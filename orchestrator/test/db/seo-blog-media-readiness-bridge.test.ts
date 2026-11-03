import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import type { Pool, QueryResult } from 'pg';
import { discoverMigrations } from '../../src/db/migrate.js';
import { assertRuntimeSchemaCurrent } from '../../src/db/runtime-readiness.js';

type Row = { filename: string; checksum: string };
const mediaFilename = '0136_seo_blog_media_storage.sql';
// Independently reviewed b90cec0 migration; keep the runtime and this test exact.
const approvedMediaChecksum: string | null = '24ce1ac40bea289a9292b029ae010965805f8f45f3b458c03a4edfcb34e3e0cd';
const mediaRow: Row = { filename: mediaFilename, checksum: approvedMediaChecksum ?? 'a'.repeat(64) };
const tailChecksum = '9f73caa543ac243304063866897c4900301c4bb64bcf7f6d238cd668c8cc2be2';
const tempDirectories: string[] = [];

function pool(rows: Row[]): Pick<Pool, 'query'> {
  return { query: (async (sql: string) => {
    assert.match(sql, /FROM app_private\.runtime_schema_migrations\(\)/);
    return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] } as QueryResult;
  }) as Pool['query'] };
}

async function fixture(options: { changedTail?: boolean; include136?: boolean } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'r72-media-bridge-'));
  tempDirectories.push(directory);
  const prefix = (await discoverMigrations()).slice(0, 135);
  assert.equal(prefix.length, 135);
  assert.equal(prefix[134]?.filename, '0135_mhp_event_phone_signup_handoff.sql');
  assert.equal(prefix[134]?.checksum, tailChecksum);
  await Promise.all(prefix.map(m => writeFile(
    path.join(directory, m.filename),
    options.changedTail && m.version === 135 ? 'SELECT 135;\n' : m.sql,
    'utf8',
  )));
  if (options.include136) {
    // Source-only ledger fixture: no SQL or database is executed.
    await writeFile(path.join(directory, mediaFilename), 'SELECT 136;\n', 'utf8');
  }
  const rows = (await discoverMigrations(directory)).map(({ filename, checksum }) => ({ filename, checksum }));
  return { directory, rows };
}
let cached: ReturnType<typeof fixture> | undefined;
function bridge() { return cached ??= fixture(); }
after(async () => { await Promise.all(tempDirectories.map(async directory => {
  const resolved = path.resolve(directory);
  assert.equal(path.dirname(resolved), path.resolve(tmpdir()));
  assert.match(path.basename(resolved), /^r72-media-bridge-/);
  await rm(resolved, { recursive: true, force: true });
})); });

test('media136 bridge hash is explicit and agrees with the runtime source', async () => {
  const source = await readFile(new URL('../../src/db/runtime-readiness.ts', import.meta.url), 'utf8');
  const constant = source.match(/const SEO_BLOG_MEDIA_CHECKSUM: string \| null = (null|'[0-9a-f]{64}');/);
  assert.ok(constant, 'compatibility hash must be explicit null or exact reviewed hex');
  assert.equal(constant[1], approvedMediaChecksum === null ? 'null' : "'" + approvedMediaChecksum + "'");
});

test('135 media bridge keeps its complete existing ledger ready', async () => {
  const { directory, rows } = await bridge();
  await assert.doesNotReject(assertRuntimeSchemaCurrent(pool(rows), directory));
});

test('135 media bridge admits only its reviewed136, and remains closed before freeze', async () => {
  const { directory, rows } = await bridge();
  if (approvedMediaChecksum === null) {
    await assert.rejects(assertRuntimeSchemaCurrent(pool([...rows, mediaRow]), directory), /migration not present/);
  } else {
    await assert.doesNotReject(assertRuntimeSchemaCurrent(pool([...rows, mediaRow]), directory));
  }
});

test('135 media bridge rejects wrong136 and unknown137, including beside approved136', async () => {
  const { directory, rows } = await bridge();
  await assert.rejects(assertRuntimeSchemaCurrent(pool([...rows, { ...mediaRow, checksum: '0'.repeat(64) }]), directory), /migration not present/);
  await assert.rejects(assertRuntimeSchemaCurrent(pool([...rows, mediaRow, { filename: '0137_unknown.sql', checksum: 'f'.repeat(64) }]), directory), /migration not present/);
  await assert.rejects(assertRuntimeSchemaCurrent(pool([...rows, { filename: '0137_unknown.sql', checksum: 'f'.repeat(64) }]), directory), /migration not present/);
});

test('135 media bridge rejects duplicate136 before compatibility filtering', async () => {
  const { directory, rows } = await bridge();
  await assert.rejects(assertRuntimeSchemaCurrent(pool([...rows, mediaRow, mediaRow]), directory), /invalid runtime migration ledger/);
});

test('136 never hides missing135, missing earlier rows, or changed prefix checksums', async () => {
  const { directory, rows } = await bridge();
  await assert.rejects(assertRuntimeSchemaCurrent(pool([...rows.slice(0, -1), mediaRow]), directory));
  await assert.rejects(assertRuntimeSchemaCurrent(pool([...rows.slice(1), mediaRow]), directory));
  await assert.rejects(assertRuntimeSchemaCurrent(pool([{ ...rows[0]!, checksum: '0'.repeat(64) }, ...rows.slice(1), mediaRow]), directory));
  await assert.rejects(assertRuntimeSchemaCurrent(pool([...rows.slice(0, -1), { ...rows[134]!, checksum: '0'.repeat(64) }, mediaRow]), directory));
});

test('135 media bridge requires the exact bundled135 tail as well as the applied tail', async () => {
  const { rows } = await bridge();
  const changed = await fixture({ changedTail: true });
  await assert.rejects(assertRuntimeSchemaCurrent(pool([...rows, mediaRow]), changed.directory));
  await assert.rejects(assertRuntimeSchemaCurrent(pool([...changed.rows, mediaRow]), changed.directory), /migration not present/);
});

test('bundled136 is strict and cannot fall back to135, even when the bridge136 hash is known', async () => {
  const { directory, rows } = await fixture({ include136: true });
  await assert.doesNotReject(assertRuntimeSchemaCurrent(pool(rows), directory));
  await assert.rejects(assertRuntimeSchemaCurrent(pool(rows.slice(0, -1)), directory), /schema is behind by 1 migration/);
  await assert.rejects(assertRuntimeSchemaCurrent(pool([...rows.slice(0, -1), mediaRow]), directory), /checksum changed/);
  await assert.rejects(assertRuntimeSchemaCurrent(pool([...rows, { filename: '0137_unknown.sql', checksum: 'f'.repeat(64) }]), directory), /migration not present/);
});
