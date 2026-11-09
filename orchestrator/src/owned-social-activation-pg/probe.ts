/**
 * Read-only owned public-social activation readiness probe.
 *
 * One statement, inside a read-only serializable transaction, against the 0059
 * SECURITY DEFINER function. It cannot enqueue, cannot write and cannot reach
 * Ayrshare. The owned account crosses the boundary as a digest and is never
 * returned.
 */

import type { Pool, QueryResultRow } from 'pg';
import type { DatabaseRequestContext } from '../db/rls.js';
import { validateDatabaseContext } from '../db/rls.js';
import { withTransaction } from '../db/transaction.js';
import {
  OwnedSocialActivationError,
  buildOwnedSocialActivationReadinessReport,
  type OwnedSocialActivationBlockerCode,
  type OwnedSocialActivationDimension,
  type OwnedSocialActivationDimensionResult,
  type OwnedSocialActivationReadinessReport,
  type OwnedSocialActivationTarget,
} from '../owned-social-activation/foundation.js';

const SHA256 = /^[0-9a-f]{64}$/u;

/**
 * `new Date('nonsense').toISOString()` throws, so an unparseable value must be
 * rejected before the comparison or it escapes as a RangeError instead of this
 * module's own refusal.
 */
function isCanonicalInstantOrNull(value: string | null): boolean {
  if (value === null) return true;
  if (!Number.isFinite(Date.parse(value))) return false;
  return new Date(value).toISOString() === value;
}

interface ReadinessRow extends QueryResultRow {
  dimension: unknown;
  ready: unknown;
  blockerCode: unknown;
}

export interface OwnedSocialActivationProbeDependencies {
  /** The exact 0052 founder command identity pool; no other role may run this. */
  readonly commandPool: Pick<Pool, 'connect'>;
}

export class PgOwnedSocialActivationReadinessProbe {
  readonly #commandPool: Pick<Pool, 'connect'>;

  constructor(dependencies: OwnedSocialActivationProbeDependencies) {
    this.#commandPool = dependencies.commandPool;
  }

  async readiness(
    context: DatabaseRequestContext,
    target: OwnedSocialActivationTarget,
  ): Promise<OwnedSocialActivationReadinessReport> {
    validateDatabaseContext(context);
    if (context.actorKind !== 'user'
        || !context.userId
        || context.workspaceId !== target.workspaceId
        || !SHA256.test(target.expectedOwnedAccountSha256)
        || !isCanonicalInstantOrNull(target.scheduledFor)) {
      throw new OwnedSocialActivationError('invalid_target');
    }
    const rows = await withTransaction(this.#commandPool, context, async (transaction) => (
      await transaction.query<ReadinessRow>(
        `/* owned-social-activation.readiness */
         SELECT dimension, ready, blocker_code AS "blockerCode"
         FROM app_private.property_predator_owned_social_activation_readiness(
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
           $7::uuid, $8::uuid, decode($9, 'hex'), $10::timestamptz
         )`,
        [
          target.workspaceId,
          target.providerConnectionId,
          target.profileId,
          target.contentItemId,
          target.contentVersionId,
          target.approvalRequestId,
          target.approvalDecisionId,
          target.sourceAttestationId,
          target.expectedOwnedAccountSha256,
          target.scheduledFor,
        ],
      )
    ).rows, { isolation: 'serializable', readOnly: true });
    return buildOwnedSocialActivationReadinessReport(rows.map(parseRow));
  }
}

function parseRow(row: ReadinessRow): OwnedSocialActivationDimensionResult {
  if (typeof row.dimension !== 'string' || typeof row.ready !== 'boolean'
      || (row.blockerCode !== null && typeof row.blockerCode !== 'string')) {
    throw new OwnedSocialActivationError('invalid_evidence');
  }
  return Object.freeze({
    dimension: row.dimension as OwnedSocialActivationDimension,
    ready: row.ready,
    blockerCode: row.blockerCode as OwnedSocialActivationBlockerCode | null,
  });
}

export function createPgOwnedSocialActivationReadinessProbe(
  dependencies: OwnedSocialActivationProbeDependencies,
): PgOwnedSocialActivationReadinessProbe {
  return new PgOwnedSocialActivationReadinessProbe(dependencies);
}
