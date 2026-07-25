/**
 * AI marketing manager — tick CLI. Shows what the manager would run, for which
 * clients, on a given date.
 *
 *   # £0 dry tick over a demo roster (or your own --tenants file):
 *   npm run manager -- --date 2026-08-03 --mock
 *   npm run manager -- --tenants tenants.json --date 2026-08-03 --mock
 *
 * A tenants file is a JSON array of { id, name, runDir?, rules:[{action,cadence}] }.
 * Exit 0 ok · 1 error.
 */

import fs from 'node:fs';
import path from 'node:path';
import '../config.js';
import type { Tenant } from './types.js';
import { runTick, ghlRunner, type ActionRunner } from './engine.js';
import { MockGhlClient } from '../ghl/mock.js';
import { GhlLiveClient } from '../ghl/live.js';

interface CliArgs { tenants?: string; date?: string; mock: boolean; ghl: boolean }

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { mock: false, ghl: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tenants') args.tenants = argv[++i];
    else if (a === '--date') args.date = argv[++i];
    else if (a === '--mock') args.mock = true;
    else if (a === '--ghl') args.ghl = true;
    else if (a === '--help' || a === '-h') {
      console.log('Usage: npm run manager -- --date YYYY-MM-DD [--tenants <file.json>] [--ghl] [--mock]');
      process.exit(0);
    } else throw new Error(`Unknown argument: ${a}`);
  }
  if (!args.date) throw new Error('Provide --date <YYYY-MM-DD> (the tick date)');
  return args;
}

// A small demo roster so the manager runs with no setup. Real rosters come from
// the portal (one tenant per subscribed client).
const DEMO_ROSTER: Tenant[] = [
  { id: 't-trades', name: 'Brightmoor Electrical (demo)', rules: [
    { action: 'social_batch', cadence: 'daily' },
    { action: 'content_cluster', cadence: 'weekly' },
    { action: 'ads_refresh', cadence: 'monthly' },
  ] },
  { id: 't-coach', name: 'Coach fixture (demo)', rules: [
    { action: 'social_batch', cadence: 'daily' },
    { action: 'keyword_refresh', cadence: 'weekly' },
  ] },
];

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  const tenants: Tenant[] = args.tenants
    ? (JSON.parse(fs.readFileSync(path.resolve(args.tenants), 'utf8')) as Tenant[])
    : DEMO_ROSTER;

  // Pick the runner. --ghl dispatches through GoHighLevel (MockGhlClient under
  // --mock, the live GHL client otherwise); plain --mock is the log-only runner.
  let runner: ActionRunner | undefined;
  if (args.ghl) {
    runner = ghlRunner(args.mock ? new MockGhlClient() : new GhlLiveClient());
  } else if (args.mock) {
    runner = undefined; // engine default = mockRunner
  } else {
    // The live rail runner (wiring each action to its own rail per tenant) is
    // the next step; today live ticks go via --ghl. Fail loud, don't pretend.
    throw new Error('No live rail runner yet — use --mock (log plan) or --ghl (push via GoHighLevel). See decisions D-057.');
  }

  const result = await runTick(tenants, args.date as string, runner);
  console.log(`Manager tick for ${result.date} — ${tenants.length} tenant(s), ${result.due} action(s) due\n`);
  for (const e of result.entries) {
    console.log(`   ${e.status === 'ok' ? '→' : '✗'} ${e.tenantId.padEnd(10)} ${e.action.padEnd(16)} ${e.note ?? ''}`);
  }
  if (result.due === 0) console.log('   (nothing due today)');
  console.log('\nNOTE: mock tick — nothing was generated or published; this shows what the manager WOULD run.');
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  });
