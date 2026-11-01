/**
 * Topic duplication checks against the brand's existing public pages (all
 * editorial pages, not only /blog paths) and its planned/generated articles.
 * Exact matches and material overlap produce an explicit recommendation —
 * distinct angle, update the existing page, or skip — never a silent drop.
 */

import type { DuplicateAssessment, InventoryPage } from './types.js';

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'do', 'does', 'for', 'from', 'how', 'i', 'in', 'is',
  'it', 'its', 'my', 'of', 'on', 'or', 'our', 'should', 'so', 'than', 'that', 'the', 'their', 'this', 'to',
  'uk', 'up', 'vs', 'what', 'when', 'where', 'which', 'who', 'why', 'will', 'with', 'you', 'your', 'guide',
  'complete', 'ultimate', 'best', 'need', 'know', 'things', 'about', 'into', 'more', 'most', '2024', '2025', '2026',
]);

function stem(token: string): string {
  if (token.length > 5 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.length > 5 && token.endsWith('ing')) return token.slice(0, -3);
  if (token.length > 4 && token.endsWith('es') && !token.endsWith('ses')) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

export function topicTokens(text: string): Set<string> {
  return new Set(
    text
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[̀-ͯ]/g, '')
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 1 && !STOPWORDS.has(t))
      .map(stem),
  );
}

export function topicSimilarity(a: string, b: string): number {
  const ta = topicTokens(a);
  const tb = topicTokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  // Overlap coefficient blended with Jaccard: a short title wholly contained in
  // a longer one is material overlap even when Jaccard looks modest.
  const jaccard = inter / (ta.size + tb.size - inter);
  const overlap = inter / Math.min(ta.size, tb.size);
  return Math.round((0.6 * jaccard + 0.4 * overlap) * 1000) / 1000;
}

function normalizedTitle(text: string): string {
  return [...topicTokens(text)].sort().join(' ');
}

export function slugify(text: string, max = 80): string {
  const slug = text
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return slug.length >= 3 ? slug : `post-${slug || 'untitled'}`.slice(0, max);
}

function pathSlug(url: string): string {
  try {
    const segments = new URL(url).pathname.split('/').filter(Boolean);
    return (segments[segments.length - 1] ?? '').replace(/\.html?$/i, '').toLowerCase();
  } catch {
    return '';
  }
}

export interface DuplicateCandidate {
  readonly title: string;
  readonly targetQuery: string;
  readonly slug: string;
}

export interface PlannedComparable {
  readonly id: string;
  readonly title: string;
  readonly targetQuery: string;
  readonly slug: string;
  /** A sibling in the same cluster: related by design, so only substantial duplication counts. */
  readonly sibling?: boolean;
}

export const MATERIAL_OVERLAP = 0.5;
export const SUBSTANTIAL_DUPLICATE = 0.8;

export function assessDuplicate(
  candidate: DuplicateCandidate,
  inventory: readonly InventoryPage[],
  planned: readonly PlannedComparable[],
): DuplicateAssessment {
  let best: { score: number; against: string; kind: 'published_page' | 'planned_article'; exact: boolean } | null = null;
  const consider = (score: number, against: string, kind: 'published_page' | 'planned_article', exact: boolean) => {
    if (!best || score > best.score || (exact && !best.exact)) best = { score, against, kind, exact };
  };
  const candidateNorm = normalizedTitle(candidate.title);
  for (const page of inventory) {
    if (page.fetchStatus !== 'ok') continue;
    const label = [page.title ?? '', page.headings[0] ?? ''].join(' ');
    const exact = (candidate.slug && pathSlug(page.url) === candidate.slug)
      || (candidateNorm.length > 0 && normalizedTitle(page.title ?? '') === candidateNorm);
    const score = Math.max(
      topicSimilarity(candidate.title, label),
      topicSimilarity(candidate.targetQuery, label),
      exact ? 1 : 0,
    );
    consider(score, page.canonical ?? page.url, 'published_page', Boolean(exact));
  }
  for (const item of planned) {
    const exact = item.slug === candidate.slug || normalizedTitle(item.title) === candidateNorm;
    const score = Math.max(
      topicSimilarity(candidate.title, item.title),
      topicSimilarity(candidate.targetQuery, item.targetQuery),
      exact ? 1 : 0,
    );
    if (item.sibling && !exact && score < SUBSTANTIAL_DUPLICATE) continue;
    consider(score, item.title, 'planned_article', exact);
  }
  const hit = best as { score: number; against: string; kind: 'published_page' | 'planned_article'; exact: boolean } | null;
  if (!hit || hit.score < MATERIAL_OVERLAP) {
    return { verdict: 'distinct', score: hit?.score ?? 0, against: null, againstKind: null, advice: 'No material overlap with existing or planned content.' };
  }
  if (hit.kind === 'published_page') {
    if (hit.exact || hit.score >= SUBSTANTIAL_DUPLICATE) {
      return {
        verdict: 'update_existing', score: hit.score, against: hit.against, againstKind: hit.kind,
        advice: 'An existing page already covers this. Consider updating that page instead of publishing a near-duplicate.',
      };
    }
    return {
      verdict: 'new_angle', score: hit.score, against: hit.against, againstKind: hit.kind,
      advice: 'An existing page overlaps. Keep this only with a clearly different angle, and link to the existing page.',
    };
  }
  if (hit.exact || hit.score >= SUBSTANTIAL_DUPLICATE) {
    return {
      verdict: 'skip', score: hit.score, against: hit.against, againstKind: hit.kind,
      advice: 'Another planned article already covers this subject. Skip it or merge the ideas.',
    };
  }
  return {
    verdict: 'new_angle', score: hit.score, against: hit.against, againstKind: hit.kind,
    advice: 'Overlaps a planned article. Sharpen the angle so each article answers a different question.',
  };
}
