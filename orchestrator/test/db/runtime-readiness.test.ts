import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Pool, QueryResult } from 'pg';
import { discoverMigrations } from '../../src/db/migrate.js';
import { assertRuntimeSchemaCurrent } from '../../src/db/runtime-readiness.js';

async function fixtureDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'r72-runtime-ledger-'));
  await writeFile(path.join(directory, '0001_first.sql'), 'SELECT 1;\n', 'utf8');
  await writeFile(path.join(directory, '0002_second.sql'), 'SELECT 2;\n', 'utf8');
  return directory;
}

function runtimePool(rows: Array<{ filename: string; checksum: string }>): Pick<Pool, 'query'> {
  return {
    query: (async () => ({ rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] } as QueryResult)) as Pool['query'],
  };
}

test('least-privilege runtime readiness accepts only the exact bundled migration ledger', async () => {
  const directory = await fixtureDirectory();
  const migrations = await discoverMigrations(directory);
  const exact = migrations.map(({ filename, checksum }) => ({ filename, checksum }));
  await assert.doesNotReject(assertRuntimeSchemaCurrent(runtimePool(exact), directory));
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool(exact.slice(0, 1)), directory), /schema is behind by 1 migration/);
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool([
    { ...exact[0]!, checksum: '0'.repeat(64) }, exact[1]!,
  ]), directory), /checksum changed/);
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool([...exact, exact[0]!]), directory), /invalid runtime migration ledger/);
});
