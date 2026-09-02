import { createHash } from 'node:crypto';

export const ZERNIO_MESSAGING_CONTRACT = 'r72-zernio-messaging-v1' as const;
export const ZERNIO_MESSAGING_ORIGIN = 'https://zernio.com' as const;

const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_CONVERSATIONS = 100;
const MAX_MESSAGES = 100;
const MAX_COMMENTED_POSTS = 100;
const MAX_COMMENTS = 100;
const MAX_COMMENT_REPLY_DEPTH = 2;
const SAFE_OPAQUE_ID = /^[\x21-\x7e]{1,500}$/u;
const SAFE_PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/u;
const SAFE_SECRET = /^[\x21-\x7e]{8,500}$/u;
const SAFE_IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,254}$/u;
const SUPPORTED_DM_PLATFORMS = new Set(['instagram', 'facebook']);
const SUPPORTED_COMMENT_PLATFORMS = new Set(['instagram', 'linkedin']);

export type ZernioCommentPlatform = 'instagram' | 'linkedin';

export type ZernioMessagingFailureCode =
  | 'unauthorised'
  | 'forbidden'
  | 'rate_limited'
  | 'provider_rejected'
  | 'provider_unavailable'
  | 'invalid_provider_response'
  | 'unbound_target'
  | 'outcome_unknown';

export class ZernioMessagingError extends Error {
  constructor(readonly code: ZernioMessagingFailureCode) {
    super(code);
    this.name = 'ZernioMessagingError';
  }
}

export interface ZernioConversationSnapshot {
  readonly providerConversationId: string;
  readonly platform: 'instagram' | 'facebook';
  readonly accountId: string;
  readonly accountUsername: string;
  readonly participantId: string;
  readonly participantName: string;
  readonly lastMessage: string;
  readonly updatedAt: string;
  readonly status: 'active' | 'archived';
  readonly unreadCount: number;
  readonly url: string | null;
}

export interface ZernioMessageSnapshot {
  readonly providerMessageId: string;
  readonly providerConversationId: string;
  readonly accountId: string;
  readonly platform: 'instagram' | 'facebook';
  readonly body: string;
  readonly senderId: string;
  readonly senderName: string;
  readonly direction: 'incoming' | 'outgoing';
  readonly occurredAt: string;
  readonly deliveryStatus: string | null;
  readonly sentVia: string | null;
}

export interface ZernioCommentedPostSnapshot {
  readonly providerPostId: string;
  readonly platform: ZernioCommentPlatform;
  readonly accountId: string;
  readonly accountUsername: string;
  readonly content: string;
  readonly pictureUrl: string | null;
  readonly permalinkUrl: string | null;
  readonly createdAt: string;
  readonly commentCount: number;
  readonly likeCount: number;
}

export interface ZernioCommentAuthorSnapshot {
  readonly providerAuthorId: string;
  readonly name: string;
  readonly username: string;
  readonly pictureUrl: string | null;
  readonly isOwner: boolean;
  readonly verifiedType: string | null;
}

export interface ZernioCommentSnapshot {
  readonly providerCommentId: string;
  readonly providerPostId: string;
  readonly platform: ZernioCommentPlatform;
  readonly accountId: string;
  readonly body: string;
  readonly createdAt: string;
  readonly author: ZernioCommentAuthorSnapshot;
  readonly likeCount: number;
  readonly replyCount: number;
  readonly url: string | null;
  readonly parentCommentId: string | null;
  readonly canReply: boolean;
  readonly repliesHaveMore: boolean;
  readonly replies: readonly ZernioCommentSnapshot[];
}

export interface ZernioMessagingClient {
  readonly contract: typeof ZERNIO_MESSAGING_CONTRACT;
  listConversations(input: Readonly<{ accountIds: readonly string[] }>): Promise<Readonly<{
    conversations: readonly ZernioConversationSnapshot[];
    checkedAt: string;
    hasMore: boolean;
  }>>;
  listMessages(input: Readonly<{
    accountId: string;
    providerConversationId: string;
  }>): Promise<Readonly<{
    messages: readonly ZernioMessageSnapshot[];
    checkedAt: string;
    hasMore: boolean;
  }>>;
  sendMessage(input: Readonly<{
    accountId: string;
    providerConversationId: string;
    body: string;
    idempotencyKey: string;
  }>): Promise<Readonly<{
    accepted: true;
    providerMessageId: string;
    responseSha256: string;
    idempotentReplay: boolean;
  }>>;
  listCommentedPosts(input: Readonly<{
    accountId: string;
    platform: ZernioCommentPlatform;
    cursor?: string;
  }>): Promise<Readonly<{
    posts: readonly ZernioCommentedPostSnapshot[];
    checkedAt: string;
    hasMore: boolean;
    nextCursor: string | null;
  }>>;
  listPostComments(input: Readonly<{
    accountId: string;
    platform: ZernioCommentPlatform;
    providerPostId: string;
    cursor?: string;
  }>): Promise<Readonly<{
    comments: readonly ZernioCommentSnapshot[];
    checkedAt: string;
    hasMore: boolean;
    nextCursor: string | null;
  }>>;
  replyToComment(input: Readonly<{
    accountId: string;
    platform: ZernioCommentPlatform;
    providerPostId: string;
    providerCommentId: string;
    body: string;
    idempotencyKey: string;
  }>): Promise<Readonly<{
    accepted: true;
    providerReplyCommentId: string;
    responseSha256: string;
    idempotentReplay: boolean;
  }>>;
}

export interface ZernioMessagingClientOptions {
  readonly apiKey: string;
  readonly providerProfileId: string;
  readonly allowedAccountIds: readonly string[];
  readonly fetch: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
}

function fail(code: ZernioMessagingFailureCode): never {
  throw new ZernioMessagingError(code);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_provider_response');
  return value as Record<string, unknown>;
}

function text(value: unknown, max: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && value.length < 1)) {
    fail('invalid_provider_response');
  }
  return value;
}

function opaqueId(value: unknown): string {
  const parsed = text(value, 500);
  if (!SAFE_OPAQUE_ID.test(parsed)) fail('invalid_provider_response');
  return parsed;
}

function timestamp(value: unknown): string {
  const parsed = text(value, 100);
  const date = new Date(parsed);
  if (!Number.isFinite(date.getTime())) fail('invalid_provider_response');
  return date.toISOString();
}

function boundedInteger(value: unknown, max = 1_000_000): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) {
    fail('invalid_provider_response');
  }
  return value as number;
}

function nullableUrl(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = text(value, 2_048);
  let url: URL;
  try { url = new URL(parsed); } catch { fail('invalid_provider_response'); }
  if (url.protocol !== 'https:' || url.username || url.password) fail('invalid_provider_response');
  return url.toString();
}

function nullableText(value: unknown, max: number): string | null {
  if (value === null || value === undefined || value === '') return null;
  return text(value, max);
}

function booleanValue(value: unknown): boolean {
  if (typeof value !== 'boolean') fail('invalid_provider_response');
  return value;
}

function commentPlatform(value: unknown): ZernioCommentPlatform {
  const parsed = text(value, 30);
  if (!SUPPORTED_COMMENT_PLATFORMS.has(parsed)) fail('invalid_provider_response');
  return parsed as ZernioCommentPlatform;
}

function cursor(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  return text(value, 4_096);
}

async function boundedJson(response: Response): Promise<Readonly<{
  readonly body: Record<string, unknown>;
  readonly bytes: Uint8Array;
}>> {
  const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json') fail('invalid_provider_response');
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d{1,10}$/u.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
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
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail('invalid_provider_response'); }
  return Object.freeze({ body: record(parsed), bytes });
}

function mapFailure(status: number): never {
  if (status === 401) fail('unauthorised');
  if (status === 403) fail('forbidden');
  if (status === 429) fail('rate_limited');
  if (status >= 500) fail('provider_unavailable');
  fail('provider_rejected');
}

function conversation(value: unknown, allowed: ReadonlySet<string>): ZernioConversationSnapshot {
  const source = record(value);
  const platform = text(source.platform, 30);
  if (!SUPPORTED_DM_PLATFORMS.has(platform)) fail('invalid_provider_response');
  const accountId = opaqueId(source.accountId);
  if (!allowed.has(accountId)) fail('unbound_target');
  const status = text(source.status, 20);
  if (status !== 'active' && status !== 'archived') fail('invalid_provider_response');
  return Object.freeze({
    providerConversationId: opaqueId(source.id),
    platform: platform as 'instagram' | 'facebook', accountId,
    accountUsername: text(source.accountUsername ?? '', 500, true),
    participantId: opaqueId(source.participantId),
    participantName: text(source.participantName ?? 'Unknown social contact', 500),
    lastMessage: text(source.lastMessage ?? '', 65_536, true),
    updatedAt: timestamp(source.updatedTime), status,
    unreadCount: boundedInteger(source.unreadCount), url: nullableUrl(source.url),
  });
}

function message(value: unknown, allowed: ReadonlySet<string>): ZernioMessageSnapshot {
  const source = record(value);
  const platform = text(source.platform, 30);
  if (!SUPPORTED_DM_PLATFORMS.has(platform)) fail('invalid_provider_response');
  const accountId = opaqueId(source.accountId);
  if (!allowed.has(accountId)) fail('unbound_target');
  const direction = text(source.direction, 20);
  if (direction !== 'incoming' && direction !== 'outgoing') fail('invalid_provider_response');
  const messageBody = source.message === '' || source.message === null || source.message === undefined
    ? '[Attachment]'
    : source.message;
  return Object.freeze({
    providerMessageId: opaqueId(source.id),
    providerConversationId: opaqueId(source.conversationId), accountId,
    platform: platform as 'instagram' | 'facebook',
    body: text(messageBody, 65_536),
    senderId: opaqueId(source.senderId),
    senderName: text(source.senderName ?? 'Unknown social contact', 500),
    direction, occurredAt: timestamp(source.createdAt),
    deliveryStatus: source.deliveryStatus === null || source.deliveryStatus === undefined
      ? null : text(source.deliveryStatus, 100),
    sentVia: source.sentVia === null || source.sentVia === undefined
      ? null : text(source.sentVia, 100),
  });
}

function commentedPost(
  value: unknown,
  expectedAccountId: string,
  expectedPlatform: ZernioCommentPlatform,
): ZernioCommentedPostSnapshot {
  const source = record(value);
  const platform = commentPlatform(source.platform);
  const accountId = opaqueId(source.accountId);
  if (accountId !== expectedAccountId || platform !== expectedPlatform) fail('unbound_target');
  if (source.isAd === true) fail('unbound_target');
  if (source.isAd !== undefined && source.isAd !== false) fail('invalid_provider_response');
  return Object.freeze({
    providerPostId: opaqueId(source.id), platform, accountId,
    accountUsername: text(source.accountUsername ?? '', 500, true),
    content: text(source.content ?? '', 65_536, true),
    pictureUrl: nullableUrl(source.picture),
    permalinkUrl: nullableUrl(source.permalink),
    createdAt: timestamp(source.createdTime),
    commentCount: boundedInteger(source.commentCount),
    likeCount: boundedInteger(source.likeCount),
  });
}

function commentAuthor(value: unknown): ZernioCommentAuthorSnapshot {
  const source = record(value);
  return Object.freeze({
    providerAuthorId: opaqueId(source.id),
    name: text(source.name ?? 'Unknown social contact', 500),
    username: text(source.username ?? '', 500, true),
    pictureUrl: nullableUrl(source.picture),
    isOwner: booleanValue(source.isOwner),
    verifiedType: nullableText(source.verifiedType, 100),
  });
}

function commentSnapshot(
  value: unknown,
  binding: Readonly<{
    accountId: string;
    platform: ZernioCommentPlatform;
    providerPostId: string;
  }>,
  depth: number,
  counter: { value: number },
): ZernioCommentSnapshot {
  counter.value += 1;
  if (counter.value > 500 || depth > MAX_COMMENT_REPLY_DEPTH) fail('invalid_provider_response');
  const source = record(value);
  const platform = commentPlatform(source.platform);
  if (platform !== binding.platform) fail('unbound_target');
  const providerCommentId = opaqueId(source.id);
  const rawReplies = source.replies ?? [];
  if (!Array.isArray(rawReplies) || rawReplies.length > MAX_COMMENTS) fail('invalid_provider_response');
  if (depth === MAX_COMMENT_REPLY_DEPTH && rawReplies.length > 0) fail('invalid_provider_response');
  const replies = rawReplies.map((reply) => commentSnapshot(
    reply,
    binding,
    depth + 1,
    counter,
  ));
  return Object.freeze({
    providerCommentId,
    providerPostId: binding.providerPostId,
    platform,
    accountId: binding.accountId,
    body: text(source.message ?? '', 65_536, true),
    createdAt: timestamp(source.createdTime),
    author: commentAuthor(source.from),
    likeCount: boundedInteger(source.likeCount),
    replyCount: boundedInteger(source.replyCount),
    url: nullableUrl(source.url),
    parentCommentId: source.parentId === null || source.parentId === undefined || source.parentId === ''
      ? null : opaqueId(source.parentId),
    canReply: booleanValue(source.canReply),
    repliesHaveMore: source.repliesHasMore === undefined
      ? false : booleanValue(source.repliesHasMore),
    replies: Object.freeze(replies),
  });
}

export function createZernioMessagingClient(options: ZernioMessagingClientOptions): ZernioMessagingClient {
  if (!options || typeof options !== 'object' || Array.isArray(options)
      || typeof options.apiKey !== 'string' || !SAFE_SECRET.test(options.apiKey)
      || typeof options.providerProfileId !== 'string' || !SAFE_PROFILE_ID.test(options.providerProfileId)
      || typeof options.fetch !== 'function' || !Array.isArray(options.allowedAccountIds)) {
    fail('provider_rejected');
  }
  const allowed = new Set<string>(options.allowedAccountIds.map((value: string) => {
    if (typeof value !== 'string' || !SAFE_OPAQUE_ID.test(value)) fail('provider_rejected');
    return value;
  }));
  if (allowed.size < 1 || allowed.size !== options.allowedAccountIds.length) fail('provider_rejected');
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30_000) fail('provider_rejected');
  const now = options.now ?? (() => new Date());

  async function request(path: string, init: RequestInit): Promise<Readonly<{
    response: Response; body: Record<string, unknown>; bytes: Uint8Array;
  }>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    let response: Response;
    try {
      response = await options.fetch(new URL(path, ZERNIO_MESSAGING_ORIGIN), {
        ...init, redirect: 'error', signal: controller.signal,
        headers: Object.freeze({
          authorization: `Bearer ${options.apiKey}`, accept: 'application/json',
          ...(init.headers ?? {}),
        }),
      });
    } catch { fail('provider_unavailable'); }
    finally { clearTimeout(timer); }
    if (!response.ok) mapFailure(response.status);
    const parsed = await boundedJson(response);
    return Object.freeze({ response, ...parsed });
  }

  return Object.freeze({
    contract: ZERNIO_MESSAGING_CONTRACT,
    async listConversations(input: Readonly<{ accountIds: readonly string[] }>) {
      if (!input || !Array.isArray(input.accountIds) || input.accountIds.length < 1) fail('unbound_target');
      const requested = new Set(input.accountIds);
      if (requested.size !== input.accountIds.length
          || [...requested].some((id) => !allowed.has(id))) fail('unbound_target');
      const url = new URL('/api/v1/inbox/conversations', ZERNIO_MESSAGING_ORIGIN);
      url.searchParams.set('profileId', options.providerProfileId);
      url.searchParams.set('limit', String(MAX_CONVERSATIONS));
      const { body } = await request(`${url.pathname}${url.search}`, { method: 'GET' });
      if (!Array.isArray(body.data) || body.data.length > MAX_CONVERSATIONS) fail('invalid_provider_response');
      const conversations = body.data.map((value) => conversation(value, requested));
      const pagination = record(body.pagination ?? {});
      return Object.freeze({
        conversations: Object.freeze(conversations), checkedAt: now().toISOString(),
        hasMore: pagination.hasMore === true,
      });
    },
    async listMessages(input: Readonly<{
      accountId: string;
      providerConversationId: string;
    }>) {
      if (!input || typeof input !== 'object' || !allowed.has(input.accountId)
          || typeof input.providerConversationId !== 'string'
          || !SAFE_OPAQUE_ID.test(input.providerConversationId)) fail('unbound_target');
      const url = new URL(`/api/v1/inbox/conversations/${encodeURIComponent(input.providerConversationId)}/messages`, ZERNIO_MESSAGING_ORIGIN);
      url.searchParams.set('accountId', input.accountId);
      url.searchParams.set('limit', String(MAX_MESSAGES));
      url.searchParams.set('sortOrder', 'asc');
      const { body } = await request(`${url.pathname}${url.search}`, { method: 'GET' });
      if (!Array.isArray(body.messages) || body.messages.length > MAX_MESSAGES) fail('invalid_provider_response');
      const messages = body.messages.map((value) => message(value, allowed));
      if (messages.some((item) => item.providerConversationId !== input.providerConversationId
          || item.accountId !== input.accountId)) fail('unbound_target');
      const pagination = record(body.pagination ?? {});
      return Object.freeze({ messages: Object.freeze(messages), checkedAt: now().toISOString(), hasMore: pagination.hasMore === true });
    },
    async sendMessage(input: Readonly<{
      accountId: string;
      providerConversationId: string;
      body: string;
      idempotencyKey: string;
    }>) {
      if (!input || typeof input !== 'object' || !allowed.has(input.accountId)
          || typeof input.providerConversationId !== 'string'
          || !SAFE_OPAQUE_ID.test(input.providerConversationId)
          || typeof input.body !== 'string' || input.body.trim() !== input.body
          || Buffer.byteLength(input.body, 'utf8') < 1 || Buffer.byteLength(input.body, 'utf8') > 10_000
          || typeof input.idempotencyKey !== 'string'
          || !SAFE_IDEMPOTENCY_KEY.test(input.idempotencyKey)) fail('unbound_target');
      const path = `/api/v1/inbox/conversations/${encodeURIComponent(input.providerConversationId)}/messages`;
      try {
        const result = await request(path, {
          method: 'POST', headers: Object.freeze({
            'content-type': 'application/json', 'idempotency-key': input.idempotencyKey,
          }),
          body: JSON.stringify({ accountId: input.accountId, message: input.body }),
        });
        const data = record(result.body.data ?? result.body);
        const providerMessageId = opaqueId(data.messageId ?? data.id);
        return Object.freeze({
          accepted: true as const, providerMessageId,
          responseSha256: createHash('sha256').update(result.bytes).digest('hex'),
          idempotentReplay: result.response.headers.get('idempotent-replayed') === 'true',
        });
      } catch (error) {
        if (error instanceof ZernioMessagingError
            && (error.code === 'provider_unavailable' || error.code === 'invalid_provider_response')) {
          fail('outcome_unknown');
        }
        throw error;
      }
    },
    async listCommentedPosts(input: Readonly<{
      accountId: string;
      platform: ZernioCommentPlatform;
      cursor?: string;
    }>) {
      if (!input || typeof input !== 'object' || !allowed.has(input.accountId)
          || !SUPPORTED_COMMENT_PLATFORMS.has(input.platform)
          || (input.cursor !== undefined
            && (typeof input.cursor !== 'string' || input.cursor.length < 1 || input.cursor.length > 4_096))) {
        fail('unbound_target');
      }
      const url = new URL('/api/v1/inbox/comments', ZERNIO_MESSAGING_ORIGIN);
      url.searchParams.set('profileId', options.providerProfileId);
      url.searchParams.set('accountId', input.accountId);
      url.searchParams.set('platform', input.platform);
      url.searchParams.set('sortBy', 'date');
      url.searchParams.set('sortOrder', 'desc');
      url.searchParams.set('limit', String(MAX_COMMENTED_POSTS));
      if (input.cursor !== undefined) url.searchParams.set('cursor', input.cursor);
      const { body } = await request(`${url.pathname}${url.search}`, { method: 'GET' });
      if (!Array.isArray(body.data) || body.data.length > MAX_COMMENTED_POSTS) {
        fail('invalid_provider_response');
      }
      const seen = new Set<string>();
      const posts: ZernioCommentedPostSnapshot[] = [];
      for (const value of body.data) {
        const parsed = commentedPost(value, input.accountId, input.platform);
        if (seen.has(parsed.providerPostId)) continue;
        seen.add(parsed.providerPostId);
        posts.push(parsed);
      }
      if (body.meta !== undefined) {
        const meta = record(body.meta);
        if (meta.accountsFailed !== undefined && boundedInteger(meta.accountsFailed) > 0) {
          fail('provider_unavailable');
        }
      }
      const pagination = record(body.pagination ?? {});
      const hasMore = pagination.hasMore === undefined
        ? false : booleanValue(pagination.hasMore);
      const nextCursor = cursor(pagination.nextCursor);
      if (hasMore && nextCursor === null) fail('invalid_provider_response');
      return Object.freeze({
        posts: Object.freeze(posts), checkedAt: now().toISOString(), hasMore, nextCursor,
      });
    },
    async listPostComments(input: Readonly<{
      accountId: string;
      platform: ZernioCommentPlatform;
      providerPostId: string;
      cursor?: string;
    }>) {
      if (!input || typeof input !== 'object' || !allowed.has(input.accountId)
          || !SUPPORTED_COMMENT_PLATFORMS.has(input.platform)
          || typeof input.providerPostId !== 'string'
          || !SAFE_OPAQUE_ID.test(input.providerPostId)
          || (input.cursor !== undefined
            && (typeof input.cursor !== 'string' || input.cursor.length < 1 || input.cursor.length > 4_096))) {
        fail('unbound_target');
      }
      const url = new URL(
        `/api/v1/inbox/comments/${encodeURIComponent(input.providerPostId)}`,
        ZERNIO_MESSAGING_ORIGIN,
      );
      url.searchParams.set('accountId', input.accountId);
      url.searchParams.set('limit', String(MAX_COMMENTS));
      if (input.cursor !== undefined) url.searchParams.set('cursor', input.cursor);
      const { body } = await request(`${url.pathname}${url.search}`, { method: 'GET' });
      if (!Array.isArray(body.comments) || body.comments.length > MAX_COMMENTS) {
        fail('invalid_provider_response');
      }
      const meta = record(body.meta);
      const metaAccountId = opaqueId(meta.accountId);
      const metaPlatform = commentPlatform(meta.platform);
      if (metaAccountId !== input.accountId || metaPlatform !== input.platform) fail('unbound_target');
      opaqueId(meta.postId);
      const counter = { value: 0 };
      const binding = Object.freeze({
        accountId: input.accountId,
        platform: input.platform,
        providerPostId: input.providerPostId,
      });
      const comments = body.comments.map((value) => commentSnapshot(value, binding, 0, counter));
      const pagination = record(body.pagination ?? {});
      const hasMore = pagination.hasMore === undefined
        ? false : booleanValue(pagination.hasMore);
      const nextCursor = cursor(pagination.cursor);
      if (hasMore && nextCursor === null) fail('invalid_provider_response');
      return Object.freeze({
        comments: Object.freeze(comments), checkedAt: now().toISOString(), hasMore, nextCursor,
      });
    },
    async replyToComment(input: Readonly<{
      accountId: string;
      platform: ZernioCommentPlatform;
      providerPostId: string;
      providerCommentId: string;
      body: string;
      idempotencyKey: string;
    }>) {
      if (!input || typeof input !== 'object' || !allowed.has(input.accountId)
          || !SUPPORTED_COMMENT_PLATFORMS.has(input.platform)
          || typeof input.providerPostId !== 'string'
          || !SAFE_OPAQUE_ID.test(input.providerPostId)
          || typeof input.providerCommentId !== 'string'
          || !SAFE_OPAQUE_ID.test(input.providerCommentId)
          || typeof input.body !== 'string' || input.body.trim() !== input.body
          || Buffer.byteLength(input.body, 'utf8') < 1 || Buffer.byteLength(input.body, 'utf8') > 10_000
          || typeof input.idempotencyKey !== 'string'
          || !SAFE_IDEMPOTENCY_KEY.test(input.idempotencyKey)) fail('unbound_target');
      const path = `/api/v1/inbox/comments/${encodeURIComponent(input.providerPostId)}`;
      try {
        const result = await request(path, {
          method: 'POST',
          headers: Object.freeze({
            'content-type': 'application/json',
            'idempotency-key': input.idempotencyKey,
          }),
          body: JSON.stringify({
            accountId: input.accountId,
            message: input.body,
            commentId: input.providerCommentId,
          }),
        });
        if (result.body.success !== true) fail('invalid_provider_response');
        const data = record(result.body.data);
        if (data.isReply !== true) fail('invalid_provider_response');
        return Object.freeze({
          accepted: true as const,
          providerReplyCommentId: opaqueId(data.commentId),
          responseSha256: createHash('sha256').update(result.bytes).digest('hex'),
          idempotentReplay: result.response.headers.get('idempotent-replayed') === 'true',
        });
      } catch (error) {
        if (error instanceof ZernioMessagingError
            && (error.code === 'provider_unavailable' || error.code === 'invalid_provider_response')) {
          fail('outcome_unknown');
        }
        throw error;
      }
    },
  });
}
