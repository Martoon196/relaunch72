import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  loadTwilioSmsLiveRuntimeConfig,
  parseTwilioSmsInboundEvent,
  parseTwilioSmsStatusEvent,
  runTwilioSmsLiveOnce,
  twilioSmsSegmentCount,
  TwilioSmsLiveError,
  verifyTwilioSmsWebhook,
  type TwilioSmsLiveClaim,
  type TwilioSmsLiveMaterial,
  type TwilioSmsLiveRepository,
} from '../src/sms-live/foundation.js';
import type { ProviderOperationResult } from '../src/providers/contracts.js';

const IDS = Object.freeze({
  workspace: '11111111-1111-4111-8111-111111111111',
  connection: '22222222-2222-4222-8222-222222222222',
  job: '33333333-3333-4333-8333-333333333333',
  operation: '44444444-4444-4444-8444-444444444444',
  correlation: '55555555-5555-4555-8555-555555555555',
});
const ACCOUNT_SID = `AC${'1'.repeat(32)}`;
const MESSAGE_SID = `SM${'2'.repeat(32)}`;
const REQUEST_SHA = createHash('sha256').update('exact-sms-request').digest('hex');
const activeConfig = () => loadTwilioSmsLiveRuntimeConfig({
  PROPERTY_PREDATOR_SMS_LIVE_MODE: 'owned_number_live',
  PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED: 'true',
  PROPERTY_PREDATOR_SMS_DELIVERY_ENABLED: 'true',
  PROPERTY_PREDATOR_SMS_EMERGENCY_PAUSED: 'false',
  PROPERTY_PREDATOR_SMS_RECEIPTS_CONFIRMED: 'true',
  PROPERTY_PREDATOR_SMS_PROVIDER_ID: 'twilio_messaging',
  PROPERTY_PREDATOR_SMS_SENDER_NUMBER: '+447700900999',
});

test('SMS live defaults off and requires the complete exact activation tuple', () => {
  assert.deepEqual(loadTwilioSmsLiveRuntimeConfig({}), {
    mode: 'disabled', providerEffectsEnabled: false, smsDeliveryEnabled: false,
    emergencyPaused: true, receiptsConfirmed: false, senderNumber: null,
    maximumOperationsPerCycle: 1, maximumRecipientsPerJob: 1,
    dailySegmentCap: 10, monthlySegmentCap: 50,
  });
  assert.equal(activeConfig().mode, 'owned_number_live');
  for (const patch of [
    { PROPERTY_PREDATOR_SMS_DELIVERY_ENABLED: 'false' },
    { PROPERTY_PREDATOR_SMS_EMERGENCY_PAUSED: 'true' },
    { PROPERTY_PREDATOR_SMS_RECEIPTS_CONFIRMED: 'false' },
    { PROPERTY_PREDATOR_SMS_PROVIDER_ID: 'wrong' },
    { PROPERTY_PREDATOR_SMS_SENDER_NUMBER: '+15551234567' },
  ]) assert.throws(() => loadTwilioSmsLiveRuntimeConfig({
    PROPERTY_PREDATOR_SMS_LIVE_MODE: 'owned_number_live',
    PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED: 'true',
    PROPERTY_PREDATOR_SMS_DELIVERY_ENABLED: 'true',
    PROPERTY_PREDATOR_SMS_EMERGENCY_PAUSED: 'false',
    PROPERTY_PREDATOR_SMS_RECEIPTS_CONFIRMED: 'true',
    PROPERTY_PREDATOR_SMS_PROVIDER_ID: 'twilio_messaging',
    PROPERTY_PREDATOR_SMS_SENDER_NUMBER: '+447700900999',
    ...patch,
  }), TwilioSmsLiveError);
});

test('segment accounting is exact at GSM concatenation boundaries and rejects unsafe text', () => {
  assert.equal(twilioSmsSegmentCount('A'.repeat(160)), 1);
  assert.equal(twilioSmsSegmentCount('A'.repeat(161)), 2);
  assert.equal(twilioSmsSegmentCount('A'.repeat(306)), 2);
  assert.equal(twilioSmsSegmentCount('A'.repeat(307)), 3);
  assert.equal(twilioSmsSegmentCount('A'.repeat(1_530)), 10);
  for (const body of ['', '£', 'A'.repeat(1_531)]) {
    assert.throws(() => twilioSmsSegmentCount(body), TwilioSmsLiveError);
  }
});

test('Twilio signature verification matches an exact HMAC-SHA1 vector and rejects mutation', () => {
  const rawBody = Buffer.from(`MessageSid=${MESSAGE_SID}&From=%2B447700900123&Body=STOP&AccountSid=${ACCOUNT_SID}`);
  const input = {
    publicOrigin: 'https://hq.propertypredator.com',
    path: '/webhooks/twilio/sms/inbound',
    authToken: 'test-auth-token',
    rawBody,
    contentType: 'application/x-www-form-urlencoded',
    twilioSignature: 'qfxrRCDaI382OhEGVBMdQhzzHFw=',
  } as const;
  const verified = verifyTwilioSmsWebhook(input);
  assert.equal(verified.params.get('Body'), 'STOP');
  assert.match(verified.payloadSha256, /^[0-9a-f]{64}$/u);
  assert.throws(() => verifyTwilioSmsWebhook({ ...input,
    rawBody: Buffer.from(rawBody.toString().replace('STOP', 'START')),
  }), (error: unknown) => error instanceof TwilioSmsLiveError
    && error.code === 'signature_invalid');
});

test('signed inbound STOP/START evidence and status callbacks remain provider-bound', () => {
  const base = new Map([
    ['AccountSid', ACCOUNT_SID], ['MessageSid', MESSAGE_SID],
    ['From', '+447700900123'], ['Body', ' stop '],
  ]);
  const verified = { payloadSha256: 'a'.repeat(64), signatureSha256: 'b'.repeat(64), params: base };
  const stop = parseTwilioSmsInboundEvent(verified, ACCOUNT_SID);
  assert.equal(stop.optEvidence, 'stop');
  assert.equal(stop.normalizedSender, '447700900123');
  base.set('Body', 'UNSTOP');
  assert.equal(parseTwilioSmsInboundEvent(verified, ACCOUNT_SID).optEvidence, 'start');
  const statusParams = new Map([
    ['AccountSid', ACCOUNT_SID], ['MessageSid', MESSAGE_SID],
    ['MessageStatus', 'undelivered'], ['ErrorCode', '30007'],
  ]);
  assert.deepEqual(parseTwilioSmsStatusEvent({ ...verified, params: statusParams }, ACCOUNT_SID), {
    kind: 'status', externalEventId: `status:${MESSAGE_SID}:undelivered`,
    providerMessageId: MESSAGE_SID, status: 'undelivered', errorCode: '30007',
  });
  assert.throws(() => parseTwilioSmsInboundEvent(verified, `AC${'9'.repeat(32)}`),
    TwilioSmsLiveError);
});

class MemoryRepository implements TwilioSmsLiveRepository {
  readonly claim: TwilioSmsLiveClaim = Object.freeze({ workspaceId: IDS.workspace,
    connectionId: IDS.connection, jobId: IDS.job, leaseVersion: 1 });
  order: string[] = [];
  settlement: ProviderOperationResult | null = null;
  async claimOne(): Promise<TwilioSmsLiveClaim> { this.order.push('claim'); return this.claim; }
  async loadClaimed(): Promise<TwilioSmsLiveMaterial> {
    this.order.push('load');
    return Object.freeze({ ...this.claim, operationId: IDS.operation,
      correlationId: IDS.correlation, requestSha256: REQUEST_SHA,
      senderNumber: '+447700900999', recipient: '+447700900123', body: 'Exact approved SMS.',
      segmentCount: 1 });
  }
  async markCalling(): Promise<boolean> { this.order.push('calling'); return true; }
  async settle(input: TwilioSmsLiveClaim & Readonly<{
    leaseToken: Buffer; result: ProviderOperationResult; receiptSha256: string;
  }>): Promise<void> {
    assert.match(input.receiptSha256, /^[0-9a-f]{64}$/u);
    this.order.push('settled'); this.settlement = input.result;
  }
}

test('worker calls exactly one recipient only after the durable calling fence', async () => {
  const repository = new MemoryRepository();
  const outcome = await runTwilioSmsLiveOnce({ config: activeConfig(), repository,
    leaseToken: Buffer.alloc(32, 7), transport: {
      contract: 'propertypredator.twilio-sms-live/v1', providerId: 'twilio_messaging',
      async send(context, request) {
        repository.order.push('transport');
        assert.equal(context.idempotencyKey, REQUEST_SHA);
        assert.equal(request.recipient, '+447700900123');
        assert.equal(request.expectedSegmentCount, 1);
        return { status: 'accepted', externalId: MESSAGE_SID,
          occurredAt: '2026-08-29T10:00:00.000Z', retryable: false,
          errorCode: null, summary: 'Twilio accepted the SMS' };
      },
    } });
  assert.equal(outcome, 'settled');
  assert.deepEqual(repository.order, ['claim', 'load', 'calling', 'transport', 'settled']);
});

test('ambiguous provider failure is quarantined and never automatically retried', async () => {
  const repository = new MemoryRepository();
  const outcome = await runTwilioSmsLiveOnce({ config: activeConfig(), repository,
    leaseToken: Buffer.alloc(32, 8), now: () => new Date('2026-08-29T10:00:00Z'),
    transport: {
      contract: 'propertypredator.twilio-sms-live/v1', providerId: 'twilio_messaging',
      async send() { repository.order.push('transport'); throw new Error('socket closed'); },
    } });
  assert.equal(outcome, 'failed_or_attention');
  assert.equal(repository.settlement?.status, 'needs_attention');
  assert.equal(repository.settlement?.retryable, false);
  assert.equal(repository.settlement?.errorCode, 'twilio_sms_outcome_unknown');
});
