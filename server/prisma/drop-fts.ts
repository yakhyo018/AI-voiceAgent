/**
 * prisma db push 전에 FTS5 가상 테이블을 지움.
 * (Prisma 스키마에 없는 테이블이라 그대로 두면 db push 가 "데이터 손실" 경고로 멈춤 — seed 에서 다시 만듦)
 */
async function main() {
  let PrismaClient: typeof import('@prisma/client').PrismaClient;
  try {
    ({ PrismaClient } = await import('@prisma/client'));
  } catch {
    return; // 클라이언트 미생성(최초 설치) → 지울 테이블도 없음
  }
  const prisma = new PrismaClient();
  try {
    await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS knowledge_fts');
  } catch {
    /* DB 파일이 아직 없으면 무시 */
  } finally {
    await prisma.$disconnect();
  }
}
main();
