import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { discoverMigrations } from '../../src/db/migrate.js';

const migration1Url = new URL('../../src/db/migrations/0001_extensions_roles.sql', import.meta.url);
const migration2Url = new URL('../../src/db/migrations/0002_identity_workspaces.sql', import.meta.url);
const migration3Url = new URL('../../src/db/migrations/0003_crm_first_loop.sql', import.meta.url);
const migration4Url = new URL('../../src/db/migrations/0004_portal_sessions.sql', import.meta.url);
const migration5Url = new URL('../../src/db/migrations/0005_canonical_portal_identity.sql', import.meta.url);
const migration6Url = new URL('../../src/db/migrations/0006_customer_provisioning.sql', import.meta.url);
const migration7Url = new URL('../../src/db/migrations/0007_public_schema_hardening.sql', import.meta.url);
const migration8Url = new URL('../../src/db/migrations/0008_setup_delivery_recovery.sql', import.meta.url);
const migration9Url = new URL('../../src/db/migrations/0009_neon_integration_repairs.sql', import.meta.url);
const migration10Url = new URL('../../src/db/migrations/0010_delivery_lease_portability.sql', import.meta.url);
const migration11Url = new URL('../../src/db/migrations/0011_stable_chronology_defaults.sql', import.meta.url);

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
  for (const role of ['r72_owner', 'r72_security_definer']) {
    assert.match(sql, new RegExp(`\('${role}', false, true\)`));
  }
  for (const role of ['r72_web', 'r72_public', 'r72_worker', 'r72_webhook', 'r72_readonly']) {
    assert.match(sql, new RegExp(`\('${role}', true, false\)`));
  }
  assert.match(sql, /'CREATE ROLE %I %s %s'/);
  assert.match(sql, /rolcanlogin = expected_login AND rolinherit = expected_inherit AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls/);
  assert.match(sql, /Unsafe role attributes/);
  assert.match(sql, /REVOKE r72_owner, r72_security_definer FROM r72_web, r72_public, r72_worker, r72_webhook, r72_readonly/);
  assert.match(sql, /FROM pg_catalog\.pg_auth_members AS membership/);
  assert.match(sql, /Unsafe role membership/);
  assert.match(sql, /CREATE SCHEMA IF NOT EXISTS app AUTHORIZATION r72_owner; CREATE SCHEMA IF NOT EXISTS app_private AUTHORIZATION r72_owner; SET LOCAL ROLE r72_owner/);
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

test('pre-launch 0001 role bootstrap and issued 0002 bytes remain checksum-pinned', async () => {
  const digest = (source: string): string => createHash('sha256')
    .update(source.replace(/\r\n/g, '\n'))
    .digest('hex');
  assert.equal(digest(await readFile(migration1Url, 'utf8')), '188dff7a4c51034e197c3166e8170c1b77c2e1a48c088bb213c6a1258021ba6d');
  assert.equal(digest(await readFile(migration2Url, 'utf8')), '6e231cdf96281cdd246e01a7780a2ddb0bdfe7465a955167b071b911d89378ed');
});

test('role bootstraps never ALTER protected attributes that managed Postgres cannot change', async () => {
  const sources = await Promise.all([
    migration1Url,
    migration3Url,
    migration4Url,
    migration6Url,
    migration8Url,
  ].map((url) => readFile(url, 'utf8')));
  const sql = normalise(sources.join('\n'));
  assert.doesNotMatch(
    sql,
    /ALTER ROLE [^;]*\b(?:SUPERUSER|NOSUPERUSER|CREATEDB|NOCREATEDB|CREATEROLE|NOCREATEROLE|REPLICATION|NOREPLICATION|BYPASSRLS|NOBYPASSRLS)\b/,
  );
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

test('0003 bootstraps and audits the isolated CRM command role', async () => {
  const sql = normalise(await readFile(migration3Url, 'utf8'));
  assert.match(sql, /CREATE ROLE r72_crm_command LOGIN NOINHERIT/);
  assert.match(sql, /rolname = 'r72_crm_command' AND rolcanlogin AND NOT rolinherit AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls/);
  assert.match(sql, /Unsafe role attributes: r72_crm_command/);
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
  assert.match(sql, /CREATE ROLE r72_identity_command LOGIN NOINHERIT/);
  assert.match(sql, /rolname = 'r72_identity_command' AND rolcanlogin AND NOT rolinherit AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls/);
  assert.match(sql, /Unsafe role attributes: r72_identity_command/);
  assert.match(sql, /REVOKE r72_owner, r72_security_definer FROM r72_identity_command/);
  assert.match(sql, /Unsafe identity role membership/);
  assert.match(sql, /Unsafe identity role grant/);
  assert.match(sql, /parent\.rolname = 'r72_identity_command' AND member\.rolname <> current_user/);
  assert.match(sql, /Unsafe privileged role membership/);
  assert.match(sql, /Unsafe privileged role grant/);
  assert.match(sql, /parent\.rolname = 'r72_owner' AND member\.rolname <> current_user/);
  assert.match(sql, /parent\.rolname = 'r72_security_definer' AND member\.rolname NOT IN \('r72_owner', current_user\)/);
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

test('0005 recreates effective portal authentication under the non-login function owner', async () => {
  const sql = normalise(await readFile(migration5Url, 'utf8'));
  assert.match(sql, /SET LOCAL ROLE r72_owner; GRANT CREATE ON SCHEMA app_private TO r72_security_definer; SET LOCAL ROLE r72_security_definer/);
  for (const signature of [
    'portal_login_credential\\(text\\)',
    'create_portal_session\\(uuid, uuid, text, bytea, bytea, bytea, bytea\\)',
    'resolve_portal_session\\(bytea\\)',
    'upgrade_portal_password_hash\\(uuid, text, text\\)',
  ]) {
    assert.match(sql, new RegExp(`DROP FUNCTION app_private\\.${signature}`));
  }
  assert.equal((sql.match(/CREATE FUNCTION app_private\./g) ?? []).length, 3);
  assert.equal((sql.match(/SECURITY DEFINER SET search_path = pg_catalog/g) ?? []).length, 3);
  assert.doesNotMatch(sql, /CREATE FUNCTION app_private\.upgrade_portal_password_hash/);
  assert.match(sql, /CREATE FUNCTION app_private\.resolve_portal_session\(p_token_hash bytea\)[^;]+\$function\$; SET LOCAL ROLE r72_owner; REVOKE CREATE ON SCHEMA app_private FROM r72_security_definer/);
});

test('0005 removes the JSON tenant bridge and returns canonical identity columns only', async () => {
  const sql = normalise(await readFile(migration5Url, 'utf8'));
  assert.doesNotMatch(sql, /legacy_tenant_key/);
  assert.match(sql, /CREATE FUNCTION app_private\.portal_login_credential\(p_email text\) RETURNS TABLE \( user_id uuid, user_email text, password_hash text, selected_workspace_id uuid \)/);
  assert.match(sql, /CREATE FUNCTION app_private\.create_portal_session\([^;]+RETURNS TABLE \( session_id uuid, user_id uuid, user_email text, selected_workspace_id uuid, expires_at timestamptz \)/);
  assert.match(sql, /CREATE FUNCTION app_private\.resolve_portal_session\(p_token_hash bytea\) RETURNS TABLE \( session_id uuid, user_id uuid, user_email text, selected_workspace_id uuid \)/);
  assert.match(sql, /SELECT resolved\.session_id, resolved\.user_id, person\.email::text, resolved\.selected_workspace_id FROM app_private\.resolve_session\(p_token_hash\) AS resolved/);
});

test('0005 preserves active membership checks, lifecycle locks, and least-privilege grants', async () => {
  const sql = normalise(await readFile(migration5Url, 'utf8'));
  assert.match(sql, /candidate\.status = 'active'/);
  assert.match(sql, /app_private\.has_active_workspace_membership\(person\.id, candidate\.workspace_id\)/);
  assert.match(sql, /person\.status = 'active' AND person\.password_hash IS NOT NULL/);
  for (const predicate of [
    /person\.status = 'active'/,
    /membership\.status = 'active'/,
    /workspace\.status = 'active'/,
    /organization\.status = 'active'/,
  ]) {
    assert.match(sql, predicate);
  }
  assert.match(sql, /person\.password_hash = p_expected_password_hash/);
  assert.match(sql, /FOR SHARE OF person, membership, workspace, organization/);
  assert.match(sql, /selected_source_organization_id IS NOT NULL/);
  assert.match(sql, /source_membership\.status = 'active' FOR SHARE OF source_membership/);
  assert.match(sql, /RAISE EXCEPTION 'portal identity source membership is not active' USING ERRCODE = '42501'/);

  assert.match(sql, /GRANT EXECUTE ON FUNCTION app_private\.portal_login_credential\(text\) TO r72_identity_command/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app_private\.create_portal_session\(uuid, uuid, text, bytea, bytea, bytea, bytea\) TO r72_identity_command/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app_private\.resolve_portal_session\(bytea\) TO r72_web/);
  assert.doesNotMatch(sql, /GRANT EXECUTE ON FUNCTION app_private\.resolve_portal_session\(bytea\) TO r72_identity_command/);
  assert.doesNotMatch(sql, /GRANT EXECUTE ON FUNCTION app_private\.(?:portal_login_credential|create_portal_session)[^;]+ TO r72_web/);
  assert.doesNotMatch(sql, /GRANT EXECUTE ON FUNCTION app_private\.upgrade_portal_password_hash/);
});

test('bundled migration discovery orders and checksums native identity through managed-Postgres repairs', async () => {
  const migrations = await discoverMigrations();
  const tail = migrations.slice(-7);
  assert.deepEqual(tail.map(({ filename, version }) => ({ filename, version })), [
    { filename: '0005_canonical_portal_identity.sql', version: 5 },
    { filename: '0006_customer_provisioning.sql', version: 6 },
    { filename: '0007_public_schema_hardening.sql', version: 7 },
    { filename: '0008_setup_delivery_recovery.sql', version: 8 },
    { filename: '0009_neon_integration_repairs.sql', version: 9 },
    { filename: '0010_delivery_lease_portability.sql', version: 10 },
    { filename: '0011_stable_chronology_defaults.sql', version: 11 },
  ]);
  const sources = [
    (await readFile(migration5Url, 'utf8')).replace(/\r\n?/g, '\n'),
    (await readFile(migration6Url, 'utf8')).replace(/\r\n?/g, '\n'),
    (await readFile(migration7Url, 'utf8')).replace(/\r\n?/g, '\n'),
    (await readFile(migration8Url, 'utf8')).replace(/\r\n?/g, '\n'),
    (await readFile(migration9Url, 'utf8')).replace(/\r\n?/g, '\n'),
    (await readFile(migration10Url, 'utf8')).replace(/\r\n?/g, '\n'),
    (await readFile(migration11Url, 'utf8')).replace(/\r\n?/g, '\n'),
  ];
  for (const [index, migration] of tail.entries()) {
    assert.equal(migration!.checksum, createHash('sha256').update(sources[index]!, 'utf8').digest('hex'));
  }
});

test('0009 stabilises session defaults and grants only the claim-lock capability', async () => {
  const foundation = normalise(await readFile(migration2Url, 'utf8'));
  const sql = normalise(await readFile(migration9Url, 'utf8'));
  assert.match(foundation, /CHECK \(expires_at > created_at\)/);
  assert.match(foundation, /CHECK \(last_seen_at >= created_at\)/);
  assert.match(sql, /SET LOCAL ROLE r72_owner/);
  assert.match(sql, /ALTER TABLE app\.user_sessions ALTER COLUMN last_seen_at SET DEFAULT statement_timestamp\(\), ALTER COLUMN created_at SET DEFAULT statement_timestamp\(\)/);
  assert.doesNotMatch(sql, /DROP CONSTRAINT/);
  assert.match(sql, /GRANT UPDATE \(created_at\) ON app_private\.account_setup_claims TO r72_security_definer/);
  assert.doesNotMatch(sql, /GRANT UPDATE ON app_private\.account_setup_claims/);
});

test('0010 repairs lease renewal without weakening its function boundary', async () => {
  const sql = normalise(await readFile(migration10Url, 'utf8'));
  assert.match(sql, /CREATE OR REPLACE FUNCTION app_private\.renew_account_setup_delivery_lease\(/);
  assert.match(sql, /SECURITY DEFINER SET search_path = pg_catalog/);
  assert.match(sql, /SET lease_expires_at = least\(/);
  assert.doesNotMatch(sql, /pg_catalog\.least/);
  assert.match(sql, /REVOKE CREATE ON SCHEMA app_private FROM r72_setup_delivery_definer/);
  assert.match(sql, /REVOKE ALL ON FUNCTION app_private\.renew_account_setup_delivery_lease\( uuid, bytea, integer \) FROM PUBLIC/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app_private\.renew_account_setup_delivery_lease\( uuid, bytea, integer \) TO r72_setup_delivery_command/);
});

test('0011 makes lifecycle chronology deterministic without inverting event facts', async () => {
  const crm = normalise(await readFile(migration3Url, 'utf8'));
  const sql = normalise(await readFile(migration11Url, 'utf8'));
  const stableColumns: Readonly<Record<string, readonly string[]>> = {
    'app.organizations': ['created_at', 'updated_at'],
    'app.users': ['created_at', 'updated_at'],
    'app.organization_branding': ['created_at', 'updated_at'],
    'app.workspaces': ['created_at', 'updated_at'],
    'app.organization_domains': ['created_at', 'updated_at'],
    'app.organization_memberships': ['granted_at', 'updated_at'],
    'app.workspace_memberships': ['granted_at', 'updated_at'],
    'app.membership_invitations': ['created_at', 'updated_at'],
    'app.identity_action_tokens': ['created_at'],
    'app.contacts': ['created_at', 'updated_at'],
    'app.contact_points': ['created_at', 'updated_at'],
    'app.pipelines': ['created_at', 'updated_at'],
    'app.pipeline_stages': ['created_at', 'updated_at'],
    'app.opportunities': ['created_at', 'updated_at'],
    'app.tasks': ['created_at', 'updated_at'],
    'app.command_receipts': ['created_at'],
    'app_private.account_setup_deliveries': ['created_at', 'updated_at'],
    'app_private.account_setup_claims': ['created_at'],
  };
  for (const [table, columns] of Object.entries(stableColumns)) {
    for (const column of columns) {
      assert.match(
        sql,
        new RegExp(`ALTER TABLE ${table.replace('.', '\\.')}[^;]*ALTER COLUMN ${column} SET DEFAULT statement_timestamp\\(\\)`),
      );
    }
  }
  assert.match(crm, /CHECK \(closed_at IS NULL OR closed_at >= created_at\)/);
  assert.match(crm, /CHECK \(completed_at IS NULL OR completed_at >= created_at\)/);
  assert.doesNotMatch(sql, /ALTER TABLE app\.(?:activities|outbox_events|user_sessions)/);
  assert.doesNotMatch(sql, /DROP CONSTRAINT/);
});

test('0007 removes ambient public-schema object creation from every application role', async () => {
  const sql = normalise(await readFile(migration7Url, 'utf8'));
  assert.match(sql, /REVOKE CREATE ON SCHEMA public FROM PUBLIC/);
  for (const role of [
    'r72_owner', 'r72_security_definer', 'r72_web', 'r72_public',
    'r72_worker', 'r72_webhook', 'r72_readonly', 'r72_crm_command',
    'r72_identity_command', 'r72_provisioning_command',
  ]) {
    assert.match(sql, new RegExp(`(?:FROM|,) ${role}(?:,|;)`));
  }
  assert.doesNotMatch(sql, /REVOKE USAGE ON SCHEMA public/);
  assert.doesNotMatch(sql, /DROP (?:EXTENSION|SCHEMA)/);
});

test('0006 isolates native provisioning behind one function-only runtime role', async () => {
  const sql = normalise(await readFile(migration6Url, 'utf8'));
  assert.match(sql, /CREATE ROLE r72_provisioning_command LOGIN NOINHERIT/);
  assert.match(sql, /rolname = 'r72_provisioning_command' AND rolcanlogin AND NOT rolinherit AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls/);
  assert.match(sql, /Unsafe role attributes: r72_provisioning_command/);
  assert.match(sql, /REVOKE r72_owner, r72_security_definer FROM r72_provisioning_command/);
  assert.match(sql, /Unsafe provisioning role membership/);
  assert.match(sql, /Unsafe provisioning role grant/);
  assert.match(sql, /Unsafe privileged role membership/);
  assert.match(sql, /Unsafe privileged role grant/);
  assert.match(sql, /parent\.rolname = 'r72_security_definer' AND member\.rolname NOT IN \('r72_owner', current_user\)/);
  assert.match(sql, /REVOKE ALL ON ALL TABLES IN SCHEMA app FROM r72_provisioning_command/);
  assert.match(sql, /REVOKE ALL ON ALL TABLES IN SCHEMA app_private FROM r72_provisioning_command/);
  assert.match(sql, /REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app_private FROM r72_provisioning_command/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app_private\.provision_customer_workspace\([^;]+\) TO r72_provisioning_command/);
  assert.doesNotMatch(sql, /GRANT (?:SELECT|INSERT|UPDATE|DELETE)[^;]* TO r72_provisioning_command/);
  assert.doesNotMatch(sql, /GRANT EXECUTE ON FUNCTION app_private\.complete_native_account_setup\([^;]+\) TO r72_provisioning_command/);
});

test('0006 binds setup credentials to one workspace and keeps idempotency state private', async () => {
  const sql = normalise(await readFile(migration6Url, 'utf8'));
  assert.match(sql, /ALTER TABLE app\.identity_action_tokens ADD COLUMN workspace_id uuid/);
  assert.match(sql, /FOREIGN KEY \(workspace_id, user_id\) REFERENCES app\.workspace_memberships \(workspace_id, user_id\) ON DELETE CASCADE/);
  assert.match(sql, /CHECK \(purpose <> 'account_setup' OR workspace_id IS NOT NULL\)/);
  assert.match(sql, /CREATE INDEX identity_action_tokens_workspace_active_idx ON app\.identity_action_tokens \(workspace_id, user_id, purpose, expires_at\) WHERE consumed_at IS NULL AND revoked_at IS NULL/);
  assert.match(sql, /CREATE UNIQUE INDEX identity_action_tokens_one_active_setup_uq ON app\.identity_action_tokens \(user_id\) WHERE purpose = 'account_setup' AND consumed_at IS NULL AND revoked_at IS NULL/);
  assert.match(sql, /VALUES \('app', 'identity_action_tokens', 'workspace_id'\)/);

  const receipt = /CREATE TABLE app_private\.customer_provisioning_receipts \((.*?)\);/.exec(sql)?.[1];
  assert.ok(receipt);
  assert.match(receipt, /idempotency_key text PRIMARY KEY/);
  assert.match(receipt, /request_hash bytea NOT NULL CHECK \(octet_length\(request_hash\) = 32\)/);
  assert.match(receipt, /organization_id uuid NOT NULL UNIQUE REFERENCES app\.organizations/);
  assert.match(receipt, /workspace_id uuid NOT NULL UNIQUE REFERENCES app\.workspaces/);
  assert.match(receipt, /setup_token_id uuid NOT NULL UNIQUE/);
  assert.doesNotMatch(receipt, /REFERENCES app\.identity_action_tokens/);
  assert.doesNotMatch(receipt, /token_hash|raw_token|token_value/);
  assert.match(sql, /REVOKE ALL ON app_private\.customer_provisioning_receipts FROM PUBLIC/);
  assert.doesNotMatch(sql, /GRANT [^;]*app_private\.customer_provisioning_receipts[^;]* TO r72_(?:web|public|worker|webhook|readonly|crm_command|identity_command|provisioning_command)/);
});

test('0006 provisions the entire first workspace atomically and replays only a stable receipt', async () => {
  const sql = normalise(await readFile(migration6Url, 'utf8'));
  assert.match(sql, /CREATE FUNCTION app_private\.provision_customer_workspace\(/);
  assert.match(sql, /SECURITY DEFINER SET search_path = pg_catalog/);
  assert.match(sql, /pg_advisory_xact_lock\( pg_catalog\.hashtextextended\(normalized_idempotency_key, 7200006\) \)/);
  assert.match(sql, /customer provisioning idempotency key was reused with different input/);
  assert.match(sql, /customer provisioning idempotency key was reused with different input' USING ERRCODE = '22023'/);
  assert.match(sql, /RETURN QUERY SELECT existing_organization_id, existing_workspace_id, existing_owner_user_id, existing_setup_token_id, existing_setup_expires_at, false/);

  const stableHash = /stable_request_hash := public\.digest\((.*?)\);/.exec(sql)?.[1];
  assert.ok(stableHash);
  assert.match(stableHash, /normalized_organization_name/);
  assert.match(stableHash, /normalized_workspace_slug/);
  assert.match(stableHash, /normalized_owner_email/);
  assert.doesNotMatch(stableHash, /p_setup_token_hash/);

  assert.match(sql, /INSERT INTO app\.organizations \(name, slug, kind\)/);
  assert.match(sql, /INSERT INTO app\.users \(email, display_name\)/);
  assert.match(sql, /INSERT INTO app\.workspaces/);
  assert.match(sql, /FROM pg_catalog\.pg_timezone_names AS timezone WHERE timezone\.name = normalized_timezone/);
  assert.match(sql, /INSERT INTO app\.organization_memberships/);
  assert.match(sql, /INSERT INTO app\.workspace_memberships/);
  assert.match(sql, /INSERT INTO app\.identity_action_tokens/);
  assert.match(sql, /created_setup_expires_at timestamptz := statement_timestamp\(\) \+ interval '24 hours'/);
  assert.match(sql, /'account_setup', p_setup_token_hash, created_setup_expires_at/);
  assert.match(sql, /INSERT INTO app\.pipelines \(workspace_id, name, slug, is_default\) VALUES \(created_workspace_id, 'Sales', 'sales', true\)/);
  for (const stage of [
    /'New lead', 'new-lead', 1, 'open', false/,
    /'Qualified', 'qualified', 2, 'open', false/,
    /'Proposal', 'proposal', 3, 'open', false/,
    /'Won', 'won', 4, 'won', true/,
    /'Lost', 'lost', 5, 'lost', true/,
  ]) {
    assert.match(sql, stage);
  }
  assert.match(sql, /RETURN QUERY SELECT created_organization_id, created_workspace_id, created_owner_user_id, created_setup_token_id, created_setup_expires_at, true/);
  assert.doesNotMatch(sql, /p_setup_token(?!_(?:hash|id))/);
});

test('0006 consumes setup once, activates the owner, and issues the first opaque session atomically', async () => {
  const sql = normalise(await readFile(migration6Url, 'utf8'));
  assert.match(sql, /CREATE FUNCTION app_private\.complete_native_account_setup\(/);
  assert.match(sql, /p_password_hash !~ '\^scrypt\\\$v1\\\$16384,8,1\\\$\[A-Za-z0-9_-\]\{22\}\\\$\[A-Za-z0-9_-\]\{43\}\$'/);
  assert.match(sql, /action_token\.token_hash = p_setup_token_hash/);
  assert.match(sql, /action_token\.workspace_id INTO selected_action_token_id, selected_user_id, selected_user_email, selected_setup_workspace_id/);
  assert.match(sql, /action_token\.purpose = 'account_setup'/);
  assert.match(sql, /action_token\.consumed_at IS NULL/);
  assert.match(sql, /action_token\.revoked_at IS NULL/);
  assert.match(sql, /action_token\.expires_at > statement_timestamp\(\)/);
  assert.match(sql, /person\.status = 'pending' AND person\.password_hash IS NULL/);
  assert.match(sql, /membership\.status = 'active' AND membership\.role = 'owner'/);
  assert.match(sql, /organization_membership\.status = 'active' AND organization_membership\.role = 'owner'/);
  assert.match(sql, /FOR UPDATE OF action_token, person, membership, workspace, tenant_organization, organization_membership/);
  assert.doesNotMatch(sql, /RAISE EXCEPTION 'invalid (?:native account setup input|or expired native account setup token)'/);
  assert.match(sql, /SET password_hash = p_password_hash, email_verified_at = statement_timestamp\(\), status = 'active'/);
  assert.match(sql, /SET consumed_at = statement_timestamp\(\) WHERE action_token\.id = selected_action_token_id/);
  assert.match(sql, /SET revoked_at = statement_timestamp\(\) WHERE peer_token\.user_id = selected_user_id AND peer_token\.purpose = 'account_setup'/);
  assert.match(sql, /INSERT INTO app\.user_sessions/);
  assert.match(sql, /selected_user_id, selected_setup_workspace_id, selected_expires_at/);
  assert.match(sql, /statement_timestamp\(\) \+ interval '14 days'/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app_private\.complete_native_account_setup\([^;]+\) TO r72_identity_command/);
  assert.doesNotMatch(sql, /GRANT EXECUTE ON FUNCTION app_private\.provision_customer_workspace\([^;]+\) TO r72_identity_command/);
});

test('0008 separates onboarding, setup delivery, reissue, and identity capabilities', async () => {
  const sql = normalise(await readFile(migration8Url, 'utf8'));
  for (const role of [
    'r72_onboarding_definer', 'r72_setup_delivery_definer',
    'r72_setup_delivery_command', 'r72_setup_reissue_command',
  ]) {
    assert.match(sql, new RegExp(`'${role}'`));
  }
  assert.match(sql, /\('r72_onboarding_definer', false\)/);
  assert.match(sql, /\('r72_setup_delivery_definer', false\)/);
  assert.match(sql, /\('r72_setup_delivery_command', true\)/);
  assert.match(sql, /\('r72_setup_reissue_command', true\)/);
  assert.match(sql, /'CREATE ROLE %I %s NOINHERIT'/);
  assert.match(sql, /rolcanlogin = expected_login AND NOT rolinherit AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls/);
  assert.match(sql, /Unsafe role attributes/);
  const allDeliveryRoles = 'r72_onboarding_definer, r72_setup_delivery_definer, r72_setup_delivery_command, r72_setup_reissue_command';
  assert.ok(sql.includes(`REVOKE ALL ON ALL TABLES IN SCHEMA app FROM ${allDeliveryRoles}`));
  assert.ok(sql.includes(`REVOKE ALL ON ALL TABLES IN SCHEMA app_private FROM ${allDeliveryRoles}`));
  assert.ok(sql.includes(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app_private FROM ${allDeliveryRoles}`));
  assert.ok(sql.includes(`REVOKE CREATE ON SCHEMA public FROM ${allDeliveryRoles}`));
  assert.doesNotMatch(sql, /GRANT (?:SELECT|INSERT|UPDATE|DELETE)[^;]* TO r72_setup_(?:delivery|reissue)_command/);

  const createGrant = sql.indexOf('GRANT CREATE ON SCHEMA app_private TO r72_onboarding_definer');
  const ownershipTransfer = sql.indexOf('ALTER FUNCTION app_private.provision_customer_workspace');
  assert.ok(createGrant >= 0 && createGrant < ownershipTransfer, 'target definer can own the existing function');
  assert.match(sql, /ALTER FUNCTION app_private\.provision_customer_workspace\([^;]+\) OWNER TO r72_onboarding_definer/);
  assert.match(sql, /REVOKE INSERT ON app\.organizations,[^;]+ FROM r72_security_definer/);
  assert.match(sql, /REVOKE ALL ON app_private\.customer_provisioning_receipts FROM r72_security_definer/);
  assert.match(sql, /REVOKE ALL ON FUNCTION app_private\.provision_customer_workspace\([^;]+\) FROM r72_provisioning_command/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app_private\.provision_customer_workspace_with_setup_delivery\([^;]+\) TO r72_provisioning_command/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app_private\.reissue_native_account_setup\([^;]+\) TO r72_setup_reissue_command/);
  assert.doesNotMatch(sql, /GRANT EXECUTE ON FUNCTION app_private\.reissue_native_account_setup\([^;]+\) TO r72_(?:provisioning|identity|setup_delivery)_command/);
});

test('0008 stores only authenticated ciphertext and hash-only setup credentials', async () => {
  const sql = normalise(await readFile(migration8Url, 'utf8'));
  const table = /CREATE TABLE app_private\.account_setup_deliveries \((.*?)\);/.exec(sql)?.[1];
  assert.ok(table);
  for (const field of [
    /recipient_email_hash bytea NOT NULL CHECK \(octet_length\(recipient_email_hash\) = 32\)/,
    /payload_version smallint NOT NULL CHECK \(payload_version = 1\)/,
    /encryption_key_id text NOT NULL/,
    /encryption_iv bytea/,
    /encrypted_payload bytea/,
    /authentication_tag bytea/,
    /lease_token_hash bytea/,
  ]) assert.match(table, field);
  assert.doesNotMatch(table, /raw|setup_token(?!_id)|recipient_email text|setup_url/);
  assert.match(table, /state IN \('pending', 'leased', 'retry'\) AND encryption_iv IS NOT NULL AND encrypted_payload IS NOT NULL AND authentication_tag IS NOT NULL/);
  assert.match(table, /state IN \('delivered', 'superseded', 'dead_letter'\) AND encryption_iv IS NULL AND encrypted_payload IS NULL AND authentication_tag IS NULL/);
  assert.match(table, /\(state = 'superseded'\) = \(superseded_at IS NOT NULL\)/);
  assert.match(sql, /pg_catalog\.convert_to\('r72\/setup-link\/v1', 'UTF8'\) \|\| pg_catalog\.decode\('00', 'hex'\) \|\| pg_catalog\.convert_to\(pg_catalog\.lower\(claimed\.id::text\), 'UTF8'\)/);
  assert.doesNotMatch(sql, /RETURNS TABLE \([^)]*token_hash/);
  assert.doesNotMatch(sql, /p_(?:raw_)?setup_token(?!_hash)/);
});

test('0008 makes provisioning plus encrypted delivery atomic and replay-stable', async () => {
  const sql = normalise(await readFile(migration8Url, 'utf8'));
  const body = /CREATE FUNCTION app_private\.provision_customer_workspace_with_setup_delivery\((.*?)\$function\$;/.exec(sql)?.[1];
  assert.ok(body);
  assert.match(body, /FROM app_private\.provision_customer_workspace\(/);
  assert.match(body, /IF selected_created_now THEN INSERT INTO app_private\.account_setup_deliveries/);
  assert.match(body, /ELSE SELECT delivery\.id, delivery\.generation/);
  assert.match(body, /provisioned customer has no durable setup delivery; use trusted reissue/);
  assert.match(body, /p_recipient_email_hash <> public\.digest/);
  assert.doesNotMatch(body, /UPDATE app_private\.account_setup_deliveries[^;]*encrypted_payload = p_encrypted_payload/);
  assert.match(sql, /CREATE TRIGGER identity_action_tokens_redact_setup_delivery AFTER UPDATE OF consumed_at, revoked_at ON app\.identity_action_tokens/);
  assert.match(sql, /TG_OP <> 'UPDATE' OR TG_TABLE_SCHEMA <> 'app' OR TG_TABLE_NAME <> 'identity_action_tokens'/);
  assert.match(sql, /delivery\.state IN \('pending', 'leased', 'retry'\) AND delivery\.superseded_at IS NULL/);
  assert.match(sql, /REVOKE ALL ON FUNCTION app_private\.redact_terminal_account_setup_delivery\(\) FROM PUBLIC/);
});

test('0008 reissue is idempotent, email-bound, serialized, and appends a new generation', async () => {
  const sql = normalise(await readFile(migration8Url, 'utf8'));
  const body = /CREATE FUNCTION app_private\.reissue_native_account_setup\((.*?)\$function\$;/.exec(sql)?.[1];
  assert.ok(body);
  const receiptHash = /stable_request_hash := public\.digest\((.*?)\);/.exec(body)?.[1];
  assert.ok(receiptHash);
  for (const binding of ['p_workspace_id', 'p_user_id', 'normalized_operator_request', 'p_recipient_email_hash']) {
    assert.match(receiptHash, new RegExp(binding));
  }
  assert.match(body, /public\.digest\( pg_catalog\.convert_to\(pg_catalog\.lower\(person\.email::text\), 'UTF8'\), 'sha256' \) = p_recipient_email_hash/);
  assert.match(body, /setup reissue idempotency key was reused with different input/);
  const userLock = body.indexOf('FROM app.users AS person');
  const membershipLock = body.indexOf('FROM app.workspace_memberships AS workspace_membership', userLock);
  const workspaceLock = body.indexOf('FROM app.workspaces AS workspace', membershipLock);
  const organizationLock = body.indexOf('FROM app.organizations AS organization', workspaceLock);
  const organizationMembershipLock = body.indexOf('FROM app.organization_memberships AS organization_membership', organizationLock);
  const tokenLock = body.indexOf('PERFORM action_token.id');
  const claimDelete = body.indexOf('DELETE FROM app_private.account_setup_claims');
  const revoke = body.indexOf('UPDATE app.identity_action_tokens AS action_token SET revoked_at');
  assert.ok(userLock >= 0 && userLock < membershipLock
    && membershipLock < workspaceLock && workspaceLock < organizationLock
    && organizationLock < organizationMembershipLock
    && organizationMembershipLock < tokenLock
    && tokenLock < claimDelete && claimDelete < revoke);
  assert.match(body, /coalesce\(pg_catalog\.max\(delivery\.generation\), 0\) \+ 1/);
  assert.match(body, /INSERT INTO app_private\.account_setup_deliveries/);
  assert.match(body, /RETURN QUERY SELECT existing_action_token_id,[^;]+ false/);
});

test('0008 delivery claims are bounded, fenced, retryable, and erase terminal secrets', async () => {
  const sql = normalise(await readFile(migration8Url, 'utf8'));
  assert.match(sql, /CREATE FUNCTION app_private\.claim_account_setup_deliveries\(/);
  assert.match(sql, /p_batch_size NOT BETWEEN 1 AND 25/);
  assert.match(sql, /authentication_tag bytea, recipient_email_hash bytea, aad_context bytea/);
  assert.match(sql, /FOR UPDATE OF delivery SKIP LOCKED LIMIT 25/);
  assert.match(sql, /FOR UPDATE OF delivery SKIP LOCKED LIMIT p_batch_size/);
  assert.match(sql, /action_token\.consumed_at IS NULL AND action_token\.revoked_at IS NULL AND action_token\.expires_at > statement_timestamp\(\)/);
  assert.match(sql, /attempt_count = delivery\.attempt_count \+ 1/);
  assert.match(sql, /delivery\.attempt_count >= 8/);
  assert.match(sql, /state = 'dead_letter'/);
  assert.match(sql, /CREATE FUNCTION app_private\.renew_account_setup_delivery_lease\(/);
  assert.match(sql, /CREATE FUNCTION app_private\.acknowledge_account_setup_delivery\(/);
  assert.match(sql, /CREATE FUNCTION app_private\.fail_account_setup_delivery\(/);
  assert.match(sql, /delivery\.lease_token_hash = p_lease_token_hash AND delivery\.lease_expires_at > statement_timestamp\(\)/);
  assert.match(sql, /SET state = 'delivered', encryption_iv = NULL, encrypted_payload = NULL, authentication_tag = NULL/);
  assert.match(sql, /normalized_error_code !~ '\^\[a-z0-9\]\[a-z0-9\._:-\]\{0,99\}\$'/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app_private\.claim_account_setup_deliveries\([^;]+\) TO r72_setup_delivery_command/);
  assert.match(sql, /CREATE FUNCTION app_private\.required_account_setup_delivery_key_ids\(\)[^;]+JOIN app\.identity_action_tokens AS action_token[^;]+JOIN app\.users AS person/);
});

test('0008 reserves valid setup hashes before scrypt and requires a live source-bound fence', async () => {
  const sql = normalise(await readFile(migration8Url, 'utf8'));
  const reserve = /CREATE FUNCTION app_private\.reserve_native_account_setup\((.*?)\$function\$;/.exec(sql)?.[1];
  const complete = /CREATE FUNCTION app_private\.complete_native_account_setup\((.*?)\$function\$;/.exec(sql)?.[1];
  assert.ok(reserve);
  assert.ok(complete);
  assert.match(reserve, /p_setup_token_hash bytea, p_claim_hash bytea, p_source_hash bytea/);
  assert.match(reserve, /created_claim_expires_at timestamptz := statement_timestamp\(\) \+ interval '2 minutes'/);
  const cheapLookup = reserve.indexOf('WHERE action_token.token_hash = p_setup_token_hash');
  const passwordLock = reserve.indexOf('FROM app.users AS person');
  assert.ok(cheapLookup >= 0 && cheapLookup < passwordLock, 'invalid tokens stop at the indexed lookup');
  assert.match(reserve, /INSERT INTO app_private\.account_setup_claims/);
  assert.match(sql, /DROP FUNCTION app_private\.complete_native_account_setup\( bytea, text, bytea, bytea, bytea, bytea \)/);
  assert.match(complete, /p_setup_token_hash bytea, p_setup_claim_hash bytea, p_source_hash bytea, p_password_hash text/);
  assert.match(complete, /claim\.claim_hash = p_setup_claim_hash AND claim\.source_hash = p_source_hash AND claim\.expires_at > statement_timestamp\(\)/);
  const userLock = complete.indexOf('FROM app.users AS person');
  const membershipLock = complete.indexOf('FROM app.workspace_memberships AS membership', userLock);
  const workspaceLock = complete.indexOf('FROM app.workspaces AS workspace', membershipLock);
  const organizationLock = complete.indexOf('FROM app.organizations AS organization', workspaceLock);
  const organizationMembershipLock = complete.indexOf('FROM app.organization_memberships AS organization_membership', organizationLock);
  const tokenLock = complete.indexOf('SELECT action_token.id, action_token.workspace_id', organizationMembershipLock);
  const claimLock = complete.indexOf('FROM app_private.account_setup_claims AS claim');
  assert.ok(userLock >= 0 && userLock < membershipLock
    && membershipLock < workspaceLock && workspaceLock < organizationLock
    && organizationLock < organizationMembershipLock
    && organizationMembershipLock < tokenLock && tokenLock < claimLock);
  assert.match(complete, /DELETE FROM app_private\.account_setup_claims AS claim WHERE claim\.user_id = locked_user_id/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app_private\.reserve_native_account_setup\( bytea, bytea, bytea \) TO r72_identity_command/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app_private\.complete_native_account_setup\( bytea, bytea, bytea, text, bytea, bytea, bytea, bytea \) TO r72_identity_command/);
});
