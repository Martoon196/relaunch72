/** Text utilities backing S0 validation and the fact-echo QA checks. */

export function wordCount(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

/**
 * Normalization used by "exact substring" checks (see decisions.md D-002):
 * NFC + curly/smart quotes → straight + all whitespace runs collapsed to one
 * space + trimmed. Case and wording are preserved — paraphrase still fails.
 */
export function normalizeText(s: string): string {
  return s
    .normalize('NFC')
    .replace(/[​‌‍﻿]/g, '') // zero-width chars can't hide words
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/…/g, '...')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Lowercased loose form for similarity scoring only (never for verbatim checks). */
export function normalizeLoose(s: string): string {
  return normalizeText(s).toLowerCase();
}

/** Extract spans wrapped in straight or curly DOUBLE quotes. Single quotes are
 * ignored (apostrophes make them unreliable); prompts instruct double quotes. */
export function extractQuotedSpans(s: string): string[] {
  const spans: string[] = [];
  const re = /"([^"]{2,600})"|“([^”]{2,600})”/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const span = m[1] ?? m[2];
    if (span) spans.push(span.trim());
  }
  return spans;
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min((prev[j] as number) + 1, (curr[j - 1] as number) + 1, (prev[j - 1] as number) + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length] as number;
}

/** 0..1, on loose-normalized strings. */
export function similarityRatio(a: string, b: string): number {
  const na = normalizeLoose(a);
  const nb = normalizeLoose(b);
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(na, nb) / maxLen;
}

function contentTokens(s: string): Set<string> {
  return new Set(
    normalizeLoose(s)
      .split(/[^a-z0-9£$%]+/)
      .filter((t) => t.length > 2),
  );
}

export function tokenJaccard(a: string, b: string): number {
  const ta = contentTokens(a);
  const tb = contentTokens(b);
  if (ta.size === 0 && tb.size === 0) return 1;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * S0 placeholder-similarity: does the answer just echo our placeholder example?
 * Fires on exact/containment matches and near-copies; a genuine answer about a
 * similar business should NOT fire (thresholds per decisions.md D-001).
 */
export function isPlaceholderEcho(answer: string, placeholder: string): boolean {
  const a = normalizeLoose(answer);
  const p = normalizeLoose(placeholder);
  if (!a || !p) return false;
  if (a === p) return true;
  if (a.includes(p) || p.includes(a)) return true;
  if (tokenJaccard(answer, placeholder) >= 0.6) return true;
  if (similarityRatio(answer, placeholder) >= 0.8) return true;
  return false;
}

export interface ExtractedNumber {
  value: number;
  percent: boolean;
  raw: string;
  /** Up to 3 chars preceding the number (currency detection). */
  before: string;
  /** Up to 16 chars following the number (unit/period detection). */
  after: string;
}

/**
 * Pull numeric tokens out of prose like "£2,400/mo (= 2 lost jobs × £1,200)".
 * Handles thousands groups split by NBSP/thin space ("12 345"), and k/m
 * shorthand ("£12k" is 12,000 — it must not slip the invented-number gate
 * disguised as a small 12).
 */
export function extractNumbers(s: string): ExtractedNumber[] {
  const joined = s.replace(/(\d)[   ](?=\d{3}\b)/g, '$1');
  const out: ExtractedNumber[] = [];
  const re = /(\d[\d,]*(?:\.\d+)?)(\s*%|[km]\b)?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(joined)) !== null) {
    let value = Number((m[1] as string).replace(/,/g, ''));
    if (!Number.isFinite(value)) continue;
    const suffix = (m[2] ?? '').trim().toLowerCase();
    if (suffix === 'k') value *= 1_000;
    else if (suffix === 'm') value *= 1_000_000;
    out.push({
      value,
      percent: suffix === '%',
      raw: m[0],
      before: joined.slice(Math.max(0, m.index - 3), m.index),
      after: joined.slice(m.index + m[0].length, m.index + m[0].length + 16),
    });
  }
  // Band shorthand: in "£10–30k" the k scales only the high operand, so the
  // low bound's true magnitude (10,000) is missing — an honest expansion
  // ("£10,000") then reads as an invented number. Emit the scaled low bound
  // too (only when the low operand carries no suffix of its own).
  const rangeRe = /(\d[\d,]*(?:\.\d+)?)\s*(?:-|–|—|to)\s*(\d[\d,]*(?:\.\d+)?)([km])\b/gi;
  let r: RegExpExecArray | null;
  while ((r = rangeRe.exec(joined)) !== null) {
    const low = Number((r[1] as string).replace(/,/g, ''));
    const mult = (r[3] as string).toLowerCase() === 'k' ? 1_000 : 1_000_000;
    if (!Number.isFinite(low)) continue;
    const scaled = low * mult;
    if (!out.some((n) => n.value === scaled)) {
      out.push({ value: scaled, percent: false, raw: `${r[1]}${r[3]}`, before: '', after: '' });
    }
  }
  return out;
}
