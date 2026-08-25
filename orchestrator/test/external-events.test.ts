import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import {
  PROPERTY_PREDATOR_EXTERNAL_EVENT_MAX_BODY_BYTES,
  PROPERTY_PREDATOR_EXTERNAL_EVENT_TYPES,
  PropertyPredatorExternalEventAuthenticationError,
  PropertyPredatorExternalEventBodyTooLargeError,
  PropertyPredatorExternalEventContractError,
  PropertyPredatorExternalEventSignatureConfigurationError,
  parsePropertyPredatorExternalEvent,
  parsePropertyPredatorExternalEventBody,
  verifyPropertyPredatorExternalEventSignature,
} from '../src/integrations/external-events/index.js';

const EVENT_ID = '0198e9dd-a56f-7000-8000-000000000001';
const CORRELATION_ID = '0198e9dd-a56f-7000-8000-000000000002';
const ACCOUNT_ID = '0d445877-f8cf-4d65-9640-258710a69375';
const AFFILIATE_ID = 'c4a8a965-fb4a-4a96-a469-7f29a48bf83c';
const KEY_ID = 'pp-growth-2026-01';
const NOW = 1_787_652_000;
const TIMESTAMP = String(NOW);
const SECRET = Buffer.from('2b8f4c6d8e0a1c3e5f7092a4c6e8f0b22b8f4c6d8e0a1c3e5f7092a4c6e8f0b2', 'hex');

function envelope(type: string, data: Record<string, unknown>): Record<string, unknown> {
  return {
    id: EVENT_ID,
    type,
    version: 1,
    occurredAt: '2026-08-25T12:00:00.000Z',
    correlationId: CORRELATION_ID,
    subject: { kind: 'account', id: ACCOUNT_ID },
    data,
  };
}

const EXAMPLES: Readonly<Record<string, Record<string, unknown>>> = Object.freeze({
  'identity.account.created': { email: 'hunter@example.com', signupMethod: 'password' },
  'privacy.consent.updated': {
    purpose: 'property_predator_marketing', channel: 'email', state: 'granted', source: 'registration',
  },
  'affiliate.referral.attributed': {
    affiliateId: AFFILIATE_ID, referralCode: 'martoon-72', model: 'last_click',
  },
  'product.analysis.completed': { toolKey: 'full_xray', accessMode: 'paid', unitsSpent: 2 },
  'commerce.purchase.completed': {
    provider: 'stripe', providerEventId: 'evt_123', checkoutSessionId: 'cs_123',
    productKey: 'pro_investor', billingKind: 'subscription', amountMinor: 9_900, currency: 'gbp',
  },
  'commerce.purchase.refunded': {
    provider: 'stripe', providerEventId: 'evt_refund_123', checkoutSessionId: 'cs_123',
    productKey: 'pro_investor', amountMinor: 9_900, currency: 'gbp', reasonCode: 'requested_by_customer',
  },
  'commerce.subscription.cancelled': {
    provider: 'stripe', providerEventId: 'evt_cancel_123', subscriptionId: 'sub_123',
    productKey: 'pro_investor', effectiveAt: '2026-09-25T12:00:00.000Z',
  },
});

function raw(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), 'utf8');
}

function sign(body: Uint8Array, timestamp = TIMESTAMP, secret: Uint8Array = SECRET): string {
  const digest = createHmac('sha256', Buffer.from(secret))
    .update(timestamp, 'ascii')
    .update('.', 'ascii')
    .update(body)
    .digest('hex');
  return `v1=${digest}`;
}

function verify(overrides: Partial<Parameters<typeof verifyPropertyPredatorExternalEventSignature>[0]> = {}) {
  const body = overrides.rawBody ?? raw(envelope('identity.account.created', EXAMPLES['identity.account.created']!));
  return verifyPropertyPredatorExternalEventSignature({
    rawBody: body,
    keyId: KEY_ID,
    timestamp: TIMESTAMP,
    signature: sign(body),
    expectedKeyId: KEY_ID,
    sharedSecret: SECRET,
    nowSeconds: NOW,
    ...overrides,
  });
}

test('the strict V1 catalogue parses every supported Property Predator event', () => {
  assert.deepEqual(PROPERTY_PREDATOR_EXTERNAL_EVENT_TYPES, Object.keys(EXAMPLES));
  for (const type of PROPERTY_PREDATOR_EXTERNAL_EVENT_TYPES) {
    const event = parsePropertyPredatorExternalEvent(envelope(type, EXAMPLES[type]!));
    assert.equal(event.type, type);
    assert.equal(event.version, 1);
    assert.equal(event.subject.id, ACCOUNT_ID);
    assert.ok(Object.isFrozen(event));
    assert.ok(Object.isFrozen(event.subject));
    assert.ok(Object.isFrozen(event.data));
  }
});

test('the contract rejects unknown versions, event types and every unsupported key', () => {
  const base = envelope('identity.account.created', EXAMPLES['identity.account.created']!);
  assert.throws(
    () => parsePropertyPredatorExternalEvent({ ...base, version: 2 }),
    PropertyPredatorExternalEventContractError,
  );
  assert.throws(
    () => parsePropertyPredatorExternalEvent({ ...base, type: 'commerce.checkout.started' }),
    /not supported/,
  );
  assert.throws(
    () => parsePropertyPredatorExternalEvent({ ...base, workspaceId: ACCOUNT_ID }),
    /unsupported field: workspaceId/,
  );
  assert.throws(
    () => parsePropertyPredatorExternalEvent({
      ...base,
      subject: { kind: 'account', id: ACCOUNT_ID, organizationId: ACCOUNT_ID },
    }),
    /unsupported field: organizationId/,
  );
  assert.throws(
    () => parsePropertyPredatorExternalEvent({
      ...base,
      data: { ...EXAMPLES['identity.account.created'], address: 'Do not ingest this' },
    }),
    /unsupported field: address/,
  );
  for (const type of PROPERTY_PREDATOR_EXTERNAL_EVENT_TYPES) {
    assert.throws(
      () => parsePropertyPredatorExternalEvent(envelope(type, {
        ...EXAMPLES[type],
        unexpected: true,
      })),
      /unsupported field: unexpected/,
    );
  }
});

test('event identities, times and bounded signal values must be canonical', () => {
  const base = envelope('identity.account.created', EXAMPLES['identity.account.created']!);
  assert.throws(() => parsePropertyPredatorExternalEvent({ ...base, id: EVENT_ID.toUpperCase() }), /canonical lowercase UUID/);
  assert.throws(() => parsePropertyPredatorExternalEvent({ ...base, occurredAt: '2026-08-25T12:00:00Z' }), /canonical RFC3339/);
  assert.throws(() => parsePropertyPredatorExternalEvent({
    ...base,
    data: { email: 'Hunter@example.com', signupMethod: 'password' },
  }), /canonical lowercase email/);
  assert.throws(() => parsePropertyPredatorExternalEvent(envelope('product.analysis.completed', {
    toolKey: 'Full X-Ray', accessMode: 'paid', unitsSpent: 1,
  })), /safe lowercase key/);
  assert.throws(() => parsePropertyPredatorExternalEvent(envelope('product.analysis.completed', {
    toolKey: 'full_xray', accessMode: 'paid', unitsSpent: 1_001,
  })), /integer from 0 to 1000/);
  assert.throws(() => parsePropertyPredatorExternalEvent(envelope('commerce.purchase.completed', {
    ...EXAMPLES['commerce.purchase.completed'], amountMinor: 0,
  })), /positive safe integer/);
  assert.throws(() => parsePropertyPredatorExternalEvent(envelope('commerce.purchase.completed', {
    ...EXAMPLES['commerce.purchase.completed'], currency: 'GBP',
  })), /lowercase three-letter/);
});

test('raw-body parsing enforces UTF-8 JSON and the 32 KiB boundary', () => {
  const valid = raw(envelope('identity.account.created', EXAMPLES['identity.account.created']!));
  assert.equal(parsePropertyPredatorExternalEventBody(valid).type, 'identity.account.created');
  const maximum = Buffer.concat([
    valid,
    Buffer.alloc(PROPERTY_PREDATOR_EXTERNAL_EVENT_MAX_BODY_BYTES - valid.byteLength, 0x20),
  ]);
  assert.equal(maximum.byteLength, PROPERTY_PREDATOR_EXTERNAL_EVENT_MAX_BODY_BYTES);
  assert.equal(parsePropertyPredatorExternalEventBody(maximum).type, 'identity.account.created');
  assert.throws(() => parsePropertyPredatorExternalEventBody(Buffer.alloc(0)), /must not be empty/);
  assert.throws(() => parsePropertyPredatorExternalEventBody(Buffer.from([0xff])), /valid UTF-8 JSON/);
  assert.throws(() => parsePropertyPredatorExternalEventBody(Buffer.from('{', 'utf8')), /valid UTF-8 JSON/);
  assert.throws(
    () => parsePropertyPredatorExternalEventBody(Buffer.alloc(PROPERTY_PREDATOR_EXTERNAL_EVENT_MAX_BODY_BYTES + 1)),
    PropertyPredatorExternalEventBodyTooLargeError,
  );
});

test('HMAC verification covers the timestamp and exact raw body bytes', () => {
  const compact = raw(envelope('identity.account.created', EXAMPLES['identity.account.created']!));
  const result = verify({ rawBody: compact, signature: sign(compact) });
  assert.deepEqual(result, { keyId: KEY_ID, timestampSeconds: NOW, signatureVersion: 'v1' });
  assert.ok(Object.isFrozen(result));

  const semanticallyEqualButDifferentBytes = Buffer.from(JSON.stringify(
    envelope('identity.account.created', EXAMPLES['identity.account.created']!),
    null,
    2,
  ));
  assert.throws(
    () => verify({ rawBody: semanticallyEqualButDifferentBytes, signature: sign(compact) }),
    PropertyPredatorExternalEventAuthenticationError,
  );
  const mutated = Buffer.from(compact);
  mutated[mutated.length - 2] = mutated[mutated.length - 2]! ^ 1;
  assert.throws(
    () => verify({ rawBody: mutated, signature: sign(compact) }),
    PropertyPredatorExternalEventAuthenticationError,
  );
});

test('signature verification enforces an exact key id and exact v1 header syntax', () => {
  for (const keyId of [`${KEY_ID} `, KEY_ID.toUpperCase(), 'other-key', '', 'bad/key']) {
    assert.throws(() => verify({ keyId }), PropertyPredatorExternalEventAuthenticationError);
  }
  const body = raw(envelope('identity.account.created', EXAMPLES['identity.account.created']!));
  const correct = sign(body);
  for (const signature of [` ${correct}`, `${correct} `, correct.toUpperCase(), `${correct},v1=${'0'.repeat(64)}`, 'v2=' + '0'.repeat(64), '']) {
    assert.throws(
      () => verify({ rawBody: body, signature }),
      PropertyPredatorExternalEventAuthenticationError,
    );
  }
});

test('signature timestamps accept the exact five-minute window and reject malformed or stale values', () => {
  for (const seconds of [NOW - 300, NOW, NOW + 300]) {
    const timestamp = String(seconds);
    const body = raw(envelope('identity.account.created', EXAMPLES['identity.account.created']!));
    assert.equal(verify({ rawBody: body, timestamp, signature: sign(body, timestamp) }).timestampSeconds, seconds);
  }
  for (const timestamp of [String(NOW - 301), String(NOW + 301), ` ${NOW}`, `${NOW}.0`, `0${NOW}`, 'not-a-time']) {
    const body = raw(envelope('identity.account.created', EXAMPLES['identity.account.created']!));
    assert.throws(
      () => verify({ rawBody: body, timestamp, signature: sign(body, timestamp) }),
      PropertyPredatorExternalEventAuthenticationError,
    );
  }
});

test('signature verification rejects oversized bodies before authentication work', () => {
  const maximum = Buffer.alloc(PROPERTY_PREDATOR_EXTERNAL_EVENT_MAX_BODY_BYTES, 0x61);
  assert.equal(verify({ rawBody: maximum, signature: sign(maximum) }).keyId, KEY_ID);
  const oversized = Buffer.alloc(PROPERTY_PREDATOR_EXTERNAL_EVENT_MAX_BODY_BYTES + 1, 0x61);
  assert.throws(
    () => verify({ rawBody: oversized, signature: sign(oversized) }),
    PropertyPredatorExternalEventBodyTooLargeError,
  );
});

test('invalid trusted signature configuration fails separately from request authentication', () => {
  assert.throws(
    () => verify({ expectedKeyId: 'bad/key' }),
    PropertyPredatorExternalEventSignatureConfigurationError,
  );
  assert.throws(
    () => verify({ sharedSecret: Buffer.alloc(31) }),
    PropertyPredatorExternalEventSignatureConfigurationError,
  );
  assert.throws(
    () => verify({ nowSeconds: 1.5 }),
    PropertyPredatorExternalEventSignatureConfigurationError,
  );
});
