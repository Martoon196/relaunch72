import type {
  AffiliateComplianceEvidence,
  AffiliateDeclarationEvidence,
  AffiliateSpecialistDecisionEvidence,
} from '../affiliate-compliance-pg/types.js';
import type {
  PortalAffiliateComplianceDocument,
  PortalAffiliateComplianceSnapshot,
  PortalAffiliateComplianceSubject,
} from './affiliate-compliance-service.js';

const NOW = '2026-08-27T12:00:00.000Z';
const FUTURE = '2027-08-27T12:00:00.000Z';
// Reproducible illustrative bundle digest: SHA-256 of the seven exact document
// hashes below, in display order, joined with a single LF and no final LF.
const PACK_SHA = '739ce2b2d9b051a94fca79c622cd476934edb61c25dc207e89e6850e1d859ce6';

const DOCUMENTS: readonly PortalAffiliateComplianceDocument[] = Object.freeze([
  ['programme_agreement', 'Affiliate programme agreement', 'draft-1', '7d486fc05ec0c1087a18c49358e470b0c62be5d8e6623f894f5164a37b35fc5e'],
  ['marketing_policy', 'Marketing, disclosure and claims policy', 'draft-1', '6422d8a5f2debf141dbc3a2450636ab034a27bbbbdcea257bd5116c2bd9efc43'],
  ['data_addendum', 'Data protection and direct-marketing addendum', 'draft-1', '147cdffc5c7503e79b0e760dd142f672b4b9ebd5fdb51a2d206717954230a55d'],
  ['onboarding_declaration', 'Onboarding, tax and business declaration', 'draft-1', '57827798c31905d05313306b72b6ffcd27637d7dba824fe7999c57f42eb6654a'],
  ['breach_policy', 'Breach, takedown and suspension policy', 'draft-1', 'a73e97eb6727be94612af366eb178991ba45f03d8beb027814e29e8a72554500'],
  ['decision_register', 'Solicitor decision checklist and source register', 'draft-1', 'a6bf38fa524f252de8b1872c2e99d2c3b07df6ef73c8d9c0f5f6a1517ff2af05'],
  ['workflow_spec', 'Acceptance-evidence and product workflow specification', 'draft-1', 'd2ac780e9efb02ae55a0212e3db5096283ea854ae57fe7389d34071ee5bbd83d'],
].map(([documentType, title, version, contentSha256]) => Object.freeze({
  documentType: documentType!,
  title: title!,
  version: version!,
  contentSha256: contentSha256!,
  draftingStatus: 'draft_complete' as const,
  legalStatus: 'awaiting_solicitor_review' as const,
  commercialStatus: 'awaiting_legal_approval' as const,
  publicationStatus: 'not_published' as const,
})));

const CURRENT_DECLARATION: AffiliateDeclarationEvidence = Object.freeze({
  status: 'current',
  version: 'fixture-v1',
  evidenceSha256: '8888888888888888888888888888888888888888888888888888888888888888',
  expiresAt: FUTURE,
});

const MISSING_DECLARATION: AffiliateDeclarationEvidence = Object.freeze({
  status: 'missing', version: null, evidenceSha256: null, expiresAt: null,
});

const MISSING_SPECIALIST_DECISION: AffiliateSpecialistDecisionEvidence = Object.freeze({
  status: 'missing', decisionReference: null, expiresAt: null,
});

const MISSING_PECR_ROUTE = Object.freeze({
  ...MISSING_SPECIALIST_DECISION,
  routeClassification: 'unknown' as const,
  partyReference: null,
  responsibilityReference: null,
});

function evidence(input: Readonly<{
  acceptance: 'current' | 'missing';
  training: 'current' | 'missing' | 'expired';
  declarations: 'current' | 'missing';
  channels: readonly ('public_social' | 'email' | 'whatsapp' | 'social_dm')[];
  holds?: AffiliateComplianceEvidence['holds'];
}>): AffiliateComplianceEvidence {
  const declarations = input.declarations === 'current' ? CURRENT_DECLARATION : MISSING_DECLARATION;
  return Object.freeze({
    policyPack: Object.freeze({
      bundleId: 'policy-pack-draft-2026-08-27',
      bundleVersion: 'draft-1',
      bundleSha256: PACK_SHA,
      legalApproval: 'pending',
      commercialApproval: 'pending',
      publication: 'draft',
      effectiveAt: null,
      expiresAt: null,
    }),
    acceptance: input.acceptance === 'current' ? Object.freeze({
      status: 'accepted',
      bundleId: 'policy-pack-draft-2026-08-27',
      bundleSha256: PACK_SHA,
      acceptedAt: '2026-08-26T10:15:00.000Z',
      expiresAt: FUTURE,
      capacityVerified: true,
      reacceptanceRequired: false,
    }) : null,
    training: input.training === 'missing' ? null : Object.freeze({
      status: 'passed',
      completedAt: '2026-08-26T10:45:00.000Z',
      expiresAt: input.training === 'expired' ? '2026-08-26T10:45:00.000Z' : FUTURE,
      attestationSha256: '9999999999999999999999999999999999999999999999999999999999999999',
    }),
    declarations: Object.freeze({
      businessTax: declarations,
      disclosureClaims: declarations,
      dataProtection: declarations,
    }),
    channelAuthorities: Object.freeze(input.channels.map((channel, index) => Object.freeze({
      channel,
      status: 'current' as const,
      validFrom: '2026-08-26T11:00:00.000Z',
      validUntil: FUTURE,
      evidenceSha256: `${String(index + 10).padStart(2, '0')}`.repeat(32),
    }))),
    specialistDecisions: Object.freeze({
      pecrSenderRoute: MISSING_PECR_ROUTE,
      pecrInstigatorRoute: MISSING_PECR_ROUTE,
      affiliateRecruitmentPolicy: MISSING_SPECIALIST_DECISION,
      financialPromotionPerimeter: MISSING_SPECIALIST_DECISION,
      consumerEligibilityReview: MISSING_SPECIALIST_DECISION,
      sanctionsScreening: MISSING_SPECIALIST_DECISION,
    }),
    holds: Object.freeze([...(input.holds ?? [])]),
    effects: Object.freeze({
      propertyInvestmentContent: true,
      contentApprovedForScope: false,
      disclosureRenderedAndChecked: false,
      claimEvidenceCurrent: false,
      recipientRouteCurrent: false,
      suppressionClear: false,
      visitorChoiceCurrent: false,
      payoutChecksCurrent: false,
      providerEffectsOn: false,
    }),
  });
}

const SUBJECTS: readonly PortalAffiliateComplianceSubject[] = Object.freeze([
  Object.freeze({
    subjectId: 'ac100000-0000-4000-8000-000000000001',
    displayLabel: 'Fictional affiliate 01',
    fictional: true as const,
    lifecycleLabel: 'Evidence prepared · legal pack blocked',
    evidence: evidence({ acceptance: 'current', training: 'current', declarations: 'current', channels: ['public_social'] }),
    cases: Object.freeze([]),
    timeline: Object.freeze([
      Object.freeze({ eventId: 'timeline-a1', eventType: 'declaration.attested', label: 'Illustrative declarations recorded', occurredAt: '2026-08-26T11:00:00.000Z', evidenceSha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', previousEventId: 'timeline-a0' }),
      Object.freeze({ eventId: 'timeline-a0', eventType: 'training.passed', label: 'Illustrative training pass recorded', occurredAt: '2026-08-26T10:45:00.000Z', evidenceSha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', previousEventId: null }),
    ]),
  }),
  Object.freeze({
    subjectId: 'ac100000-0000-4000-8000-000000000002',
    displayLabel: 'Fictional legacy affiliate',
    fictional: true as const,
    lifecycleLabel: 'Migrated unverified · reacceptance required',
    evidence: evidence({
      acceptance: 'missing', training: 'missing', declarations: 'missing', channels: [],
      holds: Object.freeze([Object.freeze({ kind: 'reacceptance', active: true, caseReference: 'LEGACY-MIGRATION' })]),
    }),
    cases: Object.freeze([]),
    timeline: Object.freeze([
      Object.freeze({ eventId: 'timeline-b0', eventType: 'legacy.migrated_unverified', label: 'Illustrative legacy record quarantined', occurredAt: '2026-08-25T09:00:00.000Z', evidenceSha256: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc', previousEventId: null }),
    ]),
  }),
  Object.freeze({
    subjectId: 'ac100000-0000-4000-8000-000000000003',
    displayLabel: 'Fictional affiliate 03',
    fictional: true as const,
    lifecycleLabel: 'Interim suspension · correction open',
    evidence: evidence({
      acceptance: 'current', training: 'expired', declarations: 'current', channels: ['public_social', 'email'],
      holds: Object.freeze([
        Object.freeze({ kind: 'suspension', active: true, caseReference: 'DEMO-CASE-003' }),
        Object.freeze({ kind: 'correction', active: true, caseReference: 'DEMO-CASE-003' }),
      ]),
    }),
    cases: Object.freeze([Object.freeze({
      caseReference: 'DEMO-CASE-003',
      state: 'suspended_interim',
      severity: 'high',
      reasonLabel: 'Illustrative disclosure removed after final crop',
      openedAt: '2026-08-27T08:30:00.000Z',
      ownerRole: 'Compliance owner',
      blocksPermissions: true,
    })]),
    timeline: Object.freeze([
      Object.freeze({ eventId: 'timeline-c1', eventType: 'case.suspended_interim', label: 'Illustrative interim suspension recorded', occurredAt: '2026-08-27T08:35:00.000Z', evidenceSha256: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd', previousEventId: 'timeline-c0' }),
      Object.freeze({ eventId: 'timeline-c0', eventType: 'case.opened', label: 'Illustrative disclosure case opened', occurredAt: '2026-08-27T08:30:00.000Z', evidenceSha256: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', previousEventId: null }),
    ]),
  }),
]);

/** Synthetic workflow data only: no production IDs, people, links, commissions or provider state. */
export function createPropertyPredatorAffiliateComplianceFixture(): PortalAffiliateComplianceSnapshot {
  return Object.freeze({
    workspace: Object.freeze({
      workspaceId: 'ac200000-0000-4000-8000-000000000001',
      workspaceName: 'Property Predator Growth HQ',
      snapshotAt: NOW,
      canManage: true,
    }),
    programme: Object.freeze({
      programmeName: 'Property Predator affiliate programme',
      packVersion: 'draft-2026-08-27',
      bundleSha256: PACK_SHA,
      sourceCommit: '3405cc8',
      sourceCommitMeaning: 'drafting_provenance_only',
      solicitorApproved: false,
      published: false,
      externalEffects: false,
      documents: DOCUMENTS,
      openDecisions: Object.freeze([
        'Operator legal entity, agreement formation and affiliate signatory authority',
        'Commission, attribution, clawback, VAT, self-billing and digital-platform reporting',
        'Legacy-link treatment and reacceptance deadline',
        'Per-flow PECR instigator/responsibility decision for Operator-assisted sends',
        'CAP Section 20 affiliate-recruitment and one-level/team-reward classification',
        'CAP Section 14 plus FCA/FSMA perimeter approval for property, investment and returns content',
        'OFSI sanctions screening, ownership/control, rescreen, freeze and escalation route',
        'Tracking/cookie classification, controller roles, retention and international transfers',
      ]),
    }),
    subjects: SUBJECTS,
    dataset: 'illustrative_fixture',
  });
}
