import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../src/db/migrations/0048_property_predator_owned_seed_live_message.sql',
  import.meta.url,
);

async function migration(): Promise<string> {
  return (await readFile(migrationUrl, 'utf8')).replace(/\r\n?/g, '\n');
}

test('0048 exposes only table-blind owned-seed commands and one bounded resume snapshot', async () => {
  const sql = await migration();
  assert.match(sql, /CREATE ROLE r72_owned_seed_message_command LOGIN NOINHERIT/);
  assert.match(sql, /create_property_predator_owned_seed_message_draft\(\s*p_workspace_id uuid, p_company_content_version_id uuid, p_command_key text/s);
  assert.match(sql, /request_property_predator_owned_seed_message_approval\(\s*p_workspace_id uuid, p_message_id uuid, p_command_key text, p_review_note text/s);
  assert.match(sql, /decide_property_predator_owned_seed_message_approval\(\s*p_workspace_id uuid, p_approval_request_id uuid, p_decision text,/s);
  assert.match(sql, /resume_property_predator_owned_seed_message\(\s*p_workspace_id uuid, p_company_content_version_id uuid/s);
  assert.doesNotMatch(
    sql,
    /create_property_predator_owned_seed_message_draft\([\s\S]{0,300}p_(?:recipient|subject|body|provider|contact)/,
  );
  assert.doesNotMatch(
    sql,
    /GRANT (?:SELECT|INSERT|UPDATE|DELETE|TRUNCATE)[^;]*TO r72_owned_seed_message_command/,
  );
  assert.match(sql, /has_table_privilege\('r72_owned_seed_message_command'/);
  assert.match(
    sql,
    /GRANT EXECUTE ON FUNCTION app_private\.lock_active_portal_session\(bytea, uuid, uuid\)[\s\S]*TO r72_owned_seed_message_command/,
  );
  assert.match(
    sql,
    /GRANT EXECUTE ON FUNCTION app_private\.active_portal_session\(bytea, uuid, uuid\)[\s\S]*TO r72_owned_seed_message_command/,
  );
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app_private\.runtime_schema_migrations\(\)[\s\S]*TO r72_owned_seed_message_command/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app_private\.runtime_database_installation_id\(\)[\s\S]*TO r72_owned_seed_message_command/);
});

test('0048 readiness rejects privilege drift and authenticates the portal session lock', async () => {
  const sql = await migration();
  const readiness = sql.slice(
    sql.indexOf('CREATE FUNCTION app_private.property_predator_owned_seed_message_boundary_ready'),
    sql.indexOf('SET LOCAL ROLE r72_owner;',
      sql.indexOf('CREATE FUNCTION app_private.property_predator_owned_seed_message_boundary_ready')),
  );
  assert.match(
    readiness,
    /namespace\.nspname = 'app_private'[\s\S]*procedure\.oid NOT IN \([\s\S]*create_oid, request_oid, decide_oid, resume_oid, ready_oid,[\s\S]*ledger_oid, installation_oid, portal_lock_oid, portal_read_oid[\s\S]*\)[\s\S]*has_function_privilege\([\s\S]*session_user, procedure\.oid, 'EXECUTE'/,
  );
  assert.match(
    readiness,
    /procedure\.oid IN \(portal_lock_oid, portal_read_oid\)[\s\S]*owner_role\.rolname = 'r72_security_definer'[\s\S]*procedure\.prosecdef[\s\S]*procedure\.proconfig = ARRAY\['search_path=pg_catalog'\]::text\[\][\s\S]*pg_catalog\.count\(\*\) = 2/,
  );
});

test('0048 resume is exact-version, phase-bounded and reveals hashes but no copy or provider identity', async () => {
  const sql = await migration();
  const body = sql.slice(
    sql.indexOf('CREATE FUNCTION app_private.resume_property_predator_owned_seed_message'),
    sql.indexOf('CREATE FUNCTION app_private.property_predator_owned_seed_message_boundary_ready'),
  );
  assert.match(body, /p_company_content_version_id uuid/);
  assert.match(body, /ledger\.operation = 'create_draft'/);
  assert.match(body, /ledger\.company_content_version_id = p_company_content_version_id/);
  assert.match(body, /message\.current_version_id = ledger\.message_version_id/);
  assert.match(body, /version\.source_content_sha256 = ledger\.source_content_sha256/);
  assert.match(body, /lower\(point\.normalized_value\) = 'office@propertypredator\.com'/);
  assert.match(body, /app\.property_predator_mailgun_jobs/);
  assert.match(body, /THEN 'staged'/);
  assert.match(body, /THEN 'approved'/);
  assert.match(body, /THEN 'approval_pending'/);
  assert.match(body, /THEN 'drafted'/);
  assert.match(body, /subject_sha256 bytea[\s\S]*body_sha256 bytea[\s\S]*source_content_sha256 bytea/);
  assert.doesNotMatch(
    body.slice(0, body.indexOf('LANGUAGE plpgsql')),
    /(?:subject_text|body_text|provider_connection_id|contact_id|job_id)/,
  );
  assert.doesNotMatch(body, /INSERT INTO|UPDATE app\.|DELETE FROM/);
});

test('0048 resolves exact current approved email content and fixed live office seed server-side', async () => {
  const sql = await migration();
  const createBody = sql.slice(
    sql.indexOf('CREATE FUNCTION app_private.create_property_predator_owned_seed_message_draft'),
    sql.indexOf('CREATE FUNCTION app_private.request_property_predator_owned_seed_message_approval'),
  );
  assert.match(createBody, /version\.content_kind = 'email'/);
  assert.match(createBody, /application\/vnd\.propertypredator\.email-draft\+json/);
  assert.match(createBody, /decision\.decision = 'approved'/);
  assert.match(createBody, /ORDER BY latest\.request_number DESC/);
  assert.match(createBody, /NOT EXISTS \([\s\S]*company_content_versions AS newer/);
  assert.match(createBody, /JOIN app\.company_content_source_attestations AS source_attestation/);
  assert.match(createBody, /source_attestation\.source_system = version\.source_system/);
  assert.match(createBody, /source_attestation\.content_sha256 = version\.content_sha256/);
  assert.match(createBody, /source_attestation\.blob_sha256 = version\.blob_sha256/);
  assert.match(createBody, /source_attestation\.brand_sha256 = version\.brand_sha256/);
  assert.match(createBody, /ORDER BY latest\.checked_at DESC, latest\.id DESC LIMIT 1/);
  assert.match(createBody, /source_attestation\.checked_at <= statement_timestamp\(\)/);
  assert.match(createBody, /source_attestation\.expires_at > statement_timestamp\(\)/);
  assert.match(createBody, /propertypredator\.email-draft\/v1/);
  assert.match(createBody, /office@propertypredator\.com/);
  assert.match(createBody, /provider_id = 'mailgun_eu'/);
  assert.match(createBody, /environment = 'live'/);
  assert.match(createBody, /property_predator_email_pilot_seed_events/);
  assert.match(createBody, /source_content_version_ref/);
  assert.match(createBody, /source_content_approval_ref/);
});

test('0048 independently proves exact canonical email bytes and their digest', async () => {
  const sql = await migration();
  const createBody = sql.slice(
    sql.indexOf('CREATE FUNCTION app_private.create_property_predator_owned_seed_message_draft'),
    sql.indexOf('CREATE FUNCTION app_private.request_property_predator_owned_seed_message_approval'),
  );
  assert.match(createBody, /selected_canonical_content text/);
  assert.match(
    createBody,
    /selected_canonical_payload := '\{"bodyText":'[\s\S]*pg_catalog\.to_json\(selected_body\)::text[\s\S]*'\,"schema":"propertypredator\.email-draft\/v1","subject":'[\s\S]*pg_catalog\.to_json\(selected_subject\)::text/,
  );
  assert.match(
    createBody,
    /selected_canonical_content IS DISTINCT FROM selected_canonical_payload[\s\S]*selected_source_sha IS DISTINCT FROM public\.digest\([\s\S]*convert_to\(selected_canonical_content, 'UTF8'\), 'sha256'/,
  );
  assert.match(createBody, /Approved company-content email bytes are not canonical/);
});

test('0048 revalidates the exact latest source approval at request and decision time', async () => {
  const sql = await migration();
  const requestBody = sql.slice(
    sql.indexOf('CREATE FUNCTION app_private.request_property_predator_owned_seed_message_approval'),
    sql.indexOf('CREATE FUNCTION app_private.decide_property_predator_owned_seed_message_approval'),
  );
  const decideBody = sql.slice(
    sql.indexOf('CREATE FUNCTION app_private.decide_property_predator_owned_seed_message_approval'),
    sql.indexOf('CREATE FUNCTION app_private.property_predator_owned_seed_message_boundary_ready'),
  );
  for (const body of [requestBody, decideBody]) {
    assert.match(body, /version\.source_content_version_ref[\s\S]*app\.company_content_versions:/);
    assert.match(body, /version\.source_content_sha256 = source_version\.content_sha256/);
    assert.match(body, /version\.source_content_approval_ref[\s\S]*app\.company_content_approval_decisions:/);
    assert.match(body, /source_decision\.decision = 'approved'/);
    assert.match(body, /ORDER BY latest\.request_number DESC/);
    assert.match(body, /company_content_versions AS newer/);
  }
  assert.match(requestBody, /JOIN app\.company_content_source_attestations AS source_attestation/);
  assert.match(requestBody, /source_attestation\.source_system = source_version\.source_system/);
  assert.match(requestBody, /source_attestation\.content_sha256 = source_version\.content_sha256/);
  assert.match(requestBody, /source_attestation\.blob_sha256 = source_version\.blob_sha256/);
  assert.match(requestBody, /source_attestation\.brand_sha256 = source_version\.brand_sha256/);
  assert.match(requestBody, /source_attestation\.expires_at > statement_timestamp\(\)/);
  assert.match(requestBody, /source_version\.content_body = '\{"bodyText":'/);
  assert.match(requestBody, /created\.operation = 'create_draft'/);
  assert.match(requestBody, /created\.subject_sha256[\s\S]*public\.digest\(conversation\.subject, 'sha256'\)/);
  assert.match(requestBody, /created\.body_sha256 = version\.body_sha256/);
  assert.match(requestBody, /created\.source_content_sha256 = source_version\.content_sha256/);
  assert.match(decideBody, /FROM app\.company_content_source_attestations AS source_attestation/);
  assert.match(decideBody, /source_attestation\.expires_at > statement_timestamp\(\)/);
  assert.match(decideBody, /p_decision <> 'approved'[\s\S]*OR \(/);
  assert.match(decideBody, /source_version\.content_body = '\{"bodyText":'/);
  assert.match(decideBody, /created\.operation = 'create_draft'/);
  assert.match(
    decideBody,
    /message\.direction = 'outbound' AND message\.source_kind = 'automation'[\s\S]*lower\(point\.normalized_value\) = 'office@propertypredator\.com'[\s\S]*AND EXISTS \(\s*SELECT 1\s*FROM app_private\.property_predator_owned_seed_message_commands AS created[\s\S]*created\.operation = 'create_draft'[\s\S]*created\.company_content_version_id = source_version\.id[\s\S]*created\.message_id = message\.id[\s\S]*created\.message_version_id = version\.id[\s\S]*created\.subject_sha256[\s\S]*created\.body_sha256 = version\.body_sha256[\s\S]*created\.source_content_sha256 = source_version\.content_sha256[\s\S]*AND \(\s*p_decision <> 'approved'/,
  );
  assert.match(decideBody, /FROM app\.company_content_approval_requests AS source_request/);
  assert.match(decideBody, /version\.source_content_approval_ref[\s\S]*source_decision\.id::text/);
  assert.match(decideBody, /NOT EXISTS \(\s*SELECT 1 FROM app\.company_content_versions AS newer[\s\S]*newer\.version_number > source_version\.version_number/);
  const unconditionalDecisionJoins = decideBody.slice(
    decideBody.indexOf('SELECT request.message_id'),
    decideBody.indexOf('JOIN app.conversations AS conversation'),
  );
  assert.doesNotMatch(
    unconditionalDecisionJoins,
    /JOIN app\.company_content_(?:approval_requests|approval_decisions) AS source_/,
  );
});

test('0048 creates only a draft and requires separate exact request and decision commands', async () => {
  const sql = await migration();
  const createBody = sql.slice(
    sql.indexOf('CREATE FUNCTION app_private.create_property_predator_owned_seed_message_draft'),
    sql.indexOf('CREATE FUNCTION app_private.request_property_predator_owned_seed_message_approval'),
  );
  const requestBody = sql.slice(
    sql.indexOf('CREATE FUNCTION app_private.request_property_predator_owned_seed_message_approval'),
    sql.indexOf('CREATE FUNCTION app_private.decide_property_predator_owned_seed_message_approval'),
  );
  const decideBody = sql.slice(
    sql.indexOf('CREATE FUNCTION app_private.decide_property_predator_owned_seed_message_approval'),
    sql.indexOf('CREATE FUNCTION app_private.property_predator_owned_seed_message_boundary_ready'),
  );
  assert.match(createBody, /'outbound', 'draft', 'automation'/);
  assert.doesNotMatch(createBody, /INSERT INTO app\.message_approval_(?:requests|decisions)/);
  assert.match(requestBody, /INSERT INTO app\.message_approval_requests/);
  assert.match(requestBody, /lifecycle = 'approval_pending'/);
  assert.match(decideBody, /INSERT INTO app\.message_approval_decisions/);
  assert.match(decideBody, /p_decision = 'approved'/);
  assert.doesNotMatch(sql, /(?:fetch|https?:\/\/|api\.mailgun|provider_effects_enabled\s*=\s*true)/i);
  assert.doesNotMatch(sql, /INSERT INTO app\.(?:provider_operations|message_deliveries|property_predator_mailgun_jobs)/);
});

test('0048 command receipts are hash-only and commands plus cross-tab draft replay are idempotent', async () => {
  const sql = await migration();
  assert.match(sql, /CREATE TABLE app_private\.property_predator_owned_seed_message_commands/);
  assert.match(sql, /request_sha256 bytea NOT NULL/);
  assert.match(sql, /subject_sha256 bytea NOT NULL/);
  assert.match(sql, /body_sha256 bytea NOT NULL/);
  assert.match(sql, /UNIQUE \(workspace_id, company_content_version_id\)/);
  assert.match(
    sql,
    /command\.operation = 'create_draft'[\s\S]*command\.company_content_version_id = p_company_content_version_id[\s\S]*RETURN QUERY SELECT 'replayed'/,
  );
  assert.doesNotMatch(sql, /(?:subject|body|email)_text\s+text/);
  assert.equal((sql.match(/Owned-seed message command idempotency conflict/g) ?? []).length, 3);
  assert.equal((sql.match(/RETURN QUERY SELECT 'replayed'/g) ?? []).length, 4);
});

test('0048 command receipts are append-only evidence even to the owner role', async () => {
  const sql = await migration();
  assert.match(
    sql,
    /CREATE FUNCTION app_private\.reject_property_predator_owned_seed_message_command_mutation\(\)[\s\S]*Property Predator owned-seed message command evidence is append-only[\s\S]*ERRCODE = '55000'/,
  );
  assert.match(
    sql,
    /REVOKE ALL ON FUNCTION\s+app_private\.reject_property_predator_owned_seed_message_command_mutation\(\)\s+FROM PUBLIC/,
  );
  assert.match(
    sql,
    /CREATE TRIGGER property_predator_owned_seed_message_commands_append_only\s+BEFORE UPDATE OR DELETE\s+ON app_private\.property_predator_owned_seed_message_commands[\s\S]*reject_property_predator_owned_seed_message_command_mutation\(\)/,
  );
  assert.match(
    sql,
    /GRANT SELECT, INSERT ON app_private\.property_predator_owned_seed_message_commands\s+TO r72_owned_seed_message_definer/,
  );
  assert.doesNotMatch(
    sql,
    /GRANT (?:UPDATE|DELETE)[^;]*ON app_private\.property_predator_owned_seed_message_commands/,
  );
});
