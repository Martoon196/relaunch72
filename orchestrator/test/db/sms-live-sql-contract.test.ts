import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../src/db/migrations/0056_property_predator_twilio_sms_live_foundation.sql',
  import.meta.url,
);
const sql = await readFile(migrationUrl, 'utf8');

test('0056 installs table-blind least-privilege SMS command identities', () => {
  assert.ok(sql.indexOf('DO $roles$') < sql.indexOf('SET LOCAL ROLE r72_owner'));
  for (const role of [
    'r72_sms_command', 'r72_sms_worker_command',
    'r72_sms_webhook_command', 'r72_sms_definer',
  ]) assert.match(sql, new RegExp(`${role}[\\s\\S]{0,450}NOT rolcreaterole`, 'u'));
  assert.match(sql, /capability_audit[\s\S]*has_table_privilege/u);
  assert.doesNotMatch(sql,
    /GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE)[\s\S]{0,100}TO\s+r72_sms_(?:command|worker_command|webhook_command)/iu);
  assert.match(sql, /REVOKE CREATE ON SCHEMA app_private[\s\S]*r72_sms_definer/u);
});

test('0056 exposes distinct command, worker and signed-webhook capabilities only', () => {
  assert.match(sql, /authorize_and_enqueue_sms_live_job[\s\S]*TO r72_sms_command/u);
  for (const fn of ['claim_sms_live_job', 'load_sms_live_job',
    'begin_sms_live_call', 'settle_sms_live_call']) {
    assert.match(sql, new RegExp(`GRANT EXECUTE ON FUNCTION app_private\\.${fn}[\\s\\S]{0,400}TO r72_sms_worker_command`, 'u'));
  }
  for (const fn of ['record_sms_live_status_receipt', 'record_sms_live_inbound_projection']) {
    assert.match(sql, new RegExp(`GRANT EXECUTE ON FUNCTION app_private\\.${fn}[\\s\\S]{0,400}TO r72_sms_webhook_command`, 'u'));
  }
  assert.match(sql, /lock_active_portal_session\(bytea, uuid, uuid\)[\s\S]*TO r72_sms_command/u);
  assert.doesNotMatch(sql,
    /GRANT EXECUTE ON FUNCTION app_private\.active_portal_session\(bytea, uuid, uuid\)[\s\S]{0,100}TO r72_sms_command/u);
});

test('0056 binds one approved UK recipient to fresh consent and durable authority', () => {
  for (const fragment of [
    "provider_id = 'twilio_messaging'", "provider_kind = 'sms'",
    "capabilities @> '[\"sms.send\"]'::jsonb",
    "point.kind = 'phone'", "point.normalized_value ~ '^\\+44[0-9]{9,10}$'",
    "message.lifecycle = 'approved'", "decision.decision = 'approved'",
    'message_body_sha256 bytea NOT NULL', 'recipient_sha256 bytea NOT NULL',
    'endpoint_identity_sha256 bytea NOT NULL', 'consent_event_id uuid NOT NULL',
    'permission_use_receipt_id uuid NOT NULL', "permission_use.permission = 'sms.send'",
    "operator_membership.role IN ('owner', 'admin')",
  ]) assert.ok(sql.includes(fragment), `missing ${fragment}`);
  assert.match(sql, /latest_consent IS DISTINCT FROM NEW\.consent_event_id/u);
  assert.match(sql, /active_suppression IS NOT NULL/u);
  assert.match(sql, /recipient_sha256 bytea NOT NULL/u);
  assert.doesNotMatch(sql, /recipients\s+(?:jsonb|text\[\])/iu);
});

test('0056 enforces segment caps at enqueue and the final calling fence', () => {
  assert.match(sql, /segment_count integer NOT NULL CHECK \(segment_count BETWEEN 1 AND 10\)/u);
  assert.match(sql, /day_segments \+ selected_segment_count > 10[\s\S]*month_segments \+ selected_segment_count > 50/u);
  assert.match(sql, /day_segments BETWEEN selected\.segment_count AND 10[\s\S]*month_segments BETWEEN selected\.segment_count AND 50/u);
  assert.match(sql, /pg_advisory_xact_lock[\s\S]*pp-sms:%s:%s/u);
  assert.match(sql, /max_attempts[\s\S]*0, 1, 'user'/u);
  assert.match(sql, /state = 'calling'[\s\S]*provider_reference = 'twilio-sms-pending:'/u);
});

test('0056 quarantines unknown outcomes and requires signed monotonic reconciliation', () => {
  assert.match(sql, /Twilio SMS provider outcome is unknown; manual reconciliation required/u);
  assert.match(sql, /state = 'needs_attention'/u);
  assert.match(sql, /next_attempt_at = 'infinity'::timestamptz/u);
  assert.match(sql, /record_sms_live_status_receipt/u);
  assert.match(sql, /ON CONFLICT \(workspace_id, provider_connection_id, external_event_id\)/u);
  assert.match(sql, /sms_receipts_immutable BEFORE UPDATE OR DELETE/u);
  assert.match(sql, /sms_inbox_projections_immutable BEFORE UPDATE OR DELETE/u);
});

test('0056 projects signed inbound SMS and START cannot clear a non-Twilio suppression', () => {
  assert.match(sql, /record_sms_live_inbound_projection/u);
  assert.match(sql, /p_opt_evidence = 'stop'[\s\S]*'suppressed', 'twilio_stop', 'twilio\.webhook'/u);
  assert.match(sql, /p_opt_evidence = 'start'[\s\S]*latest_suppression\.reason = 'twilio_stop'[\s\S]*latest_suppression\.source = 'twilio\.webhook'/u);
  assert.match(sql, /INSERT INTO app\.messages/u);
  assert.match(sql, /INSERT INTO app\.tasks/u);
  assert.match(sql, /admin_call_origins/u);
  assert.match(sql, /property_predator_sms_inbox_projections/u);
});

test('0056 forces RLS on every SMS rail table and registers workspace ownership', () => {
  for (const table of ['authorities', 'jobs', 'job_leases', 'receipts', 'inbox_projections']) {
    const full = `app.property_predator_sms_${table}`;
    assert.ok(sql.includes(`ALTER TABLE ${full} ENABLE ROW LEVEL SECURITY`));
    assert.ok(sql.includes(`ALTER TABLE ${full} FORCE ROW LEVEL SECURITY`));
    assert.ok(sql.includes(`('app', 'property_predator_sms_${table}', 'workspace_id')`));
  }
});
