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
interface Unit { readonly start: number; readonly end: number; readonly text: string }

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
  const re = /(?:[^\n.!?]|[.!?](?![.!?]*[*”"')’\]]*(?:[ \t\n]|$)))+(?:[.!?]+[*”"')’\]]*(?=[ \t\n]|$))?|[.!?]+[*”"')’\]]*(?=[ \t\n]|$)/g;
  for (const m of text.matchAll(re)) {
    const lead = m[0].length - m[0].trimStart().length;
    const body = m[0].trim();
    if (!body) continue;
    const start = m.index! + lead;
    out.push({ start, end: start + body.length, text: body });
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
}

export function restoreCitationsDetailed(stored: string, edited: string): RestoredText {
  const next = normal(edited);
  const { plain: rawPlain, anchors: rawAnchors } = strip(stored);
  const plainNormal = normal(rawPlain);
  if (next === plainNormal || next.trim() === plainNormal.trim()) return { text: stored, droppedMarkers: 0, droppedSentences: 0 };
  const { plain, anchors } = strip(normal(stored));
  if (!anchors.length) return { text: next, droppedMarkers: 0, droppedSentences: 0 };
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
  for (const [i, j] of lcs(before.map((u) => u.text), after.map((u) => u.text))) { matched.set(i, j); usedAfter.add(j); }
  // Moved sentences: still word for word, elsewhere.
  for (let i = 0; i < before.length; i++) {
    if (matched.has(i) || !owner.includes(i)) continue;
    const j = after.findIndex((u, k) => !usedAfter.has(k) && u.text === before[i]!.text);
    if (j >= 0) { matched.set(i, j); usedAfter.add(j); }
  }
  // Edited sentences: only a single changed sentence between the same unchanged neighbours, with the same claim.
  const storedTexts = new Set(before.map((u) => u.text));
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
    if (storedTexts.has(target.u.text)) continue; // a word-for-word stored sentence is never someone else's target
    if (!sameClaim(before[i]!.text, target.u.text)) continue;
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
      if (a.offset >= u.start) { inserts.push({ at: t.start + (a.offset - u.start), raw: a.raw, order: n }); return; }
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
  let out = next;
  for (const x of inserts.sort((p, q) => q.at - p.at || q.order - p.order)) {
    let raw = x.raw;
    // The visible text must stay exactly the owner's: a marker without its own space never swallows his space.
    if (!/^[ \t]/.test(raw) && /[ \t]$/.test(out.slice(0, x.at))) raw = raw.trimStart();
    out = out.slice(0, x.at) + raw + out.slice(x.at);
  }
  if (withoutCitations(out) !== next) {
    // Should not happen; never alter the owner's words to keep a source.
    return { text: next, droppedMarkers: anchors.length, droppedSentences: new Set(owner).size };
  }
  return { text: out, droppedMarkers, droppedSentences: droppedUnits.size };
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
