import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migration53Url = new URL(
  '../../src/db/migrations/0053_property_predator_meta_whatsapp_live_foundation.sql',
  import.meta.url,
);
const migration57Url = new URL(
  '../../src/db/migrations/0057_property_predator_live_channel_emergency_pause.sql',
  import.meta.url,
);
const migration55Url = new URL(
  '../../src/db/migrations/0055_property_predator_operational_conversion_inbox.sql',
  import.meta.url,
);
const migration58Url = new URL(
  '../../src/db/migrations/0058_property_predator_whatsapp_activation_readiness.sql',
  import.meta.url,
);

function normalise(sql: string): string {
  return sql.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();
}

test('0058 adds a read-only probe that cannot write, enqueue or dispatch', async () => {
  const sql = normalise(await readFile(migration58Url, 'utf8'));
  assert.match(sql, /CREATE FUNCTION app_private\.property_predator_whatsapp_activation_readiness\(/);
  assert.match(sql, /RETURNS TABLE \(dimension text, ready boolean, blocker_code text\)/);
  assert.match(sql, /LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog/);

  const probe = sql.slice(
    sql.indexOf('CREATE FUNCTION app_private.property_predator_whatsapp_activation_readiness('),
    sql.indexOf('RESET ROLE'),
  );
  assert.ok(probe.length > 0, 'the probe body must be present');
  for (const mutation of [
    /\bINSERT INTO\b/, /\bUPDATE app\./, /\bDELETE FROM\b/, /\bTRUNCATE\b/,
    /\bnextval\b/, /\bpg_advisory/, /\bCOMMIT\b/,
  ]) {
    assert.doesNotMatch(probe, mutation,
      `the readiness probe must not contain ${String(mutation)}`);
  }
  // It must never create an authority, a job or a provider operation.
  assert.doesNotMatch(probe, /property_predator_whatsapp_live_authorities \(/);
  assert.doesNotMatch(probe, /authorize_and_enqueue_whatsapp_live_job/);
});

test('0058 keeps the probe behind the exact founder command identity', async () => {
  const sql = normalise(await readFile(migration58Url, 'utf8'));
  assert.match(sql, /session_user <> 'r72_whatsapp_live_command'/);
  assert.match(sql, /current_setting\('app\.actor_kind', true\) IS DISTINCT FROM 'user'/);
  assert.match(sql, /current_setting\('app\.user_id', true\) !~ '\^\[0-9a-f-\]\{36\}\$'/);
  assert.match(sql, /coalesce\(current_setting\('app\.request_id', true\), ''\) = ''/);
  assert.match(sql, /RAISE EXCEPTION 'WhatsApp activation readiness denied' USING ERRCODE = '42501'/);
  assert.match(
    sql,
    /REVOKE ALL ON FUNCTION app_private\.property_predator_whatsapp_activation_readiness\( uuid, uuid, uuid, uuid, uuid, uuid, text, bytea \) FROM PUBLIC/,
  );
  assert.match(
    sql,
    /GRANT EXECUTE ON FUNCTION app_private\.property_predator_whatsapp_activation_readiness\( uuid, uuid, uuid, uuid, uuid, uuid, text, bytea \) TO r72_whatsapp_live_command/,
  );
  // The probe must not become a second read capability for a command identity.
  assert.match(sql, /Unsafe WhatsApp activation readiness capability/);
  assert.match(sql, /has_table_privilege\(checked_role, relation\.oid, 'SELECT'\)/);
});

test('0058 proves the owned recipient by digest and never returns the number', async () => {
  const sql = normalise(await readFile(migration58Url, 'utf8'));
  assert.match(sql, /p_expected_recipient_sha256 bytea/);
  assert.match(sql, /octet_length\(p_expected_recipient_sha256\) <> 32/);
  assert.match(
    sql,
    /public\.digest\(regexp_replace\(point\.normalized_value, '\^\\\+', ''\), 'sha256'\)/,
  );
  assert.match(sql, /selected_recipient_sha = p_expected_recipient_sha256/);
  assert.match(sql, /'RECIPIENT_EVIDENCE_MISMATCH'/);

  // Only dimension/boolean/code leave the boundary: no address-shaped column
  // may be assigned into an output field.
  assert.doesNotMatch(sql, /dimension := point\.normalized_value/);
  assert.doesNotMatch(sql, /blocker_code := point\./);
  assert.doesNotMatch(sql, /RETURNS TABLE \([^)]*recipient[^)]*\)/);
});

test('0058 re-proves the exact evidence chain the command boundary enforces', async () => {
  const sql = normalise(await readFile(migration58Url, 'utf8'));
  const enqueue = normalise(await readFile(migration53Url, 'utf8'));

  // Owned, active, non-revoked binding on a live Meta connection.
  assert.match(sql, /connection\.provider_id = 'meta_whatsapp_cloud'/);
  assert.match(sql, /connection\.provider_kind = 'messaging'/);
  assert.match(sql, /property_predator_whatsapp_live_binding_revocations/);
  assert.match(sql, /'BINDING_REVOKED'/);
  assert.match(sql, /'IDENTITY_BINDING_REQUIRED'/);

  // Exactly one Meta-approved, parameter-free, company-approved template.
  assert.match(sql, /template\.provider_status = 'approved'/);
  assert.match(sql, /template\.parameter_count = 0/);
  assert.match(sql, /decision\.decision = 'approved'/);
  assert.match(sql, /public\.digest\(version\.content_body, 'sha256'\) = version\.content_sha256/);
  assert.match(sql, /'TEMPLATE_NOT_APPROVED'/);
  assert.match(sql, /'TEMPLATE_CONTENT_SUPERSEDED'/);

  // Verified endpoint, current consent, clear suppression - the same
  // latest-wins predicates 0053 applies immediately before a provider call.
  assert.match(sql, /point\.kind = 'whatsapp'/);
  assert.match(sql, /point\.is_verified AND point\.dedupe_state = 'normal'/);
  assert.match(sql, /consent\.state = 'granted'/);
  assert.match(sql, /consent\.endpoint_identity_sha256 = selected_endpoint_sha/);
  assert.match(sql, /suppression\.state = 'suppressed'/);
  assert.match(sql, /'CONSENT_NOT_CURRENT'/);
  assert.match(sql, /'SUPPRESSION_ACTIVE'/);
  for (const source of [sql, enqueue]) {
    assert.match(source, /ORDER BY latest\.occurred_at DESC, latest\.recorded_at DESC, latest\.id DESC LIMIT 1/);
  }

  // Operator authority and the durable pause fence.
  assert.match(sql, /membership\.role IN \('owner', 'admin'\)/);
  assert.match(sql, /'OPERATOR_AUTHORITY_REQUIRED'/);
  assert.match(sql, /pause\.scope IN \('all', 'whatsapp'\)/);
  assert.match(sql, /'EMERGENCY_PAUSED'/);
});

test('0058 reports the stricter per-binding cap the command boundary enforces', async () => {
  const sql = normalise(await readFile(migration58Url, 'utf8'));
  assert.match(sql, /job\.binding_id = p_binding_id/);
  assert.match(sql, /daily_used < 1 AND monthly_used < 3/);
  assert.match(sql, /'CAP_REACHED'/);
});

test('0058 surfaces a missing approved template through the existing typed contract', async () => {
  const sql = normalise(await readFile(migration58Url, 'utf8'));
  const paused = normalise(await readFile(migration57Url, 'utf8'));

  assert.match(sql, /CREATE OR REPLACE FUNCTION app_private\.property_predator_live_channel_truth\(\)/);
  assert.match(sql, /'TEMPLATE_REQUIRED'/);
  assert.match(sql, /truth\.rail = 'whatsapp'/);

  // The wrapper must keep reading the closed 0056 base through 0057's rename,
  // and must preserve the durable emergency-pause evidence exactly.
  assert.match(sql, /FROM app_private\.property_predator_live_channel_truth_unpaused\(\) AS truth/);
  assert.match(paused, /FROM app_private\.property_predator_live_channel_truth_unpaused\(\) AS truth/);
  assert.match(sql, /pause\.scope IN \('all', truth\.rail\)/);
  assert.match(sql, /truth\.rail <> 'social_dm' AND EXISTS/);
  assert.match(sql, /'EMERGENCY_PAUSED' = ANY\(truth\.blocker_codes\)/);

  // Cap, receipt and state truth must pass through untouched.
  for (const column of [
    'truth\\.daily_used', 'truth\\.daily_limit', 'truth\\.monthly_used',
    'truth\\.monthly_limit', 'truth\\.connection_state', 'truth\\.inbound_state',
    'truth\\.outbound_or_reply_state', 'truth\\.receipt_state',
    'truth\\.latest_receipt_id', 'truth\\.latest_receipt_outcome',
    'truth\\.latest_receipt_at', 'truth\\.latest_receipt_evidence_sha256',
  ]) {
    assert.match(sql, new RegExp(column));
  }
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app_private\.property_predator_live_channel_truth\(\) TO r72_web/);
  assert.doesNotMatch(sql, /GRANT EXECUTE ON FUNCTION app_private\.property_predator_live_channel_truth_unpaused/);
});

test('0058 grants only the reads the probe and truth wrapper require', async () => {
  const sql = normalise(await readFile(migration58Url, 'utf8'));
  assert.match(sql, /GRANT SELECT ON app\.property_predator_live_channel_pause_events, app\.inboxes TO r72_whatsapp_live_definer/);
  assert.match(sql, /CREATE POLICY live_channel_pause_whatsapp_live_definer_select/);
  assert.match(sql, /CREATE POLICY inboxes_whatsapp_live_definer_select/);
  assert.match(sql, /GRANT SELECT ON app\.property_predator_whatsapp_live_templates TO r72_operational_inbox_definer/);
  assert.match(sql, /CREATE POLICY operational_channel_truth_whatsapp_templates_select/);

  // Every added policy stays tenant-scoped.
  const policies = sql.match(/CREATE POLICY [a-z0-9_]+ ON [a-z0-9_.]+ FOR SELECT TO [a-z0-9_]+ USING \([^;]*?\)(?= ;|;)/g)
    ?? sql.match(/CREATE POLICY [a-z0-9_]+ ON [a-z0-9_.]+ FOR SELECT TO [a-z0-9_]+ USING \([^;]*\)/g) ?? [];
  assert.ok(policies.length >= 3, 'each new read must be tenant scoped');
  for (const policy of policies) {
    assert.match(policy, /workspace_id = nullif\(current_setting\('app\.workspace_id', true\), ''\)::uuid/);
  }
  // The temporary DDL capability is always closed again.
  assert.match(sql, /REVOKE CREATE ON SCHEMA app_private FROM r72_whatsapp_live_definer/);
  assert.match(sql, /REVOKE CREATE ON SCHEMA app_private FROM r72_operational_inbox_definer/);
});

// One consolidated gate for the owned-test checklist. The individual rail
// suites prove each mechanism; this asserts the whole set is present before
// anyone is asked to authorise a first WhatsApp effect.
test('the owned-test checklist is provably composed without any provider call', async () => {
  const foundation = normalise(await readFile(migration53Url, 'utf8'));
  const inbox = normalise(await readFile(migration55Url, 'utf8'));

  // Every Meta delivery status is handled, and nothing outside the set is.
  assert.match(
    foundation,
    /p_status NOT IN \('sent', 'delivered', 'read', 'failed', 'deleted'\)/,
  );
  assert.match(foundation, /event_kind IN \( 'accepted', 'sent', 'delivered', 'read', 'failed', 'deleted', 'outcome_unknown', 'inbound_received' \)/);

  // Replay and conflict protection on authenticated webhook evidence.
  for (const disposition of [/RETURN 'conflict'/, /RETURN 'replayed'/, /RETURN 'applied'/]) {
    assert.match(foundation, disposition);
  }
  assert.match(inbox, /RETURN QUERY SELECT 'conflict'/);
  assert.match(inbox, /RETURN QUERY SELECT 'replayed'/);
  assert.match(inbox, /RETURN QUERY SELECT 'applied'/);

  // A status may only settle a job it exactly belongs to.
  assert.match(foundation, /WhatsApp status has no exact outbound job/);

  // Outcome-unknown is quarantined rather than retried blindly.
  assert.match(foundation, /'outcome_unknown'/);
  assert.match(foundation, /worker_whatsapp_outcome_unknown/);
  assert.match(foundation, /needs_attention/);

  // A verified reply binds to Conversion Inbox and Lead 360.
  assert.match(inbox, /INSERT INTO app\.conversations \(/);
  assert.match(inbox, /INSERT INTO app\.messages \(/);
  assert.match(inbox, /source_kind[\s\S]{0,400}'verified_webhook'/);
  assert.match(inbox, /INSERT INTO app\.property_predator_admin_call_task_origins \(/);
  assert.match(inbox, /'signed_inbound'/);
  assert.match(inbox, /'inbox\.whatsapp\.reply_received'/);
  assert.match(inbox, /INSERT INTO app\.property_predator_whatsapp_live_inbox_projections \(/);

  // The responder is resolved from a verified owned endpoint, never invented.
  assert.match(inbox, /point\.kind = 'whatsapp'/);
  assert.match(inbox, /WhatsApp live inbound verified contact point not found/);
  assert.match(inbox, /WhatsApp live inbound contact identity is ambiguous/);
});
