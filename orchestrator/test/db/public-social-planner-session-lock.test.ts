import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('0105 enables only the existing planner write-session fence and checks it at startup', async () => {
  const sql = await readFile(new URL('../../src/db/migrations/0105_public_social_planner_session_lock.sql', import.meta.url), 'utf8');
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app_private\.lock_active_portal_session\(bytea, uuid, uuid\)\s+TO r72_public_social_command/u);
  assert.match(sql, /SET LOCAL ROLE r72_owner/u);
  assert.doesNotMatch(sql, /GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE|TRUNCATE)|r72_web|r72_public_social_worker_command/u);
  const startup = await readFile(new URL('../../src/portal/postgres-platform.ts', import.meta.url), 'utf8');
  assert.match(startup, /public-social-command-role-readiness[\s\S]*?has_function_privilege\(current_user,[\s\S]*?'app_private\.lock_active_portal_session\(bytea,uuid,uuid\)'/u);
});
