/**
 * Boot-time wiring for the client portal: a persisted CRM store, a seeded demo
 * tenant you can log into, and the PortalDeps the router needs. Mock-first — no
 * external calls. Real per-client provisioning (a tenant per paid subscriber,
 * their own generated run dir) is the next slice; this makes the portal a
 * running, log-in-able app today.
 */

import path from 'node:path';
import { JsonCrmStore } from '../crm/store.js';
import { ingestTick } from '../crm/ingest.js';
import { makeDashboard } from './data.js';
import { passwordOk } from './session.js';
import type { PortalDeps } from './router.js';
import type { ActivityEntry } from '../manager/types.js';

interface Creds { tenantId: string; password: string }

/** A manager run recorded to the CRM (mock — labelled in the UI). */
async function recordRun(store: JsonCrmStore, tenantId: string): Promise<number> {
  const at = new Date().toISOString();
  const tick: ActivityEntry[] = [
    { tenantId, action: 'content_cluster', at, status: 'ok', note: 'Generated this week’s content cluster' },
    { tenantId, action: 'keyword_refresh', at, status: 'ok', note: 'Re-priced fan-out queries by search volume' },
    { tenantId, action: 'social_batch', at, status: 'ok', note: 'Scheduled the next 30 social posts' },
    { tenantId, action: 'ads_refresh', at, status: 'ok', note: 'Prepared 2 ad drafts (paused, awaiting your yes)' },
  ];
  return ingestTick(store, tick);
}

export interface PortalConfig {
  dataDir: string;
  sessionSecret: string;
  secure: boolean;
  demoEmail?: string;
  demoPassword?: string;
  /** Optional run dir to bind to the demo tenant so real artifacts show. */
  demoRunDir?: string;
}

export async function buildPortalDeps(cfg: PortalConfig): Promise<PortalDeps> {
  const store = new JsonCrmStore(path.join(cfg.dataDir, 'portal-crm.json'));
  const email = (cfg.demoEmail ?? 'owner@frayne-electrical.co.uk').toLowerCase();
  const password = cfg.demoPassword ?? 'relaunch72';
  const creds = new Map<string, Creds>([[email, { tenantId: 't-frayne', password }]]);

  // Seed the demo tenant once (idempotent — only if the store is empty).
  if ((await store.listTenants()).length === 0) {
    await store.upsertTenant({ id: 't-frayne', name: 'Frayne Electrical', runDir: cfg.demoRunDir });
    const a = await store.addContact('t-frayne', { name: 'Priya Nair', email: 'priya@nairlets.example' });
    await store.addContact('t-frayne', { name: 'Tom Fielding', phone: '07700 900112' });
    const c = await store.addContact('t-frayne', { name: 'Marsh Property Ltd', email: 'ops@marshprop.example' });
    const w = await store.addContact('t-frayne', { name: 'Derwent Lettings', email: 'hello@derwent.example' });
    await store.moveContact(a.id, 'contacted');
    await store.moveContact(c.id, 'qualified');
    await store.moveContact(w.id, 'won');
    await recordRun(store, 't-frayne');
  }

  return {
    sessionSecret: cfg.sessionSecret,
    secure: cfg.secure,
    login: async (e, pw) => {
      const c = creds.get(e.toLowerCase());
      return c && passwordOk(pw, c.password) ? c.tenantId : null;
    },
    dashboard: makeDashboard(store, (t) => t.runDir),
    runTick: async (tid) => recordRun(store, tid),
  };
}
