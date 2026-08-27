import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { ProviderOperationContext } from '../src/providers/contracts.js';
import {
  SimulatedWhatsAppDarkAdapter,
  WhatsAppDarkContractError,
  createSignedSimulatedWhatsAppInbound,
  createWhatsAppDarkTemplate,
  toOwnInboxTestInbound,
  verifySimulatedWhatsAppWebhook,
} from '../src/whatsapp-dark/index.js';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const CONNECTION_ID = '22222222-2222-4222-8222-222222222222';
const OPERATION_ID = '33333333-3333-4333-8333-333333333333';
const CORRELATION_ID = '44444444-4444-4444-8444-444444444444';
const APPROVAL_ID = '55555555-5555-4555-8555-555555555555';
const CONSENT_ID = '66666666-6666-4666-8666-666666666666';
const PECR_ID = '77777777-7777-4777-8777-777777777777';
const INSTIGATOR_ID = '88888888-8888-4888-8888-888888888888';
const INBOX_ID = '99999999-9999-4999-8999-999999999999';
const CONTACT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONTACT_POINT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TEST_SECRET = 'test-only-whatsapp-webhook-secret-000000001';
const NOW = new Date('2026-08-27T14:00:00.000Z');

const context: ProviderOperationContext = Object.freeze({
  workspaceId: WORKSPACE_ID,
  connectionId: CONNECTION_ID,
  providerId: 'whatsapp_dark_simulator',
  operationId: OPERATION_ID,
  idempotencyKey: 'whatsapp-test-operation-1',
  correlationId: CORRELATION_ID,
});

const template = createWhatsAppDarkTemplate({
  templateId: 'wa_test_template_property_pack',
  version: 1,
  name: 'property_pack',
  language: 'en_GB',
  category: 'utility',
  body: 'Hi {{first_name}}, your test property pack is ready: {{pack_reference}}.',
  variableNames: ['first_name', 'pack_reference'],
});

const request = Object.freeze({
  recipient: '+447700900001',
  template,
  variables: Object.freeze({ first_name: 'Test Founder', pack_reference: 'TEST-001' }),
  approvalId: APPROVAL_ID,
  consentEvidenceId: CONSENT_ID,
  pecrSenderDecisionId: PECR_ID,
  operatorInstigatorDecisionId: INSTIGATOR_ID,
});

test('template model is immutable, hash-bound and exact-variable only', async () => {
  assert.equal(template.lifecycle, 'test_only_draft');
  assert.match(template.bodySha256, /^[a-f0-9]{64}$/);
  assert.ok(Object.isFrozen(template));
  assert.ok(Object.isFrozen(template.variableNames));
  assert.throws(() => createWhatsAppDarkTemplate({
    ...template, body: 'Hello {{undeclared}}', variableNames: ['first_name'],
  }), WhatsAppDarkContractError);
  assert.throws(() => createWhatsAppDarkTemplate({
    ...template, variableNames: ['first_name', 'first_name'],
  }), WhatsAppDarkContractError);
  const adapter = new SimulatedWhatsAppDarkAdapter({ now: () => NOW });
  await assert.rejects(adapter.simulateTemplate(context, {
    ...request, variables: { first_name: 'Test', pack_reference: 'TEST', extra: 'forbidden' },
  }), WhatsAppDarkContractError);
  await assert.rejects(adapter.simulateTemplate(context, {
    ...request,
    template: { ...template, body: 'Forged {{first_name}} {{pack_reference}}.' },
  }), /body hash is invalid/);
});

test('simulator refuses routable numbers and records hashes without raw body or recipient', async () => {
  const adapter = new SimulatedWhatsAppDarkAdapter({ now: () => NOW });
  await assert.rejects(adapter.simulateTemplate(context, {
    ...request, recipient: '+447911123456',
  }), /reserved non-routable/);
  const result = await adapter.simulateTemplate(context, request);
  assert.deepEqual(result, {
    effectMode: 'simulated_test_only', status: 'simulated',
    testReference: 'wa_test_085d72da9ad59a3b173a7a7656d44ba0',
    occurredAt: NOW.toISOString(), providerOperationCreated: false,
    externalDeliveryAttempted: false,
    summary: 'Reserved WhatsApp test operation simulated',
  });
  assert.equal(adapter.audit.length, 1);
  assert.equal(adapter.audit[0]?.externalDeliveryAttempted, false);
  assert.match(adapter.audit[0]?.recipientSha256 ?? '', /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(adapter.audit), /Test Founder|\+447700900001|property pack is ready/);
  await assert.doesNotReject(adapter.reconcileSimulation(context, result.testReference));
  await assert.rejects(adapter.reconcileSimulation(context, 'wa_test_00000000000000000000000000000000'));
});

test('signed simulated inbound webhook maps into an own-inbox test command', () => {
  const signed = createSignedSimulatedWhatsAppInbound({
    workspaceId: WORKSPACE_ID,
    connectionId: CONNECTION_ID,
    from: '+447700900002',
    to: '+447700900001',
    body: 'Yes, send the fictional test pack.',
    occurredAt: NOW.toISOString(),
    testSecret: TEST_SECRET,
  });
  const event = verifySimulatedWhatsAppWebhook({ ...signed, testSecret: TEST_SECRET });
  const command = toOwnInboxTestInbound(event, {
    workspaceId: WORKSPACE_ID,
    connectionId: CONNECTION_ID,
    inboxId: INBOX_ID,
    contactId: CONTACT_ID,
    contactPointId: CONTACT_POINT_ID,
    ownedTestNumber: '+447700900001',
    sourceTestNumber: '+447700900002',
  });
  assert.equal(command.commandKey, `whatsapp-test-inbound:${event.eventId}`);
  assert.equal(command.body, 'Yes, send the fictional test pack.');
  assert.equal(command.inboxId, INBOX_ID);
  assert.ok(Object.isFrozen(event));
  assert.ok(Object.isFrozen(event.event));
  assert.ok(Object.isFrozen(command));
});

test('webhook verification fails closed before parsing and rejects scope/address drift', () => {
  const signed = createSignedSimulatedWhatsAppInbound({
    workspaceId: WORKSPACE_ID, connectionId: CONNECTION_ID,
    from: '+447700900002', to: '+447700900001', body: 'Test reply.',
    occurredAt: NOW.toISOString(), testSecret: TEST_SECRET,
  });
  const tampered = Uint8Array.from(signed.rawBody);
  tampered[tampered.length - 2] = tampered[tampered.length - 2]! ^ 1;
  assert.throws(() => verifySimulatedWhatsAppWebhook({
    ...signed, rawBody: tampered, testSecret: TEST_SECRET,
  }), /signature is invalid/);
  assert.throws(() => verifySimulatedWhatsAppWebhook({
    ...signed, contentType: 'text/plain', testSecret: TEST_SECRET,
  }), /media type is invalid/);
  const event = verifySimulatedWhatsAppWebhook({ ...signed, testSecret: TEST_SECRET });
  assert.throws(() => toOwnInboxTestInbound(event, {
    workspaceId: WORKSPACE_ID,
    connectionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    inboxId: INBOX_ID, contactId: CONTACT_ID, contactPointId: CONTACT_POINT_ID,
    ownedTestNumber: '+447700900001', sourceTestNumber: '+447700900002',
  }), /does not match/);
  assert.throws(() => toOwnInboxTestInbound({ ...event }, {
    workspaceId: WORKSPACE_ID, connectionId: CONNECTION_ID,
    inboxId: INBOX_ID, contactId: CONTACT_ID, contactPointId: CONTACT_POINT_ID,
    ownedTestNumber: '+447700900001', sourceTestNumber: '+447700900002',
  }), /authenticated before inbox mapping/);
  assert.throws(() => createSignedSimulatedWhatsAppInbound({
    workspaceId: WORKSPACE_ID, connectionId: CONNECTION_ID,
    from: '+447911123456', to: '+447700900001', body: 'No.',
    occurredAt: NOW.toISOString(), testSecret: TEST_SECRET,
  }), /reserved non-routable/);
});

test('dark WhatsApp module has no transport, SDK, registry, credential or live-effect path', async () => {
  const files = ['contracts.ts', 'simulator.ts', 'webhook.ts', 'index.ts'];
  const source = (await Promise.all(files.map((name) => readFile(
    new URL(`../src/whatsapp-dark/${name}`, import.meta.url), 'utf8',
  )))).join('\n');
  assert.doesNotMatch(source, /\bfetch\s*\(|node:https|axios|graph\.facebook|providerRegistry|access[_-]?token|api[_-]?key/i);
  assert.doesNotMatch(source, /status:\s*['"](?:sent|delivered|published)['"]/i);
  assert.match(source, /externalDeliveryAttempted:\s*false/g);
  assert.match(source, /providerOperationCreated:\s*false/g);
});
