import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../src/db/migrations/0077_company_content_sync_session_acl_repair.sql',
  import.meta.url,
);

function normalise(sql: string): string {
  return sql.replace(/--[^\n]*/gu, ' ').replace(/\s+/gu, ' ').trim();
}

test('0077 grants only the proven nested session fence and audits ownership', async () => {
  const sql = normalise(await readFile(migrationUrl, 'utf8'));
  assert.match(
    sql,
    /GRANT EXECUTE ON FUNCTION app_private\.lock_active_portal_session\(bytea, uuid, uuid\) TO r72_security_definer/,
  );
  assert.match(sql, /procedure\.oid IN \(consume_oid, lock_oid\)/);
  assert.match(sql, /owner_role\.rolname = 'r72_security_definer'/);
  assert.match(sql, /procedure\.prosecdef/);
  assert.match(sql, /procedure\.proconfig = ARRAY\['search_path=pg_catalog'\]::text\[\]/);
  assert.match(sql, /app_private\.consume_company_content_sync_command\(uuid,bytea,text\)/);
  assert.match(sql, /r72_web', 'app_private\.lock_active_portal_session\(bytea,uuid,uuid\)', 'EXECUTE'/);
  assert.match(sql, /has_table_privilege\('r72_web', relation\.oid, 'TRUNCATE'\)/);
  assert.doesNotMatch(sql, /GRANT EXECUTE[^;]+TO r72_web/);
  assert.doesNotMatch(sql, /GRANT (?:SELECT|INSERT|UPDATE|DELETE|TRUNCATE)/);
  assert.doesNotMatch(sql, /(?:publish|enqueue|schedule|worker_lease|claim_job)/iu);
});
