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

export interface MhpMarketingWorkspaceDependencies {
  portal: PostgresPortalDeps;
  marketingWorkspace: Pick<PgMhpMarketingWorkspaceService, 'snapshot' | 'select'>;
  webinarLeads?: Pick<MhpWebinarLeadService, 'importBatch'>;
  emailEditorEnabled?: boolean;
  sequenceEditorEnabled?: boolean;
  ownedSmsEnabled?: boolean;
  eventSmsEnabled?: boolean;
  whatsappEnabled?: boolean;
}
const PATHS = new Set(['/hq/marketing', '/hq/marketing/open', '/hq/marketing/return', '/hq/marketing/webinar-leads']);
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
async function form(req: IncomingMessage, keys: readonly string[]): Promise<URLSearchParams> {
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
  if ([...fields.keys()].some(key => !keys.includes(key) || fields.getAll(key).length !== 1)
      || fields.size !== keys.length) throw new MhpCommerceError(400, 'Refresh the marketing workspace form.');
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
    if ((path === '/hq/marketing' && method !== 'GET') || (path !== '/hq/marketing' && method !== 'POST')) {
      throw new MhpCommerceError(405, 'Use the controls in the marketing workspace.');
    }
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
    if (!identity) { redirect(res, '/portal/login'); return true; }
    await reserve(principalAbuseAdmission(context, routeClass, portal.abuseHashSecret, identity, now));
    const snapshot = await deps.marketingWorkspace.snapshot(identity);
    if (method === 'GET') {
      send(res, 200, marketingWorkspacePage(snapshot, portalCsrfToken(portal.sessionSecret, token), randomUUID(),
        { enabled: Boolean(deps.webinarLeads), emailEditorEnabled: deps.emailEditorEnabled, sequenceEditorEnabled: deps.sequenceEditorEnabled, ownedSmsEnabled: deps.ownedSmsEnabled, eventSmsEnabled: deps.eventSmsEnabled, whatsappEnabled: deps.whatsappEnabled }), true);
      return true;
    }
    if (req.headers.origin !== MHP_AUTH_ORIGIN
        || (req.headers['sec-fetch-site'] !== undefined && req.headers['sec-fetch-site'] !== 'same-origin')) {
      throw new MhpCommerceError(403, 'Refresh the marketing workspace before continuing.');
    }
    const importing = path === '/hq/marketing/webinar-leads';
    const fields = await form(req, importing ? ['csrf', 'cursor'] : ['csrf', 'commandId']);
    if (!verifyPortalCsrf(portal.sessionSecret, token, fields.get('csrf') ?? '')) {
      throw new MhpCommerceError(403, 'Refresh the marketing workspace before continuing.');
    }
    if (importing) {
      if (!snapshot.marketingSelected) throw new MhpCommerceError(403, 'Open the MHP marketing workspace before importing sign-ups.');
      if (!deps.webinarLeads) throw new MhpCommerceError(503, 'Webinar import is temporarily unavailable.');
      const result = await deps.webinarLeads.importBatch(identity, context.requestId, fields.get('cursor') ?? '', now);
      if (result.failed) outcome = 'service_error';
      send(res, result.failed ? 503 : 200, marketingWorkspacePage(snapshot, portalCsrfToken(portal.sessionSecret, token), randomUUID(),
        { enabled: true, result, emailEditorEnabled: deps.emailEditorEnabled, sequenceEditorEnabled: deps.sequenceEditorEnabled, ownedSmsEnabled: deps.ownedSmsEnabled, eventSmsEnabled: deps.eventSmsEnabled, whatsappEnabled: deps.whatsappEnabled }), true);
      return true;
    }
    const action = path === '/hq/marketing/open' ? 'open' : 'return';
    if (action === 'return' && !snapshot.marketingSelected) throw new MhpCommerceError(409, 'The marketing workspace is not selected.');
    const selected = await deps.marketingWorkspace.select(identity, action, fields.get('commandId') ?? '', now);
    if (action === 'return' && selected.workspaceId !== snapshot.personalWorkspaceId) {
      throw new MhpCommerceError(503, 'Personal Desk selection was not confirmed. Sign in again.');
    }
    redirect(res, action === 'open' ? '/portal/crm/opportunities' : '/portal/investors',
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
