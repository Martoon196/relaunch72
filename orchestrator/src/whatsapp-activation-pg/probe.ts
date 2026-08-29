/**
 * Read-only WhatsApp activation readiness probe.
 *
 * One statement, inside a read-only serializable transaction, against the
 * 0058 SECURITY DEFINER function. It cannot enqueue, cannot write and cannot
 * reach a provider. The recipient is passed as a digest and never returned.
 */

import type { Pool, QueryResultRow } from 'pg';
import type { DatabaseRequestContext } from '../db/rls.js';
import { validateDatabaseContext } from '../db/rls.js';
import { withTransaction } from '../db/transaction.js';
import {
  WhatsAppActivationReadinessError,
  buildWhatsAppActivationReadinessReport,
  type WhatsAppActivationDimension,
  type WhatsAppActivationDimensionResult,
  type WhatsAppActivationBlockerCode,
  type WhatsAppActivationReadinessReport,
  type WhatsAppActivationTarget,
} from '../whatsapp-activation/foundation.js';

const SHA256 = /^[0-9a-f]{64}$/u;

interface ReadinessRow extends QueryResultRow {
  dimension: unknown;
  ready: unknown;
  blockerCode: unknown;
}

export interface WhatsAppActivationReadinessProbeDependencies {
  /** The exact 0053 command identity pool; no other role may run this. */
  readonly commandPool: Pick<Pool, 'connect'>;
}

export class PgWhatsAppActivationReadinessProbe {
  readonly #commandPool: Pick<Pool, 'connect'>;

  constructor(dependencies: WhatsAppActivationReadinessProbeDependencies) {
    this.#commandPool = dependencies.commandPool;
  }

  async readiness(
    context: DatabaseRequestContext,
    target: WhatsAppActivationTarget,
  ): Promise<WhatsAppActivationReadinessReport> {
    validateDatabaseContext(context);
    if (context.actorKind !== 'user'
        || !context.userId
        || context.workspaceId !== target.workspaceId
        || !SHA256.test(target.expectedRecipientSha256)) {
      throw new WhatsAppActivationReadinessError('invalid_target');
    }
    const rows = await withTransaction(this.#commandPool, context, async (transaction) => (
      await transaction.query<ReadinessRow>(
        `/* meta-whatsapp-activation.readiness */
         SELECT dimension, ready, blocker_code AS "blockerCode"
         FROM app_private.property_predator_whatsapp_activation_readiness(
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
           $7::text, decode($8, 'hex')
         )`,
        [
          target.workspaceId,
          target.bindingId,
          target.templateId,
          target.contactId,
          target.contactPointId,
          target.consentEventId,
          target.purpose,
          target.expectedRecipientSha256,
        ],
      )
    ).rows, { isolation: 'serializable', readOnly: true });
    return buildWhatsAppActivationReadinessReport(rows.map(parseRow));
  }
}

function parseRow(row: ReadinessRow): WhatsAppActivationDimensionResult {
  if (typeof row.dimension !== 'string' || typeof row.ready !== 'boolean'
      || (row.blockerCode !== null && typeof row.blockerCode !== 'string')) {
    throw new WhatsAppActivationReadinessError('invalid_evidence');
  }
  return Object.freeze({
    dimension: row.dimension as WhatsAppActivationDimension,
    ready: row.ready,
    blockerCode: row.blockerCode as WhatsAppActivationBlockerCode | null,
  });
}

export function createPgWhatsAppActivationReadinessProbe(
  dependencies: WhatsAppActivationReadinessProbeDependencies,
): PgWhatsAppActivationReadinessProbe {
  return new PgWhatsAppActivationReadinessProbe(dependencies);
}
