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

const FINANCE_COMPATIBILITY_MIGRATION = '0106_finance_planning_drafts.sql';
const FINANCE_COMPATIBILITY_CHECKSUM = '422d1766390910417b397bb34607f74a56c8d7744c3f88a84c4ae46e39ae40ba';

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

  // This pre-finance recovery build supports only the reviewed additive 0106.
  // A release which bundles 0106 takes the normal strict path and requires it.
  // The database ledger is read-only; all earlier and unknown rows still pass
  // through the existing exact-checksum and contiguous-prefix validation.
  if (migrations.length === 105
      && migrations[104]?.filename === '0105_public_social_planner_session_lock.sql'
      && applied.get(FINANCE_COMPATIBILITY_MIGRATION) === FINANCE_COMPATIBILITY_CHECKSUM) {
    applied.delete(FINANCE_COMPATIBILITY_MIGRATION);
  }
  validateAppliedState(migrations, applied);
  const pending = migrations.filter((migration) => !applied.has(migration.filename));
  if (pending.length > 0) {
    throw new Error(`Database schema is behind by ${pending.length} migration(s); first pending: ${pending[0]!.filename}`);
  }
}
