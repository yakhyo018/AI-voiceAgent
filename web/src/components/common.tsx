import type { AgentInfo } from '../api';

/** tool 이름 → 화면 표시 */
export const TOOL_LABEL: Record<string, string> = {
  verify_identity: '본인 확인',
  get_appointment: '예약 조회',
  search_hospital_info: '병원 안내 검색',
  register_callback: '콜백 등록',
  confirm_attendance: '내원 확정',
  request_reschedule: '변경 접수',
  end_call: '통화 종료',
};

const STATUS_CLASS: Record<string, string> = {
  '진행 중': 'st-live',
  '내원 확정': 'st-ok',
  '변경 요청 접수': 'st-change',
  '재통화 필요': 'st-muted',
  '상담원 콜백': 'st-yellow',
  '긴급 이관': 'st-red',
  '통화 중단': 'st-muted',
};

export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge ${STATUS_CLASS[status] ?? 'st-muted'}`}>{status}</span>;
}

/** 한 턴에서 에이전트가 한 일: LLM 호출 수·지연·tool 칩·서버 개입 */
export function AgentTag({ agent }: { agent: AgentInfo }) {
  return (
    <span className="agent-tag" title={agent.notes.join('\n') || undefined}>
      <span className="src src-llm">{agent.llmCalls ? `LLM ×${agent.llmCalls}` : '서버'}</span>
      <span className="lat">{(agent.latencyMs / 1000).toFixed(1)}s</span>
      {agent.toolCalls.map((t, i) => (
        <span key={i} className={`tool-chip ${t.ok ? '' : 'rejected'}`} title={JSON.stringify(t.input)}>
          🔧 {TOOL_LABEL[t.name] ?? t.name}
          {!t.ok && ' ✗'}
        </span>
      ))}
      {agent.notes.length > 0 && <span className="server-note">⚠ {agent.notes[0]}</span>}
    </span>
  );
}

export function LevelDot({ level }: { level: 'red' | 'yellow' }) {
  return <span aria-label={level === 'red' ? '적색 경보' : '황색 경보'}>{level === 'red' ? '🔴' : '🟡'}</span>;
}

export const fmtTime = (iso: string) =>
  new Date(iso).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export const fmtAppt = (iso: string) => {
  const d = new Date(iso);
  const wd = '일월화수목금토'[d.getDay()];
  const h = d.getHours();
  return `${d.getMonth() + 1}/${d.getDate()}(${wd}) ${h < 12 ? '오전' : '오후'} ${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** 데모용 빠른 응답 칩 (마이크 대체) — 진행 단계별 */
export const QUICK_REPLIES: Record<string, string[]> = {
  '본인 확인': ['네, 맞아요', '아니요, 아들입니다', '누구세요?'],
  '보호자 동의 확인': ['네, 제가 전달할게요', '지금은 전달하기 어려워요'],
  '안내 시작': ['네, 알겠습니다', '다시 말해 주세요'],
  '일정·준비 안내': ['네, 알겠습니다', '다시 말해 주세요', '혈압약은 먹어도 되나요?', '주차는 돼요?', '네, 갈게요', '그날은 못 가요', '다음 주 화요일 오전이요'],
};
