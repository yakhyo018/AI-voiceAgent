/**
 * REST e2e: 발신 → 턴 → 종료 (가짜 LLM, prisma/test.db)
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { LLM_CLIENT } from '../src/agent/agent.types';
import { AppModule } from '../src/app.module';
import { FakeLlm, text, use } from './fake-llm';

describe('Calls API (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  const llm = new FakeLlm();

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(LLM_CLIENT).useValue(llm).compile();
    app = mod.createNestApplication({ logger: false });
    app.setGlobalPrefix('api');
    await app.init();
    http = request(app.getHttpServer());
  });

  afterAll(() => app.close());

  const start = async (patientId: number) => {
    llm.script([text('안녕하세요, AI 보훈이입니다. {환자명} 환자분 맞으신가요?')]);
    return (await http.post('/api/calls').send({ patientId }).expect(201)).body;
  };
  const turn = (id: string, body: object) => http.post(`/api/calls/${id}/turn`).send(body);

  it('설정: LLM 에이전트 아키텍처', async () => {
    const res = await http.get('/api/config').expect(200);
    expect(res.body).toMatchObject({ architecture: 'llm-agent', model: 'fake-llm', llmEnabled: true });
  });

  it('환자 3명 + 예약 (검사 없는 환자 포함)', async () => {
    const res = await http.get('/api/patients').expect(200);
    expect(res.body).toHaveLength(3);
    expect(res.body.some((p: { appointments: { exams: string | null }[] }) => p.appointments[0].exams === null)).toBe(true);
  });

  it('변경 요청 흐름 + 턴 기록(tool·끼어들기) + 종료 후 409', async () => {
    const s = await start(2);
    expect(s.utterances[0].text).toContain('김영수 환자분');
    llm.script(
      [use('verify_identity', { respondent: 'patient' }), use('get_appointment')],
      [text('내일 오후 2시 진료입니다. 오실 수 있으세요?')],
    );
    await turn(s.call.id, { text: '네' }).expect(201);
    llm.script(
      [use('request_reschedule', { desired_slot: '다음 주 화요일 오전' }), use('end_call', { status: '변경 요청 접수' }), text('접수되었습니다.')],
    );
    const r = await turn(s.call.id, { text: '못 가요, 다음 주 화요일 오전이요', bargeIn: true }).expect(201);
    expect(r.body.call).toMatchObject({ status: '변경 요청 접수', requestedSlot: '다음 주 화요일 오전' });

    const d = (await http.get(`/api/calls/${s.call.id}`).expect(200)).body;
    const lastUser = d.turns.filter((t: { speaker: string }) => t.speaker === 'user').pop();
    expect(lastUser.note).toContain('끼어들기');
    expect(lastUser.note).toContain('request_reschedule');
    expect(d.toolCalls).toHaveLength(4);
    expect(d.sms).toHaveLength(2);
    await turn(s.call.id, { text: '네' }).expect(409);
  });

  it('잘못된 요청 검증', async () => {
    await http.post('/api/calls').send({}).expect(400);
    await http.post('/api/calls').send({ patientId: 999 }).expect(404);
    const s = await start(1);
    await turn(s.call.id, {}).expect(400);
  });

  it('통화 중단(hangup)도 요약 문자 발송', async () => {
    const s = await start(3);
    const r = await http.post(`/api/calls/${s.call.id}/hangup`).expect(201);
    expect(r.body.status).toBe('통화 중단');
    expect(r.body.sms).toHaveLength(2);
  });
});
