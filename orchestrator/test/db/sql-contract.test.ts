import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migration1Url = new URL('../../src/db/migrations/0001_extensions_roles.sql', import.meta.url);
const migration2Url = new URL('../../src/db/migrations/0002_identity_workspaces.sql', import.meta.url);

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
