/**
 * Affiliate Studio: the fixes the independent review of the screens asked for before the switch may ever be turned on
 * (review-affiliate-screens.md, M1 to M7, S1 to S12 and the notes). Each test is the review's own reproduction, made a
 * repo test: it failed on the foundation (7b5ccf2) and passes now. In-memory doubles only: no database, no Amazon, no
 * paid call, no publishing anywhere real.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { SeoBlogEngine, type EngineDeps } from '../src/seo-blog/engine.js';
import { handleSeoBlog } from '../src/portal/seo-blog-router.js';
import { portalCsrfToken } from '../src/portal/session.js';
import type { PortalSeoBlogService } from '../src/portal/seo-blog-service.js';
import type { PortalSessionIdentity } from '../src/portal/auth-service.js';
import { affiliateReader, type AffiliateStores } from '../src/portal/affiliate-service.js';
import { PgAffiliateProductStore, NOT_OPENED_YET, refused, type AffiliateProduct, type AffiliateResult, type ProgrammeSettings } from '../src/affiliate/product-store.js';
import { readAmazonTrackingReport, reportTrackingIdProblem } from '../src/affiliate/amazon-tracking-report.js';
import { affiliateIssues, isAmazonFamilyHost, PRODUCT_MESSAGES, productArticleProblems, shopLinkProblem, textRuleBreaks, usableProductSource, withoutAffiliateParams, type BriefProducts } from '../src/affiliate/article.js';
import { programmeFor } from '../src/affiliate/programmes.js';
import { AD_PREFIX, publicBody } from '../src/affiliate/render.js';
import { affiliatePageProblems, AFFILIATE_PAGE_ALERT, AFFILIATE_PAGE_BLOCK, AFFILIATE_PAGE_UNVERIFIED } from '../src/affiliate/page-check.js';
import { reportsCard } from '../src/portal/affiliate-views.js';
import { ContentApiPublisher, renderArticleFragment } from '../src/seo-blog/publishers/content-api.js';
import { WordPressPublisher } from '../src/seo-blog/publishers/wordpress.js';
import { renderArticlePage } from '../src/seo-blog/render.js';
import { evaluatePublication } from '../src/seo-blog/policy.js';
import { seoScore } from '../src/seo-blog/seo-score.js';
import { ownerActivityWords, ownerWords, noticeWords } from '../src/seo-blog/owner-words.js';
import type { FetchTransport } from '../src/seo-blog/safe-fetch.js';
import { websiteSha } from '../src/seo-blog/website-target.js';
import { ResearchUnavailableError } from '../src/seo-blog/research.js';
import type { Article, ArticleVersion, Brand, Destination } from '../src/seo-blog/types.js';
import { harness, OWNER, seedBrandSite, type Harness } from './seo-blog-fixtures.js';

// The switches are not assumed absent: this file composes the affiliate stores itself.
delete process.env.CONTENT_AREA_PREVIEW;
delete process.env.AFFILIATE_STUDIO;

const SECRET = 's'.repeat(48);
const SITE = 'https://harbour.example';
const ASIN = ['B0TORCH001', 'B0RADIO002', 'B0WATER003', 'B0STOVE004'];
const filler = 'It is small, simple to keep in a cupboard and easy for anyone in the family to use when the lights go out at home.';

// ─── Doubles ─────────────────────────────────────────────────────────────────

/** In-memory stores with the real store's link and text rules; a replayed product id answers the first result. */
class FakeAffiliate implements AffiliateStores {
  products_: AffiliateProduct[] = [];
  settings_: ProgrammeSettings | null = null;
  reports_: { id: string; month: string; text: string; createdAt: string }[] = [];
  constructor(readonly workspaceId: string) {}
  private ok<T>(v: T): AffiliateResult<T> { return { ok: true, value: v }; }
  readonly products = {
    list: async () => this.ok(this.products_.map((p) => ({ ...p }))),
    get: async (_w: string, id: string) => this.ok(this.products_.find((p) => p.productId === id) ?? null),
    settings: async () => this.ok(this.settings_),
    saveSettings: async (a: { trackingId: string; registeredSite: string; expectedRevision: number; siteListedConfirmed: boolean; accountConfirmed: boolean }) => {
      if (!a.siteListedConfirmed || !a.accountConfirmed || !programmeFor('amazon_uk')!.validateTrackingId(a.trackingId).ok) return refused('invalid');
      if ((this.settings_?.revision ?? 0) !== a.expectedRevision) return refused('stale');
      const site = /^https:\/\//.test(a.registeredSite) ? a.registeredSite : `https://${a.registeredSite}`;
      this.settings_ = { programme: 'amazon_uk', revision: a.expectedRevision + 1, trackingId: a.trackingId, registeredSite: site, siteListedConfirmed: true, accountConfirmed: true, createdAt: '2026-11-16T10:00:00.000Z' };
      return { ok: true as const, value: { replayed: false, revision: this.settings_.revision } };
    },
    add: async (a: { details: Parameters<typeof PgAffiliateProductStore.prepare>[0]; productId?: string; commandId?: string }) => {
      if (!this.settings_) return refused('settings_required');
      const prepared = PgAffiliateProductStore.prepare(a.details, this.settings_.trackingId);
      if (!prepared.ok) return refused('link', prepared.reason);
      const existing = a.productId ? this.products_.find((p) => p.productId === a.productId) : undefined;
      if (existing) return { ok: true as const, value: { replayed: true, productId: existing.productId, revision: existing.revision, status: existing.status } };
      const p = prepared.product as Record<string, unknown>;
      const product: AffiliateProduct = { productId: a.productId ?? randomUUID(), revision: 1, programme: 'amazon_uk', merchantName: 'Amazon UK', productName: String(p.productName), merchantProductId: String(p.merchantProductId),
        productUrl: String(p.productUrl), affiliateUrl: String(p.affiliateUrl), infoUrl: (p.infoUrl as string | null) ?? null, notes: (p.notes as string | null) ?? null, ownerUsed: p.ownerUsed === true, status: 'active', createdAt: '2026-11-16T10:00:00.000Z' };
      this.products_.push(product);
      return { ok: true as const, value: { replayed: false, productId: product.productId, revision: 1, status: 'active' as const } };
    },
    edit: async () => refused('invalid'),
    retire: async (a: { productId: string; expectedRevision: number }) => {
      const p = this.products_.find((x) => x.productId === a.productId);
      if (!p || p.revision !== a.expectedRevision) return refused('stale');
      Object.assign(p, { status: 'retired', revision: p.revision + 1 });
      return { ok: true as const, value: { replayed: false, productId: p.productId, revision: p.revision, status: 'retired' as const } };
    },
  } as unknown as AffiliateStores['products'];
  readonly reports = {
    list: async () => this.ok(this.reports_.map((r) => { const rep = readAmazonTrackingReport(r.text); if (!rep.ok) throw new Error('bad'); const { rows: _rows, ...summary } = rep.report;
      return { id: r.id, programme: 'amazon_uk' as const, source: 'user_uploaded_amazon_tracking_id_summary', reportStart: `${r.month}-01`, reportEnd: `${r.month}-28`, currency: 'GBP' as const, summary, rowCount: rep.report.rows.length, createdAt: r.createdAt }; })),
    get: async (_w: string, id: string) => { const r = this.reports_.find((x) => x.id === id); const rep = r ? readAmazonTrackingReport(r.text) : null;
      return this.ok(r && rep?.ok ? { id: r.id, programme: 'amazon_uk' as const, reportStart: `${r.month}-01`, reportEnd: `${r.month}-28`, currency: 'GBP' as const, payload: rep.report, createdAt: r.createdAt } : null); },
    save: async (a: { month: string; originalText: string; commandId?: string }) => {
      const rep = readAmazonTrackingReport(a.originalText);
      if (!rep.ok) return refused('report_unreadable', rep.reason);
      const same = this.reports_.find((x) => x.month === a.month && x.text === a.originalText);
      if (same) return { ok: true as const, value: { replayed: true, id: same.id } };
      const id = a.commandId ?? randomUUID(); this.reports_.push({ id, month: a.month, text: a.originalText, createdAt: '2026-11-03T09:00:00.000Z' });
      return { ok: true as const, value: { replayed: false, id } };
    },
  } as unknown as AffiliateStores['reports'];
}

async function readyBrand(h: Harness, name = 'Harbour Lettings', site = SITE): Promise<Brand> {
  seedBrandSite(h.web, site, 'deposits');
  const { brand } = await h.engine.createBrand(OWNER, { commandId: randomUUID(), name, website: site });
  await h.engine.uploadKnowledge(OWNER, brand.id, { category: 'product_facts', title: 'Plans', filename: 'plans.txt', bytes: Buffer.from('Harbour Lettings Compliance Plan costs £49 per month.') });
  const b = await h.engine.getBrand(OWNER, brand.id);
  await h.engine.updateSettings(OWNER, brand.id, b.rowVersion, { budgets: { modelTokensPerMonth: 2_000_000, searchCallsPerMonth: 200, imagesPerMonth: 0 } });
  const profile = await h.engine.extractBrandProfile(OWNER, brand.id);
  await h.engine.confirmProfile(OWNER, brand.id, profile.version);
  return h.engine.getBrand(OWNER, brand.id);
}

/**
 * A writer that answers a product article with one part per product name. `extra` changes the answer; with no research
 * sources at all it answers directly (the scripted model needs one source: review N11).
 */
function productWriter(h: Harness, extra: (names: string[]) => Record<string, unknown> = () => ({})) {
  const prompts: { system: string; user: string; stage: string }[] = [];
  const inner = h.llm.complete.bind(h.llm);
  h.llm.complete = async (req) => {
    prompts.push({ system: req.system ?? '', user: req.messages[0]!.content, stage: req.meta?.stage ?? '' });
    const products = /<products>\n([\s\S]*?)\n<\/products>/.exec(req.messages[0]!.content);
    if (!products || req.meta?.stage !== 'SEO_BLOG_ARTICLE') return inner(req);
    const names = (JSON.parse(products[1]!) as { products: { name: string }[] }).products.map((p) => p.name);
    if (/<research_sources>\n\[\]\n<\/research_sources>/.test(req.messages[0]!.content)) {
      h.llm.calls.push('SEO_BLOG_ARTICLE');
      const out = { title: 'What to keep for a power cut', seo_title: 'What to keep for a power cut', meta_description: 'A plain guide to the few things worth keeping at home for a power cut, and why each one earns its place.', excerpt: 'What to keep at home for a power cut.',
        intro: `${filler} ${filler}`, sections: names.map((n) => ({ heading: n, body: `${filler} ${filler}` })), conclusion: filler, faqs: [{ q: 'Do I need all of these?', a: 'Not all of them; start with light and then add the rest as you can.' }], image_alt: 'A torch on a kitchen table', public_source_ids: [], ...extra(names) };
      return { text: JSON.stringify(out), tokensIn: 1000, tokensOut: 800, stopReason: 'end_turn', model: 'scripted' };
    }
    h.llm.articleOverride = (base) => ({ ...base, title: 'What to keep for a power cut', sections: names.map((n) => ({ heading: n, body: `${filler} ${filler}` })), ...extra(names) });
    try { return await inner(req); } finally { h.llm.articleOverride = null; }
  };
  return prompts;
}

type Setup = Awaited<ReturnType<typeof setup>>;
async function setup(o: { tracking?: string; extra?: (names: string[]) => Record<string, unknown>; engine?: Partial<EngineDeps>; transport?: FetchTransport } = {}) {
  const h = harness();
  const brand = await readyBrand(h);
  const aff = new FakeAffiliate(brand.id);
  await aff.products.saveSettings({ workspaceId: brand.id, programme: 'amazon_uk', expectedRevision: 0, trackingId: o.tracking ?? 'harbour-21', registeredSite: SITE, siteListedConfirmed: true, accountConfirmed: true });
  for (const [i, name] of ['Wind-up torch', 'Battery radio', 'Water carrier'].entries()) {
    await aff.products.add({ workspaceId: brand.id, details: { programme: 'amazon_uk', link: `https://www.amazon.co.uk/Thing/dp/${ASIN[i]}?ref=x&tag=${o.tracking ?? 'harbour-21'}`, productName: name, notes: i === 0 ? 'We keep two by the door.' : null, ownerUsed: i === 0 } });
  }
  const publishers = (h.engine as unknown as { deps: EngineDeps }).deps.publishers;
  const deps: EngineDeps = { store: h.store, llm: h.llm, search: h.search, transport: o.transport ?? h.web, publishers, vault: h.vault, now: h.clock.now, batchLimit: 20, ...(o.engine ?? {}) };
  const engine = new SeoBlogEngine({ ...deps, affiliate: affiliateReader(aff) });
  // The worker has no owner session, so no affiliate reader.
  const worker = new SeoBlogEngine(deps);
  const prompts = productWriter(h, o.extra);
  return { h, brand, aff, engine, worker, prompts };
}

async function writeOne(s: Setup, kind = 'shopping_list') {
  const products = s.aff.products_.filter((p) => p.status === 'active');
  await s.engine.requestProductArticle(OWNER, s.brand.id, { commandId: randomUUID(), kind, topic: 'What to keep for a power cut', productIds: products.map((p) => p.productId) });
  await s.worker.tick('w');
  const row = (await s.engine.listArticles(OWNER, s.brand.id))[0]!;
  const detail = await s.engine.getArticle(OWNER, s.brand.id, row.article.id);
  return { article: detail.article, version: detail.version!, products };
}

const connectGithub = (s: Setup) => s.engine.connectDestination(OWNER, s.brand.id, { type: 'github_static', label: 'Website', credential: 'gh-token-1',
  config: { repository: 'acme/site', branch: 'main', publicBaseUrl: SITE, blogPath: 'blog', sitemapPath: 'sitemap.xml' } });
const autoPublishOn = async (s: Setup) => { const b = await s.engine.getBrand(OWNER, s.brand.id); await s.engine.updateSettings(OWNER, s.brand.id, b.rowVersion, { autoPublish: true }); };
const siteFiles = (s: Setup) => [...s.h.github.files().entries()];
const linkedPages = (s: Setup) => siteFiles(s).filter(([, v]) => v.includes('amazon.co.uk/dp/'));
const art = async (s: Setup, id: string) => (await s.h.store.getArticle(s.brand.id, id))!;
const critical = async (s: Setup, id: string) => ((await s.engine.getArticle(OWNER, s.brand.id, id)).article.checks?.issues ?? []).filter((i) => i.severity === 'critical');

/** Schedule for 2026-11-03 09:00 and let the worker reach that time. */
async function scheduleAndRun(s: Setup, articleId: string, destination: Destination, time = '09:00', day = '2026-11-03') {
  const a = await art(s, articleId);
  await s.engine.schedule(OWNER, s.brand.id, articleId, a.rowVersion, { localDate: day, localTime: time, destinationId: destination.id });
  s.h.clock.set(`${day}T${time}:30.000Z`);
  await s.worker.tick('w');
}

// ─── M1: approval can never be skipped ───────────────────────────────────────

test('M1: the gate itself requires approval of the exact version for a product article, whatever the stored flag and auto-publish say', () => {
  const at = '2026-11-03T09:00:30.000Z';
  const version = { id: 'v1', contentSha: 'c1', body: { affiliate: { programme: 'amazon_uk', disclosureVersion: 'x', registeredSite: SITE, links: [{ productId: 'p', revision: 1, name: 'Torch', url: 'https://www.amazon.co.uk/dp/B0TORCH001?tag=harbour-21', sectionId: 's', ownerUsed: false }] } } } as unknown as ArticleVersion;
  const article = { delivery: 'none', currentVersionId: 'v1', publishedVersionId: null, schedule: { publishAtUtc: '2026-11-03T09:00:00.000Z', destinationId: 'd' }, hold: null, requiresApproval: false, approval: null } as unknown as Article;
  const base = { brand: { settings: { autoPublish: true, pauseAll: false } } as unknown as Brand, article, version, checks: { versionId: 'v1', contentSha: 'c1', factsSha: 'f', status: 'pass', issues: [] } as never, currentFactsSha: 'f', destination: { id: 'd', status: 'connected' } as Destination, now: at };
  const linked = evaluatePublication(base);
  assert.equal(linked.decision, 'hold');
  assert.equal(linked.decision === 'hold' && linked.hold.reason, 'missing_approval');
  // No links left, but the brief has products: still held.
  const bare = { ...version, body: {} } as unknown as ArticleVersion;
  const briefOnly = evaluatePublication({ ...base, version: bare, brief: { products: {} as BriefProducts } });
  assert.equal(briefOnly.decision === 'hold' && briefOnly.hold.reason, 'missing_approval');
  // An ordinary article with the flag off and auto-publish on goes out as before.
  assert.equal(evaluatePublication({ ...base, version: bare, brief: { } }).decision, 'publish');
  // Approved: goes out, and the policy records that approval was required.
  const approved = evaluatePublication({ ...base, article: { ...article, approval: { versionId: 'v1', contentSha: 'c1', approvedAt: at, approvedBy: OWNER.userId } } });
  assert.ok(approved.decision === 'publish' && approved.policy.rule === 'approved' && approved.policy.requiresApproval === true);
});

test('M1: the review\'s sequence (remove every link, switch approval off, write it again, auto-publish) never publishes without approval', async () => {
  const s = await setup();
  const { article, version } = await writeOne(s);
  const dest = await connectGithub(s);
  await autoPublishOn(s);
  let v = version;
  for (const l of version.body.affiliate!.links) v = await s.engine.removeAffiliateLink(OWNER, s.brand.id, article.id, v.id, l.productId);
  assert.equal(v.body.affiliate!.links.length, 0);
  // Switching "needs my approval" off is refused for a product article even with no link left.
  await assert.rejects(s.engine.setRequiresApproval(OWNER, s.brand.id, article.id, (await art(s, article.id)).rowVersion, false), /always waits for your approval/);
  // Even a stored flag of false (an older row, or any other route) does not open the gate.
  const a0 = await art(s, article.id);
  await s.h.store.updateArticle({ ...a0, requiresApproval: false });
  await s.engine.requestRegeneration(OWNER, s.brand.id, article.id, v.id);
  await s.worker.tick('w');
  const rewritten = await s.engine.getArticle(OWNER, s.brand.id, article.id);
  assert.equal(rewritten.version!.body.affiliate!.links.length, 3, 'the rewrite put the links back');
  assert.equal(rewritten.article.requiresApproval, true, 'the flag is set back whenever a version with links is added');
  await s.h.store.updateArticle({ ...rewritten.article, requiresApproval: false });
  await scheduleAndRun(s, article.id, dest);
  const after = await s.engine.getArticle(OWNER, s.brand.id, article.id);
  assert.equal(after.article.hold?.reason, 'missing_approval');
  assert.equal(after.article.delivery, 'none');
  assert.deepEqual(linkedPages(s), [], 'nothing with product links reached the website');
});

test('M1: every other way to a new version holds too (retry, allowance auto-resume) and the links check runs on approve, approve-and-publish and schedule', async () => {
  // Retry: the first write is blocked (the writer never uses the product names), then retried with a writer that does.
  let names = false;
  const s = await setup({ extra: (n) => names ? {} : { sections: n.map((x, i) => ({ heading: `Part ${i + 1} ${x.length}`, body: `${filler} ${filler}` })) } });
  const products = s.aff.products_;
  await s.engine.requestProductArticle(OWNER, s.brand.id, { commandId: randomUUID(), kind: 'shopping_list', topic: 'What to keep for a power cut', productIds: products.map((p) => p.productId) });
  await s.worker.tick('w');
  const blocked = (await s.engine.listJobs(OWNER, s.brand.id)).find((j) => j.kind === 'write')!;
  assert.notEqual(blocked.state, 'done');
  names = true;
  await s.engine.retryJob(OWNER, s.brand.id, blocked.id);
  await s.worker.tick('w');
  const [row] = await s.engine.listArticles(OWNER, s.brand.id);
  assert.equal(row!.article.requiresApproval, true);
  const dest = await connectGithub(s);
  await autoPublishOn(s);
  await scheduleAndRun(s, row!.article.id, dest);
  assert.equal((await art(s, row!.article.id)).hold?.reason, 'missing_approval', 'retried: held for approval');

  // Allowance auto-resume: the write waits for the writing allowance, then carries on when it is raised.
  const t = await setup();
  const b = await t.engine.getBrand(OWNER, t.brand.id);
  await t.engine.updateSettings(OWNER, t.brand.id, b.rowVersion, { budgets: { modelTokensPerMonth: 20_000, searchCallsPerMonth: 200, imagesPerMonth: 0 } });
  await assert.rejects(t.engine.requestProductArticle(OWNER, t.brand.id, { commandId: randomUUID(), kind: 'shopping_list', topic: 'What to keep for a power cut', productIds: t.aff.products_.map((p) => p.productId) }), /allowance/i);
  const b2 = await t.engine.getBrand(OWNER, t.brand.id);
  await t.engine.updateSettings(OWNER, t.brand.id, b2.rowVersion, { budgets: { modelTokensPerMonth: 2_000_000, searchCallsPerMonth: 200, imagesPerMonth: 0 } });
  await t.engine.resumeAllowanceBlockedWrites(OWNER, t.brand.id);
  const { article, version } = await writeOne(t);
  assert.equal(article.requiresApproval, true);
  const dest2 = await connectGithub(t);
  await autoPublishOn(t);

  // The links check runs on every press towards publication: a retired product blocks approve, approve-and-publish and schedule.
  Object.assign(t.aff.products_[1]!, { status: 'retired' });
  await assert.rejects(t.engine.approve(OWNER, t.brand.id, article.id, version.id), /Update the links/);
  await assert.rejects(t.engine.approveAndSchedule(OWNER, t.brand.id, article.id, { versionId: version.id, when: 'now', destinationId: dest2.id }), /Update the links/);
  await assert.rejects(t.engine.schedule(OWNER, t.brand.id, article.id, (await art(t, article.id)).rowVersion, { localDate: '2026-11-03', localTime: '09:00', destinationId: dest2.id }), /Update the links/);
  // Approved while current, then a product retired: approve-and-publish (already approved) checks again.
  Object.assign(t.aff.products_[1]!, { status: 'active' });
  await t.engine.approve(OWNER, t.brand.id, article.id, version.id);
  Object.assign(t.aff.products_[1]!, { status: 'retired' });
  await assert.rejects(t.engine.approveAndSchedule(OWNER, t.brand.id, article.id, { versionId: version.id, when: 'now', destinationId: dest2.id }), /Update the links/);
  // The worker (no owner session) cannot approve at all.
  await assert.rejects(t.worker.approve(OWNER, t.brand.id, article.id, version.id), /could not be checked/);
});

test('M1 and S6: under the strict setting a product article holds without live research, and a retry never publishes or buys research again', async () => {
  const s = await setup({ engine: { requireFullEngine: true } });
  (s.h.search as unknown as { mode: string }).mode = 'unconfigured';
  await assert.rejects(s.engine.requestProductArticle(OWNER, s.brand.id, { commandId: randomUUID(), kind: 'shopping_list', topic: 'What to keep for a power cut', productIds: s.aff.products_.map((p) => p.productId) }), /Research is not available right now/);
  assert.equal((await s.engine.listArticles(OWNER, s.brand.id)).length, 0, 'nothing was planned or written');
  // Live research that finds too little: the write holds, and Retry reuses the saved research.
  const t = await setup({ engine: { requireFullEngine: true } });
  t.h.search.search = async function (this: { calls: number }) { this.calls++; return [{ url: 'https://landlord-news.example/deposits-explained', title: 'x', snippet: '' }]; } as never;
  await t.engine.requestProductArticle(OWNER, t.brand.id, { commandId: randomUUID(), kind: 'shopping_list', topic: 'What to keep for a power cut', productIds: t.aff.products_.map((p) => p.productId) });
  const [brief] = (await t.engine.listPlans(OWNER, t.brand.id)).flatMap((p) => p.briefs);
  assert.deepEqual({ strict: brief!.engine?.strict, research: brief!.engine?.research, numbers: brief!.engine?.numbers }, { strict: true, research: 'live', numbers: 'off' }, 'product briefs carry the engine stamp');
  await t.worker.tick('w');
  const job = (await t.engine.listJobs(OWNER, t.brand.id)).find((j) => j.kind === 'write')!;
  assert.match(`${job.error}`, /did not find enough trustworthy sources for this product article/);
  const searches = (t.h.search as unknown as { calls: number }).calls;
  await t.engine.retryJob(OWNER, t.brand.id, job.id);
  await t.worker.tick('w');
  assert.equal((t.h.search as unknown as { calls: number }).calls, searches, 'research is not bought again');
  const rows = await t.engine.listArticles(OWNER, t.brand.id);
  assert.ok(rows.every((r) => !r.article.currentVersionId), 'nothing was written');
});

// ─── S1: changed details or a retired product take approval back ─────────────

test('S1: changing the tracking ID or retiring a product takes back the approval of unpublished linked articles, so the old link never goes out', async () => {
  const s = await setup();
  const { article, version, products } = await writeOne(s);
  const dest = await connectGithub(s);
  await s.engine.approve(OWNER, s.brand.id, article.id, version.id);
  const a = await art(s, article.id);
  await s.engine.schedule(OWNER, s.brand.id, article.id, a.rowVersion, { localDate: '2026-11-03', localTime: '09:00', destinationId: dest.id });
  const svc = service(s.engine, s.aff), id = who(s.brand.id), base = `/portal/seo-blog/b/${s.brand.id}`;
  let r = await call(svc, id, 'POST', `${base}/affiliate/settings`, { form: [['revision', '1'], ['trackingId', 'corrected-21'], ['registeredSite', 'harbour.example'], ['siteListed', '1'], ['accountMine', '1']] });
  assert.equal(r.isError, false, r.notice);
  assert.match(r.notice, /Links use your tracking ID “corrected-21”\. 1 approved article with product links now waits for your approval again\./);
  assert.equal((await art(s, article.id)).approval, null);
  s.h.clock.set('2026-11-03T09:00:30.000Z');
  await s.worker.tick('w');
  assert.equal((await art(s, article.id)).hold?.reason, 'missing_approval');
  assert.deepEqual(linkedPages(s), []);
  // Retiring a product the article links to does the same.
  const t = await setup();
  const w = await writeOne(t);
  await t.engine.approve(OWNER, t.brand.id, w.article.id, w.version.id);
  r = await call(service(t.engine, t.aff), who(t.brand.id), 'POST', `/portal/seo-blog/b/${t.brand.id}/products/${w.products[0]!.productId}/retire`, { form: [['revision', '1']] });
  assert.match(r.notice, /1 approved article with product links now waits for your approval again\./);
  assert.equal((await art(t, w.article.id)).approval, null);
  for (const line of (await t.engine.activity(OWNER, t.brand.id, 20)).filter((x) => x.kind === 'affiliate.approval_cleared')) assert.equal(ownerActivityWords(line.message, line.kind), line.message);
  void products;
});

// ─── The screens, through the real router ────────────────────────────────────

function service(engine: SeoBlogEngine, aff: AffiliateStores | null, extraBrands: Record<string, AffiliateStores> = {}): PortalSeoBlogService {
  // As composed in production: the stores belong to the session's own workspace.
  return { generation: 'live', research: 'live', social: 'unavailable', engineFor: () => engine, socialCallback: async () => null,
    ...(aff ? { affiliateFor: (identity: PortalSessionIdentity) => identity.workspaceId === aff.workspaceId ? aff : extraBrands[identity.workspaceId] ?? new FakeAffiliate(identity.workspaceId) } : {}) } as PortalSeoBlogService;
}
const who = (workspaceId: string): PortalSessionIdentity => ({ sessionToken: `token-${OWNER.userId}`, userId: OWNER.userId, workspaceId, userEmail: 'owner@example.test' });
async function call(svc: PortalSeoBlogService, id: PortalSessionIdentity, method: string, path: string, o: { form?: [string, string][]; multipart?: { fields: [string, string][]; file: { name: string; data: string } }; csrf?: string } = {}) {
  let body = '', type = '';
  const csrf = o.csrf ?? portalCsrfToken(SECRET, id.sessionToken);
  if (o.form) { body = new URLSearchParams([['_csrf', csrf], ...o.form]).toString(); type = 'application/x-www-form-urlencoded'; }
  if (o.multipart) {
    const b = 'XXBOUNDARY';
    body = [...[['_csrf', csrf], ...o.multipart.fields].map(([k, v]) => `--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`), `--${b}\r\nContent-Disposition: form-data; name="file"; filename="${o.multipart.file.name}"\r\nContent-Type: text/csv\r\n\r\n${o.multipart.file.data}\r\n--${b}--\r\n`].join('');
    type = `multipart/form-data; boundary=${b}`;
  }
  const req = new PassThrough() as unknown as IncomingMessage & PassThrough;
  Object.assign(req, { method, url: path, headers: { host: 'portal.example', ...(type ? { 'content-type': type, 'content-length': String(Buffer.byteLength(body)), origin: 'https://portal.example' } : {}), cookie: 'r72_content_look=new' } });
  (req as PassThrough).end(body);
  let status = 0; let headers: Record<string, string> = {}; let out = '';
  const res = { writeHead(st: number, hd: Record<string, string>) { status = st; headers = hd; return res; }, setHeader() {}, end(chunk?: string | Buffer) { if (chunk) out += chunk.toString(); } } as unknown as ServerResponse;
  await handleSeoBlog(req, res, new URL(path, 'https://portal.example'), { service: svc, identity: id, requestId: 'r-fixed', sessionSecret: SECRET, vaultReady: true, contentAreaPreview: 'enabled' } as Parameters<typeof handleSeoBlog>[3]);
  const loc = headers.location ? new URL(headers.location, 'https://x') : null;
  const msg = loc ? (loc.searchParams.get('n') ?? loc.searchParams.get('e')) : null;
  return { status, headers, body: out, notice: msg ? Buffer.from(msg, 'base64url').toString().replace(/^[^|]*\|/, '') : '', isError: Boolean(loc?.searchParams.has('e')), location: loc ? `${loc.pathname}${loc.hash}` : '' };
}
const visible = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const sameShape = (html: string) => html.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, 'ID').replace(/name="_csrf" value="[^"]*"/g, '');

test('M2: a business made with "Add a business" renders exactly as with the switch off (no Products pill, no cards, no "not found")', async () => {
  const h = harness();
  const home = randomUUID(); // the session's own workspace
  const brandB = await readyBrand(h, 'Bay Supplies', 'https://bay-shop.example');
  assert.notEqual(brandB.id, home, 'a new business is its own workspace');
  const engine = new SeoBlogEngine({ store: h.store, llm: h.llm, search: h.search, transport: h.web, publishers: new Map(), vault: h.vault, now: h.clock.now, batchLimit: 20 });
  const on = service(engine, new FakeAffiliate(home), { [brandB.id]: new FakeAffiliate(brandB.id) }), off = service(engine, null), id = who(home), base = `/portal/seo-blog/b/${brandB.id}`;
  for (const page of ['articles', 'results', 'publishing', 'products', 'products/write', `results/report/${randomUUID()}`]) {
    const a = await call(on, id, 'GET', `${base}/${page}`), b = await call(off, id, 'GET', `${base}/${page}`);
    assert.equal(a.status, b.status, page);
    assert.equal(sameShape(a.body), sameShape(b.body), `${page} is exactly as with the switch off`);
    assert.doesNotMatch(a.body, /af-pills|What Amazon reported|Amazon UK details/, page);
  }
  for (const page of ['articles', 'results', 'publishing']) assert.equal((await call(on, id, 'GET', `${base}/${page}`)).status, 200, page);
  // And a POST answers as with the switch off.
  const p1 = await call(on, id, 'POST', `${base}/products`, { form: [['link', 'https://www.amazon.co.uk/dp/B0TORCH001']] }), p2 = await call(off, id, 'POST', `${base}/products`, { form: [['link', 'https://www.amazon.co.uk/dp/B0TORCH001']] });
  assert.equal(p1.status, p2.status); assert.equal(p1.location, p2.location);
  // The business the session is signed in to still gets the screens.
  const own = await readyBrand(h, 'Home Shop', 'https://home-shop.example');
  const onOwn = service(engine, new FakeAffiliate(own.id));
  assert.match((await call(onOwn, who(own.id), 'GET', `/portal/seo-blog/b/${own.id}/results`)).body, /What Amazon reported/);
});

test('M3: a tracking ID in a pasted link is never adopted; the owner types it, it is named back, and a different tag in a link is replaced and said', async () => {
  const h = harness();
  const brand = await readyBrand(h);
  const aff = new FakeAffiliate(brand.id);
  const engine = new SeoBlogEngine({ store: h.store, llm: h.llm, search: h.search, transport: h.web, publishers: new Map(), vault: h.vault, now: h.clock.now, batchLimit: 20, affiliate: affiliateReader(aff) });
  const svc = service(engine, aff), id = who(brand.id), base = `/portal/seo-blog/b/${brand.id}`;
  const first = await call(svc, id, 'GET', `${base}/products`);
  assert.match(first.body, /<input id="tracking" name="trackingId" autocomplete="off" maxlength="64" required>/, 'the tracking ID must be typed');
  assert.match(visible(first.body), /we never take it from a link you paste/);
  // The review's input: somebody else's tag in the link, tracking ID box left empty, both boxes ticked.
  const stranger = 'https://www.amazon.co.uk/Wind-Up-Torch/dp/B0TORCH001?tag=stranger-21&linkCode=ll1';
  let r = await call(svc, id, 'POST', `${base}/products`, { form: [['commandId', randomUUID()], ['link', stranger], ['registeredSite', 'harbour.example'], ['siteListed', '1'], ['accountMine', '1']] });
  assert.equal(r.isError, true); assert.match(r.notice, /Type your Amazon UK tracking ID/);
  assert.equal(aff.settings_, null, 'nothing was saved');
  r = await call(svc, id, 'POST', `${base}/products`, { form: [['commandId', randomUUID()], ['link', stranger], ['trackingId', 'harbour-21'], ['registeredSite', 'harbour.example'], ['siteListed', '1'], ['accountMine', '1']] });
  assert.equal(r.isError, false, r.notice);
  assert.equal(r.notice, 'Product added. Your tracking ID “harbour-21” is saved, and every link uses it. The link you pasted carried a different tracking ID, “stranger-21”, so we used yours instead.');
  assert.equal(aff.settings_!.trackingId, 'harbour-21');
  assert.equal(aff.products_[0]!.affiliateUrl, 'https://www.amazon.co.uk/dp/B0TORCH001?tag=harbour-21');
  // Later products: a stranger's tag is replaced and said; a plain page gets the saved ID, named.
  r = await call(svc, id, 'POST', `${base}/products`, { form: [['commandId', randomUUID()], ['link', 'https://www.amazon.co.uk/dp/B0RADIO002?tag=stranger-21'], ['productName', 'Battery radio']] });
  assert.equal(r.notice, 'Product added. Its link uses your tracking ID “harbour-21”. The link you pasted carried a different tracking ID, “stranger-21”, so we used yours instead.');
  assert.equal(aff.products_[1]!.affiliateUrl, 'https://www.amazon.co.uk/dp/B0RADIO002?tag=harbour-21');
  r = await call(svc, id, 'POST', `${base}/products`, { form: [['commandId', randomUUID()], ['link', 'https://www.amazon.co.uk/dp/B0WATER003'], ['productName', 'Water carrier']] });
  assert.equal(r.notice, 'Product added. Its link uses your tracking ID “harbour-21”.');
  // The form and the Settings card name the saved ID.
  assert.match((await call(svc, id, 'GET', `${base}/products`)).body, /The link is made with your tracking ID <strong>harbour-21<\/strong>/);
  assert.match((await call(svc, id, 'GET', `${base}/publishing`)).body, /Links use your tracking ID <strong>harbour-21<\/strong>/);
  r = await call(svc, id, 'POST', `${base}/affiliate/settings`, { form: [['revision', '1'], ['trackingId', 'harbour-21'], ['registeredSite', 'harbour.example'], ['siteListed', '1'], ['accountMine', '1']] });
  assert.equal(r.notice, 'Your Amazon UK details are saved. Links use your tracking ID “harbour-21”.');
});

test('S8, S9, N4: "Add a product" pressed twice adds it once; a name of invisible characters is refused; the same product is not added twice', async () => {
  const h = harness();
  const brand = await readyBrand(h);
  const aff = new FakeAffiliate(brand.id);
  await aff.products.saveSettings({ workspaceId: brand.id, programme: 'amazon_uk', expectedRevision: 0, trackingId: 'harbour-21', registeredSite: SITE, siteListedConfirmed: true, accountConfirmed: true });
  const engine = new SeoBlogEngine({ store: h.store, llm: h.llm, search: h.search, transport: h.web, publishers: new Map(), vault: h.vault, now: h.clock.now, affiliate: affiliateReader(aff) });
  const svc = service(engine, aff), id = who(brand.id), base = `/portal/seo-blog/b/${brand.id}`;
  const form: [string, string][] = [['commandId', randomUUID()], ['link', 'https://www.amazon.co.uk/dp/B0TORCH001'], ['productName', 'Wind-up torch']];
  assert.match((await call(svc, id, 'POST', `${base}/products`, { form })).notice, /^Product added\./);
  const again = await call(svc, id, 'POST', `${base}/products`, { form });
  assert.equal(again.isError, false); assert.equal(again.notice, 'That product was already added.');
  assert.equal(aff.products_.length, 1);
  // The same product under another name.
  const twin = await call(svc, id, 'POST', `${base}/products`, { form: [['commandId', randomUUID()], ['link', 'https://www.amazon.co.uk/Other/dp/B0TORCH001?tag=harbour-21'], ['productName', 'Torch again']] });
  assert.equal(twin.isError, true); assert.equal(twin.notice, 'You already have this product, as “Wind-up torch”. Each product is added once.');
  // A name of invisible characters only, at the route and at the store.
  const empty = await call(svc, id, 'POST', `${base}/products`, { form: [['commandId', randomUUID()], ['link', 'https://www.amazon.co.uk/dp/B0RADIO002'], ['productName', '​​⁠']] });
  assert.equal(empty.isError, true); assert.equal(empty.notice, 'Give the product a name.');
  assert.equal(PgAffiliateProductStore.prepare({ programme: 'amazon_uk', link: 'https://www.amazon.co.uk/dp/B0RADIO002', productName: '​‮⁠', ownerUsed: false }, 'harbour-21').ok, false);
  assert.equal(aff.products_.length, 1);
});

test('S10: an expired form on the Amazon UK details card goes back to Settings, not to "not found"', async () => {
  const s = await setup();
  const r = await call(service(s.engine, s.aff), who(s.brand.id), 'POST', `/portal/seo-blog/b/${s.brand.id}/affiliate/settings`, { form: [['revision', '1'], ['trackingId', 'harbour-21']], csrf: 'expired' });
  assert.equal(r.status, 303);
  assert.equal(r.location, `/portal/seo-blog/b/${s.brand.id}/publishing`);
  assert.equal(r.isError, true);
});

// ─── M4, S3, S12: what a product article may not say, anywhere ───────────────

test('M4: a price, rating, stock, delivery, testing claim or the shop is caught in the title, search title, description, summary, picture words, headings and questions, at approval', async () => {
  const s = await setup();
  const { article, version } = await writeOne(s);
  const v2 = await s.engine.editArticle(OWNER, s.brand.id, article.id, version.id, {
    title: 'Best power cut kit under £19.99 on Amazon.co.uk (4.5 stars, in stock, free delivery)',
    seoTitle: 'Power cut kit from £9.99 | 20% off today',
    metaDescription: 'We tested every torch. Now £19.99 at amazon.co.uk with next-day delivery and 2,000 reviews, rated 4.8 out of 5.',
    excerpt: 'Only £19.99 today, best seller, Amazon\'s Choice. We tested them all.',
    image: { ...version.body.image, alt: 'A torch on sale for £9.99' },
    faqs: [{ q: 'Is it rated five stars?', a: 'It depends on what you need it for at home.' }],
  });
  const issues = await critical(s, article.id);
  const at = (where: string) => issues.filter((i) => i.location === where).map((i) => i.code).sort();
  assert.deepEqual(at('Title'), ['affiliate.price_stated', 'affiliate.rating_or_stock', 'affiliate.raw_merchant_link']);
  assert.deepEqual(at('Title in search results'), ['affiliate.price_stated']);
  assert.deepEqual(at('Description in search results'), ['affiliate.price_stated', 'affiliate.rating_or_stock', 'affiliate.raw_merchant_link', 'affiliate.untested_claim']);
  assert.deepEqual(at('Summary'), ['affiliate.price_stated', 'affiliate.rating_or_stock', 'affiliate.untested_claim']);
  assert.deepEqual(at('Picture description'), ['affiliate.price_stated']);
  assert.deepEqual(at('Question 1'), ['affiliate.rating_or_stock']);
  await assert.rejects(s.engine.approve(OWNER, s.brand.id, article.id, v2.id), /critical issues/);
  // A heading counts too.
  const v3 = await s.engine.editArticle(OWNER, s.brand.id, article.id, v2.id, { title: version.body.title, seoTitle: version.body.seoTitle, metaDescription: version.body.metaDescription, excerpt: version.body.excerpt, image: version.body.image, faqs: version.body.faqs,
    sections: [...version.body.sections, { id: '', heading: 'Half price this week', body: `${filler} ${filler}` }] });
  assert.ok((await critical(s, article.id)).some((i) => i.code === 'affiliate.price_stated' && i.location === 'Section “Half price this week”'));
  void v3;
});

test('M4: the writer is told about every surface at write time, and an article that keeps breaking the rules is not saved', async () => {
  const bad = (names: string[]) => ({ title: 'Power cut kit: best prices on Amazon.co.uk', seo_title: 'Power cut kit from £9.99 on amazon.co.uk', meta_description: 'Rated 4.8 out of 5 by 2,000 reviews. From £9.99 with free delivery at amazon.co.uk. We tested every one of them for you.',
    excerpt: 'From £9.99 today on amazon.co.uk, tested by us.', image_alt: 'Torch on sale at amazon.co.uk for £9.99', sections: names.map((n) => ({ heading: n, body: `${filler} ${filler}` })) });
  const p = { schema: 1, programme: 'amazon_uk', kind: 'shopping_list', topic: 't', trackingId: 'harbour-21', registeredSite: SITE, products: [{ productId: 'p', revision: 1, productName: 'Torch', merchantName: 'Amazon UK', affiliateUrl: '', infoUrl: null, notes: null, ownerUsed: false }] } as BriefProducts;
  const problems = productArticleProblems({ ...bad(['Torch']), intro: filler, conclusion: filler, faqs: [{ q: 'Is it cheaper at £9.99?', a: 'Maybe.' }] }, p);
  assert.ok(problems.some((x) => /shop address/.test(x) && /Title/.test(x) && /Picture description/.test(x)), problems.join('\n'));
  assert.ok(problems.some((x) => /price/.test(x) && /Description in search results/.test(x) && /Question 1/.test(x)));
  assert.ok(problems.some((x) => /star rating/.test(x)) && problems.some((x) => /tested/.test(x)));
  const s = await setup({ extra: bad });
  await s.engine.requestProductArticle(OWNER, s.brand.id, { commandId: randomUUID(), kind: 'shopping_list', topic: 'What to keep for a power cut', productIds: s.aff.products_.map((x) => x.productId) });
  await s.worker.tick('w');
  const [row] = await s.engine.listArticles(OWNER, s.brand.id);
  assert.equal(row!.article.currentVersionId, null, 'nothing with a price in its title was saved');
  assert.equal(s.h.llm.calls.filter((c) => c === 'SEO_BLOG_ARTICLE').length, 2, 'one chance to correct, as for the body');
});

test('S12: the wording rules are structural: the review\'s 15 phrasings are caught and ordinary honest sentences are not', () => {
  const caught = ['It costs 19.99 at the moment.', 'It is about twenty quid.', 'Half price this week.', 'Now 20% cheaper than last month.', 'A bargain at under a tenner.', 'Rated five stars by buyers.', 'Thousands of happy reviews.',
    'Usually arrives the next day.', 'Currently available to order with Prime.', 'RRP 24.99, now less.', 'The number one best selling torch.', 'Our team checked it for a month.', 'Tested by experts.', 'Black Friday deal.',
    'It is £19.99.', 'Only $25 in the US.', '4.8/5 from buyers.', 'It has a 4.5-star rating.', 'Over 2,000 reviews.', 'It is in stock now.', 'Free delivery on orders.', 'Next-day delivery is available.', 'We tested it for a week.',
    'Hands-on review below.', 'Buy it on Amazon.', 'See it at amazon。co.uk today.', 'Save 30% today.', 'Ships tomorrow if you order now.'];
  for (const sentence of caught) assert.ok(textRuleBreaks(sentence).length > 0, `should be caught: ${sentence}`);
  const honest = ['We stayed in a five-star hotel once and it had one of these by the bed.', 'Prices change, so check the page before you buy.', 'It runs for 20 hours on one charge.', 'Keep spare batteries in stock at home.',
    'A good deal of light from a small torch.', 'It weighs 450 grams and folds flat.', 'The radio picks up long wave and FM.', 'Most people keep one by the door.', 'Charge it once a month so it is ready.', 'Number the boxes so you can find them in the dark.',
    'The Amazon rainforest has nothing to do with this torch.', 'It has three brightness settings and an SOS flash.', 'Wind it for one minute for ten minutes of light.', 'We checked the official advice on power cuts first.'];
  for (const sentence of honest) assert.deepEqual(textRuleBreaks(sentence), [], `should not be caught: ${sentence}`);
});

test('S3: a shop link typed into the text is caught as a browser reads it (encoded, full-width, ideographic dot, short links, redirects, other shops\' paid links), even with no product link left', async () => {
  const forms = ['[See it](https://www.amazon.co.uk/dp/B0TORCH001?tag=someoneelse-21)', '[See it](https://www.amazon%2Eco.uk/dp/B0TORCH001?tag=someoneelse-21)', '[See it](https://www.ａmazon.co.uk/dp/B0TORCH001?tag=someoneelse-21)',
    '[See it](https://www.amazon。co.uk/dp/B0TORCH001?tag=someoneelse-21)', '[See it](https://amzlink.to/az0abc)', '[See it](https://amzn.asia/d/abc)', '[See it](https://redirect.example/?to=amazon)', '[See it](https://www.ebay.co.uk/itm/1?campid=533)',
    '[See it](https://bit.ly/abc)', 'https://smile.amazon.de/dp/B0TORCH001', '[See it](https://www.awin1.com/cread.php?awinmid=1)'];
  const s = await setup();
  const { article, version } = await writeOne(s);
  let v = version;
  for (const l of version.body.affiliate!.links) v = await s.engine.removeAffiliateLink(OWNER, s.brand.id, article.id, v.id, l.productId);
  for (const md of forms) {
    const sec = v.body.sections[1]!;
    v = await s.engine.editArticle(OWNER, s.brand.id, article.id, v.id, { sections: v.body.sections.map((x) => x.id === sec.id ? { ...x, body: `${filler} ${md}` } : x) });
    assert.ok((await critical(s, article.id)).some((i) => i.code === 'affiliate.raw_merchant_link'), md);
    await assert.rejects(s.engine.approve(OWNER, s.brand.id, article.id, v.id), /critical issues/, md);
  }
  for (const [url, problem] of [['https://www.amazon%2Eco.uk/x', 'shop'], ['https://www.ａmazon.co.uk/x', 'shop'], ['https://amzn.to/x', 'shop'], ['https://bit.ly/x', 'short'], ['https://go.example/?url=https://x.example', 'redirect'], ['https://shop.example/x?tag=a-21', 'paid'], ['https://www.gov.uk/x', null]] as const) {
    assert.equal(shopLinkProblem(url), problem, url);
  }
  // An ordinary article (no products in its brief) is not judged by the product rules at all.
  assert.deepEqual(affiliateIssues({ ...version.body, affiliate: undefined, intro: 'It costs £19.99 at amazon.co.uk.' }, SITE, false), []);
});

// ─── M5: research never reads or cites the shop ──────────────────────────────

test('M5: research for a product article never fetches or cites any address of the Amazon family, checks again after redirects, and no cited address carries a tag', async () => {
  const amazonish = ['https://m.amazon.co.uk/dp/B0TORCH001?tag=stranger-21', 'https://smile.amazon.co.uk/dp/B0TORCH001', 'https://www.amazon.de/dp/B0TORCH001?tag=stranger-21', 'https://amzn.eu/d/abc', 'https://www.amazon.co.uk/dp/B0TORCH001',
    'https://a.co/d/xyz', 'https://amzn.to/abc', 'https://amzlink.to/x', 'https://amzn.asia/d/abc', 'https://www.amazon.com.au/dp/B0TORCH001', 'https://images-amazon.com/x'];
  const page = '<html><head><title>Wind-up torch</title></head><body><main><h1>Wind-up torch</h1><p>What to keep for a power cut: this wind-up torch costs £12.99, has 4.6 out of 5 stars from 3,210 ratings and is in stock with free delivery tomorrow. Keep a wind-up torch and a battery radio for a power cut at home, and a water carrier.</p></main></body></html>';
  const honest = '<html><head><title>Power cuts: be ready</title></head><body><main><h1>Be ready</h1><p>What to keep for a power cut at home: a wind-up torch, a battery radio and a water carrier are the three things most households are told to keep ready for a long power cut in winter.</p></main></body></html>';
  const h0 = harness();
  for (const u of amazonish) h0.web.set(u, page);
  h0.web.set('https://ready.example/power-cuts?tag=someone-21&utm_source=x&linkCode=ll1', honest);
  h0.web.set('https://redirector.example/go', honest);
  // A transport on which one ordinary-looking address ends up on Amazon after its redirects.
  const transport: FetchTransport = { fetch: async (url, options) => { const r = await h0.web.fetch(url, options); return url.startsWith('https://redirector.example/') ? { ...r, finalUrl: 'https://www.amazon.co.uk/dp/B0TORCH001?tag=stranger-21' } : r; } };
  const s = await setup({ transport });
  Object.assign(s.h.web.pages, h0.web.pages); for (const [k, v] of h0.web.pages) s.h.web.pages.set(k, v);
  s.h.search.search = async function (this: { calls: number }) { this.calls++; return [...amazonish, 'https://redirector.example/go', 'https://ready.example/power-cuts?tag=someone-21&utm_source=x&linkCode=ll1'].map((url) => ({ url, title: 'Wind-up torch', snippet: '' })); } as never;
  const before = h0.web.requests.length;
  const { article, version } = await writeOne(s);
  const fetched = h0.web.requests.slice(before);
  assert.deepEqual(fetched.filter((u) => /amazon|amzn|a\.co\/|amzlink/.test(u)), [], 'no Amazon address was fetched');
  assert.ok(fetched.includes('https://redirector.example/go'), 'the redirecting address was read once');
  assert.deepEqual(version.body.citations.map((c) => c.url), ['https://ready.example/power-cuts'], 'only the independent page, with its tags removed');
  const prompt = s.prompts.find((p) => p.user.includes('<products>'))!.user;
  assert.doesNotMatch(prompt, /£12\.99|4\.6 out of 5/, 'the writer never saw the shop\'s price or rating');
  const html = renderArticlePage(version.body, { siteName: 'Harbour', canonicalUrl: `${SITE}/blog/x/`, blogIndexUrl: `${SITE}/blog/`, locale: 'en-GB', publishedAt: '2026-11-02T10:00:00.000Z', articleId: article.id, versionId: version.id, contentSha: version.contentSha });
  for (const m of html.matchAll(/href="([^"]+)"([^>]*)>/g)) if (/amazon|amzn/.test(m[1]!)) assert.match(m[2]!, /rel="sponsored nofollow noopener"/, `${m[1]} is one of our own marked links`);
  assert.equal([...html.matchAll(/tag=([a-z0-9-]+)/g)].every((m) => m[1] === 'harbour-21'), true, 'no one else\'s tag on the page');
  // The pieces.
  for (const host of ['amazon.co.uk', 'm.amazon.co.uk', 'smile.amazon.de', 'www.amazon.com.au', 'amzn.to', 'amzn.eu', 'a.co', 'amzlink.to', 'www.amazon.co.jp']) assert.equal(isAmazonFamilyHost(host), true, host);
  for (const host of ['amazonia.example', 'notamazon.co.uk', 'gov.uk', 'amazon-review.example.com']) assert.equal(isAmazonFamilyHost(host), false, host);
  assert.equal(withoutAffiliateParams('https://x.example/a?tag=y-21&linkCode=ll1&ascsubtag=z&id=4'), 'https://x.example/a?id=4');
  assert.equal(usableProductSource('https://x.example/a?tag=y-21'), true);
  assert.equal(usableProductSource('https://www.amazon.co.uk/dp/B0TORCH001'), false);
});

test('S5: the research spend is recorded even when a search fails part-way, the empty result is kept so a rewrite buys nothing, and the owner is told in one line', async () => {
  const s = await setup();
  let n = 0;
  s.h.search.search = async function () { n++; if (n >= 2) throw new ResearchUnavailableError('down'); return [{ url: 'https://ready.example/none', title: 'x', snippet: '' }]; } as never;
  const { article, version } = await writeOne(s);
  assert.equal(n, 2);
  assert.equal((await s.engine.usage(OWNER, s.brand.id)).search_calls, 2, 'both searches asked for are recorded');
  assert.equal(version.body.citations.length, 0);
  const lines = (await s.engine.activity(OWNER, s.brand.id, 30)).filter((x) => x.kind === 'affiliate.research');
  assert.equal(lines.length, 1);
  assert.equal(ownerActivityWords(lines[0]!.message, lines[0]!.kind), lines[0]!.message, 'plain words, unchanged by the owner-words pass');
  await s.engine.requestRegeneration(OWNER, s.brand.id, article.id, version.id);
  await s.worker.tick('w');
  assert.equal(n, 2, 'the rewrite bought no new research');
  assert.equal((await s.engine.usage(OWNER, s.brand.id)).search_calls, 2);
});

// ─── M6: the label before the click ──────────────────────────────────────────

test('M6: every outward title, description and summary of a product article begins with "Ad: ", the wording says "we earn", and the SEO score is not affected', async () => {
  const s = await setup();
  const { article, version } = await writeOne(s);
  const p = programmeFor('amazon_uk')!;
  assert.match(p.disclosure.text, /We earn a commission if you buy through these links/);
  assert.doesNotMatch(p.disclosure.text, /may earn/);
  assert.match(p.disclosure.text, /As an Amazon Associate I earn from qualifying purchases\.$/);
  assert.equal(version.body.title, 'What to keep for a power cut', 'the stored title is the owner\'s own');
  const pub = publicBody(version.body);
  for (const k of ['title', 'seoTitle', 'metaDescription', 'excerpt'] as const) assert.ok(pub[k].startsWith(AD_PREFIX), k);
  assert.equal(publicBody(pub).title, pub.title, 'never twice');
  const plain = { ...version.body, affiliate: undefined };
  assert.equal(publicBody(plain), plain, 'any other article is the same object');
  // The published page: <title>, the heading, og:title, the description and the structured data headline.
  const html = renderArticlePage(version.body, { siteName: 'Harbour', canonicalUrl: `${SITE}/blog/x/`, blogIndexUrl: `${SITE}/blog/`, locale: 'en-GB', publishedAt: '2026-11-02T10:00:00.000Z', articleId: article.id, versionId: version.id, contentSha: version.contentSha });
  assert.match(html, /<title>Ad: What to keep for a power cut<\/title>/);
  assert.match(html, /<h1>Ad: What to keep for a power cut<\/h1>/);
  assert.match(html, /<meta property="og:title" content="Ad: /);
  assert.match(html, /<meta name="description" content="Ad: /);
  assert.match(html, /"headline":"Ad: What to keep for a power cut"/);
  // The static site's blog index teaser, the content site's payload and the WordPress payload.
  const dest = await connectGithub(s);
  await s.engine.approve(OWNER, s.brand.id, article.id, version.id);
  await scheduleAndRun(s, article.id, dest);
  const index = s.h.github.files().get('blog/index.html') ?? '';
  assert.match(index, /Ad: What to keep for a power cut/);
  assert.match(index, /<p>Ad: /, 'the teaser summary too');
  // The WordPress payload, for an exactly reviewed target.
  const destination = { id: 'd', brandId: s.brand.id, config: {}, websiteCapability: { protocol: 'v2', capabilities: { siteId: 'site', capabilitiesSha: 'caps', urlContract: 'plain', roots: [{ id: 'r', path: '/blog', indexUrl: `${SITE}/blog/`, articleUrlPattern: `${SITE}/blog/{slug}/` }] } } };
  const snapshot = { destinationId: 'd', brandName: 'Harbour', locale: 'en-GB', target: { siteId: 'site', capabilitiesSha: 'caps', rootId: 'r', rootPath: '/blog', indexUrl: `${SITE}/blog/`, canonicalUrl: `${SITE}/blog/${version.body.slug}/` } };
  const websiteTarget = { ...snapshot, deliverySha: websiteSha({ body: version.body, ...snapshot }) };
  const payload = JSON.parse(new WordPressPublisher().payload({ websiteTarget, destination, operationId: 'o', articleId: article.id, versionId: version.id, contentSha: version.contentSha, versionNumber: 1, body: version.body, publishedAt: '2026-11-03T09:00:00.000Z', locale: 'en-GB', brandName: 'Harbour', credential: 'x' } as never));
  // The content site's payload.
  const contentApi = new ContentApiPublisher(s.h.site.fetch, 1000, () => s.h.clock.ms);
  await contentApi.publish({ destination: { id: 'c', brandId: s.brand.id, publicBaseUrl: 'https://bay.example', config: { endpoint: 'https://bay.example/api/blog/publish' } }, credential: 'x'.repeat(40), operationId: 'o', articleId: article.id, versionId: version.id, contentSha: version.contentSha, versionNumber: 1, body: version.body, publishedAt: '2026-11-03T09:00:00.000Z', locale: 'en-GB', brandName: 'Harbour' } as never);
  const sent = s.h.site.payloads.at(-1) as Record<string, string>;
  for (const k of ['title', 'seoTitle', 'metaDescription', 'excerpt']) assert.ok(sent[k]!.startsWith(AD_PREFIX), `content site ${k}`);
  assert.equal(payload.title, 'Ad: What to keep for a power cut'); assert.ok(payload.seoTitle.startsWith('Ad: ') && payload.excerpt.startsWith('Ad: ') && payload.metaDescription.startsWith('Ad: ') && payload.wordpress.social.title.startsWith('Ad: '));
  // The SEO score reads the stored article: the label never shortens the title or moves the search phrase.
  const brief = { targetQuery: 'what to keep for a power cut' };
  assert.deepEqual(seoScore(brief, version.body), seoScore(brief, plain));
});

test('S2: a product article gets no social drafts, no campaign and no Activity line about drafts', async () => {
  const s = await setup();
  const { article, version } = await writeOne(s);
  assert.equal(version.promotionPack, undefined);
  assert.equal((await art(s, article.id)).campaign, undefined);
  assert.ok(!s.h.llm.calls.includes('SEO_BLOG_SOCIAL'));
  const edited = await s.engine.editArticle(OWNER, s.brand.id, article.id, version.id, { intro: `${version.body.intro} More.` });
  assert.equal(edited.promotionPack, undefined);
  const lines = (await s.engine.activity(OWNER, s.brand.id, 50)).map((x) => `${x.kind}: ${x.message}`);
  assert.deepEqual(lines.filter((x) => /promotion|drafts|model/i.test(x)), []);
  await assert.rejects(s.engine.approvePromotion(OWNER, s.brand.id, article.id, edited.id, 'instagram', 'x'), /changed/);
});

// ─── M7: the published page is checked ───────────────────────────────────────

test('M7: the published page is read back; a page that lost the label or the paid-link marking raises a plain alert, and the website takes no more product articles until it passes', async () => {
  const s = await setup();
  const first = await writeOne(s);
  const dest = await connectGithub(s);
  await s.engine.approve(OWNER, s.brand.id, first.article.id, first.version.id);
  await scheduleAndRun(s, first.article.id, dest);
  let d = await s.engine.getArticle(OWNER, s.brand.id, first.article.id);
  assert.equal(d.status, 'Published');
  assert.equal(d.publications[0]!.affiliateCheck?.state, 'passed', JSON.stringify(d.publications[0]!.affiliateCheck));
  // The site's sanitiser rewrites every rel (as the Property Predator site does) and drops the label.
  const path = 'blog/what-to-keep-for-a-power-cut/index.html';
  const served = s.h.github.files().get(path)!;
  s.h.github.files().set(path, served.replace(/<p class="r72-disclosure">[\s\S]*?<\/p>/, '').replace(/<title>Ad: /, '<title>').replace(/<h1>Ad: /, '<h1>').replace(/ rel="sponsored nofollow noopener"/g, ' rel="noopener"'));
  await s.engine.reobservePublication(OWNER, s.brand.id, first.article.id, d.publications[0]!.id);
  d = await s.engine.getArticle(OWNER, s.brand.id, first.article.id);
  assert.equal(d.publications[0]!.affiliateCheck?.state, 'failed');
  assert.deepEqual([...d.publications[0]!.affiliateCheck!.problems].sort(), ['A product link is not marked as a paid link.', 'The Amazon Associates statement is missing.', 'The ad label is not shown before the first product link.'].sort());
  const alert = (await s.engine.activity(OWNER, s.brand.id, 20)).find((x) => x.kind === 'affiliate.page_alert')!;
  assert.equal(alert.message, AFFILIATE_PAGE_ALERT);
  assert.equal(ownerActivityWords(alert.message, alert.kind), AFFILIATE_PAGE_ALERT, 'shown to the owner exactly');
  const page = await call(service(s.engine, s.aff), who(s.brand.id), 'GET', `/portal/seo-blog/b/${s.brand.id}/articles/${first.article.id}`);
  assert.match(page.body, /<section class="ap-fix" role="alert"><p><strong>Your website changed this page when it put it up\./);
  // A second product article to the same website is held, not sent.
  const second = await (async () => {
    await s.engine.requestProductArticle(OWNER, s.brand.id, { commandId: randomUUID(), kind: 'comparison', topic: 'Torch or radio for a power cut', productIds: s.aff.products_.slice(0, 2).map((p) => p.productId) });
    await s.worker.tick('w');
    const row = (await s.engine.listArticles(OWNER, s.brand.id)).find((r) => r.article.id !== first.article.id)!;
    const d0 = await s.engine.getArticle(OWNER, s.brand.id, row.article.id);
    await s.engine.editArticle(OWNER, s.brand.id, row.article.id, d0.version!.id, { title: 'Torch or radio: which helps more when the lights go out', seoTitle: 'Torch or radio when the lights go out' });
    return (await s.engine.getArticle(OWNER, s.brand.id, row.article.id));
  })();
  assert.deepEqual((await critical(s, second.article.id)).map((i) => `${i.code} ${i.location} ${i.message}`), []);
  await s.engine.approve(OWNER, s.brand.id, second.article.id, second.version!.id);
  await scheduleAndRun(s, second.article.id, dest, '10:00', '2026-11-04');
  const held = await art(s, second.article.id);
  assert.equal(held.delivery, 'none');
  assert.deepEqual({ reason: held.hold?.reason, detail: held.hold?.detail }, { reason: 'destination', detail: AFFILIATE_PAGE_BLOCK });
  assert.equal(s.h.github.files().has('blog/torch-or-radio-for-a-power-cut/index.html'), false);
  // The page cannot be opened at all: not verified, never passed.
  s.h.github.files().delete(path);
  await s.engine.reobservePublication(OWNER, s.brand.id, first.article.id, d.publications[0]!.id);
  assert.equal((await s.engine.getArticle(OWNER, s.brand.id, first.article.id)).publications[0]!.affiliateCheck?.state, 'unverified');
  assert.ok((await s.engine.activity(OWNER, s.brand.id, 30)).some((x) => x.kind === 'affiliate.page_alert' && x.message === AFFILIATE_PAGE_UNVERIFIED));
  // Fixed on the site: a later check passes and product articles may go again.
  s.h.github.files().set(path, served);
  await s.engine.reobservePublication(OWNER, s.brand.id, first.article.id, d.publications[0]!.id);
  assert.equal((await s.engine.getArticle(OWNER, s.brand.id, first.article.id)).publications[0]!.affiliateCheck?.state, 'passed');
  const again = await art(s, second.article.id);
  await s.engine.hold(OWNER, s.brand.id, second.article.id, again.rowVersion, false);
  await scheduleAndRun(s, second.article.id, dest, '11:00', '2026-11-05');
  assert.equal((await art(s, second.article.id)).delivery, 'published');
});

test('M7: the page check itself: our own page passes; a stripped rel, a missing label or statement, a missing link, or a page that cannot be opened do not', async () => {
  const s = await setup();
  const { version } = await writeOne(s);
  const a = version.body.affiliate!;
  const fragment = renderArticleFragment({ body: version.body } as never, `${SITE}/x`);
  assert.deepEqual(affiliatePageProblems(`<html><body>${fragment}</body></html>`, a), []);
  // The Property Predator sanitiser's output: every rel rewritten to noopener (review M7).
  assert.deepEqual(affiliatePageProblems(`<body>${fragment.replace(/rel="sponsored nofollow noopener"/g, 'rel="noopener"')}</body>`, a), ['A product link is not marked as a paid link.']);
  assert.ok(affiliatePageProblems(`<body>${fragment.replace(/<strong>Ad\.<\/strong>/, '')}</body>`, a).includes('The ad label is not shown before the first product link.'));
  assert.ok(affiliatePageProblems(`<body>${fragment.replace('As an Amazon Associate I earn from qualifying purchases.', '')}</body>`, a).includes('The Amazon Associates statement is missing.'));
  assert.ok(affiliatePageProblems(`<body>${fragment.replace(a.links[0]!.url, 'https://example.org/')}</body>`, a).includes('A product link is missing from the page.'));
  // "Ad" in the <head> title does not count as a label in the page.
  assert.ok(affiliatePageProblems(`<html><head><title>Ad: x</title></head><body>${fragment.replace(/<strong>Ad\.<\/strong>/, '')}</body></html>`, a).includes('The ad label is not shown before the first product link.'));
  // A shop link somebody else added without the marking fails too.
  assert.ok(affiliatePageProblems(`<body>${fragment}<a href="https://www.amazon.co.uk/dp/B0OTHER001">x</a></body>`, a).includes('A product link is not marked as a paid link.'));
});

// ─── S4, N5, N6: the reports ─────────────────────────────────────────────────

test('S4: the Results card headlines the saved tracking ID\'s own row; unknown cells are "Not shown by Amazon"; totals rows in any spelling; ambiguous money is refused', () => {
  const H = 'Tracking ID,Clicks,Ordered Items,Shipped Items,Earnings\n';
  for (const total of ['Totals:', 'Total:', 'Grand Total:', 'TOTAL (all IDs)', 'Total for period', 'Total']) {
    const r = readAmazonTrackingReport(`${H}harbour-21,412,9,8,£23.40\n${total},412,9,8,£23.40\n`);
    assert.ok(r.ok && r.report.rows.length === 1 && r.report.knownEarningsMinor === 2340, total);
  }
  const tagged = readAmazonTrackingReport(`${H}total-21,5,1,1,£1.00\n`);
  assert.ok(tagged.ok && tagged.report.rows.length === 1, 'a tracking ID that starts with "total" is still read');
  for (const money of ['"1,50"', '"0,99"', '(-1.50)', '"1.234,56"']) assert.equal(readAmazonTrackingReport(`${H}harbour-21,1,1,1,${money}\n`).ok, false, money);
  assert.equal(readAmazonTrackingReport(`${H}harbour-21,"1,2",1,1,£1.00\n`).ok, false);
  const fine = readAmazonTrackingReport(`${H}harbour-21,"1,204",1,1,"£1,234.56"\nOthers,1,0,0,(£1.50)\n`);
  assert.ok(fine.ok && fine.report.rows[0]!.clicks === 1204 && fine.report.knownEarningsMinor === 123306);
  const brand = { id: '00000000-0000-4000-8000-000000000001', name: 'Harbour' } as Brand, shell = { csrf: 'c', brand } as never;
  const card = (text: string, trackingId: string | null) => { const rep = readAmazonTrackingReport(text); assert.ok(rep.ok); const { rows, ...summary } = rep.report;
    return visible(reportsCard(shell, brand, { opened: true, reports: [{ id: 'r1', programme: 'amazon_uk', source: 'x', reportStart: '2026-10-01', reportEnd: '2026-10-31', currency: 'GBP', summary, rowCount: rows.length, createdAt: '2026-11-03T09:00:00Z' }],
      linkedArticles: 1, commandId: 'c', thisMonth: '2026-10', trackingId, rows: new Map([['r1', rows]]) })); };
  // Only other people's tracking IDs: never presented as this business's earnings.
  const others = card(`${H}othershop-21,9000,300,290,£812.00\nthirdshop-21,10,1,1,£2.00\n`, 'harbour-21');
  assert.match(others, /Your tracking ID harbour-21 is not in this file\. All tracking IDs in this file: Clicks counted by Amazon 9,010 · Earnings £814\.00/);
  // One hidden earnings cell: not a partial sum.
  assert.match(card(`${H}harbour-21,412,9,8,hidden\nsecond-21,5,1,1,£2.00\n`, 'harbour-21'), /Your tracking ID harbour-21 : Clicks counted by Amazon 412 · Earnings Not shown by Amazon/);
  assert.match(card(`${H}harbour-21,412,9,8,hidden\nsecond-21,5,1,1,£2.00\n`, null), /All tracking IDs in this file: Clicks counted by Amazon 417 · Earnings Not shown by Amazon/);
});

test('N5 and N6: a month that has not started is refused, the same figures for another month need the owner to say so, and only Amazon UK tracking IDs are kept', async () => {
  const s = await setup();
  const svc = service(s.engine, s.aff), id = who(s.brand.id), base = `/portal/seo-blog/b/${s.brand.id}`;
  const file = 'Tracking ID,Clicks,Ordered Items,Shipped Items,Earnings\nharbour-21,412,9,8,£23.40\nOthers,3,0,0,£0.50\n';
  const up = (month: string, data = file, extra: [string, string][] = []) => call(svc, id, 'POST', `${base}/results/report`, { multipart: { fields: [['commandId', randomUUID()], ['month', month], ...extra], file: { name: 's.csv', data } } });
  let r = await up('2099-12');
  assert.equal(r.isError, true); assert.match(r.notice, /Choose this month or an earlier one/);
  r = await up('2026-10');
  assert.equal(r.isError, false, r.notice);
  r = await up('2026-09');
  assert.equal(r.isError, true); assert.match(r.notice, /exactly the same figures as Amazon's report for October 2026/);
  assert.match((await call(svc, id, 'GET', `${base}/results`)).body, /name="sameFiguresConfirmed"/);
  r = await up('2026-09', file, [['sameFiguresConfirmed', '1']]);
  assert.equal(r.isError, false, r.notice);
  assert.equal(s.aff.reports_.length, 2);
  for (const bad of ["'=1", '＝1+1', 'a=1', 'DDE("cmd")', 'x​y', 'shop-20']) {
    r = await up('2026-08', `Tracking ID,Earnings\n"${bad.replace(/"/g, '""')}",£1.00\n`);
    assert.equal(r.isError, true, bad); assert.match(r.notice, /not one Amazon would make/);
  }
  const ok = readAmazonTrackingReport('Tracking ID,Earnings\nmy-shop-21,£1.00\nOthers,£0.10\n');
  assert.ok(ok.ok && reportTrackingIdProblem(ok.report) === null);
});

// ─── S7, S11, N2, N3, N8 ─────────────────────────────────────────────────────

test('S7: a product name can never change which sentence the owner is shown', () => {
  for (const name of ['OpenAI mug', 'API token case', 'GPT-4 guide book', 'Anthropic principle book', 'Claude Monet print', 'model railway set', 'Tesla “Model” 3 holder']) {
    const sentence = PRODUCT_MESSAGES.needsFreshLink(name);
    assert.equal(ownerWords(sentence), sentence, name);
    assert.equal(noticeWords(sentence), sentence, name);
    assert.match(sentence, /^The link for “[^”]+” was made with a different tracking ID\./);
  }
  const issues = affiliateIssues({ title: 't', seoTitle: 't', metaDescription: 'd', excerpt: 'e', image: { alt: '' }, intro: '', conclusion: '', faqs: [], sections: [{ id: 's', heading: 'OpenAI mug', body: 'I have used it.' }],
    affiliate: { programme: 'amazon_uk', disclosureVersion: 'x', registeredSite: SITE, links: [{ productId: 'p', revision: 1, name: 'OpenAI mug', url: 'https://www.amazon.co.uk/dp/B0TORCH001?tag=harbour-21', sectionId: 's', ownerUsed: false }] } }, SITE);
  for (const i of issues) assert.equal(ownerWords(i.message), i.message, i.message);
});

test('S11: rewriting one part of a product article gives the writer the product rules and keeps the product\'s heading', async () => {
  const s = await setup();
  const { article, version } = await writeOne(s);
  const sec = version.body.sections[0]!;
  const next = await s.engine.regenerateSection(OWNER, s.brand.id, article.id, version.id, sec.id, 'Say what it costs and how many stars it has.');
  const prompt = s.prompts.filter((p) => p.stage === 'SEO_BLOG_SECTION').at(-1)!;
  assert.match(prompt.system, /Never state a price/);
  assert.match(prompt.system, /keep its heading exactly "Wind-up torch"/);
  assert.match(prompt.user, /<products>/);
  assert.equal(next.body.sections[0]!.heading, 'Wind-up torch');
  assert.equal(next.body.affiliate!.links.length, 3);
});

test('N2: the portal\'s article page, its preview and the HTML copy show product links as words only; the website keeps live links', async () => {
  const s = await setup();
  const { article, version } = await writeOne(s);
  const preview = await s.engine.preview(OWNER, s.brand.id, article.id);
  const copy = await s.engine.exportArticle(OWNER, s.brand.id, article.id, 'html');
  const page = await call(service(s.engine, s.aff), who(s.brand.id), 'GET', `/portal/seo-blog/b/${s.brand.id}/articles/${article.id}`);
  for (const [name, html] of [['preview', preview], ['HTML copy', copy.body], ['article page', /<article class="ap-read">[\s\S]*?<\/article>/.exec(page.body)![0]]] as const) {
    assert.doesNotMatch(html, /<a [^>]*href="https:\/\/www\.amazon\.co\.uk/, name);
    assert.match(html, /<strong>See Wind-up torch on Amazon<\/strong> \(paid link, live only on your website\)/, name);
    assert.match(html, /r72-disclosure/, name);
  }
  const fragment = renderArticleFragment({ body: version.body } as never, `${SITE}/x`);
  assert.match(fragment, /<a href="https:\/\/www\.amazon\.co\.uk\/dp\/B0TORCH001\?tag=harbour-21" rel="sponsored nofollow noopener" target="_blank">/);
});

test('N3: a part id sent twice in an edit never shows a product\'s link twice', async () => {
  const s = await setup();
  const { article, version } = await writeOne(s);
  const first = version.body.sections[0]!;
  const dup = await s.engine.editArticle(OWNER, s.brand.id, article.id, version.id, { sections: [first, { ...first, heading: 'Copy of the first part' }, ...version.body.sections.slice(1)] });
  assert.equal(new Set(dup.body.sections.map((x) => x.id)).size, dup.body.sections.length);
  const fragment = renderArticleFragment({ body: dup.body } as never, `${SITE}/x`);
  const url = dup.body.affiliate!.links.find((l) => l.sectionId === first.id)!.url;
  assert.equal(fragment.split(url).length - 1, 1);
  // And the renderer itself shows a shared id's link once.
  const shared = { ...version.body, sections: [first, { ...first, heading: 'Again' }, ...version.body.sections.slice(1)] };
  assert.equal(renderArticleFragment({ body: shared } as never, `${SITE}/x`).split(url).length - 1, 1);
});

test('N8: a product article\'s plan is not offered in Topics with "Generate selected articles"', async () => {
  const s = await setup();
  await writeOne(s);
  const svc = service(s.engine, s.aff);
  const topics = await call(svc, who(s.brand.id), 'GET', `/portal/seo-blog/b/${s.brand.id}/topics`);
  assert.equal(topics.status, 200);
  assert.doesNotMatch(topics.body, /What to keep for a power cut/);
  assert.doesNotMatch(topics.body, /Generate selected articles/);
});

// ─── Second review (review2-affiliate-fixes.md) ──────────────────────────────

test('S-b: honest sentences that only look like a price, rating, stock or testing claim are not caught; the real ones still are', () => {
  const honest = ['The cable is only 2.50 metres long.', 'Our shop is open from 10.30 to 4.00 on Saturdays.', 'Save 10% of your phone battery by dimming the screen.', 'It has a 4-star energy rating.',
    'Use 3 out of 5 settings for normal light.', 'Free returns are not something we can promise; check the shop.', 'We tested the smoke alarm button every month, as the fire service advises.',
    'I have reviewed the government advice on power cuts.', 'We checked the products against the manufacturer manuals.', 'The kettle holds only 1.70 litres, just 0.50 more than the old one.'];
  for (const sentence of honest) assert.deepEqual(textRuleBreaks(sentence), [], `should not be caught: ${sentence}`);
  const caught: [string, string][] = [['The price is now 19.99 for the pair.', 'price_stated'], ['Only 19.99 at the moment, a real bargain.', 'price_stated'], ['From 9.99 per pack.', 'price_stated'],
    ['Save 30% of the price this week.', 'price_stated'], ['Rated 4 out of 5 by buyers.', 'rating_or_stock'], ['It scores 4.5 out of 5 in reviews.', 'rating_or_stock'], ['4 out of 5 stars.', 'rating_or_stock'],
    ['It has a 4-star rating from buyers.', 'rating_or_stock'], ['Free returns on every order.', 'rating_or_stock'], ['We tested the products for a month.', 'untested_claim'],
    ['I reviewed them all.', 'untested_claim'], ['We tested 12 torches.', 'untested_claim'], ['We checked the products for a fortnight.', 'untested_claim'], ['We tested these in the garden.', 'untested_claim']];
  for (const [sentence, rule] of caught) assert.ok(textRuleBreaks(sentence).includes(rule as never), `should be caught as ${rule}: ${sentence}`);
  // A product named by a word of its name counts as "the product"; other things tested do not.
  const names = ['Wind-up torch', 'Battery radio'];
  for (const sentence of ['We tested the torch for a week.', 'I have checked the wind-up torches every winter.', 'We reviewed this little radio.']) assert.deepEqual(textRuleBreaks(sentence, names), ['untested_claim'], sentence);
  for (const sentence of ['We tested the smoke alarm button every month.', 'We checked the radio against the manufacturer manual.']) assert.deepEqual(textRuleBreaks(sentence, names), [], sentence);
});

test('S-b: through the engine, the product\'s own name in a testing claim is caught and an honest sentence passes the checks', async () => {
  const s = await setup();
  const { article, version } = await writeOne(s);
  const radio = version.body.sections.find((x) => x.heading === 'Battery radio')!;
  const edit = (v: ArticleVersion, sentence: string) => s.engine.editArticle(OWNER, s.brand.id, article.id, v.id, { sections: v.body.sections.map((x) => x.id === radio.id ? { ...x, body: `${filler} ${sentence}` } : x) });
  const v2 = await edit(version, 'We tested the radio for a week.');
  assert.ok((await critical(s, article.id)).some((i) => i.code === 'affiliate.untested_claim' && i.location === 'Section “Battery radio”'));
  const v3 = await edit(v2, 'We tested the smoke alarm button every month. Use 3 out of 5 settings. It has a 4-star energy rating. Free returns are not something we can promise.');
  assert.deepEqual(await critical(s, article.id), []);
  void v3;
});

const connectBay = (s: Setup) => s.engine.connectDestination(OWNER, s.brand.id, { type: 'content_api', label: 'Bay', credential: 'x'.repeat(40),
  config: { endpoint: 'https://bay.example/api/blog/publish', publicBaseUrl: 'https://bay.example' } });

test('P1: an article with product links goes only to the website registered with Amazon; another connected website is refused at scheduling and held at the gate, naming both', async () => {
  const s = await setup();
  const { article, version } = await writeOne(s);
  const harbour = await connectGithub(s);
  const bay = await connectBay(s);
  await s.engine.approve(OWNER, s.brand.id, article.id, version.id);
  // Choosing the other website is refused, plainly, naming both.
  const a = await art(s, article.id);
  await assert.rejects(s.engine.schedule(OWNER, s.brand.id, article.id, a.rowVersion, { localDate: '2026-11-03', localTime: '09:00', destinationId: bay.id }),
    (e: Error) => /can only go on harbour\.example/.test(e.message) && /set to go on bay\.example/.test(e.message));
  await assert.rejects(s.engine.approveAndSchedule(OWNER, s.brand.id, article.id, { versionId: version.id, when: { localDate: "2026-11-03", localTime: "09:00" }, destinationId: bay.id }), /can only go on harbour\.example/);
  // A schedule that reached the other website anyway (made before this rule, or by any other path) is held at the gate.
  const now = await art(s, article.id);
  await s.h.store.updateArticle({ ...now, schedule: { publishAtUtc: '2026-11-03T09:00:00.000Z', localDate: '2026-11-03', localTime: '09:00', timezone: 'Europe/London', destinationId: bay.id, setAt: s.h.clock.now(), setBy: OWNER.userId } });
  s.h.clock.set('2026-11-03T09:00:30.000Z');
  await s.worker.tick('w');
  const held = await art(s, article.id);
  assert.equal(held.delivery, 'none');
  assert.equal(held.hold?.reason, 'destination');
  assert.match(held.hold!.detail, /can only go on harbour\.example, the website saved with your Amazon UK details\. It was set to go on bay\.example\./);
  assert.equal(s.h.site.articles.size, 0, 'nothing reached bay.example');
  // The registered website takes it.
  await s.engine.hold(OWNER, s.brand.id, article.id, held.rowVersion, false);
  await scheduleAndRun(s, article.id, harbour, '10:00', '2026-11-04');
  assert.equal((await art(s, article.id)).delivery, 'published');
  assert.equal(linkedPages(s).length, 1);
});

test('P2: after a page fails its check, the same article with its product links removed is published over it; the alert says so in plain words, and linked articles stay paused', async () => {
  const s = await setup();
  const { article, version } = await writeOne(s);
  const dest = await connectGithub(s);
  await s.engine.approve(OWNER, s.brand.id, article.id, version.id);
  await scheduleAndRun(s, article.id, dest);
  let d = await s.engine.getArticle(OWNER, s.brand.id, article.id);
  assert.equal(d.publications[0]!.affiliateCheck?.state, 'passed');
  // The website strips the paid-link marking (as the Property Predator sanitiser does).
  const path = 'blog/what-to-keep-for-a-power-cut/index.html';
  s.h.github.files().set(path, s.h.github.files().get(path)!.replace(/ rel="sponsored nofollow noopener"/g, ' rel="noopener"'));
  await s.engine.reobservePublication(OWNER, s.brand.id, article.id, d.publications[0]!.id);
  d = await s.engine.getArticle(OWNER, s.brand.id, article.id);
  assert.equal(d.publications[0]!.affiliateCheck?.state, 'failed');
  // The alert: plain words, the way out the owner has alone, and what to ask a website person if they have one.
  const alert = (await s.engine.activity(OWNER, s.brand.id, 20)).find((x) => x.kind === 'affiliate.page_alert')!;
  assert.equal(alert.message, AFFILIATE_PAGE_ALERT);
  assert.match(AFFILIATE_PAGE_ALERT, /You can fix this page yourself: remove its product links .*then approve and publish it again\./);
  assert.match(AFFILIATE_PAGE_ALERT, /If someone looks after your website for you, you can ask them/);
  for (const text of [AFFILIATE_PAGE_ALERT, AFFILIATE_PAGE_BLOCK, AFFILIATE_PAGE_UNVERIFIED]) assert.doesNotMatch(text, /paid-link marking|whoever looks after/);
  const page = await call(service(s.engine, s.aff), who(s.brand.id), 'GET', `/portal/seo-blog/b/${s.brand.id}/articles/${article.id}`);
  assert.match(page.body, /You can fix this page yourself/);
  assert.doesNotMatch(visible(page.body), /paid-link marking/);
  // The way out: every product link removed, approved and published again on the same website.
  let v = d.version!;
  for (const l of version.body.affiliate!.links) v = await s.engine.removeAffiliateLink(OWNER, s.brand.id, article.id, v.id, l.productId);
  assert.equal(v.body.affiliate?.links.length ?? 0, 0);
  await s.engine.approve(OWNER, s.brand.id, article.id, v.id);
  await scheduleAndRun(s, article.id, dest, '09:00', '2026-11-04');
  const fixed = await art(s, article.id);
  assert.equal(fixed.hold, null, JSON.stringify(fixed.hold));
  assert.equal(fixed.delivery, 'published');
  assert.equal(fixed.publishedVersionId, v.id);
  assert.doesNotMatch(s.h.github.files().get(path)!, /amazon\.co\.uk\/dp\//, 'no unmarked product link left on the live page');
  // Articles that do carry product links are still paused for this website.
  await s.engine.requestProductArticle(OWNER, s.brand.id, { commandId: randomUUID(), kind: 'comparison', topic: 'Torch or radio for a power cut', productIds: s.aff.products_.slice(0, 2).map((p) => p.productId) });
  await s.worker.tick('w');
  const row = (await s.engine.listArticles(OWNER, s.brand.id)).find((r) => r.article.id !== article.id)!;
  const d0 = await s.engine.getArticle(OWNER, s.brand.id, row.article.id);
  const v2 = await s.engine.editArticle(OWNER, s.brand.id, row.article.id, d0.version!.id, { title: 'Torch or radio: which helps more when the lights go out', seoTitle: 'Torch or radio when the lights go out' });
  assert.ok(v2.body.affiliate?.links.length);
  await s.engine.approve(OWNER, s.brand.id, row.article.id, v2.id);
  await scheduleAndRun(s, row.article.id, dest, '10:00', '2026-11-05');
  const held = await art(s, row.article.id);
  assert.deepEqual({ delivery: held.delivery, reason: held.hold?.reason, detail: held.hold?.detail }, { delivery: 'none', reason: 'destination', detail: AFFILIATE_PAGE_BLOCK });
});

test('S-a: approvals are taken back before the new tracking ID is saved; a lost second step, a replayed form or a stale form whose details are already saved still takes them back, without "changed somewhere else"', async () => {
  const svcFor = (s: Setup) => service(s.engine, s.aff);
  const form = (revision: string): [string, string][] => [['commandId', randomUUID()], ['revision', revision], ['trackingId', 'corrected-21'], ['registeredSite', 'harbour.example'], ['siteListed', '1'], ['accountMine', '1']];
  async function approvedScheduled() {
    const s = await setup();
    const w = await writeOne(s);
    const dest = await connectGithub(s);
    await s.engine.approve(OWNER, s.brand.id, w.article.id, w.version.id);
    const a = await art(s, w.article.id);
    await s.engine.schedule(OWNER, s.brand.id, w.article.id, a.rowVersion, { localDate: '2026-11-03', localTime: '09:00', destinationId: dest.id });
    return { s, ...w };
  }
  // (1) The database connection is lost right after the details are saved: the approval is already gone.
  {
    const { s, article } = await approvedScheduled();
    const save = s.aff.products.saveSettings.bind(s.aff.products), real = s.engine.affiliateDetailsChanged.bind(s.engine);
    let saved = false, boom = true;
    (s.aff.products as { saveSettings: unknown }).saveSettings = async (a: never) => { const r = await save(a); saved = true; return r; };
    s.engine.affiliateDetailsChanged = async (...a: Parameters<typeof real>) => { if (saved && boom) { boom = false; throw new Error('database connection lost'); } return real(...a); };
    const f = form('1');
    await call(svcFor(s), who(s.brand.id), 'POST', `/portal/seo-blog/b/${s.brand.id}/affiliate/settings`, { form: f }).catch(() => null);
    assert.equal(s.aff.settings_!.trackingId, 'corrected-21');
    assert.equal((await art(s, article.id)).approval, null, 'taken back before the save, so a lost second step leaves nothing approved with the old link');
    // The same form sent again: saved, not "changed somewhere else".
    const again = await call(svcFor(s), who(s.brand.id), 'POST', `/portal/seo-blog/b/${s.brand.id}/affiliate/settings`, { form: f });
    assert.equal(again.isError, false, again.notice);
    assert.doesNotMatch(again.notice, /somewhere else/);
    assert.match(again.notice, /Your Amazon UK details are saved\. Links use your tracking ID “corrected-21”\./);
    s.h.clock.set('2026-11-03T09:00:30.000Z');
    await s.worker.tick('w');
    assert.equal((await art(s, article.id)).hold?.reason, 'missing_approval');
    assert.deepEqual(linkedPages(s), []);
  }
  // (2) The save went through but its answer was lost, and the article was approved again meanwhile: the stale form
  // (stored ID already equals the typed one) still takes the approval back and says the details are saved.
  {
    const { s, article } = await approvedScheduled();
    await s.aff.products.saveSettings({ workspaceId: s.brand.id, programme: 'amazon_uk', expectedRevision: 1, trackingId: 'corrected-21', registeredSite: SITE, siteListedConfirmed: true, accountConfirmed: true });
    assert.ok((await art(s, article.id)).approval);
    const r = await call(svcFor(s), who(s.brand.id), 'POST', `/portal/seo-blog/b/${s.brand.id}/affiliate/settings`, { form: form('1') });
    assert.equal(r.isError, false, r.notice);
    assert.doesNotMatch(r.notice, /somewhere else/);
    assert.match(r.notice, /1 approved article with product links now waits for your approval again\./);
    assert.equal((await art(s, article.id)).approval, null);
    // A genuinely different save in between is still refused as changed elsewhere.
    const other = await call(svcFor(s), who(s.brand.id), 'POST', `/portal/seo-blog/b/${s.brand.id}/affiliate/settings`, { form: [['commandId', randomUUID()], ['revision', '1'], ['trackingId', 'third-21'], ['registeredSite', 'harbour.example'], ['siteListed', '1'], ['accountMine', '1']] });
    assert.equal(other.isError, true);
    assert.equal(s.aff.settings_!.trackingId, 'corrected-21');
  }
  // (3) Retiring a product: taken back first; a retire whose product is already retired (a resent or stale form) still takes it back.
  {
    const { s, article, products } = await approvedScheduled();
    const retire = s.aff.products.retire.bind(s.aff.products), real = s.engine.affiliateDetailsChanged.bind(s.engine);
    let retired = false, boom = true;
    (s.aff.products as { retire: unknown }).retire = async (a: never) => { const r = await retire(a); retired = true; return r; };
    s.engine.affiliateDetailsChanged = async (...a: Parameters<typeof real>) => { if (retired && boom) { boom = false; throw new Error('database connection lost'); } return real(...a); };
    const path = `/portal/seo-blog/b/${s.brand.id}/products/${products[0]!.productId}/retire`, f: [string, string][] = [['commandId', randomUUID()], ['revision', '1']];
    await call(svcFor(s), who(s.brand.id), 'POST', path, { form: f }).catch(() => null);
    assert.equal(s.aff.products_[0]!.status, 'retired');
    assert.equal((await art(s, article.id)).approval, null);
    // Approved again meanwhile (as a stale page might), then the same form again.
    const a = await art(s, article.id);
    await s.h.store.updateArticle({ ...a, approval: { versionId: a.currentVersionId!, contentSha: (await s.h.store.getVersion(s.brand.id, a.currentVersionId!))!.contentSha, approvedAt: s.h.clock.now(), approvedBy: OWNER.userId } as never });
    const again = await call(svcFor(s), who(s.brand.id), 'POST', path, { form: f });
    assert.equal(again.isError, false, again.notice);
    assert.doesNotMatch(again.notice, /somewhere else/);
    assert.match(again.notice, /You have stopped using that product\./);
    assert.equal((await art(s, article.id)).approval, null);
  }
});

test('P1: after the Amazon website is changed, the article\'s old links count as changed, so it cannot be approved for the old website again', async () => {
  const s = await setup();
  const { article, version } = await writeOne(s);
  await connectGithub(s);
  const bay = await connectBay(s);
  await s.engine.approve(OWNER, s.brand.id, article.id, version.id);
  const r = await call(service(s.engine, s.aff), who(s.brand.id), 'POST', `/portal/seo-blog/b/${s.brand.id}/affiliate/settings`, { form: [['commandId', randomUUID()], ['revision', '1'], ['trackingId', 'harbour-21'], ['registeredSite', 'bay.example'], ['siteListed', '1'], ['accountMine', '1']] });
  assert.equal(r.isError, false, r.notice);
  assert.equal((await art(s, article.id)).approval, null, 'a new website takes the approval back');
  await assert.rejects(s.engine.approve(OWNER, s.brand.id, article.id, version.id), /Update the links/);
  const page = await call(service(s.engine, s.aff), who(s.brand.id), 'GET', `/portal/seo-blog/b/${s.brand.id}/articles/${article.id}`);
  assert.match(page.body, /Update the links/);
  const updated = await s.engine.refreshAffiliateLinks(OWNER, s.brand.id, article.id, version.id);
  assert.equal(updated.body.affiliate!.registeredSite, 'https://bay.example');
  // The business's own website is still harbour.example, so the existing check refuses the links until the two agree.
  assert.ok((await critical(s, article.id)).some((i) => i.code === 'affiliate.site_mismatch'));
  await assert.rejects(s.engine.approve(OWNER, s.brand.id, article.id, updated.id), /critical issues/);
  void bay;
});
