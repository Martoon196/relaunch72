/**
 * The tick engine: for a given date, work out what's due per tenant and run it
 * through an injected ActionRunner. The runner is the seam to the real rails
 * (content / social / keyword / ads) — the default is a deterministic mock that
 * records what WOULD run, so the whole manager exercises at £0 and in tests. A
 * live runner (wiring each action to its CLI/module per tenant runDir) is the
 * next step and drops in without touching this engine.
 */

import type { ActivityEntry, DueAction, RailAction, Tenant } from './types.js';
import { dueActions } from './schedule.js';
import type { GhlArtifact, GhlClient } from '../ghl/types.js';

export type ActionRunner = (tenant: Tenant, action: DueAction) => Promise<ActivityEntry>;

/** No external calls, deterministic — logs what would run for whom. */
export const mockRunner: ActionRunner = async (tenant, action) => ({
  tenantId: tenant.id,
  action: action.action,
  at: action.dueDate,
  // A simulation is not a successfully executed rail. Marking it skipped keeps
  // ingestTick from turning a dry-run plan into a customer-facing success event.
  status: 'skipped',
  note: `simulation only: would run ${action.action} (${action.cadence}) for ${tenant.name}; no external action occurred`,
});

/** How each rail action lands as a GHL artifact pushed into the client's sub-account. */
const ARTIFACT_FOR: Record<RailAction, GhlArtifact> = {
  content_cluster: { type: 'content_cluster', title: 'Content-cluster draft (Soro)' },
  social_batch: { type: 'social_post', title: 'Social schedule draft — not scheduled' },
  keyword_refresh: { type: 'note', title: 'Keyword-planning draft — data source not attached' },
  ads_refresh: { type: 'ad_campaign', title: 'Ad-campaign draft — not created or published' },
};

/**
 * Runner that dispatches each due action through GoHighLevel: ensure the client's
 * sub-account exists, then push the artifact for that action. Works with either a
 * MockGhlClient (£0) or the live GHL client (SaaS-Pro token). The rails' own
 * generation (Soro/social/ads) is wired in behind this as a follow-on; this is
 * the seam that proves the manager → GHL path end to end.
 */
export function ghlRunner(ghl: GhlClient): ActionRunner {
  return async (tenant, action) => {
    const loc = await ghl.ensureLocation({ id: tenant.id, name: tenant.name });
    const artifact = ARTIFACT_FOR[action.action];
    const res = await ghl.pushArtifact(loc.locationId, artifact);
    const pushed = res.artifactId
      ? `${artifact.type} draft record → ${loc.locationId} (${res.artifactId}); nothing was scheduled or published`
      : `${artifact.type} draft NOT recorded (GHL not fully configured)`;
    return {
      tenantId: tenant.id,
      action: action.action,
      at: action.dueDate,
      status: ghl.mode === 'live' && res.artifactId ? 'ok' : 'skipped',
      note: `${ghl.mode === 'mock' ? 'simulation only — ' : ''}ghl[${ghl.mode}]: ${pushed}${loc.created ? ` [${ghl.mode === 'mock' ? 'simulated' : 'new'} sub-account]` : ''}`,
    };
  };
}

export interface TickResult {
  date: string;
  due: number;
  entries: ActivityEntry[];
}

export async function runTick(tenants: Tenant[], dateISO: string, runner: ActionRunner = mockRunner): Promise<TickResult> {
  const due = dueActions(tenants, dateISO);
  const byId = new Map(tenants.map((t) => [t.id, t]));
  const entries: ActivityEntry[] = [];
  for (const action of due) {
    const tenant = byId.get(action.tenantId);
    if (!tenant) continue;
    try {
      entries.push(await runner(tenant, action));
    } catch (err) {
      entries.push({ tenantId: action.tenantId, action: action.action, at: dateISO, status: 'failed', note: (err as Error).message });
    }
  }
  return { date: dateISO, due: due.length, entries };
}
