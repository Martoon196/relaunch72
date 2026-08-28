import { createHash } from 'node:crypto';
import {
  AYRSHARE_PUBLIC_SOCIAL_PROVIDER_ID,
  PUBLIC_SOCIAL_OUTBOUND_CONTRACT_VERSION,
  PublicSocialOutboundContractError,
  PublicSocialOutboundDisabledError,
  executePublicSocialContractMediaResolution,
  executePublicSocialContractHttpRequest,
  isAuthenticPublicSocialContractMediaResolver,
  isAuthenticPublicSocialContractHttpTransport,
  readAyrshareCredentialBundle,
  type AyrshareCredentialBundle,
  type PublicSocialContractMediaResolver,
  type PublicSocialContractHttpTransport,
  type PublicSocialFreshnessEvidence,
  type PublicSocialHttpRequest,
  type PublicSocialHttpResponse,
  type PublicSocialOutboundContext,
  type PublicSocialOutboundDispatchRequest,
  type PublicSocialOutboundMediaEvidence,
  type PublicSocialOutboundResult,
  type PublicSocialOutboundTransport,
  type PublicSocialReadyMimeType,
  type PublicSocialReconciliationExpectation,
  type PublicSocialResolvedMediaEvidence,
  type PublicSocialXOptions,
} from './contracts.js';

const AYRSHARE_API_ORIGIN = 'https://api.ayrshare.com';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_EXTERNAL_ID = /^[a-zA-Z0-9_-]{1,200}$/u;
const SAFE_IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,500}$/u;
const SAFE_OPERATION_TAG = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/u;
const SAFE_TEXT = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/u;
const PROVEN_X_V1_TEXT = /^[\r\n\x20-\x7e]+$/u;
const LINK_LIKE_X_V1_TEXT = /(?:\/\/|\b[a-z][a-z0-9+.-]*:|\bwww\.|\b(?:\d{1,3}\.){3}\d{1,3}\b|\b[a-z0-9](?:[a-z0-9-]{0,62})\.(?:[a-z]{2,63})(?:\.[a-z]{2,63})?(?:[/?#][^\s]*)?)/iu;
const SAFE_BLOB_KEY = /^[a-zA-Z0-9][a-zA-Z0-9/_.-]{0,511}$/u;
const READY_NETWORKS = new Set<unknown>(['x']);
const READY_MIME_TYPES = new Set<unknown>(['image/jpeg', 'image/png']);
const MAX_RESPONSE_BYTES = 65_536;
const MAX_POST_BYTES = 16_384;
const MAX_X_CODE_POINTS = 280;
const MEDIA_FETCH_GRACE_MS = 15 * 60 * 1_000;
const MAX_SCHEDULE_HORIZON_MS = 366 * 24 * 60 * 60 * 1_000;

type SnapshotDispatch = Readonly<{
  targetId: string;
  profileId: string;
  network: 'x';
  networkOptions: PublicSocialXOptions;
  operationTag: string;
  providerNotes: string;
  approvalDecisionId: string;
  contentVersionId: string;
  contentSha256: string;
  text: string;
  bodySha256: string;
  planSha256: string;
  scheduledFor: string | null;
  freshness: PublicSocialFreshnessEvidence;
  media: readonly PublicSocialOutboundMediaEvidence[];
}>;

interface EnabledAdapter {
  readonly credentials: ReturnType<typeof readAyrshareCredentialBundle>;
  readonly http: PublicSocialContractHttpTransport;
  readonly mediaResolver: PublicSocialContractMediaResolver;
}

export interface AyrshareHttpAdapterOptions {
  /** Defaults to disabled. There is deliberately no live execution mode. */
  readonly executionMode?: 'disabled' | 'contract_test';
  readonly credentials?: AyrshareCredentialBundle;
  readonly http?: PublicSocialContractHttpTransport;
  readonly mediaResolver?: PublicSocialContractMediaResolver;
  readonly timeoutMs?: number;
  /** Fixed contract-test observation time; no executable clock is injected. */
  readonly observedAt?: string;
}

function fail(message: string): never {
  throw new PublicSocialOutboundContractError(message);
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${label} is invalid`);
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) fail(`${label} is invalid`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some((descriptor) => descriptor.get || descriptor.set)) {
    fail(`${label} is invalid`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(source: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(source).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} has unexpected fields`);
  }
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== 'string') fail(`${label} is invalid`);
  const normalized = value.trim().toLowerCase();
  if (!UUID.test(normalized)) fail(`${label} is invalid`);
  return normalized;
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) fail(`${label} is invalid`);
  return value;
}

function canonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string') fail(`${label} is invalid`);
  const parsed = new Date(value);
  if (!Number.isFinite(Date.prototype.getTime.call(parsed))
      || Date.prototype.toISOString.call(parsed) !== value) {
    fail(`${label} must be a canonical UTC timestamp`);
  }
  return value;
}

function sha256Utf8(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function activationReadyXText(value: unknown): value is string {
  return typeof value === 'string'
    && SAFE_TEXT.test(value)
    && PROVEN_X_V1_TEXT.test(value)
    && !LINK_LIKE_X_V1_TEXT.test(value)
    && Buffer.byteLength(value, 'utf8') >= 1
    && Buffer.byteLength(value, 'utf8') <= MAX_POST_BYTES
    && Array.from(value).length <= MAX_X_CODE_POINTS;
}

function canonicalHash(value: unknown): string {
  return sha256Utf8(JSON.stringify(value));
}

function snapshotContext(input: PublicSocialOutboundContext): PublicSocialOutboundContext {
  const source = plainRecord(input, 'provider context');
  exactKeys(source, [
    'workspaceId', 'connectionId', 'providerId', 'operationId', 'idempotencyKey', 'correlationId',
  ], 'provider context');
  const providerId = source.providerId;
  if (providerId !== AYRSHARE_PUBLIC_SOCIAL_PROVIDER_ID) fail('provider context is not Ayrshare-bound');
  if (typeof source.idempotencyKey !== 'string' || !SAFE_IDEMPOTENCY_KEY.test(source.idempotencyKey)) {
    fail('context.idempotencyKey is invalid');
  }
  return Object.freeze({
    workspaceId: uuid(source.workspaceId, 'context.workspaceId'),
    connectionId: uuid(source.connectionId, 'context.connectionId'),
    providerId,
    operationId: uuid(source.operationId, 'context.operationId'),
    idempotencyKey: source.idempotencyKey,
    correlationId: uuid(source.correlationId, 'context.correlationId'),
  });
}

function snapshotOptions(value: unknown): PublicSocialXOptions {
  const source = plainRecord(value, 'request.networkOptions');
  exactKeys(source, ['kind', 'mediaMode', 'shortenLinks'], 'request.networkOptions');
  if (source.kind !== 'x_standard_post'
      || (source.mediaMode !== 'none' && source.mediaMode !== 'single_image')
      || source.shortenLinks !== false) {
    fail('request.networkOptions is not supported');
  }
  return Object.freeze({
    kind: 'x_standard_post', mediaMode: source.mediaMode, shortenLinks: false,
  });
}

function snapshotFreshness(value: unknown): PublicSocialFreshnessEvidence {
  const source = plainRecord(value, 'request.freshness');
  exactKeys(source, ['proofId', 'sourceAttestationId', 'evidenceSha256', 'validUntil'], 'request.freshness');
  return Object.freeze({
    proofId: uuid(source.proofId, 'request.freshness.proofId'),
    sourceAttestationId: uuid(
      source.sourceAttestationId, 'request.freshness.sourceAttestationId',
    ),
    evidenceSha256: sha256(source.evidenceSha256, 'request.freshness.evidenceSha256'),
    validUntil: canonicalTimestamp(source.validUntil, 'request.freshness.validUntil'),
  });
}

function snapshotMediaItem(value: unknown, index: number): PublicSocialOutboundMediaEvidence {
  const label = `request.media[${index}]`;
  const source = plainRecord(value, label);
  exactKeys(source, [
    'artifactId', 'contentVersionId', 'contentSha256', 'blobStorageKey', 'blobSha256',
    'mimeType', 'validUntil',
  ], label);
  if (typeof source.blobStorageKey !== 'string' || !SAFE_BLOB_KEY.test(source.blobStorageKey)
      || source.blobStorageKey.includes('..')) {
    fail(`${label}.blobStorageKey is invalid`);
  }
  if (!READY_MIME_TYPES.has(source.mimeType)) fail(`${label}.mimeType is not supported`);
  return Object.freeze({
    artifactId: uuid(source.artifactId, `${label}.artifactId`),
    contentVersionId: uuid(source.contentVersionId, `${label}.contentVersionId`),
    contentSha256: sha256(source.contentSha256, `${label}.contentSha256`),
    blobStorageKey: source.blobStorageKey,
    blobSha256: sha256(source.blobSha256, `${label}.blobSha256`),
    mimeType: source.mimeType as PublicSocialReadyMimeType,
    validUntil: canonicalTimestamp(source.validUntil, `${label}.validUntil`),
  });
}

function snapshotMedia(value: unknown): readonly PublicSocialOutboundMediaEvidence[] {
  if (!Array.isArray(value) || value.length > 1) fail('request.media is invalid');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const numericKeys = Object.keys(descriptors).filter((key) => key !== 'length');
  if (numericKeys.some((key) => !/^\d+$/u.test(key))
      || numericKeys.length !== value.length
      || Object.values(descriptors).some((descriptor) => descriptor.get || descriptor.set)) {
    fail('request.media is invalid');
  }
  const media = value.map((item, index) => snapshotMediaItem(item, index));
  return Object.freeze(media);
}

function canonicalPlanEvidence(request: Omit<SnapshotDispatch, 'planSha256' | 'providerNotes'>): unknown {
  return {
    contract: PUBLIC_SOCIAL_OUTBOUND_CONTRACT_VERSION,
    targetId: request.targetId,
    profileId: request.profileId,
    network: request.network,
    networkOptions: {
      kind: request.networkOptions.kind,
      mediaMode: request.networkOptions.mediaMode,
      shortenLinks: request.networkOptions.shortenLinks,
    },
    operationTag: request.operationTag,
    approvalDecisionId: request.approvalDecisionId,
    contentVersionId: request.contentVersionId,
    contentSha256: request.contentSha256,
    text: request.text,
    bodySha256: request.bodySha256,
    scheduledFor: request.scheduledFor,
    freshness: {
      proofId: request.freshness.proofId,
      sourceAttestationId: request.freshness.sourceAttestationId,
      evidenceSha256: request.freshness.evidenceSha256,
      validUntil: request.freshness.validUntil,
    },
    media: request.media.map((item) => ({
      artifactId: item.artifactId,
      contentVersionId: item.contentVersionId,
      contentSha256: item.contentSha256,
      blobStorageKey: item.blobStorageKey,
      blobSha256: item.blobSha256,
      mimeType: item.mimeType,
      validUntil: item.validUntil,
    })),
  };
}

/** Deterministic helper for the trusted command/repository boundary. */
export function createPublicSocialOutboundPlanSha256(
  request: Omit<PublicSocialOutboundDispatchRequest, 'planSha256' | 'providerNotes'>,
): string {
  return canonicalHash(canonicalPlanEvidence(request as Omit<SnapshotDispatch, 'planSha256' | 'providerNotes'>));
}

export function createPublicSocialProviderNotes(operationTag: string, planSha256: string): string {
  if (!SAFE_OPERATION_TAG.test(operationTag) || !SHA256.test(planSha256)) {
    fail('provider note evidence is invalid');
  }
  return `${PUBLIC_SOCIAL_OUTBOUND_CONTRACT_VERSION}:${operationTag}:${planSha256}`;
}

function snapshotDispatch(
  input: PublicSocialOutboundDispatchRequest,
  nowMs: number,
  enforceTimeFences: boolean,
): SnapshotDispatch {
  const source = plainRecord(input, 'social dispatch request');
  exactKeys(source, [
    'targetId', 'profileId', 'network', 'networkOptions', 'operationTag', 'providerNotes',
    'approvalDecisionId', 'contentVersionId', 'contentSha256', 'text', 'bodySha256',
    'planSha256', 'scheduledFor', 'freshness', 'media',
  ], 'social dispatch request');
  if (!READY_NETWORKS.has(source.network)) fail('request.network is not activation-ready');
  if (typeof source.operationTag !== 'string' || !SAFE_OPERATION_TAG.test(source.operationTag)) {
    fail('request.operationTag is invalid');
  }
  if (!activationReadyXText(source.text)) {
    fail('request.text exceeds the proven X text-post contract');
  }
  const scheduledFor = source.scheduledFor === null
    ? null
    : canonicalTimestamp(source.scheduledFor, 'request.scheduledFor');
  const networkOptions = snapshotOptions(source.networkOptions);
  const media = snapshotMedia(source.media);
  if ((networkOptions.mediaMode === 'none' && media.length !== 0)
      || (networkOptions.mediaMode === 'single_image' && media.length !== 1)) {
    fail('request.networkOptions.mediaMode does not bind the exact media set');
  }
  const freshness = snapshotFreshness(source.freshness);
  const snapshotWithoutPlan = Object.freeze({
    targetId: uuid(source.targetId, 'request.targetId'),
    profileId: uuid(source.profileId, 'request.profileId'),
    network: 'x' as const,
    networkOptions,
    operationTag: source.operationTag,
    approvalDecisionId: uuid(source.approvalDecisionId, 'request.approvalDecisionId'),
    contentVersionId: uuid(source.contentVersionId, 'request.contentVersionId'),
    contentSha256: sha256(source.contentSha256, 'request.contentSha256'),
    text: source.text,
    bodySha256: sha256(source.bodySha256, 'request.bodySha256'),
    scheduledFor,
    freshness,
    media,
  });
  if (sha256Utf8(snapshotWithoutPlan.text) !== snapshotWithoutPlan.bodySha256
      || snapshotWithoutPlan.contentSha256 !== snapshotWithoutPlan.bodySha256) {
    fail('request body/content hashes do not bind the exact post text');
  }
  const planSha256 = sha256(source.planSha256, 'request.planSha256');
  const calculatedPlanSha256 = canonicalHash(canonicalPlanEvidence(snapshotWithoutPlan));
  if (planSha256 !== calculatedPlanSha256) fail('request.planSha256 does not bind immutable dispatch evidence');
  const expectedNotes = createPublicSocialProviderNotes(snapshotWithoutPlan.operationTag, planSha256);
  if (source.providerNotes !== expectedNotes) fail('request.providerNotes does not bind the immutable plan');

  if (enforceTimeFences) {
    const effectAtMs = scheduledFor === null ? nowMs : Date.parse(scheduledFor);
    if (scheduledFor !== null && (effectAtMs <= nowMs || effectAtMs - nowMs > MAX_SCHEDULE_HORIZON_MS)) {
      fail('request.scheduledFor is outside the activation-ready window');
    }
    const requiredValidityMs = effectAtMs + MEDIA_FETCH_GRACE_MS;
    if (Date.parse(freshness.validUntil) < requiredValidityMs) {
      fail('request freshness proof expires before provider fetch fencing');
    }
    for (const [index, item] of media.entries()) {
      if (Date.parse(item.validUntil) < requiredValidityMs) {
        fail(`request.media[${index}] expires before provider fetch fencing`);
      }
    }
  }

  return Object.freeze({
    ...snapshotWithoutPlan,
    planSha256,
    providerNotes: expectedNotes,
  });
}

function snapshotExpectation(input: PublicSocialReconciliationExpectation): PublicSocialReconciliationExpectation {
  const source = plainRecord(input, 'reconciliation expectation');
  exactKeys(source, [
    'profileId', 'externalId', 'network', 'text', 'bodySha256', 'planSha256',
    'operationTag', 'providerNotes', 'scheduledFor',
  ], 'reconciliation expectation');
  if (!READY_NETWORKS.has(source.network)) fail('reconciliation network is not activation-ready');
  if (typeof source.externalId !== 'string' || !SAFE_EXTERNAL_ID.test(source.externalId)) {
    fail('reconciliation post identity is invalid');
  }
  if (!activationReadyXText(source.text)
      || sha256Utf8(source.text) !== source.bodySha256) {
    fail('reconciliation body evidence is invalid');
  }
  const planSha = sha256(source.planSha256, 'reconciliation.planSha256');
  if (typeof source.operationTag !== 'string' || !SAFE_OPERATION_TAG.test(source.operationTag)
      || source.providerNotes !== createPublicSocialProviderNotes(source.operationTag, planSha)) {
    fail('reconciliation provider notes are not plan-bound');
  }
  return Object.freeze({
    profileId: uuid(source.profileId, 'reconciliation.profileId'),
    externalId: source.externalId,
    network: 'x',
    text: source.text,
    bodySha256: source.bodySha256,
    planSha256: planSha,
    operationTag: source.operationTag,
    providerNotes: source.providerNotes,
    scheduledFor: source.scheduledFor === null
      ? null : canonicalTimestamp(source.scheduledFor, 'reconciliation.scheduledFor'),
  });
}

function providerIdempotencyKey(
  context: PublicSocialOutboundContext,
  profileId: string,
): string {
  const digest = canonicalHash({
    version: PUBLIC_SOCIAL_OUTBOUND_CONTRACT_VERSION,
    workspaceId: context.workspaceId,
    connectionId: context.connectionId,
    profileId,
    stableIdempotencyKey: context.idempotencyKey,
  });
  return `r72-v1-${digest}`;
}

function occurredAt(value: unknown): Readonly<{ iso: string; milliseconds: number }> {
  const iso = canonicalTimestamp(value, 'Ayrshare contract observation time');
  return Object.freeze({ iso, milliseconds: Date.parse(iso) });
}

function response(input: PublicSocialHttpResponse): PublicSocialHttpResponse {
  const source = plainRecord(input, 'Ayrshare contract response');
  exactKeys(source, ['status', 'bodyUtf8'], 'Ayrshare contract response');
  if (!Number.isSafeInteger(source.status) || (source.status as number) < 100
      || (source.status as number) > 599 || typeof source.bodyUtf8 !== 'string'
      || Buffer.byteLength(source.bodyUtf8, 'utf8') > MAX_RESPONSE_BYTES) {
    fail('Ayrshare contract response is invalid');
  }
  return Object.freeze({ status: source.status as number, bodyUtf8: source.bodyUtf8 });
}

function parseJsonBody(bodyUtf8: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyUtf8) as unknown;
  } catch {
    return null;
  }
  try {
    return plainRecord(parsed, 'provider JSON');
  } catch {
    return null;
  }
}

function safeExternalId(value: unknown): string | null {
  return typeof value === 'string' && SAFE_EXTERNAL_ID.test(value) ? value : null;
}

function providerKeySha(providerKey: string): string {
  return sha256Utf8(providerKey);
}

function result(input: Readonly<{
  status: PublicSocialOutboundResult['status'];
  externalId: string | null;
  occurredAt: string;
  retryable: boolean;
  errorCode: string | null;
  summary: string;
  reconciliationRequired: boolean;
  recoveryKind: PublicSocialOutboundResult['recovery']['kind'];
  providerKey: string;
}>): PublicSocialOutboundResult {
  return Object.freeze({
    status: input.status,
    externalId: input.externalId,
    occurredAt: input.occurredAt,
    retryable: input.retryable,
    errorCode: input.errorCode,
    summary: input.summary,
    reconciliationRequired: input.reconciliationRequired,
    recovery: Object.freeze({
      kind: input.recoveryKind,
      providerIdempotencyKeySha256: providerKeySha(input.providerKey),
    }),
  });
}

function exactPlatforms(value: unknown): boolean {
  return Array.isArray(value) && value.length === 1 && value[0] === 'twitter';
}

function exactImmediatePostIds(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== 1) return false;
  try {
    const item = plainRecord(value[0], 'Ayrshare post identity');
    return item.platform === 'twitter' && item.status === 'success'
      && safeExternalId(item.id) !== null;
  } catch {
    return false;
  }
}

function resolvedMedia(
  input: readonly PublicSocialResolvedMediaEvidence[],
  expected: readonly PublicSocialOutboundMediaEvidence[],
  requiredValidityMs: number,
): readonly PublicSocialResolvedMediaEvidence[] {
  if (!Array.isArray(input) || input.length !== expected.length) fail('media resolver returned unbound evidence');
  const resolved = input.map((value, index) => {
    const source = plainRecord(value, `resolved media[${index}]`);
    exactKeys(source, [
      'artifactId', 'contentVersionId', 'contentSha256', 'blobStorageKey', 'blobSha256',
      'mimeType', 'validUntil', 'downloadUrl', 'downloadUrlValidUntil',
    ], `resolved media[${index}]`);
    const snapshot = snapshotMediaItem({
      artifactId: source.artifactId,
      contentVersionId: source.contentVersionId,
      contentSha256: source.contentSha256,
      blobStorageKey: source.blobStorageKey,
      blobSha256: source.blobSha256,
      mimeType: source.mimeType,
      validUntil: source.validUntil,
    }, index);
    const wanted = expected[index];
    if (!wanted || JSON.stringify(snapshot) !== JSON.stringify(wanted)) {
      fail(`resolved media[${index}] does not bind immutable media evidence`);
    }
    if (typeof source.downloadUrl !== 'string' || source.downloadUrl.length > 2_048) {
      fail(`resolved media[${index}].downloadUrl is invalid`);
    }
    let parsed: URL;
    try {
      parsed = new URL(source.downloadUrl);
    } catch {
      fail(`resolved media[${index}].downloadUrl is invalid`);
    }
    if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password
        || parsed.hash || /\s/u.test(source.downloadUrl)) {
      fail(`resolved media[${index}].downloadUrl is invalid`);
    }
    const downloadUrlValidUntil = canonicalTimestamp(
      source.downloadUrlValidUntil, `resolved media[${index}].downloadUrlValidUntil`,
    );
    if (Date.parse(downloadUrlValidUntil) < requiredValidityMs) {
      fail(`resolved media[${index}] URL expires before provider fetch fencing`);
    }
    return Object.freeze({ ...snapshot, downloadUrl: parsed.toString(), downloadUrlValidUntil });
  });
  if (new Set(resolved.map((item) => item.downloadUrl)).size !== resolved.length) {
    fail('media resolver returned duplicate URLs');
  }
  return Object.freeze(resolved);
}

function httpRequest(
  method: 'GET' | 'POST',
  url: string,
  headers: Readonly<Record<string, string>>,
  bodyUtf8: string | null,
  timeoutMs: number,
): PublicSocialHttpRequest {
  return Object.freeze({
    method,
    url,
    headers: Object.freeze({ ...headers }),
    bodyUtf8,
    timeoutMs,
    redirectPolicy: 'error',
    maximumResponseBytes: MAX_RESPONSE_BYTES,
  });
}

function recordMatchesExpectation(
  payload: Record<string, unknown>,
  expectation: PublicSocialReconciliationExpectation,
): boolean {
  if (safeExternalId(payload.id) !== expectation.externalId
      || !exactPlatforms(payload.platforms)
      || payload.post !== expectation.text
      || sha256Utf8(expectation.text) !== expectation.bodySha256
      || payload.notes !== expectation.providerNotes) return false;
  if (expectation.scheduledFor === null) {
    return payload.scheduleDate === undefined || payload.scheduleDate === null;
  }
  return payload.scheduleDate === expectation.scheduledFor;
}

function dispatchMatchesHistory(
  payload: Record<string, unknown>,
  request: SnapshotDispatch,
): boolean {
  return safeExternalId(payload.id) !== null
    && exactPlatforms(payload.platforms)
    && payload.post === request.text
    && payload.notes === request.providerNotes
    && (request.scheduledFor === null
      ? payload.scheduleDate === undefined || payload.scheduleDate === null
      : payload.scheduleDate === request.scheduledFor);
}

export class AyrshareHttpAdapter implements PublicSocialOutboundTransport {
  readonly providerId = AYRSHARE_PUBLIC_SOCIAL_PROVIDER_ID;
  readonly executionMode: 'disabled' | 'contract_test';
  readonly #enabledValue: EnabledAdapter | null;
  readonly #timeoutMs: number;
  readonly #observedAt: Readonly<{ iso: string; milliseconds: number }> | null;

  constructor(options: AyrshareHttpAdapterOptions = {}) {
    plainRecord(options, 'Ayrshare adapter options');
    const mode = options.executionMode ?? 'disabled';
    if (mode !== 'disabled' && mode !== 'contract_test') fail('Ayrshare execution mode is invalid');
    this.executionMode = mode;
    const timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30_000) {
      fail('Ayrshare timeout must be between 1000 and 30000 milliseconds');
    }
    this.#timeoutMs = timeoutMs;

    if (mode === 'disabled') {
      this.#enabledValue = null;
      this.#observedAt = null;
      return;
    }
    this.#observedAt = occurredAt(options.observedAt);
    if (!options.credentials) fail('Ayrshare credential bundle is required');
    const credentials = readAyrshareCredentialBundle(options.credentials);
    if (!isAuthenticPublicSocialContractHttpTransport(options.http)) {
      fail('Ayrshare contract-test mode requires an authentic pure scripted transport');
    }
    if (!isAuthenticPublicSocialContractMediaResolver(options.mediaResolver)) {
      fail('Ayrshare contract-test mode requires an authentic pure scripted media resolver');
    }
    this.#enabledValue = Object.freeze({
      credentials,
      http: options.http,
      mediaResolver: options.mediaResolver,
    });
  }

  #enabled(): EnabledAdapter {
    if (this.executionMode !== 'contract_test' || !this.#enabledValue) {
      throw new PublicSocialOutboundDisabledError();
    }
    return this.#enabledValue;
  }

  #boundContext(
    rawContext: PublicSocialOutboundContext,
    enabled: EnabledAdapter,
  ): PublicSocialOutboundContext {
    const context = snapshotContext(rawContext);
    const binding = enabled.credentials.binding;
    if (context.workspaceId !== binding.workspaceId || context.connectionId !== binding.connectionId) {
      fail('Ayrshare credential bundle is not bound to this workspace connection');
    }
    return context;
  }

  #boundProfile(profileId: string, enabled: EnabledAdapter): void {
    if (profileId !== enabled.credentials.binding.profileId) {
      fail('Ayrshare credential bundle is not bound to this target profile');
    }
  }

  async publish(
    rawContext: PublicSocialOutboundContext,
    rawRequest: PublicSocialOutboundDispatchRequest,
  ): Promise<PublicSocialOutboundResult> {
    const enabled = this.#enabled();
    const at = this.#observedAt!;
    const context = this.#boundContext(rawContext, enabled);
    const request = snapshotDispatch(rawRequest, at.milliseconds, true);
    this.#boundProfile(request.profileId, enabled);
    const providerKey = providerIdempotencyKey(context, request.profileId);
    const effectAtMs = request.scheduledFor === null ? at.milliseconds : Date.parse(request.scheduledFor);
    const requiredValidityMs = effectAtMs + MEDIA_FETCH_GRACE_MS;

    let media: readonly PublicSocialResolvedMediaEvidence[];
    try {
      const rawMedia = request.media.length === 0
        ? Object.freeze([] as PublicSocialResolvedMediaEvidence[])
        : await executePublicSocialContractMediaResolution(
          enabled.mediaResolver, context, request.media,
        );
      media = resolvedMedia(rawMedia, request.media, requiredValidityMs);
    } catch {
      return result({
        status: 'failed', externalId: null, occurredAt: at.iso, retryable: false,
        errorCode: 'ayrshare_media_resolution_failed',
        summary: 'Approved company media could not be resolved to exact fresh evidence',
        reconciliationRequired: false, recoveryKind: 'none', providerKey,
      });
    }

    const body: Record<string, unknown> = {
      post: request.text,
      platforms: ['twitter'],
      idempotencyKey: providerKey,
      notes: request.providerNotes,
      shortenLinks: false,
    };
    if (media.length === 1) body.mediaUrls = [media[0]!.downloadUrl];
    if (request.scheduledFor !== null) body.scheduleDate = request.scheduledFor;
    const call = httpRequest(
      'POST', `${AYRSHARE_API_ORIGIN}/api/post`,
      {
        Authorization: `Bearer ${enabled.credentials.apiKey}`,
        'Content-Type': 'application/json',
        'Profile-Key': enabled.credentials.profileKey,
        'X-Twitter-OAuth1-Api-Key': enabled.credentials.xOAuth1ApiKey,
        'X-Twitter-OAuth1-Api-Secret': enabled.credentials.xOAuth1ApiSecret,
      },
      JSON.stringify(body), this.#timeoutMs,
    );

    let contractResponse: PublicSocialHttpResponse;
    try {
      contractResponse = response(await executePublicSocialContractHttpRequest(enabled.http, call));
    } catch {
      return result({
        status: 'needs_attention', externalId: null, occurredAt: at.iso, retryable: false,
        errorCode: 'ayrshare_transport_outcome_unknown',
        summary: 'Ayrshare did not prove whether it accepted the public-social post',
        reconciliationRequired: true, recoveryKind: 'history_lookup', providerKey,
      });
    }
    const payload = parseJsonBody(contractResponse.bodyUtf8);
    const externalId = safeExternalId(payload?.id);
    if (contractResponse.status < 200 || contractResponse.status >= 300) {
      const ambiguous = contractResponse.status === 408 || contractResponse.status === 409
        || contractResponse.status === 425 || contractResponse.status === 429
        || contractResponse.status >= 500;
      return result({
        status: ambiguous ? 'needs_attention' : 'failed', externalId, occurredAt: at.iso,
        retryable: false,
        errorCode: ambiguous
          ? `ayrshare_http_${contractResponse.status}_outcome_unknown`
          : `ayrshare_http_${contractResponse.status}`,
        summary: ambiguous
          ? 'Ayrshare did not prove whether it accepted the public-social post'
          : 'Ayrshare rejected the public-social request',
        reconciliationRequired: ambiguous,
        recoveryKind: ambiguous ? (externalId ? 'exact_post' : 'history_lookup') : 'none',
        providerKey,
      });
    }

    const exactScheduled = request.scheduledFor !== null
      && payload?.status === 'scheduled'
      && externalId !== null
      && exactPlatforms(payload.platforms)
      && payload.scheduleDate === request.scheduledFor;
    const exactImmediate = request.scheduledFor === null
      && payload?.status === 'success'
      && externalId !== null
      && exactImmediatePostIds(payload.postIds);
    if (!exactScheduled && !exactImmediate) {
      return result({
        status: 'needs_attention', externalId, occurredAt: at.iso, retryable: false,
        errorCode: 'ayrshare_unproven_acceptance_response',
        summary: 'Ayrshare returned a post identity without exact acceptance evidence',
        reconciliationRequired: true,
        recoveryKind: externalId ? 'exact_post' : 'history_lookup', providerKey,
      });
    }
    return result({
      status: 'accepted', externalId, occurredAt: at.iso, retryable: false,
      errorCode: null,
      summary: request.scheduledFor === null
        ? 'Ayrshare accepted the exact X post'
        : 'Ayrshare accepted the exact scheduled X post',
      reconciliationRequired: false, recoveryKind: 'none', providerKey,
    });
  }

  async reconcile(
    rawContext: PublicSocialOutboundContext,
    rawExpectation: PublicSocialReconciliationExpectation,
  ): Promise<PublicSocialOutboundResult> {
    const enabled = this.#enabled();
    const at = this.#observedAt!;
    const context = this.#boundContext(rawContext, enabled);
    const expectation = snapshotExpectation(rawExpectation);
    this.#boundProfile(expectation.profileId, enabled);
    const providerKey = providerIdempotencyKey(context, expectation.profileId);
    const call = httpRequest(
      'GET', `${AYRSHARE_API_ORIGIN}/api/post/${encodeURIComponent(expectation.externalId)}`,
      {
        Authorization: `Bearer ${enabled.credentials.apiKey}`,
        'Profile-Key': enabled.credentials.profileKey,
        'X-Twitter-OAuth1-Api-Key': enabled.credentials.xOAuth1ApiKey,
        'X-Twitter-OAuth1-Api-Secret': enabled.credentials.xOAuth1ApiSecret,
      }, null, this.#timeoutMs,
    );
    let contractResponse: PublicSocialHttpResponse;
    try {
      contractResponse = response(await executePublicSocialContractHttpRequest(enabled.http, call));
    } catch {
      return result({
        status: 'needs_attention', externalId: expectation.externalId, occurredAt: at.iso,
        retryable: false, errorCode: 'ayrshare_reconciliation_outcome_unknown',
        summary: 'Ayrshare exact post evidence could not be retrieved',
        reconciliationRequired: true, recoveryKind: 'exact_post', providerKey,
      });
    }
    if (contractResponse.status < 200 || contractResponse.status >= 300) {
      return result({
        status: 'needs_attention', externalId: expectation.externalId, occurredAt: at.iso,
        retryable: false, errorCode: `ayrshare_reconcile_http_${contractResponse.status}`,
        summary: 'Ayrshare exact post evidence could not be retrieved',
        reconciliationRequired: true, recoveryKind: 'exact_post', providerKey,
      });
    }
    const payload = parseJsonBody(contractResponse.bodyUtf8);
    if (!payload || !recordMatchesExpectation(payload, expectation)) {
      return result({
        status: 'needs_attention', externalId: expectation.externalId, occurredAt: at.iso,
        retryable: false, errorCode: 'ayrshare_unbound_reconciliation_evidence',
        summary: 'Ayrshare returned post evidence that does not bind the immutable plan',
        reconciliationRequired: true, recoveryKind: 'exact_post', providerKey,
      });
    }
    if (payload.status === 'success') {
      return result({
        status: 'succeeded', externalId: expectation.externalId, occurredAt: at.iso,
        retryable: false, errorCode: null,
        summary: 'Ayrshare reports the exact X post succeeded',
        reconciliationRequired: false, recoveryKind: 'none', providerKey,
      });
    }
    if (payload.status === 'pending' || payload.status === 'awaiting approval') {
      return result({
        status: 'pending', externalId: expectation.externalId, occurredAt: at.iso,
        retryable: true, errorCode: null,
        summary: 'Ayrshare reports the exact X post is still pending',
        reconciliationRequired: true, recoveryKind: 'exact_post', providerKey,
      });
    }
    if (payload.status === 'error') {
      return result({
        status: 'failed', externalId: expectation.externalId, occurredAt: at.iso,
        retryable: false, errorCode: 'ayrshare_post_error',
        summary: 'Ayrshare reports the exact X post failed',
        reconciliationRequired: false, recoveryKind: 'none', providerKey,
      });
    }
    return result({
      status: 'needs_attention', externalId: expectation.externalId, occurredAt: at.iso,
      retryable: false, errorCode: 'ayrshare_unknown_post_status',
      summary: 'Ayrshare returned an unknown exact post status',
      reconciliationRequired: true, recoveryKind: 'exact_post', providerKey,
    });
  }

  async recoverUnknown(
    rawContext: PublicSocialOutboundContext,
    rawRequest: PublicSocialOutboundDispatchRequest,
  ): Promise<PublicSocialOutboundResult> {
    const enabled = this.#enabled();
    const at = this.#observedAt!;
    const context = this.#boundContext(rawContext, enabled);
    const request = snapshotDispatch(rawRequest, at.milliseconds, false);
    this.#boundProfile(request.profileId, enabled);
    const providerKey = providerIdempotencyKey(context, request.profileId);
    const call = httpRequest(
      'GET', `${AYRSHARE_API_ORIGIN}/api/history?limit=25&platforms=twitter`,
      {
        Authorization: `Bearer ${enabled.credentials.apiKey}`,
        'Profile-Key': enabled.credentials.profileKey,
        'X-Twitter-OAuth1-Api-Key': enabled.credentials.xOAuth1ApiKey,
        'X-Twitter-OAuth1-Api-Secret': enabled.credentials.xOAuth1ApiSecret,
      }, null, this.#timeoutMs,
    );
    let contractResponse: PublicSocialHttpResponse;
    try {
      contractResponse = response(await executePublicSocialContractHttpRequest(enabled.http, call));
    } catch {
      return result({
        status: 'needs_attention', externalId: null, occurredAt: at.iso,
        retryable: false, errorCode: 'ayrshare_history_lookup_outcome_unknown',
        summary: 'Ayrshare history could not resolve the ambiguous publish',
        reconciliationRequired: true, recoveryKind: 'history_lookup', providerKey,
      });
    }
    const payload = parseJsonBody(contractResponse.bodyUtf8);
    if (contractResponse.status < 200 || contractResponse.status >= 300
        || !payload || !Array.isArray(payload.history)) {
      return result({
        status: 'needs_attention', externalId: null, occurredAt: at.iso,
        retryable: false, errorCode: 'ayrshare_history_lookup_unproven',
        summary: 'Ayrshare history did not prove the ambiguous publish result',
        reconciliationRequired: true, recoveryKind: 'history_lookup', providerKey,
      });
    }
    const matches: Record<string, unknown>[] = [];
    for (const candidate of payload.history) {
      try {
        const row = plainRecord(candidate, 'Ayrshare history row');
        if (dispatchMatchesHistory(row, request)) matches.push(row);
      } catch {
        // Malformed unrelated history rows are ignored; no row becomes evidence by coercion.
      }
    }
    if (matches.length !== 1) {
      return result({
        status: 'needs_attention', externalId: null, occurredAt: at.iso,
        retryable: false,
        errorCode: matches.length === 0
          ? 'ayrshare_history_match_not_found' : 'ayrshare_history_match_not_unique',
        summary: 'Ayrshare history did not uniquely bind the ambiguous publish',
        reconciliationRequired: true, recoveryKind: 'history_lookup', providerKey,
      });
    }
    const match = matches[0]!;
    const externalId = safeExternalId(match.id)!;
    if (match.status === 'success') {
      return result({
        status: 'succeeded', externalId, occurredAt: at.iso, retryable: false,
        errorCode: null, summary: 'Ayrshare history proves the exact X post succeeded',
        reconciliationRequired: false, recoveryKind: 'none', providerKey,
      });
    }
    if (match.status === 'scheduled' || match.status === 'pending'
        || match.status === 'awaiting approval') {
      return result({
        status: 'accepted', externalId, occurredAt: at.iso, retryable: false,
        errorCode: null, summary: 'Ayrshare history proves the exact X post was accepted',
        reconciliationRequired: false, recoveryKind: 'none', providerKey,
      });
    }
    if (match.status === 'error') {
      return result({
        status: 'failed', externalId, occurredAt: at.iso, retryable: false,
        errorCode: 'ayrshare_post_error', summary: 'Ayrshare history proves the exact X post failed',
        reconciliationRequired: false, recoveryKind: 'none', providerKey,
      });
    }
    return result({
      status: 'needs_attention', externalId, occurredAt: at.iso, retryable: false,
      errorCode: 'ayrshare_history_unknown_post_status',
      summary: 'Ayrshare history returned an unknown status for the exact post',
      reconciliationRequired: true, recoveryKind: 'exact_post', providerKey,
    });
  }

  toJSON(): Readonly<Record<string, string>> {
    return Object.freeze({
      provider: this.providerId,
      executionMode: this.executionMode,
      credentials: '[REDACTED]',
    });
  }
}
