/**
 * HTTP surface of the operator API on the canonical (Property Predator) host:
 *   GET  /.well-known/oauth-protected-resource, /.well-known/oauth-authorization-server
 *   POST /api/operator/oauth/register        dynamic client registration (claude.ai)
 *   GET/POST /api/operator/oauth/authorize   consent, only for the signed-in operator user
 *   POST /api/operator/oauth/token           code / refresh exchange (PKCE)
 *   POST /api/operator/mcp                   MCP, bearer = static token or OAuth access token
 */
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PortalAuthService } from '../portal/auth-service.js';
import { portalCsrfToken, verifyPortalCsrf } from '../portal/session.js';
import { escapeHtml as e } from '../portal/ui.js';
import { parseCookies } from '../server/admin/session.js';
import { OPERATOR_MCP_PATH, OPERATOR_OAUTH_PATHS, type OperatorConfig } from './config.js';
import { McpServer, type McpToolHost } from './mcp.js';
import { OperatorOAuth, authorizationServerMetadata, protectedResourceMetadata } from './oauth.js';

const MAX_BODY = 256 * 1024;
const PORTAL_COOKIE = 'r72_portal';

export interface OperatorMountDependencies {
  readonly config: OperatorConfig;
  /** Canonical https origin of this host, used in OAuth metadata. */
  readonly origin: string;
  /** Resolves the portal cookie for the consent page. */
  readonly auth: Pick<PortalAuthService, 'resolve'>;
  readonly tools: McpToolHost;
  readonly sessionSecret: string;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

async function readBody(req: IncomingMessage): Promise<Buffer | null> {
  if (Number(req.headers['content-length'] ?? 0) > MAX_BODY) return null;
  const parts: Buffer[] = []; let length = 0;
  for await (const raw of req) {
    const part = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    length += part.length;
    if (length > MAX_BODY) return null;
    parts.push(part);
  }
  return Buffer.concat(parts, length);
}

function json(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const value = body === null ? '' : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(value), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra });
  res.end(value);
}

function html(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" });
  res.end(body);
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(title)}</title>
<style>body{font-family:system-ui,sans-serif;background:#f6f7f9;color:#111;margin:0;padding:32px 16px}main{max-width:520px;margin:0 auto;background:#fff;border:1px solid #e3e6ea;border-radius:12px;padding:28px}h1{font-size:22px;margin:0 0 12px}p{line-height:1.5}dl{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;margin:16px 0}dt{color:#555}button,a.btn{display:inline-block;border:1px solid #1d4ed8;background:#1d4ed8;color:#fff;border-radius:8px;padding:10px 18px;font:inherit;cursor:pointer;text-decoration:none}button.secondary,a.secondary{background:#fff;color:#1d4ed8}form{display:inline-block;margin-right:10px}</style></head><body><main>${body}</main></body></html>`;
}

export function createOperatorMount(deps: OperatorMountDependencies) {
  const now = deps.now ?? Date.now;
  const oauth = deps.config.oauthSecret ? new OperatorOAuth(deps.config.oauthSecret, now) : null;
  const mcp = new McpServer(deps.tools, { name: 'relaunch72', version: '1' });
  const unauthorised = (res: ServerResponse) => json(res, 401, { error: 'unauthorised' }, {
    'www-authenticate': `Bearer realm="Relaunch72 operator"${oauth ? `, resource_metadata="${deps.origin}${OPERATOR_OAUTH_PATHS.protectedResource}"` : ''}` });

  function bearerSubject(req: IncomingMessage): string | null {
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
    const presented = header.slice(7).trim();
    if (deps.config.token) {
      const a = Buffer.from(presented, 'utf8'); const b = Buffer.from(deps.config.token, 'utf8');
      if (a.length === b.length && timingSafeEqual(a, b)) return deps.config.userId;
    }
    if (oauth) {
      const subject = oauth.subject(presented);
      if (subject && subject === deps.config.userId) return subject;
    }
    return null;
  }

  async function signedInOperator(req: IncomingMessage): Promise<boolean> {
    const token = parseCookies(req.headers.cookie)[PORTAL_COOKIE] ?? '';
    if (!token) return false;
    const identity = await deps.auth.resolve(token, now()).catch(() => null);
    return identity !== null && identity.userId === deps.config.userId;
  }

  async function authorize(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (!oauth) { json(res, 404, { error: 'not found' }); return; }
    const method = req.method ?? 'GET';
    let params = url.searchParams;
    let csrf = '';
    if (method === 'POST') {
      const body = await readBody(req);
      if (!body) { html(res, 413, page('Request too large', '<h1>Request too large</h1>')); return; }
      params = new URLSearchParams(body.toString('utf8'));
      csrf = params.get('csrf') ?? '';
    } else if (method !== 'GET') { json(res, 405, { error: 'method not allowed' }, { allow: 'GET, POST' }); return; }
    const request = oauth.authorizationRequest(params);
    if (!request) { html(res, 400, page('Invalid request', '<h1>That connection request is invalid</h1><p>The client, redirect address or code challenge was not accepted. Nothing was approved.</p>')); return; }
    const sessionToken = parseCookies(req.headers.cookie)[PORTAL_COOKIE] ?? '';
    if (!(await signedInOperator(req))) {
      html(res, 401, page('Sign in first', `<h1>Sign in to Growth HQ first</h1><p>Claude wants to connect as the operator account. Sign in to this portal as that account in this browser, then come back to this page and press Continue.</p>
<p><a class="btn" href="/portal/login" target="_blank" rel="noopener">Open sign-in</a> <a class="btn secondary" href="${e(`${OPERATOR_OAUTH_PATHS.authorize}?${url.searchParams.toString()}`)}">Continue</a></p>`));
      return;
    }
    const fields = ['response_type', 'client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'state', 'scope', 'resource']
      .filter((k) => params.get(k) !== null).map((k) => `<input type="hidden" name="${k}" value="${e(params.get(k)!)}">`).join('');
    if (method === 'GET') {
      const token = portalCsrfToken(deps.sessionSecret, sessionToken);
      const redirectHost = new URL(request.redirectUri).host;
      html(res, 200, page('Allow Claude to operate Growth HQ?', `<h1>Allow <em>${e(request.client.name)}</em> to operate this portal?</h1>
<dl><dt>Acting as</dt><dd>the operator account</dd><dt>Can</dt><dd>read CRM and webinars${deps.config.writes ? ', and create or change leads, tasks and webinars' : ' (writes are disabled on this deployment)'}</dd><dt>Returns to</dt><dd>${e(redirectHost)}</dd><dt>Access lasts</dt><dd>one hour per token, renewed for 30 days</dd></dl>
<form method="post" action="${OPERATOR_OAUTH_PATHS.authorize}">${fields}<input type="hidden" name="csrf" value="${e(token)}"><input type="hidden" name="decision" value="allow"><button type="submit">Allow</button></form>
<form method="post" action="${OPERATOR_OAUTH_PATHS.authorize}">${fields}<input type="hidden" name="csrf" value="${e(token)}"><input type="hidden" name="decision" value="deny"><button type="submit" class="secondary">Deny</button></form>`));
      return;
    }
    if (!verifyPortalCsrf(deps.sessionSecret, sessionToken, csrf)) { html(res, 403, page('Expired', '<h1>That form has expired</h1><p>Start the connection again from Claude.</p>')); return; }
    const target = new URL(request.redirectUri);
    if (params.get('decision') === 'allow') {
      target.searchParams.set('code', oauth.issueCode(request.client, request.redirectUri, request.challenge, deps.config.userId));
      deps.log?.('operator oauth: authorization granted');
    } else {
      target.searchParams.set('error', 'access_denied');
    }
    if (request.state) target.searchParams.set('state', request.state);
    res.writeHead(303, { location: target.toString(), 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
    res.end();
  }

  return {
    paths: [OPERATOR_MCP_PATH, ...Object.values(OPERATOR_OAUTH_PATHS)],
    async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
      const p = url.pathname;
      const method = req.method ?? 'GET';
      if (p === OPERATOR_OAUTH_PATHS.protectedResource || p === OPERATOR_OAUTH_PATHS.authorizationServer) {
        if (!oauth) { json(res, 404, { error: 'not found' }); return; }
        if (method !== 'GET') { json(res, 405, { error: 'method not allowed' }, { allow: 'GET' }); return; }
        json(res, 200, p === OPERATOR_OAUTH_PATHS.protectedResource ? protectedResourceMetadata(deps.origin) : authorizationServerMetadata(deps.origin), { 'access-control-allow-origin': '*' });
        return;
      }
      if (p === OPERATOR_OAUTH_PATHS.register) {
        if (!oauth) { json(res, 404, { error: 'not found' }); return; }
        if (method !== 'POST') { json(res, 405, { error: 'method not allowed' }, { allow: 'POST' }); return; }
        const body = await readBody(req);
        let parsed: unknown = null;
        try { parsed = body ? JSON.parse(body.toString('utf8')) : null; } catch { parsed = null; }
        const client = oauth.register(parsed);
        if (!client) { json(res, 400, { error: 'invalid_client_metadata' }); return; }
        json(res, 201, { client_id: client.id, client_name: client.name, redirect_uris: client.redirectUris, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
        return;
      }
      if (p === OPERATOR_OAUTH_PATHS.authorize) { await authorize(req, res, url); return; }
      if (p === OPERATOR_OAUTH_PATHS.token) {
        if (!oauth) { json(res, 404, { error: 'not found' }); return; }
        if (method !== 'POST') { json(res, 405, { error: 'method not allowed' }, { allow: 'POST' }); return; }
        const body = await readBody(req);
        if (!body) { json(res, 413, { error: 'invalid_request' }); return; }
        const reply = oauth.exchange(new URLSearchParams(body.toString('utf8')));
        json(res, reply.status, reply.body);
        return;
      }
      if (p === OPERATOR_MCP_PATH) {
        if (method === 'GET' || method === 'DELETE') { json(res, 405, { error: 'This server is stateless: POST JSON-RPC requests only.' }, { allow: 'POST' }); return; }
        if (method !== 'POST') { json(res, 405, { error: 'method not allowed' }, { allow: 'POST' }); return; }
        if (!bearerSubject(req)) { unauthorised(res); return; }
        const body = await readBody(req);
        if (!body) { json(res, 413, { error: 'request body too large' }); return; }
        let parsed: unknown;
        try { parsed = JSON.parse(body.toString('utf8')); } catch { json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
        const reply = await mcp.handle(parsed);
        json(res, reply.status, reply.body);
        return;
      }
      json(res, 404, { error: 'not found' });
    },
  };
}
