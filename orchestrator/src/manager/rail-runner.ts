/**
 * The rail runner — the capstone that makes a manager tick actually DRIVE the
 * rails per tenant, then push each result into GoHighLevel. This is what turns
 * the platform from "scaffolded seams" into one end-to-end flow:
 *
 *   tick → per due action, load the tenant's brand brain from its runDir →
 *   run the real rail (Soro cluster / social schedule / keyword report / ad
 *   campaign) → push the artifact into the client's GHL sub-account.
 *
 * Mock-first: with { mock: true } the LLM + every rail + GHL are all mock, so the
 * whole package runs at £0 and in tests. Swapping in live keys (Anthropic, the
 * rail APIs, a GHL token) lights the same flow up for real — no rewrite.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Intake } from '../types.js';
import { runStage } from '../stages/runner.js';
import { CONTENT_CLUSTER_STAGE } from '../content/stage.js';
import { AD_STAGE } from '../ads/stage.js';
import { buildSchedule, type S8Output } from '../social/schedule.js';
import { MockKeywordProvider } from '../keyword/mock.js';
import { MockClient } from '../llm/mock.js';
import { AnthropicClient, type LlmClient } from '../llm/client.js';
import type { GhlArtifact, GhlClient } from '../ghl/types.js';
import type { ActionRunner } from './engine.js';
import type { ActivityEntry, DueAction, Tenant } from './types.js';

function readJson<T>(file: string): T { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; }
function has(runDir: string, file: string): boolean { return fs.existsSync(path.join(runDir, file)); }

function entry(action: DueAction, status: ActivityEntry['status'], note: string): ActivityEntry {
  return { tenantId: action.tenantId, action: action.action, at: action.dueDate, status, note };
}

/**
 * Execute one rail for a tenant and return the artifact to push into GHL (or null
 * to skip, with a reason).
 */
async function runRail(
  tenant: Tenant,
  action: DueAction,
  runDir: string,
  intake: Intake,
  client: LlmClient,
): Promise<{ artifact: GhlArtifact; detail: string } | { skip: string }> {
  switch (action.action) {
    case 'content_cluster': {
      if (!has(runDir, 's2.json') || !has(runDir, 's3.json')) return { skip: 'needs S2 + S3 in the tenant runDir' };
      const prior = { S2: readJson(path.join(runDir, 's2.json')), S3: readJson(path.join(runDir, 's3.json')) };
      const { output } = await runStage(CONTENT_CLUSTER_STAGE, intake, prior, { runDir, client });
      if (!output) return { skip: 'cluster parked by QA' };
      const cl = output as { topic: string; supporting: unknown[] };
      return { artifact: { type: 'content_cluster', title: `Content-cluster draft: ${cl.topic}`, payload: output }, detail: `${cl.supporting.length + 1} article briefs drafted` };
    }
    case 'ads_refresh': {
      if (!['s2.json', 's3.json', 's4.json'].every((f) => has(runDir, f))) return { skip: 'needs S2 + S3 + S4' };
      const prior = { S2: readJson(path.join(runDir, 's2.json')), S3: readJson(path.join(runDir, 's3.json')), S4: readJson(path.join(runDir, 's4.json')) };
      const { output } = await runStage(AD_STAGE, intake, prior, { runDir, client });
      if (!output) return { skip: 'campaign parked by QA' };
      const camp = output as { platforms: string[]; ad_sets: unknown[] };
      return {
        artifact: { type: 'ad_campaign', title: 'Simulated ad-campaign draft — not created or published', payload: output },
        detail: `simulated ad drafts for ${camp.platforms.length} platform(s); no ad account changed`,
      };
    }
    case 'social_batch': {
      if (!has(runDir, 's8.json')) return { skip: 'needs S8 (social pack)' };
      const s8 = readJson<S8Output>(path.join(runDir, 's8.json'));
      const planned = buildSchedule(s8, { startDate: action.dueDate });
      return {
        artifact: { type: 'social_post', title: 'Social schedule draft — not scheduled', payload: { count: planned.length, posts: planned } },
        detail: `${planned.length}-post schedule drafted; no post was scheduled or published`,
      };
    }
    case 'keyword_refresh': {
      if (!has(runDir, 'cc.json')) return { skip: 'needs a cc.json cluster (run content first)' };
      const cluster = readJson<{ pillar: { target_query: string }; supporting: { target_query: string }[] }>(path.join(runDir, 'cc.json'));
      const queries = [cluster.pillar.target_query, ...cluster.supporting.map((s) => s.target_query)];
      const metrics = await new MockKeywordProvider().metrics(queries);
      return {
        artifact: { type: 'note', title: 'Simulated keyword estimates — not live search data', payload: { mode: 'simulated', metrics } },
        detail: `simulated planning estimates for ${metrics.length} queries; not live search-volume data`,
      };
    }
  }
}

export function railRunner(ghl: GhlClient, opts: { mock: boolean }): ActionRunner {
  return async (tenant, action) => {
    if (!tenant.runDir) return entry(action, 'skipped', `${tenant.name}: no runDir (brand brain) configured`);
    const runDir = path.resolve(tenant.runDir);
    if (!has(runDir, 'intake.json')) return entry(action, 'skipped', `${tenant.name}: no intake.json in runDir`);
    const intake = readJson<Intake>(path.join(runDir, 'intake.json'));
    const client: LlmClient = opts.mock ? new MockClient(intake) : new AnthropicClient();

    let result: Awaited<ReturnType<typeof runRail>>;
    try {
      result = await runRail(tenant, action, runDir, intake, client);
    } catch (err) {
      return entry(action, 'failed', `${action.action}: ${(err as Error).message}`);
    }
    if ('skip' in result) return entry(action, 'skipped', `${action.action}: ${result.skip}`);

    const loc = await ghl.ensureLocation({ id: tenant.id, name: tenant.name });
    const push = await ghl.pushArtifact(loc.locationId, result.artifact);
    if (opts.mock || ghl.mode === 'mock') {
      return entry(
        action,
        'skipped',
        `simulation only: ${action.action}: ${result.detail}; mock GHL record ${push.artifactId || 'not created'}; no external account changed`,
      );
    }
    const pushed = push.artifactId
      ? `draft/note recorded in GHL ${loc.locationId} (${push.artifactId}); nothing was published`
      : 'draft/note not recorded because GHL is not fully configured';
    return entry(action, push.artifactId ? 'ok' : 'skipped', `${action.action}: ${result.detail}; ${pushed}${loc.created ? ' [new sub-account]' : ''}`);
  };
}
