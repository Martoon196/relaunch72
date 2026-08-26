import type {
  CompanyContentCatalogItem,
  CompanyContentCatalogPage,
} from '../company-content-pg/types.js';

export const CONTENT_CALENDAR_ROUTE = '/portal/content/calendar' as const;
export const CONTENT_CALENDAR_MAX_CATALOG_ITEMS = 100;
export const CONTENT_CALENDAR_MAX_SLOTS = 120;
export const CONTENT_CALENDAR_MAX_BACKLOG_ITEMS = 8;

export type ContentCalendarMode = 'week' | 'month';
export type ContentCalendarChannel =
  | 'linkedin'
  | 'instagram'
  | 'facebook'
  | 'email'
  | 'webinar';
export type ContentCalendarChannelFilter = 'all' | ContentCalendarChannel;

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
}

export interface ContentCalendarSnapshot {
  readonly catalog: CompanyContentCatalogPage;
  readonly slots: readonly ContentCalendarSlotSnapshot[];
}

export interface ContentCalendarFilterInput {
  readonly mode?: unknown;
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
  'all', 'linkedin', 'instagram', 'facebook', 'email', 'webinar',
]);
const DAY_MS = 86_400_000;

const CHANNEL_LABELS: Readonly<Record<ContentCalendarChannel, string>> = Object.freeze({
  linkedin: 'LinkedIn',
  instagram: 'Instagram',
  facebook: 'Facebook',
  email: 'Email',
  webinar: 'Webinar',
});

const CHANNEL_CODES: Readonly<Record<ContentCalendarChannel, string>> = Object.freeze({
  linkedin: 'in',
  instagram: 'ig',
  facebook: 'fb',
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

function validDateOnly(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
    ? value
    : null;
}

function safeAsOfDate(asOf: string): string {
  const date = new Date(asOf);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : '1970-01-01';
}

export function normaliseContentCalendarFilters(
  input: ContentCalendarFilterInput = {},
  asOf = '1970-01-01T00:00:00.000Z',
): ContentCalendarFiltersView {
  const mode = typeof input.mode === 'string' && MODES.has(input.mode as ContentCalendarMode)
    ? input.mode as ContentCalendarMode
    : 'week';
  const channel = typeof input.channel === 'string' && CHANNELS.has(input.channel as ContentCalendarChannelFilter)
    ? input.channel as ContentCalendarChannelFilter
    : 'all';
  return Object.freeze({
    mode,
    date: validDateOnly(input.date) ?? safeAsOfDate(asOf),
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
): ContentCalendarSlotView {
  const versionMatches = Boolean(item
    && item.contentItemId === slot.contentItemId
    && item.contentVersionId === slot.contentVersionId
    && item.contentSha256 === slot.contentSha256);
  const approved = Boolean(item && exactApproval(item) && versionMatches);
  const fresh = Boolean(item && attestationFresh(item, asOf) && versionMatches);
  const simulationEligible = Boolean(item?.publishable && versionMatches && approved && fresh);
  const scheduled = new Date(slot.scheduledFor);
  const timeLabel = Number.isFinite(scheduled.getTime())
    ? new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC',
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
    gateDetail: gateDetail({ item, versionMatches, approved, fresh, eligible: simulationEligible }),
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

function validSlotDate(slot: ContentCalendarSlotSnapshot): string | null {
  const parsed = new Date(slot.scheduledFor);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : null;
}

export function presentContentCalendar(
  snapshot: ContentCalendarSnapshot,
  options: PresentContentCalendarOptions,
): ContentCalendarView {
  const filters = normaliseContentCalendarFilters(options.filters, options.asOf);
  const bounds = periodBounds(filters);
  const catalog = snapshot.catalog.items.slice(0, CONTENT_CALENDAR_MAX_CATALOG_ITEMS);
  const itemByVersion = new Map(catalog.map((item) => [item.contentVersionId, item] as const));
  const boundedSlots = snapshot.slots.slice(0, CONTENT_CALENDAR_MAX_SLOTS);
  const visibleSnapshots = boundedSlots
    .filter((slot) => filters.channel === 'all' || slot.channel === filters.channel)
    .filter((slot) => {
      const date = validSlotDate(slot);
      return date !== null && date >= dateOnly(bounds.gridStart) && date <= dateOnly(bounds.gridEnd);
    })
    .sort((left, right) => left.scheduledFor.localeCompare(right.scheduledFor));
  const visibleSlots = visibleSnapshots.map((slot, index) => presentSlot(
    slot,
    itemByVersion.get(slot.contentVersionId),
    options.asOf,
    index,
  ));
  const slotsByDate = new Map<string, ContentCalendarSlotView[]>();
  for (const [index, slot] of visibleSlots.entries()) {
    const snapshot = visibleSnapshots[index];
    if (!snapshot) continue;
    const date = validSlotDate(snapshot);
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
      isToday: date === safeAsOfDate(options.asOf),
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
    timezone: options.timezone,
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
    inputTruncated: snapshot.catalog.items.length > CONTENT_CALENDAR_MAX_CATALOG_ITEMS
      || snapshot.slots.length > CONTENT_CALENDAR_MAX_SLOTS,
    hasUnknownVersion: visibleSlots.some((slot) => !slot.immutableVersionMatches),
  });
}
