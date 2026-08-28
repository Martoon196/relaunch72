import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import {
  previewLegacyCsvImport,
  type CsvImportMapping,
  type CsvImportPreview,
  type CsvPreviewLimits,
} from './csv-preview.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u;
const SAFE_OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._~:-]{15,199}$/u;
const API_TOKEN = /^ppmig_[A-Za-z0-9_-]{32,128}$/u;
const EMAIL_ADDRESS = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu;
const UK_POSTCODE = /\b(?:GIR\s?0AA|[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2})\b/iu;
const SECRET_MARKER = /(?:authorization|bearer|password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)/iu;

const HARD_LIMITS = Object.freeze({
  maxBytes: 10 * 1024 * 1024,
  maxRows: 50_000,
  maxColumns: 250,
  maxCellBytes: 128 * 1024,
});
const DEFAULT_LIMITS = Object.freeze({
  maxBytes: 5 * 1024 * 1024,
  maxRows: 10_000,
  maxColumns: 100,
  maxCellBytes: 64 * 1024,
});
const DEFAULT_RECEIPT_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_RECEIPT_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_CHUNKS = 32_768;
const MAX_MAX_CHUNKS = 65_536;
const MAX_AFFILIATE_SOURCE_HEADERS = 16;
const MAX_MAPPING_COLUMNS = 32;

export type MigrationCommandOperation = 'preview' | 'commit_receipt';
export type MigrationAuthenticationKind = 'portal_session' | 'public_api_token';
export type MigrationOperatorRole = 'founder' | 'admin' | 'migration_operator';

export interface MigrationAuthenticatedPrincipal {
  readonly workspaceId: string;
  readonly actorId: string;
  readonly role: MigrationOperatorRole;
  readonly authentication: MigrationAuthenticationKind;
  /** Hash of upstream session/token evidence. Raw credentials never enter receipts. */
  readonly authenticationProofSha256: string;
}

export interface MigrationPublicApiTokenAuthorization {
  readonly tokenSha256: string;
  readonly operation: MigrationCommandOperation;
}

export type MigrationPublicApiTokenDecision =
  | Readonly<{ allowed: true; principal: MigrationAuthenticatedPrincipal }>
  | Readonly<{ allowed: false; reason: 'invalid' | 'revoked' | 'scope_denied' }>;

/** Implemented by the API-token store. It receives a digest, never the bearer token. */
export interface MigrationPublicApiTokenDirectory {
  authorize(
    input: MigrationPublicApiTokenAuthorization,
  ): Promise<MigrationPublicApiTokenDecision> | MigrationPublicApiTokenDecision;
}

export interface MigrationRateLimitRequest {
  readonly workspaceId: string;
  readonly actorFingerprintSha256: string;
  readonly tokenSha256: string | null;
  readonly operation: MigrationCommandOperation;
  /** Pre-body metadata scope for preview; exact command digest for commit receipts. */
  readonly rateLimitScopeSha256: string;
  readonly requestedAt: string;
}

export type MigrationRateLimitDecision =
  | Readonly<{
      allowed: true;
      reservationSha256: string;
      remaining: number;
      resetAt: string;
    }>
  | Readonly<{ allowed: false; retryAfterSeconds: number }>;

/** Durable deployments should implement this with an atomic, workspace-scoped counter. */
export interface MigrationRateLimitGate {
  reserve(
    input: MigrationRateLimitRequest,
  ): Promise<MigrationRateLimitDecision> | MigrationRateLimitDecision;
}

export interface MigrationCommandFenceRequest {
  readonly namespace: 'preview' | 'commit_receipt';
  readonly workspaceId: string;
  readonly actorFingerprintSha256: string;
  readonly idempotencyKeySha256: string;
  readonly commandSha256: string;
  readonly proposedOpaqueId: string;
  readonly proposedAt: string;
}

export type MigrationCommandFenceDecision =
  | Readonly<{ disposition: 'new' | 'replayed'; opaqueId: string; issuedAt: string }>
  | Readonly<{ disposition: 'conflict' | 'unavailable' }>;

/**
 * Atomic metadata fence. Implementations store only hashes/opaque IDs and must
 * return conflict when one key is reused for a different command hash.
 */
export interface MigrationCommandFence {
  claim(
    input: MigrationCommandFenceRequest,
  ): Promise<MigrationCommandFenceDecision> | MigrationCommandFenceDecision;
}

export interface MigrationReceiptSigner {
  sign(receiptSha256: string): Promise<string> | string;
  verify(receiptSha256: string, hmacSha256: string): Promise<boolean> | boolean;
}

export interface MigrationSourceDescriptor {
  readonly system: string;
  /** Opaque export ID only. It is hashed immediately and never returned. */
  readonly reference?: string;
  readonly exportedAt?: string;
}

export interface MigrationCsvAcquisitionCommand {
  readonly idempotencyKey: string;
  readonly adapterId: string;
  readonly source: MigrationSourceDescriptor;
  readonly contentType: string;
  readonly contentEncoding?: string;
  readonly declaredContentLength?: number;
  readonly chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
  readonly mapping: CsvImportMapping;
  readonly limits?: CsvPreviewLimits;
}

export interface MigrationPublicApiPreviewCommand extends MigrationCsvAcquisitionCommand {
  readonly bearerToken: string;
}

export interface MigrationRateLimitEvidence {
  readonly reservationSha256: string;
  readonly remaining: number;
  readonly resetAt: string;
}

export interface MigrationAcquisitionReceipt {
  readonly schemaVersion: 1;
  readonly acquisition: 'portal_upload' | 'public_api_body';
  readonly adapterId: string;
  readonly sourceSystem: string;
  readonly sourceReferenceSha256: string | null;
  readonly sourceExportedAt: string | null;
  readonly mediaType: 'text/csv' | 'application/csv';
  readonly charset: 'utf-8';
  readonly contentEncoding: 'identity';
  readonly declaredByteCount: number | null;
  readonly byteCount: number;
  readonly sourceSha256: string;
  readonly firstObservedAt: string;
  readonly effects: Readonly<{
    requestBodyReads: 1;
    databaseWrites: 0;
    externalMutations: 0;
    providerCalls: 0;
  }>;
  readonly receiptSha256: string;
}

export interface MigrationPreviewReceipt {
  readonly schemaVersion: 1;
  readonly batchId: string;
  readonly workspaceId: string;
  readonly requestedBySha256: string;
  readonly authentication: MigrationAuthenticationKind;
  readonly idempotencyKeySha256: string;
  readonly acquisitionReceiptSha256: string;
  readonly csvPreviewReceiptSha256: string;
  readonly sourceSha256: string;
  readonly headerSchemaSha256: string;
  readonly mappingSha256: string;
  /** Binds headers, accepted records and position-only quarantine evidence. */
  readonly previewDataSha256: string;
  /** Binds accepted affiliate column names and values without exposing them. */
  readonly affiliateAttributionSha256: string;
  readonly affiliateSourceHeaderCount: number;
  readonly affiliateValueCount: number;
  readonly acceptedRowCount: number;
  readonly quarantinedRowCount: number;
  readonly firstIssuedAt: string;
  readonly expiresAt: string;
  readonly previewOnly: true;
  readonly explicitCommitRequired: true;
  readonly liveCustomerImport: false;
  readonly effects: Readonly<{
    customerDataWrites: 0;
    providerCalls: 0;
    externalMutations: 0;
    controlMetadata: 'rate_limit_and_idempotency_only';
  }>;
  readonly receiptSha256: string;
  readonly receiptHmacSha256: string;
}

export interface MigrationPreviewResult {
  readonly disposition: 'new' | 'replayed';
  readonly acquisition: MigrationAcquisitionReceipt;
  readonly preview: CsvImportPreview;
  readonly receipt: MigrationPreviewReceipt;
  readonly rateLimit: MigrationRateLimitEvidence;
}

export interface MigrationCommitReceiptCommand {
  readonly idempotencyKey: string;
  readonly confirmation: 'commit_exact_preview';
  readonly expectedBatchId: string;
  readonly expectedPreviewReceiptSha256: string;
  readonly expectedSourceSha256: string;
  readonly expectedAffiliateAttributionSha256: string;
  readonly previewResult: MigrationPreviewResult;
}

export interface MigrationPublicApiCommitReceiptCommand extends MigrationCommitReceiptCommand {
  readonly bearerToken: string;
}

export interface MigrationCommitReceipt {
  readonly schemaVersion: 1;
  readonly receiptId: string;
  readonly batchId: string;
  readonly workspaceId: string;
  readonly previewRequestedBySha256: string;
  readonly commitRequestedBySha256: string;
  readonly authentication: MigrationAuthenticationKind;
  readonly idempotencyKeySha256: string;
  readonly previewReceiptSha256: string;
  readonly acquisitionReceiptSha256: string;
  readonly sourceSha256: string;
  readonly headerSchemaSha256: string;
  readonly mappingSha256: string;
  readonly previewDataSha256: string;
  readonly affiliateAttributionSha256: string;
  readonly acceptedRowCount: number;
  readonly quarantinedRowCount: number;
  readonly issuedAt: string;
  readonly execution: 'not_executed_dark_contract';
  readonly liveCustomerImport: false;
  readonly effects: Readonly<{
    customerDataWrites: 0;
    providerCalls: 0;
    externalMutations: 0;
    controlMetadata: 'rate_limit_and_idempotency_only';
  }>;
  readonly receiptSha256: string;
  readonly receiptHmacSha256: string;
}

export interface MigrationCommitReceiptResult {
  readonly disposition: 'new' | 'replayed';
  readonly receipt: MigrationCommitReceipt;
  readonly rateLimit: MigrationRateLimitEvidence;
}

export type MigrationCentreErrorCode =
  | 'principal_invalid'
  | 'principal_forbidden'
  | 'api_token_invalid'
  | 'api_token_unauthorized'
  | 'idempotency_key_invalid'
  | 'source_descriptor_invalid'
  | 'mapping_invalid'
  | 'content_type_unsafe'
  | 'content_encoding_unsafe'
  | 'declared_length_invalid'
  | 'source_stream_invalid'
  | 'source_stream_failed'
  | 'source_too_large'
  | 'source_length_mismatch'
  | 'rate_limited'
  | 'control_unavailable'
  | 'idempotency_conflict'
  | 'receipt_invalid'
  | 'receipt_expired'
  | 'commit_confirmation_invalid';

const ERROR_MESSAGES: Readonly<Record<MigrationCentreErrorCode, string>> = Object.freeze({
  principal_invalid: 'The authenticated migration principal is invalid.',
  principal_forbidden: 'The authenticated principal cannot use the migration boundary.',
  api_token_invalid: 'The migration API token is invalid.',
  api_token_unauthorized: 'The migration API token is not authorised for this operation.',
  idempotency_key_invalid: 'The migration idempotency key is invalid.',
  source_descriptor_invalid: 'The migration source descriptor is invalid.',
  mapping_invalid: 'The migration field mapping is invalid.',
  content_type_unsafe: 'The upload content type is not an approved UTF-8 CSV type.',
  content_encoding_unsafe: 'The upload content encoding is not supported.',
  declared_length_invalid: 'The declared upload length is invalid.',
  source_stream_invalid: 'The upload stream is invalid.',
  source_stream_failed: 'The upload stream could not be read safely.',
  source_too_large: 'The upload exceeds its byte limit.',
  source_length_mismatch: 'The upload length does not match its declaration.',
  rate_limited: 'The migration command rate limit has been reached.',
  control_unavailable: 'A required migration control is unavailable.',
  idempotency_conflict: 'The idempotency key is already bound to a different migration command.',
  receipt_invalid: 'The migration preview receipt is invalid.',
  receipt_expired: 'The migration preview receipt has expired.',
  commit_confirmation_invalid: 'The exact preview commit confirmation is invalid.',
});

/** Fixed-code error. Messages never interpolate credentials, source data or identifiers. */
export class MigrationCentreError extends Error {
  constructor(
    readonly code: MigrationCentreErrorCode,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(ERROR_MESSAGES[code]);
    this.name = 'MigrationCentreError';
  }
}

interface ResolvedLimits {
  readonly maxBytes: number;
  readonly maxRows: number;
  readonly maxColumns: number;
  readonly maxCellBytes: number;
}

interface NormalizedAcquisition {
  readonly idempotencyKeySha256: string;
  readonly adapterId: string;
  readonly sourceSystem: string;
  readonly sourceReferenceSha256: string | null;
  readonly sourceExportedAt: string | null;
  readonly mediaType: 'text/csv' | 'application/csv';
  readonly declaredContentLength: number | null;
  readonly chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
  readonly mapping: CsvImportMapping;
  readonly limits: ResolvedLimits;
  readonly metadataSha256: string;
}

interface VerifiedPreview {
  readonly receipt: MigrationPreviewReceipt;
  readonly acquisition: MigrationAcquisitionReceipt;
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new MigrationCentreError('receipt_invalid');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value !== 'object') throw new MigrationCentreError('receipt_invalid');
  const object = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(object).sort().map((key) => {
    const entry = object[key];
    if (entry === undefined) throw new MigrationCentreError('receipt_invalid');
    return `${JSON.stringify(key)}:${canonicalJson(entry)}`;
  }).join(',')}}`;
}

function digest(value: unknown): string {
  return sha256(canonicalJson(value));
}

async function invokeControl<T>(operation: () => Promise<T> | T): Promise<T> {
  try {
    return await operation();
  } catch {
    throw new MigrationCentreError('control_unavailable');
  }
}

function exactInstant(value: unknown, code: MigrationCentreErrorCode): string {
  if (typeof value !== 'string' || value.length < 20 || value.length > 30) {
    throw new MigrationCentreError(code);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new MigrationCentreError(code);
  }
  return value;
}

function containsPhoneNumber(value: string): boolean {
  const candidates = value.match(/(?:\+|\b0)[\d\s().-]{8,}\d/gu) ?? [];
  return candidates.some((candidate) => {
    const count = candidate.replace(/\D/gu, '').length;
    return count >= 10 && count <= 15;
  });
}

function opaqueDigest(value: unknown, minimum = 16): string {
  if (typeof value !== 'string' || value.length < minimum || !SAFE_OPAQUE.test(value)
      || EMAIL_ADDRESS.test(value) || UK_POSTCODE.test(value)
      || containsPhoneNumber(value) || SECRET_MARKER.test(value)) {
    throw new MigrationCentreError('idempotency_key_invalid');
  }
  return sha256(value);
}

function safeSourceReference(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !SAFE_OPAQUE.test(value)
      || EMAIL_ADDRESS.test(value) || UK_POSTCODE.test(value)
      || containsPhoneNumber(value) || SECRET_MARKER.test(value)) {
    throw new MigrationCentreError('source_descriptor_invalid');
  }
  return sha256(value);
}

function safeDescriptorId(value: unknown): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)
      || EMAIL_ADDRESS.test(value) || UK_POSTCODE.test(value)
      || containsPhoneNumber(value) || SECRET_MARKER.test(value)) {
    throw new MigrationCentreError('source_descriptor_invalid');
  }
  return value;
}

function validateMappingEnvelope(value: unknown): CsvImportMapping {
  if (!value || typeof value !== 'object') throw new MigrationCentreError('mapping_invalid');
  const mapping = value as Readonly<Record<string, unknown>>;
  if (!Array.isArray(mapping.columns) || mapping.columns.length < 1
      || mapping.columns.length > MAX_MAPPING_COLUMNS
      || (mapping.affiliateSourceHeaders !== undefined
        && (!Array.isArray(mapping.affiliateSourceHeaders)
          || mapping.affiliateSourceHeaders.length > MAX_AFFILIATE_SOURCE_HEADERS))
      || (mapping.requiredTargetFields !== undefined
        && (!Array.isArray(mapping.requiredTargetFields)
          || mapping.requiredTargetFields.length > MAX_MAPPING_COLUMNS))) {
    throw new MigrationCentreError('mapping_invalid');
  }
  return value as CsvImportMapping;
}

function positiveLimit(value: number | undefined, fallback: number, hard: number): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > hard) {
    throw new MigrationCentreError('source_descriptor_invalid');
  }
  return candidate;
}

function resolveLimits(input: CsvPreviewLimits | undefined): ResolvedLimits {
  return Object.freeze({
    maxBytes: positiveLimit(input?.maxBytes, DEFAULT_LIMITS.maxBytes, HARD_LIMITS.maxBytes),
    maxRows: positiveLimit(input?.maxRows, DEFAULT_LIMITS.maxRows, HARD_LIMITS.maxRows),
    maxColumns: positiveLimit(input?.maxColumns, DEFAULT_LIMITS.maxColumns, HARD_LIMITS.maxColumns),
    maxCellBytes: positiveLimit(input?.maxCellBytes, DEFAULT_LIMITS.maxCellBytes, HARD_LIMITS.maxCellBytes),
  });
}

function parseContentType(value: unknown): 'text/csv' | 'application/csv' {
  if (typeof value !== 'string' || value !== value.trim() || value.length < 1 || value.length > 128
      || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new MigrationCentreError('content_type_unsafe');
  }
  const parts = value.split(';').map((part) => part.trim());
  const rawMediaType = parts.shift()?.toLocaleLowerCase('en-GB');
  if (rawMediaType !== 'text/csv' && rawMediaType !== 'application/csv') {
    throw new MigrationCentreError('content_type_unsafe');
  }
  let charsetSeen = false;
  for (const parameter of parts) {
    const match = /^charset=(?:"utf-8"|utf-8)$/iu.exec(parameter);
    if (!match || charsetSeen) throw new MigrationCentreError('content_type_unsafe');
    charsetSeen = true;
  }
  return rawMediaType;
}

function normalizeAcquisition(input: MigrationCsvAcquisitionCommand): NormalizedAcquisition {
  if (!input || typeof input !== 'object') throw new MigrationCentreError('source_descriptor_invalid');
  const adapterId = safeDescriptorId(input.adapterId);
  const sourceSystem = safeDescriptorId(input.source?.system);
  const sourceReferenceSha256 = safeSourceReference(input.source.reference);
  const sourceExportedAt = input.source.exportedAt === undefined
    ? null
    : exactInstant(input.source.exportedAt, 'source_descriptor_invalid');
  const mediaType = parseContentType(input.contentType);
  const contentEncoding = input.contentEncoding ?? 'identity';
  if (contentEncoding !== 'identity') throw new MigrationCentreError('content_encoding_unsafe');
  const limits = resolveLimits(input.limits);
  const declaredContentLength = input.declaredContentLength ?? null;
  if (declaredContentLength !== null
      && (!Number.isSafeInteger(declaredContentLength) || declaredContentLength < 0
        || declaredContentLength > limits.maxBytes)) {
    throw new MigrationCentreError('declared_length_invalid');
  }
  const chunks = input.chunks;
  const source = chunks as unknown as Readonly<Record<PropertyKey, unknown>>;
  if (!chunks || (typeof source[Symbol.asyncIterator] !== 'function'
      && typeof source[Symbol.iterator] !== 'function')) {
    throw new MigrationCentreError('source_stream_invalid');
  }
  const idempotencyKeySha256 = opaqueDigest(input.idempotencyKey);
  const metadata = Object.freeze({
    adapterId,
    sourceSystem,
    sourceReferenceSha256,
    sourceExportedAt,
    mediaType,
    contentEncoding: 'identity',
    declaredContentLength,
    limits,
  });
  return Object.freeze({
    idempotencyKeySha256,
    adapterId,
    sourceSystem,
    sourceReferenceSha256,
    sourceExportedAt,
    mediaType,
    declaredContentLength,
    chunks,
    mapping: validateMappingEnvelope(input.mapping),
    limits,
    metadataSha256: digest(metadata),
  });
}

function principal(input: MigrationAuthenticatedPrincipal, expected?: MigrationAuthenticationKind): MigrationAuthenticatedPrincipal {
  if (!input || typeof input !== 'object' || !UUID.test(input.workspaceId)
      || !UUID.test(input.actorId) || !SHA256.test(input.authenticationProofSha256)
      || !(['portal_session', 'public_api_token'] as const).includes(input.authentication)
      || (expected !== undefined && input.authentication !== expected)) {
    throw new MigrationCentreError('principal_invalid');
  }
  if (!(['founder', 'admin', 'migration_operator'] as readonly unknown[]).includes(input.role)) {
    throw new MigrationCentreError('principal_forbidden');
  }
  return Object.freeze({ ...input });
}

function actorFingerprint(input: MigrationAuthenticatedPrincipal): string {
  return digest({
    actorId: input.actorId,
    authentication: input.authentication,
    authenticationProofSha256: input.authenticationProofSha256,
    workspaceId: input.workspaceId,
  });
}

function assertSha(value: unknown): string {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new MigrationCentreError('receipt_invalid');
  }
  return value;
}

function assertUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new MigrationCentreError('receipt_invalid');
  }
  return value;
}

function unsignedReceipt<T extends { readonly receiptSha256: string }>(receipt: T): Omit<T, 'receiptSha256'> {
  const { receiptSha256: _receiptSha256, ...unsigned } = receipt;
  return unsigned;
}

function unsignedSignedReceipt<
  T extends { readonly receiptSha256: string; readonly receiptHmacSha256: string },
>(receipt: T): Omit<T, 'receiptSha256' | 'receiptHmacSha256'> {
  const { receiptSha256: _receiptSha256, receiptHmacSha256: _receiptHmacSha256, ...unsigned } = receipt;
  return unsigned;
}

async function collectBytes(
  source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  maximumBytes: number,
  maximumChunks: number,
  declaredLength: number | null,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let byteCount = 0;
  let chunkCount = 0;
  try {
    for await (const supplied of source) {
      chunkCount += 1;
      if (chunkCount > maximumChunks) throw new MigrationCentreError('source_stream_invalid');
      if (!(supplied instanceof Uint8Array)) throw new MigrationCentreError('source_stream_invalid');
      if (supplied.byteLength > maximumBytes - byteCount) {
        throw new MigrationCentreError('source_too_large');
      }
      const copy = Uint8Array.from(supplied);
      chunks.push(copy);
      byteCount += copy.byteLength;
    }
  } catch (error) {
    if (error instanceof MigrationCentreError) throw error;
    throw new MigrationCentreError('source_stream_failed');
  }
  if (declaredLength !== null && byteCount !== declaredLength) {
    throw new MigrationCentreError('source_length_mismatch');
  }
  const bytes = new Uint8Array(byteCount);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function affiliateEvidence(preview: CsvImportPreview): Readonly<{
  sha256: string;
  valueCount: number;
  headerCount: number;
}> {
  const evidence = preview.records.map((record) => Object.freeze({
    sourceRowNumber: record.provenance.sourceRowNumber,
    affiliateSources: record.affiliateSources.map((entry) => Object.freeze({
      column: entry.column,
      value: entry.value,
    })),
  }));
  const headers = new Set(evidence.flatMap((row) => row.affiliateSources.map((entry) => entry.column)));
  return Object.freeze({
    sha256: digest(evidence),
    valueCount: evidence.reduce((sum, row) => sum + row.affiliateSources.length, 0),
    headerCount: headers.size,
  });
}

function previewDataSha256(preview: CsvImportPreview): string {
  return digest({
    canonicalHeaders: preview.canonicalHeaders,
    records: preview.records,
    quarantinedRows: preview.quarantinedRows,
  });
}

function validateRateDecision(decision: MigrationRateLimitDecision): MigrationRateLimitEvidence {
  if (!decision || typeof decision !== 'object' || typeof decision.allowed !== 'boolean') {
    throw new MigrationCentreError('control_unavailable');
  }
  if (!decision.allowed) {
    if (!Number.isSafeInteger(decision.retryAfterSeconds)
        || decision.retryAfterSeconds < 1 || decision.retryAfterSeconds > 86_400) {
      throw new MigrationCentreError('control_unavailable');
    }
    throw new MigrationCentreError('rate_limited', decision.retryAfterSeconds);
  }
  if (!SHA256.test(decision.reservationSha256)
      || !Number.isSafeInteger(decision.remaining) || decision.remaining < 0) {
    throw new MigrationCentreError('control_unavailable');
  }
  const resetAt = exactInstant(decision.resetAt, 'control_unavailable');
  return Object.freeze({
    reservationSha256: decision.reservationSha256,
    remaining: decision.remaining,
    resetAt,
  });
}

function validateFenceDecision(
  decision: MigrationCommandFenceDecision,
  now: Date,
): Readonly<{ disposition: 'new' | 'replayed'; opaqueId: string; issuedAt: string }> {
  if (!decision || typeof decision !== 'object') throw new MigrationCentreError('control_unavailable');
  if (decision.disposition === 'conflict') throw new MigrationCentreError('idempotency_conflict');
  if (decision.disposition === 'unavailable') throw new MigrationCentreError('control_unavailable');
  if (decision.disposition !== 'new' && decision.disposition !== 'replayed') {
    throw new MigrationCentreError('control_unavailable');
  }
  const opaqueId = assertUuid(decision.opaqueId);
  const issuedAt = exactInstant(decision.issuedAt, 'control_unavailable');
  if (new Date(issuedAt).getTime() > now.getTime() + 5 * 60 * 1_000) {
    throw new MigrationCentreError('control_unavailable');
  }
  return Object.freeze({ disposition: decision.disposition, opaqueId, issuedAt });
}

function buildAcquisitionReceipt(input: Omit<MigrationAcquisitionReceipt, 'receiptSha256'>): MigrationAcquisitionReceipt {
  return Object.freeze({ ...input, receiptSha256: digest(input) });
}

function verifyAcquisitionReceipt(input: MigrationAcquisitionReceipt): void {
  if (!input || typeof input !== 'object' || input.schemaVersion !== 1
      || (input.acquisition !== 'portal_upload' && input.acquisition !== 'public_api_body')
      || !SAFE_ID.test(input.adapterId) || !SAFE_ID.test(input.sourceSystem)
      || (input.sourceReferenceSha256 !== null && !SHA256.test(input.sourceReferenceSha256))
      || (input.sourceExportedAt !== null
        && exactInstant(input.sourceExportedAt, 'receipt_invalid') !== input.sourceExportedAt)
      || (input.mediaType !== 'text/csv' && input.mediaType !== 'application/csv')
      || input.charset !== 'utf-8' || input.contentEncoding !== 'identity'
      || (input.declaredByteCount !== null
        && (!Number.isSafeInteger(input.declaredByteCount) || input.declaredByteCount < 0))
      || !Number.isSafeInteger(input.byteCount) || input.byteCount < 0
      || input.byteCount > HARD_LIMITS.maxBytes
      || input.declaredByteCount !== null && input.declaredByteCount !== input.byteCount
      || !SHA256.test(input.sourceSha256)
      || !input.effects || input.effects.requestBodyReads !== 1
      || input.effects.databaseWrites !== 0 || input.effects.externalMutations !== 0
      || input.effects.providerCalls !== 0) {
    throw new MigrationCentreError('receipt_invalid');
  }
  exactInstant(input.firstObservedAt, 'receipt_invalid');
  if (digest(unsignedReceipt(input)) !== input.receiptSha256) {
    throw new MigrationCentreError('receipt_invalid');
  }
}

function verifyCsvPreview(preview: CsvImportPreview, acquisition: MigrationAcquisitionReceipt): void {
  if (!preview || preview.schemaVersion !== 1 || preview.previewOnly !== true
      || preview.providerEffects !== false || preview.receipt.sourceAcquisition !== 'outside_preview_boundary'
      || preview.receipt.effects.databaseWrites !== 0 || preview.receipt.effects.externalMutations !== 0
      || preview.receipt.effects.providerCalls !== 0
      || preview.receipt.adapterId !== acquisition.adapterId
      || preview.receipt.sourceSha256 !== acquisition.sourceSha256
      || preview.receipt.byteCount !== acquisition.byteCount
      || !Number.isSafeInteger(preview.receipt.rowCount) || preview.receipt.rowCount < 0
      || preview.receipt.rowCount > HARD_LIMITS.maxRows
      || !Number.isSafeInteger(preview.receipt.columnCount) || preview.receipt.columnCount < 1
      || preview.receipt.columnCount > HARD_LIMITS.maxColumns
      || preview.canonicalHeaders.length !== preview.receipt.columnCount
      || preview.receipt.acceptedRowCount !== preview.records.length
      || preview.receipt.quarantinedRowCount !== preview.quarantinedRows.length
      || preview.receipt.acceptedRowCount + preview.receipt.quarantinedRowCount
        !== preview.receipt.rowCount
      || sha256(JSON.stringify(preview.canonicalHeaders)) !== preview.receipt.headerSchemaSha256
      // csv-preview/v1 predates the canonical object-key serializer used by
      // this boundary; preserve and verify its exact insertion-order contract.
      || sha256(JSON.stringify(unsignedReceipt(preview.receipt))) !== preview.receipt.receiptSha256) {
    throw new MigrationCentreError('receipt_invalid');
  }
  for (const record of preview.records) {
    const provenance = record.provenance;
    if (provenance.adapterId !== preview.receipt.adapterId
        || provenance.sourceSha256 !== preview.receipt.sourceSha256
        || provenance.headerSchemaSha256 !== preview.receipt.headerSchemaSha256
        || provenance.mappingSha256 !== preview.receipt.mappingSha256) {
      throw new MigrationCentreError('receipt_invalid');
    }
  }
}

function assertExpectedCommit(input: MigrationCommitReceiptCommand): void {
  if (!input || typeof input !== 'object'
      || input.confirmation !== 'commit_exact_preview'
      || input.expectedBatchId !== input.previewResult?.receipt?.batchId
      || input.expectedPreviewReceiptSha256 !== input.previewResult?.receipt?.receiptSha256
      || input.expectedSourceSha256 !== input.previewResult?.receipt?.sourceSha256
      || input.expectedAffiliateAttributionSha256
        !== input.previewResult?.receipt?.affiliateAttributionSha256) {
    throw new MigrationCentreError('commit_confirmation_invalid');
  }
}

/** Hashes a strongly scoped API bearer token without retaining or returning it. */
export function hashMigrationPublicApiToken(rawToken: unknown): string {
  if (typeof rawToken !== 'string' || !API_TOKEN.test(rawToken)) {
    throw new MigrationCentreError('api_token_invalid');
  }
  return sha256(rawToken);
}

/** HMAC authority for self-contained preview/commit receipts. Secret is 32-byte lowercase hex. */
export function createHmacMigrationReceiptSigner(secretHex: string): MigrationReceiptSigner {
  if (!/^[0-9a-f]{64}$/u.test(secretHex)) throw new MigrationCentreError('control_unavailable');
  const key = Buffer.from(secretHex, 'hex');
  const sign = (receiptSha256: string): string => {
    if (!SHA256.test(receiptSha256)) throw new MigrationCentreError('receipt_invalid');
    return createHmac('sha256', key).update(receiptSha256, 'utf8').digest('hex');
  };
  return Object.freeze({
    sign,
    verify(receiptSha256: string, supplied: string): boolean {
      if (!SHA256.test(receiptSha256) || !SHA256.test(supplied)) return false;
      return timingSafeEqual(Buffer.from(sign(receiptSha256), 'hex'), Buffer.from(supplied, 'hex'));
    },
  });
}

export interface MigrationCentreBoundaryOptions {
  readonly signer: MigrationReceiptSigner;
  readonly fence: MigrationCommandFence;
  readonly rateLimit: MigrationRateLimitGate;
  readonly apiTokens?: MigrationPublicApiTokenDirectory;
  readonly now?: () => Date;
  readonly opaqueId?: () => string;
  readonly receiptTtlMs?: number;
  readonly maxChunks?: number;
}

/**
 * Authenticated migration control plane. It can acquire and preview CSV bytes
 * and issue a tamper-evident dark commit receipt. It deliberately has no
 * customer repository, live importer or external-provider dependency.
 */
export class MigrationCentreBoundary {
  private readonly now: () => Date;
  private readonly opaqueId: () => string;
  private readonly receiptTtlMs: number;
  private readonly maxChunks: number;

  constructor(private readonly options: MigrationCentreBoundaryOptions) {
    if (!options?.signer || !options.fence || !options.rateLimit) {
      throw new MigrationCentreError('control_unavailable');
    }
    this.now = options.now ?? (() => new Date());
    this.opaqueId = options.opaqueId ?? randomUUID;
    this.receiptTtlMs = options.receiptTtlMs ?? DEFAULT_RECEIPT_TTL_MS;
    this.maxChunks = options.maxChunks ?? DEFAULT_MAX_CHUNKS;
    if (!Number.isSafeInteger(this.receiptTtlMs) || this.receiptTtlMs < 60_000
        || this.receiptTtlMs > MAX_RECEIPT_TTL_MS
        || !Number.isSafeInteger(this.maxChunks) || this.maxChunks < 1
        || this.maxChunks > MAX_MAX_CHUNKS) {
      throw new MigrationCentreError('control_unavailable');
    }
  }

  async previewPortal(
    authenticated: MigrationAuthenticatedPrincipal,
    input: MigrationCsvAcquisitionCommand,
  ): Promise<MigrationPreviewResult> {
    return this.previewForPrincipal(principal(authenticated, 'portal_session'), input, null);
  }

  async previewPublicApi(input: MigrationPublicApiPreviewCommand): Promise<MigrationPreviewResult> {
    if (!input || typeof input !== 'object') throw new MigrationCentreError('api_token_invalid');
    const tokenSha256 = hashMigrationPublicApiToken(input.bearerToken);
    const authenticated = await this.apiPrincipal(tokenSha256, 'preview');
    return this.previewForPrincipal(authenticated, input, tokenSha256);
  }

  async commitReceiptPortal(
    authenticated: MigrationAuthenticatedPrincipal,
    input: MigrationCommitReceiptCommand,
  ): Promise<MigrationCommitReceiptResult> {
    return this.commitForPrincipal(principal(authenticated, 'portal_session'), input, null);
  }

  async commitReceiptPublicApi(
    input: MigrationPublicApiCommitReceiptCommand,
  ): Promise<MigrationCommitReceiptResult> {
    if (!input || typeof input !== 'object') throw new MigrationCentreError('api_token_invalid');
    const tokenSha256 = hashMigrationPublicApiToken(input.bearerToken);
    const authenticated = await this.apiPrincipal(tokenSha256, 'commit_receipt');
    return this.commitForPrincipal(authenticated, input, tokenSha256);
  }

  private async apiPrincipal(
    tokenSha256: string,
    operation: MigrationCommandOperation,
  ): Promise<MigrationAuthenticatedPrincipal> {
    if (!this.options.apiTokens) throw new MigrationCentreError('api_token_unauthorized');
    const decision = await invokeControl(
      () => this.options.apiTokens!.authorize({ tokenSha256, operation }),
    );
    if (!decision || decision.allowed !== true) {
      throw new MigrationCentreError('api_token_unauthorized');
    }
    const authenticated = principal(decision.principal, 'public_api_token');
    if (authenticated.authenticationProofSha256 !== tokenSha256) {
      throw new MigrationCentreError('api_token_unauthorized');
    }
    return authenticated;
  }

  private async reserveRateLimit(
    authenticated: MigrationAuthenticatedPrincipal,
    actorSha256: string,
    operation: MigrationCommandOperation,
    rateLimitScopeSha256: string,
    tokenSha256: string | null,
    requestedAt: string,
  ): Promise<MigrationRateLimitEvidence> {
    const decision = await invokeControl(() => this.options.rateLimit.reserve({
        workspaceId: authenticated.workspaceId,
        actorFingerprintSha256: actorSha256,
        tokenSha256,
        operation,
        rateLimitScopeSha256,
        requestedAt,
      }));
    return validateRateDecision(decision);
  }

  private async previewForPrincipal(
    authenticated: MigrationAuthenticatedPrincipal,
    input: MigrationCsvAcquisitionCommand,
    tokenSha256: string | null,
  ): Promise<MigrationPreviewResult> {
    const normalized = normalizeAcquisition(input);
    const requested = await invokeControl(this.now);
    if (!Number.isFinite(requested.getTime())) throw new MigrationCentreError('control_unavailable');
    if (normalized.sourceExportedAt !== null
        && new Date(normalized.sourceExportedAt).getTime() > requested.getTime() + 5 * 60 * 1_000) {
      throw new MigrationCentreError('source_descriptor_invalid');
    }
    const requestedAt = requested.toISOString();
    const actorSha256 = actorFingerprint(authenticated);
    const rateLimit = await this.reserveRateLimit(
      authenticated,
      actorSha256,
      'preview',
      normalized.metadataSha256,
      tokenSha256,
      requestedAt,
    );
    const bytes = await collectBytes(
      normalized.chunks,
      normalized.limits.maxBytes,
      this.maxChunks,
      normalized.declaredContentLength,
    );
    const csvPreview = previewLegacyCsvImport(
      { bytes, mediaType: normalized.mediaType },
      normalized.adapterId,
      normalized.mapping,
      normalized.limits,
    );
    const attribution = affiliateEvidence(csvPreview);
    const previewData = previewDataSha256(csvPreview);
    const commandSha256 = digest({
      actorSha256,
      workspaceId: authenticated.workspaceId,
      metadataSha256: normalized.metadataSha256,
      sourceSha256: csvPreview.receipt.sourceSha256,
      csvPreviewReceiptSha256: csvPreview.receipt.receiptSha256,
      previewDataSha256: previewData,
      affiliateAttributionSha256: attribution.sha256,
    });
    const proposedOpaqueId = await invokeControl(this.opaqueId);
    if (!UUID.test(proposedOpaqueId)) throw new MigrationCentreError('control_unavailable');
    const fenceDecision = await invokeControl(() => this.options.fence.claim({
        namespace: 'preview',
        workspaceId: authenticated.workspaceId,
        actorFingerprintSha256: actorSha256,
        idempotencyKeySha256: normalized.idempotencyKeySha256,
        commandSha256,
        proposedOpaqueId,
        proposedAt: requestedAt,
      }));
    const fence = validateFenceDecision(fenceDecision, requested);
    const firstIssued = new Date(fence.issuedAt);
    const expiresAt = new Date(firstIssued.getTime() + this.receiptTtlMs).toISOString();
    const acquisitionKind = authenticated.authentication === 'portal_session'
      ? 'portal_upload' as const
      : 'public_api_body' as const;
    const acquisition = buildAcquisitionReceipt({
      schemaVersion: 1,
      acquisition: acquisitionKind,
      adapterId: normalized.adapterId,
      sourceSystem: normalized.sourceSystem,
      sourceReferenceSha256: normalized.sourceReferenceSha256,
      sourceExportedAt: normalized.sourceExportedAt,
      mediaType: normalized.mediaType,
      charset: 'utf-8',
      contentEncoding: 'identity',
      declaredByteCount: normalized.declaredContentLength,
      byteCount: bytes.byteLength,
      sourceSha256: csvPreview.receipt.sourceSha256,
      firstObservedAt: fence.issuedAt,
      effects: Object.freeze({
        requestBodyReads: 1,
        databaseWrites: 0,
        externalMutations: 0,
        providerCalls: 0,
      }),
    });
    const unsigned = Object.freeze({
      schemaVersion: 1 as const,
      batchId: fence.opaqueId,
      workspaceId: authenticated.workspaceId,
      requestedBySha256: actorSha256,
      authentication: authenticated.authentication,
      idempotencyKeySha256: normalized.idempotencyKeySha256,
      acquisitionReceiptSha256: acquisition.receiptSha256,
      csvPreviewReceiptSha256: csvPreview.receipt.receiptSha256,
      sourceSha256: csvPreview.receipt.sourceSha256,
      headerSchemaSha256: csvPreview.receipt.headerSchemaSha256,
      mappingSha256: csvPreview.receipt.mappingSha256,
      previewDataSha256: previewData,
      affiliateAttributionSha256: attribution.sha256,
      affiliateSourceHeaderCount: attribution.headerCount,
      affiliateValueCount: attribution.valueCount,
      acceptedRowCount: csvPreview.receipt.acceptedRowCount,
      quarantinedRowCount: csvPreview.receipt.quarantinedRowCount,
      firstIssuedAt: fence.issuedAt,
      expiresAt,
      previewOnly: true as const,
      explicitCommitRequired: true as const,
      liveCustomerImport: false as const,
      effects: Object.freeze({
        customerDataWrites: 0 as const,
        providerCalls: 0 as const,
        externalMutations: 0 as const,
        controlMetadata: 'rate_limit_and_idempotency_only' as const,
      }),
    });
    const receiptSha256 = digest(unsigned);
    const receiptHmacSha256 = await invokeControl(
      () => this.options.signer.sign(receiptSha256),
    );
    if (!SHA256.test(receiptHmacSha256)) throw new MigrationCentreError('control_unavailable');
    return Object.freeze({
      disposition: fence.disposition,
      acquisition,
      preview: csvPreview,
      receipt: Object.freeze({ ...unsigned, receiptSha256, receiptHmacSha256 }),
      rateLimit,
    });
  }

  private async verifyPreviewResult(
    authenticated: MigrationAuthenticatedPrincipal,
    result: MigrationPreviewResult,
    now: Date,
  ): Promise<VerifiedPreview> {
    if (!result || typeof result !== 'object' || !result.receipt || !result.acquisition
        || !result.preview || (result.disposition !== 'new' && result.disposition !== 'replayed')) {
      throw new MigrationCentreError('receipt_invalid');
    }
    const receipt = result.receipt;
    verifyAcquisitionReceipt(result.acquisition);
    verifyCsvPreview(result.preview, result.acquisition);
    if (receipt.schemaVersion !== 1 || !UUID.test(receipt.batchId)
        || receipt.workspaceId !== authenticated.workspaceId
        || !SHA256.test(receipt.requestedBySha256)
        || (receipt.authentication !== 'portal_session' && receipt.authentication !== 'public_api_token')
        || !SHA256.test(receipt.idempotencyKeySha256)
        || receipt.acquisitionReceiptSha256 !== result.acquisition.receiptSha256
        || receipt.csvPreviewReceiptSha256 !== result.preview.receipt.receiptSha256
        || receipt.sourceSha256 !== result.preview.receipt.sourceSha256
        || receipt.headerSchemaSha256 !== result.preview.receipt.headerSchemaSha256
        || receipt.mappingSha256 !== result.preview.receipt.mappingSha256
        || receipt.previewDataSha256 !== previewDataSha256(result.preview)
        || receipt.acceptedRowCount !== result.preview.receipt.acceptedRowCount
        || receipt.quarantinedRowCount !== result.preview.receipt.quarantinedRowCount
        || receipt.previewOnly !== true || receipt.explicitCommitRequired !== true
        || receipt.liveCustomerImport !== false
        || !receipt.effects || receipt.effects.customerDataWrites !== 0
        || receipt.effects.providerCalls !== 0 || receipt.effects.externalMutations !== 0
        || receipt.effects.controlMetadata !== 'rate_limit_and_idempotency_only') {
      throw new MigrationCentreError('receipt_invalid');
    }
    const attribution = affiliateEvidence(result.preview);
    if (receipt.affiliateAttributionSha256 !== attribution.sha256
        || receipt.affiliateSourceHeaderCount !== attribution.headerCount
        || receipt.affiliateValueCount !== attribution.valueCount) {
      throw new MigrationCentreError('receipt_invalid');
    }
    const firstIssuedAt = exactInstant(receipt.firstIssuedAt, 'receipt_invalid');
    const expiresAt = exactInstant(receipt.expiresAt, 'receipt_invalid');
    if (new Date(expiresAt).getTime() - new Date(firstIssuedAt).getTime() !== this.receiptTtlMs) {
      throw new MigrationCentreError('receipt_invalid');
    }
    if (new Date(expiresAt).getTime() <= now.getTime()) {
      throw new MigrationCentreError('receipt_expired');
    }
    const receiptSha256 = digest(unsignedSignedReceipt(receipt));
    if (receipt.receiptSha256 !== receiptSha256
        || !SHA256.test(receipt.receiptHmacSha256)) {
      throw new MigrationCentreError('receipt_invalid');
    }
    const signatureValid = await invokeControl(
      () => this.options.signer.verify(receiptSha256, receipt.receiptHmacSha256),
    );
    if (signatureValid !== true) throw new MigrationCentreError('receipt_invalid');
    return Object.freeze({ receipt, acquisition: result.acquisition });
  }

  private async commitForPrincipal(
    authenticated: MigrationAuthenticatedPrincipal,
    input: MigrationCommitReceiptCommand,
    tokenSha256: string | null,
  ): Promise<MigrationCommitReceiptResult> {
    assertExpectedCommit(input);
    const idempotencyKeySha256 = opaqueDigest(input.idempotencyKey);
    const requested = await invokeControl(this.now);
    if (!Number.isFinite(requested.getTime())) throw new MigrationCentreError('control_unavailable');
    const verified = await this.verifyPreviewResult(authenticated, input.previewResult, requested);
    const actorSha256 = actorFingerprint(authenticated);
    const commandSha256 = digest({
      actorSha256,
      workspaceId: authenticated.workspaceId,
      batchId: verified.receipt.batchId,
      previewReceiptSha256: verified.receipt.receiptSha256,
      acquisitionReceiptSha256: verified.acquisition.receiptSha256,
      sourceSha256: verified.receipt.sourceSha256,
      affiliateAttributionSha256: verified.receipt.affiliateAttributionSha256,
      confirmation: 'commit_exact_preview',
    });
    const requestedAt = requested.toISOString();
    const rateLimit = await this.reserveRateLimit(
      authenticated,
      actorSha256,
      'commit_receipt',
      commandSha256,
      tokenSha256,
      requestedAt,
    );
    const proposedOpaqueId = await invokeControl(this.opaqueId);
    if (!UUID.test(proposedOpaqueId)) throw new MigrationCentreError('control_unavailable');
    const fenceDecision = await invokeControl(() => this.options.fence.claim({
        namespace: 'commit_receipt',
        workspaceId: authenticated.workspaceId,
        actorFingerprintSha256: actorSha256,
        idempotencyKeySha256,
        commandSha256,
        proposedOpaqueId,
        proposedAt: requestedAt,
      }));
    const fence = validateFenceDecision(fenceDecision, requested);
    const unsigned = Object.freeze({
      schemaVersion: 1 as const,
      receiptId: fence.opaqueId,
      batchId: verified.receipt.batchId,
      workspaceId: authenticated.workspaceId,
      previewRequestedBySha256: verified.receipt.requestedBySha256,
      commitRequestedBySha256: actorSha256,
      authentication: authenticated.authentication,
      idempotencyKeySha256,
      previewReceiptSha256: verified.receipt.receiptSha256,
      acquisitionReceiptSha256: verified.acquisition.receiptSha256,
      sourceSha256: verified.receipt.sourceSha256,
      headerSchemaSha256: verified.receipt.headerSchemaSha256,
      mappingSha256: verified.receipt.mappingSha256,
      previewDataSha256: verified.receipt.previewDataSha256,
      affiliateAttributionSha256: verified.receipt.affiliateAttributionSha256,
      acceptedRowCount: verified.receipt.acceptedRowCount,
      quarantinedRowCount: verified.receipt.quarantinedRowCount,
      issuedAt: fence.issuedAt,
      execution: 'not_executed_dark_contract' as const,
      liveCustomerImport: false as const,
      effects: Object.freeze({
        customerDataWrites: 0 as const,
        providerCalls: 0 as const,
        externalMutations: 0 as const,
        controlMetadata: 'rate_limit_and_idempotency_only' as const,
      }),
    });
    const receiptSha256 = digest(unsigned);
    const receiptHmacSha256 = await invokeControl(
      () => this.options.signer.sign(receiptSha256),
    );
    if (!SHA256.test(receiptHmacSha256)) throw new MigrationCentreError('control_unavailable');
    return Object.freeze({
      disposition: fence.disposition,
      receipt: Object.freeze({ ...unsigned, receiptSha256, receiptHmacSha256 }),
      rateLimit,
    });
  }
}
