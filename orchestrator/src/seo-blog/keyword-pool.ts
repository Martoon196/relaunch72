/**
 * Keyword pool: turns raw measured candidates into a ranked, explainable list
 * of phrases a business could write about. PURE: no I/O, no clock, no random.
 * Not wired into the engine, planner, router or any screen yet.
 *
 * Steps (plan section 2, "Building the candidate list"):
 *  1. Seeds from the business: confirmed Brand DNA offers and audiences, the
 *     locations it serves, and titles of its existing pages.
 *  2. Normalise and de-duplicate candidates (case, punctuation, plurals, word
 *     order and US/UK spelling collapse to one key).
 *  3. Filter, each exclusion recorded with a reason.
 *  4. Cluster deterministically (a pillar and its supporting phrases).
 *  5. Rank with a documented formula and explain each pick in one true sentence.
 *
 * Honest ladder for thin data, per phrase: its own measured number; else the
 * measured number of its wider (parent) phrase, labelled as the wider phrase;
 * else observed only (no number). A number is never invented or carried across
 * to a phrase that was not measured.
 */

import type { KeywordCandidate, KeywordCandidateSource, KeywordIntent } from '../keyword/types.js';
import type { BrandProfile, InventoryPage } from './types.js';
import { MATERIAL_OVERLAP, SUBSTANTIAL_DUPLICATE, slugify, topicTokens } from './dedupe.js';

// ─── Tunable constants (documented; tune after a pilot) ─────────────────────

/** Below this many measured monthly searches a phrase is too small, unless its wider phrase is measured above it. */
export const MIN_SEARCHES = 20;
/** Default difficulty ceiling: "Harder" (50+) is excluded unless the site already ranks 11–30 for the phrase. */
export const DEFAULT_DIFFICULTY_CEILING = 49;
/** Similarity to an existing brief's phrase at or above which a candidate would cannibalise it (plan: 0.6). */
export const CANNIBALISE_SIMILARITY = 0.6;
/** Similarity to a cluster's pillar at or above which a phrase supports that pillar. */
export const CLUSTER_SIMILARITY = MATERIAL_OVERLAP;

/** opportunity = 0.35·V + 0.30·E + 0.25·F + 0.10·Q (see `opportunity`). */
export const RANK_WEIGHTS = Object.freeze({ volume: 0.35, ease: 0.30, fit: 0.25, quickWin: 0.10 });

/**
 * Difficulty bands on the 0–100 ranking-difficulty scale:
 *   Easier 0–29 · Medium 30–49 · Harder 50–100 · Not rated yet (no number).
 * The scale is logarithmic; for the small businesses we serve (young sites,
 * few links) 50+ is realistically out of reach for a new article, and 30 is
 * the usual line between "a good article can rank" and "needs links too".
 */
export const DIFFICULTY_BANDS = Object.freeze({ easierMax: 29, mediumMax: 49 });

export type DifficultyBand = 'easier' | 'medium' | 'harder' | 'not_rated';

export function difficultyBand(difficulty: number | null): { readonly band: DifficultyBand; readonly label: string } {
  if (difficulty === null || !Number.isFinite(difficulty)) return { band: 'not_rated', label: 'Not rated yet' };
  if (difficulty <= DIFFICULTY_BANDS.easierMax) return { band: 'easier', label: 'Easier' };
  if (difficulty <= DIFFICULTY_BANDS.mediumMax) return { band: 'medium', label: 'Medium' };
  return { band: 'harder', label: 'Harder' };
}

export type WhatTheyWant = 'buy' | 'compare' | 'learn';
export function intentLabel(intent: KeywordIntent | null): { readonly want: WhatTheyWant; readonly label: string } | null {
  if (intent === 'transactional') return { want: 'buy', label: 'Buy' };
  if (intent === 'commercial') return { want: 'compare', label: 'Compare' };
  if (intent === 'informational') return { want: 'learn', label: 'Learn' };
  return null;
}

// ─── Normalisation ──────────────────────────────────────────────────────────

// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f­​-‏‪-‮⁠-⁤﻿]/g;
const MAX_CHARS = 80;
const MAX_WORDS = 10;

/**
 * A display-safe phrase: NFKC, no markup, entities, control or invisible
 * characters, no punctuation other than an apostrophe or hyphen inside a word,
 * single spaces, lower case, ≤ 80 characters and ≤ 10 words. Null when nothing
 * usable is left, or when it looks like an address rather than a phrase.
 */
export function normalisePhrase(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let t = raw.normalize('NFKC').replace(INVISIBLE, ' ');
  t = t.replace(/<[^>]*>?/g, ' ').replace(/&[#a-z0-9]+;?/gi, ' ');
  if (/https?:|www\.|@\S+\.\S|\.(com|co\.uk|org|net)\b/i.test(t)) return null;
  t = t.toLowerCase().replace(/[’‘`´]/g, "'").replace(/&/g, ' and ');
  t = t.replace(/[^\p{L}\p{N}'\- ]+/gu, ' ').replace(/(^|\s)['-]+|['-]+(?=\s|$)/g, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  if (!t || !/\p{L}/u.test(t) || t.length > MAX_CHARS || t.split(' ').length > MAX_WORDS) return null;
  return t;
}

/** US → UK spellings that matter in small-business search. Keys only: the phrase people type is kept as typed. */
const UK_SPELLING: Readonly<Record<string, string>> = Object.freeze({
  color: 'colour', colors: 'colours', favorite: 'favourite', favorites: 'favourites', center: 'centre', centers: 'centres',
  organize: 'organise', organizing: 'organising', organization: 'organisation', optimize: 'optimise', optimization: 'optimisation',
  customize: 'customise', customized: 'customised', specialize: 'specialise', specialized: 'specialised', specialist: 'specialist',
  license: 'licence', licenses: 'licences', defense: 'defence', analyze: 'analyse', analyzing: 'analysing', catalog: 'catalogue',
  program: 'programme', programs: 'programmes', mold: 'mould', moldy: 'mouldy', gray: 'grey', jewelry: 'jewellery',
  traveling: 'travelling', traveler: 'traveller', labor: 'labour', neighbor: 'neighbour', neighbors: 'neighbours', neighborhood: 'neighbourhood',
  apartment: 'apartment', renovate: 'renovate', tire: 'tyre', tires: 'tyres', aluminum: 'aluminium', fiber: 'fibre', meter: 'metre',
  theater: 'theatre', cozy: 'cosy', practicing: 'practising', enrollment: 'enrolment', fulfill: 'fulfil', check: 'check',
});

const KEY_DROP = new Set(['a', 'an', 'the']);

function singular(w: string): string {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && /(ches|shes|sses|xes|zes)$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !/(ss|us|is|ous)$/.test(w)) return w.slice(0, -1);
  return w;
}

/** De-duplication key: UK spelling, singular, articles dropped, word order ignored. */
export function phraseKey(phrase: string): string {
  return phrase.split(/[\s-]+/).filter((w) => w && !KEY_DROP.has(w)).map((w) => singular(UK_SPELLING[w] ?? w)).sort().join(' ');
}

/**
 * A looser root for topic matching than `topicTokens` gives on its own, whose
 * single suffix rule maps "letting" to "lett" but "lettings" to "letting".
 */
function root(token: string): string {
  const t = singular(token);
  return t.length > 5 && t.endsWith('ing') ? t.slice(0, -3) : t;
}
function roots(text: string): Set<string> {
  return new Set([...topicTokens(text)].map(root));
}

/** Same arithmetic as `dedupe.topicSimilarity`, on precomputed token sets (5,000 candidates must stay fast). */
export function setSimilarity(ta: ReadonlySet<string>, tb: ReadonlySet<string>): number {
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const jaccard = inter / (ta.size + tb.size - inter);
  const overlap = inter / Math.min(ta.size, tb.size);
  return Math.round((0.6 * jaccard + 0.4 * overlap) * 1000) / 1000;
}

/**
 * Deliberately small list of topics no client article should target. It is a
 * backstop, not a classifier: off-brand phrases are mostly removed by the
 * off-topic and exclusion filters. Whole words only, so "Sussex" or
 * "cracked screen repair" are not caught.
 */
const UNSAFE = /\b(porn\w*|xxx|nsfw|escorts?|casinos?|gambling|betting tips?|cocaine|heroin|suicide|self harm|fake ids?|counterfeit\w*|torrents?)\b/;

// ─── Seeds ──────────────────────────────────────────────────────────────────

export type SeedFrom = 'offer' | 'audience' | 'location' | 'offer_in_location' | 'page';
export interface Seed { readonly phrase: string; readonly from: SeedFrom }

export type PoolProfile = Pick<BrandProfile, 'offers' | 'audiences' | 'exclusions' | 'voice' | 'confirmedAt'>;

export interface PoolBusiness {
  /** Brand DNA. Offers and audiences are used only once the owner has confirmed it. */
  readonly profile: PoolProfile | null;
  readonly brandName: string;
  readonly website: string | null;
  /** Towns or areas served. BrandProfile has no such field today, so the caller supplies them. */
  readonly locations?: readonly string[];
  /** Competitor brand names never to be targeted (owner-confirmed). */
  readonly competitorNames?: readonly string[];
  /** Competitor domains; their first label is also treated as a brand name. */
  readonly competitorDomains?: readonly string[];
  /** The site's existing pages (the stored inventory). */
  readonly pages: readonly InventoryPage[];
  /** Existing and planned articles (briefs), compared by their measured phrase or target question. */
  readonly planned: readonly PlannedPhrase[];
  /** Phrases the owner said "Not for us" to. Never suggested again. */
  readonly dismissed: readonly string[];
}

export interface PlannedPhrase {
  readonly id: string;
  readonly title: string;
  readonly targetQuery: string;
  /** The measured phrase on the brief, when it has one (release 5). */
  readonly phrase?: string | null;
}

const SEED_STOP = new Set(['a', 'an', 'the', 'and', 'or', 'to', 'of', 'for', 'with', 'who', 'that', 'their', 'your', 'our', 'is', 'are', 'in', 'on', 'by', 'from', 'we', 'you', 'my', 'all']);

/** A short search seed (≤ 4 content words) from an offer name, audience line or page title. */
function seedPhrase(text: string, maxWords = 4): string | null {
  const cleaned = normalisePhrase(String(text).replace(/\([^)]*\)/g, ' ').split(/\s[|–—:]\s|\s-\s/)[0] ?? '');
  if (!cleaned) return null;
  const words = cleaned.split(' ').filter((w) => !SEED_STOP.has(w) && !/^\d+$/.test(w)).slice(0, maxWords);
  const s = words.join(' ');
  return s.length >= 3 && /\p{L}{2}/u.test(s) ? s : null;
}

export function businessSeeds(business: PoolBusiness, max = 40): Seed[] {
  const out = new Map<string, Seed>();
  const banned = bannedTerms(business);
  const add = (phrase: string | null, from: SeedFrom) => {
    if (!phrase || out.size >= max) return;
    if (banned.some((b) => containsWords(phrase, b))) return;
    const key = phraseKey(phrase);
    if (key && !out.has(key)) out.set(key, { phrase, from });
  };
  const confirmed = business.profile && business.profile.confirmedAt ? business.profile : null;
  const offers = confirmed ? confirmed.offers.map((o) => seedPhrase(o.name)).filter((s): s is string => !!s) : [];
  const locations = (business.locations ?? []).map((l) => seedPhrase(l, 3)).filter((s): s is string => !!s);
  for (const o of offers) add(o, 'offer');
  for (const o of offers.slice(0, 3)) for (const l of locations.slice(0, 2)) add(`${o} ${l}`, 'offer_in_location');
  for (const a of confirmed ? confirmed.audiences : []) add(seedPhrase(a, 3), 'audience');
  for (const l of locations) add(l, 'location');
  for (const p of [...business.pages].sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0))) {
    if (p.fetchStatus === 'ok' && p.title) add(seedPhrase(p.title, 5), 'page');
  }
  return [...out.values()];
}

function containsWords(phrase: string, words: string): boolean {
  if (!words) return false;
  return ` ${phrase} `.includes(` ${words} `);
}

/** Exclusions and short voice "don't" items (≤ 4 words), as normalised word sequences. */
function bannedTerms(business: PoolBusiness): string[] {
  const p = business.profile;
  const raw = [...(p?.exclusions ?? []), ...(p?.voice.dont ?? []).filter((d) => d.trim().split(/\s+/).length <= 4)];
  return [...new Set(raw.map((r) => normalisePhrase(r)).filter((r): r is string => !!r && r.length >= 3))];
}

function competitorTerms(business: PoolBusiness): string[] {
  const own = normalisePhrase(business.brandName);
  const names = [...(business.competitorNames ?? [])];
  for (const d of business.competitorDomains ?? []) {
    const label = String(d).toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[./]/)[0] ?? '';
    if (label.length >= 4) names.push(label.replace(/-/g, ' '));
  }
  return [...new Set(names.map((n) => normalisePhrase(n)).filter((n): n is string => !!n && n.length >= 3 && n !== own))];
}

// ─── The pool ───────────────────────────────────────────────────────────────

export type SearchBasis = 'measured' | 'parent_phrase' | 'observed';

export type ExclusionReason =
  | 'invalid' | 'unsafe' | 'dismissed' | 'excluded_term' | 'competitor_brand' | 'wrong_intent'
  | 'already_covered' | 'cannibalises' | 'too_small' | 'too_hard' | 'off_topic';

export interface PoolRow {
  /** Stable id from the de-duplication key and market. */
  readonly id: string;
  readonly key: string;
  readonly phrase: string;
  readonly basis: SearchBasis;
  /** This phrase's own measured monthly searches; null unless basis is 'measured'. */
  readonly searches: number | null;
  readonly measuredMonth: string | null;
  readonly parent: string | null;
  /** The wider phrase's measured searches; set only when basis is 'parent_phrase'. */
  readonly parentSearches: number | null;
  readonly parentMeasuredMonth: string | null;
  readonly rankingDifficulty: number | null;
  readonly band: DifficultyBand;
  readonly intent: KeywordIntent | null;
  readonly sources: readonly KeywordCandidateSource[];
  readonly variants: readonly string[];
  readonly ownPosition: number | null;
  readonly clusterId: string;
  readonly role: 'pillar' | 'supporting';
  readonly opportunity: number;
  /** One true sentence, built from the same factors as the score. Names no supplier and no mechanism. */
  readonly why: string;
  readonly labels: { readonly searches: string; readonly difficulty: string; readonly want: string | null; readonly basis: string };
}

export interface PoolExclusion {
  readonly key: string;
  readonly phrase: string;
  readonly reason: ExclusionReason;
  /** For 'already_covered': the address that covers it, or the position the site holds. */
  readonly covered?: { readonly url: string | null; readonly how: 'ranks_top_10' | 'existing_page' | 'planned_article'; readonly position?: number } | null;
}

export interface PoolCluster { readonly id: string; readonly pillarKey: string; readonly memberKeys: readonly string[] }

export interface KeywordPool {
  /** 'measured': at least one measured pick; 'thin': picks exist but none is measured; 'no_data': nothing to suggest. */
  readonly state: 'measured' | 'thin' | 'no_data';
  readonly rows: readonly PoolRow[];
  readonly clusters: readonly PoolCluster[];
  readonly excluded: readonly PoolExclusion[];
}

export interface PoolOptions {
  readonly difficultyCeiling?: number;
  readonly minSearches?: number;
  /** Cap on suggested rows (plan: 300 stored). */
  readonly limit?: number;
}

/** FNV-1a, for stable short ids without I/O. */
function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

const SOURCE_ORDER: readonly KeywordCandidateSource[] = ['overview', 'own_ranked', 'site_keywords', 'ideas', 'suggestions', 'related', 'competitor_ranked', 'serp_question', 'serp_related', 'owner'];
const sourceRank = (s: KeywordCandidateSource) => { const i = SOURCE_ORDER.indexOf(s); return i < 0 ? SOURCE_ORDER.length : i; };
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

interface Merged {
  key: string;
  phrase: string;
  best: KeywordCandidate;
  sources: Set<KeywordCandidateSource>;
  variants: Set<string>;
  parents: Set<string>;
  ownPosition: number | null;
  ownUrl: string | null;
}

/** Measured beats unmeasured; then more searches; then source order; then the phrase itself. Order-independent. */
function better(a: KeywordCandidate, aPhrase: string, b: KeywordCandidate, bPhrase: string): boolean {
  const am = a.searches !== null; const bm = b.searches !== null;
  if (am !== bm) return am;
  if ((a.searches ?? -1) !== (b.searches ?? -1)) return (a.searches ?? -1) > (b.searches ?? -1);
  if (sourceRank(a.source) !== sourceRank(b.source)) return sourceRank(a.source) < sourceRank(b.source);
  if (aPhrase !== bPhrase) return aPhrase < bPhrase;
  // Same phrase, same numbers, same source: any remaining difference (difficulty, intent, parent…) is settled
  // by a canonical comparison, so the result never depends on the order the supplier returned rows in.
  return canonical(a) < canonical(b);
}

function canonical(c: KeywordCandidate): string {
  return JSON.stringify([c.rankingDifficulty, c.intent, c.secondaryIntents, c.parent, c.measuredMonth, c.dataUpdatedAt, c.cpc, c.adCompetition, c.ranking ?? null, c.competitorDomain ?? null, c.locationCode, c.languageCode]);
}

function sanitiseNumber(n: number | null, max: number): number | null {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= max ? n : null;
}

/** Words a reason or label must never contain: the supplier, its endpoints and mechanism words. */
export const BANNED_COPY = /dataforseo|data for seo|\blabs\b|keyword_ideas|keyword_suggestions|related_keywords|keywords_for_site|ranked_keywords|competitors_domain|keyword_overview|bulk_keyword_difficulty|search_intent|\bapi\b|provider|\bmodel\b|algorithm|\bai\b|endpoint|supplier/i;

export function buildKeywordPool(candidates: readonly KeywordCandidate[], business: PoolBusiness, options: PoolOptions = {}): KeywordPool {
  const ceiling = options.difficultyCeiling ?? DEFAULT_DIFFICULTY_CEILING;
  const minSearches = options.minSearches ?? MIN_SEARCHES;
  const excluded: PoolExclusion[] = [];

  // 1. Normalise, screen and merge by key.
  const merged = new Map<string, Merged>();
  for (const c of candidates) {
    const phrase = normalisePhrase(c?.phrase);
    if (!phrase) { excluded.push({ key: '', phrase: '', reason: 'invalid' }); continue; }
    const key = phraseKey(phrase);
    if (!key) { excluded.push({ key: '', phrase: '', reason: 'invalid' }); continue; }
    const cand: KeywordCandidate = { ...c, searches: sanitiseNumber(c.searches, 1e10) === null ? null : Math.round(c.searches as number), rankingDifficulty: sanitiseNumber(c.rankingDifficulty, 100) };
    const parent = c.parent ? normalisePhrase(c.parent) : null;
    const m = merged.get(key);
    if (!m) {
      merged.set(key, { key, phrase, best: cand, sources: new Set([c.source]), variants: new Set([phrase]), parents: new Set(parent ? [parent] : []), ownPosition: null, ownUrl: null });
    } else {
      m.sources.add(c.source); m.variants.add(phrase); if (parent) m.parents.add(parent);
      if (better(cand, phrase, m.best, m.phrase)) { m.best = cand; m.phrase = phrase; }
    }
    const entry = merged.get(key)!;
    if (c.source === 'own_ranked' && c.ranking && c.ranking.position > 0 && (entry.ownPosition === null || c.ranking.position < entry.ownPosition || (c.ranking.position === entry.ownPosition && cmp(c.ranking.url ?? '', entry.ownUrl ?? '') < 0))) {
      entry.ownPosition = c.ranking.position; entry.ownUrl = c.ranking.url;
    }
  }

  // Measured index, for the parent rung of the ladder.
  const measuredByKey = new Map<string, { searches: number; month: string | null; phrase: string }>();
  for (const m of merged.values()) if (m.best.searches !== null) measuredByKey.set(m.key, { searches: m.best.searches, month: m.best.measuredMonth, phrase: m.phrase });

  // Business context, computed once.
  const banned = bannedTerms(business);
  const competitors = competitorTerms(business);
  const dismissed = new Set(business.dismissed.map((d) => normalisePhrase(d)).filter((d): d is string => !!d).map(phraseKey));
  const confirmed = business.profile && business.profile.confirmedAt ? business.profile : null;
  const offerTokens = (confirmed?.offers ?? []).map((o) => ({ name: o.name, tokens: roots(o.name) })).filter((o) => o.tokens.size > 0);
  const audienceTokens = (confirmed?.audiences ?? []).map((a) => roots(a)).filter((t) => t.size > 0);
  const vocabulary = new Set<string>();
  for (const o of confirmed?.offers ?? []) for (const t of roots(`${o.name} ${o.description}`)) vocabulary.add(t);
  for (const a of audienceTokens) for (const t of a) vocabulary.add(t);
  // Locations are deliberately NOT topic vocabulary (removed below, even when an audience line names them):
  // "best pizza leeds" is off-topic for a Leeds letting agent.
  const pageIndex = indexPages(business.pages);
  for (const p of pageIndex.pages) for (const t of p.tokens) vocabulary.add(root(t));
  for (const l of business.locations ?? []) for (const t of roots(l)) vocabulary.delete(t);
  const plannedIndex = business.planned.map((p) => ({
    phrase: topicTokens(p.phrase ?? p.targetQuery), title: topicTokens(p.title), titleNorm: [...topicTokens(p.title)].sort().join(' '),
  }));

  // 2. Filter, in a fixed order so the first reason recorded is deterministic.
  const kept: { m: Merged; basis: SearchBasis; parent: string | null; parentSearches: number | null; parentMonth: string | null; tokens: Set<string> }[] = [];
  for (const m of [...merged.values()].sort((a, b) => cmp(a.key, b.key))) {
    const phrase = m.phrase;
    const tokens = topicTokens(phrase);
    const reject = (reason: ExclusionReason, covered?: PoolExclusion['covered']) => excluded.push({ key: m.key, phrase, reason, ...(covered !== undefined ? { covered } : {}) });
    if (UNSAFE.test(phrase)) { reject('unsafe'); continue; }
    if (dismissed.has(m.key)) { reject('dismissed'); continue; }
    if (banned.some((b) => containsWords(phrase, b))) { reject('excluded_term'); continue; }
    if (competitors.some((c) => containsWords(phrase, c))) { reject('competitor_brand'); continue; }
    if (m.best.intent === 'navigational') { reject('wrong_intent'); continue; }
    if (m.ownPosition !== null && m.ownPosition <= 10) { reject('already_covered', { url: m.ownUrl, how: 'ranks_top_10', position: m.ownPosition }); continue; }
    const page = coveringPage(phrase, tokens, pageIndex);
    if (page) { reject('already_covered', { url: page, how: 'existing_page' }); continue; }
    const titleNorm = [...tokens].sort().join(' ');
    const clash = plannedIndex.find((p) => setSimilarity(tokens, p.phrase) >= CANNIBALISE_SIMILARITY || setSimilarity(tokens, p.title) >= SUBSTANTIAL_DUPLICATE || (titleNorm.length > 0 && p.titleNorm === titleNorm));
    if (clash) { reject('cannibalises', { url: null, how: 'planned_article' }); continue; }

    // The ladder: own number, else a measured wider phrase, else observed only.
    let basis: SearchBasis = 'observed'; let parent: string | null = null; let parentSearches: number | null = null; let parentMonth: string | null = null;
    const bestParent = [...m.parents].map((p) => ({ p, hit: measuredByKey.get(phraseKey(p)) }))
      .filter((x) => x.hit && phraseKey(x.p) !== m.key)
      .sort((a, b) => (b.hit!.searches - a.hit!.searches) || cmp(a.p, b.p))[0];
    if (m.best.searches !== null) basis = 'measured';
    else if (bestParent) { basis = 'parent_phrase'; parent = bestParent.hit!.phrase; parentSearches = bestParent.hit!.searches; parentMonth = bestParent.hit!.month; }
    if (m.best.searches !== null && bestParent) parent = bestParent.hit!.phrase;

    if (basis === 'measured' && (m.best.searches as number) < minSearches && !(bestParent && bestParent.hit!.searches >= minSearches)) { reject('too_small'); continue; }
    const quickWin = m.ownPosition !== null && m.ownPosition >= 11 && m.ownPosition <= 30;
    if (m.best.rankingDifficulty !== null && m.best.rankingDifficulty > ceiling && !quickWin) { reject('too_hard'); continue; }
    const fromOwnSite = m.sources.has('own_ranked') || m.sources.has('site_keywords') || m.sources.has('owner');
    if (!fromOwnSite && vocabulary.size > 0 && ![...tokens].some((t) => vocabulary.has(root(t)))) { reject('off_topic'); continue; }
    kept.push({ m, basis, parent, parentSearches, parentMonth, tokens });
  }

  // 3. Score.
  const scored = kept.map((k) => {
    const r = [...k.tokens].map(root);
    const offer = offerTokens.filter((o) => r.some((t) => o.tokens.has(t))).sort((a, b) => cmp(a.name, b.name))[0] ?? null;
    const audience = audienceTokens.some((a) => r.some((t) => a.has(t)));
    const quickWin = k.m.ownPosition !== null && k.m.ownPosition >= 11 && k.m.ownPosition <= 30;
    const volumeFor = k.basis === 'measured' ? k.m.best.searches : k.basis === 'parent_phrase' ? k.parentSearches : null;
    const f = fit(k.m.best.intent, offer !== null, audience);
    const score = opportunity({ searches: volumeFor, difficulty: k.m.best.rankingDifficulty, fit: f, quickWin });
    return { ...k, offer, audience, quickWin, score };
  });

  // 4. Cluster: broad phrases first, so each cluster's pillar is its broadest well-searched phrase.
  const tier = (b: SearchBasis) => (b === 'measured' ? 0 : b === 'parent_phrase' ? 1 : 2);
  const clusterOrder = [...scored].sort((a, b) => tier(a.basis) - tier(b.basis) || a.tokens.size - b.tokens.size
    || ((b.m.best.searches ?? -1) - (a.m.best.searches ?? -1)) || cmp(a.m.key, b.m.key));
  const clusters: { id: string; pillarKey: string; tokens: Set<string>; members: string[] }[] = [];
  const byToken = new Map<string, number[]>();
  const clusterOf = new Map<string, number>();
  for (const s of clusterOrder) {
    const seen = new Set<number>();
    let bestIdx = -1; let bestSim = 0;
    for (const t of s.tokens) for (const idx of byToken.get(t) ?? []) {
      if (seen.has(idx)) continue; seen.add(idx);
      const sim = setSimilarity(s.tokens, clusters[idx]!.tokens);
      if (sim > bestSim || (sim === bestSim && idx < bestIdx)) { bestSim = sim; bestIdx = idx; }
    }
    if (bestIdx >= 0 && bestSim >= CLUSTER_SIMILARITY) {
      clusters[bestIdx]!.members.push(s.m.key); clusterOf.set(s.m.key, bestIdx);
    } else {
      const idx = clusters.length;
      clusters.push({ id: `kc-${fnv(s.m.key)}`, pillarKey: s.m.key, tokens: s.tokens, members: [s.m.key] });
      clusterOf.set(s.m.key, idx);
      for (const t of s.tokens) { const list = byToken.get(t) ?? []; list.push(idx); byToken.set(t, list); }
    }
  }

  // 5. Rank: measured first, then the wider-phrase rung, then observed; opportunity within each; key breaks ties.
  const ranked = [...scored].sort((a, b) => tier(a.basis) - tier(b.basis) || b.score - a.score || cmp(a.m.key, b.m.key))
    .slice(0, Math.max(0, options.limit ?? 300));
  const location = candidates.find((c) => c && Number.isFinite(c.locationCode))?.locationCode ?? 0;
  const rows: PoolRow[] = ranked.map((s) => {
    const cluster = clusters[clusterOf.get(s.m.key)!]!;
    const band = difficultyBand(s.m.best.rankingDifficulty);
    const want = intentLabel(s.m.best.intent);
    return {
      id: `kw-${fnv(`${location}:${s.m.key}`)}`,
      key: s.m.key,
      phrase: s.m.phrase,
      basis: s.basis,
      searches: s.basis === 'measured' ? s.m.best.searches : null,
      measuredMonth: s.basis === 'measured' ? s.m.best.measuredMonth : null,
      parent: s.parent,
      parentSearches: s.basis === 'parent_phrase' ? s.parentSearches : null,
      parentMeasuredMonth: s.basis === 'parent_phrase' ? s.parentMonth : null,
      rankingDifficulty: s.m.best.rankingDifficulty,
      band: band.band,
      intent: s.m.best.intent,
      sources: [...s.m.sources].sort((a, b) => sourceRank(a) - sourceRank(b)),
      variants: [...s.m.variants].sort(),
      ownPosition: s.m.ownPosition,
      clusterId: cluster.id,
      role: cluster.pillarKey === s.m.key ? 'pillar' : 'supporting',
      opportunity: s.score,
      why: reason(s),
      labels: {
        searches: searchesLabel(s.basis, s.basis === 'measured' ? s.m.best.searches : s.parentSearches, s.basis === 'measured' ? s.m.best.measuredMonth : s.parentMonth),
        difficulty: band.label,
        want: want?.label ?? null,
        basis: s.basis === 'measured' ? 'Measured' : s.basis === 'parent_phrase' ? 'Wider phrase' : 'No search number yet',
      },
    };
  });
  const inRows = new Set(rows.map((r) => r.key));
  return {
    state: rows.some((r) => r.basis === 'measured') ? 'measured' : rows.length ? 'thin' : 'no_data',
    rows,
    clusters: clusters.map((c) => ({ id: c.id, pillarKey: c.pillarKey, memberKeys: c.members.filter((k) => inRows.has(k)) })).filter((c) => c.memberKeys.length > 0),
    excluded,
  };
}

// ─── Coverage by existing pages ─────────────────────────────────────────────

interface PageIndex {
  readonly pages: { url: string; tokens: Set<string>; titleNorm: string; slug: string }[];
  readonly byToken: Map<string, number[]>;
  readonly bySlug: Map<string, number>;
}

function indexPages(pages: readonly InventoryPage[]): PageIndex {
  const list: PageIndex['pages'] = [];
  const byToken = new Map<string, number[]>(); const bySlug = new Map<string, number>();
  for (const p of [...pages].sort((a, b) => cmp(a.url, b.url))) {
    if (p.fetchStatus !== 'ok') continue;
    const label = [p.title ?? '', p.headings[0] ?? ''].join(' ');
    const tokens = topicTokens(label);
    let slug = '';
    try { const seg = new URL(p.url).pathname.split('/').filter(Boolean); slug = (seg[seg.length - 1] ?? '').replace(/\.html?$/i, '').toLowerCase(); } catch { /* not a URL */ }
    const idx = list.length;
    list.push({ url: p.canonical ?? p.url, tokens, titleNorm: [...topicTokens(p.title ?? '')].sort().join(' '), slug });
    for (const t of tokens) { const l = byToken.get(t) ?? []; l.push(idx); byToken.set(t, l); }
    if (slug && !bySlug.has(slug)) bySlug.set(slug, idx);
  }
  return { pages: list, byToken, bySlug };
}

/** Mirrors `assessDuplicate` against published pages: exact slug or title, or substantial similarity. */
function coveringPage(phrase: string, tokens: Set<string>, index: PageIndex): string | null {
  const slugHit = index.bySlug.get(slugify(phrase));
  if (slugHit !== undefined) return index.pages[slugHit]!.url;
  const norm = [...tokens].sort().join(' ');
  const seen = new Set<number>();
  for (const t of tokens) for (const idx of index.byToken.get(t) ?? []) {
    if (seen.has(idx)) continue; seen.add(idx);
    const page = index.pages[idx]!;
    if ((norm && page.titleNorm === norm) || setSimilarity(tokens, page.tokens) >= SUBSTANTIAL_DUPLICATE) return page.url;
  }
  return null;
}

// ─── Ranking ────────────────────────────────────────────────────────────────

/**
 * Fit with a blog article and with what the business sells (F, 0–1):
 *   1.0  learn or compare phrase that matches an offer;
 *   0.9  learn phrase that matches an audience;
 *   0.8  compare phrase that matches an audience;
 *   0.6  buy phrase that matches an offer, or an unrated phrase that matches;
 *   0.3  anything else.
 * Buy phrases score lower than in the plan's draft because results pages for
 * them are mostly product and service pages, which an article rarely displaces.
 */
export function fit(intent: KeywordIntent | null, offer: boolean, audience: boolean): number {
  const want = intentLabel(intent)?.want ?? null;
  if (offer && (want === 'learn' || want === 'compare')) return 1;
  if (audience && want === 'learn') return 0.9;
  if (audience && want === 'compare') return 0.8;
  if ((offer && want === 'buy') || (want === null && (offer || audience))) return 0.6;
  return 0.3;
}

/**
 * opportunity = 0.35·V + 0.30·E + 0.25·F + 0.10·Q, rounded to 4 places.
 *   V = min(1, log10(searches + 1) / 4)   (10,000 searches a month scores 1; 0 when no number)
 *   E = (100 − difficulty) / 100, or 0.5 when unrated
 *   F = `fit`
 *   Q = 1 when the site already ranks 11–30 for the phrase (a quick win), else 0
 */
export function opportunity(input: { readonly searches: number | null; readonly difficulty: number | null; readonly fit: number; readonly quickWin: boolean }): number {
  const v = input.searches === null ? 0 : Math.min(1, Math.log10(Math.max(0, input.searches) + 1) / 4);
  const e = input.difficulty === null ? 0.5 : (100 - Math.min(100, Math.max(0, input.difficulty))) / 100;
  const q = input.quickWin ? 1 : 0;
  const raw = RANK_WEIGHTS.volume * v + RANK_WEIGHTS.ease * e + RANK_WEIGHTS.fit * input.fit + RANK_WEIGHTS.quickWin * q;
  return Math.round(raw * 10_000) / 10_000;
}

// ─── Words ──────────────────────────────────────────────────────────────────

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export function monthLabel(month: string | null): string | null {
  const m = month ? /^(\d{4})-(\d{2})$/.exec(month) : null;
  const i = m ? Number(m[2]) - 1 : -1;
  return m && i >= 0 && i < 12 ? `${MONTHS[i]} ${m[1]}` : null;
}

const fmt = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

export function searchesLabel(basis: SearchBasis, searches: number | null, month: string | null): string {
  if (basis === 'observed' || searches === null) return 'No search number yet';
  const when = monthLabel(month);
  const tail = when ? `, measured ${when}` : '';
  return basis === 'measured'
    ? `About ${fmt(searches)} searches a month${tail}`
    : `About ${fmt(searches)} searches a month for the wider phrase${tail}`;
}

/** An offer's name as it may appear in a sentence, or null when it is unsafe or would read as a mechanism word. */
function offerName(name: string): string | null {
  const n = String(name).normalize('NFKC').replace(INVISIBLE, ' ').replace(/<[^>]*>?/g, ' ').replace(/[^\p{L}\p{N}'&\- ]+/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!n || n.length > 60 || BANNED_COPY.test(n)) return null;
  return n;
}

function reason(s: {
  basis: SearchBasis; m: Merged; parentSearches: number | null; quickWin: boolean;
  offer: { name: string } | null; audience: boolean;
}): string {
  const clauses: string[] = [];
  if (s.basis === 'measured') clauses.push(`it is searched about ${fmt(s.m.best.searches as number)} times a month`);
  else if (s.basis === 'parent_phrase') clauses.push(`it belongs to a wider search made about ${fmt(s.parentSearches as number)} times a month`);
  else if (s.m.sources.has('serp_question')) clauses.push('people ask this question when they search');
  else if (s.m.sources.has('serp_related')) clauses.push('people search for it alongside related topics');
  else clauses.push('it came up for your business, although it has no search number yet');
  if (s.quickWin) clauses.push('your site already appears on page two or three for it');
  else {
    const band = difficultyBand(s.m.best.rankingDifficulty).band;
    if (band === 'easier') clauses.push('it is easier to rank for');
    else if (band === 'medium') clauses.push('it is moderately hard to rank for');
  }
  if (s.offer) {
    const name = offerName(s.offer.name);
    clauses.push(name ? `it ties in with your ${name}` : 'it ties in with one of your services');
  } else if (s.audience) clauses.push('it matters to the people you serve');
  const body = clauses.length === 1 ? clauses[0] : `${clauses.slice(0, -1).join(', ')} and ${clauses[clauses.length - 1]}`;
  return `We chose this because ${body}.`;
}
