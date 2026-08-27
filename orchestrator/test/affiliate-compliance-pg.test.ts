import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AFFILIATE_COMPLIANCE_CHANNELS,
  AFFILIATE_COMPLIANCE_EFFECT_KINDS,
  AFFILIATE_COMPLIANCE_LIFECYCLE_STATES,
  AFFILIATE_COMPLIANCE_PERMISSIONS,
  AFFILIATE_COMPLIANCE_REASON_CODES,
  AFFILIATE_SPECIALIST_DECISION_KINDS,
  evaluateAffiliateCompliance,
  type AffiliateComplianceChannel,
  type AffiliateComplianceEvidence,
  type AffiliateCompliancePermission,
  type EvaluateAffiliateComplianceInput,
} from '../src/affiliate-compliance-pg/index.js';

const NOW = '2026-08-27T12:00:00.000Z';
const FUTURE = '2027-08-27T12:00:00.000Z';
const WORKSPACE_ID = 'ad100000-0000-4000-8000-000000000001';
const SUBJECT_ID = 'ad200000-0000-4000-8000-000000000001';
const SCOPE_SHA = '1'.repeat(64);
const SNAPSHOT_SHA = '2'.repeat(64);
const NONCE_SHA = '3'.repeat(64);
const SHA = 'a'.repeat(64);

function contentClass(channel: AffiliateComplianceChannel) {
  if (channel === 'affiliate_recruitment') return 'affiliate_recruitment' as const;
  if (channel === 'tracking' || channel === 'payout' || channel === 'audience_upload' || channel === 'phone') {
    return 'operational_only' as const;
  }
  return 'ordinary_product' as const;
}

function readyEvidence(): AffiliateComplianceEvidence {
  const declaration = {
    status: 'current' as const,
    decision: 'affirmed' as const,
    version: 'v1',
    declarationSha256: SHA,
    evidenceSha256: SHA,
    occurredAt: '2026-08-03T00:00:00.000Z',
    expiresAt: FUTURE,
  };
  const specialist = (decisionKind: Exclude<(typeof AFFILIATE_SPECIALIST_DECISION_KINDS)[number], 'pecr_sender_route' | 'pecr_instigator_route'>) => ({
    status: 'current' as const,
    decisionKind,
    decision: 'approved' as const,
    decisionReference: `decision-${decisionKind}`,
    actionScopeSha256: SCOPE_SHA,
    validFrom: '2026-08-01T00:00:00.000Z',
    expiresAt: FUTURE,
  });
  const pecr = (decisionKind: 'pecr_sender_route' | 'pecr_instigator_route') => ({
    status: 'current' as const,
    decisionKind,
    decision: 'approved' as const,
    decisionReference: `decision-${decisionKind}`,
    actionScopeSha256: SCOPE_SHA,
    validFrom: '2026-08-01T00:00:00.000Z',
    expiresAt: FUTURE,
    routeClassification: 'individual_consent' as const,
    partyReference: `party-${decisionKind}`,
    responsibilityReference: `responsibility-${decisionKind}`,
  });
  const effect = (kind: 'content_scope_approval' | 'rendered_disclosure_check' | 'claim_evidence' | 'recipient_route' | 'suppression' | 'visitor_choice' | 'payout_checks') => ({
    kind,
    status: 'current' as const,
    decision: 'satisfied' as const,
    actionScopeSha256: SCOPE_SHA,
    evidenceSha256: SHA,
    validFrom: '2026-08-01T00:00:00.000Z',
    expiresAt: FUTURE,
  });

  return {
    workspaceId: WORKSPACE_ID,
    subjectId: SUBJECT_ID,
    evidenceSnapshotSha256: SNAPSHOT_SHA,
    policyPack: {
      bundleId: 'bundle-v1',
      bundleVersion: '1.0.0',
      bundleSha256: SHA,
      legalApproval: 'approved',
      commercialApproval: 'approved',
      publication: 'published',
      effectiveAt: '2026-08-01T00:00:00.000Z',
      expiresAt: FUTURE,
    },
    lifecycle: {
      state: 'active',
      occurredAt: '2026-08-02T00:00:00.000Z',
      evidenceSha256: SHA,
    },
    acceptance: {
      status: 'accepted',
      bundleId: 'bundle-v1',
      bundleSha256: SHA,
      acceptedAt: '2026-08-02T00:00:00.000Z',
      expiresAt: FUTURE,
    },
    capacity: {
      status: 'current',
      decision: 'verified',
      capacityReference: 'capacity-decision-v1',
      evidenceSha256: SHA,
      occurredAt: '2026-08-02T00:00:00.000Z',
      expiresAt: FUTURE,
    },
    training: {
      status: 'passed',
      trainingKey: 'affiliate_core',
      trainingVersion: 'v1',
      courseSha256: SHA,
      quizSha256: SHA,
      approvalState: 'approved',
      completedAt: '2026-08-03T00:00:00.000Z',
      expiresAt: FUTURE,
      attestationSha256: SHA,
    },
    declarations: {
      businessTax: declaration,
      disclosureClaims: { ...declaration },
      dataProtection: { ...declaration },
    },
    channelAuthorities: AFFILIATE_COMPLIANCE_CHANNELS.map((channel, index) => ({
      channel,
      status: 'current' as const,
      authorityState: 'approved' as const,
      contentClass: contentClass(channel),
      purposeCode: 'affiliate_marketing',
      territoryCode: 'GB',
      senderPartyReference: 'property-predator',
      accountScopeReference: `account-${index}`,
      actionScopeSha256: SCOPE_SHA,
      validFrom: '2026-08-01T00:00:00.000Z',
      validUntil: FUTURE,
      evidenceSha256: index.toString(16).padStart(64, '0'),
    })),
    specialistDecisions: {
      pecrSenderRoute: pecr('pecr_sender_route'),
      pecrInstigatorRoute: pecr('pecr_instigator_route'),
      affiliateRecruitmentPolicy: specialist('affiliate_recruitment_policy'),
      financialPromotionPerimeter: specialist('financial_promotion_perimeter'),
      consumerEligibilityReview: specialist('consumer_eligibility_review'),
      sanctionsScreening: specialist('sanctions_screening'),
    },
    cases: [],
    permissionFacts: [],
    effects: {
      contentClassification: {
        kind: 'content_classification',
        status: 'current',
        classification: 'ordinary_product',
        actionScopeSha256: SCOPE_SHA,
        evidenceSha256: SHA,
        validFrom: '2026-08-01T00:00:00.000Z',
        expiresAt: FUTURE,
      },
      contentScopeApproval: effect('content_scope_approval'),
      disclosureRenderedCheck: effect('rendered_disclosure_check'),
      claimEvidence: effect('claim_evidence'),
      recipientRoute: effect('recipient_route'),
      suppression: effect('suppression'),
      visitorChoice: effect('visitor_choice'),
      payoutChecks: effect('payout_checks'),
      providerEffects: 'off',
    },
  };
}

function input(permission: AffiliateCompliancePermission, evidence = readyEvidence()): EvaluateAffiliateComplianceInput {
  return {
    permission,
    workspaceId: WORKSPACE_ID,
    subjectId: SUBJECT_ID,
    actionScopeSha256: SCOPE_SHA,
    decisionNonceSha256: NONCE_SHA,
    now: NOW,
    evidence,
  };
}

function evaluate(permission: AffiliateCompliancePermission, evidence = readyEvidence()) {
  return evaluateAffiliateCompliance(input(permission, evidence));
}

function mutableEvidence(): any {
  return structuredClone(readyEvidence());
}

test('all exported compliance vocabularies are runtime-frozen and cannot manufacture admin.override', () => {
  for (const collection of [
    AFFILIATE_COMPLIANCE_PERMISSIONS,
    AFFILIATE_COMPLIANCE_CHANNELS,
    AFFILIATE_COMPLIANCE_LIFECYCLE_STATES,
    AFFILIATE_SPECIALIST_DECISION_KINDS,
    AFFILIATE_COMPLIANCE_EFFECT_KINDS,
    AFFILIATE_COMPLIANCE_REASON_CODES,
  ]) {
    assert.equal(Object.isFrozen(collection), true);
    assert.throws(() => (collection as unknown as string[]).push('admin.override'), TypeError);
  }
  const attacked = evaluateAffiliateCompliance({ ...input('affiliate_link.issue'), permission: 'admin.override' } as never);
  assert.equal(attacked.decision, 'deny');
  assert.deepEqual(attacked.reasonCodes, ['UNKNOWN_PERMISSION']);
});

test('a valid manual decision is short-lived and bound to the exact workspace, subject, scope, snapshot and nonce', () => {
  const decision = evaluate('affiliate_link.issue');
  assert.equal(decision.decision, 'allow');
  assert.deepEqual(decision.reasonCodes, []);
  assert.equal(decision.workspaceId, WORKSPACE_ID);
  assert.equal(decision.subjectId, SUBJECT_ID);
  assert.equal(decision.actionScopeSha256, SCOPE_SHA);
  assert.equal(decision.evidenceSnapshotSha256, SNAPSHOT_SHA);
  assert.equal(decision.decisionNonceSha256, NONCE_SHA);
  assert.equal(decision.expiresAt, '2026-08-27T12:05:00.000Z');
  assert.equal(Object.isFrozen(decision), true);
  assert.equal(Object.isFrozen(decision.reasonCodes), true);
});

test('exact validation rejects string/number boolean bypasses and structural surprises before allow', () => {
  const attacks: unknown[] = [];
  for (const value of ['false', 0, 1]) {
    const candidate = structuredClone(input('affiliate_link.issue')) as any;
    candidate.evidence.acceptance.capacityVerified = value;
    attacks.push(candidate);
  }
  const extraKey = structuredClone(input('affiliate_link.issue')) as any;
  extraKey['admin.override'] = true;
  attacks.push(extraKey);

  const getter = structuredClone(input('affiliate_link.issue')) as any;
  Object.defineProperty(getter.evidence.capacity, 'decision', {
    enumerable: true,
    get: () => 'verified',
  });
  attacks.push(getter);

  const prototype = structuredClone(input('affiliate_link.issue')) as any;
  Object.setPrototypeOf(prototype.evidence, { adminOverride: true });
  attacks.push(prototype);

  const proxyTarget = structuredClone(input('affiliate_link.issue'));
  attacks.push(new Proxy(proxyTarget, {}));

  const sparse = structuredClone(input('affiliate_link.issue')) as any;
  sparse.evidence.channelAuthorities = new Array(1);
  attacks.push(sparse);

  const wrongWorkspace = structuredClone(input('affiliate_link.issue')) as any;
  wrongWorkspace.evidence.workspaceId = 'ad100000-0000-4000-8000-000000000002';
  attacks.push(wrongWorkspace);

  for (const [index, attack] of attacks.entries()) {
    const decision = evaluateAffiliateCompliance(attack as never);
    assert.equal(decision.decision, 'deny');
    if (index < 3) assert.deepEqual(decision.reasonCodes, ['EVIDENCE_INVALID']);
    else assert.ok(decision.reasonCodes.includes('EVIDENCE_INVALID') || decision.reasonCodes.includes('UNKNOWN_PERMISSION'));
  }
});

test('general policy, acceptance, training, declaration and lifecycle states stay decisive', () => {
  const cases: readonly [AffiliateComplianceEvidence, string][] = [
    [{ ...readyEvidence(), policyPack: null }, 'POLICY_PACK_MISSING'],
    [{ ...readyEvidence(), policyPack: { ...readyEvidence().policyPack!, legalApproval: 'rejected' } }, 'LEGAL_APPROVAL_MISSING'],
    [{ ...readyEvidence(), policyPack: { ...readyEvidence().policyPack!, commercialApproval: 'withdrawn' } }, 'COMMERCIAL_APPROVAL_MISSING'],
    [{ ...readyEvidence(), policyPack: { ...readyEvidence().policyPack!, publication: 'superseded' } }, 'POLICY_PACK_NOT_PUBLISHED'],
    [{ ...readyEvidence(), acceptance: { ...readyEvidence().acceptance!, status: 'declined' } }, 'ACCEPTANCE_MISSING'],
    [{ ...readyEvidence(), acceptance: { ...readyEvidence().acceptance!, bundleSha256: 'b'.repeat(64) } }, 'ACCEPTANCE_BUNDLE_MISMATCH'],
    [{ ...readyEvidence(), capacity: { ...readyEvidence().capacity!, decision: 'blocked' } }, 'SIGNATORY_AUTHORITY_UNVERIFIED'],
    [{ ...readyEvidence(), training: { ...readyEvidence().training!, approvalState: 'blocked' } }, 'TRAINING_MISSING'],
    [{ ...readyEvidence(), declarations: { ...readyEvidence().declarations, businessTax: { ...readyEvidence().declarations.businessTax!, decision: 'declined' } } }, 'BUSINESS_TAX_DECLARATION_MISSING'],
    [{ ...readyEvidence(), lifecycle: { ...readyEvidence().lifecycle, state: 'terminated' } }, 'LIFECYCLE_TERMINATED'],
    [{ ...readyEvidence(), lifecycle: { ...readyEvidence().lifecycle, state: 'withdrawn' } }, 'LIFECYCLE_WITHDRAWN'],
  ];
  for (const [evidence, expected] of cases) {
    const decision = evaluate('affiliate_link.issue', evidence);
    assert.equal(decision.decision, 'deny', expected);
    assert.ok(decision.reasonCodes.includes(expected as never), expected);
  }
});

test('blocked, expired and wrong-scope channel, specialist, case and permission evidence cannot allow', () => {
  const blockedChannel = mutableEvidence();
  blockedChannel.channelAuthorities = blockedChannel.channelAuthorities.map((authority: AffiliateComplianceEvidence['channelAuthorities'][number]) => (
    authority.channel === 'affiliate_link' ? { ...authority, authorityState: 'blocked' } : authority
  ));
  assert.ok(evaluate('affiliate_link.issue', blockedChannel).reasonCodes.includes('PROMOTION_CHANNEL_NOT_APPROVED'));

  const wrongScope = mutableEvidence();
  wrongScope.channelAuthorities = wrongScope.channelAuthorities.map((authority: AffiliateComplianceEvidence['channelAuthorities'][number]) => (
    authority.channel === 'affiliate_link' ? { ...authority, actionScopeSha256: '4'.repeat(64) } : authority
  ));
  assert.ok(evaluate('affiliate_link.issue', wrongScope).reasonCodes.includes('PROMOTION_CHANNEL_NOT_APPROVED'));

  const blockedRecruitment = mutableEvidence();
  blockedRecruitment.specialistDecisions.affiliateRecruitmentPolicy = {
    ...blockedRecruitment.specialistDecisions.affiliateRecruitmentPolicy!, decision: 'blocked',
  };
  assert.ok(evaluate('affiliate_recruitment.manual_publish', blockedRecruitment).reasonCodes.includes('AFFILIATE_RECRUITMENT_POLICY_MISSING'));

  const openCase = mutableEvidence();
  openCase.cases = [{
    kind: 'fraud', state: 'opened', permissionEffect: 'block', caseReference: 'CASE-001',
    occurredAt: NOW, evidenceSha256: SHA,
  }];
  assert.ok(evaluate('affiliate_link.issue', openCase).reasonCodes.includes('FRAUD_HOLD_ACTIVE'));

  const permissionBlock = mutableEvidence();
  permissionBlock.permissionFacts = [{
    permission: 'affiliate_link.issue', state: 'blocked', actionScopeSha256: SCOPE_SHA,
    validFrom: NOW, validUntil: FUTURE, evidenceSha256: SHA,
  }];
  assert.ok(evaluate('affiliate_link.issue', permissionBlock).reasonCodes.includes('PERMISSION_BLOCK_ACTIVE'));
});

test('PECR sender and instigator, CAP 20, CAP 14/FCA/FSMA, consumer status and OFSI remain independent', () => {
  const missingSender = mutableEvidence();
  missingSender.specialistDecisions.pecrSenderRoute = null;
  assert.ok(evaluate('email.send', missingSender).reasonCodes.includes('PECR_SENDER_ROUTE_MISSING'));

  const missingInstigator = mutableEvidence();
  missingInstigator.specialistDecisions.pecrInstigatorRoute = null;
  assert.ok(evaluate('email.send', missingInstigator).reasonCodes.includes('PECR_INSTIGATOR_DECISION_MISSING'));

  const noCap20 = mutableEvidence();
  noCap20.specialistDecisions.affiliateRecruitmentPolicy = null;
  assert.equal(evaluate('public_social.manual_publish', noCap20).decision, 'allow');
  assert.ok(evaluate('affiliate_recruitment.manual_publish', noCap20).reasonCodes.includes('AFFILIATE_RECRUITMENT_POLICY_MISSING'));

  const property = mutableEvidence();
  property.effects.contentClassification = { ...property.effects.contentClassification!, classification: 'property_investment' };
  property.channelAuthorities = property.channelAuthorities.map((authority: AffiliateComplianceEvidence['channelAuthorities'][number]) => (
    authority.channel === 'public_social' ? { ...authority, contentClass: 'property_investment' } : authority
  ));
  property.specialistDecisions.financialPromotionPerimeter = null;
  property.specialistDecisions.consumerEligibilityReview = null;
  const propertyDecision = evaluate('public_social.manual_publish', property);
  assert.ok(propertyDecision.reasonCodes.includes('FINANCIAL_PROMOTION_PERIMETER_MISSING'));
  assert.ok(propertyDecision.reasonCodes.includes('CONSUMER_ELIGIBILITY_REVIEW_MISSING'));

  const staleSanctions = mutableEvidence();
  staleSanctions.specialistDecisions.sanctionsScreening = {
    ...staleSanctions.specialistDecisions.sanctionsScreening!, expiresAt: null,
  };
  assert.ok(evaluate('commission.payout', staleSanctions).reasonCodes.includes('SANCTIONS_SCREENING_MISSING'));
});

test('every provider-effect permission remains denied without manufacturing provider capability', () => {
  const providerPermissions: readonly AffiliateCompliancePermission[] = [
    'public_social.provider_publish', 'affiliate_recruitment.provider_publish',
    'email.send', 'sms.send', 'whatsapp.send', 'social_dm.send', 'audience.upload',
    'paid_ads.launch', 'phone.marketing', 'commission.payout',
  ];
  for (const permission of providerPermissions) {
    const decision = evaluate(permission);
    assert.equal(decision.decision, 'deny', permission);
    assert.ok(decision.reasonCodes.includes('PROVIDER_EFFECTS_OFF'), permission);
  }
});

test('malformed canonical values return a denial instead of throwing', () => {
  for (const patch of [
    { now: 'later' },
    { actionScopeSha256: 'not-a-digest' },
    { decisionNonceSha256: '4'.repeat(65) },
  ]) {
    const decision = evaluateAffiliateCompliance({ ...input('affiliate_link.issue'), ...patch } as never);
    assert.equal(decision.decision, 'deny');
    assert.deepEqual(decision.reasonCodes, ['EVIDENCE_INVALID']);
  }
});
