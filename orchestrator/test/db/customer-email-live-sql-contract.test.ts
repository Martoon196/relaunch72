import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../src/db/migrations/0054_property_predator_customer_email_live_foundation.sql',
  import.meta.url,
);
const sql = await readFile(migrationUrl, 'utf8');
const compact = (value: string): string => value.replace(/\s+/gu, ' ').trim();

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

test('0054 exposes one exact server-derived enqueue interface with queued/replayed truth', () => {
  const declaration = sql.match(
    /CREATE FUNCTION app_private\.authorize_and_enqueue_customer_email_live_job\(([\s\S]*?)\) RETURNS TABLE \(job_id uuid, disposition text\)/u,
  );
  assert.ok(declaration);
  assert.equal(compact(declaration[1] ?? ''), compact(`
    p_workspace_id uuid, p_provider_connection_id uuid,
    p_campaign_template_version_id uuid, p_campaign_template_step_id uuid,
    p_campaign_step_content_sha256 bytea, p_campaign_approval_request_id uuid,
    p_campaign_approval_decision_id uuid, p_message_version_id uuid,
    p_message_approval_request_id uuid, p_message_approval_decision_id uuid,
    p_channel_endpoint_id uuid, p_consent_event_id uuid,
    p_compliance_subject_id uuid, p_policy_publication_event_id uuid,
    p_pecr_sender_decision_event_id uuid, p_pecr_instigator_decision_event_id uuid,
    p_permission_use_receipt_id uuid, p_authority_valid_until timestamptz,
    p_provider_operation_id uuid, p_message_delivery_id uuid,
    p_correlation_id uuid, p_idempotency_key_sha256 bytea, p_request_sha256 bytea
  `));
  assert.match(sql, /RETURN QUERY SELECT existing\.id, 'replayed'::text/u);
  assert.match(sql, /RETURN QUERY SELECT selected_job_id, 'queued'::text/u);
  assert.doesNotMatch(declaration[1] ?? '', /contact_id|contact_point_id|recipient|pecr_evidence|operator_instigator|action_scope/u);
});

test('0054 atomically creates the only admitted live operation and delivery', () => {
  const enqueueStart = sql.indexOf(
    'CREATE FUNCTION app_private.authorize_and_enqueue_customer_email_live_job',
  );
  const enqueue = sql.slice(enqueueStart, sql.indexOf('SET LOCAL ROLE r72_owner', enqueueStart));
  const operationInsert = enqueue.indexOf('INSERT INTO app.provider_operations');
  const deliveryInsert = enqueue.indexOf('INSERT INTO app.message_deliveries');
  const operationReserve = enqueue.indexOf("state = 'reconciliation_required'");
  const messageCommit = enqueue.indexOf("lifecycle = 'committed'");
  const authorityInsert = enqueue.indexOf('INSERT INTO app.property_predator_customer_email_authorities');
  const jobInsert = enqueue.indexOf('INSERT INTO app.property_predator_customer_email_jobs');
  assert.ok(operationInsert < deliveryInsert && deliveryInsert < operationReserve);
  assert.ok(operationReserve < messageCommit && messageCommit < authorityInsert && authorityInsert < jobInsert);
  assert.match(enqueue, /'customer-email-live:' \|\| pg_catalog\.encode\(p_idempotency_key_sha256, 'hex'\)/u);
  assert.match(sql, /current_user = 'r72_customer_email_definer'[\s\S]*NEW\.idempotency_key ~ '\^customer-email-live:\[0-9a-f\]\{64\}\$'/u);
  assert.match(sql, /current_user = 'r72_mailgun_worker_definer'/u);
  assert.match(sql, /CREATE POLICY customer_email_provider_operations_insert/u);
  assert.match(sql, /CREATE POLICY customer_email_message_deliveries_insert/u);
});

test('0054 binds exact campaign step content to the approved email subject and body', () => {
  for (const fragment of [
    'campaign_template_step_id uuid NOT NULL', 'campaign_step_content_sha256 bytea NOT NULL',
    'campaign_definition_sha256 bytea NOT NULL', 'campaign_approval_request_id uuid NOT NULL',
    'campaign_approval_decision_id uuid NOT NULL', 'message_version_id uuid NOT NULL',
    'message_approval_request_id uuid NOT NULL', 'message_approval_decision_id uuid NOT NULL',
    'message_subject_sha256 bytea NOT NULL', 'endpoint_identity_sha256 bytea NOT NULL',
    'consent_event_id uuid NOT NULL', 'sender_endpoint_normalized_address text NOT NULL',
  ]) assert.ok(sql.includes(fragment), `missing ${fragment}`);
  assert.match(sql, /step\.content_sha256 = p_campaign_step_content_sha256/u);
  assert.match(sql, /step\.requires_human_approval AND step\.requires_current_permission/u);
  assert.match(sql, /NOT step\.provider_effects/u);
  assert.match(sql, /conversation\.subject = selected_campaign_subject/u);
  assert.match(sql, /message_version\.body_text = selected_campaign_body/u);
  assert.match(sql, /campaign_step\.content_sha256 = authority\.campaign_step_content_sha256/u);
  assert.match(sql, /conversation\.subject = campaign_step\.subject_template/u);
  assert.match(sql, /message_version\.body_text = campaign_step\.body_template/u);
  assert.match(sql, /message\.lifecycle = 'committed'/u);
});

test('0054 snapshots and re-proves the exact canonical Mailgun sending domain', () => {
  assert.match(sql,
    /sender_endpoint_normalized_address text NOT NULL CHECK \(\s*sender_endpoint_normalized_address = 'mg\.propertypredator\.com'\s*\)/u);
  const guardStart = sql.indexOf(
    'CREATE OR REPLACE FUNCTION app_private.guard_property_predator_email_live_delivery',
  );
  const guard = sql.slice(guardStart, sql.indexOf('CREATE TABLE', guardStart));
  assert.match(guard, /current_user = 'r72_customer_email_definer'[\s\S]*endpoint\.id = NEW\.channel_endpoint_id/u);
  assert.match(guard, /endpoint\.address = 'mg\.propertypredator\.com'[\s\S]*endpoint\.normalized_address = 'mg\.propertypredator\.com'/u);

  const enqueueStart = sql.indexOf(
    'CREATE FUNCTION app_private.authorize_and_enqueue_customer_email_live_job',
  );
  const enqueue = sql.slice(enqueueStart, sql.indexOf('SET LOCAL ROLE r72_owner', enqueueStart));
  assert.match(enqueue,
    /SELECT message\.contact_id, message\.contact_point_id, endpoint\.id,\s*endpoint\.normalized_address,/u);
  assert.match(enqueue, /endpoint\.address = 'mg\.propertypredator\.com'[\s\S]*endpoint\.normalized_address = 'mg\.propertypredator\.com'/u);
  assert.match(enqueue,
    /expected_action_scope := public\.digest\(format\([\s\S]*p_provider_connection_id, selected_sender_domain,\s*p_campaign_template_version_id/u);
  assert.match(enqueue,
    /contact_point_id, channel_endpoint_id, sender_endpoint_normalized_address,\s*recipient_sha256[\s\S]*selected_channel_endpoint_id, selected_sender_domain,\s*selected_recipient_sha/u);

  const beginStart = sql.indexOf('CREATE FUNCTION app_private.begin_customer_email_live_call');
  const begin = sql.slice(beginStart, sql.indexOf('CREATE FUNCTION', beginStart + 1));
  const loadStart = sql.indexOf('CREATE FUNCTION app_private.load_customer_email_live_job');
  const load = sql.slice(loadStart, sql.indexOf('REVOKE ALL ON FUNCTION', loadStart));
  for (const boundary of [begin, load]) {
    assert.match(boundary,
      /endpoint\.address = authority\.sender_endpoint_normalized_address[\s\S]*endpoint\.normalized_address = authority\.sender_endpoint_normalized_address/u);
    assert.match(boundary,
      /authority\.sender_endpoint_normalized_address = 'mg\.propertypredator\.com'/u);
    assert.match(boundary,
      /authority\.action_scope_sha256 = public\.digest\(format\([\s\S]*authority\.sender_endpoint_normalized_address/u);
  }
  assert.match(load,
    /RETURNS TABLE \(\s*provider_connection_id uuid, sending_domain text,/u);
  assert.match(load,
    /SELECT job\.provider_connection_id, authority\.sender_endpoint_normalized_address,/u);
});

test('0054 re-proves durable PECR, operator and permission evidence at enqueue and call', () => {
  for (const fragment of [
    'compliance_subject_id uuid NOT NULL', 'policy_publication_event_id uuid NOT NULL',
    'pecr_sender_decision_event_id uuid NOT NULL',
    'pecr_instigator_decision_event_id uuid NOT NULL',
    'permission_use_receipt_id uuid NOT NULL', "permission_use.permission = 'email.send'",
    "permission_use.eligibility_decision = 'allow'", "permission_use.use_state = 'consumed'",
    'permission_use.provider_effects IS FALSE', "operator_membership.status = 'active'",
    "operator_membership.role IN ('owner', 'admin')",
  ]) assert.ok(sql.includes(fragment), `missing ${fragment}`);
  assert.match(sql, /sender_route\.decision_kind = 'pecr_sender_route'/u);
  assert.match(sql, /instigator_route\.decision_kind = 'pecr_instigator_route'/u);
  assert.match(sql, /successor\.supersedes_event_id = sender_route\.id/u);
  assert.match(sql, /successor\.supersedes_event_id = instigator_route\.id/u);
  assert.match(sql, /block\.permission_state IN \('blocked', 'revoked', 'expired'\)/u);
  assert.match(sql, /block\.action_scope_sha256 = authority\.action_scope_sha256/u);
});

test('0054 request digest binds every fresh ID, immutable hash and derived recipient fact', () => {
  const digestStart = sql.indexOf('expected_request_sha := public.digest');
  const digestEnd = sql.indexOf("), 'sha256');", digestStart);
  assert.ok(digestStart > 0 && digestEnd > digestStart);
  const digest = sql.slice(digestStart, digestEnd);
  const orderedTokens = [
    "'propertypredator.customer-email-live/v1'", 'p_workspace_id::text',
    'p_provider_connection_id::text', 'selected_sender_domain',
    'p_campaign_template_version_id::text',
    "pg_catalog.encode(selected_campaign_sha, 'hex')", 'p_campaign_template_step_id::text',
    "pg_catalog.encode(selected_campaign_step_sha, 'hex')", 'p_campaign_approval_request_id::text',
    'p_campaign_approval_decision_id::text', 'selected_message_version_id::text',
    "pg_catalog.encode(selected_message_body_sha, 'hex')", 'selected_message_approval_request_id::text',
    'selected_message_approval_decision_id::text', 'selected_channel_endpoint_id::text',
    'p_consent_event_id::text', 'p_compliance_subject_id::text',
    'p_policy_publication_event_id::text', 'p_pecr_sender_decision_event_id::text',
    'p_pecr_instigator_decision_event_id::text', 'p_permission_use_receipt_id::text',
    'p_authority_valid_until AT TIME ZONE',
    'p_provider_operation_id::text', 'p_message_delivery_id::text',
    'p_correlation_id::text', "pg_catalog.encode(p_idempotency_key_sha256, 'hex')",
    'selected_contact_id::text', 'selected_contact_point_id::text',
    "pg_catalog.encode(selected_recipient_sha, 'hex')",
    "pg_catalog.encode(selected_message_subject_sha, 'hex')",
    "pg_catalog.encode(selected_endpoint_sha, 'hex')", 'selected_purpose',
    "pg_catalog.encode(expected_action_scope, 'hex')", 'selected_user::text',
    'selected_request_id',
  ];
  let cursor = -1;
  for (const token of orderedTokens) {
    const next = digest.indexOf(token, cursor + 1);
    assert.ok(next > cursor, `request digest is missing or misorders ${token}`);
    cursor = next;
  }
  assert.match(sql, /'email:%s:%s:%s:%s:%s:%s:%s:%s:%s:%s'/u);
  assert.match(sql, /p_authority_valid_until IS DISTINCT FROM[\s\S]*date_trunc\('milliseconds', p_authority_valid_until\)/u);
  assert.match(digest, /'YYYY-MM-DD"T"HH24:MI:SS\.MS"Z"'/u);
});

test('0054 serializes deterministic idempotency and 10/day, 50/month caps', () => {
  assert.match(sql, /UNIQUE \(workspace_id, idempotency_key_sha256\)/u);
  assert.match(sql, /Customer email idempotency conflict/u);
  assert.match(sql, /pg_advisory_xact_lock[\s\S]*pp-customer-email/u);
  assert.match(sql, /day_count >= 10 OR month_count >= 50/u);
  assert.match(sql, /day_count BETWEEN 1 AND 10 AND month_count BETWEEN 1 AND 50/u);
  assert.match(sql, /recipient_sha256 bytea NOT NULL/u);
  assert.doesNotMatch(sql, /recipients\s+(?:jsonb|text\[\])/iu);
});

test('0054 fences the provider reference before calling and quarantines unknown outcomes', () => {
  assert.match(sql, /provider_reference = selected\.expected_message_id/u);
  assert.match(sql, /provider_operation\.provider_reference IS NULL/u);
  assert.match(sql, /worker-timeout:%s:%s/u);
  assert.match(sql, /receipt-timeout:%s/u);
  assert.match(sql, /'outcome_unknown'/u);
  assert.match(sql, /public\.digest\(timeout_event_id, 'sha256'\)/u);
  assert.match(sql, /ON CONFLICT \(workspace_id, provider_connection_id, external_event_id\)[\s\S]*DO NOTHING/u);
  assert.match(sql, /status = 'reconciliation_required'/u);
  assert.match(sql, /last_summary = 'Customer email provider outcome is unknown; manual reconciliation required'/u);
  assert.match(sql, /provider_reference = coalesce\(p_external_id, selected\.expected_message_id\)/u);
});

test('0054 consumes only exact signed Mailgun events with monotonic replay-safe projection', () => {
  const declaration = sql.match(
    /CREATE FUNCTION app_private\.record_customer_email_signed_receipt\(([^)]*)\) RETURNS text/u,
  );
  assert.ok(declaration);
  assert.equal(compact(declaration[1] ?? ''),
    'p_workspace_id uuid, p_provider_connection_id uuid, p_external_event_id text');
  assert.match(sql, /FROM app\.mailgun_webhook_events AS event/u);
  assert.match(sql, /event\.external_event_id = p_external_event_id/u);
  assert.match(sql, /job\.operation_id = selected_event\.provider_operation_id/u);
  assert.match(sql, /job\.message_delivery_id = selected_event\.message_delivery_id/u);
  assert.match(sql, /job\.recipient_sha256 = selected_event\.recipient_identity_sha256/u);
  assert.match(sql, /RETURN 'not_applicable'/u);
  assert.match(sql, /RETURN 'replayed'/u);
  assert.match(sql, /WHEN selected_job\.state = 'failed' THEN 'failed' ELSE 'succeeded'/u);
  assert.match(sql, /WHEN selected_job\.state IN \('succeeded', 'failed'\) THEN selected_job\.state/u);
  assert.match(sql, /receipt\.mailgun_webhook_event_id IS NOT NULL[\s\S]*RETURN;/u);
  assert.match(sql, /customer_email_receipts_immutable BEFORE UPDATE OR DELETE/u);
  assert.match(sql, /customer_email_authorities_immutable BEFORE UPDATE OR DELETE/u);
});

test('0054 grants only readiness and the write-path portal-session lock to login roles', () => {
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app_private\.runtime_schema_migrations\(\),[\s\S]*app_private\.runtime_database_installation_id\(\)[\s\S]*TO r72_customer_email_command, r72_customer_email_worker_command,[\s\S]*r72_customer_email_webhook_command/u);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app_private\.lock_active_portal_session\(bytea, uuid, uuid\)[\s\S]*TO r72_customer_email_command/u);
  assert.doesNotMatch(sql, /GRANT EXECUTE ON FUNCTION[\s\S]{0,200}app_private\.active_portal_session\(bytea, uuid, uuid\)[\s\S]{0,100}r72_customer_email_command/u);
});

test('0054 forces RLS on new and dependency tables without an unused contacts grant', () => {
  for (const table of ['authorities', 'jobs', 'job_leases', 'receipts']) {
    const full = `app.property_predator_customer_email_${table}`;
    assert.ok(sql.includes(`ALTER TABLE ${full} ENABLE ROW LEVEL SECURITY`));
    assert.ok(sql.includes(`ALTER TABLE ${full} FORCE ROW LEVEL SECURITY`));
  }
  assert.match(sql, /'campaign_template_steps'/u);
  assert.match(sql, /'property_predator_email_pilot_approved_content'/u);
  assert.match(sql, /workspace_id = nullif\(current_setting\('app\.workspace_id'/u);
  assert.doesNotMatch(sql, /\bapp\.contacts\b|'contacts'/u);
  const tables = sql.slice(sql.indexOf('CREATE TABLE app.property_predator_customer_email_authorities'),
    sql.indexOf('CREATE INDEX property_predator_customer_email_jobs_claim_idx'));
  assert.doesNotMatch(tables,
    /\b(?:api_key|sending_key|password|secret|recipient|email_address|body_text)\s+(?:text|bytea)/iu);
});
