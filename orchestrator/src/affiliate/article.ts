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

/**
 * A product name inside a sentence, in curly quotation marks so the owner-words pass lifts it out untouched: a name
 * such as "OpenAI mug" or "API token case" can never change which sentence the owner is shown (review S7). Quotation
 * marks inside the name are made plain so the quoted span cannot end early.
 */
export function quotedName(name: unknown): string {
  return `“${cleanDisplay(name).replace(/[“”‘’"]/gu, "'") || 'this product'}”`;
}

export const PRODUCT_MESSAGES = Object.freeze({
  count: (kind: ProductArticleKind) => `A ${KIND_LABEL[kind].toLowerCase()} takes ${KIND_LIMITS[kind][0] === KIND_LIMITS[kind][1] ? KIND_LIMITS[kind][0] : `${KIND_LIMITS[kind][0]} to ${KIND_LIMITS[kind][1]}`} products.`,
  topic: 'Say in one line what the article is about.',
  unknownProduct: 'One of the products is no longer available. Open Products again and choose from the list.',
  needsFreshLink: (name: string) => `The link for ${quotedName(name)} was made with a different tracking ID. Add it again from its product page before using it.`,
  duplicateName: 'Two of the products have the same name. Give each one its own name first.',
  sameProduct: 'The same product is chosen twice under two names. Choose it once.',
  noName: 'One of the products has no name that can be shown. Give it a name in Products first.',
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
    if (!name) return { ok: false, reason: PRODUCT_MESSAGES.noName };
    if (!programme.validateLink(p.affiliateUrl, settings.trackingId).ok) return { ok: false, reason: PRODUCT_MESSAGES.needsFreshLink(name) };
    products.push({ productId: p.productId, revision: p.revision, productName: name, merchantName: programme.merchantName, affiliateUrl: p.affiliateUrl,
      infoUrl: p.infoUrl, notes: p.notes ? cleanNotes(p.notes) : null, ownerUsed: p.ownerUsed });
  }
  if (new Set(products.map((p) => p.productName.toLowerCase())).size !== products.length) return { ok: false, reason: PRODUCT_MESSAGES.duplicateName };
  if (new Set(products.map((p) => p.affiliateUrl)).size !== products.length) return { ok: false, reason: PRODUCT_MESSAGES.sameProduct };
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

// ─── What a product article may not say, on any surface a reader sees ──────────
//
// Structural rules rather than a list of phrasings (review M4, S12): any currency amount, any star or "out of 5"
// rating, any percentage off, stock and delivery wording, testing claims, and the shop's address or name as a place
// to buy. Each rule is written so ordinary honest sentences ("a five-star hotel", "prices change, check the page")
// pass. They run at write time (the writer gets one chance to correct) and again in the checks that gate approval.

/** Text as a browser or reader would read it: full-width letters, ideographic full stops and %2E made plain. */
function readable(text: string): string {
  return text.normalize('NFKC').replace(/[。．｡︒]/gu, '.').replace(/%2e/giu, '.').replace(/[​-‍⁠﻿­]/gu, '');
}

/** Words that make a bare amount a price ("only 2.50 ... a bargain", "the price is now 19.99"). */
const PRICE_WORD = 'prices?|priced|pricing|costs?|costing|pay|paying|paid|spend|spending|rrp|retails?|retailing|sale|deals?|offers?|bargain|cheap(?:er|est)?|discount(?:ed|s)?|reduced|pounds?|pence|quid|per (?:pack|unit|item|box)';
const AMOUNT = new RegExp([
  /[£$€¥]\s?\d/u.source, /\b\d[\d,]*(?:\.\d+)?\s?(?:pence|pounds?|quid|gbp|euros?|eur|dollars?|usd|bucks)\b/u.source, /\b(?:gbp|usd|eur|rrp)\s?:?\s?\d/u.source,
  /\b(?:costs?|costing|priced|price[sd]?|for just|for only|reduced to)\s+(?:about\s+|around\s+)?\d+[.,]\d{2}\b/u.source,
  // "only 2.50" or "from 10.30" is a price only with a price word near it: "only 2.50 metres" and "open from 10.30" are not (review S-b).
  `(?<=\\b(?:${PRICE_WORD})\\b(?:[^.!?\\n]|\\.(?=\\d)){0,40})\\b(?:only|just|now|was|from|under|less than)\\s+(?:about\\s+|around\\s+)?\\d+[.,]\\d{2}\\b`,
  `\\b(?:only|just|now|was|from|under|less than)\\s+(?:about\\s+|around\\s+)?\\d+[.,]\\d{2}\\b(?=(?:[^.!?\\n]|\\.(?=\\d)){0,40}\\b(?:${PRICE_WORD})\\b)`,
  /\b(?:a|one|two|three|five|ten|twenty|fifty)?\s?(?:tenner|fiver|quid)\b/u.source, /\brrp\b/u.source,
].join('|'), 'iu');
const DEAL = new RegExp([
  /\b\d{1,3}\s?(?:%|per\s?cent|percent)\s+(?:off|cheaper|less|discount|saving|reduction|lower)\b/u.source,
  // "Save 10% of your phone battery" is a share of something, not a discount, unless the price or cost follows (review S-b).
  /\bsave\s+(?:up to\s+|over\s+)?\d{1,3}\s?(?:%|per\s?cent|percent)(?!\s+of\s+(?:your|the|its|their|our|my|a)\b(?![^.!?\n]{0,25}\b(?:price|cost|rrp|bill)s?\b))/u.source, /\b(?:half|third|quarter)[- ]price\b/u.source, /\bhalf off\b/u.source,
  /\b(?:on sale|sale price|discount(?:ed|s)?|deal of the day|lowest price|cheapest price|price (?:drop|cut)|save £|save up to|bargain|special offer|limited[- ]time offer|clearance)\b/u.source,
  /\b(?:black friday|cyber monday|prime day|boxing day)(?:\s+(?:deals?|sales?|offers?|price))?\b/u.source, /\b(?:great|good|best|top|today'?s|this week'?s|daily|lightning) deals?\b(?!\s+of\b)/u.source,
].join('|'), 'iu');
/** Words that make "4 out of 5" a rating. */
const RATING_WORD = 'stars?|rated|rating|ratings|rates|scored?|scores|reviews?|reviewers?|reviewed|buyers|customers|shoppers|users';
const RATING = new RegExp([
  /\b\d(?:\.\d)?\s?\/\s?(?:5|10)\b/u.source,
  // "N out of 5" is a rating only beside stars, a rating, reviews or buyers: "use 3 out of 5 settings" is not (review S-b).
  `(?<=\\b(?:${RATING_WORD})\\b(?:[^.!?\\n]|\\.(?=\\d)){0,30})\\b(?:\\d(?:\\.\\d)?|one|two|three|four|five)\\s+out of\\s+(?:5|five|10|ten)\\b`,
  `\\b(?:\\d(?:\\.\\d)?|one|two|three|four|five)\\s+out of\\s+(?:5|five|10|ten)\\b(?=(?:[^.!?\\n]|\\.(?=\\d)){0,30}\\b(?:${RATING_WORD})\\b)`,
  // A star rating of something other than the product (energy, food hygiene, a hotel) is not a product rating (review S-b).
  /\b(?:rated|rating of|rates|scores?|scored|gets?|got|given|earns?|earned|has|have|had|with|averag\w*|boasts?)\s+(?:a\s+|an\s+)?(?:\d(?:\.\d)?|one|two|three|four|five)(?:\s+out\s+of\s+(?:5|five))?[- ]?stars?\b(?!\s+(?:energy|efficiency|hygiene|food|safety|fire|hotel|holiday|resort|restaurant|accommodation)\b)/u.source,
  /\b(?:\d(?:\.\d)?|one|two|three|four|five)[- ]stars?\s+(?:rating|ratings|reviews?|from|by|on)\b/u.source, /\bstar ratings?\b/u.source,
  /\b\d[\d,]*\+?\s+(?:customer\s+|happy\s+|positive\s+|verified\s+|glowing\s+|five[- ]star\s+)?(?:reviews|ratings)\b/u.source,
  /\b(?:thousands|hundreds|millions|lots|dozens|plenty) of (?:\w+\s+)?(?:reviews|ratings)\b/u.source,
  /\bbest[- ]?sell(?:er|ers|ing)\b/u.source, /\bamazon'?s choice\b/u.source, /\btop[- ]rated\b/u.source, /#\s?1\s+(?:best|seller|selling|rated)\b/u.source,
].join('|'), 'iu');
const STOCK = new RegExp([
  /(?<!\bkeep(?:s|ing)?\b(?:\s+[\w-]+){0,3}\s+)\bin stock\b/u.source, /\bout of stock\b/u.source, /\blow stock\b/u.source, /\bonly \d+ left\b/u.source, /\bsold out\b/u.source,
  /\bavailable (?:to (?:order|buy)|now|today)\b/u.source, /\b(?:with|via|on|amazon)\s+prime\b|\bprime (?:delivery|shipping|members?)\b/u.source,
  /\b(?:next|same)[- ]day (?:delivery|dispatch|shipping)\b/u.source, /\bfree (?:delivery|shipping|returns)\b(?!\s+(?:is|are)\s+not\b|\s+(?:isn't|aren't|cannot|can't)\b)/u.source,
  /\b(?:arrives?|arriving|delivered|delivery|ships?|shipped|dispatch(?:ed|es)?)\b[^.!?\n]{0,30}\b(?:today|tomorrow|next day|the next day|same day|within \d+)\b/u.source,
].join('|'), 'iu');
const TESTER = "(?:we|i|our team|our experts|our editors|my team|the team)(?:'ve| have| had)?";
/** What a testing claim is about: the products themselves (it, them, each, these, a count of them, "the products"). */
const TESTED_THING = '(?:it|them|each|every|all|both|everything|these|those|this one|that one|one|ones|\\d+|two|three|four|five|six|seven|eight|nine|ten|dozens|several|many|lots|hundreds|(?:the|our|my) (?:[\\w-]+\\s+){0,2}?(?:products?|items?|picks|kit|models?|brands?|versions?|ones|lot|range|choices|recommendations))\\b';
/** Reviewing or checking the products against their manuals or the official advice is reading, not testing. */
const NOT_DOCUMENTS = "(?!\\s+(?:against|with)\\s+(?:the\\s+|their\\s+|its\\s+|our\\s+)?(?:[\\w'-]+\\s+){0,2}(?:manuals?|instructions|guidance|advice|specs?|specifications|labels?|listings?|websites?|leaflets?|details|information|documents?|paperwork|data)\\b)";
const TESTED = new RegExp([
  // "We tested/reviewed/checked" is a claim about the products only when what follows is them: "we tested the smoke alarm
  // button every month" or "I have reviewed the government advice" is not (review S-b). Product names are added per call.
  `\\b${TESTER}\\s+(?:\\w+\\s+)?(?:tested|trialled)\\s+${TESTED_THING}`, `\\b${TESTER}\\s+(?:\\w+\\s+)?put (?:it|them) through\\b`,
  `\\b${TESTER}\\s+(?:\\w+\\s+)?(?:reviewed|checked)\\s+${TESTED_THING}${NOT_DOCUMENTS}`,
  /\b(?:tested|reviewed|checked|trialled|vetted) by (?:us|our|me|experts?|the team|real)\b/u.source, /\bhands[- ]on (?:test|testing|review)\b/u.source,
  /\bour (?:tests|testing|lab|verdict|reviewers?)\b/u.source, /\b(?:independently|lab|expert)[- ]tested\b/u.source, /\b(?:we|i) tried (?:it|them|each|every)\b/u.source,
].join('|'), 'iu');
/** The shop's address in any spelling, or the shop named as a place to buy. */
const MERCHANT = /\bamazon\s?\.\s?(?:co\s?\.\s?uk|com|[a-z]{2,3})\b|\bamzn\s?\.\s?[a-z]{2,4}\b|\ba\.co\/|\bamzlink\.to\b|\b(?:on|at|from|via|through|in|buy it on|order (?:it )?on)\s+amazon\b(?!\s+(?:rainforest|river|basin))/iu;
const FIRST_HAND = /\b(?:i(?:'ve| have)? (?:used|use|owned|own|bought|tried)|in my experience|we(?:'ve| have)? (?:used|been using|tried))\b/iu;

/** Short links and redirect services: never in a product article (no cloaking; the reader sees where a link goes). */
const SHORTENERS = new Set(['amzn.to', 'amzn.eu', 'amzn.asia', 'amzn.com', 'amzn.co.uk', 'a.co', 'amzlink.to', 'bit.ly', 'bitly.com', 'tinyurl.com', 't.co', 'goo.gl', 'ow.ly', 'is.gd', 'buff.ly',
  'rebrand.ly', 'cutt.ly', 'shorturl.at', 'tiny.cc', 'rb.gy', 'lnkd.in', 'tr.im', 'v.gd', 'bl.ink', 'short.io', 'geni.us', 'linktr.ee', 'shrsl.com', 'go.skimresources.com', 'redirect.viglink.com', 'rstyle.me']);
/** Affiliate networks: their links pay someone, so they are made by code or not at all. */
const AFFILIATE_NETWORKS = /(?:^|\.)(?:awin1\.com|linksynergy\.com|anrdoezrs\.net|jdoqocy\.com|tkqlhce\.com|dpbolvw\.net|kqzyfj\.com|shareasale\.com|prf\.hn|webgains\.com|tradedoubler\.com|clkuk\.tradedoubler\.com|avantlink\.com|impact\.com|sjv\.io|pxf\.io|ojrq\.net|go2cloud\.org|skimlinks\.com|viglink\.com|rover\.ebay\.com)$/u;
/** Query names that carry a commission or send the reader on somewhere else. */
const AFFILIATE_PARAMS = new Set(['tag', 'linkcode', 'linkid', 'ascsubtag', 'creative', 'creativeasin', 'camp', 'campid', 'customid', 'mkcid', 'mkrid', 'mkevt', 'toolid', 'affid', 'aff_id', 'aff',
  'affiliate', 'affiliate_id', 'affiliateid', 'awinmid', 'awinaffid', 'clickref', 'irclickid', 'irgwc', 'ranmid', 'raneaa', 'ransiteid', 'cjevent', 'partnerid', 'ref_id', 'subid', 'sub_id', 'u1']);
const REDIRECT_PARAMS = new Set(['to', 'url', 'u', 'redirect', 'redirect_url', 'redirect_uri', 'redirecturl', 'dest', 'destination', 'target', 'location', 'goto', 'out', 'link', 'murl', 'r']);

/** True for any host of the Amazon family: amazon.<any country>, amzn.<any>, a.co, amzlink.to and their subdomains, and Amazon's own image and ad hosts. */
export function isAmazonFamilyHost(host: string): boolean {
  const h = readable(host).toLowerCase().replace(/\.+$/u, '');
  if (/(?:^|\.)(?:amazon|amzn)\.(?:[a-z]{2,6}|(?:co|com|org|net|ac|ne|or)\.[a-z]{2})$/u.test(h)) return true;
  return /(?:^|\.)(?:a\.co|amzlink\.to|amazon-adsystem\.com|media-amazon\.com|images-amazon\.com|ssl-images-amazon\.com|amazon\.co\.uk)$/u.test(h);
}

/** Why a link someone typed into the text may not appear in a product article, or null. Parsed as a browser reads it. */
export function shopLinkProblem(raw: string): 'shop' | 'short' | 'redirect' | 'paid' | null {
  let url: URL;
  try { url = new URL(readable(raw.trim())); } catch { return null; }
  if (!/^https?:$/u.test(url.protocol)) return null;
  const host = url.hostname.toLowerCase().replace(/\.+$/u, '');
  if (isAmazonFamilyHost(host)) return 'shop';
  const labels = host.split('.');
  const registrable = labels.length >= 3 && ['co', 'com', 'org', 'net', 'ac'].includes(labels[labels.length - 2]!) ? labels.slice(-3).join('.') : labels.slice(-2).join('.');
  if (SHORTENERS.has(host) || SHORTENERS.has(registrable)) return 'short';
  if (AFFILIATE_NETWORKS.test(host)) return 'paid';
  for (const [key, value] of url.searchParams) {
    const k = key.trim().toLowerCase();
    if (AFFILIATE_PARAMS.has(k)) return 'paid';
    if (REDIRECT_PARAMS.has(k) && value.trim()) return 'redirect';
  }
  return null;
}

/** The web addresses written in a text: Markdown links, bare addresses and www. addresses. */
export function addressesIn(text: string): string[] {
  const t = readable(text);
  const out: string[] = [];
  for (const m of t.matchAll(/\]\(\s*<?([^)\s>]+)>?/gu)) out.push(m[1]!);
  for (const m of t.matchAll(/\b(?:https?:\/\/|www\.)[^\s<>()"'\]]+/giu)) out.push(/^www\./iu.test(m[0]) ? `https://${m[0]}` : m[0]);
  return out.map((u) => u.replace(/[.,;:!?]+$/u, ''));
}

/** An address with every commission or tracking parameter removed (cited sources never carry anyone's tag). */
export function withoutAffiliateParams(raw: string): string {
  try {
    const url = new URL(raw);
    for (const key of [...url.searchParams.keys()]) if (AFFILIATE_PARAMS.has(key.trim().toLowerCase()) || /^utm_/iu.test(key)) url.searchParams.delete(key);
    return url.toString();
  } catch { return raw; }
}

/** A research source a product article may cite: never the shop itself (any of its addresses), a short link, a redirect or a paid link; tracking parameters are removed first. */
export function usableProductSource(url: string): boolean {
  try { new URL(url); } catch { return false; }
  return shopLinkProblem(withoutAffiliateParams(url)) === null;
}

type TextRule = 'raw_merchant_link' | 'price_stated' | 'rating_or_stock' | 'untested_claim';
/** What one piece of reader-facing text breaks, in a fixed order. */
export function textRuleBreaks(text: string, productNames: readonly string[] = []): TextRule[] {
  const t = readable(text);
  const out: TextRule[] = [];
  if (MERCHANT.test(t) || addressesIn(t).some((u) => shopLinkProblem(u) !== null)) out.push('raw_merchant_link');
  if (AMOUNT.test(t) || DEAL.test(t)) out.push('price_stated');
  if (RATING.test(t) || STOCK.test(t)) out.push('rating_or_stock');
  if (TESTED.test(t) || testedByName(productNames)?.test(t)) out.push('untested_claim');
  return out;
}

const NAME_STOP = new Set(['the', 'and', 'for', 'with', 'from', 'pack', 'set', 'kit', 'new', 'one', 'two', 'all', 'our', 'your', 'this', 'that', 'its', 'their', 'size', 'large', 'small', 'black', 'white']);
const namedCache = new Map<string, RegExp | null>();
/** "We tested the torch": a testing claim about a product named by a word of its name (the heading of its part). */
function testedByName(names: readonly string[]): RegExp | null {
  const words = [...new Set(names.flatMap((n) => readable(n).toLowerCase().split(/[^\p{L}\p{N}]+/u)).filter((w) => w.length >= 3 && !NAME_STOP.has(w) && !/^\d+$/u.test(w)))].sort();
  if (!words.length) return null;
  const key = words.join('|');
  if (!namedCache.has(key)) {
    if (namedCache.size > 200) namedCache.clear();
    const noun = `(?:${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|')})(?:e?s)?`;
    namedCache.set(key, new RegExp([
      `\\b${TESTER}\\s+(?:\\w+\\s+)?(?:tested|trialled)\\s+(?:the|our|my|this|that|each|every|both)\\s+(?:[\\w-]+\\s+){0,3}?${noun}\\b`,
      `\\b${TESTER}\\s+(?:\\w+\\s+)?(?:reviewed|checked)\\s+(?:the|our|my|this|that|each|every|both)\\s+(?:[\\w-]+\\s+){0,3}?${noun}\\b${NOT_DOCUMENTS}`,
    ].join('|'), 'iu'));
  }
  return namedCache.get(key)!;
}

/** A website's host as Amazon lists it: lower case, no "www.", no trailing dot (null when it cannot be read). */
export function siteHost(url: string | null | undefined): string | null {
  try { return url ? new URL(url).hostname.toLowerCase().replace(/\.+$/u, '').replace(/^www\./u, '') || null : null; } catch { return null; }
}

/**
 * Review P1: Amazon only allows its links on the websites listed in the owner's Associates account, so an article with
 * product links may only be published on the website saved with the owner's Amazon UK details. Null when it may; the
 * plain reason, naming both websites, when it may not. A version with no product links carries no paid link.
 */
export function affiliateSiteProblem(pageUrl: string | null | undefined, affiliate: Pick<ArticleAffiliate, 'registeredSite' | 'links'> | null | undefined): string | null {
  if (!affiliate?.links.length) return null;
  const page = siteHost(pageUrl), registered = siteHost(affiliate.registeredSite);
  if (page && registered && page === registered) return null;
  return `This article has Amazon product links, so it can only go on ${registered ?? 'the website saved with your Amazon UK details'}, the website saved with your Amazon UK details. `
    + `It was set to go on ${page ?? 'a website we could not read'}. Choose ${registered ?? 'that website'} instead, or remove the product links. `
    + 'If you have added this other website to your Amazon account, change the website in your Amazon UK details in Settings first.';
}

/** Every surface of an article a reader sees (on the page, in search results, in a link preview), with where it is. */
export function readerSurfaces(b: { readonly title: string; readonly seoTitle: string; readonly metaDescription: string; readonly excerpt: string; readonly image: { readonly alt: string };
  readonly intro: string; readonly conclusion: string; readonly sections: readonly { readonly heading: string; readonly body: string }[]; readonly faqs: readonly { readonly q: string; readonly a: string }[];
  readonly cta?: { readonly label: string } | null }): { readonly where: string; readonly text: string }[] {
  return [
    { where: 'Title', text: b.title }, { where: 'Title in search results', text: b.seoTitle }, { where: 'Description in search results', text: b.metaDescription },
    { where: 'Summary', text: b.excerpt }, { where: 'Picture description', text: b.image.alt }, { where: 'Opening', text: b.intro },
    ...b.sections.map((s) => ({ where: `Section ${quotedName(s.heading)}`, text: `${s.heading}\n${s.body}` })),
    ...b.faqs.map((f, i) => ({ where: `Question ${i + 1}`, text: `${f.q}\n${f.a}` })), { where: 'Closing', text: b.conclusion },
    ...(b.cta ? [{ where: 'Button', text: b.cta.label }] : []),
  ];
}

const RULE_FOR_WRITER: Record<TextRule, string> = {
  raw_merchant_link: 'Remove every shop address, shop name used as a place to buy, short link or buying link; the system adds the buying links.',
  price_stated: 'Remove every price, amount, discount or deal.',
  rating_or_stock: 'Remove every star rating, review count, best-seller claim, stock level or delivery promise.',
  untested_claim: 'Remove every claim that the products were tested or reviewed.',
};

/** Problems with a written product article (the writer gets one chance to correct them). Every reader surface is read. */
export function productArticleProblems(v: { readonly title?: string; readonly seo_title?: string; readonly meta_description?: string; readonly excerpt?: string; readonly image_alt?: string;
  readonly sections: readonly { readonly heading: string; readonly body: string }[]; readonly intro: string; readonly conclusion: string; readonly faqs: readonly { readonly q?: string; readonly a: string }[] }, p: BriefProducts): string[] {
  const problems: string[] = [];
  for (const product of p.products) {
    const n = v.sections.filter((s) => s.heading.trim().toLowerCase() === product.productName.toLowerCase()).length;
    if (n !== 1) problems.push(`Write exactly one section whose heading is exactly "${product.productName}".`);
  }
  const surfaces = readerSurfaces({ title: v.title ?? '', seoTitle: v.seo_title ?? '', metaDescription: v.meta_description ?? '', excerpt: v.excerpt ?? '', image: { alt: v.image_alt ?? '' },
    intro: v.intro, conclusion: v.conclusion, sections: v.sections, faqs: v.faqs.map((f) => ({ q: f.q ?? '', a: f.a })) });
  const broken = new Map<TextRule, string[]>();
  const names = [...p.products.map((x) => x.productName), ...v.sections.map((x) => x.heading)];
  for (const s of surfaces) for (const rule of textRuleBreaks(s.text, names)) broken.set(rule, [...(broken.get(rule) ?? []), s.where]);
  for (const [rule, where] of broken) problems.push(`${RULE_FOR_WRITER[rule]} (in: ${[...new Set(where)].slice(0, 6).join(', ')})`);
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
  // Links made for another website count as changed: the publish gate judges the website saved in the version (review P1).
  const otherSite = Boolean(settings) && siteHost(affiliate.registeredSite) !== siteHost(settings!.registeredSite);
  return affiliate.links.map((l) => {
    const p = catalogue.find((x) => x.productId === l.productId);
    if (!p || p.status === 'retired') return { productId: l.productId, name: l.name, state: 'retired' as const };
    const ok = Boolean(settings && programme?.validateLink(p.affiliateUrl, settings.trackingId).ok && programme.validateLink(l.url, settings.trackingId).ok);
    return { productId: l.productId, name: l.name, state: ok && !otherSite && p.affiliateUrl === l.url ? 'current' as const : 'changed' as const };
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

const ISSUE_TEXT: Record<TextRule, { message: string; fix: string }> = {
  raw_merchant_link: { message: 'The text contains a shop address, a short or redirect link, a paid link, or names the shop as the place to buy. Buying links are added by the system, with the label readers need.', fix: 'Remove the shop address, link or shop name from the text.' },
  price_stated: { message: 'The text states a price, an amount or a deal. Prices change and may only come from the shop itself.', fix: 'Remove the price or deal.' },
  rating_or_stock: { message: 'The text mentions ratings, reviews, best sellers, stock or delivery, which may only come from the shop itself.', fix: 'Remove the rating, stock or delivery wording.' },
  untested_claim: { message: 'The text says the products were tested or reviewed. Only say what you know.', fix: 'Remove the testing claim.' },
};

/**
 * Critical issues for a product article; every one blocks approval. A product article is one whose body carries
 * product links or whose brief has products (`productArticle`): the text rules apply to both, on every surface a
 * reader sees, even once every link was removed (review M4, S3).
 */
export function affiliateIssues(body: { readonly affiliate?: ArticleAffiliate; readonly title: string; readonly seoTitle: string; readonly metaDescription: string; readonly excerpt: string; readonly image: { readonly alt: string };
  readonly intro: string; readonly conclusion: string; readonly sections: readonly { readonly id: string; readonly heading: string; readonly body: string }[]; readonly faqs: readonly { readonly q: string; readonly a: string }[];
  readonly cta?: { readonly label: string; readonly url: string } | null; readonly citations?: readonly { readonly url: string; readonly public?: boolean }[] }, website: string | null, productArticle = false): AffiliateIssue[] {
  const a = body.affiliate;
  const linked = Boolean(a?.links.length);
  if (!linked && !productArticle) return [];
  const out: AffiliateIssue[] = [];
  const names = [...(a?.links ?? []).map((l) => l.name), ...body.sections.map((x) => x.heading)];
  for (const s of readerSurfaces(body)) for (const rule of textRuleBreaks(s.text, names)) out.push({ code: `affiliate.${rule}`, ...ISSUE_TEXT[rule], location: s.where });
  // The button's own address and every cited source: never the shop, a short link or a paid link (review M5).
  if (body.cta && shopLinkProblem(body.cta.url)) out.push({ code: 'affiliate.raw_merchant_link', ...ISSUE_TEXT.raw_merchant_link, location: 'Button' });
  for (const c of body.citations ?? []) if (shopLinkProblem(c.url)) out.push({ code: 'affiliate.source_is_shop', message: 'One of the sources is the shop itself, a short link or a paid link. Sources must be independent pages.', fix: 'Write the article again so its research is done afresh.', location: 'Sources' });
  if (!a || !linked) return out;
  const programme = programmeFor(a.programme);
  for (const l of a.links) {
    if (!programme || !programme.validateLink(l.url).ok) out.push({ code: 'affiliate.link_invalid', message: `The link for ${quotedName(l.name)} is not in the form we make. Update the links.`, fix: 'Update the links, or remove this one.', location: null });
    const s = body.sections.find((x) => x.id === l.sectionId);
    if (s && !l.ownerUsed && FIRST_HAND.test(readable(s.body))) out.push({ code: 'affiliate.untested_claim', message: `The part about ${quotedName(l.name)} speaks of using it, but you have not said you used it.`, fix: 'Remove the first-hand wording, or tick "I have used this myself" on the product.', location: `Section ${quotedName(s.heading)}` });
  }
  const site = (() => { try { return website ? new URL(website).hostname.replace(/^www\./u, '') : null; } catch { return null; } })();
  const registered = (() => { try { return new URL(a.registeredSite).hostname.replace(/^www\./u, ''); } catch { return null; } })();
  if (!site || site !== registered) out.push({ code: 'affiliate.site_mismatch', message: 'This business\'s website is not the one saved with your Amazon UK details, so these links may not be allowed here.', fix: 'Check the website in your Amazon UK details in Settings.', location: null });
  return out;
}
