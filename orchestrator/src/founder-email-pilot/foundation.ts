/**
 * Founder customer-email pilot: typed contracts for the two launch-critical
 * seams a live acceptance walkthrough exposed.
 *
 * The first is attaching a verified email endpoint to an existing contact. The
 * only prior route to an endpoint was "Create a lead", which would have
 * duplicated the founder contact and its opportunity.
 *
 * The second is knowing why the capped enqueue would refuse. It demands
 * twenty-one exact evidence identifiers; preparing, approving and staging
 * content produces only some of them, and nothing named the rest. The readiness
 * report turns that into a list a founder can act on.
 *
 * Nothing here sends, enqueues or reaches Mailgun.
 */

import { createHash } from 'node:crypto';

/** Dimensions in the exact order the 0064 probe emits them. */
export const FOUNDER_EMAIL_PILOT_DIMENSIONS = Object.freeze([
  'operator_authority',
  'provider_connection',
  'recipient_endpoint',
  'sender_endpoint',
  'current_consent',
  'suppression_clear',
  'approved_campaign_version',
  'approved_message_version',
  'approved_pilot_content',
  'cap_headroom',
] as const);

export type FounderEmailPilotDimension = typeof FOUNDER_EMAIL_PILOT_DIMENSIONS[number];

export const FOUNDER_EMAIL_PILOT_BLOCKER_CODES = Object.freeze([
  'OPERATOR_NOT_AUTHORISED',
  'PROVIDER_NOT_CONFIGURED',
  'RECIPIENT_ENDPOINT_MISSING',
  'SENDER_ENDPOINT_MISSING',
  'CONSENT_NOT_GRANTED',
  'RECIPIENT_SUPPRESSED',
  'CAMPAIGN_APPROVAL_REQUIRED',
  'MESSAGE_APPROVAL_REQUIRED',
  'PILOT_CONTENT_NOT_APPROVED',
  'CAP_REACHED',
] as const);

export type FounderEmailPilotBlockerCode = typeof FOUNDER_EMAIL_PILOT_BLOCKER_CODES[number];

/** Plain-English copy for the founder surface, one line per blocker. */
export const FOUNDER_EMAIL_PILOT_BLOCKER_MESSAGES: Readonly<
  Record<FounderEmailPilotBlockerCode, string>
> = Object.freeze({
  OPERATOR_NOT_AUTHORISED:
    'Only an active owner or admin of this workspace can authorise the pilot.',
  PROVIDER_NOT_CONFIGURED:
    'No active live Mailgun EU connection is bound for this workspace.',
  RECIPIENT_ENDPOINT_MISSING:
    'This contact has no verified, unquarantined email endpoint to send to.',
  SENDER_ENDPOINT_MISSING:
    'No active live email sender endpoint is bound to the provider connection.',
  CONSENT_NOT_GRANTED:
    'The latest recorded permission for this endpoint and purpose is not a grant.',
  RECIPIENT_SUPPRESSED:
    'A suppression is the latest record for this endpoint. It is never overridden here.',
  CAMPAIGN_APPROVAL_REQUIRED:
    'No approved campaign template version exists to send from.',
  MESSAGE_APPROVAL_REQUIRED:
    'No approved outbound email message version exists to send.',
  PILOT_CONTENT_NOT_APPROVED:
    'No approved pilot content is recorded for this workspace.',
  CAP_REACHED:
    'The daily or monthly send cap is already used. Nothing more can be queued.',
});

export interface FounderEmailPilotDimensionResult {
  readonly dimension: FounderEmailPilotDimension;
  readonly ready: boolean;
  readonly blockerCode: FounderEmailPilotBlockerCode | null;
}

export interface FounderEmailPilotReadinessReport {
  readonly schemaVersion: 1;
  readonly result: 'ready-for-founder-authorisation' | 'blocked';
  /** Always false. This report is evidence, never an enqueue. */
  readonly enqueued: false;
  readonly providerEffects: false;
  readonly dimensions: readonly FounderEmailPilotDimensionResult[];
  readonly blockers: readonly FounderEmailPilotBlockerCode[];
  readonly nextStep: string;
}

export class FounderEmailPilotError extends Error {
  readonly code: 'invalid_evidence';

  constructor(message: string) {
    super(message);
    this.name = 'FounderEmailPilotError';
    this.code = 'invalid_evidence';
  }
}

/**
 * Build the report from database rows, revalidating the probe as untrusted.
 *
 * A truncated or reordered result must throw rather than read as ready: an
 * empty blocker list from a short read would otherwise authorise a send.
 */
export function buildFounderEmailPilotReadinessReport(
  rows: readonly FounderEmailPilotDimensionResult[],
): FounderEmailPilotReadinessReport {
  if (rows.length !== FOUNDER_EMAIL_PILOT_DIMENSIONS.length) {
    throw new FounderEmailPilotError('readiness evidence is incomplete');
  }
  const codes: ReadonlySet<string> = new Set(FOUNDER_EMAIL_PILOT_BLOCKER_CODES);
  const seen = new Set<string>();
  const dimensions = rows.map((row, index): FounderEmailPilotDimensionResult => {
    if (row.dimension !== FOUNDER_EMAIL_PILOT_DIMENSIONS[index]
        || seen.has(row.dimension)
        || typeof row.ready !== 'boolean'
        || (row.ready && row.blockerCode !== null)
        || (!row.ready && (row.blockerCode === null || !codes.has(row.blockerCode)))) {
      throw new FounderEmailPilotError('readiness evidence is invalid');
    }
    seen.add(row.dimension);
    return Object.freeze({
      dimension: row.dimension,
      ready: row.ready,
      blockerCode: row.blockerCode,
    });
  });
  const blockers = Object.freeze(dimensions
    .filter((entry): entry is FounderEmailPilotDimensionResult & {
      blockerCode: FounderEmailPilotBlockerCode;
    } => entry.blockerCode !== null)
    .map((entry) => entry.blockerCode));
  const ready = blockers.length === 0;
  return Object.freeze({
    schemaVersion: 1 as const,
    result: ready ? 'ready-for-founder-authorisation' : 'blocked',
    enqueued: false as const,
    providerEffects: false as const,
    dimensions: Object.freeze(dimensions),
    blockers,
    nextStep: ready
      ? 'Every dimension is proven. Authorising a send is a separate, explicit act.'
      : 'Resolve the listed blockers. Nothing was queued and no provider was called.',
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const EVIDENCE_SOURCE = /^[a-z][a-z0-9_.:-]{0,99}$/u;
const REFERENCE = /^[\x21-\x7e][\x20-\x7e]{0,198}[\x21-\x7e]$|^[\x21-\x7e]$/u;
const PURPOSE = /^[a-z][a-z0-9_.-]{0,99}$/u;

/** Unit separator, matching the chr(31) convention the migrations use. */
const DIGEST_FIELD_SEPARATOR = String.fromCharCode(31);

/** Witnessed evidence only; an endpoint is never trusted from activity. */
export const CONTACT_ENDPOINT_EVIDENCE_SOURCES = Object.freeze([
  'founder.written_confirmation',
  'founder.signed_form',
  'founder.owned_mailbox',
  'founder.verified_reply',
] as const);

export type ContactEndpointEvidenceSource =
  typeof CONTACT_ENDPOINT_EVIDENCE_SOURCES[number];

export interface AttachContactEmailEndpointInput {
  readonly contactId: string;
  readonly email: string;
  readonly label: string | null;
  readonly evidenceSource: string;
  readonly evidenceReference: string;
  readonly verifiedAt: string;
  readonly operatorConfirmed: boolean;
}

export interface AttachContactEmailEndpointCommand {
  readonly contactId: string;
  readonly email: string;
  readonly label: string | null;
  readonly evidenceSource: ContactEndpointEvidenceSource;
  readonly evidenceReference: string;
  readonly verifiedAt: string;
}

function isCanonicalInstant(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

export function parseAttachContactEmailEndpoint(
  input: AttachContactEmailEndpointInput,
): AttachContactEmailEndpointCommand {
  const fail = (reason: string): never => {
    throw new FounderEmailPilotError(reason);
  };
  if (input.operatorConfirmed !== true) fail('operator confirmation is required');
  if (!UUID.test(input.contactId)) fail('contact id is invalid');
  const email = typeof input.email === 'string' ? input.email.trim() : '';
  if (!EMAIL.test(email) || email.length < 3 || email.length > 320) {
    fail('email address is invalid');
  }
  if (!(CONTACT_ENDPOINT_EVIDENCE_SOURCES as readonly string[])
    .includes(input.evidenceSource)) {
    fail('evidence source is not a witnessed source');
  }
  if (!EVIDENCE_SOURCE.test(input.evidenceSource)) fail('evidence source is invalid');
  const reference = typeof input.evidenceReference === 'string'
    ? input.evidenceReference.trim() : '';
  if (!REFERENCE.test(reference)) fail('evidence reference is invalid');
  const label = input.label === null ? null : String(input.label).trim();
  if (label !== null && (label.length < 1 || label.length > 50)) fail('label is invalid');
  if (!isCanonicalInstant(input.verifiedAt)) fail('verification time is invalid');
  return Object.freeze({
    contactId: input.contactId.toLowerCase(),
    email,
    label,
    evidenceSource: input.evidenceSource as ContactEndpointEvidenceSource,
    evidenceReference: reference,
    verifiedAt: input.verifiedAt,
  });
}

/** Workspace-scoped idempotency digest for either founder command. */
export function deriveFounderPilotCommandKey(
  context: 'contact-endpoint-attach' | 'email-pilot-authorise',
  workspaceId: string,
  commandKey: string,
): string {
  if (!UUID.test(workspaceId)) throw new FounderEmailPilotError('workspace id is invalid');
  if (!UUID.test(commandKey)) throw new FounderEmailPilotError('command key is invalid');
  return createHash('sha256').update([
    `propertypredator.founder-${context}/v1`,
    workspaceId.toLowerCase(),
    commandKey.toLowerCase(),
  ].join(DIGEST_FIELD_SEPARATOR), 'utf8').digest('hex');
}

export function isFounderPilotPurpose(value: unknown): value is string {
  return typeof value === 'string' && PURPOSE.test(value);
}
