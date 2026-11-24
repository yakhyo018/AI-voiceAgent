/**
 * 끼어들기(barge-in) 판정 — AI 가 말하는 도중 환자가 말을 끊었는지 결정
 *
 * 문제 1) 맞장구: 고령 환자는 안내를 들으며 "네, 네" 하고 맞장구를 침 → 끼어들기가 아님
 * 문제 2) 에코: 스피커로 나온 AI 음성을 마이크가 다시 인식 → AI 안내 문장과 겹치면 무시
 * 위험 표현("가슴이 아파" 등)은 항상 즉시 끼어들기로 처리
 */

const BACKCHANNEL = new Set(['네', '예', '넵', '넹', '응', '어', '음', '아', '그래', '그래요', '네네', '예예', '응응', '아아', '오']);
const RISK = /(아파|아프|숨이|숨을|숨\s?쉬|쓰러|답답|119|살려|응급)/;

const clean = (s: string) => s.replace(/[.,!?~…·"'“”‘’]/g, ' ').replace(/\s+/g, ' ').trim();
const compact = (s: string) => clean(s).replace(/\s/g, '');

/** 토큰이 AI 가 지금 읽는 문장에 들어 있으면 에코로 간주 (판정 시엔 2글자 이상만) */
function isEchoToken(token: string, agentCompact: string, minLen = 2) {
  const t = compact(token);
  return t.length >= minLen && agentCompact.includes(t);
}

/** 실제 환자 발화만 남긴 토큰 (맞장구·에코 제거) */
function meaningfulTokens(text: string, agentText: string) {
  const agent = compact(agentText);
  return clean(text)
    .split(' ')
    .filter((tok) => tok && !BACKCHANNEL.has(tok) && !isEchoToken(tok, agent));
}

export function isBargeIn(text: string, agentText: string): boolean {
  const t = clean(text);
  if (!t) return false;
  if (RISK.test(t) && !compact(agentText).includes(compact(t))) return true;
  const rest = meaningfulTokens(t, agentText);
  return rest.join('').length >= 2;
}

/** 끼어든 발화 앞부분에 섞인 AI 음성(에코)·맞장구 제거 */
export function stripEcho(text: string, agentText: string): string {
  const agent = compact(agentText);
  const toks = clean(text).split(' ').filter(Boolean);
  let i = 0;
  // 앞부분 에코 제거: 앞 토큰이 에코였다면 1글자 토큰("꼭" 등)도 에코로 봄
  while (i < toks.length && (BACKCHANNEL.has(toks[i]) || isEchoToken(toks[i], agent, i > 0 ? 1 : 2))) i++;
  const rest = toks.slice(i).join(' ');
  return rest || clean(text);
}
