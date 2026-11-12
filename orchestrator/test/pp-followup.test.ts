import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { canonicalFlowMessage } from '../src/followup-sequences/channel-drafts.js';
import { normalizePpEmail, ppMarketingConfig, type PpMarketingConfig } from '../src/pp-followup/config.js';
import { PP_FOLLOWUP_UNSUBSCRIBE_ROUTE, ppUnsubscribeToken, ppUnsubscribeUrl, renderPpFollowupEmail, verifyPpUnsubscribeToken } from '../src/pp-followup/content.js';
import { createPpPostmarkSender, PpNotSentError } from '../src/pp-followup/mail.js';
import { dispatchPpFollowupEmails, startPpFollowupDispatcher } from '../src/pp-followup/dispatch.js';
import { PgPpFollowupQueue, PgPpFollowupRepository, PP_FOLLOWUP_WORKSPACE_ID, parsePpFollowupSnapshot, type PpFollowupPrepared, type PpFollowupQueue, type PpFollowupRun } from '../src/pp-followup/repository.js';
import { handlePpFollowupUnsubscribe } from '../src/pp-followup/unsubscribe-route.js';
import { PortalFollowupFlowService, PP_FOLLOWUP_CAMPAIGN } from '../src/portal/followup-flow-service.js';
import { ppFlowCommandMessage, renderPortalFlowPage, type PortalFlowPageInput } from '../src/portal/followup-flow-view.js';
import { createFollowupTools } from '../src/operator/followup-tools.js';
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

test('recipient addresses: apostrophes are valid, anything that could carry a second address is not', () => {
  assert.equal(normalizePpEmail(" O'Brien@Example.com "), "o'brien@example.com");
  assert.equal(normalizePpEmail('first.last+tag@sub.example.co.uk'), 'first.last+tag@sub.example.co.uk');
  for (const bad of ['', 'no-at.example.com', 'a@b', 'two@example.com,three@example.com', 'Name <a@example.com>', '"quoted"@example.com', 'a b@example.com', 'a@exa mple.com', 'a@example.com\r\nBcc: x@example.com', `${'x'.repeat(65)}@example.com`])
    assert.equal(normalizePpEmail(bad), null, bad);
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
  const accept = () => new Response(JSON.stringify({ ErrorCode: 0, MessageID: 'pm-1' }), { status: 200 });
  let reply: Response | undefined;
  const fetcher = (async (url: string, init: RequestInit) => { calls.push({ url, init }); const next = reply ?? accept(); reply = undefined; return next; }) as unknown as typeof fetch;
  const sender = createPpPostmarkSender(config(), fetcher);
  assert.equal(await sender.sendRendered({ id: 'send-1', email: 'Ann@Example.com', tag: 'pp_followup', rendered: rendered() }), 'pm-1');
  assert.equal(calls[0]!.url, 'https://api.postmarkapp.com/email');
  const headers = calls[0]!.init.headers as Record<string, string>, body = JSON.parse(String(calls[0]!.init.body));
  assert.equal(headers['X-Postmark-Server-Token'], 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  assert.equal(body.From, 'Property Predator <hello@propertypredator.com>'); assert.equal(body.To, 'ann@example.com'); assert.equal(body.MessageStream, 'broadcast');
  assert.equal(body.TrackOpens, false); assert.equal(body.TrackLinks, 'None'); assert.deepEqual(body.Metadata, { send: 'send-1' });
  assert.deepEqual(body.Headers.map((h: { Name: string }) => h.Name), ['List-Unsubscribe', 'List-Unsubscribe-Post']);
  assert.equal(await sender.sendRendered({ id: 'send-1b', email: "O'Brien@Example.com", tag: 'pp_followup', rendered: rendered() }), 'pm-1');
  assert.equal(JSON.parse(String(calls[1]!.init.body)).To, "o'brien@example.com");
  const refusal = async (answer: Response | Error, email = 'ann@example.com') => {
    const using = answer instanceof Error ? createPpPostmarkSender(config(), (async () => { throw answer; }) as unknown as typeof fetch) : sender;
    if (!(answer instanceof Error)) reply = answer;
    try { await using.sendRendered({ id: 'send-x', email, tag: 'pp_followup', rendered: rendered() }); return 'accepted'; }
    catch (error) { return error instanceof PpNotSentError ? error.scope : 'unknown'; }
  };
  // Definite refusals say what was refused; nothing here is ever "may have been sent".
  assert.equal(await refusal(new Response(JSON.stringify({ ErrorCode: 10, Message: 'Bad or missing Server API token.' }), { status: 401 })), 'sender');
  assert.equal(await refusal(new Response('', { status: 429 })), 'sender');
  assert.equal(await refusal(new Response(JSON.stringify({ ErrorCode: 400, Message: 'Sender signature not found' }), { status: 422 })), 'sender');
  assert.equal(await refusal(new Response(JSON.stringify({ ErrorCode: 300, Message: 'Invalid email request' }), { status: 422 })), 'message');
  assert.equal(await refusal(new Response('{}', { status: 422 })), 'message');
  assert.equal(await refusal(new Response('not json', { status: 413 })), 'message');
  assert.equal(await refusal(new Response(JSON.stringify({ ErrorCode: 406, Message: 'Inactive recipient' }), { status: 422 })), 'recipient');
  assert.equal(await refusal(new Response(JSON.stringify({ ErrorCode: 406, Message: 'Inactive recipient' }), { status: 200 })), 'recipient');
  assert.equal(await refusal(accept(), 'not an address'), 'recipient');
  // Genuinely uncertain: the request may have reached Postmark.
  assert.equal(await refusal(new Response('upstream error', { status: 500 })), 'unknown');
  assert.equal(await refusal(new Response('', { status: 503 })), 'unknown');
  assert.equal(await refusal(new Response('', { status: 408 })), 'unknown');
  assert.equal(await refusal(new Response('not json', { status: 200 })), 'unknown');
  assert.equal(await refusal(new Response(JSON.stringify({ ErrorCode: 0 }), { status: 200 })), 'unknown', 'accepted without a message id is not provably sent');
  assert.equal(await refusal(new Error('socket hang up')), 'unknown');
  assert.equal(await refusal(new DOMException('The operation timed out', 'TimeoutError')), 'unknown');
  reply = new Response(JSON.stringify({ ErrorCode: 406, Message: 'Inactive recipient' }), { status: 200 });
  await assert.rejects(sender.sendRendered({ id: 'send-2', email: 'ann@example.com', tag: 'pp_followup', rendered: rendered() }), /not accepted/u);
  const testSender = createPpPostmarkSender(config({ mode: 'test', testRecipients: ['owner@example.com'] }), fetcher);
  const before = calls.length;
  await assert.rejects(testSender.sendRendered({ id: 'send-4', email: 'ann@example.com', tag: 'pp_followup', rendered: rendered() }), /test list/u);
  assert.equal(calls.length, before, 'test mode refuses before any provider call');
});

const LEASE = { id: '4d7fa05e-6b3a-4e9c-9f4d-3c4d5e6f7081', leaseId: '5e80b16f-7c4b-4fad-a05e-4d5e6f708192', leaseUntil: new Date(Date.now() + 120_000).toISOString(), email: 'ann@example.com' };
const PREPARED: PpFollowupPrepared = { ...LEASE, proofId: '6f91c270-8d5c-4abe-b16f-5e6f708192a3', runId: '70a2d381-9e6d-4bcf-827a-6f708192a3b4', step: 0,
  contactPointId: POINT, email: 'ann@example.com', displayName: 'Ann Smith', contentVersionId: '81b3e492-af7e-4cd0-9381-708192a3b4c5', canonicalContent: canonical, contentSha256: sha };
function queueFixture(over: Partial<{ prepared: PpFollowupPrepared | null; prepareFails: boolean; settleFails: boolean; leases: (typeof LEASE)[] }> = {}) {
  const calls: string[] = []; let claimedWith: readonly string[] | null | undefined;
  const queue: PpFollowupQueue = {
    claim: async (_limit, _seconds, emails) => { claimedWith = emails; calls.push('claim'); return over.leases ?? [LEASE]; },
    prepare: async () => { calls.push('prepare'); if (over.prepareFails) throw new Error('lost'); return over.prepared === undefined ? PREPARED : over.prepared; },
    settle: async (_lease, outcome, reference) => { calls.push(`settle:${outcome}:${reference}`); if (over.settleFails) throw new Error('lost'); },
    unknown: async () => { calls.push('unknown'); },
  };
  return { queue, calls, claimed: () => claimedWith };
}
const dispatchConfig = { testRecipients: ['ann@example.com'], link: 'https://propertypredator.com/', unsubscribeOrigin: ORIGIN, fromName: 'Property Predator' };

test('dispatcher settles only a real Postmark acceptance and treats any failure after the proof as unknown', async () => {
  const ok = queueFixture(), sent: string[] = [];
  const sender = { sendRendered: async (item: { email: string; rendered: { subject: string } }) => { sent.push(`${item.email}:${item.rendered.subject}`); return 'pm-42'; } };
  assert.deepEqual(await dispatchPpFollowupEmails({ queue: ok.queue, sender, unsubscribeSecret: SECRET, config: dispatchConfig }), { sent: 1, failed: 0, unknown: 0 });
  assert.deepEqual(ok.calls, ['claim', 'prepare', 'settle:accepted:pm-42']); assert.deepEqual(sent, ['ann@example.com:Hi Ann']);
  assert.deepEqual(ok.claimed(), ['ann@example.com'], 'test mode filters the claim');

  const failing = queueFixture(), boom = { sendRendered: async () => { throw new Error('timeout'); } };
  assert.deepEqual(await dispatchPpFollowupEmails({ queue: failing.queue, sender: boom, unsubscribeSecret: SECRET, config: dispatchConfig }), { sent: 0, failed: 0, unknown: 1 });
  assert.deepEqual(failing.calls, ['claim', 'prepare', 'unknown']);

  const lostSettle = queueFixture({ settleFails: true });
  assert.deepEqual(await dispatchPpFollowupEmails({ queue: lostSettle.queue, sender, unsubscribeSecret: SECRET, config: dispatchConfig }), { sent: 0, failed: 0, unknown: 1 });
  assert.deepEqual(lostSettle.calls, ['claim', 'prepare', 'settle:accepted:pm-42', 'unknown'], 'an accepted email whose settlement was lost is never recorded as a refusal');

  const noProof = queueFixture({ prepared: null });
  assert.deepEqual(await dispatchPpFollowupEmails({ queue: noProof.queue, sender, unsubscribeSecret: SECRET, config: dispatchConfig }), { sent: 0, failed: 0, unknown: 0 });
  const prepareLost = queueFixture({ prepareFails: true });
  assert.deepEqual(await dispatchPpFollowupEmails({ queue: prepareLost.queue, sender, unsubscribeSecret: SECRET, config: dispatchConfig }), { sent: 0, failed: 1, unknown: 0 });
  assert.deepEqual(prepareLost.calls, ['claim', 'prepare'], 'a failure before the proof never reaches the provider or the unknown hold');

  const expiring = queueFixture({ prepared: { ...PREPARED, leaseUntil: LEASE.leaseUntil } });
  const expiringSent: string[] = [];
  assert.deepEqual(await dispatchPpFollowupEmails({ queue: expiring.queue, sender: { sendRendered: async () => { expiringSent.push('x'); return 'pm'; } }, unsubscribeSecret: SECRET,
    config: dispatchConfig, now: () => Date.parse(LEASE.leaseUntil) - 5_000 }), { sent: 0, failed: 1, unknown: 0 });
  assert.deepEqual(expiringSent, [], 'an expiring lease is never handed to Postmark');
  assert.deepEqual(expiring.calls, ['claim'], 'the lease-time check runs before any proof is written, so nothing is spent or held');
});

test('dispatcher records definite non-sends as plain failures; only uncertain hand-offs are held as unknown', async () => {
  const run = async (sender: { sendRendered: () => Promise<string> }, over: Parameters<typeof queueFixture>[0] = {}, config = dispatchConfig) => {
    const fixture = queueFixture(over); let refused = 0;
    const result = await dispatchPpFollowupEmails({ queue: fixture.queue, sender, unsubscribeSecret: SECRET, config, onSenderRefused: () => { refused++; } });
    return { result, calls: fixture.calls, refused };
  };
  const throwing = (error: Error) => ({ sendRendered: async (): Promise<string> => { throw error; } });
  // One bad server token: the sweep stops at the first refusal and every other lease is left unspent.
  const second = { ...LEASE, id: OTHER };
  const token = await run(throwing(new PpNotSentError('sender')), { leases: [LEASE, second] });
  assert.deepEqual(token.result, { sent: 0, failed: 1, unknown: 0 });
  assert.deepEqual(token.calls, ['claim', 'prepare', 'settle:deferred:null']); assert.equal(token.refused, 1);
  const message = await run(throwing(new PpNotSentError('message')));
  assert.deepEqual([message.result, message.calls, message.refused], [{ sent: 0, failed: 1, unknown: 0 }, ['claim', 'prepare', 'settle:rejected:null'], 0]);
  const recipient = await run(throwing(new PpNotSentError('recipient')));
  assert.deepEqual([recipient.result, recipient.calls], [{ sent: 0, failed: 1, unknown: 0 }, ['claim', 'prepare', 'settle:undeliverable:null']]);
  // An address that can never be sent to fails before any proof exists.
  let handed = 0; const counting = { sendRendered: async () => { handed++; return 'pm-1'; } };
  const invalid = await run(counting, { leases: [{ ...LEASE, email: 'not an address' }] });
  assert.deepEqual([invalid.result, invalid.calls], [{ sent: 0, failed: 1, unknown: 0 }, ['claim', 'settle:undeliverable:null']]);
  // Test mode: someone outside the list is never prepared or handed over, whatever the claim returned.
  const outside = await run(counting, { leases: [{ ...LEASE, email: 'stranger@example.com' }] });
  assert.deepEqual([outside.result, outside.calls], [{ sent: 0, failed: 1, unknown: 0 }, ['claim']]);
  // The proof names a different address from the claim: nothing is sent and the attempt is handed back.
  const moved = await run(counting, { prepared: { ...PREPARED, email: 'other@example.com' } });
  assert.deepEqual([moved.result, moved.calls], [{ sent: 0, failed: 1, unknown: 0 }, ['claim', 'prepare', 'settle:deferred:null']]);
  // Rendering fails after the proof (changed bytes): certain non-send, never reaches Postmark, never "unknown".
  const broken = await run(counting, { prepared: { ...PREPARED, contentSha256: '0'.repeat(64) } });
  assert.deepEqual([broken.result, broken.calls], [{ sent: 0, failed: 1, unknown: 0 }, ['claim', 'prepare', 'settle:rejected:null']]);
  assert.equal(handed, 0);
  // If even the refusal cannot be recorded, the unresolved proof is held rather than retried silently.
  const lost = await run(throwing(new PpNotSentError('message')), { settleFails: true });
  assert.deepEqual([lost.result, lost.calls], [{ sent: 0, failed: 0, unknown: 1 }, ['claim', 'prepare', 'settle:rejected:null', 'unknown']]);
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
  await queue.settle(LEASE, 'accepted', 'pm-1'); await queue.settle(LEASE, 'rejected', 'ignored'); await queue.unknown(LEASE);
  assert.deepEqual(calls.filter(call => call.sql.includes('pp_followup_settle')).map(call => call.values.slice(2)), [['accepted', 'pm-1'], ['rejected', null]]);
  value = [{ ...LEASE, email: undefined }]; await assert.rejects(queue.claim(25, 120, null), /lease batch/u); value = null;
  assert.deepEqual(calls.map(call => call.sql.match(/app_private\.(\w+)/u)?.[1]), ['pp_followup_claim', 'pp_followup_prepare', 'pp_followup_prepare', 'pp_followup_settle', 'pp_followup_settle', 'pp_followup_unknown', 'pp_followup_claim']);
  const repo = new PgPpFollowupRepository(pool as never, pool as never);
  const foreign = { sessionToken: 'token', userId: OTHER, workspaceId: OTHER } as PortalSessionIdentity;
  await assert.rejects(repo.snapshot(foreign), (error: unknown) => error instanceof FlowWorkspaceError && error.status === 403);
  value = { known: true, recorded: true, stopped: 2 };
  assert.deepEqual(await repo.unsubscribe(POINT), { known: true, recorded: true, stopped: 2 });
  await assert.rejects(repo.unsubscribe('nope'));
  assert.throws(() => parsePpFollowupSnapshot({ campaign: 'pp-owner-followup', permitted: -1, contactMatches: 0, runMatches: 0, runCount: 0, contacts: [], runs: [] }));
  assert.throws(() => parsePpFollowupSnapshot({ campaign: 'pp-owner-followup', permitted: 0, runCount: 0, contacts: [], runs: [] }), 'the match counts are required');
  const mine = { sessionToken: 'token', userId: OTHER, workspaceId: PP_FOLLOWUP_WORKSPACE_ID } as PortalSessionIdentity;
  value = { campaign: 'pp-owner-followup', permitted: 0, contactMatches: 0, runMatches: 0, runCount: 0, contacts: [], runs: [] };
  await repo.snapshot(mine, { itemId: POINT, search: "  O'Brien " });
  assert.match(calls.at(-1)!.sql, /pp_followup_snapshot\(\$1,\$2,\$3\)/u); assert.deepEqual(calls.at(-1)!.values.slice(1), [POINT, "O'Brien"]);
  await repo.snapshot(mine); assert.deepEqual(calls.at(-1)!.values.slice(1), [null, null]);
  await assert.rejects(repo.snapshot(mine, { search: 'x'.repeat(101) }), (error: unknown) => error instanceof FlowWorkspaceError && error.status === 400);
  value = { action: 'enrol', contentItemId: OTHER, contentVersionId: POINT, changed: 1, remaining: 0, blocked: 0, inFlight: 0, heldForTest: 1, reason: null, replayed: false };
  const command = { action: 'enrol' as const, commandId: LEASE.id, itemId: OTHER, versionId: POINT, contactPointId: LEASE.leaseId, runId: '', ackProofId: '', requestId: 'r' };
  assert.equal((await repo.command(mine, { ...command, testRecipients: ['owner@example.com'] })).heldForTest, 1);
  assert.deepEqual(calls.at(-1)!.values.at(-1), ['owner@example.com'], 'the test list reaches the database command');
  await repo.command(mine, command); assert.equal(calls.at(-1)!.values.at(-1), null);
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
  await assert.rejects(off.command(identity, 'r', input), /Email sending isn’t set up yet/u);
  await live.command(identity, 'r', input); assert.deepEqual(commands, ['enrol']);
  // A mode of live with incomplete settings is not ready: nothing can be started.
  const broken = new PortalFollowupFlowService({ ...base, delivery: { repository, status: { mode: 'live', ready: false, problems: ['PP_POSTMARK_SERVER_TOKEN is missing'] } } });
  Object.defineProperty(broken, 'review', { value: async () => detail });
  assert.equal(broken.readiness.email, false);
  await assert.rejects(broken.command(identity, 'r', input), /Email sending isn’t set up yet/u);
  detail.review.approvalStatus = 'unrequested';
  await assert.rejects(live.command(identity, 'r', input), /Publish the latest version first/u);
  await off.command(identity, 'r', { ...input, action: 'stop', contactPointId: '' });
  assert.deepEqual(commands, ['enrol', 'stop'], 'stop never needs readiness or publication');
  await assert.rejects(live.command(identity, 'r', { ...input, contactPointId: '' }), /This page was out of date\. Please try again\./u);
  await assert.rejects(new PortalFollowupFlowService(base).command(identity, 'r', input), /isn’t set up yet/u);
  // Test mode hands the test list to the database so people outside it are held; without a list nothing starts.
  detail.review.approvalStatus = 'approved';
  const lists: unknown[] = [];
  const listening = { ...repository, command: async (_identity: unknown, sent: { action: string; testRecipients?: readonly string[] | null }) => { lists.push(sent.testRecipients); return repository.command(_identity, sent); } };
  const testing = new PortalFollowupFlowService({ ...base, delivery: { repository: listening, status: { mode: 'test', ready: true, problems: [] }, testRecipients: ['owner@example.com'] } });
  const listless = new PortalFollowupFlowService({ ...base, delivery: { repository: listening, status: { mode: 'test', ready: true, problems: [] } } });
  const liveListening = new PortalFollowupFlowService({ ...base, delivery: { repository: listening, status: { mode: 'live', ready: true, problems: [] }, testRecipients: ['owner@example.com'] } });
  for (const service of [testing, listless, liveListening]) Object.defineProperty(service, 'review', { value: async () => detail });
  await testing.command(identity, 'r', input); await liveListening.command(identity, 'r', input);
  assert.deepEqual(lists, [['owner@example.com'], null], 'live mode never sends a test list');
  await assert.rejects(listless.command(identity, 'r', input), /isn’t set up yet/u);
});

const FLOW_ITEM = '92c4f5a3-b08f-4de1-a4a2-8192a3b4c5d6', FLOW_VERSION = 'a3d506b4-c190-4ef2-b5b3-92a3b4c5d6e7', EMAIL_ITEM = 'b4e617c5-d2a1-4f03-86c4-a3b4c5d6e7f8', EMAIL_VERSION = 'c5f728d6-e3b2-4014-97d5-b4c5d6e7f809';
const FLOW_RUN: PpFollowupRun = { id: OTHER, contentItemId: FLOW_ITEM, contentVersionId: FLOW_VERSION, contactId: POINT, contactPointId: POINT, email: 'ann@example.com', displayName: 'Ann Smith',
  state: 'active', position: 0, dueAt: '2026-11-12T10:00:00.000Z', reason: null, createdAt: '2026-11-11T10:00:00.000Z', lastAcceptedAt: null, inFlight: false, unknownProofId: null, steps: [] };
function flowPage(over: { mode?: 'off' | 'test' | 'live'; ready?: boolean; problems?: string[]; runs?: PpFollowupRun[]; permitted?: number; search?: string; contacts?: number; blockers?: string[]; delivery?: boolean } = {}): string {
  const ready = over.ready ?? true, runs = over.runs ?? [];
  const contacts = Array.from({ length: over.contacts ?? 1 }, (_unused, index) => ({ contactId: POINT, contactPointId: POINT, displayName: `Person ${index + 1}`, email: `person${index + 1}@example.com`, inOpenRun: false }));
  const snapshot = { brand: { productName: 'Property Predator', primaryColor: '#123b48', accentColor: '#e8a33d' }, catalog: { items: [] }, messageChoices: [], workspaceId: PP_FOLLOWUP_WORKSPACE_ID, campaign: PP_FOLLOWUP_CAMPAIGN,
    readiness: { email: ready, sms: false, whatsapp: false, reply: false, booked: false, purchased: false }, executable: ready,
    ...(over.delivery === false ? {} : { delivery: { mode: over.mode ?? 'live', problems: over.problems ?? [], search: over.search ?? '',
      database: { campaign: PP_FOLLOWUP_CAMPAIGN, permitted: over.permitted ?? 12, contactMatches: 1, contacts, runs, runMatches: runs.length, runCount: runs.length } } }) };
  const definition = { schema: 'growthhq.followup-sequence/v2', brand: 'pp', campaign: PP_FOLLOWUP_CAMPAIGN, title: 'Welcome', expiryHours: 24, entry: { mode: 'manual', source: 'manual_owner' },
    stopOn: { reply: false, booked: false, purchased: false }, steps: [
      { key: 's1', kind: 'email', contentItemId: EMAIL_ITEM, contentVersionId: EMAIL_VERSION, contentSha256: sha }, { key: 's2', kind: 'wait', minutes: 1440 },
      { key: 's3', kind: 'email', contentItemId: EMAIL_ITEM, contentVersionId: EMAIL_VERSION, contentSha256: sha }] };
  const detail = { review: { contentItemId: FLOW_ITEM, contentVersionId: FLOW_VERSION, versionNumber: 1, isLatest: true, approvalStatus: 'approved', approvalStale: false }, definition, valid: true,
    blockers: over.blockers ?? (ready ? [] : ['email_not_connected']), messages: [], timeline: [] };
  return renderPortalFlowPage({ snapshot, detail, csrf: 'csrf', commandId: LEASE.id, now: Date.parse('2026-11-12T12:00:00.000Z') } as unknown as PortalFlowPageInput);
}
/** The owner's main copy: everything outside the editor script and the closed "For your developer" blocks. */
const ownerCopy = (html: string) => html.replace(/<details><summary>For your developer<\/summary>[\s\S]*?<\/details>/gu, '').replace(/<style>[\s\S]*?<\/style>/u, '');

test('a mode of test or live with incomplete settings is shown as not set up, never as working', () => {
  const problems = ['PP_POSTMARK_SERVER_TOKEN is missing', 'PORTAL_BASE_URL must be the https portal origin that serves the unsubscribe link'];
  for (const mode of ['live', 'test', 'off'] as const) {
    const html = flowPage({ mode, ready: false, problems });
    assert.match(ownerCopy(html), /Email sending isn’t set up yet\./u, mode);
    assert.doesNotMatch(html, /Email sending is on|Email sending is in test mode|delivery is live/u, mode);
    assert.doesNotMatch(ownerCopy(html), /PP_[A-Z_]+|PORTAL_BASE_URL|SESSION_SECRET/u, 'setting names never appear in the owner copy');
    assert.match(html, /<details><summary>For your developer<\/summary><ul><li>PP_POSTMARK_SERVER_TOKEN is missing<\/li>/u);
    assert.match(html, /<button disabled type="button">Start this person<\/button>/u);
    assert.doesNotMatch(html, /action="\/portal\/follow-ups\/enrol"/u);
  }
  // Switched off on purpose (no problems) and not composed at all read the same way to the owner.
  for (const html of [flowPage({ mode: 'off', ready: false }), flowPage({ ready: false, delivery: false })]) {
    assert.match(ownerCopy(html), /Email sending isn’t set up yet\./u); assert.doesNotMatch(ownerCopy(html), /PP_MARKETING_MODE|0152/u); assert.match(html, /For your developer/u);
  }
  assert.match(flowPage({ mode: 'live' }), /<strong>Email sending is on\.<\/strong> People you start will get these emails\./u);
  assert.match(flowPage({ mode: 'test' }), /<strong>Email sending is in test mode\.<\/strong> Only your test addresses get emails\./u);
});

test('the owner page speaks plainly: five states, one stop button, clear unknown and in-flight notes', () => {
  const html = flowPage({ runs: [FLOW_RUN,
    { ...FLOW_RUN, id: POINT, state: 'held', reason: 'outcome_unknown', unknownProofId: LEASE.leaseId, position: 2, steps: [{ position: 0, acceptedAt: '2026-11-11T10:00:00.000Z', dueAt: '2026-11-11T10:00:00.000Z', expiresAt: '2026-11-12T10:00:00.000Z', cancelled: false, failed: false, held: false, inFlight: false }] },
    { ...FLOW_RUN, id: LEASE.id, state: 'paused', inFlight: true }, { ...FLOW_RUN, id: LEASE.leaseId, state: 'held', reason: 'recovery' }, { ...FLOW_RUN, id: FLOW_ITEM, state: 'held', reason: 'test_mode' },
    { ...FLOW_RUN, id: FLOW_VERSION, state: 'completed' }, { ...FLOW_RUN, id: EMAIL_ITEM, state: 'stopped', reason: 'manual' }, { ...FLOW_RUN, id: EMAIL_VERSION, state: 'cancelled' },
    { ...FLOW_RUN, id: PREPARED.proofId, state: 'failed', reason: 'delivery_failed' }] });
  for (const label of ['Running', 'Paused', 'Waiting for you', 'Finished', 'Stopped', 'Couldn’t send']) assert.match(html, new RegExp(`<strong>${label}</strong>`, 'u'), label);
  assert.doesNotMatch(html, /<strong>(?:active|paused|held|completed|stopped|cancelled|failed)<\/strong>/u, 'raw state values are never shown');
  assert.match(html, /12 people have agreed to marketing emails\. Only they can be started\./u);
  assert.match(flowPage({ permitted: 1 }), /1 person has agreed to marketing emails\. Only they can be started\./u);
  assert.match(html, /We’re not sure this email went out\.<\/strong> Check Postmark for this person first\. Send it again\? They might get it twice\./u);
  assert.match(html, /An email is going out right now\. If you stop, this one may still arrive\./u);
  assert.match(html, /Sent does not always mean it reached their inbox\./u);
  assert.match(html, /email 1 of 2/u); assert.match(html, /Email 1: sent 11 Nov 2026/u);
  assert.match(html, /Paused for safety after an update\. Press Resume when you’re ready\./u);
  assert.match(html, /isn’t on your test list/u);
  // One way to stop a person; "cancel" is not a second button and never a word on the page.
  assert.equal((html.match(/>Stop this person<\/button>/gu) ?? []).length, 5);
  assert.doesNotMatch(html, /Cancel|cancel/u); assert.doesNotMatch(html, /\/portal\/follow-ups\/cancel/u);
  assert.match(html, /<summary>Stop everyone in this flow<\/summary>/u); assert.match(html, />Yes, stop everyone<\/button>/u);
  // The unknown attempt has its own explicit decision and no plain Resume button.
  assert.equal((html.match(/>Resume this person<\/button>/gu) ?? []).length, 3);
  assert.match(html, /name="ackProofId" value="5e80b16f-7c4b-4fad-a05e-4d5e6f708192" required> I’ve checked Postmark\. Send it again\./u);
  // The parts of the page this feature owns (start controls and people), as the owner reads them.
  const owned = ownerCopy(html.slice(html.indexOf('<h2>Published flow</h2>'), html.indexOf('<h2>Not available yet</h2>'))).replace(/<[^>]+>/gu, ' ');
  assert.ok(owned.length > 1000);
  for (const jargon of [/release recovery/iu, /acceptance/iu, /does not prove/iu, /explicit batch/iu, /enrol/iu, /suppress/iu, /provider/iu, /\bruns?\b/iu, /PP_[A-Z_]+/u, /handoff|hand-off/iu, /\bstep \d/iu])
    assert.doesNotMatch(owned, jargon, String(jargon));
  // Search: one box for both lists, and an honest note when a list is capped.
  const searched = flowPage({ search: "o'brien", contacts: 0 });
  assert.match(searched, /<input type="search" name="q" maxlength="100" value="o&#39;brien">/u);
  assert.match(searched, /No one who has agreed to marketing emails matches “o&#39;brien”\./u); assert.match(searched, />Show everyone<\/a>/u);
  assert.match(flowPage({ contacts: 0 }), /No one has agreed to marketing emails yet\. Record their permission on the lead first\./u);
});

test('button results are one or two plain sentences', () => {
  const result = (over: Partial<Parameters<typeof ppFlowCommandMessage>[0]>) => ppFlowCommandMessage({ action: 'pause', contentItemId: FLOW_ITEM, contentVersionId: FLOW_VERSION,
    changed: 0, remaining: 0, blocked: 0, inFlight: 0, heldForTest: 0, reason: null, replayed: false, ...over });
  assert.equal(result({ changed: 3, blocked: 1, remaining: 1, action: 'resume' }), 'Done: 3 people resumed. 1 couldn’t be changed; see below.');
  assert.equal(result({ changed: 3 }), 'Done: 3 people paused.');
  assert.equal(result({ changed: 1, action: 'stop', inFlight: 1 }), 'Done: 1 person stopped. An email was already going out to 1 person. It may still arrive.');
  assert.equal(result({ changed: 500, remaining: 12, action: 'stop' }), 'Done: 500 people stopped. 12 people still to do. Press the button again.');
  assert.equal(result({ action: 'resume' }), 'No one needed to be resumed.');
  assert.equal(result({ action: 'resume', blocked: 2, remaining: 2, heldForTest: 1 }), 'No one was resumed. 2 couldn’t be changed; see below. 1 person isn’t on your test list and must wait until you switch to live.');
  assert.equal(result({ action: 'enrol', changed: 1 }), 'Done: 1 person started.');
  assert.match(result({ action: 'enrol', changed: 1, heldForTest: 1 }), /^Added, but waiting for you\. Email is in test mode/u);
  assert.equal(result({ action: 'enrol', blocked: 1, reason: 'not_permitted' }), 'Not started. This person hasn’t agreed to marketing emails, has unsubscribed, or their address has changed.');
  assert.match(result({ action: 'enrol', blocked: 1, reason: 'older_version_open' }), /^Not started\. This person is still in an older version/u);
  assert.match(result({ changed: 1, replayed: true }), /You had already done this, so nothing was done twice\.$/u);
  for (const text of [result({ changed: 3, blocked: 1, remaining: 4, inFlight: 2 }), result({ action: 'enrol', blocked: 1, reason: 'already_enrolled' })]) assert.doesNotMatch(text, /\bruns?\b|batch|review|enrol/iu);
});

test('the operator overview never carries a recipient name or address, in the picker or in the progress list', async () => {
  const snapshot = { campaign: PP_FOLLOWUP_CAMPAIGN, readiness: { email: true }, delivery: { mode: 'live', problems: [], search: '', database: { campaign: PP_FOLLOWUP_CAMPAIGN, permitted: 1, contactMatches: 1, runMatches: 1, runCount: 1,
    contacts: [{ contactId: POINT, contactPointId: POINT, displayName: 'Ann Smith', email: 'ann@example.com', inOpenRun: true }], runs: [FLOW_RUN] } } };
  const tools = createFollowupTools({ sessions: { identity: async () => ({ sessionToken: 't', userId: OTHER, workspaceId: PP_FOLLOWUP_WORKSPACE_ID } as PortalSessionIdentity) },
    ppFlows: { snapshot: async () => structuredClone(snapshot) } as never, links: { ppOrigin: ORIGIN, mhpOrigin: 'https://app.martinhowardproperty.co.uk' } });
  const overview = await tools.find(tool => tool.name === 'followups_overview')!.run({ brand: 'pp' }) as { delivery: { database: { permitted: number; contacts?: unknown; runs: Record<string, unknown>[] } } };
  const text = JSON.stringify(overview);
  assert.doesNotMatch(text, /ann@example\.com|Ann Smith|displayName|"email":"/u);
  assert.equal(overview.delivery.database.contacts, undefined); assert.equal(overview.delivery.database.permitted, 1);
  assert.deepEqual(overview.delivery.database.runs.map(run => [run.id, run.state, run.position]), [[OTHER, 'active', 0]], 'progress stays visible');
});
