import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  createTwilioMessagingHttpAdapterFromRestrictedKeyEnvironment,
  TwilioMessagingHttpAdapter,
  TwilioOutcomeUnknownError,
} from '../src/providers/twilio-messaging-http-adapter.js';

const ACCOUNT = `AC${'1'.repeat(32)}`;
const KEY = `SK${'2'.repeat(32)}`;
const SERVICE = `MG${'3'.repeat(32)}`;
const MESSAGE = `SM${'4'.repeat(32)}`;
const SECRET = 'restricted-test-secret-123456';
const DIGEST = createHash('sha256').update('exact-request').digest('hex');
const context = Object.freeze({ workspaceId: '11111111-1111-4111-8111-111111111111',
  connectionId: '22222222-2222-4222-8222-222222222222', providerId: 'twilio_messaging',
  operationId: '33333333-3333-4333-8333-333333333333', idempotencyKey: DIGEST,
  correlationId: '44444444-4444-4444-8444-444444444444' });
const request = Object.freeze({ recipient: '+447700900123', body: 'Exact approved SMS.',
  expectedSegmentCount: 1, idempotencySha256: DIGEST });

test('adapter sends one form-bound recipient with restricted Basic auth and idempotency', async () => {
  let url = ''; let init: RequestInit | undefined;
  const adapter = new TwilioMessagingHttpAdapter({ accountSid: ACCOUNT, apiKeySid: KEY,
    apiKeySecret: SECRET, messagingServiceSid: SERVICE,
    now: () => new Date('2026-08-29T10:00:00Z'),
    fetch: (async (input, supplied) => {
      url = String(input); init = supplied;
      return new Response(JSON.stringify({ sid: MESSAGE, num_segments: '1' }), {
        status: 201, headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch });
  const result = await adapter.send(context, request);
  assert.equal(result.status, 'accepted');
  assert.equal(result.externalId, MESSAGE);
  assert.match(url, new RegExp(`/Accounts/${ACCOUNT}/Messages[.]json$`, 'u'));
  const headers = init?.headers as Record<string, string>;
  assert.equal(headers['idempotency-key'], DIGEST);
  assert.equal(headers.authorization,
    `Basic ${Buffer.from(`${KEY}:${SECRET}`, 'utf8').toString('base64')}`);
  const form = new URLSearchParams(String(init?.body));
  assert.deepEqual(Object.fromEntries(form), {
    To: '+447700900123', MessagingServiceSid: SERVICE, Body: 'Exact approved SMS.',
  });
  assert.equal(JSON.stringify(adapter).includes(SECRET), false);
});

test('adapter rejects request drift before fetch and quarantines ambiguous outcomes', async () => {
  let calls = 0;
  const adapter = new TwilioMessagingHttpAdapter({ accountSid: ACCOUNT, apiKeySid: KEY,
    apiKeySecret: SECRET, messagingServiceSid: SERVICE,
    fetch: (async () => { calls += 1; throw new Error('socket closed'); }) as typeof fetch });
  await assert.rejects(adapter.send(context, { ...request, recipient: '+15551234567' }),
    /controlled-pilot boundary/u);
  assert.equal(calls, 0);
  await assert.rejects(adapter.send(context, request), TwilioOutcomeUnknownError);
  assert.equal(calls, 1);
});

test('adapter treats ambiguous HTTP and billed-segment expansion as manual attention', async () => {
  for (const [response, code] of [
    [new Response('{}', { status: 500 }), 'twilio_http_500_outcome_unknown'],
    [new Response(JSON.stringify({ sid: MESSAGE, num_segments: '2' }), { status: 201 }),
      'twilio_segments_exceeded'],
  ] as const) {
    const adapter = new TwilioMessagingHttpAdapter({ accountSid: ACCOUNT, apiKeySid: KEY,
      apiKeySecret: SECRET, messagingServiceSid: SERVICE,
      fetch: (async () => response) as typeof fetch });
    const result = await adapter.send(context, request);
    assert.equal(result.status, 'needs_attention');
    assert.equal(result.retryable, false);
    assert.equal(result.errorCode, code);
  }
});

test('environment factory rejects the webhook auth token and incomplete key scope', () => {
  const env = { TWILIO_KEY_SCOPE: 'restricted-api-key',
    PROPERTY_PREDATOR_SMS_ACCOUNT_SID: ACCOUNT, TWILIO_API_KEY_SID: KEY,
    TWILIO_API_KEY_SECRET: SECRET, TWILIO_MESSAGING_SERVICE_SID: SERVICE };
  assert.ok(createTwilioMessagingHttpAdapterFromRestrictedKeyEnvironment(env));
  assert.throws(() => createTwilioMessagingHttpAdapterFromRestrictedKeyEnvironment({
    ...env, TWILIO_AUTH_TOKEN: 'webhook-only-token',
  }), /must not receive/u);
  assert.throws(() => createTwilioMessagingHttpAdapterFromRestrictedKeyEnvironment({
    ...env, TWILIO_KEY_SCOPE: 'full-account',
  }), /restricted-api-key/u);
});
