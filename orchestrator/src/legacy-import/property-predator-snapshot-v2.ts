import { createHash } from 'node:crypto';
import type {
  LegacyLeadBatchInput,
  LegacyLeadRowInput,
  LegacyUnresolvedAttributionInput,
} from './types.js';

export const PROPERTY_PREDATOR_ACCOUNT_SNAPSHOT_SCHEMA_VERSION = 2 as const;
export const PROPERTY_PREDATOR_ACCOUNT_SNAPSHOT_SOURCE =
  'property-predator.accounts/v2' as const;
export const PROPERTY_PREDATOR_SNAPSHOT_MAX_PAGE_RECORDS = 500;
export const PROPERTY_PREDATOR_SNAPSHOT_MAX_RECORDS = 10_000;
export const PROPERTY_PREDATOR_SNAPSHOT_MAX_AGE_MS = 15 * 60 * 1_000;

export interface PropertyPredatorVerifiedGoogleIdentityV2 {
  readonly provider: 'google';
  readonly emailVerified: true;
  readonly verifiedAt: string;
}

export interface PropertyPredatorSnapshotAccountV2 {
  readonly id: string;
  readonly email: string;
  readonly createdAt: string;
  readonly displayName?: string;
  readonly companyName?: string;
  readonly verifiedIdentity: PropertyPredatorVerifiedGoogleIdentityV2 | null;
}

export interface PropertyPredatorSnapshotOwnAffiliateV2 {
  readonly id: string;
  readonly code: string;
  readonly codeStatus: string;
  readonly createdAt: string;
  readonly parentAffiliateId?: string;
}

export interface PropertyPredatorSnapshotOriginalAttributionV2 {
  readonly referralId: string;
  readonly affiliateId: string;
  readonly affiliateCode: string;
  readonly attachedAt: string;
}

export interface PropertyPredatorSnapshotRecordV2 {
  readonly account: PropertyPredatorSnapshotAccountV2;
  readonly ownAffiliate: PropertyPredatorSnapshotOwnAffiliateV2 | null;
  readonly originalAttribution: PropertyPredatorSnapshotOriginalAttributionV2 | null;
}

export interface PropertyPredatorSnapshotManifestV2 {
  readonly pageCount: number;
  readonly recordCount: number;
  readonly eventHighWatermark: string;
  readonly contentSha256: string;
}

export interface PropertyPredatorSnapshotPageV2 {
  readonly pageNumber: number;
  readonly cursor: string | null;
  readonly nextCursor: string | null;
  readonly previousPageSha256: string | null;
  readonly records: readonly PropertyPredatorSnapshotRecordV2[];
  readonly pageSha256: string;
}

/** One source response contains exactly one page. Consumers retain all responses. */
export interface PropertyPredatorAccountSnapshotEnvelopeV2 {
  readonly schemaVersion: typeof PROPERTY_PREDATOR_ACCOUNT_SNAPSHOT_SCHEMA_VERSION;
  readonly sourceSystem: typeof PROPERTY_PREDATOR_ACCOUNT_SNAPSHOT_SOURCE;
  readonly snapshotId: string;
  readonly generatedAt: string;
  readonly watermark: string;
  readonly complete: true;
  readonly manifest: PropertyPredatorSnapshotManifestV2;
  readonly pages: readonly [PropertyPredatorSnapshotPageV2];
}

export type PropertyPredatorAccountSnapshotExportV2 =
  | PropertyPredatorAccountSnapshotEnvelopeV2
  | readonly PropertyPredatorAccountSnapshotEnvelopeV2[];

export type PropertyPredatorSnapshotRecordIssueCode =
  | 'duplicate_account_id'
  | 'duplicate_verified_email'
  | 'duplicate_affiliate_id'
  | 'duplicate_affiliate_code'
  | 'missing_parent_affiliate'
  | 'self_parent_affiliate'
  | 'affiliate_parent_cycle'
  | 'duplicate_referral_id'
  | 'missing_attribution_affiliate'
  | 'invalid_attribution_affiliate'
  | 'attribution_affiliate_code_mismatch';

export interface PropertyPredatorSnapshotRecordIssue {
  readonly pageNumber: number;
  readonly recordIndex: number;
  readonly accountId: string;
  readonly code: PropertyPredatorSnapshotRecordIssueCode;
}

export interface VerifiedPropertyPredatorAccountSnapshotV2 {
  readonly schemaVersion: 2;
  readonly sourceSystem: typeof PROPERTY_PREDATOR_ACCOUNT_SNAPSHOT_SOURCE;
  readonly snapshotId: string;
  readonly generatedAt: string;
  readonly watermark: string;
  readonly manifest: Readonly<PropertyPredatorSnapshotManifestV2>;
  readonly pages: readonly Readonly<PropertyPredatorSnapshotPageV2>[];
  readonly records: readonly Readonly<PropertyPredatorSnapshotRecordV2>[];
  readonly recordIssues: readonly PropertyPredatorSnapshotRecordIssue[];
  readonly envelopeJson: string;
  readonly envelopeSha256: string;
  readonly legacyBatch: LegacyLeadBatchInput;
  readonly consentDefault: 'unknown';
}

export class PropertyPredatorSnapshotContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PropertyPredatorSnapshotContractError';
  }
}

type JsonRecord = Record<string, unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const AFFILIATE_STATUS = /^[a-z][a-z0-9_-]{0,31}$/;
const AFFILIATE_CODE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const HIGH_WATERMARK = /^(?:0|[1-9][0-9]{0,19})$/;

export function canonicalSnapshotJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new PropertyPredatorSnapshotContractError('snapshot JSON contains a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalSnapshotJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as JsonRecord;
    return `{${Object.keys(record).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalSnapshotJson(record[key])}`
    )).join(',')}}`;
  }
  throw new PropertyPredatorSnapshotContractError(`snapshot JSON cannot contain ${typeof value}`);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function fail(message: string): never {
  throw new PropertyPredatorSnapshotContractError(message);
}

function object(value: unknown, path: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${path} must be an object`);
  return value as JsonRecord;
}

function exactKeys(value: JsonRecord, allowed: readonly string[], required: readonly string[], path: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) fail(`${path}.${key} is not part of snapshot schema v2`);
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) fail(`${path}.${key} is required`);
  }
}

function text(value: unknown, path: string, max: number): string {
  if (typeof value !== 'string' || value !== value.trim() || value.length < 1 || value.length > max
      || /[\u0000-\u001f\u007f]/.test(value)) {
    fail(`${path} must be trimmed text between 1 and ${max} characters`);
  }
  return value;
}

function timestamp(value: unknown, path: string, now: Date): string {
  if (typeof value !== 'string' || !CANONICAL_TIMESTAMP.test(value)) {
    fail(`${path} must be a canonical RFC3339 millisecond UTC timestamp`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) fail(`${path} must be a real timestamp`);
  if (parsed.getTime() > now.getTime()) fail(`${path} must not be in the future`);
  return value;
}

function hash(value: unknown, path: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) fail(`${path} must be a lowercase SHA-256 hex digest`);
  return value;
}

function uuid(value: unknown, path: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    fail(`${path} must be a canonical lowercase UUID`);
  }
  return value;
}

function email(value: unknown, path: string): string {
  const candidate = text(value, path, 320);
  if (!EMAIL.test(candidate)) fail(`${path} must be an email address`);
  if (candidate !== candidate.toLowerCase()) fail(`${path} must be canonical lowercase`);
  return candidate;
}

function nullableCursor(value: unknown, path: string): string | null {
  return value === null ? null : text(value, path, 500);
}

function integer(value: unknown, path: string, min: number, max: number): number {
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) {
    fail(`${path} must be an integer between ${min} and ${max}`);
  }
  return Number(value);
}

function parseVerifiedIdentity(
  value: unknown,
  path: string,
  now: Date,
): PropertyPredatorVerifiedGoogleIdentityV2 | null {
  if (value === null) return null;
  const record = object(value, path);
  exactKeys(record, ['provider', 'emailVerified', 'verifiedAt'],
    ['provider', 'emailVerified', 'verifiedAt'], path);
  if (record.provider !== 'google') fail(`${path}.provider must equal google`);
  if (record.emailVerified !== true) fail(`${path}.emailVerified must equal true`);
  return Object.freeze({
    provider: 'google',
    emailVerified: true,
    verifiedAt: timestamp(record.verifiedAt, `${path}.verifiedAt`, now),
  });
}

function parseRecord(value: unknown, path: string, now: Date): PropertyPredatorSnapshotRecordV2 {
  const record = object(value, path);
  exactKeys(record, ['account', 'ownAffiliate', 'originalAttribution'],
    ['account', 'ownAffiliate', 'originalAttribution'], path);
  const account = object(record.account, `${path}.account`);
  exactKeys(account, ['id', 'email', 'createdAt', 'displayName', 'companyName', 'verifiedIdentity'],
    ['id', 'email', 'createdAt', 'verifiedIdentity'], `${path}.account`);
  const parsedAccount: PropertyPredatorSnapshotAccountV2 = Object.freeze({
    id: uuid(account.id, `${path}.account.id`),
    email: email(account.email, `${path}.account.email`),
    createdAt: timestamp(account.createdAt, `${path}.account.createdAt`, now),
    ...(Object.prototype.hasOwnProperty.call(account, 'displayName')
      ? { displayName: text(account.displayName, `${path}.account.displayName`, 200) }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(account, 'companyName')
      ? { companyName: text(account.companyName, `${path}.account.companyName`, 200) }
      : {}),
    verifiedIdentity: parseVerifiedIdentity(account.verifiedIdentity, `${path}.account.verifiedIdentity`, now),
  });

  let ownAffiliate: PropertyPredatorSnapshotOwnAffiliateV2 | null = null;
  if (record.ownAffiliate !== null) {
    const affiliate = object(record.ownAffiliate, `${path}.ownAffiliate`);
    exactKeys(affiliate, ['id', 'code', 'codeStatus', 'createdAt', 'parentAffiliateId'],
      ['id', 'code', 'codeStatus', 'createdAt'], `${path}.ownAffiliate`);
    const codeStatus = text(affiliate.codeStatus, `${path}.ownAffiliate.codeStatus`, 32);
    if (!AFFILIATE_STATUS.test(codeStatus)) fail(`${path}.ownAffiliate.codeStatus is invalid`);
    ownAffiliate = Object.freeze({
      id: uuid(affiliate.id, `${path}.ownAffiliate.id`),
      code: text(affiliate.code, `${path}.ownAffiliate.code`, 64),
      codeStatus,
      createdAt: timestamp(affiliate.createdAt, `${path}.ownAffiliate.createdAt`, now),
      ...(Object.prototype.hasOwnProperty.call(affiliate, 'parentAffiliateId')
        ? { parentAffiliateId: uuid(
          affiliate.parentAffiliateId,
          `${path}.ownAffiliate.parentAffiliateId`,
        ) }
        : {}),
    });
    if (!AFFILIATE_CODE.test(ownAffiliate.code)) fail(`${path}.ownAffiliate.code is invalid`);
  }

  let originalAttribution: PropertyPredatorSnapshotOriginalAttributionV2 | null = null;
  if (record.originalAttribution !== null) {
    const attribution = object(record.originalAttribution, `${path}.originalAttribution`);
    exactKeys(attribution, ['referralId', 'affiliateId', 'affiliateCode', 'attachedAt'],
      ['referralId', 'affiliateId', 'affiliateCode', 'attachedAt'], `${path}.originalAttribution`);
    originalAttribution = Object.freeze({
      referralId: uuid(attribution.referralId, `${path}.originalAttribution.referralId`),
      affiliateId: uuid(attribution.affiliateId, `${path}.originalAttribution.affiliateId`),
      affiliateCode: text(attribution.affiliateCode, `${path}.originalAttribution.affiliateCode`, 64),
      attachedAt: timestamp(attribution.attachedAt, `${path}.originalAttribution.attachedAt`, now),
    });
    if (!AFFILIATE_CODE.test(originalAttribution.affiliateCode)) {
      fail(`${path}.originalAttribution.affiliateCode is invalid`);
    }
  }

  return Object.freeze({ account: parsedAccount, ownAffiliate, originalAttribution });
}

export function propertyPredatorSnapshotPageSha256(input: Readonly<{
  snapshotId: string;
  pageNumber: number;
  cursor: string | null;
  nextCursor: string | null;
  previousPageSha256: string | null;
  records: readonly PropertyPredatorSnapshotRecordV2[];
}>): string {
  return sha256(canonicalSnapshotJson({
    snapshotId: input.snapshotId,
    pageNumber: input.pageNumber,
    cursor: input.cursor,
    nextCursor: input.nextCursor,
    previousPageSha256: input.previousPageSha256,
    records: input.records,
  }));
}

export function propertyPredatorSnapshotContentSha256(input: Readonly<{
  schemaVersion: 2;
  sourceSystem: typeof PROPERTY_PREDATOR_ACCOUNT_SNAPSHOT_SOURCE;
  snapshotId: string;
  generatedAt: string;
  watermark: string;
  complete: true;
  pageCount: number;
  recordCount: number;
  eventHighWatermark: string;
  pageSha256: readonly string[];
}>): string {
  return sha256(canonicalSnapshotJson(input));
}

function duplicates(values: readonly (string | null)[]): Set<string> {
  const seen = new Set<string>();
  const duplicate = new Set<string>();
  for (const value of values) {
    if (value === null) continue;
    if (seen.has(value)) duplicate.add(value);
    seen.add(value);
  }
  return duplicate;
}

interface PositionedRecord {
  readonly pageNumber: number;
  readonly recordIndex: number;
  readonly record: PropertyPredatorSnapshotRecordV2;
}

function inspectRecordIntegrity(positioned: readonly PositionedRecord[]): PropertyPredatorSnapshotRecordIssue[] {
  const accountIds = duplicates(positioned.map(({ record }) => record.account.id));
  const verifiedEmails = duplicates(positioned.map(({ record }) => (
    record.account.verifiedIdentity ? record.account.email : null
  )));
  const affiliateIds = duplicates(positioned.map(({ record }) => record.ownAffiliate?.id ?? null));
  const affiliateCodes = duplicates(positioned.map(({ record }) => record.ownAffiliate?.code.toLowerCase() ?? null));
  const referralIds = duplicates(positioned.map(({ record }) => record.originalAttribution?.referralId ?? null));
  const affiliates = new Map(positioned
    .filter(({ record }) => record.ownAffiliate !== null)
    .map(({ record }) => [record.ownAffiliate!.id, record.ownAffiliate!]));
  const invalidAffiliateIds = new Set<string>();
  for (const item of positioned) {
    const own = item.record.ownAffiliate;
    if (!own) continue;
    if (affiliateIds.has(own.id) || affiliateCodes.has(own.code.toLowerCase())
        || own.parentAffiliateId === own.id
        || (own.parentAffiliateId && !affiliates.has(own.parentAffiliateId))) {
      invalidAffiliateIds.add(own.id);
    }
  }
  const cycleIds = new Set<string>();
  for (const start of affiliates.keys()) {
    const path: string[] = [];
    const seen = new Map<string, number>();
    let current: string | null = start;
    while (current && affiliates.has(current)) {
      const prior = seen.get(current);
      if (prior !== undefined) {
        path.slice(prior).forEach((id) => cycleIds.add(id));
        break;
      }
      seen.set(current, path.length);
      path.push(current);
      current = affiliates.get(current)?.parentAffiliateId ?? null;
    }
  }
  cycleIds.forEach((id) => invalidAffiliateIds.add(id));
  const issues: PropertyPredatorSnapshotRecordIssue[] = [];
  const add = (item: PositionedRecord, code: PropertyPredatorSnapshotRecordIssueCode): void => {
    issues.push(Object.freeze({
      pageNumber: item.pageNumber,
      recordIndex: item.recordIndex,
      accountId: item.record.account.id,
      code,
    }));
  };
  for (const item of positioned) {
    const { record } = item;
    if (accountIds.has(record.account.id)) add(item, 'duplicate_account_id');
    const identity = record.account.verifiedIdentity;
    if (identity) {
      if (verifiedEmails.has(record.account.email)) add(item, 'duplicate_verified_email');
    }
    const own = record.ownAffiliate;
    if (own) {
      if (affiliateIds.has(own.id)) add(item, 'duplicate_affiliate_id');
      if (affiliateCodes.has(own.code.toLowerCase())) add(item, 'duplicate_affiliate_code');
      if (own.parentAffiliateId === own.id) add(item, 'self_parent_affiliate');
      else if (own.parentAffiliateId && !affiliates.has(own.parentAffiliateId)) add(item, 'missing_parent_affiliate');
      if (cycleIds.has(own.id) && own.parentAffiliateId !== own.id) add(item, 'affiliate_parent_cycle');
    }
    const attribution = record.originalAttribution;
    if (attribution) {
      if (referralIds.has(attribution.referralId)) add(item, 'duplicate_referral_id');
      const affiliate = affiliates.get(attribution.affiliateId);
      if (!affiliate) add(item, 'missing_attribution_affiliate');
      else if (invalidAffiliateIds.has(attribution.affiliateId)) add(item, 'invalid_attribution_affiliate');
      else if (affiliate.code !== attribution.affiliateCode) add(item, 'attribution_affiliate_code_mismatch');
    }
  }
  return issues.sort((left, right) => (
    left.pageNumber - right.pageNumber
    || left.recordIndex - right.recordIndex
    || left.code.localeCompare(right.code)
  ));
}

function issueMap(issues: readonly PropertyPredatorSnapshotRecordIssue[]): ReadonlyMap<string, readonly string[]> {
  const result = new Map<string, string[]>();
  for (const issue of issues) {
    const key = `${issue.pageNumber}:${issue.recordIndex}`;
    const list = result.get(key) ?? [];
    list.push(`snapshot:${issue.code}`);
    result.set(key, list);
  }
  return result;
}

function adaptToLegacy(
  snapshotId: string,
  positioned: readonly PositionedRecord[],
  issues: readonly PropertyPredatorSnapshotRecordIssue[],
): LegacyLeadBatchInput {
  const byPosition = issueMap(issues);
  const duplicateAccounts = new Set(issues
    .filter((issue) => issue.code === 'duplicate_account_id')
    .map((issue) => `${issue.pageNumber}:${issue.recordIndex}`));
  const invalidAffiliates = new Set(issues
    .filter((issue) => issue.code.includes('affiliate') && issue.code !== 'missing_attribution_affiliate')
    .map((issue) => `${issue.pageNumber}:${issue.recordIndex}`));
  const invalidReferrals = new Set(issues
    .filter((issue) => issue.code.includes('attribution') || issue.code === 'duplicate_referral_id')
    .map((issue) => `${issue.pageNumber}:${issue.recordIndex}`));
  const affiliatesById = new Map(positioned
    .filter(({ record }) => record.ownAffiliate !== null)
    .map(({ record }) => [record.ownAffiliate!.id, record.ownAffiliate!]));

  const rows: LegacyLeadRowInput[] = [];
  const unresolvedAttributions: LegacyUnresolvedAttributionInput[] = [];
  const unresolvedKeys = new Set<string>();
  const retainUnresolved = (fact: LegacyUnresolvedAttributionInput): void => {
    const key = `${fact.recordKind}\0${fact.sourceRecordId}`;
    // Every duplicate raw record and every reason remains in private snapshot
    // staging. The legacy compatibility batch retains one canonical pointer so
    // its own uniqueness constraint cannot manufacture a second source fact.
    if (unresolvedKeys.has(key)) return;
    unresolvedKeys.add(key);
    unresolvedAttributions.push(fact);
  };
  for (const item of positioned) {
    const key = `${item.pageNumber}:${item.recordIndex}`;
    const { account, ownAffiliate, originalAttribution } = item.record;
    if (!duplicateAccounts.has(key)) {
      const identitySafe = account.verifiedIdentity !== null
        && !(byPosition.get(key) ?? []).some((reason) => (
          reason === 'snapshot:duplicate_verified_email'
        ));
      const affiliate = originalAttribution
        ? affiliatesById.get(originalAttribution.affiliateId)
        : undefined;
      rows.push({
        sourceRecordId: account.id,
        displayName: account.displayName?.trim() || account.companyName?.trim() || account.email,
        companyName: account.companyName?.trim() || null,
        originalCreatedAt: account.createdAt,
        identities: [{
          kind: 'email', value: account.email, verified: identitySafe,
          label: identitySafe
            ? 'Property Predator Google-verified email'
            : 'Property Predator account email',
          primary: true,
        }],
        sourceQuarantineReasons: (byPosition.get(key) ?? []).filter((reason) => (
          !reason.includes('affiliate') && reason !== 'snapshot:duplicate_referral_id'
        )),
        attribution: originalAttribution && affiliate && !invalidReferrals.has(key)
          ? {
              affiliateSourceId: affiliate.id,
              affiliateCode: affiliate.code,
              referralCode: originalAttribution.affiliateCode,
              attributedAt: originalAttribution.attachedAt,
              raw: {
                referral: originalAttribution,
                affiliate,
              },
            }
          : null,
      });
    }
    if (ownAffiliate && invalidAffiliates.has(key)) {
      retainUnresolved({
        recordKind: 'affiliate', sourceRecordId: ownAffiliate.id,
        referredSourceRecordId: account.id, originalCreatedAt: ownAffiliate.createdAt,
        reason: 'source_integrity_conflict', affiliateSourceId: ownAffiliate.id,
        affiliateCode: ownAffiliate.code, referralCode: ownAffiliate.code,
        raw: { accountId: account.id, affiliate: ownAffiliate, issues: byPosition.get(key) ?? [] },
      });
    }
    if (originalAttribution && invalidReferrals.has(key)) {
      retainUnresolved({
        recordKind: 'referral', sourceRecordId: originalAttribution.referralId,
        referredSourceRecordId: account.id, originalCreatedAt: originalAttribution.attachedAt,
        reason: 'source_integrity_conflict', affiliateSourceId: originalAttribution.affiliateId,
        affiliateCode: originalAttribution.affiliateCode,
        referralCode: originalAttribution.affiliateCode,
        raw: { accountId: account.id, attribution: originalAttribution, issues: byPosition.get(key) ?? [] },
      });
    }
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    sourceSystem: PROPERTY_PREDATOR_ACCOUNT_SNAPSHOT_SOURCE,
    batchKey: snapshotId,
    rows: Object.freeze(rows),
    unresolvedAttributions: Object.freeze(unresolvedAttributions),
  });
}

/**
 * Verify a collected, complete set of source page responses before any DB call.
 * No sorting or repair is attempted: missing, mixed or reordered pages fail.
 */
export function verifyPropertyPredatorAccountSnapshotV2(
  input: PropertyPredatorAccountSnapshotExportV2,
  now = new Date(),
): VerifiedPropertyPredatorAccountSnapshotV2 {
  const responses = Array.isArray(input) ? input : [input];
  if (responses.length < 1) fail('snapshot responses must contain page 1');
  if (responses.length > PROPERTY_PREDATOR_SNAPSHOT_MAX_RECORDS) {
    fail(`snapshot responses must contain at most ${PROPERTY_PREDATOR_SNAPSHOT_MAX_RECORDS} pages`);
  }
  let cumulativeRecordCount = 0;
  const parsed: Array<{
    envelope: Omit<PropertyPredatorAccountSnapshotEnvelopeV2, 'pages'>;
    page: PropertyPredatorSnapshotPageV2;
  }> = [];
  for (const [responseIndex, candidate] of responses.entries()) {
    const path = `responses[${responseIndex}]`;
    const envelope = object(candidate, path);
    exactKeys(envelope, [
      'schemaVersion', 'sourceSystem', 'snapshotId', 'generatedAt', 'watermark',
      'complete', 'manifest', 'pages',
    ], [
      'schemaVersion', 'sourceSystem', 'snapshotId', 'generatedAt', 'watermark',
      'complete', 'manifest', 'pages',
    ], path);
    if (envelope.schemaVersion !== 2) fail(`${path}.schemaVersion must equal 2`);
    if (envelope.sourceSystem !== PROPERTY_PREDATOR_ACCOUNT_SNAPSHOT_SOURCE) {
      fail(`${path}.sourceSystem must equal ${PROPERTY_PREDATOR_ACCOUNT_SNAPSHOT_SOURCE}`);
    }
    if (envelope.complete !== true) fail(`${path}.complete must equal true`);
    const snapshotId = uuid(envelope.snapshotId, `${path}.snapshotId`);
    const generatedAt = timestamp(envelope.generatedAt, `${path}.generatedAt`, now);
    const watermark = timestamp(envelope.watermark, `${path}.watermark`, now);
    if (new Date(watermark).getTime() > new Date(generatedAt).getTime()) {
      fail(`${path}.watermark must not be later than generatedAt`);
    }
    const manifestValue = object(envelope.manifest, `${path}.manifest`);
    exactKeys(manifestValue, ['pageCount', 'recordCount', 'eventHighWatermark', 'contentSha256'],
      ['pageCount', 'recordCount', 'eventHighWatermark', 'contentSha256'], `${path}.manifest`);
    if (typeof manifestValue.eventHighWatermark !== 'string'
        || !HIGH_WATERMARK.test(manifestValue.eventHighWatermark)) {
      fail(`${path}.manifest.eventHighWatermark must be a canonical non-negative decimal string`);
    }
    const manifest: PropertyPredatorSnapshotManifestV2 = Object.freeze({
      pageCount: integer(manifestValue.pageCount, `${path}.manifest.pageCount`, 1, 10_000),
      recordCount: integer(manifestValue.recordCount, `${path}.manifest.recordCount`, 0, PROPERTY_PREDATOR_SNAPSHOT_MAX_RECORDS),
      eventHighWatermark: manifestValue.eventHighWatermark,
      contentSha256: hash(manifestValue.contentSha256, `${path}.manifest.contentSha256`),
    });
    if (!Array.isArray(envelope.pages) || envelope.pages.length !== 1) {
      fail(`${path}.pages must contain exactly one source page response`);
    }
    const pageValue = object(envelope.pages[0], `${path}.pages[0]`);
    exactKeys(pageValue, [
      'pageNumber', 'cursor', 'nextCursor', 'previousPageSha256', 'records', 'pageSha256',
    ], [
      'pageNumber', 'cursor', 'nextCursor', 'previousPageSha256', 'records', 'pageSha256',
    ], `${path}.pages[0]`);
    if (!Array.isArray(pageValue.records) || pageValue.records.length > PROPERTY_PREDATOR_SNAPSHOT_MAX_PAGE_RECORDS) {
      fail(`${path}.pages[0].records must contain at most ${PROPERTY_PREDATOR_SNAPSHOT_MAX_PAGE_RECORDS} records`);
    }
    cumulativeRecordCount += pageValue.records.length;
    if (cumulativeRecordCount > PROPERTY_PREDATOR_SNAPSHOT_MAX_RECORDS) {
      fail(`snapshot responses must contain at most ${PROPERTY_PREDATOR_SNAPSHOT_MAX_RECORDS} records in total`);
    }
    const records = pageValue.records.map((record, index) => (
      parseRecord(record, `${path}.pages[0].records[${index}]`, now)
    ));
    for (const [recordIndex, record] of records.entries()) {
      const recordTimes = [
        ['account.createdAt', record.account.createdAt],
        ['account.verifiedIdentity.verifiedAt', record.account.verifiedIdentity?.verifiedAt],
        ['ownAffiliate.createdAt', record.ownAffiliate?.createdAt],
        ['originalAttribution.attachedAt', record.originalAttribution?.attachedAt],
      ] as const;
      for (const [label, recordTime] of recordTimes) {
        if (recordTime && new Date(recordTime).getTime() > new Date(watermark).getTime()) {
          fail(`${path}.pages[0].records[${recordIndex}].${label} must not be later than watermark`);
        }
      }
    }
    const page: PropertyPredatorSnapshotPageV2 = Object.freeze({
      pageNumber: integer(pageValue.pageNumber, `${path}.pages[0].pageNumber`, 1, 10_000),
      cursor: nullableCursor(pageValue.cursor, `${path}.pages[0].cursor`),
      nextCursor: nullableCursor(pageValue.nextCursor, `${path}.pages[0].nextCursor`),
      previousPageSha256: pageValue.previousPageSha256 === null
        ? null
        : hash(pageValue.previousPageSha256, `${path}.pages[0].previousPageSha256`),
      records: Object.freeze(records),
      pageSha256: hash(pageValue.pageSha256, `${path}.pages[0].pageSha256`),
    });
    parsed.push({
      envelope: Object.freeze({
        schemaVersion: 2, sourceSystem: PROPERTY_PREDATOR_ACCOUNT_SNAPSHOT_SOURCE,
        snapshotId, generatedAt, watermark, complete: true, manifest,
      }),
      page,
    });
  }

  const first = parsed[0]!.envelope;
  const ageMs = now.getTime() - new Date(first.generatedAt).getTime();
  if (ageMs < 0 || ageMs > PROPERTY_PREDATOR_SNAPSHOT_MAX_AGE_MS) {
    fail(`snapshot generatedAt must be within ${PROPERTY_PREDATOR_SNAPSHOT_MAX_AGE_MS}ms of ingest`);
  }
  if (new Date(first.generatedAt).getTime() - new Date(first.watermark).getTime()
      > PROPERTY_PREDATOR_SNAPSHOT_MAX_AGE_MS) {
    fail('snapshot watermark is too far behind generatedAt');
  }
  if (first.manifest.pageCount !== parsed.length) fail('manifest.pageCount must equal the number of collected page responses');
  const pageHashes: string[] = [];
  const positioned: PositionedRecord[] = [];
  for (const [index, item] of parsed.entries()) {
    const expectedPage = index + 1;
    const envelope = item.envelope;
    if (canonicalSnapshotJson(envelope) !== canonicalSnapshotJson(first)) {
      fail(`responses[${index}] mixes snapshot, source, schema or manifest fields`);
    }
    if (item.page.pageNumber !== expectedPage) fail(`snapshot pages must be contiguous; expected page ${expectedPage}`);
    if (expectedPage === 1) {
      if (item.page.cursor !== null || item.page.previousPageSha256 !== null) {
        fail('snapshot page 1 cursor and previousPageSha256 must be null');
      }
    } else {
      const previous = parsed[index - 1]!.page;
      if (item.page.cursor === null || item.page.cursor !== previous.nextCursor) {
        fail(`snapshot page ${expectedPage} cursor must equal the previous nextCursor`);
      }
      if (item.page.previousPageSha256 !== previous.pageSha256) {
        fail(`snapshot page ${expectedPage} previousPageSha256 must equal the previous page hash`);
      }
    }
    if (expectedPage < parsed.length && item.page.nextCursor === null) {
      fail(`snapshot page ${expectedPage} must provide nextCursor`);
    }
    if (expectedPage === parsed.length && item.page.nextCursor !== null) {
      fail('the final snapshot page nextCursor must be null');
    }
    if (parsed.length > 1 && expectedPage < parsed.length && item.page.records.length === 0) {
      fail(`non-final snapshot page ${expectedPage} must not be empty`);
    }
    const expectedHash = propertyPredatorSnapshotPageSha256({
      snapshotId: first.snapshotId,
      pageNumber: item.page.pageNumber,
      cursor: item.page.cursor,
      nextCursor: item.page.nextCursor,
      previousPageSha256: item.page.previousPageSha256,
      records: item.page.records,
    });
    if (item.page.pageSha256 !== expectedHash) fail(`snapshot page ${expectedPage} hash does not match canonical bytes`);
    pageHashes.push(expectedHash);
    item.page.records.forEach((record, recordIndex) => {
      positioned.push({ pageNumber: expectedPage, recordIndex, record });
    });
  }
  if (first.manifest.recordCount !== positioned.length) {
    fail('manifest.recordCount must equal the sum of records across all pages');
  }
  for (let index = 1; index < positioned.length; index += 1) {
    if (positioned[index]!.record.account.id < positioned[index - 1]!.record.account.id) {
      fail('snapshot records must be globally ordered by ascending account.id across pages');
    }
  }
  const contentSha256 = propertyPredatorSnapshotContentSha256({
    schemaVersion: 2,
    sourceSystem: PROPERTY_PREDATOR_ACCOUNT_SNAPSHOT_SOURCE,
    snapshotId: first.snapshotId,
    generatedAt: first.generatedAt,
    watermark: first.watermark,
    complete: true,
    pageCount: first.manifest.pageCount,
    recordCount: first.manifest.recordCount,
    eventHighWatermark: first.manifest.eventHighWatermark,
    pageSha256: pageHashes,
  });
  if (first.manifest.contentSha256 !== contentSha256) fail('manifest.contentSha256 does not match the ordered page set');

  const pages = Object.freeze(parsed.map(({ page }) => page));
  const records = Object.freeze(positioned.map(({ record }) => record));
  const recordIssues = Object.freeze(inspectRecordIntegrity(positioned));
  const envelopeJson = canonicalSnapshotJson({ ...first, pages });
  return Object.freeze({
    schemaVersion: 2,
    sourceSystem: PROPERTY_PREDATOR_ACCOUNT_SNAPSHOT_SOURCE,
    snapshotId: first.snapshotId,
    generatedAt: first.generatedAt,
    watermark: first.watermark,
    manifest: first.manifest,
    pages,
    records,
    recordIssues,
    envelopeJson,
    envelopeSha256: sha256(envelopeJson),
    legacyBatch: adaptToLegacy(first.snapshotId, positioned, recordIssues),
    consentDefault: 'unknown',
  });
}
