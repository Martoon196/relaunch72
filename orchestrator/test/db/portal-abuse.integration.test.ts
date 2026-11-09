import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import type { Pool, QueryResultRow } from 'pg';
import {
  expectPostgresError,
  openTestDatabase,
  ownerQuery,
  roleQuery,
  testDatabaseSkipReason,
} from './database-helper.js';

const skip = testDatabaseSkipReason();

type AdmissionRow = QueryResultRow & {
  allowed: boolean;
  retry_after_seconds: number;
  lease_hash: Buffer | null;
};

interface Dimension {
  readonly kind: string;
  readonly subject: Buffer;
  readonly capacity: number;
  readonly windowSeconds: number;
  readonly concurrency: number;
  readonly cost?: number;
}

async function admit(
  pool: Pool,
  routeClass: string,
  dimensions: readonly Dimension[],
): Promise<AdmissionRow> {
  const leaseHash = randomBytes(32);
  const evidenceHash = randomBytes(32);
  const rows = await roleQuery<AdmissionRow>(
    pool,
    'r72_abuse_command',
    `SELECT allowed, retry_after_seconds, lease_hash
     FROM app_private.admit_portal_abuse(
       $1::text, $2::text[], $3::bytea[], $4::integer[], $5::integer[],
       $6::integer[], $7::integer[], $8::bytea, $9::bytea
     )`,
    [
      routeClass,
      dimensions.map(({ kind }) => kind),
      dimensions.map(({ subject }) => subject),
      dimensions.map(({ capacity }) => capacity),
      dimensions.map(({ windowSeconds }) => windowSeconds),
      dimensions.map(({ cost }) => cost ?? 1),
      dimensions.map(({ concurrency }) => concurrency),
      leaseHash,
      evidenceHash,
    ],
  );
  assert.equal(rows.length, 1);
  return rows[0]!;
}

async function complete(
  pool: Pool,
  leaseHash: Buffer | null,
  outcome: 'success' | 'auth_failure' | 'service_error',
): Promise<void> {
  assert.ok(leaseHash);
  const rows = await roleQuery<{ completed: boolean } & QueryResultRow>(
    pool,
    'r72_abuse_command',
    `SELECT app_private.complete_portal_abuse_lease($1::bytea, $2::text) AS completed`,
    [leaseHash, outcome],
  );
  assert.deepEqual(rows, [{ completed: true }]);
}

test('portal abuse functions are least-privilege, cross-route and transactionally all-or-nothing', {
  skip,
}, async () => {
  const pool = await openTestDatabase();
  try {
    const privileges = await ownerQuery<{
      admit: boolean;
      complete: boolean;
      ready: boolean;
      installation_identity: boolean;
      installation_identity_table: boolean;
      buckets: boolean;
      leases: boolean;
      denials: boolean;
      unexpected_tables: number;
      unexpected_functions: number;
    } & QueryResultRow>(pool, `
      SELECT
        has_function_privilege(
          'r72_abuse_command',
          'app_private.admit_portal_abuse(text,text[],bytea[],integer[],integer[],integer[],integer[],bytea,bytea)',
          'EXECUTE'
        ) AS admit,
        has_function_privilege(
          'r72_abuse_command',
          'app_private.complete_portal_abuse_lease(bytea,text)',
          'EXECUTE'
        ) AS complete,
        has_function_privilege(
          'r72_abuse_command',
          'app_private.portal_abuse_ready()',
          'EXECUTE'
        ) AS ready,
        has_function_privilege(
          'r72_abuse_command',
          'app_private.runtime_database_installation_id()',
          'EXECUTE'
        ) AS installation_identity,
        has_table_privilege(
          'r72_abuse_command',
          'app_private.database_installation_identity',
          'SELECT'
        ) AS installation_identity_table,
        has_table_privilege(
          'r72_abuse_command', 'app_private.portal_abuse_buckets', 'SELECT'
        ) AS buckets,
        has_table_privilege(
          'r72_abuse_command', 'app_private.portal_abuse_leases', 'SELECT'
        ) AS leases,
        has_table_privilege(
          'r72_abuse_command', 'app_private.portal_abuse_denial_aggregates', 'SELECT'
        ) AS denials,
        (
          SELECT count(*)::integer
          FROM pg_catalog.pg_class AS relation
          JOIN pg_catalog.pg_namespace AS namespace
            ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname IN ('app', 'app_private')
            AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
            AND (
              has_table_privilege('r72_abuse_command', relation.oid, 'SELECT')
              OR has_table_privilege('r72_abuse_command', relation.oid, 'INSERT')
              OR has_table_privilege('r72_abuse_command', relation.oid, 'UPDATE')
              OR has_table_privilege('r72_abuse_command', relation.oid, 'DELETE')
              OR has_table_privilege('r72_abuse_command', relation.oid, 'TRUNCATE')
              OR has_table_privilege('r72_abuse_command', relation.oid, 'REFERENCES')
              OR has_table_privilege('r72_abuse_command', relation.oid, 'TRIGGER')
            )
        ) AS unexpected_tables,
        (
          SELECT count(*)::integer
          FROM pg_catalog.pg_proc AS procedure
          JOIN pg_catalog.pg_namespace AS namespace
            ON namespace.oid = procedure.pronamespace
          WHERE namespace.nspname IN ('app', 'app_private')
            AND procedure.oid NOT IN (
              'app_private.admit_portal_abuse(text,text[],bytea[],integer[],integer[],integer[],integer[],bytea,bytea)'::regprocedure,
              'app_private.complete_portal_abuse_lease(bytea,text)'::regprocedure,
              'app_private.portal_abuse_ready()'::regprocedure,
              'app_private.runtime_database_installation_id()'::regprocedure
            )
            AND has_function_privilege(
              'r72_abuse_command', procedure.oid, 'EXECUTE'
            )
        ) AS unexpected_functions
    `);
    assert.deepEqual(privileges, [{
      admit: true,
      complete: true,
      ready: true,
      installation_identity: true,
      installation_identity_table: false,
      buckets: false,
      leases: false,
      denials: false,
      unexpected_tables: 0,
      unexpected_functions: 0,
    }]);
    const installation = await roleQuery<{
      installation_id: string;
    } & QueryResultRow>(pool, 'r72_abuse_command',
      `SELECT app_private.runtime_database_installation_id()::text AS installation_id`);
    assert.match(
      installation[0]!.installation_id,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    await expectPostgresError(
      roleQuery(pool, 'r72_abuse_command',
        `SELECT subject_hash FROM app_private.portal_abuse_buckets LIMIT 1`),
      '42501',
    );
    await expectPostgresError(
      roleQuery(pool, 'r72_abuse_command',
        `SELECT installation_id FROM app_private.database_installation_identity`),
      '42501',
    );

    const account = randomBytes(32);
    const read = await admit(pool, 'read.page', [{
      kind: 'account', subject: account, capacity: 1,
      windowSeconds: 86_400, concurrency: 0,
    }]);
    assert.equal(read.allowed, true);

    const command = await admit(pool, 'command', [{
      kind: 'account', subject: account, capacity: 1,
      windowSeconds: 86_400, concurrency: 0,
    }]);
    assert.equal(command.allowed, false, 'global account budget must cross route classes');
    assert.equal(command.lease_hash, null);
    assert.ok(command.retry_after_seconds > 0);

    const untouchedWorkspace = randomBytes(32);
    const combined = await admit(pool, 'command', [
      {
        kind: 'workspace', subject: untouchedWorkspace, capacity: 1,
        windowSeconds: 86_400, concurrency: 0,
      },
      {
        kind: 'account', subject: account, capacity: 1,
        windowSeconds: 86_400, concurrency: 0,
      },
    ]);
    assert.equal(combined.allowed, false);

    const workspaceOnly = await admit(pool, 'command', [{
      kind: 'workspace', subject: untouchedWorkspace, capacity: 1,
      windowSeconds: 86_400, concurrency: 0,
    }]);
    assert.equal(workspaceOnly.allowed, true,
      'a denied multi-dimension request must not partially consume a fresh bucket');
  } finally {
    await pool.end();
  }
});

test('portal abuse auth capacity counts failures and leases enforce bounded concurrency', {
  skip,
}, async () => {
  const pool = await openTestDatabase();
  try {
    const auth = randomBytes(32);
    const authDimension: Dimension = {
      kind: 'auth', subject: auth, capacity: 1,
      windowSeconds: 86_400, concurrency: 1,
    };

    const successful = await admit(pool, 'auth.login', [authDimension]);
    assert.equal(successful.allowed, true);
    await complete(pool, successful.lease_hash, 'success');

    const dependencyFailure = await admit(pool, 'auth.login', [authDimension]);
    assert.equal(dependencyFailure.allowed, true);
    await complete(pool, dependencyFailure.lease_hash, 'service_error');

    const credentialFailure = await admit(pool, 'auth.login', [authDimension]);
    assert.equal(credentialFailure.allowed, true);
    await complete(pool, credentialFailure.lease_hash, 'auth_failure');

    const exhausted = await admit(pool, 'auth.login', [authDimension]);
    assert.equal(exhausted.allowed, false);
    assert.equal(exhausted.lease_hash, null);

    const source = randomBytes(32);
    const sourceDimension: Dimension = {
      kind: 'source', subject: source, capacity: 100,
      windowSeconds: 60, concurrency: 1,
    };
    const first = await admit(pool, 'read.page', [sourceDimension]);
    assert.equal(first.allowed, true);
    const concurrent = await admit(pool, 'read.page', [sourceDimension]);
    assert.equal(concurrent.allowed, false);
    assert.ok(concurrent.retry_after_seconds >= 1 && concurrent.retry_after_seconds <= 30);

    await complete(pool, first.lease_hash, 'success');
    const afterRelease = await admit(pool, 'read.page', [sourceDimension]);
    assert.equal(afterRelease.allowed, true);
    await complete(pool, afterRelease.lease_hash, 'success');
  } finally {
    await pool.end();
  }
});
