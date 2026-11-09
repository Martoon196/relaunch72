import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Pool } from 'pg';
import { discoverMigrations } from '../../src/db/migrate.js';
import { assertRuntimeSchemaCurrent } from '../../src/db/runtime-readiness.js';
const approved = { filename: '0129_mhp_local_channel_drafts.sql', checksum: '649ba68b60954b6e76d4e702511321e59eff0785128051ed7b81f968abe1b57a' };
type Row = typeof approved;
const pool = (rows: Row[]) => ({ query: async () => ({ rows }) }) as unknown as Pick<Pool, 'query'>;
let fixture: Promise<{ directory: string; rows: Row[] }>;
function bridge() {
  return fixture ??= (async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'r72-local-channel-bridge-')), prefix = (await discoverMigrations()).slice(0, 128);
    assert.equal(prefix.length, 128);
    await Promise.all(prefix.map(row => writeFile(path.join(directory, row.filename), row.sql, 'utf8')));
    return { directory, rows: prefix.map(({ filename, checksum }) => ({ filename, checksum })) };
  })();
}
test('128 bridge accepts exact128 and only reviewed129 without requiring new capabilities', async () => {
  const { directory, rows } = await bridge();
  await assert.doesNotReject(assertRuntimeSchemaCurrent(pool(rows), directory));
  await assert.doesNotReject(assertRuntimeSchemaCurrent(pool([...rows, approved]), directory));
});
test('128 bridge rejects changed129, duplicate129 and future130', async () => {
  const { directory, rows } = await bridge();
  await assert.rejects(assertRuntimeSchemaCurrent(pool([...rows, { ...approved, checksum: '0'.repeat(64) }]), directory), /migration not present/u);
  await assert.rejects(assertRuntimeSchemaCurrent(pool([...rows, approved, approved]), directory), /invalid runtime migration ledger/u);
  await assert.rejects(assertRuntimeSchemaCurrent(pool([...rows, approved, { filename: '0130_unknown.sql', checksum: 'a'.repeat(64) }]), directory), /migration not present/u);
});
test('129 allowance cannot excuse a missing128 or changed/noncontiguous earlier ledger', async () => {
  const { directory, rows } = await bridge();
  await assert.rejects(assertRuntimeSchemaCurrent(pool([...rows.slice(0, 127), approved]), directory), /migration not present/u);
  await assert.rejects(assertRuntimeSchemaCurrent(pool([{ ...rows[0]!, checksum: '0'.repeat(64) }, ...rows.slice(1), approved]), directory), /checksum changed/u);
  await assert.rejects(assertRuntimeSchemaCurrent(pool([...rows.slice(1), approved]), directory), /not a contiguous prefix/u);
});
test('129 allowance requires the exact bundled128 source tail', async () => {
  const { rows } = await bridge(), directory = await mkdtemp(path.join(tmpdir(), 'r72-local-channel-wrong-tail-'));
  const prefix = (await discoverMigrations()).slice(0, 128);
  await Promise.all(prefix.map(row => writeFile(path.join(directory, row.filename), row.version === 128 ? 'SELECT 128;\n' : row.sql, 'utf8')));
  await assert.rejects(assertRuntimeSchemaCurrent(pool([...rows, approved]), directory), /checksum changed|migration not present/u);
});
