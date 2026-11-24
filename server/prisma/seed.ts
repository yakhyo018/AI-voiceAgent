/**
 * 시드: 데모 환자 3명 + 예약 + 병원 안내 지식(FTS5 인덱스)
 * 해피콜은 "진료 전일" 발신이므로, 예약일은 실행 시점 기준 항상 "내일"로 맞춥니다.
 */
import { PrismaClient } from '@prisma/client';
import { KNOWLEDGE } from './faq-data';

const prisma = new PrismaClient();

function tomorrowAt(hour: number, minute: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(hour, minute, 0, 0);
  return d;
}

const PATIENTS = [
  {
    patient: { id: 1, name: '홍길동', phone: '010-1234-5678', hospital: '대구보훈병원', guardianName: '홍민수', guardianRelation: '아들', guardianPhone: '010-9876-5432' },
    appt: { id: 1, at: tomorrowAt(10, 30), department: '내과', location: '본관 2층 내과 외래', exams: '채혈 및 복부 초음파', examWhen: '오전', fastingStart: '밤 10시' },
  },
  {
    patient: { id: 2, name: '김영수', phone: '010-2222-3333', hospital: '대구보훈병원', guardianName: '김지은', guardianRelation: '딸', guardianPhone: '010-4444-5555' },
    appt: { id: 2, at: tomorrowAt(14, 0), department: '정형외과', location: '본관 3층 정형외과 외래', exams: null, examWhen: null, fastingStart: null },
  },
  {
    patient: { id: 3, name: '박순자', phone: '010-7777-8888', hospital: '대구보훈병원', guardianName: '이정호', guardianRelation: '남편', guardianPhone: '010-1111-2222' },
    appt: { id: 3, at: tomorrowAt(9, 0), department: '소화기내과', location: '신관 1층 소화기내과 외래', exams: '위 내시경', examWhen: '오전', fastingStart: '밤 9시' },
  },
];

export async function seed(client: PrismaClient = prisma) {
  for (const { patient, appt } of PATIENTS) {
    await client.patient.upsert({ where: { id: patient.id }, create: patient, update: patient });
    const data = { ...appt, patientId: patient.id, status: '예약' };
    await client.appointment.upsert({ where: { id: appt.id }, create: data, update: data });
  }

  for (const k of KNOWLEDGE) {
    await client.knowledgeArticle.upsert({ where: { id: k.id }, create: k, update: k });
  }
  // FTS5 전문 검색 인덱스 (임베디드, 외부 서비스 불필요). unicode61 + 접두어 검색으로 한국어 조사 대응
  await client.$executeRawUnsafe('DROP TABLE IF EXISTS knowledge_fts');
  await client.$executeRawUnsafe(
    "CREATE VIRTUAL TABLE knowledge_fts USING fts5(id UNINDEXED, topic, content, tags, tokenize='unicode61')",
  );
  await client.$executeRawUnsafe(
    'INSERT INTO knowledge_fts (id, topic, content, tags) SELECT id, topic, content, tags FROM KnowledgeArticle',
  );
  console.log(`[seed] 환자·예약 ${PATIENTS.length}건 (예약일: 내일), 안내 지식 ${KNOWLEDGE.length}건 + FTS5 인덱스`);
}

if (require.main === module) {
  seed()
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
