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
// MHP-DESK-001 bridge only: unchanged 112 application before/after the atomic
// reviewed suffix. Never accept a partly applied suffix or a different body.
const MHP_BRIDGE_SUFFIX = [
  ['0113_mhp_brand.sql', 'df6d62f511d81188f68ba61565cac6384964045c64fbe35940ab26fe5cec64a7'],
  ['0114_mhp_commerce.sql', 'f6d0e928954b533f1b0116c4dfbac10900c830c0a8e070d4fde5d439af861900'],
  ['0115_mhp_auth.sql', 'f338b8b61a147a9ab2848ca60c9c45f34c990abaa15c8fd2aed48e09720ab535'],
  ['0116_mhp_members.sql', 'f0d4c7b923ed04982216c48e2846348ee59de8c38b8290f6610e7554cd6e4758'],
  ['0117_mhp_manual_grants.sql', 'e5a5ac94fce23e17383b77e24fe29613a94a3e606c8ee863cde45000e58cd53b'],
  ['0118_mhp_catalogue_v3.sql', 'ec3e5f7ae69779f80752da7037135f35bace765012d95b582dacef70235e5fa7'],
] as const;

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
  if (migrations.length === 118 && applied.size === 112 && pending.length === 6
      && migrations[111]?.filename === '0112_investor_email_replies.sql'
      && MHP_BRIDGE_SUFFIX.every(([filename, checksum], index) =>
        migrations[112 + index]?.filename === filename && migrations[112 + index]?.checksum === checksum
        && pending[index]?.filename === filename)) {
    return;
  }
  if (pending.length > 0) {
    throw new Error(`Database schema is behind by ${pending.length} migration(s); first pending: ${pending[0]!.filename}`);
  }
}
