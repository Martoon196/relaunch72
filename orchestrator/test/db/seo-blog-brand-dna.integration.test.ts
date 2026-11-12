/**
 * Brand DNA website door on the real Postgres store, as the actual r72_content_command role.
 * Run only on the disposable test database. The website and the writing model are the offline fakes.
 *
 * Proves, on Postgres rather than the in-memory store:
 *   - pages read from the website travel with the card task and are not brand documents yet;
 *   - a refused or failed card leaves documents, the confirmed profile and readiness unchanged;
 *   - a made card and its pages are written in ONE transaction (same xmin), and roll back together;
 *   - two presses at once queue one read and one card;
 *   - usage is recorded exactly once per call.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { PgSeoBlogStore } from '../../src/seo-blog/pg-store.js';
import { SeoBlogEngine } from '../../src/seo-blog/engine.js';
import { profilePayload } from '../../src/seo-blog/profile-jobs.js';
import { harness } from '../seo-blog-fixtures.js';
import { openTestDatabase, testDatabaseSkipReason } from './database-helper.js';
import { grantFounderAllowance } from './seo-blog-allowance-fixture.js';

const skip = testDatabaseSkipReason();
const SITE = 'https://quay.example';
const HOME_WORDS = 'Quay Lettings helps private landlords in Kent stay compliant and let their homes with confidence. We explain the rules in plain English, remind you before each deadline and keep your paperwork in one tidy place so nothing is missed.';
const PRICING_WORDS = 'The Quay Compliance Plan costs £49 per month. It covers gas safety reminders, deposit protection checks and a yearly review call with a named adviser for every home you let.';
const ABOUT_WORDS = 'We help landlords in Kent. Our small team has managed rented homes across Medway and Maidstone for many years and still answers the phone ourselves every working day.';
const page = (title: string, words: string, links = '') => `<html><head><title>${title}</title></head><body><main><h1>${title}</h1><p>${words}</p>${links}</main></body></html>`;

interface ModelDoc { id: string; text: string }
/** A card that quotes its sources word for word, as the door requires. */
function honestCard(docs: ModelDoc[]): Record<string, unknown> {
  const priced = docs.find((d) => d.text.includes('Quay Compliance Plan costs £49 per month'))!;
  const who = docs.find((d) => d.text.includes('private landlords in Kent'))!, claim = docs.find((d) => d.text.includes('We help landlords in Kent'))!;
  return {
    summary: 'Quay Lettings helps private landlords in Kent stay compliant.', audiences: ['Private landlords in Kent'], positioning: 'Plain-English compliance help.',
    offers: [{ name: 'Quay Compliance Plan', description: 'Monthly compliance support', price: '£49 per month', url: null, sourceDocumentId: priced.id }],
    conversionPages: [], voice: { tone: ['plain'], do: [], dont: [], examples: [] }, approvedClaims: ['We help landlords in Kent'], exclusions: [], conflicts: [], missingFacts: [],
    sources: [{ field: 'audience', value: 'Private landlords in Kent', documentId: who.id, quote: 'private landlords in Kent' }, { field: 'claim', value: 'We help landlords in Kent', documentId: claim.id, quote: 'We help landlords in Kent' }],
  };
}

async function contentLogin(admin: pg.Pool): Promise<pg.Pool> {
  const password = `brand-dna-proof-${randomUUID()}`;
  const statement = await admin.query<{ sql: string }>("SELECT pg_catalog.format('ALTER ROLE %I PASSWORD %L', 'r72_content_command', $1::text) AS sql", [password]);
  await admin.query(statement.rows[0]!.sql);
  const url = new URL(process.env.TEST_DATABASE_URL!); url.username = 'r72_content_command'; url.password = password;
  return new pg.Pool({ connectionString: url.toString(), max: 6, application_name: 'relaunch72-disposable-brand-dna' });
}

async function seedOwner(admin: pg.Pool) {
  const org = randomUUID(), user = randomUUID(), home = randomUUID(), token = randomUUID() + randomUUID();
  await admin.query("INSERT INTO app.organizations(id,name,slug,kind) VALUES($1,'Brand DNA proof',$2,'direct_customer')", [org, `dna-${org}`]);
  await admin.query("INSERT INTO app.users(id,email,status) VALUES($1,$2,'active')", [user, `async-${user}@example.test`]);
  await admin.query("INSERT INTO app.organization_memberships(organization_id,user_id,role,status) VALUES($1,$2,'owner','active')", [org, user]);
  await admin.query("INSERT INTO app.workspaces(id,organization_id,name,slug) VALUES($1,$2,'Home',$3)", [home, org, `home-${home}`]);
  await admin.query("INSERT INTO app.workspace_memberships(workspace_id,organization_id,user_id,role,status,source_organization_id) VALUES($1,$2,$3,'owner','active',$2)", [home, org, user]);
  await admin.query("INSERT INTO app.user_sessions(token_hash,csrf_secret_hash,user_id,selected_workspace_id,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')", [createHash('sha256').update(token).digest(), createHash('sha256').update(`csrf${token}`).digest(), user, home]);
  return { user, home, token };
}

test('Brand DNA door on Postgres: pages wait with the card task, a refused or failed card changes nothing, a made card and its pages are one write, one read for two presses, usage once', { skip, timeout: 240_000 }, async () => {
  const admin = await openTestDatabase(); const content = await contentLogin(admin);
  try {
    assert.equal((await content.query('SELECT current_user AS role')).rows[0].role, 'r72_content_command');
    const alice = await seedOwner(admin);
    const h = harness(new Date().toISOString());
    h.web.set(`${SITE}/`, page('Quay Lettings', HOME_WORDS, '<a href="/pricing">Pricing</a><a href="/about">About</a>'));
    h.web.set(`${SITE}/pricing`, page('Pricing', PRICING_WORDS)); h.web.set(`${SITE}/about`, page('About us', ABOUT_WORDS));
    let script: (docs: ModelDoc[]) => Record<string, unknown> = honestCard; let broken = false; let calls = 0;
    h.llm.complete = async (req) => {
      calls++;
      if (broken) throw new Error('socket hang up');
      const docs = JSON.parse(/<knowledge_documents>\n([\s\S]*?)\n<\/knowledge_documents>/.exec(req.messages[0]!.content)![1]!) as ModelDoc[];
      return { text: JSON.stringify(script(docs)), tokensIn: 1000, tokensOut: 800, stopReason: 'end_turn', model: 'scripted' };
    };
    const deps = { llm: h.llm, search: h.search, transport: h.web, publishers: new Map(), vault: h.vault, now: h.clock.now };
    // The portal builds a store and an engine for every request; the worker has its own.
    const asOwner = () => new SeoBlogEngine({ ...deps, store: new PgSeoBlogStore(content, { kind: 'user', userId: alice.user, selectedWorkspaceId: alice.home, sessionToken: alice.token, requestId: randomUUID() }) });
    const workerStore = new PgSeoBlogStore(content, { kind: 'worker', requestId: randomUUID() });
    const owner = asOwner(), worker = new SeoBlogEngine({ ...deps, store: workerStore });
    const actor = { userId: alice.user };
    const { brand } = await owner.createBrand(actor, { commandId: randomUUID(), name: 'Quay Lettings', website: SITE });
    await grantFounderAllowance(admin, content, alice, brand.id, { modelTokens: 2_000_000 });
    await owner.updateSettings(actor, brand.id, (await owner.getBrand(actor, brand.id)).rowVersion, { budgets: { modelTokensPerMonth: 1_000_000, searchCallsPerMonth: 0, imagesPerMonth: 0 } });
    /** One worker pass over this brand's waiting tasks only, so other brands left in the disposable database are never run. */
    const round = async (name: string) => { h.clock.advance(1000); for (const job of await workerStore.claimJobs({ brandId: brand.id, now: h.clock.now(), owner: name, leaseMs: 600_000, limit: 5 })) await worker.runJob(job); };
    const work = async (name: string) => { for (let i = 0; i < 4; i++) await round(`${name}-${i}`); };
    const count = async (sql: string) => (await admin.query<{ n: number }>(sql, [brand.id])).rows[0]!.n;
    const dnaJobs = () => count("SELECT count(*)::int AS n FROM app.seo_blog_jobs WHERE workspace_id=$1 AND kind='inventory' AND data->'payload'->>'stage'='brand_dna'");
    const cardJobs = () => count("SELECT count(*)::int AS n FROM app.seo_blog_jobs WHERE workspace_id=$1 AND kind='write' AND data->'payload'->>'stage'='profile' AND data->'payload'->'source'->>'strict'='true'");
    const heldPages = () => count("SELECT count(*)::int AS n FROM app.seo_blog_jobs WHERE workspace_id=$1 AND data->'payload' ? 'staged'");
    const usageRows = async () => (await admin.query<{ reference: string; n: number; amount: number }>('SELECT reference,count(*)::int AS n,sum(amount)::int AS amount FROM app.seo_blog_usage WHERE workspace_id=$1 GROUP BY reference ORDER BY reference', [brand.id])).rows;

    // A brand set up and confirmed the older way, from pasted details: the state Property Predator is in today.
    await owner.uploadKnowledge(actor, brand.id, { category: 'product_facts', title: 'About my business', pastedText: `${HOME_WORDS} ${ABOUT_WORDS} ${PRICING_WORDS}` });
    await owner.requestProfileExtraction(actor, brand.id, { commandId: randomUUID(), baseVersion: 0 }); await work('setup');
    const confirmed = await owner.confirmProfile(actor, brand.id, (await owner.getProfile(actor, brand.id))!.version);
    assert.ok(confirmed.confirmedAt); assert.equal(confirmed.strict, undefined);
    /** The database's own answer to "is the confirmed profile bound to exactly today's documents?", asked inside this brand's scope as its definer reads it. */
    const usableProfile = async (): Promise<string | null> => {
      const client = await admin.connect();
      try {
        await client.query('BEGIN'); await client.query("SELECT set_config('app.workspace_id', $1, true)", [brand.id]);
        const sha = (await client.query<{ sha: string | null }>('SELECT md5(app_private.seo_creator_profile($1)::text) AS sha', [brand.id])).rows[0]!.sha;
        await client.query('ROLLBACK'); return sha;
      } finally { client.release(); }
    };
    /** Every stored document and profile byte, what the owner's pages read, and what the database's own check of the confirmed profile returns. */
    const state = async () => ({
      records: (await admin.query("SELECT kind,id,md5(data::text) AS sha FROM app.seo_blog_records WHERE workspace_id=$1 AND kind IN ('knowledge','profile') ORDER BY kind,id", [brand.id])).rows,
      readiness: { ...await asOwner().readiness(actor, brand.id), inventory: null }, status: await asOwner().brandDnaStatus(actor, brand.id),
      usable: await usableProfile(),
    });
    const before = await state();
    assert.equal(before.status, 'confirmed'); assert.equal(before.readiness.profile, 'confirmed'); assert.equal(before.records.length, 3, 'one document, the extracted profile and its confirmation');
    assert.ok(before.usable, 'the database itself accepts the confirmed profile as bound to today’s documents');

    // Two presses at once, each its own request: one read. The model keeps an audience it cannot quote: the card is refused.
    script = (docs) => ({ ...honestCard(docs), audiences: ['Private landlords in Kent', 'Landlords everywhere'] });
    const [first, second] = await Promise.all([asOwner().requestBrandDna(actor, brand.id, { commandId: randomUUID(), readAgain: true }), asOwner().requestBrandDna(actor, brand.id, { commandId: randomUUID(), readAgain: true })]);
    assert.equal(first.id, second.id); assert.equal(await dnaJobs(), 1, 'two presses, one read');
    await round('read');
    assert.equal(await cardJobs(), 1); assert.equal(await heldPages(), 1);
    assert.equal(await count("SELECT jsonb_array_length(data->'payload'->'staged')::int AS n FROM app.seo_blog_jobs WHERE workspace_id=$1 AND data->'payload' ? 'staged'"), 3, 'the three pages wait with the card task');
    assert.deepEqual(await state(), before, 'the read on its own stores no document and leaves the confirmed profile current');
    const callsBefore = calls; await work('refused');
    assert.equal(calls - callsBefore, 2, 'one answer and one correction');
    const refused = (await workerStore.listJobs(brand.id)).find((j) => j.payload.stage === 'profile' && profilePayload(j).reason === 'rejected')!;
    assert.equal(refused.state, 'blocked'); assert.match(refused.error!, /Nothing was saved or changed\./); assert.equal(await heldPages(), 0, 'the pages are dropped with the refused task');
    assert.deepEqual(await state(), before, 'refused: documents, confirmed profile and readiness are byte for byte as they were');

    // The call to the writing service breaks: still nothing changes, and no usage is invented for it.
    broken = true;
    await asOwner().requestBrandDna(actor, brand.id, { commandId: randomUUID(), readAgain: true }); await work('failed');
    assert.equal(await dnaJobs(), 2); assert.equal(await cardJobs(), 2); assert.equal(await heldPages(), 0);
    assert.deepEqual(await state(), before, 'failed: documents, confirmed profile and readiness are byte for byte as they were');
    const afterFailures = await usageRows();
    assert.equal(afterFailures.length, 2); assert.ok(afterFailures.every((r) => r.n === 1)); assert.deepEqual(afterFailures.map((r) => r.amount).sort(), [1800, 3600]);
    assert.equal(afterFailures.filter((r) => r.reference.endsWith(':rejected')).length, 1);

    // Made. The first attempt to save is made to fail AFTER the card row is written, on one of the page rows:
    // if the two were separate writes the card would be left behind. Then the retry saves everything.
    broken = false; script = honestCard;
    const boundary = workerStore.profileJobBoundary.bind(workerStore); let sabotaged = false; let midway: { profiles: number; documents: number; usage: number } | null = null;
    workerStore.profileJobBoundary = async (input) => {
      if (sabotaged && !midway) midway = { profiles: await count("SELECT count(*)::int AS n FROM app.seo_blog_records WHERE workspace_id=$1 AND kind='profile'"), documents: await count("SELECT count(*)::int AS n FROM app.seo_blog_records WHERE workspace_id=$1 AND kind='knowledge'"), usage: (await usageRows()).length };
      return boundary({ ...input, decide: (s) => {
        const result = input.decide(s);
        if (sabotaged || !result.profile || !result.knowledge?.length) return result;
        sabotaged = true;
        // A page row the table refuses (its key is too long), placed last so the card and the other pages are inserted first.
        return { ...result, knowledge: [...result.knowledge, { ...result.knowledge[0]!, id: 'x'.repeat(130) }] };
      } });
    };
    await asOwner().requestBrandDna(actor, brand.id, { commandId: randomUUID(), readAgain: true, acknowledgePriorUsage: true }); await work('made');
    assert.ok(sabotaged, 'the failing save really happened');
    assert.deepEqual(midway, { profiles: 2, documents: 1, usage: 2 }, 'the failed save left no card, no page and no usage behind: one transaction');

    const made = (await asOwner().getProfile(actor, brand.id))!;
    assert.equal(made.version, confirmed.version + 1); assert.equal(made.strict, true); assert.equal(made.confirmedAt, null); assert.equal(made.knowledge.length, 4);
    const documents = await asOwner().listKnowledge(actor, brand.id);
    assert.deepEqual(documents.map((d) => `${d.title} v${d.version} ${d.active}`).sort(), ['About my business v1 true', 'About page v1 true', 'Home page v1 true', 'Pricing page v1 true']);
    assert.equal(await asOwner().brandDnaStatus(actor, brand.id), 'proposed'); assert.equal(await heldPages(), 0, 'no finished task still carries page words');
    const cardJob = (await workerStore.listJobs(brand.id)).find((j) => j.payload.stage === 'profile' && j.state === 'done' && profilePayload(j).source.strict)!;
    // Rows written by one transaction carry the same xmin: the three pages, the card, the task's final state and its usage.
    const written = await admin.query<{ what: string; xmin: string }>(`
      SELECT 'page' AS what, xmin::text FROM app.seo_blog_records WHERE workspace_id=$1 AND kind='knowledge' AND data->'origin'->>'kind'='website'
      UNION ALL SELECT 'card', xmin::text FROM app.seo_blog_records WHERE workspace_id=$1 AND kind='profile' AND (data->>'version')::int=$2
      UNION ALL SELECT 'task', xmin::text FROM app.seo_blog_jobs WHERE workspace_id=$1 AND id=$3
      UNION ALL SELECT 'usage', xmin::text FROM app.seo_blog_usage WHERE workspace_id=$1 AND reference LIKE 'profile:' || $3::text || ':%'`, [brand.id, made.version, cardJob.id]);
    assert.deepEqual(written.rows.map((r) => r.what).sort(), ['card', 'page', 'page', 'page', 'task', 'usage']);
    assert.equal(new Set(written.rows.map((r) => r.xmin)).size, 1, 'pages, card, task and usage were written by the same transaction');

    // Usage exactly once per call that reported back; one read and one card per press throughout.
    const usage = await usageRows();
    assert.equal(usage.length, 3); assert.ok(usage.every((r) => r.n === 1)); assert.equal(usage.reduce((n, r) => n + r.amount, 0), 1800 + 3600 + 1800);
    assert.equal((await asOwner().usage(actor, brand.id)).model_tokens, 7200);
    assert.equal(await dnaJobs(), 3); assert.equal(await cardJobs(), 3);
    await worker.runJob(cardJob); assert.equal((await usageRows()).length, 3, 'running a finished task again records nothing');

    // The owner confirms the new card; the database's own check agrees it is bound to exactly today's pages and documents.
    assert.equal(await usableProfile(), null, 'not used until confirmed');
    assert.ok((await asOwner().confirmBrandDna(actor, brand.id, made.version)).confirmedAt);
    assert.equal((await asOwner().readiness(actor, brand.id)).profile, 'confirmed');
    const usable = await usableProfile();
    assert.ok(usable, 'the database accepts the confirmed card as bound to exactly the pages and documents now active'); assert.notEqual(usable, before.usable);
  } finally { await content.end(); await admin.end(); }
});
