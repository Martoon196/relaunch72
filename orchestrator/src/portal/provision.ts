/**
 * Portal composition boundaries. The legacy builder below is an explicit local
 * development/demo path backed by JSON. The PostgreSQL builder composes only
 * canonical auth + CRM services and never constructs those stores.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { JsonCrmStore } from '../crm/store.js';
import { JsonAccountStore, type AccountStore } from './accounts.js';
import { InMemoryLoginThrottle } from './session.js';
import { makeDashboard } from './data.js';
import { makeBilling } from './billing.js';
import { generateBrandBrain, runTickReal } from './run.js';
import { FIXTURES_DIR } from '../paths.js';
import type { Intake } from '../types.js';
import type { LegacyPortalDeps, PortalInboxReadBoundary, PostgresPortalDeps } from './router.js';
import type { PortalCrmService } from './crm-service.js';
import type { PortalAuthService } from './auth-service.js';
import type { PropertyPredatorSsoClient } from './property-predator-sso.js';
import type { PortalJourneyManagerService } from './journey-manager-service.js';
import type { PortalCompanyContentService } from './company-content-service.js';
import type { PortalBrandBrainService } from './brand-brain-service.js';
import type { PortalAffiliateComplianceService } from './affiliate-compliance-service.js';
import type { PortalConversionInboxCommandService } from './conversion-inbox-service.js';
import type { PortalOperatorActionCentreService } from './operator-action-centre-pg-service.js';
import type { SubscriptionStore } from '../server/subscriptions.js';
import { canonicalIntake } from '../intake/canonical.js';
import { RELAUNCH72_PRODUCT_PROFILE, type PortalProductProfile } from './product-profile.js';

export interface ProvisionArgs {
  email: string;
  name: string;
  intake: Intake;
}
export interface ProvisionResult {
  tenantId: string;
  name: string;
  email: string;
  /** One-use, high-entropy setup token. Deliver it only in the setup email. */
  setupToken: string;
  setupExpiresAt: string;
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
function setupToken(): string {
  return crypto.randomBytes(32).toString('base64url');
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

  const existingAccount = await accounts.findByEmail(email);
  if (existingAccount) {
    const existingTenant = await store.getTenant(existingAccount.tenantId);
    const existingRunDir = existingTenant?.runDir ?? path.join(dataDir, 'portal-runs', existingAccount.tenantId);
    return {
      tenantId: existingAccount.tenantId,
      name: existingTenant?.name ?? args.name,
      email,
      setupToken: '',
      setupExpiresAt: '',
      generated: fs.existsSync(path.join(existingRunDir, 's3.json')),
      existing: true,
    };
  }

  let runDir: string | undefined = path.join(dataDir, 'portal-runs', tenantId);
  let generated = true;
  try {
    await generateBrandBrain(canonicalIntake(args.intake), runDir);
  } catch {
    generated = false;
    runDir = undefined; // login still works; the dashboard shows the CRM only
  }

  await store.upsertTenant({ id: tenantId, name: args.name, runDir });
  const token = setupToken();
  const setupExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  await accounts.createPending(email, tenantId, token, setupExpiresAt);
  if (generated) await runTickReal(store, tenantId); // record the first run to the timeline
  return { tenantId, name: args.name, email, setupToken: token, setupExpiresAt, generated, existing: false };
}

export interface PortalConfig {
  dataDir: string;
  sessionSecret: string;
  secure: boolean;
  demoEmail?: string;
  demoPassword?: string;
  demoRunDir?: string;
  /** Development/test fixture only. Production wiring must set this false. */
  allowDemoSeed?: boolean;
  /** Called after a NEW tenant is provisioned (e.g. deliver its setup link). */
  onProvisioned?: (result: ProvisionResult) => Promise<void>;
  /** Roll back a pending login and reject provisioning if setup delivery fails. */
  requireSetupDelivery?: boolean;
  /** Subscription store to drive the portal billing screen; absent = billing UI off. */
  subscriptions?: SubscriptionStore;
  /** Start a plan checkout (wired to Stripe in index.ts); returns the URL to redirect to. */
  subscribeUrl?: (plan: string, email: string | null) => Promise<string>;
  /** Open the Stripe billing portal for an existing customer; returns the URL. */
  manageUrl?: (customerId: string) => Promise<string>;
  /** When true, "Run this week" requires an active subscription (default false — demo runs). */
  billingEnforced?: boolean;
}

export interface PortalBundle {
  portal: LegacyPortalDeps;
  provision: (args: ProvisionArgs) => Promise<ProvisionResult>;
}

export interface PostgresPortalConfig {
  sessionSecret: string;
  secure: boolean;
  auth: PortalAuthService;
  /** Optional, env-gated main-site identity bridge. It never carries provider tokens. */
  propertyPredatorSso?: PropertyPredatorSsoClient;
  crm: PortalCrmService;
  journeys?: PortalJourneyManagerService;
  /** Authoritative operator queue; assignment/snooze only, with no provider effects. */
  operatorActions?: PortalOperatorActionCentreService;
  /** Omitted unless the dedicated company-content command identity is ready. */
  companyContent?: PortalCompanyContentService;
  /** Read-only Brand Brain metadata. Omitted until its RLS reader is ready. */
  brandBrain?: PortalBrandBrainService;
  /** Fixture-only affiliate compliance evidence. Omitted outside explicit preview composition. */
  affiliateCompliance?: PortalAffiliateComplianceService;
  /** TEST-only conversion queue read boundary; no provider/send capability. */
  inbox?: PortalInboxReadBoundary;
  /** Durable TEST-only draft/approval queue boundary; no dispatcher capability. */
  inboxCommands?: PortalConversionInboxCommandService;
  productProfile?: PortalProductProfile;
  /** Explicit authenticated-proxy client address policy; omitted by default. */
  trustedClientAddress?: PostgresPortalDeps['trustedClientAddress'];
  now?: () => number;
  requestId?: () => string;
}

/**
 * Compose the canonical portal without constructing a JSON account, CRM or
 * billing store. PostgreSQL readiness is owned by buildPgPortalPlatform.
 */
export function buildPostgresPortalDeps(cfg: PostgresPortalConfig): PostgresPortalDeps {
  return {
    kind: 'postgres',
    sessionSecret: cfg.sessionSecret,
    secure: cfg.secure,
    loginThrottle: new InMemoryLoginThrottle(),
    auth: cfg.auth,
    propertyPredatorSso: cfg.propertyPredatorSso,
    crm: cfg.crm,
    journeys: cfg.journeys,
    operatorActions: cfg.operatorActions,
    companyContent: cfg.companyContent,
    brandBrain: cfg.brandBrain,
    affiliateCompliance: cfg.affiliateCompliance,
    inbox: cfg.inbox,
    inboxCommands: cfg.inboxCommands,
    productProfile: cfg.productProfile ?? RELAUNCH72_PRODUCT_PROFILE,
    trustedClientAddress: cfg.trustedClientAddress,
    now: cfg.now,
    requestId: cfg.requestId,
  };
}

export async function buildPortalDeps(cfg: PortalConfig): Promise<PortalBundle> {
  const store = new JsonCrmStore(path.join(cfg.dataDir, 'portal-crm.json'));
  const accounts = new JsonAccountStore(path.join(cfg.dataDir, 'portal-accounts.json'));

  // Seed the demo tenant only in explicitly allowed development/test contexts.
  if (cfg.allowDemoSeed === true && (await store.listTenants()).length === 0) {
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

  const billing = cfg.subscriptions
    ? makeBilling(cfg.subscriptions, async (tid) => (await accounts.findByTenant(tid))?.email ?? null)
    : undefined;

  const portal: LegacyPortalDeps = {
    kind: 'legacy',
    sessionSecret: cfg.sessionSecret,
    secure: cfg.secure,
    login: (e, pw) => accounts.verify(e, pw),
    completeSetup: (token, password, now) => accounts.completeSetup(token, password, now),
    loginThrottle: new InMemoryLoginThrottle(),
    dashboard: makeDashboard(store, (t) => t.runDir),
    runTick: (tid) => runTickReal(store, tid),
    billing,
    subscribeUrl: cfg.subscribeUrl,
    manageUrl: cfg.manageUrl,
    billingEnforced: cfg.billingEnforced,
  };
  const provision = async (args: ProvisionArgs): Promise<ProvisionResult> => {
    const result = await provisionTenant(store, accounts, cfg.dataDir, args);
    if (!result.existing && result.setupToken && cfg.onProvisioned) {
      try { await cfg.onProvisioned(result); }
      catch (e) {
        if (cfg.requireSetupDelivery) {
          await accounts.discardPending(result.email, result.setupToken);
          throw new Error(`account setup delivery failed for ${result.email}: ${(e as Error).message}`);
        }
        console.warn(`onProvisioned failed for ${result.email}: ${(e as Error).message}`);
      }
    }
    return result;
  };
  return { portal, provision };
}
