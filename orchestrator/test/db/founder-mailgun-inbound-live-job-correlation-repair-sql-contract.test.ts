import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../src/db/migrations/0073_founder_mailgun_inbound_live_job_correlation_repair.sql',
  import.meta.url,
);

test('0073 rebinds founder inbound correlation to the live customer-email job only', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.match(sql, /GRANT SELECT ON app\.property_predator_customer_email_jobs/u);
  assert.match(sql, /CREATE POLICY customer_email_jobs_mailgun_inbound_definer_select/u);
  assert.match(sql, /REVOKE SELECT ON app\.property_predator_mailgun_jobs/u);
  assert.match(sql, /RENAME COLUMN mailgun_job_id TO customer_email_job_id/u);
  assert.match(
    sql,
    /REFERENCES app\.property_predator_customer_email_jobs \(workspace_id, id\)/u,
  );
  assert.match(sql, /customer_email_job_id,/u);
  assert.match(
    sql,
    /selected_job app\.property_predator_customer_email_jobs%ROWTYPE;/u,
  );
  assert.match(sql, /FROM app\.property_predator_customer_email_jobs AS job/u);
  assert.match(sql, /AND job\.state = ''succeeded''/u);
  assert.match(sql, /lower\(point\.normalized_value\) = p_normalized_sender/u);
  assert.match(sql, /has_function_privilege\([\s\S]*r72_mailgun_webhook_command/u);
  assert.match(sql, /owner_role\.rolname = 'r72_mailgun_webhook_definer'/u);
  assert.match(sql, /procedure\.prosecdef/u);
  assert.match(sql, /procedure\.proconfig = ARRAY\['search_path=pg_catalog'\]::text\[\]/u);
  assert.doesNotMatch(sql, /INSERT INTO app\./u);
  assert.doesNotMatch(sql, /UPDATE app\./u);
  assert.doesNotMatch(sql, /DELETE FROM app\./u);
});
