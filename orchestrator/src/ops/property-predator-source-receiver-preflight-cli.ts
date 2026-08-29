#!/usr/bin/env node

import '../config.js';
import {
  formatPropertyPredatorReceiverPreflight,
  runPropertyPredatorReceiverPreflight,
} from './property-predator-source-receiver-preflight.js';

async function main(): Promise<void> {
  if (process.argv.length > 2) {
    process.stderr.write('Usage: npm run receiver:preflight\n');
    process.exitCode = 2;
    return;
  }
  // No database is opened here on purpose. The schema half is proven against
  // the target database by the activation runbook step that supplies one.
  const report = await runPropertyPredatorReceiverPreflight(process.env);
  process.stdout.write(`${formatPropertyPredatorReceiverPreflight(report)}\n`);
  process.exitCode = report.result === 'ready-for-activation-review' ? 0 : 1;
}

void main();
