import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationPath = path.join(
  testDirectory,
  '../../src/db/migrations/0038_test_inbox_webhook_inbound.sql',
);
const sql = fs.readFileSync(migrationPath, 'utf8');

function block(start: RegExp, end: RegExp): string {
  const startMatch = start.exec(sql);
  assert.ok(startMatch?.index !== undefined, `missing block start ${start}`);
  const tail = sql.slice(startMatch.index);
  const endMatch = end.exec(tail);
  assert.ok(endMatch?.index !== undefined, `missing block end ${end}`);
  return tail.slice(0, endMatch.index + endMatch[0].length);
}

test('migration creates one dedicated function-only webhook command identity', () => {
  assert.match(sql, /'r72_test_inbox_webhook_definer', false/);
  assert.match(sql, /'r72_test_inbox_webhook_command', true/);
  assert.match(sql, /AND NOT rolinherit AND NOT rolsuper AND NOT rolcreatedb/);
  assert.match(sql, /AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls/);
  assert.match(sql, /REVOKE ALL ON ALL TABLES IN SCHEMA app[\s\S]*r72_test_inbox_webhook_command/);
  assert.match(sql, /GRANT USAGE ON SCHEMA app_private TO r72_test_inbox_webhook_command/);
  assert.doesNotMatch(sql, /GRANT USAGE ON SCHEMA app TO r72_test_inbox_webhook_command/);
  assert.match(sql, /unexpectedly has table privilege/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app_private\.record_test_inbox_webhook_inbound\([\s\S]*TO r72_test_inbox_webhook_command/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app_private\.test_inbox_webhook_binding_ready\([\s\S]*TO r72_test_inbox_webhook_command/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app_private\.runtime_database_installation_id\(\)[\s\S]*TO r72_test_inbox_webhook_command/);
});

test('dark simulator provider connections are structurally TEST-only', () => {
  assert.match(sql, /provider_connections_dark_simulators_test_only_ck/);
  assert.match(sql, /provider_id NOT IN \([\s\S]*'whatsapp_dark_simulator',[\s\S]*'social_dm_dark_simulator'[\s\S]*\) OR environment = 'test'/);
  assert.match(sql, /VALIDATE CONSTRAINT provider_connections_dark_simulators_test_only_ck/);
  const recorder = block(
    /CREATE FUNCTION app_private\.record_test_inbox_webhook_inbound\(/,
    /\$function\$;/,
  );
  assert.match(recorder, /connection\.environment = 'test' AND connection\.status = 'active'/);
  assert.match(recorder, /connection\.provider_id = p_provider_id/);
  assert.match(recorder, /p_provider_id NOT IN \([\s\S]*whatsapp_dark_simulator[\s\S]*social_dm_dark_simulator/);
  assert.doesNotMatch(recorder, /environment = '(?:live|sandbox)'/);
});

test('receipt evidence is immutable, forced-RLS and contains hashes instead of raw payload/address/signature data', () => {
  const receipt = block(
    /CREATE TABLE app\.test_inbox_webhook_receipts \(/,
    /\n\);/,
  );
  for (const digestColumn of [
    'payload_sha256', 'event_identity_sha256', 'signature_sha256',
    'source_identity_sha256', 'destination_identity_sha256', 'body_sha256',
  ]) {
    assert.match(receipt, new RegExp(`${digestColumn} bytea NOT NULL`));
  }
  assert.doesNotMatch(receipt, /\bbody(?:_text)?\s+text\b/i);
  assert.doesNotMatch(receipt, /\b(?:source|destination|recipient|sender)_address\b/i);
  assert.doesNotMatch(receipt, /\bsignature\s+text\b/i);
  assert.doesNotMatch(receipt, /\b(?:payload|event)_body\b/i);
  assert.match(sql, /test_inbox_webhook_receipts_append_only/);
  assert.match(sql, /ALTER TABLE app\.test_inbox_webhook_receipts ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /ALTER TABLE app\.test_inbox_webhook_receipts FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /UNIQUE \(workspace_id, provider_connection_id, external_event_id\)/);
  assert.match(sql, /UNIQUE \(workspace_id, provider_connection_id, signature_sha256\)/);
});

test('recorder conflict-fences signatures/events and rebinds reserved addresses inside PostgreSQL', () => {
  const recorder = block(
    /CREATE FUNCTION app_private\.record_test_inbox_webhook_inbound\(/,
    /\$function\$;/,
  );
  assert.match(recorder, /pg_advisory_xact_lock\([\s\S]*test-inbox-signature/);
  assert.match(recorder, /pg_advisory_xact_lock\([\s\S]*test-inbox-event/);
  assert.match(recorder, /pg_advisory_xact_lock\([\s\S]*test-inbox-conversation:/);
  assert.doesNotMatch(recorder, /FOR UPDATE OF inbox/);
  assert.match(recorder, /test inbox webhook signature replay conflict/);
  assert.match(recorder, /test inbox webhook event identity conflict/);
  assert.match(recorder, /public\.digest\(point\.normalized_value, 'sha256'\) = p_source_identity_sha256/);
  assert.match(recorder, /public\.digest\(endpoint\.normalized_address, 'sha256'\) = p_destination_identity_sha256/);
  assert.match(recorder, /point\.normalized_value ~ '\^\[\+\]447700900\[0-9\]\{3\}\$'/);
  assert.match(recorder, /'\^test-dm:' \|\| inbox\.channel/);
  assert.match(recorder, /'inbound', 'received', 'verified_webhook'/);
  assert.match(recorder, /'webhook', NULL, p_occurred_at/);
  assert.match(recorder, /created_request_id[\s\S]*trusted_request_id/);
  assert.match(recorder, /p_occurred_at < received_at - interval '5 minutes'/);
  assert.match(recorder, /p_occurred_at > received_at \+ interval '5 minutes'/);
});

test('startup readiness exposes one boolean-only exact TEST binding proof', () => {
  const readiness = block(
    /CREATE FUNCTION app_private\.test_inbox_webhook_binding_ready\(/,
    /\$function\$;/,
  );
  assert.match(readiness, /RETURNS boolean/);
  assert.match(readiness, /current_setting\('app\.workspace_id', true\) = p_workspace_id::text/);
  assert.match(readiness, /current_setting\('app\.actor_kind', true\) = 'webhook'/);
  assert.match(readiness, /connection\.provider_id = p_provider_id/);
  assert.match(readiness, /connection\.environment = 'test' AND connection\.status = 'active'/);
  assert.match(readiness, /inbox\.id = p_inbox_id/);
  assert.match(readiness, /point\.id = p_contact_point_id/);
  assert.match(readiness, /point\.contact_id = p_contact_id/);
  assert.match(readiness, /whatsapp_dark_simulator[\s\S]*social_dm_dark_simulator/);
  assert.match(readiness, /\^\[\+\]447700900\[0-9\]\{3\}\$/);
  assert.match(readiness, /\^test-dm:/);
  assert.doesNotMatch(readiness, /RETURNS TABLE|SELECT endpoint\.normalized_address|SELECT point\.normalized_value/);
});

test('member provenance returns only message-linked simulator family, network and server time', () => {
  const provenance = block(
    /CREATE FUNCTION app_private\.test_inbox_webhook_message_provenance\(/,
    /\$function\$;/,
  );
  assert.match(provenance, /RETURNS TABLE \(\s*receipt_id uuid,\s*provider_family text,\s*network text,\s*received_at timestamptz\s*\)/);
  assert.match(provenance, /p_workspace_id = app_private\.current_workspace_id\(\)/);
  assert.match(provenance, /app_private\.current_actor_kind\(\) = 'user'/);
  assert.match(provenance, /app_private\.has_active_workspace_membership\([\s\S]*p_workspace_id/);
  assert.match(provenance, /receipt\.conversation_id = p_conversation_id/);
  assert.match(provenance, /receipt\.message_id = p_message_id/);
  assert.match(provenance, /receipt\.environment = 'test'/);
  assert.match(provenance, /whatsapp_dark_simulator[\s\S]*receipt\.channel = 'whatsapp'/);
  assert.match(provenance, /social_dm_dark_simulator[\s\S]*receipt\.channel IN \('instagram', 'facebook'\)/);
  assert.doesNotMatch(provenance, /external_event_id|_sha256|contact_id|contact_point_id|normalized_address|body_text/);
  assert.match(sql, /UNIQUE \(workspace_id, message_id\)/);
  assert.match(sql, /FOREIGN KEY \([\s\S]*workspace_id, conversation_id, message_id,[\s\S]*message_version_id, version_number, body_sha256[\s\S]*REFERENCES app\.message_versions/);
  assert.match(sql, /test_inbox_webhook_receipts_append_only/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app_private\.test_inbox_webhook_message_provenance\([\s\S]*TO r72_web/);
  assert.match(sql, /'r72_web', 'app\.test_inbox_webhook_receipts', 'SELECT'/);
});

test('command role gets no live-provider, queue, worker or broad inbox capability', () => {
  assert.doesNotMatch(sql, /GRANT .*app\.provider_operations.*r72_test_inbox_webhook_(?:command|definer)/);
  assert.doesNotMatch(sql, /GRANT .*app\.message_deliveries.*r72_test_inbox_webhook_(?:command|definer)/);
  assert.doesNotMatch(sql, /GRANT .*app\.provider_credentials/);
  assert.doesNotMatch(sql, /MAILGUN_API_KEY|TWILIO_AUTH_TOKEN|META_ACCESS_TOKEN|AYRSHARE_API_KEY/);
  assert.match(sql, /has_table_privilege\([\s\S]*r72_test_inbox_webhook_command/);
  assert.match(sql, /r72_test_inbox_webhook_definer', 'app\.messages', 'SELECT'/);
  assert.match(sql, /r72_test_inbox_webhook_definer', 'app\.message_versions', 'SELECT'/);
});

test('recorder is owned by its NOLOGIN definer with a fixed search path', () => {
  assert.match(sql, /SET LOCAL ROLE r72_test_inbox_webhook_definer;[\s\S]*CREATE FUNCTION app_private\.record_test_inbox_webhook_inbound/);
  assert.match(sql, /SECURITY DEFINER\s+SET search_path = pg_catalog/);
  assert.match(sql, /owner_role\.rolname = 'r72_test_inbox_webhook_definer'/);
  assert.match(sql, /procedure\.proconfig = ARRAY\['search_path=pg_catalog'\]::text\[\]/);
  assert.match(sql, /REVOKE CREATE ON SCHEMA app_private FROM r72_test_inbox_webhook_definer/);
});
