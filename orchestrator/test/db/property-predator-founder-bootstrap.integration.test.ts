import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { Pool } from 'pg';
import { discoverMigrations } from '../../src/db/migrate.js';
import {
  PROPERTY_PREDATOR_FOUNDER_BOOTSTRAP_TERMINAL_CHECKSUM,
  propertyPredatorFounderMigrationLedger,
} from '../../src/ops/property-predator-founder-bootstrap.js';
import {
  expectPostgresError,
  openTestDatabase,
  ownerQuery,
  resetIdentityTables,
  roleQuery,
  testDatabaseSkipReason,
} from './database-helper.js';

const skip = testDatabaseSkipReason();
const CHANGE_REFERENCE = 'pp-ghq-founder-bootstrap-integration';

interface BootstrapRow {
  organization_id: string;
  workspace_id: string;
  owner_user_id: string;
  setup_action_token_id: string;
  setup_expires_at: string;
  provider_connection_id: string;
  control_event_id: string;
  seed_event_id: string;
  created_now: boolean;
}

async function invoke(
  pool: Pool,
  installationId: string,
  ledger: ReadonlyArray<Readonly<{ filename: string; checksum: string }>>,
): Promise<BootstrapRow[]> {
  return ownerQuery<BootstrapRow>(
    pool,
    `SELECT organization_id, workspace_id, owner_user_id,
            setup_action_token_id, setup_expires_at,
            provider_connection_id, control_event_id, seed_event_id,
            created_now
       FROM app_private.bootstrap_property_predator_founder(
         $1, $2, $3::jsonb, $4
       )`,
    [
      CHANGE_REFERENCE,
      installationId,
      JSON.stringify(ledger),
      createHash('sha256').update('founder-integration-token', 'utf8').digest(),
    ],
  );
}

test('post-0027 schemas keep the founder bootstrap permanently retired without partial writes', {
  skip,
}, async () => {
  const pool = await openTestDatabase();
  try {
    await resetIdentityTables(pool);
    const migrations = await discoverMigrations();
    const reviewedLedger = propertyPredatorFounderMigrationLedger(migrations);
    assert.equal(reviewedLedger.length, 27);
    assert.ok(
      migrations.some((migration) => migration.version > reviewedLedger.length),
      'the retirement proof requires at least one migration after the reviewed bootstrap ledger',
    );
    assert.equal(
      reviewedLedger.at(-1)?.checksum,
      PROPERTY_PREDATOR_FOUNDER_BOOTSTRAP_TERMINAL_CHECKSUM,
    );

    const installation = await ownerQuery<{ installation_id: string }>(
      pool,
      `SELECT app_private.runtime_database_installation_id()::text AS installation_id`,
    );
    const installationId = installation[0]!.installation_id;

    // The one-time production bootstrap was reviewed for exactly migrations
    // 0001-0027. Once 0028 or any later migration exists, even that correct historical ledger must
    // fail closed instead of silently provisioning against a newer schema.
    await expectPostgresError(
      invoke(pool, installationId, reviewedLedger),
      '55000',
    );

    assert.deepEqual(await ownerQuery<{
      organizations: number;
      users: number;
      workspaces: number;
      pipelines: number;
      tokens: number;
      provisioning_receipts: number;
      founder_receipts: number;
      provider_connections: number;
      pilot_controls: number;
      pilot_seeds: number;
    }>(pool,
      `SELECT
         (SELECT count(*)::integer FROM app.organizations) AS organizations,
         (SELECT count(*)::integer FROM app.users) AS users,
         (SELECT count(*)::integer FROM app.workspaces) AS workspaces,
         (SELECT count(*)::integer FROM app.pipelines) AS pipelines,
         (SELECT count(*)::integer FROM app.identity_action_tokens) AS tokens,
         (SELECT count(*)::integer
            FROM app_private.customer_provisioning_receipts) AS provisioning_receipts,
         (SELECT count(*)::integer
            FROM app_private.property_predator_founder_bootstrap_receipts) AS founder_receipts,
         (SELECT count(*)::integer FROM app.provider_connections) AS provider_connections,
         (SELECT count(*)::integer
            FROM app.property_predator_email_pilot_control_events) AS pilot_controls,
         (SELECT count(*)::integer
            FROM app.property_predator_email_pilot_seed_events) AS pilot_seeds`,
    ), [{
      organizations: 0,
      users: 0,
      workspaces: 0,
      pipelines: 0,
      tokens: 0,
      provisioning_receipts: 0,
      founder_receipts: 0,
      provider_connections: 0,
      pilot_controls: 0,
      pilot_seeds: 0,
    }]);

    await expectPostgresError(roleQuery(
      pool,
      'r72_web',
      `SELECT * FROM app_private.bootstrap_property_predator_founder(
         $1, $2, $3::jsonb, $4
       )`,
      [
        CHANGE_REFERENCE,
        installationId,
        JSON.stringify(reviewedLedger),
        createHash('sha256').update('runtime-token').digest(),
      ],
    ), '42501');
  } finally {
    await pool.end();
  }
});
