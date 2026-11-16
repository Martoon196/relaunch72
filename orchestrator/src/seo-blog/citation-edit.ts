/**
 * Editing article text without showing citation markers.
 *
 * Bodies keep their `[src:…]` markers in storage (the renderer turns them into numbered source links). The
 * owner edits the text with the markers taken out; on save the markers are put back, conservatively:
 *
 * - Nothing visible changed (line endings ignored on both sides) → the stored text, byte for byte.
 * - A sentence that is still there word for word keeps its markers at the same places. Sentences matched in
 *   order first (so of two identical sentences, the one in the same position is preferred), then moved ones.
 * - A cited sentence that was edited keeps its markers only when it is the single changed sentence between the
 *   same unchanged neighbours, every number in it is still there unchanged, and at least 70% of its words
 *   (and at least four) remain. Otherwise its markers are dropped: a missing source is caught by the checks
 *   ("number has no source"); a source on the wrong claim would not be.
 * - A marker is never attached to a sentence it was not attached to in the stored text.
 * - The visible text of the result is always exactly the owner's edited text.
 */

const MARKER = /[ \t]*\[src:[A-Za-z0-9-]{1,64}\]/g;

/** The text the owner sees while editing. */
export function withoutCitations(text: string): string {
  return text.replace(MARKER, '');
}

const normal = (text: string) => text.replace(/\r\n?/g, '\n');

interface Anchor { readonly offset: number; readonly raw: string }
/** `key` is the text compared between versions: a numbered list item without its number, so renumbering is not an edit. */
interface Unit { readonly start: number; readonly end: number; readonly text: string; readonly key: string; readonly keyStart: number }
const LIST_NUMBER = /^\d{1,3}[.)][ \t]+/;

function strip(text: string): { plain: string; anchors: Anchor[] } {
  const anchors: Anchor[] = [];
  let plain = '';
  let last = 0;
  for (const m of text.matchAll(MARKER)) {
    plain += text.slice(last, m.index);
    anchors.push({ offset: plain.length, raw: m[0] });
    last = m.index! + m[0].length;
  }
  plain += text.slice(last);
  return { plain, anchors };
}

/**
 * Sentences and lines (list items are lines), with their positions. A sentence ends at . ! or ? followed by any
 * closing marks (** ” " ) * ’ ') and then a space or the end; "5.5%" stays inside its sentence.
 */
export function sentenceUnits(text: string): Unit[] {
  const out: Unit[] = [];
  // A numbered list item's own number ("2. ") belongs to its line; it does not end a sentence.
  const re = /(?:(?<=^|\n)[ \t]*\d{1,3}[.)][ \t]+)?(?:(?:[^\n.!?]|[.!?](?![.!?]*[*”"')’\]]*(?:[ \t\n]|$)))+(?:[.!?]+[*”"')’\]]*(?=[ \t\n]|$))?|[.!?]+[*”"')’\]]*(?=[ \t\n]|$))/g;
  for (const m of text.matchAll(re)) {
    const lead = m[0].length - m[0].trimStart().length;
    const body = m[0].trim();
    if (!body) continue;
    const start = m.index! + lead;
    const number = LIST_NUMBER.exec(body)?.[0].length ?? 0;
    out.push({ start, end: start + body.length, text: body, key: body.slice(number), keyStart: start + number });
  }
  return out;
}

const words = (text: string) => text.toLowerCase().replace(/[*_`[\]()]/g, ' ').split(/[^\p{L}\p{N}£%'’-]+/u).map((w) => w.replace(/^['’-]+|['’-]+$/g, '')).filter(Boolean);
const numbers = (text: string) => (text.match(/[£$€]?\d[\d,]*(?:\.\d+)?\s?(?:%|k\b|m\b|bn\b|million\b|billion\b)?/gi) ?? []).map((n) => n.replace(/\s/g, '').toLowerCase());

/** True when an edited sentence is close enough to the stored one to keep its sources. */
export function sameClaim(stored: string, edited: string): boolean {
  const left = [...edited.match(/[£$€]?\d[\d,]*(?:\.\d+)?\s?(?:%|k\b|m\b|bn\b|million\b|billion\b)?/gi) ?? []].map((n) => n.replace(/\s/g, '').toLowerCase());
  for (const n of numbers(stored)) { const i = left.indexOf(n); if (i < 0) return false; left.splice(i, 1); }
  const before = new Set(words(stored)), after = new Set(words(edited));
  if (!before.size) return false;
  let shared = 0;
  for (const w of before) if (after.has(w)) shared++;
  return shared >= 4 && shared / before.size >= 0.7;
}

/** Longest common subsequence of unit texts; among equally long ones, the one keeping sentences nearest their old positions. */
function lcs(a: readonly string[], b: readonly string[]): [number, number][] {
  const n = a.length, m = b.length;
  const len: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  const cost: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  const better = (l1: number, c1: number, l2: number, c2: number) => l1 > l2 || (l1 === l2 && c1 < c2);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    let l = len[i + 1]![j]!, c = cost[i + 1]![j]!;
    if (better(len[i]![j + 1]!, cost[i]![j + 1]!, l, c)) { l = len[i]![j + 1]!; c = cost[i]![j + 1]!; }
    if (a[i] === b[j] && better(len[i + 1]![j + 1]! + 1, cost[i + 1]![j + 1]! + Math.abs(i - j), l, c)) { l = len[i + 1]![j + 1]! + 1; c = cost[i + 1]![j + 1]! + Math.abs(i - j); }
    len[i]![j] = l; cost[i]![j] = c;
  }
  const pairs: [number, number][] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j] && len[i]![j] === len[i + 1]![j + 1]! + 1 && cost[i]![j] === cost[i + 1]![j + 1]! + Math.abs(i - j)) { pairs.push([i, j]); i++; j++; }
    else if (len[i]![j] === len[i + 1]![j] && cost[i]![j] === cost[i + 1]![j]) i++;
    else j++;
  }
  return pairs;
}

export interface RestoredText {
  readonly text: string;
  /** Markers that could not safely stay (their sentence was deleted or changed too much). */
  readonly droppedMarkers: number;
  /** Stored sentences whose markers were dropped. */
  readonly droppedSentences: number;
  /** Marker-like text the owner typed or pasted, removed from what is saved (markers are only ever restored, never typed). */
  readonly typedRemoved: number;
  /** Edited sentences that kept their sources (same numbers, most words): the owner should check them. Source ids of each. */
  readonly keptOnEdited: readonly (readonly string[])[];
  /** Sentences changed back to how they were in the previous version, whose sources from it came back. */
  readonly restoredFromEarlier: number;
  /** Sentences changed back whose earlier source is no longer on the article's source list (or not shown to readers), so it did not come back. */
  readonly notRestored: number;
}

/** Anything that looks like a citation marker, as typed or pasted by the owner. */
const TYPED = /[ \t]*\[src:[^\]\n]*\]/gi;

/**
 * `previous` is the version saved before `stored` (when there is one): a sentence the owner changes back to exactly
 * how it was there gets that version's sources back, so "change it back" really undoes a lost source.
 */
export function restoreCitationsDetailed(stored: string, edited: string, previous?: string | null, usable?: (sourceId: string) => boolean): RestoredText {
  const typedRemoved = (normal(edited).match(TYPED) ?? []).length;
  const next = normal(edited).replace(TYPED, '');
  const { plain: rawPlain } = strip(stored);
  const plainNormal = normal(rawPlain);
  const none = { droppedMarkers: 0, droppedSentences: 0, typedRemoved, keptOnEdited: [] as string[][], restoredFromEarlier: 0, notRestored: 0 };
  if (next === plainNormal || next.trim() === plainNormal.trim()) return { ...none, text: stored };
  const { plain, anchors } = strip(normal(stored));
  const earlier = previous ? strip(normal(previous)) : null;
  if (!anchors.length && !earlier?.anchors.length) return { ...none, text: next };
  const before = sentenceUnits(plain);
  const after = sentenceUnits(next);
  // Which stored sentence each marker belongs to: the sentence it sits in or directly after; a marker before a
  // sentence's first word (start of a line or field) belongs to the sentence that follows it.
  const owner = anchors.map((a) => {
    const inside = before.findIndex((u) => a.offset > u.start && a.offset <= u.end);
    if (inside >= 0) return inside;
    // Alone on its own line: it belongs to the line before and stays only where that gap is unchanged.
    const lineStart = plain.lastIndexOf('\n', a.offset - 1) + 1, lineEnd = plain.indexOf('\n', a.offset);
    if (/^\s*$/.test(plain.slice(lineStart, lineEnd < 0 ? plain.length : lineEnd)) && lineStart > 0) {
      for (let i = before.length - 1; i >= 0; i--) if (before[i]!.end <= a.offset) return i;
    }
    const following = before.findIndex((u) => u.start >= a.offset && /^\s*$/.test(plain.slice(a.offset, u.start)));
    if (following >= 0) return following;
    for (let i = before.length - 1; i >= 0; i--) if (before[i]!.end <= a.offset) return i;
    return -1;
  });
  const matched = new Map<number, number>(); // stored unit → edited unit (word for word)
  const usedAfter = new Set<number>();
  for (const [i, j] of lcs(before.map((u) => u.key), after.map((u) => u.key))) { matched.set(i, j); usedAfter.add(j); }
  // Moved sentences: still word for word, elsewhere.
  for (let i = 0; i < before.length; i++) {
    if (matched.has(i) || !owner.includes(i)) continue;
    const j = after.findIndex((u, k) => !usedAfter.has(k) && u.key === before[i]!.key);
    if (j >= 0) { matched.set(i, j); usedAfter.add(j); }
  }
  // Identical twin sentences whose order changed: which one is which cannot be known, so their sources are not guessed.
  const count = (xs: readonly Unit[]) => { const m = new Map<string, number>(); for (const u of xs) m.set(u.key, (m.get(u.key) ?? 0) + 1); return m; };
  const inBefore = count(before), inAfter = count(after);
  let possible = 0; for (const [text, n] of inBefore) possible += Math.min(n, inAfter.get(text) ?? 0);
  const inOrder = lcs(before.map((u) => u.key), after.map((u) => u.key)).length;
  const twin = (i: number) => (inBefore.get(before[i]!.key) ?? 0) > 1 || (inAfter.get(before[i]!.key) ?? 0) > 1;
  if (possible > inOrder) for (const i of [...matched.keys()]) if (owner.includes(i) && twin(i)) matched.delete(i);
  // A cited twin keeps its source only where at least one of its neighbours is still beside it.
  for (const [i, j] of [...matched]) {
    if (!owner.includes(i) || !twin(i)) continue;
    const prevOk = (i === 0 && j === 0) || (i > 0 && matched.get(i - 1) === j - 1);
    const nextOk = (i === before.length - 1 && j === after.length - 1) || (i < before.length - 1 && matched.get(i + 1) === j + 1);
    if (!prevOk && !nextOk) matched.delete(i);
  }
  // Edited sentences: only a single changed sentence between the same unchanged neighbours, with the same claim.
  const storedTexts = new Set(before.map((u) => u.key));
  const reworded = new Map<number, number>();
  for (let i = 0; i < before.length; i++) {
    if (matched.has(i) || !owner.includes(i)) continue;
    let prev = -1, nextStored = before.length;
    for (let k = i - 1; k >= 0; k--) if (matched.has(k)) { prev = k; break; }
    for (let k = i + 1; k < before.length; k++) if (matched.has(k)) { nextStored = k; break; }
    const lo = prev >= 0 ? matched.get(prev)! : -1;
    const hi = nextStored < before.length ? matched.get(nextStored)! : after.length;
    if (hi <= lo) continue;
    const storedGap = before.slice(prev + 1, nextStored).filter((_, k) => !matched.has(prev + 1 + k));
    const editedGap = after.map((u, k) => ({ u, k })).filter(({ k }) => k > lo && k < hi && !usedAfter.has(k));
    if (storedGap.length !== 1 || editedGap.length !== 1) continue;
    const target = editedGap[0]!;
    if (storedTexts.has(target.u.key)) continue; // a word-for-word stored sentence is never someone else's target
    // Compared without list numbers: a list item's own number is not a figure in its sentence.
    if (!sameClaim(before[i]!.key, target.u.key)) continue;
    reworded.set(i, target.k);
  }
  const inserts: { at: number; raw: string; order: number }[] = [];
  let droppedMarkers = 0;
  const droppedUnits = new Set<number>();
  anchors.forEach((a, n) => {
    const i = owner[n]!;
    const u = before[i];
    if (!u) { droppedMarkers++; return; }
    if (matched.has(i)) {
      const t = after[matched.get(i)!]!;
      if (a.offset > u.end) {
        // After the sentence (for example alone on the next line): only where the same gap still follows it.
        const gap = plain.slice(u.end, a.offset);
        if (next.slice(t.end, t.end + gap.length) === gap) inserts.push({ at: t.end + gap.length, raw: a.raw, order: n }); else { droppedMarkers++; droppedUnits.add(i); }
        return;
      }
      if (a.offset >= u.keyStart) { inserts.push({ at: t.keyStart + (a.offset - u.keyStart), raw: a.raw, order: n }); return; }
      if (a.offset >= u.start) { inserts.push({ at: t.start + Math.min(a.offset - u.start, t.keyStart - t.start), raw: a.raw, order: n }); return; }
      // A leading marker keeps its place when the space before the sentence is the same; otherwise it goes before the sentence.
      const gap = plain.slice(a.offset, u.start);
      inserts.push(next.slice(t.start - gap.length, t.start) === gap ? { at: t.start - gap.length, raw: a.raw, order: n } : { at: t.start, raw: a.raw.trimStart(), order: n });
      return;
    }
    if (reworded.has(i)) {
      const t = after[reworded.get(i)!]!;
      const closing = /[.!?:;]+[*”"')’\]]*$/.exec(t.text)?.[0].length ?? 0;
      if (a.offset > u.end) { droppedMarkers++; droppedUnits.add(i); return; }
      const at = a.offset < u.start ? t.start : t.end - closing;
      inserts.push({ at, raw: a.offset < u.start ? a.raw.trimStart() : /^[ \t]/.test(a.raw) ? a.raw : ` ${a.raw}`, order: n });
      return;
    }
    droppedMarkers++; droppedUnits.add(i);
  });
  // Sentences changed back to exactly how they were in the version before: their sources from that version return.
  let restoredFromEarlier = 0, notRestored = 0;
  if (earlier?.anchors.length) {
    const prevUnits = sentenceUnits(earlier.plain);
    const targeted = new Set([...[...matched].filter(([i]) => owner.includes(i)).map(([, j]) => j), ...reworded.values()]);
    after.forEach((t, j) => {
      if (targeted.has(j) || storedTexts.has(t.key) || after.filter((x) => x.key === t.key).length !== 1) return;
      const same = prevUnits.filter((x) => x.key === t.key);
      if (same.length !== 1) return;
      const u = same[0]!;
      const mine = earlier.anchors.filter((a) => a.offset > u.keyStart && a.offset <= u.end);
      if (!mine.length) return;
      // Only a source this article still lists and shows to readers comes back; otherwise the sentence stays without it.
      if (usable && !mine.every((a) => usable(/\[src:([A-Za-z0-9-]+)\]/.exec(a.raw)![1]!))) { notRestored++; return; }
      restoredFromEarlier++;
      mine.forEach((a, k) => inserts.push({ at: t.keyStart + (a.offset - u.keyStart), raw: a.raw, order: anchors.length + k }));
    });
  }
  let out = next;
  for (const x of inserts.sort((p, q) => q.at - p.at || q.order - p.order)) {
    let raw = x.raw;
    // The visible text must stay exactly the owner's: a marker without its own space never swallows his space.
    if (!/^[ \t]/.test(raw) && /[ \t]$/.test(out.slice(0, x.at))) raw = raw.trimStart();
    out = out.slice(0, x.at) + raw + out.slice(x.at);
  }
  if (withoutCitations(out) !== next) {
    // Should not happen; never alter the owner's words to keep a source.
    return { ...none, text: next, droppedMarkers: anchors.length, droppedSentences: new Set(owner).size };
  }
  const keptOnEdited = [...reworded.keys()].map((i) => anchors.filter((_, n) => owner[n] === i).map((a) => /\[src:([A-Za-z0-9-]+)\]/.exec(a.raw)![1]!));
  return { text: out, droppedMarkers, droppedSentences: droppedUnits.size, typedRemoved, keptOnEdited, restoredFromEarlier, notRestored };
}

/** Put the stored text's citation markers back into the owner's edited (marker-free) text. */
export function restoreCitations(stored: string, edited: string): string {
  return restoreCitationsDetailed(stored, edited).text;
}

/** Plain text fields (title, headings, questions): unchanged input keeps the stored bytes. */
export function keepIfUnchanged(stored: string, edited: string): string {
  const next = normal(edited).replace(/\n+/g, ' ');
  return next.trim() === normal(stored).replace(/\n+/g, ' ').trim() ? stored : next.trim();
}

// ─── "Put the earlier wording back" ──────────────────────────────────────────

/** Where it goes back: in place of one changed sentence, or (deleted) before the sentence that followed it / after the one before it, with the same line breaks or spaces as before. */
interface Restorable { readonly index: number; readonly earlier: string; readonly raw: string; readonly at: { start: number; end: number } | { before: number; sep: string } | { after: number; sep: string } | { alone: true } }

function rawSpan(stored: string, unit: Unit): string {
  const { anchors } = strip(stored);
  const map = (p: number, inclusive: boolean) => p + anchors.filter((a) => (inclusive ? a.offset <= p : a.offset < p)).reduce((n, a) => n + a.raw.length, 0);
  return stored.slice(map(unit.start, false), map(unit.end, true));
}

function restorables(earlierStored: string, currentStored: string): Restorable[] {
  const earlier = normal(earlierStored), current = normal(currentStored);
  const { plain: ep, anchors } = strip(earlier);
  const { plain: cp } = strip(current);
  const before = sentenceUnits(ep), after = sentenceUnits(cp);
  const currentIds = new Set([...current.matchAll(/\[src:([A-Za-z0-9-]+)\]/g)].map((m) => m[1]!));
  const matched = new Map(lcs(before.map((u) => u.key), after.map((u) => u.key)));
  const usedAfter = new Set(matched.values());
  const out: Restorable[] = [];
  before.forEach((u, i) => {
    if (matched.has(i)) return;
    const ids = anchors.filter((a) => a.offset > u.start && a.offset <= u.end).map((a) => /\[src:([A-Za-z0-9-]+)\]/.exec(a.raw)![1]!);
    if (!ids.length || ids.every((id) => currentIds.has(id))) return;
    let prev = -1, next = before.length;
    for (let k = i - 1; k >= 0; k--) if (matched.has(k)) { prev = k; break; }
    for (let k = i + 1; k < before.length; k++) if (matched.has(k)) { next = k; break; }
    const storedGap = before.slice(prev + 1, next).filter((_, k) => !matched.has(prev + 1 + k));
    const lo = prev >= 0 ? matched.get(prev)! : -1, hi = next < before.length ? matched.get(next)! : after.length;
    const gap = after.map((x, k) => ({ x, k })).filter(({ k }) => k > lo && k < hi && !usedAfter.has(k));
    if (storedGap.length !== 1 || gap.length > 1) return;
    // Not offered when it could not come back exactly: the same sentence appears twice (which one was it?), it
    // is a numbered item whose list was renumbered since, or the item that replaced it carries another number.
    if (before.filter((x) => x.key === u.key).length > 1 || after.some((x) => x.key === u.key)) return;
    const prefix = (x: Unit) => x.text.slice(0, x.keyStart - x.start);
    if (prefix(u) && [...matched].some(([bi, aj]) => before[bi]!.text !== after[aj]!.text)) return;
    if (gap.length && prefix(gap[0]!.x) !== prefix(u)) return;
    // A deleted one is attached to the neighbour it sat closest to (a list item to its list, not across a blank line).
    const sepBefore = prev >= 0 ? ep.slice(before[prev]!.end, u.start) : null, sepAfter = next < before.length ? ep.slice(u.end, before[next]!.start) : null;
    const at: Restorable['at'] = gap.length ? { start: gap[0]!.x.start, end: gap[0]!.x.end }
      : sepBefore !== null && (sepAfter === null || sepBefore.length <= sepAfter.length) ? { after: lo, sep: sepBefore }
      : sepAfter !== null ? { before: hi, sep: sepAfter } : { alone: true };
    out.push({ index: i, earlier: u.text, raw: rawSpan(earlier, u), at });
  });
  return out;
}

/** Cited sentences of an earlier version that lost their source in this one, and can be put back one at a time. */
export function sentencesToPutBack(earlierStored: string, currentStored: string): { index: number; earlier: string }[] {
  return restorables(earlierStored, currentStored).map(({ index, earlier }) => ({ index, earlier }));
}

/** The current text with one earlier sentence (and its sources) put back in its place, or null when that is no longer possible. */
export function putBackSentence(earlierStored: string, currentStored: string, index: number): string | null {
  const r = restorables(earlierStored, currentStored).find((x) => x.index === index);
  if (!r) return null;
  const current = normal(currentStored);
  const { plain: cp, anchors } = strip(current);
  const toRaw = (p: number) => p + anchors.filter((a) => a.offset <= p).reduce((n, a) => n + a.raw.length, 0);
  const at0 = r.at;
  if ('start' in at0) {
    const startRaw = at0.start + anchors.filter((a) => a.offset < at0.start).reduce((n, a) => n + a.raw.length, 0);
    return current.slice(0, startRaw) + r.raw + current.slice(toRaw(at0.end));
  }
  const units = sentenceUnits(cp);
  // A deleted sentence, list item or paragraph comes back on its own line (or after its own space), exactly as stored.
  if ('before' in at0) { const at = units[at0.before]!.start + anchors.filter((a) => a.offset < units[at0.before]!.start).reduce((n, a) => n + a.raw.length, 0); return `${current.slice(0, at)}${r.raw}${at0.sep}${current.slice(at)}`; }
  if ('after' in at0) { const at = toRaw(units[at0.after]!.end); return `${current.slice(0, at)}${at0.sep}${r.raw}${current.slice(at)}`; }
  return current.trim() ? `${r.raw}\n\n${current}` : r.raw;
}

/** Every sentence the page will offer to put back, comparing an earlier version's text fields with the current ones. */
export function putBackOffers(earlier: ArticleTextFields, current: ArticleTextFields): { field: string; index: number; earlier: string }[] {
  const fields: [string, string | undefined, string | undefined][] = [['intro', earlier.intro, current.intro], ['conclusion', earlier.conclusion, current.conclusion],
    ...current.sections.map((s) => [`section:${s.id}`, earlier.sections.find((x) => x.id === s.id)?.body, s.body] as [string, string | undefined, string | undefined]),
    ...current.faqs.map((f, i) => [`faq:${i}`, earlier.faqs[i]?.a, f.a] as [string, string | undefined, string | undefined])];
  return fields.flatMap(([field, from, to]) => (from === undefined || to === undefined ? [] : sentencesToPutBack(from, to).map((x) => ({ field, ...x }))));
}
export interface ArticleTextFields { readonly intro: string; readonly conclusion: string; readonly sections: readonly { readonly id: string; readonly body: string }[]; readonly faqs: readonly { readonly a: string }[] }
