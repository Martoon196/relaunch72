/**
 * Content-cluster engine CLI — generate one topical-authority cluster.
 *
 *   # From a completed relaunch run (reads its S2 + S3, writes cc.json alongside):
 *   npm run content -- --run runs/2026...-trades-xxxx
 *
 *   # Self-contained mechanics run (generates S2+S3 then the cluster, no API cost):
 *   npm run content -- --fixture trades --mock
 *
 * Exit codes: 0 ok · 3 stage parked (schema/QA) · 1 error.
 */

import fs from 'node:fs';
import path from 'node:path';
import '../config.js'; // loads .env before anything reads process.env
import { FIXTURES_DIR } from '../paths.js';
import type { Intake, RunManifest, StageRecord } from '../types.js';
import { STAGES } from '../stages/defs.js';
import { runStage } from '../stages/runner.js';
import { CONTENT_CLUSTER_STAGE } from './stage.js';
import { createRun, writeManifest } from '../runs/manifest.js';
import { AnthropicClient, type LlmClient } from '../llm/client.js';
import { MockClient } from '../llm/mock.js';

interface CliArgs {
  run?: string;
  fixture?: string;
  input?: string;
  mock: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { mock: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--run') args.run = argv[++i];
    else if (a === '--fixture') args.fixture = argv[++i];
    else if (a === '--input') args.input = argv[++i];
    else if (a === '--mock') args.mock = true;
    else if (a === '--help' || a === '-h') {
      console.log('Usage: npm run content -- (--run runs/<id> | --fixture <name> | --input <path.json>) [--mock]');
      process.exit(0);
    } else throw new Error(`Unknown argument: ${a}`);
  }
  const sources = [args.run, args.fixture, args.input].filter(Boolean).length;
  if (sources !== 1) throw new Error('Provide exactly one of --run <dir>, --fixture <name>, or --input <path.json>');
  return args;
}

function loadPrior(runDir: string): { intake: Intake; prior: Record<string, unknown> } {
  const read = (f: string) => JSON.parse(fs.readFileSync(path.join(runDir, f), 'utf8'));
  const intake = read('intake.json') as Intake;
  const prior: Record<string, unknown> = {};
  for (const stage of ['S2', 'S3']) {
    const file = path.join(runDir, `${stage.toLowerCase()}.json`);
    if (!fs.existsSync(file)) {
      throw new Error(`${runDir} has no ${stage.toLowerCase()}.json — the content engine needs a run that has passed S2 and S3. Run the pipeline through S3 first.`);
    }
    prior[stage] = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  return { intake, prior };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  let runDir: string;
  let intake: Intake;
  const prior: Record<string, unknown> = {};
  let client: LlmClient;

  if (args.run) {
    runDir = path.resolve(args.run);
    const loaded = loadPrior(runDir);
    intake = loaded.intake;
    Object.assign(prior, loaded.prior);
    client = args.mock ? new MockClient(intake) : new AnthropicClient();
    console.log(`Content cluster for ${path.basename(runDir)} (reusing its S2 + S3)`);
  } else {
    const file = args.fixture ? path.join(FIXTURES_DIR, `${args.fixture}.json`) : path.resolve(args.input as string);
    if (!fs.existsSync(file)) throw new Error(`Intake file not found: ${file}`);
    intake = JSON.parse(fs.readFileSync(file, 'utf8')) as Intake;
    const source = args.fixture ?? path.basename(file, '.json');
    const created = createRun(`${source}-content`, args.mock ? 'mock' : 'live', 'CC');
    runDir = created.runDir;
    const manifest = created.manifest;
    fs.writeFileSync(path.join(runDir, 'intake.json'), JSON.stringify(intake, null, 2), 'utf8');
    client = args.mock ? new MockClient(intake) : new AnthropicClient();
    console.log(`Content cluster (fresh run ${manifest.run_id}) — generating S2 + S3 first…`);
    // The cluster is grounded in S2 (dream buyer) + S3 (message & voice): generate them first.
    for (const stageId of ['S2', 'S3']) {
      const def = STAGES[stageId];
      if (!def) throw new Error(`No stage definition for ${stageId}`);
      console.log(`  ${stageId}  running (${def.name})…`);
      const { record, output } = await runStage(def, intake, prior, { runDir, client });
      manifest.stages.push(record);
      if (record.status !== 'passed' || output === null) {
        console.log(`  ${stageId} PARKED — cannot build a cluster without it. Flags: ${record.flags.join('; ')}`);
        writeManifest(runDir, manifest);
        return 3;
      }
      prior[stageId] = output;
    }
    writeManifest(runDir, manifest);
  }

  console.log(`  CC  running (${CONTENT_CLUSTER_STAGE.name})…`);
  const { record, output } = await runStage(CONTENT_CLUSTER_STAGE, intake, prior, { runDir, client });
  const line = (r: StageRecord) => `  CC  ${r.status.toUpperCase()} attempts=${r.attempts.length} cost=$${r.cost_usd.toFixed(4)} model=${r.model}`;
  console.log(line(record));
  for (const flag of record.flags) console.log(`      ⚑ ${flag}`);

  if (record.status !== 'passed' || output === null) {
    console.log(`\nContent cluster PARKED for human review. See ${runDir}/${(record.output_file ?? 'manifest.json')}`);
    return 3;
  }
  const out = output as { supporting: unknown[] };
  console.log(`\n✓ Cluster written: ${runDir}/cc.json — 1 pillar + ${out.supporting.length} supporting articles`);
  if (client.mode === 'mock') console.log('NOTE: mock mode — mechanics only; article briefs are synthetic, not for publication.');
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  });
