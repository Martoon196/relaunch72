/**
 * Sending through the stored connection (release 2): which sender a sweep uses, the reservation before every proof
 * (a hold spends no attempt and stops nobody), the footer, and the environment path exactly as before.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalFlowMessage } from '../src/followup-sequences/channel-drafts.js';
import { ppUnsubscribeUrl, renderPpFollowupEmail } from '../src/pp-followup/content.js';
import { createPpPostmarkSender, PpNotSentError } from '../src/pp-followup/mail.js';
import { dispatchPpFollowupEmails } from '../src/pp-followup/dispatch.js';
import { runPpFollowupDelivery } from '../src/pp-followup/delivery.js';
import type { PpMarketingConfig } from '../src/pp-followup/config.js';
import type { PpFollowupPrepared, PpFollowupQueue } from '../src/pp-followup/repository.js';
import { EmailConnectionVault } from '../src/email-connections/vault.js';
import { leaseSendKey, resolveSendingPlan, sendingPlan } from '../src/email-protection/sending.js';
import type { SendingConfig } from '../src/email-protection/store.js';

const PP = 'd975ff66-336a-46c2-b36b-d7095a11af97';
const SECRET = 'synthetic-pp-followup-secret-at-least-32-chars';
const ORIGIN = 'https://hq.propertypredator.com';
const POINT = '2b5d8a3c-4f1e-4c7a-9d2b-1a2b3c4d5e6f';
const vault = new EmailConnectionVault(Buffer.alloc(32, 3));
const TOKEN = 'srv-connection-token-0123456789abcdef';
const canonical = canonicalFlowMessage('email', { schema: 'propertypredator.email-draft/v1', subject: 'Hi {{FIRSTNAME}}', bodyText: 'Hello from {{LABEL}}.' });
const sha = createHash('sha256').update(canonical).digest('hex');

export function sendingConfig(over: Partial<SendingConfig> = {}): SendingConfig {
  return { workspaceId: PP, status: 'verified', mode: 'live', serverId: 5151, stream: 'broadcast', sealedServerToken: vault.seal(PP, 'server_token', TOKEN),
    fromName: 'Property Predator, Leeds', fromAddress: 'hello@mail.pp-send-proof.co.uk', replyTo: 'team@pp-send-proof.co.uk', businessName: 'Property Predator Ltd',
    postalAddress: '1 High Street, Leeds LS1 1AA', testRecipients: ['owner@pp-send-proof.co.uk'], protectionState: 'ok', ownerPaused: false, sampleState: 'passed',
    dailyCap: 50, hourlyCap: 13, accountHeld: false, liveDay: 0, liveHour: 0, goLiveRequestedAt: null, goLiveApprovedAt: '2026-11-01T00:00:00.000Z', lastStep: null,
    protectionReason: null, approvedCurrent: true, testCurrent: true, ...over };
}

test('which sender: the environment ONLY while the connection was never in charge; every other state holds or uses the connection', () => {
  assert.deepEqual(sendingPlan(null, vault), { kind: 'env' }, 'no connection row, or the database ends at 0155');
  const fresh = (over: Partial<SendingConfig> = {}) => sendingConfig({ mode: 'off', goLiveApprovedAt: null, approvedCurrent: false, sampleState: 'none', ...over });
  assert.deepEqual(sendingPlan(fresh(), vault), { kind: 'env' }, 'never in charge: today\'s sender');
  for (const status of ['dns_pending', 'needs_attention', 'disconnected', 'creating', 'not_connected']) assert.deepEqual(sendingPlan(fresh({ status }), vault), { kind: 'env' }, status);
  // Any sign of having been in charge, or any hold, and the environment sender never takes over again by itself.
  for (const [over, reason] of [[{ protectionState: 'paused' }, 'paused'], [{ protectionState: 'off' }, 'off'], [{ ownerPaused: true }, 'not_live'],
    [{ sampleState: 'held' }, 'not_live'], [{ goLiveApprovedAt: 'x' }, 'not_live'], [{ protectionState: 'slowed' }, 'not_live']] as [Partial<SendingConfig>, string][]) {
    assert.deepEqual(sendingPlan(fresh(over), vault), { kind: 'hold', reason, workspaceId: PP }, JSON.stringify(over));
  }
  const live = sendingPlan(sendingConfig(), vault);
  assert.equal(live.kind, 'connection');
  if (live.kind !== 'connection') return;
  assert.deepEqual([live.mode, live.token, live.from, live.fromName, live.replyTo, live.stream, live.testRecipients, live.remaining],
    ['live', TOKEN, 'hello@mail.pp-send-proof.co.uk', 'Property Predator, Leeds', 'team@pp-send-proof.co.uk', 'broadcast', null, 13]);
  assert.deepEqual(live.footer, { businessName: 'Property Predator Ltd', postalAddress: '1 High Street, Leeds LS1 1AA' });
  const tests = sendingPlan(sendingConfig({ mode: 'test', testRecipients: ['A@pp-send-proof.co.uk', 'bad address'] }), vault);
  assert.deepEqual(tests.kind === 'connection' ? [tests.mode, tests.testRecipients, tests.remaining] : null, ['test', ['a@pp-send-proof.co.uk'], 20], 'test mode: only the test list');
  assert.deepEqual(sendingPlan(sendingConfig({ mode: 'test', testRecipients: [] }), vault), { kind: 'hold', reason: 'not_live', workspaceId: PP });
  assert.equal((sendingPlan(sendingConfig({ dailyCap: 50, liveDay: 45, liveHour: 1 }), vault) as { remaining: number }).remaining, 5, 'the smaller allowance');
  const holds: [Partial<SendingConfig>, string][] = [[{ protectionState: 'off' }, 'off'], [{ protectionState: 'paused' }, 'paused'], [{ ownerPaused: true }, 'owner_paused'],
    [{ businessName: null }, 'needs_footer'], [{ postalAddress: null }, 'needs_footer'], [{ accountHeld: true }, 'account_held'], [{ sampleState: 'held' }, 'sample_held'],
    [{ sampleState: 'waiting' }, 'sample_wait'], [{ liveDay: 50 }, 'cap'], [{ liveHour: 13 }, 'cap'], [{ sealedServerToken: null }, 'unreadable'],
    [{ approvedCurrent: false }, 'not_approved'], [{ testCurrent: false }, 'needs_test'],
    [{ sealedServerToken: new EmailConnectionVault(Buffer.alloc(32, 4)).seal(PP, 'server_token', TOKEN) }, 'unreadable'], [{ fromAddress: 'not an address' }, 'unreadable']];
  for (const [over, reason] of holds) assert.deepEqual(sendingPlan(sendingConfig(over), vault), { kind: 'hold', reason, workspaceId: PP }, reason);
  assert.deepEqual(sendingPlan(sendingConfig(), null), { kind: 'hold', reason: 'unreadable', workspaceId: PP }, 'no key: held, never sent unsealed or from the environment');
  // The deployment's own switches (EMAIL_CONNECT off, or bounce handling off) hold a connection in charge.
  assert.deepEqual(sendingPlan(sendingConfig(), vault, { allowed: false }), { kind: 'hold', reason: 'switched_off_here', workspaceId: PP });
  assert.deepEqual(sendingPlan(fresh(), vault, { allowed: false }), { kind: 'env' }, 'never in charge: still the environment sender');
  // Test mode still goes to the business's own list while paused by protection, but not while switched off.
  assert.equal(sendingPlan(sendingConfig({ mode: 'test', protectionState: 'paused' }), vault).kind, 'connection');
  assert.equal(sendingPlan(sendingConfig({ mode: 'test', protectionState: 'off' }), vault).kind, 'hold');
});

test('the reviewer\'s full state table: 6 statuses x 3 modes x every hold, never the environment once in charge, never the connection unless connected', () => {
  const statuses = ['verified', 'dns_pending', 'needs_attention', 'disconnected', 'creating', 'not_connected'];
  const variants: Partial<SendingConfig>[] = [{}, { protectionState: 'slowed' }, { protectionState: 'paused' }, { protectionState: 'off' }, { ownerPaused: true }, { accountHeld: true },
    { sampleState: 'held' }, { sampleState: 'waiting' }, { liveDay: 50 }, { businessName: null }, { sealedServerToken: null }, { approvedCurrent: false }];
  let rows = 0;
  for (const approved of [true, false]) for (const status of statuses) for (const mode of ['off', 'test', 'live'] as const) for (const variant of variants) {
    const config = sendingConfig({ status, mode, goLiveApprovedAt: approved ? 'x' : null, approvedCurrent: approved, sampleState: approved ? 'passed' : 'none', ...variant });
    const plan = sendingPlan(config, vault);
    const neverInCharge = mode === 'off' && !approved && (config.protectionState === 'ok') && !config.ownerPaused && config.sampleState === 'none';
    rows++;
    if (neverInCharge) { assert.equal(plan.kind, 'env', `${status} ${mode} ${JSON.stringify(variant)}`); continue; }
    assert.notEqual(plan.kind, 'env', `once in charge never env: ${status} ${mode} ${approved} ${JSON.stringify(variant)}`);
    if (status !== 'verified') assert.deepEqual(plan, { kind: 'hold', reason: config.protectionState === 'off' ? 'off' : 'not_connected', workspaceId: PP }, `${status} ${mode}`);
    if (plan.kind === 'connection') {
      assert.equal(status, 'verified');
      assert.notEqual(config.protectionState, 'off');
      assert.equal(config.ownerPaused, false);
      if (plan.mode === 'live') assert.ok(!config.accountHeld && config.protectionState !== 'paused' && config.sampleState !== 'held' && config.sampleState !== 'waiting' && config.approvedCurrent);
    }
  }
  assert.equal(rows, 2 * 6 * 3 * 12);
  // The two probed failures: a held sample then Disconnect; a test-mode connection dropping to dns_pending.
  assert.deepEqual(sendingPlan(sendingConfig({ sampleState: 'held', status: 'disconnected' }), vault), { kind: 'hold', reason: 'not_connected', workspaceId: PP });
  assert.deepEqual(sendingPlan(sendingConfig({ mode: 'test', status: 'dns_pending' }), vault), { kind: 'hold', reason: 'not_connected', workspaceId: PP });
});

test('the plan is read fresh every sweep; at 0155 it is the environment; a database fault holds', async () => {
  assert.deepEqual(await resolveSendingPlan({ sendingConfig: async () => null }, vault, PP), { kind: 'env' });
  assert.deepEqual(await resolveSendingPlan({ sendingConfig: async () => { throw new Error('down'); } }, vault, PP), { kind: 'hold', reason: 'unavailable', workspaceId: PP });
  assert.equal(leaseSendKey('L', 'S'), 'lease:S:L');
});

test('the footer: the business\'s real name and postal address above the unsubscribe link; without it the bytes are exactly as before', () => {
  const unsubscribe = ppUnsubscribeUrl(ORIGIN, SECRET, POINT);
  const base = { canonicalContent: canonical, contentSha256: sha, displayName: 'Ann', label: 'Property Predator', link: 'https://propertypredator.com/', unsubscribe,
    productName: 'Property Predator', unsubscribeOrigin: ORIGIN };
  const plain = renderPpFollowupEmail(base);
  assert.equal(plain.text, `Hello from Property Predator.\n\nUnsubscribe: ${unsubscribe}`);
  assert.match(plain.html, /<\/div><p style="margin-top:32px;font-size:12px"><a href=/u);
  const footed = renderPpFollowupEmail({ ...base, footer: { businessName: 'Smith & <Co>', postalAddress: '1 High St\r\nLeeds' } });
  assert.equal(footed.text, `Hello from Property Predator.\n\nSmith & <Co> · 1 High St Leeds\nUnsubscribe: ${unsubscribe}`);
  assert.match(footed.html, /<p style="margin-top:32px;font-size:12px">Smith &amp; &lt;Co&gt; · 1 High St Leeds<\/p><p style="margin-top:8px;font-size:12px"><a href=/u);
});

const LEASE = { id: '4d7fa05e-6b3a-4e9c-9f4d-3c4d5e6f7081', leaseId: '5e80b16f-7c4b-4fad-a05e-4d5e6f708192', leaseUntil: new Date(Date.now() + 120_000).toISOString(), email: 'ann@pp-send-proof.co.uk' };
const LEASE2 = { ...LEASE, id: '4d7fa05e-6b3a-4e9c-9f4d-3c4d5e6f7082', email: 'bob@pp-send-proof.co.uk' };
const prepared = (lease: typeof LEASE): PpFollowupPrepared => ({ ...lease, proofId: '6f91c270-8d5c-4abe-b16f-5e6f708192a3', runId: '70a2d381-9e6d-4bcf-827a-6f708192a3b4', step: 0,
  contactPointId: POINT, displayName: 'Ann Smith', contentVersionId: '81b3e492-af7e-4cd0-9381-708192a3b4c5', canonicalContent: canonical, contentSha256: sha });
function queue(leases = [LEASE, LEASE2]) {
  const calls: string[] = []; const claims: { limit: number; emails: readonly string[] | null }[] = [];
  const q: PpFollowupQueue = {
    claim: async (limit, _s, emails) => { claims.push({ limit, emails }); calls.push('claim'); return leases.slice(0, limit); },
    prepare: async lease => { calls.push(`prepare:${lease.email}`); return prepared(leases.find(l => l.id === lease.id)!); },
    settle: async (lease, outcome, reference) => { calls.push(`settle:${lease.email}:${outcome}:${reference}`); },
    unknown: async lease => { calls.push(`unknown:${lease.email}`); },
  };
  return { q, calls, claims };
}
const dispatchConfig = { testRecipients: null, link: 'https://propertypredator.com/', unsubscribeOrigin: ORIGIN, fromName: 'Property Predator' };

test('reserved before the proof: a hold hands the lease back with no attempt spent, stops the sweep and stops nobody', async () => {
  const { q, calls } = queue();
  const reserved: string[] = [], settled: string[] = [], holds: string[] = [];
  let answer = 'ok';
  const sender = { sendRendered: async () => 'pm-1' };
  const allowance = (limit: number) => ({ limit, reserve: async (lease: typeof LEASE) => { reserved.push(lease.email); const now = answer; answer = 'daily_cap'; return now; },
    settle: async (lease: typeof LEASE, accepted: boolean) => { settled.push(`${lease.email}:${accepted}`); }, onHold: (reason: string) => holds.push(reason) });
  const result = await dispatchPpFollowupEmails({ queue: q, sender, unsubscribeSecret: SECRET, config: dispatchConfig, allowance: allowance(10) });
  assert.deepEqual(result, { sent: 1, failed: 0, unknown: 0 }, 'a hold is not counted as "not sent"');
  assert.deepEqual(calls, ['claim', 'prepare:ann@pp-send-proof.co.uk', 'settle:ann@pp-send-proof.co.uk:accepted:pm-1', 'settle:bob@pp-send-proof.co.uk:deferred:null']);
  assert.ok(!calls.includes('prepare:bob@pp-send-proof.co.uk'), 'no proof, so no attempt is spent for the held one');
  assert.ok(!calls.some(call => call.includes('undeliverable')), 'nobody is stopped');
  assert.deepEqual([reserved, settled, holds], [['ann@pp-send-proof.co.uk', 'bob@pp-send-proof.co.uk'], ['ann@pp-send-proof.co.uk:true'], ['daily_cap']]);
  // A limit claims no more than it may send; a limit of 0 claims nothing at all.
  const small = queue();
  await dispatchPpFollowupEmails({ queue: small.q, sender, unsubscribeSecret: SECRET, config: dispatchConfig, allowance: { limit: 1, reserve: async () => 'ok', settle: async () => undefined } });
  assert.deepEqual(small.claims.map(c => c.limit), [1]);
  const none = queue();
  assert.deepEqual(await dispatchPpFollowupEmails({ queue: none.q, sender, unsubscribeSecret: SECRET, config: dispatchConfig, allowance: { limit: 0, reserve: async () => 'ok', settle: async () => undefined } }),
    { sent: 0, failed: 0, unknown: 0 });
  assert.deepEqual(none.calls, []);
  // The reservation could not be made (database fault): nothing is settled, the lease runs out, nothing is spent.
  const broken = queue();
  await dispatchPpFollowupEmails({ queue: broken.q, sender, unsubscribeSecret: SECRET, config: dispatchConfig, allowance: { limit: 5, reserve: async () => { throw new Error('down'); }, settle: async () => undefined } });
  assert.deepEqual(broken.calls, ['claim']);
});

test('after the proof: a definite refusal releases the reservation; an unknown outcome keeps it counted', async () => {
  for (const [error, outcome, release] of [[new PpNotSentError('message'), 'rejected', 'false'], [new PpNotSentError('recipient'), 'undeliverable', 'false'], [new Error('timeout'), 'unknown', null]] as const) {
    const { q, calls } = queue([LEASE]); const settled: string[] = [];
    await dispatchPpFollowupEmails({ queue: q, sender: { sendRendered: async () => { throw error; } }, unsubscribeSecret: SECRET, config: dispatchConfig,
      allowance: { limit: 5, reserve: async () => 'ok', settle: async (_l, accepted) => { settled.push(String(accepted)); } } });
    assert.deepEqual(settled, release ? [release] : [], outcome);
    assert.ok(calls.some(call => call.includes(outcome)), outcome);
  }
});

test('the environment path is exactly as before: no reservation, no footer, the same request', async () => {
  const envConfig: PpMarketingConfig = { mode: 'live', token: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', from: 'hello@propertypredator.com', fromName: 'Property Predator',
    replyTo: 'office@propertypredator.com', stream: 'broadcast', testRecipients: null, link: 'https://propertypredator.com/', unsubscribeOrigin: ORIGIN };
  const bodies: string[] = [];
  const fetcher = (async (_url: string, init: RequestInit) => { bodies.push(String(init.body)); return new Response(JSON.stringify({ ErrorCode: 0, MessageID: 'pm-env' }), { status: 200 }); }) as unknown as typeof fetch;
  const sender = createPpPostmarkSender(envConfig, fetcher);
  const direct = queue([LEASE]);
  await dispatchPpFollowupEmails({ queue: direct.q, sender, unsubscribeSecret: SECRET, config: envConfig });
  const viaDelivery = queue([LEASE]);
  let planned = 0;
  const outcome = await runPpFollowupDelivery({ queue: viaDelivery.q, unsubscribeSecret: SECRET, env: { sender, config: envConfig },
    connection: { plan: async () => { planned++; return { kind: 'env' }; }, store: { reserve: async () => { throw new Error('never'); }, settle: async () => { throw new Error('never'); } },
      link: 'https://propertypredator.com/', unsubscribeOrigin: ORIGIN } });
  assert.deepEqual([outcome.sender, outcome.sent, planned], ['env', 1, 1]);
  assert.deepEqual(viaDelivery.calls, direct.calls);
  assert.equal(bodies[0], bodies[1], 'byte for byte the same Postmark request');
  assert.match(bodies[0]!, /"From":"Property Predator <hello@propertypredator\.com>"/u);
  // No environment sender and no connection in charge: nothing at all.
  const nothing = queue([LEASE]);
  assert.equal((await runPpFollowupDelivery({ queue: nothing.q, unsubscribeSecret: SECRET, connection: { plan: async () => ({ kind: 'env' }), store: { reserve: async () => 'ok', settle: async () => undefined },
    link: 'https://propertypredator.com/', unsubscribeOrigin: ORIGIN } })).sender, 'none');
  assert.deepEqual(nothing.calls, []);
});

test('the connection path: the business\'s own token, quoted sender name, reply-to, stream and footer; each send reserved under a key with no address', async () => {
  const requests: { headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const fetcher = (async (_url: string, init: RequestInit) => { requests.push({ headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ ErrorCode: 0, MessageID: 'pm-conn' }), { status: 200 }); }) as unknown as typeof fetch;
  const keys: string[] = [], settled: string[] = [], after: string[] = [];
  const store = { reserve: async (ws: string, key: string, purpose: 'live' | 'test') => { keys.push(`${ws}:${key}:${purpose}`); return 'ok' as const; },
    settle: async (_ws: string, key: string, accepted: boolean) => { settled.push(`${key}:${accepted}`); } };
  const plan = sendingPlan(sendingConfig(), vault);
  const { q, calls } = queue([LEASE]);
  const result = await runPpFollowupDelivery({ queue: q, unsubscribeSecret: SECRET, connection: { plan: async () => plan, store, fetcher, link: 'https://propertypredator.com/',
    unsubscribeOrigin: ORIGIN, afterSend: ws => after.push(ws) } });
  assert.deepEqual([result.sender, result.sent], ['connection', 1]);
  const request = requests[0]!;
  assert.equal(request.headers['X-Postmark-Server-Token'], TOKEN);
  assert.deepEqual([request.body.From, request.body.ReplyTo, request.body.MessageStream], ['"Property Predator, Leeds" <hello@mail.pp-send-proof.co.uk>', 'team@pp-send-proof.co.uk', 'broadcast']);
  assert.match(String(request.body.TextBody), /Property Predator Ltd · 1 High Street, Leeds LS1 1AA\nUnsubscribe: https:\/\/hq\.propertypredator\.com\/email\/follow-up\/unsubscribe\?p=/u);
  assert.match(String((request.body.Headers as { Value: string }[])[0]!.Value), /^<https:\/\/hq\.propertypredator\.com\/email\/follow-up\/unsubscribe\?p=/u);
  assert.deepEqual(keys, [`${PP}:lease:${LEASE.id}:${LEASE.leaseId}:live`]);
  assert.ok(keys.every(key => !key.includes('@')));
  assert.deepEqual(settled, [`lease:${LEASE.id}:${LEASE.leaseId}:true`]);
  assert.deepEqual(after, [PP], 'the evaluator is told (the sample may now be full)');
  assert.deepEqual(calls, ['claim', `prepare:${LEASE.email}`, `settle:${LEASE.email}:accepted:pm-conn`]);
  // Test mode: the claim asks only for the test list, and reservations are 'test'.
  const testPlan = sendingPlan(sendingConfig({ mode: 'test', testRecipients: ['ann@pp-send-proof.co.uk'] }), vault);
  const tq = queue([LEASE]); keys.length = 0;
  await runPpFollowupDelivery({ queue: tq.q, unsubscribeSecret: SECRET, connection: { plan: async () => testPlan, store, fetcher, link: 'https://propertypredator.com/', unsubscribeOrigin: ORIGIN } });
  assert.deepEqual(tq.claims[0]!.emails, ['ann@pp-send-proof.co.uk']);
  assert.ok(keys[0]!.endsWith(':test'));
  // A hold claims nothing: no attempt can be spent and nobody can be stopped.
  const hq = queue([LEASE]);
  const held = await runPpFollowupDelivery({ queue: hq.q, unsubscribeSecret: SECRET, env: { sender: { sendRendered: async () => { throw new Error('never'); } }, config: { ...dispatchConfig, mode: 'live', token: 'x', from: 'a@b.co', replyTo: 'a@b.co', stream: 'broadcast' } },
    connection: { plan: async () => ({ kind: 'hold', reason: 'paused', workspaceId: PP }), store, link: 'https://propertypredator.com/', unsubscribeOrigin: ORIGIN } });
  assert.deepEqual([held.sender, held.hold, hq.calls], ['hold', 'paused', []], 'a paused connection never falls back to the environment sender');
});

test('the follow-ups page: the stored connection in charge replaces the environment\'s mode and test list and shows its banner; otherwise nothing changes', async () => {
  const { PortalFollowupFlowService } = await import('../src/portal/followup-flow-service.js');
  const { renderPortalFlowPage } = await import('../src/portal/followup-flow-view.js');
  const stub = {} as never;
  const base = { context: stub, reader: stub, adapter: stub, approvals: stub, transactions: stub, local: stub, messages: stub };
  const lists: unknown[] = [];
  const repository = { snapshot: async () => { throw new Error('unused'); }, command: async (_i: unknown, input: { action: string; testRecipients?: readonly string[] | null }) => { lists.push(input.testRecipients);
    return { action: input.action, contentItemId: POINT, contentVersionId: POINT, changed: 1, remaining: 0, blocked: 0, inFlight: 0, heldForTest: 0, reason: null, replayed: false } as never; } };
  let now: Awaited<ReturnType<NonNullable<import('../src/portal/followup-flow-service.js').PortalFlowDelivery['current']>>> = null;
  const service = new PortalFollowupFlowService({ ...base, delivery: { repository, status: { mode: 'off', ready: false, problems: [] }, current: async () => now } });
  const detail = { valid: true, blockers: [] as string[], review: { isLatest: true, approvalStatus: 'approved', approvalStale: false } };
  Object.defineProperty(service, 'review', { value: async () => { await (service as unknown as { refreshDelivery(): Promise<void> }).refreshDelivery(); return detail; } });
  const identity = { sessionToken: 't', userId: POINT, workspaceId: PP } as never;
  const input = { action: 'enrol' as const, commandId: '92c4f5a3-b08f-4de1-a4a2-8192a3b4c5d6', itemId: POINT, versionId: POINT, contactPointId: LEASE.id, runId: '', ackProofId: '' };
  await assert.rejects(service.command(identity, 'r', input), /isn’t set up yet/u, 'not in charge: the environment (off) decides, exactly as before');
  now = { status: { mode: 'test', ready: true, problems: [] }, testRecipients: ['owner@pp-send-proof.co.uk'], banner: null };
  await service.command(identity, 'r', input);
  now = { status: { mode: 'live', ready: true, problems: [] }, testRecipients: null, banner: { tone: 'alert', title: 'Your marketing emails are paused', text: 'In the last 7 days, 6 of your 120 emails bounced (5%). Our limit is 4%.' } };
  await service.command(identity, 'r', input);
  assert.deepEqual(lists, [['owner@pp-send-proof.co.uk'], null]);
  const html = renderPortalFlowPage({ snapshot: { brand: { productName: 'Property Predator' }, catalog: { items: [] }, messageChoices: [], readiness: service.readiness, executable: true,
    delivery: { mode: 'live', problems: [], search: '', database: null, banner: now.banner } }, csrf: 'c', commandId: 'x' } as never);
  assert.match(html, /<section class="card notice" role="alert"><h2>Your marketing emails are paused<\/h2><p>In the last 7 days, 6 of your 120 emails bounced \(5%\)\. Our limit is 4%\.<\/p><p><a href="\/portal\/email">Open your email page<\/a><\/p><\/section>/u);
});

test('while held, the retry windows of held people are restarted every sweep (a hold, or a refused reservation); a replayed reservation is the same one', async () => {
  let waited = 0;
  const store = { reserve: async () => 'replayed' as const, settle: async () => undefined, holdWait: async () => { waited++; return 0; } };
  const hold = queue([LEASE]);
  const held = await runPpFollowupDelivery({ queue: hold.q, unsubscribeSecret: SECRET, connection: { plan: async () => ({ kind: 'hold', reason: 'sample_wait', workspaceId: PP }), store,
    link: 'https://propertypredator.com/', unsubscribeOrigin: ORIGIN } });
  assert.deepEqual([held.sender, held.hold, waited, hold.calls], ['hold', 'sample_wait', 1, []]);
  const fetcher = (async () => new Response(JSON.stringify({ ErrorCode: 0, MessageID: 'pm-r' }), { status: 200 })) as unknown as typeof fetch;
  const plan = sendingPlan(sendingConfig(), vault);
  const replay = queue([LEASE]);
  const sent = await runPpFollowupDelivery({ queue: replay.q, unsubscribeSecret: SECRET, connection: { plan: async () => plan, store, fetcher, link: 'https://propertypredator.com/', unsubscribeOrigin: ORIGIN } });
  assert.deepEqual([sent.sent, waited], [1, 1], 'replayed counts as reserved; nothing held, no wait');
  const capped = queue([LEASE, LEASE2]);
  let n = 0;
  const capStore = { ...store, reserve: async () => (n++ === 0 ? 'ok' as const : 'daily_cap' as const) };
  const result = await runPpFollowupDelivery({ queue: capped.q, unsubscribeSecret: SECRET, connection: { plan: async () => plan, store: capStore, fetcher, link: 'https://propertypredator.com/', unsubscribeOrigin: ORIGIN } });
  assert.deepEqual([result.sent, result.failed, result.hold, waited], [1, 0, 'daily_cap', 2], 'a refused reservation: the rest wait, and their windows are restarted');
});

test('the follow-ups page never says "Email sending is on." while held', async () => {
  const { renderPortalFlowPage } = await import('../src/portal/followup-flow-view.js');
  const page = (held: boolean) => renderPortalFlowPage({ snapshot: { brand: { productName: 'Property Predator' }, catalog: { items: [] }, messageChoices: [],
    readiness: { email: true, sms: false, whatsapp: false, reply: false, booked: false, purchased: false }, executable: true,
    delivery: { mode: 'live', problems: [], search: '', database: null, held, banner: null } }, csrf: 'c', commandId: 'x' } as never);
  assert.match(page(true), /Email sending is on hold right now: people you start wait until it goes again\./u);
  assert.doesNotMatch(page(true), /Email sending is on\./u);
  assert.match(page(false), /Email sending is on\. Publish a flow/u);
});
