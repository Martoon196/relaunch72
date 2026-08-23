import type { Pool, QueryResultRow } from 'pg';
import {
  DEFAULT_MIGRATIONS_DIR,
  discoverMigrations,
  validateAppliedState,
} from './migrate.js';

interface RuntimeMigrationRow extends QueryResultRow {
  filename: string;
  checksum: string;
}

/**
 * Prove that a least-privilege runtime is connected to the exact schema bundled
 * with this release. The safe SQL function exists only from migration 0004, so
 * an older database fails closed before any portal service is composed.
 */
export async function assertRuntimeSchemaCurrent(
  pool: Pick<Pool, 'query'>,
  migrationsDir: string = DEFAULT_MIGRATIONS_DIR,
): Promise<void> {
  const migrations = await discoverMigrations(migrationsDir);
  const result = await pool.query<RuntimeMigrationRow>(
    `/* database.runtime-schema-readiness */
     SELECT filename, checksum
     FROM app_private.runtime_schema_migrations()`,
  );
  const applied = new Map<string, string>();
  for (const row of result.rows) {
    if (typeof row.filename !== 'string' || typeof row.checksum !== 'string' || applied.has(row.filename)) {
      throw new Error('Database returned an invalid runtime migration ledger');
    }
    applied.set(row.filename, row.checksum);
  }
  validateAppliedState(migrations, applied);
  const pending = migrations.filter((migration) => !applied.has(migration.filename));
  if (pending.length > 0) {
    throw new Error(`Database schema is behind by ${pending.length} migration(s); first pending: ${pending[0]!.filename}`);
  }
}
