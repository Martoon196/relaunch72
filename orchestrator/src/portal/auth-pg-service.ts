import { createHash, randomBytes } from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';
import { hashPassword, verifyStoredPassword } from './accounts.js';
import type {
  PortalAuthenticatedSession,
  PortalAuthRequestContext,
  PortalAuthService,
  PortalSessionIdentity,
} from './auth-service.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPAQUE_SESSION_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface CredentialRow extends QueryResultRow {
  user_id: string;
  user_email: string;
  password_hash: string;
  selected_workspace_id: string;
  legacy_tenant_key: string;
}

interface SessionRow extends QueryResultRow {
  session_id: string;
  user_id: string;
  user_email: string;
  selected_workspace_id: string;
  legacy_tenant_key: string;
  expires_at?: string | Date;
}

function sha256(value: string | Buffer): Buffer {
  return createHash('sha256').update(value).digest();
}

function metadataHash(value: string | undefined): Buffer | null {
  if (!value) return null;
  return sha256(value.slice(0, 4_096));
}

function canonicalUuid(value: unknown): string | null {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value.toLowerCase() : null;
}

function legacyTenantKey(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && value === value.trim()
    ? value
    : null;
}

function canonicalEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email.length >= 3 && email.length <= 320 && EMAIL_PATTERN.test(email) ? email : null;
}

function rawOpaqueSession(): string {
  return randomBytes(32).toString('base64url');
}

function isAuthorizationRace(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === '42501';
}

export interface PgPortalAuthDependencies {
  readPool: Pick<Pool, 'query'>;
  commandPool: Pick<Pool, 'query'>;
}

/** PostgreSQL-backed password login plus revocable opaque browser sessions. */
export class PgPortalAuthService implements PortalAuthService {
  constructor(private readonly dependencies: PgPortalAuthDependencies) {}

  async resolve(sessionToken: string, _now: number): Promise<PortalSessionIdentity | null> {
    if (!OPAQUE_SESSION_PATTERN.test(sessionToken)) return null;
    const result = await this.dependencies.readPool.query<SessionRow>(
      `/* portal.auth.resolve-session */
       SELECT session_id, user_id, user_email, selected_workspace_id, legacy_tenant_key
       FROM app_private.resolve_portal_session($1)`,
      [sha256(sessionToken)],
    );
    if (result.rows.length === 0) return null;
    if (result.rows.length !== 1) throw new Error('Portal session resolved more than once');
    const userId = canonicalUuid(result.rows[0]?.user_id);
    const userEmail = canonicalEmail(result.rows[0]?.user_email);
    const workspaceId = canonicalUuid(result.rows[0]?.selected_workspace_id);
    const tenantId = legacyTenantKey(result.rows[0]?.legacy_tenant_key);
    if (!userId || !userEmail || !workspaceId || !tenantId) throw new Error('Portal session returned invalid identity data');
    return Object.freeze({ sessionToken, userId, userEmail, workspaceId, legacyTenantId: tenantId });
  }

  async login(
    email: string,
    password: string,
    context: PortalAuthRequestContext,
  ): Promise<PortalAuthenticatedSession | null> {
    const normalizedEmail = email.trim().toLowerCase();
    const validInput = normalizedEmail.length >= 3
      && normalizedEmail.length <= 320
      && EMAIL_PATTERN.test(normalizedEmail)
      && password.length > 0
      && password.length <= 1_024;

    let credential: CredentialRow | undefined;
    if (validInput) {
      const result = await this.dependencies.commandPool.query<CredentialRow>(
        `/* portal.auth.login-credential */
         SELECT user_id, user_email, password_hash, selected_workspace_id, legacy_tenant_key
         FROM app_private.portal_login_credential($1)`,
        [normalizedEmail],
      );
      if (result.rows.length > 1) throw new Error('Portal login credential resolved more than once');
      credential = result.rows[0];
    }

    const verified = await verifyStoredPassword(credential?.password_hash, password);
    if (!credential || !verified.matches) return null;
    const userId = canonicalUuid(credential.user_id);
    const userEmail = canonicalEmail(credential.user_email);
    const workspaceId = canonicalUuid(credential.selected_workspace_id);
    const tenantId = legacyTenantKey(credential.legacy_tenant_key);
    if (!userId || userEmail !== normalizedEmail || !workspaceId || !tenantId || typeof credential.password_hash !== 'string') {
      throw new Error('Portal login credential returned invalid identity data');
    }

    let expectedPasswordHash = credential.password_hash;
    if (verified.needsUpgrade) {
      const replacement = await hashPassword(password);
      const upgraded = await this.dependencies.commandPool.query<{ upgraded: boolean }>(
        `/* portal.auth.upgrade-password */
         SELECT app_private.upgrade_portal_password_hash($1, $2, $3) AS upgraded`,
        [userId, expectedPasswordHash, replacement],
      );
      if (upgraded.rows[0]?.upgraded !== true) return null;
      expectedPasswordHash = replacement;
    }

    const sessionToken = rawOpaqueSession();
    const csrfSecret = randomBytes(32);
    let created;
    try {
      created = await this.dependencies.commandPool.query<SessionRow>(
        `/* portal.auth.create-session */
         SELECT session_id, user_id, user_email, selected_workspace_id, legacy_tenant_key, expires_at
         FROM app_private.create_portal_session($1, $2, $3, $4, $5, $6, $7)`,
        [
          userId,
          workspaceId,
          expectedPasswordHash,
          sha256(sessionToken),
          sha256(csrfSecret),
          metadataHash(context.ipAddress),
          metadataHash(context.userAgent),
        ],
      );
    } catch (error) {
      // A password reset, membership revoke or workspace suspension between the
      // credential read and session insert behaves like an invalid login.
      if (isAuthorizationRace(error)) return null;
      throw error;
    }
    if (created.rows.length !== 1) throw new Error('Portal login did not create exactly one session');
    const row = created.rows[0]!;
    const returnedUserId = canonicalUuid(row.user_id);
    const returnedUserEmail = canonicalEmail(row.user_email);
    const returnedWorkspaceId = canonicalUuid(row.selected_workspace_id);
    const returnedTenantId = legacyTenantKey(row.legacy_tenant_key);
    const expiresAt = row.expires_at instanceof Date ? row.expires_at.toISOString() : row.expires_at;
    const expiry = typeof expiresAt === 'string' ? Date.parse(expiresAt) : Number.NaN;
    if (returnedUserId !== userId || returnedUserEmail !== userEmail
        || returnedWorkspaceId !== workspaceId || returnedTenantId !== tenantId
        || !Number.isFinite(expiry) || expiry <= context.now) {
      throw new Error('Portal login created an invalid session');
    }
    return Object.freeze({
      sessionToken,
      userId,
      userEmail,
      workspaceId,
      legacyTenantId: tenantId,
      expiresAt: new Date(expiry).toISOString(),
    });
  }

  async revoke(sessionToken: string): Promise<void> {
    if (!OPAQUE_SESSION_PATTERN.test(sessionToken)) return;
    await this.dependencies.commandPool.query(
      `/* portal.auth.revoke-session */
       SELECT app_private.revoke_portal_session($1) AS revoked`,
      [sha256(sessionToken)],
    );
  }
}
