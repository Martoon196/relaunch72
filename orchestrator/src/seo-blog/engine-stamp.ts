/**
 * "Engine verifiably on": which parts of the article engine ran for a plan, a brief and an article version, and the
 * strict setting that stops planning and writing rather than quietly producing a weaker article.
 *
 * - One credential resolution for research and search numbers (`researchCredentials`), so a deployment that sets only
 *   the scoped names gets both, not research alone.
 * - `SEO_BLOG_REQUIRE_FULL_ENGINE=true` (off by default) turns each silent fallback into a stop with a neutral owner
 *   message. With it off nothing stops that did not stop before.
 * - The engine stamp is recorded on every plan, brief and version (outside the article body, so content hashes are
 *   unchanged). It is internal: it is never rendered for a business owner and names no supplier, method or model.
 *
 * Owner-facing wording here is plain English and names no mechanism.
 */

import { SeoBlogError, type EngineStamp, type EngineMethodState, type EngineNumbersState, type IsoInstant } from './types.js';
import type { KeywordMetric } from '../keyword/types.js';

export const FULL_ENGINE_FLAG = 'SEO_BLOG_REQUIRE_FULL_ENGINE';

/** The strict setting: true only for the exact value "true". */
export function fullEngineRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[FULL_ENGINE_FLAG]?.trim() === 'true';
}

export interface ResearchCredentials { readonly login: string; readonly password: string }

/**
 * The one place research and search numbers find their supplier credentials: the scoped names
 * (SEO_BLOG_DATAFORSEO_LOGIN / _PASSWORD) first, then the shared ones (DATAFORSEO_LOGIN / _PASSWORD), field by field,
 * exactly as research has always resolved them. Null when either is missing.
 */
export function researchCredentials(env: NodeJS.ProcessEnv = process.env): ResearchCredentials | null {
  const login = env.SEO_BLOG_DATAFORSEO_LOGIN ?? env.DATAFORSEO_LOGIN ?? '';
  const password = env.SEO_BLOG_DATAFORSEO_PASSWORD ?? env.DATAFORSEO_PASSWORD ?? '';
  return login && password ? { login, password } : null;
}

/** How the search numbers went for one research run. */
export function numbersState(provider: { readonly mode: 'mock' | 'live' } | null | undefined, outcome: { failed: boolean; metrics: readonly KeywordMetric[] }): EngineNumbersState {
  if (!provider || provider.mode !== 'live') return 'off';
  if (outcome.failed) return 'unavailable';
  return outcome.metrics.some((m) => m.source !== 'mock' && typeof m.volume === 'number') ? 'measured' : 'no_data';
}

/** The stamp for a brief: measured when its own phrase was measured; otherwise how numbers went for its plan. */
export function briefNumbers(plan: EngineNumbersState, measured: boolean): EngineNumbersState {
  if (measured) return 'measured';
  return plan === 'measured' ? 'no_data' : plan;
}

export function engineStamp(input: { strict: boolean; research: EngineStamp['research']; numbers: EngineNumbersState; method: EngineMethodState; methodReceiptId?: string | null; at: IsoInstant }): EngineStamp {
  return { schema: 1, strict: input.strict, research: input.research, numbers: input.numbers, method: input.method, methodReceiptId: input.methodReceiptId ?? null, at: input.at };
}

/** At least this many usable sources before a plan may go on under the strict setting. */
export const MIN_PLAN_SOURCES = 3;

/** Why the strict setting stopped (internal; the owner sees only the neutral message). */
export type EngineGap = 'research' | 'numbers' | 'numbers_off' | 'numbers_allowance' | 'thin_research' | 'method' | 'planned_without_numbers';

/** Neutral owner messages: no supplier, method, model or mechanism. */
export const ENGINE_GAP_MESSAGE: Record<EngineGap, string> = {
  research: 'Topic research is not available right now, so planning is paused. Nothing has been spent. We will pick it up once it is back.',
  numbers: 'We could not check how many people search for these topics just now, so planning is paused rather than guessing. Nothing has been spent on writing. To check again, press Retry beside this planning task in Activity. Your saved searches are reused.',
  numbers_off: 'Checking how many people search for these topics is not switched on for this business yet, so planning is paused rather than guessing. Nothing has been spent. Please ask us to check your set-up.',
  numbers_allowance: 'There is not enough research allowance left this month to check how many people search for these topics, so planning is paused rather than guessing. Nothing has been spent on writing. Once the allowance is raised in Settings or renews next month, press Retry beside this planning task in Activity.',
  thin_research: 'We did not find enough trustworthy sources to plan these articles properly, so planning is paused rather than going ahead on thin evidence. Nothing has been spent on writing. To try again, start a new plan in Topics, ideally with a focus, and confirm the fresh search it asks for.',
  method: 'Your writing standard is not switched on for this business right now, so this was paused rather than written to a lower standard. Nothing has been spent. Please ask us to check your set-up.',
  planned_without_numbers: 'This article was planned without checking how many people search for it, so it is paused rather than written without that. Nothing has been spent. Please ask us to check it.',
};

/** Thrown when the strict setting stops planning or writing. A 409, so jobs hold (they are not retried automatically). */
export class EngineIncompleteError extends SeoBlogError {
  constructor(readonly gap: EngineGap) {
    super(409, ENGINE_GAP_MESSAGE[gap], 'engine_incomplete');
    this.name = 'EngineIncompleteError';
  }
}
