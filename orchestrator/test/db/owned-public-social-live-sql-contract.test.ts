import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../src/db/migrations/0052_property_predator_owned_public_social_live_foundation.sql',
  import.meta.url,
);

test('0052 installs encrypted exact-profile evidence and no plaintext provider credential column', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.ok(sql.indexOf('CREATE ROLE r72_owned_social_command') < sql.indexOf('SET LOCAL ROLE r72_owner'));
  assert.match(sql, /secret_algorithm text NOT NULL CHECK \(secret_algorithm = 'aes-256-gcm-v1'\)/u);
  for (const field of [
    'profile_key_iv', 'profile_key_ciphertext', 'profile_key_auth_tag',
    'profile_key_aad_sha256', 'profile_key_sha256', 'x_oauth_link_evidence_sha256',
  ]) assert.match(sql, new RegExp(`\\b${field}\\b`, 'u'));
  assert.doesNotMatch(sql, /\b(api_key|x_oauth1_api_key|x_oauth1_api_secret)\b/u);
  assert.match(sql, /provider_id text NOT NULL CHECK \(provider_id = 'ayrshare'\)/u);
  assert.match(sql, /network text NOT NULL CHECK \(network = 'x'\)/u);
  assert.match(sql, /propertypredator[.]owned-public-social-live\/v1/u);
  assert.match(sql, /p_profile_key_aad_sha256 <> public[.]digest/u);
});

test('0052 has hard one/day three/month caps, single lease and outcome-unknown terminal fence', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.match(sql, /property_predator_owned_social_profiles AS profile[\s\S]+FOR UPDATE[\s\S]+\) >= 1[\s\S]*\) >= 3 THEN/u);
  assert.match(sql, /selected_effect_at := greatest[\s\S]+job[.]utc_day = \(selected_effect_at AT TIME ZONE 'UTC'\)/u);
  assert.match(sql, /job[.]utc_day = \(statement_timestamp\(\) AT TIME ZONE 'UTC'\)::date[\s\S]+capped_day[\s\S]+capped_month/u);
  assert.match(sql, /\) >= 1[\s\S]*\) >= 3 THEN/u);
  assert.match(sql, /LIMIT 1 FOR UPDATE SKIP LOCKED/u);
  assert.match(sql, /public\.digest\(p_lease_token, 'sha256'\)/u);
  assert.match(sql, /ELSE next_state := 'needs_attention'/u);
  assert.match(sql, /worker_call_lease_expired_unknown/u);
  assert.match(sql, /WHEN recovered[.]state = 'calling' THEN 'needs_attention'/u);
  assert.match(sql, /UNIQUE \(workspace_id, idempotency_key_sha256\)/u);
  assert.match(sql, /UNIQUE \(workspace_id, job_id, lease_version\)/u);
  assert.match(sql, /Owned public-social job identity evidence is immutable/u);
  assert.match(sql, /NEW[.]text_body IS DISTINCT FROM OLD[.]text_body/u);
});

test('0052 keeps login roles table-blind behind exact function grants', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.match(sql, /REVOKE ALL ON ALL TABLES IN SCHEMA app FROM[\s\S]*r72_owned_social_command/u);
  assert.match(sql, /session_user <> 'r72_owned_social_command'/u);
  assert.match(sql, /session_user <> 'r72_owned_social_worker_command'/u);
  assert.match(sql, /NOT p_provider_effects_enabled OR p_emergency_paused/u);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app_private\.begin_owned_social_call/u);
  assert.match(
    sql,
    /GRANT EXECUTE ON FUNCTION app_private\.runtime_schema_migrations\(\),[\s\S]+runtime_database_installation_id\(\)[\s\S]+TO r72_owned_social_worker_command/u,
  );
  assert.match(sql, /Owned-social worker runtime readiness capability is incomplete/u);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app_private\.revoke_owned_social_profile/u);
  assert.match(sql, /property_predator_owned_social_profile_revocations/u);
  for (const dependency of [
    'provider_connections', 'workspace_memberships', 'company_content_versions',
    'company_content_approval_requests', 'company_content_approval_decisions',
    'company_content_source_attestations',
  ]) assert.match(sql, new RegExp(`CREATE POLICY ${dependency}_owned_social_definer_select`, 'u'));
  assert.match(sql, /begin_owned_social_call[\s\S]+connection[.]status = 'active'[\s\S]+profile_revocations/u);
  assert.match(sql, /Unsafe owned-social table capability/u);
  assert.doesNotMatch(sql, /GRANT (SELECT|INSERT|UPDATE|DELETE)[\s\S]{0,100}TO r72_owned_social_(?:command|worker_command)/u);
});
