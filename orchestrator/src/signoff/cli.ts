/**
 * Founder sign-off CLI — the human QA gate (LS-19).
 *
 *   npm run signoff -- --run runs/<id>                         # review summary, no change
 *   npm run signoff -- --run runs/<id> --approve [--by NAME]   # approve → ready for delivery
 *   npm run signoff -- --run runs/<id> --send-back "fix the ecom hero" --stages S6
 *
 * Reads the assembled bundle.json, records the decision to signoff.json, and
 * moves the bundle's status. Nothing is deleted; a prior sign-off needs --force
 * to overwrite. Delivery (the actual send) is the next task and reads signoff.json.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Signoff } from '../types.js';
import { approve, sendBack, summarize, bundleStatusFor, SignoffError, type BundleLike } from './signoff.js';

interface Args {
  run?: string;
  decision?: 'approve' | 'send-back';
  notes?: string;
  stages: string[];
  by: string;
  force: boolean;
}

function parse(argv: string[]): Args {
  const a: Args = { stages: [], by: 'Founder', force: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--run') a.run = argv[++i];
    else if (t === '--approve') a.decision = 'approve';
    else if (t === '--send-back') { a.decision = 'send-back'; a.notes = argv[++i]; }
    else if (t === '--stages') a.stages = (argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (t === '--by') a.by = argv[++i] ?? 'Founder';
    else if (t === '--force') a.force = true;
    else if (t === '--help' || t === '-h') { a.decision = undefined; a.run = a.run ?? undefined; }
    else throw new Error(`Unknown argument: ${t}`);
  }
  return a;
}

function main(): number {
  const args = parse(process.argv.slice(2));
  if (!args.run) throw new Error('Provide --run <run dir>');
  const runDir = path.resolve(args.run);
  const bundlePath = path.join(runDir, 'bundle.json');
  if (!fs.existsSync(bundlePath)) {
    throw new Error(`No bundle.json in ${runDir} — the run must reach S10 assembly before sign-off.`);
  }
  const bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8')) as BundleLike & Record<string, unknown>;

  // No decision → just show the review summary.
  if (!args.decision) {
    console.log(summarize(bundle));
    return 0;
  }

  // Guard re-signing.
  if ((bundle.status === 'approved' || bundle.status === 'sent_back') && !args.force) {
    throw new Error(`Already ${bundle.status} — pass --force to overwrite the recorded sign-off.`);
  }

  const at = new Date().toISOString();
  let signoff: Signoff;
  try {
    signoff = args.decision === 'approve'
      ? approve(bundle, { by: args.by, at, force: args.force })
      : sendBack(bundle, { by: args.by, at, stages: args.stages, notes: args.notes ?? '' });
  } catch (e) {
    if (e instanceof SignoffError) { console.error(`Sign-off blocked: ${e.message}`); return 2; }
    throw e;
  }

  fs.writeFileSync(path.join(runDir, 'signoff.json'), JSON.stringify(signoff, null, 2), 'utf8');
  bundle.status = bundleStatusFor(signoff.decision);
  (bundle as Record<string, unknown>).signoff = { decision: signoff.decision, by: signoff.by, at: signoff.at };
  fs.writeFileSync(bundlePath, JSON.stringify(bundle, null, 2), 'utf8');

  if (signoff.decision === 'approved') {
    const n = signoff.acknowledged_flags?.length ?? 0;
    console.log(`✓ APPROVED by ${signoff.by} — ${bundle.business}`);
    console.log(n ? `  ${n} QA flag(s) acknowledged and recorded.` : '  Clean pack, no flags.');
    console.log('  → ready for delivery (LS-19 delivery step reads signoff.json).');
  } else {
    const where = signoff.send_back?.stages.length ? signoff.send_back.stages.join(', ') : 'the whole pack';
    console.log(`↩ SENT BACK by ${signoff.by} — re-run ${where}`);
    console.log(`  Note: ${signoff.send_back?.notes}`);
    console.log('  Recorded to signoff.json for the targeted re-run.');
  }
  return 0;
}

try {
  process.exit(main());
} catch (err) {
  console.error(`Error: ${(err as Error).message}`);
  process.exit(1);
}
