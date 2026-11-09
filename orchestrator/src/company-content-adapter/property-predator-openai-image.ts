import { createHash } from 'node:crypto';
import { canonicalCompanyContentJson } from '../company-content-pg/validation.js';

const MODEL = 'gpt-image-2' as const;
const GENERATE_PATH = '/v1/images/generations';
const EDIT_PATH = '/v1/images/edits';
const MAX_PROMPT_BYTES = 8 * 1024;
const MAX_REFERENCE_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const VISIBLE_ASCII = /^[\x21-\x7e]+$/u;
const SAFE_IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,199}$/u;
const SAFE_RESERVATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,199}$/u;
const SAFE_PROVIDER_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/u;
const JSON_MEDIA_TYPE = /^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json$/iu;
const UNSAFE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const EMAIL_ADDRESS = /\b[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+\b/iu;
const UK_POSTCODE = /\b(?:GIR\s?0AA|[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2})\b/iu;
const PRIVATE_FIELD = /\b(?:customer|client|contact|lead)[_. -]*(?:id|name|email|phone|mobile|address)\b/iu;
const PRIVATE_LABEL = /\b(?:customer|client|contact|lead)\s+(?:name|email|phone|mobile|address)\s*:/iu;
const SECRET_MARKER = /\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|secret|bearer)\b|-----BEGIN [A-Z ]+PRIVATE KEY-----/iu;
const URL_MARKER = /\bhttps?:\/\/|\bwww\./iu;
const MARKUP = /[<>]/u;
const PROMPT_OVERRIDE = /\b(?:ignore|override|disregard|forget|bypass)\b.{0,40}\b(?:instruction|rule|policy|guardrail|system|brand)\b/iu;
const BANNED_VISUAL_REQUEST = /\b(?:logo|wordmark|caption|typography|text|lettering|people|person|human|face|portrait|man|woman|child|crowd|estate agent|handshake|animal|panther|lion|tiger|cat|dog|mascot|fake ui|fake interface|dashboard mockup|software screen|purple|royal blue|gold|orange glow|cyberpunk|american suburban|real estate)\b/iu;

export const PROPERTY_PREDATOR_OPENAI_IMAGE_CREDENTIAL_BOUNDARY =
  'property-predator-openai-image-api/v1' as const;

export const PROPERTY_PREDATOR_IMAGE_RULES = Object.freeze({
  schema: 'propertypredator.image-rules/v1',
  brand: 'property-predator',
  palette: Object.freeze({
    background: '#050608',
    brightAccent: '#00E5CC',
    neutralDetail: '#EEF1F7',
  }),
  aesthetic: 'dark-editorial-uk-property-intelligence',
  requiresUkPropertyArchitecture: true,
  forbidden: Object.freeze([
    'text', 'people', 'faces', 'logos', 'animals', 'mascots', 'fake-ui',
    'purple', 'royal-blue', 'gold', 'orange-glow', 'cyberpunk-city',
  ]),
  outputState: 'human-review-required',
} as const);

export const PROPERTY_PREDATOR_IMAGE_RULES_SHA256 = createHash('sha256')
  .update(canonicalCompanyContentJson(PROPERTY_PREDATOR_IMAGE_RULES), 'utf8')
  .digest('hex');

export type PropertyPredatorImageOperation = 'generate' | 'edit';
export type PropertyPredatorImageSize = '1024x1024' | '1536x1024' | '1024x1536';
export type PropertyPredatorImageQuality = 'low' | 'medium' | 'high';
export type PropertyPredatorImageFormat = 'png' | 'webp' | 'jpeg';
export type PropertyPredatorImageMimeType = 'image/png' | 'image/webp' | 'image/jpeg';

export interface PropertyPredatorImageVisualBrief {
  readonly subject: string;
  readonly forensicConcept: string;
  readonly composition: string;
  readonly intendedUse: 'article-hero' | 'social-background' | 'campaign-concept' | 'diagram-background';
  readonly altText: string;
}

interface PropertyPredatorImageCommandBase {
  readonly idempotencyKey: string;
  readonly expectedBrandSha256: string;
  /** Maximum provider charge in USD cents for this one reservation. */
  readonly maximumCostMinor: number;
  readonly size: PropertyPredatorImageSize;
  readonly quality: PropertyPredatorImageQuality;
  readonly format: PropertyPredatorImageFormat;
  readonly visualBrief: PropertyPredatorImageVisualBrief;
}

export interface PropertyPredatorGenerateImageCommand extends PropertyPredatorImageCommandBase {}

export interface PropertyPredatorOwnedImageReference {
  readonly assetId: string;
  readonly versionId: string;
  readonly sha256: string;
  readonly bytes: Uint8Array;
  readonly format: PropertyPredatorImageFormat;
  readonly mimeType: PropertyPredatorImageMimeType;
  readonly width: number;
  readonly height: number;
}

export interface PropertyPredatorEditImageCommand extends PropertyPredatorImageCommandBase {
  readonly reference: PropertyPredatorOwnedImageReference;
}

export interface PropertyPredatorOpenAiImageCredential {
  readonly boundary: typeof PROPERTY_PREDATOR_OPENAI_IMAGE_CREDENTIAL_BOUNDARY;
  readonly purpose: 'image_api_only';
  readonly apiKey: string;
  readonly contentReadCredentialSha256: string;
  readonly contentSyncCredentialSha256: string;
  readonly textGenerationCredentialSha256: string;
}

export interface PropertyPredatorImagePolicyRequest {
  readonly operation: PropertyPredatorImageOperation;
  readonly requestSha256: string;
  readonly idempotencyKeySha256: string;
  readonly expectedBrandSha256: string;
  readonly rulesSha256: string;
  readonly promptSha256: string;
  readonly altTextSha256: string;
  readonly referenceAssetId: string | null;
  readonly referenceVersionId: string | null;
  readonly referenceSha256: string | null;
  readonly referenceRegistryVersionSha256: string | null;
  readonly referenceAuthorizationSha256: string | null;
  readonly requestBytes: number;
  readonly maximumCostMinor: number;
  readonly currency: 'USD';
  readonly size: PropertyPredatorImageSize;
  readonly quality: PropertyPredatorImageQuality;
  readonly format: PropertyPredatorImageFormat;
}

export type PropertyPredatorImagePolicyDenialReason =
  | 'generation_disabled'
  | 'provider_effects_disabled'
  | 'emergency_paused'
  | 'volume_exhausted'
  | 'spend_exhausted'
  | 'concurrency_exhausted'
  | 'idempotency_conflict'
  | 'policy_unavailable';

export type PropertyPredatorImagePolicyDecision =
  | Readonly<{ allowed: false; reasonCode: PropertyPredatorImagePolicyDenialReason }>
  | Readonly<{
      allowed: true;
      reservationId: string;
      generationEnabled: true;
      providerEffectsEnabled: true;
      emergencyPaused: false;
      availableVolumeSlots: number;
      availableConcurrencySlots: number;
      availableSpendMinor: number;
      approvedMaximumCostMinor: number;
      currency: 'USD';
    }>;

export type PropertyPredatorImageEffectState =
  | 'not_sent'
  | 'provider_effect_unknown'
  | 'confirmed_image';

export interface PropertyPredatorImagePolicyOutcome {
  readonly reservationId: string;
  readonly requestSha256: string;
  readonly idempotencyKeySha256: string;
  readonly outcome: 'proposal_accepted' | 'proposal_rejected' | 'failed_closed';
  readonly effectState: PropertyPredatorImageEffectState;
  readonly safeErrorCode: PropertyPredatorOpenAiImageErrorCode | null;
  readonly outputSha256: string | null;
  readonly proposalSha256: string | null;
  readonly usageSha256: string | null;
  readonly costEvidenceSha256: string | null;
  readonly inspectionEvidenceSha256: string | null;
  readonly providerRequestIdSha256: string | null;
  readonly actualCostMinor: number | null;
  readonly currency: 'USD';
}

/**
 * Production must reserve volume, spend and one concurrency slot atomically by
 * requestSha256 + idempotencyKeySha256. A reused key with different content
 * must be denied. A reservation remains consumed until recordOutcome releases
 * concurrency and records actual cost.
 */
export interface PropertyPredatorImagePolicy {
  reserve(request: PropertyPredatorImagePolicyRequest): Promise<PropertyPredatorImagePolicyDecision>;
  recordOutcome(outcome: PropertyPredatorImagePolicyOutcome): Promise<void>;
}

export interface PropertyPredatorOwnedReferenceRegistryRequest {
  readonly assetId: string;
  readonly versionId: string;
  readonly sha256: string;
  readonly bytesLength: number;
  readonly format: PropertyPredatorImageFormat;
  readonly mimeType: PropertyPredatorImageMimeType;
  readonly width: number;
  readonly height: number;
}

export type PropertyPredatorOwnedReferenceRegistryDecision =
  | Readonly<{ allowed: false }>
  | Readonly<{
      allowed: true;
      ownership: 'company_owned';
      reviewStatus: 'approved_image_reference';
      customerData: false;
      personalDataRemoved: true;
      containsText: false;
      containsPeople: false;
      containsLogo: false;
      containsAnimal: false;
      containsFakeUi: false;
      registryVersionSha256: string;
    }>;

export interface PropertyPredatorOwnedReferenceRegistry {
  authorizeExact(
    request: PropertyPredatorOwnedReferenceRegistryRequest,
  ): Promise<PropertyPredatorOwnedReferenceRegistryDecision>;
}

export interface PropertyPredatorImageUsage {
  readonly model: typeof MODEL;
  readonly operation: PropertyPredatorImageOperation;
  readonly size: PropertyPredatorImageSize;
  readonly quality: PropertyPredatorImageQuality;
  readonly format: PropertyPredatorImageFormat;
  readonly inputTokens: number;
  readonly inputTextTokens: number;
  readonly inputImageTokens: number;
  readonly outputTokens: number;
  readonly outputImageTokens: number;
  readonly totalTokens: number;
  readonly providerRequestIdSha256: string;
}

export interface PropertyPredatorImageCostEvidenceRequest {
  readonly usage: PropertyPredatorImageUsage;
  readonly usageSha256: string;
}

export interface PropertyPredatorImageCostEvidence {
  readonly actualCostMinor: number;
  readonly currency: 'USD';
  readonly usageSha256: string;
  readonly pricingVersionSha256: string;
  readonly evidenceSha256: string;
}

export interface PropertyPredatorImageCostEvidenceProvider {
  resolveExact(
    request: PropertyPredatorImageCostEvidenceRequest,
  ): Promise<PropertyPredatorImageCostEvidence>;
}

export interface PropertyPredatorImageInspectionRequest {
  readonly outputBytes: Uint8Array;
  readonly outputSha256: string;
  readonly mimeType: PropertyPredatorImageMimeType;
  readonly width: number;
  readonly height: number;
  readonly rulesSha256: string;
}

export interface PropertyPredatorImageInspectionEvidence {
  readonly passed: boolean;
  readonly outputSha256: string;
  readonly rulesSha256: string;
  readonly paletteWithinBrand: boolean;
  readonly noText: boolean;
  readonly noPeople: boolean;
  readonly noLogos: boolean;
  readonly noAnimals: boolean;
  readonly noFakeUi: boolean;
  readonly inspectionVersionSha256: string;
  readonly evidenceSha256: string;
}

export interface PropertyPredatorImageInspector {
  inspectExact(
    request: PropertyPredatorImageInspectionRequest,
  ): Promise<PropertyPredatorImageInspectionEvidence>;
}

export interface PropertyPredatorImageProposalMetadata {
  readonly schema: 'propertypredator.openai-image-proposal/v1';
  readonly brand: 'property-predator';
  readonly operation: PropertyPredatorImageOperation;
  readonly model: typeof MODEL;
  readonly expectedBrandSha256: string;
  readonly rulesSha256: string;
  readonly requestSha256: string;
  readonly promptSha256: string;
  readonly altTextSha256: string;
  readonly referenceAssetId: string | null;
  readonly referenceVersionId: string | null;
  readonly referenceSha256: string | null;
  readonly referenceRegistryVersionSha256: string | null;
  readonly referenceAuthorizationSha256: string | null;
  readonly outputSha256: string;
  readonly byteLength: number;
  readonly mimeType: PropertyPredatorImageMimeType;
  readonly width: number;
  readonly height: number;
  readonly size: PropertyPredatorImageSize;
  readonly quality: PropertyPredatorImageQuality;
  readonly format: PropertyPredatorImageFormat;
  readonly usageSha256: string;
  readonly costEvidenceSha256: string;
  readonly inspectionEvidenceSha256: string;
  readonly providerRequestIdSha256: string;
  readonly status: 'human_review_required';
  readonly publishable: false;
  readonly customerAttachable: false;
}

export interface PropertyPredatorImageProposal {
  readonly ok: true;
  readonly status: 'human_review_required';
  readonly allowedNextAction: 'store_immutable_review_version';
  readonly publishable: false;
  readonly customerAttachable: false;
  readonly providerEffects: false;
  readonly metadata: PropertyPredatorImageProposalMetadata;
  readonly proposalSha256: string;
  /** Immutable transport form. It is not an approved or publishable asset. */
  readonly imageBase64: string;
  readonly altTextProposal: string;
  readonly usage: PropertyPredatorImageUsage;
  readonly costEvidence: PropertyPredatorImageCostEvidence;
  readonly inspectionEvidence: PropertyPredatorImageInspectionEvidence;
}

export interface PropertyPredatorOpenAiImageTransport {
  generate(command: PropertyPredatorGenerateImageCommand): Promise<PropertyPredatorImageProposal>;
  edit(command: PropertyPredatorEditImageCommand): Promise<PropertyPredatorImageProposal>;
}

export interface PropertyPredatorOpenAiImageTransportOptions {
  readonly baseUrl: string;
  readonly credential: PropertyPredatorOpenAiImageCredential;
  readonly policy?: PropertyPredatorImagePolicy;
  readonly costEvidence: PropertyPredatorImageCostEvidenceProvider;
  readonly inspector: PropertyPredatorImageInspector;
  readonly ownedReferenceRegistry?: PropertyPredatorOwnedReferenceRegistry;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  /** Tests only. Production is pinned to https://api.openai.com. */
  readonly allowLocalHttp?: boolean;
}

export type PropertyPredatorOpenAiImageErrorCode =
  | 'invalid_configuration'
  | 'invalid_request'
  | 'effects_disabled'
  | 'emergency_paused'
  | 'volume_exhausted'
  | 'spend_exhausted'
  | 'concurrency_exhausted'
  | 'idempotency_conflict'
  | 'reference_not_authorized'
  | 'policy_unavailable'
  | 'timeout'
  | 'provider_rejected'
  | 'invalid_response'
  | 'integrity_mismatch'
  | 'cost_evidence_unavailable'
  | 'brand_rejected'
  | 'transport_failed';

const ERROR_MESSAGES: Readonly<Record<PropertyPredatorOpenAiImageErrorCode, string>> = Object.freeze({
  invalid_configuration: 'Property Predator image rail configuration is invalid',
  invalid_request: 'Property Predator image request is invalid',
  effects_disabled: 'Property Predator image provider effects are disabled',
  emergency_paused: 'Property Predator image generation is emergency-paused',
  volume_exhausted: 'Property Predator image generation volume is unavailable',
  spend_exhausted: 'Property Predator image generation spend is unavailable',
  concurrency_exhausted: 'Property Predator image generation concurrency is unavailable',
  idempotency_conflict: 'Property Predator image request identity conflicts',
  reference_not_authorized: 'Property Predator image reference is not authorized',
  policy_unavailable: 'Property Predator image policy is unavailable',
  timeout: 'Property Predator image request timed out',
  provider_rejected: 'Property Predator image provider rejected the request',
  invalid_response: 'Property Predator image provider response is invalid',
  integrity_mismatch: 'Property Predator image integrity check failed',
  cost_evidence_unavailable: 'Property Predator image cost evidence is unavailable',
  brand_rejected: 'Property Predator image failed brand inspection',
  transport_failed: 'Property Predator image request failed closed',
});

export class PropertyPredatorOpenAiImageError extends Error {
  constructor(readonly code: PropertyPredatorOpenAiImageErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'PropertyPredatorOpenAiImageError';
  }
}

function railError(code: PropertyPredatorOpenAiImageErrorCode): PropertyPredatorOpenAiImageError {
  return new PropertyPredatorOpenAiImageError(code);
}

function sha256Bytes(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonicalSha(value: unknown, code: PropertyPredatorOpenAiImageErrorCode): string {
  if (typeof value !== 'string' || !SHA256.test(value)) throw railError(code);
  return value;
}

function exactRecord(
  input: unknown,
  expectedKeys: readonly string[],
  code: PropertyPredatorOpenAiImageErrorCode,
): Readonly<Record<string, unknown>> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw railError(code);
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) throw railError(code);
  const keys = Reflect.ownKeys(input);
  if (keys.some((key) => typeof key !== 'string')) throw railError(code);
  const actual = (keys as string[]).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw railError(code);
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  for (const key of expected) {
    const descriptor = descriptors[key];
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw railError(code);
  }
  return input as Readonly<Record<string, unknown>>;
}

function safeInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  code: PropertyPredatorOpenAiImageErrorCode,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw railError(code);
  }
  return value as number;
}

function safeText(
  value: unknown,
  minimum: number,
  maximum: number,
  code: PropertyPredatorOpenAiImageErrorCode,
): string {
  if (typeof value !== 'string' || value !== value.trim() || value.length < minimum
      || value.length > maximum || UNSAFE_CONTROL.test(value)) {
    throw railError(code);
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

function assertSafeBriefText(value: string): void {
  if (EMAIL_ADDRESS.test(value) || UK_POSTCODE.test(value) || containsPhoneNumber(value)
      || PRIVATE_FIELD.test(value) || PRIVATE_LABEL.test(value) || SECRET_MARKER.test(value)
      || URL_MARKER.test(value) || MARKUP.test(value) || PROMPT_OVERRIDE.test(value)
      || BANNED_VISUAL_REQUEST.test(value)) {
    throw railError('invalid_request');
  }
}

const SIZES = new Set<PropertyPredatorImageSize>(['1024x1024', '1536x1024', '1024x1536']);
const QUALITIES = new Set<PropertyPredatorImageQuality>(['low', 'medium', 'high']);
const FORMATS = new Set<PropertyPredatorImageFormat>(['png', 'webp', 'jpeg']);

function formatMime(format: PropertyPredatorImageFormat): PropertyPredatorImageMimeType {
  if (format === 'png') return 'image/png';
  if (format === 'webp') return 'image/webp';
  return 'image/jpeg';
}

function expectedDimensions(size: PropertyPredatorImageSize): Readonly<{ width: number; height: number }> {
  const [width, height] = size.split('x').map(Number);
  return Object.freeze({ width: width!, height: height! });
}

function buildPrompt(brief: PropertyPredatorImageVisualBrief, size: PropertyPredatorImageSize): string {
  const ratio = size === '1024x1024' ? '1:1' : size === '1536x1024' ? '3:2' : '2:3';
  const prompt = [
    `Create a dark editorial conceptual illustration for Property Predator: ${brief.subject}.`,
    `Forensic scanning/data concept: ${brief.forensicConcept}.`,
    `Composition: ${brief.composition}. Intended use: ${brief.intendedUse}.`,
    'Use recognisably UK property architecture and a high-grade property-intelligence aesthetic.',
    'LOCKED PALETTE: Predator Black #050608 dominant; Predator Cyan #00E5CC as the only bright accent; restrained Ice White #EEF1F7 neutral detail only.',
    'HARD EXCLUSIONS: no text, no lettering, no logos, no wordmarks, no people or faces, no animals or mascots, no fake software UI, no purple, no royal blue, no gold, no orange glow, no cyberpunk city, no American suburban property.',
    `Exact composition ratio ${ratio}; leave useful negative space and do not add captions.`,
  ].join('\n');
  if (Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES) throw railError('invalid_request');
  return prompt;
}

interface NormalizedBase {
  readonly operation: PropertyPredatorImageOperation;
  readonly idempotencyKey: string;
  readonly idempotencyKeySha256: string;
  readonly expectedBrandSha256: string;
  readonly maximumCostMinor: number;
  readonly size: PropertyPredatorImageSize;
  readonly quality: PropertyPredatorImageQuality;
  readonly format: PropertyPredatorImageFormat;
  readonly visualBrief: PropertyPredatorImageVisualBrief;
  readonly prompt: string;
  readonly promptSha256: string;
  readonly altTextSha256: string;
  readonly requestSha256: string;
  readonly requestBytes: number;
  readonly reference: Readonly<{
    assetId: string;
    versionId: string;
    sha256: string;
    bytes: Uint8Array;
    format: PropertyPredatorImageFormat;
    mimeType: PropertyPredatorImageMimeType;
    width: number;
    height: number;
  }> | null;
}

function normalizeBrief(input: unknown): PropertyPredatorImageVisualBrief {
  const value = exactRecord(input, [
    'altText', 'composition', 'forensicConcept', 'intendedUse', 'subject',
  ], 'invalid_request');
  const subject = safeText(value.subject, 3, 300, 'invalid_request');
  const forensicConcept = safeText(value.forensicConcept, 3, 300, 'invalid_request');
  const composition = safeText(value.composition, 3, 300, 'invalid_request');
  const altText = safeText(value.altText, 3, 500, 'invalid_request');
  for (const text of [subject, forensicConcept, composition, altText]) assertSafeBriefText(text);
  const uses = new Set(['article-hero', 'social-background', 'campaign-concept', 'diagram-background']);
  if (typeof value.intendedUse !== 'string' || !uses.has(value.intendedUse)) {
    throw railError('invalid_request');
  }
  return Object.freeze({
    subject,
    forensicConcept,
    composition,
    intendedUse: value.intendedUse as PropertyPredatorImageVisualBrief['intendedUse'],
    altText,
  });
}

function canonicalBase(
  input: unknown,
  operation: PropertyPredatorImageOperation,
  hasReference: boolean,
): Omit<NormalizedBase, 'requestSha256' | 'requestBytes' | 'reference'> {
  const expectedKeys = hasReference
    ? ['expectedBrandSha256', 'format', 'idempotencyKey', 'maximumCostMinor', 'quality', 'reference', 'size', 'visualBrief']
    : ['expectedBrandSha256', 'format', 'idempotencyKey', 'maximumCostMinor', 'quality', 'size', 'visualBrief'];
  const value = exactRecord(input, expectedKeys, 'invalid_request');
  const idempotencyKey = safeText(value.idempotencyKey, 16, 200, 'invalid_request');
  if (!SAFE_IDEMPOTENCY_KEY.test(idempotencyKey) || EMAIL_ADDRESS.test(idempotencyKey)
      || UK_POSTCODE.test(idempotencyKey) || containsPhoneNumber(idempotencyKey)
      || PRIVATE_FIELD.test(idempotencyKey) || PRIVATE_LABEL.test(idempotencyKey)
      || SECRET_MARKER.test(idempotencyKey)) {
    throw railError('invalid_request');
  }
  const expectedBrandSha256 = canonicalSha(value.expectedBrandSha256, 'invalid_request');
  const maximumCostMinor = safeInteger(value.maximumCostMinor, 1, 100_000, 'invalid_request');
  if (typeof value.size !== 'string' || !SIZES.has(value.size as PropertyPredatorImageSize)
      || typeof value.quality !== 'string' || !QUALITIES.has(value.quality as PropertyPredatorImageQuality)
      || typeof value.format !== 'string' || !FORMATS.has(value.format as PropertyPredatorImageFormat)) {
    throw railError('invalid_request');
  }
  const size = value.size as PropertyPredatorImageSize;
  const visualBrief = normalizeBrief(value.visualBrief);
  const prompt = buildPrompt(visualBrief, size);
  return Object.freeze({
    operation,
    idempotencyKey,
    idempotencyKeySha256: sha256Text(idempotencyKey),
    expectedBrandSha256,
    maximumCostMinor,
    size,
    quality: value.quality as PropertyPredatorImageQuality,
    format: value.format as PropertyPredatorImageFormat,
    visualBrief,
    prompt,
    promptSha256: sha256Text(prompt),
    altTextSha256: sha256Text(visualBrief.altText),
  });
}

function readPngDimensions(bytes: Uint8Array): Readonly<{ width: number; height: number }> | null {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 24 || signature.some((value, index) => bytes[index] !== value)
      || String.fromCharCode(...bytes.slice(12, 16)) !== 'IHDR') return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Object.freeze({ width: view.getUint32(16), height: view.getUint32(20) });
}

function readJpegDimensions(bytes: Uint8Array): Readonly<{ width: number; height: number }> | null {
  if (bytes.length < 11 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const sof = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    let markerOffset = offset + 1;
    while (markerOffset < bytes.length && bytes[markerOffset] === 0xff) markerOffset += 1;
    const marker = bytes[markerOffset];
    if (marker === undefined) return null;
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset = markerOffset + 1;
      continue;
    }
    if (markerOffset + 2 >= bytes.length) return null;
    const length = (bytes[markerOffset + 1]! << 8) | bytes[markerOffset + 2]!;
    if (length < 2 || markerOffset + 1 + length > bytes.length) return null;
    if (sof.has(marker)) {
      if (length < 7 || markerOffset + 7 >= bytes.length) return null;
      return Object.freeze({
        height: (bytes[markerOffset + 4]! << 8) | bytes[markerOffset + 5]!,
        width: (bytes[markerOffset + 6]! << 8) | bytes[markerOffset + 7]!,
      });
    }
    offset = markerOffset + 1 + length;
  }
  return null;
}

function readWebpDimensions(bytes: Uint8Array): Readonly<{ width: number; height: number }> | null {
  const text = (start: number, end: number): string => String.fromCharCode(...bytes.slice(start, end));
  if (bytes.length < 30 || text(0, 4) !== 'RIFF' || text(8, 12) !== 'WEBP') return null;
  const chunk = text(12, 16);
  if (chunk === 'VP8X') {
    const width = 1 + bytes[24]! + (bytes[25]! << 8) + (bytes[26]! << 16);
    const height = 1 + bytes[27]! + (bytes[28]! << 8) + (bytes[29]! << 16);
    return Object.freeze({ width, height });
  }
  if (chunk === 'VP8L' && bytes[20] === 0x2f) {
    const width = 1 + bytes[21]! + ((bytes[22]! & 0x3f) << 8);
    const height = 1 + (bytes[22]! >> 6) + (bytes[23]! << 2) + ((bytes[24]! & 0x0f) << 10);
    return Object.freeze({ width, height });
  }
  if (chunk === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return Object.freeze({
      width: (bytes[26]! | (bytes[27]! << 8)) & 0x3fff,
      height: (bytes[28]! | (bytes[29]! << 8)) & 0x3fff,
    });
  }
  return null;
}

function inspectImageBytes(
  bytes: Uint8Array,
  format: PropertyPredatorImageFormat,
  expectedWidth?: number,
  expectedHeight?: number,
): Readonly<{ width: number; height: number; mimeType: PropertyPredatorImageMimeType }> {
  const dimensions = format === 'png' ? readPngDimensions(bytes)
    : format === 'jpeg' ? readJpegDimensions(bytes) : readWebpDimensions(bytes);
  if (!dimensions || dimensions.width < 1 || dimensions.height < 1
      || (expectedWidth !== undefined && dimensions.width !== expectedWidth)
      || (expectedHeight !== undefined && dimensions.height !== expectedHeight)) {
    throw railError('invalid_request');
  }
  return Object.freeze({ ...dimensions, mimeType: formatMime(format) });
}

function normalizeReference(input: unknown): NonNullable<NormalizedBase['reference']> {
  const value = exactRecord(input, [
    'assetId', 'bytes', 'format', 'height', 'mimeType', 'sha256', 'versionId', 'width',
  ], 'invalid_request');
  if (typeof value.assetId !== 'string' || !UUID.test(value.assetId)
      || typeof value.versionId !== 'string' || !UUID.test(value.versionId)) {
    throw railError('invalid_request');
  }
  const referenceSha256 = canonicalSha(value.sha256, 'invalid_request');
  if (!(value.bytes instanceof Uint8Array)
      || Object.getPrototypeOf(value.bytes) !== Uint8Array.prototype
      || value.bytes.byteLength < 32 || value.bytes.byteLength > MAX_REFERENCE_BYTES) {
    throw railError('invalid_request');
  }
  if (typeof value.format !== 'string' || !FORMATS.has(value.format as PropertyPredatorImageFormat)
      || typeof value.mimeType !== 'string'
      || value.mimeType !== formatMime(value.format as PropertyPredatorImageFormat)) {
    throw railError('invalid_request');
  }
  const width = safeInteger(value.width, 64, 4096, 'invalid_request');
  const height = safeInteger(value.height, 64, 4096, 'invalid_request');
  if (Math.max(width / height, height / width) > 3) throw railError('invalid_request');
  const bytes = Uint8Array.from(value.bytes);
  if (sha256Bytes(bytes) !== referenceSha256) throw railError('integrity_mismatch');
  inspectImageBytes(bytes, value.format as PropertyPredatorImageFormat, width, height);
  return Object.freeze({
    assetId: value.assetId,
    versionId: value.versionId,
    sha256: referenceSha256,
    bytes,
    format: value.format as PropertyPredatorImageFormat,
    mimeType: value.mimeType as PropertyPredatorImageMimeType,
    width,
    height,
  });
}

function normalizeCommand(input: unknown, operation: PropertyPredatorImageOperation): NormalizedBase {
  try {
    const base = canonicalBase(input, operation, operation === 'edit');
    const record = input as Readonly<Record<string, unknown>>;
    const reference = operation === 'edit' ? normalizeReference(record.reference) : null;
    const requestMetadata = Object.freeze({
      schema: 'propertypredator.openai-image-request/v1',
      operation,
      model: MODEL,
      expectedBrandSha256: base.expectedBrandSha256,
      maximumCostMinor: base.maximumCostMinor,
      currency: 'USD',
      size: base.size,
      quality: base.quality,
      format: base.format,
      promptSha256: base.promptSha256,
      altTextSha256: base.altTextSha256,
      rulesSha256: PROPERTY_PREDATOR_IMAGE_RULES_SHA256,
      referenceAssetId: reference?.assetId ?? null,
      referenceVersionId: reference?.versionId ?? null,
      referenceSha256: reference?.sha256 ?? null,
    });
    const requestBytes = Buffer.byteLength(base.prompt, 'utf8') + (reference?.bytes.byteLength ?? 0);
    if (requestBytes < 1 || requestBytes > MAX_PROMPT_BYTES + MAX_REFERENCE_BYTES) {
      throw railError('invalid_request');
    }
    return Object.freeze({
      ...base,
      reference,
      requestSha256: sha256Text(canonicalCompanyContentJson(requestMetadata)),
      requestBytes,
    });
  } catch (error) {
    if (error instanceof PropertyPredatorOpenAiImageError) throw error;
    throw railError('invalid_request');
  }
}

function cleanBaseUrl(raw: unknown, allowLocalHttp: boolean): URL {
  if (typeof raw !== 'string') throw railError('invalid_configuration');
  let url: URL;
  try { url = new URL(raw); } catch { throw railError('invalid_configuration'); }
  const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  const validProduction = url.protocol === 'https:' && url.hostname === 'api.openai.com' && !url.port;
  const validTest = allowLocalHttp && local && (url.protocol === 'http:' || url.protocol === 'https:');
  if ((!validProduction && !validTest) || url.username || url.password || url.search || url.hash
      || (url.pathname !== '' && url.pathname !== '/')) {
    throw railError('invalid_configuration');
  }
  return url;
}

function normalizeCredential(input: unknown): Readonly<{ apiKey: string }> {
  const value = exactRecord(input, [
    'apiKey', 'boundary', 'contentReadCredentialSha256', 'contentSyncCredentialSha256',
    'purpose', 'textGenerationCredentialSha256',
  ], 'invalid_configuration');
  if (value.boundary !== PROPERTY_PREDATOR_OPENAI_IMAGE_CREDENTIAL_BOUNDARY
      || value.purpose !== 'image_api_only' || typeof value.apiKey !== 'string'
      || Buffer.byteLength(value.apiKey, 'utf8') < 32 || Buffer.byteLength(value.apiKey, 'utf8') > 512
      || !VISIBLE_ASCII.test(value.apiKey)) {
    throw railError('invalid_configuration');
  }
  const otherDigests = [
    canonicalSha(value.contentReadCredentialSha256, 'invalid_configuration'),
    canonicalSha(value.contentSyncCredentialSha256, 'invalid_configuration'),
    canonicalSha(value.textGenerationCredentialSha256, 'invalid_configuration'),
  ];
  const imageDigest = sha256Text(value.apiKey);
  if (new Set([...otherDigests, imageDigest]).size !== 4) throw railError('invalid_configuration');
  return Object.freeze({ apiKey: value.apiKey });
}

function normalizeTimeout(value: unknown): number {
  return value === undefined ? 90_000 : safeInteger(value, 1_000, 120_000, 'invalid_configuration');
}

function validateService<T extends object>(
  value: unknown,
  methods: readonly (keyof T)[],
): T {
  if (!value || typeof value !== 'object') throw railError('invalid_configuration');
  for (const method of methods) {
    if (typeof (value as T)[method] !== 'function') throw railError('invalid_configuration');
  }
  return value as T;
}

function policyRequest(
  command: NormalizedBase,
  referenceRegistryVersionSha256: string | null,
  referenceAuthorizationSha256: string | null,
): PropertyPredatorImagePolicyRequest {
  return Object.freeze({
    operation: command.operation,
    requestSha256: command.requestSha256,
    idempotencyKeySha256: command.idempotencyKeySha256,
    expectedBrandSha256: command.expectedBrandSha256,
    rulesSha256: PROPERTY_PREDATOR_IMAGE_RULES_SHA256,
    promptSha256: command.promptSha256,
    altTextSha256: command.altTextSha256,
    referenceAssetId: command.reference?.assetId ?? null,
    referenceVersionId: command.reference?.versionId ?? null,
    referenceSha256: command.reference?.sha256 ?? null,
    referenceRegistryVersionSha256,
    referenceAuthorizationSha256,
    requestBytes: command.requestBytes,
    maximumCostMinor: command.maximumCostMinor,
    currency: 'USD',
    size: command.size,
    quality: command.quality,
    format: command.format,
  });
}

function normalizePolicyDecision(
  input: unknown,
  maximumCostMinor: number,
): PropertyPredatorImagePolicyDecision {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw railError('policy_unavailable');
  const allowed = Object.getOwnPropertyDescriptor(input, 'allowed');
  if (!allowed || !('value' in allowed)) throw railError('policy_unavailable');
  if (allowed.value === false) {
    const value = exactRecord(input, ['allowed', 'reasonCode'], 'policy_unavailable');
    const reasons = new Set<PropertyPredatorImagePolicyDenialReason>([
      'generation_disabled', 'provider_effects_disabled', 'emergency_paused', 'volume_exhausted',
      'spend_exhausted', 'concurrency_exhausted', 'idempotency_conflict', 'policy_unavailable',
    ]);
    if (typeof value.reasonCode !== 'string'
        || !reasons.has(value.reasonCode as PropertyPredatorImagePolicyDenialReason)) {
      throw railError('policy_unavailable');
    }
    return Object.freeze({ allowed: false, reasonCode: value.reasonCode as PropertyPredatorImagePolicyDenialReason });
  }
  const value = exactRecord(input, [
    'allowed', 'approvedMaximumCostMinor', 'availableConcurrencySlots', 'availableSpendMinor',
    'availableVolumeSlots', 'currency', 'emergencyPaused', 'generationEnabled',
    'providerEffectsEnabled', 'reservationId',
  ], 'policy_unavailable');
  if (value.allowed !== true || value.generationEnabled !== true || value.providerEffectsEnabled !== true
      || value.emergencyPaused !== false || value.currency !== 'USD'
      || typeof value.reservationId !== 'string' || !SAFE_RESERVATION_ID.test(value.reservationId)
      || safeInteger(value.availableVolumeSlots, 1, 1_000_000, 'policy_unavailable') < 1
      || safeInteger(value.availableConcurrencySlots, 1, 10_000, 'policy_unavailable') < 1
      || safeInteger(value.availableSpendMinor, maximumCostMinor, 10_000_000_000, 'policy_unavailable') < maximumCostMinor
      || value.approvedMaximumCostMinor !== maximumCostMinor) {
    throw railError('policy_unavailable');
  }
  return Object.freeze({
    allowed: true,
    reservationId: value.reservationId,
    generationEnabled: true,
    providerEffectsEnabled: true,
    emergencyPaused: false,
    availableVolumeSlots: value.availableVolumeSlots as number,
    availableConcurrencySlots: value.availableConcurrencySlots as number,
    availableSpendMinor: value.availableSpendMinor as number,
    approvedMaximumCostMinor: maximumCostMinor,
    currency: 'USD',
  });
}

function policyDenial(reason: PropertyPredatorImagePolicyDenialReason): PropertyPredatorOpenAiImageError {
  if (reason === 'emergency_paused') return railError('emergency_paused');
  if (reason === 'volume_exhausted') return railError('volume_exhausted');
  if (reason === 'spend_exhausted') return railError('spend_exhausted');
  if (reason === 'concurrency_exhausted') return railError('concurrency_exhausted');
  if (reason === 'idempotency_conflict') return railError('idempotency_conflict');
  if (reason === 'policy_unavailable') return railError('policy_unavailable');
  return railError('effects_disabled');
}

function normalizeReferenceDecision(input: unknown): PropertyPredatorOwnedReferenceRegistryDecision {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw railError('reference_not_authorized');
  const allowed = Object.getOwnPropertyDescriptor(input, 'allowed');
  if (!allowed || !('value' in allowed)) throw railError('reference_not_authorized');
  if (allowed.value === false) {
    exactRecord(input, ['allowed'], 'reference_not_authorized');
    return Object.freeze({ allowed: false });
  }
  const value = exactRecord(input, [
    'allowed', 'containsAnimal', 'containsFakeUi', 'containsLogo', 'containsPeople', 'containsText',
    'customerData', 'ownership', 'personalDataRemoved', 'registryVersionSha256', 'reviewStatus',
  ], 'reference_not_authorized');
  if (value.allowed !== true || value.ownership !== 'company_owned'
      || value.reviewStatus !== 'approved_image_reference' || value.customerData !== false
      || value.personalDataRemoved !== true || value.containsText !== false
      || value.containsPeople !== false || value.containsLogo !== false
      || value.containsAnimal !== false || value.containsFakeUi !== false) {
    throw railError('reference_not_authorized');
  }
  return Object.freeze({
    allowed: true,
    ownership: 'company_owned',
    reviewStatus: 'approved_image_reference',
    customerData: false,
    personalDataRemoved: true,
    containsText: false,
    containsPeople: false,
    containsLogo: false,
    containsAnimal: false,
    containsFakeUi: false,
    registryVersionSha256: canonicalSha(value.registryVersionSha256, 'reference_not_authorized'),
  });
}

function validJsonMediaType(raw: string | null): boolean {
  if (raw === null) return false;
  const parts = raw.split(';').map((part) => part.trim());
  const mediaType = parts.shift();
  if (!mediaType || !JSON_MEDIA_TYPE.test(mediaType)) return false;
  return parts.length === 0 || (parts.length === 1 && /^charset=utf-8$/iu.test(parts[0]!));
}

type DeadlineRace = <T>(operation: Promise<T>) => Promise<T>;

async function boundedResponseText(response: Response, beforeDeadline: DeadlineRace): Promise<string> {
  const declaredRaw = response.headers.get('content-length');
  let declared: number | null = null;
  if (declaredRaw !== null) {
    if (!/^(?:0|[1-9][0-9]{0,8})$/u.test(declaredRaw)) throw railError('invalid_response');
    declared = Number(declaredRaw);
    if (!Number.isSafeInteger(declared) || declared < 1 || declared > MAX_RESPONSE_BYTES) {
      throw railError('invalid_response');
    }
  }
  if (!response.body) throw railError('invalid_response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await beforeDeadline(reader.read());
      if (next.done) break;
      if (!(next.value instanceof Uint8Array)) throw railError('invalid_response');
      bytes += next.value.byteLength;
      if (!Number.isSafeInteger(bytes) || bytes > MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw railError('invalid_response');
      }
      chunks.push(Uint8Array.from(next.value));
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    if (error instanceof PropertyPredatorOpenAiImageError) throw error;
    throw railError('invalid_response');
  } finally {
    try { reader.releaseLock(); } catch { /* untrusted stream cannot retain the caller */ }
  }
  if (bytes === 0 || (declared !== null && declared !== bytes)) throw railError('invalid_response');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))),
    );
  } catch {
    throw railError('invalid_response');
  }
}

function parseBase64Image(value: unknown, command: NormalizedBase): Readonly<{
  imageBase64: string;
  bytes: Uint8Array;
  outputSha256: string;
  width: number;
  height: number;
  mimeType: PropertyPredatorImageMimeType;
}> {
  if (typeof value !== 'string' || value.length < 44 || value.length > MAX_RESPONSE_BYTES
      || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    throw railError('invalid_response');
  }
  const buffer = Buffer.from(value, 'base64');
  if (buffer.length < 32 || buffer.length > MAX_OUTPUT_BYTES || buffer.toString('base64') !== value) {
    throw railError('invalid_response');
  }
  const bytes = Uint8Array.from(buffer);
  const dimensions = expectedDimensions(command.size);
  let image: ReturnType<typeof inspectImageBytes>;
  try {
    image = inspectImageBytes(bytes, command.format, dimensions.width, dimensions.height);
  } catch {
    throw railError('invalid_response');
  }
  return Object.freeze({
    imageBase64: value,
    bytes,
    outputSha256: sha256Bytes(bytes),
    width: image.width,
    height: image.height,
    mimeType: image.mimeType,
  });
}

function parseUsage(
  input: unknown,
  command: NormalizedBase,
  providerRequestIdSha256: string,
): Readonly<{ usage: PropertyPredatorImageUsage; usageSha256: string }> {
  let raw: Readonly<Record<string, unknown>>;
  try {
    raw = exactRecord(input, [
      'input_tokens', 'input_tokens_details', 'output_tokens', 'output_tokens_details', 'total_tokens',
    ], 'invalid_response');
  } catch (error) {
    if (!(error instanceof PropertyPredatorOpenAiImageError)) throw error;
    raw = exactRecord(input, [
      'input_tokens', 'input_tokens_details', 'output_tokens', 'total_tokens',
    ], 'invalid_response');
  }
  const inputDetails = exactRecord(raw.input_tokens_details, ['image_tokens', 'text_tokens'], 'invalid_response');
  const inputTokens = safeInteger(raw.input_tokens, 0, 100_000_000, 'invalid_response');
  const outputTokens = safeInteger(raw.output_tokens, 0, 100_000_000, 'invalid_response');
  const totalTokens = safeInteger(raw.total_tokens, 1, 200_000_000, 'invalid_response');
  const inputTextTokens = safeInteger(inputDetails.text_tokens, 0, inputTokens, 'invalid_response');
  const inputImageTokens = safeInteger(inputDetails.image_tokens, 0, inputTokens, 'invalid_response');
  const outputDetails = raw.output_tokens_details === undefined ? null
    : exactRecord(raw.output_tokens_details, ['image_tokens', 'text_tokens'], 'invalid_response');
  const outputImageTokens = outputDetails === null ? outputTokens
    : safeInteger(outputDetails.image_tokens, 0, outputTokens, 'invalid_response');
  const outputTextTokens = outputDetails === null ? 0
    : safeInteger(outputDetails.text_tokens, 0, outputTokens, 'invalid_response');
  if (inputTextTokens + inputImageTokens !== inputTokens || outputImageTokens + outputTextTokens !== outputTokens
      || inputTokens + outputTokens !== totalTokens) throw railError('integrity_mismatch');
  const usage = Object.freeze({
    model: MODEL,
    operation: command.operation,
    size: command.size,
    quality: command.quality,
    format: command.format,
    inputTokens,
    inputTextTokens,
    inputImageTokens,
    outputTokens,
    outputImageTokens,
    totalTokens,
    providerRequestIdSha256,
  });
  return Object.freeze({ usage, usageSha256: sha256Text(canonicalCompanyContentJson(usage)) });
}

function parseProviderResponse(
  input: unknown,
  command: NormalizedBase,
  providerRequestIdSha256: string,
): Readonly<{
  imageBase64: string;
  bytes: Uint8Array;
  outputSha256: string;
  width: number;
  height: number;
  mimeType: PropertyPredatorImageMimeType;
  usage: PropertyPredatorImageUsage;
  usageSha256: string;
}> {
  const value = exactRecord(input, [
    'background', 'created', 'data', 'output_format', 'quality', 'size', 'usage',
  ], 'invalid_response');
  safeInteger(value.created, 1, Number.MAX_SAFE_INTEGER, 'invalid_response');
  if (value.background !== 'opaque' || value.output_format !== command.format
      || value.quality !== command.quality || value.size !== command.size
      || !Array.isArray(value.data) || Object.getPrototypeOf(value.data) !== Array.prototype
      || value.data.length !== 1) throw railError('integrity_mismatch');
  const imageRecord = exactRecord(value.data[0], ['b64_json'], 'invalid_response');
  const image = parseBase64Image(imageRecord.b64_json, command);
  const usage = parseUsage(value.usage, command, providerRequestIdSha256);
  return Object.freeze({ ...image, ...usage });
}

function normalizeCostEvidence(
  input: unknown,
  usageSha256: string,
  maximumCostMinor: number,
): PropertyPredatorImageCostEvidence {
  const value = exactRecord(input, [
    'actualCostMinor', 'currency', 'evidenceSha256', 'pricingVersionSha256', 'usageSha256',
  ], 'cost_evidence_unavailable');
  const evidence = Object.freeze({
    actualCostMinor: safeInteger(value.actualCostMinor, 0, maximumCostMinor, 'cost_evidence_unavailable'),
    currency: value.currency,
    usageSha256: value.usageSha256,
    pricingVersionSha256: canonicalSha(value.pricingVersionSha256, 'cost_evidence_unavailable'),
  });
  if (evidence.currency !== 'USD' || evidence.usageSha256 !== usageSha256
      || canonicalSha(value.evidenceSha256, 'cost_evidence_unavailable')
        !== sha256Text(canonicalCompanyContentJson(evidence))) {
    throw railError('cost_evidence_unavailable');
  }
  return Object.freeze({ ...evidence, currency: 'USD', usageSha256, evidenceSha256: value.evidenceSha256 as string });
}

function normalizeInspectionEvidence(
  input: unknown,
  outputSha256: string,
): PropertyPredatorImageInspectionEvidence {
  const value = exactRecord(input, [
    'evidenceSha256', 'inspectionVersionSha256', 'noAnimals', 'noFakeUi', 'noLogos',
    'noPeople', 'noText', 'outputSha256', 'paletteWithinBrand', 'passed', 'rulesSha256',
  ], 'brand_rejected');
  const evidence = Object.freeze({
    passed: value.passed,
    outputSha256: value.outputSha256,
    rulesSha256: value.rulesSha256,
    paletteWithinBrand: value.paletteWithinBrand,
    noText: value.noText,
    noPeople: value.noPeople,
    noLogos: value.noLogos,
    noAnimals: value.noAnimals,
    noFakeUi: value.noFakeUi,
    inspectionVersionSha256: canonicalSha(value.inspectionVersionSha256, 'brand_rejected'),
  });
  if (evidence.outputSha256 !== outputSha256
      || evidence.rulesSha256 !== PROPERTY_PREDATOR_IMAGE_RULES_SHA256
      || typeof evidence.passed !== 'boolean' || typeof evidence.paletteWithinBrand !== 'boolean'
      || typeof evidence.noText !== 'boolean' || typeof evidence.noPeople !== 'boolean'
      || typeof evidence.noLogos !== 'boolean' || typeof evidence.noAnimals !== 'boolean'
      || typeof evidence.noFakeUi !== 'boolean'
      || canonicalSha(value.evidenceSha256, 'brand_rejected')
        !== sha256Text(canonicalCompanyContentJson(evidence))) throw railError('brand_rejected');
  return Object.freeze({
    ...evidence,
    outputSha256,
    rulesSha256: PROPERTY_PREDATOR_IMAGE_RULES_SHA256,
    evidenceSha256: value.evidenceSha256 as string,
  }) as PropertyPredatorImageInspectionEvidence;
}

function generationBody(command: NormalizedBase): string {
  return JSON.stringify({
    model: MODEL,
    prompt: command.prompt,
    n: 1,
    background: 'opaque',
    moderation: 'auto',
    output_format: command.format,
    quality: command.quality,
    size: command.size,
    stream: false,
  });
}

function editBody(command: NormalizedBase): FormData {
  if (!command.reference) throw railError('invalid_request');
  const referenceBytes = Uint8Array.from(command.reference.bytes);
  const body = new FormData();
  body.set('model', MODEL);
  body.set('prompt', command.prompt);
  body.set('n', '1');
  body.set('background', 'opaque');
  body.set('moderation', 'auto');
  body.set('output_format', command.format);
  body.set('quality', command.quality);
  body.set('size', command.size);
  body.set('stream', 'false');
  body.set('image', new Blob([referenceBytes.buffer], { type: command.reference.mimeType }),
    `owned-reference.${command.reference.format}`);
  return body;
}

function proposal(
  command: NormalizedBase,
  image: ReturnType<typeof parseProviderResponse>,
  costEvidence: PropertyPredatorImageCostEvidence,
  inspectionEvidence: PropertyPredatorImageInspectionEvidence,
  referenceRegistryVersionSha256: string | null,
  referenceAuthorizationSha256: string | null,
): PropertyPredatorImageProposal {
  const metadata: PropertyPredatorImageProposalMetadata = Object.freeze({
    schema: 'propertypredator.openai-image-proposal/v1',
    brand: 'property-predator',
    operation: command.operation,
    model: MODEL,
    expectedBrandSha256: command.expectedBrandSha256,
    rulesSha256: PROPERTY_PREDATOR_IMAGE_RULES_SHA256,
    requestSha256: command.requestSha256,
    promptSha256: command.promptSha256,
    altTextSha256: command.altTextSha256,
    referenceAssetId: command.reference?.assetId ?? null,
    referenceVersionId: command.reference?.versionId ?? null,
    referenceSha256: command.reference?.sha256 ?? null,
    referenceRegistryVersionSha256,
    referenceAuthorizationSha256,
    outputSha256: image.outputSha256,
    byteLength: image.bytes.byteLength,
    mimeType: image.mimeType,
    width: image.width,
    height: image.height,
    size: command.size,
    quality: command.quality,
    format: command.format,
    usageSha256: image.usageSha256,
    costEvidenceSha256: costEvidence.evidenceSha256,
    inspectionEvidenceSha256: inspectionEvidence.evidenceSha256,
    providerRequestIdSha256: image.usage.providerRequestIdSha256,
    status: 'human_review_required',
    publishable: false,
    customerAttachable: false,
  });
  return Object.freeze({
    ok: true,
    status: 'human_review_required',
    allowedNextAction: 'store_immutable_review_version',
    publishable: false,
    customerAttachable: false,
    providerEffects: false,
    metadata,
    proposalSha256: sha256Text(canonicalCompanyContentJson(metadata)),
    imageBase64: image.imageBase64,
    altTextProposal: command.visualBrief.altText,
    usage: image.usage,
    costEvidence,
    inspectionEvidence,
  });
}

/**
 * A dark GPT Image 2 rail. It has no publish, scheduling, customer-attachment,
 * content-approval or provider-activation operation. A call can return only a
 * hash-bound human-review proposal after policy, accounting and pixel-level
 * brand inspection all pass.
 */
export function createPropertyPredatorOpenAiImageTransport(
  options: PropertyPredatorOpenAiImageTransportOptions,
): PropertyPredatorOpenAiImageTransport {
  let baseUrl: URL;
  let credential: Readonly<{ apiKey: string }>;
  let timeoutMs: number;
  let costEvidence: PropertyPredatorImageCostEvidenceProvider;
  let inspector: PropertyPredatorImageInspector;
  let fetchImpl: typeof fetch;
  try {
    baseUrl = cleanBaseUrl(options.baseUrl, options.allowLocalHttp === true);
    credential = normalizeCredential(options.credential);
    timeoutMs = normalizeTimeout(options.timeoutMs);
    costEvidence = validateService<PropertyPredatorImageCostEvidenceProvider>(
      options.costEvidence, ['resolveExact'],
    );
    inspector = validateService<PropertyPredatorImageInspector>(options.inspector, ['inspectExact']);
    fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') throw railError('invalid_configuration');
  } catch (error) {
    if (error instanceof PropertyPredatorOpenAiImageError) throw error;
    throw railError('invalid_configuration');
  }
  const policy = options.policy;
  if (policy !== undefined) validateService<PropertyPredatorImagePolicy>(policy, ['reserve', 'recordOutcome']);
  const registry = options.ownedReferenceRegistry;
  if (registry !== undefined) validateService<PropertyPredatorOwnedReferenceRegistry>(registry, ['authorizeExact']);

  const execute = async (
    rawCommand: PropertyPredatorGenerateImageCommand | PropertyPredatorEditImageCommand,
    operation: PropertyPredatorImageOperation,
  ): Promise<PropertyPredatorImageProposal> => {
    const command = normalizeCommand(rawCommand, operation);
    if (!policy) throw railError('effects_disabled');
    const controller = new AbortController();
    let rejectDeadline: ((error: PropertyPredatorOpenAiImageError) => void) | undefined;
    const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
    const timer = setTimeout(() => {
      controller.abort();
      rejectDeadline?.(railError('timeout'));
    }, timeoutMs);
    const beforeDeadline: DeadlineRace = async <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, deadline]);
    let reservationId: string | null = null;
    let effectState: PropertyPredatorImageEffectState = 'not_sent';
    let outcomeRecorded = false;
    let parsedImage: ReturnType<typeof parseProviderResponse> | null = null;
    let resolvedCost: PropertyPredatorImageCostEvidence | null = null;
    let inspection: PropertyPredatorImageInspectionEvidence | null = null;
    let referenceRegistryVersionSha256: string | null = null;
    let referenceAuthorizationSha256: string | null = null;
    try {
      if (operation === 'edit') {
        if (!registry || !command.reference) throw railError('reference_not_authorized');
        let decision: PropertyPredatorOwnedReferenceRegistryDecision;
        try {
          decision = normalizeReferenceDecision(await beforeDeadline(registry.authorizeExact(Object.freeze({
            assetId: command.reference.assetId,
            versionId: command.reference.versionId,
            sha256: command.reference.sha256,
            bytesLength: command.reference.bytes.byteLength,
            format: command.reference.format,
            mimeType: command.reference.mimeType,
            width: command.reference.width,
            height: command.reference.height,
          }))));
        } catch (error) {
          if (error instanceof PropertyPredatorOpenAiImageError) throw error;
          throw railError('reference_not_authorized');
        }
        if (!decision.allowed) throw railError('reference_not_authorized');
        referenceRegistryVersionSha256 = decision.registryVersionSha256;
        referenceAuthorizationSha256 = sha256Text(canonicalCompanyContentJson(decision));
      }

      let decision: PropertyPredatorImagePolicyDecision;
      try {
        decision = normalizePolicyDecision(
          await beforeDeadline(policy.reserve(policyRequest(
            command,
            referenceRegistryVersionSha256,
            referenceAuthorizationSha256,
          ))),
          command.maximumCostMinor,
        );
      } catch (error) {
        if (error instanceof PropertyPredatorOpenAiImageError) throw error;
        throw railError('policy_unavailable');
      }
      if (!decision.allowed) throw policyDenial(decision.reasonCode);
      reservationId = decision.reservationId;

      const endpoint = new URL(operation === 'generate' ? GENERATE_PATH : EDIT_PATH, baseUrl).href;
      const headers: Record<string, string> = {
        accept: 'application/json',
        authorization: `Bearer ${credential.apiKey}`,
        'idempotency-key': command.idempotencyKey,
      };
      let body: string | FormData;
      if (operation === 'generate') {
        body = generationBody(command);
        if (Buffer.byteLength(body, 'utf8') > MAX_PROMPT_BYTES * 2) throw railError('invalid_request');
        headers['content-type'] = 'application/json; charset=utf-8';
      } else {
        body = editBody(command);
      }
      effectState = 'provider_effect_unknown';
      let response: Response;
      try {
        response = await beforeDeadline(fetchImpl(endpoint, {
          method: 'POST',
          headers,
          body,
          cache: 'no-store',
          credentials: 'omit',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
          signal: controller.signal,
        }));
      } catch (error) {
        if (error instanceof PropertyPredatorOpenAiImageError) throw error;
        throw railError('transport_failed');
      }
      if (!(response instanceof Response) || response.redirected) throw railError('invalid_response');
      if (response.status !== 200) throw railError('provider_rejected');
      if (!validJsonMediaType(response.headers.get('content-type'))) throw railError('invalid_response');
      const providerRequestId = response.headers.get('x-request-id');
      if (!providerRequestId || !SAFE_PROVIDER_REQUEST_ID.test(providerRequestId)) {
        throw railError('invalid_response');
      }
      const raw = await boundedResponseText(response, beforeDeadline);
      let parsed: unknown;
      try { parsed = JSON.parse(raw) as unknown; } catch { throw railError('invalid_response'); }
      parsedImage = parseProviderResponse(parsed, command, sha256Text(providerRequestId));
      effectState = 'confirmed_image';

      try {
        resolvedCost = normalizeCostEvidence(
          await beforeDeadline(costEvidence.resolveExact(Object.freeze({
            usage: parsedImage.usage,
            usageSha256: parsedImage.usageSha256,
          }))),
          parsedImage.usageSha256,
          command.maximumCostMinor,
        );
      } catch (error) {
        if (error instanceof PropertyPredatorOpenAiImageError) throw error;
        throw railError('cost_evidence_unavailable');
      }

      try {
        inspection = normalizeInspectionEvidence(
          await beforeDeadline(inspector.inspectExact(Object.freeze({
            outputBytes: Uint8Array.from(parsedImage.bytes),
            outputSha256: parsedImage.outputSha256,
            mimeType: parsedImage.mimeType,
            width: parsedImage.width,
            height: parsedImage.height,
            rulesSha256: PROPERTY_PREDATOR_IMAGE_RULES_SHA256,
          }))),
          parsedImage.outputSha256,
        );
        if (inspection.passed !== true || inspection.paletteWithinBrand !== true
            || inspection.noText !== true || inspection.noPeople !== true
            || inspection.noLogos !== true || inspection.noAnimals !== true
            || inspection.noFakeUi !== true) {
          throw railError('brand_rejected');
        }
      } catch (error) {
        if (error instanceof PropertyPredatorOpenAiImageError) throw error;
        throw railError('brand_rejected');
      }

      const result = proposal(
        command,
        parsedImage,
        resolvedCost,
        inspection,
        referenceRegistryVersionSha256,
        referenceAuthorizationSha256,
      );
      try {
        await beforeDeadline(policy.recordOutcome(Object.freeze({
          reservationId,
          requestSha256: command.requestSha256,
          idempotencyKeySha256: command.idempotencyKeySha256,
          outcome: 'proposal_accepted',
          effectState,
          safeErrorCode: null,
          outputSha256: parsedImage.outputSha256,
          proposalSha256: result.proposalSha256,
          usageSha256: parsedImage.usageSha256,
          costEvidenceSha256: resolvedCost.evidenceSha256,
          inspectionEvidenceSha256: inspection.evidenceSha256,
          providerRequestIdSha256: parsedImage.usage.providerRequestIdSha256,
          actualCostMinor: resolvedCost.actualCostMinor,
          currency: 'USD',
        })));
        outcomeRecorded = true;
      } catch {
        throw railError('policy_unavailable');
      }
      return result;
    } catch (error) {
      const safeError = error instanceof PropertyPredatorOpenAiImageError
        ? error : railError('transport_failed');
      if (reservationId !== null && !outcomeRecorded) {
        const rejected = safeError.code === 'brand_rejected';
        try {
          await beforeDeadline(policy.recordOutcome(Object.freeze({
            reservationId,
            requestSha256: command.requestSha256,
            idempotencyKeySha256: command.idempotencyKeySha256,
            outcome: rejected ? 'proposal_rejected' : 'failed_closed',
            effectState,
            safeErrorCode: safeError.code,
            outputSha256: parsedImage?.outputSha256 ?? null,
            proposalSha256: null,
            usageSha256: parsedImage?.usageSha256 ?? null,
            costEvidenceSha256: resolvedCost?.evidenceSha256 ?? null,
            inspectionEvidenceSha256: inspection?.evidenceSha256 ?? null,
            providerRequestIdSha256: parsedImage?.usage.providerRequestIdSha256 ?? null,
            actualCostMinor: resolvedCost?.actualCostMinor ?? null,
            currency: 'USD',
          })));
        } catch {
          // Reservation remains conservatively consumed for reconciliation.
        }
      }
      throw safeError;
    } finally {
      clearTimeout(timer);
    }
  };

  return Object.freeze({
    generate: async (command: PropertyPredatorGenerateImageCommand) => execute(command, 'generate'),
    edit: async (command: PropertyPredatorEditImageCommand) => execute(command, 'edit'),
  });
}
