import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';
import { loadDatabaseConfig } from './config.js';
import { createDatabasePool } from './pool.js';

export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));
export const MIGRATION_LOCK_KEYS = [1_382_302_770, 7_200_001] as const;

const MIGRATION_NAME = /^(\d{4})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;

export interface SqlMigration {
  filename: string;
  version: number;
  checksum: string;
  sql: string;
}

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

interface AppliedMigrationRow {
  filename: string;
  checksum: string;
}

function checksumSql(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

export async function discoverMigrations(
  migrationsDir: string = DEFAULT_MIGRATIONS_DIR,
): Promise<SqlMigration[]> {
  const filenames = (await readdir(migrationsDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)
    .sort();

  if (filenames.length === 0) throw new Error('No SQL migrations were found');
  const migrations: SqlMigration[] = [];
  let expectedVersion = 1;
  for (const filename of filenames) {
    const match = MIGRATION_NAME.exec(filename);
    if (!match) throw new Error(`Invalid migration filename: ${filename}`);
    const version = Number(match[1]);
    if (version !== expectedVersion) {
      throw new Error(`Migration sequence must be contiguous: expected ${String(expectedVersion).padStart(4, '0')}, found ${filename}`);
    }
    // Git checkouts may use CRLF on Windows and LF in production. Canonicalise
    // only line endings so the same committed migration has one checksum.
    const sql = (await readFile(path.join(migrationsDir, filename), 'utf8')).replace(/\r\n?/g, '\n');
    if (!sql.trim()) throw new Error(`Migration is empty: ${filename}`);
    migrations.push({ filename, version, sql, checksum: checksumSql(sql) });
    expectedVersion += 1;
  }
  return migrations;
}

async function loadAppliedMigrations(client: PoolClient): Promise<Map<string, string>> {
  const ledger = await client.query<{ ledger: string | null }>(
    `SELECT to_regclass('app_private.schema_migrations')::text AS ledger`,
  );
  if (!ledger.rows[0]?.ledger) return new Map();
  const rows = await client.query<AppliedMigrationRow>(
    `SELECT filename, checksum FROM app_private.schema_migrations ORDER BY filename`,
  );
  return new Map(rows.rows.map((row) => [row.filename, row.checksum]));
}

export function validateAppliedState(
  migrations: SqlMigration[],
  applied: Map<string, string>,
): void {
  const known = new Set(migrations.map((migration) => migration.filename));
  for (const filename of applied.keys()) {
    if (!known.has(filename)) {
      throw new Error(`Database contains migration not present in this release: ${filename}`);
    }
  }

  let foundPending = false;
  for (const migration of migrations) {
    const storedChecksum = applied.get(migration.filename);
    if (!storedChecksum) {
      foundPending = true;
      continue;
    }
    if (foundPending) {
      throw new Error(`Database migration history is not a contiguous prefix at ${migration.filename}`);
    }
    if (storedChecksum !== migration.checksum) {
      throw new Error(`Applied migration checksum changed: ${migration.filename}`);
    }
  }
}

async function applyOne(client: PoolClient, migration: SqlMigration): Promise<void> {
  await client.query('BEGIN');
  try {
    // SQL files are trusted, version-controlled product behaviour. Never accept
    // a migration path or SQL body from an HTTP/API caller.
    await client.query(migration.sql);
    await client.query(
      `INSERT INTO app_private.schema_migrations (filename, checksum)
       VALUES ($1, $2)`,
      [migration.filename, migration.checksum],
    );
    await client.query('COMMIT');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], `Migration and rollback failed: ${migration.filename}`);
    }
    throw error;
  }
}

/** Apply pending migrations under one session-level advisory lock. */
export async function runMigrations(
  pool: Pick<Pool, 'connect'>,
  migrationsDir: string = DEFAULT_MIGRATIONS_DIR,
): Promise<MigrationResult> {
  const migrations = await discoverMigrations(migrationsDir);
  const client = await pool.connect();
  let locked = false;
  let primaryError: unknown;
  let destroyClient = false;
  try {
    await client.query('SELECT pg_advisory_lock($1, $2)', [...MIGRATION_LOCK_KEYS]);
    locked = true;
    const existing = await loadAppliedMigrations(client);
    validateAppliedState(migrations, existing);

    const result: MigrationResult = { applied: [], alreadyApplied: [] };
    for (const migration of migrations) {
      if (existing.has(migration.filename)) {
        result.alreadyApplied.push(migration.filename);
        continue;
      }
      await applyOne(client, migration);
      result.applied.push(migration.filename);
    }
    return result;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    let unlockError: unknown;
    if (locked) {
      try {
        const unlock = await client.query<{ unlocked: boolean }>(
          'SELECT pg_advisory_unlock($1, $2) AS unlocked',
          [...MIGRATION_LOCK_KEYS],
        );
        if (unlock.rows[0]?.unlocked !== true) {
          throw new Error('Database migration advisory lock was not held by this session');
        }
      } catch (error) {
        unlockError = error;
        destroyClient = true;
      }
    }
    // A session whose lock could not be positively released must never return
    // to the pool: a leaked session-level lock can stall every later deploy.
    client.release(destroyClient);
    if (unlockError && primaryError) {
      throw new AggregateError([primaryError, unlockError], 'Migration and advisory unlock both failed');
    }
    if (unlockError) throw unlockError;
  }
}

/** Read-only production readiness check: no migration is applied here. */
export async function assertSchemaCurrent(
  pool: Pick<Pool, 'connect'>,
  migrationsDir: string = DEFAULT_MIGRATIONS_DIR,
): Promise<void> {
  const migrations = await discoverMigrations(migrationsDir);
  const client = await pool.connect();
  try {
    const applied = await loadAppliedMigrations(client);
    validateAppliedState(migrations, applied);
    const pending = migrations.filter((migration) => !applied.has(migration.filename));
    if (pending.length > 0) {
      throw new Error(`Database schema is behind by ${pending.length} migration(s); first pending: ${pending[0]!.filename}`);
    }
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  // CLI convenience only. Library consumers (especially isolated workers)
  // must not load a repository .env file as an import side effect.
  await import('../config.js');
  const config = loadDatabaseConfig('migrator');
  const pool = createDatabasePool(config);
  try {
    if (process.argv.includes('--check')) {
      await assertSchemaCurrent(pool);
      console.log('Database schema is current.');
    } else {
      const result = await runMigrations(pool);
      console.log(`Database migrations complete: ${result.applied.length} applied, ${result.alreadyApplied.length} already current.`);
    }
  } finally {
    await pool.end();
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath.toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Database migration failed');
    process.exitCode = 1;
  });
}
