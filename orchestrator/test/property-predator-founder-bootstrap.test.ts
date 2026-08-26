import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { Pool, PoolClient, QueryResult } from 'pg';
import { discoverMigrations } from '../src/db/migrate.js';
import {
  bootstrapPropertyPredatorFounder,
  loadPropertyPredatorFounderBootstrapConfig,
  propertyPredatorFounderMigrationLedger,
} from '../src/ops/property-predator-founder-bootstrap.js';

const IDS = {
  installation: 'a1111111-1111-4111-8111-111111111111',
  organization: '22222222-2222-4222-8222-222222222222',
  workspace: '33333333-3333-4333-8333-333333333333',
  owner: '44444444-4444-4444-8444-444444444444',
  token: '55555555-5555-4555-8555-555555555555',
  connection: '66666666-6666-4666-8666-666666666666',
  control: '77777777-7777-4777-8777-777777777777',
  seed: '88888888-8888-4888-8888-888888888888',
};

interface FakeClient extends Pick<PoolClient, 'query' | 'release'> {
  releasedWith: boolean | Error | undefined;
}

function result(rows: unknown[]): QueryResult {
  return {
    rows,
    rowCount: rows.length,
    command: 'SELECT',
    oid: 0,
    fields: [],
  } as QueryResult;
}

async function bootstrapFixture(createdNow: boolean): Promise<{
  handoff: Awaited<ReturnType<typeof bootstrapPropertyPredatorFounder>>;
  rawToken: string;
  sqlTokenHash: Buffer;
  bootstrapValues: unknown[];
}> {
  const migrations = await discoverMigrations();
  const ledgerRows = migrations.map(({ filename, checksum }) => ({ filename, checksum }));
  const setupBytes = Buffer.alloc(32, 0xa5);
  const rawToken = setupBytes.toString('base64url');
  let sqlTokenHash = Buffer.alloc(0);
  let bootstrapValues: unknown[] = [];
  let connectionNumber = 0;
  const clients: FakeClient[] = [];
  const pool = {
    connect: async () => {
      connectionNumber += 1;
      const readinessConnection = connectionNumber === 1;
      const client: FakeClient = {
        releasedWith: undefined,
        query: (async (sql: string, values?: unknown[]) => {
          if (readinessConnection && sql.includes("to_regclass('app_private.schema_migrations')")) {
            return result([{ ledger: 'app_private.schema_migrations' }]);
          }
          if (readinessConnection && sql.includes('SELECT filename, checksum')) {
            return result(ledgerRows);
          }
          if (sql.includes('bootstrap_property_predator_founder')) {
            bootstrapValues = values ? [...values] : [];
            sqlTokenHash = Buffer.from(bootstrapValues[3] as Buffer);
            return result([{
              organization_id: IDS.organization,
              workspace_id: IDS.workspace,
              owner_user_id: IDS.owner,
              setup_action_token_id: IDS.token,
              setup_expires_at: '2030-01-02T03:04:05.000Z',
              provider_connection_id: IDS.connection,
              control_event_id: IDS.control,
              seed_event_id: IDS.seed,
              created_now: createdNow,
            }]);
          }
          return result([]);
        }) as PoolClient['query'],
        release(error?: boolean | Error) {
          this.releasedWith = error;
        },
      };
      clients.push(client);
      return client as unknown as PoolClient;
    },
  } as Pick<Pool, 'connect'>;

  const handoff = await bootstrapPropertyPredatorFounder({
    pool,
    setupTokenBytes: () => setupBytes,
  }, {
    changeReference: 'pp-ghq-founder-bootstrap-20260826',
    expectedInstallationId: IDS.installation,
  });
  assert.equal(clients.length, 2);
  assert.equal(clients.every((client) => client.releasedWith !== true), true);
  return { handoff, rawToken, sqlTokenHash, bootstrapValues };
}

test('founder bootstrap sends only a setup-token hash to SQL and returns one memory handoff', async () => {
  const fixture = await bootstrapFixture(true);
  assert.deepEqual(
    fixture.sqlTokenHash,
    createHash('sha256').update(fixture.rawToken, 'ascii').digest(),
  );
  assert.equal(fixture.bootstrapValues.some((value) => value === fixture.rawToken), false);
  assert.equal(fixture.bootstrapValues[0], 'pp-ghq-founder-bootstrap-20260826');
  assert.equal(fixture.bootstrapValues[1], IDS.installation);
  assert.equal(fixture.handoff.createdNow, true);
  assert.equal(fixture.handoff.setup.status, 'created');
  assert.equal(
    fixture.handoff.setup.url,
    `https://hq.propertypredator.com/portal/setup?token=${fixture.rawToken}`,
  );
  assert.deepEqual(fixture.handoff.render, {
    PROPERTY_PREDATOR_PILOT_WORKSPACE_ID: IDS.workspace,
    PROPERTY_PREDATOR_MAILGUN_CONNECTION_ID: IDS.connection,
    PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID: IDS.installation,
    PROPERTY_PREDATOR_EMAIL_INTERNAL_SEEDS: 'office@propertypredator.com',
  });
});

test('idempotent replay never claims its unrelated fresh setup token is usable', async () => {
  const fixture = await bootstrapFixture(false);
  assert.equal(fixture.handoff.createdNow, false);
  assert.deepEqual(fixture.handoff.setup, {
    status: 'unavailable-on-idempotent-replay',
  });
  assert.equal('url' in fixture.handoff.setup, false);
  assert.equal(JSON.stringify(fixture.handoff).includes(fixture.rawToken), false);
});

test('founder bootstrap config and local release ledger are exact', async () => {
  assert.deepEqual(loadPropertyPredatorFounderBootstrapConfig({
    PROPERTY_PREDATOR_FOUNDER_BOOTSTRAP_CHANGE_REFERENCE:
      'pp-ghq-founder-bootstrap-20260826',
    PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID: IDS.installation,
  }), {
    changeReference: 'pp-ghq-founder-bootstrap-20260826',
    expectedInstallationId: IDS.installation,
  });
  for (const env of [
    {
      PROPERTY_PREDATOR_FOUNDER_BOOTSTRAP_CHANGE_REFERENCE: ' PP-GHQ-BOOTSTRAP ',
      PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID: IDS.installation,
    },
    {
      PROPERTY_PREDATOR_FOUNDER_BOOTSTRAP_CHANGE_REFERENCE:
        'pp-ghq-founder-bootstrap-20260826',
      PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID: IDS.installation.toUpperCase(),
    },
  ]) {
    assert.throws(() => loadPropertyPredatorFounderBootstrapConfig(env), /must be/);
  }

  const migrations = await discoverMigrations();
  assert.equal(propertyPredatorFounderMigrationLedger(migrations).length, 27);
  assert.throws(
    () => propertyPredatorFounderMigrationLedger(migrations.slice(0, -1)),
    /exact reviewed migration ledger/,
  );
});
