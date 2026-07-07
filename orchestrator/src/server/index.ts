/**
 * Boot the Stripe backend. The ONLY module that imports the real `stripe` SDK
 * and touches the filesystem/process — everything else is injected + tested.
 *
 *   npm run serve            # needs STRIPE_SECRET_KEY (test key) in .env
 *
 * On an accepted intake it spawns the pipeline detached (`tsx cli.ts --input …`),
 * so the HTTP response returns immediately while the 72-hour build runs.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Intake } from '../types.js';
import { loadStripeConfig } from './config.js';
import { fileOrderStore } from './orders.js';
import { createApp, type MarketingHooks } from './app.js';
import { makeStripe } from './stripe-client.js';
import type { StripeLike } from './stripe.js';
import { ensureCatalogPrices, type StripeCatalogLike } from './catalog.js';
import type { StripeConfig } from './config.js';
import { makeBrevo } from '../email/brevo.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ORCH_ROOT = path.resolve(HERE, '../..');
const CLI = path.join(ORCH_ROOT, 'src', 'cli.ts');

/** Persist the accepted intake under `dataDir` and spawn the build detached. */
function createKick(intakeDir: string) {
  return function kickPipeline(intake: Intake, sessionId: string | null): string {
    fs.mkdirSync(intakeDir, { recursive: true });
    const ref = `${sessionId ?? 'intake'}-${Date.now()}`;
    const file = path.join(intakeDir, `${ref}.json`);
    fs.writeFileSync(file, JSON.stringify(intake, null, 2), 'utf8');
    console.log(`▶ Intake accepted — kicking pipeline for ${ref}`);
    // inherit stdout/stderr so the build's progress + errors show in the host logs
    // (was 'ignore', which made every build invisible).
    const child = spawn('npx', ['tsx', CLI, '--input', file], { cwd: ORCH_ROOT, detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('exit', (code) => console.log(`■ Pipeline for ${ref} exited (code ${code ?? 'null'})`));
    child.unref();
    return file;
  };
}

/** A never-called Stripe stand-in for when no key is set — routes 503 before touching it. */
function unconfiguredStripe(): StripeLike {
  const nope = (): never => { throw new Error('Stripe not configured'); };
  return { checkout: { sessions: { create: nope } }, webhooks: { constructEvent: nope } };
}

/**
 * Fill any unset price IDs by provisioning the catalog from the key — so the
 * founder sets only STRIPE_SECRET_KEY, no STRIPE_PRICE_* vars. Runs after the
 * server is already listening so a slow/failed Stripe call never blocks /health.
 */
async function ensurePrices(stripe: StripeLike, cfg: StripeConfig): Promise<void> {
  try {
    const { priceIds, provisioned, created, reused } = await ensureCatalogPrices(
      stripe as unknown as StripeCatalogLike, cfg.priceIds, 'usd', (m) => console.log('  ' + m));
    if (provisioned) {
      Object.assign(cfg.priceIds, priceIds);
      console.log(`Catalog ready — ${created.length} created, ${reused.length} reused.`);
    }
  } catch (e) {
    console.warn(`⚠  Stripe price auto-provision failed: ${(e as Error).message}. Checkout will 400 until it succeeds — restart the service, or set STRIPE_PRICE_* manually.`);
  }
}

/**
 * Build the Brevo marketing hooks from env, or undefined if Brevo isn't set.
 * BREVO_LIST_LEADS / BREVO_LIST_CUSTOMERS are the numeric Brevo list IDs whose
 * automations run the nurture / onboarding sequences.
 */
function makeMarketing(): MarketingHooks | undefined {
  const key = process.env.BREVO_API_KEY?.trim();
  if (!key) return undefined;
  const brevo = makeBrevo(key);
  const leads = Number(process.env.BREVO_LIST_LEADS) || undefined;
  const customers = Number(process.env.BREVO_LIST_CUSTOMERS) || undefined;
  return {
    onLead: (email, firstName) => brevo.upsertContact({ email, firstName, listIds: leads ? [leads] : [], attributes: { SOURCE: 'scorecard' } }),
    onCustomer: (order) => brevo.upsertContact({ email: order.email!, listIds: customers ? [customers] : [], attributes: { TIER: order.tier, R72_STATUS: order.status } }),
  };
}

function main(): void {
  const cfg = loadStripeConfig();
  // Start regardless of config so the host's health check passes; checkout/webhook
  // return 503 until a key is added. Crash-on-missing-secret breaks cloud deploys.
  if (!cfg.secretKey) {
    console.warn('⚠  STRIPE_SECRET_KEY not set — starting UNCONFIGURED: /health is up, but checkout & webhook 503 until you add a key (see docs/deploy-render.md).');
  }
  const stripe = cfg.secretKey ? (makeStripe(cfg.secretKey) as unknown as StripeLike) : unconfiguredStripe();
  const orders = fileOrderStore(cfg.ordersFile);
  const kickPipeline = createKick(path.join(cfg.dataDir, 'intakes'));
  const marketing = makeMarketing();
  const app = createApp({ stripe, cfg, orders, kickPipeline, now: () => new Date().toISOString(), marketing });
  http.createServer((req, res) => { void app(req, res); }).listen(cfg.port, () => {
    const mode = !cfg.secretKey ? 'UNCONFIGURED' : cfg.liveMode ? 'LIVE ⚠️' : 'TEST';
    console.log(`Relaunch72 payments server on :${cfg.port} — ${mode} mode`);
    // With a key but no manual price IDs, provision the catalog now (idempotent).
    if (cfg.secretKey) void ensurePrices(stripe, cfg);
  });
}

main();
