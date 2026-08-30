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
  'policy_authority',
  'pecr_decisions',
  'permission_use_receipt',
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
  'POLICY_AUTHORITY_MISSING',
  'PECR_DECISIONS_MISSING',
  'PERMISSION_USE_RECEIPT_MISSING',
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
  POLICY_AUTHORITY_MISSING:
    'No current published compliance policy pack covers this send.',
  PECR_DECISIONS_MISSING:
    'The PECR sender and instigator route decisions are not both approved and in force.',
  PERMISSION_USE_RECEIPT_MISSING:
    'No permission-use receipt is recorded for this operator on this request. '
    + 'The enqueue binds the receipt to the exact request that authorises it, so '
    + 'one must be consumed here rather than carried over from earlier.',
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

/**
 * True only for an exact round-tripping ISO instant.
 *
 * It never throws: `new Date('nonsense').toISOString()` raises a RangeError, and
 * a guard that throws turns a plainly invalid field into a reported outage.
 */
export function isCanonicalInstant(value: unknown): value is string {
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
  context: 'contact-endpoint-attach' | 'email-pilot-authorise' | 'email-permission-use'
    | 'founder-pilot-prepare' | 'founder-pilot-evidence',
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

/**
 * The exact tuple the enqueue re-validates, as the database resolved it.
 *
 * Subject and body are carried because a founder must read the precise words
 * that would leave the building, not a description of them.
 */
export interface FounderEmailPilotEvidence {
  readonly campaignTemplateVersionId: string;
  readonly campaignTemplateStepId: string;
  readonly campaignStepContentSha256: string;
  readonly campaignApprovalRequestId: string;
  readonly campaignApprovalDecisionId: string;
  readonly campaignVersionNo: number;
  readonly messageVersionId: string;
  readonly messageApprovalRequestId: string;
  readonly messageApprovalDecisionId: string;
  readonly messageVersionNumber: number;
  readonly channelEndpointId: string;
  readonly consentEventId: string;
  readonly complianceSubjectId: string;
  readonly policyPublicationEventId: string;
  readonly pecrSenderDecisionEventId: string;
  readonly pecrInstigatorDecisionEventId: string;
  readonly permissionUseReceiptId: string;
  readonly recipientEmail: string;
  readonly subject: string;
  readonly bodyText: string;
}

/** Field order for the evidence digest. Changing it changes every token. */
const EVIDENCE_DIGEST_FIELDS = Object.freeze([
  'campaignTemplateVersionId', 'campaignTemplateStepId', 'campaignStepContentSha256',
  'campaignApprovalRequestId', 'campaignApprovalDecisionId', 'messageVersionId',
  'messageApprovalRequestId', 'messageApprovalDecisionId', 'channelEndpointId',
  'consentEventId', 'complianceSubjectId', 'policyPublicationEventId',
  'pecrSenderDecisionEventId', 'pecrInstigatorDecisionEventId',
  'permissionUseReceiptId', 'recipientEmail', 'subject', 'bodyText',
] as const satisfies readonly (keyof FounderEmailPilotEvidence)[]);

/**
 * Digest of everything a founder was shown and approved.
 *
 * The preview token carries this. If any of it changes between the preview and
 * the authorisation — a new approval, a different body, another endpoint — the
 * token no longer matches the resolved evidence and the action refuses rather
 * than sending something the founder never read.
 */
export function founderEmailPilotEvidenceDigest(
  evidence: FounderEmailPilotEvidence,
): string {
  return createHash('sha256').update([
    'propertypredator.founder-email-pilot-evidence/v1',
    ...EVIDENCE_DIGEST_FIELDS.map((field) => String(evidence[field])),
  ].join(DIGEST_FIELD_SEPARATOR), 'utf8').digest('hex');
}

/**
 * Identifiers the enqueue records, derived from the command key alone.
 *
 * Deterministic on purpose: a resubmitted authorisation must present the same
 * delivery, provider operation, correlation id, idempotency key and request id,
 * so the enqueue recognises it as the same act and replays it. Random ids would
 * make every retry look like a new send.
 */
export interface FounderEmailPilotIdentifiers {
  readonly providerOperationId: string;
  readonly messageDeliveryId: string;
  readonly correlationId: string;
  readonly idempotencyKeySha256: string;
  readonly requestId: string;
}

/** A stable UUID from a digest, in the version and variant the rail accepts. */
function derivedUuid(seed: Buffer): string {
  const bytes = Buffer.from(seed.subarray(0, 16));
  // Version 5 and the RFC variant, so the value satisfies the same UUID shape
  // every command boundary validates rather than being merely hex-shaped.
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16),
    hex.slice(16, 20), hex.slice(20, 32),
  ].join('-');
}

function seedFor(workspaceId: string, commandKey: string, label: string): Buffer {
  return createHash('sha256').update([
    'propertypredator.founder-email-pilot-identifier/v1',
    workspaceId.toLowerCase(), commandKey.toLowerCase(), label,
  ].join(DIGEST_FIELD_SEPARATOR), 'utf8').digest();
}

export function deriveFounderEmailPilotIdentifiers(
  workspaceId: string,
  commandKey: string,
): FounderEmailPilotIdentifiers {
  if (!UUID.test(workspaceId)) throw new FounderEmailPilotError('workspace id is invalid');
  if (!UUID.test(commandKey)) throw new FounderEmailPilotError('command key is invalid');
  const idempotencyKeySha256 = deriveFounderPilotCommandKey(
    'email-pilot-authorise', workspaceId, commandKey,
  );
  return Object.freeze({
    providerOperationId: derivedUuid(seedFor(workspaceId, commandKey, 'provider-operation')),
    messageDeliveryId: derivedUuid(seedFor(workspaceId, commandKey, 'message-delivery')),
    correlationId: derivedUuid(seedFor(workspaceId, commandKey, 'correlation')),
    idempotencyKeySha256,
    // The enqueue folds the request id into the digest it compares, so a replay
    // can only match when the request id matches too. Deriving it from the
    // command key is what makes a second submit a replay instead of a conflict.
    requestId: `pp-email-pilot:${idempotencyKeySha256}`,
  });
}

export interface AuthoriseFounderEmailPilotInput {
  readonly contactId: string;
  readonly contactPointId: string;
  readonly purpose: string;
  readonly commandKey: string;
  readonly previewToken: string;
  readonly operatorConfirmed: boolean;
}

export interface AuthoriseFounderEmailPilotCommand {
  readonly contactId: string;
  readonly contactPointId: string;
  readonly purpose: string;
  readonly commandKey: string;
  readonly previewToken: string;
}

export function parseAuthoriseFounderEmailPilot(
  input: AuthoriseFounderEmailPilotInput,
): AuthoriseFounderEmailPilotCommand {
  const fail = (reason: string): never => {
    throw new FounderEmailPilotError(reason);
  };
  if (input.operatorConfirmed !== true) fail('final confirmation is required');
  if (!UUID.test(input.contactId)) fail('contact id is invalid');
  if (!UUID.test(input.contactPointId)) fail('contact point id is invalid');
  if (!UUID.test(input.commandKey)) fail('command key is invalid');
  if (!isFounderPilotPurpose(input.purpose)) fail('purpose is invalid');
  if (typeof input.previewToken !== 'string'
      || input.previewToken.length < 1 || input.previewToken.length > 512) {
    fail('preview token is invalid');
  }
  return Object.freeze({
    contactId: input.contactId.toLowerCase(),
    contactPointId: input.contactPointId.toLowerCase(),
    purpose: input.purpose,
    commandKey: input.commandKey.toLowerCase(),
    previewToken: input.previewToken,
  });
}
