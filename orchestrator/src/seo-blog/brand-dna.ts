/**
 * Brand DNA from a website address: the pure rules.
 *
 * The owner pastes an address; the existing website read keeps the words of the
 * few pages that describe the business; each page becomes an ordinary versioned
 * brand document; the existing profile extraction then proposes a card. Nothing
 * here calls a model, the network or the database.
 *
 * The model that reads the site is ours and makes honest mistakes; these checks stop invention, rewording and a price
 * attached to the wrong product, and cannot understand context. The owner reads the card, with where each line came from,
 * before confirming it. Where a rule cannot be sure, the line is left out or the owner is asked; nothing is picked. The
 * exact rules are in `brand-dna-rules.ts`:
 *   - QUOTED FACTS are copied from the business's own pages: an approved claim is one whole sentence (or clean list item);
 *     an audience is a run of words in one plain sentence; an offer name is written where the business presents it; a
 *     price is the full price expression written for that offer, tied by the page's structure; a link is on its own site;
 *   - DESCRIPTION (summary, positioning, offer descriptions, voice, conversion-page labels) is our wording: no money or
 *     percentage at all, any other number one a source states, and length-capped;
 *   - the model's own notes (what it could not find, the wording of a question) are shown to the owner only;
 *   - more than one price for one offer is never settled by the machine: the price stays empty until the owner chooses;
 *   - what writing steps receive is unchanged by these rules (the card's fields, as the owner confirmed them);
 *   - a settled choice takes its value from the stored card, never the browser;
 *   - pages read from the website are only held with the card task until a card built from them is saved.
 *
 * A card checked under rules version 3 whose offers carry no proposed price structure (`pricing`) is exactly what 8eca59d
 * made, with TWO differences on the card view, and no others:
 *   - the "What we could not find" list hides the model's price notes while that offer has an open price question, and
 *     shows at most 6 notes (`gapNotes`);
 *   - a price question whose field is a bare "Price" (or "Prices", "The price") is titled "<Offer>: price".
 * The stored words of every page are 8eca59d's byte for byte: which lines were action text is recorded beside them
 * (`origin.actionLines`), never in them.
 */

import { createHash } from 'node:crypto';
import type {
  BrandProfile, InventoryPage, Job, KnowledgeCategory, KnowledgeDocument, ProfileConflict, ProfileConflictOption,
  OfferPriceLine, ProfileFactSource, ProfileLeftOut, ProfileOffer,
} from './types.js';
import { materialFigures } from './checks.js';
import { SeoBlogError } from './types.js';
import {
  AUDIENCE_MAX, audienceUnit, basisText, claimSentence, cutDescription, DESCRIPTION_MAX, linkAllowed, linkLabel, NEVER_SAY_MAX, neverSayKept, OFFER_LIMIT, offerNameProblem,
  basisPositions, checkAllPricing, priceCandidates, priceLines, priceStatus, proposedLines, sourceNumbers, VOICE_LINE_MAX, withoutMarkers, wordRun,
  type CheckedPricing, type CheckDocument, type LinkContext, type PriceStatus, type ProposedPriceLine,
} from './brand-dna-rules.js';

/**
 * Figures that need evidence, as the article checks read them, but hardened for the website door: full-width and other
 * compatibility digits ("５００") are read as the digits they are, and a leading "500) " or "30. " is a figure here,
 * not a list number (a brand fact is one line, never a numbered list).
 */
function figuresIn(text: string): string[] {
  const normal = text.normalize('NFKC');
  const leading = /^\s*(\d{2,})[.)]\s/.exec(normal);
  return [...(leading ? [leading[1]!] : []), ...materialFigures(normal)];
}

export const BRAND_DNA_STAGE = 'brand_dna';
/** Pages whose words are kept from one website read. */
export const BRAND_PAGE_LIMIT = 12;
/** Characters kept per page. */
export const BRAND_PAGE_TEXT_LIMIT = 8000;
/**
 * The words kept from one page: spacing within a line collapsed, but each heading, paragraph, list item and table cell
 * kept on its own line (the page reader ends each block with a line break), so the checks can tell blocks apart.
 * Pages stored before this kept one line; every rule also works on that.
 */
export function brandPageText(text: string): string {
  return collapsePageText(text).slice(0, BRAND_PAGE_TEXT_LIMIT);
}
const collapsePageText = (text: string) => text.replace(/[^\S\n]+/g, ' ').replace(/ *\n[\s]*/g, '\n').trim();
/**
 * `brandPageText` of a page read, with its action lines carried to the stored text's line numbers. The words are exactly
 * `brandPageText(read.text)` (the 8,000-character limit applies to them alone). Each read line becomes one stored line, or
 * none when it is blank; if that cannot be confirmed line for line, no line is recorded as action text.
 */
export function brandPageTextRead(read: { readonly text: string; readonly actionLines: readonly number[] }): { readonly text: string; readonly actionLines: readonly number[] } {
  const text = brandPageText(read.text);
  if (!read.actionLines.length) return { text, actionLines: [] };
  const at: number[] = [], kept: string[] = [];
  for (const line of read.text.split('\n')) { const t = line.replace(/\s+/g, ' ').trim(); at.push(t ? kept.length : -1); if (t) kept.push(t); }
  if (kept.join('\n') !== collapsePageText(read.text)) return { text, actionLines: [] };
  const lines = text ? text.split('\n').length : 0;
  return { text, actionLines: read.actionLines.map((i) => at[i] ?? -1).filter((i) => i >= 0 && i < lines) };
}
/**
 * What the owner is told when a read cannot end in a card. Each says what to do next in one sentence;
 * the page puts the button for it right underneath.
 */
export const BRAND_DNA_MESSAGES = Object.freeze({
  /** The address gave no readable words. Button: paste your details. */
  noWords: 'We could not read enough words on that address. Check the address, or paste your details instead.',
  /** The model answered from the website (and any documents), but nothing on its card could be confirmed. Button: paste. */
  nothingClear: 'We read your website but could not find enough clear facts to make a card. Paste a short description of what you sell and who it is for, and we will use that.',
  /** The same, when no website page could be used and the card was made from the owner's documents alone. Button: paste. */
  nothingClearDocuments: 'We could not find enough clear facts in your documents to make a card. Paste a short description of what you sell and who it is for, and we will use that.',
  /** The website read itself failed before any card was asked for. No writing call was made, so nothing was spent. Button: Read. */
  ourSide: 'Something went wrong on our side. Nothing was spent. Press Read my website again.',
  /** The writing call answered in a shape we could not use, or one we could not make true. Its usage is recorded. Button: Read. */
  ourSideCard: 'Something went wrong on our side while making your card. Nothing was saved. Press Read my website again.',
  /** Something failed after a card may already have been asked for: nothing is promised about the allowance. Button: Read. */
  ourSideRetry: 'Something went wrong on our side. Press Read my website again.',
});
/** Fewer readable words than this across the whole read means the site could not really be read. */
export const BRAND_DNA_MIN_WORDS = 60;

// ─── Which pages describe the business ───────────────────────────────────────

const PRICE_PAGES = /^(pricing|prices?|fees?|plans?|packages?|offers?|costs?|rates?|membership|memberships|join)$/i;
const OFFER_PAGES = /^(services?|products?|what-we-do|how-it-works|courses?|training|mentoring|mentorship|coaching|programmes?|programs?|solutions?|work-with-us|investors?|landlords?|sellers?|buyers?|sourcing|deals?)$/i;
const ABOUT_PAGES = /^(about|about-us|our-story|who-we-are|team|meet-the-team|why-us)$/i;
// Reviews, testimonials, case studies and results pages are deliberately not read: customer words must never become the brand's own claims.
const OTHER_PAGES = /^(faqs?|frequently-asked-questions|contact|contact-us)$/i;

function lastSegment(url: string): { segments: string[]; last: string } | null {
  try {
    const segments = new URL(url).pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s).replace(/\.(html?|php|aspx?)$/i, ''));
    return { segments, last: segments[segments.length - 1] ?? '' };
  } catch { return null; }
}

/** Lower is read first. Null means the page is not one that describes the business. */
export function brandPageRank(url: string): number | null {
  const path = lastSegment(url);
  if (!path) return null;
  if (path.segments.length === 0 || (path.segments.length === 1 && /^(index|home)$/i.test(path.last))) return 0;
  if (path.segments.length > 2) return null;
  if (PRICE_PAGES.test(path.last)) return 1;
  if (OFFER_PAGES.test(path.last)) return 2;
  if (ABOUT_PAGES.test(path.last)) return 3;
  if (OTHER_PAGES.test(path.last)) return 4;
  return null;
}

function categoryFor(url: string): KnowledgeCategory {
  const rank = brandPageRank(url);
  if (rank === 0 || rank === 3) return 'brand_guidelines';
  if (lastSegment(url)?.last.match(/^(faqs?|frequently-asked-questions)$/i)) return 'faqs';
  return 'product_facts';
}

/** "Pricing page", "About us page", "Home page". */
export function pageLabel(url: string): string {
  const path = lastSegment(url);
  if (!path || brandPageRank(url) === 0) return 'Home page';
  const words = path.last.replace(/[-_+]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Website';
  return `${words.charAt(0).toUpperCase()}${words.slice(1)} page`;
}

const sha256Hex = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const wordCount = (text: string) => text.split(/\s+/).filter(Boolean).length;

/** One website page is one logical document for the life of the brand, so a re-read versions it instead of duplicating it. */
export function websiteDocumentId(brandId: string, url: string): string {
  const h = sha256Hex(`brand-dna-page:${brandId.toLowerCase()}:${url}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export interface WebsiteDocumentPlan {
  /** New document versions to save. Pages whose words did not change are not here. */
  readonly documents: readonly KnowledgeDocument[];
  readonly pagesRead: number;
  readonly unchanged: number;
  readonly words: number;
}

/** Turn the pages kept by a website read into brand documents. Pure: the caller saves them. */
export function websiteDocuments(input: {
  readonly brandId: string;
  readonly pages: readonly InventoryPage[];
  readonly existing: readonly KnowledgeDocument[];
  readonly now: string;
}): WebsiteDocumentPlan {
  const latest = new Map<string, KnowledgeDocument>();
  for (const d of input.existing) if (!latest.has(d.id) || latest.get(d.id)!.version < d.version) latest.set(d.id, d);
  const documents: KnowledgeDocument[] = [];
  let pagesRead = 0, unchanged = 0, words = 0;
  const readable = input.pages
    .filter((p) => p.fetchStatus === 'ok' && typeof p.text === 'string' && wordCount(p.text) >= 5 && brandPageRank(p.url) !== null)
    .sort((a, b) => brandPageRank(a.url)! - brandPageRank(b.url)!)
    .slice(0, BRAND_PAGE_LIMIT);
  for (const page of readable) {
    const text = page.text!.slice(0, BRAND_PAGE_TEXT_LIMIT);
    const lineCount = text.split('\n').length, actionLines = (page.actionLines ?? []).filter((i) => i < lineCount);
    const count = wordCount(text);
    pagesRead++; words += count;
    const id = websiteDocumentId(input.brandId, page.url);
    const prior = latest.get(id);
    const sha256 = sha256Hex(text);
    if (prior?.active && prior.sha256 === sha256) { unchanged++; continue; }
    documents.push({
      id, brandId: input.brandId, version: (prior?.version ?? 0) + 1, category: categoryFor(page.url), title: pageLabel(page.url),
      filename: null, format: 'txt', mime: 'text/plain', sizeBytes: Buffer.byteLength(text), sha256, blobId: null, status: 'extracted',
      statusDetail: `${count.toLocaleString('en-GB')} words read from ${page.url}`, text, pagesRead: null, pagesTotal: null, active: true,
      createdAt: input.now, origin: { kind: 'website', url: page.url, fetchedAt: input.now, ...(actionLines.length ? { actionLines } : {}) },
    });
  }
  return { documents, pagesRead, unchanged, words };
}

// ─── Word-for-word checks ────────────────────────────────────────────────────

function plain(text: string): string {
  return basisText(withoutMarkers(text)).replace(/[‘’‚‛]/g, "'").replace(/[“”„‟]/g, '"').replace(/[‐-―−]/g, '-')
    .replace(/\s+/g, ' ').trim().toLowerCase();
}

/** `needle` sits in `hay` without cutting a number in half: "£4" is not in "£49", "£49" is not in "£499", "£49.99" or "£49k". */
function foundWhole(hay: string, needle: string): boolean {
  for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + 1)) if (wholeHere(hay, needle, at)) return true;
  return false;
}

/** The test `foundWhole` makes at one position. */
function wholeHere(hay: string, needle: string, at: number): boolean {
  // A needle ending "1," or "1." still ends inside a number when the text goes on with a digit: "£1," is not in "£1,500".
  const startsWithDigit = /^\d/.test(needle), endsWithDigit = /\d[.,]?$/.test(needle);
  if (startsWithDigit && /(?:\d|\d[.,])$/.test(hay.slice(Math.max(0, at - 2), at))) return false;
  if (endsWithDigit && /^(?:\d|[.,]\d|\s?%|\s?(?:k|m|bn|thousand|million|billion)\b)/.test(hay.slice(at + needle.length, at + needle.length + 10))) return false;
  return true;
}

/**
 * True when `quote` appears in `text`, ignoring only case, spacing, typographic quote/dash variants and invisible
 * characters (soft hyphens, zero-width and bidi marks; footnote marks read as spaces). Numbers match whole.
 */
export function appearsIn(text: string | null | undefined, quote: string | null | undefined): boolean {
  const needle = plain(quote ?? '');
  return needle.length >= 2 && foundWhole(plain(text ?? ''), needle);
}

/** A quote long enough to mean something: at least twelve characters or three words. */
export function meaningfulQuote(quote: string | null | undefined): boolean {
  const text = plain(quote ?? '');
  return text.length >= 12 || text.split(' ').filter(Boolean).length >= 3;
}

const sameValue = (a: string, b: string) => plain(a) === plain(b);
const loose = (text: string) => plain(text).replace(/[^a-z0-9£]+/g, ' ').trim();

/** The part of a profile these rules read. Structural so the extraction module can use it without a cycle. */
export type ProfileFacts = Pick<BrandProfile, 'offers' | 'audiences' | 'approvedClaims' | 'conflicts' | 'missingFacts'>
  & Partial<Pick<BrandProfile, 'summary' | 'positioning' | 'voice' | 'exclusions' | 'conversionPages'>> & {
    readonly sources?: readonly ProfileFactSource[];
    /**
     * The names of every offer the model's answer gave, in its order. Set by the repair so that the check of a repaired
     * card reads prices against exactly the same offer list the repair did. Never stored on a card.
     */
    readonly offerNames?: readonly string[];
  };
/** A supplied document as the checks read it. `page` is the website address it was read from, when it was. */
type SourceText = Pick<KnowledgeDocument, 'id' | 'text'> & { readonly page?: string | null; readonly actionLines?: readonly number[] };
/** What the checks know besides the documents: the business's own website address, when it has one. */
export interface SourceContext { readonly website?: string | null }

/** Position of `name` in `text` as a whole word (both already lower case), from `from` onwards; -1 when absent. */
function wholeWordAt(text: string, name: string, from = 0): number {
  for (let at = text.indexOf(name, from); at !== -1; at = text.indexOf(name, at + 1)) {
    const before = text[at - 1], after = text[at + name.length];
    if ((before === undefined || !/[a-z0-9]/.test(before)) && (after === undefined || !/[a-z0-9]/.test(after))) return at;
  }
  return -1;
}

/**
 * The one offer a conflict is about. The exact name wins; otherwise the offer must be named as whole words
 * ("Pro" is not in "Pro Plus" or "property"), and the longest name wins so a question about "Pro Plus" is never taken for "Pro".
 */
export function conflictOffer<T extends Pick<ProfileOffer, 'name'>>(conflict: ProfileConflict, offers: readonly T[]): T | null {
  if (typeof conflict.offer === 'string' && conflict.offer.trim()) {
    const exact = offers.find((o) => sameValue(o.name, conflict.offer!));
    if (exact) return exact;
  }
  for (const text of [conflict.offer ?? '', conflict.field, conflict.detail]) {
    const hay = loose(text);
    const named = offers.filter((o) => loose(o.name).length >= 3 && wholeWordAt(hay, loose(o.name)) !== -1).sort((a, b) => loose(b.name).length - loose(a.name).length);
    if (named[0]) return named[0];
  }
  return null;
}

const PRICE_WORDS = /\b(?:prices?|pricing|priced|costs?|fees?)\b|[£$€]\s?\d/i;

/**
 * The offer whose price this conflict leaves open, or null when it is not a question about a price.
 * A conflict made before Brand DNA carries no `kind`; one that talks about a price is treated as one,
 * so a disputed price is never shown as settled.
 */
export function priceConflictOffer<T extends Pick<ProfileOffer, 'name'>>(conflict: ProfileConflict, offers: readonly T[]): T | null {
  const aboutPrice = conflict.kind === 'price' || (conflict.kind === undefined && PRICE_WORDS.test(`${conflict.field} ${conflict.detail}`));
  return aboutPrice ? conflictOffer(conflict, offers) : null;
}

const MONEY = /[£$€]\s?(\d[\d,]*(?:\.\d+)?)\s?(k|m)?\b/gi;
function moneyAmounts(text: string): number[] {
  return [...text.matchAll(MONEY)].map((m) => Number(m[1]!.replace(/,/g, '')) * (m[2]?.toLowerCase() === 'k' ? 1_000 : m[2]?.toLowerCase() === 'm' ? 1_000_000 : 1)).filter(Number.isFinite);
}

/** Drop every sentence of `description` that states a money amount other than the ones in `keep`. Whole sentences only, so what is left still reads. */
export function withoutOtherPrices(description: string, keep: string | null): string {
  const kept = new Set(keep ? moneyAmounts(keep) : []);
  return description.split(/(?<=[.!?])\s+/).filter((sentence) => moneyAmounts(sentence).every((amount) => kept.has(amount))).join(' ').trim();
}

/** A line of the model's own "what we could not find" note may be shown to the owner only when it states no number, price or percentage at all. */
export function missingFactShowable(line: string): boolean {
  return !/[\p{N}£$€¥%]/u.test(basisText(line));
}

// ─── One decision per field, shared by the check and the repair ──────────────

interface OfferDecision {
  readonly offer: ProfileOffer;
  /** Why the whole offer goes, or null. */
  readonly drop: string | null;
  /** 'tied': the price stands. 'untied': emptied and listed. 'ambiguous': emptied; the owner is asked. */
  readonly price: PriceStatus | null;
  /** The page's own price expression for this offer, shown to the owner when the model's differs (only when the rule is sure of it). */
  readonly pagePrice: string | null;
  /** For a tied price: the lines the rule used (the offer's name line and the price's line), shown beside it on the card. */
  readonly priceLines: string | null;
  /** The model's proposed price structure, when the check accepted every line of it (the price is then tied by it). */
  readonly checked: CheckedPricing | null;
  readonly description: { readonly text: string; readonly cut: readonly string[] };
  readonly urlBad: boolean;
}
interface Decisions {
  readonly offers: readonly OfferDecision[];
  readonly names: readonly string[];
}

/**
 * The model's proposed price structure for an offer, or null for none. An empty `lines` list proposes the price alone, which
 * means something only beside "Free"; beside any other price it is no proposal at all (the plain 8eca59d path).
 */
function proposalOf(o: ProfileOffer): ProposedPriceLine[] | null {
  const lines = proposedLines((o as { pricing?: unknown }).pricing);
  return lines && (lines.length > 0 || /^free$/iu.test((o.price ?? '').trim())) ? lines : null;
}

function linkContext(documents: readonly SourceText[], context: SourceContext): LinkContext {
  return { website: context.website ?? null, pages: documents.map((d) => d.page) };
}

function decideOffers(value: ProfileFacts, documents: readonly SourceText[], context: SourceContext): Decisions {
  const byId = new Map(documents.map((d) => [d.id, d]));
  const names = value.offerNames ?? value.offers.map((o) => o.name);
  const numbers = sourceNumbers(documents);
  const links = linkContext(documents, context);
  // Every proposed structure is checked together (one offer's accepted check may excuse its own amounts for another).
  const checks = checkAllPricing(documents, names, value.offers.map((o, index) => {
    const self = names.findIndex((n) => sameValue(n, o.name));
    const doc = o.sourceDocumentId ? byId.get(o.sourceDocumentId) : undefined;
    const usable = index < OFFER_LIMIT && Boolean(doc) && !offerNameProblem(o.name, doc!);
    return { self: self < 0 ? names.length : self, price: usable ? o.price : null, proposed: proposalOf(o), citedId: o.sourceDocumentId };
  }));
  const offers = value.offers.map((o, index): OfferDecision => {
    const doc = o.sourceDocumentId ? byId.get(o.sourceDocumentId) : undefined;
    const description = cutDescription(o.description ?? '', numbers, DESCRIPTION_MAX);
    const none = { price: null, pagePrice: null, priceLines: null, checked: null, description, urlBad: false };
    if (index >= OFFER_LIMIT) return { offer: o, drop: `is past the first ${OFFER_LIMIT} offers`, ...none };
    if (!doc) return { offer: o, drop: 'must name the supplied document it came from in sourceDocumentId', ...none };
    const nameProblem = offerNameProblem(o.name, doc);
    if (nameProblem) return { offer: o, drop: `its name ${nameProblem}. Name the offer exactly as that document does`, ...none };
    const self = names.findIndex((n) => sameValue(n, o.name));
    const at = self < 0 ? names.length : self;
    // A proposed price structure is checked line by line; accepted whole, it ties the price. Otherwise the plain rule.
    const proposal = proposalOf(o);
    const checked = proposal ? checks[index] ?? null : null;
    const read = checked ? { status: 'tied' as const, hint: null } : priceStatus(o.price ?? '', doc, names, at);
    const lines = o.price && read.status === 'tied' && !checked ? priceLines(doc, names, at, o.price) : null;
    return { offer: o, drop: null, price: o.price ? read.status : null, pagePrice: read.hint, priceLines: lines, checked, description, urlBad: Boolean(o.url) && !linkAllowed(o.url, links) };
  });
  return { offers, names };
}

/**
 * Website door: for each offer whose price the rule tied, the lines it was tied by, carried from the same decision the
 * check and repair made (same offer list) to the card, which shows them beside the price. Never sent to any writing step.
 */
export function priceLineSources(value: ProfileFacts, documents: readonly SourceText[], context: SourceContext = {}): ProfileFactSource[] {
  return decideOffers(value, documents, context).offers.flatMap((d) => !d.drop && d.price === 'tied' && d.priceLines && d.offer.sourceDocumentId
    ? [{ field: 'price' as const, value: clip(d.offer.name, 400), documentId: d.offer.sourceDocumentId, quote: clip(d.priceLines, 600) }] : []);
}

/** The sources entry that supports an audience or claim, or null. Its quote must be word for word in its document and hold the line. */
function supportingSource(field: 'audience' | 'claim', item: string, value: ProfileFacts, byId: ReadonlyMap<string, SourceText>): ProfileFactSource | null {
  for (const s of value.sources ?? []) {
    if (s.field !== field || !sameValue(s.value, item) || !s.documentId) continue;
    const doc = byId.get(s.documentId);
    if (!doc || !appearsIn(doc.text, s.quote) || !meaningfulQuote(s.quote) || !wordRun(s.quote, item)) continue;
    if (field === 'claim' ? claimSentence(item, doc) : audienceUnit(item, doc)) return s;
  }
  return null;
}
const hasQuotedSource = (field: 'audience' | 'claim', item: string, value: ProfileFacts, byId: ReadonlyMap<string, SourceText>) =>
  (value.sources ?? []).some((s) => s.field === field && sameValue(s.value, item) && s.documentId && byId.has(s.documentId) && appearsIn(byId.get(s.documentId)!.text, s.quote) && meaningfulQuote(s.quote));

/** A voice example is the business's own words: one whole sentence of a source, exactly as an approved claim must be. */
const exampleOk = (line: string, documents: readonly SourceText[]) => documents.some((d) => claimSentence(line, d) !== null);
/** A voice tone/do/don't line is description: each of its sentences must pass the description rule, and it is at most 200 characters. */
const voiceLineOk = (line: string, numbers: ReadonlySet<string>) => line.length <= VOICE_LINE_MAX && cutDescription(line, numbers).cut.length === 0;

/**
 * Reasons a site-fed extraction must be corrected. Any entry sends the model's one correction pass; what still
 * fails after it is taken off the card by `repairProfileFacts`, and only a card with nothing usable left is refused.
 * Every rule here is the same function the repair applies, over the same offer list, so a repaired card has no problem.
 * Messages never describe a position the model could satisfy by picking a different amount: unsure means leave it empty.
 */
export function strictProfileProblems(value: ProfileFacts, documents: readonly SourceText[], context: SourceContext = {}): string[] {
  const byId = new Map(documents.map((d) => [d.id, d]));
  const everywhere = documents.map((d) => d.text ?? '').join('\n');
  const numbers = sourceNumbers(documents);
  const problems: string[] = [];
  const decided = decideOffers(value, documents, context);
  for (const d of decided.offers) {
    const o = d.offer;
    if (d.drop) { problems.push(`offer "${o.name}" ${d.drop}`); continue; }
    if (d.price === 'untied') problems.push(`offer "${o.name}": the price "${o.price}" is not the price document ${o.sourceDocumentId} writes for this offer. Copy the price written for "${o.name}" with all its words, or leave price empty if you are unsure`);
    if (d.price === 'ambiguous') problems.push(`offer "${o.name}": document ${o.sourceDocumentId} gives more than one price for "${o.name}". Leave price empty: the owner will be asked which is right`);
    if (d.urlBad) problems.push(`offer "${o.name}": the url must be an https address on the business's own website, or null`);
    if (d.description.cut.length) problems.push(`the description of "${o.name}" has a sentence with a price, a percentage or a number no document states, or runs over ${DESCRIPTION_MAX} characters ("${d.description.cut[0]!.slice(0, 80)}"). Descriptions are your own short words and carry no figures`);
  }
  for (const s of value.sources ?? []) {
    const doc = s.documentId ? byId.get(s.documentId) : undefined;
    if (!doc) problems.push(`source for "${s.value}" cites a document id that was not supplied`);
    else if (!appearsIn(doc.text, s.quote)) problems.push(`source for "${s.value}": the quote is not word for word in document ${doc.id}`);
  }
  for (const item of value.approvedClaims) {
    if (!hasQuotedSource('claim', item, value, byId)) problems.push(`approved claim "${item}" has no sources entry with a word-for-word quote. Quote the document that states it, or remove it`);
    else if (!supportingSource('claim', item, value, byId)) problems.push(`approved claim "${item}" is not one whole sentence the business states in the document it cites. An approved claim is a complete sentence copied exactly (not a heading, table cell, customer's words or question), or remove it`);
  }
  for (const item of value.audiences) {
    if (!hasQuotedSource('audience', item, value, byId)) problems.push(`audience "${item}" has no sources entry with a word-for-word quote. Quote the document that states it, or remove it`);
    else if (!supportingSource('audience', item, value, byId)) problems.push(`audience "${item}" is not an unbroken run of words in one plain sentence of the document it cites (no negation, no customer's words). Copy the words exactly (at most ${AUDIENCE_MAX} characters), or remove it`);
  }
  for (const c of value.conflicts) {
    for (const [part, text] of [['title', c.field], ['detail', c.detail]] as const) {
      for (const figure of figuresIn(text)) if (!appearsIn(everywhere, figure)) problems.push(`the ${part} of conflict "${c.field}" states "${figure}", which is in none of the supplied documents. Describe the question without it`);
    }
    for (const id of c.documentIds) if (!byId.has(id)) problems.push(`conflict "${c.field}" cites a document id that was not supplied`);
    if (c.kind !== 'price' && c.kind !== 'other') problems.push(`conflict "${c.field}" must give kind: "price" when it is about what one offer costs, otherwise "other"`);
    const named = typeof c.offer === 'string' && c.offer.trim() ? value.offers.some((o) => sameValue(o.name, c.offer!)) : null;
    if (c.kind === 'price' && !named) problems.push(`price conflict "${c.field}" must give offer: the exact name of the entry in offers it is about`);
    else if (named === false) problems.push(`conflict "${c.field}" names the offer "${c.offer}", which is not in offers. Use the exact offer name, or null`);
    for (const option of c.options ?? []) {
      const doc = byId.get(option.documentId);
      const answer = c.kind === 'price' ? 'price option' : 'answer';
      if (!doc) problems.push(`conflict "${c.field}" has an option citing a document id that was not supplied`);
      else if (!appearsIn(doc.text, option.quote)) problems.push(`conflict "${c.field}": the option quote "${option.quote.slice(0, 60)}" is not word for word in document ${doc.id}`);
      else if (!meaningfulQuote(option.quote)) problems.push(`conflict "${c.field}": the option quote "${option.quote.slice(0, 60)}" is too short. Quote at least three words`);
      else if (!appearsIn(doc.text, option.value)) problems.push(`conflict "${c.field}": the ${answer} "${option.value}" does not appear character for character in document ${doc.id}. Copy it exactly as written there`);
      else if (figuresIn(option.value).some((figure) => !appearsIn(option.quote, figure))) problems.push(`conflict "${c.field}": the quote for "${option.value}" must contain every figure in it`);
    }
  }
  for (const line of value.exclusions ?? []) {
    if (!neverSayKept(line, documents)) problems.push(`exclusion "${line}" must be a short topic or wording to avoid (2 or more words, at most ${NEVER_SAY_MAX} characters, no numbers or prices, no instruction to say something) and not something the business itself says`);
  }
  for (const line of value.missingFacts) {
    if (!missingFactShowable(line)) problems.push(`missingFacts line "${line}" states a number or price. Name the gap in words only`);
  }
  const links = linkContext(documents, context);
  for (const p of value.conversionPages ?? []) {
    if (!linkAllowed(p.url, links)) problems.push(`conversion page ${p.url} is not an https address on the business's own website`);
    else if (linkLabel(p.label, p.url, documents) !== p.label) problems.push(`conversion page ${p.url}: its label must be words copied from a plain sentence of a supplied document (at most 80 characters)`);
  }
  // Description is our wording: no money or percentage at all, only numbers a source states, and short.
  const free: [string, string, number][] = [['summary', value.summary ?? '', DESCRIPTION_MAX], ['positioning', value.positioning ?? '', DESCRIPTION_MAX],
    ...(['tone', 'do', 'dont'] as const).flatMap((part) => (value.voice?.[part] ?? []).map((line): [string, string, number] => [`voice "${part}" line`, line, VOICE_LINE_MAX]))];
  for (const [where, text, max] of free) {
    const cut = cutDescription(text, numbers, max).cut;
    if (cut.length) problems.push(`the ${where} has a sentence with a price, a percentage or a number no document states, or runs over ${max} characters ("${cut[0]!.slice(0, 80)}"). Description is your own short words and carries no figures`);
  }
  for (const line of value.voice?.examples ?? []) {
    if (!exampleOk(line, documents)) problems.push(`voice example "${line.slice(0, 80)}" must be one whole sentence copied exactly from a supplied document`);
  }
  return problems.slice(0, 12);
}

const clip = (text: unknown, max: number) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// ─── Repair instead of reject ────────────────────────────────────────────────

export interface ProfileRepair<T> {
  readonly value: T;
  /** Exactly what was taken off, in order. Empty when nothing needed removing. */
  readonly leftOut: readonly ProfileLeftOut[];
}

/**
 * Website door only, after the model's correction pass: take off exactly what fails the rules and keep everything
 * that passes. It never adds, rewrites or paraphrases a fact. It removes a line (an offer, audience, claim, voice line or
 * example, "never say" line, question, conversion page), empties a price, link or a question's title or detail, replaces
 * a conversion-page label that is not the business's words with the link's own path, and cuts whole sentences out of
 * description (summary, positioning, offer descriptions) that carry a figure or run over the length limit. Cutting a
 * sentence can leave description saying less, or more plainly, than the model wrote; every cut is listed under "What we
 * left out". Each decision is the one `strictProfileProblems` makes, over the same offer list (the model's own list,
 * carried in `offerNames`), so `strictProfileProblems(result.value, documents)` is [].
 *
 * Returns null when the answer cannot be repaired truthfully: a price question that is dropped but cannot be tied to
 * one offer (its price could otherwise be shown as settled), or a question marked "other" that is really about a price.
 */
export function repairProfileFacts<T extends ProfileFacts>(value: T, documents: readonly SourceText[], context: SourceContext = {}): ProfileRepair<T> | null {
  const byId = new Map(documents.map((d) => [d.id, d]));
  const everywhere = documents.map((d) => d.text ?? '').join('\n');
  const numbers = sourceNumbers(documents);
  const leftOut: ProfileLeftOut[] = [];
  const leave = (what: ProfileLeftOut['what'], text: string, found?: string | null) => {
    if (!leftOut.some((l) => l.what === what && sameValue(l.text, text))) leftOut.push({ what, text: clip(text, 300), ...(found ? { found: clip(withoutMarkers(found), 200) } : {}) });
  };
  const anywhere = (f: string) => appearsIn(everywhere, f);
  const decided = decideOffers(value, documents, context);

  // A source line counts only when its quote is word for word in a supplied document.
  const sources = (value.sources ?? []).filter((s) => s.documentId && byId.has(s.documentId) && appearsIn(byId.get(s.documentId)!.text, s.quote));

  const offers: ProfileOffer[] = [];
  for (const d of decided.offers) {
    const o = d.offer;
    if (d.drop) { leave('offer', o.name); continue; }
    let next: ProfileOffer = o;
    if (d.price === 'untied') { next = { ...next, price: null }; leave('price', o.name, d.pagePrice); }
    if (d.price === 'ambiguous') next = { ...next, price: null };
    if (d.description.cut.length) { next = { ...next, description: d.description.text }; leave('offer_detail', o.name); }
    if (d.urlBad) { next = { ...next, url: null }; leave('link', o.url!); }
    offers.push(next);
  }

  const repairedSources = { ...value, sources };
  const audiences = value.audiences.filter((a) => supportingSource('audience', a, repairedSources, byId) || (leave('audience', a), false));
  const approvedClaims = value.approvedClaims.filter((c) => supportingSource('claim', c, repairedSources, byId) || (leave('claim', c), false));
  const keptSources = sources.filter((s) => s.field === 'audience' ? audiences.some((a) => sameValue(a, s.value)) : s.field === 'claim' ? approvedClaims.some((c) => sameValue(c, s.value)) : true);

  // Questions: unverifiable answers are dropped; a question left with fewer than two answers, a malformed one, or a price
  // question about an offer no longer on the card is dropped. A price it held stays empty: nothing is chosen. A price
  // question that stays has its answers replaced by the page's own price expressions afterwards (`holdConflictedPrices`).
  const noPrice = new Set<ProfileOffer>();
  const conflicts: ProfileConflict[] = [];
  for (const c of value.conflicts) {
    const named = typeof c.offer === 'string' && c.offer.trim() ? offers.find((o) => sameValue(o.name, c.offer!)) ?? null : undefined;
    const options = (c.options ?? []).filter((option) => {
      const doc = byId.get(option.documentId);
      return doc && appearsIn(doc.text, option.quote) && meaningfulQuote(option.quote) && appearsIn(doc.text, option.value) && figuresIn(option.value).every((f) => appearsIn(option.quote, f));
    });
    // The title and detail are labels for the owner: one stating a figure in no document is emptied, never reworded.
    const badField = figuresIn(c.field).some((f) => !anywhere(f)), badDetail = figuresIn(c.detail).some((f) => !anywhere(f));
    // What the owner is told was left out: never a title whose own figure could not be found.
    const label = badField ? (named?.name ?? '') : c.field;
    const malformed = (c.kind !== 'price' && c.kind !== 'other') || (c.kind === 'price' && !named) || (badField && c.kind !== 'price');
    const thinned = options.length < (c.options ?? []).length && options.length < 2;
    if (malformed || thinned) {
      const statesMoney = (c.options ?? []).some((o) => moneyAmounts(`${o.value} ${o.quote}`).length > 0);
      const aboutPrice = c.kind === 'price' || PRICE_WORDS.test(`${c.field} ${c.detail} ${c.offer ?? ''}`) || statesMoney;
      if (aboutPrice) {
        // A price question marked "other" could leave its offer's price looking settled: refuse rather than guess.
        if (c.kind === 'other') return null;
        const about = named ?? conflictOffer(c, offers);
        if (about) noPrice.add(about);
        // Still unrepairable unless the offer it was about is off the card altogether.
        else if (!conflictOffer(c, value.offers) || offers.some((o) => sameValue(o.name, conflictOffer(c, value.offers)!.name))) return null;
      }
      leave('question', label);
      continue;
    }
    const { offer: _offer, options: _options, ...rest } = c;
    conflicts.push({ ...rest, ...(badField ? { field: '' } : {}), ...(badDetail ? { detail: '' } : {}), documentIds: c.documentIds.filter((id) => byId.has(id)),
      // An offer name that is not on the card is emptied (only allowed for a question that is not about a price).
      ...(c.offer !== undefined ? { offer: named ? c.offer : null } : {}), ...(c.options !== undefined ? { options } : {}) });
  }

  const pricedOffers = offers.map((o) => {
    if (noPrice.has(o) && o.price) { leave('price', o.name); return { ...o, price: null }; }
    return o;
  });

  // Description: whole sentences with a figure, or past the length limit, are cut (and listed); a voice line with one goes;
  // an example that is not one whole sentence of a source goes.
  const freeText = (what: 'summary' | 'positioning', text: string | undefined): string | undefined => {
    if (text === undefined) return text;
    const cut = cutDescription(text, numbers, DESCRIPTION_MAX);
    if (!cut.cut.length) return text;
    leave(what, text);
    // A summary too short to stand on its own is emptied: the owner writes one before confirming.
    return cut.text.length < 10 ? '' : cut.text;
  };
  const lines = (what: 'voice' | 'voice_dont', items: readonly string[]) => items.filter((line) => voiceLineOk(line, numbers) || (leave(what, line), false));
  const voice = value.voice ? { ...value.voice, tone: lines('voice', value.voice.tone), do: lines('voice', value.voice.do), dont: lines('voice_dont', value.voice.dont),
    examples: value.voice.examples.filter((line) => exampleOk(line, documents) || (leave('voice', line), false)) } : undefined;
  const summary = freeText('summary', value.summary), positioning = freeText('positioning', value.positioning);

  // "Never say" lines are suggestions that restrict the writer only.
  const exclusions = value.exclusions?.filter((line) => neverSayKept(line, documents) || (leave('exclusion', line), false));
  // The model's note of what it could not find is shown to the owner only, and never with a figure or price in it.
  const missingFacts = value.missingFacts.filter(missingFactShowable);
  const links = linkContext(documents, context);
  const conversionPages = value.conversionPages?.flatMap((p) => {
    if (!linkAllowed(p.url, links)) { leave('link', String(p.url ?? '')); return []; }
    return [{ url: p.url, label: linkLabel(p.label, p.url, documents) }];
  });

  // The offer list the prices were read against travels with the card only when the repair took an offer off it.
  const sameNames = pricedOffers.length === decided.names.length && pricedOffers.every((o, i) => o.name === decided.names[i]);
  const repaired: T = { ...value, offers: pricedOffers, audiences, approvedClaims, conflicts, missingFacts, ...(sameNames ? {} : { offerNames: decided.names }),
    ...(exclusions !== undefined ? { exclusions } : {}), ...(conversionPages !== undefined ? { conversionPages } : {}),
    ...(value.sources !== undefined ? { sources: keptSources } : {}),
    ...(summary !== undefined ? { summary } : {}), ...(positioning !== undefined ? { positioning } : {}), ...(voice ? { voice } : {}) };
  return { value: repaired, leftOut };
}

/**
 * The left-out lines that are still true after the owner changed the card by hand. A line goes as soon as the thing it
 * names is on the card again (the same audience or claim, a summary or positioning, the same "avoid" line, a price on
 * that offer). Matching is exact (case and spacing aside); a line re-added in different words stays listed.
 */
export function leftOutAfterEdit(leftOut: readonly ProfileLeftOut[] | undefined, card: Pick<BrandProfile, 'summary' | 'positioning' | 'audiences' | 'approvedClaims' | 'offers' | 'voice' | 'exclusions'>): ProfileLeftOut[] | undefined {
  if (!leftOut) return undefined;
  const has = (items: readonly string[], text: string) => items.some((i) => sameValue(i, text));
  const offer = (name: string) => card.offers.find((o) => sameValue(o.name, name));
  return leftOut.filter((l) => {
    switch (l.what) {
      case 'audience': return !has(card.audiences, l.text);
      case 'claim': return !has(card.approvedClaims, l.text);
      case 'summary': return !card.summary.trim();
      case 'positioning': return !card.positioning.trim();
      case 'voice_dont': return !has(card.voice.dont, l.text);
      case 'exclusion': return !has(card.exclusions, l.text);
      case 'price': return !offer(l.text)?.price;
      case 'offer': return !offer(l.text);
      default: return true;
    }
  });
}

/** True when nothing a reader could rely on is left: no offer, no audience and no claim. */
export function nothingVerifiable(value: Pick<ProfileFacts, 'offers' | 'audiences' | 'approvedClaims'>): boolean {
  return value.offers.length === 0 && value.audiences.length === 0 && value.approvedClaims.length === 0;
}

// The provenance rule Setup's documents-only path has always used, kept exactly (its own text normalisation included).
const LEGACY_SMALL_WORDS = new Set(['about', 'across', 'also', 'and', 'any', 'are', 'been', 'being', 'both', 'but', 'can', 'each', 'every', 'for', 'from', 'had', 'has', 'have', 'her', 'his', 'into', 'its',
  'just', 'more', 'most', 'not', 'only', 'our', 'out', 'over', 'such', 'than', 'that', 'the', 'their', 'them', 'then', 'these', 'they', 'this', 'those', 'too', 'very', 'was', 'were', 'what', 'when',
  'which', 'who', 'whom', 'will', 'with', 'you', 'your']);
const legacyPlain = (text: string) => text.normalize('NFKC').replace(/[‘’‚‛]/g, "'").replace(/[“”„‟]/g, '"').replace(/[‐-―−]/g, '-').replace(/\s+/g, ' ').trim().toLowerCase();
const legacyAppearsIn = (text: string | null | undefined, quote: string | null | undefined) => { const needle = legacyPlain(quote ?? ''); return needle.length >= 2 && foundWhole(legacyPlain(text ?? ''), needle); };
const legacyWordsOf = (text: string) => legacyPlain(text).split(/[^a-z0-9]+/).filter(Boolean);
function legacyUnsupportedBy(value: string, quote: string | null | undefined): string | null {
  const q = legacyPlain(quote ?? '');
  if (!(q.length >= 12 || q.split(' ').filter(Boolean).length >= 3)) return 'too short';
  for (const figure of figuresIn(value)) if (!legacyAppearsIn(quote, figure)) return 'figure';
  const words = [...new Set(legacyWordsOf(value).filter((w) => !LEGACY_SMALL_WORDS.has(w) && !/^\d+$/.test(w)))];
  const long = words.filter((w) => w.length >= 4);
  const keys = long.length ? long : words.filter((w) => w.length >= 2);
  if (!keys.length) return null;
  const quoted = legacyWordsOf(quote ?? '');
  const hits = keys.filter((k) => quoted.some((w) => w.startsWith(k.slice(0, 5)))).length;
  return hits >= Math.ceil((keys.length * 2) / 3) ? null : 'key words';
}

/**
 * Keep only provenance that can be shown truthfully. Used on every extraction. On the website door (`strict`), after the
 * repair: a claim's source line is kept when its quote is word for word in the document, holds the claim, and the claim is
 * one whole sentence of that document; an audience's when the audience rule holds; a voice or offer line when its quote is
 * word for word and at least three words. On Setup's documents-only path it is exactly the rule it always was. It never
 * removes a claim, audience or other line from the profile.
 */
export function cleanProvenance<T extends ProfileFacts>(value: T, documents: readonly SourceText[], strict = false): T {
  const byId = new Map(documents.map((d) => [d.id, d]));
  const sources: ProfileFactSource[] = [];
  for (const s of value.sources ?? []) {
    if (s.field !== 'audience' && s.field !== 'claim' && s.field !== 'voice' && s.field !== 'offer') continue;
    const doc = s.documentId ? byId.get(s.documentId) : undefined;
    const item = String(s.value ?? '');
    if (strict) {
      if (!doc || !appearsIn(doc.text, s.quote)) continue;
      const shown = s.field === 'claim' ? claimSentence(item, doc) !== null && wordRun(s.quote, item) : s.field === 'audience' ? audienceUnit(item, doc) !== null && wordRun(s.quote, item) : meaningfulQuote(s.quote);
      if (!shown) continue;
    } else if (!doc || !legacyAppearsIn(doc.text, s.quote) || legacyUnsupportedBy(item, s.quote)) continue;
    sources.push({ field: s.field, value: clip(s.value, 400), documentId: doc.id, quote: clip(s.quote, 300) });
  }
  const has = strict ? appearsIn : legacyAppearsIn;
  const conflicts = value.conflicts.map((c): ProfileConflict => {
    const options = (c.options ?? []).flatMap((o): ProfileConflictOption[] => {
      const doc = byId.get(o.documentId);
      // A choice is only offered when both its answer and its quote are word for word in the document it names.
      return doc && has(doc.text, o.quote) && clip(o.value, 300).length >= 2 && has(doc.text, o.value) ? [{ value: clip(o.value, 300), documentId: doc.id, quote: clip(o.quote, 300) }] : [];
    }).slice(0, 6);
    const kind = c.kind === 'price' ? 'price' as const : 'other' as const;
    const offer = typeof c.offer === 'string' && c.offer.trim() ? clip(c.offer, 200) : null;
    // Fields the model did not give are left absent, so a documents-only profile keeps its earlier shape.
    return { field: c.field, detail: c.detail, documentIds: c.documentIds, ...(c.kind ? { kind } : {}), ...(offer ? { offer } : {}), ...(options.length ? { options } : {}) };
  });
  // The model never states who typed a price: that field belongs to an owner's settled choice only.
  const offers = value.offers.map((o): ProfileOffer => ({ name: o.name, description: o.description, price: o.price ?? null, url: o.url ?? null, sourceDocumentId: o.sourceDocumentId ?? null,
    // Website door: the model's proposed price structure travels on to be checked (holdConflictedPrices), never stored unchecked.
    ...(strict && (o as { pricing?: unknown }).pricing !== undefined ? { pricing: (o as { pricing?: unknown }).pricing as ProfileOffer['pricing'] } : {}) }));
  const cleaned: T = { ...value, offers, conflicts, sources: sources.slice(0, 120) };
  if (!sources.length) delete (cleaned as { sources?: unknown }).sources;
  return cleaned;
}

// ─── Price backstop ──────────────────────────────────────────────────────────

const PRICE_PHRASE = /£\s?\d[\d,]*(?:\.\d{1,2})?(?:\s?(?:k|m)\b)?(?:\s?\+\s?vat\b|\s?(?:per|a|each|every|\/)\s?(?:calendar\s)?(?:month|year|week|day|annum|person|session|hour|property|deal)\b|\s?(?:pcm|pm|pa|p\/m)\b)*/gi;

interface FoundPrice { readonly amount: number; readonly phrase: string; readonly quote: string }

/**
 * Where each position of the whitespace-collapsed text (`text.replace(/\s+/g, ' ')`) stands in `text`: one entry per
 * collapsed character, a run of white space mapping to its first character.
 */
export function collapsedPositions(text: string): Int32Array {
  const map = new Int32Array(text.length + 1);
  let h = 0, at = 0;
  for (const m of text.matchAll(/\s+/g)) {
    for (let i = at; i < m.index!; i++) map[h++] = i;
    map[h++] = m.index!;
    at = m.index! + m[0].length;
  }
  for (let i = at; i < text.length; i++) map[h++] = i;
  map[h] = text.length;
  return map.subarray(0, h + 1);
}

function pricesNear(text: string, name: string, otherNames: readonly string[], ignoreAt?: (collapsed: number) => boolean): FoundPrice[] {
  const haystack = text.replace(/\s+/g, ' ');
  const lower = haystack.toLowerCase(), needle = name.replace(/\s+/g, ' ').trim().toLowerCase();
  if (needle.length < 3) return [];
  // Where the other offers are named, so "Pro" is never read out of "Pro Plus" and one offer's price is not taken for its neighbour's.
  const others: { start: number; end: number }[] = [];
  for (const other of otherNames) {
    for (let at = wholeWordAt(lower, other), n = 0; at !== -1 && n < 40; at = wholeWordAt(lower, other, at + 1), n++) others.push({ start: at, end: at + other.length });
  }
  const found: FoundPrice[] = [];
  for (let at = wholeWordAt(lower, needle), hits = 0; at !== -1 && hits < 20; at = wholeWordAt(lower, needle, at + 1), hits++) {
    const stop = at + needle.length;
    if (others.some((o) => o.start <= at && o.end >= stop)) continue;
    // Words before the name count only when no other offer is named there; the words after it stop at the next offer.
    const start = others.some((o) => o.end <= at && o.end > at - 120) ? at : Math.max(0, at - 120);
    const next = Math.min(...others.filter((o) => o.start >= stop).map((o) => o.start), haystack.length);
    const end = Math.min(next, stop + 240);
    const window = haystack.slice(start, end);
    for (const m of window.matchAll(PRICE_PHRASE)) {
      // (Accepted structures only: that very occurrence is another accepted offer's.)
      if (ignoreAt?.(start + m.index!)) continue;
      const amountText = /£\s?(\d[\d,]*(?:\.\d{1,2})?)\s?(k|m)?/i.exec(m[0]);
      if (!amountText) continue;
      const amount = Number(amountText[1]!.replace(/,/g, '')) * (amountText[2]?.toLowerCase() === 'k' ? 1_000 : amountText[2]?.toLowerCase() === 'm' ? 1_000_000 : 1);
      if (!Number.isFinite(amount) || found.some((f) => f.amount === amount)) continue;
      // A short run of the surrounding words, cut at whole words so the owner reads a clean quote. Still verbatim.
      let q0 = Math.max(0, m.index! - 60), q1 = Math.min(window.length, m.index! + m[0].length + 40);
      if (q0 > 0) { const space = window.indexOf(' ', q0); if (space !== -1 && space < m.index!) q0 = space + 1; }
      if (q1 < window.length) { const space = window.lastIndexOf(' ', q1); if (space > m.index! + m[0].length) q1 = space; }
      found.push({ amount, phrase: m[0].trim(), quote: window.slice(q0, q1).trim() });
    }
  }
  return found;
}

/**
 * Deterministic backstop: when two sources each put a different price beside the same offer name and
 * share none, the owner must choose. It never picks, and it never fires on one page listing several
 * prices for an offer (monthly and yearly, say).
 */
export function priceConflicts(value: Pick<ProfileFacts, 'offers' | 'conflicts'>, documents: readonly SourceText[],
  /** For an offer whose structure was accepted: the amounts ("document:basis position of its £") other accepted offers claim. */
  claimedByOthers?: (offer: ProfileOffer) => ReadonlySet<string> | null): ProfileConflict[] {
  const added: ProfileConflict[] = [];
  // Built once per document, and only when an accepted structure needs it: collapsed position → text → basis.
  const maps = new Map<string, ((collapsed: number) => number) | null>();
  const basisAt = (d: SourceText) => {
    if (!maps.has(d.id)) {
      const text = d.text ?? '', toText = collapsedPositions(text), toBasis = basisPositions(text);
      maps.set(d.id, toBasis ? (c: number) => (c >= 0 && c < toText.length ? toBasis[toText[c]!]! : -1) : null);
    }
    return maps.get(d.id)!;
  };
  for (const offer of value.offers) {
    // Skipped only when a price question for this offer is already on the card; a different question about the same offer does not hide a price disagreement.
    if (value.conflicts.some((c) => priceConflictOffer(c, value.offers) === offer)) continue;
    const otherNames = value.offers.filter((o) => o !== offer).map((o) => o.name.replace(/\s+/g, ' ').trim().toLowerCase()).filter((n) => n.length >= 3);
    const claimed = claimedByOthers?.(offer) ?? null;
    const ignoreFor = (d: SourceText) => {
      if (!claimed?.size) return undefined;
      const at = basisAt(d);
      // A position that cannot be mapped with certainty is never ignored.
      return at ? (c: number) => { const b = at(c); return b >= 0 && claimed.has(`${d.id}:${b}`); } : undefined;
    };
    const perDoc = documents.map((d) => ({ id: d.id, prices: d.text ? pricesNear(d.text, offer.name, otherNames, ignoreFor(d)) : [] })).filter((d) => d.prices.length > 0);
    const disagree = perDoc.some((a, i) => perDoc.slice(i + 1).some((b) => !a.prices.some((p) => b.prices.some((q) => q.amount === p.amount))));
    if (!disagree) continue;
    const options: ProfileConflictOption[] = [];
    for (const d of perDoc) for (const p of d.prices) {
      if (options.length < 6 && !options.some((o) => o.documentId === d.id && sameValue(o.value, p.phrase))) options.push({ value: p.phrase, documentId: d.id, quote: p.quote });
    }
    added.push({
      field: `${offer.name}: price`, detail: 'Your website pages and documents give different prices for this. Nothing was chosen for you.',
      documentIds: [...new Set(options.map((o) => o.documentId))], kind: 'price', offer: offer.name, options,
    });
  }
  return added;
}

/** The page's own price expressions for one offer in one document, as answers to put to the owner. */
function pageOptions(doc: SourceText, names: readonly string[], self: number): ProfileConflictOption[] {
  return priceCandidates(doc, names, self).slice(0, 6).map((x): ProfileConflictOption => {
    const quote = withoutMarkers(x.unit?.text ?? x.text);
    return { value: clip(withoutMarkers(x.text), 300), documentId: doc.id, quote: clip(quote.length >= 12 ? quote : x.text, 300) };
  });
}

/**
 * Site-fed extractions only, after the repair: make sure no price the page gives more than one of, and no questioned
 * price, is shown as settled.
 *   - A price question the model raised keeps its wording but its answers become the page's own price expressions for
 *     that offer in every document (so a junk extra offer or a single-answer question cannot steer it); with fewer than
 *     two, it goes and the price stays empty.
 *   - An offer whose cited document gives more than one price is asked about: "We found more than one price for X.
 *     Which is right?", each full expression with its sentence.
 *   - The cross-source backstop is unchanged: two sources disagreeing are always asked. For an offer whose structure was
 *     accepted, the question asked is 8eca59d's same-page one (its cited page's prices) when that page has two or more.
 * Only the offer a price question is about is held; its description loses any sentence that states a price.
 */
export function holdConflictedPrices<T extends ProfileFacts>(value: T, documents: readonly SourceText[]): T {
  const byId = new Map(documents.map((d) => [d.id, d]));
  const names = value.offers.map((o) => o.name);
  // Website door, rules v3: each offer's proposed price structure, accepted only when the check accepts every line of it.
  const checked = checkAllPricing(documents, names, value.offers.map((o, i) => ({ self: i, price: o.price, proposed: proposalOf(o), citedId: o.sourceDocumentId })));
  const amountsOf = (i: number) => new Set([value.offers[i]!.price, ...(checked[i]?.lines ?? []).flatMap((l) => [l.text, l.total ?? ''])].flatMap((t) => (t ? moneyAmounts(t) : [])));
  /** Every answer of a question is an amount of the offer's accepted structure (so the structure answers it). */
  const answered = (c: ProfileConflict, i: number) => checked[i] !== null && (c.options ?? []).length > 0 && (c.options ?? []).every((o) => { const a = moneyAmounts(o.value); return a.length > 0 && a.every((n) => amountsOf(i).has(n)); });
  const options = (offer: ProfileOffer) => {
    const i = value.offers.indexOf(offer);
    const all = documents.flatMap((d) => pageOptions(d, names, i));
    return all.filter((o, k) => all.findIndex((p) => p.documentId === o.documentId && sameValue(p.value, o.value)) === k).slice(0, 6);
  };
  const heldOffers = new Set<ProfileOffer>();
  const modelQuestions: ProfileConflict[] = [];
  for (const c of value.conflicts) {
    const offer = c.kind === 'price' ? priceConflictOffer(c, value.offers) : null;
    if (!offer) { modelQuestions.push(c); continue; }
    if (answered(c, value.offers.indexOf(offer))) continue;
    heldOffers.add(offer);
    const page = options(offer);
    if (page.length >= 2) modelQuestions.push({ ...c, documentIds: [...new Set(page.map((o) => o.documentId))], options: page });
  }
  const several: ProfileConflict[] = [];
  for (const [i, offer] of value.offers.entries()) {
    if (checked[i] || heldOffers.has(offer) || modelQuestions.some((c) => priceConflictOffer(c, value.offers) === offer)) continue;
    const doc = offer.sourceDocumentId ? byId.get(offer.sourceDocumentId) : undefined;
    if (!doc) continue;
    const page = pageOptions(doc, names, i);
    if (page.length < 2) continue;
    several.push({ field: `${offer.name}: price`, detail: `We found more than one price for ${offer.name}. Which is right?`, documentIds: [doc.id], kind: 'price', offer: offer.name, options: page });
  }
  const before = [...modelQuestions, ...several];
  // The cross-source backstop as before, except that an answer whose amounts are all covered by that offer's own accepted
  // structure does not conflict.
  // For an offer whose structure was accepted, an amount whose very occurrence another accepted offer claims is not read.
  const claimedByOthers = (offer: ProfileOffer) => {
    const i = value.offers.indexOf(offer);
    if (i < 0 || !checked[i]) return null;
    const set = new Set<string>();
    checked.forEach((c, j) => { if (c && j !== i && value.offers[j]!.name !== offer.name) for (const a of c.claimedAmounts ?? []) set.add(a); });
    return set;
  };
  // An offer whose structure the check accepted but the backstop still asks about is asked 8eca59d's same-page question
  // (its cited page's prices) when that page has two or more: never a wider list than 8eca59d would show for it.
  const backstop = priceConflicts({ offers: value.offers, conflicts: before }, documents, claimedByOthers).filter((c) => {
    const i = value.offers.findIndex((o) => o.name === c.offer);
    return !(i >= 0 && answered(c, i));
  }).map((c): ProfileConflict => {
    const i = value.offers.findIndex((o) => o.name === c.offer), offer = value.offers[i];
    const doc = offer?.sourceDocumentId ? byId.get(offer.sourceDocumentId) : undefined;
    if (!offer || !checked[i] || !doc) return c;
    const page = pageOptions(doc, names, i);
    return page.length >= 2 ? { field: `${offer.name}: price`, detail: `We found more than one price for ${offer.name}. Which is right?`, documentIds: [doc.id], kind: 'price', offer: offer.name, options: page } : c;
  });
  const conflicts = [...before.slice(0, Math.max(0, 30 - backstop.length)), ...backstop];
  const held = new Set([...heldOffers, ...conflicts.map((c) => priceConflictOffer(c, value.offers)).filter((o): o is ProfileOffer => Boolean(o))]);
  const offers = value.offers.map((o, i): ProfileOffer => {
    const { pricing: _proposal, ...rest } = o;
    if (held.has(o)) return { ...rest, price: null, description: withoutOtherPrices(o.description ?? '', null) };
    const c = checked[i];
    // A structure of the price alone is stored only for "Free" (so the card can show the line that says it).
    return c && (c.lines.length || /^free$/iu.test(o.price ?? '')) ? { ...rest, pricing: { lines: c.lines.map((l): OfferPriceLine => ({ role: l.role, text: l.text, ...(l.label ? { label: l.label } : {}), ...(l.total ? { total: l.total } : {}), ...(l.role === 'plan' ? { for: l.for } : {}), documentId: l.documentId, quote: l.quote })),
      priceDocumentId: c.priceDocumentId, priceQuote: c.priceQuote } } : rest;
  });
  return { ...value, offers, conflicts };
}

/** The version of the rules a website-door card was checked under. A card with a lower (or no) version is shown as made under older rules. */
export const BRAND_DNA_RULES_VERSION = 3;

/** True for a website-door card checked under today's rules. */
export function checkedUnderCurrentRules(profile: Pick<BrandProfile, 'strict' | 'rulesVersion'>): boolean {
  return profile.strict === true && (profile.rulesVersion ?? 1) >= BRAND_DNA_RULES_VERSION;
}

// ─── The owner settles a conflict ────────────────────────────────────────────

export type ConflictChoice = { readonly kind: 'option'; readonly index: number } | { readonly kind: 'typed'; readonly text: string };

/**
 * Apply one settled conflict to the stored card. The chosen value is read from the stored conflict
 * by position; the only text ever taken from the owner is their own typed answer. A price question sets that offer's
 * price; any other question is closed only.
 */
export function settleConflict(profile: Pick<BrandProfile, 'offers' | 'approvedClaims' | 'conflicts' | 'sources'> & Partial<Pick<BrandProfile, 'strict'>>, index: number, choice: ConflictChoice):
  Pick<BrandProfile, 'offers' | 'approvedClaims' | 'conflicts'> & { sources: readonly ProfileFactSource[] } {
  const conflict = Number.isInteger(index) && index >= 0 ? profile.conflicts[index] : undefined;
  if (!conflict) throw new SeoBlogError(400, 'That question is not on this card any more. Reload the page and try again.');
  let value: string, documentId: string | null, quote: string | null;
  if (choice.kind === 'option') {
    const option = Number.isInteger(choice.index) && choice.index >= 0 ? conflict.options?.[choice.index] : undefined;
    if (!option) throw new SeoBlogError(400, 'That answer is not one of the choices on this card. Reload the page and try again.');
    ({ value, documentId, quote } = option);
  } else {
    value = clip(choice.text, 300);
    if (value.length < 2) throw new SeoBlogError(400, 'Type the right answer, or choose one of the answers shown.');
    documentId = null; quote = null;
  }
  // A question about a price always settles onto that offer's price. It never becomes a loose claim beside a different price.
  const offer = priceConflictOffer(conflict, profile.offers);
  if (conflict.kind === 'price' && !offer) throw new SeoBlogError(409, 'We could not tell which of the things you sell this price belongs to, so nothing was changed. Read your website again to get a fresh card.');
  const conflicts = profile.conflicts.filter((_, i) => i !== index);
  const sources = [...(profile.sources ?? [])];
  if (offer) {
    // A price the owner did not choose must not live on in the description.
    const offers = profile.offers.map((o) => o === offer ? { ...o, price: value, priceSourceDocumentId: documentId, description: withoutOtherPrices(o.description ?? '', value) } : o);
    return { offers, approvedClaims: profile.approvedClaims, conflicts, sources };
  }
  // Website door only: picking one of the model's answers to a model-written question closes it and adds no claim (the
  // title and the answer are both the model's words). An answer the owner typed is saved as their own, on every card.
  if (profile.strict === true && choice.kind === 'option') return { offers: profile.offers, approvedClaims: profile.approvedClaims, conflicts, sources };
  const claim = clip(`${conflict.field}: ${value}`, 400);
  const approvedClaims = profile.approvedClaims.some((c) => sameValue(c, claim)) ? profile.approvedClaims : [...profile.approvedClaims, claim];
  sources.push({ field: 'claim', value: claim, documentId, quote });
  return { offers: profile.offers, approvedClaims, conflicts, sources };
}

/** Keep the source of every fact that survives an owner's wording change; a new line is recorded as the owner's own. */
export function sourcesAfterEdit(before: readonly ProfileFactSource[] | undefined, field: 'audience' | 'claim', prior: readonly string[], next: readonly string[]): ProfileFactSource[] {
  const kept = (before ?? []).filter((s) => s.field !== field || next.some((v) => sameValue(v, s.value)));
  const added = next.filter((v) => !prior.some((p) => sameValue(p, v)) && !kept.some((s) => s.field === field && sameValue(s.value, v)))
    .map((v): ProfileFactSource => ({ field, value: v, documentId: null, quote: null }));
  return [...kept, ...added];
}

// ─── The card the owner reads ────────────────────────────────────────────────

export interface DnaSource {
  /** "From your Pricing page", "From your document “Price list”", "You told us". */
  readonly label: string;
  readonly url: string | null;
  readonly quote: string | null;
}
export interface DnaItem { readonly text: string; readonly source: DnaSource | null }
export interface DnaOffer {
  readonly name: string; readonly description: string; readonly source: DnaSource | null; readonly price: string | null; readonly priceSource: DnaSource | null; readonly priceOpen: boolean;
  /** Website door, rules v3: the rest of the offer's checked price structure, each line with where it was read. */
  readonly pricing?: DnaPricing;
}
export interface DnaPriceLine { readonly text: string; readonly label: string | null; readonly total: string | null; readonly for: string | null; readonly source: DnaSource }
export interface DnaPricing { readonly also: readonly DnaPriceLine[]; readonly plans: readonly DnaPriceLine[]; readonly specials: readonly DnaPriceLine[] }
export interface DnaConflict {
  readonly index: number;
  readonly title: string;
  readonly detail: string;
  readonly options: readonly { readonly index: number; readonly value: string; readonly source: DnaSource }[];
}
/**
 * One line taken off the card because it could not be found word for word. `fix` says where the owner can add it:
 * the card's own correction form, Brand setup's profile form, or their documents (then read again).
 */
export interface DnaLeftOut { readonly label: string; readonly fix: 'card' | 'setup' | 'documents' }
export interface BrandDnaCard {
  readonly summary: string;
  readonly positioning: string;
  readonly offers: readonly DnaOffer[];
  readonly audiences: readonly DnaItem[];
  readonly claims: readonly DnaItem[];
  readonly voice: Readonly<{ tone: readonly string[]; do: readonly string[]; dont: readonly string[] }>;
  readonly never: readonly string[];
  readonly conflicts: readonly DnaConflict[];
  readonly missing: readonly string[];
  readonly readFrom: readonly { readonly label: string; readonly url: string | null }[];
  /** Facts shown without a recorded source (cards made before Brand DNA). The screen says so rather than implying one. */
  readonly unsourced: number;
  /** True only for a website-door card made under today's rules. */
  readonly checked: boolean;
  /** True for any card made by the website door, whichever rules it was made under. */
  readonly fromWebsite?: boolean;
  /** A website-door card checked under older, looser rules: the page asks the owner to read the website again. */
  readonly rulesOutdated?: boolean;
  /** What was left off this card because it could not be found word for word. Never used in writing. */
  readonly leftOut: readonly DnaLeftOut[];
}

const LEFT_OUT_LABEL: Record<ProfileLeftOut['what'], [string, DnaLeftOut['fix'], boolean]> = {
  price: ['The price of', 'documents', true], offer: ['The offer', 'documents', true], offer_detail: ['The description of', 'documents', true],
  audience: ['Who it is for:', 'card', true], claim: ['The claim', 'card', true], question: ['The question about', 'documents', true],
  // The summary and positioning were the model's own words with a figure in them: they are named, not repeated.
  summary: ['The summary', 'card', false], positioning: ['The positioning line', 'setup', false],
  voice: ['The style note', 'documents', true], voice_dont: ['The “avoid” line', 'card', true], link: ['The link', 'documents', true],
  exclusion: ['The “never say” line', 'card', true],
};

/** "The price of “Mentoring programme”". Plain words; the quoted part is the model's and is escaped wherever it is shown. */
export function leftOutLines(items: readonly ProfileLeftOut[] | undefined): DnaLeftOut[] {
  return (items ?? []).flatMap((item) => {
    const known = LEFT_OUT_LABEL[item.what];
    if (!known) return [];
    if (!known[2]) return [{ label: known[0], fix: known[1] }];
    const whole = clip(item.text, 2000), text = whole.slice(0, 120).trim();
    // A question whose own title could not be found word for word is named without it.
    if (!text && item.what === 'question') return [{ label: 'One of the questions we found', fix: known[1] }];
    const found = item.what === 'price' && item.found ? ` (your page says “${clip(item.found, 120)}”)` : '';
    return [{ label: `${known[0]} “${text}${whole.length > 120 ? '…' : ''}”${found}`, fix: known[1] }];
  });
}

export function documentLabel(doc: Pick<KnowledgeDocument, 'title' | 'origin'> | null | undefined): string {
  if (!doc) return 'a document that has since been removed';
  return doc.origin?.kind === 'website' ? `your ${pageLabel(doc.origin.url)}` : `your document “${doc.title}”`;
}

/** The card the owner reads. A Setup (documents-only) card is built exactly as before Brand DNA's website rules. */
export function brandDnaCard(profile: BrandProfile, documents: readonly KnowledgeDocument[]): BrandDnaCard {
  return profile.strict === true ? websiteDoorCard(profile, documents) : setupCard(profile, documents);
}

function setupCard(profile: BrandProfile, documents: readonly KnowledgeDocument[]): BrandDnaCard {
  const latest = new Map<string, KnowledgeDocument>();
  for (const d of documents) if (!latest.has(d.id) || latest.get(d.id)!.version < d.version) latest.set(d.id, d);
  const from = (documentId: string | null | undefined, quote: string | null = null): DnaSource | null => {
    if (documentId === undefined) return null;
    if (documentId === null) return { label: 'You told us', url: null, quote: null };
    const doc = latest.get(documentId);
    return { label: `From ${documentLabel(doc)}`, url: doc?.origin?.url ?? null, quote };
  };
  let unsourced = 0;
  const sourced = (field: ProfileFactSource['field'], text: string): DnaItem => {
    const s = (profile.sources ?? []).find((x) => x.field === field && sameValue(x.value, text));
    if (!s) unsourced++;
    return { text, source: s ? from(s.documentId, s.quote) : null };
  };
  const offers = profile.offers.map((o): DnaOffer => {
    const priceOpen = profile.conflicts.some((c) => priceConflictOffer(c, profile.offers) === o);
    const source = o.sourceDocumentId ? from(o.sourceDocumentId) : null;
    if (!source) unsourced++;
    const priceSource = !o.price ? null : o.priceSourceDocumentId !== undefined ? from(o.priceSourceDocumentId) : source;
    return { name: o.name, description: o.description, source, price: o.price, priceSource, priceOpen };
  });
  const used = new Set<string>([...profile.knowledge.map((k) => k.documentId)]);
  const readFrom = [...used].map((id) => latest.get(id)).filter((d): d is KnowledgeDocument => Boolean(d?.text))
    .map((d) => ({ label: documentLabel(d).replace(/^your /, ''), url: d.origin?.url ?? null }));
  return {
    summary: profile.summary, positioning: profile.positioning, offers,
    audiences: profile.audiences.map((a) => sourced('audience', a)), claims: profile.approvedClaims.map((c) => sourced('claim', c)),
    voice: { tone: profile.voice.tone, do: profile.voice.do, dont: profile.voice.dont }, never: profile.exclusions,
    conflicts: profile.conflicts.map((c, index): DnaConflict => ({
      index, title: c.field, detail: c.detail,
      options: (c.options ?? []).map((o, i) => ({ index: i, value: o.value, source: from(o.documentId, o.quote)! })),
    })),
    missing: profile.missingFacts, readFrom, unsourced, checked: profile.strict === true, leftOut: leftOutLines(profile.leftOut),
  };
}

/** At most this many "What we could not find" notes on a website-door card (rules v3). */
export const GAP_NOTES_SHOWN = 6;
const PRICE_NOTE = /\bprices?\b|\bpric(?:ed|ing)\b|\bcosts?\b|\bfees?\b|\binstal(?:l)?ments?\b|\bpayments?\b|\bwebinar\b|\bspecial\b|\boffers?\b|\bfound(?:er|ers|ing)\b|\bdiscount|£/iu;
/** A note about an offer's price, instalments or special offer goes when that offer has a checked price structure or an
 * open question about its price; the rest are capped. */
function gapNotes(profile: BrandProfile): string[] {
  const settled = profile.offers.filter((o) => (o.pricing?.lines.length ?? 0) > 0 || profile.conflicts.some((c) => priceConflictOffer(c, profile.offers) === o));
  return profile.missingFacts.filter(missingFactShowable)
    .filter((m) => !(PRICE_NOTE.test(m) && settled.some((o) => loose(m).includes(loose(o.name.replace(/^the\s+/i, ''))))))
    .slice(0, GAP_NOTES_SHOWN);
}

/** How a price structure line is written in the card's correction form, one per line. */
const PRICING_LABEL: Record<OfferPriceLine['role'], string> = { other: 'Also', plan: 'Instalments', special: 'Special offer' };
export function pricingEditLine(l: OfferPriceLine): string {
  return `${PRICING_LABEL[l.role]}: ${l.label ? `${l.label} — ` : ''}${l.text}${l.role === 'plan' && l.total ? ` (${l.total})` : ''}`;
}
export const pricingEditText = (o: ProfileOffer) => (o.pricing?.lines ?? []).map(pricingEditLine).join('\n');
/**
 * The owner's corrected price lines for one offer (website door). The box submitted exactly as it was shown changes nothing.
 * Otherwise every line is the owner's own ("You told us"), read by its label ("Also:", "Instalments:", "Special offer:";
 * no label: "Also"), never tied to a parent, never re-checked. `price` is never touched here.
 */
export function pricingAfterEdit(offer: ProfileOffer, submitted: string): ProfileOffer {
  const norm = (t: string) => t.replace(/\r/g, '').split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
  if (norm(submitted) === norm(pricingEditText(offer))) return offer;
  const lines: OfferPriceLine[] = [];
  for (const raw of norm(submitted).split('\n').filter(Boolean).slice(0, 12)) {
    const m = /^(also|instalments|special offer)\s*:\s*(.*)$/iu.exec(raw);
    const role: OfferPriceLine['role'] = !m ? 'other' : m[1]!.toLowerCase() === 'instalments' ? 'plan' : m[1]!.toLowerCase() === 'special offer' ? 'special' : 'other';
    const text = clip(m ? m[2]! : raw, 300);
    if (text) lines.push({ role, text, documentId: null, quote: null });
  }
  const { pricing: _old, ...rest } = offer;
  return lines.length ? { ...rest, pricing: { lines } } : rest;
}

function websiteDoorCard(profile: BrandProfile, documents: readonly KnowledgeDocument[]): BrandDnaCard {
  const latest = new Map<string, KnowledgeDocument>();
  for (const d of documents) if (!latest.has(d.id) || latest.get(d.id)!.version < d.version) latest.set(d.id, d);
  const from = (documentId: string | null | undefined, quote: string | null = null): DnaSource | null => {
    if (documentId === undefined) return null;
    if (documentId === null) return { label: 'You told us', url: null, quote: null };
    const doc = latest.get(documentId);
    return { label: `From ${documentLabel(doc)}`, url: doc?.origin?.url ?? null, quote: quote === null ? null : withoutMarkers(quote) };
  };
  // The site's own sentence that holds a line, shown beside it (never the page's structure markers).
  const claimLine = (documentId: string | null | undefined, text: string): string | null => {
    const doc = documentId ? latest.get(documentId) : undefined;
    return doc?.text ? claimSentence(text, doc) : null;
  };
  let unsourced = 0;
  const sourced = (field: ProfileFactSource['field'], text: string): DnaItem => {
    const s = (profile.sources ?? []).find((x) => x.field === field && sameValue(x.value, text));
    if (!s) unsourced++;
    return { text, source: s ? from(s.documentId, (field === 'claim' ? claimLine(s.documentId, text) : null) ?? s.quote) : null };
  };
  const offers = profile.offers.map((o): DnaOffer => {
    const priceOpen = profile.conflicts.some((c) => priceConflictOffer(c, profile.offers) === o);
    const source = o.sourceDocumentId ? from(o.sourceDocumentId) : null;
    if (!source) unsourced++;
    // Beside a price: the lines the price rule used, as recorded when the card was made (an owner-settled price has none).
    const priceDoc = o.priceSourceDocumentId !== undefined ? o.priceSourceDocumentId : o.sourceDocumentId;
    const ruled = o.priceSourceDocumentId === undefined && o.price
      ? (profile.sources ?? []).find((s) => s.field === 'price' && s.documentId === o.sourceDocumentId && s.value === o.name && s.quote !== null && appearsIn(s.quote, o.price!)) : undefined;
    // An accepted price structure says where the check found the price (its document and line).
    const checkedAt = o.priceSourceDocumentId === undefined && o.pricing?.priceDocumentId ? o.pricing : null;
    const priceSource = !o.price ? null : checkedAt ? from(checkedAt.priceDocumentId, checkedAt.priceQuote ?? null) : from(priceDoc, ruled?.quote ?? null);
    const lines = o.pricing?.lines ?? [];
    const line = (l: OfferPriceLine): DnaPriceLine => ({ text: l.text, label: l.label ?? null, total: l.total ?? null, for: l.for ?? null,
      source: l.documentId === null ? { label: 'You told us', url: null, quote: null } : from(l.documentId, l.quote)! });
    const pricing: DnaPricing | undefined = lines.length ? { also: lines.filter((l) => l.role === 'other').map(line), plans: lines.filter((l) => l.role === 'plan').map(line), specials: lines.filter((l) => l.role === 'special').map(line) } : undefined;
    return { name: o.name, description: o.description, source, price: o.price, priceSource, priceOpen, ...(pricing ? { pricing } : {}) };
  });
  const used = new Set<string>([...profile.knowledge.map((k) => k.documentId)]);
  const readFrom = [...used].map((id) => latest.get(id)).filter((d): d is KnowledgeDocument => Boolean(d?.text))
    .map((d) => ({ label: documentLabel(d).replace(/^your /, ''), url: d.origin?.url ?? null }));
  return {
    summary: profile.summary, positioning: profile.positioning, offers,
    audiences: profile.audiences.map((a) => sourced('audience', a)), claims: profile.approvedClaims.map((c) => sourced('claim', c)),
    voice: { tone: profile.voice.tone, do: profile.voice.do, dont: profile.voice.dont }, never: profile.exclusions,
    conflicts: profile.conflicts.map((c, index): DnaConflict => ({
      // A price question's legend names its offer (a bare "price" gets the offer's name; the stored question is unchanged).
      index, title: (c.kind === 'price' && /^\s*(?:the\s+)?prices?\s*$/iu.test(c.field) && priceConflictOffer(c, profile.offers) ? `${priceConflictOffer(c, profile.offers)!.name}: price` : c.field.trim()) || (c.offer ? `${c.offer}: price` : 'A question about your details'), detail: c.detail,
      options: (c.options ?? []).map((o, i) => ({ index: i, value: o.value, source: from(o.documentId, o.quote)! })),
    })),
    missing: checkedUnderCurrentRules(profile) ? gapNotes(profile) : profile.missingFacts.filter(missingFactShowable), readFrom, unsourced, checked: checkedUnderCurrentRules(profile), fromWebsite: profile.strict === true, rulesOutdated: profile.strict === true && !checkedUnderCurrentRules(profile), leftOut: leftOutLines(profile.leftOut),
  };
}

// ─── The background task ─────────────────────────────────────────────────────

export interface BrandDnaResult {
  readonly pagesRead: number;
  readonly pagesChanged: number;
  readonly words: number;
  /** False when the website gave almost no words and the card is built from the owner's documents alone. */
  readonly websiteReadable: boolean;
}
export interface BrandDnaJobPayload {
  readonly stage: typeof BRAND_DNA_STAGE;
  readonly requestedBy: string;
  readonly commandId: string;
  /** Fixed at request time so a repeated run can never queue a second card. */
  readonly profileJobId: string;
  /** The owner pressed "Read my website again" on a confirmed card, having been told content pauses. */
  readonly replaceConfirmed: boolean;
  readonly acknowledgePriorUsage: boolean;
  readonly result?: BrandDnaResult;
  readonly reason?: 'no_words' | 'confirmed' | 'allowance' | 'unavailable';
}
export function isBrandDnaJob(job: Job): boolean { return job.kind === 'inventory' && job.payload.stage === BRAND_DNA_STAGE; }
export function brandDnaPayload(job: Job): BrandDnaJobPayload { return job.payload as unknown as BrandDnaJobPayload; }
