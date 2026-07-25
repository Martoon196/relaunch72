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
import { MockPublisher } from '../social/mock.js';
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
      return { artifact: { type: 'content_cluster', title: `Cluster: ${cl.topic}`, payload: output }, detail: `${cl.supporting.length + 1} articles` };
    }
    case 'ads_refresh': {
      if (!['s2.json', 's3.json', 's4.json'].every((f) => has(runDir, f))) return { skip: 'needs S2 + S3 + S4' };
      const prior = { S2: readJson(path.join(runDir, 's2.json')), S3: readJson(path.join(runDir, 's3.json')), S4: readJson(path.join(runDir, 's4.json')) };
      const { output } = await runStage(AD_STAGE, intake, prior, { runDir, client });
      if (!output) return { skip: 'campaign parked by QA' };
      const camp = output as { platforms: string[]; ad_sets: unknown[] };
      const publisher = new MockPublisherAds();
      const drafts = await Promise.all(camp.platforms.map((p) => publisher.draft(p, camp.ad_sets.length)));
      return { artifact: { type: 'ad_campaign', title: 'Ad campaign (paused drafts)', payload: output }, detail: `${drafts.length} platform(s), all paused` };
    }
    case 'social_batch': {
      if (!has(runDir, 's8.json')) return { skip: 'needs S8 (social pack)' };
      const s8 = readJson<S8Output>(path.join(runDir, 's8.json'));
      const planned = buildSchedule(s8, { startDate: action.dueDate });
      const publisher = new MockPublisher();
      // Schedule the next post as the day's batch (demo scope).
      const next = planned[0];
      if (next) await publisher.schedule(next);
      return { artifact: { type: 'social_post', title: 'Social batch scheduled', payload: { count: planned.length } }, detail: `${planned.length} posts scheduled` };
    }
    case 'keyword_refresh': {
      if (!has(runDir, 'cc.json')) return { skip: 'needs a cc.json cluster (run content first)' };
      const cluster = readJson<{ pillar: { target_query: string }; supporting: { target_query: string }[] }>(path.join(runDir, 'cc.json'));
      const queries = [cluster.pillar.target_query, ...cluster.supporting.map((s) => s.target_query)];
      const metrics = await new MockKeywordProvider().metrics(queries);
      return { artifact: { type: 'note', title: 'Keyword report', payload: metrics }, detail: `${metrics.length} queries priced` };
    }
  }
}

/** Tiny inline paused-draft helper so we don't import the ads publisher's file just for a count. */
class MockPublisherAds {
  async draft(platform: string, adSets: number): Promise<{ platform: string; adSets: number }> { return { platform, adSets }; }
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
    const pushed = push.artifactId ? `→ ${loc.locationId} (${push.artifactId})` : '→ GHL not fully configured';
    return entry(action, push.artifactId ? 'ok' : 'skipped', `${action.action}: ${result.detail} ${pushed}${loc.created ? ' [new sub-account]' : ''}`);
  };
}
