import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../src/db/migrations/0091_property_predator_creator_watch_and_message_families.sql',
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
  assert.ok(from >= 0 && to > from, `missing SQL boundary: ${start}`);
  return source.slice(from, to);
}

const TABLES = [
  'daily_outreach_message_family_versions',
  'daily_outreach_creator_watch_subject_versions',
  'daily_outreach_creator_watch_observed_posts',
  'daily_outreach_creator_watch_relevance_decisions',
  'daily_outreach_creator_watch_comment_assignments',
] as const;

test('0091 creates private forced-RLS append-only Creator Watch evidence', async () => {
  const source = await sql();
  assert.match(source, /IF unsafe_parent IS NOT NULL THEN/u);
  assert.doesNotMatch(source, /unsafe_parent = 'r72_owner'/u);
  for (const table of TABLES) {
    assert.match(source, new RegExp(`CREATE TABLE app_private\\.${table}`, 'u'));
    assert.match(source, new RegExp(`ALTER TABLE app_private\\.${table} ENABLE ROW LEVEL SECURITY`, 'u'));
    assert.match(source, new RegExp(`ALTER TABLE app_private\\.${table} FORCE ROW LEVEL SECURITY`, 'u'));
    assert.match(source, new RegExp(`'app_private', '${table}', 'workspace_id'`, 'u'));
    assert.match(source, new RegExp(`BEFORE UPDATE OR DELETE ON app_private\\.${table}`, 'u'));
  }
  assert.match(source, /Creator Watch evidence is append-only/u);
  assert.doesNotMatch(source, /CREATE TABLE app\.daily_outreach/u);
});

test('0091 message families are immutable approved envelopes with bounded enums', async () => {
  const source = await sql();
  const table = between(
    source,
    'CREATE TABLE app_private.daily_outreach_message_family_versions',
    'CREATE UNIQUE INDEX daily_outreach_message_family_one_root',
  );
  assert.match(table, /version_number integer NOT NULL/u);
  assert.match(table, /previous_version_id uuid/u);
  assert.match(table, /purpose text NOT NULL CHECK \(purpose IN/u);
  assert.match(table, /'authority_comment'/u);
  assert.match(table, /allowed_context_fields text\[\] NOT NULL/u);
  for (const field of [
    'post_topic', 'role', 'company', 'observed_problem',
    'relationship_context', 'campaign_context',
  ]) assert.match(table, new RegExp(`'${field}'`, 'u'));
  assert.match(table, /content_version_id uuid NOT NULL/u);
  assert.match(table, /content_sha256 bytea NOT NULL/u);
  assert.match(table, /approval_request_id uuid NOT NULL/u);
  assert.match(table, /approval_decision_id uuid NOT NULL/u);
  assert.match(table, /approval_request_id, approval_decision_id, content_sha256 \) REFERENCES app\.company_content_approval_decisions/u);
  assert.match(table, /review_mode = 'one_tap_review'/u);
  assert.match(table, /requires_human_approval IS TRUE/u);
  assert.match(table, /autonomous_comment_enabled IS FALSE/u);
  assert.match(table, /provider_effects_enabled IS FALSE/u);
  assert.match(source, /Non-linear Daily Outreach message-family version/u);
  assert.match(source, /assert_current_approved_creator_content/u);
  const approvalHelper = between(
    source,
    'CREATE FUNCTION app_private.assert_current_approved_creator_content',
    'CREATE FUNCTION app_private.publish_daily_outreach_message_family_version',
  );
  assert.match(approvalHelper, /SELECT version\.version_number/u);
  assert.match(approvalHelper, /SELECT request\.request_number/u);
  assert.match(approvalHelper, /SELECT decision\.id/u);
  assert.doesNotMatch(approvalHelper, /SELECT (?:version|request|decision)\.\*/u);
});

test('0091 stores creator and post references as hashes, never raw dumps or bodies', async () => {
  const source = await sql();
  const subject = between(
    source,
    'CREATE TABLE app_private.daily_outreach_creator_watch_subject_versions',
    'CREATE UNIQUE INDEX daily_outreach_creator_subject_one_root',
  );
  assert.match(subject, /provider_subject_ref_sha256 bytea NOT NULL/u);
  assert.match(subject, /provenance_sha256 bytea NOT NULL/u);
  assert.match(subject, /status IN \( 'active_review', 'paused', 'retired' \)/u);
  assert.match(subject, /minimum_comment_interval_seconds/u);
  assert.match(subject, /max_comments_per_utc_day/u);
  assert.match(subject, /max_comments_rolling_7_days/u);

  const post = between(
    source,
    'CREATE TABLE app_private.daily_outreach_creator_watch_observed_posts',
    'CREATE INDEX daily_outreach_creator_posts_review_idx',
  );
  for (const column of [
    'provider_post_ref_sha256', 'source_reference_sha256',
    'post_content_sha256', 'observation_evidence_sha256',
  ]) assert.match(post, new RegExp(`${column} bytea NOT NULL`, 'u'));
  assert.match(post, /raw_content_stored IS FALSE/u);
  for (const forbidden of [
    /profile_dump/iu, /profile_json/iu, /profile_url/iu,
    /post_body/iu, /post_text/iu, /raw_body/iu,
    /username/iu, /email_address/iu, /phone_number/iu,
    /access_token/iu, /api_key/iu, /provider_secret/iu,
  ]) assert.doesNotMatch(post, forbidden);
});

test('0091 pins comment/no_comment decisions and review-only approved assignments', async () => {
  const source = await sql();
  const decision = between(
    source,
    'CREATE TABLE app_private.daily_outreach_creator_watch_relevance_decisions',
    'CREATE UNIQUE INDEX daily_outreach_creator_decision_one_root',
  );
  assert.match(decision, /decision IN \('comment', 'no_comment'\)/u);
  for (const purpose of [
    'add_useful_evidence', 'extend_the_idea', 'ask_sharp_question',
    'offer_counterpoint', 'open_genuine_conversation',
  ]) assert.match(decision, new RegExp(`'${purpose}'`, 'u'));
  assert.match(decision, /no_comment_reason text CHECK/u);
  assert.match(decision, /grounding_evidence_sha256/u);
  assert.match(decision, /requires_human_approval IS TRUE/u);
  assert.match(decision, /UNIQUE \(workspace_id, observed_post_id, id\)/u);

  const assignment = between(
    source,
    'CREATE TABLE app_private.daily_outreach_creator_watch_comment_assignments',
    'CREATE INDEX daily_outreach_creator_assignment_frequency_idx',
  );
  assert.match(assignment, /purpose = 'authority_comment'/u);
  assert.match(assignment, /effect_state = 'review_only'/u);
  assert.match(assignment, /requires_human_approval IS TRUE/u);
  assert.match(assignment, /autonomous_comment_enabled IS FALSE/u);
  assert.match(assignment, /provider_effects_enabled IS FALSE/u);
  assert.match(assignment, /approval_request_id, approval_decision_id, content_sha256 \) REFERENCES app\.company_content_approval_decisions/u);
  assert.match(assignment, /cooldown_until timestamptz NOT NULL/u);
  assert.doesNotMatch(assignment, /message_body|comment_body|provider_operation_id/u);
});

test('0091 serialises cooldown and frequency limits without creating an effect', async () => {
  const source = await sql();
  const assign = between(
    source,
    'CREATE FUNCTION app_private.assign_daily_outreach_creator_watch_comment',
    'CREATE FUNCTION app_private.read_daily_outreach_message_families',
  );
  assert.match(assign, /daily-outreach-creator-frequency:/u);
  assert.match(assign, /daily-outreach-channel-frequency:/u);
  assert.match(assign, /daily-outreach-creator-assignment-command:/u);
  assert.match(assign, /Creator Watch frequency cap reached/u);
  assert.match(assign, /Creator Watch cooldown is active/u);
  assert.match(assign, /max_comments_per_utc_day/u);
  assert.match(assign, /max_comments_rolling_7_days/u);
  assert.match(assign, /max_per_channel_per_utc_day/u);
  assert.match(assign, /assignment must use exact message-family content/u);
  assert.match(assign, /family\.content_sha256 <> p_content_sha256/u);
  assert.match(assign, /family\.approval_decision_id <> p_approval_decision_id/u);
  assert.match(assign, /'review_only'::text/u);
  assert.doesNotMatch(assign, /INSERT INTO app\.provider_operations/u);
  assert.doesNotMatch(assign, /INSERT INTO app\.property_predator_zernio_reply_deliveries/u);
  assert.doesNotMatch(assign, /enqueue_|begin_.*call|settle_/u);
  const serverResolver = between(
    source,
    'CREATE FUNCTION app_private.assign_current_daily_outreach_creator_watch_comment',
    'CREATE FUNCTION app_private.read_daily_outreach_message_families',
  );
  assert.match(serverResolver, /SELECT version\.\* INTO family/u);
  assert.match(serverResolver, /family\.content_item_id/u);
  assert.match(serverResolver, /family\.approval_request_id/u);
  assert.match(serverResolver, /family\.approval_decision_id/u);
  assert.match(serverResolver, /assign_daily_outreach_creator_watch_comment/u);
  assert.doesNotMatch(serverResolver, /provider_operations|reply_deliveries|enqueue_/u);
});

test('0091 exposes exact table-blind command/read functions only', async () => {
  const source = await sql();
  assert.match(source, /member\.rolname = session_user/u);
  assert.match(source, /membership\.admin_option/u);
  assert.match(source, /NOT membership\.inherit_option/u);
  assert.match(source, /Creator Watch login role has direct table capability/u);
  assert.match(source, /has_any_column_privilege/u);
  assert.match(source, /Creator Watch exact command\/read ACL is not intact/u);
  assert.match(source, /Creator Watch gained provider-effect capability/u);
  assert.match(
    source,
    /GRANT EXECUTE ON FUNCTION app_private\.read_daily_outreach_creator_watch_queue\( uuid, smallint \) TO r72_daily_outreach_read/u,
  );
  assert.match(
    source,
    /GRANT EXECUTE ON FUNCTION app_private\.assign_current_daily_outreach_creator_watch_comment\(/u,
  );
  assert.match(
    source,
    /GRANT EXECUTE ON FUNCTION app_private\.resolve_daily_outreach_creator_watch_replay\( uuid, bytea \) TO r72_daily_outreach_command/u,
  );
  assert.doesNotMatch(
    source,
    /GRANT EXECUTE ON FUNCTION app_private\.assign_daily_outreach_creator_watch_comment\([^;]+TO r72_daily_outreach_command/u,
  );
  assert.doesNotMatch(
    source,
    /GRANT (?:SELECT|INSERT|UPDATE|DELETE|TRUNCATE)[^;]+TO r72_daily_outreach_(?:command|read)/u,
  );
  assert.doesNotMatch(source, /GRANT EXECUTE[^;]+TO PUBLIC/u);
  const replay = between(
    source,
    'CREATE FUNCTION app_private.resolve_daily_outreach_creator_watch_replay',
    'CREATE FUNCTION app_private.read_daily_outreach_message_families',
  );
  for (const stableField of [
    'observed_post_id', 'previous_decision_id', 'decision',
    'comment_purpose', 'no_comment_reason', 'decision_source',
    'relevance_decision_id',
    'decided_by_user_id', 'message_family_version_id',
    'comment_assignment_id', 'assigned_by_user_id', 'effect_state',
  ]) assert.match(replay, new RegExp(stableField, 'u'));
  assert.match(replay, /assert_daily_outreach_context\( p_workspace_id, 'r72_daily_outreach_command', true \)/u);
  assert.doesNotMatch(
    replay,
    /provider_post_ref|source_reference|post_content|message_body|comment_body|provider_operations|reply_deliveries/u,
  );
  for (const inheritedFunction of [
    'assign_daily_outreach_approved_content',
    'record_daily_outreach_outcome_event',
    'project_daily_outreach_outcome',
    'read_daily_outreach_cockpit_snapshot',
  ]) assert.match(source, new RegExp(`'${inheritedFunction}'`, 'u'));
  assert.doesNotMatch(source, /'project_daily_outreach_attempt'/u);
  assert.doesNotMatch(source, /'read_daily_outreach_cockpit'/u);

  const messageFamiliesRead = between(
    source,
    'CREATE FUNCTION app_private.read_daily_outreach_message_families',
    'CREATE FUNCTION app_private.read_daily_outreach_creator_watch_queue',
  );
  assert.match(messageFamiliesRead, /family\.effective_from <= statement_timestamp\(\)/u);
  assert.match(messageFamiliesRead, /decision\.decision = 'approved'/u);
  assert.match(messageFamiliesRead, /newer_content\.version_number > content_version\.version_number/u);
  assert.match(messageFamiliesRead, /later_request\.request_number > request\.request_number/u);

  const read = between(
    source,
    'CREATE FUNCTION app_private.read_daily_outreach_creator_watch_queue',
    'RESET ROLE;',
  );
  assert.match(read, /source_reference_sha256 bytea/u);
  assert.match(read, /post_content_sha256 bytea/u);
  assert.match(read, /relevance_decision text/u);
  assert.match(read, /effect_state text/u);
  assert.doesNotMatch(
    read,
    /profile|username|normalized_value|content_body|message_body|comment_body/u,
  );
});
