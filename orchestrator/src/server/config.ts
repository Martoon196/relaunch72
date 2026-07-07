/**
 * Stripe backend config — all from env (hard rule #4: secrets in env, never git).
 * Test-mode-first (hard rule #2): liveMode is derived from the key prefix, so a
 * test key (sk_test_…) can never accidentally run as live.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '../config.js'; // side-effect: loads .env into process.env before we read it

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** Checkout tiers → the env var holding that price's Stripe Price ID. */
export const TIER_PRICE_ENV: Record<string, string> = {
  autopsy: 'STRIPE_PRICE_AUTOPSY',
  core: 'STRIPE_PRICE_CORE',
  core_bump: 'STRIPE_PRICE_CORE_BUMP',
  pro: 'STRIPE_PRICE_PRO',
};

export interface StripeConfig {
  secretKey: string;
  webhookSecret: string;
  priceIds: Record<string, string>;
  publicBaseUrl: string;
  port: number;
  liveMode: boolean;
  ordersFile: string;
}

export function loadStripeConfig(env: NodeJS.ProcessEnv = process.env): StripeConfig {
  const priceIds: Record<string, string> = {};
  for (const [tier, key] of Object.entries(TIER_PRICE_ENV)) priceIds[tier] = env[key]?.trim() ?? '';
  const secretKey = env.STRIPE_SECRET_KEY?.trim() ?? '';
  return {
    secretKey,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET?.trim() ?? '',
    priceIds,
    publicBaseUrl: (env.PUBLIC_BASE_URL?.trim() || 'http://localhost:8080').replace(/\/$/, ''),
    port: Number(env.PORT ?? 4242),
    liveMode: /^sk_live_/.test(secretKey),
    ordersFile: path.join(REPO_ROOT, 'data', 'orders.jsonl'),
  };
}

/** True once a tier has a real price id — checkout refuses tiers that don't. */
export function tierConfigured(cfg: StripeConfig, key: string): boolean {
  return Boolean(cfg.priceIds[key]);
}
