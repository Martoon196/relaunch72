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
  /** Server-owned response grammar; callers still validate the full original contract. */
  outputSchema?: Record<string, unknown>;
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

  constructor(apiKey?: string) {
    if (apiKey !== undefined) {
      if (!apiKey.trim()) throw new Error('The explicit Anthropic API key must not be empty.');
      // Scoped callers do not broaden process-wide build authority or inherit
      // a different bearer token from the ambient environment.
      this.client = new Anthropic({ apiKey: apiKey.trim(), authToken: null, maxRetries: 4 });
      return;
    }
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
    if (req.outputSchema) params.output_config = { format: { type: 'json_schema', schema: providerJsonSchema(req.outputSchema) } };
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

/** Anthropic supports a subset of JSON Schema. Keep unsupported bounds as
 * descriptions for generation; AJV and content checks retain the full bounds.
 * Unlike the installed SDK transformer, preserve supported enum constraints. */
export function providerJsonSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const supported = new Set(['type', 'enum', 'const', 'required', 'description']);
  const out: Record<string, unknown> = {};
  const bounds: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    // Large ID catalogues multiply the compiled grammar (the live planning
    // schema hit the provider's internal limit). They remain supplied guidance
    // here and are enforced by the original server contract after generation.
    if (key === 'enum' && Array.isArray(value) && (value.length > 8 || JSON.stringify(value).length > 200)) bounds[key] = value;
    else if (supported.has(key)) out[key] = structuredClone(value);
    else if (key === 'properties') out.properties = Object.fromEntries(Object.entries(value as Record<string, Record<string, unknown>>).map(([k, v]) => [k, providerJsonSchema(v)]));
    else if (key === 'items') out.items = providerJsonSchema(value as Record<string, unknown>);
    else if (key === 'additionalProperties') continue;
    else if (key === 'minItems' && (value === 0 || value === 1)) out[key] = value;
    else bounds[key] = value;
  }
  if (schema.type === 'object') out.additionalProperties = false;
  if (Object.keys(bounds).length) out.description = [out.description, 'Server validation constraints: ' + JSON.stringify(bounds)].filter(Boolean).join('\n');
  return out;
}
