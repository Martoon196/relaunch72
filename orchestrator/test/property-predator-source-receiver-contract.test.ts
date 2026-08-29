/**
 * Cross-repository contract: the Property Predator worker's exact delivery
 * against this receiver's validation and receipts.
 *
 * The envelope below is built the way the source dispatcher builds it, from its
 * published contract rather than by importing it: the two repositories deploy
 * independently, so a shared import would hide exactly the drift this test
 * exists to catch. The source contract is:
 *
 *   X-R72-Key-Id:     <dedicated source key id>
 *   X-R72-Timestamp:  <unix seconds>
 *   X-R72-Signature:  v1=<HMAC-SHA256(secret, timestamp + "." + raw-body)>
 *
 * and the source accepts exactly one receipt shape: `{accepted, disposition,
 * replayed}` with 202 meaning fresh and 200 meaning replayed. Each of those
 * rules is asserted here against what this receiver actually returns.
 */

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import test from 'node:test';
import {
  PROPERTY_PREDATOR_EXTERNAL_EVENT_PATH,
  PropertyPredatorExternalEventReceiptConflictError,
  createPropertyPredatorExternalEventHandler,
  parsePropertyPredatorExternalEventBody,
  type PropertyPredatorExternalEventShadowRecordInput,
} from '../src/integrations/external-events/index.js';
import { PROPERTY_PREDATOR_EXTERNAL_EVENT_MAX_BODY_BYTES } from '../src/integrations/external-events/contracts.js';
import { PropertyPredatorExternalEventContractError } from '../src/integrations/external-events/contracts.js';

const KEY_ID = 'pp-growth-2026-01';
const SECRET = Buffer.alloc(32, 0x27);
const OTHER_SECRET = Buffer.alloc(32, 0x28);

/** The source's own catalogue name for the only wired producer today. */
const ACCOUNT_CREATED = 'identity.account.created';

/** Statuses the source treats as permanent, and the reason each is permanent. */
const SOURCE_PERMANENT: readonly (readonly [number, string])[] = Object.freeze([
  [401, 'authentication_rejected'],
  [409, 'event_conflict'],
  [413, 'event_contract_rejected'],
  [415, 'event_contract_rejected'],
  [422, 'event_contract_rejected'],
] as const);

/** Statuses the source retries behind its claim fence. */
const SOURCE_RETRYABLE: readonly number[] = Object.freeze([429, 500, 502, 503, 504]);

function sourceBody(extra: Record<string, unknown> = {}): Buffer {
  return Buffer.from(JSON.stringify({
    id: '0198e9dd-a56f-7000-8000-000000000001',
    type: ACCOUNT_CREATED,
    version: 1,
    occurredAt: '2026-08-30T12:00:00.000Z',
    correlationId: '0198e9dd-a56f-7000-8000-000000000002',
    subject: { kind: 'account', id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
    data: { email: 'founder@example.test', signupMethod: 'password' },
    ...extra,
  }));
}

/** Exactly the headers the source dispatcher signs and sends. */
function sourceEnvelope(
  body: Uint8Array,
  options: { secret?: Buffer; keyId?: string; timestamp?: string } = {},
): Record<string, string> {
  const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1_000));
  const signature = createHmac('sha256', options.secret ?? SECRET)
    .update(timestamp, 'ascii')
    .update('.', 'ascii')
    .update(body)
    .digest('hex');
  return {
    'content-type': 'application/json',
    'x-r72-key-id': options.keyId ?? KEY_ID,
    'x-r72-timestamp': timestamp,
    'x-r72-signature': `v1=${signature}`,
  };
}

function request(
  body: Uint8Array,
  headers: Record<string, string>,
  options: { method?: string; path?: string } = {},
): IncomingMessage {
  const stream = Readable.from([Buffer.from(body)]) as unknown as IncomingMessage;
  return Object.assign(stream, {
    method: options.method ?? 'POST',
    url: options.path ?? PROPERTY_PREDATOR_EXTERNAL_EVENT_PATH,
    headers: Object.fromEntries(
      Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
    ),
    rawHeaders: Object.entries(headers).flatMap(([name, value]) => [name, value]),
    socket: { encrypted: false, remoteAddress: undefined },
  });
}

function response(): ServerResponse & {
  statusCode: number;
  body: Record<string, unknown>;
  headers: Record<string, string | number>;
  raw: string;
} {
  const state = {
    statusCode: 0,
    body: {} as Record<string, unknown>,
    headers: {} as Record<string, string | number>,
    raw: '',
    setHeader(name: string, value: string | number) {
      state.headers[name.toLowerCase()] = value;
      return state;
    },
    writeHead(status: number, headers: Record<string, string | number> = {}) {
      state.statusCode = status;
      for (const [name, value] of Object.entries(headers)) {
        state.headers[name.toLowerCase()] = value;
      }
      return state;
    },
    end(body = '') {
      state.raw = body;
      state.body = body ? JSON.parse(body) as Record<string, unknown> : {};
      return state;
    },
  };
  return state as unknown as ServerResponse & typeof state;
}

function receiver(
  outcome: { disposition: 'shadow' | 'projected'; replayed: boolean } | Error,
  seen: PropertyPredatorExternalEventShadowRecordInput[] = [],
) {
  return createPropertyPredatorExternalEventHandler({
    production: false,
    bindings: [{
      keyId: KEY_ID,
      sharedSecret: SECRET,
      store: {
        async record(input: PropertyPredatorExternalEventShadowRecordInput) {
          seen.push(input);
          parsePropertyPredatorExternalEventBody(input.rawBody);
          if (outcome instanceof Error) throw outcome;
          return outcome;
        },
      },
    }],
  });
}

async function deliver(
  handler: ReturnType<typeof receiver>,
  body: Uint8Array,
  headers: Record<string, string>,
  options: { method?: string; path?: string } = {},
) {
  const res = response();
  await handler(request(body, headers, options), res);
  return res;
}

/**
 * The source's own receipt validation, restated. It requires exactly these
 * three keys, a true acceptance, a known disposition, and a `replayed` flag
 * that agrees with the status code.
 */
function sourceAcceptsReceipt(status: number, body: Record<string, unknown>): boolean {
  const keys = new Set(Object.keys(body));
  if (keys.size !== 3 || !keys.has('accepted') || !keys.has('disposition') || !keys.has('replayed')) {
    return false;
  }
  const replayed = body.replayed;
  if (body.accepted !== true) return false;
  if (body.disposition !== 'shadow' && body.disposition !== 'projected') return false;
  if (typeof replayed !== 'boolean') return false;
  if ((status === 200) !== replayed) return false;
  if ((status === 202) === replayed) return false;
  return status === 200 || status === 202;
}

test('a fresh source delivery receipts 202 and the source accepts it', async () => {
  const body = sourceBody();
  const seen: PropertyPredatorExternalEventShadowRecordInput[] = [];
  const res = await deliver(
    receiver({ disposition: 'shadow', replayed: false }, seen),
    body,
    sourceEnvelope(body),
  );
  assert.equal(res.statusCode, 202);
  assert.deepEqual(res.body, { accepted: true, disposition: 'shadow', replayed: false });
  assert.ok(sourceAcceptsReceipt(res.statusCode, res.body), 'the source must accept this receipt');
  // The receiver verified the source's signature over the exact stored bytes.
  assert.equal(seen.length, 1);
  assert.deepEqual(Buffer.from(seen[0]!.rawBody), body);
});

test('an exact replay receipts 200 and the source accepts it', async () => {
  const body = sourceBody();
  const res = await deliver(
    receiver({ disposition: 'projected', replayed: true }),
    body,
    sourceEnvelope(body),
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { accepted: true, disposition: 'projected', replayed: true });
  assert.ok(sourceAcceptsReceipt(res.statusCode, res.body));
});

test('the receiver never emits a receipt the source would reject', async () => {
  // Both dispositions, both freshness states, paired with the status each must
  // carry. A mismatch here is the exact contradiction the source quarantines.
  for (const disposition of ['shadow', 'projected'] as const) {
    for (const replayed of [false, true]) {
      const body = sourceBody({ id: `0198e9dd-a56f-7000-8000-00000000000${replayed ? 3 : 4}` });
      const res = await deliver(receiver({ disposition, replayed }), body, sourceEnvelope(body));
      assert.equal(res.statusCode, replayed ? 200 : 202);
      assert.ok(
        sourceAcceptsReceipt(res.statusCode, res.body),
        `${disposition}/${replayed} produced a receipt the source rejects`,
      );
    }
  }
});

test('a wrong secret, wrong key id or stale timestamp is refused as 401', async () => {
  const body = sourceBody();
  const staleTimestamp = String(Math.floor(Date.now() / 1_000) - 3_600);
  for (const [label, headers] of [
    ['wrong secret', sourceEnvelope(body, { secret: OTHER_SECRET })],
    ['unknown key id', sourceEnvelope(body, { keyId: 'pp-growth-unknown' })],
    ['stale timestamp', sourceEnvelope(body, { timestamp: staleTimestamp })],
  ] as const) {
    const seen: PropertyPredatorExternalEventShadowRecordInput[] = [];
    const res = await deliver(receiver({ disposition: 'shadow', replayed: false }, seen), body, headers);
    assert.equal(res.statusCode, 401, label);
    assert.deepEqual(res.body, { error: 'authentication_failed' }, label);
    // Authentication is decided before the store is ever consulted.
    assert.deepEqual(seen, [], `${label} must not reach the store`);
  }
});

test('a tampered body fails authentication rather than being stored', async () => {
  const signed = sourceBody();
  const headers = sourceEnvelope(signed);
  const tampered = sourceBody({ data: { email: 'attacker@example.test', signupMethod: 'password' } });
  const seen: PropertyPredatorExternalEventShadowRecordInput[] = [];
  const res = await deliver(receiver({ disposition: 'shadow', replayed: false }, seen), tampered, headers);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(seen, []);
});

test('each permanent failure the source quarantines has an exact receiver status', async () => {
  const body = sourceBody();
  const cases: readonly (readonly [number, () => Promise<ReturnType<typeof response>>])[] = [
    [409, async () => deliver(
      receiver(new PropertyPredatorExternalEventReceiptConflictError()),
      body, sourceEnvelope(body),
    )],
    [422, async () => deliver(
      receiver(new PropertyPredatorExternalEventContractError('invalid')),
      body, sourceEnvelope(body),
    )],
    [415, async () => deliver(
      receiver({ disposition: 'shadow', replayed: false }),
      body, { ...sourceEnvelope(body), 'content-type': 'text/plain' },
    )],
  ];
  for (const [expected, run] of cases) {
    const res = await run();
    assert.equal(res.statusCode, expected);
    assert.ok(
      SOURCE_PERMANENT.some(([status]) => status === expected),
      `${expected} must be one the source treats as permanent`,
    );
    // A failure must never look like an acceptance.
    assert.equal(sourceAcceptsReceipt(res.statusCode, res.body), false);
  }
});

test('an oversized body is refused at the byte cap the source also enforces', async () => {
  // The source caps its own bodies at 32 KiB, so the two caps must agree or a
  // legal source event would be rejected as too large.
  assert.equal(PROPERTY_PREDATOR_EXTERNAL_EVENT_MAX_BODY_BYTES, 32 * 1024);
  const oversized = Buffer.alloc(PROPERTY_PREDATOR_EXTERNAL_EVENT_MAX_BODY_BYTES + 1, 0x20);
  const seen: PropertyPredatorExternalEventShadowRecordInput[] = [];
  const res = await deliver(
    receiver({ disposition: 'shadow', replayed: false }, seen),
    oversized,
    sourceEnvelope(oversized),
  );
  assert.equal(res.statusCode, 413);
  assert.deepEqual(seen, []);
});

test('a store outage is retryable for the source, not a silent acceptance', async () => {
  const body = sourceBody();
  const res = await deliver(receiver(new Error('database unavailable')), body, sourceEnvelope(body));
  assert.equal(res.statusCode, 503);
  assert.ok(SOURCE_RETRYABLE.includes(res.statusCode), 'the source must retry a 503');
  assert.equal(sourceAcceptsReceipt(res.statusCode, res.body), false);
  // A store outage is reported distinctly from an authentication-stage
  // outage, so an operator can tell the two apart from the token alone.
  assert.deepEqual(res.body, { error: 'external_event_store_unavailable' });
});

test('every failure body is sanitised operational evidence', async () => {
  const body = sourceBody();
  const secretHex = SECRET.toString('hex');
  const secretBase64Url = SECRET.toString('base64url');
  const responses = [
    await deliver(receiver({ disposition: 'shadow', replayed: false }), body,
      sourceEnvelope(body, { secret: OTHER_SECRET })),
    await deliver(receiver(new PropertyPredatorExternalEventReceiptConflictError()),
      body, sourceEnvelope(body)),
    await deliver(receiver(new Error('connection to 10.0.0.4:5432 failed for user r72_web')),
      body, sourceEnvelope(body)),
    await deliver(receiver({ disposition: 'shadow', replayed: false }), body,
      sourceEnvelope(body), { path: '/api/external-events/v1/unknown' }),
  ];
  for (const res of responses) {
    // Exactly one low-cardinality error token, and nothing else.
    assert.deepEqual(Object.keys(res.body), ['error']);
    assert.match(String(res.body.error), /^[a-z][a-z0-9_]*$/);
    for (const leaked of [
      secretHex, secretBase64Url, KEY_ID, 'founder@example.test',
      '10.0.0.4', 'r72_web', 'password',
    ]) {
      assert.equal(res.raw.includes(leaked), false, `response leaked ${leaked}`);
    }
    // Receipts and failures alike must never be cached by an intermediary.
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
  }
});

test('a successful receipt carries no source identity or event content', async () => {
  const body = sourceBody();
  const res = await deliver(receiver({ disposition: 'projected', replayed: false }), body,
    sourceEnvelope(body));
  assert.deepEqual(Object.keys(res.body).sort(), ['accepted', 'disposition', 'replayed']);
  for (const leaked of [KEY_ID, 'founder@example.test', SECRET.toString('hex')]) {
    assert.equal(res.raw.includes(leaked), false, `receipt leaked ${leaked}`);
  }
  assert.equal(res.headers['cache-control'], 'no-store');
});

test('only the exact method and path are the receiver', async () => {
  const body = sourceBody();
  for (const options of [
    { method: 'GET' },
    { method: 'PUT' },
    { path: '/api/external-events/v1/property-predator/' },
    { path: '/api/external-events/v1/property-predator?replay=1' },
    { path: '/api/external-events/v2/property-predator' },
  ]) {
    const seen: PropertyPredatorExternalEventShadowRecordInput[] = [];
    const res = await deliver(
      receiver({ disposition: 'shadow', replayed: false }, seen),
      body, sourceEnvelope(body), options,
    );
    assert.equal(res.statusCode, 404, JSON.stringify(options));
    assert.deepEqual(seen, []);
  }
});
