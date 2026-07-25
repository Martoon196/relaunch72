/**
 * AI Socials Manager — spike CLI.
 *
 *   # Dry-run a run's S8 pack into a schedule (no network, no cost):
 *   npm run social -- --run runs/<id> --schedule 2026-08-01 --mock
 *
 *   # Live (needs AYRSHARE_API_KEY in .env; opt-in, informed consent applies):
 *   npm run social -- --run runs/<id> --schedule 2026-08-01 --platform Facebook --publish
 *
 * Every post passes qaSocialPost (no-invention guard) BEFORE it is queued: any
 * FATAL issue blocks that post; the run writes social-plan.json for review.
 * Exit codes: 0 ok · 3 QA blocked one or more posts · 1 error.
 */

import fs from 'node:fs';
import path from 'node:path';
import '../config.js';
import type { Intake, QAIssue } from '../types.js';
import { qaSocialPost } from '../qa/checks.js';
import { buildSchedule, type S8Output } from './schedule.js';
import { MockPublisher } from './mock.js';
import { AyrsharedPublisher } from './ayrshare.js';
import type { PlannedPost, PublishResult, SocialPublisher } from './types.js';

interface CliArgs {
  run?: string;
  startDate?: string;
  time?: string;
  platforms: string[];
  mock: boolean;
  publish: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { platforms: [], mock: false, publish: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--run') args.run = argv[++i];
    else if (a === '--schedule') args.startDate = argv[++i];
    else if (a === '--time') args.time = argv[++i];
    else if (a === '--platform') args.platforms.push(argv[++i] as string);
    else if (a === '--mock') args.mock = true;
    else if (a === '--publish') args.publish = true;
    else if (a === '--help' || a === '-h') {
      console.log('Usage: npm run social -- --run runs/<id> --schedule YYYY-MM-DD [--time HH:MM] [--platform <name> ...] [--mock] [--publish]');
      process.exit(0);
    } else throw new Error(`Unknown argument: ${a}`);
  }
  if (!args.run) throw new Error('Provide --run <run dir> (a run that has passed S8)');
  if (!args.startDate) throw new Error('Provide --schedule <YYYY-MM-DD> (the date day 1 posts on)');
  return args;
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const runDir = path.resolve(args.run as string);

  const intake = readJson<Intake>(path.join(runDir, 'intake.json'));
  const s8File = path.join(runDir, 's8.json');
  if (!fs.existsSync(s8File)) throw new Error(`${runDir} has no s8.json — the socials manager needs a run that has passed S8. Run the pipeline through S8 first.`);
  const s8 = readJson<S8Output>(s8File);
  // S2/S3 give the no-invention guard its number/quote provenance (optional but recommended).
  const prior: Record<string, unknown> = { S8: s8 };
  for (const stage of ['S2', 'S3']) {
    const f = path.join(runDir, `${stage.toLowerCase()}.json`);
    if (fs.existsSync(f)) prior[stage] = readJson(f);
  }

  const planned = buildSchedule(s8, { startDate: args.startDate as string, time: args.time, platforms: args.platforms });
  console.log(`Socials plan for ${path.basename(runDir)} — ${planned.length} post(s), day 1 = ${args.startDate}${args.platforms.length ? ` (platforms: ${args.platforms.join(', ')})` : ''}`);

  // ── QA gate: every post checked before anything is queued ──────────────────
  const checked = planned.map((p) => ({ post: p, issues: qaSocialPost({ platform: p.platform, text: p.text, day: p.day }, intake, prior) }));
  const blocked = checked.filter((c) => c.issues.some((i) => i.fatal));
  const flagged = checked.filter((c) => c.issues.length > 0 && !c.issues.some((i) => i.fatal));
  for (const c of [...blocked, ...flagged]) {
    for (const issue of c.issues) console.log(`   ${issue.fatal ? '✗ FATAL' : '⚠'} ${issue.message}`);
  }
  const publishable = checked.filter((c) => c.issues.length === 0).map((c) => c.post);
  console.log(`  QA: ${publishable.length} clean · ${flagged.length} flagged · ${blocked.length} blocked (fatal)`);

  // ── Publish/schedule the clean posts through the chosen backend ────────────
  const client: SocialPublisher = args.mock ? new MockPublisher() : new AyrsharedPublisher();
  console.log(`  backend: ${client.mode}${client.mode === 'live' ? ' (Ayrshare)' : ''} · action: ${args.publish ? 'publish now' : 'schedule'}`);

  const results: PublishResult[] = [];
  for (const post of publishable) {
    const r = args.publish ? await client.publish(post) : await client.schedule(post);
    results.push(r);
    console.log(`   ${r.status === 'failed' ? '✗' : '→'} day ${post.day} ${post.platform} @ ${post.scheduleDate}${r.error ? ` — ${r.error}` : ''}`);
  }

  const plan = {
    run: path.basename(runDir),
    start_date: args.startDate,
    backend: client.mode,
    action: args.publish ? 'publish' : 'schedule',
    counts: { planned: planned.length, clean: publishable.length, flagged: flagged.length, blocked: blocked.length },
    posts: checked.map((c) => ({
      day: c.post.day,
      platform: c.post.platform,
      pillar: c.post.pillar,
      scheduleDate: c.post.scheduleDate,
      chars: c.post.text.length,
      qa: c.issues.map((i: QAIssue) => ({ check: i.check, fatal: i.fatal === true, message: i.message })),
    })),
    results,
    cost_usd_total: results.reduce((n, r) => n + (r.costUsd ?? 0), 0),
  };
  fs.writeFileSync(path.join(runDir, 'social-plan.json'), JSON.stringify(plan, null, 2), 'utf8');
  console.log(`\n✓ Plan written: ${runDir}/social-plan.json`);
  if (client.mode === 'mock') console.log('NOTE: mock backend — nothing was posted; this is a dry run.');
  return blocked.length > 0 ? 3 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  });
