import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('0103 adds only the source-refresh receipt command and retains actor/workspace/state fences', async () => {
  const sql = (await readFile(new URL('../../src/db/migrations/0103_content_source_refresh_receipts.sql', import.meta.url), 'utf8'))
    .replace(/--[^\n]*/g, '').replace(/\s+/g, ' ');
  assert.equal((sql.match(/ALTER POLICY/g) ?? []).length, 3);
  assert.equal((sql.match(/command_name IN \('companyContent.createVersion', 'companyContent.refreshSourceAttestation'\)/g) ?? []).length, 4);
  assert.equal((sql.match(/workspace_id = app_private.current_workspace_id\(\)/g) ?? []).length, 4);
  assert.equal((sql.match(/actor_user_id = app_private.current_user_id\(\)/g) ?? []).length, 4);
  assert.match(sql, /has_active_workspace_membership\(actor_user_id, workspace_id\)/);
  assert.equal((sql.match(/can_write_workspace\(actor_user_id, workspace_id\)/g) ?? []).length, 3);
  assert.equal((sql.match(/status = 'started'/g) ?? []).length, 2);
  assert.match(sql, /status IN \('succeeded', 'failed'\)/);
  assert.doesNotMatch(sql, /\b(?:GRANT|CREATE|DROP|DELETE|TRUNCATE|DISABLE)\b/i);
  assert.doesNotMatch(sql, /requestApproval|decideApproval|provider_operations|TO PUBLIC/i);
});
