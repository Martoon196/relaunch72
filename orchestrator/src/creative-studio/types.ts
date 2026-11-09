import type { PlacementId } from './placements.js';

export const CREATIVE_PURPOSES = ['advert', 'organic_social', 'article_image', 'product_promotion', 'carousel'] as const;
export type CreativePurpose = typeof CREATIVE_PURPOSES[number];
export const PURPOSE_LABELS: Readonly<Record<CreativePurpose, string>> = Object.freeze({
  advert: 'Advert', organic_social: 'Organic social post', article_image: 'Article image',
  product_promotion: 'Product promotion', carousel: 'Carousel',
});

export interface Palette {
  readonly primary: string;
  readonly accent: string;
  readonly dark: string;
  readonly light: string;
}

export interface StoredImageRef {
  readonly blobId: string;
  readonly sha256: string;
  readonly mime: 'image/jpeg' | 'image/png';
  readonly width: number;
  readonly height: number;
}

/** Owner-confirmed decorative and compliance settings. Immutable versions. */
export interface BrandKit {
  readonly brandId: string;
  readonly version: number;
  readonly palette: Palette;
  readonly logo: (StoredImageRef & { readonly label: string }) | null;
  /** Required disclosure applied to every artwork for this brand, rendered deterministically. */
  readonly disclosure: string | null;
  /** Extra phrases this brand must never use in creative copy. */
  readonly restrictedPhrases: readonly string[];
  readonly sha256: string;
  readonly createdBy: string;
  readonly createdAt: string;
}

export type CreativeSource =
  | { readonly kind: 'offer'; readonly name: string }
  | { readonly kind: 'article'; readonly articleId: string; readonly articleVersionId: string; readonly title: string }
  | { readonly kind: 'brief'; readonly text: string };

export interface CreativeRequest {
  readonly purpose: CreativePurpose;
  readonly source: CreativeSource;
  readonly audience: string | null;
  readonly destination: Readonly<{ url: string; label: string }> | null;
  readonly placements: readonly PlacementId[];
  readonly conceptCount: number;
  /** Carousel only: coordinated cards per concept. */
  readonly cardCount: number;
}

export type BackgroundComponent =
  | { readonly kind: 'neutral' }
  | { readonly kind: 'image'; readonly image: StoredImageRef; readonly origin: 'owner_upload' | 'generated_article_image';
      readonly label: string; readonly provenance: Readonly<Record<string, string>> };

/** Concept-level components shared by every placement and card of one concept. */
export interface ConceptComponents {
  readonly angle: string;
  readonly hook: string;
  readonly headline: string;
  readonly body: string;
  readonly cta: string;
  readonly background: BackgroundComponent;
  /** Visible "Illustrative image" marker on generated scenes. */
  readonly illustrativeTag: boolean;
  /** Carousel cards (empty for single images). Card 1 uses hook/headline; the last card carries the CTA. */
  readonly cards: readonly Readonly<{ headline: string; body: string }>[];
}

/** Placement-level components. */
export interface VariantComponents {
  readonly focal: Readonly<{ x: number; y: number }>;
}

export type IssueCode = 'text_overflow' | 'low_contrast' | 'cta_contrast' | 'unsupported_figure' | 'restricted_phrase' | 'missing_essential';
export interface ArtworkIssue {
  readonly code: IssueCode;
  readonly blocking: boolean;
  readonly detail: string;
}

export interface RenderReceipt {
  readonly rendererVersion: string;
  readonly blobId: string;
  readonly sha256: string;
  readonly mime: 'image/jpeg';
  readonly width: number;
  readonly height: number;
  readonly byteLength: number;
  readonly contrast: Readonly<Record<string, number>>;
  readonly scrimAlpha: number;
  readonly headlineSize: number;
}

export interface CreativeVersion {
  readonly id: string;
  readonly setId: string;
  readonly brandId: string;
  readonly conceptKey: string;
  readonly placement: PlacementId;
  /** 0 for single images; 1..n for carousel cards. */
  readonly card: number;
  readonly number: number;
  readonly parentVersionId: string | null;
  readonly change: string;
  readonly concept: ConceptComponents;
  readonly variant: VariantComponents;
  /** Exact brand inputs this version was rendered from; the database rechecks them before approval or hand-off. */
  readonly context: ContextInputs;
  readonly componentShas: Readonly<Record<string, string>>;
  readonly specSha256: string;
  readonly contextSha256: string;
  readonly render: RenderReceipt;
  readonly issues: readonly ArtworkIssue[];
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface ContextInputs {
  readonly profileVersion: number;
  readonly factsSha: string;
  readonly kitVersion: number;
}

export interface CreativeApproval {
  readonly id: string;
  readonly versionId: string;
  readonly context: ContextInputs;
  readonly renderSha256: string;
  readonly specSha256: string;
  readonly contextSha256: string;
  /** Owner confirmed figures that are not in approved brand facts. */
  readonly figuresConfirmed: boolean;
  /** Approval covers this exact image only — never captions, campaigns, schedules or paid ads. */
  readonly scope: 'image_only';
  readonly approvedBy: string;
  readonly approvedAt: string;
}

export interface CreativeHandoff {
  readonly id: string;
  readonly versionId: string;
  readonly approvalId: string;
  readonly target: Readonly<{ kind: 'article_campaign'; articleId: string } | { kind: 'creator_campaign'; campaignId: string }>;
  /** Draft hand-off only: nothing is published, scheduled or spent. */
  readonly state: 'ready_for_review';
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface CreativeSet {
  readonly id: string;
  readonly brandId: string;
  readonly request: CreativeRequest;
  readonly requestSha256: string;
  readonly contextSha256: string;
  readonly createdBy: string;
  readonly createdAt: string;
}
