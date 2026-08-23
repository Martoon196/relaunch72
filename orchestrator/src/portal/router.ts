/**
 * The client portal — routes + the tenant auth gate. Everything under /portal
 * requires a valid tenant session except the login routes. Dependency-injected
 * (store + login + dashboard + runTick) so it tests without a socket.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { parseCookies } from '../server/admin/session.js';
import { PORTAL_COOKIE, signTenant, verifyTenant, portalCookie, clearPortalCookie, portalCsrfToken, verifyPortalCsrf } from './session.js';
import type { InMemoryLoginThrottle } from './session.js';
import { accountSetupPage, loginPage, dashboardPage, billingPage } from './views.js';
import { appShell } from './ui.js';
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

export interface PortalDeps {
  sessionSecret: string;
  secure: boolean;
  /** Email + password → tenant id, or null if the credentials don't match. */
  login(email: string, password: string): Promise<string | null>;
  /** Consume a new customer's one-time setup token and set their password. */
  completeSetup?(token: string, password: string, now: number): Promise<string | null>;
  /** Process-local login limiter; replace with a shared implementation at multi-instance scale. */
  loginThrottle?: Pick<InMemoryLoginThrottle, 'check' | 'failure' | 'success'>;
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
  now?: () => number;
  requestId?: () => string;
}

function sendHtml(res: ServerResponse, code: number, body: string, cookie?: string, extra: Record<string, string> = {}): void {
  const headers: Record<string, string> = {
    'content-type': 'text/html; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  };
  if (cookie) headers['set-cookie'] = cookie;
  Object.assign(headers, extra);
  res.writeHead(code, headers);
  res.end(body);
}

function loginKeys(req: IncomingMessage, email: string): string[] {
  const forwarded = req.headers['x-forwarded-for'];
  const firstForwarded = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
  const remote = firstForwarded || req.socket?.remoteAddress || 'unknown';
  return [`account:${email || 'unknown'}`, `source:${remote}`];
}
function redirect(res: ServerResponse, to: string, cookie?: string): void {
  const headers: Record<string, string> = { location: to };
  if (cookie) headers['set-cookie'] = cookie;
  res.writeHead(302, headers);
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
  snapshot: CrmWorkspaceSnapshot,
  body: string,
  deps: PortalDeps,
): string {
  return appShell({
    title: `Relaunch72 CRM — ${snapshot.workspace.name}`,
    tenantName: snapshot.workspace.name,
    active: 'crm',
    billingAvailable: !!deps.billing,
    crmAvailable: true,
    mode: 'crm',
    body,
  });
}

function crmIdentity(sessionToken: string, tenantId: string, deps: PortalDeps): PortalCrmRequestIdentity {
  return {
    sessionToken,
    legacyTenantId: tenantId,
    requestId: deps.requestId ? deps.requestId() : randomUUID(),
  };
}

function crmRedirect(
  res: ServerResponse,
  route: string,
  deps: PortalDeps,
  sessionToken: string,
  code: PortalCrmNoticeCode,
): void {
  const token = crmNoticeToken(deps.sessionSecret, sessionToken, code);
  redirect(res, `${route}?notice=${encodeURIComponent(token)}`);
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
  const now = deps.now ? deps.now() : Date.now();
  const sessionToken = parseCookies(req.headers.cookie)[PORTAL_COOKIE] ?? '';
  const tenantId = verifyTenant(deps.sessionSecret, sessionToken, now);

  // ── one-time account setup / login / logout (no auth) ──
  if (p === '/portal/setup' && method === 'GET') {
    const token = url.searchParams.get('token') ?? '';
    const error = token ? undefined : 'This setup link is incomplete. Contact support.';
    return sendHtml(res, token ? 200 : 400, accountSetupPage(token, error), undefined, {
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    });
  }
  if (p === '/portal/setup' && method === 'POST') {
    if (!deps.completeSetup) return sendHtml(res, 404, accountSetupPage('', 'Account setup is not enabled.'));
    const form = await readForm(req);
    const token = form.token ?? '';
    const password = form.password ?? '';
    if (password.length < 12 || password.length > 1_024) {
      return sendHtml(res, 400, accountSetupPage(token, 'Use a password between 12 and 1,024 characters.'), undefined, { 'cache-control': 'no-store' });
    }
    if (password !== (form.confirm ?? '')) {
      return sendHtml(res, 400, accountSetupPage(token, 'Those passwords do not match.'), undefined, { 'cache-control': 'no-store' });
    }
    const tid = await deps.completeSetup(token, password, now);
    if (!tid) {
      return sendHtml(res, 400, accountSetupPage('', 'This setup link has expired or has already been used. Contact support.'), undefined, { 'cache-control': 'no-store' });
    }
    return redirect(res, '/portal', portalCookie(signTenant(deps.sessionSecret, tid, now), deps.secure));
  }
  if (p === '/portal/login' && method === 'GET') {
    if (tenantId) return redirect(res, '/portal');
    return sendHtml(res, 200, loginPage());
  }
  if (p === '/portal/login' && method === 'POST') {
    const form = await readForm(req);
    const email = (form.email ?? '').trim().toLowerCase();
    const keys = loginKeys(req, email);
    const throttle = keys.map((key) => deps.loginThrottle?.check(key, now)).find((result) => result && !result.allowed);
    if (throttle && !throttle.allowed) {
      return sendHtml(res, 429, loginPage('Too many login attempts. Try again later.'), undefined, {
        'retry-after': String(throttle.retryAfterSeconds),
      });
    }
    const tid = await deps.login(email, form.password ?? '');
    if (!tid) {
      for (const key of keys) deps.loginThrottle?.failure(key, now);
      return sendHtml(res, 401, loginPage('Wrong email or password.'));
    }
    for (const key of keys) deps.loginThrottle?.success(key);
    return redirect(res, '/portal', portalCookie(signTenant(deps.sessionSecret, tid, now), deps.secure));
  }
  if (p === '/portal/logout' && method === 'POST') {
    return redirect(res, '/portal/login', clearPortalCookie(deps.secure));
  }

  // ── everything below requires a tenant session ──
  if (!tenantId) return redirect(res, '/portal/login');

  // ── durable CRM: real service only; no fake fallback data ──
  if (p === '/portal/crm' && method === 'GET') {
    return deps.crm
      ? redirect(res, CRM_PORTAL_ROUTES.contacts)
      : sendHtml(res, 404, '<h1>CRM not connected</h1><p><a href="/portal">← dashboard</a></p>');
  }

  const isCrmRoute = p.startsWith('/portal/crm/');
  if (isCrmRoute && !deps.crm) {
    return sendHtml(res, 404, '<h1>CRM not connected</h1><p><a href="/portal">← dashboard</a></p>');
  }

  if (deps.crm && method === 'GET' && [CRM_PORTAL_ROUTES.contacts, CRM_PORTAL_ROUTES.pipeline, CRM_PORTAL_ROUTES.tasks].includes(p as never)) {
    const identity = crmIdentity(sessionToken, tenantId, deps);
    try {
      const snapshot = await deps.crm.snapshot(identity);
      if (!snapshot) return sendHtml(res, 403, '<h1>CRM workspace not available</h1><p>Your portal login is still active. <a href="/portal">Return to the dashboard</a>.</p>');
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
      return sendHtml(res, 200, crmPage(snapshot, body, deps));
    } catch {
      return sendHtml(res, 503, '<h1>CRM temporarily unavailable</h1><p>No change was made. <a href="/portal">Return to the dashboard</a>.</p>');
    }
  }

  if (deps.crm && p === CRM_PORTAL_ROUTES.createLead && method === 'POST') {
    const form = await readForm(req);
    if (!verifyPortalCsrf(deps.sessionSecret, sessionToken, form._csrf)) {
      return sendHtml(res, 403, '<h1>Refresh needed</h1><p>The secure form token was invalid. No change was made.</p>');
    }
    const identity = crmIdentity(sessionToken, tenantId, deps);
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
      if (!snapshot) return sendHtml(res, 403, '<h1>CRM workspace not available</h1><p>Your portal login is still active. <a href="/portal">Return to the dashboard</a>.</p>');
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
      return sendHtml(res, status, crmPage(snapshot, body, deps));
    } catch {
      return sendHtml(res, 503, '<h1>CRM temporarily unavailable</h1><p>No lead was saved. Try again after refreshing the page.</p>');
    }
  }

  const moveMatch = /^\/portal\/crm\/opportunities\/([^/]+)\/stage$/.exec(p);
  if (deps.crm && moveMatch && method === 'POST') {
    if (!CRM_OBJECT_ID.test(moveMatch[1]!)) return sendHtml(res, 404, '<h1>Opportunity not found</h1>');
    const form = await readForm(req);
    if (!verifyPortalCsrf(deps.sessionSecret, sessionToken, form._csrf)) {
      return sendHtml(res, 403, '<h1>Refresh needed</h1><p>The secure form token was invalid. No change was made.</p>');
    }
    try {
      const outcome = await deps.crm.moveOpportunity(crmIdentity(sessionToken, tenantId, deps), {
        commandKey: form.command_key ?? '',
        opportunityId: moveMatch[1]!,
        targetStageId: form.target_stage_id ?? '',
        expectedRowVersion: form.expected_version ?? '',
      });
      if (outcome.ok) return crmRedirect(res, CRM_PORTAL_ROUTES.pipeline, deps, sessionToken, outcome.disposition === 'replayed' ? 'replayed' : 'moved');
      if (outcome.kind === 'conflict') return crmRedirect(res, CRM_PORTAL_ROUTES.pipeline, deps, sessionToken, 'conflict');
      if (outcome.kind === 'not_found') return crmRedirect(res, CRM_PORTAL_ROUTES.pipeline, deps, sessionToken, 'missing');
      return sendHtml(res, outcome.kind === 'forbidden' ? 403 : outcome.kind === 'unavailable' ? 503 : 400,
        `<h1>Stage was not changed</h1><p>${outcome.kind === 'validation' ? 'Check the submitted values and refresh the pipeline.' : 'No change was made.'}</p>`);
    } catch {
      return sendHtml(res, 503, '<h1>CRM temporarily unavailable</h1><p>The stage was not changed.</p>');
    }
  }

  const completeMatch = /^\/portal\/crm\/tasks\/([^/]+)\/complete$/.exec(p);
  if (deps.crm && completeMatch && method === 'POST') {
    if (!CRM_OBJECT_ID.test(completeMatch[1]!)) return sendHtml(res, 404, '<h1>Task not found</h1>');
    const form = await readForm(req);
    if (!verifyPortalCsrf(deps.sessionSecret, sessionToken, form._csrf)) {
      return sendHtml(res, 403, '<h1>Refresh needed</h1><p>The secure form token was invalid. No change was made.</p>');
    }
    try {
      const outcome = await deps.crm.completeTask(crmIdentity(sessionToken, tenantId, deps), {
        commandKey: form.command_key ?? '',
        taskId: completeMatch[1]!,
        expectedRowVersion: form.expected_version ?? '',
      });
      if (outcome.ok) return crmRedirect(res, CRM_PORTAL_ROUTES.tasks, deps, sessionToken, outcome.disposition === 'replayed' ? 'replayed' : 'completed');
      if (outcome.kind === 'conflict') return crmRedirect(res, CRM_PORTAL_ROUTES.tasks, deps, sessionToken, 'conflict');
      if (outcome.kind === 'not_found') return crmRedirect(res, CRM_PORTAL_ROUTES.tasks, deps, sessionToken, 'missing');
      return sendHtml(res, outcome.kind === 'forbidden' ? 403 : outcome.kind === 'unavailable' ? 503 : 400,
        `<h1>Task was not completed</h1><p>${outcome.kind === 'validation' ? 'Check the submitted values and refresh the task list.' : 'No change was made.'}</p>`);
    } catch {
      return sendHtml(res, 503, '<h1>CRM temporarily unavailable</h1><p>The task was not changed.</p>');
    }
  }

  if (p === '/portal' && method === 'GET') {
    const data = await deps.dashboard(tenantId);
    if (!data) return redirect(res, '/portal/login', clearPortalCookie(deps.secure)); // stale session
    const billing = deps.billing ? await deps.billing(tenantId) : null;
    return sendHtml(res, 200, dashboardPage(data, billing ?? undefined, { crmAvailable: !!deps.crm }));
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
      notice,
    }));
  }

  if (p === '/portal/subscribe' && method === 'POST') {
    if (!deps.subscribeUrl || !deps.billing) return redirect(res, '/portal/billing');
    const form = await readForm(req);
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
