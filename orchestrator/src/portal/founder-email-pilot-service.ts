/**
 * Founder-only Lead 360 seam for the customer-email pilot.
 *
 * Two actions, both owner/admin-gated and both idempotent on a per-render
 * command key. Attaching an endpoint can create neither a contact nor an
 * opportunity. Reading readiness enqueues nothing and calls no provider.
 *
 * The router depends on this interface and never on the 0064 functions or on
 * the capped enqueue directly.
 */

import type {
  AttachContactEmailEndpointInput,
  FounderEmailPilotEvidence,
  FounderEmailPilotIdentifiers,
  FounderEmailPilotReadinessReport,
} from '../founder-email-pilot/foundation.js';
import type { PortalCrmRequestIdentity } from './crm-service.js';

export type FounderEmailPilotFailureKind =
  | 'unauthenticated'
  /** Signed in, but not an active owner or admin of this workspace. */
  | 'forbidden'
  | 'validation'
  /** The command key was reused for different content. */
  | 'conflict'
  /** The database did not prove every readiness dimension. */
  | 'blocked'
  | 'unavailable';

export interface FounderEmailPilotFailure {
  readonly ok: false;
  readonly kind: FounderEmailPilotFailureKind;
}

export interface AttachEndpointInput extends AttachContactEmailEndpointInput {
  /** Fresh per-render key, so a double submit replays instead of re-attaching. */
  readonly commandKey: string;
}

export interface AttachEndpointOutcome {
  readonly ok: true;
  readonly disposition: 'applied' | 'replayed';
  readonly contactPointId: string;
  readonly receiptId: string;
  /** Always none: attaching an endpoint is evidence, not permission. */
  readonly consentRecorded: 'none';
}

export type AttachEndpointResult = AttachEndpointOutcome | FounderEmailPilotFailure;

export interface PilotReadinessInput {
  readonly contactId: string;
  readonly contactPointId: string;
  readonly purpose: string;
}

export interface PilotReadinessOutcome {
  readonly ok: true;
  readonly report: FounderEmailPilotReadinessReport;
  /** Exactly what would be sent, shown before any authorisation. */
  readonly preview: FounderEmailPilotPreview | null;
}

export interface FounderEmailPilotPreview {
  readonly recipientEmail: string;
  readonly recipientVerified: boolean;
  readonly purpose: string;
  readonly dailyUsed: number;
  readonly dailyCap: number;
  readonly monthlyUsed: number;
  readonly monthlyCap: number;
}

export type PilotReadinessResult = PilotReadinessOutcome | FounderEmailPilotFailure;

/**
 * The exact message that would leave the building, resolved from the approved
 * records rather than composed here.
 *
 * `authorityValidUntil` is minted with the preview and folded into the digest
 * the enqueue compares, so the founder authorises the window they were shown.
 */
export interface FounderEmailPilotAuthorisationPreview {
  readonly evidence: FounderEmailPilotEvidence;
  readonly evidenceDigest: string;
  readonly authorityValidUntil: string;
  readonly identifiers: FounderEmailPilotIdentifiers;
}

export interface ResolveAuthorisationInput {
  readonly contactId: string;
  readonly contactPointId: string;
  readonly purpose: string;
  /** Fresh per-render key. It becomes the idempotency key for the enqueue. */
  readonly commandKey: string;
}

export interface ResolveAuthorisationOutcome {
  readonly ok: true;
  /** Null when the exact tuple did not resolve; the readiness blockers say why. */
  readonly preview: FounderEmailPilotAuthorisationPreview | null;
}

export type ResolveAuthorisationResult =
  | ResolveAuthorisationOutcome
  | FounderEmailPilotFailure;

export interface AuthoriseInput {
  readonly contactId: string;
  readonly contactPointId: string;
  readonly purpose: string;
  readonly commandKey: string;
  /** The exact evidence the founder was shown, from the verified preview token. */
  readonly evidenceDigest: string;
  readonly authorityValidUntil: string;
  readonly operatorConfirmed: boolean;
}

export interface AuthoriseOutcome {
  readonly ok: true;
  readonly disposition: 'queued' | 'replayed';
  readonly jobId: string;
  /** Always none: the existing worker owns dispatch, not this action. */
  readonly providerEffects: 'none';
  readonly recipientEmail: string;
  readonly subject: string;
}

/** The resolved evidence no longer matches what the founder read. */
export interface AuthoriseStale {
  readonly ok: false;
  readonly kind: 'stale_preview';
}

export type AuthoriseResult =
  | AuthoriseOutcome
  | AuthoriseStale
  | FounderEmailPilotFailure;

export interface PrepareContentInput {
  readonly contactId: string;
  readonly contactPointId: string;
  readonly purpose: string;
  /** Fresh per-render key, so a double submit replays instead of re-preparing. */
  readonly commandKey: string;
  readonly operatorConfirmed: boolean;
}

export interface PrepareContentOutcome {
  readonly ok: true;
  readonly disposition: 'prepared' | 'replayed';
  readonly campaignTemplateVersionId: string;
  readonly messageVersionId: string;
  readonly approvedContentId: string;
  /** Always none: preparing content creates no delivery intent whatsoever. */
  readonly providerEffects: 'none';
}

export type PrepareContentResult = PrepareContentOutcome | FounderEmailPilotFailure;

export interface RecordPolicyEvidenceInput {
  readonly contactId: string;
  readonly contactPointId: string;
  readonly purpose: string;
  readonly commandKey: string;
  readonly operatorConfirmed: boolean;
}

export interface RecordPolicyEvidenceOutcome {
  readonly ok: true;
  readonly disposition: 'recorded' | 'replayed';
  readonly policyPublicationEventId: string;
  readonly pecrSenderDecisionEventId: string;
  readonly pecrInstigatorDecisionEventId: string;
  readonly actionScopeSha256: string;
  /** How the ledger describes the authority. Never a solicitor's approval. */
  readonly reviewAuthority: string;
  /** Always false: no ownership or control evidence reaches this workflow. */
  readonly ownershipControlChecked: false;
  readonly providerEffects: 'none';
}

export type RecordPolicyEvidenceResult =
  | RecordPolicyEvidenceOutcome
  | FounderEmailPilotFailure;

export interface PortalFounderEmailPilotService {
  attachEndpoint(
    identity: PortalCrmRequestIdentity,
    input: AttachEndpointInput,
  ): Promise<AttachEndpointResult>;
  readiness(
    identity: PortalCrmRequestIdentity,
    input: PilotReadinessInput,
  ): Promise<PilotReadinessResult>;
  /** Builds the approved campaign and message evidence. It queues nothing. */
  prepareContent(
    identity: PortalCrmRequestIdentity,
    input: PrepareContentInput,
  ): Promise<PrepareContentResult>;
  /**
   * Records the founder and operator compliance review. Not legal advice, and
   * it claims no solicitor approval. It queues nothing.
   */
  recordPolicyEvidence(
    identity: PortalCrmRequestIdentity,
    input: RecordPolicyEvidenceInput,
  ): Promise<RecordPolicyEvidenceResult>;
  /** Read-only. Resolves the tuple and the exact message, and queues nothing. */
  resolveAuthorisation(
    identity: PortalCrmRequestIdentity,
    input: ResolveAuthorisationInput,
  ): Promise<ResolveAuthorisationResult>;
  /** The one call that reaches the capped enqueue. It never calls Mailgun. */
  authorise(
    identity: PortalCrmRequestIdentity,
    input: AuthoriseInput,
  ): Promise<AuthoriseResult>;
}
