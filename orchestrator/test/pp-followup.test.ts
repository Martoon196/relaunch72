import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { canonicalFlowMessage } from '../src/followup-sequences/channel-drafts.js';
import { ppMarketingConfig, type PpMarketingConfig } from '../src/pp-followup/config.js';
import { PP_FOLLOWUP_UNSUBSCRIBE_ROUTE, ppUnsubscribeToken, ppUnsubscribeUrl, renderPpFollowupEmail, verifyPpUnsubscribeToken } from '../src/pp-followup/content.js';
import { createPpPostmarkSender } from '../src/pp-followup/mail.js';
import { dispatchPpFollowupEmails, startPpFollowupDispatcher } from '../src/pp-followup/dispatch.js';
import { PgPpFollowupQueue, PgPpFollowupRepository, PP_FOLLOWUP_WORKSPACE_ID, parsePpFollowupSnapshot, type PpFollowupPrepared, type PpFollowupQueue } from '../src/pp-followup/repository.js';
import { handlePpFollowupUnsubscribe } from '../src/pp-followup/unsubscribe-route.js';
import { PortalFollowupFlowService } from '../src/portal/followup-flow-service.js';
import { FlowWorkspaceError } from '../src/followup-sequences/workspace.js';
import type { PortalSessionIdentity } from '../src/portal/auth-service.js';

const SECRET = 'synthetic-pp-followup-secret-at-least-32-chars';
const POINT = '2b5d8a3c-4f1e-4c7a-9d2b-1a2b3c4d5e6f', OTHER = '3c6e9b4d-5a2f-4d8b-8e3c-2b3c4d5e6f70';
const ORIGIN = 'https://hq.propertypredator.com';
const ENV = { PP_MARKETING_MODE: 'test', PP_POSTMARK_SERVER_TOKEN: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', PP_MARKETING_FROM: 'Hello@PropertyPredator.com',
  PP_MARKETING_REPLY_TO: 'office@propertypredator.com', PP_MARKETING_TEST_TO: 'Owner@Example.com, second@example.com', PORTAL_BASE_URL: ORIGIN, SESSION_SECRET: SECRET };
const canonical = canonicalFlowMessage('email', { schema: 'propertypredator.email-draft/v1', subject: 'Hi {{FIRSTNAME}}', bodyText: 'From {{LABEL}}: {{LINK}}\nLeave: {{UNSUBSCRIBE}}' });
const sha = createHash('sha256').update(canonical).digest('hex');

test('PP delivery config defaults to off, never throws and only reports ready when complete', () => {
  assert.deepEqual(ppMarketingConfig({}), { status: { mode: 'off', ready: false, problems: [] }, config: null });
  const test = ppMarketingConfig(ENV);
  assert.equal(test.status.ready, true); assert.equal(test.config?.mode, 'test');
  assert.deepEqual(test.config?.testRecipients, ['owner@example.com', 'second@example.com']);
  assert.equal(test.config?.from, 'hello@propertypredator.com'); assert.equal(test.config?.stream, 'broadcast'); assert.equal(test.config?.unsubscribeOrigin, ORIGIN);
  const noList = ppMarketingConfig({ ...ENV, PP_MARKETING_TEST_TO: '' });
  assert.equal(noList.config, null); assert.match(noList.status.problems.join(), /PP_MARKETING_TEST_TO/u);
  const live = ppMarketingConfig({ ...ENV, PP_MARKETING_MODE: 'live', PP_POSTMARK_SERVER_TOKEN: '', PORTAL_BASE_URL: 'http://insecure.example' });
  assert.equal(live.status.ready, false); assert.equal(live.status.mode, 'live');
  assert.match(live.status.problems.join(), /PP_POSTMARK_SERVER_TOKEN/u); assert.match(live.status.problems.join(), /PORTAL_BASE_URL/u);
  assert.equal(ppMarketingConfig({ ...ENV, PP_MARKETING_MODE: 'LIVE' }).status.mode, 'off');
  assert.equal(ppMarketingConfig({ ...ENV, PP_MARKETING_MODE: 'live' }).config?.testRecipients, null);
  assert.ok(!JSON.stringify(live.status).includes(ENV.PP_POSTMARK_SERVER_TOKEN), 'status never carries the token');
});

test('unsubscribe links are signed per contact point and only valid for that point', () => {
  const url = new URL(ppUnsubscribeUrl(ORIGIN, SECRET, POINT));
  assert.equal(url.origin, ORIGIN); assert.equal(url.pathname, PP_FOLLOWUP_UNSUBSCRIBE_ROUTE); assert.equal(url.searchParams.get('p'), POINT);
  const token = url.searchParams.get('t')!;
  assert.equal(verifyPpUnsubscribeToken(SECRET, POINT, token), true);
  assert.equal(verifyPpUnsubscribeToken(SECRET, OTHER, token), false);
  assert.equal(verifyPpUnsubscribeToken('another-secret-of-sufficient-length-x', POINT, token), false);
  assert.equal(verifyPpUnsubscribeToken(SECRET, POINT, 'short'), false);
  assert.throws(() => ppUnsubscribeUrl('http://hq.propertypredator.com', SECRET, POINT), /https/u);
  assert.throws(() => ppUnsubscribeToken(SECRET, 'not-a-uuid'));
});

test('rendering fills exact approved copy once, escapes HTML and refuses changed bytes or foreign links', () => {
  const unsubscribe = ppUnsubscribeUrl(ORIGIN, SECRET, POINT);
  const input = { canonicalContent: canonical, contentSha256: sha, displayName: 'Ann <b>{{LINK}}</b> Smith', label: 'Property Predator',
    link: 'https://propertypredator.com/next', unsubscribe, productName: 'Property Predator', unsubscribeOrigin: ORIGIN };
  const rendered = renderPpFollowupEmail(input);
  assert.equal(rendered.subject, 'Hi Ann');
  assert.match(rendered.text, /From Property Predator: https:\/\/propertypredator\.com\/next/u);
  assert.ok(rendered.text.endsWith(`Unsubscribe: ${unsubscribe}`));
  const tricky = renderPpFollowupEmail({ ...input, displayName: '{{LINK}}' });
  assert.equal(tricky.subject, 'Hi {{LINK}}', 'placeholder values are never re-scanned');
  assert.match(renderPpFollowupEmail({ ...input, displayName: '<script>' }).html, /&lt;script&gt;/u);
  assert.throws(() => renderPpFollowupEmail({ ...input, contentSha256: '0'.repeat(64) }), /digest/u);
  assert.throws(() => renderPpFollowupEmail({ ...input, unsubscribe: 'https://evil.example/email/follow-up/unsubscribe?p=x' }), /unsubscribe/u);
  assert.throws(() => renderPpFollowupEmail({ ...input, link: 'http://propertypredator.com' }), /link/u);
});

function config(over: Partial<PpMarketingConfig> = {}): PpMarketingConfig {
  return { mode: 'live', token: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', from: 'hello@propertypredator.com', fromName: 'Property Predator', replyTo: 'office@propertypredator.com',
    stream: 'broadcast', testRecipients: null, link: 'https://propertypredator.com/', unsubscribeOrigin: ORIGIN, ...over };
}
const rendered = () => renderPpFollowupEmail({ canonicalContent: canonical, contentSha256: sha, displayName: 'Ann', label: 'Property Predator', link: 'https://propertypredator.com/',
  unsubscribe: ppUnsubscribeUrl(ORIGIN, SECRET, POINT), productName: 'Property Predator', unsubscribeOrigin: ORIGIN });

test('Postmark sender posts one broadcast message with one-click unsubscribe and resolves only with a MessageID', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  let reply: Response = new Response(JSON.stringify({ ErrorCode: 0, MessageID: 'pm-1' }), { status: 200 });
  const fetcher = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return reply; }) as unknown as typeof fetch;
  const sender = createPpPostmarkSender(config(), fetcher);
  assert.equal(await sender.sendRendered({ id: 'send-1', email: 'Ann@Example.com', tag: 'pp_followup', rendered: rendered() }), 'pm-1');
  assert.equal(calls[0]!.url, 'https://api.postmarkapp.com/email');
  const headers = calls[0]!.init.headers as Record<string, string>, body = JSON.parse(String(calls[0]!.init.body));
  assert.equal(headers['X-Postmark-Server-Token'], 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  assert.equal(body.From, 'Property Predator <hello@propertypredator.com>'); assert.equal(body.To, 'ann@example.com'); assert.equal(body.MessageStream, 'broadcast');
  assert.equal(body.TrackOpens, false); assert.equal(body.TrackLinks, 'None'); assert.deepEqual(body.Metadata, { send: 'send-1' });
  assert.deepEqual(body.Headers.map((h: { Name: string }) => h.Name), ['List-Unsubscribe', 'List-Unsubscribe-Post']);
  reply = new Response(JSON.stringify({ ErrorCode: 406, Message: 'Inactive recipient' }), { status: 200 });
  await assert.rejects(sender.sendRendered({ id: 'send-2', email: 'ann@example.com', tag: 'pp_followup', rendered: rendered() }), /not accepted/u);
  reply = new Response('{}', { status: 422 });
  await assert.rejects(sender.sendRendered({ id: 'send-3', email: 'ann@example.com', tag: 'pp_followup', rendered: rendered() }), /not accepted/u);
  const testSender = createPpPostmarkSender(config({ mode: 'test', testRecipients: ['owner@example.com'] }), fetcher);
  const before = calls.length;
  await assert.rejects(testSender.sendRendered({ id: 'send-4', email: 'ann@example.com', tag: 'pp_followup', rendered: rendered() }), /test list/u);
  assert.equal(calls.length, before, 'test mode refuses before any provider call');
});

const LEASE = { id: '4d7fa05e-6b3a-4e9c-9f4d-3c4d5e6f7081', leaseId: '5e80b16f-7c4b-4fad-a05e-4d5e6f708192', leaseUntil: new Date(Date.now() + 120_000).toISOString() };
const PREPARED: PpFollowupPrepared = { ...LEASE, proofId: '6f91c270-8d5c-4abe-b16f-5e6f708192a3', runId: '70a2d381-9e6d-4bcf-827a-6f708192a3b4', step: 0,
  contactPointId: POINT, email: 'ann@example.com', displayName: 'Ann Smith', contentVersionId: '81b3e492-af7e-4cd0-9381-708192a3b4c5', canonicalContent: canonical, contentSha256: sha };
function queueFixture(over: Partial<{ prepared: PpFollowupPrepared | null; prepareFails: boolean; settleFails: boolean }> = {}) {
  const calls: string[] = []; let claimedWith: readonly string[] | null | undefined;
  const queue: PpFollowupQueue = {
    claim: async (_limit, _seconds, emails) => { claimedWith = emails; calls.push('claim'); return [LEASE]; },
    prepare: async () => { calls.push('prepare'); if (over.prepareFails) throw new Error('lost'); return over.prepared === undefined ? PREPARED : over.prepared; },
    settle: async (_lease, accepted, reference) => { calls.push(`settle:${accepted}:${reference}`); if (over.settleFails) throw new Error('lost'); },
    unknown: async () => { calls.push('unknown'); },
  };
  return { queue, calls, claimed: () => claimedWith };
}
const dispatchConfig = { testRecipients: ['ann@example.com'], link: 'https://propertypredator.com/', unsubscribeOrigin: ORIGIN, fromName: 'Property Predator' };

test('dispatcher settles only a real Postmark acceptance and treats any failure after the proof as unknown', async () => {
  const ok = queueFixture(), sent: string[] = [];
  const sender = { sendRendered: async (item: { email: string; rendered: { subject: string } }) => { sent.push(`${item.email}:${item.rendered.subject}`); return 'pm-42'; } };
  assert.deepEqual(await dispatchPpFollowupEmails({ queue: ok.queue, sender, unsubscribeSecret: SECRET, config: dispatchConfig }), { sent: 1, failed: 0, unknown: 0 });
  assert.deepEqual(ok.calls, ['claim', 'prepare', 'settle:true:pm-42']); assert.deepEqual(sent, ['ann@example.com:Hi Ann']);
  assert.deepEqual(ok.claimed(), ['ann@example.com'], 'test mode filters the claim');

  const failing = queueFixture(), boom = { sendRendered: async () => { throw new Error('timeout'); } };
  assert.deepEqual(await dispatchPpFollowupEmails({ queue: failing.queue, sender: boom, unsubscribeSecret: SECRET, config: dispatchConfig }), { sent: 0, failed: 0, unknown: 1 });
  assert.deepEqual(failing.calls, ['claim', 'prepare', 'unknown']);

  const lostSettle = queueFixture({ settleFails: true });
  assert.deepEqual(await dispatchPpFollowupEmails({ queue: lostSettle.queue, sender, unsubscribeSecret: SECRET, config: dispatchConfig }), { sent: 0, failed: 0, unknown: 1 });
  assert.deepEqual(lostSettle.calls, ['claim', 'prepare', 'settle:true:pm-42', 'unknown']);

  const noProof = queueFixture({ prepared: null });
  assert.deepEqual(await dispatchPpFollowupEmails({ queue: noProof.queue, sender, unsubscribeSecret: SECRET, config: dispatchConfig }), { sent: 0, failed: 0, unknown: 0 });
  const prepareLost = queueFixture({ prepareFails: true });
  assert.deepEqual(await dispatchPpFollowupEmails({ queue: prepareLost.queue, sender, unsubscribeSecret: SECRET, config: dispatchConfig }), { sent: 0, failed: 1, unknown: 0 });
  assert.deepEqual(prepareLost.calls, ['claim', 'prepare'], 'a failure before the proof never reaches the provider or the unknown hold');

  const expiring = queueFixture({ prepared: { ...PREPARED, leaseUntil: LEASE.leaseUntil } });
  const expiringSent: string[] = [];
  assert.deepEqual(await dispatchPpFollowupEmails({ queue: expiring.queue, sender: { sendRendered: async () => { expiringSent.push('x'); return 'pm'; } }, unsubscribeSecret: SECRET,
    config: dispatchConfig, now: () => Date.parse(LEASE.leaseUntil) - 5_000 }), { sent: 0, failed: 0, unknown: 1 });
  assert.deepEqual(expiringSent, [], 'an expiring proof is never handed to Postmark');
});

test('the dispatcher loop is single-flight and stops cleanly', async () => {
  let claims = 0;
  const queue: PpFollowupQueue = { claim: async () => { claims++; return []; }, prepare: async () => null, settle: async () => {}, unknown: async () => {} };
  const stop = startPpFollowupDispatcher({ queue, sender: { sendRendered: async () => 'x' }, unsubscribeSecret: SECRET, config: dispatchConfig }, { intervalMs: 5 });
  await new Promise(resolve => setTimeout(resolve, 30)); stop(); const after = claims;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(after >= 1); assert.equal(claims, after);
});

test('PG adapters call only the fixed 0152 capabilities and reject unpinned results', async () => {
  const calls: { sql: string; values: unknown[] }[] = []; let value: unknown = [LEASE];
  const pool = { query: async (sql: string, values: unknown[]) => { calls.push({ sql, values }); return { rows: [{ jobs: value, prepared: value, value }] }; } };
  const queue = new PgPpFollowupQueue(pool as never);
  assert.deepEqual(await queue.claim(25, 120, null), [LEASE]);
  value = { ...PREPARED, leaseId: OTHER }; await assert.rejects(queue.prepare(LEASE), /dispatch proof/u);
  value = null; assert.equal(await queue.prepare(LEASE), null);
  await queue.settle(LEASE, true, 'pm-1'); await queue.unknown(LEASE);
  assert.deepEqual(calls.map(call => call.sql.match(/app_private\.(\w+)/u)?.[1]), ['pp_followup_claim', 'pp_followup_prepare', 'pp_followup_prepare', 'pp_followup_settle', 'pp_followup_unknown']);
  const repo = new PgPpFollowupRepository(pool as never, pool as never);
  const foreign = { sessionToken: 'token', userId: OTHER, workspaceId: OTHER } as PortalSessionIdentity;
  await assert.rejects(repo.snapshot(foreign), (error: unknown) => error instanceof FlowWorkspaceError && error.status === 403);
  value = { known: true, recorded: true, stopped: 2 };
  assert.deepEqual(await repo.unsubscribe(POINT), { known: true, recorded: true, stopped: 2 });
  await assert.rejects(repo.unsubscribe('nope'));
  assert.throws(() => parsePpFollowupSnapshot({ campaign: 'pp-owner-followup', permitted: -1, runCount: 0, contacts: [], runs: [] }));
  assert.equal(PP_FOLLOWUP_WORKSPACE_ID, 'd975ff66-336a-46c2-b36b-d7095a11af97');
});

async function call(method: string, target: string, unsubscribe: (point: string) => Promise<{ known: boolean; recorded: boolean; stopped: number }>) {
  const result = { status: 0, body: '' };
  const req = Object.assign(Readable.from([Buffer.from('List-Unsubscribe=One-Click')]), { method, url: target, headers: {} }) as unknown as IncomingMessage;
  const res = { writeHead(status: number) { result.status = status; }, end(body = '') { result.body = body; } } as unknown as ServerResponse;
  const handled = await handlePpFollowupUnsubscribe(req, res, new URL(target, ORIGIN), { secret: SECRET, unsubscriber: { unsubscribe } });
  return { ...result, handled };
}
test('unsubscribe link: GET only confirms, POST (one-click) records it, forged links do nothing', async () => {
  const seen: string[] = [], unsubscribe = async (point: string) => { seen.push(point); return { known: true, recorded: true, stopped: 1 }; };
  const link = new URL(ppUnsubscribeUrl(ORIGIN, SECRET, POINT)), target = link.pathname + link.search;
  const get = await call('GET', target, unsubscribe);
  assert.equal(get.status, 200); assert.match(get.body, /<form method="post"/u); assert.deepEqual(seen, []);
  const post = await call('POST', target, unsubscribe);
  assert.equal(post.status, 200); assert.match(post.body, /unsubscribed/u); assert.deepEqual(seen, [POINT]);
  const forged = await call('POST', `${PP_FOLLOWUP_UNSUBSCRIBE_ROUTE}?p=${OTHER}&t=${link.searchParams.get('t')}`, unsubscribe);
  assert.equal(forged.status, 400); assert.deepEqual(seen, [POINT]);
  const failing = await call('POST', target, async () => { throw new Error('db down'); });
  assert.equal(failing.status, 503);
  assert.equal((await call('GET', '/elsewhere', unsubscribe)).handled, false);
});

test('portal readiness and executable follow the composed sender; Start rechecks publication and readiness', async () => {
  const stub = {} as never;
  const base = { context: stub, reader: stub, adapter: stub, approvals: stub, transactions: stub, local: stub, messages: stub };
  assert.equal(new PortalFollowupFlowService(base).readiness.email, false);
  const commands: string[] = [];
  const repository = { snapshot: async () => { throw new Error('unused'); }, command: async (_identity: unknown, input: { action: string }) => { commands.push(input.action);
    return { action: input.action, contentItemId: OTHER, contentVersionId: POINT, changed: 1, remaining: 0, blocked: 0, inFlight: 0, reason: null, replayed: false } as never; } };
  const off = new PortalFollowupFlowService({ ...base, delivery: { repository, status: { mode: 'off', ready: false, problems: [] } } });
  const live = new PortalFollowupFlowService({ ...base, delivery: { repository, status: { mode: 'live', ready: true, problems: [] } } });
  assert.equal(off.readiness.email, false); assert.equal(live.readiness.email, true);
  const detail = { valid: true, blockers: [] as string[], review: { isLatest: true, approvalStatus: 'approved', approvalStale: false } };
  for (const service of [off, live]) Object.defineProperty(service, 'review', { value: async () => detail });
  const identity = { sessionToken: 't', userId: OTHER, workspaceId: PP_FOLLOWUP_WORKSPACE_ID } as PortalSessionIdentity;
  const input = { action: 'enrol' as const, commandId: '92c4f5a3-b08f-4de1-a4a2-8192a3b4c5d6', itemId: OTHER, versionId: POINT, contactPointId: LEASE.id, runId: '', ackProofId: '' };
  await assert.rejects(off.command(identity, 'r', input), /off or not fully configured/u);
  await live.command(identity, 'r', input); assert.deepEqual(commands, ['enrol']);
  detail.review.approvalStatus = 'unrequested';
  await assert.rejects(live.command(identity, 'r', input), /Publish the latest flow/u);
  await off.command(identity, 'r', { ...input, action: 'stop', contactPointId: '' });
  assert.deepEqual(commands, ['enrol', 'stop'], 'stop never needs readiness or publication');
  await assert.rejects(live.command(identity, 'r', { ...input, contactPointId: '' }), /Refresh/u);
  await assert.rejects(new PortalFollowupFlowService(base).command(identity, 'r', input), /not connected/u);
});
