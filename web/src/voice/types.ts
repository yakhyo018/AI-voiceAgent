/**
 * 음성 입출력 추상화 — 브라우저 Web Speech API 구현을
 * 추후 CLOVA Speech / Google STT·TTS (서버 스트리밍) 구현으로 교체할 수 있도록 인터페이스만 의존합니다.
 */

export interface SpeechSegment {
  text: string;
  pauseBeforeMs: number;
  pauseAfterMs: number;
  key: boolean;
}

export type ListenResult =
  | { type: 'speech'; text: string }
  | { type: 'noInput' }
  | { type: 'aborted' }
  | { type: 'error'; error: string };

export interface ListenOptions {
  /** 마지막 음성 이후 이 시간만큼 침묵하면 발화 종료로 판정 */
  silenceMs: number;
  /** 질문 후 아무 음성이 없으면 무응답 처리 */
  noInputMs: number;
  onInterim?: (text: string) => void;
  /**
   * 끼어들기(barge-in) 모드: AI 가 말하는 동안 듣는 경우 지정.
   * accept(text) 가 true 를 돌려줄 때까지는 인식 결과를 무시(맞장구·에코)하고 무응답 타이머도 돌리지 않음.
   */
  accept?: (text: string) => boolean;
  /** accept 를 처음 통과한 순간 (AI 음성 중단 신호) */
  onAccept?: (text: string) => void;
}

export interface SpeechRecognizer {
  readonly name: string;
  readonly supported: boolean;
  listen(opts: ListenOptions): Promise<ListenResult>;
  /** 진행 중인 인식을 즉시 중단 (listen 은 'aborted' 로 끝남) */
  stop(): void;
}

export interface SpeechSynthesizer {
  readonly name: string;
  readonly supported: boolean;
  /** 선택된 음성 이름 (예: Google 한국의) */
  voiceName(): string | null;
  /** 세그먼트를 순서대로, 휴지기를 지키며 읽음. cancel() 시 즉시 종료 */
  speak(segments: SpeechSegment[], opts: { rate: number; onSegment?: (s: SpeechSegment) => void }): Promise<void>;
  cancel(): void;
}

export const voiceConfig = {
  silenceMs: Number(import.meta.env.VITE_ENDPOINT_SILENCE_MS) || 1800,
  noInputMs: Number(import.meta.env.VITE_NO_INPUT_MS) || 8000,
  ttsRate: Number(import.meta.env.VITE_TTS_RATE) || 0.88,
};
