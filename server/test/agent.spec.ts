/**
 * LLM 에이전트 — 가짜 LLM 으로 루프·tool 가드·안전망·폴백 검증 (prisma/test.db)
 */
import { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { LLM_CLIENT } from '../src/agent/agent.types';
import { autoMark, toUtterance } from '../src/agent/speech';
import { AppModule } from '../src/app.module';
import { CallsService } from '../src/calls/calls.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { seed } from '../prisma/seed';
import { FakeLlm, text, use } from './fake-llm';

describe('LLM 에이전트', () => {
  let app: INestApplicationContext;
  let calls: CallsService;
  let prisma: PrismaService;
  const llm = new FakeLlm();

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(LLM_CLIENT)
      .useValue(llm)
      .compile();
    app = mod.createNestApplication({ logger: false });
    await (app as { init(): Promise<unknown> }).init();
    calls = app.get(CallsService);
    prisma = app.get(PrismaService);
  });

  beforeEach(async () => {
    llm.calls = [];
    await seed(prisma); // 예약 상태 초기화
  });

  afterAll(() => app.close());

  async function start(patientId = 1) {
    llm.script([text('안녕하세요, 대구보훈병원 AI 보훈이입니다. {환자명} 환자분 본인 맞으신가요?')]);
    return calls.startCall(patientId);
  }

  it('첫 인사: LLM 이 쓴 문장 + 이름 토큰 치환, LLM 에는 실명 미전송', async () => {
    const r = await start();
    expect(r.utterances[0].text).toBe('안녕하세요, 대구보훈병원 AI 보훈이입니다. 홍길동 환자분 본인 맞으신가요?');
    expect(JSON.stringify(llm.calls[0])).not.toContain('홍길동');
    expect(r.call.phase).toBe('본인 확인');
  });

  it('정상 흐름: 본인 확인 → 예약 조회 → 내원 확정 → 종료 + 요약 문자', async () => {
    const s = await start();
    // 본인 확인 + 예약 조회를 한 응답에서 병렬 호출 → 안내 문장
    llm.script(
      [use('verify_identity', { respondent: 'patient' }), use('get_appointment')],
      [text('내일 [[오전 10시 30분]] 진료가 있습니다. 금식 안내 잘 이해하셨을까요?')],
    );
    const r1 = await calls.turn(s.call.id, { text: '네 맞아요' });
    expect(r1.agent.toolCalls.map((t) => [t.name, t.ok])).toEqual([
      ['verify_identity', true],
      ['get_appointment', true],
    ]);
    expect(r1.utterances[0].segments.find((x) => x.key)).toMatchObject({ text: '오전 10시 30분', pauseBeforeMs: 500 });
    // 예약 조회 결과(tool_result)가 다음 LLM 호출에 그대로 전달됨
    const appt = JSON.parse((llm.lastUserContent() as { content: string }[])[1].content);
    expect(appt).toMatchObject({ day: '내일', location: '본관 2층 내과 외래', fasting: { start: '오늘 밤 10시 이후' } });

    llm.script([use('confirm_attendance'), use('end_call', { status: '내원 확정' }), text('내일 뵙겠습니다. 감사합니다.')]);
    const r2 = await calls.turn(s.call.id, { text: '네 갈게요' });
    expect(r2.ended).toBe(true);
    expect(r2.call.status).toBe('내원 확정');
    const detail = await calls.getCall(s.call.id);
    expect(detail.sms.map((m) => m.recipientType)).toEqual(['patient', 'guardian']);
    expect(detail.toolCalls.map((t) => t.name)).toEqual(['verify_identity', 'get_appointment', 'confirm_attendance', 'end_call']);
    expect((await prisma.appointment.findUnique({ where: { id: 1 } }))?.status).toBe('내원 확정');
  });

  it('가드: 본인 확인 전 예약 조회 → is_error 결과를 LLM 에 돌려줌', async () => {
    const s = await start();
    llm.script([use('get_appointment')], [text('먼저 본인 확인을 부탁드립니다.')]);
    const r = await calls.turn(s.call.id, { text: '내일 몇 시예요?' });
    expect(r.agent.toolCalls[0]).toMatchObject({ name: 'get_appointment', ok: false });
    const result = (llm.lastUserContent() as { is_error?: boolean; content: string }[])[0];
    expect(result.is_error).toBe(true);
    expect(result.content).toContain('verify_identity');
  });

  it('가드: 내원 확정 없이 end_call(내원 확정) → 거부, 통화 계속', async () => {
    const s = await start();
    llm.script([use('end_call', { status: '내원 확정' })], [text('다시 여쭤볼게요.')]);
    const r = await calls.turn(s.call.id, { text: '네' });
    expect(r.ended).toBe(false);
    expect(r.agent.toolCalls[0].ok).toBe(false);
  });

  it('보호자가 전달 거절 → 예약 정보 조회 불가', async () => {
    const s = await start();
    llm.script([use('verify_identity', { respondent: 'guardian', guardian_consent: false }), use('get_appointment')], [text('네, 알겠습니다.')]);
    const r = await calls.turn(s.call.id, { text: '아들인데 지금은 전달 못 해요' });
    expect(r.agent.toolCalls.map((t) => t.ok)).toEqual([true, false]);
    expect(r.call.phase).toBe('보호자 동의 확인');
  });

  it('병원 안내 검색 (FTS5): 있으면 결과, 없으면 found=false', async () => {
    const s = await start();
    llm.script([use('search_hospital_info', { query: '주차' }), use('search_hospital_info', { query: '맛집' })], [text('네.')]);
    await calls.turn(s.call.id, { text: '주차 돼요? 근처 맛집도요' });
    const [parking, food] = (llm.lastUserContent() as { content: string }[]).map((c) => JSON.parse(c.content));
    expect(parking.found).toBe(true);
    expect(parking.results[0].topic).toBe('주차');
    expect(food.found).toBe(false);
  });

  it('위험 키워드 안전망: LLM 전에 🔴 등록 + 시스템 알림, LLM 이 안 끝내도 서버가 긴급 이관', async () => {
    const s = await start();
    let redBeforeLlm = false;
    llm.respondWith(async () => {
      redBeforeLlm = (await prisma.callback.count({ where: { callId: s.call.id, level: 'red' } })) === 1;
      return (await import('./fake-llm')).message([text('많이 불편하시군요. 119에 바로 전화해 주세요.')]);
    });
    const r = await calls.turn(s.call.id, { text: '가슴이 너무 아파요' });
    expect(redBeforeLlm).toBe(true);
    expect(String(llm.lastUserContent())).toContain('[시스템] 위험 표현');
    expect(r.ended).toBe(true);
    expect(r.call.status).toBe('긴급 이관');
    expect(r.agent.notes.join(' ')).toContain('서버가 긴급 이관');
  });

  it('LLM 실패 → 고정 안내 후 상담원 콜백으로 종료 (통화가 멈추지 않음)', async () => {
    const s = await start();
    llm.script(new Error('Request timed out.'));
    const r = await calls.turn(s.call.id, { text: '네' });
    expect(r.ended).toBe(true);
    expect(r.call.status).toBe('상담원 콜백');
    expect(r.utterances[0].text).toContain('상담원이 다시 연락드리겠습니다');
    expect(await prisma.callback.count({ where: { callId: s.call.id, level: 'yellow' } })).toBe(1);
  });

  it('무응답: LLM 에 시스템 알림, 3회 연속이면 LLM 없이 서버가 종료', async () => {
    const s = await start();
    llm.script([text('죄송합니다, 잘 듣지 못했습니다.')], [text('혹시 들리시나요?')]);
    await calls.turn(s.call.id, { noInput: true });
    expect(String(llm.lastUserContent())).toContain('무응답, 연속 1회');
    await calls.turn(s.call.id, { noInput: true });
    const before = llm.calls.length;
    const r = await calls.turn(s.call.id, { noInput: true });
    expect(llm.calls.length).toBe(before);
    expect(r.call.status).toBe('상담원 콜백');
  });

  it('tool 루프 상한: 계속 tool 만 부르면 멈춤', async () => {
    const s = await start();
    llm.respondWith(async () => (await import('./fake-llm')).message([use('search_hospital_info', { query: '주차' })]));
    const r = await calls.turn(s.call.id, { text: '주차' });
    expect(r.agent.llmCalls).toBe(5);
    expect(r.agent.notes.join(' ')).toContain('상한');
  });
});

describe('음성 출력 변환', () => {
  it('이름 토큰 (변형 포함) 치환', () => {
    expect(toUtterance('{환자명} 환자분', '홍길동').text).toBe('홍길동 환자분');
    expect(toUtterance('{±환자명} 환자분', '홍길동').text).toBe('홍길동 환자분');
  });

  it('LLM 이 [[ ]] 를 빠뜨려도 날짜·시간에 휴지기 자동 표시', () => {
    expect(autoMark('내일 11월 27일 금요일 오전 10시 30분에 오세요. 오늘 밤 10시 이후 금식')).toBe(
      '내일 [[11월 27일 금요일 오전 10시 30분]]에 오세요. 오늘 [[밤 10시]] 이후 금식',
    );
    const segs = toUtterance('예약 [[20분 전]]까지 오세요', '홍길동').segments;
    expect(segs.map((s) => s.key)).toEqual([false, true, false]);
  });
});
