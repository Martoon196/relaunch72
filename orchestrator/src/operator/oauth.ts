/**
 * Minimal OAuth 2.1 authorization server for the operator MCP endpoint, which is
 * what claude.ai custom connectors require (dynamic client registration, PKCE S256,
 * authorization code, refresh). Only the configured operator user can authorise,
 * from a signed-in portal session; everything issued is a signed, stateless blob.
 */
import { createHash, randomBytes } from 'node:crypto';
import { OPERATOR_MCP_PATH, OPERATOR_OAUTH_PATHS } from './config.js';
import { ConsumedNonces, signBlob, verifyBlob } from './tokens.js';

export const OAUTH_SCOPE = 'operator';
const ACCESS_LIFETIME = 3600;
const REFRESH_LIFETIME = 30 * 24 * 3600;
const CODE_LIFETIME = 120;
const CHALLENGE = /^[A-Za-z0-9._~-]{43,128}$/;
const STATE = /^[\x20-\x7e]{0,512}$/;

export interface RegisteredClient { readonly id: string; readonly name: string; readonly redirectUris: readonly string[] }

export function protectedResourceMetadata(origin: string) {
  return { resource: `${origin}${OPERATOR_MCP_PATH}`, authorization_servers: [origin], bearer_methods_supported: ['header'], scopes_supported: [OAUTH_SCOPE] };
}

export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}${OPERATOR_OAUTH_PATHS.authorize}`,
    token_endpoint: `${origin}${OPERATOR_OAUTH_PATHS.token}`,
    registration_endpoint: `${origin}${OPERATOR_OAUTH_PATHS.register}`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [OAUTH_SCOPE],
  };
}

/** https with no fragment, or loopback http for local MCP clients. */
export function validRedirectUri(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2000 || value.includes('#')) return false;
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.username || url.password) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]');
}

export class OperatorOAuth {
  private readonly codes = new ConsumedNonces();
  constructor(private readonly secret: string, private readonly now: () => number = Date.now) {}

  private sec(): number { return Math.floor(this.now() / 1000); }

  /** Dynamic client registration; the client id is a signed description of the client, so nothing is stored. */
  register(body: unknown): RegisteredClient | null {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    const b = body as Record<string, unknown>;
    const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris : [];
    if (uris.length < 1 || uris.length > 5 || !uris.every(validRedirectUri)) return null;
    const name = typeof b.client_name === 'string' ? b.client_name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 100) : '';
    const method = b.token_endpoint_auth_method;
    if (method !== undefined && method !== 'none') return null;
    const id = signBlob(this.secret, 'oauth-client', { uris, name, iat: this.sec() });
    return Object.freeze({ id, name: name || 'MCP client', redirectUris: Object.freeze([...uris] as string[]) });
  }

  client(clientId: unknown): RegisteredClient | null {
    if (typeof clientId !== 'string') return null;
    const c = verifyBlob(this.secret, 'oauth-client', clientId, this.sec());
    if (!c || !Array.isArray(c.uris) || !c.uris.every(validRedirectUri)) return null;
    return Object.freeze({ id: clientId, name: typeof c.name === 'string' && c.name ? c.name : 'MCP client', redirectUris: Object.freeze([...c.uris] as string[]) });
  }

  /** Validates an authorization request; a failure never redirects anywhere. */
  authorizationRequest(params: URLSearchParams): { client: RegisteredClient; redirectUri: string; challenge: string; state: string } | null {
    const single = (key: string) => (params.getAll(key).length === 1 ? params.get(key)! : null);
    if (single('response_type') !== 'code') return null;
    const client = this.client(single('client_id'));
    const redirectUri = single('redirect_uri');
    const challenge = single('code_challenge');
    const state = single('state') ?? '';
    const scope = single('scope');
    if (!client || !redirectUri || !client.redirectUris.includes(redirectUri)) return null;
    if (single('code_challenge_method') !== 'S256' || !challenge || !CHALLENGE.test(challenge) || !STATE.test(state)) return null;
    if (scope !== null && scope !== '' && scope.split(' ').some((s) => s !== OAUTH_SCOPE)) return null;
    return { client, redirectUri, challenge, state };
  }

  issueCode(client: RegisteredClient, redirectUri: string, challenge: string, subject: string): string {
    const iat = this.sec();
    return signBlob(this.secret, 'oauth-code', { cid: client.id, uri: redirectUri, cc: challenge, sub: subject, scope: OAUTH_SCOPE, iat, exp: iat + CODE_LIFETIME, n: randomBytes(18).toString('base64url') });
  }

  /** Authorization-code exchange with PKCE; a code is accepted once. */
  exchange(form: URLSearchParams): { body: Record<string, unknown>; status: number } {
    const grant = form.get('grant_type');
    const invalid = (error: string, status = 400) => ({ status, body: { error } });
    if (grant === 'authorization_code') {
      const code = verifyBlob(this.secret, 'oauth-code', form.get('code'), this.sec());
      const verifier = form.get('code_verifier') ?? '';
      if (!code || typeof code.n !== 'string' || typeof code.sub !== 'string' || typeof code.cc !== 'string') return invalid('invalid_grant');
      if (code.cid !== form.get('client_id') || code.uri !== form.get('redirect_uri')) return invalid('invalid_grant');
      if (!CHALLENGE.test(verifier) || createHash('sha256').update(verifier).digest('base64url') !== code.cc) return invalid('invalid_grant');
      if (!this.codes.consume(code.n, Number(code.exp), this.sec())) return invalid('invalid_grant');
      return { status: 200, body: this.tokens(code.sub) };
    }
    if (grant === 'refresh_token') {
      const refresh = verifyBlob(this.secret, 'oauth-refresh', form.get('refresh_token'), this.sec());
      if (!refresh || typeof refresh.sub !== 'string') return invalid('invalid_grant');
      if (form.get('client_id') && !this.client(form.get('client_id'))) return invalid('invalid_client', 401);
      return { status: 200, body: { ...this.tokens(refresh.sub, false), refresh_token: form.get('refresh_token') } };
    }
    return invalid(grant ? 'unsupported_grant_type' : 'invalid_request');
  }

  private tokens(subject: string, withRefresh = true): Record<string, unknown> {
    const iat = this.sec();
    const access = signBlob(this.secret, 'oauth-access', { sub: subject, scope: OAUTH_SCOPE, iat, exp: iat + ACCESS_LIFETIME, jti: randomBytes(12).toString('base64url') });
    const out: Record<string, unknown> = { access_token: access, token_type: 'Bearer', expires_in: ACCESS_LIFETIME, scope: OAUTH_SCOPE };
    if (withRefresh) out.refresh_token = signBlob(this.secret, 'oauth-refresh', { sub: subject, scope: OAUTH_SCOPE, iat, exp: iat + REFRESH_LIFETIME, jti: randomBytes(12).toString('base64url') });
    return out;
  }

  /** The subject of a valid access token, or null. */
  subject(accessToken: string): string | null {
    const claims = verifyBlob(this.secret, 'oauth-access', accessToken, this.sec());
    return claims && typeof claims.sub === 'string' && claims.scope === OAUTH_SCOPE ? claims.sub : null;
  }
}
