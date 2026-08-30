/**
 * Postgres implementation of the founder customer-email pilot seam.
 *
 * Every rule that matters is enforced by the 0064 functions: active owner/admin
 * membership, the exact contact binding, command-key idempotency and conflict,
 * the derived endpoint digest, and the structural isolation that stops an
 * endpoint attach creating a contact, an opportunity, a consent or a
 * suppression release. This class validates shape, hands over the exact tuple,
 * and maps failures without softening any of them.
 *
 * The workspace comes from the resolved session, never from the request.
 */

import { createHash } from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';
import { requestDatabaseContext, type DatabaseRequestContext } from '../db/rls.js';
import { InactivePortalSessionError, withTransaction } from '../db/transaction.js';
import {
  FounderEmailPilotError,
  buildFounderEmailPilotReadinessReport,
  deriveFounderPilotCommandKey,
  isFounderPilotPurpose,
  parseAttachContactEmailEndpoint,
  type FounderEmailPilotDimensionResult,
} from '../founder-email-pilot/foundation.js';
import {
  createPgPortalCrmPrincipalResolver,
  type PortalCrmPrincipalResolver,
} from './crm-pg-service.js';
import type { PortalCrmRequestIdentity } from './crm-service.js';
import type {
  AttachEndpointInput,
  AttachEndpointResult,
  FounderEmailPilotFailure,
  FounderEmailPilotPreview,
  PilotReadinessInput,
  PilotReadinessResult,
  PortalFounderEmailPilotService,
} from './founder-email-pilot-service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/** Caps the 0054 rail enforces. Restated so the preview cannot drift silently. */
export const FOUNDER_EMAIL_DAILY_CAP = 10;
export const FOUNDER_EMAIL_MONTHLY_CAP = 50;

interface AttachRow extends QueryResultRow {
  readonly disposition: unknown;
  readonly contact_point_id: unknown;
  readonly receipt_id: unknown;
}

interface ReadinessRow extends QueryResultRow {
  readonly dimension: unknown;
  readonly ready: unknown;
  readonly blocker_code: unknown;
}

interface PreviewRow extends QueryResultRow {
  readonly recipient_email: unknown;
  readonly recipient_verified: unknown;
  readonly daily_used: unknown;
  readonly monthly_used: unknown;
}

function failed(kind: FounderEmailPilotFailure['kind']): FounderEmailPilotFailure {
  return Object.freeze({ ok: false, kind });
}

function postgresCode(error: unknown): string | null {
  return error && typeof error === 'object' && 'code' in error
    && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code : null;
}

/** One shared mapping so no call site can invent a softer failure. */
function mapFailure(error: unknown): FounderEmailPilotFailure {
  if (error instanceof InactivePortalSessionError) return failed('unauthenticated');
  if (error instanceof FounderEmailPilotError) return failed('validation');
  const code = postgresCode(error);
  if (code === '42501') return failed('forbidden');
  if (code === '23505' || code === '40001') return failed('conflict');
  if (code === '22023' || code === '23514' || code === '23503') return failed('validation');
  return failed('unavailable');
}

export interface PgPortalFounderEmailPilotDependencies {
  readonly principalResolver: Pick<PortalCrmPrincipalResolver, 'resolve'>;
  readonly commandPool: Pick<Pool, 'connect'>;
  /** The exact live Mailgun EU connection this pilot may use. */
  readonly providerConnectionId: string;
}

export class PgPortalFounderEmailPilotService implements PortalFounderEmailPilotService {
  readonly #dependencies: PgPortalFounderEmailPilotDependencies;

  constructor(dependencies: PgPortalFounderEmailPilotDependencies) {
    if (!UUID.test(dependencies.providerConnectionId)) {
      throw new Error('founder email pilot requires the exact provider connection id');
    }
    this.#dependencies = dependencies;
  }

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

  async attachEndpoint(
    identity: PortalCrmRequestIdentity,
    input: AttachEndpointInput,
  ): Promise<AttachEndpointResult> {
    try {
      // Shape first, so an unconfirmed or malformed submission never opens a
      // transaction and never reaches the contact record.
      const command = parseAttachContactEmailEndpoint(input);
      if (!UUID.test(input.commandKey)) return failed('validation');
      const resolved = await this.#context(identity);
      if (!resolved) return failed('unauthenticated');
      const commandKeyDigest = Buffer.from(
        deriveFounderPilotCommandKey(
          'contact-endpoint-attach', resolved.workspaceId, input.commandKey,
        ),
        'hex',
      );
      const row = await withTransaction(
        this.#dependencies.commandPool, resolved.context,
        async (client) => {
          const result = await client.query<AttachRow>(
            `/* portal.founder-email-pilot.attach-endpoint */
             SELECT disposition, contact_point_id::text, receipt_id::text
             FROM app_private.attach_verified_contact_email_endpoint(
               $1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::text,
               $7::timestamptz, $8::bytea
             )`,
            [
              resolved.workspaceId,
              command.contactId,
              command.email,
              command.label,
              command.evidenceSource,
              command.evidenceReference,
              command.verifiedAt,
              commandKeyDigest,
            ],
          );
          return result.rows[0] ?? null;
        });
      if (!row
        || typeof row.contact_point_id !== 'string'
        || typeof row.receipt_id !== 'string') {
        return failed('unavailable');
      }
      return Object.freeze({
        ok: true as const,
        disposition: row.disposition === 'replayed' ? 'replayed' as const : 'applied' as const,
        contactPointId: row.contact_point_id,
        receiptId: row.receipt_id,
        consentRecorded: 'none' as const,
      });
    } catch (error) {
      return mapFailure(error);
    }
  }

  async readiness(
    identity: PortalCrmRequestIdentity,
    input: PilotReadinessInput,
  ): Promise<PilotReadinessResult> {
    try {
      if (!UUID.test(input.contactId) || !UUID.test(input.contactPointId)
        || !isFounderPilotPurpose(input.purpose)) {
        return failed('validation');
      }
      const resolved = await this.#context(identity);
      if (!resolved) return failed('unauthenticated');
      const { rows, preview } = await withTransaction(
        this.#dependencies.commandPool, resolved.context,
        async (client) => {
          const probe = await client.query<ReadinessRow>(
            `/* portal.founder-email-pilot.readiness */
             SELECT dimension, ready, blocker_code
             FROM app_private.customer_email_pilot_readiness(
               $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::text
             )`,
            [
              resolved.workspaceId,
              this.#dependencies.providerConnectionId,
              input.contactId.toLowerCase(),
              input.contactPointId.toLowerCase(),
              input.purpose,
            ],
          );
          // The exact recipient the founder must confirm before authorising.
          const shown = await client.query<PreviewRow>(
            `/* portal.founder-email-pilot.preview */
             SELECT point.value AS recipient_email,
                    point.is_verified AS recipient_verified,
                    (SELECT count(*) FROM app.property_predator_customer_email_jobs AS day_job
                      WHERE day_job.workspace_id = $1::uuid
                        AND day_job.provider_connection_id = $2::uuid
                        AND day_job.utc_day = (statement_timestamp() AT TIME ZONE 'UTC')::date
                        AND day_job.state <> 'cancelled')::int AS daily_used,
                    (SELECT count(*) FROM app.property_predator_customer_email_jobs AS month_job
                      WHERE month_job.workspace_id = $1::uuid
                        AND month_job.provider_connection_id = $2::uuid
                        AND month_job.utc_month =
                          date_trunc('month', statement_timestamp() AT TIME ZONE 'UTC')::date
                        AND month_job.state <> 'cancelled')::int AS monthly_used
             FROM app.contact_points AS point
             WHERE point.workspace_id = $1::uuid
               AND point.id = $4::uuid
               AND point.contact_id = $3::uuid
               AND point.kind = 'email'
               AND point.deleted_at IS NULL`,
            [
              resolved.workspaceId,
              this.#dependencies.providerConnectionId,
              input.contactId.toLowerCase(),
              input.contactPointId.toLowerCase(),
            ],
          );
          return { rows: probe.rows, preview: shown.rows[0] ?? null };
        },
        { readOnly: true },
      );
      const report = buildFounderEmailPilotReadinessReport(
        rows.map((row): FounderEmailPilotDimensionResult => ({
          dimension: row.dimension as never,
          ready: row.ready === true,
          blockerCode: row.blocker_code === null ? null : row.blocker_code as never,
        })),
      );
      return Object.freeze({
        ok: true as const,
        report,
        preview: preview === null ? null : Object.freeze({
          recipientEmail: String(preview.recipient_email),
          recipientVerified: preview.recipient_verified === true,
          purpose: input.purpose,
          dailyUsed: Number(preview.daily_used),
          dailyCap: FOUNDER_EMAIL_DAILY_CAP,
          monthlyUsed: Number(preview.monthly_used),
          monthlyCap: FOUNDER_EMAIL_MONTHLY_CAP,
        }) satisfies FounderEmailPilotPreview,
      });
    } catch (error) {
      return mapFailure(error);
    }
  }
}

export function createPgPortalFounderEmailPilotService(input: {
  readonly webPool: Pool;
  readonly crmCommandPool: Pool;
  readonly providerConnectionId: string;
}): PgPortalFounderEmailPilotService {
  return new PgPortalFounderEmailPilotService({
    principalResolver: createPgPortalCrmPrincipalResolver(input.webPool),
    commandPool: input.crmCommandPool,
    providerConnectionId: input.providerConnectionId,
  });
}
