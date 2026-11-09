/**
 * Postgres implementation of the operator permission-use receipt seam.
 *
 * Everything that matters is enforced outside this class. The 0032 row-level
 * policy admits only an active owner or admin writing under their own user id
 * and their own request id; the ledger's own constraints hold the five-minute
 * decision window, the append-only shape and `provider_effects IS FALSE`; and
 * the 0064 resolver produces the subject, action scope and evidence snapshot,
 * so none of them can be supplied by a caller.
 *
 * The nonce is derived from the workspace and the command key alone,
 * deliberately not from the evidence. That is what makes an identical retry
 * reuse one receipt, and what makes changed evidence a conflict rather than a
 * second receipt for the same act.
 */

import { createHash } from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';
import { requestDatabaseContext, type DatabaseRequestContext } from '../db/rls.js';
import { InactivePortalSessionError, withTransaction } from '../db/transaction.js';
import {
  FounderEmailPilotError,
  deriveFounderEmailPilotIdentifiers,
  deriveFounderPilotCommandKey,
  isCanonicalInstant,
  isFounderPilotPurpose,
} from '../founder-email-pilot/foundation.js';
import {
  createPgPortalCrmPrincipalResolver,
  type PortalCrmPrincipalResolver,
} from './crm-pg-service.js';
import type { PortalCrmRequestIdentity } from './crm-service.js';
import type {
  ConsumePermissionUseInput,
  ConsumePermissionUseResult,
  PermissionUseFailure,
  PortalPermissionUseReceiptService,
} from './permission-use-receipt-service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256 = /^[0-9a-f]{64}$/u;

interface ScopeRow extends QueryResultRow {
  readonly compliance_subject_id: unknown;
  readonly action_scope_sha256: unknown;
  readonly evidence_snapshot_sha256: unknown;
}

interface ReceiptRow extends QueryResultRow {
  readonly id: unknown;
  readonly subject_id: unknown;
  readonly action_scope_sha256: unknown;
  readonly evidence_snapshot_sha256: unknown;
  readonly provider_effects: unknown;
}

function failed(kind: PermissionUseFailure['kind']): PermissionUseFailure {
  return Object.freeze({ ok: false, kind });
}

function postgresCode(error: unknown): string | null {
  return error && typeof error === 'object' && 'code' in error
    && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code : null;
}

function mapFailure(error: unknown): PermissionUseFailure {
  if (error instanceof InactivePortalSessionError) return failed('unauthenticated');
  if (error instanceof FounderEmailPilotError) return failed('validation');
  const code = postgresCode(error);
  if (code === '42501') return failed('forbidden');
  if (code === '23505' || code === '40001') return failed('conflict');
  if (code === '22023' || code === '23514' || code === '23503') return failed('validation');
  return failed('unavailable');
}

/** Reads a resolver or ledger row as untrusted. */
function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new FounderEmailPilotError(`${label} is invalid`);
  }
  return value.toLowerCase();
}

export interface PgPortalPermissionUseReceiptDependencies {
  readonly principalResolver: Pick<PortalCrmPrincipalResolver, 'resolve'>;
  /** The dedicated r72_affiliate_receipt_command pool. Never a shared one. */
  readonly receiptPool: Pick<Pool, 'connect'>;
  readonly providerConnectionId: string;
  readonly workspaceId: string;
}

export class PgPortalPermissionUseReceiptService
implements PortalPermissionUseReceiptService {
  readonly #dependencies: PgPortalPermissionUseReceiptDependencies;

  get workspaceId(): string {
    return this.#dependencies.workspaceId;
  }

  constructor(dependencies: PgPortalPermissionUseReceiptDependencies) {
    if (!UUID.test(dependencies.providerConnectionId)
      || !UUID.test(dependencies.workspaceId)) {
      throw new Error('permission use receipts require the exact workspace and connection');
    }
    this.#dependencies = dependencies;
  }

  async consume(
    identity: PortalCrmRequestIdentity,
    input: ConsumePermissionUseInput,
  ): Promise<ConsumePermissionUseResult> {
    try {
      if (!UUID.test(input.contactId) || !UUID.test(input.contactPointId)
        || !UUID.test(input.commandKey) || !isFounderPilotPurpose(input.purpose)
        || !isCanonicalInstant(input.authorityValidUntil)) {
        return failed('validation');
      }
      const principal = await this.#dependencies.principalResolver
        .resolve(identity.sessionToken);
      if (!principal || !UUID.test(principal.workspaceId)) return failed('unauthenticated');
      if (principal.workspaceId.toLowerCase() !== this.workspaceId.toLowerCase()) {
        return failed('forbidden');
      }
      const identifiers = deriveFounderEmailPilotIdentifiers(
        principal.workspaceId, input.commandKey,
      );
      // The same derived request id the enqueue binds. The row-level policy
      // compares it against app.request_id, so preview, receipt and enqueue can
      // only ever agree or all fail together.
      const context: DatabaseRequestContext = requestDatabaseContext({
        ...principal,
        requestId: identifiers.requestId,
        portalSessionTokenHash: createHash('sha256').update(identity.sessionToken).digest(),
      });
      const nonce = Buffer.from(
        deriveFounderPilotCommandKey(
          'email-permission-use', principal.workspaceId, input.commandKey,
        ),
        'hex',
      );

      const outcome = await withTransaction(
        this.#dependencies.receiptPool, context,
        async (client) => {
          const scope = await client.query<ScopeRow>(
            `/* portal.permission-use.resolve-scope */
             SELECT compliance_subject_id::text, action_scope_sha256,
                    evidence_snapshot_sha256
             FROM app_private.resolve_customer_email_permission_use_scope(
               $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::text
             )`,
            [
              principal.workspaceId, this.#dependencies.providerConnectionId,
              input.contactId.toLowerCase(), input.contactPointId.toLowerCase(),
              input.purpose,
            ],
          );
          if (scope.rows.length > 1) {
            throw new FounderEmailPilotError('permission scope is ambiguous');
          }
          const resolved = scope.rows[0];
          // Nothing to bind a receipt to. Writing one anyway would record a
          // permission consumption for a send that could never be authorised.
          if (!resolved) return { kind: 'blocked' as const };
          const subjectId = resolved.compliance_subject_id;
          if (typeof subjectId !== 'string' || !UUID.test(subjectId)) {
            throw new FounderEmailPilotError('resolved compliance subject is invalid');
          }
          const actionScope = digest(resolved.action_scope_sha256, 'action scope');
          const snapshot = digest(resolved.evidence_snapshot_sha256, 'evidence snapshot');

          const existing = await this.#existing(client, principal.workspaceId, nonce);
          if (existing) {
            // Same act, same evidence: one receipt, reused.
            if (existing.actionScope === actionScope
              && existing.snapshot === snapshot
              && existing.subjectId === subjectId.toLowerCase()) {
              return {
                kind: 'replayed' as const,
                receiptId: existing.id, subjectId: existing.subjectId,
                actionScope, snapshot,
              };
            }
            // Same command key, different evidence. The founder read one
            // message and is now authorising another.
            return { kind: 'conflict' as const };
          }

          const inserted = await client.query<ReceiptRow>(
            `/* portal.permission-use.consume */
             INSERT INTO app_private.affiliate_compliance_permission_use_receipts (
               workspace_id, subject_id, permission, action_scope_sha256,
               evidence_snapshot_sha256, decision_nonce_sha256,
               eligibility_decision, use_state, evaluated_at, decision_expires_at,
               consumed_at, provider_effects, recorded_by_user_id, recorded_request_id
             ) VALUES (
               $1::uuid, $2::uuid, 'email.send', decode($3, 'hex'),
               decode($4, 'hex'), $5::bytea, 'allow', 'consumed',
               statement_timestamp(), $6::timestamptz, statement_timestamp(),
               false, $7::uuid, $8::text
             )
             RETURNING id::text, subject_id::text,
                       encode(action_scope_sha256, 'hex') AS action_scope_sha256,
                       encode(evidence_snapshot_sha256, 'hex') AS evidence_snapshot_sha256,
                       provider_effects`,
            [
              principal.workspaceId, subjectId, actionScope, snapshot, nonce,
              input.authorityValidUntil, principal.userId, identifiers.requestId,
            ],
          );
          const row = inserted.rows[0];
          if (!row || typeof row.id !== 'string' || row.provider_effects !== false) {
            throw new FounderEmailPilotError('recorded receipt is invalid');
          }
          return {
            kind: 'consumed' as const,
            receiptId: row.id, subjectId: subjectId.toLowerCase(),
            actionScope, snapshot,
          };
        },
        { isolation: 'serializable' },
      );

      if (outcome.kind === 'blocked') return failed('blocked');
      if (outcome.kind === 'conflict') return failed('conflict');
      return Object.freeze({
        ok: true as const,
        disposition: outcome.kind,
        permissionUseReceiptId: outcome.receiptId,
        complianceSubjectId: outcome.subjectId,
        actionScopeSha256: outcome.actionScope,
        evidenceSnapshotSha256: outcome.snapshot,
        providerEffects: false as const,
      });
    } catch (error) {
      return mapFailure(error);
    }
  }

  async #existing(
    client: { query: <R extends QueryResultRow>(
      sql: string, values: readonly unknown[],
    ) => Promise<{ rows: R[] }> },
    workspaceId: string,
    nonce: Buffer,
  ): Promise<{
    id: string; subjectId: string; actionScope: string; snapshot: string;
  } | null> {
    const found = await client.query<ReceiptRow>(
      `/* portal.permission-use.existing */
       SELECT id::text, subject_id::text,
              encode(action_scope_sha256, 'hex') AS action_scope_sha256,
              encode(evidence_snapshot_sha256, 'hex') AS evidence_snapshot_sha256,
              provider_effects
       FROM app_private.affiliate_compliance_permission_use_receipts
       WHERE workspace_id = $1::uuid AND decision_nonce_sha256 = $2::bytea`,
      [workspaceId, nonce],
    );
    const row = found.rows[0];
    if (!row) return null;
    if (found.rows.length !== 1 || typeof row.id !== 'string'
      || typeof row.subject_id !== 'string' || row.provider_effects !== false) {
      throw new FounderEmailPilotError('stored receipt is invalid');
    }
    return {
      id: row.id,
      subjectId: row.subject_id.toLowerCase(),
      actionScope: digest(row.action_scope_sha256, 'stored action scope'),
      snapshot: digest(row.evidence_snapshot_sha256, 'stored evidence snapshot'),
    };
  }
}

export function createPgPortalPermissionUseReceiptService(input: {
  readonly webPool: Pool;
  readonly receiptPool: Pool;
  readonly providerConnectionId: string;
  readonly workspaceId: string;
}): PgPortalPermissionUseReceiptService {
  return new PgPortalPermissionUseReceiptService({
    principalResolver: createPgPortalCrmPrincipalResolver(input.webPool),
    receiptPool: input.receiptPool,
    providerConnectionId: input.providerConnectionId,
    workspaceId: input.workspaceId,
  });
}
