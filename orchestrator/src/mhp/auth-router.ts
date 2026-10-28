import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseCookies } from '../server/admin/session.js';
import { verifyPortalCsrf } from '../portal/session.js';
import { authSubjectAbuseAdmission, sourceAbuseAdmission, type PortalAbuseGuard, type PortalAbuseOutcome } from '../portal/abuse.js';
import type { PortalRequestContext } from '../portal/request-context.js';
import type { PortalAuthRequestContext, PortalAuthenticatedSession } from '../portal/auth-service.js';
import { MHP_AUTH_HOST, MHP_AUTH_ORIGIN, MHP_OPAQUE_TOKEN, MHP_SESSION_COOKIE, normalizeMhpEmail, type MhpAuthPurpose, type MhpAuthService } from './auth-service.js';
import type { MhpTransactionalMailer } from './transactional-mail.js';

const CSRF_COOKIE = '__Host-mhp_auth_csrf';
const INTENT_COOKIE = '__Host-mhp_auth_intent';
const TTL = 15 * 60_000;
const PATHS = new Set(['/portal/login', '/portal/logout', '/portal/auth/magic', '/portal/auth/reset', '/portal/auth/verify', '/portal/auth/complete', '/portal/setup']);
const escape = (value: string): string => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
const cookie = (name: string, value: string, seconds: number): string => `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${seconds}`;
const mac = (secret: string, scope: string, value: string): string => createHmac('sha256', secret).update(`mhp/auth/${scope}/v1\0`).update(value).digest('base64url');
const equal = (left: string, right: string): boolean => {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
};
function freshCsrfCookie(value: string | undefined, now: number): value is string {
  if (!value) return false;
  const parts = value.split('.');
  const issuedAt = Number(parts[1]);
  return parts.length === 2 && MHP_OPAQUE_TOKEN.test(parts[0] ?? '') && Number.isSafeInteger(issuedAt)
    && issuedAt <= now + 60_000 && now - issuedAt <= TTL;
}

function securityHeaders(res: ServerResponse): void {
  res.setHeader('cache-control', 'no-store');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
}
function redirect(res: ServerResponse, target: string, cookies: string[] = []): void {
  if (cookies.length) res.setHeader('set-cookie', cookies);
  res.writeHead(303, { location: target }); res.end();
}
function page(res: ServerResponse, status: number, title: string, content: string, cookies: string[] = []): void {
  if (cookies.length) res.setHeader('set-cookie', cookies);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · Martin Howard Property</title><style>*{box-sizing:border-box}body{margin:0;background:#f4f4ef;color:#142019;font:16px/1.55 system-ui,-apple-system,sans-serif}a{color:inherit}main{min-height:100svh;display:grid;grid-template-columns:1fr 1fr}.story{background:#142019;color:#f6f5ee;padding:clamp(32px,7vw,100px);display:flex;flex-direction:column;justify-content:space-between;position:relative;overflow:hidden}.story:after{content:'';position:absolute;right:-100px;bottom:-120px;width:400px;height:400px;border:1px solid #e8a33d44;border-radius:50%;box-shadow:0 0 0 70px #e8a33d08,0 0 0 140px #e8a33d05}.wordmark{display:flex;align-items:center;gap:14px;font-size:11px;letter-spacing:2px;font-weight:700}.monogram{border:1px solid #e8a33d;color:#e8a33d;border-radius:10px;width:46px;height:46px;display:grid;place-items:center;font:24px Georgia,serif;letter-spacing:-3px;padding-right:3px}.story h2{font:clamp(38px,4vw,64px)/1.08 Georgia,serif;font-weight:400;max-width:470px;margin:56px 0 24px}.story h2 em{font-style:normal;color:#e8a33d}.story p{max-width:390px;color:#bac6bc}.story footer{font-size:12px;color:#aab7ac;margin-top:64px}.panel{display:grid;place-items:center;padding:40px 24px}.card{width:min(100%,430px)}.eyebrow{text-transform:uppercase;letter-spacing:2px;color:#627367;font-size:11px;font-weight:800}h1{font:36px/1.15 Georgia,serif;font-weight:400;margin:12px 0 16px}.intro{color:#5b6b5f;margin-bottom:30px}label{display:block;margin:18px 0 7px;font-size:13px;font-weight:700}input{width:100%;border:1px solid #cdd5cc;border-radius:9px;padding:14px;background:#fff;color:#142019;font:inherit}input:focus{outline:3px solid #e8a33d55;border-color:#a36a17}button{cursor:pointer;border:0;border-radius:9px;padding:15px 18px;font:700 15px system-ui;width:100%;background:#e8a33d;color:#142019;margin-top:24px}button:hover{background:#efb55b}.links{display:flex;flex-wrap:wrap;gap:12px;justify-content:space-between;margin-top:22px;font-size:13px}.notice{padding:16px;border:1px solid #d6ded2;border-radius:10px;background:#e9efe5;margin:20px 0}.help{margin-top:34px;color:#627367;font-size:12px}.help a{text-decoration-thickness:1px}.small{font-size:13px;color:#627367}@media(max-width:760px){main{grid-template-columns:1fr}.story{padding:26px}.story h2,.story p,.story footer{display:none}.story:after{display:none}.panel{padding:40px 24px;place-items:start center}h1{font-size:32px}}@media(prefers-reduced-motion:no-preference){button,input{transition:background .15s,border-color .15s}}</style></head><body><main><aside class="story"><div class="wordmark"><span class="monogram" aria-hidden="true">MH</span><span>MARTIN HOWARD<br>PROPERTY</span></div><div><h2>Build relationships.<br><em>Create opportunity.</em></h2><p>Your own place to organise investors, follow through on conversations and take the next step with confidence.</p></div><footer>Practical support. Your business. Your pace.</footer></aside><section class="panel"><div class="card"><div class="eyebrow">Your member workspace</div><h1>${escape(title)}</h1>${content}<p class="help">Need a hand? <a href="mailto:martin@propinvestuk.co.uk">martin@propinvestuk.co.uk</a><br><a href="https://martinhowardproperty.co.uk/">Back to Martin Howard Property</a></p></div></section></main></body></html>`;
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(html) }); res.end(html);
}

function sealIntent(secret: string, token: string, purpose: MhpAuthPurpose, now: number): string {
  const key = createHash('sha256').update('mhp/auth/intent/key/v1\0').update(secret).digest();
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(MHP_AUTH_ORIGIN));
  const body = Buffer.concat([cipher.update(JSON.stringify({ token, purpose, at: now })), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), body]).toString('base64url');
}
function openIntent(secret: string, value: string | undefined, now: number): { token: string; purpose: MhpAuthPurpose } | null {
  if (!value || value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const raw = Buffer.from(value, 'base64url');
    if (raw.length < 30) return null;
    const key = createHash('sha256').update('mhp/auth/intent/key/v1\0').update(secret).digest();
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(MHP_AUTH_ORIGIN)); decipher.setAuthTag(raw.subarray(12, 28));
    const data = JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8')) as { token?: unknown; purpose?: unknown; at?: unknown };
    if (typeof data.token !== 'string' || !MHP_OPAQUE_TOKEN.test(data.token) || (data.purpose !== 'magic' && data.purpose !== 'reset')
      || typeof data.at !== 'number' || !Number.isFinite(data.at) || data.at > now + 60_000 || now - data.at > TTL) return null;
    return { token: data.token, purpose: data.purpose };
  } catch { return null; }
}

class FormError extends Error { constructor(readonly status: number) { super('Invalid authentication request'); } }
async function readForm(req: IncomingMessage): Promise<Record<string, string>> {
  const type = req.headers['content-type'];
  if (typeof type !== 'string' || !/^application\/x-www-form-urlencoded(?:;\s*charset=utf-8)?$/i.test(type)) throw new FormError(415);
  const raw = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []; let count = 0; let settled = false;
    const clean = (): void => { req.off('data', data); req.off('end', end); req.off('aborted', abort); req.off('error', fail); };
    const fail = (): void => { if (settled) return; settled = true; clean(); req.resume(); reject(new FormError(count > 16_384 ? 413 : 400)); };
    const data = (value: Buffer | string): void => { const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value); count += chunk.length; if (count > 16_384) return fail(); chunks.push(chunk); };
    const end = (): void => { if (settled) return; settled = true; clean(); resolve(Buffer.concat(chunks)); };
    const abort = (): void => fail();
    if (Number(req.headers['content-length'] ?? 0) > 16_384) { count = 16_385; fail(); return; }
    req.on('data', data); req.on('end', end); req.on('aborted', abort); req.on('error', fail);
  });
  const params = new URLSearchParams(raw.toString('utf8')); const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, value] of params) { if (Object.hasOwn(result, key)) throw new FormError(400); result[key] = value; }
  return result;
}

export interface MhpAuthMountDeps {
  auth: MhpAuthService;
  mail: MhpTransactionalMailer;
  sessionSecret: string;
  abuse: PortalAbuseGuard;
  abuseHashSecret: string;
  requestContext(req: IncomingMessage): PortalRequestContext | null;
  now?: () => number;
}

export function createMhpAuthMount(deps: MhpAuthMountDeps): { handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> } {
  if (deps.sessionSecret.length < 32 || deps.abuseHashSecret.length < 32) throw new Error('MHP authentication secrets are not ready');
  return { async handle(req, res, url): Promise<boolean> {
    if (!PATHS.has(url.pathname) && !url.pathname.startsWith('/portal/auth/property-predator')) return false;
    securityHeaders(res);
    if (typeof req.headers.host !== 'string' || ![MHP_AUTH_HOST, `${MHP_AUTH_HOST}:443`].includes(req.headers.host.toLowerCase())) {
      page(res, 421, 'Use your member address', '<p>Open app.martinhowardproperty.co.uk to sign in.</p>'); return true;
    }
    if (url.pathname === '/portal/setup' || url.pathname.startsWith('/portal/auth/property-predator')) {
      page(res, 404, 'Use your MHP sign-in', '<p><a href="/portal/login">Sign in with your password or an email link.</a></p>'); return true;
    }
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'POST') { res.setHeader('allow', 'GET, POST'); page(res, 405, 'Try signing in again', '<p>That request is not supported.</p>'); return true; }
    const now = deps.now?.() ?? Date.now();
    const cookies = parseCookies(req.headers.cookie);
    const loginForm = (status = 200, notice = ''): void => {
      const nonce = `${randomBytes(32).toString('base64url')}.${now}`;
      const route = url.pathname === '/portal/auth/reset' ? 'reset' : url.pathname === '/portal/auth/magic' ? 'magic' : 'login';
      const title = route === 'reset' ? 'Set your password' : route === 'magic' ? 'A link to your workspace' : 'Welcome back.';
      const action = route === 'reset' ? '/portal/auth/reset' : route === 'magic' ? '/portal/auth/magic' : '/portal/login';
      const introduction = route === 'login' ? 'Sign in to your account and pick up where you left off.' : 'Enter the email address you used to join. We’ll send you a secure, one-time link.';
      page(res, status, title, `<p class="intro">${introduction}</p>${notice ? `<div class="notice" role="status">${escape(notice)}</div>` : ''}<form method="post" action="${action}"><input type="hidden" name="_auth_csrf" value="${mac(deps.sessionSecret, 'csrf', nonce)}"><label for="email">Email address</label><input id="email" name="email" type="email" required maxlength="320" autocomplete="email">${route === 'login' ? '<label for="password">Password</label><input id="password" name="password" type="password" required maxlength="1024" autocomplete="current-password">' : ''}<button>${route === 'login' ? 'Sign in to Your Desk' : 'Email my secure link'}</button></form><nav class="links" aria-label="Sign-in options"><a href="/portal/login">Use a password</a><a href="/portal/auth/magic">Email me a sign-in link</a><a href="/portal/auth/reset">Set or reset password</a></nav>`, [cookie(CSRF_COOKIE, nonce, TTL / 1000)]);
    };
    const failure = (): void => page(res, 400, 'That link is no longer available', '<p>It may have expired or already been used. Request a new link to continue.</p><p><a href="/portal/auth/magic">Email me a fresh sign-in link</a></p>', [cookie(INTENT_COOKIE, '', 0)]);
    if (method === 'GET') {
      if (url.pathname === '/portal/logout') { res.setHeader('allow', 'POST'); page(res, 405, 'Sign out from your account', '<p>Use the sign-out button in your workspace.</p>'); return true; }
      if (url.pathname === '/portal/auth/verify') {
        const token = url.searchParams.get('token'), purpose = url.searchParams.get('purpose');
        if (!token || !MHP_OPAQUE_TOKEN.test(token) || (purpose !== 'magic' && purpose !== 'reset')
          || url.searchParams.getAll('token').length !== 1 || url.searchParams.getAll('purpose').length !== 1
          || [...url.searchParams.keys()].some(key => key !== 'token' && key !== 'purpose')) { failure(); return true; }
        redirect(res, '/portal/auth/complete', [cookie(INTENT_COOKIE, sealIntent(deps.sessionSecret, token, purpose, now), TTL / 1000)]); return true;
      }
      if (url.pathname === '/portal/auth/complete') {
        const intentValue = cookies[INTENT_COOKIE], intent = openIntent(deps.sessionSecret, intentValue, now);
        if (!intent) { failure(); return true; }
        page(res, 200, intent.purpose === 'reset' ? 'Choose your password' : 'Your workspace is ready', `<p class="intro">${intent.purpose === 'reset' ? 'Use at least 12 characters. This change signs out your other sessions.' : 'Continue to securely sign in to Martin Howard Property.'}</p><form method="post" action="/portal/auth/complete"><input type="hidden" name="_auth_csrf" value="${mac(deps.sessionSecret, 'intent', intentValue!)}">${intent.purpose === 'reset' ? '<label for="password">New password</label><input id="password" name="password" type="password" minlength="12" maxlength="1024" autocomplete="new-password" required><label for="confirm">Confirm password</label><input id="confirm" name="confirm" type="password" minlength="12" maxlength="1024" autocomplete="new-password" required>' : ''}<button>${intent.purpose === 'reset' ? 'Save password and sign in' : 'Continue to my account'}</button></form>`); return true;
      }
      loginForm(); return true;
    }

    if (req.headers.origin !== MHP_AUTH_ORIGIN || (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin')) {
      page(res, 403, 'Refresh this page', '<p>Open the sign-in page again before continuing.</p>'); return true;
    }
    const context = deps.requestContext(req);
    if (!context?.sourceHash) { page(res, 503, 'Sign-in is temporarily unavailable', '<p>Please try again shortly.</p>'); return true; }
    const authContext: PortalAuthRequestContext = { now, sourceHash: context.sourceHash, userAgent: req.headers['user-agent'] };
    const leases: Buffer[] = []; let outcome: PortalAbuseOutcome = 'success';
    const admit = async (subject?: string): Promise<boolean> => {
      const admission = subject === undefined ? sourceAbuseAdmission(context, 'auth.login', now) : authSubjectAbuseAdmission(context, 'auth.login', deps.abuseHashSecret, `mhp/${subject}`, now);
      if (!admission) throw new Error('MHP abuse context unavailable');
      const decision = await deps.abuse.admit(admission);
      if (decision.allowed) { if (decision.leaseHash) leases.push(decision.leaseHash); return true; }
      res.setHeader('retry-after', String(Math.max(1, Math.ceil(decision.retryAfterSeconds))));
      page(res, 429, 'Take a moment', '<p>There have been several attempts. Please try again shortly.</p>'); return false;
    };
    const signIn = (session: PortalAuthenticatedSession): void => {
      const ttl = Math.min(86_400, Math.max(1, Math.floor((Date.parse(session.expiresAt ?? '') - now) / 1000)));
      if (!Number.isFinite(ttl)) throw new Error('MHP session expiry unavailable');
      redirect(res, '/app/account', [cookie(MHP_SESSION_COOKIE, session.sessionToken, ttl), cookie(INTENT_COOKIE, '', 0), cookie(CSRF_COOKIE, '', 0)]);
    };
    try {
      if (!await admit()) return true;
      const form = await readForm(req);
      if (url.pathname === '/portal/logout') {
        const token = cookies[MHP_SESSION_COOKIE] ?? '';
        if (!MHP_OPAQUE_TOKEN.test(token) || !verifyPortalCsrf(deps.sessionSecret, token, form._csrf)) throw new FormError(403);
        await deps.auth.revoke(token);
        redirect(res, '/portal/login', [cookie(MHP_SESSION_COOKIE, '', 0), cookie(INTENT_COOKIE, '', 0)]); return true;
      }
      if (url.pathname === '/portal/auth/complete') {
        const value = cookies[INTENT_COOKIE], intent = openIntent(deps.sessionSecret, value, now);
        if (!intent || !equal(form._auth_csrf ?? '', mac(deps.sessionSecret, 'intent', value!))) throw new FormError(403);
        if (!await admit(`token/${intent.token}`)) return true;
        if (intent.purpose === 'reset' && (form.password !== form.confirm || !form.password || form.password.length < 12 || form.password.length > 1024)) {
          page(res, 400, 'Check your new password', '<p>Use at least 12 characters and enter the same password twice.</p><p><a href="/portal/auth/complete">Try again</a></p>'); return true;
        }
        const session = await deps.auth.consumeLink(intent.token, intent.purpose, intent.purpose === 'reset' ? form.password : undefined, authContext);
        if (!session) { outcome = 'auth_failure'; failure(); return true; }
        signIn(session); return true;
      }
      if (!['/portal/login', '/portal/auth/magic', '/portal/auth/reset'].includes(url.pathname)) throw new FormError(405);
      const csrfCookie = cookies[CSRF_COOKIE];
      if (!freshCsrfCookie(csrfCookie, now) || !equal(form._auth_csrf ?? '', mac(deps.sessionSecret, 'csrf', csrfCookie))) throw new FormError(403);
      const email = normalizeMhpEmail(form.email ?? '');
      if (!email) { loginForm(400, 'Enter a valid email address.'); return true; }
      if (!await admit(`email/${email}`)) return true;
      if (url.pathname === '/portal/login') {
        const session = await deps.auth.login(email, form.password ?? '', authContext);
        if (!session) { outcome = 'auth_failure'; loginForm(401, 'We could not sign you in with those details. You can also request an email sign-in link.'); return true; }
        signIn(session); return true;
      }
      if (!deps.mail.configured) { page(res, 503, 'Email sign-in is not ready yet', '<p>Please try again shortly, or use your existing password.</p><p><a href="/portal/login">Sign in with a password</a></p>'); return true; }
      const purpose: MhpAuthPurpose = url.pathname === '/portal/auth/reset' ? 'reset' : 'magic';
      const link = await deps.auth.requestLink(email, purpose, authContext);
      if (link) {
        // The long-running server delivers independently of the HTTP response.
        // Waiting for a provider only for eligible addresses is an account-enumeration timing oracle.
        // The mailer has a hard concurrency cap and timeout; a restart/failure leaves a harmless
        // expiring token and the member can request another link. No raw token is logged.
        void deps.mail.sendAuthLink(link.email, link.url, purpose).catch(() => undefined);
      }
      loginForm(200, 'If this email is linked to an eligible account, a secure link will arrive shortly. Check your inbox and spam folder.'); return true;
    } catch (error) {
      outcome = error instanceof FormError ? 'auth_failure' : 'service_error';
      if (!res.headersSent) page(res, error instanceof FormError ? error.status : 503, 'We could not complete that request', '<p>Please refresh the sign-in page and try again.</p><p><a href="/portal/login">Return to sign in</a></p>');
      return true;
    } finally {
      await Promise.allSettled(leases.map(lease => deps.abuse.complete(lease, outcome)));
    }
  } };
}
