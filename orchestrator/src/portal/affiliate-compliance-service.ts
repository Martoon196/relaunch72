import type {
  AffiliateComplianceEvidence,
} from '../affiliate-compliance-pg/types.js';

export interface PortalAffiliateComplianceRequestIdentity {
  readonly sessionToken: string;
  readonly requestId: string;
}

export interface PortalAffiliateComplianceDocument {
  readonly documentType: string;
  readonly title: string;
  readonly version: string;
  readonly contentSha256: string;
  readonly draftingStatus: 'draft_complete';
  readonly legalStatus: 'awaiting_solicitor_review' | 'approved' | 'rejected';
  readonly commercialStatus: 'awaiting_legal_approval' | 'approved' | 'rejected';
  readonly publicationStatus: 'not_published' | 'published' | 'withdrawn';
}

export interface PortalAffiliateComplianceTimelineEvent {
  readonly eventId: string;
  readonly eventType: string;
  readonly label: string;
  readonly occurredAt: string;
  readonly evidenceSha256: string;
  readonly previousEventId: string | null;
}

export interface PortalAffiliateComplianceCase {
  readonly caseReference: string;
  readonly state: 'open' | 'correction_required' | 'suspended_interim' | 'closed';
  readonly severity: 'low' | 'medium' | 'high';
  readonly reasonLabel: string;
  readonly openedAt: string;
  readonly ownerRole: string;
  readonly blocksPermissions: boolean;
}

export interface PortalAffiliateComplianceSubject {
  readonly subjectId: string;
  readonly displayLabel: string;
  readonly fictional: true;
  readonly lifecycleLabel: string;
  readonly evidence: AffiliateComplianceEvidence;
  readonly cases: readonly PortalAffiliateComplianceCase[];
  readonly timeline: readonly PortalAffiliateComplianceTimelineEvent[];
}

export interface PortalAffiliateComplianceSnapshot {
  readonly workspace: Readonly<{
    workspaceId: string;
    workspaceName: string;
    snapshotAt: string;
    canManage: boolean;
  }>;
  readonly programme: Readonly<{
    programmeName: string;
    packVersion: string;
    bundleSha256: string;
    sourceCommit: string;
    sourceCommitMeaning: 'drafting_provenance_only';
    solicitorApproved: false;
    published: false;
    externalEffects: false;
    documents: readonly PortalAffiliateComplianceDocument[];
    openDecisions: readonly string[];
  }>;
  readonly subjects: readonly PortalAffiliateComplianceSubject[];
  readonly dataset: 'illustrative_fixture';
}

export type PortalAffiliateComplianceSnapshotOutcome =
  | { readonly ok: true; readonly snapshot: PortalAffiliateComplianceSnapshot }
  | {
      readonly ok: false;
      readonly kind: 'unauthenticated' | 'forbidden' | 'not_found' | 'invalid_snapshot' | 'unavailable';
      readonly message: string;
    };

/** Read-only evidence boundary. There is no acceptance, approval, send, link or provider command. */
export interface PortalAffiliateComplianceService {
  snapshot(
    identity: PortalAffiliateComplianceRequestIdentity,
  ): Promise<PortalAffiliateComplianceSnapshotOutcome>;
}
