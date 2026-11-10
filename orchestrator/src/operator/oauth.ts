/**
 * Minimal OAuth 2.1 authorization server for the operator MCP endpoint, which is
 * what claude.ai custom connectors require (dynamic client registration, PKCE S256,
 * authorization code, refresh, revocation). Client ids are signed, stateless
 * descriptions of the registered redirect URIs; codes, access and refresh tokens
 * are opaque random values whose hashes live in the database (migration 0148):
 * a code is redeemable once across every instance, refresh tokens are bound to
 * their client and rotated on use, and reuse revokes the connection.
 */
import { createHash, randomBytes } from 'node:crypto';
import { OPERATOR_MCP_PATH, OPERATOR_OAUTH_PATHS } from './config.js';
import type { OperatorOAuthStore } from './oauth-store.js';
import { signBlob, verifyBlob } from './tokens.js';

export const OAUTH_SCOPE = 'operator';
export const ACCESS_LIFETIME_SECONDS = 3600;
export const REFRESH_LIFETIME_SECONDS = 30 * 24 * 3600;
const CODE_LIFETIME_SECONDS = 120;
/** S256 challenges are exactly one base64url SHA-256 digest. */
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const OPAQUE = /^[A-Za-z0-9_-]{43}$/;
const STATE = /^[\x20-\x7e]{0,512}$/;

const sha256 = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();
const opaque = (): string => randomBytes(32).toString('base64url');

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
    revocation_endpoint: `${origin}${OPERATOR_OAUTH_PATHS.revoke}`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
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

export interface TokenReply { readonly status: number; readonly body: Record<string, unknown> }

export class OperatorOAuth {
  constructor(
    private readonly secret: string,
    private readonly store: OperatorOAuthStore,
    private readonly now: () => number = Date.now,
  ) {}

  private sec(): number { return Math.floor(this.now() / 1000); }
  private date(offsetSeconds = 0): Date { return new Date(this.now() + offsetSeconds * 1000); }

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

  /** Persists a consented code for two minutes and returns it; null if the subject is not an active user. */
  async issueCode(client: RegisteredClient, redirectUri: string, challenge: string, subject: string): Promise<string | null> {
    const code = opaque();
    const ok = await this.store.issueCode({ codeHash: sha256(code), clientIdHash: sha256(client.id), clientName: client.name,
      redirectUriHash: sha256(redirectUri), codeChallenge: challenge, subject, now: this.date(), expiresAt: this.date(CODE_LIFETIME_SECONDS) });
    return ok ? code : null;
  }

  /** Token endpoint: authorization_code (PKCE) or refresh_token (client-bound, rotated). */
  async exchange(form: URLSearchParams): Promise<TokenReply> {
    const grant = form.get('grant_type');
    const invalid = (error: string, status = 400): TokenReply => ({ status, body: { error } });
    const single = (key: string) => (form.getAll(key).length === 1 ? form.get(key)! : null);
    const clientId = single('client_id');
    const client = this.client(clientId);
    if (grant === 'authorization_code') {
      const code = single('code'), redirectUri = single('redirect_uri'), verifier = single('code_verifier');
      if (!code || !OPAQUE.test(code) || !redirectUri || !verifier || !VERIFIER.test(verifier)) return invalid('invalid_request');
      if (!client) return invalid('invalid_client', 401);
      const access = opaque(), refresh = opaque();
      const result = await this.store.redeemCode({ codeHash: sha256(code), clientIdHash: sha256(client.id), redirectUriHash: sha256(redirectUri),
        verifierChallenge: createHash('sha256').update(verifier).digest('base64url'),
        accessHash: sha256(access), accessExpiresAt: this.date(ACCESS_LIFETIME_SECONDS),
        refreshHash: sha256(refresh), refreshExpiresAt: this.date(REFRESH_LIFETIME_SECONDS), now: this.date() });
      if (result.outcome !== 'issued') return invalid('invalid_grant');
      return { status: 200, body: this.tokenBody(access, refresh) };
    }
    if (grant === 'refresh_token') {
      const presented = single('refresh_token');
      if (!presented || !OPAQUE.test(presented)) return invalid('invalid_request');
      // Public clients must identify themselves; the refresh token is bound to that client.
      if (!client) return invalid('invalid_client', 401);
      const access = opaque(), next = opaque();
      const result = await this.store.refresh({ refreshHash: sha256(presented), clientIdHash: sha256(client.id),
        accessHash: sha256(access), accessExpiresAt: this.date(ACCESS_LIFETIME_SECONDS),
        newRefreshHash: sha256(next), refreshExpiresAt: this.date(REFRESH_LIFETIME_SECONDS), now: this.date() });
      if (result.outcome !== 'issued') return invalid('invalid_grant');
      return { status: 200, body: this.tokenBody(access, next) };
    }
    return invalid(grant ? 'unsupported_grant_type' : 'invalid_request');
  }

  /** RFC 7009: always 200 to the caller; a matching token of this client ends its grant. */
  async revoke(form: URLSearchParams): Promise<TokenReply> {
    const token = form.get('token');
    const client = this.client(form.get('client_id'));
    if (!client) return { status: 401, body: { error: 'invalid_client' } };
    if (token && OPAQUE.test(token)) await this.store.revokeToken(sha256(token), sha256(client.id), this.date());
    return { status: 200, body: {} };
  }

  private tokenBody(access: string, refresh: string): Record<string, unknown> {
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_LIFETIME_SECONDS, refresh_token: refresh, scope: OAUTH_SCOPE };
  }

  /** The subject of a live access token, or null. */
  async subject(accessToken: string): Promise<string | null> {
    if (!OPAQUE.test(accessToken)) return null;
    return this.store.resolve(sha256(accessToken), this.date());
  }

  listGrants(subject: string) { return this.store.listGrants(subject); }
  revokeGrant(subject: string, grantId: string) { return this.store.revokeGrant(subject, grantId, this.date()); }
}
