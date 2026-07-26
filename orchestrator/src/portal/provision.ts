/**
 * Boot-time wiring for the client portal: a persisted CRM store, an account
 * (login) store, a seeded demo tenant you can log into, and — the new bit — a
 * `provision` function that turns a real signup (an accepted intake + email) into
 * a working portal login with its own generated brand brain. Mock-first, £0.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { JsonCrmStore } from '../crm/store.js';
import { JsonAccountStore, type AccountStore } from './accounts.js';
import { makeDashboard } from './data.js';
import { generateBrandBrain, runTickReal } from './run.js';
import { FIXTURES_DIR } from '../paths.js';
import type { Intake } from '../types.js';
import type { PortalDeps } from './router.js';

export interface ProvisionArgs {
  email: string;
  name: string;
  intake: Intake;
}
export interface ProvisionResult {
  tenantId: string;
  email: string;
  /** The generated temp password (deliver to the customer; not stored in clear). */
  password: string;
  /** True if the brand brain generated; false = login works, artifacts deferred. */
  generated: boolean;
  /** True if this email already had an account (no new tenant created). */
  existing: boolean;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'client';
}
function tenantIdFor(name: string, email: string): string {
  const h = crypto.createHash('sha256').update(email.toLowerCase()).digest('hex').slice(0, 6);
  return `t-${slug(name)}-${h}`;
}
function tempPassword(): string {
  return crypto.randomBytes(9).toString('base64url'); // 12 url-safe chars
}

/** Turn a signup into a working portal login with a generated brand brain. */
export async function provisionTenant(
  store: JsonCrmStore,
  accounts: AccountStore,
  dataDir: string,
  args: ProvisionArgs,
): Promise<ProvisionResult> {
  const email = args.email.trim().toLowerCase();
  const tenantId = tenantIdFor(args.name, email);

  if (await accounts.has(email)) {
    return { tenantId, email, password: '', generated: fs.existsSync(path.join(dataDir, 'portal-runs', tenantId, 's3.json')), existing: true };
  }

  let runDir: string | undefined = path.join(dataDir, 'portal-runs', tenantId);
  let generated = true;
  try {
    await generateBrandBrain(args.intake, runDir);
  } catch {
    generated = false;
    runDir = undefined; // login still works; the dashboard shows the CRM only
  }

  await store.upsertTenant({ id: tenantId, name: args.name, runDir });
  const password = tempPassword();
  await accounts.create(email, tenantId, password);
  if (generated) await runTickReal(store, tenantId); // record the first run to the timeline
  return { tenantId, email, password, generated, existing: false };
}

export interface PortalConfig {
  dataDir: string;
  sessionSecret: string;
  secure: boolean;
  demoEmail?: string;
  demoPassword?: string;
  demoRunDir?: string;
}

export interface PortalBundle {
  portal: PortalDeps;
  provision: (args: ProvisionArgs) => Promise<ProvisionResult>;
}

export async function buildPortalDeps(cfg: PortalConfig): Promise<PortalBundle> {
  const store = new JsonCrmStore(path.join(cfg.dataDir, 'portal-crm.json'));
  const accounts = new JsonAccountStore(path.join(cfg.dataDir, 'portal-accounts.json'));

  // Seed the demo tenant + its account once (only if there are no tenants yet).
  if ((await store.listTenants()).length === 0) {
    const email = (cfg.demoEmail ?? 'owner@frayne-electrical.co.uk').toLowerCase();
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
    await runTickReal(store, 't-frayne');
    if (!(await accounts.has(email))) await accounts.create(email, 't-frayne', cfg.demoPassword ?? 'relaunch72');
  }

  const portal: PortalDeps = {
    sessionSecret: cfg.sessionSecret,
    secure: cfg.secure,
    login: (e, pw) => accounts.verify(e, pw),
    dashboard: makeDashboard(store, (t) => t.runDir),
    runTick: (tid) => runTickReal(store, tid),
  };
  return { portal, provision: (args) => provisionTenant(store, accounts, cfg.dataDir, args) };
}
