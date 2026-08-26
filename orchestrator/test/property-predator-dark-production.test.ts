import assert from 'node:assert/strict';
import test from 'node:test';
import { propertyPredatorDarkProductionBlockers } from '../src/ops/property-predator-dark-production.js';

function locked(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    PORTAL_PRODUCT_PROFILE: 'property_predator_growth',
    PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED: 'false',
    PROPERTY_PREDATOR_EMAIL_DELIVERY_ENABLED: 'false',
    PROPERTY_PREDATOR_EMAIL_EMERGENCY_PAUSED: 'true',
    PUBLIC_LEAD_CAPTURE_ENABLED: 'false',
    PLATFORM_SUBSCRIPTIONS_ENABLED: 'false',
    BILLING_ENFORCED: 'false',
    PORTAL_DEMO_SEED: 'false',
    RELAUNCH72_FORCE_MOCK_BUILDS: 'true',
    PROPERTY_PREDATOR_EXTERNAL_EVENTS_ENABLED: 'false',
    PORTAL_BASE_URL: 'https://hq.propertypredator.co.uk',
    PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID: '33333333-3333-4333-8333-333333333333',
    PROPERTY_PREDATOR_MAILGUN_WEBHOOK_ENABLED: 'true',
    MAILGUN_WEBHOOK_SIGNATURE_VERIFICATION_ENABLED: 'true',
    ...overrides,
  };
}

test('dark production policy is scoped to the Property Predator production web process', () => {
  assert.deepEqual(propertyPredatorDarkProductionBlockers({}), []);
  assert.deepEqual(propertyPredatorDarkProductionBlockers({
    NODE_ENV: 'production', PORTAL_PRODUCT_PROFILE: 'relaunch72',
  }), []);
  assert.deepEqual(propertyPredatorDarkProductionBlockers(locked()), []);
});

test('dark production policy requires every irreversible rail to remain exact locked', () => {
  const unsafe = propertyPredatorDarkProductionBlockers(locked({
    PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED: 'FALSE',
    PROPERTY_PREDATOR_EMAIL_DELIVERY_ENABLED: 'true',
    PROPERTY_PREDATOR_EMAIL_EMERGENCY_PAUSED: 'false',
    PUBLIC_LEAD_CAPTURE_ENABLED: undefined,
    PLATFORM_SUBSCRIPTIONS_ENABLED: 'true',
    BILLING_ENFORCED: 'true',
    PORTAL_DEMO_SEED: 'true',
    RELAUNCH72_FORCE_MOCK_BUILDS: 'false',
    PROPERTY_PREDATOR_EXTERNAL_EVENTS_ENABLED: 'true',
    PORTAL_BASE_URL: 'https://attacker.example',
    PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID: 'not-a-uuid',
    PROPERTY_PREDATOR_MAILGUN_WEBHOOK_ENABLED: 'false',
    MAILGUN_WEBHOOK_SIGNATURE_VERIFICATION_ENABLED: 'false',
  }));
  assert.equal(unsafe.length, 13);
  assert.match(unsafe.join(' '), /Provider effects/);
  assert.match(unsafe.join(' '), /Email emergency pause/);
  assert.match(unsafe.join(' '), /Portal demo seed/);
  assert.match(unsafe.join(' '), /Canonical Growth HQ origin/);
  assert.match(unsafe.join(' '), /Database installation identity/);
});

test('public web readiness rejects every privileged credential from another process', () => {
  const secrets = {
    STRIPE_SECRET_KEY: 'secret',
    POSTMARK_SERVER_TOKEN: 'secret',
    BREVO_API_KEY: 'secret',
    ANTHROPIC_API_KEY: 'secret',
    MAILGUN_API_KEY: 'secret',
    DATABASE_URL: 'secret',
    DATABASE_MIGRATOR_URL: 'secret',
    DATABASE_IMPORT_COMMAND_URL: 'secret',
    DATABASE_MAILGUN_WORKER_URL: 'secret',
  };
  const blockers = propertyPredatorDarkProductionBlockers(locked(secrets));
  assert.equal(blockers.length, Object.keys(secrets).length);
  assert.equal(blockers.some((blocker) => blocker.includes('secret')), false);
  assert.match(blockers.join(' '), /Outbound Mailgun credential/);
  assert.match(blockers.join(' '), /Migration-owner database credential/);
});
