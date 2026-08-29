import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  CustomerEmailLiveError,
  loadCustomerEmailLiveRuntimeConfig,
  runCustomerEmailLiveOnce,
  type CustomerEmailLiveClaim,
  type CustomerEmailLiveMaterial,
  type CustomerEmailLiveRepository,
} from '../src/customer-email-live/foundation.js';
import type { ProviderOperationResult } from '../src/providers/contracts.js';

const IDS = Object.freeze({
  workspace: '11111111-1111-4111-8111-111111111111',
  connection: '22222222-2222-4222-8222-222222222222',
  job: '33333333-3333-4333-8333-333333333333',
  operation: '44444444-4444-4444-8444-444444444444',
  correlation: '55555555-5555-4555-8555-555555555555',
});
const sha = createHash('sha256').update('exact-customer-request').digest('hex');
const config = () => loadCustomerEmailLiveRuntimeConfig({
  PROPERTY_PREDATOR_CUSTOMER_EMAIL_LIVE_MODE: 'customer_live',
  PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED: 'true',
  PROPERTY_PREDATOR_CUSTOMER_EMAIL_DELIVERY_ENABLED: 'true',
  PROPERTY_PREDATOR_CUSTOMER_EMAIL_EMERGENCY_PAUSED: 'false',
  PROPERTY_PREDATOR_CUSTOMER_EMAIL_PROVIDER_ID: 'mailgun_eu',
});

test('customer email runtime defaults OFF and requires the full exact switch tuple', () => {
  assert.deepEqual(loadCustomerEmailLiveRuntimeConfig({}), {
    mode: 'disabled', providerEffectsEnabled: false, emailDeliveryEnabled: false,
    emergencyPaused: true, maximumOperationsPerCycle: 1, maximumRecipientsPerJob: 1,
    dailySendCap: 10, monthlySendCap: 50,
  });
  for (const env of [
    { PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED: 'true' },
    { PROPERTY_PREDATOR_CUSTOMER_EMAIL_DELIVERY_ENABLED: 'true' },
    { PROPERTY_PREDATOR_CUSTOMER_EMAIL_EMERGENCY_PAUSED: 'false' },
    { PROPERTY_PREDATOR_CUSTOMER_EMAIL_LIVE_MODE: 'customer_live' },
  ]) assert.throws(() => loadCustomerEmailLiveRuntimeConfig(env), CustomerEmailLiveError);
  assert.equal(config().mode, 'customer_live');
});

class MemoryRepository implements CustomerEmailLiveRepository {
  readonly claim: CustomerEmailLiveClaim = Object.freeze({ workspaceId: IDS.workspace,
    connectionId: IDS.connection, jobId: IDS.job, leaseVersion: 1 });
  order: string[] = [];
  settlement: ProviderOperationResult | null = null;
  async claimOne(): Promise<CustomerEmailLiveClaim> { this.order.push('claim'); return this.claim; }
  async loadClaimed(): Promise<CustomerEmailLiveMaterial> {
    this.order.push('load');
    return Object.freeze({ ...this.claim, operationId: IDS.operation,
      correlationId: IDS.correlation, requestSha256: sha,
      expectedMessageId: `<pp-${sha}@mg.propertypredator.com>`,
      recipient: 'customer@example.com', subject: 'Your Property Predator update',
      text: 'The exact approved body.' });
  }
  async markCalling(): Promise<boolean> { this.order.push('calling'); return true; }
  async settle(input: CustomerEmailLiveClaim & Readonly<{
    leaseToken: Buffer; result: ProviderOperationResult; receiptSha256: string;
  }>): Promise<void> {
    assert.match(input.receiptSha256, /^[0-9a-f]{64}$/u);
    this.order.push('settled'); this.settlement = input.result;
  }
}

test('worker makes one exact-recipient call only after the durable calling fence', async () => {
  const repository = new MemoryRepository();
  let requestRecipients: readonly string[] = [];
  const outcome = await runCustomerEmailLiveOnce({ config: config(), repository,
    leaseToken: Buffer.alloc(32, 7), transport: { async send(context, request) {
      repository.order.push('transport');
      assert.equal(context.workspaceId, IDS.workspace);
      assert.equal(context.connectionId, IDS.connection);
      assert.equal(context.providerId, 'mailgun_eu');
      assert.equal(context.idempotencyKey, sha);
      requestRecipients = request.recipients;
      return { status: 'accepted', externalId: '<mailgun-id>', retryable: false,
        occurredAt: '2026-08-29T10:00:00.000Z', errorCode: null,
        summary: 'Mailgun accepted the customer email' };
    } } });
  assert.equal(outcome, 'settled');
  assert.deepEqual(requestRecipients, ['customer@example.com']);
  assert.deepEqual(repository.order, ['claim', 'load', 'calling', 'transport', 'settled']);
});

test('ambiguous provider exception is quarantined, non-retryable and still settled', async () => {
  const repository = new MemoryRepository();
  const outcome = await runCustomerEmailLiveOnce({ config: config(), repository,
    leaseToken: Buffer.alloc(32, 8), now: () => new Date('2026-08-29T10:00:00Z'),
    transport: { async send() { repository.order.push('transport'); throw new Error('socket closed'); } } });
  assert.equal(outcome, 'failed_or_attention');
  assert.equal(repository.settlement?.status, 'needs_attention');
  assert.equal(repository.settlement?.retryable, false);
  assert.equal(repository.settlement?.errorCode, 'mailgun_customer_outcome_unknown');
});

test('material must bind the expected Message-ID to the exact request digest', async () => {
  const repository = new MemoryRepository();
  repository.loadClaimed = async () => ({ ...repository.claim, operationId: IDS.operation,
    correlationId: IDS.correlation, requestSha256: sha,
    expectedMessageId: `<pp-${'0'.repeat(64)}@mg.propertypredator.com>`,
    recipient: 'customer@example.com', subject: 'Subject', text: 'Body' });
  await assert.rejects(() => runCustomerEmailLiveOnce({ config: config(), repository,
    leaseToken: Buffer.alloc(32, 9), transport: { async send() {
      throw new Error('must not call');
    } } }), (error: unknown) => error instanceof CustomerEmailLiveError
      && error.code === 'invalid_binding');
  assert.deepEqual(repository.order, ['claim']);
});
