import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../src/db/migrations/0039_public_social_campaign_scheduler.sql',
  import.meta.url,
);

function normalise(sql: string): string {
  return sql.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();
}

async function migration(): Promise<string> {
  return normalise(await readFile(migrationUrl, 'utf8'));
}

const IMMUTABLE_TABLES = [
  'public_social_campaigns',
  'public_social_campaign_revisions',
  'public_social_targets',
  'public_social_posts',
  'public_social_post_media',
  'public_social_operation_attempts',
  'public_social_operation_receipts',
  'public_social_events',
] as const;

const ALL_TABLES = [
  ...IMMUTABLE_TABLES,
  'public_social_operations',
] as const;

test('0039 creates a TEST-only public-social model with no live provider capability', async () => {
  const sql = await migration();
  for (const table of ALL_TABLES) {
    assert.match(sql, new RegExp(`CREATE TABLE app\\.${table}`));
    assert.match(sql, new RegExp(`'app', '${table}', 'workspace_id'`));
  }
  assert.match(sql, /provider_id = 'public_social_dark_simulator'/);
  assert.match(sql, /environment text NOT NULL DEFAULT 'test' CHECK \(environment = 'test'\)/);
  assert.match(sql, /execution_mode text NOT NULL DEFAULT 'simulated_test_only' CHECK \(execution_mode = 'simulated_test_only'\)/);
  assert.match(sql, /provider_connections_public_social_dark_test_only_ck/);
  assert.doesNotMatch(sql, /https?:\/\/|fetch\(|axios|XMLHttpRequest|node-fetch/i);
  assert.doesNotMatch(sql, /CREATE TABLE[^;]*(?:credential|secret|access_token|refresh_token)/i);
  assert.doesNotMatch(sql, /'published'|'sent'|'delivered'/);
});

test('0039 pins exact campaign, content, approval, attestation, media and target evidence', async () => {
  const sql = await migration();
  assert.match(sql, /UNIQUE \(workspace_id, campaign_id, revision_number\)/);
  assert.match(sql, /CHECK \(\(revision_number = 1\) = \(previous_revision_id IS NULL\)\)/);
  assert.match(sql, /campaign revisions must extend the exact latest revision/);
  assert.match(sql, /FOREIGN KEY \(workspace_id, content_item_id, content_version_id, content_sha256\) REFERENCES app\.company_content_versions/);
  assert.match(sql, /approval_decision_id uuid NOT NULL/);
  assert.match(sql, /scheduled_source_attestation_id uuid NOT NULL/);
  assert.match(sql, /decision\.decision = 'approved'/);
  assert.match(sql, /attestation\.expires_at > statement_timestamp\(\)/);
  assert.match(sql, /attestation\.expires_at > p_required_valid_at/);
  assert.match(sql, /exact public-social source proof does not cover the scheduled time'[\s\S]*?ERRCODE = 'P0039'/);
  assert.match(sql, /p_source_attestation_id, p_scheduled_for, false, NULL/);
  assert.match(sql, /fresh\.id = post\.scheduled_source_attestation_id/);
  assert.match(sql, /fresh_media\.id = media\.scheduled_source_attestation_id/);
  assert.match(sql, /version\.content_kind = 'social_post'/);
  assert.match(sql, /version\.content_kind IN \('image', 'video'\)/);
  assert.match(sql, /existing_media IS DISTINCT FROM p_media/);
  assert.match(sql, /public-social content is stale, unapproved or unverified/);
  assert.match(sql, /one or more TEST public-social targets are unavailable/);
  assert.match(sql, /public_social_revision_sha256/);
  assert.match(sql, /p_revision_sha256 IS DISTINCT FROM app_private\.public_social_revision_sha256/);
  assert.match(sql, /public_social_body_supported\(version\.content_body\)/);
  assert.match(sql, /pg_catalog\.octet_length\(p_body\) BETWEEN 1 AND 16384/);
  assert.match(sql, /public_social_media_payload_supported/);
  assert.match(sql, /p_blob_storage_key ~ '\^\[A-Za-z0-9\]/);
  assert.match(sql, /resolve_test_social_campaign_targets/);
  assert.match(sql, /title = btrim\(title\) AND length\(title\) BETWEEN 1 AND 200/);
  assert.match(sql, /test_account_ref ~ '\^test-account:\[a-z_\]\+:\[a-z0-9_-\]\{1,64\}\$'/);
  assert.match(sql, /public_social_display_text_supported/);
  assert.match(sql, /8234, 8235, 8236, 8237, 8238, 8294, 8295, 8296, 8297/);
  assert.match(sql, /position\(U&'\\202E' in title\) = 0/);
});

test('0039 separates function-only command and worker roles from table capabilities', async () => {
  const sql = await migration();
  assert.match(sql, /'r72_public_social_definer', false/);
  assert.match(sql, /'r72_public_social_command', true/);
  assert.match(sql, /'r72_public_social_worker_command', true/);
  assert.match(sql, /NOLOGIN NOINHERIT|CREATE ROLE %I %s NOINHERIT/);
  assert.match(sql, /REVOKE ALL ON ALL TABLES IN SCHEMA app FROM r72_public_social_definer, r72_public_social_command, r72_public_social_worker_command/);
  assert.match(sql, /Public-social login % unexpectedly has table privilege/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app_private\.create_test_social_campaign_revision/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app_private\.resolve_test_social_campaign_targets/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app_private\.claim_due_test_social_targets/);
  assert.match(sql, /TO r72_public_social_command/);
  assert.match(sql, /TO r72_public_social_worker_command/);
  assert.doesNotMatch(sql, /GRANT (?:SELECT|INSERT|UPDATE|DELETE)[^;]+TO r72_public_social_(?:command|worker_command)/);
});

test('0039 forces workspace RLS, immutable facts and a single mutable state machine', async () => {
  const sql = await migration();
  assert.match(sql, /ALTER TABLE app\.%I ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /ALTER TABLE app\.%I FORCE ROW LEVEL SECURITY/);
  for (const table of IMMUTABLE_TABLES) assert.match(sql, new RegExp(`'${table}'`));
  assert.match(sql, /BEFORE UPDATE OR DELETE ON app\.%I/);
  assert.match(sql, /public-social evidence is append-only/);
  assert.match(sql, /phase text GENERATED ALWAYS AS/);
  assert.match(sql, /UNIQUE \(workspace_id, operation_id, lease_version, phase\)/);
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE ON app\.public_social_operations TO r72_public_social_definer/);
  assert.doesNotMatch(sql, /GRANT UPDATE ON app\.public_social_(?!operations)/);
  assert.doesNotMatch(sql, /UPDATE app\.public_social_operation_attempts/);
});

test('0039 supports fenced leases, bounded retries, cancellation and reconciliation evidence', async () => {
  const sql = await migration();
  assert.match(sql, /FOR UPDATE SKIP LOCKED/);
  assert.match(sql, /lease_token_hash bytea CHECK/);
  assert.match(sql, /lease_version bigint NOT NULL DEFAULT 0/);
  assert.match(sql, /attempt_count smallint NOT NULL DEFAULT 0/);
  assert.match(sql, /reconciliation_count smallint NOT NULL DEFAULT 0/);
  assert.match(sql, /CHECK \(reconciliation_count <= max_attempts\)/);
  assert.match(sql, /max_attempts smallint NOT NULL CHECK \(max_attempts BETWEEN 1 AND 4\)/);
  assert.match(sql, /attempt_kind text NOT NULL CHECK \(attempt_kind IN \('simulation', 'reconcile'\)\)/);
  assert.match(sql, /UNIQUE \(workspace_id, operation_id, attempt_kind, attempt_number, phase\)/);
  assert.match(sql, /public-social lease was lost/);
  assert.match(sql, /cancel_test_social_campaign_target/);
  assert.match(sql, /cancel_test_social_target_before_call/);
  assert.match(sql, /reconcile_test_social_target/);
  assert.match(sql, /operation\.state = 'reconciliation_required' AND operation\.reconciliation_count < operation\.max_attempts/);
  assert.match(sql, /selected_attempt_kind = 'reconcile' AND p_provider_status IN \('accepted', 'pending', 'needs_attention'\)/);
  assert.match(sql, /selected_attempt_kind = 'reconcile' AND p_provider_status = 'failed'/);
  assert.match(sql, /selected_attempt_kind = 'simulation' AND p_provider_status = 'failed' AND p_test_reference IS NOT NULL/);
  assert.match(sql, /p_provider_status IN \('accepted', 'pending', 'needs_attention'\) AND selected\.reconciliation_count >= selected\.max_attempts/);
  assert.match(sql, /CASE WHEN selected_attempt_kind = 'reconcile' THEN 'worker_reconcile' ELSE 'test_provider' END/);
  assert.match(sql, /reconciliation_call_lease_expired/);
  assert.match(sql, /expired\.state = 'calling_simulator' AND expired\.reconciliation_count < expired\.max_attempts/);
  assert.match(sql, /reconciliation_attempts_exhausted/);
  assert.match(sql, /IF p_provider_status IS NULL OR p_provider_status NOT IN/);
  assert.match(sql, /UNIQUE \(workspace_id, operation_id, source_kind, external_event_id\)/);
  assert.match(sql, /ON CONFLICT \(workspace_id, operation_id, source_kind, external_event_id\) DO NOTHING/);
  assert.match(sql, /public_social_events_one_cancellation_per_operation_uq/);
  assert.match(sql, /existing_reason_sha256 IS DISTINCT FROM p_reason_sha256/);
});

test('0039 resolves exact idempotent replays before mutable creation readiness', async () => {
  const sql = await migration();
  const target = sql.slice(
    sql.indexOf('CREATE FUNCTION app_private.register_test_social_campaign_target'),
    sql.indexOf('CREATE FUNCTION app_private.resolve_test_social_campaign_targets'),
  );
  assert.ok(
    target.indexOf("RETURN QUERY SELECT p_target_id, 'replayed'::text")
      < target.indexOf("connection.status = 'active'"),
  );

  const schedule = sql.slice(
    sql.indexOf('CREATE FUNCTION app_private.schedule_test_social_campaign'),
    sql.indexOf('CREATE FUNCTION app_private.cancel_test_social_campaign_target'),
  );
  const replay = schedule.indexOf("RETURN QUERY SELECT p_post_id, inserted_operation_ids, 'replayed'::text");
  assert.ok(replay < schedule.indexOf("p_scheduled_for < statement_timestamp() - interval '5 seconds'"));
  assert.ok(replay < schedule.indexOf("connection.status = 'active'"));
  assert.ok(replay < schedule.indexOf('PERFORM app_private.assert_public_social_content'));
});

test('0039 exposes bounded command and calendar reads without raw account references', async () => {
  const sql = await migration();
  assert.match(sql, /CREATE FUNCTION app_private\.list_social_campaign_command/);
  assert.match(sql, /CREATE FUNCTION app_private\.list_social_campaign_calendar/);
  assert.match(sql, /LIMIT p_limit \+ 1/);
  assert.match(sql, /p_limit NOT BETWEEN 1 AND 120/);
  assert.match(sql, /has_more boolean/);
  assert.match(sql, /count\(\*\) OVER \(\) > p_limit/);
  assert.match(sql, /ORDER BY projection\.scheduled_for, projection\.post_id/);
  assert.match(sql, /test_reference_sha256 text/);
  assert.match(sql, /public\.digest\(operation\.test_reference, 'sha256'\)/);
  const readSurface = sql.slice(
    sql.indexOf('CREATE FUNCTION app_private.list_social_campaign_command'),
    sql.indexOf('CREATE FUNCTION app_private.public_social_campaign_boundary_ready'),
  );
  assert.doesNotMatch(readSurface, /test_account_ref/i);
});

test('0039 terminates every function and anonymous block as executable PostgreSQL', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const functions = [...sql.matchAll(
    /CREATE FUNCTION app_private\.([a-z0-9_]+)\([^]*?AS \$function\$([^]*?)\$function\$;/g,
  )];
  assert.ok(functions.length >= 18);
  for (const match of functions) {
    if (/LANGUAGE sql/.test(match[0]!)) continue;
    assert.match(match[2]!, /\bEND;\s*$/, `${match[1]} must terminate with END;`);
  }
  const blocks = [...sql.matchAll(/DO \$([a-z0-9_]+)\$([^]*?)\$\1\$;/g)];
  assert.ok(blocks.length >= 4);
  for (const match of blocks) assert.match(match[2]!, /\bEND;?\s*$/);
});
