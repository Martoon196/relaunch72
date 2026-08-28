import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../src/db/migrations/0044_company_content_sync_command_consumption.sql',
  import.meta.url,
);

function normalise(sql: string): string {
  return sql.replace(/--[^\n]*/gu, ' ').replace(/\s+/gu, ' ').trim();
}

test('0044 stores only bounded workspace and hashed one-use command evidence', async () => {
  const sql = normalise(await readFile(migrationUrl, 'utf8'));
  assert.match(sql, /CREATE TABLE app\.company_content_sync_command_consumptions/);
  assert.match(sql, /session_token_sha256 bytea NOT NULL CHECK \(octet_length\(session_token_sha256\) = 32\)/);
  assert.match(sql, /command_key_sha256 bytea NOT NULL CHECK \(octet_length\(command_key_sha256\) = 32\)/);
  assert.match(sql, /PRIMARY KEY \(workspace_id, session_token_sha256, command_key_sha256\)/);
  assert.match(sql, /expires_at <= consumed_at \+ interval '10 minutes 30 seconds'/);
  assert.match(sql, /v_active_count >= 2048/);
  assert.match(sql, /DELETE FROM app\.company_content_sync_command_consumptions WHERE workspace_id = p_workspace_id AND expires_at <= v_now/);
  assert.match(sql, /INSERT INTO app_private\.workspace_table_registry \(schema_name, table_name, workspace_column\) VALUES \('app', 'company_content_sync_command_consumptions', 'workspace_id'\) ON CONFLICT \(schema_name, table_name\) DO UPDATE SET workspace_column = EXCLUDED\.workspace_column/);
  assert.doesNotMatch(sql, /email|raw_session|raw_command|source_content/iu);
});

test('0044 consumes atomically after exact active-session and manager checks', async () => {
  const sql = normalise(await readFile(migrationUrl, 'utf8'));
  assert.match(sql, /CREATE FUNCTION app_private\.consume_company_content_sync_command\( p_workspace_id uuid, p_session_token_sha256 bytea, p_command_key text \)/);
  assert.match(sql, /SECURITY DEFINER SET search_path = pg_catalog/);
  assert.match(sql, /app_private\.current_workspace_id\(\) IS DISTINCT FROM p_workspace_id/);
  assert.match(sql, /app_private\.can_manage_workspace\( app_private\.current_user_id\(\), p_workspace_id \)/);
  assert.match(sql, /app_private\.lock_active_portal_session\( p_session_token_sha256, app_private\.current_user_id\(\), p_workspace_id \)/);
  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /RETURN 'replayed'/);
  assert.match(sql, /RETURN 'saturated'/);
  assert.match(sql, /RETURN 'accepted'/);
});

test('0044 gives web execute-only access and no provider/content role capability', async () => {
  const sql = normalise(await readFile(migrationUrl, 'utf8'));
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /REVOKE ALL ON app\.company_content_sync_command_consumptions FROM r72_web, r72_content_adapter, r72_content_command/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app_private\.consume_company_content_sync_command\(uuid, bytea, text\) TO r72_web/);
  assert.match(sql, /has_table_privilege\( 'r72_web', 'app\.company_content_sync_command_consumptions', 'INSERT' \)/);
  assert.match(sql, /has_table_privilege\( 'r72_security_definer', 'app\.company_content_sync_command_consumptions', 'UPDATE' \)/);
  assert.doesNotMatch(sql, /CREATE POLICY [^ ]+ ON app\.company_content_sync_command_consumptions FOR UPDATE/);
  assert.match(sql, /has_function_privilege\( 'r72_content_adapter', 'app_private\.consume_company_content_sync_command\(uuid,bytea,text\)', 'EXECUTE' \)/);
  assert.match(sql, /has_function_privilege\( 'r72_content_command', 'app_private\.consume_company_content_sync_command\(uuid,bytea,text\)', 'EXECUTE' \)/);
  assert.doesNotMatch(sql, /provider_operations|message_deliveries|publish|send_message/iu);
});
