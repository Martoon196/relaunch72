import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/db/config.js';
import { buildPgOnboardingPlatform } from '../src/portal/onboarding-platform.js';

const KEY = Buffer.alloc(32, 7).toString('base64url');

function validEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const database = 'relaunch72_test?sslmode=disable';
  return {
    NODE_ENV: 'development',
    DATABASE_WEB_URL: `postgresql://r72_web:secret@localhost/${database}`,
    DATABASE_PROVISIONING_COMMAND_URL: `postgresql://r72_provisioning_command:secret@localhost/${database}`,
    DATABASE_SETUP_DELIVERY_COMMAND_URL: `postgresql://r72_setup_delivery_command:secret@localhost/${database}`,
    DATABASE_SETUP_REISSUE_COMMAND_URL: `postgresql://r72_setup_reissue_command:secret@localhost/${database}`,
    PORTAL_BASE_URL: 'http://localhost:4242',
    SETUP_DELIVERY_ACTIVE_KEY_ID: 'active-key',
    SETUP_DELIVERY_KEYS_JSON: JSON.stringify({ 'active-key': KEY }),
    ...overrides,
  };
}

interface FakePoolState {
  role: string;
  queries: string[];
  ends: number;
}

function fakePools(requiredKeyIds: string[] = []): {
  states: FakePoolState[];
  createPool(config: DatabaseConfig): Pool;
} {
  const states: FakePoolState[] = [];
  return {
    states,
    createPool(config: DatabaseConfig): Pool {
      const state: FakePoolState = { role: config.role, queries: [], ends: 0 };
      states.push(state);
      return {
        async query(sql: string) {
          state.queries.push(sql);
          return sql.includes('required_account_setup_delivery_key_ids')
            ? { rows: requiredKeyIds.map((encryption_key_id) => ({ encryption_key_id })) }
            : { rows: [{ ready: 1 }] };
        },
        async end() { state.ends += 1; },
      } as unknown as Pool;
    },
  };
}

test('native onboarding composes exact isolated identities and closes transient readiness', async () => {
  const fake = fakePools(['active-key']);
  const schemaPools: string[] = [];
  const platform = await buildPgOnboardingPlatform(validEnv(), {
    createPool: fake.createPool,
    async assertSchemaCurrent(pool) {
      const state = fake.states.find((candidate) => candidate.role === 'web');
      assert.ok(state);
      assert.equal(pool, pool);
      schemaPools.push(state.role);
    },
  });

  assert.deepEqual(fake.states.map((state) => state.role), [
    'web',
    'provisioningCommand',
    'setupDeliveryCommand',
    'setupReissueCommand',
  ]);
  assert.deepEqual(schemaPools, ['web']);
  assert.equal(fake.states[0]!.ends, 1, 'readiness-only web pool closes before return');
  assert.ok(platform.provisioning);
  assert.ok(platform.setupDelivery);

  await platform.close();
  await platform.close();
  assert.deepEqual(fake.states.map((state) => state.ends), [1, 1, 1, 1]);
});

test('native onboarding rejects generic or wrong database identities before connecting', async () => {
  const fake = fakePools();
  await assert.rejects(
    () => buildPgOnboardingPlatform({
      ...validEnv(),
      DATABASE_WEB_URL: undefined,
      DATABASE_URL: 'postgresql://database_owner:secret@localhost/relaunch72_test?sslmode=disable',
    }, { createPool: fake.createPool }),
    /requires DATABASE_WEB_URL authenticated as r72_web/,
  );
  assert.equal(fake.states.length, 0);

  await assert.rejects(
    () => buildPgOnboardingPlatform({
      ...validEnv(),
      DATABASE_SETUP_REISSUE_COMMAND_URL: 'postgresql://wrong_role:secret@localhost/relaunch72_test?sslmode=disable',
    }, { createPool: fake.createPool }),
    /r72_setup_reissue_command/,
  );
  assert.equal(fake.states.length, 0);
});

test('native onboarding closes every pool when a historical decryption key is unavailable', async () => {
  const fake = fakePools(['retired-key']);
  await assert.rejects(
    () => buildPgOnboardingPlatform(validEnv(), {
      createPool: fake.createPool,
      assertSchemaCurrent: async () => undefined,
    }),
    /key is unavailable: retired-key/,
  );
  assert.deepEqual(fake.states.map((state) => state.ends), [1, 1, 1, 1]);
});

test('native onboarding closes the transient web pool when schema readiness fails', async () => {
  const fake = fakePools();
  await assert.rejects(
    () => buildPgOnboardingPlatform(validEnv(), {
      createPool: fake.createPool,
      assertSchemaCurrent: async () => { throw new Error('schema is behind'); },
    }),
    /schema is behind/,
  );
  assert.deepEqual(fake.states.map((state) => state.role), ['web']);
  assert.deepEqual(fake.states.map((state) => state.ends), [1]);
});
