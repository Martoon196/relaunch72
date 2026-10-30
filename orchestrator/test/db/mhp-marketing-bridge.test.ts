import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { discoverMigrations } from '../../src/db/migrate.js';
import { assertRuntimeSchemaCurrent } from '../../src/db/runtime-readiness.js';

const approved = { filename: '0124_mhp_brand_marketing_workspace.sql',
  checksum: '6d17547dc37070b736f23e2a7906dc40739b66c50de262eacdbe9ace7e011209' };
const migrations = await discoverMigrations();
assert.equal(migrations.length, 123);
assert.equal(migrations[122]?.filename, '0123_sms_phone_receipt_trigger_acl.sql');
const rows = migrations.map(({ filename, checksum }) => ({ filename, checksum }));
const check = (ledger: typeof rows) => assertRuntimeSchemaCurrent({
  query: async () => ({ rows: ledger }),
} as unknown as Pick<Pool, 'query'>);

test('marketing bridge accepts its exact production123 ledger', async () => {
  await assert.doesNotReject(check(rows));
});
test('marketing bridge accepts only reviewed124 after exact123', async () => {
  await assert.doesNotReject(check([...rows, approved]));
});
test('marketing bridge rejects a different124 checksum', async () => {
  await assert.rejects(check([...rows, { ...approved, checksum: '0'.repeat(64) }]), /migration not present/);
});
test('marketing bridge rejects duplicate124 ledger rows', async () => {
  await assert.rejects(check([...rows, approved, approved]), /invalid runtime migration ledger/);
});
test('marketing bridge rejects unknown125 alongside reviewed124', async () => {
  await assert.rejects(check([...rows, approved, { filename: '0125_unknown.sql', checksum: 'a'.repeat(64) }]), /migration not present/);
});
test('marketing bridge cannot hide a missing123 behind reviewed124', async () => {
  await assert.rejects(check([...rows.slice(0, 122), approved]), /migration not present/);
});
test('marketing bridge rejects altered earlier source checksums', async () => {
  await assert.rejects(check([{ ...rows[0]!, checksum: '0'.repeat(64) }, ...rows.slice(1), approved]), /checksum changed/);
});
test('marketing bridge rejects a noncontiguous prefix', async () => {
  await assert.rejects(check([...rows.slice(1), approved]), /not a contiguous prefix/);
});
