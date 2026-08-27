import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../src/db/migrations/0035_company_asset_portal_session_capability.sql',
  import.meta.url,
);

async function migration(): Promise<string> {
  return (await readFile(migrationUrl, 'utf8')).replace(/\r\n?/g, '\n');
}

test('0035 grants each company-asset role only its exact session fence', async () => {
  const sql = await migration();

  assert.match(
    sql,
    /GRANT EXECUTE ON FUNCTION app_private\.active_portal_session\(bytea, uuid, uuid\)\s+TO r72_content_adapter/,
  );
  assert.match(
    sql,
    /GRANT EXECUTE ON FUNCTION app_private\.lock_active_portal_session\(bytea, uuid, uuid\)\s+TO r72_content_command/,
  );
  assert.match(
    sql,
    /REVOKE EXECUTE ON FUNCTION app_private\.lock_active_portal_session\(bytea, uuid, uuid\)\s+FROM r72_content_adapter/,
  );
  assert.match(
    sql,
    /REVOKE EXECUTE ON FUNCTION app_private\.active_portal_session\(bytea, uuid, uuid\)\s+FROM r72_content_command/,
  );
});

test('0035 opens no session resolver, mutator, table or role capability', async () => {
  const sql = await migration();

  assert.doesNotMatch(
    sql,
    /(?:resolve|create|revoke)_portal_session|portal_login_credential/,
  );
  assert.doesNotMatch(
    sql,
    /GRANT (?:SELECT|INSERT|UPDATE|DELETE|TRUNCATE)|GRANT [^;]* ROLE/,
  );
  assert.doesNotMatch(sql, /CREATE (?:OR REPLACE )?FUNCTION|ALTER FUNCTION/);
});
