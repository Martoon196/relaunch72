import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../src/db/migrations/0049_property_predator_owned_seed_attestation_window.sql',
  import.meta.url,
);

function normalise(sql: string): string {
  return sql.replace(/--[^\n]*/gu, ' ').replace(/\s+/gu, ' ').trim();
}

test('0049 keeps the global 15-minute window and grants only the exact proof 24 hours', async () => {
  const sql = normalise(await readFile(migrationUrl, 'utf8'));
  assert.match(sql, /expires_at <= checked_at \+ interval '15 minutes' OR/);
  assert.match(sql, /source_system = 'propertypredator\.company-content'/);
  assert.match(sql, /source_item_id = 'growth-hq-owned-seed-delivery-proof'/);
  assert.match(sql, /source_version = 'operational-proof-v1'/);
  assert.match(sql, /\^operational-proof-\[0-9\]\{17\}-\[0-9a-f\]\{16\}\$/);
  assert.match(sql, /6dd76f99e782b91b6db96ed15d1867bdab9f70d9594719e75b33e6cafcb19148/);
  assert.match(sql, /blob_sha256 = content_sha256/);
  assert.match(sql, /expires_at <= checked_at \+ interval '24 hours'/);
  assert.equal(sql.match(/interval '24 hours'/gu)?.length, 1);
});

test('0049 rechecks the immutable source bytes, metadata and office-only boundary in a trigger', async () => {
  const sql = normalise(await readFile(migrationUrl, 'utf8'));
  assert.match(sql, /CREATE FUNCTION app_private\.guard_property_predator_owned_seed_attestation_window\(\)/);
  assert.match(sql, /version\.content_sha256 = NEW\.content_sha256/);
  assert.match(sql, /version\.blob_sha256 = NEW\.blob_sha256/);
  assert.match(sql, /version\.brand_sha256 = NEW\.brand_sha256/);
  assert.match(sql, /version\.content_kind = 'email'/);
  assert.match(sql, /application\/vnd\.propertypredator\.email-draft\+json/);
  assert.match(sql, /version\.metadata ->> 'purpose' = 'owned_seed_delivery_proof'/);
  assert.match(sql, /version\.metadata ->> 'recipientBoundary' = 'fixed_owned_office'/);
  assert.match(sql, /version\.metadata -> 'providerEffects' = 'false'::jsonb/);
  assert.match(sql, /USING ERRCODE = '23514'/);
  assert.match(sql, /BEFORE INSERT ON app\.company_content_source_attestations/);
  assert.match(sql, /REVOKE ALL ON FUNCTION app_private\.guard_property_predator_owned_seed_attestation_window\(\) FROM PUBLIC/);
  assert.doesNotMatch(sql, /https?:\/\/|send_message|publish_social|provider_effect/iu);
});
