import assert from 'node:assert/strict';
import test from 'node:test';
import { runSmsPhoneVerificationOnce } from '../src/sms-live-pg/phone-verification.js';
import { loadTwilioSmsWorkerConfig } from '../src/workers/twilio-sms-live/runner.js';
const WORKSPACE = '2789228d-55a6-4688-b1e8-2f70abca990b', CONNECTION = '13000000-0000-4000-8000-000000000021', CHALLENGE = '13000000-0000-4000-8000-000000000005';
test('separate MHP verification worker parses the display brand without enabling marketing', () => {
  const env = { NODE_ENV: 'production', DATABASE_SMS_WORKER_URL: 'postgres://r72_sms_worker_command:synthetic@localhost/isolated',
    PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID: '13000000-0000-4000-8000-000000000001',
    PROPERTY_PREDATOR_SMS_LIVE_MODE: 'disabled', PROPERTY_PREDATOR_SMS_DELIVERY_ENABLED: 'false', PROPERTY_PREDATOR_SMS_EMERGENCY_PAUSED: 'true',
    PROPERTY_PREDATOR_SMS_VERIFICATION_MODE: 'owned_number', PROPERTY_PREDATOR_SMS_VERIFICATION_ENABLED: 'true', PROPERTY_PREDATOR_SMS_VERIFICATION_PAUSED: 'false',
    PROPERTY_PREDATOR_SMS_LIVE_WORKSPACE_ID: WORKSPACE, PROPERTY_PREDATOR_SMS_LIVE_CONNECTION_ID: CONNECTION, PROPERTY_PREDATOR_SMS_VERIFY_TEST_NUMBER: '+447700900123',
    PROPERTY_PREDATOR_SMS_ACCOUNT_SID: `AC${'a'.repeat(32)}`, TWILIO_MESSAGING_SERVICE_SID: `MG${'b'.repeat(32)}`,
    TWILIO_KEY_SCOPE: 'restricted-api-key', TWILIO_API_KEY_SID: `SK${'c'.repeat(32)}`, TWILIO_API_KEY_SECRET: 'synthetic-restricted-key-secret',
    PROPERTY_PREDATOR_SMS_VERIFICATION_DISPLAY_BRAND: 'Martin Howard Property' };
  const config = loadTwilioSmsWorkerConfig(env); assert.equal(config.mode, 'verification_only');
  if (config.mode !== 'verification_only') throw Error('Wrong mode');
  assert.equal(config.verificationDisplayBrand, 'Martin Howard Property'); assert.equal(config.runtime.smsDeliveryEnabled, false);
  assert.throws(() => loadTwilioSmsWorkerConfig({ ...env, PROPERTY_PREDATOR_SMS_VERIFICATION_DISPLAY_BRAND: 'MHP\nInject' }), /display brand/u);
});
test('existing OTP handoff labels MHP, preserves one recipient and settles once', async () => {
  let sends = 0, settles = 0;
  const client = { async query(sql: string) {
    if (sql.includes('claim_sms_phone_challenge')) return { rows: [{ challengeId: CHALLENGE, phoneE164: '+447700900123' }] };
    if (sql.includes('arm_sms_phone_challenge')) return { rows: [{ applied: true }] };
    if (sql.includes('settle_sms_phone_challenge')) { settles++; return { rows: [{ applied: true }] }; }
    return { rows: [] };
  }, release() {} };
  const result = await runSmsPhoneVerificationOnce({ connect: async () => client } as never, { send: async (context, request) => {
    sends++; assert.equal(context.workspaceId, WORKSPACE); assert.equal(context.connectionId, CONNECTION);
    assert.equal(request.recipient, '+447700900123'); assert.match(request.body, /^Martin Howard Property verification code: \d{6}\. Expires in 10 minutes\.$/u);
    assert.equal(request.expectedSegmentCount, 1);
    return { status: 'accepted', externalId: `SM${'a'.repeat(32)}`, occurredAt: new Date().toISOString(), retryable: false, errorCode: null, summary: 'Synthetic accepted' };
  } }, { workspaceId: WORKSPACE, connectionId: CONNECTION, phone: '+447700900123', displayBrand: 'Martin Howard Property' });
  assert.equal(result, 'sent'); assert.deepEqual([sends, settles], [1, 1]);
});
