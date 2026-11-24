/**
 * 위험 키워드 안전망 (LLM 이전 단계)
 * 대화는 LLM 이 전부 맡지만, 고령 환자의 응급 신호는 LLM 지연·오류와 무관하게
 * 규칙으로 즉시 감지해 🔴 적색 콜백을 등록하고 통화를 긴급 종료하도록 강제합니다.
 */
const ADV = '(?:너무\\s?|많이\\s?|좀\\s?|자꾸\\s?|갑자기\\s?|계속\\s?)?';
const RISK = new RegExp(
  `(가슴이?\\s?${ADV}(아파|아프|답답|조여|찢)|흉통|숨이?\\s?${ADV}(차|막|가빠|안\\s?쉬)|숨\\s?쉬기|숨을?\\s?못|호흡이?\\s?(곤란|힘들|안\\s?돼)|쓰러|의식이?\\s?(없|잃)|정신을?\\s?잃|기절|마비|말이?\\s?(안\\s?나와|어눌)|피를?\\s?토|토혈|피가?\\s?(많이|안\\s?멈|멈추지)|119|살려\\s?줘|살려\\s?주|응급|죽을\\s?것\\s?같|죽고\\s?싶|자살)`,
);

export function normalize(text: string): string {
  return text
    .replace(/[.,!~…·"'“”‘’?]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 감지된 위험 표현 (없으면 null) */
export function detectRisk(text: string): string | null {
  const m = normalize(text).match(RISK);
  return m ? m[0] : null;
}
