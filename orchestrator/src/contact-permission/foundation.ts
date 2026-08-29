/**
 * Founder-operated contact permission decisions.
 *
 * This is a typed seam over the existing consent ledger, not a second consent
 * system. Decisions live in app.communication_consent_events and suppression
 * lives in app.communication_suppression_events exactly as before; 0063 adds
 * only the founder command boundary and its idempotency receipt.
 *
 * Two rules are load-bearing and are enforced here as well as in the database.
 * A grant never touches suppression, so a suppressed endpoint stays suppressed
 * whatever permission is recorded. And permission is never inferred: no login,
 * account creation, CRM stage, opportunity, previous send or site activity may
 * be presented as evidence, so the evidence source is a closed set of things a
 * human actually witnessed.
 */

import { createHash } from 'node:crypto';

/** The three decisions a founder may record. Nothing else is a permission act. */
export const CONTACT_PERMISSION_DECISIONS = Object.freeze([
  'granted',
  'denied',
  'withdrawn',
] as const);

export type ContactPermissionDecision = typeof CONTACT_PERMISSION_DECISIONS[number];

/** Channels this workflow supports, matching the existing endpoint kinds. */
export const CONTACT_PERMISSION_CHANNELS = Object.freeze(['email', 'sms', 'whatsapp'] as const);

export type ContactPermissionChannel = typeof CONTACT_PERMISSION_CHANNELS[number];

/** app.contact_points.kind for each supported channel. */
export const CONTACT_PERMISSION_ENDPOINT_KIND: Readonly<
  Record<ContactPermissionChannel, 'email' | 'phone' | 'whatsapp'>
> = Object.freeze({ email: 'email', sms: 'phone', whatsapp: 'whatsapp' });

export const CONTACT_PERMISSION_LAWFUL_BASES = Object.freeze([
  'consent',
  'legitimate_interests',
  'contract',
  'legal_obligation',
  'vital_interests',
  'public_task',
] as const);

export type ContactPermissionLawfulBasis = typeof CONTACT_PERMISSION_LAWFUL_BASES[number];

/**
 * Evidence a human can actually witness and later produce.
 *
 * Inferred signals are deliberately absent. A login, a created account, a
 * pipeline stage, an opportunity, an earlier send or a page view is not
 * permission, and leaving them out of this set means the workflow cannot be
 * pointed at them even by mistake.
 */
export const CONTACT_PERMISSION_EVIDENCE_SOURCES = Object.freeze([
  'founder.written_confirmation',
  'founder.recorded_call',
  'founder.signed_form',
  'founder.inbound_request',
  'founder.verbal_confirmation',
] as const);

export type ContactPermissionEvidenceSource =
  typeof CONTACT_PERMISSION_EVIDENCE_SOURCES[number];

/** Signals that must never be offered or accepted as permission evidence. */
export const CONTACT_PERMISSION_FORBIDDEN_INFERENCES = Object.freeze([
  'login',
  'account_creation',
  'crm_stage',
  'opportunity',
  'previous_send',
  'site_activity',
] as const);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PURPOSE = /^[a-z][a-z0-9_.-]{0,99}$/u;
const POLICY_VERSION = /^[\x20-\x7e]{1,100}$/u;
const SOURCE_EVENT_ID = /^[\x21-\x7e][\x20-\x7e]{0,253}[\x21-\x7e]$|^[\x21-\x7e]$/u;
const SHA256_HEX = /^[0-9a-f]{64}$/u;

/** Unit separator, matching the chr(31) convention the migrations use. */
const DIGEST_FIELD_SEPARATOR = String.fromCharCode(31);

export class ContactPermissionError extends Error {
  readonly code: 'invalid_decision';

  constructor(message: string) {
    super(message);
    this.name = 'ContactPermissionError';
    this.code = 'invalid_decision';
  }
}

export interface ContactPermissionDecisionInput {
  readonly contactId: string;
  readonly contactPointId: string;
  readonly channel: string;
  readonly purpose: string;
  readonly decision: string;
  readonly lawfulBasis: string | null;
  readonly evidenceSource: string;
  readonly policyVersion: string | null;
  readonly policyTextSha256: string | null;
  readonly sourceEventId: string | null;
  readonly occurredAt: string;
  readonly operatorConfirmed: boolean;
}

export interface ContactPermissionDecisionCommand {
  readonly contactId: string;
  readonly contactPointId: string;
  readonly channel: ContactPermissionChannel;
  readonly purpose: string;
  readonly decision: ContactPermissionDecision;
  readonly lawfulBasis: ContactPermissionLawfulBasis | null;
  readonly evidenceSource: ContactPermissionEvidenceSource;
  readonly policyVersion: string | null;
  readonly policyTextSha256: string | null;
  readonly sourceEventId: string | null;
  readonly occurredAt: string;
}

function isCanonicalInstant(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

/**
 * Validate one decision into the exact shape 0063 accepts.
 *
 * The operator confirmation is required here rather than treated as a UI
 * nicety: recording a permission decision is a deliberate legal act, and an
 * unconfirmed submission must never reach the database.
 */
export function parseContactPermissionDecision(
  input: ContactPermissionDecisionInput,
): ContactPermissionDecisionCommand {
  const fail = (reason: string): never => {
    throw new ContactPermissionError(reason);
  };
  if (input.operatorConfirmed !== true) fail('operator confirmation is required');
  if (!UUID.test(input.contactId)) fail('contact id is invalid');
  if (!UUID.test(input.contactPointId)) fail('contact point id is invalid');
  if (!(CONTACT_PERMISSION_CHANNELS as readonly string[]).includes(input.channel)) {
    fail('channel is not supported');
  }
  if (!PURPOSE.test(input.purpose)) fail('purpose is invalid');
  if (!(CONTACT_PERMISSION_DECISIONS as readonly string[]).includes(input.decision)) {
    fail('decision is not a permission act');
  }
  if (!(CONTACT_PERMISSION_EVIDENCE_SOURCES as readonly string[])
    .includes(input.evidenceSource)) {
    fail('evidence source is not a witnessed source');
  }
  const decision = input.decision as ContactPermissionDecision;
  if (decision === 'granted') {
    if (input.lawfulBasis === null
      || !(CONTACT_PERMISSION_LAWFUL_BASES as readonly string[]).includes(input.lawfulBasis)) {
      fail('a granted permission requires a lawful basis');
    }
  } else if (input.lawfulBasis !== null) {
    fail('only a granted permission carries a lawful basis');
  }
  if (input.policyVersion !== null && !POLICY_VERSION.test(input.policyVersion)) {
    fail('policy version is invalid');
  }
  if (input.policyTextSha256 !== null && !SHA256_HEX.test(input.policyTextSha256)) {
    fail('policy text digest is invalid');
  }
  if (input.sourceEventId !== null && !SOURCE_EVENT_ID.test(input.sourceEventId)) {
    fail('evidence reference is invalid');
  }
  if (!isCanonicalInstant(input.occurredAt)) fail('effective time is invalid');
  return Object.freeze({
    contactId: input.contactId.toLowerCase(),
    contactPointId: input.contactPointId.toLowerCase(),
    channel: input.channel as ContactPermissionChannel,
    purpose: input.purpose,
    decision,
    lawfulBasis: (input.lawfulBasis as ContactPermissionLawfulBasis | null),
    evidenceSource: input.evidenceSource as ContactPermissionEvidenceSource,
    policyVersion: input.policyVersion,
    policyTextSha256: input.policyTextSha256,
    sourceEventId: input.sourceEventId,
    occurredAt: input.occurredAt,
  });
}

/**
 * Derive the idempotency key digest from the operator's command key.
 *
 * The key is scoped to the workspace and the exact decision so a key reused
 * for different content is a conflict in the database rather than a second
 * silent decision.
 */
export function deriveContactPermissionCommandKey(
  workspaceId: string,
  commandKey: string,
): string {
  if (!UUID.test(workspaceId)) {
    throw new ContactPermissionError('workspace id is invalid');
  }
  if (!UUID.test(commandKey)) {
    throw new ContactPermissionError('command key is invalid');
  }
  return createHash('sha256').update([
    'propertypredator.contact-permission-command/v1',
    workspaceId.toLowerCase(),
    commandKey.toLowerCase(),
  ].join(DIGEST_FIELD_SEPARATOR), 'utf8').digest('hex');
}

/** Human labels for the founder surface. */
export const CONTACT_PERMISSION_DECISION_LABELS: Readonly<
  Record<ContactPermissionDecision, string>
> = Object.freeze({
  granted: 'Permission granted',
  denied: 'Permission denied',
  withdrawn: 'Permission withdrawn',
});

export const CONTACT_PERMISSION_EVIDENCE_LABELS: Readonly<
  Record<ContactPermissionEvidenceSource, string>
> = Object.freeze({
  'founder.written_confirmation': 'Written confirmation from the contact',
  'founder.recorded_call': 'Recorded call with the contact',
  'founder.signed_form': 'Signed form from the contact',
  'founder.inbound_request': 'Inbound request from the contact',
  'founder.verbal_confirmation': 'Verbal confirmation, witnessed and noted',
});
