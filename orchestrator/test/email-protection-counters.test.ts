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
import { deletePostmarkSuppressions } from '../src/email-bounces/postmark-suppressions.js';
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

test('a stored connection\'s webhook counts each Postmark event once; a configured source is never counted; a failed write is retried by Postmark', async () => {
  const f = fixture();
  assert.equal((await f.post(CONN, CONN_SECRET, bounce())).status, 200);
  assert.equal((await f.post(CONN, CONN_SECRET, bounce())).status, 200, 'a replay');
  await f.post(CONN, CONN_SECRET, bounce({ ID: 43, Type: 'SoftBounce', Inactive: false }));
  await f.post(CONN, CONN_SECRET, bounce({ ID: 44, Type: 'Transient', Inactive: false }));
  await f.post(CONN, CONN_SECRET, { RecordType: 'SpamComplaint', MessageStream: 'broadcast', ID: 45, Type: 'SpamComplaint', Email: 'cross@pp-send-proof.co.uk', BouncedAt: '2026-11-12T09:56:00Z', ServerID: 5151 });
  // The subscription change that accompanies a hard bounce is not a second bounce; an unsubscribe is counted.
  await f.post(CONN, CONN_SECRET, { RecordType: 'SubscriptionChange', MessageStream: 'broadcast', Recipient: 'gone@pp-send-proof.co.uk', ChangedAt: '2026-11-12T09:55:01Z', SuppressSending: true, SuppressionReason: 'HardBounce', ServerID: 5151 });
  await f.post(CONN, CONN_SECRET, { RecordType: 'SubscriptionChange', MessageStream: 'broadcast', Recipient: 'leave@pp-send-proof.co.uk', ChangedAt: '2026-11-12T09:57:00Z', SuppressSending: true, SuppressionReason: 'ManualSuppression', ServerID: 5151 });
  assert.deepEqual(f.counted.map(c => c.kind), ['hard_bounce', 'soft_bounce', 'complaint', 'unsubscribe'], 'Transient says nothing about the address');
  assert.deepEqual(f.counted.slice(0, 3).map(c => c.key), ['bounce:42', 'bounce:43', 'bounce:45']);
  assert.ok(f.counted.every(c => !c.key.includes('@')), 'no address in any key');
  // Postmark's set-up sample (another ServerID) is answered 200 and counted nowhere.
  await f.post(CONN, CONN_SECRET, bounce({ ID: 46, ServerID: 1 }));
  // The environment-configured source: exactly as before, nothing counted.
  assert.equal((await f.post('pp', ENV_SECRET, bounce({ ID: 47, ServerID: 777 }))).status, 200);
  assert.equal(f.counted.length, 4);
  f.setFail(true);
  assert.equal((await f.post(CONN, CONN_SECRET, bounce({ ID: 48 }))).status, 503, 'Postmark retries');
  f.setFail(false);
  assert.equal((await f.post(CONN, CONN_SECRET, bounce({ ID: 48 }))).status, 200);
  assert.deepEqual(f.counted.at(-1), { kind: 'hard_bounce', key: 'bounce:48' });
});

test('the hourly read counts a stored connection\'s bounces under the same keys the webhook uses; a configured source is not counted', async () => {
  const counted: string[] = [];
  const api = { suppressions: async () => [], totals: async () => ({ sent: null, bounced: null, complaints: null }),
    bounces: async () => ({ total: 3, received: 3, rows: [{ id: '42', kind: 'hard_bounce' as const, email: 'a@pp-send-proof.co.uk', at: 1 }, { id: '43', kind: 'soft_bounce' as const, email: 'b@pp-send-proof.co.uk', at: 2 },
      { id: '45', kind: 'spam_complaint' as const, email: 'c@pp-send-proof.co.uk', at: 3 }] }) };
  const source = (connection: boolean): EmailBounceSource => ({ key: connection ? CONN : 'pp', workspaceId: PP, token: 't', webhookSecret: 's', serverId: '1', streams: new Map([['broadcast', 'marketing']]), connection });
  const counter = async (input: { kind: string; key: string }) => { counted.push(`${input.kind}:${input.key}`); };
  await sweepPostmarkSource({ source: source(true), api, registry: new EmailBlockRegistry(), now: Date.now(), counter });
  await sweepPostmarkSource({ source: source(false), api, registry: new EmailBlockRegistry(), now: Date.now(), counter });
  assert.deepEqual(counted, ['hard_bounce:bounce:42', 'soft_bounce:bounce:43', 'complaint:bounce:45']);
});

test('Postmark\'s side of "This address works now": the suppression is deleted on every stream with each server\'s own token; spam is kept by Postmark', async () => {
  const calls: { url: string; token: string; body: unknown }[] = [];
  let answer = (email: string) => ({ EmailAddress: email, Status: 'Deleted', Message: null as string | null });
  const fetcher = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { Suppressions: { EmailAddress: string }[] };
    calls.push({ url, token: (init.headers as Record<string, string>)['X-Postmark-Server-Token']!, body });
    if (url.includes('down')) throw new TypeError('network');
    return new Response(JSON.stringify({ Suppressions: body.Suppressions.map(s => answer(s.EmailAddress)) }), { status: 200 });
  }) as unknown as typeof fetch;
  const result = await deletePostmarkSuppressions({ token: 'srv', stream: 'broadcast', emails: [' Gone@X.co.uk '], fetcher });
  assert.deepEqual([...result], [['gone@x.co.uk', 'deleted']]);
  assert.equal(calls[0]!.url, 'https://api.postmarkapp.com/message-streams/broadcast/suppressions/delete');
  assert.deepEqual(calls[0]!.body, { Suppressions: [{ EmailAddress: 'gone@x.co.uk' }] });
  await assert.rejects(deletePostmarkSuppressions({ token: 'srv', stream: 'Bad Stream', emails: ['a@b.co'], fetcher }));
  // The environment-configured Martin Howard Property path (its marketing and service streams, its own token) ...
  const mhp = new EmailBounceService({ config: { sources: [{ key: 'mhp', workspaceId: MHP, token: 'mhp-server-token', webhookSecret: 's', serverId: null,
    streams: new Map([['broadcast', 'marketing'], ['outbound', 'service']]) }], blockers: [] }, suppressionFetch: fetcher });
  calls.length = 0;
  assert.equal(await mhp.reactivateAtProvider(MHP, 'gone@x.co.uk'), 'deleted');
  assert.deepEqual(calls.map(c => [c.url.split('/')[4], c.token]), [['broadcast', 'mhp-server-token'], ['outbound', 'mhp-server-token']]);
  // ... and a stored connection (its own server token), alongside PP's environment server.
  const pp = new EmailBounceService({ config: { sources: [{ key: 'pp', workspaceId: PP, token: 'pp-env-token', webhookSecret: 's', serverId: null, streams: new Map([['broadcast', 'marketing']]) }], blockers: [] }, suppressionFetch: fetcher });
  pp.upsertSource({ key: CONN, workspaceId: PP, token: 'conn-server-token', webhookSecret: CONN_SECRET, serverId: '5151', streams: new Map([['broadcast', 'marketing']]), connection: true });
  calls.length = 0;
  assert.equal(await pp.reactivateAtProvider(PP, 'gone@x.co.uk'), 'deleted');
  assert.deepEqual(calls.map(c => c.token).sort(), ['conn-server-token', 'pp-env-token']);
  answer = email => ({ EmailAddress: email, Status: 'Failed', Message: 'You do not have the required authority to change this suppression.' });
  assert.equal(await pp.reactivateAtProvider(PP, 'spam@x.co.uk'), 'failed', 'Postmark never deletes a spam complaint');
  assert.equal(await new EmailBounceService({ config: { sources: [], blockers: [] } }).reactivateAtProvider(PP, 'a@b.co'), 'none');
  const down = new EmailBounceService({ config: { sources: [{ key: 'mhp', workspaceId: MHP, token: 't', webhookSecret: 's', serverId: null, streams: new Map([['down', 'marketing']]) }], blockers: [] }, suppressionFetch: fetcher });
  assert.equal(await down.reactivateAtProvider(MHP, 'a@b.co'), 'unavailable');
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
