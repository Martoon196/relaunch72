import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../src/db/migrations/0083_founder_email_pilot_readiness_membership_rls_tightening.sql',
  import.meta.url,
);

test('0083 limits email readiness membership visibility to the exact active operator', async () => {
  const sql = await readFile(migrationUrl, 'utf8');

  assert.match(sql,
    /ALTER POLICY founder_email_pilot_readiness_membership_select/u);
  assert.match(sql,
    /ON app\.workspace_memberships[\s\S]*?workspace_id = nullif\(current_setting\('app\.workspace_id', true\), ''\)::uuid/u);
  assert.match(sql,
    /user_id = nullif\(current_setting\('app\.user_id', true\), ''\)::uuid/u);
  assert.match(sql, /status = 'active'/u);
  assert.match(sql, /role IN \('owner', 'admin'\)/u);
  assert.doesNotMatch(sql,
    /GRANT (?:INSERT|UPDATE|DELETE|TRUNCATE)[\s\S]*?r72_email_pilot_readiness_definer/u);
  assert.match(sql,
    /ARRAY\[\s*'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'\s*\]/u);
});
