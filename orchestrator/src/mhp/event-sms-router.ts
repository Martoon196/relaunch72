import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PostgresPortalDeps } from '../portal/router.js';
import { portalCsrfToken, verifyPortalCsrf } from '../portal/session.js';
import { principalAbuseAdmission, sourceAbuseAdmission, type PortalAbuseRouteClass } from '../portal/abuse.js';
import { parseCookies } from '../server/admin/session.js';
import { MHP_AUTH_ORIGIN, MHP_SESSION_COOKIE } from './auth-service.js';
import { MhpCommerceError } from './commerce-service.js';
import type { MhpEventSmsOwnerService, MhpEventSmsPublic } from './event-sms-service.js';
import { MHP_EVENT_SMS_OWNER_ROUTE, MHP_EVENT_SMS_PUBLIC_ROUTE, mhpEventSmsCodePage, mhpEventSmsDonePage, mhpEventSmsMessagePage,
  mhpEventSmsOptinPage, mhpEventSmsOwnerPage } from './event-sms-view.js';

const CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
function send(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'content-length': String(Buffer.byteLength(body)), 'cache-control': 'no-store',
    'referrer-policy': 'same-origin', 'x-content-type-options': 'nosniff', 'content-security-policy': CSP });
  res.end(body);
}
async function form(req: IncomingMessage, allowed: readonly string[]): Promise<URLSearchParams> {
  if (!/^application\/x-www-form-urlencoded(?:;\s*charset=utf-8)?$/iu.test(String(req.headers['content-type'] ?? ''))) throw new MhpCommerceError(415, 'Use the form on this page.');
  if (Number(req.headers['content-length'] ?? 0) > 4_096) throw new MhpCommerceError(413, 'This form is too large.');
  const parts: Buffer[] = []; let size = 0;
  for await (const raw of req) {
    const part = Buffer.isBuffer(raw) ? raw : Buffer.from(raw); size += part.length;
    if (size > 4_096) throw new MhpCommerceError(413, 'This form is too large.');
    parts.push(part);
  }
  const fields = new URLSearchParams(Buffer.concat(parts).toString('utf8'));
  if ([...fields.keys()].some(key => !allowed.includes(key) || fields.getAll(key).length !== 1)) throw new MhpCommerceError(400, 'Refresh the page and try again.');
  return fields;
}
const sameOrigin = (req: IncomingMessage): boolean => req.headers.origin === MHP_AUTH_ORIGIN
  && (!req.headers['sec-fetch-site'] || req.headers['sec-fetch-site'] === 'same-origin');
async function admit(portal: PostgresPortalDeps, admission: ReturnType<typeof sourceAbuseAdmission>, leases: Buffer[]): Promise<void> {
  if (!admission || !portal.abuse) throw new MhpCommerceError(503, 'This page is temporarily unavailable.');
  const decision = await portal.abuse.admit(admission);
  if (!decision.allowed) throw new MhpCommerceError(429, 'Too many requests. Please wait a few minutes and try again.');
  if (decision.leaseHash) leases.push(decision.leaseHash);
}

/** Anonymous registrant pages. No session, no owner context and no CRM access. */
export async function handleMhpEventSmsPublic(req: IncomingMessage, res: ServerResponse, url: URL,
  dependencies: { portal: PostgresPortalDeps; optins: MhpEventSmsPublic }): Promise<boolean> {
  const path = url.pathname.replace(/\/+$/, '');
  if (path !== MHP_EVENT_SMS_PUBLIC_ROUTE && path !== `${MHP_EVENT_SMS_PUBLIC_ROUTE}/confirm`) return false;
  const { portal, optins } = dependencies, leases: Buffer[] = [];
  let outcome: 'success' | 'service_error' = 'success';
  try {
    const method = req.method ?? 'GET';
    const context = portal.requestContext?.(req), now = portal.now?.() ?? Date.now();
    if (!context || !portal.abuse) throw new MhpCommerceError(503, 'This page is temporarily unavailable.');
    if (method === 'GET' && path === MHP_EVENT_SMS_PUBLIC_ROUTE && url.search === '') {
      await admit(portal, sourceAbuseAdmission(context, 'read.page', now), leases);
      send(res, 200, mhpEventSmsOptinPage({ requestKey: randomUUID() })); return true;
    }
    if (method !== 'POST') throw new MhpCommerceError(405, 'Use the form on this page.');
    const routeClass: PortalAbuseRouteClass = 'auth.setup';
    await admit(portal, sourceAbuseAdmission(context, routeClass, now), leases);
    if (!sameOrigin(req)) throw new MhpCommerceError(403, 'Use the form on this page.');
    if (path === MHP_EVENT_SMS_PUBLIC_ROUTE) {
      const fields = await form(req, ['requestKey', 'email', 'mobile', 'consent']);
      const email = fields.get('email') ?? '';
      if (fields.get('consent') !== 'yes') {
        send(res, 400, mhpEventSmsOptinPage({ requestKey: randomUUID(), email, notice: 'Tick the box to agree to webinar texts, or simply leave this page.' })); return true;
      }
      const optinId = await optins.request({ email, phone: fields.get('mobile') ?? '', consented: true, requestKey: fields.get('requestKey') ?? '' },
        context.sourceHash ? Buffer.from(context.sourceHash) : null);
      send(res, 200, mhpEventSmsCodePage({ optinId })); return true;
    }
    const fields = await form(req, ['optinId', 'code']);
    const optinId = fields.get('optinId') ?? '', result = await optins.confirm(optinId, fields.get('code') ?? '');
    if (result === 'verified' || result === 'already') { send(res, 200, mhpEventSmsDonePage()); return true; }
    if (result === 'retry') { send(res, 400, mhpEventSmsCodePage({ optinId, notice: "That code didn't match. Check the text and try again." })); return true; }
    send(res, 400, mhpEventSmsMessagePage('That code has expired', 'Codes last 10 minutes and allow five tries. Start again to get a new one.')); return true;
  } catch (error) {
    outcome = 'service_error';
    const status = error instanceof MhpCommerceError ? error.status : 503;
    send(res, status, mhpEventSmsMessagePage(status === 429 ? 'Slow down a moment' : status >= 500 ? 'Something went wrong' : 'Please check the form',
      error instanceof MhpCommerceError ? error.message : 'Webinar texts are temporarily unavailable. Please try again shortly.'));
    return true;
  } finally { await Promise.allSettled(leases.map(lease => portal.abuse!.complete(lease, outcome))); }
}

type Owner = Pick<MhpEventSmsOwnerService, 'snapshot' | 'send'>;
/** Owner review and the one send action, behind the native MHP owner session. */
export async function handleMhpEventSmsOwner(req: IncomingMessage, res: ServerResponse, url: URL,
  dependencies: { portal: PostgresPortalDeps; owner: Owner }): Promise<boolean> {
  const path = url.pathname.replace(/\/+$/, '');
  if (path !== MHP_EVENT_SMS_OWNER_ROUTE && path !== `${MHP_EVENT_SMS_OWNER_ROUTE}/send`) return false;
  const { portal, owner } = dependencies, leases: Buffer[] = [];
  let outcome: 'success' | 'service_error' = 'success';
  try {
    if (path === MHP_EVENT_SMS_OWNER_ROUTE ? req.method !== 'GET' : req.method !== 'POST') throw new MhpCommerceError(405, 'Use the controls on the webinar texts page.');
    const context = portal.requestContext?.(req), now = portal.now?.() ?? Date.now();
    if (!context || !portal.abuse || !portal.abuseHashSecret) throw new MhpCommerceError(503, 'Webinar texts are unavailable.');
    const routeClass: PortalAbuseRouteClass = req.method === 'GET' ? 'read.page' : 'command';
    await admit(portal, sourceAbuseAdmission(context, routeClass, now), leases);
    const token = parseCookies(req.headers.cookie)[MHP_SESSION_COOKIE] ?? '', identity = token ? await portal.auth.resolve(token, now) : null;
    if (!identity) { res.writeHead(303, { location: '/portal/login', 'cache-control': 'no-store' }); res.end(); return true; }
    await admit(portal, principalAbuseAdmission(context, routeClass, portal.abuseHashSecret, identity, now), leases);
    const csrf = portalCsrfToken(portal.sessionSecret, token);
    if (req.method === 'GET') {
      const keys = [...url.searchParams.keys()];
      if (keys.some(key => !['item', 'version'].includes(key) || url.searchParams.getAll(key).length !== 1)
          || url.searchParams.has('item') !== url.searchParams.has('version')) throw new MhpCommerceError(400, 'Choose an exact saved MHP text.');
      const chosen = url.searchParams.has('item') ? { itemId: url.searchParams.get('item')!, versionId: url.searchParams.get('version')! } : undefined;
      send(res, 200, mhpEventSmsOwnerPage({ snapshot: await owner.snapshot(identity, context.requestId, chosen), csrf, commandId: randomUUID() })); return true;
    }
    if (!sameOrigin(req)) throw new MhpCommerceError(403, 'Use the webinar texts page.');
    const fields = await form(req, ['csrf', 'commandId', 'itemId', 'versionId', 'sha256', 'batchSha256', 'agreed']);
    if (!verifyPortalCsrf(portal.sessionSecret, token, fields.get('csrf') ?? '')) throw new MhpCommerceError(403, 'Refresh the webinar texts page before continuing.');
    const field = (key: string): string => fields.get(key) ?? '';
    const result = await owner.send(identity, context.requestId, { commandId: field('commandId'), itemId: field('itemId'), versionId: field('versionId'),
      sha256: field('sha256'), batchSha256: field('batchSha256'), agreed: field('agreed') === 'yes' }, now);
    // The send is recorded; a failed refresh must never read as a failed send.
    const snapshot = await owner.snapshot(identity, context.requestId, { itemId: field('itemId'), versionId: field('versionId') }).catch(() => null);
    if (!snapshot) {
      send(res, 200, mhpEventSmsMessagePage(result.replayed ? 'Already sent' : 'Texts queued',
        `${result.recipientCount} texts are recorded for this batch. Open the webinar texts page again to follow their status.`)); return true;
    }
    send(res, 200, mhpEventSmsOwnerPage({ snapshot, csrf, commandId: randomUUID(), result })); return true;
  } catch (error) {
    outcome = 'service_error';
    const status = error instanceof MhpCommerceError ? error.status : 503;
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': CSP });
    res.end(error instanceof MhpCommerceError ? error.message : 'Webinar texts are unavailable. Check the recorded status before retrying.');
    return true;
  } finally { await Promise.allSettled(leases.map(lease => portal.abuse!.complete(lease, outcome))); }
}
