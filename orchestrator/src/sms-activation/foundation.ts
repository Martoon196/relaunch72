/**
 * Effect-free Twilio SMS activation readiness for one exact owned recipient.
 *
 * Nothing here sends, enqueues, opens a socket or reaches Twilio. The owned
 * recipient crosses every boundary as a digest and is never returned.
 */

import { createHash } from 'node:crypto';

export const SMS_ACTIVATION_CONTRACT =
  'propertypredator.twilio-sms-activation-readiness/v1' as const;

/** One row per dimension, in the exact order the 0060 probe emits them. */
export const SMS_ACTIVATION_DIMENSIONS = Object.freeze([
  'operator_authority',
  'owned_binding',
  'provider_connection',
  'sender_endpoint',
  'approved_message',
  'recipient_endpoint',
  'recipient_matches_supplied_owned_target',
  'current_consent',
  'suppression_clear',
  'segment_cap_headroom',
  'receipt_path_clear',
  'emergency_pause_clear',
] as const);

export type SmsActivationDimension = (typeof SMS_ACTIVATION_DIMENSIONS)[number];

/** Non-sensitive codes only: no recipient, account SID or credential. */
export const SMS_ACTIVATION_BLOCKER_CODES = Object.freeze([
  'OPERATOR_AUTHORITY_REQUIRED',
  'IDENTITY_BINDING_REQUIRED',
  'IDENTITY_BINDING_REVOKED',
  'PROVIDER_NOT_CONFIGURED',
  'SENDER_ENDPOINT_REQUIRED',
  'APPROVED_CONTENT_REQUIRED',
  'RECIPIENT_ENDPOINT_UNVERIFIED',
  'RECIPIENT_EVIDENCE_MISMATCH',
  'CONSENT_NOT_CURRENT',
  'SUPPRESSION_ACTIVE',
  'CAP_REACHED',
  'OUTCOME_UNKNOWN_QUARANTINED',
  'EMERGENCY_PAUSED',
] as const);

export type SmsActivationBlockerCode = (typeof SMS_ACTIVATION_BLOCKER_CODES)[number];

export interface SmsActivationDimensionResult {
  readonly dimension: SmsActivationDimension;
  readonly ready: boolean;
  readonly blockerCode: SmsActivationBlockerCode | null;
}

export interface SmsActivationReadinessReport {
  readonly schemaVersion: 1;
  readonly contract: typeof SMS_ACTIVATION_CONTRACT;
  readonly result: 'ready-for-separately-authorised-owned-test' | 'blocked';
  readonly providerEffects: false;
  readonly providerCallsMade: false;
  readonly messagesSent: false;
  readonly dimensions: readonly SmsActivationDimensionResult[];
  readonly blockers: readonly SmsActivationBlockerCode[];
  readonly nextStep: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const UK_E164 = /^\+44[0-9]{9,10}$/u;

/** Twilio identifier shapes, so a founder cannot bind an obviously wrong value. */
export const TWILIO_ACCOUNT_SID_SHAPE = /^AC[0-9a-f]{32}$/u;
export const TWILIO_MESSAGING_SERVICE_SID_SHAPE = /^MG[0-9a-f]{32}$/u;

export const SMS_DAILY_SEGMENT_HARD_CAP = 10 as const;
export const SMS_MONTHLY_SEGMENT_HARD_CAP = 50 as const;

/**
 * Unit separator, matching the chr(31) convention the migrations use. Joining
 * without one would let two different stagings collide on the same digest.
 */
const DIGEST_FIELD_SEPARATOR = String.fromCharCode(31);

export class SmsActivationError extends Error {
  constructor(readonly code: 'invalid_target' | 'invalid_evidence' | 'invalid_staging') {
    super(`Twilio SMS activation failed: ${code}`);
    this.name = 'SmsActivationError';
  }
}

/** Mirrors 0056: only the digest of the E.164 recipient ever travels. */
export function ownedSmsRecipientDigest(recipient: string): string {
  const trimmed = recipient.trim();
  if (!UK_E164.test(trimmed)) throw new SmsActivationError('invalid_target');
  return createHash('sha256').update(trimmed, 'utf8').digest('hex');
}

export interface SmsActivationTarget {
  readonly workspaceId: string;
  readonly bindingId: string;
  readonly messageVersionId: string;
  readonly messageApprovalDecisionId: string;
  readonly contactId: string;
  readonly contactPointId: string;
  readonly consentEventId: string;
  readonly purpose: string;
  readonly expectedRecipientSha256: string;
}

/**
 * The scope-bound idempotency key a founder staging command supplies. 0056
 * re-derives the *request* digest itself, but never this one, so fixing the
 * definition here is what makes a replay collapse onto one job.
 */
export function deriveSmsStagingIdempotencyKey(
  target: SmsActivationTarget,
  providerConnectionId: string,
  authorityValidUntil: string,
): string {
  if (!UUID.test(providerConnectionId)
      || !UUID.test(target.messageVersionId)
      || !UUID.test(target.messageApprovalDecisionId)
      || !UUID.test(target.consentEventId)
      || !Number.isFinite(Date.parse(authorityValidUntil))
      || new Date(authorityValidUntil).toISOString() !== authorityValidUntil) {
    throw new SmsActivationError('invalid_staging');
  }
  return createHash('sha256').update([
    SMS_ACTIVATION_CONTRACT,
    target.workspaceId,
    providerConnectionId,
    target.bindingId,
    target.messageVersionId,
    target.messageApprovalDecisionId,
    target.contactPointId,
    target.consentEventId,
    authorityValidUntil,
  ].join(DIGEST_FIELD_SEPARATOR), 'utf8').digest('hex');
}

/** Builds the report from database rows, revalidating the probe as untrusted. */
export function buildSmsActivationReadinessReport(
  rows: readonly SmsActivationDimensionResult[],
): SmsActivationReadinessReport {
  if (rows.length !== SMS_ACTIVATION_DIMENSIONS.length) {
    throw new SmsActivationError('invalid_evidence');
  }
  const codes: ReadonlySet<string> = new Set(SMS_ACTIVATION_BLOCKER_CODES);
  const seen = new Set<string>();
  const dimensions = rows.map((row, index): SmsActivationDimensionResult => {
    if (row.dimension !== SMS_ACTIVATION_DIMENSIONS[index]
        || seen.has(row.dimension)
        || typeof row.ready !== 'boolean'
        || (row.ready && row.blockerCode !== null)
        || (!row.ready && (row.blockerCode === null || !codes.has(row.blockerCode)))) {
      throw new SmsActivationError('invalid_evidence');
    }
    seen.add(row.dimension);
    return Object.freeze({
      dimension: row.dimension,
      ready: row.ready,
      blockerCode: row.blockerCode,
    });
  });
  const blockers = Object.freeze(dimensions
    .filter((entry): entry is SmsActivationDimensionResult & {
      blockerCode: SmsActivationBlockerCode;
    } => entry.blockerCode !== null)
    .map((entry) => entry.blockerCode));
  const ready = blockers.length === 0;
  return Object.freeze({
    schemaVersion: 1,
    contract: SMS_ACTIVATION_CONTRACT,
    result: ready ? 'ready-for-separately-authorised-owned-test' : 'blocked',
    providerEffects: false,
    providerCallsMade: false,
    messagesSent: false,
    dimensions: Object.freeze(dimensions),
    blockers,
    nextStep: ready
      ? 'Durable owned-recipient evidence is proven. A first SMS still requires separate authorisation, delivery enablement and an explicit pause decision.'
      : 'Resolve the listed blockers. No command, enqueue or provider call was attempted.',
  });
}

export function formatSmsActivationReadiness(
  report: SmsActivationReadinessReport,
): string {
  return [
    'Property Predator Twilio SMS activation readiness',
    'ZERO SEND — no enqueue, provider call or message dispatch occurred.',
    `Result: ${report.result === 'blocked' ? 'BLOCKED' : 'READY FOR SEPARATE OWNED-TEST AUTHORISATION'}`,
    '',
    'Durable evidence',
    ...report.dimensions.map((entry) => `[${entry.ready ? 'PASS' : 'BLOCKED'}] ${entry.dimension}`
      + (entry.blockerCode ? ` — ${entry.blockerCode}` : '')),
    '',
    report.nextStep,
  ].join('\n');
}
