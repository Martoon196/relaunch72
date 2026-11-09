import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const migration = readFileSync(fileURLToPath(new URL(
  '../src/db/migrations/0055_property_predator_operational_conversion_inbox.sql',
  import.meta.url,
)), 'utf8');

test('0055 extends the one canonical Conversion Inbox with append-only operational evidence', () => {
  for (const relation of [
    'property_predator_inbox_assignment_events',
    'property_predator_admin_call_task_origins',
    'property_predator_admin_call_outcomes',
    'property_predator_whatsapp_live_inbox_projections',
  ]) {
    assert.match(migration, new RegExp(`CREATE TABLE app\\.${relation}`));
  }
  assert.match(migration, /ALTER TABLE app\.%I ENABLE ROW LEVEL SECURITY/u);
  assert.match(migration, /ALTER TABLE app\.%I FORCE ROW LEVEL SECURITY/u);
  assert.match(migration, /reject_operational_inbox_evidence_mutation/u);
  assert.match(migration, /Operational inbox evidence is append-only/u);
});

test('0055 exposes exact provider-incapable operator commands through r72_crm_command', () => {
  for (const command of [
    'assign_operational_inbox_conversation',
    'append_operational_inbox_internal_note',
    'create_operational_inbox_admin_call_task',
    'record_operational_inbox_admin_call_outcome',
  ]) {
    assert.match(migration, new RegExp(`CREATE FUNCTION app_private\\.${command}`));
    assert.match(migration, new RegExp(
      `GRANT EXECUTE ON FUNCTION app_private\\.${command}\\([\\s\\S]*?\\) TO r72_crm_command`,
    ));
  }
  assert.doesNotMatch(migration, /GRANT (?:SELECT|INSERT|UPDATE|DELETE)[\s\S]{0,120}TO r72_crm_command/u);
});

test('0055 makes verified WhatsApp projection the only webhook entry point', () => {
  assert.match(migration, /CREATE FUNCTION app_private\.record_whatsapp_live_inbound_projection\(/u);
  assert.match(migration, /p_signature_sha256 bytea/u);
  assert.match(migration, /p_event_identity_sha256 bytea/u);
  assert.match(migration, /REVOKE EXECUTE ON FUNCTION app_private\.record_whatsapp_live_inbound_receipt\([\s\S]*?FROM r72_whatsapp_live_webhook_command/u);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION app_private\.record_whatsapp_live_inbound_projection\([\s\S]*?TO r72_whatsapp_live_webhook_command/u);
  assert.match(migration, /'inbox\.whatsapp\.reply_received'/u);
  assert.match(migration, /'Call lead after verified Meta WhatsApp reply'/u);
});

test('0055 provides a four-rail sanitised evidence boundary and keeps social DMs blocked', () => {
  assert.match(migration, /CREATE FUNCTION app_private\.property_predator_live_channel_truth\(\)/u);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION app_private\.property_predator_live_channel_truth\(\)[\s\S]*?TO r72_web/u);
  for (const rail of ['customer_email', 'owned_social', 'whatsapp', 'social_dm']) {
    assert.match(migration, new RegExp(`rail := '${rail}'`));
  }
  assert.match(migration, /blocker_codes := ARRAY\['LIVE_ADAPTER_NOT_COMPOSED'\]/u);
  assert.match(migration, /daily_limit := 10;[\s\S]*?monthly_limit := 50;/u);
  assert.match(migration, /daily_limit := 1;[\s\S]*?monthly_limit := 3;/u);
});

test('0055 closes default PUBLIC execution and temporary schema creation', () => {
  assert.match(migration, /REVOKE CREATE ON SCHEMA app_private[\s\S]*?FROM r72_operational_inbox_definer, r72_whatsapp_live_definer/u);
  assert.match(migration, /REVOKE ALL ON FUNCTION app_private\.property_predator_live_channel_truth\(\)[\s\S]*?FROM PUBLIC/u);
  assert.match(migration, /DO \$capability_audit\$/u);
  assert.match(migration, /Unsafe operational inbox table capability/u);
});
