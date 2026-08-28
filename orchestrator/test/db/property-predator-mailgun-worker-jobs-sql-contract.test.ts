import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../src/db/migrations/0043_property_predator_mailgun_worker_jobs.sql',
  import.meta.url,
);

async function migration(): Promise<string> {
  return (await readFile(migrationUrl, 'utf8')).replace(/\r\n?/g, '\n');
}

test('0043 adds a dedicated table-blind one-job Mailgun lease boundary', async () => {
  const sql = await migration();
  assert.match(sql, /CREATE TABLE app\.property_predator_mailgun_jobs/);
  assert.match(sql, /CREATE TABLE app\.property_predator_mailgun_job_lease_hashes/);
  assert.match(sql, /FOR UPDATE SKIP LOCKED/);
  assert.match(sql, /LIMIT 1 FOR UPDATE SKIP LOCKED/);
  for (const capability of [
    'claim_property_predator_mailgun_job',
    'renew_property_predator_mailgun_job',
    'begin_property_predator_mailgun_job_call',
    'settle_property_predator_mailgun_job',
    'recover_one_property_predator_mailgun_job',
  ]) {
    assert.match(sql, new RegExp(`GRANT EXECUTE ON FUNCTION app_private\\.${capability}`));
  }
  assert.doesNotMatch(sql, /GRANT (?:SELECT|INSERT|UPDATE|DELETE|TRUNCATE)[^;]*TO r72_mailgun_worker_command/);
  assert.match(sql, /has_table_privilege\('r72_mailgun_worker_command'/);
});

test('0043 gives the definer exactly the lease-row delete capability used by recovery', async () => {
  const sql = await migration();
  assert.match(
    sql,
    /GRANT SELECT, INSERT, UPDATE, DELETE\s+ON app\.property_predator_mailgun_job_lease_hashes\s+TO r72_mailgun_worker_definer/,
  );
  assert.doesNotMatch(
    sql,
    /GRANT[^;]*DELETE[^;]*ON app\.property_predator_mailgun_jobs/,
  );
});

test('0043 stores no raw payload, mailbox, credentials or raw lease token in the job table', async () => {
  const sql = await migration();
  const jobTable = /CREATE TABLE app\.property_predator_mailgun_jobs \(([\s\S]*?)\n\);/.exec(sql)?.[1];
  assert.ok(jobTable);
  assert.doesNotMatch(jobTable, /\b(?:recipient|email_address|subject|body|credential|api_key|lease_token)\b/i);
  assert.match(jobTable, /email_sha256 bytea/);
  assert.match(jobTable, /expected_message_id text/);
  const leaseTable = /CREATE TABLE app\.property_predator_mailgun_job_lease_hashes \(([\s\S]*?)\n\);/.exec(sql)?.[1];
  assert.ok(leaseTable);
  assert.match(leaseTable, /lease_token_sha256 bytea/);
  assert.doesNotMatch(leaseTable, /lease_token\s+bytea/);
});

test('0043 performs exact current-evidence authorization at begin-call with hard pilot caps', async () => {
  const sql = await migration();
  const begin = sql.slice(
    sql.indexOf('CREATE FUNCTION app_private.begin_property_predator_mailgun_job_call'),
    sql.indexOf('CREATE FUNCTION app_private.settle_property_predator_mailgun_job'),
  );
  assert.match(begin, /authorize_property_predator_email_pilot/);
  assert.match(begin, /'internal-seed', 'owned-internal-seeds-only'/);
  assert.match(begin, /\)\), 1, selected\.estimated_spend_usd_micros,\s*1, 3,/);
  assert.match(begin, /lower\(point\.normalized_value\) = 'office@propertypredator\.com'/);
  assert.match(begin, /selected_expected_id := '<pp-' \|\| encode\(selected\.request_sha256, 'hex'\)/);
  assert.ok(
    begin.indexOf('provider_reference = selected_expected_id')
      < begin.indexOf("SET state = 'calling'"),
    'expected Message-ID must be durable before the job crosses the calling fence',
  );
});

test('0043 fences claim, begin and recovery to one configured provider connection', async () => {
  const sql = await migration();
  const claim = sql.slice(
    sql.indexOf('CREATE FUNCTION app_private.claim_property_predator_mailgun_job'),
    sql.indexOf('CREATE FUNCTION app_private.renew_property_predator_mailgun_job'),
  );
  const begin = sql.slice(
    sql.indexOf('CREATE FUNCTION app_private.begin_property_predator_mailgun_job_call'),
    sql.indexOf('CREATE FUNCTION app_private.settle_property_predator_mailgun_job'),
  );
  const recover = sql.slice(
    sql.indexOf('CREATE FUNCTION app_private.recover_one_property_predator_mailgun_job'),
    sql.indexOf('CREATE OR REPLACE FUNCTION app_private.property_predator_email_pilot_boundary_ready'),
  );
  for (const body of [claim, begin, recover]) {
    assert.match(body, /p_provider_connection_id uuid/);
    assert.match(body, /job\.provider_connection_id = p_provider_connection_id/);
  }
});

test('0043 never requeues a possibly-called job and supports signed-webhook recovery', async () => {
  const sql = await migration();
  const recover = sql.slice(
    sql.indexOf('CREATE FUNCTION app_private.recover_one_property_predator_mailgun_job'),
    sql.indexOf('CREATE OR REPLACE FUNCTION app_private.property_predator_email_pilot_boundary_ready'),
  );
  assert.match(recover, /IF selected\.state = 'leased'[\s\S]*SET state = 'queued'/);
  assert.match(recover, /IF selected\.state = 'calling'[\s\S]*'needs_attention'/);
  assert.doesNotMatch(
    recover.slice(recover.indexOf("IF selected.state = 'calling'")),
    /SET state = 'queued'/,
  );
  assert.match(recover, /source_kind = 'verified_webhook'/);
  assert.match(recover, /'signed_webhook_reconciled'/);
  assert.match(sql, /A returned Mailgun id is authoritative/);
});

test('0043 terminally handles stale-month and eighth-claim pre-call jobs', async () => {
  const sql = await migration();
  const begin = sql.slice(
    sql.indexOf('CREATE FUNCTION app_private.begin_property_predator_mailgun_job_call'),
    sql.indexOf('CREATE FUNCTION app_private.settle_property_predator_mailgun_job'),
  );
  const recover = sql.slice(
    sql.indexOf('CREATE FUNCTION app_private.recover_one_property_predator_mailgun_job'),
    sql.indexOf('CREATE OR REPLACE FUNCTION app_private.property_predator_email_pilot_boundary_ready'),
  );
  assert.match(begin, /selected\.utc_month <> date_trunc\([\s\S]*'stale_utc_month'/);
  assert.ok(
    begin.indexOf("'stale_utc_month'") < begin.indexOf('authorize_property_predator_email_pilot'),
    'stale jobs must stop before authorization/provider-call state',
  );
  assert.match(recover, /selected\.claim_count >= 8[\s\S]*'lease_attempts_exhausted'/);
  assert.match(recover, /'claim_attempts_exhausted'/);
});

test('0043 reconciles only terminal signed receipts across every durable ledger', async () => {
  const sql = await migration();
  const recover = sql.slice(
    sql.indexOf('CREATE FUNCTION app_private.recover_one_property_predator_mailgun_job'),
    sql.indexOf('CREATE OR REPLACE FUNCTION app_private.property_predator_email_pilot_boundary_ready'),
  );
  assert.match(recover, /SELECT receipt\.delivery_status, receipt\.occurred_at, receipt\.error_code/);
  assert.match(recover, /receipt\.delivery_status IN \('accepted', 'delivered', 'read'\)/);
  assert.match(recover, /receipt\.delivery_status = 'failed'[\s\S]*receipt\.error_code = 'mailgun\.permanent'/);
  assert.doesNotMatch(recover, /mailgun\.temporary/);
  assert.match(recover, /UPDATE app\.property_predator_email_pilot_reservations/);
  assert.match(recover, /WHEN delivery_status = 'accepted' THEN 'accepted'/);
  assert.match(recover, /WHEN delivery_status IN \('delivered', 'read'\) THEN 'succeeded'/);
  assert.match(recover, /ELSE 'failed'/);
  assert.match(recover, /UPDATE app\.provider_operations AS operation/);
  assert.match(recover, /UPDATE app\.message_deliveries AS delivery/);
  assert.match(recover, /UPDATE app\.property_predator_mailgun_jobs/);
  assert.equal(
    (recover.match(/GET DIAGNOSTICS changed_rows = ROW_COUNT/g) ?? []).length,
    4,
  );
  assert.match(recover, /last_error_code = CASE WHEN delivery_status = 'failed'[\s\S]*ELSE NULL END/);
  assert.match(recover, /last_summary = CASE WHEN delivery_status = 'failed'[\s\S]*ELSE NULL END/);
  assert.doesNotMatch(recover, /SELECT delivery\.status, max\(receipt\.occurred_at\)/);
});

test('0043 keeps an authoritative Mailgun response id over the deterministic fallback', async () => {
  const sql = await migration();
  const settle = sql.slice(
    sql.indexOf('CREATE FUNCTION app_private.settle_property_predator_mailgun_job'),
    sql.indexOf('CREATE FUNCTION app_private.recover_one_property_predator_mailgun_job'),
  );
  assert.match(
    settle,
    /provider_reference = coalesce\(p_external_id, selected\.expected_message_id\)/,
  );
  assert.doesNotMatch(settle, /provider_reference = selected\.expected_message_id/);
  assert.match(settle, /Mailgun operation reference fence was lost/);
  assert.match(settle, /Mailgun job settlement fence was lost/);
});

test('0043 leaves the 0023 TEST-only provider queue untouched', async () => {
  const sql = await migration();
  assert.doesNotMatch(sql, /provider_operation_dispatch|claim_provider_operation|0023_provider/);
});
