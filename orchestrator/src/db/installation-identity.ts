import type { Pool, QueryResult, QueryResultRow } from 'pg';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface InstallationIdentityRow extends QueryResultRow {
  installationId: unknown;
}

function expectedUuid(value: string | undefined): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new Error('Expected database installation UUID is required');
  }
  return value;
}

/**
 * Prove that one least-privilege runtime pool reaches the configured database
 * installation. Call this for every production role/pool with the same
 * operator-provided UUID. Database driver errors are deliberately discarded so
 * a connection URL or credential can never be copied into readiness output.
 */
export async function assertExpectedDatabaseInstallation(
  pool: Pick<Pool, 'query'>,
  expectedInstallationId: string | undefined,
): Promise<void> {
  const expected = expectedUuid(expectedInstallationId);
  let result: QueryResult<InstallationIdentityRow>;
  try {
    result = await pool.query<InstallationIdentityRow>(
      `/* database.installation-identity */
       SELECT app_private.runtime_database_installation_id()::text AS "installationId"`,
    );
  } catch {
    throw new Error('Database installation identity could not be verified');
  }

  const actual = result.rows[0]?.installationId;
  if (result.rows.length !== 1 || typeof actual !== 'string' || !UUID.test(actual)) {
    throw new Error('Database installation identity could not be verified');
  }
  if (actual !== expected) {
    throw new Error('Database installation identity mismatch');
  }
}
