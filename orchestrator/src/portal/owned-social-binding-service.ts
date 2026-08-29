/**
 * Founder-only owned public-social binding and staging seam.
 *
 * The router depends on this interface and never on the Postgres class, the
 * command service or the encryption contract. The clear Ayrshare Profile Key
 * and the clear owned account reference enter exactly one method each, are
 * reduced to ciphertext or a digest immediately, and are never stored on the
 * service, returned, logged or rendered.
 *
 * Nothing here can claim a worker lease or reach Ayrshare. Staging is a
 * database-only enqueue behind the existing 0052 command boundary.
 */

import type { OwnedSocialActivationReadinessReport } from '../owned-social-activation/foundation.js';
import type { PortalCrmRequestIdentity } from './crm-service.js';

export type PortalOwnedSocialFailureKind =
  | 'unauthenticated'
  | 'forbidden'
  | 'validation'
  | 'conflict'
  /** The database did not prove every readiness dimension for this target. */
  | 'blocked'
  | 'unavailable';

export interface PortalOwnedSocialFailure {
  readonly ok: false;
  readonly kind: PortalOwnedSocialFailureKind;
}

/**
 * Everything a founder supplies to bind one exact owned Ayrshare/X profile.
 * `profileKey` and `ownedAccountReference` are the only clear secrets and both
 * die inside the implementation.
 */
export interface PortalOwnedSocialRecordProfileInput {
  readonly profileId: string;
  readonly displayName: string;
  readonly providerProfileReference: string;
  readonly ownedAccountReference: string;
  readonly profileKey: string;
  readonly ownershipAttested: boolean;
  readonly oauthPermissions: string;
  readonly oauthLinkEvidence: string;
  readonly linkedAt: string;
  readonly evidenceObservedAt: string;
}

export interface PortalOwnedSocialRecordProfileOutcome {
  readonly ok: true;
  readonly profileId: string;
  readonly providerEffects: 'none';
}

export interface PortalOwnedSocialRevokeProfileInput {
  readonly profileId: string;
  readonly reasonCode: string;
  readonly revocationEvidence: string;
}

export interface PortalOwnedSocialRevokeProfileOutcome {
  readonly ok: true;
  readonly revocationId: string;
  readonly providerEffects: 'none';
}

/** The exact approved publication a founder is staging. */
export interface PortalOwnedSocialStageInput {
  readonly profileId: string;
  readonly contentItemId: string;
  readonly contentVersionId: string;
  readonly approvalRequestId: string;
  readonly approvalDecisionId: string;
  readonly sourceAttestationId: string;
  readonly operationTag: string;
  readonly ownedAccountReference: string;
}

export interface PortalOwnedSocialStageOutcome {
  readonly ok: true;
  readonly jobId: string;
  readonly providerEffects: 'none';
  readonly workerLeaseClaimed: false;
  /** The scope-bound key the command boundary de-duplicated this job on. */
  readonly idempotencyKeySha256: string;
  readonly caps: Readonly<{ daily: 1; monthly: 3 }>;
}

export interface PortalOwnedSocialReadinessOutcome {
  readonly ok: true;
  readonly report: OwnedSocialActivationReadinessReport;
}

export type PortalOwnedSocialRecordProfileResult =
  PortalOwnedSocialRecordProfileOutcome | PortalOwnedSocialFailure;
export type PortalOwnedSocialRevokeProfileResult =
  PortalOwnedSocialRevokeProfileOutcome | PortalOwnedSocialFailure;
export type PortalOwnedSocialStageResult =
  PortalOwnedSocialStageOutcome | PortalOwnedSocialFailure;
export type PortalOwnedSocialReadinessResult =
  PortalOwnedSocialReadinessOutcome | PortalOwnedSocialFailure;

export interface PortalOwnedSocialBindingService {
  /** The exact owned Ayrshare connection this seam is bound to. */
  readonly providerConnectionId: string;
  /** True only when the profile-key encryption contract is composed. */
  readonly profileBindingComposed: boolean;
  recordProfile(
    identity: PortalCrmRequestIdentity,
    input: PortalOwnedSocialRecordProfileInput,
  ): Promise<PortalOwnedSocialRecordProfileResult>;
  revokeProfile(
    identity: PortalCrmRequestIdentity,
    input: PortalOwnedSocialRevokeProfileInput,
  ): Promise<PortalOwnedSocialRevokeProfileResult>;
  readiness(
    identity: PortalCrmRequestIdentity,
    input: Omit<PortalOwnedSocialStageInput, 'operationTag'>,
  ): Promise<PortalOwnedSocialReadinessResult>;
  stagePublication(
    identity: PortalCrmRequestIdentity,
    input: PortalOwnedSocialStageInput,
  ): Promise<PortalOwnedSocialStageResult>;
}
