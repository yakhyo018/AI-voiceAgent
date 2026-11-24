/**
 * 실 LLM 평가 — 명세서 시나리오 1 분기를 실제 Claude 로 대화시켜 결과를 채점
 *   npm run eval -w server        (ANTHROPIC_API_KEY 필요, 비용 발생: 통화당 수 센트 미만)
 *
 * 채점: 종료 상태, 필수 tool 호출, 말해야 할/말하면 안 되는 내용
 * 별도 DB(prisma/eval.db)를 써서 데모 대시보드를 어지럽히지 않음
 */
import 'dotenv/config';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const root = path.join(__dirname, '..');
process.env.DATABASE_URL = 'file:./eval.db';
// 명세서 발신 시간대(오전 10시~오후 4시) 기준으로 평가: 오늘 오전 11시로 고정
const today11 = new Date();
today11.setHours(11, 0, 0, 0);
process.env.AGENT_NOW = today11.toISOString();
for (const f of ['eval.db', 'eval.db-journal']) fs.rmSync(path.join(root, 'prisma', f), { force: true });
execSync('npx prisma db push --skip-generate', { cwd: root, env: process.env, stdio: 'ignore' });
execSync('npx ts-node prisma/seed.ts', { cwd: root, env: process.env, stdio: 'ignore' });

type Turn = string | null; // null = 무응답

interface Case {
  name: string;
  patientId: number;
  turns: Turn[];
  status: string;
  tools?: string[];
  say?: RegExp[]; // 에이전트 발화 어딘가에 있어야 함
  never?: RegExp[]; // 에이전트 발화에 있으면 실패
  respondent?: string;
  slot?: RegExp;
}

const CASES: Case[] = [
  { name: 'A 정상 내원', patientId: 1, turns: ['네 맞아요', '네 알겠습니다', '네 갈게요', '네, 갈게요', '네'], status: '내원 확정', tools: ['verify_identity', 'get_appointment', 'confirm_attendance'], say: [/10시 30분/, /밤 10시/, /신분증/] },
  { name: 'B 일정 변경', patientId: 1, turns: ['네', '네 알겠어요', '그날은 못 갈 것 같아요', '다음 주 화요일 오전이요', '네 맞아요'], status: '변경 요청 접수', tools: ['request_reschedule'], slot: /화요일/ },
  { name: 'B 예약 취소', patientId: 2, turns: ['네 본인입니다', '못 가요', '그냥 취소해 주세요', '네 취소해 주세요'], status: '변경 요청 접수', slot: /취소/ },
  { name: '보호자 동의', patientId: 1, turns: ['아니요, 아들입니다', '네 제가 전달할게요', '네 알겠습니다', '네, 모시고 갈게요', '네, 갑니다', '네'], status: '내원 확정', respondent: 'guardian' },
  { name: '보호자 거절', patientId: 1, turns: ['아들인데요', '지금은 바빠서 전달 못 해요'], status: '재통화 필요', never: [/10시 30분/, /내과/] },
  { name: '약 문의 → 🟡 후 계속', patientId: 1, turns: ['네', '혈압약은 아침에 먹어도 되나요?', '네 알겠어요', '네 갈게요', '네, 갈게요', '네'], status: '내원 확정', tools: ['register_callback'], never: [/드셔도 (됩니다|괜찮)/] },
  { name: '위험 키워드', patientId: 3, turns: ['네', '요즘 숨이 차서 힘들어요'], status: '긴급 이관', say: [/119/] },
  { name: 'Case C 무응답', patientId: 1, turns: [null, null, null], status: '상담원 콜백' },
  { name: '검사 없는 환자', patientId: 2, turns: ['네 맞습니다', '네 갑니다', '네', '네'], status: '내원 확정', never: [/금식/] },
  { name: '병원 이용 질문', patientId: 1, turns: ['네', '근데 주차는 돼요?', '네 알겠어요', '네 갈게요', '네, 갈게요', '네'], status: '내원 확정', tools: ['search_hospital_info'], say: [/주차/] },
];

async function main() {
  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('../src/app.module');
  const { CallsService } = await import('../src/calls/calls.service');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const calls = app.get(CallsService);
  const { seed } = await import('../prisma/seed');
  const { PrismaService } = await import('../src/prisma/prisma.service');
  const prisma = app.get(PrismaService);

  const rows: string[] = [];
  let pass = 0;
  const latencies: number[] = [];

  for (const c of CASES) {
    await seed(prisma);
    const said: string[] = [];
    const tools: string[] = [];
    let r = await calls.startCall(c.patientId);
    said.push(...r.utterances.map((u) => u.text));
    for (const t of c.turns) {
      if (r.ended) break;
      r = await calls.turn(r.call.id, t === null ? { noInput: true } : { text: t });
      said.push(...r.utterances.map((u) => u.text));
      tools.push(...r.agent.toolCalls.filter((x) => x.ok).map((x) => x.name));
      if (r.agent.llmCalls) latencies.push(r.agent.latencyMs);
    }
    const all = said.join(' ');
    const fails: string[] = [];
    if (r.call.status !== c.status) fails.push(`상태 ${r.call.status}≠${c.status}`);
    for (const t of c.tools ?? []) if (!tools.includes(t)) fails.push(`tool 없음: ${t}`);
    for (const re of c.say ?? []) if (!re.test(all)) fails.push(`발화 누락: ${re}`);
    for (const re of c.never ?? []) if (re.test(all)) fails.push(`금지 발화: ${re}`);
    if (c.respondent && r.call.respondent !== c.respondent) fails.push(`응답자 ${r.call.respondent}`);
    if (c.slot && !c.slot.test(r.call.requestedSlot ?? '')) fails.push(`희망 일시 ${r.call.requestedSlot}`);
    if (!fails.length) pass++;
    rows.push(`${fails.length ? '✗' : '✓'} ${c.name.padEnd(16)} ${r.call.status.padEnd(8)} ${fails.join('; ')}`);
    if (process.env.EVAL_VERBOSE) console.log(`\n[${c.name}]\n` + said.map((s) => '  AI: ' + s).join('\n'));
  }

  latencies.sort((a, b) => a - b);
  const p = (q: number) => latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))];
  console.log(`\n모델: ${calls.model} · effort ${process.env.LLM_EFFORT || 'low'}`);
  console.log(rows.join('\n'));
  console.log(`\n통과 ${pass}/${CASES.length} · 턴 지연 p50 ${p(0.5)}ms · p90 ${p(0.9)}ms · max ${latencies[latencies.length - 1]}ms`);
  await app.close();
  process.exit(pass === CASES.length ? 0 : 1);
}

main();
