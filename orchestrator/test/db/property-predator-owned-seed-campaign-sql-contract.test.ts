import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../src/db/migrations/0047_property_predator_owned_seed_campaign_loop.sql',
  import.meta.url,
);

async function migration(): Promise<string> {
  return (await readFile(migrationUrl, 'utf8')).replace(/\r\n?/g, '\n');
}

test('0047 exposes one table-blind staging command with no recipient selector', async () => {
  const sql = await migration();
  assert.match(sql, /CREATE ROLE r72_owned_seed_campaign_command LOGIN NOINHERIT/);
  assert.match(sql, /stage_property_predator_owned_seed_campaign\(\s*p_workspace_id uuid,\s*p_message_version_id uuid,\s*p_run_id uuid,\s*p_command_key text/s);
  assert.doesNotMatch(
    sql,
    /stage_property_predator_owned_seed_campaign\([\s\S]{0,400}p_(?:recipient|contact|consent|provider|approval)/,
  );
  assert.doesNotMatch(
    sql,
    /GRANT (?:SELECT|INSERT|UPDATE|DELETE|TRUNCATE)[^;]*TO r72_owned_seed_campaign_command/,
  );
  assert.match(sql, /has_table_privilege\(\s*'r72_owned_seed_campaign_command'/);
});

test('0047 resolves exact live approval, office seed, consent, suppression and caps server-side', async () => {
  const sql = await migration();
  const body = sql.slice(
    sql.indexOf('CREATE FUNCTION app_private.stage_property_predator_owned_seed_campaign'),
    sql.indexOf('CREATE FUNCTION app_private.property_predator_owned_seed_campaign_boundary_ready'),
  );
  assert.match(body, /connection\.provider_id = 'mailgun_eu'/);
  assert.match(body, /connection\.environment = 'live'/);
  assert.match(body, /control\.max_recipients = 1/);
  assert.match(body, /control\.run_message_cap = 1/);
  assert.match(body, /control\.monthly_message_cap = 3/);
  assert.match(body, /message\.lifecycle = 'approved'/);
  assert.match(body, /decision\.decision = 'approved'/);
  assert.match(body, /SELECT current_decision\.id[\s\S]*ORDER BY current_decision\.decided_at DESC/);
  assert.match(body, /property_predator_email_pilot_approved_content/);
  assert.match(body, /lower\(point\.normalized_value\)\s*= 'office@propertypredator\.com'/);
  assert.match(body, /consent\.purpose = 'marketing'/);
  assert.match(body, /consent\.state = 'granted'/);
  assert.match(body, /property_predator_email_pilot_seed_events/);
  assert.match(body, /communication_suppression_events/);
  assert.match(body, /suppression\.state = 'suppressed'/);
  assert.match(body, /property_predator_email_pilot_run_usage/);
  assert.match(body, /property_predator_email_pilot_month_usage/);
  assert.match(body, /job\.state IN \('queued', 'leased'\)/);
  assert.match(body, /pilot_capacity_unavailable/);
});

test('0047 final staging revalidates exact canonical source approval and fresh attestation', async () => {
  const sql = await migration();
  const body = sql.slice(
    sql.indexOf('CREATE FUNCTION app_private.stage_property_predator_owned_seed_campaign'),
    sql.indexOf('CREATE FUNCTION app_private.property_predator_owned_seed_campaign_boundary_ready'),
  );
  assert.match(body, /version\.source_content_version_ref[\s\S]*app\.company_content_versions:/);
  assert.match(body, /version\.source_content_sha256 = source_version\.content_sha256/);
  assert.match(body, /source_version\.content_body = '\{"bodyText":'[\s\S]*to_json\(version\.body_text\)[\s\S]*to_json\(conversation\.subject\)/);
  assert.match(body, /version\.source_content_approval_ref[\s\S]*app\.company_content_approval_decisions:/);
  assert.match(body, /source_decision\.decision = 'approved'/);
  assert.match(body, /JOIN app\.company_content_source_attestations AS source_attestation/);
  assert.match(body, /source_attestation\.source_system = source_version\.source_system/);
  assert.match(body, /source_attestation\.content_sha256 = source_version\.content_sha256/);
  assert.match(body, /source_attestation\.blob_sha256 = source_version\.blob_sha256/);
  assert.match(body, /source_attestation\.brand_sha256 = source_version\.brand_sha256/);
  assert.match(body, /ORDER BY latest\.checked_at DESC, latest\.id DESC LIMIT 1/);
  assert.match(body, /source_attestation\.checked_at <= statement_timestamp\(\)/);
  assert.match(body, /source_attestation\.expires_at > statement_timestamp\(\)/);
  assert.match(body, /company_content_versions AS newer[\s\S]*newer\.version_number > source_version\.version_number/);
  assert.match(body, /source_evidence_not_current/);
  assert.match(body, /selected_source_attestation_id::text/);
});

test('0047 reuses the 0043 job and delivery model without making a provider call', async () => {
  const sql = await migration();
  const body = sql.slice(
    sql.indexOf('CREATE FUNCTION app_private.stage_property_predator_owned_seed_campaign'),
    sql.indexOf('CREATE FUNCTION app_private.property_predator_owned_seed_campaign_boundary_ready'),
  );
  assert.match(body, /app_private\.stage_property_predator_mailgun_job\(/);
  assert.match(body, /app\.property_predator_mailgun_jobs/);
  assert.doesNotMatch(body, /INSERT INTO app\.message_deliveries/);
  assert.doesNotMatch(body, /INSERT INTO app\.provider_operations/);
  assert.doesNotMatch(body, /(?:fetch|https?:\/\/|mailgun\.net|api_key|credential)/i);
  assert.match(body, /idempotency_conflict/);
  assert.match(body, /SELECT 'replayed'/);
  assert.match(body, /delivery_state text/);
  assert.match(body, /existing_job\.estimated_spend_usd_micros, existing_job\.state/);
  assert.match(body, /selected_request_sha256, selected_cost, 'queued'::text/);
});

test('0047 returns immutable delivery-intent truth before mutable launch gates drift', async () => {
  const sql = await migration();
  const body = sql.slice(
    sql.indexOf('CREATE FUNCTION app_private.stage_property_predator_owned_seed_campaign'),
    sql.indexOf('CREATE FUNCTION app_private.property_predator_owned_seed_campaign_boundary_ready'),
  );
  const exactReplay = body.indexOf(
    'job.idempotency_key_sha256 = selected_idempotency_sha256',
  );
  const crossKeyReplay = body.indexOf(
    'job.message_version_id = p_message_version_id', exactReplay,
  );
  const providerGate = body.indexOf("connection.provider_id = 'mailgun_eu'");
  const sourceGate = body.indexOf('Resolve the source item first');
  const recipientGate = body.indexOf("'office@propertypredator.com'", sourceGate);
  assert.ok(exactReplay >= 0, 'exact command-hash replay lookup is missing');
  assert.ok(crossKeyReplay > exactReplay, 'cross-key message replay lookup is missing');
  assert.ok(providerGate > crossKeyReplay, 'provider policy must follow replay truth');
  assert.ok(sourceGate > crossKeyReplay, 'source freshness must follow replay truth');
  assert.ok(recipientGate > crossKeyReplay, 'recipient evidence must follow replay truth');
  assert.match(
    body.slice(exactReplay, providerGate),
    /existing_job\.message_version_id IS DISTINCT FROM p_message_version_id[\s\S]*existing_job\.run_id IS DISTINCT FROM p_run_id[\s\S]*existing_job\.email_sha256 IS DISTINCT FROM selected_email_sha256/,
  );
  assert.match(
    body.slice(crossKeyReplay, providerGate),
    /job\.email_sha256 = selected_email_sha256[\s\S]*RETURN QUERY SELECT 'replayed'/,
  );
});

test('0047 boundary readiness allowlists only stage/readiness/runtime identity functions', async () => {
  const sql = await migration();
  assert.match(sql, /property_predator_owned_seed_campaign_boundary_ready/);
  assert.match(sql, /runtime_schema_migrations/);
  assert.match(sql, /runtime_database_installation_id/);
  assert.match(sql, /procedure\.oid NOT IN \(\s*stage_oid, ready_oid, ledger_oid, installation_oid, session_lock_oid/s);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app_private\.lock_active_portal_session\(bytea, uuid, uuid\)\s+TO r72_owned_seed_campaign_command/);
  assert.match(sql, /owner_role\.rolname = 'r72_security_definer'[\s\S]*procedure\.prosecdef/);
  assert.match(sql, /NOT pg_catalog\.has_schema_privilege\(session_user, 'app', 'USAGE'\)/);
  assert.match(sql, /NOT pg_catalog\.has_schema_privilege\(session_user, 'public', 'CREATE'\)/);
});

test('disposable reset removes the dedicated owned-seed campaign login role', async () => {
  const reset = await readFile(new URL('./reset-disposable.ts', import.meta.url), 'utf8');
  assert.match(reset, /'r72_owned_seed_campaign_command'/);
});
