/**
 * Founder-only Twilio SMS binding and owned-test staging seam.
 *
 * The router depends on this interface and never on the command service, the
 * 0061 functions or the digest derivation. No Twilio credential ever enters
 * these types: the account and messaging-service identifiers are reduced to
 * digests, and the Auth Token and restricted API key stay in the secret
 * manager, held only by the webhook and worker processes respectively.
 *
 * Nothing here can claim a worker lease or reach Twilio. Staging is a
 * database-only enqueue behind the existing 0056 command boundary.
 */

import type { SmsActivationReadinessReport } from '../sms-activation/foundation.js';
import type { PortalCrmRequestIdentity } from './crm-service.js';

export type PortalSmsFailureKind =
  | 'unauthenticated'
  | 'forbidden'
  | 'validation'
  | 'conflict'
  /** The database did not prove every readiness dimension for this target. */
  | 'blocked'
  | 'unavailable';

export interface PortalSmsFailure {
  readonly ok: false;
  readonly kind: PortalSmsFailureKind;
}

/** The exact owned Twilio sender a founder is binding. */
export interface PortalSmsBindSenderInput {
  readonly bindingId: string;
  readonly providerConnectionId: string;
  readonly channelEndpointId: string;
  readonly displayName: string;
  readonly accountSid: string;
  readonly messagingServiceSid: string;
  readonly senderNumber: string;
  readonly regulatoryEvidence: string;
  readonly ownershipEvidence: string;
  readonly ownershipAttested: boolean;
  readonly evidenceObservedAt: string;
}

export interface PortalSmsBindSenderOutcome {
  readonly ok: true;
  readonly bindingId: string;
  readonly providerEffects: 'none';
}

export interface PortalSmsRevokeSenderInput {
  readonly bindingId: string;
  readonly reasonCode: string;
  readonly revocationEvidence: string;
}

export interface PortalSmsRevokeSenderOutcome {
  readonly ok: true;
  readonly revocationId: string;
  readonly providerEffects: 'none';
}

/** The exact owned test recipient and approved message being staged. */
export interface PortalSmsStageInput {
  readonly bindingId: string;
  readonly providerConnectionId: string;
  readonly channelEndpointId: string;
  readonly messageVersionId: string;
  readonly messageApprovalRequestId: string;
  readonly messageApprovalDecisionId: string;
  readonly contactId: string;
  readonly contactPointId: string;
  readonly consentEventId: string;
  readonly complianceSubjectId: string;
  readonly policyPublicationEventId: string;
  readonly pecrSenderDecisionEventId: string;
  readonly pecrInstigatorDecisionEventId: string;
  readonly permissionUseReceiptId: string;
  readonly providerOperationId: string;
  readonly messageDeliveryId: string;
  readonly correlationId: string;
  readonly authorityValidUntil: string;
  readonly expectedSegmentCount: number;
  readonly ownedRecipient: string;
  readonly purpose: string;
}

export interface PortalSmsStageOutcome {
  readonly ok: true;
  readonly jobId: string;
  readonly disposition: 'queued' | 'replayed';
  readonly providerEffects: 'none';
  readonly workerLeaseClaimed: false;
  readonly caps: Readonly<{ dailySegments: 10; monthlySegments: 50 }>;
}

export interface PortalSmsReadinessOutcome {
  readonly ok: true;
  readonly report: SmsActivationReadinessReport;
}

export type PortalSmsBindSenderResult = PortalSmsBindSenderOutcome | PortalSmsFailure;
export type PortalSmsRevokeSenderResult = PortalSmsRevokeSenderOutcome | PortalSmsFailure;
export type PortalSmsStageResult = PortalSmsStageOutcome | PortalSmsFailure;
export type PortalSmsReadinessResult = PortalSmsReadinessOutcome | PortalSmsFailure;

export interface PortalSmsBindingService {
  /** The exact workspace this seam is bound to. */
  readonly workspaceId: string;
  bindSender(
    identity: PortalCrmRequestIdentity,
    input: PortalSmsBindSenderInput,
  ): Promise<PortalSmsBindSenderResult>;
  revokeSender(
    identity: PortalCrmRequestIdentity,
    input: PortalSmsRevokeSenderInput,
  ): Promise<PortalSmsRevokeSenderResult>;
  readiness(
    identity: PortalCrmRequestIdentity,
    input: Readonly<{
      bindingId: string;
      messageVersionId: string;
      messageApprovalDecisionId: string;
      contactId: string;
      contactPointId: string;
      consentEventId: string;
      purpose: string;
      ownedRecipient: string;
    }>,
  ): Promise<PortalSmsReadinessResult>;
  stageOwnedTest(
    identity: PortalCrmRequestIdentity,
    input: PortalSmsStageInput,
  ): Promise<PortalSmsStageResult>;
}
