import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../src/db/migrations/0087_property_predator_zernio_live_channel_truth.sql',
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
  assert.notEqual(from, -1, `missing SQL section start: ${start}`);
  assert.notEqual(to, -1, `missing SQL section end: ${end}`);
  return source.slice(from, to);
}

test('0087 preserves the typed truth contract and replaces only its owned-social row', async () => {
  const source = await sql();
  assert.match(
    source,
    /ALTER FUNCTION app_private\.property_predator_live_channel_truth\(\) RENAME TO property_predator_live_channel_truth_pre_zernio/u,
  );
  const replacement = between(
    source,
    'CREATE FUNCTION app_private.property_predator_live_channel_truth()',
    'RESET ROLE',
  );
  assert.match(
    replacement,
    /RETURNS TABLE \( workspace_id uuid, snapshot_at timestamptz, rail text, connection_state text, inbound_state text, outbound_or_reply_state text, receipt_state text, daily_used bigint, daily_limit bigint, monthly_used bigint, monthly_limit bigint, blocker_codes text\[\], latest_receipt_id uuid, latest_receipt_outcome text, latest_receipt_at timestamptz, latest_receipt_evidence_sha256 text \)/u,
  );
  assert.match(
    replacement,
    /FROM app_private\.property_predator_live_channel_truth_pre_zernio\(\) AS legacy/u,
  );
  assert.match(
    replacement,
    /LEFT JOIN LATERAL app_private\.property_predator_zernio_owned_social_truth\( legacy\.workspace_id, legacy\.snapshot_at \) AS zernio ON legacy\.rail = 'owned_social'/u,
  );
  assert.match(
    replacement,
    /CASE WHEN legacy\.rail = 'owned_social' THEN zernio\.connection_state ELSE legacy\.connection_state END/u,
  );
  assert.doesNotMatch(replacement, /provider_id = 'ayrshare'|network = 'x'/u);
});

test('0087 requires an active non-revoked Zernio account and signed current binding', async () => {
  const source = await sql();
  const helper = between(
    source,
    'CREATE FUNCTION app_private.property_predator_zernio_owned_social_truth',
    'CREATE FUNCTION app_private.property_predator_live_channel_truth()',
  );
  assert.match(helper, /session_user <> 'r72_web'/u);
  assert.match(helper, /membership\.status = 'active'/u);
  assert.match(helper, /connection\.provider_id = 'zernio'/u);
  assert.match(helper, /connection\.provider_kind = 'social'/u);
  assert.match(helper, /connection\.environment = 'live'/u);
  assert.match(helper, /connection\.status = 'active'/u);
  assert.match(helper, /binding\.provider_id = 'zernio'/u);
  assert.match(helper, /binding\.network IN \('instagram', 'linkedin'\)/u);
  assert.match(helper, /account\.status = 'active'/u);
  assert.match(helper, /account\.provider_profile_id_sha256 = binding\.provider_profile_id_sha256/u);
  assert.match(helper, /account\.provider_account_id_sha256 = binding\.provider_account_id_sha256/u);
  assert.match(helper, /property_predator_zernio_publish_binding_revocations AS revocation/u);
  assert.match(helper, /connected_receipt\.event_type = 'account\.connected'/u);
  assert.match(helper, /connected_receipt\.receipt_sha256 = binding\.ownership_evidence_sha256/u);
  assert.match(helper, /disconnected_receipt\.event_type = 'account\.disconnected'/u);
  assert.match(helper, /disconnected_receipt\.occurred_at >= connected_receipt\.occurred_at/u);
});

test('0087 reports 1/day and 3/month at Zernio account/network grain', async () => {
  const source = await sql();
  const helper = between(
    source,
    'CREATE FUNCTION app_private.property_predator_zernio_owned_social_truth',
    'CREATE FUNCTION app_private.property_predator_live_channel_truth()',
  );
  assert.match(helper, /job\.provider_id = 'zernio'/u);
  assert.match(helper, /job\.zernio_account_id = scope\.zernio_account_id/u);
  assert.match(helper, /job\.network = scope\.network/u);
  assert.match(
    helper,
    /GROUP BY scope\.zernio_account_id, scope\.network/u,
  );
  assert.match(
    helper,
    /job\.utc_day = \(p_snapshot_at AT TIME ZONE 'UTC'\)::date/u,
  );
  assert.match(
    helper,
    /job\.utc_month = date_trunc\('month', p_snapshot_at AT TIME ZONE 'UTC'\)::date/u,
  );
  assert.match(helper, /least\(coalesce\(max\(scope_usage\.daily_used\), 0\), 1::bigint\)/u);
  assert.match(helper, /least\(coalesce\(max\(scope_usage\.monthly_used\), 0\), 3::bigint\)/u);
  assert.match(helper, /facts\.daily_used >= 1 OR facts\.monthly_used >= 3 AS cap_reached/u);
  assert.match(helper, /WHEN states\.cap_reached THEN 'cap_reached'/u);
  assert.match(helper, /CASE WHEN states\.cap_reached THEN 'CAP_REACHED' END/u);
});

test('0087 uses only Zernio jobs and receipts and keeps ambiguous outcomes quarantined', async () => {
  const source = await sql();
  const helper = between(
    source,
    'CREATE FUNCTION app_private.property_predator_zernio_owned_social_truth',
    'CREATE FUNCTION app_private.property_predator_live_channel_truth()',
  );
  assert.match(
    helper,
    /JOIN app\.property_predator_owned_social_jobs AS job ON job\.workspace_id = receipt\.workspace_id AND job\.id = receipt\.job_id/u,
  );
  assert.match(helper, /job\.provider_id = 'zernio'/u);
  assert.match(helper, /receipt\.provider_id = 'zernio'/u);
  assert.match(helper, /receipt\.event_kind = 'outcome_unknown'/u);
  assert.match(helper, /FROM ambiguous_receipt AS receipt UNION ALL SELECT/u);
  assert.match(helper, /WHERE NOT EXISTS \(SELECT 1 FROM ambiguous_receipt\)/u);
  assert.match(helper, /WHEN 'accepted' THEN 'pending'/u);
  assert.match(helper, /WHEN 'published' THEN 'healthy'/u);
  assert.match(helper, /WHEN 'failed' THEN 'needs_attention'/u);
  assert.match(helper, /WHEN 'outcome_unknown' THEN 'outcome_unknown'/u);
  assert.match(helper, /THEN 'OUTCOME_UNKNOWN_QUARANTINED'/u);
  assert.doesNotMatch(helper, /property_predator_owned_social_profiles/u);
});

test('0087 keeps durable pause and current approved-content evidence in the owned-social row', async () => {
  const source = await sql();
  const helper = between(
    source,
    'CREATE FUNCTION app_private.property_predator_zernio_owned_social_truth',
    'CREATE FUNCTION app_private.property_predator_live_channel_truth()',
  );
  assert.match(helper, /pause\.scope IN \('all', 'owned_social'\)/u);
  assert.match(helper, /CASE WHEN states\.emergency_paused THEN 'EMERGENCY_PAUSED' END/u);
  assert.match(helper, /version\.content_kind = 'social_post'/u);
  assert.match(helper, /decision\.decision = 'approved'/u);
  assert.match(helper, /newer\.version_number > version\.version_number/u);
  assert.match(helper, /THEN 'APPROVED_CONTENT_REQUIRED'/u);
  assert.match(
    helper,
    /WHEN NOT states\.binding_ready OR states\.ambiguous_outcome OR states\.emergency_paused THEN 'blocked'/u,
  );
});

test('0087 grants only scoped definer reads and the existing web truth entry point', async () => {
  const source = await sql();
  assert.match(
    source,
    /GRANT SELECT \( workspace_id, id, provider_connection_id, provider_profile_id_sha256, provider_account_id_sha256, network, status, environment \) ON app\.property_predator_zernio_accounts TO r72_operational_inbox_definer/u,
  );
  assert.match(
    source,
    /CREATE POLICY operational_channel_truth_zernio_accounts_select ON app\.property_predator_zernio_accounts FOR SELECT TO r72_operational_inbox_definer/u,
  );
  assert.match(
    source,
    /REVOKE ALL ON FUNCTION app_private\.property_predator_live_channel_truth_pre_zernio\(\) FROM PUBLIC, r72_web/u,
  );
  assert.match(
    source,
    /REVOKE ALL ON FUNCTION app_private\.property_predator_zernio_owned_social_truth\( uuid, timestamptz \) FROM PUBLIC, r72_web/u,
  );
  assert.match(
    source,
    /GRANT EXECUTE ON FUNCTION app_private\.property_predator_live_channel_truth\(\) TO r72_web/u,
  );
  assert.match(source, /r72_zernio_social_command', 'r72_owned_social_worker_command/u);
  assert.match(source, /Zernio live truth login has direct table capability/u);
  assert.match(source, /Unsafe Zernio live truth function ACL/u);
  assert.match(source, /Zernio live truth can read forbidden account column/u);
  assert.match(source, /Zernio live truth can read forbidden binding column/u);
  assert.match(source, /Zernio live truth can read forbidden revocation column/u);
  assert.match(source, /Zernio live truth can read forbidden webhook column/u);
  assert.doesNotMatch(
    source,
    /GRANT (?:SELECT|INSERT|UPDATE|DELETE|TRUNCATE)[^;]+ TO (?:r72_zernio_social_command|r72_owned_social_worker_command)/u,
  );
  assert.doesNotMatch(source, /GRANT EXECUTE[^;]+ TO PUBLIC/u);
});

test('0087 truth helper is read-only', async () => {
  const source = await sql();
  const helper = between(
    source,
    'CREATE FUNCTION app_private.property_predator_zernio_owned_social_truth',
    'CREATE FUNCTION app_private.property_predator_live_channel_truth()',
  );
  for (const mutation of [
    /\bINSERT INTO\b/u,
    /\bUPDATE app\./u,
    /\bDELETE FROM\b/u,
    /\bTRUNCATE\b/u,
    /\bFOR UPDATE\b/u,
  ]) {
    assert.doesNotMatch(helper, mutation);
  }
  assert.match(helper, /LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog/u);
});
