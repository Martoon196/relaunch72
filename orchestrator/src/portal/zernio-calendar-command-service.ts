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

export interface PortalZernioCalendarCommandService {
  /** Networks with one exact deployment-configured Zernio account binding. */
  readonly configuredNetworks: readonly PortalZernioCalendarNetwork[];
  stage(
    identity: PortalCrmRequestIdentity,
    input: PortalZernioCalendarCommandInput,
  ): Promise<PortalZernioCalendarCommandResult>;
}
