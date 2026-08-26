import type {
  CompanyContentCatalogItem,
  CompanyContentCatalogPage,
  CompanyContentKind,
  CompanyContentOrigin,
} from '../company-content-pg/types.js';
import type { ContentControlNoticeView } from './content-control-room-actions.js';
import { PORTAL_COMPANY_CONTENT_REVIEW_REPRESENTATION_AVAILABLE } from './company-content-service.js';

export const CONTENT_CONTROL_ROOM_ROUTE = '/portal/content' as const;
export const CONTENT_CONTROL_ROOM_MAX_ITEMS = 100;
export const CONTENT_CONTROL_ROOM_MAX_REVIEW_ITEMS = 12;
export const CONTENT_CONTROL_ROOM_MAX_QUERY_LENGTH = 80;

export type ContentControlRoomChannel =
  | 'all'
  | 'social'
  | 'email'
  | 'webinar'
  | 'library';

export type ContentControlRoomFormat = 'all' | CompanyContentKind;

export interface ContentControlRoomFilterInput {
  readonly query?: unknown;
  readonly channel?: unknown;
  readonly format?: unknown;
}

export interface ContentControlRoomFiltersView {
  readonly query: string;
  readonly channel: ContentControlRoomChannel;
  readonly format: ContentControlRoomFormat;
}

export type ContentApprovalTone =
  | 'approved'
  | 'pending'
  | 'warning'
  | 'rejected'
  | 'neutral';

export interface ContentControlRoomItemView {
  readonly anchorId: string;
  readonly contentItemId: string;
  readonly contentVersionId: string;
  readonly versionNumber: number;
  readonly title: string;
  readonly origin: CompanyContentOrigin;
  readonly originLabel: string;
  readonly kind: CompanyContentKind;
  readonly kindLabel: string;
  readonly channel: Exclude<ContentControlRoomChannel, 'all'>;
  readonly channelLabel: string;
  readonly contentMimeType: string;
  readonly sourceSystem: string;
  readonly sourceItemId: string;
  readonly sourceVersion: string;
  readonly contentSha256: string;
  readonly blobSha256: string;
  readonly brandSha256: string;
  readonly approvalRequestId: string | null;
  readonly approvalDecisionId: string | null;
  readonly approvalStatus: CompanyContentCatalogItem['approvalStatus'];
  readonly approvalLabel: string;
  readonly approvalDetail: string;
  readonly approvalTone: ContentApprovalTone;
  readonly approvalStale: boolean;
  readonly reviewRepresentationAvailable: boolean;
  readonly reviewRepresentationLabel: 'Exact content available' | 'Exact content unavailable';
  readonly reviewRepresentationDetail: string;
  readonly sourceAttestationId: string | null;
  readonly sourceCheckedAt: string | null;
  readonly sourceExpiresAt: string | null;
  readonly sourceFresh: boolean;
  readonly sourceFreshnessLabel: string;
  readonly sourceFreshnessDetail: string;
  /** Fail-closed view of the stored gate; true only when every prerequisite agrees. */
  readonly publishable: boolean;
  readonly publishableLabel: 'Eligible' | 'Locked';
  readonly publishableDetail: string;
  readonly reviewReason: string | null;
  readonly createdAt: string;
}

export interface ContentControlRoomReviewItemView {
  readonly anchorId: string;
  readonly title: string;
  readonly versionNumber: number;
  readonly reason: string;
  readonly approvalLabel: string;
  readonly sourceFresh: boolean;
}

export interface ContentControlRoomMetricsView {
  readonly loaded: number;
  readonly exactApproved: number;
  readonly publishable: number;
  readonly needsAttention: number;
}

export interface ContentControlRoomView {
  readonly workspaceName: string;
  readonly asOf: string;
  readonly filters: ContentControlRoomFiltersView;
  readonly items: readonly ContentControlRoomItemView[];
  readonly reviewQueue: readonly ContentControlRoomReviewItemView[];
  readonly metrics: ContentControlRoomMetricsView;
  readonly loadedCount: number;
  readonly matchingCount: number;
  readonly matchingAttentionCount: number;
  readonly sourceCount: number;
  readonly catalogEmpty: boolean;
  readonly inputTruncated: boolean;
  readonly hasMore: boolean;
  readonly canWrite: boolean;
  readonly canManage: boolean;
  readonly notice?: ContentControlNoticeView;
}

export interface PresentContentControlRoomOptions {
  readonly workspaceName: string;
  /** Request/snapshot time supplied by the caller; the presenter never invents it. */
  readonly asOf: string;
  readonly filters?: ContentControlRoomFilterInput;
  readonly canWrite?: boolean;
  readonly canManage?: boolean;
  readonly notice?: ContentControlNoticeView;
}

const CHANNELS = new Set<ContentControlRoomChannel>([
  'all', 'social', 'email', 'webinar', 'library',
]);
const FORMATS = new Set<ContentControlRoomFormat>([
  'all', 'article', 'document', 'email', 'image', 'social_post',
  'video', 'webinar', 'other',
]);

const KIND_LABELS: Readonly<Record<CompanyContentKind, string>> = Object.freeze({
  article: 'Article',
  document: 'Document',
  email: 'Email',
  image: 'Image',
  social_post: 'Social post',
  video: 'Video',
  webinar: 'Webinar',
  other: 'Other',
});

const ORIGIN_LABELS: Readonly<Record<CompanyContentOrigin, string>> = Object.freeze({
  imported: 'Imported',
  generated: 'Generated',
  edited: 'Edited',
});

const APPROVAL_LABELS: Readonly<Record<CompanyContentCatalogItem['approvalStatus'], string>> = Object.freeze({
  unrequested: 'Not submitted',
  pending: 'Pending review',
  approved: 'Approved',
  rejected: 'Rejected',
  changes_requested: 'Changes requested',
  stale: 'Stale approval',
});

function boundedFilterText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, CONTENT_CONTROL_ROOM_MAX_QUERY_LENGTH);
}

export function normaliseContentControlRoomFilters(
  input: ContentControlRoomFilterInput = {},
): ContentControlRoomFiltersView {
  const channel = typeof input.channel === 'string' && CHANNELS.has(input.channel as ContentControlRoomChannel)
    ? input.channel as ContentControlRoomChannel
    : 'all';
  const format = typeof input.format === 'string' && FORMATS.has(input.format as ContentControlRoomFormat)
    ? input.format as ContentControlRoomFormat
    : 'all';
  return Object.freeze({
    query: boundedFilterText(input.query),
    channel,
    format,
  });
}

function channelFor(kind: CompanyContentKind): Exclude<ContentControlRoomChannel, 'all'> {
  if (kind === 'social_post') return 'social';
  if (kind === 'email') return 'email';
  if (kind === 'webinar') return 'webinar';
  // Images and videos remain in the owned library until an exact delivery rail is chosen.
  return 'library';
}

function channelLabel(channel: Exclude<ContentControlRoomChannel, 'all'>): string {
  if (channel === 'social') return 'Social';
  if (channel === 'email') return 'Email';
  if (channel === 'webinar') return 'Webinar';
  return 'Owned library';
}

function approvalTone(status: CompanyContentCatalogItem['approvalStatus']): ContentApprovalTone {
  if (status === 'approved') return 'approved';
  if (status === 'pending') return 'pending';
  if (status === 'rejected') return 'rejected';
  if (status === 'changes_requested' || status === 'stale') return 'warning';
  return 'neutral';
}

function exactApproval(item: CompanyContentCatalogItem): boolean {
  return item.approvalStatus === 'approved'
    && item.approvalStale === false
    && item.approvalRequestId !== null
    && item.approvalDecisionId !== null;
}

function approvalDetail(item: CompanyContentCatalogItem, stale: boolean): string {
  if (stale) return `An older decision does not cover immutable v${item.versionNumber}.`;
  if (item.approvalStatus === 'approved') {
    return `A decision is recorded against the v${item.versionNumber} hash, but this surface cannot show the exact review content.`;
  }
  if (item.approvalStatus === 'pending') return `The exact v${item.versionNumber} request has no decision yet.`;
  if (item.approvalStatus === 'changes_requested') return `The exact v${item.versionNumber} review requested changes.`;
  if (item.approvalStatus === 'rejected') return `The exact v${item.versionNumber} request was rejected.`;
  return `Immutable v${item.versionNumber} has not been submitted for approval.`;
}

function freshnessDetail(item: CompanyContentCatalogItem): string {
  if (!item.sourceAttestationId || !item.sourceCheckedAt || !item.sourceExpiresAt) {
    return 'No complete source attestation is recorded for this exact version.';
  }
  return item.sourceFresh
    ? 'The source catalogue proof is inside its short freshness window.'
    : 'The source catalogue proof has expired or is not currently valid.';
}

function publishableDetail(
  item: CompanyContentCatalogItem,
  approved: boolean,
  stale: boolean,
  reviewRepresentationAvailable: boolean,
  publishable: boolean,
): string {
  if (publishable) return 'Exact approval and fresh source proof agree. No provider action has run.';
  if (!reviewRepresentationAvailable) {
    return 'The exact text or artwork bytes are not available in this review surface, so approval and outbound use stay locked.';
  }
  if (stale) return 'This version needs its own approval decision.';
  if (!approved) return 'An exact approval decision is required.';
  if (!item.sourceFresh) return 'A fresh source catalogue attestation is required.';
  return 'The stored outbound gate is closed; this view fails closed.';
}

function reviewReason(
  item: CompanyContentCatalogItem,
  approved: boolean,
  stale: boolean,
  reviewRepresentationAvailable: boolean,
  publishable: boolean,
): string | null {
  if (publishable) return null;
  if (!reviewRepresentationAvailable) return 'Exact review content unavailable';
  if (stale) return 'Approve this exact version';
  if (item.approvalStatus === 'pending') return 'Decision waiting';
  if (item.approvalStatus === 'changes_requested') return 'Changes requested';
  if (item.approvalStatus === 'rejected') return 'Rework before resubmitting';
  if (item.approvalStatus === 'unrequested') return 'Submit for review';
  if (approved && !item.sourceFresh) return 'Refresh source proof';
  return 'Outbound gate locked';
}

function presentItem(item: CompanyContentCatalogItem, index: number): ContentControlRoomItemView {
  const channel = channelFor(item.kind);
  const stale = item.approvalStale || item.approvalStatus === 'stale';
  const approved = exactApproval(item) && !stale;
  const reviewRepresentationAvailable = PORTAL_COMPANY_CONTENT_REVIEW_REPRESENTATION_AVAILABLE;
  const publishable = item.publishable
    && approved
    && item.sourceFresh
    && reviewRepresentationAvailable;
  return Object.freeze({
    anchorId: `ccr-content-${index + 1}`,
    contentItemId: item.contentItemId,
    contentVersionId: item.contentVersionId,
    versionNumber: item.versionNumber,
    title: item.title,
    origin: item.origin,
    originLabel: ORIGIN_LABELS[item.origin],
    kind: item.kind,
    kindLabel: KIND_LABELS[item.kind],
    channel,
    channelLabel: channelLabel(channel),
    contentMimeType: item.contentMimeType,
    sourceSystem: item.source.system,
    sourceItemId: item.source.itemId,
    sourceVersion: item.source.version,
    contentSha256: item.contentSha256,
    blobSha256: item.blobSha256,
    brandSha256: item.brandSha256,
    approvalRequestId: item.approvalRequestId,
    approvalDecisionId: item.approvalDecisionId,
    approvalStatus: item.approvalStatus,
    approvalLabel: APPROVAL_LABELS[item.approvalStatus],
    approvalDetail: approvalDetail(item, stale),
    approvalTone: approvalTone(item.approvalStatus),
    approvalStale: stale,
    reviewRepresentationAvailable,
    reviewRepresentationLabel: reviewRepresentationAvailable
      ? 'Exact content available'
      : 'Exact content unavailable',
    reviewRepresentationDetail: reviewRepresentationAvailable
      ? 'The exact hash-bound review representation is available for human inspection.'
      : 'Only metadata and hashes are available here; the exact text or artwork cannot be inspected.',
    sourceAttestationId: item.sourceAttestationId,
    sourceCheckedAt: item.sourceCheckedAt,
    sourceExpiresAt: item.sourceExpiresAt,
    sourceFresh: item.sourceFresh,
    sourceFreshnessLabel: item.sourceFresh ? 'Source fresh' : 'Source proof stale',
    sourceFreshnessDetail: freshnessDetail(item),
    publishable,
    publishableLabel: publishable ? 'Eligible' : 'Locked',
    publishableDetail: publishableDetail(
      item,
      approved,
      stale,
      reviewRepresentationAvailable,
      publishable,
    ),
    reviewReason: reviewReason(
      item,
      approved,
      stale,
      reviewRepresentationAvailable,
      publishable,
    ),
    createdAt: item.createdAt,
  });
}

function matchesFilters(
  item: ContentControlRoomItemView,
  filters: ContentControlRoomFiltersView,
): boolean {
  if (filters.channel !== 'all' && item.channel !== filters.channel) return false;
  if (filters.format !== 'all' && item.kind !== filters.format) return false;
  if (!filters.query) return true;
  const needle = filters.query.toLowerCase();
  return [
    item.title,
    item.sourceSystem,
    item.sourceItemId,
    item.sourceVersion,
    item.kindLabel,
    item.channelLabel,
  ].some((value) => value.toLowerCase().includes(needle));
}

function reviewPriority(item: ContentControlRoomItemView): number {
  if (item.approvalStale) return 0;
  if (item.approvalStatus === 'pending') return 1;
  if (item.approvalStatus === 'changes_requested') return 2;
  if (item.approvalStatus === 'rejected') return 3;
  if (item.approvalStatus === 'unrequested') return 4;
  if (!item.sourceFresh) return 5;
  return 6;
}

export function presentContentControlRoom(
  catalog: CompanyContentCatalogPage,
  options: PresentContentControlRoomOptions,
): ContentControlRoomView {
  const filters = normaliseContentControlRoomFilters(options.filters);
  const inputTruncated = catalog.items.length > CONTENT_CONTROL_ROOM_MAX_ITEMS;
  const loaded = catalog.items
    .slice(0, CONTENT_CONTROL_ROOM_MAX_ITEMS)
    .map(presentItem);
  const items = loaded.filter((item) => matchesFilters(item, filters));
  const reviewQueue = items
    .filter((item) => item.reviewReason !== null)
    .map((item, index) => ({ item, index }))
    .sort((left, right) => reviewPriority(left.item) - reviewPriority(right.item) || left.index - right.index)
    .slice(0, CONTENT_CONTROL_ROOM_MAX_REVIEW_ITEMS)
    .map(({ item }) => Object.freeze({
      anchorId: item.anchorId,
      title: item.title,
      versionNumber: item.versionNumber,
      reason: item.reviewReason!,
      approvalLabel: item.approvalLabel,
      sourceFresh: item.sourceFresh,
    }));
  const sourceSystems = new Set(loaded.map((item) => item.sourceSystem));

  return Object.freeze({
    workspaceName: options.workspaceName,
    asOf: options.asOf,
    filters,
    items: Object.freeze(items),
    reviewQueue: Object.freeze(reviewQueue),
    metrics: Object.freeze({
      loaded: loaded.length,
      exactApproved: loaded.filter((item) => (
        item.approvalStatus === 'approved'
        && !item.approvalStale
        && item.approvalRequestId !== null
        && item.approvalDecisionId !== null
      )).length,
      publishable: loaded.filter((item) => item.publishable).length,
      needsAttention: loaded.filter((item) => item.reviewReason !== null).length,
    }),
    loadedCount: loaded.length,
    matchingCount: items.length,
    matchingAttentionCount: items.filter((item) => item.reviewReason !== null).length,
    sourceCount: sourceSystems.size,
    catalogEmpty: loaded.length === 0,
    inputTruncated,
    hasMore: catalog.nextCursor !== null || inputTruncated,
    canWrite: options.canWrite === true,
    canManage: options.canManage === true,
    ...(options.notice ? { notice: options.notice } : {}),
  });
}
