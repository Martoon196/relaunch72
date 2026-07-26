/**
 * Boot-time wiring for the client portal: a persisted CRM store, a seeded demo
 * tenant you can log into, and the PortalDeps the router needs. Mock-first — no
 * external calls. Real per-client provisioning (a tenant per paid subscriber,
 * their own generated run dir) is the next slice; this makes the portal a
 * running, log-in-able app today.
 */

import fs from 'node:fs';
import path from 'node:path';
import { JsonCrmStore } from '../crm/store.js';
import { makeDashboard } from './data.js';
import { passwordOk } from './session.js';
import { generateBrandBrain, runTickReal } from './run.js';
import { FIXTURES_DIR } from '../paths.js';
import type { Intake } from '../types.js';
import type { PortalDeps } from './router.js';

interface Creds { tenantId: string; password: string }

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
    // Generate a real brand brain + artifacts so the dashboard shows genuine
    // (mock) output. If it fails, still seed the tenant so login works.
    let runDir = cfg.demoRunDir;
    if (!runDir) {
      runDir = path.join(cfg.dataDir, 'portal-runs', 't-frayne');
      try {
        const intake = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'trades.json'), 'utf8')) as Intake;
        await generateBrandBrain(intake, runDir);
      } catch (e) {
        console.warn(`⚠  Demo brand brain not generated (${(e as Error).message}); seeding CRM only.`);
        runDir = undefined;
      }
    }
    await store.upsertTenant({ id: 't-frayne', name: 'Frayne Electrical', runDir });
    const a = await store.addContact('t-frayne', { name: 'Priya Nair', email: 'priya@nairlets.example' });
    await store.addContact('t-frayne', { name: 'Tom Fielding', phone: '07700 900112' });
    const c = await store.addContact('t-frayne', { name: 'Marsh Property Ltd', email: 'ops@marshprop.example' });
    const w = await store.addContact('t-frayne', { name: 'Derwent Lettings', email: 'hello@derwent.example' });
    await store.moveContact(a.id, 'contacted');
    await store.moveContact(c.id, 'qualified');
    await store.moveContact(w.id, 'won');
    await runTickReal(store, 't-frayne'); // record the first run to the timeline
  }

  return {
    sessionSecret: cfg.sessionSecret,
    secure: cfg.secure,
    login: async (e, pw) => {
      const c = creds.get(e.toLowerCase());
      return c && passwordOk(pw, c.password) ? c.tenantId : null;
    },
    dashboard: makeDashboard(store, (t) => t.runDir),
    runTick: async (tid) => runTickReal(store, tid),
  };
}
