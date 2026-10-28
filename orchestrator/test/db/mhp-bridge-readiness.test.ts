import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { discoverMigrations } from '../../src/db/migrate.js';
import { assertRuntimeSchemaCurrent } from '../../src/db/runtime-readiness.js';

const migrations = await discoverMigrations();
assert.equal(migrations.length, 118);
const rows = migrations.map(({ filename, checksum }) => ({ filename, checksum }));
function pool(ledger: typeof rows): Pick<Pool, 'query'> {
  return { query: async () => ({ rows: ledger }) } as unknown as Pick<Pool, 'query'>;
}
test('MHP bridge accepts the complete exact pre-cutover 112 ledger', async () => {
  await assert.doesNotReject(assertRuntimeSchemaCurrent(pool(rows.slice(0,112))));
});
test('MHP bridge accepts all 118 exact migrations after atomic cutover', async () => {
  await assert.doesNotReject(assertRuntimeSchemaCurrent(pool(rows)));
});
for (const length of [113,114,115,116,117]) test(`MHP bridge refuses partial suffix ${length}`, async () => {
  await assert.rejects(assertRuntimeSchemaCurrent(pool(rows.slice(0,length))), /schema is behind/);
});
test('MHP compatibility never excuses missing or changed original migrations', async () => {
  await assert.rejects(assertRuntimeSchemaCurrent(pool(rows.slice(0,111))), /schema is behind/);
  await assert.rejects(assertRuntimeSchemaCurrent(pool(rows.slice(1,113))), /contiguous prefix/);
  await assert.rejects(assertRuntimeSchemaCurrent(pool([{...rows[0]!,checksum:'0'.repeat(64)},...rows.slice(1,112)])), /checksum changed/);
});
test('MHP bridge refuses every changed suffix checksum', async () => {
  for (let index=112;index<118;index++) {
    const changed = rows.map((row,i) => i===index ? {...row,checksum:'0'.repeat(64)} : row);
    await assert.rejects(assertRuntimeSchemaCurrent(pool(changed)), /checksum changed/);
  }
});
test('MHP bridge refuses unknown and duplicate ledger entries', async () => {
  await assert.rejects(assertRuntimeSchemaCurrent(pool([...rows,{filename:'0119_unknown.sql',checksum:'1'.repeat(64)}])), /not present in this release/);
  await assert.rejects(assertRuntimeSchemaCurrent(pool([...rows,rows[117]!])), /invalid runtime migration ledger/);
});
test('pre-cutover exception is bound to the exact reviewed suffix bodies', async () => {
  const directory=await mkdtemp(path.join(tmpdir(),'mhp-bridge-source-'));
  await Promise.all(migrations.map(m=>writeFile(path.join(directory,m.filename),m.sql+(m.version===118?'\n-- changed source\n':''),'utf8')));
  await assert.rejects(assertRuntimeSchemaCurrent(pool(rows.slice(0,112)),directory), /schema is behind/);
});
