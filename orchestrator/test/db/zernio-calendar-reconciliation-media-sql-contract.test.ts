import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../src/db/migrations/0095_property_predator_calendar_reconciliation_and_media.sql',
  import.meta.url,
);

async function sql(): Promise<string> {
  return (await readFile(migrationUrl, 'utf8')).replace(/--[^\n]*/gu, ' ').replace(/\s+/gu, ' ');
}

test('0095 binds media and a current exact-account probe to direct schedules', async () => {
  const source = await sql();
  assert.match(source, /ADD COLUMN media_type text/u);
  assert.match(source, /ADD COLUMN media_url text/u);
  assert.match(source, /CREATE TABLE app\.property_predator_zernio_calendar_account_probes/u);
  assert.match(source, /CREATE FUNCTION app_private\.record_zernio_calendar_account_probe/u);
  assert.match(source, /CREATE FUNCTION app_private\.reserve_zernio_direct_schedule_v2/u);
  assert.match(source, /GRANT CREATE ON SCHEMA app_private TO r72_zernio_social_definer; SET LOCAL ROLE r72_zernio_social_definer;[\s\S]+CREATE FUNCTION app_private\.record_zernio_calendar_account_probe/u);
  assert.match(source, /REVOKE CREATE ON SCHEMA app_private FROM r72_zernio_social_definer; GRANT CREATE ON SCHEMA app_private TO r72_owned_social_definer; SET LOCAL ROLE r72_owned_social_definer;[\s\S]+CREATE FUNCTION app_private\.reserve_zernio_direct_schedule_v2/u);
  assert.match(source, /REVOKE CREATE ON SCHEMA app_private FROM r72_owned_social_definer/u);
  assert.match(source, /probe\.probed_at >= statement_timestamp\(\) - interval '24 hours'/u);
  assert.match(source, /p_media_url !~ '\^https:\/\/media\[\.\]zernio\[\.\]com\/'/u);
  assert.match(source, /RAISE EXCEPTION 'Zernio direct calendar account not ready' USING ERRCODE = '55000'/u);
});

test('0095 separates access and validation errors and keeps the command role table-blind', async () => {
  const source = await sql();
  assert.match(source, /access denied' USING ERRCODE = '42501'/u);
  assert.match(source, /input invalid' USING ERRCODE = '22023'/u);
  assert.match(source, /GRANT EXECUTE ON FUNCTION app_private\.record_zernio_calendar_account_probe/u);
  assert.match(source, /GRANT EXECUTE ON FUNCTION app_private\.reserve_zernio_direct_schedule_v2/u);
  assert.match(source, /REVOKE EXECUTE ON FUNCTION app_private\.reserve_zernio_direct_schedule/u);
  assert.match(source, /Zernio social command role gained table capability/u);
  assert.doesNotMatch(source, /api[_ ]?key|bearer|credential|secret/iu);
});
