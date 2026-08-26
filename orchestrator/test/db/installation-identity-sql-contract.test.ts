import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../src/db/migrations/0026_database_installation_identity.sql',
  import.meta.url,
);

const runtimeRoles = [
  'r72_web',
  'r72_identity_command',
  'r72_crm_command',
  'r72_content_command',
  'r72_mailgun_webhook_command',
  'r72_mailgun_worker_command',
] as const;

async function migration(): Promise<string> {
  return (await readFile(migrationUrl, 'utf8')).replace(/\r\n?/g, '\n');
}

test('0026 creates one opaque, generated installation UUID', async () => {
  const sql = await migration();
  const table = /CREATE TABLE app_private\.database_installation_identity \((.*?)\);/s
    .exec(sql)?.[1];
  assert.ok(table);
  assert.match(table, /singleton boolean PRIMARY KEY DEFAULT true CHECK \(singleton\)/);
  assert.match(table, /installation_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid\(\)/);
  assert.equal(
    (sql.match(/INSERT INTO app_private\.database_installation_identity DEFAULT VALUES;/g) ?? []).length,
    1,
  );
  assert.doesNotMatch(sql, /'[0-9a-f]{8}-[0-9a-f-]{27,}'::uuid/);
});

test('0026 exposes only the UUID through a hardened SECURITY DEFINER function', async () => {
  const sql = await migration();
  const functionContract = /CREATE FUNCTION app_private\.runtime_database_installation_id\(\)(.*?)\$function\$;/s
    .exec(sql)?.[1];
  assert.ok(functionContract);
  assert.match(functionContract, /RETURNS uuid/);
  assert.match(functionContract, /LANGUAGE sql\s+STABLE\s+SECURITY DEFINER/);
  assert.match(functionContract, /SET search_path = pg_catalog/);
  assert.match(functionContract, /SELECT installation\.installation_id\s+FROM app_private\.database_installation_identity/);
  assert.doesNotMatch(functionContract, /SELECT \*/);
  assert.match(sql, /ALTER FUNCTION app_private\.runtime_database_installation_id\(\)\s+OWNER TO r72_security_definer/);
  assert.match(sql, /REVOKE ALL ON FUNCTION app_private\.runtime_database_installation_id\(\)\s+FROM PUBLIC/);
});

test('0026 grants function execution to exactly the six production runtime roles', async () => {
  const sql = await migration();
  const grants = [
    ...sql.matchAll(
      /GRANT EXECUTE ON FUNCTION app_private\.runtime_database_installation_id\(\)\s+TO ([^;]+);/g,
    ),
  ];
  assert.equal(grants.length, 1);
  const grantees = grants[0]![1]!
    .split(',')
    .map((role) => role.trim())
    .sort();
  assert.deepEqual(grantees, [...runtimeRoles].sort());
  assert.match(sql, /privilege\.grantee <> ALL \(ARRAY\[/);
  for (const role of runtimeRoles) {
    assert.match(sql, new RegExp(`'${role}'::regrole::oid`));
  }
});

test('0026 keeps every production runtime role table-blind', async () => {
  const sql = await migration();
  const revoke = /REVOKE ALL ON app_private\.database_installation_identity\s+FROM ([^;]+);/s
    .exec(sql)?.[1];
  assert.ok(revoke);
  for (const role of ['PUBLIC', ...runtimeRoles]) {
    assert.match(revoke, new RegExp(`\\b${role}\\b`));
  }
  assert.doesNotMatch(
    sql,
    /GRANT (?:SELECT|INSERT|UPDATE|DELETE|TRUNCATE|REFERENCES|TRIGGER) ON app_private\.database_installation_identity\s+TO (?!r72_security_definer)/,
  );
  for (const privilege of [
    'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER',
  ]) {
    assert.match(
      sql,
      new RegExp(`has_table_privilege\\(role_name, relation_oid, '${privilege}'\\)`),
    );
  }
});

test('0026 forward-extends the Mailgun worker readiness allowlist', async () => {
  const sql = await migration();
  const readiness = /CREATE OR REPLACE FUNCTION app_private\.property_predator_email_pilot_boundary_ready\(\)(.*?)\$function\$;/s
    .exec(sql)?.[1];
  assert.ok(readiness);
  assert.match(readiness, /installation_oid oid := pg_catalog\.to_regprocedure\(\s*'app_private\.runtime_database_installation_id\(\)'/);
  assert.match(readiness, /ledger_oid IS NOT NULL AND installation_oid IS NOT NULL/);
  assert.match(readiness, /has_function_privilege\(session_user, installation_oid, 'EXECUTE'\)/);
  assert.match(
    readiness,
    /procedure\.oid NOT IN \(\s*authorize_oid, cancel_oid, settle_oid, ready_oid, ledger_oid,\s*installation_oid\s*\)/,
  );
  assert.match(readiness, /has_table_privilege\(session_user, relation\.oid, 'SELECT'\)/);
  assert.match(sql, /REVOKE CREATE ON SCHEMA app_private FROM r72_mailgun_worker_definer/);
});
