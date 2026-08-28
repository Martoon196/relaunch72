import { createHash } from 'node:crypto';

const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[a-z0-9][a-z0-9._:/-]{0,199}$/;
const SAFE_MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const MAX_FILES = 100;
const MAX_EVIDENCE = 20;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_EVIDENCE_BYTES = 5 * 1024 * 1024;
const MAX_PACK_BYTES = 100 * 1024 * 1024;

const SOURCE_KINDS = [
  'chatgpt-custom-gpt',
  'codex-skill',
  'prompt-pack',
  'custom-bot-export',
] as const;

const PROPOSAL_CAPABILITIES = [
  'content-proposal',
  'email-proposal',
  'image-brief-proposal',
  'paid-media-proposal',
  'social-proposal',
  'strategy-proposal',
  'video-script-proposal',
  'workflow-guidance',
] as const;

const FILE_ROLES = [
  'action-schema-review-only',
  'approved-example',
  'conversation-starters',
  'knowledge-reference',
  'primary-instructions',
  'rejected-example',
  'skill-asset',
  'skill-reference',
  'skill-script-review-only',
  'skill-template',
  'workflow-reference',
] as const;

const PRIMARY_INSTRUCTION_MEDIA_TYPES = new Set([
  'application/json',
  'text/markdown',
  'text/plain',
]);

const ARCHIVE_OR_DATA_EXTENSION = /(?:^|\/)[^/]+\.(?:7z|csv|db|eml|gz|jsonl|mbox|ndjson|parquet|pst|rar|sql|sqlite3?|tar|tgz|tsv|vcf|xls|xlsx|zip)$/iu;
const SECRET_PATH = /(?:^|\/)(?:\.env(?:\.[^/]*)?|credentials?(?:\.[^/]*)?|cookies?(?:\.[^/]*)?|id_(?:ed25519|rsa)(?:\.[^/]*)?|[^/]*(?:api[-_]?key|access[-_]?token|refresh[-_]?token|private[-_]?key|secrets?|sessions?)[^/]*)$/iu;
const CUSTOMER_DATA_PATH = /(?:^|[\/_. -])(?:clients?|contacts?|crm|customers?|inbox|leads?|mailing[-_ ]?list|message[-_ ]?export|prospects?|recipients?|subscribers?)(?:$|[\/_. -])/iu;
const STRATEGY_PATH = /(?:^|\/)(?:[^/]*(?:customer[-_ ]?avatar|buyer[-_ ]?profile|persona)[^/]*|segments?)(?:\/|$)/iu;
const CUSTOMER_RECORD_CONTAINER = /(?:^|\/)(?:backups?|crm[-_ ]?(?:dump|export)s?|database[-_ ]?dumps?|exports?|mailboxes?|raw[-_ ]?data|records?)(?:\/|$)/iu;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu;
const PHONE = /(?:^|\D)(?:\+?\d[\s().-]*){9,}(?:$|\D)/u;
const SECRET_VALUE_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/iu,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bBearer\s+\S+/iu,
  /\b(?:api[-_ ]?key|password|passwd|private[-_ ]?key|secret|access[-_ ]?token|refresh[-_ ]?token)\s*[:=]/iu,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s/@:]+:[^\s/@]+@/iu,
  /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/u,
  /\b(?:sk|rk|sess)-[A-Za-z0-9_-]{16,}\b/u,
] as const;

export type FounderSpecialistSourceKind = typeof SOURCE_KINDS[number];
export type FounderSpecialistProposalCapability = typeof PROPOSAL_CAPABILITIES[number];
export type FounderSpecialistFileRole = typeof FILE_ROLES[number];

export interface FounderSpecialistIdentity {
  readonly specialistId: string;
  readonly name: string;
  readonly sourceKind: FounderSpecialistSourceKind;
  readonly proposalCapabilities: readonly FounderSpecialistProposalCapability[];
}

export interface FounderSpecialistFileReference {
  readonly fileId: string;
  readonly path: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly contentSha256: string;
  readonly role: FounderSpecialistFileRole;
  readonly ownershipEvidenceId: string;
  readonly privacyAttestation: 'founder-attested-no-secrets-credentials-or-customer-data';
}

export interface FounderSpecialistOwnershipEvidence {
  readonly evidenceId: string;
  readonly path: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly contentSha256: string;
  readonly assertion: 'founder-asserted-owned-or-licensed';
  readonly reviewStatus: 'review-required';
}

export interface FounderSpecialistPackHandling {
  readonly payload: 'metadata-and-hashes-only';
  readonly promptBodyAccess: 'forbidden';
  readonly archiveHandling: 'never-unpack';
  readonly execution: 'forbidden';
  readonly providerAccess: 'forbidden';
}

export interface FounderSpecialistPack {
  readonly schemaVersion: 1;
  readonly packId: string;
  readonly source: 'founder-supplied-offline-export';
  readonly specialist: Readonly<FounderSpecialistIdentity>;
  readonly files: readonly Readonly<FounderSpecialistFileReference>[];
  readonly ownershipEvidence: readonly Readonly<FounderSpecialistOwnershipEvidence>[];
  readonly handling: Readonly<FounderSpecialistPackHandling>;
  readonly callable: false;
  readonly effects: 'none';
  readonly reviewStatus: 'review-required';
  readonly packageSha256: string;
}

export class FounderSpecialistPackContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FounderSpecialistPackContractError';
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new FounderSpecialistPackContractError(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new FounderSpecialistPackContractError(`${label} must be a plain object`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string')) {
    throw new FounderSpecialistPackContractError(`${label} must contain only string-keyed JSON fields`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (keys.some((key) => {
    const descriptor = descriptors[key as string];
    return !descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value');
  })) {
    throw new FounderSpecialistPackContractError(`${label} must contain only enumerable data fields`);
  }
  return value as Record<string, unknown>;
}

function dataArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new FounderSpecialistPackContractError(`${label} must be a plain array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string')
      || keys.some((key) => key !== 'length' && !/^(?:0|[1-9][0-9]*)$/u.test(key as string))) {
    throw new FounderSpecialistPackContractError(`${label} must contain only JSON array entries`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new FounderSpecialistPackContractError(`${label} must be dense and contain only data entries`);
    }
  }
  return value;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new FounderSpecialistPackContractError(`${label} has unknown or missing fields`);
  }
}

function rejectSensitiveMetadata(value: string, label: string): void {
  if (EMAIL.test(value) || PHONE.test(value) || SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value))) {
    throw new FounderSpecialistPackContractError(`${label} contains secret, credential or customer-data-shaped metadata`);
  }
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value !== value.trim() || value.length < 1 || value.length > maximum
      || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new FounderSpecialistPackContractError(`${label} must be bounded trimmed text`);
  }
  rejectSensitiveMetadata(value, label);
  return value;
}

function safeId(value: unknown, label: string): string {
  const result = boundedText(value, label, 200);
  if (!SAFE_ID.test(result) || result.includes('://')
      || result.split('/').some((segment) => segment.length < 1 || segment === '.' || segment === '..')) {
    throw new FounderSpecialistPackContractError(`${label} must be a safe identifier`);
  }
  return result;
}

function displayName(value: unknown, label: string): string {
  const result = boundedText(value, label, 120);
  if (!/^[\p{L}\p{N}][\p{L}\p{N} &'().,+:/_-]{0,119}$/u.test(result) || result.includes('://')) {
    throw new FounderSpecialistPackContractError(`${label} must be a safe display name`);
  }
  return result;
}

function literal<const T extends string>(value: unknown, expected: T, label: string): T {
  if (value !== expected) {
    throw new FounderSpecialistPackContractError(`${label} is unsupported`);
  }
  return expected;
}

function oneOf<const T extends readonly string[]>(value: unknown, options: T, label: string): T[number] {
  if (typeof value !== 'string' || !(options as readonly string[]).includes(value)) {
    throw new FounderSpecialistPackContractError(`${label} is unsupported`);
  }
  return value as T[number];
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new FounderSpecialistPackContractError(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function positiveBytes(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new FounderSpecialistPackContractError(`${label} must be a bounded positive byte count`);
  }
  return value as number;
}

function safePath(value: unknown, label: string): string {
  const path = boundedText(value, label, 500);
  if (path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:/u.test(path)
      || path.includes('\\') || path.includes('://')
      || path.split('/').some((part) => part.length < 1 || part === '.' || part === '..')) {
    throw new FounderSpecialistPackContractError(`${label} must be a safe package-relative path`);
  }
  if (ARCHIVE_OR_DATA_EXTENSION.test(path)) {
    throw new FounderSpecialistPackContractError(`${label} must not identify an archive, mailbox, database or tabular dataset`);
  }
  if (SECRET_PATH.test(path)) {
    throw new FounderSpecialistPackContractError(`${label} must not identify credential or secret material`);
  }
  if (CUSTOMER_DATA_PATH.test(path)
      && (!STRATEGY_PATH.test(path) || CUSTOMER_RECORD_CONTAINER.test(path))) {
    throw new FounderSpecialistPackContractError(`${label} appears to identify customer-private data`);
  }
  return path;
}

function mediaType(value: unknown, label: string): string {
  const result = boundedText(value, label, 100);
  if (result !== result.toLowerCase() || !SAFE_MEDIA_TYPE.test(result)) {
    throw new FounderSpecialistPackContractError(`${label} must be a lowercase media type`);
  }
  if (/(?:archive|compressed|gzip|rar|tar|zip)/u.test(result)) {
    throw new FounderSpecialistPackContractError(`${label} must not be an archive media type`);
  }
  return result;
}

function parseProposalCapabilities(value: unknown): readonly FounderSpecialistProposalCapability[] {
  const entries = dataArray(value, 'specialist.proposalCapabilities');
  if (entries.length < 1 || entries.length > PROPOSAL_CAPABILITIES.length) {
    throw new FounderSpecialistPackContractError('specialist.proposalCapabilities must be a bounded non-empty array');
  }
  const capabilities = entries.map((entry, index) =>
    oneOf(entry, PROPOSAL_CAPABILITIES, `specialist.proposalCapabilities[${index}]`));
  if (new Set(capabilities).size !== capabilities.length) {
    throw new FounderSpecialistPackContractError('specialist.proposalCapabilities must not contain duplicates');
  }
  assertCanonicalOrder(capabilities, 'specialist.proposalCapabilities');
  return Object.freeze(capabilities);
}

function parseSpecialist(value: unknown): Readonly<FounderSpecialistIdentity> {
  const specialist = record(value, 'specialist');
  exactKeys(specialist, ['specialistId', 'name', 'sourceKind', 'proposalCapabilities'], 'specialist');
  return Object.freeze({
    specialistId: safeId(specialist.specialistId, 'specialist.specialistId'),
    name: displayName(specialist.name, 'specialist.name'),
    sourceKind: oneOf(specialist.sourceKind, SOURCE_KINDS, 'specialist.sourceKind'),
    proposalCapabilities: parseProposalCapabilities(specialist.proposalCapabilities),
  });
}

function parseFile(value: unknown): Readonly<FounderSpecialistFileReference> {
  const file = record(value, 'file reference');
  exactKeys(file, [
    'fileId', 'path', 'mediaType', 'byteLength', 'contentSha256', 'role',
    'ownershipEvidenceId', 'privacyAttestation',
  ], 'file reference');
  return Object.freeze({
    fileId: safeId(file.fileId, 'file.fileId'),
    path: safePath(file.path, 'file.path'),
    mediaType: mediaType(file.mediaType, 'file.mediaType'),
    byteLength: positiveBytes(file.byteLength, 'file.byteLength', MAX_FILE_BYTES),
    contentSha256: digest(file.contentSha256, 'file.contentSha256'),
    role: oneOf(file.role, FILE_ROLES, 'file.role'),
    ownershipEvidenceId: safeId(file.ownershipEvidenceId, 'file.ownershipEvidenceId'),
    privacyAttestation: literal(file.privacyAttestation,
      'founder-attested-no-secrets-credentials-or-customer-data', 'file.privacyAttestation'),
  });
}

function parseOwnershipEvidence(value: unknown): Readonly<FounderSpecialistOwnershipEvidence> {
  const evidence = record(value, 'ownership evidence');
  exactKeys(evidence, [
    'evidenceId', 'path', 'mediaType', 'byteLength', 'contentSha256', 'assertion', 'reviewStatus',
  ], 'ownership evidence');
  return Object.freeze({
    evidenceId: safeId(evidence.evidenceId, 'ownershipEvidence.evidenceId'),
    path: safePath(evidence.path, 'ownershipEvidence.path'),
    mediaType: mediaType(evidence.mediaType, 'ownershipEvidence.mediaType'),
    byteLength: positiveBytes(evidence.byteLength, 'ownershipEvidence.byteLength', MAX_EVIDENCE_BYTES),
    contentSha256: digest(evidence.contentSha256, 'ownershipEvidence.contentSha256'),
    assertion: literal(evidence.assertion, 'founder-asserted-owned-or-licensed',
      'ownershipEvidence.assertion'),
    reviewStatus: literal(evidence.reviewStatus, 'review-required', 'ownershipEvidence.reviewStatus'),
  });
}

function parseHandling(value: unknown): Readonly<FounderSpecialistPackHandling> {
  const handling = record(value, 'handling');
  exactKeys(handling, [
    'payload', 'promptBodyAccess', 'archiveHandling', 'execution', 'providerAccess',
  ], 'handling');
  return Object.freeze({
    payload: literal(handling.payload, 'metadata-and-hashes-only', 'handling.payload'),
    promptBodyAccess: literal(handling.promptBodyAccess, 'forbidden', 'handling.promptBodyAccess'),
    archiveHandling: literal(handling.archiveHandling, 'never-unpack', 'handling.archiveHandling'),
    execution: literal(handling.execution, 'forbidden', 'handling.execution'),
    providerAccess: literal(handling.providerAccess, 'forbidden', 'handling.providerAccess'),
  });
}

function uniqueBy<T>(items: readonly T[], key: (item: T) => string, label: string): void {
  const values = items.map(key);
  if (new Set(values).size !== values.length) {
    throw new FounderSpecialistPackContractError(`${label} contains duplicate values`);
  }
}

function assertCanonicalOrder(values: readonly string[], label: string): void {
  if (values.some((value, index) => index > 0 && value <= values[index - 1]!)) {
    throw new FounderSpecialistPackContractError(`${label} must be canonically ordered`);
  }
}

function canonicalJson(value: unknown, path: string, seen: Set<object>): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new FounderSpecialistPackContractError(`${path} is not finite`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const array = dataArray(value, path);
    if (seen.has(array)) throw new FounderSpecialistPackContractError(`${path} contains a cycle`);
    seen.add(array);
    const encoded = `[${array.map((item, index) => canonicalJson(item, `${path}[${index}]`, seen)).join(',')}]`;
    seen.delete(array);
    return encoded;
  }
  if (typeof value === 'object') {
    const object = record(value, path);
    if (seen.has(object)) throw new FounderSpecialistPackContractError(`${path} contains a cycle`);
    seen.add(object);
    const encoded = Object.entries(object)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => {
        if (child === undefined) throw new FounderSpecialistPackContractError(`${path}.${key} is undefined`);
        return `${JSON.stringify(key)}:${canonicalJson(child, `${path}.${key}`, seen)}`;
      }).join(',');
    seen.delete(object);
    return `{${encoded}}`;
  }
  throw new FounderSpecialistPackContractError(`${path} is not JSON`);
}

export function canonicalFounderSpecialistPackJson(value: unknown): string {
  return canonicalJson(value, 'founderSpecialistPack', new Set<object>());
}

export function parseFounderSpecialistPack(input: unknown): FounderSpecialistPack {
  const pack = record(input, 'founder specialist pack');
  exactKeys(pack, [
    'schemaVersion', 'packId', 'source', 'specialist', 'files', 'ownershipEvidence',
    'handling', 'callable', 'effects', 'reviewStatus', 'packageSha256',
  ], 'founder specialist pack');
  if (pack.schemaVersion !== 1) {
    throw new FounderSpecialistPackContractError('founder specialist pack schema version is unsupported');
  }
  const fileEntries = dataArray(pack.files, 'founder specialist pack files');
  const evidenceEntries = dataArray(pack.ownershipEvidence, 'founder specialist pack ownershipEvidence');
  if (fileEntries.length < 1 || fileEntries.length > MAX_FILES
      || evidenceEntries.length < 1 || evidenceEntries.length > MAX_EVIDENCE) {
    throw new FounderSpecialistPackContractError('founder specialist pack arrays are not bounded');
  }

  const specialist = parseSpecialist(pack.specialist);
  const files = Object.freeze(fileEntries.map(parseFile));
  const ownershipEvidence = Object.freeze(evidenceEntries.map(parseOwnershipEvidence));
  const handling = parseHandling(pack.handling);

  uniqueBy(files, (file) => file.fileId, 'file identities');
  uniqueBy(files, (file) => file.path.toLowerCase(), 'file paths');
  uniqueBy(ownershipEvidence, (evidence) => evidence.evidenceId, 'ownership evidence identities');
  uniqueBy(ownershipEvidence, (evidence) => evidence.path.toLowerCase(), 'ownership evidence paths');
  uniqueBy([
    ...files.map((file) => file.path.toLowerCase()),
    ...ownershipEvidence.map((evidence) => evidence.path.toLowerCase()),
  ], (path) => path, 'all package paths');
  assertCanonicalOrder(files.map((file) => file.fileId), 'file identities');
  assertCanonicalOrder(ownershipEvidence.map((evidence) => evidence.evidenceId), 'ownership evidence identities');

  if (files.filter((file) => file.role === 'primary-instructions').length !== 1) {
    throw new FounderSpecialistPackContractError('founder specialist pack must contain exactly one primary instructions file');
  }
  const primaryInstructions = files.find((file) => file.role === 'primary-instructions')!;
  if (!PRIMARY_INSTRUCTION_MEDIA_TYPES.has(primaryInstructions.mediaType)) {
    throw new FounderSpecialistPackContractError('primary instructions must use a reviewable text media type');
  }
  if (specialist.sourceKind === 'codex-skill'
      && primaryInstructions.path.split('/').at(-1) !== 'SKILL.md') {
    throw new FounderSpecialistPackContractError('a Codex skill primary instructions file must be named SKILL.md');
  }
  if (specialist.sourceKind !== 'codex-skill'
      && files.some((file) => file.role.startsWith('skill-'))) {
    throw new FounderSpecialistPackContractError('skill-only file roles require a Codex skill source');
  }

  const evidenceIds = new Set(ownershipEvidence.map((evidence) => evidence.evidenceId));
  if (files.some((file) => !evidenceIds.has(file.ownershipEvidenceId))) {
    throw new FounderSpecialistPackContractError('a file references unknown ownership evidence');
  }
  if (ownershipEvidence.some((evidence) => !files.some((file) => file.ownershipEvidenceId === evidence.evidenceId))) {
    throw new FounderSpecialistPackContractError('ownership evidence must be referenced by at least one file');
  }
  const totalBytes = files.reduce((total, file) => total + file.byteLength, 0)
    + ownershipEvidence.reduce((total, evidence) => total + evidence.byteLength, 0);
  if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_PACK_BYTES) {
    throw new FounderSpecialistPackContractError('founder specialist pack exceeds the byte budget');
  }

  if (pack.callable !== false) {
    throw new FounderSpecialistPackContractError('founder specialist pack callable must be false');
  }
  const effects = literal(pack.effects, 'none', 'founder specialist pack effects');
  const reviewStatus = literal(pack.reviewStatus, 'review-required', 'founder specialist pack reviewStatus');
  const packageSha256 = digest(pack.packageSha256, 'founder specialist pack packageSha256');

  const hashInput: Omit<FounderSpecialistPack, 'packageSha256'> = {
    schemaVersion: 1,
    packId: safeId(pack.packId, 'founder specialist pack packId'),
    source: literal(pack.source, 'founder-supplied-offline-export', 'founder specialist pack source'),
    specialist,
    files,
    ownershipEvidence,
    handling,
    callable: false,
    effects,
    reviewStatus,
  };
  const computed = createHash('sha256')
    .update(canonicalFounderSpecialistPackJson(hashInput), 'utf8')
    .digest('hex');
  if (computed !== packageSha256) {
    throw new FounderSpecialistPackContractError('founder specialist pack package hash failed verification');
  }
  return Object.freeze({ ...hashInput, packageSha256 });
}
