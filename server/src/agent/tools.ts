/**
 * 에이전트 tool — LLM 이 "무엇을 할지" 정하면, 실행과 검증은 서버 코드가 함
 *
 *  - tool 은 사실(데이터)과 처리 결과만 돌려주고, 환자에게 할 말(대사)은 돌려주지 않음
 *  - 가드: 본인/보호자 확인 전 예약 조회 금지, 처리 안 된 결과로 종료 금지 등
 *    → 위반 시 is_error 결과를 돌려주고 LLM 이 대화로 바로잡게 함
 */
import type Anthropic from '@anthropic-ai/sdk';
import { koreanDate, koreanTime, relativeDay } from '../common/korean-time';
import type { PrismaService } from '../prisma/prisma.service';
import { AgentState, END_STATUSES, EndStatus } from './agent.types';

export const TOOLS: Anthropic.Tool[] = [
  {
    name: 'verify_identity',
    description:
      '전화 받은 사람이 환자 본인인지 보호자인지 확인되면 호출한다. 보호자라면 진료 일정 전달에 동의했는지도 함께 기록한다. ' +
      '본인이거나 동의한 보호자일 때만 이후 예약 정보를 조회할 수 있다.',
    input_schema: {
      type: 'object',
      properties: {
        respondent: { type: 'string', enum: ['patient', 'guardian'], description: '본인=patient, 가족·보호자=guardian' },
        guardian_consent: { type: 'boolean', description: '보호자가 일정 전달에 동의했는지 (보호자일 때만)' },
      },
      required: ['respondent'],
    },
  },
  {
    name: 'get_appointment',
    description: '본인/보호자 확인 후, 이번 예약의 날짜·시간·장소·도착 시간·준비물·검사·금식 정보를 조회한다. 안내 전에 반드시 호출한다.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'search_hospital_info',
    description:
      '주차, 접수 위치, 휠체어, 보호자 동반, 교통, 지각, 진료비, 준비물 등 병원 이용 질문에 답하기 전에 병원 안내 자료를 검색한다. ' +
      '검색 결과에 없는 내용은 답하지 않는다.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: '짧은 명사 키워드 1~3개, 공백 구분 (예: "주차", "휠체어 계단")' } },
      required: ['query'],
    },
  },
  {
    name: 'register_callback',
    description:
      '사람이 확인해야 할 일을 상담원/간호사 콜백 리스트에 등록한다. ' +
      'yellow: 복용 약·증상 등 의료 질문, 답할 수 없는 문의, 2번 연속 알아듣지 못함·무응답, 일정 확인 곤란. red: 응급·위험 상황.',
    input_schema: {
      type: 'object',
      properties: {
        level: { type: 'string', enum: ['red', 'yellow'] },
        reason: { type: 'string', description: '담당자가 볼 짧은 사유 (한국어)' },
      },
      required: ['level', 'reason'],
    },
  },
  {
    name: 'confirm_attendance',
    description: '안내를 마친 뒤 환자가 예약 시간에 정상 내원하겠다고 하면 호출한다.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'request_reschedule',
    description: '환자가 예약일에 못 오면, 원하는 변경 날짜·시간대(또는 취소 희망)를 접수한다. 희망 일시를 먼저 물어본 뒤 호출한다.',
    input_schema: {
      type: 'object',
      properties: {
        desired_slot: { type: 'string', description: '환자가 말한 희망 일시를 짧게 정리 (예: "다음 주 화요일 오전")' },
        cancel: { type: 'boolean', description: '변경이 아니라 예약 취소를 원하면 true' },
      },
      required: [],
    },
  },
  {
    name: 'end_call',
    description:
      '대화 목적이 끝났을 때 마지막 인사와 함께 호출해 통화를 종료한다. ' +
      '내원 확정=confirm_attendance 완료, 변경 요청 접수=request_reschedule 완료, 재통화 필요=보호자가 전달 거절 등, ' +
      '상담원 콜백=알아듣기 어렵거나 사람이 이어받아야 함, 긴급 이관=응급 상황.',
    input_schema: {
      type: 'object',
      properties: { status: { type: 'string', enum: [...END_STATUSES] } },
      required: ['status'],
    },
  },
];

export interface ToolContext {
  prisma: PrismaService;
  callId: string;
  patientId: number;
  appointmentId: number;
  state: AgentState;
  now: Date;
}

export class ToolError extends Error {}

type Input = Record<string, unknown>;

async function searchKnowledge(prisma: PrismaService, query: string) {
  const terms = query
    .replace(/["'*():^]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 1)
    .slice(0, 5);
  if (!terms.length) return [];
  // FTS5: 각 키워드를 접두어 검색 (주차* → 주차장, 주차는 …)
  const match = terms.map((t) => `"${t}"*`).join(' OR ');
  let rows = await prisma.$queryRawUnsafe<{ id: string; topic: string; content: string }[]>(
    'SELECT id, topic, content FROM knowledge_fts WHERE knowledge_fts MATCH ? ORDER BY bm25(knowledge_fts) LIMIT 3',
    match,
  );
  if (!rows.length) {
    // 조사가 붙은 키워드 대비: 앞 2글자로 부분 일치 검색
    const like = terms.map((t) => `%${t.slice(0, 2)}%`);
    const where = like.map(() => '(topic LIKE ? OR tags LIKE ? OR content LIKE ?)').join(' OR ');
    rows = await prisma.$queryRawUnsafe(
      `SELECT id, topic, content FROM KnowledgeArticle WHERE ${where} LIMIT 3`,
      ...like.flatMap((l) => [l, l, l]),
    );
  }
  return rows.map((r) => ({ topic: r.topic, content: r.content }));
}

/** tool 실행. 가드 위반은 ToolError 로 던져 is_error 결과가 됨 */
export async function runTool(name: string, input: Input, ctx: ToolContext): Promise<unknown> {
  const s = ctx.state;
  switch (name) {
    case 'verify_identity': {
      const respondent = input.respondent === 'guardian' ? 'guardian' : 'patient';
      s.respondent = respondent;
      if (respondent === 'patient') {
        s.identityVerified = true;
        return { verified: true, respondent };
      }
      if (input.guardian_consent === true) {
        s.identityVerified = true;
        return { verified: true, respondent, guardian_consent: true };
      }
      return {
        verified: false,
        respondent,
        guardian_consent: input.guardian_consent ?? null,
        note: input.guardian_consent === false ? '전달 거절 — 예약 정보를 말하지 말 것' : '동의 여부를 먼저 물어볼 것',
      };
    }

    case 'get_appointment': {
      if (!s.identityVerified) throw new ToolError('본인 또는 동의한 보호자 확인 전에는 예약 정보를 조회할 수 없습니다. verify_identity 를 먼저 호출하세요.');
      const a = await ctx.prisma.appointment.findUniqueOrThrow({ where: { id: ctx.appointmentId }, include: { patient: true } });
      s.appointmentShared = true;
      const day = relativeDay(a.at, ctx.now);
      return {
        hospital: a.patient.hospital,
        day,
        date: koreanDate(a.at),
        time: koreanTime(a.at),
        department: a.department,
        location: a.location,
        arrive: '예약 시간 20분 전까지 접수처 도착',
        bring: ['신분증', '보훈병원 진료카드'],
        exams: a.exams ? { name: a.exams, when: `${day} ${a.examWhen ?? ''}`.trim() } : null,
        fasting: a.exams && a.fastingStart
          ? { start: `${relativeDay(new Date(a.at.getTime() - 86_400_000), ctx.now)} ${a.fastingStart} 이후`, rule: '물·커피·껌을 포함해 아무것도 먹지 않음', confirm: '금식 안내를 이해했는지 확인 필요' }
          : null,
      };
    }

    case 'search_hospital_info': {
      const results = await searchKnowledge(ctx.prisma, String(input.query ?? ''));
      return results.length ? { found: true, results } : { found: false, note: '안내 자료에 없음 — 지어내지 말고 상담원 연결 안내 + register_callback(yellow)' };
    }

    case 'register_callback': {
      const level = input.level === 'red' ? 'red' : 'yellow';
      const reason = String(input.reason ?? '').slice(0, 200) || '확인 필요';
      // 같은 통화에서 같은 사유 중복 등록 방지
      if (!s.callbacks.some((c) => c.level === level && c.reason === reason)) {
        await ctx.prisma.callback.create({ data: { callId: ctx.callId, patientId: ctx.patientId, level, reason } });
        s.callbacks.push({ level, reason });
      }
      return { registered: true, level };
    }

    case 'confirm_attendance': {
      if (!s.identityVerified) throw new ToolError('본인/보호자 확인 전입니다.');
      if (!s.appointmentShared) throw new ToolError('예약 안내(get_appointment) 전에는 내원 확정을 할 수 없습니다.');
      s.outcome = '내원 확정';
      await ctx.prisma.appointment.update({ where: { id: ctx.appointmentId }, data: { status: '내원 확정' } });
      return { confirmed: true };
    }

    case 'request_reschedule': {
      if (!s.identityVerified) throw new ToolError('본인/보호자 확인 전입니다.');
      const cancel = input.cancel === true;
      const slot = cancel ? '예약 취소' : String(input.desired_slot ?? '').trim();
      if (!slot) throw new ToolError('희망 날짜·시간대가 비어 있습니다. 환자에게 먼저 물어보세요.');
      s.outcome = '변경 요청 접수';
      s.requestedSlot = slot;
      await ctx.prisma.appointment.update({ where: { id: ctx.appointmentId }, data: { status: '변경 요청' } });
      return { accepted: true, requested: slot, follow_up: '담당 직원이 확인 후 확정 문자 발송' };
    }

    case 'end_call': {
      const status = String(input.status) as EndStatus;
      if (!END_STATUSES.includes(status)) throw new ToolError(`알 수 없는 종료 상태: ${status}`);
      if (status === '내원 확정' && s.outcome !== '내원 확정') throw new ToolError('confirm_attendance 가 아직 호출되지 않았습니다.');
      if (status === '변경 요청 접수' && s.outcome !== '변경 요청 접수') throw new ToolError('request_reschedule 가 아직 호출되지 않았습니다.');
      if (status === '상담원 콜백' && !s.callbacks.length) throw new ToolError('상담원 콜백으로 종료하려면 register_callback 을 먼저 호출하세요.');
      if (status === '긴급 이관' && !s.callbacks.some((c) => c.level === 'red')) throw new ToolError('긴급 이관은 red 콜백 등록 후에만 가능합니다.');
      s.status = status;
      s.ended = true;
      return { ended: true, status, note: '통화 종료 후 환자·보호자에게 요약 문자가 자동 발송됨' };
    }

    default:
      throw new ToolError(`알 수 없는 tool: ${name}`);
  }
}
