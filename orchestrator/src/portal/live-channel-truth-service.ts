import type { PortalCrmRequestIdentity } from './crm-service.js';

/**
 * The five operational rails that may appear in the shared Conversion Inbox
 * and the founder Live Channels control room. This is deliberately not a
 * provider list: a rail remains present when its live adapter is absent.
 */
export const PORTAL_LIVE_CHANNEL_TRUTH_RAILS = Object.freeze([
  'customer_email',
  'owned_social',
  'whatsapp',
  'sms',
  'social_dm',
] as const);

export type PortalLiveChannelTruthRail =
  (typeof PORTAL_LIVE_CHANNEL_TRUTH_RAILS)[number];

/** Stable machine codes only. Provider/error copy never crosses this seam. */
export const PORTAL_LIVE_CHANNEL_BLOCKER_CODES = Object.freeze([
  'PROVIDER_NOT_CONFIGURED',
  'LIVE_ADAPTER_NOT_COMPOSED',
  'EFFECTS_DISABLED',
  'INGRESS_NOT_READY',
  'CONSENT_REQUIRED',
  'CONSENT_WITHDRAWN',
  'SUPPRESSED',
  'APPROVAL_REQUIRED',
  'REPLY_WINDOW_CLOSED',
  'CAP_REACHED',
  'RECEIPT_NEEDS_ATTENTION',
  'IDENTITY_BINDING_REQUIRED',
  'OPERATOR_AUTHORITY_REQUIRED',
  'TEMPLATE_REQUIRED',
  'EMERGENCY_PAUSED',
  'OUTCOME_UNKNOWN_QUARANTINED',
  'APPROVED_CONTENT_REQUIRED',
] as const);

export type PortalLiveChannelBlockerCode =
  (typeof PORTAL_LIVE_CHANNEL_BLOCKER_CODES)[number];

export type PortalLiveChannelConnectionState =
  | 'not_configured'
  | 'configured'
  | 'ready'
  | 'degraded'
  | 'revoked'
  | 'not_composed';

export type PortalLiveChannelInboundState =
  | 'not_supported'
  | 'not_ready'
  | 'ready'
  | 'degraded';

/**
 * Email/social use outbound, while WhatsApp/social DMs use reply. One field
 * avoids pretending those permissions are interchangeable in the UI.
 */
export type PortalLiveChannelOutboundOrReplyState =
  | 'not_supported'
  | 'effects_disabled'
  | 'blocked'
  | 'approval_required'
  | 'ready'
  | 'cap_reached';

export type PortalLiveChannelReceiptState =
  | 'none'
  | 'pending'
  | 'healthy'
  | 'needs_attention'
  | 'outcome_unknown';

export type PortalLiveChannelReceiptOutcome =
  | 'accepted'
  | 'succeeded'
  | 'failed'
  | 'inbound_verified'
  | 'outcome_unknown';

export interface PortalLiveChannelCapWindow {
  readonly used: number;
  readonly limit: number;
  readonly remaining: number;
}

/**
 * Bounded proof only. No recipient, address, provider payload, provider
 * external id, response body, secret, token or credential is representable.
 */
export interface PortalLiveChannelLatestReceipt {
  readonly receiptId: string;
  readonly outcome: PortalLiveChannelReceiptOutcome;
  readonly recordedAt: string;
  readonly evidenceSha256: string;
}

export interface PortalLiveChannelTruthRailSnapshot {
  readonly rail: PortalLiveChannelTruthRail;
  readonly connectionState: PortalLiveChannelConnectionState;
  readonly inboundState: PortalLiveChannelInboundState;
  readonly outboundOrReplyState: PortalLiveChannelOutboundOrReplyState;
  readonly receiptState: PortalLiveChannelReceiptState;
  readonly caps: Readonly<{
    readonly daily: PortalLiveChannelCapWindow;
    readonly monthly: PortalLiveChannelCapWindow;
  }>;
  readonly blockerCodes: readonly PortalLiveChannelBlockerCode[];
  readonly latestReceipt: PortalLiveChannelLatestReceipt | null;
}

export interface PortalLiveChannelTruthSnapshot {
  readonly workspaceId: string;
  readonly snapshotAt: string;
  readonly dataset: 'postgres_authoritative';
  readonly rails: readonly PortalLiveChannelTruthRailSnapshot[];
}

export type PortalLiveChannelTruthFailureKind =
  | 'unauthenticated'
  | 'forbidden'
  | 'invalid_snapshot'
  | 'unavailable';

export interface PortalLiveChannelTruthFailure {
  readonly ok: false;
  readonly kind: PortalLiveChannelTruthFailureKind;
  /** Fixed safe copy only; database/provider exception text is never returned. */
  readonly message: string;
}

export type PortalLiveChannelTruthSnapshotOutcome =
  | Readonly<{
      readonly ok: true;
      readonly snapshot: PortalLiveChannelTruthSnapshot;
    }>
  | PortalLiveChannelTruthFailure;

/**
 * Shared read-only backend seam for Conversion Inbox and Live Channels. It has
 * intentionally no enqueue, provider-connect, pause or effects command.
 */
export interface PortalLiveChannelTruthService {
  snapshot(
    identity: PortalCrmRequestIdentity,
  ): Promise<PortalLiveChannelTruthSnapshotOutcome>;
}
