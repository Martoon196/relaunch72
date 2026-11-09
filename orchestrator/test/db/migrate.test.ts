import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Pool, PoolClient, QueryResult } from 'pg';
import { assertSchemaCurrent, discoverMigrations, runMigrations } from '../../src/db/migrate.js';

class MigrationClient {
  readonly calls: Array<{ sql: string; values?: unknown[] }> = [];
  readonly applied = new Map<string, string>();
  ledgerExists = false;
  released = false;
  releaseArgument: boolean | Error | undefined;
  failUnlock = false;

  async query(sql: string, values?: unknown[]): Promise<QueryResult> {
    this.calls.push({ sql, values });
    if (sql.includes("to_regclass('app_private.schema_migrations')")) {
      return this.result([{ ledger: this.ledgerExists ? 'app_private.schema_migrations' : null }]);
    }
    if (sql.includes('SELECT filename, checksum FROM app_private.schema_migrations')) {
      return this.result([...this.applied].map(([filename, checksum]) => ({ filename, checksum })));
    }
    if (sql.includes('INSERT INTO app_private.schema_migrations')) {
      const [filename, checksum] = values as [string, string];
      this.applied.set(filename, checksum);
      return this.result([]);
    }
    if (sql.includes('pg_advisory_unlock')) {
      if (this.failUnlock) throw new Error('unlock connection failed');
      return this.result([{ unlocked: true }]);
    }
    if (sql.includes('-- test migration')) this.ledgerExists = true;
    return this.result([]);
  }

  release(error?: boolean | Error): void {
    this.released = true;
    this.releaseArgument = error;
  }

  private result(rows: Record<string, unknown>[]): QueryResult {
    return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] };
  }
}

function migrationPool(client: MigrationClient): Pick<Pool, 'connect'> {
  return { connect: async () => client as unknown as PoolClient } as Pick<Pool, 'connect'>;
}

async function migrationDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'r72-migrations-'));
  await writeFile(path.join(directory, '0001_first.sql'), "-- test migration\nSELECT 'first';\n", 'utf8');
  await writeFile(path.join(directory, '0002_second.sql'), "-- test migration\nSELECT 'second';\n", 'utf8');
  return directory;
}

test('migration discovery requires a contiguous, strictly named sequence', async () => {
  const directory = await migrationDirectory();
  const migrations = await discoverMigrations(directory);
  assert.deepEqual(migrations.map((migration) => migration.filename), ['0001_first.sql', '0002_second.sql']);
  assert.match(migrations[0]!.checksum, /^[0-9a-f]{64}$/);
  await writeFile(path.join(directory, '0001_first.sql'), "-- test migration\r\nSELECT 'first';\r\n", 'utf8');
  const windowsCheckout = await discoverMigrations(directory);
  assert.equal(windowsCheckout[0]!.checksum, migrations[0]!.checksum);

  await writeFile(path.join(directory, '0004_gap.sql'), '-- test migration\nSELECT 4;\n', 'utf8');
  await assert.rejects(discoverMigrations(directory), /expected 0003, found 0004_gap\.sql/);
});

test('migration runner locks, applies transactionally, records checksums, and is idempotent', async () => {
  const directory = await migrationDirectory();
  const client = new MigrationClient();
  const first = await runMigrations(migrationPool(client), directory);
  assert.deepEqual(first.applied, ['0001_first.sql', '0002_second.sql']);
  assert.deepEqual(first.alreadyApplied, []);
  assert.equal(client.applied.size, 2);
  assert.match(client.calls[0]!.sql, /pg_advisory_lock/);
  assert.match(client.calls.at(-1)!.sql, /pg_advisory_unlock/);
  assert.equal(client.released, true);
  assert.equal(client.releaseArgument, false);

  client.released = false;
  client.calls.length = 0;
  const second = await runMigrations(migrationPool(client), directory);
  assert.deepEqual(second.applied, []);
  assert.deepEqual(second.alreadyApplied, ['0001_first.sql', '0002_second.sql']);
  assert.equal(client.calls.some((call) => call.sql === 'BEGIN'), false);
  assert.equal(client.released, true);
});

test('migration runner destroys a session when its advisory lock cannot be released', async () => {
  const directory = await migrationDirectory();
  const client = new MigrationClient();
  client.failUnlock = true;

  await assert.rejects(runMigrations(migrationPool(client), directory), /unlock connection failed/);
  assert.equal(client.released, true);
  assert.equal(client.releaseArgument, true);
});

test('migration runner preserves both the migration and unlock failures', async () => {
  const directory = await migrationDirectory();
  const client = new MigrationClient();
  client.ledgerExists = true;
  client.applied.set('9999_not_in_release.sql', '0'.repeat(64));
  client.failUnlock = true;

  await assert.rejects(
    runMigrations(migrationPool(client), directory),
    (error: unknown) => error instanceof AggregateError && error.errors.length === 2,
  );
  assert.equal(client.releaseArgument, true);
});

test('migration runner refuses checksum changes and unknown database history', async () => {
  const directory = await migrationDirectory();
  const client = new MigrationClient();
  await runMigrations(migrationPool(client), directory);

  await writeFile(path.join(directory, '0001_first.sql'), "-- test migration\nSELECT 'changed';\n", 'utf8');
  client.released = false;
  client.calls.length = 0;
  await assert.rejects(runMigrations(migrationPool(client), directory), /checksum changed: 0001_first\.sql/);
  assert.match(client.calls.at(-1)!.sql, /pg_advisory_unlock/);
  assert.equal(client.released, true);

  const restored = await discoverMigrations(directory);
  client.applied.set('9999_not_in_release.sql', restored[0]!.checksum);
  await assert.rejects(runMigrations(migrationPool(client), directory), /not present in this release/);
});

test('migration runner rejects a non-prefix applied history', async () => {
  const directory = await migrationDirectory();
  const migrations = await discoverMigrations(directory);
  const client = new MigrationClient();
  client.ledgerExists = true;
  client.applied.set(migrations[1]!.filename, migrations[1]!.checksum);
  await assert.rejects(runMigrations(migrationPool(client), directory), /not a contiguous prefix/);
});

test('schema readiness fails closed while behind and passes only at the exact release', async () => {
  const directory = await migrationDirectory();
  const client = new MigrationClient();
  await assert.rejects(
    assertSchemaCurrent(migrationPool(client), directory),
    /schema is behind by 2 migration\(s\)/,
  );
  await runMigrations(migrationPool(client), directory);
  await assert.doesNotReject(assertSchemaCurrent(migrationPool(client), directory));
});
