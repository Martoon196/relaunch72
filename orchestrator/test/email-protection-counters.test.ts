/**
 * Where the counters come from: a stored connection's webhook and its hourly read (configured sources are never
 * counted), each Postmark event once, a failed write asks Postmark to retry; and Postmark's side of "This address
 * works now" for a stored connection and the environment-configured Martin Howard Property path alike.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createPostmarkBounceWebhook, EmailBounceService, sweepPostmarkSource, EmailBlockRegistry, type EmailBounceSource } from '../src/email-bounces/index.js';
import { deletePostmarkSuppressions, readPostmarkSuppression } from '../src/email-bounces/postmark-suppressions.js';
import { postmarkCounterKind, readPostmarkCounter, readPostmarkCounterRow, readPostmarkWebhook } from '../src/email-bounces/postmark-events.js';
import { MhpEmailHealth, emailHealthPage } from '../src/mhp/email-health.js';
import { GroupHqInboxCrmService, InboxCrmError } from '../src/integrations/group-hq-crm/inbox.js';
import type { CrmTransactionRunner } from '../src/crm-pg/types.js';
import type { Pool } from 'pg';
import { EmailProtectionService } from '../src/email-protection/service.js';
import { counts, MemoryProtectionStore } from './email-protection-fixtures.js';

const PP = 'd975ff66-336a-46c2-b36b-d7095a11af97', MHP = '2789228d-55a6-4688-b1e8-2f70abca990b';
const CONN_SECRET = 'conn-webhook-secret-synthetic-0123456789', ENV_SECRET = 'pp-webhook-secret-synthetic-9876543210';
const basic = (user: string, password: string): string => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
const CONN = 'conn-d975ff66336a46c2b36bd7095a11af97';

function fixture() {
  const service = new EmailBounceService({ config: { sources: [{ key: 'pp', workspaceId: PP, token: null, webhookSecret: ENV_SECRET, serverId: '777', streams: new Map([['broadcast', 'marketing']]) }], blockers: [] } });
  service.upsertSource({ key: CONN, workspaceId: PP, token: null, webhookSecret: CONN_SECRET, serverId: '5151', streams: new Map([['broadcast', 'marketing']]), connection: true });
  const counted: { kind: string; key: string }[] = [];
  let fail = false;
  service.setCounter(async input => { if (fail) throw new Error('database down'); counted.push({ kind: input.kind, key: input.key }); });
  const webhook = createPostmarkBounceWebhook({ service });
  const post = async (key: string, secret: string, body: unknown) => {
    const captured = { status: 0, body: {} as Record<string, unknown> };
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: 'POST', url: `/api/provider-webhooks/postmark/${key}`,
      headers: { 'content-type': 'application/json', authorization: basic(key, secret) }, socket: { remoteAddress: '10.0.0.1' } }) as unknown as IncomingMessage;
    const res = { writeHead(status: number) { captured.status = status; }, end(text = '') { captured.body = text ? JSON.parse(text) : {}; } } as unknown as ServerResponse;
    await webhook.handle(req, res, new URL(req.url!, 'https://app.example.test'));
    return captured;
  };
  return { service, counted, post, setFail: (value: boolean) => { fail = value; } };
}
const bounce = (over: Record<string, unknown> = {}) => ({ RecordType: 'Bounce', MessageStream: 'broadcast', ID: 42, Type: 'HardBounce', Email: 'gone@pp-send-proof.co.uk',
  BouncedAt: '2026-11-12T09:55:00Z', Inactive: true, ServerID: 5151, Metadata: {}, ...over });

test('a stored connection\'s webhook counts each Postmark event once (Blocked too, never a Transient); a configured source is never counted; a failed write is retried', async () => {
  const f = fixture();
  assert.equal((await f.post(CONN, CONN_SECRET, bounce())).status, 200);
  assert.equal((await f.post(CONN, CONN_SECRET, bounce())).status, 200, 'a replay');
  await f.post(CONN, CONN_SECRET, bounce({ ID: 43, Type: 'SoftBounce', Inactive: false }));
  await f.post(CONN, CONN_SECRET, bounce({ ID: 44, Type: 'Transient', Inactive: false }));
  await f.post(CONN, CONN_SECRET, bounce({ ID: 49, Type: 'Blocked', Inactive: false }));
  await f.post(CONN, CONN_SECRET, bounce({ ID: 50, Type: 'AutoResponder', Inactive: false }));
  await f.post(CONN, CONN_SECRET, { RecordType: 'SpamComplaint', MessageStream: 'broadcast', ID: 45, Type: 'SpamComplaint', Email: 'cross@pp-send-proof.co.uk', BouncedAt: '2026-11-12T09:56:00Z', ServerID: 5151 });
  // The subscription change that accompanies a hard bounce is not a second bounce; an unsubscribe is counted once.
  await f.post(CONN, CONN_SECRET, { RecordType: 'SubscriptionChange', MessageStream: 'broadcast', Recipient: 'gone@pp-send-proof.co.uk', ChangedAt: '2026-11-12T09:55:01Z', SuppressSending: true, SuppressionReason: 'HardBounce', ServerID: 5151 });
  await f.post(CONN, CONN_SECRET, { RecordType: 'SubscriptionChange', MessageStream: 'broadcast', Recipient: 'leave@pp-send-proof.co.uk', ChangedAt: '2026-11-12T09:57:00Z', SuppressSending: true, SuppressionReason: 'ManualSuppression', ServerID: 5151 });
  assert.deepEqual(f.counted.map(c => c.kind), ['hard_bounce', 'soft_bounce', 'blocked', 'complaint', 'unsubscribe'],
    'counted per the list in postmarkCounterKind; a Transient and an AutoResponder are not; a replay this process saw is skipped (the database keeps any other once)');
  assert.deepEqual(f.counted.slice(0, 4).map(c => c.key), ['bounce:42', 'bounce:43', 'bounce:49', 'bounce:45']);
  assert.match(f.counted[4]!.key, /^unsub:[0-9a-f]{40}$/u);
  assert.ok(f.counted.every(c => !c.key.includes('@')), 'no address in any key');
  // Postmark's set-up sample (another ServerID) is answered 200 and counted nowhere.
  const before = f.counted.length;
  await f.post(CONN, CONN_SECRET, bounce({ ID: 46, ServerID: 1 }));
  // The environment-configured source: exactly as before, nothing counted.
  assert.equal((await f.post('pp', ENV_SECRET, bounce({ ID: 47, ServerID: 777 }))).status, 200);
  assert.equal(f.counted.length, before);
  f.setFail(true);
  assert.equal((await f.post(CONN, CONN_SECRET, bounce({ ID: 48 }))).status, 503, 'Postmark retries');
  assert.equal((await f.post(CONN, CONN_SECRET, bounce({ ID: 51, Type: 'Blocked', Inactive: false }))).status, 503, 'a counted-only bounce is retried too');
  f.setFail(false);
  assert.equal((await f.post(CONN, CONN_SECRET, bounce({ ID: 48 }))).status, 200);
  assert.deepEqual(f.counted.at(-1), { kind: 'hard_bounce', key: 'bounce:48' });
});

test('one classification and one key for the webhook and the hourly read: the same Postmark event is the same counter row', () => {
  const b = { RecordType: 'Bounce', ID: '4323372036854775807', Type: 'HardBounce', Email: 'x@pp-send-proof.co.uk', BouncedAt: '2026-11-14T10:00:00Z', MessageStream: 'broadcast', ServerID: 5151, Inactive: false };
  // The reviewer's probe: HardBounce with Inactive:false is a soft bounce for BLOCKING but a hard bounce for counting, in both readers.
  assert.equal((readPostmarkWebhook(b) as { event: { kind: string } }).event.kind, 'soft_bounce');
  const viaWebhook = readPostmarkCounter(b)!, viaRead = readPostmarkCounterRow(b, 'broadcast')!;
  assert.deepEqual([viaWebhook.kind, viaWebhook.key], ['hard_bounce', 'bounce:4323372036854775807']);
  assert.deepEqual([viaRead.kind, viaRead.key], [viaWebhook.kind, viaWebhook.key]);
  // The final mapping (S-7): Transient is never counted; Blocked and SpamNotification only ever slow a business down.
  const table: [string, string | null][] = [['Blocked', 'blocked'], ['SpamNotification', 'blocked'], ['Transient', null], ['DMARCPolicy', 'soft_bounce'],
    ['SoftBounce', 'soft_bounce'], ['DnsError', 'soft_bounce'], ['Unknown', 'soft_bounce'], ['BadEmailAddress', 'hard_bounce'], ['ChallengeVerification', null], ['AutoResponder', null],
    ['AddressChange', null], ['VirusNotification', null], ['SMTPApiError', null]];
  for (const [Type, kind] of table) {
    assert.equal(postmarkCounterKind(Type, false), kind, Type);
    assert.equal(readPostmarkCounter({ ...b, Type })?.kind ?? null, kind, `webhook ${Type}`);
    assert.equal(readPostmarkCounterRow({ ...b, Type }, 'broadcast')?.kind ?? null, kind, `hourly read ${Type}`);
  }
  assert.equal(postmarkCounterKind('AutoResponder', true), 'hard_bounce', 'anything Postmark switched off counts as hard');
  for (const Type of ['Blocked', 'SpamNotification', 'SoftBounce', 'Transient', 'DnsError']) assert.equal(postmarkCounterKind(Type, true), 'hard_bounce', `${Type} switched off`);
  assert.equal(postmarkCounterKind('Unsubscribe', true), 'unsubscribe', 'an unsubscribe stays an unsubscribe');
  // An unsubscribe as a Bounce record and as a SubscriptionChange: one key.
  const u1 = readPostmarkCounter({ ...b, Type: 'Unsubscribe', Inactive: true })!;
  const u2 = readPostmarkCounter({ RecordType: 'SubscriptionChange', Recipient: 'x@pp-send-proof.co.uk', ChangedAt: '2026-11-14T10:00:00Z', MessageStream: 'broadcast', ServerID: 5151,
    SuppressSending: true, SuppressionReason: 'ManualSuppression' })!;
  assert.deepEqual([u1.kind, u2.kind, u1.key === u2.key], ['unsubscribe', 'unsubscribe', true]);
  assert.equal(readPostmarkCounterRow({ ...b, Type: 'Unsubscribe', Inactive: true }, 'broadcast')!.key, u1.key);
  // Our own reactivation reads as a resubscribe with its Origin kept.
  const re = readPostmarkWebhook({ RecordType: 'SubscriptionChange', Recipient: 'x@pp-send-proof.co.uk', ChangedAt: '2026-11-14T10:00:00Z', MessageStream: 'broadcast', ServerID: 5151,
    SuppressSending: false, Origin: 'Customer' }) as { event: { kind: string; origin: string } };
  assert.deepEqual([re.event.kind, re.event.origin], ['resubscribed', 'Customer']);
});

test('the hourly read counts a stored connection\'s rows under the same keys the webhook uses; a configured source is not counted', async () => {
  const counted: string[] = [];
  const raw = [{ ID: 42, Type: 'HardBounce', Email: 'a@pp-send-proof.co.uk', BouncedAt: '2026-11-12T09:55:00Z', Inactive: false },
    { ID: 43, Type: 'Transient', Email: 'b@pp-send-proof.co.uk', BouncedAt: '2026-11-12T09:56:00Z', Inactive: false },
    { ID: 45, Type: 'SpamComplaint', Email: 'c@pp-send-proof.co.uk', BouncedAt: '2026-11-12T09:57:00Z', Inactive: true }];
  const api = { suppressions: async () => [], totals: async () => ({ sent: null, bounced: null, complaints: null }),
    bounces: async () => ({ total: 3, received: 3, rows: [], counted: raw.map(row => readPostmarkCounterRow(row, 'broadcast')).filter(row => row !== null) }) };
  const source = (connection: boolean): EmailBounceSource => ({ key: connection ? CONN : 'pp', workspaceId: PP, token: 't', webhookSecret: 's', serverId: '1', streams: new Map([['broadcast', 'marketing']]), connection });
  const counter = async (input: { kind: string; key: string }) => { counted.push(`${input.kind}:${input.key}`); };
  await sweepPostmarkSource({ source: source(true), api, registry: new EmailBlockRegistry(), now: Date.now(), counter });
  await sweepPostmarkSource({ source: source(false), api, registry: new EmailBlockRegistry(), now: Date.now(), counter });
  assert.deepEqual(counted, ['hard_bounce:bounce:42', 'complaint:bounce:45'], 'a Transient is not counted');
});

test('Postmark\'s side of "This address works now": read first, delete only a HardBounce suppression, never an unsubscribe or a spam report', async () => {
  const calls: { method: string; url: string; token: string }[] = [];
  let reason: string | null = 'HardBounce', deleteStatus = 'Deleted';
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ method: init.method!, url, token: (init.headers as Record<string, string>)['X-Postmark-Server-Token']! });
    if (url.includes('/down/')) throw new TypeError('network');
    if (init.method === 'GET') {
      const email = new URL(url).searchParams.get('EmailAddress')!;
      return new Response(JSON.stringify({ Suppressions: reason ? [{ EmailAddress: email, SuppressionReason: reason, Origin: 'Recipient', CreatedAt: '2026-11-01T00:00:00Z' }] : [] }), { status: 200 });
    }
    const body = JSON.parse(String(init.body)) as { Suppressions: { EmailAddress: string }[] };
    return new Response(JSON.stringify({ Suppressions: body.Suppressions.map(s => ({ EmailAddress: s.EmailAddress, Status: deleteStatus, Message: null })) }), { status: 200 });
  }) as unknown as typeof fetch;
  assert.equal(await readPostmarkSuppression({ token: 'srv', stream: 'broadcast', email: ' Gone@X.co.uk ', fetcher }), 'HardBounce');
  assert.equal(calls[0]!.url, 'https://api.postmarkapp.com/message-streams/broadcast/suppressions/dump?EmailAddress=gone%40x.co.uk');
  const result = await deletePostmarkSuppressions({ token: 'srv', stream: 'broadcast', emails: [' Gone@X.co.uk '], fetcher });
  assert.deepEqual([...result], [['gone@x.co.uk', 'deleted']]);
  await assert.rejects(deletePostmarkSuppressions({ token: 'srv', stream: 'Bad Stream', emails: ['a@b.co'], fetcher }));
  // The environment-configured Martin Howard Property path (its marketing and service streams, its own token) ...
  const mhp = new EmailBounceService({ config: { sources: [{ key: 'mhp', workspaceId: MHP, token: 'mhp-server-token', webhookSecret: 's', serverId: null,
    streams: new Map([['broadcast', 'marketing'], ['outbound', 'service']]) }], blockers: [] }, suppressionFetch: fetcher });
  calls.length = 0;
  assert.equal(await mhp.reactivateAtProvider(MHP, 'gone@x.co.uk'), 'deleted');
  assert.deepEqual(calls.map(c => [c.method, c.url.split('/')[4], c.token]), [['GET', 'broadcast', 'mhp-server-token'], ['POST', 'broadcast', 'mhp-server-token'],
    ['GET', 'outbound', 'mhp-server-token'], ['POST', 'outbound', 'mhp-server-token']]);
  // An unsubscribe or a spam report at Postmark is never deleted (it would re-subscribe the person).
  for (const kept of ['ManualSuppression', 'SpamComplaint']) {
    reason = kept; calls.length = 0;
    assert.equal(await mhp.reactivateAtProvider(MHP, 'leave@x.co.uk'), 'failed', kept);
    assert.ok(calls.every(c => c.method === 'GET'), `${kept}: nothing deleted`);
  }
  // Not suppressed anywhere: nothing to do, and nothing repeated.
  reason = null; calls.length = 0;
  assert.equal(await mhp.reactivateAtProvider(MHP, 'fine@x.co.uk'), 'not_bounced');
  assert.ok(calls.every(c => c.method === 'GET'));
  // ... and a stored connection (its own server token), alongside PP's environment server.
  reason = 'HardBounce';
  const pp = new EmailBounceService({ config: { sources: [{ key: 'pp', workspaceId: PP, token: 'pp-env-token', webhookSecret: 's', serverId: null, streams: new Map([['broadcast', 'marketing']]) }], blockers: [] }, suppressionFetch: fetcher });
  pp.upsertSource({ key: CONN, workspaceId: PP, token: 'conn-server-token', webhookSecret: CONN_SECRET, serverId: '5151', streams: new Map([['broadcast', 'marketing']]), connection: true });
  calls.length = 0;
  assert.equal(await pp.reactivateAtProvider(PP, 'gone@x.co.uk'), 'deleted');
  assert.deepEqual([...new Set(calls.map(c => c.token))].sort(), ['conn-server-token', 'pp-env-token']);
  deleteStatus = 'Failed';
  assert.equal(await pp.reactivateAtProvider(PP, 'gone@x.co.uk'), 'failed');
  assert.equal(await new EmailBounceService({ config: { sources: [], blockers: [] } }).reactivateAtProvider(PP, 'a@b.co'), 'none');
  const down = new EmailBounceService({ config: { sources: [{ key: 'mhp', workspaceId: MHP, token: 't', webhookSecret: 's', serverId: null, streams: new Map([['down', 'marketing']]) }], blockers: [] }, suppressionFetch: fetcher });
  assert.equal(await down.reactivateAtProvider(MHP, 'a@b.co'), 'unavailable');
});

test('the reactivation our own delete causes is not the person re-subscribing: matched to our delete (same stream, within minutes), whatever its Origin; a later one is', async () => {
  const lifts: string[] = [];
  let cleared: number | undefined;
  const T = Date.parse('2026-11-14T10:00:00Z');
  const ledger = { covers: () => true, status: () => 'available', record: async () => 'recorded', recordList: async () => null, rows: async () => null,
    decide: async () => ({ blocked: false, reallowed: false, cleared: cleared === undefined ? {} : { hard_bounce: cleared } }),
    lift: async (input: { email: string }) => { lifts.push(input.email); return 1; } } as never;
  const fetcher = (async (url: string, init: RequestInit) => {
    if (init.method === 'GET') return new Response(JSON.stringify({ Suppressions: [{ EmailAddress: new URL(url).searchParams.get('EmailAddress'), SuppressionReason: 'HardBounce', Origin: 'Recipient', CreatedAt: '2026-11-01T00:00:00Z' }] }), { status: 200 });
    const body = JSON.parse(String(init.body)) as { Suppressions: { EmailAddress: string }[] };
    return new Response(JSON.stringify({ Suppressions: body.Suppressions.map(x => ({ EmailAddress: x.EmailAddress, Status: 'Deleted', Message: null })) }), { status: 200 });
  }) as unknown as typeof fetch;
  let now = T;
  const make = (token: string | null, streams: string[]) => {
    const service = new EmailBounceService({ config: { sources: [], blockers: [] }, ledger, now: () => now, suppressionFetch: fetcher });
    service.upsertSource({ key: CONN, workspaceId: PP, token, webhookSecret: CONN_SECRET, serverId: '5151', streams: new Map(streams.map(x => [x, 'marketing'] as const)), connection: true });
    const webhook = createPostmarkBounceWebhook({ service, now: () => now });
    const post = async (body: unknown) => {
      const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: 'POST', url: `/api/provider-webhooks/postmark/${CONN}`,
        headers: { 'content-type': 'application/json', authorization: basic(CONN, CONN_SECRET) }, socket: { remoteAddress: '10.0.0.2' } }) as unknown as IncomingMessage;
      let status = 0;
      const res = { writeHead(code: number) { status = code; }, end() {} } as unknown as ServerResponse;
      await webhook.handle(req, res, new URL(req.url!, 'https://app.example.test'));
      return status;
    };
    return { service, post };
  };
  const change = (origin: string, at: string, n: number, stream = 'broadcast') => ({ RecordType: 'SubscriptionChange', MessageStream: stream, Recipient: `p${n}@pp-send-proof.co.uk`, ChangedAt: at,
    SuppressSending: false, Origin: origin, ServerID: 5151 });
  // Another instance asked Postmark (the owner's lift is in the ledger; this source holds the token).
  const other = make('srv', ['broadcast']);
  cleared = T;
  await other.post(change('Customer', '2026-11-14T10:00:05Z', 1));
  assert.deepEqual(lifts, [], 'seconds after the owner lifted the bounce: our own delete, no unsubscribe is lifted');
  await other.post(change('Recipient', '2026-11-14T10:00:06Z', 2));
  assert.deepEqual(lifts, [], 'within the minutes after our delete it is read as ours whatever Origin says (failing closed: nothing is lifted)');
  await other.post(change('Recipient', '2026-11-14T10:20:00Z', 3));
  assert.deepEqual(lifts, ['p3@pp-send-proof.co.uk'], '20 minutes later, by the recipient: not ours');
  // The owner pressed, Postmark could not be reached; a second press hours later deletes it, and a fresh process (no
  // mark of our own delete) handles Postmark's reactivation: not the recipient, within 24 hours of the lift: ours.
  const fresh = make('srv', ['broadcast']);
  await fresh.post(change('Customer', '2026-11-14T13:00:00Z', 8));
  assert.deepEqual(lifts, ['p3@pp-send-proof.co.uk'], 'the durable unsubscribe is NOT lifted');
  await fresh.post(change('Customer', '2026-11-15T10:01:01Z', 9));
  assert.deepEqual(lifts, ['p3@pp-send-proof.co.uk', 'p9@pp-send-proof.co.uk'], 'more than 24 hours after the lift: not ours');
  cleared = undefined;
  await other.post(change('Admin', '2026-11-14T10:00:05Z', 4));
  assert.equal(lifts.length, 3, 'no owner lift recorded: as before');
  // A source we hold no token for could never have been asked by us: the ledger alone does not make it ours.
  cleared = T;
  await make(null, ['broadcast']).post(change('Customer', '2026-11-14T10:00:05Z', 5));
  assert.equal(lifts.length, 4, 'no token: not our delete');
  // This process asked Postmark itself: matched on the same stream only.
  cleared = undefined;
  const own = make('srv', ['broadcast', 'other']);
  now = T;
  assert.equal(await own.service.reactivateAtProvider(PP, 'p6@pp-send-proof.co.uk'), 'deleted');
  await own.post(change('Customer', '2026-11-14T10:00:03Z', 6));
  assert.equal(lifts.length, 4, 'our own delete, same stream');
  assert.equal(own.service.ownDeleteNear(PP, 'broadcast', 'p6@pp-send-proof.co.uk', Date.parse('2026-11-14T10:00:03Z')), true);
  assert.equal(own.service.ownDeleteNear(PP, 'elsewhere', 'p6@pp-send-proof.co.uk', Date.parse('2026-11-14T10:00:03Z')), false, 'another stream is not ours');
  assert.equal(own.service.ownDeleteNear(PP, 'broadcast', 'p6@pp-send-proof.co.uk', Date.parse('2026-11-14T10:30:00Z')), false, 'half an hour later is not ours');
  // A ledger that cannot be read: 503 (Postmark retries), nothing lifted.
  let brokenLifts = 0;
  const broken = new EmailBounceService({ config: { sources: [], blockers: [] }, now: () => now,
    ledger: { covers: () => true, status: () => 'available', decide: async () => { throw new Error('down'); }, lift: async () => { brokenLifts++; return 1; } } as never });
  broken.upsertSource({ key: CONN, workspaceId: PP, token: 'srv', webhookSecret: CONN_SECRET, serverId: '5151', streams: new Map([['broadcast', 'marketing']]), connection: true });
  const hook = createPostmarkBounceWebhook({ service: broken, now: () => now });
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(change('Customer', '2026-11-14T10:00:05Z', 7)))]), { method: 'POST', url: `/api/provider-webhooks/postmark/${CONN}`,
    headers: { 'content-type': 'application/json', authorization: basic(CONN, CONN_SECRET) }, socket: { remoteAddress: '10.0.0.3' } }) as unknown as IncomingMessage;
  let code = 0;
  await hook.handle(req, { writeHead(c: number) { code = c; }, end() {} } as unknown as ServerResponse, new URL(req.url!, 'https://app.example.test'));
  assert.equal(code, 503);
  assert.equal(brokenLifts, 0);
});

test('Martin Howard Property\'s "This address works now" asks Postmark too and says truthfully what it answered', async () => {
  const reactivated: string[] = [];
  const health = new MhpEmailHealth({ bounces: { ownerLiftHardBounce: async () => ({ lifted: 1, released: 0, spamComplaint: false, alreadyLifted: false }), refreshLedger: async () => undefined,
    reactivateAtProvider: async (_ws: string, email: string) => { reactivated.push(email); return 'deleted' as const; } } as never, growth: {} as never });
  assert.deepEqual(await health.lift('tok', 'Gone@x.co.uk'), { email: 'gone@x.co.uk', outcome: 'lifted', provider: 'deleted' });
  assert.deepEqual(reactivated, ['gone@x.co.uk']);
  const snapshot = { workspaceId: MHP, ready: true, blocked: [], streams: [], window: { days: 30, sent: 0, bounced: 0, complaints: 0, bounceRate: null, complaintRate: null },
    month: { bounced: 0, complained: 0, unsubscribed: 0 }, lastCheckedAt: null, incomplete: false } as never;
  const say = (provider: 'deleted' | 'failed' | 'unavailable' | 'none') => emailHealthPage(snapshot, 'c', undefined, { durable: true, lift: { email: 'gone@x.co.uk', outcome: 'lifted', provider } });
  assert.match(say('deleted'), /We no longer block gone@x\.co\.uk for that bounce\. Postmark has reactivated it too\./u);
  assert.match(say('failed'), /Postmark kept it on its own list, so Postmark still refuses it\./u);
  assert.match(say('unavailable'), /Postmark could not be reached to reactivate it; press the button again in a minute\./u);
  const spam = new MhpEmailHealth({ bounces: { ownerLiftHardBounce: async () => ({ lifted: 0, released: 0, spamComplaint: true, alreadyLifted: false }), refreshLedger: async () => undefined,
    reactivateAtProvider: async () => { throw new Error('never asked'); } } as never, growth: {} as never });
  assert.deepEqual(await spam.lift('tok', 'spam@x.co.uk'), { email: 'spam@x.co.uk', outcome: 'spam' });
});

test('Group HQ emailProtectionStatus: read only, checked like every other action, this brand\'s lines and the account hold, nothing when all is well', async () => {
  const SCOPE = { label: 'PP', workspaceId: PP, organizationId: '0b156000-0000-4000-8000-0000000000aa', ownerUserId: '0b156000-0000-4000-8000-0000000000bb',
    pipelineId: '0b156000-0000-4000-8000-0000000000cc', stageId: '0b156000-0000-4000-8000-0000000000dd', actorEmails: ['owner@pp-send-proof.co.uk'] };
  const INBOX = { secret: 's'.repeat(40), scopes: { pp: SCOPE } };
  const readPool = (allowed = true) => ({ connect: async () => ({ query: async (sql: string) => ({ rows: sql.includes('group-hq.inbox.scope') ? [{ allowed }] : [], rowCount: 1 }), release() {} }) }) as unknown as Pick<Pool, 'connect'>;
  let writes = 0;
  const runner: CrmTransactionRunner = { async run() { writes++; throw new Error('no CRM transaction expected'); } };
  const request = { action: 'emailProtectionStatus', actorEmail: 'owner@pp-send-proof.co.uk', brand: 'pp', requestId: '0b156000-0000-4000-8000-0000000000ee' };
  const off = await new GroupHqInboxCrmService(readPool(), runner, INBOX).execute(request) as Record<string, unknown>;
  assert.deepEqual([off.available, off.needsYou, off.sentences], [false, false, []]);
  const store = new MemoryProtectionStore(counts());
  const protection = new EmailProtectionService({ store, portalOrigin: 'https://hq.propertypredator.com' });
  const service = new GroupHqInboxCrmService(readPool(), runner, INBOX, { emailProtection: protection });
  const quiet = await service.execute(request) as Record<string, unknown>;
  assert.deepEqual([quiet.available, quiet.needsYou, quiet.sentences, quiet.summary], [true, false, [], 'Email sending needs nothing from you.']);
  store.counts = { ...store.counts, state: 'paused' };
  store.events.push({ kind: 'paused', numbers: { line: 'bounce_rate', count: 6, total: 120, limit: 4, days: 7 }, actor: null, at: Date.now() });
  const red = await service.execute(request) as { needsYou: boolean; sentences: string[]; items: { tone: string; sentence: string; button: { label: string; url: string } }[] };
  assert.equal(red.needsYou, true);
  assert.deepEqual(red.sentences, ['Emails paused for Property Predator Ltd. 6 of their last 120 emails bounced (5%, last 7 days). Our line is 4%, Postmark\'s is 10%. Sign-in and booking emails still go. Nobody else is affected.']);
  assert.deepEqual(red.items[0]!.button, { label: 'Review and decide', url: 'https://hq.propertypredator.com/portal/email/founder' });
  await assert.rejects(service.execute({ ...request, actorEmail: 'stranger@x.co.uk' }), (e: unknown) => e instanceof InboxCrmError && e.status === 403);
  await assert.rejects(new GroupHqInboxCrmService(readPool(false), runner, INBOX, { emailProtection: protection }).execute(request), (e: unknown) => e instanceof InboxCrmError && e.status === 403);
  assert.equal(writes, 0);
  assert.ok(!JSON.stringify(red).includes('@'), 'no address in the founder\'s lines');
});
