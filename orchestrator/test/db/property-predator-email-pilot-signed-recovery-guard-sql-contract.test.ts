import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../src/db/migrations/0045_property_predator_email_pilot_signed_recovery_guard.sql',
  import.meta.url,
);

async function migration(): Promise<string> {
  return (await readFile(migrationUrl, 'utf8')).replace(/\r\n?/g, '\n');
}

test('0045 preserves reservation evidence while admitting only terminal signed recovery', async () => {
  const sql = await migration();
  assert.match(
    sql,
    /CREATE OR REPLACE FUNCTION app_private\.guard_property_predator_email_pilot_reservation_update\(\)/,
  );
  for (const field of [
    'workspace_id',
    'provider_connection_id',
    'operation_id',
    'message_delivery_id',
    'idempotency_key_sha256',
    'request_sha256',
    'message_version_id',
    'approval_request_id',
    'approval_decision_id',
    'approved_content_sha256',
    'control_event_id',
    'recipient_evidence',
    'requested_messages',
    'estimated_spend_usd_micros',
    'runtime_provider_effects_enabled',
    'runtime_email_delivery_enabled',
    'runtime_emergency_paused',
    'authorized_at',
  ]) {
    assert.match(sql, new RegExp(`NEW\\.${field} IS DISTINCT FROM OLD\\.${field}`));
  }
  assert.match(
    sql,
    /OLD\.state IN \('pending', 'needs_attention'\)[\s\S]*NEW\.state IN \('accepted', 'succeeded', 'failed'\)/,
  );
  assert.doesNotMatch(
    sql,
    /OLD\.state IN \('pending', 'needs_attention'\)[\s\S]*NEW\.state IN \([^)]*pending/,
  );
  assert.match(
    sql,
    /current_user IS DISTINCT FROM 'r72_mailgun_worker_definer'/,
  );
  assert.match(sql, /NEW\.cancellation_reason IS DISTINCT FROM OLD\.cancellation_reason/);
  assert.match(sql, /NEW\.provider_external_id IS NULL/);
  assert.match(sql, /NEW\.provider_occurred_at IS NULL/);
  assert.match(sql, /NEW\.provider_retryable IS DISTINCT FROM false/);
  assert.match(sql, /NEW\.settled_at < OLD\.settled_at/);
  assert.match(sql, /NEW\.provider_error_code IS DISTINCT FROM 'mailgun\.permanent'/);
  assert.match(sql, /Signed Mailgun webhook reconciled the ambiguous call/);
  assert.match(sql, /Signed Mailgun webhook confirmed a permanent delivery failure/);
});

test('0045 retains one-shot calling settlement and does not bypass the trigger', async () => {
  const sql = await migration();
  assert.match(sql, /IF OLD\.state = 'calling'[\s\S]*IF NEW\.state = 'calling'/);
  assert.match(
    sql,
    /REVOKE ALL ON FUNCTION app_private\.guard_property_predator_email_pilot_reservation_update\(\)\s+FROM PUBLIC/,
  );
  assert.doesNotMatch(sql, /DISABLE TRIGGER|DROP TRIGGER|session_replication_role/i);
  assert.doesNotMatch(sql, /GRANT (?:SELECT|INSERT|UPDATE|DELETE|TRUNCATE)/);
});
