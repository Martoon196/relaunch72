/**
 * Brand DNA from a website address (Milestone 2, slice 1) and the logo/colour proposal (slice 2).
 * Offline only: a fake public web and a scripted model. No network, model or database is touched.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  appearsIn, BRAND_PAGE_TEXT_LIMIT, brandDnaCard, brandDnaPayload, brandPageRank, cleanProvenance, conflictOffer, holdConflictedPrices, isBrandDnaJob, pageLabel, priceConflicts, settleConflict,
  strictProfileProblems, websiteDocumentId, websiteDocuments,
} from '../src/seo-blog/brand-dna.js';
import { loadPrompt } from '../src/stages/prompt.js';
import type { FetchTransport } from '../src/seo-blog/safe-fetch.js';
import { buildInventory } from '../src/seo-blog/inventory.js';
import { normaliseHexColour, parseHtmlPage } from '../src/seo-blog/html.js';
import { isProfileJob, profilePayload } from '../src/seo-blog/profile-jobs.js';
import { USAGE_ESTIMATES, WEBSITE_LOGO_MAX_BYTES } from '../src/seo-blog/engine.js';
import type { BrandProfile, InventoryPage, KnowledgeDocument } from '../src/seo-blog/types.js';
import { handleSeoBlog } from '../src/portal/seo-blog-router.js';
import { portalCsrfToken } from '../src/portal/session.js';
import type { PortalSeoBlogService } from '../src/portal/seo-blog-service.js';
import type { PortalSessionIdentity } from '../src/portal/auth-service.js';
import { CreativeStudioService } from '../src/creative-studio/service.js';
import { MemoryCreativeLibraryStore } from '../src/creative-studio/store.js';
import type { ArtworkRenderer } from '../src/creative-studio/renderer.js';
import { websiteLookProposal } from '../src/creative-studio/website-look.js';
import { harness, OWNER, STRANGER, type Harness } from './seo-blog-fixtures.js';
import { syntheticLogoPng } from './creative-studio-fixtures.js';

const SITE = 'https://quay.example';
const SECRET = 's'.repeat(48);
const HOME_WORDS = 'Quay Lettings helps private landlords in Kent stay compliant and let their homes with confidence. We explain the rules in plain English, remind you before each deadline and keep your paperwork in one tidy place so nothing is missed.';
const PRICING_WORDS = 'The Quay Compliance Plan costs £49 per month. It covers gas safety reminders, deposit protection checks and a yearly review call with a named adviser for every home you let.';
const ABOUT_WORDS = 'We help landlords in Kent. Our small team has managed rented homes across Medway and Maidstone for many years and still answers the phone ourselves every working day.';

function page(title: string, words: string, head = '', links = ''): string {
  return `<html><head><title>${title}</title>${head}</head><body><nav><a href="/">Home</a></nav><main><h1>${title}</h1><p>${words}</p>${links}</main></body></html>`;
}

function seedSite(h: Harness, options: { pricing?: string; home?: string; head?: string } = {}): void {
  h.web.set(`${SITE}/`, page('Quay Lettings', options.home ?? HOME_WORDS, options.head ?? '', '<a href="/pricing">Pricing</a><a href="/about">About</a><a href="/blog/a-very-long-post">Blog</a><a href="/login">Sign in</a>'));
  h.web.set(`${SITE}/pricing`, page('Pricing', options.pricing ?? PRICING_WORDS));
  h.web.set(`${SITE}/about`, page('About us', ABOUT_WORDS));
  h.web.set(`${SITE}/blog/a-very-long-post`, page('A long post', 'Post words. '.repeat(200)));
  h.web.set(`${SITE}/login`, page('Sign in', 'Sign in to your account here please now.'));
}

interface ModelDoc { id: string; title: string; text: string; page?: string }
type CardScript = (docs: ModelDoc[], attempt: number) => Record<string, unknown>;

/** A card that quotes its sources word for word, as the strict path requires. */
const honestCard: CardScript = (docs) => {
  const priced = docs.find((d) => /Quay Compliance Plan costs £\d+ per month/.test(d.text));
  const price = priced ? /Quay Compliance Plan costs (£\d+ per month)/.exec(priced.text)![1]! : null;
  const who = docs.find((d) => d.text.includes('private landlords in Kent'))!;
  const claim = docs.find((d) => d.text.includes('We help landlords in Kent'))!;
  return {
    summary: 'Quay Lettings helps private landlords in Kent stay compliant.', audiences: ['Private landlords in Kent'], positioning: 'Plain-English compliance help.',
    offers: priced ? [{ name: 'Quay Compliance Plan', description: 'Monthly compliance support', price, url: null, sourceDocumentId: priced.id }] : [],
    conversionPages: [], voice: { tone: ['plain', 'reassuring'], do: ['Explain rules simply'], dont: ['Jargon'], examples: [] },
    approvedClaims: ['We help landlords in Kent'], exclusions: ['Tax advice'], conflicts: [], missingFacts: ['A named author'],
    sources: [
      { field: 'audience', value: 'Private landlords in Kent', documentId: who.id, quote: 'private landlords in Kent' },
      { field: 'claim', value: 'We help landlords in Kent', documentId: claim.id, quote: 'We help landlords in Kent' },
    ],
  };
};

function useModel(h: Harness, script: CardScript): { seen: ModelDoc[][] } {
  const seen: ModelDoc[][] = [];
  h.llm.complete = async (req) => {
    assert.equal(req.meta?.stage, 'SEO_BLOG_PROFILE');
    h.llm.calls.push('SEO_BLOG_PROFILE');
    const block = /<knowledge_documents>\n([\s\S]*?)\n<\/knowledge_documents>/.exec(req.messages[0]!.content)!;
    const docs = JSON.parse(block[1]!) as ModelDoc[];
    seen.push(docs);
    return { text: JSON.stringify(script(docs, req.messages.length > 1 ? 2 : 1)), tokensIn: 1000, tokensOut: 800, stopReason: 'end_turn', model: 'scripted' };
  };
  return { seen };
}

async function newBrand(h: Harness, allowance = 1_000_000, name = 'Quay Lettings') {
  const { brand } = await h.engine.createBrand(OWNER, { commandId: randomUUID(), name, website: SITE });
  if (allowance > 0) await h.engine.updateSettings(OWNER, brand.id, brand.rowVersion, { budgets: { modelTokensPerMonth: allowance, searchCallsPerMonth: 0, imagesPerMonth: 0 } });
  return brand;
}
const work = async (h: Harness) => { for (let i = 0; i < 3; i++) await h.engine.tick(`worker-${i}`); };
const read = (h: Harness, brandId: string, extra: { readAgain?: boolean; website?: string } = {}) => h.engine.requestBrandDna(OWNER, brandId, { commandId: randomUUID(), ...extra });

async function proposedCard(options: { pricing?: string; document?: string } = {}) {
  const h = harness();
  seedSite(h, options);
  const model = useModel(h, honestCard);
  const brand = await newBrand(h);
  if (options.document) await h.engine.uploadKnowledge(OWNER, brand.id, { category: 'product_facts', title: 'Price list', pastedText: options.document });
  await read(h, brand.id);
  await work(h);
  return { h, brand, model, profile: (await h.engine.getProfile(OWNER, brand.id))! };
}

// ─── Pure rules ──────────────────────────────────────────────────────────────

test('page selection keeps the pages that describe the business and labels them in plain words', () => {
  assert.equal(brandPageRank(`${SITE}/`), 0);
  assert.equal(brandPageRank(`${SITE}/pricing`), 1);
  assert.equal(brandPageRank(`${SITE}/services/`), 2);
  assert.equal(brandPageRank(`${SITE}/about-us.html`), 3);
  assert.equal(brandPageRank(`${SITE}/faq`), 4);
  for (const other of ['/blog/a-very-long-post', '/login', '/privacy', '/guides/deposits/2024/part-one', '/pricing/archive/2019/old']) assert.equal(brandPageRank(SITE + other), null, other);
  assert.equal(pageLabel(`${SITE}/`), 'Home page');
  assert.equal(pageLabel(`${SITE}/pricing`), 'Pricing page');
  assert.equal(pageLabel(`${SITE}/about-us.html`), 'About us page');
});

test('a website page is one document for life: stable id, no new version when unchanged, version 2 when its words change', () => {
  const brandId = randomUUID(), now = '2026-11-12T10:00:00.000Z';
  const pages = (pricing: string): InventoryPage[] => [
    { url: `${SITE}/pricing`, canonical: null, title: 'Pricing', headings: [], excerpt: '', publishedAt: null, modifiedAt: null, fetchStatus: 'ok', httpStatus: 200, editorial: false, text: pricing },
    { url: `${SITE}/`, canonical: null, title: 'Home', headings: [], excerpt: '', publishedAt: null, modifiedAt: null, fetchStatus: 'ok', httpStatus: 200, editorial: false, text: HOME_WORDS },
    { url: `${SITE}/blog/post`, canonical: null, title: 'Post', headings: [], excerpt: '', publishedAt: null, modifiedAt: null, fetchStatus: 'ok', httpStatus: 200, editorial: true, text: 'Not a page that describes the business at all.' },
    { url: `${SITE}/contact`, canonical: null, title: null, headings: [], excerpt: '', publishedAt: null, modifiedAt: null, fetchStatus: 'http_error', httpStatus: 500, editorial: false },
  ];
  const first = websiteDocuments({ brandId, pages: pages(PRICING_WORDS), existing: [], now });
  assert.equal(first.documents.length, 2); assert.equal(first.pagesRead, 2); assert.ok(first.words > 60);
  assert.deepEqual(first.documents.map((d) => d.title), ['Home page', 'Pricing page'], 'the home page is read first');
  const pricing = first.documents[1]!;
  assert.equal(pricing.id, websiteDocumentId(brandId, `${SITE}/pricing`)); assert.match(pricing.id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(pricing.id, websiteDocumentId(randomUUID(), `${SITE}/pricing`), 'another brand never shares a document id');
  assert.equal(pricing.version, 1); assert.equal(pricing.category, 'product_facts'); assert.equal(first.documents[0]!.category, 'brand_guidelines');
  assert.deepEqual(pricing.origin, { kind: 'website', url: `${SITE}/pricing`, fetchedAt: now }); assert.equal(pricing.active, true);

  const again = websiteDocuments({ brandId, pages: pages(PRICING_WORDS), existing: first.documents, now });
  assert.equal(again.documents.length, 0); assert.equal(again.unchanged, 2);
  const changed = websiteDocuments({ brandId, pages: pages(PRICING_WORDS.replace('£49', '£59')), existing: first.documents, now });
  assert.equal(changed.documents.length, 1); assert.equal(changed.documents[0]!.id, pricing.id); assert.equal(changed.documents[0]!.version, 2);
  const long = websiteDocuments({ brandId, pages: [{ ...pages('x')[1]!, text: 'word '.repeat(5000) }], existing: [], now });
  assert.ok(long.documents[0]!.text!.length <= BRAND_PAGE_TEXT_LIMIT);
});

test('nothing invented: a price must be word for word in its source, and every audience and claim must quote one', () => {
  const docs = [{ id: 'page', text: PRICING_WORDS }, { id: 'home', text: HOME_WORDS }];
  assert.equal(appearsIn(PRICING_WORDS, '£49  PER month'), true, 'only case and spacing are forgiven');
  assert.equal(appearsIn(PRICING_WORDS, '£49 a month'), false);
  assert.equal(appearsIn(PRICING_WORDS, '£4'), false, 'a price is matched on whole numbers'); assert.equal(appearsIn(PRICING_WORDS, ''), false);
  assert.equal(appearsIn(PRICING_WORDS, '£49'), true); assert.equal(appearsIn('Gold costs £499 per month.', '£49'), false); assert.equal(appearsIn('Only £49.99 today, or £1,499 a year.', '£49'), false);
  assert.equal(appearsIn('Only £49.99 today, or £1,499 a year.', '499'), false); assert.equal(appearsIn('Homes from £49k.', '£49'), false); assert.equal(appearsIn('It costs £49.', '£49'), true);
  const base = { conflicts: [], missingFacts: [] };
  const good = { ...base, offers: [{ name: 'Quay Compliance Plan', description: '', price: '£49 per month', url: null, sourceDocumentId: 'page' }], audiences: ['Private landlords in Kent'], approvedClaims: [],
    sources: [{ field: 'audience' as const, value: 'Private landlords in Kent', documentId: 'home', quote: 'private landlords in Kent' }] };
  assert.deepEqual(strictProfileProblems(good, docs), []);
  const invented = strictProfileProblems({ ...good, offers: [{ ...good.offers[0]!, price: '£39 per month' }] }, docs);
  assert.equal(invented.length, 1); assert.match(invented[0]!, /£39 per month.*does not appear character for character/);
  assert.match(strictProfileProblems({ ...good, offers: [{ ...good.offers[0]!, sourceDocumentId: 'made-up' }] }, docs)[0]!, /must name the supplied document/);
  // Free text has no source line on the card, so a number in it must exist in a source.
  assert.deepEqual(strictProfileProblems({ ...good, summary: 'Compliance for private landlords in Kent, from £49 per month.' }, docs), []);
  const boast = strictProfileProblems({ ...good, summary: 'Trusted by 500 landlords with a 98% pass rate.' }, docs);
  assert.equal(boast.length, 2); assert.match(boast[0]!, /the summary states "500", which is in none of the supplied documents/);
  assert.match(strictProfileProblems({ ...good, offers: [{ ...good.offers[0]!, description: 'Save £2,000 a year.' }] }, docs)[0]!, /description of "Quay Compliance Plan" states "£2,000"/);
  assert.match(strictProfileProblems({ ...good, audiences: ['Private landlords in Kent', 'Property developers'] }, docs)[0]!, /audience "Property developers" has no sources entry/);
  assert.match(strictProfileProblems({ ...good, approvedClaims: ['Rated best in Kent'] }, docs)[0]!, /approved claim "Rated best in Kent"/);
  assert.match(strictProfileProblems({ ...good, sources: [{ ...good.sources[0]!, quote: 'landlords all over Britain' }] }, docs).join('\n'), /not word for word/);
  const conflict = { field: 'Plan price', detail: 'two prices', documentIds: ['page'], kind: 'price' as const, offer: 'Quay Compliance Plan', options: [{ value: '£99 per month', documentId: 'page', quote: 'costs £49 per month' }] };
  assert.match(strictProfileProblems({ ...good, conflicts: [conflict] }, docs).join('\n'), /price option "£99 per month" does not appear/);
});

test('price backstop: two sources with different prices for one offer become a question; one page with two prices does not', () => {
  const offer = { name: 'Quay Compliance Plan', description: '', price: '£59 per month', url: null, sourceDocumentId: 'doc' };
  const page = { id: 'page', text: PRICING_WORDS }, doc = { id: 'doc', text: 'Price list. Quay Compliance Plan costs £59 per month from January.' };
  const found = priceConflicts({ offers: [offer], conflicts: [] }, [page, doc]);
  assert.equal(found.length, 1); assert.equal(found[0]!.kind, 'price'); assert.equal(found[0]!.offer, 'Quay Compliance Plan');
  assert.deepEqual(found[0]!.options!.map((o) => [o.value, o.documentId]), [['£49 per month', 'page'], ['£59 per month', 'doc']]);
  for (const o of found[0]!.options!) assert.ok(appearsIn(o.documentId === 'page' ? page.text : doc.text, o.quote), 'each option quotes its own source');
  const held = holdConflictedPrices({ offers: [offer], conflicts: [], audiences: [], approvedClaims: [], missingFacts: [] }, [page, doc]);
  assert.equal(held.offers[0]!.price, null, 'a conflicted price is never shown as settled'); assert.equal(held.conflicts.length, 1);

  const both = { id: 'page', text: 'The Quay Compliance Plan costs £49 per month or £490 per year.' };
  assert.equal(priceConflicts({ offers: [offer], conflicts: [] }, [both, { id: 'doc', text: 'Quay Compliance Plan costs £49 per month.' }]).length, 0, 'a shared price is agreement');
  assert.equal(priceConflicts({ offers: [offer], conflicts: [] }, [both]).length, 0, 'one source cannot disagree with itself');
  assert.equal(priceConflicts({ offers: [offer], conflicts: [{ field: 'Quay Compliance Plan price', detail: 'x', documentIds: [] }] }, [page, doc]).length, 0, 'a conflict the model already raised is not doubled');
  assert.equal(priceConflicts({ offers: [offer], conflicts: [{ field: 'Quay Compliance Plan: contract length', detail: 'six or twelve months', documentIds: [], kind: 'other' }] }, [page, doc]).length, 1, 'a different question about the same offer does not hide the price disagreement');
});

test('settling takes the value from the stored card by position; the card says where every line came from', () => {
  const documents = [
    { id: 'page', version: 1, title: 'Pricing page', text: PRICING_WORDS, active: true, origin: { kind: 'website', url: `${SITE}/pricing`, fetchedAt: 'x' } },
    { id: 'doc', version: 1, title: 'Price list', text: 'Quay Compliance Plan costs £59 per month.', active: true },
  ] as unknown as KnowledgeDocument[];
  const profile = {
    brandId: 'b', version: 3, knowledge: [{ documentId: 'page', version: 1, sha256: 'a', category: 'product_facts' }, { documentId: 'doc', version: 1, sha256: 'b', category: 'product_facts' }],
    summary: 'Summary of the business.', audiences: ['Private landlords in Kent', 'Legacy audience'], positioning: '', conversionPages: [], voice: { tone: [], do: [], dont: [], examples: [] }, exclusions: [], missingFacts: [],
    offers: [{ name: 'Quay Compliance Plan', description: 'Support', price: null, url: null, sourceDocumentId: 'page' }], approvedClaims: [],
    conflicts: [
      { field: 'Quay Compliance Plan: price', detail: 'd', documentIds: ['page', 'doc'], kind: 'price', offer: 'Quay Compliance Plan', options: [{ value: '£49 per month', documentId: 'page', quote: 'costs £49 per month' }, { value: '£59 per month', documentId: 'doc', quote: 'costs £59 per month' }] },
      { field: 'Service area', detail: 'd', documentIds: ['page', 'doc'], kind: 'other', options: [{ value: 'Kent', documentId: 'page', quote: 'in Kent' }] },
    ],
    sources: [{ field: 'audience', value: 'Private landlords in Kent', documentId: 'page', quote: 'private landlords' }],
    factsSha: 'f', source: 'extracted', confirmedAt: null, confirmedBy: null, createdAt: 'x', generation: null,
  } as unknown as BrandProfile;

  const before = brandDnaCard(profile, documents);
  assert.equal(before.offers[0]!.priceOpen, true); assert.equal(before.offers[0]!.source!.label, 'From your Pricing page');
  assert.deepEqual(before.conflicts[0]!.options.map((o) => o.source.label), ['From your Pricing page', 'From your document “Price list”']);
  assert.equal(before.audiences[0]!.source!.label, 'From your Pricing page'); assert.equal(before.audiences[0]!.source!.url, `${SITE}/pricing`);
  assert.equal(before.audiences[1]!.source, null); assert.equal(before.unsourced, 1, 'a line with no recorded source is counted, not dressed up');
  assert.deepEqual(before.readFrom.map((r) => r.label), ['Pricing page', 'document “Price list”']);

  const picked = settleConflict(profile, 0, { kind: 'option', index: 1 });
  assert.equal(picked.offers[0]!.price, '£59 per month'); assert.equal(picked.offers[0]!.priceSourceDocumentId, 'doc'); assert.equal(picked.conflicts.length, 1);
  assert.equal(brandDnaCard({ ...profile, ...picked }, documents).offers[0]!.priceSource!.label, 'From your document “Price list”');
  const typed = settleConflict(profile, 0, { kind: 'typed', text: '  £55 per month  ' });
  assert.equal(typed.offers[0]!.price, '£55 per month'); assert.equal(typed.offers[0]!.priceSourceDocumentId, null);
  assert.equal(brandDnaCard({ ...profile, ...typed }, documents).offers[0]!.priceSource!.label, 'You told us');
  const other = settleConflict(profile, 1, { kind: 'option', index: 0 });
  assert.deepEqual(other.approvedClaims, ['Service area: Kent']); assert.equal(other.offers[0]!.price, null);
  assert.equal(brandDnaCard({ ...profile, ...other }, documents).claims[0]!.source!.label, 'From your Pricing page');
  for (const bad of [[0, 2], [0, -1], [5, 0], [1, 1], [0, 1.5]] as const) assert.throws(() => settleConflict(profile, bad[0], { kind: 'option', index: bad[1] }), { status: 400 });
  assert.throws(() => settleConflict(profile, 0, { kind: 'typed', text: ' ' }), /Type the right answer/);
});

// ─── Engine ──────────────────────────────────────────────────────────────────

test('website address only: the site is read and a proposed card cites the pages; no page text is kept in the page list', async () => {
  const { h, brand, model, profile } = await proposedCard();
  assert.equal(profile.confirmedAt, null); assert.equal(profile.source, 'extracted'); assert.equal(profile.conflicts.length, 0);
  const documents = await h.engine.listKnowledge(OWNER, brand.id);
  assert.deepEqual(documents.map((d) => d.title).sort(), ['About page', 'Home page', 'Pricing page']);
  assert.ok(documents.every((d) => d.origin?.kind === 'website' && d.active && d.version === 1));
  assert.ok(!documents.some((d) => /Post words|Sign in to your account/.test(d.text ?? '')), 'a blog post and the sign-in page are not brand sources');
  const pricing = documents.find((d) => d.title === 'Pricing page')!;
  assert.equal(profile.offers[0]!.price, '£49 per month'); assert.equal(profile.offers[0]!.sourceDocumentId, pricing.id);
  assert.deepEqual(model.seen[0]!.map((d) => d.page).sort(), [`${SITE}/`, `${SITE}/about`, `${SITE}/pricing`], 'the model is told which documents are website pages');

  const state = await h.engine.brandDna(OWNER, brand.id);
  assert.equal(state.status, 'proposed'); assert.equal(state.working, false); assert.equal(state.pages, 3); assert.equal(state.documents, 0);
  assert.equal(state.card!.offers[0]!.priceSource!.label, 'From your Pricing page'); assert.equal(state.card!.audiences[0]!.source!.label, 'From your Home page');
  assert.equal(state.card!.claims[0]!.source!.label, 'From your About page'); assert.equal(state.card!.unsourced, 0);
  assert.deepEqual(brandDnaPayload(state.job!).result, { pagesRead: 3, pagesChanged: 3, words: state.job ? brandDnaPayload(state.job).result!.words : 0, websiteReadable: true });

  const inventory = (await h.engine.getInventory(OWNER, brand.id))!;
  assert.ok(inventory.pages.length >= 5); assert.ok(inventory.pages.every((p) => !('text' in p)), 'page words live in versioned documents only');
  assert.equal(h.llm.calls.length, 1); assert.equal((await h.engine.usage(OWNER, brand.id)).model_tokens, 1800);
  const jobs = await h.engine.listJobs(OWNER, brand.id);
  assert.deepEqual(jobs.map((j) => [j.kind, j.state, isBrandDnaJob(j), isProfileJob(j)]).sort(), [['inventory', 'done', true, false], ['write', 'done', false, true]]);
  assert.equal(profilePayload(jobs.find(isProfileJob)!).source.strict, true);

  const confirmed = await h.engine.confirmBrandDna(OWNER, brand.id, profile.version);
  assert.ok(confirmed.confirmedAt); assert.equal((await h.engine.readiness(OWNER, brand.id)).profile, 'confirmed');
  await assert.rejects(h.engine.requestBrandDna(STRANGER, brand.id, { commandId: randomUUID() }), { status: 404 });
});

test('an invented price is rejected: one correction pass, then the card is refused, nothing saved and the known usage recorded once', async () => {
  const h = harness(); seedSite(h);
  useModel(h, (docs) => { const card = honestCard(docs, 1) as { offers: { price: string }[] }; card.offers[0]!.price = '£39 per month'; return card; });
  const brand = await newBrand(h);
  await read(h, brand.id); await work(h);
  assert.equal(await h.engine.getProfile(OWNER, brand.id), null);
  assert.equal(h.llm.calls.length, 2, 'the existing single critique retry, never more');
  const cardJob = (await h.engine.listJobs(OWNER, brand.id)).find(isProfileJob)!;
  assert.equal(cardJob.state, 'blocked'); assert.equal(profilePayload(cardJob).reason, 'rejected'); assert.match(cardJob.error!, /could not find word for word/);
  assert.equal((await h.engine.usage(OWNER, brand.id)).model_tokens, 3600, 'both calls are accounted');
  assert.equal((await h.engine.listKnowledge(OWNER, brand.id)).length, 0, 'no page read for a refused card is kept'); assert.equal(profilePayload(cardJob).staged, undefined);
  await work(h); assert.equal(h.llm.calls.length, 2, 'a refused card is never retried on its own');
  const state = await h.engine.brandDna(OWNER, brand.id);
  assert.equal(state.status, 'none'); assert.equal(state.uncertainEarlierAttempt, false, 'a known rejection is not an uncertain charge');
  assert.ok((await h.engine.activity(OWNER, brand.id)).some((e) => e.kind === 'profile.rejected' && /£39 per month/.test(e.message)));

  // The correction pass works: a model that fixes the price on its second answer produces the card.
  const g = harness(); seedSite(g);
  useModel(g, (docs, attempt) => { const card = honestCard(docs, attempt) as { offers: { price: string }[] }; if (attempt === 1) card.offers[0]!.price = '£39 per month'; return card; });
  const second = await newBrand(g); await read(g, second.id); await work(g);
  assert.equal((await g.engine.getProfile(OWNER, second.id))!.offers[0]!.price, '£49 per month'); assert.equal(g.llm.calls.length, 2);
});

test('a page and a document disagree: shown as a question, confirm is refused until the owner settles it from the stored choices', async () => {
  const { h, brand, profile } = await proposedCard({ document: 'Price list for agents. Quay Compliance Plan costs £59 per month. Private landlords in Kent only.' });
  assert.equal(profile.conflicts.length, 1); assert.equal(profile.offers[0]!.price, null, 'neither price was chosen for the owner');
  const options = profile.conflicts[0]!.options!;
  assert.deepEqual(options.map((o) => o.value).sort(), ['£49 per month', '£59 per month']);
  const state = await h.engine.brandDna(OWNER, brand.id);
  assert.equal(state.documents, 1); assert.equal(state.pages, 3);
  assert.deepEqual(state.card!.conflicts[0]!.options.map((o) => o.source.label).sort(), ['From your Pricing page', 'From your document “Price list”']);

  await assert.rejects(h.engine.confirmBrandDna(OWNER, brand.id, profile.version), /Choose the right answer for each question/);
  assert.equal((await h.engine.getProfile(OWNER, brand.id))!.confirmedAt, null);
  await assert.rejects(h.engine.settleBrandDnaConflict(OWNER, brand.id, profile.version, 0, { kind: 'option', index: 7 }), { status: 400 });
  await assert.rejects(h.engine.settleBrandDnaConflict(OWNER, brand.id, profile.version, 3, { kind: 'option', index: 0 }), { status: 400 });
  await assert.rejects(h.engine.settleBrandDnaConflict(OWNER, brand.id, profile.version + 9, 0, { kind: 'option', index: 0 }), { status: 409 });
  await assert.rejects(h.engine.settleBrandDnaConflict(STRANGER, brand.id, profile.version, 0, { kind: 'option', index: 0 }), { status: 404 });
  assert.equal((await h.engine.getProfile(OWNER, brand.id))!.version, profile.version, 'refused choices change nothing');

  const pageChoice = options.findIndex((o) => o.value === '£49 per month');
  const settled = await h.engine.settleBrandDnaConflict(OWNER, brand.id, profile.version, 0, { kind: 'option', index: pageChoice });
  assert.equal(settled.offers[0]!.price, '£49 per month'); assert.equal(settled.conflicts.length, 0); assert.equal(settled.source, 'owner_edited'); assert.equal(settled.confirmedAt, null);
  const pricing = (await h.engine.listKnowledge(OWNER, brand.id)).find((d) => d.title === 'Pricing page')!;
  assert.equal(settled.offers[0]!.priceSourceDocumentId, pricing.id);
  const confirmed = await h.engine.confirmBrandDna(OWNER, brand.id, settled.version);
  assert.ok(confirmed.confirmedAt); assert.equal(h.llm.calls.length, 1, 'settling and confirming never call the model');

  // A card made by the website door keeps its rules whichever page confirms it: Setup's confirm cannot skip the question.
  const other = await proposedCard({ document: 'Quay Compliance Plan costs £59 per month. Private landlords in Kent.' });
  assert.equal(other.profile.strict, true);
  await assert.rejects(other.h.engine.confirmProfile(OWNER, other.brand.id, other.profile.version), (error: Error & { code?: string }) => error.code === 'brand_dna_open_conflicts');
  assert.equal((await other.h.engine.getProfile(OWNER, other.brand.id))!.confirmedAt, null);
});

test('no allowance: nothing is read, nothing is spent and the owner is told to set one', async () => {
  const h = harness(); seedSite(h); useModel(h, honestCard);
  const brand = await newBrand(h, 0);
  const before = h.web.requests.length;
  await assert.rejects(read(h, brand.id), (error: Error & { status?: number; code?: string }) => error.status === 409 && error.code === 'brand_dna_allowance' && /^Set a monthly allowance first\./.test(error.message));
  assert.equal((await h.engine.listJobs(OWNER, brand.id)).length, 0); assert.equal(h.web.requests.length, before); assert.equal(h.llm.calls.length, 0);
  const state = await h.engine.brandDna(OWNER, brand.id);
  assert.deepEqual(state.allowance, { used: 0, ceiling: 0, estimate: USAGE_ESTIMATES.profileFromSite, enough: false });
  assert.equal(USAGE_ESTIMATES.profileFromSite, 40_000); assert.ok(USAGE_ESTIMATES.profileFromSite > USAGE_ESTIMATES.profile);

  // Enough for the old documents-only estimate is still not enough for a website read.
  const small = await newBrand(h, USAGE_ESTIMATES.profile + 1, 'Quay Two');
  await assert.rejects(read(h, small.id), /Set a monthly allowance first/);
  // An allowance withdrawn after the request holds the read before any page is fetched or saved.
  const late = await newBrand(h, 1_000_000, 'Quay Three'); await read(h, late.id);
  const current = await h.engine.getBrand(OWNER, late.id);
  await h.engine.updateSettings(OWNER, late.id, current.rowVersion, { budgets: { ...current.settings.budgets, modelTokensPerMonth: 0 } });
  const fetched = h.web.requests.length; await work(h);
  const held = (await h.engine.listJobs(OWNER, late.id))[0]!;
  assert.equal(held.state, 'blocked'); assert.equal(brandDnaPayload(held).reason, 'allowance'); assert.equal(h.web.requests.length, fetched);
  assert.equal((await h.engine.listKnowledge(OWNER, late.id)).length, 0); assert.equal(h.llm.calls.length, 0);
});

test('a website that shows almost no words says so and offers pasting; pasted details then make the card on their own', async () => {
  const h = harness(); useModel(h, honestCard);
  h.web.set(`${SITE}/`, '<html><head><title>Quay</title></head><body><div id="app"></div><script src="/app.js"></script></body></html>');
  const brand = await newBrand(h);
  await read(h, brand.id); await work(h);
  const held = (await h.engine.listJobs(OWNER, brand.id))[0]!;
  assert.equal(held.state, 'blocked'); assert.equal(brandDnaPayload(held).reason, 'no_words');
  assert.match(held.error!, /could not read enough words from your website.*Paste your details instead/);
  assert.equal((await h.engine.listKnowledge(OWNER, brand.id)).length, 0); assert.equal(h.llm.calls.length, 0); assert.equal(await h.engine.getProfile(OWNER, brand.id), null);

  await h.engine.uploadKnowledge(OWNER, brand.id, { category: 'product_facts', title: 'About my business', pastedText: `${HOME_WORDS} ${ABOUT_WORDS} ${PRICING_WORDS}` });
  await read(h, brand.id); await work(h);
  const state = await h.engine.brandDna(OWNER, brand.id);
  assert.equal(state.status, 'proposed'); assert.equal(brandDnaPayload(state.job!).result!.websiteReadable, false); assert.equal(state.pages, 0);
  assert.equal(state.card!.offers[0]!.priceSource!.label, 'From your document “About my business”');

  // A website that cannot be opened at all is named as such.
  const g = harness(); useModel(g, honestCard);
  const down = await newBrand(g); await read(g, down.id); await work(g);
  assert.match((await g.engine.listJobs(OWNER, down.id))[0]!.error!, /We could not open https:\/\/quay\.example\. Check the address is right/);
});

test('a confirmed card is never made out of date silently: reading again needs the deliberate press, at request time and in the worker', async () => {
  const { h, brand, profile } = await proposedCard();
  await h.engine.confirmBrandDna(OWNER, brand.id, profile.version);
  h.web.set(`${SITE}/pricing`, page('Pricing', PRICING_WORDS.replace('£49', '£59')));
  const fetched = h.web.requests.length, documents = (await h.engine.listKnowledge(OWNER, brand.id)).length;
  await assert.rejects(read(h, brand.id), (error: Error & { code?: string }) => error.code === 'brand_dna_confirmed' && /content pauses until you confirm it/.test(error.message));
  await work(h);
  assert.equal(h.web.requests.length, fetched); assert.equal((await h.engine.listKnowledge(OWNER, brand.id)).length, documents);
  assert.equal((await h.engine.brandDna(OWNER, brand.id)).status, 'confirmed'); assert.equal((await h.engine.readiness(OWNER, brand.id)).profile, 'confirmed');

  const job = await read(h, brand.id, { readAgain: true });
  assert.equal(brandDnaPayload(job).replaceConfirmed, true); await work(h);
  const after = await h.engine.brandDna(OWNER, brand.id);
  assert.equal(after.status, 'proposed'); assert.equal(after.profile!.offers[0]!.price, '£59 per month');
  const pricing = (await h.engine.listKnowledge(OWNER, brand.id)).filter((d) => d.title === 'Pricing page');
  assert.deepEqual(pricing.map((d) => d.version), [1, 2], 'the changed page is a new version of the same document');

  // Requested while unconfirmed, confirmed before the worker ran: the worker reads nothing.
  const race = await proposedCard();
  const waiting = await read(race.h, race.brand.id);
  await race.h.engine.confirmBrandDna(OWNER, race.brand.id, race.profile.version);
  race.h.web.set(`${SITE}/pricing`, page('Pricing', PRICING_WORDS.replace('£49', '£59')));
  const before = race.h.web.requests.length; await work(race.h);
  const held = (await race.h.store.getJob(race.brand.id, waiting.id))!;
  assert.equal(held.state, 'blocked'); assert.equal(brandDnaPayload(held).reason, 'confirmed'); assert.equal(race.h.web.requests.length, before);
  assert.equal((await race.h.engine.brandDna(OWNER, race.brand.id)).status, 'confirmed');
});

test('pressing twice reads once; an unchanged re-read adds no document versions; an older worker would hold the task', async () => {
  const h = harness(); seedSite(h); useModel(h, honestCard);
  const brand = await newBrand(h); const commandId = randomUUID();
  const [a, b] = await Promise.all([h.engine.requestBrandDna(OWNER, brand.id, { commandId }), h.engine.requestBrandDna(OWNER, brand.id, { commandId })]);
  assert.equal(a.id, b.id); assert.equal((await read(h, brand.id)).id, a.id, 'a second press while one is waiting joins it');
  assert.equal((await h.engine.listJobs(OWNER, brand.id)).length, 1);
  assert.equal(a.kind, 'inventory'); assert.equal(a.payload.stage, 'brand_dna', 'an existing job kind with a payload stage: no new kind');
  await work(h); assert.equal(h.llm.calls.length, 1);
  await read(h, brand.id); await work(h);
  assert.ok((await h.engine.listKnowledge(OWNER, brand.id)).every((d) => d.version === 1)); assert.equal(h.llm.calls.length, 2);
  await assert.rejects(h.engine.requestBrandDna(OWNER, brand.id, { commandId: 'not-a-uuid' }), { status: 400 });
});

test('a new website address retires the pages kept from the old one, and Brand setup still lists every source', async () => {
  const { h, brand } = await proposedCard();
  const NEXT = 'https://quayside.example';
  h.web.set(`${NEXT}/`, page('Quayside', HOME_WORDS, '', '<a href="/fees">Fees</a>'));
  h.web.set(`${NEXT}/fees`, page('Fees', `${PRICING_WORDS} ${ABOUT_WORDS}`));
  await read(h, brand.id, { website: 'quayside.example' }); await work(h);
  assert.equal((await h.engine.getBrand(OWNER, brand.id)).website, NEXT);
  const state = await h.engine.brandDna(OWNER, brand.id);
  assert.equal(state.status, 'proposed'); assert.equal(state.pages, 2);
  assert.deepEqual(state.card!.readFrom.map((r) => r.url).sort(), [`${NEXT}/`, `${NEXT}/fees`], 'the old address is no longer a source');
  assert.equal(state.card!.offers[0]!.priceSource!.label, 'From your Fees page');
  const setup = await call(serviceFor(h), identity(OWNER.userId), 'GET', `/portal/seo-blog/b/${brand.id}/setup`);
  assert.equal(setup.status, 200); assert.match(setup.body, /Fees page/); assert.match(setup.body, /Check your Brand DNA card/);
});

test('an owner correction keeps the source of unchanged lines and marks new ones as theirs', async () => {
  const { h, brand, profile } = await proposedCard();
  const corrected = await h.engine.correctBrandDna(OWNER, brand.id, profile.version, { summary: 'Quay Lettings keeps Kent landlords compliant.', audiences: ['Private landlords in Kent', 'First-time landlords'], approvedClaims: [], exclusions: ['Tax advice'], voiceDont: ['Jargon'] });
  assert.equal(corrected.source, 'owner_edited'); assert.equal(corrected.confirmedAt, null); assert.equal(corrected.version, profile.version + 1);
  const card = (await h.engine.brandDna(OWNER, brand.id)).card!;
  assert.deepEqual(card.audiences.map((a) => a.source?.label), ['From your Home page', 'You told us']); assert.equal(card.claims.length, 0); assert.equal(card.unsourced, 0);
  assert.equal(corrected.offers[0]!.price, '£49 per month', 'a correction cannot type a price');
  await assert.rejects(h.engine.correctBrandDna(OWNER, brand.id, profile.version, { summary: 'A stale edit of the earlier card.', audiences: [], approvedClaims: [], exclusions: [], voiceDont: [] }), { status: 409 });
});

// ─── Screens and routes ──────────────────────────────────────────────────────

function identity(userId: string): PortalSessionIdentity {
  return { sessionToken: `token-${userId}`, userId, workspaceId: '33333333-3333-4333-8333-333333333333', userEmail: 'owner@example.test' };
}
async function call(service: PortalSeoBlogService, who: PortalSessionIdentity | null, method: string, path: string, form?: Record<string, string>, extraHeaders: Record<string, string> = {}) {
  const body = form ? new URLSearchParams(form).toString() : '';
  const req = new PassThrough() as unknown as IncomingMessage & PassThrough;
  Object.assign(req, { method, url: path, headers: { host: 'portal.example', ...(form ? { 'content-type': 'application/x-www-form-urlencoded', 'content-length': String(Buffer.byteLength(body)), origin: 'https://portal.example' } : {}), ...extraHeaders } });
  (req as PassThrough).end(body);
  let status = 0; let headers: Record<string, string> = {}; let out = '';
  const res = { writeHead(s: number, hd: Record<string, string>) { status = s; headers = hd; return res; }, end(chunk?: string | Buffer) { if (chunk) out += chunk.toString(); } } as unknown as ServerResponse;
  await handleSeoBlog(req, res, new URL(path, 'https://portal.example'), { service, identity: who, requestId: `r-${randomUUID()}`, sessionSecret: SECRET, vaultReady: true });
  return { status, headers, body: out };
}
const serviceFor = (h: Harness, extra: Partial<PortalSeoBlogService> = {}): PortalSeoBlogService => ({ generation: 'live', research: 'live', social: 'unavailable', engineFor: () => h.engine, socialCallback: async () => null, ...extra });
/** The door's own words, without the shared navigation and stylesheet around it. */
const door = (html: string) => html.slice(html.indexOf('<div class="dna">'), html.indexOf('</main>'));
const mains = (html: string) => (door(html).match(/class="(?:button )?main"/g) ?? []).length;
const failed = (r: { status: number; headers: Record<string, string> }) => r.status === 303 && new URL(r.headers.location!, 'https://x').searchParams.has('e');
const JARGON = /extract|inventory|knowledge|stale|profile|\bjob\b|crawl|model\b/i;

test('the door: one main button, plain words, CSRF and workspace checks, and a read that starts from the page', async () => {
  const h = harness(); seedSite(h); useModel(h, honestCard);
  const brand = await newBrand(h); const service = serviceFor(h), owner = identity(OWNER.userId), csrf = portalCsrfToken(SECRET, owner.sessionToken);
  const base = `/portal/seo-blog/b/${brand.id}/dna`;

  const brands = await call(service, owner, 'GET', '/portal/seo-blog');
  assert.match(brands.body, new RegExp(`<a class="button" href="${base}">Start with your website</a>`));
  assert.match((await call(service, owner, 'GET', `/portal/seo-blog/b/${brand.id}/setup`)).body, new RegExp(`id="brand-dna-door"[\\s\\S]*href="${base}">Start with your website</a>`));

  const first = await call(service, owner, 'GET', base);
  assert.equal(first.status, 200); assert.match(door(first.body), /<h1>Start with your website<\/h1>/);
  assert.match(door(first.body), /<button class="main" type="submit">Read my website<\/button>/); assert.equal(mains(first.body), 1);
  assert.match(door(first.body), /name="website"[^>]*value="https:\/\/quay\.example"/); assert.match(door(first.body), /Paste your details instead/);
  assert.doesNotMatch(door(first.body), JARGON);
  assert.equal((await call(service, identity(STRANGER.userId), 'GET', base)).status, 404);
  assert.equal((await call(service, null, 'GET', base)).status, 303);

  const form = { commandId: randomUUID(), website: 'quay.example' };
  assert.ok(failed(await call(service, owner, 'POST', `${base}/read`, form)), 'no CSRF token');
  assert.ok(failed(await call(service, owner, 'POST', `${base}/read`, { ...form, _csrf: csrf }, { origin: 'https://evil.example' })), 'another site');
  const stranger = identity(STRANGER.userId);
  assert.equal((await call(service, stranger, 'POST', `${base}/read`, { ...form, _csrf: portalCsrfToken(SECRET, stranger.sessionToken) })).status, 404, 'another workspace');
  assert.equal((await h.engine.listJobs(OWNER, brand.id)).length, 0);

  const started = await call(service, owner, 'POST', `${base}/read`, { ...form, _csrf: csrf });
  assert.equal(started.status, 303); assert.match(started.headers.location!, new RegExp(`^${base}\\?n=`));
  const waiting = await call(service, owner, 'GET', base);
  assert.match(door(waiting.body), /<h1>Reading your website<\/h1>/); assert.match(waiting.body, /<meta http-equiv="refresh" content="8">/); assert.equal(mains(waiting.body), 1);
  assert.doesNotMatch(door(waiting.body), /<form/); assert.doesNotMatch(door(waiting.body), JARGON);
  await work(h);

  const card = await call(service, owner, 'GET', base);
  assert.match(door(card.body), /<h1>Your Brand DNA <span class="pill warn">Needs your confirmation<\/span><\/h1>/);
  assert.match(door(card.body), /Price: £49 per month<\/span><span class="from"><a href="https:\/\/quay\.example\/pricing"[^>]*>From your Pricing page<\/a>/);
  assert.match(door(card.body), /Private landlords in Kent<span class="from"><a href="https:\/\/quay\.example\/"[^>]*>From your Home page<\/a>: <q>private landlords in Kent<\/q>/);
  assert.match(door(card.body), /<button class="main" type="submit">Confirm my Brand DNA<\/button>/); assert.equal(mains(card.body), 1);
  assert.match(door(card.body), /What we could not find[\s\S]*A named author/); assert.doesNotMatch(door(card.body), JARGON);
  assert.match((await call(service, owner, 'GET', '/portal/seo-blog')).body, /Check your Brand DNA card/);

  const version = String((await h.engine.getProfile(OWNER, brand.id))!.version);
  assert.ok(failed(await call(service, owner, 'POST', `${base}/confirm`, { version })), 'confirm needs CSRF');
  assert.ok(failed(await call(service, owner, 'POST', `${base}/confirm`, { _csrf: csrf, version: 'abc' })));
  assert.equal((await call(service, owner, 'POST', `${base}/confirm`, { _csrf: csrf, version })).status, 303);
  const done = await call(service, owner, 'GET', base);
  assert.match(door(done.body), /<span class="pill ok">Confirmed<\/span>/); assert.equal(mains(done.body), 1); assert.match(door(done.body), /class="button main"[^>]*>Plan my content<\/a>/);
  assert.match(door(done.body), /<strong>Your content pauses until you confirm the new card\.<\/strong>[\s\S]*name="again" value="1"[\s\S]*<button class="secondary" type="submit">Read my website again<\/button>/);
  // A plain read request against the confirmed card is refused: only the form that carries the warning can start one.
  assert.ok(failed(await call(service, owner, 'POST', `${base}/read`, { _csrf: csrf, commandId: randomUUID(), website: 'quay.example' })));
  assert.equal((await h.engine.brandDna(OWNER, brand.id)).status, 'confirmed');
  assert.equal((await call(service, owner, 'GET', `${base}/nothing`)).status, 404);
});

test('conflict screen: answers side by side, confirm disabled, and a forged or out-of-range choice changes nothing', async () => {
  const { h, brand, profile } = await proposedCard({ document: 'Price list for agents. Quay Compliance Plan costs £59 per month. Private landlords in Kent only.' });
  const service = serviceFor(h), owner = identity(OWNER.userId), csrf = portalCsrfToken(SECRET, owner.sessionToken), base = `/portal/seo-blog/b/${brand.id}/dna`;
  const shown = door((await call(service, owner, 'GET', base)).body);
  assert.match(shown, /<h2>We found different answers<\/h2>/); assert.match(shown, /We have not chosen for you/);
  assert.match(shown, /<div class="answers side">/); assert.equal((shown.match(/type="radio" name="choice"/g) ?? []).length, 3);
  assert.match(shown, /<strong>£49 per month<\/strong><span class="from"><a[^>]*>From your Pricing page<\/a>/); assert.match(shown, /<strong>£59 per month<\/strong><span class="from">From your document “Price list”/);
  assert.match(shown, /<strong>Neither, I’ll type it<\/strong>/); assert.match(shown, /Price: choose the right one above/);
  assert.match(shown, /<button class="main" type="submit" disabled aria-describedby="dna-why">Confirm my Brand DNA<\/button>/); assert.match(shown, /Choose an answer for the question above first/);
  assert.doesNotMatch(shown, /name="value"/, 'the form carries positions, never the answer itself');

  const send = (form: Record<string, string>) => call(service, owner, 'POST', `${base}/settle`, { _csrf: csrf, version: String(profile.version), conflict: '0', ...form });
  const refusals: Record<string, string>[] = [{ choice: '9' }, { choice: '-1' }, { choice: '' }, { choice: '0', conflict: '4' }, { choice: 'typed', typed: ' ' }, { choice: '0', version: String(profile.version + 1) }];
  for (const bad of refusals) {
    assert.ok(failed(await send(bad)), JSON.stringify(bad));
  }
  assert.ok(failed(await call(service, owner, 'POST', `${base}/settle`, { version: String(profile.version), conflict: '0', choice: '0' })), 'CSRF');
  assert.ok(failed(await call(service, owner, 'POST', `${base}/confirm`, { _csrf: csrf, version: String(profile.version) })), 'confirm is refused while a question is open');
  assert.deepEqual(await h.engine.getProfile(OWNER, brand.id), profile);

  // A forged value travels with a valid position: the stored option wins.
  const index = profile.conflicts[0]!.options!.findIndex((o) => o.value === '£59 per month');
  const saved = await send({ choice: String(index), value: '£1 per month', typed: '£2 per month' });
  assert.equal(saved.status, 303); assert.ok(!failed(saved));
  const current = (await h.engine.getProfile(OWNER, brand.id))!;
  assert.equal(current.offers[0]!.price, '£59 per month'); assert.equal(current.conflicts.length, 0);
  const after = door((await call(service, owner, 'GET', base)).body);
  assert.match(after, /Price: £59 per month<\/span><span class="from">From your document “Price list”/); assert.doesNotMatch(after, /disabled/);
  assert.equal((await call(service, owner, 'POST', `${base}/confirm`, { _csrf: csrf, version: String(current.version) })).status, 303);
  assert.ok((await h.engine.getProfile(OWNER, brand.id))!.confirmedAt);
});

test('blocked screens say what to do: set an allowance, or paste details when the website shows no words', async () => {
  const h = harness(); useModel(h, honestCard);
  h.web.set(`${SITE}/`, '<html><head><title>Quay</title></head><body><div id="app"></div></body></html>');
  const poor = await newBrand(h, 0); const service = serviceFor(h), owner = identity(OWNER.userId), csrf = portalCsrfToken(SECRET, owner.sessionToken);
  const blocked = door((await call(service, owner, 'GET', `/portal/seo-blog/b/${poor.id}/dna`)).body);
  assert.match(blocked, /<h2>Set a monthly allowance first<\/h2>/); assert.match(blocked, /Nothing has been read and nothing has been spent/);
  assert.match(blocked, new RegExp(`<a class="button main" href="/portal/seo-blog/b/${poor.id}/publishing#writing-budget">Set my monthly allowance</a>`));
  assert.equal(mains(blocked), 1); assert.doesNotMatch(blocked, /Read my website<\/button>/);
  const refused = await call(service, owner, 'POST', `/portal/seo-blog/b/${poor.id}/dna/read`, { _csrf: csrf, commandId: randomUUID(), website: 'quay.example' });
  assert.ok(failed(refused)); assert.match(refused.headers.location!, new RegExp(`^/portal/seo-blog/b/${poor.id}/dna\\?e=`));
  assert.match((await call(service, owner, 'GET', refused.headers.location!)).body, /role="alert">Set a monthly allowance first\./);
  assert.equal(h.llm.calls.length, 0);

  const brand = await newBrand(h, 1_000_000, 'Quay Two'); await read(h, brand.id); await work(h);
  const empty = door((await call(service, owner, 'GET', `/portal/seo-blog/b/${brand.id}/dna`)).body);
  assert.match(empty, /role="alert">We could not read enough words from your website/);
  assert.match(empty, new RegExp(`<a class="button main" href="/portal/seo-blog/b/${brand.id}/setup#brand-guidance">Paste your details instead</a>`));
  assert.equal(mains(empty), 1); assert.match(empty, /<summary>Try my website again<\/summary>/); assert.doesNotMatch(empty, JARGON);
});

// ─── Slice 2: logo and colours ───────────────────────────────────────────────

const LOOK_HEAD = '<meta name="theme-color" content="#0F766E"><link rel="icon" sizes="32x32" href="/favicon.png"><link rel="apple-touch-icon" sizes="180x180" href="/touch.png"><link rel="icon" sizes="192x192" href="/icon-192.png"><link rel="icon" href="/mark.svg"><meta property="og:image" content="/share.jpg"><link rel="stylesheet" href="/site.css">';

test('the page parser reads the share image, icons and theme colour a home page declares', () => {
  const parsed = parseHtmlPage(`<html><head><title>Quay</title>${LOOK_HEAD}</head><body><p>Hello</p></body></html>`, `${SITE}/`);
  assert.equal(parsed.ogImage, `${SITE}/share.jpg`); assert.equal(parsed.themeColour, '#0f766e');
  assert.deepEqual(parsed.icons, [`${SITE}/touch.png`, `${SITE}/icon-192.png`, `${SITE}/favicon.png`, `${SITE}/mark.svg`], 'touch icon first, then largest');
  const bare = parseHtmlPage('<html><head><meta name="theme-color" content="red"><link rel="icon" href="javascript:alert(1)"></head><body></body></html>', `${SITE}/`);
  assert.equal(bare.themeColour, null); assert.deepEqual(bare.icons, []); assert.equal(bare.ogImage, null);
  assert.equal(normaliseHexColour('#ABC'), '#aabbcc'); assert.equal(normaliseHexColour('0f766e'), '#0f766e');
  for (const no of ['rgb(1,2,3)', '#12', '#1234567', 'url(x)', '', null]) assert.equal(normaliseHexColour(no), null);
});

function studioFor(h: Harness) {
  const library = new MemoryCreativeLibraryStore();
  const renderer = { version: 'none', available: () => false, renderBatch: async () => [] } as unknown as ArtworkRenderer;
  return { library, studio: new CreativeStudioService({ library, brands: h.store, renderer, savedImages: { list: async () => [], load: async () => { throw new Error('unused'); } } }) };
}

test('logo and colours are proposed from the website and saved only when the owner says "Yes, use these"', async () => {
  const h = harness(); seedSite(h, { head: LOOK_HEAD }); useModel(h, honestCard);
  const logo = syntheticLogoPng([15, 118, 110], 180, 180);
  h.web.set(`${SITE}/touch.png`, { contentType: 'image/png', body: '', bytes: logo });
  const brand = await newBrand(h); await read(h, brand.id); await work(h);
  const inventory = (await h.engine.getInventory(OWNER, brand.id))!;
  assert.deepEqual(inventory.look, { logoCandidates: [`${SITE}/touch.png`, `${SITE}/icon-192.png`, `${SITE}/favicon.png`, `${SITE}/share.jpg`], themeColour: '#0f766e' }, 'the SVG is not offered');
  assert.equal((await h.engine.brandDna(OWNER, brand.id)).look?.themeColour, '#0f766e');

  const { library, studio } = studioFor(h);
  const service = serviceFor(h, { creativeEnabled: true, creativeFor: () => studio, creativeSavedImages: async () => [] });
  const owner = identity(OWNER.userId), csrf = portalCsrfToken(SECRET, owner.sessionToken), kitUrl = `/portal/seo-blog/b/${brand.id}/creative/kit`;
  assert.match(door((await call(service, owner, 'GET', `/portal/seo-blog/b/${brand.id}/dna`)).body), /We found a logo and a colour on your website\. Nothing is used until you say so\.[\s\S]*creative\/kit\?website=1">Check your logo and colours/);

  // The kit page itself never calls out to the website: it offers to look, and looks only when asked.
  const fetchedBefore = h.web.requests.length;
  const hint = await call(service, owner, 'GET', kitUrl);
  assert.match(hint.body, new RegExp(`<a href="${kitUrl}\\?website=1">Show me what you found</a>`)); assert.doesNotMatch(hint.body, /Is this your logo/);
  assert.equal(h.web.requests.length, fetchedBefore);
  const shown = await call(service, owner, 'GET', `${kitUrl}?website=1`);
  assert.deepEqual(h.web.requests.slice(fetchedBefore), [`${SITE}/touch.png`]);
  assert.match(shown.body, /<h2>Is this your logo and colours\?<\/h2>/); assert.match(shown.body, /<button type="submit">Yes, use these<\/button>/);
  const viewedOnce = h.web.requests.length;
  assert.match((await call(service, owner, 'GET', `${kitUrl}?website=1`)).body, /Is this your logo and colours/); assert.equal(h.web.requests.length, viewedOnce, 'opening the page again does not fetch the logo again');
  assert.match(shown.body, new RegExp(`src="data:image/png;base64,${logo.toString('base64').slice(0, 40)}`)); assert.match(shown.body, /Main colour #0f766e/);
  assert.match(shown.body, /<summary><strong>Choose my own logo and colours<\/strong><\/summary>/);
  assert.equal(await library.latestKit(brand.id), null, 'looking saves nothing');
  const sha = /name="logoSha" value="([0-9a-f]{64})"/.exec(shown.body)![1]!;
  const form = { commandId: randomUUID(), expectedVersion: '0', logoSha: sha, colour: '#0f766e' };
  assert.ok(failed(await call(service, owner, 'POST', `${kitUrl}/use-website`, form)), 'CSRF');
  assert.ok(failed(await call(service, owner, 'POST', `${kitUrl}/use-website`, { ...form, _csrf: csrf, logoSha: 'f'.repeat(64) })), 'not the logo the owner was shown');
  assert.ok(failed(await call(service, owner, 'POST', `${kitUrl}/use-website`, { ...form, _csrf: csrf, colour: '#ff0000' })), 'not the colour the owner was shown');
  const stranger = identity(STRANGER.userId);
  const foreign = await call(service, stranger, 'POST', `${kitUrl}/use-website`, { ...form, _csrf: portalCsrfToken(SECRET, stranger.sessionToken) });
  assert.ok(foreign.status === 404 || failed(foreign), 'another workspace is refused like every other studio action');
  assert.equal(await library.latestKit(brand.id), null);

  const saved = await call(service, owner, 'POST', `${kitUrl}/use-website`, { ...form, _csrf: csrf });
  assert.equal(saved.status, 303); assert.ok(!failed(saved));
  const kit = (await library.latestKit(brand.id))!;
  assert.equal(kit.version, 1); assert.equal(kit.palette.primary, '#0f766e'); assert.equal(kit.logo!.sha256, sha); assert.equal(kit.logo!.mime, 'image/png');
  assert.deepEqual([kit.palette.accent, kit.palette.dark, kit.palette.light], ['#f4f6f8', '#121820', '#ffffff'], 'colours the website does not declare are left alone');
  const fetchedAfter = h.web.requests.length;
  const after = await call(service, owner, 'GET', `${kitUrl}?website=1`);
  assert.doesNotMatch(after.body, /Is this your logo|Show me what you found/, 'once a logo is on record the website is not asked again'); assert.equal(h.web.requests.length, fetchedAfter);
});

test('an oversized or wrong-type website logo is refused through the guarded fetch and never saved', async () => {
  const h = harness(); seedSite(h, { head: '<link rel="apple-touch-icon" href="/touch.png"><link rel="icon" sizes="64x64" href="/icon.png"><meta property="og:image" content="https://cdn.quay.example/share.jpg">' });
  useModel(h, honestCard);
  const png = syntheticLogoPng([1, 2, 3], 120, 120);
  h.web.set(`${SITE}/touch.png`, { contentType: 'image/png', body: '', bytes: Buffer.concat([png, Buffer.alloc(WEBSITE_LOGO_MAX_BYTES)]) });
  h.web.set(`${SITE}/icon.png`, { contentType: 'image/png', body: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' });
  h.web.set('https://cdn.quay.example/share.jpg', { contentType: 'text/html', body: '', bytes: png });
  const brand = await newBrand(h); await read(h, brand.id); await work(h);
  const requests = h.web.requests.length;
  const found = (await h.engine.proposedWebsiteLook(OWNER, brand.id))!;
  assert.equal(found.logo, null); assert.equal(found.refused, 'the file is larger than 1 MB');
  assert.deepEqual(h.web.requests.slice(requests), [`${SITE}/touch.png`, `${SITE}/icon.png`, 'https://cdn.quay.example/share.jpg'], 'every candidate went through the same guarded transport');
  await assert.rejects(h.engine.proposedWebsiteLook(STRANGER, brand.id), { status: 404 });
  const proposal = websiteLookProposal(found, null)!;
  assert.equal(proposal.usable, false); assert.equal(proposal.logo, null);

  const { library, studio } = studioFor(h);
  const service = serviceFor(h, { creativeEnabled: true, creativeFor: () => studio, creativeSavedImages: async () => [] });
  const owner = identity(OWNER.userId), csrf = portalCsrfToken(SECRET, owner.sessionToken), kitUrl = `/portal/seo-blog/b/${brand.id}/creative/kit`;
  const shown = await call(service, owner, 'GET', `${kitUrl}?website=1`);
  assert.match(shown.body, /We found a logo on your website but could not use it: the file is larger than 1 MB\./); assert.doesNotMatch(shown.body, /Yes, use th/);
  assert.ok(failed(await call(service, owner, 'POST', `${kitUrl}/use-website`, { _csrf: csrf, commandId: randomUUID(), expectedVersion: '0', logoSha: '', colour: '' })));
  assert.equal(await library.latestKit(brand.id), null);

  // A valid file of the right type is offered; a private address is refused before any request.
  h.web.set(`${SITE}/icon.png`, { contentType: 'image/png', body: '', bytes: png });
  const settledRequests = h.web.requests.length;
  assert.equal((await h.engine.proposedWebsiteLook(OWNER, brand.id))!.logo, null); assert.equal(h.web.requests.length, settledRequests, 'looking again straight away fetches nothing');
  assert.equal((await h.makeEngine().proposedWebsiteLook(OWNER, brand.id))!.logo, null); assert.equal(h.web.requests.length, settledRequests, 'nor does another request, which gets its own engine');
  h.clock.advance(11 * 60_000);
  const ok = (await h.engine.proposedWebsiteLook(OWNER, brand.id))!;
  assert.equal(ok.logo!.url, `${SITE}/icon.png`); assert.equal(ok.logo!.mime, 'image/png'); assert.equal(ok.refused, null);
  const page0 = await buildInventory(brand.id, SITE, h.web, { now: h.clock.now() });
  assert.ok(page0.look!.logoCandidates.every((u) => u.startsWith('https://')));
});

// ─── Fixes from the independent review ───────────────────────────────────────

const DETAILS = `${HOME_WORDS} ${ABOUT_WORDS} ${PRICING_WORDS}`;
/** A brand whose profile was made and confirmed the older way: pasted details in Brand setup, then "Extract profile". */
async function setupConfirmedBrand(h: Harness) {
  const brand = await newBrand(h);
  await h.engine.uploadKnowledge(OWNER, brand.id, { category: 'product_facts', title: 'About my business', pastedText: DETAILS });
  await h.engine.requestProfileExtraction(OWNER, brand.id, { commandId: randomUUID(), baseVersion: 0 });
  await work(h);
  const extracted = (await h.engine.getProfile(OWNER, brand.id))!;
  return { brand, profile: await h.engine.confirmProfile(OWNER, brand.id, extracted.version) };
}

test('a refused or failed card leaves a confirmed brand exactly as it was; pages become sources only in the same write as the card built from them', async () => {
  const h = harness(); seedSite(h);
  let answer: CardScript = honestCard;
  useModel(h, (docs, attempt) => answer(docs, attempt));
  const { brand } = await setupConfirmedBrand(h);
  // Everything content is written and planned from. (The list of site pages is refreshed by any read, as the daily read does.)
  const snapshot = async () => ({ documents: await h.engine.listKnowledge(OWNER, brand.id), profile: await h.engine.getProfile(OWNER, brand.id),
    readiness: { ...await h.engine.readiness(OWNER, brand.id), inventory: null }, status: (await h.engine.brandDna(OWNER, brand.id)).status });
  const before = await snapshot();
  assert.equal(before.status, 'confirmed'); assert.equal(before.readiness.profile, 'confirmed'); assert.equal(before.documents.length, 1); assert.equal(before.profile!.strict, undefined);

  // Refused: the model keeps an audience it cannot quote, twice.
  answer = (docs, attempt) => ({ ...honestCard(docs, attempt), audiences: ['Private landlords in Kent', 'Landlords everywhere'] });
  await read(h, brand.id, { readAgain: true });
  await h.engine.tick('reader');
  const waiting = (await h.engine.listJobs(OWNER, brand.id)).find((j) => isProfileJob(j) && j.state === 'queued')!;
  assert.deepEqual(profilePayload(waiting).staged!.map((d) => d.title).sort(), ['About page', 'Home page', 'Pricing page'], 'the pages wait with the card task');
  assert.deepEqual(await snapshot(), before, 'reading the website on its own changes nothing: the confirmed card is still current while the new one is made');
  await work(h);
  const refused = (await h.engine.listJobs(OWNER, brand.id)).find((j) => isProfileJob(j) && profilePayload(j).reason === 'rejected')!;
  assert.match(refused.error!, /could not find word for word.*Nothing was saved or changed\./); assert.equal(profilePayload(refused).staged, undefined);
  assert.deepEqual(await snapshot(), before, 'refused: same documents, same confirmed card, still ready to plan');
  const spent = (await h.engine.usage(OWNER, brand.id)).model_tokens;

  // Failed: the call to the writing service breaks. Still nothing changes, and nothing is left to tidy up in Brand setup.
  h.llm.complete = async () => { throw new Error('socket hang up'); };
  await read(h, brand.id, { readAgain: true }); await work(h);
  assert.deepEqual(await snapshot(), before, 'failed: same documents, same confirmed card');
  assert.equal((await h.engine.usage(OWNER, brand.id)).model_tokens, spent);
  const page1 = door((await call(serviceFor(h), identity(OWNER.userId), 'GET', `/portal/seo-blog/b/${brand.id}/dna`)).body);
  assert.match(page1, /<span class="pill ok">Confirmed<\/span>/); assert.doesNotMatch(page1, /out of date/i);

  // Made: the pages and the card arrive together, and only then does the brand wait for the owner's confirmation.
  useModel(h, honestCard);
  await h.engine.requestBrandDna(OWNER, brand.id, { commandId: randomUUID(), readAgain: true, acknowledgePriorUsage: true }); await work(h);
  const after = await snapshot();
  assert.equal(after.status, 'proposed'); assert.equal(after.profile!.strict, true); assert.equal(after.profile!.knowledge.length, 4);
  assert.deepEqual(after.documents.map((d) => `${d.title} v${d.version} ${d.active}`).sort(), ['About my business v1 true', 'About page v1 true', 'Home page v1 true', 'Pricing page v1 true']);
  assert.ok((await h.engine.listJobs(OWNER, brand.id)).filter(isProfileJob).every((j) => profilePayload(j).staged === undefined), 'no finished task still carries page words');
  assert.ok((await h.engine.confirmBrandDna(OWNER, brand.id, after.profile!.version)).confirmedAt);
  assert.equal((await h.engine.readiness(OWNER, brand.id)).profile, 'confirmed');
});

test('strict mode: a short or unrelated quote, a figure outside its quote, a price cut out of a longer number and a loose question are all refused', () => {
  const docs = [
    { id: 'd1', text: 'Gold Membership costs £499 per month and includes weekly deal alerts. We help property investors find deals. Trusted by investors across the UK.' },
    { id: 'd2', text: 'Price list: Gold Membership £599 per month. Refunds: a money-back guarantee is available for thirty days.' },
  ];
  const gold = { name: 'Gold Membership', description: 'Weekly deal alerts', price: null as string | null, url: null, sourceDocumentId: 'd1' };
  const base = { summary: 'We help investors.', positioning: '', voice: { tone: [] as string[], do: [] as string[], dont: [] as string[], examples: [] as string[] }, missingFacts: [], offers: [gold], audiences: [] as string[], approvedClaims: [] as string[], conflicts: [] };
  const claim = (value: string, quote: string) => strictProfileProblems({ ...base, approvedClaims: [value], sources: [{ field: 'claim', value, documentId: 'd1', quote }] }, docs);
  assert.deepEqual(claim('We help property investors find deals', 'We help property investors find deals'), []);
  assert.match(claim('We help property investors find deals', 'in')[0]!, /too short/);
  assert.match(claim('Over 10,000 investors trust us, with 27% average returns guaranteed', 'Trusted by investors across the UK')[0]!, /states "10,000", which the quote does not contain/);
  assert.match(claim('Rated the best sourcing company in Britain', 'We help property investors find deals')[0]!, /does not use the same key words/);
  const audience = (value: string, quote: string) => strictProfileProblems({ ...base, audiences: [value], sources: [{ field: 'audience', value, documentId: 'd1', quote }] }, docs);
  assert.deepEqual(audience('Property investors', 'We help property investors find deals'), []); assert.match(audience('First-time buyers in Leeds', 'We help property investors find deals')[0]!, /key words/);

  // Prices on whole numbers; figures in names, descriptions and voice lines must be in a source.
  for (const price of ['£4', '£49', '£499 per year']) assert.match(strictProfileProblems({ ...base, offers: [{ ...gold, price }] }, docs)[0]!, /does not appear character for character/, price);
  assert.deepEqual(strictProfileProblems({ ...base, offers: [{ ...gold, price: '£499 per month' }] }, docs), []);
  assert.match(strictProfileProblems({ ...base, offers: [{ ...gold, name: 'Guaranteed 30% ROI plan' }] }, docs)[0]!, /name of offer "Guaranteed 30% ROI plan" states "30%"/);
  assert.match(strictProfileProblems({ ...base, offers: [{ ...gold, description: 'Only £599 per month.' }] }, docs)[0]!, /description of "Gold Membership" states "£599", which is not in document d1/);
  assert.match(strictProfileProblems({ ...base, voice: { ...base.voice, tone: ['Trusted by 9,999 clients'] } }, docs)[0]!, /voice "tone" line states "9,999"/);
  assert.match(strictProfileProblems({ ...base, voice: { ...base.voice, do: ['Say we have 5,000 five-star reviews'] } }, docs)[0]!, /voice "do" line states "5,000"/);

  // A question must say what kind it is, which offer a price belongs to, and offer only answers written in the document.
  const about = { field: 'Gold Membership price', detail: 'The page says £499 and the price list says £599.', documentIds: ['d1', 'd2'] };
  const conflict = (c: Record<string, unknown>) => strictProfileProblems({ ...base, conflicts: [{ ...about, ...c }] } as never, docs).join('\n');
  assert.match(conflict({}), /must give kind/);
  assert.match(conflict({ kind: 'price' }), /must give offer: the exact name/); assert.match(conflict({ kind: 'price', offer: 'Gold' }), /must give offer: the exact name/);
  assert.match(conflict({ kind: 'other', offer: 'Platinum' }), /names the offer "Platinum", which is not in offers/);
  const fair = [{ value: '£499 per month', documentId: 'd1', quote: 'Gold Membership costs £499 per month' }, { value: '£599 per month', documentId: 'd2', quote: 'Gold Membership £599 per month' }];
  assert.equal(conflict({ kind: 'price', offer: 'Gold Membership', options: fair }), '');
  assert.match(conflict({ kind: 'price', offer: 'Gold Membership', options: [{ ...fair[1]!, quote: '£599' }] }), /too short/);
  assert.match(conflict({ kind: 'price', offer: 'Gold Membership', options: [{ ...fair[1]!, quote: 'Price list: Gold Membership' }] }), /must contain "£599"/);
  assert.match(conflict({ kind: 'other', offer: null, options: [{ value: 'free forever', documentId: 'd2', quote: 'a money-back guarantee is available' }] }), /the answer "free forever" does not appear character for character in document d2/);
  assert.equal(conflict({ kind: 'other', offer: null, field: 'Refund period', detail: 'x', options: [{ value: 'thirty days', documentId: 'd2', quote: 'a money-back guarantee is available for thirty days' }] }), '');

  // What is kept to show the owner is only what can be shown truthfully, on either path.
  const cleaned = cleanProvenance({ ...base, approvedClaims: ['Over 10,000 investors trust us'], sources: [{ field: 'claim' as const, value: 'Over 10,000 investors trust us', documentId: 'd1', quote: 'Trusted by investors across the UK' }],
    conflicts: [{ ...about, kind: 'other' as const, options: [{ value: 'free forever', documentId: 'd2', quote: 'a money-back guarantee is available' }, { value: 'thirty days', documentId: 'd2', quote: 'a money-back guarantee is available for thirty days' }] }] }, docs);
  assert.equal(cleaned.sources, undefined, 'a quote that does not carry the fact is never shown as its source');
  assert.deepEqual(cleaned.conflicts[0]!.options!.map((o) => o.value), ['thirty days'], 'an answer not written in its document is never offered as a choice');
});

test('a question about a price always holds and then sets that offer’s price, including old questions that carry no kind; a losing price does not live on in the description', () => {
  const docs = [{ id: 'd1', text: 'Gold Membership costs £499 per month and includes weekly deal alerts.' }, { id: 'd2', text: 'Price list: Gold Membership £599 per month.' }];
  const priced = { name: 'Gold Membership', description: 'Weekly deal alerts. Only £499 per month.', price: '£499 per month', url: null, sourceDocumentId: 'd1' };
  const old = { field: 'Gold Membership price', detail: 'The page says £499 and the price list says £599.', documentIds: ['d1', 'd2'] };
  const held = holdConflictedPrices({ offers: [priced], conflicts: [old], audiences: [], approvedClaims: [], missingFacts: [] }, docs);
  assert.equal(held.offers[0]!.price, null, 'a disputed price is never shown as settled'); assert.equal(held.offers[0]!.description, 'Weekly deal alerts.'); assert.equal(held.conflicts.length, 1);

  // A profile confirmed before Brand DNA: the question has no kind and the disputed price still sits on the offer.
  const profile = { brandId: 'b', version: 4, knowledge: [], summary: 'Summary of the business.', audiences: [], positioning: '', conversionPages: [], voice: { tone: [], do: [], dont: [], examples: [] }, exclusions: [], missingFacts: [],
    offers: [priced], approvedClaims: ['We help investors'], conflicts: [old], factsSha: 'f', source: 'extracted', confirmedAt: null, confirmedBy: null, createdAt: 'x', generation: null } as unknown as BrandProfile;
  const card = brandDnaCard(profile, []);
  assert.equal(card.offers[0]!.priceOpen, true, 'the card asks, it does not show £499 as the price'); assert.equal(card.checked, false);
  const typed = settleConflict(profile, 0, { kind: 'typed', text: '£599 per month' });
  assert.equal(typed.offers[0]!.price, '£599 per month'); assert.equal(typed.offers[0]!.priceSourceDocumentId, null); assert.equal(typed.conflicts.length, 0);
  assert.deepEqual(typed.approvedClaims, ['We help investors'], 'the answer is the offer’s price, not a second claim beside a different price');
  assert.equal(typed.offers[0]!.description, 'Weekly deal alerts.', 'the price the owner did not choose is gone from the description');
  const settledCard = brandDnaCard({ ...profile, ...typed }, []);
  assert.equal(settledCard.offers[0]!.priceOpen, false); assert.equal(settledCard.offers[0]!.price, '£599 per month'); assert.equal(settledCard.offers[0]!.priceSource!.label, 'You told us');

  // Choosing the price the description already states keeps that sentence.
  const withChoices = { ...profile, conflicts: [{ ...old, kind: 'price', offer: 'Gold Membership', options: [{ value: '£499 per month', documentId: 'd1', quote: 'Gold Membership costs £499 per month' }, { value: '£599 per month', documentId: 'd2', quote: 'Gold Membership £599 per month' }] }] } as unknown as BrandProfile;
  assert.equal(settleConflict(withChoices, 0, { kind: 'option', index: 0 }).offers[0]!.description, 'Weekly deal alerts. Only £499 per month.');
  assert.equal(settleConflict(withChoices, 0, { kind: 'option', index: 1 }).offers[0]!.description, 'Weekly deal alerts.');
  // A price question whose offer is no longer on the card changes nothing rather than becoming a loose claim.
  assert.throws(() => settleConflict({ ...withChoices, offers: [] } as unknown as BrandProfile, 0, { kind: 'option', index: 0 }), { status: 409 });
});

test('offer names: the exact name first, then whole words only, so a question about "Pro Plus" never touches "Pro" and "Pro" is never read out of "property"', () => {
  const offer = (name: string, price: string | null) => ({ name, description: '', price, url: null, sourceDocumentId: 'page' });
  const offers = [offer('Starter', '£29 per month'), offer('Pro', '£49 per month'), offer('Pro Plus', '£499 per month')];
  const docs = [
    { id: 'page', text: 'Starter costs £29 per month. Pro costs £49 per month. Pro Plus costs £499 per month.' },
    { id: 'home', text: 'We source property worth £250,000 for investors every month. Professional help, properly explained.' },
    { id: 'list', text: 'Price list: Pro Plus £599 per month.' },
  ];
  const facts = { offers, conflicts: [] as BrandProfile['conflicts'][number][], audiences: [], approvedClaims: [], missingFacts: [] };
  const held = holdConflictedPrices(facts, docs);
  assert.deepEqual(held.conflicts.map((c) => c.offer), ['Pro Plus'], 'only the offer whose sources disagree becomes a question');
  assert.deepEqual(held.conflicts[0]!.options!.map((o) => [o.value, o.documentId]), [['£499 per month', 'page'], ['£599 per month', 'list']], 'no price is borrowed from a neighbouring offer or from the word "property"');
  assert.deepEqual(held.offers.map((o) => o.price), ['£29 per month', '£49 per month', null]);

  const named = holdConflictedPrices({ ...facts, conflicts: [{ field: 'Pro Plus: price', detail: 'Pro Plus is £499 on the page and £599 on the list', documentIds: ['page', 'list'], kind: 'price' as const, offer: 'Pro Plus' }] }, docs);
  assert.deepEqual(named.offers.map((o) => o.price), ['£29 per month', '£49 per month', null], 'a question for one offer never wipes another offer’s price');
  const bare = (field: string, detail = 'two answers') => conflictOffer({ field, detail, documentIds: [] }, offers)?.name ?? null;
  assert.equal(bare('Pro Plus price'), 'Pro Plus'); assert.equal(bare('Pro price'), 'Pro'); assert.equal(bare('Property management price'), null); assert.equal(bare('Professional price'), null);
  assert.equal(bare('Price', 'Starter is listed at two prices, unlike Pro'), 'Starter');
  assert.equal(conflictOffer({ field: 'Pro Plus and Pro', detail: '', documentIds: [], offer: 'pro' }, offers)!.name, 'Pro', 'the exact name wins over a longer one mentioned beside it');
  const settled = settleConflict({ offers: named.offers, approvedClaims: [], conflicts: named.conflicts.map((c) => ({ ...c, options: [{ value: '£599 per month', documentId: 'list', quote: 'Pro Plus £599 per month' }] })), sources: [] }, 0, { kind: 'option', index: 0 });
  assert.deepEqual(settled.offers.map((o) => o.price), ['£29 per month', '£49 per month', '£599 per month']);
});

test('a mistyped website address is the owner’s to fix, said plainly, and a refused request changes nothing', async () => {
  const h = harness(); seedSite(h); useModel(h, honestCard);
  const brand = await newBrand(h); const service = serviceFor(h), owner = identity(OWNER.userId), csrf = portalCsrfToken(SECRET, owner.sessionToken), base = `/portal/seo-blog/b/${brand.id}/dna`;
  for (const website of ['my website', 'quay lettings.co.uk', 'http://localhost', 'me@quay.example', 'quay.example:8080', 'quaylettings']) {
    await assert.rejects(h.engine.requestBrandDna(OWNER, brand.id, { commandId: randomUUID(), website }),
      (error: Error & { status?: number }) => error.status === 400 && /^That doesn’t look like a website address\. It should look like www\.yourbusiness\.co\.uk$/.test(error.message), website);
  }
  const typo = await call(service, owner, 'POST', `${base}/read`, { _csrf: csrf, commandId: randomUUID(), website: 'my website' });
  assert.ok(failed(typo), 'sent back to the page with the reason, not to an error page'); assert.match(typo.headers.location!, new RegExp(`^${base}\\?e=`));
  const shown = await call(service, owner, 'GET', typo.headers.location!);
  assert.equal(shown.status, 200); assert.match(shown.body, /role="alert">That doesn’t look like a website address\. It should look like www\.yourbusiness\.co\.uk/); assert.match(door(shown.body), /Read my website<\/button>/);
  assert.equal((await h.engine.listJobs(OWNER, brand.id)).length, 0); assert.equal((await h.engine.getBrand(OWNER, brand.id)).website, SITE);

  // A request that is refused for another reason does not change the saved address either.
  const { h: g, brand: confirmed, profile } = await proposedCard();
  await g.engine.confirmBrandDna(OWNER, confirmed.id, profile.version);
  await assert.rejects(g.engine.requestBrandDna(OWNER, confirmed.id, { commandId: randomUUID(), website: 'quayside.example' }), { status: 409 });
  assert.equal((await g.engine.getBrand(OWNER, confirmed.id)).website, SITE);
  const noAllowance = await newBrand(h, 0, 'Quay Two');
  await assert.rejects(h.engine.requestBrandDna(OWNER, noAllowance.id, { commandId: randomUUID(), website: 'quayside.example' }),
    (error: Error) => /uses a little of your monthly writing allowance/.test(error.message) && !/token/i.test(error.message));
  assert.equal((await h.engine.getBrand(OWNER, noAllowance.id)).website, SITE);
});

test('a page that forwards to another site is not a source, customer-review pages are not read, and "Where we looked" lists only pages kept', async () => {
  for (const path of ['/testimonials', '/reviews', '/case-studies', '/results']) assert.equal(brandPageRank(SITE + path), null, path);
  const h = harness(); seedSite(h); useModel(h, honestCard);
  h.web.set(`${SITE}/`, page('Quay Lettings', HOME_WORDS, '', '<a href="/pricing">Pricing</a><a href="/about">About</a><a href="/join">Join</a><a href="/reviews">Reviews</a>'));
  h.web.set(`${SITE}/join`, page('Join', 'Pay securely with Checkout Corp. Checkout Corp plans start at £5 per month for every merchant on the platform today.'));
  h.web.set(`${SITE}/reviews`, page('Reviews', 'Quay saved me £9,000 in fines last year and I would recommend them to every landlord I know. Five stars from me.'));
  const real = h.web.fetch.bind(h.web);
  h.web.fetch = async (url, options) => { const got = await real(url, options); return /\/join$/.test(url) ? { ...got, finalUrl: 'https://pay.checkout.example/quay' } : got; };
  const transport: FetchTransport = h.web;
  const scan = await buildInventory('b', SITE, transport, { now: h.clock.now(), captureText: true });
  const kept = scan.pages.filter((p) => p.text).map((p) => p.url).sort();
  assert.deepEqual(kept, [`${SITE}/`, `${SITE}/about`, `${SITE}/pricing`]);
  assert.equal(scan.pages.find((p) => p.url === `${SITE}/join`)!.fetchStatus, 'ok', 'the page is still listed as read; only its words are not kept');

  const brand = await newBrand(h); await read(h, brand.id); await work(h);
  const state = await h.engine.brandDna(OWNER, brand.id);
  assert.deepEqual(state.card!.readFrom.map((r) => r.label).sort(), ['About page', 'Home page', 'Pricing page']);
  assert.ok(!(await h.engine.listKnowledge(OWNER, brand.id)).some((d) => /Checkout Corp|saved me £9,000/.test(d.text ?? '')));
  const shown = door((await call(serviceFor(h), identity(OWNER.userId), 'GET', `/portal/seo-blog/b/${brand.id}/dna`)).body);
  assert.doesNotMatch(shown, /Join page|Reviews page/);
});

test('Brand setup’s confirm cannot confirm a website-door card that is out of date, and confirms an older-style profile exactly as before', async () => {
  const { h, brand, profile } = await proposedCard();
  const service = serviceFor(h), owner = identity(OWNER.userId), csrf = portalCsrfToken(SECRET, owner.sessionToken);
  await h.engine.uploadKnowledge(OWNER, brand.id, { category: 'product_facts', title: 'New price list', pastedText: 'Quay Compliance Plan costs £49 per month from January.' });
  assert.equal((await h.engine.brandDna(OWNER, brand.id)).status, 'out_of_date');
  await assert.rejects(h.engine.confirmProfile(OWNER, brand.id, profile.version), (error: Error & { code?: string }) => error.code === 'brand_dna_out_of_date');
  const viaSetup = await call(service, owner, 'POST', `/portal/seo-blog/b/${brand.id}/profile/confirm`, { _csrf: csrf, version: String(profile.version) });
  assert.ok(failed(viaSetup)); assert.equal((await h.engine.getProfile(OWNER, brand.id))!.confirmedAt, null);

  // A profile made the older way, with a question still open: Setup confirms it as it always did, and the door still will not.
  const g = harness();
  useModel(g, (docs, attempt) => ({ ...honestCard(docs, attempt), conflicts: [{ field: 'Service area', detail: 'Kent in one place, Medway in another', documentIds: [docs[0]!.id] }] }));
  const older = await newBrand(g);
  await g.engine.uploadKnowledge(OWNER, older.id, { category: 'product_facts', title: 'About my business', pastedText: DETAILS });
  await g.engine.requestProfileExtraction(OWNER, older.id, { commandId: randomUUID(), baseVersion: 0 }); await work(g);
  const extracted = (await g.engine.getProfile(OWNER, older.id))!;
  assert.equal(extracted.strict, undefined); assert.equal(extracted.conflicts.length, 1);
  await assert.rejects(g.engine.confirmBrandDna(OWNER, older.id, extracted.version), /Choose the right answer/);
  assert.ok((await g.engine.confirmProfile(OWNER, older.id, extracted.version)).confirmedAt);
});

test('Brand setup’s "Extract profile" is sent the prompt it always was and returns what it always did; only the website door asks for quoted sources', async () => {
  const setupPrompt = loadPrompt('seo-blog-profile.md'), doorPrompt = loadPrompt('seo-blog-profile-site.md');
  assert.equal(setupPrompt.header.version, '1.1.0'); assert.equal(setupPrompt.sha256, 'f17838886613cc298a85d4d0422729606c64a94d1c72867c0cfb2c2bda18f94d', 'byte for byte the prompt in use before Brand DNA');
  assert.doesNotMatch(setupPrompt.body, /`sources`|`quote`|`kind`/); assert.equal(doorPrompt.header.stage, setupPrompt.header.stage);
  assert.match(doorPrompt.body, /reviews, testimonials[^.]*\) are NOT the brand's own claims/); assert.match(doorPrompt.body, /Every conflict must give `kind`/);

  const h = harness(); seedSite(h);
  const sent: { system: string; maxTokens: number }[] = [];
  const plainAnswer = (docs: ModelDoc[]) => {
    const { sources: _none, ...card } = honestCard(docs, 1) as Record<string, unknown>;
    return { ...card, audiences: ['Private landlords in Kent', 'Landlords the documents never mention'], approvedClaims: ['We help landlords in Kent', 'A claim with no quote at all'] } as Record<string, unknown>;
  };
  let script: (docs: ModelDoc[]) => Record<string, unknown> = plainAnswer;
  h.llm.complete = async (req) => {
    sent.push({ system: req.system ?? '', maxTokens: req.maxTokens });
    const docs = JSON.parse(/<knowledge_documents>\n([\s\S]*?)\n<\/knowledge_documents>/.exec(req.messages[0]!.content)![1]!) as ModelDoc[];
    return { text: JSON.stringify(script(docs)), tokensIn: 1000, tokensOut: 800, stopReason: 'end_turn', model: 'scripted' };
  };
  const brand = await newBrand(h);
  await h.engine.uploadKnowledge(OWNER, brand.id, { category: 'product_facts', title: 'About my business', pastedText: DETAILS });
  const document = (await h.engine.listKnowledge(OWNER, brand.id))[0]!;
  await h.engine.requestProfileExtraction(OWNER, brand.id, { commandId: randomUUID(), baseVersion: 0 }); await work(h);
  const made = (await h.engine.getProfile(OWNER, brand.id))!;
  assert.equal(sent.length, 1, 'no correction pass: nothing new is rejected on this path'); assert.equal(sent[0]!.system, setupPrompt.body); assert.equal(sent[0]!.maxTokens, 8000);
  const expected = plainAnswer([{ id: document.id, title: document.title, text: document.text! }]);
  for (const key of ['summary', 'audiences', 'positioning', 'offers', 'conversionPages', 'voice', 'approvedClaims', 'exclusions', 'conflicts', 'missingFacts'] as const) assert.deepEqual(made[key], expected[key], key);
  assert.equal(made.strict, undefined); assert.equal('sources' in made, false);
  assert.equal(profilePayload((await h.engine.listJobs(OWNER, brand.id)).find(isProfileJob)!).source.prompt.version, '1.1.0');

  script = (docs) => honestCard(docs, 1);
  await read(h, brand.id); await work(h);
  assert.equal(sent.length, 2); assert.equal(sent[1]!.system, doorPrompt.body); assert.equal(sent[1]!.maxTokens, 16000, 'room for a quoted source per fact');
  const card = (await h.engine.getProfile(OWNER, brand.id))!;
  assert.equal(card.strict, true); assert.equal(card.version, made.version + 1);
  const cardJob = (await h.engine.listJobs(OWNER, brand.id)).filter(isProfileJob).find((j) => profilePayload(j).source.strict)!;
  assert.equal(profilePayload(cardJob).source.prompt.sha256, doorPrompt.sha256);
});

test('two tabs pressed together queue one read and one card', async () => {
  const h = harness(); seedSite(h); useModel(h, honestCard);
  const brand = await newBrand(h);
  const [a, b, c] = await Promise.all([1, 2, 3].map(() => h.engine.requestBrandDna(OWNER, brand.id, { commandId: randomUUID() })));
  assert.equal(a!.id, b!.id); assert.equal(a!.id, c!.id);
  assert.equal((await h.engine.listJobs(OWNER, brand.id)).length, 1);
  await work(h);
  assert.equal(h.llm.calls.length, 1); assert.equal((await h.engine.listJobs(OWNER, brand.id)).filter(isProfileJob).length, 1);
  // Once that read has finished, the next press starts a new one.
  const next = await read(h, brand.id);
  assert.notEqual(next.id, a!.id); assert.equal((await h.engine.listJobs(OWNER, brand.id)).filter(isBrandDnaJob).length, 2);
});

test('wording: verbatim prices are promised only on a website-door card, no dead-end nudge, and an update in progress is not shown as an error', async () => {
  const h = harness(); seedSite(h); useModel(h, (docs, attempt) => { const { sources: _none, ...card } = honestCard(docs, attempt) as Record<string, unknown>; return card; });
  const { brand } = await setupConfirmedBrand(h);
  const service = serviceFor(h), owner = identity(OWNER.userId);
  const older = door((await call(service, owner, 'GET', `/portal/seo-blog/b/${brand.id}/dna`)).body);
  assert.doesNotMatch(older, /Prices are shown exactly as written/); assert.match(older, /Check each price against your own price list before you confirm\./);
  assert.match(older, /2 lines on this card have no recorded source\. Check them yourself before you rely on them\./); assert.doesNotMatch(older, /Read your website again to get a card/);
  assert.match(older, /The card above carries on being used until the new one is ready\. If a new card cannot be made, nothing changes\./);

  const made = await proposedCard();
  const fresh = door((await call(serviceFor(made.h), owner, 'GET', `/portal/seo-blog/b/${made.brand.id}/dna`)).body);
  assert.match(fresh, /Prices are shown exactly as written\. We never work one out\./); assert.match(fresh, /Check each line\. Every one says where we found it\./);

  // The web side updated first and an older reader picked the task up: it holds it, and the page says to come back shortly.
  const g = harness(); seedSite(g); useModel(g, honestCard);
  const waiting = await newBrand(g); const job = await read(g, waiting.id);
  const stored = (await g.store.getJob(waiting.id, job.id))!;
  g.clock.advance(1000);
  await g.store.updateJob({ ...stored, state: 'blocked', error: 'This worker does not support that task stage.', progress: 'Paused until the issue is fixed.', updatedAt: g.clock.now() });
  const updating = door((await call(serviceFor(g), owner, 'GET', `/portal/seo-blog/b/${waiting.id}/dna`)).body);
  assert.match(updating, /This will be ready in a few minutes\. Nothing was changed\./); assert.doesNotMatch(updating, /does not support|worker|task stage/);
  assert.match(updating, /Read my website<\/button>/);
});
