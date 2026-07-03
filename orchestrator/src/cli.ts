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
import { createRun, writeManifest } from './runs/manifest.js';
import { AnthropicClient, type LlmClient } from './llm/client.js';
import { MockClient } from './llm/mock.js';

interface CliArgs {
  fixture?: string;
  input?: string;
  through: string;
  mock: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { through: 'S2', mock: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--fixture') args.fixture = argv[++i];
    else if (a === '--input') args.input = argv[++i];
    else if (a === '--through') args.through = (argv[++i] ?? '').toUpperCase();
    else if (a === '--mock') args.mock = true;
    else if (a === '--help' || a === '-h') {
      console.log('Usage: npm run pipeline -- --fixture <trades|coach|ecom> [--through S0|S1|S2] [--mock]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  if (!args.fixture && !args.input) throw new Error('Provide --fixture <name> or --input <path.json>');
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
  const { intake, source } = loadIntake(args);

  const { runDir, manifest } = createRun(source, args.mock ? 'mock' : 'live', args.through);
  fs.writeFileSync(path.join(runDir, 'intake.json'), JSON.stringify(intake, null, 2), 'utf8');
  console.log(`Run ${manifest.run_id}`);
  console.log(`  dir: ${runDir}`);

  // ── S0 · intake QA gate — nothing runs downstream until accepted ────────
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

  const client: LlmClient = args.mock ? new MockClient(intake) : new AnthropicClient();

  // ── S1 → S2 sequentially; a parked stage parks the whole run ────────────
  const prior: Record<string, unknown> = {};
  for (const stageId of STAGE_ORDER) {
    const def = STAGES[stageId];
    if (!def) throw new Error(`No stage definition for ${stageId}`);
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
