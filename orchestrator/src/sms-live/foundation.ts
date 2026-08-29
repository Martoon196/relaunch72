/**
 * Twilio Messaging UK SMS live rail foundation.
 *
 * Fail-closed domain seam mirroring the customer-email rail: an exact
 * environment switch tuple, a one-at-a-time claim/load/fence/settle worker
 * flow, segment-counted hard caps and raw-callback signature verification.
 * This module owns no credential and can never call Twilio itself; the
 * transport is injected by the isolated worker process only.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type {
  ProviderOperationContext,
  ProviderOperationResult,
} from '../providers/contracts.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

export const TWILIO_SMS_LIVE_CONTRACT = 'propertypredator.twilio-sms-live/v1' as const;
export const TWILIO_SMS_PROVIDER_ID = 'twilio_messaging' as const;
export const TWILIO_SMS_DAILY_SEGMENT_HARD_CAP = 10 as const;
export const TWILIO_SMS_MONTHLY_SEGMENT_HARD_CAP = 50 as const;

/**
 * Conservative GSM-7 basic subset (printable ASCII minus the escape-extended
 * characters, plus CR/LF). Every admitted character costs exactly one septet,
 * so the SQL cap gate and this module compute identical segment counts.
 */
export const TWILIO_SMS_GSM_BASIC_TEXT = /^[\r\n\x20-\x5a\x5f\x61-\x7a]+$/u;
export const TWILIO_SMS_UK_RECIPIENT = /^\+44[0-9]{9,10}$/u;
export const TWILIO_SMS_MESSAGE_SID = /^(?:SM|MM)[0-9a-f]{32}$/u;
export const TWILIO_SMS_ACCOUNT_SID = /^AC[0-9a-f]{32}$/u;

const MAX_BODY_CHARS = 1_530;
const SINGLE_SEGMENT_CHARS = 160;
const MULTI_SEGMENT_CHARS = 153;
const MAX_INBOUND_BODY_BYTES = 4_096;
const E164 = /^\+[1-9][0-9]{6,14}$/u;
const ERROR_CODE = /^[0-9]{1,6}$/u;

export class TwilioSmsLiveError extends Error {
  constructor(readonly code:
    | 'disabled'
    | 'invalid_configuration'
    | 'invalid_binding'
    | 'signature_invalid'
    | 'webhook_invalid'
    | 'provider_outcome_unknown') {
    super(`Twilio SMS live rail failed: ${code}`);
    this.name = 'TwilioSmsLiveError';
  }
}

function fail(code: ConstructorParameters<typeof TwilioSmsLiveError>[0]): never {
  throw new TwilioSmsLiveError(code);
}

/**
 * Segments for a GSM-basic-subset body. The caller must have proven the body
 * against TWILIO_SMS_GSM_BASIC_TEXT first; every admitted character is one
 * septet, so 160 characters fit one segment and 153 fit each concatenated one.
 */
export function twilioSmsSegmentCount(body: string): number {
  if (!body || !TWILIO_SMS_GSM_BASIC_TEXT.test(body) || body.length > MAX_BODY_CHARS) {
    fail('invalid_binding');
  }
  return body.length <= SINGLE_SEGMENT_CHARS
    ? 1
    : Math.ceil(body.length / MULTI_SEGMENT_CHARS);
}

export interface TwilioSmsLiveRuntimeConfig {
  readonly mode: 'disabled' | 'owned_number_live';
  readonly providerEffectsEnabled: boolean;
  readonly smsDeliveryEnabled: boolean;
  readonly emergencyPaused: boolean;
  /** Explicit operator attestation; this does not claim remote webhook health. */
  readonly receiptsConfirmed: boolean;
  readonly senderNumber: string | null;
  readonly maximumOperationsPerCycle: 1;
  readonly maximumRecipientsPerJob: 1;
  readonly dailySegmentCap: typeof TWILIO_SMS_DAILY_SEGMENT_HARD_CAP;
  readonly monthlySegmentCap: typeof TWILIO_SMS_MONTHLY_SEGMENT_HARD_CAP;
}

export function loadTwilioSmsLiveRuntimeConfig(
  env: NodeJS.ProcessEnv,
): TwilioSmsLiveRuntimeConfig {
  const mode = env.PROPERTY_PREDATOR_SMS_LIVE_MODE ?? 'disabled';
  const providerEffectsEnabled = env.PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED === 'true';
  const smsDeliveryEnabled = env.PROPERTY_PREDATOR_SMS_DELIVERY_ENABLED === 'true';
  const emergencyPaused = env.PROPERTY_PREDATOR_SMS_EMERGENCY_PAUSED !== 'false';
  const receiptsAttestation = env.PROPERTY_PREDATOR_SMS_RECEIPTS_CONFIRMED;
  if (receiptsAttestation !== undefined
      && receiptsAttestation !== 'true' && receiptsAttestation !== 'false') {
    fail('invalid_configuration');
  }
  const receiptsConfirmed = receiptsAttestation === 'true';
  if (mode === 'disabled') {
    if (providerEffectsEnabled || smsDeliveryEnabled || !emergencyPaused || receiptsConfirmed) {
      fail('invalid_configuration');
    }
    return Object.freeze({
      mode,
      providerEffectsEnabled: false,
      smsDeliveryEnabled: false,
      emergencyPaused: true,
      receiptsConfirmed: false,
      senderNumber: null,
      maximumOperationsPerCycle: 1,
      maximumRecipientsPerJob: 1,
      dailySegmentCap: TWILIO_SMS_DAILY_SEGMENT_HARD_CAP,
      monthlySegmentCap: TWILIO_SMS_MONTHLY_SEGMENT_HARD_CAP,
    });
  }
  const senderNumber = env.PROPERTY_PREDATOR_SMS_SENDER_NUMBER?.trim() ?? '';
  if (mode !== 'owned_number_live'
      || !providerEffectsEnabled || !smsDeliveryEnabled || emergencyPaused
      || !receiptsConfirmed
      || env.PROPERTY_PREDATOR_SMS_PROVIDER_ID !== TWILIO_SMS_PROVIDER_ID
      || !TWILIO_SMS_UK_RECIPIENT.test(senderNumber)) {
    fail('invalid_configuration');
  }
  return Object.freeze({
    mode,
    providerEffectsEnabled: true,
    smsDeliveryEnabled: true,
    emergencyPaused: false,
    receiptsConfirmed: true,
    senderNumber,
    maximumOperationsPerCycle: 1,
    maximumRecipientsPerJob: 1,
    dailySegmentCap: TWILIO_SMS_DAILY_SEGMENT_HARD_CAP,
    monthlySegmentCap: TWILIO_SMS_MONTHLY_SEGMENT_HARD_CAP,
  });
}

export interface TwilioSmsLiveClaim {
  readonly workspaceId: string;
  readonly connectionId: string;
  readonly jobId: string;
  readonly leaseVersion: number;
}

export interface TwilioSmsLiveMaterial extends TwilioSmsLiveClaim {
  readonly operationId: string;
  readonly correlationId: string;
  readonly requestSha256: string;
  readonly senderNumber: string;
  readonly recipient: string;
  readonly body: string;
  readonly segmentCount: number;
}

export interface TwilioSmsLiveRepository {
  claimOne(input: Readonly<{ leaseToken: Buffer; leaseSeconds: number }>
  ): Promise<TwilioSmsLiveClaim | null>;
  loadClaimed(input: TwilioSmsLiveClaim & Readonly<{ leaseToken: Buffer }>
  ): Promise<TwilioSmsLiveMaterial>;
  markCalling(input: TwilioSmsLiveClaim & Readonly<{
    leaseToken: Buffer;
    providerEffectsEnabled: true;
    smsDeliveryEnabled: true;
    emergencyPaused: false;
  }>): Promise<boolean>;
  settle(input: TwilioSmsLiveClaim & Readonly<{
    leaseToken: Buffer;
    result: ProviderOperationResult;
    receiptSha256: string;
  }>): Promise<void>;
}

export interface TwilioSmsSendRequest {
  readonly recipient: string;
  readonly body: string;
  readonly expectedSegmentCount: number;
  /** SHA-256 of the canonical enqueue-time request; doubles as the idempotency key. */
  readonly idempotencySha256: string;
  readonly signal?: AbortSignal;
}

export interface TwilioMessagingSmsTransport {
  readonly contract: typeof TWILIO_SMS_LIVE_CONTRACT;
  readonly providerId: typeof TWILIO_SMS_PROVIDER_ID;
  send(
    context: ProviderOperationContext,
    request: TwilioSmsSendRequest,
  ): Promise<ProviderOperationResult>;
}

function assertMaterial(
  claim: TwilioSmsLiveClaim,
  material: TwilioSmsLiveMaterial,
  config: TwilioSmsLiveRuntimeConfig,
): void {
  if (material.workspaceId !== claim.workspaceId || material.connectionId !== claim.connectionId
      || material.jobId !== claim.jobId || material.leaseVersion !== claim.leaseVersion
      || !UUID.test(material.operationId) || !UUID.test(material.correlationId)
      || !SHA256.test(material.requestSha256)) fail('invalid_binding');
  if (config.senderNumber !== material.senderNumber
      || !TWILIO_SMS_UK_RECIPIENT.test(material.recipient)
      || material.recipient === material.senderNumber
      || twilioSmsSegmentCount(material.body) !== material.segmentCount
      || material.segmentCount > TWILIO_SMS_DAILY_SEGMENT_HARD_CAP) {
    fail('invalid_binding');
  }
}

function outcomeUnknown(now: () => Date): ProviderOperationResult {
  return Object.freeze({
    status: 'needs_attention' as const,
    externalId: null,
    occurredAt: now().toISOString(),
    retryable: false,
    errorCode: 'twilio_sms_outcome_unknown',
    summary: 'Twilio SMS outcome requires signed status-callback reconciliation',
  });
}

/**
 * One controlled dispatch cycle: claim → load → prove material → durable
 * calling fence → provider call → settle. Every transport throw is
 * quarantined as a non-retryable unknown outcome.
 */
export async function runTwilioSmsLiveOnce(input: Readonly<{
  config: TwilioSmsLiveRuntimeConfig;
  repository: TwilioSmsLiveRepository;
  transport: TwilioMessagingSmsTransport;
  leaseToken: Buffer;
  now?: () => Date;
}>): Promise<'idle' | 'settled' | 'failed_or_attention'> {
  if (input.config.mode !== 'owned_number_live' || !input.config.providerEffectsEnabled
      || !input.config.smsDeliveryEnabled || input.config.emergencyPaused
      || !input.config.receiptsConfirmed || !input.config.senderNumber
      || input.transport.contract !== TWILIO_SMS_LIVE_CONTRACT
      || input.transport.providerId !== TWILIO_SMS_PROVIDER_ID
      || input.leaseToken.length !== 32) fail('disabled');
  const claim = await input.repository.claimOne({ leaseToken: input.leaseToken, leaseSeconds: 60 });
  if (!claim) return 'idle';
  const material = await input.repository.loadClaimed({ ...claim, leaseToken: input.leaseToken });
  assertMaterial(claim, material, input.config);
  const marked = await input.repository.markCalling({
    ...claim,
    leaseToken: input.leaseToken,
    providerEffectsEnabled: true,
    smsDeliveryEnabled: true,
    emergencyPaused: false,
  });
  if (!marked) return 'failed_or_attention';
  const context: ProviderOperationContext = Object.freeze({
    workspaceId: material.workspaceId,
    connectionId: material.connectionId,
    providerId: TWILIO_SMS_PROVIDER_ID,
    operationId: material.operationId,
    idempotencyKey: material.requestSha256,
    correlationId: material.correlationId,
  });
  const now = input.now ?? (() => new Date());
  let result: ProviderOperationResult;
  try {
    result = await input.transport.send(context, {
      recipient: material.recipient,
      body: material.body,
      expectedSegmentCount: material.segmentCount,
      idempotencySha256: material.requestSha256,
    });
  } catch {
    result = outcomeUnknown(now);
  }
  const receiptSha256 = createHash('sha256')
    .update(JSON.stringify({ contract: TWILIO_SMS_LIVE_CONTRACT, jobId: claim.jobId, result }))
    .digest('hex');
  await input.repository.settle({ ...claim, leaseToken: input.leaseToken, result, receiptSha256 });
  return result.status === 'needs_attention' ? 'failed_or_attention' : 'settled';
}

// ── Signed callback verification (webhook service only) ─────────────────────

const STOP_KEYWORDS = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'REVOKE', 'OPTOUT']);
const START_KEYWORDS = new Set(['START', 'YES', 'UNSTOP']);
const STATUS_VALUES = new Set([
  'queued', 'accepted', 'scheduled', 'sending', 'sent',
  'delivered', 'undelivered', 'failed', 'canceled',
]);

export interface VerifiedTwilioSmsPayload {
  readonly payloadSha256: string;
  readonly signatureSha256: string;
  readonly params: ReadonlyMap<string, string>;
}

/**
 * Twilio's documented request authentication: base64(HMAC-SHA1(authToken,
 * fullUrl + concat(sorted form parameter name+value))). The exact raw byte
 * sequence is hashed for evidence before any parsing survives the boundary.
 */
export function verifyTwilioSmsWebhook(input: Readonly<{
  publicOrigin: string;
  path: string;
  authToken: string;
  rawBody: Uint8Array;
  contentType: unknown;
  twilioSignature: unknown;
}>): VerifiedTwilioSmsPayload {
  if (!input.authToken || input.rawBody.byteLength < 1
      || input.rawBody.byteLength > 65_536) fail('webhook_invalid');
  if (typeof input.contentType !== 'string'
      || !input.contentType.toLowerCase().startsWith('application/x-www-form-urlencoded')) {
    fail('webhook_invalid');
  }
  if (typeof input.twilioSignature !== 'string'
      || !/^[A-Za-z0-9+/=]{20,64}$/u.test(input.twilioSignature)) {
    fail('signature_invalid');
  }
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(Buffer.from(input.rawBody).toString('utf8'));
  } catch {
    fail('webhook_invalid');
  }
  const names = [...new Set([...params.keys()])];
  for (const name of names) {
    if (params.getAll(name).length !== 1) fail('webhook_invalid');
  }
  names.sort();
  let data = `${input.publicOrigin}${input.path}`;
  for (const name of names) {
    data += name + (params.get(name) ?? '');
  }
  const expected = createHmac('sha1', input.authToken).update(data, 'utf8').digest('base64');
  const suppliedBytes = Buffer.from(input.twilioSignature, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  if (suppliedBytes.length !== expectedBytes.length
      || !timingSafeEqual(suppliedBytes, expectedBytes)) {
    fail('signature_invalid');
  }
  const entries = new Map<string, string>();
  for (const name of names) entries.set(name, params.get(name) ?? '');
  return Object.freeze({
    payloadSha256: createHash('sha256').update(Buffer.from(input.rawBody)).digest('hex'),
    signatureSha256: createHash('sha256').update(input.twilioSignature, 'utf8').digest('hex'),
    params: entries,
  });
}

export type TwilioSmsOptEvidence = 'stop' | 'start' | 'help' | null;

export interface VerifiedTwilioSmsInboundEvent {
  readonly kind: 'inbound';
  readonly externalEventId: string;
  readonly providerMessageId: string;
  /** Digits-only normalized sender, mirroring the WhatsApp projection contract. */
  readonly normalizedSender: string;
  readonly senderSha256: string;
  readonly body: string;
  readonly bodySha256: string;
  readonly optEvidence: TwilioSmsOptEvidence;
}

export interface VerifiedTwilioSmsStatusEvent {
  readonly kind: 'status';
  readonly externalEventId: string;
  readonly providerMessageId: string;
  readonly status: string;
  readonly errorCode: string | null;
}

function requiredParam(params: ReadonlyMap<string, string>, name: string): string {
  const value = params.get(name);
  if (!value) fail('webhook_invalid');
  return value;
}

function assertAccount(params: ReadonlyMap<string, string>, accountSid: string): void {
  if (!TWILIO_SMS_ACCOUNT_SID.test(accountSid)
      || requiredParam(params, 'AccountSid') !== accountSid) {
    fail('webhook_invalid');
  }
}

export function parseTwilioSmsInboundEvent(
  verified: VerifiedTwilioSmsPayload,
  accountSid: string,
): VerifiedTwilioSmsInboundEvent {
  assertAccount(verified.params, accountSid);
  const messageSid = requiredParam(verified.params, 'MessageSid');
  const from = requiredParam(verified.params, 'From');
  const body = verified.params.get('Body') ?? '';
  if (!TWILIO_SMS_MESSAGE_SID.test(messageSid) || !E164.test(from)
      || !body.trim() || Buffer.byteLength(body, 'utf8') > MAX_INBOUND_BODY_BYTES
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(body)) {
    fail('webhook_invalid');
  }
  const rawOptOut = verified.params.get('OptOutType')?.toUpperCase() ?? '';
  const keyword = body.trim().toUpperCase();
  const optEvidence: TwilioSmsOptEvidence = rawOptOut === 'STOP' || STOP_KEYWORDS.has(keyword)
    ? 'stop'
    : rawOptOut === 'START' || START_KEYWORDS.has(keyword)
      ? 'start'
      : rawOptOut === 'HELP' || keyword === 'HELP' || keyword === 'INFO'
        ? 'help'
        : null;
  const normalizedSender = from.slice(1);
  return Object.freeze({
    kind: 'inbound',
    externalEventId: `inbound:${messageSid}`,
    providerMessageId: messageSid,
    normalizedSender,
    senderSha256: createHash('sha256').update(normalizedSender, 'utf8').digest('hex'),
    body,
    bodySha256: createHash('sha256').update(body, 'utf8').digest('hex'),
    optEvidence,
  });
}

export function parseTwilioSmsStatusEvent(
  verified: VerifiedTwilioSmsPayload,
  accountSid: string,
): VerifiedTwilioSmsStatusEvent {
  assertAccount(verified.params, accountSid);
  const messageSid = requiredParam(verified.params, 'MessageSid');
  const status = (verified.params.get('MessageStatus')
    ?? verified.params.get('SmsStatus') ?? '').toLowerCase();
  const rawErrorCode = verified.params.get('ErrorCode')?.trim() ?? '';
  if (!TWILIO_SMS_MESSAGE_SID.test(messageSid) || !STATUS_VALUES.has(status)
      || (rawErrorCode !== '' && !ERROR_CODE.test(rawErrorCode))) {
    fail('webhook_invalid');
  }
  return Object.freeze({
    kind: 'status',
    externalEventId: `status:${messageSid}:${status}`,
    providerMessageId: messageSid,
    status,
    errorCode: rawErrorCode === '' ? null : rawErrorCode,
  });
}
