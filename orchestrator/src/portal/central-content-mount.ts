import { createHmac, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseCookies } from '../server/admin/session.js';
import { handlePortal, type PostgresPortalDeps } from './router.js';
import { RELAUNCH72_PRODUCT_PROFILE } from './product-profile.js';
import type { PortalAuthenticatedSession, PortalSessionIdentity } from './auth-service.js';

export const CENTRAL_CONTENT_ORIGIN = 'https://app.relaunch72.com';
export const CENTRAL_CONTENT_COOKIE = '__Host-r72_content' as const;
export const CENTRAL_CONTENT_LOGIN_CSRF_COOKIE = '__Host-r72_content_login_csrf' as const;

export function centralContentOrigin(env: NodeJS.ProcessEnv): string | null {
  if (env.R72_CONTENT_ENABLED !== 'true') return null;
  if (env.R72_CONTENT_ORIGIN !== CENTRAL_CONTENT_ORIGIN) throw new Error('R72_CONTENT_ORIGIN must be the exact approved HTTPS origin');
  return CENTRAL_CONTENT_ORIGIN;
}

function status(res: ServerResponse, code: number, message: string): void {
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store',
    'x-robots-tag': 'noindex, nofollow', 'x-content-type-options': 'nosniff' });
  res.end(message);
}

export function createCentralContentMount(input: {
  origin: string;
  portal: PostgresPortalDeps;
  /** Must resolve genuine canonical membership, not a posted role or brand name. */
  authorize(identity: PortalSessionIdentity, requestId: string): Promise<boolean>;
}) {
  if (input.origin !== CENTRAL_CONTENT_ORIGIN) throw new Error('Unapproved content application origin');
  const hostname = new URL(input.origin).hostname;
  const base = input.portal;
  const sessionSecret = createHmac('sha256', base.sessionSecret).update('relaunch72/content-central/csrf/v1').digest('hex');
  const permittedSession = async (session: PortalAuthenticatedSession | null): Promise<PortalAuthenticatedSession | null> => {
    if (!session) return null;
    if (await input.authorize(session, randomUUID())) return session;
    await base.auth.revoke(session.sessionToken);
    return null;
  };
  const portal: PostgresPortalDeps = {
    ...base, sessionSecret, secure: true, sessionCookieName: CENTRAL_CONTENT_COOKIE,
    loginCsrfCookieName: CENTRAL_CONTENT_LOGIN_CSRF_COOKIE,
    productProfile: RELAUNCH72_PRODUCT_PROFILE, portalBaseUrl: input.origin, propertyPredatorSso: undefined,
    authorizeMemberRequest: undefined,
    auth: {
      resolve: (token, now) => base.auth.resolve(token, now), revoke: token => base.auth.revoke(token),
      login: async (email, password, context) => permittedSession(await base.auth.login(email, password, context)),
      ...(base.auth.completeSetup ? { completeSetup: async (token: string, password: string, context: Parameters<NonNullable<typeof base.auth.completeSetup>>[2]) =>
        permittedSession(await base.auth.completeSetup!(token, password, context)) } : {}),
    },
  };
  return {
    hostname,
    readiness: async (): Promise<readonly string[]> => base.seoBlog && base.companyContent ? [] : ['Central content dependencies are unavailable'],
    async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
      // Ignore proxy host headers; ports, userinfo, suffixes and unknown routes never fall through.
      if (req.headers.host?.toLowerCase() !== hostname) return status(res, 421, 'Misdirected request.');
      const url = new URL(req.url ?? '/', input.origin);
      const method = req.method ?? 'GET';
      const seo = url.pathname === '/portal/seo-blog' || url.pathname.startsWith('/portal/seo-blog/');
      const auth = ['/portal/login', '/portal/logout', '/portal/setup'].includes(url.pathname);
      const asset = url.pathname === '/portal/appearance.js' && method === 'GET';
      if (method === 'POST' && (req.headers.origin !== input.origin
          || (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin'))) {
        return status(res, 403, 'Refresh this page before submitting the form.');
      }
      if (['/', '/portal', '/portal/'].includes(url.pathname) && method === 'GET') {
        res.writeHead(303, { location: '/portal/seo-blog', 'cache-control': 'no-store' }); res.end(); return;
      }
      if (!seo && !auth && !asset) return status(res, 404, 'Page not found.');
      if (!base.seoBlog) return status(res, 503, 'The content application is temporarily unavailable.');
      if (seo) {
        const token = parseCookies(req.headers.cookie)[CENTRAL_CONTENT_COOKIE];
        const identity = token ? await base.auth.resolve(token, Date.now()) : null;
        // This guard must run before handlePortal's early SEO route delegation.
        if (identity && !await input.authorize(identity, randomUUID())) return status(res, 403, 'An active owner or managing membership is required.');
      }
      await handlePortal(req, res, portal);
    },
  };
}
