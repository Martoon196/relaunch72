/**
 * Resolve the creative brand context from the existing multi-brand Brand Brain
 * (SEO-programme brand, confirmed profile, active knowledge) plus the
 * owner-confirmed creative kit. Nothing here is brand-specific: two brands
 * resolve through the same code from their own workspace rows only.
 *
 * Essential facts (confirmation, offers, destinations) are never invented: a
 * missing one is reported as a gap. Missing decorative preferences use a
 * clearly labelled neutral fallback.
 */
import { createHash } from 'node:crypto';
import type { Brand, BrandProfile, KnowledgeDocument, ProfileOffer } from '../seo-blog/types.js';
import type { BrandKit, CreativePurpose, CreativeSource, Palette, CreativeTypography } from './types.js';

export const NEUTRAL_PALETTE: Palette = Object.freeze({ primary: '#3a4a63', accent: '#f4f6f8', dark: '#121820', light: '#ffffff' });

export interface ContextGap {
  readonly field: string;
  readonly detail: string;
  readonly action: string;
}

export interface CreativeBrandContext {
  readonly brandId: string;
  readonly brandName: string;
  readonly website: string | null;
  readonly profileVersion: number | null;
  readonly factsSha: string | null;
  readonly confirmed: boolean;
  readonly positioning: string;
  readonly summary: string;
  readonly voice: Readonly<{ tone: readonly string[]; do: readonly string[]; dont: readonly string[] }>;
  readonly audiences: readonly string[];
  readonly offers: readonly ProfileOffer[];
  readonly approvedClaims: readonly string[];
  readonly restricted: readonly string[];
  readonly destinations: readonly Readonly<{ url: string; label: string }>[];
  readonly palette: Palette;
  readonly typography?: CreativeTypography;
  readonly paletteSource: 'brand_kit' | 'neutral_fallback';
  readonly logo: BrandKit['logo'];
  readonly disclosure: string | null;
  readonly kitVersion: number;
  /** Colours mentioned in visual-guidance documents: suggestions only, never applied without owner confirmation. */
  readonly suggestedColours: readonly string[];
  readonly visualGuidance: string | null;
  readonly decorativeGaps: readonly ContextGap[];
  /** Invalidation key: profile version + facts digest + kit version/digest. */
  readonly contextSha256: string;
}

const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

export function resolveCreativeContext(input: {
  readonly brand: Pick<Brand, 'id' | 'name' | 'website'>;
  readonly profile: BrandProfile | null;
  readonly knowledge: readonly KnowledgeDocument[];
  readonly kit: BrandKit | null;
}): CreativeBrandContext {
  const { brand, profile, kit } = input;
  if (profile && profile.brandId !== brand.id) throw new Error('Profile belongs to another brand.');
  if (kit && kit.brandId !== brand.id) throw new Error('Creative kit belongs to another brand.');
  const latest = new Map<string, KnowledgeDocument>();
  for (const doc of input.knowledge) {
    if (doc.brandId !== brand.id) throw new Error('Knowledge belongs to another brand.');
    if (!latest.has(doc.id) || latest.get(doc.id)!.version < doc.version) latest.set(doc.id, doc);
  }
  const active = [...latest.values()].filter((d) => d.active);
  // Mirrors app_private.seo_creator_profile: confirmed, conflict-free and bound to exactly the active knowledge.
  const usable = Boolean(profile?.confirmedAt) && (profile?.conflicts.length ?? 1) === 0
    && profile!.knowledge.length === active.length
    && active.every((d) => profile!.knowledge.some((k) => k.documentId === d.id && k.version === d.version && k.sha256 === d.sha256));
  const visual = [...latest.values()].filter((d) => d.active && d.category === 'visual_guidance' && d.text).map((d) => d.text!).join('\n');
  const suggestedColours = [...new Set([...visual.matchAll(/#[0-9a-f]{6}\b/giu)].map((m) => m[0].toLowerCase()))].slice(0, 8);
  const decorativeGaps: ContextGap[] = [];
  if (!kit) decorativeGaps.push({ field: 'palette', detail: 'No brand colours are confirmed for creative work, so a neutral grey-blue fallback palette is used and labelled.', action: 'Confirm brand colours in the creative kit.' });
  if (!kit?.logo) decorativeGaps.push({ field: 'logo', detail: 'No approved logo file is on record, so the brand name is set in plain text instead. A logo is never drawn by a model.', action: 'Upload the approved logo (PNG or JPEG).' });
  if (!visual) decorativeGaps.push({ field: 'visual_guidance', detail: 'No visual guidance document is active.', action: 'Optional: add visual guidance in Setup.' });
  const contextSha256 = sha(JSON.stringify({ recipe: 'creative-context-v1', brandId: brand.id, brandName: brand.name,
    profileVersion: profile?.version ?? null, factsSha: profile?.factsSha ?? null, confirmedAt: profile?.confirmedAt ?? null,
    kitVersion: kit?.version ?? 0, kitSha: kit?.sha256 ?? null }));
  return Object.freeze({
    brandId: brand.id, brandName: brand.name, website: brand.website,
    profileVersion: profile?.version ?? null, factsSha: profile?.factsSha ?? null, confirmed: usable,
    positioning: profile?.positioning ?? '', summary: profile?.summary ?? '',
    voice: Object.freeze({ tone: profile?.voice.tone ?? [], do: profile?.voice.do ?? [], dont: profile?.voice.dont ?? [] }),
    audiences: profile?.audiences ?? [], offers: profile?.offers ?? [], approvedClaims: profile?.approvedClaims ?? [],
    restricted: Object.freeze([...(profile?.exclusions ?? []), ...(kit?.restrictedPhrases ?? [])]),
    destinations: profile?.conversionPages ?? [],
    typography: kit?.typography ?? 'inter',
    palette: kit?.palette ?? NEUTRAL_PALETTE, paletteSource: kit ? 'brand_kit' : 'neutral_fallback',
    logo: kit?.logo ?? null, disclosure: kit?.disclosure ?? null, kitVersion: kit?.version ?? 0,
    suggestedColours: Object.freeze(suggestedColours), visualGuidance: visual ? visual.slice(0, 1200) : null,
    decorativeGaps: Object.freeze(decorativeGaps), contextSha256,
  });
}

/** Essential facts this request needs. Any entry blocks drafting; nothing is invented to fill it. */
export function essentialGaps(context: CreativeBrandContext, purpose: CreativePurpose, source: CreativeSource, destination: { url: string } | null): ContextGap[] {
  const gaps: ContextGap[] = [];
  if (!context.confirmed) gaps.push({ field: 'profile', detail: 'The brand profile is not confirmed against the current knowledge (it is unconfirmed, has open conflicts, or a document changed since confirmation), so its facts cannot be used in creative work yet.', action: 'Review and confirm the profile in Setup.' });
  if (source.kind === 'offer' && !context.offers.some((o) => o.name === source.name)) gaps.push({ field: 'offer', detail: context.offers.length ? 'That offer is not in the confirmed profile.' : 'The confirmed profile lists no offers or products, so an offer-led creative cannot be drafted.', action: 'Add the offer to a product-facts document and re-confirm the profile, or use a written brief.' });
  if (purpose === 'article_image' && source.kind !== 'article') gaps.push({ field: 'article', detail: 'An article image needs an existing article as its source.', action: 'Choose an article.' });
  if ((purpose === 'advert' || purpose === 'product_promotion') && !destination) gaps.push({ field: 'destination', detail: context.destinations.length ? 'Choose where the advert should send people.' : 'The confirmed profile has no approved destination page, and an advert needs one.', action: 'Add a conversion page to the profile, then choose it here.' });
  if (destination && !context.destinations.some((d) => d.url === destination.url)) gaps.push({ field: 'destination', detail: 'That destination is not one of the brand\'s approved conversion pages.', action: 'Choose an approved destination.' });
  return gaps;
}
