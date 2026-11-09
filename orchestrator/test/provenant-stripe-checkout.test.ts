import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { StripeConfig } from '../src/server/config.js';
import type {
  BeginPaidCheckoutInput,
  VerifiedPaidCheckoutCompletion,
} from '../src/server/paid-checkout-pg-service.js';
import {
  createProvenantCheckoutSession,
  processProvenantCheckoutWebhook,
  ProvenantCheckoutError,
  type ProvenantStripeEvent,
  type ProvenantStripeLike,
  type RetrievedCheckoutSession,
} from '../src/server/provenant-stripe-checkout.js';

const IDS = {
  request: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  intent: '11111111-1111-4111-8111-111111111111',
  order: '22222222-2222-4222-8222-222222222222',
};
const ORDER_CLAIM = Buffer.alloc(32, 17).toString('base64url');

function config(overrides: Partial<StripeConfig> = {}): StripeConfig {
  return {
    secretKey: 'sk_test_x',
    keyMode: 'test',
    webhookSecret: 'whsec_test_x',
    priceIds: {
      autopsy: 'price_autopsy',
      core: 'price_core',
      core_bump: 'price_core_bump',
      pro: 'price_pro',
    },
    planIds: {},
    platformSubscriptionsEnabled: false,
    sandboxAccessToken: '',
    publicLeadCaptureEnabled: false,
    publicBaseUrl: 'https://relaunch72.test',
    host: '127.0.0.1',
    port: 4242,
    liveMode: false,
    dataDir: os.tmpdir(),
    ordersFile: path.join(os.tmpdir(), 'orders.jsonl'),
    subscriptionsFile: path.join(os.tmpdir(), 'subscriptions.jsonl'),
    allowedOrigins: [],
    adminPassword: '',
    sessionSecret: 'test-only-secret',
    ...overrides,
  };
}

function checkoutStripe(overrides: Partial<{
  createdSession: RetrievedCheckoutSession;
  retrievedSession: RetrievedCheckoutSession;
  event: ProvenantStripeEvent;
}> = {}): {
  stripe: ProvenantStripeLike;
  created: Array<{ params: Record<string, unknown>; options: { idempotencyKey: string } }>;
  retrieved: Array<{ sessionId: string; params?: Record<string, unknown> }>;
} {
  const created: Array<{ params: Record<string, unknown>; options: { idempotencyKey: string } }> = [];
  const retrieved: Array<{ sessionId: string; params?: Record<string, unknown> }> = [];
  const defaultSession: RetrievedCheckoutSession = {
    id: 'cs_test_paid_123',
    url: 'https://checkout.stripe.test/c/pay/cs_test_paid_123',
    livemode: false,
    client_reference_id: IDS.intent,
  };
  return {
    created,
    retrieved,
    stripe: {
      checkout: {
        sessions: {
          create: async (params, options) => {
            created.push({ params, options });
            return overrides.createdSession ?? defaultSession;
          },
          retrieve: async (sessionId, params) => {
            retrieved.push({ sessionId, params });
            return overrides.retrievedSession ?? overrides.createdSession ?? defaultSession;
          },
        },
      },
      webhooks: {
        constructEvent: () => overrides.event ?? { type: 'unconfigured.test.event' },
      },
    },
  };
}

test('checkout commits product authority first, uses stable Stripe idempotency, and never exposes the raw claim', async () => {
  const { stripe, created, retrieved } = checkoutStripe();
  const began: BeginPaidCheckoutInput[] = [];
  const bound: Array<readonly [string, string, string]> = [];
  const database = {
    begin: async (input: BeginPaidCheckoutInput) => {
      began.push(input);
      return {
        checkoutIntentId: IDS.intent,
        providerIdempotencyKey: 'stripe-checkout-intent-111',
        intentExpiresAt: '2035-01-01T01:00:00.000Z',
        stripeSessionId: null,
        createdNow: true,
      };
    },
    bindSession: async (intentId: string, providerKey: string, sessionId: string) => {
      bound.push([intentId, providerKey, sessionId]);
      return { checkoutIntentId: intentId, stripeSessionId: sessionId, boundNow: true };
    },
  };

  const result = await createProvenantCheckoutSession(stripe, database, config(), {
    tier: 'core',
    bump: true,
    requestIdempotencyKey: IDS.request,
    orderClaim: ORDER_CLAIM,
  }, () => Date.parse('2035-01-01T00:00:00.000Z'));

  assert.deepEqual(began, [{
    requestIdempotencyKey: IDS.request,
    orderClaim: ORDER_CLAIM,
    productKey: 'core_bump',
    expectedPriceId: 'price_core_bump',
    expectedAmountMinor: 114_400,
    expectedCurrency: 'usd',
    expectedLivemode: false,
  }]);
  assert.equal(created.length, 1);
  assert.equal(retrieved.length, 0);
  assert.equal(created[0]!.options.idempotencyKey, 'stripe-checkout-intent-111');
  assert.deepEqual(created[0]!.params.line_items, [{ price: 'price_core_bump', quantity: 1 }]);
  assert.equal(created[0]!.params.client_reference_id, IDS.intent);
  assert.deepEqual(created[0]!.params.metadata, {
    schema_version: '1',
    checkout_intent_id: IDS.intent,
  });
  const successUrl = String(created[0]!.params.success_url);
  assert.equal(successUrl, `https://relaunch72.test/intake/?intent=${IDS.intent}&session={CHECKOUT_SESSION_ID}`);
  assert.equal(successUrl.includes(ORDER_CLAIM), false);
  assert.equal(JSON.stringify(created).includes(ORDER_CLAIM), false);
  assert.deepEqual(bound, [[IDS.intent, 'stripe-checkout-intent-111', 'cs_test_paid_123']]);
  assert.equal(result.checkoutIntentId, IDS.intent);
  assert.equal(result.claimStorageKey, `r72:paid-order-claim:${IDS.intent}`);
  assert.equal(JSON.stringify(result).includes(ORDER_CLAIM), false);
  assert.equal(result.url.includes(ORDER_CLAIM), false);
});

test('an exact retry retrieves and rebinds the already-authorized Stripe Session', async () => {
  const retrievedSession: RetrievedCheckoutSession = {
    id: 'cs_test_existing_123',
    url: 'https://checkout.stripe.test/c/pay/cs_test_existing_123',
    livemode: false,
    client_reference_id: IDS.intent,
  };
  const { stripe, created, retrieved } = checkoutStripe({ retrievedSession });
  const bindings: string[][] = [];
  const result = await createProvenantCheckoutSession(stripe, {
    begin: async () => ({
      checkoutIntentId: IDS.intent,
      providerIdempotencyKey: 'stripe-checkout-intent-111',
      intentExpiresAt: '2035-01-01T01:00:00.000Z',
      stripeSessionId: 'cs_test_existing_123',
      createdNow: false,
    }),
    bindSession: async (...values: [string, string, string]) => {
      bindings.push(values);
      return { checkoutIntentId: values[0], stripeSessionId: values[2], boundNow: false };
    },
  }, config(), {
    tier: 'core',
    requestIdempotencyKey: IDS.request,
    orderClaim: ORDER_CLAIM,
  }, () => Date.parse('2035-01-01T00:00:00.000Z'));

  assert.equal(created.length, 0);
  assert.deepEqual(retrieved, [{ sessionId: 'cs_test_existing_123', params: undefined }]);
  assert.deepEqual(bindings, [[IDS.intent, 'stripe-checkout-intent-111', 'cs_test_existing_123']]);
  assert.equal(result.resumed, true);
});

test('invalid tier and bump combinations fail before database or Stripe work', async () => {
  let databaseCalls = 0;
  const { stripe, created, retrieved } = checkoutStripe();
  const database = {
    begin: async () => {
      databaseCalls += 1;
      throw new Error('must not begin');
    },
    bindSession: async () => {
      databaseCalls += 1;
      throw new Error('must not bind');
    },
  };
  const base = { requestIdempotencyKey: IDS.request, orderClaim: ORDER_CLAIM };

  for (const request of [
    { ...base, tier: 'enterprise' },
    { ...base, tier: 'core_bump' },
    { ...base, tier: 'pro', bump: true },
    { ...base, tier: 'autopsy', bump: true },
  ]) {
    await assert.rejects(
      () => createProvenantCheckoutSession(stripe, database, config(), request),
      ProvenantCheckoutError,
    );
  }
  assert.equal(databaseCalls, 0);
  assert.equal(created.length, 0);
  assert.equal(retrieved.length, 0);
});

test('webhook signature verification happens before Session retrieval or database recording', async () => {
  const trace: string[] = [];
  const raw = Buffer.from('{"not":"trusted-until-signed"}');
  const stripe: ProvenantStripeLike = {
    checkout: {
      sessions: {
        create: async () => { throw new Error('not used'); },
        retrieve: async () => {
          trace.push('retrieve');
          throw new Error('must not retrieve');
        },
      },
    },
    webhooks: {
      constructEvent: (payload, signature, secret) => {
        trace.push('signature');
        assert.equal(payload, raw);
        assert.equal(signature, 'bad-signature');
        assert.equal(secret, 'whsec_test_x');
        throw new Error('bad signature');
      },
    },
  };

  await assert.rejects(
    () => processProvenantCheckoutWebhook(stripe, {
      recordCompleted: async () => {
        trace.push('database');
        throw new Error('must not record');
      },
    }, config(), raw, 'bad-signature'),
    ProvenantCheckoutError,
  );
  assert.deepEqual(trace, ['signature']);
});

test('signed completion retrieves one exact line item and delegates every authenticated fact to PostgreSQL', async () => {
  const trace: string[] = [];
  const raw = Buffer.from('{"signed":"raw-payload"}');
  const event: ProvenantStripeEvent = {
    id: 'evt_paid_123',
    type: 'checkout.session.completed',
    created: 1_735_689_600,
    livemode: false,
    data: {
      object: {
        id: 'cs_test_paid_123',
        metadata: {
          schema_version: '1',
          checkout_intent_id: IDS.intent.toUpperCase(),
        },
      },
    },
  };
  const session: RetrievedCheckoutSession = {
    id: 'cs_test_paid_123',
    livemode: false,
    client_reference_id: IDS.intent.toUpperCase(),
    mode: 'payment',
    payment_status: 'paid',
    amount_total: 99_700,
    currency: 'usd',
    payment_intent: { id: 'pi_paid_123' },
    customer: 'cus_paid_123',
    customer_email: 'fallback@example.test',
    customer_details: { email: 'payer@example.test' },
    line_items: {
      has_more: false,
      data: [{ quantity: 1, price: { id: 'price_core' } }],
    },
  };
  let recorded: VerifiedPaidCheckoutCompletion | undefined;
  const stripe: ProvenantStripeLike = {
    checkout: {
      sessions: {
        create: async () => { throw new Error('not used'); },
        retrieve: async (sessionId, params) => {
          trace.push('retrieve');
          assert.equal(sessionId, 'cs_test_paid_123');
          assert.deepEqual(params, { expand: ['line_items.data.price'] });
          return session;
        },
      },
    },
    webhooks: {
      constructEvent: (payload, signature, secret) => {
        trace.push('signature');
        assert.equal(payload, raw);
        assert.equal(signature, 'valid-signature');
        assert.equal(secret, 'whsec_test_x');
        return event;
      },
    },
  };
  const result = await processProvenantCheckoutWebhook(stripe, {
    recordCompleted: async (input) => {
      trace.push('database');
      recorded = input;
      return { eventDisposition: 'processed', orderId: IDS.order, replayed: false };
    },
  }, config(), raw, 'valid-signature');

  assert.deepEqual(trace, ['signature', 'retrieve', 'database']);
  assert.ok(recorded);
  assert.equal(recorded.rawPayload, raw);
  assert.deepEqual(recorded, {
    eventId: 'evt_paid_123',
    eventType: 'checkout.session.completed',
    rawPayload: raw,
    providerCreatedAt: new Date(1_735_689_600_000),
    eventLivemode: false,
    sessionLivemode: false,
    reportedCheckoutIntentId: IDS.intent,
    clientReferenceIntentId: IDS.intent,
    metadataSchemaVersion: 1,
    stripeSessionId: 'cs_test_paid_123',
    sessionMode: 'payment',
    paymentStatus: 'paid',
    priceId: 'price_core',
    lineItemCount: 1,
    quantity: 1,
    amountTotal: 99_700,
    currency: 'usd',
    paymentIntentId: 'pi_paid_123',
    stripeCustomerId: 'cus_paid_123',
    receiptEmail: 'payer@example.test',
  });
  assert.deepEqual(result, { outcome: 'processed', orderId: IDS.order, replayed: false });
});

test('multi-line and malformed line-item shapes are never normalized into authority', async () => {
  const cases: Array<{
    name: string;
    lineItems: RetrievedCheckoutSession['line_items'];
    expectedCount: number | null;
  }> = [
    {
      name: 'multiple lines',
      lineItems: {
        has_more: false,
        data: [
          { quantity: 1, price: 'price_core' },
          { quantity: 1, price: 'price_extra' },
        ],
      },
      expectedCount: 2,
    },
    {
      name: 'truncated expansion',
      lineItems: { has_more: true, data: [{ quantity: 1, price: 'price_core' }] },
      expectedCount: null,
    },
    {
      name: 'malformed exact line',
      lineItems: { has_more: false, data: [{ quantity: 1.5, price: { id: ' ' } }] },
      expectedCount: 1,
    },
  ];

  for (const fixture of cases) {
    let databaseCalls = 0;
    const event: ProvenantStripeEvent = {
      id: `evt_${fixture.name.replace(/\s/g, '_')}`,
      type: 'checkout.session.completed',
      created: 1_735_689_600,
      livemode: false,
      data: { object: { id: 'cs_test_paid_123', metadata: {} } },
    };
    const session: RetrievedCheckoutSession = {
      id: 'cs_test_paid_123',
      livemode: false,
      client_reference_id: IDS.intent,
      mode: 'payment',
      payment_status: 'paid',
      amount_total: 99_700,
      currency: 'usd',
      customer_details: { email: 'payer@example.test' },
      line_items: fixture.lineItems,
    };
    const { stripe } = checkoutStripe({ event, retrievedSession: session });
    const result = await processProvenantCheckoutWebhook(stripe, {
      recordCompleted: async (input) => {
        databaseCalls += 1;
        assert.equal(input.lineItemCount, fixture.expectedCount, fixture.name);
        assert.equal(input.priceId, null, fixture.name);
        assert.equal(input.quantity, null, fixture.name);
        return { eventDisposition: 'rejected', orderId: null, replayed: false };
      },
    }, config(), Buffer.from(createHash('sha256').update(fixture.name).digest('hex')), 'valid');

    assert.equal(databaseCalls, 1, `${fixture.name} is delegated once to database reconciliation`);
    assert.deepEqual(result, { outcome: 'rejected', orderId: null, replayed: false });
  }
});
