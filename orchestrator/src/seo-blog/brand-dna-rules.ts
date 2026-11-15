/**
 * Brand DNA: the exact rules that decide which words on a website-door card are the business's own. Pure: no model,
 * network or database.
 *
 * THREAT MODEL. The model that reads the site is ours and is not hostile; it makes honest mistakes. These mechanical
 * checks exist to stop invention, rewording, and a price being attached to the wrong product. They cannot understand
 * context. The owner reads the card, with where each line came from, before confirming it. So wherever a rule cannot be
 * sure it leaves the item out or asks the owner; it never picks. Nothing here is a claim that a line was understood.
 *
 * Page structure is recorded by the page reader (`brandPageLines` in html.ts), never guessed from capital letters: each
 * stored line starts with a marker that the comparison below ignores: "# " heading, "• " list item, "| " table row (its
 * cells joined by " | "), "❝ " testimonial or quoted material, nothing for a paragraph. Pages stored before markers
 * existed are one untagged line; every rule treats such text conservatively (full sentences only, prices only when one
 * sentence holds the offer's name and exactly one price).
 *
 * KNOWN RESIDUALS (not solved, by design): a full sentence whose meaning is reversed by a neighbouring sentence ("It would
 * be a lie to say this. Every landlord gets guaranteed rent.") is still a whole sentence and can be proposed as a claim;
 * a list of myths written as full sentences under a heading we do not recognise is read as the business's statements.
 * The owner sees each such line with its source sentence before confirming.
 */

// ─── 1. Text basis ───────────────────────────────────────────────────────────

const INVISIBLE = /[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁤⁦-⁯﻿]/gu;
const FOOTNOTE = /[²³¹⁰-₟†‡※]/gu;

/** The text every rule reads: invisibles gone, footnote marks as spaces, NFKC. Positions in rules refer to this string. */
export function basisText(text: string | null | undefined): string {
  return String(text ?? '').replace(INVISIBLE, '').replace(FOOTNOTE, ' ').normalize('NFKC');
}

export interface Tok { readonly w: string; readonly raw: string; readonly s: number; readonly e: number }
/** A number keeps its internal commas and points ("1,500" and "1.5" are one word each, never "1 500" or "1 5"). */
const TOKEN = /\p{N}+(?:[.,]\p{N}+)*|[\p{L}\p{M}][\p{L}\p{M}\p{N}]*|[£$€¥%+]/gu;

function tokenize(basis: string): Tok[] {
  const out: Tok[] = [];
  for (const m of basis.matchAll(TOKEN)) out.push({ w: m[0].toLowerCase(), raw: m[0], s: m.index!, e: m.index! + m[0].length });
  return out;
}

/** The comparison key of any text: its words, lower case, one space apart. Line markers and all punctuation vanish. */
export function keyOf(text: string | null | undefined): string {
  return tokenize(basisText(text)).map((t) => t.w).join(' ');
}

/** True when `needle`'s words are one unbroken whole-word run of `hay`'s words. */
export function wordRun(hay: string | null | undefined, needle: string | null | undefined): boolean {
  const n = keyOf(needle);
  return n.length > 0 && ` ${keyOf(hay)} `.includes(` ${n} `);
}

/** Line markers written by the page reader. Shown text never carries them (`withoutMarkers`). */
export type LineKind = 'heading' | 'item' | 'row' | 'quoted' | 'para';
const MARKERS: [string, LineKind][] = [['# ', 'heading'], ['• ', 'item'], ['| ', 'row'], ['❝ ', 'quoted']];
export function lineKind(line: string): { kind: LineKind; start: number } {
  for (const [m, kind] of MARKERS) if (line.startsWith(m)) return { kind, start: m.length };
  return { kind: 'para', start: 0 };
}
/** Stored page text as a person should read it: the structure markers removed. */
export function withoutMarkers(text: string | null | undefined): string {
  return String(text ?? '').split('\n').map((l) => l.slice(lineKind(l).start)).join('\n');
}

// ─── Words that turn a sentence round, or say it is not the business's own fact ──

const UNRELIABLE = /\b(?:not|no|never|nor|neither|without|unlike|except|excluding|cannot|unable|none|stopped|myths?|misconceptions?|lies?|false|untrue|wrong|mistakes?)\b|\bno longer\b|\brather than\b|\binstead of\b|n['’]t\b|\bhope to\b|\baim(?:ing)? to\b|\b(?:aim|goal|ambition|mission|vision|dream) is to\b|\bplan to\b|\bwant to become\b|\bwill be\b|\bwould be\b|\bsome (?:\w+ ){0,2}(?:think|thinks|believe|believes|say|says)\b/u;
/** True when a piece of text holds a negation or an unreliability word (see the list above). */
export const unreliable = (text: string) => UNRELIABLE.test(basisText(text).toLowerCase());
const QUOTE_MARKS = /["“”„«»]/u;
const CROSS = /[✗✘❌✕×]/u;
/** Sentences that are about someone else's product. */
const THIRD_PARTY = /\b(?:recommend|recommends|recommended|provided by|partner|partners|buy direct|you buy|supplied by|powered by|offered by|refer you to|referral to|run by)\b/iu;

// ─── Blocks and units ────────────────────────────────────────────────────────

/** Words a full stop does not end a sentence after. Single letters (initials) are also never an end. */
const ABBREVIATIONS = new Set(['inc', 'incl', 'approx', 'e.g', 'i.e', 'eg', 'ie', 'no', 'nos', 'ltd', 'st', 'etc', 'vs', 'v', 'mr', 'mrs', 'ms', 'dr', 'prof', 'est', 'ex',
  'excl', 'exc', 'min', 'max', 'co', 'plc', 'bros', 'gt', 'nr', 'p.a', 'p.c.m', 'p.w', 'p.m', 'a.m', 'pcm', 'ave', 'rd', 'tel', 'ref', 'fig', 'cf', 'dept', 'govt',
  'u.k', 'sq', 'ft', 'mins', 'hrs', 'yrs', 'jr', 'sr', 'mt', 'ft', 'op', 'vol', 'pp', 'esp', 'approx', 'cont', 'corp', 'assoc', 'int', 'intl']);
/** A line longer than this is not split into sentences, and gives no claims or audiences. */
export const LINE_SPLIT_LIMIT = 20_000;

export interface Unit {
  readonly text: string; readonly s: number; readonly e: number; readonly line: number; readonly key: string; readonly kind: LineKind;
  /** Customer words: a testimonial line, inside quotation marks, or followed by an attribution. */
  readonly quoted: boolean;
  readonly unreliable: boolean;
  /** Ends with "." or "!" (closing quotes or brackets aside). */
  readonly ends: boolean;
  readonly words: number;
  readonly tooLong: boolean;
}
export interface Line { readonly text: string; readonly s: number; readonly e: number; readonly kind: LineKind; readonly contentStart: number; readonly units: readonly Unit[] }

const isSpace = (c: string | undefined) => c === undefined || c === ' ' || c === '\t' || c === ' ';
const CLOSERS = new Set(['"', "'", '”', '’', ')', ']', '»']);

/** Split one line into sentences. Linear: one pass, a bounded look-back for the word before a full stop. */
function sentences(line: string, from: number): { s: number; e: number }[] {
  const out: { s: number; e: number }[] = [];
  if (line.length - from > LINE_SPLIT_LIMIT) return [{ s: from, e: line.length }];
  let start = from;
  for (let i = from; i < line.length; i++) {
    const c = line[i]!;
    if (c !== '.' && c !== '!' && c !== '?') continue;
    let j = i + 1;
    while (j < line.length && CLOSERS.has(line[j]!)) j++;
    if (!isSpace(line[j])) continue;
    if (c === '.') {
      if (line[i - 1] === '.' || line[i + 1] === '.') continue; // "..." never ends a sentence
      let k = i - 1;
      while (k >= start && k > i - 14 && /[\p{L}\p{N}.]/u.test(line[k]!)) k--;
      const word = line.slice(k + 1, i).replace(/^\.+/, '').toLowerCase();
      if (ABBREVIATIONS.has(word) || /^\p{L}$/u.test(word)) continue;
    }
    if (line.slice(start, j).trim()) out.push({ s: start, e: j });
    start = j;
  }
  if (line.slice(start).trim()) out.push({ s: start, e: line.length });
  return out;
}

/** A short line naming who said the line above: "Sarah T, landlord", "— Tom", "John D.". */
const NAME_LINE = /^(?:[-–—]\s*\S.*|[\p{Lu}][\p{L}'’.-]*(?:\s+[\p{Lu}][\p{L}'’.-]*){0,3}\s*,\s*[\p{L}][\p{L}\s'’-]*|[\p{Lu}][\p{L}'’-]+\s+[\p{Lu}]\.?)$/u;
const nameLike = (text: string) => text.length <= 60 && text.trim().split(/\s+/).length <= 6 && !/\p{N}/u.test(text) && !/[!?:;]/.test(text) && NAME_LINE.test(text.trim());

export interface Structure { readonly basis: string; readonly lines: readonly Line[]; readonly units: readonly Unit[]; readonly tokens: readonly Tok[]; readonly key: string; readonly tokenLine: Int32Array }

/** A document as the rules read it: lines are blocks, sentences within a line are units. Computed once per document object. */
export function structureOf(text: string | null | undefined): Structure {
  const basis = basisText(text);
  const lines: Line[] = [];
  const units: Unit[] = [];
  let offset = 0;
  const raw = basis.split('\n');
  const kinds = raw.map((l) => lineKind(l));
  for (let li = 0; li < raw.length; li++) {
    const line = raw[li]!, s = offset;
    offset += line.length + 1;
    const { kind, start } = kinds[li]!;
    if (!line.slice(start).trim()) { lines.push({ text: line, s, e: s + line.length, kind, contentStart: s + start, units: [] }); continue; }
    const parts = sentences(line, start);
    // A paragraph followed by a short name-like line is a quote; so is the name line.
    const nextPara = kinds[li + 1]?.kind === 'para' ? raw[li + 1] ?? '' : '';
    const prevLine = li > 0 ? raw[li - 1]! : '';
    const attributed = kind === 'para' && nameLike(nextPara);
    const isAttribution = kind === 'para' && li > 0 && kinds[li - 1]!.kind === 'para' && nameLike(line) && prevLine.trim().length > 0;
    const tooLong = line.length - start > LINE_SPLIT_LIMIT;
    // Quoted spans: from an opening quote mark to its closing mark, across sentences, within the line.
    const spans: [number, number][] = [];
    if (!tooLong && /["“«„]/u.test(line)) {
      // Where each closing mark next occurs, from one backward pass, so finding a span never rescans the line.
      const next: Record<string, Int32Array> = { '"': new Int32Array(line.length + 1), '”': new Int32Array(line.length + 1), '»': new Int32Array(line.length + 1) };
      for (const c of Object.keys(next)) { const arr = next[c]!; arr[line.length] = -1; for (let i = line.length - 1; i >= 0; i--) arr[i] = line[i] === c ? i : arr[i + 1]!; }
      for (let i = start; i < line.length; i++) {
        const c = line[i]!;
        if ((c === '“' || c === '«' || c === '„' || c === '"') && (i === start || /[\s(]/.test(line[i - 1]!))) {
          const end = next[c === '«' ? '»' : c === '"' ? '"' : '”']![i + 1]!;
          if (end !== -1) { spans.push([i, end]); i = end; }
        }
      }
    }
    const mine: Unit[] = parts.map((p, i) => {
      const chunk = line.slice(p.s, p.e), lead = chunk.length - chunk.trimStart().length, unitText = chunk.trim();
      const us = s + p.s + lead, ue = us + unitText.length;
      const next = parts[i + 1] ? line.slice(parts[i + 1]!.s, parts[i + 1]!.e) : '';
      const quoted = kind === 'quoted' || attributed || isAttribution || spans.some(([a, b]) => a < p.e && b >= p.s)
        || /^\s*[-–—]\s*\p{L}/u.test(next) || /^[-–—]/u.test(unitText) || /["”»’]\s*[-–—]/u.test(unitText);
      return { text: unitText, s: us, e: ue, line: li, key: keyOf(unitText), kind, quoted, unreliable: unreliable(unitText), ends: /[.!]["'”’)\]»]*$/u.test(unitText),
        words: unitText.split(/\s+/).filter(Boolean).length, tooLong };
    });
    lines.push({ text: line, s, e: s + line.length, kind, contentStart: s + start, units: mine });
    units.push(...mine);
  }
  const tokens = tokenize(basis);
  const tokenLine = new Int32Array(tokens.length);
  let li = 0;
  for (let t = 0; t < tokens.length; t++) { while (li < lines.length - 1 && tokens[t]!.s >= lines[li]!.e + 1) li++; tokenLine[t] = li; }
  return { basis, lines, units, tokens, key: tokens.map((t) => t.w).join(' '), tokenLine };
}

const cache = new WeakMap<object, Structure>();
/** The structure of a document object, computed once while that object lives. */
export function structureOfDoc(doc: { readonly text?: string | null }): Structure {
  let s = cache.get(doc);
  if (!s) { s = structureOf(doc.text); cache.set(doc, s); }
  return s;
}

/** The nearest earlier line that is not a list item: what a list is introduced by. */
function leadIn(st: Structure, line: number): Line | null {
  for (let i = line - 1; i >= 0 && i >= line - 60; i--) if (st.lines[i]!.kind !== 'item' && st.lines[i]!.text.trim()) return st.lines[i]!;
  return null;
}
const itemContent = (st: Structure, l: Line) => st.basis.slice(l.contentStart, l.e).trim();

// ─── 2. Approved claims ──────────────────────────────────────────────────────

export const CLAIM_MAX = 220;

/**
 * The text of the source sentence an approved claim is, or null. A claim is one whole unit of the document, and one of:
 *   - a prose sentence: a paragraph unit that ends with "." or "!" and has at least four words;
 *   - a whole list item, when neither the item nor its lead-in line holds a negation or unreliability word and the
 *     item has no cross mark and does not start with "no" or "not".
 * Never: a heading, a table cell, customer words (testimonial lines, quotation marks, an attributed quote), anything
 * with a question mark, anything over 220 characters, or a line too long to split.
 */
export function claimSentence(claim: string, doc: { readonly text?: string | null }): string | null {
  if (claim.length > CLAIM_MAX || claim.includes('?')) return null;
  const k = keyOf(claim);
  if (!k) return null;
  const st = structureOfDoc(doc);
  for (const u of st.units) {
    if (u.key !== k || u.quoted || u.tooLong || u.text.includes('?')) continue;
    if (u.kind === 'para' && u.ends && u.words >= 4) return u.text;
  }
  for (const l of st.lines) {
    if (l.kind !== 'item') continue;
    const content = itemContent(st, l);
    if (keyOf(content) !== k || content.includes('?') || CROSS.test(content) || /^(?:no|not)\b/iu.test(content) || unreliable(content)) continue;
    const lead = leadIn(st, st.lines.indexOf(l));
    if (lead && unreliable(lead.text)) continue;
    return content;
  }
  return null;
}

// ─── 3. Audiences ────────────────────────────────────────────────────────────

export const AUDIENCE_MAX = 80;

/**
 * An audience is an unbroken run of words inside one unit of the document that is not customer words, has no quotation
 * marks and holds no negation or unreliability word; for a list item, its lead-in line is screened the same way.
 */
export function audienceUnit(audience: string, doc: { readonly text?: string | null }): Unit | null {
  if (audience.length > AUDIENCE_MAX) return null;
  const k = keyOf(audience);
  if (!k) return null;
  const st = structureOfDoc(doc);
  return st.units.find((u) => !u.quoted && !u.unreliable && !u.tooLong && !QUOTE_MARKS.test(u.text) && ` ${u.key} `.includes(` ${k} `)
    && (u.kind !== 'item' || !leadInUnreliable(st, u.line))) ?? null;
}
const leadInUnreliable = (st: Structure, line: number) => { const l = leadIn(st, line); return l ? unreliable(l.text) : false; };

// ─── 4. Offer names ──────────────────────────────────────────────────────────

export const OFFER_NAME_MAX = 80;
export const OFFER_NAME_WORDS = 10;
export const OFFER_LIMIT = 30;

const usableName = (name: string) => name.trim().length >= 3 && /\p{L}/u.test(name) && name.length <= OFFER_NAME_MAX && name.trim().split(/\s+/).length <= OFFER_NAME_WORDS && keyOf(name).length > 0;

/** Every whole-word place a name's words occur, as token ranges. Indexed by the first word, so each name costs its own hits only. */
function nameHits(st: Structure, name: string): [number, number][] {
  const k = keyOf(name).split(' ');
  if (!k[0]) return [];
  const idx = firstWordIndex(st);
  const out: [number, number][] = [];
  for (const at of idx.get(k[0]) ?? []) if (k.every((w, j) => st.tokens[at + j]?.w === w)) out.push([at, at + k.length]);
  return out;
}
const firstWords = new WeakMap<Structure, Map<string, number[]>>();
function firstWordIndex(st: Structure): Map<string, number[]> {
  let m = firstWords.get(st);
  if (!m) { m = new Map(); st.tokens.forEach((t, i) => { const a = m!.get(t.w); if (a) a.push(i); else m!.set(t.w, [i]); }); firstWords.set(st, m); }
  return m;
}
function unitOfToken(st: Structure, tok: number): Unit | null {
  const pos = st.tokens[tok]?.s ?? -1;
  let lo = 0, hi = st.units.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (st.units[mid]!.e <= pos) lo = mid + 1; else hi = mid; }
  const u = st.units[lo];
  return u && u.s <= pos && pos < u.e ? u : null;
}
/** True when the token at `tok` is the first word of its line's content (after the marker; for a table row, its first cell). */
const startsLine = (st: Structure, tok: number) => {
  const line = st.lines[st.tokenLine[tok]!]!;
  return tok === 0 || st.tokens[tok - 1]!.s < line.contentStart;
};

/**
 * Why an offer name cannot stand, or null. It must be 3 to 80 characters with a letter and at most 10 words, and be
 * written as a whole-word run in the cited document in at least one place that is a heading, a list item, the start of a
 * table row, or a prose sentence that is not customer words, negates nothing and is not about someone else's product.
 */
export function offerNameProblem(name: string, doc: { readonly text?: string | null }): string | null {
  if (!usableName(name)) return `must be 3 to ${OFFER_NAME_MAX} characters with a letter, and at most ${OFFER_NAME_WORDS} words`;
  const st = structureOfDoc(doc);
  const hits = nameHits(st, name);
  if (!hits.length) return 'is not written as these words in the document it cites';
  const ok = hits.some(([a]) => {
    const line = st.lines[st.tokenLine[a]!]!;
    if (line.kind === 'heading') return true;
    if (line.kind === 'item') return !unreliable(line.text);
    if (line.kind === 'row') return /\|\s*$/.test(st.basis.slice(Math.max(line.s, st.tokens[a]!.s - 4), st.tokens[a]!.s)) || startsLine(st, a);
    if (line.kind === 'quoted') return false;
    const u = unitOfToken(st, a);
    return Boolean(u && !u.quoted && !u.unreliable && !THIRD_PARTY.test(u.text));
  });
  return ok ? null : 'is only written in a sentence that negates it, quotes a customer or is about someone else\'s product';
}

// ─── 5. Prices ───────────────────────────────────────────────────────────────

const AMOUNT = /[£$€¥]\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:k|m|bn)\b)?|\d[\d,]*(?:\.\d+)?\s?(?:%|per\s?cent\b)|\b\d+(?:\.\d+)?p\b/giu;
const LEFT_QUALIFIERS = [['starting', 'from'], ['starting', 'at'], ['up', 'to'], ['from'], ['only'], ['just'], ['was'], ['now'], ['save'], ['approx'], ['approximately'], ['around']];
const PERIODS = new Set(['month', 'months', 'year', 'years', 'week', 'weeks', 'day', 'days', 'annum', 'hour', 'hours', 'person', 'session', 'visit', 'let', 'property', 'room', 'night',
  'job', 'tenancy', 'minute', 'class', 'lesson', 'user', 'seat', 'unit', 'flat', 'house', 'home', 'head', 'item', 'page', 'report', 'certificate', 'quarter', 'appliance']);
const PERIOD_LINKS = new Set(['per', 'a', 'an', 'each', 'every']);
const AFTER = [['pcm'], ['pw'], ['pa'], ['pm'], ['ph'], ['p', 'a'], ['p', 'w'], ['p', 'c', 'm'], ['p', 'm'], ['each'], ['one', 'off'], ['one-off'],
  ['+', 'vat'], ['plus', 'vat'], ['inc', 'vat'], ['incl', 'vat'], ['including', 'vat'], ['inclusive', 'of', 'vat'], ['ex', 'vat'], ['exc', 'vat'], ['excl', 'vat'],
  ['excluding', 'vat'], ['exclusive', 'of', 'vat'], ['vat', 'included'], ['plus', 'disbursements'], ['+', 'disbursements'], ['plus', 'fees'], ['+', 'fees']];
const BASES = new Set(['rent', 'rents', 'rental', 'income', 'value', 'price', 'fee', 'fees', 'sale', 'sales', 'purchase', 'loan', 'mortgage', 'turnover', 'cost', 'costs', 'amount',
  'profit', 'profits', 'premium', 'collected', 'budget', 'spend', 'commission']);
/** A sentence about someone else's prices never supplies one. */
const COMPETITOR = /\b(?:other agents?|other firms?|other companies|other providers?|competitors?|elsewhere|typically|typical|industry average|on average|compared (?:with|to)|unlike|high street agents?)\b/iu;
const OWN_SUBJECTS = new Set(['we', 'our', 'i', 'it', 'this', 'that', 'which', 'the', 'each', 'every', 'one', 'it\'s', 'everything']);
const SAVING_BEFORE = new Set(['save', 'saving', 'savings', 'worth', 'discount', 'discounted', 'cashback', 'voucher', 'credit', 'rebate', 'off']);
const SAVING_AFTER = new Set(['off', 'discount', 'cashback', 'saving', 'savings', 'voucher', 'credit']);
const HOLD_WORDS = new Set(['deposit', 'minimum', 'min', 'spend', 'holding']);

/** A full price expression: the amount (or range) with every qualifier written beside it, and why it may not be a price. */
export interface PriceExpression {
  readonly ts: number; readonly te: number; readonly s: number; readonly e: number; readonly key: string; readonly text: string; readonly line: number; readonly unit: Unit | null;
  /** Never a price: a competitor sentence, a saving or value, a percentage with no base, or customer words. */
  readonly never: boolean;
  /** The capitalised name that "charges/costs/quotes" this amount in its sentence, if any ("Foxtons charge 20%"). */
  readonly subject: string | null;
  /** A deposit or minimum word beside the amount: a price only for an offer whose own name holds that word. */
  readonly hold: string | null;
}

const seq = (tokens: readonly Tok[], at: number, words: readonly string[]) => words.every((w, i) => tokens[at + i]?.w === w);

interface PriceView { readonly expressions: readonly PriceExpression[]; readonly byLine: ReadonlyMap<number, PriceExpression[]>; readonly byUnit: ReadonlyMap<Unit, PriceExpression[]> }
const priceCache = new WeakMap<Structure, PriceView>();

/** Every price expression in a document, once per document. */
function priceView(st: Structure): PriceView {
  const done = priceCache.get(st);
  if (done) return done;
  const { tokens, basis } = st;
  const firstTokenAt = (pos: number) => { let lo = 0, hi = tokens.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (tokens[mid]!.s < pos) lo = mid + 1; else hi = mid; } return lo; };
  interface Amount { ts: number; te: number; s: number; e: number; percent: boolean }
  const amounts: Amount[] = [];
  for (const m of basis.matchAll(AMOUNT)) {
    const s = m.index!, e = s + m[0].length, ts = firstTokenAt(s);
    let te = ts; while (te < tokens.length && tokens[te]!.e <= e) te++;
    if (te > ts) amounts.push({ ts, te, s, e, percent: /%|per\s?cent/iu.test(m[0]) });
  }
  const groups: Amount[][] = [];
  for (const a of amounts) {
    const last = groups[groups.length - 1], prev = last?.[last.length - 1];
    if (prev && /^\s*(?:-|–|—|to)\s*$/iu.test(basis.slice(prev.e, a.s))) last!.push(a); else groups.push([a]);
  }
  const expressions: PriceExpression[] = [];
  const byLine = new Map<number, PriceExpression[]>();
  const byUnit = new Map<Unit, PriceExpression[]>();
  const competitorUnits = new Map<Unit, boolean>();
  for (const g of groups) {
    let ts = g[0]!.ts, te = g[g.length - 1]!.te;
    const percent = g.some((a) => a.percent);
    let based = false;
    for (let changed = true; changed;) {
      changed = false;
      for (const q of LEFT_QUALIFIERS) if (ts - q.length >= 0 && seq(tokens, ts - q.length, q)) { ts -= q.length; changed = true; break; }
    }
    for (let changed = true, n = 0; changed && n < 12; n++) {
      changed = false;
      const next = tokens[te];
      if (!next) break;
      const link = PERIOD_LINKS.has(next.w) ? 1 : 0;
      const cal = tokens[te + link]?.w === 'calendar' ? 1 : 0;
      const period = tokens[te + link + cal];
      if (period && PERIODS.has(period.w) && (link || /\//.test(basis.slice(tokens[te - 1]!.e, next.s)))) { te += link + cal + 1; changed = true; continue; }
      if (next.w === 'for' && tokens[te + 1]?.w === 'your' && tokens[te + 2]?.w === 'first' && tokens[te + 4] && PERIODS.has(tokens[te + 4]!.w)) { te += 5; changed = true; continue; }
      const after = AFTER.find((q) => seq(tokens, te, q));
      if (after) { te += after.length; changed = true; continue; }
      if (percent && next.w === 'of') {
        for (let k = 1; k <= 6 && te + k < tokens.length; k++) {
          const t = tokens[te + k]!;
          if (/^[£$€¥%]$|^\d/.test(t.w)) break;
          if (BASES.has(t.w)) { te += k + 1; changed = true; based = true; break; }
        }
      }
      if (percent && !based && (next.w === 'commission' || next.w === 'fee' || next.w === 'fees' || next.w === 'management')) { te += 1; based = true; changed = true; }
    }
    // The words around the amount, within its own sentence only.
    const unitOf = unitOfToken(st, g[0]!.ts), us = unitOf?.s ?? 0, ue = unitOf?.e ?? basis.length;
    const before = tokens.slice(Math.max(0, ts - 4), ts).filter((t) => t.s >= us).map((t) => t.w), after = tokens.slice(te, te + 3).filter((t) => t.e <= ue).map((t) => t.w);
    if (percent && !based && (before.slice(-2).join(' ') === 'fee of' || before.slice(-2).join(' ') === 'commission of' || before.includes('commission') || before.includes('fee'))) based = true;
    let s = tokens[ts]!.s, e = tokens[te - 1]!.e;
    // A closing bracket the expression opened is kept: "12% of monthly rent (inc. VAT)".
    let text = basis.slice(s, e);
    if ((text.match(/\(/g)?.length ?? 0) > (text.match(/\)/g)?.length ?? 0)) { const close = basis.indexOf(')', e); if (close !== -1 && close - e <= 3) { e = close + 1; text = basis.slice(s, e); } }
    const u = unitOfToken(st, g[0]!.ts);
    let competitor = u ? competitorUnits.get(u) : false;
    if (u && competitor === undefined) { competitor = COMPETITOR.test(u.text); competitorUnits.set(u, competitor); }
    const saving = before.some((w) => SAVING_BEFORE.has(w)) || after.slice(0, 2).some((w) => SAVING_AFTER.has(w)) || tokens[ts]!.w === 'save';
    const hold = [...before, ...after].find((w) => HOLD_WORDS.has(w)) ?? null;
    // "Foxtons charge 20%": a capitalised subject straight before charge/costs/quote, other than our own words.
    let subject: string | null = null;
    const unitStart = u?.s ?? 0;
    for (let k = ts - 1; k >= Math.max(0, ts - 8) && tokens[k]!.s >= unitStart; k--) {
      if (/^(?:charge|charges|charged|charging|cost|costs|quote|quotes|quoted)$/.test(tokens[k]!.w)) {
        const words: string[] = [];
        for (let j = k - 1; j >= Math.max(0, k - 4) && tokens[j]!.s >= unitStart && /^\p{Lu}/u.test(tokens[j]!.raw); j--) words.unshift(tokens[j]!.raw);
        if (words.length && !words.some((w) => OWN_SUBJECTS.has(w.toLowerCase()))) subject = words.join(' ');
        break;
      }
    }
    const x: PriceExpression = { ts, te, s, e, key: tokens.slice(ts, te).map((t) => t.w).join(' '), text, line: st.tokenLine[g[0]!.ts]!, unit: u,
      never: Boolean(competitor) || saving || (percent && !based) || Boolean(u?.quoted) || st.lines[st.tokenLine[g[0]!.ts]!]!.kind === 'quoted', subject, hold };
    expressions.push(x);
    const list = byLine.get(x.line); if (list) list.push(x); else byLine.set(x.line, [x]);
    if (u) { const ul = byUnit.get(u); if (ul) ul.push(x); else byUnit.set(u, [x]); }
  }
  const view = { expressions, byLine, byUnit };
  priceCache.set(st, view);
  return view;
}

const PRICE_LABEL_WORDS = new Set(['price', 'prices', 'pricing', 'cost', 'costs', 'fee', 'fees', 'total', 'pay', 'rate', 'rates', 'charge', 'charges', 'from', 'only', 'just', 'now', 'was',
  'save', 'up', 'to', 'approx', 'around', 'starting', 'at', 'per', 'a', 'an', 'the', 'and', 'or', 'plus', 'monthly', 'yearly', 'annual', 'annually', 'one', 'off', 'standard', 'visit',
  'month', 'year', 'hour', 'session', 'each', 'vat', 'inc', 'incl', 'including', 'ex', 'excl', 'investment', 'is', 'it', 'costs']);

/** True when a candidate amount may be a price for an offer with this name. */
function candidateFor(x: PriceExpression, key: string): boolean {
  if (x.never) return false;
  const nameKey = ` ${key} `;
  if (x.subject && !nameKey.includes(` ${keyOf(x.subject)} `) && !` ${keyOf(x.subject)} `.includes(nameKey)) return false;
  if (x.hold && !nameKey.includes(` ${x.hold} `)) return false;
  return true;
}

/** Which offer (longest name) a line begins with, after its marker; -1 when none. For a table row, its first cell. */
function anchorOf(st: Structure, line: Line, names: readonly string[], keys: readonly string[][]): number {
  if (line.kind === 'quoted') return -1;
  const content = st.basis.slice(line.contentStart, line.e);
  const first = tokenize(content).slice(0, OFFER_NAME_WORDS).map((t) => t.w);
  let best = -1;
  keys.forEach((k, i) => { if (k.length && usableName(names[i]!) && k.every((w, j) => first[j] === w) && (best < 0 || k.length > keys[best]!.length)) best = i; });
  return best;
}

/** The line starts a new "name, then price" card: a short label line with no sentence punctuation that is not just price words. */
function cardStart(st: Structure, view: PriceView, i: number): boolean {
  const l = st.lines[i]!;
  if (l.kind === 'heading') return true;
  const content = st.basis.slice(l.contentStart, l.e).trim();
  if (!content || content.length >= 60 || /[.!?]/.test(content) || !/\p{L}/u.test(content)) return false;
  const own = view.byLine.get(i);
  const label = own?.length ? st.basis.slice(l.contentStart, own[0]!.s) : content;
  const words = tokenize(label).map((t) => t.w).filter((w) => /\p{L}/u.test(w));
  if (!words.length || words.every((w) => PRICE_LABEL_WORDS.has(w))) return false;
  if (own?.length) return true;
  return Boolean(view.byLine.get(i + 1)?.length || view.byLine.get(i + 2)?.length);
}

const RUN_LINES = 12, RUN_CHARS = 600;
const amountOnly = (st: Structure, view: PriceView, i: number) => {
  const l = st.lines[i]!, xs = view.byLine.get(i);
  return Boolean(xs?.length) && keyOf(st.basis.slice(l.contentStart, l.e)) === xs!.map((x) => x.key).join(' ');
};
const nextIsCard = (st: Structure, i: number, isAnchor: ReadonlySet<number>) => {
  for (let j = i + 1; j < st.lines.length; j++) if (st.lines[j]!.text.trim()) return st.lines[j]!.kind === 'heading' || isAnchor.has(j);
  return false;
};
/** Names, keys and anchors of one document for one offer list, built once per check. */
interface Anchors { readonly done: Map<number, PriceExpression[]>; readonly nameKeys: readonly string[]; readonly anchorsOf: ReadonlyMap<number, number[]>; readonly isAnchor: ReadonlySet<number>; readonly unitOffers: ReadonlyMap<Unit, ReadonlySet<number>>; readonly hits: readonly [number, number][][] }
const anchorCache = new WeakMap<Structure, Map<string, Anchors>>();
function anchorsFor(st: Structure, names: readonly string[]): Anchors {
  const id = JSON.stringify(names);
  let byNames = anchorCache.get(st);
  if (!byNames) { byNames = new Map(); anchorCache.set(st, byNames); }
  const done = byNames.get(id);
  if (done) return done;
  const keys = names.map((n) => (usableName(n) ? keyOf(n).split(' ') : []));
  const anchorsOf = new Map<number, number[]>();
  const isAnchor = new Set<number>();
  if (st.lines.length >= 2) st.lines.forEach((l, i) => { const a = anchorOf(st, l, names, keys); if (a >= 0) { isAnchor.add(i); const list = anchorsOf.get(a); if (list) list.push(i); else anchorsOf.set(a, [i]); } });
  // Which offers each sentence names, once, for the prose fallback.
  const hits = names.map((n) => (usableName(n) ? nameHits(st, n) : []));
  const unitOffers = new Map<Unit, Set<number>>();
  hits.forEach((hs, i) => { for (const [a] of hs) { const u = unitOfToken(st, a); if (u) { const set = unitOffers.get(u); if (set) set.add(i); else unitOffers.set(u, new Set([i])); } } });
  const result = { done: new Map<number, PriceExpression[]>(), nameKeys: keys.map((k) => k.join(' ')), anchorsOf, isAnchor, unitOffers, hits };
  byNames.set(id, result);
  return result;
}

/**
 * THE PRICE RULE. The distinct full price expressions written for offer `self` (an index into `names`, the model's own
 * offer list) in one document, tied by the page's structure, never by "the nearest amount":
 *   - an ANCHOR is a line that the offer's name begins (heading, list item, table row's first cell, paragraph), the
 *     longest name winning; a mention inside prose is not an anchor;
 *   - its RUN is the anchor line to just before the next heading, the next anchor of any offer the model named, or the
 *     next line that starts another "name, then price" card; at most 12 lines and 600 characters; a table row is its run;
 *   - every money amount, and every percentage with a base, in the run is a candidate, except: a competitor sentence, a
 *     saving or value ("save", "worth", "off", "discount"), a deposit or minimum (unless the offer's own name says so),
 *     a percentage with no base, and customer words.
 * With no anchor (and always on a page stored as one line), the only rule is the prose fallback: one sentence that holds
 * the offer's name, then exactly one candidate amount, and no other offer the model named. A price written above its name
 * is never tied.
 */
export function priceCandidates(doc: { readonly text?: string | null }, names: readonly string[], self: number): PriceExpression[] {
  const st = structureOfDoc(doc);
  const name = names[self] ?? '';
  if (!usableName(name)) return [];
  const anchors = anchorsFor(st, names);
  const known = anchors.done.get(self);
  if (known) return known;
  const result = findCandidates(st, anchors, names, self);
  anchors.done.set(self, result);
  return result;
}
function findCandidates(st: Structure, anchors: Anchors, names: readonly string[], self: number): PriceExpression[] {
  const view = priceView(st), name = names[self]!;
  const { nameKeys, anchorsOf, isAnchor, unitOffers, hits } = anchors;
  const selfKey = nameKeys[self] ?? keyOf(name);
  const found = new Map<string, PriceExpression>();
  const add = (x: PriceExpression) => { if (!found.has(x.key)) found.set(x.key, x); };
  const mine = anchorsOf.get(self) ?? [];
  // Prices written above their names: the line just before the first offer's line is only a price.
  let firstAnchor = -1;
  for (const i of isAnchor) if (firstAnchor < 0 || i < firstAnchor) firstAnchor = i;
  let prev = firstAnchor - 1; while (prev >= 0 && !st.lines[prev]!.text.trim()) prev--;
  const pricesAbove = firstAnchor >= 0 && prev >= 0 && amountOnly(st, view, prev);
  for (const a of mine) {
    const start = st.lines[a]!;
    let end = a + 1;
    if (start.kind !== 'row') {
      while (end < st.lines.length && end - a < RUN_LINES && st.lines[end]!.e - start.s <= RUN_CHARS && !isAnchor.has(end) && !cardStart(st, view, end)) end++;
    }
    for (let i = a; i < end; i++) {
      // A line that is only a price, straight above a heading or another offer's line, belongs to what follows (a layout
      // with prices above names): it is tied to neither.
      if (i > a && pricesAbove && amountOnly(st, view, i) && nextIsCard(st, i, isAnchor)) continue;
      for (const x of view.byLine.get(i) ?? []) if (x.s >= start.s && candidateFor(x, selfKey)) add(x);
    }
  }
  if (mine.length) return [...found.values()];
  // Prose fallback.
  for (const [a] of hits[self] ?? []) {
    const u = unitOfToken(st, a);
    if (!u || u.quoted) continue;
    const cands = (view.byUnit.get(u) ?? []).filter((x) => candidateFor(x, selfKey));
    if (cands.length !== 1 || cands[0]!.ts < a) continue;
    let other = false;
    for (const o of unitOffers.get(u) ?? []) if (o !== self && nameKeys[o] !== selfKey) { other = true; break; }
    if (other) continue;
    add(cands[0]!);
  }
  return found.size === 1 ? [...found.values()] : [];
}

export type PriceStatus = 'tied' | 'ambiguous' | 'untied';
/** The model's price against the page: exactly the one candidate ('tied'), the page gives several ('ambiguous'), or not. */
export function priceStatus(price: string, doc: { readonly text?: string | null }, names: readonly string[], self: number): { status: PriceStatus; page: readonly PriceExpression[] } {
  const page = priceCandidates(doc, names, self);
  if (page.length > 1) return { status: 'ambiguous', page };
  return { status: page.length === 1 && page[0]!.key === keyOf(price) ? 'tied' : 'untied', page };
}

// ─── 6. Description fields ───────────────────────────────────────────────────

const MONEY_OR_PERCENT = /[£$€¥%]|\bper\s?cent\b|\b\d+(?:[.,]\d+)?p\b/iu;
const NUMBER = /\p{N}+(?:[.,]\p{N}+)*/gu;
const numbersOf = (text: string) => [...basisText(text).matchAll(NUMBER)].map((m) => m[0]);
export const DESCRIPTION_MAX = 600;
export const VOICE_LINE_MAX = 200;

/** Every number the sources state, exactly as written ("1,500" and "1500" are different numbers). */
export function sourceNumbers(documents: readonly { readonly text?: string | null }[]): Set<string> {
  return new Set(documents.flatMap((d) => numbersOf(d.text ?? '')));
}

/** The sentences of a piece of description, for cutting. Line breaks also end a sentence. */
export function descriptionSentences(text: string): string[] {
  return text.split('\n').flatMap((line) => sentences(line, 0).map((p) => line.slice(p.s, p.e).trim())).filter(Boolean);
}

/** True when one sentence of description may stand: no money or percentage at all, and every other number is one a source states. */
export function descriptionSentenceOk(sentence: string, numbers: ReadonlySet<string> | null): boolean {
  const b = basisText(sentence);
  if (MONEY_OR_PERCENT.test(b)) return false;
  const ns = numbersOf(b);
  return numbers ? ns.every((n) => numbers.has(n)) : ns.length === 0;
}

/**
 * The description with every failing sentence cut, and what was cut. Over `max` characters, whole sentences are also cut
 * from the end until it fits. Text is returned unchanged when nothing fails.
 */
export function cutDescription(text: string, numbers: ReadonlySet<string> | null, max = Infinity): { readonly text: string; readonly cut: readonly string[] } {
  if (!text) return { text, cut: [] };
  const parts = descriptionSentences(text);
  const cut = parts.filter((p) => !descriptionSentenceOk(p, numbers));
  let kept = parts.filter((p) => !cut.includes(p));
  if (!cut.length && text.length <= max) return { text, cut: [] };
  while (kept.join(' ').length > max && kept.length) cut.push(kept.pop()!);
  return { text: kept.join(' '), cut };
}

// ─── 7. "Never say" lines ────────────────────────────────────────────────────

export const NEVER_SAY_MAX = 120;
const INSTRUCTS = /\b(?:always|must|should|make sure|ensure|state that|say that|mention that|tell (?:them|people|customers|readers|clients|landlords))\b/iu;

/**
 * A model-proposed "never say" line is a suggestion that only restricts the writer, so it is not word-matched. It is kept
 * when it has two or more words, at most 120 characters, no number, money or percentage, gives no instruction to say
 * something (always, must, should, make sure, ensure, state/say/mention that, tell people), and is not the business's
 * own positive words (a whole sentence, or a run of three or more words inside one, that negates nothing).
 */
export function neverSayKept(line: string, documents: readonly { readonly text?: string | null }[]): boolean {
  if (line.length > NEVER_SAY_MAX || /[\p{N}£$€¥%]/u.test(basisText(line)) || INSTRUCTS.test(basisText(line))) return false;
  const k = keyOf(line);
  const words = k ? k.split(' ').length : 0;
  if (words < 2) return false;
  return !documents.some((d) => structureOfDoc(d).units.some((u) => !u.unreliable && !u.quoted && (u.key === k || (words >= 3 && ` ${u.key} `.includes(` ${k} `)))));
}

// ─── 8. Links ────────────────────────────────────────────────────────────────

/** Hosts many unrelated businesses share. On one, a business's site is its path, so a link must start with that path. */
export const SHARED_HOSTS = ['sites.google.com', 'github.io', 'wixsite.com', 'carrd.co', 'wordpress.com', 'blogspot.com', 'squarespace.com', 'webflow.io', 'netlify.app', 'vercel.app',
  'pages.dev', 'notion.site', 'weebly.com', 'godaddysites.com', 'square.site', 'linktr.ee', 'company.site', 'mystrikingly.com', 'jimdosite.com', 'site123.me',
  'facebook.com', 'instagram.com', 'linkedin.com', 'x.com', 'twitter.com', 'tiktok.com', 'youtube.com', 'etsy.com', 'ebay.co.uk', 'ebay.com', 'amazon.co.uk', 'checkatrade.com',
  'yell.com', 'trustatrader.com', 'mybuilder.com', 'bark.com', 'google.com', 'business.site', 'myshopify.com'];
export interface LinkContext { readonly website?: string | null; readonly pages?: readonly (string | null | undefined)[] }

function parsed(url: string): URL | null {
  if (url.length > 2000 || /[\s\\]/u.test(url) || !/^https:\/\//i.test(url)) return null;
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
 * A link (offer url or conversion page) is kept only when it is https (any letter case), with no user name or password,
 * on the default port, and its host is the business's website host or a subdomain of it, or exactly a host a page was
 * read from. A host written in page text does not count. On a shared host (social networks, marketplaces, site builders)
 * the link must start with the website's own path; a website on a shared host with no path allows no links at all.
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
  if (siteHost && shared(siteHost)) {
    const sitePath = site!.pathname.replace(/\/+$/, '');
    if (!sitePath) return false;
    return host === siteHost && (u.pathname === sitePath || u.pathname.startsWith(`${sitePath}/`));
  }
  if (!siteHost && pageHosts.some(shared)) return false;
  return (base !== null && (host === base || host === siteHost || host.endsWith(`.${base}`))) || pageHosts.includes(host);
}

/** A conversion-page label is kept when it is a run of words from a sentence that is not customer words and negates nothing; otherwise the link's own path. */
export function linkLabel(label: string, url: string, documents: readonly { readonly text?: string | null }[]): string {
  const k = keyOf(label);
  if (label.length <= 80 && k && documents.some((d) => structureOfDoc(d).units.some((u) => !u.quoted && !u.unreliable && ` ${u.key} `.includes(` ${k} `)))) return label;
  try { const u = new URL(url); return u.pathname && u.pathname !== '/' ? decodeURIComponent(u.pathname) : u.hostname; } catch { return url; }
}
