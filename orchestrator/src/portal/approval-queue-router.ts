/**
 * Routes for the shared approval queue and the campaign journey page.
 *
 * Every POST applies the strictest checks any underlying area uses: the deployment's own https origin and host
 * (as the Property Predator follow-up flow workspace requires), Origin equal to that origin, same-origin fetch
 * metadata, a form content type, a bounded body and the session-bound CSRF token. Workspace and actor always come
 * from the signed-in session; the browser only returns refs the server signed for this session.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PortalSessionIdentity } from './auth-service.js';
import { portalCsrfToken, verifyPortalCsrf } from './session.js';
import { APPROVAL_QUEUE_BATCH_MAX, APPROVAL_QUEUE_BATCH_ROUTE, APPROVAL_QUEUE_DECIDE_ROUTE, APPROVAL_QUEUE_ROUTE, decisionErrorMessage,
  verifyApprovalRef, type ApprovalQueueService, type ApprovalRef } from './approval-queue-service.js';
import { CAMPAIGN_JOURNEY_ROUTE, type CampaignJourneyService } from './campaign-journey-service.js';
import { renderApprovalQueueBody, renderBatchResultsBody, renderCampaignJourneyBody } from './approval-queue-view.js';

export interface ApprovalQueueRouteInput {
  readonly queue: Pick<ApprovalQueueService, 'list' | 'decide' | 'batch'>;
  readonly journey: Pick<CampaignJourneyService, 'snapshot'>;
  readonly identity: PortalSessionIdentity | null;
  readonly requestId: string;
  readonly sessionSecret: string;
  /** The deployment's public origin. POSTs are refused without it. */
  readonly portalBaseUrl?: string;
  readonly actionCentre: boolean;
  readonly now: () => number;
  /** Wraps a body in the portal shell for this deployment. */
  readonly shell: (title: string, body: string, csrf: string) => string;
}

const MAX_BODY = 64 * 1024;
const PAGE_CSP = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self'; media-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
class RouteError extends Error { constructor(readonly status: number, message: string) { super(message); } }

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
  if (!/^application\/x-www-form-urlencoded/iu.test(String(req.headers['content-type'] ?? ''))) throw new RouteError(415, 'Use the form on the page.');
  if (Number(req.headers['content-length'] ?? 0) > MAX_BODY) throw new RouteError(413, 'Too many items at once. Select fewer and try again.');
  const chunks: Buffer[] = []; let size = 0;
  for await (const raw of req) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as string);
    size += chunk.length; if (size > MAX_BODY) throw new RouteError(413, 'Too many items at once. Select fewer and try again.');
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

/** Same rules as the PP native flow workspace (followup-flow-router.ts), applied to every queue POST. */
function assertStrictOrigin(req: IncomingMessage, url: URL, portalBaseUrl: string | undefined): void {
  let origin: URL;
  try { origin = new URL(portalBaseUrl ?? ''); } catch { throw new RouteError(503, 'Approvals cannot be changed on this address. Nothing was changed.'); }
  if (origin.protocol !== 'https:' || req.headers.host?.toLowerCase() !== origin.host.toLowerCase()) throw new RouteError(404, 'Approvals are not available on this address.');
  if (url.search || req.headers.origin !== origin.origin
    || (req.headers['sec-fetch-site'] !== undefined && req.headers['sec-fetch-site'] !== 'same-origin')) throw new RouteError(403, 'Refresh the page and try again. Nothing was changed.');
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
      if (method !== 'GET' && method !== 'HEAD') throw new RouteError(405, 'Use the buttons on the page.');
      if (path === CAMPAIGN_JOURNEY_ROUTE) {
        send(res, 200, input.shell('Campaign results', renderCampaignJourneyBody(await input.journey.snapshot(identity, input.requestId)), csrf)); return true;
      }
      const snapshot = await input.queue.list(identity, input.requestId);
      const notice = readNotice(input.sessionSecret, identity.sessionToken, url.searchParams.get('n'));
      send(res, 200, input.shell('Approvals', renderApprovalQueueBody(snapshot, { csrf, now: input.now(), notice, actionCentre: input.actionCentre }), csrf)); return true;
    }
    if (method !== 'POST') throw new RouteError(405, 'Use the buttons on the page.');
    assertStrictOrigin(req, url, input.portalBaseUrl);
    const form = await readForm(req);
    if (!verifyPortalCsrf(input.sessionSecret, identity.sessionToken, form.get('_csrf') ?? undefined)) throw new RouteError(403, 'Your page expired. Refresh it and try again. Nothing was changed.');
    const now = input.now();
    if (path === APPROVAL_QUEUE_DECIDE_ROUTE) {
      const refs = form.getAll('ref'), action = form.get('action');
      if (refs.length !== 1 || (action !== 'approve' && action !== 'refuse')) throw new RouteError(400, 'Use the buttons on the page.');
      const ref = verifyApprovalRef(input.sessionSecret, identity.sessionToken, refs[0], now);
      if (!ref) throw new RouteError(409, 'This page is out of date. Refresh it and review the item again. Nothing was changed.');
      let text: string, ok = true;
      try { text = await input.queue.decide(identity, input.requestId, ref, action, form.get('confirmed') === '1'); }
      catch (error) { ok = false; text = decisionErrorMessage(error); }
      redirect(res, `${APPROVAL_QUEUE_ROUTE}?n=${encodeURIComponent(approvalNotice(input.sessionSecret, identity.sessionToken, ok, `${ref.n}: ${text}`))}`); return true;
    }
    // Batch: each selected item is approved through its own path, one at a time.
    const tokens = [...new Set(form.getAll('ref'))];
    if (!tokens.length) throw new RouteError(400, 'Select at least one item to approve.');
    if (tokens.length > APPROVAL_QUEUE_BATCH_MAX) throw new RouteError(400, `Select up to ${APPROVAL_QUEUE_BATCH_MAX} items at a time. Nothing was changed.`);
    const refs: ApprovalRef[] = [];
    for (const token of tokens) {
      const ref = verifyApprovalRef(input.sessionSecret, identity.sessionToken, token, now);
      if (!ref) throw new RouteError(409, 'This page is out of date. Refresh it and select the items again. Nothing was changed.');
      refs.push(ref);
    }
    send(res, 200, input.shell('Approval results', renderBatchResultsBody(await input.queue.batch(identity, input.requestId, refs)), csrf)); return true;
  } catch (error) {
    const known = error instanceof RouteError;
    send(res, known ? error.status : 503, input.shell('Approvals', `<div class="aq"><h1>Approvals</h1><p>${(known ? error.message : 'Approvals are temporarily unavailable. Nothing was changed.').replace(/[&<>"']/gu, (c) => `&#${c.charCodeAt(0)};`)}</p><p><a href="${APPROVAL_QUEUE_ROUTE}">Back to approvals</a></p></div>`, csrf));
    return true;
  }
}
