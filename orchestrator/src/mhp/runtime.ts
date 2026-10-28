import type { Pool } from 'pg';
import Stripe from 'stripe';
import { loadDatabaseConfig } from '../db/config.js';
import { createDatabasePool } from '../db/pool.js';
import { assertExpectedDatabaseInstallation } from '../db/installation-identity.js';
import { PgMhpAuthService } from './auth-service.js';
import { createMhpTransactionalMailer, type MhpTransactionalMailer } from './transactional-mail.js';
import { mhpCommerceConfig } from './commerce-config.js';
import { PgMhpCommerceService } from './commerce-service.js';
import { MhpInvestorService, PgMhpMemberService } from './member-service.js';
import { InvestorMailService } from '../portal/investor-mail-service.js';
import { InvestorMailVault } from '../investor-mail/vault.js';
import { PgMhpHqService } from './hq-service.js';
import { PgMhpDeskService } from './desk-service.js';

export interface MhpRuntime {
  auth: PgMhpAuthService;
  mail: MhpTransactionalMailer;
  members: PgMhpMemberService;
  investors: MhpInvestorService;
  investorMail: InvestorMailService;
  commerce: PgMhpCommerceService;
  hq: PgMhpHqService;
  desk: PgMhpDeskService;
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
