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
import { PgPpFollowupRepository, type PpFollowupPrepared, type PpFollowupQueue } from '../src/pp-followup/repository.js';
import { EmailGuardUnavailableError, EmailRecipientBlockedError } from '../src/email-bounces/policy.js';
import { createMhpMarketingSender, mhpMarketingConfig } from '../src/mhp/marketing-mail.js';
import { createPpPostmarkSender, PpNotSentError } from '../src/pp-followup/mail.js';
import { dispatchPpFollowupEmails } from '../src/pp-followup/dispatch.js';
import { ppMarketingConfig } from '../src/pp-followup/config.js';

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
  rows_: { workspaceId: string; sourceKey: string; email: string; reason: 'hard_bounce' | 'spam_complaint' | 'unsubscribed'; at: number; eventId: string | null; lifted: boolean; liftedAt?: number }[] = [];
  signedUp = new Map<string, number>();
  writes: string[] = [];
  fail = false;
  failDecide = false;
  covers(workspaceId: string) { return workspaceId === MHP || workspaceId === PP; }
  status() { return 'available' as const; }
  async decide(workspaceId: string, email: string, purpose: 'marketing' | 'service'): Promise<LedgerDecision | null> {
    if (!this.covers(workspaceId)) return null;
    if (this.failDecide) throw new Error('connection reset');
    const mine = this.rows_.filter(r => r.workspaceId === workspaceId && r.email === email);
    let clearedAt: number | null = null;
    for (const r of mine) if (r.lifted && r.liftedAt !== undefined) clearedAt = Math.max(clearedAt ?? -Infinity, r.liftedAt);
    const live = mine.filter(r => !r.lifted);
    const all = live.find(r => r.reason !== 'unsubscribed');
    if (all) return { blocked: true, reason: all.reason, reallowed: false, clearedAt };
    let reallowed = false;
    if (purpose === 'marketing') for (const row of live) {
      if (!((this.signedUp.get(email) ?? 0) > row.at)) return { blocked: true, reason: 'unsubscribed', reallowed: false, clearedAt };
      reallowed = true; clearedAt = Math.max(clearedAt ?? -Infinity, row.at);
    }
    return { blocked: false, reallowed, clearedAt };
  }
  async record(input: { workspaceId: string; sourceKey: string; email: string; reason: 'hard_bounce' | 'spam_complaint' | 'unsubscribed'; eventId: string | null; stream: string | null; at: number }) {
    if (this.fail) throw new Error('database unavailable');
    this.writes.push(`record ${input.reason} ${input.eventId}`);
    const existing = this.rows_.find(r => r.workspaceId === input.workspaceId && r.sourceKey === input.sourceKey && r.email === input.email && r.reason === input.reason);
    if (existing) {
      // Event times, never arrival order: only a newer event re-arms a lifted row.
      if (existing.lifted && existing.liftedAt !== undefined && input.at > existing.liftedAt) { existing.lifted = false; existing.at = input.at; existing.liftedAt = undefined; return 'renewed' as const; }
      return 'exists' as const;
    }
    this.rows_.push({ ...input, lifted: false }); return 'recorded' as const;
  }
  firstSeen = NOW;
  async recordList(input: { workspaceId: string; sourceKey: string; stream: string; rows: readonly { email: string; reason: 'hard_bounce' | 'spam_complaint' | 'unsubscribed'; at: number | null }[] }) {
    if (this.fail) throw new Error('database unavailable');
    this.writes.push(`list ${input.stream} ${input.rows.length}`);
    let added = 0;
    for (const row of input.rows) if ((await this.record({ ...input, ...row, at: row.at ?? this.firstSeen, eventId: null, stream: input.stream })) === 'recorded') added++;
    return { added, skipped: 0 };
  }
  async lift(input: { workspaceId: string; sourceKey: string; email: string; eventId: string | null; at: number }) {
    if (this.fail) throw new Error('database unavailable');
    this.writes.push(`lift ${input.eventId?.slice(0, 13)}`);
    let n = 0, known = false;
    for (const row of this.rows_) if (row.workspaceId === input.workspaceId && row.sourceKey === input.sourceKey && row.email === input.email && row.reason === 'unsubscribed') {
      known = true;
      if (row.at < input.at && (!row.lifted || (row.liftedAt ?? 0) < input.at)) { row.lifted = true; row.liftedAt = input.at; n++; }
    }
    // The re-subscribe overtook a retried older unsubscribe: leave a lifted tombstone at the re-subscribe's own time.
    if (!known) this.rows_.push({ workspaceId: input.workspaceId, sourceKey: input.sourceKey, email: input.email, reason: 'unsubscribed', at: input.at, eventId: null, lifted: true, liftedAt: input.at });
    return n;
  }
  lifts: string[] = [];
  async ownerLift(input: { sessionToken: string; workspaceId: string; email: string; note: string }) {
    this.lifts.push(`${input.workspaceId} ${input.email} ${input.note}`);
    let lifted = 0;
    for (const row of this.rows_) if (row.workspaceId === input.workspaceId && row.email === input.email && row.reason === 'hard_bounce' && !row.lifted) { row.lifted = true; row.liftedAt = NOW - 30 * 60_000; lifted++; }
    return { lifted, released: 0, spamComplaint: this.rows_.some(r => r.workspaceId === input.workspaceId && r.email === input.email && r.reason === 'spam_complaint' && !r.lifted) };
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

test('a database error that is not "missing": the read is reported, never swallowed; a webhook write asks Postmark to retry', async () => {
  const broken = { query: async () => { throw Object.assign(new Error('connection reset'), { code: '08006' }); } };
  const logs: string[] = [];
  const ledger = new PgEmailBlockLedger(broken as never, { log: line => logs.push(line) });
  await assert.rejects(ledger.decide(PP, 'ann@example.invalid', 'marketing'), /connection reset/u);
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
  assert.deepEqual(ledger.rows_.map(r => r.lifted), [false, false, true, true], 'the hard-bounced address re-subscribe left only a lifted unsubscribe marker');
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

// ---- Review fixes (0153 second pass) ----

const mhpConfig = () => mhpMarketingConfig({ MHP_MARKETING_MODE: 'live', MHP_POSTMARK_SERVER_TOKEN: 'synthetic-token', MHP_MARKETING_FROM: 'owner@example.invalid' })!;
const rendered = { subject: 's', text: 't', html: '<p>t</p>', unsubscribe: 'https://app.martinhowardproperty.co.uk/email/unsubscribe?p=x' };

test('Postmark 406 after a re-allow: the guard lets marketing go, Postmark still refuses, and that is a definite non-send (never an unknown that holds a sequence)', async () => {
  const ledger = new FakeLedger();
  ledger.rows_.push({ workspaceId: MHP, sourceKey: 'mhp', email: 'back@example.invalid', reason: 'unsubscribed', at: NOW - 40 * DAY, eventId: null, lifted: false });
  ledger.signedUp.set('back@example.invalid', NOW - DAY);
  const service = new EmailBounceService({ config: { sources: [source], blockers: [] }, now: () => NOW, ledger });
  service.registry.markReady();
  assert.deepEqual(await decideRecipient(service.guard, MHP, 'back@example.invalid', 'marketing'), { blocked: false });
  let calls = 0;
  const fetcher = (async () => { calls++; return new Response(JSON.stringify({ ErrorCode: 406, Message: 'inactive' }), { status: 422 }); }) as unknown as typeof fetch;
  const sender = createMhpMarketingSender(mhpConfig(), 'synthetic-unsubscribe-secret-at-least-32-characters', fetcher, { guard: service.guard, workspaceId: MHP });
  await assert.rejects(sender.sendRendered({ id: 'a', email: 'back@example.invalid', tag: 'owner_sequence', rendered }),
    (error: unknown) => error instanceof EmailRecipientBlockedError && error.reason === 'unsubscribed');
  assert.equal(calls, 1, 'Postmark was asked once and said no');
  // Another 4xx without 406 stays a plain refusal, as before.
  const other = createMhpMarketingSender(mhpConfig(), 'synthetic-unsubscribe-secret-at-least-32-characters',
    (async () => new Response(JSON.stringify({ ErrorCode: 300 }), { status: 422 })) as unknown as typeof fetch);
  await assert.rejects(other.sendRendered({ id: 'a', email: 'x@example.invalid', tag: 't', rendered }), (error: unknown) => !(error instanceof EmailRecipientBlockedError));
});

test('a ledger read error with an empty cache: marketing fails closed as a retryable non-send everywhere; event email falls back to the in-process list', async () => {
  const ledger = new FakeLedger(); ledger.failDecide = true;
  const service = new EmailBounceService({ config: { sources: [source], blockers: [] }, now: () => NOW, ledger });
  service.registry.markReady();
  await assert.rejects(service.guard.check!(MHP, 'anyone@example.invalid', 'marketing'), EmailGuardUnavailableError);
  assert.deepEqual(await service.guard.check!(MHP, 'anyone@example.invalid', 'service'), { blocked: false }, 'event email: in-process list (empty) decides');
  // MHP: refused before any provider call, never stops the person.
  let calls = 0;
  const fetcher = (async () => { calls++; return new Response(JSON.stringify({ ErrorCode: 0, MessageID: 'pm-1' }), { status: 200 }); }) as unknown as typeof fetch;
  const sender = createMhpMarketingSender(mhpConfig(), 'synthetic-unsubscribe-secret-at-least-32-characters', fetcher, { guard: service.guard, workspaceId: MHP });
  await assert.rejects(sender.sendRendered({ id: 'a', email: 'anyone@example.invalid', tag: 'owner_sequence', rendered }),
    (error: unknown) => error instanceof EmailRecipientBlockedError && error.reason === 'check_unavailable');
  assert.equal(calls, 0);
  // PP: the dispatcher spends nothing and leaves the lease to run out (claimed again later); the sender hands the attempt back.
  const ppService = new EmailBounceService({ config: { sources: [{ ...source, key: 'pp', workspaceId: PP }], blockers: [] }, now: () => NOW, ledger });
  ppService.registry.markReady();
  const recipients = { guard: ppService.guard, workspaceId: PP };
  const calls2: string[] = [];
  const lease = { id: '4d7fa05e-6b3a-4e9c-9f4d-3c4d5e6f7081', leaseId: '5e80b16f-7c4b-4fad-a05e-4d5e6f708192', leaseUntil: new Date(Date.now() + 120_000).toISOString(), email: 'ann@example.com' };
  const queue: PpFollowupQueue = { claim: async () => { calls2.push('claim'); return [lease]; }, prepare: async () => { calls2.push('prepare'); return null as unknown as PpFollowupPrepared; },
    settle: async (_l, outcome) => { calls2.push(`settle:${outcome}`); }, unknown: async () => { calls2.push('unknown'); } };
  const pp = ppMarketingConfig({ PP_MARKETING_MODE: 'live', PP_POSTMARK_SERVER_TOKEN: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', PP_MARKETING_FROM: 'hello@propertypredator.com',
    PP_POSTMARK_BROADCAST_STREAM: 'pp-news', PORTAL_BASE_URL: 'https://hq.propertypredator.com', SESSION_SECRET: 'synthetic-pp-followup-secret-at-least-32-chars' }).config!;
  let ppCalls = 0;
  const ppSender = createPpPostmarkSender(pp, (async () => { ppCalls++; return new Response('{}'); }) as unknown as typeof fetch, recipients);
  const result = await dispatchPpFollowupEmails({ queue, sender: ppSender, unsubscribeSecret: 'synthetic-pp-followup-secret-at-least-32-chars', recipients,
    config: { testRecipients: null, link: 'https://propertypredator.com/', unsubscribeOrigin: 'https://hq.propertypredator.com', fromName: 'Property Predator' } });
  assert.deepEqual(result, { sent: 0, failed: 1, unknown: 0 });
  assert.deepEqual(calls2, ['claim'], 'no proof prepared and nothing settled: the step is claimed again later');
  await assert.rejects(ppSender.sendRendered({ id: 'x', email: 'ann@example.com', tag: 't', rendered: { subject: 's', text: 't', html: 'h', unsubscribe: 'https://hq.propertypredator.com/u' } }),
    (error: unknown) => error instanceof PpNotSentError && error.scope === 'sender');
  assert.equal(ppCalls, 0);
});

test('a missing ledger function after the ledger has answered in this process is a fault: thrown and warned every time, never "not applied yet"', async () => {
  let answered = 0;
  const pool = { query: async () => {
    if (answered++ === 0) return { rows: [{ value: { blocked: false, reallowed: false, clearedAt: null } }] };
    throw Object.assign(new Error('function app_private.email_block_decide(uuid, text, text) does not exist'), { code: '42883' });
  } };
  const logs: string[] = [];
  const ledger = new PgEmailBlockLedger(pool as never, { log: line => logs.push(line) });
  assert.equal(ledger.status(), 'unknown');
  assert.deepEqual(await ledger.decide(MHP, 'a@example.invalid', 'marketing'), { blocked: false, reallowed: false, clearedAt: null });
  assert.equal(ledger.status(), 'available');
  for (let i = 0; i < 2; i++) await assert.rejects(ledger.decide(MHP, 'a@example.invalid', 'marketing'), /does not exist/u);
  assert.equal(logs.filter(line => line.includes('ledger_missing_after_use') && line.includes('"level":"warn"')).length, 2, 'warned every time');
  assert.equal(ledger.status(), 'available');
  const service = new EmailBounceService({ config: { sources: [source], blockers: [] }, now: () => NOW, ledger });
  await assert.rejects(service.guard.check!(MHP, 'a@example.invalid', 'marketing'), EmailGuardUnavailableError);
});

test('out-of-order events: a re-subscribe that arrives before a retried older unsubscribe leaves a lifted marker; event times decide in both orders', async () => {
  const resub = (at: string) => ({ RecordType: 'SubscriptionChange', MessageStream: 'broadcast', Recipient: 'left@example.invalid', ChangedAt: at, SuppressSending: false, ServerID: 23 });
  for (const order of ['unsubscribe-first', 'resubscribe-first'] as const) {
    const ledger = new FakeLedger();
    const f = webhookFixture(ledger);
    const events = [subscription(true, '2026-11-12T09:00:00Z'), resub('2026-11-12T09:30:00Z')];
    for (const event of order === 'unsubscribe-first' ? events : events.reverse()) assert.equal((await f.post(event)).status, 200);
    assert.deepEqual(await decideRecipient(f.service.guard, MHP, 'left@example.invalid', 'marketing'), { blocked: false }, order);
    // A genuinely newer unsubscribe still blocks again.
    assert.equal((await f.post(subscription(true, '2026-11-12T09:45:00Z'))).status, 200);
    assert.deepEqual(await decideRecipient(f.service.guard, MHP, 'left@example.invalid', 'marketing'), { blocked: true, reason: 'unsubscribed' }, `${order}, newer unsubscribe`);
  }
});

test('the hourly read: a list row with no time keeps its first-seen time; a refused row is counted and warned, the rest still written', async () => {
  const ledger = new FakeLedger();
  ledger.firstSeen = NOW - 10 * DAY;
  const api: PostmarkBounceApi = { suppressions: async stream => stream === 'broadcast' ? [{ email: 'left@example.invalid', kind: 'unsubscribed', at: null }] : [],
    bounces: async () => ({ total: 0, received: 0, rows: [] }), totals: async () => ({ sent: 1, bounced: 0, complaints: 0 }) };
  let now = NOW;
  const service = new EmailBounceService({ config: { sources: [source], blockers: [] }, now: () => now, apiFor: () => api, ledger });
  await service.sweepWorkspace(MHP);
  ledger.firstSeen = NOW; now = NOW + DAY;
  await new EmailBounceService({ config: { sources: [source], blockers: [] }, now: () => now, apiFor: () => api, ledger }).sweepWorkspace(MHP);
  assert.deepEqual(ledger.rows_.map(r => [r.email, r.at]), [['left@example.invalid', NOW - 10 * DAY]], 'the second read does not renew the time');
  ledger.signedUp.set('left@example.invalid', NOW - DAY);
  assert.deepEqual(await decideRecipient(service.guard, MHP, 'left@example.invalid', 'marketing'), { blocked: false }, 'so a sign-up since still re-allows marketing');
  // A ledger that refused one row: counted, and the timed read logs a warning.
  const skipping: EmailBlockLedger = Object.assign(new FakeLedger(), { recordList: async (input: { rows: readonly unknown[] }) => ({ added: 0, skipped: input.rows.length }) });
  const logs: string[] = [];
  const warned = new EmailBounceService({ config: { sources: [source], blockers: [] }, now: () => NOW, apiFor: () => api, ledger: skipping, log: line => logs.push(line) });
  assert.deepEqual(await warned.sweepWorkspace(MHP), { streams: 2, failed: 0, suppressions: 1, bounces: 0, ledgerSkipped: 1 });
  const stop = warned.start(3_600_000);
  for (let i = 0; i < 50 && logs.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 10));
  stop();
  assert.match(logs[0]!, /"event":"email\.bounces\.sweep_ledger_incomplete","level":"warn"/u); assert.doesNotMatch(logs[0]!, /@/u);
});

test('a newer in-process unsubscribe is not ignored because an older ledger unsubscribe was re-allowed', async () => {
  const ledger = new FakeLedger();
  ledger.rows_.push({ workspaceId: MHP, sourceKey: 'mhp', email: 'back@example.invalid', reason: 'unsubscribed', at: NOW - 40 * DAY, eventId: null, lifted: false });
  ledger.signedUp.set('back@example.invalid', NOW - 2 * DAY);
  const service = new EmailBounceService({ config: { sources: [source], blockers: [] }, now: () => NOW, ledger });
  assert.deepEqual(await decideRecipient(service.guard, MHP, 'back@example.invalid', 'marketing'), { blocked: false });
  // A webhook reported a NEW unsubscribe a moment ago whose durable write has not landed yet.
  service.registry.record(MHP, { sourceKey: 'mhp', stream: 'broadcast', id: 'subscription:new', kind: 'unsubscribed', email: 'back@example.invalid', at: NOW - 60_000 }, false);
  assert.deepEqual(await decideRecipient(service.guard, MHP, 'back@example.invalid', 'marketing'), { blocked: true, reason: 'unsubscribed' });
  // ...while an older in-process copy of the re-allowed unsubscribe is ignored.
  const older = new EmailBounceService({ config: { sources: [source], blockers: [] }, now: () => NOW, ledger });
  older.registry.record(MHP, { sourceKey: 'mhp', stream: 'broadcast', id: 'subscription:old', kind: 'unsubscribed', email: 'back@example.invalid', at: NOW - 40 * DAY }, false);
  assert.deepEqual(await decideRecipient(older.guard, MHP, 'back@example.invalid', 'marketing'), { blocked: false });
});

test('undo of a wrong hard bounce: the ledger lifts it, the process forgets its copy, and a later genuine bounce blocks again', async () => {
  const ledger = new FakeLedger();
  const f = webhookFixture(ledger);
  assert.equal((await f.post(bounce({ BouncedAt: '2026-11-12T08:00:00Z' }))).status, 200);
  assert.deepEqual(await decideRecipient(f.service.guard, MHP, 'gone@example.invalid', 'service'), { blocked: true, reason: 'hard_bounce' });
  assert.deepEqual(await f.service.ownerLiftHardBounce({ sessionToken: 't', workspaceId: MHP, email: 'gone@example.invalid', note: 'Owner confirmed' }), { lifted: 1, released: 0, spamComplaint: false });
  assert.equal(f.service.registry.decide(MHP, 'gone@example.invalid', 'service').blocked, false, 'the process copy is forgotten');
  assert.deepEqual(await decideRecipient(f.service.guard, MHP, 'gone@example.invalid', 'marketing'), { blocked: false });
  // The same old bounce replayed later by Postmark changes nothing; a new bounce after the lift blocks again.
  assert.equal((await f.post(bounce({ BouncedAt: '2026-11-12T08:00:00Z' }))).body.replayed, true);
  assert.equal((await f.post(bounce({ ID: 99, BouncedAt: '2026-11-12T09:59:00Z' }))).status, 200);
  assert.deepEqual(await decideRecipient(f.service.guard, MHP, 'gone@example.invalid', 'service'), { blocked: true, reason: 'hard_bounce' });
  // Without a durable ledger nothing is lifted and the caller is told so.
  assert.equal(await new EmailBounceService({ config: { sources: [source], blockers: [] } }).ownerLiftHardBounce({ sessionToken: 't', workspaceId: MHP, email: 'gone@example.invalid', note: 'x' }), null);
});
