/**
 * PostgreSQL proof for the keyword review fixes, through the real PgSeoBlogStore as r72_content_command under forced
 * RLS (owner sessions and the worker). Skipped unless both URLs point at a disposable *test* database:
 *   SEO_BLOG_PG_ADMIN_URL   - superuser/migrator URL used only to seed identity rows and stored records
 *   SEO_BLOG_PG_CONTENT_URL - the same database as r72_content_command
 * The supplier is a double: no network and no paid call.
 *
 * Covers: 3-A (two fill tasks on two workers pay each lookup once; a second request joins), 3-C (a change of country
 * keeps the ledger), 2-C (a newer-shaped list is never overwritten and never stops planning), 4-A/4-B (planning binds
 * by id only on the real store; a list for another country is not used).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { PgSeoBlogStore } from '../../src/seo-blog/pg-store.js';
import { SeoBlogEngine } from '../../src/seo-blog/engine.js';
import { emptyKeywordStore, type StoredKeywordRow } from '../../src/seo-blog/keyword-store-shape.js';
import type { LabsMarket } from '../../src/keyword/dataforseo-labs.js';
import { harness, seedBrandSite } from '../seo-blog-fixtures.js';
import { grantFounderAllowance } from './seo-blog-allowance-fixture.js';

const adminUrl = process.env.SEO_BLOG_PG_ADMIN_URL;
const contentUrl = process.env.SEO_BLOG_PG_CONTENT_URL;
const skip = !adminUrl || !contentUrl || !/test/i.test(adminUrl) ? 'set SEO_BLOG_PG_ADMIN_URL and SEO_BLOG_PG_CONTENT_URL to a disposable *test* database' : false;

async function seedOwner(admin: pg.Pool, label: string) {
  const org = randomUUID(), user = randomUUID(), home = randomUUID(), token = randomUUID() + randomUUID();
  await admin.query(`INSERT INTO app.organizations (id, name, slug, kind) VALUES ($1, $2, $3, 'direct_customer')`, [org, `Org ${label}`, `org-${label}-${org.slice(0, 8)}`]);
  await admin.query(`INSERT INTO app.users (id, email, status) VALUES ($1, $2, 'active')`, [user, `${label}-${user.slice(0, 8)}@example.test`]);
  await admin.query(`INSERT INTO app.organization_memberships (organization_id, user_id, role, status) VALUES ($1, $2, 'owner', 'active')`, [org, user]);
  await admin.query(`INSERT INTO app.workspaces (id, organization_id, name, slug) VALUES ($1, $2, 'Home', $3)`, [home, org, `home-${home.slice(0, 8)}`]);
  await admin.query(`INSERT INTO app.workspace_memberships (workspace_id, organization_id, user_id, role, status, source_organization_id) VALUES ($1, $2, $3, 'owner', 'active', $2)`, [home, org, user]);
  await admin.query(`INSERT INTO app.user_sessions (token_hash, csrf_secret_hash, user_id, selected_workspace_id, expires_at) VALUES ($1, $2, $3, $4, now() + interval '1 hour')`,
    [createHash('sha256').update(token).digest(), createHash('sha256').update(`csrf${token}`).digest(), user, home]);
  return { user, home, token };
}

class Fake {
  readonly mode = 'live' as const;
  args: string[] = [];
  private async answer(endpoint: string, m: LabsMarket, arg: string) {
    this.args.push(`${endpoint}(${arg})@${m.locationCode}`);
    await new Promise((r) => setTimeout(r, 20));
    const rows = ['landlord compliance', 'deposit protection'].map((p, i) => ({ phrase: `${p} ${endpoint.split('_')[1]} ${i}`, searches: 100 + i, measuredMonth: '2026-10', dataUpdatedAt: null, rankingDifficulty: 20,
      adCompetition: null, cpc: null, intent: 'informational', secondaryIntents: [], source: 'ideas', parent: null, locationCode: m.locationCode, languageCode: m.languageCode }));
    return { endpoint, status: 'ok', rows, skippedRows: 0, totalCount: rows.length, providerReportedCost: 0.0124, taskId: 't', diagnostic: null };
  }
  keywordsForSite(d: string, m: LabsMarket) { return this.answer('keywords_for_site', m, d); }
  rankedKeywords(d: string, m: LabsMarket) { return this.answer('ranked_keywords', m, d); }
  keywordIdeas(s: readonly string[], m: LabsMarket) { return this.answer('keyword_ideas', m, s.join('|')); }
  keywordSuggestions(seed: string, m: LabsMarket) { return this.answer('keyword_suggestions', m, seed); }
  async relatedKeywords(): Promise<never> { throw new Error('not used'); }
  async competitorDomains(): Promise<never> { throw new Error('not used'); }
  async keywordOverview(): Promise<never> { throw new Error('not used'); }
  async bulkKeywordDifficulty(): Promise<never> { throw new Error('not used'); }
  async searchIntent(): Promise<never> { throw new Error('not used'); }
  async readSerpObservations(): Promise<never> { throw new Error('not used'); }
}

test('PostgreSQL: keyword fill never pays twice, keeps its ledger across a country change, and planning binds by id only', { skip, timeout: 240_000 }, async () => {
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  const content = new pg.Pool({ connectionString: contentUrl, max: 8 });
  try {
    assert.equal((await content.query<{ u: string }>('SELECT current_user AS u')).rows[0]!.u, 'r72_content_command');
    const alice = await seedOwner(admin, 'kw');
    const h = harness(new Date().toISOString());
    seedBrandSite(h.web, 'https://harbour.example', 'deposits');
    const kw = new Fake();
    const deps = { llm: h.llm, search: h.search, transport: h.web, publishers: new Map(), vault: h.vault, now: h.clock.now, keywordResearch: kw as never };
    const owner = new SeoBlogEngine({ ...deps, store: new PgSeoBlogStore(content, { kind: 'user', userId: alice.user, selectedWorkspaceId: alice.home, sessionToken: alice.token, requestId: randomUUID() }) });
    const workerStore = () => new PgSeoBlogStore(content, { kind: 'worker', requestId: randomUUID() });
    const workerA = new SeoBlogEngine({ ...deps, store: workerStore() }), workerB = new SeoBlogEngine({ ...deps, store: workerStore() });
    const actor = { userId: alice.user };
    const { brand } = await owner.createBrand(actor, { commandId: randomUUID(), name: 'Harbour Lettings', website: 'https://harbour.example' });
    await grantFounderAllowance(admin, content, alice, brand.id, { modelTokens: 2_000_000, searchCalls: 200 });
    const b0 = await owner.getBrand(actor, brand.id);
    await owner.updateSettings(actor, brand.id, b0.rowVersion, { budgets: { modelTokensPerMonth: 2_000_000, searchCallsPerMonth: 200, imagesPerMonth: 0 } });
    await owner.uploadKnowledge(actor, brand.id, { category: 'product_facts', title: 'Plans', filename: 'plans.txt', bytes: Buffer.from('Harbour Lettings Compliance Plan costs £49 per month.') });
    const profile = await owner.extractBrandProfile(actor, brand.id);
    await owner.confirmProfile(actor, brand.id, profile.version);
    await workerA.refreshInventory(brand.id);
    const usage = async () => Number((await admin.query("SELECT count(*) AS n FROM app.seo_blog_usage WHERE workspace_id=$1 AND kind='search_calls' AND reference LIKE 'keywords:%'", [brand.id])).rows[0].n);

    // 3-A: a second request joins the first; two tasks claimed by two workers at once pay each lookup once.
    const first = await owner.requestKeywordFill(actor, brand.id, { commandId: randomUUID() });
    assert.equal((await owner.requestKeywordFill(actor, brand.id, { commandId: randomUUID() })).id, first.id);
    const ownerStore = (owner as unknown as { store: PgSeoBlogStore }).store;
    const queued = (await ownerStore.getJob(brand.id, first.id))!;
    const twinId = randomUUID();
    await ownerStore.enqueueJob({ ...queued, id: twinId, idempotencyKey: `keywords:${twinId}`, payload: { keywordFill: { commandId: 'twin', attempts: [] } }, rowVersion: 1 });
    const [a] = await (workerA as unknown as { store: PgSeoBlogStore }).store.claimJobs({ now: h.clock.now(), owner: 'wA', leaseMs: 600_000, limit: 1 });
    const [b] = await (workerB as unknown as { store: PgSeoBlogStore }).store.claimJobs({ now: h.clock.now(), owner: 'wB', leaseMs: 600_000, limit: 1 });
    assert.ok(a && b, 'two workers each hold one fill task');
    await Promise.all([workerA.runJob(a), workerB.runJob(b)]);
    const counts = new Map<string, number>(); for (const x of kw.args) counts.set(x, (counts.get(x) ?? 0) + 1);
    assert.ok(counts.size > 0 && [...counts.values()].every((n) => n === 1), JSON.stringify([...counts]));
    assert.equal(await usage(), counts.size, 'one research attempt per lookup');
    const states = (await admin.query("SELECT state FROM app.seo_blog_jobs WHERE workspace_id=$1 AND kind='inventory' AND data->'payload' ? 'keywordFill'", [brand.id])).rows.map((r) => r.state);
    assert.deepEqual(states.sort(), ['done', 'done']);

    // 3-C: a change of country starts a new list and keeps the ledger.
    const ledgerBefore = (await owner.keywordList(actor, brand.id))!.ledger;
    const basics = await owner.getBrand(actor, brand.id);
    await owner.updateBrandBasics(actor, brand.id, { rowVersion: basics.rowVersion, website: basics.website, locale: 'en-US', timezone: basics.timezone });
    await owner.requestKeywordFill(actor, brand.id, { commandId: randomUUID() });
    await workerA.tick('wA');
    const us = (await owner.keywordList(actor, brand.id))!;
    assert.equal(us.locationCode, 2840);
    assert.equal(us.ledger.entries.length, ledgerBefore.entries.length * 2);
    const back = await owner.getBrand(actor, brand.id);
    await owner.updateBrandBasics(actor, brand.id, { rowVersion: back.rowVersion, website: back.website, locale: 'en-GB', timezone: back.timezone });

    // 4-A / 4-B: a measured UK list; the scripted planner chooses by id on the real store.
    const now = h.clock.now();
    const row = (phrase: string, searches: number, i: number): StoredKeywordRow => ({ id: `id-${i}`, key: phrase, phrase, basis: 'measured', searches, measuredMonth: '2026-10', parent: null, parentSearches: null, rankingDifficulty: 20,
      intent: 'informational', sources: ['ideas'], clusterId: 'c1', role: i === 0 ? 'pillar' : 'supporting', ownPosition: null, opportunity: 1 - i / 20, why: 'w', measuredAt: now });
    const pool = { ...emptyKeywordStore(2826, 'en').pool, builtAt: now, state: 'measured', rows: [['tenancy deposit protection', 2400], ['deposit protection deadline', 480], ['return tenancy deposit', 390], ['deposit dispute evidence', 170],
      ['deposit protection schemes', 720], ['prescribed information deposit', 260], ['landlord deposit return rules', 210]].map(([p, n], i) => row(p as string, n as number, i)), calls: [], ledger: us.ledger };
    await admin.query("UPDATE app.seo_blog_records SET data = jsonb_set(data, '{keywordPool}', $2::jsonb) WHERE workspace_id=$1 AND kind='inventory' AND id='current'", [brand.id, JSON.stringify(pool)]);
    await owner.requestPlan(actor, brand.id, { commandId: randomUUID() });
    await workerA.tick('wA');
    const { plan, briefs } = (await owner.listPlans(actor, brand.id)).at(-1)!;
    assert.match(plan.generation.promptVersion, /^seo-blog-plan-v2\.md@2\.0\.0#/);
    assert.equal(plan.keywordPlanning?.stripped, 0);
    assert.equal(briefs.find((x) => x.slug.startsWith('deposits-basics'))!.seo!.primary.basis, 'none', 'no similarity binding on the real store');
    assert.equal(briefs.find((x) => x.slug === 'returning-a-tenancy-deposit')!.seo!.primary.phrase, 'return tenancy deposit');

    // 2-C: a newer-shaped list: no fill overwrites it, planning still runs, and the worker pass completes.
    const newer = { schema: 2, locationCode: 2826, languageCode: 'en', builtAt: now, entries: {} };
    await admin.query("UPDATE app.seo_blog_records SET data = jsonb_set(data, '{keywordPool}', $2::jsonb) WHERE workspace_id=$1 AND kind='inventory' AND id='current'", [brand.id, JSON.stringify(newer)]);
    await assert.rejects(owner.requestKeywordFill(actor, brand.id, { commandId: randomUUID() }), /newer version/);
    assert.equal((await owner.keywordListRead(actor, brand.id)).status, 'newer');
    assert.deepEqual(await owner.keywordNextUp(actor, brand.id), []);
    await owner.requestPlan(actor, brand.id, { commandId: randomUUID() });
    await workerA.tick('wA');
    const latest = (await admin.query("SELECT state FROM app.seo_blog_jobs WHERE workspace_id=$1 AND kind='plan' ORDER BY created_at DESC LIMIT 1", [brand.id])).rows[0]?.state;
    assert.equal(latest, 'done');
    assert.deepEqual((await admin.query("SELECT data->'keywordPool' AS p FROM app.seo_blog_records WHERE workspace_id=$1 AND kind='inventory' AND id='current'", [brand.id])).rows[0].p, newer);
  } finally {
    await content.end(); await admin.end();
  }
});
