import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migrationUrl = new URL(
  '../../src/db/migrations/0067_founder_pilot_preparation_source_approval_repair.sql',
  import.meta.url,
);

test('0067 supplies the approval reference required by message provenance', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.match(sql, /source_content_approval_ref, created_by_actor_kind/);
  assert.match(sql, /app\.campaign_template_approval_decisions:/);
  assert.match(sql, /created_campaign_decision_id::text/);
  assert.match(sql, /pg_get_functiondef/);
  assert.match(sql, /EXECUTE repaired_definition/);
});

test('0067 fails closed on drift and restores the definer boundary', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.match(sql, /no longer matches the reviewed repair/);
  assert.match(sql, /REVOKE CREATE ON SCHEMA app_private FROM r72_founder_pilot_prep_definer/);
  assert.match(sql, /has_schema_privilege/);
  assert.doesNotMatch(sql, /GRANT (?:INSERT|UPDATE|DELETE|TRUNCATE).*message_deliveries/);
  assert.doesNotMatch(sql, /provider_operations|property_predator_customer_email_jobs/);
});
