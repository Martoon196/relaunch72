import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../src/db/migrations/0070_founder_pilot_evidence_runtime_contract_repair.sql',
  import.meta.url,
);

test('0070 repairs only the two proven evidence runtime privileges', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.match(sql, /GRANT USAGE ON SCHEMA app_private\s+TO r72_founder_pilot_evidence_command/u);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app_private\.current_request_id\(\)\s+TO r72_founder_pilot_evidence_definer/u);
  assert.doesNotMatch(sql, /GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE|TRUNCATE)/iu);
  assert.doesNotMatch(sql, /message_deliveries|provider_operations|customer_email_jobs/iu);
  assert.match(sql, /has_schema_privilege/u);
  assert.match(sql, /has_function_privilege/u);
});
