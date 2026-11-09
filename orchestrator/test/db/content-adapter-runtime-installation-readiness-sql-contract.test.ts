import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../src/db/migrations/0042_content_adapter_runtime_installation_readiness.sql',
  import.meta.url,
);

async function source(): Promise<string> {
  return (await readFile(migrationUrl, 'utf8'))
    .replace(/--[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

test('0042 grants only installation-identity readiness to the content adapter', async () => {
  const sql = await source();
  assert.match(sql, /rolname = 'r72_content_adapter' AND rolcanlogin AND NOT rolinherit AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls/);
  assert.match(sql, /SET LOCAL ROLE r72_security_definer/);
  assert.match(
    sql,
    /GRANT EXECUTE ON FUNCTION app_private\.runtime_database_installation_id\(\) TO r72_content_adapter/,
  );
  assert.match(
    sql,
    /has_function_privilege\( 'r72_content_adapter', 'app_private\.runtime_database_installation_id\(\)', 'EXECUTE' \)/,
  );
  assert.doesNotMatch(sql, /GRANT EXECUTE[^;]+TO (?!r72_content_adapter)/);
  assert.doesNotMatch(sql, /GRANT (?:SELECT|INSERT|UPDATE|DELETE|USAGE|CREATE|ALL)/);
  assert.doesNotMatch(sql, /ALTER ROLE|CREATE ROLE|PASSWORD/);
});

test('0042 preserves the metadata-only, non-provider content boundary', async () => {
  const sql = await source();
  assert.match(sql, /has_schema_privilege\( 'r72_content_adapter', 'app_private', 'USAGE' \)/);
  assert.match(sql, /has_schema_privilege\( 'r72_content_adapter', 'app_private', 'CREATE' \)/);
  assert.match(sql, /has_table_privilege\( 'r72_content_adapter', 'app\.provider_operations', 'INSERT' \)/);
  assert.match(sql, /has_function_privilege\( 'r72_content_adapter', 'app_private\.lock_active_portal_session\(bytea,uuid,uuid\)', 'EXECUTE' \)/);
  assert.doesNotMatch(sql, /provider_operations[^;]+(?:GRANT|TO r72_content_adapter)/);
  assert.doesNotMatch(sql, /publish|generate|approve|dispatch/i);
});
