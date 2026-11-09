import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { Pool } from 'pg';
import type { EncryptedSetupDelivery } from '../src/portal/setup-delivery-pg-service.js';
import {
  PaidCheckoutClaimError,
  PgPaidCheckoutService,
  type PaidPortalFulfilmentInput,
} from '../src/server/paid-checkout-pg-service.js';

const IDS = {
  request: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  intent: '11111111-1111-4111-8111-111111111111',
  order: '22222222-2222-4222-8222-222222222222',
  organization: '33333333-3333-4333-8333-333333333333',
  workspace: '44444444-4444-4444-8444-444444444444',
  user: '55555555-5555-4555-8555-555555555555',
  action: '66666666-6666-4666-8666-666666666666',
  delivery: '77777777-7777-4777-8777-777777777777',
};
const ORDER_CLAIM = Buffer.alloc(32, 17).toString('base64url');
const WRONG_ORDER_CLAIM = Buffer.alloc(32, 23).toString('base64url');
const ORDER_CLAIM_HASH = createHash('sha256').update(ORDER_CLAIM, 'ascii').digest();

type QueryCall = Readonly<{ text: string; values: readonly unknown[] }>;

function queryPool(
  handler: (text: string, values: readonly unknown[]) => Promise<{ rows: unknown[] }>,
): Pick<Pool, 'query'> {
  return {
    query: async (text: string, values?: unknown[]) => handler(text, values ?? []),
  } as unknown as Pick<Pool, 'query'>;
}

function unusedPool(): Pick<Pool, 'query'> {
  return queryPool(async () => ({ rows: [] }));
}

function unusedDelivery(): { prepare(recipientEmail: string): EncryptedSetupDelivery } {
  return {
    prepare: (_recipientEmail: string) => {
      throw new Error('setup delivery must not be prepared in this test');
    },
  };
}

function containsRawClaim(value: unknown): boolean {
  if (value === ORDER_CLAIM || value === WRONG_ORDER_CLAIM) return true;
  if (Array.isArray(value)) return value.some(containsRawClaim);
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) {
    return Object.values(value as Record<string, unknown>).some(containsRawClaim);
  }
  return false;
}

test('begin sends immutable product authority and only the exact claim hash to PostgreSQL', async () => {
  const calls: QueryCall[] = [];
  const checkoutCommandPool = queryPool(async (text, values) => {
    calls.push({ text, values });
    return { rows: [{
      checkout_intent_id: IDS.intent.toUpperCase(),
      provider_idempotency_key: 'stripe-checkout-intent-111',
      intent_expires_at: '2035-01-01T01:00:00.000Z',
      stripe_session_id: null,
      created_now: true,
    }] };
  });
  const service = new PgPaidCheckoutService({
    checkoutCommandPool,
    webhookCommandPool: unusedPool(),
    provisioningCommandPool: unusedPool(),
    setupDelivery: unusedDelivery(),
  });

  const result = await service.begin({
    requestIdempotencyKey: IDS.request,
    orderClaim: ORDER_CLAIM,
    productKey: 'core_bump',
    expectedPriceId: 'price_core_bump',
    expectedAmountMinor: 114_400,
    expectedCurrency: 'usd',
    expectedLivemode: false,
  });

  assert.equal(result.checkoutIntentId, IDS.intent);
  assert.equal(result.providerIdempotencyKey, 'stripe-checkout-intent-111');
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.text, /begin_one_off_checkout/);
  assert.deepEqual(calls[0]!.values.slice(0, 9), [
    IDS.request,
    'core_bump',
    1,
    'S9',
    true,
    'price_core_bump',
    114_400,
    'usd',
    false,
  ]);
  assert.deepEqual(calls[0]!.values[9], ORDER_CLAIM_HASH);
  assert.equal(calls[0]!.text.includes(ORDER_CLAIM), false);
  assert.equal(containsRawClaim(calls[0]!.values), false);
});

test('begin derives the restricted autopsy scope and rejects invalid product or claim before SQL', async () => {
  let queryCount = 0;
  const checkoutCommandPool = queryPool(async (_text, values) => {
    queryCount += 1;
    assert.deepEqual(values.slice(1, 5), ['autopsy', 1, 'S1', false]);
    return { rows: [{
      checkout_intent_id: IDS.intent,
      provider_idempotency_key: 'stripe-checkout-intent-111',
      intent_expires_at: '2035-01-01T01:00:00.000Z',
      stripe_session_id: null,
      created_now: true,
    }] };
  });
  const service = new PgPaidCheckoutService({
    checkoutCommandPool,
    webhookCommandPool: unusedPool(),
    provisioningCommandPool: unusedPool(),
    setupDelivery: unusedDelivery(),
  });
  const valid = {
    requestIdempotencyKey: IDS.request,
    orderClaim: ORDER_CLAIM,
    productKey: 'autopsy' as const,
    expectedPriceId: 'price_autopsy',
    expectedAmountMinor: 9_700,
    expectedCurrency: 'usd',
    expectedLivemode: false,
  };

  await service.begin(valid);
  await assert.rejects(
    () => service.begin({ ...valid, productKey: 'enterprise' as never }),
    /productKey is invalid/,
  );
  await assert.rejects(
    () => service.begin({ ...valid, orderClaim: 'not-a-claim' }),
    PaidCheckoutClaimError,
  );
  assert.equal(queryCount, 1);
});

test('recorded completion sends the payload digest and exact verified payment facts to PostgreSQL', async () => {
  const calls: QueryCall[] = [];
  const rawPayload = Buffer.from('{"signed":"stripe-event"}');
  const service = new PgPaidCheckoutService({
    checkoutCommandPool: unusedPool(),
    webhookCommandPool: queryPool(async (text, values) => {
      calls.push({ text, values });
      return { rows: [{ event_disposition: 'processed', order_id: IDS.order, replayed: false }] };
    }),
    provisioningCommandPool: unusedPool(),
    setupDelivery: unusedDelivery(),
  });

  const result = await service.recordCompleted({
    eventId: 'evt_paid_123',
    eventType: 'checkout.session.completed',
    rawPayload,
    providerCreatedAt: new Date('2025-01-01T00:00:00.000Z'),
    eventLivemode: false,
    sessionLivemode: false,
    reportedCheckoutIntentId: IDS.intent.toUpperCase(),
    clientReferenceIntentId: IDS.intent.toUpperCase(),
    metadataSchemaVersion: 1,
    stripeSessionId: 'cs_test_paid_123',
    sessionMode: 'payment',
    paymentStatus: 'paid',
    priceId: 'price_core',
    lineItemCount: 1,
    quantity: 1,
    amountTotal: 99_700,
    currency: 'USD',
    paymentIntentId: 'pi_paid_123',
    stripeCustomerId: 'cus_paid_123',
    receiptEmail: ' PAYER@Example.TEST ',
  });

  assert.deepEqual(result, { eventDisposition: 'processed', orderId: IDS.order, replayed: false });
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.text, /record_paid_checkout_completed/);
  assert.deepEqual(calls[0]!.values, [
    'evt_paid_123',
    'checkout.session.completed',
    createHash('sha256').update(rawPayload).digest(),
    '2025-01-01T00:00:00.000Z',
    false,
    false,
    IDS.intent,
    IDS.intent,
    1,
    'cs_test_paid_123',
    'payment',
    'paid',
    'price_core',
    1,
    1,
    99_700,
    'usd',
    'pi_paid_123',
    'cus_paid_123',
    'payer@example.test',
  ]);
  assert.equal(calls[0]!.values.includes(rawPayload), false, 'raw event bytes are not persisted as SQL parameters');
});

test('paid portal fulfilment trusts the database receipt email and passes only claim hash plus encrypted delivery', async () => {
  const calls: QueryCall[] = [];
  const preparedFor: string[] = [];
  const encrypted: EncryptedSetupDelivery = {
    deliveryId: IDS.delivery,
    setupTokenHash: Buffer.alloc(32, 1),
    recipientEmailHash: Buffer.alloc(32, 2),
    payloadVersion: 1,
    encryptionKeyId: 'setup-key-v1',
    encryptionIv: Buffer.alloc(12, 3),
    encryptedPayload: Buffer.from('ciphertext-without-a-token'),
    authenticationTag: Buffer.alloc(16, 4),
  };
  const provisioningCommandPool = queryPool(async (text, values) => {
    calls.push({ text, values });
    if (text.includes('authorize_paid_portal_fulfilment')) {
      return { rows: [{
        order_id: IDS.order,
        product_key: 'core',
        receipt_email: 'payer@example.test',
        fulfilment_status: 'awaiting_intake',
        organization_id: null,
        workspace_id: null,
        owner_user_id: null,
        setup_action_token_id: null,
        setup_delivery_id: null,
      }] };
    }
    assert.match(text, /fulfil_paid_portal_checkout_with_setup_delivery/);
    return { rows: [{
      organization_id: IDS.organization,
      workspace_id: IDS.workspace,
      owner_user_id: IDS.user,
      setup_action_token_id: IDS.action,
      setup_expires_at: '2035-01-02T00:00:00.000Z',
      setup_delivery_id: IDS.delivery,
      setup_delivery_generation: 1,
      created_now: true,
    }] };
  });
  const service = new PgPaidCheckoutService({
    checkoutCommandPool: unusedPool(),
    webhookCommandPool: unusedPool(),
    provisioningCommandPool,
    setupDelivery: {
      prepare: (recipientEmail: string) => {
        preparedFor.push(recipientEmail);
        return encrypted;
      },
    },
  });
  const untrustedInput = {
    stripeSessionId: 'cs_test_paid_123',
    orderClaim: ORDER_CLAIM,
    organizationName: 'Acme Property',
    workspaceName: 'Acme Growth',
    ownerDisplayName: 'Alex Owner',
    receiptEmail: 'attacker@example.test',
  } as PaidPortalFulfilmentInput & { receiptEmail: string };

  const result = await service.fulfilPaidPortal(untrustedInput);

  assert.deepEqual(preparedFor, ['payer@example.test']);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0]!.values, ['cs_test_paid_123', ORDER_CLAIM_HASH]);
  assert.deepEqual(calls[1]!.values.slice(0, 2), ['cs_test_paid_123', ORDER_CLAIM_HASH]);
  assert.deepEqual(calls[1]!.values.slice(6), [
    'Alex Owner',
    encrypted.setupTokenHash,
    encrypted.recipientEmailHash,
    'Europe/London',
    'en-GB',
    'GBP',
    encrypted.deliveryId,
    encrypted.payloadVersion,
    encrypted.encryptionKeyId,
    encrypted.encryptionIv,
    encrypted.encryptedPayload,
    encrypted.authenticationTag,
  ]);
  assert.equal(calls.every((call) => !call.text.includes(ORDER_CLAIM)), true);
  assert.equal(calls.every((call) => !containsRawClaim(call.values)), true);
  assert.equal(calls.flatMap((call) => [...call.values]).includes('attacker@example.test'), false);
  assert.deepEqual(result, {
    organizationId: IDS.organization,
    workspaceId: IDS.workspace,
    ownerUserId: IDS.user,
    setupActionTokenId: IDS.action,
    setupExpiresAt: '2035-01-02T00:00:00.000Z',
    setupDeliveryId: IDS.delivery,
    setupDeliveryGeneration: 1,
    createdNow: true,
  });
});

test('wrong, unavailable, or already-consumed paid claims fail closed', async () => {
  let prepared = 0;
  let queries = 0;
  const service = new PgPaidCheckoutService({
    checkoutCommandPool: unusedPool(),
    webhookCommandPool: unusedPool(),
    provisioningCommandPool: queryPool(async () => {
      queries += 1;
      return { rows: [] };
    }),
    setupDelivery: {
      prepare: (_recipientEmail: string) => {
        prepared += 1;
        throw new Error('must not prepare a delivery for an unauthorized claim');
      },
    },
  });
  const input: PaidPortalFulfilmentInput = {
    stripeSessionId: 'cs_test_paid_123',
    orderClaim: WRONG_ORDER_CLAIM,
    organizationName: 'Acme Property',
  };

  await assert.rejects(() => service.fulfilPaidPortal(input), PaidCheckoutClaimError);
  assert.equal(queries, 1, 'a structurally valid but wrong claim is decided by PostgreSQL');
  assert.equal(prepared, 0);

  await assert.rejects(
    () => service.fulfilPaidPortal({ ...input, orderClaim: 'wrong' }),
    PaidCheckoutClaimError,
  );
  assert.equal(queries, 1, 'a malformed claim never reaches PostgreSQL');
  assert.equal(prepared, 0);
});

test('a zero-row final atomic fulfilment result also fails closed', async () => {
  let queryCount = 0;
  const encrypted: EncryptedSetupDelivery = {
    deliveryId: IDS.delivery,
    setupTokenHash: Buffer.alloc(32, 1),
    recipientEmailHash: Buffer.alloc(32, 2),
    payloadVersion: 1,
    encryptionKeyId: 'setup-key-v1',
    encryptionIv: Buffer.alloc(12, 3),
    encryptedPayload: Buffer.from('ciphertext'),
    authenticationTag: Buffer.alloc(16, 4),
  };
  const service = new PgPaidCheckoutService({
    checkoutCommandPool: unusedPool(),
    webhookCommandPool: unusedPool(),
    provisioningCommandPool: queryPool(async (text) => {
      queryCount += 1;
      if (text.includes('authorize_paid_portal_fulfilment')) {
        return { rows: [{
          order_id: IDS.order,
          product_key: 'pro',
          receipt_email: 'payer@example.test',
          fulfilment_status: 'awaiting_intake',
          organization_id: null,
          workspace_id: null,
          owner_user_id: null,
          setup_action_token_id: null,
          setup_delivery_id: null,
        }] };
      }
      return { rows: [] };
    }),
    setupDelivery: { prepare: () => encrypted },
  });

  await assert.rejects(() => service.fulfilPaidPortal({
    stripeSessionId: 'cs_test_paid_123',
    orderClaim: ORDER_CLAIM,
    organizationName: 'Acme Property',
  }), PaidCheckoutClaimError);
  assert.equal(queryCount, 2);
});
