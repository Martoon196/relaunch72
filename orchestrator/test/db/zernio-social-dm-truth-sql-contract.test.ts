import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../src/db/migrations/0089_property_predator_zernio_social_dm_truth.sql',
  import.meta.url,
);

async function sql(): Promise<string> {
  return (await readFile(migrationUrl, 'utf8'))
    .replace(/--[^\n]*/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `missing SQL boundary: ${start}`);
  return source.slice(from, to);
}

test('0089 replaces only the social-DM row and preserves the 0087 truth behind it', async () => {
  const source = await sql();
  assert.match(
    source,
    /ALTER FUNCTION app_private\.property_predator_live_channel_truth\(\) RENAME TO property_predator_live_channel_truth_pre_zernio_social_dm/u,
  );
  const wrapper = between(
    source,
    'CREATE FUNCTION app_private.property_predator_live_channel_truth()',
    'RESET ROLE;',
  );
  assert.match(
    wrapper,
    /FROM app_private\.property_predator_live_channel_truth_pre_zernio_social_dm\(\) AS legacy/u,
  );
  assert.match(wrapper, /legacy\.rail = 'social_dm'/u);
  assert.match(
    wrapper,
    /app_private\.property_predator_zernio_social_dm_truth\( legacy\.workspace_id, legacy\.snapshot_at \)/u,
  );
  assert.doesNotMatch(wrapper, /legacy\.rail = 'owned_social'/u);
});

test('0089 requires exact active live Zernio connection and signed current account evidence', async () => {
  const source = await sql();
  const helper = between(
    source,
    'CREATE FUNCTION app_private.property_predator_zernio_social_dm_truth',
    'CREATE FUNCTION app_private.property_predator_live_channel_truth()',
  );
  assert.match(helper, /connection\.provider_id = 'zernio'/u);
  assert.match(helper, /connection\.provider_kind = 'social'/u);
  assert.match(helper, /connection\.environment = 'live'/u);
  assert.match(helper, /connection\.status = 'active'/u);
  assert.match(helper, /account\.status = 'active'/u);
  assert.match(helper, /account\.network IN \('instagram', 'linkedin'\)/u);
  assert.match(helper, /connected\.event_type = 'account\.connected'/u);
  assert.match(helper, /disconnected\.event_type = 'account\.disconnected'/u);
  assert.match(
    helper,
    /disconnected\.provider_account_id_sha256 = connected\.provider_account_id_sha256/u,
  );
  assert.match(helper, /disconnected\.occurred_at >= connected\.occurred_at/u);
});

test('0089 derives reply approval, settlement and pause truth without provider effects', async () => {
  const source = await sql();
  const helper = between(
    source,
    'CREATE FUNCTION app_private.property_predator_zernio_social_dm_truth',
    'CREATE FUNCTION app_private.property_predator_live_channel_truth()',
  );
  assert.match(helper, /property_predator_zernio_reply_drafts/u);
  assert.match(helper, /property_predator_zernio_reply_approval_requests/u);
  assert.match(helper, /property_predator_zernio_reply_approval_decisions/u);
  assert.match(helper, /property_predator_zernio_reply_deliveries/u);
  assert.match(helper, /lifecycle\.decision = 'approved'/u);
  assert.match(helper, /delivery\.state = 'outcome_unknown'/u);
  assert.match(helper, /pause\.scope IN \('all', 'social_dm'\)/u);
  assert.match(helper, /THEN 'OUTCOME_UNKNOWN_QUARANTINED'/u);
  assert.match(helper, /THEN 'EMERGENCY_PAUSED'/u);
  assert.match(helper, /THEN 'APPROVAL_REQUIRED'/u);
  assert.match(helper, /0::bigint, 0::bigint, 0::bigint, 0::bigint/u);
  for (const mutation of [/\bINSERT INTO\b/u, /\bUPDATE app\./u, /\bDELETE FROM\b/u,
    /\bTRUNCATE\b/u, /\bFOR UPDATE\b/u]) {
    assert.doesNotMatch(helper, mutation);
  }
});

test('0089 exposes only aggregate evidence and keeps raw reply/provider material unreadable', async () => {
  const source = await sql();
  assert.match(
    source,
    /GRANT SELECT \( workspace_id, id, provider_connection_id, provider_profile_id_sha256, provider_account_id_sha256, network, body_sha256, created_at \) ON app\.property_predator_zernio_reply_drafts TO r72_operational_inbox_definer/u,
  );
  assert.match(source, /Zernio social DM truth can read forbidden reply material/u);
  assert.match(
    source,
    /REVOKE ALL ON FUNCTION app_private\.property_predator_zernio_social_dm_truth\( uuid, timestamptz \) FROM PUBLIC, r72_web/u,
  );
  assert.match(
    source,
    /GRANT EXECUTE ON FUNCTION app_private\.property_predator_live_channel_truth\(\) TO r72_web/u,
  );
  const grants = source.match(/GRANT SELECT[\s\S]*?TO r72_operational_inbox_definer;/gu) ?? [];
  assert.ok(grants.every((grant) => !/body_text|provider_conversation_id_sha256|provider_response_sha256|provider_message_id_sha256|requested_by_user_id|created_by_user_id/u.test(grant)));
  const helper = between(
    source,
    'CREATE FUNCTION app_private.property_predator_zernio_social_dm_truth',
    'CREATE FUNCTION app_private.property_predator_live_channel_truth()',
  );
  assert.doesNotMatch(helper, /body_text|username|display_name|raw_body_sha256|provider_response_sha256|provider_message_id_sha256/u);
  assert.match(helper, /public\.digest\(/u);
});
