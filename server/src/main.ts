import 'dotenv/config';
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  app.enableCors();
  app.enableShutdownHooks();
  // 안전장치: 종료가 3초 안에 끝나지 않으면 강제 종료 (dev watch 재시작 보장)
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.once(sig, () => setTimeout(() => process.exit(0), 3000).unref());
  }
  const port = Number(process.env.API_PORT) || 3001; // PORT 는 프론트 개발 서버가 쓰는 경우가 있어 분리
  await app.listen(port);
  Logger.log(`AI 보훈이 서버: http://localhost:${port}/api`, 'Bootstrap');
}
bootstrap();
