import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import test from 'node:test';
import {
  PROPERTY_PREDATOR_SIMULATED_META_DM_INBOUND_PATH,
  PROPERTY_PREDATOR_SIMULATED_WHATSAPP_INBOUND_PATH,
  SIMULATED_FACEBOOK_INSTAGRAM_DM_ENVELOPE_ADAPTER,
  SIMULATED_INBOUND_MAX_BODY_BYTES,
  SIMULATED_INBOUND_SIGNATURE_HEADER,
  SimulatedInboundBindingUnavailableError,
  SimulatedInboundEventConflictError,
  createSimulatedMetaDmInboundWebhookHandler,
  createSimulatedWhatsAppInboundWebhookHandler,
  type AuthenticatedSimulatedInboundCommand,
  type DurableSimulatedInboundCommandService,
  type SimulatedInboundSafeOutcome,
} from '../src/integrations/simulated-inbound/router.js';
import { createRepositoryBackedSimulatedInboundCommandService } from '../src/integrations/simulated-inbound/repository-command-service.js';
import { createSignedSocialDmDarkInbound } from '../src/social-dm-dark/index.js';
import {
  TestInboxWebhookBindingError,
  TestInboxWebhookEventConflictError,
  type TestInboxWebhookRepository,
  type VerifiedTestInboxWebhookRecordInput,
} from '../src/test-inbox-webhook-pg/types.js';
import { createSignedSimulatedWhatsAppInbound } from '../src/whatsapp-dark/index.js';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const CONNECTION_ID = '22222222-2222-4222-8222-222222222222';
const INSTAGRAM_CONNECTION_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const INBOX_ID = '33333333-3333-4333-8333-333333333333';
const CONTACT_ID = '44444444-4444-4444-8444-444444444444';
const CONTACT_POINT_ID = '55555555-5555-4555-8555-555555555555';
const INSTAGRAM_INBOX_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INSTAGRAM_CONTACT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const INSTAGRAM_CONTACT_POINT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const NOW = new Date('2026-08-27T18:00:00.000Z');
const WHATSAPP_SECRET = 'whatsapp-http-test-secret-000000000000001';
const SOCIAL_SECRET = 'social-http-test-secret-00000000000000001';

function request(
  rawBody: Uint8Array,
  headers: Readonly<Record<string, string>>,
  options: Readonly<{
    method?: string;
    path?: string;
    rawHeaders?: readonly string[];
  }> = {},
): IncomingMessage {
  const body = Buffer.from(rawBody);
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  const rawHeaders = options.rawHeaders ?? Object.entries(normalized).flatMap(([key, value]) => [key, value]);
  const stream = Readable.from([body]) as unknown as IncomingMessage;
  return Object.assign(stream, {
    method: options.method ?? 'POST',
    url: options.path ?? PROPERTY_PREDATOR_SIMULATED_WHATSAPP_INBOUND_PATH,
    headers: normalized,
    rawHeaders: [...rawHeaders],
  });
}

function response(): ServerResponse & {
  statusCode: number;
  body: string;
  responseHeaders: Record<string, string>;
} {
  const state = {
    statusCode: 0,
    body: '',
    responseHeaders: {} as Record<string, string>,
    writeHead(code: number, headers: Record<string, string> = {}) {
      state.statusCode = code;
      for (const [key, value] of Object.entries(headers)) {
        state.responseHeaders[key.toLowerCase()] = String(value);
      }
      return state;
    },
    end(body = '') {
      state.body = body;
      return state;
    },
  };
  return state as unknown as ServerResponse & {
    statusCode: number;
    body: string;
    responseHeaders: Record<string, string>;
  };
}

class DurableFake implements DurableSimulatedInboundCommandService {
  readonly calls: AuthenticatedSimulatedInboundCommand[] = [];
  readonly #receipts = new Map<string, string>();
  nextError: Error | null = null;

  async recordAuthenticatedTestInbound(
    input: AuthenticatedSimulatedInboundCommand,
  ): Promise<Readonly<{ disposition: 'applied' | 'replayed' }>> {
    if (this.nextError) throw this.nextError;
    this.calls.push(input);
    const key = [
      input.workspaceId,
      input.connectionId,
      input.providerId,
      input.externalEventId,
    ].join(':');
    const payloadSha256 = Buffer.from(input.payloadSha256).toString('hex');
    const previous = this.#receipts.get(key);
    if (previous !== undefined && previous !== payloadSha256) {
      throw new SimulatedInboundEventConflictError();
    }
    if (previous !== undefined) return Object.freeze({ disposition: 'replayed' });
    this.#receipts.set(key, payloadSha256);
    return Object.freeze({ disposition: 'applied' });
  }
}

function whatsAppSigned(occurredAt = NOW.toISOString()) {
  return createSignedSimulatedWhatsAppInbound({
    workspaceId: WORKSPACE_ID,
    connectionId: CONNECTION_ID,
    from: '+447700900002',
    to: '+447700900001',
    body: 'A signed fictional WhatsApp reply.',
    occurredAt,
    testSecret: WHATSAPP_SECRET,
  });
}

function whatsappBinding() {
  return Object.freeze({
    workspaceId: WORKSPACE_ID,
    connectionId: CONNECTION_ID,
    inboxId: INBOX_ID,
    contactId: CONTACT_ID,
    contactPointId: CONTACT_POINT_ID,
    ownedTestNumber: '+447700900001',
    sourceTestNumber: '+447700900002',
  });
}

function signedHeaders(signed: Readonly<{ signature: string; contentType: string }>) {
  return {
    'content-type': signed.contentType,
    'content-length': String(0),
    [SIMULATED_INBOUND_SIGNATURE_HEADER]: signed.signature,
  };
}

function exactHeaders(signed: Readonly<{ rawBody: Uint8Array; signature: string; contentType: string }>) {
  return {
    ...signedHeaders(signed),
    'content-length': String(signed.rawBody.byteLength),
  };
}

test('signed fresh WhatsApp TEST ingress records once and exact replay is durable', async () => {
  const service = new DurableFake();
  const outcomes: SimulatedInboundSafeOutcome[] = [];
  const handler = createSimulatedWhatsAppInboundWebhookHandler({
    testSecret: WHATSAPP_SECRET,
    binding: whatsappBinding(),
    commandService: service,
    now: () => NOW,
    onSafeOutcome: (outcome) => { outcomes.push(outcome); },
  });
  const signed = whatsAppSigned();

  const first = response();
  await handler(request(signed.rawBody, exactHeaders(signed)), first);
  assert.equal(first.statusCode, 202);
  assert.deepEqual(JSON.parse(first.body), {
    accepted: true, replayed: false, environment: 'test',
  });
  assert.equal(service.calls.length, 1);
  assert.equal(service.calls[0]?.providerId, 'whatsapp_dark_simulator');
  assert.equal(service.calls[0]?.environment, 'test');
  assert.equal(service.calls[0]?.command.inboxId, INBOX_ID);
  assert.equal(service.calls[0]?.command.body, 'A signed fictional WhatsApp reply.');
  for (const digest of [
    service.calls[0]?.payloadSha256,
    service.calls[0]?.eventIdentitySha256,
    service.calls[0]?.signatureSha256,
    service.calls[0]?.sourceIdentitySha256,
    service.calls[0]?.destinationIdentitySha256,
  ]) {
    assert.equal(digest?.byteLength, 32);
  }
  assert.equal(first.responseHeaders['cache-control'], 'no-store');

  const replay = response();
  await handler(request(signed.rawBody, exactHeaders(signed)), replay);
  assert.equal(replay.statusCode, 200);
  assert.deepEqual(JSON.parse(replay.body), {
    accepted: true, replayed: true, environment: 'test',
  });
  assert.deepEqual(outcomes, ['accepted', 'replayed']);
  assert.doesNotMatch(first.body + replay.body, /447700|fictional|waevt|wamsg|whatsapp-http-test-secret/i);
});

test('same durable event identity with different authenticated bytes conflicts', async () => {
  const service = new DurableFake();
  const handler = createSimulatedWhatsAppInboundWebhookHandler({
    testSecret: WHATSAPP_SECRET, binding: whatsappBinding(), commandService: service,
    now: () => NOW,
  });
  const signed = whatsAppSigned();
  const first = response();
  await handler(request(signed.rawBody, exactHeaders(signed)), first);
  assert.equal(first.statusCode, 202);

  const parsed = JSON.parse(Buffer.from(signed.rawBody).toString('utf8')) as Record<string, unknown>;
  const changedBytes = Buffer.from(`${JSON.stringify(parsed, null, 1)}\n`, 'utf8');
  const changedSignature = `sha256=${createHmac('sha256', WHATSAPP_SECRET)
    .update(changedBytes).digest('hex')}`;
  const conflict = response();
  await handler(request(changedBytes, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(changedBytes.byteLength),
    [SIMULATED_INBOUND_SIGNATURE_HEADER]: changedSignature,
  }), conflict);
  assert.equal(conflict.statusCode, 409);
  assert.deepEqual(JSON.parse(conflict.body), { error: 'event_conflict' });
  assert.equal(service.calls.length, 2);
});

test('repository bridge forwards complete hashed evidence and translates durable conflicts', async () => {
  const capture = new DurableFake();
  const handler = createSimulatedWhatsAppInboundWebhookHandler({
    testSecret: WHATSAPP_SECRET, binding: whatsappBinding(), commandService: capture,
    now: () => NOW,
  });
  const signed = whatsAppSigned();
  const accepted = response();
  await handler(request(signed.rawBody, exactHeaders(signed)), accepted);
  const authenticated = capture.calls[0]!;

  let recorded: VerifiedTestInboxWebhookRecordInput | undefined;
  const repository: TestInboxWebhookRepository = {
    record: async (input) => {
      recorded = input;
      return Object.freeze({
        replayed: false,
        conversationId: '66666666-6666-4666-8666-666666666666',
        messageId: '77777777-7777-4777-8777-777777777777',
        messageVersionId: '88888888-8888-4888-8888-888888888888',
        bodySha256: '0'.repeat(64),
      });
    },
  };
  const bridge = createRepositoryBackedSimulatedInboundCommandService(repository);
  assert.deepEqual(await bridge.recordAuthenticatedTestInbound(authenticated), {
    disposition: 'applied',
  });
  assert.equal(recorded?.providerConnectionId, CONNECTION_ID);
  assert.equal(recorded?.providerId, 'whatsapp_dark_simulator');
  assert.equal(recorded?.inboxId, INBOX_ID);
  assert.equal(recorded?.contactId, CONTACT_ID);
  assert.equal(recorded?.contactPointId, CONTACT_POINT_ID);
  assert.equal(recorded?.externalEventId, authenticated.externalEventId);
  assert.equal(recorded?.occurredAt, NOW.toISOString());
  assert.equal(recorded?.body, 'A signed fictional WhatsApp reply.');
  assert.deepEqual(recorded?.payloadSha256, authenticated.payloadSha256);
  assert.equal(
    Buffer.from(recorded?.signatureSha256 ?? []).toString('hex'),
    createHash('sha256').update(signed.signature).digest('hex'),
  );
  assert.notEqual(recorded?.payloadSha256, authenticated.payloadSha256);
  assert.doesNotMatch(
    JSON.stringify(recorded),
    /\+447700|whatsapp-http-test-secret|sha256=[a-f0-9]{64}/iu,
  );

  const conflictBridge = createRepositoryBackedSimulatedInboundCommandService({
    record: async () => { throw new TestInboxWebhookEventConflictError(); },
  });
  await assert.rejects(
    conflictBridge.recordAuthenticatedTestInbound(authenticated),
    SimulatedInboundEventConflictError,
  );
  const bindingBridge = createRepositoryBackedSimulatedInboundCommandService({
    record: async () => { throw new TestInboxWebhookBindingError(); },
  });
  await assert.rejects(
    bindingBridge.recordAuthenticatedTestInbound(authenticated),
    SimulatedInboundBindingUnavailableError,
  );
});

test('signature, duplicate header, reserved-address and timestamp checks precede the command', async () => {
  const service = new DurableFake();
  const outcomes: SimulatedInboundSafeOutcome[] = [];
  const handler = createSimulatedWhatsAppInboundWebhookHandler({
    testSecret: WHATSAPP_SECRET, binding: whatsappBinding(), commandService: service,
    now: () => NOW, onSafeOutcome: (outcome) => { outcomes.push(outcome); },
  });
  const signed = whatsAppSigned();
  const tampered = Uint8Array.from(signed.rawBody);
  tampered[tampered.length - 2] = tampered[tampered.length - 2]! ^ 1;
  const badSignature = response();
  await handler(request(tampered, exactHeaders({ ...signed, rawBody: tampered })), badSignature);
  assert.equal(badSignature.statusCode, 401);

  const duplicate = response();
  const headers = exactHeaders(signed);
  await handler(request(signed.rawBody, headers, { rawHeaders: [
    'content-type', headers['content-type'],
    'content-length', headers['content-length'],
    SIMULATED_INBOUND_SIGNATURE_HEADER, signed.signature,
    SIMULATED_INBOUND_SIGNATURE_HEADER, signed.signature,
  ] }), duplicate);
  assert.equal(duplicate.statusCode, 401);

  const raw = JSON.parse(Buffer.from(signed.rawBody).toString('utf8')) as {
    event: { from: string };
  };
  raw.event.from = '+447911123456';
  const routableBody = Buffer.from(JSON.stringify(raw));
  const routableSignature = `sha256=${createHmac('sha256', WHATSAPP_SECRET)
    .update(routableBody).digest('hex')}`;
  const routable = response();
  await handler(request(routableBody, {
    'content-type': 'application/json',
    'content-length': String(routableBody.byteLength),
    [SIMULATED_INBOUND_SIGNATURE_HEADER]: routableSignature,
  }), routable);
  assert.equal(routable.statusCode, 401);

  for (const occurredAt of [
    new Date(NOW.getTime() - 300_001).toISOString(),
    new Date(NOW.getTime() + 300_001).toISOString(),
  ]) {
    const stale = whatsAppSigned(occurredAt);
    const rejected = response();
    await handler(request(stale.rawBody, exactHeaders(stale)), rejected);
    assert.equal(rejected.statusCode, 409);
    assert.deepEqual(JSON.parse(rejected.body), { error: 'event_rejected' });
  }
  const edge = whatsAppSigned(new Date(NOW.getTime() - 300_000).toISOString());
  const edgeAccepted = response();
  await handler(request(edge.rawBody, exactHeaders(edge)), edgeAccepted);
  assert.equal(edgeAccepted.statusCode, 202);
  assert.equal(service.calls.length, 1);
  assert.deepEqual(outcomes, [
    'authentication_failed', 'authentication_failed', 'authentication_failed',
    'event_rejected', 'event_rejected', 'accepted',
  ]);
});

test('HTTP bounds, media type and service failures return fixed safe responses', async () => {
  const service = new DurableFake();
  const outcomes: SimulatedInboundSafeOutcome[] = [];
  const handler = createSimulatedWhatsAppInboundWebhookHandler({
    testSecret: WHATSAPP_SECRET, binding: whatsappBinding(), commandService: service,
    now: () => NOW, onSafeOutcome: (outcome) => { outcomes.push(outcome); },
  });
  const signed = whatsAppSigned();

  for (const options of [
    { method: 'GET' },
    { path: `${PROPERTY_PREDATOR_SIMULATED_WHATSAPP_INBOUND_PATH}?debug=1` },
  ]) {
    const hidden = response();
    await handler(request(signed.rawBody, exactHeaders(signed), options), hidden);
    assert.equal(hidden.statusCode, 404);
  }

  const media = response();
  await handler(request(signed.rawBody, {
    ...exactHeaders(signed), 'content-type': 'text/plain',
  }), media);
  assert.equal(media.statusCode, 415);

  const oversized = Buffer.alloc(SIMULATED_INBOUND_MAX_BODY_BYTES + 1, 0x61);
  const tooLarge = response();
  await handler(request(oversized, {
    'content-type': 'application/json',
    'content-length': String(oversized.byteLength),
    [SIMULATED_INBOUND_SIGNATURE_HEADER]: 'sha256=' + '0'.repeat(64),
  }), tooLarge);
  assert.equal(tooLarge.statusCode, 413);

  const incomplete = response();
  await handler(request(signed.rawBody, {
    ...exactHeaders(signed),
    'content-length': String(signed.rawBody.byteLength + 1),
  }), incomplete);
  assert.equal(incomplete.statusCode, 503);

  service.nextError = new Error(
    'postgresql://secret@database.invalid and +447700900002 must never escape',
  );
  const unavailable = response();
  await handler(request(signed.rawBody, exactHeaders(signed)), unavailable);
  assert.equal(unavailable.statusCode, 503);
  assert.deepEqual(JSON.parse(unavailable.body), {
    error: 'simulated_inbound_temporarily_unavailable',
  });
  assert.equal(unavailable.responseHeaders['retry-after'], '30');
  assert.doesNotMatch(unavailable.body, /postgres|447700|secret/i);
  assert.deepEqual(outcomes, ['temporarily_unavailable', 'temporarily_unavailable']);
});

test('generic Meta seam authenticates Facebook and Instagram but refuses other DM networks', async () => {
  const facebookService = new DurableFake();
  const instagramService = new DurableFake();
  const handler = createSimulatedMetaDmInboundWebhookHandler({
    testSecret: SOCIAL_SECRET,
    bindings: {
      facebook: {
        workspaceId: WORKSPACE_ID, connectionId: CONNECTION_ID,
        inboxId: INBOX_ID, contactId: CONTACT_ID, contactPointId: CONTACT_POINT_ID,
        network: 'facebook',
        ownedTestAddress: 'test-dm:facebook:property-predator-owned',
        sourceTestAddress: 'test-dm:facebook:fictional-source',
      },
      instagram: {
        workspaceId: WORKSPACE_ID, connectionId: INSTAGRAM_CONNECTION_ID,
        inboxId: INSTAGRAM_INBOX_ID,
        contactId: INSTAGRAM_CONTACT_ID,
        contactPointId: INSTAGRAM_CONTACT_POINT_ID,
        network: 'instagram',
        ownedTestAddress: 'test-dm:instagram:property-predator-owned',
        sourceTestAddress: 'test-dm:instagram:fictional-source',
      },
    },
    commandServices: {
      facebook: facebookService,
      instagram: instagramService,
    },
    now: () => NOW,
  });
  for (const network of ['facebook', 'instagram'] as const) {
    const source = `test-dm:${network}:fictional-source`;
    const owned = `test-dm:${network}:property-predator-owned`;
    const signed = createSignedSocialDmDarkInbound({
      workspaceId: WORKSPACE_ID,
      connectionId: network === 'facebook' ? CONNECTION_ID : INSTAGRAM_CONNECTION_ID,
      network,
      from: source, to: owned, body: `Fictional ${network} DM.`,
      occurredAt: NOW.toISOString(), testSecret: SOCIAL_SECRET,
    });
    const accepted = response();
    await handler(request(signed.rawBody, exactHeaders(signed), {
      path: PROPERTY_PREDATOR_SIMULATED_META_DM_INBOUND_PATH,
    }), accepted);
    assert.equal(accepted.statusCode, 202);
    const service = network === 'facebook' ? facebookService : instagramService;
    const call = service.calls.at(-1);
    assert.equal(call?.providerId, 'social_dm_dark_simulator');
    assert.equal(call?.command.body, `Fictional ${network} DM.`);
    assert.equal(
      call?.command.inboxId,
      network === 'facebook' ? INBOX_ID : INSTAGRAM_INBOX_ID,
    );
  }
  assert.equal(facebookService.calls.length, 1);
  assert.equal(instagramService.calls.length, 1);

  const linkedin = createSignedSocialDmDarkInbound({
    workspaceId: WORKSPACE_ID, connectionId: CONNECTION_ID, network: 'linkedin',
    from: 'test-dm:linkedin:source', to: 'test-dm:linkedin:owned',
    body: 'Not part of the Meta seam.', occurredAt: NOW.toISOString(), testSecret: SOCIAL_SECRET,
  });
  const verified = SIMULATED_FACEBOOK_INSTAGRAM_DM_ENVELOPE_ADAPTER.verify({
    ...linkedin, testSecret: SOCIAL_SECRET,
  });
  assert.throws(
    () => SIMULATED_FACEBOOK_INSTAGRAM_DM_ENVELOPE_ADAPTER.identity(verified),
    /not a Meta network/,
  );
});

test('simulated inbound HTTP boundary has no provider network, SDK, env or database authority', () => {
  const source = [
    'router.ts',
    'repository-command-service.ts',
  ].map((file) => fs.readFileSync(
    new URL(`../src/integrations/simulated-inbound/${file}`, import.meta.url),
    'utf8',
  )).join('\n');
  assert.doesNotMatch(source, /\bfetch\s*\(/u);
  assert.doesNotMatch(source, /node:(?:https|http2|net|tls|dns)/u);
  assert.doesNotMatch(source, /(?:twilio|whatsapp-web\.js|facebook-nodejs-business-sdk)/iu);
  assert.doesNotMatch(source, /\bprocess\.env\b/u);
  assert.doesNotMatch(source, /(?:db\/config|db\/pool|provider-registry|live-provider)/iu);

  const productionEntrypoint = fs.readFileSync(
    new URL('../src/server/index.ts', import.meta.url),
    'utf8',
  );
  assert.match(productionEntrypoint, /composePropertyPredatorSimulatedInbound\(process\.env\)/u);
  assert.match(productionEntrypoint, /propertyPredatorSimulatedWhatsAppInbound/u);
  assert.match(productionEntrypoint, /propertyPredatorSimulatedMetaDmInbound/u);
  assert.match(productionEntrypoint, /simulatedInbound\.close\(\)/u);
  assert.doesNotMatch(productionEntrypoint, /createSimulated(?:WhatsApp|MetaDm)InboundWebhookHandler/u);
});
