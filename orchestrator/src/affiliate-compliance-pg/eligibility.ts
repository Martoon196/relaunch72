import type {
  AffiliateChannelAuthorityEvidence,
  AffiliateComplianceCaseEvidence,
  AffiliateComplianceChannel,
  AffiliateComplianceDecision,
  AffiliateCompliancePermission,
  AffiliateComplianceReasonCode,
  AffiliateDeclarationEvidence,
  AffiliatePermissionFactEvidence,
  AffiliateScopedEffectEvidence,
  AffiliateSpecialistDecisionEvidence,
  EvaluateAffiliateComplianceInput,
} from './types.js';
import {
  asValidatedAffiliateComplianceInput,
  validateAffiliateComplianceInput,
} from './validation.js';

const ZERO_UUID = '00000000-0000-4000-8000-000000000000';
const ZERO_SHA256 = '0'.repeat(64);

const PERMISSION_CHANNEL: Readonly<Record<AffiliateCompliancePermission, AffiliateComplianceChannel>> = Object.freeze({
  'affiliate_link.issue': 'affiliate_link',
  'content.export_linked': 'content_export',
  'public_social.manual_publish': 'public_social',
  'public_social.provider_publish': 'public_social',
  'affiliate_recruitment.manual_publish': 'affiliate_recruitment',
  'affiliate_recruitment.provider_publish': 'affiliate_recruitment',
  'email.send': 'email',
  'sms.send': 'sms',
  'whatsapp.send': 'whatsapp',
  'social_dm.send': 'social_dm',
  'audience.upload': 'audience_upload',
  'paid_ads.launch': 'paid_ads',
  'phone.marketing': 'phone',
  'affiliate_attribution.write': 'tracking',
  'commission.payout': 'payout',
});

function isProviderEffectPermission(permission: AffiliateCompliancePermission): boolean {
  switch (permission) {
    case 'public_social.provider_publish':
    case 'affiliate_recruitment.provider_publish':
    case 'email.send':
    case 'sms.send':
    case 'whatsapp.send':
    case 'social_dm.send':
    case 'audience.upload':
    case 'paid_ads.launch':
    case 'phone.marketing':
    case 'commission.payout':
      return true;
    default:
      return false;
  }
}

function isContentPermission(permission: AffiliateCompliancePermission): boolean {
  switch (permission) {
    case 'content.export_linked':
    case 'public_social.manual_publish':
    case 'public_social.provider_publish':
    case 'affiliate_recruitment.manual_publish':
    case 'affiliate_recruitment.provider_publish':
    case 'email.send':
    case 'sms.send':
    case 'whatsapp.send':
    case 'social_dm.send':
    case 'paid_ads.launch':
      return true;
    default:
      return false;
  }
}

function isRecipientPermission(permission: AffiliateCompliancePermission): boolean {
  switch (permission) {
    case 'email.send':
    case 'sms.send':
    case 'whatsapp.send':
    case 'social_dm.send':
    case 'phone.marketing':
      return true;
    default:
      return false;
  }
}

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
  TRAINING_MISSING: 'Complete the exact current approved training version and assessment.',
  TRAINING_EXPIRED: 'Repeat the exact current training and assessment.',
  BUSINESS_TAX_DECLARATION_MISSING: 'Complete the current business, tax and VAT declaration.',
  DISCLOSURE_CLAIMS_ACKNOWLEDGEMENT_MISSING: 'Affirm the current disclosure and claims policy.',
  DATA_PROTECTION_DECLARATION_MISSING: 'Affirm the current data-protection and direct-marketing declaration.',
  LIFECYCLE_TERMINATED: 'A terminated affiliate cannot receive a permission decision.',
  LIFECYCLE_WITHDRAWN: 'A withdrawn affiliate cannot receive a permission decision.',
  LIFECYCLE_NOT_ELIGIBLE: 'Complete the independent affiliate lifecycle review before evaluating a permission.',
  PROMOTION_CHANNEL_NOT_APPROVED: 'Approve the exact affiliate-link or content-export channel scope.',
  CHANNEL_AUTHORITY_MISSING: 'Verify the exact channel, purpose, territory, sender, account and action scope.',
  CONTENT_CLASSIFICATION_MISSING: 'Record the exact current content classification for this action scope.',
  CONTENT_SCOPE_NOT_APPROVED: 'Use an exact content version approved for this channel and audience.',
  DISCLOSURE_CHECK_MISSING: 'Check the disclosure after final rendering, cropping and truncation.',
  CLAIM_EVIDENCE_MISSING: 'Attach current evidence for every objective claim.',
  RECIPIENT_ROUTE_MISSING: 'Record the lawful recipient-level route immediately before release.',
  PECR_SENDER_ROUTE_MISSING: 'Record the exact PECR sender route, party and responsibility for this flow.',
  PECR_INSTIGATOR_DECISION_MISSING: 'Record who instigates this flow and the Operator responsibilities.',
  AFFILIATE_RECRUITMENT_POLICY_MISSING: 'Record the scoped CAP Section 20 affiliate-recruitment decision.',
  FINANCIAL_PROMOTION_PERIMETER_MISSING: 'Record the scoped CAP 14 and FCA/FSMA perimeter approval.',
  CONSUMER_ELIGIBILITY_REVIEW_MISSING: 'Complete the independent scoped consumer/status eligibility review.',
  SANCTIONS_SCREENING_MISSING: 'Complete OFSI screening with a finite rescreen deadline and approved hold route.',
  SUPPRESSION_CHECK_FAILED: 'Resolve the suppression or objection before any release.',
  VISITOR_CHOICE_MISSING: 'Obtain the required visitor choice before attribution storage or access.',
  PAYOUT_CHECKS_MISSING: 'Complete payee, VAT, validation and reconciliation checks.',
  PROVIDER_EFFECTS_OFF: 'This module grants no provider capability; use a separately authorised activation boundary.',
  PERMISSION_BLOCK_ACTIVE: 'Resolve the current scoped permission block before evaluating again.',
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

function currentUntil(value: string | null, now: number, required = false): boolean {
  if (value === null) return !required;
  const expiresAt = parseInstant(value);
  return expiresAt !== null && expiresAt > now;
}

function currentDeclaration(declaration: AffiliateDeclarationEvidence | null, now: number): boolean {
  if (!declaration || declaration.status !== 'current' || declaration.decision !== 'affirmed') return false;
  const occurredAt = parseInstant(declaration.occurredAt);
  return occurredAt !== null && occurredAt <= now
    && declaration.version !== null
    && declaration.declarationSha256 !== null
    && declaration.evidenceSha256 !== null
    && currentUntil(declaration.expiresAt, now);
}

function currentCapacity(
  capacity: EvaluateAffiliateComplianceInput['evidence']['capacity'],
  now: number,
): boolean {
  if (!capacity || capacity.status !== 'current' || capacity.decision !== 'verified'
      || capacity.capacityReference === null || capacity.evidenceSha256 === null) return false;
  const occurredAt = parseInstant(capacity.occurredAt);
  return occurredAt !== null && occurredAt <= now && currentUntil(capacity.expiresAt, now);
}

function currentChannel(
  authority: AffiliateChannelAuthorityEvidence,
  requiredChannel: AffiliateComplianceChannel,
  requiredContentClass: AffiliateChannelAuthorityEvidence['contentClass'],
  actionScopeSha256: string,
  now: number,
): boolean {
  if (authority.channel !== requiredChannel
      || authority.contentClass !== requiredContentClass
      || authority.actionScopeSha256 !== actionScopeSha256
      || authority.status !== 'current'
      || authority.authorityState !== 'approved') return false;
  const validFrom = parseInstant(authority.validFrom);
  return validFrom !== null && validFrom <= now
    && authority.evidenceSha256 !== null
    && currentUntil(authority.validUntil, now);
}

function requiredContentClass(
  permission: AffiliateCompliancePermission,
  classification: 'ordinary_product' | 'property_investment' | null,
): AffiliateChannelAuthorityEvidence['contentClass'] {
  if (permission === 'affiliate_recruitment.manual_publish'
      || permission === 'affiliate_recruitment.provider_publish') return 'affiliate_recruitment';
  if (isContentPermission(permission)) return classification ?? 'ordinary_product';
  switch (permission) {
    case 'audience.upload':
    case 'phone.marketing':
    case 'affiliate_attribution.write':
    case 'commission.payout':
      return 'operational_only';
    default:
      return 'ordinary_product';
  }
}

function currentSpecialistDecision(
  decision: AffiliateSpecialistDecisionEvidence | null,
  expectedKind: AffiliateSpecialistDecisionEvidence['decisionKind'],
  actionScopeSha256: string,
  now: number,
  finiteExpiryRequired = false,
): boolean {
  if (!decision
      || decision.status !== 'current'
      || decision.decision !== 'approved'
      || decision.decisionKind !== expectedKind
      || decision.actionScopeSha256 !== actionScopeSha256
      || decision.decisionReference === null) return false;
  const validFrom = parseInstant(decision.validFrom);
  return validFrom !== null && validFrom <= now
    && currentUntil(decision.expiresAt, now, finiteExpiryRequired);
}

function currentPecrRoute(
  decision: EvaluateAffiliateComplianceInput['evidence']['specialistDecisions']['pecrSenderRoute'],
  expectedKind: 'pecr_sender_route' | 'pecr_instigator_route',
  actionScopeSha256: string,
  now: number,
): boolean {
  return currentSpecialistDecision(decision, expectedKind, actionScopeSha256, now)
    && decision!.routeClassification !== 'unknown'
    && decision!.partyReference !== null
    && decision!.responsibilityReference !== null;
}

function currentEffect(
  effect: AffiliateScopedEffectEvidence | null,
  expectedKind: AffiliateScopedEffectEvidence['kind'],
  actionScopeSha256: string,
  now: number,
): boolean {
  if (!effect || effect.kind !== expectedKind || effect.status !== 'current'
      || effect.decision !== 'satisfied' || effect.actionScopeSha256 !== actionScopeSha256
      || effect.evidenceSha256 === null) return false;
  const validFrom = parseInstant(effect.validFrom);
  return validFrom !== null && validFrom <= now && currentUntil(effect.expiresAt, now);
}

function currentContentClassification(
  input: EvaluateAffiliateComplianceInput,
  now: number,
): 'ordinary_product' | 'property_investment' | null {
  const classification = input.evidence.effects.contentClassification;
  if (!classification || classification.status !== 'current'
      || classification.actionScopeSha256 !== input.actionScopeSha256
      || classification.evidenceSha256 === null) return null;
  const validFrom = parseInstant(classification.validFrom);
  if (validFrom === null || validFrom > now || !currentUntil(classification.expiresAt, now)) return null;
  return classification.classification;
}

function currentPermissionBlock(
  fact: AffiliatePermissionFactEvidence,
  permission: AffiliateCompliancePermission,
  actionScopeSha256: string,
  now: number,
): boolean {
  if (fact.permission !== permission || fact.actionScopeSha256 !== actionScopeSha256
      || fact.state === 'expired') return false;
  const validFrom = parseInstant(fact.validFrom);
  return validFrom !== null && validFrom <= now && currentUntil(fact.validUntil, now);
}

function activeBlockingCase(entry: AffiliateComplianceCaseEvidence): boolean {
  return entry.permissionEffect === 'block' && entry.state !== 'closed' && entry.state !== 'reinstated';
}

function uniqueReasons(reasons: readonly AffiliateComplianceReasonCode[]): readonly AffiliateComplianceReasonCode[] {
  return Object.freeze([...new Set(reasons)]);
}

function decisionExpiry(now: number, candidates: readonly (string | null)[]): string {
  const ceiling = now + 5 * 60_000;
  const expiries = candidates.map(parseInstant).filter((instant): instant is number => instant !== null && instant > now);
  return new Date(Math.min(ceiling, ...expiries)).toISOString();
}

function invalidDecision(knownPermission: boolean): AffiliateComplianceDecision {
  const reasonCode: AffiliateComplianceReasonCode = knownPermission ? 'EVIDENCE_INVALID' : 'UNKNOWN_PERMISSION';
  return Object.freeze({
    decision: 'deny',
    permission: 'affiliate_link.issue',
    workspaceId: ZERO_UUID,
    subjectId: ZERO_UUID,
    actionScopeSha256: ZERO_SHA256,
    evidenceSnapshotSha256: ZERO_SHA256,
    decisionNonceSha256: ZERO_SHA256,
    evaluatedAt: new Date(0).toISOString(),
    expiresAt: new Date(0).toISOString(),
    reasonCodes: Object.freeze([reasonCode]),
    nextAction: 'Refresh the exact evidence snapshot and request a new scoped decision.',
  });
}

/**
 * Sole product-domain eligibility evaluator. Every runtime value is deeply and
 * exactly validated before it can enter an allow path. The decision is bound to
 * one workspace, subject, action scope, evidence snapshot and one-use nonce.
 * This module never grants or owns provider capability.
 */
export function evaluateAffiliateCompliance(input: EvaluateAffiliateComplianceInput): AffiliateComplianceDecision {
  const validation = validateAffiliateComplianceInput(input);
  if (!validation.valid) return invalidDecision(validation.knownPermission);
  const safeInput = asValidatedAffiliateComplianceInput(input);
  const { permission, evidence } = safeInput;
  const now = Date.parse(safeInput.now);
  const reasons: AffiliateComplianceReasonCode[] = [];

  const pack = evidence.policyPack;
  if (!pack) reasons.push('POLICY_PACK_MISSING');
  if (pack) {
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
    if (acceptedAt === null || acceptedAt > now) reasons.push('EVIDENCE_INVALID');
    if (!currentUntil(acceptance.expiresAt, now)) reasons.push('ACCEPTANCE_EXPIRED');
  }
  if (!currentCapacity(evidence.capacity, now)) reasons.push('SIGNATORY_AUTHORITY_UNVERIFIED');

  const training = evidence.training;
  if (!training || training.status !== 'passed' || training.approvalState !== 'approved') reasons.push('TRAINING_MISSING');
  if (training?.status === 'passed') {
    const completedAt = parseInstant(training.completedAt);
    if (completedAt === null || completedAt > now) reasons.push('EVIDENCE_INVALID');
    if (!currentUntil(training.expiresAt, now, true)) reasons.push('TRAINING_EXPIRED');
  }

  if (!currentDeclaration(evidence.declarations.businessTax, now)) reasons.push('BUSINESS_TAX_DECLARATION_MISSING');
  if (!currentDeclaration(evidence.declarations.disclosureClaims, now)) reasons.push('DISCLOSURE_CLAIMS_ACKNOWLEDGEMENT_MISSING');
  if (!currentDeclaration(evidence.declarations.dataProtection, now)) reasons.push('DATA_PROTECTION_DECLARATION_MISSING');

  const lifecycleOccurredAt = parseInstant(evidence.lifecycle.occurredAt);
  if (lifecycleOccurredAt === null || lifecycleOccurredAt > now) reasons.push('EVIDENCE_INVALID');

  switch (evidence.lifecycle.state) {
    case 'active':
      break;
    case 'terminated':
      reasons.push('LIFECYCLE_TERMINATED');
      break;
    case 'withdrawn':
      reasons.push('LIFECYCLE_WITHDRAWN');
      break;
    case 'reacceptance_required':
      reasons.push('REACCEPTANCE_REQUIRED');
      break;
    case 'correction_required':
      reasons.push('CORRECTION_REQUIRED');
      break;
    case 'suspended_interim':
    case 'suspended_final':
      reasons.push('SUSPENSION_ACTIVE');
      break;
    default:
      reasons.push('LIFECYCLE_NOT_ELIGIBLE');
  }

  for (const entry of evidence.cases) {
    if (!activeBlockingCase(entry)) continue;
    if (entry.kind === 'reacceptance') reasons.push('REACCEPTANCE_REQUIRED');
    if (entry.kind === 'correction') reasons.push('CORRECTION_REQUIRED');
    if (entry.kind === 'suspension') reasons.push('SUSPENSION_ACTIVE');
    if (entry.kind === 'fraud') reasons.push('FRAUD_HOLD_ACTIVE');
    if (entry.kind === 'security') reasons.push('SECURITY_HOLD_ACTIVE');
  }

  if (evidence.permissionFacts.some((fact) => currentPermissionBlock(
    fact, permission, safeInput.actionScopeSha256, now,
  ))) reasons.push('PERMISSION_BLOCK_ACTIVE');

  let contentClassification: 'ordinary_product' | 'property_investment' | null = null;
  if (isContentPermission(permission)) contentClassification = currentContentClassification(safeInput, now);

  const requiredChannel = PERMISSION_CHANNEL[permission];
  const channelCurrent = evidence.channelAuthorities.some((authority) => currentChannel(
    authority, requiredChannel, requiredContentClass(permission, contentClassification),
    safeInput.actionScopeSha256, now,
  ));
  if (!channelCurrent) {
    reasons.push(permission === 'affiliate_link.issue' || permission === 'content.export_linked'
      ? 'PROMOTION_CHANNEL_NOT_APPROVED'
      : 'CHANNEL_AUTHORITY_MISSING');
  }

  if (isContentPermission(permission)) {
    if (contentClassification === null) reasons.push('CONTENT_CLASSIFICATION_MISSING');
    if (!currentEffect(evidence.effects.contentScopeApproval, 'content_scope_approval', safeInput.actionScopeSha256, now)) {
      reasons.push('CONTENT_SCOPE_NOT_APPROVED');
    }
    if (!currentEffect(evidence.effects.disclosureRenderedCheck, 'rendered_disclosure_check', safeInput.actionScopeSha256, now)) {
      reasons.push('DISCLOSURE_CHECK_MISSING');
    }
    if (!currentEffect(evidence.effects.claimEvidence, 'claim_evidence', safeInput.actionScopeSha256, now)) {
      reasons.push('CLAIM_EVIDENCE_MISSING');
    }
  }

  if (isRecipientPermission(permission)) {
    if (!currentEffect(evidence.effects.recipientRoute, 'recipient_route', safeInput.actionScopeSha256, now)) {
      reasons.push('RECIPIENT_ROUTE_MISSING');
    }
    if (!currentPecrRoute(evidence.specialistDecisions.pecrSenderRoute, 'pecr_sender_route', safeInput.actionScopeSha256, now)) {
      reasons.push('PECR_SENDER_ROUTE_MISSING');
    }
    if (!currentPecrRoute(evidence.specialistDecisions.pecrInstigatorRoute, 'pecr_instigator_route', safeInput.actionScopeSha256, now)) {
      reasons.push('PECR_INSTIGATOR_DECISION_MISSING');
    }
    if (!currentEffect(evidence.effects.suppression, 'suppression', safeInput.actionScopeSha256, now)) {
      reasons.push('SUPPRESSION_CHECK_FAILED');
    }
  }

  if ((permission === 'affiliate_recruitment.manual_publish'
      || permission === 'affiliate_recruitment.provider_publish')
      && !currentSpecialistDecision(
        evidence.specialistDecisions.affiliateRecruitmentPolicy,
        'affiliate_recruitment_policy', safeInput.actionScopeSha256, now,
      )) reasons.push('AFFILIATE_RECRUITMENT_POLICY_MISSING');

  if (contentClassification === 'property_investment') {
    if (!currentSpecialistDecision(
      evidence.specialistDecisions.financialPromotionPerimeter,
      'financial_promotion_perimeter', safeInput.actionScopeSha256, now,
    )) reasons.push('FINANCIAL_PROMOTION_PERIMETER_MISSING');
    if (!currentSpecialistDecision(
      evidence.specialistDecisions.consumerEligibilityReview,
      'consumer_eligibility_review', safeInput.actionScopeSha256, now,
    )) reasons.push('CONSUMER_ELIGIBILITY_REVIEW_MISSING');
  }

  if (permission === 'affiliate_attribution.write'
      && !currentEffect(evidence.effects.visitorChoice, 'visitor_choice', safeInput.actionScopeSha256, now)) {
    reasons.push('VISITOR_CHOICE_MISSING');
  }
  if (permission === 'commission.payout') {
    if (!currentEffect(evidence.effects.payoutChecks, 'payout_checks', safeInput.actionScopeSha256, now)) {
      reasons.push('PAYOUT_CHECKS_MISSING');
    }
    if (!currentSpecialistDecision(
      evidence.specialistDecisions.sanctionsScreening,
      'sanctions_screening', safeInput.actionScopeSha256, now, true,
    )) reasons.push('SANCTIONS_SCREENING_MISSING');
  }

  // Provider activation is deliberately outside this module and cannot be supplied as a caller boolean.
  if (isProviderEffectPermission(permission)) reasons.push('PROVIDER_EFFECTS_OFF');

  const reasonCodes = uniqueReasons(reasons);
  const expiries = [
    pack?.expiresAt ?? null,
    acceptance?.expiresAt ?? null,
    evidence.capacity?.expiresAt ?? null,
    training?.expiresAt ?? null,
    evidence.declarations.businessTax?.expiresAt ?? null,
    evidence.declarations.disclosureClaims?.expiresAt ?? null,
    evidence.declarations.dataProtection?.expiresAt ?? null,
    ...evidence.channelAuthorities.map((authority) => authority.validUntil),
    ...Object.values(evidence.specialistDecisions).map((decision) => decision?.expiresAt ?? null),
    ...Object.values(evidence.effects).flatMap((effect) => (
      typeof effect === 'object' && effect !== null && 'expiresAt' in effect ? [effect.expiresAt] : []
    )),
    ...evidence.permissionFacts.map((fact) => fact.validUntil),
  ];

  return Object.freeze({
    decision: reasonCodes.length === 0 ? 'allow' : 'deny',
    permission,
    workspaceId: safeInput.workspaceId,
    subjectId: safeInput.subjectId,
    actionScopeSha256: safeInput.actionScopeSha256,
    evidenceSnapshotSha256: evidence.evidenceSnapshotSha256,
    decisionNonceSha256: safeInput.decisionNonceSha256,
    evaluatedAt: new Date(now).toISOString(),
    expiresAt: decisionExpiry(now, expiries),
    reasonCodes,
    nextAction: reasonCodes.length === 0
      ? 'Permission is ready for one nonce-bound, short-lived server-side use; consume it atomically.'
      : NEXT_ACTIONS[reasonCodes[0]!] ?? 'Resolve the first blocked evidence gate and evaluate again.',
  });
}
