import { createHash } from 'node:crypto';

/**
 * Narrow transport for Zernio's documented create/get post contract.
 *
 * This module deliberately has no scheduler, database, credential loader or
 * provider-effects switch. A separately authorised worker must satisfy those
 * gates before it can call publishDue.
 *
 * @see https://docs.zernio.com/posts/create-post
 * @see https://docs.zernio.com/posts/get-post
 */
export const ZERNIO_POSTING_CONTRACT = 'r72-zernio-posting-v1' as const;
export const ZERNIO_POSTING_ORIGIN = 'https://zernio.com' as const;

const CREATE_POST_PATH = '/api/v1/posts';
const MEDIA_PRESIGN_PATH = '/api/v1/media/presign';
const MAX_RESPONSE_BYTES = 65_536;
const MAX_REQUEST_BYTES = 131_072;
const MAX_CONTENT_BYTES = 50_000;
const MAX_MEDIA_ITEMS = 10;
const MAX_TARGETS = 10;
const SAFE_API_KEY = /^[\x21-\x7e]{8,500}$/u;
const SAFE_ACCOUNT_ID = /^[a-f0-9]{24}$/u;
const SAFE_POST_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/u;
const SAFE_REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SAFE_MEDIA_FILENAME = /^[^\u0000-\u001f\u007f\\/]{1,180}$/u;
const SAFE_PUBLIC_HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;
const SUPPORTED_NETWORKS = new Set(['instagram', 'linkedin']);
const SUPPORTED_POST_STATUSES = new Set([
  'scheduled', 'publishing', 'published', 'partial', 'failed', 'cancelled',
]);
const SUPPORTED_PLATFORM_STATUSES = new Set([
  'pending', 'publishing', 'published', 'failed', 'cancelled',
]);
const TIMEOUT = Symbol('zernio-posting-timeout');

export type ZernioPostingNetwork = 'instagram' | 'linkedin';
export type ZernioPostingMediaType = 'image' | 'video';
export type ZernioPostingPostStatus =
  | 'scheduled'
  | 'publishing'
  | 'published'
  | 'partial'
  | 'failed'
  | 'cancelled';
export type ZernioPostingPlatformStatus =
  | 'pending'
  | 'publishing'
  | 'published'
  | 'failed'
  | 'cancelled';

export type ZernioPostingFailureCode =
  | 'invalid_configuration'
  | 'invalid_request'
  | 'unbound_target'
  | 'unauthorised'
  | 'forbidden'
  | 'conflict'
  | 'rate_limited'
  | 'provider_rejected'
  | 'provider_unavailable'
  | 'not_found'
  | 'invalid_provider_response'
  | 'outcome_unknown';

export class ZernioPostingError extends Error {
  constructor(readonly code: ZernioPostingFailureCode) {
    super(code);
    this.name = 'ZernioPostingError';
  }
}

export interface ZernioPostingTarget {
  readonly network: ZernioPostingNetwork;
  readonly accountId: string;
}

export interface ZernioPostingMediaItem {
  readonly type: ZernioPostingMediaType;
  readonly url: string;
}

export interface ZernioPostingPlatformResult extends ZernioPostingTarget {
  readonly status: ZernioPostingPlatformStatus;
  readonly platformPostUrl: string | null;
}

export interface ZernioPostingSnapshot {
  readonly providerPostId: string;
  readonly status: ZernioPostingPostStatus;
  readonly platforms: readonly ZernioPostingPlatformResult[];
  readonly responseSha256: string;
}

export interface ZernioPostingPublishResult extends ZernioPostingSnapshot {
  readonly idempotentReplay: boolean;
}

export interface ZernioPostingAccountProbe {
  readonly accountId: string;
  readonly profileId: string;
  readonly network: ZernioPostingNetwork;
  readonly username: string | null;
  readonly displayName: string | null;
  readonly canPost: true;
  readonly responseSha256: string;
}

export interface ZernioPostingMediaUpload {
  readonly uploadUrl: string;
  readonly publicUrl: string;
  readonly expiresIn: number;
}

export interface ZernioPostingClient {
  readonly contract: typeof ZERNIO_POSTING_CONTRACT;
  probeAccount(input: Readonly<{
    requestId: string;
    target: ZernioPostingTarget;
  }>): Promise<ZernioPostingAccountProbe>;
  prepareMediaUpload(input: Readonly<{
    requestId: string;
    filename: string;
    contentType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'
      | 'video/mp4' | 'video/quicktime' | 'video/webm';
    size: number;
  }>): Promise<ZernioPostingMediaUpload>;
  schedule(input: Readonly<{
    requestId: string;
    content: string;
    targets: readonly ZernioPostingTarget[];
    scheduledFor: string;
    mediaItems?: readonly ZernioPostingMediaItem[];
  }>): Promise<ZernioPostingPublishResult>;
  publishDue(input: Readonly<{
    requestId: string;
    content: string;
    targets: readonly ZernioPostingTarget[];
    mediaItems?: readonly ZernioPostingMediaItem[];
  }>): Promise<ZernioPostingPublishResult>;
  reconcile(input: Readonly<{
    providerPostId: string;
    expectedTargets: readonly ZernioPostingTarget[];
  }>): Promise<ZernioPostingSnapshot>;
}

export interface ZernioPostingClientOptions {
  readonly apiKey: string;
  readonly allowedTargets: readonly ZernioPostingTarget[];
  readonly fetch: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

function fail(code: ZernioPostingFailureCode): never {
  throw new ZernioPostingError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const permitted = new Set(allowed);
  return Object.keys(value).every((key) => permitted.has(key));
}

function providerRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) fail('invalid_provider_response');
  return value;
}

function providerText(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum) {
    fail('invalid_provider_response');
  }
  return value;
}

function targetKey(target: ZernioPostingTarget): string {
  return `${target.network}:${target.accountId}`;
}

function parseInputTarget(value: unknown, failure: ZernioPostingFailureCode): ZernioPostingTarget {
  if (!isRecord(value) || !exactKeys(value, ['network', 'accountId'])) fail(failure);
  if (typeof value.network !== 'string' || !SUPPORTED_NETWORKS.has(value.network)
      || typeof value.accountId !== 'string' || !SAFE_ACCOUNT_ID.test(value.accountId)) {
    fail(failure);
  }
  return Object.freeze({
    network: value.network as ZernioPostingNetwork,
    accountId: value.accountId,
  });
}

function parseTargetSet(
  value: unknown,
  failure: ZernioPostingFailureCode,
): readonly ZernioPostingTarget[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_TARGETS) fail(failure);
  const targets = value.map((item) => parseInputTarget(item, failure));
  const unique = new Set(targets.map(targetKey));
  if (unique.size !== targets.length) fail(failure);
  return Object.freeze(targets);
}

function publicMediaUrl(value: unknown, failure: ZernioPostingFailureCode): string {
  if (typeof value !== 'string' || value.length < 10 || value.length > 2_048) fail(failure);
  let url: URL;
  try { url = new URL(value); } catch { fail(failure); }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password
      || (url.port && url.port !== '443') || url.hash
      || !SAFE_PUBLIC_HOST.test(hostname)
      || hostname === 'localhost' || hostname.endsWith('.localhost')
      || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    fail(failure);
  }
  return url.toString();
}

function parseMediaItems(value: unknown): readonly ZernioPostingMediaItem[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > MAX_MEDIA_ITEMS) fail('invalid_request');
  const items = value.map((item): ZernioPostingMediaItem => {
    if (!isRecord(item) || !exactKeys(item, ['type', 'url'])
        || (item.type !== 'image' && item.type !== 'video')) fail('invalid_request');
    return Object.freeze({
      type: item.type,
      url: publicMediaUrl(item.url, 'invalid_request'),
    });
  });
  return Object.freeze(items);
}

function providerAccountId(value: unknown, network: ZernioPostingNetwork): string {
  if (typeof value === 'string') {
    if (!SAFE_ACCOUNT_ID.test(value)) fail('invalid_provider_response');
    return value;
  }
  const source = providerRecord(value);
  const accountId = providerText(source._id, 24);
  if (!SAFE_ACCOUNT_ID.test(accountId)) fail('invalid_provider_response');
  if (source.platform !== undefined && source.platform !== network) {
    fail('invalid_provider_response');
  }
  return accountId;
}

function parsePlatform(
  value: unknown,
  expected: ReadonlySet<string>,
): ZernioPostingPlatformResult {
  const source = providerRecord(value);
  const network = providerText(source.platform, 30);
  if (!SUPPORTED_NETWORKS.has(network)) fail('invalid_provider_response');
  const typedNetwork = network as ZernioPostingNetwork;
  const accountId = providerAccountId(source.accountId, typedNetwork);
  if (!expected.has(`${typedNetwork}:${accountId}`)) fail('unbound_target');
  const status = providerText(source.status, 30);
  if (!SUPPORTED_PLATFORM_STATUSES.has(status)) fail('invalid_provider_response');
  const platformPostUrl = source.platformPostUrl === undefined
    || source.platformPostUrl === null || source.platformPostUrl === ''
    ? null
    : publicMediaUrl(source.platformPostUrl, 'invalid_provider_response');
  if (status === 'published' && platformPostUrl === null) fail('invalid_provider_response');
  return Object.freeze({
    network: typedNetwork,
    accountId,
    status: status as ZernioPostingPlatformStatus,
    platformPostUrl,
  });
}

function parsePost(
  value: unknown,
  expectedTargets: readonly ZernioPostingTarget[],
  responseSha256: string,
): ZernioPostingSnapshot {
  const source = providerRecord(value);
  const providerPostId = providerText(source._id, 128);
  if (!SAFE_POST_ID.test(providerPostId)) fail('invalid_provider_response');
  const status = providerText(source.status, 30);
  if (!SUPPORTED_POST_STATUSES.has(status)) fail('invalid_provider_response');
  if (!Array.isArray(source.platforms)
      || source.platforms.length !== expectedTargets.length) {
    fail('invalid_provider_response');
  }
  const expected = new Set(expectedTargets.map(targetKey));
  const platforms = source.platforms.map((item) => parsePlatform(item, expected));
  if (new Set(platforms.map(targetKey)).size !== expected.size) {
    fail('invalid_provider_response');
  }
  return Object.freeze({
    providerPostId,
    status: status as ZernioPostingPostStatus,
    platforms: Object.freeze(platforms),
    responseSha256,
  });
}

async function boundedJson(response: Response): Promise<Readonly<{
  body: Record<string, unknown>;
  bytes: Uint8Array;
}>> {
  if (response.redirected) fail('invalid_provider_response');
  const mediaType = response.headers.get('content-type')
    ?.split(';', 1)[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json') fail('invalid_provider_response');
  const declared = response.headers.get('content-length');
  if (declared !== null
      && (!/^\d{1,10}$/u.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
    fail('invalid_provider_response');
  }
  const reader = response.body?.getReader();
  if (!reader) fail('invalid_provider_response');
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    length += item.value.length;
    if (length > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      fail('invalid_provider_response');
    }
    chunks.push(item.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    fail('invalid_provider_response');
  }
  return Object.freeze({ body: providerRecord(parsed), bytes });
}

function responseSha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function mapHttpFailure(status: number, ambiguousWrite: boolean): never {
  if (status === 401) fail('unauthorised');
  if (status === 403) fail('forbidden');
  if (status === 404) fail('not_found');
  if (status === 409) fail('conflict');
  if (status === 429) fail('rate_limited');
  if (status >= 500) fail(ambiguousWrite ? 'outcome_unknown' : 'provider_unavailable');
  fail('provider_rejected');
}

export function createZernioPostingClient(
  options: ZernioPostingClientOptions,
): ZernioPostingClient {
  if (!isRecord(options) || typeof options.apiKey !== 'string'
      || !SAFE_API_KEY.test(options.apiKey) || typeof options.fetch !== 'function') {
    fail('invalid_configuration');
  }
  const allowedTargets = parseTargetSet(options.allowedTargets, 'invalid_configuration');
  const allowed = new Set(allowedTargets.map(targetKey));
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30_000) {
    fail('invalid_configuration');
  }

  async function request(
    path: string,
    init: RequestInit,
    ambiguousWrite: boolean,
  ): Promise<Readonly<{
    response: Response;
    body: Record<string, unknown>;
    bytes: Uint8Array;
  }>> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<typeof TIMEOUT>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(TIMEOUT);
      }, timeoutMs);
      timer.unref?.();
    });
    try {
      const operation = (async () => {
        const response = await options.fetch(new URL(path, ZERNIO_POSTING_ORIGIN), {
          ...init,
          redirect: 'error',
          signal: controller.signal,
          headers: Object.freeze({
            authorization: `Bearer ${options.apiKey}`,
            accept: 'application/json',
            ...(init.headers ?? {}),
          }),
        });
        return Object.freeze({ response, ...(await boundedJson(response)) });
      })();
      const result = await Promise.race([operation, timeout]);
      if (result === TIMEOUT) {
        fail(ambiguousWrite ? 'outcome_unknown' : 'provider_unavailable');
      }
      if (!result.response.ok) mapHttpFailure(result.response.status, ambiguousWrite);
      return result;
    } catch (error) {
      if (error instanceof ZernioPostingError) throw error;
      return fail(ambiguousWrite ? 'outcome_unknown' : 'provider_unavailable');
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function exactAllowedTargets(value: unknown): readonly ZernioPostingTarget[] {
    const targets = parseTargetSet(value, 'invalid_request');
    if (targets.some((target) => !allowed.has(targetKey(target)))) fail('unbound_target');
    return targets;
  }

  function exactPostInput(
    input: Readonly<{
      requestId: string;
      content: string;
      targets: readonly ZernioPostingTarget[];
      mediaItems?: readonly ZernioPostingMediaItem[];
    }>,
    allowedKeys: readonly string[],
  ): Readonly<{
    requestId: string;
    content: string;
    targets: readonly ZernioPostingTarget[];
    mediaItems: readonly ZernioPostingMediaItem[];
  }> {
    if (!isRecord(input)
        || !exactKeys(input, allowedKeys)
        || typeof input.requestId !== 'string'
        || !SAFE_REQUEST_ID.test(input.requestId)
        || typeof input.content !== 'string'
        || input.content.trim() !== input.content
        || Buffer.byteLength(input.content, 'utf8') < 1
        || Buffer.byteLength(input.content, 'utf8') > MAX_CONTENT_BYTES) {
      fail('invalid_request');
    }
    return Object.freeze({
      requestId: input.requestId,
      content: input.content,
      targets: exactAllowedTargets(input.targets),
      mediaItems: parseMediaItems(input.mediaItems),
    });
  }

  async function createPost(input: Readonly<{
    requestId: string;
    content: string;
    targets: readonly ZernioPostingTarget[];
    mediaItems: readonly ZernioPostingMediaItem[];
    scheduledFor?: string;
  }>): Promise<ZernioPostingPublishResult> {
    const requestBody = JSON.stringify({
      content: input.content,
      platforms: input.targets.map((target) => ({
        platform: target.network,
        accountId: target.accountId,
      })),
      ...(input.mediaItems.length === 0 ? {} : { mediaItems: input.mediaItems }),
      ...(input.scheduledFor ? { scheduledFor: input.scheduledFor, timezone: 'UTC' } : {
        publishNow: true,
      }),
    });
    if (Buffer.byteLength(requestBody, 'utf8') > MAX_REQUEST_BYTES) {
      fail('invalid_request');
    }
    const result = await request(CREATE_POST_PATH, {
      method: 'POST',
      headers: Object.freeze({
        'content-type': 'application/json',
        'x-request-id': input.requestId,
      }),
      body: requestBody,
    }, true);
    const idempotentReplay = result.response.status === 200;
    if (result.response.status !== 201 && !idempotentReplay) fail('invalid_provider_response');
    const post = idempotentReplay ? result.body.existingPost : result.body.post;
    const parsed = parsePost(post, input.targets, responseSha256(result.bytes));
    return Object.freeze({ ...parsed, idempotentReplay });
  }

  return Object.freeze({
    contract: ZERNIO_POSTING_CONTRACT,

    async probeAccount(input: Parameters<ZernioPostingClient['probeAccount']>[0]) {
      if (!isRecord(input) || !exactKeys(input, ['requestId', 'target'])
          || typeof input.requestId !== 'string' || !SAFE_REQUEST_ID.test(input.requestId)) {
        fail('invalid_request');
      }
      const target = parseInputTarget(input.target, 'invalid_request');
      if (!allowed.has(targetKey(target))) fail('unbound_target');
      const result = await request(`/api/v1/accounts/${target.accountId}/health`, {
        method: 'GET', headers: Object.freeze({ 'x-request-id': input.requestId }),
      }, false);
      const body = result.body;
      const accountId = providerText(body.accountId, 24);
      if (accountId !== target.accountId || body.platform !== target.network
          || body.status !== 'healthy' || !isRecord(body.permissions)
          || body.permissions.canPost !== true) fail('provider_rejected');
      const listed = await request('/api/v1/accounts?includeOverLimit=true', {
        method: 'GET', headers: Object.freeze({ 'x-request-id': input.requestId }),
      }, false);
      if (!Array.isArray(listed.body.accounts) || listed.body.accounts.length > 500) {
        fail('invalid_provider_response');
      }
      const exactAccount = listed.body.accounts.find((candidate) => {
        if (!isRecord(candidate)) return false;
        const id = candidate._id ?? candidate.id ?? candidate.accountId;
        return id === target.accountId;
      });
      if (!isRecord(exactAccount) || exactAccount.platform !== target.network
          || exactAccount.isActive === false) fail('invalid_provider_response');
      const profileSource = exactAccount.profileId;
      const profileId = typeof profileSource === 'string'
        ? profileSource
        : isRecord(profileSource) ? String(profileSource._id ?? profileSource.id ?? '') : '';
      if (!SAFE_ACCOUNT_ID.test(profileId)) fail('invalid_provider_response');
      const optionalName = (value: unknown): string | null => {
        if (value === undefined || value === null || value === '') return null;
        const name = providerText(value, 160).trim();
        if (!name || /[\u0000-\u001f\u007f]/u.test(name)) fail('invalid_provider_response');
        return name;
      };
      return Object.freeze({
        accountId,
        profileId,
        network: target.network,
        username: optionalName(body.username),
        displayName: optionalName(body.displayName),
        canPost: true as const,
        responseSha256: createHash('sha256')
          .update(result.bytes).update(listed.bytes).digest('hex'),
      });
    },

    async prepareMediaUpload(input: Parameters<ZernioPostingClient['prepareMediaUpload']>[0]) {
      if (!isRecord(input) || !exactKeys(input, ['requestId', 'filename', 'contentType', 'size'])
          || typeof input.requestId !== 'string' || !SAFE_REQUEST_ID.test(input.requestId)
          || typeof input.filename !== 'string' || !SAFE_MEDIA_FILENAME.test(input.filename)
          || !['image/jpeg', 'image/png', 'image/webp', 'image/gif',
            'video/mp4', 'video/quicktime', 'video/webm'].includes(String(input.contentType))
          || !Number.isSafeInteger(input.size) || input.size < 1 || input.size > 500_000_000) {
        fail('invalid_request');
      }
      const result = await request(MEDIA_PRESIGN_PATH, {
        method: 'POST',
        headers: Object.freeze({
          'content-type': 'application/json',
          'x-request-id': input.requestId,
        }),
        body: JSON.stringify({
          filename: input.filename,
          contentType: input.contentType,
          size: input.size,
        }),
      }, false);
      if (result.response.status !== 200) fail('invalid_provider_response');
      const uploadUrl = publicMediaUrl(result.body.uploadUrl, 'invalid_provider_response');
      const publicUrl = publicMediaUrl(result.body.publicUrl, 'invalid_provider_response');
      const uploadHost = new URL(uploadUrl).hostname.toLowerCase();
      if (!uploadHost.endsWith('.r2.cloudflarestorage.com')
          || new URL(publicUrl).hostname.toLowerCase() !== 'media.zernio.com'
          || !Number.isSafeInteger(result.body.expiresIn)
          || Number(result.body.expiresIn) < 60 || Number(result.body.expiresIn) > 3_600) {
        fail('invalid_provider_response');
      }
      return Object.freeze({
        uploadUrl,
        publicUrl,
        expiresIn: Number(result.body.expiresIn),
      });
    },

    async schedule(input: Parameters<ZernioPostingClient['schedule']>[0]) {
      const parsed = exactPostInput(
        input,
        ['requestId', 'content', 'targets', 'scheduledFor', 'mediaItems'],
      );
      if (typeof input.scheduledFor !== 'string') fail('invalid_request');
      const scheduled = new Date(input.scheduledFor);
      if (!Number.isFinite(scheduled.getTime())
          || scheduled.toISOString() !== input.scheduledFor
          || scheduled.getTime() < Date.now() + 4 * 60_000
          || scheduled.getTime() > Date.now() + 366 * 24 * 60 * 60_000) {
        fail('invalid_request');
      }
      return createPost({ ...parsed, scheduledFor: input.scheduledFor });
    },

    async publishDue(input: Parameters<ZernioPostingClient['publishDue']>[0]) {
      const parsed = exactPostInput(
        input,
        ['requestId', 'content', 'targets', 'mediaItems'],
      );
      return createPost(parsed);
    },

    async reconcile(input: Parameters<ZernioPostingClient['reconcile']>[0]) {
      if (!isRecord(input)
          || !exactKeys(input, ['providerPostId', 'expectedTargets'])
          || typeof input.providerPostId !== 'string'
          || !SAFE_POST_ID.test(input.providerPostId)) {
        fail('invalid_request');
      }
      const targets = exactAllowedTargets(input.expectedTargets);
      const result = await request(
        `${CREATE_POST_PATH}/${encodeURIComponent(input.providerPostId)}`,
        { method: 'GET' },
        false,
      );
      if (result.response.status !== 200) fail('invalid_provider_response');
      return parsePost(result.body.post, targets, responseSha256(result.bytes));
    },
  });
}
