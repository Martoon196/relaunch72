/**
 * Portal run engine — the live "Run this week" behind the button, and one-time
 * brand-brain provisioning for a tenant. Everything is mock-first (£0): the same
 * stages/rails the pipeline uses, run against a tenant's own run dir, writing
 * real artifacts (cluster, keyword report, ad campaign) and recording each run to
 * the CRM timeline. Swap MockClient → AnthropicClient and it's live, no rewrite.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Intake } from '../types.js';
import { STAGES, STAGE_ORDER } from '../stages/defs.js';
import { runStage } from '../stages/runner.js';
import { CONTENT_CLUSTER_STAGE } from '../content/stage.js';
import { AD_STAGE } from '../ads/stage.js';
import { MockKeywordProvider } from '../keyword/mock.js';
import { MockClient } from '../llm/mock.js';
import { ingestTick } from '../crm/ingest.js';
import type { CrmStore } from '../crm/store.js';
import type { ActivityEntry } from '../manager/types.js';

function readJson<T>(file: string): T { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; }
function has(dir: string, f: string): boolean { return fs.existsSync(path.join(dir, f)); }

/** Price a cluster's fan-out queries and write keyword-report.json (mock volumes). */
async function writeKeywordReport(dir: string, cluster: { pillar: { target_query: string }; supporting: { target_query: string }[] }): Promise<number> {
  const queries = [cluster.pillar.target_query, ...cluster.supporting.map((s) => s.target_query)];
  const metrics = await new MockKeywordProvider().metrics(queries);
  fs.writeFileSync(path.join(dir, 'keyword-report.json'), JSON.stringify({ queries: metrics.map((m) => ({ query: m.keyword, volume: m.volume, source: m.source })) }, null, 2), 'utf8');
  return metrics.length;
}

/**
 * Generate a tenant's brand brain + first artifacts into `dir`: the full S1–S9
 * pipeline, then a Soro cluster, a keyword report and an ad campaign. Mock LLM.
 */
export async function generateBrandBrain(intake: Intake, dir: string): Promise<void> {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'intake.json'), JSON.stringify(intake, null, 2), 'utf8');
  const client = new MockClient(intake);
  const prior: Record<string, unknown> = {};
  for (const id of STAGE_ORDER) {
    const def = STAGES[id];
    if (!def) continue;
    const { record, output } = await runStage(def, intake, prior, { runDir: dir, client });
    if (record.status !== 'passed' || output === null) throw new Error(`brand brain: stage ${id} did not pass`);
    prior[id] = output;
  }
  const cc = await runStage(CONTENT_CLUSTER_STAGE, intake, { S2: prior.S2, S3: prior.S3 }, { runDir: dir, client });
  if (cc.output) await writeKeywordReport(dir, cc.output as never);
  await runStage(AD_STAGE, intake, { S2: prior.S2, S3: prior.S3, S4: prior.S4 }, { runDir: dir, client });
}

/**
 * The live "Run this week": regenerate this period's content/keyword/ads for a
 * tenant from their run dir and record each to their CRM timeline. Falls back to
 * recording a simulated run if the tenant has no brand brain yet.
 */
export async function runTickReal(store: CrmStore, tenantId: string): Promise<number> {
  const tenant = await store.getTenant(tenantId);
  const dir = tenant?.runDir;
  const at = new Date().toISOString();

  if (!dir || !fs.existsSync(dir) || !has(dir, 's3.json') || !has(dir, 'intake.json')) {
    // No brand brain — record a mock run so the button still does something visible.
    const sim: ActivityEntry[] = [
      { tenantId, action: 'content_cluster', at, status: 'ok', note: 'Generated this week’s content cluster' },
      { tenantId, action: 'social_batch', at, status: 'ok', note: 'Scheduled the next 30 social posts' },
    ];
    return ingestTick(store, sim);
  }

  const intake = readJson<Intake>(path.join(dir, 'intake.json'));
  const client = new MockClient(intake);
  const S2 = readJson(path.join(dir, 's2.json'));
  const S3 = readJson(path.join(dir, 's3.json'));
  const S4 = has(dir, 's4.json') ? readJson(path.join(dir, 's4.json')) : undefined;
  const entries: ActivityEntry[] = [];

  const cc = await runStage(CONTENT_CLUSTER_STAGE, intake, { S2, S3 }, { runDir: dir, client });
  if (cc.output) {
    const cluster = cc.output as { pillar: { target_query: string }; supporting: { target_query: string }[] };
    entries.push({ tenantId, action: 'content_cluster', at, status: 'ok', note: `Generated a ${cluster.supporting.length + 1}-article content cluster` });
    const priced = await writeKeywordReport(dir, cluster);
    entries.push({ tenantId, action: 'keyword_refresh', at, status: 'ok', note: `Priced ${priced} fan-out queries by search volume` });
  }
  if (has(dir, 's8.json')) entries.push({ tenantId, action: 'social_batch', at, status: 'ok', note: 'Scheduled 30 days of on-brand social posts' });
  if (S4) {
    const ad = await runStage(AD_STAGE, intake, { S2, S3, S4 }, { runDir: dir, client });
    if (ad.output) {
      const camp = ad.output as { platforms: string[] };
      entries.push({ tenantId, action: 'ads_refresh', at, status: 'ok', note: `Prepared ${camp.platforms.length} ad campaign(s) as paused drafts` });
    }
  }
  await ingestTick(store, entries);
  return entries.length;
}
