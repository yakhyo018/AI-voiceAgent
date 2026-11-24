import { Module } from '@nestjs/common';
import { AgentModule } from './agent/agent.module';
import { CallsModule } from './calls/calls.module';
import { EventsModule } from './events/events.module';
import { PrismaModule } from './prisma/prisma.service';
import { TtsModule } from './tts/tts.module';

@Module({
  imports: [PrismaModule, AgentModule, EventsModule, TtsModule, CallsModule],
})
export class AppModule {}
