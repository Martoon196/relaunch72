import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migrationUrl = new URL(
  '../../src/db/migrations/0068_founder_pilot_preparation_approval_state_repair.sql',
  import.meta.url,
);

test('0068 moves the founder draft to approval pending before its decision', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.match(sql, /lifecycle = ''approval_pending''/);
  assert.match(sql, /transition_sql \|\| decision_needle/);
  assert.match(sql, /current_version_id = created_message_version_id/);
  assert.match(sql, /current_body_sha256 = selected_body_sha/);
  assert.match(sql, /IF NOT FOUND THEN/);
  assert.match(sql, /USING ERRCODE = ''40001''/);
});

test('0068 fails closed on drift and restores the definer boundary', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.match(sql, /source_content_approval_ref/);
  assert.match(sql, /no longer matches the reviewed repair/);
  assert.match(sql, /EXECUTE repaired_definition/);
  assert.match(sql, /REVOKE CREATE ON SCHEMA app_private FROM r72_founder_pilot_prep_definer/);
  assert.match(sql, /has_schema_privilege/);
  assert.doesNotMatch(sql, /GRANT (?:INSERT|UPDATE|DELETE|TRUNCATE).*message_deliveries/);
  assert.doesNotMatch(sql, /provider_operations|property_predator_customer_email_jobs/);
});
