import { types as utilTypes } from 'node:util';
import type {
  AffiliateComplianceChannel,
  AffiliateCompliancePermission,
  AffiliateSpecialistDecisionKind,
  EvaluateAffiliateComplianceInput,
} from './types.js';

type DataRecord = Record<string, unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const OPAQUE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const LOWER_CODE = /^[a-z][a-z0-9_-]{0,99}$/u;
const TERRITORY = /^[A-Z]{2}(?:-[A-Z0-9]{1,3})?$/u;
const CASE_REFERENCE = /^[A-Z0-9][A-Z0-9._-]{0,99}$/u;
const CANONICAL_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function dataRecord(value: unknown, expectedKeys: readonly string[]): DataRecord | null {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value) || utilTypes.isProxy(value)) return null;
    if (Object.getPrototypeOf(value) !== Object.prototype) return null;
    if (Object.getOwnPropertySymbols(value).length !== 0) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const actualKeys = Object.keys(descriptors).sort();
    const wantedKeys = [...expectedKeys].sort();
    if (actualKeys.length !== wantedKeys.length
        || actualKeys.some((key, index) => key !== wantedKeys[index])) return null;
    const output: DataRecord = {};
    for (const key of wantedKeys) {
      const descriptor = descriptors[key];
      if (!descriptor || !('value' in descriptor) || descriptor.get || descriptor.set || !descriptor.enumerable) return null;
      output[key] = descriptor.value;
    }
    return output;
  } catch {
    return null;
  }
}

function dataArray(value: unknown, maximum: number): readonly unknown[] | null {
  try {
    if (!Array.isArray(value) || utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
    if (Object.getOwnPropertySymbols(value).length !== 0) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (!lengthDescriptor || !('value' in lengthDescriptor)) return null;
    const lengthValue = lengthDescriptor.value;
    if (typeof lengthValue !== 'number' || !Number.isInteger(lengthValue)
        || lengthValue < 0 || lengthValue > maximum) return null;
    const length = lengthValue;
    const names = Object.keys(descriptors);
    if (names.length !== length + 1) return null;
    const output: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !('value' in descriptor) || descriptor.get || descriptor.set || !descriptor.enumerable) return null;
      output.push(descriptor.value);
    }
    return output;
  } catch {
    return null;
  }
}

function oneOf(value: unknown, options: readonly string[]): value is string {
  return typeof value === 'string' && options.includes(value);
}

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === 'string'
    && value.length >= 1
    && [...value].length <= maximum
    && value === value.trim()
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function nullable(value: unknown, predicate: (candidate: unknown) => boolean): boolean {
  return value === null || predicate(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256.test(value);
}

function isOpaqueReference(value: unknown): value is string {
  return typeof value === 'string' && OPAQUE_REFERENCE.test(value);
}

function isLowerCode(value: unknown): value is string {
  return typeof value === 'string' && LOWER_CODE.test(value);
}

function isInstant(value: unknown): value is string {
  if (typeof value !== 'string' || !CANONICAL_INSTANT.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

/** Private switch authority: exported arrays are presentation contracts, never evaluator authority. */
export function isCanonicalAffiliatePermission(value: unknown): value is AffiliateCompliancePermission {
  switch (value) {
    case 'affiliate_link.issue':
    case 'content.export_linked':
    case 'public_social.manual_publish':
    case 'public_social.provider_publish':
    case 'affiliate_recruitment.manual_publish':
    case 'affiliate_recruitment.provider_publish':
    case 'email.send':
    case 'sms.send':
    case 'whatsapp.send':
    case 'social_dm.send':
    case 'audience.upload':
    case 'paid_ads.launch':
    case 'phone.marketing':
    case 'affiliate_attribution.write':
    case 'commission.payout':
      return true;
    default:
      return false;
  }
}

export function isCanonicalAffiliateChannel(value: unknown): value is AffiliateComplianceChannel {
  switch (value) {
    case 'affiliate_link':
    case 'content_export':
    case 'public_social':
    case 'affiliate_recruitment':
    case 'email':
    case 'sms':
    case 'whatsapp':
    case 'social_dm':
    case 'audience_upload':
    case 'paid_ads':
    case 'phone':
    case 'tracking':
    case 'payout':
      return true;
    default:
      return false;
  }
}

function isLifecycleState(value: unknown): boolean {
  return oneOf(value, [
    'account_only', 'application_draft', 'identity_review', 'legal_bundle_presented',
    'legal_accepted', 'training_required', 'declarations_required', 'compliance_review',
    'active_limited', 'active', 'reacceptance_required', 'correction_required',
    'suspended_interim', 'suspended_final', 'terminated', 'withdrawn', 'migrated_unverified',
  ]);
}

function policyPack(value: unknown): boolean {
  if (value === null) return true;
  const record = dataRecord(value, [
    'bundleId', 'bundleVersion', 'bundleSha256', 'legalApproval', 'commercialApproval',
    'publication', 'effectiveAt', 'expiresAt',
  ]);
  return Boolean(record
    && isOpaqueReference(record.bundleId)
    && boundedText(record.bundleVersion, 100)
    && isSha256(record.bundleSha256)
    && oneOf(record.legalApproval, ['approved', 'pending', 'rejected', 'withdrawn'])
    && oneOf(record.commercialApproval, ['approved', 'pending', 'rejected', 'withdrawn'])
    && oneOf(record.publication, ['published', 'draft', 'superseded', 'withdrawn'])
    && nullable(record.effectiveAt, isInstant)
    && nullable(record.expiresAt, isInstant));
}

function acceptance(value: unknown): boolean {
  if (value === null) return true;
  const record = dataRecord(value, [
    'status', 'bundleId', 'bundleSha256', 'acceptedAt', 'expiresAt',
  ]);
  if (!record
      || !oneOf(record.status, ['accepted', 'declined', 'missing'])
      || !nullable(record.bundleId, isOpaqueReference)
      || !nullable(record.bundleSha256, isSha256)
      || !nullable(record.acceptedAt, isInstant)
      || !nullable(record.expiresAt, isInstant)) return false;
  if (record.status === 'accepted') {
    return record.bundleId !== null && record.bundleSha256 !== null && record.acceptedAt !== null;
  }
  return true;
}

function capacity(value: unknown): boolean {
  if (value === null) return true;
  const record = dataRecord(value, [
    'status', 'decision', 'capacityReference', 'evidenceSha256', 'occurredAt', 'expiresAt',
  ]);
  return Boolean(record
    && oneOf(record.status, ['current', 'missing', 'expired', 'withdrawn'])
    && nullable(record.decision, (candidate) => oneOf(candidate, ['verified', 'blocked']))
    && nullable(record.capacityReference, isOpaqueReference)
    && nullable(record.evidenceSha256, isSha256)
    && nullable(record.occurredAt, isInstant)
    && nullable(record.expiresAt, isInstant));
}

function training(value: unknown): boolean {
  if (value === null) return true;
  const record = dataRecord(value, [
    'status', 'trainingKey', 'trainingVersion', 'courseSha256', 'quizSha256',
    'approvalState', 'completedAt', 'expiresAt', 'attestationSha256',
  ]);
  if (!record
      || !oneOf(record.status, ['passed', 'failed', 'missing'])
      || !nullable(record.trainingKey, isLowerCode)
      || !nullable(record.trainingVersion, (candidate) => boundedText(candidate, 100))
      || !nullable(record.courseSha256, isSha256)
      || !nullable(record.quizSha256, isSha256)
      || !nullable(record.approvalState, (candidate) => oneOf(candidate, ['approved', 'blocked', 'withdrawn']))
      || !nullable(record.completedAt, isInstant)
      || !nullable(record.expiresAt, isInstant)
      || !nullable(record.attestationSha256, isSha256)) return false;
  if (record.status === 'passed') {
    return record.trainingKey !== null && record.trainingVersion !== null
      && record.courseSha256 !== null && record.quizSha256 !== null
      && record.approvalState !== null && record.completedAt !== null
      && record.expiresAt !== null && record.attestationSha256 !== null;
  }
  return true;
}

function declaration(value: unknown): boolean {
  if (value === null) return true;
  const record = dataRecord(value, [
    'status', 'decision', 'version', 'declarationSha256', 'evidenceSha256', 'occurredAt', 'expiresAt',
  ]);
  return Boolean(record
    && oneOf(record.status, ['current', 'missing', 'expired', 'withdrawn'])
    && nullable(record.decision, (candidate) => oneOf(candidate, ['affirmed', 'declined', 'withdrawn']))
    && nullable(record.version, (candidate) => boundedText(candidate, 100))
    && nullable(record.declarationSha256, isSha256)
    && nullable(record.evidenceSha256, isSha256)
    && nullable(record.occurredAt, isInstant)
    && nullable(record.expiresAt, isInstant));
}

function lifecycle(value: unknown): boolean {
  const record = dataRecord(value, ['state', 'occurredAt', 'evidenceSha256']);
  return Boolean(record && isLifecycleState(record.state) && isInstant(record.occurredAt) && isSha256(record.evidenceSha256));
}

function channelAuthority(value: unknown): boolean {
  const record = dataRecord(value, [
    'channel', 'status', 'authorityState', 'contentClass', 'purposeCode', 'territoryCode',
    'senderPartyReference', 'accountScopeReference', 'actionScopeSha256',
    'validFrom', 'validUntil', 'evidenceSha256',
  ]);
  return Boolean(record
    && isCanonicalAffiliateChannel(record.channel)
    && oneOf(record.status, ['current', 'missing', 'expired', 'withdrawn'])
    && oneOf(record.authorityState, ['approved', 'blocked', 'revoked', 'expired'])
    && oneOf(record.contentClass, ['ordinary_product', 'affiliate_recruitment', 'property_investment', 'operational_only'])
    && isLowerCode(record.purposeCode)
    && typeof record.territoryCode === 'string' && TERRITORY.test(record.territoryCode)
    && isOpaqueReference(record.senderPartyReference)
    && isOpaqueReference(record.accountScopeReference)
    && isSha256(record.actionScopeSha256)
    && nullable(record.validFrom, isInstant)
    && nullable(record.validUntil, isInstant)
    && nullable(record.evidenceSha256, isSha256));
}

function specialistKind(value: unknown): value is AffiliateSpecialistDecisionKind {
  return oneOf(value, [
    'pecr_sender_route', 'pecr_instigator_route', 'affiliate_recruitment_policy',
    'financial_promotion_perimeter', 'consumer_eligibility_review', 'sanctions_screening',
  ]);
}

function specialistDecision(value: unknown, expectedKind: AffiliateSpecialistDecisionKind, pecr: boolean): boolean {
  if (value === null) return true;
  const keys = [
    'status', 'decisionKind', 'decision', 'decisionReference', 'actionScopeSha256', 'validFrom', 'expiresAt',
    ...(pecr ? ['routeClassification', 'partyReference', 'responsibilityReference'] : []),
  ];
  const record = dataRecord(value, keys);
  if (!record
      || !specialistKind(record.decisionKind) || record.decisionKind !== expectedKind
      || !oneOf(record.status, ['current', 'missing', 'expired', 'withdrawn'])
      || !nullable(record.decision, (candidate) => oneOf(candidate, ['approved', 'blocked']))
      || !nullable(record.decisionReference, isOpaqueReference)
      || !nullable(record.actionScopeSha256, isSha256)
      || !nullable(record.validFrom, isInstant)
      || !nullable(record.expiresAt, isInstant)) return false;
  return !pecr || (oneOf(record.routeClassification, [
    'solicited_request', 'individual_consent', 'individual_soft_opt_in',
    'corporate_subscriber_reg23', 'unknown',
  ]) && nullable(record.partyReference, isOpaqueReference)
    && nullable(record.responsibilityReference, isOpaqueReference));
}

function complianceCase(value: unknown): boolean {
  const record = dataRecord(value, [
    'kind', 'state', 'permissionEffect', 'caseReference', 'occurredAt', 'evidenceSha256',
  ]);
  return Boolean(record
    && oneOf(record.kind, ['reacceptance', 'correction', 'suspension', 'fraud', 'security'])
    && oneOf(record.state, [
      'opened', 'takedown_requested', 'correction_requested', 'suspended_interim',
      'suspended_final', 'reinstated', 'closed',
    ])
    && oneOf(record.permissionEffect, ['block', 'monitor'])
    && typeof record.caseReference === 'string' && CASE_REFERENCE.test(record.caseReference)
    && isInstant(record.occurredAt)
    && isSha256(record.evidenceSha256));
}

function permissionFact(value: unknown): boolean {
  const record = dataRecord(value, [
    'permission', 'state', 'actionScopeSha256', 'validFrom', 'validUntil', 'evidenceSha256',
  ]);
  return Boolean(record
    && isCanonicalAffiliatePermission(record.permission)
    && oneOf(record.state, ['requested', 'blocked', 'revoked', 'expired'])
    && isSha256(record.actionScopeSha256)
    && isInstant(record.validFrom)
    && nullable(record.validUntil, isInstant)
    && isSha256(record.evidenceSha256));
}

function classificationEffect(value: unknown): boolean {
  if (value === null) return true;
  const record = dataRecord(value, [
    'kind', 'status', 'classification', 'actionScopeSha256', 'evidenceSha256', 'validFrom', 'expiresAt',
  ]);
  return Boolean(record
    && record.kind === 'content_classification'
    && oneOf(record.status, ['current', 'missing', 'expired', 'withdrawn'])
    && nullable(record.classification, (candidate) => oneOf(candidate, ['ordinary_product', 'property_investment']))
    && nullable(record.actionScopeSha256, isSha256)
    && nullable(record.evidenceSha256, isSha256)
    && nullable(record.validFrom, isInstant)
    && nullable(record.expiresAt, isInstant));
}

function scopedEffect(value: unknown, expectedKind: string): boolean {
  if (value === null) return true;
  const record = dataRecord(value, [
    'kind', 'status', 'decision', 'actionScopeSha256', 'evidenceSha256', 'validFrom', 'expiresAt',
  ]);
  return Boolean(record
    && record.kind === expectedKind
    && oneOf(record.status, ['current', 'missing', 'expired', 'withdrawn'])
    && nullable(record.decision, (candidate) => oneOf(candidate, ['satisfied', 'blocked']))
    && nullable(record.actionScopeSha256, isSha256)
    && nullable(record.evidenceSha256, isSha256)
    && nullable(record.validFrom, isInstant)
    && nullable(record.expiresAt, isInstant));
}

function effects(value: unknown): boolean {
  const record = dataRecord(value, [
    'contentClassification', 'contentScopeApproval', 'disclosureRenderedCheck', 'claimEvidence',
    'recipientRoute', 'suppression', 'visitorChoice', 'payoutChecks', 'providerEffects',
  ]);
  return Boolean(record
    && classificationEffect(record.contentClassification)
    && scopedEffect(record.contentScopeApproval, 'content_scope_approval')
    && scopedEffect(record.disclosureRenderedCheck, 'rendered_disclosure_check')
    && scopedEffect(record.claimEvidence, 'claim_evidence')
    && scopedEffect(record.recipientRoute, 'recipient_route')
    && scopedEffect(record.suppression, 'suppression')
    && scopedEffect(record.visitorChoice, 'visitor_choice')
    && scopedEffect(record.payoutChecks, 'payout_checks')
    && record.providerEffects === 'off');
}

function evidence(value: unknown, workspaceId: string, subjectId: string): boolean {
  const record = dataRecord(value, [
    'workspaceId', 'subjectId', 'evidenceSnapshotSha256', 'policyPack', 'lifecycle', 'acceptance', 'capacity',
    'training', 'declarations', 'channelAuthorities', 'specialistDecisions', 'cases',
    'permissionFacts', 'effects',
  ]);
  if (!record || record.workspaceId !== workspaceId || record.subjectId !== subjectId
      || !isUuid(record.workspaceId) || !isUuid(record.subjectId)
      || !isSha256(record.evidenceSnapshotSha256)
      || !policyPack(record.policyPack) || !lifecycle(record.lifecycle)
      || !acceptance(record.acceptance) || !capacity(record.capacity)
      || !training(record.training)) return false;

  const declarations = dataRecord(record.declarations, ['businessTax', 'disclosureClaims', 'dataProtection']);
  if (!declarations || !declaration(declarations.businessTax)
      || !declaration(declarations.disclosureClaims) || !declaration(declarations.dataProtection)) return false;

  const channels = dataArray(record.channelAuthorities, 32);
  if (!channels || channels.some((entry) => !channelAuthority(entry))) return false;
  const channelKeys = channels.map((entry) => {
    const item = entry as { channel: string; actionScopeSha256: string };
    return `${item.channel}:${item.actionScopeSha256}`;
  });
  if (new Set(channelKeys).size !== channelKeys.length) return false;

  const decisions = dataRecord(record.specialistDecisions, [
    'pecrSenderRoute', 'pecrInstigatorRoute', 'affiliateRecruitmentPolicy',
    'financialPromotionPerimeter', 'consumerEligibilityReview', 'sanctionsScreening',
  ]);
  if (!decisions
      || !specialistDecision(decisions.pecrSenderRoute, 'pecr_sender_route', true)
      || !specialistDecision(decisions.pecrInstigatorRoute, 'pecr_instigator_route', true)
      || !specialistDecision(decisions.affiliateRecruitmentPolicy, 'affiliate_recruitment_policy', false)
      || !specialistDecision(decisions.financialPromotionPerimeter, 'financial_promotion_perimeter', false)
      || !specialistDecision(decisions.consumerEligibilityReview, 'consumer_eligibility_review', false)
      || !specialistDecision(decisions.sanctionsScreening, 'sanctions_screening', false)) return false;

  const cases = dataArray(record.cases, 100);
  if (!cases || cases.some((entry) => !complianceCase(entry))) return false;
  const caseReferences = cases.map((entry) => (entry as { caseReference: string }).caseReference);
  if (new Set(caseReferences).size !== caseReferences.length) return false;

  const permissionFacts = dataArray(record.permissionFacts, 100);
  if (!permissionFacts || permissionFacts.some((entry) => !permissionFact(entry))) return false;
  const factKeys = permissionFacts.map((entry) => {
    const item = entry as { permission: string; actionScopeSha256: string };
    return `${item.permission}:${item.actionScopeSha256}`;
  });
  return new Set(factKeys).size === factKeys.length && effects(record.effects);
}

export interface AffiliateComplianceInputValidation {
  readonly valid: boolean;
  readonly knownPermission: boolean;
}

export function validateAffiliateComplianceInput(value: unknown): AffiliateComplianceInputValidation {
  const record = dataRecord(value, [
    'permission', 'workspaceId', 'subjectId', 'actionScopeSha256',
    'decisionNonceSha256', 'now', 'evidence',
  ]);
  const knownPermission = Boolean(record && isCanonicalAffiliatePermission(record.permission));
  const valid = Boolean(record
    && knownPermission
    && isUuid(record.workspaceId)
    && isUuid(record.subjectId)
    && isSha256(record.actionScopeSha256)
    && isSha256(record.decisionNonceSha256)
    && isInstant(record.now)
    && evidence(record.evidence, record.workspaceId as string, record.subjectId as string));
  return Object.freeze({ valid, knownPermission });
}

export function asValidatedAffiliateComplianceInput(value: unknown): EvaluateAffiliateComplianceInput {
  return value as EvaluateAffiliateComplianceInput;
}
