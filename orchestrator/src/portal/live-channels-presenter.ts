/**
 * Presenter for the Property Predator Live Channels control room.
 *
 * Evidence mode consumes the shared `PortalLiveChannelTruthService` rail
 * snapshot verbatim — there is deliberately no second readiness model and
 * no provider SQL here. The presenter fail-closes: it revalidates every
 * rail against the seam's own invariants, derives founder-facing posture
 * itself, and throws on any inconsistency instead of displaying an
 * unproven claim. Facts the sanitised seam does not carry (queue depth,
 * approval counts, account identities) render as explicitly unavailable,
 * never as zero or ready.
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
import {
  PORTAL_LIVE_CHANNEL_BLOCKER_CODES,
  PORTAL_LIVE_CHANNEL_TRUTH_RAILS,
  type PortalLiveChannelBlockerCode,
  type PortalLiveChannelConnectionState,
  type PortalLiveChannelInboundState,
  type PortalLiveChannelOutboundOrReplyState,
  type PortalLiveChannelReceiptOutcome,
  type PortalLiveChannelReceiptState,
  type PortalLiveChannelTruthRail,
  type PortalLiveChannelTruthRailSnapshot,
} from './live-channel-truth-service.js';

export const LIVE_CHANNELS_ROUTE = '/portal/channels/live' as const;
export const LIVE_CHANNELS_PAUSE_ROUTE = '/portal/channels/live/emergency-pause' as const;
export const LIVE_CHANNELS_OWNED_SOCIAL_BIND_ROUTE =
  '/portal/channels/live/owned-social/profile' as const;
export const LIVE_CHANNELS_OWNED_SOCIAL_REVOKE_ROUTE =
  '/portal/channels/live/owned-social/revocation' as const;
export const LIVE_CHANNELS_OWNED_SOCIAL_STAGE_ROUTE =
  '/portal/channels/live/owned-social/staging' as const;
export const LIVE_CHANNELS_SMS_BIND_ROUTE =
  '/portal/channels/live/sms/sender' as const;
export const LIVE_CHANNELS_SMS_REVOKE_ROUTE =
  '/portal/channels/live/sms/revocation' as const;
export const LIVE_CHANNELS_SMS_STAGE_ROUTE =
  '/portal/channels/live/sms/staging' as const;

export type LiveChannelsPauseScope = PortalLiveChannelTruthRail | 'all';

/**
 * Presenter input. Evidence renders pass the truth snapshot through with
 * its own `postgres_authoritative` dataset; only the labelled local
 * preview may substitute `illustrative_fixture`.
 */
export interface LiveChannelsSourceSnapshot {
  readonly workspaceId: string;
  readonly snapshotAt: string;
  readonly dataset: 'postgres_authoritative' | 'illustrative_fixture';
  readonly rails: readonly PortalLiveChannelTruthRailSnapshot[];
}

/**
 * `gated` is the honest state for a rail that is composed and healthy but
 * still cannot dispatch.
 *
 * A soft blocker used to leave the posture `ready`, so the card read
 * "Connected · ready" and the rail counted toward "N of M channels live" while
 * the same card explained that an approval, a permission, a receipt or the
 * enqueue itself was still holding everything. A rail nothing can leave is not
 * a live sending rail, and the summary must not count it as one.
 */
export type LiveChannelPosture =
  'ready' | 'gated' | 'degraded' | 'paused' | 'blocked' | 'not_connected';
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

export interface LiveChannelStateChipView {
  readonly label: string;
  readonly value: string;
  readonly tone: LiveChannelToneClass;
}

export interface LiveChannelReceiptView {
  readonly outcome: PortalLiveChannelReceiptOutcome;
  readonly outcomeLabel: string;
  readonly receiptId: string;
  readonly evidenceShaShort: string;
  readonly recordedAt: string;
  readonly tone: LiveChannelToneClass;
}

export interface LiveChannelRailReceiptView extends LiveChannelReceiptView {
  readonly rail: PortalLiveChannelTruthRail;
  readonly railLabel: string;
}

export interface LiveChannelBlockerView {
  readonly code: string;
  readonly message: string;
  /** True when the presenter derived this from proven state rather than a seam code. */
  readonly derived: boolean;
}

export interface LiveChannelCardView {
  readonly rail: PortalLiveChannelTruthRail;
  readonly anchorId: string;
  readonly eyebrow: string;
  readonly label: string;
  readonly providerLabel: string;
  readonly contractLabel: string;
  readonly posture: LiveChannelPosture;
  readonly postureLabel: string;
  readonly postureTone: LiveChannelToneClass;
  readonly pauseEngaged: boolean;
  readonly capReached: boolean;
  readonly stateChips: readonly LiveChannelStateChipView[];
  readonly gauges: readonly LiveChannelGaugeView[];
  readonly perJobLabel: string | null;
  readonly approvalRequirement: string;
  readonly approvalRequired: boolean;
  readonly targetScope: string;
  readonly latestReceipt: LiveChannelReceiptView | null;
  readonly whyBlocked: readonly LiveChannelBlockerView[];
  readonly nextAction: Readonly<{ label: string; detail: string; link: LiveChannelLinkView | null }>;
  readonly links: readonly LiveChannelLinkView[];
}

export type LiveChannelsNoticeCode =
  | 'pause_engaged'
  | 'pause_already'
  | 'profile_bound'
  | 'profile_revoked'
  | 'publication_staged'
  | 'staging_blocked'
  | 'owned_social_invalid'
  | 'owned_social_forbidden'
  | 'owned_social_unavailable'
  | 'sms_sender_bound'
  | 'sms_sender_revoked'
  | 'sms_test_staged'
  | 'sms_staging_blocked'
  | 'sms_invalid'
  | 'sms_forbidden'
  | 'sms_unavailable'
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
  readonly snapshotAt: string;
  readonly dataset: LiveChannelsSourceSnapshot['dataset'];
  readonly illustrative: boolean;
  readonly channels: readonly LiveChannelCardView[];
  readonly readyCount: number;
  /** Composed and healthy, but a gate stops every send. Never counted as live. */
  readonly gatedCount: number;
  readonly pausedCount: number;
  readonly blockedCount: number;
  readonly degradedCount: number;
  readonly notConnectedCount: number;
  readonly launchReadinessLabel: string;
  readonly launchReadinessTone: LiveChannelToneClass;
  /** True when every composed rail carries an engaged emergency pause. */
  readonly allComposedPaused: boolean;
  readonly totalUsedToday: number;
  readonly totalDailyCap: number;
  readonly attentionRailCount: number;
  readonly approvalRequiredRailLabels: readonly string[];
  readonly latestReceipts: readonly LiveChannelRailReceiptView[];
  readonly whatsappInboundReady: boolean;
}

interface RailStatic {
  readonly eyebrow: string;
  readonly label: string;
  readonly providerLabel: string;
  readonly contractLabel: string;
  readonly dailyCap: number;
  readonly monthlyCap: number;
  readonly perJobLabel: string | null;
  readonly approvalRequirement: string;
  readonly targetScope: string;
  readonly unitNoun: string;
  readonly links: readonly LiveChannelLinkView[];
}

const RAIL_STATIC: Readonly<Record<PortalLiveChannelTruthRail, RailStatic>> = Object.freeze({
  customer_email: Object.freeze({
    eyebrow: 'Owned audience',
    label: 'Customer email',
    providerLabel: 'Mailgun EU',
    contractLabel: CUSTOMER_EMAIL_LIVE_CONTRACT,
    dailyCap: CUSTOMER_EMAIL_DAILY_HARD_CAP,
    monthlyCap: CUSTOMER_EMAIL_MONTHLY_HARD_CAP,
    perJobLabel: '1 recipient / job · 1 operation / cycle',
    approvalRequirement: 'Approved campaign version, approved message and granted consent — all hash-bound inside a 15-minute authority window.',
    targetScope: 'One verified, consented email recipient per job · marketing purpose only · suppression always respected.',
    unitNoun: 'sends',
    links: Object.freeze([
      Object.freeze({ href: `${CONVERSION_INBOX_ROUTE}?channel=email`, label: 'Email conversations' }),
      Object.freeze({ href: `${CONVERSION_INBOX_ROUTE}?queue=approval`, label: 'Approval queue' }),
    ]),
  }),
  owned_social: Object.freeze({
    eyebrow: 'Audience growth',
    label: 'Owned social publishing',
    providerLabel: 'Ayrshare',
    contractLabel: OWNED_PUBLIC_SOCIAL_LIVE_CONTRACT,
    dailyCap: 1,
    monthlyCap: 3,
    perJobLabel: '1 owned profile / job · 1 operation / cycle',
    approvalRequirement: 'Approved latest content version plus a fresh source attestation, hash-bound at enqueue.',
    targetScope: 'One owned X profile · approved, link-free post text · 280 characters maximum.',
    unitNoun: 'posts',
    links: Object.freeze([
      Object.freeze({ href: PUBLIC_SOCIAL_CAMPAIGNS_ROUTE, label: 'Campaigns' }),
      Object.freeze({ href: CONTENT_CALENDAR_ROUTE, label: 'Calendar' }),
    ]),
  }),
  whatsapp: Object.freeze({
    eyebrow: 'Private messaging',
    label: 'Meta WhatsApp',
    providerLabel: 'Meta WhatsApp Cloud',
    contractLabel: META_WHATSAPP_LIVE_CONTRACT,
    dailyCap: 1,
    monthlyCap: 3,
    perJobLabel: '1 recipient / job · 1 approved template / job',
    approvalRequirement: 'Meta-approved zero-parameter template, granted consent and the full PECR specialist chain inside a 15-minute authority window.',
    targetScope: 'One consented WhatsApp recipient per job · approved template messages only.',
    unitNoun: 'messages',
    links: Object.freeze([
      Object.freeze({ href: `${CONVERSION_INBOX_ROUTE}?channel=whatsapp`, label: 'WhatsApp conversations' }),
      Object.freeze({ href: `${CONVERSION_INBOX_ROUTE}?queue=approval`, label: 'Approval queue' }),
    ]),
  }),
  sms: Object.freeze({
    eyebrow: 'Direct messaging',
    label: 'Customer SMS',
    providerLabel: 'Twilio Messaging',
    contractLabel: 'propertypredator.twilio-sms-live/v1',
    dailyCap: 10,
    monthlyCap: 50,
    perJobLabel: '1 recipient / job · 1 concurrent provider call',
    approvalRequirement: 'Approved message version, granted SMS consent and the full PECR specialist chain inside a 15-minute authority window.',
    targetScope: 'One consented UK phone endpoint per job · approved, GSM-basic message text · STOP is honoured immediately and START never overrides a manual suppression.',
    unitNoun: 'segments',
    links: Object.freeze([
      Object.freeze({ href: `${CONVERSION_INBOX_ROUTE}?channel=sms`, label: 'SMS conversations' }),
      Object.freeze({ href: `${CONVERSION_INBOX_ROUTE}?queue=approval`, label: 'Approval queue' }),
    ]),
  }),
  social_dm: Object.freeze({
    eyebrow: 'Conversation rail',
    label: 'Social DMs',
    providerLabel: 'Zernio',
    contractLabel: 'r72-zernio-messaging-v1',
    dailyCap: 0,
    monthlyCap: 0,
    perJobLabel: 'Conversation replies only · no cold bulk-send allowance',
    approvalRequirement: 'An exact connected Zernio account, an immutable reply draft and a matching human approval are required before a reply can be claimed.',
    targetScope: 'Connected Instagram conversations plus Instagram and LinkedIn comment threads owned by the configured company accounts.',
    unitNoun: 'messages',
    links: Object.freeze([
      Object.freeze({ href: CONVERSION_INBOX_ROUTE, label: 'Conversion Inbox' }),
    ]),
  }),
});

const POSTURE_LABELS: Readonly<Record<LiveChannelPosture, string>> = Object.freeze({
  ready: 'Connected · ready',
  gated: 'Connected · gated',
  degraded: 'Degraded',
  paused: 'Paused',
  blocked: 'Blocked',
  not_connected: 'Not connected',
});

const POSTURE_TONES: Readonly<Record<LiveChannelPosture, LiveChannelToneClass>> = Object.freeze({
  ready: 'ready',
  // Not the ready tone: the rail is connected, but nothing leaves it yet.
  gated: 'working',
  degraded: 'working',
  paused: 'paused',
  blocked: 'blocked',
  not_connected: 'muted',
});

/** Presenter-owned plain English for the seam's stable machine codes. */
const BLOCKER_COPY: Readonly<Record<PortalLiveChannelBlockerCode, string>> = Object.freeze({
  PROVIDER_NOT_CONFIGURED: 'No active live provider connection is configured for this rail.',
  LIVE_ADAPTER_NOT_COMPOSED: 'No live delivery adapter is composed; the rail is present but cannot dispatch.',
  EFFECTS_DISABLED: 'The provider-effects switch is OFF, so no external call can be made.',
  INGRESS_NOT_READY: 'The inbound webhook ingress for this rail is not proven ready.',
  CONSENT_REQUIRED: 'No granted consent evidence currently covers the allowed target scope.',
  CONSENT_WITHDRAWN: 'Consent for the target scope was withdrawn and must be re-established.',
  SUPPRESSED: 'The target scope is under an active suppression and cannot be contacted.',
  APPROVAL_REQUIRED: 'A human approval decision is required before anything can dispatch.',
  REPLY_WINDOW_CLOSED: 'The provider reply window has closed for the open conversation.',
  CAP_REACHED: 'A hard send cap for this window is fully used; dispatch resumes when the window resets.',
  RECEIPT_NEEDS_ATTENTION: 'A recorded receipt needs a human decision before the rail is clean again.',
  IDENTITY_BINDING_REQUIRED: 'The owned account or number binding evidence is missing or unproven.',
  OPERATOR_AUTHORITY_REQUIRED: 'Current operator authority evidence is missing for this action scope.',
  TEMPLATE_REQUIRED: 'No provider-approved template is recorded for this rail.',
  EMERGENCY_PAUSED: 'The emergency pause is engaged; no provider call can begin on this rail.',
  OUTCOME_UNKNOWN_QUARANTINED: 'An ambiguous provider outcome is quarantined pending signed-receipt reconciliation.',
  APPROVED_CONTENT_REQUIRED: 'No approved, current post content is recorded for this rail, so nothing can be published yet.',
});

/** Codes that keep a rail operating but demand attention; everything else hard-blocks. */
const SOFT_BLOCKER_CODES: ReadonlySet<PortalLiveChannelBlockerCode> = new Set([
  'EMERGENCY_PAUSED',
  'APPROVAL_REQUIRED',
  'CAP_REACHED',
  'RECEIPT_NEEDS_ATTENTION',
  'OUTCOME_UNKNOWN_QUARANTINED',
]);

/**
 * Gates on a connected rail: approval, permission, receipt and enqueue.
 *
 * These stop every send, but the connection itself is fine, so "Blocked" reads
 * as a broken rail when the truth is a rail waiting on a human decision or a
 * missing piece of evidence. They resolve to `gated` instead, which is not
 * counted as live either way.
 */
const GATE_BLOCKER_CODES: ReadonlySet<PortalLiveChannelBlockerCode> = new Set([
  'APPROVAL_REQUIRED',
  'APPROVED_CONTENT_REQUIRED',
  'OPERATOR_AUTHORITY_REQUIRED',
  'CAP_REACHED',
]);

const CONNECTION_STATES = new Set<PortalLiveChannelConnectionState>([
  'not_configured', 'configured', 'ready', 'degraded', 'revoked', 'not_composed',
]);
const INBOUND_STATES = new Set<PortalLiveChannelInboundState>([
  'not_supported', 'not_ready', 'ready', 'degraded',
]);
const OUTBOUND_STATES = new Set<PortalLiveChannelOutboundOrReplyState>([
  'not_supported', 'effects_disabled', 'blocked', 'approval_required', 'ready', 'cap_reached',
]);
const RECEIPT_STATES = new Set<PortalLiveChannelReceiptState>([
  'none', 'pending', 'healthy', 'needs_attention', 'outcome_unknown',
]);
const RECEIPT_OUTCOMES = new Set<PortalLiveChannelReceiptOutcome>([
  'accepted', 'succeeded', 'failed', 'inbound_verified', 'outcome_unknown',
]);
const BLOCKER_CODE_SET = new Set<string>(PORTAL_LIVE_CHANNEL_BLOCKER_CODES);

const CONNECTION_LABELS: Readonly<Record<PortalLiveChannelConnectionState, string>> = Object.freeze({
  not_configured: 'Not configured',
  configured: 'Configured',
  ready: 'Ready',
  degraded: 'Degraded',
  revoked: 'Revoked',
  not_composed: 'Not composed',
});
const INBOUND_LABELS: Readonly<Record<PortalLiveChannelInboundState, string>> = Object.freeze({
  not_supported: 'Not supported',
  not_ready: 'Not ready',
  ready: 'Ready',
  degraded: 'Degraded',
});
const OUTBOUND_LABELS: Readonly<Record<PortalLiveChannelOutboundOrReplyState, string>> = Object.freeze({
  not_supported: 'Not supported',
  effects_disabled: 'Effects off',
  blocked: 'Blocked',
  approval_required: 'Approval required',
  ready: 'Ready',
  cap_reached: 'At cap',
});
const RECEIPT_STATE_LABELS: Readonly<Record<PortalLiveChannelReceiptState, string>> = Object.freeze({
  none: 'None yet',
  pending: 'Pending',
  healthy: 'Healthy',
  needs_attention: 'Needs attention',
  outcome_unknown: 'Outcome unknown',
});
const RECEIPT_OUTCOME_LABELS: Readonly<Record<PortalLiveChannelReceiptOutcome, string>> = Object.freeze({
  accepted: 'Accepted by provider',
  succeeded: 'Succeeded',
  failed: 'Failed',
  inbound_verified: 'Inbound verified',
  outcome_unknown: 'Outcome unknown',
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const MAX_CAP_VALUE = 1_000_000;

function boundedText(value: unknown, max = 64): string {
  if (typeof value !== 'string') return '';
  const clean = value.trim();
  return clean ? [...clean].slice(0, max).join('') : '';
}

function requiredInstant(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} is invalid`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} is invalid`);
  return new Date(parsed).toISOString();
}

function safeCap(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)
      || value < 0 || value > MAX_CAP_VALUE) {
    throw new Error(`${label} must be a bounded non-negative safe integer`);
  }
  return value;
}

function gauge(label: string, used: number, cap: number, unitNoun: string): LiveChannelGaugeView {
  const percent = cap === 0 ? 0 : Math.round((used / cap) * 100);
  return Object.freeze({
    label,
    used,
    cap,
    percent,
    summary: cap === 0
      ? 'No cap window exists until the adapter is composed'
      : `${used.toLocaleString('en-GB')} of ${cap.toLocaleString('en-GB')} ${unitNoun} used`,
    attention: cap > 0 && percent >= 80,
  });
}

function toneForConnection(state: PortalLiveChannelConnectionState): LiveChannelToneClass {
  if (state === 'ready') return 'ready';
  if (state === 'degraded' || state === 'configured') return 'working';
  if (state === 'revoked') return 'blocked';
  return 'muted';
}

function toneForInbound(state: PortalLiveChannelInboundState): LiveChannelToneClass {
  if (state === 'ready') return 'ready';
  if (state === 'degraded') return 'working';
  return 'muted';
}

function toneForOutbound(state: PortalLiveChannelOutboundOrReplyState): LiveChannelToneClass {
  if (state === 'ready') return 'ready';
  if (state === 'approval_required' || state === 'cap_reached') return 'working';
  if (state === 'blocked' || state === 'effects_disabled') return 'blocked';
  return 'muted';
}

function toneForReceiptState(state: PortalLiveChannelReceiptState): LiveChannelToneClass {
  if (state === 'healthy') return 'ready';
  if (state === 'pending') return 'working';
  if (state === 'needs_attention' || state === 'outcome_unknown') return 'blocked';
  return 'muted';
}

function toneForOutcome(outcome: PortalLiveChannelReceiptOutcome): LiveChannelToneClass {
  if (outcome === 'succeeded' || outcome === 'inbound_verified') return 'ready';
  if (outcome === 'accepted') return 'working';
  return 'blocked';
}

function presentReceipt(
  source: PortalLiveChannelTruthRailSnapshot['latestReceipt'],
  receiptState: PortalLiveChannelReceiptState,
  asOfMs: number,
): LiveChannelReceiptView | null {
  if ((receiptState === 'none') !== (source === null)) {
    throw new Error('live channel receipt presence contradicts its receipt state');
  }
  if (source === null) return null;
  if (!source || typeof source !== 'object'
      || typeof source.receiptId !== 'string' || !UUID.test(source.receiptId)
      || typeof source.evidenceSha256 !== 'string' || !SHA256_HEX.test(source.evidenceSha256)
      || !RECEIPT_OUTCOMES.has(source.outcome)) {
    throw new Error('live channel receipt evidence is invalid');
  }
  const recordedAt = requiredInstant(source.recordedAt, 'receipt recordedAt');
  if (Date.parse(recordedAt) > asOfMs) {
    throw new Error('live channel receipt is newer than its snapshot');
  }
  if ((receiptState === 'pending' && source.outcome !== 'accepted')
      || (receiptState === 'healthy'
        && source.outcome !== 'succeeded' && source.outcome !== 'inbound_verified')
      || (receiptState === 'needs_attention' && source.outcome !== 'failed')
      || (receiptState === 'outcome_unknown' && source.outcome !== 'outcome_unknown')) {
    throw new Error('live channel receipt outcome contradicts its receipt state');
  }
  return Object.freeze({
    outcome: source.outcome,
    outcomeLabel: RECEIPT_OUTCOME_LABELS[source.outcome],
    receiptId: source.receiptId,
    evidenceShaShort: `${source.evidenceSha256.slice(0, 12)}…`,
    recordedAt,
    tone: toneForOutcome(source.outcome),
  });
}

function derivePosture(
  source: PortalLiveChannelTruthRailSnapshot,
  hardBlocked: boolean,
): LiveChannelPosture {
  if (source.connectionState === 'not_composed' || source.connectionState === 'not_configured') {
    return 'not_connected';
  }
  if (hardBlocked || source.connectionState === 'revoked'
      || source.outboundOrReplyState === 'blocked'
      || source.outboundOrReplyState === 'effects_disabled') {
    // A paused rail with no other hard signal reads as paused, not blocked.
    if (!hardBlocked
        && source.connectionState !== 'revoked'
        && source.outboundOrReplyState === 'blocked'
        && source.blockerCodes.includes('EMERGENCY_PAUSED')) {
      return 'paused';
    }
    // A connected rail held only by approval, permission or enqueue gates is
    // gated, not broken. Nothing dispatches either way, so this never makes a
    // rail look more capable than it is.
    if (source.connectionState === 'ready'
        && source.outboundOrReplyState !== 'effects_disabled'
        && source.blockerCodes.length > 0
        && source.blockerCodes.every((code) => GATE_BLOCKER_CODES.has(code))) {
      return 'gated';
    }
    return 'blocked';
  }
  if (source.blockerCodes.includes('EMERGENCY_PAUSED')) return 'paused';
  if (source.connectionState === 'degraded'
      || source.inboundState === 'degraded'
      || source.receiptState === 'needs_attention'
      || source.receiptState === 'outcome_unknown') {
    return 'degraded';
  }
  if (source.connectionState !== 'ready') {
    // 'configured' with no blocker and no degradation is still not proven ready.
    return 'blocked';
  }
  // Composed, healthy, and still unable to dispatch. An approval, a permission,
  // a receipt or a spent cap each stop every send on this rail, so the rail is
  // gated rather than live, and the summary counts it accordingly.
  if (source.blockerCodes.length > 0) return 'gated';
  return 'ready';
}

function nextActionFor(
  posture: LiveChannelPosture,
  statics: RailStatic,
  blockers: readonly LiveChannelBlockerView[],
): LiveChannelCardView['nextAction'] {
  if (posture === 'not_connected') {
    return Object.freeze({
      label: 'Compose the rail',
      detail: 'Connection, adapter and mode evidence must land before this rail can be assessed. Track progress on Rail status.',
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
      detail: `A recorded receipt or rail signal needs a human decision before the ${statics.unitNoun} rail is clean again.`,
      link: Object.freeze({ href: PROVIDER_READINESS_COCKPIT_ROUTE, label: 'Open Rail status' }),
    });
  }
  // A gated rail is composed and healthy and still sends nothing. The remaining
  // gate is the action; anything else would send the founder to watch an Inbox
  // for messages that cannot arrive.
  const remaining = blockers[0];
  if (remaining) {
    return Object.freeze({
      label: 'One gate still holds this rail',
      detail: `${remaining.message} Nothing dispatches until it clears.`,
      link: remaining.code === 'APPROVAL_REQUIRED'
        ? Object.freeze({
          href: `${CONVERSION_INBOX_ROUTE}?queue=approval`,
          label: 'Open approval queue',
        })
        : Object.freeze({ href: PROVIDER_READINESS_COCKPIT_ROUTE, label: 'Open Rail status' }),
    });
  }
  return Object.freeze({
    label: 'No action needed',
    detail: `The rail is live inside its caps. Watch receipts and the Conversion Inbox for ${statics.unitNoun} as they land.`,
    link: Object.freeze({ href: CONVERSION_INBOX_ROUTE, label: 'Open Conversion Inbox' }),
  });
}

function presentRail(
  source: PortalLiveChannelTruthRailSnapshot,
  illustrative: boolean,
  asOfMs: number,
): LiveChannelCardView {
  const statics = RAIL_STATIC[source.rail];
  if (!statics) throw new Error('live channel rail is outside the controlled set');
  if (!CONNECTION_STATES.has(source.connectionState)
      || !INBOUND_STATES.has(source.inboundState)
      || !OUTBOUND_STATES.has(source.outboundOrReplyState)
      || !RECEIPT_STATES.has(source.receiptState)) {
    throw new Error(`live channel ${source.rail} state is outside the truth contract`);
  }
  if (!Array.isArray(source.blockerCodes)
      || source.blockerCodes.length > PORTAL_LIVE_CHANNEL_BLOCKER_CODES.length) {
    throw new Error('live channel blocker evidence is out of bounds');
  }
  const seen = new Set<string>();
  for (const code of source.blockerCodes) {
    if (typeof code !== 'string' || !BLOCKER_CODE_SET.has(code) || seen.has(code)) {
      throw new Error('live channel blocker code is invalid or duplicated');
    }
    seen.add(code);
  }
  const codes = source.blockerCodes as readonly PortalLiveChannelBlockerCode[];
  const dailyUsed = safeCap(source.caps?.daily?.used, 'daily usage');
  const dailyLimit = safeCap(source.caps?.daily?.limit, 'daily limit');
  const dailyRemaining = safeCap(source.caps?.daily?.remaining, 'daily remaining');
  const monthlyUsed = safeCap(source.caps?.monthly?.used, 'monthly usage');
  const monthlyLimit = safeCap(source.caps?.monthly?.limit, 'monthly limit');
  const monthlyRemaining = safeCap(source.caps?.monthly?.remaining, 'monthly remaining');
  if (dailyLimit !== statics.dailyCap || monthlyLimit !== statics.monthlyCap) {
    throw new Error(`live channel ${source.rail} caps do not match the foundation hard caps`);
  }
  if (dailyUsed > dailyLimit || monthlyUsed > monthlyLimit
      || dailyUsed > monthlyUsed
      || dailyRemaining !== dailyLimit - dailyUsed
      || monthlyRemaining !== monthlyLimit - monthlyUsed) {
    throw new Error(`live channel ${source.rail} cap windows are contradictory`);
  }
  const capReached = (dailyLimit > 0 && dailyUsed >= dailyLimit)
    || (monthlyLimit > 0 && monthlyUsed >= monthlyLimit);
  if (capReached !== (source.outboundOrReplyState === 'cap_reached')
      || capReached !== codes.includes('CAP_REACHED')) {
    throw new Error(`live channel ${source.rail} cap evidence is contradictory`);
  }
  if ((source.connectionState === 'not_configured' && !codes.includes('PROVIDER_NOT_CONFIGURED'))
      || (source.connectionState === 'not_composed' && !codes.includes('LIVE_ADAPTER_NOT_COMPOSED'))
      || (source.outboundOrReplyState === 'effects_disabled' && !codes.includes('EFFECTS_DISABLED'))
      || (source.outboundOrReplyState === 'approval_required' && !codes.includes('APPROVAL_REQUIRED'))
      || (source.receiptState === 'needs_attention' && !codes.includes('RECEIPT_NEEDS_ATTENTION'))
      || (source.receiptState === 'outcome_unknown' && !codes.includes('OUTCOME_UNKNOWN_QUARANTINED'))) {
    throw new Error(`live channel ${source.rail} blocker codes contradict its states`);
  }
  if (source.rail === 'social_dm') {
    const accountReady = source.connectionState === 'ready' && source.inboundState === 'ready';
    const accountMissing = (source.connectionState === 'not_configured'
      || source.connectionState === 'configured')
      && source.inboundState === 'not_ready'
      && source.outboundOrReplyState === 'blocked';
    const safelyBlocked = source.outboundOrReplyState !== 'blocked'
      || codes.includes('EMERGENCY_PAUSED')
      || codes.includes('OUTCOME_UNKNOWN_QUARANTINED');
    if ((source.connectionState !== 'ready' && source.connectionState !== 'configured'
          && source.connectionState !== 'not_configured')
        || (source.outboundOrReplyState !== 'ready'
          && source.outboundOrReplyState !== 'approval_required'
          && source.outboundOrReplyState !== 'blocked')
        || (!accountReady && !accountMissing)
        || (accountReady && !safelyBlocked)
        || codes.includes('LIVE_ADAPTER_NOT_COMPOSED')) {
      throw new Error('the social DM rail must match composed Zernio account and reply evidence');
    }
  }
  if (source.rail !== 'social_dm' && source.outboundOrReplyState === 'not_supported') {
    throw new Error(`live channel ${source.rail} cannot disclaim outbound support`);
  }
  const latestReceipt = presentReceipt(source.latestReceipt, source.receiptState, asOfMs);
  const hardBlocked = codes.some((code) => !SOFT_BLOCKER_CODES.has(code));
  const posture = derivePosture(source, hardBlocked);
  if (illustrative && (posture === 'ready' || posture === 'degraded')) {
    throw new Error('an illustrative fixture can never depict a deliverable live channel');
  }
  const whyBlocked: LiveChannelBlockerView[] = codes.map((code) => Object.freeze({
    code,
    message: BLOCKER_COPY[code],
    derived: false,
  }));
  if (posture === 'blocked' && !hardBlocked
      && source.connectionState === 'configured' && codes.length === 0) {
    whyBlocked.push(Object.freeze({
      code: 'CONNECTION_NOT_PROVEN_READY',
      message: 'The connection is configured but has not yet been proven ready by the truth seam.',
      derived: true,
    }));
  }
  const pauseEngaged = codes.includes('EMERGENCY_PAUSED');
  return Object.freeze({
    rail: source.rail,
    anchorId: `live-${source.rail.replaceAll('_', '-')}`,
    eyebrow: statics.eyebrow,
    label: statics.label,
    providerLabel: statics.providerLabel,
    contractLabel: statics.contractLabel,
    posture,
    postureLabel: POSTURE_LABELS[posture],
    postureTone: POSTURE_TONES[posture],
    pauseEngaged,
    capReached,
    stateChips: Object.freeze([
      Object.freeze({ label: 'Connection', value: CONNECTION_LABELS[source.connectionState], tone: toneForConnection(source.connectionState) }),
      Object.freeze({ label: 'Inbound', value: INBOUND_LABELS[source.inboundState], tone: toneForInbound(source.inboundState) }),
      Object.freeze({
        label: source.rail === 'whatsapp' || source.rail === 'social_dm' ? 'Reply' : 'Outbound',
        value: OUTBOUND_LABELS[source.outboundOrReplyState],
        tone: toneForOutbound(source.outboundOrReplyState),
      }),
      Object.freeze({ label: 'Receipts', value: RECEIPT_STATE_LABELS[source.receiptState], tone: toneForReceiptState(source.receiptState) }),
    ]),
    gauges: Object.freeze([
      gauge('Today', dailyUsed, dailyLimit, statics.unitNoun),
      gauge('This month', monthlyUsed, monthlyLimit, statics.unitNoun),
    ]),
    perJobLabel: statics.perJobLabel,
    approvalRequirement: statics.approvalRequirement,
    approvalRequired: codes.includes('APPROVAL_REQUIRED'),
    targetScope: statics.targetScope,
    latestReceipt,
    whyBlocked: Object.freeze(whyBlocked),
    nextAction: nextActionFor(posture, statics, whyBlocked),
    links: statics.links,
  });
}

export function presentLiveChannels(
  snapshot: LiveChannelsSourceSnapshot,
): LiveChannelsView {
  if (!snapshot
      || (snapshot.dataset !== 'postgres_authoritative'
        && snapshot.dataset !== 'illustrative_fixture')) {
    throw new Error('live channels snapshot dataset is invalid');
  }
  const workspaceId = boundedText(snapshot.workspaceId);
  const snapshotAt = requiredInstant(snapshot.snapshotAt, 'live channels snapshotAt');
  if (!workspaceId) throw new Error('live channels workspace boundary is invalid');
  const asOfMs = Date.parse(snapshotAt);
  const illustrative = snapshot.dataset === 'illustrative_fixture';
  if (!Array.isArray(snapshot.rails)
      || snapshot.rails.length !== PORTAL_LIVE_CHANNEL_TRUTH_RAILS.length) {
    throw new Error('live channels snapshot must contain the exact four-rail set');
  }
  const railSource: readonly PortalLiveChannelTruthRailSnapshot[] = snapshot.rails;
  const byRail = new Map(railSource.map((rail) => [rail.rail, rail]));
  if (byRail.size !== PORTAL_LIVE_CHANNEL_TRUTH_RAILS.length
      || PORTAL_LIVE_CHANNEL_TRUTH_RAILS.some((rail) => !byRail.has(rail))) {
    throw new Error('live channels snapshot rail set is incomplete or duplicated');
  }
  const channels = Object.freeze(PORTAL_LIVE_CHANNEL_TRUTH_RAILS.map((rail) =>
    presentRail(byRail.get(rail)!, illustrative, asOfMs)));
  // Only a rail something can actually leave counts as live. A gated rail is
  // composed and healthy and still sends nothing, so it is counted separately
  // rather than folded into the live total.
  const readyCount = channels.filter((channel) => channel.posture === 'ready').length;
  const gatedCount = channels.filter((channel) => channel.posture === 'gated').length;
  const pausedCount = channels.filter((channel) => channel.posture === 'paused').length;
  const blockedCount = channels.filter((channel) => channel.posture === 'blocked').length;
  const degradedCount = channels.filter((channel) => channel.posture === 'degraded').length;
  const notConnectedCount = channels.filter((channel) => channel.posture === 'not_connected').length;
  const composed = channels.filter((channel) => channel.posture !== 'not_connected');
  const latestReceipts = Object.freeze(channels
    .flatMap((channel) => channel.latestReceipt
      ? [Object.freeze({ ...channel.latestReceipt, rail: channel.rail, railLabel: channel.label })]
      : [])
    .sort((left, right) => Date.parse(right.recordedAt) - Date.parse(left.recordedAt)));
  const whatsapp = byRail.get('whatsapp')!;
  const launchReadinessTone: LiveChannelToneClass = readyCount === channels.length
    ? 'ready'
    : readyCount + gatedCount + degradedCount > 0
      ? 'working'
      : pausedCount > 0 ? 'paused' : 'blocked';
  return Object.freeze({
    workspaceId,
    snapshotAt,
    dataset: snapshot.dataset,
    illustrative,
    channels,
    readyCount,
    gatedCount,
    pausedCount,
    blockedCount,
    degradedCount,
    notConnectedCount,
    launchReadinessLabel: readyCount === channels.length
      ? 'All channels live'
      : `${readyCount} of ${channels.length} channels live`,
    launchReadinessTone,
    allComposedPaused: composed.length > 0
      && composed.every((channel) => channel.pauseEngaged),
    totalUsedToday: channels.reduce((total, channel) => total + channel.gauges[0]!.used, 0),
    totalDailyCap: channels.reduce((total, channel) => total + channel.gauges[0]!.cap, 0),
    attentionRailCount: channels.filter((channel) => channel.posture === 'degraded'
      || channel.whyBlocked.some((blocker) => blocker.code === 'RECEIPT_NEEDS_ATTENTION'
        || blocker.code === 'OUTCOME_UNKNOWN_QUARANTINED')).length,
    approvalRequiredRailLabels: Object.freeze(channels
      .filter((channel) => channel.approvalRequired)
      .map((channel) => channel.label)),
    latestReceipts,
    whatsappInboundReady: whatsapp.inboundState === 'ready',
  });
}
