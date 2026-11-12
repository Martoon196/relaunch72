/**
 * Routes for the shared approval queue and the campaign journey page.
 *
 * Every POST applies the strictest checks any underlying area uses: the deployment's own https origin and host
 * (as the Property Predator follow-up flow workspace requires), Origin equal to that origin, same-origin fetch
 * metadata, a form content type, a bounded body and the session-bound CSRF token. The actor always comes from the
 * signed-in session; the browser only returns refs the server signed for this session.
 *
 * Which business: GET pages take ?brand=<id>, which the services resolve against the brand workspaces the user
 * manages. A POST carries the business twice, in the page's hidden field and inside each signed ref; they must
 * agree, a batch is for one business only, and the decision itself only ever uses the signed one.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PortalSessionIdentity } from './auth-service.js';
import { portalCsrfToken, verifyPortalCsrf } from './session.js';
import { APPROVAL_QUEUE_BATCH_MAX, APPROVAL_QUEUE_BATCH_ROUTE, APPROVAL_QUEUE_DECIDE_ROUTE, APPROVAL_QUEUE_ROUTE, ApprovalQueueError, BRAND_ALL, brandQuery, decisionErrorMessage,
  verifyApprovalRef, type ApprovalQueueService, type ApprovalRef } from './approval-queue-service.js';
import { CAMPAIGN_JOURNEY_ROUTE, type CampaignJourneyService } from './campaign-journey-service.js';
import { renderApprovalOverviewBody, renderApprovalQueueBody, renderBatchResultsBody, renderCampaignJourneyBody } from './approval-queue-view.js';

export interface ApprovalQueueRouteInput {
  readonly queue: Pick<ApprovalQueueService, 'select' | 'list' | 'overview' | 'decide' | 'batch'>;
  readonly journey: Pick<CampaignJourneyService, 'snapshot'>;
  readonly identity: PortalSessionIdentity | null;
  readonly requestId: string;
  readonly sessionSecret: string;
  /** The deployment's public origin. POSTs are refused without it. */
  readonly portalBaseUrl?: string;
  readonly actionCentre: boolean;
  /** True on the central content address, where only the content pages are served (no Action Centre, CRM or portal home). */
  readonly central?: boolean;
  readonly now: () => number;
  /** Wraps a body in the portal shell for this deployment. */
  readonly shell: (title: string, body: string, csrf: string) => string;
}

const MAX_BODY = 64 * 1024;
const PAGE_CSP = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self'; media-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
export class ApprovalRouteError extends Error { constructor(readonly status: number, message: string) { super(message); } }

function send(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
    'content-security-policy': PAGE_CSP, 'permissions-policy': 'camera=(), microphone=(), geolocation=()' });
  res.end(body);
}
function redirect(res: ServerResponse, location: string): void { res.writeHead(303, { location, 'cache-control': 'no-store' }); res.end(); }

const NOTICE_CONTEXT = 'relaunch72:approval-queue-notice:v1\0';
function noticeMac(secret: string, sessionToken: string, payload: string): string {
  return createHmac('sha256', secret).update(NOTICE_CONTEXT).update(sessionToken).update('\0').update(payload).digest('base64url');
}
/** Session-bound notice so a link cannot put arbitrary words on the page. */
export function approvalNotice(secret: string, sessionToken: string, ok: boolean, text: string): string {
  const payload = Buffer.from(`${ok ? 1 : 0}${text.slice(0, 400)}`).toString('base64url');
  return `${payload}.${noticeMac(secret, sessionToken, payload)}`;
}
function readNotice(secret: string, sessionToken: string, value: string | null): { ok: boolean; text: string } | null {
  const [payload, given] = (value ?? '').split('.');
  if (!payload || !given) return null;
  const a = Buffer.from(given), b = Buffer.from(noticeMac(secret, sessionToken, payload));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const raw = Buffer.from(payload, 'base64url').toString('utf8');
  return { ok: raw.startsWith('1'), text: raw.slice(1) };
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  if (!/^application\/x-www-form-urlencoded/iu.test(String(req.headers['content-type'] ?? ''))) throw new ApprovalRouteError(415, 'Use the form on the page.');
  if (Number(req.headers['content-length'] ?? 0) > MAX_BODY) throw new ApprovalRouteError(413, 'Too many items at once. Select fewer and try again.');
  const chunks: Buffer[] = []; let size = 0;
  for await (const raw of req) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as string);
    size += chunk.length; if (size > MAX_BODY) throw new ApprovalRouteError(413, 'Too many items at once. Select fewer and try again.');
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

/**
 * Same rules as the PP native flow workspace (followup-flow-router.ts), applied to every queue POST.
 * `portalBaseUrl` is the one origin this deployment answers on: the Property Predator address on that host, and
 * https://app.relaunch72.com on the central content mount, which sets it itself (and has already refused any other
 * Host or Origin before the request gets here). The request must name that exact host and that exact https Origin:
 * a missing, "null", repeated or other site's Origin is refused, as is an http Origin for the same host, and a
 * form signed on one address is never accepted on the other.
 */
export function assertStrictOrigin(req: Pick<IncomingMessage, 'headers'>, url: URL, portalBaseUrl: string | undefined): void {
  let origin: URL;
  try { origin = new URL(portalBaseUrl ?? ''); } catch { throw new ApprovalRouteError(503, 'Approvals cannot be changed on this address. Nothing was changed.'); }
  const host = req.headers.host;
  if (origin.protocol !== 'https:' || typeof host !== 'string' || host.toLowerCase() !== origin.host.toLowerCase()) throw new ApprovalRouteError(404, 'Approvals are not available on this address.');
  const sent = req.headers.origin, site = req.headers['sec-fetch-site'];
  if (url.search || typeof sent !== 'string' || sent !== origin.origin
    || (site !== undefined && site !== 'same-origin')) throw new ApprovalRouteError(403, 'Refresh the page and try again. Nothing was changed.');
}

/** Returns false when the path is not one of ours. */
export async function handleApprovalQueue(req: IncomingMessage, res: ServerResponse, url: URL, input: ApprovalQueueRouteInput): Promise<boolean> {
  const path = url.pathname.replace(/\/+$/u, '');
  const ours = [APPROVAL_QUEUE_ROUTE, APPROVAL_QUEUE_DECIDE_ROUTE, APPROVAL_QUEUE_BATCH_ROUTE, CAMPAIGN_JOURNEY_ROUTE] as readonly string[];
  if (!ours.includes(path)) return false;
  const method = req.method ?? 'GET';
  const identity = input.identity;
  if (!identity) { redirect(res, '/portal/login'); return true; }
  const csrf = portalCsrfToken(input.sessionSecret, identity.sessionToken);
  try {
    if (path === APPROVAL_QUEUE_ROUTE || path === CAMPAIGN_JOURNEY_ROUTE) {
      if (method !== 'GET' && method !== 'HEAD') throw new ApprovalRouteError(405, 'Use the buttons on the page.');
      // Untrusted selector: a repeated value is refused, and the services check it against the brands this user manages.
      const asked = url.searchParams.getAll('brand');
      if (asked.length > 1) throw new ApprovalRouteError(400, 'Choose one business.');
      const requested = asked[0] ?? null;
      if (path === CAMPAIGN_JOURNEY_ROUTE) {
        send(res, 200, input.shell('Campaign results', renderCampaignJourneyBody(await input.journey.snapshot(identity, input.requestId, requested), { central: input.central }), csrf)); return true;
      }
      if (requested === BRAND_ALL) {
        const overview = await input.queue.overview(identity, input.requestId);
        if (overview.selection.view === 'all') {
          send(res, 200, input.shell('All businesses', renderApprovalOverviewBody(overview, { actionCentre: input.actionCentre, central: input.central }), csrf)); return true;
        }
      }
      const snapshot = await input.queue.list(identity, input.requestId, requested === BRAND_ALL ? null : requested);
      const notice = readNotice(input.sessionSecret, identity.sessionToken, url.searchParams.get('n'));
      send(res, 200, input.shell('Approvals', renderApprovalQueueBody(snapshot, { csrf, now: input.now(), notice, actionCentre: input.actionCentre, central: input.central }), csrf)); return true;
    }
    if (method !== 'POST') throw new ApprovalRouteError(405, 'Use the buttons on the page.');
    assertStrictOrigin(req, url, input.portalBaseUrl);
    const form = await readForm(req);
    if (!verifyPortalCsrf(input.sessionSecret, identity.sessionToken, form.get('_csrf') ?? undefined)) throw new ApprovalRouteError(403, 'Your page expired. Refresh it and try again. Nothing was changed.');
    const now = input.now();
    // The business the page was showing. It never chooses where a decision lands (the signed ref does); it must simply agree.
    const pages = form.getAll('brand');
    if (pages.length !== 1) throw new ApprovalRouteError(400, 'Use the buttons on the page.');
    const pageBrand = pages[0]!.toLowerCase();
    const WRONG_BUSINESS = 'This item belongs to a different business. Open that business and review it there. Nothing was changed.';
    // Back to the same business. If it can no longer be opened, back to the signed-in account's own view.
    const backTo = async (brandId: string): Promise<string> => {
      try { return `${APPROVAL_QUEUE_ROUTE}${brandQuery(await input.queue.select(identity, input.requestId, brandId))}`; }
      catch { return `${APPROVAL_QUEUE_ROUTE}${brandQuery({ selected: null, view: 'account' })}`; }
    };
    if (path === APPROVAL_QUEUE_DECIDE_ROUTE) {
      const refs = form.getAll('ref'), action = form.get('action');
      if (refs.length !== 1 || (action !== 'approve' && action !== 'refuse')) throw new ApprovalRouteError(400, 'Use the buttons on the page.');
      const ref = verifyApprovalRef(input.sessionSecret, identity.sessionToken, refs[0], now);
      if (!ref) throw new ApprovalRouteError(409, 'This page is out of date. Refresh it and review the item again. Nothing was changed.');
      if (ref.b !== pageBrand) throw new ApprovalRouteError(409, WRONG_BUSINESS);
      let text: string, ok = true;
      try { text = await input.queue.decide(identity, input.requestId, ref, action, form.get('confirmed') === '1'); }
      catch (error) { ok = false; text = decisionErrorMessage(error); }
      redirect(res, `${await backTo(ref.b)}&n=${encodeURIComponent(approvalNotice(input.sessionSecret, identity.sessionToken, ok, `${ref.n}: ${text}`))}`); return true;
    }
    // Batch: each selected item is approved through its own path, one at a time, and only for the one business on the page.
    const tokens = [...new Set(form.getAll('ref'))];
    if (!tokens.length) throw new ApprovalRouteError(400, 'Select at least one item to approve.');
    if (tokens.length > APPROVAL_QUEUE_BATCH_MAX) throw new ApprovalRouteError(400, `Select up to ${APPROVAL_QUEUE_BATCH_MAX} items at a time. Nothing was changed.`);
    const refs: ApprovalRef[] = [];
    for (const token of tokens) {
      const ref = verifyApprovalRef(input.sessionSecret, identity.sessionToken, token, now);
      if (!ref) throw new ApprovalRouteError(409, 'This page is out of date. Refresh it and select the items again. Nothing was changed.');
      refs.push(ref);
    }
    if (refs.some((ref) => ref.b !== pageBrand)) throw new ApprovalRouteError(409, 'Approve one business at a time. Nothing was changed.');
    send(res, 200, input.shell('Approval results', renderBatchResultsBody(await input.queue.batch(identity, input.requestId, refs), await backTo(pageBrand)), csrf)); return true;
  } catch (error) {
    const known = error instanceof ApprovalRouteError || error instanceof ApprovalQueueError;
    send(res, known ? error.status : 503, input.shell('Approvals', `<div class="aq"><h1>Approvals</h1><p>${(known ? error.message : 'Approvals are temporarily unavailable. Nothing was changed.').replace(/[&<>"']/gu, (c) => `&#${c.charCodeAt(0)};`)}</p><p><a href="${APPROVAL_QUEUE_ROUTE}">Back to approvals</a></p></div>`, csrf));
    return true;
  }
}
