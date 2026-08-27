/**
 * AI Socials Manager — spike CLI.
 *
 *   # Dry-run a run's S8 pack into a schedule (DEFAULT; no network, no cost):
 *   npm run social -- --run runs/<id> --schedule 2026-08-01
 *
 *   # `--publish` changes only the preview action. This legacy spike has no
 *   # live provider path; durable provider operations own that later boundary.
 *
 * Every post passes qaSocialPost (no-invention guard) BEFORE it is queued: any
 * FATAL issue blocks that post; the run writes social-plan.json for review.
 * Exit codes: 0 ok · 3 QA blocked one or more posts · 1 error.
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import '../config.js';
import type { Intake, QAIssue } from '../types.js';
import { qaSocialPost } from '../qa/checks.js';
import { buildSchedule, type S8Output } from './schedule.js';
import { MockPublisher } from './mock.js';
import type { PublishResult, SocialPublisher } from './types.js';

export interface SocialCliArgs {
  run?: string;
  startDate?: string;
  time?: string;
  platforms: string[];
  mock: boolean;
  publish: boolean;
  executeProviderEffects: boolean;
  approvalId?: string;
  approvalSha256?: string;
  idempotencyKey?: string;
}

export interface SocialCliRuntime {
  readonly env?: NodeJS.ProcessEnv;
  readonly createMockPublisher?: () => SocialPublisher;
  readonly log?: (message: string) => void;
}

export const SOCIAL_PROVIDER_EFFECTS_SWITCH = 'PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED';

function argumentValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function setOnce(args: SocialCliArgs, field: 'approvalId' | 'approvalSha256' | 'idempotencyKey', value: string, flag: string): void {
  if (args[field] !== undefined) throw new Error(`${flag} may be supplied only once`);
  args[field] = value;
}

export function parseSocialCliArgs(argv: readonly string[]): SocialCliArgs {
  const args: SocialCliArgs = {
    platforms: [],
    mock: false,
    publish: false,
    executeProviderEffects: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--run') { args.run = argumentValue(argv, i, a); i += 1; }
    else if (a === '--schedule') { args.startDate = argumentValue(argv, i, a); i += 1; }
    else if (a === '--time') { args.time = argumentValue(argv, i, a); i += 1; }
    else if (a === '--platform') { args.platforms.push(argumentValue(argv, i, a)); i += 1; }
    else if (a === '--mock') args.mock = true;
    else if (a === '--publish') args.publish = true;
    else if (a === '--execute-provider-effects') args.executeProviderEffects = true;
    else if (a === '--approval-id') { setOnce(args, 'approvalId', argumentValue(argv, i, a), a); i += 1; }
    else if (a === '--approval-sha256') { setOnce(args, 'approvalSha256', argumentValue(argv, i, a), a); i += 1; }
    else if (a === '--idempotency-key') { setOnce(args, 'idempotencyKey', argumentValue(argv, i, a), a); i += 1; }
    else if (a === '--help' || a === '-h') {
      console.log('Usage: npm run social -- --run runs/<id> --schedule YYYY-MM-DD [--time HH:MM] [--platform <name> ...] [--publish] [--mock]');
      console.log('Dry-run is the only mode. Live provider effects are unavailable in this legacy CLI.');
      process.exit(0);
    } else throw new Error(`Unknown argument: ${a}`);
  }
  if (!args.run) throw new Error('Provide --run <run dir> (a run that has passed S8)');
  if (!args.startDate) throw new Error('Provide --schedule <YYYY-MM-DD> (the date day 1 posts on)');
  return args;
}

function assertLegacyCliIsDark(args: SocialCliArgs): void {
  if (args.executeProviderEffects || args.approvalId !== undefined
      || args.approvalSha256 !== undefined || args.idempotencyKey !== undefined) {
    throw new Error(
      'live social provider effects are unavailable in this legacy CLI; use the durable provider-operation rail',
    );
  }
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

export async function runSocialCli(
  argv: readonly string[],
  runtime: SocialCliRuntime = {},
): Promise<number> {
  const args = parseSocialCliArgs(argv);
  const log = runtime.log ?? console.log;
  // No combination of environment, `--publish`, approval-shaped text or an
  // idempotency-shaped value can construct a live adapter from this spike.
  assertLegacyCliIsDark(args);
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
  log(`Socials plan for ${path.basename(runDir)} — ${planned.length} post(s), day 1 = ${args.startDate}${args.platforms.length ? ` (platforms: ${args.platforms.join(', ')})` : ''}`);

  // ── QA gate: every post checked before anything is queued ──────────────────
  const checked = planned.map((p) => ({ post: p, issues: qaSocialPost({ platform: p.platform, text: p.text, day: p.day }, intake, prior) }));
  const blocked = checked.filter((c) => c.issues.some((i) => i.fatal));
  const flagged = checked.filter((c) => c.issues.length > 0 && !c.issues.some((i) => i.fatal));
  for (const c of [...blocked, ...flagged]) {
    for (const issue of c.issues) log(`   ${issue.fatal ? '✗ FATAL' : '⚠'} ${issue.message}`);
  }
  const publishable = checked.filter((c) => c.issues.length === 0).map((c) => c.post);
  log(`  QA: ${publishable.length} clean · ${flagged.length} flagged · ${blocked.length} blocked (fatal)`);

  const client: SocialPublisher = (runtime.createMockPublisher ?? (() => new MockPublisher()))();
  if (client.mode !== 'mock') throw new Error('dry-run mode refuses a live publisher');
  const action = args.publish ? 'publish now' : 'schedule';
  log(`  backend: ${client.mode} · action: dry-run: would ${action}`);

  const results: PublishResult[] = [];
  for (const post of publishable) {
    const r = args.publish ? await client.publish(post) : await client.schedule(post);
    results.push(r);
    log(`   ${r.status === 'failed' ? '✗' : '→'} day ${post.day} ${post.platform} @ ${post.scheduleDate}${r.error ? ` — ${r.error}` : ''}`);
  }

  const plan = {
    run: path.basename(runDir),
    start_date: args.startDate,
    backend: client.mode,
    action: args.publish ? 'preview_publish' : 'preview_schedule',
    provider_effects: 'none',
    approval: null,
    idempotency_sha256: null,
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
  log(`\n✓ Plan written: ${runDir}/social-plan.json`);
  log('NOTE: dry-run backend — no live provider exists here and nothing was scheduled or published.');
  return blocked.length > 0 ? 3 : 0;
}

const directEntry = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
  : false;
if (directEntry) {
  runSocialCli(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    });
}
