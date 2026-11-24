import { Module } from '@nestjs/common';
import { AgentService } from './agent.service';
import { LLM_CLIENT } from './agent.types';
import { AnthropicLlmClient, MissingKeyLlmClient } from './llm.client';

@Module({
  providers: [
    AgentService,
    {
      provide: LLM_CLIENT,
      useFactory: () => {
        const key = process.env.ANTHROPIC_API_KEY?.trim();
        return key ? new AnthropicLlmClient(key) : new MissingKeyLlmClient();
      },
    },
  ],
  exports: [AgentService],
})
export class AgentModule {}
