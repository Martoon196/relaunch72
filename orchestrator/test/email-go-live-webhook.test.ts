/**
 * "Go live" and the bounce webhook: the check Postmark is asked before going live (Status verified, unverified, absent or
 * in another letter case; the stored id not listed; no token; a failed list; a failed or passing verify), each refusal
 * logged as one line with its reason, and "Repair bounce reporting", the owner's button for the webhook. Postmark is a
 * stand-in; nothing touches the network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createPostmarkAccountApi, createPostmarkServerApi, EmailConnectionService, EmailConnectionVault, EMAIL_CONNECTION_MESSAGES, loadEmailConnectConfig,
  PostmarkAccountError, type EmailConnectionState, type PostmarkServerApi, type PostmarkWebhook, type WebhookVerification } from '../src/email-connections/index.js';
import { handleEmailConnection } from '../src/portal/email-connection-router.js';
import { OwnerSendingService, SENDING_MESSAGES } from '../src/email-protection/owner.js';
import { portalCsrfToken } from '../src/portal/session.js';
import { ACCOUNT_TOKEN, FakePostmark, fakeResolver, MemoryEmailConnectionStore, OWNER_SESSION, PP_WS } from './email-connections-fixtures.js';
import { counts, MemoryProtectionStore } from './email-protection-fixtures.js';

const ORIGIN = 'https://growth.relaunch72-test.co.uk';
const SESSION_SECRET = 'portal-session-secret-for-tests-0123456789';
const SECRET = 'whsec-synthetic-0123456789-abcdefghijklmnop';
const KEY = Buffer.alloc(32, 9).toString('base64');
const SERVER_TOKEN = 'srv-unit-token-0123456789abcdef';
const owner = { sessionToken: OWNER_SESSION, userId: '00000000-0000-4000-8000-000000000001', workspaceId: PP_WS, userEmail: 'owner@pp-send-proof.co.uk' };
const portal = { productProfile: { id: 'property_predator_growth' } as never, portalBaseUrl: ORIGIN, sessionSecret: SESSION_SECRET };
const HOOK_URL = `${ORIGIN}/api/provider-webhooks/postmark/conn-d975ff66336a46c2b36bd7095a11af97`;

// ---------- the Postmark client ----------

test('the webhook list reads Status in any letter case and says when it is absent; verify answers verified, or the failing triggers with numbers only', async () => {
  const postmark = new FakePostmark();
  const account = createPostmarkAccountApi({ accountToken: ACCOUNT_TOKEN, fetch: postmark.fetch });
  const server = await account.createServer({ name: 'Relaunch72 - test' });
  const api = createPostmarkServerApi({ serverToken: server.serverToken!, fetch: postmark.fetch });
  await api.createBroadcastStream('broadcast', 'Broadcasts');
  const hook = await api.createWebhook({ url: HOOK_URL, stream: 'broadcast', username: 'conn-x', password: SECRET });
  let listed = (await api.listWebhooks('broadcast'))[0]!;
  assert.deepEqual([listed.status, listed.statusPresent], ['verified', true]);
  postmark.statusField = 'upper';
  listed = (await api.listWebhooks('broadcast'))[0]!;
  assert.deepEqual([listed.status, listed.statusPresent], ['verified', true], '"VERIFIED" is verified');
  postmark.statusField = 'absent';
  listed = (await api.listWebhooks('broadcast'))[0]!;
  assert.deepEqual([listed.status, listed.statusPresent], [null, false], 'no Status field: neither verified nor unverified');
  // Verify: the documented call, with the server token.
  assert.deepEqual(await api.verifyWebhook(hook.id), { verified: true });
  const call = postmark.calls.at(-1)!;
  assert.deepEqual([call.method, call.path, call.header, call.token], ['POST', `/webhooks/${hook.id}/verify`, 'server', server.serverToken]);
  // A failing verification, in both documented shapes: 422 / 1364, and 200 with Success false.
  postmark.verify = async () => false;
  for (const shape of ['422', '200'] as const) {
    postmark.verifyFailsAs = shape;
    const answer = await api.verifyWebhook(hook.id);
    assert.deepEqual(answer, { verified: false, failing: [{ trigger: 'Bounce', status: 401 }] }, shape);
    assert.doesNotMatch(JSON.stringify(answer), /Remote server|https:|secret-ish/u, 'no Postmark text and no URL');
  }
  assert.equal(postmark.servers[0]!.webhooks[0]!.status, 'unverified', 'Postmark marked it unverified');
  // Anything else is the usual typed error, without Postmark's text.
  postmark.failOn(c => c.path.endsWith('/verify'), 503);
  await assert.rejects(api.verifyWebhook(hook.id), (e: unknown) => e instanceof PostmarkAccountError && e.category === 'busy' && e.status === 503);
  await assert.rejects(api.verifyWebhook(424242), (e: unknown) => e instanceof PostmarkAccountError && e.errorCode === 1352 && !String(e.message).includes('no'));
  await assert.rejects(api.verifyWebhook(0), (e: unknown) => e instanceof PostmarkAccountError);
  // A webhook create that fails Postmark's test carries the failing triggers too.
  await assert.rejects(api.createWebhook({ url: HOOK_URL, stream: 'broadcast', username: 'conn-x', password: SECRET }),
    (e: unknown) => e instanceof PostmarkAccountError && e.errorCode === 1364 && JSON.stringify(e.failingTriggers) === JSON.stringify([{ trigger: 'Bounce', status: 401 }])
      && !JSON.stringify(e).includes('Remote server'));
});

// ---------- the go-live check, with a stand-in server API ----------

type Listed = Partial<PostmarkWebhook> & { id: number };
function unit(options: { webhookId?: number | null; listed?: Listed[] | Error; verify?: WebhookVerification | Error; sealed?: 'ok' | 'none' | 'garbage' } = {}) {
  const vault = new EmailConnectionVault(Buffer.from(KEY, 'base64'));
  const sealed = options.sealed ?? 'ok';
  const calls: string[] = [], logs: string[] = [];
  const api: PostmarkServerApi = {
    listBroadcastStreams: async () => { calls.push('listStreams'); return []; },
    createBroadcastStream: async () => { calls.push('createStream'); throw new Error('never'); },
    listWebhooks: async stream => {
      calls.push(`list:${stream}`);
      if (options.listed instanceof Error) throw options.listed;
      return (options.listed ?? []).map(hook => ({ url: HOOK_URL, stream: 'broadcast', username: 'conn', password: null, status: null, ...hook }) as PostmarkWebhook);
    },
    createWebhook: async () => { calls.push('create'); throw new Error('never'); },
    deleteWebhook: async () => { calls.push('delete'); },
    verifyWebhook: async id => { calls.push(`verify:${id}`); if (options.verify instanceof Error) throw options.verify; return options.verify ?? { verified: true }; },
  };
  const protection = new MemoryProtectionStore(counts({ mode: 'off', goLiveApprovedAt: null }));
  // As 0156: needs_webhook unless the application's own check said the webhook is verified.
  protection.command = async (_token, _ws, action, terms, webhookOk) => { protection.commands.push({ action, terms, webhookOk }); return webhookOk ? 'requested' : 'needs_webhook'; };
  const tokens: string[] = [];
  const service = new OwnerSendingService({ protection, vault,
    connections: { sealed: async () => ({ serverToken: sealed === 'ok' ? vault.seal(PP_WS, 'server_token', SERVER_TOKEN) : sealed === 'garbage' ? 'not-a-sealed-value' : null, webhookSecret: null }) } as never,
    serverApi: token => { tokens.push(token); return api; }, log: line => logs.push(line), mailer: () => true });
  const connection = { status: 'verified', webhookId: options.webhookId === undefined ? 4321 : options.webhookId, stream: 'broadcast' } as EmailConnectionState;
  const goLive = () => service.command(owner, connection, 'live');
  const lines = () => logs.map(line => JSON.parse(line) as Record<string, unknown>).filter(line => line.event === 'email.protection.go_live_webhook');
  const clean = () => {
    for (const line of logs) for (const value of [SERVER_TOKEN, SECRET, KEY, HOOK_URL, 'https:', 'pp-send-proof']) assert.equal(line.includes(value), false, `no ${value} in the log`);
  };
  return { service, protection, calls, logs, lines, goLive, clean, tokens };
}

test('go live: listed with Status verified (any letter case read by the client) is confirmed at once, with no verify call and no log line', async () => {
  const u = unit({ listed: [{ id: 99, status: 'unverified' }, { id: 4321, status: 'verified', statusPresent: true }] });
  const result = await u.goLive();
  assert.equal(result.ok, true); assert.match(result.message, /Waiting for approval/u);
  assert.equal(result.bounceRepair, undefined);
  assert.deepEqual(u.protection.commands.at(-1)!.webhookOk, true);
  assert.deepEqual(u.calls, ['list:broadcast'], 'read only');
  assert.deepEqual(u.lines(), []);
  assert.deepEqual(u.tokens, [SERVER_TOKEN], 'with the connection\'s own server token');
});

test('go live: Status absent, verify passes: Postmark is asked to verify once and go-live proceeds; logged as verified_after_verify', async () => {
  const u = unit({ listed: [{ id: 4321, status: null, statusPresent: false }], verify: { verified: true } });
  const result = await u.goLive();
  assert.equal(result.ok, true);
  assert.equal(u.protection.commands.at(-1)!.webhookOk, true);
  assert.deepEqual(u.calls, ['list:broadcast', 'verify:4321'], 'one verify of the stored id; nothing created, edited or deleted');
  assert.deepEqual(u.lines(), [{ event: 'email.protection.go_live_webhook', level: 'info', workspace: PP_WS.slice(0, 8), confirmed: true, reason: 'verified_after_verify', statusPresent: false }]);
  u.clean();
});

test('go live: Status absent, verify fails: refused with the Repair offer and the failing triggers logged', async () => {
  const u = unit({ listed: [{ id: 4321, status: null, statusPresent: false }], verify: { verified: false, failing: [{ trigger: 'Bounce', status: 401 }, { trigger: 'SubscriptionChange', status: null }] } });
  const result = await u.goLive();
  assert.deepEqual(result, { ok: false, message: SENDING_MESSAGES.needsWebhook, bounceRepair: true });
  assert.equal(SENDING_MESSAGES.needsWebhook, 'We couldn\'t confirm the email service will tell us about bounces. Press Repair bounce reporting below, then press Go live again.');
  assert.equal(u.protection.commands.at(-1)!.webhookOk, false);
  assert.deepEqual(u.calls, ['list:broadcast', 'verify:4321']);
  assert.deepEqual(u.lines(), [{ event: 'email.protection.go_live_webhook', level: 'warn', workspace: PP_WS.slice(0, 8), confirmed: false, reason: 'verify_failed', statusPresent: false,
    failing: [{ trigger: 'Bounce', status: 401 }, { trigger: 'SubscriptionChange', status: null }] }]);
  u.clean();
});

test('go live: Status unverified is verified once too; a verify that errors is verify_error with its category', async () => {
  const ok = unit({ listed: [{ id: 4321, status: 'unverified', statusPresent: true }], verify: { verified: true } });
  assert.equal((await ok.goLive()).ok, true);
  assert.deepEqual(ok.lines().map(l => [l.reason, l.statusPresent]), [['verified_after_verify', true]]);
  const broken = unit({ listed: [{ id: 4321, status: 'unverified', statusPresent: true }], verify: new PostmarkAccountError('timeout') });
  assert.equal((await broken.goLive()).bounceRepair, true);
  assert.deepEqual(broken.lines().map(l => [l.reason, l.category, l.httpStatus, l.statusPresent]), [['verify_error', 'timeout', null, true]]);
});

test('go live: a list that fails, a stored id not listed, no stored id and a token that cannot be opened are each refused and logged, with no verify', async () => {
  const cases: [string, Parameters<typeof unit>[0], Record<string, unknown>][] = [
    ['list fails', { listed: new PostmarkAccountError('busy', 503) }, { reason: 'list_failed', category: 'busy', httpStatus: 503 }],
    ['list throws something else', { listed: new Error('socket hang up') }, { reason: 'list_failed', category: 'unexpected', httpStatus: null }],
    ['not listed', { listed: [{ id: 77, status: 'verified' }] }, { reason: 'not_listed' }],
    ['no stored id', { webhookId: null, listed: [{ id: 4321, status: 'verified' }] }, { reason: 'no_webhook_id' }],
    ['no token saved', { sealed: 'none', listed: [{ id: 4321, status: 'verified' }] }, { reason: 'no_token' }],
    ['token cannot be opened', { sealed: 'garbage', listed: [{ id: 4321, status: 'verified' }] }, { reason: 'no_token' }],
  ];
  for (const [name, options, expected] of cases) {
    const u = unit(options);
    const result = await u.goLive();
    assert.deepEqual([result.ok, result.message, result.bounceRepair], [false, SENDING_MESSAGES.needsWebhook, true], name);
    assert.equal(u.protection.commands.at(-1)!.webhookOk, false, name);
    assert.equal(u.calls.some(c => c.startsWith('verify') || c === 'create' || c === 'delete'), false, `${name}: no verify, create or delete`);
    const lines = u.lines();
    assert.equal(lines.length, 1, name);
    assert.deepEqual({ ...lines[0], event: undefined, level: undefined, workspace: undefined, confirmed: undefined },
      { event: undefined, level: undefined, workspace: undefined, confirmed: undefined, ...expected }, name);
    assert.deepEqual([lines[0]!.level, lines[0]!.workspace, lines[0]!.confirmed], ['warn', PP_WS.slice(0, 8), false], name);
    u.clean();
  }
});

test('the other owner commands never ask Postmark about the webhook', async () => {
  const u = unit({ listed: [{ id: 4321, status: 'verified' }] });
  for (const action of ['test', 'pause', 'resume'] as const) await u.service.command(owner, { status: 'verified', webhookId: 4321, stream: 'broadcast' } as EmailConnectionState, action);
  assert.deepEqual(u.calls, []);
});

// ---------- the page: "Repair bounce reporting" ----------

async function page() {
  const postmark = new FakePostmark(), store = new MemoryEmailConnectionStore(new Set([OWNER_SESSION]), { [OWNER_SESSION]: 'Pat Owner' });
  const config = loadEmailConnectConfig({ EMAIL_CONNECT: 'enabled', POSTMARK_ACCOUNT_TOKEN: ACCOUNT_TOKEN, EMAIL_CONNECTION_KEY: KEY }, { portalBaseUrl: ORIGIN });
  const logs: string[] = [];
  let secret = SECRET;
  const service = new EmailConnectionService({ config, store, account: createPostmarkAccountApi({ accountToken: ACCOUNT_TOKEN, fetch: postmark.fetch }),
    resolver: fakeResolver({}), secret: () => secret, lockWaitMs: 2000, log: line => logs.push(line) });
  const protection = new MemoryProtectionStore(counts({ mode: 'off', goLiveApprovedAt: null }));
  protection.command = async (_token, _ws, action, terms, webhookOk) => { protection.commands.push({ action, terms, webhookOk }); return webhookOk ? 'requested' : 'needs_webhook'; };
  const sending = new OwnerSendingService({ protection, connections: store, vault: new EmailConnectionVault(Buffer.from(KEY, 'base64')), fetcher: postmark.fetch,
    log: line => logs.push(line), mailer: () => true });
  const call = async (method: 'GET' | 'POST', path: string, fields?: Record<string, string>) => {
    const body = fields ? new URLSearchParams(fields).toString() : '';
    const captured = { status: 0, body: '' };
    const req = Object.assign(Readable.from(body ? [Buffer.from(body)] : []), { method, url: path,
      headers: { host: 'growth.relaunch72-test.co.uk', ...(method === 'POST' ? { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' } : {}) } }) as unknown as IncomingMessage;
    const res = { writeHead(status: number) { captured.status = status; }, end(text = '') { captured.body = String(text); } } as unknown as ServerResponse;
    assert.equal(await handleEmailConnection(req, res, new URL(path, ORIGIN), { portal, service, identity: owner, sending }), true);
    return captured;
  };
  const form = { csrf: portalCsrfToken(SESSION_SECRET, OWNER_SESSION), commandId: '6f0d8f2a-3b1c-4d5e-8f90-123456789abc' };
  await call('POST', '/portal/email/connect', { ...form, fromName: 'Property Predator', fromAddress: 'hello@pp-send-proof.co.uk', replyTo: '', agree: 'yes' });
  for (const domain of postmark.domains) { domain.dkimVerified = true; domain.returnPathVerified = true; }
  await call('POST', '/portal/email/check', form);
  assert.equal(store.row!.status, 'verified');
  const hooks = () => postmark.servers[0]!.webhooks;
  const writes = () => postmark.calls.filter(c => c.method !== 'GET' && c.path.startsWith('/webhooks')).map(c => `${c.method} ${c.path.replace(/[0-9]+/gu, 'N')}`);
  const repairLines = () => logs.map(line => JSON.parse(line) as Record<string, unknown>).filter(line => line.event === 'email.connections.bounce_repair');
  return { postmark, store, protection, call, form, hooks, writes, logs, repairLines, setSecret: (value: string) => { secret = value; } };
}

const repairButton = /action="\/portal\/email\/repair-bounces"[^>]*>[^]*?<button type="submit" class="secondary">Repair bounce reporting<\/button>/u;
const buttons = (html: string) => [...html.matchAll(/<button type="submit"[^>]*>([^<]+)<\/button>/gu)].map(m => m[1]);

test('the Repair bounce reporting button appears only after Go live could not confirm the webhook, and the message names buttons that are on the page', async () => {
  const h = await page();
  let response = await h.call('GET', '/portal/email');
  assert.doesNotMatch(response.body, /Repair bounce reporting|repair-bounces/u, 'not offered on an ordinary page');
  h.postmark.statusField = 'absent';
  h.postmark.verify = async () => false;
  response = await h.call('POST', '/portal/email/go-live', h.form);
  assert.equal(response.status, 409);
  assert.ok(response.body.includes('We couldn&#39;t confirm the email service will tell us about bounces. Press Repair bounce reporting below, then press Go live again.'));
  assert.match(response.body, repairButton);
  const shown = buttons(response.body);
  for (const named of ['Repair bounce reporting', 'Go live']) assert.ok(shown.includes(named), `${named} is on the page`);
  assert.equal(shown.includes('Repair'), false, 'no button called just "Repair" is promised or shown');
  assert.doesNotMatch(response.body, /Postmark|https:\/\/api|ErrorCode/u);
  // The refusal was logged with its reason; nothing was created or deleted by Go live.
  const line = h.logs.map(l => JSON.parse(l) as Record<string, unknown>).find(l => l.event === 'email.protection.go_live_webhook')!;
  assert.deepEqual([line.reason, line.statusPresent, line.failing], ['verify_failed', false, [{ trigger: 'Bounce', status: 401 }]]);
  assert.deepEqual(h.writes(), ['POST /webhooks', 'POST /webhooks/N/verify'], 'Connect\'s create, then only a verify');
});

test('Repair bounce reporting: a listed webhook that can now be verified is verified in place (nothing created or deleted), then Go live proceeds', async () => {
  const h = await page();
  const before = h.hooks().map(hook => hook.id);
  h.hooks()[0]!.status = 'unverified';
  h.postmark.verify = async () => false;
  let response = await h.call('POST', '/portal/email/go-live', h.form);
  assert.match(response.body, repairButton);
  // Still failing: said plainly, and the button stays.
  response = await h.call('POST', '/portal/email/repair-bounces', h.form);
  assert.equal(response.status, 200);
  assert.ok(response.body.includes(EMAIL_CONNECTION_MESSAGES.bounceStillFailing.replace(/'/gu, '&#39;')));
  assert.match(response.body, repairButton);
  // Fixed at our end: the repair verifies the same webhook.
  h.postmark.verify = async () => true;
  response = await h.call('POST', '/portal/email/repair-bounces', h.form);
  assert.ok(response.body.includes('Bounce reporting is working again. Press Go live again.'));
  assert.doesNotMatch(response.body, /repair-bounces/u, 'the button goes once it is confirmed');
  assert.deepEqual(h.hooks().map(hook => [hook.id, hook.status]), [[before[0], 'verified']]);
  assert.deepEqual(h.writes(), ['POST /webhooks', 'POST /webhooks/N/verify', 'POST /webhooks/N/verify', 'POST /webhooks/N/verify'], 'no create, edit or delete');
  assert.equal(h.store.row!.status, 'verified', 'the connection is untouched');
  assert.deepEqual(h.repairLines().map(l => [l.reason, l.confirmed]), [['verify_failed', false], ['verified_after_verify', true]]);
  response = await h.call('POST', '/portal/email/go-live', h.form);
  assert.equal(h.protection.commands.at(-1)!.webhookOk, true);
  assert.match(response.body, /Waiting for approval/u);
  // Already working: said so, and nothing is called but the list.
  const writes = h.writes().length;
  response = await h.call('POST', '/portal/email/repair-bounces', h.form);
  assert.ok(response.body.includes('Bounce reporting is working. Press Go live again.'));
  assert.equal(h.writes().length, writes);
});

test('Repair bounce reporting: a webhook gone at Postmark is made again by the existing repair, once, with its secret in force first; then Check and Go live', async () => {
  const h = await page();
  h.hooks().length = 0;
  let response = await h.call('POST', '/portal/email/go-live', h.form);
  assert.match(response.body, repairButton);
  h.setSecret('whsec-after-repair-0123456789-abcdefghijkl');
  response = await h.call('POST', '/portal/email/repair-bounces', h.form);
  assert.equal(response.status, 200);
  assert.ok(response.body.includes('Bounce reporting was set up again. Press Check below to confirm your records, then send a test to yourself and press Go live.'));
  assert.deepEqual(h.hooks().map(hook => [hook.url, hook.password]), [[HOOK_URL, 'whsec-after-repair-0123456789-abcdefghijkl']], 'one webhook at our address, with the new secret');
  assert.equal(h.store.row!.webhookId, h.hooks()[0]!.id, 'its id is saved');
  assert.equal(h.store.row!.status, 'dns_pending');
  // The domain was adopted with both records found: the page says so and names the Check button it shows.
  assert.match(response.body, /Your 2 records are already in place/u);
  assert.ok(buttons(response.body).includes('Check'));
  assert.deepEqual(h.repairLines().map(l => [l.outcome, l.reason]), [['remade', 'not_listed']]);
  // A second press while waiting for Check: the webhook is listed now, so nothing is made again.
  const count = h.postmark.count('POST', /^\/webhooks$/u);
  response = await h.call('POST', '/portal/email/repair-bounces', h.form);
  assert.ok(response.body.includes('Bounce reporting is working. Press Check below to finish connecting.'), 'names Check, the button on this screen');
  assert.ok(buttons(response.body).includes('Check'));
  assert.equal(h.postmark.count('POST', /^\/webhooks$/u), count);
  // Still failing while waiting for Check: the repair button is on this screen too.
  h.postmark.servers[0]!.webhooks[0]!.status = 'unverified';
  h.postmark.verify = async () => false;
  response = await h.call('POST', '/portal/email/repair-bounces', h.form);
  assert.match(response.body, repairButton);
  h.postmark.verify = async () => true;
  await h.call('POST', '/portal/email/check', h.form);
  assert.equal(h.store.row!.status, 'verified');
  await h.call('POST', '/portal/email/go-live', h.form);
  assert.equal(h.protection.commands.at(-1)!.webhookOk, true);
});

test('Repair bounce reporting: no stored webhook id, or our webhook moved to another address, is remade without leaving a second webhook', async () => {
  const h = await page();
  h.hooks()[0]!.url = 'https://old-origin.relaunch72-test.co.uk/api/provider-webhooks/postmark/conn-d975ff66336a46c2b36bd7095a11af97';
  await h.call('POST', '/portal/email/repair-bounces', h.form);
  assert.deepEqual(h.hooks().map(hook => hook.url), [HOOK_URL], 'the old one deleted, one at our address');
  assert.deepEqual(h.repairLines().map(l => l.reason), ['other_address']);
  await h.call('POST', '/portal/email/check', h.form);
  h.store.row!.webhookId = null;
  await h.call('POST', '/portal/email/repair-bounces', h.form);
  assert.equal(h.hooks().length, 1);
  assert.equal(h.store.row!.webhookId, h.hooks()[0]!.id);
  assert.deepEqual(h.repairLines().map(l => l.reason), ['other_address', 'no_webhook_id']);
  for (const line of h.logs) for (const value of [SECRET, KEY, ACCOUNT_TOKEN, ...h.postmark.servers.map(s => s.token), 'https:']) assert.equal(line.includes(value), false, 'no secret, token or URL logged');
});

test('Repair bounce reporting is only for an owner, same origin and CSRF, and only once records exist', async () => {
  const h = await page();
  assert.equal((await h.call('POST', '/portal/email/repair-bounces', { ...h.form, csrf: 'wrong' })).status, 403);
  assert.equal((await h.call('POST', '/portal/email/repair-bounces', { ...h.form, extra: '1' })).status, 400);
  await h.call('POST', '/portal/email/disconnect', h.form);
  const response = await h.call('POST', '/portal/email/repair-bounces', h.form);
  assert.ok(response.body.includes(EMAIL_CONNECTION_MESSAGES.nothingToCheck));
  assert.equal(h.hooks().length, 0, 'nothing made for a disconnected business');
});
