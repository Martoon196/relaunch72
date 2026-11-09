import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const sql = await readFile(new URL(
  '../../src/db/migrations/0057_property_predator_live_channel_emergency_pause.sql',
  import.meta.url,
), 'utf8');

test('0057 creates only append-only engage evidence with no release command', () => {
  assert.match(sql, /CREATE TABLE app\.property_predator_live_channel_pause_events/u);
  assert.match(sql, /live_channel_pause_events_immutable BEFORE UPDATE OR DELETE/u);
  assert.match(sql, /RAISE EXCEPTION 'Live channel pause evidence is append-only'/u);
  assert.doesNotMatch(sql, /CREATE FUNCTION app_private\.(?:release|resume|disable|delete).*pause/iu);
  assert.doesNotMatch(sql, /DELETE FROM app\.property_predator_live_channel_pause_events/iu);
});

test('0057 command is active-session, founder/admin and exact-scope bound', () => {
  assert.match(sql, /engage_property_predator_live_channel_pause\([\s\S]*p_session_token_sha256 bytea[\s\S]*p_scope text[\s\S]*p_command_key uuid/u);
  assert.match(sql, /assert_operational_inbox_user_context\([\s\S]*p_workspace_id, p_session_token_sha256/u);
  assert.match(sql, /can_manage_workspace\(selected_user_id, p_workspace_id\)/u);
  for (const scope of ['all', 'customer_email', 'owned_social', 'whatsapp', 'sms', 'social_dm']) {
    assert.ok(sql.includes(`'${scope}'`));
  }
});

test('0057 command is replay-safe and conflicts if one key changes scope', () => {
  assert.match(sql, /UNIQUE \(workspace_id, command_key\)/u);
  assert.match(sql, /pg_advisory_xact_lock[\s\S]*property-predator-live-pause/u);
  assert.match(sql, /existing_scope IS DISTINCT FROM p_scope[\s\S]*idempotency conflict/u);
  assert.match(sql, /RETURN 'replayed'/u);
  assert.match(sql, /RETURN 'engaged'/u);
  assert.match(sql, /propertypredator\.live-channel-pause\/v1/u);
});

test('0057 fences every composed rail at the final job calling transition', () => {
  for (const [trigger, table] of [
    ['customer_email_live_emergency_pause', 'property_predator_customer_email_jobs'],
    ['owned_social_live_emergency_pause', 'property_predator_owned_social_jobs'],
    ['whatsapp_live_emergency_pause', 'property_predator_whatsapp_live_jobs'],
    ['sms_live_emergency_pause', 'property_predator_sms_jobs'],
  ]) {
    assert.match(sql, new RegExp(`CREATE TRIGGER ${trigger}[\\s\\S]*BEFORE UPDATE OF state ON app\\.${table}`, 'u'));
  }
  assert.match(sql, /NEW\.state IS DISTINCT FROM 'calling'/u);
  assert.match(sql, /pause\.scope IN \('all', selected_scope\)/u);
  assert.match(sql, /RAISE EXCEPTION 'Live channel emergency pause is engaged'[\s\S]*ERRCODE = '42501'/u);
});

test('0057 truth wrapper adds durable pause evidence without changing cap or receipt truth', () => {
  assert.match(sql, /RENAME TO property_predator_live_channel_truth_unpaused/u);
  assert.match(sql, /FROM app_private\.property_predator_live_channel_truth_unpaused\(\) AS truth/u);
  assert.match(sql, /truth\.rail <> 'social_dm'[\s\S]*pause\.scope IN \('all', truth\.rail\)/u);
  assert.match(sql, /truth\.blocker_codes \|\| ARRAY\['EMERGENCY_PAUSED'\]/u);
  assert.match(sql, /truth\.daily_used, truth\.daily_limit[\s\S]*truth\.monthly_used, truth\.monthly_limit/u);
});

test('0057 keeps the base truth unreadable and grants only engage plus wrapped truth', () => {
  assert.match(sql, /property_predator_live_channel_truth_unpaused\(\)[\s\S]*FROM PUBLIC, r72_web/u);
  assert.match(sql, /engage_property_predator_live_channel_pause\([\s\S]*TO r72_crm_command/u);
  assert.match(sql, /property_predator_live_channel_truth\(\)[\s\S]*TO r72_web/u);
  assert.doesNotMatch(sql,
    /GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE)[\s\S]{0,100}TO\s+r72_(?:web|crm_command)/iu);
});
