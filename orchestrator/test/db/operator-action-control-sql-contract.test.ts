import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../src/db/migrations/0028_operator_action_control_foundation.sql',
  import.meta.url,
);

async function migration(): Promise<string> {
  return (await readFile(migrationUrl, 'utf8'))
    .replace(/--[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

test('0028 stores only workspace-scoped assignment and snooze overlays', async () => {
  const sql = await migration();
  assert.match(sql, /CREATE TABLE app\.operator_action_controls/);
  assert.match(sql, /action_key text NOT NULL/);
  assert.match(sql, /action_kind IN \( 'journey', 'inbox', 'content', 'webinar', 'automation', 'provider', 'crm' \)/);
  assert.match(sql, /source_reference text NOT NULL/);
  assert.match(sql, /assignment_overridden boolean NOT NULL DEFAULT false/);
  assert.match(sql, /assigned_user_id uuid/);
  assert.match(sql, /snoozed_until timestamptz/);
  assert.match(sql, /UNIQUE \(workspace_id, action_key\)/);
  assert.match(sql, /FOREIGN KEY \(workspace_id, assigned_user_id\) REFERENCES app\.workspace_memberships/);
  assert.doesNotMatch(sql, /\bcompleted_(?:at|by)|\bcompletion\b|\bmark_complete\b|\bstatus text NOT NULL CHECK \( status IN \('open'/i);
  assert.doesNotMatch(sql, /\btitle text|\bpriority text|\bdue_at timestamptz/);
});

test('0028 keeps audit events and terminal command receipts append-only', async () => {
  const sql = await migration();
  assert.match(sql, /CREATE TABLE app\.operator_action_control_events/);
  assert.match(sql, /event_kind IN \('assignment_changed', 'snooze_changed'\)/);
  assert.match(sql, /UNIQUE \(workspace_id, control_id, control_row_version\)/);
  assert.match(sql, /CREATE TABLE app\.operator_action_command_receipts/);
  assert.match(sql, /command_name IN \('operatorAction\.assign', 'operatorAction\.snooze'\)/);
  assert.match(sql, /UNIQUE \(workspace_id, actor_user_id, command_name, idempotency_key\)/);
  assert.match(sql, /payload_hash bytea NOT NULL CHECK \(octet_length\(payload_hash\) = 32\)/);
  assert.match(sql, /CHECK \(changed = \(event_id IS NOT NULL\)\)/);
  assert.match(sql, /CREATE TRIGGER operator_action_control_events_immutable BEFORE UPDATE OR DELETE/);
  assert.match(sql, /CREATE TRIGGER operator_action_command_receipts_immutable BEFORE UPDATE OR DELETE/);
  assert.match(sql, /ERRCODE = '55000'/);
});

test('0028 exposes two replay-safe optimistic commands only to the CRM command identity', async () => {
  const sql = await migration();
  for (const command of [
    'set_operator_action_assignment',
    'set_operator_action_snooze',
  ]) {
    assert.match(sql, new RegExp(`CREATE FUNCTION app_private\\.${command}\\(`));
    assert.match(sql, new RegExp(`ALTER FUNCTION app_private\\.${command}\\([\\s\\S]*?OWNER TO r72_operator_action_definer`));
    assert.match(sql, new RegExp(`GRANT EXECUTE ON FUNCTION app_private\\.${command}\\([\\s\\S]*?TO r72_crm_command`));
  }
  assert.match(sql, /SECURITY DEFINER SET search_path = pg_catalog/);
  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /idempotency key was reused with different input/);
  assert.match(sql, /p_expected_row_version/);
  assert.match(sql, /ERRCODE = '40001'/);
  assert.match(sql, /app_private\.current_actor_kind\(\) <> 'user'/);
  assert.match(sql, /app_private\.can_write_workspace/);
  assert.match(sql, /app_private\.can_manage_workspace/);
  assert.match(sql, /Only a workspace manager may assign another member/);
  assert.match(sql, /A member may release only their own Operator Action assignment/);
  assert.match(sql, /A member cannot clear an Operator Action assignment without an explicit self-owned overlay/);
  assert.match(sql, /authoritative server-side queue/);
  assert.match(sql, /must never be trusted from a browser form/);
});

test('0028 forces RLS, registers every table and gives providers no control-plane capability', async () => {
  const sql = await migration();
  for (const table of [
    'operator_action_controls',
    'operator_action_control_events',
    'operator_action_command_receipts',
  ]) {
    assert.match(sql, new RegExp(`'${table}'`));
  }
  assert.match(sql, /ALTER TABLE app\.%I ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /ALTER TABLE app\.%I FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /CREATE POLICY operator_action_controls_member_select/);
  assert.doesNotMatch(sql, /CREATE POLICY operator_action_control_events_member_select/);
  assert.doesNotMatch(sql, /CREATE POLICY operator_action_command_receipts_scoped_select/);
  assert.match(sql, /GRANT SELECT ON app\.operator_action_controls TO r72_web/);
  assert.doesNotMatch(sql, /GRANT SELECT[^;]*operator_action_(?:control_events|command_receipts)[^;]*TO r72_(?:web|crm_command)/);
  assert.match(sql, /has_any_column_privilege\( 'r72_crm_command', 'app\.' \|\| table_name, 'SELECT' \)/);
  assert.match(sql, /INSERT INTO app_private\.workspace_table_registry/);
  assert.match(sql, /r72_mailgun_webhook_command/);
  assert.match(sql, /r72_mailgun_worker_command/);
  assert.match(sql, /r72_worker/);
  assert.match(sql, /r72_webhook/);
  assert.match(sql, /Unsafe Operator Action capability/);
  assert.doesNotMatch(sql, /GRANT (?:SELECT|INSERT|UPDATE|DELETE)[^;]*TO r72_(?:worker|webhook|mailgun)/);
});

test('0028 exposes a bounded manager-or-self assignment directory only to the web reader', async () => {
  const sql = await migration();
  assert.match(sql, /CREATE FUNCTION app_private\.list_operator_action_assignable_members\( p_limit integer \)/);
  assert.match(sql, /RETURNS TABLE \( user_id uuid, display_name text, role text \)/);
  assert.match(sql, /LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog/);
  assert.match(sql, /p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 101/);
  assert.match(sql, /app_private\.has_active_workspace_membership/);
  assert.match(sql, /caller_can_write := app_private\.can_write_workspace/);
  assert.match(sql, /caller_can_manage := app_private\.can_manage_workspace/);
  assert.match(sql, /caller_can_manage OR membership\.user_id = trusted_user_id/);
  assert.match(sql, /membership\.role IN \('owner', 'admin', 'marketer', 'sales'\)/);
  assert.match(sql, /GRANT SELECT \(workspace_id, user_id, role\) ON app\.workspace_memberships TO r72_operator_action_definer/);
  assert.match(sql, /GRANT SELECT \(id, display_name\) ON app\.users TO r72_operator_action_definer/);
  assert.match(sql, /CREATE POLICY workspace_memberships_operator_action_definer_select/);
  assert.match(sql, /CREATE POLICY users_operator_action_definer_select/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app_private\.list_operator_action_assignable_members\(integer\) TO r72_web/);
  assert.match(sql, /REVOKE ALL ON FUNCTION app_private\.list_operator_action_assignable_members\(integer\) FROM PUBLIC,[^;]*r72_crm_command/);
  assert.doesNotMatch(sql, /GRANT SELECT \([^)]*(?:email|password_hash)/);
  assert.match(sql, /has_column_privilege\( 'r72_operator_action_definer', 'app\.users', 'email', 'SELECT' \)/);
  assert.match(sql, /has_column_privilege\( 'r72_operator_action_definer', 'app\.users', 'password_hash', 'SELECT' \)/);
});
