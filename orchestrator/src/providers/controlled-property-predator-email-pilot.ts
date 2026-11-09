import { createHash } from 'node:crypto';
import {
  createProviderOperationContext,
  type ProviderOperationContext,
  type ProviderOperationResult,
} from './contracts.js';
import {
  MailgunOutcomeUnknownError,
  type MailgunEuEmailTransport,
} from './mailgun-eu-http-adapter.js';
import {
  normalizeOwnedInternalSeedEmail,
  PROPERTY_PREDATOR_EMAIL_HARD_MAX_RECIPIENTS,
  PROPERTY_PREDATOR_EMAIL_PILOT_STAGE,
  PROPERTY_PREDATOR_EMAIL_PROVIDER_ID,
  PROPERTY_PREDATOR_EMAIL_RECIPIENT_SCOPE,
  type PropertyPredatorEmailPilotPolicy,
} from './property-predator-email-pilot-config.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_KEY = /^[\x21-\x7e]{1,200}$/;
const SAFE_REASON = /^[a-z][a-z0-9_.:-]{0,99}$/;
const MAX_BODY_BYTES = 8_192;
const MAX_SUBJECT_BYTES = 500;

export interface ControlledEmailPilotRecipient {
  readonly email: string;
  readonly contactPointId: string;
  readonly consentEventId: string;
}

export interface ControlledEmailPilotApproval {
  readonly messageVersionId: string;
  readonly approvalRequestId: string;
  readonly approvalDecisionId: string;
  /** SHA-256 produced by propertyPredatorEmailContentSha256. */
  readonly approvedContentSha256: string;
}

export interface ControlledEmailPilotCommand {
  readonly runId: string;
  readonly stage: typeof PROPERTY_PREDATOR_EMAIL_PILOT_STAGE;
  readonly recipientScope: typeof PROPERTY_PREDATOR_EMAIL_RECIPIENT_SCOPE;
  readonly subject: string;
  readonly text: string;
  readonly recipients: readonly ControlledEmailPilotRecipient[];
  readonly approval: ControlledEmailPilotApproval;
  readonly signal?: AbortSignal;
}

interface CanonicalRecipientEvidence {
  readonly email: string;
  readonly emailSha256: string;
  readonly contactPointId: string;
  readonly consentEventId: string;
}

export interface ControlledEmailPilotBoundaryInput {
  readonly workspaceId: string;
  readonly providerConnectionId: string;
  readonly operationId: string;
  readonly correlationId: string;
  readonly idempotencyKeySha256: string;
  readonly requestSha256: string;
  readonly runId: string;
  readonly utcMonth: string;
  readonly stage: typeof PROPERTY_PREDATOR_EMAIL_PILOT_STAGE;
  readonly recipientScope: typeof PROPERTY_PREDATOR_EMAIL_RECIPIENT_SCOPE;
  readonly approval: ControlledEmailPilotApproval;
  readonly recipients: readonly CanonicalRecipientEvidence[];
  readonly requestedMessages: number;
  readonly estimatedSpendUsdMicros: number;
  readonly limits: Readonly<{
    maxMessagesPerRun: number;
    maxMessagesPerUtcMonth: number;
    maxSpendUsdMicrosPerRun: number;
    maxSpendUsdMicrosPerUtcMonth: number;
  }>;
}

export interface ControlledEmailPilotCurrentEvidence {
  readonly workspaceId: string;
  readonly providerConnectionId: string;
  readonly stage: typeof PROPERTY_PREDATOR_EMAIL_PILOT_STAGE;
  readonly recipientScope: typeof PROPERTY_PREDATOR_EMAIL_RECIPIENT_SCOPE;
  readonly providerEffectsEnabled: boolean;
  readonly emailDeliveryEnabled: boolean;
  readonly emergencyPaused: boolean;
  readonly approval: Readonly<{
    messageVersionId: string;
    approvalRequestId: string;
    approvalDecisionId: string;
    approvedContentSha256: string;
    decision: 'approved';
    immutable: true;
  }>;
  readonly recipients: readonly Readonly<{
    contactPointId: string;
    consentEventId: string;
    emailSha256: string;
    consentState: 'granted' | 'denied' | 'withdrawn' | 'unknown';
    suppressed: boolean;
    ownedInternalSeed: boolean;
  }>[];
  /** Usage after atomically reserving this call. Unknown outcomes remain counted. */
  readonly usageAfterReservation: Readonly<{
    runMessages: number;
    runSpendUsdMicros: number;
    monthMessages: number;
    monthSpendUsdMicros: number;
    utcMonth: string;
  }>;
}

export type ControlledEmailPilotBoundaryDecision =
  | Readonly<{ disposition: 'blocked'; reason: string }>
  | Readonly<{
    disposition: 'replay';
    requestSha256: string;
    result: ProviderOperationResult;
  }>
  | Readonly<{
    disposition: 'authorized';
    reservationId: string;
    requestSha256: string;
    evidence: ControlledEmailPilotCurrentEvidence;
  }>;

/**
 * The production implementation must make this method one atomic, durable
 * transaction. It owns idempotency, aggregate usage reservation and the final
 * current approval/consent/suppression/emergency-pause recheck.
 */
export interface ControlledEmailPilotBoundary {
  authorizeImmediatelyBeforeProviderCall(
    input: ControlledEmailPilotBoundaryInput,
  ): Promise<ControlledEmailPilotBoundaryDecision>;
  cancelBeforeProviderCall(
    reservationId: string,
    requestSha256: string,
    reason: string,
  ): Promise<void>;
  settleProviderCall(
    reservationId: string,
    requestSha256: string,
    result: ProviderOperationResult,
  ): Promise<void>;
}

export interface ControlledEmailPilotDispatchResult {
  readonly disposition: 'blocked' | 'replayed' | 'settled';
  readonly reason: string | null;
  readonly requestSha256: string | null;
  readonly providerResult: ProviderOperationResult | null;
}

function uuid(value: string, label: string): string {
  const canonical = value.toLowerCase();
  if (!UUID.test(canonical)) throw new Error(`${label} must be a canonical UUID`);
  return canonical;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function contentText(value: string, label: string, maximumBytes: number): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') < 1
      || Buffer.byteLength(value, 'utf8') > maximumBytes || value.includes('\u0000')
      || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

export function propertyPredatorEmailContentSha256(subject: string, text: string): string {
  const canonicalSubject = contentText(
    subject.normalize('NFC').trim(),
    'subject',
    MAX_SUBJECT_BYTES,
  );
  if (/[\r\n]/u.test(canonicalSubject)) throw new Error('subject cannot contain header breaks');
  const canonicalText = contentText(text, 'text', MAX_BODY_BYTES);
  return sha256(JSON.stringify({ schemaVersion: 1, subject: canonicalSubject, text: canonicalText }));
}

function validateProviderResult(result: ProviderOperationResult): void {
  if (!['accepted', 'pending', 'succeeded', 'failed', 'needs_attention'].includes(result.status)
      || !Number.isFinite(new Date(result.occurredAt).getTime())
      || typeof result.retryable !== 'boolean'
      || typeof result.summary !== 'string' || result.summary.trim() !== result.summary
      || result.summary.length < 1 || result.summary.length > 500
      || (result.externalId !== null
        && (typeof result.externalId !== 'string' || result.externalId.trim() !== result.externalId
          || result.externalId.length < 1 || result.externalId.length > 500))
      || (result.errorCode !== null && !SAFE_REASON.test(result.errorCode))) {
    throw new Error('Controlled email provider result is invalid');
  }
}

function blocked(reason: string): ControlledEmailPilotDispatchResult {
  return Object.freeze({
    disposition: 'blocked', reason, requestSha256: null, providerResult: null,
  });
}

function validatePolicy(policy: PropertyPredatorEmailPilotPolicy): ReadonlySet<string> {
  uuid(policy.workspaceId, 'policy.workspaceId');
  uuid(policy.providerConnectionId, 'policy.providerConnectionId');
  if (policy.stage !== PROPERTY_PREDATOR_EMAIL_PILOT_STAGE
      || policy.recipientScope !== PROPERTY_PREDATOR_EMAIL_RECIPIENT_SCOPE
      || typeof policy.providerEffectsEnabled !== 'boolean'
      || typeof policy.emailDeliveryEnabled !== 'boolean'
      || typeof policy.emergencyPaused !== 'boolean'
      || !Number.isSafeInteger(policy.maxRecipients) || policy.maxRecipients < 1
      || policy.maxRecipients > PROPERTY_PREDATOR_EMAIL_HARD_MAX_RECIPIENTS
      || !Number.isSafeInteger(policy.maxMessagesPerRun) || policy.maxMessagesPerRun < 1
      || policy.maxMessagesPerRun > policy.maxRecipients
      || !Number.isSafeInteger(policy.maxMessagesPerUtcMonth)
      || policy.maxMessagesPerUtcMonth < policy.maxMessagesPerRun
      || policy.maxMessagesPerUtcMonth > 10_000
      || !Number.isSafeInteger(policy.estimatedCostUsdMicrosPerRecipient)
      || policy.estimatedCostUsdMicrosPerRecipient < 1
      || policy.estimatedCostUsdMicrosPerRecipient > 1_000_000
      || !Number.isSafeInteger(policy.maxSpendUsdMicrosPerRun)
      || policy.maxSpendUsdMicrosPerRun < policy.estimatedCostUsdMicrosPerRecipient
      || policy.maxSpendUsdMicrosPerRun > 100_000_000
      || !Number.isSafeInteger(policy.maxSpendUsdMicrosPerUtcMonth)
      || policy.maxSpendUsdMicrosPerUtcMonth < policy.maxSpendUsdMicrosPerRun
      || policy.maxSpendUsdMicrosPerUtcMonth > 100_000_000) {
    throw new Error('Controlled email pilot policy is invalid');
  }
  const seeds = policy.internalSeedAllowlist.map(normalizeOwnedInternalSeedEmail);
  if (seeds.length < 1 || seeds.length > policy.maxRecipients
      || seeds.some((seed, index) => seed !== policy.internalSeedAllowlist[index])
      || new Set(seeds).size !== seeds.length) {
    throw new Error('Controlled email pilot allowlist is not canonical');
  }
  return new Set(seeds);
}

function utcMonth(now: Date): string {
  if (!Number.isFinite(now.getTime())) throw new Error('Controlled email pilot clock is invalid');
  return now.toISOString().slice(0, 7);
}

function validUsage(evidence: ControlledEmailPilotCurrentEvidence, input: ControlledEmailPilotBoundaryInput): boolean {
  const usage = evidence.usageAfterReservation;
  return usage.utcMonth === input.utcMonth
    && Number.isSafeInteger(usage.runMessages) && usage.runMessages >= input.requestedMessages
    && usage.runMessages <= input.limits.maxMessagesPerRun
    && Number.isSafeInteger(usage.monthMessages) && usage.monthMessages >= input.requestedMessages
    && usage.monthMessages <= input.limits.maxMessagesPerUtcMonth
    && Number.isSafeInteger(usage.runSpendUsdMicros)
    && usage.runSpendUsdMicros >= input.estimatedSpendUsdMicros
    && usage.runSpendUsdMicros <= input.limits.maxSpendUsdMicrosPerRun
    && Number.isSafeInteger(usage.monthSpendUsdMicros)
    && usage.monthSpendUsdMicros >= input.estimatedSpendUsdMicros
    && usage.monthSpendUsdMicros <= input.limits.maxSpendUsdMicrosPerUtcMonth;
}

function validCurrentEvidence(
  evidence: ControlledEmailPilotCurrentEvidence,
  input: ControlledEmailPilotBoundaryInput,
): boolean {
  if (evidence.workspaceId !== input.workspaceId
      || evidence.providerConnectionId !== input.providerConnectionId
      || evidence.stage !== PROPERTY_PREDATOR_EMAIL_PILOT_STAGE
      || evidence.recipientScope !== PROPERTY_PREDATOR_EMAIL_RECIPIENT_SCOPE
      || evidence.providerEffectsEnabled !== true
      || evidence.emailDeliveryEnabled !== true
      || evidence.emergencyPaused !== false
      || evidence.approval.decision !== 'approved'
      || evidence.approval.immutable !== true
      || evidence.approval.messageVersionId !== input.approval.messageVersionId
      || evidence.approval.approvalRequestId !== input.approval.approvalRequestId
      || evidence.approval.approvalDecisionId !== input.approval.approvalDecisionId
      || evidence.approval.approvedContentSha256 !== input.approval.approvedContentSha256
      || evidence.recipients.length !== input.recipients.length
      || !validUsage(evidence, input)) return false;
  const byContactPoint = new Map(evidence.recipients.map((recipient) => [recipient.contactPointId, recipient]));
  return input.recipients.every((recipient) => {
    const current = byContactPoint.get(recipient.contactPointId);
    return current?.consentEventId === recipient.consentEventId
      && current.emailSha256 === recipient.emailSha256
      && current.consentState === 'granted'
      && current.suppressed === false
      && current.ownedInternalSeed === true;
  });
}

/**
 * Fail-closed controlled Mailgun pilot coordinator.
 *
 * No transport call is possible until both static switches and the durable
 * final-boundary transaction agree. A durable boundary must retain `calling`
 * and `needs_attention` operations so an abort or crash can never become an
 * automatic duplicate send.
 */
export class ControlledPropertyPredatorEmailPilot {
  readonly #allowlist: ReadonlySet<string>;
  readonly #now: () => Date;

  constructor(private readonly dependencies: Readonly<{
    policy: PropertyPredatorEmailPilotPolicy;
    boundary: ControlledEmailPilotBoundary;
    transport: MailgunEuEmailTransport;
    now?: () => Date;
  }>) {
    this.#allowlist = validatePolicy(dependencies.policy);
    this.#now = dependencies.now ?? (() => new Date());
  }

  async dispatch(
    context: ProviderOperationContext,
    command: ControlledEmailPilotCommand,
  ): Promise<ControlledEmailPilotDispatchResult> {
    const policy = this.dependencies.policy;
    if (!policy.providerEffectsEnabled) return blocked('provider_effects_disabled');
    if (!policy.emailDeliveryEnabled) return blocked('email_delivery_disabled');
    if (policy.emergencyPaused) return blocked('emergency_paused');
    if (context.workspaceId !== policy.workspaceId) return blocked('wrong_workspace');
    if (context.connectionId !== policy.providerConnectionId) return blocked('wrong_connection');
    if (context.providerId !== PROPERTY_PREDATOR_EMAIL_PROVIDER_ID) return blocked('wrong_provider');
    if (command.stage !== PROPERTY_PREDATOR_EMAIL_PILOT_STAGE) return blocked('wrong_stage');
    if (command.recipientScope !== PROPERTY_PREDATOR_EMAIL_RECIPIENT_SCOPE) return blocked('wrong_scope');
    if (command.signal?.aborted) return blocked('request_aborted');
    uuid(context.operationId, 'context.operationId');
    uuid(context.correlationId, 'context.correlationId');
    uuid(command.runId, 'command.runId');
    if (!SAFE_KEY.test(context.idempotencyKey)) throw new Error('context.idempotencyKey is invalid');

    const subject = contentText(command.subject.normalize('NFC').trim(), 'command.subject', MAX_SUBJECT_BYTES);
    if (/[\r\n]/u.test(subject)) throw new Error('command.subject cannot contain header breaks');
    const text = contentText(command.text, 'command.text', MAX_BODY_BYTES);
    const contentSha256 = propertyPredatorEmailContentSha256(subject, text);
    if (!SHA256.test(command.approval.approvedContentSha256)
        || command.approval.approvedContentSha256 !== contentSha256) {
      return blocked('approval_content_mismatch');
    }
    const approval: ControlledEmailPilotApproval = Object.freeze({
      messageVersionId: uuid(command.approval.messageVersionId, 'approval.messageVersionId'),
      approvalRequestId: uuid(command.approval.approvalRequestId, 'approval.approvalRequestId'),
      approvalDecisionId: uuid(command.approval.approvalDecisionId, 'approval.approvalDecisionId'),
      approvedContentSha256: contentSha256,
    });

    if (!Array.isArray(command.recipients) || command.recipients.length < 1
        || command.recipients.length > policy.maxRecipients
        || command.recipients.length > PROPERTY_PREDATOR_EMAIL_HARD_MAX_RECIPIENTS) {
      return blocked('recipient_limit');
    }
    const recipients = command.recipients.map((recipient): CanonicalRecipientEvidence => {
      const email = normalizeOwnedInternalSeedEmail(recipient.email);
      return Object.freeze({
        email,
        emailSha256: sha256(email),
        contactPointId: uuid(recipient.contactPointId, 'recipient.contactPointId'),
        consentEventId: uuid(recipient.consentEventId, 'recipient.consentEventId'),
      });
    }).sort((left, right) => left.email.localeCompare(right.email));
    if (new Set(recipients.map((recipient) => recipient.email)).size !== recipients.length
        || new Set(recipients.map((recipient) => recipient.contactPointId)).size !== recipients.length) {
      return blocked('duplicate_recipient');
    }
    if (recipients.some((recipient) => !this.#allowlist.has(recipient.email))) {
      return blocked('recipient_not_allowlisted');
    }
    // The durable delivery/evidence model intentionally maps one provider
    // operation to one recipient. The ten-seed pilot is ten independently
    // approved/idempotent operations, never one opaque bulk Mailgun request.
    if (recipients.length !== 1) return blocked('single_recipient_operation_required');
    const requestedMessages = recipients.length;
    const estimatedSpendUsdMicros = requestedMessages * policy.estimatedCostUsdMicrosPerRecipient;
    if (requestedMessages > policy.maxMessagesPerRun) return blocked('run_message_cap');
    if (estimatedSpendUsdMicros > policy.maxSpendUsdMicrosPerRun) return blocked('run_spend_cap');

    const idempotencyKeySha256 = sha256(context.idempotencyKey);
    const requestSha256 = sha256(JSON.stringify({
      schemaVersion: 1,
      workspaceId: policy.workspaceId,
      providerConnectionId: policy.providerConnectionId,
      operationId: context.operationId,
      correlationId: context.correlationId,
      idempotencyKeySha256,
      runId: command.runId,
      stage: command.stage,
      recipientScope: command.recipientScope,
      subject,
      text,
      approval,
      recipients,
    }));
    const input: ControlledEmailPilotBoundaryInput = Object.freeze({
      workspaceId: policy.workspaceId,
      providerConnectionId: policy.providerConnectionId,
      operationId: context.operationId,
      correlationId: context.correlationId,
      idempotencyKeySha256,
      requestSha256,
      runId: command.runId,
      utcMonth: utcMonth(this.#now()),
      stage: PROPERTY_PREDATOR_EMAIL_PILOT_STAGE,
      recipientScope: PROPERTY_PREDATOR_EMAIL_RECIPIENT_SCOPE,
      approval,
      recipients: Object.freeze(recipients),
      requestedMessages,
      estimatedSpendUsdMicros,
      limits: Object.freeze({
        maxMessagesPerRun: policy.maxMessagesPerRun,
        maxMessagesPerUtcMonth: policy.maxMessagesPerUtcMonth,
        maxSpendUsdMicrosPerRun: policy.maxSpendUsdMicrosPerRun,
        maxSpendUsdMicrosPerUtcMonth: policy.maxSpendUsdMicrosPerUtcMonth,
      }),
    });

    const decision = await this.dependencies.boundary.authorizeImmediatelyBeforeProviderCall(input);
    if (decision.disposition === 'blocked') {
      return blocked(SAFE_REASON.test(decision.reason) ? decision.reason : 'authorization_blocked');
    }
    if (decision.requestSha256 !== requestSha256) {
      if (decision.disposition === 'authorized') {
        await this.dependencies.boundary.cancelBeforeProviderCall(
          decision.reservationId, decision.requestSha256, 'request_digest_mismatch',
        );
      }
      return blocked('idempotency_conflict');
    }
    if (decision.disposition === 'replay') {
      validateProviderResult(decision.result);
      return Object.freeze({
        disposition: 'replayed', reason: null, requestSha256,
        providerResult: decision.result,
      });
    }
    if (!UUID.test(decision.reservationId)
        || !validCurrentEvidence(decision.evidence, input)) {
      await this.dependencies.boundary.cancelBeforeProviderCall(
        decision.reservationId, requestSha256, 'invalid_current_evidence',
      );
      return blocked('authorization_evidence_invalid');
    }
    if (command.signal?.aborted) {
      await this.dependencies.boundary.cancelBeforeProviderCall(
        decision.reservationId, requestSha256, 'request_aborted',
      );
      return blocked('request_aborted');
    }

    const providerContext = createProviderOperationContext({
      connection: Object.freeze({
        id: policy.providerConnectionId,
        workspaceId: policy.workspaceId,
        providerId: PROPERTY_PREDATOR_EMAIL_PROVIDER_ID,
      }),
      operationId: context.operationId,
      correlationId: context.correlationId,
      idempotencyKey: requestSha256,
    });
    let result: ProviderOperationResult;
    try {
      result = await this.dependencies.transport.send(providerContext, Object.freeze({
        recipients: Object.freeze(recipients.map((recipient) => recipient.email)),
        subject,
        text,
        idempotencySha256: requestSha256,
        signal: command.signal,
      }));
      validateProviderResult(result);
    } catch (error) {
      result = Object.freeze({
        status: 'needs_attention', externalId: null, occurredAt: this.#now().toISOString(),
        retryable: false,
        errorCode: error instanceof MailgunOutcomeUnknownError
          ? error.code : 'mailgun_unexpected_transport_exception',
        summary: 'Mailgun call outcome requires manual reconciliation before any retry',
      });
    }
    await this.dependencies.boundary.settleProviderCall(
      decision.reservationId,
      requestSha256,
      result,
    );
    return Object.freeze({
      disposition: 'settled', reason: null, requestSha256, providerResult: result,
    });
  }
}
