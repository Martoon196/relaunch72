/**
 * Boot the Stripe backend. The ONLY module that imports the real `stripe` SDK
 * and touches the filesystem/process — everything else is injected + tested.
 *
 *   npm run serve            # needs STRIPE_SECRET_KEY (test key) in .env
 *
 * On an accepted intake it spawns the pipeline detached (`tsx cli.ts --input …`),
 * so the HTTP response returns immediately while the 72-hour build runs.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Intake } from '../types.js';
import {
  loadPortalAbuseRuntimeConfig,
  loadStripeConfig,
  portalProvisioningEnabled,
  type PortalAbuseRuntimeConfig,
} from './config.js';
import { fileOrderStore, type Order } from './orders.js';
import { fileSubscriptionStore } from './subscriptions.js';
import { createApp, type MarketingHooks } from './app.js';
import { makeStripe } from './stripe-client.js';
import { createSubscriptionCheckout, createBillingPortalUrl, type StripeLike } from './stripe.js';
import { ensureCatalogPrices, ensurePlanPrices, type StripeCatalogLike } from './catalog.js';
import type { StripeConfig } from './config.js';
import { makeBrevo } from '../email/brevo.js';
import { buildPortalDeps, buildPostgresPortalDeps, type PortalBundle } from '../portal/provision.js';
import type { PortalDeps } from '../portal/router.js';
import { loginEmail } from '../portal/emails.js';
import { makePostmark } from '../email/postmark.js';
import type { BuildEntitlement } from './entitlements.js';
import { customerOutboundMessagingEnabled, runtimeSafetyPolicy, subscriptionCheckoutBlockers } from './readiness.js';
import { canonicalIntake } from '../intake/canonical.js';
import { buildPgPortalPlatform, postgresPortalEnabled, type PgPortalPlatform } from '../portal/postgres-platform.js';
import { resolvePortalProductProfile } from '../portal/product-profile.js';
import {
  composePropertyPredatorSso,
} from '../portal/property-predator-sso.js';
import {
  createExternalEventCommandDatabasePool,
  createMailgunWebhookCommandDatabasePool,
  createWebhookDatabasePool,
} from '../db/pool.js';
import {
  PgPropertyPredatorGrowthEventProjector,
  PgPropertyPredatorJourneyRuntime,
  PgPropertyPredatorExternalEventShadowService,
  PropertyPredatorRuntimeEventStore,
  assertPgPropertyPredatorGrowthEventProjectorReady,
  assertPgPropertyPredatorJourneyRuntimeReady,
  assertPgPropertyPredatorExternalEventShadowStoreReady,
  createPropertyPredatorExternalEventHandler,
  loadPropertyPredatorExternalEventConfig,
  type PropertyPredatorExternalEventBridgeMount,
} from '../integrations/external-events/index.js';
import {
  MailgunWebhookIngressService,
  PgMailgunWebhookRepository,
} from '../mailgun-webhook-pg/index.js';
import { assertPgMailgunWebhookIngressReady } from '../integrations/mailgun-webhook/readiness.js';
import {
  createPropertyPredatorMailgunWebhookHandler,
  loadPropertyPredatorMailgunWebhookConfig,
  type PropertyPredatorMailgunWebhookMount,
} from '../integrations/mailgun-webhook/router.js';
import { propertyPredatorDarkProductionBlockers } from '../ops/property-predator-dark-production.js';
import { createCachedRuntimeReadinessProbe } from '../ops/runtime-readiness-cache.js';
import { createPortalRequestContextResolver } from '../portal/request-context.js';
import { createSafeTelemetryLogger } from '../ops/safe-telemetry.js';
import { composePropertyPredatorSimulatedInbound } from '../integrations/simulated-inbound/composition.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ORCH_ROOT = path.resolve(HERE, '../..');
const CLI = path.join(ORCH_ROOT, 'src', 'cli.ts');
const SERVICE_TELEMETRY = createSafeTelemetryLogger({ service: 'relaunch72-server' });

/** Persist the accepted intake + immutable paid scope, then spawn the build. */
function createKick(intakeDir: string, opts: { mockOnly: boolean; maxConcurrent: number }) {
  let activeBuilds = 0;
  return function kickPipeline(intake: Intake, order: Order, entitlement: BuildEntitlement): string {
    if (activeBuilds >= opts.maxConcurrent) throw new Error('test build concurrency limit reached; try again after a current build finishes');
    const safeIntake = canonicalIntake(intake);
    fs.mkdirSync(intakeDir, { recursive: true });
    const ref = `${order.session_id}-${Date.now()}`;
    const file = path.join(intakeDir, `${ref}.json`);
    fs.writeFileSync(file, JSON.stringify(safeIntake, null, 2), 'utf8');
    const jobFile = path.join(intakeDir, `${ref}.job.json`);
    fs.writeFileSync(jobFile, JSON.stringify({
      version: 1,
      created_at: new Date().toISOString(),
      stripe_session_id: order.session_id,
      product: entitlement.product,
      through: entitlement.through,
      portal_access: entitlement.portalAccess,
      manual_fulfilment: entitlement.manualFulfilment,
      execution_mode: opts.mockOnly ? 'mock' : 'live',
      intake_file: file,
    }, null, 2), 'utf8');
    // This id is generated independently of the Stripe session and filesystem
    // reference, so service logs can correlate the child lifecycle without
    // exposing payment/customer identifiers.
    const correlationId = SERVICE_TELEMETRY.nextCorrelationId();
    SERVICE_TELEMETRY.emit('info', 'pipeline.accepted', { correlationId });
    // Pipeline output can contain intake/customer content and provider-authored
    // error text. The service log records only the safe correlated lifecycle;
    // detailed build evidence remains in the protected run artifacts.
    activeBuilds += 1;
    const args = ['tsx', CLI, '--input', file, '--through', entitlement.through, ...(opts.mockOnly ? ['--mock'] : [])];
    const child = spawn('npx', args, { cwd: ORCH_ROOT, detached: true, stdio: 'ignore' });
    let released = false;
    const release = (): void => { if (!released) { released = true; activeBuilds -= 1; } };
    child.on('error', (error) => {
      release();
      SERVICE_TELEMETRY.emit('error', 'pipeline.start_failed', { correlationId, error });
    });
    child.on('exit', () => {
      release();
      SERVICE_TELEMETRY.emit('info', 'pipeline.exited', { correlationId });
    });
    child.unref();
    return file;
  };
}

/** A never-called Stripe stand-in for when no key is set — routes 503 before touching it. */
function unconfiguredStripe(): StripeLike {
  const nope = (): never => { throw new Error('Stripe not configured'); };
  return { checkout: { sessions: { create: nope } }, webhooks: { constructEvent: nope } };
}

/**
 * Fill any unset price IDs by provisioning the catalog from the key — so the
 * founder sets only STRIPE_SECRET_KEY, no STRIPE_PRICE_* vars. Runs after the
 * server is already listening so a slow/failed Stripe call never blocks /health.
 */
async function ensurePrices(stripe: StripeLike, cfg: StripeConfig): Promise<void> {
  try {
    const { priceIds, provisioned, created, reused } = await ensureCatalogPrices(
      stripe as unknown as StripeCatalogLike, cfg.priceIds, 'usd');
    if (provisioned) {
      Object.assign(cfg.priceIds, priceIds);
      console.log(`Catalog ready — ${created.length} created, ${reused.length} reused.`);
    }
  } catch (e) {
    SERVICE_TELEMETRY.emit('warn', 'stripe.catalog.provision_failed', { error: e });
  }
  if (cfg.platformSubscriptionsEnabled) {
    try {
      const { priceIds, provisioned, created, reused } = await ensurePlanPrices(
        stripe as unknown as StripeCatalogLike, cfg.planIds, 'usd');
      if (provisioned) {
        Object.assign(cfg.planIds, priceIds);
        console.log(`Preview plans ready — ${created.length} created, ${reused.length} reused.`);
      }
    } catch (e) {
      SERVICE_TELEMETRY.emit('warn', 'stripe.plan_catalog.provision_failed', { error: e });
    }
  }
}

/**
 * Build the Brevo marketing hooks from env, or undefined if Brevo isn't set.
 * BREVO_LIST_LEADS / BREVO_LIST_CUSTOMERS are the numeric Brevo list IDs whose
 * automations run the nurture / onboarding sequences.
 */
function makeMarketing(): MarketingHooks | undefined {
  const key = process.env.BREVO_API_KEY?.trim();
  if (!key) return undefined;
  const brevo = makeBrevo(key);
  const leads = Number(process.env.BREVO_LIST_LEADS) || undefined;
  const customers = Number(process.env.BREVO_LIST_CUSTOMERS) || undefined;
  return {
    onLead: (email, firstName) => brevo.upsertContact({ email, firstName, listIds: leads ? [leads] : [], attributes: { SOURCE: 'scorecard' } }),
    onCustomer: (order) => brevo.upsertContact({ email: order.email!, listIds: customers ? [customers] : [], attributes: { TIER: order.tier, R72_STATUS: order.status } }),
  };
}

async function main(): Promise<void> {
  const cfg = loadStripeConfig();
  const serviceReadinessBlockers = propertyPredatorDarkProductionBlockers(process.env);
  if (serviceReadinessBlockers.length > 0) {
    // For the controlled production profile, an injected effect credential or
    // loosened switch must stop the process before any SDK/client can perform
    // startup work. Readiness alone is too late for an irreversible rail.
    throw new Error('Property Predator production safety policy did not pass');
  }
  // Start regardless of config so the host's health check passes; checkout/webhook
  // return 503 until a key is added. Crash-on-missing-secret breaks cloud deploys.
  if (!cfg.secretKey) {
    console.warn('⚠  STRIPE_SECRET_KEY not set — starting UNCONFIGURED: /health is up, but checkout & webhook 503 until you add a key (see docs/deploy-render.md).');
  }
  const stripe = cfg.secretKey ? (makeStripe(cfg.secretKey) as unknown as StripeLike) : unconfiguredStripe();
  const externalEventConfig = loadPropertyPredatorExternalEventConfig(process.env);
  let externalEventCommandPool:
    ReturnType<typeof createExternalEventCommandDatabasePool> | undefined;
  let externalEventWebhookPool:
    ReturnType<typeof createWebhookDatabasePool> | undefined;
  let propertyPredatorExternalEvents: PropertyPredatorExternalEventBridgeMount = Object.freeze({
    enabled: externalEventConfig.enabled,
    ready: false,
    blockers: externalEventConfig.blockers,
  });
  if (externalEventConfig.enabled
      && externalEventConfig.configurationReady
      && externalEventConfig.binding) {
    try {
      // An explicitly enabled bridge may never fall back to a generic local or
      // owner database credential. The pool itself verifies current_user on
      // every new physical connection before it can be checked out.
      if (!process.env.DATABASE_EXTERNAL_EVENT_COMMAND_URL?.trim()) {
        throw new Error('dedicated external-event command database identity is required');
      }
      if (!process.env.DATABASE_WEBHOOK_URL?.trim()) {
        throw new Error('dedicated webhook projection database identity is required');
      }
      externalEventCommandPool = createExternalEventCommandDatabasePool(process.env);
      externalEventWebhookPool = createWebhookDatabasePool(process.env);
      await Promise.all([
        assertPgPropertyPredatorExternalEventShadowStoreReady(externalEventCommandPool),
        assertPgPropertyPredatorGrowthEventProjectorReady(externalEventWebhookPool),
        assertPgPropertyPredatorJourneyRuntimeReady(
          externalEventWebhookPool,
          externalEventConfig.binding.workspaceId,
        ),
      ]);
      const receiptStore = new PgPropertyPredatorExternalEventShadowService({
        commandPool: externalEventCommandPool,
        workspaceId: externalEventConfig.binding.workspaceId,
      });
      const growthProjector = new PgPropertyPredatorGrowthEventProjector({
        webhookPool: externalEventWebhookPool,
        workspaceId: externalEventConfig.binding.workspaceId,
      });
      const journeyRuntime = new PgPropertyPredatorJourneyRuntime({
        webhookPool: externalEventWebhookPool,
        workspaceId: externalEventConfig.binding.workspaceId,
      });
      const store = new PropertyPredatorRuntimeEventStore({
        receiptStore,
        growthProjector,
        journeyRuntime,
      });
      const runtimeHealth: {
        ready: boolean;
        blockers: readonly string[];
      } = {
        ready: true,
        blockers: Object.freeze([]),
      };
      const handle = createPropertyPredatorExternalEventHandler({
        production: externalEventConfig.production,
        trustedProxyAddresses: externalEventConfig.trustedProxyAddresses,
        bindings: [{
          keyId: externalEventConfig.binding.keyId,
          sharedSecret: externalEventConfig.binding.sharedSecret,
          store,
        }],
        onRuntimeAvailable: () => {
          runtimeHealth.ready = true;
          runtimeHealth.blockers = Object.freeze([]);
        },
        onRuntimeUnavailable: () => {
          runtimeHealth.ready = false;
          runtimeHealth.blockers = Object.freeze([
            'Property Predator external-event runtime failed its latest projection',
          ]);
        },
      });
      propertyPredatorExternalEvents = Object.freeze({
        enabled: true,
        get ready() { return runtimeHealth.ready; },
        get blockers() { return runtimeHealth.blockers; },
        handle,
      });
      console.log('Property Predator external-event journey runtime is ready.');
    } catch {
      await Promise.allSettled([
        externalEventCommandPool?.end(),
        externalEventWebhookPool?.end(),
      ]);
      externalEventCommandPool = undefined;
      externalEventWebhookPool = undefined;
      propertyPredatorExternalEvents = Object.freeze({
        enabled: true,
        ready: false,
        blockers: Object.freeze([
          'Property Predator external-event runtime did not pass protected readiness',
        ]),
      });
      console.warn('⚠  Property Predator external-event runtime unavailable; protected readiness failed.');
    }
  } else if (externalEventConfig.enabled) {
    console.warn(`⚠  Property Predator external-event bridge unavailable: ${externalEventConfig.blockers.join('; ')}`);
  }

  const mailgunWebhookConfig = loadPropertyPredatorMailgunWebhookConfig(process.env);
  let mailgunWebhookPool:
    ReturnType<typeof createMailgunWebhookCommandDatabasePool> | undefined;
  let propertyPredatorMailgunWebhook: PropertyPredatorMailgunWebhookMount = Object.freeze({
    enabled: mailgunWebhookConfig.enabled,
    ready: false,
    blockers: mailgunWebhookConfig.blockers,
  });
  if (mailgunWebhookConfig.enabled
      && mailgunWebhookConfig.configurationReady
      && mailgunWebhookConfig.workspaceId
      && mailgunWebhookConfig.providerConnectionId
      && mailgunWebhookConfig.signingKey) {
    try {
      mailgunWebhookPool = createMailgunWebhookCommandDatabasePool(process.env);
      await assertPgMailgunWebhookIngressReady(
        mailgunWebhookPool,
        mailgunWebhookConfig.workspaceId,
        mailgunWebhookConfig.providerConnectionId,
        process.env.PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID?.trim() ?? '',
      );
      const repository = new PgMailgunWebhookRepository({
        commandPool: mailgunWebhookPool,
        workspaceId: mailgunWebhookConfig.workspaceId,
        providerConnectionId: mailgunWebhookConfig.providerConnectionId,
      });
      const ingress = new MailgunWebhookIngressService({
        repository,
        signingKey: mailgunWebhookConfig.signingKey,
      });
      propertyPredatorMailgunWebhook = Object.freeze({
        enabled: true,
        ready: true,
        blockers: Object.freeze([]),
        handle: createPropertyPredatorMailgunWebhookHandler(ingress),
      });
      console.log('Signed Mailgun delivery-evidence ingress is ready.');
    } catch {
      await mailgunWebhookPool?.end();
      mailgunWebhookPool = undefined;
      propertyPredatorMailgunWebhook = Object.freeze({
        enabled: true,
        ready: false,
        blockers: Object.freeze([
          'Mailgun webhook did not pass protected database readiness',
        ]),
      });
      console.warn('⚠  Mailgun webhook unavailable; protected readiness failed.');
    }
  } else if (mailgunWebhookConfig.enabled) {
    console.warn(`⚠  Mailgun webhook unavailable: ${mailgunWebhookConfig.blockers.join('; ')}`);
  }
  const orders = fileOrderStore(cfg.ordersFile);
  const subscriptions = fileSubscriptionStore(cfg.subscriptionsFile);
  const runtimePolicy = runtimeSafetyPolicy(cfg);
  const forceMockBuilds = runtimePolicy.forceMockBuilds;
  const maxConcurrent = runtimePolicy.maxConcurrentBuilds;
  const kickPipeline = createKick(path.join(cfg.dataDir, 'intakes'), { mockOnly: forceMockBuilds, maxConcurrent });
  // Stripe test-mode addresses are arbitrary input, not verified customers.
  // Keep every real outbound rail locked until live checkout provenance is
  // durable; this currently disables Brevo and Postmark in the sandbox.
  const allowCustomerOutbound = customerOutboundMessagingEnabled(cfg);
  const marketing = allowCustomerOutbound ? makeMarketing() : undefined;
  if (!allowCustomerOutbound && (process.env.BREVO_API_KEY?.trim() || process.env.POSTMARK_SERVER_TOKEN?.trim())) {
    console.warn('⚠  Customer outbound messaging is locked in this payment mode; configured Brevo/Postmark credentials will not be used.');
  }

  // Email a one-time account setup link on a new signup. Setup credentials are
  // never written to logs, including when Postmark is not configured.
  const postmarkToken = allowCustomerOutbound ? process.env.POSTMARK_SERVER_TOKEN?.trim() : undefined;
  // PUBLIC_BASE_URL is the separately hosted funnel/Stripe return origin. The
  // setup link must instead point at the service/domain that actually mounts /portal.
  const portalBaseUrl = process.env.PORTAL_BASE_URL?.trim() || (!cfg.production ? cfg.publicBaseUrl : undefined);
  let canonicalHost: string | undefined;
  if (cfg.production && portalBaseUrl) {
    try {
      const parsedPortalBaseUrl = new URL(portalBaseUrl);
      if (parsedPortalBaseUrl.protocol === 'https:') {
        canonicalHost = parsedPortalBaseUrl.hostname.toLowerCase();
      }
    } catch {
      canonicalHost = undefined;
    }
  }
  const canAutoProvisionPortal = portalProvisioningEnabled(Boolean(cfg.production), postmarkToken, portalBaseUrl);
  if (!canAutoProvisionPortal) {
    console.warn('⚠  Portal auto-provisioning disabled: POSTMARK_SERVER_TOKEN and PORTAL_BASE_URL are required to deliver valid one-time setup links in production.');
  }
  const onProvisioned = postmarkToken && portalBaseUrl
    ? async (r: import('../portal/provision.js').ProvisionResult): Promise<void> => {
        const setupUrl = new URL('/portal/setup', portalBaseUrl!);
        setupUrl.searchParams.set('token', r.setupToken);
        const msg = loginEmail({ to: r.email, tenantName: r.name, setupUrl: setupUrl.toString(), generated: r.generated, from: process.env.EMAIL_FROM?.trim() });
        await makePostmark(postmarkToken).send(msg);
        // Provider acceptance is useful operational evidence; the recipient and
        // provider message id are deliberately not service-log fields.
        SERVICE_TELEMETRY.emit('info', 'portal.setup_email.accepted');
      }
    : undefined;

  // Billing UI uses exactly the same readiness gate as /api/subscription. The
  // default is a non-purchasable plan preview while the platform is unfinished.
  const subscriptionBlockers = subscriptionCheckoutBlockers(cfg);
  const subscribeUrl = subscriptionBlockers.length === 0
    ? async (plan: string, email: string | null): Promise<string> => (await createSubscriptionCheckout(stripe, cfg, { plan, email: email ?? undefined })).url
    : undefined;
  if (subscriptionBlockers.length) console.warn(`⚠  Platform subscription checkout disabled: ${subscriptionBlockers.join('; ')}`);
  const manageUrl = cfg.keyMode === 'test'
    ? async (customerId: string): Promise<string> => createBillingPortalUrl(stripe, cfg, customerId)
    : undefined;
  // Enforce an active subscription before "Run this week" only if explicitly turned on.
  const billingEnforced = /^(1|true|yes)$/i.test(process.env.BILLING_ENFORCED?.trim() ?? '');

  const requirePostgresPortal = postgresPortalEnabled(process.env);
  const portalProductProfile = resolvePortalProductProfile(process.env.PORTAL_PRODUCT_PROFILE);
  let postgresPortal: PgPortalPlatform | undefined;
  let portalAbuseRuntime: PortalAbuseRuntimeConfig | undefined;
  if (requirePostgresPortal) {
    try {
      portalAbuseRuntime = loadPortalAbuseRuntimeConfig(Boolean(cfg.production), process.env);
      postgresPortal = await buildPgPortalPlatform(process.env);
      console.log('PostgreSQL portal identity and CRM contracts are current and ready.');
      if (postgresPortal.companyContent) {
        console.log('Company content catalogue and protected approval commands are ready.');
      } else {
        console.warn('⚠  Company content controls remain unavailable; the dedicated content command identity is absent or did not pass readiness.');
      }
      if (postgresPortal.companyAssets) {
        console.log('Company asset metadata and founder quarantine-only controls are ready.');
      } else {
        console.warn('⚠  Company asset controls remain unavailable; adapter/command role readiness did not pass.');
      }
      console.log('Authoritative Operator Action Centre and protected assignment/snooze commands are ready.');
    } catch (error) {
      // No legacy-cookie fallback in requested database mode. Payments may stay
      // live for liveness, but the customer portal is deliberately not mounted.
      SERVICE_TELEMETRY.emit('warn', 'portal.readiness_failed', { error });
    }
  }

  // Client portal — optional; a failure here must never stop the payments server.
  const allowDemoSeed = runtimePolicy.allowDemoSeed;
  let bundle: PortalBundle | undefined;
  let portal: PortalDeps | undefined;
  try {
    if (requirePostgresPortal && !postgresPortal) {
      throw new Error('required PostgreSQL portal services did not pass readiness');
    }
    const securePortalCookie = Boolean(cfg.production) || Boolean(portalBaseUrl?.startsWith('https://'));
    const propertyPredatorSsoComposition = postgresPortal
      ? composePropertyPredatorSso(process.env, cfg.sessionSecret, securePortalCookie)
      : { state: 'disabled' as const };
    const propertyPredatorSso = propertyPredatorSsoComposition.client;
    if (propertyPredatorSsoComposition.state === 'invalid') {
      console.warn('⚠  Property Predator SSO configuration is invalid; shared-login routes remain disabled and native Growth HQ password access remains mounted.');
    }
    if (postgresPortal) {
      if (!portalAbuseRuntime) {
        throw new Error('production portal abuse boundary did not compose');
      }
      portal = buildPostgresPortalDeps({
        sessionSecret: cfg.sessionSecret,
        secure: securePortalCookie,
        auth: postgresPortal.auth,
        abuse: postgresPortal.abuse,
        abuseHashSecret: portalAbuseRuntime.hashSecret,
        requestContext: createPortalRequestContextResolver({
          hashSecret: portalAbuseRuntime.hashSecret,
          proxyMode: portalAbuseRuntime.proxyMode,
          directClientAddress: (req) => req.socket.remoteAddress,
        }),
        propertyPredatorSso,
        crm: postgresPortal.crm,
        journeys: postgresPortal.journeys,
        operatorActions: postgresPortal.operatorActions,
        companyContent: postgresPortal.companyContent,
        companyAssets: postgresPortal.companyAssets,
        publicSocial: postgresPortal.publicSocial,
        inbox: postgresPortal.inbox,
        inboxCommands: postgresPortal.inboxCommands,
        productProfile: portalProductProfile,
      });
      console.log(`Canonical PostgreSQL client portal mounted at /portal; JSON portal stores are not composed; Property Predator SSO ${propertyPredatorSso ? 'ready' : 'disabled'}.`);
    } else {
      if (cfg.production) {
        throw new Error('production portal requires PostgreSQL mode; the legacy JSON portal is local-development only');
      }
      bundle = await buildPortalDeps({
        dataDir: cfg.dataDir,
        sessionSecret: cfg.sessionSecret,
        secure: securePortalCookie,
        demoEmail: process.env.PORTAL_DEMO_EMAIL?.trim(),
        demoPassword: process.env.PORTAL_DEMO_PASSWORD?.trim(),
        demoRunDir: process.env.PORTAL_DEMO_RUNDIR?.trim(),
        allowDemoSeed,
        onProvisioned,
        requireSetupDelivery: Boolean(cfg.production),
        subscriptions,
        subscribeUrl,
        manageUrl,
        billingEnforced,
      });
      portal = bundle.portal;
      console.log(cfg.production
        ? 'Legacy JSON client portal mounted at /portal — production demo seeding disabled.'
        : allowDemoSeed
          ? 'Legacy JSON client portal mounted at /portal — explicit development demo enabled.'
          : 'Legacy JSON client portal mounted at /portal — development demo seeding disabled.');
    }
  } catch (e) {
    if (postgresPortal) {
      await postgresPortal.close();
      postgresPortal = undefined;
    }
    SERVICE_TELEMETRY.emit('warn', 'portal.mount_failed', { error: e });
  }

  // On an accepted intake, provision that customer's portal login in the background.
  if (requirePostgresPortal && canAutoProvisionPortal) {
    console.warn('⚠  Automatic PostgreSQL onboarding remains locked pending exact runtime-role credentials/URLs, paid-checkout provenance, an operated setup-email dispatcher, edge token-log redaction and shared abuse controls.');
  }
  const onIntakeAccepted = bundle && canAutoProvisionPortal && !requirePostgresPortal
    ? (intake: Intake, order: Order): void => {
        const email = order.email;
        if (!email) return;
        void bundle!.provision({ email, name: String(intake.A1 ?? 'Your business'), intake })
          .then(() => SERVICE_TELEMETRY.emit('info', 'portal.provision.accepted'))
          .catch((error) => SERVICE_TELEMETRY.emit('warn', 'portal.provision.failed', { error }));
      }
    : undefined;

  const simulatedInbound = await composePropertyPredatorSimulatedInbound(process.env);
  if (simulatedInbound.enabled) {
    console.log(simulatedInbound.ready
      ? 'Signed non-routable simulated TEST ingress is ready.'
      : '⚠  Simulated inbound TEST ingress unavailable; protected readiness failed.');
  }

  const buildBlockers = forceMockBuilds || process.env.ANTHROPIC_API_KEY?.trim() ? [] : ['Anthropic build key is not configured'];
  const runtimeReadinessProbe = (postgresPortal || mailgunWebhookConfig.enabled
      || simulatedInbound.enabled)
    ? createCachedRuntimeReadinessProbe({
        probe: async () => {
          const blockers: string[] = [];
          if (postgresPortal) {
            try { await postgresPortal.assertReady(); }
            catch { blockers.push('Protected PostgreSQL portal runtime is unavailable'); }
          } else if (requirePostgresPortal) {
            blockers.push('Protected PostgreSQL portal runtime is unavailable');
          }
          if (mailgunWebhookConfig.enabled) {
            if (!mailgunWebhookPool || !mailgunWebhookConfig.workspaceId
                || !mailgunWebhookConfig.providerConnectionId) {
              blockers.push('Protected Mailgun webhook runtime is unavailable');
            } else {
              try {
                await assertPgMailgunWebhookIngressReady(
                  mailgunWebhookPool,
                  mailgunWebhookConfig.workspaceId,
                  mailgunWebhookConfig.providerConnectionId,
                  process.env.PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID?.trim() ?? '',
                );
              } catch {
                blockers.push('Protected Mailgun webhook runtime is unavailable');
              }
            }
          }
          if (simulatedInbound.enabled) {
            try {
              await simulatedInbound.assertReady();
            } catch {
              blockers.push('Protected simulated inbound TEST runtime is unavailable');
            }
          }
          return Object.freeze(blockers);
        },
      })
    : undefined;
  const app = createApp({
    stripe,
    cfg,
    orders,
    subscriptions,
    kickPipeline,
    buildBlockers,
    serviceReadinessBlockers,
    runtimeReadinessProbe,
    canonicalHost,
    buildMode: forceMockBuilds ? 'mock' : 'live',
    now: () => new Date().toISOString(),
    marketing,
    portal,
    portalMaxConcurrentRequests: 32,
    portalBlockers: portal
      ? undefined
      : [requirePostgresPortal
          ? 'required PostgreSQL portal services did not pass readiness'
          : 'client portal dependencies did not compose'],
    onIntakeAccepted,
    propertyPredatorExternalEvents,
    propertyPredatorMailgunWebhook,
    propertyPredatorSimulatedWhatsAppInbound: simulatedInbound.whatsapp,
    propertyPredatorSimulatedMetaDmInbound: simulatedInbound.metaDm,
  });
  const server = http.createServer((req, res) => { void app(req, res); });
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.timeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
  server.maxHeadersCount = 100;
  server.listen(cfg.port, cfg.host, () => {
    const mode = cfg.keyMode === 'live' ? 'LIVE LOCKED ⚠️' : cfg.keyMode.toUpperCase();
    console.log(`Relaunch72 payments server on ${cfg.host}:${cfg.port} — ${mode} mode`);
    // Automatic catalog writes are test-mode only. Live Stripe remains entirely
    // untouched until the durable platform is ready and the founder explicitly
    // runs the catalog setup workflow.
    if (cfg.keyMode === 'test') void ensurePrices(stripe, cfg);
    else if (cfg.keyMode === 'live') console.warn('⚠  Live Stripe catalog provisioning is locked; no products or prices were changed.');
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}; draining HTTP requests and closing database pools.`);
    try {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      await Promise.all([
        postgresPortal?.close(),
        externalEventCommandPool?.end(),
        externalEventWebhookPool?.end(),
        mailgunWebhookPool?.end(),
        simulatedInbound.close(),
      ]);
    } catch (error) {
      process.exitCode = 1;
      SERVICE_TELEMETRY.emit('error', 'server.shutdown_failed', { error });
    }
  };
  process.once('SIGINT', () => { void shutdown('SIGINT'); });
  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
}

main().catch((error) => {
  SERVICE_TELEMETRY.emit('error', 'server.fatal', { error });
  process.exit(1);
});
