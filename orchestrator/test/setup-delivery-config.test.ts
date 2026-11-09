import assert from 'node:assert/strict';
import test from 'node:test';
import { loadSetupDeliveryRuntimeConfig } from '../src/portal/setup-delivery-config.js';

const KEY_ONE = Buffer.alloc(32, 1).toString('base64url');
const KEY_TWO = Buffer.alloc(32, 2).toString('base64url');

function validEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    PORTAL_BASE_URL: 'https://portal.relaunch72.test',
    SETUP_DELIVERY_ACTIVE_KEY_ID: 'setup-2026-08',
    SETUP_DELIVERY_KEYS_JSON: JSON.stringify({
      'setup-2026-07': KEY_ONE,
      'setup-2026-08': KEY_TWO,
    }),
    ...overrides,
  };
}

test('setup delivery config retains active and retired keys without exposing their values', () => {
  const config = loadSetupDeliveryRuntimeConfig(validEnv());
  assert.equal(config.portalOrigin, 'https://portal.relaunch72.test');
  assert.equal(config.setupUrl, 'https://portal.relaunch72.test/portal/setup');
  assert.equal(config.keyring.activeKeyId, 'setup-2026-08');
  assert.equal(config.keyring.has('setup-2026-07'), true);
  assert.equal(config.keyring.has('setup-2026-08'), true);
});

test('setup delivery keys are required, strictly shaped and canonical', () => {
  assert.throws(
    () => loadSetupDeliveryRuntimeConfig(validEnv({ SETUP_DELIVERY_ACTIVE_KEY_ID: undefined })),
    /SETUP_DELIVERY_ACTIVE_KEY_ID/,
  );
  assert.throws(
    () => loadSetupDeliveryRuntimeConfig(validEnv({ SETUP_DELIVERY_ACTIVE_KEY_ID: ' setup-2026-08 ' })),
    /trimmed key id/,
  );
  assert.throws(
    () => loadSetupDeliveryRuntimeConfig(validEnv({ SETUP_DELIVERY_KEYS_JSON: 'not-json-super-secret' })),
    (error: unknown) => error instanceof Error
      && /must be valid JSON/.test(error.message)
      && !error.message.includes('super-secret'),
  );
  assert.throws(
    () => loadSetupDeliveryRuntimeConfig(validEnv({ SETUP_DELIVERY_KEYS_JSON: '[]' })),
    /must be a JSON object/,
  );
  assert.throws(
    () => loadSetupDeliveryRuntimeConfig(validEnv({
      SETUP_DELIVERY_KEYS_JSON: JSON.stringify({ 'setup-2026-08': `${KEY_TWO}=` }),
    })),
    /canonical 32-byte base64url/,
  );
  assert.throws(
    () => loadSetupDeliveryRuntimeConfig(validEnv({
      SETUP_DELIVERY_ACTIVE_KEY_ID: 'missing-key',
    })),
    /is not present/,
  );
});

test('setup delivery origin requires HTTPS except explicit loopback development', () => {
  const local = loadSetupDeliveryRuntimeConfig(validEnv({
    NODE_ENV: 'development',
    PORTAL_BASE_URL: 'http://127.0.0.1:4242',
  }));
  assert.equal(local.setupUrl, 'http://127.0.0.1:4242/portal/setup');

  for (const env of [
    validEnv({ NODE_ENV: 'development', PORTAL_BASE_URL: 'http://portal.test' }),
    validEnv({ PORTAL_BASE_URL: 'http://127.0.0.1:4242' }),
    validEnv({ PORTAL_BASE_URL: 'https://user:password@portal.test' }),
    validEnv({ PORTAL_BASE_URL: 'https://portal.test/other' }),
    validEnv({ PORTAL_BASE_URL: 'https://portal.test?next=elsewhere' }),
    validEnv({ PORTAL_BASE_URL: 'https://portal.test#fragment' }),
  ]) {
    assert.throws(() => loadSetupDeliveryRuntimeConfig(env), /PORTAL_BASE_URL/);
  }
});
