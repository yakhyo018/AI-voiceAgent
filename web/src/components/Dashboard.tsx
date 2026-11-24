import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type CallDetail, type CallSummary, type Callback, type SmsLog } from '../api';
import { LevelDot, StatusBadge, TOOL_LABEL, fmtTime } from './common';

/** 관제 데이터 + SSE 실시간 갱신 */
function useDashboard(selectedId: string | null) {
  const [calls, setCalls] = useState<CallSummary[]>([]);
  const [callbacks, setCallbacks] = useState<Callback[]>([]);
  const [sms, setSms] = useState<SmsLog[]>([]);
  const [detail, setDetail] = useState<CallDetail | null>(null);
  const [live, setLive] = useState(false);
  const selected = useRef(selectedId);
  selected.current = selectedId;

  // 늦게 도착한 이전 응답이 최신 상태를 덮어쓰지 않도록 요청 순번 확인
  const seq = useRef(0);
  const refresh = useCallback(async () => {
    const my = ++seq.current;
    const id = selected.current;
    const [c, cb, s, d] = await Promise.all([
      api.calls(),
      api.callbacks(),
      api.sms(),
      id ? api.call(id) : Promise.resolve(null),
    ]);
    if (my !== seq.current) return;
    setCalls(c);
    setCallbacks(cb);
    setSms(s);
    setDetail(d);
  }, []);

  useEffect(() => {
    refresh().catch(() => undefined); // 서버 미기동 시엔 SSE 재연결(onopen)에서 다시 갱신
  }, [refresh, selectedId]);

  useEffect(() => {
    let timer: number | undefined;
    const es = new EventSource('/api/events');
    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void refresh().catch(() => undefined), 120);
    };
    // (재)연결될 때마다 전체 갱신 — 서버가 늦게 뜬 경우에도 대시보드가 채워짐
    es.onopen = () => {
      setLive(true);
      schedule();
    };
    es.onerror = () => setLive(false);
    for (const t of ['call.updated', 'turn.created', 'callback.created', 'sms.created']) es.addEventListener(t, schedule);
    return () => {
      window.clearTimeout(timer);
      es.close();
    };
  }, [refresh]);

  return { calls, callbacks, sms, detail, live, refresh };
}

export function Dashboard({ activeCallId }: { activeCallId: string | null }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => {
    if (activeCallId) setSelectedId(activeCallId);
  }, [activeCallId]);

  const { calls, callbacks, sms, detail, live, refresh } = useDashboard(selectedId);
  const openCallbacks = callbacks.filter((c) => c.status !== '처리 완료');
  const count = (st: string) => calls.filter((c) => c.status === st).length;

  return (
    <section className="dash" aria-label="관제 대시보드">
      <div className="stats">
        <Stat label="통화" value={calls.length} />
        <Stat label="진행 중" value={count('진행 중')} tone="live" />
        <Stat label="내원 확정" value={count('내원 확정')} tone="ok" />
        <Stat label="변경 요청" value={count('변경 요청 접수')} tone="change" />
        <Stat label="🔴 긴급" value={openCallbacks.filter((c) => c.level === 'red').length} tone="red" />
        <Stat label="🟡 콜백" value={openCallbacks.filter((c) => c.level === 'yellow').length} tone="yellow" />
        <span className={`live ${live ? 'on' : ''}`}>{live ? '● 실시간 연결' : '○ 연결 대기'}</span>
      </div>

      <div className="grid">
        <div className="card calls">
          <h2>통화 목록</h2>
          <table>
            <thead>
              <tr>
                <th>시각</th>
                <th>환자</th>
                <th>상태</th>
                <th>단계</th>
                <th>콜백</th>
              </tr>
            </thead>
            <tbody>
              {calls.length === 0 && (
                <tr>
                  <td colSpan={5} className="muted center">
                    아직 통화가 없습니다
                  </td>
                </tr>
              )}
              {calls.map((c) => (
                <tr
                  key={c.id}
                  className={c.id === selectedId ? 'sel' : ''}
                  onClick={() => setSelectedId(c.id)}
                  tabIndex={0}
                  onKeyDown={(e) => e.key === 'Enter' && setSelectedId(c.id)}
                >
                  <td>{fmtTime(c.startedAt)}</td>
                  <td>
                    {c.patientName}
                    {c.respondent === 'guardian' && <span className="tag">보호자</span>}
                  </td>
                  <td>
                    <StatusBadge status={c.status} />
                    {c.requestedSlot && <div className="muted small">희망: {c.requestedSlot}</div>}
                  </td>
                  <td className="muted">{c.phase}</td>
                  <td>{c.callbackCount || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card callbacks">
          <h2>콜백 리스트</h2>
          {callbacks.length === 0 && <p className="muted">이관된 콜백이 없습니다</p>}
          <ul>
            {callbacks.map((cb) => (
              <li key={cb.id} className={`cb cb-${cb.level} ${cb.status === '처리 완료' ? 'done' : ''}`}>
                <div className="cb-head">
                  <LevelDot level={cb.level} />
                  <b>{cb.patient?.name}</b>
                  <span className="muted small">{cb.patient?.phone}</span>
                  <span className="muted small right">{fmtTime(cb.createdAt)}</span>
                </div>
                <div>{cb.reason}</div>
                <div className="cb-foot">
                  <span className="muted small">{cb.status}</span>
                  {cb.status === '처리 완료' ? (
                    <span className="muted small">처리 완료</span>
                  ) : (
                    <button
                      className="btn tiny"
                      onClick={() => void api.resolveCallback(cb.id).then(refresh)}
                    >
                      처리 완료
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className="card detail">
          <h2>
            통화 기록
            {detail && (
              <span className="muted small">
                {' '}
                · {detail.patientName} · <StatusBadge status={detail.status} />
              </span>
            )}
          </h2>
          {!detail && <p className="muted">통화를 선택하세요</p>}
          {detail && (
            <ol className="turns">
              {(() => {
                let userIdx = 0;
                return detail.turns.map((t) => {
                  if (t.speaker === 'user') userIdx++;
                  const tools = t.speaker === 'user' ? detail.toolCalls.filter((c) => c.turnSeq === userIdx) : [];
                  return (
                    <li key={t.id} className={`turn ${t.speaker}`}>
                      <span className="who">{t.speaker === 'agent' ? 'AI' : t.speaker === 'user' ? '환자' : '시스템'}</span>
                      <span className="txt">{t.text}</span>
                      {t.speaker === 'user' && t.latencyMs != null && (
                        <span className="note">응답 {(t.latencyMs / 1000).toFixed(1)}s · {t.note}</span>
                      )}
                      {tools.map((c) => (
                        <span key={c.id} className={`tool-row ${c.ok ? '' : 'rejected'}`} title={JSON.stringify(c.output)}>
                          🔧 {TOOL_LABEL[c.name] ?? c.name} <code>{c.name}({JSON.stringify(c.input)})</code>
                          {c.ok ? ' ✓' : ' ✗ 거부'} · {c.latencyMs}ms
                        </span>
                      ))}
                    </li>
                  );
                });
              })()}
            </ol>
          )}
        </div>

        <div className="card sms">
          <h2>알림톡 / SMS 발송 기록 <span className="muted small">(시뮬레이션)</span></h2>
          {sms.length === 0 && <p className="muted">통화가 끝나면 환자·보호자에게 요약이 발송됩니다</p>}
          <ul>
            {sms.map((m) => (
              <li key={m.id} className={m.callId === selectedId ? 'hl' : ''}>
                <div className="sms-head">
                  <span className={`chan ${m.channel === '알림톡' ? 'kakao' : ''}`}>{m.channel}</span>
                  <b>{m.recipientName}</b>
                  <span className="muted small">
                    {m.recipientType === 'patient' ? '환자' : '보호자'} · {m.phone}
                  </span>
                  <span className="muted small right">{fmtTime(m.createdAt)}</span>
                </div>
                <pre>{m.body}</pre>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className={`stat ${tone ?? ''}`}>
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}
