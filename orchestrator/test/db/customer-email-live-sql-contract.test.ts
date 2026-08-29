import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../src/db/migrations/0054_property_predator_customer_email_live_foundation.sql',
  import.meta.url,
);
const sql = await readFile(migrationUrl, 'utf8');

test('0054 creates audited table-blind roles before assuming r72_owner', () => {
  assert.ok(sql.indexOf('DO $roles$') < sql.indexOf('SET LOCAL ROLE r72_owner'));
  for (const role of [
    'r72_customer_email_command', 'r72_customer_email_worker_command',
    'r72_customer_email_webhook_command', 'r72_customer_email_definer',
  ]) assert.match(sql, new RegExp(`${role}[\\s\\S]{0,320}NOT rolcreaterole`, 'u'));
  assert.match(sql, /capability_audit[\s\S]*has_table_privilege/u);
  assert.doesNotMatch(sql,
    /GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE)[\s\S]{0,100}TO\s+r72_customer_email_(?:command|worker_command|webhook_command)/iu);
});

test('0054 binds exact campaign, approval, delivery, endpoint, consent and operator scope evidence', () => {
  for (const fragment of [
    'campaign_template_version_id uuid NOT NULL',
    'campaign_definition_sha256 bytea NOT NULL',
    'campaign_approval_request_id uuid NOT NULL',
    'campaign_approval_decision_id uuid NOT NULL',
    'message_delivery_id uuid NOT NULL',
    'message_version_id uuid NOT NULL',
    'message_approval_request_id uuid NOT NULL',
    'message_approval_decision_id uuid NOT NULL',
    'message_subject_sha256 bytea NOT NULL',
    'contact_point_id uuid NOT NULL', 'channel_endpoint_id uuid NOT NULL',
    'endpoint_identity_sha256 bytea NOT NULL', 'consent_event_id uuid NOT NULL',
    "lawful_basis text NOT NULL CHECK (lawful_basis IN ('consent', 'legitimate_interests'))",
    "pecr_decision text NOT NULL CHECK (pecr_decision = 'eligible')",
    "operator_instigator_decision text NOT NULL CHECK (operator_instigator_decision = 'eligible')",
    'action_scope_sha256 bytea NOT NULL',
  ]) assert.ok(sql.includes(fragment), `missing ${fragment}`);
  assert.match(sql, /campaign_decision\.decision = 'approved'/u);
  assert.match(sql, /message_decision\.decision = 'approved'/u);
  assert.match(sql, /consent\.state = 'granted'/u);
  assert.match(sql, /suppression\.state = 'suppressed'/u);
  assert.match(sql, /valid_until[\s\S]*interval '15 minutes'/u);
});

test('0054 enforces deterministic idempotency, one-recipient jobs and serialized 10/50 caps', () => {
  assert.match(sql, /UNIQUE \(workspace_id, idempotency_key_sha256\)/u);
  assert.match(sql, /Customer email idempotency conflict/u);
  assert.match(sql, /propertypredator\.customer-email-live\/v1[\s\S]*expected_request_sha/u);
  assert.match(sql, /pg_advisory_xact_lock[\s\S]*pp-customer-email/u);
  assert.match(sql, /day_count >= 10 OR month_count >= 50/u);
  assert.match(sql, /day_count BETWEEN 1 AND 10 AND month_count BETWEEN 1 AND 50/u);
  assert.match(sql, /recipient_sha256 bytea NOT NULL/u);
  assert.doesNotMatch(sql, /recipients\s+(?:jsonb|text\[\])/iu);
});

test('0054 has durable leases, pre-call revalidation and outcome-unknown quarantine', () => {
  assert.match(sql, /LIMIT 1 FOR UPDATE OF job SKIP LOCKED/u);
  assert.match(sql, /lease_token_sha256 bytea NOT NULL/u);
  assert.match(sql, /state = 'calling'/u);
  assert.match(sql, /NOT p_provider_effects_enabled OR NOT p_email_delivery_enabled/u);
  assert.match(sql, /p_emergency_paused/u);
  assert.match(sql, /recovered\.state = 'leased'[\s\S]*'queued'[\s\S]*'needs_attention'/u);
  assert.match(sql, /event_kind = 'outcome_unknown'|ELSE 'outcome_unknown'/u);
  assert.match(sql, /state = 'needs_attention'/u);
  assert.match(sql, /latest\.purpose IS NOT DISTINCT FROM suppression\.purpose/u);
});

test('0054 correlates only pre-verified signed Mailgun receipts and keeps evidence append-only', () => {
  assert.match(sql, /record_customer_email_signed_receipt/u);
  assert.match(sql, /FROM app\.mailgun_webhook_events/u);
  assert.match(sql, /job\.message_delivery_id = event\.message_delivery_id/u);
  assert.match(sql, /job\.recipient_sha256 = event\.recipient_identity_sha256/u);
  assert.match(sql, /RETURN 'replayed'/u);
  assert.match(sql, /customer_email_receipts_immutable BEFORE UPDATE OR DELETE/u);
  assert.match(sql, /customer_email_authorities_immutable BEFORE UPDATE OR DELETE/u);
  const tables = sql.slice(sql.indexOf('CREATE TABLE app.property_predator_customer_email_authorities'),
    sql.indexOf('CREATE INDEX property_predator_customer_email_jobs_claim_idx'));
  assert.doesNotMatch(tables,
    /\b(?:api_key|sending_key|password|secret|recipient|email_address|body_text)\s+(?:text|bytea)/iu);
});

test('0054 forces RLS on every new table and gives the definer current-workspace policies', () => {
  for (const table of ['authorities', 'jobs', 'job_leases', 'receipts']) {
    const full = `app.property_predator_customer_email_${table}`;
    assert.ok(sql.includes(`ALTER TABLE ${full} ENABLE ROW LEVEL SECURITY`));
    assert.ok(sql.includes(`ALTER TABLE ${full} FORCE ROW LEVEL SECURITY`));
  }
  assert.match(sql, /'provider_connections'[\s\S]*'communication_consent_events'[\s\S]*'communication_suppression_events'/u);
  assert.match(sql, /'customer_email_' \|\| table_name \|\| '_select'/u);
  assert.match(sql, /workspace_id = nullif\(current_setting\('app\.workspace_id'/u);
});
