/**
 * One-command Stripe provisioning:  npm run stripe:setup
 *
 * Reads STRIPE_SECRET_KEY from .env, creates the four products + prices via the
 * Stripe API (idempotent), and writes the resulting Price IDs back into .env.
 * That's the whole "you just give the key" flow — no dashboard clicking.
 * TEST MODE ONLY: refuses a live key (hard rule #2).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT } from '../paths.js';
import '../config.js'; // side-effect: loads .env
import { provisionCatalog, type StripeCatalogLike } from './catalog.js';
import { makeStripe } from './stripe-client.js';
import { TIER_PRICE_ENV } from './config.js';

/** Set KEY=value in an .env file, replacing an existing line or appending. */
export function upsertEnv(envPath: string, updates: Record<string, string>): void {
  const lines = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8').split('\n') : [];
  for (const [k, v] of Object.entries(updates)) {
    const idx = lines.findIndex((l) => new RegExp(`^${k}=`).test(l));
    if (idx >= 0) lines[idx] = `${k}=${v}`;
    else lines.push(`${k}=${v}`);
  }
  fs.writeFileSync(envPath, lines.join('\n'), 'utf8');
}

async function main(): Promise<void> {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) {
    console.error('Set STRIPE_SECRET_KEY (a TEST key, sk_test_…) in .env first, then re-run `npm run stripe:setup`.');
    process.exit(1);
  }
  if (/^sk_live_/.test(key)) {
    console.error('That is a LIVE key. Use a TEST key (sk_test_…) — Relaunch72 stays in test mode until you go live.');
    process.exit(1);
  }
  const stripe = makeStripe(key) as unknown as StripeCatalogLike;
  console.log('Provisioning the Relaunch72 catalog in Stripe (test mode)…');
  const { priceIds, created, reused } = await provisionCatalog(stripe, 'usd', (m) => console.log('  ' + m));

  const updates: Record<string, string> = {};
  for (const [tier, envName] of Object.entries(TIER_PRICE_ENV)) if (priceIds[tier]) updates[envName] = priceIds[tier];
  upsertEnv(path.join(REPO_ROOT, '.env'), updates);

  console.log(`\nDone — ${created.length} created, ${reused.length} reused. Price IDs written to .env.`);
  console.log('Next:  npm run serve   →   set apiBase in site/checkout-config.js   →   test with card 4242 4242 4242 4242.');
}

// Run only when invoked directly (so importing upsertEnv in tests is side-effect free).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error('Setup failed:', (e as Error).message); process.exit(1); });
}
