/**
 * Affiliate Studio, slice 1, release 2: the screens and product articles, behind AFFILIATE_STUDIO and the new look.
 * The stores are in-memory doubles with the real store's rules (PgAffiliateProductStore.prepare); no database, no
 * Amazon, no paid call. With the switch off, every path answers as before.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { SeoBlogEngine } from '../src/seo-blog/engine.js';
import { handleSeoBlog } from '../src/portal/seo-blog-router.js';
import { portalCsrfToken } from '../src/portal/session.js';
import type { PortalSeoBlogService } from '../src/portal/seo-blog-service.js';
import type { PortalSessionIdentity } from '../src/portal/auth-service.js';
import { affiliateReader, affiliateStudioEnabled, type AffiliateStores } from '../src/portal/affiliate-service.js';
import { PgAffiliateProductStore, NOT_OPENED_YET, refused, type AffiliateProduct, type AffiliateResult, type ProgrammeSettings } from '../src/affiliate/product-store.js';
import { readAmazonTrackingReport } from '../src/affiliate/amazon-tracking-report.js';
import { cleanDisplay, productSnapshot } from '../src/affiliate/article.js';
import { programmeFor } from '../src/affiliate/programmes.js';
import { renderArticleFragment } from '../src/seo-blog/publishers/content-api.js';
import type { Brand } from '../src/seo-blog/types.js';
import { harness, OWNER, seedBrandSite, type Harness } from './seo-blog-fixtures.js';

delete process.env.CONTENT_AREA_PREVIEW;

const SECRET = 's'.repeat(48);
const SITE = 'https://harbour.example';
const ASIN = ['B0TORCH001', 'B0RADIO002', 'B0WATER003', 'B0STOVE004'];
const BANNED = /dataforseo|anthropic|claude|openai|\bgpt\b|\bmodel\b|method pack|supplier|\bAPI\b|revision|sha256|asin/i;

/** In-memory stores with the real store's link and text rules. */
class FakeAffiliate implements AffiliateStores {
  products_: AffiliateProduct[] = [];
  settings_: ProgrammeSettings | null = null;
  reports_: { id: string; month: string; text: string; createdAt: string }[] = [];
  closed = false;
  constructor(readonly workspaceId: string) {}
  private gate<T>(v: T): AffiliateResult<T> { return this.closed ? NOT_OPENED_YET : { ok: true, value: v }; }
  readonly products = {
    list: async () => this.gate(this.products_.map((p) => ({ ...p }))),
    get: async (_w: string, id: string) => this.gate(this.products_.find((p) => p.productId === id) ?? null),
    settings: async () => this.gate(this.settings_),
    saveSettings: async (a: { trackingId: string; registeredSite: string; expectedRevision: number; siteListedConfirmed: boolean; accountConfirmed: boolean }) => {
      if (this.closed) return NOT_OPENED_YET;
      if (!a.siteListedConfirmed || !a.accountConfirmed || !programmeFor('amazon_uk')!.validateTrackingId(a.trackingId).ok) return refused('invalid');
      if ((this.settings_?.revision ?? 0) !== a.expectedRevision) return refused('stale');
      const site = /^https:\/\//.test(a.registeredSite) ? a.registeredSite : `https://${a.registeredSite}`;
      this.settings_ = { programme: 'amazon_uk', revision: a.expectedRevision + 1, trackingId: a.trackingId, registeredSite: site, siteListedConfirmed: true, accountConfirmed: true, createdAt: '2026-11-16T10:00:00.000Z' };
      return { ok: true as const, value: { replayed: false, revision: this.settings_.revision } };
    },
    add: async (a: { details: Parameters<typeof PgAffiliateProductStore.prepare>[0]; productId?: string }) => {
      if (this.closed) return NOT_OPENED_YET;
      if (!this.settings_) return refused('settings_required');
      const prepared = PgAffiliateProductStore.prepare(a.details, this.settings_.trackingId);
      if (!prepared.ok) return refused('link', prepared.reason);
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
    list: async () => this.gate(this.reports_.map((r) => { const rep = readAmazonTrackingReport(r.text); if (!rep.ok) throw new Error('bad'); const { rows: _rows, ...summary } = rep.report;
      return { id: r.id, programme: 'amazon_uk' as const, source: 'user_uploaded_amazon_tracking_id_summary', reportStart: `${r.month}-01`, reportEnd: `${r.month}-28`, currency: 'GBP' as const, summary, rowCount: rep.report.rows.length, createdAt: r.createdAt }; })),
    get: async (_w: string, id: string) => { const r = this.reports_.find((x) => x.id === id); const rep = r ? readAmazonTrackingReport(r.text) : null;
      return this.gate(r && rep?.ok ? { id: r.id, programme: 'amazon_uk' as const, reportStart: `${r.month}-01`, reportEnd: `${r.month}-28`, currency: 'GBP' as const, payload: rep.report, createdAt: r.createdAt } : null); },
    save: async (a: { month: string; originalText: string }) => {
      const rep = readAmazonTrackingReport(a.originalText);
      if (!rep.ok) return refused('report_unreadable', rep.reason);
      const id = randomUUID(); this.reports_.push({ id, month: a.month, text: a.originalText, createdAt: '2026-11-03T09:00:00.000Z' });
      return { ok: true as const, value: { replayed: false, id } };
    },
  } as unknown as AffiliateStores['reports'];
}

async function readyBrand(h: Harness): Promise<Brand> {
  seedBrandSite(h.web, SITE, 'deposits');
  const { brand } = await h.engine.createBrand(OWNER, { commandId: randomUUID(), name: 'Harbour Lettings', website: SITE });
  await h.engine.uploadKnowledge(OWNER, brand.id, { category: 'product_facts', title: 'Plans', filename: 'plans.txt', bytes: Buffer.from('Harbour Lettings Compliance Plan costs £49 per month.') });
  const b = await h.engine.getBrand(OWNER, brand.id);
  await h.engine.updateSettings(OWNER, brand.id, b.rowVersion, { budgets: { modelTokensPerMonth: 2_000_000, searchCallsPerMonth: 200, imagesPerMonth: 0 } });
  const profile = await h.engine.extractBrandProfile(OWNER, brand.id);
  await h.engine.confirmProfile(OWNER, brand.id, profile.version);
  return h.engine.getBrand(OWNER, brand.id);
}

const filler = 'It is small, simple to keep in a cupboard and easy for anyone in the family to use when the lights go out at home.';
/** A writer that answers a product article with one part per product name (from the products data it was given). */
function productWriter(h: Harness, extra: (names: string[]) => Record<string, unknown> = () => ({})) {
  const prompts: string[] = [];
  const inner = h.llm.complete.bind(h.llm);
  h.llm.complete = async (req) => {
    prompts.push(`${req.system ?? ''}\n${req.messages[0]!.content}`);
    const products = /<products>\n([\s\S]*?)\n<\/products>/.exec(req.messages[0]!.content);
    if (!products) return inner(req);
    const names = (JSON.parse(products[1]!) as { products: { name: string }[] }).products.map((p) => p.name);
    h.llm.articleOverride = (base) => ({ ...base, title: 'What to keep for a power cut', sections: names.map((n) => ({ heading: n, body: `${filler} ${filler}` })), ...extra(names) });
    try { return await inner(req); } finally { h.llm.articleOverride = null; }
  };
  return prompts;
}

async function setup(o: { tracking?: string } = {}) {
  const h = harness();
  const brand = await readyBrand(h);
  const aff = new FakeAffiliate(brand.id);
  await aff.products.saveSettings({ workspaceId: brand.id, programme: 'amazon_uk', expectedRevision: 0, trackingId: o.tracking ?? 'harbour-21', registeredSite: SITE, siteListedConfirmed: true, accountConfirmed: true });
  for (const [i, name] of ['Wind-up torch', 'Battery radio', 'Water carrier'].entries()) {
    await aff.products.add({ workspaceId: brand.id, details: { programme: 'amazon_uk', link: `https://www.amazon.co.uk/Thing/dp/${ASIN[i]}?ref=x&tag=harbour-21`, productName: name, notes: i === 0 ? 'We keep two by the door.' : null, ownerUsed: i === 0 } });
  }
  const engine = new SeoBlogEngine({ store: h.store, llm: h.llm, search: h.search, transport: h.web, publishers: new Map(), vault: h.vault, now: h.clock.now, batchLimit: 20, affiliate: affiliateReader(aff) });
  const prompts = productWriter(h);
  return { h, brand, aff, engine, prompts };
}

async function writeOne(s: Awaited<ReturnType<typeof setup>>) {
  const products = (await s.aff.products.list(s.brand.id) as { ok: true; value: AffiliateProduct[] }).value;
  await s.engine.requestProductArticle(OWNER, s.brand.id, { commandId: randomUUID(), kind: 'shopping_list', topic: 'What to keep for a power cut', productIds: products.map((p) => p.productId) });
  await s.engine.tick('w');
  const row = (await s.engine.listArticles(OWNER, s.brand.id))[0]!;
  const detail = await s.engine.getArticle(OWNER, s.brand.id, row.article.id);
  return { article: detail.article, version: detail.version!, products };
}

// ─── Before any route used them ──────────────────────────────────────────────

test('the report reader no longer hangs on a small hostile file (review 0158, should-fix 2)', () => {
  for (const text of ['x"'.repeat(200_000), `${' '.repeat(30_000)}"`.repeat(4), `Tracking ID,Earnings\n${'a"'.repeat(150_000)}`]) {
    const t = performance.now();
    const r = readAmazonTrackingReport(text);
    assert.ok(performance.now() - t < 1500, `${(performance.now() - t).toFixed(0)} ms`);
    assert.equal(r.ok, false);
  }
  // Quoted cells still read as before.
  const ok = readAmazonTrackingReport('Tracking ID,Clicks,Ordered Items,Shipped Items,Earnings\n"harbour-21","1,204",9,8,"£23.40"\nOthers,3,0,0,£0.50\n');
  assert.ok(ok.ok && ok.report.rows[0]!.clicks === 1204 && ok.report.knownEarningsMinor === 2390, JSON.stringify(ok));
});

test('names and notes are cleaned of invisible and direction-changing characters, and every link is checked against the saved tracking ID', async () => {
  assert.equal(cleanDisplay('Torch\u202Egnirts\u2060 <img src=x>'), 'Torch gnirts img src=x');
  const s = await setup();
  const products = (await s.aff.products.list(s.brand.id) as { ok: true; value: AffiliateProduct[] }).value;
  // The tracking ID changes: old links are no longer usable until added again (review note 1).
  await s.aff.products.saveSettings({ workspaceId: s.brand.id, programme: 'amazon_uk', expectedRevision: 1, trackingId: 'newtag-21', registeredSite: SITE, siteListedConfirmed: true, accountConfirmed: true });
  const settings = s.aff.settings_!;
  const snap = productSnapshot({ kind: 'comparison', topic: 'Torches', productIds: products.slice(0, 2).map((p) => p.productId) }, products, settings);
  assert.equal(snap.ok, false);
  assert.match((snap as { reason: string }).reason, /different tracking ID/);
  assert.match((productSnapshot({ kind: 'comparison', topic: 'Torches', productIds: [products[0]!.productId] }, products, settings) as { reason: string }).reason, /takes 2 to 4 products/);
  assert.match((productSnapshot({ kind: 'comparison', topic: 'Torches', productIds: [randomUUID(), randomUUID()] }, products, settings) as { reason: string }).reason, /no longer available/);
});

// ─── Product articles through the existing engine ────────────────────────────

test('a product article: one brief composed in code, written by the existing engine, links and disclosure added by code, never in the prose', async () => {
  const s = await setup();
  const { article, version, products } = await writeOne(s);
  assert.equal(article.requiresApproval, true, 'always waits for approval');
  const a = version.body.affiliate!;
  assert.equal(a.links.length, 3);
  for (const [i, p] of products.entries()) {
    const link = a.links.find((l) => l.productId === p.productId)!;
    assert.equal(link.url, `https://www.amazon.co.uk/dp/${ASIN[i]}?tag=harbour-21`);
    assert.equal(version.body.sections.find((x) => x.id === link.sectionId)!.heading, p.productName);
  }
  const prose = JSON.stringify({ ...version.body, affiliate: undefined, citations: undefined });
  assert.doesNotMatch(prose, /amazon\.co\.uk/i, 'no link in the prose');
  // The writer saw names and the owner's words only, with the rules; never a link.
  const productPrompt = s.prompts.find((p) => p.includes('<products>'))!;
  assert.match(productPrompt, /We keep two by the door/);
  assert.match(productPrompt, /Never state a price/);
  assert.doesNotMatch(productPrompt.split('<products>')[1]!, /amazon\.co\.uk|tag=/);
  // No social drafts for a product article.
  assert.ok(!s.h.llm.calls.includes('SEO_BLOG_SOCIAL'));
  // Every renderer: the disclosure first, each product's button after its part, the stored address exactly.
  const page = await s.engine.preview(OWNER, s.brand.id, article.id);
  const fragment = renderArticleFragment({ body: version.body } as never, `${SITE}/x`);
  for (const html of [page, fragment]) {
    assert.match(html, /<p class="r72-disclosure"><strong>Ad\.<\/strong> This article contains affiliate links\.[^<]*As an Amazon Associate I earn from qualifying purchases\.<\/p>/);
    for (const l of a.links) assert.ok(html.includes(`<a href="${l.url}" rel="sponsored nofollow noopener" target="_blank">`), l.url);
    assert.match(html, /See Wind-up torch on Amazon<\/a> \(paid link\)/);
  }
  assert.ok(fragment.indexOf('r72-disclosure') < fragment.indexOf('<h2>'), 'the disclosure comes first');
  // Exported text never carries the links.
  const md = await s.engine.exportArticle(OWNER, s.brand.id, article.id, 'markdown');
  assert.doesNotMatch(md.body, /amazon\.co\.uk/);
  assert.match(md.body, /Product links are not included in this copy\./);
});

test('the links survive edits as code-held data: a sent "affiliate" is ignored, a deleted part takes its link, the last removal takes the disclosure', async () => {
  const s = await setup();
  const { article, version } = await writeOne(s);
  const tampered = await s.engine.editArticle(OWNER, s.brand.id, article.id, version.id, { intro: `${version.body.intro} More.`, affiliate: { programme: 'amazon_uk', disclosureVersion: 'x', registeredSite: SITE, links: [{ productId: 'x', revision: 1, name: 'Evil', url: 'https://evil.example', sectionId: version.body.sections[0]!.id, ownerUsed: true }] } } as never);
  assert.deepEqual(tampered.body.affiliate, version.body.affiliate);
  const fewer = await s.engine.editArticle(OWNER, s.brand.id, article.id, tampered.id, { sections: tampered.body.sections.slice(1) });
  assert.equal(fewer.body.affiliate!.links.length, 2);
  let v = fewer;
  for (const l of fewer.body.affiliate!.links) v = await s.engine.removeAffiliateLink(OWNER, s.brand.id, article.id, v.id, l.productId);
  assert.equal(v.body.affiliate!.links.length, 0);
  assert.doesNotMatch(await s.engine.preview(OWNER, s.brand.id, article.id), /r72-disclosure/);
});

test('approval: links must match the current products; a retired product blocks until the links are updated; the approval flag cannot be switched off', async () => {
  const s = await setup();
  const { article, version, products } = await writeOne(s);
  await assert.rejects(s.engine.setRequiresApproval(OWNER, s.brand.id, article.id, article.rowVersion, false), /always waits for your approval/);
  // Without a way to check the products (the switch off), it cannot be approved.
  const blind = new SeoBlogEngine({ store: s.h.store, llm: s.h.llm, search: s.h.search, transport: s.h.web, publishers: new Map(), vault: s.h.vault, now: s.h.clock.now });
  await assert.rejects(blind.approve(OWNER, s.brand.id, article.id, version.id), /could not be checked/);
  await s.aff.products.retire({ workspaceId: s.brand.id, productId: products[1]!.productId, expectedRevision: 1 });
  await assert.rejects(s.engine.approve(OWNER, s.brand.id, article.id, version.id), /Update the links/);
  const updated = await s.engine.refreshAffiliateLinks(OWNER, s.brand.id, article.id, version.id);
  assert.equal(updated.body.affiliate!.links.length, 2);
  const approved = await s.engine.approve(OWNER, s.brand.id, article.id, updated.id);
  assert.equal(approved.approval?.versionId, updated.id);
});

test('critical checks: a price, a rating, stock, a testing claim, first-hand words without use, or another website each block approval', async () => {
  const s = await setup();
  const { article, version } = await writeOne(s);
  const torch = version.body.sections.find((x) => x.heading === 'Battery radio')!;
  const cases: [string, string][] = [['It costs £19.99 today.', 'affiliate.price_stated'], ['It has 4.5 out of 5 stars from 2,000 reviews.', 'affiliate.rating_or_stock'],
    ['It is in stock with free delivery.', 'affiliate.rating_or_stock'], ['We tested it for a week.', 'affiliate.untested_claim'], ['I have used it every winter.', 'affiliate.untested_claim'],
    ['Buy it at amazon.co.uk now.', 'affiliate.raw_merchant_link']];
  let v = version;
  for (const [sentence, code] of cases) {
    v = await s.engine.editArticle(OWNER, s.brand.id, article.id, v.id, { sections: v.body.sections.map((x) => x.id === torch.id ? { ...x, body: `${filler} ${sentence}` } : x) });
    const a = await s.engine.getArticle(OWNER, s.brand.id, article.id);
    assert.ok(a.article.checks!.issues.some((i) => i.code === code && i.severity === 'critical'), `${sentence} -> ${code}`);
    await assert.rejects(s.engine.approve(OWNER, s.brand.id, article.id, v.id), /critical issues/);
  }
});

// ─── The screens, through the real router ────────────────────────────────────

function service(engine: SeoBlogEngine, aff: AffiliateStores | null): PortalSeoBlogService {
  // As composed in production: the stores belong to the session's own business.
  return { generation: 'live', research: 'live', social: 'unavailable', engineFor: () => engine, socialCallback: async () => null,
    ...(aff ? { affiliateFor: (identity: PortalSessionIdentity) => identity.workspaceId === aff.workspaceId ? aff : new FakeAffiliate(identity.workspaceId) } : {}) } as PortalSeoBlogService;
}
const who = (workspaceId: string): PortalSessionIdentity => ({ sessionToken: `token-${OWNER.userId}`, userId: OWNER.userId, workspaceId, userEmail: 'owner@example.test' });
async function call(svc: PortalSeoBlogService, id: PortalSessionIdentity, method: string, path: string, o: { form?: [string, string][]; multipart?: { fields: [string, string][]; file: { name: string; data: string } }; newLook?: boolean } = {}) {
  let body = '', type = '';
  const csrf = portalCsrfToken(SECRET, id.sessionToken);
  if (o.form) { body = new URLSearchParams([['_csrf', csrf], ...o.form]).toString(); type = 'application/x-www-form-urlencoded'; }
  if (o.multipart) {
    const b = 'XXBOUNDARY';
    body = [...[['_csrf', csrf], ...o.multipart.fields].map(([k, v]) => `--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`), `--${b}\r\nContent-Disposition: form-data; name="file"; filename="${o.multipart.file.name}"\r\nContent-Type: text/csv\r\n\r\n${o.multipart.file.data}\r\n--${b}--\r\n`].join('');
    type = `multipart/form-data; boundary=${b}`;
  }
  const req = new PassThrough() as unknown as IncomingMessage & PassThrough;
  Object.assign(req, { method, url: path, headers: { host: 'portal.example', ...(type ? { 'content-type': type, 'content-length': String(Buffer.byteLength(body)), origin: 'https://portal.example' } : {}), ...(o.newLook === false ? {} : { cookie: 'r72_content_look=new' }) } });
  (req as PassThrough).end(body);
  let status = 0; let headers: Record<string, string> = {}; let out = '';
  const res = { writeHead(s: number, h: Record<string, string>) { status = s; headers = h; return res; }, end(chunk?: string | Buffer) { if (chunk) out += chunk.toString(); } } as unknown as ServerResponse;
  await handleSeoBlog(req, res, new URL(path, 'https://portal.example'), { service: svc, identity: id, requestId: `r-${randomUUID()}`, sessionSecret: SECRET, vaultReady: true, contentAreaPreview: 'enabled' } as Parameters<typeof handleSeoBlog>[3]);
  const loc = headers.location ? new URL(headers.location, 'https://x') : null;
  const msg = loc ? (loc.searchParams.get('n') ?? loc.searchParams.get('e')) : null;
  return { status, headers, body: out, notice: msg ? Buffer.from(msg, 'base64url').toString().replace(/^[^|]*\|/, '') : '', isError: Boolean(loc?.searchParams.has('e')) };
}
const main = (html: string) => /<main id="ca-main"[\s\S]*<\/main>/.exec(html)?.[0] ?? html;
const visible = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('switch off (no affiliate composed) or the old look: every new path answers as before, and no page shows Products', async () => {
  assert.equal(affiliateStudioEnabled({}), false);
  assert.equal(affiliateStudioEnabled({ AFFILIATE_STUDIO: 'true' }), false);
  assert.equal(affiliateStudioEnabled({ AFFILIATE_STUDIO: 'enabled' }), true);
  const s = await setup();
  const off = service(s.engine, null), on = service(s.engine, s.aff);
  for (const path of ['products', 'products/write', `results/report/${randomUUID()}`]) {
    const before = await call(off, who(s.brand.id), 'GET', `/portal/seo-blog/b/${s.brand.id}/${path}`);
    assert.notEqual(before.status, 200, path);
    assert.equal((await call(on, who(s.brand.id), 'GET', `/portal/seo-blog/b/${s.brand.id}/${path}`, { newLook: false })).status, before.status, `${path} in the old look`);
  }
  for (const page of ['articles', 'results']) assert.doesNotMatch((await call(off, who(s.brand.id), 'GET', `/portal/seo-blog/b/${s.brand.id}/${page}`)).body, /af-pills|What Amazon reported/);
  const settingsOff = await call(off, who(s.brand.id), 'GET', `/portal/seo-blog/b/${s.brand.id}/publishing`);
  assert.doesNotMatch(settingsOff.body, /Amazon UK details/);
  const post = await call(off, who(s.brand.id), 'POST', `/portal/seo-blog/b/${s.brand.id}/products`, { form: [['link', 'https://www.amazon.co.uk/dp/B0TORCH001']] });
  assert.notEqual(post.status, 303);
});

test('Products inside Articles, Write, the details card in Settings and what Amazon reported in Results; plain, escaped, one main action', async () => {
  const h = harness();
  const brand = await readyBrand(h);
  const aff = new FakeAffiliate(brand.id);
  const engine = new SeoBlogEngine({ store: h.store, llm: h.llm, search: h.search, transport: h.web, publishers: new Map(), vault: h.vault, now: h.clock.now, batchLimit: 20, affiliate: affiliateReader(aff) });
  productWriter(h);
  const svc = service(engine, aff), id = who(brand.id), base = `/portal/seo-blog/b/${brand.id}`;
  // Articles carries the two pills.
  assert.match((await call(svc, id, 'GET', `${base}/articles`)).body, /<nav class="af-pills" aria-label="Articles and products"><a class="af-pill" href="[^"]+\/articles" aria-current="page">Articles<\/a><a class="af-pill" href="[^"]+\/products">Products<\/a><\/nav>/);
  let page = await call(svc, id, 'GET', `${base}/products`);
  assert.equal(page.status, 200);
  assert.match(page.body, /Which website will carry these links\?/, 'the first product asks for the details once');
  assert.match(page.body, /<span>Articles<\/span>/);
  // A short link is refused in one sentence.
  let r = await call(svc, id, 'POST', `${base}/products`, { form: [['link', 'https://amzn.to/abc'], ['registeredSite', 'harbour.example'], ['siteListed', '1'], ['accountMine', '1']] });
  assert.equal(r.isError, true); assert.match(r.notice, /Short links cannot be used/);
  // The first product: the tracking ID is read from the link; the details are saved with it.
  r = await call(svc, id, 'POST', `${base}/products`, { form: [['commandId', randomUUID()], ['link', 'https://www.amazon.co.uk/Wind-Up-Torch-Lantern/dp/B0TORCH001?tag=harbour-21&ref=x'], ['registeredSite', 'harbour.example'], ['siteListed', '1'], ['accountMine', '1'], ['ownerUsed', '1'], ['notes', 'We keep two.\u202E']] });
  assert.equal(r.isError, false, r.notice); assert.equal(r.notice, 'Product added.');
  assert.equal(aff.settings_!.trackingId, 'harbour-21');
  assert.equal(aff.products_[0]!.productName, 'Wind Up Torch Lantern', 'the name suggested from the address');
  for (const [i, n] of [[1, 'Battery radio'], [2, '<script>alert(1)</script> Water carrier\u202E']] as const) {
    r = await call(svc, id, 'POST', `${base}/products`, { form: [['commandId', randomUUID()], ['link', `https://www.amazon.co.uk/dp/${ASIN[i]}`], ['productName', n]] });
    assert.equal(r.isError, r.notice !== 'Product added.', r.notice);
  }
  page = await call(svc, id, 'GET', `${base}/products`);
  const m = main(page.body);
  assert.match(m, /<a class="ca-btn" data-primary href="[^"]+\/products\/write">Write an article<\/a>/);
  assert.equal((m.match(/data-primary/g) ?? []).length, 1, 'one main action');
  assert.doesNotMatch(m, /<script>alert|\u202E/);
  assert.doesNotMatch(visible(m), BANNED);
  assert.doesNotMatch(visible(m), /[–—]/);
  // Write: choose and request.
  const write = await call(svc, id, 'GET', `${base}/products/write`);
  assert.match(write.body, /Shopping list <span class="af-opt">\(3 to 15 products\)<\/span>/);
  const ids = aff.products_.filter((p) => p.status === 'active').map((p) => p.productId);
  r = await call(svc, id, 'POST', `${base}/products/write`, { form: [['commandId', randomUUID()], ['kind', 'comparison'], ['topic', 'Torch or radio?'], ...ids.slice(0, 1).map((x) => ['product', x] as [string, string])] });
  assert.equal(r.isError, true); assert.match(r.notice, /2 to 4 products/);
  r = await call(svc, id, 'POST', `${base}/products/write`, { form: [['commandId', randomUUID()], ['kind', 'comparison'], ['topic', 'Torch or radio?'], ...ids.slice(0, 2).map((x) => ['product', x] as [string, string])] });
  assert.equal(r.isError, false, r.notice); assert.match(r.notice, /wait for your approval/);
  await engine.tick('w');
  const [row] = await engine.listArticles(OWNER, brand.id);
  const art = await call(svc, id, 'GET', `${base}/articles/${row!.article.id}`);
  assert.match(art.body, /<details class="ap-fold" id="product-links"><summary><h2>Product links<\/h2><\/summary>/);
  assert.match(art.body, /Every link matches your products\./);
  assert.match(art.body, /Remove this link/);
  // Stop using one: the article page says so and offers one press to update.
  Object.assign(aff.products_[0]!, { status: 'retired' });
  const stale = await call(svc, id, 'GET', `${base}/articles/${row!.article.id}`);
  assert.match(stale.body, /You stopped using this product/); assert.match(stale.body, />Update the links<\/button>/);
  r = await call(svc, id, 'POST', `${base}/articles/${row!.article.id}/affiliate-refresh`, { form: [['versionId', row!.article.currentVersionId!]] });
  assert.equal(r.isError, false, r.notice);
  // Settings carries the details card; Results carries what Amazon reported.
  const settings = await call(svc, id, 'GET', `${base}/publishing`);
  assert.match(settings.body, /<section class="af-card" id="affiliate"[\s\S]*Links use your tracking ID <strong>harbour-21<\/strong> for <strong>harbour\.example<\/strong>/);
  r = await call(svc, id, 'POST', `${base}/affiliate/settings`, { form: [['revision', '1'], ['trackingId', 'bad'], ['registeredSite', 'harbour.example'], ['siteListed', '1'], ['accountMine', '1']] });
  assert.equal(r.isError, true); assert.match(r.notice, /ends in -21/);
  let results = await call(svc, id, 'GET', `${base}/results`);
  assert.match(results.body, /What Amazon reported/); assert.match(results.body, /No report yet\./);
  r = await call(svc, id, 'POST', `${base}/results/report`, { multipart: { fields: [['commandId', randomUUID()], ['month', '2026-10']], file: { name: 'summary.csv', data: 'Tracking ID,Clicks,Ordered Items,Shipped Items,Earnings\nharbour-21,412,9,8,£23.40\nOthers,3,0,0,£0.50\n' } } });
  assert.equal(r.isError, false, r.notice);
  const report = await call(svc, id, 'GET', r.headers.location!.split('?')[0]!);
  assert.match(report.body, /Amazon&#39;s report for October 2026|Amazon's report for October 2026/);
  assert.match(visible(report.body), /harbour-21 412 9 8 £23\.40 Not tied to a tracking ID 3 0 0 £0\.50/);
  results = await call(svc, id, 'GET', `${base}/results`);
  assert.match(visible(results.body), /Clicks counted by Amazon 415 · Earnings £23\.90/);
  assert.doesNotMatch(visible(main(results.body)), /rate|per article|conversion/i);
  // A damaged file is refused in one sentence.
  r = await call(svc, id, 'POST', `${base}/results/report`, { multipart: { fields: [['month', '2026-10']], file: { name: 'x.csv', data: 'hello' } } });
  assert.equal(r.isError, true);
});

test('only the session\'s own business: another business id answers 404, and "not opened yet" is a normal, plain state', async () => {
  const s = await setup();
  const svc = service(s.engine, s.aff);
  const other = randomUUID();
  const elsewhere = await call(svc, who(other), 'GET', `/portal/seo-blog/b/${s.brand.id}/products`);
  assert.notEqual(elsewhere.status, 200);
  s.aff.closed = true;
  const page = await call(svc, who(s.brand.id), 'GET', `/portal/seo-blog/b/${s.brand.id}/products`);
  assert.equal(page.status, 200);
  assert.match(page.body, /Products are not switched on for this business yet\. Nothing has been set up, and nothing else changes\./);
  assert.match((await call(svc, who(s.brand.id), 'GET', `/portal/seo-blog/b/${s.brand.id}/results`)).body, /Products are not switched on for this business yet/);
  await assert.rejects(s.engine.requestProductArticle(OWNER, s.brand.id, { commandId: randomUUID(), kind: 'comparison', topic: 'x y z', productIds: [] }), /not available/);
});
