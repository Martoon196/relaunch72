import type {
  CompanyContentCatalogItem,
  CompanyContentCatalogPage,
} from '../company-content-pg/types.js';
import type { SocialNetwork } from '../providers/contracts.js';
import type { SocialCampaignTargetState } from '../social-campaign-pg/types.js';

export const CONTENT_CALENDAR_ROUTE = '/portal/content/calendar' as const;
export const CONTENT_CALENDAR_MAX_CATALOG_ITEMS = 100;
export const CONTENT_CALENDAR_MAX_SLOTS = 120;
export const CONTENT_CALENDAR_MAX_BACKLOG_ITEMS = 8;

export type ContentCalendarMode = 'week' | 'month';
export type ContentCalendarPublicSocialChannel = SocialNetwork;
export type ContentCalendarChannel =
  | ContentCalendarPublicSocialChannel
  | 'email'
  | 'webinar';
export type ContentCalendarChannelFilter = 'all' | ContentCalendarChannel;

export interface ContentCalendarPublicSocialProvenance {
  readonly campaignId: string;
  readonly revisionId: string;
  readonly revisionNumber: number;
  readonly campaignTitle: string;
  readonly postId: string;
  readonly planSha256: string;
  readonly operationId: string;
  readonly targetId: string;
  readonly targetLabel: string;
  readonly network: ContentCalendarPublicSocialChannel;
  readonly state: SocialCampaignTargetState;
  readonly simulationAttemptCount: number;
  readonly maxSimulationAttempts: number;
  readonly reconciliationAttemptCount: number;
  readonly maxReconciliationAttempts: number;
  readonly updatedAt: string;
  readonly environment: 'test';
  readonly providerEffects: 'none';
}

/**
 * A planning fact only. It cannot contain provider credentials or request data.
 * Channel variants are placement metadata around an immutable approved version;
 * they never mutate the stored company content.
 */
export interface ContentCalendarSlotSnapshot {
  readonly slotId: string;
  readonly contentItemId: string;
  readonly contentVersionId: string;
  readonly contentSha256: string;
  readonly scheduledFor: string;
  readonly channel: ContentCalendarChannel;
  readonly variantLabel: string;
  readonly objectiveLabel: string;
  readonly ownerLabel: string;
  readonly plannerState: 'draft' | 'simulated_preview';
  readonly executionMode: 'simulated';
  /** Allowlisted durable TEST provenance. Raw body/account/storage data has no shape here. */
  readonly publicSocial?: ContentCalendarPublicSocialProvenance;
}

export interface ContentCalendarSnapshot {
  readonly catalog: CompanyContentCatalogPage;
  readonly slots: readonly ContentCalendarSlotSnapshot[];
  /** Database-proven continuation beyond the loaded complete post aggregates. */
  readonly sourceTruncated: boolean;
}

export interface ContentCalendarFilterInput {
  readonly mode?: unknown;
  /** Legacy preview links used `view`; accepted read-only and canonicalised to `mode`. */
  readonly view?: unknown;
  readonly date?: unknown;
  readonly channel?: unknown;
}

export interface ContentCalendarFiltersView {
  readonly mode: ContentCalendarMode;
  readonly date: string;
  readonly channel: ContentCalendarChannelFilter;
}

export interface ContentCalendarSlotView {
  readonly slotId: string;
  readonly anchorId: string;
  readonly title: string;
  readonly contentItemId: string;
  readonly contentVersionId: string;
  readonly versionNumber: number | null;
  readonly contentSha256: string;
  readonly shortHash: string;
  readonly scheduledFor: string;
  readonly timeLabel: string;
  readonly channel: ContentCalendarChannel;
  readonly channelLabel: string;
  readonly channelCode: string;
  readonly variantLabel: string;
  readonly objectiveLabel: string;
  readonly ownerLabel: string;
  readonly plannerState: ContentCalendarSlotSnapshot['plannerState'];
  readonly plannerStateLabel: string;
  readonly immutableVersionMatches: boolean;
  readonly exactApproval: boolean;
  readonly approvalLabel: string;
  readonly sourceFresh: boolean;
  readonly sourceFreshnessLabel: string;
  readonly sourceExpiresAt: string | null;
  readonly simulationEligible: boolean;
  readonly gateLabel: 'Simulation ready' | 'Locked';
  readonly gateDetail: string;
  readonly publicSocial: ContentCalendarPublicSocialView | null;
}

export interface ContentCalendarPublicSocialView extends ContentCalendarPublicSocialProvenance {
  readonly campaignShortId: string;
  readonly revisionShortId: string;
  readonly postShortId: string;
  readonly operationShortId: string;
  readonly targetShortId: string;
  readonly planShortHash: string;
  readonly stateLabel: string;
  readonly stateDetail: string;
  readonly stateTone: 'planned' | 'working' | 'complete' | 'cancelled' | 'attention';
  readonly attention: boolean;
  readonly identityProofValid: boolean;
}

export interface ContentCalendarDayView {
  readonly date: string;
  readonly weekdayLabel: string;
  readonly dayNumber: string;
  readonly fullDateLabel: string;
  readonly inPrimaryPeriod: boolean;
  readonly isToday: boolean;
  readonly slots: readonly ContentCalendarSlotView[];
}

export interface ContentCalendarBacklogItemView {
  readonly contentItemId: string;
  readonly contentVersionId: string;
  readonly title: string;
  readonly versionNumber: number;
  readonly kindLabel: string;
  readonly shortHash: string;
  readonly approvalLabel: string;
  readonly sourceFreshnessLabel: string;
  readonly simulationEligible: boolean;
  readonly gateDetail: string;
}

export interface ContentCalendarMetricsView {
  readonly plannedSlots: number;
  readonly simulationReady: number;
  readonly blocked: number;
  readonly activeChannels: number;
}

export interface ContentCalendarView {
  readonly workspaceName: string;
  readonly timezone: string;
  readonly asOf: string;
  readonly filters: ContentCalendarFiltersView;
  readonly periodLabel: string;
  readonly previousDate: string;
  readonly nextDate: string;
  readonly days: readonly ContentCalendarDayView[];
  readonly backlog: readonly ContentCalendarBacklogItemView[];
  readonly metrics: ContentCalendarMetricsView;
  readonly visibleSlotCount: number;
  readonly catalogCount: number;
  readonly inputTruncated: boolean;
  readonly sourceTruncated: boolean;
  readonly hasUnknownVersion: boolean;
}

export interface PresentContentCalendarOptions {
  readonly workspaceName: string;
  readonly timezone: string;
  /** Request/snapshot time supplied by the caller; the presenter never invents it. */
  readonly asOf: string;
  readonly filters?: ContentCalendarFilterInput;
}

const MODES = new Set<ContentCalendarMode>(['week', 'month']);
const CHANNELS = new Set<ContentCalendarChannelFilter>([
  'all', 'linkedin', 'instagram', 'facebook', 'tiktok', 'x', 'youtube',
  'google_business_profile', 'threads', 'pinterest', 'email', 'webinar',
]);
const DAY_MS = 86_400_000;

const CHANNEL_LABELS: Readonly<Record<ContentCalendarChannel, string>> = Object.freeze({
  linkedin: 'LinkedIn',
  instagram: 'Instagram',
  facebook: 'Facebook',
  tiktok: 'TikTok',
  x: 'X',
  youtube: 'YouTube',
  google_business_profile: 'Google Business Profile',
  threads: 'Threads',
  pinterest: 'Pinterest',
  email: 'Email',
  webinar: 'Webinar',
});

const CHANNEL_CODES: Readonly<Record<ContentCalendarChannel, string>> = Object.freeze({
  linkedin: 'in',
  instagram: 'ig',
  facebook: 'fb',
  tiktok: 'tt',
  x: 'x',
  youtube: 'yt',
  google_business_profile: 'gb',
  threads: 'th',
  pinterest: 'pi',
  email: 'em',
  webinar: 'wb',
});

const KIND_LABELS: Readonly<Record<CompanyContentCatalogItem['kind'], string>> = Object.freeze({
  article: 'Article',
  document: 'Document',
  email: 'Email',
  image: 'Artwork',
  social_post: 'Social post',
  video: 'Video',
  webinar: 'Webinar',
  other: 'Content',
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const PUBLIC_SOCIAL_CHANNELS = new Set<ContentCalendarPublicSocialChannel>([
  'facebook', 'instagram', 'linkedin', 'tiktok', 'x', 'youtube',
  'google_business_profile', 'threads', 'pinterest',
]);
const PUBLIC_SOCIAL_STATE_META: Readonly<Record<SocialCampaignTargetState, Readonly<{
  label: string;
  detail: string;
  tone: ContentCalendarPublicSocialView['stateTone'];
  attention: boolean;
  allowsSimulation: boolean;
}>>> = Object.freeze({
  waiting_for_test_time: Object.freeze({
    label: 'TEST plan queued', detail: 'Waiting for its durable TEST time; no external publication is possible.',
    tone: 'planned', attention: false, allowsSimulation: true,
  }),
  leased: Object.freeze({
    label: 'Simulator leased', detail: 'A TEST worker holds the durable lease; provider effects remain none.',
    tone: 'working', attention: false, allowsSimulation: true,
  }),
  calling_simulator: Object.freeze({
    label: 'Simulator running', detail: 'The non-routable TEST simulator is evaluating this operation.',
    tone: 'working', attention: false, allowsSimulation: true,
  }),
  retry_wait: Object.freeze({
    label: 'TEST retry waiting', detail: 'The durable simulator operation is waiting for its bounded retry.',
    tone: 'working', attention: false, allowsSimulation: true,
  }),
  simulated_succeeded: Object.freeze({
    label: 'Simulation complete', detail: 'The durable TEST simulator completed; this is not a social publication.',
    tone: 'complete', attention: false, allowsSimulation: true,
  }),
  simulated_failed: Object.freeze({
    label: 'Simulation failed', detail: 'The durable TEST operation failed and needs operator attention.',
    tone: 'attention', attention: true, allowsSimulation: false,
  }),
  simulated_cancelled: Object.freeze({
    label: 'TEST plan cancelled', detail: 'The durable TEST operation was cancelled and cannot advance.',
    tone: 'cancelled', attention: false, allowsSimulation: false,
  }),
  reconciliation_required: Object.freeze({
    label: 'Reconciliation required', detail: 'The simulator result is ambiguous and requires safe reconciliation.',
    tone: 'attention', attention: true, allowsSimulation: false,
  }),
  simulated_reconciled: Object.freeze({
    label: 'Simulation reconciled', detail: 'The durable TEST simulator result was safely reconciled.',
    tone: 'complete', attention: false, allowsSimulation: true,
  }),
  dead_letter: Object.freeze({
    label: 'TEST dead letter', detail: 'Bounded attempts are exhausted; operator attention is required.',
    tone: 'attention', attention: true, allowsSimulation: false,
  }),
});

function canonicalInstant(value: string): boolean {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function safePublicSocialText(value: string, maximum: number): boolean {
  return typeof value === 'string' && value === value.trim() && value.length > 0
    && value.length <= maximum
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value);
}

function presentPublicSocial(
  provenance: ContentCalendarPublicSocialProvenance,
  slot: ContentCalendarSlotSnapshot,
): Readonly<{ view: ContentCalendarPublicSocialView; allowsSimulation: boolean }> {
  const knownState = Object.prototype.hasOwnProperty.call(PUBLIC_SOCIAL_STATE_META, provenance.state);
  const stateMeta = knownState ? PUBLIC_SOCIAL_STATE_META[provenance.state] : Object.freeze({
    label: 'Provenance locked', detail: 'The durable TEST state was not recognised.',
    tone: 'attention' as const, attention: true, allowsSimulation: false,
  });
  const campaignId = typeof provenance.campaignId === 'string' ? provenance.campaignId : 'locked';
  const revisionId = typeof provenance.revisionId === 'string' ? provenance.revisionId : 'locked';
  const campaignTitle = typeof provenance.campaignTitle === 'string'
    ? provenance.campaignTitle.slice(0, 200) : 'Campaign unavailable';
  const postId = typeof provenance.postId === 'string' ? provenance.postId : 'locked';
  const planSha256 = typeof provenance.planSha256 === 'string' ? provenance.planSha256 : 'locked';
  const operationId = typeof provenance.operationId === 'string' ? provenance.operationId : 'locked';
  const targetId = typeof provenance.targetId === 'string' ? provenance.targetId : 'locked';
  const targetLabel = typeof provenance.targetLabel === 'string'
    ? provenance.targetLabel.slice(0, 120) : 'Target unavailable';
  const revisionNumber = Number.isSafeInteger(provenance.revisionNumber)
    ? provenance.revisionNumber : 0;
  const simulationAttemptCount = Number.isSafeInteger(provenance.simulationAttemptCount)
    ? provenance.simulationAttemptCount : 0;
  const maxSimulationAttempts = Number.isSafeInteger(provenance.maxSimulationAttempts)
    ? provenance.maxSimulationAttempts : 0;
  const reconciliationAttemptCount = Number.isSafeInteger(provenance.reconciliationAttemptCount)
    ? provenance.reconciliationAttemptCount : 0;
  const maxReconciliationAttempts = Number.isSafeInteger(provenance.maxReconciliationAttempts)
    ? provenance.maxReconciliationAttempts : 0;
  const updatedAt = typeof provenance.updatedAt === 'string'
    ? provenance.updatedAt : '1970-01-01T00:00:00.000Z';
  const identityProofValid = [
    campaignId, revisionId, postId, operationId, targetId,
  ].every((value) => typeof value === 'string' && UUID.test(value))
    && revisionNumber > 0
    && safePublicSocialText(campaignTitle, 200)
    && SHA256.test(planSha256)
    && safePublicSocialText(targetLabel, 120)
    && PUBLIC_SOCIAL_CHANNELS.has(provenance.network)
    && provenance.network === slot.channel
    && operationId === slot.slotId
    && knownState
    && simulationAttemptCount >= 0
    && maxSimulationAttempts >= 1
    && simulationAttemptCount <= maxSimulationAttempts
    && reconciliationAttemptCount >= 0
    && maxReconciliationAttempts >= 1
    && reconciliationAttemptCount <= maxReconciliationAttempts
    && canonicalInstant(updatedAt)
    && provenance.environment === 'test'
    && provenance.providerEffects === 'none';
  const attention = !identityProofValid || stateMeta.attention;
  const stateLabel = identityProofValid ? stateMeta.label : 'Provenance locked';
  const stateDetail = identityProofValid
    ? stateMeta.detail
    : 'Campaign, operation or TEST-environment provenance contradicted the calendar slot and was locked.';
  const view: ContentCalendarPublicSocialView = Object.freeze({
    campaignId,
    revisionId,
    revisionNumber,
    campaignTitle,
    postId,
    planSha256,
    operationId,
    targetId,
    targetLabel,
    network: provenance.network,
    state: knownState ? provenance.state : 'dead_letter',
    simulationAttemptCount,
    maxSimulationAttempts,
    reconciliationAttemptCount,
    maxReconciliationAttempts,
    updatedAt,
    environment: 'test',
    providerEffects: 'none',
    campaignShortId: campaignId.slice(0, 8),
    revisionShortId: revisionId.slice(0, 8),
    postShortId: postId.slice(0, 8),
    operationShortId: operationId.slice(0, 8),
    targetShortId: targetId.slice(0, 8),
    planShortHash: planSha256.slice(0, 10),
    stateLabel,
    stateDetail,
    stateTone: identityProofValid ? stateMeta.tone : 'attention',
    attention,
    identityProofValid,
  });
  return Object.freeze({ view, allowsSimulation: identityProofValid && stateMeta.allowsSimulation });
}

function validDateOnly(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
    ? value
    : null;
}

function safeTimeZone(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 100) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: value }).format(new Date(0));
    return value;
  } catch {
    return 'UTC';
  }
}

function dateInTimeZone(value: string | Date, timeZone: string): string | null {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-GB', {
    year: 'numeric', month: '2-digit', day: '2-digit', timeZone,
  }).formatToParts(date);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  const candidate = year && month && day ? `${year}-${month}-${day}` : null;
  return candidate && validDateOnly(candidate) ? candidate : null;
}

function safeAsOfDate(asOf: string, timeZone = 'UTC'): string {
  return dateInTimeZone(asOf, safeTimeZone(timeZone)) ?? '1970-01-01';
}

export function normaliseContentCalendarFilters(
  input: ContentCalendarFilterInput = {},
  asOf = '1970-01-01T00:00:00.000Z',
  timeZone = 'UTC',
): ContentCalendarFiltersView {
  const requestedMode = input.mode ?? input.view;
  const mode = typeof requestedMode === 'string' && MODES.has(requestedMode as ContentCalendarMode)
    ? requestedMode as ContentCalendarMode
    : 'week';
  const channel = typeof input.channel === 'string' && CHANNELS.has(input.channel as ContentCalendarChannelFilter)
    ? input.channel as ContentCalendarChannelFilter
    : 'all';
  return Object.freeze({
    mode,
    date: validDateOnly(input.date) ?? safeAsOfDate(asOf, timeZone),
    channel,
  });
}

function utcDate(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + (days * DAY_MS));
}

function mondayOnOrBefore(date: Date): Date {
  const weekday = date.getUTCDay();
  return addDays(date, -(weekday === 0 ? 6 : weekday - 1));
}

function startOfMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function endOfMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
}

function periodBounds(filters: ContentCalendarFiltersView): Readonly<{
  gridStart: Date;
  gridEnd: Date;
  primaryStart: Date;
  primaryEnd: Date;
  previousDate: string;
  nextDate: string;
}> {
  const selected = utcDate(filters.date);
  if (filters.mode === 'week') {
    const start = mondayOnOrBefore(selected);
    const end = addDays(start, 6);
    return Object.freeze({
      gridStart: start,
      gridEnd: end,
      primaryStart: start,
      primaryEnd: end,
      previousDate: dateOnly(addDays(selected, -7)),
      nextDate: dateOnly(addDays(selected, 7)),
    });
  }
  const first = startOfMonth(selected);
  const last = endOfMonth(selected);
  const gridStart = mondayOnOrBefore(first);
  const lastWeekday = last.getUTCDay();
  const gridEnd = addDays(last, lastWeekday === 0 ? 0 : 7 - lastWeekday);
  return Object.freeze({
    gridStart,
    gridEnd,
    primaryStart: first,
    primaryEnd: last,
    previousDate: dateOnly(new Date(Date.UTC(selected.getUTCFullYear(), selected.getUTCMonth() - 1, 1))),
    nextDate: dateOnly(new Date(Date.UTC(selected.getUTCFullYear(), selected.getUTCMonth() + 1, 1))),
  });
}

function exactApproval(item: CompanyContentCatalogItem): boolean {
  return item.approvalStatus === 'approved'
    && item.approvalStale === false
    && item.approvalRequestId !== null
    && item.approvalDecisionId !== null;
}

function attestationFresh(item: CompanyContentCatalogItem, asOf: string): boolean {
  const asOfTime = new Date(asOf).getTime();
  const checkedAt = item.sourceCheckedAt ? new Date(item.sourceCheckedAt).getTime() : Number.NaN;
  const expiresAt = item.sourceExpiresAt ? new Date(item.sourceExpiresAt).getTime() : Number.NaN;
  return item.sourceFresh
    && item.sourceAttestationId !== null
    && Number.isFinite(asOfTime)
    && Number.isFinite(checkedAt)
    && Number.isFinite(expiresAt)
    && checkedAt <= asOfTime
    && asOfTime < expiresAt;
}

function gateDetail(input: Readonly<{
  item: CompanyContentCatalogItem | undefined;
  versionMatches: boolean;
  approved: boolean;
  fresh: boolean;
  eligible: boolean;
}>): string {
  if (!input.item) return 'The referenced immutable version is not in the loaded company catalogue.';
  if (!input.versionMatches) return 'The slot does not match the latest immutable version and exact content hash.';
  if (!input.approved) return `Immutable v${input.item.versionNumber} needs an exact current approval decision.`;
  if (!input.fresh) return 'The exact source proof is missing, expired or not yet valid.';
  if (!input.eligible) return 'The stored outbound gate is closed; the planner fails closed.';
  return 'Exact version, approval and source proof agree. Simulation only; no provider call is possible here.';
}

function presentSlot(
  slot: ContentCalendarSlotSnapshot,
  item: CompanyContentCatalogItem | undefined,
  asOf: string,
  index: number,
  timeZone: string,
): ContentCalendarSlotView {
  const versionMatches = Boolean(item
    && item.contentItemId === slot.contentItemId
    && item.contentVersionId === slot.contentVersionId
    && item.contentSha256 === slot.contentSha256);
  const approved = Boolean(item && exactApproval(item) && versionMatches);
  const fresh = Boolean(item && attestationFresh(item, asOf) && versionMatches);
  const contentEligible = Boolean(item?.publishable && versionMatches && approved && fresh);
  const publicSocialResult = slot.publicSocial
    ? presentPublicSocial(slot.publicSocial, slot)
    : null;
  const simulationEligible = contentEligible && (publicSocialResult?.allowsSimulation ?? true);
  const scheduled = new Date(slot.scheduledFor);
  const timeLabel = Number.isFinite(scheduled.getTime())
    ? new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone,
    }).format(scheduled)
    : 'Invalid time';
  return Object.freeze({
    slotId: slot.slotId,
    anchorId: `content-calendar-slot-${index + 1}`,
    title: item?.title ?? 'Version unavailable',
    contentItemId: slot.contentItemId,
    contentVersionId: slot.contentVersionId,
    versionNumber: item?.versionNumber ?? null,
    contentSha256: slot.contentSha256,
    shortHash: slot.contentSha256.slice(0, 10),
    scheduledFor: slot.scheduledFor,
    timeLabel,
    channel: slot.channel,
    channelLabel: CHANNEL_LABELS[slot.channel],
    channelCode: CHANNEL_CODES[slot.channel],
    variantLabel: slot.variantLabel,
    objectiveLabel: slot.objectiveLabel,
    ownerLabel: slot.ownerLabel,
    plannerState: slot.plannerState,
    plannerStateLabel: slot.plannerState === 'simulated_preview'
      ? 'Simulated preview' : 'Draft slot',
    immutableVersionMatches: versionMatches,
    exactApproval: approved,
    approvalLabel: !item
      ? 'Version unavailable'
      : approved ? `Approved · exact v${item.versionNumber}` : `Approval locked · v${item.versionNumber}`,
    sourceFresh: fresh,
    sourceFreshnessLabel: fresh ? 'Source proof fresh' : 'Source proof locked',
    sourceExpiresAt: item?.sourceExpiresAt ?? null,
    simulationEligible,
    gateLabel: simulationEligible ? 'Simulation ready' : 'Locked',
    gateDetail: !contentEligible
      ? gateDetail({ item, versionMatches, approved, fresh, eligible: contentEligible })
      : publicSocialResult && !publicSocialResult.allowsSimulation
        ? publicSocialResult.view.stateDetail
        : publicSocialResult
          ? `${gateDetail({ item, versionMatches, approved, fresh, eligible: contentEligible })} ${publicSocialResult.view.stateDetail}`
          : gateDetail({ item, versionMatches, approved, fresh, eligible: contentEligible }),
    publicSocial: publicSocialResult?.view ?? null,
  });
}

function presentBacklogItem(
  item: CompanyContentCatalogItem,
  asOf: string,
): ContentCalendarBacklogItemView {
  const approved = exactApproval(item);
  const fresh = attestationFresh(item, asOf);
  const eligible = item.publishable && approved && fresh;
  return Object.freeze({
    contentItemId: item.contentItemId,
    contentVersionId: item.contentVersionId,
    title: item.title,
    versionNumber: item.versionNumber,
    kindLabel: KIND_LABELS[item.kind],
    shortHash: item.contentSha256.slice(0, 10),
    approvalLabel: approved ? 'Exact approval' : item.approvalStale ? 'Approval stale' : 'Approval locked',
    sourceFreshnessLabel: fresh ? 'Source fresh' : 'Source locked',
    simulationEligible: eligible,
    gateDetail: gateDetail({ item, versionMatches: true, approved, fresh, eligible }),
  });
}

function validSlotDate(slot: ContentCalendarSlotSnapshot, timeZone: string): string | null {
  return dateInTimeZone(slot.scheduledFor, timeZone);
}

export function presentContentCalendar(
  snapshot: ContentCalendarSnapshot,
  options: PresentContentCalendarOptions,
): ContentCalendarView {
  const timeZone = safeTimeZone(options.timezone);
  const filters = normaliseContentCalendarFilters(options.filters, options.asOf, timeZone);
  const bounds = periodBounds(filters);
  const catalog = snapshot.catalog.items.slice(0, CONTENT_CALENDAR_MAX_CATALOG_ITEMS);
  const itemByVersion = new Map(catalog.map((item) => [item.contentVersionId, item] as const));
  const boundedSlots = snapshot.slots.slice(0, CONTENT_CALENDAR_MAX_SLOTS);
  const visibleSnapshots = boundedSlots
    .filter((slot) => filters.channel === 'all' || slot.channel === filters.channel)
    .filter((slot) => {
      const date = validSlotDate(slot, timeZone);
      return date !== null && date >= dateOnly(bounds.gridStart) && date <= dateOnly(bounds.gridEnd);
    })
    .sort((left, right) => left.scheduledFor.localeCompare(right.scheduledFor));
  const visibleSlots = visibleSnapshots.map((slot, index) => presentSlot(
    slot,
    itemByVersion.get(slot.contentVersionId),
    options.asOf,
    index,
    timeZone,
  ));
  const slotsByDate = new Map<string, ContentCalendarSlotView[]>();
  for (const [index, slot] of visibleSlots.entries()) {
    const snapshot = visibleSnapshots[index];
    if (!snapshot) continue;
    const date = validSlotDate(snapshot, timeZone);
    if (!date) continue;
    const daySlots = slotsByDate.get(date) ?? [];
    daySlots.push(slot);
    slotsByDate.set(date, daySlots);
  }

  const days: ContentCalendarDayView[] = [];
  for (let cursor = bounds.gridStart; cursor <= bounds.gridEnd; cursor = addDays(cursor, 1)) {
    const date = dateOnly(cursor);
    days.push(Object.freeze({
      date,
      weekdayLabel: new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: 'UTC' }).format(cursor),
      dayNumber: new Intl.DateTimeFormat('en-GB', { day: '2-digit', timeZone: 'UTC' }).format(cursor),
      fullDateLabel: new Intl.DateTimeFormat('en-GB', {
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
      }).format(cursor),
      inPrimaryPeriod: cursor >= bounds.primaryStart && cursor <= bounds.primaryEnd,
      isToday: date === safeAsOfDate(options.asOf, timeZone),
      slots: Object.freeze(slotsByDate.get(date) ?? []),
    }));
  }

  const scheduledVersionIds = new Set(boundedSlots.map((slot) => slot.contentVersionId));
  const backlog = catalog
    .filter((item) => !scheduledVersionIds.has(item.contentVersionId))
    .slice(0, CONTENT_CALENDAR_MAX_BACKLOG_ITEMS)
    .map((item) => presentBacklogItem(item, options.asOf));
  const ready = visibleSlots.filter((slot) => slot.simulationEligible).length;
  const channelCount = new Set(visibleSlots.map((slot) => slot.channel)).size;
  const selected = utcDate(filters.date);
  const periodLabel = filters.mode === 'week'
    ? `${new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(bounds.primaryStart)} – ${new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(bounds.primaryEnd)}`
    : new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(selected);

  return Object.freeze({
    workspaceName: options.workspaceName,
    timezone: timeZone,
    asOf: options.asOf,
    filters,
    periodLabel,
    previousDate: bounds.previousDate,
    nextDate: bounds.nextDate,
    days: Object.freeze(days),
    backlog: Object.freeze(backlog),
    metrics: Object.freeze({
      plannedSlots: visibleSlots.length,
      simulationReady: ready,
      blocked: visibleSlots.length - ready,
      activeChannels: channelCount,
    }),
    visibleSlotCount: visibleSlots.length,
    catalogCount: catalog.length,
    inputTruncated: snapshot.sourceTruncated
      || snapshot.catalog.nextCursor !== null
      || snapshot.catalog.items.length > CONTENT_CALENDAR_MAX_CATALOG_ITEMS
      || snapshot.slots.length > CONTENT_CALENDAR_MAX_SLOTS,
    sourceTruncated: snapshot.sourceTruncated,
    hasUnknownVersion: visibleSlots.some((slot) => !slot.immutableVersionMatches),
  });
}
