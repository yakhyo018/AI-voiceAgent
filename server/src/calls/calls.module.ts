import { Module } from '@nestjs/common';
import { AgentModule } from '../agent/agent.module';
import { EventsModule } from '../events/events.module';
import { TtsModule } from '../tts/tts.module';
import { CallsController } from './calls.controller';
import { CallsService } from './calls.service';

@Module({
  imports: [AgentModule, EventsModule, TtsModule],
  controllers: [CallsController],
  providers: [CallsService],
})
export class CallsModule {}
