import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../src/db/migrations/0096_zernio_direct_calendar_lock_repair.sql',
  import.meta.url,
);

async function sql(): Promise<string> {
  return (await readFile(migrationUrl, 'utf8')).replace(/--[^\n]*/gu, ' ').replace(/\s+/gu, ' ');
}

test('0096 replaces the impossible account row lock with per-account serialization', async () => {
  const source = await sql();
  assert.match(source, /CREATE OR REPLACE FUNCTION app_private\.reserve_zernio_direct_schedule_v2/u);
  assert.match(source, /zernio-direct-calendar-account:/u);
  assert.match(source, /7200096/u);
  assert.doesNotMatch(source, /FOR UPDATE OF account, connection/u);
  assert.match(source, /probe\.probed_at >= statement_timestamp\(\) - interval '24 hours'/u);
  assert.match(source, /membership\.role IN \('owner', 'admin'\)/u);
  assert.match(source, />= 25/u);
  assert.match(source, />= 250/u);
});

test('0096 keeps provider truth read-only and the command role table-blind', async () => {
  const source = await sql();
  assert.match(source, /REVOKE CREATE ON SCHEMA app_private FROM r72_owned_social_definer/u);
  assert.match(source, /has_table_privilege\('r72_owned_social_definer', 'app\.provider_connections', 'UPDATE'\)/u);
  assert.match(source, /has_table_privilege\('r72_owned_social_definer', 'app\.property_predator_zernio_accounts', 'UPDATE'\)/u);
  assert.doesNotMatch(source, /GRANT UPDATE[^;]+(?:provider_connections|property_predator_zernio_accounts)/u);
  assert.doesNotMatch(source, /api[_ ]?key|bearer|credential|secret/iu);
});
