/**
 * LLM 이 쓴 문장 → TTS 세그먼트
 *  - 명세서 0장: 날짜·시간·금식 시간 등 핵심 숫자 앞뒤 0.5초 휴지기
 *  - LLM 이 [[ ]] 로 표시하도록 지시하고, 빠뜨린 경우 서버가 날짜·시간 표현을 찾아 자동 표시
 *  - {환자명} 토큰 → 실제 이름 (LLM 에는 실명을 보내지 않음)
 */
export const KEY_PAUSE_MS = 500;
export const NAME_TOKEN = '{환자명}';

export interface SpeechSegment {
  text: string;
  pauseBeforeMs: number;
  pauseAfterMs: number;
  key: boolean;
}

/** 날짜·시간 표현 (예: 11월 27일 금요일 오전 10시 30분 / 밤 10시 / 20분 전) */
const KEY_NUMBER =
  /((?:\d{1,2}월\s?\d{1,2}일(?:\s?[월화수목금토일]요일)?)(?:\s?(?:오전|오후|아침|저녁|밤|낮|새벽)?\s?\d{1,2}시(?:\s?\d{1,2}분|\s?반)?)?|(?:오전|오후|아침|저녁|밤|낮|새벽)\s?\d{1,2}시(?:\s?\d{1,2}분|\s?반)?|\d{1,2}분\s?전)/g;

/** [[ ]] 표시가 하나도 없으면 날짜·시간 표현을 자동으로 감쌈 */
export function autoMark(text: string): string {
  if (text.includes('[[')) return text;
  return text.replace(KEY_NUMBER, (m) => `[[${m.trim()}]]`);
}

export function toSegments(marked: string): SpeechSegment[] {
  const segments: SpeechSegment[] = [];
  const re = /\[\[([\s\S]*?)\]\]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const plain = (s: string) => {
    const t = s.trim();
    if (t) segments.push({ text: t, pauseBeforeMs: 0, pauseAfterMs: 0, key: false });
  };
  while ((m = re.exec(marked))) {
    plain(marked.slice(last, m.index));
    const key = m[1].trim();
    if (key) segments.push({ text: key, pauseBeforeMs: KEY_PAUSE_MS, pauseAfterMs: KEY_PAUSE_MS, key: true });
    last = m.index + m[0].length;
  }
  plain(marked.slice(last));
  return segments;
}

/** LLM 출력 → 화면용 텍스트 + TTS 세그먼트 */
/** {환자명} 토큰 (LLM 이 {±환자명}, { 환자명 } 처럼 살짝 변형해도 인식) */
const NAME_RE = /\{[^{}]{0,3}환자\s?명[^{}]{0,3}\}/g;

export function toUtterance(llmText: string, patientName: string) {
  const named = llmText.replace(NAME_RE, patientName).replace(/\s+/g, ' ').trim();
  const marked = autoMark(named);
  return { text: marked.replace(/\[\[|\]\]/g, ''), segments: toSegments(marked) };
}
