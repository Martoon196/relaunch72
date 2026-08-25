import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import test from 'node:test';
import {
  PROPERTY_PREDATOR_EXTERNAL_EVENT_MAX_BODY_BYTES,
  PROPERTY_PREDATOR_EXTERNAL_EVENT_PATH,
  PropertyPredatorExternalEventReceiptConflictError,
  createPropertyPredatorExternalEventHandler,
  loadPropertyPredatorExternalEventConfig,
  parsePropertyPredatorExternalEventBody,
  type PropertyPredatorExternalEventShadowRecordInput,
  type PropertyPredatorExternalEventShadowRecordResult,
} from '../src/integrations/external-events/index.js';
import { createApp } from '../src/server/app.js';
import type { StripeConfig } from '../src/server/config.js';
import { memoryWebhookReceiptStore, type OrderStore } from '../src/server/orders.js';
import type { StripeLike } from '../src/server/stripe.js';

const KEY_ID = 'pp-growth-2026-01';
const SECRET = Buffer.alloc(32, 0x5a);
const WORKSPACE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const EVENT_ID = '0198e9dd-a56f-7000-8000-000000000001';

function eventBody(extra: Record<string, unknown> = {}): Buffer {
  return Buffer.from(JSON.stringify({
    id: EVENT_ID,
    type: 'identity.account.created',
    version: 1,
    occurredAt: '2026-08-25T12:00:00.000Z',
    correlationId: '0198e9dd-a56f-7000-8000-000000000002',
    subject: { kind: 'account', id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
    data: { email: 'hunter@example.com', signupMethod: 'password' },
    ...extra,
  }));
}

function signedHeaders(
  body: Uint8Array,
  overrides: Record<string, string> = {},
): Record<string, string> {
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const signature = createHmac('sha256', SECRET)
    .update(timestamp, 'ascii')
    .update('.', 'ascii')
    .update(body)
    .digest('hex');
  return {
    'content-type': 'application/json; charset=utf-8',
    'x-r72-key-id': KEY_ID,
    'x-r72-timestamp': timestamp,
    'x-r72-signature': `v1=${signature}`,
    ...overrides,
  };
}

function request(
  body: Uint8Array,
  headers: Record<string, string>,
  options: {
    method?: string;
    path?: string;
    rawHeaders?: string[];
    socketEncrypted?: boolean;
    remoteAddress?: string;
  } = {},
): IncomingMessage {
  const stream = Readable.from([Buffer.from(body)]) as unknown as IncomingMessage;
  const normalizedHeaders = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
  const rawHeaders = options.rawHeaders ?? Object.entries(headers).flatMap(([name, value]) => [name, value]);
  return Object.assign(stream, {
    method: options.method ?? 'POST',
    url: options.path ?? PROPERTY_PREDATOR_EXTERNAL_EVENT_PATH,
    headers: normalizedHeaders,
    rawHeaders,
    socket: {
      encrypted: options.socketEncrypted === true,
      remoteAddress: options.remoteAddress,
    },
  });
}

function response(): ServerResponse & {
  statusCode: number;
  body: Record<string, unknown>;
  headers: Record<string, string | number>;
} {
  const state = {
    statusCode: 0,
    body: {} as Record<string, unknown>,
    headers: {} as Record<string, string | number>,
    setHeader(name: string, value: string | number) {
      state.headers[name.toLowerCase()] = value;
      return state;
    },
    writeHead(status: number, headers: Record<string, string | number> = {}) {
      state.statusCode = status;
      for (const [name, value] of Object.entries(headers)) {
        state.headers[name.toLowerCase()] = value;
      }
      return state;
    },
    end(body = '') {
      state.body = body ? JSON.parse(body) as Record<string, unknown> : {};
      return state;
    },
  };
  return state as unknown as ServerResponse & typeof state;
}

function strictStore(
  outcome: PropertyPredatorExternalEventShadowRecordResult
    | { readonly disposition: 'projected'; readonly replayed: boolean }
    | Error,
  seen: PropertyPredatorExternalEventShadowRecordInput[] = [],
) {
  return {
    async record(input: PropertyPredatorExternalEventShadowRecordInput) {
      seen.push(input);
      parsePropertyPredatorExternalEventBody(input.rawBody);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  };
}

function handlerWithStore(
  store: ReturnType<typeof strictStore>,
  production = false,
  trustedProxyAddresses: readonly string[] = [],
  health: {
    readonly onRuntimeAvailable?: () => void;
    readonly onRuntimeUnavailable?: () => void;
  } = {},
) {
  return createPropertyPredatorExternalEventHandler({
    production,
    trustedProxyAddresses,
    ...health,
    bindings: [{ keyId: KEY_ID, sharedSecret: SECRET, store }],
  });
}

test('the endpoint returns 202 first receipt and 200 exact replay', async () => {
  const body = eventBody();
  const seen: PropertyPredatorExternalEventShadowRecordInput[] = [];
  const firstHandler = handlerWithStore(strictStore({ disposition: 'shadow', replayed: false }, seen));
  const first = response();
  await firstHandler(request(body, signedHeaders(body)), first);
  assert.equal(first.statusCode, 202);
  assert.deepEqual(first.body, { accepted: true, disposition: 'shadow', replayed: false });
  assert.equal(seen.length, 1);
  assert.deepEqual(Buffer.from(seen[0]!.rawBody), body);
  assert.equal(seen[0]!.verifiedSignature.keyId, KEY_ID);

  const replayHandler = handlerWithStore(strictStore({ disposition: 'shadow', replayed: true }));
  const replay = response();
  await replayHandler(request(body, signedHeaders(body)), replay);
  assert.equal(replay.statusCode, 200);
  assert.deepEqual(replay.body, { accepted: true, disposition: 'shadow', replayed: true });
});

test('the endpoint reports projected only after the composed runtime succeeds', async () => {
  const body = eventBody();
  const first = response();
  await handlerWithStore(strictStore({ disposition: 'projected', replayed: false }))(
    request(body, signedHeaders(body)),
    first,
  );
  assert.equal(first.statusCode, 202);
  assert.deepEqual(first.body, { accepted: true, disposition: 'projected', replayed: false });

  const replay = response();
  await handlerWithStore(strictStore({ disposition: 'projected', replayed: true }))(
    request(body, signedHeaders(body)),
    replay,
  );
  assert.equal(replay.statusCode, 200);
  assert.deepEqual(replay.body, { accepted: true, disposition: 'projected', replayed: true });
});

test('authentication is decided before any event-contract response', async () => {
  const malformed = Buffer.from('{');
  const seen: PropertyPredatorExternalEventShadowRecordInput[] = [];
  const handler = handlerWithStore(strictStore({ disposition: 'shadow', replayed: false }, seen));
  const unauthorized = response();
  await handler(request(malformed, signedHeaders(malformed, {
    'x-r72-signature': `v1=${'0'.repeat(64)}`,
  })), unauthorized);
  assert.equal(unauthorized.statusCode, 401);
  assert.deepEqual(unauthorized.body, { error: 'authentication_failed' });
  assert.equal(seen.length, 0);

  const authenticated = response();
  await handler(request(malformed, signedHeaders(malformed)), authenticated);
  assert.equal(authenticated.statusCode, 422);
  assert.deepEqual(authenticated.body, { error: 'invalid_event_contract' });
});

test('a signed body cannot supply a workspace or unknown contract field', async () => {
  const body = eventBody({ workspaceId: WORKSPACE_ID, profile: 'admin' });
  const handler = handlerWithStore(strictStore({ disposition: 'shadow', replayed: false }));
  const result = response();
  await handler(request(body, signedHeaders(body)), result);
  assert.equal(result.statusCode, 422);
  assert.deepEqual(result.body, { error: 'invalid_event_contract' });
});

test('content type, exact auth headers, and the streaming byte cap fail closed', async () => {
  const body = eventBody();
  const store = strictStore({ disposition: 'shadow', replayed: false });
  const handler = handlerWithStore(store);

  const unsupported = response();
  await handler(request(body, signedHeaders(body, { 'content-type': 'text/plain' })), unsupported);
  assert.equal(unsupported.statusCode, 415);

  const alteredHeader = response();
  await handler(request(body, signedHeaders(body, { 'x-r72-key-id': `${KEY_ID} ` })), alteredHeader);
  assert.equal(alteredHeader.statusCode, 401);

  const duplicateHeader = response();
  const headers = signedHeaders(body);
  const rawHeaders = Object.entries(headers).flatMap(([name, value]) => [name, value]);
  rawHeaders.push('X-R72-Key-Id', KEY_ID);
  await handler(request(body, headers, { rawHeaders }), duplicateHeader);
  assert.equal(duplicateHeader.statusCode, 401);

  const oversized = Buffer.alloc(PROPERTY_PREDATOR_EXTERNAL_EVENT_MAX_BODY_BYTES + 1, 0x20);
  const tooLarge = response();
  await handler(request(oversized, signedHeaders(oversized)), tooLarge);
  assert.equal(tooLarge.statusCode, 413);
  assert.deepEqual(tooLarge.body, { error: 'payload_too_large' });

  const padded = Buffer.concat([
    body,
    Buffer.alloc(PROPERTY_PREDATOR_EXTERNAL_EVENT_MAX_BODY_BYTES - body.byteLength, 0x20),
  ]);
  const exactLimit = response();
  await handler(request(padded, signedHeaders(padded)), exactLimit);
  assert.equal(exactLimit.statusCode, 202);
});

test('digest conflict and receipt-store failure have narrow non-leaking responses', async () => {
  const body = eventBody();
  const conflict = response();
  await handlerWithStore(strictStore(
    new PropertyPredatorExternalEventReceiptConflictError(),
  ))(request(body, signedHeaders(body)), conflict);
  assert.equal(conflict.statusCode, 409);
  assert.deepEqual(conflict.body, { error: 'event_conflict' });

  const unavailable = response();
  await handlerWithStore(strictStore(
    new Error('postgres://user:secret@example.test/private payload hunter@example.com'),
  ))(request(body, signedHeaders(body)), unavailable);
  assert.equal(unavailable.statusCode, 503);
  assert.deepEqual(unavailable.body, { error: 'external_event_store_unavailable' });
  assert.doesNotMatch(JSON.stringify(unavailable.body), /secret|hunter@example/i);
});

test('runtime health follows projection outcomes without changing response truth', async () => {
  const body = eventBody();
  const health: string[] = [];
  const unavailable = response();
  await handlerWithStore(
    strictStore(new Error('database unavailable')),
    false,
    [],
    { onRuntimeUnavailable: () => health.push('unavailable') },
  )(request(body, signedHeaders(body)), unavailable);
  assert.equal(unavailable.statusCode, 503);
  assert.deepEqual(health, ['unavailable']);

  const projected = response();
  await handlerWithStore(
    strictStore({ disposition: 'projected', replayed: false }),
    false,
    [],
    { onRuntimeAvailable: () => health.push('available') },
  )(request(body, signedHeaders(body)), projected);
  assert.equal(projected.statusCode, 202);
  assert.deepEqual(health, ['unavailable', 'available']);

  const observational = response();
  await handlerWithStore(
    strictStore({ disposition: 'projected', replayed: false }),
    false,
    [],
    { onRuntimeAvailable: () => { throw new Error('health observer failed'); } },
  )(request(body, signedHeaders(body)), observational);
  assert.equal(observational.statusCode, 202);
});

test('production requires real HTTPS unless a trusted proxy is explicitly configured', async () => {
  const body = eventBody();
  const store = strictStore({ disposition: 'shadow', replayed: false });
  const production = handlerWithStore(store, true);
  const http = response();
  await production(request(body, signedHeaders(body)), http);
  assert.equal(http.statusCode, 400);
  assert.deepEqual(http.body, { error: 'https_required' });

  const spoofed = response();
  await production(request(body, signedHeaders(body, { 'x-forwarded-proto': 'https' })), spoofed);
  assert.equal(spoofed.statusCode, 400, 'a direct caller cannot self-assert HTTPS');

  const untrustedPeer = response();
  await handlerWithStore(store, true, ['127.0.0.1'])(
    request(body, signedHeaders(body, { 'x-forwarded-proto': 'https' }), {
      remoteAddress: '203.0.113.25',
    }),
    untrustedPeer,
  );
  assert.equal(untrustedPeer.statusCode, 400, 'only a configured socket peer may assert HTTPS');

  const encrypted = response();
  await production(request(body, signedHeaders(body), { socketEncrypted: true }), encrypted);
  assert.equal(encrypted.statusCode, 202);

  const trustedProxy = response();
  await handlerWithStore(store, true, ['127.0.0.1'])(
    request(body, signedHeaders(body, { 'x-forwarded-proto': 'https' }), {
      remoteAddress: '127.0.0.1',
    }),
    trustedProxy,
  );
  assert.equal(trustedProxy.statusCode, 202);

  assert.throws(
    () => handlerWithStore(store, true, ['proxy.internal']),
    /trusted proxy addresses must be exact IPv4 or IPv6 addresses/,
  );

  const development = response();
  await handlerWithStore(store, false)(request(body, signedHeaders(body)), development);
  assert.equal(development.statusCode, 202);
});

test('environment configuration is disabled by default and invalid enablement stays closed', () => {
  const disabled = loadPropertyPredatorExternalEventConfig({ NODE_ENV: 'development' });
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.configurationReady, false);
  assert.equal(disabled.binding, undefined);
  assert.deepEqual(disabled.trustedProxyAddresses, []);

  const invalid = loadPropertyPredatorExternalEventConfig({
    NODE_ENV: 'production',
    PROPERTY_PREDATOR_EXTERNAL_EVENTS_ENABLED: 'tru',
  });
  assert.equal(invalid.enabled, true);
  assert.equal(invalid.configurationReady, false);
  assert.equal(invalid.production, true);
  assert.ok(invalid.blockers.length >= 4);
  assert.equal(invalid.binding, undefined);
});

test('valid configuration creates one dedicated key-to-workspace binding', () => {
  const encoded = SECRET.toString('base64url');
  const valid = loadPropertyPredatorExternalEventConfig({
    NODE_ENV: 'development',
    PROPERTY_PREDATOR_EXTERNAL_EVENTS_ENABLED: 'true',
    PROPERTY_PREDATOR_EXTERNAL_EVENTS_KEY_ID: KEY_ID,
    PROPERTY_PREDATOR_EXTERNAL_EVENTS_WORKSPACE_ID: WORKSPACE_ID,
    PROPERTY_PREDATOR_EXTERNAL_EVENTS_HMAC_SECRET_BASE64URL: encoded,
    PROPERTY_PREDATOR_EXTERNAL_EVENTS_TRUSTED_PROXY_ADDRESSES: '127.0.0.1,::1',
  });
  assert.equal(valid.configurationReady, true);
  assert.equal(valid.binding?.keyId, KEY_ID);
  assert.equal(valid.binding?.workspaceId, WORKSPACE_ID);
  assert.deepEqual(Buffer.from(valid.binding!.sharedSecret), SECRET);
  assert.deepEqual(valid.trustedProxyAddresses, ['127.0.0.1', '::1']);

  const invalidProxy = loadPropertyPredatorExternalEventConfig({
    PROPERTY_PREDATOR_EXTERNAL_EVENTS_ENABLED: 'true',
    PROPERTY_PREDATOR_EXTERNAL_EVENTS_KEY_ID: KEY_ID,
    PROPERTY_PREDATOR_EXTERNAL_EVENTS_WORKSPACE_ID: WORKSPACE_ID,
    PROPERTY_PREDATOR_EXTERNAL_EVENTS_HMAC_SECRET_BASE64URL: encoded,
    PROPERTY_PREDATOR_EXTERNAL_EVENTS_TRUSTED_PROXY_ADDRESSES: 'proxy.internal',
  });
  assert.equal(invalidProxy.configurationReady, false);
  assert.match(invalidProxy.blockers.join(' '), /only IP addresses/);

  const legacyBooleanTrust = loadPropertyPredatorExternalEventConfig({
    PROPERTY_PREDATOR_EXTERNAL_EVENTS_ENABLED: 'true',
    PROPERTY_PREDATOR_EXTERNAL_EVENTS_KEY_ID: KEY_ID,
    PROPERTY_PREDATOR_EXTERNAL_EVENTS_WORKSPACE_ID: WORKSPACE_ID,
    PROPERTY_PREDATOR_EXTERNAL_EVENTS_HMAC_SECRET_BASE64URL: encoded,
    PROPERTY_PREDATOR_EXTERNAL_EVENTS_TRUST_FORWARDED_PROTO: 'true',
  });
  assert.equal(legacyBooleanTrust.configurationReady, false);
  assert.match(legacyBooleanTrust.blockers.join(' '), /unsupported/);

  const reused = loadPropertyPredatorExternalEventConfig({
    PROPERTY_PREDATOR_EXTERNAL_EVENTS_ENABLED: 'true',
    PROPERTY_PREDATOR_EXTERNAL_EVENTS_KEY_ID: KEY_ID,
    PROPERTY_PREDATOR_EXTERNAL_EVENTS_WORKSPACE_ID: WORKSPACE_ID,
    PROPERTY_PREDATOR_EXTERNAL_EVENTS_HMAC_SECRET_BASE64URL: encoded,
    SESSION_SECRET: encoded,
  });
  assert.equal(reused.configurationReady, false);
  assert.match(reused.blockers.join(' '), /must be dedicated/);
});

function appConfig(): StripeConfig {
  return {
    secretKey: '',
    keyMode: 'unconfigured',
    webhookSecret: '',
    priceIds: {},
    planIds: {},
    platformSubscriptionsEnabled: false,
    sandboxAccessToken: '',
    publicLeadCaptureEnabled: false,
    publicBaseUrl: 'http://localhost:8080',
    host: '127.0.0.1',
    port: 4242,
    liveMode: false,
    production: false,
    dataDir: '.',
    ordersFile: 'unused',
    subscriptionsFile: 'unused',
    allowedOrigins: [],
    adminPassword: '',
    sessionSecret: 'development-only',
  };
}

function appForBridge(mount: Parameters<typeof createApp>[0]['propertyPredatorExternalEvents']) {
  const stripe = {
    checkout: { sessions: { create: async () => { throw new Error('unused'); } } },
    webhooks: { constructEvent: () => { throw new Error('unused'); } },
  } as unknown as StripeLike;
  const orders: OrderStore = {
    record: () => undefined,
    find: () => null,
    update: () => null,
  };
  return createApp({
    stripe,
    cfg: appConfig(),
    orders,
    kickPipeline: () => { throw new Error('unused'); },
    now: () => '2026-08-25T00:00:00.000Z',
    webhookReceipts: memoryWebhookReceiptStore(),
    propertyPredatorExternalEvents: mount,
  });
}

test('main app reports bridge readiness and keeps an incomplete opt-in closed', async () => {
  const handler = appForBridge({
    enabled: true,
    ready: false,
    blockers: ['Property Predator external-event receipt store did not pass protected readiness'],
  });
  const health = response();
  await handler(request(Buffer.alloc(0), {}, { method: 'GET', path: '/health' }), health);
  assert.equal(health.statusCode, 200);
  assert.deepEqual(health.body.property_predator_external_events, {
    enabled: true,
    ready: false,
    blockers: ['Property Predator external-event receipt store did not pass protected readiness'],
  });

  const route = response();
  const body = eventBody();
  await handler(request(body, signedHeaders(body)), route);
  assert.equal(route.statusCode, 503);
  assert.deepEqual(route.body, { error: 'external_event_bridge_unavailable' });

  const disabled = appForBridge({ enabled: false, ready: false, blockers: ['disabled'] });
  const hidden = response();
  await disabled(request(body, signedHeaders(body)), hidden);
  assert.equal(hidden.statusCode, 404);
});

test('a mounted degraded bridge remains open for an exact repair retry', async () => {
  let handled = 0;
  const handler = appForBridge({
    enabled: true,
    ready: false,
    blockers: ['latest projection failed'],
    handle: async (_req, res) => {
      handled += 1;
      const encoded = JSON.stringify({ accepted: true, disposition: 'projected' });
      res.writeHead(202, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(encoded),
      });
      res.end(encoded);
    },
  });
  const body = eventBody();
  const retried = response();
  await handler(request(body, signedHeaders(body)), retried);
  assert.equal(retried.statusCode, 202);
  assert.equal(handled, 1);
});
