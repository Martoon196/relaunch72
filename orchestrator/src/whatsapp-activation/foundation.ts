/**
 * Zero-send activation readiness for one exact founder-owned WhatsApp target.
 *
 * The 0053 command boundary deliberately answers every failed enqueue with one
 * opaque denial. That is right for a command, but it means the only way to
 * learn why a first owned-number rehearsal is blocked would be to attempt a
 * real send. This module reduces a supplied owned target to per-dimension
 * boolean evidence and non-sensitive blocker codes.
 *
 * It never sends, never enqueues, never reaches a provider and never returns
 * the recipient. The number is converted to a digest before it crosses any
 * boundary, exactly as `app_private.authorize_and_enqueue_whatsapp_live_job`
 * derives it, so the probe can prove the database would dial the same number
 * without ever disclosing it.
 */

import { createHash } from 'node:crypto';

export const WHATSAPP_ACTIVATION_READINESS_CONTRACT =
  'propertypredator.whatsapp-activation-readiness/v1' as const;

/** One row per dimension, in the exact order the database probe emits them. */
export const WHATSAPP_ACTIVATION_DIMENSIONS = Object.freeze([
  'operator_authority',
  'provider_connection',
  'owned_binding',
  'approved_template',
  'template_content_current',
  'recipient_endpoint',
  'recipient_matches_supplied_owned_target',
  'current_consent',
  'suppression_clear',
  'inbound_ingress',
  'cap_headroom',
  'emergency_pause_clear',
] as const);

export type WhatsAppActivationDimension =
  (typeof WHATSAPP_ACTIVATION_DIMENSIONS)[number];

/**
 * Non-sensitive codes only. Nothing here can carry a number, token, provider
 * payload or database error text.
 */
export const WHATSAPP_ACTIVATION_BLOCKER_CODES = Object.freeze([
  'OPERATOR_AUTHORITY_REQUIRED',
  'PROVIDER_NOT_CONFIGURED',
  'IDENTITY_BINDING_REQUIRED',
  'BINDING_REVOKED',
  'TEMPLATE_NOT_APPROVED',
  'TEMPLATE_CONTENT_SUPERSEDED',
  'RECIPIENT_ENDPOINT_UNVERIFIED',
  'RECIPIENT_EVIDENCE_MISMATCH',
  'CONSENT_NOT_CURRENT',
  'SUPPRESSION_ACTIVE',
  'INGRESS_NOT_READY',
  'CAP_REACHED',
  'EMERGENCY_PAUSED',
] as const);

export type WhatsAppActivationBlockerCode =
  (typeof WHATSAPP_ACTIVATION_BLOCKER_CODES)[number];

export interface WhatsAppActivationDimensionResult {
  readonly dimension: WhatsAppActivationDimension;
  readonly ready: boolean;
  readonly blockerCode: WhatsAppActivationBlockerCode | null;
}

/**
 * Evidence that cannot honestly be pre-proved. The PECR sender and instigator
 * routes and the permission-use receipt are bound to the exact request id of
 * the command that consumes them, so they are supplied and checked at command
 * time. Claiming them here would be a false readiness signal.
 */
export const WHATSAPP_ACTIVATION_COMMAND_TIME_EVIDENCE = Object.freeze([
  'compliance_subject_id',
  'policy_publication_event_id',
  'pecr_sender_decision_event_id',
  'pecr_instigator_decision_event_id',
  'permission_use_receipt_id',
] as const);

export interface WhatsAppActivationReadinessReport {
  readonly schemaVersion: 1;
  readonly contract: typeof WHATSAPP_ACTIVATION_READINESS_CONTRACT;
  readonly result: 'ready-for-separately-authorised-owned-test' | 'blocked';
  readonly providerEffects: false;
  readonly providerCallsMade: false;
  readonly messagesSent: false;
  readonly dimensions: readonly WhatsAppActivationDimensionResult[];
  readonly blockers: readonly WhatsAppActivationBlockerCode[];
  readonly commandTimeEvidence: readonly string[];
  readonly nextStep: string;
}

/** The exact owned target, carrying a digest rather than the number. */
export interface WhatsAppActivationTarget {
  readonly workspaceId: string;
  readonly bindingId: string;
  readonly templateId: string;
  readonly contactId: string;
  readonly contactPointId: string;
  readonly consentEventId: string;
  readonly purpose: string;
  readonly expectedRecipientSha256: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const UK_E164 = /^\+44[0-9]{9,10}$/u;
const PURPOSE = /^[a-z][a-z0-9_.-]{0,99}$/u;

const DIMENSION_SET: ReadonlySet<string> = new Set(WHATSAPP_ACTIVATION_DIMENSIONS);
const BLOCKER_SET: ReadonlySet<string> = new Set(WHATSAPP_ACTIVATION_BLOCKER_CODES);

export class WhatsAppActivationReadinessError extends Error {
  constructor(readonly code: 'invalid_target' | 'invalid_evidence') {
    super(`WhatsApp activation readiness failed: ${code}`);
    this.name = 'WhatsAppActivationReadinessError';
  }
}

/**
 * Mirrors the database exactly: the recipient is normalised to E.164 without
 * its leading plus, then hashed. Only the digest travels.
 */
export function ownedWhatsAppRecipientDigest(recipient: string): string {
  const trimmed = recipient.trim();
  if (!UK_E164.test(trimmed)) {
    throw new WhatsAppActivationReadinessError('invalid_target');
  }
  return createHash('sha256').update(trimmed.slice(1), 'utf8').digest('hex');
}

/** Every setting the probe needs, so a founder can be told what is missing. */
export const WHATSAPP_ACTIVATION_TARGET_SETTINGS = Object.freeze([
  'PROPERTY_PREDATOR_REHEARSAL_WORKSPACE_ID',
  'PROPERTY_PREDATOR_WHATSAPP_LIVE_BINDING_ID',
  'PROPERTY_PREDATOR_REHEARSAL_WHATSAPP_TEMPLATE_ID',
  'PROPERTY_PREDATOR_REHEARSAL_WHATSAPP_PERSON_ID',
  'PROPERTY_PREDATOR_REHEARSAL_WHATSAPP_ENDPOINT_ID',
  'PROPERTY_PREDATOR_REHEARSAL_WHATSAPP_CONSENT_EVIDENCE_ID',
  'PROPERTY_PREDATOR_REHEARSAL_WHATSAPP_PURPOSE',
  'PROPERTY_PREDATOR_REHEARSAL_WHATSAPP_RECIPIENT',
  'PROPERTY_PREDATOR_REHEARSAL_WHATSAPP_RECIPIENT_OWNED',
] as const);

export type WhatsAppActivationTargetOutcome =
  | Readonly<{ ok: true; target: WhatsAppActivationTarget }>
  | Readonly<{ ok: false; missing: readonly string[] }>;

/**
 * Reads the exact supplied owned target. A recipient is never invented: every
 * identifier must be supplied explicitly, and the ownership attestation must
 * be an affirmative 'true'.
 */
export function readWhatsAppActivationTarget(
  env: NodeJS.ProcessEnv,
): WhatsAppActivationTargetOutcome {
  const missing: string[] = [];
  const value = (setting: string): string => (env[setting] ?? '').trim();
  const uuid = (setting: string): string => {
    const raw = value(setting);
    if (!UUID.test(raw)) missing.push(setting);
    return raw;
  };
  const workspaceId = uuid('PROPERTY_PREDATOR_REHEARSAL_WORKSPACE_ID');
  const bindingId = uuid('PROPERTY_PREDATOR_WHATSAPP_LIVE_BINDING_ID');
  const templateId = uuid('PROPERTY_PREDATOR_REHEARSAL_WHATSAPP_TEMPLATE_ID');
  const contactId = uuid('PROPERTY_PREDATOR_REHEARSAL_WHATSAPP_PERSON_ID');
  const contactPointId = uuid('PROPERTY_PREDATOR_REHEARSAL_WHATSAPP_ENDPOINT_ID');
  const consentEventId = uuid('PROPERTY_PREDATOR_REHEARSAL_WHATSAPP_CONSENT_EVIDENCE_ID');
  const purpose = value('PROPERTY_PREDATOR_REHEARSAL_WHATSAPP_PURPOSE');
  if (!PURPOSE.test(purpose)) missing.push('PROPERTY_PREDATOR_REHEARSAL_WHATSAPP_PURPOSE');
  const recipient = value('PROPERTY_PREDATOR_REHEARSAL_WHATSAPP_RECIPIENT');
  if (!UK_E164.test(recipient)) missing.push('PROPERTY_PREDATOR_REHEARSAL_WHATSAPP_RECIPIENT');
  if (value('PROPERTY_PREDATOR_REHEARSAL_WHATSAPP_RECIPIENT_OWNED').toLowerCase() !== 'true') {
    missing.push('PROPERTY_PREDATOR_REHEARSAL_WHATSAPP_RECIPIENT_OWNED');
  }
  if (missing.length > 0) return Object.freeze({ ok: false, missing: Object.freeze(missing) });
  return Object.freeze({
    ok: true,
    target: Object.freeze({
      workspaceId,
      bindingId,
      templateId,
      contactId,
      contactPointId,
      consentEventId,
      purpose,
      expectedRecipientSha256: ownedWhatsAppRecipientDigest(recipient),
    }),
  });
}

/**
 * Builds the report from database rows. Every row is revalidated: the probe is
 * treated as untrusted input, and an unknown dimension or code is a hard
 * failure rather than a silently passed readiness claim.
 */
export function buildWhatsAppActivationReadinessReport(
  rows: readonly WhatsAppActivationDimensionResult[],
): WhatsAppActivationReadinessReport {
  if (rows.length !== WHATSAPP_ACTIVATION_DIMENSIONS.length) {
    throw new WhatsAppActivationReadinessError('invalid_evidence');
  }
  const seen = new Set<string>();
  const dimensions = rows.map((row, index): WhatsAppActivationDimensionResult => {
    if (!DIMENSION_SET.has(row.dimension)
        || row.dimension !== WHATSAPP_ACTIVATION_DIMENSIONS[index]
        || seen.has(row.dimension)
        || typeof row.ready !== 'boolean'
        || (row.ready && row.blockerCode !== null)
        || (!row.ready && (row.blockerCode === null || !BLOCKER_SET.has(row.blockerCode)))) {
      throw new WhatsAppActivationReadinessError('invalid_evidence');
    }
    seen.add(row.dimension);
    return Object.freeze({
      dimension: row.dimension,
      ready: row.ready,
      blockerCode: row.blockerCode,
    });
  });
  const blockers = Object.freeze(dimensions
    .filter((entry): entry is WhatsAppActivationDimensionResult & {
      blockerCode: WhatsAppActivationBlockerCode;
    } => entry.blockerCode !== null)
    .map((entry) => entry.blockerCode));
  const ready = blockers.length === 0;
  return Object.freeze({
    schemaVersion: 1,
    contract: WHATSAPP_ACTIVATION_READINESS_CONTRACT,
    result: ready ? 'ready-for-separately-authorised-owned-test' : 'blocked',
    providerEffects: false,
    providerCallsMade: false,
    messagesSent: false,
    dimensions: Object.freeze(dimensions),
    blockers,
    commandTimeEvidence: WHATSAPP_ACTIVATION_COMMAND_TIME_EVIDENCE,
    nextStep: ready
      ? 'Durable owned-target evidence is proven. A first WhatsApp effect still requires separate authorisation and the command-time PECR and permission-use evidence listed above.'
      : 'Resolve the listed blockers. No command, enqueue or provider call was attempted.',
  });
}

export function formatWhatsAppActivationReadiness(
  report: WhatsAppActivationReadinessReport,
): string {
  const lines = [
    'Property Predator Meta WhatsApp activation readiness',
    'ZERO SEND — no enqueue, provider call or message dispatch occurred.',
    `Result: ${report.result === 'blocked' ? 'BLOCKED' : 'READY FOR SEPARATE OWNED-TEST AUTHORISATION'}`,
    '',
    'Durable evidence',
    ...report.dimensions.map((entry) => `[${entry.ready ? 'PASS' : 'BLOCKED'}] ${entry.dimension}`
      + (entry.blockerCode ? ` — ${entry.blockerCode}` : '')),
    '',
    'Supplied at command time (cannot be pre-proved; request-bound)',
    ...report.commandTimeEvidence.map((item) => `[DEFERRED] ${item}`),
    '',
    report.nextStep,
  ];
  return lines.join('\n');
}
