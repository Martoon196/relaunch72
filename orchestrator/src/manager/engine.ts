/**
 * The tick engine: for a given date, work out what's due per tenant and run it
 * through an injected ActionRunner. The runner is the seam to the real rails
 * (content / social / keyword / ads) — the default is a deterministic mock that
 * records what WOULD run, so the whole manager exercises at £0 and in tests. A
 * live runner (wiring each action to its CLI/module per tenant runDir) is the
 * next step and drops in without touching this engine.
 */

import type { ActivityEntry, DueAction, Tenant } from './types.js';
import { dueActions } from './schedule.js';

export type ActionRunner = (tenant: Tenant, action: DueAction) => Promise<ActivityEntry>;

/** No external calls, deterministic — logs what would run for whom. */
export const mockRunner: ActionRunner = async (tenant, action) => ({
  tenantId: tenant.id,
  action: action.action,
  at: action.dueDate,
  status: 'ok',
  note: `mock: would run ${action.action} (${action.cadence}) for ${tenant.name}`,
});

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
