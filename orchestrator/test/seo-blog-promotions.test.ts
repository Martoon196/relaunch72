import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { calendarPage, editorPage, socialPage } from '../src/portal/seo-blog-view.js';
import { canonicalPromotionApproval, linkedPromotionFor, OBSERVATION_TTL_MS, promotionCommand, promotionCommandKey, promotionPublicationHold, SEO_BLOG_PROMOTION_MIME_TYPE, type ArticlePromotionApproval } from '../src/seo-blog/promotions.js';
import { SocialDeliveryHoldError, type SocialBinding, type SocialRegistry } from '../src/seo-blog/social.js';
import { sha256 } from '../src/seo-blog/engine.js';
import type { Article, PromotionObservation } from '../src/seo-blog/types.js';
import { harness, OWNER, seedBrandSite } from './seo-blog-fixtures.js';

async function written() {
  const h = harness(); seedBrandSite(h.web, 'https://harbour.example', 'deposits');
  let { brand } = await h.engine.createBrand(OWNER, { commandId: randomUUID(), name: 'Harbour', website: 'https://harbour.example' });
  await h.engine.updateSettings(OWNER, brand.id, brand.rowVersion, { budgets: { modelTokensPerMonth: 2_000_000, searchCallsPerMonth: 200, imagesPerMonth: 0 } });
  await h.engine.uploadKnowledge(OWNER, brand.id, { category: 'product_facts', title: 'Plans', filename: 'plans.txt', bytes: Buffer.from('Harbour compliance plan costs £49 per month.') });
  const profile = await h.engine.extractBrandProfile(OWNER, brand.id); await h.engine.confirmProfile(OWNER, brand.id, profile.version);
  const destination = await h.engine.connectDestination(OWNER, brand.id, { type: 'github_static', label: 'Harbour website', credential: 'gh-token-fixture', config: { repository: 'acme/site', branch: 'main', publicBaseUrl: 'https://harbour.example', blogPath: 'blog', sitemapPath: 'sitemap.xml' } });
  assert.equal(destination.status, 'connected');
  await h.engine.requestPlan(OWNER, brand.id, { commandId: randomUUID() }); await h.engine.tick('fixture-worker');
  const [plan] = await h.engine.listPlans(OWNER, brand.id); await h.engine.acceptPlan(OWNER, brand.id, plan!.plan.id);
  const brief = plan!.briefs.find(b => b.role === 'pillar')!; await h.engine.requestArticles(OWNER, brand.id, [brief.id]); await h.engine.tick('fixture-worker');
  const [row] = await h.engine.listArticles(OWNER, brand.id); const detail = await h.engine.getArticle(OWNER, brand.id, row!.article.id);
  brand = await h.engine.getBrand(OWNER, brand.id);
  return { h, brand, brief: (await h.engine.listPlans(OWNER, brand.id))[0]!.briefs.find(b => b.id === brief.id)!, ...detail };
}

function observationFor(version: { id: string; promotionPack?: unknown }, network: 'instagram' | 'linkedin', at: string, purpose: 'approve' | 'schedule' = 'approve'): PromotionObservation {
  return { id: randomUUID(), purpose, articleVersionId: version.id, network, packSha: sha256(version.promotionPack), observedAt: at, expiresAt: new Date(Date.parse(at) + OBSERVATION_TTL_MS).toISOString(), observedBy: OWNER.userId, contentItemId: null, contentVersionId: null };
}

/** Records every canonical command it is asked to run; optionally fails after the draft exists. */
function fakeApproval(behaviour: { failAfterDraft?: number } = {}) {
  const calls: { observationId: string; commandKey: string; draftIds: [string, string] | null }[] = [];
  let failures = behaviour.failAfterDraft ?? 0;
  const adapter: ArticlePromotionApproval = { async approve({ brand, version, network, observation, recordDraft }) {
    const command = promotionCommand(brand, version, network, observation);
    let draftIds: [string, string] | null = observation.contentItemId && observation.contentVersionId ? [observation.contentItemId, observation.contentVersionId] : null;
    if (!draftIds) { draftIds = [randomUUID(), randomUUID()]; await recordDraft(draftIds[0], draftIds[1]); }
    calls.push({ observationId: observation.id, commandKey: command.commandKey, draftIds });
    if (failures > 0) { failures -= 1; throw new Error('approval transaction lost'); }
    return { articleVersionId: version.id, network, packSha: sha256(version.promotionPack), contentItemId: draftIds[0], contentVersionId: draftIds[1], approvalRequestId: randomUUID(), approvalDecisionId: randomUUID() };
  } };
  return { adapter, calls };
}

test('generated articles automatically carry model promotion drafts and appear at proposed dates without publication schedules', async () => {
  const f = await written(); const { version, article, brand, h } = f;
  assert.ok(version?.promotionPack); assert.equal(version.promotionPack.mode, 'model'); assert.equal(version.promotionPack.posts.length, 2);
  assert.equal(version.promotionPack.brandId, brand.id); assert.equal(version.promotionPack.versionId, version.id); assert.equal(version.promotionPack.contentSha, version.contentSha);
  assert.ok(h.llm.calls.includes('SEO_BLOG_SOCIAL')); assert.equal(article.schedule, null);
  const html = calendarPage({ brands: [brand], brand, tab: 'calendar', csrf: 'fixture', notice: null, error: null }, { view: 'list', anchor: f.brief.suggestedAtUtc!.slice(0,10), articles: [{ article, title: version.body.title, status: 'Needs approval' }], briefs: [f.brief], destinations: [], brandsAll: false });
  assert.match(html, /Proposed/); assert.match(html, /no publication scheduled/i); assert.match(html, /Needs approval/);
  await h.engine.moveProposedDate(OWNER, brand.id, article.id, article.rowVersion, '2026-11-09', '09:30');
  assert.equal((await h.engine.getArticle(OWNER, brand.id, article.id)).article.schedule, null);
});

test('canonical promotion command is exact plain text bound to one owner observation; non-user and URL-less paths stay held', async () => {
  const f = await written(); const v = f.version!;
  const at = '2026-11-02T10:05:00.000Z';
  const observation = observationFor(v, 'linkedin', at);
  const command = promotionCommand(f.brand, v, 'linkedin', observation);
  assert.deepEqual(command, promotionCommand(f.brand, v, 'linkedin', observation), 'same observation → byte-identical command');
  assert.equal(command.contentMimeType, SEO_BLOG_PROMOTION_MIME_TYPE);
  assert.equal(command.source.system, 'relaunch72.seo-blog'); assert.match(command.source.version, new RegExp(v.id));
  assert.equal(command.blob.sha256, sha256(command.content));
  assert.ok(command.content.endsWith(`\n\n${v.promotionPack!.canonicalUrl!}`), 'copy then the reviewed URL, nothing else');
  assert.doesNotMatch(command.content, /artwork|"schema"/i, 'no JSON envelope: the worker posts content_body verbatim');
  assert.deepEqual(command.attestation, { catalogSha256: sha256(v.promotionPack), checkedAt: at, expiresAt: observation.expiresAt });
  assert.equal(command.commandKey, promotionCommandKey(v, 'linkedin', observation));
  assert.ok(command.commandKey.endsWith(String(Date.parse(at))), 'a new observation is a new durable command, never a mutated old one');
  assert.notEqual(promotionCommand(f.brand, v, 'linkedin', observationFor(v, 'linkedin', '2026-11-02T10:06:00.000Z')).commandKey, command.commandKey);
  assert.equal((command.metadata as Record<string, unknown>).observationId, observation.id);
  assert.throws(() => promotionCommand(f.brand, { ...v, promotionPack: { ...v.promotionPack!, canonicalUrl: null } }, 'linkedin', observation), /final URL/);
  assert.throws(() => promotionCommand(f.brand, v, 'linkedin', { ...observation, packSha: 'f'.repeat(64) }), /drafts changed/);
  const unused = {} as never;
  const adapter = canonicalPromotionApproval({ context: () => ({ workspaceId: f.brand.id, actorKind: 'worker', requestId: 'fixture' }), drafts: unused, approvals: unused });
  await assert.rejects(adapter.approve({ brand: f.brand, article: f.article, version: v, network: 'linkedin', observation, recordDraft: async () => undefined }), /owner session/);
  assert.match(promotionPublicationHold(f.article, v, 'linkedin')!, /verified public/);
});

test('owner approval replays the same observation on retry, resumes a lost approval without a duplicate draft, and re-observes after expiry', async () => {
  const f = await written(); const v = f.version!; const { h, brand, article } = f;
  const packSha = sha256(v.promotionPack);
  const first = fakeApproval({ failAfterDraft: 1 });
  const engine = new (await import('../src/seo-blog/engine.js')).SeoBlogEngine({ store: h.store, llm: h.llm, search: h.search, transport: h.web, publishers: new Map(), vault: h.vault, now: h.clock.now, promotions: first.adapter });
  await assert.rejects(engine.approvePromotion(OWNER, brand.id, article.id, v.id, 'linkedin', packSha), /approval transaction lost/);
  let stored = (await h.store.getArticle(brand.id, article.id))!;
  assert.equal(stored.promotionObservations?.length, 1, 'the observation was recorded before the canonical command ran');
  assert.ok(stored.promotionObservations![0]!.contentVersionId, 'the draft identity survived the failed approval');
  assert.equal(stored.linkedPromotions, undefined);
  h.clock.advance?.(30_000);
  await engine.approvePromotion(OWNER, brand.id, article.id, v.id, 'linkedin', packSha);
  assert.equal(first.calls.length, 2);
  assert.equal(first.calls[1]!.observationId, first.calls[0]!.observationId, 'retry reused the stored observation → identical command key');
  assert.equal(first.calls[1]!.commandKey, first.calls[0]!.commandKey);
  assert.deepEqual(first.calls[1]!.draftIds, first.calls[0]!.draftIds, 'no second draft version was created');
  stored = (await h.store.getArticle(brand.id, article.id))!;
  const link = linkedPromotionFor(stored, v, 'linkedin')!;
  assert.ok(link.approvalRequestId && link.approvalDecisionId);
  // After the 15-minute attestation window a fresh owner observation is required: new command, never an extended old one.
  h.clock.advance?.(OBSERVATION_TTL_MS + 1_000);
  await engine.approvePromotion(OWNER, brand.id, article.id, v.id, 'instagram', packSha);
  const latest = first.calls.at(-1)!;
  assert.notEqual(latest.observationId, first.calls[0]!.observationId);
  assert.notEqual(latest.commandKey, first.calls[0]!.commandKey);
  assert.match(promotionPublicationHold((await h.store.getArticle(brand.id, article.id))!, v, 'instagram')!, /verified public/);
});

test('article edits stale only the linked old version, keeping other article promotions independent', async () => {
  const f = await written(); const v = f.version!;
  const linked = { articleVersionId: v.id, network: 'linkedin' as const, packSha: sha256(v.promotionPack), contentItemId: randomUUID(), contentVersionId: randomUUID(), approvalRequestId: randomUUID(), approvalDecisionId: randomUUID() };
  const published = { ...f.article, delivery: 'published' as const, publishedVersionId: v.id, publishedUrl: v.promotionPack!.canonicalUrl, linkedPromotions: [linked] };
  assert.equal(promotionPublicationHold(published, v, 'linkedin'), null);
  assert.match(promotionPublicationHold(published, v, 'instagram')!, /approval/);
  assert.match(promotionPublicationHold({ ...published, linkedPromotions: [{ ...linked, approvalRequestId: undefined }] }, v, 'linkedin')!, /again/);
  const next = await f.h.engine.editArticle(OWNER, f.brand.id, f.article.id, v.id, { title: `${v.body.title} updated` });
  const current = (await f.h.engine.getArticle(OWNER, f.brand.id, f.article.id)).article;
  assert.notEqual(next.id, v.id); assert.equal(current.approval, null);
  assert.match(promotionPublicationHold({ ...current, linkedPromotions: [linked] }, v, 'linkedin')!, /article changed/);
  assert.equal(promotionPublicationHold(published, v, 'linkedin'), null, 'unrelated historical tuple was not mutated');
});

function fakeRegistry(bindings: SocialBinding[], behaviour: { hold?: string } = {}) {
  const plans: Parameters<SocialRegistry['plan']>[0][] = [];
  const registry: SocialRegistry = {
    overview: async () => ({ profile: { providerConnectionId: randomUUID(), providerProfileId: 'brand-profile', registeredAt: '2026-11-01T00:00:00.000Z' }, accounts: [], bindings }),
    registerProfile: async () => ({ providerConnectionId: randomUUID(), disposition: 'applied' }),
    beginConnect: async () => ({ authUrl: 'https://provider.example/consent' }),
    completeConnect: async () => ({ disposition: 'recorded' }),
    registerBinding: async () => ({ bindingId: randomUUID(), disposition: 'applied' }),
    revokeBinding: async () => undefined,
    async plan(input) { plans.push(input); if (behaviour.hold) throw new SocialDeliveryHoldError(behaviour.hold); return { intentId: input.dispatchId, jobId: randomUUID(), dailyCap: input.binding.dailyCap, monthlyCap: input.binding.monthlyCap }; },
  };
  return { registry, plans };
}

test('scheduling goes through the registered account with truthful holds: unpublished, unregistered, caps off, Instagram without media, duplicates', async () => {
  const f = await written(); const v = f.version!; const { h, brand } = f;
  const packSha = sha256(v.promotionPack);
  const { SeoBlogEngine } = await import('../src/seo-blog/engine.js');
  const binding = (network: 'instagram' | 'linkedin', dailyCap = 1, monthlyCap = 3): SocialBinding => ({ id: randomUUID(), network, providerConnectionId: randomUUID(), providerAccountIdSha256: sha256('a'.repeat(24)), username: 'brand', dailyCap, monthlyCap, status: 'active', registeredAt: '2026-11-01T00:00:00.000Z', revokedAt: null });
  const approval = fakeApproval();
  const make = (registry: SocialRegistry) => new SeoBlogEngine({ store: h.store, llm: h.llm, search: h.search, transport: h.web, publishers: new Map(), vault: h.vault, now: h.clock.now, promotions: approval.adapter, social: registry });
  const linkedin = fakeRegistry([binding('linkedin'), binding('instagram')]);
  let engine = make(linkedin.registry);
  await engine.approvePromotion(OWNER, brand.id, f.article.id, v.id, 'linkedin', packSha);
  await engine.approvePromotion(OWNER, brand.id, f.article.id, v.id, 'instagram', packSha);
  // Not yet verified public at the reviewed URL.
  await assert.rejects(engine.scheduleSocial(OWNER, brand.id, f.article.id, v.id, 'linkedin', packSha, '2026-11-03', '09:00'), /verified public/);
  const published = (await h.store.getArticle(brand.id, f.article.id))!;
  await h.store.updateArticle({ ...published, delivery: 'published', publishedVersionId: v.id, publishedUrl: v.promotionPack!.canonicalUrl });
  // Instagram needs real media — a per-platform hold that never blocks LinkedIn text.
  await assert.rejects(engine.scheduleSocial(OWNER, brand.id, f.article.id, v.id, 'instagram', packSha, '2026-11-03', '09:00'), /real approved image/);
  await assert.rejects(engine.scheduleSocial(OWNER, brand.id, f.article.id, v.id, 'linkedin', packSha, '2026-11-02', '10:05'), /ten minutes/);
  const queued = await engine.scheduleSocial(OWNER, brand.id, f.article.id, v.id, 'linkedin', packSha, '2026-11-03', '09:00');
  assert.equal(queued.state, 'queued'); assert.equal(queued.scheduledFor, '2026-11-03T09:00:00.000Z'); assert.ok(queued.jobId);
  assert.equal(linkedin.plans.length, 1);
  const plan = linkedin.plans[0]!;
  assert.equal(plan.observation.purpose, 'schedule'); assert.equal(plan.observation.contentVersionId, plan.link.contentVersionId, 'schedule observation is bound to the approved draft identity');
  assert.equal(plan.dispatchId, queued.intentId); assert.equal(plan.binding.network, 'linkedin');
  const stored = (await h.store.getArticle(brand.id, f.article.id))!;
  assert.equal(stored.socialDispatches?.length, 1); assert.equal(stored.socialDispatches![0]!.state, 'queued');
  await assert.rejects(engine.scheduleSocial(OWNER, brand.id, f.article.id, v.id, 'linkedin', packSha, '2026-11-04', '09:00'), /already queued/);
  // No registered account / caps off → held before any planning.
  engine = make(fakeRegistry([]).registry);
  await assert.rejects(engine.scheduleSocial(OWNER, brand.id, f.article.id, v.id, 'linkedin', packSha, '2026-11-05', '09:00'), /No linkedin account is registered/);
  engine = make(fakeRegistry([binding('linkedin', 0, 3)]).registry);
  await assert.rejects(engine.scheduleSocial(OWNER, brand.id, f.article.id, v.id, 'linkedin', packSha, '2026-11-05', '09:00'), /switched off/);
  // A hold raised by the canonical machinery (caps, stale approval) is recorded on the article, not dropped.
  const dup = fakeRegistry([binding('linkedin')], { hold: 'The daily cap for this account is already used.' });
  engine = make(dup.registry);
  const fresh = (await h.store.getArticle(brand.id, f.article.id))!;
  await h.store.updateArticle({ ...fresh, socialDispatches: [] });
  await assert.rejects(engine.scheduleSocial(OWNER, brand.id, f.article.id, v.id, 'linkedin', packSha, '2026-11-05', '09:00'), /daily cap/);
  const held = (await h.store.getArticle(brand.id, f.article.id))!.socialDispatches!.at(-1)!;
  assert.equal(held.state, 'held'); assert.match(held.detail!, /daily cap/);
  const shell = { brands: [brand], brand, tab: 'articles' as const, csrf: 'fixture', notice: null, error: null };
  const detail = await engine.getArticle(OWNER, brand.id, f.article.id);
  const html = editorPage(shell, { ...detail, article: { ...detail.article, requiresApproval: true }, destinations: [], social: await dup.registry.overview(brand.id) });
  assert.match(html, /aria-label="Needs my approval: On\. Turn off" class="toggle-control on"/);
  const approvalOff = editorPage(shell, { ...detail, article: { ...detail.article, requiresApproval: false }, destinations: [], social: await dup.registry.overview(brand.id) });
  assert.match(approvalOff, /aria-label="Needs my approval: Off\. Turn on" class="toggle-control off"/);
  assert.match(html, /held: The daily cap/); assert.match(html, /Queue linkedin post/); assert.match(html, /Instagram requires a real approved image/);
  const social = socialPage({ ...shell, tab: 'social' }, { overview: await dup.registry.overview(brand.id), connectHere: false, connectHost: 'https://hq.propertypredator.com', intentId: randomUUID() });
  assert.match(social, /brand-profile/); assert.match(social, /Open this page there to connect accounts/); assert.match(social, /Revoke/);
});

test('engine refuses social actions when no registry is composed and exposes an empty overview', async () => {
  const f = await written();
  const overview = await f.h.engine.socialOverview(OWNER, f.brand.id);
  assert.deepEqual(overview, { profile: null, accounts: [], bindings: [] });
  await assert.rejects(f.h.engine.registerSocialProfile(OWNER, f.brand.id, 'x', 'profile_1'), /not available/);
  const article: Article = f.article;
  assert.equal(article.socialDispatches, undefined);
});

async function reservedSchedulingFixture() {
  const f = await written(); const v = f.version!; const { h, brand } = f;
  const packSha = sha256(v.promotionPack);
  const { SeoBlogEngine } = await import('../src/seo-blog/engine.js');
  const binding: SocialBinding = { id: randomUUID(), network: 'linkedin', providerConnectionId: randomUUID(), providerAccountIdSha256: sha256('b'.repeat(24)),
    username: 'brand', dailyCap: 5, monthlyCap: 20, status: 'active', registeredAt: h.clock.now(), revokedAt: null };
  const fake = fakeRegistry([binding]);
  const committed = new Map<string, { intentId: string; jobId: string; dailyCap: number; monthlyCap: number }>();
  fake.registry.plan = async input => {
    fake.plans.push(input);
    const existing = committed.get(input.dispatchId);
    if (existing) return existing;
    const result = { intentId: input.dispatchId, jobId: randomUUID(), dailyCap: 5, monthlyCap: 20 };
    committed.set(input.dispatchId, result); return result;
  };
  const engine = new SeoBlogEngine({ store: h.store, llm: h.llm, search: h.search, transport: h.web, publishers: new Map(), vault: h.vault, now: h.clock.now, promotions: fakeApproval().adapter, social: fake.registry });
  await engine.approvePromotion(OWNER, brand.id, f.article.id, v.id, 'linkedin', packSha);
  const article = (await h.store.getArticle(brand.id, f.article.id))!;
  await h.store.updateArticle({ ...article, delivery: 'published', publishedVersionId: v.id, publishedUrl: v.promotionPack!.canonicalUrl });
  return { ...f, engine, fake, committed, packSha, schedule: (date = '2026-11-03') => engine.scheduleSocial(OWNER, brand.id, f.article.id, v.id, 'linkedin', packSha, date, '09:00') };
}

test('social reservation survives enqueue commit plus lost article result, then replays beyond proof expiry without a new intent', async () => {
  const f = await reservedSchedulingFixture();
  const save = f.h.store.updateArticle.bind(f.h.store);
  let fail = true;
  f.h.store.updateArticle = async article => {
    if (fail && article.socialDispatches?.some(d => d.state === 'queued')) { fail = false; throw new Error('lost article result write'); }
    return save(article);
  };
  await assert.rejects(f.schedule(), /lost article result/);
  const reserved = (await f.h.store.getArticle(f.brand.id, f.article.id))!.socialDispatches!;
  assert.equal(reserved.length, 1); assert.equal(reserved[0]!.state, 'preparing'); assert.equal(f.committed.size, 1);
  await assert.rejects(f.schedule('2026-11-04'), /retry cannot move/);
  const overview = f.fake.registry.overview;
  f.fake.registry.overview = async brandId => {
    const current = await overview(brandId);
    return { ...current, bindings: current.bindings.map(binding => ({ ...binding, dailyCap: 0 })) };
  };
  await assert.rejects(f.schedule(), /switched off/);
  assert.equal((await f.h.store.getArticle(f.brand.id, f.article.id))!.socialDispatches![0]!.id, reserved[0]!.id, 'a temporary control hold cannot discard the committed reservation');
  f.fake.registry.overview = overview;
  f.h.clock.advance(16 * 60_000);
  const resumed = await f.schedule();
  assert.equal(resumed.id, reserved[0]!.id); assert.equal(resumed.jobId, [...f.committed.values()][0]!.jobId);
  assert.equal(f.committed.size, 1); assert.equal(new Set(f.fake.plans.map(p => p.dispatchId)).size, 1);
  assert.equal(f.fake.plans[0]!.observation.id, f.fake.plans[1]!.observation.id, 'expired observation is retained, never extended');
  assert.equal((await f.h.store.getArticle(f.brand.id, f.article.id))!.socialDispatches!.length, 1);
  assert.equal((await f.schedule()).jobId, resumed.jobId, 'receipt replay itself is idempotent');
});

test('concurrent exact promotion requests share one CAS reservation and canonical job with caps above one', async () => {
  const f = await reservedSchedulingFixture();
  const results = await Promise.all([f.schedule(), f.schedule(), f.schedule()]);
  assert.equal(new Set(results.map(r => r.id)).size, 1); assert.equal(new Set(results.map(r => r.jobId)).size, 1);
  assert.equal(f.committed.size, 1); assert.equal(results[0]!.dailyCap, 5);
  const article = (await f.h.store.getArticle(f.brand.id, f.article.id))!;
  assert.equal(article.socialDispatches?.length, 1);
  assert.equal(article.promotionObservations?.filter(o => o.purpose === 'schedule').length, 1);
});
