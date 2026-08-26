import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { Pool } from 'pg';
import { discoverMigrations } from '../../src/db/migrate.js';
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
  changeReference = CHANGE_REFERENCE,
  token = 'founder-integration-token',
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
      changeReference,
      installationId,
      JSON.stringify(ledger),
      createHash('sha256').update(token, 'utf8').digest(),
    ],
  );
}

test('founder bootstrap is atomic, one-shot, idempotent and dark by construction', {
  skip,
}, async () => {
  const pool = await openTestDatabase();
  try {
    await resetIdentityTables(pool);
    const migrations = await discoverMigrations();
    const ledger = migrations.map(({ filename, checksum }) => ({ filename, checksum }));
    assert.equal(ledger.length, 27);
    const installation = await ownerQuery<{ installation_id: string }>(
      pool,
      `SELECT app_private.runtime_database_installation_id()::text AS installation_id`,
    );
    const installationId = installation[0]!.installation_id;

    const wrongLedger = ledger.map((entry, index) => index === 0
      ? { ...entry, checksum: '0'.repeat(64) }
      : entry);
    await expectPostgresError(
      invoke(pool, installationId, wrongLedger),
      '55000',
    );
    await expectPostgresError(
      invoke(pool, '99999999-9999-4999-8999-999999999999', ledger),
      '55000',
    );
    assert.deepEqual(await ownerQuery<{ tenants: number; receipts: number }>(
      pool,
      `SELECT
         (SELECT count(*)::integer FROM app.organizations) AS tenants,
         (SELECT count(*)::integer
            FROM app_private.property_predator_founder_bootstrap_receipts) AS receipts`,
    ), [{ tenants: 0, receipts: 0 }]);

    // Fail after the inner provisioning primitive has run. PostgreSQL must roll
    // the founder, workspace, pipeline and setup-token hash back with the later
    // provider insertion rather than leave a half-bootstrap behind.
    await ownerQuery(pool,
      `DROP TRIGGER IF EXISTS integration_reject_founder_provider
         ON app.provider_connections`);
    await ownerQuery(pool,
      `DROP FUNCTION IF EXISTS app_private.integration_reject_founder_provider()`);
    await ownerQuery(pool,
      `CREATE FUNCTION app_private.integration_reject_founder_provider()
       RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
       BEGIN
         RAISE EXCEPTION 'integration rollback fence' USING ERRCODE = '55000';
       END
       $function$`);
    await ownerQuery(pool,
      `CREATE TRIGGER integration_reject_founder_provider
       BEFORE INSERT ON app.provider_connections
       FOR EACH ROW EXECUTE FUNCTION app_private.integration_reject_founder_provider()`);
    try {
      await expectPostgresError(invoke(pool, installationId, ledger), '55000');
    } finally {
      await ownerQuery(pool,
        `DROP TRIGGER IF EXISTS integration_reject_founder_provider
           ON app.provider_connections`);
      await ownerQuery(pool,
        `DROP FUNCTION IF EXISTS app_private.integration_reject_founder_provider()`);
    }
    assert.deepEqual(await ownerQuery<{
      organizations: number;
      users: number;
      workspaces: number;
      pipelines: number;
      tokens: number;
      base_receipts: number;
      founder_receipts: number;
    }>(pool,
      `SELECT
         (SELECT count(*)::integer FROM app.organizations) AS organizations,
         (SELECT count(*)::integer FROM app.users) AS users,
         (SELECT count(*)::integer FROM app.workspaces) AS workspaces,
         (SELECT count(*)::integer FROM app.pipelines) AS pipelines,
         (SELECT count(*)::integer FROM app.identity_action_tokens) AS tokens,
         (SELECT count(*)::integer FROM app_private.customer_provisioning_receipts) AS base_receipts,
         (SELECT count(*)::integer FROM app_private.property_predator_founder_bootstrap_receipts) AS founder_receipts`,
    ), [{
      organizations: 0, users: 0, workspaces: 0, pipelines: 0,
      tokens: 0, base_receipts: 0, founder_receipts: 0,
    }]);

    const first = await invoke(pool, installationId, ledger);
    assert.equal(first.length, 1);
    assert.equal(first[0]!.created_now, true);
    const replay = await invoke(
      pool,
      installationId,
      ledger,
      CHANGE_REFERENCE,
      'unrelated-replay-token',
    );
    assert.deepEqual(replay, [{ ...first[0]!, created_now: false }]);

    // The setup hash is intentionally excluded for legitimate retries, while a
    // changed release authority on the same reference is an idempotency conflict.
    await expectPostgresError(
      invoke(pool, installationId, wrongLedger),
      '22023',
    );
    await expectPostgresError(
      invoke(pool, installationId, ledger, 'pp-ghq-founder-bootstrap-second'),
      '55000',
    );

    assert.deepEqual(await ownerQuery<{
      provider_id: string;
      provider_kind: string;
      environment: string;
      status: string;
      display_name: string;
      capabilities: unknown;
      provider_effects_enabled: boolean;
      email_delivery_enabled: boolean;
      emergency_paused: boolean;
      max_recipients: number;
      estimated_recipient_cost_usd_micros: number;
      run_message_cap: number;
      monthly_message_cap: number;
      run_spend_cap_usd_micros: string;
      monthly_spend_cap_usd_micros: string;
      seed_state: string;
      seed_matches_founder: boolean;
    }>(pool,
      `SELECT connection.provider_id, connection.provider_kind,
              connection.environment, connection.status,
              connection.display_name, connection.capabilities,
              control.provider_effects_enabled,
              control.email_delivery_enabled, control.emergency_paused,
              control.max_recipients,
              control.estimated_recipient_cost_usd_micros,
              control.run_message_cap, control.monthly_message_cap,
              control.run_spend_cap_usd_micros::text,
              control.monthly_spend_cap_usd_micros::text,
              seed.state AS seed_state,
              seed.email_sha256 = digest(
                convert_to('office@propertypredator.com', 'UTF8'), 'sha256'
              ) AS seed_matches_founder
       FROM app_private.property_predator_founder_bootstrap_receipts AS receipt
       JOIN app.provider_connections AS connection
         ON connection.workspace_id = receipt.workspace_id
        AND connection.id = receipt.provider_connection_id
       JOIN app.property_predator_email_pilot_control_events AS control
         ON control.workspace_id = receipt.workspace_id
        AND control.id = receipt.control_event_id
       JOIN app.property_predator_email_pilot_seed_events AS seed
         ON seed.workspace_id = receipt.workspace_id
        AND seed.id = receipt.seed_event_id`,
    ), [{
      provider_id: 'mailgun_eu', provider_kind: 'email', environment: 'live',
      status: 'active', display_name: 'Property Predator Mailgun EU',
      capabilities: ['email.events', 'email.send'],
      provider_effects_enabled: false, email_delivery_enabled: false,
      emergency_paused: true, max_recipients: 10,
      estimated_recipient_cost_usd_micros: 10000,
      run_message_cap: 10, monthly_message_cap: 100,
      run_spend_cap_usd_micros: '100000',
      monthly_spend_cap_usd_micros: '1000000',
      seed_state: 'owned', seed_matches_founder: true,
    }]);

    assert.deepEqual(await ownerQuery<{
      contacts: number;
      contact_points: number;
      endpoints: number;
      inboxes: number;
      conversations: number;
      messages: number;
      consents: number;
      suppressions: number;
      operations: number;
      deliveries: number;
    }>(pool,
      `SELECT
         (SELECT count(*)::integer FROM app.contacts) AS contacts,
         (SELECT count(*)::integer FROM app.contact_points) AS contact_points,
         (SELECT count(*)::integer FROM app.channel_endpoints) AS endpoints,
         (SELECT count(*)::integer FROM app.inboxes) AS inboxes,
         (SELECT count(*)::integer FROM app.conversations) AS conversations,
         (SELECT count(*)::integer FROM app.messages) AS messages,
         (SELECT count(*)::integer FROM app.communication_consent_events) AS consents,
         (SELECT count(*)::integer FROM app.communication_suppression_events) AS suppressions,
         (SELECT count(*)::integer FROM app.provider_operations) AS operations,
         (SELECT count(*)::integer FROM app.message_deliveries) AS deliveries`,
    ), [{
      contacts: 0, contact_points: 0, endpoints: 0, inboxes: 0,
      conversations: 0, messages: 0, consents: 0, suppressions: 0,
      operations: 0, deliveries: 0,
    }]);

    await expectPostgresError(ownerQuery(
      pool,
      `UPDATE app_private.property_predator_founder_bootstrap_receipts
          SET change_reference = change_reference
        WHERE change_reference = $1`,
      [CHANGE_REFERENCE],
    ), '42501');
    await expectPostgresError(roleQuery(
      pool,
      'r72_web',
      `SELECT * FROM app_private.bootstrap_property_predator_founder(
         $1, $2, $3::jsonb, $4
       )`,
      [
        CHANGE_REFERENCE,
        installationId,
        JSON.stringify(ledger),
        createHash('sha256').update('runtime-token').digest(),
      ],
    ), '42501');

    const rawSetupToken = 'founder-integration-token';
    const persistence = await ownerQuery<{
      stored_hash_matches: boolean;
      receipt_text: string;
    }>(pool,
      `SELECT action.token_hash = $2 AS stored_hash_matches,
              to_jsonb(receipt)::text AS receipt_text
       FROM app_private.property_predator_founder_bootstrap_receipts AS receipt
       JOIN app.identity_action_tokens AS action
         ON action.id = receipt.setup_action_token_id
       WHERE receipt.change_reference = $1`,
      [CHANGE_REFERENCE, createHash('sha256').update(rawSetupToken).digest()],
    );
    assert.equal(persistence[0]!.stored_hash_matches, true);
    assert.equal(persistence[0]!.receipt_text.includes(rawSetupToken), false);
    assert.equal(persistence[0]!.receipt_text.includes('/portal/setup?token='), false);
  } finally {
    await pool.end();
  }
});
