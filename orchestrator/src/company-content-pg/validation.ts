import { createHash } from 'node:crypto';
import type { DatabaseRequestContext } from '../db/rls.js';
import { validateDatabaseContext } from '../db/rls.js';
import {
  CompanyContentValidationError,
  type CompanyContentApprovalDecision,
  type CompanyContentKind,
  type CompanyContentOrigin,
  type CreateCompanyContentVersionCommand,
  type DecideCompanyContentApprovalCommand,
  type RefreshCompanyContentSourceAttestationCommand,
  type RequestCompanyContentApprovalCommand,
} from './types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const COMMAND_KEY = /^[\x21-\x7e]{1,200}$/;
const SOURCE_SYSTEM = /^[A-Za-z][A-Za-z0-9_.:-]{0,99}$/;
const MIME_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const ORIGINS = new Set<CompanyContentOrigin>(['imported', 'generated', 'edited']);
const KINDS = new Set<CompanyContentKind>([
  'article', 'document', 'email', 'image', 'social_post',
  'video', 'webinar', 'other',
]);
const DECISIONS = new Set<CompanyContentApprovalDecision>([
  'approved', 'rejected', 'changes_requested',
]);

function exactText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string' || value !== value.trim()
      || value.length < 1 || value.length > maximum) {
    throw new CompanyContentValidationError(
      `${field} must be trimmed and contain 1-${maximum} characters`,
    );
  }
  return value;
}

function optionalText(value: unknown, field: string, maximum: number): string | null {
  if (value === undefined || value === null || value === '') return null;
  return exactText(value, field, maximum);
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new CompanyContentValidationError(`${field} must be a UUID`);
  }
  return value.toLowerCase();
}

function digest(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new CompanyContentValidationError(`${field} must be a lowercase SHA-256 hex digest`);
  }
  return value;
}

function timestamp(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new CompanyContentValidationError(`${field} must be an ISO timestamp`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new CompanyContentValidationError(`${field} must be a canonical UTC ISO timestamp`);
  }
  return value;
}

function commandKey(value: unknown): string {
  if (typeof value !== 'string' || value !== value.trim() || !COMMAND_KEY.test(value)) {
    throw new CompanyContentValidationError(
      'commandKey must be 1-200 printable ASCII characters without surrounding space',
    );
  }
  return value;
}

function jsonValue(value: unknown, path: string, seen: Set<object>): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new CompanyContentValidationError(`${path} contains a non-finite number`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new CompanyContentValidationError(`${path} contains a cycle`);
    seen.add(value);
    const encoded = `[${value.map((child, index) => jsonValue(child, `${path}[${index}]`, seen)).join(',')}]`;
    seen.delete(value);
    return encoded;
  }
  if (typeof value === 'object') {
    if (seen.has(value)) throw new CompanyContentValidationError(`${path} contains a cycle`);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CompanyContentValidationError(`${path} must contain only plain JSON objects`);
    }
    seen.add(value);
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => {
        if (child === undefined) {
          throw new CompanyContentValidationError(`${path}.${key} must not be undefined`);
        }
        return `${JSON.stringify(key)}:${jsonValue(child, `${path}.${key}`, seen)}`;
      });
    seen.delete(value);
    return `{${entries.join(',')}}`;
  }
  throw new CompanyContentValidationError(`${path} contains a non-JSON value`);
}

export function canonicalCompanyContentJson(value: unknown): string {
  return jsonValue(value, 'value', new Set<object>());
}

function deepFreezeCanonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    for (const child of value) deepFreezeCanonicalJson(child);
    return Object.freeze(value);
  }
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreezeCanonicalJson(child);
    }
    return Object.freeze(value);
  }
  return value;
}

export function validateCompanyContentUserContext(context: DatabaseRequestContext): void {
  validateDatabaseContext(context);
  if (context.actorKind !== 'user' || !context.userId) {
    throw new CompanyContentValidationError(
      'Company content commands require an authenticated workspace member',
    );
  }
}

export interface NormalizedCompanyContentVersionCommand {
  readonly commandKey: string;
  readonly contentItemId: string | null;
  readonly previousVersionId: string | null;
  readonly origin: CompanyContentOrigin;
  readonly kind: CompanyContentKind;
  readonly title: string;
  readonly contentMimeType: string;
  readonly content: string;
  readonly sourceSystem: string;
  readonly sourceItemId: string;
  readonly sourceVersion: string;
  readonly blobStorageKey: string;
  readonly blobSha256: string;
  readonly brandSnapshotRef: string;
  readonly brandSha256: string;
  readonly sourceCatalogSha256: string;
  readonly sourceCheckedAt: string;
  readonly sourceExpiresAt: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly contentSha256: string;
}

export function normalizeCompanyContentVersionCommand(
  command: CreateCompanyContentVersionCommand,
): NormalizedCompanyContentVersionCommand {
  if (!command || typeof command !== 'object') {
    throw new CompanyContentValidationError('Company content version command is required');
  }
  if (!ORIGINS.has(command.origin)) {
    throw new CompanyContentValidationError('origin is invalid');
  }
  if (!KINDS.has(command.kind)) {
    throw new CompanyContentValidationError('kind is invalid');
  }
  const contentItemId = command.contentItemId === undefined || command.contentItemId === null
    ? null : uuid(command.contentItemId, 'contentItemId');
  const previousVersionId = command.previousVersionId === undefined || command.previousVersionId === null
    ? null : uuid(command.previousVersionId, 'previousVersionId');
  if ((contentItemId === null) !== (previousVersionId === null)) {
    throw new CompanyContentValidationError(
      'contentItemId and previousVersionId must either both be supplied or both be omitted',
    );
  }
  if (contentItemId === null && command.origin === 'edited') {
    throw new CompanyContentValidationError('An edited version must identify its predecessor');
  }
  const title = exactText(command.title, 'title', 300);
  const contentMimeType = exactText(command.contentMimeType, 'contentMimeType', 100);
  if (contentMimeType !== contentMimeType.toLowerCase() || !MIME_TYPE.test(contentMimeType)) {
    throw new CompanyContentValidationError('contentMimeType must be a lowercase MIME type');
  }
  if (typeof command.content !== 'string'
      || Buffer.byteLength(command.content, 'utf8') < 1
      || Buffer.byteLength(command.content, 'utf8') > 1_048_576) {
    throw new CompanyContentValidationError('content must contain 1-1048576 UTF-8 bytes');
  }
  const sourceSystem = exactText(command.source?.system, 'source.system', 100);
  if (!SOURCE_SYSTEM.test(sourceSystem)) {
    throw new CompanyContentValidationError('source.system is invalid');
  }
  const metadata = command.metadata ?? {};
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
    throw new CompanyContentValidationError('metadata must be a JSON object');
  }
  const canonicalMetadata = canonicalCompanyContentJson(metadata);
  if (Buffer.byteLength(canonicalMetadata, 'utf8') > 65_536) {
    throw new CompanyContentValidationError('metadata must not exceed 65536 UTF-8 bytes');
  }
  const metadataSnapshot = deepFreezeCanonicalJson(
    JSON.parse(canonicalMetadata) as unknown,
  ) as Readonly<Record<string, unknown>>;
  const sourceCheckedAt = timestamp(command.attestation?.checkedAt, 'attestation.checkedAt');
  const sourceExpiresAt = timestamp(command.attestation?.expiresAt, 'attestation.expiresAt');
  if (sourceExpiresAt <= sourceCheckedAt) {
    throw new CompanyContentValidationError('attestation.expiresAt must be after checkedAt');
  }
  if (new Date(sourceExpiresAt).getTime() - new Date(sourceCheckedAt).getTime()
      > 15 * 60 * 1_000) {
    throw new CompanyContentValidationError(
      'Source attestation freshness may not exceed 15 minutes',
    );
  }
  return Object.freeze({
    commandKey: commandKey(command.commandKey),
    contentItemId,
    previousVersionId,
    origin: command.origin,
    kind: command.kind,
    title,
    contentMimeType,
    content: command.content,
    sourceSystem,
    sourceItemId: exactText(command.source?.itemId, 'source.itemId', 500),
    sourceVersion: exactText(command.source?.version, 'source.version', 500),
    blobStorageKey: exactText(command.blob?.storageKey, 'blob.storageKey', 1024),
    blobSha256: digest(command.blob?.sha256, 'blob.sha256'),
    brandSnapshotRef: exactText(command.brand?.snapshotRef, 'brand.snapshotRef', 1024),
    brandSha256: digest(command.brand?.sha256, 'brand.sha256'),
    sourceCatalogSha256: digest(
      command.attestation?.catalogSha256,
      'attestation.catalogSha256',
    ),
    sourceCheckedAt,
    sourceExpiresAt,
    metadata: metadataSnapshot,
    contentSha256: createHash('sha256').update(command.content, 'utf8').digest('hex'),
  });
}

export interface NormalizedRefreshCompanyContentSourceAttestationCommand {
  readonly commandKey: string;
  readonly contentItemId: string;
  readonly contentVersionId: string;
  readonly sourceSystem: string;
  readonly sourceItemId: string;
  readonly sourceVersion: string;
  readonly contentSha256: string;
  readonly blobSha256: string;
  readonly brandSha256: string;
  readonly sourceCatalogSha256: string;
  readonly sourceCheckedAt: string;
  readonly sourceExpiresAt: string;
}

export function normalizeRefreshCompanyContentSourceAttestationCommand(
  command: RefreshCompanyContentSourceAttestationCommand,
): NormalizedRefreshCompanyContentSourceAttestationCommand {
  if (!command || typeof command !== 'object') {
    throw new CompanyContentValidationError('Source attestation refresh command is required');
  }
  const sourceSystem = exactText(command.expected?.source?.system, 'expected.source.system', 100);
  if (!SOURCE_SYSTEM.test(sourceSystem)) {
    throw new CompanyContentValidationError('expected.source.system is invalid');
  }
  const sourceCheckedAt = timestamp(command.attestation?.checkedAt, 'attestation.checkedAt');
  const sourceExpiresAt = timestamp(command.attestation?.expiresAt, 'attestation.expiresAt');
  if (sourceExpiresAt <= sourceCheckedAt) {
    throw new CompanyContentValidationError('attestation.expiresAt must be after checkedAt');
  }
  if (new Date(sourceExpiresAt).getTime() - new Date(sourceCheckedAt).getTime()
      > 15 * 60 * 1_000) {
    throw new CompanyContentValidationError(
      'Source attestation freshness may not exceed 15 minutes',
    );
  }
  return Object.freeze({
    commandKey: commandKey(command.commandKey),
    contentItemId: uuid(command.contentItemId, 'contentItemId'),
    contentVersionId: uuid(command.contentVersionId, 'contentVersionId'),
    sourceSystem,
    sourceItemId: exactText(command.expected?.source?.itemId, 'expected.source.itemId', 500),
    sourceVersion: exactText(command.expected?.source?.version, 'expected.source.version', 500),
    contentSha256: digest(command.expected?.contentSha256, 'expected.contentSha256'),
    blobSha256: digest(command.expected?.blobSha256, 'expected.blobSha256'),
    brandSha256: digest(command.expected?.brandSha256, 'expected.brandSha256'),
    sourceCatalogSha256: digest(
      command.attestation?.catalogSha256,
      'attestation.catalogSha256',
    ),
    sourceCheckedAt,
    sourceExpiresAt,
  });
}

export interface NormalizedApprovalRequestCommand {
  readonly commandKey: string;
  readonly contentItemId: string;
  readonly contentVersionId: string;
  readonly reviewNote: string | null;
}

export function normalizeApprovalRequestCommand(
  command: RequestCompanyContentApprovalCommand,
): NormalizedApprovalRequestCommand {
  if (!command || typeof command !== 'object') {
    throw new CompanyContentValidationError('Approval request command is required');
  }
  return Object.freeze({
    commandKey: commandKey(command.commandKey),
    contentItemId: uuid(command.contentItemId, 'contentItemId'),
    contentVersionId: uuid(command.contentVersionId, 'contentVersionId'),
    reviewNote: optionalText(command.reviewNote, 'reviewNote', 2000),
  });
}

export interface NormalizedApprovalDecisionCommand {
  readonly commandKey: string;
  readonly approvalRequestId: string;
  readonly decision: CompanyContentApprovalDecision;
  readonly decisionNote: string | null;
}

export function normalizeApprovalDecisionCommand(
  command: DecideCompanyContentApprovalCommand,
): NormalizedApprovalDecisionCommand {
  if (!command || typeof command !== 'object') {
    throw new CompanyContentValidationError('Approval decision command is required');
  }
  if (!DECISIONS.has(command.decision)) {
    throw new CompanyContentValidationError('decision is invalid');
  }
  const decisionNote = optionalText(command.decisionNote, 'decisionNote', 4000);
  if (command.decision !== 'approved' && decisionNote === null) {
    throw new CompanyContentValidationError(
      'Rejected and changes-requested decisions require a note',
    );
  }
  return Object.freeze({
    commandKey: commandKey(command.commandKey),
    approvalRequestId: uuid(command.approvalRequestId, 'approvalRequestId'),
    decision: command.decision,
    decisionNote,
  });
}

export function companyContentRequestHash(
  context: DatabaseRequestContext,
  commandName: string,
  payload: unknown,
): Buffer {
  validateCompanyContentUserContext(context);
  return createHash('sha256').update(canonicalCompanyContentJson({
    actorKind: context.actorKind,
    actorUserId: context.userId!.toLowerCase(),
    commandName,
    payload,
  }), 'utf8').digest();
}

export function sha256HexToBuffer(value: string): Buffer {
  return Buffer.from(digest(value, 'sha256'), 'hex');
}

export function sha256BytesToHex(value: Uint8Array): string {
  if (value.byteLength !== 32) {
    throw new Error('Database returned a non-SHA-256 digest');
  }
  return Buffer.from(value).toString('hex');
}
