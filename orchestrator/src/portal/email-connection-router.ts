/**
 * /portal/email: the owner's "Connect email" screens (Property Predator's portal only, for now).
 *
 *   GET  /portal/email              the page for the current state (?business=<id> must name an allowed business)
 *   GET  /portal/email/copy.js      the Copy buttons (progressive enhancement)
 *   POST /portal/email/connect      csrf, commandId, fromName, fromAddress, replyTo, agree (the email rules tick)
 *   POST /portal/email/continue     csrf, commandId
 *   POST /portal/email/check        csrf, commandId
 *   POST /portal/email/disconnect   csrf, commandId (also "Start again")
 *   POST /portal/email/use-domain   csrf, commandId (the platform founder only: take over a domain already in the account)
 * Same-origin and CSRF checked like the follow-ups page; the database re-checks the owner on every call.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { PortalSessionIdentity } from './auth-service.js';
import type { PostgresPortalDeps } from './router.js';
import { portalCsrfToken, verifyPortalCsrf } from './session.js';
import { FLOW_NATIVE_CSP } from '../followup-sequences/http.js';
import { EMAIL_CONNECT_BUSINESSES } from '../email-connections/config.js';
import { EMAIL_CONNECTION_MESSAGES, EmailConnectionError, type EmailConnectionService } from '../email-connections/service.js';
import { EMAIL_CONNECTION_COPY_SCRIPT, EMAIL_CONNECTION_ROUTE as BASE, renderEmailConnectionPage, renderEmailConnectionProblem, type EmailConnectionPageInput } from './email-connection-view.js';

const STALE = 'This page is out of date. Open Connect email again and try once more. Nothing was changed.';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function send(res: ServerResponse, status: number, body: string, type = 'text/html; charset=utf-8'): void {
  res.writeHead(status, { 'content-type': type, 'content-length': String(Buffer.byteLength(body)), 'cache-control': 'no-store',
    'referrer-policy': 'same-origin', 'content-security-policy': FLOW_NATIVE_CSP, 'x-content-type-options': 'nosniff' });
  res.end(body);
}

class RouteError extends Error { constructor(readonly status: number, message: string) { super(message); } }

async function readForm(req: IncomingMessage, required: readonly string[], optional: readonly string[] = []): Promise<URLSearchParams> {
  if (!/^application\/x-www-form-urlencoded(?:;\s*charset=utf-8)?$/iu.test(String(req.headers['content-type'] ?? ''))) throw new RouteError(415, STALE);
  const maximum = 4096;
  if (Number(req.headers['content-length'] ?? 0) > maximum) throw new RouteError(413, STALE);
  const chunks: Buffer[] = []; let size = 0;
  for await (const raw of req) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as string);
    size += chunk.length;
    if (size > maximum) throw new RouteError(413, STALE);
    chunks.push(chunk);
  }
  const fields = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  const keys = [...fields.keys()];
  if (required.some(key => fields.getAll(key).length !== 1) || keys.some(key => (!required.includes(key) && !optional.includes(key)) || fields.getAll(key).length !== 1)) throw new RouteError(400, STALE);
  return fields;
}

export async function handleEmailConnection(req: IncomingMessage, res: ServerResponse, url: URL, input: {
  portal: Pick<PostgresPortalDeps, 'productProfile' | 'portalBaseUrl' | 'sessionSecret'>;
  service: Pick<EmailConnectionService, 'view' | 'connect' | 'continue' | 'check' | 'disconnect' | 'useExistingDomain'>;
  identity: PortalSessionIdentity | null;
}): Promise<boolean> {
  const path = url.pathname.replace(/\/+$/u, '');
  if (path !== BASE && !path.startsWith(`${BASE}/`)) return false;
  try {
    const { portal, service, identity } = input;
    let origin: URL;
    try { origin = new URL(portal.portalBaseUrl ?? ''); } catch { throw new RouteError(503, EMAIL_CONNECTION_MESSAGES.off); }
    if (portal.productProfile?.id !== 'property_predator_growth' || origin.protocol !== 'https:' || req.headers.host?.toLowerCase() !== origin.host.toLowerCase()) {
      throw new RouteError(404, 'This page isn’t available here.');
    }
    if (path === `${BASE}/copy.js`) {
      if (req.method !== 'GET' || url.search) throw new RouteError(400, STALE);
      send(res, 200, EMAIL_CONNECTION_COPY_SCRIPT, 'text/javascript; charset=utf-8'); return true;
    }
    if (!identity) { res.writeHead(303, { location: '/portal/login', 'cache-control': 'no-store' }); res.end(); return true; }
    const page = async (extra: Partial<EmailConnectionPageInput> = {}): Promise<string> => renderEmailConnectionPage({
      view: await service.view(identity), csrf: portalCsrfToken(portal.sessionSecret, identity.sessionToken), commandId: randomUUID(), ...extra });
    if (path === BASE) {
      if (req.method !== 'GET') throw new RouteError(405, STALE);
      const keys = [...url.searchParams.keys()];
      if (keys.some(key => key !== 'business') || url.searchParams.getAll('business').length > 1) throw new RouteError(400, STALE);
      const business = url.searchParams.get('business');
      // The Business picker offers only the businesses allowed to connect email (Property Predator for now), and only
      // the one this session has selected; another id is refused.
      if (business !== null && (!EMAIL_CONNECT_BUSINESSES.some(item => item.workspaceId === business) || business !== identity.workspaceId)) {
        throw new RouteError(404, EMAIL_CONNECTION_MESSAGES.notAllowed);
      }
      send(res, 200, await page()); return true;
    }
    if (req.method !== 'POST') throw new RouteError(405, STALE);
    if (url.search || req.headers.origin !== origin.origin || (req.headers['sec-fetch-site'] !== undefined && req.headers['sec-fetch-site'] !== 'same-origin')) throw new RouteError(403, STALE);
    const action = path.slice(BASE.length + 1);
    if (!['connect', 'continue', 'check', 'disconnect', 'use-domain'].includes(action)) throw new RouteError(404, STALE);
    const fields = action === 'connect'
      ? await readForm(req, ['csrf', 'commandId', 'fromName', 'fromAddress', 'replyTo'], ['agree'])
      : await readForm(req, ['csrf', 'commandId']);
    if (!verifyPortalCsrf(portal.sessionSecret, identity.sessionToken, fields.get('csrf') ?? '') || !UUID.test(fields.get('commandId') ?? '')) throw new RouteError(403, STALE);
    const typed = action === 'connect' ? { fromName: (fields.get('fromName') ?? '').slice(0, 200), fromAddress: (fields.get('fromAddress') ?? '').slice(0, 300),
      replyTo: (fields.get('replyTo') ?? '').slice(0, 300) } : undefined;
    try {
      const result = action === 'connect' ? await service.connect(identity, { ...typed!, agreed: fields.get('agree') === 'yes' })
        : action === 'continue' ? await service.continue(identity)
          : action === 'check' ? await service.check(identity)
            : action === 'use-domain' ? await service.useExistingDomain(identity) : await service.disconnect(identity);
      send(res, 200, await page({ message: { text: result.message, ok: result.ok } }));
    } catch (error) {
      if (!(error instanceof EmailConnectionError)) throw error;
      // A refusal is shown on the page itself, with what the owner typed kept in the form.
      if (error.status === 403 || error.code === 'off') throw new RouteError(error.status, error.message);
      send(res, error.status, await page({ message: { text: error.message, ok: false }, ...(typed ? { form: typed } : {}),
        ...(error.code === 'domain_in_account' ? { offerTakeOver: true } : {}) }));
    }
    return true;
  } catch (error) {
    const known = error instanceof RouteError || error instanceof EmailConnectionError;
    const status = known ? (error as RouteError).status : 503;
    send(res, status, renderEmailConnectionProblem(known ? (error as Error).message : EMAIL_CONNECTION_MESSAGES.busy));
    return true;
  }
}
