/**
 * "Use Martin Howard Property here" (migration 0154): the one card on "Your businesses", the duplicate steer on the
 * ordinary "Add a business" form, and the fallback while the database still ends at 0153. The database rules are
 * proved in test/db/seo-blog-attach-workspace.integration.test.ts; here the memory store stands in for them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import { handleSeoBlog } from '../src/portal/seo-blog-router.js';
import { brandsPage } from '../src/portal/seo-blog-view.js';
import { portalCsrfToken } from '../src/portal/session.js';
import type { PortalSeoBlogService } from '../src/portal/seo-blog-service.js';
import type { PortalSessionIdentity } from '../src/portal/auth-service.js';
import { EXISTING_WORKSPACE, namesExistingWorkspace } from '../src/seo-blog/existing-workspace.js';
import { PgSeoBlogStore } from '../src/seo-blog/pg-store.js';
import { SeoBlogEngine } from '../src/seo-blog/engine.js';
import { DEFAULT_BRAND_SETTINGS, SeoBlogError } from '../src/seo-blog/types.js';
import { harness, OWNER, STRANGER } from './seo-blog-fixtures.js';

const SECRET = 's'.repeat(48);
const MHP = EXISTING_WORKSPACE.id;
const CARD = /<section class="card" id="use-existing"/g;

function identity(userId: string): PortalSessionIdentity {
  return { sessionToken: `token-${userId}`, userId, workspaceId: '33333333-3333-4333-8333-333333333333', userEmail: 'owner@example.test' };
}

async function call(service: PortalSeoBlogService, who: PortalSessionIdentity, method: string, path: string, form?: Record<string, string>, extraHeaders: Record<string, string> = {}) {
  const body = form ? new URLSearchParams(form).toString() : '';
  const req = new PassThrough() as unknown as IncomingMessage & PassThrough;
  Object.assign(req, { method, url: path, headers: { host: 'portal.example', ...(form ? { 'content-type': 'application/x-www-form-urlencoded', 'content-length': String(Buffer.byteLength(body)), origin: 'https://portal.example' } : {}), ...extraHeaders } });
  (req as PassThrough).end(body);
  let status = 0; let headers: Record<string, string> = {}; let out = '';
  const res = {
    writeHead(s: number, h: Record<string, string>) { status = s; headers = h; return res; },
    end(chunk?: string) { if (chunk) out += chunk; },
  } as unknown as ServerResponse;
  await handleSeoBlog(req, res, new URL(path, 'https://portal.example'), { service, identity: who, requestId: `r-${randomUUID()}`, sessionSecret: SECRET, vaultReady: true });
  return { status, headers, body: out };
}

/** The memory store with MHP's existing workspace, usable by OWNER only (the database rule in 0154). */
function mhpHarness() {
  const h = harness();
  h.store.existingWorkspace = { id: MHP, organizationId: EXISTING_WORKSPACE.organizationId, name: 'Martin Howard Property · Marketing', owners: new Set([OWNER.userId]) };
  const service: PortalSeoBlogService = { generation: 'live', research: 'live', social: 'unavailable', engineFor: () => h.engine, socialCallback: async () => null };
  return { h, service };
}

const commandOf = (html: string) => /action="\/portal\/seo-blog\/brands\/existing"><input type="hidden" name="_csrf" value="[^"]+"><input type="hidden" name="commandId" value="([0-9a-f-]{36})">/.exec(html)?.[1];
const follow = async (service: PortalSeoBlogService, who: PortalSessionIdentity, location: string) => call(service, who, 'GET', location.split('#')[0]!);

test('the duplicate rule: the name "Martin Howard Property" in any spacing or case, or a martinhowardproperty website, and nothing else', () => {
  for (const name of ['Martin Howard Property', 'martin howard property', '  MARTIN-HOWARD  PROPERTY ', 'Martin Howard Property Ltd', 'Martin Howard Property · Marketing', 'MartinHowardProperty'])
    assert.equal(namesExistingWorkspace(name), true, name);
  for (const site of ['martinhowardproperty.co.uk', 'https://www.martinhowardproperty.co.uk/about', 'http://app.martinhowardproperty.co.uk', 'MARTINHOWARDPROPERTY.COM', 'https://user@martinhowardproperty.co.uk:443/'])
    assert.equal(namesExistingWorkspace('Anything', site), true, site);
  for (const [name, site] of [['Martin Howard', null], ['Howard Property Lettings', null], ['Martin Howard Properties', null], ['The Martin Howard Property Fund', null],
    ['Harbour Lettings', 'harbour.example'], ['Harbour Lettings', 'martinhowardpropertyfans.example'], ['Harbour Lettings', 'https://example.co.uk/martinhowardproperty'], ['MHP', '']] as const)
    assert.equal(namesExistingWorkspace(name, site), false, `${name} ${site}`);
});

test('the card: shown once for the eligible owner, plain, with CSRF and a fresh command id; hidden for anyone else, once used, and when not supported', async () => {
  const { h, service } = mhpHarness();
  const owner = identity(OWNER.userId);
  const home = await call(service, owner, 'GET', '/portal/seo-blog');
  assert.equal(home.status, 200);
  assert.equal((home.body.match(CARD) ?? []).length, 1, 'one card');
  assert.match(home.body, /<h2 id="use-existing-title">Martin Howard Property<\/h2>/);
  assert.match(home.body, /<p>This uses the Martin Howard Property workspace you already have\. Nothing is spent until an allowance is set\.<\/p>/);
  assert.match(home.body, /<button type="submit">Use Martin Howard Property here<\/button>/);
  assert.match(home.body, new RegExp(`<input type="hidden" name="_csrf" value="${portalCsrfToken(SECRET, owner.sessionToken)}">`));
  assert.ok(commandOf(home.body));
  assert.notEqual(commandOf(home.body), commandOf((await call(service, owner, 'GET', '/portal/seo-blog')).body), 'each page carries its own command id');
  assert.ok(home.body.indexOf('id="use-existing"') < home.body.indexOf('id="add-business"'), 'above the ordinary form');
  assert.doesNotMatch(home.body, /workspace_id|tenant|provision|RLS|migration/i, 'no jargon');
  // Not eligible: another signed-in owner never sees it.
  assert.doesNotMatch((await call(service, identity(STRANGER.userId), 'GET', '/portal/seo-blog')).body, CARD);
  // A store without the capability (a build against a store that predates 0154) and an offer that fails both hide it.
  const bare = harness();
  const bareService: PortalSeoBlogService = { ...service, engineFor: () => bare.engine };
  Object.defineProperty(bare.store, 'existingWorkspaceOffer', { value: undefined });
  const plain = await call(bareService, owner, 'GET', '/portal/seo-blog');
  assert.equal(plain.status, 200); assert.doesNotMatch(plain.body, CARD);
  const broken = harness();
  broken.store.existingWorkspaceOffer = async () => { throw new Error('database unavailable'); };
  const failed = await call({ ...service, engineFor: () => broken.engine }, owner, 'GET', '/portal/seo-blog');
  assert.equal(failed.status, 200); assert.doesNotMatch(failed.body, CARD);
  // Once used it is just one of the businesses: no card.
  await h.engine.attachExistingWorkspace(OWNER, { commandId: randomUUID() });
  const after = await call(service, owner, 'GET', '/portal/seo-blog');
  assert.doesNotMatch(after.body, CARD);
  assert.match(after.body, /Martin Howard Property · Marketing/);
});

test('the card escapes what it prints', () => {
  const html = brandsPage({ brands: [], brand: null, tab: null, csrf: '"><script>x</script>', limitsAvailable: false }, randomUUID(), undefined, '"><img src=x onerror=alert(1)>');
  assert.equal((html.match(CARD) ?? []).length, 1);
  assert.doesNotMatch(html, /<script>x<\/script>|<img src=x/);
  assert.match(html, /value="&#34;&gt;&lt;script&gt;|value="&quot;&gt;&lt;script&gt;/);
  assert.doesNotMatch(brandsPage({ brands: [], brand: null, tab: null, csrf: 'c', limitsAvailable: false }, randomUUID()), CARD, 'no command id, no card');
});

test('pressing the button: CSRF and same-origin required, lands on the Brand DNA door, and a replay or second press attaches once', async () => {
  const { h, service } = mhpHarness();
  const owner = identity(OWNER.userId), csrf = portalCsrfToken(SECRET, owner.sessionToken);
  const commandId = commandOf((await call(service, owner, 'GET', '/portal/seo-blog')).body)!;
  for (const denied of [await call(service, owner, 'POST', '/portal/seo-blog/brands/existing', { commandId }),
    await call(service, owner, 'POST', '/portal/seo-blog/brands/existing', { commandId, _csrf: 'wrong' }),
    await call(service, owner, 'POST', '/portal/seo-blog/brands/existing', { commandId, _csrf: csrf }, { origin: 'https://evil.example' })]) {
    assert.notEqual(denied.headers.location?.includes(`/b/${MHP}/dna`), true);
  }
  assert.equal((await h.engine.listBrands(OWNER)).length, 0, 'nothing attached without the form token');
  const done = await call(service, owner, 'POST', '/portal/seo-blog/brands/existing', { commandId, _csrf: csrf });
  assert.equal(done.status, 303);
  assert.ok(done.headers.location!.startsWith(`/portal/seo-blog/b/${MHP}/dna?`), done.headers.location);
  assert.match((await follow(service, owner, done.headers.location!)).body, /Martin Howard Property is ready\. Start with its website\./);
  const replay = await call(service, owner, 'POST', '/portal/seo-blog/brands/existing', { commandId, _csrf: csrf });
  assert.ok(replay.headers.location!.startsWith(`/portal/seo-blog/b/${MHP}/dna?`));
  assert.match((await follow(service, owner, replay.headers.location!)).body, /Martin Howard Property is already here\./);
  const again = await call(service, owner, 'POST', '/portal/seo-blog/brands/existing', { commandId: randomUUID(), _csrf: csrf });
  assert.ok(again.headers.location!.startsWith(`/portal/seo-blog/b/${MHP}/dna?`));
  const brands = await h.engine.listBrands(OWNER);
  assert.deepEqual(brands.map((b) => b.id), [MHP], 'one business, the existing workspace');
  assert.deepEqual(brands[0]!.settings.budgets, { modelTokensPerMonth: 0, searchCallsPerMonth: 0, imagesPerMonth: 0 });
  assert.equal(brands[0]!.settings.autoPublish, false);
  assert.equal((await h.engine.activity(OWNER, MHP)).filter((a) => a.kind === 'brand.attached').length, 1);
  // Someone else pressing a copied form is refused and stays on the businesses page.
  const stranger = identity(STRANGER.userId);
  const refused = await call(service, stranger, 'POST', '/portal/seo-blog/brands/existing', { commandId: randomUUID(), _csrf: portalCsrfToken(SECRET, stranger.sessionToken) });
  assert.ok(refused.headers.location!.startsWith('/portal/seo-blog?'));
  assert.ok(refused.headers.location!.endsWith('#use-existing'));
  assert.match((await follow(service, stranger, refused.headers.location!)).body, /Only the Martin Howard Property owner can do this\./);
  assert.equal((await h.engine.listBrands(STRANGER)).length, 0);
  // A malformed command id is refused before anything is written.
  await assert.rejects(h.engine.attachExistingWorkspace(OWNER, { commandId: 'nope' }), (e: unknown) => e instanceof SeoBlogError && e.status === 400);
});

test('typing Martin Howard Property into "Add a business" never makes a duplicate: card if usable, its door if used, otherwise a plain reason', async () => {
  const { h, service } = mhpHarness();
  const owner = identity(OWNER.userId), csrf = portalCsrfToken(SECRET, owner.sessionToken);
  const add = (who: PortalSessionIdentity, name: string, website = '') => call(service, who, 'POST', '/portal/seo-blog/brands',
    { commandId: randomUUID(), name, website, _csrf: portalCsrfToken(SECRET, who.sessionToken) });
  // Usable here: pointed at the card.
  const toCard = await add(owner, 'Martin Howard Property');
  assert.ok(toCard.headers.location!.startsWith('/portal/seo-blog?') && toCard.headers.location!.endsWith('#use-existing'), toCard.headers.location);
  const page = (await follow(service, owner, toCard.headers.location!)).body;
  assert.match(page, /Martin Howard Property already has a workspace\. Use the Martin Howard Property card on this page instead\./);
  assert.equal((page.match(CARD) ?? []).length, 1);
  assert.ok((await add(owner, 'MHP website', 'www.martinhowardproperty.co.uk')).headers.location!.endsWith('#use-existing'), 'the website counts too');
  assert.equal((await h.engine.listBrands(OWNER)).length, 0, 'nothing was created');
  // Not usable here (someone else): a plain reason, nothing created.
  const stranger = identity(STRANGER.userId);
  const reason = await add(stranger, 'martin howard property ltd');
  assert.ok(reason.headers.location!.endsWith('#add-business'));
  assert.match((await follow(service, stranger, reason.headers.location!)).body, /Martin Howard Property already has its own workspace, so it is not added again as a new business\./);
  assert.equal((await h.engine.listBrands(STRANGER)).length, 0);
  // Used: straight to its Brand DNA door.
  await call(service, owner, 'POST', '/portal/seo-blog/brands/existing', { commandId: randomUUID(), _csrf: csrf });
  const toDoor = await add(owner, 'Martin Howard Property');
  assert.ok(toDoor.headers.location!.startsWith(`/portal/seo-blog/b/${MHP}/dna?`));
  assert.deepEqual((await h.engine.listBrands(OWNER)).map((b) => b.id), [MHP]);
  // An ordinary business is unaffected.
  const harbour = await add(owner, 'Harbour Lettings', 'harbour.example');
  assert.match(harbour.headers.location!, /^\/portal\/seo-blog\/b\/[0-9a-f-]{36}\/dna\?/);
  assert.equal((await h.engine.listBrands(OWNER)).length, 2);
});

/** A pool whose transactions answer the session lock and then fail the 0154 call as a database at 0153 would. */
function poolAt0153(code = '42883'): { pool: Pick<Pool, 'connect'>; sql: string[] } {
  const sql: string[] = [];
  const client = {
    async query(text: string) {
      sql.push(text);
      if (/lock_active_portal_session/.test(text)) return { rows: [{ ok: true }] };
      if (/seo_blog_attach_workspace/.test(text)) throw Object.assign(new Error('function does not exist'), { code });
      return { rows: [] };
    },
    release() {},
  };
  return { pool: { connect: async () => client } as unknown as Pick<Pool, 'connect'>, sql };
}

test('on a database at 0153 the option is simply not offered and pressing a stale button changes nothing', async () => {
  for (const code of ['42883', '42501']) {
    const { pool, sql } = poolAt0153(code);
    const store = new PgSeoBlogStore(pool, { kind: 'user', userId: OWNER.userId, requestId: 'r', sessionToken: 't', selectedWorkspaceId: '33333333-3333-4333-8333-333333333333' });
    assert.equal(await store.existingWorkspaceOffer(OWNER.userId, MHP), false);
    assert.ok(sql.includes('ROLLBACK'), 'the failed transaction is rolled back');
    assert.ok(sql.some((s) => s.includes('app_private.seo_blog_attach_workspace_offer($1)')));
  }
  const { pool } = poolAt0153();
  const store = new PgSeoBlogStore(pool, { kind: 'user', userId: OWNER.userId, requestId: 'r', sessionToken: 't', selectedWorkspaceId: '33333333-3333-4333-8333-333333333333' });
  const h = harness();
  const engine = new SeoBlogEngine({ store, llm: h.llm, search: h.search, transport: h.web, publishers: new Map(), vault: h.vault, now: h.clock.now });
  assert.equal(await engine.existingWorkspaceOffer(OWNER), false);
  await assert.rejects(engine.attachExistingWorkspace(OWNER, { commandId: randomUUID() }), (e: unknown) => e instanceof SeoBlogError && e.status === 404 && /not switched on yet/.test(e.message));
  // Any other database failure is not hidden by the store (the page itself still renders without the card).
  const other = poolAt0153('57014');
  const failing = new PgSeoBlogStore(other.pool, { kind: 'user', userId: OWNER.userId, requestId: 'r', sessionToken: 't', selectedWorkspaceId: '33333333-3333-4333-8333-333333333333' });
  await assert.rejects(failing.existingWorkspaceOffer(OWNER.userId, MHP), { code: '57014' });
});

test('the attach sends the same default settings a new business gets, and the pinned workspace, never one from the form', async () => {
  const seen: unknown[][] = [];
  const client = {
    async query(text: string, values?: unknown[]) {
      if (/lock_active_portal_session/.test(text)) return { rows: [{ ok: true }] };
      if (/seo_blog_attach_workspace\(/.test(text)) { seen.push(values!); return { rows: [{ result: { workspaceId: MHP, attached: true } }] }; }
      if (/seo_blog_brand\(/.test(text)) return { rows: [{ brand: { id: MHP, organizationId: EXISTING_WORKSPACE.organizationId, name: 'Martin Howard Property · Marketing', slug: 'mhp-brand-marketing', website: null, locale: 'en-GB', timezone: 'Europe/London', settings: {}, createdAt: '2026-11-14T00:00:00Z', createdBy: OWNER.userId, rowVersion: 1 } }] };
      return { rows: [] };
    },
    release() {},
  };
  const store = new PgSeoBlogStore({ connect: async () => client } as unknown as Pick<Pool, 'connect'>, { kind: 'user', userId: OWNER.userId, requestId: 'r', sessionToken: 't', selectedWorkspaceId: '33333333-3333-4333-8333-333333333333' });
  const command = randomUUID();
  const out = await store.attachExistingWorkspace({ commandId: command, actorId: OWNER.userId, workspaceId: MHP, website: null, now: '2026-11-14T00:00:00Z' });
  assert.equal(out.attached, true);
  assert.deepEqual(seen, [[command, MHP, null, JSON.stringify(DEFAULT_BRAND_SETTINGS)]]);
  await assert.rejects(store.attachExistingWorkspace({ commandId: command, actorId: STRANGER.userId, workspaceId: MHP, website: null, now: '2026-11-14T00:00:00Z' }), { status: 403 });
});
