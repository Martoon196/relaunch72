import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PostgresPortalDeps } from '../portal/router.js';
import { portalCsrfToken, verifyPortalCsrf } from '../portal/session.js';
import { parseCookies } from '../server/admin/session.js';
import { principalAbuseAdmission, sourceAbuseAdmission } from '../portal/abuse.js';
import { MHP_AUTH_ORIGIN, MHP_SESSION_COOKIE } from './auth-service.js';
import { MhpCommerceError, type PgMhpCommerceService } from './commerce-service.js';
import { calculateMhpDeal, mhpCalculator, MhpCalculatorInputError } from './calculators.js';
import { VERDICT_FIELDS, type PgMhpDeskService } from './desk-service.js';
import { calculatorPage, deskPage, verdictPage, verdictQueuePage } from './desk-view.js';

export interface MhpDeskDependencies {
  portal: PostgresPortalDeps;
  desk: Pick<PgMhpDeskService, 'snapshot' | 'save' | 'archive' | 'submitVerdict' | 'queue' | 'review'>;
  commerce: Pick<PgMhpCommerceService, 'creditSnapshot' | 'courseCheckout' | 'billingEnabled'>;
}
const known = /^\/(?:app\/(?:desk|verdict|calculators\/(?:brrr|hmo|sa|auction|residual)|deals\/(?:[0-9a-f-]{36}|archive)|account\/course-checkout)|hq\/verdicts(?:\/review)?)$/i;
function send(res: ServerResponse, status: number, content: string, html = false): void {
  res.writeHead(status, { 'content-type': html ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8', 'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(content)), 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" });
  res.end(content);
}
function redirect(res: ServerResponse, location: string): void { res.writeHead(303, { location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }); res.end(); }
async function form(req: IncomingMessage, allowed: readonly string[], token: string, secret: string): Promise<Record<string, string>> {
  if (req.headers.origin !== MHP_AUTH_ORIGIN) throw new MhpCommerceError(403, 'Refresh Your Desk before continuing.');
  if (!/^application\/x-www-form-urlencoded(?:;|$)/i.test(String(req.headers['content-type'] ?? ''))) throw new MhpCommerceError(415, 'Use the form in Your Desk.');
  const maximum = 32_768;
  if (Number(req.headers['content-length'] ?? 0) > maximum) throw new MhpCommerceError(413, 'This form is too large.');
  const parts: Buffer[] = []; let size = 0;
  for await (const raw of req) {
    const part = Buffer.isBuffer(raw) ? raw : Buffer.from(raw); size += part.length;
    if (size > maximum) throw new MhpCommerceError(413, 'This form is too large.');
    parts.push(part);
  }
  const fields = new URLSearchParams(Buffer.concat(parts).toString('utf8'));
  if ([...fields.keys()].some(key => !allowed.includes(key) || fields.getAll(key).length !== 1)
      || !verifyPortalCsrf(secret, token, fields.get('csrf') ?? '')) throw new MhpCommerceError(403, 'Refresh Your Desk before continuing.');
  return Object.fromEntries(fields);
}

/** Called only after the MHP mount's exact-host guard. No PP route uses this handler. */
export async function handleMhpDesk(req: IncomingMessage, res: ServerResponse, url: URL, deps: MhpDeskDependencies): Promise<boolean> {
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (!known.test(path)) return false;
  const { portal, desk, commerce } = deps;
  const leases: Buffer[] = [];
  let outcome: 'success' | 'service_error' = 'success';
  try {
    if (!['GET', 'POST'].includes(req.method ?? '')) throw new MhpCommerceError(405, 'Use the controls in Your Desk.');
    const context = portal.requestContext?.(req);
    if (!context || !portal.abuse || !portal.abuseHashSecret) throw new MhpCommerceError(503, 'Your Desk is temporarily unavailable.');
    const now = portal.now?.() ?? Date.now(), routeClass = req.method === 'GET' ? 'read.page' : 'command';
    const source = sourceAbuseAdmission(context, routeClass, now);
    if (!source) throw new MhpCommerceError(503, 'Your Desk is temporarily unavailable.');
    const reserve = async (admission: typeof source): Promise<void> => {
      const decision = await portal.abuse!.admit(admission);
      if (!decision.allowed) throw new MhpCommerceError(429, 'Too many requests. Please try again shortly.');
      if (decision.leaseHash) leases.push(decision.leaseHash);
    };
    await reserve(source);
    const token = parseCookies(req.headers.cookie)[MHP_SESSION_COOKIE] ?? '';
    const identity = token ? await portal.auth.resolve(token, now) : null;
    if (!identity) { redirect(res, '/portal/login'); return true; }
    await reserve(principalAbuseAdmission(context, routeClass, portal.abuseHashSecret, identity, now));
    const csrf = portalCsrfToken(portal.sessionSecret, token);
    if (path === '/hq/verdicts' && req.method === 'GET') {
      send(res, 200, verdictQueuePage({ queue: await desk.queue(token), csrf, reviewed: url.searchParams.get('result') === 'reviewed' }), true); return true;
    }
    if (path === '/hq/verdicts/review' && req.method === 'POST') {
      await desk.review(token, await form(req, ['csrf', 'commandId', 'verdictId', 'version', 'response'], token, portal.sessionSecret));
      redirect(res, '/hq/verdicts?result=reviewed'); return true;
    }
    if (path === '/app/account/course-checkout' && req.method === 'POST') {
      const fields = await form(req, ['csrf', 'commandId'], token, portal.sessionSecret);
      const target = new URL(await commerce.courseCheckout(token, fields.commandId ?? ''));
      if (target.protocol !== 'https:' || target.hostname !== 'checkout.stripe.com' || target.username || target.password) throw new MhpCommerceError(503, 'Course checkout is temporarily unavailable.');
      redirect(res, target.toString()); return true;
    }
    if (path === '/app/desk' && req.method === 'GET') {
      const [snapshot, credit] = await Promise.all([desk.snapshot(token), commerce.creditSnapshot(token)]);
      send(res, 200, deskPage({ snapshot, credit, csrf, billingEnabled: commerce.billingEnabled, message: url.searchParams.get('result') === 'archived' ? 'File archived. It still counts towards your lifetime allowance.' : undefined }), true); return true;
    }
    if (path === '/app/deals/archive' && req.method === 'POST') {
      const fields = await form(req, ['csrf', 'commandId', 'fileId', 'version', 'archived'], token, portal.sessionSecret);
      const fileId = await desk.archive(token, fields);
      redirect(res, fields.archived === 'true' ? '/app/desk?result=archived' : `/app/deals/${fileId}`); return true;
    }
    if (path === '/app/verdict') {
      const snapshot = await desk.snapshot(token);
      if (req.method === 'GET') {
        send(res, 200, verdictPage({ snapshot, csrf, submitted: url.searchParams.get('result') === 'submitted' }), true); return true;
      }
      const fields = await form(req, ['csrf', 'commandId', 'confirm', ...VERDICT_FIELDS.map(field => field.key)], token, portal.sessionSecret);
      try { await desk.submitVerdict(token, fields); }
      catch (error) {
        if (error instanceof MhpCommerceError && error.status === 400) { send(res, 400, verdictPage({ snapshot, csrf, values: fields, error: error.message }), true); return true; }
        throw error;
      }
      redirect(res, '/app/verdict?result=submitted'); return true;
    }
    const calculatorId = path.startsWith('/app/calculators/') ? path.split('/').at(-1)! : undefined;
    const existingId = path.startsWith('/app/deals/') && path !== '/app/deals/archive' ? path.split('/').at(-1)! : undefined;
    if ((calculatorId || existingId) && req.method === 'GET') {
      const snapshot = await desk.snapshot(token, existingId);
      if (!snapshot.access.calculators) throw new MhpCommerceError(403, 'Calculator access is not included in your current membership.');
      if (existingId && !snapshot.selected) throw new MhpCommerceError(404, 'This deal file is not available in your workspace.');
      const calculator = calculatorId ?? snapshot.selected!.calculator;
      if (!mhpCalculator(calculator)) throw new MhpCommerceError(404, 'Calculator not found.');
      send(res, 200, calculatorPage({ snapshot, csrf, calculator, saved: url.searchParams.get('result') === 'saved' }), true); return true;
    }
    if (calculatorId && req.method === 'POST') {
      const definition = mhpCalculator(calculatorId)!;
      const fields = await form(req, ['csrf', 'commandId', 'calculator', 'fileId', 'version', 'title', 'address', 'notes', 'action', ...definition.fields.map(field => `input_${field.key}`)], token, portal.sessionSecret);
      if (fields.calculator !== calculatorId || !['calculate', 'save'].includes(fields.action ?? '')) throw new MhpCommerceError(400, 'Choose calculate or save.');
      const snapshot = await desk.snapshot(token, fields.fileId || undefined);
      if (!snapshot.access.calculators) throw new MhpCommerceError(403, 'Calculator access is not included in your current membership.');
      if (fields.fileId && (!snapshot.selected || snapshot.selected.calculator !== calculatorId)) throw new MhpCommerceError(404, 'This calculator does not match the saved file.');
      try {
        if (fields.action === 'save') {
          const fileId = await desk.save(token, fields); redirect(res, `/app/deals/${fileId}?result=saved`); return true;
        }
        const calculation = calculateMhpDeal(calculatorId, Object.fromEntries(definition.fields.map(field => [field.key, fields[`input_${field.key}`] ?? ''])));
        send(res, 200, calculatorPage({ snapshot, csrf, calculator: calculatorId, values: fields, calculation }), true); return true;
      } catch (error) {
        if (error instanceof MhpCalculatorInputError || error instanceof MhpCommerceError && error.status === 400) {
          send(res, 400, calculatorPage({ snapshot, csrf, calculator: calculatorId, values: fields, error: error.message,
            errorField: error instanceof MhpCalculatorInputError ? error.field : undefined }), true); return true;
        }
        throw error;
      }
    }
    throw new MhpCommerceError(405, 'Use the controls in Your Desk.');
  } catch (error) {
    outcome = 'service_error';
    send(res, error instanceof MhpCommerceError ? error.status : 503, error instanceof MhpCommerceError ? error.message : 'Your Desk is temporarily unavailable. Please try again shortly.');
  } finally { await Promise.allSettled(leases.map(lease => portal.abuse!.complete(lease, outcome))); }
  return true;
}
