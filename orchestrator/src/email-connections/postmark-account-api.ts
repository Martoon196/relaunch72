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

export class PostmarkAccountError extends Error {
  override readonly name = 'PostmarkAccountError';
  constructor(readonly category: PostmarkErrorCategory, readonly status: number | null = null, readonly errorCode: number | null = null) {
    super(`Postmark request failed (${category}${status === null ? '' : ` ${status}`}${errorCode === null ? '' : ` code ${errorCode}`})`);
  }
  toJSON(): Readonly<Record<string, unknown>> { return { category: this.category, status: this.status, errorCode: this.errorCode }; }
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
  return Object.freeze(hidden({ id, url, stream, username } as PostmarkWebhook, 'password', text(auth.Password, 400)));
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
  return async (method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<unknown> => {
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
      // Only the numeric ErrorCode is kept from an error body; Postmark's message text is never carried.
      let errorCode: number | null = null;
      try {
        const parsed: unknown = JSON.parse(await readCapped(response, MAX_ERROR_BYTES));
        if (record(parsed) && typeof parsed.ErrorCode === 'number' && Number.isSafeInteger(parsed.ErrorCode)) errorCode = parsed.ErrorCode;
      } catch { await response.body?.cancel().catch(() => undefined); }
      const status = response.status;
      const category: PostmarkErrorCategory = status === 401 ? 'unauthorized' : status === 404 ? 'not_found'
        : status === 429 || status >= 500 || status === 408 ? 'busy' : 'rejected';
      throw new PostmarkAccountError(category, status, errorCode);
    }
    let raw: string;
    try { raw = await readCapped(response, MAX_RESPONSE_BYTES); } catch { throw new PostmarkAccountError('invalid_response', response.status); }
    if (!raw.trim()) return null;
    try { return JSON.parse(raw) as unknown; } catch { throw new PostmarkAccountError('invalid_response', response.status); }
  };
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
      const out: PostmarkDomainSummary[] = [];
      // At most 5 pages of 500: far more domains than one Postmark account for a handful of businesses holds.
      for (let offset = 0; offset < 2500; offset += 500) {
        const body = await call('GET', `/domains?${new URLSearchParams({ count: '500', offset: String(offset) }).toString()}`);
        if (!record(body) || !Array.isArray(body.Domains)) throw new PostmarkAccountError('invalid_response');
        for (const item of body.Domains) {
          if (!record(item)) continue;
          const domainId = positiveId(item.ID), name = text(item.Name, 255);
          if (domainId !== null && name) out.push(Object.freeze({ id: domainId, name: name.toLowerCase() }));
        }
        const total = typeof body.TotalCount === 'number' ? body.TotalCount : 0;
        if (body.Domains.length < 500 || offset + 500 >= total) break;
      }
      return Object.freeze(out);
    },
    async getDomain(domainId) { return readDomain(await call('GET', `/domains/${id(domainId)}`)); },
    async createDomain({ name, returnPathDomain }) { return readDomain(await call('POST', '/domains', { Name: name, ReturnPathDomain: returnPathDomain })); },
    async verifyDkim(domainId) { return readDomain(await call('PUT', `/domains/${id(domainId)}/verifyDkim`)); },
    async verifyReturnPath(domainId) { return readDomain(await call('PUT', `/domains/${id(domainId)}/verifyReturnPath`)); },
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
  };
  return Object.freeze({ ...api, toJSON: () => ({ postmark: '[REDACTED]' }) });
}
