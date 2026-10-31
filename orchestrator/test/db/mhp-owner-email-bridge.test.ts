import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { discoverMigrations } from '../../src/db/migrate.js';
import { assertRuntimeSchemaCurrent } from '../../src/db/runtime-readiness.js';

const approved = { filename: '0126_mhp_owner_email_editor.sql',
  checksum: '317555ffd745918305f4d9209112ed4abf7eca8ed283e7db3ceb0bffcd2aef76' };
const migrations = await discoverMigrations();
assert.equal(migrations.length, 125);
assert.equal(migrations[124]?.filename, '0125_mhp_webinar_lead_candidates.sql');
const rows = migrations.map(({ filename, checksum }) => ({ filename, checksum }));
const check = (ledger: typeof rows) => assertRuntimeSchemaCurrent({
  query: async () => ({ rows: ledger }),
} as unknown as Pick<Pool, 'query'>);

test('owner email bridge accepts its exact125 ledger', async () => {
  await assert.doesNotReject(check(rows));
});
test('owner email bridge accepts only reviewed126 after exact125', async () => {
  await assert.doesNotReject(check([...rows, approved]));
});
test('owner email bridge rejects a different126 checksum', async () => {
  await assert.rejects(check([...rows, { ...approved, checksum: '0'.repeat(64) }]), /migration not present/);
});
test('owner email bridge rejects duplicate126 rows', async () => {
  await assert.rejects(check([...rows, approved, approved]), /invalid runtime migration ledger/);
});
test('owner email bridge rejects unknown127 alongside reviewed126', async () => {
  await assert.rejects(check([...rows, approved, { filename: '0127_unknown.sql', checksum: 'a'.repeat(64) }]), /migration not present/);
});
test('owner email bridge cannot hide missing125 behind reviewed126', async () => {
  await assert.rejects(check([...rows.slice(0, 124), approved]), /migration not present/);
});
test('owner email bridge rejects changed earlier checksums', async () => {
  await assert.rejects(check([{ ...rows[0]!, checksum: '0'.repeat(64) }, ...rows.slice(1), approved]), /checksum changed/);
});
test('owner email bridge rejects a noncontiguous prefix', async () => {
  await assert.rejects(check([...rows.slice(1), approved]), /not a contiguous prefix/);
});
