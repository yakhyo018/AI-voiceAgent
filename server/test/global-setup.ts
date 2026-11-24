/** e2e 용 SQLite 테스트 DB 초기화 (dev.db 와 분리된 prisma/test.db 를 새로 생성) */
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export default async function globalSetup() {
  const root = path.join(__dirname, '..');
  for (const f of ['test.db', 'test.db-journal']) fs.rmSync(path.join(root, 'prisma', f), { force: true });
  const env = { ...process.env, DATABASE_URL: 'file:./test.db' };
  execSync('npx prisma db push --skip-generate', { cwd: root, env, stdio: 'ignore' });
  execSync('npx ts-node prisma/seed.ts', { cwd: root, env, stdio: 'ignore' });
}
