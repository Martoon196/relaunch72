import { createHash } from 'node:crypto';

const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[a-z0-9][a-z0-9._:/-]{0,199}$/;
const SAFE_TOKEN = /^[a-z][a-z0-9_-]{0,99}$/;
const MAX_SOURCES = 200;
const MAX_SPECIALISTS = 20;
const MAX_ARTWORK = 500;
const MAX_QUARANTINES = 50;

export const PROPERTY_PREDATOR_AI_INVENTORY_V1_PACKAGE_SHA256 =
  'd55afac02ac995f6157749181cf230ea8acc23b7b129dd6f92f63bcd04b57300';
export const PROPERTY_PREDATOR_AI_INVENTORY_V1_FILE_SHA256 =
  'e34b0ca9ac8ab4afdb1e8cd44ca0f3fc1f8362836332eca8a1f02cf71fa366e2';
export const PROPERTY_PREDATOR_AI_RUNTIME_BRAND_V1_SHA256 =
  'd77b0306d110075571dedd716d012c8752a302eb39ea9198e71ecd43cc089abc';

export type PropertyPredatorAiConsumerUse =
  | 'runtime-authority-reference'
  | 'reference-only-not-runtime-profile-input'
  | 'quarantine-only';

export interface PropertyPredatorAiInventorySource {
  readonly sourceId: string;
  readonly assetRole: string;
  readonly authorityStatus: string;
  readonly path: string;
  readonly locatorKind: string;
  readonly symbol: string | null;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly contentSha256: string;
  readonly suppliedBy: string;
  readonly ownershipStatus: string;
  readonly licenceStatus: string;
  readonly privacyClass: string;
  readonly consumerUse: PropertyPredatorAiConsumerUse;
}

export interface PropertyPredatorAiSpecialistProfile {
  readonly profileId: string;
  readonly name: string;
  readonly capabilities: readonly string[];
  readonly roleSourceId: string;
  readonly policySourceId: string;
  readonly instructionSourceIds: readonly string[];
  readonly knowledgeSourceIds: readonly string[];
  readonly runtimeBrandSha256: string;
  readonly sourceStatus: string;
  readonly hqActivationStatus: string;
}

export interface PropertyPredatorAiArtworkReference {
  readonly assetId: string;
  readonly path: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly contentSha256: string;
  readonly purpose: string;
  readonly sourceApprovalStatus: string;
  readonly hqUseStatus: string;
  readonly suppliedBy: string;
  readonly ownershipStatus: string;
  readonly licenceStatus: string;
}

export interface PropertyPredatorAiQuarantine {
  readonly quarantineId: string;
  readonly status: string;
  readonly reasonCode: string;
  readonly usable: false;
  readonly resolution: string;
  readonly sourceIds: readonly string[];
  readonly ruleIds: readonly string[];
  readonly evidenceSha256: string;
}

export interface PropertyPredatorAiInventory {
  readonly schemaVersion: 1;
  readonly inventoryId: 'property-predator.ai-inventory/v1';
  readonly sourceSystem: 'property-predator';
  readonly contract: Readonly<{
    mode: 'offline-fixture-only';
    fullTextAuthority: 'source-repository';
    consumerPayload: 'hash-addressed-metadata-only';
    hqApprovalRequired: true;
  }>;
  readonly sources: readonly PropertyPredatorAiInventorySource[];
  readonly specialistProfiles: readonly PropertyPredatorAiSpecialistProfile[];
  readonly artworkReferences: readonly PropertyPredatorAiArtworkReference[];
  readonly quarantines: readonly PropertyPredatorAiQuarantine[];
  readonly packageSha256: string;
}

export class PropertyPredatorAiInventoryContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PropertyPredatorAiInventoryContractError';
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PropertyPredatorAiInventoryContractError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new PropertyPredatorAiInventoryContractError(`${label} has unknown or missing fields`);
  }
}

function boundedText(value: unknown, label: string, maximum = 300): string {
  if (typeof value !== 'string' || value !== value.trim() || value.length < 1 || value.length > maximum
      || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new PropertyPredatorAiInventoryContractError(`${label} must be bounded trimmed text`);
  }
  return value;
}

function token(value: unknown, label: string): string {
  const result = boundedText(value, label, 100);
  if (!SAFE_TOKEN.test(result)) {
    throw new PropertyPredatorAiInventoryContractError(`${label} must be a safe token`);
  }
  return result;
}

function literal<const T extends string>(value: unknown, expected: T, label: string): T {
  if (value !== expected) {
    throw new PropertyPredatorAiInventoryContractError(`${label} is unsupported`);
  }
  return expected;
}

function oneOf<const T extends readonly string[]>(value: unknown, expected: T, label: string): T[number] {
  const result = token(value, label);
  if (!(expected as readonly string[]).includes(result)) {
    throw new PropertyPredatorAiInventoryContractError(`${label} is unsupported`);
  }
  return result as T[number];
}

function safeId(value: unknown, label: string): string {
  const result = boundedText(value, label, 200);
  if (!SAFE_ID.test(result)) {
    throw new PropertyPredatorAiInventoryContractError(`${label} must be a safe identifier`);
  }
  return result;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new PropertyPredatorAiInventoryContractError(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function positiveBytes(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 100 * 1024 * 1024) {
    throw new PropertyPredatorAiInventoryContractError(`${label} must be a bounded positive byte count`);
  }
  return value as number;
}

function safePath(value: unknown, label: string): string {
  const path = boundedText(value, label, 500);
  if (path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:/u.test(path)
      || path.includes('\\') || path.split('/').some((part) => part === '..' || part === '.')) {
    throw new PropertyPredatorAiInventoryContractError(`${label} must be a safe repository-relative path`);
  }
  return path;
}

function mediaType(value: unknown, label: string): string {
  const result = boundedText(value, label, 100);
  if (result !== result.toLowerCase()
      || !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(result)) {
    throw new PropertyPredatorAiInventoryContractError(`${label} must be a lowercase media type`);
  }
  return result;
}

function uniqueStrings(value: unknown, label: string, maximum: number): readonly string[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new PropertyPredatorAiInventoryContractError(`${label} must be a bounded array`);
  }
  const parsed = value.map((entry, index) => safeId(entry, `${label}[${index}]`));
  if (new Set(parsed).size !== parsed.length) {
    throw new PropertyPredatorAiInventoryContractError(`${label} must not contain duplicates`);
  }
  return Object.freeze(parsed);
}

function json(value: unknown, path: string, seen: Set<object>): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new PropertyPredatorAiInventoryContractError(`${path} is not finite`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new PropertyPredatorAiInventoryContractError(`${path} contains a cycle`);
    seen.add(value);
    const encoded = `[${value.map((item, index) => json(item, `${path}[${index}]`, seen)).join(',')}]`;
    seen.delete(value);
    return encoded;
  }
  if (typeof value === 'object') {
    if (seen.has(value)) throw new PropertyPredatorAiInventoryContractError(`${path} contains a cycle`);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new PropertyPredatorAiInventoryContractError(`${path} contains a non-JSON object`);
    }
    seen.add(value);
    const encoded = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => {
        if (child === undefined) throw new PropertyPredatorAiInventoryContractError(`${path}.${key} is undefined`);
        return `${JSON.stringify(key)}:${json(child, `${path}.${key}`, seen)}`;
      }).join(',');
    seen.delete(value);
    return `{${encoded}}`;
  }
  throw new PropertyPredatorAiInventoryContractError(`${path} is not JSON`);
}

export function canonicalPropertyPredatorAiInventoryJson(value: unknown): string {
  return json(value, 'inventory', new Set<object>());
}

function parseSource(value: unknown): PropertyPredatorAiInventorySource {
  const source = record(value, 'source');
  exactKeys(source, [
    'sourceId', 'assetRole', 'authorityStatus', 'path', 'locatorKind', 'symbol',
    'mediaType', 'byteLength', 'contentSha256', 'suppliedBy', 'ownershipStatus',
    'licenceStatus', 'privacyClass', 'consumerUse',
  ], 'source');
  const consumerUse = oneOf(source.consumerUse, [
    'runtime-authority-reference', 'reference-only-not-runtime-profile-input', 'quarantine-only',
  ] as const, 'source.consumerUse');
  const assetRole = oneOf(source.assetRole, ['knowledge', 'instruction', 'visual-reference'] as const,
    'source.assetRole');
  const authorityStatus = oneOf(source.authorityStatus,
    ['authoritative-runtime', 'reference-only', 'legacy-conflicting'] as const,
    'source.authorityStatus');
  const locatorKind = oneOf(source.locatorKind, ['file', 'python-symbol'] as const, 'source.locatorKind');
  const symbol = source.symbol === null ? null : boundedText(source.symbol, 'source.symbol', 200);
  if ((locatorKind === 'file' && symbol !== null) || (locatorKind === 'python-symbol' && symbol === null)) {
    throw new PropertyPredatorAiInventoryContractError('source locator and symbol do not agree');
  }
  const expectedUse = authorityStatus === 'authoritative-runtime'
    ? 'runtime-authority-reference'
    : authorityStatus === 'reference-only'
      ? 'reference-only-not-runtime-profile-input'
      : 'quarantine-only';
  if (consumerUse !== expectedUse) {
    throw new PropertyPredatorAiInventoryContractError('source authority and consumer use do not agree');
  }
  return Object.freeze({
    sourceId: safeId(source.sourceId, 'source.sourceId'),
    assetRole,
    authorityStatus,
    path: safePath(source.path, 'source.path'),
    locatorKind,
    symbol,
    mediaType: mediaType(source.mediaType, 'source.mediaType'),
    byteLength: positiveBytes(source.byteLength, 'source.byteLength'),
    contentSha256: digest(source.contentSha256, 'source.contentSha256'),
    suppliedBy: literal(source.suppliedBy, 'property-predator-repository', 'source.suppliedBy'),
    ownershipStatus: literal(source.ownershipStatus, 'source-asserted-company-owned', 'source.ownershipStatus'),
    licenceStatus: literal(source.licenceStatus, 'hq-review-required', 'source.licenceStatus'),
    privacyClass: literal(source.privacyClass, 'company-internal', 'source.privacyClass'),
    consumerUse,
  });
}

function parseSpecialist(value: unknown): PropertyPredatorAiSpecialistProfile {
  const profile = record(value, 'specialist profile');
  exactKeys(profile, [
    'profileId', 'name', 'capabilities', 'roleSourceId', 'policySourceId',
    'instructionSourceIds', 'knowledgeSourceIds', 'runtimeBrandSha256',
    'sourceStatus', 'hqActivationStatus',
  ], 'specialist profile');
  return Object.freeze({
    profileId: safeId(profile.profileId, 'profile.profileId'),
    name: boundedText(profile.name, 'profile.name', 200),
    capabilities: uniqueStrings(profile.capabilities, 'profile.capabilities', 20),
    roleSourceId: safeId(profile.roleSourceId, 'profile.roleSourceId'),
    policySourceId: safeId(profile.policySourceId, 'profile.policySourceId'),
    instructionSourceIds: uniqueStrings(profile.instructionSourceIds, 'profile.instructionSourceIds', 30),
    knowledgeSourceIds: uniqueStrings(profile.knowledgeSourceIds, 'profile.knowledgeSourceIds', 100),
    runtimeBrandSha256: digest(profile.runtimeBrandSha256, 'profile.runtimeBrandSha256'),
    sourceStatus: literal(profile.sourceStatus, 'source-current', 'profile.sourceStatus'),
    hqActivationStatus: literal(profile.hqActivationStatus, 'review-required', 'profile.hqActivationStatus'),
  });
}

function parseArtwork(value: unknown): PropertyPredatorAiArtworkReference {
  const artwork = record(value, 'artwork reference');
  exactKeys(artwork, [
    'assetId', 'path', 'mediaType', 'byteLength', 'contentSha256', 'purpose',
    'sourceApprovalStatus', 'hqUseStatus', 'suppliedBy', 'ownershipStatus', 'licenceStatus',
  ], 'artwork reference');
  return Object.freeze({
    assetId: safeId(artwork.assetId, 'artwork.assetId'),
    path: safePath(artwork.path, 'artwork.path'),
    mediaType: mediaType(artwork.mediaType, 'artwork.mediaType'),
    byteLength: positiveBytes(artwork.byteLength, 'artwork.byteLength'),
    contentSha256: digest(artwork.contentSha256, 'artwork.contentSha256'),
    purpose: boundedText(artwork.purpose, 'artwork.purpose', 500),
    sourceApprovalStatus: literal(artwork.sourceApprovalStatus, 'git-tracked-marketing-reference',
      'artwork.sourceApprovalStatus'),
    hqUseStatus: literal(artwork.hqUseStatus, 'review-required', 'artwork.hqUseStatus'),
    suppliedBy: literal(artwork.suppliedBy, 'property-predator-repository', 'artwork.suppliedBy'),
    ownershipStatus: literal(artwork.ownershipStatus, 'source-asserted-company-owned',
      'artwork.ownershipStatus'),
    licenceStatus: literal(artwork.licenceStatus, 'hq-review-required', 'artwork.licenceStatus'),
  });
}

function parseQuarantine(value: unknown): PropertyPredatorAiQuarantine {
  const quarantine = record(value, 'quarantine');
  exactKeys(quarantine, [
    'quarantineId', 'status', 'reasonCode', 'usable', 'resolution',
    'sourceIds', 'ruleIds', 'evidenceSha256',
  ], 'quarantine');
  if (quarantine.usable !== false) {
    throw new PropertyPredatorAiInventoryContractError('quarantine.usable must be false');
  }
  return Object.freeze({
    quarantineId: safeId(quarantine.quarantineId, 'quarantine.quarantineId'),
    status: literal(quarantine.status, 'quarantined', 'quarantine.status'),
    reasonCode: literal(quarantine.reasonCode, 'visual-policy-conflict', 'quarantine.reasonCode'),
    usable: false,
    resolution: literal(quarantine.resolution, 'unresolved-founder-decision-required', 'quarantine.resolution'),
    sourceIds: uniqueStrings(quarantine.sourceIds, 'quarantine.sourceIds', 50),
    ruleIds: uniqueStrings(quarantine.ruleIds, 'quarantine.ruleIds', 50),
    evidenceSha256: digest(quarantine.evidenceSha256, 'quarantine.evidenceSha256'),
  });
}

function uniqueBy<T>(items: readonly T[], key: (item: T) => string, label: string): void {
  const keys = items.map(key);
  if (new Set(keys).size !== keys.length) {
    throw new PropertyPredatorAiInventoryContractError(`${label} contains duplicate identities`);
  }
}

export function parsePropertyPredatorAiInventory(input: unknown): PropertyPredatorAiInventory {
  const inventory = record(input, 'AI inventory');
  exactKeys(inventory, [
    'schemaVersion', 'inventoryId', 'sourceSystem', 'contract', 'sources',
    'specialistProfiles', 'artworkReferences', 'quarantines', 'packageSha256',
  ], 'AI inventory');
  if (inventory.schemaVersion !== 1
      || inventory.inventoryId !== 'property-predator.ai-inventory/v1'
      || inventory.sourceSystem !== 'property-predator') {
    throw new PropertyPredatorAiInventoryContractError('AI inventory identity is unsupported');
  }
  const contract = record(inventory.contract, 'contract');
  exactKeys(contract, ['mode', 'fullTextAuthority', 'consumerPayload', 'hqApprovalRequired'], 'contract');
  if (contract.mode !== 'offline-fixture-only'
      || contract.fullTextAuthority !== 'source-repository'
      || contract.consumerPayload !== 'hash-addressed-metadata-only'
      || contract.hqApprovalRequired !== true) {
    throw new PropertyPredatorAiInventoryContractError('AI inventory contract is unsafe');
  }
  if (!Array.isArray(inventory.sources) || inventory.sources.length > MAX_SOURCES
      || !Array.isArray(inventory.specialistProfiles) || inventory.specialistProfiles.length > MAX_SPECIALISTS
      || !Array.isArray(inventory.artworkReferences) || inventory.artworkReferences.length > MAX_ARTWORK
      || !Array.isArray(inventory.quarantines) || inventory.quarantines.length > MAX_QUARANTINES) {
    throw new PropertyPredatorAiInventoryContractError('AI inventory arrays are not bounded');
  }
  const sources = Object.freeze(inventory.sources.map(parseSource));
  const profiles = Object.freeze(inventory.specialistProfiles.map(parseSpecialist));
  const artwork = Object.freeze(inventory.artworkReferences.map(parseArtwork));
  const quarantines = Object.freeze(inventory.quarantines.map(parseQuarantine));
  uniqueBy(sources, (item) => item.sourceId, 'sources');
  uniqueBy(profiles, (item) => item.profileId, 'specialistProfiles');
  uniqueBy(artwork, (item) => item.assetId, 'artworkReferences');
  uniqueBy(quarantines, (item) => item.quarantineId, 'quarantines');

  const sourceIds = new Set(sources.map((source) => source.sourceId));
  for (const profile of profiles) {
    const refs = [profile.roleSourceId, profile.policySourceId,
      ...profile.instructionSourceIds, ...profile.knowledgeSourceIds];
    if (refs.some((reference) => !sourceIds.has(reference))) {
      throw new PropertyPredatorAiInventoryContractError('specialist profile references an unknown source');
    }
    const evalOnly = refs.some((reference) => {
      const source = sources.find((candidate) => candidate.sourceId === reference)!;
      return source.consumerUse !== 'runtime-authority-reference';
    });
    if (evalOnly) {
      throw new PropertyPredatorAiInventoryContractError('specialist profile references eval-only or quarantined material');
    }
  }
  for (const quarantine of quarantines) {
    if (quarantine.sourceIds.some((sourceId) => !sourceIds.has(sourceId))) {
      throw new PropertyPredatorAiInventoryContractError('quarantine references an unknown source');
    }
  }

  const expectedProfiles = [
    ['propertypredator.owned.social/v1', 'PropertyPredator official social editor', ['post', 'thread'],
      'propertypredator-owned-content-role/social/v1'],
    ['propertypredator.owned.content/v1', 'PropertyPredator official content editor', ['article'],
      'propertypredator-owned-content-role/content/v1'],
    ['propertypredator.owned.image/v1', 'PropertyPredator official image brief editor', ['image'],
      'propertypredator-owned-content-role/image/v1'],
    ['propertypredator.owned.email/v1', 'PropertyPredator official email editor', ['email'],
      'propertypredator-owned-content-role/email/v1'],
    ['propertypredator.owned.video/v1', 'PropertyPredator official video editor', ['script'],
      'propertypredator-owned-content-role/video/v1'],
    ['propertypredator.owned.ad/v1', 'PropertyPredator official paid-media editor', ['ad'],
      'propertypredator-owned-content-role/ad/v1'],
  ] as const;
  if (profiles.length !== expectedProfiles.length
      || profiles.some((profile, index) => {
        const expected = expectedProfiles[index]!;
        return profile.profileId !== expected[0]
          || profile.name !== expected[1]
          || profile.capabilities.length !== expected[2].length
          || profile.capabilities.some((capability, capabilityIndex) => capability !== expected[2][capabilityIndex])
          || profile.roleSourceId !== expected[3]
          || profile.policySourceId !== 'propertypredator-owned-content-policy/v1'
          || profile.instructionSourceIds.length !== 1
          || profile.instructionSourceIds[0] !== 'production-kit'
          || profile.knowledgeSourceIds.length !== 1
          || profile.knowledgeSourceIds[0] !== 'brand-bible';
      })) {
    throw new PropertyPredatorAiInventoryContractError('specialist profile set or order is unsupported');
  }
  if (new Set(profiles.map((profile) => profile.runtimeBrandSha256)).size !== 1) {
    throw new PropertyPredatorAiInventoryContractError('specialist profiles do not share one runtime brand hash');
  }
  if (profiles.some((profile) => profile.runtimeBrandSha256 !== PROPERTY_PREDATOR_AI_RUNTIME_BRAND_V1_SHA256)) {
    throw new PropertyPredatorAiInventoryContractError('specialist runtime brand hash is not the trusted v1 release');
  }
  const sourceOrder = sources.map((source) => source.sourceId);
  const artworkOrder = artwork.map((item) => item.assetId);
  if (sourceOrder.some((value, index) => index > 0 && value <= sourceOrder[index - 1]!)
      || artworkOrder.some((value, index) => index > 0 && value <= artworkOrder[index - 1]!)) {
    throw new PropertyPredatorAiInventoryContractError('inventory sources or artwork are not canonically ordered');
  }
  if (quarantines.length !== 1
      || quarantines[0]!.quarantineId !== 'legacy-black-panther-vs-current-no-animal/v1'
      || quarantines[0]!.sourceIds.join('\n') !== 'legacy-admin-image-style\nproduction-kit'
      || quarantines[0]!.ruleIds.join('\n') !== 'current-forbids-animal-mascot\nlegacy-allows-black-panther') {
    throw new PropertyPredatorAiInventoryContractError('required visual policy conflict quarantine is missing');
  }

  const packageSha256 = digest(inventory.packageSha256, 'packageSha256');
  if (packageSha256 !== PROPERTY_PREDATOR_AI_INVENTORY_V1_PACKAGE_SHA256) {
    throw new PropertyPredatorAiInventoryContractError('AI inventory package is not the trusted v1 release');
  }
  const hashInput: Omit<PropertyPredatorAiInventory, 'packageSha256'> = {
    schemaVersion: 1,
    inventoryId: 'property-predator.ai-inventory/v1',
    sourceSystem: 'property-predator',
    contract: {
      mode: 'offline-fixture-only',
      fullTextAuthority: 'source-repository',
      consumerPayload: 'hash-addressed-metadata-only',
      hqApprovalRequired: true,
    },
    sources,
    specialistProfiles: profiles,
    artworkReferences: artwork,
    quarantines,
  };
  const computed = createHash('sha256')
    .update(canonicalPropertyPredatorAiInventoryJson(hashInput), 'utf8')
    .digest('hex');
  if (computed !== packageSha256) {
    throw new PropertyPredatorAiInventoryContractError('AI inventory package hash failed verification');
  }
  return Object.freeze({ ...hashInput, packageSha256 });
}

export const PROPERTY_PREDATOR_EXTERNAL_GPT_PLACEHOLDERS = Object.freeze([
  Object.freeze({ name: 'Content Marketer', status: 'awaiting_founder_export' as const, callable: false as const }),
  Object.freeze({ name: 'Image Maker', status: 'awaiting_founder_export' as const, callable: false as const }),
  Object.freeze({ name: 'Social Media Manager', status: 'awaiting_founder_export' as const, callable: false as const }),
]);
