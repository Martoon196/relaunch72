#!/usr/bin/env node

import '../config.js';
import {
  formatOwnedTargetRehearsal,
  runOwnedTargetRehearsal,
} from './property-predator-owned-target-rehearsal.js';

if (process.argv.length > 2) {
  process.stderr.write('Usage: npm run pilot:rehearse-targets\n');
  process.exitCode = 2;
} else {
  const report = runOwnedTargetRehearsal(process.env);
  process.stdout.write(`${formatOwnedTargetRehearsal(report)}\n`);
  process.exitCode = report.result === 'ready-for-composed-rail-rehearsal' ? 0 : 1;
}
