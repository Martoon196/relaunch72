import type { CompanyContentCatalogItem } from '../company-content-pg/types.js';

export const SOCIAL_COMPOSER_ROUTE = '/portal/content/compose' as const;
export const SOCIAL_COMPOSER_MAX_VARIANTS = 5;
export const SOCIAL_COMPOSER_MAX_ARTWORK = 8;

export type SocialComposerChannel = 'linkedin' | 'instagram' | 'facebook' | 'x' | 'email';
export type SocialComposerPreviewMode = 'mobile' | 'desktop' | 'focus';
export type SocialComposerApprovalState = 'working_draft' | 'review_requested' | 'changes_requested';

export interface SocialComposerSourceCopy {
  readonly eyebrow: string;
  readonly headline: string;
  readonly body: string;
  readonly ctaLabel: string;
}

export interface SocialComposerVariantSnapshot {
  readonly variantId: string;
  readonly channel: SocialComposerChannel;
  readonly label: string;
  readonly headline: string;
  readonly body: string;
  readonly subject: string | null;
  readonly preheader: string | null;
  readonly ctaLabel: string;
  readonly artworkAssetId: string;
  readonly derivedFromContentVersionId: string;
  readonly derivedFromContentSha256: string;
  readonly approvalState: SocialComposerApprovalState;
}

export interface SocialComposerArtworkSnapshot {
  readonly assetId: string;
  readonly title: string;
  readonly aspectRatio: '1:1' | '4:5' | '1.91:1' | '16:9';
  readonly altText: string;
  readonly blobSha256: string;
  readonly sourceItemId: string;
  readonly channels: readonly SocialComposerChannel[];
}

export interface SocialComposerSnapshot {
  readonly catalogItem: CompanyContentCatalogItem;
  readonly sourceCopy: SocialComposerSourceCopy;
  readonly variants: readonly SocialComposerVariantSnapshot[];
  readonly artwork: readonly SocialComposerArtworkSnapshot[];
  readonly tracking: Readonly<{
    destinationUrl: string;
    campaign: string;
    content: string;
  }>;
  readonly association: Readonly<{
    offerId: string;
    offerLabel: string;
    journeyId: string;
    journeyLabel: string;
    milestoneId: string;
    milestoneLabel: string;
  }>;
}

export interface SocialComposerFilterInput {
  readonly channel?: unknown;
  readonly preview?: unknown;
}

export interface SocialComposerFiltersView {
  readonly channel: SocialComposerChannel;
  readonly preview: SocialComposerPreviewMode;
}

export interface SocialComposerCheckView {
  readonly key: string;
  readonly label: string;
  readonly detail: string;
  readonly passed: boolean;
}

export interface SocialComposerVariantView {
  readonly variantId: string;
  readonly channel: SocialComposerChannel;
  readonly channelLabel: string;
  readonly channelCode: string;
  readonly label: string;
  readonly headline: string;
  readonly body: string;
  readonly subject: string | null;
  readonly preheader: string | null;
  readonly ctaLabel: string;
  readonly artworkAssetId: string;
  readonly artworkTitle: string;
  readonly artworkAspectRatio: string;
  readonly artworkAltText: string;
  readonly approvalState: SocialComposerApprovalState;
  readonly approvalLabel: string;
  readonly characterCount: number;
  readonly characterLimit: number;
  readonly countLabel: string;
  readonly exactSourceVersion: boolean;
  readonly checks: readonly SocialComposerCheckView[];
  readonly passedChecks: number;
  readonly readyForReview: boolean;
  readonly trackingUrl: string;
}

export interface SocialComposerArtworkView extends SocialComposerArtworkSnapshot {
  readonly shortHash: string;
  readonly channelLabels: readonly string[];
  readonly selected: boolean;
}

export interface SocialComposerView {
  readonly workspaceName: string;
  readonly asOf: string;
  readonly filters: SocialComposerFiltersView;
  readonly source: Readonly<{
    title: string;
    contentItemId: string;
    contentVersionId: string;
    versionNumber: number;
    contentSha256: string;
    shortHash: string;
    brandSha256: string;
    sourceSystem: string;
    sourceItemId: string;
    sourceVersion: string;
    sourceCopy: SocialComposerSourceCopy;
    approvalLabel: string;
    sourceFreshnessLabel: string;
    eligible: boolean;
    gateDetail: string;
  }>;
  readonly selected: SocialComposerVariantView;
  readonly variants: readonly SocialComposerVariantView[];
  readonly artwork: readonly SocialComposerArtworkView[];
  readonly association: SocialComposerSnapshot['association'];
  readonly tracking: Readonly<{
    destinationUrl: string;
    campaign: string;
    content: string;
    source: string;
    medium: string;
  }>;
  readonly metrics: Readonly<{
    variants: number;
    reviewReady: number;
    artworkSlots: number;
    checksPassed: number;
    checksTotal: number;
  }>;
  readonly inputTruncated: boolean;
  readonly commandBoundaryAvailable: false;
}

const CHANNELS = new Set<SocialComposerChannel>(['linkedin', 'instagram', 'facebook', 'x', 'email']);
const PREVIEWS = new Set<SocialComposerPreviewMode>(['mobile', 'desktop', 'focus']);

const CHANNEL_META: Readonly<Record<SocialComposerChannel, Readonly<{
  label: string;
  code: string;
  limit: number;
  medium: string;
}>>> = Object.freeze({
  linkedin: { label: 'LinkedIn', code: 'in', limit: 3_000, medium: 'organic_social' },
  instagram: { label: 'Instagram', code: 'ig', limit: 2_200, medium: 'organic_social' },
  facebook: { label: 'Facebook', code: 'fb', limit: 63_206, medium: 'organic_social' },
  x: { label: 'X', code: 'x', limit: 280, medium: 'organic_social' },
  email: { label: 'Email', code: 'em', limit: 10_000, medium: 'email' },
});

const APPROVAL_LABELS: Readonly<Record<SocialComposerApprovalState, string>> = Object.freeze({
  working_draft: 'Working draft',
  review_requested: 'Review requested',
  changes_requested: 'Changes requested',
});

function validInstant(value: string): Date | null {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function characterCount(value: string): number {
  return [...value].length;
}

function bounded(value: string, max = 100_000): string {
  return value.slice(0, max);
}

function validHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function utmUrl(base: string, channel: SocialComposerChannel, campaign: string, content: string): string {
  if (!validHttpsUrl(base)) return base;
  const url = new URL(base);
  url.searchParams.set('utm_source', channel);
  url.searchParams.set('utm_medium', CHANNEL_META[channel].medium);
  url.searchParams.set('utm_campaign', campaign);
  url.searchParams.set('utm_content', content);
  return url.toString();
}

export function normaliseSocialComposerFilters(input: SocialComposerFilterInput = {}): SocialComposerFiltersView {
  return Object.freeze({
    channel: typeof input.channel === 'string' && CHANNELS.has(input.channel as SocialComposerChannel)
      ? input.channel as SocialComposerChannel
      : 'linkedin',
    preview: typeof input.preview === 'string' && PREVIEWS.has(input.preview as SocialComposerPreviewMode)
      ? input.preview as SocialComposerPreviewMode
      : 'mobile',
  });
}

function sourceGate(item: CompanyContentCatalogItem, asOf: string): Readonly<{
  eligible: boolean;
  approvalLabel: string;
  sourceFreshnessLabel: string;
  gateDetail: string;
}> {
  const now = validInstant(asOf);
  const checked = item.sourceCheckedAt ? validInstant(item.sourceCheckedAt) : null;
  const expires = item.sourceExpiresAt ? validInstant(item.sourceExpiresAt) : null;
  const approvalExact = item.approvalStatus === 'approved'
    && !item.approvalStale
    && item.approvalDecisionId !== null;
  const fresh = item.sourceFresh
    && now !== null
    && checked !== null
    && expires !== null
    && checked.getTime() <= now.getTime()
    && expires.getTime() > now.getTime();
  const immutable = isSha256(item.contentSha256) && isSha256(item.brandSha256);
  const eligible = approvalExact && fresh && immutable && item.publishable;
  const gateDetail = !immutable
    ? 'The source version or brand proof is malformed, so every derived variant is locked.'
    : !approvalExact
      ? 'The exact Affiliate Stash source version needs a current approval before review.'
      : !fresh
        ? 'Affiliate Stash source proof is missing, expired or not yet valid.'
        : !item.publishable
          ? 'The source catalogue does not mark this exact version as publishable, so every placement is locked.'
          : 'Exact approved Affiliate Stash source, immutable version and brand proof verified.';
  return Object.freeze({
    eligible,
    approvalLabel: approvalExact ? `Approved · exact v${item.versionNumber}` : 'Approval required',
    sourceFreshnessLabel: fresh ? 'Affiliate Stash proof current' : 'Source proof expired',
    gateDetail,
  });
}

function checksFor(input: Readonly<{
  snapshot: SocialComposerSnapshot;
  variant: SocialComposerVariantSnapshot;
  artwork: SocialComposerArtworkSnapshot | undefined;
  sourceEligible: boolean;
  destinationValid: boolean;
}>): readonly SocialComposerCheckView[] {
  const meta = CHANNEL_META[input.variant.channel];
  const body = bounded(input.variant.body);
  const count = characterCount(body);
  const exactSource = input.variant.derivedFromContentVersionId === input.snapshot.catalogItem.contentVersionId
    && input.variant.derivedFromContentSha256 === input.snapshot.catalogItem.contentSha256;
  const channelArtwork = input.artwork?.channels.includes(input.variant.channel) ?? false;
  const base: SocialComposerCheckView[] = [
    {
      key: 'length',
      label: 'Placement length',
      detail: `${count.toLocaleString('en-GB')} / ${meta.limit.toLocaleString('en-GB')} characters`,
      passed: count > 0 && count <= meta.limit,
    },
    {
      key: 'source',
      label: 'Exact source lineage',
      detail: exactSource ? 'Matches the immutable source version and SHA-256' : 'Source version or SHA-256 does not match',
      passed: exactSource && input.sourceEligible,
    },
    {
      key: 'artwork',
      label: 'Artwork placement',
      detail: channelArtwork ? `${input.artwork?.aspectRatio ?? ''} owned artwork selected` : 'No compatible owned artwork selected',
      passed: channelArtwork && Boolean(input.artwork?.altText.trim()) && isSha256(input.artwork?.blobSha256 ?? ''),
    },
    {
      key: 'tracking',
      label: 'Offer tracking',
      detail: input.destinationValid ? 'HTTPS destination and channel UTM set' : 'Destination must be a valid HTTPS URL',
      passed: input.destinationValid && Boolean(input.snapshot.association.offerId.trim()) && Boolean(input.snapshot.association.journeyId.trim()),
    },
  ];

  if (input.variant.channel === 'email') {
    const subjectCount = characterCount(input.variant.subject ?? '');
    base.push({
      key: 'email-envelope',
      label: 'Inbox envelope',
      detail: `Subject ${subjectCount}/60 · preheader ${characterCount(input.variant.preheader ?? '')}/100`,
      passed: subjectCount > 0 && subjectCount <= 60
        && characterCount(input.variant.preheader ?? '') > 0
        && characterCount(input.variant.preheader ?? '') <= 100,
    });
  } else if (input.variant.channel === 'instagram') {
    const hashtags = body.match(/#[\p{L}\p{N}_]+/gu) ?? [];
    base.push({
      key: 'hashtags',
      label: 'Hashtag discipline',
      detail: `${hashtags.length} focused hashtags · maximum 30`,
      passed: hashtags.length <= 30,
    });
  } else if (input.variant.channel === 'x') {
    base.push({
      key: 'x-link',
      label: 'Link allowance',
      detail: 'Destination is tracked separately; preview reserves a compact link line',
      passed: count <= meta.limit - 24,
    });
  } else {
    base.push({
      key: 'hook',
      label: 'Opening hook',
      detail: input.variant.headline.trim() ? 'Channel-specific opening line present' : 'Add a channel-specific opening line',
      passed: Boolean(input.variant.headline.trim()),
    });
  }
  return Object.freeze(base.map((check) => Object.freeze(check)));
}

export function presentSocialComposer(
  snapshot: SocialComposerSnapshot,
  options: Readonly<{
    workspaceName: string;
    asOf: string;
    filters?: SocialComposerFilterInput;
  }>,
): SocialComposerView {
  const filters = normaliseSocialComposerFilters(options.filters);
  const variants = snapshot.variants.slice(0, SOCIAL_COMPOSER_MAX_VARIANTS);
  const artwork = snapshot.artwork.slice(0, SOCIAL_COMPOSER_MAX_ARTWORK);
  const source = sourceGate(snapshot.catalogItem, options.asOf);
  const destinationValid = validHttpsUrl(snapshot.tracking.destinationUrl);
  const variantViews = variants.map((variant): SocialComposerVariantView => {
    const selectedArtwork = artwork.find((asset) => asset.assetId === variant.artworkAssetId);
    const checks = checksFor({ snapshot, variant, artwork: selectedArtwork, sourceEligible: source.eligible, destinationValid });
    const passedChecks = checks.filter((check) => check.passed).length;
    const body = bounded(variant.body);
    const meta = CHANNEL_META[variant.channel];
    return Object.freeze({
      variantId: variant.variantId,
      channel: variant.channel,
      channelLabel: meta.label,
      channelCode: meta.code,
      label: bounded(variant.label, 160),
      headline: bounded(variant.headline, 500),
      body,
      subject: variant.subject === null ? null : bounded(variant.subject, 500),
      preheader: variant.preheader === null ? null : bounded(variant.preheader, 500),
      ctaLabel: bounded(variant.ctaLabel, 160),
      artworkAssetId: variant.artworkAssetId,
      artworkTitle: selectedArtwork?.title ?? 'Artwork unavailable',
      artworkAspectRatio: selectedArtwork?.aspectRatio ?? '—',
      artworkAltText: bounded(selectedArtwork?.altText ?? '', 2_000),
      approvalState: variant.approvalState,
      approvalLabel: APPROVAL_LABELS[variant.approvalState],
      characterCount: characterCount(body),
      characterLimit: meta.limit,
      countLabel: `${characterCount(body).toLocaleString('en-GB')} / ${meta.limit.toLocaleString('en-GB')}`,
      exactSourceVersion: variant.derivedFromContentVersionId === snapshot.catalogItem.contentVersionId
        && variant.derivedFromContentSha256 === snapshot.catalogItem.contentSha256,
      checks,
      passedChecks,
      readyForReview: checks.every((check) => check.passed),
      trackingUrl: utmUrl(snapshot.tracking.destinationUrl, variant.channel, snapshot.tracking.campaign, snapshot.tracking.content),
    });
  });
  const selected = variantViews.find((variant) => variant.channel === filters.channel)
    ?? variantViews[0];
  if (!selected) throw new Error('Social Composer requires at least one bounded channel variant');

  const selectedArtworkId = selected.artworkAssetId;
  const artworkViews = artwork.map((asset): SocialComposerArtworkView => Object.freeze({
    ...asset,
    title: bounded(asset.title, 300),
    altText: bounded(asset.altText, 2_000),
    shortHash: asset.blobSha256.slice(0, 12),
    channelLabels: Object.freeze(asset.channels.map((channel) => CHANNEL_META[channel].label)),
    selected: asset.assetId === selectedArtworkId,
  }));
  const checksTotal = variantViews.reduce((sum, variant) => sum + variant.checks.length, 0);
  const checksPassed = variantViews.reduce((sum, variant) => sum + variant.passedChecks, 0);

  return Object.freeze({
    workspaceName: bounded(options.workspaceName, 200),
    asOf: options.asOf,
    filters,
    source: Object.freeze({
      title: bounded(snapshot.catalogItem.title, 500),
      contentItemId: snapshot.catalogItem.contentItemId,
      contentVersionId: snapshot.catalogItem.contentVersionId,
      versionNumber: snapshot.catalogItem.versionNumber,
      contentSha256: snapshot.catalogItem.contentSha256,
      shortHash: snapshot.catalogItem.contentSha256.slice(0, 12),
      brandSha256: snapshot.catalogItem.brandSha256,
      sourceSystem: snapshot.catalogItem.source.system,
      sourceItemId: snapshot.catalogItem.source.itemId,
      sourceVersion: snapshot.catalogItem.source.version,
      sourceCopy: Object.freeze({
        eyebrow: bounded(snapshot.sourceCopy.eyebrow, 300),
        headline: bounded(snapshot.sourceCopy.headline, 1_000),
        body: bounded(snapshot.sourceCopy.body),
        ctaLabel: bounded(snapshot.sourceCopy.ctaLabel, 160),
      }),
      approvalLabel: source.approvalLabel,
      sourceFreshnessLabel: source.sourceFreshnessLabel,
      eligible: source.eligible,
      gateDetail: source.gateDetail,
    }),
    selected,
    variants: Object.freeze(variantViews),
    artwork: Object.freeze(artworkViews),
    association: Object.freeze({ ...snapshot.association }),
    tracking: Object.freeze({
      destinationUrl: bounded(snapshot.tracking.destinationUrl, 2_000),
      campaign: bounded(snapshot.tracking.campaign, 300),
      content: bounded(snapshot.tracking.content, 300),
      source: selected.channel,
      medium: CHANNEL_META[selected.channel].medium,
    }),
    metrics: Object.freeze({
      variants: variantViews.length,
      reviewReady: variantViews.filter((variant) => variant.readyForReview).length,
      artworkSlots: artworkViews.length,
      checksPassed,
      checksTotal,
    }),
    inputTruncated: snapshot.variants.length > SOCIAL_COMPOSER_MAX_VARIANTS
      || snapshot.artwork.length > SOCIAL_COMPOSER_MAX_ARTWORK,
    commandBoundaryAvailable: false,
  });
}
