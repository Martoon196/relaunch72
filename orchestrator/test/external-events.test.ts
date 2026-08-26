import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import {
  PROPERTY_PREDATOR_EXTERNAL_EVENT_MAX_BODY_BYTES,
  PROPERTY_PREDATOR_EXTERNAL_EVENT_TYPES,
  PROPERTY_PREDATOR_REVIEWED_OUTBOX_EVENT_TYPES,
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
const PRESENTATION_EVENT_ID = '018f2a93-3b8e-72cc-9d32-eed1e2a5ed86';
const POLICY_TEXT_SHA256 = 'a'.repeat(64);
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
  'identity.account.created': {
    email: 'hunter@example.com', signupMethod: 'password', displayName: 'Hunter & Co',
  },
  'privacy.consent.updated': {
    purpose: 'property_predator_marketing', channel: 'email', state: 'granted', source: 'registration',
    email: 'hunter@example.com', policyVersion: '2026-08-25', policyTextSha256: POLICY_TEXT_SHA256,
  },
  'affiliate.referral.attributed': {
    affiliateId: AFFILIATE_ID, referralCode: 'martoon-72', model: 'last_click',
  },
  'product.analysis.completed': { toolKey: 'full_xray', accessMode: 'paid', unitsSpent: 2 },
  'content.consumption.progressed': {
    contentKey: 'academy:deal-analysis', contentVersion: '2026.08',
    title: 'Deal Analysis: A & B <Foundations>', medium: 'video',
    progressBasisPoints: 5_000, consumedSeconds: 420,
  },
  'content.consumption.completed': {
    contentKey: 'academy:deal-analysis', contentVersion: '2026.08',
    title: 'Deal Analysis: A & B <Foundations>', medium: 'video',
    progressBasisPoints: 10_000, consumedSeconds: 840,
  },
  'offer.presented': {
    offerKey: 'pro-investor:annual', offerVersion: '2026.08', productKey: 'pro_investor',
    label: 'Pro Investor — Annual <Launch>', price: { amountMinor: 99_000, currency: 'gbp' },
    placement: 'academy:completion',
  },
  'offer.responded': {
    presentationEventId: PRESENTATION_EVENT_ID, response: 'requested_contact',
  },
  'sales.appointment.booked': {
    appointmentId: 'apt_123', startsAt: '2026-08-26T10:30:00.000Z',
    bookingSource: 'self_serve_calendar', meetingKind: 'discovery',
  },
  'sales.presentation.completed': {
    appointmentId: 'apt_123', presentationKey: 'agency:partner-briefing',
    durationSeconds: 2_700, outcome: 'proposal_requested',
  },
  'commerce.purchase.completed': {
    provider: 'stripe', providerEventId: 'evt_123', checkoutSessionId: 'cs_123',
    productKey: 'pro_investor', billingKind: 'subscription', subscriptionId: 'sub_123',
    amountMinor: 9_900, currency: 'gbp',
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
  assert.strictEqual(
    PROPERTY_PREDATOR_REVIEWED_OUTBOX_EVENT_TYPES,
    PROPERTY_PREDATOR_EXTERNAL_EVENT_TYPES,
    'producer outbox and Growth HQ ingress must share one frozen catalogue',
  );
  for (const type of PROPERTY_PREDATOR_EXTERNAL_EVENT_TYPES) {
    const event = parsePropertyPredatorExternalEvent(envelope(type, EXAMPLES[type]!));
    assert.equal(event.type, type);
    assert.equal(event.version, 1);
    assert.equal(event.subject.id, ACCOUNT_ID);
    assert.ok(Object.isFrozen(event));
    assert.ok(Object.isFrozen(event.subject));
    assert.ok(Object.isFrozen(event.data));
    if (event.type === 'offer.presented') assert.ok(Object.isFrozen(event.data.price));
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
  assert.throws(() => parsePropertyPredatorExternalEvent(envelope('commerce.purchase.completed', {
    ...EXAMPLES['commerce.purchase.completed'], subscriptionId: undefined,
  })), /subscriptionId/);
  assert.throws(() => parsePropertyPredatorExternalEvent(envelope('commerce.purchase.completed', {
    ...EXAMPLES['commerce.purchase.completed'], billingKind: 'one_off',
  })), /subscriptionId/);
  const oneOff: Record<string, unknown> = { ...EXAMPLES['commerce.purchase.completed'], billingKind: 'one_off' };
  delete oneOff.subscriptionId;
  assert.equal(
    parsePropertyPredatorExternalEvent(envelope('commerce.purchase.completed', oneOff)).type,
    'commerce.purchase.completed',
  );
});

test('account display names and consent evidence are optional, safe and backwards compatible', () => {
  const displayName = 'Avery & <North> "Quoted" \\ Partners';
  const account = parsePropertyPredatorExternalEventBody(raw(envelope('identity.account.created', {
    email: 'avery@example.com', signupMethod: 'google', displayName,
  })));
  assert.equal(account.type, 'identity.account.created');
  assert.equal(account.data.displayName, displayName);

  const legacyAccount = parsePropertyPredatorExternalEvent(envelope('identity.account.created', {
    email: 'legacy@example.com', signupMethod: 'password',
  }));
  assert.equal(legacyAccount.type, 'identity.account.created');
  assert.ok(!Object.hasOwn(legacyAccount.data, 'displayName'));

  for (const displayName of [' padded', 'line\nbreak', 'x'.repeat(201), '']) {
    assert.throws(() => parsePropertyPredatorExternalEvent(envelope('identity.account.created', {
      email: 'avery@example.com', signupMethod: 'password', displayName,
    })), /displayName/);
  }

  for (const [state, source] of [
    ['denied', 'account_preferences'],
    ['withdrawn', 'unsubscribe'],
  ] as const) {
    const consent = parsePropertyPredatorExternalEvent(envelope('privacy.consent.updated', {
      purpose: 'property_predator_marketing', channel: 'email', state, source,
    }));
    assert.equal(consent.type, 'privacy.consent.updated');
    assert.equal(consent.data.state, state);
    assert.ok(!Object.hasOwn(consent.data, 'email'));
    assert.ok(!Object.hasOwn(consent.data, 'policyVersion'));
    assert.ok(!Object.hasOwn(consent.data, 'policyTextSha256'));
  }

  const consent = parsePropertyPredatorExternalEvent(envelope(
    'privacy.consent.updated',
    EXAMPLES['privacy.consent.updated']!,
  ));
  assert.equal(consent.type, 'privacy.consent.updated');
  assert.equal(consent.data.email, 'hunter@example.com');
  assert.equal(consent.data.policyVersion, '2026-08-25');
  assert.equal(consent.data.policyTextSha256, POLICY_TEXT_SHA256);

  for (const [field, value, pattern] of [
    ['email', 'Hunter@example.com', /canonical lowercase email/],
    ['policyVersion', '2026\n08', /control characters/],
    ['policyVersion', 'x'.repeat(101), /1 to 100 characters/],
    ['policyTextSha256', 'A'.repeat(64), /lowercase hexadecimal SHA-256/],
    ['policyTextSha256', 'a'.repeat(63), /lowercase hexadecimal SHA-256/],
  ] as const) {
    assert.throws(() => parsePropertyPredatorExternalEvent(envelope('privacy.consent.updated', {
      ...EXAMPLES['privacy.consent.updated'], [field]: value,
    })), pattern);
  }
});

test('content progress and completion use exact bounded evidence without an action field', () => {
  const progressed = EXAMPLES['content.consumption.progressed']!;
  for (const medium of ['video', 'audio', 'article', 'document', 'other']) {
    const event = parsePropertyPredatorExternalEvent(envelope('content.consumption.progressed', {
      ...progressed, medium,
    }));
    assert.equal(event.type, 'content.consumption.progressed');
    assert.equal(event.data.medium, medium);
  }

  for (const progressBasisPoints of [0, 10_000]) {
    const event = parsePropertyPredatorExternalEvent(envelope('content.consumption.progressed', {
      ...progressed, progressBasisPoints,
    }));
    assert.equal(event.type, 'content.consumption.progressed');
    assert.equal(event.data.progressBasisPoints, progressBasisPoints);
  }

  const contentKey = `a${'b'.repeat(149)}`;
  const contentVersion = 'v'.repeat(100);
  const title = 'T'.repeat(200);
  for (const consumedSeconds of [0, 2_147_483_647]) {
    const event = parsePropertyPredatorExternalEvent(envelope('content.consumption.progressed', {
      ...progressed, contentKey, contentVersion, title, consumedSeconds,
    }));
    assert.equal(event.type, 'content.consumption.progressed');
    assert.equal(event.data.contentKey.length, 150);
    assert.equal(event.data.contentVersion.length, 100);
    assert.equal(event.data.title.length, 200);
    assert.equal(event.data.consumedSeconds, consumedSeconds);
  }

  const completed = parsePropertyPredatorExternalEvent(envelope(
    'content.consumption.completed',
    EXAMPLES['content.consumption.completed']!,
  ));
  assert.equal(completed.type, 'content.consumption.completed');
  assert.equal(completed.data.progressBasisPoints, 10_000);

  for (const [field, value, pattern] of [
    ['contentKey', 'Academy:lesson', /safe lowercase key/],
    ['contentKey', `a${'b'.repeat(150)}`, /1 to 150 characters/],
    ['contentVersion', 'v'.repeat(101), /1 to 100 characters/],
    ['contentVersion', 'v1\nlatest', /control characters/],
    ['title', 'T'.repeat(201), /1 to 200 characters/],
    ['title', 'Unsafe\u0000title', /control characters/],
    ['medium', 'ebook', /medium is invalid/],
    ['progressBasisPoints', -1, /integer from 0 to 10000/],
    ['progressBasisPoints', 10_001, /integer from 0 to 10000/],
    ['progressBasisPoints', 50.5, /integer from 0 to 10000/],
    ['consumedSeconds', -1, /integer from 0 to 2147483647/],
    ['consumedSeconds', 2_147_483_648, /integer from 0 to 2147483647/],
    ['consumedSeconds', 1.5, /integer from 0 to 2147483647/],
  ] as const) {
    assert.throws(() => parsePropertyPredatorExternalEvent(envelope('content.consumption.progressed', {
      ...progressed, [field]: value,
    })), pattern);
  }
  assert.throws(() => parsePropertyPredatorExternalEvent(envelope('content.consumption.completed', {
    ...EXAMPLES['content.consumption.completed'], progressBasisPoints: 9_999,
  })), /must be 10000 for a completed content event/);
  assert.throws(() => parsePropertyPredatorExternalEvent(envelope('content.consumption.completed', {
    ...EXAMPLES['content.consumption.completed'], action: 'completed',
  })), /unsupported field: action/);
});

test('offer presentations have an exact frozen price and bounded display metadata', () => {
  const presented = EXAMPLES['offer.presented']!;
  const label = 'Investor & <Agency> "Launch"';
  const free = parsePropertyPredatorExternalEventBody(raw(envelope('offer.presented', {
    ...presented,
    offerKey: `a${'b'.repeat(149)}`,
    offerVersion: 'v'.repeat(100),
    productKey: `p${'r'.repeat(149)}`,
    label,
    price: { amountMinor: 0, currency: 'eur' },
    placement: `p${'l'.repeat(99)}`,
  })));
  assert.equal(free.type, 'offer.presented');
  assert.equal(free.data.label, label);
  assert.deepEqual(free.data.price, { amountMinor: 0, currency: 'eur' });
  assert.ok(Object.isFrozen(free.data.price));

  for (const [field, value, pattern] of [
    ['offerKey', 'Pro Annual', /safe lowercase key/],
    ['offerKey', `a${'b'.repeat(150)}`, /1 to 150 characters/],
    ['offerVersion', 'v'.repeat(101), /1 to 100 characters/],
    ['productKey', 'Pro', /safe lowercase key/],
    ['label', 'L'.repeat(201), /1 to 200 characters/],
    ['label', 'bad\ttitle', /control characters/],
    ['placement', 'Pricing Page', /safe lowercase key/],
    ['placement', `p${'l'.repeat(100)}`, /1 to 100 characters/],
  ] as const) {
    assert.throws(() => parsePropertyPredatorExternalEvent(envelope('offer.presented', {
      ...presented, [field]: value,
    })), pattern);
  }

  for (const [price, pattern] of [
    [null, /data.price must be an object/],
    [{ amountMinor: -1, currency: 'gbp' }, /integer from 0/],
    [{ amountMinor: 1.5, currency: 'gbp' }, /integer from 0/],
    [{ amountMinor: Number.MAX_SAFE_INTEGER + 1, currency: 'gbp' }, /integer from 0/],
    [{ amountMinor: 100, currency: 'GBP' }, /lowercase three-letter/],
    [{ amountMinor: 100, currency: 'gbp', taxMinor: 20 }, /unsupported field: taxMinor/],
  ] as const) {
    assert.throws(() => parsePropertyPredatorExternalEvent(envelope('offer.presented', {
      ...presented, price,
    })), pattern);
  }
});

test('offer responses reference one canonical presentation event and one supported response', () => {
  for (const response of ['accepted', 'declined', 'deferred', 'requested_contact']) {
    const event = parsePropertyPredatorExternalEvent(envelope('offer.responded', {
      presentationEventId: PRESENTATION_EVENT_ID, response,
    }));
    assert.equal(event.type, 'offer.responded');
    assert.equal(event.data.presentationEventId, PRESENTATION_EVENT_ID);
    assert.equal(event.data.response, response);
  }
  assert.throws(() => parsePropertyPredatorExternalEvent(envelope('offer.responded', {
    presentationEventId: PRESENTATION_EVENT_ID.toUpperCase(), response: 'accepted',
  })), /canonical lowercase UUID/);
  assert.throws(() => parsePropertyPredatorExternalEvent(envelope('offer.responded', {
    presentationEventId: PRESENTATION_EVENT_ID, response: 'presented',
  })), /response is invalid/);
  assert.throws(() => parsePropertyPredatorExternalEvent(envelope('offer.responded', {
    presentationEventId: PRESENTATION_EVENT_ID, response: 'accepted', offerKey: 'pro',
  })), /unsupported field: offerKey/);
});

test('agency appointment and presentation facts are exact and bounded', () => {
  for (const bookingSource of ['self_serve_calendar', 'team', 'partner_referral']) {
    const event = parsePropertyPredatorExternalEvent(envelope('sales.appointment.booked', {
      ...EXAMPLES['sales.appointment.booked'], bookingSource,
    }));
    assert.equal(event.type, 'sales.appointment.booked');
    assert.equal(event.data.bookingSource, bookingSource);
  }
  for (const meetingKind of ['discovery', 'strategy', 'partner']) {
    const event = parsePropertyPredatorExternalEvent(envelope('sales.appointment.booked', {
      ...EXAMPLES['sales.appointment.booked'], meetingKind,
    }));
    assert.equal(event.type, 'sales.appointment.booked');
    assert.equal(event.data.meetingKind, meetingKind);
  }
  for (const outcome of ['completed', 'follow_up_requested', 'proposal_requested']) {
    const event = parsePropertyPredatorExternalEvent(envelope('sales.presentation.completed', {
      ...EXAMPLES['sales.presentation.completed'], outcome,
    }));
    assert.equal(event.type, 'sales.presentation.completed');
    assert.equal(event.data.outcome, outcome);
  }

  assert.throws(() => parsePropertyPredatorExternalEvent(envelope('sales.appointment.booked', {
    ...EXAMPLES['sales.appointment.booked'], startsAt: '2026-08-26T10:30:00Z',
  })), /canonical RFC3339/);
  assert.throws(() => parsePropertyPredatorExternalEvent(envelope('sales.appointment.booked', {
    ...EXAMPLES['sales.appointment.booked'], appointmentId: 'bad appointment',
  })), /safe provider reference/);
  assert.throws(() => parsePropertyPredatorExternalEvent(envelope('sales.presentation.completed', {
    ...EXAMPLES['sales.presentation.completed'], presentationKey: 'Agency Briefing',
  })), /safe lowercase key/);
  assert.throws(() => parsePropertyPredatorExternalEvent(envelope('sales.presentation.completed', {
    ...EXAMPLES['sales.presentation.completed'], durationSeconds: 0,
  })), /integer from 1/);
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
