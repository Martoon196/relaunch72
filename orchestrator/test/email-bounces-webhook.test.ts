import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  createPostmarkBounceWebhook, EmailBounceService, POSTMARK_BOUNCE_WEBHOOK_MAX_BODY_BYTES, type EmailBounceSource,
} from '../src/email-bounces/index.js';
import { createApp, type AppDeps } from '../src/server/app.js';

const MHP = '2789228d-55a6-4688-b1e8-2f70abca990b', PP = 'd975ff66-336a-46c2-b36b-d7095a11af97';
const MHP_SECRET = 'mhp-webhook-secret-synthetic-0123456789', PP_SECRET = 'pp-webhook-secret-synthetic-9876543210';
const NOW = Date.parse('2026-11-12T10:00:00Z');
const PROSPECT = '0b5a3d52-3c6a-4f43-9c0e-0123456789ab';
const sources: EmailBounceSource[] = [
  { key: 'mhp', workspaceId: MHP, token: null, webhookSecret: MHP_SECRET, serverId: null, streams: new Map([['broadcast', 'marketing'], ['outbound', 'service']]) },
  { key: 'pp', workspaceId: PP, token: null, webhookSecret: PP_SECRET, serverId: '777', streams: new Map([['broadcast', 'marketing']]) },
  { key: 'closed', workspaceId: PP, token: null, webhookSecret: null, serverId: null, streams: new Map([['broadcast', 'marketing']]) },
];
const basic = (user: string, password: string): string => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;

function fixture(options: { requestsPerMinute?: number; failedAuthPerMinute?: number } = {}) {
  let now = NOW;
  const service = new EmailBounceService({ config: { sources, blockers: [] }, now: () => now });
  const effects: { workspace: string; email: string; reason: string; prospect?: string }[] = [];
  const state = { failEffect: false };
  for (const workspace of [MHP, PP]) service.setEffects(workspace, { onMarketingBlock: async ({ email, reason, metadata }) => {
    if (state.failEffect) throw new Error('database unavailable');
    effects.push({ workspace, email, reason, ...(metadata.prospect ? { prospect: metadata.prospect } : {}) });
  } });
  const logs: string[] = [];
  const webhook = createPostmarkBounceWebhook({ service, now: () => now, log: line => logs.push(line), ...options });
  async function post(key: string, body: unknown, headers: Record<string, string> = {}, method = 'POST', ip = '203.0.113.9') {
    const raw = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    const captured = { status: 0, body: {} as Record<string, unknown>, headers: {} as Record<string, string>, drained: false };
    const stream = Readable.from([Buffer.from(raw)]);
    const req = Object.assign(stream, { method, url: `/api/provider-webhooks/postmark/${key}`,
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip, ...headers }, socket: { remoteAddress: '10.0.0.1' } }) as unknown as IncomingMessage;
    const res = { headersSent: false, writeHead(status: number, h: Record<string, string> = {}) { captured.status = status; Object.assign(captured.headers, h); },
      end(text = '') { captured.body = text ? JSON.parse(text) : {}; } } as unknown as ServerResponse;
    const handled = await webhook.handle(req, res, new URL(req.url!, 'https://app.example.test'));
    return { ...captured, handled };
  }
  const auth = { authorization: basic('mhp', MHP_SECRET) };
  return { service, effects, logs, state, post, auth, advance: (ms: number) => { now += ms; } };
}
const bounce = (over: Record<string, unknown> = {}) => ({ RecordType: 'Bounce', MessageStream: 'broadcast', ID: 42, Type: 'HardBounce', TypeCode: 1, Email: 'gone@example.invalid',
  BouncedAt: '2026-11-12T09:55:00Z', Inactive: true, ServerID: 23, Metadata: { send: 'send-1', prospect: PROSPECT }, ...over });

test('webhook is never open: no secret, a wrong secret, another brand\'s secret and an unconfigured source are all refused before the body is read', async () => {
  const f = fixture();
  const none = await f.post('mhp', bounce());
  assert.equal(none.status, 401); assert.match(none.headers['www-authenticate']!, /^Basic/u);
  assert.equal((await f.post('mhp', bounce(), { authorization: basic('mhp', 'x'.repeat(40)) })).status, 401);
  assert.equal((await f.post('mhp', bounce(), { authorization: basic('mhp', PP_SECRET) })).status, 401, 'another workspace\'s secret does not open this one');
  assert.equal((await f.post('pp', bounce(), { authorization: basic('mhp', MHP_SECRET) })).status, 401, 'nor the other way round');
  assert.equal((await f.post('mhp', bounce(), { authorization: basic('someone', MHP_SECRET) })).status, 401, 'the user name is the source key');
  assert.equal((await f.post('mhp', bounce(), { authorization: `Bearer ${MHP_SECRET}` })).status, 401);
  assert.equal((await f.post('mhp', bounce(), { 'x-postmark-webhook-secret': 'nope' })).status, 401);
  const closed = await f.post('closed', bounce(), { authorization: basic('closed', '') });
  assert.equal(closed.status, 503); assert.equal(closed.body.error, 'webhook_not_configured');
  assert.equal((await f.post('unknown', bounce(), f.auth)).status, 404);
  assert.equal((await f.post('mhp', bounce(), f.auth, 'GET')).status, 405);
  assert.equal(f.service.registry.snapshot(MHP).blocked.length, 0); assert.deepEqual(f.effects, []);
});

test('a hard bounce blocks the exact address in the sending workspace, stops that person, and the same event twice changes nothing', async () => {
  const f = fixture();
  const first = await f.post('mhp', bounce(), f.auth);
  assert.deepEqual([first.status, first.body], [200, { received: true, outcome: 'hard_bounce', replayed: false, blocked: true }]);
  assert.equal(first.headers['cache-control'], 'no-store');
  assert.deepEqual(f.service.registry.decide(MHP, 'gone@example.invalid', 'marketing'), { blocked: true, reason: 'hard_bounce' });
  assert.deepEqual(f.service.registry.decide(MHP, 'gone@example.invalid', 'service'), { blocked: true, reason: 'hard_bounce' });
  assert.equal(f.service.registry.decide(PP, 'gone@example.invalid', 'marketing').blocked, false, 'only the sending workspace');
  assert.equal(f.service.registry.decide(MHP, 'other@example.invalid', 'marketing').blocked, false, 'only the exact address');
  assert.deepEqual(f.effects, [{ workspace: MHP, email: 'gone@example.invalid', reason: 'hard_bounce', prospect: PROSPECT }]);
  const again = await f.post('mhp', bounce(), { 'x-postmark-webhook-secret': MHP_SECRET });
  assert.deepEqual([again.status, again.body.replayed], [200, true]);
  assert.equal(f.effects.length, 1, 'idempotent on Postmark\'s event ID');
  assert.equal(f.service.registry.snapshot(MHP).month.bounced, 1);
  assert.doesNotMatch(f.logs.join('\n'), /example\.invalid/u, 'no address reaches the log');
});

test('a spam complaint blocks every marketing purpose for that address but not an event email the person asked for', async () => {
  const f = fixture();
  const result = await f.post('mhp', bounce({ RecordType: 'SpamComplaint', Type: 'SpamComplaint', TypeCode: 100001, ID: 43, MessageStream: 'outbound', Email: 'cross@example.invalid', CanActivate: false }), f.auth);
  assert.deepEqual([result.status, result.body.outcome, result.body.blocked], [200, 'spam_complaint', true]);
  assert.deepEqual(f.service.registry.decide(MHP, 'cross@example.invalid', 'marketing'), { blocked: true, reason: 'spam_complaint' });
  assert.equal(f.service.registry.decide(MHP, 'cross@example.invalid', 'service').blocked, false);
  assert.equal(f.effects[0]?.reason, 'spam_complaint');
  assert.equal(f.service.registry.snapshot(MHP).month.complained, 1);
});

test('soft bounces are counted and only the third inside 30 days blocks; unrelated record types are acknowledged and ignored', async () => {
  const f = fixture();
  const soft = (id: number) => f.post('mhp', bounce({ ID: id, Type: 'SoftBounce', TypeCode: 4096, Inactive: false, Email: 'full@example.invalid' }), f.auth);
  assert.deepEqual([(await soft(1)).body.blocked, (await soft(2)).body.blocked], [false, false]);
  assert.equal((await soft(2)).body.replayed, true);
  assert.equal(f.service.registry.decide(MHP, 'full@example.invalid', 'marketing').blocked, false); assert.equal(f.effects.length, 0);
  assert.equal((await soft(3)).body.blocked, true);
  assert.deepEqual(f.service.registry.decide(MHP, 'full@example.invalid', 'marketing'), { blocked: true, reason: 'repeated_soft_bounce' });
  assert.deepEqual(f.effects.map(effect => effect.reason), ['repeated_soft_bounce']);
  assert.deepEqual((await f.post('mhp', bounce({ ID: 9, Type: 'Transient', Inactive: false }), f.auth)).body, { received: true, outcome: 'ignored' });
  assert.deepEqual((await f.post('mhp', { RecordType: 'Delivery', MessageStream: 'broadcast', Recipient: 'ok@example.invalid' }, f.auth)).body, { received: true, outcome: 'ignored' });
  assert.deepEqual((await f.post('mhp', { RecordType: 'Open', MessageStream: 'broadcast' }, f.auth)).body, { received: true, outcome: 'ignored' });
});

test('an unsubscribe through Postmark\'s own link blocks marketing; a later re-subscribe there lifts only that block', async () => {
  const f = fixture();
  const change = (over: Record<string, unknown>) => f.post('mhp', { RecordType: 'SubscriptionChange', MessageID: '883953f4-6105-42a2-a16a-77a8eac79483', ServerID: 23, MessageStream: 'broadcast',
    ChangedAt: '2026-11-12T09:00:00Z', Recipient: 'left@example.invalid', Origin: 'Recipient', SuppressSending: true, SuppressionReason: 'ManualSuppression', Metadata: { prospect: PROSPECT }, ...over }, f.auth);
  const off = await change({});
  assert.deepEqual([off.status, off.body.outcome, off.body.blocked], [200, 'unsubscribed', true]);
  assert.deepEqual(f.service.registry.decide(MHP, 'left@example.invalid', 'marketing'), { blocked: true, reason: 'unsubscribed' });
  assert.equal(f.service.registry.decide(MHP, 'left@example.invalid', 'service').blocked, false);
  assert.deepEqual(f.effects, [{ workspace: MHP, email: 'left@example.invalid', reason: 'unsubscribed', prospect: PROSPECT }]);
  assert.equal((await change({})).body.replayed, true);
  const on = await change({ SuppressSending: false, SuppressionReason: null, ChangedAt: '2026-11-12T09:30:00Z' });
  assert.deepEqual([on.status, on.body.outcome], [200, 'resubscribed']);
  assert.equal(f.service.registry.decide(MHP, 'left@example.invalid', 'marketing').blocked, false);
  assert.equal(f.effects.length, 1, 'permission is never granted from a provider event');
  const hard = await change({ SuppressionReason: 'HardBounce', Recipient: 'dead@example.invalid' });
  assert.equal(hard.body.outcome, 'hard_bounce'); assert.equal(f.service.registry.decide(MHP, 'dead@example.invalid', 'service').blocked, true);
  await f.post('mhp', bounce({ ID: 77, Email: 'dead@example.invalid' }), f.auth);
  const totals = f.service.registry.snapshot(MHP);
  assert.deepEqual([totals.month.bounced, totals.window.bounced], [1, 1], 'Postmark sends both records for one bounce; it is counted once');
});

test('wrong workspace: an event from another Postmark server or an unmanaged stream is never applied', async () => {
  const f = fixture();
  const ppAuth = { authorization: basic('pp', PP_SECRET) };
  const foreign = await f.post('pp', bounce({ ServerID: 23 }), ppAuth);
  assert.deepEqual([foreign.status, foreign.body], [403, { error: 'wrong_server' }]);
  assert.equal(f.service.registry.decide(PP, 'gone@example.invalid', 'marketing').blocked, false);
  const own = await f.post('pp', bounce({ ServerID: 777 }), ppAuth);
  assert.equal(own.body.blocked, true); assert.equal(f.effects[0]?.workspace, PP);
  assert.equal(f.service.registry.decide(MHP, 'gone@example.invalid', 'marketing').blocked, false, 'the other workspace is untouched');
  const stream = await f.post('pp', bounce({ ServerID: 777, ID: 50, MessageStream: 'outbound', Email: 'else@example.invalid' }), ppAuth);
  assert.deepEqual(stream.body, { received: true, outcome: 'ignored_stream' });
  assert.equal(f.service.registry.decide(PP, 'else@example.invalid', 'marketing').blocked, false);
});

test('body rules: oversized, non-JSON and malformed events are refused and change nothing', async () => {
  const f = fixture();
  const huge = JSON.stringify(bounce({ Content: 'x'.repeat(POSTMARK_BOUNCE_WEBHOOK_MAX_BODY_BYTES) }));
  assert.equal((await f.post('mhp', huge, f.auth)).status, 413);
  assert.equal((await f.post('mhp', huge, { ...f.auth, 'content-length': String(Buffer.byteLength(huge)) })).status, 413);
  assert.equal((await f.post('mhp', '{not json', f.auth)).status, 400);
  assert.equal((await f.post('mhp', bounce(), { ...f.auth, 'content-type': 'text/plain' })).status, 415);
  assert.deepEqual((await f.post('mhp', bounce({ Email: 'no-at-sign' }), f.auth)).body, { error: 'invalid_event' });
  assert.deepEqual((await f.post('mhp', bounce({ BouncedAt: 'yesterday' }), f.auth)).body, { error: 'invalid_event' });
  assert.deepEqual((await f.post('mhp', [], f.auth)).body, { error: 'invalid_event' });
  assert.equal(f.service.registry.snapshot(MHP).blocked.length, 0); assert.deepEqual(f.effects, []);
  const nearLimit = await f.post('mhp', bounce({ Content: 'x'.repeat(200_000) }), f.auth);
  assert.equal(nearLimit.status, 200, 'a real bounce with its dump attached still fits');
});

test('rate limits: a flood from one caller and repeated wrong secrets are slowed, without locking out the real sender', async () => {
  const f = fixture({ requestsPerMinute: 3, failedAuthPerMinute: 2 });
  for (let i = 0; i < 2; i++) assert.equal((await f.post('mhp', bounce(), {}, 'POST', '198.51.100.7')).status, 401);
  assert.equal((await f.post('mhp', bounce(), {}, 'POST', '198.51.100.7')).status, 429, 'guessing is slowed');
  assert.equal((await f.post('mhp', bounce(), f.auth)).status, 200, 'Postmark, with the right secret, is not locked out by someone else');
  assert.equal((await f.post('mhp', bounce({ ID: 2, Email: 'b@example.invalid' }), f.auth)).status, 200);
  assert.equal((await f.post('mhp', bounce({ ID: 3, Email: 'c@example.invalid' }), f.auth)).status, 200);
  const limited = await f.post('mhp', bounce({ ID: 4, Email: 'd@example.invalid' }), f.auth);
  assert.deepEqual([limited.status, limited.headers['retry-after']], [429, '60']);
  assert.equal(f.service.registry.decide(MHP, 'd@example.invalid', 'marketing').blocked, false);
  f.advance(61_000);
  assert.equal((await f.post('mhp', bounce({ ID: 4, Email: 'd@example.invalid' }), f.auth)).status, 200, 'Postmark\'s retry lands after the window');
});

test('when the lasting stop fails the event is not remembered, so Postmark\'s retry completes it; the address is already refused meanwhile', async () => {
  const f = fixture();
  f.state.failEffect = true;
  const failed = await f.post('mhp', bounce(), f.auth);
  assert.deepEqual([failed.status, failed.headers['retry-after']], [503, '60']);
  assert.equal(f.service.registry.decide(MHP, 'gone@example.invalid', 'marketing').blocked, true);
  f.state.failEffect = false;
  const retried = await f.post('mhp', bounce(), f.auth);
  assert.deepEqual([retried.status, retried.body.replayed], [200, false]);
  assert.deepEqual(f.effects.map(e => e.prospect), [PROSPECT]);
});

test('the server answers the webhook on the canonical host and on the brand host, before brand routing, and nowhere else', async () => {
  const f = fixture();
  let mhpHandled = 0;
  const webhook = createPostmarkBounceWebhook({ service: f.service, now: () => NOW });
  const app = createApp({ cfg: { dataDir: '/tmp/unused', production: false } as AppDeps['cfg'], stripe: {} as AppDeps['stripe'], orders: {} as AppDeps['orders'],
    kickPipeline: () => undefined, canonicalHost: 'app.example.test', postmarkBounceWebhook: webhook,
    mhp: { hostname: 'app.martinhowardproperty.co.uk', handle: async (_req: IncomingMessage, res: ServerResponse) => { mhpHandled++; res.writeHead(404); res.end(); }, readiness: async () => [] } } as unknown as AppDeps);
  async function call(host: string, path: string) {
    const captured = { status: 0, body: '' };
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(bounce()))]), { method: 'POST', url: path,
      headers: { host, 'content-type': 'application/json', authorization: basic('mhp', MHP_SECRET) }, socket: { remoteAddress: '10.0.0.1' } }) as unknown as IncomingMessage;
    const res = { headersSent: false, setHeader() {}, writeHead(status: number) { captured.status = status; }, end(text = '') { captured.body = String(text); } } as unknown as ServerResponse;
    await app(req, res); return captured;
  }
  assert.equal((await call('app.martinhowardproperty.co.uk', '/api/provider-webhooks/postmark/mhp')).status, 200);
  assert.equal(mhpHandled, 0, 'the brand mount never saw it');
  assert.equal((await call('app.example.test', '/api/provider-webhooks/postmark/mhp')).status, 200);
  assert.equal((await call('evil.example.test', '/api/provider-webhooks/postmark/mhp')).status, 421);
  assert.equal((await call('app.martinhowardproperty.co.uk', '/api/provider-webhooks/other')).status, 404); assert.equal(mhpHandled, 1);
});
