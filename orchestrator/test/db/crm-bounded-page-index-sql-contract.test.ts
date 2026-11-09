import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../src/db/migrations/0037_crm_bounded_page_indexes.sql',
  import.meta.url,
);

async function migration(): Promise<string> {
  return (await readFile(migrationUrl, 'utf8'))
    .replace(/--[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

test('0037 covers the exact stable order of bounded opportunity and task pages', async () => {
  const sql = await migration();
  assert.match(sql, /^SET LOCAL ROLE r72_owner;/);
  assert.match(
    sql,
    /CREATE INDEX opportunities_workspace_updated_page_idx ON app\.opportunities \(workspace_id, updated_at DESC, id\)/,
  );
  assert.match(
    sql,
    /CREATE INDEX tasks_workspace_queue_page_idx ON app\.tasks \( workspace_id, \(CASE status WHEN 'open' THEN 0 WHEN 'completed' THEN 1 ELSE 2 END\), due_at ASC NULLS LAST, updated_at DESC, id \)/,
  );
  assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|GRANT|REVOKE)\b|\bCREATE\s+ROLE\b|\bprovider\b/i);
});
