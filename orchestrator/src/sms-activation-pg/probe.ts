/**
 * Read-only Twilio SMS activation readiness probe and request-digest derivation.
 *
 * Both statements run on the 0056 founder command identity. Neither writes,
 * enqueues or reaches Twilio; the recipient is passed as a digest and never
 * returned.
 */

import type { Pool, QueryResultRow } from 'pg';
import type { DatabaseRequestContext } from '../db/rls.js';
import { validateDatabaseContext } from '../db/rls.js';
import { withTransaction } from '../db/transaction.js';
import {
  SmsActivationError,
  buildSmsActivationReadinessReport,
  type SmsActivationBlockerCode,
  type SmsActivationDimension,
  type SmsActivationDimensionResult,
  type SmsActivationReadinessReport,
  type SmsActivationTarget,
} from '../sms-activation/foundation.js';

const SHA256 = /^[0-9a-f]{64}$/u;

interface ReadinessRow extends QueryResultRow {
  dimension: unknown;
  ready: unknown;
  blockerCode: unknown;
}

interface DigestRow extends QueryResultRow {
  requestSha256: unknown;
}

/** Everything the 0056 enqueue binds, needed to derive its request digest. */
export interface SmsRequestDigestInput {
  readonly providerConnectionId: string;
  readonly messageVersionId: string;
  readonly messageApprovalRequestId: string;
  readonly messageApprovalDecisionId: string;
  readonly channelEndpointId: string;
  readonly consentEventId: string;
  readonly complianceSubjectId: string;
  readonly policyPublicationEventId: string;
  readonly pecrSenderDecisionEventId: string;
  readonly pecrInstigatorDecisionEventId: string;
  readonly permissionUseReceiptId: string;
  readonly authorityValidUntil: string;
  readonly providerOperationId: string;
  readonly messageDeliveryId: string;
  readonly correlationId: string;
  readonly idempotencyKeySha256: string;
}

export interface SmsActivationProbeDependencies {
  readonly commandPool: Pick<Pool, 'connect'>;
}

export class PgSmsActivationReadinessProbe {
  readonly #commandPool: Pick<Pool, 'connect'>;

  constructor(dependencies: SmsActivationProbeDependencies) {
    this.#commandPool = dependencies.commandPool;
  }

  async readiness(
    context: DatabaseRequestContext,
    target: SmsActivationTarget,
  ): Promise<SmsActivationReadinessReport> {
    validateDatabaseContext(context);
    if (context.actorKind !== 'user' || !context.userId
        || context.workspaceId !== target.workspaceId
        || !SHA256.test(target.expectedRecipientSha256)) {
      throw new SmsActivationError('invalid_target');
    }
    const rows = await withTransaction(this.#commandPool, context, async (transaction) => (
      await transaction.query<ReadinessRow>(
        `/* twilio-sms-activation.readiness */
         SELECT dimension, ready, blocker_code AS "blockerCode"
         FROM app_private.property_predator_sms_activation_readiness(
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
           $7::uuid, $8::text, decode($9, 'hex')
         )`,
        [
          target.workspaceId,
          target.bindingId,
          target.messageVersionId,
          target.messageApprovalDecisionId,
          target.contactId,
          target.contactPointId,
          target.consentEventId,
          target.purpose,
          target.expectedRecipientSha256,
        ],
      )
    ).rows, { isolation: 'serializable', readOnly: true });
    return buildSmsActivationReadinessReport(rows.map(parseRow));
  }

  /**
   * The request digest 0056 re-computes and compares. It is derived in the
   * database because the founder command identity is table-blind and cannot
   * read the sender number, body hash or recipient digests it is built from.
   */
  async requestDigest(
    context: DatabaseRequestContext,
    input: SmsRequestDigestInput,
  ): Promise<string> {
    validateDatabaseContext(context);
    if (context.actorKind !== 'user' || !context.userId
        || !SHA256.test(input.idempotencyKeySha256)
        || new Date(input.authorityValidUntil).toISOString() !== input.authorityValidUntil) {
      throw new SmsActivationError('invalid_staging');
    }
    const rows = await withTransaction(this.#commandPool, context, async (transaction) => (
      await transaction.query<DigestRow>(
        `/* twilio-sms-activation.request-digest */
         SELECT encode(app_private.derive_sms_live_request_digest(
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
           $7::uuid, $8::uuid, $9::uuid, $10::uuid, $11::uuid, $12::uuid,
           $13::timestamptz, $14::uuid, $15::uuid, $16::uuid, decode($17, 'hex')
         ), 'hex') AS "requestSha256"`,
        [
          context.workspaceId, input.providerConnectionId, input.messageVersionId,
          input.messageApprovalRequestId, input.messageApprovalDecisionId,
          input.channelEndpointId, input.consentEventId, input.complianceSubjectId,
          input.policyPublicationEventId, input.pecrSenderDecisionEventId,
          input.pecrInstigatorDecisionEventId, input.permissionUseReceiptId,
          input.authorityValidUntil, input.providerOperationId,
          input.messageDeliveryId, input.correlationId, input.idempotencyKeySha256,
        ],
      )
    ).rows, { isolation: 'serializable', readOnly: true });
    const digest = rows[0]?.requestSha256;
    if (rows.length !== 1 || typeof digest !== 'string' || !SHA256.test(digest)) {
      throw new SmsActivationError('invalid_evidence');
    }
    return digest;
  }
}

function parseRow(row: ReadinessRow): SmsActivationDimensionResult {
  if (typeof row.dimension !== 'string' || typeof row.ready !== 'boolean'
      || (row.blockerCode !== null && typeof row.blockerCode !== 'string')) {
    throw new SmsActivationError('invalid_evidence');
  }
  return Object.freeze({
    dimension: row.dimension as SmsActivationDimension,
    ready: row.ready,
    blockerCode: row.blockerCode as SmsActivationBlockerCode | null,
  });
}

export function createPgSmsActivationReadinessProbe(
  dependencies: SmsActivationProbeDependencies,
): PgSmsActivationReadinessProbe {
  return new PgSmsActivationReadinessProbe(dependencies);
}
