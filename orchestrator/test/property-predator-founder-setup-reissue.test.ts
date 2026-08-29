import assert from 'node:assert/strict';
import test from 'node:test';
import { SetupDeliveryKeyring } from '../src/portal/setup-delivery-pg-service.js';
import {
  loadPropertyPredatorFounderSetupReissueConfig,
  reissuePropertyPredatorFounderSetup,
} from '../src/ops/property-predator-founder-setup-reissue.js';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const TOKEN = Buffer.alloc(32, 7);

function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PROPERTY_PREDATOR_PILOT_WORKSPACE_ID: WORKSPACE_ID,
    PROPERTY_PREDATOR_FOUNDER_USER_ID: USER_ID,
    PROPERTY_PREDATOR_FOUNDER_SETUP_REISSUE_CHANGE_REFERENCE: 'founder-access.2026-08-29',
    PORTAL_BASE_URL: 'https://hq.propertypredator.com',
    ...overrides,
  };
}

function keyring(): SetupDeliveryKeyring {
  return new SetupDeliveryKeyring({
    activeKeyId: 'setup-v1',
    keys: { 'setup-v1': Buffer.alloc(32, 19) },
  });
}

test('founder setup reissue config pins the canonical workspace, founder and portal origin', () => {
  assert.deepEqual(loadPropertyPredatorFounderSetupReissueConfig(env()), {
    workspaceId: WORKSPACE_ID,
    founderUserId: USER_ID,
    changeReference: 'founder-access.2026-08-29',
    setupUrl: 'https://hq.propertypredator.com/portal/setup',
  });
  for (const invalid of [
    env({ PORTAL_BASE_URL: 'https://attacker.example' }),
    env({ PROPERTY_PREDATOR_FOUNDER_USER_ID: 'not-a-uuid' }),
    env({ PROPERTY_PREDATOR_FOUNDER_SETUP_REISSUE_CHANGE_REFERENCE: ' loose ' }),
  ]) assert.throws(() => loadPropertyPredatorFounderSetupReissueConfig(invalid));
});

test('founder setup reissue sends only hashes and ciphertext to the dedicated command', async () => {
  let sql = '';
  let values: readonly unknown[] = [];
  const config = loadPropertyPredatorFounderSetupReissueConfig(env());
  const handoff = await reissuePropertyPredatorFounderSetup({
    keyring: keyring(),
    setupTokenBytes: () => Buffer.from(TOKEN),
    reissueCommandPool: {
      async query(text: string, supplied?: readonly unknown[]) {
        sql = text; values = supplied ?? [];
        return { rows: [{
          setup_action_token_id: '33333333-3333-4333-8333-333333333333',
          setup_expires_at: '2026-08-30T12:00:00.000Z',
          setup_delivery_id: '44444444-4444-4444-8444-444444444444',
          setup_delivery_generation: 2,
          created_now: true,
        }], rowCount: 1 } as never;
      },
    } as never,
  }, config);
  const rawToken = TOKEN.toString('base64url');
  assert.match(sql, /app_private\.reissue_native_account_setup/u);
  assert.deepEqual(values.slice(0, 4), [
    'pp-founder-setup-reissue:founder-access.2026-08-29',
    WORKSPACE_ID,
    USER_ID,
    'Property Predator founder setup reissue founder-access.2026-08-29',
  ]);
  assert.equal(values.length, 12);
  assert.doesNotMatch(JSON.stringify(values), new RegExp(rawToken, 'u'));
  assert.doesNotMatch(JSON.stringify(values), /office@propertypredator\.com/u);
  assert.deepEqual(handoff, {
    purpose: 'property-predator-founder-setup-reissue',
    createdNow: true,
    workspaceId: WORKSPACE_ID,
    founderUserId: USER_ID,
    setupActionTokenId: '33333333-3333-4333-8333-333333333333',
    setupDeliveryId: '44444444-4444-4444-8444-444444444444',
    setupDeliveryGeneration: 2,
    setupExpiresAt: '2026-08-30T12:00:00.000Z',
    recipientEmail: 'office@propertypredator.com',
    setupUrl: `https://hq.propertypredator.com/portal/setup?token=${rawToken}`,
  });
});

test('idempotent reissue replay never exposes a newly generated stale link', async () => {
  const handoff = await reissuePropertyPredatorFounderSetup({
    keyring: keyring(),
    setupTokenBytes: () => Buffer.from(TOKEN),
    reissueCommandPool: {
      async query() {
        return { rows: [{
          setup_action_token_id: '33333333-3333-4333-8333-333333333333',
          setup_expires_at: '2026-08-30T12:00:00.000Z',
          setup_delivery_id: '44444444-4444-4444-8444-444444444444',
          setup_delivery_generation: 2,
          created_now: false,
        }], rowCount: 1 } as never;
      },
    } as never,
  }, loadPropertyPredatorFounderSetupReissueConfig(env()));
  assert.equal(handoff.createdNow, false);
  assert.equal('setupUrl' in handoff, false);
  assert.doesNotMatch(JSON.stringify(handoff), new RegExp(TOKEN.toString('base64url'), 'u'));
});

test('founder setup reissue rejects a weak token source before SQL', async () => {
  let queries = 0;
  await assert.rejects(reissuePropertyPredatorFounderSetup({
    keyring: keyring(),
    setupTokenBytes: () => Buffer.alloc(31),
    reissueCommandPool: { async query() { queries += 1; throw new Error('must not run'); } } as never,
  }, loadPropertyPredatorFounderSetupReissueConfig(env())), /exactly 32 random bytes/u);
  assert.equal(queries, 0);
});
