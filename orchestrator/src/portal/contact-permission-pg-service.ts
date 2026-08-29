/**
 * Postgres implementation of the founder contact permission seam.
 *
 * Every rule that matters is enforced by the 0063 function, not here: active
 * owner/admin membership, the exact contact/endpoint/purpose binding, the
 * derived endpoint digest, command-key idempotency and replay/conflict, and
 * the structural isolation that keeps a decision away from the suppression
 * ledger. This class validates the shape, hands over the exact tuple, and maps
 * failures without softening any of them.
 */

import { createHash } from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';
import { requestDatabaseContext, type DatabaseRequestContext } from '../db/rls.js';
import { InactivePortalSessionError, withTransaction } from '../db/transaction.js';
import {
  ContactPermissionError,
  deriveContactPermissionCommandKey,
  parseContactPermissionDecision,
} from '../contact-permission/foundation.js';
import {
  createPgPortalCrmPrincipalResolver,
  type PortalCrmPrincipalResolver,
} from './crm-pg-service.js';
import type { PortalCrmRequestIdentity } from './crm-service.js';
import type {
  PortalContactPermissionFailure,
  PortalContactPermissionInput,
  PortalContactPermissionResult,
  PortalContactPermissionService,
} from './contact-permission-service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

interface DecisionRow extends QueryResultRow {
  readonly disposition: unknown;
  readonly consent_event_id: unknown;
  readonly receipt_id: unknown;
}

function failed(kind: PortalContactPermissionFailure['kind']): PortalContactPermissionFailure {
  return Object.freeze({ ok: false, kind });
}

function postgresCode(error: unknown): string | null {
  return error && typeof error === 'object' && 'code' in error
    && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code : null;
}

/** One shared mapping so no call site can invent a softer failure. */
function mapFailure(error: unknown): PortalContactPermissionFailure {
  if (error instanceof InactivePortalSessionError) return failed('unauthenticated');
  if (error instanceof ContactPermissionError) return failed('validation');
  const code = postgresCode(error);
  if (code === '42501') return failed('forbidden');
  if (code === '23505' || code === '40001') return failed('conflict');
  if (code === '22023' || code === '23514' || code === '23503') return failed('validation');
  return failed('unavailable');
}

export interface PgPortalContactPermissionDependencies {
  readonly principalResolver: Pick<PortalCrmPrincipalResolver, 'resolve'>;
  readonly commandPool: Pick<Pool, 'connect'>;
}

export class PgPortalContactPermissionService implements PortalContactPermissionService {
  readonly #dependencies: PgPortalContactPermissionDependencies;

  constructor(dependencies: PgPortalContactPermissionDependencies) {
    this.#dependencies = dependencies;
  }

  /**
   * The workspace comes from the resolved session, never from the request, so
   * a decision cannot be aimed at another tenant's contact.
   */
  async #context(
    identity: PortalCrmRequestIdentity,
  ): Promise<{ context: DatabaseRequestContext; workspaceId: string } | null> {
    const principal = await this.#dependencies.principalResolver.resolve(identity.sessionToken);
    if (!principal || !UUID.test(principal.workspaceId)) return null;
    return {
      workspaceId: principal.workspaceId,
      context: requestDatabaseContext({
        ...principal,
        requestId: identity.requestId,
        portalSessionTokenHash: createHash('sha256').update(identity.sessionToken).digest(),
      }),
    };
  }

  async recordDecision(
    identity: PortalCrmRequestIdentity,
    input: PortalContactPermissionInput,
  ): Promise<PortalContactPermissionResult> {
    try {
      // Shape first, so an unconfirmed or malformed submission never opens a
      // transaction and never reaches the consent ledger.
      const command = parseContactPermissionDecision(input);
      if (!UUID.test(input.commandKey)) return failed('validation');
      const resolved = await this.#context(identity);
      if (!resolved) return failed('unauthenticated');
      const commandKeyDigest = Buffer.from(
        deriveContactPermissionCommandKey(resolved.workspaceId, input.commandKey),
        'hex',
      );
      const row = await withTransaction(this.#dependencies.commandPool, resolved.context,
        async (client) => {
          const result = await client.query<DecisionRow>(
            `/* portal.contact-permission.record-decision */
             SELECT disposition, consent_event_id::text, receipt_id::text
             FROM app_private.record_contact_permission_decision(
               $1::uuid, $2::uuid, $3::uuid, $4::text, $5::text, $6::text,
               $7::text, $8::text, $9::text, $10::bytea, $11::text,
               $12::bytea, $13::timestamptz
             )`,
            [
              resolved.workspaceId,
              command.contactId,
              command.contactPointId,
              command.channel,
              command.purpose,
              command.decision,
              command.lawfulBasis,
              command.evidenceSource,
              command.policyVersion,
              command.policyTextSha256 === null
                ? null
                : Buffer.from(command.policyTextSha256, 'hex'),
              command.sourceEventId,
              commandKeyDigest,
              command.occurredAt,
            ],
          );
          return result.rows[0] ?? null;
        });
      if (!row) return failed('unavailable');
      const disposition = row.disposition === 'replayed' ? 'replayed' : 'applied';
      if (typeof row.consent_event_id !== 'string' || typeof row.receipt_id !== 'string') {
        return failed('unavailable');
      }
      return Object.freeze({
        ok: true as const,
        disposition,
        consentEventId: row.consent_event_id,
        receiptId: row.receipt_id,
        messagesQueued: 'none' as const,
      });
    } catch (error) {
      return mapFailure(error);
    }
  }
}

export function createPgPortalContactPermissionService(input: {
  readonly webPool: Pool;
  readonly crmCommandPool: Pool;
}): PgPortalContactPermissionService {
  return new PgPortalContactPermissionService({
    principalResolver: createPgPortalCrmPrincipalResolver(input.webPool),
    commandPool: input.crmCommandPool,
  });
}
