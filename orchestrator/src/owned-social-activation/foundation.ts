/**
 * Effect-free activation readiness and publication rehearsal for the exact
 * founder-owned Ayrshare/X account.
 *
 * 0052 refuses a publication with four opaque denials, and its publishable-text
 * rules are strict and easy to fail by accident: the approved bytes must be
 * ASCII printable, at most 280 characters, and contain no URL, scheme, `www.`
 * or bare domain at all. This module lets a founder learn that before a first
 * owned-account publication rather than from a rejected command.
 *
 * Nothing here publishes, enqueues, opens a socket or reaches Ayrshare. The
 * owned account crosses every boundary as a digest and is never returned.
 */

import { createHash } from 'node:crypto';
import type { OwnedPublicSocialNetwork } from '../public-social-outbound/owned-live-foundation.js';

export const OWNED_SOCIAL_ACTIVATION_CONTRACT =
  'propertypredator.owned-social-activation-readiness/v1' as const;

/** One row per dimension, in the exact order the database probe emits them. */
export const OWNED_SOCIAL_ACTIVATION_DIMENSIONS = Object.freeze([
  'operator_authority',
  'provider_connection',
  'owned_profile',
  'owned_account_matches_supplied',
  'ownership_link_evidence',
  'approved_content',
  'content_version_current',
  'source_attestation_valid',
  'publishable_text',
  'cap_headroom',
  'receipt_path_clear',
  'emergency_pause_clear',
] as const);

export type OwnedSocialActivationDimension =
  (typeof OWNED_SOCIAL_ACTIVATION_DIMENSIONS)[number];

/** Non-sensitive codes only: no account reference, profile key or post text. */
export const OWNED_SOCIAL_ACTIVATION_BLOCKER_CODES = Object.freeze([
  'OPERATOR_AUTHORITY_REQUIRED',
  'PROVIDER_NOT_CONFIGURED',
  'IDENTITY_BINDING_REQUIRED',
  'IDENTITY_BINDING_REVOKED',
  'OWNED_ACCOUNT_EVIDENCE_MISMATCH',
  'OWNERSHIP_EVIDENCE_REQUIRED',
  'APPROVED_CONTENT_REQUIRED',
  'CONTENT_VERSION_SUPERSEDED',
  'SOURCE_ATTESTATION_EXPIRED',
  'CONTENT_NOT_PUBLISHABLE',
  'CAP_REACHED',
  'OUTCOME_UNKNOWN_QUARANTINED',
  'EMERGENCY_PAUSED',
] as const);

export type OwnedSocialActivationBlockerCode =
  (typeof OWNED_SOCIAL_ACTIVATION_BLOCKER_CODES)[number];

export interface OwnedSocialActivationDimensionResult {
  readonly dimension: OwnedSocialActivationDimension;
  readonly ready: boolean;
  readonly blockerCode: OwnedSocialActivationBlockerCode | null;
}

export interface OwnedSocialActivationReadinessReport {
  readonly schemaVersion: 1;
  readonly contract: typeof OWNED_SOCIAL_ACTIVATION_CONTRACT;
  readonly result: 'ready-for-separately-authorised-owned-test' | 'blocked';
  readonly providerEffects: false;
  readonly providerCallsMade: false;
  readonly postsPublished: false;
  readonly dimensions: readonly OwnedSocialActivationDimensionResult[];
  readonly blockers: readonly OwnedSocialActivationBlockerCode[];
  readonly nextStep: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const OPERATION_TAG = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u;

/**
 * The exact X v1 shape 0052 applies to the approved bytes. Kept byte-for-byte
 * equivalent to the SQL so a rehearsal can never pass where the command would
 * refuse.
 */
const PUBLISHABLE_TEXT = /^[\r\n -~]+$/u;
const LINK_SHAPED =
  /(\/\/|(^|[^A-Za-z])[A-Za-z][A-Za-z0-9+.-]*:|www\.|[A-Za-z0-9][A-Za-z0-9-]{0,62}\.[A-Za-z]{2,63})/iu;

/**
 * Unit separator, matching the chr(31) convention the migrations use for
 * digest construction. Concatenating fields without a separator would let two
 * different publications collide on the same digest.
 */
const DIGEST_FIELD_SEPARATOR = String.fromCharCode(31);

export const OWNED_SOCIAL_MAX_POST_CHARACTERS = 280 as const;
export const OWNED_SOCIAL_DAILY_CAP = 1 as const;
export const OWNED_SOCIAL_MONTHLY_CAP = 3 as const;

export class OwnedSocialActivationError extends Error {
  constructor(readonly code: 'invalid_target' | 'invalid_evidence' | 'invalid_rehearsal') {
    super(`Owned social activation failed: ${code}`);
    this.name = 'OwnedSocialActivationError';
  }
}

/** Mirrors 0052: only the digest of the owned account reference ever travels. */
export function ownedSocialAccountDigest(accountReference: string): string {
  const trimmed = accountReference.trim();
  if (trimmed.length < 1 || trimmed.length > 200) {
    throw new OwnedSocialActivationError('invalid_target');
  }
  return createHash('sha256').update(trimmed, 'utf8').digest('hex');
}

export interface OwnedSocialActivationTarget {
  readonly network?: OwnedPublicSocialNetwork;
  readonly planningIntentId?: string;
  readonly workspaceId: string;
  readonly providerConnectionId: string;
  readonly profileId: string;
  readonly contentItemId: string;
  readonly contentVersionId: string;
  readonly approvalRequestId: string;
  readonly approvalDecisionId: string;
  readonly sourceAttestationId: string;
  readonly expectedOwnedAccountSha256: string;
  readonly scheduledFor: string | null;
}

export const OWNED_SOCIAL_ACTIVATION_TARGET_SETTINGS = Object.freeze([
  'PROPERTY_PREDATOR_REHEARSAL_WORKSPACE_ID',
  'PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_CONNECTION_ID',
  'PROPERTY_PREDATOR_REHEARSAL_SOCIAL_PROFILE_ID',
  'PROPERTY_PREDATOR_REHEARSAL_SOCIAL_CONTENT_ITEM_ID',
  'PROPERTY_PREDATOR_REHEARSAL_SOCIAL_CONTENT_VERSION_ID',
  'PROPERTY_PREDATOR_REHEARSAL_SOCIAL_APPROVAL_REQUEST_ID',
  'PROPERTY_PREDATOR_REHEARSAL_SOCIAL_APPROVAL_ID',
  'PROPERTY_PREDATOR_REHEARSAL_SOCIAL_SOURCE_ATTESTATION_ID',
  'PROPERTY_PREDATOR_REHEARSAL_SOCIAL_ACCOUNT_REF',
  'PROPERTY_PREDATOR_REHEARSAL_SOCIAL_PROFILE_OWNED',
] as const);

export type OwnedSocialActivationTargetOutcome =
  | Readonly<{ ok: true; target: OwnedSocialActivationTarget }>
  | Readonly<{ ok: false; missing: readonly string[] }>;

/**
 * Reads the exact supplied owned target. No account is ever invented: every
 * identifier must be supplied, and ownership must be affirmatively attested.
 */
export function readOwnedSocialActivationTarget(
  env: NodeJS.ProcessEnv,
): OwnedSocialActivationTargetOutcome {
  const missing: string[] = [];
  const value = (setting: string): string => (env[setting] ?? '').trim();
  const uuid = (setting: string): string => {
    const raw = value(setting);
    if (!UUID.test(raw)) missing.push(setting);
    return raw;
  };
  const workspaceId = uuid('PROPERTY_PREDATOR_REHEARSAL_WORKSPACE_ID');
  const providerConnectionId = uuid('PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_CONNECTION_ID');
  const profileId = uuid('PROPERTY_PREDATOR_REHEARSAL_SOCIAL_PROFILE_ID');
  const contentItemId = uuid('PROPERTY_PREDATOR_REHEARSAL_SOCIAL_CONTENT_ITEM_ID');
  const contentVersionId = uuid('PROPERTY_PREDATOR_REHEARSAL_SOCIAL_CONTENT_VERSION_ID');
  const approvalRequestId = uuid('PROPERTY_PREDATOR_REHEARSAL_SOCIAL_APPROVAL_REQUEST_ID');
  const approvalDecisionId = uuid('PROPERTY_PREDATOR_REHEARSAL_SOCIAL_APPROVAL_ID');
  const sourceAttestationId = uuid('PROPERTY_PREDATOR_REHEARSAL_SOCIAL_SOURCE_ATTESTATION_ID');
  const accountReference = value('PROPERTY_PREDATOR_REHEARSAL_SOCIAL_ACCOUNT_REF');
  if (accountReference.length < 1 || accountReference.length > 200) {
    missing.push('PROPERTY_PREDATOR_REHEARSAL_SOCIAL_ACCOUNT_REF');
  }
  if (value('PROPERTY_PREDATOR_REHEARSAL_SOCIAL_PROFILE_OWNED').toLowerCase() !== 'true') {
    missing.push('PROPERTY_PREDATOR_REHEARSAL_SOCIAL_PROFILE_OWNED');
  }
  if (missing.length > 0) return Object.freeze({ ok: false, missing: Object.freeze(missing) });
  return Object.freeze({
    ok: true,
    target: Object.freeze({
      workspaceId,
      providerConnectionId,
      profileId,
      contentItemId,
      contentVersionId,
      approvalRequestId,
      approvalDecisionId,
      sourceAttestationId,
      expectedOwnedAccountSha256: ownedSocialAccountDigest(accountReference),
      scheduledFor: null,
    }),
  });
}

/** Builds the report from database rows, revalidating the probe as untrusted. */
export function buildOwnedSocialActivationReadinessReport(
  rows: readonly OwnedSocialActivationDimensionResult[],
): OwnedSocialActivationReadinessReport {
  if (rows.length !== OWNED_SOCIAL_ACTIVATION_DIMENSIONS.length) {
    throw new OwnedSocialActivationError('invalid_evidence');
  }
  const codes: ReadonlySet<string> = new Set(OWNED_SOCIAL_ACTIVATION_BLOCKER_CODES);
  const seen = new Set<string>();
  const dimensions = rows.map((row, index): OwnedSocialActivationDimensionResult => {
    if (row.dimension !== OWNED_SOCIAL_ACTIVATION_DIMENSIONS[index]
        || seen.has(row.dimension)
        || typeof row.ready !== 'boolean'
        || (row.ready && row.blockerCode !== null)
        || (!row.ready && (row.blockerCode === null || !codes.has(row.blockerCode)))) {
      throw new OwnedSocialActivationError('invalid_evidence');
    }
    seen.add(row.dimension);
    return Object.freeze({
      dimension: row.dimension,
      ready: row.ready,
      blockerCode: row.blockerCode,
    });
  });
  const blockers = Object.freeze(dimensions
    .filter((entry): entry is OwnedSocialActivationDimensionResult & {
      blockerCode: OwnedSocialActivationBlockerCode;
    } => entry.blockerCode !== null)
    .map((entry) => entry.blockerCode));
  const ready = blockers.length === 0;
  return Object.freeze({
    schemaVersion: 1,
    contract: OWNED_SOCIAL_ACTIVATION_CONTRACT,
    result: ready ? 'ready-for-separately-authorised-owned-test' : 'blocked',
    providerEffects: false,
    providerCallsMade: false,
    postsPublished: false,
    dimensions: Object.freeze(dimensions),
    blockers,
    nextStep: ready
      ? 'Durable owned-account evidence is proven. A first publication still requires separate authorisation and an explicit effects/pause change.'
      : 'Resolve the listed blockers. No command, enqueue or provider call was attempted.',
  });
}

/* ------------------------------------------------------------------ *
 * Deterministic owned-test publication rehearsal.
 * ------------------------------------------------------------------ */

export interface OwnedSocialPublicationRehearsalInput {
  readonly target: OwnedSocialActivationTarget;
  readonly operationTag: string;
  /** The exact approved bytes, supplied so the rehearsal proves the hash. */
  readonly approvedText: string;
  readonly expectedContentSha256: string;
}

export interface OwnedSocialPublicationRehearsal {
  readonly schemaVersion: 1;
  readonly contract: typeof OWNED_SOCIAL_ACTIVATION_CONTRACT;
  readonly providerEffects: false;
  readonly providerCallsMade: false;
  readonly postsPublished: false;
  readonly ownedAccountSha256: string;
  readonly contentSha256: string;
  readonly contentMatchesApproval: boolean;
  readonly publishable: boolean;
  readonly publishableFailures: readonly string[];
  readonly characterCount: number;
  readonly idempotencyKeySha256: string;
  readonly requestSha256: string;
  readonly caps: Readonly<{ daily: 1; monthly: 3; perJob: 1 }>;
  readonly expectedReceipt: Readonly<{
    eventKinds: readonly ['accepted', 'published', 'failed', 'outcome_unknown'];
    uniqueOn: 'workspace_id, job_id, lease_version';
    evidenceColumn: 'receipt_sha256';
    acceptedBecomes: 'reconciliation_pending';
    publishedBecomes: 'succeeded';
    outcomeUnknownBecomes: 'needs_attention';
  }>;
}

/**
 * The scope-bound publication identity: workspace, connection, owned profile,
 * exact approved content version, approval decision, operation tag and
 * schedule. It is deliberately identifier-only so the founder portal can
 * derive the same idempotency key the offline rehearsal derives, without ever
 * reading the approved post body. Content versions are immutable, so the
 * version id pins the exact bytes just as tightly as their digest would.
 */
function ownedSocialStagingIdentity(
  target: OwnedSocialActivationTarget,
  operationTag: string,
): string {
  return [
    OWNED_SOCIAL_ACTIVATION_CONTRACT,
    target.workspaceId,
    target.providerConnectionId,
    target.profileId,
    target.network ?? 'x',
    target.planningIntentId ?? '',
    target.contentVersionId,
    target.approvalDecisionId,
    operationTag,
    target.scheduledFor ?? '',
  ].join(DIGEST_FIELD_SEPARATOR);
}

/**
 * The scope-bound digest pair a founder staging command supplies. Two stagings
 * of the same approved post onto the same owned profile collapse onto one job;
 * anything else is a distinct publication. Both digests are identifier-only so
 * the founder portal derives exactly what the offline rehearsal derives, and a
 * replay from either path lands on the same job rather than conflicting.
 */
export function deriveOwnedSocialStagingDigests(
  target: OwnedSocialActivationTarget,
  operationTag: string,
): Readonly<{ idempotencyKeySha256: string; requestSha256: string }> {
  if (!OPERATION_TAG.test(operationTag)
      || (target.scheduledFor !== null
        && (!Number.isFinite(Date.parse(target.scheduledFor))
          || new Date(target.scheduledFor).toISOString() !== target.scheduledFor))) {
    throw new OwnedSocialActivationError('invalid_rehearsal');
  }
  const identity = ownedSocialStagingIdentity(target, operationTag);
  return Object.freeze({
    idempotencyKeySha256: createHash('sha256').update(identity, 'utf8').digest('hex'),
    requestSha256: createHash('sha256').update([
      identity,
      target.contentItemId,
      target.approvalRequestId,
      target.sourceAttestationId,
      target.expectedOwnedAccountSha256,
    ].join(DIGEST_FIELD_SEPARATOR), 'utf8').digest('hex'),
  });
}

/** Backwards-compatible accessor for the idempotency half of the pair. */
export function deriveOwnedSocialStagingIdempotencyKey(
  target: OwnedSocialActivationTarget,
  operationTag: string,
): string {
  return deriveOwnedSocialStagingDigests(target, operationTag).idempotencyKeySha256;
}

/**
 * The canonical, deterministic derivation of the two digests 0052 stores but
 * does not itself recompute. Fixing the definition here means a replay of the
 * same owned publication produces byte-identical digests, so the database
 * idempotency check is meaningful rather than caller-dependent.
 */
export function deriveOwnedSocialPublicationRehearsal(
  input: OwnedSocialPublicationRehearsalInput,
): OwnedSocialPublicationRehearsal {
  const target = input.target;
  // The schedule is folded into the identity digest, so it must be exactly the
  // canonical instant the command would accept. Without this a caller could
  // mint a digest for a timestamp the command boundary would refuse.
  if (!OPERATION_TAG.test(input.operationTag)
      || !SHA256.test(target.expectedOwnedAccountSha256)
      || !SHA256.test(input.expectedContentSha256)
      || typeof input.approvedText !== 'string'
      || (target.scheduledFor !== null
        && (!Number.isFinite(Date.parse(target.scheduledFor))
          || new Date(target.scheduledFor).toISOString() !== target.scheduledFor))) {
    throw new OwnedSocialActivationError('invalid_rehearsal');
  }
  const contentSha256 = createHash('sha256').update(input.approvedText, 'utf8').digest('hex');
  const characterCount = [...input.approvedText].length;
  const failures: string[] = [];
  if (input.approvedText.length < 1) failures.push('EMPTY');
  if (characterCount > OWNED_SOCIAL_MAX_POST_CHARACTERS) failures.push('OVER_280_CHARACTERS');
  if (Buffer.byteLength(input.approvedText, 'utf8') > 16_384) failures.push('OVER_16KB');
  if (input.approvedText.length > 0 && !PUBLISHABLE_TEXT.test(input.approvedText)) {
    failures.push('NON_PRINTABLE_ASCII');
  }
  if (LINK_SHAPED.test(input.approvedText)) failures.push('CONTAINS_LINK_OR_DOMAIN');

  // Exactly the digests the founder portal derives, so a replay staged from
  // either path lands on the same job instead of conflicting.
  const digests = deriveOwnedSocialStagingDigests(target, input.operationTag);

  return Object.freeze({
    schemaVersion: 1,
    contract: OWNED_SOCIAL_ACTIVATION_CONTRACT,
    providerEffects: false,
    providerCallsMade: false,
    postsPublished: false,
    ownedAccountSha256: target.expectedOwnedAccountSha256,
    contentSha256,
    contentMatchesApproval: contentSha256 === input.expectedContentSha256,
    publishable: failures.length === 0,
    publishableFailures: Object.freeze(failures),
    characterCount,
    idempotencyKeySha256: digests.idempotencyKeySha256,
    requestSha256: digests.requestSha256,
    caps: Object.freeze({
      daily: OWNED_SOCIAL_DAILY_CAP,
      monthly: OWNED_SOCIAL_MONTHLY_CAP,
      perJob: 1,
    }),
    expectedReceipt: Object.freeze({
      eventKinds: Object.freeze([
        'accepted', 'published', 'failed', 'outcome_unknown',
      ] as const),
      uniqueOn: 'workspace_id, job_id, lease_version',
      evidenceColumn: 'receipt_sha256',
      acceptedBecomes: 'reconciliation_pending',
      publishedBecomes: 'succeeded',
      outcomeUnknownBecomes: 'needs_attention',
    }),
  });
}

export function formatOwnedSocialActivationReadiness(
  report: OwnedSocialActivationReadinessReport,
): string {
  return [
    'Property Predator owned public-social activation readiness',
    'ZERO PUBLICATION — no enqueue, provider call or post occurred.',
    `Result: ${report.result === 'blocked' ? 'BLOCKED' : 'READY FOR SEPARATE OWNED-TEST AUTHORISATION'}`,
    '',
    'Durable evidence',
    ...report.dimensions.map((entry) => `[${entry.ready ? 'PASS' : 'BLOCKED'}] ${entry.dimension}`
      + (entry.blockerCode ? ` — ${entry.blockerCode}` : '')),
    '',
    report.nextStep,
  ].join('\n');
}
