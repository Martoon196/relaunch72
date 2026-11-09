import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../src/db/migrations/0071_founder_pilot_evidence_startup_identity_repair.sql',
  import.meta.url,
);

test('0071 repairs only the proven evidence-pool installation check', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app_private\.runtime_database_installation_id\(\)\s+TO r72_founder_pilot_evidence_command/u);
  assert.doesNotMatch(sql, /GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE|TRUNCATE)/iu);
  assert.doesNotMatch(sql, /message_deliveries|provider_operations|customer_email_jobs/iu);
  assert.match(sql, /has_function_privilege/u);
  assert.match(sql, /record_founder_pilot_compliance_evidence/u);
});
