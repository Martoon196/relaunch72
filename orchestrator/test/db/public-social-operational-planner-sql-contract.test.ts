import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../src/db/migrations/0040_public_social_operational_planner.sql',
  import.meta.url,
);

function normalise(sql: string): string {
  return sql.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();
}

async function migration(): Promise<string> {
  return normalise(await readFile(migrationUrl, 'utf8'));
}

const IMMUTABLE_TABLES = [
  'public_social_planning_intents',
  'public_social_planning_intent_targets',
  'public_social_planning_intent_media',
  'public_social_planning_target_cancellations',
  'public_social_planning_target_supersessions',
  'public_social_revalidation_proofs',
  'public_social_revalidation_proof_media',
  'public_social_intent_materializations',
] as const;

const ALL_TABLES = [
  ...IMMUTABLE_TABLES,
  'public_social_revalidation_jobs',
] as const;

test('0040 creates immutable long-dated plans separate from dispatchable posts', async () => {
  const sql = await migration();
  for (const table of ALL_TABLES) {
    assert.match(sql, new RegExp(`CREATE TABLE app\\.${table}`));
    assert.match(sql, new RegExp(`'app', '${table}', 'workspace_id'`));
  }
  assert.match(sql, /desired_for <= created_at \+ interval '366 days'/);
  assert.match(sql, /intent_sha256 bytea NOT NULL CHECK \(octet_length\(intent_sha256\) = 32\)/);
  assert.match(sql, /planning_source_attestation_id uuid NOT NULL/);
  assert.match(sql, /CREATE TABLE app\.public_social_intent_materializations/);
  const createBody = sql.slice(
    sql.indexOf('CREATE FUNCTION app_private.create_test_social_planning_intent'),
    sql.indexOf('CREATE FUNCTION app_private.list_test_social_planner_targets'),
  );
  assert.doesNotMatch(createBody, /INSERT INTO app\.public_social_posts/);
  assert.doesNotMatch(createBody, /INSERT INTO app\.public_social_operations/);
});

test('0040 browser command resolves exact approval, source, target and media evidence server-side', async () => {
  const sql = await migration();
  const signature = sql.slice(
    sql.indexOf('CREATE FUNCTION app_private.create_test_social_planning_intent'),
    sql.indexOf('RETURNS TABLE (intent_id uuid, intent_sha256 text, disposition text)'),
  );
  assert.match(signature, /p_content_version_id uuid/);
  assert.match(signature, /p_target_ids uuid\[\]/);
  assert.match(signature, /p_media_version_ids uuid\[\]/);
  assert.doesNotMatch(signature, /p_(?:body|content_sha256|blob_sha256|brand_sha256|approval|attestation|account|storage)/i);
  const createBody = sql.slice(
    sql.indexOf('CREATE FUNCTION app_private.create_test_social_planning_intent'),
    sql.indexOf('CREATE FUNCTION app_private.list_test_social_planner_targets'),
  );
  assert.match(createBody, /decision\.decision = 'approved'/);
  assert.match(createBody, /attestation\.expires_at > statement_timestamp\(\)/);
  assert.match(createBody, /NOT EXISTS \( SELECT 1 FROM app\.company_content_versions AS newer/);
  assert.match(createBody, /connection\.provider_id = 'public_social_dark_simulator'/);
  assert.match(createBody, /connection\.environment = 'test'/);
  assert.match(createBody, /public-social-planning-intent\/v1/);
  assert.match(createBody, /planning intent id was reused with different inputs/);
});

test('0040 rejects unsupported or malformed immutable source provenance before intent creation', async () => {
  const sql = await migration();
  const createBody = sql.slice(
    sql.indexOf('CREATE FUNCTION app_private.create_test_social_planning_intent'),
    sql.indexOf('CREATE FUNCTION app_private.list_test_social_planner_targets'),
  );
  assert.ok(
    (createBody.match(/version\.source_system = 'propertypredator\.company-content'/g) ?? []).length >= 2,
    'main content and every media asset must use the owned company-content source',
  );
  assert.ok(
    (createBody.match(/version\.source_item_id ~ '\^\(media\|asset\|generated\):\[A-Za-z0-9\]/g) ?? []).length >= 2,
    'main and media source item identities must match the owned adapter namespace',
  );
  assert.ok(
    (createBody.match(/version\.source_version ~ '\^\[1-9\]\[0-9\]\{0,9\}\$'/g) ?? []).length >= 2,
    'main and media source versions must be canonical positive integers',
  );
  assert.ok(
    (createBody.match(/version\.source_version <= '2147483647'/g) ?? []).length >= 2,
    'source versions must stay inside the owned adapter integer bound without casting',
  );
  assert.ok(
    (createBody.match(/pg_catalog\.pg_input_is_valid\( version\.metadata->>'sourceVersionId', 'uuid' \)/g) ?? []).length >= 2,
    'main and media source version ids must be parseable canonical UUIDs',
  );
  assert.ok(
    (createBody.match(/pg_catalog\.pg_input_is_valid\( version\.metadata->>'sourceApprovalId', 'uuid' \)/g) ?? []).length >= 2,
    'main and media approval ids must be parseable canonical UUIDs',
  );
  assert.ok(
    (createBody.match(/pg_catalog\.pg_input_is_valid\( version\.metadata->>'sourceApprovedAt', 'timestamp with time zone' \)/g) ?? []).length >= 2,
    'main and media approval timestamps must be safely parseable',
  );
  const approvedAtPattern = createBody.match(/sourceApprovedAt' ~ '([^']+)'/)?.[1];
  assert.ok(approvedAtPattern, 'sourceApprovedAt must have an explicit canonical wire pattern');
  const approvedAt = new RegExp(approvedAtPattern);
  for (const accepted of [
    '2026-08-26T20:00:00Z',
    '2026-08-26T20:00:00.1Z',
    '2026-08-26T20:00:00.123456+00:00',
    '2026-08-26T20:00:00-04:30',
  ]) assert.match(accepted, approvedAt);
  for (const rejected of [
    ' 2026-08-26T20:00:00Z',
    '2026-08-26T20:00:00z',
    '2026-08-26T20:00:00',
    '2026-08-26T20:00:00+0000',
    '2026-08-26T20:00:00.1234567Z',
    '2026-08-26 20:00:00 UTC',
  ]) assert.doesNotMatch(rejected, approvedAt);
  assert.ok(
    (createBody.match(/THEN \(version\.metadata->>'sourceApprovedAt'\)::timestamptz <= statement_timestamp\(\) ELSE false END/g) ?? []).length >= 2,
    'future approval timestamps must fail closed behind a guarded cast',
  );
});

test('0040 reschedule and cancel append evidence without mutating plans or 0039 posts', async () => {
  const sql = await migration();
  assert.match(sql, /UNIQUE \(workspace_id, intent_id, target_id\)/);
  assert.match(sql, /UNIQUE \(workspace_id, predecessor_intent_id, predecessor_target_id\)/);
  assert.match(sql, /UNIQUE \(workspace_id, successor_intent_id, successor_target_id\)/);
  assert.match(sql, /cancellation_kind IN \('user_cancelled', 'rescheduled'\)/);
  assert.match(sql, /CREATE FUNCTION app_private\.cancel_test_social_planning_target/);
  assert.match(sql, /CREATE FUNCTION app_private\.reschedule_test_social_planning_target/);
  assert.match(sql, /materialized planning target can no longer be cancelled safely/);
  assert.match(sql, /materialized planning target can no longer be rescheduled safely/);
  assert.match(sql, /selected_operation\.state NOT IN \( 'waiting_for_test_time', 'retry_wait', 'simulated_cancelled' \)/);
  const lifecycle = sql.slice(
    sql.indexOf('CREATE FUNCTION app_private.cancel_test_social_planning_target'),
    sql.indexOf('CREATE FUNCTION app_private.claim_due_test_social_revalidations'),
  );
  assert.doesNotMatch(lifecycle, /UPDATE app\.public_social_planning_intents/);
  assert.doesNotMatch(lifecycle, /UPDATE app\.public_social_posts/);
  assert.match(lifecycle, /INSERT INTO app\.public_social_planning_target_cancellations/);
  assert.match(lifecycle, /INSERT INTO app\.public_social_planning_target_supersessions/);
});

test('0040 JIT revalidation is lease-fenced, bounded and pins exact proof material', async () => {
  const sql = await migration();
  assert.match(sql, /state text NOT NULL DEFAULT 'waiting_for_window' CHECK \(state IN \( 'waiting_for_window', 'leased', 'retry_wait', 'verified', 'materialized', 'dead_letter', 'cancelled', 'window_expired' \)\)/);
  assert.match(sql, /lease_token_hash bytea CHECK/);
  assert.match(sql, /lease_version bigint NOT NULL DEFAULT 0/);
  assert.match(sql, /attempt_count smallint NOT NULL DEFAULT 0 CHECK \(attempt_count BETWEEN 0 AND 4\)/);
  assert.match(sql, /FOR UPDATE OF job SKIP LOCKED/);
  assert.match(sql, /intent\.desired_for <= statement_timestamp\(\) \+ interval '10 minutes'/);
  assert.match(sql, /revalidation lease was lost/);
  assert.match(sql, /expires_at <= checked_at \+ interval '15 minutes'/);
  assert.match(sql, /p_expires_at <= intent\.desired_for \+ interval '2 minutes'/);
  assert.match(sql, /intent_sha256 = intent\.intent_sha256/);
  assert.match(sql, /fresh exact social content proof is unavailable/);
  assert.match(sql, /fresh exact media proof is unavailable/);
  assert.match(sql, /source_resource_version_id uuid NOT NULL/);
  assert.match(sql, /source_approval_id uuid NOT NULL/);
  assert.match(sql, /source_approved_at timestamptz NOT NULL/);
  assert.doesNotMatch(
    sql.slice(sql.indexOf('CREATE TABLE app.public_social_revalidation_proofs'),
      sql.indexOf('CREATE TABLE app.public_social_intent_materializations')),
    /source_attestation_id/,
  );
  assert.match(sql, /state = 'cancelled'/);
  assert.match(sql, /state = 'window_expired'/);
  assert.match(sql, /last_error_code = 'revalidation\.cancelled'/);
  assert.match(sql, /last_error_code = 'revalidation\.window_expired'/);
  assert.match(sql, /UNIQUE \(workspace_id, job_id\)/);
});

test('0040 poison-queue defence dead-letters malformed tenants and continues to valid work', async () => {
  const sql = await migration();
  const claim = sql.slice(
    sql.indexOf('CREATE FUNCTION app_private.claim_due_test_social_revalidations'),
    sql.indexOf('CREATE FUNCTION app_private.load_leased_test_social_source_versions'),
  );
  const terminalizeAt = claim.indexOf("last_error_code = 'revalidation.source_metadata_invalid'");
  const selectAt = claim.indexOf('RETURN QUERY WITH selected AS MATERIALIZED');
  assert.ok(terminalizeAt > 0 && terminalizeAt < selectAt,
    'malformed due work must be terminalised before this call selects a lease');
  assert.match(claim, /SET state = 'dead_letter', lease_token_hash = NULL, lease_worker_id = NULL, lease_expires_at = NULL/);
  assert.match(claim, /completed_at = statement_timestamp\(\)/);
  assert.match(claim, /job\.next_attempt_at <= statement_timestamp\(\)/);
  assert.match(claim, /\) IS NOT TRUE OR EXISTS \( SELECT 1 FROM app\.public_social_planning_intent_media AS planned_media/);
  assert.match(claim, /AND NOT EXISTS \( SELECT 1 FROM app\.public_social_planning_intent_media AS planned_media/);
  assert.ok(
    (claim.match(/media_version\.source_system = 'propertypredator\.company-content'/g) ?? []).length >= 2,
    'malformed media must be terminalised and excluded from selection',
  );
  assert.ok(
    (claim.match(/(?:version|media_version)\.source_item_id ~ '\^\(media\|asset\|generated\):/g) ?? []).length >= 4,
    'unsafe source item identities must be dead-lettered before queue parsing',
  );
  assert.ok(
    (claim.match(/(?:version|media_version)\.source_version <= '2147483647'/g) ?? []).length >= 4,
    'oversized or nonnumeric source versions must be dead-lettered before queue parsing',
  );
  assert.ok(
    (claim.match(/pg_catalog\.pg_input_is_valid\([^)]*sourceApprovedAt[^)]*'timestamp with time zone'/g) ?? []).length >= 4,
    'main and media timestamp casts in both terminalisation and selection must be guarded',
  );
  assert.ok(
    (claim.match(/pg_catalog\.pg_input_is_valid\([^)]*sourceVersionId[^)]*'uuid'/g) ?? []).length >= 5,
    'claim selection and its returned UUIDs must reject malformed values before casting',
  );
  assert.match(claim, /FOR UPDATE OF job SKIP LOCKED LIMIT p_batch_size/);
});

test('0040 carries the operator-selected attempt ceiling into JIT revalidation', async () => {
  const sql = await migration();
  assert.match(
    sql,
    /INSERT INTO app\.public_social_revalidation_jobs[^]*?VALUES \( p_workspace_id, p_intent_id, 'waiting_for_window', 0, p_max_attempts,/,
  );
  assert.doesNotMatch(
    sql,
    /INSERT INTO app\.public_social_revalidation_jobs[^]*?VALUES \( p_workspace_id, p_intent_id, 'waiting_for_window', 0, 4,/,
  );
});

test('0040 materialises only verified plans into the existing dark TEST simulator', async () => {
  const sql = await migration();
  const materialize = sql.slice(
    sql.indexOf('CREATE FUNCTION app_private.materialize_test_social_planning_intent'),
    sql.indexOf('CREATE OR REPLACE FUNCTION app_private.public_social_dispatch_ready'),
  );
  assert.match(materialize, /selected_job\.state <> 'verified'/);
  assert.match(materialize, /verified proof no longer covers materialization/);
  assert.match(materialize, /INSERT INTO app\.public_social_posts/);
  assert.match(materialize, /INSERT INTO app\.public_social_operations/);
  assert.match(materialize, /'simulated_test_only', 'waiting_for_test_time'/);
  assert.match(materialize, /connection\.provider_id = 'public_social_dark_simulator'/);
  assert.match(materialize, /connection\.environment = 'test'/);
  assert.doesNotMatch(sql, /https?:\/\/|fetch\(|axios|XMLHttpRequest|node-fetch/i);
  assert.doesNotMatch(sql, /CREATE TABLE[^;]*(?:credential|secret|access_token|refresh_token)/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION app_private\.public_social_dispatch_ready/);
  assert.match(sql, /public_social_intent_materializations AS materialization/);
  assert.match(sql, /job\.state = 'materialized'/);
  assert.match(sql, /proof_media\.expires_at > post\.scheduled_for \+ interval '2 minutes'/);
  assert.match(sql, /CREATE FUNCTION app_private\.complete_and_materialize_test_social_revalidation/);
});

test('0040 serialises materialization with cancel/reschedule and vetoes stale dispatch', async () => {
  const sql = await migration();
  const materialize = sql.slice(
    sql.indexOf('CREATE FUNCTION app_private.materialize_test_social_planning_intent'),
    sql.indexOf('CREATE FUNCTION app_private.complete_and_materialize_test_social_revalidation'),
  );
  const targetLock = materialize.indexOf("'public-social-planning-target:' || p_workspace_id::text || ':' || intent.id::text || ':' || locked_target.target_id::text");
  const lifecycleRecheck = materialize.indexOf('SELECT count(*) INTO expected_target_count');
  const operationInsert = materialize.indexOf('INSERT INTO app.public_social_operations');
  assert.ok(targetLock > 0 && targetLock < lifecycleRecheck && lifecycleRecheck < operationInsert,
    'every target lock must be held before fresh lifecycle reads and operation insertion');
  assert.match(materialize, /FOR locked_target IN SELECT target\.target_id[^]*?ORDER BY target\.ordinal, target\.target_id LOOP/);
  assert.match(materialize, /pg_catalog\.pg_advisory_xact_lock\( pg_catalog\.hashtextextended\([^]*?7200040 \) \)/);

  const dispatch = sql.slice(
    sql.indexOf('CREATE OR REPLACE FUNCTION app_private.public_social_dispatch_ready'),
    sql.indexOf('CREATE FUNCTION app_private.list_test_social_planning_calendar'),
  );
  assert.match(dispatch, /public_social_intent_materializations AS lifecycle_materialization/);
  assert.match(dispatch, /public_social_planning_intent_targets AS lifecycle_target/);
  assert.match(dispatch, /lifecycle_target\.target_id = operation\.target_id/);
  assert.match(dispatch, /public_social_planning_target_cancellations AS cancellation/);
  assert.match(dispatch, /public_social_planning_target_supersessions AS supersession/);
  assert.match(dispatch, /AND NOT EXISTS \( SELECT 1 FROM app\.public_social_intent_materializations AS lifecycle_materialization/);
});

test('0040 keeps facts immutable, RLS-forced and command roles function-only', async () => {
  const sql = await migration();
  for (const table of IMMUTABLE_TABLES) assert.match(sql, new RegExp(`'${table}'`));
  assert.match(sql, /BEFORE UPDATE OR DELETE ON app\.%I/);
  assert.match(sql, /reject_public_social_mutation\(\)/);
  assert.match(sql, /ALTER TABLE app\.%I ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /ALTER TABLE app\.%I FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /'r72_public_social_revalidator_command'/);
  assert.match(sql, /REVOKE ALL ON ALL TABLES IN SCHEMA app FROM r72_public_social_revalidator_command/);
  assert.match(sql, /Public-social revalidator unexpectedly has table privilege/);
  assert.doesNotMatch(sql, /GRANT (?:SELECT|INSERT|UPDATE|DELETE)[^;]+TO r72_public_social_revalidator_command/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app_private\.claim_due_test_social_revalidations/);
  assert.match(sql, /app_private\.load_leased_test_social_source_versions/);
  assert.match(sql, /app_private\.complete_and_materialize_test_social_revalidation/);
  assert.doesNotMatch(
    sql,
    /app_private\.complete_test_social_revalidation\([^;]+\) TO r72_public_social_revalidator_command/,
  );
  assert.doesNotMatch(
    sql,
    /app_private\.materialize_test_social_planning_intent\([^;]+\) TO r72_public_social_revalidator_command/,
  );
  assert.match(sql, /Unexpected effective public-social revalidator function/);
  assert.match(sql, /has_function_privilege\( 'r72_public_social_revalidator_command', procedure\.oid, 'EXECUTE' \)/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app_private\.create_test_social_planning_intent/);
  assert.match(sql, /Operational planner command capabilities are crossed/);
});

test('0040 safe projections expose state and hashes but no bodies or provider references', async () => {
  const sql = await migration();
  assert.match(sql, /CREATE FUNCTION app_private\.list_test_social_planner_targets/);
  assert.match(sql, /CREATE FUNCTION app_private\.list_test_social_planning_calendar/);
  assert.match(sql, /p_limit NOT BETWEEN 1 AND 120/);
  assert.match(sql, /LIMIT p_limit \+ 1/);
  assert.match(sql, /'awaiting_revalidation'/);
  assert.match(sql, /'revalidation_leased'/);
  assert.match(sql, /'proof_ready'/);
  assert.match(sql, /'revalidation_attention'/);
  const targetReadSignature = sql.slice(
    sql.indexOf('CREATE FUNCTION app_private.list_test_social_planner_targets'),
    sql.indexOf('LANGUAGE plpgsql',
      sql.indexOf('CREATE FUNCTION app_private.list_test_social_planner_targets')),
  );
  const calendarReadSignature = sql.slice(
    sql.indexOf('CREATE FUNCTION app_private.list_test_social_planning_calendar'),
    sql.indexOf('LANGUAGE plpgsql',
      sql.indexOf('CREATE FUNCTION app_private.list_test_social_planning_calendar')),
  );
  assert.doesNotMatch(
    targetReadSignature + calendarReadSignature,
    /test_account_ref|blob_storage_key|content_body|provider_connection_id|source_attestation_id/i,
  );
});

test('0040 terminates every function and anonymous block as executable PostgreSQL', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const functions = [...sql.matchAll(
    /CREATE (?:OR REPLACE )?FUNCTION app_private\.([a-z0-9_]+)\([^]*?AS \$function\$([^]*?)\$function\$;/g,
  )];
  assert.ok(functions.length >= 11);
  for (const match of functions) {
    if (/LANGUAGE sql/.test(match[0]!)) continue;
    assert.match(match[2]!, /\bEND;\s*$/, `${match[1]} must terminate with END;`);
  }
  const blocks = [...sql.matchAll(/DO \$([a-z0-9_]+)\$([^]*?)\$\1\$;/g)];
  assert.ok(blocks.length >= 5);
  for (const match of blocks) assert.match(match[2]!, /\bEND;?\s*$/);
});
