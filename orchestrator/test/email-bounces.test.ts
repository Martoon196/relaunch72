import test from 'node:test';
import assert from 'node:assert/strict';
import {
  blocksPurpose, classifyPostmarkBounce, EmailBlockRegistry, EmailBounceService, emailBounceHandlingDisabled, loadEmailBounceConfig, londonMonthStart, parsePostmarkJson,
  refusalStopsPerson, factBlockReason,
  readPostmarkWebhook, sweepPostmarkSource, createPostmarkBounceApi, PostmarkReadError, SOFT_BOUNCE_LIMIT,
  type EmailBounceSource, type EmailFact, type PostmarkBounceApi,
} from '../src/email-bounces/index.js';

const WS = '2789228d-55a6-4688-b1e8-2f70abca990b', OTHER = 'd975ff66-336a-46c2-b36b-d7095a11af97';
const NOW = Date.parse('2026-11-12T10:00:00Z'), DAY = 86_400_000;
const fact = (over: Partial<EmailFact> = {}): EmailFact => ({ sourceKey: 'mhp', stream: 'broadcast', id: 'bounce:1', kind: 'hard_bounce', email: 'gone@example.invalid', at: NOW - DAY, ...over });

test('policy: a hard bounce stops all email, everything else stops marketing only', () => {
  assert.equal(blocksPurpose('hard_bounce', 'marketing'), true); assert.equal(blocksPurpose('hard_bounce', 'service'), true);
  for (const reason of ['spam_complaint', 'unsubscribed', 'repeated_soft_bounce'] as const) {
    assert.equal(blocksPurpose(reason, 'marketing'), true); assert.equal(blocksPurpose(reason, 'service'), false);
  }
});

test('policy: only a dead address stops the person from a send path, and a soft bounce is never final in itself', () => {
  assert.equal(refusalStopsPerson('hard_bounce'), true);
  for (const reason of ['spam_complaint', 'unsubscribed', 'repeated_soft_bounce'] as const) assert.equal(refusalStopsPerson(reason), false);
  assert.equal(factBlockReason('soft_bounce'), null);
  assert.deepEqual((['hard_bounce', 'spam_complaint', 'unsubscribed'] as const).map(factBlockReason), ['hard_bounce', 'spam_complaint', 'unsubscribed']);
});

test('the off switch is forgiving about how "off" is typed, and nothing else switches the feature off', () => {
  for (const value of ['off', 'OFF', ' Off ', 'false', 'FALSE', '0', 'no', 'disabled']) assert.equal(emailBounceHandlingDisabled({ EMAIL_BOUNCE_HANDLING: value }), true, value);
  for (const value of [undefined, '', 'on', 'true', '1', 'offf']) assert.equal(emailBounceHandlingDisabled({ EMAIL_BOUNCE_HANDLING: value }), false, String(value));
});

test('Postmark records: bounce IDs beyond a JavaScript number stay exact, and each type maps to one meaning', () => {
  const body = '{"RecordType":"Bounce","MessageStream":"broadcast","ID": 4323372036854775807,"Type":"HardBounce","TypeCode":1,"Email":"Gone@Example.invalid","BouncedAt":"2026-11-11T16:33:54.9070259Z","Inactive":true,"ServerID":23,"Metadata":{"send":"s-1","prospect":"0b5a3d52-3c6a-4f43-9c0e-0123456789ab","n":5},"Details":"a \\"ID\\": 7 inside text"}';
  const reading = readPostmarkWebhook(parsePostmarkJson(body));
  assert.equal(reading.outcome, 'event');
  if (reading.outcome !== 'event') return;
  assert.equal(reading.event.eventId, 'bounce:4323372036854775807');
  assert.equal(reading.event.email, 'gone@example.invalid'); assert.equal(reading.event.kind, 'hard_bounce'); assert.equal(reading.event.serverId, '23');
  assert.deepEqual(reading.event.metadata, { send: 's-1', prospect: '0b5a3d52-3c6a-4f43-9c0e-0123456789ab' });
  assert.equal(classifyPostmarkBounce('BadEmailAddress', false), 'hard_bounce');
  assert.equal(classifyPostmarkBounce('SoftBounce', false), 'soft_bounce'); assert.equal(classifyPostmarkBounce('DnsError', false), 'soft_bounce');
  assert.equal(classifyPostmarkBounce('SpamComplaint', true), 'spam_complaint'); assert.equal(classifyPostmarkBounce('ManuallyDeactivated', true), 'unsubscribed');
  assert.equal(classifyPostmarkBounce('Transient', false), null); assert.equal(classifyPostmarkBounce('AutoResponder', false), null);
  assert.equal(classifyPostmarkBounce('Blocked', false), null, 'the receiving provider refused the sender, not the address');
  assert.equal(classifyPostmarkBounce('SpamNotification', false), null, 'filtered as spam by the receiving provider: about the content, not the address');
  assert.equal(classifyPostmarkBounce('Blocked', true), 'hard_bounce', 'unless Postmark itself switched the address off');
  assert.equal(classifyPostmarkBounce('SomethingNew', true), 'hard_bounce', 'an address Postmark switched off is treated as not working');
  assert.deepEqual(readPostmarkWebhook({ RecordType: 'Delivery', MessageStream: 'broadcast' }), { outcome: 'ignored', why: 'record_type' });
  assert.deepEqual(readPostmarkWebhook({ RecordType: 'Bounce', MessageStream: 'broadcast', ID: 1, Type: 'HardBounce', Email: 'not-an-address', BouncedAt: '2026-11-11T10:00:00Z' }), { outcome: 'invalid' });
  const change = (over: Record<string, unknown>) => readPostmarkWebhook({ RecordType: 'SubscriptionChange', MessageStream: 'broadcast', Recipient: 'a@example.invalid', ChangedAt: '2026-11-11T10:00:00Z', ...over });
  const off = change({ SuppressSending: true, SuppressionReason: 'ManualSuppression', Origin: 'Recipient' });
  assert.equal(off.outcome === 'event' && off.event.kind, 'unsubscribed');
  const on = change({ SuppressSending: false, SuppressionReason: null });
  assert.equal(on.outcome === 'event' && on.event.kind, 'resubscribed');
  assert.equal(change({ SuppressSending: true, SuppressionReason: 'HardBounce' }).outcome === 'event', true);
  assert.equal(change({}).outcome, 'invalid');
});

test('registry: one fact is applied once, blocks every stream of the same workspace only, and never another workspace', () => {
  const registry = new EmailBlockRegistry(() => NOW);
  assert.deepEqual(registry.decide(WS, 'gone@example.invalid', 'marketing'), { blocked: false });
  assert.deepEqual(registry.record(WS, fact()), { added: true, marketingBlock: 'hard_bounce' });
  assert.deepEqual(registry.record(WS, fact()), { added: false, marketingBlock: 'hard_bounce' }, 'replay adds nothing');
  assert.deepEqual(registry.decide(WS, 'GONE@example.invalid ', 'marketing'), { blocked: true, reason: 'hard_bounce' });
  assert.deepEqual(registry.decide(WS, 'gone@example.invalid', 'service'), { blocked: true, reason: 'hard_bounce' });
  assert.deepEqual(registry.decide(OTHER, 'gone@example.invalid', 'marketing'), { blocked: false }, 'another brand is untouched');
  registry.record(WS, fact({ id: 'bounce:2', kind: 'spam_complaint', email: 'cross@example.invalid' }));
  assert.equal(registry.decide(WS, 'cross@example.invalid', 'marketing').blocked, true);
  assert.equal(registry.decide(WS, 'cross@example.invalid', 'service').blocked, false, 'a requested event email still goes after a complaint');
  assert.equal(registry.snapshot(WS).blocked.length, 2);
});

test('registry: soft bounces only block after the stated number inside the stated window', () => {
  let now = NOW;
  const registry = new EmailBlockRegistry(() => now);
  assert.equal(SOFT_BOUNCE_LIMIT, 3);
  for (let i = 1; i <= 2; i++) assert.equal(registry.record(WS, fact({ id: `bounce:s${i}`, kind: 'soft_bounce', email: 'full@example.invalid', at: NOW - i * DAY })).marketingBlock, null);
  assert.equal(registry.decide(WS, 'full@example.invalid', 'marketing').blocked, false);
  assert.equal(registry.record(WS, fact({ id: 'bounce:s2', kind: 'soft_bounce', email: 'full@example.invalid', at: NOW - 2 * DAY })).marketingBlock, null, 'the same bounce counted once');
  assert.equal(registry.record(WS, fact({ id: 'bounce:s3', kind: 'soft_bounce', email: 'full@example.invalid', at: NOW })).marketingBlock, 'repeated_soft_bounce');
  assert.deepEqual(registry.decide(WS, 'full@example.invalid', 'marketing'), { blocked: true, reason: 'repeated_soft_bounce' });
  assert.equal(registry.decide(WS, 'full@example.invalid', 'service').blocked, false);
  assert.equal(registry.snapshot(WS).blocked[0]?.allEmail, false);
  now = NOW + 29 * DAY;
  assert.equal(registry.decide(WS, 'full@example.invalid', 'marketing').blocked, false, 'old temporary failures stop counting');
  const stale = new EmailBlockRegistry(() => NOW);
  for (let i = 0; i < 3; i++) stale.record(WS, fact({ id: `bounce:o${i}`, kind: 'soft_bounce', email: 'old@example.invalid', at: NOW - (31 + i) * DAY }));
  assert.equal(stale.decide(WS, 'old@example.invalid', 'marketing').blocked, false);
});

test('registry: a list read replaces a stream, releases what Postmark no longer lists, and keeps a fresh webhook block', () => {
  let now = NOW;
  const registry = new EmailBlockRegistry(() => now);
  const read = (emails: string[], startedAt = now) => registry.reconcile(WS, { sourceKey: 'mhp', stream: 'broadcast', kind: 'marketing', startedAt,
    suppressions: emails.map(email => ({ email, kind: 'hard_bounce' as const, at: NOW - 5 * DAY })), bounces: [], sent: 200, bounced: 3, complaints: 0 });
  read(['a@example.invalid', 'b@example.invalid']);
  assert.equal(registry.decide(WS, 'a@example.invalid', 'service').blocked, true);
  registry.record(WS, fact({ id: 'bounce:new', email: 'new@example.invalid', at: now }));
  now += 60_000;
  read(['a@example.invalid']);
  assert.equal(registry.decide(WS, 'b@example.invalid', 'marketing').blocked, false, 'reactivated in Postmark');
  assert.equal(registry.decide(WS, 'new@example.invalid', 'marketing').blocked, true, 'a block from moments ago survives a list that has not caught up');
  now += 3_600_000;
  read(['a@example.invalid']);
  assert.equal(registry.decide(WS, 'new@example.invalid', 'marketing').blocked, false, 'and is released once the provider plainly does not list it');
  registry.record(WS, fact({ id: 'sub:1', kind: 'unsubscribed', email: 'left@example.invalid' }));
  registry.release(WS, 'mhp', 'broadcast', 'left@example.invalid');
  assert.equal(registry.decide(WS, 'left@example.invalid', 'marketing').blocked, false);
});

test('registry: an address reactivated at Postmark while a list read is in flight stays released; a stale list cannot block it again', () => {
  let now = NOW;
  const registry = new EmailBlockRegistry(() => now);
  const read = (emails: string[], startedAt: number) => registry.reconcile(WS, { sourceKey: 'mhp', stream: 'broadcast', kind: 'marketing', startedAt,
    suppressions: emails.map(email => ({ email, kind: 'hard_bounce' as const, at: NOW - 5 * DAY })), bounces: [], sent: 10, bounced: 1, complaints: 0 });
  read(['fixed@example.invalid', 'dead@example.invalid'], now);
  assert.equal(registry.decide(WS, 'fixed@example.invalid', 'service').blocked, true);
  // A read starts and fetches the list; before it is applied, Postmark's webhook says the address was reactivated.
  const startedAt = now; now += 2_000;
  registry.release(WS, 'mhp', 'broadcast', 'fixed@example.invalid');
  now += 2_000;
  read(['fixed@example.invalid', 'dead@example.invalid'], startedAt);
  assert.equal(registry.decide(WS, 'fixed@example.invalid', 'service').blocked, false, 'the newer word from Postmark wins over the list fetched before it');
  assert.equal(registry.decide(WS, 'dead@example.invalid', 'service').blocked, true, 'only that address, only that stream');
  assert.equal(registry.decide(OTHER, 'fixed@example.invalid', 'service').blocked, false);
  // A later read is newer than the reactivation: if Postmark lists the address again (it bounced again), it is blocked again.
  now += 3_600_000;
  read(['fixed@example.invalid', 'dead@example.invalid'], now);
  assert.equal(registry.decide(WS, 'fixed@example.invalid', 'service').blocked, true);
});

test('registry: the owner snapshot counts people this month and uses the provider totals for the 30-day rate', () => {
  const registry = new EmailBlockRegistry(() => NOW);
  registry.reconcile(WS, { sourceKey: 'mhp', stream: 'broadcast', kind: 'marketing', startedAt: NOW,
    suppressions: [{ email: 'a@example.invalid', kind: 'hard_bounce', at: NOW - 2 * DAY }, { email: 'c@example.invalid', kind: 'spam_complaint', at: NOW - 3 * DAY },
      { email: 'old@example.invalid', kind: 'hard_bounce', at: NOW - 80 * DAY }],
    bounces: [{ id: '1', kind: 'hard_bounce', email: 'a@example.invalid', at: NOW - 2 * DAY }, { id: '2', kind: 'hard_bounce', email: 'a@example.invalid', at: NOW - DAY },
      { id: '3', kind: 'spam_complaint', email: 'c@example.invalid', at: NOW - 3 * DAY }, { id: '4', kind: 'soft_bounce', email: 'full@example.invalid', at: NOW - DAY }],
    sent: 40, bounced: 3, complaints: 1 });
  registry.reconcile(WS, { sourceKey: 'mhp', stream: 'outbound', kind: 'service', startedAt: NOW, suppressions: [], bounces: [], sent: 60, bounced: 0, complaints: 0 });
  const snapshot = registry.snapshot(WS);
  assert.deepEqual(snapshot.month, { bounced: 1, complained: 1, unsubscribed: 0 }, 'old@ bounced in an earlier month; a@ bounced twice but is one person');
  assert.deepEqual(snapshot.window, { days: 30, sent: 100, bounced: 3, complaints: 1, bounceRate: 0.03, complaintRate: 0.01 });
  assert.deepEqual(snapshot.streams.map(s => [s.kind, s.stream, s.sent, s.bounceRate]), [['marketing', 'broadcast', 40, 0.075], ['service', 'outbound', 60, 0]]);
  assert.deepEqual(snapshot.blocked.map(b => [b.email, b.reason, b.allEmail]), [['a@example.invalid', 'hard_bounce', true], ['c@example.invalid', 'spam_complaint', false], ['old@example.invalid', 'hard_bounce', true]]);
  assert.equal(snapshot.incomplete, false);
  registry.readFailed(WS, 'mhp', 'outbound', 'service');
  assert.equal(registry.snapshot(WS).incomplete, true); assert.equal(registry.snapshot(WS).window.sent, 100, 'the last good totals are kept');
  assert.equal(new Date(londonMonthStart(NOW)).toISOString(), '2026-11-01T00:00:00.000Z');
  assert.equal(new Date(londonMonthStart(Date.parse('2026-07-15T12:00:00Z'))).toISOString(), '2026-06-30T23:00:00.000Z', 'British Summer Time');
});

test('"this month" starts at UK midnight on the 1st even after the clocks change inside the month', () => {
  const start = (iso: string) => new Date(londonMonthStart(Date.parse(iso))).toISOString();
  // March starts in GMT and ends in BST (clocks forward 29 March 2026): the start is still midnight GMT on the 1st.
  assert.equal(start('2026-03-28T12:00:00Z'), '2026-03-01T00:00:00.000Z');
  assert.equal(start('2026-03-30T11:00:00Z'), '2026-03-01T00:00:00.000Z', 'not 23:00 on 28 February');
  assert.equal(start('2026-03-31T22:59:59Z'), '2026-03-01T00:00:00.000Z');
  assert.equal(start('2026-03-31T23:00:00Z'), '2026-03-31T23:00:00.000Z', 'midnight BST on 1 April');
  // October starts in BST and ends in GMT (clocks back 25 October 2026): the start is still midnight BST on the 1st.
  assert.equal(start('2026-10-24T12:00:00Z'), '2026-09-30T23:00:00.000Z');
  assert.equal(start('2026-10-28T12:00:00Z'), '2026-09-30T23:00:00.000Z', 'not an hour into 1 October');
  assert.equal(start('2026-10-31T23:59:59Z'), '2026-09-30T23:00:00.000Z');
  assert.equal(start('2026-11-01T00:00:00Z'), '2026-11-01T00:00:00.000Z');
  assert.equal(start('2027-01-01T00:00:00Z'), '2027-01-01T00:00:00.000Z'); assert.equal(start('2026-12-31T23:59:59.999Z'), '2026-12-01T00:00:00.000Z');
  // A bounce in the first hour of 1 October (UK time) belongs to October when read at the end of the month.
  const late = Date.parse('2026-10-28T12:00:00Z'), registry = new EmailBlockRegistry(() => late);
  registry.record(WS, fact({ id: 'bounce:oct', at: Date.parse('2026-09-30T23:30:00Z') }));
  registry.record(WS, fact({ id: 'bounce:sep', email: 'sept@example.invalid', at: Date.parse('2026-09-30T22:30:00Z') }));
  assert.equal(registry.snapshot(WS).month.bounced, 1);
});

test('registry: send paths wait for the first list read once, then never again', async () => {
  const registry = new EmailBlockRegistry(() => NOW);
  let resolved = false; const waiting = registry.whenReady(10_000).then(() => { resolved = true; });
  await Promise.resolve(); assert.equal(resolved, false);
  registry.markReady(); await waiting; assert.equal(resolved, true);
  const slow = new EmailBlockRegistry(() => NOW);
  // The gate's own timer never keeps a process alive, so the test holds the loop open itself.
  await Promise.all([slow.whenReady(5), new Promise(resolve => setTimeout(resolve, 30))]); assert.equal(slow.isReady, true, 'a timeout opens the gate for good rather than delaying every later send');
});

test('configuration: brands are added by configuration, secrets are only named, and a missing secret keeps the webhook closed', () => {
  const mhp = { key: 'mhp', workspaceId: WS, tokenEnv: 'MHP_POSTMARK_SERVER_TOKEN', webhookSecretEnv: 'MHP_POSTMARK_WEBHOOK_SECRET', marketingStreams: ['broadcast'], serviceStreams: ['outbound'] };
  assert.deepEqual(loadEmailBounceConfig({}, { defaults: [mhp] }).sources, [], 'no token, no source');
  const closed = loadEmailBounceConfig({ MHP_POSTMARK_SERVER_TOKEN: 'synthetic-token' }, { defaults: [mhp] });
  assert.equal(closed.sources[0]?.webhookSecret, null); assert.match(closed.blockers.join(' '), /MHP_POSTMARK_WEBHOOK_SECRET is not set/u);
  assert.equal(loadEmailBounceConfig({ MHP_POSTMARK_SERVER_TOKEN: 't', MHP_POSTMARK_WEBHOOK_SECRET: 'too-short' }, { defaults: [mhp] }).sources[0]?.webhookSecret, null);
  const env = { MHP_POSTMARK_SERVER_TOKEN: 'synthetic-token', MHP_POSTMARK_WEBHOOK_SECRET: 'm'.repeat(32), PP_TOKEN: 'pp-token', PP_SECRET: 'p'.repeat(32),
    EMAIL_BOUNCE_SOURCES: JSON.stringify([{ key: 'pp', workspaceId: OTHER, tokenEnv: 'PP_TOKEN', webhookSecretEnv: 'PP_SECRET', marketingStreams: ['broadcast'], serviceStreams: ['outbound'], serverId: '777' }]) };
  const both = loadEmailBounceConfig(env, { defaults: [mhp], webinarSenders: [{ workspaceId: WS, token: 'synthetic-token', messageStream: 'webinar-events' },
    { workspaceId: OTHER, token: 'a-different-server', messageStream: 'outbound' }] });
  assert.deepEqual(both.sources.map(s => [s.key, s.workspaceId, [...s.streams], s.serverId, Boolean(s.webhookSecret)]), [
    ['pp', OTHER, [['outbound', 'service'], ['broadcast', 'marketing']], '777', true],
    ['mhp', WS, [['outbound', 'service'], ['broadcast', 'marketing'], ['webinar-events', 'service']], null, true],
    ['webinar-d975ff66', OTHER, [['outbound', 'service']], null, false]]);
  assert.doesNotMatch(JSON.stringify(both.blockers), /synthetic-token|pp-token|mmmm|pppp/u, 'no secret value in any message');
  assert.match(loadEmailBounceConfig({ EMAIL_BOUNCE_SOURCES: '{' }).blockers[0]!, /not valid JSON/u);
  assert.match(loadEmailBounceConfig({ EMAIL_BOUNCE_SOURCES: '[{"key":"x"}]' }).blockers[0]!, /needs key, workspaceId/u);
});

const source = (over: Partial<EmailBounceSource> = {}): EmailBounceSource => ({ key: 'mhp', workspaceId: WS, token: 'synthetic-token', webhookSecret: 's'.repeat(32), serverId: null,
  streams: new Map([['broadcast', 'marketing'], ['outbound', 'service']]), ...over });

test('sweep: reads every page of bounces, the suppression list and the totals for each stream, and reading twice changes nothing', async () => {
  const calls: string[] = [];
  const rows = Array.from({ length: 1100 }, (_, i) => ({ id: String(i + 1), kind: i < 3 ? 'hard_bounce' as const : 'soft_bounce' as const, email: i < 3 ? `gone${i}@example.invalid` : `soft${i}@example.invalid`, at: NOW - DAY }));
  const api: PostmarkBounceApi = {
    suppressions: async stream => { calls.push(`suppressions ${stream}`); return stream === 'broadcast'
      ? [0, 1, 2].map(i => ({ email: `gone${i}@example.invalid`, kind: 'hard_bounce' as const, at: NOW - DAY })).concat([{ email: 'left@example.invalid', kind: 'unsubscribed' as never, at: NOW - 9 * DAY }]) : []; },
    bounces: async (stream, from, to, offset, count) => { calls.push(`bounces ${stream} ${from} ${to} ${offset} ${count}`);
      const all = stream === 'broadcast' ? rows : []; const page = all.slice(offset, offset + count);
      return { total: all.length, received: page.length, rows: page }; },
    totals: async (stream, from, to) => { calls.push(`totals ${stream} ${from} ${to}`); return stream === 'broadcast' ? { sent: 5000, bounced: 1100, complaints: 0 } : { sent: 10, bounced: 0, complaints: 0 }; },
  };
  const registry = new EmailBlockRegistry(() => NOW);
  const first = await sweepPostmarkSource({ source: source(), api, registry, now: NOW });
  assert.deepEqual(first, { streams: 2, failed: 0, suppressions: 4, bounces: 1100 });
  assert.deepEqual(calls, ['suppressions broadcast', 'bounces broadcast 2026-10-12 2026-11-13 0 500', 'bounces broadcast 2026-10-12 2026-11-13 500 500',
    'bounces broadcast 2026-10-12 2026-11-13 1000 500', 'totals broadcast 2026-10-13 2026-11-13', 'suppressions outbound',
    'bounces outbound 2026-10-12 2026-11-13 0 500', 'totals outbound 2026-10-13 2026-11-13']);
  const before = JSON.stringify(registry.snapshot(WS));
  assert.deepEqual(await sweepPostmarkSource({ source: source(), api, registry, now: NOW }), first);
  assert.equal(JSON.stringify(registry.snapshot(WS)), before, 'idempotent');
  const snapshot = registry.snapshot(WS);
  assert.equal(snapshot.blocked.length, 4); assert.equal(snapshot.month.bounced, 3);
  assert.equal(registry.decide(WS, 'gone1@example.invalid', 'service').blocked, true);
  assert.equal(registry.decide(WS, 'left@example.invalid', 'marketing').blocked, true);
  assert.equal(registry.decide(WS, 'soft5@example.invalid', 'marketing').blocked, false, 'one temporary failure blocks nobody');
});

test('sweep: a stream that cannot be read keeps what was known, and missing totals never hide the block list', async () => {
  const registry = new EmailBlockRegistry(() => NOW);
  registry.record(WS, fact({ stream: 'outbound', email: 'known@example.invalid', at: NOW - 3_600_000 }));
  const api: PostmarkBounceApi = {
    suppressions: async stream => { if (stream === 'outbound') throw new PostmarkReadError(500); return [{ email: 'gone@example.invalid', kind: 'hard_bounce', at: null }]; },
    bounces: async () => ({ total: 0, received: 0, rows: [] }), totals: async () => { throw new PostmarkReadError(422); },
  };
  assert.deepEqual(await sweepPostmarkSource({ source: source(), api, registry, now: NOW }), { streams: 2, failed: 1, suppressions: 1, bounces: 0 });
  assert.equal(registry.decide(WS, 'known@example.invalid', 'marketing').blocked, true);
  assert.equal(registry.decide(WS, 'gone@example.invalid', 'marketing').blocked, true);
  const snapshot = registry.snapshot(WS);
  assert.equal(snapshot.incomplete, true); assert.equal(snapshot.window.sent, null); assert.equal(snapshot.window.bounceRate, null);
});

test('Postmark reads use the server token, a fixed host and never surface a response body', async () => {
  const seen: { url: string; token: unknown; method: unknown }[] = [];
  const reply: Record<string, unknown> = {
    '/message-streams/broadcast/suppressions/dump': { Suppressions: [{ EmailAddress: 'Gone@Example.invalid', SuppressionReason: 'HardBounce', Origin: 'Recipient', CreatedAt: '2026-11-01T08:58:33-05:00' },
      { EmailAddress: 'x@example.invalid', SuppressionReason: 'Mystery' }] },
    '/bounces': '{"TotalCount":2,"Bounces":[{"ID":4323372036854775807,"Type":"HardBounce","Email":"gone@example.invalid","BouncedAt":"2026-11-01T10:00:00Z","Inactive":true},{"ID":5,"Type":"Transient","Email":"t@example.invalid","BouncedAt":"2026-11-01T10:00:00Z","Inactive":false}]}',
    '/stats/outbound': { Sent: 615, Bounced: 64, SpamComplaints: 10, BounceRate: 10.406 },
  };
  const fetcher = (async (url: string, init: RequestInit) => {
    const parsed = new URL(url); seen.push({ url, token: (init.headers as Record<string, string>)['X-Postmark-Server-Token'], method: init.method });
    assert.equal(parsed.origin, 'https://api.postmarkapp.com'); assert.equal(init.redirect, 'error');
    const body = reply[parsed.pathname];
    if (body === undefined) return new Response('{"ErrorCode":10,"Message":"secret detail gone@example.invalid"}', { status: 401 });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  const api = createPostmarkBounceApi('synthetic-token', fetcher);
  assert.deepEqual(await api.suppressions('broadcast'), [{ email: 'gone@example.invalid', kind: 'hard_bounce', at: Date.parse('2026-11-01T13:58:33Z') }]);
  const page = await api.bounces('broadcast', '2026-10-12', '2026-11-13', 0, 500);
  assert.deepEqual([page.total, page.received, page.rows.map(r => r.id)], [2, 2, ['4323372036854775807']]);
  assert.match(seen[1]!.url, /\/bounces\?count=500&offset=0&fromdate=2026-10-12&todate=2026-11-13&messagestream=broadcast$/u);
  assert.deepEqual(await api.totals('broadcast', '2026-10-13', '2026-11-13'), { sent: 615, bounced: 64, complaints: 10 });
  assert.ok(seen.every(call => call.token === 'synthetic-token' && call.method === 'GET'));
  await assert.rejects(api.suppressions('missing'), (error: unknown) => error instanceof PostmarkReadError && error.status === 401 && !/example|secret/u.test(String(error)));
  await assert.rejects(createPostmarkBounceApi('t', (async () => { throw new Error('network gone@example.invalid'); }) as typeof fetch).totals('x', 'a', 'b'),
    (error: unknown) => error instanceof PostmarkReadError && !/example/u.test(String(error)));
});

test('an oversized Postmark answer is abandoned part-way: it is never buffered whole and measured afterwards', async () => {
  const MB = 1024 * 1024, chunk = new Uint8Array(MB).fill(0x20);
  let pulled = 0, cancelled = false;
  const endless = (headers: Record<string, string> = {}) => new Response(new ReadableStream<Uint8Array>({
    pull(controller) { pulled++; if (pulled > 200) controller.close(); else controller.enqueue(chunk); }, cancel() { cancelled = true; } }, { highWaterMark: 0 }), { status: 200, headers });
  await assert.rejects(createPostmarkBounceApi('t', (async () => endless()) as typeof fetch).suppressions('broadcast'), PostmarkReadError);
  assert.equal(cancelled, true, 'the download is cancelled');
  assert.ok(pulled <= 14, `stopped just past the 12 MB cap, not after all 200 MB (read ${pulled} MB)`);
  pulled = 0; cancelled = false;
  await assert.rejects(createPostmarkBounceApi('t', (async () => endless({ 'content-length': String(500 * MB) })) as typeof fetch).totals('x', 'a', 'b'), PostmarkReadError);
  assert.ok(pulled <= 1, 'a declared size over the cap is refused before the body is read');
  const empty = createPostmarkBounceApi('t', (async () => new Response(null, { status: 200 })) as typeof fetch);
  await assert.rejects(empty.totals('x', 'a', 'b'), PostmarkReadError);
});

test('service: one sweep per source at a time, an owner check does not hammer Postmark, and the timer opens the gate even on failure', async () => {
  let now = NOW, reads = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const api: PostmarkBounceApi = { suppressions: async () => { reads++; await gate; return []; }, bounces: async () => ({ total: 0, received: 0, rows: [] }), totals: async () => ({ sent: 1, bounced: 0, complaints: 0 }) };
  const service = new EmailBounceService({ config: { sources: [source({ streams: new Map([['broadcast', 'marketing']]) })], blockers: [] }, now: () => now, apiFor: () => api });
  assert.equal(service.registry.isReady, false);
  const [a, b] = [service.sweepWorkspace(WS), service.sweepWorkspace(WS)];
  release(); await Promise.all([a, b]);
  assert.equal(reads, 1, 'the second caller joined the running sweep');
  await service.sweepWorkspace(WS, 30_000); assert.equal(reads, 1, 'read moments ago');
  now += 31_000; await service.sweepWorkspace(WS, 30_000); assert.equal(reads, 2);
  await service.sweepWorkspace(OTHER); assert.equal(reads, 2, 'another workspace has no source here');
  assert.equal(service.hasWorkspace(WS), true); assert.equal(service.hasWorkspace(OTHER), false);
  const broken = new EmailBounceService({ config: { sources: [source()], blockers: [] }, now: () => now, apiFor: () => ({ suppressions: async () => { throw new PostmarkReadError(null); },
    bounces: async () => ({ total: 0, received: 0, rows: [] }), totals: async () => ({ sent: null, bounced: null, complaints: null }) }) });
  const stop = broken.start(60_000); await broken.registry.whenReady(2_000); stop();
  assert.equal(broken.registry.isReady, true); assert.equal(broken.registry.snapshot(WS).incomplete, true);
  assert.equal(new EmailBounceService({ config: { sources: [], blockers: [] } }).registry.isReady, true, 'nothing to read means nothing to wait for');
});

test('paging never asks Postmark for more than it serves: 500 a page and 10,000 a query, and says when the log was longer', async () => {
  const offsets: number[] = [];
  const api: PostmarkBounceApi = { suppressions: async () => [], totals: async () => ({ sent: null, bounced: null, complaints: null }),
    bounces: async (_stream, _from, _to, offset, count) => { assert.ok(count <= 500 && offset + count <= 10_000); offsets.push(offset);
      return { total: 25_000, received: count, rows: [] }; } };
  const result = await sweepPostmarkSource({ source: source({ streams: new Map([['broadcast', 'marketing']]) }), api, registry: new EmailBlockRegistry(() => NOW), now: NOW });
  assert.deepEqual([offsets.length, offsets[0], offsets.at(-1)], [20, 0, 9_500]); assert.equal(result.truncated, 1); assert.equal(result.failed, 0);
  const real = createPostmarkBounceApi('t', (async () => { throw new Error('must not be called'); }) as typeof fetch);
  await assert.rejects(real.bounces('broadcast', 'a', 'b', 0, 501), PostmarkReadError);
  await assert.rejects(real.bounces('broadcast', 'a', 'b', 9_600, 500), PostmarkReadError);
  await assert.rejects(real.bounces('broadcast', 'a', 'b', -1, 500), PostmarkReadError);
});

test('a start-up read that fails is logged as a warning and retried on a timer until it succeeds; it never runs silently on an empty list', async () => {
  let attempts = 0, finished!: () => void; const done = new Promise<void>(resolve => { finished = resolve; });
  const logs: Record<string, unknown>[] = [];
  const api: PostmarkBounceApi = { bounces: async () => ({ total: 0, received: 0, rows: [] }), totals: async () => ({ sent: 10, bounced: 0, complaints: 0 }),
    suppressions: async () => { attempts++; if (attempts <= 2) throw new PostmarkReadError(503); return [{ email: 'gone@example.invalid', kind: 'hard_bounce', at: NOW - DAY }]; } };
  const service = new EmailBounceService({ config: { sources: [source({ streams: new Map([['broadcast', 'marketing']]) })], blockers: [] }, now: () => NOW, apiFor: () => api,
    log: line => { const entry = JSON.parse(line) as Record<string, unknown>; logs.push(entry); if (entry.event === 'email.bounces.sweep') finished(); } });
  const keepAlive = setInterval(() => undefined, 5);
  const stop = service.start(3_600_000, { retryMs: 5, maxRetryMs: 20 });
  await done; stop(); clearInterval(keepAlive);
  assert.equal(attempts, 3);
  assert.deepEqual(logs.map(entry => [entry.event, entry.level]), [['email.bounces.sweep_incomplete', 'warn'], ['email.bounces.sweep_retry', 'warn'],
    ['email.bounces.sweep_incomplete', 'warn'], ['email.bounces.sweep_retry', 'warn'], ['email.bounces.sweep', 'info']]);
  assert.deepEqual(logs.filter(entry => entry.event === 'email.bounces.sweep_retry').map(entry => entry.attempt), [1, 2]);
  assert.equal(service.registry.decide(WS, 'gone@example.invalid', 'marketing').blocked, true, 'the list arrives once Postmark answers');
  assert.equal(service.registry.snapshot(WS).incomplete, false);
  const webhookOnly = new EmailBounceService({ config: { sources: [source({ token: null })], blockers: [] }, now: () => NOW });
  assert.deepEqual(await webhookOnly.sweepWorkspace(WS), { streams: 0, failed: 0, suppressions: 0, bounces: 0 }, 'a source with no token is not a failed read to retry');
});
