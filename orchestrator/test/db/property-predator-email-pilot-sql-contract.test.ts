import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../src/db/migrations/0025_property_predator_email_pilot_boundary.sql',
  import.meta.url,
);
const webhookMigrationUrl = new URL(
  '../../src/db/migrations/0024_mailgun_webhook_evidence.sql',
  import.meta.url,
);

async function migration(): Promise<string> {
  return (await readFile(migrationUrl, 'utf8')).replace(/\r\n?/g, '\n');
}

test('0025 exposes a dedicated table-blind Mailgun worker command identity', async () => {
  const sql = await migration();
  assert.match(sql, /'r72_mailgun_worker_definer', false/);
  assert.match(sql, /'r72_mailgun_worker_command', true/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app_private\.authorize_property_predator_email_pilot/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app_private\.cancel_property_predator_email_pilot_before_call/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app_private\.settle_property_predator_email_pilot_call/);
  assert.match(sql, /property_predator_email_pilot_boundary_ready/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app_private\.runtime_schema_migrations\(\)/);
  assert.match(sql, /has_table_privilege\(session_user, relation\.oid, 'SELECT'\)/);
  assert.match(sql, /has_function_privilege\(session_user, procedure\.oid, 'EXECUTE'\)/);
  assert.match(sql, /procedure\.proconfig = ARRAY\['search_path=pg_catalog'\]::text\[\]/);
  assert.match(sql, /installation_oid IS NULL OR EXISTS[\s\S]*owner_role\.rolname = 'r72_security_definer'/);
  assert.match(sql, /installation_oid IS NULL OR procedure\.oid <> installation_oid/);
  assert.doesNotMatch(sql, /GRANT (?:SELECT|INSERT|UPDATE|DELETE)[^;]*TO r72_mailgun_worker_command/);
});

test('0025 authorizes atomically against current immutable production evidence', async () => {
  const sql = await migration();
  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /operation\.idempotency_key = 'mailgun-pilot:'[\s\S]*'operation_conflict'/);
  assert.match(sql, /provider_id = 'mailgun_eu'/);
  assert.match(sql, /environment = 'live'/);
  assert.match(sql, /decision\.decision = 'approved'/);
  assert.match(sql, /message_approval_decisions_capture_pilot_content/);
  assert.match(sql, /property_predator_email_pilot_approved_content/);
  assert.match(sql, /message\.current_version_id = version\.id/);
  assert.match(sql, /consent\.id = \(\s*SELECT current_consent\.id/);
  assert.match(sql, /current_suppression\.purpose IS NOT DISTINCT FROM suppression\.purpose/);
  assert.match(sql, /seed\.state = 'owned'/);
  assert.match(sql, /runtime_provider_effects_enabled/);
  assert.match(sql, /runtime_email_delivery_enabled/);
  assert.match(sql, /runtime_emergency_paused/);
});

test('0025 pins the subject at approval and blocks any post-approval subject mutation', async () => {
  const sql = await migration();
  const captureStart = sql.indexOf('CREATE FUNCTION app_private.capture_property_predator_email_pilot_approved_content');
  const authorizeStart = sql.indexOf('CREATE FUNCTION app_private.authorize_property_predator_email_pilot');
  const cancelStart = sql.indexOf('CREATE FUNCTION app_private.cancel_property_predator_email_pilot_before_call');
  const capture = sql.slice(captureStart, authorizeStart);
  const authorize = sql.slice(authorizeStart, cancelStart);
  assert.match(capture, /conversation\.subject/);
  assert.match(capture, /approved_content_sha256/);
  assert.match(authorize, /pilot_approval\.approved_content_sha256 = p_approved_content_sha256/);
  assert.match(
    authorize,
    /pilot_approval\.subject_sha256 = public\.digest\(conversation\.subject, 'sha256'\)/,
  );
  assert.doesNotMatch(authorize, /to_json\([^)]*subject/);
});

test('0025 rejects inflated runtime caps and understated per-recipient cost', async () => {
  const sql = await migration();
  assert.match(sql, /p_max_messages_per_run <> selected_control\.run_message_cap/);
  assert.match(sql, /p_max_messages_per_month <> selected_control\.monthly_message_cap/);
  assert.match(sql, /p_max_spend_per_run <> selected_control\.run_spend_cap_usd_micros/);
  assert.match(sql, /p_max_spend_per_month <> selected_control\.monthly_spend_cap_usd_micros/);
  assert.match(sql, /p_estimated_spend_usd_micros\s*<> p_requested_messages::bigint\s*\* selected_control\.estimated_recipient_cost_usd_micros::bigint/);
  assert.match(sql, /'operator_policy_mismatch'/);
  assert.match(sql, /run_messages > selected_control\.run_message_cap/);
  assert.doesNotMatch(sql, /run_messages > p_max_messages_per_run/);
});

test('0025 creates one canonical delivery that 0024 can correlate after acceptance', async () => {
  const sql = await migration();
  const ingress = await readFile(webhookMigrationUrl, 'utf8');
  assert.match(sql, /'single_recipient_required'/);
  assert.ok(
    sql.indexOf("'single_recipient_required'") < sql.indexOf('INSERT INTO app.provider_operations'),
    'multi-recipient input must stop before durable delivery creation',
  );
  assert.match(sql, /INSERT INTO app\.provider_operations/);
  assert.match(sql, /INSERT INTO app\.message_deliveries/);
  assert.match(sql, /message_delivery_id, correlation_id/);
  assert.match(sql, /provider_reference = p_external_id/);
  assert.match(sql, /WHEN p_status IN \('accepted', 'succeeded'\) THEN 'accepted'/);
  assert.match(ingress, /operation\.provider_reference IN \(/);
  assert.match(ingress, /delivery\.provider_operation_id = operation\.id/);
  assert.match(ingress, /public\.digest\(lower\(point\.normalized_value\), 'sha256'\)\s*= p_recipient_identity_sha256/);
});

test('0025 reserves both caps before calling and never refunds ambiguous outcomes', async () => {
  const sql = await migration();
  assert.match(sql, /p_utc_month <> date_trunc\(\s*'month', statement_timestamp\(\) AT TIME ZONE 'UTC'\s*\)::date/);
  assert.match(sql, /property_predator_email_pilot_run_usage/);
  assert.match(sql, /property_predator_email_pilot_month_usage/);
  assert.match(sql, /'run_message_cap'/);
  assert.match(sql, /'month_message_cap'/);
  assert.match(sql, /'run_spend_cap'/);
  assert.match(sql, /'month_spend_cap'/);
  assert.match(sql, /'ambiguous_outcome'/);
  assert.match(sql, /needs_attention is an\s*-- ambiguous outcome/);
  assert.match(sql, /SET state = 'cancelled'/);
});

test('0025 makes controls, seed attestations and reservation evidence immutable', async () => {
  const sql = await migration();
  assert.match(sql, /controls_append_only/);
  assert.match(sql, /seeds_append_only/);
  assert.match(sql, /reservation evidence is immutable/);
  for (const table of [
    'property_predator_email_pilot_control_events',
    'property_predator_email_pilot_seed_events',
    'property_predator_email_pilot_approved_content',
    'property_predator_email_pilot_run_usage',
    'property_predator_email_pilot_month_usage',
    'property_predator_email_pilot_reservations',
  ]) {
    assert.match(sql, new RegExp(`ALTER TABLE app\\.${table} FORCE ROW LEVEL SECURITY`));
    assert.match(sql, new RegExp(`\\('app', '${table}', 'workspace_id'\\)`));
  }
});
