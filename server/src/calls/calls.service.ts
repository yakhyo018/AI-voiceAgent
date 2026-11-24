/**
 * 통화 오케스트레이션 — 에이전트 실행 결과를 DB 에 기록하고 대시보드로 이벤트 발행
 *   발신(start) → 턴(turn) 반복 → 종료 시 요약 문자 발송
 */
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Appointment, Call, Patient } from '@prisma/client';
import { AgentCall, AgentService } from '../agent/agent.service';
import { AgentState, AgentTurnResult, CallStatus, initialState } from '../agent/agent.types';
import { EventsService } from '../events/events.module';
import { PrismaService } from '../prisma/prisma.service';
import { buildSummaryMessages } from './sms';

export interface TurnInput {
  text?: string;
  noInput?: boolean;
  /** AI 안내 도중 환자가 끼어든 발화 (기록용) */
  bargeIn?: boolean;
}

/** 화면 표시용 진행 단계 */
export function phaseOf(s: AgentState): string {
  if (s.ended) return s.status;
  if (s.outcome) return s.outcome;
  if (s.appointmentShared) return '일정·준비 안내';
  if (s.identityVerified) return '안내 시작';
  return s.respondent === 'guardian' ? '보호자 동의 확인' : '본인 확인';
}

type CallWithRelations = Call & { patient: Patient; appointment: Appointment };

@Injectable()
export class CallsService {
  private readonly logger = new Logger('Calls');
  /** 같은 통화에 턴이 동시에 들어와도 순서대로 처리 */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly agent: AgentService,
    private readonly events: EventsService,
  ) {}

  get model() {
    return this.agent.model;
  }

  // ── 조회 ──────────────────────────────────────────────

  listPatients() {
    return this.prisma.patient.findMany({ orderBy: { id: 'asc' }, include: { appointments: { orderBy: { at: 'asc' } } } });
  }

  async listCalls() {
    const calls = await this.prisma.call.findMany({
      orderBy: { startedAt: 'desc' },
      take: 50,
      include: { patient: true, appointment: true, _count: { select: { callbacks: true } } },
    });
    return calls.map((c) => ({ ...this.summary(c), callbackCount: c._count.callbacks }));
  }

  async getCall(id: string) {
    const call = await this.prisma.call.findUnique({
      where: { id },
      include: {
        patient: true,
        appointment: true,
        turns: { orderBy: { seq: 'asc' } },
        toolCalls: { orderBy: { id: 'asc' } },
        callbacks: { orderBy: { createdAt: 'asc' } },
        smsLogs: { orderBy: { id: 'asc' } },
      },
    });
    if (!call) throw new NotFoundException('통화를 찾을 수 없습니다');
    return {
      ...this.summary(call),
      turns: call.turns.map((t) => ({ ...t, segments: t.segments ? JSON.parse(t.segments) : null })),
      toolCalls: call.toolCalls.map((t) => ({ ...t, input: JSON.parse(t.input), output: JSON.parse(t.output) })),
      callbacks: call.callbacks,
      sms: call.smsLogs,
    };
  }

  listCallbacks() {
    return this.prisma.callback.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { patient: { select: { name: true, phone: true } } },
    });
  }

  async updateCallback(id: number, status: string) {
    const cb = await this.prisma.callback.update({ where: { id }, data: { status } });
    this.events.emit({ type: 'callback.created', callId: cb.callId, payload: cb });
    return cb;
  }

  listSms() {
    return this.prisma.smsLog.findMany({ orderBy: { id: 'desc' }, take: 100 });
  }

  // ── 통화 진행 ──────────────────────────────────────────

  async startCall(patientId: number) {
    const patient = await this.prisma.patient.findUnique({
      where: { id: patientId },
      include: { appointments: { where: { status: '예약' }, orderBy: { at: 'asc' }, take: 1 } },
    });
    if (!patient) throw new NotFoundException('환자를 찾을 수 없습니다');
    const appt =
      patient.appointments[0] ??
      (await this.prisma.appointment.findFirst({ where: { patientId }, orderBy: { at: 'desc' } }));
    if (!appt) throw new BadRequestException('안내할 예약이 없습니다');

    const state = initialState();
    const call = await this.prisma.call.create({
      data: { patientId, appointmentId: appt.id, status: state.status, phase: phaseOf(state), state: JSON.stringify(state), history: '[]' },
      include: { patient: true, appointment: true },
    });
    this.logger.log(`발신 ${call.id} → ${patient.name}`);
    const result = await this.agent.start(this.toAgentCall(call));
    await this.persist(call, null, result);
    return this.respond(call.id, result);
  }

  async turn(callId: string, input: TurnInput) {
    if (!input || (typeof input.text !== 'string' && !input.noInput)) {
      throw new BadRequestException('{ text } 또는 { noInput: true } 가 필요합니다');
    }
    return this.withLock(callId, async () => {
      const call = await this.prisma.call.findUnique({ where: { id: callId }, include: { patient: true, appointment: true } });
      if (!call) throw new NotFoundException('통화를 찾을 수 없습니다');
      const agentCall = this.toAgentCall(call);
      if (agentCall.state.ended) throw new ConflictException('이미 종료된 통화입니다');
      const result = await this.agent.turn(agentCall, input);
      await this.persist(call, input, result);
      return this.respond(call.id, result);
    });
  }

  async hangup(callId: string) {
    return this.withLock(callId, async () => {
      const call = await this.prisma.call.findUnique({ where: { id: callId }, include: { patient: true, appointment: true } });
      if (!call) throw new NotFoundException('통화를 찾을 수 없습니다');
      const state = JSON.parse(call.state) as AgentState;
      if (!state.ended) {
        const next: AgentState = { ...state, ended: true, status: '통화 중단' };
        await this.prisma.call.update({
          where: { id: callId },
          data: { status: next.status, phase: phaseOf(next), state: JSON.stringify(next), endedAt: new Date() },
        });
        await this.addTurn(callId, { speaker: 'system', text: '상대방이 통화를 종료했습니다.' });
        await this.sendSummary(call, next.status, next.requestedSlot);
        this.events.emit({ type: 'call.updated', callId });
      }
      return this.getCall(callId);
    });
  }

  // ── 내부 ──────────────────────────────────────────────

  private toAgentCall(call: CallWithRelations): AgentCall {
    return {
      callId: call.id,
      patientId: call.patientId,
      patientName: call.patient.name,
      appointmentId: call.appointmentId,
      hospital: call.patient.hospital,
      state: JSON.parse(call.state),
      history: JSON.parse(call.history),
      // 평가·데모용 시각 고정 (예: AGENT_NOW=2026-11-26T11:00:00+09:00). 미설정 시 실제 현재 시각
      now: process.env.AGENT_NOW ? new Date(process.env.AGENT_NOW) : undefined,
    };
  }

  private async persist(call: CallWithRelations, input: TurnInput | null, r: AgentTurnResult) {
    const turnSeq = r.state.userTurns;
    if (input) {
      const tools = r.toolCalls.map((t) => `${t.name}${t.ok ? '' : '(거부)'}`).join(', ');
      await this.addTurn(call.id, {
        speaker: 'user',
        text: input.noInput || !input.text?.trim() ? '(무응답)' : input.text.trim(),
        latencyMs: r.latencyMs,
        note:
          [input.bargeIn && '끼어들기(barge-in)', `LLM ${r.llmCalls}회`, tools && `tools: ${tools}`, ...r.notes]
            .filter(Boolean)
            .join(' / ') || undefined,
      });
    } else if (r.notes.length) {
      await this.addTurn(call.id, { speaker: 'system', text: r.notes.join(' / ') });
    }
    for (const t of r.toolCalls) {
      await this.prisma.toolCall.create({
        data: {
          callId: call.id,
          turnSeq,
          name: t.name,
          input: JSON.stringify(t.input ?? {}),
          output: JSON.stringify(t.output ?? null),
          ok: t.ok,
          latencyMs: t.latencyMs,
        },
      });
    }
    for (const u of r.utterances) {
      await this.addTurn(call.id, { speaker: 'agent', text: u.text, segments: JSON.stringify(u.segments) });
    }

    await this.prisma.call.update({
      where: { id: call.id },
      data: {
        status: r.state.status,
        phase: phaseOf(r.state),
        state: JSON.stringify(r.state),
        history: JSON.stringify(r.history),
        respondent: r.state.respondent,
        requestedSlot: r.state.requestedSlot,
        endedAt: r.state.ended ? new Date() : undefined,
      },
    });

    if (r.state.ended) {
      this.logger.log(`통화 종료 ${call.id}: ${r.state.status}`);
      await this.sendSummary(call, r.state.status, r.state.requestedSlot);
    }
    if (r.state.callbacks.length) this.events.emit({ type: 'callback.created', callId: call.id });
    this.events.emit({ type: 'call.updated', callId: call.id });
  }

  private async sendSummary(call: CallWithRelations, status: CallStatus, slot: string | null) {
    const p = call.patient;
    const a = call.appointment;
    const msgs = buildSummaryMessages(
      { ...p, appointmentAt: a.at, location: a.location, exams: a.exams, fastingStart: a.fastingStart },
      status,
      slot,
    );
    for (const m of msgs) {
      const sms = await this.prisma.smsLog.create({ data: { callId: call.id, ...m } });
      this.events.emit({ type: 'sms.created', callId: call.id, payload: sms });
    }
  }

  private async addTurn(
    callId: string,
    t: { speaker: 'agent' | 'user' | 'system'; text: string; segments?: string; latencyMs?: number; note?: string },
  ) {
    const seq = await this.prisma.turn.count({ where: { callId } });
    const turn = await this.prisma.turn.create({ data: { callId, seq, ...t } });
    this.events.emit({ type: 'turn.created', callId, payload: turn });
    return turn;
  }

  private async respond(callId: string, r: AgentTurnResult) {
    const call = await this.prisma.call.findUniqueOrThrow({ where: { id: callId }, include: { patient: true, appointment: true } });
    return {
      call: this.summary(call),
      utterances: r.utterances,
      agent: {
        model: this.agent.model,
        llmCalls: r.llmCalls,
        latencyMs: r.latencyMs,
        toolCalls: r.toolCalls.map((t) => ({ name: t.name, ok: t.ok, latencyMs: t.latencyMs, input: t.input })),
        notes: r.notes,
      },
      ended: r.state.ended,
    };
  }

  private summary(call: CallWithRelations) {
    return {
      id: call.id,
      patientId: call.patientId,
      patientName: call.patient.name,
      status: call.status,
      phase: call.phase,
      respondent: call.respondent,
      requestedSlot: call.requestedSlot,
      appointmentAt: call.appointment.at,
      startedAt: call.startedAt,
      endedAt: call.endedAt,
    };
  }

  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    this.locks.set(key, next);
    try {
      return await next;
    } finally {
      if (this.locks.get(key) === next) this.locks.delete(key);
    }
  }
}
