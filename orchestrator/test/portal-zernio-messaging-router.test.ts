import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { PortalAuthService } from '../src/portal/auth-service.js';
import type { PortalCrmService } from '../src/portal/crm-service.js';
import { PROPERTY_PREDATOR_GROWTH_PROFILE } from '../src/portal/product-profile.js';
import { handlePortal, type PostgresPortalDeps } from '../src/portal/router.js';
import { PORTAL_COOKIE, portalCsrfToken } from '../src/portal/session.js';
import {
  ZERNIO_MESSAGING_DRAFT_ROUTE,
  ZERNIO_MESSAGING_ROUTE,
  ZERNIO_MESSAGING_SEND_ROUTE,
  type PortalZernioMessagingService,
  type PortalZernioMessagingSnapshot,
} from '../src/portal/zernio-messaging-service.js';

const SECRET = 'zernio-messaging-router-secret';
const SESSION = Buffer.alloc(32, 72).toString('base64url');
const COOKIE = `${PORTAL_COOKIE}=${SESSION}`;
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const ACCOUNT = '6a95e99a77555aae01643ae2';
const CONVERSATION = '1302944325113179';
const POST = 'provider-post-1302944325113179';
const COMMENT = 'provider-comment-1302944325113179';
const DRAFT = '33333333-3333-4333-8333-333333333333';
const DELIVERY = '44444444-4444-4444-8444-444444444444';
const LEASE = '55555555-5555-4555-8555-555555555555';

function commentSnapshot(platform: 'instagram' | 'linkedin' = 'instagram'):
PortalZernioMessagingSnapshot {
  const post = Object.freeze({
    providerPostId: POST, platform, accountId: ACCOUNT,
    accountUsername: 'propertypredator', content: 'Property walkthrough',
    pictureUrl: null, permalinkUrl: null,
    createdAt: '2026-09-01T01:55:00.000Z', commentCount: 1, likeCount: 2,
  });
  const comment = Object.freeze({
    providerCommentId: COMMENT, providerPostId: POST, platform, accountId: ACCOUNT,
    body: 'Can you show me how this works?', createdAt: '2026-09-01T01:58:00.000Z',
    author: Object.freeze({
      providerAuthorId: 'comment-author-1', name: 'Property Hunter', username: 'hunter',
      pictureUrl: null, isOwner: false, verifiedType: null,
    }),
    likeCount: 1, replyCount: 0, url: null, parentCommentId: null,
    canReply: true, repliesHaveMore: false, replies: Object.freeze([]),
  });
  return Object.freeze({
    ok: true as const, provider: 'zernio' as const, providerEffects: false as const,
    outboundEffectsEnabled: false, emergencyPaused: true,
    checkedAt: '2026-09-01T02:00:00.000Z', conversations: Object.freeze([]),
    commentPosts: Object.freeze([post]), selectedConversation: null,
    selectedCommentPost: post, selectedComment: comment,
    selectedTarget: Object.freeze({
      kind: 'comment' as const, accountId: ACCOUNT, platform,
      providerPostId: POST, providerCommentId: COMMENT,
    }),
    messages: Object.freeze([]), comments: Object.freeze([comment]), reply: null,
    conversationHistoryTruncated: false, queueTruncated: false,
  });
}

const auth: PortalAuthService = {
  resolve: async (token) => token === SESSION ? {
    sessionToken: token, userId: USER, userEmail: 'founder@example.test', workspaceId: WORKSPACE,
  } : null,
  login: async () => null, revoke: async () => undefined,
};

const crm: PortalCrmService = {
  snapshot: async () => ({
    workspace: { id: WORKSPACE, name: 'PropertyPredator Growth HQ', timezone: 'Europe/London', snapshotAt: '2026-09-01T02:00:00.000Z', canWrite: true },
    contacts: [], stages: [], opportunities: [], tasks: [], timeline: [],
  }),
  workspaceShell: async () => ({
    workspace: { id: WORKSPACE, name: 'PropertyPredator Growth HQ', timezone: 'Europe/London', snapshotAt: '2026-09-01T02:00:00.000Z', canWrite: true },
  }),
  createLead: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
  moveOpportunity: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
  completeTask: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
};

function messaging(overrides: Partial<PortalZernioMessagingService> = {}): PortalZernioMessagingService {
  const base: PortalZernioMessagingService = {
    snapshot: async () => ({
      ok: true, provider: 'zernio', providerEffects: false,
      outboundEffectsEnabled: false, emergencyPaused: true,
      checkedAt: '2026-09-01T02:00:00.000Z',
      conversations: [{
        providerConversationId: CONVERSATION, platform: 'instagram', accountId: ACCOUNT,
        accountUsername: 'martin_howard_property', participantId: 'participant-1',
        participantName: 'Property Hunter', lastMessage: 'Hello',
        updatedAt: '2026-09-01T01:59:00.000Z', status: 'active', unreadCount: 1,
        url: 'https://www.instagram.com/direct/t/1/',
      }],
      selectedConversation: {
        providerConversationId: CONVERSATION, platform: 'instagram', accountId: ACCOUNT,
        accountUsername: 'martin_howard_property', participantId: 'participant-1',
        participantName: 'Property Hunter', lastMessage: 'Hello',
        updatedAt: '2026-09-01T01:59:00.000Z', status: 'active', unreadCount: 1,
        url: 'https://www.instagram.com/direct/t/1/',
      },
      commentPosts: [], selectedCommentPost: null, selectedComment: null,
      selectedTarget: {
        kind: 'dm', accountId: ACCOUNT, providerConversationId: CONVERSATION,
      },
      messages: [], comments: [], reply: null,
      conversationHistoryTruncated: false, queueTruncated: false,
    }),
    createDraft: async () => ({ ok: true, disposition: 'created', providerEffects: 'none' }),
    requestApproval: async () => ({ ok: true, disposition: 'requested', providerEffects: 'none' }),
    decideApproval: async () => ({ ok: true, disposition: 'approved', providerEffects: 'none' }),
    sendApproved: async () => ({ ok: true, disposition: 'sent', providerEffects: 'one_message_accepted' }),
  };
  return { ...base, ...overrides };
}

function deps(service: PortalZernioMessagingService): PostgresPortalDeps {
  return {
    kind: 'postgres', sessionSecret: SECRET, secure: false,
    requestId: () => 'zernio-messaging-router-request',
    now: () => Date.parse('2026-09-01T02:00:00.000Z'),
    productProfile: PROPERTY_PREDATOR_GROWTH_PROFILE,
    auth, crm, zernioMessaging: service,
  };
}

function request(url: string, method = 'GET', body?: string) {
  const req = new EventEmitter() as EventEmitter & {
    method: string; url: string; headers: Record<string, string>;
  };
  req.method = method; req.url = url; req.headers = {
    cookie: COOKIE,
    ...(body === undefined ? {} : {
      'content-type': 'application/x-www-form-urlencoded',
      'content-length': String(Buffer.byteLength(body)),
    }),
  };
  setImmediate(() => {
    if (body !== undefined) req.emit('data', Buffer.from(body));
    req.emit('end');
  });
  return req;
}

function response() {
  return {
    statusCode: 0, headers: {} as Record<string, string>, body: '',
    writeHead(code: number, headers?: Record<string, string | string[]>) {
      this.statusCode = code;
      for (const [key, value] of Object.entries(headers ?? {})) {
        this.headers[key.toLowerCase()] = Array.isArray(value) ? value.join('\n') : value;
      }
      return this;
    },
    end(body?: string) { if (body) this.body = body; },
  };
}

async function call(url: string, dependencies: PostgresPortalDeps, method = 'GET', body?: string) {
  const res = response();
  await handlePortal(request(url, method, body) as never, res as never, dependencies);
  return res;
}

test('live Messaging renders draft authoring but no send control before approval', async () => {
  const result = await call(`${ZERNIO_MESSAGING_ROUTE}?conversation=${CONVERSATION}`, deps(messaging()));
  assert.equal(result.statusCode, 200);
  assert.match(result.body, /Save immutable draft/u);
  assert.doesNotMatch(result.body, /Send approved reply now/u);
  assert.match(result.body, /OUTBOUND EFFECTS OFF/u);
});

test('a valid draft command records exact target and copy without a provider effect', async () => {
  const calls: unknown[] = [];
  const service = messaging({ createDraft: async (identity, input) => {
    calls.push({ identity, input });
    return { ok: true, disposition: 'created', providerEffects: 'none' };
  } });
  const body = new URLSearchParams({
    _csrf: portalCsrfToken(SECRET, SESSION), target_kind: 'dm', account_id: ACCOUNT,
    conversation_id: CONVERSATION, draft_id: DRAFT, body: 'Exact reply copy',
  }).toString();
  const result = await call(ZERNIO_MESSAGING_DRAFT_ROUTE, deps(service), 'POST', body);
  assert.equal(result.statusCode, 303);
  assert.equal(calls.length, 1);
  assert.deepEqual((calls[0] as { input: unknown }).input, {
    draftId: DRAFT,
    target: { kind: 'dm', accountId: ACCOUNT, providerConversationId: CONVERSATION },
    body: 'Exact reply copy',
  });
  assert.match(result.headers.location ?? '', /notice=draft_created\./u);
});

test('send requires exact CSRF and explicit confirmation before the provider boundary', async () => {
  const calls: unknown[] = [];
  const service = messaging({ sendApproved: async (identity, input) => {
    calls.push({ identity, input });
    return { ok: true, disposition: 'sent', providerEffects: 'one_message_accepted' };
  } });
  const base = {
    target_kind: 'dm', account_id: ACCOUNT, conversation_id: CONVERSATION,
    draft_id: DRAFT, delivery_id: DELIVERY, lease_token: LEASE,
  };
  await call(ZERNIO_MESSAGING_SEND_ROUTE, deps(service), 'POST',
    new URLSearchParams({ ...base, _csrf: 'bad', confirm_send: 'yes' }).toString());
  await call(ZERNIO_MESSAGING_SEND_ROUTE, deps(service), 'POST',
    new URLSearchParams({ ...base, _csrf: portalCsrfToken(SECRET, SESSION) }).toString());
  assert.equal(calls.length, 0);
  const result = await call(ZERNIO_MESSAGING_SEND_ROUTE, deps(service), 'POST',
    new URLSearchParams({ ...base, _csrf: portalCsrfToken(SECRET, SESSION), confirm_send: 'yes' }).toString());
  assert.equal(calls.length, 1);
  assert.deepEqual((calls[0] as { input: unknown }).input, {
    draftId: DRAFT, deliveryId: DELIVERY, leaseToken: LEASE,
    target: { kind: 'dm', accountId: ACCOUNT, providerConversationId: CONVERSATION },
  });
  assert.equal(result.statusCode, 303);
  assert.match(result.headers.location ?? '', /notice=sent\./u);
});

test('an exact comment selection reaches the live mixed inbox without changing its binding', async () => {
  const selections: unknown[] = [];
  const service = messaging({ snapshot: async (_identity, input) => {
    selections.push(input);
    return commentSnapshot('instagram');
  } });
  const query = new URLSearchParams({
    kind: 'comment', account: ACCOUNT, platform: 'instagram', post: POST, comment: COMMENT,
  });
  const result = await call(`${ZERNIO_MESSAGING_ROUTE}?${query.toString()}`, deps(service));
  assert.equal(result.statusCode, 200);
  assert.deepEqual(selections, [{
    comment: {
      accountId: ACCOUNT, platform: 'instagram', providerPostId: POST,
      providerCommentId: COMMENT,
    },
  }]);
  assert.match(result.body, /Instagram comments/u);
  assert.match(result.body, /Can you show me how this works\?/u);
  assert.match(result.body, /name="target_kind" value="comment"/u);
});

test('a comment draft preserves exact account, platform, post and comment binding', async () => {
  const calls: unknown[] = [];
  const service = messaging({ createDraft: async (identity, input) => {
    calls.push({ identity, input });
    return { ok: true, disposition: 'created', providerEffects: 'none' };
  } });
  const body = new URLSearchParams({
    _csrf: portalCsrfToken(SECRET, SESSION), target_kind: 'comment', account_id: ACCOUNT,
    platform: 'instagram', post_id: POST, comment_id: COMMENT,
    draft_id: DRAFT, body: 'Exact public reply',
  }).toString();
  const result = await call(ZERNIO_MESSAGING_DRAFT_ROUTE, deps(service), 'POST', body);
  assert.equal(result.statusCode, 303);
  assert.deepEqual((calls[0] as { input: unknown }).input, {
    draftId: DRAFT,
    target: {
      kind: 'comment', accountId: ACCOUNT, platform: 'instagram',
      providerPostId: POST, providerCommentId: COMMENT,
    },
    body: 'Exact public reply',
  });
  const location = new URL(result.headers.location ?? '', 'https://hq.example.test');
  assert.equal(location.searchParams.get('kind'), 'comment');
  assert.equal(location.searchParams.get('account'), ACCOUNT);
  assert.equal(location.searchParams.get('platform'), 'instagram');
  assert.equal(location.searchParams.get('post'), POST);
  assert.equal(location.searchParams.get('comment'), COMMENT);
});

test('mixed DM and comment target fields fail closed before the service boundary', async () => {
  let calls = 0;
  const service = messaging({ createDraft: async () => {
    calls += 1;
    return { ok: true, disposition: 'created', providerEffects: 'none' };
  } });
  const body = new URLSearchParams({
    _csrf: portalCsrfToken(SECRET, SESSION), target_kind: 'comment', account_id: ACCOUNT,
    conversation_id: CONVERSATION, platform: 'instagram', post_id: POST, comment_id: COMMENT,
    draft_id: DRAFT, body: 'Must not pass',
  }).toString();
  const result = await call(ZERNIO_MESSAGING_DRAFT_ROUTE, deps(service), 'POST', body);
  assert.equal(result.statusCode, 303);
  assert.equal(calls, 0);
  assert.match(result.headers.location ?? '', /notice=invalid\./u);
});
