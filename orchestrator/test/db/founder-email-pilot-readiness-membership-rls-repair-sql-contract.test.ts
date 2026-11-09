import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../src/db/migrations/0082_founder_email_pilot_readiness_membership_rls_repair.sql',
  import.meta.url,
);

test('0082 restores only workspace-scoped membership visibility to email readiness', async () => {
  const sql = await readFile(migrationUrl, 'utf8');

  assert.match(sql,
    /CREATE POLICY founder_email_pilot_readiness_membership_select/u);
  assert.match(sql,
    /ON app\.workspace_memberships\s+FOR SELECT TO r72_email_pilot_readiness_definer/u);
  assert.match(sql,
    /workspace_id = nullif\(current_setting\('app\.workspace_id', true\), ''\)::uuid/u);
  assert.doesNotMatch(sql,
    /GRANT (?:INSERT|UPDATE|DELETE|TRUNCATE)[\s\S]*?r72_email_pilot_readiness_definer/u);
  assert.match(sql,
    /ARRAY\[\s*'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'\s*\]/u);
  assert.match(sql,
    /function_owner <> 'r72_email_pilot_readiness_definer'[\s\S]*?NOT is_security_definer[\s\S]*?function_volatility <> 's'[\s\S]*?search_path=pg_catalog/u);
});
