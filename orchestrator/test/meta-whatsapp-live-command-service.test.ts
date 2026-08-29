import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { PgMetaWhatsAppLiveCommandService } from '../src/whatsapp-live-pg/index.js';
import { encryptMetaWhatsAppDispatchCredentials } from '../src/whatsapp-live/index.js';

const ids = ['11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555',
  '66666666-6666-4666-8666-666666666666', '77777777-7777-4777-8777-777777777777',
  '88888888-8888-4888-8888-888888888888', '99999999-9999-4999-8999-999999999999',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'ffffffff-ffff-4fff-8fff-ffffffffffff'] as const;
const [WORKSPACE, USER, CONNECTION, BINDING, TEMPLATE, CONTENT, VERSION, REQUEST,
  DECISION, CONTACT, POINT, CONSENT, SUBJECT, PUBLICATION, SENDER] = ids;
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const dispatchCredentials = {
  accessToken: 'EAAG-OWNED-PROPERTY-PREDATOR-TOKEN-123456789',
};
const binding = { workspaceId: WORKSPACE, connectionId: CONNECTION,
  appId: '100001234567890', wabaId: '200001234567890',
  phoneNumberId: '300001234567890', graphApiVersion: 'v24.0' as const };

test('command service carries encrypted evidence only and enqueues by authority IDs, never recipient', async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const client = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      if (sql.includes('lock_active_portal_session')) return { rows: [{ active: true }] };
      if (sql.includes('record_whatsapp_live_binding')) return { rows: [{ id: BINDING }] };
      if (sql.includes('authorize_and_enqueue_whatsapp_live_job')) return { rows: [{ id: TEMPLATE }] };
      return { rows: [] };
    }, release() { /* test client */ },
  };
  const service = new PgMetaWhatsAppLiveCommandService({
    commandPool: { connect: async () => client } as never, workspaceId: WORKSPACE,
  });
  const context = { actorKind: 'user' as const, workspaceId: WORKSPACE, userId: USER,
    requestId: 'founder-reviewed-whatsapp-command',
    portalSessionTokenHash: Buffer.alloc(32, 4) };
  const envelope = encryptMetaWhatsAppDispatchCredentials({ binding,
    credentials: dispatchCredentials,
    encryptionKey: Buffer.alloc(32, 7), keyVersion: 'render-kms-v1', iv: Buffer.alloc(12, 3) });
  assert.equal(await service.recordBinding(context, { binding: { ...binding, bindingId: BINDING },
    ownedPhoneSha256: digest('owned-phone'), envelope,
    ownershipEvidenceSha256: digest('owned-evidence'),
    ownershipObservedAt: '2026-08-29T10:00:00.000Z', predecessorBindingId: null }), BINDING);
  const bindingCall = calls.find((call) => call.sql.includes('record_whatsapp_live_binding'))!;
  assert.equal(bindingCall.values?.includes(dispatchCredentials.accessToken), false);
  assert.ok(bindingCall.values?.some((value) => Buffer.isBuffer(value)));

  await assert.rejects(service.recordBinding(context, {
    binding: { ...binding, bindingId: BINDING },
    ownedPhoneSha256: digest('owned-phone'),
    envelope: { ...envelope,
      appSecret: 'property-predator-meta-app-secret-should-be-rejected' } as never,
    ownershipEvidenceSha256: digest('owned-evidence'),
    ownershipObservedAt: '2026-08-29T10:00:00.000Z',
    predecessorBindingId: null,
  }), /binding command is invalid/u);

  assert.equal(await service.authorizeAndEnqueue(context, {
    bindingId: BINDING, templateId: TEMPLATE, contactId: CONTACT, contactPointId: POINT,
    consentEventId: CONSENT, complianceSubjectId: SUBJECT,
    policyPublicationEventId: PUBLICATION, pecrSenderDecisionEventId: SENDER,
    pecrInstigatorDecisionEventId: ids[0], permissionUseReceiptId: ids[1],
    purpose: 'owned_proof', authorityValidUntil: '2026-08-29T10:10:00.000Z',
    operationId: ids[2], idempotencyKeySha256: digest('idempotency'),
    requestSha256: digest('request'),
  }), TEMPLATE);
  const enqueue = calls.find((call) => call.sql.includes('authorize_and_enqueue'))!;
  assert.equal(enqueue.values?.includes('447700900123'), false);
  assert.match(enqueue.sql, /permission|authorize_and_enqueue_whatsapp_live_job/u);
  assert.ok(calls.some((call) => call.sql.includes("set_config('app.user_id'")));
});

test('command service rejects cross-workspace execution before acquiring a client', async () => {
  let connected = false;
  const service = new PgMetaWhatsAppLiveCommandService({ workspaceId: WORKSPACE,
    commandPool: { connect: async () => { connected = true; return {} as never; } } as never });
  await assert.rejects(service.revokeBinding({ actorKind: 'user', userId: USER,
    workspaceId: CONNECTION, requestId: 'cross-workspace',
    portalSessionTokenHash: Buffer.alloc(32, 4) },
  { bindingId: BINDING, evidenceSha256: digest('revoke') }), /trusted workspace/u);
  assert.equal(connected, false);
});
