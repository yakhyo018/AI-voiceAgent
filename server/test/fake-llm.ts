/**
 * 테스트용 가짜 LLM — 실제 API 없이 에이전트 루프·tool 가드·폴백을 검증
 * respond(params, callIndex) 가 Claude 응답(Message)을 흉내 냄
 */
import type Anthropic from '@anthropic-ai/sdk';
import { LlmClient } from '../src/agent/agent.types';

let seq = 0;

export const text = (t: string): Anthropic.TextBlock => ({ type: 'text', text: t, citations: null }) as Anthropic.TextBlock;
export const use = (name: string, input: Record<string, unknown> = {}): Anthropic.ToolUseBlock =>
  ({ type: 'tool_use', id: `tu_${++seq}`, name, input }) as Anthropic.ToolUseBlock;

export function message(content: Anthropic.ContentBlock[]): Anthropic.Message {
  const hasTool = content.some((b) => b.type === 'tool_use');
  return {
    id: `msg_${++seq}`,
    type: 'message',
    role: 'assistant',
    model: 'fake',
    content,
    stop_reason: hasTool ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  } as unknown as Anthropic.Message;
}

type Params = Parameters<LlmClient['create']>[0];
export type Responder = (params: Params, n: number) => Anthropic.Message | Promise<Anthropic.Message>;

export class FakeLlm implements LlmClient {
  readonly model = 'fake-llm';
  calls: Params[] = [];
  private responder: Responder = () => message([text('네.')]);

  /** 다음 응답들을 순서대로 지정 */
  script(...responses: (Anthropic.ContentBlock[] | Error)[]) {
    const queue = [...responses];
    this.responder = () => {
      const r = queue.shift();
      if (!r) return message([text('네.')]);
      if (r instanceof Error) throw r;
      return message(r);
    };
  }

  respondWith(fn: Responder) {
    this.responder = fn;
  }

  async create(params: Params) {
    // 호출 시점의 메시지를 깊은 복사로 보관 (이후 변경과 무관하게 검사)
    this.calls.push(JSON.parse(JSON.stringify(params)));
    return this.responder(params, this.calls.length);
  }

  /** 마지막 호출에 담긴 마지막 user 메시지 */
  lastUserContent(): unknown {
    const p = this.calls[this.calls.length - 1];
    return p.messages[p.messages.length - 1].content;
  }
}
