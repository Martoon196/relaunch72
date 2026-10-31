import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { discoverMigrations } from '../../src/db/migrate.js';
import { assertRuntimeSchemaCurrent } from '../../src/db/runtime-readiness.js';

const approved = { filename: '0125_mhp_webinar_lead_candidates.sql',
  checksum: '91bd726210fe34fa4edf46565f6c5f48d9005a6a177d735d808101d44f41c259' };
const migrations = await discoverMigrations();
assert.equal(migrations.length, 124);
assert.equal(migrations[123]?.filename, '0124_mhp_brand_marketing_workspace.sql');
const rows = migrations.map(({ filename, checksum }) => ({ filename, checksum }));
const check = (ledger: typeof rows) => assertRuntimeSchemaCurrent({
  query: async () => ({ rows: ledger }),
} as unknown as Pick<Pool, 'query'>);

test('webinar reader bridge accepts its exact124 ledger', async () => {
  await assert.doesNotReject(check(rows));
});
test('webinar reader bridge accepts only reviewed125 after exact124', async () => {
  await assert.doesNotReject(check([...rows, approved]));
});
test('webinar reader bridge rejects a different125 checksum', async () => {
  await assert.rejects(check([...rows, { ...approved, checksum: '0'.repeat(64) }]), /migration not present/);
});
test('webinar reader bridge rejects duplicate125 rows', async () => {
  await assert.rejects(check([...rows, approved, approved]), /invalid runtime migration ledger/);
});
test('webinar reader bridge rejects unknown126 alongside reviewed125', async () => {
  await assert.rejects(check([...rows, approved, { filename: '0126_unknown.sql', checksum: 'a'.repeat(64) }]), /migration not present/);
});
test('webinar reader bridge cannot hide missing124 behind reviewed125', async () => {
  await assert.rejects(check([...rows.slice(0, 123), approved]), /migration not present/);
});
test('webinar reader bridge rejects changed earlier checksums', async () => {
  await assert.rejects(check([{ ...rows[0]!, checksum: '0'.repeat(64) }, ...rows.slice(1), approved]), /checksum changed/);
});
test('webinar reader bridge rejects a noncontiguous prefix', async () => {
  await assert.rejects(check([...rows.slice(1), approved]), /not a contiguous prefix/);
});
