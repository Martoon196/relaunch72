/**
 * Who may see technical detail in the content area. There is one rule: the founder is whoever may manage account
 * limits (the "Usage and limits" page, `limits.allowed()` in the router), which every page's shell already carries
 * as `limitsAvailable`. A client sees the neutral sentence only; the founder also gets a collapsed "Technical detail".
 */
import { escapeHtml as e } from './ui.js';
import { USAGE_ESTIMATES } from '../seo-blog/engine.js';
import { monthlyCeiling, unlimited } from '../seo-blog/limits.js';
import type { BrandSettings } from '../seo-blog/types.js';

/** True only on the founder's own screens. */
export function founderView(shell: { readonly limitsAvailable?: boolean }): boolean {
  return shell.limitsAvailable === true;
}

/**
 * A collapsed "Technical detail" block for the founder, or nothing for anyone else. Raw text that says nothing
 * beyond the neutral sentence is not repeated.
 */
export function technicalDetail(shell: { readonly limitsAvailable?: boolean }, raw: readonly (string | null | undefined)[], shown = ''): string {
  if (!founderView(shell)) return '';
  const lines = raw.filter((x): x is string => typeof x === 'string' && x.trim() !== '' && x !== shown);
  return lines.length ? `<details class="technical-detail"><summary>Technical detail</summary>${lines.map((x) => `<p class="muted">${e(x)}</p>`).join('')}</details>` : '';
}

/**
 * The writing allowance in articles, for an owner who does not think in units: the remaining allowance divided by
 * the engine's own per-article estimate (USAGE_ESTIMATES.article, the figure its preflight checks), rounded down and
 * always said as "about". The raw units stay in the founder's Technical detail.
 */
export interface WritingLeft {
  /** 'unlimited' | 'none' (no allowance set) | 'count'. */
  readonly kind: 'unlimited' | 'none' | 'count';
  /** Articles that still fit this month (count only). */
  readonly articles: number;
  /** Short figure for a card ("About 5", "Unlimited", "None"). */
  readonly figure: string;
  /** One plain sentence ("There is enough left this month for about 5 more articles."). */
  readonly sentence: string;
}

const plural = (n: number) => `${n} more article${n === 1 ? '' : 's'}`;

export function writingLeft(settings: BrandSettings, used: number): WritingLeft {
  if (unlimited(settings, 'modelTokens')) return { kind: 'unlimited', articles: Infinity, figure: 'Unlimited', sentence: 'There is no monthly limit on writing.' };
  const ceiling = monthlyCeiling(settings, 'model_tokens');
  if (ceiling <= 0) return { kind: 'none', articles: 0, figure: 'None', sentence: 'No writing allowance is set yet, so nothing new is written.' };
  const n = Math.floor(Math.max(0, ceiling - used) / USAGE_ESTIMATES.article);
  return { kind: 'count', articles: n, figure: n ? `About ${n}` : '0',
    sentence: n ? `There is enough left this month for about ${plural(n)}. This is an estimate, not a promise.` : 'There is not enough left this month for another article.' };
}

/** The monthly allowance as articles ("about 62 articles a month"), for the box where the owner sets it. */
export function articlesPerMonth(settings: BrandSettings): string {
  if (unlimited(settings, 'modelTokens')) return 'No monthly limit.';
  const n = Math.floor(Math.max(0, settings.budgets.modelTokensPerMonth) / USAGE_ESTIMATES.article);
  return n ? `That is enough for about ${n} article${n === 1 ? '' : 's'} a month (an estimate).` : 'That is not enough for an article.';
}

/** The founder's raw writing figures, for Technical detail. */
export function writingUnitsDetail(settings: BrandSettings, used: number): string {
  return unlimited(settings, 'modelTokens') ? `Writing units: ${used.toLocaleString('en-GB')} used · Unlimited · about ${USAGE_ESTIMATES.article.toLocaleString('en-GB')} per article.`
    : `Writing units: ${used.toLocaleString('en-GB')} of ${settings.budgets.modelTokensPerMonth.toLocaleString('en-GB')} used · about ${USAGE_ESTIMATES.article.toLocaleString('en-GB')} per article.`;
}
