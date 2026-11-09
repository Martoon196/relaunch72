import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import type { Pool } from 'pg';
import { composePropertyPredatorSimulatedInbound } from '../src/integrations/simulated-inbound/composition.js';
import type { TestInboxWebhookTrustedBinding } from '../src/test-inbox-webhook-pg/types.js';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const INSTALLATION = '22222222-2222-4222-8222-222222222222';

function completeEnv(): NodeJS.ProcessEnv {
  return {
    PROPERTY_PREDATOR_SIMULATED_WHATSAPP_INBOUND_ENABLED: 'true',
    PROPERTY_PREDATOR_SIMULATED_META_DM_INBOUND_ENABLED: 'true',
    DATABASE_TEST_INBOX_WEBHOOK_URL:
      'postgresql://r72_test_inbox_webhook_command:secret@database.example/relaunch72',
    PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID: INSTALLATION,
    PROPERTY_PREDATOR_SIMULATED_INBOUND_WORKSPACE_ID: WORKSPACE,
    PROPERTY_PREDATOR_SIMULATED_WHATSAPP_SIGNING_SECRET: 'w'.repeat(40),
    PROPERTY_PREDATOR_SIMULATED_WHATSAPP_CONNECTION_ID: '33333333-3333-4333-8333-333333333333',
    PROPERTY_PREDATOR_SIMULATED_WHATSAPP_INBOX_ID: '44444444-4444-4444-8444-444444444444',
    PROPERTY_PREDATOR_SIMULATED_WHATSAPP_CONTACT_ID: '55555555-5555-4555-8555-555555555555',
    PROPERTY_PREDATOR_SIMULATED_WHATSAPP_CONTACT_POINT_ID: '66666666-6666-4666-8666-666666666666',
    PROPERTY_PREDATOR_SIMULATED_WHATSAPP_OWNED_TEST_NUMBER: '+447700900001',
    PROPERTY_PREDATOR_SIMULATED_WHATSAPP_SOURCE_TEST_NUMBER: '+447700900002',
    PROPERTY_PREDATOR_SIMULATED_META_DM_SIGNING_SECRET: 'm'.repeat(40),
    PROPERTY_PREDATOR_SIMULATED_FACEBOOK_CONNECTION_ID: '77777777-7777-4777-8777-777777777777',
    PROPERTY_PREDATOR_SIMULATED_FACEBOOK_INBOX_ID: '88888888-8888-4888-8888-888888888888',
    PROPERTY_PREDATOR_SIMULATED_FACEBOOK_CONTACT_ID: '99999999-9999-4999-8999-999999999999',
    PROPERTY_PREDATOR_SIMULATED_FACEBOOK_CONTACT_POINT_ID: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    PROPERTY_PREDATOR_SIMULATED_FACEBOOK_OWNED_TEST_ADDRESS: 'test-dm:facebook:owned',
    PROPERTY_PREDATOR_SIMULATED_FACEBOOK_SOURCE_TEST_ADDRESS: 'test-dm:facebook:source',
    PROPERTY_PREDATOR_SIMULATED_INSTAGRAM_CONNECTION_ID: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    PROPERTY_PREDATOR_SIMULATED_INSTAGRAM_INBOX_ID: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    PROPERTY_PREDATOR_SIMULATED_INSTAGRAM_CONTACT_ID: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    PROPERTY_PREDATOR_SIMULATED_INSTAGRAM_CONTACT_POINT_ID: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    PROPERTY_PREDATOR_SIMULATED_INSTAGRAM_OWNED_TEST_ADDRESS: 'test-dm:instagram:owned',
    PROPERTY_PREDATOR_SIMULATED_INSTAGRAM_SOURCE_TEST_ADDRESS: 'test-dm:instagram:source',
  };
}

function fakePool(): Readonly<{
  pool: Pick<Pool, 'query' | 'connect' | 'end'>;
  endCalls: () => number;
}> {
  let ends = 0;
  return {
    pool: {
      query: async () => { throw new Error('unexpected direct query'); },
      connect: async () => { throw new Error('unexpected connect'); },
      end: async () => { ends += 1; },
    } as unknown as Pick<Pool, 'query' | 'connect' | 'end'>,
    endCalls: () => ends,
  };
}

test('disabled composition creates no database pool and leaves both routes dark', async () => {
  let poolCreates = 0;
  const composition = await composePropertyPredatorSimulatedInbound({}, {
    createPool: () => { poolCreates += 1; return fakePool().pool; },
  });
  assert.equal(poolCreates, 0);
  assert.equal(composition.enabled, false);
  assert.equal(composition.whatsapp.enabled, false);
  assert.equal(composition.metaDm.enabled, false);
  assert.equal(composition.whatsapp.handle, undefined);
  await assert.doesNotReject(composition.assertReady());
  await composition.close();
});

test('enabled-but-incomplete composition creates no pool and exposes no handler', async () => {
  let poolCreates = 0;
  const composition = await composePropertyPredatorSimulatedInbound({
    PROPERTY_PREDATOR_SIMULATED_WHATSAPP_INBOUND_ENABLED: 'true',
  }, {
    createPool: () => { poolCreates += 1; return fakePool().pool; },
  });
  assert.equal(poolCreates, 0);
  assert.equal(composition.enabled, true);
  assert.equal(composition.ready, false);
  assert.equal(composition.whatsapp.enabled, true);
  assert.equal(composition.whatsapp.handle, undefined);
  assert.ok(composition.whatsapp.blockers.length > 0);
  await assert.rejects(composition.assertReady(), /protected runtime is unavailable/);
});

test('ready composition uses one pool, verifies three exact bindings and closes once', async () => {
  const database = fakePool();
  let poolCreates = 0;
  const checked: TestInboxWebhookTrustedBinding[] = [];
  const composition = await composePropertyPredatorSimulatedInbound(completeEnv(), {
    createPool: () => { poolCreates += 1; return database.pool; },
    assertBindingReady: async (_pool, binding, installationId) => {
      assert.equal(installationId, INSTALLATION);
      checked.push(binding);
    },
  });
  assert.equal(poolCreates, 1);
  assert.equal(composition.ready, true);
  assert.equal(composition.whatsapp.ready, true);
  assert.equal(typeof composition.whatsapp.handle, 'function');
  assert.equal(composition.metaDm.ready, true);
  assert.equal(typeof composition.metaDm.handle, 'function');
  assert.deepEqual(checked.map((binding) => binding.providerId), [
    'whatsapp_dark_simulator',
    'social_dm_dark_simulator',
    'social_dm_dark_simulator',
  ]);
  assert.equal(new Set(checked.map((binding) => binding.providerConnectionId)).size, 3);
  await composition.assertReady();
  assert.equal(checked.length, 6);
  await composition.close();
  await composition.close();
  assert.equal(database.endCalls(), 1);
  await assert.rejects(composition.assertReady(), /protected runtime is unavailable/);
});

test('failed protected readiness closes the one pool and keeps handlers unavailable', async () => {
  const database = fakePool();
  const composition = await composePropertyPredatorSimulatedInbound(completeEnv(), {
    createPool: () => database.pool,
    assertBindingReady: async () => { throw new Error('secret database detail'); },
  });
  assert.equal(database.endCalls(), 1);
  assert.equal(composition.ready, false);
  assert.equal(composition.whatsapp.handle, undefined);
  assert.equal(composition.metaDm.handle, undefined);
  assert.deepEqual(composition.whatsapp.blockers, [
    'Simulated inbound protected runtime did not pass readiness',
  ]);
  assert.doesNotMatch(JSON.stringify(composition), /secret database detail/u);
});

test('composition source has no provider SDK, outbound network or effect registry', () => {
  const source = [
    'config.ts', 'composition.ts', 'repository-command-service.ts', 'router.ts',
  ].map((file) => fs.readFileSync(
    new URL(`../src/integrations/simulated-inbound/${file}`, import.meta.url),
    'utf8',
  )).join('\n');
  assert.doesNotMatch(source, /\bfetch\s*\(/u);
  assert.doesNotMatch(source, /node:(?:https|http2|net|tls|dns)/u);
  assert.doesNotMatch(source, /(?:twilio|whatsapp-web\.js|facebook-nodejs-business-sdk)/iu);
  assert.doesNotMatch(source, /(?:provider-registry|live-provider|provider-effects)/iu);
});
