import { createHash } from 'node:crypto';
import { types as nodeUtilTypes } from 'node:util';
import {
  canonicalPropertyPredatorAiInventoryJson,
  parsePropertyPredatorAiInventory,
  PropertyPredatorAiInventoryContractError,
  type PropertyPredatorAiInventory,
} from '../company-content-adapter/property-predator-ai-inventory.js';

/** Exact source authority for this deliberately dark Growth HQ slice. */
export const PROPERTY_PREDATOR_COMPANY_ASSET_SOURCE_COMMIT =
  'b5986c94d0f8690236c9f290ba14b49cc978e887' as const;

export const COMPANY_ASSET_BRIDGE_SCHEMA_VERSION = 1 as const;
export const COMPANY_ASSET_RELEASE_ID = 'property-predator.company-content-growth-hq/v1' as const;
export const COMPANY_ASSET_SOURCE_SYSTEM = 'property-predator' as const;

const MAX_RELEASE_BYTES = 512 * 1024;
const MAX_APPROVED_ITEMS = 500;
const MAX_DEPTH = 12;
const MAX_NODES = 15_000;
const MAX_KEYS = 20_000;
const MAX_ARRAY_LENGTH = 1_000;
const MAX_STRING_CHARS = 4_096;
const MAX_TOTAL_STRING_CHARS = 512 * 1024;
const MAX_KEY_CHARS = 100;
export const COMPANY_ASSET_MAX_APPROVAL_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const COMPANY_ASSET_MAX_APPROVAL_CLOCK_SKEW_MICROS =
  BigInt(COMPANY_ASSET_MAX_APPROVAL_CLOCK_SKEW_MS) * 1_000n;

const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_VERSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u;
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|([+-])(\d{2}):(\d{2}))$/u;

const ENVELOPE_KEYS = ['generatedAt', 'release', 'releaseSha256', 'schemaVersion'] as const;
const RELEASE_KEYS = [
  'approvedItemCount', 'approvedItems', 'brandBrain', 'contract', 'releaseId',
  'sourceCatalogSha256', 'sourceSystem',
] as const;
const BRIDGE_CONTRACT_KEYS = [
  'affiliateMode', 'approvedContentBodies', 'assetBytes', 'consumer',
  'customerPrivateData', 'generation', 'hqApprovalRequired', 'mode',
  'providerEffects', 'rawPromptKnowledgeBodies',
] as const;
const BRAND_BRAIN_KEYS = [
  'hqUseStatus', 'manifest', 'runtimeBrandSha256', 'sourceApprovalStatus',
] as const;
const ITEM_KEYS = [
  'affiliateMode', 'approvalExpiresAt', 'approvalExpiryStatus', 'approvalId', 'approvedAt',
  'assetResourcePath', 'blobSha256', 'brandSha256', 'contentMode', 'contentResourcePath',
  'contentSha256', 'hqUseStatus', 'itemId', 'itemType', 'itemVersion', 'ownershipStatus',
  'privacyStatus', 'quarantineStatus', 'sourceApprovalStatus', 'versionId',
] as const;

const SCOPE_KEYS = [
  'approvedItems', 'brandBrainPackageSha256', 'releaseId', 'releaseSha256',
  'runtimeBrandSha256', 'schemaVersion', 'sourceCatalogSha256', 'sourceSystem',
] as const;
const APPROVAL_KEYS = [
  'approvalAuthority', 'approvalExpiresAt', 'approvalId', 'approvalStatus', 'approvedAt',
  'hqHumanApproval', 'schemaVersion', 'scope', 'scopeSha256',
] as const;

export const PROPERTY_PREDATOR_GROWTH_HQ_BRIDGE_CONTRACT = deepFreeze({
  affiliateMode: 'forbidden',
  approvedContentBodies: 'exact-version-resource-only',
  assetBytes: 'approved-asset-resource-only',
  consumer: 'growth-hq',
  customerPrivateData: 'forbidden',
  generation: 'not-exposed',
  hqApprovalRequired: true,
  mode: 'company-owned',
  providerEffects: 'not-exposed',
  rawPromptKnowledgeBodies: 'forbidden',
} as const);

/**
 * A description only. This domain exports no generation, model, source, publish,
 * transport or provider operation.
 */
export const COMPANY_OWNED_GENERATION_CONTRACT = deepFreeze({
  mode: 'simulated_draft_only',
  ownershipMode: 'company_owned',
  affiliateInput: 'forbidden',
  sessionInput: 'forbidden',
  customerInput: 'forbidden',
  customerPrivateDataInput: 'forbidden',
  privateDataInput: 'forbidden',
  rawPromptInput: 'forbidden',
  rawKnowledgeInput: 'forbidden',
  hqHumanApprovalRequired: true,
  modelCalls: false,
  sourceCalls: false,
  providerEffects: false,
  publishEffects: false,
} as const);

export type CompanyAssetItemType = 'asset' | 'generated' | 'media';
export type CompanyAssetItemUsabilityReasonCode =
  | 'source_approval_missing'
  | 'source_approval_unknown'
  | 'source_approval_unapproved'
  | 'source_approval_expired'
  | 'source_approval_expiry_missing'
  | 'source_approval_expiry_unknown'
  | 'source_approval_expired_by_time'
  | 'source_quarantine_unknown'
  | 'source_quarantined';

export interface CompanyAssetReleaseItem {
  readonly affiliateMode: 'forbidden';
  readonly approvalExpiresAt: null;
  readonly approvalExpiryStatus: 'missing';
  readonly approvalId: string;
  readonly approvedAt: string;
  readonly assetResourcePath: string | null;
  readonly blobSha256: string | null;
  readonly brandSha256: string;
  readonly contentMode: 'company-owned';
  readonly contentResourcePath: string;
  readonly contentSha256: string;
  readonly hqUseStatus: 'review-required';
  readonly itemId: string;
  readonly itemType: CompanyAssetItemType;
  readonly itemVersion: number;
  readonly ownershipStatus: 'source-asserted-company-owned';
  readonly privacyStatus: 'customer-private-data-forbidden';
  readonly quarantineStatus: 'not-recorded-at-source';
  readonly sourceApprovalStatus: 'source-approved-exact-version';
  readonly versionId: string;
  readonly usable: false;
  readonly usabilityReasonCodes: readonly CompanyAssetItemUsabilityReasonCode[];
}

export interface CompanyAssetReleaseScopeItem {
  readonly affiliateMode: string;
  readonly approvalExpiresAt: string | null;
  readonly approvalExpiryStatus: string;
  readonly approvalId: string;
  readonly approvedAt: string;
  readonly assetResourcePath: string | null;
  readonly blobSha256: string | null;
  readonly brandSha256: string;
  readonly contentMode: string;
  readonly contentResourcePath: string;
  readonly contentSha256: string;
  readonly hqUseStatus: string;
  readonly itemId: string;
  readonly itemType: CompanyAssetItemType;
  readonly itemVersion: number;
  readonly ownershipStatus: string;
  readonly privacyStatus: string;
  readonly quarantineStatus: string;
  readonly sourceApprovalStatus: string;
  readonly versionId: string;
}

export interface CompanyAssetReleaseScope {
  readonly approvedItems: readonly CompanyAssetReleaseScopeItem[];
  readonly brandBrainPackageSha256: string;
  readonly releaseId: typeof COMPANY_ASSET_RELEASE_ID;
  readonly releaseSha256: string;
  readonly runtimeBrandSha256: string;
  readonly schemaVersion: 1;
  readonly sourceCatalogSha256: string;
  readonly sourceSystem: typeof COMPANY_ASSET_SOURCE_SYSTEM;
}

export interface CompanyAssetRelease {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly releaseId: typeof COMPANY_ASSET_RELEASE_ID;
  readonly sourceSystem: typeof COMPANY_ASSET_SOURCE_SYSTEM;
  readonly releaseSha256: string;
  readonly sourceCatalogSha256: string;
  readonly contract: typeof PROPERTY_PREDATOR_GROWTH_HQ_BRIDGE_CONTRACT;
  readonly brandBrain: Readonly<{
    sourceApprovalStatus: 'source-current';
    hqUseStatus: 'review-required';
    runtimeBrandSha256: string;
    manifest: PropertyPredatorAiInventory;
  }>;
  readonly approvedItemCount: number;
  readonly approvedItems: readonly CompanyAssetReleaseItem[];
  readonly scope: CompanyAssetReleaseScope;
  readonly scopeSha256: string;
  readonly generationContract: typeof COMPANY_OWNED_GENERATION_CONTRACT;
  readonly usable: false;
  readonly usabilityReasonCodes: readonly CompanyAssetReleaseUsabilityReasonCode[];
}

export interface CompanyAssetFounderApproval {
  readonly schemaVersion: 1;
  readonly approvalId: string;
  readonly approvalStatus: 'founder_approved';
  readonly approvalAuthority: 'growth_hq_founder';
  readonly hqHumanApproval: true;
  readonly approvedAt: string;
  readonly approvalExpiresAt: string;
  readonly scope: CompanyAssetReleaseScope;
  readonly scopeSha256: string;
}

export type CompanyAssetReconciliationReasonCode =
  | 'founder_approval_missing'
  | 'founder_approval_invalid'
  | 'founder_approval_not_yet_effective'
  | 'founder_approval_expired'
  | 'release_hash_changed'
  | 'source_catalog_hash_changed'
  | 'brand_hash_changed'
  | 'brand_inventory_hash_changed'
  | 'item_added'
  | 'item_removed'
  | 'item_version_changed'
  | 'item_hash_changed'
  | 'item_status_changed'
  | 'item_path_changed'
  | 'item_approval_changed'
  | 'scope_changed';

export type CompanyAssetReleaseUsabilityReasonCode =
  | 'hq_human_approval_required'
  | 'source_material_missing'
  | CompanyAssetItemUsabilityReasonCode;

export interface CompanyAssetReleaseReconciliation {
  readonly status: 'reconciled' | 'review_required';
  readonly evaluatedAt: string;
  readonly usable: boolean;
  readonly reconciliationReasonCodes: readonly CompanyAssetReconciliationReasonCode[];
  readonly usabilityReasonCodes: readonly CompanyAssetReleaseUsabilityReasonCode[];
  readonly currentScopeSha256: string;
  readonly approvedScopeSha256: string | null;
  readonly reconciliationSha256: string;
  readonly release: CompanyAssetRelease;
  readonly generationContract: typeof COMPANY_OWNED_GENERATION_CONTRACT;
}

export class CompanyAssetReleaseContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompanyAssetReleaseContractError';
  }
}

type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

interface PlainDataBudget {
  nodes: number;
  keys: number;
  stringChars: number;
}

function deepFreeze<T>(value: T, seen = new Set<object>()): Readonly<T> {
  if (value && typeof value === 'object' && !seen.has(value)) {
    seen.add(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
    if (!Object.isFrozen(value)) Object.freeze(value);
  }
  return value;
}

function plainDataError(label: string, detail: string): never {
  throw new CompanyAssetReleaseContractError(`${label} ${detail}`);
}

function snapshotValue(
  value: unknown,
  label: string,
  depth: number,
  budget: PlainDataBudget,
): JsonValue {
  budget.nodes += 1;
  if (budget.nodes > MAX_NODES) plainDataError(label, 'exceeds the total node bound');
  if (depth > MAX_DEPTH) plainDataError(label, 'exceeds the depth bound');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) plainDataError(label, 'contains a non-finite number');
    return value;
  }
  if (typeof value === 'string') {
    if (value.length > MAX_STRING_CHARS) plainDataError(label, 'contains an oversized string');
    budget.stringChars += value.length;
    if (budget.stringChars > MAX_TOTAL_STRING_CHARS) {
      plainDataError(label, 'exceeds the total string bound');
    }
    return value;
  }
  if (typeof value !== 'object') plainDataError(label, 'is not plain JSON data');
  if (nodeUtilTypes.isProxy(value)) plainDataError(label, 'must not be a Proxy');

  let prototype: object | null;
  let descriptors: PropertyDescriptorMap;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    plainDataError(label, 'cannot be inspected as plain data');
  }

  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) plainDataError(label, 'has a surprising array prototype');
    const lengthDescriptor = descriptors.length;
    const length = lengthDescriptor && 'value' in lengthDescriptor ? lengthDescriptor.value : undefined;
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_ARRAY_LENGTH) {
      plainDataError(label, 'exceeds the array bound');
    }
    const keys = Reflect.ownKeys(descriptors).filter((key) => key !== 'length');
    if (keys.some((key) => typeof key !== 'string') || keys.length !== length) {
      plainDataError(label, 'must be a dense array without extra properties');
    }
    budget.keys += keys.length;
    if (budget.keys > MAX_KEYS) plainDataError(label, 'exceeds the total key bound');
    const clone: JsonValue[] = new Array(length);
    for (let index = 0; index < length; index += 1) {
      const key = String(index);
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
        plainDataError(`${label}[${index}]`, 'is an accessor, hole or hidden property');
      }
      clone[index] = snapshotValue(descriptor.value, `${label}[${index}]`, depth + 1, budget);
    }
    return clone;
  }

  if (prototype !== Object.prototype && prototype !== null) {
    plainDataError(label, 'has a surprising object prototype');
  }
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== 'string')) plainDataError(label, 'contains a symbol key');
  budget.keys += keys.length;
  if (budget.keys > MAX_KEYS) plainDataError(label, 'exceeds the total key bound');
  const clone = Object.create(null) as { [key: string]: JsonValue };
  for (const rawKey of keys) {
    const key = rawKey as string;
    if (key.length < 1 || key.length > MAX_KEY_CHARS || /[\u0000-\u001f\u007f]/u.test(key)
        || key === '__proto__' || key === 'prototype' || key === 'constructor') {
      plainDataError(label, 'contains an unsafe key');
    }
    budget.stringChars += key.length;
    if (budget.stringChars > MAX_TOTAL_STRING_CHARS) {
      plainDataError(label, 'exceeds the total string bound');
    }
    const descriptor = descriptors[key];
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      plainDataError(`${label} field`, 'must be an enumerable data property');
    }
    clone[key] = snapshotValue(descriptor.value, `${label} field`, depth + 1, budget);
  }
  return clone;
}

function snapshotPlainData(input: unknown, label: string): Record<string, JsonValue> {
  const snapshot = snapshotValue(input, label, 0, { nodes: 0, keys: 0, stringChars: 0 });
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    plainDataError(label, 'must be an object');
  }
  let canonical: string;
  try {
    canonical = canonicalPropertyPredatorAiInventoryJson(snapshot);
  } catch {
    plainDataError(label, 'cannot be canonically encoded');
  }
  if (Buffer.byteLength(canonical, 'utf8') > MAX_RELEASE_BYTES) {
    plainDataError(label, 'exceeds the byte bound');
  }
  return snapshot as Record<string, JsonValue>;
}

function record(value: JsonValue | undefined, label: string): Record<string, JsonValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CompanyAssetReleaseContractError(`${label} must be an object`);
  }
  return value;
}

function exactKeys(
  value: Record<string, JsonValue>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new CompanyAssetReleaseContractError(`${label} has unknown or missing fields`);
  }
}

function literal<const T extends string | boolean | number>(
  value: JsonValue | undefined,
  expected: T,
  label: string,
): T {
  if (value !== expected) throw new CompanyAssetReleaseContractError(`${label} is unsupported`);
  return expected;
}

function oneOf<const T extends readonly string[]>(
  value: JsonValue | undefined,
  options: T,
  label: string,
): T[number] {
  if (typeof value !== 'string' || !(options as readonly string[]).includes(value)) {
    throw new CompanyAssetReleaseContractError(`${label} is unsupported`);
  }
  return value as T[number];
}

function sha256(value: JsonValue | undefined, label: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new CompanyAssetReleaseContractError(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function boundedId(value: JsonValue | undefined, label: string): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw new CompanyAssetReleaseContractError(`${label} must be a safe identifier`);
  }
  return value;
}

function versionId(value: JsonValue | undefined, label: string): string {
  if (typeof value !== 'string' || !SAFE_VERSION_ID.test(value)) {
    throw new CompanyAssetReleaseContractError(`${label} must be a safe version identifier`);
  }
  return value;
}

function positiveInteger(value: JsonValue | undefined, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 2_147_483_647) {
    throw new CompanyAssetReleaseContractError(`${label} must be a bounded positive integer`);
  }
  return value as number;
}

function nonNegativeInteger(value: JsonValue | undefined, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new CompanyAssetReleaseContractError(`${label} must be a bounded non-negative integer`);
  }
  return value as number;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function instant(value: JsonValue | undefined, label: string): string {
  if (typeof value !== 'string') {
    throw new CompanyAssetReleaseContractError(`${label} must be a canonical RFC3339 instant`);
  }
  const match = RFC3339.exec(value);
  if (!match) throw new CompanyAssetReleaseContractError(`${label} must be a canonical RFC3339 instant`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetSign = match[9];
  const offsetHour = match[10] === undefined ? 0 : Number(match[10]);
  const offsetMinute = match[11] === undefined ? 0 : Number(match[11]);
  const days = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year === 0 || month < 1 || month > 12 || day < 1 || day > days[month - 1]!
      || hour > 23 || minute > 59 || second > 59
      || offsetHour > 23 || offsetMinute > 59
      || (offsetSign === '-' && offsetHour === 0 && offsetMinute === 0)
      || !Number.isFinite(Date.parse(value))) {
    throw new CompanyAssetReleaseContractError(`${label} must be a valid canonical RFC3339 instant`);
  }
  return value;
}

function instantEpochMicros(value: string): bigint {
  const match = RFC3339.exec(value);
  if (!match) throw new CompanyAssetReleaseContractError('validated instant cannot be compared');
  const fraction = (match[7] ?? '').padEnd(6, '0');
  const secondPrecision = match[7] === undefined ? value : value.replace(`.${match[7]}`, '');
  const epochMs = Date.parse(secondPrecision);
  if (!Number.isFinite(epochMs)) {
    throw new CompanyAssetReleaseContractError('validated instant cannot be compared');
  }
  return BigInt(epochMs) * 1_000n + BigInt(fraction || '0');
}

function canonicalSha256(value: unknown): string {
  return createHash('sha256')
    .update(canonicalPropertyPredatorAiInventoryJson(value), 'utf8')
    .digest('hex');
}

function itemSortKey(item: Pick<CompanyAssetReleaseScopeItem, 'itemType' | 'itemId' | 'itemVersion'>): string {
  return `${item.itemType}\u001f${item.itemId}\u001f${String(item.itemVersion).padStart(10, '0')}`;
}

const ITEM_BLOCKERS = Object.freeze([
  'source_approval_expiry_missing',
  'source_quarantine_unknown',
] as const satisfies readonly CompanyAssetItemUsabilityReasonCode[]);

function parseReleaseItem(
  value: JsonValue,
  index: number,
  runtimeBrandSha256: string,
): CompanyAssetReleaseItem {
  const label = `release.approvedItems[${index}]`;
  const item = record(value, label);
  exactKeys(item, ITEM_KEYS, label);
  const itemType = oneOf(item.itemType, ['media', 'asset', 'generated'] as const, `${label}.itemType`);
  const parsedVersionId = versionId(item.versionId, `${label}.versionId`);
  const parsedItemId = boundedId(item.itemId, `${label}.itemId`);
  const parsedBrandSha256 = sha256(item.brandSha256, `${label}.brandSha256`);
  if (parsedBrandSha256 !== runtimeBrandSha256) {
    throw new CompanyAssetReleaseContractError(`${label}.brandSha256 does not match the runtime brand`);
  }
  const blobSha256 = item.blobSha256 === null
    ? null
    : sha256(item.blobSha256, `${label}.blobSha256`);
  const assetResourcePath = item.assetResourcePath === null
    ? null
    : typeof item.assetResourcePath === 'string' ? item.assetResourcePath : '';
  if (itemType === 'asset') {
    if (!blobSha256 || assetResourcePath !== `/api/internal/company-content/assets/${parsedVersionId}/file`) {
      throw new CompanyAssetReleaseContractError(`${label} has an invalid asset resource path or blob hash`);
    }
  } else if (blobSha256 !== null || assetResourcePath !== null) {
    throw new CompanyAssetReleaseContractError(`${label} exposes asset bytes for a non-asset item`);
  }
  const contentResourcePath = typeof item.contentResourcePath === 'string'
    ? item.contentResourcePath
    : '';
  if (contentResourcePath !== `/api/internal/company-content/versions/${parsedVersionId}`) {
    throw new CompanyAssetReleaseContractError(`${label}.contentResourcePath is invalid`);
  }
  if (item.approvalExpiresAt !== null) {
    throw new CompanyAssetReleaseContractError(`${label} invents source approval expiry evidence`);
  }
  return deepFreeze({
    affiliateMode: literal(item.affiliateMode, 'forbidden', `${label}.affiliateMode`),
    approvalExpiresAt: null,
    approvalExpiryStatus: literal(item.approvalExpiryStatus, 'missing', `${label}.approvalExpiryStatus`),
    approvalId: boundedId(item.approvalId, `${label}.approvalId`),
    approvedAt: instant(item.approvedAt, `${label}.approvedAt`),
    assetResourcePath,
    blobSha256,
    brandSha256: parsedBrandSha256,
    contentMode: literal(item.contentMode, 'company-owned', `${label}.contentMode`),
    contentResourcePath,
    contentSha256: sha256(item.contentSha256, `${label}.contentSha256`),
    hqUseStatus: literal(item.hqUseStatus, 'review-required', `${label}.hqUseStatus`),
    itemId: parsedItemId,
    itemType,
    itemVersion: positiveInteger(item.itemVersion, `${label}.itemVersion`),
    ownershipStatus: literal(
      item.ownershipStatus,
      'source-asserted-company-owned',
      `${label}.ownershipStatus`,
    ),
    privacyStatus: literal(
      item.privacyStatus,
      'customer-private-data-forbidden',
      `${label}.privacyStatus`,
    ),
    quarantineStatus: literal(
      item.quarantineStatus,
      'not-recorded-at-source',
      `${label}.quarantineStatus`,
    ),
    sourceApprovalStatus: literal(
      item.sourceApprovalStatus,
      'source-approved-exact-version',
      `${label}.sourceApprovalStatus`,
    ),
    versionId: parsedVersionId,
    usable: false,
    usabilityReasonCodes: ITEM_BLOCKERS,
  });
}

function scopeItem(item: CompanyAssetReleaseItem): CompanyAssetReleaseScopeItem {
  return deepFreeze({
    affiliateMode: item.affiliateMode,
    approvalExpiresAt: item.approvalExpiresAt,
    approvalExpiryStatus: item.approvalExpiryStatus,
    approvalId: item.approvalId,
    approvedAt: item.approvedAt,
    assetResourcePath: item.assetResourcePath,
    blobSha256: item.blobSha256,
    brandSha256: item.brandSha256,
    contentMode: item.contentMode,
    contentResourcePath: item.contentResourcePath,
    contentSha256: item.contentSha256,
    hqUseStatus: item.hqUseStatus,
    itemId: item.itemId,
    itemType: item.itemType,
    itemVersion: item.itemVersion,
    ownershipStatus: item.ownershipStatus,
    privacyStatus: item.privacyStatus,
    quarantineStatus: item.quarantineStatus,
    sourceApprovalStatus: item.sourceApprovalStatus,
    versionId: item.versionId,
  });
}

function validateCanonicalItemOrder(items: readonly CompanyAssetReleaseScopeItem[], label: string): void {
  const identities = new Set<string>();
  const identityVersions = new Set<string>();
  const versionIds = new Set<string>();
  let previous: string | null = null;
  for (const item of items) {
    const identity = itemIdentity(item);
    const current = itemSortKey(item);
    if (identityVersions.has(current)) {
      throw new CompanyAssetReleaseContractError(`${label} repeats an item identity/version`);
    }
    if (identities.has(identity)) {
      throw new CompanyAssetReleaseContractError(`${label} repeats an item identity`);
    }
    if (versionIds.has(item.versionId)) {
      throw new CompanyAssetReleaseContractError(`${label} repeats a versionId`);
    }
    if (previous !== null && current <= previous) {
      throw new CompanyAssetReleaseContractError(`${label} must be in canonical order`);
    }
    identities.add(identity);
    identityVersions.add(current);
    previous = current;
    versionIds.add(item.versionId);
  }
}

export function parseCompanyAssetReleaseBridge(input: unknown): CompanyAssetRelease {
  const envelope = snapshotPlainData(input, 'company asset bridge envelope');
  exactKeys(envelope, ENVELOPE_KEYS, 'bridge envelope');
  literal(envelope.schemaVersion, COMPANY_ASSET_BRIDGE_SCHEMA_VERSION, 'bridge.schemaVersion');
  const generatedAt = instant(envelope.generatedAt, 'bridge.generatedAt');
  const releaseSha256 = sha256(envelope.releaseSha256, 'bridge.releaseSha256');
  const release = record(envelope.release, 'bridge.release');
  exactKeys(release, RELEASE_KEYS, 'bridge.release');
  if (canonicalSha256(release) !== releaseSha256) {
    throw new CompanyAssetReleaseContractError('bridge.releaseSha256 does not verify the exact release');
  }
  literal(release.releaseId, COMPANY_ASSET_RELEASE_ID, 'release.releaseId');
  literal(release.sourceSystem, COMPANY_ASSET_SOURCE_SYSTEM, 'release.sourceSystem');
  const sourceCatalogSha256 = sha256(release.sourceCatalogSha256, 'release.sourceCatalogSha256');

  const contract = record(release.contract, 'release.contract');
  exactKeys(contract, BRIDGE_CONTRACT_KEYS, 'release.contract');
  for (const [key, expected] of Object.entries(PROPERTY_PREDATOR_GROWTH_HQ_BRIDGE_CONTRACT)) {
    literal(contract[key], expected, `release.contract.${key}`);
  }

  const brandBrain = record(release.brandBrain, 'release.brandBrain');
  exactKeys(brandBrain, BRAND_BRAIN_KEYS, 'release.brandBrain');
  literal(brandBrain.sourceApprovalStatus, 'source-current', 'release.brandBrain.sourceApprovalStatus');
  literal(brandBrain.hqUseStatus, 'review-required', 'release.brandBrain.hqUseStatus');
  const runtimeBrandSha256 = sha256(
    brandBrain.runtimeBrandSha256,
    'release.brandBrain.runtimeBrandSha256',
  );
  let manifest: PropertyPredatorAiInventory;
  try {
    manifest = parsePropertyPredatorAiInventory(brandBrain.manifest);
  } catch (error) {
    if (error instanceof PropertyPredatorAiInventoryContractError) {
      throw new CompanyAssetReleaseContractError(`release.brandBrain.manifest is invalid: ${error.message}`);
    }
    throw error;
  }
  if (manifest.sourceSystem !== COMPANY_ASSET_SOURCE_SYSTEM
      || manifest.specialistProfiles.some((profile) => profile.runtimeBrandSha256 !== runtimeBrandSha256)) {
    throw new CompanyAssetReleaseContractError('release.brandBrain runtime brand identity is inconsistent');
  }
  deepFreeze(manifest);

  if (!Array.isArray(release.approvedItems)) {
    throw new CompanyAssetReleaseContractError('release.approvedItems must be a bounded array');
  }
  const itemCount = nonNegativeInteger(
    release.approvedItemCount,
    'release.approvedItemCount',
    MAX_APPROVED_ITEMS,
  );
  if (release.approvedItems.length !== itemCount || release.approvedItems.length > MAX_APPROVED_ITEMS) {
    throw new CompanyAssetReleaseContractError('release.approvedItemCount does not match');
  }
  const approvedItems = Object.freeze(release.approvedItems.map((item, index) =>
    parseReleaseItem(item, index, runtimeBrandSha256)));
  validateCanonicalItemOrder(approvedItems, 'release.approvedItems');

  const scope = deepFreeze({
    approvedItems: Object.freeze(approvedItems.map(scopeItem)),
    brandBrainPackageSha256: manifest.packageSha256,
    releaseId: COMPANY_ASSET_RELEASE_ID,
    releaseSha256,
    runtimeBrandSha256,
    schemaVersion: 1 as const,
    sourceCatalogSha256,
    sourceSystem: COMPANY_ASSET_SOURCE_SYSTEM,
  });
  const scopeSha256 = companyAssetReleaseScopeSha256(scope);
  const usabilityReasonCodes = releaseUsabilityReasons(approvedItems, false);
  return deepFreeze({
    schemaVersion: 1 as const,
    generatedAt,
    releaseId: COMPANY_ASSET_RELEASE_ID,
    sourceSystem: COMPANY_ASSET_SOURCE_SYSTEM,
    releaseSha256,
    sourceCatalogSha256,
    contract: PROPERTY_PREDATOR_GROWTH_HQ_BRIDGE_CONTRACT,
    brandBrain: deepFreeze({
      sourceApprovalStatus: 'source-current' as const,
      hqUseStatus: 'review-required' as const,
      runtimeBrandSha256,
      manifest,
    }),
    approvedItemCount: itemCount,
    approvedItems,
    scope,
    scopeSha256,
    generationContract: COMPANY_OWNED_GENERATION_CONTRACT,
    usable: false as const,
    usabilityReasonCodes,
  });
}

export function companyAssetReleaseScopeSha256(scope: CompanyAssetReleaseScope): string {
  return canonicalSha256(scope);
}

const SOURCE_APPROVAL_STATUSES = [
  'source-approved-exact-version', 'missing', 'unknown', 'unapproved', 'expired', 'revoked',
] as const;
const HQ_USE_STATUSES = ['review-required', 'approved'] as const;
const APPROVAL_EXPIRY_STATUSES = ['missing', 'unknown', 'current', 'expired'] as const;
const QUARANTINE_STATUSES = ['not-recorded-at-source', 'unknown', 'clear', 'quarantined'] as const;
const OWNERSHIP_STATUSES = ['source-asserted-company-owned', 'unknown', 'disputed'] as const;
const PRIVACY_STATUSES = ['customer-private-data-forbidden', 'unknown', 'customer-private-data-present'] as const;

function parseScopeItem(value: JsonValue, index: number, runtimeBrandSha256: string): CompanyAssetReleaseScopeItem {
  const label = `approval.scope.approvedItems[${index}]`;
  const item = record(value, label);
  exactKeys(item, ITEM_KEYS, label);
  const itemType = oneOf(item.itemType, ['media', 'asset', 'generated'] as const, `${label}.itemType`);
  const parsedVersionId = versionId(item.versionId, `${label}.versionId`);
  const parsedBrandSha256 = sha256(item.brandSha256, `${label}.brandSha256`);
  if (parsedBrandSha256 !== runtimeBrandSha256) {
    throw new CompanyAssetReleaseContractError(`${label}.brandSha256 does not match its approved scope brand`);
  }
  const blobSha256 = item.blobSha256 === null
    ? null
    : sha256(item.blobSha256, `${label}.blobSha256`);
  const assetResourcePath = item.assetResourcePath === null
    ? null
    : typeof item.assetResourcePath === 'string' ? item.assetResourcePath : '';
  if (itemType === 'asset') {
    if (!blobSha256 || assetResourcePath !== `/api/internal/company-content/assets/${parsedVersionId}/file`) {
      throw new CompanyAssetReleaseContractError(`${label} has an invalid asset path or blob hash`);
    }
  } else if (blobSha256 !== null || assetResourcePath !== null) {
    throw new CompanyAssetReleaseContractError(`${label} has non-asset blob provenance`);
  }
  const contentResourcePath = typeof item.contentResourcePath === 'string'
    ? item.contentResourcePath
    : '';
  if (contentResourcePath !== `/api/internal/company-content/versions/${parsedVersionId}`) {
    throw new CompanyAssetReleaseContractError(`${label}.contentResourcePath is invalid`);
  }
  const approvalExpiryStatus = oneOf(
    item.approvalExpiryStatus,
    APPROVAL_EXPIRY_STATUSES,
    `${label}.approvalExpiryStatus`,
  );
  const approvalExpiresAt = item.approvalExpiresAt === null
    ? null
    : instant(item.approvalExpiresAt, `${label}.approvalExpiresAt`);
  if ((approvalExpiryStatus === 'current' || approvalExpiryStatus === 'expired') !== (approvalExpiresAt !== null)) {
    throw new CompanyAssetReleaseContractError(`${label} has inconsistent approval expiry evidence`);
  }
  return deepFreeze({
    affiliateMode: oneOf(item.affiliateMode, ['forbidden', 'allowed'] as const, `${label}.affiliateMode`),
    approvalExpiresAt,
    approvalExpiryStatus,
    approvalId: boundedId(item.approvalId, `${label}.approvalId`),
    approvedAt: instant(item.approvedAt, `${label}.approvedAt`),
    assetResourcePath,
    blobSha256,
    brandSha256: parsedBrandSha256,
    contentMode: oneOf(item.contentMode, ['company-owned', 'affiliate'] as const, `${label}.contentMode`),
    contentResourcePath,
    contentSha256: sha256(item.contentSha256, `${label}.contentSha256`),
    hqUseStatus: oneOf(item.hqUseStatus, HQ_USE_STATUSES, `${label}.hqUseStatus`),
    itemId: boundedId(item.itemId, `${label}.itemId`),
    itemType,
    itemVersion: positiveInteger(item.itemVersion, `${label}.itemVersion`),
    ownershipStatus: oneOf(item.ownershipStatus, OWNERSHIP_STATUSES, `${label}.ownershipStatus`),
    privacyStatus: oneOf(item.privacyStatus, PRIVACY_STATUSES, `${label}.privacyStatus`),
    quarantineStatus: oneOf(item.quarantineStatus, QUARANTINE_STATUSES, `${label}.quarantineStatus`),
    sourceApprovalStatus: oneOf(
      item.sourceApprovalStatus,
      SOURCE_APPROVAL_STATUSES,
      `${label}.sourceApprovalStatus`,
    ),
    versionId: parsedVersionId,
  });
}

function parseScope(value: JsonValue | undefined): CompanyAssetReleaseScope {
  const scope = record(value, 'approval.scope');
  exactKeys(scope, SCOPE_KEYS, 'approval.scope');
  literal(scope.schemaVersion, 1, 'approval.scope.schemaVersion');
  literal(scope.releaseId, COMPANY_ASSET_RELEASE_ID, 'approval.scope.releaseId');
  literal(scope.sourceSystem, COMPANY_ASSET_SOURCE_SYSTEM, 'approval.scope.sourceSystem');
  const runtimeBrandSha256 = sha256(scope.runtimeBrandSha256, 'approval.scope.runtimeBrandSha256');
  if (!Array.isArray(scope.approvedItems) || scope.approvedItems.length > MAX_APPROVED_ITEMS) {
    throw new CompanyAssetReleaseContractError('approval.scope.approvedItems must be bounded');
  }
  const approvedItems = Object.freeze(scope.approvedItems.map((item, index) =>
    parseScopeItem(item, index, runtimeBrandSha256)));
  validateCanonicalItemOrder(approvedItems, 'approval.scope.approvedItems');
  return deepFreeze({
    approvedItems,
    brandBrainPackageSha256: sha256(
      scope.brandBrainPackageSha256,
      'approval.scope.brandBrainPackageSha256',
    ),
    releaseId: COMPANY_ASSET_RELEASE_ID,
    releaseSha256: sha256(scope.releaseSha256, 'approval.scope.releaseSha256'),
    runtimeBrandSha256,
    schemaVersion: 1 as const,
    sourceCatalogSha256: sha256(scope.sourceCatalogSha256, 'approval.scope.sourceCatalogSha256'),
    sourceSystem: COMPANY_ASSET_SOURCE_SYSTEM,
  });
}

export function parseCompanyAssetFounderApproval(input: unknown): CompanyAssetFounderApproval {
  const approval = snapshotPlainData(input, 'company asset founder approval');
  exactKeys(approval, APPROVAL_KEYS, 'founder approval');
  literal(approval.schemaVersion, 1, 'founder approval.schemaVersion');
  const approvedAt = instant(approval.approvedAt, 'founder approval.approvedAt');
  const approvalExpiresAt = instant(
    approval.approvalExpiresAt,
    'founder approval.approvalExpiresAt',
  );
  if (instantEpochMicros(approvalExpiresAt) <= instantEpochMicros(approvedAt)) {
    throw new CompanyAssetReleaseContractError('founder approval expiry must follow approval time');
  }
  const scope = parseScope(approval.scope);
  const scopeSha256 = sha256(approval.scopeSha256, 'founder approval.scopeSha256');
  if (companyAssetReleaseScopeSha256(scope) !== scopeSha256) {
    throw new CompanyAssetReleaseContractError('founder approval.scopeSha256 does not verify');
  }
  return deepFreeze({
    schemaVersion: 1 as const,
    approvalId: boundedId(approval.approvalId, 'founder approval.approvalId'),
    approvalStatus: literal(
      approval.approvalStatus,
      'founder_approved',
      'founder approval.approvalStatus',
    ),
    approvalAuthority: literal(
      approval.approvalAuthority,
      'growth_hq_founder',
      'founder approval.approvalAuthority',
    ),
    hqHumanApproval: literal(
      approval.hqHumanApproval,
      true,
      'founder approval.hqHumanApproval',
    ),
    approvedAt,
    approvalExpiresAt,
    scope,
    scopeSha256,
  });
}

const RECONCILIATION_REASON_ORDER = Object.freeze([
  'founder_approval_missing',
  'founder_approval_invalid',
  'founder_approval_not_yet_effective',
  'founder_approval_expired',
  'release_hash_changed',
  'source_catalog_hash_changed',
  'brand_hash_changed',
  'brand_inventory_hash_changed',
  'item_added',
  'item_removed',
  'item_version_changed',
  'item_hash_changed',
  'item_status_changed',
  'item_path_changed',
  'item_approval_changed',
  'scope_changed',
] as const satisfies readonly CompanyAssetReconciliationReasonCode[]);

const USABILITY_REASON_ORDER = Object.freeze([
  'hq_human_approval_required',
  'source_material_missing',
  'source_approval_missing',
  'source_approval_unknown',
  'source_approval_unapproved',
  'source_approval_expired',
  'source_approval_expiry_missing',
  'source_approval_expiry_unknown',
  'source_approval_expired_by_time',
  'source_quarantine_unknown',
  'source_quarantined',
] as const satisfies readonly CompanyAssetReleaseUsabilityReasonCode[]);

function itemIdentity(item: CompanyAssetReleaseScopeItem): string {
  return `${item.itemType}\u001f${item.itemId}`;
}

function compareScopes(
  current: CompanyAssetReleaseScope,
  approved: CompanyAssetReleaseScope,
): readonly CompanyAssetReconciliationReasonCode[] {
  const reasons = new Set<CompanyAssetReconciliationReasonCode>();
  if (current.releaseSha256 !== approved.releaseSha256) reasons.add('release_hash_changed');
  if (current.sourceCatalogSha256 !== approved.sourceCatalogSha256) {
    reasons.add('source_catalog_hash_changed');
  }
  if (current.runtimeBrandSha256 !== approved.runtimeBrandSha256) reasons.add('brand_hash_changed');
  if (current.brandBrainPackageSha256 !== approved.brandBrainPackageSha256) {
    reasons.add('brand_inventory_hash_changed');
  }
  const currentItems = new Map(current.approvedItems.map((item) => [itemIdentity(item), item]));
  const approvedItems = new Map(approved.approvedItems.map((item) => [itemIdentity(item), item]));
  for (const [identity, item] of currentItems) {
    const previous = approvedItems.get(identity);
    if (!previous) {
      reasons.add('item_added');
      continue;
    }
    if (item.itemVersion !== previous.itemVersion || item.versionId !== previous.versionId) {
      reasons.add('item_version_changed');
    }
    if (item.contentSha256 !== previous.contentSha256 || item.blobSha256 !== previous.blobSha256) {
      reasons.add('item_hash_changed');
    }
    if (item.brandSha256 !== previous.brandSha256) reasons.add('brand_hash_changed');
    if (item.affiliateMode !== previous.affiliateMode
        || item.approvalExpiresAt !== previous.approvalExpiresAt
        || item.approvalExpiryStatus !== previous.approvalExpiryStatus
        || item.contentMode !== previous.contentMode
        || item.hqUseStatus !== previous.hqUseStatus
        || item.ownershipStatus !== previous.ownershipStatus
        || item.privacyStatus !== previous.privacyStatus
        || item.quarantineStatus !== previous.quarantineStatus
        || item.sourceApprovalStatus !== previous.sourceApprovalStatus) {
      reasons.add('item_status_changed');
    }
    if (item.assetResourcePath !== previous.assetResourcePath
        || item.contentResourcePath !== previous.contentResourcePath) {
      reasons.add('item_path_changed');
    }
    if (item.approvalId !== previous.approvalId || item.approvedAt !== previous.approvedAt) {
      reasons.add('item_approval_changed');
    }
  }
  for (const identity of approvedItems.keys()) {
    if (!currentItems.has(identity)) reasons.add('item_removed');
  }
  if (current.releaseSha256 !== approved.releaseSha256
      && reasons.size === 1 && reasons.has('release_hash_changed')) {
    reasons.add('scope_changed');
  }
  return Object.freeze(RECONCILIATION_REASON_ORDER.filter((reason) => reasons.has(reason)));
}

function releaseUsabilityReasons(
  items: readonly Pick<CompanyAssetReleaseScopeItem,
    'approvalExpiresAt' | 'approvalExpiryStatus' | 'quarantineStatus' | 'sourceApprovalStatus'>[],
  hasReconciledApproval: boolean,
  evaluatedAt?: string,
): readonly CompanyAssetReleaseUsabilityReasonCode[] {
  const reasons = new Set<CompanyAssetReleaseUsabilityReasonCode>();
  if (!hasReconciledApproval) reasons.add('hq_human_approval_required');
  if (items.length === 0) reasons.add('source_material_missing');
  const evaluatedMicros = evaluatedAt === undefined ? null : instantEpochMicros(evaluatedAt);
  for (const item of items) {
    if (item.sourceApprovalStatus === 'missing') reasons.add('source_approval_missing');
    else if (item.sourceApprovalStatus === 'unknown') reasons.add('source_approval_unknown');
    else if (item.sourceApprovalStatus === 'expired' || item.sourceApprovalStatus === 'revoked') {
      reasons.add('source_approval_expired');
    } else if (item.sourceApprovalStatus !== 'source-approved-exact-version') {
      reasons.add('source_approval_unapproved');
    }
    if (item.approvalExpiryStatus === 'missing') reasons.add('source_approval_expiry_missing');
    else if (item.approvalExpiryStatus === 'unknown') reasons.add('source_approval_expiry_unknown');
    else if (item.approvalExpiryStatus === 'expired'
        || (item.approvalExpiresAt !== null
          && evaluatedMicros !== null
          && instantEpochMicros(item.approvalExpiresAt) <= evaluatedMicros)) {
      reasons.add('source_approval_expired_by_time');
    }
    if (item.quarantineStatus === 'not-recorded-at-source' || item.quarantineStatus === 'unknown') {
      reasons.add('source_quarantine_unknown');
    } else if (item.quarantineStatus === 'quarantined') {
      reasons.add('source_quarantined');
    }
  }
  return Object.freeze(USABILITY_REASON_ORDER.filter((reason) => reasons.has(reason)));
}

export function reconcileCompanyAssetRelease(
  release: CompanyAssetRelease,
  previousFounderApproval: unknown | undefined,
  evaluatedAtInput: string,
): CompanyAssetReleaseReconciliation {
  const evaluatedAt = instant(evaluatedAtInput, 'reconciliation.evaluatedAt');
  const reasons = new Set<CompanyAssetReconciliationReasonCode>();
  let approval: CompanyAssetFounderApproval | null = null;
  if (previousFounderApproval === undefined || previousFounderApproval === null) {
    reasons.add('founder_approval_missing');
  } else {
    try {
      approval = parseCompanyAssetFounderApproval(previousFounderApproval);
    } catch (error) {
      if (!(error instanceof CompanyAssetReleaseContractError)) throw error;
      reasons.add('founder_approval_invalid');
    }
  }
  if (approval) {
    const evaluatedMicros = instantEpochMicros(evaluatedAt);
    if (instantEpochMicros(approval.approvedAt)
        > evaluatedMicros + COMPANY_ASSET_MAX_APPROVAL_CLOCK_SKEW_MICROS) {
      reasons.add('founder_approval_not_yet_effective');
    }
    if (instantEpochMicros(approval.approvalExpiresAt) <= evaluatedMicros) {
      reasons.add('founder_approval_expired');
    }
    for (const reason of compareScopes(release.scope, approval.scope)) reasons.add(reason);
  }
  const reconciliationReasonCodes = Object.freeze(
    RECONCILIATION_REASON_ORDER.filter((reason) => reasons.has(reason)),
  );
  const status = reconciliationReasonCodes.length === 0 ? 'reconciled' : 'review_required';
  const usabilityReasonCodes = releaseUsabilityReasons(
    release.approvedItems,
    status === 'reconciled',
    evaluatedAt,
  );
  const usable = status === 'reconciled' && usabilityReasonCodes.length === 0;
  const approvedScopeSha256 = approval?.scopeSha256 ?? null;
  const digestInput = {
    approvedScopeSha256,
    currentScopeSha256: release.scopeSha256,
    evaluatedAt,
    reconciliationReasonCodes,
    schemaVersion: 1,
    status,
    usabilityReasonCodes,
    usable,
  };
  return deepFreeze({
    status,
    evaluatedAt,
    usable,
    reconciliationReasonCodes,
    usabilityReasonCodes,
    currentScopeSha256: release.scopeSha256,
    approvedScopeSha256,
    reconciliationSha256: canonicalSha256(digestInput),
    release,
    generationContract: COMPANY_OWNED_GENERATION_CONTRACT,
  });
}
