/**
 * Portal-facing read boundary for the Property Predator Live Channels
 * control room (`/portal/channels/live`).
 *
 * This seam is UI-owned and intentionally implementation-free. The portal
 * renders only what an implementation can prove from the live foundations:
 *
 * - Customer email  · `src/customer-email-live/foundation.ts` + migration 0054
 * - Owned social    · `src/public-social-outbound/owned-live-foundation.ts` + migration 0052
 * - Meta WhatsApp   · `src/whatsapp-live/foundation.ts` + migration 0053
 *
 * Backend contract required from an implementation (per channel):
 * - switch state from the fail-closed runtime config loaders
 *   (`loadCustomerEmailLiveRuntimeConfig` / `loadOwnedPublicSocialLiveRuntimeConfig`
 *   / `loadMetaWhatsAppLiveRuntimeConfig`) — never from portal input;
 * - usage counts computed exactly as the SQL cap gates count them:
 *   `count(*)` over the channel's jobs table per workspace + connection for
 *   the current `utc_day` / `utc_month` where `state <> 'cancelled'`;
 * - dispatch counts grouped from the channel's jobs table states;
 * - the latest immutable receipt row (bounded columns only — event kind,
 *   safe code and instants; never a recipient, payload or credential);
 * - blockers as bounded plain-English evidence, mirroring the readiness
 *   cockpit's operational blocker shape.
 *
 * Reads need a new SECURITY DEFINER read function per channel (owned by the
 * channel's definer role, workspace-scoped via the `app.workspace_id` GUC):
 * the worker/command roles deliberately have zero table privileges, so no
 * existing SQL surface can serve this page. Until that lands, the router
 * renders the clearly-labelled illustrative fixture instead.
 *
 * Implementations may return evidence but can never load a credential,
 * create a provider operation, flip an effect switch on, or send anything.
 */

import type { PortalCrmRequestIdentity } from './crm-service.js';

export type LiveChannelId =
  | 'customer_email_mailgun'
  | 'owned_public_social'
  | 'meta_whatsapp';

export type LiveChannelProviderId = 'mailgun_eu' | 'ayrshare' | 'meta_whatsapp_cloud';

/**
 * Per-channel execution mode, exactly as the foundation runtime configs
 * spell it. A channel may only ever claim its own live literal.
 */
export type LiveChannelMode =
  | 'disabled'
  | 'customer_live'
  | 'owned_profile_live'
  | 'owned_template_live';

export interface LiveChannelIdentitySnapshot {
  readonly providerId: LiveChannelProviderId;
  /** Human provider name only, e.g. "Mailgun EU". */
  readonly providerLabel: string;
  /** Bounded, non-secret account identity, e.g. a sending domain or handle. */
  readonly accountLabel: string;
  /** Bounded, non-secret connection reference for audit talk-back. */
  readonly connectionLabel: string;
  readonly environment: 'live';
  readonly connectionStatus: 'active' | 'missing' | 'revoked';
  /** The exact foundation contract id this evidence was read under. */
  readonly contract: string;
}

export interface LiveChannelSwitchSnapshot {
  readonly mode: LiveChannelMode;
  readonly providerEffectsEnabled: boolean;
  /** Channel-specific delivery switch (customer email only); null when the channel has no such switch. */
  readonly deliveryEnabled: boolean | null;
  readonly emergencyPaused: boolean;
}

export interface LiveChannelDispatchSnapshot {
  readonly workerComposed: boolean;
  /** When the worker projection was observed; null only when no worker is composed. */
  readonly observedAt: string | null;
  readonly queuedCount: number;
  /** Jobs currently leased or calling the provider. */
  readonly inFlightCount: number;
  /** Jobs awaiting a signed receipt, status webhook or reconciliation. */
  readonly awaitingProofCount: number;
  readonly needsAttentionCount: number;
  readonly succeededTodayCount: number;
  readonly failedTodayCount: number;
}

export interface LiveChannelCapsSnapshot {
  readonly dailyCap: number;
  readonly monthlyCap: number;
  /** Non-cancelled jobs for the current UTC day — the exact cap-gate count. */
  readonly usedToday: number;
  /** Non-cancelled jobs for the current UTC month — the exact cap-gate count. */
  readonly usedThisMonth: number;
  readonly maxRecipientsPerJob: number;
  readonly maxOperationsPerCycle: number;
}

export interface LiveChannelPermissionSnapshot {
  /** Consent/permission posture proven for this channel's exact allowed scope. */
  readonly state: 'granted' | 'partial' | 'missing' | 'revoked';
  /** Bounded plain-English evidence line. Never an identity or credential. */
  readonly detail: string;
  readonly checkedAt: string | null;
}

export interface LiveChannelReceiptSnapshot {
  /** Receipt event kind, constrained to the channel's migration CHECK set. */
  readonly eventKind: string;
  /** `safe_code` column value; matches ^[a-z][a-z0-9_.:-]{0,99}$. */
  readonly safeCode: string;
  readonly occurredAt: string;
  readonly recordedAt: string;
}

export interface LiveChannelBlockerSnapshot {
  /** Stable machine code, ^[A-Z][A-Z0-9_]{2,79}$. */
  readonly code: string;
  /** Bounded plain English (8–240 chars) a founder can act on. */
  readonly message: string;
}

export interface PortalLiveChannelSnapshot {
  readonly channel: LiveChannelId;
  readonly identity: LiveChannelIdentitySnapshot;
  readonly switches: LiveChannelSwitchSnapshot;
  readonly dispatch: LiveChannelDispatchSnapshot;
  readonly caps: LiveChannelCapsSnapshot;
  readonly approvals: Readonly<{
    /** Deliveries/messages waiting on a human approval decision for this channel. */
    pendingCount: number;
    oldestPendingAt: string | null;
  }>;
  readonly permission: LiveChannelPermissionSnapshot;
  readonly latestReceipt: LiveChannelReceiptSnapshot | null;
  readonly blockers: readonly LiveChannelBlockerSnapshot[];
}

export interface PortalLiveChannelsReceiptEvent extends LiveChannelReceiptSnapshot {
  readonly channel: LiveChannelId;
}

export interface PortalLiveChannelsSnapshot {
  readonly workspace: Readonly<{
    workspaceId: string;
    workspaceName: string;
    snapshotAt: string;
  }>;
  readonly dataset: 'evidence' | 'illustrative_fixture';
  /** Exactly one snapshot per LiveChannelId; the presenter rejects any other set. */
  readonly channels: readonly PortalLiveChannelSnapshot[];
  /** Compact cross-channel receipt timeline, newest first, bounded. */
  readonly receipts: readonly PortalLiveChannelsReceiptEvent[];
  readonly handoff: Readonly<{
    conversionInboxComposed: boolean;
    lead360Composed: boolean;
    /** Present only when the WhatsApp inbound webhook seam projects into both surfaces. */
    whatsappInboundProjection: 'conversion_inbox_and_lead360' | null;
    inboundLastDayCount: number | null;
  }>;
}

export type PortalLiveChannelsSnapshotOutcome =
  | { readonly ok: true; readonly snapshot: PortalLiveChannelsSnapshot }
  | {
      readonly ok: false;
      readonly kind: 'unauthenticated' | 'forbidden' | 'not_found' | 'invalid_snapshot' | 'unavailable';
      readonly message: string;
    };

export type LiveChannelsPauseScope = LiveChannelId | 'all';

export type LiveChannelsPauseOutcome =
  | { readonly ok: true; readonly state: 'engaged' | 'already_engaged' }
  | {
      readonly ok: false;
      readonly kind: 'unauthenticated' | 'forbidden' | 'unsupported' | 'unavailable';
      readonly message: string;
    };

/**
 * Read-only portal boundary plus one optional fail-safe command.
 *
 * `engageEmergencyPause` may only move a channel towards OFF. There is
 * deliberately no resume/unpause seam: releasing an emergency pause is a
 * separate founder decision outside this portal surface.
 */
export interface PortalLiveChannelsService {
  snapshot(
    identity: PortalCrmRequestIdentity,
  ): Promise<PortalLiveChannelsSnapshotOutcome>;
  engageEmergencyPause?(
    identity: PortalCrmRequestIdentity,
    input: Readonly<{ scope: LiveChannelsPauseScope; commandKey: string }>,
  ): Promise<LiveChannelsPauseOutcome>;
}
