import { describe, expect, it } from 'vitest';
import { isBargeIn, stripEcho } from './bargeIn';

const AGENT =
  '내원하실 때 신분증과 보훈병원 진료카드를 꼭 지참해 주세요. 또한 내일은 오전에 채혈 및 복부 초음파 검사가 예정되어 있습니다.';

describe('끼어들기 판정', () => {
  it.each(['뭐라고요', '다시 말해 주세요', '잠깐만요', '못 가요', '네 근데 혈압약은요'])('"%s" → 끼어들기', (t) => {
    expect(isBargeIn(t, AGENT)).toBe(true);
  });

  it.each(['네', '네 네', '예', '음', '응 그래'])('맞장구 "%s" → 무시', (t) => {
    expect(isBargeIn(t, AGENT)).toBe(false);
  });

  it('스피커 에코(AI 문장 그대로) → 무시', () => {
    expect(isBargeIn('신분증과 보훈병원 진료카드를', AGENT)).toBe(false);
    expect(isBargeIn('또한 내일은 오전에', AGENT)).toBe(false);
  });

  it('위험 표현은 짧아도 즉시 끼어들기', () => {
    expect(isBargeIn('아파요', AGENT)).toBe(true);
    expect(isBargeIn('숨이 차', AGENT)).toBe(true);
  });

  it('에코 뒤에 이어진 환자 말만 남김', () => {
    expect(stripEcho('진료카드를 꼭 뭐라고요', AGENT)).toBe('뭐라고요');
    expect(stripEcho('네 네 잠깐만요', AGENT)).toBe('잠깐만요');
    expect(stripEcho('못 가요', AGENT)).toBe('못 가요');
  });
});
