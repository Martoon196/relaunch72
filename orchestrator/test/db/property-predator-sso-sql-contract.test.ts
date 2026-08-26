import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../src/db/migrations/0029_property_predator_sso_identity.sql',
  import.meta.url,
);

function normalise(sql: string): string {
  return sql.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();
}

test('0029 stores one immutable Property Predator subject link per pre-existing HQ user', async () => {
  const sql = normalise(await readFile(migrationUrl, 'utf8'));
  assert.match(sql, /CREATE TABLE app\.user_external_identities \(/);
  assert.match(sql, /user_id uuid NOT NULL REFERENCES app\.users\(id\) ON DELETE RESTRICT/);
  assert.match(sql, /UNIQUE \(issuer, subject\)/);
  assert.match(sql, /UNIQUE \(issuer, user_id\)/);
  assert.match(sql, /normalized_issuer <> 'https:\/\/propertypredator\.com'/);
  assert.match(sql, /asserted_email citext NOT NULL/);
  assert.doesNotMatch(sql, /(?:access_token|refresh_token|id_token|google_token|jwt)/i);
});

test('0029 enforces exact affiliate metadata invariants and keeps attribution nullable', async () => {
  const sql = normalise(await readFile(migrationUrl, 'utf8'));
  assert.match(sql, /affiliate_member AND affiliate_id IS NOT NULL AND affiliate_code IS NOT NULL AND affiliate_code_status IS NOT NULL/);
  assert.match(sql, /NOT affiliate_member AND affiliate_id IS NULL AND affiliate_code IS NULL AND affiliate_code_status IS NULL/);
  assert.match(sql, /p_affiliate_member IS true AND \( p_affiliate_id IS NULL OR normalized_affiliate_code IS NULL OR normalized_affiliate_code_status IS NULL \)/);
  assert.match(sql, /referrer_affiliate_id uuid/);
  assert.match(sql, /source_attached_at timestamptz/);
});

test('0029 permits first link only through an explicit bootstrap user with active membership', async () => {
  const sql = normalise(await readFile(migrationUrl, 'utf8'));
  assert.match(sql, /IF selected_identity_id IS NULL THEN IF p_bootstrap_user_id IS NULL THEN RETURN/);
  assert.match(sql, /selected_user_id := p_bootstrap_user_id/);
  assert.match(sql, /person\.id = selected_user_id AND person\.status IN \('pending', 'active'\)/);
  assert.match(sql, /membership\.user_id = selected_user_id AND membership\.status = 'active'/);
  assert.match(sql, /workspace\.status = 'active' AND organization\.status = 'active'/);
  assert.match(sql, /source_membership\.status = 'active' FOR SHARE OF source_membership/);
  assert.match(sql, /existing_user_identity\.issuer = normalized_issuer AND existing_user_identity\.user_id = selected_user_id FOR UPDATE OF existing_user_identity/);
  assert.doesNotMatch(sql, /INSERT INTO app\.(?:users|organizations|workspaces|workspace_memberships|organization_memberships)/);
  assert.match(sql, /SET status = 'active'/);
  assert.match(sql, /lower\(person\.email::text\) = normalized_asserted_email THEN coalesce\(person\.email_verified_at/);
  assert.doesNotMatch(sql, /SET email\s*=/);
});

test('0029 issues an ordinary opaque HQ session with federated provenance and retires setup links', async () => {
  const sql = normalise(await readFile(migrationUrl, 'utf8'));
  assert.match(sql, /ALTER TABLE app\.user_sessions ADD COLUMN external_identity_id uuid REFERENCES app\.user_external_identities\(id\) ON DELETE RESTRICT/);
  assert.match(sql, /CREATE INDEX user_sessions_external_identity_idx ON app\.user_sessions \(external_identity_id, created_at DESC\) WHERE external_identity_id IS NOT NULL/);
  assert.match(sql, /UPDATE app\.identity_action_tokens AS action_token SET revoked_at = statement_timestamp\(\)/);
  assert.match(sql, /action_token\.purpose = 'account_setup'/);
  assert.match(sql, /INSERT INTO app\.user_sessions \( token_hash, csrf_secret_hash, user_id, selected_workspace_id, external_identity_id, expires_at, ip_hash, user_agent_hash \)/);
  assert.match(sql, /p_session_token_hash/);
  assert.match(sql, /selected_expires_at timestamptz := statement_timestamp\(\) \+ interval '24 hours'/);
  assert.doesNotMatch(sql, /selected_expires_at timestamptz := statement_timestamp\(\) \+ interval '14 days'/);
  assert.doesNotMatch(sql, /RETURN QUERY SELECT[^;]*(?:token_hash|csrf_secret_hash)/);
});

test('0029 keeps the table behind forced RLS and exposes only one definer command', async () => {
  const sql = normalise(await readFile(migrationUrl, 'utf8'));
  assert.match(sql, /ALTER TABLE app\.user_external_identities ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /ALTER TABLE app\.user_external_identities FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /SECURITY DEFINER SET search_path = pg_catalog/);
  assert.match(sql, /REVOKE ALL ON app\.user_external_identities FROM r72_web, r72_public, r72_worker, r72_webhook, r72_readonly/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app_private\.create_portal_external_identity_session\([^;]+\) TO r72_identity_command/);
  assert.doesNotMatch(sql, /GRANT EXECUTE ON FUNCTION app_private\.create_portal_external_identity_session\([^;]+\) TO (?:r72_web|r72_public|r72_worker|r72_webhook|r72_readonly)/);
  assert.doesNotMatch(sql, /app_private\.[a-z_]*(?:send|publish|dispatch|provider_effect)[a-z_]*\s*\(/i);
});
