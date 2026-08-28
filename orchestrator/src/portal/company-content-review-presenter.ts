import { createHash } from 'node:crypto';
import type {
  CompanyAssetItemDecisionSummary,
  CompanyAssetQuarantineDimension,
} from '../company-asset-pg/types.js';
import { canonicalCompanyContentJson } from '../company-content-pg/validation.js';
import type { PortalCompanyContentReviewSnapshot } from './company-content-review-service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const DIMENSIONS: readonly CompanyAssetQuarantineDimension[] = Object.freeze([
  'visual_policy',
  'claim',
  'asset',
]);
const GENERATED_KINDS = new Set(['post', 'thread', 'email', 'script', 'article', 'ad', 'image']);
const MAX_CANONICAL_CONTENT_BYTES = 128 * 1024;
const MAX_ARTWORK_BYTES = 10 * 1024 * 1024;
const COMPANY_CONTENT_SCHEMA = 'propertypredator.company-content/v1';

const MEDIA_PAYLOAD_KEYS = Object.freeze([
  'body', 'category', 'kind', 'title',
]);
const GENERATED_PAYLOAD_KEYS = Object.freeze([
  'body', 'ctaUrl', 'kind', 'platform', 'title',
]);
const ASSET_REVIEW_PAYLOAD_KEYS = Object.freeze([
  'bytes', 'caption', 'category', 'mediaType', 'title',
]);

export interface CompanyContentReviewDecisionView {
  readonly dimension: CompanyAssetQuarantineDimension;
  readonly dimensionLabel: string;
  readonly outcome: 'clear' | 'quarantined';
  readonly outcomeLabel: 'Evidence clear' | 'Quarantined';
  readonly reasonLabel: string;
  readonly evidenceSha256: string;
  readonly recordedAt: string;
}

export interface CompanyContentReviewPendingDimensionView {
  readonly dimension: CompanyAssetQuarantineDimension;
  readonly dimensionLabel: string;
  readonly explanation: string;
}

export interface CompanyContentReviewView {
  readonly workspace: Readonly<{
    readonly name: string;
    readonly snapshotAt: string;
  }>;
  readonly item: Readonly<{
    readonly releaseItemId: string;
    readonly sourceReleaseId: string;
    readonly itemType: 'asset' | 'generated' | 'media';
    readonly itemTypeLabel: string;
    readonly itemId: string;
    readonly itemVersion: number;
    readonly sourceVersionId: string;
    readonly contentSha256: string;
    readonly blobSha256: string | null;
    readonly brandSha256: string;
    readonly sourceApproval: Readonly<{
      readonly approvalId: string;
      readonly approvedAt: string;
      readonly provenanceLabel: 'Source provenance only';
      readonly hqMeaningLabel: 'Not Growth HQ approval';
    }>;
    readonly hqUseLabel: 'Review required';
    readonly state: 'pending' | 'quarantined' | 'evidence_complete';
    readonly stateLabel: string;
    readonly whyBlocked: string;
    readonly decisions: readonly CompanyContentReviewDecisionView[];
    readonly pendingDimensions: readonly CompanyContentReviewPendingDimensionView[];
    readonly quarantined: boolean;
  }>;
  readonly exactContent: Readonly<{
    readonly mediaType: 'application/json';
    readonly title: string;
    readonly contextLabel: string;
    readonly caption: string | null;
    readonly readableBody: string | null;
    readonly ctaUrl: string | null;
    readonly canonicalContent: string | null;
    readonly canonicalByteLength: number | null;
    readonly verified: true;
  }>;
  readonly artwork: null | Readonly<{
    readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
    readonly expectedByteLength: number;
    readonly blobSha256: string;
    readonly fileHref: string;
    readonly verificationLabel: 'Verified at response boundary';
  }>;
  readonly safety: Readonly<{
    readonly providerEffectsOff: true;
    readonly customerPrivateDataNotAccepted: true;
    readonly affiliateContentNotAccepted: true;
    readonly sourceApprovalNotPromoted: true;
  }>;
}

export class CompanyContentReviewPresentationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompanyContentReviewPresentationError';
  }
}

function fail(message: string): never {
  throw new CompanyContentReviewPresentationError(message);
}

function exactUuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) fail(`${label} is invalid`);
  return value;
}

function exactSha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) fail(`${label} is invalid`);
  return value;
}

function instant(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length > 80 || !Number.isFinite(Date.parse(value))) {
    fail(`${label} is invalid`);
  }
  return new Date(value).toISOString();
}

function positiveInteger(value: unknown, label: string, maximum = 2_147_483_647): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    fail(`${label} is invalid`);
  }
  return value as number;
}

function sourceText(
  value: unknown,
  label: string,
  maximum: number,
  allowEmpty = false,
): string {
  if (typeof value !== 'string' || [...value].length > maximum || (!allowEmpty && value.length === 0)) {
    fail(`${label} is invalid`);
  }
  return value;
}

function displayText(value: string, fallback: string, maximum: number): string {
  const clean = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, ' ');
  return [...clean].slice(0, maximum).join('') || fallback;
}

function plainRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || (Object.getPrototypeOf(value) !== Object.prototype
        && Object.getPrototypeOf(value) !== null)) {
    fail(`${label} is invalid`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  if (actual.length !== allowed.length
      || actual.some((key, index) => key !== allowed[index])) {
    fail(`${label} crossed the review allowlist`);
  }
}

function canonicalPayloadRecord(
  canonicalContent: string,
  expectedKeys: readonly string[],
  label: string,
): Readonly<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(canonicalContent);
  } catch {
    return fail(`${label} canonical content is not JSON`);
  }
  const payload = plainRecord(parsed, `${label} canonical payload`);
  exactKeys(payload, expectedKeys, `${label} canonical payload`);
  let recanonicalised: string;
  try {
    recanonicalised = canonicalCompanyContentJson(payload);
  } catch {
    return fail(`${label} canonical content is invalid`);
  }
  if (recanonicalised !== canonicalContent) {
    fail(`${label} canonical content is not in its exact canonical form`);
  }
  return payload;
}

function cleanHttpsUrl(value: unknown, label: string): string {
  const text = sourceText(value, label, 500);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return fail(`${label} is invalid`);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    fail(`${label} is invalid`);
  }
  return text;
}

function dimensionLabel(dimension: CompanyAssetQuarantineDimension): string {
  if (dimension === 'visual_policy') return 'Visual policy';
  if (dimension === 'claim') return 'Claims';
  return 'Asset integrity';
}

function reasonLabel(reasonCode: CompanyAssetItemDecisionSummary['reasonCode']): string {
  const labels: Readonly<Record<CompanyAssetItemDecisionSummary['reasonCode'], string>> = {
    visual_policy_match: 'Visual policy matches',
    visual_policy_conflict: 'Visual policy conflict',
    claims_supported: 'Claims supported by evidence',
    claims_unsubstantiated: 'Claims are unsubstantiated',
    no_claims_present: 'No claims present',
    asset_integrity_verified: 'Asset integrity verified',
    asset_integrity_failed: 'Asset integrity failed',
    no_asset_payload: 'No artwork payload',
  };
  return labels[reasonCode];
}

function decisionReasonMatches(decision: CompanyAssetItemDecisionSummary): boolean {
  if (decision.dimension === 'visual_policy') {
    return decision.outcome === 'clear'
      ? decision.reasonCode === 'visual_policy_match'
      : decision.reasonCode === 'visual_policy_conflict';
  }
  if (decision.dimension === 'claim') {
    return decision.outcome === 'clear'
      ? decision.reasonCode === 'claims_supported' || decision.reasonCode === 'no_claims_present'
      : decision.reasonCode === 'claims_unsubstantiated';
  }
  return decision.outcome === 'clear'
    ? decision.reasonCode === 'asset_integrity_verified' || decision.reasonCode === 'no_asset_payload'
    : decision.reasonCode === 'asset_integrity_failed';
}

function presentDecision(decision: CompanyAssetItemDecisionSummary): CompanyContentReviewDecisionView {
  if (!DIMENSIONS.includes(decision.dimension)
      || (decision.outcome !== 'clear' && decision.outcome !== 'quarantined')
      || !decisionReasonMatches(decision)) {
    fail('Review decision is inconsistent');
  }
  return Object.freeze({
    dimension: decision.dimension,
    dimensionLabel: dimensionLabel(decision.dimension),
    outcome: decision.outcome,
    outcomeLabel: decision.outcome === 'clear' ? 'Evidence clear' : 'Quarantined',
    reasonLabel: reasonLabel(decision.reasonCode),
    evidenceSha256: exactSha256(decision.evidenceSha256, 'decision evidence SHA-256'),
    recordedAt: instant(decision.recordedAt, 'decision recordedAt'),
  });
}

function pendingDimension(
  dimension: CompanyAssetQuarantineDimension,
): CompanyContentReviewPendingDimensionView {
  const explanation = dimension === 'visual_policy'
    ? 'No Growth HQ visual-policy decision is recorded for this exact content hash.'
    : dimension === 'claim'
      ? 'No Growth HQ claims decision is recorded for this exact content hash.'
      : 'No Growth HQ asset-integrity decision is recorded for this exact item.';
  return Object.freeze({
    dimension,
    dimensionLabel: dimensionLabel(dimension),
    explanation,
  });
}

interface PayloadPresentation {
  readonly title: string;
  readonly contextLabel: string;
  readonly caption: string | null;
  readonly readableBody: string | null;
  readonly ctaUrl: string | null;
  readonly canonicalContent: string | null;
  readonly canonicalByteLength: number | null;
}

function presentPayload(
  snapshot: PortalCompanyContentReviewSnapshot,
  artwork: CompanyContentReviewView['artwork'],
): PayloadPresentation {
  const payload = plainRecord(snapshot.exactContent.payload, 'exact content payload');
  const rawCanonical: unknown = snapshot.exactContent.canonicalContent;
  const itemType = snapshot.item.itemType;
  if (itemType === 'media') {
    exactKeys(payload, MEDIA_PAYLOAD_KEYS, 'media payload');
    if (payload.kind !== 'text') {
      fail('Media payload identity is invalid');
    }
    const title = sourceText(payload.title, 'media title', 300);
    const body = sourceText(payload.body, 'media body', 20_000);
    const category = sourceText(payload.category, 'media category', 100);
    if (typeof rawCanonical !== 'string') fail('Media canonical content is unavailable');
    const canonicalByteLength = verifyCanonicalContent(rawCanonical, snapshot.item.contentSha256);
    const canonical = canonicalPayloadRecord(rawCanonical, [
      'active', 'body', 'category', 'kind', 'schema', 'title', 'type',
    ], 'Media');
    if (canonical.active !== true
        || canonical.type !== 'media'
        || canonical.schema !== COMPANY_CONTENT_SCHEMA
        || canonical.kind !== 'text'
        || canonical.title !== title
        || canonical.body !== body
        || canonical.category !== category) {
      fail('Media review payload does not match canonical content');
    }
    return Object.freeze({
      title: displayText(title, 'Company media', 300),
      contextLabel: `Media · ${displayText(category, 'Uncategorised', 100)}`,
      caption: null,
      readableBody: body,
      ctaUrl: null,
      canonicalContent: rawCanonical,
      canonicalByteLength,
    });
  }
  if (itemType === 'generated') {
    exactKeys(payload, GENERATED_PAYLOAD_KEYS, 'generated payload');
    if (typeof payload.kind !== 'string' || !GENERATED_KINDS.has(payload.kind)) {
      fail('Generated payload identity is invalid');
    }
    const title = sourceText(payload.title, 'generated title', 300);
    const body = sourceText(payload.body, 'generated body', 20_000);
    const platform = sourceText(payload.platform, 'generated platform', 80, true);
    const ctaUrl = cleanHttpsUrl(payload.ctaUrl, 'generated CTA URL');
    if (typeof rawCanonical !== 'string') fail('Generated canonical content is unavailable');
    const canonicalByteLength = verifyCanonicalContent(rawCanonical, snapshot.item.contentSha256);
    const canonical = canonicalPayloadRecord(rawCanonical, [
      'body', 'cta_url', 'kind', 'platform', 'schema', 'title', 'type',
    ], 'Generated');
    if (canonical.type !== 'generated'
        || canonical.schema !== COMPANY_CONTENT_SCHEMA
        || canonical.kind !== payload.kind
        || canonical.title !== title
        || canonical.body !== body
        || canonical.platform !== platform
        || canonical.cta_url !== ctaUrl) {
      fail('Generated review payload does not match canonical content');
    }
    const kind = displayText(payload.kind, 'Content', 80);
    return Object.freeze({
      title: displayText(title, 'Generated company content', 300),
      contextLabel: platform
        ? `${kind} · ${displayText(platform, 'Platform neutral', 80)}`
        : `${kind} · Platform neutral`,
      caption: null,
      readableBody: body,
      ctaUrl,
      canonicalContent: rawCanonical,
      canonicalByteLength,
    });
  }

  exactKeys(payload, ASSET_REVIEW_PAYLOAD_KEYS, 'asset review payload');
  if (rawCanonical !== null) fail('Asset canonical content must remain sealed');
  if (!artwork) fail('Asset artwork is unavailable');
  const bytes = positiveInteger(payload.bytes, 'asset payload byte length', MAX_ARTWORK_BYTES);
  if (bytes !== artwork.expectedByteLength || payload.mediaType !== artwork.mediaType) {
    fail('Asset payload does not match the verified artwork');
  }
  const title = sourceText(payload.title, 'asset title', 300);
  const caption = sourceText(payload.caption, 'asset caption', 2_000, true);
  const category = sourceText(payload.category, 'asset category', 100);
  return Object.freeze({
    title: displayText(title, 'Company artwork', 300),
    contextLabel: `Artwork · ${displayText(category, 'Uncategorised', 100)}`,
    caption: caption ? displayText(caption, '', 2_000) : null,
    readableBody: null,
    ctaUrl: null,
    canonicalContent: null,
    canonicalByteLength: null,
  });
}

function verifyCanonicalContent(
  canonicalContent: string,
  expectedSha256: string,
): number {
  const byteLength = Buffer.byteLength(canonicalContent, 'utf8');
  if (byteLength < 1 || byteLength > MAX_CANONICAL_CONTENT_BYTES) {
    fail('Canonical content exceeds the exact review bound');
  }
  const actualSha256 = createHash('sha256').update(canonicalContent, 'utf8').digest('hex');
  if (actualSha256 !== expectedSha256) fail('Canonical content does not match its SHA-256');
  return byteLength;
}

function presentArtwork(
  snapshot: PortalCompanyContentReviewSnapshot,
): CompanyContentReviewView['artwork'] {
  const artwork = snapshot.artwork;
  if (artwork === null) {
    if (snapshot.item.itemType === 'asset' || snapshot.item.blobSha256 !== null) {
      fail('Asset review is missing verified artwork');
    }
    return null;
  }
  if (snapshot.item.itemType !== 'asset') fail('Non-asset item exposed artwork');
  if (artwork.mediaType !== 'image/png'
      && artwork.mediaType !== 'image/jpeg'
      && artwork.mediaType !== 'image/webp') {
    fail('Artwork media type is invalid');
  }
  const expectedByteLength = positiveInteger(
    artwork.expectedByteLength,
    'artwork expected byte length',
    MAX_ARTWORK_BYTES,
  );
  const blobSha256 = exactSha256(artwork.blobSha256, 'artwork blob SHA-256');
  if (blobSha256 !== snapshot.item.blobSha256
      || artwork.verification !== 'verified_at_response_boundary') {
    fail('Artwork verification is inconsistent');
  }
  const expectedHref = `/portal/content/assets/review/${snapshot.item.releaseItemId}/file`;
  if (artwork.fileHref !== expectedHref) fail('Artwork file link escaped its exact item boundary');
  return Object.freeze({
    mediaType: artwork.mediaType,
    expectedByteLength,
    blobSha256,
    fileHref: expectedHref,
    verificationLabel: 'Verified at response boundary',
  });
}

function listLabels(values: readonly string[]): string {
  if (values.length < 2) return values[0] ?? 'Review';
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(', ')}, and ${values.at(-1)}`;
}

/**
 * Allowlist-only presentation for one exact, already verified company-content item.
 * It deliberately exposes no payload object, storage/source path, secret, command,
 * provider capability, or writable decision surface.
 */
export function presentCompanyContentReview(
  snapshot: PortalCompanyContentReviewSnapshot,
): CompanyContentReviewView {
  if (!snapshot || typeof snapshot !== 'object'
      || !snapshot.workspace || !snapshot.item || !snapshot.exactContent || !snapshot.safety
      || snapshot.workspace.canManage !== true
      || snapshot.exactContent.mediaType !== 'application/json'
      || snapshot.exactContent.verified !== true
      || snapshot.item.hqUseStatus !== 'review_required'
      || snapshot.item.sourceApproval?.meaning !== 'source_provenance_only'
      || snapshot.item.sourceApproval.expiresAt !== null
      || snapshot.safety.providerEffects !== false
      || snapshot.safety.customerPrivateDataAccepted !== false
      || snapshot.safety.affiliateContentAccepted !== false
      || snapshot.safety.sourceApprovalPromotedToHqApproval !== false) {
    fail('Company content crossed the read-only review boundary');
  }
  exactUuid(snapshot.workspace.workspaceId, 'workspaceId');
  const releaseItemId = exactUuid(snapshot.item.releaseItemId, 'releaseItemId');
  const sourceReleaseId = exactUuid(snapshot.item.sourceReleaseId, 'sourceReleaseId');
  const sourceVersionId = exactUuid(snapshot.item.sourceVersionId, 'sourceVersionId');
  if (snapshot.item.itemType !== 'asset'
      && snapshot.item.itemType !== 'generated'
      && snapshot.item.itemType !== 'media') {
    fail('Item type is invalid');
  }
  if (typeof snapshot.item.itemId !== 'string' || !SAFE_ITEM_ID.test(snapshot.item.itemId)) {
    fail('itemId is invalid');
  }
  const itemVersion = positiveInteger(snapshot.item.itemVersion, 'itemVersion');
  const contentSha256 = exactSha256(snapshot.item.contentSha256, 'content SHA-256');
  const brandSha256 = exactSha256(snapshot.item.brandSha256, 'brand SHA-256');
  const blobSha256 = snapshot.item.blobSha256 === null
    ? null
    : exactSha256(snapshot.item.blobSha256, 'blob SHA-256');
  if ((snapshot.item.itemType === 'asset') !== (blobSha256 !== null)) {
    fail('Item blob identity is inconsistent');
  }

  if (!Array.isArray(snapshot.item.decisions) || snapshot.item.decisions.length > DIMENSIONS.length
      || !Array.isArray(snapshot.item.pendingDimensions)
      || snapshot.item.pendingDimensions.length > DIMENSIONS.length) {
    fail('Review dimensions are invalid');
  }
  const decisions = Object.freeze(snapshot.item.decisions.map(presentDecision));
  const decided = new Set(decisions.map((decision) => decision.dimension));
  if (decided.size !== decisions.length) fail('Review decisions repeat a dimension');
  const pendingInput = snapshot.item.pendingDimensions;
  if (pendingInput.some((dimension) => !DIMENSIONS.includes(dimension))
      || new Set(pendingInput).size !== pendingInput.length
      || pendingInput.some((dimension) => decided.has(dimension))) {
    fail('Pending review dimensions are inconsistent');
  }
  const expectedPending = DIMENSIONS.filter((dimension) => !decided.has(dimension));
  if (expectedPending.length !== pendingInput.length
      || expectedPending.some((dimension) => !pendingInput.includes(dimension))) {
    fail('Pending review dimensions do not cover the exact item');
  }
  const quarantined = decisions.some((decision) => decision.outcome === 'quarantined');
  if (snapshot.item.quarantined !== quarantined) fail('Quarantine state is inconsistent');
  const pendingDimensions = Object.freeze(pendingInput.map(pendingDimension));
  const artwork = presentArtwork(snapshot);
  const exactContent = presentPayload(snapshot, artwork);

  const quarantinedLabels = decisions
    .filter((decision) => decision.outcome === 'quarantined')
    .map((decision) => decision.dimensionLabel);
  const pendingLabels = pendingDimensions.map((dimension) => dimension.dimensionLabel);
  const state: CompanyContentReviewView['item']['state'] = quarantined
    ? 'quarantined'
    : pendingDimensions.length > 0
      ? 'pending'
      : 'evidence_complete';
  const stateLabel = state === 'quarantined'
    ? 'Quarantined · HQ use blocked'
    : state === 'pending'
      ? `${pendingDimensions.length} evidence ${pendingDimensions.length === 1 ? 'dimension' : 'dimensions'} pending`
      : 'Evidence complete · HQ approval absent';
  const whyBlocked = quarantined
    ? `${listLabels(quarantinedLabels)} ${quarantinedLabels.length === 1 ? 'is' : 'are'} quarantined for this exact item. Growth HQ use remains blocked.`
    : pendingDimensions.length > 0
      ? `${listLabels(pendingLabels)} ${pendingLabels.length === 1 ? 'is' : 'are'} still pending. Growth HQ has not approved this exact item for use.`
      : 'All evidence dimensions are recorded, but source provenance is not Growth HQ approval. HQ use remains review required.';

  return Object.freeze({
    workspace: Object.freeze({
      name: displayText(
        sourceText(snapshot.workspace.workspaceName, 'workspaceName', 200),
        'Property Predator Growth HQ',
        200,
      ),
      snapshotAt: instant(snapshot.workspace.snapshotAt, 'workspace snapshotAt'),
    }),
    item: Object.freeze({
      releaseItemId,
      sourceReleaseId,
      itemType: snapshot.item.itemType,
      itemTypeLabel: snapshot.item.itemType === 'asset'
        ? 'Artwork asset'
        : snapshot.item.itemType === 'generated'
          ? 'Generated content'
          : 'Company media',
      itemId: snapshot.item.itemId,
      itemVersion,
      sourceVersionId,
      contentSha256,
      blobSha256,
      brandSha256,
      sourceApproval: Object.freeze({
        approvalId: exactUuid(snapshot.item.sourceApproval.approvalId, 'source approvalId'),
        approvedAt: instant(snapshot.item.sourceApproval.approvedAt, 'source approvedAt'),
        provenanceLabel: 'Source provenance only',
        hqMeaningLabel: 'Not Growth HQ approval',
      }),
      hqUseLabel: 'Review required',
      state,
      stateLabel,
      whyBlocked,
      decisions,
      pendingDimensions,
      quarantined,
    }),
    exactContent: Object.freeze({
      mediaType: 'application/json',
      title: exactContent.title,
      contextLabel: exactContent.contextLabel,
      caption: exactContent.caption,
      readableBody: exactContent.readableBody,
      ctaUrl: exactContent.ctaUrl,
      canonicalContent: exactContent.canonicalContent,
      canonicalByteLength: exactContent.canonicalByteLength,
      verified: true,
    }),
    artwork,
    safety: Object.freeze({
      providerEffectsOff: true,
      customerPrivateDataNotAccepted: true,
      affiliateContentNotAccepted: true,
      sourceApprovalNotPromoted: true,
    }),
  });
}
