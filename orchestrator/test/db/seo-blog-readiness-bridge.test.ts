import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Pool, QueryResult } from 'pg';
import { discoverMigrations } from '../../src/db/migrate.js';
import { assertRuntimeSchemaCurrent } from '../../src/db/runtime-readiness.js';

const approved131 = { filename: '0131_seo_blog_engine.sql', checksum: '904c4651c51da6507370ca7eb2f271ca0347a27d76c60b0f24a19aba01695784' };
type Row = { filename: string; checksum: string };
function pool(rows: Row[]): Pick<Pool, 'query'> {
  return { query: (async () => ({ rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] } as QueryResult)) as Pool['query'] };
}
async function fixture(tailSql?: string, add131 = false) {
  const directory = await mkdtemp(path.join(tmpdir(), 'r72-seo-bridge-'));
  const prefix = (await discoverMigrations()).slice(0, 130);
  assert.equal(prefix.length, 130);
  await Promise.all(prefix.map(m => writeFile(path.join(directory, m.filename), m.version === 130 && tailSql ? tailSql : m.sql)));
  if (add131) await writeFile(path.join(directory, approved131.filename), 'SELECT 131;\n');
  const rows = (await discoverMigrations(directory)).map(({ filename, checksum }) => ({ filename, checksum }));
  return { directory, rows };
}
let cached: ReturnType<typeof fixture> | undefined;
function bridge() { return cached ??= fixture(); }

test('130 SEO bridge accepts its exact ledger before and after only approved131', async () => {
  const { directory, rows } = await bridge();
  await assert.doesNotReject(assertRuntimeSchemaCurrent(pool(rows), directory));
  await assert.doesNotReject(assertRuntimeSchemaCurrent(pool([...rows, approved131]), directory));
});
test('130 SEO bridge rejects changed131, duplicates, unknown future rows and corrupt prefix', async () => {
  const { directory, rows } = await bridge();
  await assert.rejects(assertRuntimeSchemaCurrent(pool([...rows, { ...approved131, checksum: '0'.repeat(64) }]), directory), /migration not present/);
  await assert.rejects(assertRuntimeSchemaCurrent(pool([...rows, approved131, approved131]), directory), /invalid runtime migration ledger/);
  await assert.rejects(assertRuntimeSchemaCurrent(pool([...rows, approved131, { filename: '0132_unknown.sql', checksum: 'a'.repeat(64) }]), directory), /migration not present/);
  await assert.rejects(assertRuntimeSchemaCurrent(pool([{ ...rows[0]!, checksum: '0'.repeat(64) }, ...rows.slice(1), approved131]), directory), /checksum changed/);
});
test('approved131 cannot hide missing130 or a gap in the earlier ledger', async () => {
  const { directory, rows } = await bridge();
  await assert.rejects(assertRuntimeSchemaCurrent(pool([...rows.slice(0, -1), approved131]), directory), /migration not present/);
  await assert.rejects(assertRuntimeSchemaCurrent(pool([...rows.slice(1), approved131]), directory), /not a contiguous prefix/);
});
test('130 SEO bridge requires the exact source tail checksum', async () => {
  const { rows } = await bridge();
  const changed = await fixture('SELECT 130;\n');
  await assert.rejects(assertRuntimeSchemaCurrent(pool([...rows, approved131]), changed.directory), /migration not present/);
});
test('bundled131 runtime takes strict matching rather than the compatibility allowance', async () => {
  const { directory, rows } = await fixture(undefined, true);
  await assert.doesNotReject(assertRuntimeSchemaCurrent(pool(rows), directory));
  await assert.rejects(assertRuntimeSchemaCurrent(pool(rows.slice(0, -1)), directory), /schema is behind by 1 migration/);
  await assert.rejects(assertRuntimeSchemaCurrent(pool([...rows.slice(0, -1), approved131]), directory), /checksum changed/);
});
