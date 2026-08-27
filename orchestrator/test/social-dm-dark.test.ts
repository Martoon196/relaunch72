import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { ProviderOperationContext } from '../src/providers/contracts.js';
import {
  SOCIAL_DM_DARK_CAPABILITY_MATRIX,
  SimulatedSocialDmDarkAdapter,
  SocialDmDarkContractError,
  createSignedSocialDmDarkInbound,
  createSocialDmDarkEvidence,
  socialDmDarkAddressSha256,
  toSocialDmOwnInboxCommand,
  verifySocialDmDarkInbound,
} from '../src/social-dm-dark/index.js';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const CONNECTION_ID = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-08-27T16:00:00.000Z');
const SECRET = 'social-dm-test-secret-00000000000000000001';
const context: ProviderOperationContext = Object.freeze({
  workspaceId: WORKSPACE_ID, connectionId: CONNECTION_ID,
  providerId: 'social_dm_dark_simulator',
  operationId: '33333333-3333-4333-8333-333333333333',
  idempotencyKey: 'social-dm-test-1',
  correlationId: '44444444-4444-4444-8444-444444444444',
});

const recipient = 'test-dm:instagram:property-predator-owned';
const evidence = createSocialDmDarkEvidence({
  workspaceId: WORKSPACE_ID, connectionId: CONNECTION_ID, network: 'instagram',
  recipientSha256: socialDmDarkAddressSha256(recipient),
  approvalId: '55555555-5555-4555-8555-555555555555',
  approvalDecision: 'approved_for_test_simulation',
  consentEvidenceId: '66666666-6666-4666-8666-666666666666',
  consentDecision: 'eligible_for_test_simulation',
  pecrSenderDecisionId: '77777777-7777-4777-8777-777777777777',
  pecrSenderDecision: 'eligible_for_test_simulation',
  operatorInstigatorDecisionId: '88888888-8888-4888-8888-888888888888',
  operatorInstigatorDecision: 'eligible_for_test_simulation',
  purpose: 'own_inbox_test',
});

test('capability matrix describes test mechanics without claiming live network capability', () => {
  assert.deepEqual(SOCIAL_DM_DARK_CAPABILITY_MATRIX.map((row) => row.network), [
    'facebook', 'instagram', 'linkedin', 'tiktok', 'x',
  ]);
  assert.ok(SOCIAL_DM_DARK_CAPABILITY_MATRIX.every((row) => (
    row.liveProviderCapability === 'unverified'
    && row.liveProviderConnected === false
    && row.simulatedAttachments === false
  )));
  assert.ok(Object.isFrozen(SOCIAL_DM_DARK_CAPABILITY_MATRIX));
  assert.ok(SOCIAL_DM_DARK_CAPABILITY_MATRIX.every(Object.isFrozen));
});

test('simulator refuses real or cross-network addresses and binds all decision evidence', async () => {
  const adapter = new SimulatedSocialDmDarkAdapter({ now: () => NOW });
  const request = { network: 'instagram' as const, recipient, text: 'Fictional test DM.',
    threadRef: null, replyToMessageRef: null, evidence };
  await assert.rejects(adapter.simulateMessage(context, { ...request, recipient: '@real-person' }), /test DM address/);
  await assert.rejects(adapter.simulateMessage(context, {
    ...request, recipient: 'test-dm:facebook:wrong-network',
  }), /network-bound/);
  await assert.rejects(adapter.simulateMessage(context, {
    ...request, evidence: { ...evidence, workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
  }), /not bound/);
  const result = await adapter.simulateMessage(context, request);
  assert.equal(result.status, 'simulated');
  assert.equal(result.externalMessageAttempted, false);
  assert.equal(result.providerOperationsCreated, 0);
  assert.match(result.testThreadRef, /^test-dm-thread_[a-f0-9]{32}$/);
  assert.doesNotMatch(JSON.stringify(adapter.audit), /Fictional test DM|property-predator-owned/);
  assert.equal(adapter.audit[0]?.externalMessageAttempted, false);
  await assert.rejects(adapter.simulateMessage(context, {
    ...request, text: 'Changed input under the same operation ID.',
  }), /reused with different test input/);
  await assert.doesNotReject(adapter.reconcileSimulation(context, result.testMessageRef));
  await assert.rejects(adapter.reconcileSimulation(context, 'test-dm-message_00000000000000000000000000000000'));
  await assert.rejects(new SimulatedSocialDmDarkAdapter({ now: () => NOW })
    .reconcileSimulation(context, result.testMessageRef));
});

test('signed simulated event becomes a unified-inbox command only after exact verification', () => {
  const signed = createSignedSocialDmDarkInbound({
    workspaceId: WORKSPACE_ID, connectionId: CONNECTION_ID, network: 'instagram',
    from: 'test-dm:instagram:fictional-lead', to: recipient,
    body: 'A fictional inbound DM.', occurredAt: NOW.toISOString(), testSecret: SECRET,
  });
  const event = verifySocialDmDarkInbound({ ...signed, testSecret: SECRET });
  const binding = {
    workspaceId: WORKSPACE_ID, connectionId: CONNECTION_ID,
    inboxId: '99999999-9999-4999-8999-999999999999',
    contactId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    contactPointId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    network: 'instagram' as const, ownedTestAddress: recipient,
    sourceTestAddress: 'test-dm:instagram:fictional-lead',
  };
  const command = toSocialDmOwnInboxCommand(event, binding);
  assert.equal(command.body, 'A fictional inbound DM.');
  assert.equal(command.commandKey, `social-dm-test-inbound:${event.eventId}`);
  assert.throws(() => toSocialDmOwnInboxCommand({ ...event }, binding), /authenticated before inbox mapping/);
  assert.throws(() => toSocialDmOwnInboxCommand(event, {
    ...binding, network: 'facebook',
    ownedTestAddress: 'test-dm:facebook:owned', sourceTestAddress: 'test-dm:facebook:source',
  }), /does not match/);
});

test('webhook snapshots signed bytes once and rejects tampering before parsing', () => {
  const signed = createSignedSocialDmDarkInbound({
    workspaceId: WORKSPACE_ID, connectionId: CONNECTION_ID, network: 'instagram',
    from: 'test-dm:instagram:source', to: recipient,
    body: 'Authenticated.', occurredAt: NOW.toISOString(), testSecret: SECRET,
  });
  const forged = createSignedSocialDmDarkInbound({
    workspaceId: WORKSPACE_ID, connectionId: CONNECTION_ID, network: 'instagram',
    from: 'test-dm:instagram:source', to: recipient,
    body: 'Counterfeited.', occurredAt: NOW.toISOString(), testSecret: SECRET,
  });
  let reads = 0;
  const event = verifySocialDmDarkInbound({
    get rawBody() { reads += 1; return reads === 1 ? signed.rawBody : forged.rawBody; },
    signature: signed.signature, contentType: signed.contentType, testSecret: SECRET,
  });
  assert.equal(reads, 1);
  assert.equal(event.event.body, 'Authenticated.');
  const tampered = Uint8Array.from(signed.rawBody);
  tampered[tampered.length - 2] = tampered[tampered.length - 2]! ^ 1;
  assert.throws(() => verifySocialDmDarkInbound({
    ...signed, rawBody: tampered, testSecret: SECRET,
  }), /signature is invalid/);
  assert.equal(signed.rawBody.byteLength, forged.rawBody.byteLength);
  const mutable = Uint8Array.from(signed.rawBody);
  assert.throws(() => verifySocialDmDarkInbound({
    rawBody: mutable,
    get signature() { mutable.set(forged.rawBody); return forged.signature; },
    contentType: signed.contentType,
    testSecret: SECRET,
  }), /signature is invalid/);
});

test('dark social-DM module has no external transport, provider registry or effect path', async () => {
  const source = (await Promise.all(['contracts.ts', 'simulator.ts', 'webhook.ts', 'index.ts'].map((name) => readFile(
    new URL(`../src/social-dm-dark/${name}`, import.meta.url), 'utf8',
  )))).join('\n');
  assert.doesNotMatch(source, /\bfetch\s*\(|node:https|axios|graph\.facebook|providerRegistry|access[_-]?token|api[_-]?key/i);
  assert.doesNotMatch(source, /provider_operations|createProviderOperation|status:\s*['"](?:sent|delivered)['"]/i);
  assert.match(source, /externalMessageAttempted:\s*false/g);
  assert.match(source, /providerOperationsCreated:\s*0/g);
});
