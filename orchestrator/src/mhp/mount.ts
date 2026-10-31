import type { IncomingMessage, ServerResponse } from 'node:http';
import { handlePortal, type PostgresPortalDeps } from '../portal/router.js';
import { portalCsrfToken, verifyPortalCsrf } from '../portal/session.js';
import { parseCookies } from '../server/admin/session.js';
import { principalAbuseAdmission, sourceAbuseAdmission } from '../portal/abuse.js';
import { handleInvestorPublicSite, INVESTOR_SITES_ROUTE } from '../portal/investor-site.js';
import { MHP_AUTH_HOST, MHP_AUTH_ORIGIN, MHP_SESSION_COOKIE } from './auth-service.js';
import { MhpCommerceError, type PgMhpCommerceService } from './commerce-service.js';
import { accountPage } from './account-view.js';
import { hqPage } from './hq-view.js';
import type { PgMhpHqService } from './hq-service.js';
import type { MhpTransactionalMailer } from './transactional-mail.js';
import type { PgMhpDeskService } from './desk-service.js';
import { handleMhpDesk } from './desk-router.js';
import { handleMhpGrowth, type MhpGrowthRouterDependencies } from './growth-router.js';
import { handleMhpMarketingWorkspace, type MhpMarketingWorkspaceDependencies } from './marketing-workspace-router.js';
import { handleMhpOwnerEmail } from './owner-email-router.js';
import { handleMhpOwnedSms } from './owned-sms-router.js';
import type { MhpOwnedSmsService } from './owned-sms-service.js';
import type { MhpOwnerEmailService } from './owner-email-service.js';
import { handleMhpSequence } from './followup-sequence-router.js';
import type { MhpSequenceService } from './followup-sequence-service.js';
import { handleMhpEventSmsOwner, handleMhpEventSmsPublic } from './event-sms-router.js';
import { handleMhpOwnedWhatsApp } from './owned-whatsapp-router.js';
import type { MhpOwnedWhatsAppService } from './owned-whatsapp-service.js';
import type { MhpEventSmsOwnerService, MhpEventSmsPublic } from './event-sms-service.js';

interface MhpMountDependencies {
  portal: PostgresPortalDeps;
  authMount: { handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> };
  commerce: Pick<PgMhpCommerceService, 'snapshot' | 'refund' | 'billingPortal' | 'webhook' | 'billingEnabled'> & Partial<Pick<PgMhpCommerceService, 'creditSnapshot' | 'courseCheckout'>>;
  desk?: Pick<PgMhpDeskService, 'snapshot' | 'save' | 'archive' | 'submitVerdict' | 'queue' | 'review'>;
  hq: Pick<PgMhpHqService, 'snapshot' | 'grant' | 'isOwner'>;
  mail?: Pick<MhpTransactionalMailer, 'sendAccessInvite' | 'configured'>;
  growth?: Omit<MhpGrowthRouterDependencies, 'portal'>;
  marketingWorkspace?: MhpMarketingWorkspaceDependencies['marketingWorkspace'];
  webinarLeads?: MhpMarketingWorkspaceDependencies['webinarLeads'];
  ownerEmail?: Pick<MhpOwnerEmailService, 'snapshot' | 'review' | 'preview' | 'save' | 'publish' | 'queue' | 'test'>;
  ownedSms?: Pick<MhpOwnedSmsService, 'snapshot' | 'review' | 'save' | 'bind' | 'requestCode' | 'confirmCode' | 'send'>;
  sequences?: Pick<MhpSequenceService, 'snapshot' | 'review' | 'preview' | 'save' | 'publish' | 'command'> & Partial<Pick<MhpSequenceService, 'entryCommand' | 'message' | 'simulate'>>;
  eventSms?: { optins: MhpEventSmsPublic; owner?: Pick<MhpEventSmsOwnerService, 'snapshot' | 'send'> };
  ownedWhatsApp?: Pick<MhpOwnedWhatsAppService, 'snapshot' | 'connect' | 'recordTemplate' | 'send'>;
  readiness(): Promise<readonly string[]>;
}

function respond(res: ServerResponse, status: number, body: string, html = false): void {
  res.writeHead(status, {
    'content-type': html ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)), 'cache-control': 'no-store',
    'referrer-policy': html ? 'same-origin' : 'no-referrer', 'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  });
  res.end(body);
}
function redirect(res: ServerResponse, location: string): void {
  res.writeHead(303, { location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }); res.end();
}
async function body(req: IncomingMessage, maximum: number): Promise<Buffer> {
  if (Number(req.headers['content-length'] ?? 0) > maximum) throw new MhpCommerceError(413, 'Request is too large.');
  const parts: Buffer[] = []; let length = 0;
  for await (const raw of req) {
    const part = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    length += part.length;
    if (length > maximum) throw new MhpCommerceError(413, 'Request is too large.');
    parts.push(part);
  }
  return Buffer.concat(parts, length);
}
function portalPath(path: string): boolean {
  return path === '/portal' || path === '/portal/appearance.js' || path === '/portal/mhp-crm.js'
    || path === '/portal/crm' || path.startsWith('/portal/crm/')
    || path === '/portal/investors' || path.startsWith('/portal/investors/')
    || path === '/portal/leadrelay' || path.startsWith('/portal/leadrelay/')
    || path === '/portal/api/leadrelay' || path.startsWith('/portal/api/leadrelay/');
}

/** Each MHP route terminates here; legacy PP marketing/payment routes are unreachable. */
export function createMhpMount(deps: MhpMountDependencies) {
  const { portal, commerce } = deps;
  return {
    hostname: MHP_AUTH_HOST as typeof MHP_AUTH_HOST,
    readiness: deps.readiness,
    async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
      const host = String(req.headers.host ?? '').toLowerCase();
      if (host !== MHP_AUTH_HOST && host !== `${MHP_AUTH_HOST}:443`) {
        respond(res, 421, 'Misdirected request.'); return;
      }
      const url = new URL(req.url ?? '/', MHP_AUTH_ORIGIN);
      const path = url.pathname.replace(/\/+$/, '') || '/';
      if (await deps.authMount.handle(req, res, url)) return;
      if (deps.eventSms && await handleMhpEventSmsPublic(req, res, url, { portal, optins: deps.eventSms.optins })) return;
      if (deps.eventSms?.owner && await handleMhpEventSmsOwner(req, res, url, { portal, owner: deps.eventSms.owner })) return;
      if (deps.ownedWhatsApp && await handleMhpOwnedWhatsApp(req, res, url, { portal, whatsapp: deps.ownedWhatsApp })) return;
      if (deps.ownedSms && await handleMhpOwnedSms(req, res, url, { portal, sms: deps.ownedSms })) return;
      if (deps.sequences && await handleMhpSequence(req, res, url, { portal, sequences: deps.sequences })) return;
      if (deps.ownerEmail && await handleMhpOwnerEmail(req, res, url, { portal, emails: deps.ownerEmail })) return;
      if (deps.marketingWorkspace && await handleMhpMarketingWorkspace(req, res, url,
        { portal, marketingWorkspace: deps.marketingWorkspace, webinarLeads: deps.webinarLeads, emailEditorEnabled: Boolean(deps.ownerEmail), sequenceEditorEnabled: Boolean(deps.sequences), ownedSmsEnabled: Boolean(deps.ownedSms), eventSmsEnabled: Boolean(deps.eventSms?.owner), whatsappEnabled: Boolean(deps.ownedWhatsApp) })) return;
      if (deps.growth && await handleMhpGrowth(req, res, url, { portal, ...deps.growth })) return;
      if (deps.desk && commerce.creditSnapshot && commerce.courseCheckout && await handleMhpDesk(req, res, url, {
        portal, desk: deps.desk, commerce: { billingEnabled: commerce.billingEnabled,
          creditSnapshot: commerce.creditSnapshot.bind(commerce), courseCheckout: commerce.courseCheckout.bind(commerce) },
      })) return;
      if (path === '/api/stripe/webhook') {
        if (req.method !== 'POST') { respond(res, 405, 'Use POST.'); return; }
        try {
          const signature = req.headers['stripe-signature'];
          if (typeof signature !== 'string') throw new MhpCommerceError(400, 'Missing Stripe signature.');
          await commerce.webhook(await body(req, 256 * 1024), signature);
          respond(res, 200, 'Received.');
        } catch (error) {
          respond(res, error instanceof MhpCommerceError ? error.status : 503,
            error instanceof MhpCommerceError ? error.message : 'Payment receipt processing is temporarily unavailable.');
        }
        return;
      }
      if (path.startsWith(`${INVESTOR_SITES_ROUTE}/`) && portal.investors) {
        await handleInvestorPublicSite(req, res, portal.investors, portal.sessionSecret); return;
      }
      if (path === '/' && req.method === 'GET') { redirect(res, '/portal'); return; }
      if (path === '/app/account' || path === '/app/account/refund' || path === '/app/account/billing' || path === '/hq' || path === '/hq/grant' || path === '/hq/invite') {
        const isHq = path === '/hq' || path === '/hq/grant' || path === '/hq/invite';
        const leases: Buffer[] = [];
        let outcome: 'success' | 'service_error' = 'success';
        try {
          const context = portal.requestContext?.(req);
          if (!context || !portal.abuse || !portal.abuseHashSecret) throw new MhpCommerceError(503, 'Account access is temporarily unavailable.');
          const now = portal.now?.() ?? Date.now();
          const routeClass = req.method === 'GET' ? 'read.page' : 'command';
          const source = sourceAbuseAdmission(context, routeClass, now);
          if (!source) throw new MhpCommerceError(503, 'Account access is temporarily unavailable.');
          const reserve = async (admission: typeof source): Promise<void> => {
            const decision = await portal.abuse!.admit(admission!);
            if (!decision.allowed) throw new MhpCommerceError(429, 'Too many requests. Please try again shortly.');
            if (decision.leaseHash) leases.push(decision.leaseHash);
          };
          await reserve(source);
          const token = parseCookies(req.headers.cookie)[MHP_SESSION_COOKIE] ?? '';
          const identity = token ? await portal.auth.resolve(token, now) : null;
          if (!identity) { redirect(res, '/portal/login'); return; }
          await reserve(principalAbuseAdmission(context, routeClass, portal.abuseHashSecret, identity, now));
          if (isHq) {
            if (req.method === 'GET' && path === '/hq') {
              const search = url.searchParams.get('q') ?? '';
              respond(res, 200, hqPage({ snapshot: await deps.hq.snapshot(token, search), search,
                csrf: portalCsrfToken(portal.sessionSecret, token), result: url.searchParams.get('result') ?? '' }), true);
              return;
            }
            if (req.method !== 'POST' || (path !== '/hq/grant' && path !== '/hq/invite')) throw new MhpCommerceError(405, 'Use the controls in HQ.');
            if (req.headers.origin !== MHP_AUTH_ORIGIN) throw new MhpCommerceError(403, 'Refresh HQ before continuing.');
            if (!/^application\/x-www-form-urlencoded(?:;|$)/i.test(String(req.headers['content-type'] ?? ''))) throw new MhpCommerceError(415, 'Use the grant access form.');
            const fields = new URLSearchParams((await body(req, 12_288)).toString('utf8'));
            const allowedFields = path === '/hq/grant' ? ['csrf', 'commandId', 'targetEmail', 'targetName', 'productId', 'endsAt', 'note'] : ['csrf', 'grantId', 'targetEmail'];
            if ([...fields.keys()].some(key => !allowedFields.includes(key) || fields.getAll(key).length !== 1)
                || !verifyPortalCsrf(portal.sessionSecret, token, fields.get('csrf') ?? '')) throw new MhpCommerceError(403, 'Refresh HQ before continuing.');
            if (path === '/hq/invite') {
              const recipient = (fields.get('targetEmail') ?? '').trim().toLowerCase();
              const grantId = fields.get('grantId') ?? '';
              if (!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(recipient) || !/^[0-9a-f-]{36}$/i.test(grantId)) throw new MhpCommerceError(400, 'Choose a saved access grant.');
              const grant = (await deps.hq.snapshot(token, recipient)).grants.find(item => item.id === grantId && item.email === recipient);
              if (!grant || (grant.endsAt && Date.parse(grant.endsAt) <= now)) throw new MhpCommerceError(404, 'This access grant is no longer available.');
              if (!deps.mail?.configured) { redirect(res, '/hq?result=invite-failed'); return; }
              try { await deps.mail.sendAccessInvite(recipient, grant.name || recipient.split('@')[0]!, grant.productName); }
              catch { redirect(res, '/hq?result=invite-failed'); return; }
              redirect(res, '/hq?result=invite-sent'); return;
            }
            const grantId = await deps.hq.grant(token, Object.fromEntries(fields), now);
            const recipient = (fields.get('targetEmail') ?? '').trim().toLowerCase();
            let invited = false;
            if (deps.mail?.configured) {
              try {
                const granted = (await deps.hq.snapshot(token, recipient)).grants.find(grant => grant.id === grantId);
                await deps.mail.sendAccessInvite(recipient, granted?.name || (fields.get('targetName') ?? '').trim() || recipient.split('@')[0]!, granted?.productName || 'Martin Howard Property membership');
                invited = true;
              } catch { /* The access grant is committed; HQ must report the invite failure plainly. */ }
            }
            redirect(res, invited ? '/hq?result=invited' : '/hq?result=invite-failed');
            return;
          }
          if (req.method === 'GET' && path === '/app/account') {
            const deskDecision = await portal.authorizeMemberRequest?.({ sessionToken: token, identity, path: '/portal/investors', method: 'GET' });
            respond(res, 200, accountPage({ snapshot: await commerce.snapshot(token),
              csrf: portalCsrfToken(portal.sessionSecret, token), billingEnabled: commerce.billingEnabled,
              deskAccess: deskDecision?.allowed,
              ownerAccess: await deps.hq.isOwner(token),
              message: url.searchParams.get('result') === 'refund-requested' ? 'Your refund request was accepted. This page will update when Stripe confirms it.' : undefined,
            }), true);
            return;
          }
          if (req.method !== 'POST' || path === '/app/account') throw new MhpCommerceError(405, 'Use the controls on your account page.');
          if (req.headers.origin !== MHP_AUTH_ORIGIN) throw new MhpCommerceError(403, 'Refresh your account page before continuing.');
          if (!/^application\/x-www-form-urlencoded(?:;|$)/i.test(String(req.headers['content-type'] ?? ''))) {
            throw new MhpCommerceError(415, 'Use the account form.');
          }
          const fields = new URLSearchParams((await body(req, 4_096)).toString('utf8'));
          if ([...fields.keys()].some(key => !['csrf', 'purchaseId', 'confirm'].includes(key) || fields.getAll(key).length !== 1)
            || !verifyPortalCsrf(portal.sessionSecret, token, fields.get('csrf') ?? '')) {
            throw new MhpCommerceError(403, 'Refresh your account page before continuing.');
          }
          const purchaseId = fields.get('purchaseId') ?? '';
          if (path === '/app/account/refund') {
            if (fields.get('confirm') !== 'yes') throw new MhpCommerceError(400, 'Confirm the refund and cancellation before continuing.');
            await commerce.refund(token, purchaseId);
            redirect(res, '/app/account?result=refund-requested');
          } else {
            const target = new URL(await commerce.billingPortal(token, purchaseId));
            if (target.protocol !== 'https:' || target.hostname !== 'billing.stripe.com' || target.username || target.password) {
              throw new MhpCommerceError(503, 'The billing portal is temporarily unavailable.');
            }
            redirect(res, target.toString());
          }
        } catch (error) {
          outcome = 'service_error';
          respond(res, error instanceof MhpCommerceError ? error.status : 503,
            error instanceof MhpCommerceError ? error.message : 'Account access is temporarily unavailable.');
        } finally {
          await Promise.allSettled(leases.map(lease => portal.abuse!.complete(lease, outcome)));
        }
        return;
      }
      if (portalPath(path)) { await handlePortal(req, res, portal); return; }
      respond(res, 404, 'Page not found.');
    },
  };
}

export function unavailableMhpMount() {
  return {
    hostname: MHP_AUTH_HOST as typeof MHP_AUTH_HOST,
    readiness: async () => ['MHP member application is not configured'],
    async handle(_req: IncomingMessage, res: ServerResponse): Promise<void> {
      respond(res, 503, 'Your Desk is being connected. Please try again later.');
    },
  };
}
