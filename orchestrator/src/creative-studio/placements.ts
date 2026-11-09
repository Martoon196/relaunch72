/**
 * Placement recipes for finished artwork. These are layout recipes, not a claim
 * that every network accepts every size: delivery checks stay with each
 * existing channel integration. Safe areas reserve space that platform UI
 * commonly overlays (for example, the top and bottom of vertical stories).
 */
export type PlacementId = 'square' | 'portrait' | 'vertical' | 'landscape' | 'article';
export type PlacementLayout = 'stack' | 'side';

export interface Placement {
  readonly id: PlacementId;
  readonly label: string;
  readonly use: string;
  readonly width: number;
  readonly height: number;
  readonly layout: PlacementLayout;
  /** Fractions of width (left/right) and height (top/bottom). */
  readonly safe: Readonly<{ top: number; right: number; bottom: number; left: number }>;
  /** Headline px bounds at this canvas width. */
  readonly headline: Readonly<{ max: number; min: number; maxLines: number }>;
  readonly body: Readonly<{ size: number; maxLines: number }>;
}

const p = (value: Placement): Placement => Object.freeze({ ...value, safe: Object.freeze(value.safe), headline: Object.freeze(value.headline), body: Object.freeze(value.body) });

export const PLACEMENTS: Readonly<Record<PlacementId, Placement>> = Object.freeze({
  square: p({ id: 'square', label: 'Square feed', use: 'Instagram/Facebook/LinkedIn feed (1:1)', width: 1080, height: 1080, layout: 'stack',
    safe: { top: 0.065, right: 0.065, bottom: 0.065, left: 0.065 }, headline: { max: 88, min: 46, maxLines: 4 }, body: { size: 34, maxLines: 3 } }),
  portrait: p({ id: 'portrait', label: 'Portrait feed', use: 'Instagram/Facebook feed (4:5)', width: 1080, height: 1350, layout: 'stack',
    safe: { top: 0.06, right: 0.065, bottom: 0.07, left: 0.065 }, headline: { max: 96, min: 48, maxLines: 4 }, body: { size: 36, maxLines: 4 } }),
  vertical: p({ id: 'vertical', label: 'Vertical story', use: 'Stories/Reels/Shorts cover (9:16)', width: 1080, height: 1920, layout: 'stack',
    safe: { top: 0.14, right: 0.08, bottom: 0.2, left: 0.08 }, headline: { max: 104, min: 52, maxLines: 5 }, body: { size: 38, maxLines: 4 } }),
  landscape: p({ id: 'landscape', label: 'Landscape link', use: 'Link/LinkedIn/Facebook landscape (1.91:1)', width: 1200, height: 628, layout: 'side',
    safe: { top: 0.09, right: 0.05, bottom: 0.09, left: 0.05 }, headline: { max: 64, min: 34, maxLines: 3 }, body: { size: 26, maxLines: 2 } }),
  article: p({ id: 'article', label: 'Article hero', use: 'Blog/article header (16:9)', width: 1600, height: 900, layout: 'side',
    safe: { top: 0.08, right: 0.05, bottom: 0.08, left: 0.05 }, headline: { max: 80, min: 40, maxLines: 3 }, body: { size: 32, maxLines: 2 } }),
});

export const PLACEMENT_IDS = Object.freeze(Object.keys(PLACEMENTS) as PlacementId[]);
export function isPlacementId(value: unknown): value is PlacementId {
  return typeof value === 'string' && Object.hasOwn(PLACEMENTS, value);
}
