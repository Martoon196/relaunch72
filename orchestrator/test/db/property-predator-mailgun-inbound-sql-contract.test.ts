import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../src/db/migrations/0050_property_predator_mailgun_inbound_reply.sql',
  import.meta.url,
);

async function migration(): Promise<string> {
  return (await readFile(migrationUrl, 'utf8')).replace(/\r\n?/gu, '\n');
}

function recorder(sql: string): string {
  const start = sql.indexOf(
    'CREATE FUNCTION app_private.record_property_predator_owned_seed_mailgun_inbound',
  );
  const end = sql.indexOf(
    'CREATE FUNCTION app_private.property_predator_mailgun_inbound_binding_ready',
  );
  assert.ok(start >= 0 && end > start, '0050 recorder must be present and bounded');
  return sql.slice(start, end);
}

test('0050 keeps signed inbound evidence append-only, hash-led and workspace scoped', async () => {
  const sql = await migration();
  const table = /CREATE TABLE app\.property_predator_mailgun_inbound_receipts \(([\s\S]*?)\n\);/u
    .exec(sql)?.[1];
  assert.ok(table);
  for (const digest of [
    'correlation_sha256', 'payload_sha256', 'event_identity_sha256',
    'signature_token_sha256', 'sender_identity_sha256',
    'recipient_identity_sha256', 'subject_sha256', 'body_sha256',
  ]) assert.match(table, new RegExp(`${digest} bytea NOT NULL`));
  assert.doesNotMatch(table, /\b(?:sender|recipient|subject|body_text|signature_token)\s+text\b/iu);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON app\.property_predator_mailgun_inbound_receipts/);
  assert.match(sql, /ALTER TABLE app\.property_predator_mailgun_inbound_receipts FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /UNIQUE \(workspace_id, provider_connection_id, provider_message_id\)/);
  assert.match(sql, /UNIQUE \(workspace_id, inbound_message_id\)/);
  assert.match(sql, /UNIQUE \(workspace_id, admin_call_task_id\)/);
});

test('0050 accepts only a full-digest owned-office reply bound to one settled live delivery', async () => {
  const body = recorder(await migration());
  assert.match(body, /p_correlation_sha256 !~ '\^\[0-9a-f\]\{64\}\$'/);
  assert.match(body, /'reply\+'[\s\S]*property_predator_mailgun_reply_token\(correlation_digest\)[\s\S]*'@mg\.propertypredator\.com'/);
  assert.match(body, /p_normalized_sender <> 'office@propertypredator\.com'/);
  assert.match(body, /job\.request_sha256 = correlation_digest/);
  assert.match(body, /job\.state = 'settled'/);
  assert.match(body, /INTO STRICT selected_job/);
  assert.match(body, /pg_advisory_xact_lock/);
  assert.doesNotMatch(
    body,
    /FOR (?:NO KEY )?(?:UPDATE|SHARE) OF job/,
    'settled-job correlation must not require table UPDATE authority',
  );
  assert.match(body, /connection\.provider_id = 'mailgun_eu'/);
  assert.match(body, /connection\.environment = 'live'/);
  assert.match(body, /delivery\.status IN \('accepted', 'delivered', 'read'\)/);
  assert.match(body, /conversation\.environment = 'live'/);
  assert.match(body, /lower\(point\.normalized_value\) = 'office@propertypredator\.com'/);
});

test('0050 proves event identity, replays one logical Message-Id and rejects altered evidence', async () => {
  const body = recorder(await migration());
  assert.match(body, /pg_advisory_xact_lock/);
  assert.match(body, /provider_message_id = p_provider_message_id/);
  assert.match(body, /existing_receipt\.event_identity_sha256 IS DISTINCT FROM p_event_identity_sha256/);
  assert.match(body, /existing_receipt\.subject_sha256 IS DISTINCT FROM p_subject_sha256/);
  assert.match(body, /existing_receipt\.body_sha256 IS DISTINCT FROM p_body_sha256/);
  assert.doesNotMatch(
    body.slice(body.indexOf('IF FOUND THEN'), body.indexOf('RETURN QUERY SELECT true')),
    /existing_receipt\.(?:payload_sha256|signature_token_sha256|signature_timestamp)/,
  );
  assert.match(body, /p_event_identity_sha256 <> public\.digest\(/);
  assert.match(body, /signature_token_sha256 = p_signature_token_sha256/);
  assert.match(body, /owned-seed inbound reply evidence conflicts/);
  assert.match(body, /RETURN QUERY SELECT true, existing_receipt\.conversation_id/);
});

test('0050 atomically appends inbox, Lead 360 and admin-call projections', async () => {
  const body = recorder(await migration());
  assert.match(body, /INSERT INTO app\.messages/);
  assert.match(body, /'email', 'live', 'inbound', 'received', 'verified_webhook'/);
  assert.match(body, /INSERT INTO app\.message_versions/);
  assert.match(body, /unread_count = least\(conversation\.unread_count \+ 1, 1000000\)/);
  assert.match(body, /INSERT INTO app\.tasks/);
  assert.match(body, /'urgent', 'open'/);
  assert.match(body, /INSERT INTO app\.activities/);
  assert.match(body, /'inbox\.email\.reply_received'/);
  assert.match(body, /least\(p_occurred_at, statement_timestamp\(\)\)/);
  assert.match(body, /INSERT INTO app\.property_predator_mailgun_inbound_receipts/);
});

test('0050 exposes one table-blind command and audits the definer boundary', async () => {
  const sql = await migration();
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app_private\.record_property_predator_owned_seed_mailgun_inbound\([\s\S]*?\) TO r72_mailgun_webhook_command/);
  assert.doesNotMatch(sql, /GRANT (?:SELECT|INSERT|UPDATE|DELETE|TRUNCATE)[^;]* TO r72_mailgun_webhook_command/);
  assert.match(sql, /owner_role\.rolname = 'r72_mailgun_webhook_definer'/);
  assert.match(sql, /procedure\.prosecdef/);
  assert.match(sql, /procedure\.proconfig = ARRAY\['search_path=pg_catalog'\]::text\[\]/);
  assert.match(sql, /pg_has_role\([\s\S]*'r72_mailgun_webhook_command'[\s\S]*'r72_mailgun_webhook_definer'/);
  assert.match(sql, /has_table_privilege\('r72_mailgun_webhook_command', relation\.oid, 'SELECT'\)/);
  assert.match(sql, /'r72_mailgun_webhook_definer', 'app\.messages', 'SELECT'/);
  assert.match(sql, /'r72_mailgun_webhook_definer', 'app\.message_versions', 'SELECT'/);
});
