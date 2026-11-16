/**
 * Product articles (Affiliate Studio, slice 1, release 2): a product article is a one-article plan with products
 * attached, written by the existing article engine. Links and the disclosure are structured data on the article body
 * (`body.affiliate`), never in the prose the writer produces or the owner edits; code renders them (render.ts here).
 *
 * Pure: no I/O. The engine calls these when AFFILIATE_STUDIO has handed it a product snapshot read in the owner's
 * session (the worker has no owner session, so the snapshot is taken at request time).
 */

import { programmeFor, type ProgrammeId } from './programmes.js';
import type { AffiliateProduct, ProgrammeSettings } from './product-store.js';

export type ProductArticleKind = 'buying_guide' | 'comparison' | 'shopping_list';
/** How many products each kind takes. */
export const KIND_LIMITS: Readonly<Record<ProductArticleKind, readonly [number, number]>> = Object.freeze({ buying_guide: [1, 6], comparison: [2, 4], shopping_list: [3, 15] });
export const KIND_LABEL: Readonly<Record<ProductArticleKind, string>> = Object.freeze({ buying_guide: 'Buying guide', comparison: 'Comparison', shopping_list: 'Shopping list' });

/** One product as it stood when the owner asked for the article. */
export interface ProductSnapshot {
  readonly productId: string;
  readonly revision: number;
  readonly productName: string;
  readonly merchantName: string;
  readonly affiliateUrl: string;
  readonly infoUrl: string | null;
  readonly notes: string | null;
  readonly ownerUsed: boolean;
}

/** `ArticleBrief.products`: what the writer is given (jsonb on the brief). */
export interface BriefProducts {
  readonly schema: 1;
  readonly programme: ProgrammeId;
  readonly kind: ProductArticleKind;
  readonly topic: string;
  readonly trackingId: string;
  readonly registeredSite: string;
  readonly products: readonly ProductSnapshot[];
}

/** One rendered link, bound to the part of the article about that product. */
export interface AffiliateLink {
  readonly productId: string;
  readonly revision: number;
  readonly name: string;
  readonly url: string;
  readonly sectionId: string;
  readonly ownerUsed: boolean;
}
/** `ArticleBody.affiliate`: inside the content hash, so approval binds to the exact links. */
export interface ArticleAffiliate {
  readonly programme: ProgrammeId;
  readonly disclosureVersion: string;
  readonly registeredSite: string;
  readonly links: readonly AffiliateLink[];
}

/** Invisible and direction-changing characters, markup brackets and controls out; single spaces. For anything a product name or note shows. */
export function cleanDisplay(text: unknown, max = 200): string {
  if (typeof text !== 'string') return '';
  return text.normalize('NFKC').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/[<>]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, max);
}
/** Notes keep their line breaks; everything else as cleanDisplay. */
export function cleanNotes(text: unknown, max = 2000): string {
  if (typeof text !== 'string') return '';
  return text.normalize('NFKC').split(/\r?\n/u).map((line) => line.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/[<>]/gu, ' ').replace(/\s+/gu, ' ').trim()).filter(Boolean).join('\n').slice(0, max);
}

export const PRODUCT_MESSAGES = Object.freeze({
  count: (kind: ProductArticleKind) => `A ${KIND_LABEL[kind].toLowerCase()} takes ${KIND_LIMITS[kind][0] === KIND_LIMITS[kind][1] ? KIND_LIMITS[kind][0] : `${KIND_LIMITS[kind][0]} to ${KIND_LIMITS[kind][1]}`} products.`,
  topic: 'Say in one line what the article is about.',
  unknownProduct: 'One of the products is no longer available. Open Products again and choose from the list.',
  needsFreshLink: (name: string) => `The link for ${name} was made with a different tracking ID. Add it again from its product page before using it.`,
  duplicateName: 'Two of the products have the same name. Give each one its own name first.',
});

/** The products the owner ticked, checked and frozen for the brief. Links are checked again against the saved tracking ID. */
export function productSnapshot(input: { kind: unknown; topic: unknown; productIds: readonly unknown[] }, catalogue: readonly AffiliateProduct[], settings: ProgrammeSettings):
  { ok: true; value: BriefProducts } | { ok: false; reason: string } {
  const kind = typeof input.kind === 'string' && input.kind in KIND_LIMITS ? input.kind as ProductArticleKind : null;
  if (!kind) return { ok: false, reason: 'Choose what kind of article to write.' };
  const topic = cleanDisplay(input.topic, 200);
  if (topic.length < 3) return { ok: false, reason: PRODUCT_MESSAGES.topic };
  const ids = [...new Set(input.productIds.filter((x): x is string => typeof x === 'string'))];
  const [min, max] = KIND_LIMITS[kind];
  if (ids.length < min || ids.length > max) return { ok: false, reason: PRODUCT_MESSAGES.count(kind) };
  const programme = programmeFor(settings.programme);
  if (!programme) return { ok: false, reason: PRODUCT_MESSAGES.unknownProduct };
  const products: ProductSnapshot[] = [];
  for (const id of ids) {
    const p = catalogue.find((x) => x.productId === id && x.status === 'active' && x.programme === settings.programme);
    if (!p) return { ok: false, reason: PRODUCT_MESSAGES.unknownProduct };
    const name = cleanDisplay(p.productName);
    if (!programme.validateLink(p.affiliateUrl, settings.trackingId).ok) return { ok: false, reason: PRODUCT_MESSAGES.needsFreshLink(name || 'one product') };
    products.push({ productId: p.productId, revision: p.revision, productName: name, merchantName: programme.merchantName, affiliateUrl: p.affiliateUrl,
      infoUrl: p.infoUrl, notes: p.notes ? cleanNotes(p.notes) : null, ownerUsed: p.ownerUsed });
  }
  if (new Set(products.map((p) => p.productName.toLowerCase())).size !== products.length) return { ok: false, reason: PRODUCT_MESSAGES.duplicateName };
  return { ok: true, value: { schema: 1, programme: programme.id, kind, topic, trackingId: settings.trackingId, registeredSite: settings.registeredSite, products } };
}

/** What the brief carries for the writer, built in code (no planning call). */
export function productBriefFields(p: BriefProducts): { workingTitle: string; targetQuery: string; searchIntent: 'buy' | 'compare'; outline: string[]; keyPoints: string[]; angle: string; whyFit: string } {
  const names = p.products.map((x) => x.productName);
  return {
    workingTitle: p.topic,
    targetQuery: p.topic,
    searchIntent: p.kind === 'comparison' ? 'compare' : 'buy',
    outline: names,
    keyPoints: p.products.filter((x) => x.notes).map((x) => `${x.productName}: what the owner knows about it is in the products data.`).slice(0, 15),
    angle: p.kind === 'comparison' ? 'A fair comparison that helps the reader choose' : p.kind === 'shopping_list' ? 'A practical list of what to get and why' : 'A plain guide to choosing well',
    whyFit: 'Products the business has chosen to recommend.',
  };
}

/** The data block the writer sees: names and the owner's own words only. No link, no price, no rating. */
export function productsForWriter(p: BriefProducts): Record<string, unknown> {
  return {
    article_kind: KIND_LABEL[p.kind], topic: p.topic,
    products: p.products.map((x) => ({ name: x.productName, sold_by: x.merchantName, what_the_owner_knows: x.notes ?? '', owner_has_used_it: x.ownerUsed })),
  };
}

/** Rules added in code to the writer's instructions for a product article (the pinned prompt file is unchanged). */
export const PRODUCT_RULES = [
  'This is a product article. Write exactly one section per product, in the order given, and make each section heading exactly the product name as supplied.',
  'Never write a link, address or shop name for buying a product, and never mention where to buy it: the buying links are added by the system after you write.',
  'Never state a price, discount, deal, saving, stock level, delivery time, star rating, review count, "best seller", "Amazon\'s Choice" or anything similar.',
  'Only say what the product is and does from its name, the owner\'s own words and cited research. Do not claim anyone tested it.',
  'Write in the first person about using a product only where owner_has_used_it is true, and then only what the owner\'s words support.',
].join('\n');

const MERCHANT_IN_TEXT = /\bamazon\.(?:co\.uk|com|[a-z]{2,3})\b|\bamzn\.(?:to|eu|com)\b|\ba\.co\//iu;

/** Problems with a written product article (the writer gets one chance to correct them). */
export function productArticleProblems(v: { readonly sections: readonly { readonly heading: string; readonly body: string }[]; readonly intro: string; readonly conclusion: string; readonly faqs: readonly { readonly a: string }[] }, p: BriefProducts): string[] {
  const problems: string[] = [];
  for (const product of p.products) {
    const n = v.sections.filter((s) => s.heading.trim().toLowerCase() === product.productName.toLowerCase()).length;
    if (n !== 1) problems.push(`Write exactly one section whose heading is exactly "${product.productName}".`);
  }
  const text = [v.intro, ...v.sections.map((s) => s.body), v.conclusion, ...v.faqs.map((f) => f.a)].join('\n');
  if (MERCHANT_IN_TEXT.test(text)) problems.push('Remove every shop address or buying link; the system adds the buying links.');
  return problems;
}

/** The links, bound in code to the section about each product. */
export function bindAffiliate(sections: readonly { readonly id: string; readonly heading: string }[], p: BriefProducts): ArticleAffiliate {
  const programme = programmeFor(p.programme)!;
  const links: AffiliateLink[] = [];
  for (const product of p.products) {
    const section = sections.find((s) => s.heading.trim().toLowerCase() === product.productName.toLowerCase());
    if (!section || !programme.validateLink(product.affiliateUrl, p.trackingId).ok) continue;
    links.push({ productId: product.productId, revision: product.revision, name: product.productName, url: product.affiliateUrl, sectionId: section.id, ownerUsed: product.ownerUsed });
  }
  return { programme: programme.id, disclosureVersion: programme.disclosure.version, registeredSite: p.registeredSite, links };
}

/** After an edit: links whose part was deleted go; the rest are kept exactly. */
export function pruneAffiliate(affiliate: ArticleAffiliate | undefined, sections: readonly { readonly id: string }[]): ArticleAffiliate | undefined {
  if (!affiliate) return undefined;
  const ids = new Set(sections.map((s) => s.id));
  return { ...affiliate, links: affiliate.links.filter((l) => ids.has(l.sectionId)) };
}

/** Each link against the current catalogue and tracking ID: what changed, what is retired, what is fine. */
export function linkStatus(affiliate: ArticleAffiliate, catalogue: readonly AffiliateProduct[], settings: ProgrammeSettings | null): { productId: string; name: string; state: 'current' | 'changed' | 'retired' }[] {
  const programme = programmeFor(affiliate.programme);
  return affiliate.links.map((l) => {
    const p = catalogue.find((x) => x.productId === l.productId);
    if (!p || p.status === 'retired') return { productId: l.productId, name: l.name, state: 'retired' as const };
    const ok = Boolean(settings && programme?.validateLink(p.affiliateUrl, settings.trackingId).ok && programme.validateLink(l.url, settings.trackingId).ok);
    return { productId: l.productId, name: l.name, state: ok && p.affiliateUrl === l.url ? 'current' as const : 'changed' as const };
  });
}

/** The links brought up to date: current links for active products with a valid link; retired ones removed. */
export function refreshedAffiliate(affiliate: ArticleAffiliate, catalogue: readonly AffiliateProduct[], settings: ProgrammeSettings): ArticleAffiliate {
  const programme = programmeFor(affiliate.programme)!;
  const links = affiliate.links.flatMap((l) => {
    const p = catalogue.find((x) => x.productId === l.productId && x.status === 'active');
    if (!p || !programme.validateLink(p.affiliateUrl, settings.trackingId).ok) return [];
    return [{ ...l, revision: p.revision, url: p.affiliateUrl, ownerUsed: p.ownerUsed }];
  });
  return { ...affiliate, registeredSite: settings.registeredSite, links };
}

export interface AffiliateIssue { readonly code: string; readonly message: string; readonly fix: string; readonly location: string | null }

const PRICE = /£\s?\d|\b\d+(?:\.\d{2})?\s?(?:pounds|gbp)\b|\b\d{1,3}\s?% off\b|\b(?:on sale|discount(?:ed)?|deal of the day|lowest price|cheapest price|price drop|save £)\b/iu;
const RATING_OR_STOCK = /\b(?:\d(?:\.\d)?\s?(?:out of|\/)\s?5|\d(?:\.\d)?[- ]stars?|five[- ]star|star rating|\d[\d,]*\s+(?:customer\s+)?(?:reviews|ratings)|in stock|out of stock|ships? (?:today|tomorrow|free)|next[- ]day delivery|free delivery|prime delivery|best[- ]?seller|amazon'?s choice)\b/iu;
const TESTED = /\b(?:we|i)(?:'ve| have)? (?:tested|reviewed|trialled|put (?:it|them) through)\b|\bhands[- ]on (?:test|review)\b|\bour (?:tests|testing|lab)\b|\bindependently tested\b/iu;
const FIRST_HAND = /\b(?:i(?:'ve| have)? (?:used|use|owned|own|bought|tried)|in my experience|we(?:'ve| have)? (?:used|been using|tried))\b/iu;

/** Critical issues for a product article; every one blocks approval. */
export function affiliateIssues(body: { readonly affiliate?: ArticleAffiliate; readonly intro: string; readonly conclusion: string; readonly sections: readonly { readonly id: string; readonly heading: string; readonly body: string }[]; readonly faqs: readonly { readonly q: string; readonly a: string }[] }, website: string | null): AffiliateIssue[] {
  const a = body.affiliate;
  if (!a || !a.links.length) return [];
  const programme = programmeFor(a.programme);
  const out: AffiliateIssue[] = [];
  const blocks = [{ where: 'Opening', text: body.intro }, ...body.sections.map((s) => ({ where: `Section “${s.heading}”`, text: `${s.heading}\n${s.body}`, id: s.id })),
    ...body.faqs.map((f, i) => ({ where: `Question ${i + 1}`, text: `${f.q}\n${f.a}` })), { where: 'Closing', text: body.conclusion }];
  for (const b of blocks) {
    if (MERCHANT_IN_TEXT.test(b.text)) out.push({ code: 'affiliate.raw_merchant_link', message: 'The text contains a shop address. Buying links are added by the system, with the label readers need.', fix: 'Remove the shop address from the text.', location: b.where });
    if (PRICE.test(b.text)) out.push({ code: 'affiliate.price_stated', message: 'The text states a price or a deal. Prices change and may only come from the shop itself.', fix: 'Remove the price or deal.', location: b.where });
    if (RATING_OR_STOCK.test(b.text)) out.push({ code: 'affiliate.rating_or_stock', message: 'The text mentions ratings, reviews, stock or delivery, which may only come from the shop itself.', fix: 'Remove the rating, stock or delivery wording.', location: b.where });
    if (TESTED.test(b.text)) out.push({ code: 'affiliate.untested_claim', message: 'The text says the products were tested. Only say what you know.', fix: 'Remove the testing claim.', location: b.where });
  }
  for (const l of a.links) {
    if (!programme || !programme.validateLink(l.url).ok) out.push({ code: 'affiliate.link_invalid', message: `The link for ${cleanDisplay(l.name)} is not in the form we make. Update the links.`, fix: 'Update the links, or remove this one.', location: null });
    const s = body.sections.find((x) => x.id === l.sectionId);
    if (s && !l.ownerUsed && FIRST_HAND.test(s.body)) out.push({ code: 'affiliate.untested_claim', message: `The part about ${cleanDisplay(l.name)} speaks of using it, but you have not said you used it.`, fix: 'Remove the first-hand wording, or tick "I have used this myself" on the product.', location: `Section “${s.heading}”` });
  }
  const site = (() => { try { return website ? new URL(website).hostname.replace(/^www\./u, '') : null; } catch { return null; } })();
  const registered = (() => { try { return new URL(a.registeredSite).hostname.replace(/^www\./u, ''); } catch { return null; } })();
  if (!site || site !== registered) out.push({ code: 'affiliate.site_mismatch', message: 'This business\'s website is not the one saved with your Amazon UK details, so these links may not be allowed here.', fix: 'Check the website in your Amazon UK details in Settings.', location: null });
  return out;
}
