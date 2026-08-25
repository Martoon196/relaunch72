/**
 * The client portal — routes + the auth gate. Everything under /portal requires
 * a valid session except account actions. A discriminated dependency boundary
 * keeps canonical PostgreSQL workspaces separate from the local JSON demo.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import type { PlatformCapability } from '../platform/capabilities.js';
import { parseCookies } from '../server/admin/session.js';
import {
  PORTAL_COOKIE,
  PORTAL_LOGIN_CSRF_COOKIE,
  PORTAL_SETUP_COOKIE,
  signTenant,
  verifyTenant,
  portalCookie,
  clearPortalCookie,
  portalSetupCookie,
  clearPortalSetupCookie,
  portalSetupCsrfToken,
  verifyPortalSetupCookie,
  verifyPortalSetupCsrf,
  isPortalSetupToken,
  portalCsrfToken,
  verifyPortalCsrf,
  portalLoginCsrfToken,
  portalLoginCsrfCookie,
  verifyPortalLoginCsrf,
  InMemorySetupThrottle,
} from './session.js';
import type { InMemoryLoginThrottle } from './session.js';
import { accountSetupPage, accountSetupUnavailablePage, loginPage, dashboardPage, billingPage } from './views.js';
import { appShell, escapeHtml } from './ui.js';
import { renderGrowthHomeBody } from './growth-home.js';
import { renderLead360Body } from './lead-360-view.js';
import { JOURNEY_BOARD_CLIENT_SOURCE } from './journey-board-client.js';
import {
  JOURNEY_BOARD_CLIENT_ROUTE,
  JOURNEY_BOARD_ROUTE,
  renderJourneyBoardBody,
} from './journey-board-view.js';
import { renderJourneyManagerBody } from './journey-manager-view.js';
import {
  JOURNEY_MANAGER_CONFIRMATION,
  JOURNEY_MANAGER_INSTALL_ROUTE,
  JOURNEY_MANAGER_ROUTE,
  journeyManagerNoticeFromQuery,
  journeyManagerNoticeToken,
  presentJourneyManager,
  type JourneyManagerNoticeCode,
} from './journey-manager-presenter.js';
import type { PortalJourneyManagerService } from './journey-manager-service.js';
import {
  CONTENT_CONTROL_ROOM_ROUTE,
  presentContentControlRoom,
} from './content-control-room-presenter.js';
import { renderContentControlRoomBody } from './content-control-room-view.js';
import type { PortalCompanyContentService } from './company-content-service.js';
import {
  CONVERSION_INBOX_MAX_CONVERSATIONS,
  CONVERSION_INBOX_ROUTE,
  normaliseConversionInboxFilters,
  presentConversionInbox,
  type ConversionInboxThreadSnapshot,
} from './conversion-inbox-presenter.js';
import { renderConversionInboxBody } from './conversion-inbox-view.js';
import type { InboxConversationQuery } from '../inbox-pg/read-model.js';
import type { InboxConversationPage } from '../inbox-pg/types.js';
import { RELAUNCH72_PRODUCT_PROFILE, type PortalProductProfile } from './product-profile.js';
import {
  CRM_PORTAL_ROUTES,
  renderCrmContactsBody,
  renderCrmPipelineBody,
  renderCrmTasksBody,
  type CreateLeadFormState,
  type CrmNotice,
  type CrmWorkspaceSnapshot,
} from './crm-views.js';
import {
  crmNoticeFromQuery,
  crmNoticeToken,
  type PortalCrmMutationOutcome,
  type PortalCrmNoticeCode,
  type PortalCrmRequestIdentity,
  type PortalCrmService,
} from './crm-service.js';
import type { DashboardData } from './data.js';
import type { BillingView } from './billing.js';
import type { PortalAuthRequestContext, PortalAuthService, PortalSessionIdentity } from './auth-service.js';

interface PortalCommonDeps {
  sessionSecret: string;
  secure: boolean;
  /** Deployment-owned presentation. It never grants permissions or provider readiness. */
  productProfile?: PortalProductProfile;
  /** Process-local login limiter; replace with a shared implementation at multi-instance scale. */
  loginThrottle?: Pick<InMemoryLoginThrottle, 'reserve' | 'release' | 'failure' | 'success'>;
  /** Process-local setup limiter; keys are hashed source and token fingerprints only. */
  setupThrottle?: Pick<InMemorySetupThrottle, 'reserve' | 'release' | 'failure' | 'success'>;
  /**
   * Optional deployment-owned client address policy. It may inspect proxy
   * headers only after the deployment has authenticated its trusted proxy.
   * Without it, no shared socket/proxy address is used for source blocking.
   */
  trustedClientAddress?: (req: IncomingMessage) => string | undefined;
  now?: () => number;
  requestId?: () => string;
}

/** Explicit local-demo mode. This is the only mode allowed to touch JSON stores. */
export interface LegacyPortalDeps extends PortalCommonDeps {
  kind: 'legacy';
  /** Email + password → tenant id, or null if the credentials don't match. */
  login(email: string, password: string): Promise<string | null>;
  /** Consume a new customer's one-time setup token and set their password. */
  completeSetup?(token: string, password: string, now: number): Promise<string | null>;
  /** Assemble the dashboard for a tenant (CRM + brand + artifacts), or null. */
  dashboard(tenantId: string): Promise<DashboardData | null>;
  /** Run this period's marketing for a tenant (mock); returns how many tasks ran. */
  runTick(tenantId: string): Promise<number>;
  /** Resolve a tenant's billing status + plan options; absent = billing UI off. */
  billing?(tenantId: string): Promise<BillingView | null>;
  /** Start a subscription checkout for a plan; returns the Stripe URL to redirect to. */
  subscribeUrl?(plan: string, email: string | null): Promise<string>;
  /** Open the Stripe billing portal for an existing customer; returns the URL. */
  manageUrl?(customerId: string): Promise<string>;
  /** When true, "Run this week" requires an active subscription. Default false (£0 demo runs). */
  billingEnforced?: boolean;
  /** Durable CRM application boundary. Absent means the CRM remains visibly locked. */
  crm?: PortalCrmService;
}

/** Canonical PostgreSQL mode. No legacy tenant id or JSON dependency exists here. */
export interface PostgresPortalDeps extends PortalCommonDeps {
  kind: 'postgres';
  auth: PortalAuthService;
  crm: PortalCrmService;
  /** Exact, read-mostly conversion definition manager. Omitted until composed and ready. */
  journeys?: PortalJourneyManagerService;
  /** Company-owned immutable content catalogue. It exposes no provider or publish operation. */
  companyContent?: PortalCompanyContentService;
  /** TEST-only conversion queue. Thread detail remains a separate optional projection. */
  inbox?: PortalInboxReadBoundary;
}

/**
 * Portal-facing inbox read boundary. Implementations own session resolution and
 * RLS context; the router never accepts a browser-supplied workspace id.
 */
export interface PortalInboxReadBoundary {
  listConversations(
    identity: PortalCrmRequestIdentity,
    query?: InboxConversationQuery,
  ): Promise<InboxConversationPage | null>;
  /** A real workspace-scoped projection only. Absence keeps the detail pane empty. */
  thread?(
    identity: PortalCrmRequestIdentity,
    conversationId: string,
  ): Promise<ConversionInboxThreadSnapshot | null>;
}

export type PortalDeps = LegacyPortalDeps | PostgresPortalDeps;

const DEFAULT_SETUP_THROTTLE = new InMemorySetupThrottle();
const SETUP_FAILURE_MESSAGE = 'This setup link is invalid, expired or has already been used. Contact support.';

function sendHtml(res: ServerResponse, code: number, body: string, cookie?: string | string[], extra: Record<string, string> = {}): void {
  const headers: Record<string, string | string[]> = {
    'content-type': 'text/html; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  };
  if (cookie) headers['set-cookie'] = cookie;
  Object.assign(headers, extra);
  res.writeHead(code, headers);
  res.end(body);
}

function sendJavaScript(res: ServerResponse, body: string): void {
  res.writeHead(200, {
    'content-type': 'text/javascript; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    // The asset has a stable URL, so every navigation must revalidate it after
    // a deploy rather than running markup against an hour-old enhancement.
    'cache-control': 'no-cache, max-age=0, must-revalidate',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  });
  res.end(body);
}

function sendLoginPage(
  res: ServerResponse,
  code: number,
  deps: Pick<PortalDeps, 'sessionSecret' | 'secure' | 'productProfile'>,
  error?: string,
  email = '',
  extra: Record<string, string> = {},
): void {
  const csrfToken = portalLoginCsrfToken(deps.sessionSecret);
  sendHtml(
    res,
    code,
    loginPage(error, email, csrfToken, deps.productProfile ?? RELAUNCH72_PRODUCT_PROFILE),
    portalLoginCsrfCookie(csrfToken, deps.secure),
    extra,
  );
}

function resolvedTrustedClientAddress(req: IncomingMessage, deps: PortalDeps): string | undefined {
  if (!deps.trustedClientAddress) return undefined;
  try {
    const candidate = deps.trustedClientAddress(req)?.trim();
    return candidate ? candidate.slice(0, 256) : undefined;
  } catch {
    return undefined;
  }
}

function sourceFingerprint(source: string): string {
  return createHash('sha256')
    .update('relaunch72/setup-source/v1\u0000')
    .update(source)
    .digest('hex');
}

function loginKeys(req: IncomingMessage, email: string, deps: PortalDeps): string[] {
  const accountHash = createHash('sha256')
    .update('relaunch72/login-account/v1\u0000')
    .update(email || 'unknown')
    .digest('hex');
  const keys = [`account:${accountHash}`];
  const source = resolvedTrustedClientAddress(req, deps);
  if (source) keys.push(`source:${sourceFingerprint(source)}`);
  return keys;
}

function setupKeys(req: IncomingMessage, setupToken: string, deps: PortalDeps): string[] {
  const tokenHash = createHash('sha256').update(setupToken).digest('hex');
  const keys = [`setup-token:${tokenHash}`];
  const source = resolvedTrustedClientAddress(req, deps);
  if (source) keys.unshift(`setup-source:${sourceFingerprint(source)}`);
  return keys;
}

function authRequestContext(req: IncomingMessage, now: number, deps: PortalDeps): PortalAuthRequestContext {
  const userAgent = Array.isArray(req.headers['user-agent'])
    ? req.headers['user-agent'][0]
    : req.headers['user-agent'];
  return {
    now,
    ipAddress: resolvedTrustedClientAddress(req, deps),
    userAgent: userAgent?.slice(0, 4_096),
  };
}
function redirect(
  res: ServerResponse,
  to: string,
  cookie?: string | string[],
  code = 302,
  extra: Record<string, string> = {},
): void {
  const headers: Record<string, string | string[]> = { location: to, ...extra };
  if (cookie) headers['set-cookie'] = cookie;
  res.writeHead(code, headers);
  res.end();
}
function readForm(req: IncomingMessage): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (value: Record<string, string>): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 64 * 1024) { chunks.length = 0; finish({}); return; }
      if (!settled) chunks.push(c);
    });
    req.on('end', () => {
      if (settled) return;
      const out: Record<string, string> = {};
      new URLSearchParams(Buffer.concat(chunks).toString('utf8')).forEach((v, k) => { out[k] = v; });
      finish(out);
    });
    req.on('error', () => finish({}));
  });
}

function crmPage(
  shell: Pick<CrmWorkspaceSnapshot, 'workspace'>,
  body: string,
  deps: PortalDeps,
  csrfToken: string,
): string {
  return appShell({
    title: `${deps.productProfile?.productName ?? 'Relaunch72'} CRM — ${shell.workspace.name}`,
    tenantName: shell.workspace.name,
    active: 'crm',
    productProfile: deps.productProfile,
    capabilities: new Set([
      'workspace.overview.read', 'crm.contacts.read', 'crm.pipeline.read', 'crm.tasks.read',
      ...((deps.kind === 'postgres' && deps.journeys) ? ['journeys.read'] as const : []),
      ...optionalPortalCapabilities(deps),
    ]),
    billingAvailable: deps.kind === 'legacy' && !!deps.billing,
    crmAvailable: true,
    mode: 'crm',
    csrfToken,
    body,
  });
}

function journeyManagerPage(
  shell: Pick<CrmWorkspaceSnapshot, 'workspace'>,
  body: string,
  deps: PostgresPortalDeps,
  csrfToken: string,
): string {
  return appShell({
    title: `${deps.productProfile?.productName ?? 'Relaunch72'} Journeys — ${shell.workspace.name}`,
    tenantName: shell.workspace.name,
    active: 'journeys',
    productProfile: deps.productProfile,
    capabilities: new Set([
      'workspace.overview.read', 'crm.contacts.read', 'crm.pipeline.read', 'crm.tasks.read', 'journeys.read',
      ...optionalPortalCapabilities(deps),
    ]),
    billingAvailable: false,
    crmAvailable: true,
    mode: 'crm',
    csrfToken,
    body,
  });
}

function journeyBoardPage(
  workspaceName: string,
  body: string,
  deps: PortalDeps,
  csrfToken: string,
): string {
  return appShell({
    title: `${deps.productProfile?.productName ?? 'Relaunch72'} Live Journeys — ${workspaceName}`,
    tenantName: workspaceName,
    active: 'journeys',
    productProfile: deps.productProfile,
    capabilities: new Set([
      'workspace.overview.read', 'crm.contacts.read', 'crm.pipeline.read', 'crm.tasks.read', 'journeys.read',
      ...optionalPortalCapabilities(deps),
    ]),
    billingAvailable: deps.kind === 'legacy' && !!deps.billing,
    crmAvailable: true,
    mode: 'crm',
    csrfToken,
    body,
  });
}

function journeySubnav(active: 'board' | 'rules'): string {
  return `<nav aria-label="Journey workspace" style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap"><a class="button ${active === 'board' ? '' : 'secondary'} compact" href="${JOURNEY_BOARD_ROUTE}"${active === 'board' ? ' aria-current="page"' : ''}>Live board</a><a class="button ${active === 'rules' ? '' : 'secondary'} compact" href="${JOURNEY_MANAGER_ROUTE}"${active === 'rules' ? ' aria-current="page"' : ''}>Journey rules</a></nav>`;
}

function optionalPortalCapabilities(deps: PortalDeps): readonly PlatformCapability[] {
  if (deps.kind !== 'postgres') return [];
  return [
    ...(deps.companyContent ? ['content.drafts.read'] as const : []),
    ...(deps.inbox ? ['conversations.read'] as const : []),
  ];
}

function operationalPage(
  workspaceName: string,
  body: string,
  deps: PostgresPortalDeps,
  active: 'content' | 'inbox',
  csrfToken: string,
): string {
  const label = active === 'content' ? 'Content Control' : 'Conversion Inbox';
  return appShell({
    title: `${deps.productProfile?.productName ?? 'Relaunch72'} ${label} — ${workspaceName}`,
    tenantName: workspaceName,
    active,
    productProfile: deps.productProfile,
    capabilities: new Set([
      'workspace.overview.read', 'crm.contacts.read', 'crm.pipeline.read', 'crm.tasks.read',
      ...(deps.journeys ? ['journeys.read'] as const : []),
      ...optionalPortalCapabilities(deps),
    ]),
    billingAvailable: false,
    crmAvailable: true,
    mode: 'crm',
    csrfToken,
    body,
  });
}

function portalStatusPage(
  deps: PortalDeps,
  sessionToken: string,
  options: {
    title: string;
    message: string;
    backHref?: string;
    backLabel?: string;
    active?: 'overview' | 'crm' | 'journeys' | 'content' | 'inbox' | 'billing';
    crmAvailable?: boolean;
  },
): string {
  const backHref = options.backHref ?? '/portal';
  const backLabel = options.backLabel ?? 'Return to workspace';
  const body = `<header class="page-heading"><div><div class="eyebrow">Workspace status</div><h1>${escapeHtml(options.title)}</h1><p>${escapeHtml(options.message)}</p></div></header>
    <section class="panel" aria-label="Recovery action"><div class="panel-body" style="padding-top:19px"><a class="button secondary" href="${escapeHtml(backHref)}">${escapeHtml(backLabel)}</a></div></section>`;
  return appShell({
    title: `${deps.productProfile?.productName ?? 'Relaunch72'} — ${options.title}`,
    tenantName: 'Your workspace',
    active: options.active ?? 'overview',
    productProfile: deps.productProfile,
    capabilities: new Set([
      'workspace.overview.read',
      ...((options.crmAvailable ?? !!deps.crm)
        ? ['crm.contacts.read', 'crm.pipeline.read', 'crm.tasks.read'] as const
        : []),
      ...((deps.kind === 'postgres' && deps.journeys) ? ['journeys.read'] as const : []),
      ...optionalPortalCapabilities(deps),
      ...((deps.kind === 'legacy' && !!deps.billing) ? ['billing.read'] as const : []),
    ]),
    billingAvailable: deps.kind === 'legacy' && !!deps.billing,
    crmAvailable: options.crmAvailable ?? !!deps.crm,
    mode: options.active === 'crm' || options.active === 'journeys'
      || options.active === 'content' || options.active === 'inbox' ? 'crm' : 'sandbox',
    csrfToken: portalCsrfToken(deps.sessionSecret, sessionToken),
    body,
  });
}

function crmIdentity(sessionToken: string, deps: PortalDeps): PortalCrmRequestIdentity {
  return {
    sessionToken,
    requestId: deps.requestId ? deps.requestId() : randomUUID(),
  };
}

function journeyRedirect(
  res: ServerResponse,
  deps: PostgresPortalDeps,
  sessionToken: string,
  code: JourneyManagerNoticeCode,
): void {
  const token = journeyManagerNoticeToken(deps.sessionSecret, sessionToken, code);
  redirect(res, `${JOURNEY_MANAGER_ROUTE}?notice=${encodeURIComponent(token)}`, undefined, 303);
}

function crmRedirect(
  res: ServerResponse,
  route: string,
  deps: PortalDeps,
  sessionToken: string,
  code: PortalCrmNoticeCode,
  status = 302,
  returnParams?: URLSearchParams,
): void {
  const token = crmNoticeToken(deps.sessionSecret, sessionToken, code);
  const query = new URLSearchParams({ notice: token });
  returnParams?.forEach((value, key) => query.set(key, value));
  redirect(res, `${route}?${query.toString()}`, undefined, status);
}

const JOURNEY_BOARD_RETURN_BANDS = new Set(['burning', 'hot', 'warm', 'quiet', 'unscored']);

function journeyBoardReturnParams(form: Readonly<Record<string, string>>): URLSearchParams {
  const query = new URLSearchParams();
  const search = (form.return_q ?? '').trim();
  if (search && search.length <= 120 && !/[\u0000-\u001f\u007f]/u.test(search)) query.set('q', search);
  const route = (form.return_route ?? '').trim();
  if (/^[a-z0-9][a-z0-9._-]{0,99}$/u.test(route)) query.set('route', route);
  const band = (form.return_band ?? '').trim();
  if (JOURNEY_BOARD_RETURN_BANDS.has(band)) query.set('band', band);
  return query;
}

function outcomeNotice(outcome: PortalCrmMutationOutcome): CrmNotice {
  if (outcome.ok) {
    return { kind: 'success', title: 'Saved', message: 'The CRM change was saved.' };
  }
  return {
    kind: outcome.kind === 'conflict' ? 'conflict' : outcome.kind === 'validation' ? 'error' : 'error',
    title: outcome.kind === 'forbidden' ? 'Read-only access'
      : outcome.kind === 'unavailable' ? 'CRM temporarily unavailable'
        : outcome.kind === 'not_found' ? 'Record not found'
          : outcome.kind === 'conflict' ? 'Record changed'
            : 'Check the lead details',
    message: outcome.message,
  };
}

const CRM_OBJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Handle a request under /portal. Always writes a response. */
export async function handlePortal(req: IncomingMessage, res: ServerResponse, deps: PortalDeps): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const p = url.pathname.replace(/\/+$/, '') || '/portal';
  const method = req.method ?? 'GET';
  if (p === JOURNEY_BOARD_CLIENT_ROUTE && method === 'GET') {
    return sendJavaScript(res, JOURNEY_BOARD_CLIENT_SOURCE);
  }
  const now = deps.now ? deps.now() : Date.now();
  const requestCookies = parseCookies(req.headers.cookie);
  const sessionToken = requestCookies[PORTAL_COOKIE] ?? '';
  const portalHome = '/portal';
  let tenantId: string | null = null;
  let portalIdentity: PortalSessionIdentity | null = null;
  // Public account actions must remain usable when a stale cookie exists and
  // the identity store is unavailable. Login/setup establish a new session;
  // logout validates its cookie-bound CSRF token without resolving first.
  const skipSessionResolution = p === '/portal/setup'
    || (p === '/portal/login' && method === 'POST')
    || (p === '/portal/logout' && method === 'POST');
  if (sessionToken && !skipSessionResolution) {
    try {
      if (deps.kind === 'postgres') {
        portalIdentity = await deps.auth.resolve(sessionToken, now);
      } else {
        tenantId = verifyTenant(deps.sessionSecret, sessionToken, now);
      }
    } catch {
      return sendLoginPage(res, 503, deps, 'Secure sign-in is temporarily unavailable. Try again shortly.');
    }
  }

  // ── one-time account setup / login / logout (no auth) ──
  if (p === '/portal/setup' && method === 'GET') {
    const linkedToken = url.searchParams.get('token');
    if (linkedToken !== null) {
      if (!isPortalSetupToken(linkedToken)) {
        return sendHtml(res, 400, accountSetupUnavailablePage(SETUP_FAILURE_MESSAGE), clearPortalSetupCookie(deps.secure), {
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
        });
      }
      // Move the capability out of subsequent URLs/HTML into an authenticated,
      // encrypted ten-minute HttpOnly cookie. The emailed URL remains usable
      // until database completion/reissue, and its first edge request still
      // requires query-string redaction in deployment logging.
      return redirect(res, '/portal/setup', portalSetupCookie(deps.sessionSecret, linkedToken, deps.secure, now), 303, {
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
      });
    }
    const setupEnabled = deps.kind === 'postgres'
      ? Boolean(deps.auth.completeSetup)
      : Boolean(deps.completeSetup);
    if (!setupEnabled) {
      return sendHtml(res, 503, accountSetupUnavailablePage(), undefined, {
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
      });
    }
    const setupCookieValue = requestCookies[PORTAL_SETUP_COOKIE];
    const setupToken = verifyPortalSetupCookie(deps.sessionSecret, setupCookieValue, now);
    if (!setupToken || !setupCookieValue) {
      return sendHtml(res, 400, accountSetupUnavailablePage(SETUP_FAILURE_MESSAGE), clearPortalSetupCookie(deps.secure), {
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
      });
    }
    return sendHtml(res, 200, accountSetupPage(portalSetupCsrfToken(deps.sessionSecret, setupCookieValue, now)), undefined, {
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    });
  }
  if (p === '/portal/setup' && method === 'POST') {
    const setup = deps.kind === 'postgres' ? deps.auth.completeSetup : deps.completeSetup;
    if (!setup) {
      return sendHtml(res, 503, accountSetupUnavailablePage());
    }
    const form = await readForm(req);
    const setupCookieValue = requestCookies[PORTAL_SETUP_COOKIE];
    const token = verifyPortalSetupCookie(deps.sessionSecret, setupCookieValue, now);
    if (!token || !setupCookieValue
        || !verifyPortalSetupCsrf(deps.sessionSecret, setupCookieValue, form._setup_csrf, now)) {
      // Do not clear a browser's setup cookie from a cross-site POST that did
      // not carry its Strict cookie/CSRF value. The underlying link can still
      // be revisited; terminal database invalidity is cleared below.
      return sendHtml(res, 403, accountSetupUnavailablePage(SETUP_FAILURE_MESSAGE), undefined, {
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
      });
    }
    const setupCsrf = portalSetupCsrfToken(deps.sessionSecret, setupCookieValue, now);
    const password = form.password ?? '';
    if (password.length < 12 || password.length > 1_024) {
      return sendHtml(res, 400, accountSetupPage(setupCsrf, 'Use a password between 12 and 1,024 characters.'), undefined, { 'cache-control': 'no-store' });
    }
    if (password !== (form.confirm ?? '')) {
      return sendHtml(res, 400, accountSetupPage(setupCsrf, 'Those passwords do not match.'), undefined, { 'cache-control': 'no-store' });
    }
    const throttle = deps.setupThrottle ?? DEFAULT_SETUP_THROTTLE;
    const keys = setupKeys(req, token, deps);
    const reservations: string[] = [];
    for (const key of keys) {
      const status = throttle.reserve(key, now);
      if (!status.allowed) {
        for (const reserved of reservations) throttle.release(reserved);
        return sendHtml(res, 429, accountSetupUnavailablePage(SETUP_FAILURE_MESSAGE), undefined, {
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
          'retry-after': String(status.retryAfterSeconds),
        });
      }
      reservations.push(key);
    }
    let completed;
    try {
      completed = deps.kind === 'postgres'
        ? await deps.auth.completeSetup!(token, password, authRequestContext(req, now, deps))
        : await deps.completeSetup!(token, password, now);
    } catch {
      for (const key of reservations) throttle.release(key);
      return sendHtml(res, 503, accountSetupPage(setupCsrf, 'Secure account setup is temporarily unavailable. Try again shortly.'), undefined, { 'cache-control': 'no-store' });
    }
    if (!completed) {
      for (const key of reservations) throttle.failure(key, now);
      return sendHtml(res, 400, accountSetupUnavailablePage(SETUP_FAILURE_MESSAGE), clearPortalSetupCookie(deps.secure), { 'cache-control': 'no-store' });
    }
    for (const key of reservations) throttle.success(key);
    const completedToken = typeof completed === 'string'
      ? signTenant(deps.sessionSecret, completed, now)
      : completed.sessionToken;
    return redirect(res, portalHome, [
      portalCookie(completedToken, deps.secure),
      clearPortalSetupCookie(deps.secure),
    ], 303);
  }
  if (p === '/portal/login' && method === 'GET') {
    if (tenantId || portalIdentity) return redirect(res, portalHome);
    const reason = url.searchParams.get('reason');
    const message = reason === 'workspace-unavailable'
      ? 'Your sign-in is valid, but this workspace is not ready in the new portal yet. Contact support.'
      : reason === 'session-ended'
        ? 'Your secure session ended. Sign in again to continue.'
        : undefined;
    return sendLoginPage(res, 200, deps, message);
  }
  if (p === '/portal/login' && method === 'POST') {
    const form = await readForm(req);
    const email = (form.email ?? '').trim().toLowerCase();
    const loginCsrfCookieToken = parseCookies(req.headers.cookie)[PORTAL_LOGIN_CSRF_COOKIE];
    if (!verifyPortalLoginCsrf(deps.sessionSecret, loginCsrfCookieToken, form._login_csrf)) {
      return sendLoginPage(res, 403, deps, 'Refresh the sign-in page and try again.', email);
    }
    const keys = loginKeys(req, email, deps);
    const reservations: string[] = [];
    for (const key of keys) {
      const throttle = deps.loginThrottle?.reserve(key, now);
      if (throttle && !throttle.allowed) {
        for (const reserved of reservations) deps.loginThrottle?.release(reserved);
        return sendLoginPage(res, 429, deps, 'Too many login attempts. Try again later.', email, {
          'retry-after': String(throttle.retryAfterSeconds),
        });
      }
      if (throttle) reservations.push(key);
    }
    let authenticated;
    try {
      authenticated = deps.kind === 'postgres'
        ? await deps.auth.login(email, form.password ?? '', authRequestContext(req, now, deps))
        : await deps.login(email, form.password ?? '');
    } catch {
      for (const key of reservations) deps.loginThrottle?.release(key);
      return sendLoginPage(res, 503, deps, 'Secure sign-in is temporarily unavailable. Try again shortly.', email);
    }
    if (!authenticated) {
      for (const key of keys) deps.loginThrottle?.failure(key, now);
      return sendLoginPage(res, 401, deps, 'Wrong email or password.', email);
    }
    for (const key of keys) deps.loginThrottle?.success(key);
    const authenticatedToken = typeof authenticated === 'string'
      ? signTenant(deps.sessionSecret, authenticated, now)
      : authenticated.sessionToken;
    return redirect(res, portalHome, portalCookie(authenticatedToken, deps.secure));
  }
  if (p === '/portal/logout' && method === 'POST') {
    const form = await readForm(req);
    if (!verifyPortalCsrf(deps.sessionSecret, sessionToken, form._csrf)) {
      return sendHtml(res, 403, portalStatusPage(deps, sessionToken, {
        title: 'Refresh needed', message: 'The secure form token was invalid. You are still signed in.',
      }));
    }
    if (deps.kind === 'postgres' && sessionToken) {
      try {
        await deps.auth.revoke(sessionToken);
      } catch {
        return sendHtml(res, 503, portalStatusPage(deps, sessionToken, {
          title: 'Sign-out did not finish',
          message: 'The secure session could not be revoked. You are still signed in; try again shortly.',
        }));
      }
    }
    return redirect(res, '/portal/login', clearPortalCookie(deps.secure));
  }

  // ── everything below requires a tenant session ──
  if (!tenantId && !portalIdentity) return redirect(
    res,
    sessionToken ? '/portal/login?reason=session-ended' : '/portal/login',
    sessionToken ? clearPortalCookie(deps.secure) : undefined,
  );

  // Canonical PostgreSQL Growth HQ. Only the secure CRM snapshot contributes
  // numbers; this route never falls back to the legacy JSON demo dashboard.
  if (deps.kind === 'postgres' && p === '/portal' && method === 'GET') {
    try {
      const snapshot = await deps.crm.snapshot(crmIdentity(sessionToken, deps));
      if (!snapshot) return sendHtml(res, 403, portalStatusPage(deps, sessionToken, {
        title: 'Workspace not available',
        message: 'This session no longer has access to the selected workspace.',
        active: 'overview',
      }));
      const profile = deps.productProfile ?? RELAUNCH72_PRODUCT_PROFILE;
      const growth = deps.crm.growth ? await deps.crm.growth(crmIdentity(sessionToken, deps)) : undefined;
      if (deps.crm.growth && !growth) return sendHtml(res, 403, portalStatusPage(deps, sessionToken, {
        title: 'Workspace not available',
        message: 'This session no longer has access to the selected workspace.',
        active: 'overview',
      }));
      const csrfToken = portalCsrfToken(deps.sessionSecret, sessionToken);
      return sendHtml(res, 200, appShell({
        title: `${profile.productName} — ${snapshot.workspace.name}`,
        tenantName: snapshot.workspace.name,
        active: 'overview',
        productProfile: profile,
        capabilities: new Set([
          'workspace.overview.read', 'crm.contacts.read', 'crm.pipeline.read', 'crm.tasks.read',
          ...(deps.journeys ? ['journeys.read'] as const : []),
          ...optionalPortalCapabilities(deps),
        ]),
        crmAvailable: true,
        mode: 'crm',
        csrfToken,
        body: renderGrowthHomeBody(snapshot, profile, growth ?? undefined),
      }));
    } catch {
      return sendHtml(res, 503, portalStatusPage(deps, sessionToken, {
        title: 'Growth HQ temporarily unavailable',
        message: 'No data was changed. Try again shortly.',
        active: 'overview',
      }));
    }
  }

  // ── company-owned content control: immutable catalogue evidence only ──
  if (deps.kind === 'postgres' && p === CONTENT_CONTROL_ROOM_ROUTE && method === 'GET') {
    if (!deps.companyContent) return sendHtml(res, 404, portalStatusPage(deps, sessionToken, {
      title: 'Content Control not connected',
      message: 'The company-owned content catalogue is not enabled for this workspace.',
      active: 'content',
    }));
    try {
      const outcome = await deps.companyContent.snapshot(crmIdentity(sessionToken, deps), {
        limit: 100,
      });
      if (!outcome.ok) {
        const status = outcome.kind === 'unauthenticated' || outcome.kind === 'forbidden'
          ? 403
          : outcome.kind === 'validation'
            ? 400
            : outcome.kind === 'not_found'
              ? 404
              : 503;
        return sendHtml(res, status, portalStatusPage(deps, sessionToken, {
          title: status === 503 ? 'Content Control temporarily unavailable' : 'Content Control not available',
          message: outcome.message,
          active: 'content',
          backHref: '/portal',
          backLabel: 'Return to Growth HQ',
        }));
      }
      const csrfToken = portalCsrfToken(deps.sessionSecret, sessionToken);
      const view = presentContentControlRoom(outcome.snapshot.catalog, {
        workspaceName: outcome.snapshot.workspace.workspaceName,
        asOf: outcome.snapshot.workspace.snapshotAt,
        filters: {
          query: url.searchParams.get('q') ?? '',
          channel: url.searchParams.get('channel') ?? '',
          format: url.searchParams.get('format') ?? '',
        },
      });
      return sendHtml(res, 200, operationalPage(
        outcome.snapshot.workspace.workspaceName,
        renderContentControlRoomBody(view),
        deps,
        'content',
        csrfToken,
      ));
    } catch {
      return sendHtml(res, 503, portalStatusPage(deps, sessionToken, {
        title: 'Content Control temporarily unavailable',
        message: 'No approval, version or provider state was changed. Try again shortly.',
        active: 'content',
        backHref: '/portal',
        backLabel: 'Return to Growth HQ',
      }));
    }
  }

  // ── TEST conversion inbox: queue read plus an explicitly separate detail projection ──
  if (deps.kind === 'postgres' && p === CONVERSION_INBOX_ROUTE && method === 'GET') {
    if (!deps.inbox) return sendHtml(res, 404, portalStatusPage(deps, sessionToken, {
      title: 'Conversion Inbox not connected',
      message: 'The TEST/SIMULATED conversation read service is not enabled for this workspace.',
      active: 'inbox',
    }));
    const filters = normaliseConversionInboxFilters({
      query: url.searchParams.get('q') ?? '',
      channel: url.searchParams.get('channel') ?? '',
      queue: url.searchParams.get('queue') ?? '',
    });
    const requestedConversation = (url.searchParams.get('conversation') ?? '').toLowerCase();
    const conversationId = CRM_OBJECT_ID.test(requestedConversation)
      ? requestedConversation
      : undefined;
    const identity = crmIdentity(sessionToken, deps);
    try {
      const [shell, page] = await Promise.all([
        deps.crm.workspaceShell ? deps.crm.workspaceShell(identity) : deps.crm.snapshot(identity),
        deps.inbox.listConversations(identity, {
          limit: CONVERSION_INBOX_MAX_CONVERSATIONS,
          channel: filters.channel === 'all' ? null : filters.channel,
          state: filters.queue === 'open' ? 'open' : null,
          search: filters.query || null,
        }),
      ]);
      if (!shell || !page || page.workspaceId !== shell.workspace.id) {
        return sendHtml(res, 403, portalStatusPage(deps, sessionToken, {
          title: 'Conversion Inbox workspace not available',
          message: 'This session cannot read a matching workspace-scoped TEST conversation queue.',
          active: 'inbox',
          backHref: '/portal',
          backLabel: 'Return to Growth HQ',
        }));
      }

      const options = {
        workspaceName: shell.workspace.name,
        filters: {
          query: filters.query,
          channel: filters.channel,
          queue: filters.queue,
          conversationId,
        },
      } as const;
      const queueOnly = presentConversionInbox({ page, threads: [] }, options);
      const selectedConversationId = queueOnly.conversations.find((item) => item.selected)?.conversationId;
      let threads: readonly ConversionInboxThreadSnapshot[] = [];
      if (selectedConversationId && deps.inbox.thread
          && page.conversations.some((item) => item.conversationId === selectedConversationId)) {
        const thread = await deps.inbox.thread(identity, selectedConversationId);
        // A mismatched or invisible projection never reaches the presenter.
        if (thread?.conversationId === selectedConversationId) threads = [thread];
      }
      const view = presentConversionInbox({ page, threads }, options);
      const csrfToken = portalCsrfToken(deps.sessionSecret, sessionToken);
      return sendHtml(res, 200, operationalPage(
        shell.workspace.name,
        renderConversionInboxBody(view),
        deps,
        'inbox',
        csrfToken,
      ));
    } catch {
      return sendHtml(res, 503, portalStatusPage(deps, sessionToken, {
        title: 'Conversion Inbox temporarily unavailable',
        message: 'No draft was queued and no message left Growth HQ. Try again shortly.',
        active: 'inbox',
        backHref: '/portal',
        backLabel: 'Return to Growth HQ',
      }));
    }
  }

  // ── live Journey Board: movable CRM workflow beside immutable evidence ──
  if (p === JOURNEY_BOARD_ROUTE && method === 'GET') {
    if (!deps.crm?.journeyBoard) return sendHtml(res, 404, portalStatusPage(deps, sessionToken, {
      title: 'Live journeys not connected',
      message: 'The protected operational board is not enabled for this workspace.',
      active: 'journeys',
    }));
    try {
      const board = await deps.crm.journeyBoard(crmIdentity(sessionToken, deps), {
        query: url.searchParams.get('q') ?? '',
        route: url.searchParams.get('route') ?? '',
        band: url.searchParams.get('band') ?? '',
      });
      if (!board) return sendHtml(res, 403, portalStatusPage(deps, sessionToken, {
        title: 'Journey workspace not available',
        message: 'This session no longer has access to the selected workspace.',
        active: 'journeys',
      }));
      const csrfToken = portalCsrfToken(deps.sessionSecret, sessionToken);
      const notice = crmNoticeFromQuery(url.searchParams, deps.sessionSecret, sessionToken);
      return sendHtml(
        res,
        200,
        journeyBoardPage(board.workspace.name, `${journeySubnav('board')}${renderJourneyBoardBody({
          ...board,
          csrfToken,
          notice,
        })}`, deps, csrfToken),
        undefined,
        {
          'content-security-policy': "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
        },
      );
    } catch {
      return sendHtml(res, 503, portalStatusPage(deps, sessionToken, {
        title: 'Live journeys temporarily unavailable',
        message: 'No workflow, journey evidence or outbound action was changed. Try again shortly.',
        active: 'journeys',
      }));
    }
  }

  // ── conversion Journey Manager: read-only topology plus explicit manager setup ──
  if (deps.kind === 'postgres' && p === JOURNEY_MANAGER_ROUTE && method === 'GET') {
    if (!deps.journeys) return sendHtml(res, 404, portalStatusPage(deps, sessionToken, {
      title: 'Journey Manager not connected',
      message: 'The protected journey definition service is not enabled for this workspace.',
      active: 'journeys',
    }));
    const identity = crmIdentity(sessionToken, deps);
    try {
      const [shell, snapshot] = await Promise.all([
        deps.crm.workspaceShell ? deps.crm.workspaceShell(identity) : deps.crm.snapshot(identity),
        deps.journeys.snapshot(identity),
      ]);
      if (!shell || !snapshot) return sendHtml(res, 403, portalStatusPage(deps, sessionToken, {
        title: 'Journey workspace not available',
        message: 'This session no longer has access to the selected workspace.',
        active: 'journeys',
      }));
      const csrfToken = portalCsrfToken(deps.sessionSecret, sessionToken);
      const view = presentJourneyManager(
        snapshot,
        shell.workspace.name,
        { csrfToken, commandKey: randomUUID() },
        journeyManagerNoticeFromQuery(url.searchParams, deps.sessionSecret, sessionToken),
      );
      return sendHtml(
        res,
        200,
        journeyManagerPage(shell, `${journeySubnav('rules')}${renderJourneyManagerBody(view)}`, deps, csrfToken),
      );
    } catch {
      return sendHtml(res, 503, portalStatusPage(deps, sessionToken, {
        title: 'Journey Manager temporarily unavailable',
        message: 'No definition, lead or outbound action was changed. Try again shortly.',
        active: 'journeys',
      }));
    }
  }

  if (deps.kind === 'postgres' && p === JOURNEY_MANAGER_INSTALL_ROUTE && method === 'POST') {
    if (!deps.journeys) return sendHtml(res, 404, portalStatusPage(deps, sessionToken, {
      title: 'Journey Manager not connected',
      message: 'The protected journey definition service is not enabled for this workspace.',
      active: 'journeys',
    }));
    const form = await readForm(req);
    if (!verifyPortalCsrf(deps.sessionSecret, sessionToken, form._csrf)) {
      return sendHtml(res, 403, portalStatusPage(deps, sessionToken, {
        title: 'Refresh needed',
        message: 'The secure form token was invalid. No journey definition was changed.',
        active: 'journeys',
        backHref: JOURNEY_MANAGER_ROUTE,
        backLabel: 'Return to journeys',
      }));
    }
    if (!CRM_OBJECT_ID.test(form.command_key ?? '') || form.confirmation !== JOURNEY_MANAGER_CONFIRMATION) {
      return journeyRedirect(res, deps, sessionToken, 'invalid');
    }
    try {
      const outcome = await deps.journeys.installFoundation({
        sessionToken,
        requestId: form.command_key!,
      });
      if (outcome.ok) {
        return journeyRedirect(res, deps, sessionToken, outcome.disposition === 'replayed' ? 'replayed' : 'installed');
      }
      const code: JourneyManagerNoticeCode = outcome.kind === 'forbidden'
        ? 'forbidden'
        : outcome.kind === 'conflict'
          ? 'conflict'
          : 'unavailable';
      return journeyRedirect(res, deps, sessionToken, code);
    } catch {
      return journeyRedirect(res, deps, sessionToken, 'unavailable');
    }
  }

  const journeyBoardMoveMatch = /^\/portal\/journeys\/board\/opportunities\/([^/]+)\/stage$/.exec(p);
  if (deps.crm && journeyBoardMoveMatch && method === 'POST') {
    const opportunityId = journeyBoardMoveMatch[1]!;
    if (!CRM_OBJECT_ID.test(opportunityId)) return sendHtml(res, 404, portalStatusPage(deps, sessionToken, {
      title: 'Opportunity not found',
      message: 'That workflow card address is not valid for this workspace.',
      active: 'journeys', backHref: JOURNEY_BOARD_ROUTE, backLabel: 'Return to live journeys',
    }));
    const form = await readForm(req);
    if (!verifyPortalCsrf(deps.sessionSecret, sessionToken, form._csrf)) {
      return sendHtml(res, 403, portalStatusPage(deps, sessionToken, {
        title: 'Refresh needed',
        message: 'The secure form token was invalid. No workflow or journey evidence was changed.',
        active: 'journeys', backHref: JOURNEY_BOARD_ROUTE, backLabel: 'Return to live journeys',
      }));
    }
    const returnParams = journeyBoardReturnParams(form);
    try {
      const outcome = await deps.crm.moveOpportunity(crmIdentity(sessionToken, deps), {
        commandKey: form.command_key ?? '',
        opportunityId,
        targetStageId: form.target_lane_id ?? '',
        expectedRowVersion: form.expected_version ?? '',
      });
      if (outcome.ok) return crmRedirect(
        res,
        JOURNEY_BOARD_ROUTE,
        deps,
        sessionToken,
        outcome.disposition === 'replayed' ? 'replayed' : 'moved',
        303,
        returnParams,
      );
      if (outcome.kind === 'conflict') return crmRedirect(res, JOURNEY_BOARD_ROUTE, deps, sessionToken, 'conflict', 303, returnParams);
      if (outcome.kind === 'not_found') return crmRedirect(res, JOURNEY_BOARD_ROUTE, deps, sessionToken, 'missing', 303, returnParams);
      return sendHtml(res, outcome.kind === 'forbidden' ? 403 : outcome.kind === 'unavailable' ? 503 : 400,
        portalStatusPage(deps, sessionToken, {
          title: 'Workflow lane was not changed',
          message: outcome.kind === 'validation'
            ? 'Refresh the board and choose a valid team workflow lane.'
            : outcome.message,
          active: 'journeys', backHref: JOURNEY_BOARD_ROUTE, backLabel: 'Return to live journeys',
        }));
    } catch {
      return sendHtml(res, 503, portalStatusPage(deps, sessionToken, {
        title: 'Live journeys temporarily unavailable',
        message: 'The workflow card was not moved. Journey evidence was not changed.',
        active: 'journeys', backHref: JOURNEY_BOARD_ROUTE, backLabel: 'Return to live journeys',
      }));
    }
  }

  // ── durable CRM: real service only; no fake fallback data ──
  if (p === '/portal/crm' && method === 'GET') {
    return deps.crm
      ? redirect(res, CRM_PORTAL_ROUTES.contacts)
      : sendHtml(res, 404, portalStatusPage(deps, sessionToken, {
        title: 'CRM not connected', message: 'The durable CRM is not enabled for this workspace.', crmAvailable: false,
      }));
  }

  const isCrmRoute = p.startsWith('/portal/crm/');
  if (isCrmRoute && !deps.crm) {
    return sendHtml(res, 404, portalStatusPage(deps, sessionToken, {
      title: 'CRM not connected', message: 'The durable CRM is not enabled for this workspace.', crmAvailable: false,
    }));
  }

  const lead360Match = /^\/portal\/crm\/contacts\/([^/]+)$/.exec(p);
  if (deps.crm && lead360Match && method === 'GET') {
    const contactId = lead360Match[1]!;
    if (!CRM_OBJECT_ID.test(contactId)) return sendHtml(res, 404, portalStatusPage(deps, sessionToken, {
      title: 'Lead not found',
      message: 'That Lead 360 address is not valid for this workspace.',
      active: 'crm', backHref: CRM_PORTAL_ROUTES.contacts, backLabel: 'Return to contacts',
    }));
    if (!deps.crm.lead360) return sendHtml(res, 404, portalStatusPage(deps, sessionToken, {
      title: 'Lead 360 not connected',
      message: 'This CRM service does not expose the read-only evidence case file yet.',
      active: 'crm', backHref: CRM_PORTAL_ROUTES.contacts, backLabel: 'Return to contacts',
    }));
    const identity = crmIdentity(sessionToken, deps);
    try {
      const shell = deps.crm.workspaceShell
        ? await deps.crm.workspaceShell(identity)
        : await deps.crm.snapshot(identity);
      if (!shell) return sendHtml(res, 403, portalStatusPage(deps, sessionToken, {
        title: 'CRM workspace not available',
        message: 'This session no longer has access to the durable CRM workspace.',
        active: 'crm', backHref: CRM_PORTAL_ROUTES.contacts, backLabel: 'Return to contacts',
      }));
      const caseFile = await deps.crm.lead360(identity, contactId);
      if (!caseFile) return sendHtml(res, 404, portalStatusPage(deps, sessionToken, {
        title: 'Lead not found',
        message: 'No RLS-visible contact exists at that address in this workspace.',
        active: 'crm', backHref: CRM_PORTAL_ROUTES.contacts, backLabel: 'Return to contacts',
      }));
      const csrfToken = portalCsrfToken(deps.sessionSecret, sessionToken);
      const body = `<nav aria-label="Lead 360 breadcrumb" style="margin-bottom:14px"><a class="button secondary compact" href="${CRM_PORTAL_ROUTES.contacts}">← All contacts</a></nav>${renderLead360Body(caseFile)}`;
      return sendHtml(res, 200, crmPage(shell, body, deps, csrfToken));
    } catch {
      return sendHtml(res, 503, portalStatusPage(deps, sessionToken, {
        title: 'Lead 360 temporarily unavailable',
        message: 'No data was changed. Return to contacts and try again shortly.',
        active: 'crm', backHref: CRM_PORTAL_ROUTES.contacts, backLabel: 'Return to contacts',
      }));
    }
  }

  if (deps.crm && method === 'GET' && [CRM_PORTAL_ROUTES.contacts, CRM_PORTAL_ROUTES.pipeline, CRM_PORTAL_ROUTES.tasks].includes(p as never)) {
    const identity = crmIdentity(sessionToken, deps);
    try {
      const snapshot = await deps.crm.snapshot(identity);
      if (!snapshot) return sendHtml(res, 403, portalStatusPage(deps, sessionToken, {
        title: 'CRM workspace not available', message: 'This session no longer has access to the durable CRM workspace.', active: 'crm',
      }));
      const csrfToken = portalCsrfToken(deps.sessionSecret, sessionToken);
      const notice = crmNoticeFromQuery(url.searchParams, deps.sessionSecret, sessionToken);
      const body = p === CRM_PORTAL_ROUTES.contacts
        ? renderCrmContactsBody(snapshot, { csrfToken, createLeadCommandKey: randomUUID(), notice })
        : p === CRM_PORTAL_ROUTES.pipeline
          ? renderCrmPipelineBody(snapshot, { csrfToken, notice })
          : renderCrmTasksBody(snapshot, {
            csrfToken,
            notice,
            filter: url.searchParams.get('status') === 'all' || url.searchParams.get('status') === 'completed'
              ? url.searchParams.get('status') as 'all' | 'completed'
              : 'open',
          });
      return sendHtml(res, 200, crmPage(snapshot, body, deps, csrfToken));
    } catch {
      return sendHtml(res, 503, portalStatusPage(deps, sessionToken, {
        title: 'CRM temporarily unavailable', message: 'No change was made. Try again after returning to the workspace.', active: 'crm',
      }));
    }
  }

  if (deps.crm && p === CRM_PORTAL_ROUTES.createLead && method === 'POST') {
    const form = await readForm(req);
    if (!verifyPortalCsrf(deps.sessionSecret, sessionToken, form._csrf)) {
      return sendHtml(res, 403, portalStatusPage(deps, sessionToken, {
        title: 'Refresh needed', message: 'The secure form token was invalid. No change was made.', active: 'crm', backHref: CRM_PORTAL_ROUTES.contacts, backLabel: 'Return to contacts',
      }));
    }
    const identity = crmIdentity(sessionToken, deps);
    const input = {
      commandKey: form.command_key ?? '',
      displayName: form.display_name ?? '',
      companyName: form.company_name ?? '',
      email: form.email ?? '',
      phone: form.phone ?? '',
      opportunityTitle: form.opportunity_title ?? '',
      stageId: form.stage_id ?? '',
      taskTitle: form.task_title ?? '',
      taskDueAt: form.task_due_at ?? '',
    };
    try {
      const outcome = await deps.crm.createLead(identity, input);
      if (outcome.ok) {
        return crmRedirect(res, CRM_PORTAL_ROUTES.contacts, deps, sessionToken, outcome.disposition === 'replayed' ? 'replayed' : 'created');
      }
      if (outcome.kind === 'conflict') return crmRedirect(res, CRM_PORTAL_ROUTES.contacts, deps, sessionToken, 'conflict');
      if (outcome.kind === 'not_found') return crmRedirect(res, CRM_PORTAL_ROUTES.contacts, deps, sessionToken, 'missing');

      const snapshot = await deps.crm.snapshot(identity);
      if (!snapshot) return sendHtml(res, 403, portalStatusPage(deps, sessionToken, {
        title: 'CRM workspace not available', message: 'This session no longer has access to the durable CRM workspace.', active: 'crm',
      }));
      const state: CreateLeadFormState = {
        values: {
          displayName: input.displayName,
          companyName: input.companyName,
          email: input.email,
          phone: input.phone,
          opportunityTitle: input.opportunityTitle,
          stageId: input.stageId,
          taskTitle: input.taskTitle,
          taskDueAt: input.taskDueAt,
        },
        fieldErrors: outcome.kind === 'validation' ? outcome.fieldErrors : undefined,
      };
      const commandKey = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.commandKey)
        ? input.commandKey : randomUUID();
      const body = renderCrmContactsBody(snapshot, {
        csrfToken: portalCsrfToken(deps.sessionSecret, sessionToken),
        createLeadCommandKey: commandKey,
        form: state,
        notice: outcomeNotice(outcome),
      });
      const status = outcome.kind === 'forbidden' ? 403 : outcome.kind === 'unavailable' ? 503 : 400;
      const csrfToken = portalCsrfToken(deps.sessionSecret, sessionToken);
      return sendHtml(res, status, crmPage(snapshot, body, deps, csrfToken));
    } catch {
      return sendHtml(res, 503, portalStatusPage(deps, sessionToken, {
        title: 'CRM temporarily unavailable', message: 'No lead was saved. Try again after returning to contacts.', active: 'crm', backHref: CRM_PORTAL_ROUTES.contacts, backLabel: 'Return to contacts',
      }));
    }
  }

  const moveMatch = /^\/portal\/crm\/opportunities\/([^/]+)\/stage$/.exec(p);
  if (deps.crm && moveMatch && method === 'POST') {
    if (!CRM_OBJECT_ID.test(moveMatch[1]!)) return sendHtml(res, 404, portalStatusPage(deps, sessionToken, {
      title: 'Opportunity not found', message: 'That opportunity address is not valid for this workspace.', active: 'crm', backHref: CRM_PORTAL_ROUTES.pipeline, backLabel: 'Return to pipeline',
    }));
    const form = await readForm(req);
    if (!verifyPortalCsrf(deps.sessionSecret, sessionToken, form._csrf)) {
      return sendHtml(res, 403, portalStatusPage(deps, sessionToken, {
        title: 'Refresh needed', message: 'The secure form token was invalid. No change was made.', active: 'crm', backHref: CRM_PORTAL_ROUTES.pipeline, backLabel: 'Return to pipeline',
      }));
    }
    try {
      const outcome = await deps.crm.moveOpportunity(crmIdentity(sessionToken, deps), {
        commandKey: form.command_key ?? '',
        opportunityId: moveMatch[1]!,
        targetStageId: form.target_stage_id ?? '',
        expectedRowVersion: form.expected_version ?? '',
      });
      if (outcome.ok) return crmRedirect(res, CRM_PORTAL_ROUTES.pipeline, deps, sessionToken, outcome.disposition === 'replayed' ? 'replayed' : 'moved');
      if (outcome.kind === 'conflict') return crmRedirect(res, CRM_PORTAL_ROUTES.pipeline, deps, sessionToken, 'conflict');
      if (outcome.kind === 'not_found') return crmRedirect(res, CRM_PORTAL_ROUTES.pipeline, deps, sessionToken, 'missing');
      return sendHtml(res, outcome.kind === 'forbidden' ? 403 : outcome.kind === 'unavailable' ? 503 : 400,
        portalStatusPage(deps, sessionToken, {
          title: 'Stage was not changed',
          message: outcome.kind === 'validation' ? 'Check the submitted values and refresh the pipeline.' : outcome.message,
          active: 'crm', backHref: CRM_PORTAL_ROUTES.pipeline, backLabel: 'Return to pipeline',
        }));
    } catch {
      return sendHtml(res, 503, portalStatusPage(deps, sessionToken, {
        title: 'CRM temporarily unavailable', message: 'The stage was not changed.', active: 'crm', backHref: CRM_PORTAL_ROUTES.pipeline, backLabel: 'Return to pipeline',
      }));
    }
  }

  const completeMatch = /^\/portal\/crm\/tasks\/([^/]+)\/complete$/.exec(p);
  if (deps.crm && completeMatch && method === 'POST') {
    if (!CRM_OBJECT_ID.test(completeMatch[1]!)) return sendHtml(res, 404, portalStatusPage(deps, sessionToken, {
      title: 'Task not found', message: 'That task address is not valid for this workspace.', active: 'crm', backHref: CRM_PORTAL_ROUTES.tasks, backLabel: 'Return to tasks',
    }));
    const form = await readForm(req);
    if (!verifyPortalCsrf(deps.sessionSecret, sessionToken, form._csrf)) {
      return sendHtml(res, 403, portalStatusPage(deps, sessionToken, {
        title: 'Refresh needed', message: 'The secure form token was invalid. No change was made.', active: 'crm', backHref: CRM_PORTAL_ROUTES.tasks, backLabel: 'Return to tasks',
      }));
    }
    try {
      const outcome = await deps.crm.completeTask(crmIdentity(sessionToken, deps), {
        commandKey: form.command_key ?? '',
        taskId: completeMatch[1]!,
        expectedRowVersion: form.expected_version ?? '',
      });
      if (outcome.ok) return crmRedirect(res, CRM_PORTAL_ROUTES.tasks, deps, sessionToken, outcome.disposition === 'replayed' ? 'replayed' : 'completed');
      if (outcome.kind === 'conflict') return crmRedirect(res, CRM_PORTAL_ROUTES.tasks, deps, sessionToken, 'conflict');
      if (outcome.kind === 'not_found') return crmRedirect(res, CRM_PORTAL_ROUTES.tasks, deps, sessionToken, 'missing');
      return sendHtml(res, outcome.kind === 'forbidden' ? 403 : outcome.kind === 'unavailable' ? 503 : 400,
        portalStatusPage(deps, sessionToken, {
          title: 'Task was not completed',
          message: outcome.kind === 'validation' ? 'Check the submitted values and refresh the task list.' : outcome.message,
          active: 'crm', backHref: CRM_PORTAL_ROUTES.tasks, backLabel: 'Return to tasks',
        }));
    } catch {
      return sendHtml(res, 503, portalStatusPage(deps, sessionToken, {
        title: 'CRM temporarily unavailable', message: 'The task was not changed.', active: 'crm', backHref: CRM_PORTAL_ROUTES.tasks, backLabel: 'Return to tasks',
      }));
    }
  }

  if (deps.kind === 'postgres') {
    return sendHtml(res, 404, portalStatusPage(deps, sessionToken, {
      title: 'Not available',
      message: 'That legacy portal feature is not part of this PostgreSQL workspace.',
      active: 'crm',
      backHref: CRM_PORTAL_ROUTES.contacts,
      backLabel: 'Return to CRM',
    }));
  }

  // The PostgreSQL branch returned above, so only the explicit local-demo
  // composition can reach JSON dashboards, billing and mock campaign runs.
  if (!tenantId) return redirect(res, '/portal/login?reason=session-ended', clearPortalCookie(deps.secure));

  if (p === '/portal' && method === 'GET') {
    const data = await deps.dashboard(tenantId);
    if (!data) return redirect(res, '/portal/login?reason=workspace-unavailable', clearPortalCookie(deps.secure)); // stale bridge
    const billing = deps.billing ? await deps.billing(tenantId) : null;
    return sendHtml(res, 200, dashboardPage(data, billing ?? undefined, {
      crmAvailable: !!deps.crm,
      csrfToken: portalCsrfToken(deps.sessionSecret, sessionToken),
    }));
  }

  if (p === '/portal/billing' && method === 'GET') {
    if (!deps.billing) return sendHtml(res, 404, '<h1>Billing not enabled</h1><p><a href="/portal">← dashboard</a></p>');
    const data = await deps.dashboard(tenantId);
    const billing = await deps.billing(tenantId);
    if (!billing) return redirect(res, '/portal');
    const notice = url.searchParams.get('need') ? 'A subscription is needed to run your marketing.'
      : url.searchParams.get('active') ? 'Use Manage billing for an existing subscription; Relaunch72 will not create a second one.'
      : url.searchParams.get('error') ? 'Something went wrong starting checkout — try again.' : undefined;
    return sendHtml(res, 200, billingPage(data?.tenant.name ?? 'Your business', billing, {
      canManage: !!deps.manageUrl,
      canSubscribe: !!deps.subscribeUrl,
      crmAvailable: !!deps.crm,
      csrfToken: portalCsrfToken(deps.sessionSecret, sessionToken),
      notice,
    }));
  }

  if (p === '/portal/subscribe' && method === 'POST') {
    if (!deps.subscribeUrl || !deps.billing) return redirect(res, '/portal/billing');
    const form = await readForm(req);
    if (!verifyPortalCsrf(deps.sessionSecret, sessionToken, form._csrf)) {
      return sendHtml(res, 403, portalStatusPage(deps, sessionToken, {
        title: 'Refresh needed', message: 'The secure form token was invalid. Checkout was not started.', active: 'billing', backHref: '/portal/billing', backLabel: 'Return to billing',
      }));
    }
    const plan = (form.plan ?? '').trim();
    const billing = await deps.billing(tenantId);
    if (billing?.active) return redirect(res, '/portal/billing?active=1');
    try {
      const to = await deps.subscribeUrl(plan, billing?.email ?? null);
      return redirect(res, to);
    } catch {
      return redirect(res, '/portal/billing?error=1');
    }
  }

  if (p === '/portal/manage' && method === 'POST') {
    if (!deps.manageUrl || !deps.billing) return redirect(res, '/portal/billing');
    const form = await readForm(req);
    if (!verifyPortalCsrf(deps.sessionSecret, sessionToken, form._csrf)) {
      return sendHtml(res, 403, portalStatusPage(deps, sessionToken, {
        title: 'Refresh needed', message: 'The secure form token was invalid. Billing was not opened.', active: 'billing', backHref: '/portal/billing', backLabel: 'Return to billing',
      }));
    }
    const billing = await deps.billing(tenantId);
    if (!billing?.customerId) return redirect(res, '/portal/billing');
    try {
      const to = await deps.manageUrl(billing.customerId);
      return redirect(res, to);
    } catch {
      return redirect(res, '/portal/billing?error=1');
    }
  }

  if (p === '/portal/run' && method === 'POST') {
    const form = await readForm(req);
    if (!verifyPortalCsrf(deps.sessionSecret, sessionToken, form._csrf)) {
      return sendHtml(res, 403, portalStatusPage(deps, sessionToken, {
        title: 'Refresh needed', message: 'The secure form token was invalid. No draft generation was started.',
      }));
    }
    // Soft gate: only block when billing is enforced AND the tenant isn't active.
    if (deps.billingEnforced && deps.billing) {
      const billing = await deps.billing(tenantId);
      if (!billing?.active) return redirect(res, '/portal/billing?need=1');
    }
    await deps.runTick(tenantId);
    return redirect(res, '/portal');
  }

  return sendHtml(res, 404, '<h1>Not found</h1><p><a href="/portal">← dashboard</a></p>');
}
