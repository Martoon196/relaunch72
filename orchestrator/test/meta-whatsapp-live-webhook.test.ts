import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import test from 'node:test';
import {
  loadMetaWhatsAppLiveWebhookConfig,
  startMetaWhatsAppLiveWebhookService,
} from '../src/services/meta-whatsapp-live-webhook/server.js';
import { PgMetaWhatsAppLiveWebhookCommandService } from '../src/whatsapp-live-pg/index.js';
import type {
  MetaWhatsAppLiveWebhookCommandService,
  VerifiedMetaWhatsAppLiveEvent,
} from '../src/whatsapp-live/index.js';

const INSTALLATION = '11111111-1111-4111-8111-111111111111';
const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const CONNECTION = '33333333-3333-4333-8333-333333333333';
const BINDING = '44444444-4444-4444-8444-444444444444';
const APP_SECRET = 'property-predator-meta-app-secret-123456789';
const VERIFY_TOKEN = 'property-predator-meta-verify-token-123456789';
const DATABASE_URL =
  'postgresql://r72_whatsapp_live_webhook_command:secret@db.example/relaunch72?sslmode=require';
const digest = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');

function darkEnv(): NodeJS.ProcessEnv {
  return { NODE_ENV: 'production', DATABASE_WHATSAPP_LIVE_WEBHOOK_URL: DATABASE_URL,
    PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID: INSTALLATION,
    PROPERTY_PREDATOR_WHATSAPP_WEBHOOK_MODE: 'disabled' };
}

function activeEnv(): NodeJS.ProcessEnv {
  return { ...darkEnv(), PROPERTY_PREDATOR_WHATSAPP_WEBHOOK_MODE: 'signed_live',
    PROPERTY_PREDATOR_WHATSAPP_LIVE_PROVIDER_ID: 'meta_whatsapp_cloud',
    PROPERTY_PREDATOR_WHATSAPP_LIVE_WORKSPACE_ID: WORKSPACE,
    PROPERTY_PREDATOR_WHATSAPP_LIVE_CONNECTION_ID: CONNECTION,
    PROPERTY_PREDATOR_WHATSAPP_LIVE_BINDING_ID: BINDING,
    PROPERTY_PREDATOR_META_WHATSAPP_APP_ID: '100001234567890',
    PROPERTY_PREDATOR_META_WHATSAPP_WABA_ID: '200001234567890',
    PROPERTY_PREDATOR_META_WHATSAPP_PHONE_NUMBER_ID: '300001234567890',
    PROPERTY_PREDATOR_META_WHATSAPP_APP_SECRET: APP_SECRET,
    PROPERTY_PREDATOR_META_WHATSAPP_VERIFY_TOKEN: VERIFY_TOKEN };
}

test('webhook defaults dark and rejects partial activation or outbound-worker secrets', () => {
  assert.equal(loadMetaWhatsAppLiveWebhookConfig(darkEnv()).mode, 'disabled');
  assert.throws(() => loadMetaWhatsAppLiveWebhookConfig({
    ...darkEnv(), PROPERTY_PREDATOR_WHATSAPP_WEBHOOK_MODE: 'signed_live',
  }), /activation tuple|must be|invalid|unavailable/u);
  assert.throws(() => loadMetaWhatsAppLiveWebhookConfig({
    ...darkEnv(), DATABASE_WEB_URL: DATABASE_URL,
  }), /another database identity/u);
  for (const patch of [
    { META_ACCESS_TOKEN: 'must-never-enter-webhook-process' },
    { PROPERTY_PREDATOR_WHATSAPP_CREDENTIAL_ENCRYPTION_KEY_BASE64:
      Buffer.alloc(32, 1).toString('base64') },
    { SESSION_SECRET: 'must-never-enter-webhook-process' },
  ]) assert.throws(() => loadMetaWhatsAppLiveWebhookConfig({ ...darkEnv(), ...patch }),
    /unrelated secret/u);
  assert.equal(loadMetaWhatsAppLiveWebhookConfig(activeEnv()).mode, 'signed_live');
});

function pool(): never {
  return { query: async () => ({ rows: [] }), connect: async () => ({}),
    end: async () => undefined } as never;
}

test('dark service proves readiness without constructing a command seam', async () => {
  const order: string[] = [];
  let commandServices = 0;
  const runtime = await startMetaWhatsAppLiveWebhookService({
    env: darkEnv(), listen: false, createPool: pool,
    assertSchemaCurrent: async () => { order.push('schema'); },
    assertInstallationReady: async (_pool, expected) => {
      assert.equal(expected, INSTALLATION); order.push('installation');
    },
    assertBoundaryReady: async () => { order.push('boundary'); },
    createCommandService: () => { commandServices += 1; return {} as never; },
    writeReadiness: () => undefined,
  });
  assert.deepEqual(order, ['schema', 'installation', 'boundary']);
  assert.equal(commandServices, 0);
  assert.equal(runtime.readiness.mode, 'disabled');
  assert.equal(runtime.readiness.safety.outboundAccessTokenPresent, false);
  assert.equal(runtime.readiness.safety.credentialEncryptionKeyPresent, false);
  assert.equal(runtime.readiness.safety.providerCallsMadeAtReadiness, false);
  const response = await request(runtime.handler, 'POST', '/webhooks/meta/whatsapp', '{}');
  assert.equal(response.status, 503);
  await runtime.shutdown();
});

function webhookFixture(): unknown {
  return { object: 'whatsapp_business_account', entry: [{ id: '200001234567890',
    changes: [{ field: 'messages', value: { messaging_product: 'whatsapp',
      metadata: { phone_number_id: '300001234567890' },
      messages: [{ id: 'wamid.INBOUND_1', from: '447700900456', timestamp: '1787997600',
        type: 'text', text: { body: 'Yes, tell me more.' } }],
      statuses: [{ id: 'wamid.OUTBOUND_1', recipient_id: '447700900123',
        status: 'delivered', timestamp: '1787997600' }] } }] }] };
}

async function request(
  handler: (request: never, response: never) => Promise<void>,
  method: string,
  url: string,
  body = '',
  headers: Record<string, string> = {},
): Promise<Readonly<{ status: number; body: string; headers: Record<string, unknown> }>> {
  const input = Readable.from(body.length > 0 ? [Buffer.from(body)] : []) as never as {
    method: string; url: string; headers: Record<string, string>;
  };
  input.method = method;
  input.url = url;
  input.headers = { ...(body.length > 0 ? { 'content-length': String(Buffer.byteLength(body)) } : {}),
    ...headers };
  let status = 0; let output = ''; let responseHeaders: Record<string, unknown> = {};
  const response = {
    headersSent: false,
    writeHead(code: number, exact: Record<string, unknown>) {
      status = code; responseHeaders = exact; this.headersSent = true; return this;
    },
    end(value?: Uint8Array | string) {
      output = value === undefined ? '' : Buffer.from(value).toString('utf8');
    },
    destroy() { /* test response */ },
  };
  await handler(input as never, response as never);
  return Object.freeze({ status, body: output, headers: responseHeaders });
}

test('challenge and POST routes verify exact raw bytes before dispatching receipts', async () => {
  const received: string[] = [];
  const commandService: MetaWhatsAppLiveWebhookCommandService = {
    workspaceId: WORKSPACE, connectionId: CONNECTION,
    async recordInbound({ event, projection }) {
      assert.equal(projection, 'conversion_inbox_and_lead360');
      received.push(`inbound:${event.bodySha256}`); return 'applied';
    },
    async recordStatus({ event }) { received.push(`status:${event.status}`); return 'applied'; },
  };
  const runtime = await startMetaWhatsAppLiveWebhookService({
    env: activeEnv(), listen: false, createPool: pool,
    assertSchemaCurrent: async () => undefined,
    assertInstallationReady: async () => undefined,
    assertBoundaryReady: async () => undefined,
    createCommandService: () => commandService,
    writeReadiness: () => undefined,
  });
  const challenge = await request(runtime.handler, 'GET',
    `/webhooks/meta/whatsapp?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(VERIFY_TOKEN)}&hub.challenge=owned-proof`);
  assert.equal(challenge.status, 200);
  assert.equal(challenge.body, 'owned-proof');
  assert.match(String(challenge.headers['Content-Type']), /text\/plain/u);

  const raw = JSON.stringify(webhookFixture());
  const signature = `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`;
  const accepted = await request(runtime.handler, 'POST', '/webhooks/meta/whatsapp', raw, {
    'content-type': 'application/json; charset=utf-8', 'x-hub-signature-256': signature,
  });
  assert.equal(accepted.status, 200);
  assert.deepEqual(received.map((value) => value.split(':', 1)[0]), ['inbound', 'status']);

  const changedBytes = await request(runtime.handler, 'POST', '/webhooks/meta/whatsapp',
    `${raw}\n`, { 'content-type': 'application/json', 'x-hub-signature-256': signature });
  assert.equal(changedBytes.status, 401, 'signature must bind the untouched byte sequence');
  const oversized = await request(runtime.handler, 'POST', '/webhooks/meta/whatsapp', '', {
    'content-type': 'application/json', 'content-length': '262145',
    'x-hub-signature-256': signature,
  });
  assert.equal(oversized.status, 413);
  await runtime.shutdown();
});

test('webhook repository writes only signed hashes through the exact receipt functions', async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const client = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      if (sql.includes('record_whatsapp_live_')) return { rows: [{ outcome: 'applied' }] };
      return { rows: [] };
    },
    release() { /* test client */ },
  };
  const service = new PgMetaWhatsAppLiveWebhookCommandService({
    commandPool: { connect: async () => client } as never,
    workspaceId: WORKSPACE, connectionId: CONNECTION, bindingId: BINDING,
  });
  const inbound: Extract<VerifiedMetaWhatsAppLiveEvent, { kind: 'inbound' }> = {
    kind: 'inbound', workspaceId: WORKSPACE, connectionId: CONNECTION,
    externalEventId: 'inbound:wamid.INBOUND_1', providerMessageId: 'wamid.INBOUND_1',
    senderId: '447700900456', senderSha256: digest('447700900456'),
    body: 'Yes, tell me more.', bodySha256: digest('Yes, tell me more.'),
    occurredAt: '2026-08-29T10:00:00.000Z',
  };
  assert.equal(await service.recordInbound({ event: inbound,
    payloadSha256: 'a'.repeat(64), projection: 'conversion_inbox_and_lead360' }), 'applied');
  const domain = calls.find((call) => call.sql.includes('record_whatsapp_live_inbound_receipt'));
  assert.ok(domain);
  assert.deepEqual(domain.values?.slice(0, 2), [WORKSPACE, BINDING]);
  assert.equal(domain.values?.includes(inbound.body), false);
  assert.equal(domain.values?.includes(inbound.senderId), false);
  assert.match(calls.find((call) => call.sql.includes('set_config'))?.sql ?? '', /app[.]actor_kind/u);
});
