/**
 * The durable email block ledger (0153) in front of the in-process list, without a database: the ledger's SQL is
 * proved in test/db/email-block-ledger.integration.test.ts. Here: the fallback while the database still ends at 0152,
 * how the guard combines the two answers, and what the webhook and the sweep write. No network, no real addresses.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  createPostmarkBounceWebhook, decideRecipient, EmailBlockRegistry, EmailBounceService, ledgerEventId, PgEmailBlockLedger,
  type EmailBlockLedger, type EmailBounceSource, type LedgerDecision, type LedgerRow, type PostmarkBounceApi,
} from '../src/email-bounces/index.js';
import { ppEmailBounceEffects } from '../src/pp-followup/bounces.js';
import { PgPpFollowupRepository } from '../src/pp-followup/repository.js';

const MHP = '2789228d-55a6-4688-b1e8-2f70abca990b', PP = 'd975ff66-336a-46c2-b36b-d7095a11af97', OTHER = '0b151000-0000-4000-8000-000000000002';
const NOW = Date.parse('2026-11-12T10:00:00Z'), DAY = 86_400_000;
const SECRET = 'mhp-webhook-secret-synthetic-0123456789';
const POINT = '2b5d8a3c-4f1e-4c7a-9d2b-1a2b3c4d5e6f';
const source: EmailBounceSource = { key: 'mhp', workspaceId: MHP, token: 'synthetic-token', webhookSecret: SECRET, serverId: null,
  streams: new Map([['broadcast', 'marketing'], ['outbound', 'service']]) };
const absent = Object.assign(new Error('function app_private.email_block_decide(uuid, text, text) does not exist'), { code: '42883' });

/** A pool that answers like a database still ending at 0152: every ledger function is missing. */
function pool0152() {
  const sql: string[] = [];
  return { sql, pool: { query: async (text: string) => { sql.push(text); throw absent; } } as never };
}

/** An in-memory stand-in for the ledger with the same rules as the SQL (scope, sign-up since, lift). */
class FakeLedger implements EmailBlockLedger {
  rows_: { workspaceId: string; sourceKey: string; email: string; reason: 'hard_bounce' | 'spam_complaint' | 'unsubscribed'; at: number; eventId: string | null; lifted: boolean }[] = [];
  signedUp = new Map<string, number>();
  writes: string[] = [];
  fail = false;
  covers(workspaceId: string) { return workspaceId === MHP || workspaceId === PP; }
  async decide(workspaceId: string, email: string, purpose: 'marketing' | 'service'): Promise<LedgerDecision | null> {
    if (!this.covers(workspaceId)) return null;
    const live = this.rows_.filter(r => r.workspaceId === workspaceId && r.email === email && !r.lifted);
    const all = live.find(r => r.reason !== 'unsubscribed');
    if (all) return { blocked: true, reason: all.reason, reallowed: false };
    let reallowed = false;
    if (purpose === 'marketing') for (const row of live) {
      if (!((this.signedUp.get(email) ?? 0) > row.at)) return { blocked: true, reason: 'unsubscribed', reallowed: false };
      reallowed = true;
    }
    return { blocked: false, reallowed };
  }
  async record(input: { workspaceId: string; sourceKey: string; email: string; reason: 'hard_bounce' | 'spam_complaint' | 'unsubscribed'; eventId: string | null; stream: string | null; at: number }) {
    if (this.fail) throw new Error('database unavailable');
    this.writes.push(`record ${input.reason} ${input.eventId}`);
    if (this.rows_.some(r => r.workspaceId === input.workspaceId && r.sourceKey === input.sourceKey && r.email === input.email && r.reason === input.reason)) return 'exists' as const;
    this.rows_.push({ ...input, lifted: false }); return 'recorded' as const;
  }
  async recordList(input: { workspaceId: string; sourceKey: string; stream: string; rows: readonly { email: string; reason: 'hard_bounce' | 'spam_complaint' | 'unsubscribed'; at: number }[] }) {
    if (this.fail) throw new Error('database unavailable');
    this.writes.push(`list ${input.stream} ${input.rows.length}`);
    let added = 0;
    for (const row of input.rows) if ((await this.record({ ...input, ...row, eventId: null, stream: input.stream })) === 'recorded') added++;
    return added;
  }
  async lift(input: { workspaceId: string; sourceKey: string; email: string; eventId: string | null; at: number }) {
    if (this.fail) throw new Error('database unavailable');
    this.writes.push(`lift ${input.eventId?.slice(0, 13)}`);
    let n = 0;
    for (const row of this.rows_) if (row.workspaceId === input.workspaceId && row.sourceKey === input.sourceKey && row.email === input.email && row.reason === 'unsubscribed' && !row.lifted) { row.lifted = true; n++; }
    return n;
  }
  async rows(workspaceId: string): Promise<readonly LedgerRow[]> {
    return this.rows_.filter(r => r.workspaceId === workspaceId && !r.lifted).map(r => ({ email: r.email, reason: r.reason, scope: r.reason === 'unsubscribed' ? 'marketing' as const : 'all' as const,
      sourceKey: r.sourceKey, stream: 'broadcast', since: r.at, reallowed: r.reason === 'unsubscribed' && (this.signedUp.get(r.email) ?? 0) > r.at }));
  }
}

function webhookFixture(ledger: EmailBlockLedger | null) {
  const service = new EmailBounceService({ config: { sources: [{ ...source, token: null }], blockers: [] }, now: () => NOW, ledger });
  const effects: string[] = [];
  service.setEffects(MHP, { onMarketingBlock: async ({ reason }) => { effects.push(reason); } });
  const webhook = createPostmarkBounceWebhook({ service, now: () => NOW });
  const post = async (body: unknown) => {
    const captured = { status: 0, body: {} as Record<string, unknown> };
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: 'POST', url: '/api/provider-webhooks/postmark/mhp',
      headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`mhp:${SECRET}`).toString('base64')}` }, socket: { remoteAddress: '10.0.0.1' } }) as unknown as IncomingMessage;
    const res = { headersSent: false, writeHead(status: number) { captured.status = status; }, end(text = '') { captured.body = text ? JSON.parse(text) : {}; } } as unknown as ServerResponse;
    await webhook.handle(req, res, new URL(req.url!, 'https://app.example.test'));
    return captured;
  };
  return { service, effects, post };
}
const bounce = (over: Record<string, unknown> = {}) => ({ RecordType: 'Bounce', MessageStream: 'broadcast', ID: 42, Type: 'HardBounce', TypeCode: 1, Email: 'gone@example.invalid',
  BouncedAt: '2026-11-12T09:55:00Z', Inactive: true, ServerID: 23, Metadata: { send: 'send-1' }, ...over });
const subscription = (suppress: boolean, at: string, reason = 'ManualSuppression') => ({ RecordType: 'SubscriptionChange', MessageStream: 'broadcast', Recipient: 'left@example.invalid',
  ChangedAt: at, SuppressSending: suppress, ...(suppress ? { SuppressionReason: reason } : {}), ServerID: 23 });

test('database still at 0152: every ledger call is "unavailable", the guard answers exactly as the in-process list, and the ledger looks again later', async () => {
  let now = NOW;
  const { pool, sql } = pool0152();
  const logs: string[] = [];
  const ledger = new PgEmailBlockLedger(pool, { now: () => now, log: line => logs.push(line) });
  assert.equal(await ledger.decide(MHP, 'gone@example.invalid', 'marketing'), null);
  assert.equal(sql.length, 1);
  assert.equal(await ledger.record({ workspaceId: MHP, sourceKey: 'mhp', email: 'gone@example.invalid', reason: 'hard_bounce', eventId: 'bounce:1', stream: 'broadcast', at: NOW }), 'unavailable');
  assert.equal(await ledger.recordList({ workspaceId: MHP, sourceKey: 'mhp', stream: 'broadcast', rows: [{ email: 'gone@example.invalid', reason: 'hard_bounce', at: NOW }] }), null);
  assert.equal(await ledger.lift({ workspaceId: MHP, sourceKey: 'mhp', email: 'left@example.invalid', eventId: null, at: NOW }), null);
  assert.equal(await ledger.rows(MHP), null);
  assert.equal(sql.length, 1, 'after the first "function does not exist" nothing else is sent to the database for a while');
  assert.equal(logs.length, 1); assert.doesNotMatch(logs[0]!, /@/u, 'no address is ever logged');
  now += 5 * 60_000;
  assert.equal(await ledger.decide(MHP, 'gone@example.invalid', 'marketing'), null);
  assert.equal(sql.length, 2, 'it looks again after five minutes, so applying 0153 needs no restart');
  // Another brand is never sent to the ledger at all.
  assert.equal(await ledger.decide(OTHER, 'gone@example.invalid', 'marketing'), null); assert.equal(sql.length, 2);

  // The guard's answers equal the in-process list's for every reason and purpose, as before 0153.
  const service = new EmailBounceService({ config: { sources: [source], blockers: [] }, now: () => NOW, ledger: new PgEmailBlockLedger(pool0152().pool, { now: () => now }) });
  const facts = [['gone@example.invalid', 'hard_bounce'], ['cross@example.invalid', 'spam_complaint'], ['left@example.invalid', 'unsubscribed']] as const;
  facts.forEach(([email, kind], i) => service.registry.record(MHP, { sourceKey: 'mhp', stream: 'broadcast', id: `bounce:${i}`, kind, email, at: NOW - DAY }));
  [1, 2, 3].forEach(n => service.registry.record(MHP, { sourceKey: 'mhp', stream: 'broadcast', id: `bounce:s${n}`, kind: 'soft_bounce', email: 'full@example.invalid', at: NOW - n * DAY }));
  for (const email of ['gone@example.invalid', 'cross@example.invalid', 'left@example.invalid', 'full@example.invalid', 'fine@example.invalid']) {
    for (const purpose of ['marketing', 'service'] as const) {
      assert.deepEqual(await decideRecipient(service.guard, MHP, email, purpose), service.registry.decide(MHP, email, purpose), `${email} ${purpose}`);
    }
  }
  // And the webhook behaves as before 0153: the event is applied and acknowledged.
  const f = webhookFixture(new PgEmailBlockLedger(pool0152().pool));
  const answer = await f.post(bounce());
  assert.deepEqual([answer.status, answer.body.outcome, answer.body.blocked], [200, 'hard_bounce', true]);
  assert.deepEqual(f.effects, ['hard_bounce']);
});

test('a database error that is not "missing" never fails a send: the guard falls back; a webhook write asks Postmark to retry', async () => {
  const broken = { query: async () => { throw Object.assign(new Error('connection reset'), { code: '08006' }); } };
  const logs: string[] = [];
  const ledger = new PgEmailBlockLedger(broken, { log: line => logs.push(line) });
  assert.equal(await ledger.decide(PP, 'ann@example.invalid', 'marketing'), null);
  assert.match(logs[0]!, /ledger_read_failed/u); assert.doesNotMatch(logs.join(''), /@/u);
  await assert.rejects(ledger.record({ workspaceId: PP, sourceKey: 'pp', email: 'ann@example.invalid', reason: 'spam_complaint', eventId: 'bounce:9', stream: 'pp-news', at: NOW }));
  const fake = new FakeLedger(); fake.fail = true;
  const f = webhookFixture(fake);
  const answer = await f.post(bounce());
  assert.equal(answer.status, 503, 'Postmark retries; the durable row is written next time');
  assert.deepEqual(f.effects, [], 'the brand effect waits for the durable write');
  fake.fail = false;
  assert.equal((await f.post(bounce())).status, 200, 'the retry is not treated as a replay');
  assert.deepEqual(f.effects, ['hard_bounce']);
});

test('the guard puts the in-process list in front of the ledger: a restart forgets nothing, and a sign-up since re-allows marketing after an unsubscribe only', async () => {
  const ledger = new FakeLedger();
  ledger.rows_.push({ workspaceId: MHP, sourceKey: 'mhp', email: 'gone@example.invalid', reason: 'hard_bounce', at: NOW - 40 * DAY, eventId: 'bounce:1', lifted: false },
    { workspaceId: MHP, sourceKey: 'mhp', email: 'cross@example.invalid', reason: 'spam_complaint', at: NOW - 40 * DAY, eventId: 'bounce:2', lifted: false },
    { workspaceId: MHP, sourceKey: 'mhp', email: 'left@example.invalid', reason: 'unsubscribed', at: NOW - 40 * DAY, eventId: null, lifted: false },
    { workspaceId: MHP, sourceKey: 'mhp', email: 'back@example.invalid', reason: 'unsubscribed', at: NOW - 40 * DAY, eventId: null, lifted: false });
  ledger.signedUp.set('back@example.invalid', NOW - DAY);
  // A fresh process: nothing in memory.
  const service = new EmailBounceService({ config: { sources: [source], blockers: [] }, now: () => NOW, ledger });
  const guard = service.guard;
  assert.deepEqual(await decideRecipient(guard, MHP, 'GONE@example.invalid ', 'service'), { blocked: true, reason: 'hard_bounce' }, 'a hard bounce stops every email after a restart');
  assert.deepEqual(await decideRecipient(guard, MHP, 'cross@example.invalid', 'service'), { blocked: true, reason: 'spam_complaint' }, 'so does a spam complaint');
  assert.deepEqual(await decideRecipient(guard, MHP, 'left@example.invalid', 'marketing'), { blocked: true, reason: 'unsubscribed' });
  assert.deepEqual(await decideRecipient(guard, MHP, 'left@example.invalid', 'service'), { blocked: false }, 'an unsubscribe leaves requested event email alone');
  // Postmark still lists the unsubscribe, but the person signed up again since: marketing goes again.
  service.registry.reconcile(MHP, { sourceKey: 'mhp', stream: 'broadcast', kind: 'marketing', startedAt: NOW, suppressions: [{ email: 'back@example.invalid', kind: 'unsubscribed', at: NOW - 40 * DAY }],
    bounces: [], sent: null, bounced: null, complaints: null });
  assert.equal(service.registry.decide(MHP, 'back@example.invalid', 'marketing').blocked, true, 'the in-process list alone would still refuse');
  assert.deepEqual(await decideRecipient(guard, MHP, 'back@example.invalid', 'marketing'), { blocked: false });
  // ...but a sign-up never re-allows a hard bounce or a spam complaint, and a temporary soft-bounce block still counts.
  ledger.signedUp.set('gone@example.invalid', NOW); ledger.signedUp.set('cross@example.invalid', NOW);
  assert.equal((await decideRecipient(guard, MHP, 'gone@example.invalid', 'marketing')).blocked, true);
  assert.equal((await decideRecipient(guard, MHP, 'cross@example.invalid', 'marketing')).blocked, true);
  [1, 2, 3].forEach(n => service.registry.record(MHP, { sourceKey: 'mhp', stream: 'broadcast', id: `bounce:s${n}`, kind: 'soft_bounce', email: 'back@example.invalid', at: NOW - n * DAY }));
  assert.deepEqual(await decideRecipient(guard, MHP, 'back@example.invalid', 'marketing'), { blocked: true, reason: 'repeated_soft_bounce' });
  // The strongest reason wins when both know something.
  service.registry.record(MHP, { sourceKey: 'mhp', stream: 'broadcast', id: 'bounce:x', kind: 'unsubscribed', email: 'gone@example.invalid', at: NOW });
  assert.deepEqual(await decideRecipient(guard, MHP, 'gone@example.invalid', 'marketing'), { blocked: true, reason: 'hard_bounce' });
  // A workspace the ledger does not keep is answered by the in-process list alone.
  assert.deepEqual(await decideRecipient(guard, OTHER, 'gone@example.invalid', 'marketing'), { blocked: false });
});

test('the webhook writes the true reason durably before the brand effect, replays write nothing new, and only a provider re-subscribe lifts an unsubscribe', async () => {
  const ledger = new FakeLedger();
  const f = webhookFixture(ledger);
  assert.equal((await f.post(bounce())).status, 200);
  assert.equal((await f.post(bounce({ ID: 43, RecordType: 'SpamComplaint', Type: 'SpamComplaint', Email: 'cross@example.invalid' }))).status, 200);
  assert.equal((await f.post(subscription(true, '2026-11-12T09:00:00Z'))).status, 200);
  assert.equal((await f.post(bounce())).body.replayed, true);
  assert.deepEqual(ledger.rows_.map(r => [r.email, r.reason]), [['gone@example.invalid', 'hard_bounce'], ['cross@example.invalid', 'spam_complaint'], ['left@example.invalid', 'unsubscribed']]);
  assert.equal(ledger.rows_[0]!.eventId, 'bounce:42');
  assert.match(ledgerEventId(ledger.rows_[2]!.eventId)!, /^subscription:[0-9a-f]{40}$/u, 'a subscription change is stored as a digest, never with the address in it');
  assert.equal((await f.post(bounce({ ID: 50, Type: 'SoftBounce', Inactive: false }))).status, 200);
  assert.equal(ledger.rows_.length, 3, 'a soft bounce is never written to the ledger');
  // A Postmark-side "reactivate" of the hard bounce or the complaint is a subscription change too: it lifts nothing durable.
  assert.equal((await f.post({ ...subscription(false, '2026-11-12T09:30:00Z'), Recipient: 'gone@example.invalid' })).status, 200);
  assert.equal((await f.post(subscription(false, '2026-11-12T09:40:00Z'))).status, 200);
  assert.deepEqual(ledger.rows_.map(r => r.lifted), [false, false, true]);
  assert.deepEqual(await decideRecipient(f.service.guard, MHP, 'gone@example.invalid', 'service'), { blocked: true, reason: 'hard_bounce' });
  assert.deepEqual(await decideRecipient(f.service.guard, MHP, 'left@example.invalid', 'marketing'), { blocked: false });
  assert.equal(ledgerEventId(null), null); assert.equal(ledgerEventId('bounce:42'), 'bounce:42'); assert.equal(ledgerEventId('bad id with spaces'), null);
});

test('the sweep writes each stream\'s list to the ledger, a failed write never fails the read, and the durable rows are loaded into the cache', async () => {
  const ledger = new FakeLedger();
  const api: PostmarkBounceApi = {
    suppressions: async stream => stream === 'broadcast' ? [{ email: 'gone@example.invalid', kind: 'hard_bounce', at: NOW - 2 * DAY }, { email: 'left@example.invalid', kind: 'unsubscribed', at: null }] : [],
    bounces: async () => ({ total: 0, received: 0, rows: [] }), totals: async () => ({ sent: 10, bounced: 1, complaints: 0 }) };
  const service = new EmailBounceService({ config: { sources: [source], blockers: [] }, now: () => NOW, apiFor: () => api, ledger });
  assert.deepEqual(await service.sweepWorkspace(MHP), { streams: 2, failed: 0, suppressions: 2, bounces: 0 });
  assert.deepEqual(ledger.writes, ['list broadcast 2', 'record hard_bounce null', 'record unsubscribed null', 'list outbound 0']);
  assert.deepEqual(ledger.rows_.map(r => [r.email, r.reason, r.at]), [['gone@example.invalid', 'hard_bounce', NOW - 2 * DAY], ['left@example.invalid', 'unsubscribed', NOW]],
    'a listed row with no time is recorded at the read time');
  ledger.fail = true;
  assert.deepEqual(await new EmailBounceService({ config: { sources: [source], blockers: [] }, now: () => NOW, apiFor: () => api, ledger }).sweepWorkspace(MHP),
    { streams: 2, failed: 0, suppressions: 2, bounces: 0, ledgerFailed: 2 });
  ledger.fail = false;

  // A durable row Postmark no longer lists (reactivated there) stays in the cache: a list read never removes it.
  ledger.rows_.push({ workspaceId: MHP, sourceKey: 'mhp', email: 'old@example.invalid', reason: 'spam_complaint', at: NOW - 90 * DAY, eventId: 'bounce:7', lifted: false });
  const fresh = new EmailBounceService({ config: { sources: [source], blockers: [] }, now: () => NOW, apiFor: () => api, ledger });
  await fresh.refreshLedger();
  await fresh.sweepWorkspace(MHP);
  assert.deepEqual(fresh.registry.decide(MHP, 'old@example.invalid', 'service'), { blocked: true, reason: 'spam_complaint' });
  assert.deepEqual(fresh.registry.snapshot(MHP).blocked.map(b => [b.email, b.reason, b.allEmail]),
    [['left@example.invalid', 'unsubscribed', false], ['gone@example.invalid', 'hard_bounce', true], ['old@example.invalid', 'spam_complaint', true]]);
  // A provider re-subscribe lifts the cached unsubscribe whatever stream it was cached under; never the durable complaint.
  fresh.registry.release(MHP, 'mhp', 'broadcast', 'left@example.invalid');
  fresh.registry.release(MHP, 'mhp', 'broadcast', 'old@example.invalid');
  assert.equal(fresh.registry.decide(MHP, 'left@example.invalid', 'marketing').blocked, false);
  assert.equal(fresh.registry.decide(MHP, 'old@example.invalid', 'marketing').blocked, true);
  // An unsubscribe re-allowed by a sign-up is not loaded as a block.
  ledger.signedUp.set('left@example.invalid', NOW + 1);
  const reloaded = new EmailBlockRegistry(() => NOW);
  reloaded.hydrate(MHP, (await ledger.rows(MHP)));
  assert.equal(reloaded.decide(MHP, 'left@example.invalid', 'marketing').blocked, false);
  assert.equal(reloaded.decide(MHP, 'gone@example.invalid', 'service').blocked, true);
});

test('Property Predator: a reported bounce, complaint or unsubscribe is recorded with its true reason, and before 0153 the old unsubscribe still runs', async () => {
  const calls: string[] = [];
  const unsubscriber = { unsubscribe: async (point: string) => { calls.push(`unsubscribe ${point}`); return { known: true, recorded: true, stopped: 1 }; },
    blockEmail: async (point: string, reason: string) => { calls.push(`block ${point} ${reason}`); return { known: true, recorded: true, stopped: 1, durable: true }; } };
  const effects = ppEmailBounceEffects(unsubscriber);
  for (const reason of ['hard_bounce', 'spam_complaint', 'unsubscribed'] as const) await effects.onMarketingBlock({ email: 'ann@example.invalid', reason, metadata: { point: POINT } });
  await effects.onMarketingBlock({ email: 'ann@example.invalid', reason: 'hard_bounce', metadata: { send: 'x' } });
  assert.deepEqual(calls, [`block ${POINT} hard_bounce`, `block ${POINT} spam_complaint`, `block ${POINT} unsubscribe`]);
  // An older capability without blockEmail keeps today's behaviour.
  calls.length = 0;
  await ppEmailBounceEffects({ unsubscribe: unsubscriber.unsubscribe }).onMarketingBlock({ email: 'ann@example.invalid', reason: 'hard_bounce', metadata: { point: POINT } });
  assert.deepEqual(calls, [`unsubscribe ${POINT}`]);

  // The repository: on a database still at 0152 the 0153 function is missing, so the 0152 unsubscribe runs instead.
  const sql: string[] = [];
  const commands = { query: async (text: string) => {
    sql.push(/app_private\.(\w+)/u.exec(text)![1]!);
    if (text.includes('pp_followup_block_email')) throw absent;
    return { rows: [{ value: { known: true, recorded: true, stopped: 2 } }] };
  } };
  const repo = new PgPpFollowupRepository({ query: async () => { throw new Error('unused'); } } as never, commands as never);
  assert.deepEqual(await repo.blockEmail(POINT, 'spam_complaint'), { known: true, recorded: true, stopped: 2, durable: false });
  assert.deepEqual(await repo.blockEmail(POINT, 'hard_bounce'), { known: true, recorded: true, stopped: 2, durable: false });
  assert.deepEqual(sql, ['pp_followup_block_email', 'pp_followup_unsubscribe', 'pp_followup_unsubscribe'],
    'after one "missing" answer it does not ask again straight away');
  await assert.rejects(repo.blockEmail('not-a-uuid', 'hard_bounce'));
  const failing = new PgPpFollowupRepository({} as never, { query: async () => { throw Object.assign(new Error('boom'), { code: '08006' }); } } as never);
  await assert.rejects(failing.blockEmail(POINT, 'hard_bounce'), /boom/u, 'any other database error is not swallowed: the webhook asks Postmark to retry');
});
