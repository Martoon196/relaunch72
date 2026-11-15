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
export type LineKind = 'heading' | 'item' | 'row' | 'quoted' | 'para' | 'action';
const MARKERS: [string, LineKind, number][] = [['• ', 'item', 0], ['| ', 'row', 0], ['❝ ', 'quoted', 0], ['▸ ', 'action', 1], ['▹ ', 'action', 0]];
/**
 * The kind of a stored line, where its words start, and its level: for a heading 1 to 6 (from "# " to "###### "); for
 * action text (a button, a button link, a form), 1 when it sits in the card of the heading above it ("▸ "), else 0 ("▹ ").
 */
export function lineKind(line: string): { kind: LineKind; start: number; level: number } {
  const h = /^(#{1,6}) /.exec(line);
  if (h) return { kind: 'heading', start: h[0].length, level: h[1]!.length };
  for (const [m, kind, level] of MARKERS) if (line.startsWith(m)) return { kind, start: m.length, level };
  return { kind: 'para', start: 0, level: 0 };
}
/** Stored page text as a person should read it: the structure markers removed. */
export function withoutMarkers(text: string | null | undefined): string {
  return String(text ?? '').split('\n').map((l) => l.slice(lineKind(l).start)).join('\n');
}

// ─── Words that turn a sentence round, or say it is not the business's own fact ──

/** Negation words, as whole words: "no-obligation" and "non-stop" hold none. */
const NEGATION = /(?<![\p{L}\p{N}'’-])(?:not|no|never|nor|neither|without|unlike|except|excluding|cannot|unable|none|stopped)(?![\p{L}\p{N}'’-])|\bno longer\b|\brather than\b|\binstead of\b|n['’]t(?![\p{L}])/u;
/** Words that say a sentence is not a plain statement of fact: myths, mistakes, hopes and plans. */
const NOT_FACT = /\b(?:myths?|misconceptions?|lies?|false|untrue|wrong|mistakes?)\b|\bhope to\b|\baim(?:ing)? to\b|\b(?:aim|goal|ambition|mission|vision|dream) is to\b|\bplan to\b|\bwant to become\b|\bwill be\b|\bwould be\b|\bsome (?:\w+ ){0,2}(?:think|thinks|believe|believes|say|says)\b/u;
/** Not yet, or only asked about: never who the business serves or what it sells. */
const NOT_YET = /\bworking towards\b|\bask(?:ed)? about\b|\boften ask\b|\blooking into\b|\bconsidering\b|\bcoming soon\b|\blaunching soon\b/u;
/** "will soon": only in the clause that holds the audience or offer name ("…landlords in Kent and will soon open in Sussex"). */
const WILL_SOON = /\bwill soon\b/u;
/** A list's introduction that says the list is about the reader's problems, other people, or what is not here yet.
 * A question to the reader counts only when it opens a sentence ("Do you…?", "Are you…?"), so "What do you get?" is a plain heading. */
const PAIN = /(?:^|[.!?]\s+)[^\p{L}\p{N}]*(?:do you|does your|are you|is your|have you)\b|\btired of\b|\bfed up\b|\bstruggling\b|\bworried\b|\bsound(?:s)? familiar\b|\bsick of\b|\bfrustrated\b|\bagents who\b|\bother (?:agents|companies|firms|businesses)\b|\bunlike\b|\bmistakes\b|\bpitfalls\b|\bmyths?\b|\bcoming soon\b|\blaunching soon\b|\bplanned\b|\bin development\b/u;
const lowerBasis = (text: string) => basisText(text).toLowerCase();
/** True when a piece of text holds a negation or an unreliability word (the lists above, "not yet" words included). */
export const unreliable = (text: string) => { const t = lowerBasis(text); return NEGATION.test(t) || NOT_FACT.test(t) || NOT_YET.test(t); };
const leadInBad = (text: string) => { const t = lowerBasis(text); return NEGATION.test(t) || NOT_FACT.test(t) || PAIN.test(t); };
const itemBad = (text: string) => CROSS.test(text) || NOT_FACT.test(lowerBasis(text));
/** True when the clause of `text` that holds `key` (a keyOf) says "will soon". Clauses split at , ; : dashes and "and"/"but". */
const soonInClause = (text: string, key: string) => {
  const t = lowerBasis(text);
  if (!WILL_SOON.test(t)) return false;
  const clauses = t.split(/[,;:—–]|\s-\s|\b(?:and|but)\b/u);
  const holding = clauses.filter((c) => ` ${keyOf(c)} `.includes(` ${key} `));
  return holding.length ? holding.some((c) => WILL_SOON.test(c)) : true;
};
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

/** A short line naming who said the line above: "Sarah T, landlord", "— Tom", "John D.", "The Smith family", "Ann, 34, nurse". */
const NAME_LINE = /^(?:[-–—]\s*)?(?:the\s+[\p{Lu}][\p{L}'’-]*\s+family|[\p{Lu}][\p{L}'’.-]*(?:\s+[\p{Lu}][\p{L}'’.-]*){0,3}(?:\s*,\s*[\p{L}\p{N}][\p{L}\p{N}\s'’-]*){0,2})\.?$/iu;
const nameLike = (text: string) => text.length <= 60 && text.trim().split(/\s+/).length <= 6 && !/[!?:;]/.test(text) && NAME_LINE.test(text.trim());
/** A name line as a page writes it under a quote, "Sarah T, landlord", "Mark, Whitstable", "Mrs K": it marks the line above
 * whatever that line looks like (as at f4e43219). Not a place list (two commas or an "and"), a typed bullet or a label. */
const NAMED_BY = /^(?:[\p{Lu}][\p{L}'’.-]*(?:\s+[\p{Lu}][\p{L}'’.-]*){0,3}\s*,\s*[\p{L}][\p{L}'’-]*(?:\s+[\p{L}][\p{L}'’-]*){0,3}|(?:Mr|Mrs|Ms|Miss|Mx|Dr)\.?\s+[\p{Lu}]\.?)$/u;
const namedBy = (raw: string) => { const text = raw.trim(); return text.length <= 60 && text.split(/\s+/).length <= 6 && !/\p{N}/u.test(text) && !/\band\b|&/u.test(text) && (text.match(/,/g)?.length ?? 0) <= 1 && NAMED_BY.test(text); };
/** Otherwise only a line that is itself in quotation marks is attributed by a short name line under it (the page reader also uses italics and star ratings). */
const inQuoteMarks = (text: string) => /^["“«„]/u.test(text.trim()) || /["”»]$/u.test(text.trim());

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
    const attributed = kind === 'para' && ((inQuoteMarks(line) && nameLike(nextPara)) || namedBy(nextPara));
    const isAttribution = kind === 'para' && li > 0 && kinds[li - 1]!.kind === 'para' && ((nameLike(line) && inQuoteMarks(prevLine)) || (namedBy(line) && prevLine.trim().length > 0));
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
      // "Best decision we ever made. — Sarah": a short dash-name ending the line attributes the sentence before it.
      const dashName = (t: string) => /^\s*[—–]\s*\p{Lu}/u.test(t) && nameLike(t.trim().replace(/^[—–]\s*/u, ''));
      const quoted = kind === 'quoted' || attributed || isAttribution || spans.some(([a, b]) => a < p.e && b >= p.s)
        || (i === parts.length - 2 && dashName(next)) || (i === parts.length - 1 && i > 0 && dashName(unitText)) || /["”»’]\s*[—–-]\s*\p{Lu}/u.test(unitText);
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
 *   - a whole list item, when its lead-in line (the nearest earlier line that is not an item) is not a question and
 *     holds no negation, unreliability or "problem" word (tired of, sound familiar, other agents, pitfalls …), and the
 *     item itself has no cross mark and no myth/false/wrong/hope-to word. An item's own "No …" is allowed: "No
 *     call-out charge" is the business's statement.
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
    if (keyOf(content) !== k || content.includes('?') || itemBad(content)) continue;
    const lead = leadIn(st, st.lines.indexOf(l));
    if (lead && leadInBad(withoutMarkers(lead.text))) continue;
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
  return st.units.find((u) => !u.quoted && u.kind !== 'action' && !u.unreliable && !u.tooLong && !QUOTE_MARKS.test(u.text) && ` ${u.key} `.includes(` ${k} `) && !soonInClause(u.text, k)
    && (u.kind !== 'item' || !leadInUnreliable(st, u.line))) ?? null;
}
const leadInUnreliable = (st: Structure, line: number) => { const l = leadIn(st, line); return l ? leadInBad(withoutMarkers(l.text)) : false; };

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
    if (line.kind === 'item') return !unreliable(line.text) && !soonInClause(line.text, keyOf(name));
    if (line.kind === 'row') return /\|\s*$/.test(st.basis.slice(Math.max(line.s, st.tokens[a]!.s - 4), st.tokens[a]!.s)) || startsLine(st, a);
    if (line.kind === 'quoted' || line.kind === 'action') return false;
    const u = unitOfToken(st, a);
    return Boolean(u && !u.quoted && !u.unreliable && !THIRD_PARTY.test(u.text) && !soonInClause(u.text, keyOf(name)));
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
/** Words an expression never runs past. */
const STOP_WORDS = new Set(['and', 'or', 'but', 'plus', '+', 'with', 'for', 'to', 'in', 'on', 'at', 'by', 'from', 'including', 'inc', 'incl', 'ex', 'excl', 'excluding', 'if', 'when', 'then', 'so', 'as', 'than', 'vat',
  'is', 'are', 'was', 'were', 'lasts', 'last', 'includes', 'include', 'covers', 'takes', 'gets', 'means']);
/** A percentage base never ends on these. */
const BASE_TAIL = new Set(['of', 'the', 'a', 'an']);
/** "Price on request" and the like: the offer's own card says it has no written price. */
const NO_PRICE = /\bprice on (?:request|application)\b|\bpoa\b|\bcall (?:us )?for (?:a )?(?:price|prices|quote)\b|\bcontact us for (?:a )?(?:price|quote)\b/iu;

/** A full price expression: the amount (or range) with every qualifier written beside it, and why it may not be a price. */
export interface PriceExpression {
  readonly ts: number; readonly te: number; readonly s: number; readonly e: number; readonly key: string; readonly text: string; readonly line: number; readonly unit: Unit | null;
  /** Never a price: a competitor sentence, a saving or value, a percentage with no base, or customer words. */
  readonly never: boolean;
  /** The capitalised name that "charges/costs/quotes" this amount in its sentence, if any ("Foxtons charge 20%"). */
  readonly subject: string | null;
  /** A deposit or minimum word beside the amount: a price only for an offer whose own name holds that word. */
  readonly hold: string | null;
  /** The expression ends its sentence or meets punctuation: nothing unread trails it. */
  readonly endsClean: boolean;
  /** Unsure what the amount is (pence written apart, "£49 99"; or "a"/"an" opening prose, "£85 a great price"): never a candidate. */
  readonly unsure?: boolean;
}

const seq = (tokens: readonly Tok[], at: number, words: readonly string[]) => words.every((w, i) => tokens[at + i]?.w === w);

interface PriceView { readonly expressions: readonly PriceExpression[]; readonly byLine: ReadonlyMap<number, PriceExpression[]>; readonly byUnit: ReadonlyMap<Unit, PriceExpression[]> }
const priceCache = new WeakMap<Structure, Map<string, PriceView>>();

/** Every price expression in a document, once per document and offer list (a unit never runs into a listed offer's name). */
function priceView(st: Structure, names: readonly string[] = []): PriceView {
  const id = JSON.stringify(names);
  let byNames = priceCache.get(st);
  if (!byNames) { byNames = new Map(); priceCache.set(st, byNames); }
  const done = byNames.get(id);
  if (done) return done;
  const { tokens, basis } = st;
  const nameKeys = names.filter(usableName).map((n) => keyOf(n).split(' ')).filter((k) => k[0]);
  const nameAtTok = (k: number) => nameKeys.some((nk) => nk.every((w, j) => tokens[k + j]?.w === w));
  const isUpper = (k: number) => /^\p{Lu}/u.test(tokens[k]!.raw), isLower = (k: number) => /^\p{Ll}/u.test(tokens[k]!.raw);
  const bareNumber = (k: number) => /^\p{N}[\p{N},.]*$/u.test(tokens[k]!.w);
  /** Where a unit or base stops: punctuation, another amount, a joining or verb word, a bare number (after its first word),
   * a capitalised word after a lower-case one, or a listed offer's name. */
  const stopsAt = (k: number, first: boolean) => STOP_WORDS.has(tokens[k]!.w) || amountStarts.has(k) || gapBreaks(k - 1, k) || (!first && bareNumber(k))
    || (k > 0 && isUpper(k) && isLower(k - 1)) || nameAtTok(k);
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
  // Helpers over the gaps between words: punctuation breaks an expression; an apostrophe joins one word ("month's").
  const amountStarts = new Set<number>(amounts.map((a) => a.ts));
  const gapBreaks = (a: number, b: number) => /[.,;:!?()[\]|\n•❝]/.test(basis.slice(tokens[a]!.e, tokens[b]!.s));
  const joined = (a: number, b: number) => /^['’]$/.test(basis.slice(tokens[a]!.e, tokens[b]!.s));
  const expressions: PriceExpression[] = [];
  const byLine = new Map<number, PriceExpression[]>();
  const byUnit = new Map<Unit, PriceExpression[]>();
  const competitorUnits = new Map<Unit, boolean>();
  for (const g of groups) {
    let ts = g[0]!.ts, te = g[g.length - 1]!.te;
    const percent = g.some((a) => a.percent);
    // "£49 99 /mo": pence written apart (a bare one- or two-digit number straight after the amount): unsure.
    const splitPence = Boolean(tokens[te]) && /^\p{N}{1,2}$/u.test(tokens[te]!.w) && basis.slice(tokens[te - 1]!.e, tokens[te]!.s) === ' ';
    let unsureA = false;
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
      // "per square metre", "per 1,000 words", "per walk": after per/each/every, the next one to three words (see `stopsAt`).
      // "a"/"an" opens a unit only for a single lower-case word that ends the sentence ("£2 a window."); otherwise unsure.
      if (link && !gapBreaks(te - 1, te)) {
        if (next.w === 'a' || next.w === 'an') {
          const w = te + 1;
          if (tokens[w] && isLower(w) && !stopsAt(w, false) && (!tokens[w + 1] || gapBreaks(w, w + 1) || st.tokenLine[w + 1] !== st.tokenLine[w])) { te = w + 1; changed = true; continue; }
          unsureA = true; break;
        }
        let k = te + 1, taken = 0;
        while (taken < 3 && k < tokens.length && !stopsAt(k, taken === 0) && /[\p{L}\p{N}]/u.test(tokens[k]!.w)) { k++; taken++; while (k < tokens.length && joined(k - 1, k)) k++; }
        if (taken) { te = k; changed = true; continue; }
      }
      if (next.w === 'for' && tokens[te + 1]?.w === 'your' && tokens[te + 2]?.w === 'first' && tokens[te + 4] && PERIODS.has(tokens[te + 4]!.w)) { te += 5; changed = true; continue; }
      const after = AFTER.find((q) => seq(tokens, te, q));
      if (after) { te += after.length; changed = true; continue; }
      if (percent && !based && next.w === 'of') {
        // A percentage's base: up to four words after "of", one of them naming what it is a percentage of.
        let k = te + 1, words = 0;
        while (words < 4 && k < tokens.length && !stopsAt(k, false) && /\p{L}/u.test(tokens[k]!.w)) { k++; words++; while (k < tokens.length && joined(k - 1, k)) k++; }
        // Never ending on "of", "the", "a": "2% of the purchase price of the property" is "2% of the purchase price".
        while (k > te + 1 && BASE_TAIL.has(tokens[k - 1]!.w)) k--;
        let hasBase = false;
        for (let j = te + 1; j < k; j++) if (BASES.has(tokens[j]!.w)) hasBase = true;
        if (hasBase) { te = k; changed = true; based = true; continue; }
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
      never: Boolean(competitor) || saving || (percent && !based) || Boolean(u?.quoted) || st.lines[st.tokenLine[g[0]!.ts]!]!.kind === 'quoted' || splitPence || unsureA, subject, hold,
      endsClean: !tokens[te] || (u ? tokens[te]!.s >= u.e : false) || /[.,;:!?()|\n]/.test(basis.slice(e, tokens[te]!.s)), ...(splitPence || unsureA ? { unsure: true } : {}) };
    expressions.push(x);
    const list = byLine.get(x.line); if (list) list.push(x); else byLine.set(x.line, [x]);
    if (u) { const ul = byUnit.get(u); if (ul) ul.push(x); else byUnit.set(u, [x]); }
  }
  const view = { expressions, byLine, byUnit };
  byNames.set(id, view);
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

/** Where an offer's name begins a line, or a table cell. */
interface Anchor { readonly offer: number; readonly line: number; readonly s: number; readonly end: number }

/** The cells of a table row: [start, end) positions of each cell's words. */
function rowCells(st: Structure, line: Line): [number, number][] {
  const out: [number, number][] = [];
  let at = line.contentStart;
  const text = st.basis;
  while (at <= line.e) {
    const bar = text.indexOf(' | ', at);
    const end = bar === -1 || bar >= line.e ? line.e : bar;
    out.push([at, end]);
    if (end === line.e) break;
    at = end + 3;
  }
  return out;
}

/** A name's key without a leading "the", when more words follow (the price rule reads "The Deal Desk" and "Deal Desk" alike). */
const withoutThe = (key: string) => (/^the \S/.test(key) ? key.slice(4) : key);

/** The first token on line `i` (binary search over token positions). */
function firstTokenOfLine(st: Structure, i: number): number {
  const pos = st.lines[i]!.s;
  let lo = 0, hi = st.tokens.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (st.tokens[mid]!.s < pos) lo = mid + 1; else hi = mid; }
  return lo;
}

/** The offer (longest name) whose name begins the words from `pos`, or -1. */
function nameAt(st: Structure, pos: number, end: number, names: readonly string[], keys: readonly string[][]): number {
  // The first words from `pos`, read from the document's own tokens (no re-tokenising per line).
  let lo = 0, hi = st.tokens.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (st.tokens[mid]!.s < pos) lo = mid + 1; else hi = mid; }
  const first: string[] = [];
  for (let t = lo; t < st.tokens.length && first.length < OFFER_NAME_WORDS && st.tokens[t]!.e <= Math.min(end, pos + 400); t++) first.push(st.tokens[t]!.w);
  let best = -1;
  // A leading "the" is optional on either side ("The Deal Desk" begins a line "Deal Desk £47").
  const skip = first[0] === 'the' ? 1 : 0;
  keys.forEach((k, i) => { if (k.length && usableName(names[i]!) && (k.every((w, j) => first[j] === w) || k.every((w, j) => first[j + skip] === w)) && (best < 0 || k.length > keys[best]!.length)) best = i; });
  return best;
}

/** A short line that looks like the next card's name: no sentence punctuation, not just price words, an amount on it or within two lines. */
function cardLabel(st: Structure, view: PriceView, i: number): boolean {
  const l = st.lines[i]!;
  const content = st.basis.slice(l.contentStart, l.e).trim();
  if (!content || content.length >= 60 || /[.!?]/.test(content) || !/\p{L}/u.test(content)) return false;
  const own = view.byLine.get(i);
  const label = own?.length ? st.basis.slice(l.contentStart, own[0]!.s) : content;
  const words = tokenize(label).map((t) => t.w).filter((w) => /\p{L}/u.test(w));
  if (!words.length || words.every((w) => PRICE_LABEL_WORDS.has(w))) return false;
  // "Webinar price: £997", "Founders' price £47 a month": a label ending in a colon, or naming a special offer, introduces a
  // price; it is not the next card's name.
  if (own?.length && (/:\s*$/u.test(label) || SPECIAL.test(label))) return false;
  return Boolean(own?.length || view.byLine.get(i + 1)?.length || view.byLine.get(i + 2)?.length);
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

/** What the price rule found for one offer in one document, and how. */
export interface PriceReading {
  readonly candidates: readonly PriceExpression[];
  /** 'run': from the offer's own card or row; 'prose': one sentence naming the offer and one price; 'none'. */
  readonly via: 'run' | 'prose' | 'none';
  /** The page writes prices above names. */
  readonly pricesAbove: boolean;
  /** For each candidate (by key), the line its offer's name began. */
  readonly anchorLine: ReadonlyMap<string, number>;
  /** Every amount the offer's own run (or sentence) holds was a candidate: none was set aside as a saving, deposit, bare percentage or other. */
  readonly onlyAmounts?: boolean;
  /** Every candidate occurrence in page order, with the line its offer's name began (the same amount may occur more than once). */
  readonly all?: readonly { readonly x: PriceExpression; readonly anchorLine: number }[];
  /** The lines of the offer's own run(s), in order. */
  readonly runLines?: readonly number[];
}

/** Names, keys and anchors of one document for one offer list, built once per check. */
interface Anchors {
  readonly done: Map<number, PriceReading>; readonly structures: Map<number, StructuredPrice[]>; readonly nameKeys: readonly string[]; readonly anchors: readonly Anchor[]; readonly isAnchor: ReadonlySet<number>;
  readonly unitOffers: ReadonlyMap<Unit, ReadonlySet<number>>; readonly hits: readonly [number, number][][]; readonly pricesAbove: boolean;
}
const anchorCache = new WeakMap<Structure, Map<string, Anchors>>();
function anchorsFor(st: Structure, names: readonly string[]): Anchors {
  const id = JSON.stringify(names);
  let byNames = anchorCache.get(st);
  if (!byNames) { byNames = new Map(); anchorCache.set(st, byNames); }
  const done = byNames.get(id);
  if (done) return done;
  const keys = names.map((n) => (usableName(n) ? withoutThe(keyOf(n)).split(' ') : []));
  const anchors: Anchor[] = [];
  const isAnchor = new Set<number>();
  // A table row is structure even on a page of one line; any other line begins an offer only on a page of several lines.
  st.lines.forEach((l, i) => {
    if (l.kind === 'quoted' || l.kind === 'action' || !l.text.trim()) return;
    if (l.kind !== 'row' && st.lines.length < 2) return;
    if (l.kind === 'row') {
      // Each cell may begin an offer's name; its run is the cells up to the next cell that does ("name | price | name | price").
      const cells = rowCells(st, l), found: [number, number][] = [];
      cells.forEach(([cs, ce]) => { const o = nameAt(st, cs, ce, names, keys); if (o >= 0) found.push([o, cs]); });
      found.forEach(([o, cs], k) => anchors.push({ offer: o, line: i, s: cs, end: found[k + 1]?.[1] ?? l.e }));
      if (found.length) isAnchor.add(i);
      return;
    }
    const o = nameAt(st, l.contentStart, l.e, names, keys);
    if (o >= 0) { anchors.push({ offer: o, line: i, s: l.s, end: -1 }); isAnchor.add(i); }
  });
  // Prices written above their names: the line just before the first offer's line is only a price.
  let first = -1;
  for (const i of isAnchor) if (first < 0 || i < first) first = i;
  const view = priceView(st, names);
  let prev = first - 1; while (prev >= 0 && !st.lines[prev]!.text.trim()) prev--;
  const pricesAbove = first >= 0 && prev >= 0 && amountOnly(st, view, prev);
  // Which offers each sentence names, once, for the prose fallback.
  const hits = names.map((n) => (usableName(n) ? nameHits(st, withoutThe(keyOf(n))) : []));
  const unitOffers = new Map<Unit, Set<number>>();
  hits.forEach((hs, i) => { for (const [a] of hs) { const u = unitOfToken(st, a); if (u) { const set = unitOffers.get(u); if (set) set.add(i); else unitOffers.set(u, new Set([i])); } } });
  const result: Anchors = { done: new Map(), structures: new Map(), nameKeys: keys.map((k) => k.join(' ')), anchors, isAnchor, unitOffers, hits, pricesAbove };
  byNames.set(id, result);
  return result;
}

/**
 * THE PRICE RULE. The distinct full price expressions written for offer `self` (an index into `names`, the model's own
 * offer list) in one document, tied by the page's structure, never by "the nearest amount":
 *   - an ANCHOR is a line that the offer's name begins (heading, list item, paragraph), or a table cell it begins, the
 *     longest name winning; a mention inside prose is not an anchor;
 *   - its RUN is the anchor line onwards, stopping before: another offer's anchor; a heading (unless it is a deeper
 *     sub-heading straight under the offer's own heading, with no price before it); once a price has been found, a short
 *     label line that is followed within two lines by an amount (the next card); 12 lines or 600 characters. For a table
 *     cell, the run is that cell up to the next cell that begins another offer's name;
 *   - every money amount, and every percentage with a base, in the run is a candidate, except: a competitor sentence, a
 *     saving or value ("save", "worth", "off", "discount"), a deposit or minimum (unless the offer's own name says so),
 *     a percentage with no base, and customer words.
 * With no anchor (and always on a page stored as one line), the only rule is the prose fallback: one sentence that holds
 * the offer's name, then exactly one candidate amount, and no other offer the model named. A price written above its name
 * is never tied.
 */
export function priceReading(doc: { readonly text?: string | null }, names: readonly string[], self: number): PriceReading {
  const st = structureOfDoc(doc);
  const name = names[self] ?? '';
  if (!usableName(name)) return { candidates: [], via: 'none', pricesAbove: false, anchorLine: new Map() };
  const anchors = anchorsFor(st, names);
  const known = anchors.done.get(self);
  if (known) return known;
  const result = readPrices(st, anchors, names, self);
  anchors.done.set(self, result);
  return result;
}
export function priceCandidates(doc: { readonly text?: string | null }, names: readonly string[], self: number): PriceExpression[] {
  return [...priceReading(doc, names, self).candidates];
}

function readPrices(st: Structure, anchors: Anchors, names: readonly string[], self: number): PriceReading {
  const view = priceView(st, names), name = names[self]!;
  let noPrice = false;
  const { nameKeys, isAnchor, unitOffers, hits, pricesAbove } = anchors;
  const selfKey = nameKeys[self] ?? keyOf(name);
  const found = new Map<string, PriceExpression>();
  const anchorLine = new Map<string, number>();
  const all: { x: PriceExpression; anchorLine: number }[] = [];
  const runLines: number[] = [];
  const inAll = new Set<PriceExpression>();
  const add = (x: PriceExpression, line: number) => {
    if (!inAll.has(x)) { inAll.add(x); all.push({ x, anchorLine: line }); }
    if (!found.has(x.key)) { found.set(x.key, x); anchorLine.set(x.key, line); }
  };
  let setAside = 0;
  const mine = anchors.anchors.filter((a) => a.offer === self);
  /** Action text (a button, a form) names this offer: its amounts after the name are this offer's. */
  const selfWords = selfKey.split(' ');
  const namesSelf = (i: number) => {
    const l = st.lines[i]!;
    for (let t = firstTokenOfLine(st, i); t < st.tokens.length && st.tokenLine[t] === i; t++) if (selfWords.every((w, j) => st.tokens[t + j]?.w === w && st.tokenLine[t + j] === i)) return st.tokens[t]!.s;
    return l.e + 1;
  };
  for (const a of mine) {
    const start = st.lines[a.line]!;
    if (start.kind === 'row') {
      for (const x of view.byLine.get(a.line) ?? []) if (x.s >= a.s && x.s < a.end) { if (candidateFor(x, selfKey)) add(x, a.line); else setAside++; }
      if (NO_PRICE.test(st.basis.slice(a.s, a.end))) noPrice = true;
      runLines.push(a.line);
      continue;
    }
    const level = start.kind === 'heading' ? lineKind(start.text).level : 0;
    let have = false;
    for (let i = a.line; i < st.lines.length; i++) {
      const l = st.lines[i]!;
      // Action text inside the run counts only when it names this offer, or sits in the card of this offer's own heading.
      if (i > a.line && l.kind === 'action') {
        if (i - a.line >= RUN_LINES || l.e - start.s > RUN_CHARS) break;
        const at = namesSelf(i), inCard = level > 0 && lineKind(l.text).level === 1;
        runLines.push(i);
        for (const x of view.byLine.get(i) ?? []) if (x.s >= (inCard ? l.s : at)) { if (candidateFor(x, selfKey)) { add(x, a.line); have = true; } else setAside++; }
        continue;
      }
      if (i > a.line) {
        if (i - a.line >= RUN_LINES || l.e - start.s > RUN_CHARS || isAnchor.has(i)) break;
        // A tagline or a deeper sub-heading is allowed only on the line straight under the name; after that a heading or the
        // next card's label ends the run, whether or not a price was found.
        const under = i === a.line + 1;
        if (l.kind === 'heading' && !(under && level && lineKind(l.text).level > level && !have)) break;
        if ((have || !under) && l.kind !== 'heading' && cardLabel(st, view, i)) break;
        // A line that is only a price, straight above a heading or another offer's line, belongs to what follows (a layout
        // with prices above names): it is tied to neither.
        if (pricesAbove && amountOnly(st, view, i) && nextIsCard(st, i, isAnchor)) continue;
      }
      runLines.push(i);
      for (const x of view.byLine.get(i) ?? []) if (x.s >= start.s) { if (candidateFor(x, selfKey)) { add(x, a.line); have = true; } else setAside++; }
      if (NO_PRICE.test(st.basis.slice(Math.max(l.s, start.s), l.e))) noPrice = true;
    }
  }
  // Action text anywhere that names this offer ("Get The Deal Desk: £47"): its amounts after the name are this offer's.
  for (const [h] of hits[self] ?? []) {
    const li = st.tokenLine[h]!;
    if (st.lines[li]!.kind !== 'action' || runLines.includes(li)) continue;
    runLines.push(li);
    for (const x of view.byLine.get(li) ?? []) if (x.ts >= h) { if (candidateFor(x, selfKey)) add(x, li); else setAside++; }
  }
  // "Price on request" in the offer's own card: it has no written price.
  if ((mine.length || found.size) && noPrice) return { candidates: [], via: 'none', pricesAbove, anchorLine: new Map(), onlyAmounts: false, runLines };
  if (mine.length || found.size) return { candidates: [...found.values()], via: found.size ? 'run' : 'none', pricesAbove, anchorLine, onlyAmounts: setAside === 0, all, runLines };
  // Prose fallback.
  for (const [h] of hits[self] ?? []) {
    const u = unitOfToken(st, h);
    if (!u || u.quoted) continue;
    const cands = (view.byUnit.get(u) ?? []).filter((x) => candidateFor(x, selfKey));
    if (cands.length !== 1 || cands[0]!.ts < h) continue;
    let other = false;
    for (const o of unitOffers.get(u) ?? []) if (o !== self && nameKeys[o] !== selfKey) { other = true; break; }
    if (other) continue;
    add(cands[0]!, u.line);
    if ((view.byUnit.get(u) ?? []).length !== 1) setAside++;
  }
  return found.size === 1 ? { candidates: [...found.values()], via: 'prose', pricesAbove, anchorLine, onlyAmounts: setAside === 0, all, runLines: [...new Set(all.map((o) => o.x.line))] } : { candidates: [], via: 'none', pricesAbove, anchorLine: new Map() };
}

export type PriceStatus = 'tied' | 'ambiguous' | 'untied';
/**
 * The model's price against the page's price structure for the offer: 'ambiguous' only on a real contradiction (see
 * `priceContradiction`); 'tied' when it is one of the structure's own lines (its standard price, or a special, or a plan
 * amount: the card then shows the whole structure, with the standard price as the price); otherwise 'untied'.
 * `hint` is the page's standard price to show the owner when the model's differs: only when the structure has exactly one
 * standard line, the run set nothing aside, nothing unread trails it, and the page does not put prices above names.
 */
export function priceStatus(price: string, doc: { readonly text?: string | null }, names: readonly string[], self: number): { status: PriceStatus; page: readonly PriceExpression[]; hint: string | null } {
  const r = priceReading(doc, names, self);
  const lines = priceStructure(doc, names, self);
  const clash = priceContradiction(lines);
  const page = r.candidates;
  if (clash) {
    const keys = new Set(clash.lines.map((l) => l.text));
    return { status: 'ambiguous', page: page.filter((x) => keys.has(x.text) || clash.lines.some((l) => l.text.endsWith(x.text))), hint: null };
  }
  const standard = lines.filter((l) => l.role === 'standard');
  const sole = standard.length === 1 ? page.find((x) => x.text === standard[0]!.text || x.text.endsWith(standard[0]!.text)) : undefined;
  const hint = r.via !== 'none' && r.onlyAmounts === true && sole && sole.endsClean && !r.pricesAbove ? standard[0]!.text : null;
  const k = keyOf(price);
  const tied = k.length > 0 && (lines.some((l) => keyOf(l.text) === k) || page.some((x) => x.key === k && lines.some((l) => l.amount === amountOfText(x.text))));
  return { status: tied ? 'tied' : 'untied', page, hint };
}
const amountOfText = (t: string) => { const m = /([£$€¥])\s?(\d[\d,]*(?:\.\d+)?)|(\d[\d,]*(?:\.\d+)?)\s?(?:%|per\s?cent)/iu.exec(t); return m ? (m[1] ? `${m[1]}${m[2]!.replace(/,/g, '')}` : `${m[3]!.replace(/,/g, '')}%`) : ''; };

/** The lines the price rule used for an offer's price: its name's line and the price's line (one line when they are the same). */
export function priceLines(doc: { readonly text?: string | null }, names: readonly string[], self: number, price: string): string | null {
  const r = priceReading(doc, names, self);
  const x = r.candidates.find((c) => c.key === keyOf(price));
  if (!x) return null;
  const st = structureOfDoc(doc);
  const line = (i: number) => withoutMarkers(st.lines[i]!.text).trim();
  const a = r.anchorLine.get(x.key) ?? x.line;
  return a === x.line ? line(a) : `${line(a)} … ${line(x.line)}`;
}

// ─── 5b. A price structure: standard, instalments, special offers, free ─────

export type PriceRole = 'standard' | 'plan' | 'special' | 'free';
/** One line of an offer's price structure, copied from the page; its role is given by rule. */
export interface StructuredPrice {
  readonly role: PriceRole;
  /** The page's own words: the price expression ("£1,497 once"), or the instalments ("3 x £525"), or "free". */
  readonly text: string;
  /** The amount compared (the instalment amount for a plan), e.g. "£1497" or "12%"; "" for free. */
  readonly amount: string;
  /** month, year, week… or "" when none is written (a one-off price). */
  readonly period: string;
  /** For a plan: the number of payments. */
  readonly count: number | null;
  /** For a special: the page's own words that make it special ("Webinar price", "for the first 100"). */
  readonly condition: string | null;
  /** For a plan: its total as the page writes it ("£1,575 in total"). */
  readonly total: string | null;
  /** For a plan: the index (in the same list) of the price it pays. */
  readonly parent: number | null;
  /** The page lines it came from: the offer's name line and its own line ("Name … line"), markers off. */
  readonly quote: string;
  readonly line: number;
  /** A standard amount that is an extra charge beside the price ("a £199 setup fee"): the owner is asked, as before. */
  readonly extra?: boolean;
}

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, eighteen: 18, twenty: 20, 'twenty-four': 24, 'thirty-six': 36 };
const COUNT = String.raw`(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|eighteen|twenty|twenty-four|thirty-six)`;
const PLAN_BEFORE = new RegExp(String.raw`\b${COUNT}\s*[x×]\s*$|\b${COUNT}\s+(?:(?:equal|monthly|weekly|quarterly|annual|yearly|interest-free)\s+){0,2}(?:payments|instalments|installments)\s+of\s*$`, 'iu');
const PLAN_AFTER = new RegExp(String.raw`^\s*[x×]\s*${COUNT}\b`, 'iu');
const TOTAL_AFTER = /^\s*\)?\s*(?:in total|total)\b/iu;
const TOTAL_BEFORE = /(?:\btotal(?: of| cost| price)?\s*:?|\bin total\s*:?)\s*\(?\s*$|\(\s*$/iu;
/** Another offer's price mentioned as a credit or reference: never this offer's price. */
const CREDIT = /\bcredit(?:s|ed)?\b|\bagainst\b|\btowards\b|\bdeducted\b|\boff your\b|\bcourse price\b/iu;
const DATE_WORD = String.raw`(?:\p{N}|(?:mon|tues|wednes|thurs|fri|satur|sun)day|midnight|the end|january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)`;
const SPECIAL = new RegExp(String.raw`\bwebinar\b|\bfound(?:er|ers|ing)\b|\bfounders['’]|\bearly[- ]bird\b|\blaunch (?:price|offer|special|discount|rate)\b|\bintro(?:ductory)? (?:price|offer|rate|discount)\b|\bintroductory\b|\bspecial (?:price|offer|rate|deal)\b|\boffer (?:price|ends|code)\b|\b(?:special|limited|launch|introductory|exclusive|this) offer\b|\bsale price\b|\bin the sale\b|\bpromo(?:tion|tional)?\b|\blimited (?:time|offer|places|period|availability)\b|\bfor the first \p{N}+|\bfirst \p{N}+ (?:members|customers|places|people|clients|students|landlords)\b|\bfor (?:\p{N}+|one|two|three|four|five|six|seven|ten|fourteen|thirty) (?:days|weeks|months)\b|\b(?:until|ends?|before) ${DATE_WORD}|\bif you join within\b|\binstead of\b`, 'iu');
/** An extra charge beside a price, not another way to pay it. */
const EXTRA_FEE = /\b(?:set-?up|joining|admin(?:istration)?|arrangement|booking|registration|application|onboarding|enrolment|enrollment)\s+fee\b|\bplus an?\b/iu;
const FREE = /\bfree\b|\bno charge\b|£\s?0(?![\d.,])/iu;
const periodOf = (x: PriceExpression) => { for (const w of x.key.split(' ')) { if (PERIODS.has(w)) return w.replace(/s$/, ''); if (w === 'pcm' || w === 'pm') return 'month'; if (w === 'pa') return 'year'; if (w === 'pw') return 'week'; } return ''; };
const amountOf = (x: PriceExpression) => { const m = /([£$€¥])\s?(\d[\d,]*(?:\.\d+)?)|(\d[\d,]*(?:\.\d+)?)\s?(?:%|per\s?cent)/iu.exec(x.text); return m ? (m[1] ? `${m[1]}${m[2]!.replace(/,/g, '')}` : `${m[3]!.replace(/,/g, '')}%`) : x.key; };
const countOf = (w: string) => /^\d+$/.test(w) ? Number(w) : NUMBER_WORDS[w.toLowerCase()] ?? null;

/** The clause of the expression's sentence: between commas, semicolons, brackets, spaced dashes, " or " and table cells. */
function clauseAround(st: Structure, x: PriceExpression): { s: number; e: number } {
  const u = x.unit, from = Math.max(u?.s ?? st.lines[x.line]!.contentStart, x.s - 300), to = Math.min(u?.e ?? st.lines[x.line]!.e, x.e + 300);
  const text = st.basis;
  const before = text.slice(from, x.s), after = text.slice(x.e, to);
  const B = /[,;()|]|\s[–—-]\s|\bor\b/giu;
  let s = from;
  for (const m of before.matchAll(B)) s = from + m.index! + m[0].length;
  const am = /[,;()|]|\s[–—-]\s|\bor\b/iu.exec(after);
  return { s, e: am ? x.e + am.index! : to };
}
/** "Webinar price: £997": the words before a colon that starts the line or cell, when the expression follows it. */
function labelBefore(st: Structure, x: PriceExpression): string | null {
  const l = st.lines[x.line]!;
  const lead = st.basis.slice(Math.max(l.contentStart, x.s - 200), x.s), bar = lead.lastIndexOf(' | ');
  const head = bar >= 0 ? lead.slice(bar + 3) : lead, colon = head.lastIndexOf(':');
  if (colon < 0) return null;
  const label = head.slice(0, colon).trim();
  return label && label.split(/\s+/).length <= 6 && /\p{L}/u.test(label) ? label : null;
}
const trimClause = (t: string) => t.replace(/^[\s,;:–—-]*(?:or|and|with)?\s*/iu, '').replace(/[\s,;:–—-]+$/u, '').trim();

/**
 * THE PRICE STRUCTURE of one offer in one document, from the same own run(s) as the price rule. Each candidate is given a
 * role by rule, never by the model: a credit or cross-reference ("The £997 credits in full against …", or an amount beside
 * another listed offer's name), a plan's total ("(£1,575 in total)") and an "instead of £X" amount are not price lines; a
 * plan is "3 x £525" / "£525 x 3" / "3 monthly payments of £525", belonging to the price stated just before it on its line;
 * a special has a cue (webinar, founders', early bird, launch, introductory, special, offer, sale, promo, limited, for the
 * first N, for N days, until / ends / before a date, if you join within, instead of, now) in its clause or the label before
 * it, or is the only amount of a sentence holding one; "was £X" is standard; everything else is standard. With no amount,
 * a short line of the run that says free / no charge / £0 makes it free.
 */
export function priceStructure(doc: { readonly text?: string | null }, names: readonly string[], self: number): StructuredPrice[] {
  const st = structureOfDoc(doc);
  if (!usableName(names[self] ?? '')) return [];
  const anchors = anchorsFor(st, names);
  const known = anchors.structures.get(self);
  if (known) return known;
  const result = buildStructure(st, doc, names, self);
  anchors.structures.set(self, result);
  return result;
}
function buildStructure(st: Structure, doc: { readonly text?: string | null }, names: readonly string[], self: number): StructuredPrice[] {
  const r = priceReading(doc, names, self);
  const lineText = (i: number) => withoutMarkers(st.lines[i]!.text).trim();
  const quoteFor = (anchor: number, i: number) => (anchor === i ? lineText(i) : `${lineText(anchor)} … ${lineText(i)}`);
  const otherNames = names.map((n, i) => (i !== self && usableName(n) ? keyOf(n) : '')).filter(Boolean);
  const besideOther = (x: PriceExpression) => {
    // Directly beside another listed offer's name on the same line, in the same clause ("The £997 credits against One Lane Mentoring").
    const l = st.lines[x.line]!, c = clauseAround(st, x);
    const after = keyOf(st.basis.slice(x.e, Math.min(l.e, c.e, x.e + 120))), before = keyOf(st.basis.slice(Math.max(l.contentStart, c.s, x.s - 120), x.s));
    return otherNames.some((k) => ` ${after} `.startsWith(` ${k} `) || ` ${before} `.endsWith(` ${k} `));
  };
  const out: StructuredPrice[] = [];
  const occurrences = r.all ?? r.candidates.map((x) => ({ x, anchorLine: r.anchorLine.get(x.key) ?? x.line }));
  // How many prices each sentence holds ("instead of £X" amounts aside), counted once.
  const perUnit = new Map<Unit, number>();
  for (const o of occurrences) if (o.x.unit && !/\binstead of\s*$/iu.test(st.basis.slice(Math.max(0, o.x.s - 20), o.x.s))) perUnit.set(o.x.unit, (perUnit.get(o.x.unit) ?? 0) + 1);
  for (const { x, anchorLine } of occurrences) {
    const c = clauseAround(st, x), clause = st.basis.slice(c.s, c.e);
    const before = st.basis.slice(Math.max(st.lines[x.line]!.contentStart, x.s - 60), x.s), after = st.basis.slice(x.e, Math.min(st.lines[x.line]!.e, x.e + 40));
    if (CREDIT.test(clause) || besideOther(x)) continue;
    if (/\binstead of\s*$/iu.test(before)) continue;
    if (TOTAL_AFTER.test(after) || (TOTAL_BEFORE.test(before) && /total/iu.test(before + after))) {
      for (let k = out.length - 1; k >= 0; k--) {
        const p = out[k]!;
        if (p.role === 'plan' && p.line === x.line && !p.total) {
          const close = /^\s*\)?\s*(?:in total|total)/iu.exec(after);
          out[k] = { ...p, total: close ? `${x.text}${after.slice(0, close[0].length).replace(/^\s*\)?\s*/u, ' ').replace(/\s+$/u, '')}`.replace(/\s+/g, ' ') : x.text };
          break;
        }
      }
      continue;
    }
    const period = periodOf(x), amount = amountOf(x), quote = quoteFor(anchorLine, x.line);
    const pb = PLAN_BEFORE.exec(before), pa = PLAN_AFTER.exec(after);
    if (pb || pa) {
      const count = countOf((pb ? pb[1] ?? pb[2] : pa![1])!);
      const text = pb ? `${before.slice(pb.index).trimStart()}${x.text}` : `${x.text}${after.slice(0, pa![0].length)}`;
      let parent: number | null = null;
      for (let k = out.length - 1; k >= 0; k--) if (out[k]!.role !== 'plan' && out[k]!.line === x.line) { parent = k; break; }
      out.push({ role: 'plan', text: text.replace(/\s+/g, ' ').trim(), amount, period: period || 'month', count, condition: null, total: null, parent, quote, line: x.line });
      continue;
    }
    const label = labelBefore(st, x);
    const unitOnly = x.unit ? perUnit.get(x.unit) === 1 : false;
    const was = /^was\b/iu.test(x.text);
    const cue = !was && (SPECIAL.test(clause.replace(x.text, ' ')) || (label !== null && SPECIAL.test(label)) || (unitOnly && x.unit !== null && SPECIAL.test(x.unit.text.replace(x.text, ' ')) && !CREDIT.test(x.unit.text)) || /^now\b/iu.test(x.text));
    if (cue) {
      const own = trimClause(st.basis.slice(c.s, x.s)) || trimClause(st.basis.slice(x.e, c.e));
      // Its condition in the page's words: the label before it; else its own clause; a sentence holding only this price and
      // more than one clause is kept whole; "now £49" needs none.
      const whole = unitOnly && x.unit && /[,;]/u.test(x.unit.text) ? withoutMarkers(x.unit.text) : null;
      const condition = /^now\b/iu.test(x.text) && !(own && SPECIAL.test(own)) ? null
        : label && SPECIAL.test(label) ? label : whole ?? (own && SPECIAL.test(own) ? own : unitOnly && x.unit ? trimClause(withoutMarkers(x.unit.text).replace(x.text, ' ')) : own || label);
      out.push({ role: 'special', text: x.text, amount, period, count: null, condition: condition || null, total: null, parent: null, quote, line: x.line });
      continue;
    }
    out.push({ role: 'standard', text: x.text, amount, period, count: null, condition: null, total: null, parent: null, quote, line: x.line, ...(EXTRA_FEE.test(clause) ? { extra: true } : {}) });
  }
  if (!out.length && r.candidates.length === 0) {
    for (const i of r.runLines ?? []) {
      // A short line (or table cell) of the run that says free.
      const cells = st.lines[i]!.kind === 'row' ? withoutMarkers(st.lines[i]!.text).split(' | ') : [withoutMarkers(st.lines[i]!.text)];
      // (The offer's own name never counts: "Free cheat sheets" is a name; "Available free with an email address" says it.)
      const own = keyOf(names[self] ?? '');
      const words = cells.map((c) => c.trim()).find((c) => keyOf(c) !== own && FREE.test(c) && (c.split(/\s+/).length <= 8 || /^(?:available\s+)?free\b/iu.test(c))) ?? '';
      const m = words ? FREE.exec(words) : null;
      if (m) {
        out.push({ role: 'free', text: m[0], amount: '', period: '', count: null, condition: null, total: null, parent: null, quote: quoteFor((r.runLines ?? [i])[0]!, i), line: i });
        break;
      }
    }
  }
  return out;
}

/** "" (no period written) and "once" are the same period. */
const samePeriod = (a: string, b: string) => (a === 'once' ? '' : a) === (b === 'once' ? '' : b);
const conditionKey = (c: string | null) => keyOf(c ?? '').split(' ').filter((w) => !/\p{N}/u.test(w) && !['£', '$', '€', '%'].includes(w)).join(' ');

/** Two lines that say the same thing (same role and amount; for a plan the same count; for a special, any wording). */
export function samePriceLine(a: Pick<StructuredPrice, 'role' | 'amount' | 'period' | 'count'>, b: Pick<StructuredPrice, 'role' | 'amount' | 'period' | 'count'>): boolean {
  if (a.role !== b.role || a.amount !== b.amount) return false;
  if (a.role === 'plan') return a.count === b.count;
  return samePeriod(a.period, b.period);
}

/**
 * A real contradiction in a price structure (within or across sources): two different amounts with the same role and
 * period (for specials, also the same condition words), or two plans with the same number of payments but different
 * amounts for the same price. Different roles, periods, a plan beside its price and a special beside a standard are not.
 * Returns the contradicting group, or null.
 */
export function priceContradiction<T extends Pick<StructuredPrice, 'role' | 'amount' | 'period' | 'count' | 'condition' | 'parent'> & { readonly extra?: boolean }>(lines: readonly T[]): { role: PriceRole; lines: T[] } | null {
  // An extra charge beside the price ("plus a £199 setup fee"): the owner says how the prices go together.
  const standard = lines.filter((l) => l.role === 'standard');
  if (standard.some((l) => l.extra) && new Set(standard.map((l) => l.amount)).size > 1) return { role: 'standard', lines: standard };
  for (let i = 0; i < lines.length; i++) {
    const a = lines[i]!;
    const group = lines.filter((b) => b.role === a.role && (a.role === 'plan'
      ? b.count === a.count && parentAmount(lines, b) === parentAmount(lines, a)
      : samePeriod(a.period, b.period) && (a.role !== 'special' || conditionKey(a.condition) === conditionKey(b.condition))));
    if (a.role !== 'free' && new Set(group.map((g) => g.amount)).size > 1) return { role: a.role, lines: group };
  }
  return null;
}
const parentAmount = <T extends Pick<StructuredPrice, 'amount' | 'parent'>>(lines: readonly T[], l: T) => (l.parent !== null && lines[l.parent] ? lines[l.parent]!.amount : '');

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
/** Shared hosts where each business has its own subdomain (name.myshopify.com): the full host is the business's own. */
export const SUBDOMAIN_HOSTS = ['github.io', 'wixsite.com', 'carrd.co', 'wordpress.com', 'blogspot.com', 'squarespace.com', 'webflow.io', 'netlify.app', 'vercel.app',
  'pages.dev', 'notion.site', 'weebly.com', 'godaddysites.com', 'square.site', 'company.site', 'mystrikingly.com', 'jimdosite.com', 'site123.me', 'business.site', 'myshopify.com'];
/** Shared hosts where each business has its own path (facebook.com/name): only links under that path are the business's own. */
export const PATH_HOSTS = ['sites.google.com', 'linktr.ee', 'facebook.com', 'instagram.com', 'linkedin.com', 'x.com', 'twitter.com', 'tiktok.com', 'youtube.com', 'etsy.com',
  'ebay.co.uk', 'ebay.com', 'amazon.co.uk', 'checkatrade.com', 'yell.com', 'trustatrader.com', 'mybuilder.com', 'bark.com', 'google.com'];
export const SHARED_HOSTS = [...SUBDOMAIN_HOSTS, ...PATH_HOSTS];
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
const under = (host: string, list: readonly string[]) => list.some((h) => host === h || host.endsWith(`.${h}`));
/** A subdomain-style shared domain itself (myshopify.com, www.myshopify.com): never any one business's own. */
const bareShared = (host: string) => SUBDOMAIN_HOSTS.some((h) => host === h || host === `www.${h}`);
/** A host that can be a business's own by itself: not a path-style shared host, not a bare shared domain. */
const ownable = (host: string) => !under(host, PATH_HOSTS) && !bareShared(host);

/**
 * A link (offer url or conversion page) is kept only when it is https (any letter case), with no user name or password,
 * on the default port, and its host is the business's website host or a subdomain of it, or exactly a host a page was
 * read from. A host written in page text does not count. On a subdomain-style shared host (name.myshopify.com) the
 * link's full host must equal the website's full host. On a path-style shared host (facebook.com/name) the link must
 * also start with the website's own path; a website there with no path allows no links. A bare shared domain is no one's.
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
  if (bareShared(host)) return false;
  if (siteHost && bareShared(siteHost)) return false;
  if (siteHost && under(siteHost, PATH_HOSTS)) {
    const sitePath = site!.pathname.replace(/\/+$/, '');
    if (!sitePath) return false;
    return host === siteHost && (u.pathname === sitePath || u.pathname.startsWith(`${sitePath}/`));
  }
  if (siteHost && under(siteHost, SUBDOMAIN_HOSTS)) return host === siteHost;
  const fromPage = pageHosts.includes(host) && ownable(host);
  if (!siteHost) return fromPage;
  return host === base || host === siteHost || host.endsWith(`.${base}`) || fromPage;
}

/** A conversion-page label is kept when it is a run of words from a sentence that is not customer words and negates nothing; otherwise the link's own path. */
export function linkLabel(label: string, url: string, documents: readonly { readonly text?: string | null }[]): string {
  const k = keyOf(label);
  if (label.length <= 80 && k && documents.some((d) => structureOfDoc(d).units.some((u) => !u.quoted && !u.unreliable && ` ${u.key} `.includes(` ${k} `)))) return label;
  try { const u = new URL(url); return u.pathname && u.pathname !== '/' ? decodeURIComponent(u.pathname) : u.hostname; } catch { return url; }
}
