import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadStripeConfig, portalProvisioningEnabled } from '../src/server/config.js';
import { customerOutboundMessagingEnabled, runtimeSafetyPolicy } from '../src/server/readiness.js';

test('production refuses a missing, default or short SESSION_SECRET', () => {
  const production = { NODE_ENV: 'production' } as NodeJS.ProcessEnv;
  assert.throws(() => loadStripeConfig(production), /SESSION_SECRET/);
  assert.throws(() => loadStripeConfig({ ...production, STRIPE_WEBHOOK_SECRET: 'whsec_cannot_be_reused_as_a_cookie_key' }), /SESSION_SECRET/);
  assert.throws(() => loadStripeConfig({ ...production, SESSION_SECRET: 'too-short' }), /SESSION_SECRET/);
  assert.throws(() => loadStripeConfig({ ...production, SESSION_SECRET: 'r72-dev-session-secret' }), /SESSION_SECRET/);
});

test('production accepts a dedicated long SESSION_SECRET and development retains a local-only default', () => {
  const dedicated = 'correct-horse-battery-staple-cookie-key';
  const prod = loadStripeConfig({ NODE_ENV: 'production', SESSION_SECRET: dedicated } as NodeJS.ProcessEnv);
  assert.equal(prod.production, true);
  assert.equal(prod.sessionSecret, dedicated);

  const dev = loadStripeConfig({ STRIPE_WEBHOOK_SECRET: 'whsec_not_a_session_secret' } as NodeJS.ProcessEnv);
  assert.equal(dev.production, false);
  assert.equal(dev.sessionSecret, 'r72-dev-session-secret');
  assert.equal(dev.host, '127.0.0.1');
});

test('a non-loopback bind is hardened even when NODE_ENV was forgotten', () => {
  assert.throws(() => loadStripeConfig({ HOST: '0.0.0.0', STRIPE_SECRET_KEY: 'sk_test_x' } as NodeJS.ProcessEnv), /SESSION_SECRET/);
  const remote = loadStripeConfig({
    HOST: '0.0.0.0',
    STRIPE_SECRET_KEY: 'sk_test_x',
    SESSION_SECRET: 'dedicated-remote-cookie-signing-key',
  } as NodeJS.ProcessEnv);
  assert.equal(remote.production, true);
  assert.equal(remote.host, '0.0.0.0');
});

test('enabled production admin access requires a strong password', () => {
  const base = { NODE_ENV: 'production', SESSION_SECRET: 'dedicated-production-session-secret' } as NodeJS.ProcessEnv;
  assert.throws(() => loadStripeConfig({ ...base, ADMIN_PASSWORD: 'weak-password' }), /ADMIN_PASSWORD/);
  assert.equal(loadStripeConfig({ ...base, ADMIN_PASSWORD: 'long-random-admin-password' }).adminPassword, 'long-random-admin-password');
});

test('a live Stripe key activates production auth safety even when NODE_ENV is development', () => {
  assert.throws(
    () => loadStripeConfig({ NODE_ENV: 'development', STRIPE_SECRET_KEY: 'sk_live_x' } as NodeJS.ProcessEnv),
    /SESSION_SECRET/,
  );
  const cfg = loadStripeConfig({
    NODE_ENV: 'development',
    STRIPE_SECRET_KEY: 'sk_live_x',
    SESSION_SECRET: 'dedicated-live-cookie-signing-secret',
  } as NodeJS.ProcessEnv);
  assert.equal(cfg.liveMode, true);
  assert.equal(cfg.keyMode, 'live');
  assert.equal(cfg.production, true);

  const restricted = loadStripeConfig({
    STRIPE_SECRET_KEY: 'rk_live_restricted',
    SESSION_SECRET: 'dedicated-restricted-live-cookie-key',
  } as NodeJS.ProcessEnv);
  assert.equal(restricted.keyMode, 'live');
  assert.equal(restricted.liveMode, true);
  assert.equal(restricted.production, true);
});

test('unknown nonempty Stripe key formats fail into hardened unknown mode', () => {
  assert.throws(() => loadStripeConfig({ STRIPE_SECRET_KEY: 'money_key_new_format' } as NodeJS.ProcessEnv), /SESSION_SECRET/);
  const unknown = loadStripeConfig({
    STRIPE_SECRET_KEY: 'money_key_new_format',
    SESSION_SECRET: 'dedicated-unknown-key-cookie-secret',
  } as NodeJS.ProcessEnv);
  assert.equal(unknown.keyMode, 'unknown');
  assert.equal(unknown.production, true);
  assert.equal(unknown.liveMode, false);
});

test('production portal provisioning fails closed when setup email cannot be delivered', () => {
  assert.equal(portalProvisioningEnabled(true, undefined, 'https://portal.test'), false);
  assert.equal(portalProvisioningEnabled(true, '  ', 'https://portal.test'), false);
  assert.equal(portalProvisioningEnabled(true, 'postmark-token'), false, 'a mail token cannot rescue a missing portal origin');
  assert.equal(portalProvisioningEnabled(true, 'postmark-token', 'not-a-url'), false);
  assert.equal(portalProvisioningEnabled(true, 'postmark-token', 'http://portal.test'), false, 'production setup links require HTTPS');
  assert.equal(portalProvisioningEnabled(true, 'postmark-token', 'https://portal.test/unexpected-path'), false);
  assert.equal(portalProvisioningEnabled(true, 'postmark-token', 'https://portal.test'), true);
  assert.equal(portalProvisioningEnabled(false, undefined), true, 'local development keeps the mock-first path');
});

test('recurring platform checkout requires an exact explicit opt-in', () => {
  assert.equal(loadStripeConfig({ PLATFORM_SUBSCRIPTIONS_ENABLED: 'false' } as NodeJS.ProcessEnv).platformSubscriptionsEnabled, false);
  assert.equal(loadStripeConfig({ PLATFORM_SUBSCRIPTIONS_ENABLED: 'true' } as NodeJS.ProcessEnv).platformSubscriptionsEnabled, true);
  assert.equal(loadStripeConfig({ PLATFORM_SUBSCRIPTIONS_ENABLED: 'yes' } as NodeJS.ProcessEnv).platformSubscriptionsEnabled, false);
  assert.equal(loadStripeConfig({ PLATFORM_SUBSCRIPTIONS_ENABLED: 'anything-else' } as NodeJS.ProcessEnv).platformSubscriptionsEnabled, false);
});

test('private scorecard shows results without collecting or pretending to email a lead', () => {
  const source = readFileSync(new URL('../../site/scorecard/test/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /api\/subscribe|type=["']email["']|r72_scorecard_lead|send a copy/i);
  assert.match(source, /i<Q\.length\?renderQ\(\):renderResult\(\)/);
});

test('private checkout persistently says a test transaction creates mock output only', () => {
  const source = readFileSync(new URL('../../site/checkout.html', import.meta.url), 'utf8');
  assert.match(source, /Test transaction → mock output only/i);
  assert.match(source, /does not start a live delivery clock, include human sign-off, or create a customer fulfilment obligation/i);
  assert.doesNotMatch(source, /Request my verified \$900 link|send a separate \$900 Core link/i);
});

test('customer outbound messaging stays locked for test, unknown and current live payment modes', () => {
  const dedicated = 'dedicated-production-session-secret-value';
  assert.equal(customerOutboundMessagingEnabled(loadStripeConfig({ STRIPE_SECRET_KEY: 'sk_test_x' } as NodeJS.ProcessEnv)), false);
  assert.equal(customerOutboundMessagingEnabled(loadStripeConfig({ STRIPE_SECRET_KEY: 'future_key', SESSION_SECRET: dedicated } as NodeJS.ProcessEnv)), false);
  assert.equal(customerOutboundMessagingEnabled(loadStripeConfig({ STRIPE_SECRET_KEY: 'sk_live_x', SESSION_SECRET: dedicated } as NodeJS.ProcessEnv)), false);
});

test('a remotely hosted Stripe test sandbox forces mock-only bounded execution and disables growth side effects', () => {
  const cfg = loadStripeConfig({
    NODE_ENV: 'production',
    STRIPE_SECRET_KEY: 'sk_test_x',
    SESSION_SECRET: 'dedicated-production-session-secret-value',
    PLATFORM_SUBSCRIPTIONS_ENABLED: 'true',
    PUBLIC_LEAD_CAPTURE_ENABLED: 'true',
  } as NodeJS.ProcessEnv);
  const policy = runtimeSafetyPolicy(cfg, {
    RELAUNCH72_FORCE_MOCK_BUILDS: 'false',
    RELAUNCH72_MAX_CONCURRENT_BUILDS: '99',
    PORTAL_DEMO_SEED: 'true',
  } as NodeJS.ProcessEnv);
  assert.deepEqual(policy, {
    publicTestSandbox: true,
    forceMockBuilds: true,
    maxConcurrentBuilds: 2,
    allowDemoSeed: false,
  });
  assert.equal(cfg.platformSubscriptionsEnabled, false);
  assert.equal(cfg.publicLeadCaptureEnabled, false);
});
