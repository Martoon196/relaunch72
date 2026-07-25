/**
 * Bridge the manager's tick output into the CRM timeline: each rail run the
 * manager performs for a tenant becomes an activity on that tenant's record, so
 * the portal shows a live feed of what the AI did — "generated a content
 * cluster", "scheduled 30 posts", "loaded paused ad drafts".
 */

import type { ActivityEntry, RailAction } from '../manager/types.js';
import type { Channel } from './types.js';
import type { CrmStore } from './store.js';

const CHANNEL_FOR: Record<RailAction, Channel> = {
  content_cluster: 'system',
  social_batch: 'social',
  keyword_refresh: 'system',
  ads_refresh: 'ads',
};

/** Record a manager tick's entries as CRM activities. Returns how many landed. */
export async function ingestTick(store: CrmStore, entries: ActivityEntry[]): Promise<number> {
  let n = 0;
  for (const e of entries) {
    if (e.status === 'skipped') continue; // nothing happened worth logging
    await store.addActivity({
      tenantId: e.tenantId,
      at: e.at,
      kind: 'rail_run',
      channel: CHANNEL_FOR[e.action],
      summary: e.note ?? `${e.action} (${e.status})`,
    });
    n++;
  }
  return n;
}
