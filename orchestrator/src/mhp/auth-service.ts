import { createHash, randomBytes } from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';
import { hashPassword, verifyStoredPassword, type PortalScryptWorkLimiter } from '../portal/accounts.js';
import type { PortalAuthService, PortalAuthRequestContext, PortalAuthenticatedSession, PortalSessionIdentity } from '../portal/auth-service.js';

export const MHP_AUTH_ORIGIN = 'https://app.martinhowardproperty.co.uk';
export const MHP_AUTH_HOST = 'app.martinhowardproperty.co.uk';
export const MHP_SESSION_COOKIE = '__Host-mhp_session';
export type MhpAuthPurpose = 'magic' | 'reset';
export const MHP_OPAQUE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeMhpEmail(value: string): string | null {
  const email = value.trim().toLowerCase();
  return email.length >= 3 && email.length <= 320 && EMAIL.test(email) ? email : null;
}

const digest = (value: string | Buffer): Buffer => createHash('sha256').update(value).digest();
function source(context: PortalAuthRequestContext): Buffer {
  if (!Buffer.isBuffer(context.sourceHash) || context.sourceHash.length !== 32) throw new Error('MHP source evidence unavailable');
  return Buffer.from(context.sourceHash);
}
function userAgent(context: PortalAuthRequestContext): Buffer | null {
  return context.userAgent ? digest(context.userAgent.slice(0, 4096)) : null;
}
function denied(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '42501';
}

interface IdentityRow extends QueryResultRow {
  session_id: string; user_id: string; user_email: string; selected_workspace_id: string; expires_at?: string | Date;
}
function identity(row: IdentityRow, token: string): PortalSessionIdentity {
  if (!UUID.test(row.session_id) || !UUID.test(row.user_id) || !UUID.test(row.selected_workspace_id)
      || normalizeMhpEmail(row.user_email) !== row.user_email) throw new Error('Invalid MHP session identity');
  return Object.freeze({ sessionToken: token, userId: row.user_id, userEmail: row.user_email, workspaceId: row.selected_workspace_id });
}
function authenticated(rows: IdentityRow[], token: string, now: number): PortalAuthenticatedSession | null {
  if (!rows.length) return null;
  if (rows.length !== 1) throw new Error('Ambiguous MHP session');
  const row = rows[0]!;
  const expiry = row.expires_at instanceof Date ? row.expires_at.getTime() : Date.parse(row.expires_at ?? '');
  if (!Number.isFinite(expiry) || expiry <= now || expiry > now + 24 * 60 * 60_000 + 60_000) throw new Error('Invalid MHP session expiry');
  return Object.freeze({ ...identity(row, token), expiresAt: new Date(expiry).toISOString() });
}

export interface MhpAuthService extends PortalAuthService {
  /** Internal delivery result only. HTTP responses never disclose whether an account exists. */
  requestLink(email: string, purpose: MhpAuthPurpose, context: PortalAuthRequestContext): Promise<{ email: string; url: string } | null>;
  consumeLink(token: string, purpose: MhpAuthPurpose, password: string | undefined, context: PortalAuthRequestContext): Promise<PortalAuthenticatedSession | null>;
}

export class PgMhpAuthService implements MhpAuthService {
  constructor(private readonly deps: {
    readPool: Pick<Pool, 'query'>;
    commandPool: Pick<Pool, 'query'>;
    scryptLimiter?: PortalScryptWorkLimiter;
  }) {}

  async resolve(sessionToken: string, _now: number): Promise<PortalSessionIdentity | null> {
    if (!MHP_OPAQUE_TOKEN.test(sessionToken)) return null;
    const result = await this.deps.readPool.query<IdentityRow>(
      'SELECT session_id,user_id,user_email,selected_workspace_id FROM app_private.resolve_mhp_session($1)', [digest(sessionToken)],
    );
    if (!result.rows.length) return null;
    if (result.rows.length !== 1) throw new Error('Ambiguous MHP session');
    return identity(result.rows[0]!, sessionToken);
  }

  async login(email: string, password: string, context: PortalAuthRequestContext): Promise<PortalAuthenticatedSession | null> {
    const normalized = normalizeMhpEmail(email);
    let row: { user_id: string; user_email: string; password_hash: string } | undefined;
    if (normalized && password.length > 0 && password.length <= 1024) {
      const result = await this.deps.commandPool.query<{ user_id: string; user_email: string; password_hash: string }>(
        'SELECT user_id,user_email,password_hash FROM app_private.mhp_login_credential($1)', [normalized],
      );
      if (result.rows.length > 1) throw new Error('Ambiguous MHP credential');
      row = result.rows[0];
    }
    const passwordHash = row?.password_hash?.startsWith('scrypt$v1$') ? row.password_hash : undefined;
    const checked = await verifyStoredPassword(passwordHash, password, this.deps.scryptLimiter);
    if (!row || !checked.matches || !passwordHash) return null;
    if (!UUID.test(row.user_id) || row.user_email !== normalized) throw new Error('Invalid MHP credential identity');
    const token = randomBytes(32).toString('base64url');
    try {
      const result = await this.deps.commandPool.query<IdentityRow>(
        'SELECT session_id,user_id,user_email,selected_workspace_id,expires_at FROM app_private.create_mhp_password_session($1,$2,$3,$4,$5,$6)',
        [row.user_id, passwordHash, digest(token), digest(randomBytes(32)), source(context), userAgent(context)],
      );
      const session = authenticated(result.rows, token, context.now);
      if (session && (session.userId !== row.user_id || session.userEmail !== row.user_email)) throw new Error('MHP password identity changed');
      return session;
    } catch (error) { if (denied(error)) return null; throw error; }
  }

  async requestLink(email: string, purpose: MhpAuthPurpose, context: PortalAuthRequestContext): Promise<{ email: string; url: string } | null> {
    const normalized = normalizeMhpEmail(email);
    if (!normalized || (purpose !== 'magic' && purpose !== 'reset')) return null;
    const token = randomBytes(32).toString('base64url');
    const result = await this.deps.commandPool.query<{ issued: boolean }>(
      'SELECT app_private.request_mhp_auth_token($1,$2,$3,$4) AS issued', [normalized, purpose, digest(token), source(context)],
    );
    if (result.rows.length !== 1 || typeof result.rows[0]?.issued !== 'boolean') throw new Error('Invalid MHP action issue result');
    if (!result.rows[0].issued) return null;
    const url = new URL('/portal/auth/verify', MHP_AUTH_ORIGIN);
    url.searchParams.set('token', token);
    url.searchParams.set('purpose', purpose);
    return { email: normalized, url: url.toString() };
  }

  async consumeLink(token: string, purpose: MhpAuthPurpose, password: string | undefined, context: PortalAuthRequestContext): Promise<PortalAuthenticatedSession | null> {
    if (!MHP_OPAQUE_TOKEN.test(token) || (purpose !== 'magic' && purpose !== 'reset')) return null;
    if (purpose === 'reset' && (!password || password.length < 12 || password.length > 1024)) return null;
    if (purpose === 'magic' && password !== undefined) return null;
    const sourceHash = source(context);
    const passwordHash = purpose === 'reset' ? await hashPassword(password!, this.deps.scryptLimiter) : null;
    const sessionToken = randomBytes(32).toString('base64url');
    try {
      const result = await this.deps.commandPool.query<IdentityRow>(
        'SELECT session_id,user_id,user_email,selected_workspace_id,expires_at FROM app_private.consume_mhp_auth_token($1,$2,$3,$4,$5,$6,$7)',
        [digest(token), purpose, passwordHash, digest(sessionToken), digest(randomBytes(32)), sourceHash, userAgent(context)],
      );
      return authenticated(result.rows, sessionToken, context.now);
    } catch (error) { if (denied(error)) return null; throw error; }
  }

  async revoke(sessionToken: string): Promise<void> {
    if (!MHP_OPAQUE_TOKEN.test(sessionToken)) return;
    await this.deps.commandPool.query('SELECT app_private.revoke_mhp_session($1)', [digest(sessionToken)]);
  }
}
