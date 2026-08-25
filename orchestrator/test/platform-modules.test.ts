import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlatformEvent, PLATFORM_EVENT_TYPES } from '../src/platform/events.js';
import { CORE_PLATFORM_MODULES, createPlatformModuleRegistry, platformModules } from '../src/platform/modules.js';
import type { PlatformCapability } from '../src/platform/capabilities.js';
import { createProviderRegistry } from '../src/providers/registry.js';
import { createProviderOperationContext, type SocialPublishingProvider } from '../src/providers/contracts.js';

test('core modules have stable unique ids/routes and uncluttered ordering', () => {
  assert.deepEqual(platformModules.modules.map((module) => module.id), [
    'overview', 'crm', 'journeys', 'content', 'social', 'inbox', 'listening', 'webinars', 'automations', 'analytics', 'settings',
  ]);
  assert.equal(new Set(platformModules.modules.map((module) => module.id)).size, platformModules.modules.length);
  const routes = platformModules.modules.flatMap((module) => module.route ? [module.route] : []);
  assert.equal(new Set(routes).size, routes.length);
});

test('runtime resolution never presents planned modules as ready', () => {
  const everyCapability = new Set<PlatformCapability>(CORE_PLATFORM_MODULES.flatMap((module) => [...module.requiredCapabilities]));
  const byId = new Map(platformModules.resolve({ capabilities: everyCapability }).map((module) => [module.id, module]));
  assert.equal(byId.get('overview')?.state, 'ready');
  assert.equal(byId.get('crm')?.state, 'ready');
  assert.equal(byId.get('crm')?.description, 'Private contacts, opportunities, tasks and recorded CRM activity.');
  assert.equal(byId.get('journeys')?.state, 'planned');
  assert.equal(byId.get('content')?.state, 'preview');
  assert.equal(byId.get('social')?.state, 'planned');
  assert.equal(byId.get('inbox')?.state, 'planned');
  assert.equal(byId.get('listening')?.state, 'planned');
  assert.equal(byId.get('webinars')?.state, 'planned');
});

test('conversion facts use stable internal event names without accepting external envelopes', () => {
  assert.ok(PLATFORM_EVENT_TYPES.includes('conversion.enrollment.started'));
  assert.ok(PLATFORM_EVENT_TYPES.includes('conversion.milestone.achieved'));
  assert.ok(PLATFORM_EVENT_TYPES.includes('conversion.score.updated'));
  assert.ok(PLATFORM_EVENT_TYPES.includes('conversion.commerce.fact_recorded'));
  assert.ok(PLATFORM_EVENT_TYPES.includes('communication.consent.recorded'));
  assert.ok(PLATFORM_EVENT_TYPES.includes('communication.suppression.recorded'));
});

test('available modules surface missing setup and explicit disablement truthfully', () => {
  const modules = platformModules.resolve({ capabilities: new Set(), disabledModules: new Set(['crm']) });
  assert.equal(modules.find((module) => module.id === 'overview')?.state, 'setup_required');
  assert.equal(modules.find((module) => module.id === 'crm')?.state, 'unavailable');
  assert.equal(modules.find((module) => module.id === 'content')?.state, 'setup_required');
  assert.deepEqual(modules.find((module) => module.id === 'overview')?.missingCapabilities, ['workspace.overview.read']);
});

test('a module cannot look ready while a declared dependency is unavailable', () => {
  const capabilities = new Set<PlatformCapability>(['crm.contacts.read', 'crm.pipeline.read', 'crm.tasks.read']);
  const crm = platformModules.resolve({ capabilities }).find((module) => module.id === 'crm');
  assert.equal(crm?.state, 'setup_required');
  assert.deepEqual(crm?.missingCapabilities, []);
  assert.deepEqual(crm?.blockedBy, ['overview']);
});

test('registry rejects duplicate ids, duplicate routes and dependency cycles', () => {
  const overview = CORE_PLATFORM_MODULES[0]!;
  assert.throws(() => createPlatformModuleRegistry([overview, overview]), /duplicate module id/);
  assert.throws(() => createPlatformModuleRegistry([
    overview,
    { ...CORE_PLATFORM_MODULES[1]!, route: overview.route },
  ]), /duplicate module route/);
  assert.throws(() => createPlatformModuleRegistry([
    { ...overview, dependsOn: ['crm'] },
    { ...CORE_PLATFORM_MODULES[1]!, dependsOn: ['overview'] },
  ]), /dependency cycle/);
  assert.throws(() => createPlatformModuleRegistry([
    { ...overview, stage: 'launched' as never },
  ]), /invalid stage/);
  assert.throws(() => createPlatformModuleRegistry([
    { ...overview, group: 'rogue' as never },
  ]), /invalid group/);
  assert.throws(() => createPlatformModuleRegistry([
    { ...overview, icon: 'rogue' as never },
  ]), /invalid icon/);
  assert.throws(() => createPlatformModuleRegistry([
    { ...overview, requiredCapabilities: ['crm.delete.everything' as never] },
  ]), /invalid required capability/);
});

test('platform events carry workspace, actor and correlation context', () => {
  const payload = {
    channel: 'whatsapp',
    messageId: 'wamid_1',
    metadata: { tags: ['priority'] },
  };
  const event = createPlatformEvent({
    id: '0198d3b9-5731-7000-8000-000000000001',
    type: 'conversation.message.received',
    workspaceId: '0198d3b9-5731-7000-8000-000000000002',
    occurredAt: '2026-08-23T12:00:00.000Z',
    actorId: null,
    correlationId: '0198d3b9-5731-7000-8000-000000000003',
    causationId: '0198d3b9-5731-7000-8000-000000000004',
    payload,
  });
  assert.equal(event.version, 1);
  assert.equal(event.workspaceId, '0198d3b9-5731-7000-8000-000000000002');
  assert.equal(event.payload.channel, 'whatsapp');
  payload.metadata.tags[0] = 'changed-after-creation';
  assert.deepEqual(event.payload.metadata.tags, ['priority']);
  assert.ok(Object.isFrozen(event.payload));
  assert.ok(Object.isFrozen(event.payload.metadata));
  assert.ok(Object.isFrozen(event.payload.metadata.tags));
  assert.equal(createPlatformEvent({ ...event, id: event.id.toUpperCase() }).id, event.id);
  assert.throws(() => createPlatformEvent({ ...event, occurredAt: 'not-a-date' }), /occurredAt/);
  assert.throws(() => createPlatformEvent({ ...event, occurredAt: '2026-08-23T12:00:00Z' }), /canonical RFC3339/);
  assert.throws(() => createPlatformEvent({ ...event, occurredAt: '2026-02-30T12:00:00.000Z' }), /valid canonical RFC3339/);
  assert.throws(() => createPlatformEvent({ ...event, id: 'evt_1' }), /event id must be a UUID/);
  assert.throws(() => createPlatformEvent({ ...event, workspaceId: 'ws_1' }), /workspaceId must be a UUID/);
  assert.throws(() => createPlatformEvent({ ...event, actorId: 'user_1' }), /actorId must be a UUID/);
  assert.throws(() => createPlatformEvent({ ...event, correlationId: 'corr_1' }), /correlationId must be a UUID/);
  assert.throws(() => createPlatformEvent({ ...event, causationId: 'evt_0' }), /causationId must be a UUID/);
  assert.throws(() => createPlatformEvent({ ...event, type: 'unknown.event' as never }), /unknown platform event type/);
});

test('platform event payloads reject values that cannot survive a JSON wire format', () => {
  const base = {
    id: '0198d3b9-5731-7000-8000-000000000001',
    type: 'conversation.message.received' as const,
    workspaceId: '0198d3b9-5731-7000-8000-000000000002',
    occurredAt: '2026-08-23T12:00:00.000Z',
    correlationId: '0198d3b9-5731-7000-8000-000000000003',
  };
  assert.throws(() => createPlatformEvent({ ...base, payload: { score: Number.NaN } }), /finite JSON numbers/);
  assert.throws(() => createPlatformEvent({ ...base, payload: { sentAt: new Date() } as never }), /plain JSON objects/);

  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.throws(() => createPlatformEvent({ ...base, payload: circular as never }), /circular references/);
});

test('provider registry describes capabilities and keeps outbound and inbound auth distinct', () => {
  const providers = createProviderRegistry([
    { id: 'whatsapp_cloud', name: 'WhatsApp Cloud', kind: 'messaging', outboundCredentialAuth: 'oauth2', inboundWebhookVerification: 'hmac_signature', capabilities: ['conversations.read', 'conversations.reply', 'channel.whatsapp'] },
    { id: 'social_publisher', name: 'Social Publisher', kind: 'social', outboundCredentialAuth: 'oauth2', inboundWebhookVerification: 'none', capabilities: ['social.publish'] },
    { id: 'social_listener', name: 'Social Listener', kind: 'social', outboundCredentialAuth: 'api_key', inboundWebhookVerification: 'verification_token', capabilities: ['social.listen'] },
  ]);
  assert.deepEqual(providers.forCapability('social.listen').map((provider) => provider.id), ['social_listener']);
  assert.deepEqual(providers.forCapability('social.publish').map((provider) => provider.id), ['social_publisher']);
  assert.deepEqual(providers.forCapability('conversations.reply').map((provider) => provider.id), ['whatsapp_cloud']);
  assert.equal(providers.get('whatsapp_cloud').outboundCredentialAuth, 'oauth2');
  assert.equal(providers.get('whatsapp_cloud').inboundWebhookVerification, 'hmac_signature');
  assert.throws(() => createProviderRegistry([
    { id: 'invalid', name: 'Invalid', kind: 'messaging', outboundCredentialAuth: 'signed_webhook' as 'oauth2', inboundWebhookVerification: 'none', capabilities: ['conversations.read'] },
  ]), /invalid outbound credential auth mode/);
  assert.throws(() => createProviderRegistry([
    { id: 'invalid', name: 'Invalid', kind: 'messaging', outboundCredentialAuth: 'api_key', inboundWebhookVerification: 'oauth2' as 'none', capabilities: ['conversations.read'] },
  ]), /invalid inbound webhook verification mode/);
  assert.throws(() => createProviderRegistry([
    { id: 'invalid', name: 'Invalid', kind: 'rogue' as never, outboundCredentialAuth: 'api_key', inboundWebhookVerification: 'none', capabilities: ['conversations.read'] },
  ]), /invalid kind/);
  assert.throws(() => createProviderRegistry([
    { id: 'invalid', name: 'Invalid', kind: 'messaging', outboundCredentialAuth: 'api_key', inboundWebhookVerification: 'none', capabilities: ['crm.delete.everything' as never] },
  ]), /invalid capability/);
});

test('provider operations derive workspace and connection identity from one owned row', () => {
  const context = createProviderOperationContext({
    connection: {
      workspaceId: ' 11111111-1111-4111-8111-111111111111 ',
      id: '22222222-2222-4222-8222-222222222222',
      providerId: 'social_publisher',
    },
    operationId: '33333333-3333-4333-8333-333333333333',
    idempotencyKey: 'publish:approval_1',
    correlationId: '44444444-4444-4444-8444-444444444444',
  });
  assert.equal(context.workspaceId, '11111111-1111-4111-8111-111111111111');
  assert.equal(context.connectionId, '22222222-2222-4222-8222-222222222222');
  assert.equal(context.providerId, 'social_publisher');
  assert.ok(Object.isFrozen(context));
  const contextWithRogueTopLevelIds = createProviderOperationContext({
    connection: {
      workspaceId: context.workspaceId,
      id: context.connectionId,
      providerId: context.providerId,
    },
    operationId: context.operationId,
    idempotencyKey: context.idempotencyKey,
    correlationId: context.correlationId,
    workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    connectionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  } as Parameters<typeof createProviderOperationContext>[0]);
  assert.equal(contextWithRogueTopLevelIds.workspaceId, context.workspaceId);
  assert.equal(contextWithRogueTopLevelIds.connectionId, context.connectionId);
  assert.throws(() => createProviderOperationContext({
    connection: { ...context, id: 'not-a-uuid' },
    operationId: context.operationId,
    idempotencyKey: context.idempotencyKey,
    correlationId: context.correlationId,
  }), /connection.id must be a UUID/);
});

test('publishing contract carries approval and idempotency across retries', async () => {
  const seen: string[] = [];
  const provider: SocialPublishingProvider = {
    async publish(context, request) {
      seen.push(`${context.workspaceId}:${context.idempotencyKey}:${request.approvalId}`);
      return {
        status: 'accepted', externalId: 'post_1', occurredAt: '2026-08-23T12:00:00.000Z',
        retryable: false, errorCode: null, summary: 'Accepted by provider',
      };
    },
    async reconcile() {
      throw new Error('not used');
    },
  };
  const context = createProviderOperationContext({
    connection: {
      workspaceId: '11111111-1111-4111-8111-111111111111',
      id: '22222222-2222-4222-8222-222222222222',
      providerId: 'social_publisher',
    },
    operationId: '33333333-3333-4333-8333-333333333333',
    idempotencyKey: 'publish:approval_1',
    correlationId: '44444444-4444-4444-8444-444444444444',
  });
  await provider.publish(context, {
    network: 'linkedin', text: 'Approved copy', mediaArtifactIds: [],
    publishAt: null, approvalId: 'approval_1',
  });
  await provider.publish(context, {
    network: 'linkedin', text: 'Approved copy', mediaArtifactIds: [],
    publishAt: null, approvalId: 'approval_1',
  });
  assert.deepEqual(seen, [
    '11111111-1111-4111-8111-111111111111:publish:approval_1:approval_1',
    '11111111-1111-4111-8111-111111111111:publish:approval_1:approval_1',
  ]);
});
