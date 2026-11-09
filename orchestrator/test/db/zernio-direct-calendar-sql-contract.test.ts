import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../src/db/migrations/0094_property_predator_zernio_direct_calendar.sql',
  import.meta.url,
);

async function sql(): Promise<string> {
  return (await readFile(migrationUrl, 'utf8')).replace(/--[^\n]*/gu, ' ').replace(/\s+/gu, ' ');
}

test('0094 reserves and settles a bounded LinkedIn schedule through the command role', async () => {
  const source = await sql();
  assert.match(source, /CREATE TABLE app\.property_predator_zernio_direct_schedules/u);
  assert.match(source, /network text NOT NULL CHECK \(network = 'linkedin'\)/u);
  assert.match(source, /CREATE FUNCTION app_private\.reserve_zernio_direct_schedule/u);
  assert.match(source, /session_user <> 'r72_zernio_social_command'/u);
  assert.match(source, /membership\.role IN \('owner', 'admin'\)/u);
  assert.match(source, /p_scheduled_for < statement_timestamp\(\) \+ interval '5 minutes'/u);
  assert.match(source, /\) >= 25 OR \(SELECT count\(\*\)/u);
  assert.match(source, /\) >= 250 THEN/u);
  assert.match(source, /event_type = 'account\.connected'/u);
  assert.match(source, /CREATE FUNCTION app_private\.settle_zernio_direct_schedule/u);
  assert.match(source, /outcome IN \('scheduled', 'failed', 'outcome_unknown'\)/u);
});

test('0094 keeps receipts immutable and the command role table-blind', async () => {
  const source = await sql();
  assert.match(source, /direct_schedule_receipts_immutable BEFORE UPDATE OR DELETE/u);
  assert.match(source, /ALTER TABLE app\.property_predator_zernio_direct_schedules FORCE ROW LEVEL SECURITY/u);
  assert.match(source, /GRANT EXECUTE ON FUNCTION app_private\.reserve_zernio_direct_schedule/u);
  assert.match(source, /GRANT EXECUTE ON FUNCTION app_private\.settle_zernio_direct_schedule/u);
  assert.match(source, /GRANT EXECUTE ON FUNCTION app_private\.list_zernio_direct_schedules/u);
  assert.match(source, /Zernio social command role is not table-blind/u);
  assert.doesNotMatch(source, /api[_ ]?key|bearer|credential|secret/iu);
});
