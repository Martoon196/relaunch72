import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { discoverMigrations } from '../../src/db/migrate.js';
import { assertRuntimeSchemaCurrent } from '../../src/db/runtime-readiness.js';
const entry = { filename: '0128_mhp_sequence_capture_entry.sql', checksum: '09b35b4eaf6e934c8f560e8d9d645bd3b9f37a34268f77f4afd974ecd1b54e97' };
const sequence = { filename: '0127_mhp_followup_sequences.sql', checksum: 'bfd4319fe4a0f07b93d54d528b54f3468ae0857ad53e53a8b7a038ebb1a76f23' };
const pool = (rows: { filename: string; checksum: string }[]) => ({ query: async () => ({ rows }) }) as any;
let fixture: Promise<{ directory: string; rows: { filename: string; checksum: string }[] }> | undefined;
function bridge() { return fixture ??= (async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'r72-entry-recovery-'));
  const source = (await discoverMigrations()).slice(0,127); assert.equal(source.length,127); assert.deepEqual({ filename: source[126]!.filename, checksum: source[126]!.checksum },sequence);
  await Promise.all(source.map(migration => writeFile(path.join(directory,migration.filename),migration.sql,'utf8')));
  return { directory, rows: source.map(({ filename,checksum }) => ({ filename,checksum })) };
})(); }
test('127 entry recovery bridge accepts exact127 and only reviewed128', async () => {
  const { directory,rows } = await bridge();
  await assert.doesNotReject(assertRuntimeSchemaCurrent(pool(rows),directory));
  await assert.doesNotReject(assertRuntimeSchemaCurrent(pool([...rows,entry]),directory));
});
test('127 entry recovery bridge rejects changed128, duplicate128 and unknown129', async () => {
  const { directory,rows } = await bridge();
  await assert.rejects(assertRuntimeSchemaCurrent(pool([...rows,{ ...entry,checksum:'0'.repeat(64) }]),directory),/migration not present/);
  await assert.rejects(assertRuntimeSchemaCurrent(pool([...rows,entry,entry]),directory),/invalid runtime migration ledger/);
  await assert.rejects(assertRuntimeSchemaCurrent(pool([...rows,entry,{ filename:'0129_unknown.sql',checksum:'a'.repeat(64) }]),directory),/migration not present/);
});
test('128 allowance cannot hide missing127, changed126 or a noncontiguous prefix', async () => {
  const { directory,rows } = await bridge();
  await assert.rejects(assertRuntimeSchemaCurrent(pool([...rows.slice(0,126),entry]),directory),/migration not present/);
  await assert.rejects(assertRuntimeSchemaCurrent(pool([...rows.slice(0,125),{ ...rows[125]!,checksum:'0'.repeat(64) },rows[126]!,entry]),directory),/checksum changed/);
  await assert.rejects(assertRuntimeSchemaCurrent(pool([...rows.slice(1),entry]),directory),/not a contiguous prefix/);
});
test('entry allowance requires exact bundled127 source and cannot be taken by126', async () => {
  const { rows } = await bridge();
  for (const tail of [126,127]) {
    const directory = await mkdtemp(path.join(tmpdir(),'r72-entry-wrong-source-'));
    const source = (await discoverMigrations()).slice(0,tail);
    await Promise.all(source.map(migration => writeFile(path.join(directory,migration.filename),tail===127 && migration.version===127?'SELECT 127;\n':migration.sql,'utf8')));
    await assert.rejects(assertRuntimeSchemaCurrent(pool([...rows,entry]),directory),/checksum changed|migration not present/);
  }
});
