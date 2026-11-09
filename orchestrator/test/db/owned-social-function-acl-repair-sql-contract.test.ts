import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migrationUrl = new URL(
  '../../src/db/migrations/0060_owned_social_function_acl_repair.sql',
  import.meta.url,
);

function normalise(sql: string): string {
  return sql.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();
}

test('0060 removes PUBLIC execution from every owned-social effect function', async () => {
  const sql = normalise(await readFile(migrationUrl, 'utf8'));
  for (const functionName of [
    'record_owned_social_profile',
    'revoke_owned_social_profile',
    'enqueue_owned_social_job',
    'claim_owned_social_job',
    'load_owned_social_job',
    'begin_owned_social_call',
    'settle_owned_social_call',
    'property_predator_owned_social_activation_readiness',
  ]) {
    assert.match(
      sql,
      new RegExp(`REVOKE ALL ON FUNCTION app_private\\.${functionName}\\(`),
    );
  }
  assert.match(sql, /FROM PUBLIC/);
  assert.match(sql, /pg_catalog\.aclexplode/);
  assert.match(sql, /privilege\.grantee = 0/);
  assert.match(sql, /privilege\.privilege_type = 'EXECUTE'/);
});

test('0060 restores only the exact command and worker execution grants', async () => {
  const sql = normalise(await readFile(migrationUrl, 'utf8'));
  for (const commandFunction of [
    'record_owned_social_profile',
    'revoke_owned_social_profile',
    'enqueue_owned_social_job',
    'property_predator_owned_social_activation_readiness',
  ]) {
    assert.match(
      sql,
      new RegExp(`GRANT EXECUTE ON FUNCTION app_private\\.${commandFunction}\\([^;]+TO r72_owned_social_command`),
    );
  }
  for (const workerFunction of [
    'claim_owned_social_job',
    'load_owned_social_job',
    'begin_owned_social_call',
    'settle_owned_social_call',
  ]) {
    assert.match(
      sql,
      new RegExp(`GRANT EXECUTE ON FUNCTION app_private\\.${workerFunction}\\([^;]+TO r72_owned_social_worker_command`),
    );
  }
  assert.match(sql, /SET LOCAL ROLE r72_owned_social_definer/);
  assert.match(sql, /REVOKE CREATE ON SCHEMA app_private FROM r72_owned_social_definer/);
});

test('0060 is ACL-only and cannot enqueue, call or mutate provider data', async () => {
  const sql = normalise(await readFile(migrationUrl, 'utf8'));
  assert.doesNotMatch(sql, /\bINSERT INTO\b/);
  assert.doesNotMatch(sql, /\bUPDATE app\./);
  assert.doesNotMatch(sql, /\bDELETE FROM\b/);
  assert.doesNotMatch(sql, /\bTRUNCATE\b/);
  assert.doesNotMatch(sql, /\bCREATE FUNCTION\b/);
});
