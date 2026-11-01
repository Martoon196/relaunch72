import type { Pool } from 'pg';
import Stripe from 'stripe';
import { loadDatabaseConfig } from '../db/config.js';
import { createDatabasePool } from '../db/pool.js';
import { assertExpectedDatabaseInstallation } from '../db/installation-identity.js';
import { PgMhpAuthService } from './auth-service.js';
import { createMhpTransactionalMailer, type MhpTransactionalMailer } from './transactional-mail.js';
import { mhpCommerceConfig } from './commerce-config.js';
import { MhpCommerceError, PgMhpCommerceService } from './commerce-service.js';
import { MhpInvestorService, PgMhpMemberService } from './member-service.js';
import { InvestorMailService } from '../portal/investor-mail-service.js';
import { InvestorMailVault } from '../investor-mail/vault.js';
import { PgMhpHqService } from './hq-service.js';
import { PgMhpDeskService } from './desk-service.js';
import { PgMhpGrowthService, mhpWebinarConfig } from './growth-service.js';
import { PgMhpLearningService } from './learning-service.js';
import { PgMhpMarketingWorkspaceService } from './marketing-workspace-service.js';
import { createMhpMarketingSender, mhpMarketingConfig, type MhpMarketingConfig } from './marketing-mail.js';
import { CrmCommandService, createPgCrmTransactionRunner } from '../crm-pg/index.js';
import { MhpWebinarLeadService, PgMhpWebinarLeadReader } from './webinar-leads-service.js';
import { createMhpOwnerEmailService, mhpOwnerEmailContentRunner, mhpOwnerEmailTestConfig, type MhpOwnerEmailService } from './owner-email-service.js';
import { PgMhpOwnerEmailDispatch } from './owner-email-dispatch.js';
import { createMhpSequenceService, PgMhpSequenceRepository, type MhpSequenceService } from './followup-sequence-service.js';
import { PgMhpSequenceDispatch } from './followup-sequence-dispatch.js';
import { CompanyContentService } from '../company-content-pg/index.js';
import { LocalFlowMessages } from '../followup-sequences/messages.js';
import { FlowLocalStore } from '../followup-sequences/local-store.js';
import { parseMhpOwnerEmailBrand } from './owner-email-content.js';
import { createPgPortalSmsBindingService } from '../portal/sms-binding-pg-service.js';
import { createPgTwilioSmsLiveCommandService } from '../sms-live-pg/command-service.js';
import { assertMhpEventSmsBoundaryReady, assertSmsCommandBoundaryReady } from '../sms-live-pg/readiness.js';
import { MhpEventPhoneOwner, PgMhpEventPhonePublic } from './event-phone-service.js';
import { MhpOwnedSmsService, PgMhpOwnedSmsRepository, mhpOwnedSmsConfig, assertMhpOwnedSmsBoundaryReady, refreshMhpOwnedSmsObservation } from './owned-sms-service.js';
import { MHP_MARKETING_WORKSPACE_ID } from './marketing-workspace-service.js';

export interface MhpRuntime {
  auth: PgMhpAuthService;
  mail: MhpTransactionalMailer;
  members: PgMhpMemberService;
  investors: MhpInvestorService;
  investorMail: InvestorMailService;
  commerce: PgMhpCommerceService;
  hq: PgMhpHqService;
  desk: PgMhpDeskService;
  growth: PgMhpGrowthService;
  learning: PgMhpLearningService;
  marketingWorkspace: PgMhpMarketingWorkspaceService;
  webinarLeads: MhpWebinarLeadService;
  ownerEmail?: MhpOwnerEmailService;
  ownerEmailDispatch?: PgMhpOwnerEmailDispatch;
  sequences?: MhpSequenceService;
  sequenceDispatch?: PgMhpSequenceDispatch;
  ownedSms?: MhpOwnedSmsService;
  /** MHP009B: public webinar text reminders (off unless MHP_EVENT_PHONE_PUBLIC=enabled). */
  eventPhone?: { reminders?: PgMhpEventPhonePublic; owner?: MhpEventPhoneOwner; campaign: string };
  marketing: MhpMarketingConfig | null;
  readiness(): Promise<readonly string[]>;
}

export function mhpEnabled(env: NodeJS.ProcessEnv): boolean {
  if (!env.MHP_ENABLED || env.MHP_ENABLED === 'false') return false;
  if (env.MHP_ENABLED !== 'true') throw new Error('MHP_ENABLED must be true or false');
  return true;
}

/** Use the same canonical DB with isolated function grants and per-brand providers. */
export async function buildMhpRuntime(input: {
  env: NodeJS.ProcessEnv;
  webPool: Pool;
  identityPool: Pool;
  commandPool: Pool;
  contentAdapterPool?: Pool;
  contentCommandPool?: Pool;
  registerPool(pool: Pool): void;
}): Promise<MhpRuntime | undefined> {
  const { env, webPool, identityPool, commandPool } = input;
  if (!mhpEnabled(env)) return undefined;
  const config = mhpCommerceConfig(env);
  let webhookPool: Pool | null = null;
  if (config) {
    if (!env.DATABASE_WEBHOOK_URL?.trim()) throw new Error('MHP webhook identity is missing');
    const database = loadDatabaseConfig('webhook', env);
    if (database.sourceEnv !== 'DATABASE_WEBHOOK_URL' || database.expectedDatabaseUser !== 'r72_webhook') {
      throw new Error('MHP webhook identity is invalid');
    }
    webhookPool = createDatabasePool(database);
    input.registerPool(webhookPool);
    await webhookPool.query('/* mhp.webhook-role-readiness */ SELECT 1');
    const installationId = env.PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID?.trim();
    if (installationId) await assertExpectedDatabaseInstallation(webhookPool, installationId);
  }
  const stripe = config ? new Stripe(config.secretKey, { maxNetworkRetries: 1, timeout: 8_000 }) : null;
  const commerce = new PgMhpCommerceService(webPool, identityPool, webhookPool, stripe, config);
  const mail = createMhpTransactionalMailer(env);
  const marketing = mhpMarketingConfig(env);
  const webinar = mhpWebinarConfig(env);
  const marketingWorkspace = new PgMhpMarketingWorkspaceService(webPool, identityPool);
  const ownerEmail = input.contentAdapterPool && input.contentCommandPool ? createMhpOwnerEmailService({
    web: webPool, identity: identityPool, adapter: input.contentAdapterPool, approvals: input.contentCommandPool,
    marketingWorkspace, campaign: webinar.campaign, env, marketing,
    sender: marketing ? createMhpMarketingSender(marketing, env.SESSION_SECRET?.trim() ?? '') : undefined,
  }) : undefined;
  console.info(JSON.stringify({ event: 'mhp.owner-email.readiness', editorReady: Boolean(ownerEmail), ...mhpOwnerEmailTestConfig(env, marketing).status }));
  const sequences = ownerEmail && input.contentAdapterPool && input.contentCommandPool ? createMhpSequenceService({
    web: webPool, identity: identityPool, adapter: input.contentAdapterPool, approvals: input.contentCommandPool,
    marketingWorkspace, emails: ownerEmail, campaign: webinar.campaign,
  }) : undefined;
  console.info(JSON.stringify({ event: 'mhp.sequence.readiness', editorReady: Boolean(sequences), emailReady: sequences?.readiness.email ?? false,
    smsReady: false, whatsappReady: false, automaticEntryAvailable: Boolean(sequences) }));
  let ownedSms: MhpOwnedSmsService | undefined;
  let eventPhoneOwner: MhpEventPhoneOwner | undefined;
  const smsPilot = mhpOwnedSmsConfig(env);
  if (smsPilot.enabled && sequences && input.contentAdapterPool && input.contentCommandPool) {
    let smsPool: Pool | undefined;
    const blockers = [...smsPilot.blockers];
    if (smsPilot.config && env.DATABASE_SMS_COMMAND_URL?.trim()) {
      try {
        const database = loadDatabaseConfig('smsCommand', env);
        if (database.sourceEnv !== 'DATABASE_SMS_COMMAND_URL' || database.expectedDatabaseUser !== 'r72_sms_command') throw new Error('MHP SMS identity is invalid');
        smsPool = createDatabasePool(database);
        if (env.PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID?.trim()) await assertExpectedDatabaseInstallation(smsPool, env.PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID.trim());
        await assertSmsCommandBoundaryReady(smsPool);
        await assertMhpOwnedSmsBoundaryReady(smsPool);
        input.registerPool(smsPool);
      } catch { await smsPool?.end().catch(() => undefined); smsPool = undefined; blockers.push('The MHP SMS command connection is unavailable.'); }
    } else if (!env.DATABASE_SMS_COMMAND_URL?.trim()) blockers.push('The MHP SMS command connection needs configuring.');
    const contentReader = mhpOwnerEmailContentRunner(webPool), adapterRunner = mhpOwnerEmailContentRunner(input.contentAdapterPool);
    const sourceRepository = new PgMhpSequenceRepository(webPool, identityPool);
    const smsAdapter = new CompanyContentService({ transactionRunner: adapterRunner });
    const messages = new LocalFlowMessages({ brand: 'mhp', authorize: (identity, requestId) => sequences.contentContext(identity, requestId),
      brandSnapshot: async (_context, identity) => parseMhpOwnerEmailBrand((await sourceRepository.snapshot(identity, webinar.campaign)).brand),
      reader: new CompanyContentService({ transactionRunner: contentReader }), adapter: smsAdapter,
      approvals: new CompanyContentService({ transactionRunner: mhpOwnerEmailContentRunner(input.contentCommandPool) }),
      transactions: adapterRunner, local: new FlowLocalStore(contentReader) });
    const config = smsPilot.config;
    // MHP009B owner review/schedule shares the exact 009A owner pool and local SMS sources.
    if (env.MHP_EVENT_PHONE_OWNER?.trim() === 'enabled' && smsPool && smsPilot.config && /^webinar-[0-9]{4}-[0-9]{2}-[0-9]{2}$/u.test(webinar.campaign)) {
      try {
        await assertMhpEventSmsBoundaryReady(smsPool, 'r72_sms_command');
        const boundSmsPool = smsPool;
        eventPhoneOwner = new MhpEventPhoneOwner({ marketingWorkspace, authorize: (identity, requestId) => sequences.contentContext(identity, requestId),
          smsPool: boundSmsPool, reader: new CompanyContentService({ transactionRunner: contentReader }), adapter: smsAdapter, texts: messages,
          approvals: new CompanyContentService({ transactionRunner: mhpOwnerEmailContentRunner(input.contentCommandPool) }), adapterTransactions: adapterRunner,
          brand: async identity => (await sourceRepository.snapshot(identity, webinar.campaign)).brand,
          observeSource: async (identity, requestId, context, itemId, versionId, commandId, now) => {
            const detail = await messages.review(identity, requestId, 'sms', itemId, versionId);
            if (detail.review.approvalStatus !== 'approved' || detail.review.approvalStale) throw new MhpCommerceError(409, 'Approve the reminder text before scheduling.');
            await refreshMhpOwnedSmsObservation({ context, detail, commandId: `event-${commandId}`, now, transactions: adapterRunner, adapter: smsAdapter });
          },
          campaign: webinar.campaign, bindingId: smsPilot.config.bindingId });
      } catch { eventPhoneOwner = undefined; }
    }
    ownedSms = new MhpOwnedSmsService({ marketingWorkspace, authorize: (identity, requestId) => sequences.contentContext(identity, requestId),
      config, blockers, messages, observe: (context, detail, commandId, now) => refreshMhpOwnedSmsObservation({ context, detail, commandId, now, transactions: adapterRunner, adapter: smsAdapter }),
      ...(smsPool && config ? {
        repository: new PgMhpOwnedSmsRepository(smsPool), binding: createPgPortalSmsBindingService({ webPool, smsCommandPool: smsPool,
          commandService: createPgTwilioSmsLiveCommandService({ commandPool: smsPool, workspaceId: MHP_MARKETING_WORKSPACE_ID, providerConnectionId: config.connectionId }),
          workspaceId: MHP_MARKETING_WORKSPACE_ID, verificationPhone: config.phone, verificationContactId: config.contactId, verificationOwnerUserId: config.ownerUserId }),
      } : {}) });
  }
  const transactions = createPgCrmTransactionRunner(commandPool);
  const rawVaultKey = env.INVESTOR_MAIL_ENCRYPTION_KEY?.trim();
  const vaultKey = rawVaultKey ? Buffer.from(rawVaultKey, 'base64') : undefined;
  if (vaultKey && (vaultKey.length !== 32 || vaultKey.toString('base64') !== rawVaultKey)) {
    throw new Error('Investor mailbox encryption key is invalid');
  }
  const oauthApp = (prefix: string) => env[`${prefix}_CLIENT_ID`] && env[`${prefix}_CLIENT_SECRET`]
    ? { clientId: env[`${prefix}_CLIENT_ID`]!, clientSecret: env[`${prefix}_CLIENT_SECRET`]! } : undefined;
  return {
    auth: new PgMhpAuthService({ readPool: webPool, commandPool: identityPool }),
    mail,
    members: new PgMhpMemberService(webPool),
    investors: new MhpInvestorService(webPool, identityPool, commandPool),
    investorMail: new InvestorMailService(webPool, identityPool, vaultKey ? new InvestorMailVault(vaultKey) : undefined, {
      redirectUri: 'https://app.martinhowardproperty.co.uk/portal/investors/mail/callback',
      google: oauthApp('MHP_INVESTOR_GOOGLE'), microsoft: oauthApp('MHP_INVESTOR_MICROSOFT'),
    }, env.MHP_INVESTOR_MAIL_DELIVERY_ENABLED === 'true'),
    commerce,
    hq: new PgMhpHqService(webPool, identityPool),
    desk: new PgMhpDeskService(webPool, identityPool),
    growth: new PgMhpGrowthService(webPool, identityPool, webinar),
    learning: new PgMhpLearningService(webPool, identityPool),
    marketingWorkspace,
    ownerEmail,
    ownerEmailDispatch: new PgMhpOwnerEmailDispatch(identityPool),
    sequences,
    ownedSms,
    eventPhone: (() => {
      const sender = smsPilot.config?.senderNumber;
      const reminders = env.MHP_EVENT_PHONE_PUBLIC?.trim() === 'enabled' && sender && mail.sendEventPhoneLink
        ? new PgMhpEventPhonePublic(identityPool, { configured: mail.configured, sendEventPhoneLink: mail.sendEventPhoneLink.bind(mail) }, sender) : undefined;
      return reminders || eventPhoneOwner ? { ...(reminders ? { reminders } : {}), ...(eventPhoneOwner ? { owner: eventPhoneOwner } : {}), campaign: webinar.campaign } : undefined;
    })(),
    sequenceDispatch: sequences ? new PgMhpSequenceDispatch(identityPool) : undefined,
    webinarLeads: new MhpWebinarLeadService({ marketingWorkspace, reader: new PgMhpWebinarLeadReader(webPool),
      transactions, commands: new CrmCommandService({ transactionRunner: transactions }),
      campaign: webinar.campaign, cursorSecret: env.SESSION_SECRET?.trim() ?? '' }),
    marketing,
    async readiness(): Promise<readonly string[]> {
      const blockers: string[] = [];
      if (!mail.configured) blockers.push('MHP transactional email is not configured');
      try {
        const result = await webPool.query<{ ready: boolean }>(
          '/* mhp.domain-readiness */ SELECT app_private.mhp_domain_ready() AS ready',
        );
        if (result.rows[0]?.ready !== true) blockers.push('MHP app domain has not been verified');
        const identities = await identityPool.query<{ ready: boolean }>(
          `SELECT has_function_privilege(current_user,'app_private.mhp_login_credential(text)','EXECUTE') AS ready`,
        );
        if (identities.rows[0]?.ready !== true) blockers.push('MHP identity boundary is unavailable');
      } catch { blockers.push('MHP database boundaries are unavailable'); }
      if (config) {
        try { await commerce.verifyAccount(); }
        catch { blockers.push('MHP Stripe account has not passed its identity check'); }
      }
      return Object.freeze(blockers);
    },
  };
}
