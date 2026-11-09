import assert from 'node:assert/strict';
import test from 'node:test';
import { runSmsPhoneVerificationOnce } from '../src/sms-live-pg/phone-verification.js';
import { loadTwilioSmsWorkerConfig } from '../src/workers/twilio-sms-live/runner.js';

const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const CONNECTION = '33333333-3333-4333-8333-333333333333';
const CHALLENGE = '44444444-4444-4444-8444-444444444444';
const PHONE = '+447510243096';

test('verification mode admits only an exact owned-number binding with marketing dispatch off', () => {
  const env = {
    NODE_ENV: 'production',
    DATABASE_SMS_WORKER_URL: 'postgresql://r72_sms_worker_command:secret@db.example/relaunch72',
    PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID: '11111111-1111-4111-8111-111111111111',
    PROPERTY_PREDATOR_SMS_LIVE_MODE: 'disabled',
    PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED: 'false',
    PROPERTY_PREDATOR_SMS_DELIVERY_ENABLED: 'false',
    PROPERTY_PREDATOR_SMS_EMERGENCY_PAUSED: 'true',
    PROPERTY_PREDATOR_SMS_VERIFICATION_MODE: 'owned_number',
    PROPERTY_PREDATOR_SMS_VERIFICATION_ENABLED: 'true',
    PROPERTY_PREDATOR_SMS_VERIFICATION_PAUSED: 'false',
    PROPERTY_PREDATOR_SMS_LIVE_WORKSPACE_ID: WORKSPACE,
    PROPERTY_PREDATOR_SMS_LIVE_CONNECTION_ID: CONNECTION,
    PROPERTY_PREDATOR_SMS_VERIFY_TEST_NUMBER: PHONE,
    PROPERTY_PREDATOR_SMS_ACCOUNT_SID: `AC${'1'.repeat(32)}`,
    TWILIO_MESSAGING_SERVICE_SID: `MG${'2'.repeat(32)}`,
    TWILIO_KEY_SCOPE: 'restricted-api-key',
    TWILIO_API_KEY_SID: `SK${'3'.repeat(32)}`,
    TWILIO_API_KEY_SECRET: 'restricted-test-secret-123456',
  };
  const config = loadTwilioSmsWorkerConfig(env);
  assert.equal(config.mode, 'verification_only');
  assert.equal(config.runtime.smsDeliveryEnabled, false);
  assert.throws(() => loadTwilioSmsWorkerConfig({ ...env,
    PROPERTY_PREDATOR_SMS_VERIFICATION_PAUSED: 'true' }), /explicit enabled/u);
  assert.throws(() => loadTwilioSmsWorkerConfig({ ...env,
    PROPERTY_PREDATOR_SMS_VERIFY_TEST_NUMBER: '+15551234567' }), /exact owned/u);
  assert.throws(() => loadTwilioSmsWorkerConfig({ ...env,
    PROPERTY_PREDATOR_SMS_LIVE_MODE: 'owned_number_live' }), /invalid_configuration|isolated/u);
});

test('one challenge sends one code and settles the accepted provider SID', async () => {
  let claims = 0; let arms = 0; let settles = 0; let sends = 0;
  const client = {
    async query(sql: string, params?: readonly unknown[]) {
      if (sql.includes('claim_sms_phone_challenge')) {
        claims += 1;
        return { rows: [{ challengeId: CHALLENGE, phoneE164: PHONE }] };
      }
      if (sql.includes('arm_sms_phone_challenge')) {
        arms += 1;
        assert.match(String(params?.[2]), /^[0-9]{6}$/u);
        return { rows: [{ applied: true }] };
      }
      if (sql.includes('settle_sms_phone_challenge')) {
        settles += 1;
        assert.equal(params?.[2], 'sent');
        assert.equal(params?.[3], `SM${'a'.repeat(32)}`);
        return { rows: [{ applied: true }] };
      }
      return { rows: [] };
    },
    release() {},
  };
  const result = await runSmsPhoneVerificationOnce({ connect: async () => client } as never,
    {
      async send(context, request) {
        sends += 1;
        assert.equal(context.connectionId, CONNECTION);
        assert.equal(request.recipient, PHONE);
        assert.match(request.body, /^Property Predator verification code: [0-9]{6}/u);
        assert.equal(request.expectedSegmentCount, 1);
        assert.equal(request.idempotencySha256, context.idempotencyKey);
        return { status: 'accepted' as const, externalId: `SM${'a'.repeat(32)}`,
          occurredAt: new Date().toISOString(), retryable: false,
          errorCode: null, summary: 'Accepted' };
      },
    }, { workspaceId: WORKSPACE, connectionId: CONNECTION, phone: PHONE });
  assert.equal(result, 'sent');
  assert.deepEqual([claims, arms, sends, settles], [1, 1, 1, 1]);
});
