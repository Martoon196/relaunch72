import assert from 'node:assert/strict';
import test from 'node:test';
import { MHP_EVENT_SMS_WORKSPACE_ID, mhpEventSmsCodeBody, runMhpEventSmsCodeOnce } from '../src/sms-live-pg/event-sms-codes.js';
import { loadTwilioSmsWorkerConfig, startTwilioSmsLiveWorker } from '../src/workers/twilio-sms-live/runner.js';
import { TWILIO_SMS_LIVE_CONTRACT, TWILIO_SMS_PROVIDER_ID, twilioSmsSegmentCount } from '../src/sms-live/foundation.js';

const CONNECTION = '33333333-3333-4333-8333-333333333333';
const OPTIN = '55555555-5555-4555-8555-555555555555';
const PHONE = '+447700900123';
const SID = `SM${'a'.repeat(32)}`;

function fakePool(options: { claim?: boolean } = {}) {
  const seen = { claims: 0, arms: 0, settles: [] as unknown[][], code: '' };
  const client = {
    async query(sql: string, params?: readonly unknown[]) {
      if (sql.includes('mhp_event_sms_code_claim')) { seen.claims += 1; return { rows: options.claim === false ? [] : [{ optinId: OPTIN, phoneE164: PHONE }] }; }
      if (sql.includes('mhp_event_sms_code_arm')) { seen.arms += 1; seen.code = String(params?.[2]); return { rows: [{ applied: true }] }; }
      if (sql.includes('mhp_event_sms_code_settle')) { seen.settles.push([...(params ?? [])]); return { rows: [{ applied: true }] }; }
      return { rows: [] };
    },
    release() {},
  };
  return { pool: { connect: async () => client } as never, seen };
}
const accepted = { status: 'accepted' as const, externalId: SID, occurredAt: new Date().toISOString(), retryable: false, errorCode: null, summary: 'Accepted' };
const binding = { workspaceId: MHP_EVENT_SMS_WORKSPACE_ID, connectionId: CONNECTION };

test('the code text is one plain segment and carries no marketing', () => {
  const body = mhpEventSmsCodeBody('012345');
  assert.equal(twilioSmsSegmentCount(body), 1);
  assert.doesNotMatch(body, /https?:|webinar starts|book|offer/iu);
  assert.throws(() => mhpEventSmsCodeBody('12345'));
});

test('one opt-in gets one code, sent once, and the provider SID is settled', async () => {
  const { pool, seen } = fakePool();
  let sends = 0;
  const result = await runMhpEventSmsCodeOnce(pool, { async send(context, request) {
    sends += 1;
    assert.equal(context.workspaceId, MHP_EVENT_SMS_WORKSPACE_ID);
    assert.equal(request.recipient, PHONE);
    assert.equal(request.expectedSegmentCount, 1);
    assert.ok(request.body.includes(seen.code), 'the armed code is the texted code');
    assert.equal(request.idempotencySha256, context.idempotencyKey);
    return accepted;
  } }, binding);
  assert.equal(result, 'sent');
  assert.equal(sends, 1);
  assert.match(seen.code, /^[0-9]{6}$/u);
  assert.deepEqual(seen.settles, [[MHP_EVENT_SMS_WORKSPACE_ID, OPTIN, 'sent', SID]]);
});

test('an exception after the call settles as needs_attention and never resends', async () => {
  const { pool, seen } = fakePool();
  let sends = 0;
  const result = await runMhpEventSmsCodeOnce(pool, { async send() { sends += 1; throw new Error('socket hang up'); } }, binding);
  assert.equal(result, 'failed_or_attention');
  assert.equal(sends, 1);
  assert.deepEqual(seen.settles, [[MHP_EVENT_SMS_WORKSPACE_ID, OPTIN, 'needs_attention', null]]);
});

test('nothing pending means no arm, no call and no settlement', async () => {
  const { pool, seen } = fakePool({ claim: false });
  assert.equal(await runMhpEventSmsCodeOnce(pool, { async send() { throw new Error('must not call'); } }, binding), 'idle');
  assert.equal(seen.arms, 0);
  assert.equal(seen.settles.length, 0);
});

test('codes are refused outside the MHP workspace', async () => {
  const { pool } = fakePool();
  await assert.rejects(runMhpEventSmsCodeOnce(pool, { async send() { return accepted; } },
    { workspaceId: '22222222-2222-4222-8222-222222222222', connectionId: CONNECTION }), /binding is invalid/u);
});

function liveEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: 'production', DATABASE_SMS_WORKER_URL: 'postgresql://r72_sms_worker_command:secret@db.example/relaunch72?sslmode=require',
    PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID: '11111111-1111-4111-8111-111111111111',
    PROPERTY_PREDATOR_SMS_LIVE_MODE: 'owned_number_live', PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED: 'true',
    PROPERTY_PREDATOR_SMS_DELIVERY_ENABLED: 'true', PROPERTY_PREDATOR_SMS_EMERGENCY_PAUSED: 'false',
    PROPERTY_PREDATOR_SMS_RECEIPTS_CONFIRMED: 'true', PROPERTY_PREDATOR_SMS_PROVIDER_ID: 'twilio_messaging',
    PROPERTY_PREDATOR_SMS_SENDER_NUMBER: '+447861935832', PROPERTY_PREDATOR_SMS_ACCOUNT_SID: `AC${'1'.repeat(32)}`,
    PROPERTY_PREDATOR_SMS_LIVE_WORKSPACE_ID: MHP_EVENT_SMS_WORKSPACE_ID, PROPERTY_PREDATOR_SMS_LIVE_CONNECTION_ID: CONNECTION,
    TWILIO_KEY_SCOPE: 'restricted-api-key', TWILIO_API_KEY_SID: `SK${'2'.repeat(32)}`, TWILIO_API_KEY_SECRET: 'restricted-test-secret-123456',
    TWILIO_MESSAGING_SERVICE_SID: `MG${'3'.repeat(32)}`, ...extra };
}

test('the worker switch is off by default and refuses any other workspace or a dark worker', () => {
  const plain = loadTwilioSmsWorkerConfig(liveEnv());
  assert.equal(plain.mode, 'owned_number_live');
  assert.equal(plain.mode === 'owned_number_live' && plain.mhpEventCodes, false);
  const on = loadTwilioSmsWorkerConfig(liveEnv({ MHP_EVENT_SMS_CODES_ENABLED: 'true' }));
  assert.equal(on.mode === 'owned_number_live' && on.mhpEventCodes, true);
  assert.throws(() => loadTwilioSmsWorkerConfig(liveEnv({ MHP_EVENT_SMS_CODES_ENABLED: 'true',
    PROPERTY_PREDATOR_SMS_LIVE_WORKSPACE_ID: '22222222-2222-4222-8222-222222222222' })), /MHP workspace only/u);
  assert.throws(() => loadTwilioSmsWorkerConfig({ NODE_ENV: 'production', MHP_EVENT_SMS_CODES_ENABLED: 'true',
    DATABASE_SMS_WORKER_URL: 'postgresql://r72_sms_worker_command:secret@db.example/relaunch72?sslmode=require',
    PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID: '11111111-1111-4111-8111-111111111111', PROPERTY_PREDATOR_SMS_LIVE_MODE: 'disabled',
    PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED: 'false', PROPERTY_PREDATOR_SMS_DELIVERY_ENABLED: 'false', PROPERTY_PREDATOR_SMS_EMERGENCY_PAUSED: 'true' }),
  /owned-number live worker/u);
});

test('a live cycle sends a waiting code first and only then runs the marketing queue, one provider call per cycle', async () => {
  const { pool, seen } = fakePool();
  let claim = true, marketingClaims = 0;
  const realConnect = (pool as unknown as { connect: () => Promise<{ query: (sql: string, params?: readonly unknown[]) => Promise<unknown> }> }).connect;
  const wrapped = { connect: async () => {
    const client = await realConnect();
    return { ...client, query: async (sql: string, params?: readonly unknown[]) =>
      sql.includes('mhp_event_sms_code_claim') && !claim ? { rows: [] } : client.query(sql, params) };
  }, query: async () => ({ rows: [] }), end: async () => {} };
  const readiness: string[] = [];
  const runtime = await startTwilioSmsLiveWorker({ env: liveEnv({ MHP_EVENT_SMS_CODES_ENABLED: 'true', PROPERTY_PREDATOR_SMS_LIVE_POLL_MS: '60000' }),
    createPool: () => wrapped as never, assertSchemaCurrent: async () => {}, assertInstallationReady: async () => {}, assertBoundaryReady: async () => {},
    createRepository: () => ({ claimOne: async () => { marketingClaims += 1; return null; } }) as never,
    createTransport: () => ({ contract: TWILIO_SMS_LIVE_CONTRACT, providerId: TWILIO_SMS_PROVIDER_ID, send: async () => accepted }) as never,
    writeReadiness: line => readiness.push(line) });
  try {
    assert.equal(runtime.readiness.safety.mhpEventCodesEnabled, true);
    assert.equal(await runtime.runOnce(), 'settled');
    assert.equal(seen.settles.length, 1);
    assert.equal(marketingClaims, 0, 'the code used this cycle; marketing waits');
    claim = false;
    assert.equal(await runtime.runOnce(), 'idle');
    assert.equal(seen.settles.length, 1, 'no second code');
    assert.equal(marketingClaims, 1, 'with no code waiting, the marketing queue runs');
  } finally { await runtime.shutdown(); }
});
