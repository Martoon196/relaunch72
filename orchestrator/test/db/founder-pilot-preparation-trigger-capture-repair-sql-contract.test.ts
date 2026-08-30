import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migrationUrl = new URL(
  '../../src/db/migrations/0069_founder_pilot_preparation_trigger_capture_repair.sql',
  import.meta.url,
);

test('0069 reuses the canonical 0025 approved-content capture', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.match(sql, /message_approval_decisions_capture_pilot_content/);
  assert.match(sql, /SELECT approved\.id INTO created_approved_content_id/);
  assert.match(sql, /approved\.approval_decision_id = created_message_decision_id/);
  assert.match(sql, /approved\.subject_sha256 = selected_subject_sha/);
  assert.match(sql, /approved\.body_sha256 = selected_body_sha/);
  assert.match(sql, /overlay\(/);
});

test('0069 removes the duplicate insert and restores the definer boundary', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.match(sql, /position\(duplicate_start IN repaired_definition\) <> 0/);
  assert.match(sql, /Founder preparation lost canonical approved content/);
  assert.match(sql, /REVOKE CREATE ON SCHEMA app_private FROM r72_founder_pilot_prep_definer/);
  assert.match(sql, /has_schema_privilege/);
  assert.doesNotMatch(sql, /GRANT (?:INSERT|UPDATE|DELETE|TRUNCATE).*message_deliveries/);
  assert.doesNotMatch(sql, /provider_operations|property_predator_customer_email_jobs/);
});
