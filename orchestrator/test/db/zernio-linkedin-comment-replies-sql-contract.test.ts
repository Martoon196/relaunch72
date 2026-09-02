import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migration79Url = new URL(
  '../../src/db/migrations/0079_property_predator_zernio_reply_lifecycle.sql',
  import.meta.url,
);
const migration86Url = new URL(
  '../../src/db/migrations/0086_property_predator_zernio_linkedin_comment_replies.sql',
  import.meta.url,
);

function normalise(sql: string): string {
  return sql.replace(/--[^\n]*/gu, ' ').replace(/\s+/gu, ' ').trim();
}

test('0086 forward-extends the draft network constraint without rewriting 0079 evidence', async () => {
  const [original, migration] = await Promise.all([
    readFile(migration79Url, 'utf8'), readFile(migration86Url, 'utf8'),
  ]);
  const source = normalise(migration);
  assert.match(normalise(original), /network text NOT NULL DEFAULT 'instagram' CHECK \(network = 'instagram'\)/u);
  assert.match(source, /DROP CONSTRAINT property_predator_zernio_reply_drafts_network_check/u);
  assert.match(source, /ADD CONSTRAINT property_predator_zernio_reply_drafts_network_check CHECK \(network IN \('instagram', 'linkedin'\)\) NOT VALID/u);
  assert.match(source, /VALIDATE CONSTRAINT property_predator_zernio_reply_drafts_network_check/u);
  assert.doesNotMatch(source, /ALTER COLUMN network (?:SET|DROP) DEFAULT/u);
  assert.doesNotMatch(source, /\b(?:UPDATE|DELETE|TRUNCATE)\s+app\.property_predator_zernio_reply/u);
});

test('0086 adds provider-qualified Zernio account and network truth with no secret output', async () => {
  const source = normalise(await readFile(migration86Url, 'utf8'));
  assert.match(source, /CREATE FUNCTION app_private\.zernio_reply_channel_truth\( p_workspace_id uuid, p_provider_connection_id uuid, p_provider_profile_id_sha256 bytea, p_provider_account_id_sha256 bytea, p_network text \)/u);
  assert.match(source, /RETURNS TABLE \( provider_id text, network text, connection_state text, account_state text, reply_state text, reply_ready boolean, blocker_codes text\[\] \)/u);
  assert.match(source, /connection\.provider_id = 'zernio' AND connection\.provider_kind = 'social' AND connection\.environment = 'live' AND connection\.status = 'active'/u);
  assert.match(source, /account\.provider_profile_id_sha256 = p_provider_profile_id_sha256 AND account\.provider_account_id_sha256 = p_provider_account_id_sha256 AND account\.network = p_network AND account\.environment = 'live' AND account\.status = 'active'/u);
  assert.match(source, /p_network IN \('instagram', 'linkedin'\)/u);
  assert.match(source, /'ZERNIO_CONNECTION_REQUIRED'/u);
  assert.match(source, /'ZERNIO_ACCOUNT_REQUIRED'/u);
  assert.doesNotMatch(source, /api[_ ]?key|bearer|access[_ ]?token|refresh[_ ]?token/iu);
});

test('0086 create and claim overloads bind the exact network through the immutable ledger', async () => {
  const source = normalise(await readFile(migration86Url, 'utf8'));
  assert.match(source, /CREATE FUNCTION app_private\.create_zernio_reply_draft\( p_workspace_id uuid, p_provider_connection_id uuid, p_draft_id uuid, p_network text,/u);
  assert.match(source, /existing\.provider_conversation_id_sha256 <> p_provider_conversation_id_sha256 OR existing\.network <> p_network/u);
  assert.match(source, /provider_account_id_sha256, provider_conversation_id_sha256, network, body_text/u);
  assert.match(source, /p_provider_conversation_id_sha256, p_network, p_body/u);
  assert.match(source, /CREATE FUNCTION app_private\.claim_zernio_reply_send\( p_workspace_id uuid, p_provider_connection_id uuid, p_draft_id uuid, p_delivery_id uuid, p_network text,/u);
  assert.match(source, /selected_draft\.provider_conversation_id_sha256 <> p_provider_conversation_id_sha256 OR selected_draft\.network <> p_network/u);
  assert.equal((source.match(/app_private\.zernio_reply_channel_truth\(/gu) ?? []).length >= 5, true);
  assert.match(source, /selected_decision\.decision <> 'approved'/u);
  assert.match(source, /idempotency_key_sha256, lease_token_sha256, state, requested_by_user_id/u);
  assert.match(
    source,
    /GRANT SELECT ON app\.property_predator_live_channel_pause_events TO r72_zernio_social_definer/u,
  );
  assert.match(source, /live_channel_pause_zernio_social_definer_select/u);
  assert.match(
    source,
    /FROM app\.property_predator_live_channel_pause_events AS pause WHERE pause\.workspace_id = p_workspace_id AND pause\.scope IN \('all', 'social_dm'\)[\s\S]+Zernio reply emergency pause is engaged/u,
  );
});

test('0086 retires ambiguous login surfaces and grants only exact overloads to the Zernio command role', async () => {
  const source = normalise(await readFile(migration86Url, 'utf8'));
  assert.match(source, /REVOKE EXECUTE ON FUNCTION app_private\.create_zernio_reply_draft\( uuid, uuid, uuid, bytea, bytea, bytea, text, bytea \) FROM r72_zernio_social_command/u);
  assert.match(source, /REVOKE EXECUTE ON FUNCTION app_private\.claim_zernio_reply_send\( uuid, uuid, uuid, uuid, bytea, bytea, bytea, bytea, bytea \) FROM r72_zernio_social_command/u);
  for (const signature of [
    'zernio_reply_channel_truth\\( uuid, uuid, bytea, bytea, text \\)',
    'create_zernio_reply_draft\\( uuid, uuid, uuid, text, bytea, bytea, bytea, text, bytea \\)',
    'claim_zernio_reply_send\\( uuid, uuid, uuid, uuid, text, bytea, bytea, bytea, bytea, bytea \\)',
  ]) {
    assert.match(source, new RegExp(`REVOKE ALL ON FUNCTION app_private\\.${signature} FROM PUBLIC`, 'u'));
    assert.match(source, new RegExp(`GRANT EXECUTE ON FUNCTION app_private\\.${signature} TO r72_zernio_social_command`, 'u'));
  }
  assert.match(source, /privilege\.grantee <> procedure\.proowner/u);
  assert.match(source, /role\.rolname = 'r72_zernio_social_command'/u);
  assert.match(source, /REVOKE CREATE ON SCHEMA app_private FROM r72_zernio_social_definer/u);
});
