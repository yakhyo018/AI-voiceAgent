// 모든 테스트: 별도 SQLite(prisma/test.db) 사용. LLM 은 각 테스트에서 가짜 LLM(FakeLlm)으로 교체
process.env.DATABASE_URL = 'file:./test.db';
delete process.env.AGENT_NOW;
