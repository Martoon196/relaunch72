import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../src/db/migrations/0085_property_predator_zernio_calendar_publishing.sql',
  import.meta.url,
);
const emergencyPauseUrl = new URL(
  '../../src/db/migrations/0057_property_predator_live_channel_emergency_pause.sql',
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
  assert.notEqual(from, -1, `missing SQL section start: ${start}`);
  assert.notEqual(to, -1, `missing SQL section end: ${end}`);
  return source.slice(from, to);
}

test('0085 adds a provider-qualified Zernio binding without relabelling Ayrshare evidence', async () => {
  const source = await sql();
  assert.match(source, /SET LOCAL ROLE r72_owner/u);
  assert.match(source, /CREATE TABLE app\.property_predator_zernio_publish_bindings/u);
  assert.match(source, /CREATE TABLE app\.property_predator_zernio_publish_binding_revocations/u);
  assert.match(source, /provider_id text NOT NULL CHECK \(provider_id = 'zernio'\)/u);
  assert.match(
    source,
    /adapter_contract text NOT NULL DEFAULT 'propertypredator\.zernio-calendar-publishing\/v1'/u,
  );
  assert.match(source, /ADD COLUMN provider_id text NOT NULL DEFAULT 'ayrshare'/u);
  assert.match(source, /ALTER COLUMN profile_id DROP NOT NULL/u);
  assert.match(
    source,
    /provider_id = 'ayrshare' AND profile_id IS NOT NULL AND zernio_publish_binding_id IS NULL AND zernio_account_id IS NULL/u,
  );
  assert.match(
    source,
    /provider_id = 'zernio' AND profile_id IS NULL AND zernio_publish_binding_id IS NOT NULL AND zernio_account_id IS NOT NULL/u,
  );
  assert.match(
    source,
    /FOREIGN KEY \( workspace_id, zernio_publish_binding_id, provider_connection_id, provider_id, network, zernio_account_id \) REFERENCES app\.property_predator_zernio_publish_bindings/u,
  );
  assert.match(
    source,
    /CREATE UNIQUE INDEX property_predator_zernio_calendar_jobs_external_id_uq ON app\.property_predator_owned_social_jobs \(workspace_id, zernio_account_id, provider_external_id\)/u,
  );
  assert.doesNotMatch(source, /UPDATE app\.property_predator_owned_social_profiles/u);
  assert.doesNotMatch(source, /ALTER TABLE app\.property_predator_owned_social_profiles/u);
  assert.doesNotMatch(source, /profile_key_(?:iv|ciphertext|auth_tag|sha256)/u);
});

test('0085 records only an exact active Zernio account with immutable signed ownership evidence', async () => {
  const source = await sql();
  const record = between(
    source,
    'CREATE FUNCTION app_private.record_zernio_calendar_publish_binding',
    'CREATE FUNCTION app_private.revoke_zernio_calendar_publish_binding',
  );
  assert.match(record, /session_user <> 'r72_zernio_social_command'/u);
  assert.match(record, /membership\.role IN \('owner', 'admin'\)/u);
  assert.match(record, /connection\.provider_id = 'zernio'/u);
  assert.match(record, /connection\.provider_kind = 'social'/u);
  assert.match(record, /connection\.environment = 'live' AND connection\.status = 'active'/u);
  assert.match(record, /account\.status = 'active'/u);
  assert.match(record, /connected_receipt\.event_type = 'account\.connected'/u);
  assert.match(
    record,
    /connected_receipt\.receipt_sha256 = p_ownership_evidence_sha256/u,
  );
  assert.match(record, /disconnected_receipt\.event_type = 'account\.disconnected'/u);
  assert.match(
    record,
    /disconnected_receipt\.occurred_at >= connected_receipt\.occurred_at/u,
  );
  assert.match(record, /Zernio calendar publish binding is revoked/u);
  assert.match(source, /BEFORE UPDATE OR DELETE ON app\.property_predator_zernio_publish_bindings/u);
  assert.match(
    source,
    /BEFORE UPDATE OR DELETE ON app\.property_predator_zernio_publish_binding_revocations/u,
  );
});

test('0085 enqueues the exact approved calendar target with serialised hard caps', async () => {
  const source = await sql();
  const enqueue = between(
    source,
    'CREATE FUNCTION app_private.enqueue_zernio_calendar_job',
    'CREATE FUNCTION app_private.record_zernio_calendar_publish_binding',
  );
  assert.match(enqueue, /session_user <> 'r72_zernio_social_command'/u);
  assert.match(enqueue, /target\.account_ref_sha256 = p_expected_provider_account_id_sha256/u);
  assert.match(enqueue, /decision\.decision = 'approved'/u);
  assert.match(enqueue, /later_request\.request_number > request\.request_number/u);
  assert.match(enqueue, /newer\.version_number > version\.version_number/u);
  assert.match(enqueue, /media_attestation\.expires_at > statement_timestamp\(\)/u);
  assert.match(enqueue, /selected_media_count <> planned_media_count/u);
  assert.match(enqueue, /propertypredator\.zernio-calendar-job\/v1/u);
  assert.match(enqueue, /p_request_sha256 <> public\.digest\(pg_catalog\.format/u);
  assert.match(enqueue, /public-social-planning-target:/u);
  assert.match(enqueue, /zernio-calendar-publish-binding:/u);
  assert.match(enqueue, /zernio-calendar-publish-account:/u);
  assert.ok(
    enqueue.indexOf("'public-social-planning-target:'")
      < enqueue.indexOf("'zernio-calendar-publish-binding:'")
      && enqueue.indexOf("'zernio-calendar-publish-binding:'")
        < enqueue.indexOf("'zernio-calendar-publish-account:'")
      && enqueue.indexOf("'zernio-calendar-publish-account:'")
        < enqueue.indexOf('PERFORM binding.id'),
    'enqueue must lock target, binding and immutable account before trusting active binding state',
  );
  assert.match(enqueue, /job\.utc_day = \(selected_effect_at AT TIME ZONE 'UTC'\)::date/u);
  assert.match(enqueue, /job\.utc_month = date_trunc\('month', selected_effect_at AT TIME ZONE 'UTC'\)::date/u);
  assert.match(enqueue, /job\.zernio_account_id = p_zernio_account_id/u);
  assert.match(enqueue, /job\.network = p_network/u);
  assert.doesNotMatch(
    enqueue,
    /job\.zernio_publish_binding_id = p_binding_id[\s\S]{0,180}job\.utc_(?:day|month)/u,
  );
  assert.match(enqueue, /\) >= 1 OR \(SELECT count\(\*\)[\s\S]+\) >= 3/u);
  assert.match(
    enqueue,
    /selected_id, p_workspace_id, p_provider_connection_id, 'zernio', NULL, p_binding_id, p_zernio_account_id/u,
  );
  assert.match(enqueue, /existing\.provider_id <> 'zernio'/u);
  assert.match(enqueue, /existing\.request_sha256 <> p_request_sha256/u);
});

test('0085 claim and begin-call revalidate proof, binding, lease and durable pauses', async () => {
  const source = await sql();
  const claim = between(
    source,
    'CREATE FUNCTION app_private.claim_zernio_calendar_job',
    'CREATE FUNCTION app_private.begin_zernio_calendar_call',
  );
  const begin = between(
    source,
    'CREATE FUNCTION app_private.begin_zernio_calendar_call',
    'CREATE FUNCTION app_private.load_zernio_calendar_job',
  );
  assert.match(claim, /session_user <> 'r72_owned_social_worker_command'/u);
  assert.match(claim, /job\.provider_id = 'zernio'/u);
  assert.match(
    claim,
    /job_id uuid, binding_id uuid, zernio_account_id uuid, lease_version bigint, attempt_kind text, network text/u,
  );
  assert.match(claim, /recovered\.state = 'calling'/u);
  assert.match(claim, /'outcome_unknown'/u);
  assert.match(claim, /job\.claim_count >= 12/u);
  assert.match(claim, /job\.claim_count < 12/u);
  assert.match(claim, /app_private\.zernio_calendar_job_effect_ready/u);
  assert.match(claim, /app_private\.zernio_calendar_binding_ready/u);
  assert.match(claim, /FOR UPDATE SKIP LOCKED/u);
  assert.match(
    claim,
    /selected\.zernio_account_id, next_version, selected_kind, selected\.network/u,
  );
  assert.match(begin, /p_provider_effects_enabled IS DISTINCT FROM true/u);
  assert.match(begin, /p_emergency_paused IS DISTINCT FROM false/u);
  assert.doesNotMatch(begin, /OR NOT p_provider_effects_enabled OR p_emergency_paused/u);
  assert.match(begin, /lease\.lease_token_sha256 = public\.digest\(p_lease_token, 'sha256'\)/u);
  assert.match(begin, /ORDER BY content_identity\.content_item_id/u);
  assert.ok(
    begin.indexOf("'public-social-planning-target:'")
      < begin.indexOf("'company-content:'")
      && begin.indexOf("'company-content:'")
        < begin.indexOf("'zernio-calendar-publish-binding:'")
      && begin.indexOf("'zernio-calendar-publish-binding:'")
        < begin.indexOf("'zernio-calendar-publish-account:'")
      && begin.indexOf("'zernio-calendar-publish-account:'")
        < begin.indexOf('FOR UPDATE OF job'),
    'provider-call lock order must be target, content, binding, account, then job row',
  );
  assert.match(begin, /capped_day\.zernio_account_id = job\.zernio_account_id/u);
  assert.match(begin, /capped_month\.zernio_account_id = job\.zernio_account_id/u);
  assert.match(begin, /app_private\.zernio_calendar_binding_ready\(job\.workspace_id, job\.id\)/u);
  assert.match(begin, /app_private\.zernio_calendar_job_effect_ready\(job\.workspace_id, job\.id\)/u);

  const pause = (await readFile(emergencyPauseUrl, 'utf8')).replace(/\s+/gu, ' ');
  assert.match(
    pause,
    /CREATE TRIGGER owned_social_live_emergency_pause BEFORE UPDATE OF state ON app\.property_predator_owned_social_jobs/u,
  );
  assert.doesNotMatch(source, /DISABLE TRIGGER owned_social_live_emergency_pause/u);
  assert.doesNotMatch(source, /DROP TRIGGER owned_social_live_emergency_pause/u);
});

test('0085 loads API-key-free Zernio material and settles provider receipts idempotently', async () => {
  const source = await sql();
  const load = between(
    source,
    'CREATE FUNCTION app_private.load_zernio_calendar_job',
    'CREATE FUNCTION app_private.settle_zernio_calendar_call',
  );
  const settle = between(
    source,
    'CREATE FUNCTION app_private.settle_zernio_calendar_call',
    'REVOKE ALL ON FUNCTION app_private.record_zernio_calendar_publish_binding',
  );
  assert.match(load, /provider_profile_id_sha256 bytea, provider_account_id_sha256 bytea/u);
  assert.match(load, /binding\.provider_profile_id_sha256, binding\.provider_account_id_sha256/u);
  assert.match(load, /job\.provider_id = 'zernio' AND job\.profile_id IS NULL/u);
  assert.match(load, /jsonb_agg\(jsonb_build_object/u);
  assert.doesNotMatch(load, /api[_ ]?key|bearer|credential|secret|profile_key/iu);

  assert.match(settle, /p_result_state NOT IN \('accepted', 'published', 'failed', 'outcome_unknown'\)/u);
  assert.match(settle, /p_lease_token IS NULL OR octet_length\(p_lease_token\) <> 32/u);
  assert.match(settle, /p_result_state IS NULL/u);
  assert.match(settle, /p_receipt_sha256 IS NULL/u);
  assert.match(settle, /p_safe_code IS NULL/u);
  assert.match(
    settle,
    /p_result_state IN \('accepted', 'published'\) AND p_provider_external_id IS NULL/u,
  );
  assert.match(settle, /existing_receipt\.receipt_sha256 <> p_receipt_sha256/u);
  assert.match(settle, /existing_receipt\.lease_token_sha256 IS NULL/u);
  assert.match(
    settle,
    /existing_receipt\.lease_token_sha256 <> public\.digest\(p_lease_token, 'sha256'\)/u,
  );
  assert.match(settle, /RETURN 'replayed'/u);
  assert.match(settle, /provider_id = 'zernio'/u);
  assert.match(settle, /p_workspace_id, p_job_id, p_lease_version, 'zernio'/u);
  assert.match(settle, /p_provider_occurred_at, public\.digest\(p_lease_token, 'sha256'\)/u);
  assert.match(settle, /next_state := 'reconciliation_pending'/u);
  assert.match(settle, /next_state := 'needs_attention'/u);
  assert.match(settle, /RETURN 'recorded'/u);
});

test('0085 keeps both login identities table-blind and exposes only exact commands', async () => {
  const source = await sql();
  for (const table of [
    'property_predator_zernio_publish_bindings',
    'property_predator_zernio_publish_binding_revocations',
  ]) {
    assert.match(source, new RegExp(`ALTER TABLE app\\.${table} ENABLE ROW LEVEL SECURITY`, 'u'));
    assert.match(source, new RegExp(`ALTER TABLE app\\.${table} FORCE ROW LEVEL SECURITY`, 'u'));
  }
  assert.match(
    source,
    /GRANT EXECUTE ON FUNCTION app_private\.record_zernio_calendar_publish_binding[\s\S]+TO r72_zernio_social_command/u,
  );
  assert.match(
    source,
    /GRANT EXECUTE ON FUNCTION app_private\.claim_zernio_calendar_job[\s\S]+TO r72_owned_social_worker_command/u,
  );
  assert.match(source, /has_table_privilege\( 'r72_zernio_social_command'/u);
  assert.match(source, /has_table_privilege\( 'r72_owned_social_worker_command'/u);
  assert.match(source, /privilege\.grantee = 0 AND privilege\.privilege_type = 'EXECUTE'/u);
  assert.match(source, /Unsafe Zernio calendar user-command function ACL/u);
  assert.match(source, /Unsafe Zernio calendar worker function ACL/u);
  for (const dormantFunction of [
    'record_owned_social_profile',
    'revoke_owned_social_profile',
    'enqueue_owned_social_job',
    'record_owned_social_profile_v2',
    'enqueue_owned_social_job_v2',
  ]) {
    assert.match(
      source,
      new RegExp(`REVOKE EXECUTE ON FUNCTION app_private\\.${dormantFunction}\\([\\s\\S]+?\\) FROM r72_owned_social_command`, 'u'),
    );
  }
  for (const dormantFunction of [
    'claim_owned_social_job',
    'begin_owned_social_call',
    'load_owned_social_job',
    'claim_owned_social_job_v2',
    'begin_owned_social_call_v2',
    'load_owned_social_job_v2',
    'settle_owned_social_call',
  ]) {
    assert.match(
      source,
      new RegExp(`REVOKE EXECUTE ON FUNCTION app_private\\.${dormantFunction}\\([\\s\\S]+?\\) FROM r72_owned_social_worker_command`, 'u'),
    );
  }
  assert.doesNotMatch(
    source,
    /GRANT (?:SELECT|INSERT|UPDATE|DELETE|TRUNCATE)[^;]+ TO (?:r72_zernio_social_command|r72_owned_social_worker_command)/u,
  );
  assert.doesNotMatch(source, /GRANT EXECUTE[^;]+ TO PUBLIC/u);
  assert.match(
    source,
    /INSERT INTO app_private\.workspace_table_registry[\s\S]+property_predator_zernio_publish_bindings[\s\S]+property_predator_zernio_publish_binding_revocations/u,
  );
});
