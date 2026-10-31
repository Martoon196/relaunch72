import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PostgresPortalDeps } from '../portal/router.js';
import { portalCsrfToken, verifyPortalCsrf } from '../portal/session.js';
import { principalAbuseAdmission, sourceAbuseAdmission } from '../portal/abuse.js';
import { parseCookies } from '../server/admin/session.js';
import { MHP_AUTH_ORIGIN, MHP_SESSION_COOKIE } from './auth-service.js';
import { MhpCommerceError } from './commerce-service.js';
import type { MhpOwnedSmsService } from './owned-sms-service.js';
import { mhpOwnedSmsPage } from './owned-sms-view.js';

export const MHP_OWNED_SMS_ROUTE = '/hq/marketing/phone-test';
type Service = Pick<MhpOwnedSmsService, 'snapshot' | 'review' | 'save' | 'bind' | 'requestCode' | 'confirmCode' | 'send'>;
const FIELDS: Readonly<Record<string, readonly string[]>> = {
  connect: ['ownershipEvidence', 'regulatoryEvidence', 'confirmed'], 'request-code': [],
  'confirm-code': ['challengeId', 'code'], save: ['bodyText', 'itemId', 'previousVersionId'],
  send: ['itemId', 'versionId', 'pointId', 'sha256', 'agreed'],
};
function send(res: ServerResponse, status: number, body: string, html = false): void {
  res.writeHead(status, { 'content-type': html ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8',
    'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" }); res.end(body);
}
async function form(req: IncomingMessage, fields: readonly string[]): Promise<URLSearchParams> {
  if (!/^application\/x-www-form-urlencoded(?:;\s*charset=utf-8)?$/iu.test(String(req.headers['content-type'] ?? ''))) throw new MhpCommerceError(415, 'Use the MHP phone-test form.');
  if (Number(req.headers['content-length'] ?? 0) > 12_000) throw new MhpCommerceError(413, 'This phone-test form is too large.');
  const parts: Buffer[] = []; let size = 0;
  for await (const raw of req) { const part = Buffer.isBuffer(raw) ? raw : Buffer.from(raw); size += part.length;
    if (size > 12_000) throw new MhpCommerceError(413, 'This phone-test form is too large.'); parts.push(part); }
  const result = new URLSearchParams(Buffer.concat(parts).toString('utf8')), allowed = ['csrf', 'commandId', ...fields];
  if (result.size !== allowed.length || [...result.keys()].some(key => !allowed.includes(key) || result.getAll(key).length !== 1)) throw new MhpCommerceError(400, 'Refresh the MHP phone-test form.');
  return result;
}
export async function handleMhpOwnedSms(req: IncomingMessage, res: ServerResponse, url: URL,
  dependencies: { portal: PostgresPortalDeps; sms: Service }): Promise<boolean> {
  const path = url.pathname.replace(/\/+$/, '');
  if (path !== MHP_OWNED_SMS_ROUTE && !path.startsWith(`${MHP_OWNED_SMS_ROUTE}/`)) return false;
  const action = path.slice(MHP_OWNED_SMS_ROUTE.length + 1), { portal, sms } = dependencies;
  const leases: Buffer[] = []; let outcome: 'success' | 'service_error' = 'success';
  try {
    if (path === MHP_OWNED_SMS_ROUTE ? req.method !== 'GET' : req.method !== 'POST' || !Object.hasOwn(FIELDS, action)) throw new MhpCommerceError(405, 'Use the phone-test page controls.');
    const context = portal.requestContext?.(req), now = portal.now?.() ?? Date.now();
    if (!context || !portal.abuse || !portal.abuseHashSecret) throw new MhpCommerceError(503, 'MHP phone-test access is unavailable.');
    const reserve = async (admission: ReturnType<typeof sourceAbuseAdmission>) => {
      if (!admission) throw new MhpCommerceError(503, 'MHP phone-test access is unavailable.');
      const decision = await portal.abuse!.admit(admission); if (!decision.allowed) throw new MhpCommerceError(429, 'Too many requests. Try again shortly.');
      if (decision.leaseHash) leases.push(decision.leaseHash);
    };
    await reserve(sourceAbuseAdmission(context, req.method === 'GET' ? 'read.page' : 'command', now));
    const token = parseCookies(req.headers.cookie)[MHP_SESSION_COOKIE] ?? '', identity = token ? await portal.auth.resolve(token, now) : null;
    if (!identity) { res.writeHead(303, { location: '/portal/login', 'cache-control': 'no-store' }); res.end(); return true; }
    await reserve(principalAbuseAdmission(context, req.method === 'GET' ? 'read.page' : 'command', portal.abuseHashSecret, identity, now));
    const page = async (extra: Partial<Parameters<typeof mhpOwnedSmsPage>[0]> = {}) => mhpOwnedSmsPage({
      snapshot: await sms.snapshot(identity, context.requestId), csrf: portalCsrfToken(portal.sessionSecret, token), commandId: randomUUID(), ...extra });
    if (req.method === 'GET') {
      if ([...url.searchParams.keys()].some(key => !['item', 'version'].includes(key) || url.searchParams.getAll(key).length !== 1)
          || url.searchParams.has('item') !== url.searchParams.has('version')) throw new MhpCommerceError(400, 'Choose an exact saved MHP text.');
      const detail = url.searchParams.has('item') ? await sms.review(identity, context.requestId, url.searchParams.get('item')!, url.searchParams.get('version')!) : undefined;
      send(res, 200, await page({ detail }), true); return true;
    }
    if (req.headers.origin !== MHP_AUTH_ORIGIN || req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') throw new MhpCommerceError(403, 'Use the MHP phone-test page.');
    const fields = await form(req, FIELDS[action]!), field = (key: string) => fields.get(key)!;
    if (!verifyPortalCsrf(portal.sessionSecret, token, field('csrf'))) throw new MhpCommerceError(403, 'Refresh the phone-test page before continuing.');
    const commandId = field('commandId');
    if (action === 'connect') { await sms.bind(identity, context.requestId, { ownershipEvidence: field('ownershipEvidence'), regulatoryEvidence: field('regulatoryEvidence'), confirmed: field('confirmed') === 'yes' }, now); send(res, 200, await page({ notice: 'MHP sender connection recorded. Verify your owned phone next.' }), true); }
    else if (action === 'request-code') { const challengeId = await sms.requestCode(identity, context.requestId, commandId); send(res, 200, await page({ challengeId, notice: 'Verification requested. Enter the six-digit code here when it arrives.' }), true); }
    else if (action === 'confirm-code') { const verified = await sms.confirmCode(identity, context.requestId, field('challengeId'), field('code')); send(res, 200, await page({ challengeId: verified ? undefined : field('challengeId'), notice: verified ? 'Your owned phone is verified. Review one test text below.' : 'The code did not match or expired. Check it and try again.' }), true); }
    else if (action === 'save') { const saved = await sms.save(identity, context.requestId, { commandId, bodyText: field('bodyText'), itemId: field('itemId'), previousVersionId: field('previousVersionId') });
      const detail = await sms.review(identity, context.requestId, saved.contentItemId, saved.contentVersionId); send(res, 200, await page({ detail, notice: 'Text saved. Review the exact message and one-test agreement before sending.' }), true); }
    else { const result = await sms.send(identity, context.requestId, { commandId, itemId: field('itemId'), versionId: field('versionId'), pointId: field('pointId'), sha256: field('sha256'), agreed: field('agreed') === 'yes' }, now);
      send(res, 200, await page({ result, notice: result.replayed ? 'This is the saved outcome of your earlier request. No new text queued.' : 'One test was queued. Refresh its recorded status to follow delivery.' }), true); }
  } catch (error) { outcome = 'service_error'; send(res, error instanceof MhpCommerceError ? error.status : 503,
    error instanceof MhpCommerceError ? error.message : 'MHP phone-test access is unavailable. Check recorded status before retrying.');
  } finally { await Promise.allSettled(leases.map(lease => portal.abuse!.complete(lease, outcome))); }
  return true;
}
