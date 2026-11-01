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
