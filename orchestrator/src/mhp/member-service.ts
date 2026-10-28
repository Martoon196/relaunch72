import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { InvestorError, InvestorService, investorUuid, type InvestorProgramme } from '../portal/investor-service.js';
import type { PortalCrmRequestIdentity } from '../portal/crm-service.js';
import type { PublicInvestorSite } from '../portal/investor-site.js';

export interface MhpMemberAccess {
  userId: string;
  workspaceId: string;
  isAdmin: boolean;
  crm: boolean;
  enquirySite: boolean;
  emailWorkflow: boolean;
  emailWritable: boolean;
  leadrelay: boolean;
  readOnly: boolean;
  endsAt: string | null;
}
export type MhpMemberRouteDecision = { allowed: true } | { allowed: false; status: 403 | 404; message: string };
const hash = (value: string): Buffer => createHash('sha256').update(value).digest();
const validOpaqueToken = /^[A-Za-z0-9_-]{43}$/;
const uuid = '[0-9a-fA-F-]{36}';
const crmRoute = new RegExp(`^/portal/crm(?:/(?:contacts(?:/${uuid})?|leads|opportunities(?:/${uuid}/stage)?|tasks(?:/${uuid}/complete)?))?$`);

/** This allowlist is applied before a provider mount or shared portal handler. */
export function authorizeMhpMemberRoute(access: MhpMemberAccess, request: { method: string; path: string }): MhpMemberRouteDecision {
  const { path, method } = request;
  const deny = (message: string, status: 403 | 404 = 403): MhpMemberRouteDecision => ({ allowed: false, status, message });
  if ((path === '/portal/logout' && method === 'POST')
      || path === '/app/account' || path.startsWith('/app/account/')) return { allowed: true };
  if (!['GET', 'HEAD', 'POST'].includes(method)) return deny('Use the controls in Your Desk.', 404);
  const isLeadRelay = path === '/portal/leadrelay' || path.startsWith('/portal/leadrelay/')
    || path === '/portal/api/leadrelay' || path.startsWith('/portal/api/leadrelay/');
  const isEmail = path === '/portal/investors/email' || path.startsWith('/portal/investors/email/')
    || path === '/portal/investors/mail' || path.startsWith('/portal/investors/mail/');
  if (isLeadRelay) {
    return access.crm && access.leadrelay && !access.readOnly
      ? { allowed: true } : deny('Your AI team requires active mentoring or partnership access.');
  }
  if (!access.crm) return deny('Your account is available. Your Desk requires Deal Desk, course or membership access.');
  if (access.readOnly && ((method !== 'GET' && method !== 'HEAD') || path === '/portal/investors/mail/callback')) return deny('Your Desk is read-only under your current membership.');
  if (isEmail) {
    if (!access.emailWorkflow) return deny('Email workflow is included with mentoring and partnership access.');
    if (!access.emailWritable && (method === 'POST' || path === '/portal/investors/mail/callback')) return deny('Your saved conversations are read-only during the email refund grace period.');
    return { allowed: true };
  }
  if ((path === '/portal/investors/create' || path === '/portal/investors/access') && !access.isAdmin) return deny('Programme administration is required.');
  if (path === '/portal/investors/site' && !access.enquirySite) return deny('An active enquiry-site entitlement is required.');
  if (path === '/portal' || path === '/portal/investors' || path === '/portal/investors/client.js'
      || /^\/portal\/investors\/(branding|requirements|site|site-preview|switch|create|access)$/.test(path)
      || crmRoute.test(path)) return { allowed: true };
  return deny('This page is not part of your Martin Howard Property workspace.', 404);
}

export class PgMhpMemberService {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}
  async snapshot(sessionToken: string): Promise<MhpMemberAccess> {
    if (!validOpaqueToken.test(sessionToken)) throw new InvestorError(403, 'Sign in to Martin Howard Property again.');
    const result = await this.pool.query<{ access: MhpMemberAccess }>(
      'SELECT app_private.mhp_member_snapshot($1) AS access', [hash(sessionToken)],
    );
    const access = result.rows[0]?.access;
    if (result.rows.length !== 1 || !access) throw new InvestorError(403, 'Your membership could not be verified.');
    investorUuid(access.userId); investorUuid(access.workspaceId);
    for (const field of ['isAdmin', 'crm', 'enquirySite', 'emailWorkflow', 'emailWritable', 'leadrelay', 'readOnly'] as const) {
      if (typeof access[field] !== 'boolean') throw new InvestorError(503, 'Membership information is temporarily unavailable.');
    }
    if (access.endsAt !== null && (typeof access.endsAt !== 'string' || !Number.isFinite(Date.parse(access.endsAt)))) {
      throw new InvestorError(503, 'Membership information is temporarily unavailable.');
    }
    return Object.freeze({ ...access });
  }
}

/** Reuse the existing Investor workflow, with MHP-scoped programme/public-site commands. */
export class MhpInvestorService extends InvestorService {
  constructor(private readonly mhpReadPool: Pick<Pool, 'query' | 'connect'>,
    private readonly mhpIdentityPool: Pick<Pool, 'query'>,
    commandPool: Pick<Pool, 'connect'>) {
    super(mhpReadPool, mhpIdentityPool, commandPool);
  }
  override async snapshot(identity: PortalCrmRequestIdentity): Promise<InvestorProgramme> {
    const result = await this.mhpReadPool.query<{ snapshot: InvestorProgramme }>(
      'SELECT app_private.mhp_programme_snapshot($1) AS snapshot', [hash(identity.sessionToken)],
    );
    if (result.rows.length !== 1 || !result.rows[0]?.snapshot) throw new InvestorError(503, 'Your Desk could not load.');
    return result.rows[0].snapshot;
  }
  override async create(identity: PortalCrmRequestIdentity, form: Record<string, string>): Promise<string> {
    const email = (form.ownerEmail ?? '').trim().toLowerCase();
    const brand = (form.brandName ?? '').trim(), name = (form.ownerName ?? '').trim();
    if (!['test', 'mentee'].includes(form.kind ?? '') || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(email)
      || email.length > 320 || brand.length < 1 || brand.length > 100 || name.length < 1 || name.length > 200
      || /[\u0000-\u001f\u007f]/.test(brand + name)) throw new InvestorError(400, 'Check the business and owner details.');
    const data = { key: investorUuid(form.commandKey ?? ''), brand, name, email, test: form.kind === 'test' };
    const result = await this.mhpIdentityPool.query<{ id: string }>(
      'SELECT app_private.create_mhp_investor_business($1,$2,$3,$4,$5,$6,$7) AS id',
      [hash(identity.sessionToken), data.key, hash(JSON.stringify(data)), brand, name, email, data.test],
    );
    if (!result.rows[0]?.id) throw new InvestorError(503, 'Business creation was not confirmed.');
    return investorUuid(result.rows[0].id);
  }
  override async access(identity: PortalCrmRequestIdentity, form: Record<string, string>): Promise<string | null> {
    const state = form.state, tier = form.entitlementTier ?? 'course';
    const reference = (form.paymentReference ?? '').trim();
    if (!['active', 'suspended'].includes(state ?? '') || !['course', 'mentoring', 'partnership'].includes(tier)
      || (state === 'active' && (form.paymentConfirmed !== 'yes' || reference.length < 1 || reference.length > 200))) {
      throw new InvestorError(400, 'Confirm the payment, membership tier and access change.');
    }
    if (!/^\d+$/.test(form.version ?? '') || !Number.isSafeInteger(Number(form.version))) throw new InvestorError(400, 'Refresh the business before saving.');
    await this.mhpIdentityPool.query('SELECT app_private.set_mhp_investor_access($1,$2,$3,$4,$5,$6)',
      [hash(identity.sessionToken), investorUuid(form.workspaceId ?? ''), Number(form.version), state, reference, tier]);
    // MHP uses its own verified-email sign-in; never mint a PP account setup URL.
    return null;
  }
  override async publicSite(slug: string): Promise<PublicInvestorSite | null> {
    const result = await this.mhpReadPool.query<{ site: PublicInvestorSite | null }>(
      'SELECT app_private.public_mhp_investor_site($1) AS site', [slug],
    );
    return result.rows[0]?.site ?? null;
  }
  override async captureSiteEnquiry(slug: string, nonce: string, name: string, email: string, message: string): Promise<void> {
    const cleanName = name.trim(), cleanEmail = email.trim().toLowerCase(), cleanMessage = message.trim();
    if (!cleanName || cleanName.length > 200 || !cleanMessage || cleanMessage.length > 4000
      || cleanEmail.length > 254 || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(cleanEmail)) {
      throw new InvestorError(400, 'Check your enquiry details.');
    }
    await this.mhpIdentityPool.query('SELECT app_private.capture_mhp_investor_site_enquiry($1,$2,$3,$4,$5)',
      [slug, hash(nonce), cleanName, cleanEmail, cleanMessage]);
  }
}
