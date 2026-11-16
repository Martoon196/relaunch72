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

/**
 * Where each position of `text` lands in `basisText(text)`: an exact map (index i of the text, at a code point's start,
 * to its index in the basis; -1 for a removed character), or null when the basis cannot be rebuilt character by character
 * (normalisation joining characters), so no position is certain.
 */
export function basisPositions(text: string): Int32Array | null {
  const map = new Int32Array(text.length + 1).fill(-1);
  let out = '', i = 0;
  for (const ch of text) {
    const piece = INVISIBLE.test(ch) ? '' : FOOTNOTE.test(ch) ? ' ' : ch;
    INVISIBLE.lastIndex = 0; FOOTNOTE.lastIndex = 0;
    if (piece) map[i] = out.length;
    out += piece.normalize('NFKC');
    i += ch.length;
  }
  map[text.length] = out.length;
  return out === basisText(text) ? map : null;
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
const MARKERS: [string, LineKind][] = [['• ', 'item'], ['| ', 'row'], ['❝ ', 'quoted']];
/** The kind of a stored line, where its words start, and for a heading its level (1 to 6, from "# " to "###### "). */
export function lineKind(line: string): { kind: LineKind; start: number; level: number } {
  const h = /^(#{1,6}) /.exec(line);
  if (h) return { kind: 'heading', start: h[0].length, level: h[1]!.length };
  for (const [m, kind] of MARKERS) if (line.startsWith(m)) return { kind, start: m.length, level: 0 };
  return { kind: 'para', start: 0, level: 0 };
}
/**
 * Which lines of a website page were wholly a button, a button-styled link or a form label is recorded beside its text
 * (`origin.actionLines`), never in it: every rule reads exactly the words 8eca59d stored, and only the price-structure
 * check uses those line numbers (`CheckDocument.actionLines`).
 */

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
  return st.units.find((u) => !u.quoted && !u.unreliable && !u.tooLong && !QUOTE_MARKS.test(u.text) && ` ${u.key} `.includes(` ${k} `) && !soonInClause(u.text, k)
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
    if (line.kind === 'quoted') return false;
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

/** The offer (longest name) whose name begins the words from `pos`, or -1. */
function nameAt(st: Structure, pos: number, end: number, names: readonly string[], keys: readonly string[][]): number {
  const first = tokenize(st.basis.slice(pos, Math.min(end, pos + 400))).slice(0, OFFER_NAME_WORDS).map((t) => t.w);
  let best = -1;
  keys.forEach((k, i) => { if (k.length && usableName(names[i]!) && k.every((w, j) => first[j] === w) && (best < 0 || k.length > keys[best]!.length)) best = i; });
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
  return Boolean(own?.length || view.byLine.get(i + 1)?.length || view.byLine.get(i + 2)?.length);
}

const RUN_LINES = 12, RUN_CHARS = 600;
/** The structure check reads at most this many anchors and candidate occurrences per offer per document. */
const ANCHOR_CAP = 50, OCCURRENCE_CAP = 200;
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
  /** For the structure check only (never read by the rule above): every candidate occurrence of the run(s) in page order. */
  readonly all?: readonly { readonly x: PriceExpression; readonly anchorLine: number }[];
  /** More anchors or candidates than the structure check reads (it then refuses). */
  readonly capped?: boolean;
}

/** Names, keys and anchors of one document for one offer list, built once per check. */
interface Anchors {
  readonly done: Map<number, PriceReading>; readonly nameKeys: readonly string[]; readonly anchors: readonly Anchor[]; readonly isAnchor: ReadonlySet<number>;
  readonly unitOffers: ReadonlyMap<Unit, ReadonlySet<number>>; readonly hits: readonly [number, number][][]; readonly pricesAbove: boolean;
}
const anchorCache = new WeakMap<Structure, Map<string, Anchors>>();
function anchorsFor(st: Structure, names: readonly string[]): Anchors {
  const id = JSON.stringify(names);
  let byNames = anchorCache.get(st);
  if (!byNames) { byNames = new Map(); anchorCache.set(st, byNames); }
  const done = byNames.get(id);
  if (done) return done;
  const keys = names.map((n) => (usableName(n) ? keyOf(n).split(' ') : []));
  const anchors: Anchor[] = [];
  const isAnchor = new Set<number>();
  // A table row is structure even on a page of one line; any other line begins an offer only on a page of several lines.
  st.lines.forEach((l, i) => {
    if (l.kind === 'quoted' || !l.text.trim()) return;
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
  const hits = names.map((n) => (usableName(n) ? nameHits(st, n) : []));
  const unitOffers = new Map<Unit, Set<number>>();
  hits.forEach((hs, i) => { for (const [a] of hs) { const u = unitOfToken(st, a); if (u) { const set = unitOffers.get(u); if (set) set.add(i); else unitOffers.set(u, new Set([i])); } } });
  const result: Anchors = { done: new Map(), nameKeys: keys.map((k) => k.join(' ')), anchors, isAnchor, unitOffers, hits, pricesAbove };
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
  const seen = new Set<PriceExpression>();
  const add = (x: PriceExpression, line: number) => {
    if (!seen.has(x) && all.length <= OCCURRENCE_CAP) { seen.add(x); all.push({ x, anchorLine: line }); }
    if (!found.has(x.key)) { found.set(x.key, x); anchorLine.set(x.key, line); }
  };
  let setAside = 0;
  const mine = anchors.anchors.filter((a) => a.offer === self);
  for (const a of mine) {
    const start = st.lines[a.line]!;
    if (start.kind === 'row') {
      for (const x of view.byLine.get(a.line) ?? []) if (x.s >= a.s && x.s < a.end) { if (candidateFor(x, selfKey)) add(x, a.line); else setAside++; }
      if (NO_PRICE.test(st.basis.slice(a.s, a.end))) noPrice = true;
      continue;
    }
    const level = start.kind === 'heading' ? lineKind(start.text).level : 0;
    let have = false;
    for (let i = a.line; i < st.lines.length; i++) {
      const l = st.lines[i]!;
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
      for (const x of view.byLine.get(i) ?? []) if (x.s >= start.s) { if (candidateFor(x, selfKey)) { add(x, a.line); have = true; } else setAside++; }
      if (NO_PRICE.test(st.basis.slice(Math.max(l.s, start.s), l.e))) noPrice = true;
    }
  }
  // "Price on request" in the offer's own card: it has no written price.
  if (mine.length && noPrice) return { candidates: [], via: 'none', pricesAbove, anchorLine: new Map(), onlyAmounts: false };
  if (mine.length) return { candidates: [...found.values()], via: found.size ? 'run' : 'none', pricesAbove, anchorLine, onlyAmounts: setAside === 0, all, capped: mine.length > ANCHOR_CAP || all.length > OCCURRENCE_CAP };
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
  return found.size === 1 ? { candidates: [...found.values()], via: 'prose', pricesAbove, anchorLine, onlyAmounts: setAside === 0, all, capped: false } : { candidates: [], via: 'none', pricesAbove, anchorLine: new Map() };
}

export type PriceStatus = 'tied' | 'ambiguous' | 'untied';
/**
 * The model's price against the page: exactly the one candidate ('tied'), the page gives several ('ambiguous'), or not.
 * `hint` is the page's own expression to show the owner when the model's differs: only when the offer's own card held
 * exactly one candidate and no other amount, nothing unread trails it, and the page does not put prices above names.
 */
export function priceStatus(price: string, doc: { readonly text?: string | null }, names: readonly string[], self: number): { status: PriceStatus; page: readonly PriceExpression[]; hint: string | null } {
  const r = priceReading(doc, names, self);
  const page = r.candidates;
  const hint = r.via !== 'none' && r.onlyAmounts === true && page.length === 1 && page[0]!.endsClean && !r.pricesAbove ? page[0]!.text : null;
  if (page.length > 1) return { status: 'ambiguous', page, hint: null };
  return { status: page.length === 1 && page[0]!.key === keyOf(price) ? 'tied' : 'untied', page, hint };
}

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

// ─── 5b. Checking a price structure the model proposed ───────────────────────
//
// THE PRINCIPLE. The model reading the page proposes an offer's price structure; this code only accepts or refuses it,
// line by line. It never fills a price the model left empty, never adds a line the model did not propose, never chooses
// between amounts and never changes a role. When it cannot accept the whole of an offer's pricing it refuses the
// structure, and the offer is handled exactly by the plain price rule above, as at 8eca59d. Every rule below can only make
// acceptance harder: it starts from exactly the plain rule's reading of the offer's run, and every amount in that reading
// must be accounted for.

/** One line the model proposed. kind 'other': another ordinary price; 'plan': instalments; 'special': a named or limited price. */
export interface ProposedPriceLine { readonly kind: 'other' | 'plan' | 'special'; readonly text: string; readonly label?: string | null; readonly for?: string | null; readonly total?: string | null }
/** A line that passed the check, with where it was read. */
export interface CheckedPriceLine { readonly role: 'other' | 'plan' | 'special'; readonly text: string; readonly label: string | null; readonly total: string | null; readonly for: string | null; readonly documentId: string; readonly quote: string }
/** An accepted structure: its lines, and where the price itself was found (its document and line). */
export interface CheckedPricing {
  readonly lines: readonly CheckedPriceLine[]; readonly priceDocumentId: string; readonly priceQuote: string;
  /** The occurrences ("document:position") inside this offer's own section that the accepted structure accounts for as its
   * price or one of its lines: another offer's check may excuse exactly these (never an equal amount elsewhere). */
  readonly claims?: readonly string[];
  /** The same occurrences by where their first "£" stands ("document:position" in the basis), for the cross-source backstop. */
  readonly claimedAmounts?: readonly string[];
}
/** A document as the structure check reads it: the plain text, and which of its lines were wholly action text on the page. */
export interface CheckDocument { readonly id: string; readonly text?: string | null; readonly actionLines?: readonly number[] }

/** The model's proposal, if it has the right shape (an empty `lines` list is a proposal of the price alone). */
export function proposedLines(raw: unknown): ProposedPriceLine[] | null {
  const lines = (raw as { lines?: unknown } | null | undefined)?.lines;
  if (!Array.isArray(lines) || lines.length > 12) return null;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 300) : null);
  const out: ProposedPriceLine[] = [];
  for (const l of lines) {
    const kind = (l as { kind?: unknown })?.kind, text = str((l as { text?: unknown })?.text);
    if ((kind !== 'other' && kind !== 'plan' && kind !== 'special') || !text) return null;
    out.push({ kind, text, label: str((l as { label?: unknown }).label), for: str((l as { for?: unknown }).for), total: str((l as { total?: unknown }).total) });
  }
  return out;
}

const COUNT_WORD = String.raw`(?:\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|eighteen|twenty|twenty-four|thirty-six)`;
const NUMBER_WORD: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, eighteen: 18, twenty: 20, 'twenty-four': 24, 'thirty-six': 36 };
const PLAN_BEFORE = new RegExp(String.raw`(?:^|[\s(,:])((${COUNT_WORD})\s*[x×]\s*|(${COUNT_WORD})\s+(?:(?:equal|monthly|weekly|quarterly|annual|yearly|interest-free)\s+){0,2}(?:payments|instalments|installments)\s+of\s+)$`, 'iu');
const PLAN_AFTER = new RegExp(String.raw`^\s*[x×]\s*(${COUNT_WORD})\b`, 'iu');
/** After a plan only these may follow in its clause (so "2 x £80 tyres" is a quantity, not instalments). */
const PLAN_NEXT = /^\s*(?:$|[.,;:!?)(\]|]|in total\b|total\b|payments?\b|instalments?\b|installments?\b|or\b|for\b|per month\b|a month\b|each month\b|monthly\b|weekly\b)/iu;
/**
 * Words that say a price is not the ordinary one (whole words; a hyphenated word is one word). STRONG words name an explicit
 * offer or a different kind of charge; WEAK words are ordinary sequence and time words. Where each is read: see checkPricing.
 */
const STRONG_WORDS = ['webinar', 'founder', 'founders', 'founding', 'early bird', 'early-bird', 'launch price', 'introductory', 'intro price', 'sale', 'sale price', 'special offer', 'offer price',
  'black friday', 'cyber monday', 'reduced', 'discount', 'discounted', 'new customers', 'existing customers', 'trial', 'taster', 'set-up', 'setup', 'joining fee', 'booking fee', 'admin fee',
  'registration', 'enrolment', 'enrollment', 'assessment', 'call-out', 'callout', 'day pass', 'deposit', 'attendees'];
// ("only" and "offer" are not cues: "Only £85 or £8 a month", "Our offer: £85 a year or £8 a month" are ordinary prices.)
const WEAK_WORDS = ['first', 'then', 'until', 'ends', 'normally', 'usual', 'usually', 'limited'];
const WORD = /[\p{L}\p{N}]+(?:[-'’][\p{L}\p{N}]+)*/gu;
const hyWords = (t: string) => [...basisText(t).toLowerCase().matchAll(WORD)].map((m) => m[0].replace(/’/g, "'"));
const STRONG_SEQ = STRONG_WORDS.map((w) => hyWords(w)), WEAK_SEQ = WEAK_WORDS.map((w) => hyWords(w));
const hasRun = (hay: readonly string[], needle: readonly string[]) => { if (!needle.length) return false; for (let i = 0; i + needle.length <= hay.length; i++) if (needle.every((w, j) => hay[i + j] === w)) return true; return false; };
/** "was" with an amount after it; "now" when "was" comes before it on the price's line. */
const WAS_AMOUNT = /(?<![\p{L}\p{N}])was(?![\p{L}\p{N}])[^£$€¥\d]{0,40}?(?:[£$€¥]\s?\d|\d[\d,.]*\s?(?:%|per\s?cent))/iu;
const NOW = /(?<![\p{L}\p{N}])now(?![\p{L}\p{N}])/iu, WAS_THEN_NOW = /(?<![\p{L}\p{N}])was(?![\p{L}\p{N}])[\s\S]*(?<![\p{L}\p{N}])now(?![\p{L}\p{N}])/iu;
const strongIn = (t: string, line: string) => { const w = hyWords(t); return STRONG_SEQ.some((v) => hasRun(w, v)) || WAS_AMOUNT.test(basisText(t)) || (NOW.test(t) && WAS_THEN_NOW.test(line)); };
const weakIn = (t: string) => { const w = hyWords(t); return WEAK_SEQ.some((v) => hasRun(w, v)); };
/** A credit or cross-reference: "credits in full", "credited against/towards/to", "deducted". "with credit", "on credit" excuse nothing. */
const CREDIT_WORDS = /(?<!\b(?:with|on|interest-free)\s+)\bcredit(?:s|ed)?\s+(?:in full|against|towards|to)\b|\bdeducted\b/iu;
const LABEL_EMPTY = new Set(['price', 'prices', 'cost', 'costs', 'fee', 'fees', 'a', 'an', 'per', 'each', 'every', 'the', 'month', 'months', 'year', 'years', 'week', 'weeks', 'day', 'days', 'hour', 'hours', 'annum', 'monthly', 'yearly', 'annually', 'weekly']);
const MONEY = /[£$€¥]\s?\d|\d\s?%/u;
const ONCE_TAIL = /\s+(?:once|one-off|one off|only)$/iu;
const priceKey = (t: string) => keyOf(t.replace(ONCE_TAIL, ''));
const periodWord = (x: PriceExpression) => { for (const w of x.key.split(' ')) { if (PERIODS.has(w)) return w.replace(/s$/, ''); if (w === 'pcm' || w === 'pm') return 'month'; if (w === 'pa') return 'year'; } return ''; };
const amountNumber = (t: string) => { const m = /([£$€¥])\s?(\d[\d,]*(?:\.\d+)?)|(\d[\d,]*(?:\.\d+)?)\s?(?:%|per\s?cent)/iu.exec(t); return m ? { cur: m[1] ?? '%', n: Number((m[2] ?? m[3]!).replace(/,/g, '')) } : null; };
const amountKey = (t: string) => { const a = amountNumber(t); return a ? `${a.cur}${a.n}` : ''; };
/** `a` states a larger amount than `b` (same currency, or both percentages; a range by its lower end). */
const dearer = (a: string, b: string) => { const x = amountNumber(a), y = amountNumber(b); return Boolean(x && y && x.cur === y.cur && x.n > y.n); };
/** Words a one-off price's own clause may hold beside its amount. */
const ONE_OFF_WORDS = new Set(['once', 'one-off', 'one', 'off', 'in', 'full', 'from', 'only', 'just', 'or', 'vat', 'inc', 'incl', 'including', 'exc', 'excl', 'excluding', 'ex', 'plus']);
const PRICE_HEADING = /^(?:our\s+)?(?:price|prices|pricing|cost|costs)$/iu;

/** The clause around an amount: between ; ( ) | spaced dashes, " or ", and commas not inside a number. */
const CLAUSE_BREAK = /[;()|]|,(?!\d)|\s[–—-]\s|\bor\b/giu;
const breakCache = new WeakMap<Structure, Map<number, { s: number; e: number }[]>>();
/** The backstop's clause breaks: the structure check's (CLAUSE_BREAK, unchanged), plus sentence ends. */
const CREDIT_CLAUSE_BREAK = /[;()|]|,(?!\d)|\s[–—-]\s|\bor\b|[.!?](?=\s|$)/giu;
const CREDIT_WORDS_ALL = new RegExp(CREDIT_WORDS.source, 'giu');
const CLAUSE_AMOUNT = /[£$€¥]\s?\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s?(?:%|per\s?cent)/giu;
/**
 * The cross-source backstop's credit test (accepted structures only): the amount at [s, e) of one stored line is the amount
 * a credit or cross-reference in its own clause (CREDIT_CLAUSE_BREAK, at most 300 characters either side) is about
 * ("credits in full", "credited against / towards / to", "deducted"; never "with / on / interest-free credit"). Each credit
 * phrase is about the nearest amount before it in the clause, or, with none before it, the nearest amount after it: in
 * "£1,697 with the £47 Deal Desk fee credited against it" only the £47 is.
 */
export function inCreditClause(line: string, s: number, e: number): boolean {
  let cs = Math.max(0, s - 300), ce = Math.min(line.length, e + 300);
  for (const m of line.matchAll(CREDIT_CLAUSE_BREAK)) { const b = m.index!, be = b + m[0].length; if (be <= s) { if (be > cs) cs = be; } else if (b >= e) { if (b < ce) ce = b; break; } }
  const clause = line.slice(cs, ce);
  if (!CREDIT_WORDS.test(clause)) return false;
  const amounts = [...clause.matchAll(CLAUSE_AMOUNT)].map((m) => cs + m.index!);
  for (const c of clause.matchAll(CREDIT_WORDS_ALL)) {
    const at = cs + c.index!, before = amounts.filter((a) => a < at), after = amounts.filter((a) => a > at);
    const about = before.length ? before[before.length - 1] : after[0];
    if (about !== undefined && about >= s && about < e) return true;
  }
  return false;
}
/** Every clause break on a line, found once per line (start and end positions in the basis). */
function breaksOn(st: Structure, line: number): { s: number; e: number }[] {
  let byLine = breakCache.get(st);
  if (!byLine) { byLine = new Map(); breakCache.set(st, byLine); }
  let list = byLine.get(line);
  if (!list) {
    const l = st.lines[line]!;
    list = [...st.basis.slice(l.contentStart, l.e).matchAll(CLAUSE_BREAK)].map((m) => ({ s: l.contentStart + m.index!, e: l.contentStart + m.index! + m[0].length }));
    byLine.set(line, list);
  }
  return list;
}
function clauseOf(st: Structure, x: PriceExpression): { s: number; e: number } {
  const u = x.unit, from = Math.max(u?.s ?? st.lines[x.line]!.contentStart, x.s - 300), to = Math.min(u?.e ?? st.lines[x.line]!.e, x.e + 300);
  const list = breaksOn(st, x.line);
  // The last break ending at or before the amount (within the window), and the first starting at or after its end.
  let lo = 0, hi = list.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid]!.e <= x.s) lo = mid + 1; else hi = mid; }
  let s = from;
  for (let k = lo - 1; k >= 0; k--) { const b = list[k]!; if (b.s >= from) { s = b.e; break; } if (b.e <= from) break; }
  let e = to;
  for (let k = lo; k < list.length; k++) { const b = list[k]!; if (b.s >= x.e) { if (b.s < to) e = b.s; break; } }
  return { s, e };
}
/** The part of a clause inside the amount's own sentence (a full stop, "!" or "?" followed by a space ends a sentence). */
function sentenceClause(st: Structure, x: PriceExpression, c: { s: number; e: number }): { s: number; e: number } {
  let s = c.s, e = c.e;
  for (const m of st.basis.slice(c.s, c.e).matchAll(/[.!?](?=\s|$)/gu)) { const at = c.s + m.index!; if (at < x.s) s = at + 1; else if (at >= x.e) { e = at; break; } }
  return { s, e };
}
/** Clause and sentence breaks, for the part of the words before a colon that is the amount's own label. */
const LABEL_BREAK = /[;()|]|,(?!\d)|\s[–—-]\s|\bor\b|[.!?](?=\s)/iu;
const shortLabel = (t: string) => { const w = t.trim().split(/\s+/).filter(Boolean); return w.length > 0 && w.length <= 6 && !MONEY.test(t); };
/** The words around an amount that may label it, and the words a veto reads. */
function placesOf(st: Structure, x: PriceExpression) {
  const l = st.lines[x.line]!, text = st.basis;
  const lineText = text.slice(l.contentStart, l.e);
  const cells = l.kind === 'row' ? lineText.split(' | ') : null;
  let cellBefore: string | null = null, cellAfter: string | null = null, own = lineText, ownS = l.contentStart, ownE = l.e, cell = -1;
  if (cells) {
    let at = l.contentStart;
    for (let k = 0; k < cells.length; k++) {
      const end = at + cells[k]!.length;
      if (x.s >= at && x.s < end + 1) { own = cells[k]!; ownS = at; ownE = end; cell = k; cellBefore = cells[k - 1] ?? null; cellAfter = cells[k + 1] ?? null; break; }
      at = end + 3;
    }
  }
  const lead = text.slice(Math.max(l.contentStart, x.s - 200), x.s), bar = lead.lastIndexOf(' | ');
  const head = bar >= 0 ? lead.slice(bar + 3) : lead;
  const colon = head.includes(':') ? head.slice(0, head.lastIndexOf(':')) : null;
  const nearAt = (step: number) => { for (let i = x.line + step; i >= 0 && i < st.lines.length; i += step) if (st.lines[i]!.text.trim()) return i; return -1; };
  const aboveAt = nearAt(-1), belowAt = nearAt(1);
  const near = (i: number) => { if (i < 0) return null; const p = st.lines[i]!, t = text.slice(p.contentStart, p.e); return shortLabel(t) ? t : null; };
  const above = near(aboveAt), below = near(belowAt);
  // A heading above is read by the veto, but is never a label ("Price list", "Our prices" name a section, not a price).
  return { own, ownS, ownE, cell, cellBefore, cellAfter, colon, above, below,
    aboveLabel: above !== null && st.lines[aboveAt]!.kind !== 'heading' ? above : null };
}

/** An amount labelled with another listed offer's name: in its clause, before its colon, the cell before it or the short line above. */
function labelledForOther(st: Structure, x: PriceExpression, otherNameWords: readonly (readonly string[])[]): boolean {
  if (!otherNameWords.length) return false;
  const pl = placesOf(st, x), c = clauseOf(st, x);
  return [st.basis.slice(c.s, c.e), pl.colon, pl.cellBefore, pl.aboveLabel].some((t) => t !== null && otherNameWords.some((n) => hasRun(hyWords(t), n)));
}
const otherNameWordsOf = (names: readonly string[], self: number) => names.map((n, i) => (i !== self && usableName(n) ? hyWords(n) : [])).filter((w) => w.length);

const cardKeyCache = new WeakMap<Structure, Map<string, { line: number; s: number; heading: boolean }[]>>();
/** Each heading's and table cell's key, once per page (for the "The" alias of an offer's own card). */
function cardKeys(st: Structure): Map<string, { line: number; s: number; heading: boolean }[]> {
  let m = cardKeyCache.get(st);
  if (m) return m;
  m = new Map();
  const add = (k: string, v: { line: number; s: number; heading: boolean }) => { if (!k) return; const list = m!.get(k); if (list) list.push(v); else m!.set(k, [v]); };
  st.lines.forEach((l, i) => {
    if (l.kind === 'heading') add(keyOf(st.basis.slice(l.contentStart, l.e)), { line: i, s: l.s, heading: true });
    else if (l.kind === 'row') for (const [cs, ce] of rowCells(st, l)) if (ce - cs <= 200) add(keyOf(st.basis.slice(cs, ce)), { line: i, s: cs, heading: false });
  });
  cardKeyCache.set(st, m);
  return m;
}
const headingAboveCache = new WeakMap<Structure, Int32Array>();
/** For each line, the nearest heading line above it (-1 for none), once per page. */
function headingAbove(st: Structure): Int32Array {
  let a = headingAboveCache.get(st);
  if (a) return a;
  a = new Int32Array(st.lines.length);
  let h = -1;
  for (let i = 0; i < st.lines.length; i++) { a[i] = h; if (st.lines[i]!.kind === 'heading') h = i; }
  headingAboveCache.set(st, a);
  return a;
}

/** Own sections: at most this many lines and characters from the anchor. */
const SECTION_LINES = 30, SECTION_CHARS = 1500;
/**
 * The offer's OWN SECTION in one document (read by the structure check only): from each heading, table-row or list-item
 * anchor of the offer to just before the next heading line or the next heading, row or list-item anchor of another listed
 * offer, whichever comes first, at most 30 lines and 1,500 characters; for a table-row anchor, its cells up to the next cell
 * that begins another offer's name (the whole row when it names one offer). Paragraph anchors have no own section.
 * Returns the character spans and every candidate amount in them, in page order.
 */
function ownSection(st: Structure, names: readonly string[], self: number, cited = false): { spans: { s: number; e: number }[]; occs: PriceExpression[]; card: boolean; aliasSpans: { s: number; e: number }[] } {
  const anchors = anchorsFor(st, names), view = priceView(st, names);
  const selfKey = anchors.nameKeys[self] ?? keyOf(names[self] ?? '');
  const otherAt = new Set<number>();
  for (const a of anchors.anchors) if (a.offer !== self && anchors.nameKeys[a.offer] !== selfKey && st.lines[a.line]!.kind !== 'para') otherAt.add(a.line);
  const spans: { s: number; e: number }[] = [];
  const occs: PriceExpression[] = [];
  const seen = new Set<PriceExpression>();
  const take = (i: number, s: number, e: number) => { for (const x of view.byLine.get(i) ?? []) if (x.s >= s && x.s < e && !seen.has(x) && candidateFor(x, selfKey)) { seen.add(x); occs.push(x); } };
  // The offer's own anchors, plus (here only, and on its cited page only) a heading or table-row cell that is exactly its name
  // with or without a leading "The" ("Members' Room" for "The Members' Room"); never a list item or paragraph, never in the
  // plain rule. (On other pages the check reads what it read before.)
  const mine = anchors.anchors.filter((a) => a.offer === self), aliased = new Set<string>(), aliasSpans: { s: number; e: number }[] = [];
  const alias = selfKey.startsWith('the ') ? selfKey.slice(4) : selfKey ? `the ${selfKey}` : '';
  if (cited && alias && usableName(alias)) {
    const at = new Set(mine.map((a) => `${a.line}:${a.s}`));
    for (const c of cardKeys(st).get(alias) ?? []) {
      if (c.heading) { if (!at.has(`${c.line}:${c.s}`)) { mine.push({ offer: self, line: c.line, s: c.s, end: -1 }); aliased.add(`${c.line}:${c.s}`); } continue; }
      const next = anchors.anchors.filter((a) => a.line === c.line && a.s > c.s).map((a) => a.s).sort((p, q) => p - q)[0];
      mine.push({ offer: self, line: c.line, s: c.s, end: next ?? st.lines[c.line]!.e }); aliased.add(`${c.line}:${c.s}`);
    }
    mine.sort((p, q) => p.line - q.line || p.s - q.s);
  }
  // With a heading or row of its own on the page (its own card), a list-item anchor of the offer that sits inside ANOTHER
  // listed offer's heading section ("• The Members' Room founders' price…" inside the course card) is not its own section.
  const card = mine.some((a) => st.lines[a.line]!.kind === 'heading' || st.lines[a.line]!.kind === 'row');
  const otherHeading = new Set(anchors.anchors.filter((a) => a.offer !== self && anchors.nameKeys[a.offer] !== selfKey && st.lines[a.line]!.kind === 'heading').map((a) => a.line));
  const insideOther = (line: number) => { const h = headingAbove(st)[line]!; return h >= 0 && otherHeading.has(h); };
  for (const a of mine) {
    const start = st.lines[a.line]!;
    if (card && start.kind === 'item' && insideOther(a.line)) continue;
    if (start.kind === 'row') { spans.push({ s: a.s, e: a.end }); if (aliased.has(`${a.line}:${a.s}`)) aliasSpans.push({ s: a.s, e: a.end }); take(a.line, a.s, a.end); continue; }
    if (start.kind !== 'heading' && start.kind !== 'item') continue;
    let end = start.e;
    take(a.line, start.s, start.e + 1);
    for (let i = a.line + 1; i < st.lines.length; i++) {
      const l = st.lines[i]!;
      if (i - a.line >= SECTION_LINES || l.e - start.s > SECTION_CHARS || l.kind === 'heading' || otherAt.has(i)) break;
      take(i, l.s, l.e + 1); end = l.e;
    }
    spans.push({ s: start.s, e: end });
    if (aliased.has(`${a.line}:${a.s}`)) aliasSpans.push({ s: start.s, e: end });
    if (occs.length > OCCURRENCE_CAP) break;
  }
  occs.sort((p, q) => p.s - q.s);
  return { spans, occs, card, aliasSpans };
}

/**
 * Check one offer's proposed structure against its own run(s) in every document (the plain rule's reading, unchanged).
 * Returns the accepted structure, or null when it is refused (then the plain rule applies to the offer). Refuses when:
 *   - `price` is not a candidate of the run in its cited document, is not the first amount there, or is directly followed
 *     by "in total". When the offer has its own card on the cited page (a heading or table-row anchor; on that page also a
 *     heading or row that is its name with or without a leading "The"), the first amount is read from its own section only,
 *     and a list item naming it inside another listed offer's heading section is not its own section (its amounts must
 *     still be accounted for);
 *   - the ordinary price is the cheaper one: a special line, or a labelled other line of the same period, states a larger
 *     amount than `price` (same currency, or both percentages; a range by its lower end);
 *   - a one-off `price` stands beside a non-plan line with a period and has a label of its own (words before its colon, a
 *     short label cell before it, a short label line or heading above it that is not the offer's name or just "Price"), or
 *     any word in its own clause besides the amount and once / one-off / in full / from / only / just / VAT words / or;
 *   - the price's own words say it is not the ordinary price. STRONG words (an explicit offer or another kind of charge:
 *     webinar, founder(s)/founding, early bird, launch price, introductory, intro price, sale, special offer, offer price,
 *     Black Friday, Cyber Monday, reduced, discount(ed), new/existing customers, trial, taster, set-up, joining/booking/admin
 *     fee, registration, enrolment, assessment, call-out, day pass, deposit, attendees; "was" with an amount after it; "now"
 *     after "was" on the line) and WEAK words (first, then, until, ends, normally, usual(ly), limited) both
 *     count in the price's OWN clause (cut at its sentence) and OWN label (the words before its colon, a short label cell
 *     before it, a short label line or heading directly above it). STRONG words also count anywhere else on its line (its
 *     cell, in a table row), in the cell after it, in a longer cell before it and on a short label line directly below it,
 *     except inside the clause (cut at its sentence) of another amount on that line or in that cell that the structure
 *     accounts for as a special or a labelled other line. A label line or cell between the price and another amount is never
 *     excepted (it may be the price's own badge);
 *   - a line's text is not a candidate of the run (a plan: an instalment form, not a quantity); a label is not one
 *     unbroken run of whole words from the amount's clause, the words before its colon, the cell before it or the short
 *     line above, or is empty of content, the offer's name, another listed offer's name, or just a price word or period;
 *     an "other" line has no label and does not differ from `price` by period alone, or has no label while a short label
 *     line directly above it or a label cell before it names it; a special has no label;
 *   - a plan has no `for`, or its `for` is not a one-off price or special on the same line, or count × instalment is not
 *     between the parent amount and one and a half times it; a proposed total is not the amount straight after it followed by "in total";
 *   - any candidate of the run is not the price, a proposed line or a checked total, unless it is on a line that was wholly
 *     action text and does not name the offer, or is a credit or cross-reference, or is the very occurrence another
 *     listed offer's accepted check claims;
 *   - two lines of the same kind and period (specials: and label words) give different amounts.
 */
export function checkPricing(documents: readonly CheckDocument[], names: readonly string[], self: number, price: string | null, proposed: readonly ProposedPriceLine[], citedId: string | null,
  othersClaim: ReadonlySet<string> = new Set(), read?: Set<string>): CheckedPricing | null {
  if (!price || !citedId) return null;
  if (/^free$/iu.test(price.trim())) return proposed.length ? null : freeCheck(documents.find((d) => d.id === citedId), names, self);
  // inRun: the plain rule's reading (8eca59d) holds it; mine: it lies in the offer's own section.
  type Occ = { x: PriceExpression; st: Structure; doc: string; action: boolean; i: number; inRun: boolean; mine: boolean };
  const occs: Occ[] = [];
  const byLine = new Map<string, Occ[]>();
  /** Documents where the offer has a card of its own (a heading or table-row anchor). */
  const cardIn = new Set<string>();
  /** Spans of the offer's own card found by its name with or without "The" (item 5): there the price may stand outside the plain run. */
  const aliasAt: { doc: string; s: number; e: number }[] = [];
  const selfKey = keyOf(names[self] ?? '');
  for (const d of documents) {
    const r = priceReading(d, names, self);
    if (r.capped) return null;
    const st = structureOfDoc(d), actions = new Set(d.actionLines ?? []);
    const sec = ownSection(st, names, self, d.id === citedId); if (sec.card) cardIn.add(d.id);
    for (const p of sec.aliasSpans) aliasAt.push({ doc: d.id, ...p });
    const inSection = (x: PriceExpression) => sec.spans.some((p) => x.s >= p.s && x.s < p.e);
    const run = new Set((r.all ?? []).map((o) => o.x));
    // The union of the run and the own section, in page order.
    const xs = [...run, ...sec.occs.filter((x) => !run.has(x))].sort((p, q) => p.s - q.s);
    for (const x of xs) {
      const occ: Occ = { x, st, doc: d.id, action: actions.has(x.line), i: occs.length, inRun: run.has(x), mine: inSection(x) };
      occs.push(occ); read?.add(`${d.id}:${x.s}`);
      const k = `${d.id}:${x.line}`; const list = byLine.get(k); if (list) list.push(occ); else byLine.set(k, [occ]);
    }
    // At most this many amounts across all documents: beyond it the structure is refused (the plain rule applies).
    if (occs.length > OCCURRENCE_CAP) return null;
  }
  const quotes = new Map<string, string>();
  const quoteOf = (o: Occ) => { const k = `${o.doc}:${o.x.line}`; let q = quotes.get(k); if (q === undefined) { q = withoutMarkers(o.st.lines[o.x.line]!.text).trim().slice(0, 300); quotes.set(k, q); } return q; };
  const clauses = new Map<number, { s: number; e: number }>();
  const clauseAt = (o: Occ) => { let c = clauses.get(o.i); if (!c) { c = clauseOf(o.st, o.x); clauses.set(o.i, c); } return c; };
  const clauseText = (o: Occ) => { const c = clauseAt(o); return o.st.basis.slice(c.s, c.e); };
  const otherKeys = names.map((n, i) => (i !== self && usableName(n) ? keyOf(n) : '')).filter(Boolean);
  const namesSelf = (o: Occ) => ` ${keyOf(o.st.basis.slice(o.st.lines[o.x.line]!.contentStart, o.st.lines[o.x.line]!.e))} `.includes(` ${selfKey} `);
  const besideOther = (o: Occ) => {
    const l = o.st.lines[o.x.line]!, c = clauseAt(o);
    const after = ` ${keyOf(o.st.basis.slice(o.x.e, Math.min(l.e, c.e, o.x.e + 120)))} `, before = ` ${keyOf(o.st.basis.slice(Math.max(l.contentStart, c.s, o.x.s - 120), o.x.s))} `;
    return otherKeys.some((k) => after.startsWith(` ${k} `) || before.endsWith(` ${k} `));
  };
  // Excused: action text not naming the offer, a credit or cross-reference, an amount beside another listed offer's name, or
  // the very occurrence another listed offer's accepted check claims in that offer's own section.
  const excuses = new Map<number, boolean>();
  const excused = (o: Occ) => { let v = excuses.get(o.i); if (v === undefined) { v = (o.action && !namesSelf(o)) || CREDIT_WORDS.test(clauseText(o)) || besideOther(o) || othersClaim.has(`${o.doc}:${o.x.s}`); excuses.set(o.i, v); } return v; };
  // The price: the first accounted amount of the run and own section in its cited document, itself in the run.
  const pk = priceKey(price);
  // With its own card (heading or row) on the cited page, the first amount is read from its own section only.
  const cited = occs.filter((o) => o.doc === citedId && !excused(o) && (!cardIn.has(o.doc) || o.mine)).sort((a, b) => a.x.s - b.x.s);
  const first = cited[0];
  if (!first || !(first.inRun || aliasAt.some((p) => p.doc === first.doc && first.x.s >= p.s && first.x.s < p.e)) || priceKey(first.x.text) !== pk) return null;
  if (/^\s*in total\b/iu.test(first.st.basis.slice(first.x.e, first.x.e + 12))) return null;
  const priceOcc = occs.filter((o) => priceKey(o.x.text) === pk);
  const pricePeriod = periodWord(first.x);
  const nameWords = hyWords(names[self] ?? '');
  const otherNameWords = otherNameWordsOf(names, self);
  const namedForOther = (o: Occ) => labelledForOther(o.st, o.x, otherNameWords);
  /** A label of an amount's own that is not the offer's name: a short label line directly above it, or a short label cell before it. */
  const labelledApart = (o: Occ) => {
    if (o.doc === first.doc && o.x.line === first.x.line && placesOf(o.st, o.x).cell === placesOf(first.st, first.x).cell) return false;
    const pl = placesOf(o.st, o.x);
    const real = (t: string | null) => t !== null && shortLabel(t) && keyOf(t.replace(/:\s*$/u, '')) !== selfKey && hyWords(t).some((x) => /\p{L}{3,}/u.test(x) && !LABEL_EMPTY.has(x));
    return (pl.aboveLabel !== null && !(o.doc === first.doc && o.x.line === first.x.line) && real(pl.aboveLabel)) || real(pl.cellBefore);
  };
  const labelOk = (o: Occ, label: string) => {
    if (MONEY.test(label)) return false;
    const w = hyWords(label);
    if (!w.some((x) => /\p{L}{3,}/u.test(x) && !LABEL_EMPTY.has(x))) return false;
    if (hasRun(nameWords, w)) return false;
    // Never the name of another listed offer ("The Members' Room: £67 a month" is not Mentoring's line).
    if (otherNameWords.some((n) => hasRun(w, n))) return false;
    const pl = placesOf(o.st, o.x);
    return [clauseText(o), pl.colon, pl.cellBefore, pl.aboveLabel].some((t) => t !== null && hasRun(hyWords(t), w));
  };
  const covered = new Set<number>(priceOcc.map((o) => o.i));
  /** A non-plan line with a period (per month, a year, per visit …) is proposed. */
  let periodic = false;
  /** A plan's instalment and total occurrences that matched its written form. */
  const planMatched = new Set<number>();
  const out: CheckedPriceLine[] = [];
  const specialKeys = new Set(proposed.filter((p) => p.kind === 'special').map((p) => keyOf(p.text)));
  for (const p of proposed) {
    const label = p.label ?? null;
    if (p.kind !== 'plan') {
      const k = keyOf(p.text);
      if (k === pk || amountKey(p.text) === amountKey(price)) return null;
      const cands = occs.filter((o) => o.x.key === k);
      const hit = cands.find((o) => (label ? labelOk(o, label) : true));
      if (!hit) return null;
      if (p.kind === 'special' && !label) return null;
      // The ordinary price is never the cheaper one: a special, or a labelled other line of the same period, that is dearer
      // than `price` means a concession, sale, trial or intro price was given as the price.
      if ((p.kind === 'special' || (p.kind === 'other' && label && periodWord(hit.x) === pricePeriod)) && dearer(hit.x.text, first.x.text)) return null;
      if (periodWord(hit.x)) periodic = true;
      if (p.kind === 'other' && !label) {
        const pp = periodWord(hit.x); if (!pp || !pricePeriod || pp === pricePeriod) return null;
        // An amount with a label of its own (a short line above it, a label cell before it) belongs to that label.
        if (labelledApart(hit)) return null;
      }
      for (const o of cands) covered.add(o.i);
      out.push({ role: p.kind, text: hit.x.text, label, total: null, for: null, documentId: hit.doc, quote: quoteOf(hit) });
      continue;
    }
    // A plan: an instalment form around a candidate, not a quantity, paying off a one-off price on its line.
    if (!p.for) return null;
    const fk = priceKey(p.for);
    if (fk !== pk && !specialKeys.has(keyOf(p.for))) return null;
    const ak = amountKey(p.text);
    let firstPlan: CheckedPriceLine | null = null;
    for (const o of occs) {
      if (amountKey(o.x.text) !== ak) continue;
      const l = o.st.lines[o.x.line]!;
      const before = o.st.basis.slice(Math.max(l.contentStart, o.x.s - 60), o.x.s), after = o.st.basis.slice(o.x.e, Math.min(l.e, o.x.e + 60));
      const pb = PLAN_BEFORE.exec(before), pa = pb ? null : PLAN_AFTER.exec(after);
      if (!pb && !pa) continue;
      const start = pb ? o.x.s - pb[1]!.length : o.x.s, end = pa ? o.x.e + pa[0].length : o.x.e;
      const written = o.st.basis.slice(start, end).replace(/\s+/g, ' ').trim();
      if (keyOf(written) !== keyOf(p.text) || !PLAN_NEXT.test(o.st.basis.slice(end, l.e))) continue;
      const countWord = (pb ? pb[2] ?? pb[3] : pa![1])!.toLowerCase();
      const count = /^\d+$/.test(countWord) ? Number(countWord) : NUMBER_WORD[countWord] ?? 0;
      const line = byLine.get(`${o.doc}:${o.x.line}`) ?? [];
      // Its total: the amount straight after it, followed by "in total" (or "total" closing a bracket).
      const y = line.find((q) => q.x.s >= end && q.x.s - end <= 4 && /^\s*[,(]?\s*$/u.test(o.st.basis.slice(end, q.x.s)) && /^\s*(?:in total\b|total\s*\))/iu.test(o.st.basis.slice(q.x.e, q.x.e + 12)));
      covered.add(o.i); planMatched.add(o.i); if (y) { covered.add(y.i); planMatched.add(y.i); }
      const total = y ? `${y.x.text}${/^\s*(?:in total|total)/iu.exec(o.st.basis.slice(y.x.e))![0]}`.replace(/\s+/g, ' ').trim() : null;
      if (firstPlan) continue;
      if (p.total && !(total !== null && keyOf(total) === keyOf(p.total))) continue;
      // Its parent: a one-off price or special on the same line, before it; count × instalment within one to 1.5 times it.
      const parents = line.filter((q) => q.x.e <= start && (priceKey(q.x.text) === pk || specialKeys.has(q.x.key)));
      const mine = parents.filter((q) => (fk === pk ? priceKey(q.x.text) === pk : q.x.key === keyOf(p.for!)));
      if (!mine.length) continue;
      const parent = mine[mine.length - 1]!, pa2 = amountNumber(parent.x.text), ia = amountNumber(o.x.text);
      if (periodWord(parent.x) || !pa2 || !ia || !count || count * ia.n < pa2.n || count * ia.n > 1.5 * pa2.n) return null;
      const last = parents[parents.length - 1]!;
      const direct = /^\s*,?\s*(?:or\s+)?$/iu.test(o.st.basis.slice(last.x.e, start));
      const tied = parents.length === 1 || (direct && last === parent) ? parent.x.text : null;
      firstPlan = { role: 'plan', text: written, label, total: p.total ? total : null, for: tied, documentId: o.doc, quote: quoteOf(o) };
    }
    if (!firstPlan) return null;
    out.push(firstPlan);
  }
  // Every amount the plain rule reads in the run is accounted for.
  for (const o of occs) {
    // (The price's own amount written again, "instead of £67" beside "£67 a month", is the price.)
    if (covered.has(o.i) || excused(o) || amountKey(o.x.text) === amountKey(price)) continue;
    if (out.some((l) => l.role !== 'plan' && keyOf(l.text) === o.x.key)) continue;
    return null;
  }
  // The price's own words. Both word lists apply in its OWN clause (within its sentence) and its OWN label (the words before
  // its colon, a short label cell before it, a short label line or heading directly above it); STRONG words also apply on the
  // rest of its line (its cell, in a table row), in the cell after it, in a longer cell before it and on a short label line
  // directly below it, except in the clause (within its sentence) of another amount on the price's line, or in the cell after
  // it, that the structure accounts for as a special or a labelled other line ("explained"). A word in the price's own clause
  // or own label is never explained.
  const st0 = first.st, fl = st0.lines[first.x.line]!, line0 = st0.basis.slice(fl.contentStart, fl.e), pl = placesOf(st0, first.x);
  const own = sentenceClause(st0, first.x, clauseAt(first));
  const colonLabel = pl.colon === null ? null : pl.colon.split(LABEL_BREAK).pop()!;
  const cellLabel = pl.cellBefore !== null && shortLabel(pl.cellBefore) ? pl.cellBefore : null;
  if ([st0.basis.slice(own.s, own.e), colonLabel, cellLabel, pl.above].some((t) => t !== null && (strongIn(t, line0) || weakIn(t)))) return null;
  // A one-off price beside a line with a period is a fee beside a subscription when it has a label of its own (not the offer's
  // name) or any other word in its own clause ("Sign-up fee: £30" / "Monthly membership: £45 a month").
  if (periodic && !pricePeriod) {
    const labelled = [colonLabel, cellLabel, pl.above].some((t) => t !== null && t.trim() !== '' && keyOf(t.replace(/:\s*$/u, '')) !== selfKey && !PRICE_HEADING.test(t.replace(/:\s*$/u, '').trim()));
    const words = hyWords(st0.basis.slice(own.s, own.e)), amount = hyWords(first.x.text);
    for (const w of amount) { const k = words.indexOf(w); if (k >= 0) words.splice(k, 1); }
    if (labelled || words.some((w) => !ONE_OFF_WORDS.has(w))) return null;
  }
  const explainedKeys = new Set(out.filter((l) => l.role === 'special' || (l.role === 'other' && l.label)).map((l) => keyOf(l.text)));
  const onLine = occs.filter((o) => o.doc === first.doc && o.x.line === first.x.line && explainedKeys.has(o.x.key));
  const cut = [own, ...onLine.map((o) => sentenceClause(o.st, o.x, clauseAt(o)))];
  const rest = (s0: number, e0: number) => { const parts: string[] = []; let at = s0; for (const c of [...cut].sort((a, b) => a.s - b.s)) { if (c.e <= at || c.s >= e0) continue; if (c.s > at) parts.push(st0.basis.slice(at, c.s)); at = Math.max(at, c.e); } if (at < e0) parts.push(st0.basis.slice(at, e0)); return parts.join(' | '); };
  if (strongIn(rest(pl.ownS, pl.ownE), line0)) return null;
  // (A label cell or label line between the price and another amount is never explained: it may as well be the price's own
  // badge, as in the review's M1c "£997 / Webinar price / £1,497".)
  if (pl.cellAfter !== null && strongIn(rest(pl.ownE + 3, pl.ownE + 3 + pl.cellAfter.length), line0)) return null;
  if (pl.cellBefore !== null && cellLabel === null && strongIn(pl.cellBefore, line0)) return null;
  if (pl.below !== null && strongIn(pl.below, line0)) return null;
  // Two different amounts for the same kind and period (specials: and label words).
  const groups = new Map<string, string>();
  groups.set(`price|${pricePeriod}|`, amountKey(price));
  for (const l of out) {
    if (l.role === 'plan') continue;
    const occ = occs.find((o) => o.x.text === l.text);
    const g = `${l.role === 'other' && !l.label ? 'price' : l.role}|${occ ? periodWord(occ.x) : ''}|${l.role === 'special' ? hyWords(l.label ?? '').join(' ') : ''}`;
    const a = amountKey(l.text);
    if (groups.has(g) && groups.get(g) !== a) return null;
    groups.set(g, a);
  }
  // Claimed: exactly the occurrences in the offer's own section that the check matched as the price, as a proposed line, or as
  // a checked plan's instalment or total; never an equal amount written otherwise, nor one labelled with another offer's name.
  const claimed = occs.filter((o) => o.mine && (priceKey(o.x.text) === pk || planMatched.has(o.i) || out.some((l) => l.role !== 'plan' && keyOf(l.text) === o.x.key)) && !namedForOther(o));
  const claims = claimed.map((o) => `${o.doc}:${o.x.s}`);
  const claimedAmounts = claimed.flatMap((o) => { const k = o.st.basis.slice(o.x.s, o.x.e).indexOf('£'); return k >= 0 ? [`${o.doc}:${o.x.s + k}`] : []; });
  return { lines: out, priceDocumentId: first.doc, priceQuote: quoteOf(first), claims, claimedAmounts };
}

/** One offer for `checkAllPricing`: its index in `names`, its price, its proposal (null: none) and its cited document. */
export interface PricingEntry { readonly self: number; readonly price: string | null; readonly proposed: readonly ProposedPriceLine[] | null; readonly citedId: string | null }
/**
 * Every offer's structure check, independent of order. An amount of one offer is excused when it is the very occurrence
 * (document and position) that another listed offer's accepted check claims in that offer's own section: its price, a
 * proposed line, or a checked plan's instalment or total, as written (never an equal amount written otherwise, nor one
 * labelled with another listed offer's name). An offer with no proposal claims its price's occurrences, so written, in its
 * own section of its cited document when the plain rule ties that price there. Repeated until nothing changes (excuses only grow, so it ends).
 */
export function checkAllPricing(documents: readonly CheckDocument[], names: readonly string[], entries: readonly PricingEntry[]): (CheckedPricing | null)[] {
  const plainClaims = entries.map((e) => {
    if (e.proposed || !e.price || !e.citedId || /^free$/iu.test(e.price.trim())) return [] as string[];
    const doc = documents.find((d) => d.id === e.citedId);
    if (!doc || priceStatus(e.price, doc, names, e.self).status !== 'tied') return [];
    const st = structureOfDoc(doc), pk = priceKey(e.price), others = otherNameWordsOf(names, e.self);
    return ownSection(st, names, e.self).occs.filter((x) => priceKey(x.text) === pk && !labelledForOther(st, x, others)).map((x) => `${doc.id}:${x.s}`);
  });
  const result: (CheckedPricing | null)[] = entries.map(() => null);
  const claimsOf = (k: number) => result[k]?.claims ?? plainClaims[k]!;
  // An offer is checked again only when a new excuse is one of the amounts it read (excuses never shrink).
  const read = entries.map(() => new Set<string>()), tried = entries.map(() => null as Set<string> | null);
  for (let pass = 0; pass <= entries.length; pass++) {
    let changed = false;
    for (const [k, e] of entries.entries()) {
      if (result[k] || !e.proposed) continue;
      const others = new Set<string>();
      for (let j = 0; j < entries.length; j++) if (j !== k && entries[j]!.self !== e.self) for (const c of claimsOf(j)) others.add(c);
      const before = tried[k];
      if (before && ![...others].some((c) => !before.has(c) && read[k]!.has(c))) continue;
      tried[k] = others;
      const r = checkPricing(documents, names, e.self, e.price, e.proposed, e.citedId, others, read[k]!);
      if (r) { result[k] = r; changed = true; }
    }
    if (!changed) break;
  }
  return result;
}

/**
 * "Free" as the model's price (with a proposed structure): the offer's run holds no amount at all, and either its name
 * says free, or a line or cell of its run is just Free / FREE / Free of charge / No charge / £0 that is not the value of
 * a label ("Delivery | Free", "Home survey:" above it), unless that label is the offer's name or a price word.
 */
function freeCheck(doc: CheckDocument | undefined, names: readonly string[], self: number): CheckedPricing | null {
  if (!doc) return null;
  const st = structureOfDoc(doc);
  const r = priceReading(doc, names, self);
  if (r.candidates.length || r.onlyAmounts === false) return null;
  const anchors = anchorsFor(st, names), mine = anchors.anchors.filter((a) => a.offer === self);
  if (!mine.length) return null;
  const nameKey = keyOf(names[self] ?? '');
  const isFree = (t: string) => /^(?:free|free of charge|no charge|£0)[.!]*$/iu.test(t.trim());
  const labelFine = (t: string | null) => t === null || keyOf(t.replace(/:\s*$/, '')) === nameKey || /^(?:price|cost|fee)s?:?$/iu.test(t.trim());
  const view = priceView(st, names);
  for (const a of mine) {
    const start = st.lines[a.line]!;
    if (/(?<![\p{L}-])free(?![\p{L}-])/iu.test(names[self] ?? '')) return { lines: [], priceDocumentId: doc.id, priceQuote: withoutMarkers(start.text).trim().slice(0, 300) };
    if (start.kind === 'row') {
      const cells = st.basis.slice(a.s, a.end).split(' | ');
      for (let k = 1; k < cells.length; k++) if (isFree(cells[k]!) && (k === 1 ? labelFine(cells[0]!) : labelFine(cells[k - 1]!))) return { lines: [], priceDocumentId: doc.id, priceQuote: withoutMarkers(start.text).trim().slice(0, 300) };
      continue;
    }
    for (let i = a.line + 1; i < Math.min(st.lines.length, a.line + RUN_LINES); i++) {
      const l = st.lines[i]!;
      if (l.kind === 'heading' || anchors.isAnchor.has(i) || view.byLine.get(i)?.length) break;
      const t = st.basis.slice(l.contentStart, l.e);
      if (l.kind === 'row') continue;
      let prev: string | null = null;
      for (let j = i - 1; j > a.line; j--) if (st.lines[j]!.text.trim()) { prev = st.basis.slice(st.lines[j]!.contentStart, st.lines[j]!.e); break; }
      if (isFree(t) && (prev === null || !/:\s*$/.test(prev) || labelFine(prev))) return { lines: [], priceDocumentId: doc.id, priceQuote: withoutMarkers(l.text).trim().slice(0, 300) };
    }
  }
  return null;
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
