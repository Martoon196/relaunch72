import { createHash } from 'node:crypto';
import { canonicalCompanyContentJson } from '../company-content-pg/validation.js';

const ENDPOINT_PATH = '/api/internal/company-content/generate';
const GENERATION_SCHEMA = 'propertypredator.company-content/v1';
const GENERATION_REQUEST_SCHEMA = 'propertypredator.company-content.generate/v1';
const MAX_REQUEST_BYTES = 8 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const SHA256 = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SAFE_CLIENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u;
const SAFE_RESERVATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,199}$/u;
const SAFE_CTA_HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;
const PROPERTY_PREDATOR_CTA_ROOT = 'propertypredator.com';
const VISIBLE_ASCII = /^[\x21-\x7e]+$/u;
const JSON_MEDIA_TYPE = /^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json$/iu;
const UNSAFE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const EMAIL_ADDRESS = /\b[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+\b/iu;
const UK_POSTCODE = /\b(?:GIR\s?0AA|[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2})\b/iu;
const PRIVATE_FIELD = /\b(?:customer|client|contact|lead)[_. -]*(?:id|first[_. -]?name|last[_. -]?name|full[_. -]?name|email|phone|mobile|address)\b/iu;
const PRIVATE_LABEL = /\b(?:customer|client|contact|lead)\s+(?:name|email|phone|mobile|address)\s*:/iu;
const AFFILIATE_MARKER = /(?:\{\{link\}\}|#ad\b|partner link|affiliate link|affiliate partner|i earn a commission|commission if you|[?&]ref=)/iu;
const FIRST_PERSON_RESULT = /\b(?:i|i've|i’d|i'd)\s+(?:use|used|found|saved|made|earned|stopped|avoided|overpaid|offered|bought|sold|invested|negotiated|achieved)\b|\bmy\s+(?:deal|property|portfolio|offer|investment|result|return|yield)\b/iu;
const MARKUP = /[<>]/u;
const WEB_URL = /\bhttps?:\/\/|\bwww\./iu;

export const PROPERTY_PREDATOR_GENERATE_CREDENTIAL_BOUNDARY =
  'property-predator-company-content-generate/v1' as const;

export type PropertyPredatorGenerationKind =
  | 'post'
  | 'thread'
  | 'email'
  | 'script'
  | 'article'
  | 'ad'
  | 'image';

export interface PropertyPredatorGenerationBrief {
  readonly kind: PropertyPredatorGenerationKind;
  readonly platform: string;
  readonly topic: string;
  readonly tone: string;
}

export interface PropertyPredatorGenerateDraftCommand {
  readonly idempotencyKey: string;
  readonly expectedBrandSha256: string;
  /** The maximum amount this one reservation may consume, in minor currency units. */
  readonly maximumCostMinor: number;
  readonly brief: PropertyPredatorGenerationBrief;
}

export interface PropertyPredatorGenerationCredential {
  readonly boundary: typeof PROPERTY_PREDATOR_GENERATE_CREDENTIAL_BOUNDARY;
  readonly clientId: string;
  readonly generateToken: string;
  /** Required digest of the separate company-content read credential. */
  readonly readCredentialSha256: string;
  /** Required digest of the separate company-content sync credential. */
  readonly syncCredentialSha256: string;
}

export interface PropertyPredatorGenerationPolicyRequest {
  readonly requestSha256: string;
  readonly idempotencyKeySha256: string;
  readonly expectedBrandSha256: string;
  readonly kind: PropertyPredatorGenerationKind;
  readonly requestBytes: number;
  readonly maximumCostMinor: number;
}

export type PropertyPredatorGenerationDenialReason =
  | 'generation_disabled'
  | 'provider_effects_disabled'
  | 'emergency_paused'
  | 'volume_exhausted'
  | 'spend_exhausted'
  | 'policy_unavailable';

export type PropertyPredatorGenerationPolicyDecision =
  | Readonly<{
      allowed: false;
      reasonCode: PropertyPredatorGenerationDenialReason;
    }>
  | Readonly<{
      allowed: true;
      reservationId: string;
      generationEnabled: true;
      providerEffectsEnabled: true;
      emergencyPaused: false;
      availableRequestSlots: number;
      availableSpendMinor: number;
      approvedMaximumCostMinor: number;
    }>;

export interface PropertyPredatorGenerationPolicyOutcome {
  readonly reservationId: string;
  readonly requestSha256: string;
  readonly idempotencyKeySha256: string;
  readonly outcome: 'accepted' | 'failed_closed';
  readonly effectState: 'confirmed_version' | 'unknown' | 'not_sent';
  readonly safeErrorCode: PropertyPredatorGenerationBridgeErrorCode | null;
  readonly versionId: string | null;
  readonly contentSha256: string | null;
  /** Verified upstream accounting; null unless a complete version was confirmed. */
  readonly actualCostMinor: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly model: string | null;
  readonly providerRequestId: string | null;
  readonly usageSha256: string | null;
}

/**
 * A production implementation must reserve request volume and maximum spend
 * atomically and idempotently by requestSha256 + idempotencyKeySha256, so a
 * retry cannot consume a second allowance. Omitting this policy keeps
 * generation and provider effects off.
 */
export interface PropertyPredatorGenerationPolicy {
  reserve(
    request: PropertyPredatorGenerationPolicyRequest,
  ): Promise<PropertyPredatorGenerationPolicyDecision>;
  recordOutcome(outcome: PropertyPredatorGenerationPolicyOutcome): Promise<void>;
}

export interface PropertyPredatorGeneratedPayload {
  readonly body: string;
  readonly cta_url: string;
  readonly kind: PropertyPredatorGenerationKind;
  readonly platform: string;
  readonly schema: typeof GENERATION_SCHEMA;
  readonly title: string;
  readonly type: 'generated';
}

export interface PropertyPredatorGenerationUsage {
  /** Actual ledger charge in the same minor-currency unit as maximumCostMinor. */
  readonly actualCostMinor: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly model: string;
  readonly providerRequestId: string;
}

export interface PropertyPredatorGeneratedDraft {
  readonly ok: true;
  readonly schemaVersion: 1;
  readonly brandSha256: string;
  readonly contentSha256: string;
  readonly draftId: string;
  readonly itemVersion: number;
  readonly payload: PropertyPredatorGeneratedPayload;
  readonly status: 'source_review_required';
  readonly usage: PropertyPredatorGenerationUsage;
  readonly usageSha256: string;
  readonly versionId: string;
}

export interface PropertyPredatorGenerationTransport {
  generateDraft(command: PropertyPredatorGenerateDraftCommand): Promise<PropertyPredatorGeneratedDraft>;
}

export interface PropertyPredatorGenerationTransportOptions {
  readonly baseUrl: string;
  readonly credential: PropertyPredatorGenerationCredential;
  /** Exact, lowercase Property Predator CTA hosts. Wildcards and suffix matching are forbidden. */
  readonly approvedCtaHosts: readonly string[];
  /** Deliberately optional: absence is the dark/default-deny configuration. */
  readonly policy?: PropertyPredatorGenerationPolicy;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  /** Test-only escape hatch. Production callers must use HTTPS. */
  readonly allowLocalHttp?: boolean;
}

export type PropertyPredatorGenerationBridgeErrorCode =
  | 'invalid_configuration'
  | 'invalid_request'
  | 'effects_disabled'
  | 'emergency_paused'
  | 'volume_exhausted'
  | 'spend_exhausted'
  | 'policy_unavailable'
  | 'timeout'
  | 'upstream_rejected'
  | 'invalid_response'
  | 'integrity_mismatch'
  | 'transport_failed';

const ERROR_MESSAGES: Readonly<Record<PropertyPredatorGenerationBridgeErrorCode, string>> =
  Object.freeze({
    invalid_configuration: 'company-content generation bridge configuration is invalid',
    invalid_request: 'company-content generation request is invalid',
    effects_disabled: 'company-content generation effects are disabled',
    emergency_paused: 'company-content generation is emergency-paused',
    volume_exhausted: 'company-content generation volume is unavailable',
    spend_exhausted: 'company-content generation spend is unavailable',
    policy_unavailable: 'company-content generation policy is unavailable',
    timeout: 'company-content generation request timed out',
    upstream_rejected: 'company-content generation was rejected',
    invalid_response: 'company-content generation response is invalid',
    integrity_mismatch: 'company-content generation integrity check failed',
    transport_failed: 'company-content generation request failed closed',
  });

export class PropertyPredatorGenerationBridgeError extends Error {
  constructor(readonly code: PropertyPredatorGenerationBridgeErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'PropertyPredatorGenerationBridgeError';
  }
}

function bridgeError(code: PropertyPredatorGenerationBridgeErrorCode): PropertyPredatorGenerationBridgeError {
  return new PropertyPredatorGenerationBridgeError(code);
}

function dataRecord(
  input: unknown,
  expectedKeys: readonly string[],
  code: PropertyPredatorGenerationBridgeErrorCode,
): Readonly<Record<string, unknown>> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw bridgeError(code);
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) throw bridgeError(code);
  const keys = Reflect.ownKeys(input);
  if (keys.some((key) => typeof key !== 'string')) throw bridgeError(code);
  const actual = (keys as string[]).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw bridgeError(code);
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  for (const key of expected) {
    const descriptor = descriptors[key];
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw bridgeError(code);
  }
  return input as Readonly<Record<string, unknown>>;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonicalSha(value: unknown, code: PropertyPredatorGenerationBridgeErrorCode): string {
  if (typeof value !== 'string' || !SHA256.test(value)) throw bridgeError(code);
  return value;
}

function cleanBaseUrl(raw: unknown, allowLocalHttp: boolean): URL {
  if (typeof raw !== 'string') throw bridgeError('invalid_configuration');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw bridgeError('invalid_configuration');
  }
  const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if ((url.protocol !== 'https:' && !(allowLocalHttp && local))
      || url.username || url.password || url.search || url.hash
      || (url.pathname !== '' && url.pathname !== '/')) {
    throw bridgeError('invalid_configuration');
  }
  return url;
}

function timeout(raw: unknown): number {
  const value = raw ?? 8_000;
  if (!Number.isSafeInteger(value) || (value as number) < 100 || (value as number) > 30_000) {
    throw bridgeError('invalid_configuration');
  }
  return value as number;
}

function credential(input: unknown): Readonly<{
  clientId: string;
  generateToken: string;
}> {
  const value = dataRecord(input, [
    'boundary', 'clientId', 'generateToken', 'readCredentialSha256', 'syncCredentialSha256',
  ], 'invalid_configuration');
  if (value.boundary !== PROPERTY_PREDATOR_GENERATE_CREDENTIAL_BOUNDARY
      || typeof value.clientId !== 'string' || !SAFE_CLIENT_ID.test(value.clientId)
      || typeof value.generateToken !== 'string'
      || Buffer.byteLength(value.generateToken, 'utf8') < 32
      || Buffer.byteLength(value.generateToken, 'utf8') > 512
      || !VISIBLE_ASCII.test(value.generateToken)) {
    throw bridgeError('invalid_configuration');
  }
  const readCredentialSha256 = canonicalSha(value.readCredentialSha256, 'invalid_configuration');
  const syncCredentialSha256 = canonicalSha(value.syncCredentialSha256, 'invalid_configuration');
  const generateCredentialSha256 = sha256(value.generateToken);
  if (readCredentialSha256 === syncCredentialSha256
      || readCredentialSha256 === generateCredentialSha256
      || syncCredentialSha256 === generateCredentialSha256) {
    throw bridgeError('invalid_configuration');
  }
  return Object.freeze({ clientId: value.clientId, generateToken: value.generateToken });
}

function ctaHosts(input: unknown): ReadonlySet<string> {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype
      || input.length < 1 || input.length > 32) {
    throw bridgeError('invalid_configuration');
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = Reflect.ownKeys(input);
  if (keys.some((key) => typeof key !== 'string')
      || keys.some((key) => key !== 'length' && !/^(?:0|[1-9][0-9]*)$/u.test(key as string))) {
    throw bridgeError('invalid_configuration');
  }
  const approved = new Set<string>();
  for (let index = 0; index < input.length; index += 1) {
    const descriptor = descriptors[String(index)];
    const candidate = descriptor && descriptor.enumerable && 'value' in descriptor
      ? descriptor.value : null;
    if (typeof candidate !== 'string' || candidate !== candidate.toLowerCase()
        || !SAFE_CTA_HOST.test(candidate)
        || (candidate !== PROPERTY_PREDATOR_CTA_ROOT
          && !candidate.endsWith(`.${PROPERTY_PREDATOR_CTA_ROOT}`))) {
      throw bridgeError('invalid_configuration');
    }
    approved.add(candidate);
  }
  if (approved.size !== input.length) throw bridgeError('invalid_configuration');
  return approved;
}

function safeText(
  input: unknown,
  minimum: number,
  maximum: number,
  allowEmpty: boolean,
): string {
  if (typeof input !== 'string' || input !== input.trim()
      || input.length < minimum || input.length > maximum
      || (!allowEmpty && input.length === 0) || UNSAFE_CONTROL.test(input)) {
    throw bridgeError('invalid_request');
  }
  return input;
}

function containsPhoneNumber(value: string): boolean {
  const candidates = value.match(/(?:\+|\b0)[\d\s().-]{8,}\d/gu) ?? [];
  return candidates.some((candidate) => {
    const count = candidate.replace(/\D/gu, '').length;
    return count >= 10 && count <= 15;
  });
}

function assertNoPrivateOrAttributedText(value: string, allowUrl: boolean): void {
  if (EMAIL_ADDRESS.test(value) || UK_POSTCODE.test(value) || containsPhoneNumber(value)
      || PRIVATE_FIELD.test(value) || PRIVATE_LABEL.test(value) || AFFILIATE_MARKER.test(value)
      || MARKUP.test(value) || (!allowUrl && WEB_URL.test(value))) {
    throw bridgeError('invalid_request');
  }
}

const GENERATION_KINDS = new Set<PropertyPredatorGenerationKind>([
  'post', 'thread', 'email', 'script', 'article', 'ad', 'image',
]);

function command(input: unknown): Readonly<{
  idempotencyKey: string;
  idempotencyKeySha256: string;
  expectedBrandSha256: string;
  maximumCostMinor: number;
  brief: PropertyPredatorGenerationBrief;
  body: string;
  bodyBytes: number;
  requestSha256: string;
}> {
  const value = dataRecord(input, [
    'brief', 'expectedBrandSha256', 'idempotencyKey', 'maximumCostMinor',
  ], 'invalid_request');
  if (typeof value.idempotencyKey !== 'string'
      || value.idempotencyKey.length < 16 || value.idempotencyKey.length > 200
      || !VISIBLE_ASCII.test(value.idempotencyKey)) {
    throw bridgeError('invalid_request');
  }
  const expectedBrandSha256 = canonicalSha(value.expectedBrandSha256, 'invalid_request');
  if (!Number.isSafeInteger(value.maximumCostMinor)
      || (value.maximumCostMinor as number) < 1
      || (value.maximumCostMinor as number) > 100_000) {
    throw bridgeError('invalid_request');
  }
  const rawBrief = dataRecord(value.brief, ['kind', 'platform', 'tone', 'topic'], 'invalid_request');
  if (typeof rawBrief.kind !== 'string'
      || !GENERATION_KINDS.has(rawBrief.kind as PropertyPredatorGenerationKind)) {
    throw bridgeError('invalid_request');
  }
  const platform = safeText(rawBrief.platform, 0, 40, true);
  const topic = safeText(rawBrief.topic, 1, 400, false);
  const tone = safeText(rawBrief.tone, 0, 60, true);
  for (const text of [platform, topic, tone]) assertNoPrivateOrAttributedText(text, false);
  const brief = Object.freeze({
    kind: rawBrief.kind as PropertyPredatorGenerationKind,
    platform,
    topic,
    tone,
  });
  const body = canonicalCompanyContentJson(Object.freeze({
    brief,
    expectedBrandSha256,
    maximumCostMinor: value.maximumCostMinor as number,
    schema: GENERATION_REQUEST_SCHEMA,
  }));
  const bodyBytes = Buffer.byteLength(body, 'utf8');
  if (bodyBytes < 1 || bodyBytes > MAX_REQUEST_BYTES) throw bridgeError('invalid_request');
  return Object.freeze({
    idempotencyKey: value.idempotencyKey,
    idempotencyKeySha256: sha256(value.idempotencyKey),
    expectedBrandSha256,
    maximumCostMinor: value.maximumCostMinor as number,
    brief,
    body,
    bodyBytes,
    requestSha256: sha256(body),
  });
}

function policyDecision(
  input: unknown,
  requestedMaximumCostMinor: number,
): PropertyPredatorGenerationPolicyDecision {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw bridgeError('policy_unavailable');
  }
  const allowedDescriptor = Object.getOwnPropertyDescriptor(input, 'allowed');
  if (!allowedDescriptor || !('value' in allowedDescriptor)) throw bridgeError('policy_unavailable');
  if (allowedDescriptor.value === false) {
    const denied = dataRecord(input, ['allowed', 'reasonCode'], 'policy_unavailable');
    const allowedReasons = new Set<PropertyPredatorGenerationDenialReason>([
      'generation_disabled', 'provider_effects_disabled', 'emergency_paused',
      'volume_exhausted', 'spend_exhausted', 'policy_unavailable',
    ]);
    if (typeof denied.reasonCode !== 'string'
        || !allowedReasons.has(denied.reasonCode as PropertyPredatorGenerationDenialReason)) {
      throw bridgeError('policy_unavailable');
    }
    return Object.freeze({
      allowed: false,
      reasonCode: denied.reasonCode as PropertyPredatorGenerationDenialReason,
    });
  }
  const approved = dataRecord(input, [
    'allowed', 'approvedMaximumCostMinor', 'availableRequestSlots', 'availableSpendMinor',
    'emergencyPaused', 'generationEnabled', 'providerEffectsEnabled', 'reservationId',
  ], 'policy_unavailable');
  if (approved.allowed !== true || approved.generationEnabled !== true
      || approved.providerEffectsEnabled !== true || approved.emergencyPaused !== false
      || typeof approved.reservationId !== 'string'
      || !SAFE_RESERVATION_ID.test(approved.reservationId)
      || !Number.isSafeInteger(approved.availableRequestSlots)
      || (approved.availableRequestSlots as number) < 1
      || !Number.isSafeInteger(approved.availableSpendMinor)
      || (approved.availableSpendMinor as number) < requestedMaximumCostMinor
      || approved.approvedMaximumCostMinor !== requestedMaximumCostMinor) {
    throw bridgeError('policy_unavailable');
  }
  return Object.freeze({
    allowed: true,
    reservationId: approved.reservationId,
    generationEnabled: true,
    providerEffectsEnabled: true,
    emergencyPaused: false,
    availableRequestSlots: approved.availableRequestSlots as number,
    availableSpendMinor: approved.availableSpendMinor as number,
    approvedMaximumCostMinor: approved.approvedMaximumCostMinor as number,
  });
}

function denialError(reason: PropertyPredatorGenerationDenialReason): PropertyPredatorGenerationBridgeError {
  if (reason === 'emergency_paused') return bridgeError('emergency_paused');
  if (reason === 'volume_exhausted') return bridgeError('volume_exhausted');
  if (reason === 'spend_exhausted') return bridgeError('spend_exhausted');
  if (reason === 'policy_unavailable') return bridgeError('policy_unavailable');
  return bridgeError('effects_disabled');
}

function validJsonMediaType(raw: string | null): boolean {
  if (raw === null) return false;
  const parts = raw.split(';').map((part) => part.trim());
  const mediaType = parts.shift();
  if (!mediaType || !JSON_MEDIA_TYPE.test(mediaType)) return false;
  if (parts.length === 0) return true;
  return parts.length === 1 && /^charset=utf-8$/iu.test(parts[0]!);
}

function hasNoStore(raw: string | null): boolean {
  return raw !== null && raw.split(',').some((part) => part.trim().toLowerCase() === 'no-store');
}

type DeadlineRace = <T>(operation: Promise<T>) => Promise<T>;

async function boundedBody(response: Response, beforeDeadline: DeadlineRace): Promise<string> {
  const declaredRaw = response.headers.get('content-length');
  let declared: number | null = null;
  if (declaredRaw !== null) {
    if (!/^(?:0|[1-9][0-9]{0,7})$/u.test(declaredRaw)) throw bridgeError('invalid_response');
    declared = Number(declaredRaw);
    if (!Number.isSafeInteger(declared) || declared > MAX_RESPONSE_BYTES) {
      throw bridgeError('invalid_response');
    }
  }
  if (!response.body) throw bridgeError('invalid_response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await beforeDeadline(reader.read());
      if (next.done) break;
      if (!(next.value instanceof Uint8Array)) throw bridgeError('invalid_response');
      bytes += next.value.byteLength;
      if (!Number.isSafeInteger(bytes) || bytes > MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw bridgeError('invalid_response');
      }
      chunks.push(Uint8Array.from(next.value));
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    if (error instanceof PropertyPredatorGenerationBridgeError) throw error;
    throw bridgeError('invalid_response');
  } finally {
    try { reader.releaseLock(); } catch { /* An untrusted stream cannot retain the caller. */ }
  }
  if (bytes === 0 || (declared !== null && declared !== bytes)) {
    throw bridgeError('invalid_response');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))),
    );
  } catch {
    throw bridgeError('invalid_response');
  }
}

function cleanHttpsUrl(input: unknown, approvedHosts: ReadonlySet<string>): string {
  if (typeof input !== 'string' || input.length < 1 || input.length > 500) {
    throw bridgeError('invalid_response');
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw bridgeError('invalid_response');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port
      || !approvedHosts.has(url.hostname)) {
    throw bridgeError('invalid_response');
  }
  for (const key of url.searchParams.keys()) {
    if (key.toLowerCase() === 'ref' || key.toLowerCase().startsWith('affiliate')) {
      throw bridgeError('invalid_response');
    }
  }
  return input;
}

function responseText(input: unknown, minimum: number, maximum: number): string {
  if (typeof input !== 'string' || input.length < minimum || input.length > maximum
      || UNSAFE_CONTROL.test(input)) {
    throw bridgeError('invalid_response');
  }
  return input;
}

function nonNegativeInteger(input: unknown, maximum: number): number {
  if (!Number.isSafeInteger(input) || (input as number) < 0 || (input as number) > maximum) {
    throw bridgeError('invalid_response');
  }
  return input as number;
}

function parseUsage(
  input: unknown,
  usageSha256: unknown,
  maximumCostMinor: number,
): Readonly<{ usage: PropertyPredatorGenerationUsage; usageSha256: string }> {
  const raw = dataRecord(input, [
    'actualCostMinor', 'inputTokens', 'model', 'outputTokens', 'providerRequestId',
  ], 'invalid_response');
  const actualCostMinor = nonNegativeInteger(raw.actualCostMinor, maximumCostMinor);
  const inputTokens = nonNegativeInteger(raw.inputTokens, 10_000_000);
  const outputTokens = nonNegativeInteger(raw.outputTokens, 10_000_000);
  const model = responseText(raw.model, 1, 200);
  if (MARKUP.test(model)) throw bridgeError('invalid_response');
  if (typeof raw.providerRequestId !== 'string'
      || !SAFE_RESERVATION_ID.test(raw.providerRequestId)) {
    throw bridgeError('invalid_response');
  }
  const usage = Object.freeze({
    actualCostMinor,
    inputTokens,
    model,
    outputTokens,
    providerRequestId: raw.providerRequestId,
  });
  const expectedUsageSha256 = canonicalSha(usageSha256, 'invalid_response');
  if (sha256(canonicalCompanyContentJson(usage)) !== expectedUsageSha256) {
    throw bridgeError('integrity_mismatch');
  }
  return Object.freeze({ usage, usageSha256: expectedUsageSha256 });
}

function parseGeneratedDraft(
  input: unknown,
  expected: Readonly<{
    approvedCtaHosts: ReadonlySet<string>;
    brandSha256: string;
    brief: PropertyPredatorGenerationBrief;
    maximumCostMinor: number;
  }>,
): PropertyPredatorGeneratedDraft {
  const value = dataRecord(input, [
    'brandSha256', 'contentSha256', 'draftId', 'itemVersion', 'ok', 'payload',
    'schemaVersion', 'status', 'usage', 'usageSha256', 'versionId',
  ], 'invalid_response');
  if (value.ok !== true || value.schemaVersion !== 1 || value.status !== 'source_review_required') {
    throw bridgeError('invalid_response');
  }
  const brandSha256 = canonicalSha(value.brandSha256, 'invalid_response');
  const contentSha256 = canonicalSha(value.contentSha256, 'invalid_response');
  if (brandSha256 !== expected.brandSha256) throw bridgeError('integrity_mismatch');
  if (typeof value.draftId !== 'string' || !UUID.test(value.draftId)
      || typeof value.versionId !== 'string' || !UUID.test(value.versionId)
      || !Number.isSafeInteger(value.itemVersion)
      || value.itemVersion !== 1) {
    throw bridgeError('invalid_response');
  }
  const rawPayload = dataRecord(value.payload, [
    'body', 'cta_url', 'kind', 'platform', 'schema', 'title', 'type',
  ], 'invalid_response');
  if (rawPayload.type !== 'generated' || rawPayload.schema !== GENERATION_SCHEMA
      || rawPayload.kind !== expected.brief.kind || rawPayload.platform !== expected.brief.platform) {
    throw bridgeError('integrity_mismatch');
  }
  const title = responseText(rawPayload.title, 1, 300);
  const body = responseText(rawPayload.body, 1, 20_000);
  const platform = responseText(rawPayload.platform, 0, 40);
  if (MARKUP.test(title) || MARKUP.test(body) || MARKUP.test(platform)
      || FIRST_PERSON_RESULT.test(title) || FIRST_PERSON_RESULT.test(body)) {
    throw bridgeError('invalid_response');
  }
  for (const text of [title, body, platform]) {
    try {
      // The structured CTA is the only permitted destination. Raw body links
      // would bypass the exact Property Predator host registry.
      assertNoPrivateOrAttributedText(text, false);
    } catch {
      throw bridgeError('invalid_response');
    }
  }
  const payload = Object.freeze({
    body,
    cta_url: cleanHttpsUrl(rawPayload.cta_url, expected.approvedCtaHosts),
    kind: rawPayload.kind as PropertyPredatorGenerationKind,
    platform,
    schema: GENERATION_SCHEMA,
    title,
    type: 'generated' as const,
  });
  if (sha256(canonicalCompanyContentJson(payload)) !== contentSha256) {
    throw bridgeError('integrity_mismatch');
  }
  const accounting = parseUsage(value.usage, value.usageSha256, expected.maximumCostMinor);
  return Object.freeze({
    ok: true,
    schemaVersion: 1,
    brandSha256,
    contentSha256,
    draftId: value.draftId,
    itemVersion: value.itemVersion as number,
    payload,
    status: 'source_review_required',
    usage: accounting.usage,
    usageSha256: accounting.usageSha256,
    versionId: value.versionId,
  });
}

function policyRequest(
  normalized: ReturnType<typeof command>,
): PropertyPredatorGenerationPolicyRequest {
  return Object.freeze({
    requestSha256: normalized.requestSha256,
    idempotencyKeySha256: normalized.idempotencyKeySha256,
    expectedBrandSha256: normalized.expectedBrandSha256,
    kind: normalized.brief.kind,
    requestBytes: normalized.bodyBytes,
    maximumCostMinor: normalized.maximumCostMinor,
  });
}

function normalizeCommand(input: unknown): ReturnType<typeof command> {
  try {
    return command(input);
  } catch (error) {
    if (error instanceof PropertyPredatorGenerationBridgeError) throw error;
    throw bridgeError('invalid_request');
  }
}

/**
 * Creates the isolated generate-only bridge. It cannot read/sync company
 * content and it has no publish/send operation. A policy must deliberately
 * enable and reserve both generation and provider effects for every call.
 */
export function createPropertyPredatorGenerationTransport(
  options: PropertyPredatorGenerationTransportOptions,
): PropertyPredatorGenerationTransport {
  const baseUrl = cleanBaseUrl(options.baseUrl, options.allowLocalHttp === true);
  const scopedCredential = credential(options.credential);
  const approvedCtaHosts = ctaHosts(options.approvedCtaHosts);
  const timeoutMs = timeout(options.timeoutMs);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw bridgeError('invalid_configuration');
  const policy = options.policy;
  if (policy !== undefined
      && (typeof policy !== 'object' || policy === null
        || typeof policy.reserve !== 'function' || typeof policy.recordOutcome !== 'function')) {
    throw bridgeError('invalid_configuration');
  }
  const endpoint = new URL(ENDPOINT_PATH, baseUrl).href;

  return Object.freeze({
    async generateDraft(input: PropertyPredatorGenerateDraftCommand): Promise<PropertyPredatorGeneratedDraft> {
      const normalized = normalizeCommand(input);
      if (!policy) throw bridgeError('effects_disabled');
      const requestPolicy = policyRequest(normalized);
      const controller = new AbortController();
      let rejectDeadline: ((error: PropertyPredatorGenerationBridgeError) => void) | undefined;
      const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
      const timer = setTimeout(() => {
        controller.abort();
        rejectDeadline?.(bridgeError('timeout'));
      }, timeoutMs);
      const beforeDeadline: DeadlineRace = async <T>(operation: Promise<T>): Promise<T> => (
        Promise.race([operation, deadline])
      );
      let reservationId: string | null = null;
      let effectStarted = false;
      let outcomeRecorded = false;
      try {
        let decision: PropertyPredatorGenerationPolicyDecision;
        try {
          decision = policyDecision(
            await beforeDeadline(policy.reserve(requestPolicy)),
            normalized.maximumCostMinor,
          );
        } catch (error) {
          if (error instanceof PropertyPredatorGenerationBridgeError) throw error;
          throw bridgeError('policy_unavailable');
        }
        if (!decision.allowed) throw denialError(decision.reasonCode);
        reservationId = decision.reservationId;
        effectStarted = true;
        let response: Response;
        try {
          response = await beforeDeadline(fetchImpl(endpoint, {
            method: 'POST',
            headers: Object.freeze({
              accept: 'application/json',
              authorization: `Bearer ${scopedCredential.generateToken}`,
              'content-length': String(normalized.bodyBytes),
              'content-type': 'application/json; charset=utf-8',
              'idempotency-key': normalized.idempotencyKey,
              'x-content-client': scopedCredential.clientId,
            }),
            body: normalized.body,
            cache: 'no-store',
            credentials: 'omit',
            redirect: 'error',
            referrerPolicy: 'no-referrer',
            signal: controller.signal,
          }));
        } catch (error) {
          if (error instanceof PropertyPredatorGenerationBridgeError) throw error;
          throw bridgeError('transport_failed');
        }
        if (!(response instanceof Response) || response.redirected) throw bridgeError('invalid_response');
        if (response.status !== 201) throw bridgeError('upstream_rejected');
        if (!validJsonMediaType(response.headers.get('content-type'))
            || !hasNoStore(response.headers.get('cache-control'))) {
          throw bridgeError('invalid_response');
        }
        const raw = await boundedBody(response, beforeDeadline);
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw) as unknown;
        } catch {
          throw bridgeError('invalid_response');
        }
        const draft = parseGeneratedDraft(parsed, {
          approvedCtaHosts,
          brandSha256: normalized.expectedBrandSha256,
          brief: normalized.brief,
          maximumCostMinor: normalized.maximumCostMinor,
        });
        try {
          await beforeDeadline(policy.recordOutcome(Object.freeze({
            reservationId,
            requestSha256: normalized.requestSha256,
            idempotencyKeySha256: normalized.idempotencyKeySha256,
            outcome: 'accepted',
            effectState: 'confirmed_version',
            safeErrorCode: null,
            versionId: draft.versionId,
            contentSha256: draft.contentSha256,
            actualCostMinor: draft.usage.actualCostMinor,
            inputTokens: draft.usage.inputTokens,
            outputTokens: draft.usage.outputTokens,
            model: draft.usage.model,
            providerRequestId: draft.usage.providerRequestId,
            usageSha256: draft.usageSha256,
          })));
          outcomeRecorded = true;
        } catch {
          throw bridgeError('policy_unavailable');
        }
        return draft;
      } catch (error) {
        const safeError = error instanceof PropertyPredatorGenerationBridgeError
          ? error : bridgeError('transport_failed');
        if (reservationId !== null && !outcomeRecorded) {
          try {
            await beforeDeadline(policy.recordOutcome(Object.freeze({
              reservationId,
              requestSha256: normalized.requestSha256,
              idempotencyKeySha256: normalized.idempotencyKeySha256,
              outcome: 'failed_closed',
              effectState: effectStarted ? 'unknown' : 'not_sent',
              safeErrorCode: safeError.code,
              versionId: null,
              contentSha256: null,
              actualCostMinor: null,
              inputTokens: null,
              outputTokens: null,
              model: null,
              providerRequestId: null,
              usageSha256: null,
            })));
          } catch {
            // The spend/volume reservation remains consumed. The absolute
            // deadline still wins, and policy details are never exposed.
          }
        }
        throw safeError;
      } finally {
        clearTimeout(timer);
      }
    },
  });
}
