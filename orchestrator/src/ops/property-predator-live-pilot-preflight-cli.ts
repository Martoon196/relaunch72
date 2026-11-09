#!/usr/bin/env node

import '../config.js';
import {
  formatPropertyPredatorPilotPreflight,
  runPropertyPredatorPilotPreflight,
} from './property-predator-live-pilot-preflight.js';

function main(): void {
  if (process.argv.length > 2) {
    process.stderr.write('Usage: npm run pilot:preflight\n');
    process.exitCode = 2;
    return;
  }
  const report = runPropertyPredatorPilotPreflight(process.env);
  process.stdout.write(`${formatPropertyPredatorPilotPreflight(report)}\n`);
  process.exitCode = report.result === 'ready-for-activation-review' ? 0 : 1;
}

main();
