/**
 * One source of truth for every route that can create a Stripe Checkout Session.
 * Keeping this outside the HTTP app prevents a portal shortcut from bypassing
 * the same fail-closed gates used by the JSON API.
 */

import { classifyStripeKey, type StripeConfig } from './config.js';

export function paymentBlockers(cfg: StripeConfig): string[] {
  const keyMode = classifyStripeKey(cfg.secretKey);
  return [
    ...(keyMode === 'unconfigured' ? ['Stripe secret key is not configured'] : []),
    ...(keyMode === 'unknown' ? ['Stripe secret key format is not recognised'] : []),
    ...(!cfg.webhookSecret ? ['Stripe webhook secret is not configured'] : []),
    ...(keyMode === 'live' ? ['live checkout is locked until the PostgreSQL durable-job foundation is active'] : []),
    ...(cfg.production && keyMode === 'test' && cfg.sandboxAccessToken.length < 24
      ? ['public test checkout requires a private SANDBOX_ACCESS_TOKEN of at least 24 characters']
      : []),
  ];
}

export function oneOffCheckoutBlockers(cfg: StripeConfig, buildBlockers: string[] = []): string[] {
  const required = ['autopsy', 'core', 'core_bump', 'pro'];
  const missing = required.filter((key) => !cfg.priceIds[key]);
  return [
    ...paymentBlockers(cfg),
    ...(missing.length ? [`Stripe price IDs are missing for: ${missing.join(', ')}`] : []),
    ...buildBlockers,
  ];
}

export function subscriptionCheckoutBlockers(cfg: StripeConfig): string[] {
  const required = ['platform_starter', 'platform_growth', 'platform_pro'];
  const missing = required.filter((key) => !cfg.planIds[key]);
  return [
    ...paymentBlockers(cfg),
    ...(cfg.platformSubscriptionsEnabled !== true
      ? ['recurring platform subscriptions are preview-only and not accepting payment']
      : []),
    ...(cfg.platformSubscriptionsEnabled === true && missing.length
      ? [`Stripe recurring price IDs are missing for: ${missing.join(', ')}`]
      : []),
  ];
}

/**
 * Customer-facing email/list automations must follow the same live-money
 * provenance gate. Stripe test-mode addresses are arbitrary test input, not
 * verified customers, so they can never reach production messaging rails.
 */
export function customerOutboundMessagingEnabled(cfg: StripeConfig): boolean {
  return classifyStripeKey(cfg.secretKey) === 'live' && paymentBlockers(cfg).length === 0;
}

export interface RuntimeSafetyPolicy {
  publicTestSandbox: boolean;
  forceMockBuilds: boolean;
  maxConcurrentBuilds: number;
  allowDemoSeed: boolean;
}

/** Pure boot policy so the deployed sandbox boundary is regression-tested. */
export function runtimeSafetyPolicy(cfg: StripeConfig, env: NodeJS.ProcessEnv = process.env): RuntimeSafetyPolicy {
  const publicTestSandbox = Boolean(cfg.production) && classifyStripeKey(cfg.secretKey) === 'test';
  const requestedForceMock = /^(?:1|true|yes)$/i.test(env.RELAUNCH72_FORCE_MOCK_BUILDS?.trim() ?? '');
  const configuredConcurrency = Number(env.RELAUNCH72_MAX_CONCURRENT_BUILDS);
  const requestedMax = Number.isInteger(configuredConcurrency) && configuredConcurrency > 0 ? configuredConcurrency : 4;
  return {
    publicTestSandbox,
    forceMockBuilds: publicTestSandbox || requestedForceMock,
    maxConcurrentBuilds: publicTestSandbox ? Math.min(requestedMax, 2) : requestedMax,
    allowDemoSeed: !Boolean(cfg.production) && env.PORTAL_DEMO_SEED?.trim().toLowerCase() === 'true',
  };
}
