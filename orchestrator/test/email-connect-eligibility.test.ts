/**
 * "Connect email": the allow-list seam (src/email-connections/eligibility.ts).
 *
 * 1. Golden naming for Property Predator: the Postmark server name, the bounce source key, the bounce webhook URL and
 *    the Return-Path proof are byte-identical to what the code produced BEFORE the seam existed. The literals were
 *    printed once by a scratch script run against base commit ca0c217 (using EMAIL_CONNECT_BUSINESSES[0],
 *    connectionServerName, connectionWebhookUrl and EmailConnectionVault.returnPathLabel there) and pasted here.
 * 2. A second, hypothetical business supplied through a TEST eligibility flows through the page gating, the ?business=
 *    check, bounce-source loading and the lock pool with no other code change; with the static eligibility the same
 *    business is refused on every request path exactly as before (same messages and status codes). Its stored row's
 *    bounce source is loaded either way (stage 2: the source follows the stored row, not the list).
 * 3. Nothing outside the seam (and the PP follow-up engine, PP-only by design) makes an allow decision from the PP
 *    workspace id or the old list; the environment sender is Property Predator's only.
 * Nothing touches the network or a database. Every value is synthetic.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { EmailBounceService } from '../src/email-bounces/index.js';
import {
  connectionServerName, connectionSourceKey, connectionWebhookUrl, createPostmarkAccountApi, EMAIL_CONNECT_BUSINESSES, EMAIL_CONNECTION_MESSAGES,
  EmailConnectionBounceSources, EmailConnectionService, EmailConnectionVault, emailConnectionLockPoolSize, listEligibility, loadEmailConnectConfig,
  PgEmailConnectionStore, PP_EMAIL_WORKSPACE_ID, staticEligibility, type EmailConnectEligibility, type EmailConnectionState, type StoredConnectionSource,
} from '../src/email-connections/index.js';
import { handleEmailConnection } from '../src/portal/email-connection-router.js';
import { emailConnectionBusinessAllowed } from '../src/portal/router.js';
import { ACCOUNT_TOKEN, FakePostmark, fakeResolver, MemoryEmailConnectionStore, OWNER_SESSION } from './email-connections-fixtures.js';

const PP = 'd975ff66-336a-46c2-b36b-d7095a11af97';
const ORIGIN = 'https://growth.relaunch72-test.co.uk';
const KEY = Buffer.alloc(32, 7).toString('base64');
const ENV = { EMAIL_CONNECT: 'enabled', POSTMARK_ACCOUNT_TOKEN: ACCOUNT_TOKEN, EMAIL_CONNECTION_KEY: KEY };

// ---------- 1. golden naming (literals from base commit ca0c217) ----------

const ppBusiness = () => {
  const business = staticEligibility.business(PP);
  assert.ok(business, 'Property Predator is allowed');
  return business;
};

/** One real Connect run for PP through the seam (static eligibility passed in), against the fake Postmark. */
const GOLDEN_KEY = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8');
const GOLDEN_DOMAIN = 'propertypredator-test.co.uk';
let connected: Promise<FakePostmark> | null = null;
const connectPp = (): Promise<FakePostmark> => connected ??= (async () => {
  const postmark = new FakePostmark();
  const service = new EmailConnectionService({ config: loadEmailConnectConfig({ ...ENV, EMAIL_CONNECTION_KEY: GOLDEN_KEY.toString('base64') }, { portalBaseUrl: ORIGIN }),
    store: new MemoryEmailConnectionStore(), account: createPostmarkAccountApi({ accountToken: ACCOUNT_TOKEN, fetch: postmark.fetch }), resolver: fakeResolver(),
    secret: () => 'whsec-synthetic-0123456789-abcdefghijklmnop', lockWaitMs: 2000, eligibility: staticEligibility });
  const ppOwner = { sessionToken: OWNER_SESSION, userId: '00000000-0000-4000-8000-000000000001', workspaceId: PP, userEmail: 'owner@relaunch72-test.co.uk' };
  assert.deepEqual(await service.connect(ppOwner, { fromName: 'Property Predator', fromAddress: `hello@${GOLDEN_DOMAIN}`, replyTo: '', agreed: true }),
    { ok: true, message: EMAIL_CONNECTION_MESSAGES.started });
  return postmark;
})();

test('golden: the Postmark server name for Property Predator is unchanged', async () => {
  assert.equal(PP_EMAIL_WORKSPACE_ID, PP);
  assert.deepEqual({ ...ppBusiness() }, { workspaceId: PP, name: 'Property Predator', sourceKey: 'conn-d975ff66336a46c2b36bd7095a11af97', replacesSourceKey: null });
  assert.equal(connectionServerName(ppBusiness()), 'Relaunch72 - Property Predator - d975ff66336a46c2b36bd7095a11af97');
  assert.deepEqual((await connectPp()).servers.map(server => server.name), ['Relaunch72 - Property Predator - d975ff66336a46c2b36bd7095a11af97']);
});

test('golden: the bounce source key and bounce webhook URL for Property Predator are unchanged', async () => {
  assert.equal(ppBusiness().sourceKey, 'conn-d975ff66336a46c2b36bd7095a11af97');
  assert.equal(connectionSourceKey(PP), 'conn-d975ff66336a46c2b36bd7095a11af97');
  assert.equal(connectionWebhookUrl(ORIGIN, ppBusiness()),
    'https://growth.relaunch72-test.co.uk/api/provider-webhooks/postmark/conn-d975ff66336a46c2b36bd7095a11af97');
  assert.deepEqual((await connectPp()).servers[0]!.webhooks.map(webhook => [webhook.url, webhook.username]),
    [['https://growth.relaunch72-test.co.uk/api/provider-webhooks/postmark/conn-d975ff66336a46c2b36bd7095a11af97', 'conn-d975ff66336a46c2b36bd7095a11af97']]);
});

test('golden: the Return-Path proof for Property Predator is unchanged, and is the one Connect creates the domain with', async () => {
  const vault = new EmailConnectionVault(GOLDEN_KEY);
  assert.equal(`${vault.returnPathLabel(ppBusiness().workspaceId, GOLDEN_DOMAIN)}.${GOLDEN_DOMAIN}`, 'pm-b5c317a5b3.propertypredator-test.co.uk');
  assert.deepEqual((await connectPp()).domains.map(domain => [domain.name, domain.returnPath]), [[GOLDEN_DOMAIN, 'pm-b5c317a5b3.propertypredator-test.co.uk']]);
});

// ---------- 2. the seam carries a second business; the static list refuses it as before ----------

const SECOND = 'a1b2c3d4-0000-4000-8000-000000000002';
const SECOND_SESSION = 'second-owner-session-0123456789abcdef';
const second = { sessionToken: SECOND_SESSION, userId: '00000000-0000-4000-8000-000000000002', workspaceId: SECOND, userEmail: 'owner@second-business-test.co.uk' };
const withSecond: EmailConnectEligibility = listEligibility([...EMAIL_CONNECT_BUSINESSES,
  Object.freeze({ workspaceId: SECOND, name: 'Second Business', sourceKey: connectionSourceKey(SECOND), replacesSourceKey: null })]);

const notConnected: EmailConnectionState = Object.freeze({ status: 'not_connected', step: null, domain: null, fromName: null, fromAddress: null, replyTo: null, serverId: null,
  domainId: null, stream: null, webhookId: null, hasServerToken: false, hasWebhookSecret: false, mode: 'off', dns: null, verifiedAt: null, rowVersion: 0,
  protection: { state: 'ok' as const, reason: null, since: null, dailyCap: 50, hourlyCap: 13, warmupStartedAt: null }, terms: null, goLiveApprovedAt: null, domainAttempted: false });

/** A store that lets any session own any workspace (the seam, not the database's owner rule, is under test). */
const openStore = (rows: readonly StoredConnectionSource[] = []) => ({ state: async () => notConnected, present: async () => true, sources: async () => rows,
  sealed: async () => ({ serverToken: null, webhookSecret: null }) }) as never;

function serviceWith(eligibility: EmailConnectEligibility): EmailConnectionService {
  const postmark = new FakePostmark();
  return new EmailConnectionService({ config: loadEmailConnectConfig(ENV, { portalBaseUrl: ORIGIN }), store: openStore(),
    account: createPostmarkAccountApi({ accountToken: ACCOUNT_TOKEN, fetch: postmark.fetch }), resolver: fakeResolver(), eligibility });
}

async function getPage(service: EmailConnectionService, pathAndQuery: string) {
  const captured = { status: 0, body: '' };
  const req = Object.assign(Readable.from([]), { method: 'GET', url: pathAndQuery, headers: { host: 'growth.relaunch72-test.co.uk' } }) as unknown as IncomingMessage;
  const res = { writeHead(status: number) { captured.status = status; }, end(text = '') { captured.body = String(text); } } as unknown as ServerResponse;
  const portal = { productProfile: { id: 'property_predator_growth' } as never, portalBaseUrl: ORIGIN, sessionSecret: 'portal-session-secret-0123456789abcdef' };
  assert.equal(await handleEmailConnection(req, res, new URL(pathAndQuery, ORIGIN), { portal, service, identity: second }), true);
  return captured;
}

test('a second business given through a test eligibility passes the page gating, ?business=, bounce loading and the lock pool', async () => {
  const service = serviceWith(withSecond);
  // Home page entry and the email status card (portal/router.ts).
  assert.equal(emailConnectionBusinessAllowed({ emailConnections: service } as never, SECOND), true);
  assert.equal(emailConnectionBusinessAllowed({ emailConnections: service } as never, PP), true);
  // The page and its ?business= check.
  const page = await getPage(service, '/portal/email');
  assert.equal(page.status, 200);
  assert.match(page.body, /Second Business|Connect/u);
  assert.equal((await getPage(service, `/portal/email?business=${SECOND}`)).status, 200);
  assert.equal((await getPage(service, `/portal/email?business=${SECOND.toUpperCase()}`)).status, 404, 'only the id as listed');
  // Bounce-source loading: the stored row for the second business becomes its own source.
  const vault = loadEmailConnectConfig(ENV, { portalBaseUrl: ORIGIN }).vault!;
  const row: StoredConnectionSource = { workspaceId: SECOND, serverId: '901', stream: 'broadcast',
    sealedServerToken: vault.seal(SECOND, 'server_token', 'srv-second-0123456789abcdef'), sealedWebhookSecret: vault.seal(SECOND, 'webhook_secret', 'whsec-second-0123456789-abcdefghijkl') };
  const bounces = new EmailBounceService({ config: { sources: [], blockers: [] }, apiFor: () => null });
  const sources = new EmailConnectionBounceSources({ store: openStore([row]), vault, service: bounces, eligibility: withSecond });
  assert.equal(sources.handles(connectionSourceKey(SECOND)), true);
  await sources.refresh();
  assert.deepEqual(bounces.dynamicSourceKeys(), [connectionSourceKey(SECOND)]);
  // The lock pool: a fixed maximum (stage 2), so a business allowed later needs no restart.
  assert.equal(emailConnectionLockPoolSize(), 8);
  // otherConnectionHolds without 0157 (a list not from the database): with two allowed businesses it cannot tell and refuses.
  const store = new PgEmailConnectionStore({ query: async () => { throw new Error('not used'); }, connect: async () => { throw new Error('not used'); } } as never, { eligibility: withSecond });
  await assert.rejects(store.otherConnectionHolds('session', PP, { id: null, name: 'example-test.co.uk' }), /Cannot tell whether another business holds this domain/u);
});

test('with the static eligibility the same business is refused on every request path, with the same messages and status codes as before', async () => {
  for (const service of [serviceWith(staticEligibility)]) {
    assert.equal(service.eligibility, staticEligibility);
    assert.equal(emailConnectionBusinessAllowed({ emailConnections: service } as never, SECOND), false);
    assert.equal(emailConnectionBusinessAllowed({ emailConnections: service } as never, PP), true);
    assert.equal(emailConnectionBusinessAllowed({ emailConnections: service } as never, PP.toUpperCase()), true, 'any letter case, as before');
    assert.equal(emailConnectionBusinessAllowed({} as never, PP), false, 'no Connect service: no entry');
    const page = await getPage(service, '/portal/email');
    assert.equal(page.status, 403);
    assert.match(page.body, /Email can only be connected for Property Predator for now\./u);
    assert.equal(EMAIL_CONNECTION_MESSAGES.notAllowed, 'Email can only be connected for Property Predator for now.');
    const picked = await getPage(service, `/portal/email?business=${SECOND}`);
    assert.equal(picked.status, 404);
    assert.match(picked.body, /Email can only be connected for Property Predator for now\./u);
    await assert.rejects(service.connect(second, { fromName: 'Second', fromAddress: 'hello@second-business-test.co.uk', replyTo: '', agreed: true }),
      (error: { status?: number; code?: string; message?: string }) => error.status === 403 && error.code === 'not_allowed' && error.message === EMAIL_CONNECTION_MESSAGES.notAllowed);
  }
  const vault = loadEmailConnectConfig(ENV, { portalBaseUrl: ORIGIN }).vault!;
  const row: StoredConnectionSource = { workspaceId: SECOND, serverId: '901', stream: 'broadcast',
    sealedServerToken: vault.seal(SECOND, 'server_token', 'srv-second-0123456789abcdef'), sealedWebhookSecret: vault.seal(SECOND, 'webhook_secret', 'whsec-second-0123456789-abcdefghijkl') };
  for (const eligibility of [staticEligibility]) {
    const bounces = new EmailBounceService({ config: { sources: [], blockers: [] }, apiFor: () => null });
    const sources = new EmailConnectionBounceSources({ store: openStore([row]), vault, service: bounces, eligibility });
    // Stage 2: a stored row's bounce source follows the row, not the list (a business switched off keeps its webhook).
    assert.equal(sources.handles(connectionSourceKey(SECOND)), true);
    assert.equal(sources.handles(connectionSourceKey(PP)), true);
    assert.equal(sources.handles('pp'), false, 'an environment source is never a stored connection');
    await sources.refresh();
    assert.deepEqual(bounces.dynamicSourceKeys(), [connectionSourceKey(SECOND)], 'the stored row is loaded whatever the list says');
    const store = new PgEmailConnectionStore({ query: async () => { throw new Error('not used'); }, connect: async () => { throw new Error('not used'); } } as never, { eligibility });
    assert.equal(await store.otherConnectionHolds('session', PP, { id: null, name: 'example-test.co.uk' }), false, 'one allowed business, no 0157: certainly false');
  }
  assert.deepEqual(staticEligibility.list(), EMAIL_CONNECT_BUSINESSES);
});

// ---------- 3. one seam ----------

test('no file outside the seam and the PP follow-up engine makes an allow decision from the PP id or the old list', async () => {
  const root = new URL('../src/', import.meta.url).pathname;
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full); else if (/\.ts$/u.test(entry.name)) files.push(full);
    }
  };
  await walk(root);
  // The old allow-list names, the PP constant, and the static implementation itself (to be passed in, never imported).
  const pattern = /\bEMAIL_CONNECT_BUSINESSES\b|\bPP_EMAIL_WORKSPACE_ID\b|\bemailConnectBusiness\b|\bstaticEligibility\b|\blistEligibility\b/u;
  const found = new Set<string>();
  for (const file of files) if (pattern.test(await readFile(file, 'utf8'))) found.add(path.relative(root, file));
  assert.deepEqual([...found].sort(), [
    // The seam itself.
    'email-connections/eligibility.ts',
    // The database-backed implementation: the static list while 0157 is absent (or the first read failed).
    'email-connections/allowlist.ts',
  ].sort());
  // Every consumer requires the eligibility: there is no fallback to the static list anywhere else.
  for (const file of ['email-connections/bounce-sources.ts', 'email-connections/service.ts', 'email-connections/store.ts', 'email-protection/owner.ts']) {
    assert.doesNotMatch(await readFile(path.join(root, file), 'utf8'), /eligibility\?: EmailConnectEligibility|\?\? staticEligibility/u, file);
  }
  // The PP workspace id as a literal (TypeScript; migrations aside): only the seam, the PP follow-up engine (PP-only by
  // design until the generic follow-up engine) and the durable bounce ledger's table pin (0153, not a Connect decision).
  const literal = /d975ff66-336a-46c2-b36b-d7095a11af97/u;
  const literals = new Set<string>();
  for (const file of files) if (literal.test(await readFile(file, 'utf8'))) literals.add(path.relative(root, file));
  assert.deepEqual([...literals].sort(), ['email-bounces/ledger.ts', 'email-connections/eligibility.ts', 'pp-followup/repository.ts']);
  // The PP follow-up engine constant is not used for a Connect email decision anywhere in Connect email. The one use:
  // the environment-configured sender is the PP follow-up engine's own, so only Property Predator may fall back to it.
  for (const file of files.filter(f => /\/email-connections\/|\/email-protection\/|\/portal\/email-connection-/u.test(f))) {
    const text = await readFile(file, 'utf8');
    if (path.relative(root, file) === 'email-protection/sending.ts') {
      assert.deepEqual(text.split('\n').filter(line => /PP_FOLLOWUP_WORKSPACE_ID/u.test(line)).map(line => line.trim()), [
        "import { PP_FOLLOWUP_WORKSPACE_ID } from '../pp-followup/repository.js';",
        'const envSenderFor = (workspaceId: string): boolean => workspaceId.toLowerCase() === PP_FOLLOWUP_WORKSPACE_ID;',
        'if (envSenderFor(options.workspaceId ?? config?.workspaceId ?? PP_FOLLOWUP_WORKSPACE_ID)) return { kind: \'env\' };',
      ]);
      continue;
    }
    assert.doesNotMatch(text, /PP_FOLLOWUP_WORKSPACE_ID/u, path.relative(root, file));
  }
});
