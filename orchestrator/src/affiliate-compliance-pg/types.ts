export const AFFILIATE_COMPLIANCE_PERMISSIONS = [
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
] as const;

export type AffiliateCompliancePermission = (typeof AFFILIATE_COMPLIANCE_PERMISSIONS)[number];

export const AFFILIATE_COMPLIANCE_CHANNELS = [
  'public_social',
  'affiliate_recruitment',
  'email',
  'sms',
  'whatsapp',
  'social_dm',
  'paid_ads',
  'phone',
  'tracking',
  'payout',
] as const;

export type AffiliateComplianceChannel = (typeof AFFILIATE_COMPLIANCE_CHANNELS)[number];

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
  readonly capacityVerified: boolean;
  readonly reacceptanceRequired: boolean;
}

export interface AffiliateTrainingEvidence {
  readonly status: 'passed' | 'failed' | 'missing';
  readonly completedAt: string | null;
  readonly expiresAt: string | null;
  readonly attestationSha256: string | null;
}

export interface AffiliateDeclarationEvidence {
  readonly status: ComplianceEvidenceStatus;
  readonly version: string | null;
  readonly evidenceSha256: string | null;
  readonly expiresAt: string | null;
}

export interface AffiliateChannelAuthorityEvidence {
  readonly channel: AffiliateComplianceChannel;
  readonly status: ComplianceEvidenceStatus;
  readonly validFrom: string | null;
  readonly validUntil: string | null;
  readonly evidenceSha256: string | null;
}

export interface AffiliateComplianceHold {
  readonly kind: 'reacceptance' | 'correction' | 'suspension' | 'fraud' | 'security';
  readonly active: boolean;
  readonly caseReference: string;
}

export interface AffiliateEffectEvidence {
  readonly propertyInvestmentContent: boolean;
  readonly contentApprovedForScope: boolean;
  readonly disclosureRenderedAndChecked: boolean;
  readonly claimEvidenceCurrent: boolean;
  readonly recipientRouteCurrent: boolean;
  readonly suppressionClear: boolean;
  readonly visitorChoiceCurrent: boolean;
  readonly payoutChecksCurrent: boolean;
  readonly providerEffectsOn: boolean;
}

export interface AffiliateSpecialistDecisionEvidence {
  readonly status: ComplianceEvidenceStatus;
  readonly decisionReference: string | null;
  readonly expiresAt: string | null;
}

export type PecrElectronicMailRoute =
  | 'solicited_request'
  | 'individual_consent'
  | 'individual_soft_opt_in'
  | 'corporate_subscriber_reg23'
  | 'unknown';

export interface AffiliatePecrRouteDecisionEvidence extends AffiliateSpecialistDecisionEvidence {
  readonly routeClassification: PecrElectronicMailRoute;
  readonly partyReference: string | null;
  readonly responsibilityReference: string | null;
}

export interface AffiliateComplianceEvidence {
  readonly policyPack: AffiliatePolicyPackEvidence | null;
  readonly acceptance: AffiliateAcceptanceEvidence | null;
  readonly training: AffiliateTrainingEvidence | null;
  readonly declarations: Readonly<{
    businessTax: AffiliateDeclarationEvidence | null;
    disclosureClaims: AffiliateDeclarationEvidence | null;
    dataProtection: AffiliateDeclarationEvidence | null;
  }>;
  readonly channelAuthorities: readonly AffiliateChannelAuthorityEvidence[];
  readonly specialistDecisions: Readonly<{
    /** Per-flow sender route and responsibility under PECR. */
    pecrSenderRoute: AffiliatePecrRouteDecisionEvidence | null;
    /** Per-flow Operator instigator/responsibility decision under PECR. */
    pecrInstigatorRoute: AffiliatePecrRouteDecisionEvidence | null;
    /** CAP Section 20 classification for affiliate recruitment/team rewards. */
    affiliateRecruitmentPolicy: AffiliateSpecialistDecisionEvidence | null;
    /** CAP Section 14 and FCA/FSMA perimeter classification/approval. */
    financialPromotionPerimeter: AffiliateSpecialistDecisionEvidence | null;
    /** Consumer/status eligibility review kept independent from claim approval. */
    consumerEligibilityReview: AffiliateSpecialistDecisionEvidence | null;
    /** OFSI screening, ownership/control, rescreen and freeze/escalation route. */
    sanctionsScreening: AffiliateSpecialistDecisionEvidence | null;
  }>;
  readonly holds: readonly AffiliateComplianceHold[];
  readonly effects: AffiliateEffectEvidence;
}

export const AFFILIATE_COMPLIANCE_REASON_CODES = [
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
  'PROMOTION_CHANNEL_NOT_APPROVED',
  'CHANNEL_AUTHORITY_MISSING',
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
  'CORRECTION_REQUIRED',
  'SUSPENSION_ACTIVE',
  'FRAUD_HOLD_ACTIVE',
  'SECURITY_HOLD_ACTIVE',
] as const;

export type AffiliateComplianceReasonCode = (typeof AFFILIATE_COMPLIANCE_REASON_CODES)[number];

export interface AffiliateComplianceDecision {
  readonly decision: 'allow' | 'deny';
  readonly permission: AffiliateCompliancePermission;
  readonly evaluatedAt: string;
  readonly expiresAt: string;
  readonly reasonCodes: readonly AffiliateComplianceReasonCode[];
  readonly nextAction: string;
}

export interface EvaluateAffiliateComplianceInput {
  readonly permission: AffiliateCompliancePermission;
  readonly now: string;
  readonly evidence: AffiliateComplianceEvidence;
}
