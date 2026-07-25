/**
 * Paid-ads rail CLI — generate an ad campaign from a completed relaunch's
 * strategy, then load it as PAUSED drafts.
 *
 *   # £0 mechanics (mock LLM + mock publisher):
 *   npm run ads -- --run runs/<id> --mock
 *
 *   # Real copy, mock publish (safe preview — nothing touches an ad account):
 *   npm run ads -- --run runs/<id>
 *
 *   # Live: real copy → PAUSED drafts in the customer's Meta account (needs keys):
 *   npm run ads -- --run runs/<id> --publish
 *
 * The campaign passes qaAdCampaign (no invented stats/quotes, no guaranteed
 * outcomes, char limits) before anything is created. Nothing ever un-pauses or
 * spends. Exit 0 ok · 3 stage parked · 1 error.
 */

import fs from 'node:fs';
import path from 'node:path';
import '../config.js';
import type { Intake } from '../types.js';
import { runStage } from '../stages/runner.js';
import { AD_STAGE } from './stage.js';
import { AnthropicClient, type LlmClient } from '../llm/client.js';
import { MockClient } from '../llm/mock.js';
import { MockAdsPublisher } from './mock.js';
import { MetaAdsPublisher } from './meta.js';
import type { AdCampaign, AdsPublisher, DraftRef } from './types.js';

interface CliArgs { run?: string; mock: boolean; publish: boolean }

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { mock: false, publish: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--run') args.run = argv[++i];
    else if (a === '--mock') args.mock = true;
    else if (a === '--publish') args.publish = true;
    else if (a === '--help' || a === '-h') {
      console.log('Usage: npm run ads -- --run runs/<id> [--mock] [--publish]');
      process.exit(0);
    } else throw new Error(`Unknown argument: ${a}`);
  }
  if (!args.run) throw new Error('Provide --run <run dir> (a run that has passed S2, S3 and S4)');
  if (args.mock && args.publish) throw new Error('--mock and --publish are mutually exclusive');
  return args;
}

function readJson<T>(file: string): T { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; }

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const runDir = path.resolve(args.run as string);
  const intake = readJson<Intake>(path.join(runDir, 'intake.json'));

  const prior: Record<string, unknown> = {};
  for (const stage of ['S2', 'S3', 'S4']) {
    const f = path.join(runDir, `${stage.toLowerCase()}.json`);
    if (!fs.existsSync(f)) throw new Error(`${runDir} has no ${stage.toLowerCase()}.json — the ads rail needs a run that has passed S2, S3 and S4. Run the pipeline through S4 first.`);
    prior[stage] = readJson(f);
  }

  // ── Generate the campaign (mock LLM under --mock, else live) ───────────────
  const llm: LlmClient = args.mock ? new MockClient(intake) : new AnthropicClient();
  console.log(`Ad campaign for ${path.basename(runDir)} — generating (${AD_STAGE.name}, LLM: ${llm.mode})…`);
  const { record, output } = await runStage(AD_STAGE, intake, prior, { runDir, client: llm });
  console.log(`  AD  ${record.status.toUpperCase()} attempts=${record.attempts.length} model=${record.model}`);
  for (const flag of record.flags) console.log(`      ⚑ ${flag}`);
  if (record.status !== 'passed' || output === null) {
    console.log(`\nAd campaign PARKED for human review. See ${runDir}/manifest / ${record.output_file ?? 'ad-attempt'}`);
    return 3;
  }
  const campaign = output as AdCampaign;

  // ── Publish as PAUSED drafts (mock unless --publish) ───────────────────────
  const publisher: AdsPublisher = args.publish ? new MetaAdsPublisher() : new MockAdsPublisher();
  console.log(`  publisher: ${publisher.mode}${publisher.mode === 'live' ? ' (Meta)' : ''} · objective: ${campaign.objective} · ${campaign.ad_sets.length} ad sets · platforms: ${campaign.platforms.join(', ')}`);

  const drafts: DraftRef[] = [];
  for (const platform of campaign.platforms) {
    const d = await publisher.createDraft(campaign, platform);
    drafts.push(d);
    console.log(`   ${d.status === 'failed' ? '✗' : '→'} ${platform}: ${d.status}${d.id ? ` (${d.id})` : ''}${d.error ? ` — ${d.error}` : ''}`);
  }

  const plan = {
    run: path.basename(runDir),
    llm: llm.mode,
    publisher: publisher.mode,
    objective: campaign.objective,
    platforms: campaign.platforms,
    ad_sets: campaign.ad_sets.length,
    drafts,
  };
  fs.writeFileSync(path.join(runDir, 'ads-plan.json'), JSON.stringify(plan, null, 2), 'utf8');
  console.log(`\n✓ Plan written: ${runDir}/ads-plan.json — all drafts PAUSED, nothing spends.`);
  if (publisher.mode === 'mock') console.log('NOTE: mock publisher — nothing was created in an ad account; this is a preview.');
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  });
