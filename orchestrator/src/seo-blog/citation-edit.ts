/**
 * Editing article text without showing citation markers.
 *
 * Bodies keep their `[src:…]` markers in storage (the renderer turns them into
 * numbered source links). The owner edits the text with the markers taken out;
 * on save each marker is put back on the sentence it belonged to:
 *
 * - nothing changed (after newline normalisation) → the stored text, byte for byte;
 * - a cited sentence is still there word for word → its markers go back at the same places;
 * - a cited sentence was reworded (at least half of its words kept) → its markers go at the
 *   end of the reworded sentence, before its closing punctuation;
 * - a cited sentence was deleted → its markers go with it (the claim no longer exists).
 *
 * Nothing here invents a citation: only markers that were in the stored text can come back.
 */

const MARKER = /[ \t]*\[src:[A-Za-z0-9-]{1,64}\]/g;

/** The text the owner sees while editing. */
export function withoutCitations(text: string): string {
  return text.replace(MARKER, '');
}

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

/** Sentences and lines (list items are lines), with their positions. */
function units(text: string): Unit[] {
  const out: Unit[] = [];
  // A sentence ends at . ! or ? followed by a space or the end ("5.5%" stays one sentence), or at a line break.
  const re = /(?:[^\n.!?]|[.!?](?![.!?]*(?:\s|$)))+(?:[.!?]+(?=\s|$))?|[.!?]+(?=\s|$)/g;
  for (const m of text.matchAll(re)) {
    if (!m[0]) continue;
    const lead = m[0].length - m[0].trimStart().length;
    const body = m[0].trim();
    if (!body) continue;
    const start = m.index! + lead;
    out.push({ start, end: start + body.length, text: body });
  }
  return out;
}

function words(text: string): string[] {
  return text.toLowerCase().replace(/\*\*|[*_`]/g, '').split(/[^\p{L}\p{N}£%]+/u).filter(Boolean);
}

function similarity(a: string, b: string): number {
  const wa = new Set(words(a)), wb = new Set(words(b));
  if (!wa.size || !wb.size) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / Math.max(wa.size, wb.size);
}

const normal = (text: string) => text.replace(/\r\n?/g, '\n');

/**
 * Put the stored text's citation markers back into the owner's edited (marker-free) text.
 * Returns `stored` unchanged when the visible text was not changed.
 */
export function restoreCitations(stored: string, edited: string): string {
  const next = normal(edited);
  const { plain, anchors } = strip(stored);
  if (next === plain || next.trim() === plain.trim()) return stored;
  if (!anchors.length) return next;
  const before = units(plain);
  const after = units(next);
  const used = new Set<number>();
  const inserts: { at: number; raw: string }[] = [];
  for (const unit of before) {
    const mine = anchors.filter((a) => a.offset > unit.start && a.offset <= unit.end);
    if (!mine.length) continue;
    let exact = after.findIndex((u, i) => !used.has(i) && u.text === unit.text);
    if (exact >= 0) {
      used.add(exact);
      const target = after[exact]!;
      for (const a of mine) inserts.push({ at: target.start + (a.offset - unit.start), raw: a.raw });
      continue;
    }
    let best = -1, score = 0;
    after.forEach((u, i) => { const s = similarity(unit.text, u.text); if (s > score) { score = s; best = i; } });
    if (best < 0 || score < 0.5) continue;
    const target = after[best]!;
    const closing = /[.!?:;]+$/.exec(target.text)?.[0].length ?? 0;
    for (const a of mine) inserts.push({ at: target.end - closing, raw: a.raw.startsWith(' ') || a.raw.startsWith('\t') ? a.raw : ` ${a.raw}` });
  }
  let out = next;
  for (const insert of inserts.map((x, i) => ({ ...x, i })).sort((a, b) => b.at - a.at || b.i - a.i)) out = out.slice(0, insert.at) + insert.raw + out.slice(insert.at);
  return out;
}

/** Plain text fields (title, headings, questions): unchanged input keeps the stored bytes. */
export function keepIfUnchanged(stored: string, edited: string): string {
  const next = normal(edited).replace(/\n+/g, ' ');
  return next.trim() === stored.trim() ? stored : next.trim();
}
