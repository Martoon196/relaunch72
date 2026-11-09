import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PostgresPortalDeps } from '../portal/router.js';
import { portalCsrfToken, verifyPortalCsrf } from '../portal/session.js';
import { principalAbuseAdmission, sourceAbuseAdmission } from '../portal/abuse.js';
import { parseCookies } from '../server/admin/session.js';
import { MHP_AUTH_ORIGIN, MHP_SESSION_COOKIE } from './auth-service.js';
import { MhpCommerceError } from './commerce-service.js';
import { MhpOwnerEmailService, type MhpOwnerEmailSaveInput } from './owner-email-service.js';
import { mhpOwnerEmailNewDraft, mhpOwnerEmailPage, type MhpOwnerEmailPageInput } from './owner-email-view.js';

const BASE = '/hq/marketing/emails';
const PATHS = new Set([BASE, ...['save', 'preview', 'publish', 'test', 'schedule', 'replace', 'cancel'].map(action => `${BASE}/${action}`)]);
const DRAFT_FIELDS = ['csrf', 'commandId', 'title', 'subject', 'bodyText', 'contentItemId', 'previousVersionId'];
const SAVED_FIELDS = ['csrf', 'commandId', 'itemId', 'versionId'];
const CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
function respond(res: ServerResponse, status: number, body: string, html = false): void {
  res.writeHead(status, { 'content-type': html ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)), 'cache-control': 'no-store', 'referrer-policy': 'same-origin',
    'content-security-policy': CSP, 'x-content-type-options': 'nosniff' });res.end(body);
}
function redirect(res: ServerResponse, location: string): void {
  res.writeHead(303, { location, 'cache-control': 'no-store', 'referrer-policy': 'same-origin' });res.end();
}
async function readForm(req: IncomingMessage, keys: readonly string[]): Promise<URLSearchParams> {
  if (!/^application\/x-www-form-urlencoded(?:;\s*charset=utf-8)?$/iu.test(String(req.headers['content-type'] ?? ''))) throw new MhpCommerceError(415, 'Use the email editor form.');
  const maximum = keys === DRAFT_FIELDS ? 180_000 : 4096;
  if (Number(req.headers['content-length'] ?? 0) > maximum) throw new MhpCommerceError(413, 'This email form is too large.');
  const chunks: Buffer[] = [];let size = 0;
  for await (const raw of req) { const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);size += chunk.length;
    if (size > maximum) throw new MhpCommerceError(413, 'This email form is too large.');chunks.push(chunk); }
  const fields = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  if (fields.size !== keys.length || [...fields.keys()].some(key => !keys.includes(key) || fields.getAll(key).length !== 1)) throw new MhpCommerceError(400, 'Refresh the email form before continuing.');
  return fields;
}
function scheduleTime(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u.test(value)) throw new MhpCommerceError(400, 'Choose a send time and expiry in UTC.');
  const at = Date.parse(`${value}:00Z`);
  if (!Number.isFinite(at) || new Date(at).toISOString().slice(0, 16) !== value) throw new MhpCommerceError(400, 'Choose valid send and expiry times.');
  return new Date(at).toISOString();
}

/** Only mounted inside the existing exact native MHP host boundary. */
export async function handleMhpOwnerEmail(req: IncomingMessage, res: ServerResponse, url: URL,
  deps: { portal: PostgresPortalDeps; emails: Pick<MhpOwnerEmailService, 'snapshot' | 'review' | 'preview' | 'save' | 'publish' | 'queue' | 'test'> }): Promise<boolean> {
  const path = url.pathname.replace(/\/+$/, '');if (!PATHS.has(path)) return false;
  const { portal, emails } = deps;const leases: Buffer[] = [];let outcome: 'success' | 'service_error' = 'success';
  try {
    const method = req.method ?? 'GET';
    if ((path === BASE && method !== 'GET') || (path !== BASE && method !== 'POST')) throw new MhpCommerceError(405, 'Use the email editor controls.');
    const context = portal.requestContext?.(req);
    if (!context || !portal.abuse || !portal.abuseHashSecret) throw new MhpCommerceError(503, 'Email editor access is temporarily unavailable.');
    const now = portal.now?.() ?? Date.now(), routeClass = method === 'GET' ? 'read.page' : 'command';
    const reserve = async (admission: ReturnType<typeof sourceAbuseAdmission>) => {
      if (!admission) throw new MhpCommerceError(503, 'Email editor access is temporarily unavailable.');
      const decision = await portal.abuse!.admit(admission);
      if (!decision.allowed) throw new MhpCommerceError(429, 'Too many requests. Please try again shortly.');
      if (decision.leaseHash) leases.push(decision.leaseHash);
    };
    await reserve(sourceAbuseAdmission(context, routeClass, now));
    const token = parseCookies(req.headers.cookie)[MHP_SESSION_COOKIE] ?? '';
    const identity = token ? await portal.auth.resolve(token, now) : null;
    if (!identity) { redirect(res, '/portal/login');return true; }
    await reserve(principalAbuseAdmission(context, routeClass, portal.abuseHashSecret, identity, now));
    const page = async (extra: Partial<MhpOwnerEmailPageInput> = {}) => mhpOwnerEmailPage({ snapshot: await emails.snapshot(identity, context.requestId),
      csrf: portalCsrfToken(portal.sessionSecret, token), commandId: randomUUID(), returnCommandId: randomUUID(), ...extra });
    if (method === 'GET') {
      const keys = [...url.searchParams.keys()];
      if (keys.some(key => !['new', 'item', 'version', 'beforeAt', 'beforeVersion'].includes(key) || url.searchParams.getAll(key).length !== 1)) throw new MhpCommerceError(400, 'Use the links in the email editor.');
      const newDraft = url.searchParams.get('new'), item = url.searchParams.get('item'), version = url.searchParams.get('version');
      const beforeAt = url.searchParams.get('beforeAt'), beforeVersion = url.searchParams.get('beforeVersion');
      if (Boolean(item) !== Boolean(version) || Boolean(beforeAt) !== Boolean(beforeVersion)
          || Number(Boolean(newDraft)) + Number(Boolean(item)) + Number(Boolean(beforeAt)) > 1) throw new MhpCommerceError(400, 'Use one email editor link at a time.');
      const snapshot = await emails.snapshot(identity, context.requestId, beforeAt && beforeVersion ? { beforeCreatedAt: beforeAt, beforeVersionId: beforeVersion } : null);
      const detail = item && version ? await emails.review(identity, context.requestId, item, version) : undefined;
      respond(res, 200, mhpOwnerEmailPage({ snapshot, detail, draft: newDraft ? mhpOwnerEmailNewDraft(newDraft, randomUUID()) : undefined,
        csrf: portalCsrfToken(portal.sessionSecret, token), commandId: randomUUID(), returnCommandId: randomUUID() }), true);return true;
    }
    if (url.search !== '' || req.headers.origin !== MHP_AUTH_ORIGIN
        || (req.headers['sec-fetch-site'] !== undefined && req.headers['sec-fetch-site'] !== 'same-origin')) throw new MhpCommerceError(403, 'Refresh the email editor before continuing.');
    const action = path.slice(BASE.length + 1);
    const editing = action === 'save' || action === 'preview';
    const scheduling = action === 'schedule' || action === 'replace';
    const fields = await readForm(req, editing ? DRAFT_FIELDS : scheduling ? [...SAVED_FIELDS, 'dueAt', 'expiresAt'] : SAVED_FIELDS);
    if (!verifyPortalCsrf(portal.sessionSecret, token, fields.get('csrf') ?? '')) throw new MhpCommerceError(403, 'Refresh the email editor before continuing.');
    const field = (name: string) => fields.get(name) ?? '';
    if (editing) {
      const draft: MhpOwnerEmailSaveInput = { commandId: field('commandId'), title: field('title'), subject: field('subject'), bodyText: field('bodyText'),
        contentItemId: field('contentItemId'), previousVersionId: field('previousVersionId') };
      if (action === 'save') {
        const saved = await emails.save(identity, context.requestId, draft, now);
        redirect(res, `${BASE}?item=${encodeURIComponent(saved.contentItemId)}&version=${encodeURIComponent(saved.contentVersionId)}`);return true;
      }
      const preview = await emails.preview(identity, context.requestId, draft.subject, draft.bodyText);
      const detail = draft.contentItemId && draft.previousVersionId ? await emails.review(identity, context.requestId, draft.contentItemId, draft.previousVersionId) : undefined;
      respond(res, 200, await page({ draft, detail, preview }), true);return true;
    }
    const itemId = field('itemId'), versionId = field('versionId'), commandId = field('commandId');
    await emails.review(identity, context.requestId, itemId, versionId);
    let message: string;
    if (action === 'publish') {
      await emails.publish(identity, context.requestId, itemId, versionId, commandId, now);
      message = 'This version is published. No audience email was scheduled or sent. Choose Schedule when you are ready.';
    } else if (action === 'test') {
      const status = await emails.test(identity, context.requestId, versionId, commandId);
      message = status === 'accepted' ? 'The email provider accepted your test. Check the configured owner inbox.' : 'The test outcome is unknown. Check your inbox before sending another test.';
    } else {
      const result = await emails.queue(identity, context.requestId, { action: action as 'schedule' | 'replace' | 'cancel', commandId, versionId,
        dueAt: scheduling ? scheduleTime(field('dueAt')) : '', expiresAt: scheduling ? scheduleTime(field('expiresAt')) : '' });
      message = `${result.changed} follow-ups ${action === 'cancel' ? 'cancelled' : action === 'replace' ? 'replaced or rescheduled' : 'scheduled'}.${result.replayed ? ' This is the saved result of your earlier request.' : ''} ${result.remaining} remain for another explicit batch. ${result.inFlight} already being sent were left unchanged.`;
    }
    const detail = await emails.review(identity, context.requestId, itemId, versionId);
    respond(res, 200, await page({ detail, message }), true);
  } catch (error) {
    outcome = 'service_error';respond(res, error instanceof MhpCommerceError ? error.status : 503,
      error instanceof MhpCommerceError ? error.message : 'The email editor is temporarily unavailable.');
  } finally { await Promise.allSettled(leases.map(lease => portal.abuse!.complete(lease, outcome))); }
  return true;
}
