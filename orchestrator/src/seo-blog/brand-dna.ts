/**
 * Brand DNA from a website address: the pure rules.
 *
 * The owner pastes an address; the existing website read keeps the words of the
 * few pages that describe the business; each page becomes an ordinary versioned
 * brand document; the existing profile extraction then proposes a card. Nothing
 * here calls a model, the network or the database.
 *
 * Two classes of field (the exact rules are in `brand-dna-rules.ts`):
 *   - QUOTED FACTS are the business's own words, checked exactly: an approved claim is one whole sentence of a source;
 *     an audience is an unbroken run of words in one sentence that negates nothing; an offer name is written in the
 *     document it cites; a price is the full price expression written first beside its offer's name; a link is on the
 *     business's own site;
 *   - DESCRIPTION (summary, positioning, offer descriptions, voice, conversion-page labels) is our wording: it carries no
 *     money or percentage at all, any other number must be one a source states, and writers receive it under
 *     `descriptionNotFacts`, told never to take a fact, price or promise from it;
 *   - the model's own notes (what it could not find, the wording of a question) are shown to the owner only;
 * *   - differing prices for one offer are never settled by the machine, and the price stays empty until the owner chooses;
 *   - a settled choice takes its value from the stored card, never the browser;
 *   - pages read from the website are only held with the card task until a card built from them is saved.
 */

import { createHash } from 'node:crypto';
import type {
  BrandProfile, InventoryPage, Job, KnowledgeCategory, KnowledgeDocument, ProfileConflict, ProfileConflictOption,
  ProfileFactSource, ProfileLeftOut, ProfileOffer,
} from './types.js';
import { materialFigures } from './checks.js';
import { SeoBlogError } from './types.js';
import {
  AUDIENCE_MAX, audienceUnit, basisText, claimUnit, wordRun, cutDescription, linkAllowed, linkLabel, NEVER_SAY_MAX, neverSayKept, offerNameProblem, priceStatus, sourceNumbers, tiedPrices,
  type LinkContext, type PriceStatus,
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
  return text.replace(/[^\S\n]+/g, ' ').replace(/ *\n[\s]*/g, '\n').trim().slice(0, BRAND_PAGE_TEXT_LIMIT);
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
      createdAt: input.now, origin: { kind: 'website', url: page.url, fetchedAt: input.now },
    });
  }
  return { documents, pagesRead, unchanged, words };
}

// ─── Word-for-word checks ────────────────────────────────────────────────────

function plain(text: string): string {
  return basisText(text).replace(/[‘’‚‛]/g, "'").replace(/[“”„‟]/g, '"').replace(/[‐-―−]/g, '-')
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
type SourceText = Pick<KnowledgeDocument, 'id' | 'text'> & { readonly page?: string | null };
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
  /** 'tied': the price stands. 'untied': emptied and listed. 'ambiguous': emptied and put to the owner as a question. */
  readonly price: PriceStatus | null;
  readonly description: { readonly text: string; readonly cut: readonly string[] };
  readonly urlBad: boolean;
}
interface Decisions {
  readonly offers: readonly OfferDecision[];
  readonly names: readonly string[];
}

function linkContext(documents: readonly SourceText[], context: SourceContext): LinkContext {
  return { website: context.website ?? null, pages: documents.map((d) => d.page) };
}

function decideOffers(value: ProfileFacts, documents: readonly SourceText[], context: SourceContext): Decisions {
  const byId = new Map(documents.map((d) => [d.id, d]));
  const names = value.offerNames ?? value.offers.map((o) => o.name);
  const numbers = sourceNumbers(documents);
  const links = linkContext(documents, context);
  const offers = value.offers.map((o): OfferDecision => {
    const doc = o.sourceDocumentId ? byId.get(o.sourceDocumentId) : undefined;
    const description = cutDescription(o.description ?? '', numbers);
    if (!doc) return { offer: o, drop: 'must name the supplied document it came from in sourceDocumentId', price: null, description, urlBad: false };
    const nameProblem = offerNameProblem(o.name, doc);
    if (nameProblem) return { offer: o, drop: `its name ${nameProblem}. Name the offer exactly as that document does`, price: null, description, urlBad: false };
    const self = names.findIndex((n) => sameValue(n, o.name));
    const price = o.price ? priceStatus(o.price, doc, names, self < 0 ? names.length : self) : null;
    return { offer: o, drop: null, price, description, urlBad: Boolean(o.url) && !linkAllowed(o.url, links) };
  });
  return { offers, names };
}

/** The sources entry that supports an audience or claim, or null. Its quote must be word for word in the document it cites. */
function supportingSource(field: 'audience' | 'claim', item: string, value: ProfileFacts, byId: ReadonlyMap<string, SourceText>): ProfileFactSource | null {
  for (const s of value.sources ?? []) {
    if (s.field !== field || !sameValue(s.value, item) || !s.documentId) continue;
    const doc = byId.get(s.documentId);
    // The quote shown beside the line must hold it, and the line must pass its rule in the document the quote is from.
    if (!doc || !appearsIn(doc.text, s.quote) || !meaningfulQuote(s.quote) || !wordRun(s.quote, item)) continue;
    if (field === 'claim' ? claimUnit(item, doc) : audienceUnit(item, doc)) return s;
  }
  return null;
}
const hasQuotedSource = (field: 'audience' | 'claim', item: string, value: ProfileFacts, byId: ReadonlyMap<string, SourceText>) =>
  (value.sources ?? []).some((s) => s.field === field && sameValue(s.value, item) && s.documentId && byId.has(s.documentId) && appearsIn(byId.get(s.documentId)!.text, s.quote) && meaningfulQuote(s.quote));

/** A voice example is the business's own words: one whole sentence of a source, exactly as an approved claim must be. */
const exampleOk = (line: string, documents: readonly SourceText[]) => documents.some((d) => claimUnit(line, d) !== null);
/** A voice tone/do/don't line is description: each of its sentences must pass the description rule, or the line goes. */
const voiceLineOk = (line: string, numbers: ReadonlySet<string>) => cutDescription(line, numbers).cut.length === 0;

/** A price question's answer must be one of the full price expressions tied to that offer in the document it cites. */
function priceOptionOk(option: ProfileConflictOption, offer: string, doc: SourceText, names: readonly string[]): boolean {
  const self = names.findIndex((n) => sameValue(n, offer));
  return priceStatus(option.value, doc, names, self < 0 ? names.length : self) !== 'untied';
}

/**
 * Reasons a site-fed extraction must be corrected. Any entry sends the model's one correction pass; what still
 * fails after it is taken off the card by `repairProfileFacts`, and only a card with nothing verifiable left is refused.
 * Every rule here is the same function the repair applies, over the same offer list, so a repaired card has no problem.
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
    if (d.price === 'untied') problems.push(`offer "${o.name}": the price "${o.price}" is not written as the first price beside "${o.name}" in document ${o.sourceDocumentId}. Copy the whole price exactly as written there with its words ("from", "per month", "+ VAT"), or set price to null and add the gap to missingFacts`);
    if (d.price === 'ambiguous') problems.push(`offer "${o.name}": document ${o.sourceDocumentId} gives more than one price beside "${o.name}". Set price to null: the owner will be asked which is right`);
    if (d.urlBad) problems.push(`offer "${o.name}": the url must be an https address on the business's own website, or null`);
    if (d.description.cut.length) problems.push(`the description of "${o.name}" has a sentence with a price, a percentage or a number no document states ("${d.description.cut[0]!.slice(0, 80)}"). Descriptions are your own words and carry no figures`);
  }
  for (const s of value.sources ?? []) {
    const doc = s.documentId ? byId.get(s.documentId) : undefined;
    if (!doc) problems.push(`source for "${s.value}" cites a document id that was not supplied`);
    else if (!appearsIn(doc.text, s.quote)) problems.push(`source for "${s.value}": the quote is not word for word in document ${doc.id}`);
  }
  for (const item of value.approvedClaims) {
    if (!hasQuotedSource('claim', item, value, byId)) problems.push(`approved claim "${item}" has no sources entry with a word-for-word quote. Quote the document that states it, or remove it`);
    else if (!supportingSource('claim', item, value, byId)) problems.push(`approved claim "${item}" is not one whole sentence of the document it cites. An approved claim is a complete sentence copied exactly, start to end (not in quotation marks, not a question), or remove it`);
  }
  for (const item of value.audiences) {
    if (!hasQuotedSource('audience', item, value, byId)) problems.push(`audience "${item}" has no sources entry with a word-for-word quote. Quote the document that states it, or remove it`);
    else if (!supportingSource('audience', item, value, byId)) problems.push(`audience "${item}" is not an unbroken run of words in one sentence of the document it cites that has no "not", "no", "never", "without" or "unlike". Copy the words exactly (at most ${AUDIENCE_MAX} characters), or remove it`);
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
      else if (c.kind === 'price' && c.offer && !priceOptionOk(option, c.offer, doc, decided.names)) problems.push(`conflict "${c.field}": the price option "${option.value}" is not a whole price written beside "${c.offer}" in document ${doc.id}. Offer only prices that document states for this offer, with their words`);
    }
  }
  for (const line of value.exclusions ?? []) {
    if (!neverSayKept(line, documents)) problems.push(`exclusion "${line}" must be a short topic or prohibition (at most ${NEVER_SAY_MAX} characters, no numbers or prices) and not something the business itself says`);
  }
  for (const line of value.missingFacts) {
    if (!missingFactShowable(line)) problems.push(`missingFacts line "${line}" states a number or price. Name the gap in words only`);
  }
  const links = linkContext(documents, context);
  for (const p of value.conversionPages ?? []) {
    if (!linkAllowed(p.url, links)) problems.push(`conversion page ${p.url} is not an https address on the business's own website`);
    else if (linkLabel(p.label, p.url, documents) !== p.label) problems.push(`conversion page ${p.url}: its label must be words copied from a supplied document (at most 80 characters)`);
  }
  // Description is our wording: no money or percentage at all, and only numbers a source states.
  const free: [string, string][] = [['summary', value.summary ?? ''], ['positioning', value.positioning ?? ''],
    ...(['tone', 'do', 'dont'] as const).flatMap((part) => (value.voice?.[part] ?? []).map((line): [string, string] => [`voice "${part}" line`, line]))];
  for (const [where, text] of free) {
    const cut = cutDescription(text, numbers).cut;
    if (cut.length) problems.push(`the ${where} has a sentence with a price, a percentage or a number no document states ("${cut[0]!.slice(0, 80)}"). Description is your own words and carries no figures`);
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
 * description (summary, positioning, offer descriptions) that carry a figure. Cutting a sentence can leave description
 * saying less, or more plainly, than the model wrote; every cut is listed under "What we left out", and description never
 * reaches a writer as fact. Each decision is the one `strictProfileProblems` makes, over the same offer list (the model's
 * own list, carried in `offerNames`), so `strictProfileProblems(result.value, documents)` is [].
 *
 * Returns null when the answer cannot be repaired truthfully: a price question that is dropped but cannot be tied to
 * one offer (its price could otherwise be shown as settled), or a question marked "other" that is really about a price.
 */
export function repairProfileFacts<T extends ProfileFacts>(value: T, documents: readonly SourceText[], context: SourceContext = {}): ProfileRepair<T> | null {
  const byId = new Map(documents.map((d) => [d.id, d]));
  const everywhere = documents.map((d) => d.text ?? '').join('\n');
  const numbers = sourceNumbers(documents);
  const leftOut: ProfileLeftOut[] = [];
  const leave = (what: ProfileLeftOut['what'], text: string) => { if (!leftOut.some((l) => l.what === what && sameValue(l.text, text))) leftOut.push({ what, text: clip(text, 300) }); };
  const anywhere = (f: string) => appearsIn(everywhere, f);
  const decided = decideOffers(value, documents, context);

  // A source line counts only when its quote is word for word in a supplied document.
  const sources = (value.sources ?? []).filter((s) => s.documentId && byId.has(s.documentId) && appearsIn(byId.get(s.documentId)!.text, s.quote));

  const offers: ProfileOffer[] = [];
  for (const d of decided.offers) {
    const o = d.offer;
    if (d.drop) { leave('offer', o.name); continue; }
    let next: ProfileOffer = o;
    if (d.price === 'untied') { next = { ...next, price: null }; leave('price', o.name); }
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
  // question about an offer no longer on the card is dropped. A price it held stays empty: nothing is chosen.
  const noPrice = new Set<ProfileOffer>();
  const conflicts: ProfileConflict[] = [];
  for (const c of value.conflicts) {
    const named = typeof c.offer === 'string' && c.offer.trim() ? offers.find((o) => sameValue(o.name, c.offer!)) ?? null : undefined;
    const options = (c.options ?? []).filter((option) => {
      const doc = byId.get(option.documentId);
      return doc && appearsIn(doc.text, option.quote) && meaningfulQuote(option.quote) && appearsIn(doc.text, option.value)
        && figuresIn(option.value).every((f) => appearsIn(option.quote, f))
        && !(c.kind === 'price' && c.offer && !priceOptionOk(option, c.offer, doc, decided.names));
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

  // Description: whole sentences with a figure are cut (and listed); a voice line with one goes; an example that is not
  // one whole sentence of a source goes.
  const freeText = (what: 'summary' | 'positioning', text: string | undefined): string | undefined => {
    if (text === undefined) return text;
    const cut = cutDescription(text, numbers);
    if (!cut.cut.length) return text;
    leave(what, text);
    // A summary too short to stand on its own is emptied: the owner writes one before confirming.
    return cut.text.length < 10 ? '' : cut.text;
  };
  const lines = (what: 'voice' | 'voice_dont', items: readonly string[]) => items.filter((line) => voiceLineOk(line, numbers) || (leave(what, line), false));
  const voice = value.voice ? { ...value.voice, tone: lines('voice', value.voice.tone), do: lines('voice', value.voice.do), dont: lines('voice_dont', value.voice.dont),
    examples: value.voice.examples.filter((line) => exampleOk(line, documents) || (leave('voice', line), false)) } : undefined;
  const summary = freeText('summary', value.summary), positioning = freeText('positioning', value.positioning);

  // "Never say" lines restrict the writer only: kept unless they carry a figure, run long, or forbid the business's own words.
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

/**
 * Keep only provenance that can be shown truthfully. Used on every extraction (on the website door after the repair, so
 * nothing more goes there). A claim's source line is kept when its quote is word for word in the document and the claim
 * is one whole sentence of that document; an audience's when the audience rule holds; a voice or offer line when its quote
 * is word for word and at least three words. On the documents-only Setup path this only decides which source lines are
 * shown; it removes no claim, audience or other line from the profile.
 */
export function cleanProvenance<T extends ProfileFacts>(value: T, documents: readonly SourceText[]): T {
  const byId = new Map(documents.map((d) => [d.id, d]));
  const sources: ProfileFactSource[] = [];
  for (const s of value.sources ?? []) {
    if (s.field !== 'audience' && s.field !== 'claim' && s.field !== 'voice' && s.field !== 'offer') continue;
    const doc = s.documentId ? byId.get(s.documentId) : undefined;
    if (!doc || !appearsIn(doc.text, s.quote)) continue;
    const item = String(s.value ?? '');
    const shown = s.field === 'claim' ? claimUnit(item, doc) !== null && wordRun(s.quote, item) : s.field === 'audience' ? audienceUnit(item, doc) !== null && wordRun(s.quote, item) : meaningfulQuote(s.quote);
    if (!shown) continue;
    sources.push({ field: s.field, value: clip(s.value, 400), documentId: doc.id, quote: clip(s.quote, 300) });
  }
  const conflicts = value.conflicts.map((c): ProfileConflict => {
    const options = (c.options ?? []).flatMap((o): ProfileConflictOption[] => {
      const doc = byId.get(o.documentId);
      // A choice is only offered when both its answer and its quote are word for word in the document it names.
      return doc && appearsIn(doc.text, o.quote) && clip(o.value, 300).length >= 2 && appearsIn(doc.text, o.value) ? [{ value: clip(o.value, 300), documentId: doc.id, quote: clip(o.quote, 300) }] : [];
    }).slice(0, 6);
    const kind = c.kind === 'price' ? 'price' as const : 'other' as const;
    const offer = typeof c.offer === 'string' && c.offer.trim() ? clip(c.offer, 200) : null;
    // Fields the model did not give are left absent, so a documents-only profile keeps its earlier shape.
    return { field: c.field, detail: c.detail, documentIds: c.documentIds, ...(c.kind ? { kind } : {}), ...(offer ? { offer } : {}), ...(options.length ? { options } : {}) };
  });
  // The model never states who typed a price: that field belongs to an owner's settled choice only.
  const offers = value.offers.map((o): ProfileOffer => ({ name: o.name, description: o.description, price: o.price ?? null, url: o.url ?? null, sourceDocumentId: o.sourceDocumentId ?? null }));
  const cleaned: T = { ...value, offers, conflicts, sources: sources.slice(0, 120) };
  if (!sources.length) delete (cleaned as { sources?: unknown }).sources;
  return cleaned;
}

// ─── Price backstop ──────────────────────────────────────────────────────────

const PRICE_PHRASE = /£\s?\d[\d,]*(?:\.\d{1,2})?(?:\s?(?:k|m)\b)?(?:\s?\+\s?vat\b|\s?(?:per|a|each|every|\/)\s?(?:calendar\s)?(?:month|year|week|day|annum|person|session|hour|property|deal)\b|\s?(?:pcm|pm|pa|p\/m)\b)*/gi;

interface FoundPrice { readonly amount: number; readonly phrase: string; readonly quote: string }

function pricesNear(text: string, name: string, otherNames: readonly string[]): FoundPrice[] {
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
 * prices for an offer (monthly and yearly, say). Deliberately broad: THE PRICE RULE never narrows this search,
 * so a disagreement anywhere in the business's sources is always put to the owner.
 */
export function priceConflicts(value: Pick<ProfileFacts, 'offers' | 'conflicts'>, documents: readonly SourceText[]): ProfileConflict[] {
  const added: ProfileConflict[] = [];
  for (const offer of value.offers) {
    // Skipped only when a price question for this offer is already on the card; a different question about the same offer does not hide a price disagreement.
    if (value.conflicts.some((c) => priceConflictOffer(c, value.offers) === offer)) continue;
    const otherNames = value.offers.filter((o) => o !== offer).map((o) => o.name.replace(/\s+/g, ' ').trim().toLowerCase()).filter((n) => n.length >= 3);
    const perDoc = documents.map((d) => ({ id: d.id, prices: d.text ? pricesNear(d.text, offer.name, otherNames) : [] })).filter((d) => d.prices.length > 0);
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

/**
 * One offer, one price: when the document an offer cites puts more than one price beside its name (was and now, a range,
 * a set-up fee, a monthly and a yearly figure), the card asks the owner which is right instead of picking. Each answer is
 * a full price expression exactly as written, quoted with its sentence.
 */
export function morePriceQuestions(value: Pick<ProfileFacts, 'offers' | 'conflicts'>, documents: readonly SourceText[]): ProfileConflict[] {
  const byId = new Map(documents.map((d) => [d.id, d]));
  const names = value.offers.map((o) => o.name);
  const added: ProfileConflict[] = [];
  for (const [i, offer] of value.offers.entries()) {
    if (value.conflicts.some((c) => priceConflictOffer(c, value.offers) === offer)) continue;
    const doc = offer.sourceDocumentId ? byId.get(offer.sourceDocumentId) : undefined;
    if (!doc) continue;
    const tied = tiedPrices(doc, names, i);
    if (tied.length < 2) continue;
    const options = tied.slice(0, 6).map((x): ProfileConflictOption => ({ value: clip(x.text, 300), documentId: doc.id, quote: clip(x.unit?.text ?? x.text, 300) }));
    added.push({ field: `${offer.name}: price`, detail: `We found more than one price for ${offer.name}. Which is right?`, documentIds: [doc.id], kind: 'price', offer: offer.name, options });
  }
  return added;
}

/**
 * Site-fed extractions only: add the backstop and "more than one price" questions and make sure no questioned price is
 * shown as settled. Only the offer a price question is about is held; its description loses any sentence that states a price.
 */
export function holdConflictedPrices<T extends ProfileFacts>(value: T, documents: readonly SourceText[]): T {
  const backstop = priceConflicts(value, documents);
  const several = morePriceQuestions({ offers: value.offers, conflicts: [...value.conflicts, ...backstop] }, documents);
  const added = [...backstop, ...several];
  const conflicts = [...value.conflicts.slice(0, Math.max(0, 30 - added.length)), ...added];
  const held = new Set(conflicts.map((c) => priceConflictOffer(c, value.offers)).filter(Boolean));
  const offers = value.offers.map((o) => held.has(o) ? { ...o, price: null, description: withoutOtherPrices(o.description ?? '', null) } : o);
  return { ...value, offers, conflicts };
}

// ─── What a writing step may be given ────────────────────────────────────────

/** The version of the rules a website-door card was checked under. A card with a lower (or no) version is re-filtered for writing. */
export const BRAND_DNA_RULES_VERSION = 2;

/** True for a website-door card checked under today's rules. */
export function checkedUnderCurrentRules(profile: Pick<BrandProfile, 'strict' | 'rulesVersion'>): boolean {
  return profile.strict === true && (profile.rulesVersion ?? 1) >= BRAND_DNA_RULES_VERSION;
}

/** An offer's quoted facts as a writing step sees them. The description is not here: it is description, not fact. */
export interface WritingOffer { readonly name: string; readonly price: string | null; readonly url: string | null; readonly sourceDocumentId: string | null }

/** An offer link a writing step may see: an absolute https address on the business's own site, or nothing. */
export function writingUrl(url: string | null | undefined, website?: string | null): string | null {
  if (typeof url !== 'string') return null;
  if (website) return linkAllowed(url, { website }) ? url : null;
  return /^https:\/\/[^\s\\@]+$/i.test(url) && url.startsWith('https://') ? url : null;
}

export function writingOffers(profile: Pick<BrandProfile, 'offers' | 'strict' | 'rulesVersion'>, website?: string | null): WritingOffer[] {
  // A card from before today's rules, read without the website address, has links nobody can check here: none are passed.
  const trusted = checkedUnderCurrentRules(profile) || profile.strict !== true;
  return profile.offers.map((o) => ({ name: o.name, price: o.price ?? null, url: website || trusted ? writingUrl(o.url, website) : null, sourceDocumentId: o.sourceDocumentId ?? null }));
}

export interface WritingProfile {
  /** Copied from the business's own pages and documents: whole-sentence claims. */
  readonly approvedClaims: readonly string[];
  readonly audiences: readonly string[];
  /** Offer names and their full price expressions. */
  readonly offers: readonly WritingOffer[];
  readonly conversionPages: readonly { readonly url: string; readonly label: string }[];
  /** Topics and wording never to use. Restrictions only. */
  readonly exclusions: readonly string[];
  readonly offersWithOpenQuestions: readonly string[];
  readonly hasOtherOpenQuestions: boolean;
  /** Our own description of the business, for tone and context only. Never a source of a fact, figure, price or promise. */
  readonly descriptionNotFacts: {
    readonly summary: string; readonly positioning: string;
    readonly voice: { readonly tone: readonly string[]; readonly do: readonly string[]; readonly dont: readonly string[]; readonly examples: readonly string[] };
    readonly offerDescriptions: readonly { readonly offer: string; readonly description: string }[];
  };
}

/**
 * The one list of profile fields that reach any writing prompt (planning, article, section, social, campaign).
 * Quoted facts (claims, audiences, offer names and prices, never-say lines, links) sit at the top level; our description
 * sits under `descriptionNotFacts`. Never included: `missingFacts`, question titles, details and answers, `sources` and
 * their quotes, `leftOut`, confirmation fields and owner-settled price provenance.
 *
 * A website-door card checked under today's rules is passed as it was checked (links re-checked against `website` when
 * given). Any other card (an older website-door card, or a documents-only Setup profile, which no program checks) is
 * filtered with what can be applied without its sources: description sentences with money or a percentage are cut (on an
 * older website-door card, any sentence with a number, and its voice examples and "never say" lines with a number go),
 * and links must be on the website's own host. Claims, audiences and prices on those cards are passed as the owner
 * confirmed them: they were not checked under today's rules, and the card page says so for a website-door card.
 */
export function writingProfile(profile: BrandProfile, website?: string | null): WritingProfile {
  const current = checkedUnderCurrentRules(profile);
  const olderDoor = profile.strict === true && !current;
  // Without sources, an older website-door card's numbers cannot be checked: description keeps none. A Setup profile keeps
  // its other numbers (the owner wrote or confirmed them) but never money or a percentage in description.
  const numbers: ReadonlySet<string> | null = olderDoor ? null : new Set(numbersInDescriptionAllowed(profile));
  const describe = (text: string) => current ? text : cutDescription(text, numbers).text;
  const line = (items: readonly string[]) => current ? [...items] : items.filter((l) => cutDescription(l, numbers).cut.length === 0);
  const links = (url: string) => !website ? (current || !olderDoor) && writingUrl(url) !== null : linkAllowed(url, { website });
  const open = [...new Set(profile.conflicts.map((c) => conflictOffer(c, profile.offers)?.name).filter((n): n is string => Boolean(n)))];
  return {
    approvedClaims: [...profile.approvedClaims], audiences: [...profile.audiences], offers: writingOffers(profile, website),
    conversionPages: profile.conversionPages.filter((p) => links(p.url)).map((p) => ({ url: p.url, label: p.label })),
    exclusions: olderDoor ? profile.exclusions.filter((l) => !/[\p{N}£$€¥%]/u.test(l)) : [...profile.exclusions],
    offersWithOpenQuestions: open, hasOtherOpenQuestions: profile.conflicts.some((c) => conflictOffer(c, profile.offers) === null),
    descriptionNotFacts: {
      summary: describe(profile.summary), positioning: describe(profile.positioning),
      voice: { tone: line(profile.voice.tone), do: line(profile.voice.do), dont: line(profile.voice.dont), examples: olderDoor ? [] : [...profile.voice.examples] },
      offerDescriptions: profile.offers.map((o) => ({ offer: o.name, description: describe(o.description ?? '') })).filter((o) => o.description),
    },
  };
}

/** A Setup profile's description may keep any number other than money or a percentage: every number it states counts as allowed. */
function numbersInDescriptionAllowed(profile: BrandProfile): string[] {
  const all = [profile.summary, profile.positioning, ...profile.voice.tone, ...profile.voice.do, ...profile.voice.dont, ...profile.offers.map((o) => o.description ?? '')].join(' ');
  return [...sourceNumbers([{ text: all }])];
}

// ─── The owner settles a conflict ────────────────────────────────────────────

export type ConflictChoice = { readonly kind: 'option'; readonly index: number } | { readonly kind: 'typed'; readonly text: string };

/**
 * Apply one settled conflict to the stored card. The chosen value is read from the stored conflict
 * by position; the only text ever taken from the owner is their own typed answer. A price question sets that offer's
 * price; any other question is closed only.
 */
export function settleConflict(profile: Pick<BrandProfile, 'offers' | 'approvedClaims' | 'conflicts' | 'sources'>, index: number, choice: ConflictChoice):
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
  // Any other question is closed and nothing else changes. Its title was written by the model, so it never becomes an
  // approved claim; the owner adds a claim in their own words if they want one.
  void documentId; void quote;
  return { offers: profile.offers, approvedClaims: profile.approvedClaims, conflicts, sources };
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
export interface DnaOffer { readonly name: string; readonly description: string; readonly source: DnaSource | null; readonly price: string | null; readonly priceSource: DnaSource | null; readonly priceOpen: boolean }
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
  /** True only for a website-door card checked under today's rules. */
  readonly checked: boolean;
  /** A website-door card checked under older, looser rules: the page asks the owner to read the website again. */
  readonly rulesOutdated: boolean;
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
    return [{ label: `${known[0]} “${text}${whole.length > 120 ? '…' : ''}”`, fix: known[1] }];
  });
}

export function documentLabel(doc: Pick<KnowledgeDocument, 'title' | 'origin'> | null | undefined): string {
  if (!doc) return 'a document that has since been removed';
  return doc.origin?.kind === 'website' ? `your ${pageLabel(doc.origin.url)}` : `your document “${doc.title}”`;
}

export function brandDnaCard(profile: BrandProfile, documents: readonly KnowledgeDocument[]): BrandDnaCard {
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
      index, title: c.field.trim() || (c.offer ? `${c.offer}: price` : 'A question about your details'), detail: c.detail,
      options: (c.options ?? []).map((o, i) => ({ index: i, value: o.value, source: from(o.documentId, o.quote)! })),
    })),
    missing: profile.missingFacts.filter(missingFactShowable), readFrom, unsourced, checked: checkedUnderCurrentRules(profile), rulesOutdated: profile.strict === true && !checkedUnderCurrentRules(profile), leftOut: leftOutLines(profile.leftOut),
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
