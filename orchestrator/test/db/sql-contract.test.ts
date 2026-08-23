import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migration1Url = new URL('../../src/db/migrations/0001_extensions_roles.sql', import.meta.url);
const migration2Url = new URL('../../src/db/migrations/0002_identity_workspaces.sql', import.meta.url);
const migration3Url = new URL('../../src/db/migrations/0003_crm_first_loop.sql', import.meta.url);
const migration4Url = new URL('../../src/db/migrations/0004_portal_sessions.sql', import.meta.url);

function normalise(sql: string): string {
  return sql.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();
}

test('0001 creates hardened roles, extensions, private ledger, and context helpers', async () => {
  const sql = normalise(await readFile(migration1Url, 'utf8'));
  assert.match(sql, /CREATE EXTENSION IF NOT EXISTS pgcrypto/);
  assert.match(sql, /CREATE EXTENSION IF NOT EXISTS citext/);
  for (const role of ['r72_owner', 'r72_security_definer', 'r72_web', 'r72_public', 'r72_worker', 'r72_webhook', 'r72_readonly']) {
    assert.match(sql, new RegExp(`'${role}'`));
  }
  assert.match(sql, /ALTER ROLE r72_security_definer NOLOGIN [^;]* NOBYPASSRLS/);
  for (const role of ['r72_web', 'r72_public', 'r72_worker', 'r72_webhook', 'r72_readonly']) {
    assert.match(sql, new RegExp(`ALTER ROLE ${role} LOGIN [^;]* NOBYPASSRLS`));
  }
  assert.match(sql, /REVOKE r72_owner, r72_security_definer FROM r72_web, r72_public, r72_worker, r72_webhook, r72_readonly/);
  assert.match(sql, /FROM pg_catalog\.pg_auth_members AS membership/);
  assert.match(sql, /Unsafe role membership/);
  assert.match(sql, /CREATE TABLE app_private\.schema_migrations/);
  assert.match(sql, /checksum text NOT NULL CHECK \(checksum ~ '\^\[0-9a-f\]\{64\}\$'\)/);
  assert.match(sql, /CREATE TABLE app_private\.workspace_table_registry/);
  for (const setting of ['app.user_id', 'app.workspace_id', 'app.actor_kind', 'app.request_id']) {
    assert.match(sql, new RegExp(setting.replace('.', '\\.')));
  }
});

test('0002 forces RLS on every identity table and registers workspace-bearing tables', async () => {
  const sql = normalise(await readFile(migration2Url, 'utf8'));
  const tables = [...sql.matchAll(/CREATE TABLE app\.([a-z_]+) \(/g)].map((match) => match[1]!);
  assert.deepEqual(tables, [
    'organizations',
    'users',
    'organization_branding',
    'workspaces',
    'organization_domains',
    'organization_memberships',
    'workspace_memberships',
    'membership_invitations',
    'identity_action_tokens',
    'user_sessions',
    'platform_memberships',
  ]);
  for (const table of tables) {
    assert.match(sql, new RegExp(`ALTER TABLE app\\.${table} ENABLE ROW LEVEL SECURITY`));
    assert.match(sql, new RegExp(`ALTER TABLE app\\.${table} FORCE ROW LEVEL SECURITY`));
  }
  for (const [table, workspaceColumn] of [
    ['workspaces', 'id'],
    ['organization_domains', 'workspace_id'],
    ['workspace_memberships', 'workspace_id'],
    ['membership_invitations', 'workspace_id'],
    ['user_sessions', 'selected_workspace_id'],
  ]) {
    assert.match(sql, new RegExp(`'${table}', '${workspaceColumn}'`));
  }
});

test('0002 encodes same-workspace links, opaque tokens, and revocable sourced access', async () => {
  const sql = normalise(await readFile(migration2Url, 'utf8'));
  assert.match(sql, /FOREIGN KEY \(organization_id, workspace_id\) REFERENCES app\.workspaces \(organization_id, id\)/);
  assert.match(sql, /FOREIGN KEY \(source_organization_id, user_id\) REFERENCES app\.organization_memberships \(organization_id, user_id\)/);
  assert.match(sql, /FOREIGN KEY \(workspace_id, resolved_user_id\) REFERENCES app\.workspace_memberships \(workspace_id, user_id\)/);
  assert.match(sql, /FOREIGN KEY \(selected_workspace_id, user_id\) REFERENCES app\.workspace_memberships \(workspace_id, user_id\)/);
  assert.match(sql, /token_hash bytea NOT NULL UNIQUE CHECK \(octet_length\(token_hash\) = 32\)/);
  assert.match(sql, /membership\.source_organization_id IS NULL OR EXISTS/);
  assert.match(sql, /source_membership\.status = 'active'/);
  assert.match(sql, /session\.revoked_at IS NULL/);
  assert.match(sql, /session\.expires_at > statement_timestamp\(\)/);
});

test('0002 rejects padded or structurally invalid identity email addresses', async () => {
  const sql = normalise(await readFile(migration2Url, 'utf8'));
  for (const column of ['email', 'support_email', 'invited_email']) {
    assert.match(sql, new RegExp(`${column}::text = btrim\\(${column}::text\\)`));
    assert.match(sql, new RegExp(`${column}::text ~ '\\^\\[\\^\\[:space:\\]@\\]\\+@`));
  }
});

test('0002 keeps tenant ownership columns immutable to the web role', async () => {
  const sql = normalise(await readFile(migration2Url, 'utf8'));
  assert.match(sql, /GRANT UPDATE \(name, slug, status, row_version, updated_at\) ON app\.organizations TO r72_web/);
  assert.match(sql, /GRANT UPDATE \(name, slug, status, timezone, locale, currency, settings, row_version, updated_at\) ON app\.workspaces TO r72_web/);
  assert.match(sql, /GRANT UPDATE \(product_name, logo_storage_key, logo_sha256, primary_color, accent_color, support_email, updated_at\) ON app\.organization_branding TO r72_web/);
  assert.doesNotMatch(sql, /GRANT (?:SELECT, )?UPDATE ON app\.(?:organizations|workspaces) TO r72_web/);
  assert.doesNotMatch(sql, /GRANT UPDATE \([^)]*\b(?:id|organization_id|workspace_id)\b[^)]*\) ON app\.(?:organizations|workspaces|organization_branding|organization_domains|organization_memberships|workspace_memberships|membership_invitations) TO r72_web/);
});

test('0002 keeps domain verification and access grants behind command boundaries', async () => {
  const sql = normalise(await readFile(migration2Url, 'utf8'));
  assert.match(sql, /hostname::text ~ '\^\[a-z0-9\]/);
  for (const table of ['organization_domains', 'organization_memberships', 'workspace_memberships', 'membership_invitations']) {
    assert.match(sql, new RegExp(`GRANT SELECT ON app\\.${table} TO r72_web`));
    assert.doesNotMatch(sql, new RegExp(`GRANT [^;]*(?:INSERT|UPDATE|DELETE)[^;]* ON app\\.${table} TO r72_web`));
  }
  assert.doesNotMatch(sql, /CREATE POLICY organization_domains_web_write/);
  assert.doesNotMatch(sql, /CREATE POLICY (?:organization_memberships|workspace_memberships)_manager_write/);
  assert.doesNotMatch(sql, /CREATE POLICY membership_invitations_manager_all/);
});

test('security-definer helpers have fixed search paths, private execution, and nested schema access', async () => {
  const sql = normalise(await readFile(migration2Url, 'utf8'));
  const securityDefinerCount = (sql.match(/SECURITY DEFINER/g) ?? []).length;
  const fixedPathCount = (sql.match(/SET search_path = pg_catalog/g) ?? []).length;
  assert.equal(securityDefinerCount, 7);
  assert.equal(fixedPathCount, securityDefinerCount);
  assert.match(sql, /GRANT USAGE ON SCHEMA app, app_private TO r72_security_definer/);
  assert.match(sql, /GRANT CREATE ON SCHEMA app_private TO r72_security_definer/);
  assert.match(sql, /REVOKE CREATE ON SCHEMA app_private FROM r72_security_definer/);
  for (const helper of [
    'has_active_organization_membership(uuid, uuid)',
    'can_manage_organization(uuid, uuid)',
    'has_active_workspace_membership(uuid, uuid)',
    'can_write_workspace(uuid, uuid)',
    'can_manage_workspace(uuid, uuid)',
    'workspace_is_in_organization(uuid, uuid)',
    'resolve_session(bytea)',
  ]) {
    assert.ok(sql.includes(`ALTER FUNCTION app_private.${helper} OWNER TO r72_security_definer`));
    assert.ok(sql.includes(`REVOKE ALL ON FUNCTION app_private.${helper} FROM PUBLIC`));
  }
  assert.doesNotMatch(sql, /GRANT [^;]*user_sessions[^;]* TO r72_web/);
  assert.doesNotMatch(sql, /CREATE POLICY user_sessions_[^;]* TO r72_web/);
});

test('issued 0001 and 0002 migration bytes remain checksum-immutable', async () => {
  const digest = (source: string): string => createHash('sha256')
    .update(source.replace(/\r\n/g, '\n'))
    .digest('hex');
  assert.equal(digest(await readFile(migration1Url, 'utf8')), 'e65d289e3f1ab03bb083839e7d76601094bcea39a26438f4da49ab8460260b99');
  assert.equal(digest(await readFile(migration2Url, 'utf8')), '6e231cdf96281cdd246e01a7780a2ddb0bdfe7465a955167b071b911d89378ed');
});

test('0003 creates and registers the complete workspace-scoped CRM first loop behind forced RLS', async () => {
  const sql = normalise(await readFile(migration3Url, 'utf8'));
  const tables = [...sql.matchAll(/CREATE TABLE app\.([a-z_]+) \(/g)].map((match) => match[1]!);
  assert.deepEqual(tables, [
    'contacts',
    'contact_points',
    'pipelines',
    'pipeline_stages',
    'opportunities',
    'opportunity_stage_history',
    'tasks',
    'activities',
    'command_receipts',
    'outbox_events',
  ]);
  for (const table of tables) {
    assert.match(sql, new RegExp(`CREATE TABLE app\\.${table} \\([^;]*workspace_id uuid NOT NULL`));
    assert.match(sql, new RegExp(`UNIQUE \\(workspace_id, id\\)`));
    assert.match(sql, new RegExp(`'${table}'`));
  }
  assert.match(sql, /ALTER TABLE app\.%I ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /ALTER TABLE app\.%I FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /FOREACH table_name IN ARRAY ARRAY\[ 'contacts', 'contact_points', 'pipelines', 'pipeline_stages', 'opportunities', 'opportunity_stage_history', 'tasks', 'activities', 'command_receipts', 'outbox_events' \]/);
});

test('0003 bootstraps and audits the isolated CRM command role without rewriting issued migrations', async () => {
  const sql = normalise(await readFile(migration3Url, 'utf8'));
  assert.match(sql, /CREATE ROLE r72_crm_command/);
  assert.match(sql, /ALTER ROLE r72_crm_command LOGIN [^;]* NOBYPASSRLS NOINHERIT/);
  assert.match(sql, /REVOKE r72_owner, r72_security_definer FROM r72_crm_command/);
  assert.match(sql, /REVOKE r72_crm_command FROM r72_web, r72_public, r72_worker, r72_webhook, r72_readonly/);
  assert.match(sql, /Unsafe CRM command role membership/);
  assert.match(sql, /Unsafe CRM command role grant/);
  assert.doesNotMatch(sql, /GRANT r72_crm_command TO r72_(?:web|public|worker|webhook|readonly)/);
  assert.match(sql, /REVOKE ALL ON ALL TABLES IN SCHEMA app FROM r72_crm_command/);
  assert.match(sql, /REVOKE ALL ON ALL TABLES IN SCHEMA app_private FROM r72_crm_command/);
  for (const helper of [
    'current_workspace_id()',
    'current_user_id()',
    'current_actor_kind()',
    'current_request_id()',
    'has_active_workspace_membership(uuid, uuid)',
    'can_write_workspace(uuid, uuid)',
    'can_manage_workspace(uuid, uuid)',
  ]) {
    assert.ok(sql.includes(`GRANT EXECUTE ON FUNCTION app_private.${helper} TO r72_crm_command`));
  }
});

test('0003 makes all CRM relationships same-workspace and enforces stage terminal truth', async () => {
  const sql = normalise(await readFile(migration3Url, 'utf8'));
  for (const relationship of [
    /FOREIGN KEY \(workspace_id, contact_id\) REFERENCES app\.contacts \(workspace_id, id\)/,
    /FOREIGN KEY \(workspace_id, pipeline_id\) REFERENCES app\.pipelines \(workspace_id, id\)/,
    /FOREIGN KEY \(workspace_id, pipeline_id, stage_id, status\) REFERENCES app\.pipeline_stages \(workspace_id, pipeline_id, id, stage_type\)/,
    /FOREIGN KEY \(workspace_id, pipeline_id, opportunity_id\) REFERENCES app\.opportunities \(workspace_id, pipeline_id, id\)/,
    /FOREIGN KEY \(workspace_id, opportunity_id\) REFERENCES app\.opportunities \(workspace_id, id\)/,
    /FOREIGN KEY \(workspace_id, opportunity_id, contact_id\) REFERENCES app\.opportunities \(workspace_id, id, contact_id\)/,
    /FOREIGN KEY \(workspace_id, task_id\) REFERENCES app\.tasks \(workspace_id, id\)/,
    /FOREIGN KEY \(workspace_id, owner_user_id\) REFERENCES app\.workspace_memberships \(workspace_id, user_id\)/,
    /FOREIGN KEY \(workspace_id, assignee_user_id\) REFERENCES app\.workspace_memberships \(workspace_id, user_id\)/,
  ]) {
    assert.match(sql, relationship);
  }
  assert.match(sql, /CHECK \(is_terminal = \(stage_type IN \('won', 'lost'\)\)\)/);
  assert.match(sql, /CHECK \(\(status = 'open'\) = \(closed_at IS NULL\)\)/);
  assert.match(sql, /CHECK \(\(status = 'completed'\) = \(completed_at IS NOT NULL\)\)/);
  assert.match(sql, /CHECK \(\(status = 'completed'\) = \(completed_by_user_id IS NOT NULL\)\)/);
  assert.match(sql, /CHECK \(opportunity_id IS NULL OR contact_id IS NOT NULL\)/);
  assert.match(sql, /row_version bigint NOT NULL DEFAULT 1 CHECK \(row_version > 0\)/);
});

test('0003 makes the web pool CRM read-only and isolates all mutations to the command role', async () => {
  const sql = normalise(await readFile(migration3Url, 'utf8'));
  assert.match(sql, /FOR SELECT TO r72_web, r72_crm_command USING/);
  assert.match(sql, /app_private\.can_write_workspace\( app_private\.current_user_id\(\), app_private\.current_workspace_id\(\) \)/);
  assert.match(sql, /FOREACH table_name IN ARRAY ARRAY\['contacts', 'contact_points', 'opportunities', 'tasks'\]/);
  assert.match(sql, /FOREACH table_name IN ARRAY ARRAY\['pipelines', 'pipeline_stages'\]/);
  assert.match(sql, /app_private\.can_manage_workspace\( app_private\.current_user_id\(\), app_private\.current_workspace_id\(\) \)/);
  assert.match(sql, /FOR INSERT TO r72_crm_command WITH CHECK/);
  assert.match(sql, /FOR UPDATE TO r72_crm_command USING/);
  assert.match(sql, /FOR DELETE TO r72_crm_command USING/);
  assert.doesNotMatch(sql, /FOR (?:INSERT|UPDATE|DELETE) TO r72_web/);
  assert.doesNotMatch(sql, /FOR (?:INSERT|UPDATE|DELETE) TO r72_worker/);
  assert.doesNotMatch(sql, /GRANT [^;]*(?:INSERT|UPDATE|DELETE)[^;]* TO r72_web/);
  assert.doesNotMatch(sql, /GRANT [^;]*(?:INSERT|UPDATE|DELETE)[^;]* TO r72_worker/);
  for (const table of ['contacts', 'contact_points', 'pipelines', 'pipeline_stages', 'opportunities', 'tasks']) {
    assert.match(sql, new RegExp(`GRANT [^;]*(?:INSERT|UPDATE|DELETE)[^;]*app\\.${table}[^;]*TO r72_crm_command`));
  }
});

test('0003 exposes only a scoped security-definer lock for writable default-pipeline commands', async () => {
  const sql = normalise(await readFile(migration3Url, 'utf8'));
  assert.match(sql, /CREATE FUNCTION app_private\.lock_active_default_pipeline_stage\( p_stage_id uuid, p_pipeline_id uuid \)/);
  assert.match(sql, /SECURITY DEFINER SET search_path = pg_catalog/);
  assert.match(sql, /stage\.workspace_id = nullif\(current_setting\('app\.workspace_id', true\), ''\)::uuid/);
  assert.match(sql, /pipeline\.status = 'active' AND pipeline\.is_default/);
  assert.match(sql, /app_private\.can_write_workspace\(/);
  assert.match(sql, /FOR SHARE OF pipeline, stage/);
  assert.match(sql, /ALTER FUNCTION app_private\.lock_active_default_pipeline_stage\(uuid, uuid\) OWNER TO r72_security_definer/);
  assert.match(sql, /REVOKE ALL ON FUNCTION app_private\.lock_active_default_pipeline_stage\(uuid, uuid\) FROM PUBLIC/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app_private\.lock_active_default_pipeline_stage\(uuid, uuid\) TO r72_crm_command/);
  assert.doesNotMatch(sql, /GRANT EXECUTE ON FUNCTION app_private\.lock_active_default_pipeline_stage\(uuid, uuid\) TO r72_(?:web|public|worker|webhook|readonly)/);
});

test('0003 grants append-only facts exclusively to the CRM command role', async () => {
  const sql = normalise(await readFile(migration3Url, 'utf8'));
  for (const table of ['opportunity_stage_history', 'activities']) {
    assert.match(sql, new RegExp(`GRANT SELECT, INSERT ON app\\.${table} TO r72_crm_command`));
    assert.doesNotMatch(sql, new RegExp(`GRANT [^;]*INSERT[^;]* ON app\\.${table} TO r72_(?:web|worker)`));
    assert.doesNotMatch(sql, new RegExp(`GRANT [^;]*(?:UPDATE|DELETE)[^;]* ON app\\.${table} TO r72_(?:web|crm_command|worker)`));
    assert.doesNotMatch(sql, new RegExp(`CREATE POLICY ${table}_[^;]*(?:FOR UPDATE|FOR DELETE)`));
  }
  assert.match(sql, /GRANT INSERT ON app\.outbox_events TO r72_crm_command/);
  assert.doesNotMatch(sql, /GRANT [^;]*INSERT[^;]* ON app\.outbox_events TO r72_(?:web|worker)/);
  assert.doesNotMatch(sql, /GRANT [^;]*(?:UPDATE|DELETE)[^;]* ON app\.outbox_events TO r72_(?:web|crm_command|worker)/);
  assert.doesNotMatch(sql, /CREATE POLICY outbox_events_[^;]*(?:FOR UPDATE|FOR DELETE)/);
  assert.match(sql, /status text NOT NULL DEFAULT 'pending' CHECK \(status = 'pending'\)/);
  assert.match(sql, /attempt_count integer NOT NULL DEFAULT 0 CHECK \(attempt_count = 0\)/);
});

test('0003 makes command idempotency caller-scoped and permits only one-way terminal completion', async () => {
  const sql = normalise(await readFile(migration3Url, 'utf8'));
  assert.match(sql, /UNIQUE \(workspace_id, actor_user_id, command_name, idempotency_key\)/);
  assert.match(sql, /payload_hash bytea NOT NULL CHECK \(octet_length\(payload_hash\) = 32\)/);
  assert.match(sql, /actor_user_id = app_private\.current_user_id\(\)/);
  assert.match(sql, /AND status = 'started' \) WITH CHECK/);
  assert.match(sql, /AND status IN \('succeeded', 'failed'\)/);
  assert.match(sql, /GRANT SELECT, INSERT ON app\.command_receipts TO r72_crm_command/);
  assert.match(sql, /GRANT UPDATE \(result, status, response_status, completed_at\) ON app\.command_receipts TO r72_crm_command/);
  assert.doesNotMatch(sql, /command_receipts[^;]*expires_at/);
  assert.doesNotMatch(sql, /GRANT [^;]*(?:SELECT|INSERT|UPDATE|DELETE)[^;]*app\.command_receipts[^;]*TO r72_(?:web|worker)/);
  assert.doesNotMatch(sql, /GRANT UPDATE \([^)]*(?:workspace_id|actor_user_id|command_name|idempotency_key|payload_hash)[^)]*\) ON app\.command_receipts/);
});

test('0003 seeds an idempotent default sales pipeline and ordered semantic stages for existing workspaces', async () => {
  const sql = normalise(await readFile(migration3Url, 'utf8'));
  assert.match(sql, /INSERT INTO app\.pipelines \(workspace_id, name, slug, is_default\) SELECT workspace\.id, 'Sales', 'sales', false FROM app\.workspaces AS workspace ON CONFLICT \(workspace_id, slug\) DO NOTHING/);
  assert.match(sql, /NOT EXISTS \( SELECT 1 FROM app\.pipelines AS existing_default WHERE existing_default\.workspace_id = pipeline\.workspace_id AND existing_default\.is_default \)/);
  for (const stage of [
    /\('New lead', 'new-lead', 1, 'open'\)/,
    /\('Qualified', 'qualified', 2, 'open'\)/,
    /\('Proposal', 'proposal', 3, 'open'\)/,
    /\('Won', 'won', 4, 'won'\)/,
    /\('Lost', 'lost', 5, 'lost'\)/,
  ]) {
    assert.match(sql, stage);
  }
  assert.match(sql, /ON CONFLICT DO NOTHING/);
});

test('0004 creates an isolated identity command role with function-only authority', async () => {
  const sql = normalise(await readFile(migration4Url, 'utf8'));
  assert.match(sql, /ALTER ROLE r72_identity_command LOGIN [^;]* NOBYPASSRLS NOINHERIT/);
  assert.match(sql, /REVOKE r72_owner, r72_security_definer FROM r72_identity_command/);
  assert.match(sql, /Unsafe identity role membership/);
  assert.match(sql, /Unsafe identity role grant/);
  assert.match(sql, /parent\.rolname = 'r72_identity_command' AND member\.rolname <> current_user/);
  assert.match(sql, /Unsafe privileged role membership/);
  assert.match(sql, /Unsafe privileged role grant/);
  assert.match(sql, /parent\.rolname = 'r72_owner' AND member\.rolname <> current_user/);
  assert.match(sql, /parent\.rolname = 'r72_security_definer' AND member\.rolname <> 'r72_owner'/);
  assert.match(sql, /REVOKE ALL ON ALL TABLES IN SCHEMA app FROM r72_identity_command/);
  assert.doesNotMatch(sql, /GRANT (?:SELECT|INSERT|UPDATE|DELETE)[^;]* TO r72_identity_command/);
  for (const fn of [
    'portal_login_credential',
    'create_portal_session',
    'revoke_portal_session',
    'upgrade_portal_password_hash',
  ]) {
    assert.match(sql, new RegExp(`GRANT EXECUTE ON FUNCTION app_private\\.${fn}\\(`));
  }
  assert.doesNotMatch(sql, /GRANT EXECUTE ON FUNCTION app_private\.(?:resolve_portal_session|lock_active_portal_session|active_portal_session)[^;]* TO r72_identity_command/);
});

test('0004 makes login credentials pre-context but session issuance compare-and-swap safe', async () => {
  const sql = normalise(await readFile(migration4Url, 'utf8'));
  assert.match(sql, /CREATE FUNCTION app_private\.portal_login_credential\(p_email text\)/);
  assert.match(sql, /person\.status = 'active' AND person\.password_hash IS NOT NULL/);
  assert.match(sql, /app_private\.has_active_workspace_membership\(person\.id, candidate\.workspace_id\)/);
  assert.match(sql, /candidate_workspace\.legacy_tenant_key IS NOT NULL/);
  assert.match(sql, /candidate_workspace\.legacy_tenant_key = btrim\(candidate_workspace\.legacy_tenant_key\)/);
  assert.match(sql, /pg_catalog\.lower\(person\.email::text\) = pg_catalog\.lower\(pg_catalog\.btrim\(p_email\)\)/);
  assert.match(sql, /RETURNS TABLE \( user_id uuid, user_email text, password_hash text/);
  assert.match(sql, /CREATE FUNCTION app_private\.create_portal_session\( p_user_id uuid, p_workspace_id uuid, p_expected_password_hash text/);
  assert.match(sql, /person\.password_hash = p_expected_password_hash/);
  assert.match(sql, /FOR SHARE OF person, membership, workspace, organization/);
  assert.match(sql, /RETURN QUERY SELECT created_session_id, p_user_id, selected_user_email, p_workspace_id/);
  assert.match(sql, /FOR SHARE OF source_membership/);
  assert.match(sql, /GRANT UPDATE \(updated_at\) ON app\.organizations, app\.workspaces, app\.organization_memberships, app\.workspace_memberships TO r72_security_definer/);
  for (const table of ['organizations', 'workspaces', 'organization_memberships', 'workspace_memberships']) {
    assert.match(sql, new RegExp(`CREATE POLICY ${table}_security_lock ON app\\.${table} FOR UPDATE TO r72_security_definer USING \\(true\\) WITH CHECK \\(true\\)`));
  }
  assert.match(sql, /octet_length\(p_token_hash\) <> 32/);
  assert.match(sql, /statement_timestamp\(\) \+ interval '14 days'/);
  assert.match(sql, /INSERT INTO app\.user_sessions/);
  assert.match(sql, /CREATE FUNCTION app_private\.upgrade_portal_password_hash/);
  assert.match(sql, /p_expected_hash IS NULL OR p_replacement_hash IS NULL/);
  assert.match(sql, /person\.password_hash = p_expected_hash/);
});

test('0004 revalidates portal sessions inside read and command transactions', async () => {
  const sql = normalise(await readFile(migration4Url, 'utf8'));
  assert.match(sql, /CREATE FUNCTION app_private\.resolve_portal_session\(p_token_hash bytea\)/);
  assert.match(sql, /JOIN app\.users AS person ON person\.id = resolved\.user_id AND person\.status = 'active'/);
  assert.match(sql, /SELECT resolved\.session_id, resolved\.user_id, person\.email::text/);
  assert.match(sql, /CREATE FUNCTION app_private\.lock_active_portal_session/);
  assert.match(sql, /session\.token_hash = p_token_hash/);
  assert.match(sql, /session\.user_id = p_user_id/);
  assert.match(sql, /session\.selected_workspace_id = p_workspace_id/);
  assert.match(sql, /session\.revoked_at IS NULL/);
  assert.match(sql, /session\.expires_at > statement_timestamp\(\)/);
  assert.match(sql, /FOR SHARE OF session/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app_private\.lock_active_portal_session\(bytea, uuid, uuid\) TO r72_crm_command/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app_private\.active_portal_session\(bytea, uuid, uuid\) TO r72_web/);
  assert.doesNotMatch(sql, /GRANT EXECUTE ON FUNCTION app_private\.lock_active_portal_session[^;]* TO r72_web/);
});

test('0004 exposes an exact read-only migration ledger without exposing its table', async () => {
  const sql = normalise(await readFile(migration4Url, 'utf8'));
  assert.match(sql, /CREATE FUNCTION app_private\.runtime_schema_migrations\(\)/);
  assert.match(sql, /SECURITY DEFINER SET search_path = pg_catalog/);
  assert.match(sql, /FROM app_private\.schema_migrations/);
  assert.match(sql, /REVOKE ALL ON FUNCTION app_private\.runtime_schema_migrations\(\) FROM PUBLIC/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app_private\.runtime_schema_migrations\(\) TO r72_web/);
  assert.doesNotMatch(sql, /GRANT SELECT ON app_private\.schema_migrations TO r72_web/);
});
