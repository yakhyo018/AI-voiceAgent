import { useEffect, useRef, useState } from 'react';
import type { Patient } from '../api';
import type { useCallSession } from '../useCallSession';
import { AgentTag, QUICK_REPLIES, StatusBadge, fmtAppt } from './common';

type Session = ReturnType<typeof useCallSession>;

const MIC_LABEL = {
  idle: { icon: '⏸', text: '대기' },
  speaking: { icon: '🔊', text: 'AI 보훈이 안내 중' },
  listening: { icon: '🎤', text: '듣는 중…' },
  processing: { icon: '⏳', text: '이해하는 중' },
} as const;

export function PhonePanel({ patients, s }: { patients: Patient[]; s: Session }) {
  const [patientId, setPatientId] = useState<number | null>(null);
  const [text, setText] = useState('');
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (patientId === null && patients.length) setPatientId(patients[0].id);
  }, [patients, patientId]);

  useEffect(() => {
    const el = scroller.current;
    if (el) requestAnimationFrame(() => (el.scrollTop = el.scrollHeight));
  }, [s.lines, s.interim]);

  const patient = patients.find((p) => p.id === patientId);
  const appt = patient?.appointments[0];
  const active = !!s.call && !s.ended;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t || !active) return;
    setText('');
    void s.send(t);
  };

  const mic = MIC_LABEL[s.mic];

  return (
    <section className="phone" aria-label="통화 시뮬레이터">
      <header className="phone-head">
        <label className="field">
          <span>환자 선택</span>
          <select
            value={patientId ?? ''}
            onChange={(e) => setPatientId(Number(e.target.value))}
            disabled={active}
          >
            {patients.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {p.appointments[0] ? fmtAppt(p.appointments[0].at) : '예약 없음'} ·{' '}
                {p.appointments[0]?.exams ? '검사 있음' : '검사 없음'}
              </option>
            ))}
          </select>
        </label>
        {patient && appt && (
          <div className="patient-card">
            <div>
              <b>{appt.location}</b> · {fmtAppt(appt.at)} · <span className="muted">{appt.status}</span>
            </div>
            <div className="muted">
              {appt.exams ? `${appt.exams} · ${appt.fastingStart} 금식` : '검사 없음 (금식 안내 없음)'} · 보호자{' '}
              {patient.guardianName}({patient.guardianRelation})
            </div>
          </div>
        )}
        <div className="call-buttons">
          {!active ? (
            <button className="btn call" onClick={() => patientId && s.start(patientId)} disabled={!patientId}>
              📞 발신
            </button>
          ) : (
            <button className="btn hang" onClick={() => void s.hangup()}>
              통화 종료
            </button>
          )}
        </div>
      </header>

      <div className="phone-status">
        <span className={`mic mic-${s.mic}`} aria-live="polite">
          <span className="mic-icon">{mic.icon}</span> {mic.text}
        </span>
        {s.call && (
          <span className="step">
            {s.ended ? <StatusBadge status={s.call.status} /> : s.call.phase}
          </span>
        )}
      </div>
      {s.speakingKey && <div className="key-number" aria-hidden="true">{s.speakingKey}</div>}

      <div className="transcript" ref={scroller} aria-live="polite" aria-label="실시간 대화 기록">
        {s.lines.length === 0 && (
          <p className="empty">
            환자를 선택하고 <b>발신</b>을 누르세요.
            <br />
            AI 보훈이가 한국어로 안내하고, 마이크로 응답을 듣습니다.
          </p>
        )}
        {s.lines.map((l) =>
          l.role === 'system' ? (
            <div key={l.id} className="sys">
              {l.text}
            </div>
          ) : (
            <div key={l.id} className={`bubble ${l.role}`}>
              {l.interrupted && <span className="cut">⏹ 환자가 끼어들어 중단됨</span>}
              <p>{l.text}</p>
              {l.role === 'user' && l.agent && <AgentTag agent={l.agent} />}
            </div>
          ),
        )}
        {s.interim && (
          <div className="bubble user interim">
            <p>{s.interim}</p>
          </div>
        )}
      </div>

      {s.error && <div className="error">{s.error}</div>}

      <div className="replies">
        {active &&
          (QUICK_REPLIES[s.call?.phase ?? ''] ?? []).map((q) => (
            <button key={q} className="chip" onClick={() => void s.send(q)}>
              {q}
            </button>
          ))}
        {active && (
          <>
            <button className="chip ghost" onClick={() => void s.sendNoInput()} title="무응답 시뮬레이션">
              (무응답)
            </button>
            <button className="chip danger" onClick={() => void s.send('가슴이 너무 아파요')}>
              🚨 가슴이 아파요
            </button>
          </>
        )}
      </div>

      <form className="composer" onSubmit={submit}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={active ? '환자 응답을 입력 (마이크 대체)' : '통화 중이 아닙니다'}
          disabled={!active}
          aria-label="환자 응답 텍스트 입력"
        />
        <button className="btn" disabled={!active || !text.trim()}>
          보내기
        </button>
      </form>

      <details className="voice-settings">
        <summary>음성 설정</summary>
        <label className="toggle">
          <input
            type="checkbox"
            checked={s.voiceInput}
            disabled={!s.sttSupported}
            onChange={(e) => s.setVoiceInput(e.target.checked)}
          />
          🎤 음성 입력 (STT) {!s.sttSupported && <em>— 이 브라우저 미지원 (Chrome 권장)</em>}
        </label>
        {s.serverTtsAvailable && (
          <label className="range">
            TTS 엔진
            <select value={s.ttsEngine} onChange={(e) => s.setTtsEngine(e.target.value as 'server' | 'browser')}>
              <option value="server">서버 TTS (Typecast) — 실패 시 브라우저 폴백</option>
              <option value="browser">브라우저 TTS (Web Speech)</option>
            </select>
          </label>
        )}
        <label className="toggle">
          <input
            type="checkbox"
            checked={s.voiceOutput}
            disabled={!s.ttsSupported}
            onChange={(e) => s.setVoiceOutput(e.target.checked)}
          />
          🔊 음성 출력 (0.88배속) <em>{s.ttsVoice() ?? ''}</em>
        </label>
        <label className="toggle">
          <input
            type="checkbox"
            checked={s.bargeIn}
            disabled={!s.sttSupported}
            onChange={(e) => s.setBargeIn(e.target.checked)}
          />
          🗣 끼어들기 허용 (AI 가 말하는 중에도 듣기) <em>— 스피커 에코 방지를 위해 이어폰 권장</em>
        </label>
        <label className="range">
          발화 종료 대기 {(s.silenceMs / 1000).toFixed(1)}초
          <input
            type="range"
            min={1000}
            max={3000}
            step={100}
            value={s.silenceMs}
            onChange={(e) => s.setSilenceMs(Number(e.target.value))}
          />
        </label>
        {active && s.voiceInput && s.mic === 'idle' && (
          <button type="button" className="btn small" onClick={s.listenNow}>
            🎤 다시 듣기
          </button>
        )}
      </details>
      <p className="attribution">
        병원 FAQ 는 데모용 예시 데이터입니다
        {s.serverTtsAvailable && s.ttsEngine === 'server' && ' · Voice by Typecast'}
      </p>
    </section>
  );
}
