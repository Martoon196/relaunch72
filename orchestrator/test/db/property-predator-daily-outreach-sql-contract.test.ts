import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../src/db/migrations/0090_property_predator_daily_social_outreach_foundation.sql',
  import.meta.url,
);
const resetUrl = new URL('./reset-disposable.ts', import.meta.url);

function normalise(source: string): string {
  return source.replace(/--[^\n]*/gu, ' ').replace(/\s+/gu, ' ').trim();
}

async function sql(): Promise<string> {
  return normalise(await readFile(migrationUrl, 'utf8'));
}

function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `missing SQL boundary: ${start}`);
  return source.slice(from, to);
}

const TABLES = [
  'daily_outreach_programme_versions',
  'daily_outreach_prospect_memberships',
  'daily_outreach_queue_allocations',
  'daily_outreach_queue_leases',
  'daily_outreach_channel_eligibility_decisions',
  'daily_outreach_content_assignments',
  'daily_outreach_manual_attempt_receipts',
  'daily_outreach_outcome_events',
  'daily_outreach_control_events',
  'daily_outreach_projection_receipts',
] as const;

test('0090 creates private, forced-RLS, registered and append-only outreach truth', async () => {
  const source = await sql();
  for (const table of TABLES) {
    assert.match(source, new RegExp(`CREATE TABLE app_private\\.${table}`, 'u'));
    assert.match(source, new RegExp(`ALTER TABLE app_private\\.${table} ENABLE ROW LEVEL SECURITY`, 'u'));
    assert.match(source, new RegExp(`ALTER TABLE app_private\\.${table} FORCE ROW LEVEL SECURITY`, 'u'));
    assert.match(source, new RegExp(`'app_private', '${table}', 'workspace_id'`, 'u'));
    assert.match(source, new RegExp(`BEFORE UPDATE OR DELETE ON app_private\\.${table}`, 'u'));
  }
  assert.match(source, /Daily Outreach evidence is append-only/u);
  assert.match(source, /workspace_id = app_private\.current_workspace_id\(\)/u);
  assert.doesNotMatch(source, /CREATE TABLE app\.daily_outreach/u);
});

test('0090 programme and prospect truth are immutable, versioned and hash-only', async () => {
  const source = await sql();
  const programme = between(
    source,
    'CREATE TABLE app_private.daily_outreach_programme_versions',
    'CREATE UNIQUE INDEX daily_outreach_programme_one_root',
  );
  assert.match(programme, /version_number integer NOT NULL/u);
  assert.match(programme, /previous_version_id uuid/u);
  assert.match(programme, /daily_target smallint NOT NULL/u);
  assert.match(programme, /operating_daily_cap smallint NOT NULL/u);
  assert.match(programme, /provider_daily_cap smallint NOT NULL/u);
  assert.match(programme, /provider_effects_enabled boolean NOT NULL DEFAULT false CHECK \(provider_effects_enabled IS FALSE\)/u);
  assert.match(source, /CREATE UNIQUE INDEX daily_outreach_programme_one_child/u);

  const prospect = between(
    source,
    'CREATE TABLE app_private.daily_outreach_prospect_memberships',
    'CREATE TABLE app_private.daily_outreach_queue_allocations',
  );
  for (const column of [
    'source_subject_sha256', 'provenance_sha256',
    'audience_fit_sha256', 'membership_sha256',
  ]) assert.match(prospect, new RegExp(`${column} bytea NOT NULL`, 'u'));
  for (const forbidden of [
    /profile_dump/iu, /profile_json/iu, /profile_url/iu, /username/iu,
    /display_name/iu, /email_address/iu, /phone_number/iu,
    /postal_address/iu, /legal_text/iu, /message_text/iu,
    /provider_secret/iu, /access_token/iu, /api_key/iu,
  ]) assert.doesNotMatch(prospect, forbidden);
  assert.match(
    prospect,
    /FOREIGN KEY \(workspace_id, contact_point_id, contact_id\) REFERENCES app\.contact_points/u,
  );
  assert.match(source, /daily-outreach-membership\/v2/u);
  assert.match(source, /p_source_expires_at AT TIME ZONE 'UTC'/u);
  assert.match(source, /daily-outreach-allocation\/v2/u);
  assert.match(source, /pg_catalog\.to_char\(p_work_date, 'YYYY-MM-DD'\)/u);
});

test('0090 keeps the exact five-way expiring classification without effect capability', async () => {
  const source = await sql();
  const eligibilityTable = between(
    source,
    'CREATE TABLE app_private.daily_outreach_channel_eligibility_decisions',
    'CREATE UNIQUE INDEX daily_outreach_eligibility_one_root',
  );
  for (const decision of [
    'manual_first_touch', 'zernio_reply_eligible',
    'comment_to_dm_eligible', 'other_channel_review', 'blocked',
  ]) assert.match(eligibilityTable, new RegExp(`'${decision}'`, 'u'));
  assert.match(eligibilityTable, /expires_at <= evaluated_at \+ interval '5 minutes'/u);
  assert.match(eligibilityTable, /provider_effects_enabled IS FALSE/u);
  assert.match(eligibilityTable, /provider_evidence_sha256/u);
  assert.match(eligibilityTable, /source_stale/u);
  assert.match(eligibilityTable, /provider_ambiguous/u);

  const record = between(
    source,
    'CREATE FUNCTION app_private.record_daily_outreach_channel_eligibility',
    'CREATE FUNCTION app_private.claim_next_manual_daily_outreach',
  );
  assert.match(record, /Daily Outreach eligibility must block/u);
  assert.match(record, /event\.channel = 'social'/u);
  assert.match(record, /event\.purpose IS NULL OR event\.purpose = 'daily_outreach'/u);
  assert.match(record, /control\.control_kind = 'stopped'/u);
  assert.match(record, /control\.not_before > clock_timestamp\(\)/u);
  assert.match(record, /Completed Daily Outreach allocation cannot be reclassified/u);
  assert.match(record, /exact event binding not available/u);
  assert.doesNotMatch(record, /INSERT INTO app\.provider_operations/u);
});

test('0090 serialises lease, duplicate, quota, stale and suppression gates at manual completion', async () => {
  const source = await sql();
  const attempt = between(
    source,
    'CREATE FUNCTION app_private.record_daily_outreach_manual_attempt',
    'CREATE FUNCTION app_private.record_daily_outreach_outcome_event',
  );
  assert.match(
    attempt,
    /assert_daily_outreach_context\( p_workspace_id, 'r72_daily_outreach_command', false \)/u,
  );
  assert.match(source, /session_user <> p_expected_session/u);
  assert.match(attempt, /daily-outreach-command:/u);
  assert.match(attempt, /daily-outreach-quota:/u);
  assert.match(attempt, /daily-outreach-contact:/u);
  assert.match(attempt, /company-content:/u);
  assert.match(attempt, /7200021/u);
  assert.match(attempt, /FOR UPDATE/u);
  assert.match(attempt, /Daily Outreach duplicate attempt blocked/u);
  assert.match(attempt, /eligibility\.expires_at <= clock_timestamp\(\)/u);
  assert.match(attempt, /eligibility\.decision <> 'manual_first_touch'/u);
  assert.match(attempt, /lease\.lease_token_sha256 <> public\.digest\(p_lease_token, 'sha256'\)/u);
  assert.match(attempt, /eligibility\.evaluated_at > p_attempted_at/u);
  assert.match(attempt, /lease\.leased_at > p_attempted_at/u);
  assert.match(attempt, /approval_decision\.decided_at > p_attempted_at/u);
  assert.match(attempt, /assignment\.assigned_at > p_attempted_at/u);
  assert.match(attempt, /latest\.state = 'suppressed'/u);
  assert.match(attempt, /attempt_count >= programme\.operating_daily_cap/u);
  assert.match(attempt, /attempt_count >= programme\.provider_daily_cap/u);
  assert.match(attempt, /later_request\.request_number > approval_request\.request_number/u);
  assert.match(attempt, /newer\.version_number > content_version\.version_number/u);
  assert.match(attempt, /assignment\.content_version_id <> p_content_version_id/u);
  assert.match(attempt, /decision\.decision = 'approved'/u);
  assert.match(attempt, /provider_effects_enabled, recorded_request_id/u);
  assert.doesNotMatch(attempt, /content_body|review_note|decision_note|normalized_value|endpoint_identity_sha256/u);
  assert.doesNotMatch(attempt, /INSERT INTO app\.provider_operations|enqueue_|begin_.*call|settle_/u);
  assert.match(source, /commands require READ COMMITTED isolation/u);
  assert.ok(
    attempt.indexOf('SELECT attempt.* INTO existing')
      < attempt.indexOf('IF p_lease_token IS NULL'),
    'manual replay lookup must precede volatile lease/timestamp validation',
  );

  const claim = between(
    source,
    'CREATE FUNCTION app_private.claim_next_manual_daily_outreach',
    'CREATE FUNCTION app_private.record_daily_outreach_manual_attempt',
  );
  assert.ok(
    claim.indexOf("'daily-outreach-quota:'") < claim.indexOf('FOR UPDATE OF allocation'),
    'claim must take the UTC quota lock before the allocation row lock',
  );
  assert.match(claim, /completed_count >= selected_programme\.operating_daily_cap/u);
  assert.match(claim, /completed_count >= selected_programme\.provider_daily_cap/u);

  const suppression = between(
    source,
    'CREATE FUNCTION app_private.serialize_daily_outreach_suppression',
    'INSERT INTO app_private.workspace_table_registry',
  );
  assert.match(suppression, /pg_advisory_xact_lock/u);
  assert.match(suppression, /daily-outreach-contact:/u);
  assert.match(source, /BEFORE INSERT ON app\.communication_suppression_events/u);
});

test('0090 pins manual attempts to existing approved content and refuses cold LAPS promotion', async () => {
  const source = await sql();
  const receipt = between(
    source,
    'CREATE TABLE app_private.daily_outreach_manual_attempt_receipts',
    'CREATE INDEX daily_outreach_attempt_quota_idx',
  );
  assert.match(receipt, /content_version_id uuid NOT NULL/u);
  assert.match(receipt, /content_sha256 bytea NOT NULL/u);
  assert.match(receipt, /approval_request_id uuid NOT NULL/u);
  assert.match(receipt, /approval_decision_id uuid NOT NULL/u);
  assert.match(receipt, /manual_evidence_sha256 bytea NOT NULL/u);
  assert.match(
    receipt,
    /workspace_id, allocation_id, programme_version_id, prospect_membership_id, contact_id, contact_point_id, operator_user_id, channel/u,
  );
  assert.match(
    receipt,
    /workspace_id, allocation_id, content_assignment_id, content_item_id, content_version_id, content_sha256, approval_request_id, approval_decision_id/u,
  );
  assert.doesNotMatch(receipt, /body_text|message_text|provider_address|profile_dump/u);

  const assignment = between(
    source,
    'CREATE TABLE app_private.daily_outreach_content_assignments',
    'CREATE UNIQUE INDEX daily_outreach_assignment_one_root',
  );
  assert.match(assignment, /content_item_id uuid NOT NULL/u);
  assert.match(assignment, /approval_decision_id uuid NOT NULL/u);
  assert.match(assignment, /previous_assignment_id uuid/u);
  assert.doesNotMatch(assignment, /content_body|message_text|normalized_value/u);
  const assignCommand = between(
    source,
    'CREATE FUNCTION app_private.assign_daily_outreach_approved_content',
    'CREATE FUNCTION app_private.claim_next_manual_daily_outreach',
  );
  assert.match(assignCommand, /version\.content_kind = 'social_post'/u);
  assert.match(assignCommand, /company-content:/u);
  assert.match(assignCommand, /decision\.decision = 'approved'/u);

  const outcome = between(
    source,
    'CREATE FUNCTION app_private.record_daily_outreach_outcome_event',
    'CREATE FUNCTION app_private.project_daily_outreach_outcome',
  );
  assert.match(outcome, /previous_outcome_event_id/u);
  assert.match(outcome, /Invalid Daily Outreach outcome transition/u);
  assert.match(outcome, /INSERT INTO app_private\.daily_outreach_outcome_events/u);
  assert.match(outcome, /INSERT INTO app_private\.daily_outreach_control_events/u);
  assert.ok(
    outcome.indexOf('SELECT event.* INTO existing')
      < outcome.indexOf('IF p_previous_outcome_event_id IS NULL'),
    'outcome replay lookup must precede volatile occurred-at validation',
  );

  const projection = between(
    source,
    'CREATE FUNCTION app_private.project_daily_outreach_outcome',
    'CREATE FUNCTION app_private.read_daily_outreach_cockpit',
  );
  assert.match(projection, /cold_attempt_not_eligible/u);
  assert.match(projection, /response_evidence_pending/u);
  assert.match(projection, /p_existing_laps_milestone_fact_id IS NOT NULL/u);
  assert.doesNotMatch(projection, /existing_evidence_linked/u);
  assert.match(projection, /p_task_due_at < control\.not_before/u);
  assert.match(projection, /assignee\.status = 'active'/u);
  assert.match(projection, /INSERT INTO app\.tasks/u);
  assert.doesNotMatch(projection, /INSERT INTO app\.conversion_(?:enrollments|milestone_facts)/u);
  assert.ok(
    projection.indexOf('SELECT receipt.* INTO existing')
      < projection.indexOf('IF p_projection_evidence_sha256 IS NULL'),
    'projection replay lookup must precede volatile due/evidence validation',
  );
  assert.match(source, /daily_outreach_approval_decision_exact_key UNIQUE/u);
  assert.match(source, /CHECK \(\(previous_outcome_event_id IS NULL\) = \(outcome = 'attempted'\)\)/u);
});

test('0090 exposes exact table-blind command and safe-read boundaries only', async () => {
  const source = await sql();
  for (const role of [
    'r72_daily_outreach_command', 'r72_daily_outreach_read',
  ]) {
    assert.match(source, new RegExp(`'${role}', true`, 'u'));
    assert.match(source, new RegExp(`has_table_privilege\\( '${role}'`, 'u'));
  }
  assert.match(source, /Daily Outreach login role has direct table capability/u);
  assert.match(source, /Daily Outreach command function grant is missing/u);
  assert.match(source, /has_any_column_privilege/u);
  assert.match(source, /has_sequence_privilege/u);
  assert.match(source, /unsafe inbound membership/u);
  assert.match(source, /procedure\.oid = ANY\(owned_functions\)/u);
  assert.match(source, /owner\.rolname <> 'r72_daily_outreach_definer'/u);
  assert.match(source, /Daily Outreach gained provider-effect capability/u);
  assert.match(
    source,
    /GRANT EXECUTE ON FUNCTION app_private\.read_daily_outreach_cockpit_snapshot\( uuid, text, uuid, date, smallint, smallint \) TO r72_daily_outreach_read/u,
  );
  assert.match(
    source,
    /GRANT EXECUTE ON FUNCTION app_private\.resolve_daily_outreach_command_replay\( uuid, text, bytea \) TO r72_daily_outreach_command/u,
  );
  const replayResolver = between(
    source,
    'CREATE FUNCTION app_private.resolve_daily_outreach_command_replay',
    'CREATE FUNCTION app_private.read_daily_outreach_cockpit',
  );
  for (const identityColumn of [
    'command_kind text', 'allocation_id uuid', 'attempt_receipt_id uuid',
    'previous_outcome_event_id uuid', 'outcome text',
  ]) assert.match(replayResolver, new RegExp(identityColumn, 'u'));
  assert.match(
    replayResolver,
    /selected_outcome\.previous_outcome_event_id/u,
  );
  assert.doesNotMatch(
    source,
    /GRANT (?:SELECT|INSERT|UPDATE|DELETE|TRUNCATE)[^;]+TO r72_daily_outreach_(?:command|read)/u,
  );
  assert.doesNotMatch(source, /GRANT EXECUTE[^;]+TO PUBLIC/u);

  const read = between(
    source,
    'CREATE FUNCTION app_private.read_daily_outreach_cockpit_snapshot',
    'RESET ROLE;',
  );
  assert.doesNotMatch(
    read,
    /content_body|profile|normalized_value|source_subject_sha256|provenance_sha256|manual_evidence_sha256|lease_token_sha256/u,
  );
  for (const key of [
    'schemaVersion', 'quotaTimezone', 'snapshotAt', 'workspace', 'operator',
    'programme', 'manager', 'queue', 'recentOutcomes',
  ]) assert.match(read, new RegExp(`'${key}'`, 'u'));
  assert.match(read, /p_queue_limit NOT BETWEEN 1 AND 50/u);
  assert.match(read, /contentAssignment/u);
  assert.match(read, /displayName/u);
  assert.match(read, /metricAvailability/u);
  assert.match(read, /commandRechecksRequired/u);
  assert.match(read, /'programmeVersionId'/u);
  assert.match(read, /'cooldownSeconds'/u);
  assert.match(read, /'quotaDayUtc'/u);
  assert.match(read, /'attemptedAt'/u);
  assert.match(read, /'canRecordOutcome'/u);
  assert.match(
    read,
    /attempt\.attempt_utc_day BETWEEN p_quota_day_utc - 29 AND p_quota_day_utc/u,
  );
});

test('disposable reset removes all three 0090 roles', async () => {
  const reset = await readFile(resetUrl, 'utf8');
  for (const role of [
    'r72_daily_outreach_command',
    'r72_daily_outreach_definer',
    'r72_daily_outreach_read',
  ]) assert.match(reset, new RegExp(`'${role}'`, 'u'));
});
