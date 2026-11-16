/**
 * "Connect email" stage 2 (the database allow-list, 0157) without a database:
 *   1. The snapshot: read before composition, refreshed, a failed refresh keeps the last good list, a first failure is
 *      the static list (never nothing), 0157 absent is the static list (one informational line), ids lower case.
 *   2. Differential: with 0157 absent, and with 0157 present and only Property Predator allowed, Property Predator's
 *      pages, Postmark calls and bounce source are byte-identical to the static list's (the stage-1 golden literals).
 *   3. A business switched off keeps its bounce source (it follows the stored row) in a running and a fresh process.
 *   4. The founder's page: "Invite a business", "Switch email off for this business" behind a confirm step on the page,
 *      "Allow again"; founder and CSRF checked on every action; one primary button per section; plain answers.
 *   5. The new hold: 'not_allowed' with its plain wording, and the environment sender is Property Predator's only.
 * Every value is synthetic.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { EmailBounceService } from '../src/email-bounces/index.js';
import {
  ALLOWLIST_MESSAGES, connectionServerName, connectionSourceKey, createPostmarkAccountApi, databaseEligibility, EMAIL_CONNECT_BUSINESSES, EMAIL_CONNECT_NOT_ALLOWED,
  EMAIL_CONNECTION_MESSAGES, EmailConnectAllowlistAbsentError, EmailConnectAllowlistService, EmailConnectionBounceSources, EmailConnectionService, loadEmailConnectConfig,
  PgEmailConnectAllowlist, staticEligibility, type AllowlistView, type AllowOutcome, type EmailConnectAllowlistStore, type EmailConnectEligibility, type EmailConnectionState,
  type ReallowOutcome, type RevokeOutcome, type StoredConnectionSource,
} from '../src/email-connections/index.js';
import { handleEmailConnection } from '../src/portal/email-connection-router.js';
import { emailConnectionBusinessAllowed } from '../src/portal/router.js';
import { holdBanner, OwnerSendingService, SENDING_MESSAGES, stillHeld } from '../src/email-protection/owner.js';
import { ownerBanner } from '../src/email-protection/messages.js';
import { sendingDecision, sendingPlan } from '../src/email-protection/sending.js';
import { readSendingConfig } from '../src/email-protection/store.js';
import { portalCsrfToken } from '../src/portal/session.js';
import { ACCOUNT_TOKEN, FakePostmark, fakeResolver, MemoryEmailConnectionStore, OWNER_SESSION, PP_WS } from './email-connections-fixtures.js';
import { counts, FOUNDER, MemoryProtectionStore } from './email-protection-fixtures.js';

const PP = PP_WS;
const SECOND = 'a1b2c3d4-0000-4000-8000-000000000002';
const ORIGIN = 'https://growth.relaunch72-test.co.uk';
const SESSION_SECRET = 'portal-session-secret-for-tests-0123456789';
const KEY = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8').toString('base64');
const ENV = { EMAIL_CONNECT: 'enabled', POSTMARK_ACCOUNT_TOKEN: ACCOUNT_TOKEN, EMAIL_CONNECTION_KEY: KEY };
const SECRET = 'whsec-synthetic-0123456789-abcdefghijklmnop';
const owner = { sessionToken: OWNER_SESSION, userId: '00000000-0000-4000-8000-000000000001', workspaceId: PP, userEmail: 'owner@relaunch72-test.co.uk' };
const founderIdentity = { ...owner, sessionToken: FOUNDER, userId: '00000000-0000-4000-8000-000000000002' };
const portal = { productProfile: { id: 'property_predator_growth' } as never, portalBaseUrl: ORIGIN, sessionSecret: SESSION_SECRET };
const COMMAND = '6f0d8f2a-3b1c-4d5e-8f90-123456789abc';

/** A fake 0157 read: the rows it answers, null for "0157 absent", or an Error to throw. */
const source = (answer: () => readonly { workspaceId: string; name: string }[] | null | Error) => ({
  calls: 0,
  async active() { this.calls++; const a = answer(); if (a instanceof Error) throw a; return a; },
});
const PP_ROW = { workspaceId: PP, name: 'Property Predator' };

// ---------- 1. the snapshot ----------

test('the database eligibility: loaded before it is used, refreshed, a failed read keeps the last good list, ids lower case', async () => {
  let answer: readonly { workspaceId: string; name: string }[] | null | Error = [PP_ROW, { workspaceId: SECOND.toUpperCase(), name: 'Second Business' }];
  const s = source(() => answer);
  const lines: string[] = [];
  const eligibility = await databaseEligibility({ active: async () => { const rows = await s.active(); return rows && rows.map(r => ({ ...r, workspaceId: r.workspaceId.toLowerCase() })); } },
    { log: line => lines.push(line) });
  assert.equal(s.calls, 1, 'read once before anything is composed with it');
  assert.equal(eligibility.fromDatabase, true);
  assert.deepEqual(eligibility.list().map(b => b.workspaceId), [PP, SECOND]);
  assert.equal(eligibility.allowed(SECOND.toUpperCase()), true, 'any letter case');
  assert.deepEqual({ ...eligibility.business(SECOND)! }, { workspaceId: SECOND, name: 'Second Business', sourceKey: connectionSourceKey(SECOND), replacesSourceKey: null });
  // Switched off: the next read drops it.
  answer = [PP_ROW];
  await eligibility.refresh();
  assert.equal(eligibility.allowed(SECOND), false);
  // A failed read keeps the last good list, and says so once per failure run.
  answer = new Error('connection refused');
  await eligibility.refresh(); await eligibility.refresh();
  assert.deepEqual(eligibility.list().map(b => b.workspaceId), [PP]);
  assert.equal(eligibility.fromDatabase, true);
  assert.deepEqual(lines.map(line => JSON.parse(line).event), ['email.connections.allowlist_refresh_failed']);
  // The founder switched every business off: honoured (bounce sources do not depend on it, see below).
  answer = [];
  await eligibility.refresh();
  assert.deepEqual(eligibility.list(), []);
  // Two refreshes at once share one read.
  answer = [PP_ROW];
  const before = s.calls;
  await Promise.all([eligibility.refresh(), eligibility.refresh()]);
  assert.equal(s.calls, before + 1);
});

test('the database eligibility never composes with nothing: a first read that fails is the static list until a read works', async () => {
  let answer: readonly { workspaceId: string; name: string }[] | Error = new Error('down');
  const eligibility = await databaseEligibility(source(() => answer));
  assert.equal(eligibility.fromDatabase, false);
  assert.deepEqual(eligibility.list(), EMAIL_CONNECT_BUSINESSES);
  answer = [PP_ROW, { workspaceId: SECOND, name: 'Second Business' }];
  await eligibility.refresh();
  assert.equal(eligibility.fromDatabase, true);
  assert.equal(eligibility.allowed(SECOND), true);
});

test('0157 absent: exactly the static list and its messages, one informational line, and applying 0157 takes effect without a restart', async () => {
  let present = false;
  const lines: string[] = [];
  const pool = { query: async (sql: string) => {
    if (!present) throw Object.assign(new Error('function does not exist'), { code: '42883' });
    assert.match(sql, /app_private\.email_connect_allowlist_active\(\)/u);
    return { rows: [{ value: [{ workspaceId: PP.toUpperCase(), name: 'Property Predator' }] }] };
  } } as never;
  const store = new PgEmailConnectAllowlist(pool, { log: line => lines.push(line) });
  const eligibility = await databaseEligibility(store);
  await eligibility.refresh(); await eligibility.refresh();
  assert.equal(eligibility.fromDatabase, false);
  assert.equal(eligibility.list(), EMAIL_CONNECT_BUSINESSES, 'the very same list');
  assert.deepEqual(lines.map(line => JSON.parse(line)), [{ event: 'email.connections.allowlist_absent', level: 'info',
    message: 'The email allow-list (0157) is not in this database yet; Connect email stays Property Predator only.' }]);
  await assert.rejects(store.founderView('x'), EmailConnectAllowlistAbsentError);
  present = true;
  await eligibility.refresh();
  assert.equal(eligibility.fromDatabase, true);
  assert.deepEqual(eligibility.list(), EMAIL_CONNECT_BUSINESSES, 'Property Predator, lower case, by the same name');
});

test('a malformed allow-list answer is a failed read (the last good list is kept)', async () => {
  let rows: unknown = [{ workspaceId: PP, name: 'Property Predator' }];
  const store = new PgEmailConnectAllowlist({ query: async () => ({ rows: [{ value: rows }] }) } as never);
  const eligibility = await databaseEligibility(store);
  for (const bad of [{}, [{ workspaceId: 'nope', name: 'X Y' }], [{ workspaceId: SECOND, name: '<script>' }], [{ workspaceId: SECOND }]]) {
    rows = bad;
    await assert.rejects(store.active(), /Invalid email allow-list/u);
    await eligibility.refresh();
    assert.deepEqual(eligibility.list(), EMAIL_CONNECT_BUSINESSES);
  }
});

// ---------- 2. differential: Property Predator identical with 0157 absent, and present with only PP allowed ----------

async function ppRun(eligibility: EmailConnectEligibility) {
  const postmark = new FakePostmark(), store = new MemoryEmailConnectionStore();
  const service = new EmailConnectionService({ config: loadEmailConnectConfig(ENV, { portalBaseUrl: ORIGIN }), store, eligibility,
    account: createPostmarkAccountApi({ accountToken: ACCOUNT_TOKEN, fetch: postmark.fetch }), resolver: fakeResolver(), secret: () => SECRET, lockWaitMs: 2000 });
  const bounces = new EmailBounceService({ config: { sources: [], blockers: [] }, apiFor: () => null });
  const sources = new EmailConnectionBounceSources({ store, vault: loadEmailConnectConfig(ENV, { portalBaseUrl: ORIGIN }).vault, service: bounces, eligibility });
  const call = async (method: 'GET' | 'POST', path: string, fields?: Record<string, string>, identity = owner) => {
    const body = fields ? new URLSearchParams(fields).toString() : '';
    const captured = { status: 0, body: '' };
    const req = Object.assign(Readable.from(body ? [Buffer.from(body)] : []), { method, url: path,
      headers: { host: 'growth.relaunch72-test.co.uk', ...(method === 'POST' ? { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' } : {}) } }) as unknown as IncomingMessage;
    const res = { writeHead(status: number) { captured.status = status; }, end(text = '') { captured.body = String(text); } } as unknown as ServerResponse;
    assert.equal(await handleEmailConnection(req, res, new URL(path, ORIGIN), { portal, service, identity }), true);
    return { status: captured.status, body: captured.body.replace(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gu, '<uuid>') };
  };
  const csrf = portalCsrfToken(SESSION_SECRET, OWNER_SESSION);
  const pages = [await call('GET', '/portal/email'), await call('GET', `/portal/email?business=${PP}`), await call('GET', '/portal/email?agree=yes'),
    await call('POST', '/portal/email/connect', { csrf, commandId: COMMAND, fromName: 'Property Predator', fromAddress: 'hello@propertypredator-test.co.uk', replyTo: '', agree: 'yes' })];
  for (const domain of postmark.domains) { domain.dkimVerified = true; domain.returnPathVerified = true; }
  pages.push(await call('POST', '/portal/email/check', { csrf, commandId: COMMAND }), await call('GET', '/portal/email'));
  await sources.refresh();
  const source = bounces.dynamicSourceKeys().map(key => key);
  return { pages, calls: postmark.calls.map(c => ({ method: c.method, path: c.path, body: c.body })), servers: postmark.servers.map(s => s.name),
    webhooks: postmark.servers.flatMap(s => s.webhooks.map(w => [w.url, w.username])), domains: postmark.domains.map(d => [d.name, d.returnPath]), source,
    home: emailConnectionBusinessAllowed({ emailConnections: service } as never, PP), events: store.events };
}

test('differential: Property Predator\'s pages, Postmark calls and bounce source are identical with 0157 absent and with 0157 present and only Property Predator allowed', async () => {
  const absent = await databaseEligibility(source(() => null));
  const present = await databaseEligibility(source(() => [PP_ROW]));
  assert.deepEqual([absent.fromDatabase, present.fromDatabase], [false, true]);
  const runs = [await ppRun(staticEligibility), await ppRun(absent), await ppRun(present)];
  assert.ok(runs[0]!.calls.length > 5, 'the run really talked to (fake) Postmark');
  // The stage-1 golden literals (printed against ca0c217).
  assert.deepEqual(runs[0]!.servers, ['Relaunch72 - Property Predator - d975ff66336a46c2b36bd7095a11af97']);
  assert.deepEqual(runs[0]!.webhooks, [['https://growth.relaunch72-test.co.uk/api/provider-webhooks/postmark/conn-d975ff66336a46c2b36bd7095a11af97', 'conn-d975ff66336a46c2b36bd7095a11af97']]);
  assert.deepEqual(runs[0]!.domains, [['propertypredator-test.co.uk', 'pm-b5c317a5b3.propertypredator-test.co.uk']]);
  assert.deepEqual(runs[0]!.source, ['conn-d975ff66336a46c2b36bd7095a11af97']);
  assert.equal(runs[0]!.home, true);
  for (const run of runs.slice(1)) assert.deepEqual(run, runs[0]);
  assert.equal(connectionServerName(present.business(PP)!), connectionServerName(staticEligibility.business(PP)!));
});

test('the refusal names Property Predator only while 0157 is absent; with 0157 it is generic', async () => {
  const second = { ...owner, workspaceId: SECOND, sessionToken: 'second-session-0123456789abcdef' };
  for (const [eligibility, text] of [[staticEligibility, EMAIL_CONNECT_NOT_ALLOWED.static], [await databaseEligibility(source(() => null)), EMAIL_CONNECT_NOT_ALLOWED.static],
    [await databaseEligibility(source(() => [PP_ROW])), EMAIL_CONNECT_NOT_ALLOWED.database]] as const) {
    const service = new EmailConnectionService({ config: loadEmailConnectConfig(ENV, { portalBaseUrl: ORIGIN }), store: new MemoryEmailConnectionStore(), eligibility,
      account: createPostmarkAccountApi({ accountToken: ACCOUNT_TOKEN, fetch: new FakePostmark().fetch }), resolver: fakeResolver() });
    await assert.rejects(service.view(second), (error: { status?: number; code?: string; message?: string }) => error.status === 403 && error.code === 'not_allowed' && error.message === text);
    const captured = { status: 0, body: '' };
    const req = Object.assign(Readable.from([]), { method: 'GET', url: `/portal/email?business=${SECOND}`, headers: { host: 'growth.relaunch72-test.co.uk' } }) as unknown as IncomingMessage;
    const res = { writeHead(status: number) { captured.status = status; }, end(body = '') { captured.body = String(body); } } as unknown as ServerResponse;
    await handleEmailConnection(req, res, new URL(`/portal/email?business=${SECOND}`, ORIGIN), { portal, service, identity: second });
    assert.equal(captured.status, 404);
    assert.ok(captured.body.includes(text.replace(/'/gu, '&#39;')) || captured.body.includes(text), captured.body);
  }
  assert.equal(EMAIL_CONNECTION_MESSAGES.notAllowed, EMAIL_CONNECT_NOT_ALLOWED.static, 'today\'s text, unchanged');
  assert.equal(EMAIL_CONNECT_NOT_ALLOWED.database, 'Email isn\'t switched on for this business yet. Ask the platform owner.');
});

// ---------- 3. bounce sources follow the stored row ----------

test('a business switched off keeps its bounce webhook in a running process and in one started later, for as long as its row exists', async () => {
  const vault = loadEmailConnectConfig(ENV, { portalBaseUrl: ORIGIN }).vault!;
  const row: StoredConnectionSource = { workspaceId: SECOND, serverId: '901', stream: 'broadcast',
    sealedServerToken: vault.seal(SECOND, 'server_token', 'srv-second-0123456789abcdef'), sealedWebhookSecret: vault.seal(SECOND, 'webhook_secret', 'whsec-second-0123456789-abcdefghijkl') };
  let rows: StoredConnectionSource[] = [row];
  let listed = [PP_ROW, { workspaceId: SECOND, name: 'Second Business' }];
  const store = { sources: async () => rows } as never;
  const running = await databaseEligibility(source(() => listed));
  const bounces = new EmailBounceService({ config: { sources: [], blockers: [] }, apiFor: () => null });
  const sources = new EmailConnectionBounceSources({ store, vault, service: bounces, eligibility: running, refreshEligibility: () => running.refresh() });
  await sources.refresh();
  assert.deepEqual(bounces.dynamicSourceKeys(), [connectionSourceKey(SECOND)]);
  // The founder switches it off: the tick reads the list (it is gone) and the rows (still there): the source stays.
  listed = [PP_ROW];
  await sources.refresh();
  assert.equal(running.allowed(SECOND), false, 'the tick read the list too');
  assert.deepEqual(bounces.dynamicSourceKeys(), [connectionSourceKey(SECOND)], 'running: still answered');
  // A process started now, with the list as it is.
  const fresh = await databaseEligibility(source(() => listed));
  const bounces2 = new EmailBounceService({ config: { sources: [], blockers: [] }, apiFor: () => null });
  const sources2 = new EmailConnectionBounceSources({ store, vault, service: bounces2, eligibility: fresh, refreshEligibility: () => fresh.refresh() });
  assert.equal(sources2.handles(connectionSourceKey(SECOND)), true, 'its address is looked up on demand');
  await sources2.refreshNow();
  assert.deepEqual(bounces2.dynamicSourceKeys(), [connectionSourceKey(SECOND)], 'restarted: still answered');
  // Only when the row itself goes (disconnected) does the source go.
  rows = [];
  await sources.refresh(); await sources2.refresh();
  assert.deepEqual([bounces.dynamicSourceKeys(), bounces2.dynamicSourceKeys()], [[], []]);
  assert.equal(sources.handles('pp'), false);
});

// ---------- 4. the founder's page ----------

class MemoryAllowlist implements EmailConnectAllowlistStore {
  rows: { workspaceId: string; name: string; revokedAt: string | null; reason: string | null }[] = [{ workspaceId: PP, name: 'Property Predator', revokedAt: null, reason: null }];
  candidates = [{ workspaceId: SECOND, name: 'Second <Business>' }];
  readonly actions: string[] = [];
  private founder(token: string) { if (token !== FOUNDER) throw Object.assign(new Error('x'), { code: '42501' }); }
  async active() { return this.rows.filter(r => !r.revokedAt).map(r => ({ workspaceId: r.workspaceId, name: r.name })); }
  async founderView(token: string): Promise<AllowlistView> {
    this.founder(token);
    return { businesses: this.rows.map(r => ({ workspaceId: r.workspaceId, name: r.name, businessName: r.workspaceId === PP ? 'Property Predator Growth HQ' : null, allowedAt: '2026-11-16T09:00:00Z',
      allowedByName: r.workspaceId === PP ? null : 'Fay Founder', revokedAt: r.revokedAt, revokedByName: r.revokedAt ? 'Fay Founder' : null, revokedReason: r.reason, note: null,
      hasConnection: r.workspaceId === PP, status: r.workspaceId === PP ? 'verified' : null, mode: r.workspaceId === PP ? 'live' as const : null, protectionState: 'ok' })),
      candidates: this.candidates.filter(c => !this.rows.some(r => r.workspaceId === c.workspaceId)) };
  }
  async allow(token: string, ws: string): Promise<AllowOutcome> {
    this.founder(token); this.actions.push(`allow:${ws}`);
    const row = this.rows.find(r => r.workspaceId === ws);
    if (row) return row.revokedAt ? 'revoked' : 'already_allowed';
    if (!this.candidates.some(c => c.workspaceId === ws)) return 'no_workspace';
    this.rows.push({ workspaceId: ws, name: 'Second Business', revokedAt: null, reason: null }); return 'allowed';
  }
  async reallow(token: string, ws: string): Promise<ReallowOutcome> {
    this.founder(token); this.actions.push(`reallow:${ws}`);
    const row = this.rows.find(r => r.workspaceId === ws);
    if (!row) return 'not_listed'; if (!row.revokedAt) return 'already_allowed';
    row.revokedAt = null; row.reason = null; return 'reallowed';
  }
  async revoke(token: string, ws: string, reason: string): Promise<RevokeOutcome> {
    this.founder(token); this.actions.push(`revoke:${ws}`);
    if (!reason.trim()) return 'reason_required';
    const row = this.rows.find(r => r.workspaceId === ws);
    if (!row) return 'not_listed'; if (row.revokedAt) return 'already_revoked';
    row.revokedAt = '2026-11-16T10:00:00Z'; row.reason = reason.trim(); return 'revoked';
  }
}

async function founderPage() {
  const list = new MemoryAllowlist();
  const eligibility = await databaseEligibility(list);
  const config = loadEmailConnectConfig(ENV, { portalBaseUrl: ORIGIN });
  const store = new MemoryEmailConnectionStore();
  const service = new EmailConnectionService({ config, store, eligibility, account: createPostmarkAccountApi({ accountToken: ACCOUNT_TOKEN, fetch: new FakePostmark().fetch }), resolver: fakeResolver() });
  const sending = new OwnerSendingService({ eligibility, protection: new MemoryProtectionStore(counts({})), connections: store, vault: config.vault,
    founder: async identity => identity.sessionToken === FOUNDER, portalOrigin: ORIGIN });
  const allowlist = new EmailConnectAllowlistService({ store: list, eligibility, founder: async identity => identity.sessionToken === FOUNDER });
  const call = async (method: 'GET' | 'POST', path: string, fields?: Record<string, string>, identity = founderIdentity, headers: Record<string, string> = {}) => {
    const body = fields ? new URLSearchParams(fields).toString() : '';
    const captured = { status: 0, body: '' };
    const req = Object.assign(Readable.from(body ? [Buffer.from(body)] : []), { method, url: path,
      headers: { host: 'growth.relaunch72-test.co.uk', ...(method === 'POST' ? { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' } : {}), ...headers } }) as unknown as IncomingMessage;
    const res = { writeHead(status: number) { captured.status = status; }, end(text = '') { captured.body = String(text); } } as unknown as ServerResponse;
    assert.equal(await handleEmailConnection(req, res, new URL(path, ORIGIN), { portal, service, identity, sending, allowlist }), true);
    return captured;
  };
  const form = (fields: Record<string, string>, token = FOUNDER) => ({ csrf: portalCsrfToken(SESSION_SECRET, token), commandId: COMMAND, ...fields });
  return { list, eligibility, call, form };
}

/** Every <section> of the allow-list part, with its count of primary (filled) buttons: submit buttons not styled secondary. */
const sections = (html: string) => [...html.slice(html.indexOf('<h2>Who can use email</h2>')).matchAll(/<section[^>]*>([\s\S]*?)<\/section>/gu)].map(m => ({ html: m[1]!,
  primary: (m[1]!.match(/<button type="submit">/gu) ?? []).length }));

test('the founder\'s page: invite a business, switch one off behind a confirm step with a reason, allow it again; one primary button per section', async () => {
  const h = await founderPage();
  let page = await h.call('GET', '/portal/email/founder');
  assert.equal(page.status, 200);
  assert.match(page.body, /<h2 id="invite">Invite a business<\/h2>/u);
  assert.match(page.body, /<option value="a1b2c3d4-0000-4000-8000-000000000002">Second &lt;Business&gt;<\/option>/u, 'names are escaped');
  assert.match(page.body, /<button type="submit">Allow email for this business<\/button>/u);
  // Property Predator's row: its state, and the switch-off behind a disclosure with its own reason field (no browser dialog).
  assert.match(page.body, /<h3>Property Predator <span class="small">\(Property Predator Growth HQ\)<\/span><\/h3><p>Connected and sending marketing emails\.<\/p>/u);
  assert.match(page.body, /<details class="confirm"><summary class="button secondary">Switch email off for this business<\/summary>/u);
  assert.match(page.body, /name="reason" maxlength="300" required><button type="submit">Switch email off for this business<\/button>/u);
  assert.doesNotMatch(page.body, /confirm\(|onclick|<script(?! src="\/portal\/email\/copy\.js")/u, 'no browser confirm dialog, no inline script');
  for (const section of sections(page.body)) assert.ok(section.primary <= 1, section.html);
  assert.equal(sections(page.body)[0]!.primary, 1, 'the invite section has exactly one primary button');
  assert.ok((page.body.match(/name="csrf"/gu) ?? []).length >= 2, 'every form carries the CSRF token');

  // Allow the second business.
  page = await h.call('POST', '/portal/email/founder/allowlist', h.form({ action: 'allow', workspace: SECOND }));
  assert.equal(page.status, 200);
  assert.match(page.body, new RegExp(ALLOWLIST_MESSAGES.allowed.replace(/[.]/gu, '\\.'), 'u'));
  assert.equal(h.eligibility.allowed(SECOND), true, 'this process reads the list again at once');
  assert.match(page.body, /Every one of your businesses can already use email/u);
  // Switch it off: the reason is required (the page's own confirm step carries it).
  page = await h.call('POST', '/portal/email/founder/allowlist', h.form({ action: 'revoke', workspace: SECOND, reason: '' }));
  assert.equal(page.status, 409);
  assert.match(page.body, /Say in a few words why email is being switched off/u);
  page = await h.call('POST', '/portal/email/founder/allowlist', h.form({ action: 'revoke', workspace: SECOND, reason: 'Complaints <from> a bought list' }));
  assert.equal(page.status, 200);
  assert.match(page.body, /Email is switched off for this business\. Nothing more is sent/u);
  assert.match(page.body, /<h2>Switched off<\/h2>/u);
  assert.match(page.body, /Email switched off by Fay Founder on 16 November at \d\d:\d\d: Complaints &lt;from&gt; a bought list/u);
  assert.match(page.body, /<button type="submit">Allow again<\/button>/u);
  assert.equal(h.eligibility.allowed(SECOND), false);
  for (const section of sections(page.body)) assert.ok(section.primary <= 1, section.html);
  // Allowing it with the first button again is refused plainly; "Allow again" is the deliberate action.
  page = await h.call('POST', '/portal/email/founder/allowlist', h.form({ action: 'allow', workspace: SECOND }));
  assert.equal(page.status, 409);
  assert.match(page.body, /To switch it back on, press Allow again below\./u);
  page = await h.call('POST', '/portal/email/founder/allowlist', h.form({ action: 'reallow', workspace: SECOND }));
  assert.equal(page.status, 200);
  assert.match(page.body, /Email is switched back on for this business\./u);
  assert.deepEqual(h.list.actions, [`allow:${SECOND}`, `revoke:${SECOND}`, `revoke:${SECOND}`, `allow:${SECOND}`, `reallow:${SECOND}`]);
});

test('the founder\'s allow-list actions: founder only, CSRF, same origin and exact fields on every one', async () => {
  const h = await founderPage();
  // Not the founder: the page and every action refused, and the store never asked.
  assert.equal((await h.call('GET', '/portal/email/founder', undefined, owner)).status, 403);
  const refused = await h.call('POST', '/portal/email/founder/allowlist', h.form({ action: 'allow', workspace: SECOND }, OWNER_SESSION), owner);
  assert.equal(refused.status, 403);
  assert.match(refused.body, /Only the founder can do this\./u);
  // A wrong CSRF token, another origin, an unknown action, a bad id, a reason on a non-revoke: refused before anything.
  assert.equal((await h.call('POST', '/portal/email/founder/allowlist', { ...h.form({ action: 'allow', workspace: SECOND }), csrf: 'x' })).status, 403);
  assert.equal((await h.call('POST', '/portal/email/founder/allowlist', h.form({ action: 'allow', workspace: SECOND }), founderIdentity, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await h.call('POST', '/portal/email/founder/allowlist', h.form({ action: 'delete', workspace: SECOND }))).status, 400);
  assert.equal((await h.call('POST', '/portal/email/founder/allowlist', h.form({ action: 'allow', workspace: 'not-an-id' }))).status, 400);
  assert.equal((await h.call('POST', '/portal/email/founder/allowlist', h.form({ action: 'allow', workspace: SECOND, reason: 'x' }))).status, 400);
  assert.equal((await h.call('GET', '/portal/email/founder/allowlist')).status, 405);
  assert.deepEqual(h.list.actions, []);
  // Without the allow-list (0157 absent) the founder page is exactly as before.
  const before = await founderPage();
  const config = loadEmailConnectConfig(ENV, { portalBaseUrl: ORIGIN });
  const store = new MemoryEmailConnectionStore();
  const service = new EmailConnectionService({ config, store, eligibility: staticEligibility, account: createPostmarkAccountApi({ accountToken: ACCOUNT_TOKEN, fetch: new FakePostmark().fetch }), resolver: fakeResolver() });
  const sending = new OwnerSendingService({ eligibility: staticEligibility, protection: new MemoryProtectionStore(counts({})), connections: store, vault: config.vault,
    founder: async identity => identity.sessionToken === FOUNDER, portalOrigin: ORIGIN });
  const absentList = new EmailConnectAllowlistService({ store: { ...before.list, founderView: async () => { throw new EmailConnectAllowlistAbsentError(); } } as never,
    founder: async identity => identity.sessionToken === FOUNDER });
  const get = async (allowlist?: EmailConnectAllowlistService) => {
    const captured = { status: 0, body: '' };
    const req = Object.assign(Readable.from([]), { method: 'GET', url: '/portal/email/founder', headers: { host: 'growth.relaunch72-test.co.uk' } }) as unknown as IncomingMessage;
    const res = { writeHead(status: number) { captured.status = status; }, end(text = '') { captured.body = String(text); } } as unknown as ServerResponse;
    await handleEmailConnection(req, res, new URL('/portal/email/founder', ORIGIN), { portal, service, identity: founderIdentity, sending, ...(allowlist ? { allowlist } : {}) });
    return captured.body.replace(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gu, '<uuid>');
  };
  const without = await get(), absent = await get(absentList);
  assert.equal(absent, without);
  assert.doesNotMatch(without, /Who can use email|Invite a business/u);
});

// ---------- 5. the new hold ----------

const config = (over: Record<string, unknown> = {}) => readSendingConfig({ workspaceId: PP, status: 'verified', mode: 'live', serverId: 1, stream: 'broadcast', sealedServerToken: 'x',
  fromName: 'PP', fromAddress: 'hello@pp-test.co.uk', replyTo: null, businessName: 'PP Ltd', postalAddress: '1 High Street, Leeds', testRecipients: [], protectionState: 'ok',
  ownerPaused: false, sampleState: 'passed', dailyCap: 50, hourlyCap: 13, accountHeld: false, liveDay: 0, liveHour: 0, approvedCurrent: true, testCurrent: true,
  goLiveApprovedAt: '2026-11-01T00:00:00Z', ...over })!;

test('not_allowed: a switched-off business holds with plain words; nothing else changes for an allowed one', () => {
  assert.deepEqual(sendingDecision(config(), {}), { kind: 'connection', mode: 'live', remaining: 13 });
  assert.deepEqual(sendingDecision(config(), { eligible: true }), sendingDecision(config(), {}), 'an allowed business: exactly as before');
  assert.deepEqual(sendingDecision(config(), { eligible: false }), { kind: 'hold', reason: 'not_allowed' });
  assert.deepEqual(sendingPlan(config(), null, { eligible: false }), { kind: 'hold', reason: 'not_allowed', workspaceId: PP });
  assert.equal(SENDING_MESSAGES.notAllowed, 'Email sending for this business has been switched off by the platform owner.');
  assert.equal(stillHeld('not_allowed'), SENDING_MESSAGES.notAllowed);
  assert.deepEqual(holdBanner('not_allowed', config()), { tone: 'notice', title: 'Email sending is on hold', text: SENDING_MESSAGES.notAllowed });
  const banner = ownerBanner({ state: 'ok', trip: null, dailyCap: 50, sampleState: 'passed', sampleTrip: null, ownerPaused: false, accountHeld: false, mode: 'live',
    waitingApproval: false, notAllowed: true });
  assert.deepEqual(banner, { tone: 'alert', title: 'Email sending is switched off', text: SENDING_MESSAGES.notAllowed });
});

test('the environment sender is Property Predator\'s only: any other business without a connection in charge holds', () => {
  const never = config({ mode: 'off', goLiveApprovedAt: null, sampleState: 'none' });
  assert.deepEqual(sendingDecision(null), { kind: 'env' }, 'Property Predator, as before');
  assert.deepEqual(sendingDecision(null, { workspaceId: PP }), { kind: 'env' });
  assert.deepEqual(sendingDecision(never), { kind: 'env' });
  assert.deepEqual(sendingDecision(never, { eligible: false }), { kind: 'env' }, 'PP never in charge keeps its environment sender');
  assert.deepEqual(sendingDecision(null, { workspaceId: SECOND }), { kind: 'hold', reason: 'not_connected' });
  assert.deepEqual(sendingDecision({ ...never, workspaceId: SECOND }), { kind: 'hold', reason: 'not_live' });
  assert.deepEqual(sendingPlan(null, null, { workspaceId: SECOND }), { kind: 'hold', reason: 'not_connected', workspaceId: SECOND });
});

test('the owner\'s and the founder\'s buttons say plainly that email was switched off', async () => {
  const protection = new MemoryProtectionStore(counts({}));
  const store = new MemoryEmailConnectionStore();
  const { EmailProtectionNotAllowedError } = await import('../src/email-protection/store.js');
  const sending = new OwnerSendingService({ eligibility: staticEligibility, protection, connections: store, vault: null, founder: async identity => identity.sessionToken === FOUNDER });
  protection.command = async () => { throw new EmailProtectionNotAllowedError(); };
  const state = { status: 'verified', mode: 'live', webhookId: 1, stream: 'broadcast', protection: { state: 'ok' } } as unknown as EmailConnectionState;
  assert.deepEqual(await sending.command(owner, state, 'pause'), { ok: false, message: SENDING_MESSAGES.notAllowed });
  protection.founderAct = async () => 'not_allowed';
  assert.deepEqual(await sending.founderAct(founderIdentity, PP, 'approve', 1), { ok: false, message: SENDING_MESSAGES.founderNotAllowed });
});
