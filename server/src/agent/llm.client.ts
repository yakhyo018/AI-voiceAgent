/**
 * Claude 클라이언트 (실제 LLM 포트 구현)
 *  - 모델·추론 강도·타임아웃은 env 로 조정 (기본: claude-haiku-5-5, effort low)
 *  - 재시도 1회 (일시 오류 대비), 그 이상은 에이전트가 폴백 처리
 *  - tool 정의와 고정 규칙(system 블록 1)은 매 호출 동일 → 프롬프트 캐시 적중
 */
import Anthropic from '@anthropic-ai/sdk';
import { Logger } from '@nestjs/common';
import { LlmClient } from './agent.types';

type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export class AnthropicLlmClient implements LlmClient {
  private readonly logger = new Logger('LLM');
  private readonly client: Anthropic;
  readonly model = process.env.LLM_MODEL || 'claude-haiku-5-5';
  private readonly effort = (process.env.LLM_EFFORT || 'low') as Effort;
  private readonly timeoutMs = Number(process.env.LLM_TIMEOUT_MS) || 10000;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
    this.logger.log(`${this.model} (effort ${this.effort}, timeout ${this.timeoutMs}ms)`);
  }

  async create(params: { system: Anthropic.TextBlockParam[]; tools: Anthropic.Tool[]; messages: Anthropic.MessageParam[] }) {
    const t0 = Date.now();
    const res = await this.client.messages.create(
      {
        model: this.model,
        max_tokens: 4000,
        system: params.system,
        tools: params.tools,
        messages: params.messages,
        output_config: { effort: this.effort },
      },
      { timeout: this.timeoutMs, maxRetries: 1 },
    );
    const u = res.usage;
    this.logger.debug(
      `${Date.now() - t0}ms stop=${res.stop_reason} in=${u.input_tokens} cache_read=${u.cache_read_input_tokens ?? 0} out=${u.output_tokens}`,
    );
    return res;
  }
}

/** API 키가 없을 때: 즉시 실패 → 에이전트가 폴백 안내 후 상담원 콜백 */
export class MissingKeyLlmClient implements LlmClient {
  readonly model = 'none';
  async create(): Promise<Anthropic.Message> {
    throw new Error('ANTHROPIC_API_KEY 가 설정되지 않았습니다');
  }
}
