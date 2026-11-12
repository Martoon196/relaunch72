import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import test from 'node:test';
import type { Pool } from 'pg';
import {
  createMetaWhatsAppLiveTransport,
  encryptMetaWhatsAppDispatchCredentials,
  metaErrorCode,
  verifyMetaWhatsAppLiveWebhook,
  type MetaWhatsAppDispatchResult,
} from '../src/whatsapp-live/foundation.js';
import {
  ownerSafeCode,
  parseOwnerTemplate,
  readMetaWhatsAppTemplateCatalogue,
  runMhpOwnerWhatsAppOnce,
  type OwnerJobMaterial,
  type OwnerTemplateObservation,
  type PgMhpOwnerWhatsAppRepository,
} from '../src/whatsapp-live-pg/owner-repository.js';
import { OWNER_REASONS, OwnerWhatsAppCommands, OwnerWhatsAppError, explain, isOwnerWhatsAppAction } from '../src/integrations/group-hq-crm/whatsapp-owner.js';
import { GroupHqInboxCrmService, InboxCrmError, loadInboxCrmConfig, type InboxCrmConfig } from '../src/integrations/group-hq-crm/inbox.js';
import type { CrmTransactionRunner } from '../src/crm-pg/types.js';
import { MHP_MARKETING_WORKSPACE_ID } from '../src/mhp/marketing-workspace-service.js';
import { loadMetaWhatsAppLiveWorkerConfig } from '../src/workers/meta-whatsapp-live/runner.js';

// Synthetic identifiers only; numbers are in Ofcom's reserved drama range.
const MHP = '2789228d-55a6-4688-b1e8-2f70abca990b';
const BINDING = Object.freeze({ workspaceId: MHP, connectionId: '22222222-2222-4222-8222-222222222222', appId: '100001234567890',
  wabaId: '200001234567890', phoneNumberId: '300001234567890', graphApiVersion: 'v24.0' as const });
const CREDENTIALS = Object.freeze({ accessToken: 'EAAG-SYNTHETIC-MHP-OWNER-TOKEN-0123456789' });
const OP = '55555555-5555-4555-8555-555555555555';
const meta = (overrides: Record<string, unknown> = {}) => ({ id: '1234567890123', name: 'intro_v1', language: 'en_GB', status: 'APPROVED', category: 'MARKETING',
  components: [{ type: 'BODY', text: 'Hi {{first_name}}, Martin here about {{area}}.' }], ...overrides });

test('Meta templates: named and positional body variables are recognised; anything needing other values is listed as not sendable', () => {
  const named = parseOwnerTemplate(meta())!;
  assert.equal(named.parameterFormat, 'NAMED'); assert.deepEqual(named.parameterNames, ['first_name', 'area']); assert.equal(named.sendable, true);
  const positional = parseOwnerTemplate(meta({ category: 'UTILITY', components: [
    { type: 'HEADER', format: 'TEXT', text: 'Viewing' }, { type: 'BODY', text: 'Hi {{2}} {{1}} and {{1}}' }, { type: 'FOOTER', text: 'MHP' },
    { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Call me' }] }] }))!;
  assert.equal(positional.parameterFormat, 'POSITIONAL'); assert.deepEqual(positional.parameterNames, ['1', '2']);
  assert.equal(positional.previewText, 'Viewing\n\nHi {{2}} {{1}} and {{1}}\n\nMHP\n\n[Call me]');
  assert.equal(parseOwnerTemplate(meta({ components: [{ type: 'BODY', text: 'No variables' }] }))!.parameterFormat, 'NONE');
  for (const [components, reason] of [
    [[{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'x' }], 'media_header'],
    [[{ type: 'HEADER', format: 'TEXT', text: 'Hi {{1}}' }, { type: 'BODY', text: 'x' }], 'header_variables'],
    [[{ type: 'BODY', text: 'x' }, { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Open', url: 'https://example.test/{{1}}' }] }], 'button_variables'],
    [[{ type: 'BODY', text: 'x' }, { type: 'BUTTONS', buttons: [{ type: 'COPY_CODE', text: 'Copy' }] }], 'unsupported_button'],
    [[{ type: 'BODY', text: 'x' }, { type: 'CAROUSEL', cards: [] }], 'unsupported_component'],
  ] as const) {
    const parsed = parseOwnerTemplate(meta({ components }))!;
    assert.equal(parsed.sendable, false); assert.equal(parsed.unsupportedReason, reason);
  }
  assert.equal(parseOwnerTemplate(meta({ category: 'AUTHENTICATION' }))!.unsupportedReason, 'authentication_template');
  assert.equal(parseOwnerTemplate(meta({ components: [{ type: 'BODY', text: 'Gap {{1}} {{3}}' }] })), null, 'positional placeholders must be 1..n');
  assert.equal(parseOwnerTemplate(meta({ id: 'not-an-id' })), null);
  assert.equal(parseOwnerTemplate(meta({ components: [{ type: 'FOOTER', text: 'no body' }] })), null);
});

test('the catalogue read stays on this WABA, follows only same-path paging and fails closed', async () => {
  const urls: string[] = [];
  const pages = [{ data: [meta()], paging: { next: 'https://graph.facebook.com/v24.0/200001234567890/message_templates?after=abc' } },
    { data: [meta({ id: '1234567890124' })], paging: { next: 'https://evil.example.test/v24.0/200001234567890/message_templates?after=x' } }];
  const fetchStub = (async (url: string, init: RequestInit) => {
    urls.push(url); assert.equal((init.headers as Record<string, string>).Authorization, `Bearer ${CREDENTIALS.accessToken}`);
    return new Response(JSON.stringify(pages[urls.length - 1]), { status: 200 });
  }) as unknown as typeof fetch;
  const found = await readMetaWhatsAppTemplateCatalogue({ binding: BINDING, credentials: CREDENTIALS, fetch: fetchStub });
  assert.equal(found?.length, 2); assert.equal(urls.length, 2, 'a foreign paging host is never followed');
  assert.match(urls[0]!, /^https:\/\/graph\.facebook\.com\/v24\.0\/200001234567890\/message_templates\?fields=/u);
  assert.equal(await readMetaWhatsAppTemplateCatalogue({ binding: BINDING, credentials: CREDENTIALS,
    fetch: (async () => new Response('{"error":{"code":190}}', { status: 401 })) as unknown as typeof fetch }), null);
});

test('owner template transport sends exact body parameters and keeps Meta error codes; never accepted without a wamid', async () => {
  let sent: Record<string, unknown> | null = null;
  const reply = (status: number, body: unknown) => (async (_url: string, init: RequestInit) => {
    sent = JSON.parse(String(init.body)); return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  const transport = (fetchImpl: typeof globalThis.fetch) => createMetaWhatsAppLiveTransport({ binding: BINDING, credentials: CREDENTIALS, fetch: fetchImpl,
    providerEffectsEnabled: true, emergencyPaused: false });
  const input = { binding: BINDING, recipient: '447700900123', templateName: 'intro_v1', languageCode: 'en_GB', operationId: OP,
    requestSha256: 'a'.repeat(64), parameterFormat: 'NAMED' as const, parameters: [{ name: 'first_name', value: 'Avery' }, { name: 'area', value: 'Leeds' }] };
  const ok = await transport(reply(200, { messaging_product: 'whatsapp', contacts: [{ input: '447700900123', wa_id: '447700900123' }],
    messages: [{ id: 'wamid.synthetic123' }] })).sendOwnerTemplate!(input);
  assert.equal(ok.state, 'accepted'); assert.equal(ok.providerMessageId, 'wamid.synthetic123'); assert.equal(ok.providerErrorCode, undefined);
  assert.deepEqual(sent, { messaging_product: 'whatsapp', to: '447700900123', type: 'template', template: { name: 'intro_v1', language: { code: 'en_GB' },
    components: [{ type: 'body', parameters: [{ type: 'text', parameter_name: 'first_name', text: 'Avery' }, { type: 'text', parameter_name: 'area', text: 'Leeds' }] }] } });
  await transport(reply(200, {})).sendOwnerTemplate!({ ...input, parameterFormat: 'POSITIONAL', parameters: [{ name: '1', value: 'Avery' }] });
  assert.deepEqual((sent as unknown as { template: { components: unknown } }).template.components,
    [{ type: 'body', parameters: [{ type: 'text', text: 'Avery' }] }]);
  const restricted = await transport(reply(400, { error: { code: 131048, message: 'Spam rate limit hit' } })).sendOwnerTemplate!(input);
  assert.equal(restricted.state, 'failed'); assert.equal(restricted.providerErrorCode, 131048); assert.equal(restricted.providerMessageId, null);
  assert.equal(ownerSafeCode(restricted), 'meta_error:131048');
  const limited = await transport(reply(429, { error: { code: 130429 } })).sendOwnerTemplate!(input);
  assert.equal(limited.state, 'outcome_unknown'); assert.equal(ownerSafeCode(limited), 'meta_error:130429');
  const unproven = await transport(reply(200, { messaging_product: 'whatsapp', messages: [] })).sendOwnerTemplate!(input);
  assert.equal(unproven.state, 'outcome_unknown', 'a 200 without the exact wamid and recipient is never accepted');
  for (const bad of [{ parameters: [{ name: 'first_name', value: 'line\nbreak' }] }, { parameters: [{ name: 'Bad-Name', value: 'x' }] },
    { parameterFormat: 'NONE' as const }, { parameters: [{ name: 'a', value: 'too      many spaces' }] }]) {
    await assert.rejects(transport(reply(200, {})).sendOwnerTemplate!({ ...input, ...bad }));
  }
  await assert.rejects(createMetaWhatsAppLiveTransport({ binding: { ...BINDING, workspaceId: '11111111-1111-4111-8111-111111111111' }, credentials: CREDENTIALS,
    fetch: reply(200, {}), providerEffectsEnabled: true, emergencyPaused: false }).sendOwnerTemplate!({ ...input, binding: { ...BINDING, workspaceId: '11111111-1111-4111-8111-111111111111' } }),
    'only the MHP binding can send owner templates');
  assert.equal(metaErrorCode({ error: { code: 368 } }), 368); assert.equal(metaErrorCode({ error: { code: '368' } }), undefined); assert.equal(metaErrorCode(null), undefined);
});

test('signed failed statuses carry Meta errors[0].code; other statuses are unchanged', () => {
  const appSecret = 'synthetic-meta-app-secret-0123456789';
  const body = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: BINDING.wabaId, changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { phone_number_id: BINDING.phoneNumberId },
    statuses: [{ id: 'wamid.failed1', recipient_id: '447700900123', status: 'failed', timestamp: '1794000000', errors: [{ code: 131049, title: 'x' }] },
      { id: 'wamid.ok1', recipient_id: '447700900123', status: 'delivered', timestamp: '1794000000' }] } }] }] }));
  const verified = verifyMetaWhatsAppLiveWebhook({ binding: BINDING, appSecret, rawBody: body, contentType: 'application/json',
    xHubSignature256: `sha256=${createHmac('sha256', appSecret).update(body).digest('hex')}` });
  const [failed, delivered] = verified.events as unknown as Record<string, unknown>[];
  assert.equal(failed!.errorCode, 131049); assert.equal('errorCode' in delivered!, false);
});

function fakeRepository(material: Partial<OwnerJobMaterial> | null, calls: string[]) {
  const envelope = encryptMetaWhatsAppDispatchCredentials({ binding: BINDING, credentials: CREDENTIALS, encryptionKey: KEY, keyVersion: 'synthetic-v1' });
  return {
    async catalogueTarget() { calls.push('target'); return { binding: BINDING, envelope }; },
    async recordTemplate(o: OwnerTemplateObservation) { calls.push(`record:${o.metaTemplateId}`); },
    async claim() { calls.push('claim'); return material ? { jobId: 'job', leaseVersion: 1 } : null; },
    async load() {
      calls.push('load');
      return material ? { binding: BINDING, envelope, jobId: 'job', leaseVersion: 1, recipient: '447700900123', templateName: 'intro_v1', languageCode: 'en_GB',
        metaTemplateId: '1234567890123', operationId: OP, requestSha256: 'b'.repeat(64), sendId: OP, parameterFormat: 'NAMED',
        parameters: [{ name: 'first_name', value: 'Avery' }, { name: 'area', value: 'Leeds' }], eligible: true, reason: null, ...material } as OwnerJobMaterial : null;
    },
    async begin() { calls.push('begin'); return { begun: material?.eligible !== false }; },
    async settle(_c: unknown, _t: Buffer, result: MetaWhatsAppDispatchResult) { calls.push(`settle:${result.state}:${ownerSafeCode(result)}`); },
  } as unknown as PgMhpOwnerWhatsAppRepository;
}
const KEY = randomBytes(32);
function cycle(material: Partial<OwnerJobMaterial> | null, catalogue: unknown[] | null, send: MetaWhatsAppDispatchResult | Error, calls: string[], observeNow = false) {
  return runMhpOwnerWhatsAppOnce({ repository: fakeRepository(material, calls), encryptionKey: KEY, encryptionKeyVersion: 'synthetic-v1', leaseToken: randomBytes(32),
    observeNow, fetch: (async () => catalogue === null ? new Response('', { status: 500 }) : new Response(JSON.stringify({ data: catalogue }), { status: 200 })) as unknown as typeof fetch,
    createTransport: () => ({ contract: 'propertypredator.meta-whatsapp-live/v1', executionMode: 'owned_template_live',
      sendTemplate: async () => { throw new Error('legacy path must not be used'); },
      sendOwnerTemplate: async () => { calls.push('meta'); if (send instanceof Error) throw send; return send; } }) });
}

test('owner worker cycle: fresh Meta read before begin, one send, never retried, Meta error kept for holds', async () => {
  const accepted = { state: 'accepted' as const, providerMessageId: 'wamid.x', receiptSha256: 'c'.repeat(64), safeCode: 'meta_whatsapp_accepted', occurredAt: new Date().toISOString() };
  let calls: string[] = [];
  assert.equal(await cycle({}, [meta()], accepted, calls, true), 'accepted');
  assert.deepEqual(calls, ['target', 'record:1234567890123', 'claim', 'load', 'record:1234567890123', 'begin', 'meta', 'settle:accepted:meta_whatsapp_accepted']);
  calls = [];
  assert.equal(await cycle({}, null, accepted, calls), 'failed_or_attention', 'no fresh Meta read, no begin');
  assert.deepEqual(calls, ['claim', 'load']);
  calls = [];
  assert.equal(await cycle({}, [meta({ id: '9999999999999' })], accepted, calls), 'failed_or_attention', 'the exact template must be in the fresh read');
  assert.ok(!calls.includes('begin'));
  calls = [];
  assert.equal(await cycle({ eligible: false, reason: 'permission_withdrawn' }, [meta()], accepted, calls), 'failed_or_attention');
  assert.deepEqual(calls, ['claim', 'load', 'begin'], 'an ineligible job is closed by begin-call without any Meta call');
  calls = [];
  const refused = { state: 'failed' as const, providerMessageId: null, receiptSha256: 'd'.repeat(64), safeCode: 'meta_http_400', occurredAt: new Date().toISOString(), providerErrorCode: 368 };
  assert.equal(await cycle({}, [meta()], refused, calls), 'failed_or_attention');
  assert.equal(calls.at(-1), 'settle:failed:meta_error:368');
  calls = [];
  assert.equal(await cycle({}, [meta()], new Error('socket hang up'), calls), 'failed_or_attention');
  assert.equal(calls.at(-1), 'settle:outcome_unknown:worker_transport_outcome_unknown', 'a begun call that threw is unknown, never sent and never retried');
  calls = [];
  assert.equal(await cycle(null, [], accepted, calls), 'idle');
});

test('owner worker mode needs the MHP worker mode and an explicit switch', () => {
  const base = { DATABASE_WHATSAPP_LIVE_WORKER_URL: 'postgres://synthetic', PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID: '66666666-6666-4666-8666-666666666666' };
  assert.throws(() => loadMetaWhatsAppLiveWorkerConfig({ ...base, MHP_WHATSAPP_OWNER_SENDS: 'yes' }), /MHP owner WhatsApp sends require/u);
  // A disabled worker sends nothing at all, whatever the owner switch says.
  assert.equal(loadMetaWhatsAppLiveWorkerConfig({ ...base, MHP_WHATSAPP_OWNER_SENDS: 'enabled' }).mode, 'disabled');
  assert.equal(loadMetaWhatsAppLiveWorkerConfig(base).mode, 'disabled');
});

test('plain-English states: every refusal has a message, Meta codes are explained, nothing reads as sent unless Meta accepted it', () => {
  const out = explain({ state: 'refused', reason: 'account_restricted', hold: { reason: 'spam_rate_limit', errorCode: 131048 },
    sends: [{ state: 'outcome_unknown', errorCode: null }, { state: 'failed', errorCode: 131056 }] }) as Record<string, any>;
  assert.match(out.message, /temporarily restricted/u); assert.match(out.hold.errorMessage, /spam rate limit/u);
  assert.match(out.sends[0].stateLabel, /Not confirmed by Meta/u); assert.match(out.sends[1].errorMessage, /pair rate limit/u);
  for (const reason of ['number_unverified', 'no_permission', 'permission_withdrawn', 'window_closed', 'daily_cap_reached', 'recipient_paused',
    'template_not_approved', 'variables_invalid', 'preview_changed', 'whatsapp_stop', 'suppressed', 'opted_out']) assert.ok(OWNER_REASONS[reason], reason);
  assert.equal(isOwnerWhatsAppAction('whatsappOwnerSendTemplate'), true); assert.equal(isOwnerWhatsAppAction('whatsappReply'), false);
});

test('owner commands validate input before any database call and stay off until switched on', async () => {
  const seen: unknown[][] = [];
  const runner: CrmTransactionRunner = { async run(context, op) {
    assert.equal(context.workspaceId, MHP_MARKETING_WORKSPACE_ID);
    return op({ async query(_sql: string, values?: readonly unknown[]) { seen.push([...(values ?? [])]); return { rows: [{ r: { state: 'queued' } }], rowCount: 1 } as never; } });
  } };
  const origin = { brand: 'pp', workspaceId: '11111111-1111-4111-8111-111111111111' };
  const actor = { userId: '33333333-3333-4333-8333-333333333333' };
  const id = '44444444-4444-4444-8444-444444444444';
  await assert.rejects(new OwnerWhatsAppCommands(runner, false).execute('whatsappOwnerState', { contactId: id }, origin, actor, id),
    (e: unknown) => e instanceof OwnerWhatsAppError && e.code === 'owner_send_unavailable');
  const commands = new OwnerWhatsAppCommands(runner, true);
  await assert.rejects(commands.execute('whatsappOwnerState', { contactId: id }, origin, null, id), (e: unknown) => e instanceof OwnerWhatsAppError && e.status === 403);
  for (const bad of [{ metaTemplateId: 'x' }, { metaTemplateId: '1234567890123', previewSha256: 'nothex' }, { metaTemplateId: '1234567890123', previewSha256: 'a'.repeat(64),
    idempotencyKey: id, linkId: id, contactId: id, variables: { 'Bad-Key': 'x' } }, { metaTemplateId: '1234567890123', previewSha256: 'a'.repeat(64),
    idempotencyKey: id, linkId: id, contactId: id, variables: ['x'.repeat(501)] }]) {
    await assert.rejects(commands.execute('whatsappOwnerSendTemplate', bad, origin, actor, id), (e: unknown) => e instanceof OwnerWhatsAppError && e.status === 400);
  }
  await assert.rejects(commands.execute('whatsappOwnerPermission', { contactId: id, linkId: id, commandId: id, decision: 'granted', lawfulBasis: 'contract',
    evidenceKind: 'written_consent', note: 'x'.repeat(10) }, origin, actor, id), (e: unknown) => e instanceof OwnerWhatsAppError && e.status === 400);
  assert.equal(seen.length, 0, 'nothing reached the database');
  const sent = await commands.execute('whatsappOwnerSendTemplate', { contactId: id, linkId: id, idempotencyKey: id, metaTemplateId: '1234567890123',
    previewSha256: 'A'.repeat(64), variables: { first_name: 'Avery' } }, origin, actor, id) as Record<string, any>;
  assert.equal(sent.result.state, 'queued'); assert.equal(sent.sender, 'Martin Howard Property');
  assert.deepEqual(seen[0], [origin.workspaceId, id, id, id, '1234567890123', '{"first_name":"Avery"}', 'a'.repeat(64)]);
});

test('the signed boundary routes owner actions only for an actor of both the brand and MHP, and only when switched on', async () => {
  const ID = (n: string) => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
  const kp = { label: 'Key Properties', workspaceId: ID('1'), organizationId: ID('2'), ownerUserId: ID('3'), pipelineId: ID('4'), stageId: ID('5'), actorEmails: ['owner@example.test'] };
  const mhp = { ...kp, label: 'MHP', workspaceId: MHP_MARKETING_WORKSPACE_ID, organizationId: ID('6'), actorEmails: ['other@example.test'], whatsappOwnerIds: { 'other@example.test': ID('7') } };
  const pool = { connect: async () => ({ query: async () => ({ rows: [{ allowed: true }] }), release() {} }) } as unknown as Pick<Pool, 'connect'>;
  const contexts: string[] = [];
  const runner: CrmTransactionRunner = { async run(context, op) { contexts.push(`${context.workspaceId}:${context.userId}`);
    return op({ async query() { return { rows: [{ r: { state: 'ok' } }], rowCount: 1 } as never; } }); } };
  const request = (email: string) => ({ actorEmail: email, brand: 'kp', requestId: ID('8'), action: 'whatsappOwnerState', contactId: ID('9') });
  const config: InboxCrmConfig = { secret: 'x'.repeat(40), scopes: { kp, mhp }, mhpWhatsappOwnerSends: true };
  await assert.rejects(new GroupHqInboxCrmService(pool, runner, config).execute(request('owner@example.test')),
    (e: unknown) => e instanceof InboxCrmError && e.status === 403, 'a brand actor who is not an MHP actor is refused');
  const both = { ...config, scopes: { kp: { ...kp, actorEmails: ['other@example.test'] }, mhp } };
  const result = await new GroupHqInboxCrmService(pool, runner, both).execute(request('other@example.test')) as Record<string, any>;
  assert.equal(result.result.state, 'ok'); assert.deepEqual(contexts, [`${MHP_MARKETING_WORKSPACE_ID}:${ID('7')}`], 'runs as the mapped MHP owner in MHP');
  await assert.rejects(new GroupHqInboxCrmService(pool, runner, { ...both, mhpWhatsappOwnerSends: false }).execute(request('other@example.test')),
    (e: unknown) => e instanceof InboxCrmError && e.code === 'owner_send_unavailable');
  const secret = 'x'.repeat(40);
  assert.equal(loadInboxCrmConfig({ R72_GROUP_HQ_INBOX_SECRET: secret, R72_GROUP_HQ_INBOX_SCOPES: JSON.stringify({ kp }) })?.mhpWhatsappOwnerSends, undefined);
  assert.equal(loadInboxCrmConfig({ R72_GROUP_HQ_INBOX_SECRET: secret, R72_GROUP_HQ_INBOX_SCOPES: JSON.stringify({ kp }), MHP_WHATSAPP_OWNER_SENDS: 'enabled' })?.mhpWhatsappOwnerSends, true);
});
