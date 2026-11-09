/** One provider request only. Durable authority, budgets and receipts belong to the caller. */
import { createHash } from 'node:crypto';

export const SEO_IMAGE_REQUEST = Object.freeze({
  endpoint: 'https://api.openai.com/v1/images/generations', model: 'gpt-image-2',
  n: 1, size: '1536x1024', quality: 'medium', output_format: 'jpeg',
  output_compression: 85, background: 'opaque', moderation: 'auto',
});
export const SEO_IMAGE_TRANSPORT_LIMITS = Object.freeze({
  promptCharacters: 8000, promptBytes: 32 * 1024, responseBytes: 12 * 1024 * 1024,
  imageBytes: 8 * 1024 * 1024, timeoutMs: 240_000,
});
export interface ImageGenerationCommand {
  readonly brandId: string;
  readonly actorId: string;
  readonly prompt: string;
}
export interface PreparedImageGenerationRequest {
  readonly requestSha256: string;
  readonly parameters: Readonly<Omit<typeof SEO_IMAGE_REQUEST, 'endpoint'>>;
  /** Private immutable fields; persist explicitly rather than in ordinary metadata logs. */
  readonly command: ImageGenerationCommand;
  readonly body: string;
}
export interface ImageCandidate {
  readonly sha256: string;
  readonly mimeType: 'image/jpeg';
  readonly byteLength: number;
  readonly requestedSize: '1536x1024';
  readonly validation: 'candidate_only';
  /** Private, non-enumerable owned bytes. Dimensions and full decoding remain unverified. */
  readonly bytes: Buffer;
}
export interface ImageUsageEvidence {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly inputTextTokens: number | null;
  readonly inputImageTokens: number | null;
  readonly outputImageTokens: number | null;
}
export interface ImageGenerationReceipt {
  readonly outcome: 'not_started' | 'candidate_received' | 'rejected' | 'outcome_unknown';
  readonly code: 'aborted' | 'candidate_received' | 'provider_rejected' | 'transport_interrupted' | 'invalid_response' | 'response_limit';
  readonly requestSha256: string;
  readonly providerRequestIdSha256: string | null;
  readonly httpStatus: number | null;
  readonly candidate: ImageCandidate | null;
  readonly usage: ImageUsageEvidence | null;
}
export class ImageGenerationInputError extends Error {
  constructor() { super('Supply an opaque brand and actor identity, a bounded prompt and an explicitly scoped image credential.'); this.name = 'ImageGenerationInputError'; }
}
class ResponseFailure extends Error {
  constructor(readonly code: 'invalid_response' | 'response_limit') { super(code); }
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
/** Pure preparation: no credential, environment or network access. */
export function prepareImageGenerationRequest(command: ImageGenerationCommand): PreparedImageGenerationRequest {
  if (!uuid.test(command.brandId) || !uuid.test(command.actorId) || typeof command.prompt !== 'string' || !command.prompt.trim()
      || [...command.prompt].length > SEO_IMAGE_TRANSPORT_LIMITS.promptCharacters || Buffer.byteLength(command.prompt) > SEO_IMAGE_TRANSPORT_LIMITS.promptBytes
      || /\bhttps?:\/\/|\bwww\./iu.test(command.prompt) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(command.prompt)) throw new ImageGenerationInputError();
  const normalized = Object.freeze({ brandId: command.brandId.toLowerCase(), actorId: command.actorId.toLowerCase(), prompt: command.prompt });
  const { endpoint: _endpoint, ...parameters } = SEO_IMAGE_REQUEST;
  const body = JSON.stringify({ ...parameters, prompt: normalized.prompt, safety_identifier: sha(`${normalized.brandId}:${normalized.actorId}`) });
  const prepared = { requestSha256: sha(body), parameters: Object.freeze(parameters) };
  Object.defineProperties(prepared, { command: { enumerable: false, get: () => normalized }, body: { enumerable: false, get: () => body } });
  return Object.freeze(prepared) as PreparedImageGenerationRequest;
}
function candidate(value: unknown): ImageCandidate {
  if (typeof value !== 'string' || value.length < 8 || value.length > 4 * Math.ceil(SEO_IMAGE_TRANSPORT_LIMITS.imageBytes / 3)
      || value.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) throw new ResponseFailure('invalid_response');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length < 4 || bytes.length > SEO_IMAGE_TRANSPORT_LIMITS.imageBytes || bytes.toString('base64') !== value
      || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) throw new ResponseFailure('invalid_response');
  const result = { sha256: sha(bytes), mimeType: 'image/jpeg' as const, byteLength: bytes.length,
    requestedSize: '1536x1024' as const, validation: 'candidate_only' as const };
  Object.defineProperty(result, 'bytes', { enumerable: false, get: () => Buffer.from(bytes) });
  return Object.freeze(result) as ImageCandidate;
}
function usageEvidence(raw: unknown): ImageUsageEvidence | null {
  if (raw === undefined) return null;
  if (!object(raw)) throw new ResponseFailure('invalid_response');
  const counter = (value: unknown): number | null => {
    if (value === undefined) return null;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000) throw new ResponseFailure('invalid_response');
    return value;
  };
  const details = (key: string): Record<string, unknown> => {
    const value = raw[key]; if (value === undefined) return {};
    if (!object(value)) throw new ResponseFailure('invalid_response'); return value;
  };
  const input = details('input_tokens_details'), output = details('output_tokens_details');
  const result = { inputTokens: counter(raw.input_tokens), outputTokens: counter(raw.output_tokens), totalTokens: counter(raw.total_tokens),
    inputTextTokens: counter(input.text_tokens), inputImageTokens: counter(input.image_tokens), outputImageTokens: counter(output.image_tokens) };
  if (result.inputTokens !== null && result.outputTokens !== null && result.totalTokens !== null
      && result.inputTokens + result.outputTokens !== result.totalTokens) throw new ResponseFailure('invalid_response');
  if (result.inputTokens !== null && result.inputTextTokens !== null && result.inputImageTokens !== null
      && result.inputTextTokens + result.inputImageTokens !== result.inputTokens) throw new ResponseFailure('invalid_response');
  if (result.outputTokens !== null && result.outputImageTokens !== null && result.outputImageTokens > result.outputTokens) throw new ResponseFailure('invalid_response');
  return Object.freeze(result);
}

/** No automatic retries, URL inputs, environment reads, storage, approvals or publishing. */
export async function generateImageCandidate(command: ImageGenerationCommand, dependencies: {
  readonly apiKey: string; readonly fetchImpl?: typeof fetch; readonly signal?: AbortSignal; readonly timeoutMs?: number;
}): Promise<ImageGenerationReceipt> {
  const timeout = dependencies.timeoutMs ?? SEO_IMAGE_TRANSPORT_LIMITS.timeoutMs;
  const prepared = prepareImageGenerationRequest(command);
  if (typeof dependencies.apiKey !== 'string' || !/^[\x21-\x7e]{32,512}$/u.test(dependencies.apiKey)
      || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > SEO_IMAGE_TRANSPORT_LIMITS.timeoutMs) throw new ImageGenerationInputError();
  const { body, requestSha256 } = prepared;
  const receipt = (outcome: ImageGenerationReceipt['outcome'], code: ImageGenerationReceipt['code'], extras: Partial<ImageGenerationReceipt> = {}): ImageGenerationReceipt =>
    Object.freeze({ outcome, code, requestSha256, providerRequestIdSha256: null, httpStatus: null, candidate: null, usage: null, ...extras });
  if (dependencies.signal?.aborted) return receipt('not_started', 'aborted');
  const controller = new AbortController();
  let rejectDeadline!: (error: Error) => void;
  const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
  const interrupt = () => { controller.abort(); rejectDeadline(new Error('interrupted')); };
  dependencies.signal?.addEventListener('abort', interrupt, { once: true });
  const timer = setTimeout(interrupt, timeout);
  const race = <T>(promise: Promise<T>) => Promise.race([promise, deadline]);
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let responseBody: ReadableStream<Uint8Array> | null = null;
  let httpStatus: number | null = null, providerRequestIdSha256: string | null = null;
  let image: ImageCandidate | null = null;
  try {
    if (dependencies.signal?.aborted) return receipt('not_started', 'aborted');
    const response = await race((dependencies.fetchImpl ?? fetch)(SEO_IMAGE_REQUEST.endpoint, {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { Authorization: `Bearer ${dependencies.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json', 'Accept-Encoding': 'identity' }, body,
    }));
    httpStatus = response.status;
    responseBody = response.body;
    const id = response.headers.get('x-request-id');
    if (id && /^[\x21-\x7e]{1,200}$/u.test(id)) providerRequestIdSha256 = sha(id);
    const extras = () => ({ httpStatus, providerRequestIdSha256, candidate: image });
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      const rejected = [400, 401, 403, 404, 413, 422, 429].includes(response.status);
      return receipt(rejected ? 'rejected' : 'outcome_unknown', rejected ? 'provider_rejected' : 'transport_interrupted', extras());
    }
    if (response.redirected || !/^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json(?:\s*;\s*charset=utf-8)?$/iu.test(response.headers.get('content-type') ?? '')
        || !['', 'identity'].includes((response.headers.get('content-encoding') ?? '').toLowerCase())) throw new ResponseFailure('invalid_response');
    const declaredRaw = response.headers.get('content-length');
    if (declaredRaw !== null && (!/^(?:0|[1-9][0-9]{0,8})$/u.test(declaredRaw) || Number(declaredRaw) > SEO_IMAGE_TRANSPORT_LIMITS.responseBytes)) throw new ResponseFailure('response_limit');
    if (!response.body) throw new ResponseFailure('invalid_response');
    reader = response.body.getReader();
    const chunks: Buffer[] = []; let length = 0;
    for (;;) {
      const chunk = await race(reader.read()); if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array)) throw new ResponseFailure('invalid_response');
      length += chunk.value.byteLength;
      if (length > SEO_IMAGE_TRANSPORT_LIMITS.responseBytes) throw new ResponseFailure('response_limit');
      chunks.push(Buffer.from(chunk.value));
    }
    if (!length || (declaredRaw !== null && Number(declaredRaw) !== length)) throw new ResponseFailure('invalid_response');
    let raw: unknown;
    try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, length))); }
    catch { throw new ResponseFailure('invalid_response'); }
    if (!object(raw) || !Array.isArray(raw.data) || raw.data.length !== 1 || !object(raw.data[0])) throw new ResponseFailure('invalid_response');
    image = candidate(raw.data[0].b64_json);
    // Retain known candidate bytes even when optional metadata or usage is inconsistent.
    for (const key of ['model', 'size', 'quality', 'output_format', 'background'] as const) {
      if (raw[key] !== undefined && raw[key] !== SEO_IMAGE_REQUEST[key]) throw new ResponseFailure('invalid_response');
    }
    const usage = usageEvidence(raw.usage);
    return receipt('candidate_received', 'candidate_received', { ...extras(), usage });
  } catch (error) {
    controller.abort();
    return receipt('outcome_unknown', error instanceof ResponseFailure ? error.code : 'transport_interrupted', { httpStatus, providerRequestIdSha256, candidate: image });
  } finally {
    clearTimeout(timer); dependencies.signal?.removeEventListener('abort', interrupt);
    if (reader) { void reader.cancel().catch(() => undefined); try { reader.releaseLock(); } catch { /* pending reads are already aborted */ } }
    else if (responseBody) void responseBody.cancel().catch(() => undefined);
  }
}
