import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PostgresPortalDeps } from '../portal/router.js';
import { portalCsrfToken, verifyPortalCsrf } from '../portal/session.js';
import { principalAbuseAdmission, sourceAbuseAdmission } from '../portal/abuse.js';
import { parseCookies } from '../server/admin/session.js';
import { MHP_AUTH_ORIGIN, MHP_SESSION_COOKIE } from './auth-service.js';
import { MhpCommerceError } from './commerce-service.js';
import { mhpLink, mhpOwnerProblemPage, mhpWorkspaceProblem } from './owner-frame.js';
import { MhpOwnerEmailService, type MhpEmailSchedulePlan, type MhpEmailUnsentPlan, type MhpOwnerEmailSaveInput } from './owner-email-service.js';
import { mhpOwnerEmailNewDraft, mhpOwnerEmailPage, type MhpOwnerEmailNote, type MhpOwnerEmailPageInput } from './owner-email-view.js';
import { emailHref, mhpEmailScheduleConfirmPage, mhpEmailUnsentConfirmPage } from './owner-email-confirm-view.js';
import { readMhpNote, signMhpNote } from './owner-notes.js';

const BASE = '/hq/marketing/emails';
const PATHS = new Set([BASE, ...['save', 'preview', 'publish', 'test', 'schedule', 'replace', 'cancel'].map(action => `${BASE}/${action}`)]);
const DRAFT_FIELDS = ['csrf', 'commandId', 'title', 'subject', 'bodyText', 'contentItemId', 'previousVersionId'];
const SAVED_FIELDS = ['csrf', 'commandId', 'itemId', 'versionId'];
const SCHEDULE_FIELDS = [...SAVED_FIELDS, 'dueAt', 'expiresAt', 'count', 'digest', 'issued', 'sig'];
const REPLACE_FIELDS = [...SAVED_FIELDS, 'dueAt', 'expiresAt', 'digest', 'issued', 'sig'];
const CANCEL_FIELDS = [...SAVED_FIELDS, 'digest', 'issued', 'sig'];
const CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
/** A confirmation older than this is shown again with the current list instead of being used. */
const CONFIRMATION_TTL_MS = 30 * 60_000;
function respond(res: ServerResponse, status: number, body: string, html = false): void {
  res.writeHead(status, { 'content-type': html ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)), 'cache-control': 'no-store', 'referrer-policy': 'same-origin',
    'content-security-policy': CSP, 'x-content-type-options': 'nosniff' });res.end(body);
}
function redirect(res: ServerResponse, location: string, cookie?: string): void {
  res.writeHead(303, { location, 'cache-control': 'no-store', 'referrer-policy': 'same-origin', ...(cookie ? { 'set-cookie': cookie } : {}) });res.end();
}
async function readForm(req: IncomingMessage, keys: readonly string[], optional: readonly string[] = []): Promise<URLSearchParams> {
  if (!/^application\/x-www-form-urlencoded(?:;\s*charset=utf-8)?$/iu.test(String(req.headers['content-type'] ?? ''))) throw new MhpCommerceError(415, 'This form could not be read. Open the page again and try once more.');
  const maximum = keys === DRAFT_FIELDS ? 180_000 : 4096;
  if (Number(req.headers['content-length'] ?? 0) > maximum) throw new MhpCommerceError(413, 'This email form is too large.');
  const chunks: Buffer[] = [];let size = 0;
  for await (const raw of req) { const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);size += chunk.length;
    if (size > maximum) throw new MhpCommerceError(413, 'This email form is too large.');chunks.push(chunk); }
  const fields = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  const expected = [...keys, ...optional.filter(key => fields.has(key))];
  if (fields.size !== expected.length || [...fields.keys()].some(key => !expected.includes(key) || fields.getAll(key).length !== 1)) throw new MhpCommerceError(400, 'This page was out of date. Open the email again and try once more.');
  return fields;
}
function scheduleTime(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u.test(value)) throw new MhpCommerceError(400, 'Choose a send time and expiry in UTC.');
  const at = Date.parse(`${value}:00Z`);
  if (!Number.isFinite(at) || new Date(at).toISOString().slice(0, 16) !== value) throw new MhpCommerceError(400, 'Choose valid send and expiry times.');
  return new Date(at).toISOString();
}
const mac = (secret: string, parts: readonly string[]) => createHmac('sha256', secret).update(parts.join('\n')).digest('hex');
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
/** Signed to the session, the action, the exact item and version, the chosen times, the count and the fingerprint of the people, and the moment it was shown. */
const confirmationSig = (secret: string, session: string, action: string, f: Record<string, string>) =>
  mac(secret, ['mhp.owner-email.confirm/v1', action, session, f.commandId!, f.itemId!, f.versionId!, f.dueAt ?? '', f.expiresAt ?? '', f.count ?? '', f.digest!, f.issued!]);
function scheduleToken(secret: string, session: string, commandId: string, plan: MhpEmailSchedulePlan, now: number): Record<string, string> {
  const f = { commandId, itemId: plan.itemId, versionId: plan.versionId, dueAt: plan.dueAt.slice(0, 16), expiresAt: plan.expiresAt.slice(0, 16), count: String(plan.count), digest: plan.digest || '0'.repeat(64), issued: String(now) };
  return { dueAt: f.dueAt, expiresAt: f.expiresAt, count: f.count, digest: f.digest, issued: f.issued, sig: confirmationSig(secret, session, 'schedule', f) };
}
function unsentToken(secret: string, session: string, action: 'replace' | 'cancel', commandId: string, plan: MhpEmailUnsentPlan, dueAt: string, expiresAt: string, now: number): Record<string, string> {
  const f = { commandId, itemId: plan.itemId, versionId: plan.versionId, dueAt: dueAt.slice(0, 16), expiresAt: expiresAt.slice(0, 16), digest: plan.digest, issued: String(now) };
  return { digest: f.digest, issued: f.issued, sig: confirmationSig(secret, session, action, f) };
}
type Emails = Pick<MhpOwnerEmailService, 'snapshot' | 'review' | 'preview' | 'save' | 'publish' | 'queue' | 'test'>
  & Partial<Pick<MhpOwnerEmailService, 'schedulePlan' | 'schedule' | 'unsentPlan' | 'changeUnsent'>>;

/** Only mounted inside the existing exact native MHP host boundary. */
export async function handleMhpOwnerEmail(req: IncomingMessage, res: ServerResponse, url: URL, deps: { portal: PostgresPortalDeps; emails: Emails }): Promise<boolean> {
  const path = url.pathname.replace(/\/+$/, '');if (!PATHS.has(path)) return false;
  const { portal, emails } = deps;const leases: Buffer[] = [];let outcome: 'success' | 'service_error' = 'success';
  let place: { itemId: string; versionId: string } | null = UUID.test(url.searchParams.get('item') ?? '') && UUID.test(url.searchParams.get('version') ?? '')
    ? { itemId: url.searchParams.get('item')!, versionId: url.searchParams.get('version')! } : null;
  try {
    const method = req.method ?? 'GET';
    if ((path === BASE && method !== 'GET') || (path !== BASE && method !== 'POST')) throw new MhpCommerceError(405, 'Use the buttons on the email page.');
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
    const csrf = portalCsrfToken(portal.sessionSecret, token);
    const page = async (extra: Partial<MhpOwnerEmailPageInput> = {}) => mhpOwnerEmailPage({ snapshot: await emails.snapshot(identity, context.requestId),
      csrf, commandId: randomUUID(), returnCommandId: randomUUID(), ...extra });
    const back = (itemId: string, versionId: string, note: MhpOwnerEmailNote) => {
      const signed = signMhpNote(portal.sessionSecret, token, 'emails', { itemId, versionId }, now, note);
      redirect(res, `${emailHref(itemId, versionId, signed.query)}#result`, signed.cookie);
    };
    if (method === 'GET') {
      const keys = [...url.searchParams.keys()];
      if (keys.some(key => !['new', 'item', 'version', 'beforeAt', 'beforeVersion', 'confirm', 'dueAt', 'expiresAt', 'note', 'sig'].includes(key) || url.searchParams.getAll(key).length !== 1)) throw new MhpCommerceError(400, 'Use the links in the email editor.');
      const newDraft = url.searchParams.get('new'), item = url.searchParams.get('item'), version = url.searchParams.get('version');
      const beforeAt = url.searchParams.get('beforeAt'), beforeVersion = url.searchParams.get('beforeVersion'), confirm = url.searchParams.get('confirm');
      if (Boolean(item) !== Boolean(version) || Boolean(beforeAt) !== Boolean(beforeVersion)
          || Number(Boolean(newDraft)) + Number(Boolean(item)) + Number(Boolean(beforeAt)) > 1
          || (confirm !== null && (!item || !['schedule', 'replace', 'cancel'].includes(confirm)))
          || ((confirm === 'schedule' || confirm === 'replace') !== (url.searchParams.has('dueAt') && url.searchParams.has('expiresAt')))
          || (confirm !== 'schedule' && confirm !== 'replace' && (url.searchParams.has('dueAt') || url.searchParams.has('expiresAt')))) throw new MhpCommerceError(400, 'Use one email editor link at a time.');
      if (item && version && confirm) {
        const commandId = randomUUID();
        if (confirm === 'schedule' || confirm === 'replace') {
          const dueAt = scheduleTime(url.searchParams.get('dueAt')!), expiresAt = scheduleTime(url.searchParams.get('expiresAt')!);
          if (Date.parse(dueAt) < now - 60_000 || Date.parse(expiresAt) <= Date.parse(dueAt)) throw new MhpCommerceError(400, 'Choose a send time in the future, and a stop time after it.');
          if (confirm === 'schedule') {
            if (!emails.schedulePlan) throw new MhpCommerceError(503, 'Scheduling is temporarily unavailable.');
            const plan = await emails.schedulePlan(identity, context.requestId, item, version, dueAt, expiresAt);
            respond(res, 200, mhpEmailScheduleConfirmPage({ csrf, commandId, plan, now, token: scheduleToken(portal.sessionSecret, token, commandId, plan, now) }), true);return true;
          }
          if (!emails.unsentPlan) throw new MhpCommerceError(503, 'Scheduling is temporarily unavailable.');
          const plan = await emails.unsentPlan(identity, context.requestId, item, version, 'replace', dueAt, expiresAt);
          respond(res, 200, mhpEmailUnsentConfirmPage({ csrf, commandId, action: 'replace', plan, dueAt, expiresAt, token: unsentToken(portal.sessionSecret, token, 'replace', commandId, plan, dueAt, expiresAt, now) }), true);return true;
        }
        if (!emails.unsentPlan) throw new MhpCommerceError(503, 'Scheduling is temporarily unavailable.');
        const plan = await emails.unsentPlan(identity, context.requestId, item, version, 'cancel');
        respond(res, 200, mhpEmailUnsentConfirmPage({ csrf, commandId, action: 'cancel', plan, dueAt: '', expiresAt: '', token: unsentToken(portal.sessionSecret, token, 'cancel', commandId, plan, '', '', now) }), true);return true;
      }
      const snapshot = await emails.snapshot(identity, context.requestId, beforeAt && beforeVersion ? { beforeCreatedAt: beforeAt, beforeVersionId: beforeVersion } : null);
      const detail = item && version ? await emails.review(identity, context.requestId, item, version) : undefined;
      respond(res, 200, mhpOwnerEmailPage({ snapshot, detail, draft: newDraft ? mhpOwnerEmailNewDraft(newDraft, randomUUID()) : undefined, csrf, commandId: randomUUID(), returnCommandId: randomUUID(),
        note: readMhpNote<MhpOwnerEmailNote>(portal.sessionSecret, token, 'emails', { value: url.searchParams.get('note'), sig: url.searchParams.get('sig'), cookie: req.headers.cookie, itemId: item, versionId: version, now }) }), true);return true;
    }
    if (url.search !== '' || req.headers.origin !== MHP_AUTH_ORIGIN
        || (req.headers['sec-fetch-site'] !== undefined && req.headers['sec-fetch-site'] !== 'same-origin')) throw new MhpCommerceError(403, 'This page was out of date. Open the email again and try once more.');
    const action = path.slice(BASE.length + 1);
    const editing = action === 'save' || action === 'preview';
    const fields = await readForm(req, editing ? DRAFT_FIELDS : action === 'schedule' ? SCHEDULE_FIELDS : action === 'replace' ? REPLACE_FIELDS : action === 'cancel' ? CANCEL_FIELDS : SAVED_FIELDS,
      action === 'schedule' || action === 'replace' ? ['confirm'] : []);
    const field = (name: string) => fields.get(name) ?? '';
    if (UUID.test(field('itemId')) && UUID.test(field('versionId'))) place = { itemId: field('itemId'), versionId: field('versionId') };
    if (!verifyPortalCsrf(portal.sessionSecret, token, field('csrf'))) throw new MhpCommerceError(403, 'This page was out of date. Open the email again and try once more.');
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
    if (action === 'publish') {
      await emails.publish(identity, context.requestId, itemId, versionId, commandId, now);
      back(itemId, versionId, { c: 'pub' });return true;
    }
    if (action === 'test') {
      const status = await emails.test(identity, context.requestId, versionId, commandId);
      back(itemId, versionId, { c: 'test', s: status === 'accepted' ? 1 : 0 });return true;
    }
    const signed = Object.fromEntries(['commandId', 'itemId', 'versionId', 'dueAt', 'expiresAt', 'count', 'digest', 'issued'].map(key => [key, field(key)]));
    if (!/^[a-f0-9]{64}$/u.test(field('digest')) || !/^\d{13}$/u.test(field('issued')) || !same(field('sig'), confirmationSig(portal.sessionSecret, token, action, signed)))
      throw new MhpCommerceError(400, 'This confirmation could not be checked. Open the email and press the button again. Nothing was changed.');
    const stale = now - Number(field('issued')) > CONFIRMATION_TTL_MS;
    if (action === 'schedule') {
      if (!emails.schedule || !emails.schedulePlan) throw new MhpCommerceError(503, 'Scheduling is temporarily unavailable.');
      const dueAt = scheduleTime(field('dueAt')), expiresAt = scheduleTime(field('expiresAt'));
      const again = (plan: MhpEmailSchedulePlan, problem?: string, changed?: { previousCount: number; reason?: string }) => {
        const fresh = randomUUID();
        respond(res, changed ? 409 : 400, mhpEmailScheduleConfirmPage({ csrf, commandId: fresh, plan, now, token: scheduleToken(portal.sessionSecret, token, fresh, plan, now), problem, changed }), true);
      };
      if (field('confirm') !== 'yes') { again(await emails.schedulePlan(identity, context.requestId, itemId, versionId, dueAt, expiresAt), 'Tick the “Yes, send to…” box to confirm, then press Schedule. Nothing was scheduled.');return true; }
      if (stale) { again(await emails.schedulePlan(identity, context.requestId, itemId, versionId, dueAt, expiresAt), undefined, { previousCount: Number(field('count')), reason: 'This confirmation was more than 30 minutes old, so here is the current list again. Nothing was scheduled.' });return true; }
      const result = await emails.schedule(identity, context.requestId, { commandId, itemId, versionId, dueAt, expiresAt, count: Number(field('count')), digest: field('digest'), confirmed: true });
      if (result.kind === 'changed') { again(result.plan, undefined, { previousCount: result.previousCount });return true; }
      back(itemId, versionId, { c: 'sch', n: Math.max(0, result.scheduled - result.unexpected), x: result.unexpected, r: result.replayed ? 1 : 0, u: result.dueAt });return true;
    }
    if (!emails.changeUnsent || !emails.unsentPlan) throw new MhpCommerceError(503, 'Scheduling is temporarily unavailable.');
    const act = action as 'replace' | 'cancel';
    const dueAt = act === 'replace' ? scheduleTime(field('dueAt')) : '', expiresAt = act === 'replace' ? scheduleTime(field('expiresAt')) : '';
    const again = async () => { const fresh = randomUUID(), plan = await emails.unsentPlan!(identity, context.requestId, itemId, versionId, act, dueAt, expiresAt);
      respond(res, 409, mhpEmailUnsentConfirmPage({ csrf, commandId: fresh, action: act, plan, dueAt, expiresAt, changed: true, token: unsentToken(portal.sessionSecret, token, act, fresh, plan, dueAt, expiresAt, now) }), true); };
    if (stale || (act === 'replace' && field('confirm') !== 'yes')) { await again();return true; }
    const result = await emails.changeUnsent(identity, context.requestId, { action: act, commandId, itemId, versionId, dueAt, expiresAt, digest: field('digest'), confirmed: act === 'cancel' || field('confirm') === 'yes' });
    if (result.kind === 'changed') { await again();return true; }
    back(itemId, versionId, { c: act === 'replace' ? 'rep' : 'can', n: result.result.changed, m: result.result.remaining, f: result.result.inFlight, r: result.result.replayed ? 1 : 0 });return true;
  } catch (error) {
    outcome = 'service_error';
    const status = error instanceof MhpCommerceError ? error.status : 503;
    const message = error instanceof MhpCommerceError ? error.message : 'The email editor is temporarily unavailable. Nothing was changed. Try again in a minute.';
    if (status === 404) place = null;
    const backTo = place ? emailHref(place.itemId, place.versionId) : BASE;
    // In the normal frame with a way back, never a bare text page.
    respond(res, status, mhpOwnerProblemPage({ heading: mhpWorkspaceProblem(status, message) ? 'Open your marketing workspace' : status === 409 ? 'Nothing was changed' : status >= 500 ? 'Temporarily unavailable' : 'Please try again',
      message, actions: (mhpWorkspaceProblem(status, message) ? mhpLink('/hq/marketing', 'Open marketing workspace') : '') + mhpLink(backTo, place ? 'Back to the email' : 'Back to the email library', mhpWorkspaceProblem(status, message)) }), true);
  } finally { await Promise.allSettled(leases.map(lease => portal.abuse!.complete(lease, outcome))); }
  return true;
}
