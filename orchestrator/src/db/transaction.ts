import type { Pool, PoolClient } from 'pg';
import { validateDatabaseContext, type DatabaseRequestContext } from './rls.js';

export type DbTransaction = PoolClient;
export type TransactionIsolation = 'read committed' | 'repeatable read' | 'serializable';

export interface TransactionOptions {
  isolation?: TransactionIsolation;
  readOnly?: boolean;
}

const ISOLATION_SQL: Record<TransactionIsolation, string> = {
  'read committed': 'READ COMMITTED',
  'repeatable read': 'REPEATABLE READ',
  serializable: 'SERIALIZABLE',
};

export class InactivePortalSessionError extends Error {
  constructor() {
    super('Portal session is no longer active');
    this.name = 'InactivePortalSessionError';
  }
}

/**
 * Own one transaction and install tenant identity with transaction-local
 * set_config calls before domain SQL. The callback must never acquire another
 * pool client mid-command.
 */
export async function withTransaction<T>(
  pool: Pick<Pool, 'connect'>,
  context: DatabaseRequestContext,
  operation: (transaction: DbTransaction) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  validateDatabaseContext(context);
  const client = await pool.connect();
  const isolation = ISOLATION_SQL[options.isolation ?? 'read committed'];
  const access = options.readOnly ? 'READ ONLY' : 'READ WRITE';
  let destroyClient = false;

  try {
    await client.query(`BEGIN ISOLATION LEVEL ${isolation} ${access}`);
    if (context.portalSessionTokenHash) {
      const sessionGuard = options.readOnly
        ? 'app_private.active_portal_session'
        : 'app_private.lock_active_portal_session';
      const active = await client.query<{ active: boolean }>(
        `/* database.lock-portal-session */
         SELECT ${sessionGuard}($1, $2, $3) AS active`,
        [context.portalSessionTokenHash, context.userId, context.workspaceId],
      );
      if (active.rows.length !== 1 || active.rows[0]?.active !== true) {
        throw new InactivePortalSessionError();
      }
    }
    await client.query(
      `SELECT
         set_config('app.user_id', $1, true),
         set_config('app.workspace_id', $2, true),
         set_config('app.actor_kind', $3, true),
         set_config('app.request_id', $4, true)`,
      [context.userId ?? '', context.workspaceId, context.actorKind, context.requestId],
    );
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      destroyClient = true;
      throw new AggregateError([error, rollbackError], 'Database operation and rollback both failed');
    }
    throw error;
  } finally {
    // A failed rollback leaves transaction/session state uncertain. pg-pool's
    // destroy flag prevents that client from being handed to another tenant.
    client.release(destroyClient);
  }
}
