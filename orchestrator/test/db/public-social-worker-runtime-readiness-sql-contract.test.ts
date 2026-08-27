import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../src/db/migrations/0041_public_social_worker_runtime_readiness.sql',
  import.meta.url,
);

function normalise(sql: string): string {
  return sql.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();
}

test('0041 grants only release-readiness execution to the deterministic TEST rail', async () => {
  const sql = normalise(await readFile(migrationUrl, 'utf8'));
  assert.match(sql, /SET LOCAL ROLE r72_security_definer/);
  assert.match(
    sql,
    /GRANT EXECUTE ON FUNCTION app_private\.runtime_schema_migrations\(\) TO r72_public_social_worker_command/,
  );
  assert.match(sql, /RESET ROLE/);
  assert.match(
    sql,
    /has_function_privilege\( 'r72_public_social_worker_command', schema_migrations_oid, 'EXECUTE' \)/,
  );
  assert.match(
    sql,
    /has_function_privilege\( 'r72_public_social_worker_command', installation_oid, 'EXECUTE' \)/,
  );
  assert.doesNotMatch(sql, /CREATE (?:ROLE|TABLE|FUNCTION)|ALTER (?:ROLE|TABLE|FUNCTION)/);
  assert.doesNotMatch(sql, /GRANT (?:SELECT|INSERT|UPDATE|DELETE|TRUNCATE|USAGE|CREATE)/);
  assert.doesNotMatch(sql, /https?:\/\/|provider|credential|token|secret/i);
});

test('0041 retains the function-only worker boundary and audits unsafe schema capability', async () => {
  const sql = normalise(await readFile(migrationUrl, 'utf8'));
  assert.match(sql, /rolcanlogin AND NOT rolinherit AND NOT rolsuper/);
  assert.match(sql, /NOT rolcreatedb AND NOT rolcreaterole/);
  assert.match(sql, /NOT rolreplication AND NOT rolbypassrls/);
  assert.match(
    sql,
    /has_schema_privilege\( 'r72_public_social_worker_command', 'app_private', 'CREATE' \)/,
  );
  assert.match(
    sql,
    /has_schema_privilege\( 'r72_public_social_worker_command', 'app', 'USAGE' \)/,
  );
  assert.doesNotMatch(sql, /GRANT EXECUTE[^;]+TO (?!r72_public_social_worker_command)/);
});
