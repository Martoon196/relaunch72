export const BRAND_BRAIN_ROUTE = '/portal/content/brain' as const;
export const BRAND_BRAIN_FOUNDER_EXPORT_ANCHOR = 'founder-exports' as const;
export const BRAND_BRAIN_QUARANTINE_ANCHOR = 'quarantine' as const;
export const BRAND_BRAIN_SOURCE_RELEASE_ANCHOR = 'source-release' as const;

export type BrandBrainReadOnlyAction =
  | 'content_library'
  | 'founder_exports'
  | 'source_release'
  | 'quarantine';

const ACTION_HREFS: Readonly<Record<BrandBrainReadOnlyAction, string>> = Object.freeze({
  content_library: '/portal/content',
  founder_exports: `${BRAND_BRAIN_ROUTE}#${BRAND_BRAIN_FOUNDER_EXPORT_ANCHOR}`,
  source_release: `${BRAND_BRAIN_ROUTE}#${BRAND_BRAIN_SOURCE_RELEASE_ANCHOR}`,
  quarantine: `${BRAND_BRAIN_ROUTE}#${BRAND_BRAIN_QUARANTINE_ANCHOR}`,
});

/**
 * Allowlisted GET-only navigation. Brand Brain deliberately exposes no POST
 * route while review and activation commands are still under backend review.
 */
export function brandBrainReadOnlyActionHref(action: BrandBrainReadOnlyAction): string {
  return ACTION_HREFS[action];
}
