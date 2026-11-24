/**
 * LLM 에이전트 — STT 텍스트 → Claude(tool calling) → TTS 텍스트
 *
 *  한 턴의 흐름
 *   1) 위험 키워드 안전망(규칙): 감지 시 🔴 콜백을 먼저 등록하고 LLM 에게 시스템 알림으로 전달
 *   2) 에이전트 루프: Claude 응답이 tool_use 면 서버가 실행·검증 → tool_result 로 돌려줌 → 최종 문장까지 반복
 *   3) 출력: Claude 가 쓴 문장 → {환자명} 치환 + 핵심 숫자 휴지기 세그먼트
 *   4) 백스톱: 위험 감지 후 미종료 / 연속 무응답 3회 / LLM 실패 → 서버가 종료·콜백을 강제
 *
 *  대화 기록(history)은 append-only 로 유지 (thinking 블록 포함 응답을 그대로 이어 붙임)
 */
import Anthropic from '@anthropic-ai/sdk';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { detectRisk } from '../safety/risk';
import {
  AgentState,
  AgentTurnResult,
  LLM_CLIENT,
  LlmClient,
  ToolCallRecord,
  Utterance,
} from './agent.types';
import { buildSystem } from './prompt';
import { toUtterance } from './speech';
import { TOOLS, ToolError, runTool } from './tools';

const MAX_STEPS = Number(process.env.AGENT_MAX_STEPS) || 5;

/** LLM 이 응답하지 못할 때만 쓰는 고정 안내 (안전망 — 평소 대사는 모두 LLM 이 생성) */
export const FALLBACK = {
  llmDown: '죄송합니다, 지금 연결 상태가 좋지 않습니다. 잠시 후 병원 상담원이 다시 연락드리겠습니다. 감사합니다.',
  emergency: '많이 불편하신 것 같아 걱정됩니다. 담당 간호사와 관제센터에 바로 알렸습니다. 위급하시면 지금 119에 전화해 주세요.',
  noInput: '목소리가 잘 들리지 않아 잠시 후 병원 상담원이 직접 전화드리겠습니다. 감사합니다.',
};

export interface AgentCall {
  callId: string;
  patientId: number;
  patientName: string;
  appointmentId: number;
  hospital: string;
  state: AgentState;
  history: Anthropic.MessageParam[];
  now?: Date;
}

@Injectable()
export class AgentService {
  private readonly logger = new Logger('Agent');

  constructor(
    private readonly prisma: PrismaService,
    @Inject(LLM_CLIENT) private readonly llm: LlmClient,
  ) {}

  get model() {
    return this.llm.model;
  }

  /** 발신 직후: 첫 인사 */
  start(call: AgentCall): Promise<AgentTurnResult> {
    return this.run(call, '[시스템] 전화가 연결되어 상대방이 받았습니다. 첫 인사를 하고 본인 확인을 시작하세요.', []);
  }

  /** 환자 발화 1턴 (text 또는 무응답) */
  async turn(call: AgentCall, input: { text?: string; noInput?: boolean }): Promise<AgentTurnResult> {
    const s = call.state;
    const text = input.text?.trim() ?? '';
    const notes: string[] = [];
    s.userTurns += 1;

    if (input.noInput || !text) {
      s.consecutiveNoInput += 1;
      if (s.consecutiveNoInput >= 3) {
        // 백스톱: LLM 이 무응답 2회 규칙을 놓쳐도 3회째엔 서버가 종료
        await this.addCallback(call, 'yellow', '연속 무응답 3회 — 상담원 확인 필요');
        s.status = '상담원 콜백';
        s.ended = true;
        notes.push('연속 무응답 3회 → 서버가 상담원 콜백으로 종료');
        return this.fixed(call, FALLBACK.noInput, notes);
      }
      return this.run(call, `[시스템] 상대방이 아무 말도 하지 않았습니다 (무응답, 연속 ${s.consecutiveNoInput}회).`, notes);
    }
    s.consecutiveNoInput = 0;

    // 1) 위험 키워드 안전망 — LLM 보다 먼저, 지연·오류와 무관하게
    const risk = detectRisk(text);
    let content = `환자: "${text}"`;
    if (risk && !s.emergency) {
      s.emergency = true;
      await this.addCallback(call, 'red', `위험 표현 감지: "${risk}"`);
      notes.push(`위험 키워드 "${risk}" → 🔴 적색 콜백 선등록`);
      content +=
        `\n[시스템] 위험 표현("${risk}")이 감지되어 적색 콜백이 이미 등록되었습니다. ` +
        '짧게 공감하고, 담당 간호사·관제센터에 알렸으며 위급하면 바로 119에 전화하시라고 안내한 뒤 end_call(긴급 이관) 하세요.';
    }

    const result = await this.run(call, content, notes);

    if (s.emergency && !s.ended) {
      // 백스톱: LLM 이 종료하지 않았으면 서버가 긴급 이관으로 종료
      s.status = '긴급 이관';
      s.ended = true;
      result.notes.push('위험 감지 후 LLM 미종료 → 서버가 긴급 이관 종료');
      if (!result.utterances.length) result.utterances.push(toUtterance(FALLBACK.emergency, call.patientName));
    }
    return result;
  }

  // ── 에이전트 루프 ─────────────────────────────────────

  private async run(call: AgentCall, userContent: string, notes: string[]): Promise<AgentTurnResult> {
    const t0 = Date.now();
    const s = call.state;
    const history = [...call.history, { role: 'user' as const, content: userContent }];
    const system = buildSystem({ hospital: call.hospital, now: call.now ?? new Date() });
    const utterances: Utterance[] = [];
    const toolCalls: ToolCallRecord[] = [];
    let llmCalls = 0;

    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        llmCalls++;
        const res = await this.llm.create({ system, tools: TOOLS, messages: history });
        history.push({ role: 'assistant', content: res.content });

        for (const block of res.content) {
          if (block.type === 'text' && block.text.trim()) utterances.push(toUtterance(block.text, call.patientName));
        }
        if (res.stop_reason === 'refusal') {
          notes.push('LLM refusal');
          break;
        }

        const uses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
        if (res.stop_reason !== 'tool_use' || !uses.length) break;

        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const use of uses) {
          const r = await this.exec(call, use, toolCalls);
          results.push(r);
        }
        history.push({ role: 'user', content: results });
        // end_call 이후엔 더 생성하지 않음 (마지막 인사는 같은 응답에서 이미 말함)
        if (s.ended) break;
        if (step === MAX_STEPS - 1) notes.push(`tool 루프 상한(${MAX_STEPS}) 도달`);
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[${call.callId}] LLM 실패 → 폴백 종료: ${reason}`);
      notes.push(`LLM 실패 → 폴백: ${reason.slice(0, 120)}`);
      if (!s.ended) {
        await this.addCallback(call, 'yellow', 'AI 응답 오류 — 상담원 재연락 필요');
        if (!s.emergency) s.status = '상담원 콜백';
        else s.status = '긴급 이관';
        s.ended = true;
      }
      utterances.push(toUtterance(s.emergency ? FALLBACK.emergency : FALLBACK.llmDown, call.patientName));
      // 실패한 턴은 기록을 이어 붙이지 않음 (미완성 tool_use 가 남지 않도록) — 통화는 종료됨
      return { state: s, history: call.history, utterances, toolCalls, llmCalls, latencyMs: Date.now() - t0, notes };
    }

    const latencyMs = Date.now() - t0;
    this.logger.log(
      `[${call.callId}] ${llmCalls} LLM 호출, tools=[${toolCalls.map((t) => t.name).join(', ')}] ${latencyMs}ms`,
    );
    return { state: s, history, utterances, toolCalls, llmCalls, latencyMs, notes };
  }

  private async exec(call: AgentCall, use: Anthropic.ToolUseBlock, log: ToolCallRecord[]): Promise<Anthropic.ToolResultBlockParam> {
    const t0 = Date.now();
    const input = (use.input ?? {}) as Record<string, unknown>;
    try {
      const output = await runTool(use.name, input, {
        prisma: this.prisma,
        callId: call.callId,
        patientId: call.patientId,
        appointmentId: call.appointmentId,
        state: call.state,
        now: call.now ?? new Date(),
      });
      log.push({ name: use.name, input, output, ok: true, latencyMs: Date.now() - t0 });
      return { type: 'tool_result', tool_use_id: use.id, content: JSON.stringify(output) };
    } catch (err) {
      const message = err instanceof ToolError ? err.message : `내부 오류: ${(err as Error).message}`;
      log.push({ name: use.name, input, output: { error: message }, ok: false, latencyMs: Date.now() - t0 });
      return { type: 'tool_result', tool_use_id: use.id, content: message, is_error: true };
    }
  }

  private async addCallback(call: AgentCall, level: 'red' | 'yellow', reason: string) {
    await this.prisma.callback.create({ data: { callId: call.callId, patientId: call.patientId, level, reason } });
    call.state.callbacks.push({ level, reason });
  }

  /** LLM 없이 서버가 마무리하는 경우 (백스톱) */
  private fixed(call: AgentCall, text: string, notes: string[]): AgentTurnResult {
    return {
      state: call.state,
      history: call.history,
      utterances: [toUtterance(text, call.patientName)],
      toolCalls: [],
      llmCalls: 0,
      latencyMs: 0,
      notes,
    };
  }
}
