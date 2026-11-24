/** LLM 에이전트 공통 타입 */
import type Anthropic from '@anthropic-ai/sdk';
import type { SpeechSegment } from './speech';

export type CallStatus =
  | '진행 중'
  | '내원 확정'
  | '변경 요청 접수'
  | '재통화 필요'
  | '상담원 콜백'
  | '긴급 이관'
  | '통화 중단';

/** LLM 이 end_call 로 고를 수 있는 종료 상태 */
export const END_STATUSES = ['내원 확정', '변경 요청 접수', '재통화 필요', '상담원 콜백', '긴급 이관'] as const;
export type EndStatus = (typeof END_STATUSES)[number];

/**
 * 에이전트 상태 — 대화 내용이 아니라 "무엇이 확인·처리됐는가"만 담음.
 * tool 가드(예: 본인 확인 전 예약 조회 금지)는 이 상태로 판단하고, LLM 은 이 값을 직접 바꿀 수 없음.
 */
export interface AgentState {
  respondent: 'unknown' | 'patient' | 'guardian';
  identityVerified: boolean;
  appointmentShared: boolean;
  outcome: null | '내원 확정' | '변경 요청 접수';
  requestedSlot: string | null;
  callbacks: { level: 'red' | 'yellow'; reason: string }[];
  emergency: boolean;
  consecutiveNoInput: number;
  status: CallStatus;
  ended: boolean;
  userTurns: number;
}

export const initialState = (): AgentState => ({
  respondent: 'unknown',
  identityVerified: false,
  appointmentShared: false,
  outcome: null,
  requestedSlot: null,
  callbacks: [],
  emergency: false,
  consecutiveNoInput: 0,
  status: '진행 중',
  ended: false,
  userTurns: 0,
});

export interface Utterance {
  text: string;
  segments: SpeechSegment[];
}

export interface ToolCallRecord {
  name: string;
  input: unknown;
  output: unknown;
  ok: boolean;
  latencyMs: number;
}

export interface AgentTurnResult {
  state: AgentState;
  history: Anthropic.MessageParam[];
  utterances: Utterance[];
  toolCalls: ToolCallRecord[];
  llmCalls: number;
  latencyMs: number;
  /** 위험 키워드 감지·LLM 실패 폴백 등 서버 개입 내역 */
  notes: string[];
}

/** 에이전트가 의존하는 LLM 포트 (테스트에서 가짜 LLM 으로 교체) */
export interface LlmClient {
  readonly model: string;
  create(params: {
    system: Anthropic.TextBlockParam[];
    tools: Anthropic.Tool[];
    messages: Anthropic.MessageParam[];
  }): Promise<Anthropic.Message>;
}

export const LLM_CLIENT = Symbol('LLM_CLIENT');
