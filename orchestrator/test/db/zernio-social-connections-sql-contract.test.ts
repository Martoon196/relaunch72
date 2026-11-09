import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../src/db/migrations/0074_property_predator_zernio_social_connections.sql',
  import.meta.url,
);
const readSessionAclRepairUrl = new URL(
  '../../src/db/migrations/0075_zernio_social_read_session_acl_repair.sql',
  import.meta.url,
);
const expiredIntentDeleteAclRepairUrl = new URL(
  '../../src/db/migrations/0076_zernio_social_expired_intent_delete_acl_repair.sql',
  import.meta.url,
);

function normalise(sql: string): string {
  return sql.replace(/--[^\n]*/gu, ' ').replace(/\s+/gu, ' ').trim();
}

test('0074 creates a table-blind founder-only Zernio connection boundary', async () => {
  const sql = normalise(await readFile(migrationUrl, 'utf8'));
  assert.match(sql, /CREATE ROLE r72_zernio_social_command LOGIN NOINHERIT/);
  assert.match(sql, /CREATE ROLE r72_zernio_social_definer NOLOGIN NOINHERIT/);
  assert.match(sql, /CREATE TABLE app\.property_predator_zernio_connection_intents/);
  assert.match(sql, /CREATE TABLE app\.property_predator_zernio_accounts/);
  assert.match(sql, /CREATE TABLE app\.property_predator_zernio_account_webhook_receipts/);
  assert.match(sql, /state text NOT NULL CHECK \(state IN \('claimed', 'prepared', 'consumed'\)\)/);
  assert.match(sql, /expires_at = created_at \+ interval '10 minutes'/);
  assert.match(sql, /CREATE UNIQUE INDEX property_predator_zernio_intents_one_open_network_uq/);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON app\.property_predator_zernio_account_webhook_receipts/);
  for (const table of [
    'property_predator_zernio_connection_intents',
    'property_predator_zernio_accounts',
    'property_predator_zernio_account_webhook_receipts',
  ]) {
    assert.match(sql, new RegExp(`ALTER TABLE app\\.${table} ENABLE ROW LEVEL SECURITY`));
    assert.match(sql, new RegExp(`ALTER TABLE app\\.${table} FORCE ROW LEVEL SECURITY`));
  }
  for (const fn of [
    'begin_zernio_connection_intent',
    'complete_zernio_connection_preparation',
    'record_zernio_connection_callback',
    'record_zernio_account_webhook',
    'read_zernio_social_accounts',
  ]) {
    assert.match(sql, new RegExp(`CREATE FUNCTION app_private\\.${fn}\\(`));
  }
  assert.match(sql, /session_user <> 'r72_zernio_social_command'/);
  assert.match(sql, /membership\.role IN \('owner', 'admin'\)/);
  assert.match(sql, /connection\.provider_id = 'zernio'/);
  assert.match(sql, /connection\.environment = 'live' AND connection\.status = 'active'/);
  assert.match(sql, /selected_intent\.portal_session_token_sha256 <> p_portal_session_token_sha256/);
  assert.match(sql, /selected_intent\.network <> p_network/);
  assert.match(sql, /selected_intent\.expires_at <= statement_timestamp\(\)/);
  assert.match(sql, /existing\.raw_body_sha256 <> p_raw_body_sha256/);
  assert.match(sql, /has_table_privilege\('r72_zernio_social_command'/);
  assert.doesNotMatch(sql, /GRANT (?:SELECT|INSERT|UPDATE|DELETE|TRUNCATE)[^;]+ TO r72_zernio_social_command/);
  assert.doesNotMatch(sql, /GRANT EXECUTE[^;]+ TO PUBLIC/);
  assert.doesNotMatch(sql, /(?:publish|enqueue|schedule|worker_lease|claim_job)/iu);
});

test('0075 grants only the missing read-only session fence and audits the boundary', async () => {
  const sql = normalise(await readFile(readSessionAclRepairUrl, 'utf8'));
  assert.match(
    sql,
    /GRANT EXECUTE ON FUNCTION app_private\.active_portal_session\(bytea, uuid, uuid\) TO r72_zernio_social_command/,
  );
  assert.match(sql, /has_function_privilege\( 'r72_zernio_social_command', 'app_private\.active_portal_session\(bytea,uuid,uuid\)', 'EXECUTE' \)/);
  assert.match(sql, /app_private\.lock_active_portal_session\(bytea,uuid,uuid\)/);
  assert.match(sql, /app_private\.read_zernio_social_accounts\(uuid,uuid,bytea\)/);
  assert.match(sql, /has_table_privilege\( 'r72_zernio_social_command', relation\.oid, 'TRUNCATE' \)/);
  assert.doesNotMatch(sql, /GRANT (?:SELECT|INSERT|UPDATE|DELETE|TRUNCATE)/);
  assert.doesNotMatch(sql, /(?:publish|enqueue|schedule|worker_lease|claim_job)/iu);
});

test('0076 grants only expired-intent deletion and protects durable account evidence', async () => {
  const sql = normalise(await readFile(expiredIntentDeleteAclRepairUrl, 'utf8'));
  assert.match(
    sql,
    /GRANT DELETE ON app\.property_predator_zernio_connection_intents TO r72_zernio_social_definer/,
  );
  assert.match(sql, /property_predator_zernio_accounts', 'DELETE'/);
  assert.match(sql, /property_predator_zernio_account_webhook_receipts', 'DELETE'/);
  assert.match(sql, /r72_zernio_social_command', relation\.oid, 'TRUNCATE'/);
  assert.doesNotMatch(sql, /GRANT DELETE ON app\.property_predator_zernio_(?:accounts|account_webhook_receipts)/);
  assert.doesNotMatch(sql, /(?:publish|enqueue|schedule|worker_lease|claim_job)/iu);
});
