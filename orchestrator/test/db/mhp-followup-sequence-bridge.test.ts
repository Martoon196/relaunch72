import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Pool } from 'pg';
import { discoverMigrations } from '../../src/db/migrate.js';
import { assertRuntimeSchemaCurrent } from '../../src/db/runtime-readiness.js';

const next = { filename: '0127_mhp_followup_sequences.sql', checksum: 'bfd4319fe4a0f07b93d54d528b54f3468ae0857ad53e53a8b7a038ebb1a76f23' };
const pool = (rows: readonly { filename: string; checksum: string }[]): Pick<Pool, 'query'> => ({
  query: async () => ({ rows }),
}) as unknown as Pick<Pool, 'query'>;
const migrations = await discoverMigrations();
const rows = migrations.map(({ filename, checksum }) => ({ filename, checksum }));

test('126 bridge accepts exact126 and only the reviewed127 additive ledger', async () => {
  assert.equal(rows.length, 126);
  await assert.doesNotReject(assertRuntimeSchemaCurrent(pool(rows)));
  await assert.doesNotReject(assertRuntimeSchemaCurrent(pool([...rows, next])));
});
test('126 bridge rejects wrong127, duplicate127, unknown128 and changed126', async () => {
  await assert.rejects(assertRuntimeSchemaCurrent(pool([...rows, { ...next, checksum: '0'.repeat(64) }])), /not present/);
  await assert.rejects(assertRuntimeSchemaCurrent(pool([...rows, next, next])), /invalid runtime migration ledger/);
  await assert.rejects(assertRuntimeSchemaCurrent(pool([...rows, next, { filename: '0128_unknown.sql', checksum: 'a'.repeat(64) }])), /not present/);
  await assert.rejects(assertRuntimeSchemaCurrent(pool([...rows.slice(0, -1), { ...rows[125]!, checksum: '0'.repeat(64) }, next])), /not present|checksum changed/);
});
test('126 bridge never hides a missing126, older gap or changed prefix', async () => {
  await assert.rejects(assertRuntimeSchemaCurrent(pool([...rows.slice(0, -1), next])), /not present/);
  await assert.rejects(assertRuntimeSchemaCurrent(pool([...rows.slice(0, 124), rows[125]!, next])), /contiguous prefix/);
  await assert.rejects(assertRuntimeSchemaCurrent(pool([{ ...rows[0]!, checksum: '0'.repeat(64) }, ...rows.slice(1), next])), /checksum changed/);
});
test('source which bundles127 uses normal strict readiness rather than the bridge allowance', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'r72-followup-strict-'));
  await Promise.all(migrations.map(m => writeFile(path.join(directory, m.filename), m.sql, 'utf8')));
  // Synthetic parser fixture only; this is not a claim that0127 SQL was run.
  await writeFile(path.join(directory, next.filename), '-- strict readiness parser fixture only\n', 'utf8');
  const strictRows = (await discoverMigrations(directory)).map(({ filename, checksum }) => ({ filename, checksum }));
  await assert.doesNotReject(assertRuntimeSchemaCurrent(pool(strictRows), directory));
  await assert.rejects(assertRuntimeSchemaCurrent(pool(rows), directory), /behind by 1 migration/);
  await assert.rejects(assertRuntimeSchemaCurrent(pool([...rows, next]), directory), /checksum changed/);
});
