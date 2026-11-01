import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PostgresPortalDeps } from '../portal/router.js';
import { portalCsrfToken, verifyPortalCsrf } from '../portal/session.js';
import { principalAbuseAdmission, sourceAbuseAdmission, type PortalAbuseRouteClass } from '../portal/abuse.js';
import { parseCookies } from '../server/admin/session.js';
import { MHP_AUTH_ORIGIN, MHP_SESSION_COOKIE } from './auth-service.js';
import { MhpCommerceError } from './commerce-service.js';
import { MHP_EVENT_PHONE_CAPABILITY_COOKIE, MHP_EVENT_PHONE_OWNER_ROUTE, MHP_EVENT_PHONE_ROUTE, type MhpEventPhoneOwner,
  type PgMhpEventPhonePublic } from './event-phone-service.js';
import { mhpEventPhoneChoosePage, mhpEventPhoneMessagePage, mhpEventPhoneOpenPage, mhpEventPhoneOwnerPage, mhpEventPhoneRequestPage,
  mhpEventPhoneSentPage } from './event-phone-view.js';

const CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
function send(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'content-length': String(Buffer.byteLength(body)), 'cache-control': 'no-store',
    'referrer-policy': 'same-origin', 'x-content-type-options': 'nosniff', 'content-security-policy': CSP, ...headers });
  res.end(body);
}
async function form(req: IncomingMessage, allowed: readonly string[], required: readonly string[] = allowed): Promise<URLSearchParams> {
  if (!/^application\/x-www-form-urlencoded(?:;\s*charset=utf-8)?$/iu.test(String(req.headers['content-type'] ?? ''))) throw new MhpCommerceError(415, 'Use the form on this page.');
  if (Number(req.headers['content-length'] ?? 0) > 8_192) throw new MhpCommerceError(413, 'This form is too large.');
  const parts: Buffer[] = []; let size = 0;
  for await (const raw of req) {
    const part = Buffer.isBuffer(raw) ? raw : Buffer.from(raw); size += part.length;
    if (size > 8_192) throw new MhpCommerceError(413, 'This form is too large.');
    parts.push(part);
  }
  const fields = new URLSearchParams(Buffer.concat(parts).toString('utf8'));
  if ([...fields.keys()].some(key => !allowed.includes(key) || fields.getAll(key).length !== 1) || required.some(key => !fields.has(key))) {
    throw new MhpCommerceError(400, 'Refresh the page and try again.');
  }
  return fields;
}
const sameOrigin = (req: IncomingMessage): boolean => req.headers.origin === MHP_AUTH_ORIGIN
  && (!req.headers['sec-fetch-site'] || req.headers['sec-fetch-site'] === 'same-origin');
const capabilityCookie = (value: string, maxAge: number): string =>
  `${MHP_EVENT_PHONE_CAPABILITY_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Strict`;
async function admit(portal: PostgresPortalDeps, admission: ReturnType<typeof sourceAbuseAdmission>, leases: Buffer[]): Promise<void> {
  if (!admission || !portal.abuse) throw new MhpCommerceError(503, 'This page is temporarily unavailable.');
  const decision = await portal.abuse.admit(admission);
  if (!decision.allowed) throw new MhpCommerceError(429, 'Too many requests. Please wait a few minutes and try again.');
  if (decision.leaseHash) leases.push(decision.leaseHash);
}

type Public = Pick<PgMhpEventPhonePublic, 'requestLink' | 'open' | 'status' | 'choose' | 'withdraw' | 'senderNumber'>;
/** Anonymous registrant pages: no session, no owner context, no CRM access. */
export async function handleMhpEventPhonePublic(req: IncomingMessage, res: ServerResponse, url: URL,
  dependencies: { portal: PostgresPortalDeps; reminders: Public }): Promise<boolean> {
  const path = url.pathname.replace(/\/+$/, '');
  const action = path === MHP_EVENT_PHONE_ROUTE ? '' : path.startsWith(`${MHP_EVENT_PHONE_ROUTE}/`) ? path.slice(MHP_EVENT_PHONE_ROUTE.length + 1) : null;
  if (action === null || !['', 'open', 'choose', 'withdraw'].includes(action)) return false;
  const { portal, reminders } = dependencies, leases: Buffer[] = [];
  let outcome: 'success' | 'service_error' = 'success';
  try {
    const method = req.method ?? 'GET';
    const context = portal.requestContext?.(req), now = portal.now?.() ?? Date.now();
    if (!context || !portal.abuse) throw new MhpCommerceError(503, 'This page is temporarily unavailable.');
    const source = context.sourceHash ? Buffer.from(context.sourceHash) : null;
    const capability = parseCookies(req.headers.cookie)[MHP_EVENT_PHONE_CAPABILITY_COOKIE] ?? '';
    const csrf = capability ? portalCsrfToken(portal.sessionSecret, `mhp.event-phone:${capability}`) : '';
    if (method === 'GET') {
      await admit(portal, sourceAbuseAdmission(context, 'read.page', now), leases);
      if (action === '' && url.search === '') { send(res, 200, mhpEventPhoneRequestPage()); return true; }
      if (action === 'open' && [...url.searchParams.keys()].join() === 't') { send(res, 200, mhpEventPhoneOpenPage(url.searchParams.get('t') ?? '')); return true; }
      if (action === 'choose' && url.search === '') {
        const status = await reminders.status(capability);
        if (!status) { send(res, 401, mhpEventPhoneMessagePage('Your link has expired', 'Ask for a new email link to continue. It works for 15 minutes.')); return true; }
        send(res, 200, mhpEventPhoneChoosePage({ status, csrf, sender: reminders.senderNumber })); return true;
      }
      throw new MhpCommerceError(404, 'This page does not exist.');
    }
    if (method !== 'POST') throw new MhpCommerceError(405, 'Use the form on this page.');
    const routeClass: PortalAbuseRouteClass = 'auth.setup';
    await admit(portal, sourceAbuseAdmission(context, routeClass, now), leases);
    if (!sameOrigin(req)) throw new MhpCommerceError(403, 'Use the form on this page.');
    if (action === '') {
      const fields = await form(req, ['email']);
      await reminders.requestLink(fields.get('email') ?? '', source);
      send(res, 200, mhpEventPhoneSentPage()); return true;
    }
    if (action === 'open') {
      const fields = await form(req, ['t']);
      const opened = await reminders.open(fields.get('t') ?? '', source);
      if (!('capability' in opened)) {
        send(res, 400, mhpEventPhoneMessagePage(opened.reason === 'expired' ? 'That link has expired' : 'That link has already been used',
          'Ask for a new email link to continue. Each link works once, for 15 minutes.')); return true;
      }
      res.writeHead(303, { location: `${MHP_EVENT_PHONE_ROUTE}/choose`, 'cache-control': 'no-store', 'referrer-policy': 'same-origin',
        'set-cookie': capabilityCookie(opened.capability, 900) });
      res.end(); return true;
    }
    if (action === 'choose') {
      const fields = await form(req, ['csrf', 'mobile', 'consent'], ['csrf', 'mobile']);
      if (!capability || !verifyPortalCsrf(portal.sessionSecret, `mhp.event-phone:${capability}`, fields.get('csrf') ?? '')) throw new MhpCommerceError(403, 'Your link has expired. Ask for a new email link.');
      const choice = await reminders.choose(capability, fields.get('mobile') ?? '', fields.get('consent') === 'yes', source);
      const status = await reminders.status(capability);
      if (!status) { send(res, 401, mhpEventPhoneMessagePage('Your link has expired', 'Ask for a new email link to continue.')); return true; }
      if ('reason' in choice) {
        const message = choice.reason === 'closed' ? 'Text reminders for this webinar are closed.' : choice.reason === 'number_unavailable'
          ? 'That number is already being used for this webinar. Use your own mobile number.' : 'Your link has expired. Ask for a new email link.';
        send(res, 409, mhpEventPhoneChoosePage({ status, csrf, sender: reminders.senderNumber, notice: message })); return true;
      }
      send(res, 200, mhpEventPhoneChoosePage({ status, csrf, sender: reminders.senderNumber, ...(choice.alreadyVerified ? { notice: 'That number is already confirmed.' }
        : { join: { nonce: choice.nonce, joinExpiresAt: choice.joinExpiresAt, sender: reminders.senderNumber } }) })); return true;
    }
    const fields = await form(req, ['csrf', 'receiptId']);
    if (!capability || !verifyPortalCsrf(portal.sessionSecret, `mhp.event-phone:${capability}`, fields.get('csrf') ?? '')) throw new MhpCommerceError(403, 'Your link has expired. Ask for a new email link.');
    const stopped = await reminders.withdraw(capability, fields.get('receiptId') ?? '');
    send(res, stopped ? 200 : 409, mhpEventPhoneMessagePage(stopped ? 'Webinar texts stopped' : 'Nothing to stop',
      stopped ? "We won't text you about this webinar. Your email reminders carry on." : 'There is no active text reminder for this link.')); return true;
  } catch (error) {
    outcome = 'service_error';
    const status = error instanceof MhpCommerceError ? error.status : 503;
    send(res, status, mhpEventPhoneMessagePage(status === 429 ? 'Slow down a moment' : status >= 500 ? 'Something went wrong' : 'Please check the form',
      error instanceof MhpCommerceError ? error.message : 'Webinar text reminders are temporarily unavailable. Please try again shortly.'));
    return true;
  } finally { await Promise.allSettled(leases.map(lease => portal.abuse!.complete(lease, outcome))); }
}

type Owner = Pick<MhpEventPhoneOwner, 'programmes' | 'saveProgramme' | 'publishProgramme' | 'review' | 'activate' | 'control'>;
const OWNER_FIELDS: Readonly<Record<string, readonly string[]>> = {
  save: ['startsAt', 'dueAt', 'providerDeadline', 'admissionUntil', 'sourceItemId', 'sourceVersionId', 'sourceSha256', 'previousItemId', 'previousVersionId'],
  publish: ['itemId', 'versionId'],
  activate: ['programmeVersionId', 'programmeSha256', 'reviewSha256', 'receipts', 'agreed'],
  control: ['calendarId', 'programmeVersionId', 'action'],
};
/** Owner programme, exact-recipient review, the one schedule action and hold/cancel. */
export async function handleMhpEventPhoneOwner(req: IncomingMessage, res: ServerResponse, url: URL,
  dependencies: { portal: PostgresPortalDeps; owner: Owner; campaign: string }): Promise<boolean> {
  const path = url.pathname.replace(/\/+$/, '');
  if (path !== MHP_EVENT_PHONE_OWNER_ROUTE && !path.startsWith(`${MHP_EVENT_PHONE_OWNER_ROUTE}/`)) return false;
  const action = path.slice(MHP_EVENT_PHONE_OWNER_ROUTE.length + 1), { portal, owner } = dependencies;
  const leases: Buffer[] = []; let outcome: 'success' | 'service_error' = 'success';
  try {
    if (path === MHP_EVENT_PHONE_OWNER_ROUTE ? req.method !== 'GET' : req.method !== 'POST' || !Object.hasOwn(OWNER_FIELDS, action)) throw new MhpCommerceError(405, 'Use the webinar texts page controls.');
    const context = portal.requestContext?.(req), now = portal.now?.() ?? Date.now();
    if (!context || !portal.abuse || !portal.abuseHashSecret) throw new MhpCommerceError(503, 'Webinar texts are unavailable.');
    const routeClass: PortalAbuseRouteClass = req.method === 'GET' ? 'read.page' : 'command';
    await admit(portal, sourceAbuseAdmission(context, routeClass, now), leases);
    const token = parseCookies(req.headers.cookie)[MHP_SESSION_COOKIE] ?? '', identity = token ? await portal.auth.resolve(token, now) : null;
    if (!identity) { res.writeHead(303, { location: '/portal/login', 'cache-control': 'no-store' }); res.end(); return true; }
    await admit(portal, principalAbuseAdmission(context, routeClass, portal.abuseHashSecret, identity, now), leases);
    const csrf = portalCsrfToken(portal.sessionSecret, token);
    const render = async (programmeVersionId: string | null, notice?: string, result?: Record<string, unknown>) => {
      const programmes = await owner.programmes(identity, context.requestId);
      const selected = programmes.find(p => p.contentVersionId === programmeVersionId) ?? programmes[0] ?? null;
      let review = null, reviewError: string | undefined;
      if (selected && selected.approvalStatus === 'approved' && !selected.approvalStale) {
        try { review = await owner.review(identity, context.requestId, selected.contentVersionId); }
        catch (error) { reviewError = error instanceof MhpCommerceError ? error.message : 'The review is unavailable.'; }
      }
      return mhpEventPhoneOwnerPage({ programmes, selected, review, reviewError, csrf, commandId: randomUUID(), campaign: dependencies.campaign, notice, result });
    };
    if (req.method === 'GET') {
      const keys = [...url.searchParams.keys()];
      if (keys.some(key => key !== 'programme' || url.searchParams.getAll(key).length !== 1)) throw new MhpCommerceError(400, 'Choose a saved programme.');
      send(res, 200, await render(url.searchParams.get('programme'))); return true;
    }
    if (!sameOrigin(req)) throw new MhpCommerceError(403, 'Use the webinar texts page.');
    const fields = await form(req, ['csrf', 'commandId', ...OWNER_FIELDS[action]!], ['csrf', 'commandId', ...OWNER_FIELDS[action]!.filter(f => f !== 'agreed')]);
    if (!verifyPortalCsrf(portal.sessionSecret, token, fields.get('csrf') ?? '')) throw new MhpCommerceError(403, 'Refresh the webinar texts page before continuing.');
    const field = (key: string): string => fields.get(key) ?? '', commandId = field('commandId');
    if (action === 'save') {
      const saved = await owner.saveProgramme(identity, context.requestId, { commandId, startsAt: field('startsAt'), dueAt: field('dueAt'), providerDeadline: field('providerDeadline'),
        admissionUntil: field('admissionUntil'), sourceItemId: field('sourceItemId'), sourceVersionId: field('sourceVersionId'), sourceSha256: field('sourceSha256'),
        previousItemId: field('previousItemId'), previousVersionId: field('previousVersionId') }, now);
      send(res, 200, await render(saved.contentVersionId, 'Programme saved. Approve it to open reminders; nobody is scheduled yet.')); return true;
    }
    if (action === 'publish') {
      await owner.publishProgramme(identity, context.requestId, field('itemId'), field('versionId'), commandId);
      send(res, 200, await render(field('versionId'), 'Programme approved. Registrants can now opt in; review recipients below before any text is scheduled.')); return true;
    }
    if (action === 'activate') {
      let revisions: Record<string, number>;
      try { revisions = JSON.parse(field('receipts')) as Record<string, number>; } catch { throw new MhpCommerceError(400, 'Refresh the review.'); }
      if (!revisions || typeof revisions !== 'object' || Array.isArray(revisions)) throw new MhpCommerceError(400, 'Refresh the review.');
      const result = await owner.activate(identity, context.requestId, { commandId, programmeVersionId: field('programmeVersionId'), programmeSha256: field('programmeSha256'),
        receiptIds: Object.keys(revisions), revisions, reviewSha256: field('reviewSha256'), agreed: field('agreed') === 'yes' }, now);
      send(res, 200, await render(field('programmeVersionId'), result.replayed ? 'This batch was already scheduled. Nothing new was created.'
        : `${String(result.count)} reminder(s) scheduled for the reviewed time. No text has been sent yet.`, result)); return true;
    }
    const control = field('action');
    if (control !== 'hold' && control !== 'cancel') throw new MhpCommerceError(400, 'Refresh the schedule.');
    await owner.control(identity, context.requestId, { commandId, action: control, calendarId: field('calendarId') });
    send(res, 200, await render(field('programmeVersionId'), control === 'cancel' ? 'Reminder cancelled.' : 'Reminder held. It will not send unless you schedule a new review.')); return true;
  } catch (error) {
    outcome = 'service_error';
    const status = error instanceof MhpCommerceError ? error.status : 503;
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': CSP });
    res.end(error instanceof MhpCommerceError ? error.message : 'Webinar texts are unavailable. Check the recorded status before retrying.');
    return true;
  } finally { await Promise.allSettled(leases.map(lease => portal.abuse!.complete(lease, outcome))); }
}
