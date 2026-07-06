/**
 * Pipeline CLI — M1 vertical slice.
 *
 *   npm run pipeline -- --fixture trades --through S2
 *   npm run pipeline -- --input path/to/intake.json --through S1
 *   npm run pipeline -- --fixture coach --mock          # mechanics only, no API cost
 *
 * Exit codes: 0 ok · 2 intake rejected by S0 (nudge) · 3 stage parked · 1 error.
 */

import fs from 'node:fs';
import path from 'node:path';
import './config.js'; // loads .env before anything reads process.env
import { FIXTURES_DIR } from './paths.js';
import type { Intake, RunManifest } from './types.js';
import { runS0 } from './intake/s0.js';
import { STAGES, STAGE_ORDER } from './stages/defs.js';
import { runStage } from './stages/runner.js';
import { runS10 } from './stages/s10.js';
import { createRun, writeManifest } from './runs/manifest.js';
import { AnthropicClient, type LlmClient } from './llm/client.js';
import { MockClient } from './llm/mock.js';

interface CliArgs {
  fixture?: string;
  input?: string;
  resume?: string;
  through: string;
  mock: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { through: 'S9', mock: false }; // default: the full nine-deliverable stack
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--fixture') args.fixture = argv[++i];
    else if (a === '--input') args.input = argv[++i];
    else if (a === '--resume') args.resume = argv[++i];
    else if (a === '--through') args.through = (argv[++i] ?? '').toUpperCase();
    else if (a === '--mock') args.mock = true;
    else if (a === '--help' || a === '-h') {
      console.log('Usage: npm run pipeline -- (--fixture <trades|coach|ecom> | --resume runs/<id>) [--through S0…S9, default S9] [--mock]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  if (!args.fixture && !args.input && !args.resume) throw new Error('Provide --fixture <name>, --input <path.json>, or --resume <run dir>');
  if (args.fixture && args.input) throw new Error('Use either --fixture or --input, not both');
  if (!['S0', ...STAGE_ORDER].includes(args.through)) {
    throw new Error(`--through must be one of S0, ${STAGE_ORDER.join(', ')}`);
  }
  return args;
}

function loadIntake(args: CliArgs): { intake: Intake; source: string } {
  const file = args.fixture ? path.join(FIXTURES_DIR, `${args.fixture}.json`) : path.resolve(args.input as string);
  if (!fs.existsSync(file)) {
    const available = fs.existsSync(FIXTURES_DIR)
      ? fs.readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).join(', ')
      : '(none)';
    throw new Error(`Intake file not found: ${file}${args.fixture ? ` — available fixtures: ${available}` : ''}`);
  }
  return {
    intake: JSON.parse(fs.readFileSync(file, 'utf8')) as Intake,
    source: args.fixture ?? path.basename(file, '.json'),
  };
}

function printStageLine(manifest: RunManifest): void {
  for (const s of manifest.stages) {
    const attempts = s.attempts.length;
    const tokens = s.attempts.reduce((n, a) => n + a.tokens_in + a.tokens_out, 0);
    console.log(
      `  ${s.stage}  ${s.status.toUpperCase().padEnd(7)} attempts=${attempts} tokens=${tokens} cost=$${s.cost_usd.toFixed(4)} prompt=${s.prompt_version} model=${s.model}`,
    );
    for (const flag of s.flags) console.log(`      ⚑ ${flag}`);
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  // ── Resume: reuse a parked run's dir, intake and already-passed stages ──
  const prior: Record<string, unknown> = {};
  let runDir: string;
  let manifest: RunManifest;
  let intake: Intake;

  if (args.resume) {
    runDir = path.resolve(args.resume);
    manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf8')) as RunManifest;
    intake = JSON.parse(fs.readFileSync(path.join(runDir, 'intake.json'), 'utf8')) as Intake;
    // Keep only the passed stage records; preload their outputs as prior.
    manifest.stages = manifest.stages.filter((s) => s.status === 'passed' && s.output_file);
    for (const s of manifest.stages) {
      prior[s.stage] = JSON.parse(fs.readFileSync(path.join(runDir, s.output_file as string), 'utf8'));
    }
    manifest.status = 'running';
    manifest.finished_at = null;
    console.log(`Resuming ${manifest.run_id}`);
    console.log(`  dir: ${runDir}`);
    console.log(`  already passed: ${manifest.stages.map((s) => s.stage).join(', ') || '(none)'}`);
  } else {
    const loaded = loadIntake(args);
    intake = loaded.intake;
    const created = createRun(loaded.source, args.mock ? 'mock' : 'live', args.through);
    runDir = created.runDir;
    manifest = created.manifest;
    fs.writeFileSync(path.join(runDir, 'intake.json'), JSON.stringify(intake, null, 2), 'utf8');
    console.log(`Run ${manifest.run_id}`);
    console.log(`  dir: ${runDir}`);

    // ── S0 · intake QA gate — nothing runs downstream until accepted ──────
    const s0 = runS0(intake);
    manifest.s0 = s0;
    fs.writeFileSync(path.join(runDir, 's0.json'), JSON.stringify(s0, null, 2), 'utf8');
    console.log(`  S0  ${s0.accepted ? 'ACCEPTED' : 'REJECTED → nudge'} (${s0.issues.length} issue${s0.issues.length === 1 ? '' : 's'})`);
    if (!s0.accepted) {
      for (const i of s0.issues) console.log(`      · ${i.field}: ${i.reason}`);
      manifest.status = 'nudge_required';
      manifest.finished_at = new Date().toISOString();
      writeManifest(runDir, manifest);
      return 2;
    }
    if (args.through === 'S0') {
      manifest.status = 'completed';
      manifest.finished_at = new Date().toISOString();
      writeManifest(runDir, manifest);
      return 0;
    }
  }

  const client: LlmClient = args.mock ? new MockClient(intake) : new AnthropicClient();

  // ── S1 → S9 sequentially; a parked stage parks the whole run ────────────
  for (const stageId of STAGE_ORDER) {
    const def = STAGES[stageId];
    if (!def) throw new Error(`No stage definition for ${stageId}`);
    if (prior[stageId]) continue; // resume: already passed, skip
    console.log(`  ${stageId}  running (${def.name})…`);
    const { record, output } = await runStage(def, intake, prior, { runDir, client });
    manifest.stages.push(record);
    writeManifest(runDir, manifest); // persist progress after every stage

    if (record.status !== 'passed' || output === null) {
      manifest.status = 'parked';
      manifest.finished_at = new Date().toISOString();
      writeManifest(runDir, manifest);
      printStageLine(manifest);
      console.log(`\nRun PARKED for human review at ${stageId}. See ${runDir}/manifest.json`);
      return 3;
    }
    prior[stageId] = output;
    if (stageId === args.through) break;
  }

  // ── S10 · assembly & strategist gate — runs only over a full stack ──────
  if (args.through === 'S9') {
    const s10 = runS10(intake, prior, manifest, runDir);
    manifest.s10 = s10;
    console.log(
      `  S10 assembled ${s10.package_file} + ${s10.review_file}: ${s10.issues.length} lint issue(s) — ${s10.status}`,
    );
  }

  manifest.status = 'completed';
  manifest.finished_at = new Date().toISOString();
  writeManifest(runDir, manifest);
  printStageLine(manifest);
  console.log(`\nRun completed through ${args.through}. Outputs + manifest in ${runDir}`);
  if (manifest.mode === 'mock') {
    console.log('NOTE: mock mode — mechanics only; outputs are synthetic and not for quality review.');
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  });
