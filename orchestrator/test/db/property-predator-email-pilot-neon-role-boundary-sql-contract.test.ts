import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../src/db/migrations/0046_neon_mailgun_worker_creator_membership.sql',
  import.meta.url,
);

async function migration(): Promise<string> {
  return (await readFile(migrationUrl, 'utf8')).replace(/\r\n?/g, '\n');
}

test('0046 removes only the effective owner self-grant with RESTRICT', async () => {
  const sql = await migration();
  assert.match(sql, /grantor\.rolname = session_user/);
  assert.match(sql, /membership\.inherit_option OR membership\.set_option/);
  assert.match(
    sql,
    /REVOKE r72_mailgun_worker_command FROM %I GRANTED BY %I RESTRICT/,
  );
  assert.doesNotMatch(sql, /\bCASCADE\b/);
  assert.doesNotMatch(sql, /(?:UPDATE|DELETE|INSERT)\s+(?:FROM\s+)?pg_catalog\.pg_auth_members/i);
});

test('0046 accepts exactly one non-effective bootstrap creator grant', async () => {
  const sql = await migration();
  const readiness = /CREATE OR REPLACE FUNCTION app_private\.property_predator_email_pilot_boundary_ready\(\)(.*?)\$function\$;/s
    .exec(sql)?.[1];
  assert.ok(readiness);
  assert.match(readiness, /database_owner_oid oid/);
  assert.match(readiness, /membership\.member = session_role_oid/);
  assert.match(readiness, /membership\.roleid = session_role_oid/);
  assert.match(readiness, /SELECT pg_catalog\.count\(\*\)/);
  assert.match(readiness, /membership\.member = database_owner_oid/);
  assert.match(readiness, /grantor\.rolsuper/);
  assert.match(readiness, /membership\.admin_option/);
  assert.match(readiness, /NOT membership\.inherit_option/);
  assert.match(readiness, /NOT membership\.set_option/);
  assert.match(
    readiness,
    /pg_catalog\.pg_has_role\(\s*database_owner_oid, session_role_oid, 'USAGE'/,
  );
  assert.match(
    readiness,
    /pg_catalog\.pg_has_role\(\s*database_owner_oid, session_role_oid, 'SET'/,
  );
  assert.doesNotMatch(readiness, /'MEMBER'/);
});

test('0046 preserves the hardened worker function ownership and privilege edge', async () => {
  const sql = await migration();
  assert.match(sql, /SET LOCAL ROLE r72_mailgun_worker_definer/);
  assert.match(
    sql,
    /LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog/,
  );
  assert.match(
    sql,
    /REVOKE ALL ON FUNCTION app_private\.property_predator_email_pilot_boundary_ready\(\)\s+FROM PUBLIC/,
  );
  assert.match(
    sql,
    /GRANT EXECUTE ON FUNCTION app_private\.property_predator_email_pilot_boundary_ready\(\)\s+TO r72_mailgun_worker_command/,
  );
  assert.match(
    sql,
    /REVOKE CREATE ON SCHEMA app_private FROM r72_mailgun_worker_definer/,
  );
});
