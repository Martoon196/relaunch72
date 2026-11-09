import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../src/db/migrations/0099_generated_draft_adapter_session_lock.sql',
  import.meta.url,
);

test('0099 grants the generated-draft adapter only the required write-session fence', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app_private\.lock_active_portal_session\(bytea, uuid, uuid\)\s+TO r72_content_adapter/u);
  assert.match(sql, /SET LOCAL ROLE r72_owner/u);
  assert.doesNotMatch(sql, /GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE|TRUNCATE)\s+ON/u);
  assert.doesNotMatch(sql, /r72_content_command|r72_worker|r72_web/u);
});
