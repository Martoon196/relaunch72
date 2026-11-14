import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PostgresPortalDeps } from '../portal/router.js';
import { portalCookie, portalCsrfToken, verifyPortalCsrf } from '../portal/session.js';
import { parseCookies } from '../server/admin/session.js';
import { principalAbuseAdmission, sourceAbuseAdmission } from '../portal/abuse.js';
import { MHP_AUTH_ORIGIN, MHP_SESSION_COOKIE } from './auth-service.js';
import { MhpCommerceError } from './commerce-service.js';
import type { PgMhpMarketingWorkspaceService } from './marketing-workspace-service.js';
import { marketingWorkspacePage } from './marketing-workspace-view.js';
import type { MhpWebinarLeadService } from './webinar-leads-service.js';
import { emailHealthOutsidePage, emailHealthPage, type MhpEmailHealth } from './email-health.js';

export interface MhpMarketingWorkspaceDependencies {
  portal: PostgresPortalDeps;
  marketingWorkspace: Pick<PgMhpMarketingWorkspaceService, 'snapshot' | 'select'>;
  webinarLeads?: Pick<MhpWebinarLeadService, 'importBatch'>;
  emailEditorEnabled?: boolean;
  sequenceEditorEnabled?: boolean;
  ownedSmsEnabled?: boolean;
  whatsappEnabled?: boolean;
  /** Bounced, complained and unsubscribed addresses for the MHP brand; absent when no email service is configured. */
  emailHealth?: Pick<MhpEmailHealth, 'configured' | 'snapshot' | 'check'> & Partial<Pick<MhpEmailHealth, 'durable' | 'lift'>>;
}
const EMAIL_HEALTH = '/hq/marketing/email-health', EMAIL_HEALTH_CHECK = '/hq/marketing/email-health/check', EMAIL_HEALTH_LIFT = '/hq/marketing/email-health/lift';
const READ_PATHS = new Set(['/hq/marketing', EMAIL_HEALTH]);
const PATHS = new Set(['/hq/marketing', '/hq/marketing/open', '/hq/marketing/return', '/hq/marketing/webinar-leads', EMAIL_HEALTH, EMAIL_HEALTH_CHECK, EMAIL_HEALTH_LIFT]);
const CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
function send(res: ServerResponse, status: number, body: string, html = false): void {
  res.writeHead(status, { 'content-type': html ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)), 'cache-control': 'no-store',
    'referrer-policy': 'same-origin', 'x-content-type-options': 'nosniff', 'content-security-policy': CSP });
  res.end(body);
}
function redirect(res: ServerResponse, target: string, cookie?: string): void {
  if (cookie) res.setHeader('set-cookie', cookie);
  res.writeHead(303, { location: target, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }); res.end();
}
async function form(req: IncomingMessage, keys: readonly string[], optional: readonly string[] = []): Promise<URLSearchParams> {
  if (!/^application\/x-www-form-urlencoded(?:;\s*charset=utf-8)?$/iu.test(String(req.headers['content-type'] ?? ''))) {
    throw new MhpCommerceError(415, 'Use the marketing workspace form.');
  }
  if (Number(req.headers['content-length'] ?? 0) > 4096) throw new MhpCommerceError(413, 'This form is too large.');
  const chunks: Buffer[] = []; let size = 0;
  for await (const raw of req) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw); size += chunk.length;
    if (size > 4096) throw new MhpCommerceError(413, 'This form is too large.');
    chunks.push(chunk);
  }
  const fields = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  if ([...fields.keys()].some(key => !(keys.includes(key) || optional.includes(key)) || fields.getAll(key).length !== 1)
      || keys.some(key => !fields.has(key))) throw new MhpCommerceError(400, 'Refresh the marketing workspace form.');
  return fields;
}

/** Mounted behind the existing exact native-host check. */
export async function handleMhpMarketingWorkspace(req: IncomingMessage, res: ServerResponse, url: URL,
  deps: MhpMarketingWorkspaceDependencies): Promise<boolean> {
  const path = url.pathname.replace(/\/+$/, '');
  if (!PATHS.has(path)) return false;
  const { portal } = deps; const leases: Buffer[] = [];
  let outcome: 'success' | 'service_error' = 'success';
  try {
    const method = req.method ?? 'GET';
    if ((READ_PATHS.has(path) && method !== 'GET') || (!READ_PATHS.has(path) && method !== 'POST')) {
      throw new MhpCommerceError(405, 'Use the controls in the marketing workspace.');
    }
    const health = deps.emailHealth?.configured ? deps.emailHealth : undefined;
    if ((path === EMAIL_HEALTH || path === EMAIL_HEALTH_CHECK || path === EMAIL_HEALTH_LIFT) && !health) throw new MhpCommerceError(404, 'Page not found.');
    const context = portal.requestContext?.(req);
    if (!context || !portal.abuse || !portal.abuseHashSecret) throw new MhpCommerceError(503, 'Marketing workspace access is temporarily unavailable.');
    const now = portal.now?.() ?? Date.now(); const routeClass = method === 'GET' ? 'read.page' : 'command';
    const reserve = async (admission: ReturnType<typeof sourceAbuseAdmission>): Promise<void> => {
      if (!admission) throw new MhpCommerceError(503, 'Marketing workspace access is temporarily unavailable.');
      const decision = await portal.abuse!.admit(admission);
      if (!decision.allowed) throw new MhpCommerceError(429, 'Too many requests. Please try again shortly.');
      if (decision.leaseHash) leases.push(decision.leaseHash);
    };
    await reserve(sourceAbuseAdmission(context, routeClass, now));
    const token = parseCookies(req.headers.cookie)[MHP_SESSION_COOKIE] ?? '';
    const identity = token ? await portal.auth.resolve(token, now) : null;
    if (!identity) {
      // Only these two exact pages are carried through sign-in (the sign-in page checks the same exact list again).
      redirect(res, method === 'GET' && (path === '/hq/marketing' || path === EMAIL_HEALTH) ? `/portal/login?next=${encodeURIComponent(path)}` : '/portal/login');
      return true;
    }
    await reserve(principalAbuseAdmission(context, routeClass, portal.abuseHashSecret, identity, now));
    const snapshot = await deps.marketingWorkspace.snapshot(identity);
    const emailHealth = health && snapshot.marketingSelected ? health.snapshot() : undefined;
    if (path === EMAIL_HEALTH) {
      // Addresses appear on this page, so it is only shown inside the MHP brand workspace. Outside it, the owner gets
      // the same "Open marketing workspace" form as the marketing screen, which lands back here.
      if (!emailHealth) { send(res, 200, emailHealthOutsidePage(portalCsrfToken(portal.sessionSecret, token), randomUUID()), true); return true; }
      send(res, 200, emailHealthPage(emailHealth, portalCsrfToken(portal.sessionSecret, token), undefined, { durable: health?.durable === true }), true);
      return true;
    }
    if (method === 'GET') {
      send(res, 200, marketingWorkspacePage(snapshot, portalCsrfToken(portal.sessionSecret, token), randomUUID(),
        { enabled: Boolean(deps.webinarLeads), emailEditorEnabled: deps.emailEditorEnabled, sequenceEditorEnabled: deps.sequenceEditorEnabled, ownedSmsEnabled: deps.ownedSmsEnabled, whatsappEnabled: deps.whatsappEnabled, emailHealth }), true);
      return true;
    }
    if (req.headers.origin !== MHP_AUTH_ORIGIN
        || (req.headers['sec-fetch-site'] !== undefined && req.headers['sec-fetch-site'] !== 'same-origin')) {
      throw new MhpCommerceError(403, 'Refresh the marketing workspace before continuing.');
    }
    const importing = path === '/hq/marketing/webinar-leads', checking = path === EMAIL_HEALTH_CHECK, lifting = path === EMAIL_HEALTH_LIFT;
    const opening = path === '/hq/marketing/open';
    const fields = await form(req, checking ? ['csrf'] : lifting ? ['csrf', 'email'] : importing ? ['csrf', 'cursor'] : ['csrf', 'commandId'], opening ? ['then'] : []);
    // Where opening the workspace lands: the enquiry board by default; the email health page only for this exact value.
    const then = fields.get('then');
    if (then !== null && then !== 'email-health') throw new MhpCommerceError(400, 'Refresh the marketing workspace form.');
    if (!verifyPortalCsrf(portal.sessionSecret, token, fields.get('csrf') ?? '')) {
      throw new MhpCommerceError(403, 'Refresh the marketing workspace before continuing.');
    }
    if (checking) {
      if (!health || !snapshot.marketingSelected) throw new MhpCommerceError(403, 'Open the MHP marketing workspace to check bounced emails.');
      const result = await health.check(token);
      send(res, 200, emailHealthPage(health.snapshot(), portalCsrfToken(portal.sessionSecret, token), result, { durable: health.durable === true }), true);
      return true;
    }
    if (lifting) {
      if (!health || !snapshot.marketingSelected) throw new MhpCommerceError(403, 'Open the MHP marketing workspace to change bounced emails.');
      if (!health.lift) throw new MhpCommerceError(404, 'Page not found.');
      const lift = await health.lift(token, fields.get('email') ?? '');
      send(res, 200, emailHealthPage(health.snapshot(), portalCsrfToken(portal.sessionSecret, token), undefined, { durable: health.durable === true, lift }), true);
      return true;
    }
    if (importing) {
      if (!snapshot.marketingSelected) throw new MhpCommerceError(403, 'Open the MHP marketing workspace before importing sign-ups.');
      if (!deps.webinarLeads) throw new MhpCommerceError(503, 'Webinar import is temporarily unavailable.');
      const result = await deps.webinarLeads.importBatch(identity, context.requestId, fields.get('cursor') ?? '', now);
      if (result.failed) outcome = 'service_error';
      send(res, result.failed ? 503 : 200, marketingWorkspacePage(snapshot, portalCsrfToken(portal.sessionSecret, token), randomUUID(),
        { enabled: true, result, emailEditorEnabled: deps.emailEditorEnabled, sequenceEditorEnabled: deps.sequenceEditorEnabled, ownedSmsEnabled: deps.ownedSmsEnabled, whatsappEnabled: deps.whatsappEnabled, emailHealth }), true);
      return true;
    }
    const action = path === '/hq/marketing/open' ? 'open' : 'return';
    if (action === 'return' && !snapshot.marketingSelected) throw new MhpCommerceError(409, 'The marketing workspace is not selected.');
    const selected = await deps.marketingWorkspace.select(identity, action, fields.get('commandId') ?? '', now);
    if (action === 'return' && selected.workspaceId !== snapshot.personalWorkspaceId) {
      throw new MhpCommerceError(503, 'Personal Desk selection was not confirmed. Sign in again.');
    }
    redirect(res, action === 'open' ? (then === 'email-health' ? EMAIL_HEALTH : '/portal/crm/opportunities') : '/portal/investors',
      portalCookie(selected.sessionToken, true, Math.max(1, Math.floor((Date.parse(selected.expiresAt) - now) / 1000)), MHP_SESSION_COOKIE));
  } catch (error) {
    outcome = 'service_error';
    send(res, error instanceof MhpCommerceError ? error.status : 503,
      error instanceof MhpCommerceError ? error.message : 'The marketing workspace is temporarily unavailable.');
  } finally {
    await Promise.allSettled(leases.map(lease => portal.abuse!.complete(lease, outcome)));
  }
  return true;
}
