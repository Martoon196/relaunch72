import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import test from 'node:test';
import {
  loadTwilioSmsLiveWebhookConfig,
  startTwilioSmsLiveWebhookService,
  TWILIO_SMS_INBOUND_WEBHOOK_PATH,
  TWILIO_SMS_STATUS_WEBHOOK_PATH,
} from '../src/services/twilio-sms-live-webhook/server.js';

const INSTALLATION = '11111111-1111-4111-8111-111111111111';
const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const CONNECTION = '33333333-3333-4333-8333-333333333333';
const ACCOUNT = `AC${'1'.repeat(32)}`;
const MESSAGE = `SM${'2'.repeat(32)}`;
const TOKEN = 'twilio-webhook-auth-token-123456';
const ORIGIN = 'https://hq.propertypredator.com';
const DATABASE_URL =
  'postgresql://r72_sms_webhook_command:secret@db.example/relaunch72?sslmode=require';

function darkEnv(): NodeJS.ProcessEnv {
  return { NODE_ENV: 'production', DATABASE_SMS_WEBHOOK_URL: DATABASE_URL,
    PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID: INSTALLATION,
    PROPERTY_PREDATOR_SMS_WEBHOOK_MODE: 'disabled' };
}

function activeEnv(): NodeJS.ProcessEnv {
  return { ...darkEnv(), PROPERTY_PREDATOR_SMS_WEBHOOK_MODE: 'signed_live',
    PROPERTY_PREDATOR_SMS_PROVIDER_ID: 'twilio_messaging',
    PROPERTY_PREDATOR_SMS_LIVE_WORKSPACE_ID: WORKSPACE,
    PROPERTY_PREDATOR_SMS_LIVE_CONNECTION_ID: CONNECTION,
    PROPERTY_PREDATOR_SMS_ACCOUNT_SID: ACCOUNT, TWILIO_AUTH_TOKEN: TOKEN,
    PROPERTY_PREDATOR_SMS_WEBHOOK_PUBLIC_ORIGIN: ORIGIN };
}

function pool(): never {
  return { query: async () => ({ rows: [] }), connect: async () => ({}),
    end: async () => undefined } as never;
}

async function request(
  handle: (request: never, response: never) => Promise<void>,
  method: string,
  path: string,
  body = '',
  headers: Record<string, string> = {},
): Promise<Readonly<{ status: number; body: string; headers: Record<string, unknown> }>> {
  const input = Readable.from(body ? [Buffer.from(body)] : []) as never as {
    method: string; url: string; headers: Record<string, string>;
  };
  input.method = method; input.url = path;
  input.headers = { ...(body ? { 'content-length': String(Buffer.byteLength(body)) } : {}),
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
  await handle(input as never, response as never);
  return Object.freeze({ status, body: output, headers: responseHeaders });
}

function signedForm(path: string, values: Record<string, string>): Readonly<{
  body: string; signature: string;
}> {
  const body = new URLSearchParams(values).toString();
  let data = `${ORIGIN}${path}`;
  for (const key of Object.keys(values).sort()) data += key + values[key];
  return Object.freeze({ body,
    signature: createHmac('sha1', TOKEN).update(data, 'utf8').digest('base64') });
}

test('webhook defaults disabled and rejects outbound key or database crossover', () => {
  assert.equal(loadTwilioSmsLiveWebhookConfig(darkEnv()).mode, 'disabled');
  for (const patch of [
    { DATABASE_WEB_URL: DATABASE_URL },
    { TWILIO_API_KEY_SECRET: 'outbound-worker-secret' },
    { SESSION_SECRET: 'unrelated-web-secret' },
  ]) assert.throws(() => loadTwilioSmsLiveWebhookConfig({ ...darkEnv(), ...patch }),
    /another database identity|unrelated secret/u);
  assert.equal(loadTwilioSmsLiveWebhookConfig(activeEnv()).mode, 'signed_live');
});

test('dark service proves readiness without constructing a recorder', async () => {
  const order: string[] = []; let recorders = 0;
  const runtime = await startTwilioSmsLiveWebhookService({ env: darkEnv(), listen: false,
    createPool: pool,
    assertSchemaCurrent: async () => { order.push('schema'); },
    assertInstallationReady: async (_pool, expected) => {
      assert.equal(expected, INSTALLATION); order.push('installation');
    },
    assertBoundaryReady: async () => { order.push('boundary'); },
    createRecorder: () => { recorders += 1; return {} as never; },
    writeReadiness: () => undefined,
  });
  assert.deepEqual(order, ['schema', 'installation', 'boundary']);
  assert.equal(recorders, 0);
  assert.equal(runtime.readiness.safety.outboundApiKeyPresent, false);
  assert.equal(runtime.readiness.safety.providerCallsMadeAtReadiness, false);
  assert.equal((await request(runtime.handle as never, 'POST',
    TWILIO_SMS_INBOUND_WEBHOOK_PATH)).status, 503);
  await runtime.shutdown();
});

test('signed raw inbound and status routes record exact evidence and send no automatic reply', async () => {
  const received: string[] = [];
  const runtime = await startTwilioSmsLiveWebhookService({ env: activeEnv(), listen: false,
    createPool: pool,
    assertSchemaCurrent: async () => undefined,
    assertInstallationReady: async () => undefined,
    assertBoundaryReady: async () => undefined,
    createRecorder: () => ({
      async recordInbound(input) {
        assert.equal(input.projection, 'conversion_inbox_and_lead360');
        assert.equal(input.event.optEvidence, 'stop');
        received.push(`inbound:${input.event.providerMessageId}`); return 'applied';
      },
      async recordStatus(input) {
        assert.equal(input.event.status, 'delivered');
        received.push(`status:${input.event.providerMessageId}`); return 'applied';
      },
    }),
    now: () => new Date('2026-08-29T10:00:00Z'), writeReadiness: () => undefined,
  });
  const inbound = signedForm(TWILIO_SMS_INBOUND_WEBHOOK_PATH, {
    AccountSid: ACCOUNT, MessageSid: MESSAGE, From: '+447700900123', Body: 'STOP',
  });
  const accepted = await request(runtime.handle as never, 'POST',
    TWILIO_SMS_INBOUND_WEBHOOK_PATH, inbound.body, {
      'content-type': 'application/x-www-form-urlencoded',
      'x-twilio-signature': inbound.signature,
    });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body, '<?xml version="1.0" encoding="UTF-8"?><Response/>');
  assert.match(String(accepted.headers['Content-Type']), /text\/xml/u);

  const status = signedForm(TWILIO_SMS_STATUS_WEBHOOK_PATH, {
    AccountSid: ACCOUNT, MessageSid: MESSAGE, MessageStatus: 'delivered',
  });
  assert.equal((await request(runtime.handle as never, 'POST', TWILIO_SMS_STATUS_WEBHOOK_PATH,
    status.body, { 'content-type': 'application/x-www-form-urlencoded',
      'x-twilio-signature': status.signature })).status, 200);
  assert.deepEqual(received, [`inbound:${MESSAGE}`, `status:${MESSAGE}`]);

  const mutated = await request(runtime.handle as never, 'POST',
    TWILIO_SMS_INBOUND_WEBHOOK_PATH, `${inbound.body}&OptOutType=START`, {
      'content-type': 'application/x-www-form-urlencoded',
      'x-twilio-signature': inbound.signature,
    });
  assert.equal(mutated.status, 401);
  await runtime.shutdown();
});
