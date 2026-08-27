import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Pool } from 'pg';
import {
  openTestDatabase,
  ownerQuery,
  testDatabaseSkipReason,
} from './database-helper.js';

const skip = testDatabaseSkipReason();

async function callSessionFence(
  pool: Pool,
  role: 'r72_content_adapter' | 'r72_content_command',
  functionName: 'active_portal_session' | 'lock_active_portal_session',
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${role}`);
    const result = await client.query<{ allowed: boolean }>(
      `SELECT app_private.${functionName}($1, $2, $3) AS allowed`,
      [Buffer.alloc(32), randomUUID(), randomUUID()],
    );
    await client.query('COMMIT');
    return result.rows[0]!.allowed;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

test('company-asset roles can revalidate but cannot acquire broader identity authority', {
  skip,
}, async () => {
  const pool = await openTestDatabase();
  try {
    const capability = await ownerQuery<{
      adapter_active: boolean;
      adapter_lock: boolean;
      command_active: boolean;
      command_lock: boolean;
      adapter_resolve: boolean;
      command_revoke: boolean;
      adapter_sessions_table: boolean;
      command_sessions_table: boolean;
    }>(pool, `
      SELECT
        has_function_privilege(
          'r72_content_adapter',
          'app_private.active_portal_session(bytea,uuid,uuid)',
          'EXECUTE'
        ) AS adapter_active,
        has_function_privilege(
          'r72_content_adapter',
          'app_private.lock_active_portal_session(bytea,uuid,uuid)',
          'EXECUTE'
        ) AS adapter_lock,
        has_function_privilege(
          'r72_content_command',
          'app_private.active_portal_session(bytea,uuid,uuid)',
          'EXECUTE'
        ) AS command_active,
        has_function_privilege(
          'r72_content_command',
          'app_private.lock_active_portal_session(bytea,uuid,uuid)',
          'EXECUTE'
        ) AS command_lock,
        has_function_privilege(
          'r72_content_adapter',
          'app_private.resolve_portal_session(bytea)',
          'EXECUTE'
        ) AS adapter_resolve,
        has_function_privilege(
          'r72_content_command',
          'app_private.revoke_portal_session(bytea)',
          'EXECUTE'
        ) AS command_revoke,
        has_table_privilege(
          'r72_content_adapter', 'app.user_sessions', 'SELECT'
        ) AS adapter_sessions_table,
        has_table_privilege(
          'r72_content_command', 'app.user_sessions', 'SELECT'
        ) AS command_sessions_table
    `);

    assert.deepEqual(capability[0], {
      adapter_active: true,
      adapter_lock: false,
      command_active: false,
      command_lock: true,
      adapter_resolve: false,
      command_revoke: false,
      adapter_sessions_table: false,
      command_sessions_table: false,
    });

    assert.equal(
      await callSessionFence(pool, 'r72_content_adapter', 'active_portal_session'),
      false,
    );
    assert.equal(
      await callSessionFence(pool, 'r72_content_command', 'lock_active_portal_session'),
      false,
    );
  } finally {
    await pool.end();
  }
});
