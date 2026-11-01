/**
 * PostgreSQL integration for the SEO blog store (migration 0131) running as
 * r72_content_command under forced RLS. Skipped unless both URLs point at a
 * disposable database:
 *   SEO_BLOG_PG_ADMIN_URL   — superuser/migrator URL used only to seed identity rows
 *   SEO_BLOG_PG_CONTENT_URL — the same database as r72_content_command
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { PgSeoBlogStore } from '../../src/seo-blog/pg-store.js';
import { SeoBlogEngine } from '../../src/seo-blog/engine.js';
import { harness, seedBrandSite } from '../seo-blog-fixtures.js';

const adminUrl = process.env.SEO_BLOG_PG_ADMIN_URL;
const contentUrl = process.env.SEO_BLOG_PG_CONTENT_URL;
const skip = !adminUrl || !contentUrl || !/test/i.test(adminUrl) ? 'set SEO_BLOG_PG_ADMIN_URL and SEO_BLOG_PG_CONTENT_URL to a disposable *test* database' : false;

async function seedOwner(admin: pg.Pool, label: string) {
  const org = randomUUID(), user = randomUUID(), ws = randomUUID();
  const token = randomUUID() + randomUUID();
  const slug = `org-${label}-${org.slice(0, 8)}`;
  await admin.query(`INSERT INTO app.organizations (id, name, slug, kind) VALUES ($1, $2, $3, 'direct_customer')`, [org, `Org ${label}`, slug]);
  await admin.query(`INSERT INTO app.users (id, email, status) VALUES ($1, $2, 'active')`, [user, `${label}-${user.slice(0, 8)}@example.test`]);
  await admin.query(`INSERT INTO app.organization_memberships (organization_id, user_id, role, status) VALUES ($1, $2, 'owner', 'active')`, [org, user]);
  await admin.query(`INSERT INTO app.workspaces (id, organization_id, name, slug) VALUES ($1, $2, 'Home', $3)`, [ws, org, `home-${ws.slice(0, 8)}`]);
  await admin.query(`INSERT INTO app.workspace_memberships (workspace_id, organization_id, user_id, role, status, source_organization_id) VALUES ($1, $2, $3, 'owner', 'active', $2)`, [ws, org, user]);
  await admin.query(`INSERT INTO app.user_sessions (token_hash, csrf_secret_hash, user_id, selected_workspace_id, expires_at) VALUES ($1, $2, $3, $4, now() + interval '1 hour')`,
    [createHash('sha256').update(token).digest(), createHash('sha256').update(`csrf${token}`).digest(), user, ws]);
  return { user, ws, token };
}

test('PostgreSQL store: brand creation, RLS isolation, versions, idempotent publications and jobs', { skip }, async () => {
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  const content = new pg.Pool({ connectionString: contentUrl, max: 4 });
  try {
    const role = await content.query<{ u: string }>('SELECT current_user AS u');
    assert.equal(role.rows[0]!.u, 'r72_content_command');
    const alice = await seedOwner(admin, 'alice');
    const bob = await seedOwner(admin, 'bob');
    const h = harness();
    const engineFor = (o: { user: string; ws: string; token: string }) => new SeoBlogEngine({
      store: new PgSeoBlogStore(content, { kind: 'user', userId: o.user, requestId: `t-${randomUUID()}`, sessionToken: o.token, selectedWorkspaceId: o.ws }),
      llm: h.llm, search: h.search, transport: h.web, publishers: new Map(), vault: h.vault, now: h.clock.now,
    });
    const a = engineFor(alice);
    const command = randomUUID();
    const created = await a.createBrand({ userId: alice.user }, { commandId: command, name: 'Harbour Lettings', website: 'https://harbour.example' });
    const retried = await a.createBrand({ userId: alice.user }, { commandId: command, name: 'Harbour Lettings', website: 'https://harbour.example' });
    assert.equal(created.created, true);
    assert.equal(retried.created, false);
    assert.equal(retried.brand.id, created.brand.id);
    const second = await a.createBrand({ userId: alice.user }, { commandId: randomUUID(), name: 'Harbour Lettings' });
    assert.notEqual(second.brand.slug, created.brand.slug, 'a clashing slug is made unique, never duplicated');
    assert.equal((await a.listBrands({ userId: alice.user })).length, 2);
    const brandId = created.brand.id;

    // Bob cannot see or touch Alice's brand: RLS denies, the engine answers "not found".
    const b = engineFor(bob);
    assert.equal((await b.listBrands({ userId: bob.user })).length, 0);
    await assert.rejects(b.getBrand({ userId: bob.user }, brandId), { status: 404 });
    const raw = await content.connect();
    try {
      await raw.query('BEGIN');
      await raw.query(`SELECT set_config('app.user_id', $1, true), set_config('app.workspace_id', $2, true), set_config('app.actor_kind', 'user', true), set_config('app.request_id', 'x', true)`, [bob.user, brandId]);
      const rows = await raw.query('SELECT count(*)::int AS n FROM app.seo_blog_brands');
      assert.equal(rows.rows[0].n, 0, 'forced RLS hides the foreign brand');
      await assert.rejects(raw.query(`INSERT INTO app.seo_blog_records (workspace_id, kind, id, data) VALUES ($1, 'plan', 'x', '{}')`, [brandId]));
      await raw.query('ROLLBACK');
    } finally { raw.release(); }

    // Full journey through the real store: knowledge → profile → plan → article → edit history.
    seedBrandSite(h.web, 'https://harbour.example', 'deposits');
    const actor = { userId: alice.user };
    const brand = await a.getBrand(actor, brandId);
    await a.updateSettings(actor, brandId, brand.rowVersion, { budgets: { modelTokensPerMonth: 2_000_000, searchCallsPerMonth: 200, imagesPerMonth: 0 } });
    await a.uploadKnowledge(actor, brandId, { category: 'product_facts', title: 'Plans', filename: 'plans.txt', bytes: Buffer.from('Harbour Lettings Compliance Plan costs £49 per month.') });
    const profile = await a.extractBrandProfile(actor, brandId);
    await a.confirmProfile(actor, brandId, profile.version);
    await a.requestPlan(actor, brandId, { commandId: randomUUID() });
    const worker = new SeoBlogEngine({ store: new PgSeoBlogStore(content, { kind: 'worker', requestId: `w-${randomUUID()}` }), llm: h.llm, search: h.search, transport: h.web, publishers: new Map(), vault: h.vault, now: h.clock.now });
    await worker.tick('pg-worker');
    const { plan, briefs } = (await a.listPlans(actor, brandId))[0]!;
    assert.equal(briefs.length, 7);
    await a.acceptPlan(actor, brandId, plan.id);
    const pillar = briefs.find((x) => x.role === 'pillar')!;
    await a.requestArticles(actor, brandId, [pillar.id]);
    await a.requestArticles(actor, brandId, [pillar.id]);
    await worker.tick('pg-worker');
    const [listed] = await a.listArticles(actor, brandId);
    const detail = await a.getArticle(actor, brandId, listed!.article.id);
    const v2 = await a.regenerateSection(actor, brandId, detail.article.id, detail.version!.id, detail.version!.body.sections[1]!.id, 'Shorter.');
    const after = await a.getArticle(actor, brandId, detail.article.id);
    assert.equal(after.versions.length, 2);
    assert.equal(after.version!.id, v2.id);
    await assert.rejects(admin.query('UPDATE app.seo_blog_article_versions SET number = 9 WHERE id = $1', [v2.id]), /append-only/);
    assert.equal((await a.listJobs(actor, brandId)).filter((j) => j.kind === 'write').length, 1, 'duplicate clicks share one job');
    assert.equal((await a.listKnowledge(actor, brandId)).length, 1);
    assert.equal((await b.listBrands({ userId: bob.user })).length, 0);
  } finally {
    await admin.end();
    await content.end();
  }
});

// ─── Publication-begin boundary under overlapping real sessions ─────────────

import { MemorySeoBlogStore } from '../../src/seo-blog/store.js';
import { GithubStaticPublisher } from '../../src/seo-blog/publishers/github-static.js';
import type { PublisherRegistry } from '../../src/seo-blog/publishers/registry.js';
import type { WebsitePublisher } from '../../src/seo-blog/publishers/types.js';
import type { DestinationType } from '../../src/seo-blog/types.js';

async function waitForLockWait(admin: pg.Pool, timeoutMs = 5000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const r = await admin.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = 'r72_content_command' AND wait_event_type = 'Lock'`);
    if (r.rows[0].n > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

async function scheduledPgArticle(admin: pg.Pool, content: pg.Pool) {
  void MemorySeoBlogStore;
  const owner = await seedOwner(admin, `race${randomUUID().slice(0, 6)}`);
  const h = harness();
  const publishers: PublisherRegistry = new Map<DestinationType, WebsitePublisher>([['github_static', new GithubStaticPublisher(h.github.fetch, 1000)]]);
  const user = new SeoBlogEngine({ store: new PgSeoBlogStore(content, { kind: 'user', userId: owner.user, requestId: `u-${randomUUID()}`, sessionToken: owner.token, selectedWorkspaceId: owner.ws }), llm: h.llm, search: h.search, transport: h.web, publishers, vault: h.vault, now: h.clock.now });
  const workerFor = () => new SeoBlogEngine({ store: new PgSeoBlogStore(content, { kind: 'worker', requestId: `w-${randomUUID()}` }), llm: h.llm, search: h.search, transport: h.web, publishers, vault: h.vault, now: h.clock.now });
  const actor = { userId: owner.user };
  seedBrandSite(h.web, 'https://harbour.example', 'deposits');
  const { brand } = await user.createBrand(actor, { commandId: randomUUID(), name: `Race ${randomUUID().slice(0, 6)}`, website: 'https://harbour.example' });
  let b = await user.getBrand(actor, brand.id);
  b = await user.updateSettings(actor, brand.id, b.rowVersion, { autoPublish: true, budgets: { modelTokensPerMonth: 2_000_000, searchCallsPerMonth: 200, imagesPerMonth: 0 } });
  await user.uploadKnowledge(actor, brand.id, { category: 'product_facts', title: 'Plans', pastedText: 'Compliance Plan costs £49 per month.' });
  const profile = await user.extractBrandProfile(actor, brand.id);
  await user.confirmProfile(actor, brand.id, profile.version);
  await user.requestPlan(actor, brand.id, { commandId: randomUUID() });
  await workerFor().tick('w');
  const { plan, briefs } = (await user.listPlans(actor, brand.id))[0]!;
  await user.acceptPlan(actor, brand.id, plan.id);
  await user.requestArticles(actor, brand.id, [briefs.find((x) => x.role === 'pillar')!.id]);
  await workerFor().tick('w');
  const id = (await user.listArticles(actor, brand.id))[0]!.article.id;
  const destination = await user.connectDestination(actor, brand.id, { type: 'github_static', label: 'Site', credential: 'gh-token-1', config: { repository: 'acme/site', branch: 'main', publicBaseUrl: 'https://harbour.example' } });
  assert.equal(destination.status, 'connected', destination.statusDetail);
  const art = (await user.getArticle(actor, brand.id, id)).article;
  await user.schedule(actor, brand.id, id, art.rowVersion, { localDate: '2026-11-03', localTime: '09:00', destinationId: destination.id });
  h.clock.set('2026-11-03T09:00:30.000Z');
  return { h, user, workerFor, actor, brandId: brand.id, id };
}

test('PostgreSQL begin boundary: an uncommitted pause blocks begin, and once committed prevents dispatch', { skip }, async () => {
  const admin = new pg.Pool({ connectionString: adminUrl, max: 3 });
  const content = new pg.Pool({ connectionString: contentUrl, max: 6 });
  try {
    const s = await scheduledPgArticle(admin, content);
    const pauser = await admin.connect();
    try {
      await pauser.query('BEGIN');
      await pauser.query(`UPDATE app.seo_blog_brands SET settings = jsonb_set(settings, '{pauseAll}', 'true'), row_version = row_version + 1 WHERE workspace_id = $1`, [s.brandId]);
      const dispatch = s.workerFor().dispatchDue(s.brandId);
      assert.equal(await waitForLockWait(admin), true, 'the worker waits on the brand lock inside the begin boundary');
      await pauser.query('COMMIT');
      await dispatch;
    } finally { pauser.release(); }
    const d = await s.user.getArticle(s.actor, s.brandId, s.id);
    assert.equal(d.publications.length, 0, 'no operation was recorded');
    assert.equal(d.article.hold?.reason, 'paused');
    assert.equal(s.h.github.refPatches, 0, 'nothing reached the website');
  } finally { await admin.end(); await content.end(); }
});

test('PostgreSQL begin boundary: concurrent duplicate workers begin exactly once', { skip }, async () => {
  const admin = new pg.Pool({ connectionString: adminUrl, max: 3 });
  const content = new pg.Pool({ connectionString: contentUrl, max: 8 });
  try {
    const s = await scheduledPgArticle(admin, content);
    // Hold the article row so every worker queues on the same lock, then release them together.
    const holder = await admin.connect();
    let workers: Promise<unknown>[];
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM app.seo_blog_articles WHERE workspace_id = $1 AND id = $2 FOR UPDATE', [s.brandId, s.id]);
      workers = [s.workerFor(), s.workerFor(), s.workerFor(), s.workerFor()].map((w) => w.dispatchDue(s.brandId));
      assert.equal(await waitForLockWait(admin), true);
      await holder.query('COMMIT');
    } finally { holder.release(); }
    await Promise.all(workers);
    const rows = await admin.query('SELECT count(*)::int AS n FROM app.seo_blog_publications WHERE workspace_id = $1', [s.brandId]);
    assert.equal(rows.rows[0].n, 1, 'one operation row');
    assert.equal(s.h.github.refPatches, 1, 'one provider effect');
    assert.equal((await s.user.getArticle(s.actor, s.brandId, s.id)).status, 'Published');
  } finally { await admin.end(); await content.end(); }
});

test('PostgreSQL reconciliation: a pause racing a confirmed-absent resend wins; no resend', { skip }, async () => {
  const admin = new pg.Pool({ connectionString: adminUrl, max: 3 });
  const content = new pg.Pool({ connectionString: contentUrl, max: 6 });
  try {
    const s = await scheduledPgArticle(admin, content);
    s.h.github.failNextRefBeforeApply = 2;
    await s.workerFor().dispatchDue(s.brandId);
    const before = (await s.user.getArticle(s.actor, s.brandId, s.id)).publications[0]!;
    assert.equal(before.state, 'outcome_unknown');
    s.h.clock.advance(60_000);
    const pauser = await admin.connect();
    try {
      await pauser.query('BEGIN');
      await pauser.query(`UPDATE app.seo_blog_brands SET settings = jsonb_set(settings, '{pauseAll}', 'true'), row_version = row_version + 1 WHERE workspace_id = $1`, [s.brandId]);
      const reconcile = s.workerFor().reconcile(s.brandId);
      assert.equal(await waitForLockWait(admin), true);
      await pauser.query('COMMIT');
      await reconcile;
    } finally { pauser.release(); }
    const after = (await s.user.getArticle(s.actor, s.brandId, s.id));
    assert.equal(after.publications.length, 1);
    assert.equal(after.publications[0]!.id, before.id);
    assert.equal(after.publications[0]!.state, 'cancelled');
    assert.ok(after.publications[0]!.events!.some((e) => e.state === 'outcome_unknown'));
    assert.equal(s.h.github.refPatches, 0);
    assert.equal(after.article.hold?.reason, 'paused');
  } finally { await admin.end(); await content.end(); }
});
