/**
 * Brand DNA: the exact rules that decide which words on a card are the business's own. Pure: no model, network or database.
 *
 * Two classes of field (see `brand-dna.ts` for how the card is checked and repaired with these):
 *   QUOTED FACTS are copied from the business's own pages and documents and checked exactly here: approved claims (whole
 *     sentences), audiences (an unbroken run of words in a sentence that does not negate), offer names (a run of words in
 *     the cited document), prices (the full price expression, tied to its offer), links (the business's own site).
 *   DESCRIPTION is our wording (summary, positioning, offer descriptions, voice, conversion-page labels). It is never a
 *     fact: it may carry no money or percentage at all, and any other number must be one a source states.
 *
 * Text basis (every comparison): invisible characters (soft hyphens, zero-width and bidi marks) removed; superscript,
 * subscript and footnote marks read as separators, never digits; NFKC; lower case; every run of letters, marks and digits
 * of ANY script kept as a word (so look-alike letters and other-script digits simply do not match); £ $ € ¥ % and + kept as
 * words; all other punctuation and spacing collapsed. Matches are always on whole words.
 */

// ─── 1. Text basis ───────────────────────────────────────────────────────────

const INVISIBLE = /[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁤⁦-⁯﻿]/gu;
const FOOTNOTE = /[²³¹⁰-₟†‡※]/gu;

/** The text every rule reads: invisibles gone, footnote marks as spaces, NFKC. Positions in rules refer to this string. */
export function basisText(text: string | null | undefined): string {
  return String(text ?? '').replace(INVISIBLE, '').replace(FOOTNOTE, ' ').normalize('NFKC');
}

export interface Tok { readonly w: string; readonly raw: string; readonly s: number; readonly e: number }
const TOKEN = /[\p{L}\p{M}\p{N}]+|[£$€¥%+]/gu;

/** Words of an already-basis text, with their positions. */
function tokenize(basis: string): Tok[] {
  const out: Tok[] = [];
  for (const m of basis.matchAll(TOKEN)) out.push({ w: m[0].toLowerCase(), raw: m[0], s: m.index!, e: m.index! + m[0].length });
  return out;
}

/** The comparison key of any text: its words, lower case, one space apart. */
export function keyOf(text: string | null | undefined): string {
  return tokenize(basisText(text)).map((t) => t.w).join(' ');
}

/** True when `needle`'s words are one unbroken whole-word run of `hay`'s words. */
export function wordRun(hay: string | null | undefined, needle: string | null | undefined): boolean {
  const n = keyOf(needle);
  return n.length > 0 && ` ${keyOf(hay)} `.includes(` ${n} `);
}

// ─── Blocks and units ────────────────────────────────────────────────────────

/** Words a full stop does not end a sentence after. Single letters (initials) are also never an end. */
const ABBREVIATIONS = new Set(['inc', 'incl', 'approx', 'e.g', 'i.e', 'eg', 'ie', 'no', 'nos', 'ltd', 'st', 'etc', 'vs', 'mr', 'mrs', 'ms', 'dr', 'prof', 'est', 'ex',
  'excl', 'exc', 'min', 'max', 'co', 'plc', 'p.a', 'p.c.m', 'p.w', 'p.m', 'pcm', 'ave', 'rd', 'tel', 'ref', 'fig', 'approx', 'cf', 'dept', 'govt', 'u.k', 'sq', 'ft', 'mins', 'hrs', 'yrs']);

export interface Unit { readonly text: string; readonly s: number; readonly e: number; readonly block: number; readonly key: string; readonly negated: boolean; readonly eligible: boolean }
export interface Block { readonly text: string; readonly s: number; readonly e: number; readonly units: readonly Unit[] }

/** Words that turn a sentence round. A sentence holding one never supplies an audience, and never makes a "never say" line a statement. */
const NEGATION = /\b(?:not|no|never|nor|neither|without|unlike|except|excluding|cannot|none)\b|\brather than\b|\binstead of\b|\bno longer\b|n['’]t\b/u;

/** Split one block into sentences: at . ! ? (and …) followed by space, except after an abbreviation, an initial or inside a number. */
function sentences(block: string): { s: number; e: number }[] {
  const out: { s: number; e: number }[] = [];
  let start = 0;
  for (const m of block.matchAll(/[.!?…]+["'”’)\]]*(?=\s|$)/gu)) {
    const end = m.index! + m[0].length;
    if (m[0][0] === '.') {
      const word = /([\p{L}\p{N}.]+)$/u.exec(block.slice(start, m.index!))?.[1]?.replace(/^\.+/, '').toLowerCase() ?? '';
      if (ABBREVIATIONS.has(word) || /^\p{L}$/u.test(word)) continue;
    }
    if (block.slice(start, end).trim()) out.push({ s: start, e: end });
    start = end;
  }
  if (block.slice(start).trim()) out.push({ s: start, e: block.length });
  return out;
}

/** A unit is quotable as a claim only when it is not a customer's words (in quotation marks, or followed by an attribution dash) and asks nothing. */
function quotable(text: string, next: string | undefined): boolean {
  const t = text.trim();
  if (t.includes('?')) return false;
  if (/^[«"“”„'‘’]/u.test(t) || /["”»’]\s*[-–—]/u.test(t) || /^[-–—]/u.test(t)) return false;
  if (next !== undefined && /^\s*[-–—]\s*\p{L}/u.test(next)) return false;
  return true;
}

export interface Structure { readonly basis: string; readonly blocks: readonly Block[]; readonly units: readonly Unit[]; readonly tokens: readonly Tok[]; readonly key: string }

/** A document as the rules read it: lines are blocks, sentences within a line are units. Computed once per document per check. */
export function structureOf(text: string | null | undefined): Structure {
  const basis = basisText(text);
  const blocks: Block[] = [];
  const units: Unit[] = [];
  let offset = 0;
  for (const line of basis.split('\n')) {
    const s = offset, index = blocks.length;
    offset += line.length + 1;
    if (!line.trim()) continue;
    const parts = sentences(line);
    const mine: Unit[] = parts.map((p, i) => {
      const raw = line.slice(p.s, p.e), lead = raw.length - raw.trimStart().length, unitText = raw.trim();
      return { text: unitText, s: s + p.s + lead, e: s + p.s + lead + unitText.length, block: index, key: keyOf(unitText), negated: NEGATION.test(unitText.toLowerCase()),
        eligible: quotable(unitText, parts[i + 1] ? line.slice(parts[i + 1]!.s, parts[i + 1]!.e) : undefined) };
    });
    blocks.push({ text: line, s, e: s + line.length, units: mine });
    units.push(...mine);
  }
  const tokens = tokenize(basis);
  return { basis, blocks, units, tokens, key: tokens.map((t) => t.w).join(' ') };
}

const cache = new WeakMap<object, Structure>();
/** The structure of a document object, computed once while that object lives. */
export function structureOfDoc(doc: { readonly text?: string | null }): Structure {
  let s = cache.get(doc);
  if (!s) { s = structureOf(doc.text); cache.set(doc, s); }
  return s;
}

// ─── 2. Approved claims are whole sentences ──────────────────────────────────

export const CLAIM_MAX = 220;

/** The sentence of `doc` an approved claim is, or null. The claim must be one whole quotable unit, start to end. */
export function claimUnit(claim: string, doc: { readonly text?: string | null }): Unit | null {
  if (claim.length > CLAIM_MAX) return null;
  const k = keyOf(claim);
  if (!k) return null;
  return structureOfDoc(doc).units.find((u) => u.eligible && u.key === k) ?? null;
}

// ─── 3. Audiences ────────────────────────────────────────────────────────────

export const AUDIENCE_MAX = 80;

/** An audience is an unbroken run of words inside one sentence of `doc` that holds no negation. Numbers come with the run. */
export function audienceUnit(audience: string, doc: { readonly text?: string | null }): Unit | null {
  if (audience.length > AUDIENCE_MAX) return null;
  const k = keyOf(audience);
  if (!k) return null;
  return structureOfDoc(doc).units.find((u) => !u.negated && ` ${u.key} `.includes(` ${k} `)) ?? null;
}

// ─── 4. Offer names ──────────────────────────────────────────────────────────

export const OFFER_NAME_MAX = 80;
export const OFFER_NAME_WORDS = 10;

/** Why an offer name cannot stand, or null. */
export function offerNameProblem(name: string, doc: { readonly text?: string | null }): string | null {
  if (name.length > OFFER_NAME_MAX || name.trim().split(/\s+/).length > OFFER_NAME_WORDS) return `is longer than ${OFFER_NAME_MAX} characters or ${OFFER_NAME_WORDS} words`;
  const k = keyOf(name);
  if (!k || !` ${structureOfDoc(doc).key} `.includes(` ${k} `)) return 'is not written as these words in the document it cites';
  return null;
}
const usableName = (name: string) => name.length <= OFFER_NAME_MAX && name.trim().split(/\s+/).length <= OFFER_NAME_WORDS && keyOf(name).length > 0;

// ─── 5. Prices ───────────────────────────────────────────────────────────────

/** How far after the end of an offer's name its price may start. */
export const PRICE_REACH = 300;
const AMOUNT = /[£$€¥]\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:k|m|bn)\b)?|\d[\d,]*(?:\.\d+)?\s?(?:%|per\s?cent\b)|\b\d+(?:\.\d+)?p\b/giu;
const LEFT_QUALIFIERS = [['starting', 'from'], ['starting', 'at'], ['up', 'to'], ['from'], ['only'], ['just'], ['was'], ['now'], ['save'], ['approx'], ['approximately'], ['around']];
const PERIODS = new Set(['month', 'months', 'year', 'years', 'week', 'weeks', 'day', 'days', 'annum', 'hour', 'hours', 'person', 'session', 'visit', 'let', 'property', 'room', 'night',
  'job', 'tenancy', 'minute', 'class', 'lesson', 'user', 'seat', 'unit', 'flat', 'house', 'home', 'head', 'item', 'page', 'report', 'certificate', 'quarter']);
const PERIOD_LINKS = new Set(['per', 'a', 'an', 'each', 'every']);
const SHORT_PERIODS = [['pcm'], ['pw'], ['pa'], ['pm'], ['ph'], ['p', 'a'], ['p', 'w'], ['p', 'c', 'm'], ['p', 'm']];
const VAT = [['+', 'vat'], ['plus', 'vat'], ['inc', 'vat'], ['incl', 'vat'], ['including', 'vat'], ['inclusive', 'of', 'vat'], ['ex', 'vat'], ['exc', 'vat'], ['excl', 'vat'],
  ['excluding', 'vat'], ['exclusive', 'of', 'vat'], ['vat', 'included'], ['inc', 'vat', 'included']];
const BASES = new Set(['rent', 'rents', 'rental', 'income', 'value', 'price', 'fee', 'fees', 'sale', 'sales', 'purchase', 'loan', 'mortgage', 'turnover', 'cost', 'costs', 'amount',
  'profit', 'profits', 'premium', 'collected', 'budget', 'spend']);
/** A sentence about someone else's prices never supplies one. */
const COMPETITOR = /\b(?:other agents?|other firms?|other companies|other providers?|competitors?|elsewhere|typically|typical|industry average|on average|compared (?:with|to)|unlike|high street agents?)\b/iu;
/** Capitalised words that may sit straight before a price without being another thing's name. */
const PRICE_LABELS = new Set(['price', 'prices', 'cost', 'costs', 'fee', 'fees', 'total', 'pay', 'rate', 'rates', 'charge', 'charges', 'vat', 'just', 'only', 'from', 'now', 'was', 'save', 'monthly', 'yearly', 'annual', 'annually', 'one-off', 'deposit', 'investment']);

interface Amount { readonly ts: number; readonly te: number; readonly s: number; readonly e: number; readonly percent: boolean }
/** A full price expression: the amount (or range) with every qualifier written beside it. */
export interface PriceExpression { readonly ts: number; readonly te: number; readonly s: number; readonly e: number; readonly key: string; readonly text: string; readonly unit: Unit | null; readonly competitor: boolean }

const seq = (tokens: readonly Tok[], at: number, words: readonly string[]) => words.every((w, i) => tokens[at + i]?.w === w);

interface PriceView { readonly structure: Structure; readonly expressions: readonly PriceExpression[]; readonly startsAt: ReadonlyMap<number, number>; readonly endsAt: ReadonlyMap<number, PriceExpression> }
const priceCache = new WeakMap<Structure, PriceView>();

function unitAt(st: Structure, pos: number): Unit | null {
  let lo = 0, hi = st.units.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (st.units[mid]!.e <= pos) lo = mid + 1; else hi = mid; }
  const u = st.units[lo];
  return u && u.s <= pos && pos < u.e ? u : null;
}

/** Every price expression in a document, once per document. */
function priceView(st: Structure): PriceView {
  const done = priceCache.get(st);
  if (done) return done;
  const { tokens, basis } = st;
  const firstTokenAt = (pos: number) => { let lo = 0, hi = tokens.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (tokens[mid]!.s < pos) lo = mid + 1; else hi = mid; } return lo; };
  const amounts: Amount[] = [];
  for (const m of basis.matchAll(AMOUNT)) {
    const s = m.index!, e = s + m[0].length, ts = firstTokenAt(s);
    let te = ts; while (te < tokens.length && tokens[te]!.e <= e) te++;
    if (te > ts) amounts.push({ ts, te, s, e, percent: /%|per\s?cent/iu.test(m[0]) });
  }
  // A range ("£80-£120", "£80 to £120") is one expression.
  const groups: Amount[][] = [];
  for (const a of amounts) {
    const last = groups[groups.length - 1];
    const prev = last?.[last.length - 1];
    if (prev && /^\s*(?:-|–|—|to)\s*$/iu.test(basis.slice(prev.e, a.s))) last!.push(a); else groups.push([a]);
  }
  const expressions: PriceExpression[] = [];
  const startsAt = new Map<number, number>();
  const aboutOthers = new Map<Unit, boolean>();
  for (const g of groups) {
    let ts = g[0]!.ts, te = g[g.length - 1]!.te;
    const percent = g.some((a) => a.percent);
    for (let changed = true; changed;) {
      changed = false;
      for (const q of LEFT_QUALIFIERS) if (ts - q.length >= 0 && seq(tokens, ts - q.length, q)) { ts -= q.length; changed = true; break; }
    }
    for (let changed = true; changed;) {
      changed = false;
      const next = tokens[te];
      if (!next) break;
      const link = PERIOD_LINKS.has(next.w) ? 1 : 0;
      const cal = tokens[te + link]?.w === 'calendar' ? 1 : 0;
      const period = tokens[te + link + cal];
      if (period && PERIODS.has(period.w) && (link || /\//.test(basis.slice(tokens[te - 1]!.e, next.s)))) { te += link + cal + 1; changed = true; continue; }
      const short = SHORT_PERIODS.find((q) => seq(tokens, te, q));
      if (short) { te += short.length; changed = true; continue; }
      const vat = VAT.find((q) => seq(tokens, te, q));
      if (vat) { te += vat.length; changed = true; continue; }
      if (percent && next.w === 'of') {
        for (let n = 1; n <= 6 && te + n < tokens.length; n++) {
          const t = tokens[te + n]!;
          if (/^[£$€¥%]$|^\d/.test(t.w)) break;
          if (BASES.has(t.w)) { te += n + 1; changed = true; break; }
        }
      }
    }
    const s = tokens[ts]!.s, e = tokens[te - 1]!.e, unit = unitAt(st, g[0]!.s);
    let competitor = unit ? aboutOthers.get(unit) : false;
    if (unit && competitor === undefined) { competitor = COMPETITOR.test(unit.text); aboutOthers.set(unit, competitor); }
    expressions.push({ ts, te, s, e, key: tokens.slice(ts, te).map((t) => t.w).join(' '), text: basis.slice(s, e), unit, competitor: Boolean(competitor) });
    for (let i = g[0]!.ts; i < g[g.length - 1]!.te; i++) startsAt.set(i, expressions.length - 1);
  }
  const endsAt = new Map<number, PriceExpression>();
  for (const x of expressions) endsAt.set(x.te, x);
  const view = { structure: st, expressions, startsAt, endsAt };
  priceCache.set(st, view);
  return view;
}

interface Occurrence { readonly offer: number; readonly ts: number; readonly te: number; readonly s: number; readonly e: number }

const occurrenceCache = new WeakMap<Structure, Map<string, Occurrence[]>>();
/** Where every usable offer name is written in a document, longer names winning where they overlap ("Pro" inside "Pro Plus"). Once per document and name list. */
function occurrences(st: Structure, names: readonly string[]): Occurrence[] {
  const id = JSON.stringify(names);
  let byNames = occurrenceCache.get(st);
  if (!byNames) { byNames = new Map(); occurrenceCache.set(st, byNames); }
  const done = byNames.get(id);
  if (done) return done;
  const result = findOccurrences(st, names);
  byNames.set(id, result);
  return result;
}
function findOccurrences(st: Structure, names: readonly string[]): Occurrence[] {
  const { tokens } = st;
  const all: Occurrence[] = [];
  const keys = names.map((n) => (usableName(n) ? keyOf(n).split(' ') : []));
  const byFirst = new Map<string, number[]>();
  keys.forEach((k, i) => { if (k.length) byFirst.set(k[0]!, [...(byFirst.get(k[0]!) ?? []), i]); });
  for (let at = 0; at < tokens.length; at++) {
    for (const i of byFirst.get(tokens[at]!.w) ?? []) {
      const k = keys[i]!;
      if (k.every((w, j) => tokens[at + j]?.w === w)) all.push({ offer: i, ts: at, te: at + k.length, s: tokens[at]!.s, e: tokens[at + k.length - 1]!.e });
    }
  }
  all.sort((a, b) => (b.te - b.ts) - (a.te - a.ts) || a.ts - b.ts);
  const kept: Occurrence[] = [];
  const taken = new Set<number>();
  for (const o of all) {
    let free = true;
    for (let i = o.ts; i < o.te; i++) if (taken.has(i)) { free = false; break; }
    if (!free) continue;
    // The same words as another offer's identical name: they belong to both, and so tie neither.
    kept.push(o);
    for (let i = o.ts; i < o.te; i++) taken.add(i);
  }
  return kept.sort((a, b) => a.ts - b.ts);
}

/** True when the name at `n` sits in an unbroken run "price name price name..." that starts with a price. */
function pricesComeFirst(st: Structure, view: PriceView, occEnds: ReadonlyMap<number, Occurrence>, n: Occurrence, lineStart: number): boolean {
  // Only within one line: a price on the line above a heading is not "price, name".
  let cur = n.ts;
  for (let guard = 0; guard < 50; guard++) {
    const x = view.endsAt.get(cur);
    if (!x || x.s < lineStart) return false;
    const named = occEnds.get(x.ts);
    if (named) { cur = named.ts; continue; }
    let at = x.ts;
    while (at > 0 && st.tokens[at - 1]!.s >= lineStart && capitalised(st.tokens[at - 1]) && !view.startsAt.has(at - 1)) at--;
    if (at === x.ts) return true;
    cur = at;
  }
  return false;
}

const capitalised = (t: Tok | undefined) => Boolean(t && /^\p{Lu}/u.test(t.raw) && !PRICE_LABELS.has(t.w));
const amountOnlyBlock = (st: Structure, view: PriceView, b: Block) => {
  if (b.e - b.s > 200) return false;
  const inside = view.expressions.filter((x) => x.s >= b.s && x.e <= b.e);
  return inside.length > 0 && keyOf(b.text) === inside.map((x) => x.key).join(' ');
};
const headingLike = (b: Block) => b.text.trim().length <= 60 && !/[.!?]/.test(b.text) && /\p{Lu}/u.test(b.text);

/**
 * THE PRICE RULE. The price expressions tied to offer `self` (an index into `names`, the model's whole offer list) in one
 * document. For each place the offer is named:
 *   - the FIRST amount after the name, if it starts within PRICE_REACH characters, in the same sentence, a later sentence
 *     of the same line or a following line, with no other offer named in between, no capitalised word straight before it
 *     (another thing's name: "Starter Pro £49") and no short heading-like line in between, and its sentence is not about
 *     competitors;
 *   - then every further amount attached to it: later amounts in its sentence not separated by another name, and lines
 *     straight after it that are nothing but an amount (a column of prices);
 *   - or, when a line is exactly a price followed by the name ("£29 Starter"), that price.
 * Returned as the distinct full expressions. One expression: the price is that. More than one: the owner chooses.
 */
export function tiedPrices(doc: { readonly text?: string | null }, names: readonly string[], self: number): PriceExpression[] {
  const st = structureOfDoc(doc), view = priceView(st);
  const occ = occurrences(st, names);
  const found = new Map<string, PriceExpression>();
  const add = (x: PriceExpression) => { if (!found.has(x.key)) found.set(x.key, x); };
  const selfKey = keyOf(names[self]);
  const firstAfter = (ts: number) => { let lo = 0, hi = view.expressions.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (view.expressions[mid]!.ts < ts) lo = mid + 1; else hi = mid; } return lo; };
  const occEnds = new Map(occ.map((o) => [o.te, o]));
  // The first occurrence starting at or after token `ts` (occurrences are sorted by start).
  const occFrom = (ts: number) => { let lo = 0, hi = occ.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (occ[mid]!.ts < ts) lo = mid + 1; else hi = mid; } return lo; };
  for (const [oi, n] of occ.entries()) {
    if (n.offer !== self) continue;
    const block = st.blocks.findIndex((b) => b.s <= n.s && n.s <= b.e);
    // A line that is exactly "price name".
    const b = st.blocks[block];
    if (b) {
      const before = view.endsAt.get(n.ts);
      if (before && before.s >= b.s && b.e - b.s <= 300 && keyOf(b.text) === `${before.key} ${keyOf(names[self])}`) { add(before); continue; }
      // Prices written before names ("£29 Starter £49 Pro £99 Premium"): walk back over price, name, price, name... with
      // nothing between them. If that run starts with a price, the amount after a name belongs to the next thing, so
      // nothing is tied forwards from here. (A run that starts with a name, "Boiler service £85 Gas certificate £70", is
      // the usual name-then-price list.)
      if (pricesComeFirst(st, view, occEnds, n, b.s)) continue;
    }
    let at = firstAfter(n.te);
    const first = view.expressions[at];
    if (!first || first.s - n.e > PRICE_REACH || first.competitor) continue;
    let between = false;
    for (let j = oi + 1; j < occ.length && occ[j]!.ts < first.ts; j++) if (occ[j]!.offer !== n.offer && keyOf(names[occ[j]!.offer]) !== selfKey) { between = true; break; }
    if (between) continue;
    if (first.ts > n.te && capitalised(st.tokens[first.ts - 1])) continue;
    const firstBlock = st.blocks.findIndex((bb) => bb.s <= first.s && first.s <= bb.e);
    if (st.blocks.slice(block + 1, firstBlock).some(headingLike)) continue;
    const group = [first];
    // Further amounts in the same sentence, until another name intervenes.
    for (let i = at + 1; i < view.expressions.length; i++) {
      const x = view.expressions[i]!, prev = group[group.length - 1]!;
      if (!first.unit || x.unit !== first.unit) break;
      const nextName = occ[occFrom(prev.te)];
      if ((nextName && nextName.te <= x.ts) || (x.ts > prev.te && capitalised(st.tokens[x.ts - 1]))) break;
      group.push(x);
    }
    // Lines straight after that are nothing but an amount.
    for (let bi = st.blocks.findIndex((bb) => bb.s <= group[group.length - 1]!.s && group[group.length - 1]!.s <= bb.e) + 1; bi < st.blocks.length; bi++) {
      const next = st.blocks[bi]!;
      if (!amountOnlyBlock(st, view, next)) break;
      for (const x of view.expressions) if (x.s >= next.s && x.e <= next.e) group.push(x);
    }
    for (const x of group) if (!x.competitor) add(x);
  }
  return [...found.values()];
}

export type PriceStatus = 'tied' | 'ambiguous' | 'untied';
/** Whether `price` is its offer's price in `doc`: exactly the one full expression tied to it, one of several, or neither. */
export function priceStatus(price: string, doc: { readonly text?: string | null }, names: readonly string[], self: number): PriceStatus {
  const k = keyOf(price);
  const tied = tiedPrices(doc, names, self);
  if (!k || !tied.some((x) => x.key === k)) return 'untied';
  return tied.length === 1 ? 'tied' : 'ambiguous';
}

// ─── 6. Description fields ───────────────────────────────────────────────────

const MONEY_OR_PERCENT = /[£$€¥%]|\bper\s?cent\b|\b\d+(?:[.,]\d+)?p\b/iu;
const NUMBER = /\p{N}+(?:[.,]\p{N}+)*/gu;
const numbersOf = (text: string) => [...basisText(text).matchAll(NUMBER)].map((m) => m[0].replace(/,/g, ''));

/** Every number the sources state, as whole numbers. */
export function sourceNumbers(documents: readonly { readonly text?: string | null }[]): Set<string> {
  return new Set(documents.flatMap((d) => numbersOf(d.text ?? '')));
}

/** The sentences of a piece of description, for cutting. Line breaks also end a sentence. */
export function descriptionSentences(text: string): string[] {
  return text.split('\n').flatMap((line) => sentences(line).map((p) => line.slice(p.s, p.e).trim())).filter(Boolean);
}

/** True when one sentence of description may stand: no money or percentage at all, and every other number is one a source states. */
export function descriptionSentenceOk(sentence: string, numbers: ReadonlySet<string> | null): boolean {
  const b = basisText(sentence);
  if (MONEY_OR_PERCENT.test(b)) return false;
  const ns = numbersOf(b);
  return numbers ? ns.every((n) => numbers.has(n)) : ns.length === 0;
}

/** The description with every failing sentence cut, and what was cut. Text is returned unchanged when nothing fails. */
export function cutDescription(text: string, numbers: ReadonlySet<string> | null): { readonly text: string; readonly cut: readonly string[] } {
  if (!text) return { text, cut: [] };
  const parts = descriptionSentences(text);
  const cut = parts.filter((p) => !descriptionSentenceOk(p, numbers));
  return cut.length ? { text: parts.filter((p) => !cut.includes(p)).join(' '), cut } : { text, cut: [] };
}

// ─── 7. "Never say" lines ────────────────────────────────────────────────────

export const NEVER_SAY_MAX = 120;

/**
 * A model-proposed "never say" line only restricts the writer, so it is not word-matched. It is kept when it has no
 * number, money or percentage, is at most 120 characters, and is not something the business itself says positively:
 * a line that is a whole sentence of a source with no negation, or a run of three or more words inside such a sentence,
 * is dropped (it would forbid the business's own words).
 */
export function neverSayKept(line: string, documents: readonly { readonly text?: string | null }[]): boolean {
  if (line.length > NEVER_SAY_MAX || /[\p{N}£$€¥%]/u.test(basisText(line))) return false;
  const k = keyOf(line);
  if (!k) return false;
  const words = k.split(' ').length;
  return !documents.some((d) => structureOfDoc(d).units.some((u) => !u.negated && (u.key === k || (words >= 3 && ` ${u.key} `.includes(` ${k} `)))));
}

// ─── 8. Links ────────────────────────────────────────────────────────────────

/** Hosts many unrelated sites share. On one, a business's site is its path, so a link must start with that path. */
export const SHARED_HOSTS = ['sites.google.com', 'github.io', 'wixsite.com', 'carrd.co', 'wordpress.com', 'blogspot.com', 'squarespace.com', 'webflow.io', 'netlify.app', 'vercel.app',
  'pages.dev', 'notion.site', 'weebly.com', 'godaddysites.com', 'square.site', 'linktr.ee', 'company.site', 'mystrikingly.com', 'jimdosite.com', 'site123.me'];
export interface LinkContext { readonly website?: string | null; readonly pages?: readonly (string | null | undefined)[] }

function parsed(url: string): URL | null {
  if (url.length > 2000 || /[\s\\]/u.test(url) || !url.startsWith('https://')) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.username || u.password || u.port !== '') return null;
    const host = u.hostname.toLowerCase();
    if (!host || host.endsWith('.') || host.startsWith('[') || /^[\d.]+$/.test(host) || !host.includes('.')) return null;
    return u;
  } catch { return null; }
}
const withScheme = (site: string) => (/^https?:\/\//i.test(site) ? site : `https://${site}`);
const shared = (host: string) => SHARED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));

/**
 * A link (offer url or conversion page) is kept only when it is https, with no user name or password, on the default
 * port, and its host is the business's website host or a subdomain of it, or exactly a host a page was read from. A host
 * written in page text does not count. On a shared host with a website path beyond "/", the link must also start with that path.
 */
export function linkAllowed(url: string | null | undefined, context: LinkContext): boolean {
  if (typeof url !== 'string') return false;
  const u = parsed(url);
  if (!u) return false;
  const host = u.hostname.toLowerCase();
  let site: URL | null = null;
  try { site = context.website ? new URL(withScheme(context.website.trim())) : null; } catch { site = null; }
  const siteHost = site?.hostname.toLowerCase() ?? null;
  const base = siteHost?.replace(/^www\./, '') ?? null;
  const pageHosts = (context.pages ?? []).flatMap((p) => { try { return p ? [new URL(p).hostname.toLowerCase()] : []; } catch { return []; } });
  const ownHost = (base !== null && (host === base || host === siteHost || (!SHARED_HOSTS.includes(base) && host.endsWith(`.${base}`)))) || pageHosts.includes(host);
  if (!ownHost) return false;
  const sitePath = site?.pathname.replace(/\/+$/, '') ?? '';
  if (siteHost && shared(siteHost) && sitePath) return host === siteHost && (u.pathname === sitePath || u.pathname.startsWith(`${sitePath}/`));
  if (!siteHost && pageHosts.some(shared)) return false;
  return true;
}

/** A conversion-page label is kept when it is a run of words from a source (at most 80 characters); otherwise the link's own path. */
export function linkLabel(label: string, url: string, documents: readonly { readonly text?: string | null }[]): string {
  if (label.length <= 80 && keyOf(label) && documents.some((d) => ` ${structureOfDoc(d).key} `.includes(` ${keyOf(label)} `))) return label;
  try { const u = new URL(url); return u.pathname && u.pathname !== '/' ? decodeURIComponent(u.pathname) : u.hostname; } catch { return url; }
}
