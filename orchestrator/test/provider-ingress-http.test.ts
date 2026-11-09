import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import test from 'node:test';
import {
  createMetaWhatsAppCredentialBundle,
} from '../src/meta-communications/index.js';
import {
  PROPERTY_PREDATOR_META_WHATSAPP_WEBHOOK_PATH,
  PROPERTY_PREDATOR_WHEREBY_WEBHOOK_PATH,
  composePropertyPredatorProviderIngress,
  createMetaInboundWebhookHandler,
  createPropertyPredatorProviderIngressMount,
  createWherebyInboundWebhookHandler,
  loadPropertyPredatorProviderIngressConfig,
  type MetaInboundDurableCommandService,
} from '../src/integrations/provider-ingress/index.js';
import {
  WherebyWebinarIngestService,
  type WherebyWebinarIngestDependencies,
} from '../src/whereby-webinar/index.js';
import { createApp } from '../src/server/app.js';
import type { StripeConfig } from '../src/server/config.js';
import { memoryWebhookReceiptStore, type OrderStore } from '../src/server/orders.js';
import type { StripeLike } from '../src/server/stripe.js';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const META_CONNECTION_ID = '22222222-2222-4222-8222-222222222222';
const WHEREBY_CONNECTION_ID = '33333333-3333-4333-8333-333333333333';
const META_SECRET = 'meta-app-secret-00000000000000000000000001';
const VERIFY_TOKEN = 'meta-webhook-verify-token-000000000000001';
const WHEREBY_SECRET = Buffer.from('whereby-test-secret-00000000000000000001', 'utf8');
const NOW_SECONDS = 1_787_923_200;

const whatsappCredentials = createMetaWhatsAppCredentialBundle({
  workspaceId: WORKSPACE_ID,
  connectionId: META_CONNECTION_ID,
  appId: '123456789012345',
  wabaId: '234567890123456',
  phoneNumberId: '345678901234567',
  graphApiVersion: 'v24.0',
  credentialVersion: 'secret-manager-v1',
  accessToken: 'opaque-meta-access-token-never-persist-this-value',
  appSecret: META_SECRET,
  verifyToken: VERIFY_TOKEN,
});

function request(
  body: Uint8Array = new Uint8Array(),
  options: Readonly<{
    method?: string;
    path?: string;
    headers?: Record<string, string>;
    rawHeaders?: string[];
    encrypted?: boolean;
    remoteAddress?: string;
  }> = {},
): IncomingMessage {
  const stream = Readable.from(body.byteLength === 0 ? [] : [Buffer.from(body)]) as unknown as IncomingMessage;
  const headers = Object.fromEntries(
    Object.entries(options.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
  );
  return Object.assign(stream, {
    method: options.method ?? 'POST',
    url: options.path ?? '/',
    headers,
    rawHeaders: options.rawHeaders
      ?? Object.entries(options.headers ?? {}).flatMap(([name, value]) => [name, value]),
    socket: {
      encrypted: options.encrypted === true,
      remoteAddress: options.remoteAddress,
    },
  });
}

function response(): ServerResponse & {
  statusCode: number;
  rawBody: string;
  json: Record<string, unknown> | null;
  headers: Record<string, string | number>;
} {
  const state = {
    statusCode: 0,
    rawBody: '',
    json: null as Record<string, unknown> | null,
    headers: {} as Record<string, string | number>,
    setHeader(name: string, value: string | number) {
      state.headers[name.toLowerCase()] = value;
      return state;
    },
    writeHead(status: number, headers: Record<string, string | number> = {}) {
      state.statusCode = status;
      for (const [name, value] of Object.entries(headers)) state.headers[name.toLowerCase()] = value;
      return state;
    },
    end(body = '') {
      state.rawBody = String(body);
      if (state.headers['content-type'] === 'application/json' && state.rawBody) {
        state.json = JSON.parse(state.rawBody) as Record<string, unknown>;
      }
      return state;
    },
  };
  return state as unknown as ServerResponse & typeof state;
}

function metaBody(text = 'Please send the details.'): Buffer {
  return Buffer.from(JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: whatsappCredentials.wabaId, changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp',
      metadata: {
        display_phone_number: '15551230000',
        phone_number_id: whatsappCredentials.phoneNumberId,
      },
      contacts: [],
      messages: [{
        from: '15551234567',
        id: 'wamid.provider_ingress_1',
        timestamp: '1787923200',
        type: 'text',
        text: { body: text },
      }],
    } }] }],
  }), 'utf8');
}

function metaHeaders(body: Uint8Array): Record<string, string> {
  return {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.byteLength),
    'x-hub-signature-256': `sha256=${createHmac('sha256', META_SECRET).update(body).digest('hex')}`,
  };
}

function durableMetaService(): MetaInboundDurableCommandService & { seen: unknown[] } {
  const receipts = new Map<string, string>();
  const seen: unknown[] = [];
  return {
    workspaceId: WORKSPACE_ID,
    connectionId: META_CONNECTION_ID,
    seen,
    async recordAuthenticatedInbound(input) {
      seen.push(input);
      const key = `${input.workspaceId}:${input.connectionId}:${input.providerId}:${input.externalMessageId}`;
      const existing = receipts.get(key);
      if (existing && existing !== input.payloadSha256) return { disposition: 'conflict' };
      if (existing) return { disposition: 'replayed' };
      receipts.set(key, input.payloadSha256);
      return { disposition: 'applied' };
    },
  };
}

test('Meta GET ceremony is exact, secret-safe, and bound to one connection', async () => {
  const service = durableMetaService();
  const handler = createMetaInboundWebhookHandler({
    path: PROPERTY_PREDATOR_META_WHATSAPP_WEBHOOK_PATH,
    credentials: whatsappCredentials,
    commandService: service,
    providerEffectsEnabled: false,
    emergencyPaused: true,
    production: false,
  });
  const success = response();
  await handler(request(new Uint8Array(), {
    method: 'GET',
    path: `${PROPERTY_PREDATOR_META_WHATSAPP_WEBHOOK_PATH}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(VERIFY_TOKEN)}&hub.challenge=17290123`,
  }), success);
  assert.equal(success.statusCode, 200);
  assert.equal(success.rawBody, '17290123');
  assert.equal(success.headers['cache-control'], 'no-store');

  const duplicate = response();
  await handler(request(new Uint8Array(), {
    method: 'GET',
    path: `${PROPERTY_PREDATOR_META_WHATSAPP_WEBHOOK_PATH}?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1&hub.challenge=2`,
  }), duplicate);
  assert.equal(duplicate.statusCode, 400);
  assert.equal(duplicate.rawBody, '');

  assert.throws(() => createMetaInboundWebhookHandler({
    path: PROPERTY_PREDATOR_META_WHATSAPP_WEBHOOK_PATH,
    credentials: whatsappCredentials,
    commandService: { ...service, connectionId: WHEREBY_CONNECTION_ID },
    providerEffectsEnabled: false,
    emergencyPaused: true,
    production: false,
  }), /crossed its credential binding/);
});

test('Meta POST preserves exact signed bytes and atomically reports apply, replay and conflict', async () => {
  const service = durableMetaService();
  const handler = createMetaInboundWebhookHandler({
    path: PROPERTY_PREDATOR_META_WHATSAPP_WEBHOOK_PATH,
    credentials: whatsappCredentials,
    commandService: service,
    providerEffectsEnabled: false,
    emergencyPaused: true,
    production: false,
  });
  const body = metaBody();
  const first = response();
  await handler(request(body, {
    path: PROPERTY_PREDATOR_META_WHATSAPP_WEBHOOK_PATH,
    headers: metaHeaders(body),
  }), first);
  assert.equal(first.statusCode, 202);
  assert.deepEqual(first.json, { accepted: true, applied: 1, replayed: 0, ignored: false });
  const recorded = service.seen[0] as { workspaceId: string; connectionId: string; payloadSha256: string };
  assert.equal(recorded.workspaceId, WORKSPACE_ID);
  assert.equal(recorded.connectionId, META_CONNECTION_ID);
  assert.match(recorded.payloadSha256, /^[a-f0-9]{64}$/u);

  const replay = response();
  await handler(request(body, {
    path: PROPERTY_PREDATOR_META_WHATSAPP_WEBHOOK_PATH,
    headers: metaHeaders(body),
  }), replay);
  assert.equal(replay.statusCode, 200);
  assert.deepEqual(replay.json, { accepted: true, applied: 0, replayed: 1, ignored: false });

  const altered = metaBody('Different authenticated bytes, same provider message ID.');
  const conflict = response();
  await handler(request(altered, {
    path: PROPERTY_PREDATOR_META_WHATSAPP_WEBHOOK_PATH,
    headers: metaHeaders(altered),
  }), conflict);
  assert.equal(conflict.statusCode, 409);
  assert.deepEqual(conflict.json, { error: 'event_conflict' });
});

test('Meta rejects altered signatures, duplicate headers, non-HTTPS production and body ambiguity', async () => {
  const handler = createMetaInboundWebhookHandler({
    path: PROPERTY_PREDATOR_META_WHATSAPP_WEBHOOK_PATH,
    credentials: whatsappCredentials,
    commandService: durableMetaService(),
    providerEffectsEnabled: false,
    emergencyPaused: true,
    production: true,
    trustedProxyAddresses: ['127.0.0.1'],
  });
  const body = metaBody();
  const insecure = response();
  await handler(request(body, {
    path: PROPERTY_PREDATOR_META_WHATSAPP_WEBHOOK_PATH,
    headers: metaHeaders(body),
  }), insecure);
  assert.equal(insecure.statusCode, 400);

  const wrongSignature = response();
  await handler(request(body, {
    path: PROPERTY_PREDATOR_META_WHATSAPP_WEBHOOK_PATH,
    encrypted: true,
    headers: { ...metaHeaders(body), 'x-hub-signature-256': `sha256=${'0'.repeat(64)}` },
  }), wrongSignature);
  assert.equal(wrongSignature.statusCode, 401);

  const headers = metaHeaders(body);
  const duplicateRawHeaders = Object.entries(headers).flatMap(([name, value]) => [name, value]);
  duplicateRawHeaders.push('X-Hub-Signature-256', headers['x-hub-signature-256']!);
  const duplicate = response();
  await handler(request(body, {
    path: PROPERTY_PREDATOR_META_WHATSAPP_WEBHOOK_PATH,
    encrypted: true,
    headers,
    rawHeaders: duplicateRawHeaders,
  }), duplicate);
  assert.equal(duplicate.statusCode, 401);

  const mismatch = response();
  await handler(request(body, {
    path: PROPERTY_PREDATOR_META_WHATSAPP_WEBHOOK_PATH,
    encrypted: true,
    headers: { ...headers, 'content-length': String(body.byteLength + 1) },
  }), mismatch);
  assert.equal(mismatch.statusCode, 503);
});

function wherebyPayload(): Buffer {
  return Buffer.from(JSON.stringify({
    id: 'evt_room_started_001',
    apiVersion: '1.0',
    createdAt: '2026-08-28T17:00:00.000Z',
    type: 'room.session.started',
    data: {
      meetingId: 'meeting-001',
      roomName: '/property-predator-live-001',
      roomSessionId: 'session-001',
      subdomain: 'propertypredator',
    },
  }), 'utf8');
}

function wherebyDependencies(): WherebyWebinarIngestDependencies {
  const receipts = new Map<string, { payload: string; complete: boolean; lease: string }>();
  return {
    workspaceId: WORKSPACE_ID,
    connectionId: WHEREBY_CONNECTION_ID,
    providerEffectsEnabled: false,
    emergencyPaused: true,
    receipts: {
      async claim(input) {
        const key = `${input.workspaceId}:${input.connectionId}:${input.eventId}`;
        const existing = receipts.get(key);
        if (existing && existing.payload !== input.payloadSha256) return { disposition: 'conflict' };
        if (existing?.complete) return { disposition: 'replayed' };
        if (existing) return { disposition: 'in_progress' };
        const lease = 'lease_0000000000000001';
        receipts.set(key, { payload: input.payloadSha256, complete: false, lease });
        return { disposition: 'claimed', leaseToken: lease };
      },
      async complete(input) {
        const key = `${input.workspaceId}:${input.connectionId}:${input.eventId}`;
        const existing = receipts.get(key);
        if (!existing || existing.lease !== input.leaseToken) return 'lost';
        receipts.set(key, { ...existing, complete: true });
        return 'completed';
      },
      async release(input) {
        const key = `${input.workspaceId}:${input.connectionId}:${input.eventId}`;
        return receipts.delete(key) ? 'released' : 'lost';
      },
    },
    bindings: { async resolve() { return null; } },
    attendance: {
      async recordJoin() { return { disposition: 'opened' }; },
      async recordLeave() { return { disposition: 'pending' }; },
    },
    journeyEvents: { async record() { return 'recorded'; } },
  };
}

function wherebyHeaders(body: Uint8Array): Record<string, string> {
  const signature = createHmac('sha256', WHEREBY_SECRET)
    .update(String(NOW_SECONDS), 'ascii')
    .update('.', 'ascii')
    .update(body)
    .digest('hex');
  return {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.byteLength),
    'whereby-signature': `t=${NOW_SECONDS},v1=${signature}`,
  };
}

test('Whereby exact HMAC callback feeds the idempotent attendance service and exposes no provider effect', async () => {
  const handler = createWherebyInboundWebhookHandler({
    webhookSecret: WHEREBY_SECRET,
    expectedSubdomain: 'propertypredator',
    service: new WherebyWebinarIngestService(wherebyDependencies()),
    providerEffectsEnabled: false,
    emergencyPaused: true,
    production: false,
    nowSeconds: () => NOW_SECONDS,
  });
  const body = wherebyPayload();
  const first = response();
  await handler(request(body, {
    path: PROPERTY_PREDATOR_WHEREBY_WEBHOOK_PATH,
    headers: wherebyHeaders(body),
  }), first);
  assert.equal(first.statusCode, 202);
  assert.deepEqual(first.json, { accepted: true, disposition: 'recorded' });

  const replay = response();
  await handler(request(body, {
    path: PROPERTY_PREDATOR_WHEREBY_WEBHOOK_PATH,
    headers: wherebyHeaders(body),
  }), replay);
  assert.equal(replay.statusCode, 200);
  assert.deepEqual(replay.json, { accepted: true, disposition: 'replayed' });

  const tampered = Buffer.concat([body, Buffer.from(' ')]);
  const bad = response();
  await handler(request(tampered, {
    path: PROPERTY_PREDATOR_WHEREBY_WEBHOOK_PATH,
    headers: { ...wherebyHeaders(tampered), 'whereby-signature': wherebyHeaders(body)['whereby-signature']! },
  }), bad);
  assert.equal(bad.statusCode, 401);
});

test('runtime composition is opt-in, capability-gated and fail-closed until every endpoint is ready', () => {
  assert.deepEqual(loadPropertyPredatorProviderIngressConfig({}), {
    enabled: false,
    configurationReady: true,
    enabledRails: [],
    blockers: [],
  });
  const env = {
    PROPERTY_PREDATOR_META_WHATSAPP_INGRESS_ENABLED: 'true',
    PROPERTY_PREDATOR_PROVIDER_INBOUND_CAPABILITY: 'meta_whereby_v1',
    PROPERTY_PREDATOR_PROVIDER_EFFECTS: 'false',
    PROPERTY_PREDATOR_PROVIDER_EMERGENCY_PAUSED: 'true',
  };
  const missing = composePropertyPredatorProviderIngress(env);
  assert.equal(missing.enabled, true);
  assert.equal(missing.ready, false);
  assert.deepEqual(missing.blockers, ['meta_whatsapp protected endpoint did not pass readiness']);

  const endpointHandler = async (_req: IncomingMessage, res: ServerResponse): Promise<void> => {
    res.writeHead(204);
    res.end();
  };
  const ready = composePropertyPredatorProviderIngress(env, {
    endpoints: {
      meta_whatsapp: {
        path: PROPERTY_PREDATOR_META_WHATSAPP_WEBHOOK_PATH,
        handle: endpointHandler,
      },
    },
  });
  assert.equal(ready.ready, true);
  assert.equal(ready.ownsPath(PROPERTY_PREDATOR_META_WHATSAPP_WEBHOOK_PATH), true);
  assert.deepEqual(ready.paths, [PROPERTY_PREDATOR_META_WHATSAPP_WEBHOOK_PATH]);
  assert.throws(() => createPropertyPredatorProviderIngressMount([
    { path: PROPERTY_PREDATOR_META_WHATSAPP_WEBHOOK_PATH, handle: endpointHandler },
    { path: PROPERTY_PREDATOR_META_WHATSAPP_WEBHOOK_PATH, handle: endpointHandler },
  ]), /duplicated/);

  const unsafe = loadPropertyPredatorProviderIngressConfig({
    PROPERTY_PREDATOR_WHEREBY_INGRESS_ENABLED: 'yes',
    PROPERTY_PREDATOR_PROVIDER_EFFECTS: 'true',
  });
  assert.equal(unsafe.enabled, true);
  assert.equal(unsafe.configurationReady, false);
  assert.ok(unsafe.blockers.includes('whereby ingress enablement must be exact true'));
  assert.ok(unsafe.blockers.includes('provider effects must be exact false'));
});

function appConfig(): StripeConfig {
  return {
    secretKey: '', keyMode: 'unconfigured', webhookSecret: '', priceIds: {}, planIds: {},
    platformSubscriptionsEnabled: false, sandboxAccessToken: '', publicLeadCaptureEnabled: false,
    publicBaseUrl: 'http://localhost:8080', host: '127.0.0.1', port: 4242,
    liveMode: false, production: false, dataDir: '.', ordersFile: 'unused',
    subscriptionsFile: 'unused', allowedOrigins: [], adminPassword: '',
    sessionSecret: 'development-only',
  };
}

function appWithIngress(mount: Parameters<typeof createApp>[0]['propertyPredatorProviderIngress']) {
  const stripe = {
    checkout: { sessions: { create: async () => { throw new Error('unused'); } } },
    webhooks: { constructEvent: () => { throw new Error('unused'); } },
  } as unknown as StripeLike;
  const orders: OrderStore = { record: () => undefined, find: () => null, update: () => null };
  return createApp({
    stripe, cfg: appConfig(), orders, kickPipeline: () => { throw new Error('unused'); },
    now: () => '2026-08-28T00:00:00.000Z', webhookReceipts: memoryWebhookReceiptStore(),
    propertyPredatorProviderIngress: mount,
  });
}

test('main server owns exact provider paths and reports readiness without claiming outbound capability', async () => {
  let handled = 0;
  const endpoint = async (_req: IncomingMessage, res: ServerResponse): Promise<void> => {
    handled += 1;
    res.writeHead(204);
    res.end();
  };
  const mount = createPropertyPredatorProviderIngressMount([{
    path: PROPERTY_PREDATOR_META_WHATSAPP_WEBHOOK_PATH,
    handle: endpoint,
  }]);
  const app = appWithIngress(mount);
  const health = response();
  await app(request(new Uint8Array(), { method: 'GET', path: '/health' }), health);
  assert.equal(health.statusCode, 200);
  assert.deepEqual(health.json?.property_predator_provider_ingress, {
    enabled: true,
    ready: true,
    blockers: [],
    paths: [PROPERTY_PREDATOR_META_WHATSAPP_WEBHOOK_PATH],
    provider_effects_enabled: false,
  });

  const routed = response();
  await app(request(new Uint8Array(), {
    method: 'GET',
    path: `${PROPERTY_PREDATOR_META_WHATSAPP_WEBHOOK_PATH}?hub.mode=subscribe`,
  }), routed);
  assert.equal(routed.statusCode, 204);
  assert.equal(handled, 1);

  const blockedApp = appWithIngress(composePropertyPredatorProviderIngress({
    PROPERTY_PREDATOR_META_WHATSAPP_INGRESS_ENABLED: 'true',
    PROPERTY_PREDATOR_PROVIDER_INBOUND_CAPABILITY: 'meta_whereby_v1',
    PROPERTY_PREDATOR_PROVIDER_EFFECTS: 'false',
    PROPERTY_PREDATOR_PROVIDER_EMERGENCY_PAUSED: 'true',
  }));
  const blocked = response();
  await blockedApp(request(new Uint8Array(), {
    method: 'POST', path: PROPERTY_PREDATOR_META_WHATSAPP_WEBHOOK_PATH,
  }), blocked);
  assert.equal(blocked.statusCode, 503);
  assert.deepEqual(blocked.json, { error: 'provider_ingress_unavailable' });
});
