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

// INV-CRM-001 bridge/recovery artifact only. The application in this artifact
// retains d01e1f8 behavior and does not compose investor services. These exact
// additive migrations may be pending during the rolling database cutover.
// Never copy this exception into the investor application, which requires 112.
const INVESTOR_BRIDGE_SUFFIX = new Map([
  ['0107_investor_programme.sql', '3cb8fd130ba8fd4c96660d7bc8eeb548e2123e57dbfcaa4ce473b0e529b5b873'],
  ['0108_investor_sites.sql', '6f74dbde4115b691344eb8004b41011e92d86cace9e0bf12ea16b0967c1b4fbc'],
  ['0109_investor_mail_connections.sql', 'd7bfc95eeabf7ed8e1a3fd03e9754254d9829b54f53b2d78863e0820d98290fc'],
  ['0110_investor_email_workflow.sql', '77dc11e89daa3668aae8f9d49f8b1a1df13dcdf8c824c403ea640db41527b51b'],
  ['0111_investor_email_dispatch.sql', 'a983d9adc12a29b3efd4e475b0292f56a871951e908cbf988fa20335c1b2d9c9'],
  ['0112_investor_email_replies.sql', 'ad2fbd413fbc3c10d5dc9cd55728a05e78559875fc5634c7c27ffbf0605b9910'],
]);

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
  const investorBridge = migrations.length === 112
    && migrations[105]?.filename === FINANCE_COMPATIBILITY_MIGRATION
    && migrations[105]?.checksum === FINANCE_COMPATIBILITY_CHECKSUM
    && migrations.slice(106).every((migration) => INVESTOR_BRIDGE_SUFFIX.get(migration.filename) === migration.checksum);
  // The normal validator above still rejects unknown, duplicated, changed and
  // non-contiguous ledger rows. Only this exact old-app artifact permits the
  // named additive suffix to remain pending; all 106 baseline rows are required.
  const pending = migrations.filter((migration) => !applied.has(migration.filename)
    && !(investorBridge && migration.version >= 107));
  if (pending.length > 0) {
    throw new Error(`Database schema is behind by ${pending.length} migration(s); first pending: ${pending[0]!.filename}`);
  }
}
