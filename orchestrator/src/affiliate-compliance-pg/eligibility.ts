import {
  AFFILIATE_COMPLIANCE_CHANNELS,
  AFFILIATE_COMPLIANCE_PERMISSIONS,
  type AffiliateChannelAuthorityEvidence,
  type AffiliateComplianceChannel,
  type AffiliateComplianceDecision,
  type AffiliateCompliancePermission,
  type AffiliateComplianceReasonCode,
  type AffiliateDeclarationEvidence,
  type EvaluateAffiliateComplianceInput,
} from './types.js';

const PERMISSION_CHANNEL: Readonly<Partial<Record<AffiliateCompliancePermission, AffiliateComplianceChannel>>> = Object.freeze({
  'public_social.manual_publish': 'public_social',
  'public_social.provider_publish': 'public_social',
  'affiliate_recruitment.manual_publish': 'affiliate_recruitment',
  'affiliate_recruitment.provider_publish': 'affiliate_recruitment',
  'email.send': 'email',
  'sms.send': 'sms',
  'whatsapp.send': 'whatsapp',
  'social_dm.send': 'social_dm',
  'audience.upload': 'paid_ads',
  'paid_ads.launch': 'paid_ads',
  'phone.marketing': 'phone',
  'affiliate_attribution.write': 'tracking',
  'commission.payout': 'payout',
});

const PROVIDER_EFFECT_PERMISSIONS = new Set<AffiliateCompliancePermission>([
  'public_social.provider_publish',
  'affiliate_recruitment.provider_publish',
  'email.send',
  'sms.send',
  'whatsapp.send',
  'social_dm.send',
  'audience.upload',
  'paid_ads.launch',
  'phone.marketing',
  'commission.payout',
]);

const CONTENT_PERMISSIONS = new Set<AffiliateCompliancePermission>([
  'content.export_linked',
  'public_social.manual_publish',
  'public_social.provider_publish',
  'affiliate_recruitment.manual_publish',
  'affiliate_recruitment.provider_publish',
  'email.send',
  'sms.send',
  'whatsapp.send',
  'social_dm.send',
  'paid_ads.launch',
]);

const RECIPIENT_PERMISSIONS = new Set<AffiliateCompliancePermission>([
  'email.send', 'sms.send', 'whatsapp.send', 'social_dm.send', 'phone.marketing',
]);

const NEXT_ACTIONS: Readonly<Partial<Record<AffiliateComplianceReasonCode, string>>> = Object.freeze({
  POLICY_PACK_MISSING: 'Publish a solicitor-approved policy pack before onboarding affiliates.',
  LEGAL_APPROVAL_MISSING: 'Send the exact document pack to the solicitor and record their scoped approval.',
  COMMERCIAL_APPROVAL_MISSING: 'Record commercial approval for the exact solicitor-reviewed pack.',
  POLICY_PACK_NOT_PUBLISHED: 'Publish an approved pack with a clear effective date.',
  POLICY_PACK_NOT_EFFECTIVE: 'Wait for the approved pack to become effective.',
  POLICY_PACK_EXPIRED: 'Publish and approve a replacement policy pack.',
  ACCEPTANCE_MISSING: 'Ask the affiliate to accept the exact current document bundle.',
  ACCEPTANCE_BUNDLE_MISMATCH: 'Collect a fresh acceptance for the current bundle.',
  ACCEPTANCE_EXPIRED: 'Collect a fresh acceptance before restoring permissions.',
  SIGNATORY_AUTHORITY_UNVERIFIED: 'Verify that the accepting person has authority for the named affiliate entity.',
  REACCEPTANCE_REQUIRED: 'Present the changed terms and collect explicit reacceptance.',
  TRAINING_MISSING: 'Complete the current disclosure, claims and direct-marketing training.',
  TRAINING_EXPIRED: 'Repeat the current training and assessment.',
  BUSINESS_TAX_DECLARATION_MISSING: 'Complete the current business, tax and VAT declaration.',
  DISCLOSURE_CLAIMS_ACKNOWLEDGEMENT_MISSING: 'Acknowledge the current disclosure and claims policy.',
  DATA_PROTECTION_DECLARATION_MISSING: 'Complete the current data-protection and direct-marketing declaration.',
  PROMOTION_CHANNEL_NOT_APPROVED: 'Request and verify at least one permitted promotion channel.',
  CHANNEL_AUTHORITY_MISSING: 'Verify this channel, purpose, territory and sender before use.',
  CONTENT_SCOPE_NOT_APPROVED: 'Use an exact content version approved for this channel and audience.',
  DISCLOSURE_CHECK_MISSING: 'Check the disclosure after final rendering, cropping and truncation.',
  CLAIM_EVIDENCE_MISSING: 'Attach current evidence for every objective claim.',
  RECIPIENT_ROUTE_MISSING: 'Record the lawful recipient-level route immediately before release.',
  PECR_SENDER_ROUTE_MISSING: 'Record the exact PECR sender route, party and responsibility for this flow.',
  PECR_INSTIGATOR_DECISION_MISSING: 'Record who instigates this electronic-marketing flow and the Operator responsibilities.',
  AFFILIATE_RECRUITMENT_POLICY_MISSING: 'Classify and approve the affiliate-recruitment or team-reward flow under the dedicated policy.',
  FINANCIAL_PROMOTION_PERIMETER_MISSING: 'Obtain the recorded CAP 14 and FCA/FSMA perimeter decision for this content.',
  CONSUMER_ELIGIBILITY_REVIEW_MISSING: 'Complete the independent consumer/status eligibility review for this content and audience.',
  SANCTIONS_SCREENING_MISSING: 'Complete OFSI screening, ownership/control review and the approved hold/escalation route.',
  SUPPRESSION_CHECK_FAILED: 'Resolve the suppression or objection before any release.',
  VISITOR_CHOICE_MISSING: 'Obtain the required visitor choice before attribution storage or access.',
  PAYOUT_CHECKS_MISSING: 'Complete payee, VAT, validation and reconciliation checks.',
  PROVIDER_EFFECTS_OFF: 'A separately authorised activation must enable every provider-effects layer.',
  CORRECTION_REQUIRED: 'Complete and evidence the required correction.',
  SUSPENSION_ACTIVE: 'Resolve the active suspension case before restoring permissions.',
  FRAUD_HOLD_ACTIVE: 'Resolve the fraud review before restoring permissions.',
  SECURITY_HOLD_ACTIVE: 'Resolve the security hold before restoring permissions.',
});

function parseInstant(value: string | null): number | null {
  if (value === null) return null;
  const instant = Date.parse(value);
  return Number.isFinite(instant) ? instant : null;
}

function isNonBlank(value: string | null): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isSha256(value: string | null): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function optionalExpiryIsCurrent(value: string | null, now: number): boolean {
  if (value === null) return true;
  const expiresAt = parseInstant(value);
  return expiresAt !== null && expiresAt > now;
}

function currentDeclaration(
  declaration: AffiliateDeclarationEvidence | null,
  now: number,
): boolean {
  if (!declaration || declaration.status !== 'current') return false;
  return isNonBlank(declaration.version)
    && isSha256(declaration.evidenceSha256)
    && optionalExpiryIsCurrent(declaration.expiresAt, now);
}

function currentChannel(
  authority: AffiliateChannelAuthorityEvidence,
  now: number,
): boolean {
  if (authority.status !== 'current') return false;
  const validFrom = parseInstant(authority.validFrom);
  return validFrom !== null
    && validFrom <= now
    && isSha256(authority.evidenceSha256)
    && optionalExpiryIsCurrent(authority.validUntil, now);
}

function currentSpecialistDecision(
  decision: {
    readonly status: string;
    readonly decisionReference: string | null;
    readonly expiresAt: string | null;
  } | null,
  now: number,
): boolean {
  return Boolean(decision
    && decision.status === 'current'
    && isNonBlank(decision.decisionReference)
    && optionalExpiryIsCurrent(decision.expiresAt, now));
}

function currentPecrRoute(
  decision: { readonly status: string; readonly decisionReference: string | null; readonly expiresAt: string | null; readonly routeClassification: string; readonly partyReference: string | null; readonly responsibilityReference: string | null } | null,
  now: number,
): boolean {
  return currentSpecialistDecision(decision, now)
    && decision!.routeClassification !== 'unknown'
    && Boolean(decision!.partyReference?.trim())
    && Boolean(decision!.responsibilityReference?.trim());
}

function uniqueReasons(reasons: readonly AffiliateComplianceReasonCode[]): readonly AffiliateComplianceReasonCode[] {
  return Object.freeze([...new Set(reasons)]);
}

function decisionExpiry(now: number, candidates: readonly (string | null)[]): string {
  const ceiling = now + 5 * 60_000;
  const expiries = candidates
    .map(parseInstant)
    .filter((instant): instant is number => instant !== null && instant > now);
  return new Date(Math.min(ceiling, ...expiries)).toISOString();
}

/**
 * The sole product-domain eligibility evaluator. Missing, malformed, stale or
 * contradictory evidence is a denial. Provider readiness never implies legal
 * readiness and a CRM/affiliate lifecycle label is deliberately not an input.
 */
export function evaluateAffiliateCompliance(
  input: EvaluateAffiliateComplianceInput,
): AffiliateComplianceDecision {
  const permission = input.permission;
  const now = Date.parse(input.now);
  const knownPermission = (AFFILIATE_COMPLIANCE_PERMISSIONS as readonly unknown[]).includes(permission);
  if (!knownPermission || !Number.isFinite(now)) {
    const safePermission = knownPermission ? permission : 'affiliate_link.issue';
    const reasonCode: AffiliateComplianceReasonCode = knownPermission
      ? 'EVIDENCE_INVALID'
      : 'UNKNOWN_PERMISSION';
    return Object.freeze({
      decision: 'deny',
      permission: safePermission,
      evaluatedAt: Number.isFinite(now) ? new Date(now).toISOString() : new Date(0).toISOString(),
      expiresAt: Number.isFinite(now) ? new Date(now).toISOString() : new Date(0).toISOString(),
      reasonCodes: Object.freeze([reasonCode]),
      nextAction: 'Refresh the evidence and request a new compliance decision.',
    });
  }

  const evidence = input.evidence;
  const reasons: AffiliateComplianceReasonCode[] = [];
  const pack = evidence.policyPack;
  if (!pack) reasons.push('POLICY_PACK_MISSING');
  if (pack) {
    if (!isNonBlank(pack.bundleId)
        || !isNonBlank(pack.bundleVersion)
        || !isSha256(pack.bundleSha256)) reasons.push('EVIDENCE_INVALID');
    if (pack.legalApproval !== 'approved') reasons.push('LEGAL_APPROVAL_MISSING');
    if (pack.commercialApproval !== 'approved') reasons.push('COMMERCIAL_APPROVAL_MISSING');
    if (pack.publication !== 'published') reasons.push('POLICY_PACK_NOT_PUBLISHED');
    const effectiveAt = parseInstant(pack.effectiveAt);
    const expiresAt = parseInstant(pack.expiresAt);
    if (effectiveAt === null || effectiveAt > now) reasons.push('POLICY_PACK_NOT_EFFECTIVE');
    if (pack.expiresAt !== null && (expiresAt === null || expiresAt <= now)) reasons.push('POLICY_PACK_EXPIRED');
  }

  const acceptance = evidence.acceptance;
  if (!acceptance || acceptance.status !== 'accepted') reasons.push('ACCEPTANCE_MISSING');
  if (acceptance?.status === 'accepted' && pack
      && (acceptance.bundleId !== pack.bundleId || acceptance.bundleSha256 !== pack.bundleSha256)) {
    reasons.push('ACCEPTANCE_BUNDLE_MISMATCH');
  }
  if (acceptance?.status === 'accepted') {
    const acceptedAt = parseInstant(acceptance.acceptedAt);
    if (!isNonBlank(acceptance.bundleId)
        || !isSha256(acceptance.bundleSha256)
        || acceptedAt === null
        || acceptedAt > now) reasons.push('EVIDENCE_INVALID');
    const expiresAt = parseInstant(acceptance.expiresAt);
    if (acceptance.expiresAt !== null && (expiresAt === null || expiresAt <= now)) reasons.push('ACCEPTANCE_EXPIRED');
    if (!acceptance.capacityVerified) reasons.push('SIGNATORY_AUTHORITY_UNVERIFIED');
    if (acceptance.reacceptanceRequired) reasons.push('REACCEPTANCE_REQUIRED');
  }

  const training = evidence.training;
  if (!training || training.status !== 'passed') reasons.push('TRAINING_MISSING');
  if (training?.status === 'passed') {
    const completedAt = parseInstant(training.completedAt);
    if (completedAt === null
        || completedAt > now
        || !isSha256(training.attestationSha256)) reasons.push('EVIDENCE_INVALID');
    const expiresAt = parseInstant(training.expiresAt);
    if (training.expiresAt === null || expiresAt === null || expiresAt <= now) reasons.push('TRAINING_EXPIRED');
  }
  if (!currentDeclaration(evidence.declarations.businessTax, now)) reasons.push('BUSINESS_TAX_DECLARATION_MISSING');
  if (!currentDeclaration(evidence.declarations.disclosureClaims, now)) reasons.push('DISCLOSURE_CLAIMS_ACKNOWLEDGEMENT_MISSING');
  if (!currentDeclaration(evidence.declarations.dataProtection, now)) reasons.push('DATA_PROTECTION_DECLARATION_MISSING');

  for (const hold of evidence.holds) {
    if (!hold.active) continue;
    if (hold.kind === 'reacceptance') reasons.push('REACCEPTANCE_REQUIRED');
    if (hold.kind === 'correction') reasons.push('CORRECTION_REQUIRED');
    if (hold.kind === 'suspension') reasons.push('SUSPENSION_ACTIVE');
    if (hold.kind === 'fraud') reasons.push('FRAUD_HOLD_ACTIVE');
    if (hold.kind === 'security') reasons.push('SECURITY_HOLD_ACTIVE');
  }

  const currentAuthorities = evidence.channelAuthorities.filter((authority) => (
    (AFFILIATE_COMPLIANCE_CHANNELS as readonly unknown[]).includes(authority.channel)
    && currentChannel(authority, now)
  ));
  if ((permission === 'affiliate_link.issue' || permission === 'content.export_linked')
      && !currentAuthorities.some((authority) => authority.channel !== 'payout')) {
    reasons.push('PROMOTION_CHANNEL_NOT_APPROVED');
  }
  const requiredChannel = PERMISSION_CHANNEL[permission];
  if (requiredChannel && !currentAuthorities.some((authority) => authority.channel === requiredChannel)) {
    reasons.push('CHANNEL_AUTHORITY_MISSING');
  }

  if (CONTENT_PERMISSIONS.has(permission)) {
    if (!evidence.effects.contentApprovedForScope) reasons.push('CONTENT_SCOPE_NOT_APPROVED');
    if (!evidence.effects.disclosureRenderedAndChecked) reasons.push('DISCLOSURE_CHECK_MISSING');
    if (!evidence.effects.claimEvidenceCurrent) reasons.push('CLAIM_EVIDENCE_MISSING');
  }
  if (RECIPIENT_PERMISSIONS.has(permission)) {
    if (!evidence.effects.recipientRouteCurrent) reasons.push('RECIPIENT_ROUTE_MISSING');
    if (!currentPecrRoute(evidence.specialistDecisions.pecrSenderRoute, now)) {
      reasons.push('PECR_SENDER_ROUTE_MISSING');
    }
    if (!currentPecrRoute(evidence.specialistDecisions.pecrInstigatorRoute, now)) {
      reasons.push('PECR_INSTIGATOR_DECISION_MISSING');
    }
    if (!evidence.effects.suppressionClear) reasons.push('SUPPRESSION_CHECK_FAILED');
  }
  if ((permission === 'affiliate_recruitment.manual_publish'
      || permission === 'affiliate_recruitment.provider_publish')
      && !currentSpecialistDecision(evidence.specialistDecisions.affiliateRecruitmentPolicy, now)) {
    reasons.push('AFFILIATE_RECRUITMENT_POLICY_MISSING');
  }
  if (evidence.effects.propertyInvestmentContent
      && CONTENT_PERMISSIONS.has(permission)
      && !currentSpecialistDecision(evidence.specialistDecisions.financialPromotionPerimeter, now)) {
    reasons.push('FINANCIAL_PROMOTION_PERIMETER_MISSING');
  }
  if (evidence.effects.propertyInvestmentContent
      && CONTENT_PERMISSIONS.has(permission)
      && !currentSpecialistDecision(evidence.specialistDecisions.consumerEligibilityReview, now)) {
    reasons.push('CONSUMER_ELIGIBILITY_REVIEW_MISSING');
  }
  if (permission === 'affiliate_attribution.write' && !evidence.effects.visitorChoiceCurrent) {
    reasons.push('VISITOR_CHOICE_MISSING');
  }
  if (permission === 'commission.payout' && !evidence.effects.payoutChecksCurrent) {
    reasons.push('PAYOUT_CHECKS_MISSING');
  }
  if (permission === 'commission.payout'
      && !currentSpecialistDecision(evidence.specialistDecisions.sanctionsScreening, now)) {
    reasons.push('SANCTIONS_SCREENING_MISSING');
  }
  if (PROVIDER_EFFECT_PERMISSIONS.has(permission) && !evidence.effects.providerEffectsOn) {
    reasons.push('PROVIDER_EFFECTS_OFF');
  }

  const reasonCodes = uniqueReasons(reasons);
  const expiries = [
    pack?.expiresAt ?? null,
    acceptance?.expiresAt ?? null,
    training?.expiresAt ?? null,
    evidence.declarations.businessTax?.expiresAt ?? null,
    evidence.declarations.disclosureClaims?.expiresAt ?? null,
    evidence.declarations.dataProtection?.expiresAt ?? null,
    evidence.specialistDecisions.pecrSenderRoute?.expiresAt ?? null,
    evidence.specialistDecisions.pecrInstigatorRoute?.expiresAt ?? null,
    evidence.specialistDecisions.affiliateRecruitmentPolicy?.expiresAt ?? null,
    evidence.specialistDecisions.financialPromotionPerimeter?.expiresAt ?? null,
    evidence.specialistDecisions.consumerEligibilityReview?.expiresAt ?? null,
    evidence.specialistDecisions.sanctionsScreening?.expiresAt ?? null,
    ...currentAuthorities.map((authority) => authority.validUntil),
  ];
  return Object.freeze({
    decision: reasonCodes.length === 0 ? 'allow' : 'deny',
    permission,
    evaluatedAt: new Date(now).toISOString(),
    expiresAt: decisionExpiry(now, expiries),
    reasonCodes,
    nextAction: reasonCodes.length === 0
      ? 'Permission is ready for one short-lived, server-side use.'
      : NEXT_ACTIONS[reasonCodes[0]!] ?? 'Resolve the first blocked evidence gate and evaluate again.',
  });
}
