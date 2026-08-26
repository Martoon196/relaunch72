import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../src/db/migrations/0030_property_predator_complete_snapshot_staging.sql',
  import.meta.url,
);

function normalise(sql: string): string {
  return sql.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();
}

test('0030 creates append-only complete snapshot evidence with high-water and consent boundaries', async () => {
  const sql = normalise(await readFile(migrationUrl, 'utf8'));
  assert.match(sql, /SET LOCAL ROLE r72_owner/);
  assert.match(sql, /CREATE TABLE app_private\.property_predator_snapshot_manifests/);
  assert.match(sql, /source_system = 'property-predator\.accounts\/v2'/);
  assert.match(sql, /schema_version smallint NOT NULL CHECK \(schema_version = 2\)/);
  assert.match(sql, /complete boolean NOT NULL CHECK \(complete\)/);
  assert.match(sql, /event_high_watermark numeric\(20, 0\) NOT NULL/);
  assert.match(sql, /content_sha256 bytea NOT NULL CHECK \(octet_length\(content_sha256\) = 32\)/);
  assert.match(sql, /envelope_sha256 bytea NOT NULL CHECK \(octet_length\(envelope_sha256\) = 32\)/);
  assert.match(sql, /consent_default text NOT NULL CHECK \(consent_default = 'unknown'\)/);
  assert.match(sql, /source_metadata jsonb NOT NULL CHECK \(\(.+\) IS TRUE\)/);
  assert.match(sql, /CHECK \(watermark <= generated_at\)/);
  assert.match(sql, /CHECK \(staged_at >= generated_at\)/);
  assert.match(sql, /UNIQUE \(workspace_id, source_system, snapshot_id\)/);
});

test('0030 retains each verified page and source quarantine reason privately', async () => {
  const sql = normalise(await readFile(migrationUrl, 'utf8'));
  assert.match(sql, /CREATE TABLE app_private\.property_predator_snapshot_pages/);
  assert.match(sql, /UNIQUE \(workspace_id, manifest_id, page_number\)/);
  assert.match(sql, /UNIQUE \(workspace_id, manifest_id, page_sha256\)/);
  assert.match(sql, /CHECK \(\(page_number = 1\) = \(cursor IS NULL\)\)/);
  assert.match(sql, /CHECK \(\(page_number = 1\) = \(previous_page_sha256 IS NULL\)\)/);
  assert.match(sql, /jsonb_array_length\(source_envelope -> 'pages'\) = 1/);
  assert.match(sql, /source_envelope jsonb NOT NULL CHECK \(\(.+\) IS TRUE\)/);
  assert.match(sql, /CREATE TABLE app_private\.property_predator_snapshot_quarantine/);
  for (const reason of [
    'duplicate_account_id',
    'duplicate_verified_email',
    'duplicate_affiliate_id',
    'affiliate_parent_cycle',
    'invalid_attribution_affiliate',
  ]) assert.match(sql, new RegExp(reason));
  assert.match(sql, /UNIQUE \(workspace_id, manifest_id, page_number, record_index, reason\)/);
});

test('0030 gives only a workspace manager SELECT and INSERT, never mutation or web visibility', async () => {
  const sql = normalise(await readFile(migrationUrl, 'utf8'));
  for (const table of [
    'property_predator_snapshot_manifests',
    'property_predator_snapshot_pages',
    'property_predator_snapshot_quarantine',
  ]) {
    assert.match(sql, new RegExp(`ALTER TABLE app_private\\.%I ENABLE ROW LEVEL SECURITY`));
    assert.match(sql, new RegExp(`'${table}'`));
  }
  assert.match(sql, /app_private\.can_manage_workspace\( app_private\.current_user_id\(\), app_private\.current_workspace_id\(\) \)/);
  assert.match(sql, /GRANT SELECT, INSERT ON app_private\.property_predator_snapshot_manifests, app_private\.property_predator_snapshot_pages, app_private\.property_predator_snapshot_quarantine TO r72_import_command/);
  assert.match(sql, /REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON/);
  assert.match(sql, /has_table_privilege\('r72_web', 'app_private\.' \|\| table_name, 'SELECT'\)/);
  assert.doesNotMatch(sql, /GRANT (?:UPDATE|DELETE)[^;]+TO r72_import_command/);
  assert.doesNotMatch(sql, /GRANT SELECT[^;]+TO r72_web/);
});

test('0030 expands only the existing batch source grammar for the reviewed URI-shaped v2 source', async () => {
  const sql = normalise(await readFile(migrationUrl, 'utf8'));
  assert.match(sql, /DROP CONSTRAINT legacy_lead_import_batches_source_system_check/);
  assert.match(sql, /ADD CONSTRAINT legacy_lead_import_batches_source_system_check CHECK/);
  assert.match(sql, /source_system ~ '\^\[a-z\]\[a-z0-9_\.:\/-\]\{0,99\}\$'/);
  assert.doesNotMatch(sql, /ALTER TABLE app_private\.legacy_lead_import_batches DROP COLUMN/);
});
