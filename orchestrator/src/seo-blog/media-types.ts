/** Private image storage and reviewed-publication capabilities; no provider or scheduler. */
export const SEO_MEDIA_MANIFEST_SCHEMA = 'relaunch72.seo-media/v1' as const;
export const SEO_MEDIA_PUBLIC_PATH = '/api/public/seo-blog/media/' as const;
export const SEO_IMAGE_SOURCE_RECIPE = 'seo-image-source-v1' as const;
export type SeoMediaSha256 = string;
export type SeoMediaProfile = 'blog' | 'instagram' | 'linkedin';
export interface SeoMediaRecipe {
  readonly version: 'r72-jpeg-focal-v1';
  readonly sourceSha256: SeoMediaSha256;
  readonly profile: SeoMediaProfile;
  readonly focal: Readonly<{ x: number; y: number }>;
  readonly crop: Readonly<{ x: number; y: number; width: number; height: number }>;
  readonly width: number;
  readonly height: number;
  readonly quality: number;
  readonly metadataStripped: true;
}
export interface SeoMediaProvenance {
  readonly kind: 'uploaded' | 'generated';
  /** The exact private brand snapshot used for this candidate; not an approval. */
  readonly brandSha256: SeoMediaSha256;
  readonly sourceName: string;
  readonly generation?: Readonly<{ intentId: string; nonce: string; requestSha256: string }>;
}
export interface SeoMediaCandidateInput {
  readonly commandId: string;
  readonly bytes: Uint8Array;
  readonly provenance: SeoMediaProvenance;
  /** Safe transport evidence only. Prompts, credentials, raw error bodies and bytes do not belong here. */
  readonly receipt: Readonly<Record<string, unknown>>;
}
export interface SeoMediaAsset {
  readonly id: string;
  readonly workspaceId: string;
  readonly blobId: string;
  readonly kind: 'candidate' | 'variant';
  readonly validation: 'candidate_only' | 'prepared_jpeg';
  readonly sha256: SeoMediaSha256;
  readonly byteLength: number;
  readonly mimeType: 'image/jpeg';
  readonly width: number | null;
  readonly height: number | null;
  readonly sourceAssetId: string | null;
  readonly recipe: SeoMediaRecipe | null;
  readonly provenance: SeoMediaProvenance;
  readonly createdAt: string;
}
export interface SeoMediaVariantInput {
  readonly bytes: Uint8Array;
  readonly recipe: SeoMediaRecipe;
}
export type SeoMediaPreparationInput = Readonly<{
  commandId: string;
  sourceAssetId: string;
  sourceSha256: SeoMediaSha256;
}> & (
  | Readonly<{ outcome: 'prepared'; sourceDimensions: Readonly<{ width: number; height: number }>; variants: readonly SeoMediaVariantInput[]; detail: null }>
  | Readonly<{ outcome: 'rejected'; sourceDimensions: null; variants: readonly []; detail: string }>
);
export interface SeoMediaPreparation {
  readonly id: string;
  readonly workspaceId: string;
  readonly sourceAssetId: string;
  readonly sourceSha256: string;
  readonly sourceDimensions: Readonly<{width:number;height:number}> | null;
  readonly outcome: 'prepared' | 'rejected';
  readonly variants: readonly SeoMediaAsset[];
  readonly detail: string | null;
}
/** Canonical kind=image review is the quality authority, not a new approved=true flag. */
export interface SeoMediaCanonicalApproval {
  readonly contentItemId: string;
  readonly contentVersionId: string;
  readonly contentSha256: string;
  readonly approvalRequestId: string;
  readonly approvalDecisionId: string;
}
export interface SeoMediaPresentation {
  readonly profile: 'blog';
  readonly slot: 'hero';
  readonly alt: string;
}
/** This is allocated BEFORE the URL enters an immutable article/target/review hash. Still private/404. */
export interface SeoMediaUseReservation {
  readonly commandId: string;
  readonly workspaceId: string;
  readonly articleId: string;
  readonly assetId: string;
  readonly assetSha256: string;
  readonly prospectiveReleaseId: string;
  readonly prospectiveUrl: string;
  readonly presentation: SeoMediaPresentation;
}
export interface SeoMediaUseInput {
  readonly commandId: string;
  readonly articleId: string;
  readonly assetId: string;
  readonly assetSha256: string;
  readonly presentation: SeoMediaPresentation;
}
export interface SeoMediaAuthorizationInput {
  readonly commandId: string;
  readonly reservationCommandId: string;
  /** FINAL version after target review, never blindly inherited from a parent draft. */
  readonly articleVersionId: string;
  readonly articleContentSha256: string;
  readonly reviewedIntentSha256: string;
  readonly canonical: SeoMediaCanonicalApproval;
}
export interface SeoMediaOwnerAuthorization {
  readonly useKind:'blog_hero';
  readonly id: string;
  readonly workspaceId: string;
  readonly reservationCommandId: string;
  readonly assetId: string;
  readonly assetSha256: string;
  readonly articleVersionId: string;
  readonly articleContentSha256: string;
  readonly reviewedIntentSha256: string;
  readonly authorizingUserId: string;
  readonly canonical: SeoMediaCanonicalApproval;
}
export interface SeoMediaReleaseInput {
  readonly publicationId: string;
  readonly ownerAuthorizationId: string;
  readonly reviewedIntentSha256: string;
}
export interface SeoMediaPublicRelease {
  /** Stable prospective route ID already present in the reviewed article. */
  readonly id: string;
  /** Append-only binding of that route to this actual publication operation. */
  readonly bindingId: string;
  readonly workspaceId: string;
  readonly publicationId: string;
  readonly ownerAuthorizationId: string;
  readonly assetId: string;
  readonly assetSha256: string;
  readonly publicUrl: string;
  readonly mimeType: 'image/jpeg';
  readonly width: number;
  readonly height: number;
  readonly alt: string;
}
export type SeoMediaWithdrawalInput = Readonly<{ commandId: string; reason: string }> & (
  | Readonly<{ scope: 'asset'; assetId: string; assetSha256: string }>
  | Readonly<{ scope: 'release'; releaseId: string; assetSha256: string }>
);
export interface SeoMediaWithdrawal {
  readonly id: string;
  readonly scope: 'asset' | 'release';
  readonly targetId: string;
  readonly assetSha256: string;
  readonly withdrawnAt: string;
}
export interface SeoMediaPrivateBytes {
  readonly asset: SeoMediaAsset;
  /** Copy-owned private bytes; the caller must not expose a candidate as approved content. */
  readonly bytes: Buffer;
}
export interface SeoMediaReleasedBytes {
  readonly releaseId: string;
  readonly sha256: string;
  readonly mimeType: 'image/jpeg';
  readonly bytes: Buffer;
}
/** Versioned canonical image manifest, assembled from stored asset data, not caller assertions. */
export interface SeoMediaCanonicalManifest {
  readonly schema: typeof SEO_MEDIA_MANIFEST_SCHEMA;
  readonly assetId: string;
  readonly byteSha256: string;
  readonly byteLength: number;
  readonly mimeType: 'image/jpeg';
  readonly width: number;
  readonly height: number;
  readonly recipe: SeoMediaRecipe;
  readonly presentation: Readonly<{profile:SeoMediaProfile;alt:string}>;
  readonly provenance: SeoMediaProvenance;
}

/** Operator reservations are conservative headroom, not provider invoices. */
export interface SeoImageOperatorPolicy {
  readonly version: number;
  readonly sha256: string;
  readonly enabled: boolean;
  readonly model: 'gpt-image-2';
  readonly quality: 'medium';
  readonly maxConcurrency: number;
  readonly monthlyMicrousd: number;
  readonly perAttemptMicrousd: number;
  readonly admissionEpoch: number;
}
export interface SeoImageSourceSnapshot {
  readonly recipe: typeof SEO_IMAGE_SOURCE_RECIPE;
  readonly workspaceId: string;
  readonly articleId: string;
  readonly articleVersionId: string;
  readonly articleContentSha256: string;
  /** DB recipe hashes; never aliases for JavaScript programmeSha or raw concatenation. */
  readonly sourceSha256: string;
  readonly profileSha256: string;
  readonly visualSha256: string;
  readonly snapshot: Readonly<Record<string, unknown>>;
}
export interface SeoImageIntentInput {
  readonly commandId:string;
  readonly jobId: string;
  readonly intentId: string;
  readonly intentSha256: string;
  readonly requestSha256: string;
  readonly expectedPolicyVersion: number;
  readonly expectedPolicySha256: string;
  readonly model: 'gpt-image-2';
  readonly quality: 'medium';
  readonly sponsorUserId: string;
  readonly privateCommand: Readonly<{ brandId: string; actorId: string; prompt: string }>;
  readonly confirmedNewIntent?:boolean;
  readonly replacesIntentId?:string|null;
  readonly source: SeoImageSourceSnapshot;
}
export interface SeoImageRequestAlias {
  readonly commandId:string;
  readonly requestedBy:string;
  readonly origin:'owner'|'programme';
  readonly articleId:string;
  readonly articleVersionId:string;
}
export interface SeoImageRequestLookup {
  readonly commandId:string;
  readonly articleId:string;
  readonly articleVersionId:string;
  readonly origin:'owner'|'programme';
}
export interface SeoImageAttemptInput {
  readonly workspaceId: string;
  readonly jobId: string;
  readonly intentId: string;
  readonly nonce: string;
  readonly leaseOwner: string;
  readonly leaseAttempt: number;
  readonly expectedPolicyVersion: number;
  readonly expectedPolicySha256: string;
  readonly requestSha256: string;
  readonly intentSha256: string;
  readonly providerConfigured: boolean;
  readonly sourceSha256: string;
  readonly profileSha256: string;
  readonly visualSha256: string;
  readonly articleId: string;
  readonly articleVersionId: string;
  readonly articleContentSha256: string;
  readonly sponsorUserId: string;
  readonly sourceSnapshotVersion: typeof SEO_IMAGE_SOURCE_RECIPE;
}
export interface SeoImageAttemptReceiptInput {
  readonly workspaceId: string;
  readonly attemptId: string;
  readonly nonce: string;
  readonly requestSha256: string;
  readonly leaseOwner: string;
  readonly leaseAttempt: number;
  readonly receipt: Readonly<Record<string, unknown>>;
  readonly observedCandidateSha256?: string | null;
  /** Stored atomically with receipt before any decode/crop. */
  readonly candidate?: Readonly<{ bytes: Uint8Array; provenance: SeoMediaProvenance }>;
}
export type SeoImageAttemptDecision =
  | Readonly<{ kind: 'admitted'; attemptId: string; nonce: string; policy: SeoImageOperatorPolicy }>
  | Readonly<{ kind: 'existing_started'; attemptId: string; nonce: string; reason: 'outcome_unknown' }>
  | Readonly<{ kind: 'existing_receipt'; attemptId: string; nonce: string; receipt: Readonly<Record<string, unknown>>; candidate: SeoMediaAsset | null; applyEligible: boolean; hold: string | null }>
  | Readonly<{ kind: 'held'; reason: string }>;
export interface SeoImageReceiptResult {
  readonly attemptId: string;
  readonly nonce: string;
  readonly candidate: SeoMediaAsset | null;
  readonly receipt: Readonly<Record<string, unknown>>;
  readonly applyEligible: boolean;
  readonly hold: string | null;
}
export interface SeoImagePreparedVariantRef {
  readonly assetId:string;
  readonly sha256:string;
  readonly profile:SeoMediaProfile;
}
export interface SeoImageApplyInput {
  readonly workspaceId:string;
  readonly attemptId:string;
  readonly nonce:string;
  /** The caller's CURRENT claim, never adopted from a newer snapshot by a stale worker. */
  readonly leaseOwner:string;
  readonly leaseAttempt:number;
  readonly candidateAssetId:string;
  readonly candidateSha256:string;
  readonly variants:readonly SeoImagePreparedVariantRef[];
}
export interface SeoImageVerifiedPreparation {
  readonly candidate:SeoMediaAsset;
  readonly variants:readonly SeoMediaAsset[];
}
export interface SeoMediaAssetManifestInput {
  readonly assetId:string;
  readonly assetSha256:string;
  readonly profile:SeoMediaProfile;
  readonly alt:string;
}
export interface SeoMediaSocialUseInput extends SeoMediaAssetManifestInput {
  readonly commandId:string;
  readonly useId:string;
  readonly articleId:string;
  readonly articleVersionId:string;
  readonly articleContentSha:string;
  readonly variantId:string;
  readonly variantRevisionId:string;
  readonly variantSha256:string;
  readonly network:'instagram'|'linkedin';
  readonly canonical:SeoMediaCanonicalApproval;
}
export interface SeoMediaSocialAuthorization extends Omit<SeoMediaSocialUseInput,'commandId'> {
  readonly id:string;
  readonly useKind:'social_variant';
  readonly workspaceId:string;
  readonly authorizingUserId:string;
}

export type SeoCampaignQueueDateRule =
  | Readonly<{kind:'relative_verified';days:0|3|7;afterMinutes:60;timezone:string}>
  | Readonly<{kind:'pinned';atUtc:string;timezone:string}>;
export interface SeoCampaignQueueInput {
  readonly commandId:string;
  readonly articleId:string;
  readonly articleVersionId:string;
  readonly articleContentSha:string;
  readonly variantId:string;
  readonly variantRevisionId:string;
  readonly variantSha256:string;
  readonly contentVersionId:string;
  readonly bindingId:string;
  readonly dateRule:SeoCampaignQueueDateRule;
}
export interface SeoCampaignQueueInstruction extends Omit<SeoCampaignQueueInput,'commandId'> {
  readonly queueIntentId:string;
  readonly authorizingUserId:string;
  readonly supersedesQueueIntentId:string|null;
}
export type SeoCampaignQueueResult =
  | Readonly<{kind:'held';reason:string}>
  | Readonly<{kind:'materialized';queueIntentId:string;intentId:string;jobId:string;contentVersionId:string;bindingId:string;
      authorizingUserId:string;executingActor:'worker';scheduledFor:string;anchorPublicationId:string;anchorVerifiedAt:string;
      anchorKind:'first_verified'|'legacy_pinned_observation';timezone:string;dailyCap:number;monthlyCap:number}>;
