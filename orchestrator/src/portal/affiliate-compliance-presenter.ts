import {
  evaluateAffiliateCompliance,
  type AffiliateComplianceDecision,
  type AffiliateCompliancePermission,
  type AffiliateComplianceReasonCode,
} from '../affiliate-compliance-pg/index.js';
import type {
  PortalAffiliateComplianceCase,
  PortalAffiliateComplianceSnapshot,
  PortalAffiliateComplianceTimelineEvent,
} from './affiliate-compliance-service.js';

export const AFFILIATE_COMPLIANCE_ROUTE = '/portal/affiliates/compliance' as const;

const SHA256 = /^[0-9a-f]{64}$/u;
const DISPLAY_PERMISSIONS: readonly AffiliateCompliancePermission[] = Object.freeze([
  'affiliate_link.issue',
  'public_social.manual_publish',
  'affiliate_recruitment.manual_publish',
  'email.send',
  'whatsapp.send',
  'social_dm.send',
  'affiliate_attribution.write',
  'commission.payout',
]);

const REASON_LABELS: Readonly<Record<AffiliateComplianceReasonCode, string>> = Object.freeze({
  UNKNOWN_PERMISSION: 'Unknown permission',
  EVIDENCE_INVALID: 'Evidence could not be verified',
  POLICY_PACK_MISSING: 'No policy pack',
  LEGAL_APPROVAL_MISSING: 'Solicitor approval missing',
  COMMERCIAL_APPROVAL_MISSING: 'Commercial approval missing',
  POLICY_PACK_NOT_PUBLISHED: 'Policy pack not published',
  POLICY_PACK_NOT_EFFECTIVE: 'No effective pack',
  POLICY_PACK_EXPIRED: 'Policy pack expired',
  ACCEPTANCE_MISSING: 'Current acceptance missing',
  ACCEPTANCE_BUNDLE_MISMATCH: 'Acceptance is for another pack',
  ACCEPTANCE_EXPIRED: 'Acceptance expired',
  SIGNATORY_AUTHORITY_UNVERIFIED: 'Signatory authority unverified',
  REACCEPTANCE_REQUIRED: 'Reacceptance required',
  TRAINING_MISSING: 'Training pass missing',
  TRAINING_EXPIRED: 'Training expired',
  BUSINESS_TAX_DECLARATION_MISSING: 'Business and tax declaration missing',
  DISCLOSURE_CLAIMS_ACKNOWLEDGEMENT_MISSING: 'Disclosure and claims acknowledgement missing',
  DATA_PROTECTION_DECLARATION_MISSING: 'Data-protection declaration missing',
  PROMOTION_CHANNEL_NOT_APPROVED: 'No promotion channel approved',
  CHANNEL_AUTHORITY_MISSING: 'Channel authority missing',
  CONTENT_SCOPE_NOT_APPROVED: 'Content scope not approved',
  DISCLOSURE_CHECK_MISSING: 'Rendered disclosure check missing',
  CLAIM_EVIDENCE_MISSING: 'Claim evidence missing',
  RECIPIENT_ROUTE_MISSING: 'Recipient marketing route missing',
  PECR_SENDER_ROUTE_MISSING: 'PECR sender route missing',
  PECR_INSTIGATOR_DECISION_MISSING: 'Operator PECR responsibility decision missing',
  AFFILIATE_RECRUITMENT_POLICY_MISSING: 'Affiliate-recruitment policy gate missing',
  FINANCIAL_PROMOTION_PERIMETER_MISSING: 'CAP 14 / FCA perimeter decision missing',
  CONSUMER_ELIGIBILITY_REVIEW_MISSING: 'Consumer eligibility review missing',
  SANCTIONS_SCREENING_MISSING: 'OFSI screening decision missing',
  SUPPRESSION_CHECK_FAILED: 'Suppression check not clear',
  VISITOR_CHOICE_MISSING: 'Visitor tracking choice missing',
  PAYOUT_CHECKS_MISSING: 'Payout checks missing',
  PROVIDER_EFFECTS_OFF: 'External effects off',
  CORRECTION_REQUIRED: 'Correction required',
  SUSPENSION_ACTIVE: 'Suspension active',
  FRAUD_HOLD_ACTIVE: 'Fraud hold active',
  SECURITY_HOLD_ACTIVE: 'Security hold active',
});

const REASON_OWNERS: Readonly<Partial<Record<AffiliateComplianceReasonCode, string>>> = Object.freeze({
  LEGAL_APPROVAL_MISSING: 'Solicitor',
  COMMERCIAL_APPROVAL_MISSING: 'Programme owner',
  POLICY_PACK_NOT_PUBLISHED: 'Legal + programme owners',
  ACCEPTANCE_MISSING: 'Affiliate',
  ACCEPTANCE_BUNDLE_MISMATCH: 'Affiliate',
  ACCEPTANCE_EXPIRED: 'Affiliate',
  SIGNATORY_AUTHORITY_UNVERIFIED: 'Compliance owner',
  TRAINING_MISSING: 'Affiliate',
  TRAINING_EXPIRED: 'Affiliate',
  BUSINESS_TAX_DECLARATION_MISSING: 'Affiliate + finance',
  DISCLOSURE_CLAIMS_ACKNOWLEDGEMENT_MISSING: 'Affiliate',
  DATA_PROTECTION_DECLARATION_MISSING: 'Affiliate + privacy owner',
  CHANNEL_AUTHORITY_MISSING: 'Channel owner',
  PECR_INSTIGATOR_DECISION_MISSING: 'Solicitor + privacy owner',
  PECR_SENDER_ROUTE_MISSING: 'Solicitor + privacy owner',
  AFFILIATE_RECRUITMENT_POLICY_MISSING: 'Solicitor + CAP reviewer',
  FINANCIAL_PROMOTION_PERIMETER_MISSING: 'Solicitor + FCA specialist',
  CONSUMER_ELIGIBILITY_REVIEW_MISSING: 'Solicitor + customer-outcomes owner',
  SANCTIONS_SCREENING_MISSING: 'Finance + sanctions owner',
  PROVIDER_EFFECTS_OFF: 'Founder activation owner',
  SUSPENSION_ACTIVE: 'Compliance owner',
  CORRECTION_REQUIRED: 'Affiliate + compliance owner',
});

export interface AffiliateComplianceGateView {
  readonly gateId: string;
  readonly label: string;
  readonly stateLabel: string;
  readonly detail: string;
  readonly tone: 'pass' | 'wait' | 'blocked';
  readonly passes: boolean;
}

export interface AffiliateComplianceDocumentView {
  readonly documentType: string;
  readonly title: string;
  readonly version: string;
  readonly digestLabel: string;
  readonly draftingLabel: string;
  readonly legalLabel: string;
  readonly commercialLabel: string;
  readonly publicationLabel: string;
}

export interface AffiliatePermissionView {
  readonly permission: AffiliateCompliancePermission;
  readonly label: string;
  readonly decision: 'allow' | 'deny';
  readonly stateLabel: 'Eligible' | 'Blocked';
  readonly reasonLabels: readonly string[];
  readonly firstReason: AffiliateComplianceReasonCode | null;
}

export interface AffiliateWhyBlockedView {
  readonly evidenceGap: string;
  readonly remediation: string;
  readonly owner: string;
  readonly noOverride: string;
}

export interface AffiliateComplianceSubjectView {
  readonly subjectId: string;
  readonly displayLabel: string;
  readonly fictional: true;
  readonly lifecycleLabel: string;
  readonly overallLabel: 'Blocked';
  readonly permissions: readonly AffiliatePermissionView[];
  readonly whyBlocked: AffiliateWhyBlockedView;
  readonly cases: readonly PortalAffiliateComplianceCase[];
  readonly timeline: readonly PortalAffiliateComplianceTimelineEvent[];
  readonly currentChannelLabels: readonly string[];
  readonly acceptanceLabel: string;
  readonly trainingLabel: string;
  readonly declarationLabel: string;
}

export interface AffiliateComplianceView {
  readonly workspaceName: string;
  readonly asOf: string;
  readonly fictionalDemo: true;
  readonly externalEffectsOff: true;
  readonly sourceCommit: string;
  readonly sourceCommitLabel: 'Draft provenance only';
  readonly packVersion: string;
  readonly packDigestLabel: string;
  readonly documents: readonly AffiliateComplianceDocumentView[];
  readonly gates: readonly AffiliateComplianceGateView[];
  readonly subjects: readonly AffiliateComplianceSubjectView[];
  readonly openDecisions: readonly string[];
  readonly metrics: Readonly<{
    documentCount: number;
    solicitorApprovedCount: number;
    publishedCount: number;
    fictionalSubjectCount: number;
    blockedSubjectCount: number;
    openCaseCount: number;
  }>;
  readonly workflow: readonly Readonly<{ label: string; detail: string; state: 'current' | 'future' | 'blocked' }>[];
}

export class AffiliateCompliancePresentationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AffiliateCompliancePresentationError';
  }
}

function bounded(value: unknown, fallback: string, maximum = 240): string {
  if (typeof value !== 'string') return fallback;
  const text = value.trim().replace(/[\u0000-\u001f\u007f]/gu, ' ');
  return [...text].slice(0, maximum).join('') || fallback;
}

function instant(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

function digest(value: unknown): string {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new AffiliateCompliancePresentationError('Compliance evidence contains an invalid digest');
  }
  return `${value.slice(0, 12)}…${value.slice(-8)}`;
}

function permissionLabel(permission: AffiliateCompliancePermission): string {
  return ({
    'affiliate_link.issue': 'Create or copy affiliate link',
    'content.export_linked': 'Export linked content',
    'public_social.manual_publish': 'Manual public social',
    'public_social.provider_publish': 'Provider social publish',
    'affiliate_recruitment.manual_publish': 'Affiliate recruitment content',
    'affiliate_recruitment.provider_publish': 'Provider affiliate recruitment',
    'email.send': 'Email',
    'sms.send': 'SMS',
    'whatsapp.send': 'WhatsApp',
    'social_dm.send': 'Social DM',
    'audience.upload': 'Audience upload',
    'paid_ads.launch': 'Paid ads',
    'phone.marketing': 'Marketing calls',
    'affiliate_attribution.write': 'Attribution tracking',
    'commission.payout': 'Commission payout',
  } satisfies Record<AffiliateCompliancePermission, string>)[permission];
}

function permissionView(decision: AffiliateComplianceDecision): AffiliatePermissionView {
  return Object.freeze({
    permission: decision.permission,
    label: permissionLabel(decision.permission),
    decision: decision.decision,
    stateLabel: decision.decision === 'allow' ? 'Eligible' : 'Blocked',
    reasonLabels: Object.freeze(decision.reasonCodes.slice(0, 4).map((reason) => REASON_LABELS[reason])),
    firstReason: decision.reasonCodes[0] ?? null,
  });
}

function whyBlocked(decision: AffiliateComplianceDecision): AffiliateWhyBlockedView {
  const reason = decision.reasonCodes[0] ?? 'EVIDENCE_INVALID';
  return Object.freeze({
    evidenceGap: REASON_LABELS[reason],
    remediation: decision.nextAction,
    owner: REASON_OWNERS[reason] ?? 'Compliance owner',
    noOverride: 'No administrator shortcut can turn missing legal, consent, suppression or specialist evidence into permission.',
  });
}

function subjectView(
  subject: PortalAffiliateComplianceSnapshot['subjects'][number],
  now: string,
): AffiliateComplianceSubjectView {
  if (subject.fictional !== true) {
    throw new AffiliateCompliancePresentationError('Only fictional compliance fixtures may enter this surface');
  }
  const decisions = DISPLAY_PERMISSIONS.map((permission) => evaluateAffiliateCompliance({
    permission,
    now,
    evidence: subject.evidence,
  }));
  if (decisions.some((decision) => decision.decision !== 'deny')) {
    throw new AffiliateCompliancePresentationError('Fixture compliance must remain fail-closed');
  }
  const primary = decisions[0]!;
  const channels = subject.evidence.channelAuthorities
    .filter((authority) => authority.status === 'current')
    .map((authority) => bounded(authority.channel, 'Unknown channel', 80).replaceAll('_', ' '));
  const declarations = Object.values(subject.evidence.declarations);
  return Object.freeze({
    subjectId: bounded(subject.subjectId, 'fixture-subject', 100),
    displayLabel: bounded(subject.displayLabel, 'Fictional affiliate', 160),
    fictional: true,
    lifecycleLabel: bounded(subject.lifecycleLabel, 'Evidence incomplete', 200),
    overallLabel: 'Blocked',
    permissions: Object.freeze(decisions.map(permissionView)),
    whyBlocked: whyBlocked(primary),
    cases: Object.freeze(subject.cases.slice(0, 20).map((entry) => Object.freeze({
      caseReference: bounded(entry.caseReference, 'case', 100),
      state: entry.state,
      severity: entry.severity,
      reasonLabel: bounded(entry.reasonLabel, 'Compliance case', 240),
      openedAt: instant(entry.openedAt, now),
      ownerRole: bounded(entry.ownerRole, 'Compliance owner', 120),
      blocksPermissions: entry.blocksPermissions === true,
    }))),
    timeline: Object.freeze(subject.timeline.slice(0, 30).map((entry) => Object.freeze({
      eventId: bounded(entry.eventId, 'event', 100),
      eventType: bounded(entry.eventType, 'evidence.event', 100),
      label: bounded(entry.label, 'Evidence event', 240),
      occurredAt: instant(entry.occurredAt, now),
      evidenceSha256: digest(entry.evidenceSha256),
      previousEventId: entry.previousEventId ? bounded(entry.previousEventId, 'event', 100) : null,
    }))),
    currentChannelLabels: Object.freeze(channels),
    acceptanceLabel: subject.evidence.acceptance?.status === 'accepted'
      ? 'Illustrative acceptance recorded · not valid for an unpublished draft'
      : 'Current acceptance missing',
    trainingLabel: subject.evidence.training?.status === 'passed'
      ? (Date.parse(subject.evidence.training.expiresAt ?? '') > Date.parse(now) ? 'Training pass current' : 'Training expired')
      : 'Training pass missing',
    declarationLabel: declarations.every((entry) => entry?.status === 'current')
      ? 'Three declarations current' : 'Declarations incomplete',
  });
}

export function presentAffiliateCompliance(
  snapshot: PortalAffiliateComplianceSnapshot,
): AffiliateComplianceView {
  if (snapshot.dataset !== 'illustrative_fixture'
      || snapshot.programme.externalEffects !== false
      || snapshot.programme.solicitorApproved !== false
      || snapshot.programme.published !== false
      || snapshot.programme.sourceCommitMeaning !== 'drafting_provenance_only') {
    throw new AffiliateCompliancePresentationError('Affiliate compliance preview crossed its fixture-only boundary');
  }
  const asOf = instant(snapshot.workspace.snapshotAt, '1970-01-01T00:00:00.000Z');
  const documents = Object.freeze(snapshot.programme.documents.slice(0, 20).map((document) => Object.freeze({
    documentType: bounded(document.documentType, 'document', 100),
    title: bounded(document.title, 'Untitled document', 200),
    version: bounded(document.version, 'unversioned', 100),
    digestLabel: digest(document.contentSha256),
    draftingLabel: document.draftingStatus === 'draft_complete' ? 'Draft complete' : 'Draft unavailable',
    legalLabel: document.legalStatus === 'approved' ? 'Solicitor approved' : document.legalStatus === 'rejected' ? 'Legal rejected' : 'Awaiting solicitor',
    commercialLabel: document.commercialStatus === 'approved' ? 'Commercial approved' : document.commercialStatus === 'rejected' ? 'Commercial rejected' : 'Waiting on legal',
    publicationLabel: document.publicationStatus === 'published' ? 'Published' : document.publicationStatus === 'withdrawn' ? 'Withdrawn' : 'Not published',
  })));
  const subjects = Object.freeze(snapshot.subjects.slice(0, 100).map((subject) => subjectView(subject, asOf)));
  const solicitorApprovedCount = snapshot.programme.documents.filter((document) => document.legalStatus === 'approved').length;
  const publishedCount = snapshot.programme.documents.filter((document) => document.publicationStatus === 'published').length;
  const gates: readonly AffiliateComplianceGateView[] = Object.freeze([
    Object.freeze({ gateId: 'drafting', label: 'Drafting', stateLabel: 'Complete', detail: 'Seven draft documents are hash-addressed and ready for professional review.', tone: 'pass', passes: true }),
    Object.freeze({ gateId: 'legal', label: 'Solicitor approval', stateLabel: 'Not approved', detail: 'A commit proves drafting provenance only. It is not legal approval.', tone: 'blocked', passes: false }),
    Object.freeze({ gateId: 'commercial', label: 'Commercial approval', stateLabel: 'Waiting on legal', detail: 'Commercial choices remain placeholders until legal review returns.', tone: 'wait', passes: false }),
    Object.freeze({ gateId: 'publication', label: 'Publication', stateLabel: 'Not published', detail: 'No effective policy bundle exists for affiliate acceptance.', tone: 'blocked', passes: false }),
    Object.freeze({ gateId: 'acceptance', label: 'Affiliate acceptance', stateLabel: 'Cannot be current', detail: 'No click acceptance can validate an unpublished draft bundle.', tone: 'blocked', passes: false }),
    Object.freeze({ gateId: 'permissions', label: 'Links and channels', stateLabel: 'All blocked', detail: 'No link, send, post, DM, tracking or payout eligibility is available.', tone: 'blocked', passes: false }),
  ]);
  return Object.freeze({
    workspaceName: bounded(snapshot.workspace.workspaceName, 'Property Predator Growth HQ', 200),
    asOf,
    fictionalDemo: true,
    externalEffectsOff: true,
    sourceCommit: bounded(snapshot.programme.sourceCommit, 'unavailable', 80),
    sourceCommitLabel: 'Draft provenance only',
    packVersion: bounded(snapshot.programme.packVersion, 'draft', 100),
    packDigestLabel: digest(snapshot.programme.bundleSha256),
    documents,
    gates,
    subjects,
    openDecisions: Object.freeze(snapshot.programme.openDecisions.slice(0, 30).map((decision) => bounded(decision, 'Open decision', 320))),
    metrics: Object.freeze({
      documentCount: documents.length,
      solicitorApprovedCount,
      publishedCount,
      fictionalSubjectCount: subjects.length,
      blockedSubjectCount: subjects.length,
      openCaseCount: subjects.reduce((count, subject) => count + subject.cases.filter((entry) => entry.state !== 'closed').length, 0),
    }),
    workflow: Object.freeze([
      Object.freeze({ label: 'Draft', detail: 'Exact, versioned documents and source register prepared.', state: 'current' as const }),
      Object.freeze({ label: 'Solicitor review', detail: 'Professional review and scoped decisions recorded against exact hashes.', state: 'blocked' as const }),
      Object.freeze({ label: 'Commercial approval', detail: 'Commission, attribution, tax, payout and operating choices accepted.', state: 'future' as const }),
      Object.freeze({ label: 'Publish', detail: 'Approved bundle receives a version, effective date and durable copy.', state: 'future' as const }),
      Object.freeze({ label: 'Accept + train', detail: 'Affiliate accepts the exact pack, passes training and makes declarations.', state: 'future' as const }),
      Object.freeze({ label: 'Verify channel', detail: 'Purpose, territory, sender, audience and specialist decisions are verified.', state: 'future' as const }),
      Object.freeze({ label: 'Short-lived eligibility', detail: 'The server evaluates one permission at the last responsible moment.', state: 'future' as const }),
    ]),
  });
}
