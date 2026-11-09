import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../src/db/migrations/0021_company_content_versions_and_approvals.sql',
  import.meta.url,
);

function normalise(sql: string): string {
  return sql.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();
}

test('0021 creates separate hardened adapter and approval roles without provider capability', async () => {
  const sql = normalise(await readFile(migrationUrl, 'utf8'));
  assert.match(sql, /CREATE ROLE r72_content_command LOGIN NOINHERIT/);
  assert.match(sql, /CREATE ROLE r72_content_adapter LOGIN NOINHERIT/);
  assert.match(sql, /FOREACH checked_role IN ARRAY ARRAY\[ 'r72_content_command', 'r72_content_adapter' \]/);
  assert.match(sql, /WHERE rolname = checked_role AND rolcanlogin AND NOT rolinherit AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls/);
  assert.match(sql, /REVOKE r72_owner, r72_security_definer, r72_content_adapter FROM r72_content_command/);
  assert.match(sql, /REVOKE r72_owner, r72_security_definer, r72_content_command FROM r72_content_adapter/);
  assert.match(sql, /REVOKE ALL ON ALL TABLES IN SCHEMA app FROM r72_content_command, r72_content_adapter/);
  assert.match(sql, /REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app_private FROM r72_content_command, r72_content_adapter/);
  assert.match(sql, /REVOKE CREATE ON SCHEMA public FROM r72_content_command, r72_content_adapter/);
  assert.match(sql, /Unsafe content role membership/);
  assert.match(sql, /Unsafe content role grant/);
  assert.doesNotMatch(sql, /https?:\/\/|fetch\(|publish_social|send_message/i);
});

test('0021 versions exact content provenance and computes content SHA-256 in PostgreSQL', async () => {
  const sql = normalise(await readFile(migrationUrl, 'utf8'));
  for (const column of [
    'source_system text NOT NULL',
    'source_item_id text NOT NULL',
    'source_version text NOT NULL',
    'blob_storage_key text NOT NULL',
    'brand_snapshot_ref text NOT NULL',
  ]) assert.ok(sql.includes(column));
  assert.match(sql, /content_sha256 bytea GENERATED ALWAYS AS \( public\.digest\(content_body, 'sha256'\) \) STORED/);
  assert.match(sql, /blob_sha256 bytea NOT NULL CHECK \(octet_length\(blob_sha256\) = 32\)/);
  assert.match(sql, /brand_sha256 bytea NOT NULL CHECK \(octet_length\(brand_sha256\) = 32\)/);
  assert.match(sql, /octet_length\(metadata::text\) <= 65536/);
  assert.match(sql, /UNIQUE \(workspace_id, source_system, source_item_id, source_version\)/);
  assert.match(sql, /UNIQUE \(workspace_id, source_system, source_item_id\)/);
  assert.match(sql, /FOREIGN KEY \(workspace_id, content_item_id, source_system, source_item_id\) REFERENCES app\.company_content_items \( workspace_id, id, source_system, source_item_id \)/);
  assert.match(sql, /FOREIGN KEY \(workspace_id, content_item_id, previous_version_id\) REFERENCES app\.company_content_versions \(workspace_id, content_item_id, id\)/);
  assert.match(sql, /CHECK \(\(version_number = 1\) = \(previous_version_id IS NULL\)\)/);
});

test('0021 carries a short-lived exact source attestation independent from approval', async () => {
  const sql = normalise(await readFile(migrationUrl, 'utf8'));
  assert.match(sql, /CREATE TABLE app\.company_content_source_attestations/);
  assert.match(sql, /source_catalog_sha256 bytea NOT NULL CHECK \(octet_length\(source_catalog_sha256\) = 32\)/);
  assert.match(sql, /FOREIGN KEY \( workspace_id, content_item_id, content_version_id, source_system, source_item_id, source_version, content_sha256, blob_sha256, brand_sha256 \) REFERENCES app\.company_content_versions/);
  assert.match(sql, /CHECK \(checked_at >= created_at - interval '5 minutes'\)/);
  assert.match(sql, /CHECK \(checked_at <= created_at \+ interval '30 seconds'\)/);
  assert.match(sql, /CHECK \(expires_at <= checked_at \+ interval '15 minutes'\)/);
  assert.match(sql, /company_content_source_attestations_adapter_insert/);
  assert.match(sql, /'app', 'company_content_source_attestations', 'workspace_id'/);
});

test('0021 approval requests and decisions have concrete digest-pinned foreign keys', async () => {
  const sql = normalise(await readFile(migrationUrl, 'utf8'));
  assert.match(sql, /CREATE TABLE app\.company_content_approval_requests/);
  assert.match(sql, /FOREIGN KEY \( workspace_id, content_item_id, content_version_id, content_sha256 \) REFERENCES app\.company_content_versions \( workspace_id, content_item_id, id, content_sha256 \)/);
  assert.match(sql, /CREATE TABLE app\.company_content_approval_decisions/);
  assert.match(sql, /FOREIGN KEY \( workspace_id, content_item_id, content_version_id, approval_request_id, content_sha256 \) REFERENCES app\.company_content_approval_requests \( workspace_id, content_item_id, content_version_id, id, content_sha256 \)/);
  assert.match(sql, /UNIQUE \(workspace_id, approval_request_id\)/);
  assert.doesNotMatch(sql, /approvable_type|entity_type|subject_type|target_type/);
});

test('0021 enforces linear versions, current-version approval and database-owned audit facts', async () => {
  const sql = normalise(await readFile(migrationUrl, 'utf8'));
  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /previous_number <> latest_number OR NEW\.version_number <> latest_number \+ 1/);
  assert.match(sql, /approval may only be requested for the latest content version/);
  assert.match(sql, /a stale content version cannot receive a new approval decision/);
  for (const assignment of [
    'NEW.created_by_user_id := app_private.current_user_id()',
    'NEW.created_request_id := app_private.current_request_id()',
    'NEW.created_at := statement_timestamp()',
    'NEW.requested_by_user_id := app_private.current_user_id()',
    'NEW.requested_request_id := app_private.current_request_id()',
    'NEW.requested_at := statement_timestamp()',
    'NEW.decided_by_user_id := app_private.current_user_id()',
    'NEW.decided_request_id := app_private.current_request_id()',
    'NEW.decided_at := statement_timestamp()',
  ]) assert.ok(sql.includes(assignment));
});

test('0021 forces workspace RLS and separates adapter intake from approval writes', async () => {
  const sql = normalise(await readFile(migrationUrl, 'utf8'));
  const tables = [
    'company_content_items',
    'company_content_versions',
    'company_content_source_attestations',
    'company_content_approval_requests',
    'company_content_approval_decisions',
  ];
  assert.match(sql, /ALTER TABLE app\.%I ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /ALTER TABLE app\.%I FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /FOR SELECT TO r72_web, r72_content_command/);
  assert.match(sql, /FOR SELECT TO r72_content_adapter/);
  assert.match(sql, /has_active_workspace_membership/);
  assert.match(sql, /company_content_items_adapter_insert/);
  assert.match(sql, /company_content_versions_adapter_insert/);
  assert.match(sql, /company_content_source_attestations_adapter_insert/);
  assert.match(sql, /company_content_approval_requests_command_insert/);
  assert.match(sql, /company_content_approval_decisions_manager_insert/);
  assert.match(sql, /can_manage_workspace\(decided_by_user_id, workspace_id\)/);
  assert.match(sql, /GRANT INSERT ON app\.company_content_items, app\.company_content_versions, app\.company_content_source_attestations TO r72_content_adapter/);
  assert.match(sql, /GRANT INSERT ON app\.company_content_approval_requests, app\.company_content_approval_decisions TO r72_content_command/);
  assert.doesNotMatch(sql, /GRANT INSERT ON[^;]*company_content_items[^;]*TO r72_content_command/);
  assert.doesNotMatch(sql, /GRANT INSERT ON[^;]*company_content_approval_requests[^;]*TO r72_content_adapter/);
  assert.doesNotMatch(sql, /FOR (?:INSERT|UPDATE|DELETE) TO r72_web/);
  for (const table of tables) {
    assert.match(sql, new RegExp(`'app', '${table}', 'workspace_id'`));
  }
});

test('0021 makes content append-only and partitions hashed receipts by exact command', async () => {
  const sql = normalise(await readFile(migrationUrl, 'utf8'));
  assert.match(sql, /CREATE FUNCTION app_private\.reject_company_content_mutation\(\)/);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON app\.%I/);
  assert.match(sql, /company content versions and approval records are append-only/);
  assert.match(sql, /command_receipts_content_adapter_insert/);
  assert.match(sql, /command_receipts_content_insert/);
  assert.match(sql, /command_name = 'companyContent\.createVersion'/);
  assert.match(sql, /command_name IN \( 'companyContent\.requestApproval', 'companyContent\.decideApproval' \)/);
  assert.doesNotMatch(sql, /command_name LIKE 'companyContent\.%'/);
  assert.match(sql, /GRANT UPDATE \(result, status, response_status, completed_at\) ON app\.command_receipts TO r72_content_command/);
  assert.match(sql, /GRANT UPDATE \(result, status, response_status, completed_at\) ON app\.command_receipts TO r72_content_adapter/);
  for (const triggerFunction of [
    'stamp_company_content_item_insert',
    'guard_company_content_version_insert',
    'guard_company_content_source_attestation_insert',
    'guard_company_content_approval_request_insert',
    'guard_company_content_approval_decision_insert',
    'reject_company_content_mutation',
  ]) {
    assert.match(sql, new RegExp(
      `REVOKE ALL ON FUNCTION app_private\\.${triggerFunction}\\(\\) FROM PUBLIC`,
    ));
  }
  assert.doesNotMatch(sql, /SECURITY DEFINER/);
  assert.doesNotMatch(sql, /GRANT UPDATE[^;]*ON app\.company_content_/);
  assert.doesNotMatch(sql, /GRANT DELETE[^;]*ON app\.company_content_/);
});

test('company content repository exposes a bounded latest-version approval catalogue', async () => {
  const repository = normalise(await readFile(
    new URL('../../src/company-content-pg/repository.ts', import.meta.url),
    'utf8',
  ));
  assert.match(repository, /\/\* company-content\.list-catalog \*\//);
  assert.match(repository, /JOIN LATERAL \( SELECT version\.\* FROM app\.company_content_versions AS version/);
  assert.match(repository, /ORDER BY version\.version_number DESC, version\.id LIMIT 1/);
  assert.match(repository, /older_decision\.decision = 'approved'/);
  assert.match(repository, /WHEN request\.id IS NULL AND prior_approval\.exists THEN 'stale'/);
  assert.match(repository, /\(latest\.created_at, latest\.content_version_id\) < \(\$1::timestamptz, \$2::uuid\)/);
  assert.match(repository, /ORDER BY latest\.created_at DESC, latest\.content_version_id DESC LIMIT \$3/);
  assert.match(repository, /attestation\.expires_at > statement_timestamp\(\)/);
  assert.match(repository, /coalesce\(decision\.decision = 'approved', false\)/);
  assert.match(repository, /Company content catalog returned invalid canonical data/);
  assert.match(repository, /Company content catalog exceeded its SQL-side bound/);
  assert.match(repository, /ORDER BY version\.version_number DESC, version\.id LIMIT \$2/);
  assert.match(repository, /Company content version history exceeded its read bound/);
});

test('company content exact review is version-bound and returns the stored body with database digest evidence', async () => {
  const repository = normalise(await readFile(
    new URL('../../src/company-content-pg/repository.ts', import.meta.url),
    'utf8',
  ));
  assert.match(repository, /\/\* company-content\.load-exact-review \*\//);
  assert.match(repository, /version\.content_body AS "canonicalContent"/);
  assert.match(repository, /encode\(version\.content_sha256, 'hex'\) AS "contentSha256"/);
  assert.match(repository, /WHERE version\.content_item_id = \$1 AND version\.id = \$2/);
  assert.match(repository, /NOT EXISTS \( SELECT 1 FROM app\.company_content_versions AS newer/);
  assert.match(repository, /ORDER BY candidate\.request_number DESC, candidate\.id LIMIT 1/);
});

test('0021 terminates every PL/pgSQL function and anonymous block as executable PostgreSQL', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const functions = [...sql.matchAll(
    /CREATE FUNCTION app_private\.([a-z0-9_]+)\([^]*?AS \$function\$([^]*?)\$function\$;/g,
  )];
  assert.ok(functions.length >= 6, 'the migration should expose every trigger function to this check');
  for (const match of functions) {
    assert.match(match[2]!, /\bEND;\s*$/, `${match[1]} must terminate its PL/pgSQL block with END;`);
  }

  const blocks = [...sql.matchAll(/DO \$([a-z0-9_]+)\$([^]*?)\$\1\$;/g)];
  assert.ok(blocks.length >= 3, 'the migration should expose every anonymous block to this check');
  for (const match of blocks) {
    assert.match(match[2]!, /\bEND;\s*$/, `${match[1]} must terminate its anonymous block with END;`);
  }
});

test('company content repository uses advisory identities instead of row-locking append-only facts', async () => {
  const repository = normalise(await readFile(
    new URL('../../src/company-content-pg/repository.ts', import.meta.url),
    'utf8',
  ));
  for (const marker of [
    'company-content.lock-source-identity',
    'company-content.lock-item-identity',
    'company-content.lock-version-item',
    'company-content.lock-approval-identity',
  ]) {
    assert.match(
      repository,
      new RegExp(`/\\* ${marker.replaceAll('.', '\\.')} \\*/ SELECT pg_catalog\\.pg_advisory_xact_lock\\(`),
    );
  }
  assert.doesNotMatch(repository, /FOR UPDATE OF (?:item|request)/);
  assert.doesNotMatch(repository, /company-content\.read-command-receipt \*\/[^]*?FOR UPDATE/);
  assert.match(repository, /company-content\.complete-command \*\/[^]*?JSON\.stringify\(input\.result\)/);
});
