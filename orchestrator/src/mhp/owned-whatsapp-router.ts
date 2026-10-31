import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PostgresPortalDeps } from '../portal/router.js';
import { portalCsrfToken, verifyPortalCsrf } from '../portal/session.js';
import { principalAbuseAdmission, sourceAbuseAdmission } from '../portal/abuse.js';
import { parseCookies } from '../server/admin/session.js';
import { MHP_AUTH_ORIGIN, MHP_SESSION_COOKIE } from './auth-service.js';
import { MhpCommerceError } from './commerce-service.js';
import type { MhpOwnedWhatsAppService } from './owned-whatsapp-service.js';
import { MHP_OWNED_WHATSAPP_ROUTE, mhpOwnedWhatsAppPage } from './owned-whatsapp-view.js';

type Service = Pick<MhpOwnedWhatsAppService, 'snapshot' | 'connect' | 'recordTemplate' | 'send'>;
const FIELDS: Readonly<Record<string, readonly string[]>> = {
  connect: ['envelope', 'senderNumber', 'ownershipEvidence', 'confirmed'],
  template: ['templateId', 'itemId', 'versionId', 'sha256', 'metaTemplateId', 'category', 'approvalReference', 'confirmed'],
  send: ['templateId', 'agreed'],
};
const CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
function respond(res: ServerResponse, status: number, body: string, html = false): void {
  res.writeHead(status, { 'content-type': html ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8', 'cache-control': 'no-store',
    'referrer-policy': 'same-origin', 'x-content-type-options': 'nosniff', 'content-security-policy': CSP });
  res.end(body);
}
async function form(req: IncomingMessage, fields: readonly string[]): Promise<URLSearchParams> {
  if (!/^application\/x-www-form-urlencoded(?:;\s*charset=utf-8)?$/iu.test(String(req.headers['content-type'] ?? ''))) throw new MhpCommerceError(415, 'Use the WhatsApp page form.');
  if (Number(req.headers['content-length'] ?? 0) > 24_000) throw new MhpCommerceError(413, 'This form is too large.');
  const parts: Buffer[] = []; let size = 0;
  for await (const raw of req) { const part = Buffer.isBuffer(raw) ? raw : Buffer.from(raw); size += part.length;
    if (size > 24_000) throw new MhpCommerceError(413, 'This form is too large.'); parts.push(part); }
  const result = new URLSearchParams(Buffer.concat(parts).toString('utf8')), allowed = ['csrf', 'commandId', ...fields];
  if (result.size !== allowed.length || [...result.keys()].some(key => !allowed.includes(key) || result.getAll(key).length !== 1)) throw new MhpCommerceError(400, 'Refresh the WhatsApp page.');
  return result;
}
export async function handleMhpOwnedWhatsApp(req: IncomingMessage, res: ServerResponse, url: URL,
  dependencies: { portal: PostgresPortalDeps; whatsapp: Service }): Promise<boolean> {
  const path = url.pathname.replace(/\/+$/, '');
  if (path !== MHP_OWNED_WHATSAPP_ROUTE && !path.startsWith(`${MHP_OWNED_WHATSAPP_ROUTE}/`)) return false;
  const action = path.slice(MHP_OWNED_WHATSAPP_ROUTE.length + 1), { portal, whatsapp } = dependencies;
  const leases: Buffer[] = []; let outcome: 'success' | 'service_error' = 'success';
  try {
    if (path === MHP_OWNED_WHATSAPP_ROUTE ? req.method !== 'GET' : req.method !== 'POST' || !Object.hasOwn(FIELDS, action)) throw new MhpCommerceError(405, 'Use the WhatsApp page controls.');
    const context = portal.requestContext?.(req), now = portal.now?.() ?? Date.now();
    if (!context || !portal.abuse || !portal.abuseHashSecret) throw new MhpCommerceError(503, 'MHP WhatsApp is unavailable.');
    const reserve = async (admission: ReturnType<typeof sourceAbuseAdmission>) => {
      if (!admission) throw new MhpCommerceError(503, 'MHP WhatsApp is unavailable.');
      const decision = await portal.abuse!.admit(admission); if (!decision.allowed) throw new MhpCommerceError(429, 'Too many requests. Try again shortly.');
      if (decision.leaseHash) leases.push(decision.leaseHash);
    };
    await reserve(sourceAbuseAdmission(context, req.method === 'GET' ? 'read.page' : 'command', now));
    const token = parseCookies(req.headers.cookie)[MHP_SESSION_COOKIE] ?? '', identity = token ? await portal.auth.resolve(token, now) : null;
    if (!identity) { res.writeHead(303, { location: '/portal/login', 'cache-control': 'no-store' }); res.end(); return true; }
    await reserve(principalAbuseAdmission(context, req.method === 'GET' ? 'read.page' : 'command', portal.abuseHashSecret, identity, now));
    const page = async (extra: { chosen?: { itemId: string; versionId: string }; notice?: string; result?: Awaited<ReturnType<Service['send']>> } = {}) => mhpOwnedWhatsAppPage({
      snapshot: await whatsapp.snapshot(identity, context.requestId, extra.chosen), csrf: portalCsrfToken(portal.sessionSecret, token),
      commandId: randomUUID(), templateId: randomUUID(), notice: extra.notice, result: extra.result });
    if (req.method === 'GET') {
      if ([...url.searchParams.keys()].some(key => !['item', 'version'].includes(key) || url.searchParams.getAll(key).length !== 1)
          || url.searchParams.has('item') !== url.searchParams.has('version')) throw new MhpCommerceError(400, 'Choose an exact saved WhatsApp draft.');
      const chosen = url.searchParams.has('item') ? { itemId: url.searchParams.get('item')!, versionId: url.searchParams.get('version')! } : undefined;
      respond(res, 200, await page({ chosen }), true); return true;
    }
    if (req.headers.origin !== MHP_AUTH_ORIGIN || (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin')) throw new MhpCommerceError(403, 'Use the WhatsApp page.');
    const fields = await form(req, FIELDS[action]!), field = (key: string) => fields.get(key) ?? '';
    if (!verifyPortalCsrf(portal.sessionSecret, token, field('csrf'))) throw new MhpCommerceError(403, 'Refresh the WhatsApp page before continuing.');
    if (action === 'connect') {
      await whatsapp.connect(identity, context.requestId, { commandId: field('commandId'), envelopeText: field('envelope'), senderNumber: field('senderNumber'),
        ownershipEvidence: field('ownershipEvidence'), confirmed: field('confirmed') === 'yes' });
      respond(res, 200, await page({ notice: 'MHP WhatsApp sender connected. Pin your approved template next.' }), true);
    } else if (action === 'template') {
      await whatsapp.recordTemplate(identity, context.requestId, { commandId: field('commandId'), templateId: field('templateId'), itemId: field('itemId'),
        versionId: field('versionId'), sha256: field('sha256'), category: field('category'), metaTemplateId: field('metaTemplateId'),
        approvalReference: field('approvalReference'), confirmed: field('confirmed') === 'yes' }, now);
      respond(res, 200, await page({ notice: 'Approved template pinned. You can send your one test.' }), true);
    } else {
      const result = await whatsapp.send(identity, context.requestId, { commandId: field('commandId'), templateId: field('templateId'), agreed: field('agreed') === 'yes' });
      respond(res, 200, await page({ result, notice: result.replayed ? 'This is the saved outcome of your earlier request. Nothing new was queued.' : 'One WhatsApp test was queued.' })
        .catch(() => 'One WhatsApp test is recorded. Open the WhatsApp page again to follow its status.'), true);
    }
  } catch (error) {
    outcome = 'service_error';
    respond(res, error instanceof MhpCommerceError ? error.status : 503, error instanceof MhpCommerceError ? error.message : 'MHP WhatsApp is unavailable. Check recorded status before retrying.');
  } finally { await Promise.allSettled(leases.map(lease => portal.abuse!.complete(lease, outcome))); }
  return true;
}
