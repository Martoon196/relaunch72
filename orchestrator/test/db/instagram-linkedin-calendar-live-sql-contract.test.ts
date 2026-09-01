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
  assert.match(source, /p_scheduled_for IS NULL/u);
  assert.match(source, /intent\.desired_for = p_scheduled_for/u);
  assert.match(source, /target\.network = p_network/u);
  assert.match(source, /planning_intent_id uuid/u);
  assert.match(source, /selected_media_count <> planned_media_count/u);
  assert.match(source, /p_network = 'instagram' AND selected_media_count NOT BETWEEN 1 AND 10/u);
  assert.match(source, /p_network = 'linkedin' AND selected_media_count > 9/u);
  assert.match(source, /media_attestation\.expires_at > greatest\(statement_timestamp\(\), p_scheduled_for\) \+ interval '15 minutes'/u);
  assert.match(source, /CREATE TRIGGER property_predator_owned_social_job_media_immutable/u);
  assert.match(source, /CREATE TRIGGER property_predator_owned_social_jobs_calendar_identity_immutable/u);
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
