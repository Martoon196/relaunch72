import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../src/db/migrations/0053_property_predator_meta_whatsapp_live_foundation.sql',
  import.meta.url,
);
const sql = await readFile(migrationUrl, 'utf8');

test('0053 creates and audits least-privilege roles before assuming r72_owner', () => {
  assert.ok(sql.indexOf('DO $roles$') < sql.indexOf('SET LOCAL ROLE r72_owner'));
  for (const role of [
    'r72_whatsapp_live_command', 'r72_whatsapp_live_worker_command',
    'r72_whatsapp_live_webhook_command', 'r72_whatsapp_live_definer',
  ]) assert.match(sql, new RegExp(`${role}[\\s\\S]{0,300}NOT rolcreaterole`, 'u'));
  assert.match(sql, /REVOKE ALL ON ALL TABLES IN SCHEMA app FROM[\s\S]*r72_whatsapp_live_command/u);
  assert.match(sql, /capability_audit[\s\S]*has_table_privilege/u);
  assert.doesNotMatch(sql,
    /GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE)[\s\S]{0,100}TO\s+r72_whatsapp_live_(?:command|worker_command|webhook_command)/iu);
});

test('0053 stores AES-GCM envelopes bound to exact workspace, connection, WABA and phone', () => {
  for (const fragment of [
    "secret_algorithm text NOT NULL CHECK (secret_algorithm = 'aes-256-gcm-v1')",
    'secret_key_version text NOT NULL', 'secret_iv bytea NOT NULL',
    'secret_ciphertext bytea NOT NULL', 'secret_auth_tag bytea NOT NULL',
    'secret_aad_sha256 bytea NOT NULL', 'secret_payload_sha256 bytea NOT NULL',
    'app_id text NOT NULL', 'waba_id text NOT NULL', 'phone_number_id text NOT NULL',
    "graph_api_version text NOT NULL CHECK (graph_api_version = 'v24.0')",
  ]) assert.ok(sql.includes(fragment), `missing ${fragment}`);
  assert.match(sql,
    /propertypredator\.meta-whatsapp-live\/v1[\s\S]*workspaceId[\s\S]*connectionId[\s\S]*appId[\s\S]*wabaId[\s\S]*phoneNumberId/u);
  assert.doesNotMatch(sql,
    /\b(?:access_token|app_secret|verify_token|plaintext_token|plaintext_secret)\b\s+(?:text|bytea)/iu);
  assert.match(sql,
    /UNIQUE \(workspace_id, id, provider_connection_id\)[\s\S]*FOREIGN KEY \(workspace_id, binding_id, provider_connection_id\)/u);
  assert.match(sql, /predecessor_binding_id uuid/u);
  assert.match(sql, /property_predator_whatsapp_live_binding_revocations/u);
  assert.match(sql, /revocation_kind IN \('revoked', 'superseded'\)/u);
  assert.match(sql, /revoke_whatsapp_live_binding/u);
  assert.match(sql, /pp-whatsapp-call-fence/u);
  assert.match(sql, /binding successor is required/u);
});

test('0053 gives its definer exact tenant policies on every forced-RLS dependency', () => {
  for (const dependency of [
    'provider_connections', 'workspace_memberships', 'contact_points',
    'communication_consent_events', 'communication_suppression_events',
    'company_content_versions', 'company_content_approval_requests',
    'company_content_approval_decisions',
    'affiliate_compliance_policy_review_events',
    'affiliate_compliance_policy_publication_events',
    'affiliate_compliance_specialist_decision_events',
    'affiliate_compliance_permission_fact_events',
    'affiliate_compliance_permission_use_receipts',
  ]) {
    assert.match(sql, new RegExp(
      `ON (?:app|app_private)\\.${dependency}[\\s\\S]{0,140}FOR SELECT TO r72_whatsapp_live_definer[\\s\\S]{0,180}app\\.workspace_id`,
      'u',
    ), `missing exact RLS policy for ${dependency}`);
  }
});

test('0053 permits only one exact approved zero-parameter template with current consent and authority', () => {
  for (const fragment of [
    'content_version_id uuid NOT NULL', 'approval_request_id uuid NOT NULL',
    'approval_decision_id uuid NOT NULL',
    'parameter_count smallint NOT NULL CHECK (parameter_count = 0)',
    "provider_status text NOT NULL CHECK (provider_status = 'approved')",
    "pecr_decision text NOT NULL CHECK (pecr_decision = 'eligible')",
    "operator_instigator_decision text NOT NULL CHECK (operator_instigator_decision = 'eligible')",
    'consent_event_id uuid NOT NULL', 'action_scope_sha256 bytea NOT NULL',
  ]) assert.ok(sql.includes(fragment), `missing ${fragment}`);
  assert.match(sql, /decision\.decision = 'approved'/u);
  assert.match(sql, /consent\.state = 'granted'/u);
  assert.match(sql, /latest\.purpose = authority\.purpose/u);
  assert.match(sql, /suppression\.state = 'suppressed'/u);
  assert.match(sql, /latest\.purpose IS NOT DISTINCT FROM suppression\.purpose/u);
  assert.match(sql, /valid_until[\s\S]*interval '15 minutes'/u);
  const enqueue = sql.slice(
    sql.indexOf('CREATE FUNCTION app_private.authorize_and_enqueue_whatsapp_live_job'),
    sql.indexOf('CREATE FUNCTION app_private.whatsapp_live_authority_is_current'),
  );
  assert.doesNotMatch(enqueue, /p_pecr_evidence_sha256|p_operator_instigator_sha256/u);
  for (const evidence of [
    'p_policy_publication_event_id', 'p_pecr_sender_decision_event_id',
    'p_pecr_instigator_decision_event_id', 'p_permission_use_receipt_id',
    "legal_review.decision = 'approved'", "commercial_review.decision = 'approved'",
    "sender_route.decision_kind = 'pecr_sender_route'",
    "instigator_route.decision_kind = 'pecr_instigator_route'",
    "permission_use.permission = 'whatsapp.send'",
    "permission_use.eligibility_decision = 'allow'",
  ]) assert.ok(enqueue.includes(evidence), `missing durable evidence check ${evidence}`);
  assert.match(sql, /whatsapp_live_authority_is_current[\s\S]*connection\.status = 'active'/u);
  assert.match(sql, /claim_whatsapp_live_job[\s\S]*whatsapp_live_authority_is_current/u);
  assert.match(sql, /load_whatsapp_live_job[\s\S]*whatsapp_live_authority_is_current/u);
  assert.match(sql, /begin_whatsapp_live_call[\s\S]*whatsapp_live_authority_is_current/u);
});

test('0053 enforces one-recipient caps, idempotency, leases and ambiguous-outcome quarantine', () => {
  assert.match(sql, /UNIQUE \(workspace_id, idempotency_key_sha256\)/u);
  assert.match(sql, /WhatsApp live idempotency conflict/u);
  assert.match(sql, /utc_day[\s\S]*>= 1[\s\S]*utc_month[\s\S]*>= 3/u);
  assert.match(sql, /property_predator_whatsapp_live_jobs_daily_cap_uq/u);
  assert.match(sql, /pg_advisory_xact_lock[\s\S]*pp-whatsapp-live/u);
  assert.match(sql, /LIMIT 1 FOR UPDATE SKIP LOCKED/u);
  assert.match(sql, /state = 'calling'/u);
  assert.match(sql, /provider_effects_enabled boolean, p_emergency_paused boolean/u);
  assert.match(sql, /NOT p_provider_effects_enabled OR p_emergency_paused/u);
  assert.match(sql, /worker_whatsapp_outcome_unknown/u);
  assert.match(sql, /state = CASE WHEN recovered\.state = 'leased' THEN 'queued' ELSE 'needs_attention'/u);
});

test('0053 webhook receipts are replay-aware and retain hashes, never raw body or tokens', () => {
  assert.match(sql, /record_whatsapp_live_status/u);
  assert.match(sql, /record_whatsapp_live_inbound_receipt/u);
  assert.match(sql, /RETURN 'conflict'/u);
  assert.match(sql, /RETURN 'replayed'/u);
  assert.match(sql, /pg_advisory_xact_lock[\s\S]*pp-whatsapp-webhook/u);
  assert.match(sql, /recipient_or_sender_sha256 bytea NOT NULL/u);
  assert.match(sql, /body_sha256 bytea/u);
  assert.match(sql, /payload_sha256 bytea NOT NULL/u);
  const receiptTable = sql.slice(
    sql.indexOf('CREATE TABLE app.property_predator_whatsapp_live_receipts'),
    sql.indexOf('CREATE INDEX property_predator_whatsapp_live_jobs_claim_idx'),
  );
  assert.doesNotMatch(receiptTable, /\b(?:raw_body|body|message_text|access_token|app_secret|verify_token)\s+(?:text|bytea)/iu);
  assert.match(sql, /whatsapp_live_receipts_immutable BEFORE UPDATE OR DELETE/u);
  assert.match(sql, /p_status NOT IN \('sent', 'delivered', 'read', 'failed', 'deleted'\)/u);
  assert.match(sql, /WHEN p_status = 'deleted' THEN 'needs_attention'/u);
});
