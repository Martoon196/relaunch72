import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../src/db/migrations/0092_property_predator_zernio_inbound_data_plane.sql',
  import.meta.url,
);

function normalise(source: string): string {
  return source.replace(/--[^\n]*/gu, ' ').replace(/\s+/gu, ' ').trim();
}

async function sql(): Promise<string> {
  return normalise(await readFile(migrationUrl, 'utf8'));
}

function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `missing SQL boundary: ${start}`);
  return source.slice(from, to);
}

const TABLES = [
  'property_predator_zernio_inbound_credential_bindings',
  'property_predator_zernio_inbound_inbox_bindings',
  'property_predator_zernio_inbound_person_bindings',
  'property_predator_zernio_inbound_owned_author_bindings',
  'property_predator_zernio_inbound_transport_receipts',
  'property_predator_zernio_inbound_events',
  'property_predator_zernio_inbound_quarantine',
  'property_predator_zernio_inbound_projections',
] as const;

test('0092 creates registered, forced-RLS and append-only Zernio inbound evidence', async () => {
  const source = await sql();
  assert.match(source, /member\.rolname = session_user/u);
  assert.match(source, /membership\.admin_option/u);
  assert.match(source, /NOT membership\.inherit_option/u);
  assert.doesNotMatch(source, /has_function_privilege\( 'PUBLIC'/u);
  assert.match(source, /privilege\.grantee = 0/u);
  for (const table of TABLES) {
    assert.match(source, new RegExp(`CREATE TABLE app\\.${table}`, 'u'));
    assert.match(source, new RegExp(`ALTER TABLE app\\.%I ENABLE ROW LEVEL SECURITY`, 'u'));
    assert.match(source, new RegExp(`'app', '${table}', 'workspace_id'`, 'u'));
  }
  assert.match(source, /Zernio inbound evidence is append-only/u);
  assert.match(source, /BEFORE UPDATE OR DELETE ON app\.%I/u);
  assert.match(source, /review_state text NOT NULL DEFAULT 'pending' CHECK \(review_state = 'pending'\)/u);
});

test('0092 stores exact account, person, thread, event, payload and signature hashes', async () => {
  const source = await sql();
  const transport = between(
    source,
    'CREATE TABLE app.property_predator_zernio_inbound_transport_receipts',
    'CREATE TABLE app.property_predator_zernio_inbound_events',
  );
  for (const column of [
    'provider_profile_id_sha256', 'credential_version_sha256',
    'credential_binding_sha256',
    'provider_account_id_sha256', 'provider_person_id_sha256',
    'provider_thread_id_sha256', 'provider_event_id_sha256',
    'payload_sha256', 'signature_sha256',
    'event_identity_sha256', 'delivery_identity_sha256',
  ]) assert.match(transport, new RegExp(`${column} bytea NOT NULL`, 'u'));
  assert.match(transport, /credential_binding_id uuid NOT NULL/u);
  assert.match(transport, /provider_ownership_assertion text NOT NULL/u);
  assert.match(transport, /signature_verified_at timestamptz NOT NULL/u);
  assert.doesNotMatch(transport, /provider_account_id text|provider_person_id text|provider_event_id text/u);
  assert.match(source, /UNIQUE \(workspace_id, event_key_sha256\)/u);
  assert.match(source, /UNIQUE \(workspace_id, delivery_identity_sha256\)/u);
});

test('0092 resolves only exact account-scoped inbox, person and owned-author bindings', async () => {
  const source = await sql();
  const record = between(
    source,
    'CREATE FUNCTION app_private.record_zernio_signed_inbound',
    'RESET ROLE;',
  );
  assert.match(record, /point\.kind = 'social'/u);
  assert.match(record, /lower\(coalesce\(point\.label, ''\)\) = p_network/u);
  assert.match(record, /point\.deleted_at IS NULL AND point\.is_verified/u);
  assert.match(record, /point\.dedupe_state = 'normal'/u);
  assert.match(record, /FROM app\.property_predator_zernio_inbound_inbox_bindings AS binding/u);
  assert.match(record, /FROM app\.property_predator_zernio_inbound_person_bindings AS binding/u);
  assert.match(record, /FROM app\.property_predator_zernio_inbound_owned_author_bindings AS binding/u);
  assert.match(record, /binding\.zernio_account_id = p_zernio_account_id/u);
  assert.match(record, /binding\.provider_profile_id_sha256 = p_provider_profile_id_sha256/u);
  assert.doesNotMatch(record, /digest\(point\.normalized_value/u);
  assert.doesNotMatch(record, /INSERT INTO app\.contacts/u);
  assert.doesNotMatch(record, /INSERT INTO app\.contact_points/u);
  assert.doesNotMatch(record, /UPDATE app\.contacts|UPDATE app\.contact_points/u);
  assert.match(record, /'unmatched_contact_point'/u);
  assert.match(record, /'conflicting_contact_point'/u);
  assert.match(record, /'owned_author_binding_missing'/u);
  assert.match(record, /'owned_author_comment'/u);
});

test('0092 atomically rechecks and persists exact profile and credential binding evidence', async () => {
  const source = await sql();
  const record = between(
    source,
    'CREATE FUNCTION app_private.record_zernio_signed_inbound',
    'RESET ROLE;',
  );
  assert.match(record, /selected_credential app\.property_predator_zernio_inbound_credential_bindings%ROWTYPE/u);
  assert.match(record, /credential\.credential_version_sha256 = p_credential_version_sha256/u);
  assert.match(record, /credential\.credential_binding_sha256 = p_credential_binding_sha256/u);
  assert.match(record, /account\.provider_profile_id_sha256 = p_provider_profile_id_sha256/u);
  assert.match(record, /selected_credential\.id, p_zernio_account_id/u);
  assert.match(source, /FOREIGN KEY \( workspace_id, credential_binding_id, provider_connection_id, provider_profile_id_sha256, credential_version_sha256, credential_binding_sha256 \)/u);
  assert.match(source, /account_inbox_binding_id uuid NOT NULL/u);
  assert.match(source, /person_binding_id uuid NOT NULL/u);
});

test('0092 projects one verified event into Inbox, Lead 360, admin review and a replied candidate', async () => {
  const source = await sql();
  const record = between(
    source,
    'CREATE FUNCTION app_private.record_zernio_signed_inbound',
    'RESET ROLE;',
  );
  for (const insert of [
    'app.conversations', 'app.messages', 'app.message_versions',
    'app.tasks', 'app.property_predator_admin_call_task_origins',
    'app.activities', 'app.property_predator_zernio_inbound_projections',
  ]) assert.match(record, new RegExp(`INSERT INTO ${insert.replace('.', '\\.')}`, 'u'));
  assert.match(record, /'verified_webhook'/u);
  assert.match(record, /'inbox\.zernio\.reply_received'/u);
  assert.match(source, /outreach_outcome_candidate text NOT NULL DEFAULT 'replied'/u);
  assert.match(record, /FROM app_private\.daily_outreach_manual_attempt_receipts AS attempt/u);
  assert.doesNotMatch(record, /INSERT INTO app_private\.daily_outreach_outcome_events/u);
  assert.doesNotMatch(record, /INSERT INTO app\.provider_operations|INSERT INTO app\.message_deliveries/u);
});

test('0092 preserves LinkedIn truth through canonical Inbox constraints and live provenance', async () => {
  const source = await sql();
  for (const table of [
    'channel_endpoints', 'inboxes', 'conversations',
    'messages', 'message_versions',
  ]) assert.match(source, new RegExp(`ALTER TABLE app\\.${table}`, 'u'));
  assert.doesNotMatch(
    source,
    /ALTER TABLE app\.message_deliveries[\s\S]+linkedin/u,
  );
  assert.match(source, /'facebook', 'linkedin'/u);
  assert.match(source, /WHEN 'linkedin' THEN EXISTS/u);
  assert.match(source, /'zernio_social_live'::text/u);
  assert.match(source, /source_provider IN \( 'operator', 'mailgun_eu', 'twilio_messaging', 'meta_whatsapp_cloud', 'zernio' \)/u);
});

test('0092 gives the Inbox reader only exact Zernio projection columns and no command capability', async () => {
  const source = await sql();
  assert.match(source, /GRANT SELECT \( workspace_id, event_id, conversation_id, inbound_message_id, network, recorded_at \) ON app\.property_predator_zernio_inbound_projections TO r72_operational_inbox_reader_definer/u);
  assert.match(source, /CREATE POLICY zernio_inbound_projection_reader_select ON app\.property_predator_zernio_inbound_projections FOR SELECT TO r72_operational_inbox_reader_definer USING \( workspace_id = nullif\(current_setting\('app\.workspace_id', true\), ''\)::uuid AND current_setting\('app\.actor_kind', true\) = 'user' \)/u);
  assert.match(source, /WHEN 'linkedin' THEN EXISTS \( SELECT 1 FROM app\.property_predator_zernio_inbound_projections AS live_social WHERE live_social\.workspace_id = p_workspace_id AND live_social\.conversation_id = p_conversation_id AND live_social\.network = 'linkedin' \)/u);
  assert.match(source, /live_social\.inbound_message_id = p_message_id/u);
  assert.doesNotMatch(source, /GRANT SELECT[^;]*property_predator_zernio_inbound_projections[^;]*TO (?:r72_web|r72_crm_command|r72_operational_inbox_definer)/u);
  assert.doesNotMatch(source, /GRANT (?:INSERT|UPDATE|DELETE|TRUNCATE)[^;]*property_predator_zernio_inbound_projections[^;]*TO r72_operational_inbox_reader_definer/u);
  assert.doesNotMatch(source, /GRANT EXECUTE ON FUNCTION app_private\.record_zernio_signed_inbound[^;]*TO r72_web/u);
});

test('0092 exposes only bounded table-blind webhook functions and no provider-effect capability', async () => {
  const source = await sql();
  assert.match(source, /\('r72_zernio_inbound_webhook_command'\)|rolname = 'r72_zernio_inbound_webhook_command'/u);
  assert.match(source, /CREATE ROLE r72_zernio_inbound_webhook_command LOGIN NOINHERIT/u);
  assert.match(source, /CREATE ROLE r72_zernio_inbound_definer NOLOGIN NOINHERIT/u);
  assert.match(source, /CREATE FUNCTION app_private\.resolve_zernio_inbound_account/u);
  assert.match(source, /GRANT EXECUTE ON FUNCTION app_private\.resolve_zernio_inbound_account/u);
  assert.match(source, /GRANT EXECUTE ON FUNCTION app_private\.record_zernio_signed_inbound/u);
  assert.match(source, /Zernio inbound webhook LOGIN has table capability/u);
  assert.match(source, /Zernio inbound webhook LOGIN has unexpected function/u);
  assert.match(source, /has_any_column_privilege/u);
  assert.match(source, /procedure\.oid::regprocedure::text NOT IN/u);
  assert.match(source, /Unsafe Zernio inbound role member/u);
  assert.match(source, /Zernio inbound definer gained provider-effect capability/u);
  assert.doesNotMatch(
    source,
    /GRANT (?:SELECT|INSERT|UPDATE|DELETE|TRUNCATE)[^;]+TO r72_zernio_inbound_webhook_command/u,
  );
  assert.doesNotMatch(source, /GRANT EXECUTE[^;]+TO PUBLIC/u);
});

test('0092 deduplicates on canonical provider event id and conflicts crossed identities', async () => {
  const source = await sql();
  const record = between(
    source,
    'CREATE FUNCTION app_private.record_zernio_signed_inbound',
    'RESET ROLE;',
  );
  assert.match(record, /expected_event_key_sha256 := p_provider_event_id_sha256/u);
  assert.match(source, /CONSTRAINT zernio_inbound_transport_delivery_uq UNIQUE \(workspace_id, delivery_identity_sha256\)/u);
  assert.match(source, /CONSTRAINT zernio_inbound_event_key_uq UNIQUE \(workspace_id, event_key_sha256\)/u);
  assert.match(record, /\|\| p_network \|\| pg_catalog\.chr\(31\) \|\| p_inbound_kind/u);
  assert.match(record, /'provider_event_conflict'/u);
  const deliveryIdentity = between(
    record,
    'expected_delivery_identity_sha256 := public.digest(',
    'SELECT credential.* INTO selected_credential',
  );
  assert.doesNotMatch(deliveryIdentity, /p_signature_verified_at/u);
  assert.match(record, /zernio-inbound-conversation:/u);
});
