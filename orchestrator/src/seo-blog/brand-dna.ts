/**
 * Brand DNA from a website address: the pure rules.
 *
 * The owner pastes an address; the existing website read keeps the words of the
 * few pages that describe the business; each page becomes an ordinary versioned
 * brand document; the existing profile extraction then proposes a card. Nothing
 * here calls a model, the network or the database.
 *
 * "Nothing invented" is enforced here, not asked for politely:
 *   - a price must appear word for word in the document it cites;
 *   - every audience and claim must quote a supplied document;
 *   - differing prices for one offer are never settled by the machine;
 *   - a settled choice takes its value from the stored card, never the browser.
 */

import { createHash } from 'node:crypto';
import type {
  BrandProfile, InventoryPage, Job, KnowledgeCategory, KnowledgeDocument, ProfileConflict, ProfileConflictOption,
  ProfileFactSource, ProfileOffer,
} from './types.js';
import { SeoBlogError } from './types.js';

export const BRAND_DNA_STAGE = 'brand_dna';
/** Pages whose words are kept from one website read. */
export const BRAND_PAGE_LIMIT = 12;
/** Characters kept per page. */
export const BRAND_PAGE_TEXT_LIMIT = 8000;
/** Fewer readable words than this across the whole read means the site could not really be read. */
export const BRAND_DNA_MIN_WORDS = 60;

// ─── Which pages describe the business ───────────────────────────────────────

const PRICE_PAGES = /^(pricing|prices?|fees?|plans?|packages?|offers?|costs?|rates?|membership|memberships|join)$/i;
const OFFER_PAGES = /^(services?|products?|what-we-do|how-it-works|courses?|training|mentoring|mentorship|coaching|programmes?|programs?|solutions?|work-with-us|investors?|landlords?|sellers?|buyers?|sourcing|deals?)$/i;
const ABOUT_PAGES = /^(about|about-us|our-story|who-we-are|team|meet-the-team|why-us)$/i;
const OTHER_PAGES = /^(faqs?|frequently-asked-questions|contact|contact-us|testimonials|reviews|case-studies|results)$/i;

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

/** True when `quote` appears in `text`, ignoring only case, spacing and typographic quote/dash variants. */
export function appearsIn(text: string | null | undefined, quote: string | null | undefined): boolean {
  const needle = plain(quote ?? '');
  return needle.length >= 2 && plain(text ?? '').includes(needle);
}

const sameValue = (a: string, b: string) => plain(a) === plain(b);
const loose = (text: string) => plain(text).replace(/[^a-z0-9£]+/g, ' ').trim();

/** The part of a profile these rules read. Structural so the extraction module can use it without a cycle. */
export type ProfileFacts = Pick<BrandProfile, 'offers' | 'audiences' | 'approvedClaims' | 'conflicts' | 'missingFacts'> & { readonly sources?: readonly ProfileFactSource[] };
type SourceText = Pick<KnowledgeDocument, 'id' | 'text'>;

function conflictOffer<T extends Pick<ProfileOffer, 'name'>>(conflict: ProfileConflict, offers: readonly T[]): T | null {
  if (conflict.offer) {
    const exact = offers.find((o) => sameValue(o.name, conflict.offer!));
    if (exact) return exact;
  }
  const field = loose(conflict.field), detail = loose(conflict.detail);
  return offers.find((o) => loose(o.name).length >= 3 && (field.includes(loose(o.name)) || detail.includes(loose(o.name)))) ?? null;
}

/**
 * Reasons a site-fed extraction must be rejected. Any entry sends the model's one correction pass;
 * a second failure stops the task with nothing saved.
 */
export function strictProfileProblems(value: ProfileFacts, documents: readonly SourceText[]): string[] {
  const byId = new Map(documents.map((d) => [d.id, d]));
  const problems: string[] = [];
  for (const o of value.offers) {
    const doc = o.sourceDocumentId ? byId.get(o.sourceDocumentId) : undefined;
    if (!doc) { problems.push(`offer "${o.name}" must name the supplied document it came from in sourceDocumentId`); continue; }
    if (o.price && !appearsIn(doc.text, o.price)) problems.push(`offer "${o.name}": the price "${o.price}" does not appear character for character in document ${doc.id}. Copy it exactly as written there, or set price to null and add the gap to missingFacts`);
  }
  const sources = value.sources ?? [];
  for (const s of sources) {
    const doc = s.documentId ? byId.get(s.documentId) : undefined;
    if (!doc) problems.push(`source for "${s.value}" cites a document id that was not supplied`);
    else if (!appearsIn(doc.text, s.quote)) problems.push(`source for "${s.value}": the quote is not word for word in document ${doc.id}`);
  }
  const sourced = (field: ProfileFactSource['field'], item: string) => sources.some((s) => s.field === field && sameValue(s.value, item) && s.documentId && byId.has(s.documentId) && appearsIn(byId.get(s.documentId)!.text, s.quote));
  for (const a of value.audiences) if (!sourced('audience', a)) problems.push(`audience "${a}" has no sources entry with a word-for-word quote. Quote the document that states it, or remove it`);
  for (const c of value.approvedClaims) if (!sourced('claim', c)) problems.push(`approved claim "${c}" has no sources entry with a word-for-word quote. Quote the document that states it, or remove it`);
  for (const c of value.conflicts) {
    for (const id of c.documentIds) if (!byId.has(id)) problems.push(`conflict "${c.field}" cites a document id that was not supplied`);
    for (const option of c.options ?? []) {
      const doc = byId.get(option.documentId);
      if (!doc) problems.push(`conflict "${c.field}" has an option citing a document id that was not supplied`);
      else if (!appearsIn(doc.text, option.quote)) problems.push(`conflict "${c.field}": the option quote "${option.quote.slice(0, 60)}" is not word for word in document ${doc.id}`);
      else if (c.kind === 'price' && !appearsIn(doc.text, option.value)) problems.push(`conflict "${c.field}": the price option "${option.value}" does not appear character for character in document ${doc.id}`);
    }
  }
  return problems.slice(0, 12);
}

const clip = (text: unknown, max: number) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

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
    if (!doc || !appearsIn(doc.text, s.quote)) continue;
    sources.push({ field: s.field, value: clip(s.value, 400), documentId: doc.id, quote: clip(s.quote, 300) });
  }
  const conflicts = value.conflicts.map((c): ProfileConflict => {
    const options = (c.options ?? []).flatMap((o): ProfileConflictOption[] => {
      const doc = byId.get(o.documentId);
      return doc && appearsIn(doc.text, o.quote) && clip(o.value, 300) ? [{ value: clip(o.value, 300), documentId: doc.id, quote: clip(o.quote, 300) }] : [];
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

function pricesNear(text: string, name: string): FoundPrice[] {
  const haystack = text.replace(/\s+/g, ' ');
  const lower = haystack.toLowerCase(), needle = name.replace(/\s+/g, ' ').trim().toLowerCase();
  if (needle.length < 3) return [];
  const found: FoundPrice[] = [];
  let from = 0;
  for (let hits = 0; hits < 20; hits++) {
    const at = lower.indexOf(needle, from);
    if (at === -1) break;
    from = at + needle.length;
    const start = Math.max(0, at - 120), end = Math.min(haystack.length, at + needle.length + 240);
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
    if (value.conflicts.some((c) => conflictOffer(c, [offer]) && (c.kind === 'price' || (c.kind === undefined && /price|cost|fee|£/i.test(`${c.field} ${c.detail}`))))) continue;
    const perDoc = documents.map((d) => ({ id: d.id, prices: d.text ? pricesNear(d.text, offer.name) : [] })).filter((d) => d.prices.length > 0);
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

/** Site-fed extractions only: add the backstop conflicts and make sure no conflicted price is shown as settled. */
export function holdConflictedPrices<T extends ProfileFacts>(value: T, documents: readonly SourceText[]): T {
  const conflicts = [...value.conflicts, ...priceConflicts(value, documents)].slice(0, 30);
  const offers = value.offers.map((o) => conflicts.some((c) => c.kind === 'price' && conflictOffer(c, [o])) ? { ...o, price: null } : o);
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
  const offer = conflict.kind === 'price' ? conflictOffer(conflict, profile.offers) : null;
  const conflicts = profile.conflicts.filter((_, i) => i !== index);
  const sources = [...(profile.sources ?? [])];
  if (offer) {
    const offers = profile.offers.map((o) => o === offer ? { ...o, price: value, priceSourceDocumentId: documentId } : o);
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
    const priceOpen = profile.conflicts.some((c) => c.kind === 'price' && conflictOffer(c, [o]));
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
    missing: profile.missingFacts, readFrom, unsourced,
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
