import { SeoBlogError, type BrandSettings, type UsageKind } from './types.js';

export const COMPATIBLE_UNLIMITED = Number.MAX_SAFE_INTEGER;
export type LimitKey = 'modelTokens' | 'searchCalls' | 'images' | 'studioImages';
export interface OperatorLimits {
  readonly modelTokens: number | null;
  readonly searchCalls: number | null;
  readonly images: number | null;
  readonly studioImages: number | null;
  readonly configuredBy: string;
  readonly configuredAt: string;
}
export function unlimited(settings: BrandSettings, key: LimitKey): boolean {
  return settings.operatorLimits?.[key] === null;
}
export function monthlyCeiling(settings: BrandSettings, kind: UsageKind): number {
  const key = kind === 'model_tokens' ? 'modelTokens' : kind === 'search_calls' ? 'searchCalls' : 'images';
  return unlimited(settings, key) ? Infinity : kind === 'model_tokens' ? settings.budgets.modelTokensPerMonth
    : kind === 'search_calls' ? settings.budgets.searchCallsPerMonth : settings.budgets.imagesPerMonth;
}
export function limitFromForm(form: URLSearchParams, key: LimitKey): number | null {
  if (form.get(`${key}Unlimited`) === '1') return null;
  const raw = form.get(key) ?? '';
  if (!/^\d{1,10}$/u.test(raw) || Number(raw) > 1_000_000_000) throw new SeoBlogError(400, 'Use a whole-number limit or choose Unlimited.');
  return Number(raw);
}
export function enforceManagedLimits(before: BrandSettings, after: BrandSettings): void {
  if (JSON.stringify(before.operatorLimits) !== JSON.stringify(after.operatorLimits)) throw new SeoBlogError(403, 'Only the founder can change account limits.');
  const caps = before.operatorLimits;
  if (!caps) return;
  const values = { modelTokens: after.budgets.modelTokensPerMonth, searchCalls: after.budgets.searchCallsPerMonth,
    images: after.budgets.imagesPerMonth, studioImages: after.studioImages?.perMonth ?? 0 };
  for (const key of Object.keys(values) as LimitKey[]) {
    if (caps[key] !== null && values[key] > caps[key]) throw new SeoBlogError(403, 'This exceeds your account allowance. Contact your account administrator to increase it.');
  }
}
