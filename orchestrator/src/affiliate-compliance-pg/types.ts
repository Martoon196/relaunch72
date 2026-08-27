export const AFFILIATE_COMPLIANCE_PERMISSIONS = Object.freeze([
  'affiliate_link.issue',
  'content.export_linked',
  'public_social.manual_publish',
  'public_social.provider_publish',
  'affiliate_recruitment.manual_publish',
  'affiliate_recruitment.provider_publish',
  'email.send',
  'sms.send',
  'whatsapp.send',
  'social_dm.send',
  'audience.upload',
  'paid_ads.launch',
  'phone.marketing',
  'affiliate_attribution.write',
  'commission.payout',
] as const);

export type AffiliateCompliancePermission = (typeof AFFILIATE_COMPLIANCE_PERMISSIONS)[number];

/** One canonical channel vocabulary shared by SQL, projections and the evaluator. */
export const AFFILIATE_COMPLIANCE_CHANNELS = Object.freeze([
  'affiliate_link',
  'content_export',
  'public_social',
  'affiliate_recruitment',
  'email',
  'sms',
  'whatsapp',
  'social_dm',
  'audience_upload',
  'paid_ads',
  'phone',
  'tracking',
  'payout',
] as const);

export type AffiliateComplianceChannel = (typeof AFFILIATE_COMPLIANCE_CHANNELS)[number];

export const AFFILIATE_COMPLIANCE_LIFECYCLE_STATES = Object.freeze([
  'account_only',
  'application_draft',
  'identity_review',
  'legal_bundle_presented',
  'legal_accepted',
  'training_required',
  'declarations_required',
  'compliance_review',
  'active_limited',
  'active',
  'reacceptance_required',
  'correction_required',
  'suspended_interim',
  'suspended_final',
  'terminated',
  'withdrawn',
  'migrated_unverified',
] as const);

export type AffiliateComplianceLifecycleState = (typeof AFFILIATE_COMPLIANCE_LIFECYCLE_STATES)[number];

export const AFFILIATE_SPECIALIST_DECISION_KINDS = Object.freeze([
  'pecr_sender_route',
  'pecr_instigator_route',
  'affiliate_recruitment_policy',
  'financial_promotion_perimeter',
  'consumer_eligibility_review',
  'sanctions_screening',
] as const);

export type AffiliateSpecialistDecisionKind = (typeof AFFILIATE_SPECIALIST_DECISION_KINDS)[number];

export const AFFILIATE_COMPLIANCE_EFFECT_KINDS = Object.freeze([
  'content_classification',
  'content_scope_approval',
  'rendered_disclosure_check',
  'claim_evidence',
  'recipient_route',
  'suppression',
  'visitor_choice',
  'payout_checks',
] as const);

export type AffiliateComplianceEffectKind = (typeof AFFILIATE_COMPLIANCE_EFFECT_KINDS)[number];

export type ComplianceEvidenceStatus = 'current' | 'missing' | 'expired' | 'withdrawn';

export interface AffiliatePolicyPackEvidence {
  readonly bundleId: string;
  readonly bundleVersion: string;
  readonly bundleSha256: string;
  readonly legalApproval: 'approved' | 'pending' | 'rejected' | 'withdrawn';
  readonly commercialApproval: 'approved' | 'pending' | 'rejected' | 'withdrawn';
  readonly publication: 'published' | 'draft' | 'superseded' | 'withdrawn';
  readonly effectiveAt: string | null;
  readonly expiresAt: string | null;
}

export interface AffiliateAcceptanceEvidence {
  readonly status: 'accepted' | 'declined' | 'missing';
  readonly bundleId: string | null;
  readonly bundleSha256: string | null;
  readonly acceptedAt: string | null;
  readonly expiresAt: string | null;
}

export interface AffiliateCapacityEvidence {
  readonly status: ComplianceEvidenceStatus;
  readonly decision: 'verified' | 'blocked' | null;
  readonly capacityReference: string | null;
  readonly evidenceSha256: string | null;
  readonly occurredAt: string | null;
  readonly expiresAt: string | null;
}

export interface AffiliateTrainingEvidence {
  readonly status: 'passed' | 'failed' | 'missing';
  readonly trainingKey: string | null;
  readonly trainingVersion: string | null;
  readonly courseSha256: string | null;
  readonly quizSha256: string | null;
  readonly approvalState: 'approved' | 'blocked' | 'withdrawn' | null;
  readonly completedAt: string | null;
  readonly expiresAt: string | null;
  readonly attestationSha256: string | null;
}

export interface AffiliateDeclarationEvidence {
  readonly status: ComplianceEvidenceStatus;
  readonly decision: 'affirmed' | 'declined' | 'withdrawn' | null;
  readonly version: string | null;
  readonly declarationSha256: string | null;
  readonly evidenceSha256: string | null;
  readonly occurredAt: string | null;
  readonly expiresAt: string | null;
}

export interface AffiliateLifecycleEvidence {
  readonly state: AffiliateComplianceLifecycleState;
  readonly occurredAt: string;
  readonly evidenceSha256: string;
}

export interface AffiliateChannelAuthorityEvidence {
  readonly channel: AffiliateComplianceChannel;
  readonly status: ComplianceEvidenceStatus;
  readonly authorityState: 'approved' | 'blocked' | 'revoked' | 'expired';
  readonly contentClass: 'ordinary_product' | 'affiliate_recruitment' | 'property_investment' | 'operational_only';
  readonly purposeCode: string;
  readonly territoryCode: string;
  readonly senderPartyReference: string;
  readonly accountScopeReference: string;
  readonly actionScopeSha256: string;
  readonly validFrom: string | null;
  readonly validUntil: string | null;
  readonly evidenceSha256: string | null;
}

export interface AffiliateComplianceCaseEvidence {
  readonly kind: 'reacceptance' | 'correction' | 'suspension' | 'fraud' | 'security';
  readonly state: 'opened' | 'takedown_requested' | 'correction_requested' | 'suspended_interim' | 'suspended_final' | 'reinstated' | 'closed';
  readonly permissionEffect: 'block' | 'monitor';
  readonly caseReference: string;
  readonly occurredAt: string;
  readonly evidenceSha256: string;
}

export interface AffiliatePermissionFactEvidence {
  readonly permission: AffiliateCompliancePermission;
  readonly state: 'requested' | 'blocked' | 'revoked' | 'expired';
  readonly actionScopeSha256: string;
  readonly validFrom: string;
  readonly validUntil: string | null;
  readonly evidenceSha256: string;
}

export interface AffiliateScopedEffectEvidence {
  readonly kind: Exclude<AffiliateComplianceEffectKind, 'content_classification'>;
  readonly status: ComplianceEvidenceStatus;
  readonly decision: 'satisfied' | 'blocked' | null;
  readonly actionScopeSha256: string | null;
  readonly evidenceSha256: string | null;
  readonly validFrom: string | null;
  readonly expiresAt: string | null;
}

export interface AffiliateContentClassificationEvidence {
  readonly kind: 'content_classification';
  readonly status: ComplianceEvidenceStatus;
  readonly classification: 'ordinary_product' | 'property_investment' | null;
  readonly actionScopeSha256: string | null;
  readonly evidenceSha256: string | null;
  readonly validFrom: string | null;
  readonly expiresAt: string | null;
}

export interface AffiliateEffectEvidence {
  readonly contentClassification: AffiliateContentClassificationEvidence | null;
  readonly contentScopeApproval: AffiliateScopedEffectEvidence | null;
  readonly disclosureRenderedCheck: AffiliateScopedEffectEvidence | null;
  readonly claimEvidence: AffiliateScopedEffectEvidence | null;
  readonly recipientRoute: AffiliateScopedEffectEvidence | null;
  readonly suppression: AffiliateScopedEffectEvidence | null;
  readonly visitorChoice: AffiliateScopedEffectEvidence | null;
  readonly payoutChecks: AffiliateScopedEffectEvidence | null;
  /** This compliance module owns no provider capability. */
  readonly providerEffects: 'off';
}

export interface AffiliateSpecialistDecisionEvidence {
  readonly status: ComplianceEvidenceStatus;
  readonly decisionKind: AffiliateSpecialistDecisionKind;
  readonly decision: 'approved' | 'blocked' | null;
  readonly decisionReference: string | null;
  readonly actionScopeSha256: string | null;
  readonly validFrom: string | null;
  readonly expiresAt: string | null;
}

export type PecrElectronicMailRoute =
  | 'solicited_request'
  | 'individual_consent'
  | 'individual_soft_opt_in'
  | 'corporate_subscriber_reg23'
  | 'unknown';

export interface AffiliatePecrRouteDecisionEvidence extends AffiliateSpecialistDecisionEvidence {
  readonly decisionKind: 'pecr_sender_route' | 'pecr_instigator_route';
  readonly routeClassification: PecrElectronicMailRoute;
  readonly partyReference: string | null;
  readonly responsibilityReference: string | null;
}

export interface AffiliateComplianceEvidence {
  readonly workspaceId: string;
  readonly subjectId: string;
  readonly evidenceSnapshotSha256: string;
  readonly policyPack: AffiliatePolicyPackEvidence | null;
  readonly lifecycle: AffiliateLifecycleEvidence;
  readonly acceptance: AffiliateAcceptanceEvidence | null;
  readonly capacity: AffiliateCapacityEvidence | null;
  readonly training: AffiliateTrainingEvidence | null;
  readonly declarations: Readonly<{
    businessTax: AffiliateDeclarationEvidence | null;
    disclosureClaims: AffiliateDeclarationEvidence | null;
    dataProtection: AffiliateDeclarationEvidence | null;
  }>;
  readonly channelAuthorities: readonly AffiliateChannelAuthorityEvidence[];
  readonly specialistDecisions: Readonly<{
    pecrSenderRoute: AffiliatePecrRouteDecisionEvidence | null;
    pecrInstigatorRoute: AffiliatePecrRouteDecisionEvidence | null;
    affiliateRecruitmentPolicy: AffiliateSpecialistDecisionEvidence | null;
    financialPromotionPerimeter: AffiliateSpecialistDecisionEvidence | null;
    consumerEligibilityReview: AffiliateSpecialistDecisionEvidence | null;
    sanctionsScreening: AffiliateSpecialistDecisionEvidence | null;
  }>;
  readonly cases: readonly AffiliateComplianceCaseEvidence[];
  readonly permissionFacts: readonly AffiliatePermissionFactEvidence[];
  readonly effects: AffiliateEffectEvidence;
}

export const AFFILIATE_COMPLIANCE_REASON_CODES = Object.freeze([
  'UNKNOWN_PERMISSION',
  'EVIDENCE_INVALID',
  'POLICY_PACK_MISSING',
  'LEGAL_APPROVAL_MISSING',
  'COMMERCIAL_APPROVAL_MISSING',
  'POLICY_PACK_NOT_PUBLISHED',
  'POLICY_PACK_NOT_EFFECTIVE',
  'POLICY_PACK_EXPIRED',
  'ACCEPTANCE_MISSING',
  'ACCEPTANCE_BUNDLE_MISMATCH',
  'ACCEPTANCE_EXPIRED',
  'SIGNATORY_AUTHORITY_UNVERIFIED',
  'REACCEPTANCE_REQUIRED',
  'TRAINING_MISSING',
  'TRAINING_EXPIRED',
  'BUSINESS_TAX_DECLARATION_MISSING',
  'DISCLOSURE_CLAIMS_ACKNOWLEDGEMENT_MISSING',
  'DATA_PROTECTION_DECLARATION_MISSING',
  'LIFECYCLE_TERMINATED',
  'LIFECYCLE_WITHDRAWN',
  'LIFECYCLE_NOT_ELIGIBLE',
  'PROMOTION_CHANNEL_NOT_APPROVED',
  'CHANNEL_AUTHORITY_MISSING',
  'CONTENT_CLASSIFICATION_MISSING',
  'CONTENT_SCOPE_NOT_APPROVED',
  'DISCLOSURE_CHECK_MISSING',
  'CLAIM_EVIDENCE_MISSING',
  'RECIPIENT_ROUTE_MISSING',
  'PECR_SENDER_ROUTE_MISSING',
  'PECR_INSTIGATOR_DECISION_MISSING',
  'AFFILIATE_RECRUITMENT_POLICY_MISSING',
  'FINANCIAL_PROMOTION_PERIMETER_MISSING',
  'CONSUMER_ELIGIBILITY_REVIEW_MISSING',
  'SANCTIONS_SCREENING_MISSING',
  'SUPPRESSION_CHECK_FAILED',
  'VISITOR_CHOICE_MISSING',
  'PAYOUT_CHECKS_MISSING',
  'PROVIDER_EFFECTS_OFF',
  'PERMISSION_BLOCK_ACTIVE',
  'CORRECTION_REQUIRED',
  'SUSPENSION_ACTIVE',
  'FRAUD_HOLD_ACTIVE',
  'SECURITY_HOLD_ACTIVE',
] as const);

export type AffiliateComplianceReasonCode = (typeof AFFILIATE_COMPLIANCE_REASON_CODES)[number];

export interface AffiliateComplianceDecision {
  readonly decision: 'allow' | 'deny';
  readonly permission: AffiliateCompliancePermission;
  readonly workspaceId: string;
  readonly subjectId: string;
  /** Digest of the exact action, recipient/audience, content version, provider and account scope. */
  readonly actionScopeSha256: string;
  readonly evidenceSnapshotSha256: string;
  readonly decisionNonceSha256: string;
  readonly evaluatedAt: string;
  readonly expiresAt: string;
  readonly reasonCodes: readonly AffiliateComplianceReasonCode[];
  readonly nextAction: string;
}

export interface EvaluateAffiliateComplianceInput {
  readonly permission: AffiliateCompliancePermission;
  readonly workspaceId: string;
  readonly subjectId: string;
  /** Digest of the exact action, recipient/audience, content version, provider and account scope. */
  readonly actionScopeSha256: string;
  readonly decisionNonceSha256: string;
  readonly now: string;
  readonly evidence: AffiliateComplianceEvidence;
}
