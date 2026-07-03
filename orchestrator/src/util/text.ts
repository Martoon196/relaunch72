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
}

/** Pull numeric tokens out of prose like "£2,400/mo (= 2 lost jobs × £1,200)". */
export function extractNumbers(s: string): ExtractedNumber[] {
  const out: ExtractedNumber[] = [];
  const re = /(\d[\d,]*(?:\.\d+)?)(\s*%)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const raw = m[1] as string;
    const value = Number(raw.replace(/,/g, ''));
    if (Number.isFinite(value)) out.push({ value, percent: Boolean(m[2]), raw: m[0] });
  }
  return out;
}
