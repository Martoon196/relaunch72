/**
 * A small typed client for the Postmark calls "Connect email" needs: account calls (servers and domains, with the
 * account token) and server calls (Broadcast streams and webhooks, with that server's token).
 *
 * Safety rules, all enforced here:
 *   - one fixed base URL (https://api.postmarkapp.com), redirects refused, a timeout on every call, and response
 *     bodies read up to a cap (an oversized answer is abandoned part-way, never buffered whole);
 *   - tokens live only in this module's closures; they are never put in an error, a log line or a returned value's
 *     enumerable properties (a server token or webhook password that Postmark returns is attached non-enumerable, so
 *     JSON.stringify and util.inspect never show it);
 *   - an error carries only a category, the HTTP status and Postmark's numeric ErrorCode: never Postmark's message
 *     text, a token, a request body or a response body.
 * The HTTP client is injectable so tests never touch the network.
 */

export const POSTMARK_API_BASE = 'https://api.postmarkapp.com';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;

export type PostmarkErrorCategory =
  /** The request never got an answer (DNS, connection, TLS, redirect refused). */
  | 'network'
  /** No answer within the timeout. */
  | 'timeout'
  /** 401: wrong or missing token (ErrorCode 10). */
  | 'unauthorized'
  /** 429, 5xx: try again later. */
  | 'busy'
  /** 404: the thing asked for does not exist. */
  | 'not_found'
  /** 422 or another 4xx: Postmark refused the request; errorCode says why. */
  | 'rejected'
  /** The answer was not the JSON shape the docs describe, or was too large. */
  | 'invalid_response';

/**
 * One webhook trigger Postmark tested and found failing: the trigger type (from a fixed list; anything else reads
 * 'Other') and the HTTP status Postmark says our endpoint answered (a number, or null when Postmark gave none).
 */
export interface WebhookTriggerFailure { readonly trigger: string; readonly status: number | null }

export class PostmarkAccountError extends Error {
  override readonly name = 'PostmarkAccountError';
  constructor(readonly category: PostmarkErrorCategory, readonly status: number | null = null, readonly errorCode: number | null = null,
    /** Only on a webhook verification failure (ErrorCode 1364): the failing triggers, types and numbers only. */
    readonly failingTriggers: readonly WebhookTriggerFailure[] = []) {
    super(`Postmark request failed (${category}${status === null ? '' : ` ${status}`}${errorCode === null ? '' : ` code ${errorCode}`})`);
  }
  toJSON(): Readonly<Record<string, unknown>> {
    return { category: this.category, status: this.status, errorCode: this.errorCode, ...(this.failingTriggers.length ? { failingTriggers: this.failingTriggers } : {}) };
  }
}

/** What "verify a webhook" answered: verified, or the triggers that failed (possibly none named). */
export type WebhookVerification =
  | { readonly verified: true }
  /** A documented failure: 200 with Success false, or 422 with ErrorCode 1364 (in the body or only in the header). */
  | { readonly verified: false; readonly reason: 'failed'; readonly failing: readonly WebhookTriggerFailure[] }
  /**
   * A 2xx that is neither a documented pass nor a documented failure: never a pass. Carries only the HTTP status and the
   * sorted top-level key names of the body (never a value), so it can be logged.
   */
  | { readonly verified: false; readonly reason: 'unrecognised_answer'; readonly failing: readonly WebhookTriggerFailure[];
      readonly httpStatus: number; readonly answerKeys: readonly string[] };

/** The triggers Postmark must have tested, and passed, before we accept a verification: bounces and spam reports. */
const REQUIRED_TRIGGERS = ['Bounce', 'SpamComplaint'] as const;

/**
 * Postmark's verify answer, read strictly. Verified ONLY when: HTTP 200, the body is an object with Success === true
 * (the boolean), Results is a non-empty array, every Result is an object with Success === true, and Results include
 * both Bounce and SpamComplaint. A 200 with Success === false is a documented failure. Anything else is unrecognised.
 */
export function readWebhookVerification(httpStatus: number, body: unknown): WebhookVerification {
  if (httpStatus === 200 && record(body) && body.Success === false) return Object.freeze({ verified: false as const, reason: 'failed' as const, failing: Object.freeze(failingTriggersOf(body)) });
  if (httpStatus === 200 && record(body) && body.Success === true && Array.isArray(body.Results) && body.Results.length > 0
      && body.Results.every(item => record(item) && item.Success === true)
      && REQUIRED_TRIGGERS.every(trigger => (body.Results as unknown[]).some(item => record(item) && item.TriggerType === trigger && item.Success === true))) {
    return Object.freeze({ verified: true as const });
  }
  const answerKeys = record(body) ? Object.keys(body).map(key => /^[A-Za-z0-9_]{1,40}$/u.test(key) ? key : '?').sort().slice(0, 20) : [];
  return Object.freeze({ verified: false as const, reason: 'unrecognised_answer' as const, failing: Object.freeze(failingTriggersOf(body)), httpStatus,
    answerKeys: Object.freeze(answerKeys) });
}

/** Postmark ErrorCodes this feature reacts to (from the API overview's error code table). */
export const POSTMARK_CODES = Object.freeze({
  wrongToken: 10,
  pendingApproval: 412,
  notApproved: 413,
  serverNameExists: 603,
  limitReached: 614,
  publicDomain: 503,
  domainExists: 512,
  domainNotFound: 510,
  streamIdExists: 1230,
  webhookNotFound: 1352,
  webhookVerificationFailed: 1364,
});

export interface PostmarkServer {
  readonly id: number;
  readonly name: string;
  /** The server's first API token (non-enumerable). Null when Postmark returned none. */
  readonly serverToken: string | null;
}
export interface PostmarkStream { readonly id: string; readonly type: string; readonly archived: boolean }
export interface PostmarkWebhook {
  readonly id: number; readonly url: string; readonly stream: string; readonly username: string | null;
  /** Postmark's verification status (read in any letter case): only a 'verified' webhook receives events. null: absent or unrecognised. */
  readonly status: 'verified' | 'unverified' | null;
  /** Whether the answer carried a Status field at all (Postmark's own example list shows a webhook without one). */
  readonly statusPresent?: boolean;
  /** The HTTP Basic password stored on the webhook (non-enumerable), compared with ours and then dropped. */
  readonly password: string | null;
}
export interface PostmarkDomainSummary { readonly id: number; readonly name: string }
export interface PostmarkDomain {
  readonly id: number; readonly name: string;
  /** The TXT record: DKIMPendingHost/DKIMPendingTextValue while new or rotating, else DKIMHost/DKIMTextValue. */
  readonly dkimHost: string; readonly dkimValue: string; readonly dkimVerified: boolean;
  /** The CNAME record: ReturnPathDomain pointing at ReturnPathDomainCNAMEValue. */
  readonly returnPathHost: string; readonly returnPathValue: string; readonly returnPathVerified: boolean;
}

export interface PostmarkServerApi {
  listBroadcastStreams(includeArchived?: boolean): Promise<readonly PostmarkStream[]>;
  createBroadcastStream(id: string, name: string): Promise<PostmarkStream>;
  listWebhooks(stream: string): Promise<readonly PostmarkWebhook[]>;
  createWebhook(input: { url: string; stream: string; username: string; password: string }): Promise<PostmarkWebhook>;
  deleteWebhook(id: number): Promise<void>;
  /**
   * POST /webhooks/{id}/verify: Postmark tests our endpoint for each enabled trigger and marks the webhook verified or
   * unverified. A 2xx whose body says Success false (or lists a failing trigger), or a 422 with ErrorCode 1364, is
   * { verified: false } with the failing triggers; any other failure throws PostmarkAccountError.
   */
  verifyWebhook(id: number): Promise<WebhookVerification>;
}
export interface PostmarkAccountApi {
  listServers(name: string): Promise<readonly PostmarkServer[]>;
  getServer(id: number): Promise<PostmarkServer>;
  createServer(input: { name: string; color?: string }): Promise<PostmarkServer>;
  listDomains(): Promise<readonly PostmarkDomainSummary[]>;
  getDomain(id: number): Promise<PostmarkDomain>;
  createDomain(input: { name: string; returnPathDomain: string }): Promise<PostmarkDomain>;
  verifyDkim(id: number): Promise<PostmarkDomain>;
  verifyReturnPath(id: number): Promise<PostmarkDomain>;
  /** DELETE /domains/{id}. */
  deleteDomain(id: number): Promise<void>;
  /** Calls made with one server's token (kept in this closure only). */
  server(serverToken: string): PostmarkServerApi;
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const positiveId = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
const text = (value: unknown, max = 2000): string | null => typeof value === 'string' && value.length <= max ? value : null;
const TOKEN = /^[A-Za-z0-9_-]{20,128}$/u;

/** Reads at most `maximum` bytes; an oversized answer is cancelled part-way. */
async function readCapped(response: Response, maximum: number): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? '');
  const reader = response.body?.getReader();
  if (!reader) return '';
  if (Number.isFinite(declared) && declared > maximum) { await reader.cancel().catch(() => undefined); throw new Error('too large'); }
  const chunks: Uint8Array[] = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximum) { await reader.cancel().catch(() => undefined); throw new Error('too large'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

function hidden<T extends object>(target: T, key: string, value: string | null): T {
  Object.defineProperty(target, key, { value, enumerable: false, writable: false, configurable: false });
  return target;
}

function readServer(value: unknown): PostmarkServer {
  if (!record(value)) throw new PostmarkAccountError('invalid_response');
  const id = positiveId(value.ID), name = text(value.Name, 300);
  if (id === null || name === null) throw new PostmarkAccountError('invalid_response');
  const tokens = Array.isArray(value.ApiTokens) ? value.ApiTokens : [];
  const token = tokens.find((item): item is string => typeof item === 'string' && TOKEN.test(item)) ?? null;
  return Object.freeze(hidden({ id, name } as PostmarkServer, 'serverToken', token));
}
function readStream(value: unknown): PostmarkStream | null {
  if (!record(value)) return null;
  const id = text(value.ID, 60), type = text(value.MessageStreamType, 40);
  if (!id || !type) return null;
  return Object.freeze({ id, type, archived: typeof value.ArchivedAt === 'string' && value.ArchivedAt.length > 0 });
}
function readWebhook(value: unknown): PostmarkWebhook | null {
  if (!record(value)) return null;
  const id = positiveId(value.ID), url = text(value.Url), stream = text(value.MessageStream, 60);
  if (id === null || url === null || stream === null) return null;
  const auth = record(value.HttpAuth) ? value.HttpAuth : {};
  const username = text(auth.Username, 400);
  const statusPresent = Object.prototype.hasOwnProperty.call(value, 'Status') && value.Status !== null && value.Status !== undefined;
  const raw = typeof value.Status === 'string' ? value.Status.trim().toLowerCase() : null;
  const status = raw === 'verified' || raw === 'unverified' ? raw : null;
  return Object.freeze(hidden({ id, url, stream, username, status, statusPresent } as PostmarkWebhook, 'password', text(auth.Password, 400)));
}

const TRIGGER_TYPES = new Set(['Open', 'Click', 'Delivery', 'Bounce', 'SpamComplaint', 'SubscriptionChange', 'Inbound']);
/** The failing triggers of a verification answer (Results[].Success false): known type names and numbers only, at most 10. */
function failingTriggersOf(body: unknown): WebhookTriggerFailure[] {
  if (!record(body) || !Array.isArray(body.Results)) return [];
  const out: WebhookTriggerFailure[] = [];
  for (const item of body.Results) {
    if (!record(item) || item.Success !== false) continue;
    const trigger = typeof item.TriggerType === 'string' && TRIGGER_TYPES.has(item.TriggerType) ? item.TriggerType : 'Other';
    const status = typeof item.StatusCode === 'number' && Number.isSafeInteger(item.StatusCode) && item.StatusCode >= 0 && item.StatusCode <= 999 ? item.StatusCode : null;
    out.push(Object.freeze({ trigger, status }));
    if (out.length >= 10) break;
  }
  return out;
}
function readDomain(value: unknown): PostmarkDomain {
  if (!record(value)) throw new PostmarkAccountError('invalid_response');
  const id = positiveId(value.ID), name = text(value.Name, 255);
  if (id === null || !name) throw new PostmarkAccountError('invalid_response');
  const pendingHost = text(value.DKIMPendingHost) ?? '', pendingValue = text(value.DKIMPendingTextValue, 4000) ?? '';
  const currentHost = text(value.DKIMHost) ?? '', currentValue = text(value.DKIMTextValue, 4000) ?? '';
  const pending = pendingHost.length > 0 && pendingValue.length > 0;
  return Object.freeze({
    id, name: name.toLowerCase(),
    dkimHost: (pending ? pendingHost : currentHost).toLowerCase(), dkimValue: pending ? pendingValue : currentValue,
    dkimVerified: value.DKIMVerified === true,
    returnPathHost: (text(value.ReturnPathDomain) ?? '').toLowerCase(), returnPathValue: (text(value.ReturnPathDomainCNAMEValue) ?? '').toLowerCase(),
    returnPathVerified: value.ReturnPathDomainVerified === true,
  });
}

type Fetch = typeof fetch;

function requester(header: 'X-Postmark-Account-Token' | 'X-Postmark-Server-Token', token: string, fetcher: Fetch, timeoutMs: number) {
  if (typeof token !== 'string' || !TOKEN.test(token)) throw new PostmarkAccountError('unauthorized');
  const exchange = async (method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<{ status: number; body: unknown }> => {
    let response: Response;
    try {
      response = await fetcher(`${POSTMARK_API_BASE}${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: 'application/json', [header]: token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? (method === 'PUT' ? { body: '' } : {}) : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      const name = (error as { name?: unknown })?.name;
      throw new PostmarkAccountError(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network');
    }
    if (!response.ok) {
      // Only the numeric ErrorCode is kept from an error body (or, without one, the X-PM-ApiErrorCode header);
      // Postmark's message text is never carried.
      const header = response.headers.get('x-pm-apierrorcode');
      let errorCode: number | null = header && /^[0-9]{1,6}$/u.test(header.trim()) ? Number(header.trim()) : null;
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(await readCapped(response, MAX_ERROR_BYTES));
        if (record(parsed) && typeof parsed.ErrorCode === 'number' && Number.isSafeInteger(parsed.ErrorCode)) errorCode = parsed.ErrorCode;
      } catch { await response.body?.cancel().catch(() => undefined); }
      const status = response.status;
      const category: PostmarkErrorCategory = status === 401 ? 'unauthorized' : status === 404 ? 'not_found'
        : status === 429 || status >= 500 || status === 408 ? 'busy' : 'rejected';
      // A webhook verification failure keeps which triggers failed and the status codes Postmark saw (numbers only).
      throw new PostmarkAccountError(category, status, errorCode, errorCode === POSTMARK_CODES.webhookVerificationFailed ? failingTriggersOf(parsed) : []);
    }
    let raw: string;
    try { raw = await readCapped(response, MAX_RESPONSE_BYTES); } catch { throw new PostmarkAccountError('invalid_response', response.status); }
    if (!raw.trim()) return { status: response.status, body: null };
    try { return { status: response.status, body: JSON.parse(raw) as unknown }; } catch { throw new PostmarkAccountError('invalid_response', response.status); }
  };
  const call = async (method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<unknown> => (await exchange(method, path, body)).body;
  /** The same call, also giving the HTTP status of a 2xx answer (only verify needs it). */
  return Object.assign(call, { exchange });
}

export function createPostmarkAccountApi(input: { accountToken: string; fetch?: Fetch; timeoutMs?: number }): PostmarkAccountApi {
  const fetcher = input.fetch ?? fetch, timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const call = requester('X-Postmark-Account-Token', input.accountToken, fetcher, timeoutMs);
  const id = (value: number): string => {
    if (!Number.isSafeInteger(value) || value <= 0) throw new PostmarkAccountError('invalid_response');
    return String(value);
  };
  const api: PostmarkAccountApi = {
    async listServers(name) {
      const query = new URLSearchParams({ count: '100', offset: '0', name });
      const body = await call('GET', `/servers?${query.toString()}`);
      if (!record(body) || !Array.isArray(body.Servers)) throw new PostmarkAccountError('invalid_response');
      return Object.freeze(body.Servers.map(readServer));
    },
    async getServer(serverId) { return readServer(await call('GET', `/servers/${id(serverId)}`)); },
    async createServer({ name, color }) {
      return readServer(await call('POST', '/servers', { Name: name, ...(color ? { Color: color } : {}), DeliveryType: 'Live' }));
    },
    async listDomains() {
      // Every page, advancing by the rows actually received, until TotalCount is reached. A missing TotalCount, an empty
      // page before the end or an absurd total is an error ("could not check"), never a silently short list.
      const out: PostmarkDomainSummary[] = [];
      let offset = 0, total: number | null = null;
      do {
        const body = await call('GET', `/domains?${new URLSearchParams({ count: '500', offset: String(offset) }).toString()}`);
        if (!record(body) || !Array.isArray(body.Domains) || typeof body.TotalCount !== 'number' || !Number.isSafeInteger(body.TotalCount)
            || body.TotalCount < 0 || body.TotalCount > 1_000_000) throw new PostmarkAccountError('invalid_response');
        total = body.TotalCount;
        if (body.Domains.length === 0 && offset < total) throw new PostmarkAccountError('invalid_response');
        for (const item of body.Domains) {
          if (!record(item)) throw new PostmarkAccountError('invalid_response');
          const domainId = positiveId(item.ID), name = text(item.Name, 255);
          if (domainId === null || !name) throw new PostmarkAccountError('invalid_response');
          out.push(Object.freeze({ id: domainId, name: name.toLowerCase() }));
        }
        offset += body.Domains.length;
      } while (offset < total);
      return Object.freeze(out);
    },
    async getDomain(domainId) { return readDomain(await call('GET', `/domains/${id(domainId)}`)); },
    async createDomain({ name, returnPathDomain }) { return readDomain(await call('POST', '/domains', { Name: name, ReturnPathDomain: returnPathDomain })); },
    async verifyDkim(domainId) { return readDomain(await call('PUT', `/domains/${id(domainId)}/verifyDkim`)); },
    async verifyReturnPath(domainId) { return readDomain(await call('PUT', `/domains/${id(domainId)}/verifyReturnPath`)); },
    async deleteDomain(domainId) { await call('DELETE', `/domains/${id(domainId)}`); },
    server(serverToken) { return createPostmarkServerApi({ serverToken, fetch: fetcher, timeoutMs }); },
  };
  return Object.freeze({ ...api, toJSON: () => ({ postmark: '[REDACTED]' }) });
}

export function createPostmarkServerApi(input: { serverToken: string; fetch?: Fetch; timeoutMs?: number }): PostmarkServerApi {
  const call = requester('X-Postmark-Server-Token', input.serverToken, input.fetch ?? fetch, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const api: PostmarkServerApi = {
    async listBroadcastStreams(includeArchived = false) {
      const query = new URLSearchParams({ MessageStreamType: 'Broadcasts', IncludeArchivedStreams: includeArchived ? 'true' : 'false' });
      const body = await call('GET', `/message-streams?${query.toString()}`);
      if (!record(body) || !Array.isArray(body.MessageStreams)) throw new PostmarkAccountError('invalid_response');
      return Object.freeze(body.MessageStreams.map(readStream).filter((stream): stream is PostmarkStream => stream !== null));
    },
    async createBroadcastStream(streamId, name) {
      const stream = readStream(await call('POST', '/message-streams', { ID: streamId, Name: name, MessageStreamType: 'Broadcasts' }));
      if (!stream) throw new PostmarkAccountError('invalid_response');
      return stream;
    },
    async listWebhooks(stream) {
      const body = await call('GET', `/webhooks?${new URLSearchParams({ MessageStream: stream }).toString()}`);
      if (!record(body) || !Array.isArray(body.Webhooks)) throw new PostmarkAccountError('invalid_response');
      return Object.freeze(body.Webhooks.map(readWebhook).filter((hook): hook is PostmarkWebhook => hook !== null));
    },
    async createWebhook({ url, stream, username, password }) {
      // Bounces, spam reports and subscription changes only; no message content is ever asked for.
      const hook = readWebhook(await call('POST', '/webhooks', {
        Url: url, MessageStream: stream, HttpAuth: { Username: username, Password: password },
        Triggers: { Bounce: { Enabled: true, IncludeContent: false }, SpamComplaint: { Enabled: true, IncludeContent: false }, SubscriptionChange: { Enabled: true } },
      }));
      if (!hook) throw new PostmarkAccountError('invalid_response');
      return hook;
    },
    async deleteWebhook(webhookId) {
      if (!Number.isSafeInteger(webhookId) || webhookId <= 0) throw new PostmarkAccountError('invalid_response');
      await call('DELETE', `/webhooks/${webhookId}`);
    },
    async verifyWebhook(webhookId) {
      if (!Number.isSafeInteger(webhookId) || webhookId <= 0) throw new PostmarkAccountError('invalid_response');
      let answer: { status: number; body: unknown };
      try { answer = await call.exchange('POST', `/webhooks/${webhookId}/verify`); }
      catch (error) {
        // 422 with ErrorCode 1364, in the body or (with no ErrorCode in the body) only in the X-PM-ApiErrorCode header.
        if (error instanceof PostmarkAccountError && error.status === 422 && error.errorCode === POSTMARK_CODES.webhookVerificationFailed) {
          return Object.freeze({ verified: false as const, reason: 'failed' as const, failing: Object.freeze([...error.failingTriggers]) });
        }
        throw error;
      }
      // "A 200 response means the verification check ran, not that it passed": only positive evidence is a pass.
      return readWebhookVerification(answer.status, answer.body);
    },
  };
  return Object.freeze({ ...api, toJSON: () => ({ postmark: '[REDACTED]' }) });
}
