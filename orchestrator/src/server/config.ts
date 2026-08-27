/**
 * Stripe backend config — all from env (hard rule #4: secrets in env, never git).
 * Test-mode-first (hard rule #2): liveMode is derived from the key prefix, so a
 * test key (sk_test_…) can never accidentally run as live.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '../config.js'; // side-effect: loads .env into process.env before we read it
import { canonicalTotpSecret } from './admin/session.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** Checkout tiers → the env var holding that price's Stripe Price ID. */
export const TIER_PRICE_ENV: Record<string, string> = {
  autopsy: 'STRIPE_PRICE_AUTOPSY',
  core: 'STRIPE_PRICE_CORE',
  core_bump: 'STRIPE_PRICE_CORE_BUMP',
  pro: 'STRIPE_PRICE_PRO',
};

/** Recurring platform plans → the env var holding that plan's Stripe Price ID. */
export const PLAN_PRICE_ENV: Record<string, string> = {
  platform_starter: 'STRIPE_PLAN_STARTER',
  platform_growth: 'STRIPE_PLAN_GROWTH',
  platform_pro: 'STRIPE_PLAN_PRO',
};

export interface StripeConfig {
  secretKey: string;
  /** Fail-closed classification for standard and restricted Stripe keys. */
  keyMode: 'unconfigured' | 'test' | 'live' | 'unknown';
  webhookSecret: string;
  priceIds: Record<string, string>;
  /** Recurring platform plan price IDs (plan key → Stripe Price ID). */
  planIds: Record<string, string>;
  /** Explicit preview switch. False by default: recurring plans are not yet for sale. */
  platformSubscriptionsEnabled: boolean;
  /** Private code required by public production deployments that use Stripe test mode. */
  sandboxAccessToken: string;
  /** Public lead/Brevo capture is disabled unless the operator explicitly enables it. */
  publicLeadCaptureEnabled: boolean;
  publicBaseUrl: string;
  /** Network interface. Local development defaults to loopback; production binds all interfaces. */
  host: string;
  port: number;
  liveMode: boolean;
  /** True for NODE_ENV=production or a live Stripe key; activates fail-closed safety rules. */
  production?: boolean;
  dataDir: string;
  ordersFile: string;
  /** Where subscription state is journalled (parallel to ordersFile). */
  subscriptionsFile: string;
  /** Browser origins allowed to call the API (the site is a different host). */
  allowedOrigins: string[];
  /** Admin control room: password gate + cookie-signing secret. Empty = /admin disabled. */
  adminPassword: string;
  /** Optional in local development; mandatory whenever production admin access is enabled. */
  adminTotpSecret?: string;
  /** Increment to invalidate every outstanding stateless admin session immediately. */
  adminSessionEpoch?: number;
  sessionSecret: string;
}

export interface PortalAbuseRuntimeConfig {
  readonly hashSecret: string;
  readonly proxyMode: 'render' | 'direct';
}

/** Classify both standard (sk_) and restricted (rk_) Stripe secret keys. */
export function classifyStripeKey(secretKey: string): StripeConfig['keyMode'] {
  if (!secretKey) return 'unconfigured';
  if (/^(?:sk|rk)_test_/.test(secretKey)) return 'test';
  if (/^(?:sk|rk)_live_/.test(secretKey)) return 'live';
  return 'unknown';
}

/** Origins the funnel is served from — the site, not the API. Overridable via env. */
const DEFAULT_ORIGINS = [
  'https://relaunch72.com',
  'https://www.relaunch72.com',
  'https://martoon196.github.io',
  'http://localhost:8080',
  'http://localhost:4242',
];

export function loadStripeConfig(env: NodeJS.ProcessEnv = process.env): StripeConfig {
  const priceIds: Record<string, string> = {};
  for (const [tier, key] of Object.entries(TIER_PRICE_ENV)) priceIds[tier] = env[key]?.trim() ?? '';
  const planIds: Record<string, string> = {};
  for (const [plan, key] of Object.entries(PLAN_PRICE_ENV)) planIds[plan] = env[key]?.trim() ?? '';
  const secretKey = env.STRIPE_SECRET_KEY?.trim() ?? '';
  const keyMode = classifyStripeKey(secretKey);
  const liveMode = keyMode === 'live';
  const envProduction = env.NODE_ENV?.trim().toLowerCase() === 'production';
  const hardenedByKey = liveMode || keyMode === 'unknown';
  const requestedHost = env.HOST?.trim();
  const preliminaryProduction = envProduction || hardenedByKey;
  const host = requestedHost || (preliminaryProduction ? '0.0.0.0' : '127.0.0.1');
  const loopbackHost = /^(?:127(?:\.\d{1,3}){3}|::1|localhost)$/i.test(host);
  // A live payments key is production regardless of a forgotten/mistyped
  // NODE_ENV. Any non-loopback bind is hardened too, even if an operator forgot
  // NODE_ENV, so source-known development credentials never become remote auth.
  const production = preliminaryProduction || !loopbackHost;
  const publicTestSandbox = production && keyMode === 'test';
  const configuredSessionSecret = env.SESSION_SECRET?.trim() ?? '';
  if (production && (configuredSessionSecret.length < 32 || configuredSessionSecret === 'r72-dev-session-secret')) {
    throw new Error('SESSION_SECRET must be a dedicated random value of at least 32 characters in production');
  }
  const adminPassword = env.ADMIN_PASSWORD?.trim() ?? '';
  if (production && adminPassword && adminPassword.length < 16) {
    throw new Error('ADMIN_PASSWORD must be at least 16 characters when admin access is enabled in production');
  }
  const rawAdminTotpSecret = env.ADMIN_TOTP_SECRET?.trim() ?? '';
  const adminTotpSecret = canonicalTotpSecret(rawAdminTotpSecret) ?? '';
  if (rawAdminTotpSecret && !adminTotpSecret) {
    throw new Error('ADMIN_TOTP_SECRET must be a base32 secret containing 32 to 128 characters');
  }
  const rawAdminSessionEpoch = env.ADMIN_SESSION_EPOCH?.trim() ?? '';
  const adminSessionEpoch = rawAdminSessionEpoch ? Number(rawAdminSessionEpoch) : 0;
  if (!Number.isSafeInteger(adminSessionEpoch) || adminSessionEpoch < 0) {
    throw new Error('ADMIN_SESSION_EPOCH must be a non-negative integer');
  }
  if (production && adminPassword) {
    if (!adminTotpSecret) {
      throw new Error('ADMIN_TOTP_SECRET is required when admin access is enabled in production');
    }
    if (adminSessionEpoch < 1) {
      throw new Error('ADMIN_SESSION_EPOCH must be at least 1 when admin access is enabled in production');
    }
    if (adminPassword === configuredSessionSecret) {
      throw new Error('ADMIN_PASSWORD and SESSION_SECRET must be independent values');
    }
  }
  // DATA_DIR lets a Render persistent disk hold orders/intakes across redeploys.
  const dataDir = env.DATA_DIR?.trim() || path.join(REPO_ROOT, 'data');
  const extraOrigins = (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return {
    secretKey,
    keyMode,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET?.trim() ?? '',
    priceIds,
    planIds,
    platformSubscriptionsEnabled: !publicTestSandbox && env.PLATFORM_SUBSCRIPTIONS_ENABLED?.trim().toLowerCase() === 'true',
    sandboxAccessToken: env.SANDBOX_ACCESS_TOKEN?.trim() ?? '',
    publicLeadCaptureEnabled: !publicTestSandbox && env.PUBLIC_LEAD_CAPTURE_ENABLED?.trim().toLowerCase() === 'true',
    publicBaseUrl: (env.PUBLIC_BASE_URL?.trim() || 'http://localhost:8080').replace(/\/$/, ''),
    host,
    port: Number(env.PORT ?? 4242),
    liveMode,
    production,
    dataDir,
    ordersFile: path.join(dataDir, 'orders.jsonl'),
    subscriptionsFile: path.join(dataDir, 'subscriptions.jsonl'),
    allowedOrigins: [...new Set([...DEFAULT_ORIGINS, ...extraOrigins])],
    adminPassword,
    adminTotpSecret,
    adminSessionEpoch,
    // Never reuse a webhook credential as a cookie-signing key. The fixed value
    // exists only for local development; production validation above rejects it.
    sessionSecret: configuredSessionSecret || 'r72-dev-session-secret',
  };
}

/**
 * Production PostgreSQL portal traffic is reachable only through Render's
 * trusted proxy boundary. Render mode accepts one strict CF-Connecting-IP and
 * never treats appendable X-Forwarded-For as source authority. The abuse HMAC
 * key is independent from the session key so evidence cannot become an oracle.
 */
export function loadPortalAbuseRuntimeConfig(
  production: boolean,
  env: NodeJS.ProcessEnv = process.env,
): PortalAbuseRuntimeConfig {
  const hashSecret = env.PORTAL_ABUSE_HASH_SECRET?.trim()
    || (production ? '' : 'r72-development-portal-abuse-secret-v1');
  if (hashSecret.length < 32) {
    throw new Error('PORTAL_ABUSE_HASH_SECRET must contain at least 32 characters');
  }
  if (production && hashSecret === env.SESSION_SECRET?.trim()) {
    throw new Error('PORTAL_ABUSE_HASH_SECRET must be independent from SESSION_SECRET');
  }
  const rawProxyMode = env.PORTAL_PROXY_MODE?.trim().toLowerCase()
    || (production ? '' : 'direct');
  if (rawProxyMode !== 'render' && rawProxyMode !== 'direct') {
    throw new Error('PORTAL_PROXY_MODE must be render or direct');
  }
  if (production && rawProxyMode !== 'render') {
    throw new Error('PORTAL_PROXY_MODE must be render in production');
  }
  return Object.freeze({ hashSecret, proxyMode: rawProxyMode });
}

/** True once a tier has a real price id — checkout refuses tiers that don't. */
export function tierConfigured(cfg: StripeConfig, key: string): boolean {
  return Boolean(cfg.priceIds[key]);
}

/** Production must be able to deliver a valid private setup link before creating an account. */
export function portalProvisioningEnabled(
  production: boolean,
  postmarkToken: string | undefined,
  portalBaseUrl?: string,
): boolean {
  if (!production) return true;
  if (!postmarkToken?.trim() || !portalBaseUrl?.trim()) return false;
  try {
    const url = new URL(portalBaseUrl);
    // A production setup link must target one HTTPS origin, not a URL carrying
    // credentials, a path, query, or fragment that new URL() would silently keep.
    return url.protocol === 'https:'
      && Boolean(url.hostname)
      && !url.username
      && !url.password
      && (url.pathname === '/' || url.pathname === '')
      && !url.search
      && !url.hash;
  } catch {
    return false;
  }
}
