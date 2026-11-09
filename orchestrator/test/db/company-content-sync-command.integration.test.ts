import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Pool } from 'pg';
import {
  expectPostgresError,
  openTestDatabase,
  ownerQuery,
  resetIdentityTables,
  scopedQuery,
  testDatabaseSkipReason,
} from './database-helper.js';

const skip = testDatabaseSkipReason();

async function consume(
  pool: Pool,
  context: Readonly<{ userId: string; workspaceId: string }>,
  sessionHash: Buffer,
  commandKey: string,
): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE r72_web');
    await client.query(
      `SELECT set_config('app.user_id', $1, true),
              set_config('app.workspace_id', $2, true),
              set_config('app.actor_kind', 'user', true),
              set_config('app.request_id', $3, true)`,
      [context.userId, context.workspaceId, commandKey],
    );
    const result = await client.query<{ disposition: string }>(
      `SELECT app_private.consume_company_content_sync_command(
         $1::uuid, $2::bytea, $3::text
       ) AS disposition`,
      [context.workspaceId, sessionHash, commandKey],
    );
    await client.query('COMMIT');
    return result.rows[0]!.disposition;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

test('0044 consumes once across connections and rejects a revoked session without raw evidence', {
  skip,
}, async () => {
  const pool = await openTestDatabase();
  const organizationId = randomUUID();
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const sessionHash = Buffer.alloc(32, 71);
  const context = { userId, workspaceId };
  try {
    await resetIdentityTables(pool);
    await ownerQuery(pool,
      `INSERT INTO app.organizations (id, name, slug, kind, status)
       VALUES ($1, 'Sync command integration', $2, 'direct_customer', 'active')`,
      [organizationId, `sync-${organizationId.slice(0, 8)}`],
    );
    await ownerQuery(pool,
      `INSERT INTO app.users (id, email, status, email_verified_at)
       VALUES ($1, $2, 'active', statement_timestamp())`,
      [userId, `sync-${userId.slice(0, 8)}@example.test`],
    );
    await ownerQuery(pool,
      `INSERT INTO app.organization_memberships (
         organization_id, user_id, role, status
       ) VALUES ($1, $2, 'owner', 'active')`,
      [organizationId, userId],
    );
    await ownerQuery(pool,
      `INSERT INTO app.workspaces (id, organization_id, name, slug, status)
       VALUES ($1, $2, 'Sync workspace', $3, 'active')`,
      [workspaceId, organizationId, `sync-${workspaceId.slice(0, 8)}`],
    );
    await ownerQuery(pool,
      `INSERT INTO app.workspace_memberships (
         workspace_id, organization_id, user_id, role, status
       ) VALUES ($1, $2, $3, 'owner', 'active')`,
      [workspaceId, organizationId, userId],
    );
    await ownerQuery(pool,
      `INSERT INTO app.user_sessions (
         token_hash, csrf_secret_hash, user_id, selected_workspace_id, expires_at
       ) VALUES ($1, $2, $3, $4, statement_timestamp() + interval '1 hour')`,
      [sessionHash, Buffer.alloc(32, 72), userId, workspaceId],
    );

    assert.equal(
      await consume(pool, context, sessionHash, 'company-content-sync-db-0001'),
      'accepted',
    );
    assert.equal(
      await consume(pool, context, sessionHash, 'company-content-sync-db-0001'),
      'replayed',
    );
    assert.equal(
      await consume(pool, context, sessionHash, 'company-content-sync-db-0002'),
      'accepted',
    );

    const evidence = await ownerQuery<{
      rows: string;
      bad_session_lengths: string;
      bad_command_lengths: string;
    }>(pool, `
      SELECT count(*)::text AS rows,
             count(*) FILTER (WHERE octet_length(session_token_sha256) <> 32)::text
               AS bad_session_lengths,
             count(*) FILTER (WHERE octet_length(command_key_sha256) <> 32)::text
               AS bad_command_lengths
      FROM app.company_content_sync_command_consumptions
      WHERE workspace_id = $1
    `, [workspaceId]);
    assert.deepEqual(evidence, [{
      rows: '2', bad_session_lengths: '0', bad_command_lengths: '0',
    }]);
    const registry = await ownerQuery<{
      schema_name: string;
      table_name: string;
      workspace_column: string;
    }>(pool, `
      SELECT schema_name::text, table_name::text, workspace_column::text
      FROM app_private.workspace_table_registry
      WHERE schema_name = 'app'
        AND table_name = 'company_content_sync_command_consumptions'
    `);
    assert.deepEqual(registry, [{
      schema_name: 'app',
      table_name: 'company_content_sync_command_consumptions',
      workspace_column: 'workspace_id',
    }]);
    await expectPostgresError(
      scopedQuery(
        pool,
        'r72_web',
        context,
        `UPDATE app.company_content_sync_command_consumptions
         SET expires_at = expires_at + interval '1 minute'
         WHERE workspace_id = $1`,
        [workspaceId],
      ),
      '42501',
    );

    await ownerQuery(pool,
      `UPDATE app.user_sessions
       SET revoked_at = statement_timestamp()
       WHERE token_hash = $1`,
      [sessionHash],
    );
    await expectPostgresError(
      consume(pool, context, sessionHash, 'company-content-sync-db-0003'),
      '42501',
    );
  } finally {
    await resetIdentityTables(pool).catch(() => undefined);
    await pool.end();
  }
});
