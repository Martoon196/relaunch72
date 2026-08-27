import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateAffiliateCompliance,
  type AffiliateComplianceEvidence,
  type AffiliateCompliancePermission,
} from '../src/affiliate-compliance-pg/index.js';

const NOW = '2026-08-27T12:00:00.000Z';
const FUTURE = '2027-08-27T12:00:00.000Z';
const SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function readyEvidence(): AffiliateComplianceEvidence {
  const declaration = Object.freeze({ status: 'current' as const, version: 'v1', evidenceSha256: SHA, expiresAt: FUTURE });
  const specialist = Object.freeze({ status: 'current' as const, decisionReference: 'specialist-decision-1', expiresAt: FUTURE });
  const pecr = Object.freeze({
    ...specialist,
    routeClassification: 'individual_consent' as const,
    partyReference: 'party-ref-1',
    responsibilityReference: 'responsibility-ref-1',
  });
  return Object.freeze({
    policyPack: Object.freeze({
      bundleId: 'bundle-v1', bundleVersion: '1.0.0', bundleSha256: SHA,
      legalApproval: 'approved', commercialApproval: 'approved', publication: 'published',
      effectiveAt: '2026-08-01T00:00:00.000Z', expiresAt: FUTURE,
    }),
    acceptance: Object.freeze({
      status: 'accepted', bundleId: 'bundle-v1', bundleSha256: SHA,
      acceptedAt: '2026-08-02T00:00:00.000Z', expiresAt: FUTURE,
      capacityVerified: true, reacceptanceRequired: false,
    }),
    training: Object.freeze({
      status: 'passed', completedAt: '2026-08-03T00:00:00.000Z', expiresAt: FUTURE,
      attestationSha256: SHA,
    }),
    declarations: Object.freeze({ businessTax: declaration, disclosureClaims: declaration, dataProtection: declaration }),
    channelAuthorities: Object.freeze([
      Object.freeze({ channel: 'public_social' as const, status: 'current' as const, validFrom: '2026-08-01T00:00:00.000Z', validUntil: FUTURE, evidenceSha256: SHA }),
      Object.freeze({ channel: 'affiliate_recruitment' as const, status: 'current' as const, validFrom: '2026-08-01T00:00:00.000Z', validUntil: FUTURE, evidenceSha256: SHA }),
      Object.freeze({ channel: 'email' as const, status: 'current' as const, validFrom: '2026-08-01T00:00:00.000Z', validUntil: FUTURE, evidenceSha256: SHA }),
      Object.freeze({ channel: 'tracking' as const, status: 'current' as const, validFrom: '2026-08-01T00:00:00.000Z', validUntil: FUTURE, evidenceSha256: SHA }),
      Object.freeze({ channel: 'payout' as const, status: 'current' as const, validFrom: '2026-08-01T00:00:00.000Z', validUntil: FUTURE, evidenceSha256: SHA }),
    ]),
    specialistDecisions: Object.freeze({
      pecrSenderRoute: pecr,
      pecrInstigatorRoute: pecr,
      affiliateRecruitmentPolicy: specialist,
      financialPromotionPerimeter: specialist,
      consumerEligibilityReview: specialist,
      sanctionsScreening: specialist,
    }),
    holds: Object.freeze([]),
    effects: Object.freeze({
      propertyInvestmentContent: false,
      contentApprovedForScope: true,
      disclosureRenderedAndChecked: true,
      claimEvidenceCurrent: true,
      recipientRouteCurrent: true,
      suppressionClear: true,
      visitorChoiceCurrent: true,
      payoutChecksCurrent: true,
      providerEffectsOn: true,
    }),
  });
}

function evaluate(permission: AffiliateCompliancePermission, evidence: AffiliateComplianceEvidence) {
  return evaluateAffiliateCompliance({ permission, now: NOW, evidence });
}

test('one central evaluator allows a short-lived link decision only when every general gate is current', () => {
  const decision = evaluate('affiliate_link.issue', readyEvidence());
  assert.equal(decision.decision, 'allow');
  assert.deepEqual(decision.reasonCodes, []);
  assert.equal(decision.expiresAt, '2026-08-27T12:05:00.000Z');
  assert.ok(Object.isFrozen(decision));
  assert.ok(Object.isFrozen(decision.reasonCodes));
});

test('every missing or stale general evidence class independently fails closed', () => {
  const ready = readyEvidence();
  const cases: readonly [AffiliateComplianceEvidence, string][] = [
    [{ ...ready, policyPack: null }, 'POLICY_PACK_MISSING'],
    [{ ...ready, policyPack: { ...ready.policyPack!, legalApproval: 'pending' } }, 'LEGAL_APPROVAL_MISSING'],
    [{ ...ready, policyPack: { ...ready.policyPack!, commercialApproval: 'pending' } }, 'COMMERCIAL_APPROVAL_MISSING'],
    [{ ...ready, policyPack: { ...ready.policyPack!, publication: 'draft' } }, 'POLICY_PACK_NOT_PUBLISHED'],
    [{ ...ready, acceptance: null }, 'ACCEPTANCE_MISSING'],
    [{ ...ready, acceptance: { ...ready.acceptance!, bundleSha256: 'b'.repeat(64) } }, 'ACCEPTANCE_BUNDLE_MISMATCH'],
    [{ ...ready, training: null }, 'TRAINING_MISSING'],
    [{ ...ready, declarations: { ...ready.declarations, businessTax: null } }, 'BUSINESS_TAX_DECLARATION_MISSING'],
    [{ ...ready, channelAuthorities: [] }, 'PROMOTION_CHANNEL_NOT_APPROVED'],
    [{ ...ready, holds: [{ kind: 'suspension', active: true, caseReference: 'case-1' }] }, 'SUSPENSION_ACTIVE'],
  ];
  for (const [evidence, expected] of cases) {
    const decision = evaluate('affiliate_link.issue', evidence);
    assert.equal(decision.decision, 'deny');
    assert.ok(decision.reasonCodes.includes(expected as never), expected);
  }
});

test('recipient electronic mail requires independent sender and instigator PECR route evidence', () => {
  const ready = readyEvidence();
  const missingSender = evaluate('email.send', {
    ...ready,
    specialistDecisions: { ...ready.specialistDecisions, pecrSenderRoute: null },
  });
  const unknownInstigator = evaluate('email.send', {
    ...ready,
    specialistDecisions: {
      ...ready.specialistDecisions,
      pecrInstigatorRoute: { ...ready.specialistDecisions.pecrInstigatorRoute!, routeClassification: 'unknown' },
    },
  });
  assert.ok(missingSender.reasonCodes.includes('PECR_SENDER_ROUTE_MISSING'));
  assert.ok(unknownInstigator.reasonCodes.includes('PECR_INSTIGATOR_DECISION_MISSING'));
  assert.equal(evaluate('email.send', { ...ready, effects: { ...ready.effects, providerEffectsOn: false } }).decision, 'deny');
});

test('affiliate recruitment has a distinct permission and cannot borrow ordinary product-content approval', () => {
  const ready = readyEvidence();
  const withoutRecruitmentDecision = {
    ...ready,
    specialistDecisions: { ...ready.specialistDecisions, affiliateRecruitmentPolicy: null },
  };
  assert.equal(evaluate('public_social.manual_publish', withoutRecruitmentDecision).decision, 'allow');
  const recruitment = evaluate('affiliate_recruitment.manual_publish', withoutRecruitmentDecision);
  assert.equal(recruitment.decision, 'deny');
  assert.ok(recruitment.reasonCodes.includes('AFFILIATE_RECRUITMENT_POLICY_MISSING'));
});

test('property/investment content and payout keep specialist decisions explicit', () => {
  const ready = readyEvidence();
  const content = evaluate('public_social.manual_publish', {
    ...ready,
    effects: { ...ready.effects, propertyInvestmentContent: true },
    specialistDecisions: {
      ...ready.specialistDecisions,
      financialPromotionPerimeter: null,
      consumerEligibilityReview: null,
    },
  });
  assert.ok(content.reasonCodes.includes('FINANCIAL_PROMOTION_PERIMETER_MISSING'));
  assert.ok(content.reasonCodes.includes('CONSUMER_ELIGIBILITY_REVIEW_MISSING'));

  const payout = evaluate('commission.payout', {
    ...ready,
    specialistDecisions: { ...ready.specialistDecisions, sanctionsScreening: null },
  });
  assert.ok(payout.reasonCodes.includes('SANCTIONS_SCREENING_MISSING'));
});

test('malformed time and runtime-unknown permission return a denial instead of throwing', () => {
  const evidence = readyEvidence();
  const malformed = evaluateAffiliateCompliance({ permission: 'affiliate_link.issue', now: 'later', evidence });
  assert.deepEqual(malformed.reasonCodes, ['EVIDENCE_INVALID']);
  const unknown = evaluateAffiliateCompliance({ permission: 'admin.override' as never, now: NOW, evidence });
  assert.deepEqual(unknown.reasonCodes, ['UNKNOWN_PERMISSION']);
  assert.equal(unknown.decision, 'deny');
});

test('malformed projected evidence identifiers, hashes and chronology deny every affected gate', () => {
  const ready = readyEvidence();
  const cases: readonly [AffiliateCompliancePermission, AffiliateComplianceEvidence, string][] = [
    ['affiliate_link.issue', {
      ...ready,
      acceptance: { ...ready.acceptance!, acceptedAt: 'not-an-instant' },
    }, 'EVIDENCE_INVALID'],
    ['affiliate_link.issue', {
      ...ready,
      acceptance: { ...ready.acceptance!, acceptedAt: FUTURE },
    }, 'EVIDENCE_INVALID'],
    ['affiliate_link.issue', {
      ...ready,
      training: { ...ready.training!, completedAt: null },
    }, 'EVIDENCE_INVALID'],
    ['affiliate_link.issue', {
      ...ready,
      training: { ...ready.training!, attestationSha256: 'blank' },
    }, 'EVIDENCE_INVALID'],
    ['affiliate_link.issue', {
      ...ready,
      channelAuthorities: ready.channelAuthorities.map((authority) => ({
        ...authority, validFrom: null,
      })),
    }, 'PROMOTION_CHANNEL_NOT_APPROVED'],
    ['email.send', {
      ...ready,
      channelAuthorities: ready.channelAuthorities.map((authority) => (
        authority.channel === 'email' ? { ...authority, evidenceSha256: '' } : authority
      )),
    }, 'CHANNEL_AUTHORITY_MISSING'],
    ['affiliate_recruitment.manual_publish', {
      ...ready,
      specialistDecisions: {
        ...ready.specialistDecisions,
        affiliateRecruitmentPolicy: {
          ...ready.specialistDecisions.affiliateRecruitmentPolicy!,
          decisionReference: '   ',
        },
      },
    }, 'AFFILIATE_RECRUITMENT_POLICY_MISSING'],
    ['commission.payout', {
      ...ready,
      specialistDecisions: {
        ...ready.specialistDecisions,
        sanctionsScreening: {
          ...ready.specialistDecisions.sanctionsScreening!,
          expiresAt: 'malformed',
        },
      },
    }, 'SANCTIONS_SCREENING_MISSING'],
    ['affiliate_link.issue', {
      ...ready,
      declarations: {
        ...ready.declarations,
        businessTax: { ...ready.declarations.businessTax!, evidenceSha256: '' },
      },
    }, 'BUSINESS_TAX_DECLARATION_MISSING'],
  ];
  for (const [permission, evidence, reason] of cases) {
    const decision = evaluate(permission, evidence);
    assert.equal(decision.decision, 'deny', reason);
    assert.ok(decision.reasonCodes.includes(reason as never), reason);
  }
});
