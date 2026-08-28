import { createHash } from 'node:crypto';
import type {
  ProviderOperationContext,
  ProviderOperationResult,
} from '../providers/contracts.js';

export const AYRSHARE_PUBLIC_SOCIAL_PROVIDER_ID = 'ayrshare' as const;
export const PUBLIC_SOCIAL_OUTBOUND_CONTRACT_VERSION = 'r72-public-social-v1' as const;

/**
 * The first live-capable seam is intentionally narrow: X posts containing up
 * to 280 printable ASCII characters, no links, and at most one immutable
 * company-owned JPEG/PNG. This avoids pretending that weighted Unicode/link,
 * thread, video or other-network rules have been proved. Those stay blocked
 * until their distinct payload and reconciliation rules have own contracts.
 */
export type PublicSocialReadyNetwork = 'x';
export type PublicSocialReadyMimeType = 'image/jpeg' | 'image/png';

export interface PublicSocialOutboundContext extends ProviderOperationContext {
  readonly providerId: typeof AYRSHARE_PUBLIC_SOCIAL_PROVIDER_ID;
}

export interface PublicSocialXOptions {
  readonly kind: 'x_standard_post';
  readonly mediaMode: 'none' | 'single_image';
  readonly shortenLinks: false;
}

export interface PublicSocialFreshnessEvidence {
  readonly proofId: string;
  readonly sourceAttestationId: string;
  readonly evidenceSha256: string;
  readonly validUntil: string;
}

export interface PublicSocialOutboundMediaEvidence {
  readonly artifactId: string;
  readonly contentVersionId: string;
  readonly contentSha256: string;
  readonly blobStorageKey: string;
  readonly blobSha256: string;
  readonly mimeType: PublicSocialReadyMimeType;
  /** The source/material evidence must remain valid through provider fetch time. */
  readonly validUntil: string;
}

export interface PublicSocialResolvedMediaEvidence extends PublicSocialOutboundMediaEvidence {
  readonly downloadUrl: string;
  /** Signed URL expiry, independently fenced through provider fetch time. */
  readonly downloadUrlValidUntil: string;
}

export type PublicSocialScriptedMediaStep =
  | Readonly<{
    readonly kind: 'resolved';
    readonly media: readonly PublicSocialResolvedMediaEvidence[];
  }>
  | Readonly<{
    readonly kind: 'resolution_error';
    readonly code: 'evidence_expired' | 'not_found' | 'storage_unavailable';
  }>;

/** Opaque, module-branded media evidence script with no executable callback. */
export interface PublicSocialContractMediaResolver {
  readonly kind: 'contract_media_mock';
}

export interface PublicSocialContractMediaResolutionRequest {
  readonly context: PublicSocialOutboundContext;
  readonly media: readonly PublicSocialOutboundMediaEvidence[];
}

/**
 * Worker-only, production-shaped dispatch material. Portal DTOs must never
 * manufacture this object: a workspace-qualified command repository resolves
 * the credential/profile binding and immutable evidence immediately before a
 * durable calling-state transition.
 */
export interface PublicSocialOutboundDispatchRequest {
  readonly targetId: string;
  readonly profileId: string;
  readonly network: PublicSocialReadyNetwork;
  readonly networkOptions: PublicSocialXOptions;
  readonly operationTag: string;
  /** Deterministic provider note binding the operation tag to planSha256. */
  readonly providerNotes: string;
  readonly approvalDecisionId: string;
  readonly contentVersionId: string;
  readonly contentSha256: string;
  readonly text: string;
  readonly bodySha256: string;
  readonly planSha256: string;
  readonly scheduledFor: string | null;
  readonly freshness: PublicSocialFreshnessEvidence;
  readonly media: readonly PublicSocialOutboundMediaEvidence[];
}

export interface PublicSocialReconciliationExpectation {
  readonly profileId: string;
  readonly externalId: string;
  readonly network: PublicSocialReadyNetwork;
  readonly text: string;
  readonly bodySha256: string;
  readonly planSha256: string;
  readonly operationTag: string;
  readonly providerNotes: string;
  readonly scheduledFor: string | null;
}

export interface PublicSocialOutboundResult extends ProviderOperationResult {
  /** True means the caller must retain its durable calling fence. */
  readonly reconciliationRequired: boolean;
  readonly recovery: Readonly<{
    readonly kind: 'none' | 'exact_post' | 'history_lookup';
    readonly providerIdempotencyKeySha256: string;
  }>;
}

export interface PublicSocialOutboundTransport {
  readonly providerId: typeof AYRSHARE_PUBLIC_SOCIAL_PROVIDER_ID;
  readonly executionMode: 'disabled' | 'contract_test';
  publish(
    context: PublicSocialOutboundContext,
    request: PublicSocialOutboundDispatchRequest,
  ): Promise<PublicSocialOutboundResult>;
  reconcile(
    context: PublicSocialOutboundContext,
    expectation: PublicSocialReconciliationExpectation,
  ): Promise<PublicSocialOutboundResult>;
  recoverUnknown(
    context: PublicSocialOutboundContext,
    request: PublicSocialOutboundDispatchRequest,
  ): Promise<PublicSocialOutboundResult>;
}

/**
 * Ayrshare documents that two simultaneous calls can both publish even with
 * one idempotency key. Any future composition must therefore enter a durable,
 * workspace-qualified single-caller `calling` lease before invoking publish;
 * this adapter is intentionally not wired until that persistence fence exists.
 */
export const PUBLIC_SOCIAL_DURABLE_CALLING_FENCE_REQUIRED = true as const;

export interface PublicSocialHttpRequest {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly bodyUtf8: string | null;
  readonly timeoutMs: number;
  readonly redirectPolicy: 'error';
  readonly maximumResponseBytes: 65_536;
}

export interface PublicSocialHttpResponse {
  readonly status: number;
  readonly bodyUtf8: string;
}

export type PublicSocialScriptedHttpStep =
  | Readonly<{
    readonly kind: 'response';
    readonly status: number;
    readonly bodyUtf8: string;
  }>
  | Readonly<{
    readonly kind: 'transport_error';
    readonly code: 'aborted' | 'connection_reset' | 'timeout';
  }>;

/** An opaque, module-branded, pure scripted transport. It has no callback. */
export interface PublicSocialContractHttpTransport {
  readonly kind: 'contract_mock';
}

interface ScriptedTransportState {
  readonly remaining: PublicSocialScriptedHttpStep[];
  readonly requests: PublicSocialHttpRequest[];
}

const SCRIPTED_TRANSPORTS = new WeakMap<object, ScriptedTransportState>();

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Object.values(descriptors).every((descriptor) => !descriptor.get && !descriptor.set);
}

function snapshotScriptStep(input: unknown, index: number): PublicSocialScriptedHttpStep {
  if (!plainRecord(input)) {
    throw new PublicSocialOutboundContractError(`script step ${index} is invalid`);
  }
  if (input.kind === 'transport_error') {
    if (input.code !== 'aborted' && input.code !== 'connection_reset' && input.code !== 'timeout') {
      throw new PublicSocialOutboundContractError(`script step ${index} is invalid`);
    }
    return Object.freeze({ kind: 'transport_error', code: input.code });
  }
  if (input.kind !== 'response' || !Number.isSafeInteger(input.status)
      || (input.status as number) < 100 || (input.status as number) > 599
      || typeof input.bodyUtf8 !== 'string'
      || Buffer.byteLength(input.bodyUtf8, 'utf8') > 65_536) {
    throw new PublicSocialOutboundContractError(`script step ${index} is invalid`);
  }
  return Object.freeze({
    kind: 'response',
    status: input.status as number,
    bodyUtf8: input.bodyUtf8,
  });
}

/**
 * Contract-test construction is deliberately not dependency injection. The
 * returned object has no executable member and is accepted only while present
 * in this module's private WeakMap, so a forged `kind` object cannot perform IO.
 */
export function createPublicSocialScriptedHttpTransport(
  script: readonly PublicSocialScriptedHttpStep[],
): PublicSocialContractHttpTransport {
  if (!Array.isArray(script)) {
    throw new PublicSocialOutboundContractError('contract HTTP script is invalid');
  }
  const remaining = script.map((step, index) => snapshotScriptStep(step, index));
  const transport = Object.freeze({ kind: 'contract_mock' as const });
  SCRIPTED_TRANSPORTS.set(transport, { remaining, requests: [] });
  return transport;
}

function snapshotHttpRequest(input: PublicSocialHttpRequest): PublicSocialHttpRequest {
  return Object.freeze({
    method: input.method,
    url: input.url,
    headers: Object.freeze({ ...input.headers }),
    bodyUtf8: input.bodyUtf8,
    timeoutMs: input.timeoutMs,
    redirectPolicy: input.redirectPolicy,
    maximumResponseBytes: input.maximumResponseBytes,
  });
}

/** Internal adapter seam; it can only consume a branded pure script. */
export async function executePublicSocialContractHttpRequest(
  transport: PublicSocialContractHttpTransport,
  request: PublicSocialHttpRequest,
): Promise<PublicSocialHttpResponse> {
  const state = SCRIPTED_TRANSPORTS.get(transport as object);
  if (!state) throw new PublicSocialOutboundContractError('contract HTTP transport is not authentic');
  state.requests.push(snapshotHttpRequest(request));
  const step = state.remaining.shift();
  if (!step) throw new PublicSocialContractTransportError('script_exhausted');
  if (step.kind === 'transport_error') throw new PublicSocialContractTransportError(step.code);
  return Object.freeze({ status: step.status, bodyUtf8: step.bodyUtf8 });
}

export function readPublicSocialContractHttpRequests(
  transport: PublicSocialContractHttpTransport,
): readonly PublicSocialHttpRequest[] {
  const state = SCRIPTED_TRANSPORTS.get(transport as object);
  if (!state) throw new PublicSocialOutboundContractError('contract HTTP transport is not authentic');
  return Object.freeze(state.requests.map(snapshotHttpRequest));
}

export function isAuthenticPublicSocialContractHttpTransport(
  transport: unknown,
): transport is PublicSocialContractHttpTransport {
  return typeof transport === 'object' && transport !== null
    && SCRIPTED_TRANSPORTS.has(transport as object);
}

interface ScriptedMediaState {
  readonly remaining: PublicSocialScriptedMediaStep[];
  readonly requests: PublicSocialContractMediaResolutionRequest[];
}

const SCRIPTED_MEDIA_RESOLVERS = new WeakMap<object, ScriptedMediaState>();

function exactDataKeys(source: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(source).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new PublicSocialOutboundContractError(`${label} has unexpected fields`);
  }
}

function snapshotScriptedResolvedMedia(value: unknown, index: number): PublicSocialResolvedMediaEvidence {
  if (!plainRecord(value)) {
    throw new PublicSocialOutboundContractError(`media script item ${index} is invalid`);
  }
  exactDataKeys(value, [
    'artifactId', 'contentVersionId', 'contentSha256', 'blobStorageKey', 'blobSha256',
    'mimeType', 'validUntil', 'downloadUrl', 'downloadUrlValidUntil',
  ], `media script item ${index}`);
  for (const key of Object.keys(value)) {
    if (typeof value[key] !== 'string') {
      throw new PublicSocialOutboundContractError(`media script item ${index} is invalid`);
    }
  }
  return Object.freeze({
    artifactId: value.artifactId as string,
    contentVersionId: value.contentVersionId as string,
    contentSha256: value.contentSha256 as string,
    blobStorageKey: value.blobStorageKey as string,
    blobSha256: value.blobSha256 as string,
    mimeType: value.mimeType as PublicSocialReadyMimeType,
    validUntil: value.validUntil as string,
    downloadUrl: value.downloadUrl as string,
    downloadUrlValidUntil: value.downloadUrlValidUntil as string,
  });
}

function snapshotMediaScriptStep(input: unknown, index: number): PublicSocialScriptedMediaStep {
  if (!plainRecord(input)) {
    throw new PublicSocialOutboundContractError(`media script step ${index} is invalid`);
  }
  if (input.kind === 'resolution_error') {
    exactDataKeys(input, ['kind', 'code'], `media script step ${index}`);
    if (input.code !== 'evidence_expired' && input.code !== 'not_found'
        && input.code !== 'storage_unavailable') {
      throw new PublicSocialOutboundContractError(`media script step ${index} is invalid`);
    }
    return Object.freeze({ kind: 'resolution_error', code: input.code });
  }
  exactDataKeys(input, ['kind', 'media'], `media script step ${index}`);
  if (input.kind !== 'resolved' || !Array.isArray(input.media)) {
    throw new PublicSocialOutboundContractError(`media script step ${index} is invalid`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(input.media);
  const numericKeys = Object.keys(descriptors).filter((key) => key !== 'length');
  if (numericKeys.some((key) => !/^\d+$/u.test(key))
      || numericKeys.length !== input.media.length
      || Object.values(descriptors).some((descriptor) => descriptor.get || descriptor.set)) {
    throw new PublicSocialOutboundContractError(`media script step ${index} is invalid`);
  }
  return Object.freeze({
    kind: 'resolved',
    media: Object.freeze(input.media.map(snapshotScriptedResolvedMedia)),
  });
}

export function createPublicSocialScriptedMediaResolver(
  script: readonly PublicSocialScriptedMediaStep[],
): PublicSocialContractMediaResolver {
  if (!Array.isArray(script)) {
    throw new PublicSocialOutboundContractError('contract media script is invalid');
  }
  const remaining = script.map((step, index) => snapshotMediaScriptStep(step, index));
  const resolver = Object.freeze({ kind: 'contract_media_mock' as const });
  SCRIPTED_MEDIA_RESOLVERS.set(resolver, { remaining, requests: [] });
  return resolver;
}

function snapshotResolutionRequest(
  context: PublicSocialOutboundContext,
  media: readonly PublicSocialOutboundMediaEvidence[],
): PublicSocialContractMediaResolutionRequest {
  return Object.freeze({
    context: Object.freeze({ ...context }),
    media: Object.freeze(media.map((item) => Object.freeze({ ...item }))),
  });
}

export async function executePublicSocialContractMediaResolution(
  resolver: PublicSocialContractMediaResolver,
  context: PublicSocialOutboundContext,
  media: readonly PublicSocialOutboundMediaEvidence[],
): Promise<readonly PublicSocialResolvedMediaEvidence[]> {
  const state = SCRIPTED_MEDIA_RESOLVERS.get(resolver as object);
  if (!state) throw new PublicSocialOutboundContractError('contract media resolver is not authentic');
  state.requests.push(snapshotResolutionRequest(context, media));
  const step = state.remaining.shift();
  if (!step) throw new PublicSocialContractMediaResolverError('script_exhausted');
  if (step.kind === 'resolution_error') throw new PublicSocialContractMediaResolverError(step.code);
  return step.media;
}

export function readPublicSocialContractMediaResolutionRequests(
  resolver: PublicSocialContractMediaResolver,
): readonly PublicSocialContractMediaResolutionRequest[] {
  const state = SCRIPTED_MEDIA_RESOLVERS.get(resolver as object);
  if (!state) throw new PublicSocialOutboundContractError('contract media resolver is not authentic');
  return Object.freeze(state.requests.map((request) =>
    snapshotResolutionRequest(request.context, request.media)));
}

export function isAuthenticPublicSocialContractMediaResolver(
  resolver: unknown,
): resolver is PublicSocialContractMediaResolver {
  return typeof resolver === 'object' && resolver !== null
    && SCRIPTED_MEDIA_RESOLVERS.has(resolver as object);
}

/**
 * Requirements for the separately approved live network transport. There is
 * deliberately no constructor or executable live client in this strike.
 */
export const AYRSHARE_LIVE_TRANSPORT_SECURITY_CONTRACT = Object.freeze({
  origin: 'https://api.ayrshare.com',
  redirectPolicy: 'error',
  responseMode: 'bounded_stream',
  maximumResponseBytes: 65_536,
  minimumTimeoutMs: 1_000,
  maximumTimeoutMs: 30_000,
  abortSignalRequired: true,
  credentials: 'secret_manager_headers_only',
  xByoOAuth1Headers: Object.freeze([
    'X-Twitter-OAuth1-Api-Key',
    'X-Twitter-OAuth1-Api-Secret',
  ]),
  xByoLinkedAccountEvidenceRequired: true,
} as const);

export interface CreateAyrshareCredentialBundleInput {
  readonly workspaceId: string;
  readonly connectionId: string;
  readonly profileId: string;
  readonly credentialVersion: string;
  readonly apiKey: string;
  readonly profileKey: string;
  /** X OAuth 1.0a Consumer Key required by Ayrshare after 2026-03-31. */
  readonly xOAuth1ApiKey: string;
  /** X OAuth 1.0a Consumer Secret required by Ayrshare after 2026-03-31. */
  readonly xOAuth1ApiSecret: string;
  /** Hash of the workspace-qualified completed Ayrshare/X OAuth link evidence. */
  readonly xOAuthLinkEvidenceSha256: string;
  readonly xOAuthLinkedAt: string;
  /** Trusted repository/database observation time used to reject future link evidence. */
  readonly xOAuthEvidenceObservedAt: string;
  readonly xOAuthPermissions: 'read_write';
}

export interface AyrshareCredentialBundle {
  readonly kind: 'ayrshare_credentials';
  readonly workspaceId: string;
  readonly connectionId: string;
  readonly profileId: string;
  readonly credentialVersion: string;
  readonly bindingSha256: string;
  readonly xOAuthLinkEvidenceSha256: string;
  readonly xOAuthLinkedAt: string;
  readonly xOAuthEvidenceObservedAt: string;
  readonly xOAuthPermissions: 'read_write';
}

interface AyrshareCredentialSecrets {
  readonly apiKey: string;
  readonly profileKey: string;
  readonly xOAuth1ApiKey: string;
  readonly xOAuth1ApiSecret: string;
}

const CREDENTIAL_BUNDLES = new WeakMap<object, AyrshareCredentialSecrets>();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SECRET = /^[\x21-\x7e]{8,500}$/u;
const VERSION = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

function canonicalHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function credentialUuid(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new PublicSocialOutboundContractError(`${label} is invalid`);
  const normalized = value.trim().toLowerCase();
  if (!UUID.test(normalized)) throw new PublicSocialOutboundContractError(`${label} is invalid`);
  return normalized;
}

/** Creates one atomically branded workspace/connection/profile credential tuple. */
export function createAyrshareCredentialBundle(
  input: CreateAyrshareCredentialBundleInput,
): AyrshareCredentialBundle {
  if (!plainRecord(input)) throw new PublicSocialOutboundContractError('credential bundle is invalid');
  const expectedKeys = [
    'workspaceId', 'connectionId', 'profileId', 'credentialVersion', 'apiKey', 'profileKey',
    'xOAuth1ApiKey', 'xOAuth1ApiSecret', 'xOAuthLinkEvidenceSha256', 'xOAuthLinkedAt',
    'xOAuthEvidenceObservedAt', 'xOAuthPermissions',
  ].sort();
  const actualKeys = Object.keys(input).sort();
  if (actualKeys.length !== expectedKeys.length
      || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new PublicSocialOutboundContractError('credential bundle has unexpected fields');
  }
  const workspaceId = credentialUuid(input.workspaceId, 'credentials.workspaceId');
  const connectionId = credentialUuid(input.connectionId, 'credentials.connectionId');
  const profileId = credentialUuid(input.profileId, 'credentials.profileId');
  if (typeof input.credentialVersion !== 'string' || !VERSION.test(input.credentialVersion)) {
    throw new PublicSocialOutboundContractError('credentials.credentialVersion is invalid');
  }
  if (typeof input.apiKey !== 'string' || !SECRET.test(input.apiKey)
      || typeof input.profileKey !== 'string' || !SECRET.test(input.profileKey)
      || typeof input.xOAuth1ApiKey !== 'string' || !SECRET.test(input.xOAuth1ApiKey)
      || typeof input.xOAuth1ApiSecret !== 'string' || !SECRET.test(input.xOAuth1ApiSecret)) {
    throw new PublicSocialOutboundContractError('credential secret is invalid');
  }
  if (!SHA256.test(input.xOAuthLinkEvidenceSha256)
      || input.xOAuthPermissions !== 'read_write') {
    throw new PublicSocialOutboundContractError('X OAuth link evidence is invalid');
  }
  const xOAuthLinkedAt = new Date(input.xOAuthLinkedAt);
  if (!Number.isFinite(Date.prototype.getTime.call(xOAuthLinkedAt))
      || Date.prototype.toISOString.call(xOAuthLinkedAt) !== input.xOAuthLinkedAt) {
    throw new PublicSocialOutboundContractError('X OAuth linked timestamp is invalid');
  }
  const xOAuthEvidenceObservedAt = new Date(input.xOAuthEvidenceObservedAt);
  if (!Number.isFinite(Date.prototype.getTime.call(xOAuthEvidenceObservedAt))
      || Date.prototype.toISOString.call(xOAuthEvidenceObservedAt) !== input.xOAuthEvidenceObservedAt
      || Date.prototype.getTime.call(xOAuthLinkedAt)
        > Date.prototype.getTime.call(xOAuthEvidenceObservedAt) + 5 * 60 * 1_000) {
    throw new PublicSocialOutboundContractError('X OAuth evidence observation is invalid');
  }
  const credentialVersion = input.credentialVersion;
  const xOAuthLinkEvidenceSha256 = input.xOAuthLinkEvidenceSha256;
  const xOAuthLinkedAtIso = input.xOAuthLinkedAt;
  const xOAuthEvidenceObservedAtIso = input.xOAuthEvidenceObservedAt;
  const xOAuthPermissions = input.xOAuthPermissions;
  const bindingSha256 = canonicalHash({
    contract: PUBLIC_SOCIAL_OUTBOUND_CONTRACT_VERSION,
    workspaceId,
    connectionId,
    profileId,
    credentialVersion,
    apiKeySha256: canonicalHash(input.apiKey),
    profileKeySha256: canonicalHash(input.profileKey),
    xOAuth1ApiKeySha256: canonicalHash(input.xOAuth1ApiKey),
    xOAuth1ApiSecretSha256: canonicalHash(input.xOAuth1ApiSecret),
    xOAuthLinkEvidenceSha256,
    xOAuthLinkedAt: xOAuthLinkedAtIso,
    xOAuthEvidenceObservedAt: xOAuthEvidenceObservedAtIso,
    xOAuthPermissions,
  });
  const bundle = Object.freeze({
    kind: 'ayrshare_credentials' as const,
    workspaceId,
    connectionId,
    profileId,
    credentialVersion,
    bindingSha256,
    xOAuthLinkEvidenceSha256,
    xOAuthLinkedAt: xOAuthLinkedAtIso,
    xOAuthEvidenceObservedAt: xOAuthEvidenceObservedAtIso,
    xOAuthPermissions,
    toJSON: () => Object.freeze({
      kind: 'ayrshare_credentials', workspaceId, connectionId, profileId,
      credentialVersion, bindingSha256,
      xOAuthLinkEvidenceSha256,
      xOAuthLinkedAt: xOAuthLinkedAtIso,
      xOAuthEvidenceObservedAt: xOAuthEvidenceObservedAtIso,
      xOAuthPermissions,
      secrets: '[REDACTED]',
    }),
  });
  CREDENTIAL_BUNDLES.set(bundle, Object.freeze({
    apiKey: input.apiKey,
    profileKey: input.profileKey,
    xOAuth1ApiKey: input.xOAuth1ApiKey,
    xOAuth1ApiSecret: input.xOAuth1ApiSecret,
  }));
  return bundle;
}

/** Internal adapter read; forged or structurally copied bundles fail closed. */
export function readAyrshareCredentialBundle(bundle: AyrshareCredentialBundle): Readonly<{
  readonly binding: AyrshareCredentialBundle;
  readonly apiKey: string;
  readonly profileKey: string;
  readonly xOAuth1ApiKey: string;
  readonly xOAuth1ApiSecret: string;
}> {
  const secrets = CREDENTIAL_BUNDLES.get(bundle as object);
  if (!secrets) throw new PublicSocialOutboundContractError('Ayrshare credential bundle is not authentic');
  return Object.freeze({
    binding: bundle,
    apiKey: secrets.apiKey,
    profileKey: secrets.profileKey,
    xOAuth1ApiKey: secrets.xOAuth1ApiKey,
    xOAuth1ApiSecret: secrets.xOAuth1ApiSecret,
  });
}

export class PublicSocialOutboundContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublicSocialOutboundContractError';
  }
}

export class PublicSocialContractTransportError extends PublicSocialOutboundContractError {
  constructor(readonly code: string) {
    super('Ayrshare contract transport did not produce a response');
    this.name = 'PublicSocialContractTransportError';
  }
}

export class PublicSocialContractMediaResolverError extends PublicSocialOutboundContractError {
  constructor(readonly code: string) {
    super('Company media evidence could not be resolved');
    this.name = 'PublicSocialContractMediaResolverError';
  }
}

export class PublicSocialOutboundDisabledError extends PublicSocialOutboundContractError {
  constructor() {
    super('Public-social provider effects are disabled');
    this.name = 'PublicSocialOutboundDisabledError';
  }
}
