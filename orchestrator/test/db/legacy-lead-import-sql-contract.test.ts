import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../src/db/migrations/0019_legacy_lead_import_foundation.sql',
  import.meta.url,
);

function normalise(sql: string): string {
  return sql.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();
}

test('0019 creates a manager-only forced-RLS staging and immutable receipt boundary', async () => {
  const sql = normalise(await readFile(migrationUrl, 'utf8'));
  for (const table of [
    'legacy_lead_import_batches',
    'legacy_lead_import_rows',
    'legacy_lead_import_receipts',
    'legacy_lead_unresolved_attributions',
    'legacy_lead_unresolved_attribution_receipts',
    'contact_import_attribution_payloads',
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE app_private\\.${table} \\(`));
    assert.match(sql, new RegExp(`'${table}'`));
    assert.match(sql, new RegExp(`\\('app_private', '${table}', 'workspace_id'\\)`));
  }
  for (const table of ['contact_import_provenance', 'contact_import_attribution_facts']) {
    assert.match(sql, new RegExp(`CREATE TABLE app\\.${table} \\(`));
    assert.match(sql, new RegExp(`\\('app', '${table}', 'workspace_id'\\)`));
  }
  const rls = /DO \$legacy_import_rls\$(.*?)\$legacy_import_rls\$;/.exec(sql)?.[1];
  assert.ok(rls);
  assert.match(rls, /ALTER TABLE app_private\.%I ENABLE ROW LEVEL SECURITY/);
  assert.match(rls, /ALTER TABLE app_private\.%I FORCE ROW LEVEL SECURITY/);
  assert.match(rls, /ALTER TABLE app\.%I ENABLE ROW LEVEL SECURITY/);
  assert.match(rls, /ALTER TABLE app\.%I FORCE ROW LEVEL SECURITY/);
  assert.match(rls, /app_private\.can_manage_workspace/);
  assert.match(rls, /FOR SELECT TO r72_web USING/);
  assert.match(sql, /CREATE ROLE r72_import_command LOGIN NOINHERIT/);
  assert.match(sql, /schema_version smallint NOT NULL CHECK \(schema_version = 1\)/);
  assert.match(sql, /NOT rolbypassrls/);
  assert.match(sql, /Unsafe import command membership/);
  assert.match(sql, /Unsafe import command grant/);
});

test('0019 preserves exact source lineage, original time and affiliate bytes without invented UUIDs', async () => {
  const sql = normalise(await readFile(migrationUrl, 'utf8'));
  const rows = /CREATE TABLE app_private\.legacy_lead_import_rows \((.*?)\);/.exec(sql)?.[1];
  const receipts = /CREATE TABLE app_private\.legacy_lead_import_receipts \((.*?)\);/.exec(sql)?.[1];
  const provenance = /CREATE TABLE app\.contact_import_provenance \((.*?)\);/.exec(sql)?.[1];
  const attribution = /CREATE TABLE app\.contact_import_attribution_facts \((.*?)\);/.exec(sql)?.[1];
  const unresolved = /CREATE TABLE app_private\.legacy_lead_unresolved_attributions \((.*?)\);/.exec(sql)?.[1];
  const attributionPayload = /CREATE TABLE app_private\.contact_import_attribution_payloads \((.*?)\);/.exec(sql)?.[1];
  const unresolvedReceipts = /CREATE TABLE app_private\.legacy_lead_unresolved_attribution_receipts \((.*?)\);/.exec(sql)?.[1];
  assert.ok(rows && receipts && provenance && attribution && unresolved && attributionPayload && unresolvedReceipts);

  for (const definition of [rows, receipts, provenance, attribution, unresolved]) {
    assert.match(definition, /source_system text NOT NULL/);
    assert.match(definition, /source_record_id text NOT NULL/);
  }
  for (const definition of [rows, receipts, provenance, unresolved]) {
    assert.match(definition, /original_created_at timestamptz NOT NULL/);
    assert.match(definition, /source_payload_sha256 bytea NOT NULL CHECK \(octet_length\(source_payload_sha256\) = 32\)/);
  }
  assert.match(receipts, /UNIQUE \(workspace_id, source_system, source_record_id\)/);
  assert.match(provenance, /REFERENCES app_private\.legacy_lead_import_receipts/);
  assert.match(attribution, /affiliate_source_id text/);
  assert.match(attribution, /affiliate_code text/);
  assert.match(attribution, /referral_code text/);
  assert.doesNotMatch(attribution, /raw_attribution/);
  assert.match(attributionPayload, /raw_attribution jsonb NOT NULL/);
  assert.doesNotMatch(attribution, /affiliate_id uuid/);
  assert.match(unresolved, /record_kind IN \('affiliate', 'referral', 'commission', 'attribution'\)/);
  assert.match(unresolved, /referred_source_record_id text/);
  assert.match(unresolved, /missing_contact/);
  assert.match(unresolved, /missing_affiliate_owner/);
  assert.match(unresolvedReceipts, /UNIQUE \(workspace_id, source_system, record_kind, source_record_id\)/);
  assert.match(unresolvedReceipts, /source_payload_sha256 bytea NOT NULL/);
});

test('0019 cannot overwrite contacts and keeps provenance, attribution and receipts append-only', async () => {
  const sql = normalise(await readFile(migrationUrl, 'utf8'));
  assert.match(sql, /GRANT SELECT, INSERT ON app\.contacts, app\.contact_points TO r72_import_command/);
  assert.doesNotMatch(sql, /GRANT UPDATE[^;]*app\.contacts/);
  assert.doesNotMatch(sql, /GRANT UPDATE[^;]*app\.contact_points/);
  assert.doesNotMatch(sql, /CREATE POLICY contacts_import_manager_update/);
  assert.doesNotMatch(sql, /CREATE POLICY contact_points_import_manager_update/);
  for (const table of [
    'legacy_lead_import_receipts',
    'legacy_lead_unresolved_attribution_receipts',
    'contact_import_provenance',
    'contact_import_attribution_facts',
    'contact_import_attribution_payloads',
    'legacy_lead_unresolved_attributions',
  ]) {
    assert.doesNotMatch(sql, new RegExp(`GRANT (?:UPDATE|DELETE)[^;]*${table}`));
    assert.doesNotMatch(sql, new RegExp(`ON (?:app|app_private)\\.${table} FOR (?:UPDATE|DELETE)`));
  }
  assert.match(sql, /GRANT UPDATE \( status, imported_count/);
  assert.match(sql, /GRANT UPDATE \( status, matched_contact_id/);
  assert.match(sql, /source_record_payload_changed|input_sha256|source_payload_sha256/);
  assert.match(sql, /guard_legacy_import_batch_update/);
  assert.match(sql, /guard_legacy_import_row_update/);
  assert.match(sql, /NEW\.created_by_user_id := app_private\.current_user_id\(\)/);
  assert.match(sql, /NEW\.imported_by_user_id := app_private\.current_user_id\(\)/);
  assert.doesNotMatch(sql, /GRANT SELECT ON app_private\.contact_import_attribution_payloads TO r72_web/);
});
