import type { SpeechSegment } from './voice/types';

export interface Appointment {
  id: number;
  at: string;
  department: string;
  location: string;
  exams: string | null;
  fastingStart: string | null;
  status: string;
}

export interface Patient {
  id: number;
  name: string;
  phone: string;
  hospital: string;
  guardianName: string | null;
  guardianRelation: string | null;
  guardianPhone: string | null;
  appointments: Appointment[];
}

export interface CallSummary {
  id: string;
  patientId: number;
  patientName: string;
  status: string;
  /** 화면 표시용 진행 단계 (본인 확인 / 일정·준비 안내 / …) */
  phase: string;
  respondent: 'unknown' | 'patient' | 'guardian';
  requestedSlot: string | null;
  appointmentAt: string;
  startedAt: string;
  endedAt: string | null;
  callbackCount?: number;
}

export interface Utterance {
  text: string;
  segments: SpeechSegment[];
}

export interface ToolCallInfo {
  name: string;
  ok: boolean;
  latencyMs: number;
  input: unknown;
}

/** 한 턴에서 LLM 에이전트가 한 일 (호출 수·지연·tool·서버 개입) */
export interface AgentInfo {
  model: string;
  llmCalls: number;
  latencyMs: number;
  toolCalls: ToolCallInfo[];
  notes: string[];
}

export interface TurnResponse {
  call: CallSummary;
  utterances: Utterance[];
  agent: AgentInfo;
  ended: boolean;
}

export interface Turn {
  id: number;
  seq: number;
  speaker: 'agent' | 'user' | 'system';
  text: string;
  latencyMs: number | null;
  note: string | null;
  createdAt: string;
}

export interface ToolCallRow {
  id: number;
  turnSeq: number;
  name: string;
  input: unknown;
  output: unknown;
  ok: boolean;
  latencyMs: number;
}

export interface Callback {
  id: number;
  callId: string;
  level: 'red' | 'yellow';
  reason: string;
  status: string;
  createdAt: string;
  patient?: { name: string; phone: string };
}

export interface SmsLog {
  id: number;
  callId: string;
  recipientType: 'patient' | 'guardian';
  recipientName: string;
  phone: string;
  channel: string;
  body: string;
  createdAt: string;
}

export interface CallDetail extends CallSummary {
  turns: Turn[];
  toolCalls: ToolCallRow[];
  callbacks: Callback[];
  sms: SmsLog[];
}

export interface ServerConfig {
  architecture: string;
  llmEnabled: boolean;
  model: string;
  effort: string;
  tts: { provider: string | null; voice: string | null; attribution: string | null };
}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = `${res.status}`;
    try {
      msg = (await res.json()).message ?? msg;
    } catch {
      /* noop */
    }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

export const api = {
  config: () => req<ServerConfig>('GET', '/api/config'),
  patients: () => req<Patient[]>('GET', '/api/patients'),
  startCall: (patientId: number) => req<TurnResponse>('POST', '/api/calls', { patientId }),
  turn: (callId: string, body: { text?: string; noInput?: boolean; bargeIn?: boolean }) =>
    req<TurnResponse>('POST', `/api/calls/${callId}/turn`, body),
  hangup: (callId: string) => req<CallDetail>('POST', `/api/calls/${callId}/hangup`),
  calls: () => req<CallSummary[]>('GET', '/api/calls'),
  call: (id: string) => req<CallDetail>('GET', `/api/calls/${id}`),
  callbacks: () => req<Callback[]>('GET', '/api/callbacks'),
  resolveCallback: (id: number) => req<Callback>('PATCH', `/api/callbacks/${id}`, { status: '처리 완료' }),
  sms: () => req<SmsLog[]>('GET', '/api/sms'),
};
