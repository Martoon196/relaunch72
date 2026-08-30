import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../src/db/migrations/0066_founder_email_endpoint_select_repair.sql',
  import.meta.url,
);

test('0066 grants only the missing endpoint ordering column and audits the boundary', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.match(
    sql,
    /GRANT\s+SELECT\s*\(created_at\)\s+ON\s+app\.contact_points\s+TO\s+r72_contact_endpoint_definer/is,
  );
  assert.match(sql, /has_column_privilege\([\s\S]*'created_at'[\s\S]*'SELECT'/i);
  assert.match(sql, /has_table_privilege\([\s\S]*'app\.contact_points'[\s\S]*'SELECT'/i);
  assert.doesNotMatch(sql, /GRANT\s+(?:INSERT|UPDATE|DELETE|TRUNCATE)/i);
  assert.doesNotMatch(sql, /GRANT\s+SELECT\s+ON\s+app\.contact_points/i);
});
