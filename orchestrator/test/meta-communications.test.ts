import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  META_SOCIAL_DM_PROVIDER_ID,
  META_WHATSAPP_PROVIDER_ID,
  MetaIdempotencyConflictError,
  MetaProviderEffectsDisabledError,
  createDefaultMetaDarkControls,
  createMetaOutboundControlEvidence,
  createMetaOutboundEvidence,
  createMetaScriptedHttpTransport,
  createMetaSocialDmCredentialBundle,
  createMetaWhatsAppCredentialBundle,
  metaCanonicalSha256,
  readMetaContractHttpRequests,
  verifyMetaWebhookChallenge,
} from '../src/meta-communications/index.js';
import {
  MetaWhatsAppCloudContractAdapter,
  ingestMetaWhatsAppWebhook,
  toMetaWhatsAppInboxCommand,
} from '../src/whatsapp-dark/index.js';
import {
  MetaSocialDmContractAdapter,
  createMetaConversationWindowEvidence,
  ingestMetaSocialDmWebhook,
  toMetaSocialDmInboxCommand,
} from '../src/social-dm-dark/index.js';
import type { ProviderOperationContext } from '../src/providers/contracts.js';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const CONNECTION_ID = '22222222-2222-4222-8222-222222222222';
const POLICY_ID = '33333333-3333-4333-8333-333333333333';
const MESSAGE_VERSION_ID = '44444444-4444-4444-8444-444444444444';
const NOW = '2026-08-28T12:00:00.000Z';
const VALID_UNTIL = '2026-08-28T13:00:00.000Z';
const ACCESS_TOKEN = 'opaque-meta-access-token-never-persist-this-value';
const APP_SECRET = 'meta-app-secret-00000000000000000000000001';
const VERIFY_TOKEN = 'meta-webhook-verify-token-000000000000001';

const whatsappCredentials = createMetaWhatsAppCredentialBundle({
  workspaceId: WORKSPACE_ID, connectionId: CONNECTION_ID,
  appId: '123456789012345', wabaId: '234567890123456', phoneNumberId: '345678901234567',
  graphApiVersion: 'v24.0', credentialVersion: 'secret-manager-v7',
  accessToken: ACCESS_TOKEN, appSecret: APP_SECRET, verifyToken: VERIFY_TOKEN,
});

const facebookCredentials = createMetaSocialDmCredentialBundle({
  workspaceId: WORKSPACE_ID, connectionId: CONNECTION_ID, network: 'facebook',
  appId: '123456789012345', pageId: '456789012345678', instagramAccountId: null,
  graphApiVersion: 'v24.0', credentialVersion: 'secret-manager-v8',
  accessToken: ACCESS_TOKEN, appSecret: APP_SECRET, verifyToken: VERIFY_TOKEN,
});

const instagramCredentials = createMetaSocialDmCredentialBundle({
  workspaceId: WORKSPACE_ID, connectionId: CONNECTION_ID, network: 'instagram',
  appId: '123456789012345', pageId: '456789012345678', instagramAccountId: '678901234567890',
  graphApiVersion: 'v24.0', credentialVersion: 'secret-manager-v9',
  accessToken: ACCESS_TOKEN, appSecret: APP_SECRET, verifyToken: VERIFY_TOKEN,
});

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function signature(rawBody: Uint8Array): string {
  return `sha256=${createHmac('sha256', APP_SECRET).update(rawBody).digest('hex')}`;
}

function evidence(channel: 'whatsapp' | 'facebook' | 'instagram', recipientSha256: string, bodySha256: string) {
  return createMetaOutboundEvidence({
    workspaceId: WORKSPACE_ID, connectionId: CONNECTION_ID, channel, recipientSha256,
    messageVersionId: MESSAGE_VERSION_ID, messageVersionNumber: 4, bodySha256,
    approvalDecisionId: '55555555-5555-4555-8555-555555555555', approvalDecision: 'approved',
    approvalVersionId: MESSAGE_VERSION_ID,
    consentEvidenceId: '66666666-6666-4666-8666-666666666666', consentDecision: 'eligible',
    consentValidUntil: VALID_UNTIL,
    pecrDecisionId: '77777777-7777-4777-8777-777777777777', pecrDecision: 'eligible',
    pecrValidUntil: VALID_UNTIL,
    instigatorDecisionId: '88888888-8888-4888-8888-888888888888',
    instigatorDecision: 'eligible', instigatorType: channel === 'whatsapp' ? 'human_operator' : 'customer_inbound',
    evaluatedAt: NOW,
  });
}

function controls(overrides: Partial<Parameters<typeof createMetaOutboundControlEvidence>[0]> = {}) {
  return createMetaOutboundControlEvidence({
    workspaceId: WORKSPACE_ID, connectionId: CONNECTION_ID, policyVersionId: POLICY_ID,
    emergencyPaused: false, providerEffects: false, evaluatedAt: NOW, validUntil: VALID_UNTIL,
    rateLimit: 10, rateUsed: 1, volumeLimit: 20, volumeUsed: 2,
    spendCurrency: 'GBP', spendLimitMinor: 1_000, spendUsedMinor: 100, estimatedSpendMinor: 5,
    ...overrides,
  });
}

function context(providerId: string, operationId = '99999999-9999-4999-8999-999999999999'):
ProviderOperationContext {
  return Object.freeze({
    workspaceId: WORKSPACE_ID, connectionId: CONNECTION_ID, providerId, operationId,
    idempotencyKey: 'meta-operation-1', correlationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  });
}

test('opaque Meta credentials support the exact GET verification ceremony without serialising secrets', () => {
  assert.deepEqual(verifyMetaWebhookChallenge(whatsappCredentials, {
    hubMode: 'subscribe', hubVerifyToken: VERIFY_TOKEN, hubChallenge: '17290123',
  }), { status: 200, body: '17290123' });
  assert.deepEqual(verifyMetaWebhookChallenge(whatsappCredentials, {
    hubMode: 'subscribe', hubVerifyToken: 'wrong-token-that-is-long-enough', hubChallenge: '17290123',
  }), { status: 403, body: '' });
  assert.deepEqual(verifyMetaWebhookChallenge(whatsappCredentials, {
    hubMode: 'wrong', hubVerifyToken: VERIFY_TOKEN, hubChallenge: '17290123',
  }), { status: 400, body: '' });
  const serialized = JSON.stringify({ whatsappCredentials, facebookCredentials });
  assert.doesNotMatch(serialized, new RegExp(ACCESS_TOKEN));
  assert.doesNotMatch(serialized, new RegExp(APP_SECRET));
  assert.doesNotMatch(serialized, new RegExp(VERIFY_TOKEN));
  assert.match(serialized, /\[REDACTED\]/);
  assert.throws(() => verifyMetaWebhookChallenge({ ...whatsappCredentials }, {
    hubMode: 'subscribe', hubVerifyToken: VERIFY_TOKEN, hubChallenge: '1',
  }), /not authentic/);
  assert.throws(() => createMetaWhatsAppCredentialBundle({
    workspaceId: WORKSPACE_ID, connectionId: CONNECTION_ID,
    appId: '123456789012345', wabaId: '234567890123456', phoneNumberId: 'phone-id',
    graphApiVersion: 'v24.0', credentialVersion: 'v1', accessToken: ACCESS_TOKEN,
    appSecret: APP_SECRET, verifyToken: VERIFY_TOKEN,
  }), /phoneNumberId is invalid/);
  assert.throws(() => createMetaSocialDmCredentialBundle({
    workspaceId: WORKSPACE_ID, connectionId: CONNECTION_ID, network: 'facebook',
    appId: '123456789012345', pageId: 'page-id', instagramAccountId: null,
    graphApiVersion: 'v24.0', credentialVersion: 'v1', accessToken: ACCESS_TOKEN,
    appSecret: APP_SECRET, verifyToken: VERIFY_TOKEN,
  }), /pageId is invalid/);
});

test('WhatsApp signed raw-body ingestion binds WABA/phone/sender and normalises only verified text to inbox', () => {
  const body = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: whatsappCredentials.wabaId, changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp',
      metadata: { display_phone_number: '15551230000', phone_number_id: whatsappCredentials.phoneNumberId },
      contacts: [{ profile: { name: 'Example' }, wa_id: '15551234567' }],
      messages: [{ from: '15551234567', id: 'wamid.contract_inbound_1', timestamp: '1787918400',
        type: 'text', text: { body: 'Please send the details.' } }],
    } }] }],
  });
  const rawBody = new TextEncoder().encode(body);
  const signed = signature(rawBody);
  const events = ingestMetaWhatsAppWebhook({ credentials: whatsappCredentials, rawBody,
    xHubSignature256: signed, contentType: 'application/json; charset=utf-8' });
  assert.equal(events.length, 1);
  const event = events[0]!;
  const binding = {
    workspaceId: WORKSPACE_ID, connectionId: CONNECTION_ID,
    inboxId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    contactId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    contactPointId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', senderIdSha256: sha256('15551234567'),
  };
  const command = toMetaWhatsAppInboxCommand(event, binding);
  assert.equal(command.body, 'Please send the details.');
  assert.match(command.commandKey, /^meta-whatsapp-inbound:[a-f0-9]{64}$/);
  assert.deepEqual(toMetaWhatsAppInboxCommand(event, binding), command);
  assert.throws(() => toMetaWhatsAppInboxCommand({ ...event }, binding), /must be verified/);

  const tampered = Uint8Array.from(rawBody);
  tampered[tampered.length - 3] = tampered[tampered.length - 3]! ^ 1;
  assert.throws(() => ingestMetaWhatsAppWebhook({ credentials: whatsappCredentials, rawBody: tampered,
    xHubSignature256: signed, contentType: 'application/json' }), /signature is invalid/);
  const wrongPhone = new TextEncoder().encode(body.replace(whatsappCredentials.phoneNumberId, '999999999999999'));
  assert.throws(() => ingestMetaWhatsAppWebhook({ credentials: whatsappCredentials, rawBody: wrongPhone,
    xHubSignature256: signature(wrongPhone), contentType: 'application/json' }),
  /not bound to this phone/);

  const replayPayload = JSON.parse(body) as {
    entry: Array<{ changes: Array<{ value: { messages: Array<Record<string, unknown>> } }> }>;
  };
  replayPayload.entry[0]!.changes[0]!.value.messages.push({
    ...replayPayload.entry[0]!.changes[0]!.value.messages[0], text: { body: 'Conflicting replay.' },
  });
  const replayRaw = new TextEncoder().encode(JSON.stringify(replayPayload));
  assert.throws(() => ingestMetaWhatsAppWebhook({ credentials: whatsappCredentials, rawBody: replayRaw,
    xHubSignature256: signature(replayRaw), contentType: 'application/json' }), /replay conflict/);
  const oversized = new Uint8Array(256 * 1024 + 1);
  assert.throws(() => ingestMetaWhatsAppWebhook({ credentials: whatsappCredentials, rawBody: oversized,
    xHubSignature256: signature(oversized), contentType: 'application/json' }), /body is invalid/);
});

test('WhatsApp adapter is disabled by default and contract mode enforces evidence, gates, replay, and redaction', async () => {
  const template = { templateName: 'approved_follow_up', languageCode: 'en_GB',
    bodyParameters: ['Alex', 'Friday'] as const };
  const canonical = { templateName: template.templateName, languageCode: template.languageCode,
    bodyParameters: template.bodyParameters };
  const recipient = '15551234567';
  const request = { recipient, ...template,
    evidence: evidence('whatsapp', sha256(recipient), metaCanonicalSha256(canonical)), controls: controls() };
  await assert.rejects(new MetaWhatsAppCloudContractAdapter().sendTemplate(
    context(META_WHATSAPP_PROVIDER_ID), request,
  ), MetaProviderEffectsDisabledError);

  const transport = createMetaScriptedHttpTransport([{ kind: 'response', status: 200,
    bodyUtf8: JSON.stringify({ messaging_product: 'whatsapp', contacts: [{ input: recipient,
      wa_id: recipient }], messages: [{ id: 'wamid.contract_outbound_1' }] }) }]);
  const adapter = new MetaWhatsAppCloudContractAdapter({ executionMode: 'contract_test',
    credentials: whatsappCredentials, http: transport, observedAt: NOW });
  const first = await adapter.sendTemplate(context(META_WHATSAPP_PROVIDER_ID), request);
  const replay = await adapter.sendTemplate(context(META_WHATSAPP_PROVIDER_ID), request);
  assert.equal(first.status, 'contract_accepted');
  assert.equal(first.providerEffectAttempted, false);
  assert.equal(first.providerEffectsEnabled, false);
  assert.equal(replay.disposition, 'replayed');
  assert.equal(readMetaContractHttpRequests(transport).length, 1);
  const recorded = readMetaContractHttpRequests(transport)[0]!;
  assert.equal(recorded.headers.Authorization, 'Bearer [REDACTED]');
  assert.doesNotMatch(JSON.stringify(recorded), new RegExp(ACCESS_TOKEN));
  assert.equal(recorded.url,
    `https://graph.facebook.com/v24.0/${whatsappCredentials.phoneNumberId}/messages`);
  assert.deepEqual(JSON.parse(recorded.bodyUtf8), {
    messaging_product: 'whatsapp', to: recipient, type: 'template', template: {
      name: 'approved_follow_up', language: { code: 'en_GB' },
      components: [{ type: 'body', parameters: [{ type: 'text', text: 'Alex' },
        { type: 'text', text: 'Friday' }] }],
    },
  });

  const changedCanonical = { ...canonical, bodyParameters: ['Alex', 'Monday'] };
  await assert.rejects(adapter.sendTemplate(context(META_WHATSAPP_PROVIDER_ID), {
    ...request, bodyParameters: ['Alex', 'Monday'],
    evidence: evidence('whatsapp', sha256(recipient), metaCanonicalSha256(changedCanonical)),
  }), MetaIdempotencyConflictError);
  await assert.rejects(adapter.sendTemplate({ ...context(META_WHATSAPP_PROVIDER_ID),
    correlationId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }, request), MetaIdempotencyConflictError);
  await assert.rejects(new MetaWhatsAppCloudContractAdapter({ executionMode: 'contract_test',
    credentials: whatsappCredentials,
    http: createMetaScriptedHttpTransport([{ kind: 'response', status: 200, bodyUtf8: '{}' }]), observedAt: NOW,
  }).sendTemplate(context(META_WHATSAPP_PROVIDER_ID), {
    ...request, controls: createDefaultMetaDarkControls({ workspaceId: WORKSPACE_ID,
      connectionId: CONNECTION_ID, policyVersionId: POLICY_ID, at: NOW }),
  }), /emergency pause/);
  await assert.rejects(new MetaWhatsAppCloudContractAdapter({ executionMode: 'contract_test',
    credentials: whatsappCredentials,
    http: createMetaScriptedHttpTransport([{ kind: 'response', status: 200, bodyUtf8: '{}' }]), observedAt: NOW,
  }).sendTemplate(context(META_WHATSAPP_PROVIDER_ID), {
    ...request, controls: controls({ rateLimit: 1, rateUsed: 1 }),
  }), /rate gate/);
});

test('Messenger webhook ingestion rejects echoes and maps verified customer text to the inbox seam', () => {
  const rawBody = new TextEncoder().encode(JSON.stringify({
    object: 'page', entry: [{ id: facebookCredentials.pageId, time: Date.parse(NOW), messaging: [
      { sender: { id: '567890123456789' }, recipient: { id: facebookCredentials.pageId },
        timestamp: Date.parse(NOW), message: { mid: 'm_inbound_1', text: 'Can you help?' } },
      { sender: { id: facebookCredentials.pageId }, recipient: { id: '567890123456789' },
        timestamp: Date.parse(NOW), message: { mid: 'm_echo_1', text: 'Echo', is_echo: true } },
    ] }],
  }));
  const events = ingestMetaSocialDmWebhook({ credentials: facebookCredentials, rawBody,
    xHubSignature256: signature(rawBody), contentType: 'application/json' });
  assert.equal(events.length, 1);
  const event = events[0]!;
  const command = toMetaSocialDmInboxCommand(event, {
    workspaceId: WORKSPACE_ID, connectionId: CONNECTION_ID, network: 'facebook',
    inboxId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    contactId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    contactPointId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    senderIdSha256: sha256('567890123456789'),
  });
  assert.equal(command.body, 'Can you help?');
  assert.match(command.commandKey, /^meta-social-dm-inbound:[a-f0-9]{64}$/);
});

test('social DM reply contract requires a current 24-hour window and all outbound evidence', async () => {
  const recipientId = '567890123456789';
  const text = 'Yes — here are the details.';
  const replyToMessageId = 'm_inbound_1';
  const bodySha256 = metaCanonicalSha256({ network: 'facebook', text, replyToMessageId });
  const window = createMetaConversationWindowEvidence({ inboundMessageId: replyToMessageId,
    openedAt: '2026-08-28T11:30:00.000Z', validUntil: '2026-08-28T13:00:00.000Z' });
  const request = { network: 'facebook' as const, recipientId, text, replyToMessageId,
    conversationWindow: window, evidence: evidence('facebook', sha256(recipientId), bodySha256), controls: controls() };
  const transport = createMetaScriptedHttpTransport([{ kind: 'response', status: 200,
    bodyUtf8: JSON.stringify({ recipient_id: recipientId, message_id: 'm_contract_reply_1' }) }]);
  const adapter = new MetaSocialDmContractAdapter({ executionMode: 'contract_test',
    credentials: facebookCredentials, http: transport, observedAt: NOW });
  const result = await adapter.reply(context(META_SOCIAL_DM_PROVIDER_ID), request);
  assert.equal(result.status, 'contract_accepted');
  assert.equal(result.providerEffectAttempted, false);
  const recorded = readMetaContractHttpRequests(transport)[0]!;
  assert.equal(recorded.url,
    `https://graph.facebook.com/v24.0/${facebookCredentials.pageId}/messages`);
  assert.equal(recorded.headers.Authorization, 'Bearer [REDACTED]');
  assert.deepEqual(JSON.parse(recorded.bodyUtf8), { recipient: { id: recipientId }, message: { text } });

  const expiredWindow = createMetaConversationWindowEvidence({ inboundMessageId: replyToMessageId,
    openedAt: '2026-08-27T10:00:00.000Z', validUntil: '2026-08-27T11:00:00.000Z' });
  await assert.rejects(new MetaSocialDmContractAdapter({ executionMode: 'contract_test',
    credentials: facebookCredentials,
    http: createMetaScriptedHttpTransport([{ kind: 'response', status: 200, bodyUtf8: '{}' }]), observedAt: NOW,
  }).reply({ ...context(META_SOCIAL_DM_PROVIDER_ID), operationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' }, {
    ...request, conversationWindow: expiredWindow,
  }), /conversation window is not current/);
  assert.throws(() => createMetaConversationWindowEvidence({ inboundMessageId: replyToMessageId,
    openedAt: '2026-08-27T10:00:00.000Z', validUntil: '2026-08-28T10:00:00.001Z' }), /24-hour/);
});

test('Instagram professional-account webhooks and reply endpoint remain account/network bound', async () => {
  const senderId = '789012345678901';
  const inboundId = 'ig_mid_inbound_1';
  const rawBody = new TextEncoder().encode(JSON.stringify({
    object: 'instagram', entry: [{ id: instagramCredentials.instagramAccountId, time: Date.parse(NOW),
      messaging: [{ sender: { id: senderId }, recipient: { id: instagramCredentials.instagramAccountId },
        timestamp: Date.parse(NOW), message: { mid: inboundId, text: 'Instagram enquiry.' } }] }],
  }));
  const events = ingestMetaSocialDmWebhook({ credentials: instagramCredentials, rawBody,
    xHubSignature256: signature(rawBody), contentType: 'application/json' });
  assert.equal(events[0]?.network, 'instagram');
  assert.throws(() => ingestMetaSocialDmWebhook({ credentials: facebookCredentials, rawBody,
    xHubSignature256: signature(rawBody), contentType: 'application/json' }),
  /credential network/);

  const replyText = 'Instagram reply.';
  const bodySha256 = metaCanonicalSha256({ network: 'instagram', text: replyText, replyToMessageId: inboundId });
  const transport = createMetaScriptedHttpTransport([{ kind: 'response', status: 200,
    bodyUtf8: JSON.stringify({ recipient_id: senderId, message_id: 'ig_contract_reply_1' }) }]);
  const adapter = new MetaSocialDmContractAdapter({ executionMode: 'contract_test',
    credentials: instagramCredentials, http: transport, observedAt: NOW });
  const result = await adapter.reply({ ...context(META_SOCIAL_DM_PROVIDER_ID),
    operationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', idempotencyKey: 'instagram-reply-1' }, {
    network: 'instagram', recipientId: senderId, text: replyText, replyToMessageId: inboundId,
    conversationWindow: createMetaConversationWindowEvidence({ inboundMessageId: inboundId,
      openedAt: '2026-08-28T11:30:00.000Z', validUntil: VALID_UNTIL }),
    evidence: evidence('instagram', sha256(senderId), bodySha256), controls: controls(),
  });
  assert.equal(result.status, 'contract_accepted');
  assert.equal(readMetaContractHttpRequests(transport)[0]?.url,
    `https://graph.instagram.com/v24.0/${instagramCredentials.instagramAccountId}/messages`);
});

test('Meta communication adapters contain no live HTTP implementation or token-bearing evidence path', async () => {
  const files = [
    '../src/meta-communications/contracts.ts',
    '../src/whatsapp-dark/meta-cloud.ts',
    '../src/social-dm-dark/meta-platform.ts',
  ];
  const source = (await Promise.all(files.map((path) => readFile(new URL(path, import.meta.url), 'utf8')))).join('\n');
  assert.doesNotMatch(source, /\bfetch\s*\(|node:https|node:http|axios|executionMode\s*:\s*['"]live['"]/u);
  assert.doesNotMatch(source, /providerEffectsEnabled:\s*true|providerEffectAttempted:\s*true/u);
  assert.match(source, /providerEffectsEnabled\s*=\s*false/g);
  assert.match(source, /Bearer \[REDACTED\]/);
});
