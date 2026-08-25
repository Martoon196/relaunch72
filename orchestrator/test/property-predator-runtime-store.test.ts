import assert from 'node:assert/strict';
import test from 'node:test';
import { PropertyPredatorRuntimeEventStore } from '../src/integrations/external-events/index.js';

const EVENT_ID = '0198e9dd-a56f-7000-8000-000000000001';
const CORRELATION_ID = '0198e9dd-a56f-7000-8000-000000000002';
const ACCOUNT_ID = '0d445877-f8cf-4d65-9640-258710a69375';

function input(type: string, data: Record<string, unknown>) {
  return {
    rawBody: Buffer.from(JSON.stringify({
      id: EVENT_ID,
      type,
      version: 1,
      occurredAt: '2026-08-25T12:00:00.000Z',
      correlationId: CORRELATION_ID,
      subject: { kind: 'account', id: ACCOUNT_ID },
      data,
    })),
    verifiedSignature: Object.freeze({
      keyId: 'pp-growth-2026-01',
      timestampSeconds: 1_787_652_000,
      signatureVersion: 'v1' as const,
    }),
  };
}

const ACCOUNT_DATA = Object.freeze({
  email: 'hunter@example.com', signupMethod: 'password',
});

function dependencies(overrides: Partial<{
  receiptReplayed: boolean;
  growthReplayed: boolean;
  journeyReplayed: boolean;
  failAt: 'receipt' | 'growth' | 'journey';
}> = {}) {
  const calls: string[] = [];
  const failure = new Error('runtime unavailable');
  return {
    calls,
    failure,
    value: {
      receiptStore: {
        record: async () => {
          calls.push('receipt');
          if (overrides.failAt === 'receipt') throw failure;
          return { disposition: 'shadow' as const, replayed: overrides.receiptReplayed ?? false };
        },
      },
      growthProjector: {
        project: async (eventId: string) => {
          calls.push(`growth:${eventId}`);
          if (overrides.failAt === 'growth') throw failure;
          return { disposition: 'projected' as const, replayed: overrides.growthReplayed ?? false };
        },
      },
      journeyRuntime: {
        project: async (eventId: string) => {
          calls.push(`journey:${eventId}`);
          if (overrides.failAt === 'journey') throw failure;
          return { disposition: 'projected' as const, replayed: overrides.journeyReplayed ?? false };
        },
      },
    },
  };
}

test('runtime store records, projects Growth evidence, then projects the journey', async () => {
  const deps = dependencies();
  const store = new PropertyPredatorRuntimeEventStore(deps.value);
  const result = await store.record(input('identity.account.created', ACCOUNT_DATA));

  assert.deepEqual(deps.calls, ['receipt', `growth:${EVENT_ID}`, `journey:${EVENT_ID}`]);
  assert.deepEqual(result, { disposition: 'projected', replayed: false });
  assert.ok(Object.isFrozen(result));
});

test('sales, consent and commerce events skip the evidence-only projector', async () => {
  const examples = [
    ['privacy.consent.updated', {
      purpose: 'property_predator_marketing', channel: 'email', state: 'granted', source: 'registration',
    }],
    ['sales.appointment.booked', {
      appointmentId: 'apt_123', startsAt: '2026-08-26T10:30:00.000Z',
      bookingSource: 'team', meetingKind: 'discovery',
    }],
    ['commerce.purchase.completed', {
      provider: 'stripe', providerEventId: 'evt_123', checkoutSessionId: 'cs_123',
      productKey: 'pro_investor', billingKind: 'subscription', subscriptionId: 'sub_123',
      amountMinor: 9_900, currency: 'gbp',
    }],
  ] as const;
  for (const [type, data] of examples) {
    const deps = dependencies();
    const store = new PropertyPredatorRuntimeEventStore(deps.value);
    await store.record(input(type, data));
    assert.deepEqual(deps.calls, ['receipt', `journey:${EVENT_ID}`]);
  }
});

test('only a complete replay reports replayed', async () => {
  for (const values of [
    { receiptReplayed: false, growthReplayed: true, journeyReplayed: true },
    { receiptReplayed: true, growthReplayed: false, journeyReplayed: true },
    { receiptReplayed: true, growthReplayed: true, journeyReplayed: false },
  ]) {
    const deps = dependencies(values);
    const result = await new PropertyPredatorRuntimeEventStore(deps.value)
      .record(input('identity.account.created', ACCOUNT_DATA));
    assert.equal(result.replayed, false);
  }
  const deps = dependencies({ receiptReplayed: true, growthReplayed: true, journeyReplayed: true });
  const result = await new PropertyPredatorRuntimeEventStore(deps.value)
    .record(input('identity.account.created', ACCOUNT_DATA));
  assert.equal(result.replayed, true);
});

test('an interrupted pipeline fails and leaves later stages for an exact retry', async () => {
  for (const [failAt, expectedCalls] of [
    ['receipt', ['receipt']],
    ['growth', ['receipt', `growth:${EVENT_ID}`]],
    ['journey', ['receipt', `growth:${EVENT_ID}`, `journey:${EVENT_ID}`]],
  ] as const) {
    const deps = dependencies({ failAt });
    await assert.rejects(
      new PropertyPredatorRuntimeEventStore(deps.value)
        .record(input('identity.account.created', ACCOUNT_DATA)),
      deps.failure,
    );
    assert.deepEqual(deps.calls, expectedCalls);
  }
});

test('invalid raw contracts fail before any persistence or projection call', async () => {
  const deps = dependencies();
  const store = new PropertyPredatorRuntimeEventStore(deps.value);
  await assert.rejects(store.record({
    ...input('identity.account.created', ACCOUNT_DATA),
    rawBody: Buffer.from('{'),
  }), /valid UTF-8 JSON/);
  assert.deepEqual(deps.calls, []);
});
