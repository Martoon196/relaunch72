/**
 * Portal-facing calendar-to-Zernio command seam.
 *
 * The request contains immutable calendar evidence only. Provider profile and
 * account references are deployment configuration, never browser fields.
 * Implementations may stage a database job but must not call Zernio.
 */

import type { PortalCrmRequestIdentity } from './crm-service.js';

export type PortalZernioCalendarNetwork = 'instagram' | 'linkedin';

export type PortalZernioCalendarCommandFailureKind =
  | 'unauthenticated'
  | 'forbidden'
  | 'validation'
  | 'conflict'
  | 'account_not_ready'
  | 'unavailable';

export interface PortalZernioCalendarCommandFailure {
  readonly ok: false;
  readonly kind: PortalZernioCalendarCommandFailureKind;
}

export interface PortalZernioCalendarCommandInput {
  readonly network: PortalZernioCalendarNetwork;
  readonly planningIntentId: string;
  readonly planningTargetId: string;
  readonly contentItemId: string;
  readonly contentVersionId: string;
  readonly approvalRequestId: string;
  readonly approvalDecisionId: string;
  readonly sourceAttestationId: string;
  readonly operationTag: string;
  readonly scheduledFor: string;
}

export interface PortalZernioCalendarCommandOutcome {
  readonly ok: true;
  readonly jobId: string;
  readonly idempotencyKeySha256: string;
  readonly caps: Readonly<{ daily: 1; monthly: 3 }>;
  readonly providerEffects: 'none';
  readonly workerLeaseClaimed: false;
}

export type PortalZernioCalendarCommandResult =
  | PortalZernioCalendarCommandOutcome
  | PortalZernioCalendarCommandFailure;

export type PortalZernioCalendarJobState =
  | 'queued'
  | 'leased'
  | 'calling'
  | 'reconciliation_pending'
  | 'succeeded'
  | 'failed'
  | 'needs_attention'
  | 'cancelled';

export interface PortalZernioCalendarScheduledItem {
  readonly jobId: string;
  readonly network: PortalZernioCalendarNetwork;
  readonly content: string;
  readonly scheduledFor: string;
  readonly state: PortalZernioCalendarJobState;
  readonly providerPostId: string | null;
  readonly safeCode: string | null;
  readonly createdAt: string;
}

export type PortalZernioCalendarScheduledListResult =
  | Readonly<{ ok: true; items: readonly PortalZernioCalendarScheduledItem[] }>
  | PortalZernioCalendarCommandFailure;

export interface PortalZernioCalendarPlannerTarget {
  readonly network: PortalZernioCalendarNetwork;
  readonly targetId: string;
  readonly disposition: 'applied' | 'replayed';
}

export type PortalZernioCalendarPlannerBootstrapResult =
  | Readonly<{
      ok: true;
      targets: readonly PortalZernioCalendarPlannerTarget[];
      providerEffects: 'none';
    }>
  | PortalZernioCalendarCommandFailure;

export interface PortalZernioCalendarCommandService {
  /** Networks with one exact deployment-configured Zernio account binding. */
  readonly configuredNetworks: readonly PortalZernioCalendarNetwork[];
  stage(
    identity: PortalCrmRequestIdentity,
    input: PortalZernioCalendarCommandInput,
  ): Promise<PortalZernioCalendarCommandResult>;
  /** Read-only projection of jobs already staged through the immutable approval boundary. */
  listScheduled(
    identity: PortalCrmRequestIdentity,
    input: Readonly<{ from: string; to: string }>,
  ): Promise<PortalZernioCalendarScheduledListResult>;
  /** Idempotently creates only the TEST planner targets for configured live account proofs. */
  bootstrapPlannerTargets(
    identity: PortalCrmRequestIdentity,
  ): Promise<PortalZernioCalendarPlannerBootstrapResult>;
}
