/**
 * 통화 세션 컨트롤러
 *   발신 → (TTS 재생) → (마이크 청취: 커스텀 엔드포인팅) → 서버 턴 → … → 종료
 *   - 끼어들기(barge-in) 켜짐: TTS 재생 중에도 듣되, 맞장구("네, 네")·스피커 에코는 무시하고
 *     의미 있는 발화일 때만 TTS 를 멈추고 그 발화를 턴으로 보냄 (bargeIn.ts 참고)
 *   - 끼어들기 꺼짐: TTS 가 끝난 뒤에만 청취 (에코·자기 음성 인식 방지)
 *   - TTS 는 서버(Typecast) 우선, 실패·미설정 시 브라우저 TTS 로 폴백
 *   - 마이크가 안 되면 텍스트 입력/빠른 응답 칩으로 동일하게 진행
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type AgentInfo, type CallSummary, type TurnResponse } from './api';
import { isBargeIn, stripEcho } from './voice/bargeIn';
import type { ListenResult, SpeechRecognizer, SpeechSynthesizer } from './voice/types';
import { voiceConfig } from './voice/types';
import { ServerSynthesizer } from './voice/serverTts';
import { WebSpeechRecognizer, WebSpeechSynthesizer } from './voice/webSpeech';

export type MicState = 'idle' | 'speaking' | 'listening' | 'processing';

export interface TranscriptLine {
  id: number;
  role: 'agent' | 'user' | 'system';
  text: string;
  /** 사용자 줄: 이 턴에서 에이전트가 한 일 (LLM·tool) */
  agent?: AgentInfo;
  /** 환자가 끼어들어 AI 안내가 중간에 멈춘 줄 */
  interrupted?: boolean;
}

let lineId = 0;

export function useCallSession() {
  const stt = useMemo<SpeechRecognizer>(() => new WebSpeechRecognizer(), []);
  const webTts = useMemo<SpeechSynthesizer>(() => new WebSpeechSynthesizer(), []);
  // 서버 TTS(Typecast)는 /api/config 로 사용 가능할 때만 활성화, 실패 시 브라우저 TTS 로 폴백
  const [serverTtsLabel, setServerTtsLabel] = useState<string | null>(null);
  const serverTts = useMemo(
    () => (serverTtsLabel ? new ServerSynthesizer(serverTtsLabel, webTts) : null),
    [serverTtsLabel, webTts],
  );
  const [ttsEngine, setTtsEngine] = useState<'server' | 'browser'>('server');
  const tts: SpeechSynthesizer = ttsEngine === 'server' && serverTts ? serverTts : webTts;

  const [call, setCall] = useState<CallSummary | null>(null);
  const [ended, setEnded] = useState(false);
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const [interim, setInterim] = useState('');
  const [mic, setMic] = useState<MicState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [voiceInput, setVoiceInput] = useState(stt.supported);
  const [voiceOutput, setVoiceOutput] = useState(tts.supported);
  const [silenceMs, setSilenceMs] = useState(voiceConfig.silenceMs);
  const [speakingKey, setSpeakingKey] = useState<string | null>(null);
  // 끼어들기(barge-in): AI 가 말하는 중에도 듣고, 의미 있는 발화면 AI 음성을 멈춤
  const [bargeIn, setBargeIn] = useState(true);

  // 비동기 흐름이 겹치지 않도록 동작마다 세대 번호 증가
  const gen = useRef(0);
  const callRef = useRef<CallSummary | null>(null);
  const opts = useRef({ voiceInput, voiceOutput, silenceMs, bargeIn });
  opts.current = { voiceInput, voiceOutput, silenceMs, bargeIn };

  const push = (l: Omit<TranscriptLine, 'id'>) => {
    const id = ++lineId;
    setLines((prev) => [...prev, { ...l, id }]);
    return id;
  };

  const interrupt = useCallback(() => {
    gen.current++;
    stt.stop();
    webTts.cancel();
    serverTts?.cancel();
    setInterim('');
    setSpeakingKey(null);
  }, [stt, webTts, serverTts]);

  // listen ↔ sendTurn 순환 참조를 ref 로 연결
  type TurnBody = { text?: string; noInput?: boolean; bargeIn?: boolean };
  const sendRef = useRef<(body: TurnBody) => Promise<void>>(async () => {});

  const listen = useCallback(
    async (g: number) => {
      if (g !== gen.current || !opts.current.voiceInput || !stt.supported) {
        setMic('idle');
        return;
      }
      setMic('listening');
      const r = await stt.listen({
        silenceMs: opts.current.silenceMs,
        noInputMs: voiceConfig.noInputMs,
        onInterim: (t) => g === gen.current && setInterim(t),
      });
      if (g !== gen.current) return;
      setInterim('');
      if (r.type === 'speech') await sendRef.current({ text: r.text });
      else if (r.type === 'noInput') await sendRef.current({ noInput: true });
      else if (r.type === 'error') {
        setError(`마이크 오류(${r.error}) — 텍스트 입력으로 진행하세요`);
        setVoiceInput(false);
        setMic('idle');
      }
    },
    [stt],
  );

  const handleResponse = useCallback(
    async (res: TurnResponse, g: number) => {
      callRef.current = res.call;
      setCall(res.call);
      setEnded(res.ended);
      const agentIds = res.utterances.map((u) => push({ role: 'agent', text: u.text }));
      if (res.ended) push({ role: 'system', text: `통화 종료 · ${res.call.status}` });

      if (opts.current.voiceOutput && tts.supported && res.utterances.length) {
        setMic('speaking');
        const agentText = res.utterances.map((u) => u.text).join(' ');
        let barged = false;
        let bargeP: Promise<ListenResult> | null = null;

        // 끼어들기: AI 가 말하는 동안에도 듣되, 맞장구("네, 네")·스피커 에코는 무시
        if (!res.ended && opts.current.bargeIn && opts.current.voiceInput && stt.supported) {
          bargeP = stt.listen({
            silenceMs: opts.current.silenceMs,
            noInputMs: voiceConfig.noInputMs,
            accept: (t) => isBargeIn(t, agentText),
            onAccept: () => {
              if (g !== gen.current) return;
              barged = true;
              tts.cancel(); // AI 음성 즉시 중단 → speak() 종료
              setSpeakingKey(null);
              setMic('listening');
              const last = agentIds[agentIds.length - 1];
              setLines((prev) => prev.map((l) => (l.id === last ? { ...l, interrupted: true } : l)));
            },
            onInterim: (t) => g === gen.current && barged && setInterim(stripEcho(t, agentText)),
          });
        }

        await tts.speak(
          res.utterances.flatMap((u) => u.segments),
          { rate: voiceConfig.ttsRate, onSegment: (s) => g === gen.current && setSpeakingKey(s.key ? s.text : null) },
        );
        setSpeakingKey(null);

        if (bargeP) {
          if (barged) {
            const r = await bargeP;
            if (g !== gen.current) return;
            setInterim('');
            if (r.type === 'speech') return void (await sendRef.current({ text: stripEcho(r.text, agentText), bargeIn: true }));
          } else {
            // 끝까지 말했으면 에코가 섞였을 수 있는 세션은 버리고 새로 듣기 시작
            stt.stop();
            await bargeP;
          }
        }
      }
      if (g !== gen.current) return;
      if (res.ended) {
        setMic('idle');
        return;
      }
      await listen(g);
    },
    [listen, tts],
  );

  sendRef.current = async (body: TurnBody) => {
    const current = callRef.current;
    if (!current) return;
    interrupt();
    const g = gen.current;
    setMic('processing');
    setError(null);
    const lineIdx = ++lineId;
    setLines((prev) => [...prev, { id: lineIdx, role: 'user', text: body.noInput ? '(무응답)' : body.text ?? '' }]);
    try {
      const res = await api.turn(current.id, body);
      // 사용자 줄에 에이전트 처리 내역(LLM 호출·tool·지연) 표시
      setLines((prev) => prev.map((l) => (l.id === lineIdx ? { ...l, agent: res.agent } : l)));
      if (g !== gen.current) return;
      await handleResponse(res, g);
    } catch (e) {
      setError(String((e as Error).message));
      setMic('idle');
    }
  };

  const start = useCallback(
    async (patientId: number) => {
      interrupt();
      const g = gen.current;
      setLines([]);
      setError(null);
      setEnded(false);
      setMic('processing');
      try {
        const res = await api.startCall(patientId);
        push({ role: 'system', text: `발신 · ${res.call.patientName} 님` });
        await handleResponse(res, g);
      } catch (e) {
        setError(String((e as Error).message));
        setMic('idle');
      }
    },
    [handleResponse, interrupt],
  );

  const hangup = useCallback(async () => {
    const current = callRef.current;
    interrupt();
    setMic('idle');
    if (!current || ended) return;
    try {
      const d = await api.hangup(current.id);
      setCall(d);
      setEnded(true);
      push({ role: 'system', text: `통화 종료 · ${d.status}` });
    } catch (e) {
      setError(String((e as Error).message));
    }
  }, [ended, interrupt]);

  /** 마이크 수동 재청취 (예: 음성 입력을 다시 켰을 때) */
  const listenNow = useCallback(() => {
    if (!callRef.current || ended) return;
    interrupt();
    void listen(gen.current);
  }, [ended, interrupt, listen]);

  useEffect(() => () => interrupt(), [interrupt]);

  return {
    call,
    ended,
    lines,
    interim,
    mic,
    error,
    speakingKey,
    start,
    hangup,
    send: (text: string) => sendRef.current({ text }),
    sendNoInput: () => sendRef.current({ noInput: true }),
    listenNow,
    voiceInput,
    setVoiceInput,
    voiceOutput,
    setVoiceOutput,
    silenceMs,
    setSilenceMs,
    sttSupported: stt.supported,
    ttsSupported: tts.supported,
    ttsVoice: () => tts.voiceName(),
    serverTtsAvailable: !!serverTts,
    bargeIn,
    setBargeIn,
    ttsEngine,
    setTtsEngine,
    setServerTtsLabel,
    stop: interrupt,
  };
}
