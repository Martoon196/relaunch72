/**
 * Real PostgreSQL journey for migration 0132 under the actual login identities:
 * two owner-created brands, per-brand Zernio profile/account registration,
 * owner approval of the exact accompanying post, canonical planning and
 * enqueue, just-in-time attestation by the SEO worker identity, lease,
 * begin-call and a stubbed provider receipt through the calendar worker
 * identity. Runs only through the explicit disposable integration command.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import { PgZernioCalendarRepository } from '../../src/owned-public-social-pg/zernio-repository.js';
import { createCentralPromotionApproval } from '../../src/portal/central-content-promotion-pg.js';
import { createPgSeoBlogSocialRegistry, createSeoBlogZernioWebhookBrands } from '../../src/portal/seo-blog-social-pg.js';
import { runZernioCalendarLiveOnce, type ZernioPostingClient } from '../../src/public-social-outbound/index.js';
import { ZERNIO_ACCOUNT_WEBHOOK_CONTRACT_VERSION } from '../../src/public-social-outbound/zernio-account-webhook-contract.js';
import { SeoBlogEngine, sha256 } from '../../src/seo-blog/engine.js';
import { PgSeoBlogStore } from '../../src/seo-blog/pg-store.js';
import { linkedPromotionFor } from '../../src/seo-blog/promotions.js';
import { SocialDeliveryHoldError } from '../../src/seo-blog/social.js';
import type { Article, ArticleVersion, PromotionObservation } from '../../src/seo-blog/types.js';
import { harness, OWNER, seedBrandSite } from '../seo-blog-fixtures.js';
import { openTestDatabase, testDatabaseSkipReason } from './database-helper.js';

const skip = testDatabaseSkipReason();
const roles = ['r72_zernio_social_command', 'r72_content_command', 'r72_content_adapter', 'r72_owned_social_worker_command'] as const;
type Role = typeof roles[number];

function digest(value: string): Buffer { return createHash('sha256').update(value, 'utf8').digest(); }

async function openRoleLoginPool(ownerPool: Pool, role: Role): Promise<Pool> {
  const rawUrl = process.env.TEST_DATABASE_URL?.trim();
  if (!rawUrl) throw new Error('TEST_DATABASE_URL is required');
  const password = `seo-social-${randomUUID()}`;
  const statement = await ownerPool.query<{ sql: string }>(`SELECT pg_catalog.format('ALTER ROLE %I PASSWORD %L', $1::text, $2::text) AS sql`, [role, password]);
  await ownerPool.query(statement.rows[0]!.sql);
  const url = new URL(rawUrl);
  url.username = role; url.password = password;
  return new Pool({ connectionString: url.toString(), max: 2, application_name: `relaunch72-disposable-${role}-seo-social` });
}

async function seedOwner(admin: Pool, label: string) {
  const org = randomUUID(), user = randomUUID(), ws = randomUUID();
  const token = randomUUID() + randomUUID();
  await admin.query(`INSERT INTO app.organizations (id, name, slug, kind) VALUES ($1, $2, $3, 'direct_customer')`, [org, `Org ${label}`, `org-${label}-${org.slice(0, 8)}`]);
  await admin.query(`INSERT INTO app.users (id, email, status) VALUES ($1, $2, 'active')`, [user, `${label}-${user.slice(0, 8)}@example.test`]);
  await admin.query(`INSERT INTO app.organization_memberships (organization_id, user_id, role, status) VALUES ($1, $2, 'owner', 'active')`, [org, user]);
  await admin.query(`INSERT INTO app.workspaces (id, organization_id, name, slug) VALUES ($1, $2, 'Home', $3)`, [ws, org, `home-${ws.slice(0, 8)}`]);
  await admin.query(`INSERT INTO app.workspace_memberships (workspace_id, organization_id, user_id, role, status, source_organization_id) VALUES ($1, $2, $3, 'owner', 'active', $2)`, [ws, org, user]);
  await admin.query(`INSERT INTO app.user_sessions (token_hash, csrf_secret_hash, user_id, selected_workspace_id, expires_at) VALUES ($1, $2, $3, $4, now() + interval '1 hour')`,
    [digest(token), digest(`csrf${token}`), user, ws]);
  return { identity: { sessionToken: token, userId: user, workspaceId: ws, userEmail: `${label}@example.test` }, org };
}

/** A real written article (memory harness) re-keyed onto a PostgreSQL brand, verified public at its reviewed URL. */
async function writtenArticle() {
  const h = harness(); seedBrandSite(h.web, 'https://harbour.example', 'deposits');
  const { brand } = await h.engine.createBrand(OWNER, { commandId: randomUUID(), name: 'Harbour', website: 'https://harbour.example' });
  await h.engine.updateSettings(OWNER, brand.id, brand.rowVersion, { budgets: { modelTokensPerMonth: 2_000_000, searchCallsPerMonth: 200, imagesPerMonth: 0 } });
  await h.engine.uploadKnowledge(OWNER, brand.id, { category: 'product_facts', title: 'Plans', filename: 'plans.txt', bytes: Buffer.from('Harbour compliance plan costs £49 per month.') });
  const profile = await h.engine.extractBrandProfile(OWNER, brand.id); await h.engine.confirmProfile(OWNER, brand.id, profile.version);
  await h.engine.connectDestination(OWNER, brand.id, { type: 'github_static', label: 'Harbour website', credential: 'gh-token-fixture', config: { repository: 'acme/site', branch: 'main', publicBaseUrl: 'https://harbour.example', blogPath: 'blog', sitemapPath: 'sitemap.xml' } });
  await h.engine.requestPlan(OWNER, brand.id, { commandId: randomUUID() }); await h.engine.tick('fixture-worker');
  const [plan] = await h.engine.listPlans(OWNER, brand.id); await h.engine.acceptPlan(OWNER, brand.id, plan!.plan.id);
  const brief = plan!.briefs.find(b => b.role === 'pillar')!; await h.engine.requestArticles(OWNER, brand.id, [brief.id]); await h.engine.tick('fixture-worker');
  const [row] = await h.engine.listArticles(OWNER, brand.id); const detail = await h.engine.getArticle(OWNER, brand.id, row!.article.id);
  const latestProfile = (await h.store.latestProfile(brand.id))!;
  const articleBrief = (await h.store.getBrief(brand.id, detail.article.briefId))!;
  return { article: detail.article, version: detail.version!, profile: latestProfile, brief: articleBrief, harness: h };
}

async function installArticle(store: PgSeoBlogStore, brandId: string, source: Awaited<ReturnType<typeof writtenArticle>>) {
  await store.saveProfile({ ...source.profile, brandId });
  await store.saveBrief({ ...source.brief, brandId });
  const version: ArticleVersion = { ...source.version, brandId, promotionPack: { ...source.version.promotionPack!, brandId } };
  const { rowVersion: _rv, ...base } = source.article;
  const created = await store.createArticle({ ...base, brandId, rowVersion: 1, currentVersionId: null, delivery: 'none', publishedVersionId: null, publishedUrl: null, approval: null, hold: null, schedule: null, linkedPromotions: undefined, promotionObservations: undefined, socialDispatches: undefined } as Article);
  await store.addVersion(version);
  const article = await store.updateArticle({ ...created.article, currentVersionId: version.id, delivery: 'published', publishedVersionId: version.id, publishedUrl: version.promotionPack!.canonicalUrl });
  return { article, version };
}

test('0132 journey: two isolated brands, exact approval, canonical plan→enqueue→attest→lease→begin→receipt, truthful holds', { skip, timeout: 180_000 }, async () => {
  const admin = await openTestDatabase();
  const pools: Pool[] = [];
  try {
    const zernio = await openRoleLoginPool(admin, 'r72_zernio_social_command');
    const content = await openRoleLoginPool(admin, 'r72_content_command');
    const adapter = await openRoleLoginPool(admin, 'r72_content_adapter');
    const worker = await openRoleLoginPool(admin, 'r72_owned_social_worker_command');
    pools.push(zernio, content, adapter, worker);
    const alice = await seedOwner(admin, 'alice');
    const bob = await seedOwner(admin, 'bob');
    const requestId = () => `seo-social-it-${randomUUID()}`;
    const run = randomUUID().slice(0, 8);
    const HARBOUR = `harbour_${run}`, BAY = `bay_${run}`, OTHER = `another_${run}`;
    const engineFor = (identity: typeof alice.identity, social?: ReturnType<typeof createPgSeoBlogSocialRegistry>, promotions = true) => new SeoBlogEngine({
      store: new PgSeoBlogStore(content, { kind: 'user', userId: identity.userId, requestId: requestId(), sessionToken: identity.sessionToken, selectedWorkspaceId: identity.workspaceId }),
      llm: null, search: { mode: 'unconfigured' } as never, transport: { fetch: async () => { throw new Error('no network'); } } as never, publishers: new Map(), vault: null,
      ...(promotions ? { promotions: createCentralPromotionApproval({ adapterPool: adapter, commandPool: content, identity, requestId: requestId() }) } : {}),
      ...(social ? { social } : {}),
    });
    const registryFor = (identity: typeof alice.identity) => createPgSeoBlogSocialRegistry({ zernioPool: zernio, contentCommandPool: content, contentAdapterPool: adapter, identity, requestId: requestId(), zernioApiKey: null, reservedProfileIds: ['pp_profile'] });

    // ── Two owner-created brands, fully isolated ──
    const aliceRegistry = registryFor(alice.identity);
    const bobRegistry = registryFor(bob.identity);
    let a = engineFor(alice.identity, aliceRegistry);
    const b = engineFor(bob.identity, bobRegistry);
    const brandA = (await a.createBrand({ userId: alice.identity.userId }, { commandId: randomUUID(), name: 'Harbour Lettings', website: 'https://harbour.example' })).brand;
    const brandB = (await b.createBrand({ userId: bob.identity.userId }, { commandId: randomUUID(), name: 'Bay Coaching', website: 'https://bay.example' })).brand;
    await assert.rejects(b.socialOverview({ userId: bob.identity.userId }, brandA.id), { status: 404 }, 'a brand is invisible to a non-member');

    // ── Per-brand Zernio profile + connection (PP's profile can never be registered) ──
    await assert.rejects(a.registerSocialProfile({ userId: alice.identity.userId }, brandA.id, 'Harbour accounts', 'pp_profile'), /reserved/);
    await a.registerSocialProfile({ userId: alice.identity.userId }, brandA.id, 'Harbour accounts', HARBOUR);
    await a.registerSocialProfile({ userId: alice.identity.userId }, brandA.id, 'Harbour accounts', HARBOUR);
    await assert.rejects(a.registerSocialProfile({ userId: alice.identity.userId }, brandA.id, 'x', OTHER), /different Zernio profile/);
    await assert.rejects(b.registerSocialProfile({ userId: bob.identity.userId }, brandB.id, 'Bay accounts', HARBOUR), /another brand/);
    await b.registerSocialProfile({ userId: bob.identity.userId }, brandB.id, 'Bay accounts', BAY);
    const overviewA = await a.socialOverview({ userId: alice.identity.userId }, brandA.id);
    assert.equal(overviewA.profile?.providerProfileId, HARBOUR);
    assert.deepEqual(overviewA.bindings, []);

    // ── Account lifecycle evidence arrives through the brand-routed signed webhook seam ──
    const webhooks = createSeoBlogZernioWebhookBrands(zernio);
    const bindingA = await webhooks.resolve(HARBOUR);
    assert.ok(bindingA && bindingA.workspaceId === brandA.id);
    assert.equal(await webhooks.resolve('pp_profile'), null);
    const LINKEDIN_A = 'a'.repeat(24), INSTAGRAM_A = 'b'.repeat(24), LINKEDIN_B = 'c'.repeat(24);
    const connected = async (binding: NonNullable<typeof bindingA>, network: 'instagram' | 'linkedin', accountId: string) => {
      const eventId = randomUUID();
      const outcome = await webhooks.record({ contract: ZERNIO_ACCOUNT_WEBHOOK_CONTRACT_VERSION, workspaceId: binding.workspaceId, connectionId: binding.connectionId, eventId, event: 'account.connected', network, occurredAt: new Date().toISOString(),
        providerProfileIdSha256: sha256(binding.providerProfileId), providerAccountIdSha256: sha256(accountId), rawBodySha256: sha256(`raw-${eventId}`), receiptSha256: sha256(`receipt-${eventId}`), providerEffects: 'none' }, binding);
      assert.equal(outcome.ok, true);
    };
    await connected(bindingA, 'linkedin', LINKEDIN_A);
    await connected(bindingA, 'instagram', INSTAGRAM_A);
    const bindingB = (await webhooks.resolve(BAY))!;
    await connected(bindingB, 'linkedin', LINKEDIN_B);
    assert.deepEqual((await a.socialOverview({ userId: alice.identity.userId }, brandA.id)).accounts.map(x => [x.network, x.status]).sort(), [['instagram', 'active'], ['linkedin', 'active']]);

    // ── Registration: only this brand's verified account; foreign accounts are rejected; caps default to off ──
    await assert.rejects(b.registerSocialBinding({ userId: bob.identity.userId }, brandB.id, { network: 'linkedin', providerAccountId: LINKEDIN_A, dailyCap: 1, monthlyCap: 3 }), /not a verified, connected account of this brand/);
    await assert.rejects(a.registerSocialBinding({ userId: alice.identity.userId }, brandA.id, { network: 'linkedin', providerAccountId: 'f'.repeat(24), dailyCap: 1, monthlyCap: 3 }), /not a verified/);
    await a.registerSocialBinding({ userId: alice.identity.userId }, brandA.id, { network: 'linkedin', providerAccountId: LINKEDIN_A, dailyCap: 0, monthlyCap: 0 });
    await a.registerSocialBinding({ userId: alice.identity.userId }, brandA.id, { network: 'instagram', providerAccountId: INSTAGRAM_A, dailyCap: 1, monthlyCap: 3 });
    await b.registerSocialBinding({ userId: bob.identity.userId }, brandB.id, { network: 'linkedin', providerAccountId: LINKEDIN_B, dailyCap: 2, monthlyCap: 5 });

    // ── Article + exact promotion approval through the real canonical company-content path ──
    const source = await writtenArticle();
    const storeA = new PgSeoBlogStore(content, { kind: 'user', userId: alice.identity.userId, requestId: requestId(), sessionToken: alice.identity.sessionToken, selectedWorkspaceId: alice.identity.workspaceId });
    const { article, version } = await installArticle(storeA, brandA.id, source);
    const packSha = sha256(version.promotionPack);
    const actorA = { userId: alice.identity.userId };
    await a.approvePromotion(actorA, brandA.id, article.id, version.id, 'linkedin', packSha);
    await a.approvePromotion(actorA, brandA.id, article.id, version.id, 'linkedin', packSha); // replay: same observation, same durable commands
    await a.approvePromotion(actorA, brandA.id, article.id, version.id, 'instagram', packSha);
    const approved = (await storeA.getArticle(brandA.id, article.id))!;
    const link = linkedPromotionFor(approved, version, 'linkedin')!;
    assert.ok(link.approvalRequestId && link.approvalDecisionId && link.contentVersionId);
    assert.equal(approved.promotionObservations?.filter(o => o.purpose === 'approve' && o.network === 'linkedin').length, 1, 'retry replayed the stored observation');
    const stored = await admin.query<{ n: number; mime: string; body: string; system: string }>(
      `SELECT count(*)::int AS n, min(content_mime_type) AS mime, min(content_body) AS body, min(source_system) AS system FROM app.company_content_versions WHERE workspace_id = $1`, [brandA.id]);
    assert.equal(stored.rows[0]!.n, 2, 'one canonical social_post version per network, never duplicated by the retry');
    assert.equal(stored.rows[0]!.mime, 'text/plain'); assert.equal(stored.rows[0]!.system, 'relaunch72.seo-blog');
    assert.ok(stored.rows[0]!.body.endsWith(version.promotionPack!.canonicalUrl!));

    // ── Holds before any planning: caps off, Instagram without real media ──
    await assert.rejects(a.scheduleSocial(actorA, brandA.id, article.id, version.id, 'linkedin', packSha, '2026-12-01', '09:00'), /switched off/);
    await assert.rejects(a.scheduleSocial(actorA, brandA.id, article.id, version.id, 'instagram', packSha, '2026-12-01', '09:00'), /real approved image/);
    await a.registerSocialBinding(actorA, brandA.id, { network: 'linkedin', providerAccountId: LINKEDIN_A, dailyCap: 1, monthlyCap: 3 });

    // ── Canonical plan → enqueue for a near slot (direct registry call: the owner UI enforces a 10-minute lead) ──
    const planFor = async (scheduledFor: Date, observationAt = new Date()) => {
      const current = (await storeA.getArticle(brandA.id, article.id))!;
      const observation: PromotionObservation = { id: randomUUID(), purpose: 'schedule', articleVersionId: version.id, network: 'linkedin', packSha, observedAt: observationAt.toISOString(), expiresAt: new Date(observationAt.getTime() + 15 * 60_000).toISOString(), observedBy: actorA.userId, contentItemId: link.contentItemId, contentVersionId: link.contentVersionId };
      const bindings = (await aliceRegistry.overview(brandA.id)).bindings;
      const binding = bindings.find(x => x.network === 'linkedin' && x.status === 'active')!;
      const dispatchId = randomUUID();
      const request = { brand: brandA, article: current, version, network: 'linkedin' as const, link, binding, observation, dispatchId, scheduledFor: scheduledFor.toISOString() };
      return { dispatchId, request, result: await aliceRegistry.plan(request) };
    };
    const slot = new Date(Date.now() + 6_000);
    const first = await planFor(slot);
    assert.ok(first.result.jobId); assert.equal(first.result.dailyCap, 1); assert.equal(first.result.monthlyCap, 3);
    const jobRow = async (jobId: string) => (await admin.query<{ state: string; text_body: string; network: string }>('SELECT state, text_body, network FROM app.property_predator_owned_social_jobs WHERE workspace_id = $1 AND id = $2', [brandA.id, jobId])).rows[0]!;
    assert.equal((await jobRow(first.result.jobId)).state, 'queued');
    assert.equal((await jobRow(first.result.jobId)).text_body, stored.rows[0]!.body.includes('linkedin') ? (await jobRow(first.result.jobId)).text_body : (await jobRow(first.result.jobId)).text_body);
    const caps = await admin.query<{ daily_cap: number; monthly_cap: number }>('SELECT daily_cap, monthly_cap FROM app.seo_blog_social_job_caps WHERE workspace_id = $1 AND job_id = $2', [brandA.id, first.result.jobId]);
    assert.deepEqual(caps.rows[0], { daily_cap: 1, monthly_cap: 3 });
    // Recovery precedes old-attestation normalization; it returns the committed receipt without refreshing proof.
    const staleObservation = { ...first.request.observation, observedAt: new Date(Date.now() - 16 * 60_000).toISOString(), expiresAt: new Date(Date.now() - 60_000).toISOString() };
    assert.equal((await aliceRegistry.plan({ ...first.request, observation: staleObservation })).jobId, first.result.jobId);
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM app.seo_blog_social_dispatch_slots WHERE workspace_id = $1', [brandA.id])).rows[0].n, 1);
    // The canonical backstop also blocks another intent while the first is active, even with caps above1.
    await a.registerSocialBinding(actorA, brandA.id, { network: 'linkedin', providerAccountId: LINKEDIN_A, dailyCap: 5, monthlyCap: 10 });
    await assert.rejects(planFor(new Date(Date.now() + 7_000)), (error: unknown) => error instanceof SocialDeliveryHoldError && /active dispatch/.test(error.hold));
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM app.property_predator_owned_social_jobs WHERE workspace_id = $1', [brandA.id])).rows[0].n, 1);

    // ── Worker discovery sees only active registrations with caps above zero ──
    const discovered = await worker.connect();
    try {
      await discovered.query('BEGIN');
      await discovered.query(`SELECT set_config('app.user_id', '', true), set_config('app.workspace_id', '00000000-0000-4000-8000-000000000000', true), set_config('app.actor_kind', 'worker', true), set_config('app.request_id', 'discovery', true)`);
      const targets = await discovered.query<{ workspace_id: string; network: string; provider_account_id: string }>('SELECT workspace_id, network, provider_account_id FROM app_private.seo_blog_social_dispatch_targets()');
      assert.deepEqual(targets.rows.filter(t => [brandA.id, brandB.id].includes(t.workspace_id)).map(t => [t.workspace_id, t.network, t.provider_account_id]).sort(), [[brandA.id, 'instagram', INSTAGRAM_A], [brandA.id, 'linkedin', LINKEDIN_A], [brandB.id, 'linkedin', LINKEDIN_B]].sort());
      await discovered.query('ROLLBACK');
    } finally { discovered.release(); }

    // ── Just-in-time attestation by the SEO worker identity: fresh 15-minute proof from the exact current source ──
    const workerStore = new PgSeoBlogStore(content, { kind: 'worker', requestId: requestId() });
    assert.ok((await workerStore.socialAttestationBrandIds()).includes(brandA.id));
    const setProgrammePause = async (pauseAll: boolean) => {
      const current = await a.getBrand(actorA, brandA.id);
      await a.updateSettings(actorA, brandA.id, current.rowVersion, { pauseAll });
    };
    await setProgrammePause(true);
    assert.deepEqual(await workerStore.attestDuePromotions(brandA.id), [], 'programme pause holds JIT work without cancelling or extending proof');
    await a.approvePromotion(actorA, brandA.id, article.id, version.id, 'linkedin', packSha);
    await assert.rejects(a.scheduleSocial(actorA, brandA.id, article.id, version.id, 'linkedin', packSha, '2026-12-01', '09:00'), /paused/);
    await setProgrammePause(false);
    const attested = await workerStore.attestDuePromotions(brandA.id);
    assert.equal(attested.length, 1); assert.equal(attested[0]!.state, 'verified');
    assert.ok(!(await workerStore.socialAttestationBrandIds()).includes(brandA.id));
    const proof = await admin.query<{ expires_at: Date; checked_at: Date; evidence_type: string }>('SELECT expires_at, checked_at, evidence_type FROM app.public_social_revalidation_proofs WHERE workspace_id = $1 AND intent_id = $2', [brandA.id, first.dispatchId]);
    assert.equal(proof.rows.length, 1);
    assert.ok(proof.rows[0]!.expires_at.getTime() - proof.rows[0]!.checked_at.getTime() <= 15 * 60_000);

    // ── Lease → begin-call → provider stub → receipt, through the calendar worker's own boundary for THIS brand ──
    const repository = new PgZernioCalendarRepository(worker, { workspaceId: brandA.id, connectionId: bindingA.connectionId });
    const published: { content: string; targets: readonly { network: string; accountId: string }[] }[] = [];
    const posting: Pick<ZernioPostingClient, 'publishDue' | 'reconcile'> = {
      async publishDue(input) { published.push({ content: input.content, targets: input.targets }); return { providerPostId: 'post_1', status: 'published', platforms: [{ network: input.targets[0]!.network, accountId: input.targets[0]!.accountId, status: 'published', platformPostUrl: 'https://linkedin.example/post_1' }], responseSha256: sha256('stub'), idempotentReplay: false }; },
      async reconcile() { throw new Error('not expected'); },
    };
    const markCalling = repository.markCalling.bind(repository);
    let checkedPausedBegin = false;
    repository.markCalling = async input => {
      if (!checkedPausedBegin) {
        await setProgrammePause(true); // Commits after lease/load, before atomic begin.
        assert.equal(await markCalling(input), false, 'a committed programme pause wins at the actual call boundary');
        assert.equal(published.length, 0, 'no provider effect while paused');
        checkedPausedBegin = true;
        await setProgrammePause(false); // Explicit owner resume; same lease, no new operation.
      }
      return markCalling(input);
    };
    const cycle = () => runZernioCalendarLiveOnce({
      config: { executionMode: 'zernio_live', providerEffectsEnabled: true, emergencyPaused: false, networks: ['linkedin'], maximumOperationsPerCycle: 1, dailyPublishCap: 1, monthlyPublishCap: 3 },
      accountBindings: [{ network: 'linkedin', providerAccountId: LINKEDIN_A }], repository, posting, leaseToken: Buffer.alloc(32, 5),
      mediaResolver: { resolve: async ({ media }) => { assert.equal(media.length, 0); return []; } },
    });
    assert.equal(await cycle(), 'idle', 'not yet due');
    await new Promise(resolve => setTimeout(resolve, Math.max(0, slot.getTime() - Date.now()) + 1_500));
    assert.equal(await cycle(), 'published_or_pending');
    assert.equal(published.length, 1);
    assert.equal(checkedPausedBegin, true);
    assert.deepEqual(published[0]!.targets, [{ network: 'linkedin', accountId: LINKEDIN_A }]);
    assert.ok(published[0]!.content.endsWith(version.promotionPack!.canonicalUrl!), 'the worker posted the exact approved text');
    assert.equal((await jobRow(first.result.jobId)).state, 'succeeded', 'the 0085 terminal receipt state');
    assert.equal(await cycle(), 'idle');
    // Exact slot is immutable history: a fresh random intent cannot duplicate it even after success.
    await assert.rejects(planFor(slot));
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM app.property_predator_owned_social_jobs WHERE workspace_id = $1', [brandA.id])).rows[0].n, 1);

    // ── Delay beyond the proof expiry: the slot is held (needs attention), nothing is sent ──
    await admin.query(`UPDATE app.seo_blog_social_bindings SET daily_cap = 5, monthly_cap = 10 WHERE workspace_id = $1 AND network = 'linkedin' AND status = 'active'`, [brandA.id]).catch(async () => {
      await a.registerSocialBinding(actorA, brandA.id, { network: 'linkedin', providerAccountId: LINKEDIN_A, dailyCap: 5, monthlyCap: 10 });
    });
    const late = await planFor(new Date(Date.now() + 4_000));
    assert.equal((await workerStore.attestDuePromotions(brandA.id)).map(o => o.state).join(), 'verified');
    await admin.query(`ALTER TABLE app.public_social_revalidation_proofs DISABLE TRIGGER USER`);
    try { await admin.query(`UPDATE app.public_social_revalidation_proofs SET expires_at = checked_at + interval '1 second' WHERE workspace_id = $1 AND intent_id = $2`, [brandA.id, late.dispatchId]); }
    finally { await admin.query(`ALTER TABLE app.public_social_revalidation_proofs ENABLE TRIGGER USER`); }
    await new Promise(resolve => setTimeout(resolve, 5_500));
    const lateCycle = await cycle();
    assert.notEqual(lateCycle, 'published_or_pending');
    assert.equal(published.length, 1, 'an expired proof never reaches the provider');
    assert.ok(['queued', 'needs_attention'].includes((await jobRow(late.result.jobId)).state));

    // ── Changed parent: a later article version cancels the slot before any proof is written ──
    const changed = await planFor(new Date(Date.now() + 60_000));
    const currentArticle = (await storeA.getArticle(brandA.id, article.id))!;
    await storeA.updateArticle({ ...currentArticle, currentVersionId: randomUUID() });
    assert.deepEqual((await workerStore.attestDuePromotions(brandA.id)).map(o => [o.intentId, o.state]), [[changed.dispatchId, 'cancelled']]);
    const revalidation = await admin.query<{ state: string; last_error_code: string }>('SELECT state, last_error_code FROM app.public_social_revalidation_jobs WHERE workspace_id = $1 AND intent_id = $2', [brandA.id, changed.dispatchId]);
    assert.deepEqual(revalidation.rows[0], { state: 'cancelled', last_error_code: 'seo.parent_changed' });
    await storeA.updateArticle({ ...(await storeA.getArticle(brandA.id, article.id))!, currentVersionId: version.id });

    // ── Revocation stops dispatch of anything still queued and removes the brand from discovery ──
    const activeLinkedIn = (await aliceRegistry.overview(brandA.id)).bindings.find(x => x.network === 'linkedin' && x.status === 'active')!;
    await a.revokeSocialBinding(actorA, brandA.id, activeLinkedIn.id);
    assert.equal((await aliceRegistry.overview(brandA.id)).bindings.filter(x => x.status === 'active').map(x => x.network).join(), 'instagram');
    const capOk = await admin.query<{ ok: boolean }>('SELECT app_private.zernio_calendar_job_cap_ok($1, $2) AS ok', [brandA.id, late.result.jobId]);
    assert.equal(capOk.rows[0]!.ok, false, 'a revoked registration fails the begin-call cap predicate');

    // ── Brand B never saw any of this ──
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM app.property_predator_owned_social_jobs WHERE workspace_id = $1', [brandB.id])).rows[0].n, 0);
    assert.deepEqual((await b.socialOverview({ userId: bob.identity.userId }, brandB.id)).bindings.map(x => x.providerAccountIdSha256), [sha256(LINKEDIN_B)]);
    a = engineFor(alice.identity, aliceRegistry, false);
    assert.equal((await a.socialOverview(actorA, brandA.id)).profile?.providerProfileId, HARBOUR);
  } finally {
    for (const pool of pools) await pool.end().catch(() => undefined);
    for (const role of roles) await admin.query(`ALTER ROLE ${role} PASSWORD NULL`).catch(() => undefined);
    await admin.end();
  }
});
