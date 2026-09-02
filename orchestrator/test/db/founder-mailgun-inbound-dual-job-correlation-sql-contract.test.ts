import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../src/db/migrations/0081_founder_mailgun_inbound_dual_job_correlation.sql',
  import.meta.url,
);

test('0081 preserves exact inbound correlation across the founder email rail cutover', async () => {
  const sql = await readFile(migrationUrl, 'utf8');

  assert.match(sql,
    /ALTER COLUMN customer_email_job_id DROP NOT NULL/u);
  assert.match(sql,
    /ADD COLUMN legacy_mailgun_job_id uuid/u);
  assert.match(sql,
    /CHECK \(\s*\(customer_email_job_id IS NULL\) <>\s*\(legacy_mailgun_job_id IS NULL\)\s*\)/u);
  assert.match(sql,
    /FOREIGN KEY \(workspace_id, legacy_mailgun_job_id\)[\s\S]*?REFERENCES app\.property_predator_mailgun_jobs \(workspace_id, id\)/u);

  assert.match(sql,
    /FROM app\.property_predator_customer_email_jobs AS job[\s\S]*?job\.state = 'succeeded'/u);
  assert.match(sql,
    /FROM app\.property_predator_mailgun_jobs AS job[\s\S]*?job\.state = 'settled'/u);
  assert.match(sql,
    /INTO STRICT selected_customer_job_id, selected_legacy_job_id,[\s\S]*?selected_delivery_id/u);
  assert.match(sql,
    /WHEN TOO_MANY_ROWS THEN[\s\S]*?owned-seed inbound reply evidence conflicts/u);
  assert.match(sql,
    /customer_email_job_id, legacy_mailgun_job_id,/u);
  assert.match(sql,
    /selected_customer_job_id, selected_legacy_job_id, selected_delivery\.id,/u);

  assert.match(sql,
    /lower\(point\.normalized_value\) = p_normalized_sender/u);
  assert.match(sql,
    /job\.workspace_id = p_workspace_id[\s\S]*?job\.provider_connection_id = p_provider_connection_id[\s\S]*?job\.request_sha256 = correlation_digest/u);
  assert.match(sql,
    /job\.expected_message_id = '<pp-' \|\| p_correlation_sha256[\s\S]*?\|\| '@mg\.propertypredator\.com>'/u);

  assert.match(sql,
    /CREATE POLICY property_predator_mailgun_jobs_inbound_legacy_definer_select/u);
  assert.match(sql,
    /workspace_id = app_private\.current_workspace_id\(\)[\s\S]*?app_private\.current_actor_kind\(\) = 'webhook'/u);
  assert.match(sql,
    /GRANT SELECT ON app\.property_predator_mailgun_jobs\s+TO r72_mailgun_webhook_definer/u);
  assert.doesNotMatch(sql,
    /GRANT SELECT ON app\.property_predator_(?:customer_email|mailgun)_jobs\s+TO r72_mailgun_webhook_command/u);
  assert.match(sql,
    /owner_role\.rolname = 'r72_mailgun_webhook_definer'[\s\S]*?procedure\.prosecdef[\s\S]*?search_path=pg_catalog/u);
});
