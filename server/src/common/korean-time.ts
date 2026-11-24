/** 한국어 날짜·시간 표기 유틸 */
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

export function koreanTime(d: Date): string {
  const h = d.getHours();
  const m = d.getMinutes();
  const ampm = h < 12 ? '오전' : '오후';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${ampm} ${h12}시${m ? ` ${m}분` : ''}`;
}

export function koreanDate(d: Date): string {
  return `${d.getMonth() + 1}월 ${d.getDate()}일 ${WEEKDAYS[d.getDay()]}요일`;
}

export function koreanDateTime(d: Date): string {
  return `${koreanDate(d)} ${koreanTime(d)}`;
}

/** 통화 시점 기준 예약일 표현 ('내일') */
export function relativeDay(appt: Date, now = new Date()): string {
  const a = new Date(appt.getFullYear(), appt.getMonth(), appt.getDate()).getTime();
  const n = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const diff = Math.round((a - n) / 86_400_000);
  return diff === 0 ? '오늘' : diff === 1 ? '내일' : diff === 2 ? '모레' : `${diff}일 후`;
}
