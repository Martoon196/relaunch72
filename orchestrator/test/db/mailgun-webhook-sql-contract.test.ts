import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../src/db/migrations/0024_mailgun_webhook_evidence.sql',
  import.meta.url,
);

async function migration(): Promise<string> {
  return (await readFile(migrationUrl, 'utf8')).replace(/\s+/gu, ' ').trim();
}

function recorder(sql: string): string {
  const match = /CREATE FUNCTION app_private\.record_mailgun_webhook_event\((.*?)\$function\$;/u.exec(sql);
  assert.ok(match, 'Mailgun recorder must exist and have a terminated body');
  return match[1]!;
}

test('0024 exposes one function-only Mailgun ingress identity', async () => {
  const sql = await migration();
  assert.match(sql, /'r72_mailgun_webhook_definer', false/);
  assert.match(sql, /'r72_mailgun_webhook_command', true/);
  assert.match(sql, /CREATE ROLE %I %s NOINHERIT/);
  assert.match(sql, /REVOKE ALL ON ALL TABLES IN SCHEMA app FROM r72_mailgun_webhook_definer, r72_mailgun_webhook_command/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app_private\.record_mailgun_webhook_event\([^;]*\) TO r72_mailgun_webhook_command/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app_private\.mailgun_webhook_binding_ready\(uuid, uuid\) TO r72_mailgun_webhook_command/);
  assert.doesNotMatch(sql, /GRANT (?:SELECT|INSERT|UPDATE|DELETE|TRUNCATE)[^;]* TO r72_mailgun_webhook_command/);
  assert.match(sql, /owner_role\.rolname = 'r72_mailgun_webhook_definer' AND procedure\.prosecdef/);
  assert.match(sql, /procedure\.proconfig = ARRAY\['search_path=pg_catalog'\]::text\[\]/);
});

test('0024 exposes a boolean-only exact live Mailgun EU binding readiness proof', async () => {
  const sql = await migration();
  const match = /CREATE FUNCTION app_private\.mailgun_webhook_binding_ready\((.*?)\$function\$;/u.exec(sql);
  assert.ok(match);
  const body = match[1]!;
  assert.match(body, /RETURNS boolean/);
  assert.match(body, /current_setting\('app\.workspace_id', true\) = p_workspace_id::text/);
  assert.match(body, /connection\.provider_id = 'mailgun_eu'/);
  assert.match(body, /connection\.provider_kind = 'email'/);
  assert.match(body, /connection\.environment = 'live'/);
  assert.match(body, /connection\.status = 'active'/);
  assert.doesNotMatch(body, /RETURNS TABLE|address|normalized_address/);
});

test('0024 accepts only the canonical live Mailgun EU connection', async () => {
  const body = recorder(await migration());
  assert.match(body, /connection\.provider_id = 'mailgun_eu'/);
  assert.match(body, /connection\.provider_kind = 'email'/);
  assert.match(body, /connection\.environment = 'live'/);
  assert.match(body, /operation\.environment = 'live'/);
  assert.match(body, /delivery\.environment = operation\.environment/);
  assert.doesNotMatch(body, /environment IN \('sandbox', 'live'\)/);
  assert.match(body, /operation\.provider_reference IN \( p_provider_message_id, '<' \|\| p_provider_message_id \|\| '>' \)/);
});

test('0024 retains only hashed signature, recipient and payload evidence', async () => {
  const sql = await migration();
  const events = /CREATE TABLE app\.mailgun_webhook_events \((.*?)\); -- Nonces/u.exec(sql)?.[1];
  const tokens = /CREATE TABLE app\.mailgun_webhook_signature_tokens \((.*?)\); CREATE INDEX/u.exec(sql)?.[1];
  assert.ok(events);
  assert.ok(tokens);
  assert.match(events, /payload_sha256 bytea NOT NULL CHECK \(octet_length\(payload_sha256\) = 32\)/);
  assert.match(events, /signature_token_sha256 bytea NOT NULL CHECK \( octet_length\(signature_token_sha256\) = 32 \)/);
  assert.match(events, /recipient_identity_sha256 bytea NOT NULL CHECK \( octet_length\(recipient_identity_sha256\) = 32 \)/);
  assert.doesNotMatch(events, /(?:recipient|signature_token|payload)\s+text/);
  assert.match(tokens, /PRIMARY KEY \( workspace_id, provider_connection_id, signature_token_sha256 \)/);
  assert.match(sql, /ALTER TABLE app\.mailgun_webhook_events FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /ALTER TABLE app\.mailgun_webhook_signature_tokens FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /Mailgun webhook evidence is append-only/);
  assert.doesNotMatch(sql, /GRANT (?:UPDATE|DELETE|TRUNCATE) ON app\.mailgun_webhook_events/);
});

test('0024 is replay-safe and projects receipts, suppressions and opt-outs atomically', async () => {
  const body = recorder(await migration());
  assert.match(body, /INSERT INTO app\.mailgun_webhook_signature_tokens[^;]*ON CONFLICT \( workspace_id, provider_connection_id, signature_token_sha256 \) DO NOTHING/);
  assert.match(body, /mailgun signature token replay conflict/);
  assert.match(body, /INSERT INTO app\.mailgun_webhook_events[^;]*ON CONFLICT \( workspace_id, provider_connection_id, external_event_id \) DO NOTHING/);
  assert.match(body, /mailgun event identity conflict/);
  assert.match(body, /RETURN QUERY SELECT true, selected_delivery_status, existing_event\.suppression_recorded, existing_event\.opt_out_recorded/);
  assert.match(body, /INSERT INTO app\.provider_operation_receipts/);
  assert.match(body, /source_kind[^;]*'verified_webhook'/);
  assert.match(body, /INSERT INTO app\.communication_suppression_events/);
  assert.match(body, /WHEN p_event_type = 'complained' THEN 'mailgun_complaint'/);
  assert.match(body, /WHEN p_event_type = 'unsubscribed' THEN 'mailgun_unsubscribe'/);
  assert.match(body, /ELSE 'mailgun_permanent_failure'/);
  assert.match(body, /INSERT INTO app\.communication_consent_events/);
  assert.match(body, /selected_purpose, 'withdrawn'/);
  assert.match(body, /IF p_event_type = 'accepted' THEN UPDATE app\.message_deliveries/);
  assert.match(body, /ELSIF p_event_type = 'delivered' THEN UPDATE app\.message_deliveries/);
  assert.match(body, /ELSIF p_event_type = 'opened' THEN UPDATE app\.message_deliveries/);
  assert.match(body, /ELSIF p_event_type = 'failed' AND p_failure_severity = 'permanent' THEN UPDATE app\.message_deliveries/);
});
