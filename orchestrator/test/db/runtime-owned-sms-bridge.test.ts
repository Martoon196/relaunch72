import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Pool } from 'pg';
import { discoverMigrations } from '../../src/db/migrate.js';
import { assertRuntimeSchemaCurrent } from '../../src/db/runtime-readiness.js';
const approved = { filename: '0130_mhp_owned_sms_pilot.sql', checksum: 'e6bb5be3a87e0fde3e29d3f47edde1c5daf8492f4c368f80e2e4335f5b239797' };
type Row = typeof approved;
const pool = (rows: Row[]) => ({ query: async () => ({ rows }) }) as unknown as Pick<Pool, 'query'>;
let fixture: Promise<{ directory: string; rows: Row[] }>;
function bridge() {
  return fixture ??= (async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'r72-owned-sms-bridge-')), prefix = (await discoverMigrations()).slice(0, 129);
    assert.equal(prefix.length, 129);
    await Promise.all(prefix.map(row => writeFile(path.join(directory, row.filename), row.sql, 'utf8')));
    return { directory, rows: prefix.map(({ filename, checksum }) => ({ filename, checksum })) };
  })();
}
test('129 bridge accepts exact129 and only reviewed130', async () => {
  const { directory, rows } = await bridge();
  await assert.doesNotReject(assertRuntimeSchemaCurrent(pool(rows), directory));
  await assert.doesNotReject(assertRuntimeSchemaCurrent(pool([...rows, approved]), directory));
});
test('129 bridge rejects changed130, duplicate130 and future131', async () => {
  const { directory, rows } = await bridge();
  await assert.rejects(assertRuntimeSchemaCurrent(pool([...rows, { ...approved, checksum: '0'.repeat(64) }]), directory), /migration not present/u);
  await assert.rejects(assertRuntimeSchemaCurrent(pool([...rows, approved, approved]), directory), /invalid runtime migration ledger/u);
  await assert.rejects(assertRuntimeSchemaCurrent(pool([...rows, approved, { filename: '0131_unknown.sql', checksum: 'a'.repeat(64) }]), directory), /migration not present/u);
});
test('130 allowance cannot excuse missing129 or a changed/noncontiguous prefix', async () => {
  const { directory, rows } = await bridge();
  await assert.rejects(assertRuntimeSchemaCurrent(pool([...rows.slice(0, 128), approved]), directory), /migration not present/u);
  await assert.rejects(assertRuntimeSchemaCurrent(pool([{ ...rows[0]!, checksum: '0'.repeat(64) }, ...rows.slice(1), approved]), directory), /checksum changed/u);
  await assert.rejects(assertRuntimeSchemaCurrent(pool([...rows.slice(1), approved]), directory), /not a contiguous prefix/u);
});
test('130 allowance requires the exact bundled129 source tail', async () => {
  const { rows } = await bridge(), directory = await mkdtemp(path.join(tmpdir(), 'r72-owned-sms-wrong-tail-'));
  const prefix = (await discoverMigrations()).slice(0, 129);
  await Promise.all(prefix.map(row => writeFile(path.join(directory, row.filename), row.version === 129 ? 'SELECT 129;\n' : row.sql, 'utf8')));
  await assert.rejects(assertRuntimeSchemaCurrent(pool([...rows, approved]), directory), /checksum changed|migration not present/u);
});
