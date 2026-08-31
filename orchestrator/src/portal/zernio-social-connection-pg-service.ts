import { createHash } from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';
import { requestDatabaseContext } from '../db/rls.js';
import { InactivePortalSessionError, withTransaction } from '../db/transaction.js';
import {
  ZernioLiveConnectionError,
  type VerifiedZernioAccountWebhook,
  type ZernioLiveConnectionClient,
  type ZernioPilotNetwork,
} from '../public-social-outbound/index.js';
import {
  createPgPortalCrmPrincipalResolver,
  type PortalCrmPrincipalResolver,
} from './crm-pg-service.js';
import type { PortalCrmRequestIdentity } from './crm-service.js';
import type {
  PortalZernioAccountSnapshot,
  PortalZernioBeginResult,
  PortalZernioCallbackResult,
  PortalZernioFailure,
  PortalZernioSnapshotResult,
  PortalZernioSocialConnectionService,
  PortalZernioWebhookResult,
} from './zernio-social-connection-service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/u;
const USERNAME = /^[^\u0000-\u001f\u007f]{1,160}$/u;
const NETWORKS = new Set<unknown>(['facebook', 'instagram', 'linkedin']);

interface AccountRow extends QueryResultRow {
  account_id: unknown;
  network: unknown;
  username: unknown;
  display_name: unknown;
  status: unknown;
  linked_at: unknown;
  last_event_at: unknown;
  webhook_receipt_count: unknown;
}

interface CallbackRow extends QueryResultRow { disposition: unknown; account_id: unknown }
interface DispositionRow extends QueryResultRow { disposition: unknown }

interface BoundaryRow extends QueryResultRow {
  exactRole: unknown;
  schemaUsage: unknown;
  requiredFunctions: unknown;
  tableBlind: unknown;
  elevatedRolesDenied: unknown;
}

export async function assertZernioSocialCommandBoundaryReady(
  pool: Pick<Pool, 'query'>,
): Promise<void> {
  let rows: readonly BoundaryRow[];
  try {
    const result = await pool.query<BoundaryRow>(
      `/* portal.zernio-social.runtime-boundary */
       SELECT
         current_user = 'r72_zernio_social_command' AS "exactRole",
         has_schema_privilege(current_user, 'app_private', 'USAGE') AS "schemaUsage",
         has_function_privilege(current_user,
           'app_private.begin_zernio_connection_intent(uuid,uuid,uuid,bytea,bytea,text)',
           'EXECUTE')
         AND has_function_privilege(current_user,
           'app_private.complete_zernio_connection_preparation(uuid,uuid,uuid,bytea,bytea,bytea)',
           'EXECUTE')
         AND has_function_privilege(current_user,
           'app_private.record_zernio_connection_callback(uuid,uuid,uuid,bytea,bytea,bytea,text,text,bytea,timestamp with time zone)',
           'EXECUTE')
         AND has_function_privilege(current_user,
           'app_private.record_zernio_account_webhook(uuid,uuid,uuid,text,text,bytea,bytea,bytea,bytea,timestamp with time zone)',
           'EXECUTE')
         AND has_function_privilege(current_user,
           'app_private.read_zernio_social_accounts(uuid,uuid,bytea)', 'EXECUTE')
         AND has_function_privilege(current_user,
           'app_private.lock_active_portal_session(bytea,uuid,uuid)', 'EXECUTE')
         AND has_function_privilege(current_user,
           'app_private.runtime_schema_migrations()', 'EXECUTE')
         AND has_function_privilege(current_user,
           'app_private.runtime_database_installation_id()', 'EXECUTE')
           AS "requiredFunctions",
         NOT EXISTS (
           SELECT 1 FROM pg_catalog.pg_class relation
           JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
           WHERE namespace.nspname IN ('app', 'app_private')
             AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
             AND (has_table_privilege(current_user, relation.oid, 'SELECT')
               OR has_table_privilege(current_user, relation.oid, 'INSERT')
               OR has_table_privilege(current_user, relation.oid, 'UPDATE')
               OR has_table_privilege(current_user, relation.oid, 'DELETE')
               OR has_table_privilege(current_user, relation.oid, 'TRUNCATE'))
         ) AS "tableBlind",
         NOT pg_has_role(current_user, 'r72_owner', 'MEMBER')
           AND NOT pg_has_role(current_user, 'r72_security_definer', 'MEMBER')
           AND NOT pg_has_role(current_user, 'r72_zernio_social_definer', 'MEMBER')
           AS "elevatedRolesDenied"`,
    );
    rows = result.rows;
  } catch {
    throw new Error('Zernio social command database boundary could not be verified');
  }
  const row = rows[0];
  if (rows.length !== 1 || !row || Object.values(row).some((value) => value !== true)) {
    throw new Error('Zernio social command database boundary is not exact');
  }
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function failure(kind: PortalZernioFailure['kind']): PortalZernioFailure {
  return Object.freeze({ ok: false, kind });
}

function code(error: unknown): string | null {
  return error && typeof error === 'object' && 'code' in error
    && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code : null;
}

function mapFailure(error: unknown): PortalZernioFailure {
  if (error instanceof InactivePortalSessionError) return failure('unauthenticated');
  if (error instanceof ZernioLiveConnectionError) {
    if (error.code === 'billing_required' || error.code === 'rate_limited'
        || error.code === 'provider_rejected' || error.code === 'provider_unavailable') {
      return failure(error.code);
    }
    return failure('provider_rejected');
  }
  const sqlState = code(error);
  if (sqlState === '42501') return failure('forbidden');
  if (sqlState === '40001' || sqlState === '23505') return failure('conflict');
  if (sqlState === '22023' || sqlState === '23514' || sqlState === '23503') {
    return failure('validation');
  }
  return failure('unavailable');
}

function timestamp(value: unknown): string {
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(parsed.getTime())) throw new Error('Invalid Zernio timestamp');
  return parsed.toISOString();
}

function accountRow(row: AccountRow): PortalZernioAccountSnapshot {
  if (typeof row.account_id !== 'string' || !UUID.test(row.account_id)
      || !NETWORKS.has(row.network)
      || (row.username !== null && (typeof row.username !== 'string' || !USERNAME.test(row.username)))
      || (row.display_name !== null
        && (typeof row.display_name !== 'string' || !USERNAME.test(row.display_name)))
      || (row.status !== 'active' && row.status !== 'disconnected')) {
    throw new Error('Invalid Zernio account row');
  }
  const receipts = Number(row.webhook_receipt_count);
  if (!Number.isSafeInteger(receipts) || receipts < 0) throw new Error('Invalid Zernio receipt count');
  return Object.freeze({
    accountId: row.account_id,
    network: row.network as ZernioPilotNetwork,
    username: row.username as string | null,
    displayName: row.display_name as string | null,
    status: row.status,
    linkedAt: timestamp(row.linked_at),
    lastEventAt: timestamp(row.last_event_at),
    webhookReceiptCount: receipts,
  });
}

export class PgPortalZernioSocialConnectionService
implements PortalZernioSocialConnectionService {
  readonly providerConnectionId: string;
  readonly providerProfileId: string;

  constructor(private readonly dependencies: Readonly<{
    principalResolver: Pick<PortalCrmPrincipalResolver, 'resolve'>;
    commandPool: Pick<Pool, 'connect'>;
    liveClient: ZernioLiveConnectionClient;
    workspaceId: string;
    providerConnectionId: string;
    providerProfileId: string;
  }>) {
    if (!UUID.test(dependencies.workspaceId)
        || !UUID.test(dependencies.providerConnectionId)
        || !PROVIDER_ID.test(dependencies.providerProfileId)) {
      throw new Error('Zernio social binding is invalid');
    }
    this.providerConnectionId = dependencies.providerConnectionId;
    this.providerProfileId = dependencies.providerProfileId;
  }

  async #context(identity: PortalCrmRequestIdentity) {
    const principal = await this.dependencies.principalResolver.resolve(identity.sessionToken);
    if (!principal || principal.workspaceId !== this.dependencies.workspaceId) return null;
    return requestDatabaseContext({
      ...principal,
      requestId: identity.requestId,
      portalSessionTokenHash: sha256(identity.sessionToken),
    });
  }

  async snapshot(identity: PortalCrmRequestIdentity): Promise<PortalZernioSnapshotResult> {
    try {
      const context = await this.#context(identity);
      if (!context) return failure('unauthenticated');
      const rows = await withTransaction(this.dependencies.commandPool, context, async (client) =>
        client.query<AccountRow>(
          `/* portal.zernio-social.snapshot */
           SELECT * FROM app_private.read_zernio_social_accounts($1::uuid,$2::uuid,$3::bytea)`,
          [context.workspaceId, this.providerConnectionId, sha256(this.providerProfileId)],
        ), { readOnly: true, isolation: 'repeatable read' });
      return Object.freeze({ ok: true, accounts: Object.freeze(rows.rows.map(accountRow)) });
    } catch (error) {
      return mapFailure(error);
    }
  }

  async begin(identity: PortalCrmRequestIdentity, input: Readonly<{
    intentId: string;
    network: ZernioPilotNetwork;
  }>): Promise<PortalZernioBeginResult> {
    if (!UUID.test(input.intentId) || !NETWORKS.has(input.network)) return failure('validation');
    try {
      const context = await this.#context(identity);
      if (!context?.portalSessionTokenHash) return failure('unauthenticated');
      await withTransaction(this.dependencies.commandPool, context, async (client) => {
        const result = await client.query<DispositionRow>(
          `/* portal.zernio-social.begin */
           SELECT app_private.begin_zernio_connection_intent(
             $1::uuid,$2::uuid,$3::uuid,$4::bytea,$5::bytea,$6::text
           ) AS disposition`,
          [context.workspaceId, this.providerConnectionId, input.intentId,
            context.portalSessionTokenHash, sha256(this.providerProfileId), input.network],
        );
        if (result.rows.length !== 1
            || (result.rows[0]!.disposition !== 'claimed'
              && result.rows[0]!.disposition !== 'replayed')) {
          throw new Error('Invalid Zernio intent disposition');
        }
      }, { isolation: 'serializable' });
      const prepared = await this.dependencies.liveClient.prepare(input);
      await withTransaction(this.dependencies.commandPool, context, async (client) => {
        const result = await client.query<DispositionRow>(
          `/* portal.zernio-social.complete-preparation */
           SELECT app_private.complete_zernio_connection_preparation(
             $1::uuid,$2::uuid,$3::uuid,$4::bytea,$5::bytea,$6::bytea
           ) AS disposition`,
          [context.workspaceId, this.providerConnectionId, input.intentId,
            context.portalSessionTokenHash, Buffer.from(prepared.providerStateSha256, 'hex'),
            Buffer.from(prepared.authUrlSha256, 'hex')],
        );
        if (result.rows.length !== 1
            || (result.rows[0]!.disposition !== 'prepared'
              && result.rows[0]!.disposition !== 'replayed')) {
          throw new Error('Invalid Zernio preparation disposition');
        }
      }, { isolation: 'serializable' });
      return Object.freeze({
        ok: true, intentId: input.intentId, authUrl: prepared.authUrl,
        providerEffects: 'oauth_not_started' as const,
      });
    } catch (error) {
      return mapFailure(error);
    }
  }

  async callback(identity: PortalCrmRequestIdentity, input: Readonly<{
    intentId: string;
    network: ZernioPilotNetwork;
    providerProfileId: string;
    providerAccountId: string;
    username: string;
    linkedAt: string;
    canonicalCallback: string;
  }>): Promise<PortalZernioCallbackResult> {
    if (!UUID.test(input.intentId) || !NETWORKS.has(input.network)
        || input.providerProfileId !== this.providerProfileId
        || !PROVIDER_ID.test(input.providerAccountId)
        || input.username !== input.username.trim() || !USERNAME.test(input.username)
        || !Number.isFinite(Date.parse(input.linkedAt))
        || new Date(input.linkedAt).toISOString() !== input.linkedAt
        || typeof input.canonicalCallback !== 'string' || input.canonicalCallback.length > 2_048) {
      return failure('validation');
    }
    try {
      const context = await this.#context(identity);
      if (!context?.portalSessionTokenHash) return failure('unauthenticated');
      const result = await withTransaction(this.dependencies.commandPool, context, async (client) =>
        client.query<CallbackRow>(
          `/* portal.zernio-social.callback */
           SELECT * FROM app_private.record_zernio_connection_callback(
             $1::uuid,$2::uuid,$3::uuid,$4::bytea,$5::bytea,$6::bytea,
             $7::text,$8::text,$9::bytea,$10::timestamptz
           )`,
          [context.workspaceId, this.providerConnectionId, input.intentId,
            context.portalSessionTokenHash, sha256(input.providerProfileId),
            sha256(input.providerAccountId), input.network, input.username,
            sha256(input.canonicalCallback), input.linkedAt],
        ), { isolation: 'serializable' });
      const row = result.rows[0];
      if (result.rows.length !== 1 || !row || typeof row.account_id !== 'string'
          || !UUID.test(row.account_id)
          || (row.disposition !== 'recorded' && row.disposition !== 'replayed')) {
        throw new Error('Invalid Zernio callback receipt');
      }
      return Object.freeze({
        ok: true, accountId: row.account_id, disposition: row.disposition,
        providerEffects: 'account_already_connected_by_user' as const,
      });
    } catch (error) {
      return mapFailure(error);
    }
  }

  async recordWebhook(input: VerifiedZernioAccountWebhook): Promise<PortalZernioWebhookResult> {
    if (input.workspaceId !== this.dependencies.workspaceId
        || input.connectionId !== this.providerConnectionId) return failure('forbidden');
    try {
      const context = Object.freeze({
        actorKind: 'webhook' as const,
        workspaceId: this.dependencies.workspaceId,
        requestId: input.eventId,
      });
      const result = await withTransaction(this.dependencies.commandPool, context, async (client) =>
        client.query<DispositionRow>(
          `/* portal.zernio-social.webhook */
           SELECT app_private.record_zernio_account_webhook(
             $1::uuid,$2::uuid,$3::uuid,$4::text,$5::text,$6::bytea,$7::bytea,
             $8::bytea,$9::bytea,$10::timestamptz
           ) AS disposition`,
          [input.workspaceId, input.connectionId, input.eventId, input.event, input.network,
            Buffer.from(input.providerProfileIdSha256, 'hex'),
            Buffer.from(input.providerAccountIdSha256, 'hex'),
            Buffer.from(input.rawBodySha256, 'hex'), Buffer.from(input.receiptSha256, 'hex'),
            input.occurredAt],
        ), { isolation: 'serializable' });
      const disposition = result.rows[0]?.disposition;
      if (result.rows.length !== 1
          || (disposition !== 'recorded' && disposition !== 'replayed')) {
        throw new Error('Invalid Zernio webhook disposition');
      }
      return Object.freeze({ ok: true, disposition, providerEffects: 'none' as const });
    } catch (error) {
      return mapFailure(error);
    }
  }
}

export function createPgPortalZernioSocialConnectionService(input: Readonly<{
  webPool: Pool;
  commandPool: Pool;
  liveClient: ZernioLiveConnectionClient;
  workspaceId: string;
  providerConnectionId: string;
  providerProfileId: string;
}>): PgPortalZernioSocialConnectionService {
  return new PgPortalZernioSocialConnectionService({
    principalResolver: createPgPortalCrmPrincipalResolver(input.webPool),
    commandPool: input.commandPool,
    liveClient: input.liveClient,
    workspaceId: input.workspaceId,
    providerConnectionId: input.providerConnectionId,
    providerProfileId: input.providerProfileId,
  });
}
