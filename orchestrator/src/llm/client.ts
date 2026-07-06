import Anthropic from '@anthropic-ai/sdk';

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface LlmRequest {
  model: string;
  maxTokens: number;
  system: string;
  messages: LlmMessage[];
  /** Adaptive thinking (default on). Large copy stages pass false — see StageDef.thinking. */
  thinking?: boolean;
  /** Runner metadata (used by the mock client; ignored by the real one). */
  meta?: { stage: string; attempt: number };
}

export interface LlmResponse {
  text: string;
  tokensIn: number;
  tokensOut: number;
  stopReason: string | null;
  model: string;
}

export interface LlmClient {
  readonly mode: 'live' | 'mock';
  complete(req: LlmRequest): Promise<LlmResponse>;
}

export class AnthropicClient implements LlmClient {
  readonly mode = 'live' as const;
  private client: Anthropic;

  constructor() {
    if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
      throw new Error(
        'No Anthropic credentials: set ANTHROPIC_API_KEY in <repo root>/.env (see .env.example), or use --mock for a no-cost mechanics run.',
      );
    }
    // SDK retries 429/5xx with backoff; M5 layers alerting/dead-letter on top.
    this.client = new Anthropic({ maxRetries: 4 });
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const params: Anthropic.MessageCreateParams = {
      model: req.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
    };
    // Adaptive thinking is a 4.6+ feature; Haiku-class models reject it, and
    // large output-only stages disable it (req.thinking === false) so the token
    // budget goes to the deliverable, not to reasoning it doesn't need.
    if (!/haiku/i.test(req.model) && req.thinking !== false) {
      params.thinking = { type: 'adaptive' };
    }
    // Streamed transport, collected to one message: the SDK requires
    // streaming above ~8 minutes of potential generation (32k budget), and
    // long thinking turns were breaking non-streaming calls. The runner's
    // contract is unchanged — it still sees the complete final message.
    const resp = await this.client.messages.stream(params).finalMessage();

    const text = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n');

    return {
      text,
      tokensIn: resp.usage.input_tokens,
      tokensOut: resp.usage.output_tokens,
      stopReason: resp.stop_reason,
      model: resp.model,
    };
  }
}
