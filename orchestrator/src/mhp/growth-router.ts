import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PostgresPortalDeps } from '../portal/router.js';
import { portalCsrfToken, verifyPortalCsrf } from '../portal/session.js';
import { parseCookies } from '../server/admin/session.js';
import { principalAbuseAdmission, sourceAbuseAdmission, type PortalAbuseRouteClass } from '../portal/abuse.js';
import { MHP_AUTH_ORIGIN, MHP_SESSION_COOKIE } from './auth-service.js';
import { MHP_SITE_ORIGIN, MhpGrowthError, parseMhpSignup, parseMhpStory, verifyMhpUnsubscribeToken, type PgMhpGrowthService } from './growth-service.js';
import { MhpLearningError, parseMhpCourseBundle, type PgMhpLearningService } from './learning-service.js';
import { learnHomePage, learnLessonPage, learnModulePage } from './learning-view.js';
import { hqCoursePage, hqGrowthPage, publicMessagePage, unsubscribeConfirmPage } from './growth-view.js';

export interface MhpGrowthRouterDependencies {
  portal: PostgresPortalDeps;
  growth: Pick<PgMhpGrowthService, 'capture' | 'story' | 'unsubscribe' | 'summary'>;
  learning: Pick<PgMhpLearningService, 'outline' | 'content' | 'saveProgress' | 'importCourse'>;
  unsubscribeSecret: string;
  marketingMode: string;
}

const SITE_ORIGINS = new Set([MHP_SITE_ORIGIN, 'https://www.martinhowardproperty.co.uk']);
const CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }

function send(res: ServerResponse, status: number, content: string): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-length': String(Buffer.byteLength(content)),
    'referrer-policy': 'same-origin', 'x-content-type-options': 'nosniff', 'content-security-policy': CSP });
  res.end(content);
}
function redirect(res: ServerResponse, location: string): void {
  res.writeHead(303, { location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }); res.end();
}
async function readBody(req: IncomingMessage, maximum: number): Promise<Buffer> {
  if (Number(req.headers['content-length'] ?? 0) > maximum) throw new HttpError(413, 'This form is too large.');
  const parts: Buffer[] = []; let size = 0;
  for await (const raw of req) {
    const part = Buffer.isBuffer(raw) ? raw : Buffer.from(raw); size += part.length;
    if (size > maximum) throw new HttpError(413, 'This form is too large.');
    parts.push(part);
  }
  return Buffer.concat(parts, size);
}
async function urlencoded(req: IncomingMessage, maximum: number): Promise<URLSearchParams> {
  if (!/^application\/x-www-form-urlencoded(?:;|$)/i.test(String(req.headers['content-type'] ?? ''))) throw new HttpError(415, 'Use the form on the website.');
  const fields = new URLSearchParams((await readBody(req, maximum)).toString('utf8'));
  if ([...fields.keys()].some(key => fields.getAll(key).length !== 1)) throw new HttpError(400, 'Check the details in the form and try again.');
  return fields;
}

/** Minimal multipart reader for the owner's single-file course upload. */
export function parseMultipart(body: Buffer, contentType: string): Map<string, Buffer> {
  const boundary = /boundary=(?:"([^"]{1,70})"|([^;\s]{1,70}))/i.exec(contentType);
  if (!boundary) throw new HttpError(400, 'Upload the course bundle file.');
  const marker = Buffer.from(`--${boundary[1] ?? boundary[2]}`);
  const parts = new Map<string, Buffer>();
  let start = body.indexOf(marker);
  while (start !== -1) {
    const next = body.indexOf(marker, start + marker.length);
    if (next === -1) break;
    const chunk = body.subarray(start + marker.length + 2, next - 2);
    const split = chunk.indexOf('\r\n\r\n');
    if (split !== -1) {
      const headers = chunk.subarray(0, split).toString('utf8');
      const name = /content-disposition:[^\r\n]*\bname="([^"]{1,40})"/i.exec(headers)?.[1];
      if (name) {
        if (parts.has(name)) throw new HttpError(400, 'Upload one course bundle file.');
        parts.set(name, chunk.subarray(split + 4));
      }
    }
    start = next;
  }
  return parts;
}

const LEARN = /^\/app\/learn(?:\/([0-9]{2})(?:\/([0-9]{2}))?)?$/;
const known = (path: string): boolean => path === '/api/mhp/subscribe' || path === '/api/mhp/story' || path === '/email/unsubscribe'
  || path === '/hq/growth' || path === '/hq/course' || LEARN.test(path);

/** Called only after the MHP mount's exact-host guard. */
export async function handleMhpGrowth(req: IncomingMessage, res: ServerResponse, url: URL, deps: MhpGrowthRouterDependencies): Promise<boolean> {
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (!known(path)) return false;
  const { portal } = deps;
  const leases: Buffer[] = [];
  let outcome: 'success' | 'service_error' = 'success';
  const isPublic = path.startsWith('/api/') || path === '/email/unsubscribe';
  try {
    const method = req.method ?? 'GET';
    if (!['GET', 'POST'].includes(method)) throw new HttpError(405, 'This page does not accept that request.');
    const context = portal.requestContext?.(req);
    if (!context || !portal.abuse || !portal.abuseHashSecret) throw new HttpError(503, 'This page is temporarily unavailable.');
    const now = portal.now?.() ?? Date.now();
    const routeClass: PortalAbuseRouteClass = isPublic && method === 'POST' && path !== '/email/unsubscribe' ? 'auth.setup' : method === 'GET' ? 'read.page' : 'command';
    const reserve = async (admission: ReturnType<typeof sourceAbuseAdmission>): Promise<void> => {
      if (!admission) throw new HttpError(503, 'This page is temporarily unavailable.');
      const decision = await portal.abuse!.admit(admission);
      if (!decision.allowed) throw new HttpError(429, 'Too many requests. Please wait a few minutes and try again.');
      if (decision.leaseHash) leases.push(decision.leaseHash);
    };
    await reserve(sourceAbuseAdmission(context, routeClass, now));

    if (path === '/api/mhp/subscribe' || path === '/api/mhp/story') {
      if (method !== 'POST') { redirect(res, `${MHP_SITE_ORIGIN}/`); return true; }
      if (!SITE_ORIGINS.has(String(req.headers.origin ?? ''))) throw new HttpError(403, 'Please use the form on martinhowardproperty.co.uk.');
      const fields = await urlencoded(req, path === '/api/mhp/story' ? 32_768 : 8_192);
      const source = context.sourceHash ? Buffer.from(context.sourceHash) : null;
      if (path === '/api/mhp/story') {
        await deps.growth.story(parseMhpStory(fields), source);
        redirect(res, `${MHP_SITE_ORIGIN}/thanks/?for=story`); return true;
      }
      const signup = parseMhpSignup(fields);
      if (signup !== 'honeypot') await deps.growth.capture(signup, source, now);
      const kind = signup === 'honeypot' ? 'sheet' : signup.kind;
      redirect(res, `${MHP_SITE_ORIGIN}/thanks/?for=${kind}`); return true;
    }

    if (path === '/email/unsubscribe') {
      const prospectId = url.searchParams.get('p') ?? '', token = url.searchParams.get('t') ?? '';
      if (!verifyMhpUnsubscribeToken(deps.unsubscribeSecret, prospectId, token)) throw new HttpError(400, 'This unsubscribe link is not valid. Reply to any email and we will remove you by hand.');
      if (method === 'GET') { send(res, 200, unsubscribeConfirmPage(prospectId, token)); return true; }
      await readBody(req, 1_024); // One-click (RFC 8058) or the confirm button: the signed link is the authority.
      await deps.growth.unsubscribe(prospectId);
      send(res, 200, publicMessagePage("You're unsubscribed", "You won't get any more emails from Martin Howard Property. If you change your mind, sign up again on the website."));
      return true;
    }

    const token = parseCookies(req.headers.cookie)[MHP_SESSION_COOKIE] ?? '';
    const identity = token ? await portal.auth.resolve(token, now) : null;
    if (!identity) { redirect(res, '/portal/login'); return true; }
    await reserve(principalAbuseAdmission(context, routeClass === 'auth.setup' ? 'command' : routeClass, portal.abuseHashSecret, identity, now));
    const csrf = portalCsrfToken(portal.sessionSecret, token);
    const requireForm = (fields: URLSearchParams, allowed: readonly string[]): Record<string, string> => {
      if ([...fields.keys()].some(key => !allowed.includes(key)) || !verifyPortalCsrf(portal.sessionSecret, token, fields.get('csrf') ?? '')) {
        throw new HttpError(403, 'Refresh the page before continuing.');
      }
      return Object.fromEntries(fields);
    };
    if (method === 'POST' && req.headers.origin !== MHP_AUTH_ORIGIN) throw new HttpError(403, 'Refresh the page before continuing.');

    if (path === '/hq/growth') {
      if (method !== 'GET') throw new HttpError(405, 'Use the controls in HQ.');
      send(res, 200, hqGrowthPage(await deps.growth.summary(token), deps.marketingMode)); return true;
    }
    if (path === '/hq/course') {
      if (method === 'GET') {
        const loaded = url.searchParams.get('modules') && url.searchParams.get('lessons')
          ? { modules: Number(url.searchParams.get('modules')), lessons: Number(url.searchParams.get('lessons')) } : undefined;
        send(res, 200, hqCoursePage({ csrf, course: (await deps.growth.summary(token)).course, loaded })); return true;
      }
      const contentType = String(req.headers['content-type'] ?? '');
      if (!/^multipart\/form-data(?:;|$)/i.test(contentType)) throw new HttpError(415, 'Upload the course bundle file.');
      const parts = parseMultipart(await readBody(req, 8 * 1024 * 1024), contentType);
      if ([...parts.keys()].some(key => key !== 'csrf' && key !== 'bundle')
          || !verifyPortalCsrf(portal.sessionSecret, token, parts.get('csrf')?.toString('utf8') ?? '')) throw new HttpError(403, 'Refresh HQ before continuing.');
      const bundle = parts.get('bundle');
      if (!bundle?.length) throw new HttpError(400, 'Choose the course bundle file.');
      const counts = await deps.learning.importCourse(token, parseMhpCourseBundle(bundle.toString('utf8')));
      redirect(res, `/hq/course?modules=${counts.modules}&lessons=${counts.lessons}`); return true;
    }

    const match = LEARN.exec(path)!;
    const [, moduleNumber, lessonNumber] = match;
    if (method === 'POST') {
      if (!moduleNumber || !lessonNumber) throw new HttpError(405, 'Use the controls in the training centre.');
      const fields = requireForm(await urlencoded(req, 32_768), ['csrf', 'taskDone', 'complete', 'notes']);
      await deps.learning.saveProgress(token, `${moduleNumber}/${lessonNumber}`, fields);
      redirect(res, `/app/learn/${moduleNumber}/${lessonNumber}?saved=1`); return true;
    }
    const outline = await deps.learning.outline(token);
    if (!moduleNumber) { send(res, 200, learnHomePage(outline, csrf)); return true; }
    const module = outline.modules.find(m => m.number === moduleNumber);
    if (!module) throw new HttpError(404, 'That module is not in the training centre.');
    if (!lessonNumber) {
      send(res, 200, learnModulePage(outline, module, module.open ? await deps.learning.content(token, moduleNumber) : null, csrf)); return true;
    }
    const lesson = module.lessons.find(l => l.key === `${moduleNumber}/${lessonNumber}`);
    if (!lesson) throw new HttpError(404, 'That lesson is not in the training centre.');
    if (!module.open) { redirect(res, `/app/learn/${moduleNumber}`); return true; }
    const content = await deps.learning.content(token, lesson.key);
    if (!content?.body) throw new HttpError(404, 'That lesson is not in the training centre.');
    send(res, 200, learnLessonPage({ outline, module, lesson, body: content.body, csrf, saved: url.searchParams.get('saved') === '1' }));
    return true;
  } catch (error) {
    outcome = 'service_error';
    const status = error instanceof HttpError || error instanceof MhpGrowthError || error instanceof MhpLearningError ? error.status : 503;
    const message = error instanceof HttpError || error instanceof MhpGrowthError || error instanceof MhpLearningError ? error.message : 'This page is temporarily unavailable. Please try again shortly.';
    const title = status === 429 ? 'Slow down a moment' : status >= 500 ? 'Something went wrong' : status === 403 && !isPublic ? 'Not available' : 'Please check the form';
    send(res, status, publicMessagePage(title, message, isPublic ? `${MHP_SITE_ORIGIN}/` : '/app/learn'));
    return true;
  } finally {
    await Promise.allSettled(leases.map(lease => portal.abuse!.complete(lease, outcome)));
  }
}
