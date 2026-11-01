import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Pool, QueryResult } from 'pg';
import { discoverMigrations } from '../../src/db/migrate.js';
import { assertRuntimeSchemaCurrent } from '../../src/db/runtime-readiness.js';

const approved132 = { filename: '0132_seo_blog_social_promotion.sql', checksum: '6a413abf1e1f04c7ce7cfa181c2ee6c7ced7b0155fcc2c4106ff860c98fa03cb' };
type Row = { filename: string; checksum: string };
function pool(rows: Row[]): Pick<Pool, 'query'> {
  return { query: (async () => ({ rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] } as QueryResult)) as Pool['query'] };
}
async function fixture(tailSql?: string, add132 = false) {
  const directory = await mkdtemp(path.join(tmpdir(), 'r72-seo-social-bridge-'));
  const prefix = (await discoverMigrations()).slice(0, 131);
  assert.equal(prefix.length, 131);
  await Promise.all(prefix.map(m => writeFile(path.join(directory, m.filename), m.version === 131 && tailSql ? tailSql : m.sql)));
  if (add132) await writeFile(path.join(directory, approved132.filename), 'SELECT 132;\n');
  const rows = (await discoverMigrations(directory)).map(({ filename, checksum }) => ({ filename, checksum }));
  return { directory, rows };
}
let cached: ReturnType<typeof fixture> | undefined;
function bridge() { return cached ??= fixture(); }

test('131 SEO social bridge accepts its exact ledger before and after only approved132', async () => {
  const { directory, rows } = await bridge();
  assert.equal(rows[130]?.checksum, '904c4651c51da6507370ca7eb2f271ca0347a27d76c60b0f24a19aba01695784');
  await assert.doesNotReject(assertRuntimeSchemaCurrent(pool(rows), directory));
  await assert.doesNotReject(assertRuntimeSchemaCurrent(pool([...rows, approved132]), directory));
});
test('131 SEO social bridge rejects changed132, duplicates, unknown future rows and corrupt prefix', async () => {
  const { directory, rows } = await bridge();
  await assert.rejects(assertRuntimeSchemaCurrent(pool([...rows, { ...approved132, checksum: '0'.repeat(64) }]), directory), /migration not present/);
  await assert.rejects(assertRuntimeSchemaCurrent(pool([...rows, approved132, approved132]), directory), /invalid runtime migration ledger/);
  await assert.rejects(assertRuntimeSchemaCurrent(pool([...rows, approved132, { filename: '0133_unknown.sql', checksum: 'a'.repeat(64) }]), directory), /migration not present/);
  await assert.rejects(assertRuntimeSchemaCurrent(pool([{ ...rows[0]!, checksum: '0'.repeat(64) }, ...rows.slice(1), approved132]), directory), /checksum changed/);
});
test('approved132 cannot hide missing131 or a gap in the earlier ledger', async () => {
  const { directory, rows } = await bridge();
  await assert.rejects(assertRuntimeSchemaCurrent(pool([...rows.slice(0, -1), approved132]), directory), /migration not present/);
  await assert.rejects(assertRuntimeSchemaCurrent(pool([...rows.slice(1), approved132]), directory), /not a contiguous prefix/);
});
test('131 SEO social bridge requires the exact source tail checksum', async () => {
  const { rows } = await bridge();
  const changed = await fixture('SELECT 131;\n');
  await assert.rejects(assertRuntimeSchemaCurrent(pool([...rows, approved132]), changed.directory), /migration not present/);
});
test('bundled132 runtime takes strict matching rather than the compatibility allowance', async () => {
  const { directory, rows } = await fixture(undefined, true);
  await assert.doesNotReject(assertRuntimeSchemaCurrent(pool(rows), directory));
  await assert.rejects(assertRuntimeSchemaCurrent(pool(rows.slice(0, -1)), directory), /schema is behind by 1 migration/);
  await assert.rejects(assertRuntimeSchemaCurrent(pool([...rows.slice(0, -1), approved132]), directory), /checksum changed/);
});
