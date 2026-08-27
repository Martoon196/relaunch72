import assert from 'node:assert/strict';
import test from 'node:test';
import { loadPropertyPredatorSimulatedInboundConfig } from '../src/integrations/simulated-inbound/config.js';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const WA_CONNECTION = '22222222-2222-4222-8222-222222222222';
const FB_CONNECTION = '33333333-3333-4333-8333-333333333333';
const IG_CONNECTION = '44444444-4444-4444-8444-444444444444';
const INSTALLATION = '55555555-5555-4555-8555-555555555555';

function completeEnv(): NodeJS.ProcessEnv {
  return {
    PROPERTY_PREDATOR_SIMULATED_WHATSAPP_INBOUND_ENABLED: 'true',
    PROPERTY_PREDATOR_SIMULATED_META_DM_INBOUND_ENABLED: 'true',
    DATABASE_TEST_INBOX_WEBHOOK_URL:
      'postgresql://r72_test_inbox_webhook_command:secret@database.example/relaunch72',
    PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID: INSTALLATION,
    PROPERTY_PREDATOR_SIMULATED_INBOUND_WORKSPACE_ID: WORKSPACE,
    PROPERTY_PREDATOR_SIMULATED_WHATSAPP_SIGNING_SECRET: 'w'.repeat(40),
    PROPERTY_PREDATOR_SIMULATED_WHATSAPP_CONNECTION_ID: WA_CONNECTION,
    PROPERTY_PREDATOR_SIMULATED_WHATSAPP_INBOX_ID: '66666666-6666-4666-8666-666666666666',
    PROPERTY_PREDATOR_SIMULATED_WHATSAPP_CONTACT_ID: '77777777-7777-4777-8777-777777777777',
    PROPERTY_PREDATOR_SIMULATED_WHATSAPP_CONTACT_POINT_ID: '88888888-8888-4888-8888-888888888888',
    PROPERTY_PREDATOR_SIMULATED_WHATSAPP_OWNED_TEST_NUMBER: '+447700900001',
    PROPERTY_PREDATOR_SIMULATED_WHATSAPP_SOURCE_TEST_NUMBER: '+447700900002',
    PROPERTY_PREDATOR_SIMULATED_META_DM_SIGNING_SECRET: 'm'.repeat(40),
    PROPERTY_PREDATOR_SIMULATED_FACEBOOK_CONNECTION_ID: FB_CONNECTION,
    PROPERTY_PREDATOR_SIMULATED_FACEBOOK_INBOX_ID: '99999999-9999-4999-8999-999999999999',
    PROPERTY_PREDATOR_SIMULATED_FACEBOOK_CONTACT_ID: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    PROPERTY_PREDATOR_SIMULATED_FACEBOOK_CONTACT_POINT_ID: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    PROPERTY_PREDATOR_SIMULATED_FACEBOOK_OWNED_TEST_ADDRESS:
      'test-dm:facebook:property-predator-owned',
    PROPERTY_PREDATOR_SIMULATED_FACEBOOK_SOURCE_TEST_ADDRESS:
      'test-dm:facebook:fictional-source',
    PROPERTY_PREDATOR_SIMULATED_INSTAGRAM_CONNECTION_ID: IG_CONNECTION,
    PROPERTY_PREDATOR_SIMULATED_INSTAGRAM_INBOX_ID: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    PROPERTY_PREDATOR_SIMULATED_INSTAGRAM_CONTACT_ID: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    PROPERTY_PREDATOR_SIMULATED_INSTAGRAM_CONTACT_POINT_ID: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    PROPERTY_PREDATOR_SIMULATED_INSTAGRAM_OWNED_TEST_ADDRESS:
      'test-dm:instagram:property-predator-owned',
    PROPERTY_PREDATOR_SIMULATED_INSTAGRAM_SOURCE_TEST_ADDRESS:
      'test-dm:instagram:fictional-source',
  };
}

test('simulated inbound is fully dark by default and ignores dormant values', () => {
  const config = loadPropertyPredatorSimulatedInboundConfig({
    PROPERTY_PREDATOR_SIMULATED_WHATSAPP_SIGNING_SECRET: 'must-not-be-read',
    PROPERTY_PREDATOR_SIMULATED_WHATSAPP_OWNED_TEST_NUMBER: '+447911123456',
  });
  assert.equal(config.enabled, false);
  assert.equal(config.configurationReady, true);
  assert.deepEqual(config.blockers, []);
  assert.deepEqual(config.whatsapp, { enabled: false, testSecret: null, binding: null });
  assert.deepEqual(config.metaDm, { enabled: false, testSecret: null, bindings: null });
});

test('exact true is required and malformed opt-in remains visibly blocked', () => {
  const config = loadPropertyPredatorSimulatedInboundConfig({
    PROPERTY_PREDATOR_SIMULATED_WHATSAPP_INBOUND_ENABLED: 'TRUE',
  });
  assert.equal(config.enabled, true);
  assert.equal(config.whatsapp.enabled, true);
  assert.equal(config.configurationReady, false);
  assert.ok(config.blockers.includes('Simulated inbound enablement must be exact'));
  assert.equal(config.whatsapp.binding, null);
});

test('complete TEST-only bindings retain exact values without exposing them as blockers', () => {
  const env = completeEnv();
  const config = loadPropertyPredatorSimulatedInboundConfig(env);
  assert.equal(config.configurationReady, true);
  assert.deepEqual(config.blockers, []);
  assert.equal(config.installationId, INSTALLATION);
  assert.equal(config.whatsapp.binding?.connectionId, WA_CONNECTION);
  assert.equal(config.whatsapp.binding?.ownedTestNumber, '+447700900001');
  assert.equal(config.metaDm.bindings?.facebook.connectionId, FB_CONNECTION);
  assert.equal(config.metaDm.bindings?.instagram.connectionId, IG_CONNECTION);
  assert.equal(config.whatsapp.testSecret, env.PROPERTY_PREDATOR_SIMULATED_WHATSAPP_SIGNING_SECRET);
  assert.equal(config.metaDm.testSecret, env.PROPERTY_PREDATOR_SIMULATED_META_DM_SIGNING_SECRET);
  assert.ok(Object.isFrozen(config));
});

test('one exact WhatsApp rail does not require dormant Meta DM configuration', () => {
  const env = completeEnv();
  env.PROPERTY_PREDATOR_SIMULATED_META_DM_INBOUND_ENABLED = 'false';
  for (const key of Object.keys(env)) {
    if (key.includes('FACEBOOK') || key.includes('INSTAGRAM') || key.includes('META_DM')) {
      delete env[key];
    }
  }
  const config = loadPropertyPredatorSimulatedInboundConfig(env);
  assert.equal(config.configurationReady, true);
  assert.equal(config.whatsapp.enabled, true);
  assert.equal(config.metaDm.enabled, false);
});

test('routable/cross-network addresses, shared connections and weak secrets fail safely', () => {
  const env = completeEnv();
  env.PROPERTY_PREDATOR_SIMULATED_WHATSAPP_SOURCE_TEST_NUMBER = '+447911123456';
  env.PROPERTY_PREDATOR_SIMULATED_FACEBOOK_SOURCE_TEST_ADDRESS =
    'test-dm:instagram:wrong-network';
  env.PROPERTY_PREDATOR_SIMULATED_INSTAGRAM_CONNECTION_ID = FB_CONNECTION;
  env.PROPERTY_PREDATOR_SIMULATED_WHATSAPP_SIGNING_SECRET = 'short';
  const config = loadPropertyPredatorSimulatedInboundConfig(env);
  assert.equal(config.configurationReady, false);
  assert.equal(config.whatsapp.binding, null);
  assert.equal(config.metaDm.bindings, null);
  const rendered = JSON.stringify(config.blockers);
  assert.doesNotMatch(rendered, /447911|wrong-network|33333333|short/u);
  assert.doesNotMatch(rendered, /DATABASE_|PROPERTY_PREDATOR_/u);
});

test('simulator signing secrets must be independent from each other and session auth', () => {
  const env = completeEnv();
  env.PROPERTY_PREDATOR_SIMULATED_META_DM_SIGNING_SECRET =
    env.PROPERTY_PREDATOR_SIMULATED_WHATSAPP_SIGNING_SECRET;
  env.SESSION_SECRET = env.PROPERTY_PREDATOR_SIMULATED_WHATSAPP_SIGNING_SECRET;
  const config = loadPropertyPredatorSimulatedInboundConfig(env);
  assert.equal(config.configurationReady, false);
  assert.deepEqual(
    config.blockers.filter((value) => value.includes('not isolated')),
    ['Simulated inbound signing secrets are not isolated'],
  );
});
