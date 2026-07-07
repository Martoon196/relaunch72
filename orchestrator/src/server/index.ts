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
import { createApp } from './app.js';
import { makeStripe } from './stripe-client.js';
import type { StripeLike } from './stripe.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ORCH_ROOT = path.resolve(HERE, '../..');
const CLI = path.join(ORCH_ROOT, 'src', 'cli.ts');
const INTAKE_DIR = path.resolve(ORCH_ROOT, '..', 'data', 'intakes');

function kickPipeline(intake: Intake, sessionId: string | null): string {
  fs.mkdirSync(INTAKE_DIR, { recursive: true });
  const ref = `${sessionId ?? 'intake'}-${Date.now()}`;
  const file = path.join(INTAKE_DIR, `${ref}.json`);
  fs.writeFileSync(file, JSON.stringify(intake, null, 2), 'utf8');
  const child = spawn('npx', ['tsx', CLI, '--input', file], { cwd: ORCH_ROOT, detached: true, stdio: 'ignore' });
  child.unref();
  return file;
}

function main(): void {
  const cfg = loadStripeConfig();
  if (!cfg.secretKey) {
    console.error('STRIPE_SECRET_KEY is not set. Add a TEST key (sk_test_…) to .env — see .env.example. Refusing to start.');
    process.exit(1);
  }
  const stripe = makeStripe(cfg.secretKey) as unknown as StripeLike;
  const orders = fileOrderStore(cfg.ordersFile);
  const app = createApp({ stripe, cfg, orders, kickPipeline, now: () => new Date().toISOString() });
  http.createServer((req, res) => { void app(req, res); }).listen(cfg.port, () => {
    console.log(`Relaunch72 payments server on :${cfg.port} — ${cfg.liveMode ? 'LIVE ⚠️' : 'TEST'} mode`);
    const missing = Object.entries(cfg.priceIds).filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) console.log(`  (price ids not yet set: ${missing.join(', ')} — checkout for those tiers will 400 until configured)`);
  });
}

main();
