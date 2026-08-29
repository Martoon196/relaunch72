/**
 * Presenter for the Property Predator Live Channels control room.
 *
 * Fail-closed: every fact rendered by the view must be proven by the
 * snapshot or derived here from proven switch state. The presenter throws
 * on any inconsistency instead of displaying an unproven claim, and it
 * derives channel posture itself — a service can never simply assert that
 * a channel is live.
 */

import {
  CUSTOMER_EMAIL_DAILY_HARD_CAP,
  CUSTOMER_EMAIL_LIVE_CONTRACT,
  CUSTOMER_EMAIL_MONTHLY_HARD_CAP,
} from '../customer-email-live/foundation.js';
import { OWNED_PUBLIC_SOCIAL_LIVE_CONTRACT } from '../public-social-outbound/owned-live-foundation.js';
import { META_WHATSAPP_LIVE_CONTRACT } from '../whatsapp-live/foundation.js';
import { CONVERSION_INBOX_ROUTE } from './conversion-inbox-presenter.js';
import { CONTENT_CALENDAR_ROUTE } from './content-calendar-presenter.js';
import { PUBLIC_SOCIAL_CAMPAIGNS_ROUTE } from './public-social-campaigns-presenter.js';
import { PROVIDER_READINESS_COCKPIT_ROUTE } from './provider-readiness-cockpit-presenter.js';
import type {
  LiveChannelId,
  LiveChannelMode,
  LiveChannelProviderId,
  PortalLiveChannelSnapshot,
  PortalLiveChannelsSnapshot,
} from './live-channels-service.js';

export const LIVE_CHANNELS_ROUTE = '/portal/channels/live' as const;
export const LIVE_CHANNELS_PAUSE_ROUTE = '/portal/channels/live/emergency-pause' as const;

export const LIVE_CHANNEL_IDS: readonly LiveChannelId[] = Object.freeze([
  'customer_email_mailgun',
  'owned_public_social',
  'meta_whatsapp',
]);

export type LiveChannelPosture = 'ready' | 'degraded' | 'paused' | 'blocked' | 'not_connected';
export type LiveChannelToneClass = 'ready' | 'working' | 'paused' | 'blocked' | 'muted';

export interface LiveChannelGaugeView {
  readonly label: string;
  readonly used: number;
  readonly cap: number;
  readonly percent: number;
  readonly summary: string;
  readonly attention: boolean;
}

export interface LiveChannelLinkView {
  readonly href: string;
  readonly label: string;
}

export interface LiveChannelReceiptView {
  readonly eventKind: string;
  readonly eventLabel: string;
  readonly safeCode: string;
  readonly occurredAt: string;
  readonly tone: LiveChannelToneClass;
}

export interface LiveChannelTimelineView extends LiveChannelReceiptView {
  readonly channel: LiveChannelId;
  readonly channelLabel: string;
}

export interface LiveChannelBlockerView {
  readonly code: string;
  readonly message: string;
  /** True when the presenter derived this from proven switch state. */
  readonly derived: boolean;
}

export interface LiveChannelCardView {
  readonly channel: LiveChannelId;
  readonly anchorId: string;
  readonly eyebrow: string;
  readonly label: string;
  readonly providerLabel: string;
  readonly accountLabel: string;
  readonly connectionLabel: string;
  readonly connectionStatusLabel: string;
  readonly contract: string;
  readonly posture: LiveChannelPosture;
  readonly postureLabel: string;
  readonly postureTone: LiveChannelToneClass;
  readonly modeLabel: string;
  readonly effectsLabel: string;
  readonly deliveryLabel: string | null;
  readonly pauseEngaged: boolean;
  readonly pauseLabel: 'ENGAGED' | 'RELEASED';
  readonly workerLabel: string;
  readonly dispatch: Readonly<{
    queued: number;
    inFlight: number;
    awaitingProof: number;
    needsAttention: number;
    succeededToday: number;
    failedToday: number;
    observedLabel: string;
  }>;
  readonly gauges: readonly LiveChannelGaugeView[];
  readonly perJobLabel: string;
  readonly approvalRequirement: string;
  readonly approvalsPending: number;
  readonly approvalsOldestAt: string | null;
  readonly permissionStateLabel: string;
  readonly permissionTone: LiveChannelToneClass;
  readonly permissionDetail: string;
  readonly targetScope: string;
  readonly latestReceipt: LiveChannelReceiptView | null;
  readonly whyBlocked: readonly LiveChannelBlockerView[];
  readonly nextAction: Readonly<{ label: string; detail: string; link: LiveChannelLinkView | null }>;
  readonly links: readonly LiveChannelLinkView[];
}

export type LiveChannelsNoticeCode =
  | 'pause_engaged'
  | 'pause_already'
  | 'invalid'
  | 'forbidden'
  | 'unavailable';

export interface LiveChannelsNoticeView {
  readonly kind: 'success' | 'info' | 'error';
  readonly title: string;
  readonly message: string;
}

export interface LiveChannelsView {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly snapshotAt: string;
  readonly dataset: PortalLiveChannelsSnapshot['dataset'];
  readonly illustrative: boolean;
  readonly channels: readonly LiveChannelCardView[];
  readonly readyCount: number;
  readonly pausedCount: number;
  readonly blockedCount: number;
  readonly degradedCount: number;
  readonly notConnectedCount: number;
  readonly launchReadinessLabel: string;
  readonly launchReadinessTone: LiveChannelToneClass;
  readonly allPaused: boolean;
  readonly totalQueued: number;
  readonly totalNeedsAttention: number;
  readonly totalApprovalsPending: number;
  readonly totalUsedToday: number;
  readonly totalDailyCap: number;
  readonly timeline: readonly LiveChannelTimelineView[];
  readonly handoff: Readonly<{
    conversionInboxComposed: boolean;
    lead360Composed: boolean;
    whatsappProjectionLabel: string;
    inboundLastDayLabel: string;
  }>;
}

interface ChannelStatic {
  readonly eyebrow: string;
  readonly label: string;
  readonly providerId: LiveChannelProviderId;
  readonly liveMode: Exclude<LiveChannelMode, 'disabled'>;
  readonly contract: string;
  readonly dailyCap: number;
  readonly monthlyCap: number;
  readonly maxRecipientsPerJob: number;
  readonly maxOperationsPerCycle: number;
  readonly hasDeliverySwitch: boolean;
  readonly receiptKinds: ReadonlySet<string>;
  readonly failureReceiptKinds: ReadonlySet<string>;
  readonly approvalRequirement: string;
  readonly targetScope: string;
  readonly unitNoun: string;
  readonly links: readonly LiveChannelLinkView[];
}

const CHANNEL_STATIC: Readonly<Record<LiveChannelId, ChannelStatic>> = Object.freeze({
  customer_email_mailgun: Object.freeze({
    eyebrow: 'Owned audience',
    label: 'Customer email',
    providerId: 'mailgun_eu',
    liveMode: 'customer_live',
    contract: CUSTOMER_EMAIL_LIVE_CONTRACT,
    dailyCap: CUSTOMER_EMAIL_DAILY_HARD_CAP,
    monthlyCap: CUSTOMER_EMAIL_MONTHLY_HARD_CAP,
    maxRecipientsPerJob: 1,
    maxOperationsPerCycle: 1,
    hasDeliverySwitch: true,
    receiptKinds: new Set([
      'dispatch_accepted', 'dispatch_failed', 'outcome_unknown', 'accepted',
      'delivered', 'opened', 'clicked', 'failed', 'complained', 'unsubscribed',
    ]),
    failureReceiptKinds: new Set(['dispatch_failed', 'outcome_unknown', 'failed', 'complained', 'unsubscribed']),
    approvalRequirement: 'Approved campaign version, approved message and granted consent — all hash-bound inside a 15-minute authority window.',
    targetScope: 'One verified, consented email recipient per job · marketing purpose only · suppression always respected.',
    unitNoun: 'sends',
    links: Object.freeze([
      Object.freeze({ href: `${CONVERSION_INBOX_ROUTE}?channel=email`, label: 'Email conversations' }),
      Object.freeze({ href: `${CONVERSION_INBOX_ROUTE}?queue=approval`, label: 'Approval queue' }),
    ]),
  }),
  owned_public_social: Object.freeze({
    eyebrow: 'Audience growth',
    label: 'Owned social publishing',
    providerId: 'ayrshare',
    liveMode: 'owned_profile_live',
    contract: OWNED_PUBLIC_SOCIAL_LIVE_CONTRACT,
    dailyCap: 1,
    monthlyCap: 3,
    maxRecipientsPerJob: 1,
    maxOperationsPerCycle: 1,
    hasDeliverySwitch: false,
    receiptKinds: new Set(['accepted', 'published', 'failed', 'outcome_unknown']),
    failureReceiptKinds: new Set(['failed', 'outcome_unknown']),
    approvalRequirement: 'Approved latest content version plus a fresh source attestation, hash-bound at enqueue.',
    targetScope: 'One owned X profile · approved, link-free post text · 280 characters maximum.',
    unitNoun: 'posts',
    links: Object.freeze([
      Object.freeze({ href: PUBLIC_SOCIAL_CAMPAIGNS_ROUTE, label: 'Campaigns' }),
      Object.freeze({ href: CONTENT_CALENDAR_ROUTE, label: 'Calendar' }),
    ]),
  }),
  meta_whatsapp: Object.freeze({
    eyebrow: 'Private messaging',
    label: 'Meta WhatsApp',
    providerId: 'meta_whatsapp_cloud',
    liveMode: 'owned_template_live',
    contract: META_WHATSAPP_LIVE_CONTRACT,
    dailyCap: 1,
    monthlyCap: 3,
    maxRecipientsPerJob: 1,
    maxOperationsPerCycle: 1,
    hasDeliverySwitch: false,
    receiptKinds: new Set([
      'accepted', 'sent', 'delivered', 'read', 'failed',
      'deleted', 'outcome_unknown', 'inbound_received',
    ]),
    failureReceiptKinds: new Set(['failed', 'deleted', 'outcome_unknown']),
    approvalRequirement: 'Meta-approved zero-parameter template, granted consent and the full PECR specialist chain inside a 15-minute authority window.',
    targetScope: 'One consented WhatsApp recipient per job · approved template messages only.',
    unitNoun: 'messages',
    links: Object.freeze([
      Object.freeze({ href: `${CONVERSION_INBOX_ROUTE}?channel=whatsapp`, label: 'WhatsApp conversations' }),
      Object.freeze({ href: `${CONVERSION_INBOX_ROUTE}?queue=approval`, label: 'Approval queue' }),
    ]),
  }),
});

const POSTURE_LABELS: Readonly<Record<LiveChannelPosture, string>> = Object.freeze({
  ready: 'Connected · ready',
  degraded: 'Degraded',
  paused: 'Paused',
  blocked: 'Blocked',
  not_connected: 'Not connected',
});

const POSTURE_TONES: Readonly<Record<LiveChannelPosture, LiveChannelToneClass>> = Object.freeze({
  ready: 'ready',
  degraded: 'working',
  paused: 'paused',
  blocked: 'blocked',
  not_connected: 'muted',
});

const RECEIPT_LABELS: Readonly<Record<string, string>> = Object.freeze({
  dispatch_accepted: 'Dispatch accepted',
  dispatch_failed: 'Dispatch failed',
  outcome_unknown: 'Outcome unknown',
  accepted: 'Accepted by provider',
  published: 'Published',
  delivered: 'Delivered',
  opened: 'Opened',
  clicked: 'Clicked',
  sent: 'Sent',
  read: 'Read',
  failed: 'Failed',
  deleted: 'Deleted by recipient',
  complained: 'Complaint received',
  unsubscribed: 'Unsubscribed',
  inbound_received: 'Inbound received',
});

const BLOCKER_CODE = /^[A-Z][A-Z0-9_]{2,79}$/;
const SAFE_CODE = /^[a-z][a-z0-9_.:-]{0,99}$/;
const SECRET_SHAPED = /(api[_-]?key|secret|token|bearer|password|credential)/i;
const LONG_OPAQUE_RUN = /[A-Za-z0-9+/=_-]{24,}/;
/** A safe code is words joined by separators; an unbroken 24+ alnum run is key-shaped. */
const OPAQUE_SAFE_CODE_RUN = /[a-z0-9]{24,}/;
const MAX_TIMELINE = 20;

function boundedText(value: unknown, fallback: string, max = 160): string {
  if (typeof value !== 'string') return fallback;
  const clean = value.trim();
  return clean ? [...clean].slice(0, max).join('') : fallback;
}

function safeLabel(value: unknown, label: string, max = 120): string {
  const text = boundedText(value, '', max);
  if (!text) throw new Error(`${label} is missing`);
  if (SECRET_SHAPED.test(text) || LONG_OPAQUE_RUN.test(text)) {
    throw new Error(`${label} looks secret-shaped and cannot be displayed`);
  }
  return text;
}

function safeCount(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)
      || value < 0 || value > 1_000_000) {
    throw new Error(`${label} must be a bounded non-negative safe integer`);
  }
  return value;
}

function instant(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function requiredInstant(value: unknown, label: string): string {
  const parsed = instant(value);
  if (!parsed) throw new Error(`${label} is invalid`);
  return parsed;
}

function presentReceipt(
  source: PortalLiveChannelSnapshot['latestReceipt'],
  statics: ChannelStatic,
  asOfMs: number,
): LiveChannelReceiptView | null {
  if (source === null) return null;
  if (!source || typeof source !== 'object') throw new Error('live channel receipt is invalid');
  if (typeof source.eventKind !== 'string' || !statics.receiptKinds.has(source.eventKind)) {
    throw new Error(`live channel receipt kind is outside the ${statics.label} contract`);
  }
  if (typeof source.safeCode !== 'string' || !SAFE_CODE.test(source.safeCode)
      || OPAQUE_SAFE_CODE_RUN.test(source.safeCode)) {
    throw new Error('live channel receipt safe code is invalid or secret-shaped');
  }
  const occurredAt = requiredInstant(source.occurredAt, 'receipt occurredAt');
  const recordedAt = requiredInstant(source.recordedAt, 'receipt recordedAt');
  if (Date.parse(occurredAt) > asOfMs || Date.parse(recordedAt) > asOfMs) {
    throw new Error('live channel receipt is newer than its snapshot');
  }
  return Object.freeze({
    eventKind: source.eventKind,
    eventLabel: RECEIPT_LABELS[source.eventKind] ?? source.eventKind,
    safeCode: source.safeCode,
    occurredAt,
    tone: statics.failureReceiptKinds.has(source.eventKind)
      ? 'blocked'
      : source.eventKind === 'accepted' || source.eventKind === 'dispatch_accepted' || source.eventKind === 'sent'
        ? 'working'
        : 'ready',
  });
}

function derivedBlockers(
  source: PortalLiveChannelSnapshot,
  statics: ChannelStatic,
): LiveChannelBlockerView[] {
  const gaps: LiveChannelBlockerView[] = [];
  if (source.identity.connectionStatus !== 'active') {
    gaps.push({
      code: 'CONNECTION_NOT_ACTIVE',
      message: source.identity.connectionStatus === 'revoked'
        ? 'The live provider connection was revoked. A new connection must be recorded before anything can dispatch.'
        : 'No active live provider connection is recorded for this channel.',
      derived: true,
    });
  }
  if (source.switches.mode === 'disabled') {
    gaps.push({
      code: 'MODE_DISABLED',
      message: 'The channel execution mode is disabled by its environment switch tuple.',
      derived: true,
    });
  }
  if (!source.switches.providerEffectsEnabled) {
    gaps.push({
      code: 'PROVIDER_EFFECTS_OFF',
      message: 'The provider-effects switch is OFF, so no external call can be made.',
      derived: true,
    });
  }
  if (statics.hasDeliverySwitch && source.switches.deliveryEnabled === false) {
    gaps.push({
      code: 'DELIVERY_SWITCH_OFF',
      message: 'The channel delivery switch is OFF, so dispatch cannot begin.',
      derived: true,
    });
  }
  if (!source.dispatch.workerComposed) {
    gaps.push({
      code: 'WORKER_NOT_COMPOSED',
      message: 'No dispatch worker is composed for this channel, so queued work cannot move.',
      derived: true,
    });
  }
  if (source.permission.state === 'missing' || source.permission.state === 'revoked') {
    gaps.push({
      code: 'PERMISSION_NOT_GRANTED',
      message: source.permission.state === 'revoked'
        ? 'The channel permission or consent evidence was revoked and must be re-established.'
        : 'No granted consent or permission evidence currently covers the allowed target scope.',
      derived: true,
    });
  }
  return gaps;
}

function derivePosture(
  source: PortalLiveChannelSnapshot,
  hardBlockers: readonly LiveChannelBlockerView[],
): LiveChannelPosture {
  const connected = source.identity.connectionStatus === 'active'
    && source.dispatch.workerComposed
    && source.switches.mode !== 'disabled';
  if (!connected) return 'not_connected';
  if (hardBlockers.length > 0) return 'blocked';
  if (source.switches.emergencyPaused) return 'paused';
  if (source.dispatch.needsAttentionCount > 0
      || source.dispatch.failedTodayCount > 0
      || source.permission.state === 'partial') return 'degraded';
  return 'ready';
}

function nextActionFor(
  posture: LiveChannelPosture,
  statics: ChannelStatic,
  blockers: readonly LiveChannelBlockerView[],
): LiveChannelCardView['nextAction'] {
  if (posture === 'not_connected') {
    return Object.freeze({
      label: 'Compose the rail',
      detail: 'Connection, worker and mode evidence must land before this channel can be assessed. Track progress on Rail status.',
      link: Object.freeze({ href: PROVIDER_READINESS_COCKPIT_ROUTE, label: 'Open Rail status' }),
    });
  }
  if (posture === 'blocked') {
    const first = blockers[0];
    return Object.freeze({
      label: 'Clear the first blocker',
      detail: first
        ? first.message
        : 'Resolve the listed blockers; nothing can dispatch until each one clears.',
      link: Object.freeze({ href: PROVIDER_READINESS_COCKPIT_ROUTE, label: 'Open Rail status' }),
    });
  }
  if (posture === 'paused') {
    return Object.freeze({
      label: 'Pause release is a separate decision',
      detail: 'Everything else on this rail is proven. Releasing the emergency pause happens outside this portal, deliberately.',
      link: null,
    });
  }
  if (posture === 'degraded') {
    return Object.freeze({
      label: 'Review attention items',
      detail: `Needs-attention or failed ${statics.unitNoun} require a human decision before the rail is clean again.`,
      link: Object.freeze({ href: PROVIDER_READINESS_COCKPIT_ROUTE, label: 'Open Rail status' }),
    });
  }
  return Object.freeze({
    label: 'No action needed',
    detail: `The rail is live inside its caps. Watch receipts and the Conversion Inbox for ${statics.unitNoun} as they land.`,
    link: Object.freeze({ href: CONVERSION_INBOX_ROUTE, label: 'Open Conversion Inbox' }),
  });
}

function gauge(
  label: string,
  used: number,
  cap: number,
  unitNoun: string,
): LiveChannelGaugeView {
  if (cap < 1 || cap > 1_000_000) throw new Error('live channel cap is out of bounds');
  if (used > cap) throw new Error(`live channel usage exceeds its hard cap for ${label}`);
  const percent = Math.round((used / cap) * 100);
  return Object.freeze({
    label,
    used,
    cap,
    percent,
    summary: `${used.toLocaleString('en-GB')} of ${cap.toLocaleString('en-GB')} ${unitNoun} used`,
    attention: percent >= 80,
  });
}

function readableObserved(observedAt: string | null, workerComposed: boolean): string {
  if (!workerComposed) return 'No worker composed';
  if (!observedAt) throw new Error('a composed worker must carry an observation instant');
  return `Observed ${observedAt}`;
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${label} must be a proven boolean, never a truthy stand-in`);
  }
  return value;
}

function presentChannel(
  source: PortalLiveChannelSnapshot,
  illustrative: boolean,
  asOfMs: number,
): LiveChannelCardView {
  const statics = CHANNEL_STATIC[source.channel];
  if (!statics) throw new Error('live channel id is outside the controlled set');
  requiredBoolean(source.switches.providerEffectsEnabled, 'provider effects switch');
  requiredBoolean(source.switches.emergencyPaused, 'emergency pause switch');
  requiredBoolean(source.dispatch.workerComposed, 'worker composition');
  if (source.switches.deliveryEnabled !== null) {
    requiredBoolean(source.switches.deliveryEnabled, 'delivery switch');
  }
  if (source.identity.providerId !== statics.providerId) {
    throw new Error(`live channel ${source.channel} claims a foreign provider`);
  }
  if (source.identity.environment !== 'live') {
    throw new Error('live channel identity must be scoped to the live environment');
  }
  if (source.identity.contract !== statics.contract) {
    throw new Error(`live channel ${source.channel} evidence is not bound to its foundation contract`);
  }
  if (!['active', 'missing', 'revoked'].includes(source.identity.connectionStatus)) {
    throw new Error('live channel connection status is invalid');
  }
  if (source.switches.mode !== 'disabled' && source.switches.mode !== statics.liveMode) {
    throw new Error(`live channel ${source.channel} claims a foreign execution mode`);
  }
  if (statics.hasDeliverySwitch === (source.switches.deliveryEnabled === null)) {
    throw new Error(`live channel ${source.channel} delivery switch shape is invalid`);
  }
  if (source.caps.dailyCap !== statics.dailyCap
      || source.caps.monthlyCap !== statics.monthlyCap
      || source.caps.maxRecipientsPerJob !== statics.maxRecipientsPerJob
      || source.caps.maxOperationsPerCycle !== statics.maxOperationsPerCycle) {
    throw new Error(`live channel ${source.channel} caps do not match the foundation hard caps`);
  }
  const usedToday = safeCount(source.caps.usedToday, 'daily usage');
  const usedThisMonth = safeCount(source.caps.usedThisMonth, 'monthly usage');
  if (usedToday > usedThisMonth) {
    throw new Error('live channel daily usage cannot exceed monthly usage');
  }
  const queued = safeCount(source.dispatch.queuedCount, 'queued count');
  const inFlight = safeCount(source.dispatch.inFlightCount, 'in-flight count');
  const awaitingProof = safeCount(source.dispatch.awaitingProofCount, 'awaiting-proof count');
  const needsAttention = safeCount(source.dispatch.needsAttentionCount, 'needs-attention count');
  const succeededToday = safeCount(source.dispatch.succeededTodayCount, 'succeeded-today count');
  const failedToday = safeCount(source.dispatch.failedTodayCount, 'failed-today count');
  if (!source.dispatch.workerComposed && (inFlight > 0)) {
    throw new Error('an uncomposed worker cannot hold in-flight work');
  }
  const observedAt = source.dispatch.observedAt === null
    ? null
    : requiredInstant(source.dispatch.observedAt, 'dispatch observedAt');
  if (observedAt && Date.parse(observedAt) > asOfMs) {
    throw new Error('dispatch telemetry is newer than its snapshot');
  }
  if (!['granted', 'partial', 'missing', 'revoked'].includes(source.permission.state)) {
    throw new Error('live channel permission state is invalid');
  }
  const permissionCheckedAt = source.permission.checkedAt === null
    ? null
    : requiredInstant(source.permission.checkedAt, 'permission checkedAt');
  if (permissionCheckedAt && Date.parse(permissionCheckedAt) > asOfMs) {
    throw new Error('permission evidence is newer than its snapshot');
  }
  const approvalsPending = safeCount(source.approvals.pendingCount, 'pending approvals');
  const approvalsOldestAt = source.approvals.oldestPendingAt === null
    ? null
    : requiredInstant(source.approvals.oldestPendingAt, 'oldest pending approval');
  if ((approvalsPending === 0) !== (approvalsOldestAt === null)) {
    throw new Error('approval queue evidence is contradictory');
  }
  if (!Array.isArray(source.blockers) || source.blockers.length > 12) {
    throw new Error('live channel blocker evidence is out of bounds');
  }
  const blockerSource: readonly PortalLiveChannelSnapshot['blockers'][number][] = source.blockers;
  const seenCodes = new Set<string>();
  const suppliedBlockers = blockerSource.map((blocker) => {
    if (!blocker || typeof blocker !== 'object'
        || typeof blocker.code !== 'string' || !BLOCKER_CODE.test(blocker.code)
        || seenCodes.has(blocker.code)
        || typeof blocker.message !== 'string'
        || blocker.message !== blocker.message.trim()
        || blocker.message.length < 8 || blocker.message.length > 240) {
      throw new Error('live channel blocker evidence is invalid');
    }
    if (LONG_OPAQUE_RUN.test(blocker.message)) {
      throw new Error('live channel blocker message looks secret-shaped and cannot be displayed');
    }
    seenCodes.add(blocker.code);
    return Object.freeze({ code: blocker.code, message: blocker.message, derived: false });
  });
  const gapBlockers = derivedBlockers(source, statics)
    .filter((gap) => !seenCodes.has(gap.code))
    .map((gap) => Object.freeze(gap));
  const whyBlocked = Object.freeze([...suppliedBlockers, ...gapBlockers]);
  const posture = derivePosture(source, whyBlocked);
  if (illustrative && (posture === 'ready' || posture === 'degraded')) {
    throw new Error('an illustrative fixture can never depict a deliverable live channel');
  }
  const latestReceipt = presentReceipt(source.latestReceipt, statics, asOfMs);
  return Object.freeze({
    channel: source.channel,
    anchorId: `live-${source.channel.replaceAll('_', '-')}`,
    eyebrow: statics.eyebrow,
    label: statics.label,
    providerLabel: safeLabel(source.identity.providerLabel, 'provider label', 60),
    accountLabel: safeLabel(source.identity.accountLabel, 'account label', 120),
    connectionLabel: safeLabel(source.identity.connectionLabel, 'connection label', 120),
    connectionStatusLabel: source.identity.connectionStatus === 'active'
      ? 'Connection active'
      : source.identity.connectionStatus === 'revoked'
        ? 'Connection revoked'
        : 'No live connection',
    contract: statics.contract,
    posture,
    postureLabel: POSTURE_LABELS[posture],
    postureTone: POSTURE_TONES[posture],
    modeLabel: source.switches.mode === 'disabled'
      ? 'MODE · DISABLED'
      : `MODE · ${statics.liveMode.toUpperCase()}`,
    effectsLabel: source.switches.providerEffectsEnabled ? 'EFFECTS ON' : 'EFFECTS OFF',
    deliveryLabel: statics.hasDeliverySwitch
      ? (source.switches.deliveryEnabled ? 'DELIVERY ON' : 'DELIVERY OFF')
      : null,
    pauseEngaged: source.switches.emergencyPaused,
    pauseLabel: source.switches.emergencyPaused ? 'ENGAGED' : 'RELEASED',
    workerLabel: source.dispatch.workerComposed ? 'Worker composed' : 'No worker composed',
    dispatch: Object.freeze({
      queued,
      inFlight,
      awaitingProof,
      needsAttention,
      succeededToday,
      failedToday,
      observedLabel: readableObserved(observedAt, source.dispatch.workerComposed),
    }),
    gauges: Object.freeze([
      gauge('Today', usedToday, statics.dailyCap, statics.unitNoun),
      gauge('This month', usedThisMonth, statics.monthlyCap, statics.unitNoun),
    ]),
    perJobLabel: `${statics.maxRecipientsPerJob} recipient / job · ${statics.maxOperationsPerCycle} operation / cycle`,
    approvalRequirement: statics.approvalRequirement,
    approvalsPending,
    approvalsOldestAt,
    permissionStateLabel: source.permission.state === 'granted'
      ? 'Granted'
      : source.permission.state === 'partial'
        ? 'Partially granted'
        : source.permission.state === 'revoked' ? 'Revoked' : 'Missing',
    permissionTone: source.permission.state === 'granted'
      ? 'ready'
      : source.permission.state === 'partial' ? 'working' : 'blocked',
    permissionDetail: safeLabel(source.permission.detail, 'permission detail', 240),
    targetScope: statics.targetScope,
    latestReceipt,
    whyBlocked,
    nextAction: nextActionFor(posture, statics, whyBlocked),
    links: statics.links,
  });
}

export function presentLiveChannels(
  snapshot: PortalLiveChannelsSnapshot,
): LiveChannelsView {
  if (!snapshot
      || (snapshot.dataset !== 'evidence' && snapshot.dataset !== 'illustrative_fixture')) {
    throw new Error('live channels snapshot dataset is invalid');
  }
  const workspaceId = boundedText(snapshot.workspace?.workspaceId, '', 64);
  const workspaceName = boundedText(snapshot.workspace?.workspaceName, 'Property Predator Growth HQ');
  const snapshotAt = instant(snapshot.workspace?.snapshotAt);
  if (!workspaceId || !snapshotAt) throw new Error('live channels workspace boundary is invalid');
  const asOfMs = Date.parse(snapshotAt);
  const illustrative = snapshot.dataset === 'illustrative_fixture';
  if (!Array.isArray(snapshot.channels) || snapshot.channels.length !== LIVE_CHANNEL_IDS.length) {
    throw new Error('live channels snapshot must contain the exact channel set');
  }
  const channelSource: readonly PortalLiveChannelSnapshot[] = snapshot.channels;
  const byChannel = new Map(channelSource.map((channel) => [channel.channel, channel]));
  if (byChannel.size !== LIVE_CHANNEL_IDS.length
      || LIVE_CHANNEL_IDS.some((id) => !byChannel.has(id))) {
    throw new Error('live channels snapshot channel set is incomplete or duplicated');
  }
  const channels = Object.freeze(LIVE_CHANNEL_IDS.map((id) =>
    presentChannel(byChannel.get(id)!, illustrative, asOfMs)));
  if (!Array.isArray(snapshot.receipts) || snapshot.receipts.length > MAX_TIMELINE) {
    throw new Error('live channels receipt timeline is out of bounds');
  }
  const receiptSource: readonly PortalLiveChannelsSnapshot['receipts'][number][] = snapshot.receipts;
  let previousMs = Number.POSITIVE_INFINITY;
  const timeline = Object.freeze(receiptSource.map((event) => {
    const statics = CHANNEL_STATIC[event.channel];
    if (!statics) throw new Error('timeline receipt names an unknown channel');
    const receipt = presentReceipt(event, statics, asOfMs);
    if (!receipt) throw new Error('timeline receipt is empty');
    const occurredMs = Date.parse(receipt.occurredAt);
    if (occurredMs > previousMs) {
      throw new Error('live channels receipt timeline must be newest first');
    }
    previousMs = occurredMs;
    return Object.freeze({
      ...receipt,
      channel: event.channel,
      channelLabel: statics.label,
    });
  }));
  for (const channel of channels) {
    const newestForChannel = timeline.find((event) => event.channel === channel.channel);
    if (!newestForChannel) continue;
    if (!channel.latestReceipt
        || Date.parse(newestForChannel.occurredAt) > Date.parse(channel.latestReceipt.occurredAt)) {
      throw new Error(`the ${channel.label} timeline contradicts its latest receipt`);
    }
  }
  const handoff = snapshot.handoff;
  if (!handoff || typeof handoff.conversionInboxComposed !== 'boolean'
      || typeof handoff.lead360Composed !== 'boolean'
      || (handoff.whatsappInboundProjection !== null
        && handoff.whatsappInboundProjection !== 'conversion_inbox_and_lead360')) {
    throw new Error('live channels handoff evidence is invalid');
  }
  const inboundLastDayCount = handoff.inboundLastDayCount === null
    ? null
    : safeCount(handoff.inboundLastDayCount, 'inbound last-day count');
  const readyCount = channels.filter((channel) => channel.posture === 'ready').length;
  const pausedCount = channels.filter((channel) => channel.posture === 'paused').length;
  const blockedCount = channels.filter((channel) => channel.posture === 'blocked').length;
  const degradedCount = channels.filter((channel) => channel.posture === 'degraded').length;
  const notConnectedCount = channels.filter((channel) => channel.posture === 'not_connected').length;
  const launchReadinessTone: LiveChannelToneClass = readyCount === channels.length
    ? 'ready'
    : readyCount + degradedCount > 0
      ? 'working'
      : pausedCount > 0 ? 'paused' : 'blocked';
  return Object.freeze({
    workspaceId,
    workspaceName,
    snapshotAt,
    dataset: snapshot.dataset,
    illustrative,
    channels,
    readyCount,
    pausedCount,
    blockedCount,
    degradedCount,
    notConnectedCount,
    launchReadinessLabel: readyCount === channels.length
      ? 'All channels live'
      : `${readyCount} of ${channels.length} channels live`,
    launchReadinessTone,
    allPaused: channels.every((channel) => channel.pauseEngaged),
    totalQueued: channels.reduce((total, channel) => total + channel.dispatch.queued, 0),
    totalNeedsAttention: channels.reduce((total, channel) => total + channel.dispatch.needsAttention, 0),
    totalApprovalsPending: channels.reduce((total, channel) => total + channel.approvalsPending, 0),
    totalUsedToday: channels.reduce((total, channel) => total + channel.gauges[0]!.used, 0),
    totalDailyCap: channels.reduce((total, channel) => total + channel.gauges[0]!.cap, 0),
    timeline,
    handoff: Object.freeze({
      conversionInboxComposed: handoff.conversionInboxComposed,
      lead360Composed: handoff.lead360Composed,
      whatsappProjectionLabel: handoff.whatsappInboundProjection
        ? 'Inbound WhatsApp projects into Conversion Inbox and Lead 360'
        : 'Inbound WhatsApp projection is not composed',
      inboundLastDayLabel: inboundLastDayCount === null
        ? 'Inbound volume not measured'
        : `${inboundLastDayCount.toLocaleString('en-GB')} inbound in the last day`,
    }),
  });
}
