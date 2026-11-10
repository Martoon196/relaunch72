/**
 * Group HQ → portal sign-in handoff.
 *
 * The founder signs in to Group HQ (password + authenticator). When they open a
 * portal page from there, Group HQ signs a short-lived token with a secret shared
 * only between the two servers; this host verifies it, maps the asserted Group HQ
 * login email to a canonical user id from its own server-owned allowlist and asks
 * the identity service for an ordinary portal session on the brand's workspace.
 *
 * Nothing in the token is authority on its own: a stranger with the token format
 * but not the secret gets a neutral refusal; a valid token for an email that is
 * not on the allowlist, or a user who is not an owner of the workspace, is refused
 * by the database function. Tokens are single use (nonce), host and path bound,
 * and live for two minutes.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { MHP_MARKETING_WORKSPACE_ID } from '../mhp/marketing-workspace-service.js';

export const GROUP_HQ_HANDOFF_ROUTE = '/portal/auth/group-hq';
export const GROUP_HQ_HANDOFF_VERSION = 'ghq-handoff-1';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const HOST = /^[a-z0-9.-]+(?::\d{1,5})?$/;
const NONCE = /^[A-Za-z0-9_-]{16,64}$/;
/** Only portal pages on this host; never a scheme, another host or a protocol-relative path. */
const PATH = /^\/portal(?:\/[A-Za-z0-9._~!$&'()*+,;=:@%-]+)*\/?(?:\?[A-Za-z0-9._~!$&'()*+,;=:@%/?-]*)?$/;
const MAX_TOKEN_LIFETIME_MS = 2 * 60_000;
const MAX_NONCES = 5000;

export type GroupHqBrand = 'pp' | 'mhp';

export interface GroupHqHandoffClaims {
  readonly v: typeof GROUP_HQ_HANDOFF_VERSION;
  /** The Group HQ login email; mapped to a canonical user by the server allowlist. */
  readonly email: string;
  readonly brand: GroupHqBrand;
  /** The portal host the token is for (exact Host header). */
  readonly host: string;
  /** Where to land after sign-in; a portal path on this host. */
  readonly path: string;
  readonly iat: number;
  readonly exp: number;
  readonly nonce: string;
}

export interface GroupHqSsoConfig {
  /** Shared with Group HQ only; 32–256 characters. */
  readonly secret: string;
  /** Group HQ login email (lower case) → canonical portal user id. */
  readonly users: ReadonlyMap<string, string>;
  /** The Property Predator Growth HQ workspace; the MHP brand uses the fixed marketing workspace. */
  readonly ppWorkspaceId: string | null;
}

export const GROUP_HQ_SSO_ENV = Object.freeze({
  secret: 'R72_GROUP_HQ_SSO_SECRET',
  users: 'R72_GROUP_HQ_SSO_USERS',
  ppWorkspace: 'R72_GROUP_HQ_CRM_PP_WORKSPACE_ID',
});

/** Returns undefined when nothing is configured; throws on a partial or malformed configuration. */
export function loadGroupHqSsoConfig(env: NodeJS.ProcessEnv): GroupHqSsoConfig | undefined {
  const secret = env[GROUP_HQ_SSO_ENV.secret]?.trim() ?? '';
  const usersRaw = env[GROUP_HQ_SSO_ENV.users]?.trim() ?? '';
  if (!secret && !usersRaw) return undefined;
  if (secret.length < 32 || secret.length > 256) throw new Error(`${GROUP_HQ_SSO_ENV.secret} must be 32–256 characters`);
  let parsed: unknown;
  try { parsed = JSON.parse(usersRaw); } catch { throw new Error(`${GROUP_HQ_SSO_ENV.users} must be a JSON object of email → user id`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${GROUP_HQ_SSO_ENV.users} must be a JSON object of email → user id`);
  const users = new Map<string, string>();
  for (const [email, userId] of Object.entries(parsed as Record<string, unknown>)) {
    const e = email.trim().toLowerCase();
    if (!EMAIL.test(e) || typeof userId !== 'string' || !UUID.test(userId.toLowerCase())) throw new Error(`${GROUP_HQ_SSO_ENV.users} has an invalid entry`);
    users.set(e, userId.toLowerCase());
  }
  if (users.size === 0 || users.size > 20) throw new Error(`${GROUP_HQ_SSO_ENV.users} must list 1–20 people`);
  const pp = env[GROUP_HQ_SSO_ENV.ppWorkspace]?.trim().toLowerCase() ?? '';
  return Object.freeze({ secret, users, ppWorkspaceId: UUID.test(pp) ? pp : null });
}

function b64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

function canonical(claims: GroupHqHandoffClaims): string {
  // Fixed key order so both sides sign identical bytes.
  return JSON.stringify({ v: claims.v, email: claims.email, brand: claims.brand, host: claims.host, path: claims.path, iat: claims.iat, exp: claims.exp, nonce: claims.nonce });
}

function mac(secret: string, body: string): Buffer {
  return createHmac('sha256', secret).update('group-hq-handoff\u0000').update(body).digest();
}

/** Used by tests and by the reference Group HQ implementation. */
export function signGroupHqHandoff(secret: string, claims: GroupHqHandoffClaims): string {
  const body = b64url(canonical(claims));
  return `${body}.${b64url(mac(secret, body))}`;
}

export function verifyGroupHqHandoff(secret: string, token: string | null | undefined, expected: { host: string; nowMs: number }): GroupHqHandoffClaims | null {
  if (!token || token.length > 2000) return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]!) || !/^[A-Za-z0-9_-]{43}$/.test(parts[1]!)) return null;
  const supplied = Buffer.from(parts[1]!, 'base64url');
  const wanted = mac(secret, parts[0]!);
  if (supplied.length !== wanted.length || !timingSafeEqual(supplied, wanted)) return null;
  let raw: unknown;
  try { raw = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')); } catch { return null; }
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  const email = typeof c.email === 'string' ? c.email.trim().toLowerCase() : '';
  if (c.v !== GROUP_HQ_HANDOFF_VERSION || !EMAIL.test(email) || email.length > 320) return null;
  if (c.brand !== 'pp' && c.brand !== 'mhp') return null;
  if (typeof c.host !== 'string' || !HOST.test(c.host) || c.host !== expected.host.toLowerCase()) return null;
  if (typeof c.path !== 'string' || c.path.length > 400 || !PATH.test(c.path) || c.path.includes('//')) return null;
  if (typeof c.iat !== 'number' || typeof c.exp !== 'number' || !Number.isInteger(c.iat) || !Number.isInteger(c.exp)) return null;
  if (typeof c.nonce !== 'string' || !NONCE.test(c.nonce)) return null;
  const now = Math.floor(expected.nowMs / 1000);
  if (c.exp <= now || c.iat > now + 60 || c.exp <= c.iat || (c.exp - c.iat) * 1000 > MAX_TOKEN_LIFETIME_MS) return null;
  return Object.freeze({ v: GROUP_HQ_HANDOFF_VERSION, email, brand: c.brand, host: c.host, path: c.path, iat: c.iat, exp: c.exp, nonce: c.nonce });
}

/** Per-process handoff verifier with single-use nonces. */
export class GroupHqHandoff {
  private readonly seen = new Map<string, number>();

  constructor(private readonly config: GroupHqSsoConfig, private readonly now: () => number = Date.now) {}

  /** Stable only for this signed grant. The database's unique session-token hash
   * makes a replay fail across processes and restarts, beyond the local cache. */
  sessionTokenFor(claims: GroupHqHandoffClaims): string {
    return createHmac('sha256', this.config.secret).update('group-hq-session/v1\u0000').update(canonical(claims)).digest('base64url');
  }

  /** Verifies and consumes a token; a second presentation of the same nonce is refused. */
  consume(token: string | null | undefined, host: string): GroupHqHandoffClaims | null {
    const claims = verifyGroupHqHandoff(this.config.secret, token, { host, nowMs: this.now() });
    if (!claims) return null;
    const nowMs = this.now();
    for (const [n, exp] of this.seen) if (exp < nowMs) this.seen.delete(n);
    if (this.seen.size >= MAX_NONCES) return null;
    if (this.seen.has(claims.nonce)) return null;
    this.seen.set(claims.nonce, claims.exp * 1000 + 60_000);
    return claims;
  }

  userFor(email: string): string | null {
    return this.config.users.get(email.toLowerCase()) ?? null;
  }

  workspaceFor(brand: GroupHqBrand): string | null {
    return brand === 'mhp' ? MHP_MARKETING_WORKSPACE_ID : this.config.ppWorkspaceId;
  }
}
