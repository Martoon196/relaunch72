import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { ProviderOperationContext } from '../providers/contracts.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const META_ID = /^[1-9][0-9]{4,29}$/u;
const GRAPH_VERSION = /^v(?:2[0-9]|[3-9][0-9])\.[0-9]+$/u;
const VERSION = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SECRET = /^[\x21-\x7e]{20,2000}$/u;
const SIGNATURE = /^sha256=([a-f0-9]{64})$/u;
const SAFE_KEY = /^[\x21-\x7e]{1,200}$/u;
const MAX_WEBHOOK_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 65_536;

export const META_WHATSAPP_PROVIDER_ID = 'meta_whatsapp_cloud' as const;
export const META_SOCIAL_DM_PROVIDER_ID = 'meta_social_dm' as const;
export const META_COMMUNICATIONS_CONTRACT_VERSION = 'r72-meta-communications/v1' as const;

export type MetaSocialDmNetwork = 'facebook' | 'instagram';
export type MetaOutboundChannel = 'whatsapp' | MetaSocialDmNetwork;

export class MetaCommunicationsContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MetaCommunicationsContractError';
  }
}

export class MetaProviderEffectsDisabledError extends MetaCommunicationsContractError {
  constructor() {
    super('Meta provider effects are disabled');
    this.name = 'MetaProviderEffectsDisabledError';
  }
}

export class MetaIdempotencyConflictError extends MetaCommunicationsContractError {
  constructor() {
    super('Meta operation identity was reused with different immutable input');
    this.name = 'MetaIdempotencyConflictError';
  }
}

function fail(message: string): never {
  throw new MetaCommunicationsContractError(message);
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

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} has unexpected fields`);
  }
}

export function metaUuid(value: unknown, label: string): string {
  if (typeof value !== 'string') fail(`${label} is invalid`);
  const normalized = value.trim().toLowerCase();
  if (!UUID.test(normalized)) fail(`${label} is invalid`);
  return normalized;
}

export function metaPlatformId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !META_ID.test(value)) fail(`${label} is invalid`);
  return value;
}

export function metaSha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) fail(`${label} is invalid`);
  return value;
}

export function metaTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string') fail(`${label} is invalid`);
  const parsed = new Date(value);
  if (!Number.isFinite(Date.prototype.getTime.call(parsed))
      || Date.prototype.toISOString.call(parsed) !== value) fail(`${label} must be a canonical UTC timestamp`);
  return value;
}

export function metaCanonicalSha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

interface CredentialSecrets {
  readonly accessToken: string;
  readonly appSecret: string;
  readonly verifyToken: string;
}

export interface MetaWhatsAppCredentialBundle {
  readonly kind: 'meta_whatsapp_credentials';
  readonly workspaceId: string;
  readonly connectionId: string;
  readonly appId: string;
  readonly wabaId: string;
  readonly phoneNumberId: string;
  readonly graphApiVersion: string;
  readonly credentialVersion: string;
  readonly bindingSha256: string;
}

export interface MetaSocialDmCredentialBundle {
  readonly kind: 'meta_social_dm_credentials';
  readonly workspaceId: string;
  readonly connectionId: string;
  readonly network: MetaSocialDmNetwork;
  readonly appId: string;
  readonly pageId: string;
  readonly instagramAccountId: string | null;
  readonly graphApiVersion: string;
  readonly credentialVersion: string;
  readonly bindingSha256: string;
}

export interface CreateMetaWhatsAppCredentialBundleInput {
  readonly workspaceId: string;
  readonly connectionId: string;
  readonly appId: string;
  readonly wabaId: string;
  readonly phoneNumberId: string;
  readonly graphApiVersion: string;
  readonly credentialVersion: string;
  readonly accessToken: string;
  readonly appSecret: string;
  readonly verifyToken: string;
}

export interface CreateMetaSocialDmCredentialBundleInput {
  readonly workspaceId: string;
  readonly connectionId: string;
  readonly network: MetaSocialDmNetwork;
  readonly appId: string;
  readonly pageId: string;
  readonly instagramAccountId: string | null;
  readonly graphApiVersion: string;
  readonly credentialVersion: string;
  readonly accessToken: string;
  readonly appSecret: string;
  readonly verifyToken: string;
}

const CREDENTIALS = new WeakMap<object, CredentialSecrets>();

function graphVersion(value: unknown): string {
  if (typeof value !== 'string' || !GRAPH_VERSION.test(value)) fail('credentials.graphApiVersion is invalid');
  return value;
}

function credentialVersion(value: unknown): string {
  if (typeof value !== 'string' || !VERSION.test(value)) fail('credentials.credentialVersion is invalid');
  return value;
}

function secret(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SECRET.test(value)) fail(`${label} is invalid`);
  return value;
}

function attachSecrets<T extends object>(bundle: T, input: Readonly<{
  accessToken: unknown; appSecret: unknown; verifyToken: unknown;
}>): T {
  CREDENTIALS.set(bundle, Object.freeze({
    accessToken: secret(input.accessToken, 'credential secret'),
    appSecret: secret(input.appSecret, 'credential secret'),
    verifyToken: secret(input.verifyToken, 'credential secret'),
  }));
  return bundle;
}

export function createMetaWhatsAppCredentialBundle(
  input: CreateMetaWhatsAppCredentialBundleInput,
): MetaWhatsAppCredentialBundle {
  const source = plainRecord(input, 'WhatsApp credential bundle');
  exactKeys(source, [
    'workspaceId', 'connectionId', 'appId', 'wabaId', 'phoneNumberId', 'graphApiVersion',
    'credentialVersion', 'accessToken', 'appSecret', 'verifyToken',
  ], 'WhatsApp credential bundle');
  const safe = {
    kind: 'meta_whatsapp_credentials' as const,
    workspaceId: metaUuid(source.workspaceId, 'credentials.workspaceId'),
    connectionId: metaUuid(source.connectionId, 'credentials.connectionId'),
    appId: metaPlatformId(source.appId, 'credentials.appId'),
    wabaId: metaPlatformId(source.wabaId, 'credentials.wabaId'),
    phoneNumberId: metaPlatformId(source.phoneNumberId, 'credentials.phoneNumberId'),
    graphApiVersion: graphVersion(source.graphApiVersion),
    credentialVersion: credentialVersion(source.credentialVersion),
  };
  const bindingSha256 = metaCanonicalSha256({
    contract: META_COMMUNICATIONS_CONTRACT_VERSION,
    ...safe,
  });
  const bundle = Object.freeze({
    ...safe,
    bindingSha256,
    toJSON: () => Object.freeze({ ...safe, bindingSha256, secrets: '[REDACTED]' }),
  });
  return attachSecrets(bundle, {
    accessToken: source.accessToken, appSecret: source.appSecret, verifyToken: source.verifyToken,
  }) as MetaWhatsAppCredentialBundle;
}

export function createMetaSocialDmCredentialBundle(
  input: CreateMetaSocialDmCredentialBundleInput,
): MetaSocialDmCredentialBundle {
  const source = plainRecord(input, 'social DM credential bundle');
  exactKeys(source, [
    'workspaceId', 'connectionId', 'network', 'appId', 'pageId', 'instagramAccountId',
    'graphApiVersion', 'credentialVersion', 'accessToken', 'appSecret', 'verifyToken',
  ], 'social DM credential bundle');
  if (source.network !== 'facebook' && source.network !== 'instagram') fail('credentials.network is invalid');
  const instagramAccountId = source.instagramAccountId === null
    ? null : metaPlatformId(source.instagramAccountId, 'credentials.instagramAccountId');
  if ((source.network === 'instagram') !== (instagramAccountId !== null)) {
    fail('Instagram credentials require exactly one professional-account binding');
  }
  const safe = {
    kind: 'meta_social_dm_credentials' as const,
    workspaceId: metaUuid(source.workspaceId, 'credentials.workspaceId'),
    connectionId: metaUuid(source.connectionId, 'credentials.connectionId'),
    network: source.network as MetaSocialDmNetwork,
    appId: metaPlatformId(source.appId, 'credentials.appId'),
    pageId: metaPlatformId(source.pageId, 'credentials.pageId'),
    instagramAccountId,
    graphApiVersion: graphVersion(source.graphApiVersion),
    credentialVersion: credentialVersion(source.credentialVersion),
  };
  const bindingSha256 = metaCanonicalSha256({
    contract: META_COMMUNICATIONS_CONTRACT_VERSION,
    ...safe,
  });
  const bundle = Object.freeze({
    ...safe,
    bindingSha256,
    toJSON: () => Object.freeze({ ...safe, bindingSha256, secrets: '[REDACTED]' }),
  });
  return attachSecrets(bundle, {
    accessToken: source.accessToken, appSecret: source.appSecret, verifyToken: source.verifyToken,
  }) as MetaSocialDmCredentialBundle;
}

function credentialSecrets(bundle: MetaWhatsAppCredentialBundle | MetaSocialDmCredentialBundle): CredentialSecrets {
  const found = CREDENTIALS.get(bundle as object);
  if (!found) fail('Meta credential bundle is not authentic');
  return found;
}

export function verifyMetaWebhookChallenge(
  bundle: MetaWhatsAppCredentialBundle | MetaSocialDmCredentialBundle,
  query: Readonly<{ hubMode: unknown; hubVerifyToken: unknown; hubChallenge: unknown }>,
): Readonly<{ status: 200 | 400 | 403; body: string }> {
  const mode = query.hubMode;
  const suppliedToken = query.hubVerifyToken;
  const challenge = query.hubChallenge;
  if (mode !== 'subscribe' || typeof suppliedToken !== 'string'
      || typeof challenge !== 'string' || !/^[\x21-\x7e]{1,200}$/u.test(challenge)) {
    return Object.freeze({ status: 400, body: '' });
  }
  const expectedToken = credentialSecrets(bundle).verifyToken;
  const supplied = Buffer.from(suppliedToken, 'utf8');
  const expected = Buffer.from(expectedToken, 'utf8');
  if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected)) {
    return Object.freeze({ status: 403, body: '' });
  }
  return Object.freeze({ status: 200, body: challenge });
}

export function verifyMetaSignedJson(
  bundle: MetaWhatsAppCredentialBundle | MetaSocialDmCredentialBundle,
  input: Readonly<{ rawBody: Uint8Array; xHubSignature256: unknown; contentType: unknown }>,
): unknown {
  const candidate = input.rawBody;
  if (!(candidate instanceof Uint8Array)) fail('webhook body is invalid');
  const rawBody = Uint8Array.from(candidate);
  if (rawBody.byteLength < 2 || rawBody.byteLength > MAX_WEBHOOK_BYTES) fail('webhook body is invalid');
  const signatureValue = input.xHubSignature256;
  const contentType = input.contentType;
  if (typeof contentType !== 'string'
      || contentType.toLowerCase().split(';', 1)[0]?.trim() !== 'application/json') {
    fail('webhook media type is invalid');
  }
  const match = typeof signatureValue === 'string' ? SIGNATURE.exec(signatureValue) : null;
  if (!match) fail('webhook signature is invalid');
  const expected = createHmac('sha256', credentialSecrets(bundle).appSecret).update(rawBody).digest();
  const supplied = Buffer.from(match[1]!, 'hex');
  if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected)) {
    fail('webhook signature is invalid');
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBody)) as unknown;
  } catch {
    fail('webhook body is not strict UTF-8 JSON');
  }
}

export interface MetaOutboundEvidenceInput {
  readonly workspaceId: string;
  readonly connectionId: string;
  readonly channel: MetaOutboundChannel;
  readonly recipientSha256: string;
  readonly messageVersionId: string;
  readonly messageVersionNumber: number;
  readonly bodySha256: string;
  readonly approvalDecisionId: string;
  readonly approvalDecision: 'approved';
  readonly approvalVersionId: string;
  readonly consentEvidenceId: string;
  readonly consentDecision: 'eligible';
  readonly consentValidUntil: string;
  readonly pecrDecisionId: string;
  readonly pecrDecision: 'eligible';
  readonly pecrValidUntil: string;
  readonly instigatorDecisionId: string;
  readonly instigatorDecision: 'eligible';
  readonly instigatorType: 'human_operator' | 'customer_inbound';
  readonly evaluatedAt: string;
}

export interface MetaOutboundEvidence extends MetaOutboundEvidenceInput {
  readonly evidenceSha256: string;
}

export function createMetaOutboundEvidence(input: MetaOutboundEvidenceInput): MetaOutboundEvidence {
  const source = plainRecord(input, 'Meta outbound evidence');
  exactKeys(source, [
    'workspaceId', 'connectionId', 'channel', 'recipientSha256', 'messageVersionId',
    'messageVersionNumber', 'bodySha256', 'approvalDecisionId', 'approvalDecision',
    'approvalVersionId', 'consentEvidenceId', 'consentDecision', 'consentValidUntil',
    'pecrDecisionId', 'pecrDecision', 'pecrValidUntil', 'instigatorDecisionId',
    'instigatorDecision', 'instigatorType', 'evaluatedAt',
  ], 'Meta outbound evidence');
  if (!['whatsapp', 'facebook', 'instagram'].includes(String(source.channel))) fail('evidence channel is invalid');
  if (!Number.isSafeInteger(source.messageVersionNumber) || (source.messageVersionNumber as number) < 1
      || (source.messageVersionNumber as number) > 1_000_000
      || source.approvalDecision !== 'approved' || source.consentDecision !== 'eligible'
      || source.pecrDecision !== 'eligible' || source.instigatorDecision !== 'eligible'
      || (source.instigatorType !== 'human_operator' && source.instigatorType !== 'customer_inbound')) {
    fail('Meta outbound decision evidence is invalid');
  }
  const exact = {
    workspaceId: metaUuid(source.workspaceId, 'evidence.workspaceId'),
    connectionId: metaUuid(source.connectionId, 'evidence.connectionId'),
    channel: source.channel as MetaOutboundChannel,
    recipientSha256: metaSha256(source.recipientSha256, 'evidence.recipientSha256'),
    messageVersionId: metaUuid(source.messageVersionId, 'evidence.messageVersionId'),
    messageVersionNumber: source.messageVersionNumber as number,
    bodySha256: metaSha256(source.bodySha256, 'evidence.bodySha256'),
    approvalDecisionId: metaUuid(source.approvalDecisionId, 'evidence.approvalDecisionId'),
    approvalDecision: 'approved' as const,
    approvalVersionId: metaUuid(source.approvalVersionId, 'evidence.approvalVersionId'),
    consentEvidenceId: metaUuid(source.consentEvidenceId, 'evidence.consentEvidenceId'),
    consentDecision: 'eligible' as const,
    consentValidUntil: metaTimestamp(source.consentValidUntil, 'evidence.consentValidUntil'),
    pecrDecisionId: metaUuid(source.pecrDecisionId, 'evidence.pecrDecisionId'),
    pecrDecision: 'eligible' as const,
    pecrValidUntil: metaTimestamp(source.pecrValidUntil, 'evidence.pecrValidUntil'),
    instigatorDecisionId: metaUuid(source.instigatorDecisionId, 'evidence.instigatorDecisionId'),
    instigatorDecision: 'eligible' as const,
    instigatorType: source.instigatorType as 'human_operator' | 'customer_inbound',
    evaluatedAt: metaTimestamp(source.evaluatedAt, 'evidence.evaluatedAt'),
  };
  if (Date.parse(exact.consentValidUntil) < Date.parse(exact.evaluatedAt)
      || Date.parse(exact.pecrValidUntil) < Date.parse(exact.evaluatedAt)) {
    fail('Meta outbound decision evidence expires before its evaluation');
  }
  if (exact.approvalVersionId !== exact.messageVersionId) fail('approval is not bound to the message version');
  return Object.freeze({ ...exact, evidenceSha256: metaCanonicalSha256(exact) });
}

export interface MetaOutboundControlEvidenceInput {
  readonly workspaceId: string;
  readonly connectionId: string;
  readonly policyVersionId: string;
  readonly emergencyPaused: boolean;
  readonly providerEffects: false;
  readonly evaluatedAt: string;
  readonly validUntil: string;
  readonly rateLimit: number;
  readonly rateUsed: number;
  readonly volumeLimit: number;
  readonly volumeUsed: number;
  readonly spendCurrency: 'GBP';
  readonly spendLimitMinor: number;
  readonly spendUsedMinor: number;
  readonly estimatedSpendMinor: number;
}

export interface MetaOutboundControlEvidence extends MetaOutboundControlEvidenceInput {
  readonly controlSha256: string;
}

export function createMetaOutboundControlEvidence(
  input: MetaOutboundControlEvidenceInput,
): MetaOutboundControlEvidence {
  const source = plainRecord(input, 'Meta outbound controls');
  exactKeys(source, [
    'workspaceId', 'connectionId', 'policyVersionId', 'emergencyPaused', 'providerEffects',
    'evaluatedAt', 'validUntil', 'rateLimit', 'rateUsed', 'volumeLimit', 'volumeUsed',
    'spendCurrency', 'spendLimitMinor', 'spendUsedMinor', 'estimatedSpendMinor',
  ], 'Meta outbound controls');
  const integers = ['rateLimit', 'rateUsed', 'volumeLimit', 'volumeUsed',
    'spendLimitMinor', 'spendUsedMinor', 'estimatedSpendMinor'] as const;
  for (const key of integers) {
    if (!Number.isSafeInteger(source[key]) || (source[key] as number) < 0) fail(`controls.${key} is invalid`);
  }
  if ((source.rateLimit as number) < 1 || (source.volumeLimit as number) < 1
      || source.providerEffects !== false || typeof source.emergencyPaused !== 'boolean'
      || source.spendCurrency !== 'GBP') fail('Meta outbound controls are invalid');
  const exact = {
    workspaceId: metaUuid(source.workspaceId, 'controls.workspaceId'),
    connectionId: metaUuid(source.connectionId, 'controls.connectionId'),
    policyVersionId: metaUuid(source.policyVersionId, 'controls.policyVersionId'),
    emergencyPaused: source.emergencyPaused as boolean,
    providerEffects: false as const,
    evaluatedAt: metaTimestamp(source.evaluatedAt, 'controls.evaluatedAt'),
    validUntil: metaTimestamp(source.validUntil, 'controls.validUntil'),
    rateLimit: source.rateLimit as number,
    rateUsed: source.rateUsed as number,
    volumeLimit: source.volumeLimit as number,
    volumeUsed: source.volumeUsed as number,
    spendCurrency: 'GBP' as const,
    spendLimitMinor: source.spendLimitMinor as number,
    spendUsedMinor: source.spendUsedMinor as number,
    estimatedSpendMinor: source.estimatedSpendMinor as number,
  };
  if (Date.parse(exact.validUntil) < Date.parse(exact.evaluatedAt)) {
    fail('Meta outbound controls expire before their evaluation');
  }
  return Object.freeze({ ...exact, controlSha256: metaCanonicalSha256(exact) });
}

export function createDefaultMetaDarkControls(input: Readonly<{
  workspaceId: string; connectionId: string; policyVersionId: string; at: string;
}>): MetaOutboundControlEvidence {
  return createMetaOutboundControlEvidence({
    workspaceId: input.workspaceId, connectionId: input.connectionId,
    policyVersionId: input.policyVersionId, emergencyPaused: true, providerEffects: false,
    evaluatedAt: input.at, validUntil: input.at,
    rateLimit: 1, rateUsed: 1, volumeLimit: 1, volumeUsed: 1,
    spendCurrency: 'GBP', spendLimitMinor: 0, spendUsedMinor: 0, estimatedSpendMinor: 0,
  });
}

export function assertMetaOutboundPreconditions(input: Readonly<{
  context: ProviderOperationContext;
  providerId: typeof META_WHATSAPP_PROVIDER_ID | typeof META_SOCIAL_DM_PROVIDER_ID;
  channel: MetaOutboundChannel;
  recipientSha256: string;
  bodySha256: string;
  evidence: MetaOutboundEvidence;
  controls: MetaOutboundControlEvidence;
  observedAt: string;
}>): void {
  const context = input.context;
  const workspaceId = metaUuid(context.workspaceId, 'context.workspaceId');
  const connectionId = metaUuid(context.connectionId, 'context.connectionId');
  metaUuid(context.operationId, 'context.operationId');
  metaUuid(context.correlationId, 'context.correlationId');
  if (context.providerId !== input.providerId || typeof context.idempotencyKey !== 'string'
      || !SAFE_KEY.test(context.idempotencyKey)) fail('Meta provider context is invalid');
  const at = Date.parse(metaTimestamp(input.observedAt, 'observedAt'));
  const { evidenceSha256: suppliedEvidenceSha256, ...evidenceInput } = input.evidence;
  const { controlSha256: suppliedControlSha256, ...controlInput } = input.controls;
  const evidence = createMetaOutboundEvidence(evidenceInput);
  const controls = createMetaOutboundControlEvidence(controlInput);
  if (evidence.evidenceSha256 !== suppliedEvidenceSha256
      || controls.controlSha256 !== suppliedControlSha256
      || evidence.workspaceId !== workspaceId || controls.workspaceId !== workspaceId
      || evidence.connectionId !== connectionId || controls.connectionId !== connectionId
      || evidence.channel !== input.channel || evidence.recipientSha256 !== input.recipientSha256
      || evidence.bodySha256 !== input.bodySha256) fail('Meta evidence is not bound to the outbound plan');
  if (Date.parse(evidence.evaluatedAt) > at + 300_000
      || Date.parse(controls.evaluatedAt) > at + 300_000
      || Date.parse(evidence.consentValidUntil) < at || Date.parse(evidence.pecrValidUntil) < at
      || Date.parse(controls.validUntil) < at) fail('Meta outbound evidence is not current');
  if (controls.emergencyPaused) fail('Meta emergency pause is engaged');
  if (controls.providerEffects !== false) fail('Meta provider-effects evidence is invalid');
  if (controls.rateUsed + 1 > controls.rateLimit) fail('Meta rate gate is exhausted');
  if (controls.volumeUsed + 1 > controls.volumeLimit) fail('Meta volume gate is exhausted');
  if (controls.spendUsedMinor + controls.estimatedSpendMinor > controls.spendLimitMinor) {
    fail('Meta spend gate is exhausted');
  }
}

export interface MetaHttpRequest {
  readonly method: 'POST';
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly bodyUtf8: string;
  readonly timeoutMs: number;
  readonly redirectPolicy: 'error';
  readonly maximumResponseBytes: typeof MAX_RESPONSE_BYTES;
}

export interface MetaHttpResponse {
  readonly status: number;
  readonly bodyUtf8: string;
}

export type MetaScriptedHttpStep = Readonly<{
  readonly kind: 'response'; readonly status: number; readonly bodyUtf8: string;
}> | Readonly<{
  readonly kind: 'transport_error'; readonly code: 'aborted' | 'connection_reset' | 'timeout';
}>;

export interface MetaContractHttpTransport { readonly kind: 'meta_contract_mock' }

interface TransportState {
  readonly remaining: MetaScriptedHttpStep[];
  readonly requests: MetaHttpRequest[];
}

const TRANSPORTS = new WeakMap<object, TransportState>();

export function createMetaScriptedHttpTransport(script: readonly MetaScriptedHttpStep[]): MetaContractHttpTransport {
  if (!Array.isArray(script) || script.length > 100) fail('Meta HTTP script is invalid');
  const remaining = script.map((step, index): MetaScriptedHttpStep => {
    const source = plainRecord(step, `Meta HTTP script step ${index}`);
    if (source.kind === 'transport_error') {
      exactKeys(source, ['kind', 'code'], `Meta HTTP script step ${index}`);
      if (!['aborted', 'connection_reset', 'timeout'].includes(String(source.code))) fail('Meta HTTP script is invalid');
      return Object.freeze({ kind: 'transport_error', code: source.code as 'aborted' | 'connection_reset' | 'timeout' });
    }
    exactKeys(source, ['kind', 'status', 'bodyUtf8'], `Meta HTTP script step ${index}`);
    if (source.kind !== 'response' || !Number.isSafeInteger(source.status)
        || (source.status as number) < 100 || (source.status as number) > 599
        || typeof source.bodyUtf8 !== 'string'
        || Buffer.byteLength(source.bodyUtf8, 'utf8') > MAX_RESPONSE_BYTES) fail('Meta HTTP script is invalid');
    return Object.freeze({ kind: 'response', status: source.status as number, bodyUtf8: source.bodyUtf8 });
  });
  const transport = Object.freeze({ kind: 'meta_contract_mock' as const });
  TRANSPORTS.set(transport, { remaining, requests: [] });
  return transport;
}

function safeRequest(request: MetaHttpRequest): MetaHttpRequest {
  const headers = { ...request.headers };
  if ('Authorization' in headers) headers.Authorization = 'Bearer [REDACTED]';
  return Object.freeze({ ...request, headers: Object.freeze(headers) });
}

export function readMetaContractHttpRequests(transport: MetaContractHttpTransport): readonly MetaHttpRequest[] {
  const state = TRANSPORTS.get(transport as object);
  if (!state) fail('Meta contract HTTP transport is not authentic');
  return Object.freeze(state.requests.map(safeRequest));
}

export function isAuthenticMetaContractHttpTransport(value: unknown): value is MetaContractHttpTransport {
  return typeof value === 'object' && value !== null && TRANSPORTS.has(value as object);
}

export async function executeMetaContractHttpRequest(
  transport: MetaContractHttpTransport,
  request: MetaHttpRequest,
): Promise<MetaHttpResponse> {
  const state = TRANSPORTS.get(transport as object);
  if (!state) fail('Meta contract HTTP transport is not authentic');
  state.requests.push(safeRequest(request));
  const step = state.remaining.shift();
  if (!step || step.kind === 'transport_error') throw new MetaCommunicationsContractError('Meta contract transport did not produce a response');
  return Object.freeze({ status: step.status, bodyUtf8: step.bodyUtf8 });
}

/** Injects the bearer token transiently; the pure transport stores only a redacted snapshot. */
export async function executeMetaAuthorizedContractHttpRequest(
  transport: MetaContractHttpTransport,
  bundle: MetaWhatsAppCredentialBundle | MetaSocialDmCredentialBundle,
  request: MetaHttpRequest,
): Promise<MetaHttpResponse> {
  return executeMetaContractHttpRequest(transport, Object.freeze({
    ...request,
    headers: Object.freeze({
      ...request.headers,
      Authorization: `Bearer ${credentialSecrets(bundle).accessToken}`,
    }),
  }));
}

export function metaBoundContext(
  context: ProviderOperationContext,
  bundle: MetaWhatsAppCredentialBundle | MetaSocialDmCredentialBundle,
  providerId: typeof META_WHATSAPP_PROVIDER_ID | typeof META_SOCIAL_DM_PROVIDER_ID,
): void {
  if (metaUuid(context.workspaceId, 'context.workspaceId') !== bundle.workspaceId
      || metaUuid(context.connectionId, 'context.connectionId') !== bundle.connectionId
      || context.providerId !== providerId) fail('Meta credentials are not bound to this provider operation');
}

export interface MetaContractDispatchResult {
  readonly status: 'contract_accepted' | 'contract_rejected' | 'outcome_unknown';
  readonly providerMessageId: string | null;
  readonly occurredAt: string;
  readonly disposition: 'applied' | 'replayed';
  readonly requestSha256: string;
  readonly providerEffectAttempted: false;
  readonly providerEffectsEnabled: false;
  readonly summary: string;
}

export function parseBoundedJson(value: string): Record<string, unknown> | null {
  if (Buffer.byteLength(value, 'utf8') > MAX_RESPONSE_BYTES) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}
