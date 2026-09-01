import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../src/db/migrations/0066_instagram_linkedin_calendar_live_rail.sql',
  import.meta.url,
);

async function sql(): Promise<string> {
  return (await readFile(migrationUrl, 'utf8')).replace(/--[^\n]*/gu, ' ').replace(/\s+/gu, ' ');
}

function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `missing SQL section start: ${start}`);
  assert.notEqual(to, -1, `missing SQL section end: ${end}`);
  return source.slice(from, to);
}

test('0066 widens the live rail only to Instagram, LinkedIn and the deferred X identity', async () => {
  const source = await sql();
  assert.match(source, /CHECK \(network IN \('instagram', 'linkedin', 'x'\)\)/u);
  assert.match(source, /p_network NOT IN \('instagram', 'linkedin'\)/u);
  assert.match(source, /provider_permissions IN \('publish', 'read_write'\)/u);
  assert.match(source, /provider_id = 'ayrshare'/u);
  assert.doesNotMatch(source, /p_network (?:=|IN \()[^;]{0,120}'x'/u);
});

test('0066 binds one calendar job to exact immutable planning, approval and media evidence', async () => {
  const source = await sql();
  assert.match(source, /CREATE FUNCTION app_private\.enqueue_owned_social_job_v2/u);
  assert.match(
    source,
    /p_network text, p_expected_owned_account_sha256 bytea, p_planning_intent_id uuid, p_planning_target_id uuid/u,
  );
  assert.match(
    source,
    /p_expected_owned_account_sha256 IS NULL OR octet_length\(p_expected_owned_account_sha256\) <> 32/u,
  );
  assert.match(
    source,
    /profile\.owned_account_ref_sha256 = p_expected_owned_account_sha256/u,
  );
  assert.match(
    source,
    /profile\.owned_account_ref_sha256 = p_expected_owned_account_sha256[\s\S]+FOR UPDATE/u,
  );
  assert.match(source, /p_scheduled_for IS NULL/u);
  assert.match(source, /intent\.desired_for = p_scheduled_for/u);
  assert.match(source, /target\.target_id = p_planning_target_id/u);
  assert.match(source, /target\.network = p_network/u);
  assert.match(source, /planning_intent_id uuid/u);
  assert.match(source, /planning_target_id uuid/u);
  assert.match(
    source,
    /FOREIGN KEY \(workspace_id, planning_intent_id, planning_target_id\) REFERENCES app\.public_social_planning_intent_targets \(workspace_id, intent_id, target_id\)/u,
  );
  assert.match(source, /CHECK \(\(planning_intent_id IS NULL\) = \(planning_target_id IS NULL\)\)/u);
  assert.match(source, /NEW\.planning_target_id IS DISTINCT FROM OLD\.planning_target_id/u);
  assert.match(source, /existing\.planning_target_id IS DISTINCT FROM p_planning_target_id/u);
  assert.match(
    source,
    /planning_intent_id, planning_target_id, content_item_id[\s\S]+p_planning_intent_id, p_planning_target_id, p_content_item_id/u,
  );
  assert.match(source, /selected_media_count <> planned_media_count/u);
  assert.match(source, /p_network = 'instagram' AND selected_media_count NOT BETWEEN 1 AND 10/u);
  assert.match(source, /p_network = 'linkedin' AND selected_media_count > 9/u);
  assert.match(source, /later_request\.request_number > request\.request_number/u);
  assert.match(source, /later_media_request\.request_number > media_request\.request_number/u);
  assert.match(source, /newer\.version_number > version\.version_number/u);
  assert.match(source, /newer_media\.version_number > media_version\.version_number/u);
  assert.match(source, /attestation\.expires_at > statement_timestamp\(\)/u);
  assert.match(source, /media_attestation\.expires_at > statement_timestamp\(\)/u);
  assert.doesNotMatch(
    source,
    /(?:attestation|media_attestation)\.expires_at > greatest\(statement_timestamp\(\), p_scheduled_for\)/u,
  );
  assert.match(source, /CREATE TRIGGER property_predator_owned_social_job_media_immutable/u);
  assert.match(source, /CREATE TRIGGER property_predator_owned_social_jobs_calendar_identity_immutable/u);
});

test('0066 revalidates the exact active target and latest approved bytes at provider-call time', async () => {
  const source = await sql();
  const effect = between(
    source,
    'CREATE FUNCTION app_private.owned_social_job_effect_ready_v2',
    'CREATE FUNCTION app_private.claim_owned_social_job_v2',
  );
  assert.match(source, /CREATE FUNCTION app_private\.owned_social_job_effect_ready_v2/u);
  assert.match(source, /intent\.id = job\.planning_intent_id/u);
  assert.match(source, /intent\.desired_for = job\.scheduled_for/u);
  assert.match(source, /target\.intent_id = intent\.id/u);
  assert.match(source, /target\.target_id = job\.planning_target_id/u);
  assert.match(source, /target\.network = job\.network/u);
  assert.match(source, /cancellation\.target_id = target\.target_id/u);
  assert.match(source, /supersession\.predecessor_target_id = target\.target_id/u);
  assert.match(effect, /JOIN app\.public_social_revalidation_jobs AS revalidation/u);
  assert.match(effect, /revalidation\.state IN \('verified', 'materialized'\)/u);
  assert.match(effect, /proof\.id = revalidation\.current_proof_id/u);
  assert.match(effect, /proof\.intent_sha256 = intent\.intent_sha256/u);
  assert.match(effect, /proof\.content_version_id = intent\.content_version_id/u);
  assert.match(effect, /proof\.content_sha256 = intent\.content_sha256/u);
  assert.match(effect, /proof\.blob_sha256 = intent\.blob_sha256/u);
  assert.match(effect, /proof\.brand_sha256 = intent\.brand_sha256/u);
  assert.match(effect, /proof\.expires_at > statement_timestamp\(\)/u);
  assert.match(effect, /proof_media\.proof_id = proof\.id/u);
  assert.match(effect, /proof_media\.ordinal = planned_media\.ordinal/u);
  assert.match(effect, /proof_media\.source_catalog_sha256 = proof\.source_catalog_sha256/u);
  assert.match(effect, /proof_media\.expires_at <= statement_timestamp\(\)/u);
  assert.match(effect, /media\.blob_storage_key IS DISTINCT FROM media_version\.blob_storage_key/u);
  assert.match(effect, /media\.content_mime_type IS DISTINCT FROM media_version\.content_mime_type/u);
  assert.doesNotMatch(effect, /company_content_source_attestations/u);
  assert.doesNotMatch(effect, /attestation\.expires_at/u);
  assert.match(source, /CREATE FUNCTION app_private\.claim_owned_social_job_v2/u);
  assert.match(source, /job\.network = ANY\(p_networks\)/u);
  assert.match(source, /NOT app_private\.owned_social_job_effect_ready_v2\(job\.workspace_id, job\.id\)/u);
  assert.match(source, /job\.available_at <= statement_timestamp\(\) - interval '5 minutes'/u);
  assert.match(source, /CREATE FUNCTION app_private\.begin_owned_social_call_v2/u);
  assert.match(
    source,
    /selected\.planning_intent_id::text \|\| ':' \|\| selected\.planning_target_id::text/u,
  );
  const begin = between(
    source,
    'CREATE FUNCTION app_private.begin_owned_social_call_v2',
    'CREATE FUNCTION app_private.load_owned_social_job_v2',
  );
  assert.ok(
    begin.indexOf('pg_advisory_xact_lock') < begin.indexOf('FOR UPDATE OF job'),
    'begin-call must take the target advisory lock before the live-job row lock',
  );
  assert.ok(
    begin.indexOf("'company-content:'") > begin.indexOf("'public-social-planning-target:'")
      && begin.indexOf("'company-content:'") < begin.indexOf('FOR UPDATE OF job'),
    'begin-call must lock target, then sorted content, then the live-job row',
  );
  assert.match(begin, /ORDER BY content_identity\.content_item_id/u);
  assert.equal((begin.match(/lease\.lease_token_sha256 = public\.digest\(p_lease_token/g) ?? []).length, 3);
  assert.match(source, /OR app_private\.owned_social_job_effect_ready_v2\(job\.workspace_id, job\.id\)/u);
  assert.doesNotMatch(
    source,
    /GRANT EXECUTE ON FUNCTION app_private\.owned_social_job_effect_ready_v2/u,
  );
});

test('0066 registers the new workspace-scoped media table', async () => {
  const source = await sql();
  assert.match(
    source,
    /INSERT INTO app_private\.workspace_table_registry \(schema_name, table_name, workspace_column\) VALUES \('app', 'property_predator_owned_social_job_media', 'workspace_id'\)/u,
  );
});

test('0066 accepts the real Property Predator asset route for an Instagram media enqueue', async () => {
  const source = await sql();
  const realAssetPath = '/api/internal/company-content/assets/77777777-7777-4777-8777-777777777777/file';
  const storagePattern = source.match(/blob_storage_key ~ '([^']+)'/u)?.[1];
  assert.ok(storagePattern, 'job-media storage-key constraint must retain an explicit allowlist');
  assert.match(source, /length\(blob_storage_key\) BETWEEN 1 AND 500/u);
  assert.equal(new RegExp(storagePattern).test(realAssetPath), true);
  assert.equal(realAssetPath.includes('..'), false);
  assert.equal(realAssetPath.includes('//'), false);

  assert.match(
    source,
    /p_network = 'instagram' AND selected_media_count NOT BETWEEN 1 AND 10/u,
  );
  assert.match(
    source,
    /INSERT INTO app[.]property_predator_owned_social_job_media[\s\S]+media_version[.]blob_storage_key[\s\S]+WHERE planned_media[.]workspace_id = p_workspace_id[\s\S]+AND planned_media[.]intent_id = p_planning_intent_id/u,
  );

  for (const unsafePath of [
    '//api/internal/company-content/assets/77777777-7777-4777-8777-777777777777/file',
    '/api/internal/company-content/assets/../secrets',
    '/api/internal/company-content/assets/key?token=secret',
  ]) {
    const accepted: boolean = new RegExp(storagePattern).test(unsafePath)
      && unsafePath.length <= 500
      && !unsafePath.includes('..')
      && !unsafePath.includes('//');
    assert.equal(accepted, false, `unsafe path unexpectedly accepted: ${unsafePath}`);
  }

  const payloadHelper = between(
    source,
    'CREATE OR REPLACE FUNCTION app_private.public_social_media_payload_supported',
    'CREATE OR REPLACE FUNCTION app_private.cancel_test_social_planning_target',
  );
  assert.match(payloadHelper, /length\(p_blob_storage_key\) BETWEEN 1 AND 500/u);
  assert.match(payloadHelper, /p_blob_storage_key ~ '\^\/\?\[A-Za-z0-9\]/u);
  assert.match(payloadHelper, /strpos\(p_blob_storage_key, '\.\.'\) = 0/u);
  assert.match(payloadHelper, /strpos\(p_blob_storage_key, '\/\/'\) = 0/u);
  const helperPattern = payloadHelper.match(/p_blob_storage_key ~ '([^']+)'/u)?.[1];
  assert.ok(helperPattern);
  assert.equal(new RegExp(helperPattern).test(realAssetPath), true);
  assert.equal(new RegExp(helperPattern).test(realAssetPath.slice(1)), true);
  assert.equal(new RegExp(helperPattern).test(`${'a'.repeat(500)}/`), false);
});

test('0066 preserves legacy X profile recording while filling provider-neutral evidence', async () => {
  const source = await sql();
  const legacy = between(
    source,
    'CREATE OR REPLACE FUNCTION app_private.record_owned_social_profile(',
    'CREATE FUNCTION app_private.record_owned_social_profile_v2',
  );
  assert.match(legacy, /provider_link_evidence_sha256, provider_permissions/u);
  assert.match(legacy, /x_oauth_link_evidence_sha256, x_oauth_permissions/u);
  assert.match(
    legacy,
    /p_x_oauth_link_evidence_sha256, 'read_write', p_x_oauth_link_evidence_sha256, 'read_write'/u,
  );
});

test('0066 serializes 0040 lifecycle changes with the exact live target and removes v1 worker bypasses', async () => {
  const source = await sql();
  const lifecycle = between(
    source,
    'CREATE FUNCTION app_private.assert_owned_social_target_lifecycle_changeable',
    'REVOKE ALL ON FUNCTION app_private.assert_owned_social_target_lifecycle_changeable',
  );
  assert.match(lifecycle, /job\.planning_intent_id = p_intent_id/u);
  assert.match(lifecycle, /job\.planning_target_id = p_target_id/u);
  assert.match(lifecycle, /ORDER BY job\.id FOR UPDATE/u);
  assert.match(lifecycle, /selected\.state NOT IN \('queued', 'cancelled'\)/u);
  assert.equal(
    (source.match(/PERFORM app_private\.assert_owned_social_target_lifecycle_changeable\(/gu) ?? []).length,
    2,
  );
  assert.match(
    source,
    /REVOKE EXECUTE ON FUNCTION app_private\.claim_owned_social_job\( uuid, uuid, bytea, integer \) FROM r72_owned_social_worker_command/u,
  );
  assert.match(
    source,
    /REVOKE EXECUTE ON FUNCTION app_private\.load_owned_social_job\( uuid, uuid, bigint, bytea \) FROM r72_owned_social_worker_command/u,
  );
  assert.match(
    source,
    /REVOKE EXECUTE ON FUNCTION app_private\.begin_owned_social_call\( uuid, uuid, bigint, bytea, boolean, boolean \) FROM r72_owned_social_worker_command/u,
  );
});

test('0066 keeps the calendar command and worker table-blind behind exact functions', async () => {
  const source = await sql();
  assert.match(source, /SECURITY DEFINER SET search_path = pg_catalog/u);
  assert.match(source, /session_user <> 'r72_owned_social_command'/u);
  assert.match(source, /GRANT EXECUTE ON FUNCTION app_private\.enqueue_owned_social_job_v2/u);
  assert.match(source, /GRANT EXECUTE ON FUNCTION app_private\.load_owned_social_job_v2/u);
  assert.doesNotMatch(source, /GRANT (?:SELECT|INSERT|UPDATE|DELETE) ON app\.property_predator_owned_social_job_media TO r72_owned_social_(?:command|worker_command)/u);
  assert.doesNotMatch(source, /(?:http|fetch|AYRSHARE_API_KEY|Profile-Key)/u);
});
