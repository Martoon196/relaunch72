import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createPostmarkBounceWebhook, EmailBlockRegistry, EmailBounceService, loadEmailBounceConfig, type EmailFact, type PostmarkBounceApi } from '../src/email-bounces/index.js';
import { canonicalFlowMessage } from '../src/followup-sequences/channel-drafts.js';
import { ppEmailBounceEffects, ppEmailBounceSourceDefault } from '../src/pp-followup/bounces.js';
import { ppMarketingConfig, type PpMarketingConfig } from '../src/pp-followup/config.js';
import { ppUnsubscribeUrl, renderPpFollowupEmail } from '../src/pp-followup/content.js';
import { dispatchPpFollowupEmails } from '../src/pp-followup/dispatch.js';
import { createPpPostmarkSender, PpNotSentError } from '../src/pp-followup/mail.js';
import { PP_FOLLOWUP_WORKSPACE_ID as PP, type PpFollowupPrepared, type PpFollowupQueue } from '../src/pp-followup/repository.js';
import { MHP_MARKETING_WORKSPACE_ID as MHP } from '../src/mhp/marketing-workspace-service.js';

const SECRET = 'synthetic-pp-followup-secret-at-least-32-chars', WEBHOOK_SECRET = 'pp-webhook-secret-synthetic-0123456789';
const POINT = '2b5d8a3c-4f1e-4c7a-9d2b-1a2b3c4d5e6f', ORIGIN = 'https://hq.propertypredator.com', NOW = Date.parse('2026-11-12T10:00:00Z');
const ENV = { PP_MARKETING_MODE: 'live', PP_POSTMARK_SERVER_TOKEN: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', PP_MARKETING_FROM: 'hello@propertypredator.com',
  PP_POSTMARK_BROADCAST_STREAM: 'pp-news', PORTAL_BASE_URL: ORIGIN, SESSION_SECRET: SECRET };
const canonical = canonicalFlowMessage('email', { schema: 'propertypredator.email-draft/v1', subject: 'Hi {{FIRSTNAME}}', bodyText: 'From {{LABEL}}: {{LINK}}\nLeave: {{UNSUBSCRIBE}}' });
const sha = createHash('sha256').update(canonical).digest('hex');
const config = (): PpMarketingConfig => ppMarketingConfig(ENV).config!;
const rendered = () => renderPpFollowupEmail({ canonicalContent: canonical, contentSha256: sha, displayName: 'Ann', label: 'Property Predator', link: 'https://propertypredator.com/',
  unsubscribe: ppUnsubscribeUrl(ORIGIN, SECRET, POINT), productName: 'Property Predator', unsubscribeOrigin: ORIGIN });
const fact = (over: Partial<EmailFact> = {}): EmailFact => ({ sourceKey: 'pp', stream: 'pp-news', id: 'bounce:1', kind: 'hard_bounce', email: 'ann@example.com', at: NOW - 86_400_000, ...over });
function guardWith(workspace: string, ...facts: Partial<EmailFact>[]) {
  const registry = new EmailBlockRegistry(() => NOW); registry.markReady();
  facts.forEach((item, index) => registry.record(workspace, fact({ id: `bounce:${index}`, ...item })));
  return { guard: registry, workspaceId: PP };
}
const LEASE = { id: '4d7fa05e-6b3a-4e9c-9f4d-3c4d5e6f7081', leaseId: '5e80b16f-7c4b-4fad-a05e-4d5e6f708192', leaseUntil: new Date(Date.now() + 120_000).toISOString(), email: 'ann@example.com' };
const PREPARED: PpFollowupPrepared = { ...LEASE, proofId: '6f91c270-8d5c-4abe-b16f-5e6f708192a3', runId: '70a2d381-9e6d-4bcf-827a-6f708192a3b4', step: 0,
  contactPointId: POINT, email: 'ann@example.com', displayName: 'Ann Smith', contentVersionId: '81b3e492-af7e-4cd0-9381-708192a3b4c5', canonicalContent: canonical, contentSha256: sha };
function queueFixture() {
  const calls: string[] = [];
  const queue: PpFollowupQueue = { claim: async () => { calls.push('claim'); return [LEASE]; }, prepare: async () => { calls.push('prepare'); return PREPARED; },
    settle: async (_lease, outcome, reference) => { calls.push(`settle:${outcome}:${reference}`); }, unknown: async () => { calls.push('unknown'); } };
  return { queue, calls };
}
const dispatchConfig = { testRecipients: null, link: 'https://propertypredator.com/', unsubscribeOrigin: ORIGIN, fromName: 'Property Predator' };

test('PP joins the shared handler by configuration only, and only while its delivery is switched on and ready', () => {
  assert.equal(ppEmailBounceSourceDefault(ppMarketingConfig({}).config), null, 'mode off: no source');
  assert.equal(ppEmailBounceSourceDefault(ppMarketingConfig({ ...ENV, PP_POSTMARK_SERVER_TOKEN: '' }).config), null, 'not fully configured: no source');
  const source = ppEmailBounceSourceDefault(config())!;
  assert.deepEqual(source, { key: 'pp', workspaceId: PP, tokenEnv: 'PP_POSTMARK_SERVER_TOKEN', webhookSecretEnv: 'PP_POSTMARK_WEBHOOK_SECRET', marketingStreams: ['pp-news'], serviceStreams: [] });
  const closed = loadEmailBounceConfig(ENV, { defaults: [source] });
  assert.deepEqual(closed.sources.map(s => [s.key, s.workspaceId, [...s.streams], Boolean(s.token), s.webhookSecret]), [['pp', PP, [['pp-news', 'marketing']], true, null]]);
  assert.match(closed.blockers.join(' '), /PP_POSTMARK_WEBHOOK_SECRET is not set/u);
  assert.equal(loadEmailBounceConfig({ ...ENV, PP_POSTMARK_WEBHOOK_SECRET: WEBHOOK_SECRET }, { defaults: [source] }).sources[0]!.webhookSecret, WEBHOOK_SECRET);
});

test('PP dispatch refuses a blocked address before any proof is written: a definite non-send, never an unknown', async () => {
  const sent: string[] = [];
  const sender = { sendRendered: async (item: { email: string; contactPointId?: string }) => { sent.push(`${item.email}:${item.contactPointId}`); return 'pm-1'; } };
  for (const kind of ['hard_bounce', 'spam_complaint', 'unsubscribed'] as const) {
    const blocked = queueFixture();
    assert.deepEqual(await dispatchPpFollowupEmails({ queue: blocked.queue, sender, unsubscribeSecret: SECRET, config: dispatchConfig, recipients: guardWith(PP, { kind }) }), { sent: 0, failed: 1, unknown: 0 });
    assert.deepEqual(blocked.calls, ['claim', 'settle:undeliverable:null'], `${kind}: no prepare, no provider call, no unknown hold`);
  }
  assert.deepEqual(sent, []);
  const otherBrand = queueFixture();
  assert.deepEqual(await dispatchPpFollowupEmails({ queue: otherBrand.queue, sender, unsubscribeSecret: SECRET, config: dispatchConfig, recipients: guardWith(MHP, {}) }), { sent: 1, failed: 0, unknown: 0 });
  assert.deepEqual(otherBrand.calls, ['claim', 'prepare', 'settle:accepted:pm-1'], 'a block in another brand never refuses a PP send');
  assert.deepEqual(sent, [`ann@example.com:${POINT}`], 'the sender is told which contact point the email is for');
  const softOnce = queueFixture();
  assert.equal((await dispatchPpFollowupEmails({ queue: softOnce.queue, sender, unsubscribeSecret: SECRET, config: dispatchConfig, recipients: guardWith(PP, { kind: 'soft_bounce' }) })).sent, 1, 'one temporary failure blocks nobody');
  const unguarded = queueFixture();
  assert.equal((await dispatchPpFollowupEmails({ queue: unguarded.queue, sender, unsubscribeSecret: SECRET, config: dispatchConfig })).sent, 1);
  const lost = queueFixture(); lost.queue.settle = async () => { lost.calls.push('settle-lost'); throw new Error('lost'); };
  assert.deepEqual(await dispatchPpFollowupEmails({ queue: lost.queue, sender, unsubscribeSecret: SECRET, config: dispatchConfig, recipients: guardWith(PP, {}) }), { sent: 0, failed: 1, unknown: 0 });
  assert.deepEqual(lost.calls, ['claim', 'settle-lost'], 'if the refusal cannot be recorded the lease simply runs out; nothing is sent or held');
});

test('PP sender refuses a blocked address itself and marks each message with its contact point', async () => {
  const bodies: Record<string, any>[] = [];
  const fetcher = (async (_url: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ ErrorCode: 0, MessageID: 'pm-1' }), { status: 200 }); }) as unknown as typeof fetch;
  const guarded = createPpPostmarkSender(config(), fetcher, guardWith(PP, {}));
  await assert.rejects(guarded.sendRendered({ id: 'send-1', email: 'Ann@Example.com', tag: 'pp_followup', rendered: rendered(), contactPointId: POINT }),
    (error: unknown) => error instanceof PpNotSentError && error.scope === 'recipient');
  assert.equal(bodies.length, 0, 'Postmark was never called');
  await guarded.sendRendered({ id: 'send-2', email: 'fine@example.com', tag: 'pp_followup', rendered: rendered(), contactPointId: POINT });
  assert.deepEqual(bodies[0]!.Metadata, { send: 'send-2', point: POINT }); assert.equal(bodies[0]!.MessageStream, 'pp-news');
  await createPpPostmarkSender(config(), fetcher).sendRendered({ id: 'send-3', email: 'ann@example.com', tag: 'pp_followup', rendered: rendered(), contactPointId: 'not-a-uuid' });
  assert.deepEqual(bodies[1]!.Metadata, { send: 'send-3' });
  // The dispatcher maps the sender's own refusal to the same definite outcome.
  const late = queueFixture();
  const result = await dispatchPpFollowupEmails({ queue: late.queue, sender: guarded, unsubscribeSecret: SECRET, config: dispatchConfig });
  assert.deepEqual([result, late.calls], [{ sent: 0, failed: 1, unknown: 0 }, ['claim', 'prepare', 'settle:undeliverable:null']]);
});

test('PP webhook and sweep: a bounce reported for our own message records the existing email suppression for that contact point', async () => {
  const stopped: string[] = [];
  const reads: string[] = [];
  const api: PostmarkBounceApi = { suppressions: async stream => { reads.push(stream); return [{ email: 'old@example.com', kind: 'hard_bounce', at: NOW - 5 * 86_400_000 }]; },
    bounces: async stream => { reads.push(`bounces ${stream}`); return { total: 0, received: 0, rows: [] }; }, totals: async () => ({ sent: 50, bounced: 1, complaints: 0 }) };
  const service = new EmailBounceService({ now: () => NOW, apiFor: () => api,
    config: loadEmailBounceConfig({ ...ENV, PP_POSTMARK_WEBHOOK_SECRET: WEBHOOK_SECRET }, { defaults: [ppEmailBounceSourceDefault(config())!] }) });
  service.setEffects(PP, ppEmailBounceEffects({ unsubscribe: async point => { stopped.push(point); return { known: true, recorded: true, stopped: 1 }; } }));
  await service.sweepWorkspace(PP);
  assert.deepEqual(reads, ['pp-news', 'bounces pp-news'], 'the catch-up read asks for PP\'s own stream');
  assert.equal(service.registry.decide(PP, 'old@example.com', 'marketing').blocked, true, 'bounces from before the webhook existed are refused');
  assert.deepEqual(stopped, [], 'an address known only from Postmark\'s list has no contact point to record against (0153)');
  const webhook = createPostmarkBounceWebhook({ service, now: () => NOW });
  const post = async (path: string, body: unknown, password = WEBHOOK_SECRET) => {
    const captured = { status: 0, body: '' };
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: 'POST', url: path,
      headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`pp:${password}`).toString('base64')}` }, socket: { remoteAddress: '127.0.0.1' } }) as unknown as IncomingMessage;
    const res = { writeHead(status: number) { captured.status = status; }, end(text = '') { captured.body = String(text); } } as unknown as ServerResponse;
    await webhook.handle(req, res, new URL(path, ORIGIN)); return captured;
  };
  const event = (over: Record<string, unknown> = {}) => ({ RecordType: 'Bounce', MessageStream: 'pp-news', ID: 501, Type: 'HardBounce', Email: 'ann@example.com', BouncedAt: '2026-11-12T09:00:00Z',
    Inactive: true, ServerID: 9, Metadata: { send: 'send-1', point: POINT }, ...over });
  assert.equal((await post('/api/provider-webhooks/postmark/pp', event(), 'wrong-secret-wrong-secret-wrong')).status, 401);
  assert.equal((await post('/api/provider-webhooks/postmark/pp', event())).status, 200);
  assert.deepEqual(stopped, [POINT]);
  assert.equal(service.registry.decide(PP, 'ann@example.com', 'marketing').blocked, true);
  assert.equal(service.registry.decide(MHP, 'ann@example.com', 'marketing').blocked, false, 'only Property Predator');
  assert.match((await post('/api/provider-webhooks/postmark/pp', event())).body, /"replayed":true/u); assert.equal(stopped.length, 1);
  await post('/api/provider-webhooks/postmark/pp', event({ RecordType: 'SpamComplaint', Type: 'SpamComplaint', ID: 502, Email: 'cross@example.com', Metadata: { send: 'send-2' } }));
  assert.equal(service.registry.decide(PP, 'cross@example.com', 'marketing').blocked, true); assert.equal(stopped.length, 1, 'no contact point in the metadata: refused in memory only');
  await post('/api/provider-webhooks/postmark/pp', event({ ID: 503, Email: 'bad@example.com', Metadata: { point: 'not-a-uuid' } })); assert.equal(stopped.length, 1);
  assert.deepEqual(JSON.parse((await post('/api/provider-webhooks/postmark/pp', event({ ID: 504, MessageStream: 'outbound' }))).body), { received: true, outcome: 'ignored_stream' });
  // Three soft bounces block the address for now, in memory. They never write the permanent "recipient unsubscribed" suppression row.
  const OTHER_POINT = '5f0c2a9e-7d41-4b53-8a6e-0123456789cd';
  for (const id of [601, 602, 603]) await post('/api/provider-webhooks/postmark/pp', event({ ID: id, Type: 'SoftBounce', Inactive: false, Email: 'full@example.com', Metadata: { send: 'send-3', point: OTHER_POINT } }));
  assert.deepEqual(service.registry.decide(PP, 'full@example.com', 'marketing'), { blocked: true, reason: 'repeated_soft_bounce' });
  assert.deepEqual(stopped, [POINT], 'a temporary block is not recorded as an unsubscribe');

  // PP switched off: no source, so the same address answers "not found" and nothing is read or refused.
  const off = new EmailBounceService({ config: loadEmailBounceConfig({ PP_POSTMARK_WEBHOOK_SECRET: WEBHOOK_SECRET },
    { defaults: [ppEmailBounceSourceDefault(ppMarketingConfig({ PP_POSTMARK_WEBHOOK_SECRET: WEBHOOK_SECRET }).config)].filter(source => source !== null) }) });
  const closed = { status: 0 };
  await createPostmarkBounceWebhook({ service: off }).handle(Object.assign(Readable.from([Buffer.from('{}')]), { method: 'POST', url: '/api/provider-webhooks/postmark/pp',
    headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`pp:${WEBHOOK_SECRET}`).toString('base64')}` }, socket: {} }) as unknown as IncomingMessage,
    { writeHead(status: number) { closed.status = status; }, end() {} } as unknown as ServerResponse, new URL('/api/provider-webhooks/postmark/pp', ORIGIN));
  assert.equal(closed.status, 404); assert.equal(off.sources.length, 0); assert.equal(off.hasWorkspace(PP), false);
});
