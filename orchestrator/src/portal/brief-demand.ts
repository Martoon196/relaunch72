/**
 * Review fix F2: every measured number shown for an article or brief names the phrase it belongs to, so a person can
 * check the match on screen. The phrase is the brief's bound search phrase when keyword-first planning chose one, else
 * the brief's own search phrase (the older planner measures exactly that phrase). Pure; callers escape.
 */
import type { ArticleBrief } from '../seo-blog/types.js';

export interface MeasuredDemand {
  readonly searches: number;
  /** The phrase the number was measured for. */
  readonly phrase: string;
  readonly retrievedAt: string | null;
}

/** The brief's measured demand with its phrase, or null when it has no usable measured number. */
export function measuredDemand(brief: Pick<ArticleBrief, 'demand' | 'seo' | 'targetQuery'> | null | undefined): MeasuredDemand | null {
  const demand = brief?.demand as ArticleBrief['demand'] | undefined;
  if (!demand || demand.kind !== 'measured') return null;
  const volume = typeof demand.volume === 'number' && Number.isFinite(demand.volume) && demand.volume >= 0 ? Math.round(demand.volume) : null;
  if (volume === null) return null;
  const bound = brief!.seo && brief!.seo.primary.basis !== 'none' && typeof brief!.seo.primary.phrase === 'string' ? brief!.seo.primary.phrase.trim() : '';
  const own = typeof brief!.targetQuery === 'string' ? brief!.targetQuery.trim() : '';
  const phrase = bound || own;
  if (!phrase) return null;
  return { searches: volume, phrase, retrievedAt: typeof demand.retrievedAt === 'string' ? demand.retrievedAt : null };
}

/** `6,600 searches a month for "landlord tax"`, as plain text (escape it where it is placed). */
export function demandSentence(d: MeasuredDemand): string {
  return `${d.searches.toLocaleString('en-GB')} searches a month for "${d.phrase}"`;
}
