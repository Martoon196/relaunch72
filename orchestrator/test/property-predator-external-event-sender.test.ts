import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PROPERTY_PREDATOR_EXTERNAL_EVENT_PATH,
  PropertyPredatorExternalEventDeliveryError,
  PropertyPredatorExternalEventSender,
  loadPropertyPredatorExternalEventSenderConfig,
  verifyPropertyPredatorExternalEventSignature,
  type PropertyPredatorExternalEvent,
} from '../src/integrations/external-events/index.js';

const ENDPOINT = `https://hq.propertypredator.com${PROPERTY_PREDATOR_EXTERNAL_EVENT_PATH}`;
const KEY_ID = 'pp-source-2026-01';
const SECRET = Buffer.alloc(32, 0x5a);
const NOW = 1_777_777_777;

function event(): PropertyPredatorExternalEvent {
  return {
    id: '0198e9dd-a56f-7000-8000-000000000001',
    type: 'identity.account.created',
    version: 1,
    occurredAt: '2026-08-29T12:00:00.000Z',
    correlationId: '0198e9dd-a56f-7000-8000-000000000002',
    subject: { kind: 'account', id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
    data: { email: 'hunter@example.com', signupMethod: 'password', displayName: 'Hunter One' },
  };
}

function sender(fetchImpl: typeof fetch): PropertyPredatorExternalEventSender {
  return new PropertyPredatorExternalEventSender({
    endpoint: ENDPOINT, keyId: KEY_ID, sharedSecret: SECRET, timeoutMs: 1_000,
  }, { fetch: fetchImpl, nowSeconds: () => NOW });
}

function accepted(status: 200 | 202, replayed = status === 200): Response {
  const body = JSON.stringify({ accepted: true, disposition: 'projected', replayed });
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
  });
}

test('sender validates, signs and delivers the exact canonical event bytes once', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const delivery = sender((async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return accepted(202);
  }) as typeof fetch);
  const receipt = await delivery.deliver(event());
  assert.deepEqual(receipt, {
    accepted: true,
    disposition: 'projected',
    replayed: false,
    eventId: event().id,
    acceptedStatus: 202,
  });
  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.url, ENDPOINT);
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.redirect, 'error');
  const headers = call.init.headers as Record<string, string>;
  assert.equal(headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(headers['x-r72-key-id'], KEY_ID);
  assert.equal(headers['x-r72-timestamp'], String(NOW));
  const rawBody = call.init.body as Buffer;
  assert.deepEqual(JSON.parse(rawBody.toString('utf8')), event());
  verifyPropertyPredatorExternalEventSignature({
    rawBody,
    keyId: headers['x-r72-key-id']!,
    timestamp: headers['x-r72-timestamp']!,
    signature: headers['x-r72-signature']!,
    expectedKeyId: KEY_ID,
    sharedSecret: SECRET,
    nowSeconds: NOW,
  });
});

test('sender accepts only the receiver exact fresh/replay receipt pairing', async () => {
  assert.equal((await sender(async () => accepted(200) as never).deliver(event())).replayed, true);
  for (const response of [
    accepted(200, false),
    accepted(202, true),
    new Response(JSON.stringify({ accepted: true, disposition: 'projected', replayed: false, extra: true }), {
      status: 202, headers: { 'content-type': 'application/json' },
    }),
    new Response('not-json', { status: 202, headers: { 'content-type': 'application/json' } }),
    new Response('{}', { status: 202, headers: { 'content-type': 'text/plain' } }),
  ]) {
    await assert.rejects(sender(async () => response as never).deliver(event()), (error) => (
      error instanceof PropertyPredatorExternalEventDeliveryError
      && error.kind === 'unexpected_response' && error.retryable === false
    ));
  }
});

test('sender classifies receiver failures for a durable source outbox', async () => {
  const cases: readonly [number, string, boolean][] = [
    [401, 'authentication_rejected', false],
    [409, 'event_conflict', false],
    [422, 'event_contract_rejected', false],
    [429, 'receiver_unavailable_retryable', true],
    [503, 'receiver_unavailable_retryable', true],
  ];
  for (const [status, kind, retryable] of cases) {
    await assert.rejects(
      sender(async () => new Response('{}', { status }) as never).deliver(event()),
      (error) => error instanceof PropertyPredatorExternalEventDeliveryError
        && error.kind === kind && error.retryable === retryable,
    );
  }
  await assert.rejects(
    sender(async () => { throw new Error('socket closed after write'); }).deliver(event()),
    (error) => error instanceof PropertyPredatorExternalEventDeliveryError
      && error.kind === 'outcome_unknown_retryable' && error.retryable,
  );
});

test('sender rejects invalid event/config before any network attempt', async () => {
  for (const config of [
    { endpoint: `http://hq.propertypredator.com${PROPERTY_PREDATOR_EXTERNAL_EVENT_PATH}`, keyId: KEY_ID, sharedSecret: SECRET },
    { endpoint: `${ENDPOINT}?workspace=forged`, keyId: KEY_ID, sharedSecret: SECRET },
    { endpoint: ENDPOINT, keyId: 'bad key', sharedSecret: SECRET },
    { endpoint: ENDPOINT, keyId: KEY_ID, sharedSecret: Buffer.alloc(16) },
  ]) assert.throws(() => new PropertyPredatorExternalEventSender(config));

  let calls = 0;
  const invalid = event() as any;
  invalid.workspaceId = 'browser-supplied-workspace';
  await assert.rejects(sender(async () => { calls += 1; return accepted(202); }).deliver(invalid));
  assert.equal(calls, 0);
});

test('source runtime config loads one exact endpoint/key/secret tuple', () => {
  const loaded = loadPropertyPredatorExternalEventSenderConfig({
    PROPERTY_PREDATOR_GROWTH_HQ_EVENT_ENDPOINT: ENDPOINT,
    PROPERTY_PREDATOR_GROWTH_HQ_EVENT_KEY_ID: KEY_ID,
    PROPERTY_PREDATOR_GROWTH_HQ_EVENT_SECRET_BASE64URL: SECRET.toString('base64url'),
    PROPERTY_PREDATOR_GROWTH_HQ_EVENT_TIMEOUT_MS: '3000',
  });
  assert.equal(loaded.endpoint, ENDPOINT);
  assert.equal(loaded.keyId, KEY_ID);
  assert.deepEqual(loaded.sharedSecret, SECRET);
  assert.equal(loaded.timeoutMs, 3_000);
  for (const invalid of [
    { PROPERTY_PREDATOR_GROWTH_HQ_EVENT_ENDPOINT: `${ENDPOINT}?workspace=forged`, PROPERTY_PREDATOR_GROWTH_HQ_EVENT_KEY_ID: KEY_ID, PROPERTY_PREDATOR_GROWTH_HQ_EVENT_SECRET_BASE64URL: SECRET.toString('base64url') },
    { PROPERTY_PREDATOR_GROWTH_HQ_EVENT_ENDPOINT: ENDPOINT, PROPERTY_PREDATOR_GROWTH_HQ_EVENT_KEY_ID: KEY_ID, PROPERTY_PREDATOR_GROWTH_HQ_EVENT_SECRET_BASE64URL: ` ${SECRET.toString('base64url')}` },
    { PROPERTY_PREDATOR_GROWTH_HQ_EVENT_ENDPOINT: ENDPOINT, PROPERTY_PREDATOR_GROWTH_HQ_EVENT_KEY_ID: KEY_ID, PROPERTY_PREDATOR_GROWTH_HQ_EVENT_SECRET_BASE64URL: Buffer.alloc(16).toString('base64url') },
  ]) assert.throws(() => loadPropertyPredatorExternalEventSenderConfig(invalid));
});

test('sender caps response bytes and never includes the shared secret in errors', async () => {
  const oversized = 'x'.repeat(16 * 1024 + 1);
  await assert.rejects(
    sender(async () => new Response(oversized, {
      status: 202,
      headers: { 'content-type': 'application/json', 'content-length': String(oversized.length) },
    }) as never).deliver(event()),
    (error) => error instanceof PropertyPredatorExternalEventDeliveryError
      && error.kind === 'unexpected_response'
      && !error.message.includes(SECRET.toString('base64url')),
  );
});
