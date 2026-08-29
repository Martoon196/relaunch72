import assert from 'node:assert/strict';
import { createCipheriv, createHash, createHmac } from 'node:crypto';
import test from 'node:test';
import {
  MetaWhatsAppLiveError,
  createMetaWhatsAppLiveTransport,
  decryptMetaWhatsAppDispatchCredentials,
  dispatchVerifiedMetaWhatsAppLiveEvents,
  encryptMetaWhatsAppDispatchCredentials,
  loadMetaWhatsAppLiveRuntimeConfig,
  runMetaWhatsAppLiveOnce,
  verifyMetaWhatsAppLiveChallenge,
  verifyMetaWhatsAppLiveWebhook,
  type MetaWhatsAppDispatchResult,
  type MetaWhatsAppLiveClaim,
  type MetaWhatsAppLiveMaterial,
  type MetaWhatsAppLiveRepository,
} from '../src/whatsapp-live/foundation.js';

const IDS = Object.freeze({
  workspace: '11111111-1111-4111-8111-111111111111',
  connection: '22222222-2222-4222-8222-222222222222',
  binding: '33333333-3333-4333-8333-333333333333',
  job: '44444444-4444-4444-8444-444444444444',
  operation: '55555555-5555-4555-8555-555555555555',
});
const BINDING = Object.freeze({
  workspaceId: IDS.workspace,
  connectionId: IDS.connection,
  appId: '100001234567890',
  wabaId: '200001234567890',
  phoneNumberId: '300001234567890',
  graphApiVersion: 'v24.0' as const,
});
const DISPATCH_CREDENTIALS = Object.freeze({
  accessToken: 'EAAG-OWNED-PROPERTY-PREDATOR-TOKEN-123456789',
});
const WEBHOOK_SECRETS = Object.freeze({
  appSecret: 'property-predator-meta-app-secret-123456789',
  verifyToken: 'property-predator-meta-verify-token-123456789',
});
const KEY = Buffer.alloc(32, 7);
const LEASE = Buffer.alloc(32, 9);
const digest = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');

const ENVELOPE = encryptMetaWhatsAppDispatchCredentials({
  binding: BINDING,
  credentials: DISPATCH_CREDENTIALS,
  encryptionKey: KEY,
  keyVersion: 'render-kms-v1',
  iv: Buffer.alloc(12, 3),
});

test('access-token-only AES-256-GCM credentials are bound to workspace, connection, WABA and phone AAD', () => {
  assert.deepEqual(decryptMetaWhatsAppDispatchCredentials({
    binding: BINDING,
    envelope: ENVELOPE,
    encryptionKey: KEY,
    expectedKeyVersion: 'render-kms-v1',
  }), DISPATCH_CREDENTIALS);
  for (const binding of [
    { ...BINDING, workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    { ...BINDING, connectionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
    { ...BINDING, wabaId: '900001234567890' },
    { ...BINDING, phoneNumberId: '800001234567890' },
  ]) assert.throws(() => decryptMetaWhatsAppDispatchCredentials({
    binding,
    envelope: ENVELOPE,
    encryptionKey: KEY,
    expectedKeyVersion: 'render-kms-v1',
  }), MetaWhatsAppLiveError);
  assert.throws(() => decryptMetaWhatsAppDispatchCredentials({
    binding: BINDING,
    envelope: { ...ENVELOPE, ciphertextBase64: Buffer.from('tampered').toString('base64') },
    encryptionKey: KEY,
    expectedKeyVersion: 'render-kms-v1',
  }), MetaWhatsAppLiveError);
  assert.equal(JSON.stringify(ENVELOPE).includes(DISPATCH_CREDENTIALS.accessToken), false);

  assert.throws(() => encryptMetaWhatsAppDispatchCredentials({
    binding: BINDING,
    credentials: { ...DISPATCH_CREDENTIALS,
      appSecret: WEBHOOK_SECRETS.appSecret } as never,
    encryptionKey: KEY,
    keyVersion: 'render-kms-v1',
    iv: Buffer.alloc(12, 4),
  }), MetaWhatsAppLiveError);

  const legacyPlaintext = Buffer.from(JSON.stringify({
    ...DISPATCH_CREDENTIALS,
    appSecret: WEBHOOK_SECRETS.appSecret,
    verifyToken: WEBHOOK_SECRETS.verifyToken,
  }), 'utf8');
  const legacyAad = Buffer.from(JSON.stringify({
    contract: 'propertypredator.meta-whatsapp-live/v1',
    ...BINDING,
    providerId: 'meta_whatsapp_cloud',
    channel: 'whatsapp',
  }), 'utf8');
  const legacyIv = Buffer.alloc(12, 5);
  const legacyCipher = createCipheriv('aes-256-gcm', KEY, legacyIv);
  legacyCipher.setAAD(legacyAad);
  const legacyCiphertext = Buffer.concat([
    legacyCipher.update(legacyPlaintext), legacyCipher.final(),
  ]);
  assert.throws(() => decryptMetaWhatsAppDispatchCredentials({
    binding: BINDING,
    envelope: {
      algorithm: 'aes-256-gcm-v1',
      keyVersion: 'render-kms-v1',
      ivBase64: legacyIv.toString('base64'),
      ciphertextBase64: legacyCiphertext.toString('base64'),
      authTagBase64: legacyCipher.getAuthTag().toString('base64'),
      aadSha256: digest(legacyAad),
      secretPayloadSha256: digest(legacyPlaintext),
    },
    encryptionKey: KEY,
    expectedKeyVersion: 'render-kms-v1',
  }), MetaWhatsAppLiveError);
});

test('runtime defaults OFF and accepts only the complete explicit live switch tuple', () => {
  assert.deepEqual(loadMetaWhatsAppLiveRuntimeConfig({}), {
    mode: 'disabled', providerEffectsEnabled: false, emergencyPaused: true,
    maximumOperationsPerCycle: 1, maximumRecipientsPerJob: 1,
    maximumTemplatesPerJob: 1, dailySendCap: 1, monthlySendCap: 3,
  });
  for (const env of [
    { PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED: 'true' },
    { PROPERTY_PREDATOR_WHATSAPP_EMERGENCY_PAUSED: 'false' },
    { PROPERTY_PREDATOR_WHATSAPP_LIVE_MODE: 'owned_template_live' },
    { PROPERTY_PREDATOR_WHATSAPP_LIVE_MODE: 'owned_template_live',
      PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED: 'true',
      PROPERTY_PREDATOR_WHATSAPP_EMERGENCY_PAUSED: 'false' },
  ]) assert.throws(() => loadMetaWhatsAppLiveRuntimeConfig(env), MetaWhatsAppLiveError);
  assert.equal(loadMetaWhatsAppLiveRuntimeConfig({
    PROPERTY_PREDATOR_WHATSAPP_LIVE_MODE: 'owned_template_live',
    PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED: 'true',
    PROPERTY_PREDATOR_WHATSAPP_EMERGENCY_PAUSED: 'false',
    PROPERTY_PREDATOR_WHATSAPP_LIVE_PROVIDER_ID: 'meta_whatsapp_cloud',
  }).mode, 'owned_template_live');
});

test('direct Graph transport is explicit-fetch, one-recipient, one-template and bounded', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const transport = createMetaWhatsAppLiveTransport({
    binding: BINDING,
    credentials: DISPATCH_CREDENTIALS,
    providerEffectsEnabled: true,
    emergencyPaused: false,
    fetch: async (input, init = {}) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ messaging_product: 'whatsapp',
        contacts: [{ input: '447700900123', wa_id: '447700900123' }],
        messages: [{ id: 'wamid.OWNED_TEMPLATE_PROOF_1' }] }), { status: 200 });
    },
    now: () => new Date('2026-08-29T10:00:00.000Z'),
  });
  const result = await transport.sendTemplate({
    binding: BINDING,
    recipient: '447700900123',
    templateName: 'property_predator_owned_proof',
    languageCode: 'en_GB',
    operationId: IDS.operation,
    requestSha256: digest('exact-owned-template'),
  });
  assert.equal(result.state, 'accepted');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url,
    'https://graph.facebook.com/v24.0/300001234567890/messages');
  assert.equal(calls[0]?.init.redirect, 'error');
  assert.equal((calls[0]?.init.headers as Record<string, string>).Authorization,
    `Bearer ${DISPATCH_CREDENTIALS.accessToken}`);
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
    messaging_product: 'whatsapp', to: '447700900123', type: 'template',
    template: { name: 'property_predator_owned_proof', language: { code: 'en_GB' } },
  });

  for (const contacts of [
    undefined,
    [{ input: '447700900999', wa_id: '447700900999' }],
    [{ input: '447700900123', wa_id: '447700900999' }],
    [{ input: '447700900123', wa_id: '447700900123' },
      { input: '447700900123', wa_id: '447700900123' }],
  ]) {
    const unbound = createMetaWhatsAppLiveTransport({
      binding: BINDING, credentials: DISPATCH_CREDENTIALS, providerEffectsEnabled: true,
      emergencyPaused: false,
      fetch: async () => new Response(JSON.stringify({ messaging_product: 'whatsapp',
        contacts, messages: [{ id: 'wamid.UNBOUND_CONTACT' }] }), { status: 200 }),
    });
    assert.equal((await unbound.sendTemplate({
      binding: BINDING, recipient: '447700900123',
      templateName: 'property_predator_owned_proof', languageCode: 'en_GB',
      operationId: IDS.operation, requestSha256: digest('exact-owned-template'),
    })).state, 'outcome_unknown');
  }

  const oversized = createMetaWhatsAppLiveTransport({
    binding: BINDING, credentials: DISPATCH_CREDENTIALS, providerEffectsEnabled: true,
    emergencyPaused: false,
    fetch: async () => new Response('x', { status: 200,
      headers: { 'content-length': '65537' } }),
  });
  await assert.rejects(() => oversized.sendTemplate({
    binding: BINDING, recipient: '447700900123',
    templateName: 'property_predator_owned_proof', languageCode: 'en_GB',
    operationId: IDS.operation, requestSha256: digest('exact-owned-template'),
  }), (error: unknown) => error instanceof MetaWhatsAppLiveError
    && error.code === 'provider_response_invalid');
});

function signedWebhook(payload: unknown): Readonly<{
  rawBody: Buffer;
  xHubSignature256: string;
}> {
  const rawBody = Buffer.from(JSON.stringify(payload), 'utf8');
  return Object.freeze({ rawBody,
    xHubSignature256: `sha256=${createHmac('sha256', WEBHOOK_SECRETS.appSecret)
      .update(rawBody).digest('hex')}` });
}

function webhookFixture(overrides: Readonly<{ duplicateConflict?: boolean }> = {}): unknown {
  const statuses = [{ id: 'wamid.OWNED_TEMPLATE_PROOF_1', recipient_id: '447700900123',
    status: 'delivered', timestamp: '1787997600' }];
  if (overrides.duplicateConflict) statuses.push({ ...statuses[0]!, recipient_id: '447700900999' });
  return { object: 'whatsapp_business_account', entry: [{ id: BINDING.wabaId,
    changes: [{ field: 'messages', value: { messaging_product: 'whatsapp',
      metadata: { phone_number_id: BINDING.phoneNumberId },
      messages: [{ id: 'wamid.INBOUND_1', from: '447700900456', timestamp: '1787997600',
        type: 'text', text: { body: 'Yes, tell me more.' } }], statuses } }] }] };
}

test('challenge and signed raw webhook enforce exact secret, WABA, phone and replay conflict', () => {
  assert.deepEqual(verifyMetaWhatsAppLiveChallenge(WEBHOOK_SECRETS, {
    mode: 'subscribe', verifyToken: WEBHOOK_SECRETS.verifyToken, challenge: 'owned-proof-challenge',
  }), { status: 200, body: 'owned-proof-challenge' });
  assert.equal(verifyMetaWhatsAppLiveChallenge(WEBHOOK_SECRETS, {
    mode: 'subscribe', verifyToken: 'wrong-token-but-valid-length-1234567890', challenge: 'x',
  }).status, 403);

  const signed = signedWebhook(webhookFixture());
  const verified = verifyMetaWhatsAppLiveWebhook({
    binding: BINDING, appSecret: WEBHOOK_SECRETS.appSecret, ...signed,
    contentType: 'application/json; charset=utf-8',
  });
  assert.equal(verified.events.length, 2);
  assert.equal(verified.signatureSha256, signed.xHubSignature256.slice('sha256='.length));
  assert.deepEqual(verified.events.map((event) => event.kind), ['inbound', 'status']);
  assert.equal(verified.events[0]?.workspaceId, IDS.workspace);

  assert.throws(() => verifyMetaWhatsAppLiveWebhook({
    binding: BINDING, appSecret: WEBHOOK_SECRETS.appSecret, rawBody: signed.rawBody,
    xHubSignature256: `sha256=${'0'.repeat(64)}`, contentType: 'application/json',
  }), (error: unknown) => error instanceof MetaWhatsAppLiveError
    && error.code === 'signature_invalid');
  const conflict = signedWebhook(webhookFixture({ duplicateConflict: true }));
  assert.throws(() => verifyMetaWhatsAppLiveWebhook({
    binding: BINDING, appSecret: WEBHOOK_SECRETS.appSecret, ...conflict,
    contentType: 'application/json',
  }), (error: unknown) => error instanceof MetaWhatsAppLiveError
    && error.code === 'webhook_invalid');
  assert.throws(() => verifyMetaWhatsAppLiveWebhook({
    binding: { ...BINDING, phoneNumberId: '900001234567890' },
    appSecret: WEBHOOK_SECRETS.appSecret, ...signed, contentType: 'application/json',
  }), (error: unknown) => error instanceof MetaWhatsAppLiveError
    && error.code === 'invalid_binding');
});

test('verified inbound and statuses expose only the durable inbox/Lead360 command seam', async () => {
  const signed = signedWebhook(webhookFixture());
  const verified = verifyMetaWhatsAppLiveWebhook({
    binding: BINDING, appSecret: WEBHOOK_SECRETS.appSecret, ...signed,
    contentType: 'application/json',
  });
  const received: string[] = [];
  const outcome = await dispatchVerifiedMetaWhatsAppLiveEvents({
    verified,
    commandService: {
      workspaceId: IDS.workspace,
      connectionId: IDS.connection,
      async recordStatus({ event, payloadSha256 }) {
        assert.equal(payloadSha256, verified.payloadSha256);
        received.push(`status:${event.status}`);
        return 'applied';
      },
      async recordInbound({ event, payloadSha256, signatureSha256, projection }) {
        assert.equal(payloadSha256, verified.payloadSha256);
        assert.equal(signatureSha256, verified.signatureSha256);
        assert.equal(projection, 'conversion_inbox_and_lead360');
        received.push(`inbound:${event.bodySha256}`);
        return 'applied';
      },
    },
  });
  assert.deepEqual(outcome, { applied: 2, replayed: 0 });
  assert.equal(received.length, 2);
});

test('signed deleted status is preserved as a durable terminal status', () => {
  const fixture = webhookFixture() as {
    entry: Array<{ changes: Array<{ value: { messages: unknown[]; statuses: Array<Record<string, unknown>> } }> }>;
  };
  fixture.entry[0]!.changes[0]!.value.messages = [];
  fixture.entry[0]!.changes[0]!.value.statuses[0]!.status = 'deleted';
  const signed = signedWebhook(fixture);
  const verified = verifyMetaWhatsAppLiveWebhook({
    binding: BINDING, appSecret: WEBHOOK_SECRETS.appSecret, ...signed,
    contentType: 'application/json',
  });
  assert.equal(verified.events.length, 1);
  assert.equal(verified.events[0]?.kind, 'status');
  assert.equal(verified.events[0]?.kind === 'status' ? verified.events[0].status : null,
    'deleted');
});

class MemoryRepository implements MetaWhatsAppLiveRepository {
  readonly claim: MetaWhatsAppLiveClaim = Object.freeze({
    workspaceId: IDS.workspace, connectionId: IDS.connection, bindingId: IDS.binding,
    jobId: IDS.job, leaseVersion: 1,
  });
  order: string[] = [];
  settled: MetaWhatsAppDispatchResult | null = null;
  async claimOne(): Promise<MetaWhatsAppLiveClaim> { this.order.push('claim'); return this.claim; }
  async loadClaimed(): Promise<MetaWhatsAppLiveMaterial> {
    this.order.push('load');
    return Object.freeze({ ...this.claim, binding: BINDING, envelope: ENVELOPE,
      recipient: '447700900123', templateName: 'property_predator_owned_proof',
      languageCode: 'en_GB', operationId: IDS.operation,
      requestSha256: digest('exact-owned-template') });
  }
  async markCalling(): Promise<boolean> { this.order.push('calling'); return true; }
  async settle(input: MetaWhatsAppLiveClaim & Readonly<{
    leaseToken: Buffer; result: MetaWhatsAppDispatchResult;
  }>): Promise<void> { this.order.push('settled'); this.settled = input.result; }
}

test('worker crosses durable calling fence before transport and makes ambiguity non-retriable', async () => {
  const repository = new MemoryRepository();
  const result = await runMetaWhatsAppLiveOnce({
    config: loadMetaWhatsAppLiveRuntimeConfig({
      PROPERTY_PREDATOR_WHATSAPP_LIVE_MODE: 'owned_template_live',
      PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED: 'true',
      PROPERTY_PREDATOR_WHATSAPP_EMERGENCY_PAUSED: 'false',
      PROPERTY_PREDATOR_WHATSAPP_LIVE_PROVIDER_ID: 'meta_whatsapp_cloud',
    }),
    repository, encryptionKey: KEY, encryptionKeyVersion: 'render-kms-v1', leaseToken: LEASE,
    createTransport: ({ credentials }) => {
      assert.deepEqual(Object.keys(credentials), ['accessToken']);
      assert.equal('appSecret' in credentials, false);
      assert.equal('verifyToken' in credentials, false);
      return {
        contract: 'propertypredator.meta-whatsapp-live/v1', executionMode: 'owned_template_live',
        async sendTemplate() {
          repository.order.push('transport');
          throw new Error('socket closed after write');
        },
      };
    },
  });
  assert.equal(result, 'failed_or_attention');
  assert.deepEqual(repository.order, ['claim', 'load', 'calling', 'transport', 'settled']);
  assert.equal(repository.settled?.state, 'outcome_unknown');
});
