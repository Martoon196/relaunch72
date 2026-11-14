/**
 * "Connect email" release 1: the Postmark account client, the vault, the switch, the domain rules, the state machine
 * (with a failure injected after every step and a second press adopting cleanly), the email rules, and the stored
 * connection as a bounce source (Postmark's set-up samples answered 200 and recorded nothing). Postmark and DNS are
 * stand-ins; nothing touches the network. Every value is synthetic.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createPostmarkBounceWebhook, EmailBounceService, loadEmailBounceConfig, type EmailBlockLedger } from '../src/email-bounces/index.js';
import {
  connectionServerName, createPostmarkAccountApi, createPostmarkServerApi, dnsHostFromNameServers, EMAIL_CONNECT_BUSINESSES, EMAIL_CONNECTION_MESSAGES, EMAIL_TERMS,
  EMAIL_TERMS_VERSION, EmailConnectionBounceSources, EmailConnectionError, EmailConnectionService, EmailConnectionVault, emailConnectionKey, freeMailboxDomain,
  loadEmailConnectConfig, lookUpCname, lookUpTxt, parseEmailAddress, PostmarkAccountError, reservedDomain, shortHost,
} from '../src/email-connections/index.js';
import { ACCOUNT_TOKEN, FakePostmark, fakeResolver, MemoryEmailConnectionStore, OWNER_SESSION, PP_WS } from './email-connections-fixtures.js';

const KEY = Buffer.alloc(32, 7).toString('base64');
const SECRET = 'whsec-synthetic-0123456789-abcdefghijklmnop';
const ORIGIN = 'https://growth.relaunch72-test.co.uk';
const ENV = { EMAIL_CONNECT: 'enabled', POSTMARK_ACCOUNT_TOKEN: ACCOUNT_TOKEN, EMAIL_CONNECTION_KEY: KEY };
const owner = { sessionToken: OWNER_SESSION, userId: '00000000-0000-4000-8000-000000000001', workspaceId: PP_WS, userEmail: 'owner@relaunch72-test.co.uk' };
const FORM = { fromName: 'Property Predator', fromAddress: 'Hello@Mail.PropertyPredator-Test.co.uk', replyTo: 'team@propertypredator-test.co.uk', agreed: true };
const DOMAIN = 'mail.propertypredator-test.co.uk';
const KEYPATH = `/api/provider-webhooks/postmark/${EMAIL_CONNECT_BUSINESSES[0]!.sourceKey}`;

// ---------- Postmark account client ----------

test('the account client sends the documented headers and fields, refuses redirects and never carries a token or Postmark text in an error', async () => {
  const postmark = new FakePostmark();
  const api = createPostmarkAccountApi({ accountToken: ACCOUNT_TOKEN, fetch: postmark.fetch });
  const server = await api.createServer({ name: 'Relaunch72 · Test · 12345678', color: 'Turquoise' });
  assert.equal(postmark.calls[0]!.header, 'account');
  assert.deepEqual(postmark.calls[0]!.body, { Name: 'Relaunch72 · Test · 12345678', Color: 'Turquoise', DeliveryType: 'Live' });
  assert.ok(server.serverToken, 'the server token is read from ApiTokens');
  assert.doesNotMatch(JSON.stringify(server), /srv-/u, 'the server token is never serialised');
  assert.doesNotMatch(inspect(server), /srv-/u, 'nor shown by util.inspect');
  assert.deepEqual((await api.listServers('Relaunch72')).map(s => s.id), [server.id]);
  assert.match(postmark.calls.at(-1)!.path, /^\/servers\?count=100&offset=0&name=Relaunch72$/u);
  assert.equal((await api.getServer(server.id)).id, server.id);
  const domain = await api.createDomain({ name: 'brand-test.co.uk', returnPathDomain: 'pm-bounces.brand-test.co.uk' });
  assert.deepEqual(postmark.calls.at(-1)!.body, { Name: 'brand-test.co.uk', ReturnPathDomain: 'pm-bounces.brand-test.co.uk' });
  assert.equal(domain.dkimHost, `${domain.id}pm._domainkey.brand-test.co.uk`, 'the pending DKIM host while new');
  assert.equal(domain.returnPathValue, 'pm.mtasv.net');
  assert.deepEqual((await api.listDomains()).map(d => d.name), ['brand-test.co.uk']);
  await api.verifyDkim(domain.id); assert.deepEqual([postmark.calls.at(-1)!.method, postmark.calls.at(-1)!.path], ['PUT', `/domains/${domain.id}/verifyDkim`]);
  await api.verifyReturnPath(domain.id); assert.equal(postmark.calls.at(-1)!.path, `/domains/${domain.id}/verifyReturnPath`);
  postmark.domains[0]!.dkimVerified = true;
  assert.equal((await api.getDomain(domain.id)).dkimVerified, true);

  const serverApi = createPostmarkServerApi({ serverToken: server.serverToken!, fetch: postmark.fetch });
  assert.deepEqual(await serverApi.listBroadcastStreams(), []);
  assert.match(postmark.calls.at(-1)!.path, /MessageStreamType=Broadcasts/u);
  await serverApi.createBroadcastStream('broadcast', 'Broadcasts');
  assert.deepEqual(postmark.calls.at(-1)!.body, { ID: 'broadcast', Name: 'Broadcasts', MessageStreamType: 'Broadcasts' });
  assert.equal(postmark.calls.at(-1)!.header, 'server');
  const hook = await serverApi.createWebhook({ url: `${ORIGIN}/hook`, stream: 'broadcast', username: 'conn-x', password: SECRET });
  assert.deepEqual(postmark.calls.at(-1)!.body, { Url: `${ORIGIN}/hook`, MessageStream: 'broadcast', HttpAuth: { Username: 'conn-x', Password: SECRET },
    Triggers: { Bounce: { Enabled: true, IncludeContent: false }, SpamComplaint: { Enabled: true, IncludeContent: false }, SubscriptionChange: { Enabled: true } } });
  assert.doesNotMatch(JSON.stringify(hook) + inspect(hook), new RegExp(SECRET), 'the webhook password is never serialised');
  assert.equal((await serverApi.listWebhooks('broadcast'))[0]!.password, SECRET, 'but can be compared');
  await serverApi.deleteWebhook(hook.id);
  assert.equal(postmark.calls.at(-1)!.method, 'DELETE');

  // Every documented error code arrives as category + status + code only.
  const codes: [number, number, string][] = [[401, 10, 'unauthorized'], [422, 603, 'rejected'], [422, 614, 'rejected'], [422, 512, 'rejected'], [422, 503, 'rejected'],
    [422, 1230, 'rejected'], [422, 1364, 'rejected'], [422, 412, 'rejected'], [422, 413, 'rejected'], [404, 0, 'not_found'], [429, 0, 'busy'], [500, 0, 'busy'], [503, 0, 'busy']];
  for (const [status, code, category] of codes) {
    postmark.failOn(() => true, status, code);
    const error = await api.listDomains().then(() => null, (e: unknown) => e);
    assert.ok(error instanceof PostmarkAccountError);
    assert.deepEqual([error.category, error.status, error.errorCode], [category, status, code]);
    assert.doesNotMatch(`${error.message} ${JSON.stringify(error)} ${inspect(error)}`, new RegExp(`${ACCOUNT_TOKEN}|secret-ish|Fake`), 'no token and no Postmark text');
  }
  // A wrong token is Postmark's 401 / code 10.
  const wrong = createPostmarkAccountApi({ accountToken: '99999999-2222-4333-8444-555555555555', fetch: postmark.fetch });
  await assert.rejects(wrong.listDomains(), (e: unknown) => e instanceof PostmarkAccountError && e.category === 'unauthorized' && e.errorCode === 10);
  // Redirects are refused by the platform fetch; a network failure is a category, never the cause's text.
  const seen: RequestInit[] = [];
  const redirecting = createPostmarkAccountApi({ accountToken: ACCOUNT_TOKEN, fetch: (async (_url: unknown, init: RequestInit) => { seen.push(init); throw new TypeError(`redirect refused ${ACCOUNT_TOKEN}`); }) as unknown as typeof fetch });
  await assert.rejects(redirecting.listDomains(), (e: unknown) => e instanceof PostmarkAccountError && e.category === 'network' && !e.message.includes(ACCOUNT_TOKEN));
  assert.equal(seen[0]!.redirect, 'error');
  assert.ok(seen[0]!.signal, 'every call has a timeout');
  // AbortSignal.timeout fires a TimeoutError; its timer does not hold the process open, so the fake rejects the same way.
  const slow = createPostmarkAccountApi({ accountToken: ACCOUNT_TOKEN, timeoutMs: 20, fetch: (async () => { throw new DOMException('timed out', 'TimeoutError'); }) as unknown as typeof fetch });
  await assert.rejects(slow.listDomains(), (e: unknown) => e instanceof PostmarkAccountError && e.category === 'timeout');
  // An oversized or malformed answer is abandoned.
  const huge = createPostmarkAccountApi({ accountToken: ACCOUNT_TOKEN, fetch: (async () => new Response('x'.repeat(10), { status: 200, headers: { 'content-length': String(3 * 1024 * 1024) } })) as unknown as typeof fetch });
  await assert.rejects(huge.listDomains(), (e: unknown) => e instanceof PostmarkAccountError && e.category === 'invalid_response');
  const odd = createPostmarkAccountApi({ accountToken: ACCOUNT_TOKEN, fetch: (async () => new Response('{"Nope":1}', { status: 200 })) as unknown as typeof fetch });
  await assert.rejects(odd.listDomains(), (e: unknown) => e instanceof PostmarkAccountError && e.category === 'invalid_response');
  assert.throws(() => createPostmarkAccountApi({ accountToken: 'short' }), PostmarkAccountError);
  assert.doesNotMatch(JSON.stringify(api) + inspect(api), new RegExp(ACCOUNT_TOKEN), 'the client itself never shows its token');
});

// ---------- vault, switch, domain rules ----------

test('the vault seals with AAD per workspace and field, under its own key', () => {
  const vault = new EmailConnectionVault(Buffer.from(KEY, 'base64'));
  const sealed = vault.seal(PP_WS, 'server_token', 'srv-token-123456789012345');
  assert.equal(vault.open(PP_WS, 'server_token', sealed), 'srv-token-123456789012345');
  assert.throws(() => vault.open(PP_WS, 'webhook_secret', sealed), 'another field does not open');
  assert.throws(() => vault.open('2789228d-55a6-4688-b1e8-2f70abca990b', 'server_token', sealed), 'another workspace does not open');
  assert.throws(() => new EmailConnectionVault(Buffer.alloc(32, 8)).open(PP_WS, 'server_token', sealed), 'another key does not open');
  assert.match(sealed, /^[A-Za-z0-9+/]{40,}={0,2}$/u, 'the shape the 0155 CHECK accepts');
  assert.equal(JSON.stringify(vault), '{"credentials":"[REDACTED]"}');
  assert.equal(emailConnectionKey('not-base64'), null);
  assert.equal(emailConnectionKey(Buffer.alloc(16).toString('base64')), null);
});

test('the feature is on only with EMAIL_CONNECT=enabled and well-formed settings; problems name settings, never values', () => {
  assert.equal(loadEmailConnectConfig(ENV, { portalBaseUrl: ORIGIN }).enabled, true);
  const on = loadEmailConnectConfig(ENV, { portalBaseUrl: `${ORIGIN}/portal` });
  assert.ok(on.enabled && on.webhookOrigin === ORIGIN && on.accountToken === ACCOUNT_TOKEN);
  assert.doesNotMatch(JSON.stringify(on) + inspect(on), new RegExp(`${ACCOUNT_TOKEN}|${KEY.replace(/[+/]/g, '.')}`), 'the token and key are not enumerable');
  for (const [env, url] of [[{ ...ENV, EMAIL_CONNECT: 'true' }, ORIGIN], [{ ...ENV, EMAIL_CONNECT: 'Enabled' }, ORIGIN], [{ ...ENV, POSTMARK_ACCOUNT_TOKEN: '' }, ORIGIN],
    [{ ...ENV, POSTMARK_ACCOUNT_TOKEN: 'abc' }, ORIGIN], [{ ...ENV, EMAIL_CONNECTION_KEY: 'short' }, ORIGIN], [{ ...ENV, EMAIL_CONNECTION_KEY: undefined }, ORIGIN],
    [ENV, 'http://growth.relaunch72-test.co.uk'], [ENV, undefined]] as const) {
    const config = loadEmailConnectConfig(env as NodeJS.ProcessEnv, { portalBaseUrl: url });
    assert.equal(config.enabled, false);
    assert.ok(config.problems.length > 0);
    assert.doesNotMatch(config.problems.join(' '), /abc|short|11111111/u);
  }
  // A bad configuration never throws: the service is simply off.
  const service = new EmailConnectionService({ config: loadEmailConnectConfig({}, {}), store: new MemoryEmailConnectionStore() });
  assert.equal(service.enabled, false);
});

test('free mailboxes and reserved test domains are refused; addresses and hosts are read exactly', () => {
  for (const domain of ['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.co.uk', 'hotmail.fr', 'yahoo.com', 'yahoo.co.uk', 'icloud.com', 'live.com', 'aol.com', 'btinternet.com', 'mail.gmail.com']) {
    assert.equal(freeMailboxDomain(domain), true, domain);
  }
  for (const domain of ['propertypredator.com', 'live.mybusiness.co.uk', 'yahooligans-shop.com', 'mygmail.com']) assert.equal(freeMailboxDomain(domain), false, domain);
  for (const domain of ['example.com', 'mail.example.org', 'shop.test', 'x.invalid', 'localhost', 'a.example']) assert.equal(reservedDomain(domain), true, domain);
  assert.equal(reservedDomain('example.co.uk'), false, 'the shared rule: a real domain');
  assert.deepEqual(parseEmailAddress(' Hello@Mail.Brand.co.uk '), { address: 'hello@mail.brand.co.uk', domain: 'mail.brand.co.uk' });
  for (const bad of ['no-at', '@brand.co.uk', 'a@b', 'a..b@brand.co.uk', 'a b@brand.co.uk', 'a@-brand.co.uk', 'a@brand.c0']) assert.equal(parseEmailAddress(bad), null, bad);
  assert.equal(shortHost('20240101pm._domainkey.brand.co.uk', 'brand.co.uk'), '20240101pm._domainkey');
  assert.equal(shortHost('pm-bounces.brand.co.uk.', 'brand.co.uk'), 'pm-bounces');
  assert.equal(dnsHostFromNameServers(['ada.ns.cloudflare.com']), 'cloudflare');
  assert.equal(dnsHostFromNameServers(['ns01.domaincontrol.com']), 'godaddy');
  assert.equal(dnsHostFromNameServers(['dns1.registrar-servers.com']), 'namecheap');
  assert.equal(dnsHostFromNameServers(['ns.123-reg.co.uk']), '123-reg');
  assert.equal(dnsHostFromNameServers(['ns1045.ui-dns.com']), 'ionos');
  assert.equal(dnsHostFromNameServers(['ns1.other-host.net']), 'other');
});

test('our own DNS look-ups tell found, different, missing and unknown apart', async () => {
  const resolver = fakeResolver({ txt: { 'a.brand.co.uk': [['k=rsa; ', 'p=ABC']], 'b.brand.co.uk': [['k=rsa; p=OLD']] }, cname: { 'pm-bounces.brand.co.uk': ['PM.mtasv.net.'], 'x.brand.co.uk': ['elsewhere.net'] } });
  assert.equal(await lookUpTxt(resolver, 'a.brand.co.uk', 'k=rsa; p=ABC'), 'found');
  assert.equal(await lookUpTxt(resolver, 'b.brand.co.uk', 'k=rsa; p=ABC'), 'different');
  assert.equal(await lookUpTxt(resolver, 'c.brand.co.uk', 'k=rsa; p=ABC'), 'missing');
  assert.equal(await lookUpCname(resolver, 'pm-bounces.brand.co.uk', 'pm.mtasv.net'), 'found');
  assert.equal(await lookUpCname(resolver, 'x.brand.co.uk', 'pm.mtasv.net'), 'different');
  const broken = { ...resolver, resolveTxt: async () => { throw Object.assign(new Error('x'), { code: 'ESERVFAIL' }); } };
  assert.equal(await lookUpTxt(broken, 'a.brand.co.uk', 'x'), 'unknown');
});

// ---------- the state machine ----------

function harness(options: { resolver?: ReturnType<typeof fakeResolver>; configured?: boolean } = {}) {
  const postmark = new FakePostmark(), store = new MemoryEmailConnectionStore(), lines: string[] = [];
  const log = (line: string) => { lines.push(line); };
  const config = loadEmailConnectConfig(ENV, { portalBaseUrl: ORIGIN });
  const ledgerWrites: unknown[] = [];
  const ledger: EmailBlockLedger = { covers: () => true, status: () => 'available', decide: async () => null, recordList: async () => null, rows: async () => null,
    record: async input => { ledgerWrites.push(input); return 'recorded'; }, lift: async input => { ledgerWrites.push(input); return 1; } };
  // Optionally an env-configured PP source exists too (PP_POSTMARK_* set): the stored connection must win.
  const env = options.configured ? { PP_POSTMARK_SERVER_TOKEN: 'env-pp-server-token-0123456789', PP_POSTMARK_WEBHOOK_SECRET: 'env-pp-webhook-secret-0123456789' } : {};
  const bounces = new EmailBounceService({ log, ledger, config: loadEmailBounceConfig(env, { defaults: options.configured
    ? [{ key: 'pp', workspaceId: PP_WS, tokenEnv: 'PP_POSTMARK_SERVER_TOKEN', webhookSecretEnv: 'PP_POSTMARK_WEBHOOK_SECRET', marketingStreams: ['broadcast'], serviceStreams: [] }] : [] }),
    apiFor: () => null });
  const effects: unknown[] = [];
  bounces.setEffects(PP_WS, { onMarketingBlock: async input => { effects.push(input); } });
  assert.ok(config.enabled);
  const sources = new EmailConnectionBounceSources({ store, vault: config.vault, service: bounces, log });
  bounces.setSourceLoader(sources);
  const webhook = createPostmarkBounceWebhook({ service: bounces, log });
  const account = createPostmarkAccountApi({ accountToken: ACCOUNT_TOKEN, fetch: postmark.fetch });
  const service = new EmailConnectionService({ config, store, account, resolver: options.resolver ?? fakeResolver(), bounces: sources, log, secret: () => SECRET, lockWaitMs: 3_000 });
  const post = async (body: unknown, auth = `${EMAIL_CONNECT_BUSINESSES[0]!.sourceKey}:${SECRET}`, path = KEYPATH) => {
    const captured = { status: 0, body: '' };
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: 'POST', url: path,
      headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(auth).toString('base64')}` }, socket: { remoteAddress: '127.0.0.1' } }) as unknown as IncomingMessage;
    const res = { writeHead(status: number) { captured.status = status; }, end(text = '') { captured.body = String(text); } } as unknown as ServerResponse;
    await webhook.handle(req, res, new URL(path, ORIGIN)); return captured;
  };
  // Postmark checks a new webhook by posting a sample of each trigger to it, with the webhook's own credentials.
  const samples = (stream = 'outbound') => [
    { RecordType: 'Bounce', ID: 4323372036854775807n.toString(), Type: 'HardBounce', TypeCode: 1, ServerID: 23, MessageStream: stream, Email: 'john@example.com',
      From: 'sender@example.com', BouncedAt: '2019-11-05T16:33:54.9070259Z', Inactive: true, CanActivate: true, Metadata: { a_key: 'a_value' } },
    { RecordType: 'SpamComplaint', ID: 42, Type: 'SpamComplaint', TypeCode: 512, ServerID: 23, MessageStream: stream, Email: 'john@example.com', BouncedAt: '2019-11-05T16:33:54Z', Inactive: true },
    { RecordType: 'SubscriptionChange', MessageID: '883953f4-6105-42a2-a16a-77a8eac79483', ServerID: 23, MessageStream: stream, ChangedAt: '2020-02-01T10:53:34.416071Z',
      Recipient: 'bounced-address@wildbit.com', Origin: 'Recipient', SuppressSending: true, SuppressionReason: 'HardBounce', Tag: 'my-tag', Metadata: { example: 'value' } },
  ];
  postmark.verify = async hook => {
    for (const sample of [...samples(), ...samples(hook.stream)]) {
      const answer = await post(sample, `${hook.username}:${hook.password}`, new URL(hook.url).pathname);
      if (answer.status !== 200) return false;
    }
    return true;
  };
  return { postmark, store, lines, service, bounces, sources, post, samples, ledgerWrites, effects };
}

const counts = (postmark: FakePostmark) => ({
  servers: postmark.servers.length,
  streams: postmark.servers.reduce((n, s) => n + s.streams.filter(st => st.id === 'broadcast').length, 0),
  webhooks: postmark.servers.reduce((n, s) => n + s.webhooks.length, 0),
  domains: postmark.domains.length,
});

test('Connect creates the server, the Broadcast stream, the webhook (secret saved first) and the domain, and Postmark\'s samples record nothing', async () => {
  const h = harness();
  const result = await h.service.connect(owner, FORM);
  assert.deepEqual(result, { ok: true, message: EMAIL_CONNECTION_MESSAGES.started });
  assert.deepEqual(counts(h.postmark), { servers: 1, streams: 1, webhooks: 1, domains: 1 });
  const server = h.postmark.servers[0]!;
  assert.equal(server.name, connectionServerName(EMAIL_CONNECT_BUSINESSES[0]!));
  assert.equal(server.name, 'Relaunch72 · Property Predator · d975ff66');
  assert.deepEqual(server.webhooks.map(w => [w.url, w.stream, w.username]), [[`${ORIGIN}/api/provider-webhooks/postmark/conn-d975ff66`, 'broadcast', 'conn-d975ff66']]);
  assert.equal(h.postmark.domains[0]!.name, DOMAIN);
  assert.equal(h.postmark.domains[0]!.returnPath, `pm-bounces.${DOMAIN}`);
  const state = await h.store.state(OWNER_SESSION, PP_WS);
  assert.equal(state.status, 'dns_pending');
  assert.equal(state.mode, 'off', 'this release never switches sending on');
  assert.deepEqual([state.fromAddress, state.replyTo, state.domain], ['hello@mail.propertypredator-test.co.uk', 'team@propertypredator-test.co.uk', DOMAIN]);
  assert.equal(state.dns!.dkim.host, `${h.postmark.domains[0]!.id}pm._domainkey.${DOMAIN}`);
  assert.equal(state.dns!.returnPath.value, 'pm.mtasv.net');
  // Intent first, and the secret saved before the webhook was asked for.
  const order = h.store.events.map(e => `${e.step}:${e.outcome}`);
  assert.deepEqual(order, ['terms:accepted', 'begin:started', 'server:started', 'server:token_saved', 'server:created', 'stream:started', 'stream:created',
    'secret:started', 'secret:saved', 'webhook:started', 'webhook:created', 'domain:started', 'domain:created']);
  // Postmark's verification samples (another ServerID, sample addresses, on our stream too) were answered 200 and recorded nothing.
  assert.deepEqual(h.ledgerWrites, []);
  assert.deepEqual(h.effects, []);
  assert.equal(h.bounces.registry.decide(PP_WS, 'john@example.com', 'marketing').blocked, false);
  for (const sample of h.samples('broadcast')) assert.deepEqual(JSON.parse((await h.post(sample)).body), { received: true, outcome: 'ignored' });
  assert.deepEqual(h.ledgerWrites, []);
  // A real event for the connected server is recorded as today.
  const real = { RecordType: 'Bounce', ID: 777, Type: 'HardBounce', ServerID: server.id, MessageStream: 'broadcast', Email: 'reader@readers-test.co.uk', BouncedAt: '2026-11-14T09:00:00Z',
    Inactive: true, Metadata: { point: '00000000-0000-4000-8000-000000000009' } };
  assert.equal((await h.post(real)).status, 200);
  assert.equal(h.bounces.registry.decide(PP_WS, 'reader@readers-test.co.uk', 'marketing').blocked, true);
  assert.equal(h.ledgerWrites.length, 1);
  assert.equal((h.ledgerWrites[0] as unknown as { sourceKey: string }).sourceKey, 'conn-d975ff66');
  assert.equal(h.effects.length, 1, 'the brand\'s own lasting stop runs, as for any source');
  // Wrong password: 401.
  assert.equal((await h.post(real, `conn-d975ff66:wrong-secret-wrong-secret-wrong-secret`)).status, 401);
  assert.equal((await h.post(real, `pp:${SECRET}`)).status, 401, 'the Basic user must be the source key');
  // Nothing sensitive in any log line.
  const token = server.token, all = h.lines.join('\n');
  for (const value of [token, SECRET, ACCOUNT_TOKEN, KEY, 'reader@readers-test.co.uk', 'john@example.com']) assert.equal(all.includes(value), false, 'no secret or address in the logs');
});

test('a failure after EVERY step leaves the connection to Continue, and Continue adopts everything without creating anything twice', async () => {
  type Inject = { name: string; match: (call: { method: string; path: string }) => boolean; after?: boolean; status?: number; code?: number };
  const injections: Inject[] = [
    { name: 'list servers', match: c => c.method === 'GET' && c.path.startsWith('/servers?') },
    { name: 'create server (lost answer)', match: c => c.method === 'POST' && c.path === '/servers', after: true },
    { name: 'create server', match: c => c.method === 'POST' && c.path === '/servers' },
    { name: 'list streams', match: c => c.method === 'GET' && c.path.startsWith('/message-streams') },
    { name: 'create stream (lost answer)', match: c => c.method === 'POST' && c.path === '/message-streams', after: true },
    { name: 'list webhooks', match: c => c.method === 'GET' && c.path.startsWith('/webhooks') },
    { name: 'create webhook (lost answer)', match: c => c.method === 'POST' && c.path === '/webhooks', after: true },
    { name: 'create webhook', match: c => c.method === 'POST' && c.path === '/webhooks', status: 422, code: 1364 },
    { name: 'create domain (lost answer)', match: c => c.method === 'POST' && c.path === '/domains', after: true },
    { name: 'create domain', match: c => c.method === 'POST' && c.path === '/domains', status: 429 },
  ];
  for (const inject of injections) {
    const h = harness();
    h.postmark.failOn(inject.match, inject.status ?? 500, inject.code ?? null, inject.after ?? false);
    await assert.rejects(h.service.connect(owner, FORM), (e: unknown) => e instanceof EmailConnectionError
      && ([EMAIL_CONNECTION_MESSAGES.busy, EMAIL_CONNECTION_MESSAGES.unfinished] as string[]).includes(e.message), inject.name);
    assert.equal((await h.store.state(OWNER_SESSION, PP_WS)).status, 'needs_attention', inject.name);
    const result = await h.service.continue(owner);
    assert.equal(result.ok, true, inject.name);
    assert.equal((await h.store.state(OWNER_SESSION, PP_WS)).status, 'dns_pending', inject.name);
    assert.deepEqual(counts(h.postmark), { servers: 1, streams: 1, webhooks: 1, domains: 1 }, inject.name);
    // And a further press changes nothing at Postmark.
    const before = h.postmark.calls.filter(c => c.method !== 'GET').length;
    await h.service.continue(owner);
    assert.equal(h.postmark.calls.filter(c => c.method !== 'GET').length, before, inject.name);
  }
  // A database failure after each step's Postmark work: the step is adopted on Continue.
  for (const method of ['record', 'saveSealed', 'intend']) {
    for (let skip = 0; skip < 5; skip++) {
      const h = harness();
      let seen = 0;
      const original = (h.store as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[method]!.bind(h.store);
      (h.store as unknown as Record<string, unknown>)[method] = async (...args: unknown[]) => {
        if (seen++ === skip) throw new Error('database went away');
        return original(...args);
      };
      await h.service.connect(owner, FORM).catch(() => undefined);
      (h.store as unknown as Record<string, unknown>)[method] = original;
      const state = await h.store.state(OWNER_SESSION, PP_WS);
      if (state.status !== 'dns_pending') await h.service.continue(owner);
      assert.equal((await h.store.state(OWNER_SESSION, PP_WS)).status, 'dns_pending', `${method} #${skip}`);
      assert.deepEqual(counts(h.postmark), { servers: 1, streams: 1, webhooks: 1, domains: 1 }, `${method} #${skip}`);
    }
  }
});

test('a double press creates nothing twice', async () => {
  const h = harness();
  const [a, b] = await Promise.allSettled([h.service.connect(owner, FORM), h.service.connect(owner, FORM)]);
  assert.equal(a.status, 'fulfilled');
  // The second press waited for the first, then found the connection already waiting for its records.
  assert.ok(b.status === 'rejected' && (b.reason as EmailConnectionError).message === EMAIL_CONNECTION_MESSAGES.alreadyConnected);
  assert.deepEqual(counts(h.postmark), { servers: 1, streams: 1, webhooks: 1, domains: 1 });
  const [c, d] = await Promise.all([h.service.continue(owner), h.service.continue(owner)]);
  assert.equal(c.ok && d.ok, true);
  assert.deepEqual(counts(h.postmark), { servers: 1, streams: 1, webhooks: 1, domains: 1 });
});

test('free mailboxes, reserved domains and bad details are refused before Postmark is called', async () => {
  const h = harness();
  const refused = async (form: Partial<typeof FORM>, message: string) => {
    await assert.rejects(h.service.connect(owner, { ...FORM, ...form }), (e: unknown) => e instanceof EmailConnectionError && e.message === message);
  };
  await refused({ fromAddress: 'me@gmail.com' }, 'That\'s a free mailbox (gmail.com). Use an address on your own domain.');
  await refused({ fromAddress: 'me@yahoo.co.uk' }, 'That\'s a free mailbox (yahoo.co.uk). Use an address on your own domain.');
  await refused({ fromAddress: 'me@shop.example.com' }, EMAIL_CONNECTION_MESSAGES.reservedDomain);
  await refused({ fromAddress: 'me@brand.test' }, EMAIL_CONNECTION_MESSAGES.reservedDomain);
  await refused({ fromAddress: 'not an address' }, EMAIL_CONNECTION_MESSAGES.needFrom);
  await refused({ fromName: '' }, EMAIL_CONNECTION_MESSAGES.needName);
  await refused({ fromName: '<script>' }, EMAIL_CONNECTION_MESSAGES.needName);
  await refused({ replyTo: 'nope' }, EMAIL_CONNECTION_MESSAGES.needReplyTo);
  assert.equal(h.postmark.calls.length, 0);
  assert.equal(h.store.row, null, 'nothing was saved either');
  // A domain Postmark itself calls public is reported the same plain way.
  h.postmark.failOn(c => c.method === 'POST' && c.path === '/domains', 422, 503);
  await assert.rejects(h.service.connect(owner, FORM), (e: unknown) => e instanceof EmailConnectionError && /free mailbox/u.test(e.message));
});

test('the email rules: required on the server, idempotent, and a new version needs a new tick before any further Postmark call', async () => {
  const h = harness();
  await assert.rejects(h.service.connect(owner, { ...FORM, agreed: false }), (e: unknown) => e instanceof EmailConnectionError && e.message === 'Tick the email rules first.');
  assert.equal(h.postmark.calls.length, 0);
  assert.equal(h.store.row, null, 'an unticked box saves nothing');
  // The store itself refuses begin without the current rules.
  assert.equal(await h.store.begin(OWNER_SESSION, PP_WS, { domain: DOMAIN, fromName: 'x', fromAddress: `a@${DOMAIN}`, replyTo: null }, EMAIL_TERMS_VERSION), 'terms_required');
  assert.equal(await h.store.acceptTerms(OWNER_SESSION, PP_WS, EMAIL_TERMS_VERSION), 'accepted');
  const first = (await h.store.state(OWNER_SESSION, PP_WS)).terms!;
  assert.equal(await h.store.acceptTerms(OWNER_SESSION, PP_WS, EMAIL_TERMS_VERSION), 'already');
  assert.deepEqual((await h.store.state(OWNER_SESSION, PP_WS)).terms, first, 'a second tick keeps the first who and when');
  assert.equal(EMAIL_TERMS.length, 6);
  // Interrupted, then the rules change: Continue makes no Postmark call until the owner ticks again.
  h.postmark.failOn(c => c.method === 'POST' && c.path === '/webhooks', 500);
  await assert.rejects(h.service.connect(owner, FORM));
  h.store.row!.terms = { version: '2025-01-01', acceptedAt: first.acceptedAt, acceptedByName: 'Pat Owner' };
  const calls = h.postmark.calls.length;
  await assert.rejects(h.service.continue(owner), (e: unknown) => e instanceof EmailConnectionError && e.message === EMAIL_CONNECTION_MESSAGES.termsFirst);
  assert.equal(h.postmark.calls.length, calls, 'no Postmark call under old rules');
  const view = await h.service.view(owner);
  assert.ok(view.offered && view.state.protection.dailyCap === 50 && view.state.protection.hourlyCap === 13 && view.state.protection.state === 'ok');
});

test('a domain already in the shared account is never adopted unless this business started creating it', async () => {
  const h = harness();
  // Another business's (or a hand-made) domain of the same name already in our Postmark account.
  h.postmark.domains.push({ id: 5, name: DOMAIN, returnPath: `pm-bounces.${DOMAIN}`, dkimVerified: true, returnPathVerified: true });
  await assert.rejects(h.service.connect(owner, FORM), (e: unknown) => e instanceof EmailConnectionError && e.message === 'That domain is already connected to another business.');
  await assert.rejects(h.service.continue(owner), (e: unknown) => e instanceof EmailConnectionError && e.message === EMAIL_CONNECTION_MESSAGES.domainTaken);
  assert.equal((await h.store.state(OWNER_SESSION, PP_WS)).domainId, null);
  // Our own interrupted create (the answer was lost) IS adopted.
  const g = harness();
  g.postmark.failOn(c => c.method === 'POST' && c.path === '/domains', 500, null, true);
  await assert.rejects(g.service.connect(owner, FORM));
  assert.equal((await g.service.continue(owner)).ok, true);
  assert.equal(g.postmark.domains.length, 1);
});

test('Check answers in exactly the four plain sentences, from Postmark\'s verified flags; our look-up only picks the wording', async () => {
  const dns: { txt: Record<string, string[][]>; cname: Record<string, string[]> } = { txt: {}, cname: {} };
  const setup = async () => { dns.txt = {}; dns.cname = {}; const h = harness({ resolver: fakeResolver(dns) }); await h.service.connect(owner, FORM); return h; };
  let h = await setup();
  assert.equal((await h.service.check(owner)).message, 'Not found yet. This can take up to 48 hours; press Check again later.');
  h = await setup();
  dns.txt[`${h.postmark.domains[0]!.id}pm._domainkey.${DOMAIN}`] = [['k=rsa; p=WRONG']];
  assert.equal((await h.service.check(owner)).message, 'The value doesn\'t match. Copy it again from this page.');
  h = await setup();
  h.postmark.domains[0]!.dkimVerified = true;
  assert.equal((await h.service.check(owner)).message, 'Found 1 of 2: the CNAME record is missing.');
  h.postmark.domains[0]!.dkimVerified = false; h.postmark.domains[0]!.returnPathVerified = true;
  assert.equal((await h.service.check(owner)).message, 'Found 1 of 2: the TXT record is missing.');
  // Our look-up says found, Postmark says not yet: Postmark wins (not connected).
  h = await setup();
  const id = h.postmark.domains[0]!.id;
  dns.txt[`${id}pm._domainkey.${DOMAIN}`] = [['k=rsa; p=KEY' + id]]; dns.cname[`pm-bounces.${DOMAIN}`] = ['pm.mtasv.net'];
  assert.notEqual((await h.service.check(owner)).message, EMAIL_CONNECTION_MESSAGES.checkBoth);
  assert.equal((await h.store.state(OWNER_SESSION, PP_WS)).status, 'dns_pending');
  h.postmark.domains[0]!.dkimVerified = true; h.postmark.domains[0]!.returnPathVerified = true;
  assert.equal((await h.service.check(owner)).message, 'Both found. Your email is connected.');
  const state = await h.store.state(OWNER_SESSION, PP_WS);
  assert.equal(state.status, 'verified');
  assert.equal(state.mode, 'off');
  assert.ok(state.dns!.dkim.verified && state.dns!.returnPath.verified);
  // Postmark busy on check: the plain busy sentence.
  h.postmark.failOn(c => c.path.endsWith('/verifyDkim'), 503);
  await assert.rejects(h.service.check(owner), (e: unknown) => e instanceof EmailConnectionError && e.message === EMAIL_CONNECTION_MESSAGES.busy);
});

test('Disconnect deletes the webhook, forgets both secrets, keeps the server and domain for re-adoption, and stops the bounce source', async () => {
  const h = harness();
  await h.service.connect(owner, FORM);
  assert.deepEqual(h.bounces.dynamicSourceKeys(), ['conn-d975ff66']);
  await h.service.disconnect(owner);
  const state = await h.store.state(OWNER_SESSION, PP_WS);
  assert.equal(state.status, 'disconnected');
  assert.equal(state.webhookId, null);
  assert.equal(state.hasServerToken || state.hasWebhookSecret, false);
  assert.ok(state.serverId && state.domainId, 'server and domain ids are kept');
  assert.deepEqual(counts(h.postmark), { servers: 1, streams: 1, webhooks: 0, domains: 1 });
  assert.deepEqual(h.bounces.dynamicSourceKeys(), []);
  assert.equal((await h.post({ RecordType: 'Bounce' })).status, 404, 'the address is closed');
  // Reconnecting adopts the same server and domain and makes one new webhook.
  await h.service.connect(owner, FORM);
  assert.deepEqual(counts(h.postmark), { servers: 1, streams: 1, webhooks: 1, domains: 1 });
});

test('an account token Postmark refuses reads as "not switched on" to the owner and is logged without the token', async () => {
  const h = harness();
  h.postmark.failOn(() => true, 401, 10);
  await assert.rejects(h.service.connect(owner, FORM), (e: unknown) => e instanceof EmailConnectionError && e.message === EMAIL_CONNECTION_MESSAGES.off);
  assert.ok(h.lines.some(line => line.includes('email.connections.account_token_refused')));
  assert.equal(h.lines.join('\n').includes(ACCOUNT_TOKEN), false);
  const g = harness();
  g.postmark.failOn(() => true, 422, 412);
  await assert.rejects(g.service.connect(owner, FORM), (e: unknown) => e instanceof EmailConnectionError && e.message === EMAIL_CONNECTION_MESSAGES.awaitingApproval);
});

test('only the eligible owner, only an allowed business', async () => {
  const h = harness();
  await assert.rejects(h.service.connect({ ...owner, sessionToken: 'someone-else-session-token-000000' }, FORM), (e: unknown) => e instanceof EmailConnectionError && e.status === 403);
  await assert.rejects(h.service.connect({ ...owner, workspaceId: '2789228d-55a6-4688-b1e8-2f70abca990b' }, FORM), (e: unknown) => e instanceof EmailConnectionError && e.message === EMAIL_CONNECTION_MESSAGES.notAllowed);
  assert.equal(h.postmark.calls.length, 0);
  const off = new EmailConnectionService({ config: loadEmailConnectConfig({}, {}), store: h.store });
  assert.deepEqual(await off.view(owner), { offered: false, message: 'Email connection isn\'t switched on yet.' });
});

// ---------- dynamic bounce sources ----------

test('stored connections are added and removed without a restart; configured sources are unchanged; the stored one wins over PP\'s env source', async () => {
  const h = harness({ configured: true });
  assert.deepEqual(h.bounces.sources.map(s => s.key), ['pp'], 'before: the env source as today');
  await h.service.connect(owner, FORM);
  assert.deepEqual(h.bounces.sources.map(s => s.key), ['conn-d975ff66'], 'the stored connection replaces PP\'s env source');
  const replaced = h.lines.filter(line => line.includes('configured_source_replaced'));
  assert.equal(replaced.length, 1);
  await h.sources.refresh(); await h.sources.refresh();
  assert.equal(h.lines.filter(line => line.includes('configured_source_replaced')).length, 1, 'logged once');
  assert.equal(h.lines.join('\n').includes('env-pp-'), false, 'without secrets');
  await h.service.disconnect(owner);
  assert.deepEqual(h.bounces.sources.map(s => s.key), ['pp'], 'after disconnect the env source applies again');

  // Another instance: the store has a connection this process never loaded. Postmark's post triggers a read.
  const a = harness();
  await a.service.connect(owner, FORM);
  const other = new EmailBounceService({ config: { sources: [], blockers: [] }, apiFor: () => null });
  const otherSources = new EmailConnectionBounceSources({ store: a.store, vault: loadEmailConnectConfig(ENV, { portalBaseUrl: ORIGIN }).vault!, service: other });
  other.setSourceLoader(otherSources);
  const hook = createPostmarkBounceWebhook({ service: other });
  const call = async () => {
    const captured = { status: 0 };
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(a.samples('broadcast')[0]))]), { method: 'POST', url: KEYPATH,
      headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`conn-d975ff66:${SECRET}`).toString('base64')}` }, socket: { remoteAddress: '127.0.0.2' } }) as unknown as IncomingMessage;
    await hook.handle(req, { writeHead(s: number) { captured.status = s; }, end() {} } as unknown as ServerResponse, new URL(KEYPATH, ORIGIN));
    return captured.status;
  };
  assert.equal(await call(), 200, 'loaded on demand, then answered');
  assert.deepEqual(other.dynamicSourceKeys(), ['conn-d975ff66']);
  // The store cannot be read: 503 (Postmark retries), never a 4xx (Postmark drops those).
  const cold = new EmailBounceService({ config: { sources: [], blockers: [] }, apiFor: () => null });
  const broken = new MemoryEmailConnectionStore(); broken.sourcesFail = new Error('database down');
  cold.setSourceLoader(new EmailConnectionBounceSources({ store: broken, vault: loadEmailConnectConfig(ENV, { portalBaseUrl: ORIGIN }).vault!, service: cold }));
  const coldHook = createPostmarkBounceWebhook({ service: cold });
  const captured = { status: 0 };
  const req = Object.assign(Readable.from([Buffer.from('{}')]), { method: 'POST', url: KEYPATH, headers: { 'content-type': 'application/json' }, socket: { remoteAddress: '127.0.0.3' } }) as unknown as IncomingMessage;
  await coldHook.handle(req, { writeHead(s: number) { captured.status = s; }, end() {} } as unknown as ServerResponse, new URL(KEYPATH, ORIGIN));
  assert.equal(captured.status, 503);
  // The periodic refresh removes a connection disconnected elsewhere.
  await a.service.disconnect(owner);
  await otherSources.refresh();
  assert.deepEqual(other.dynamicSourceKeys(), []);
});

test('configured sources keep today\'s behaviour exactly: a wrong ServerID is refused 403 and an unreadable body 400', async () => {
  const service = new EmailBounceService({ apiFor: () => null, config: loadEmailBounceConfig({ EMAIL_BOUNCE_SOURCES: JSON.stringify([{ key: 'mhp', workspaceId: '2789228d-55a6-4688-b1e8-2f70abca990b',
    tokenEnv: 'MHP_TOKEN', webhookSecretEnv: 'MHP_SECRET', marketingStreams: ['broadcast'], serverId: '77' }]), MHP_TOKEN: 'mhp-token-0123456789-0123', MHP_SECRET: SECRET }) });
  const hook = createPostmarkBounceWebhook({ service });
  const call = async (body: unknown) => {
    const captured = { status: 0 };
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: 'POST', url: '/x', headers: { 'content-type': 'application/json',
      authorization: `Basic ${Buffer.from(`mhp:${SECRET}`).toString('base64')}` }, socket: { remoteAddress: '127.0.0.1' } }) as unknown as IncomingMessage;
    await hook.handle(req, { writeHead(s: number) { captured.status = s; }, end() {} } as unknown as ServerResponse, new URL('/api/provider-webhooks/postmark/mhp', ORIGIN));
    return captured.status;
  };
  assert.equal(await call({ RecordType: 'Bounce', ID: 1, Type: 'HardBounce', ServerID: 23, MessageStream: 'broadcast', Email: 'a@readers-test.co.uk', BouncedAt: '2026-11-14T09:00:00Z', Inactive: true }), 403);
  assert.equal(await call({ RecordType: 'Bounce' }), 400);
  assert.equal(service.sourceLoader, null);
  assert.throws(() => service.upsertSource({ key: 'mhp', workspaceId: PP_WS, token: null, webhookSecret: SECRET, serverId: '1', streams: new Map([['broadcast', 'marketing']]) }),
    'a run-time source never replaces a configured key');
});

// ---------- a database at 0154, and the send paths ----------

test('on a database at 0154 the feature is simply not offered and nothing errors', async () => {
  const { PgEmailConnectionStore } = await import('../src/email-connections/store.js');
  const lines: string[] = [];
  const missing = Object.assign(new Error('function app_private.email_connection_state(bytea, uuid) does not exist'), { code: '42883' });
  const pool = { query: async () => { throw missing; }, connect: async () => { throw new Error('not used'); } };
  const store = new PgEmailConnectionStore(pool as never, { log: line => lines.push(line) });
  const config = loadEmailConnectConfig(ENV, { portalBaseUrl: ORIGIN });
  const postmark = new FakePostmark();
  const service = new EmailConnectionService({ config, store, account: createPostmarkAccountApi({ accountToken: ACCOUNT_TOKEN, fetch: postmark.fetch }) });
  assert.deepEqual(await service.view(owner), { offered: false, message: 'Email connection isn\'t switched on yet.' });
  assert.equal(await store.sources(), null);
  const bounces = new EmailBounceService({ config: { sources: [], blockers: [] }, apiFor: () => null });
  const sources = new EmailConnectionBounceSources({ store, vault: config.vault!, service: bounces });
  await sources.refresh();
  assert.deepEqual(bounces.sources, []);
  bounces.setSourceLoader(sources);
  const captured = { status: 0 };
  const req = Object.assign(Readable.from([Buffer.from('{}')]), { method: 'POST', url: KEYPATH, headers: { 'content-type': 'application/json' }, socket: { remoteAddress: '127.0.0.9' } }) as unknown as IncomingMessage;
  await createPostmarkBounceWebhook({ service: bounces }).handle(req, { writeHead(s: number) { captured.status = s; }, end() {} } as unknown as ServerResponse, new URL(KEYPATH, ORIGIN));
  assert.equal(captured.status, 404, 'no stored connection: not found, as for any unknown address');
  assert.equal(postmark.calls.length, 0);
  assert.equal(lines.filter(line => line.includes('store_absent')).length, 1, 'said once, at info');
});

test('no existing sender reads the connection, its mode or the protection groundwork in this release', async () => {
  const { readdir, readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const root = new URL('../src/', import.meta.url).pathname;
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full); else if (/\.ts$/u.test(entry.name)) files.push(full);
    }
  };
  await walk(root);
  const allowed = (file: string) => file.includes('/email-connections/') || /\/portal\/email-connection-(?:router|view)\.ts$/u.test(file);
  const pattern = /app_private\.email_connection|email_connections|email_protection_events|protection_state|go_live_approved|warmup_started_at|terms_accepted|termsAccepted|goLiveApproved|warmupStartedAt|protectionState|EmailConnection(?:Service|Store|BounceSources)|email-connections\//u;
  const readers: string[] = [];
  for (const file of files) {
    if (allowed(file)) continue;
    const text = await readFile(file, 'utf8');
    if (pattern.test(text)) readers.push(path.relative(root, file));
  }
  // Only the composition (platform, portal deps, router mount) and the schema gate know about it; no send path does.
  assert.deepEqual(readers.sort(), ['db/email-connection-schema.ts', 'portal/postgres-platform.ts', 'portal/router.ts'].sort());
  for (const sender of ['pp-followup/mail.ts', 'pp-followup/dispatch.ts', 'mhp/marketing-mail.ts', 'email/postmark.ts', 'webinars/messages.ts']) {
    assert.doesNotMatch(await readFile(path.join(root, sender), 'utf8'), pattern, sender);
  }
});
