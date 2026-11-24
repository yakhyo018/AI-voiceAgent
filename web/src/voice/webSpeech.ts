/**
 * Web Speech API 구현 (Chrome 권장)
 *  - STT: webkitSpeechRecognition, ko-KR, continuous + interimResults
 *         브라우저 기본 종료 판정 대신 "침묵 N ms" 커스텀 엔드포인팅
 *  - TTS: speechSynthesis, ko-KR 음성 (Google 한국의 / Yuna 우선), 0.88배속
 */
import type { ListenOptions, ListenResult, SpeechRecognizer, SpeechSegment, SpeechSynthesizer } from './types';

/* eslint-disable @typescript-eslint/no-explicit-any */
const SR: any =
  typeof window !== 'undefined' ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition : null;

export class WebSpeechRecognizer implements SpeechRecognizer {
  readonly name = 'Web Speech API (ko-KR)';
  readonly supported = !!SR;
  private abort: (() => void) | null = null;

  listen({ silenceMs, noInputMs, onInterim, accept, onAccept }: ListenOptions): Promise<ListenResult> {
    if (!SR) return Promise.resolve({ type: 'error', error: 'not-supported' });
    this.stop();

    return new Promise<ListenResult>((resolve) => {
      const rec = new SR();
      rec.lang = 'ko-KR';
      rec.continuous = true;
      rec.interimResults = true;
      rec.maxAlternatives = 1;

      let done = false;
      let committed = ''; // 브라우저가 세션을 스스로 끊었다 재시작할 때 이전 결과 보존
      let current = '';
      let silenceTimer: number | undefined;
      // 끼어들기 모드에선 accept 전까지 무응답 판정을 하지 않음
      let accepted = !accept;
      const noInputTimer = accept ? undefined : window.setTimeout(() => finish({ type: 'noInput' }), noInputMs);

      const text = () => `${committed} ${current}`.replace(/\s+/g, ' ').trim();

      const finish = (r: ListenResult) => {
        if (done) return;
        done = true;
        window.clearTimeout(noInputTimer);
        window.clearTimeout(silenceTimer);
        rec.onend = null;
        rec.onresult = null;
        rec.onerror = null;
        try {
          rec.abort();
        } catch {
          /* noop */
        }
        this.abort = null;
        resolve(r);
      };
      this.abort = () => finish({ type: 'aborted' });

      rec.onresult = (e: any) => {
        let s = '';
        for (let i = 0; i < e.results.length; i++) s += e.results[i][0].transcript;
        current = s;
        const t = text();
        if (!t) return;
        if (!accepted) {
          if (!accept!(t)) return; // 맞장구·스피커 에코 → 무시
          accepted = true;
          onAccept?.(t);
        }
        window.clearTimeout(noInputTimer);
        onInterim?.(t);
        // 커스텀 엔드포인팅: 마지막 결과 이후 silenceMs 동안 새 결과가 없으면 종료
        window.clearTimeout(silenceTimer);
        silenceTimer = window.setTimeout(() => finish({ type: 'speech', text: text() }), silenceMs);
      };

      rec.onerror = (e: any) => {
        // no-speech / aborted 는 자체 타이머로 처리하므로 무시
        if (e.error === 'no-speech' || e.error === 'aborted') return;
        finish({ type: 'error', error: e.error || 'unknown' });
      };

      rec.onend = () => {
        if (done) return;
        committed = text();
        current = '';
        try {
          rec.start();
        } catch {
          /* 이미 시작됨 */
        }
      };

      try {
        rec.start();
      } catch (err) {
        finish({ type: 'error', error: String(err) });
      }
    });
  }

  stop() {
    this.abort?.();
  }
}

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

export class WebSpeechSynthesizer implements SpeechSynthesizer {
  readonly name = 'Web Speech API speechSynthesis';
  readonly supported = typeof window !== 'undefined' && 'speechSynthesis' in window;
  private voice: SpeechSynthesisVoice | null = null;
  private generation = 0;

  constructor() {
    if (!this.supported) return;
    const pick = () => {
      const voices = window.speechSynthesis.getVoices();
      const ko = voices.filter((v) => v.lang?.toLowerCase().startsWith('ko'));
      this.voice =
        ko.find((v) => v.name.includes('Google') && v.name.includes('한국')) ||
        ko.find((v) => /yuna|유나/i.test(v.name)) ||
        ko.find((v) => v.lang === 'ko-KR') ||
        ko[0] ||
        null;
    };
    pick();
    window.speechSynthesis.addEventListener?.('voiceschanged', pick);
  }

  voiceName() {
    return this.voice?.name ?? null;
  }

  async speak(segments: SpeechSegment[], { rate, onSegment }: { rate: number; onSegment?: (s: SpeechSegment) => void }) {
    if (!this.supported) return;
    this.cancel();
    const gen = ++this.generation;
    for (const seg of segments) {
      if (gen !== this.generation) return;
      if (seg.pauseBeforeMs) await sleep(seg.pauseBeforeMs);
      if (gen !== this.generation) return;
      onSegment?.(seg);
      // 긴 문장은 일부 브라우저에서 중간에 끊기므로 문장 단위로 나눠 읽음
      for (const sentence of seg.text.split(/(?<=[.?!])\s+/)) {
        if (gen !== this.generation) return;
        await this.speakOne(sentence, rate);
      }
      if (seg.pauseAfterMs) await sleep(seg.pauseAfterMs);
    }
  }

  cancel() {
    this.generation++;
    if (this.supported) window.speechSynthesis.cancel();
  }

  private speakOne(text: string, rate: number) {
    return new Promise<void>((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'ko-KR';
      u.rate = rate;
      u.pitch = 1;
      if (this.voice) u.voice = this.voice;
      // 음성 출력 장치가 없거나 onend 가 오지 않는 환경 대비 안전 타임아웃
      const guard = window.setTimeout(resolve, Math.max(2500, (text.length * 330) / rate));
      const end = () => {
        window.clearTimeout(guard);
        resolve();
      };
      u.onend = end;
      u.onerror = end;
      window.speechSynthesis.speak(u);
    });
  }
}
