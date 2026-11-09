import { createHash } from 'node:crypto';
import type { ProviderOperationContext, ProviderOperationResult } from '../providers/contracts.js';
import {
  MailgunOutcomeUnknownError,
  type MailgunEuEmailTransport,
} from '../providers/mailgun-eu-http-adapter.js';
import { normalizeOwnedInternalSeedEmail } from '../providers/property-predator-email-pilot-config.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const MESSAGE_ID = /^<pp-([0-9a-f]{64})@mg[.]propertypredator[.]com>$/u;

export const CUSTOMER_EMAIL_LIVE_CONTRACT = 'propertypredator.customer-email-live/v1' as const;
export const CUSTOMER_EMAIL_DAILY_HARD_CAP = 10 as const;
export const CUSTOMER_EMAIL_MONTHLY_HARD_CAP = 50 as const;
export const CUSTOMER_EMAIL_LIVE_SENDING_DOMAIN = 'mg.propertypredator.com' as const;

export class CustomerEmailLiveError extends Error {
  constructor(readonly code:
    | 'disabled'
    | 'invalid_configuration'
    | 'invalid_binding'
    | 'provider_outcome_unknown') {
    super(`Customer email live rail failed: ${code}`);
    this.name = 'CustomerEmailLiveError';
  }
}

function fail(code: CustomerEmailLiveError['code']): never {
  throw new CustomerEmailLiveError(code);
}

function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) fail('invalid_binding');
  return value;
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export interface CustomerEmailLiveRuntimeConfig {
  readonly mode: 'disabled' | 'customer_live';
  readonly providerEffectsEnabled: boolean;
  readonly emailDeliveryEnabled: boolean;
  readonly emergencyPaused: boolean;
  /** Explicit operator attestation; this does not claim remote webhook health. */
  readonly receiptsConfirmed: boolean;
  readonly fromEmail: string | null;
  readonly sendingDomain: typeof CUSTOMER_EMAIL_LIVE_SENDING_DOMAIN | null;
  readonly maximumOperationsPerCycle: 1;
  readonly maximumRecipientsPerJob: 1;
  readonly dailySendCap: typeof CUSTOMER_EMAIL_DAILY_HARD_CAP;
  readonly monthlySendCap: typeof CUSTOMER_EMAIL_MONTHLY_HARD_CAP;
}

export function loadCustomerEmailLiveRuntimeConfig(
  env: NodeJS.ProcessEnv,
): CustomerEmailLiveRuntimeConfig {
  const mode = env.PROPERTY_PREDATOR_CUSTOMER_EMAIL_LIVE_MODE ?? 'disabled';
  const providerEffectsEnabled = env.PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED === 'true';
  const emailDeliveryEnabled = env.PROPERTY_PREDATOR_CUSTOMER_EMAIL_DELIVERY_ENABLED === 'true';
  const emergencyPaused = env.PROPERTY_PREDATOR_CUSTOMER_EMAIL_EMERGENCY_PAUSED !== 'false';
  const receiptsAttestation = env.PROPERTY_PREDATOR_CUSTOMER_EMAIL_RECEIPTS_CONFIRMED;
  if (receiptsAttestation !== undefined
      && receiptsAttestation !== 'true' && receiptsAttestation !== 'false') {
    fail('invalid_configuration');
  }
  const receiptsConfirmed = receiptsAttestation === 'true';
  if (mode === 'disabled') {
    if (providerEffectsEnabled || emailDeliveryEnabled || !emergencyPaused || receiptsConfirmed) {
      fail('invalid_configuration');
    }
    return Object.freeze({ mode, providerEffectsEnabled: false, emailDeliveryEnabled: false,
      emergencyPaused: true, receiptsConfirmed: false, fromEmail: null, sendingDomain: null,
      maximumOperationsPerCycle: 1, maximumRecipientsPerJob: 1,
      dailySendCap: CUSTOMER_EMAIL_DAILY_HARD_CAP,
      monthlySendCap: CUSTOMER_EMAIL_MONTHLY_HARD_CAP });
  }
  if (mode !== 'customer_live' || !providerEffectsEnabled || !emailDeliveryEnabled
      || emergencyPaused || !receiptsConfirmed
      || env.PROPERTY_PREDATOR_CUSTOMER_EMAIL_PROVIDER_ID !== 'mailgun_eu'
      || env.MAILGUN_SENDING_DOMAIN !== CUSTOMER_EMAIL_LIVE_SENDING_DOMAIN) {
    fail('invalid_configuration');
  }
  let fromEmail: string;
  try {
    fromEmail = normalizeOwnedInternalSeedEmail(env.MAILGUN_FROM_EMAIL ?? '');
  } catch {
    fail('invalid_configuration');
  }
  if (fromEmail !== env.MAILGUN_FROM_EMAIL
      || fromEmail.split('@')[1] !== CUSTOMER_EMAIL_LIVE_SENDING_DOMAIN) {
    fail('invalid_configuration');
  }
  return Object.freeze({ mode, providerEffectsEnabled: true, emailDeliveryEnabled: true,
    emergencyPaused: false, receiptsConfirmed: true, fromEmail,
    sendingDomain: CUSTOMER_EMAIL_LIVE_SENDING_DOMAIN,
    maximumOperationsPerCycle: 1, maximumRecipientsPerJob: 1,
    dailySendCap: CUSTOMER_EMAIL_DAILY_HARD_CAP,
    monthlySendCap: CUSTOMER_EMAIL_MONTHLY_HARD_CAP });
}

export interface CustomerEmailLiveClaim {
  readonly workspaceId: string;
  readonly connectionId: string;
  readonly jobId: string;
  readonly leaseVersion: number;
}

export interface CustomerEmailLiveMaterial extends CustomerEmailLiveClaim {
  readonly operationId: string;
  readonly correlationId: string;
  readonly requestSha256: string;
  readonly expectedMessageId: string;
  readonly sendingDomain: string;
  readonly recipient: string;
  readonly subject: string;
  readonly text: string;
}

export interface CustomerEmailLiveRepository {
  claimOne(input: Readonly<{ leaseToken: Buffer; leaseSeconds: number }>
  ): Promise<CustomerEmailLiveClaim | null>;
  loadClaimed(input: CustomerEmailLiveClaim & Readonly<{ leaseToken: Buffer }>
  ): Promise<CustomerEmailLiveMaterial>;
  markCalling(input: CustomerEmailLiveClaim & Readonly<{
    leaseToken: Buffer;
    providerEffectsEnabled: true;
    emailDeliveryEnabled: true;
    emergencyPaused: false;
  }>): Promise<boolean>;
  settle(input: CustomerEmailLiveClaim & Readonly<{
    leaseToken: Buffer;
    result: ProviderOperationResult;
    receiptSha256: string;
  }>): Promise<void>;
}

function assertMaterial(
  claim: CustomerEmailLiveClaim,
  material: CustomerEmailLiveMaterial,
  config: CustomerEmailLiveRuntimeConfig,
): void {
  if (material.workspaceId !== claim.workspaceId || material.connectionId !== claim.connectionId
      || material.jobId !== claim.jobId || material.leaseVersion !== claim.leaseVersion
      || !UUID.test(material.operationId) || !UUID.test(material.correlationId)
      || !SHA256.test(material.requestSha256)) fail('invalid_binding');
  const match = MESSAGE_ID.exec(material.expectedMessageId);
  if (!match || match[1] !== material.requestSha256
      || material.sendingDomain !== CUSTOMER_EMAIL_LIVE_SENDING_DOMAIN
      || config.sendingDomain !== material.sendingDomain
      || config.fromEmail?.split('@')[1] !== material.sendingDomain
      || normalizeOwnedInternalSeedEmail(material.recipient) !== material.recipient
      || !material.subject || /[\r\n]/u.test(material.subject)
      || Buffer.byteLength(material.subject, 'utf8') > 500
      || !material.text || Buffer.byteLength(material.text, 'utf8') > 8_192) {
    fail('invalid_binding');
  }
}

function outcomeUnknown(now: () => Date): ProviderOperationResult {
  return Object.freeze({ status: 'needs_attention' as const, externalId: null,
    occurredAt: now().toISOString(), retryable: false,
    errorCode: 'mailgun_customer_outcome_unknown',
    summary: 'Mailgun customer-email outcome requires signed receipt reconciliation' });
}

/**
 * Runs no more than one exact-recipient job. The durable calling fence is
 * crossed before the adapter receives any recipient or body material.
 */
export async function runCustomerEmailLiveOnce(input: Readonly<{
  config: CustomerEmailLiveRuntimeConfig;
  repository: CustomerEmailLiveRepository;
  transport: MailgunEuEmailTransport;
  leaseToken: Buffer;
  now?: () => Date;
}>): Promise<'idle' | 'settled' | 'failed_or_attention'> {
  if (input.config.mode !== 'customer_live' || !input.config.providerEffectsEnabled
      || !input.config.emailDeliveryEnabled || input.config.emergencyPaused
      || !input.config.receiptsConfirmed || !input.config.fromEmail
      || input.config.sendingDomain !== CUSTOMER_EMAIL_LIVE_SENDING_DOMAIN
      || input.leaseToken.length !== 32) fail('disabled');
  const claim = await input.repository.claimOne({ leaseToken: input.leaseToken, leaseSeconds: 60 });
  if (!claim) return 'idle';
  const material = await input.repository.loadClaimed({ ...claim, leaseToken: input.leaseToken });
  assertMaterial(claim, material, input.config);
  const marked = await input.repository.markCalling({ ...claim, leaseToken: input.leaseToken,
    providerEffectsEnabled: true, emailDeliveryEnabled: true, emergencyPaused: false });
  if (!marked) return 'failed_or_attention';
  const context: ProviderOperationContext = Object.freeze({ workspaceId: uuid(claim.workspaceId),
    connectionId: uuid(claim.connectionId), providerId: 'mailgun_eu',
    operationId: material.operationId, idempotencyKey: material.requestSha256,
    correlationId: material.correlationId });
  const now = input.now ?? (() => new Date());
  let result: ProviderOperationResult;
  try {
    result = await input.transport.send(context, { recipients: [material.recipient],
      subject: material.subject, text: material.text,
      idempotencySha256: material.requestSha256,
      expectedMessageId: material.expectedMessageId });
  } catch (error) {
    result = error instanceof MailgunOutcomeUnknownError
      ? outcomeUnknown(now) : outcomeUnknown(now);
  }
  const receiptSha256 = digest(JSON.stringify({ contract: CUSTOMER_EMAIL_LIVE_CONTRACT,
    jobId: claim.jobId, result }));
  await input.repository.settle({ ...claim, leaseToken: input.leaseToken,
    result, receiptSha256 });
  return result.status === 'needs_attention' ? 'failed_or_attention' : 'settled';
}
