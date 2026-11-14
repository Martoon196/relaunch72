/**
 * Brand DNA from a website address: the pure rules.
 *
 * The owner pastes an address; the existing website read keeps the words of the
 * few pages that describe the business; each page becomes an ordinary versioned
 * brand document; the existing profile extraction then proposes a card. Nothing
 * here calls a model, the network or the database.
 *
 * "Nothing invented" is enforced here, not asked for politely:
 *   - a price must appear word for word in the document it cites, on whole numbers ("£4" is not in "£49");
 *   - every audience and claim must quote a supplied document, and the quote must carry its key words and figures;
 *   - differing prices for one offer are never settled by the machine, and the price stays empty until the owner chooses;
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
  return text.normalize('NFKC').replace(/[‘’‚‛]/g, "'").replace(/[“”„‟]/g, '"').replace(/[‐-―−]/g, '-')
    .replace(/\s+/g, ' ').trim().toLowerCase();
}

/** `needle` sits in `hay` without cutting a number in half: "£4" is not in "£49", "£49" is not in "£499", "£49.99" or "£49k". */
function foundWhole(hay: string, needle: string): boolean {
  // A needle ending "1," or "1." still ends inside a number when the text goes on with a digit: "£1," is not in "£1,500".
  const startsWithDigit = /^\d/.test(needle), endsWithDigit = /\d[.,]?$/.test(needle);
  for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + 1)) {
    if (startsWithDigit && /(?:\d|\d[.,])$/.test(hay.slice(Math.max(0, at - 2), at))) continue;
    if (endsWithDigit && /^(?:\d|[.,]\d|\s?%|\s?(?:k|m|bn|thousand|million|billion)\b)/.test(hay.slice(at + needle.length, at + needle.length + 10))) continue;
    return true;
  }
  return false;
}

/** True when `quote` appears in `text`, ignoring only case, spacing and typographic quote/dash variants. Numbers match whole. */
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

const SMALL_WORDS = new Set(['about', 'across', 'also', 'and', 'any', 'are', 'been', 'being', 'both', 'but', 'can', 'each', 'every', 'for', 'from', 'had', 'has', 'have', 'her', 'his', 'into', 'its',
  'just', 'more', 'most', 'not', 'only', 'our', 'out', 'over', 'such', 'than', 'that', 'the', 'their', 'them', 'then', 'these', 'they', 'this', 'those', 'too', 'very', 'was', 'were', 'what', 'when',
  'which', 'who', 'whom', 'will', 'with', 'you', 'your']);
const wordsOf = (text: string) => plain(text).split(/[^a-z0-9]+/).filter(Boolean);

/** The words that carry a fact's meaning: longer words first, short ones only when there is nothing else. */
function keyWords(text: string): string[] {
  const words = [...new Set(wordsOf(text).filter((w) => !SMALL_WORDS.has(w) && !/^\d+$/.test(w)))];
  const long = words.filter((w) => w.length >= 4);
  return long.length ? long : words.filter((w) => w.length >= 2);
}

/**
 * Why `quote` does not support `value`, or null when it does. The quote must be long enough to mean something,
 * share at least two thirds of the fact's key words (by word stem) and contain every figure the fact states.
 */
export function unsupportedBy(value: string, quote: string | null | undefined): string | null {
  if (!meaningfulQuote(quote)) return 'the quote is too short to support it (quote at least three words)';
  for (const figure of figuresIn(value)) if (!appearsIn(quote, figure)) return `it states "${figure}", which the quote does not contain`;
  const keys = keyWords(value);
  if (!keys.length) return null;
  const quoted = wordsOf(quote ?? '');
  const hits = keys.filter((k) => quoted.some((q) => q.startsWith(k.slice(0, 5)))).length;
  return hits >= Math.ceil((keys.length * 2) / 3) ? null : 'the quote does not use the same key words';
}

/** The part of a profile these rules read. Structural so the extraction module can use it without a cycle. */
export type ProfileFacts = Pick<BrandProfile, 'offers' | 'audiences' | 'approvedClaims' | 'conflicts' | 'missingFacts'> & Partial<Pick<BrandProfile, 'summary' | 'positioning' | 'voice'>> & { readonly sources?: readonly ProfileFactSource[] };
type SourceText = Pick<KnowledgeDocument, 'id' | 'text'>;

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

/**
 * Reasons a site-fed extraction must be corrected. Any entry sends the model's one correction pass; what still
 * fails after it is taken off the card by `repairProfileFacts`, and only a card with nothing verifiable left is refused.
 */
export function strictProfileProblems(value: ProfileFacts, documents: readonly SourceText[]): string[] {
  const byId = new Map(documents.map((d) => [d.id, d]));
  const everywhere = documents.map((d) => d.text ?? '').join('\n');
  const problems: string[] = [];
  for (const o of value.offers) {
    const doc = o.sourceDocumentId ? byId.get(o.sourceDocumentId) : undefined;
    if (!doc) { problems.push(`offer "${o.name}" must name the supplied document it came from in sourceDocumentId`); continue; }
    if (o.price && !appearsIn(doc.text, o.price)) problems.push(`offer "${o.name}": the price "${o.price}" does not appear character for character in document ${doc.id}. Copy it exactly as written there, or set price to null and add the gap to missingFacts`);
    for (const figure of figuresIn(o.name)) if (!appearsIn(doc.text, figure)) problems.push(`the name of offer "${o.name}" states "${figure}", which is not in document ${doc.id}. Name the offer as that document does`);
    for (const figure of figuresIn(o.description ?? '')) if (!appearsIn(doc.text, figure)) problems.push(`the description of "${o.name}" states "${figure}", which is not in document ${doc.id}. Remove the figure or copy one exactly as that document writes it`);
  }
  const sources = value.sources ?? [];
  for (const s of sources) {
    const doc = s.documentId ? byId.get(s.documentId) : undefined;
    if (!doc) problems.push(`source for "${s.value}" cites a document id that was not supplied`);
    else if (!appearsIn(doc.text, s.quote)) problems.push(`source for "${s.value}": the quote is not word for word in document ${doc.id}`);
  }
  const quoted = (field: ProfileFactSource['field'], item: string) => sources.filter((s) => s.field === field && sameValue(s.value, item) && s.documentId && byId.has(s.documentId) && appearsIn(byId.get(s.documentId)!.text, s.quote));
  for (const [field, label, items] of [['audience', 'audience', value.audiences], ['claim', 'approved claim', value.approvedClaims]] as const) {
    for (const item of items) {
      const found = quoted(field, item);
      if (!found.length) { problems.push(`${label} "${item}" has no sources entry with a word-for-word quote. Quote the document that states it, or remove it`); continue; }
      const why = found.map((s) => unsupportedBy(item, s.quote));
      if (!why.includes(null)) problems.push(`${label} "${item}": ${why[0]}. Quote the words that state it, including every number, or remove it`);
    }
  }
  for (const c of value.conflicts) {
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
      else for (const figure of figuresIn(option.value)) if (!appearsIn(option.quote, figure)) problems.push(`conflict "${c.field}": the quote for "${option.value}" must contain "${figure}"`);
    }
  }
  // The free-text parts (the summary, the positioning, voice lines and examples) carry no source line on the card,
  // so a figure in them must exist in at least one supplied source. Words are the model's; numbers are not.
  const freeText: [string, string][] = [['summary', value.summary ?? ''], ['positioning', value.positioning ?? ''],
    ...(['tone', 'do', 'dont', 'examples'] as const).flatMap((part) => (value.voice?.[part] ?? []).map((line): [string, string] => [part === 'examples' ? 'voice example' : `voice "${part}" line`, line]))];
  for (const [where, text] of freeText) {
    for (const figure of figuresIn(text)) {
      if (!appearsIn(everywhere, figure)) problems.push(`the ${where} states "${figure}", which is in none of the supplied documents. Remove the figure or copy one exactly as a document writes it`);
    }
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
 * Website door only, after the model's correction pass: take off exactly the lines that cannot be found word for word
 * and keep everything that can. It never adds, rewrites or paraphrases anything; it only removes a line, empties a
 * price or empties a whole free-text field. Each rule mirrors one in `strictProfileProblems`, so
 * `strictProfileProblems(result.value, documents)` is [].
 *
 * Free text (an offer description, the summary, the positioning) is never cut down to the sentences that pass: taking
 * one sentence away can turn the rest into a stronger statement nobody wrote ("Rent is guaranteed." without "This
 * applies only for the first 18 months."). If any part fails, the whole field is emptied and listed as left out.
 *
 * Returns null when the answer cannot be repaired truthfully: a price question that is dropped but cannot be tied to
 * one offer (its price could otherwise be shown as settled), or a question marked "other" that is really about a price.
 */
export function repairProfileFacts<T extends ProfileFacts>(value: T, documents: readonly SourceText[]): ProfileRepair<T> | null {
  const byId = new Map(documents.map((d) => [d.id, d]));
  const everywhere = documents.map((d) => d.text ?? '').join('\n');
  const leftOut: ProfileLeftOut[] = [];
  const leave = (what: ProfileLeftOut['what'], text: string) => { if (!leftOut.some((l) => l.what === what && sameValue(l.text, text))) leftOut.push({ what, text: clip(text, 300) }); };

  // A source line counts only when its quote is word for word in a supplied document.
  const sources = (value.sources ?? []).filter((s) => s.documentId && byId.has(s.documentId) && appearsIn(byId.get(s.documentId)!.text, s.quote));

  // Offers: no valid source, or a figure in the name the source does not state, drops the offer. A price not word for
  // word in the source is emptied. A description stating any figure the source does not is emptied as a whole.
  const offers: ProfileOffer[] = [];
  for (const o of value.offers) {
    const doc = o.sourceDocumentId ? byId.get(o.sourceDocumentId) : undefined;
    if (!doc || figuresIn(o.name).some((f) => !appearsIn(doc.text, f))) { leave('offer', o.name); continue; }
    let next: ProfileOffer = o;
    if (o.price && !appearsIn(doc.text, o.price)) { next = { ...next, price: null }; leave('price', o.name); }
    if (figuresIn(o.description ?? '').some((f) => !appearsIn(doc.text, f))) { next = { ...next, description: '' }; leave('offer_detail', o.name); }
    offers.push(next);
  }

  // Audiences and claims: kept only with a word-for-word quote that carries their key words and figures.
  const supported = (field: 'audience' | 'claim', item: string) => sources.some((s) => s.field === field && sameValue(s.value, item) && unsupportedBy(item, s.quote) === null);
  const audiences = value.audiences.filter((a) => supported('audience', a) || (leave('audience', a), false));
  const approvedClaims = value.approvedClaims.filter((c) => supported('claim', c) || (leave('claim', c), false));
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
        && figuresIn(option.value).every((f) => appearsIn(option.quote, f));
    });
    const malformed = (c.kind !== 'price' && c.kind !== 'other') || (c.kind === 'price' && !named);
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
      leave('question', c.field);
      continue;
    }
    const { offer: _offer, options: _options, ...rest } = c;
    conflicts.push({ ...rest, documentIds: c.documentIds.filter((id) => byId.has(id)),
      // An offer name that is not on the card is emptied (only allowed for a question that is not about a price).
      ...(c.offer !== undefined ? { offer: named ? c.offer : null } : {}), ...(c.options !== undefined ? { options } : {}) });
  }

  // An offer whose price the repair emptied keeps no price in its description, exactly as a held price question does.
  const priceEmptied = new Set(leftOut.filter((l) => l.what === 'price').map((l) => l.text));
  const pricedOffers = offers.map((o) => {
    let next = o;
    if (noPrice.has(o) && o.price) { leave('price', o.name); next = { ...next, price: null }; }
    if (noPrice.has(o) || priceEmptied.has(clip(o.name, 300))) {
      const description = withoutOtherPrices(next.description ?? '', null);
      if (description !== (next.description ?? '')) { leave('offer_detail', o.name); next = { ...next, description }; }
    }
    return next;
  });

  // Free text carries no source line, so a field stating a figure in no document is emptied whole; a voice line is dropped.
  const anywhere = (f: string) => appearsIn(everywhere, f);
  const freeText = (what: 'summary' | 'positioning', text: string | undefined): string | undefined => {
    if (text === undefined || figuresIn(text).every(anywhere)) return text;
    leave(what, text);
    return '';
  };
  const lines = (what: 'voice' | 'voice_dont', items: readonly string[]) => items.filter((line) => figuresIn(line).every(anywhere) || (leave(what, line), false));
  const voice = value.voice ? { ...value.voice, tone: lines('voice', value.voice.tone), do: lines('voice', value.voice.do), dont: lines('voice_dont', value.voice.dont), examples: lines('voice', value.voice.examples) } : undefined;
  const summary = freeText('summary', value.summary), positioning = freeText('positioning', value.positioning);

  const repaired: T = { ...value, offers: pricedOffers, audiences, approvedClaims, conflicts,
    ...(value.sources !== undefined ? { sources: keptSources } : {}),
    ...(summary !== undefined ? { summary } : {}), ...(positioning !== undefined ? { positioning } : {}), ...(voice ? { voice } : {}) };
  return { value: repaired, leftOut };
}

/**
 * The left-out lines that are still true after the owner changed the card by hand. A line goes as soon as the thing it
 * names is on the card again (the same audience or claim, a summary or positioning, the same "avoid" line, a price on
 * that offer). Matching is exact (case and spacing aside); a line re-added in different words stays listed.
 */
export function leftOutAfterEdit(leftOut: readonly ProfileLeftOut[] | undefined, card: Pick<BrandProfile, 'summary' | 'positioning' | 'audiences' | 'approvedClaims' | 'offers' | 'voice'>): ProfileLeftOut[] | undefined {
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
 * Keep only provenance that can be shown truthfully. Used on every extraction: on the older
 * documents-only path it quietly drops a source the model could not support (as before, that path
 * rejects nothing new); on the site-fed path the strict check has already rejected such output.
 */
export function cleanProvenance<T extends ProfileFacts>(value: T, documents: readonly SourceText[]): T {
  const byId = new Map(documents.map((d) => [d.id, d]));
  const sources: ProfileFactSource[] = [];
  for (const s of value.sources ?? []) {
    if (s.field !== 'audience' && s.field !== 'claim' && s.field !== 'voice' && s.field !== 'offer') continue;
    const doc = s.documentId ? byId.get(s.documentId) : undefined;
    // A source line is only ever shown when its quote is in that document and really carries the fact.
    if (!doc || !appearsIn(doc.text, s.quote) || unsupportedBy(String(s.value ?? ''), s.quote)) continue;
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
 * prices for an offer (monthly and yearly, say).
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
 * Site-fed extractions only: add the backstop conflicts and make sure no conflicted price is shown as settled.
 * Only the offer a price question is about is held; its description loses any sentence that states a price.
 */
export function holdConflictedPrices<T extends ProfileFacts>(value: T, documents: readonly SourceText[]): T {
  const added = priceConflicts(value, documents);
  const conflicts = [...value.conflicts.slice(0, Math.max(0, 30 - added.length)), ...added];
  const held = new Set(conflicts.map((c) => priceConflictOffer(c, value.offers)).filter(Boolean));
  const offers = value.offers.map((o) => held.has(o) ? { ...o, price: null, description: withoutOtherPrices(o.description ?? '', null) } : o);
  return { ...value, offers, conflicts };
}

// ─── The owner settles a conflict ────────────────────────────────────────────

export type ConflictChoice = { readonly kind: 'option'; readonly index: number } | { readonly kind: 'typed'; readonly text: string };

/**
 * Apply one settled conflict to the stored card. The chosen value is read from the stored conflict
 * by position; the only text ever taken from the owner is their own typed answer.
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
  /** True only for a card made by the website door, where every price, audience and claim was checked word for word. */
  readonly checked: boolean;
  /** What was left off this card because it could not be found word for word. Never used in writing. */
  readonly leftOut: readonly DnaLeftOut[];
}

const LEFT_OUT_LABEL: Record<ProfileLeftOut['what'], [string, DnaLeftOut['fix'], boolean]> = {
  price: ['The price of', 'documents', true], offer: ['The offer', 'documents', true], offer_detail: ['The description of', 'documents', true],
  audience: ['Who it is for:', 'card', true], claim: ['The claim', 'card', true], question: ['The question about', 'documents', true],
  // The summary and positioning were the model's own words with a figure in them: they are named, not repeated.
  summary: ['The summary', 'card', false], positioning: ['The positioning line', 'setup', false],
  voice: ['The style note', 'documents', true], voice_dont: ['The “avoid” line', 'card', true], link: ['The link', 'documents', true],
};

/** "The price of “Mentoring programme”". Plain words; the quoted part is the model's and is escaped wherever it is shown. */
export function leftOutLines(items: readonly ProfileLeftOut[] | undefined): DnaLeftOut[] {
  return (items ?? []).flatMap((item) => {
    const known = LEFT_OUT_LABEL[item.what];
    if (!known) return [];
    if (!known[2]) return [{ label: known[0], fix: known[1] }];
    const whole = clip(item.text, 2000), text = whole.slice(0, 120).trim();
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
      index, title: c.field, detail: c.detail,
      options: (c.options ?? []).map((o, i) => ({ index: i, value: o.value, source: from(o.documentId, o.quote)! })),
    })),
    missing: profile.missingFacts, readFrom, unsourced, checked: profile.strict === true, leftOut: leftOutLines(profile.leftOut),
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
