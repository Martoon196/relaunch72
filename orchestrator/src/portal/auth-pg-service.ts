import { createHash, randomBytes } from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';
import {
  hashPassword,
  verifyStoredPassword,
  type PortalScryptWorkLimiter,
} from './accounts.js';
import type {
  PortalAuthenticatedSession,
  PortalAuthRequestContext,
  PortalAuthService,
  PortalExternalIdentityAssertion,
  PortalSessionIdentity,
} from './auth-service.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPAQUE_SESSION_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PROPERTY_PREDATOR_SSO_ISSUER = 'https://propertypredator.com';
const AFFILIATE_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const AFFILIATE_STATUS_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

interface CredentialRow extends QueryResultRow {
  user_id: string;
  user_email: string;
  password_hash: string;
  selected_workspace_id: string;
}

interface SessionRow extends QueryResultRow {
  session_id: string;
  user_id: string;
  user_email: string;
  selected_workspace_id: string;
  expires_at?: string | Date;
}

interface SetupClaimRow extends QueryResultRow {
  claim_expires_at: string | Date;
}

function sha256(value: string | Buffer): Buffer {
  return createHash('sha256').update(value).digest();
}

function metadataHash(value: string | undefined): Buffer | null {
  if (!value) return null;
  return sha256(value.slice(0, 4_096));
}

function setupSourceHash(value: string | undefined): Buffer {
  const normalized = value?.trim().slice(0, 256) || 'unavailable';
  return createHash('sha256')
    .update('relaunch72/setup-source/v1\u0000')
    .update(normalized)
    .digest();
}

function canonicalUuid(value: unknown): string | null {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value.toLowerCase() : null;
}

function canonicalEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email.length >= 3 && email.length <= 320 && EMAIL_PATTERN.test(email) ? email : null;
}

function rawOpaqueSession(): string {
  return randomBytes(32).toString('base64url');
}

function validExternalIdentityAssertion(
  assertion: PortalExternalIdentityAssertion,
  context: PortalAuthRequestContext,
  bootstrapUserId: string | undefined,
): boolean {
  const issuedAt = Date.parse(assertion.issuedAt);
  const expiresAt = Date.parse(assertion.expiresAt);
  const affiliate = assertion.affiliate;
  const attribution = assertion.attribution;
  return assertion.emailVerified === true
    && assertion.issuer === PROPERTY_PREDATOR_SSO_ISSUER
    && canonicalUuid(assertion.subject) === assertion.subject
    && canonicalEmail(assertion.email) === assertion.email
    && Number.isFinite(issuedAt)
    && Number.isFinite(expiresAt)
    && issuedAt <= context.now + 60_000
    && expiresAt > context.now
    && expiresAt > issuedAt
    && expiresAt - issuedAt <= 10 * 60 * 1_000
    && (bootstrapUserId === undefined || canonicalUuid(bootstrapUserId) === bootstrapUserId)
    && typeof affiliate?.member === 'boolean'
    && (affiliate.affiliateId === null || canonicalUuid(affiliate.affiliateId) === affiliate.affiliateId)
    && (affiliate.code === null || AFFILIATE_CODE_PATTERN.test(affiliate.code))
    && (affiliate.codeStatus === null || AFFILIATE_STATUS_PATTERN.test(affiliate.codeStatus))
    && (affiliate.member
      ? affiliate.affiliateId !== null && affiliate.code !== null && affiliate.codeStatus !== null
      : affiliate.affiliateId === null && affiliate.code === null && affiliate.codeStatus === null)
    && (attribution.referrerAffiliateId === null
      || canonicalUuid(attribution.referrerAffiliateId) === attribution.referrerAffiliateId)
    && (attribution.attachedAt === null
      || (Number.isFinite(Date.parse(attribution.attachedAt))
        && Date.parse(attribution.attachedAt) <= context.now + 60_000));
}

function isAuthorizationRace(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === '42501';
}

export interface PgPortalAuthDependencies {
  readPool: Pick<Pool, 'query'>;
  commandPool: Pick<Pool, 'query'>;
  /** Test seam; production omits this and uses the process-wide limiter. */
  scryptLimiter?: PortalScryptWorkLimiter;
}

/** PostgreSQL-backed password login plus revocable opaque browser sessions. */
export class PgPortalAuthService implements PortalAuthService {
  constructor(private readonly dependencies: PgPortalAuthDependencies) {}

  async resolve(sessionToken: string, _now: number): Promise<PortalSessionIdentity | null> {
    if (!OPAQUE_SESSION_PATTERN.test(sessionToken)) return null;
    const result = await this.dependencies.readPool.query<SessionRow>(
      `/* portal.auth.resolve-session */
       SELECT session_id, user_id, user_email, selected_workspace_id
       FROM app_private.resolve_portal_session($1)`,
      [sha256(sessionToken)],
    );
    if (result.rows.length === 0) return null;
    if (result.rows.length !== 1) throw new Error('Portal session resolved more than once');
    const sessionId = canonicalUuid(result.rows[0]?.session_id);
    const userId = canonicalUuid(result.rows[0]?.user_id);
    const userEmail = canonicalEmail(result.rows[0]?.user_email);
    const workspaceId = canonicalUuid(result.rows[0]?.selected_workspace_id);
    if (!sessionId || !userId || !userEmail || !workspaceId) throw new Error('Portal session returned invalid identity data');
    return Object.freeze({ sessionToken, userId, userEmail, workspaceId });
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
         SELECT user_id, user_email, password_hash, selected_workspace_id
         FROM app_private.portal_login_credential($1)`,
        [normalizedEmail],
      );
      if (result.rows.length > 1) throw new Error('Portal login credential resolved more than once');
      credential = result.rows[0];
    }

    // PostgreSQL is a clean canonical store: imported unsalted hashes are not
    // accepted here. Passing an absent hash keeps the bounded dummy-scrypt path
    // for unknown accounts and every non-current credential format.
    const currentPasswordHash = typeof credential?.password_hash === 'string'
      && credential.password_hash.startsWith('scrypt$v1$')
      ? credential.password_hash
      : undefined;
    const verified = await verifyStoredPassword(
      currentPasswordHash,
      password,
      this.dependencies.scryptLimiter,
    );
    if (!credential || !verified.matches) return null;
    const userId = canonicalUuid(credential.user_id);
    const userEmail = canonicalEmail(credential.user_email);
    const workspaceId = canonicalUuid(credential.selected_workspace_id);
    if (!userId || userEmail !== normalizedEmail || !workspaceId || currentPasswordHash !== credential.password_hash) {
      throw new Error('Portal login credential returned invalid identity data');
    }

    const sessionToken = rawOpaqueSession();
    const csrfSecret = randomBytes(32);
    let created;
    try {
      created = await this.dependencies.commandPool.query<SessionRow>(
        `/* portal.auth.create-session */
         SELECT session_id, user_id, user_email, selected_workspace_id, expires_at
         FROM app_private.create_portal_session($1, $2, $3, $4, $5, $6, $7)`,
        [
          userId,
          workspaceId,
          currentPasswordHash,
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
    const returnedSessionId = canonicalUuid(row.session_id);
    const returnedUserId = canonicalUuid(row.user_id);
    const returnedUserEmail = canonicalEmail(row.user_email);
    const returnedWorkspaceId = canonicalUuid(row.selected_workspace_id);
    const expiresAt = row.expires_at instanceof Date ? row.expires_at.toISOString() : row.expires_at;
    const expiry = typeof expiresAt === 'string' ? Date.parse(expiresAt) : Number.NaN;
    if (!returnedSessionId || returnedUserId !== userId || returnedUserEmail !== userEmail
        || returnedWorkspaceId !== workspaceId || !Number.isFinite(expiry) || expiry <= context.now) {
      throw new Error('Portal login created an invalid session');
    }
    return Object.freeze({
      sessionToken,
      userId,
      userEmail,
      workspaceId,
      expiresAt: new Date(expiry).toISOString(),
    });
  }

  async completeSetup(
    setupToken: string,
    password: string,
    context: PortalAuthRequestContext,
  ): Promise<PortalAuthenticatedSession | null> {
    if (!OPAQUE_SESSION_PATTERN.test(setupToken) || password.length < 12 || password.length > 1_024) {
      return null;
    }

    const setupTokenHash = sha256(setupToken);
    const claimHash = sha256(randomBytes(32));
    const sourceHash = setupSourceHash(context.ipAddress);
    let reserved;
    try {
      reserved = await this.dependencies.commandPool.query<SetupClaimRow>(
        `/* portal.auth.reserve-setup */
         SELECT claim_expires_at
         FROM app_private.reserve_native_account_setup($1, $2, $3)`,
        [
          setupTokenHash,
          claimHash,
          sourceHash,
        ],
      );
    } catch (error) {
      if (isAuthorizationRace(error)) return null;
      throw error;
    }
    if (reserved.rows.length === 0) return null;
    if (reserved.rows.length !== 1) {
      await this.releaseSetupClaim(setupTokenHash, claimHash, sourceHash);
      throw new Error('Portal setup token reserved more than once');
    }
    const claimExpiryValue = reserved.rows[0]?.claim_expires_at;
    const claimExpiryText = claimExpiryValue instanceof Date ? claimExpiryValue.toISOString() : claimExpiryValue;
    const claimExpiry = typeof claimExpiryText === 'string' ? Date.parse(claimExpiryText) : Number.NaN;
    if (!Number.isFinite(claimExpiry) || claimExpiry <= context.now) {
      await this.releaseSetupClaim(setupTokenHash, claimHash, sourceHash);
      throw new Error('Portal setup reservation returned invalid expiry data');
    }

    let claimConsumed = false;
    let operationError: unknown;
    try {
      const passwordHash = await hashPassword(
        password,
        this.dependencies.scryptLimiter,
      );
      const sessionToken = rawOpaqueSession();
      const csrfSecret = randomBytes(32);
      let completed;
      try {
        completed = await this.dependencies.commandPool.query<SessionRow>(
          `/* portal.auth.complete-setup */
           SELECT session_id, user_id, user_email, selected_workspace_id, expires_at
           FROM app_private.complete_native_account_setup($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            setupTokenHash,
            claimHash,
            sourceHash,
            passwordHash,
            sha256(sessionToken),
            sha256(csrfSecret),
            metadataHash(context.ipAddress),
            metadataHash(context.userAgent),
          ],
        );
      } catch (error) {
        // A concurrent token claim or membership/workspace suspension is an
        // invalid setup attempt, not an application error to expose.
        if (isAuthorizationRace(error)) return null;
        throw error;
      }
      if (completed.rows.length === 0) return null;
      if (completed.rows.length !== 1) throw new Error('Portal setup completed more than once');
      // A one-row return means the SQL command consumed both token and claim.
      // Never issue a separate release after that atomic success.
      claimConsumed = true;

      const row = completed.rows[0]!;
      const sessionId = canonicalUuid(row.session_id);
      const userId = canonicalUuid(row.user_id);
      const userEmail = canonicalEmail(row.user_email);
      const workspaceId = canonicalUuid(row.selected_workspace_id);
      const expiresAt = row.expires_at instanceof Date ? row.expires_at.toISOString() : row.expires_at;
      const expiry = typeof expiresAt === 'string' ? Date.parse(expiresAt) : Number.NaN;
      if (!sessionId || !userId || !userEmail || !workspaceId
          || !Number.isFinite(expiry) || expiry <= context.now) {
        throw new Error('Portal setup returned invalid session data');
      }

      return Object.freeze({
        sessionToken,
        userId,
        userEmail,
        workspaceId,
        expiresAt: new Date(expiry).toISOString(),
      });
    } catch (error) {
      operationError = error;
      throw error;
    } finally {
      if (!claimConsumed) {
        try {
          await this.releaseSetupClaim(setupTokenHash, claimHash, sourceHash);
        } catch (releaseError) {
          // A release failure is itself an availability failure unless another
          // error is already propagating. Never mask the original cause.
          if (operationError === undefined) throw releaseError;
        }
      }
    }
  }

  async loginExternal(
    assertion: PortalExternalIdentityAssertion,
    context: PortalAuthRequestContext,
    bootstrapUserId?: string,
  ): Promise<PortalAuthenticatedSession | null> {
    if (!validExternalIdentityAssertion(assertion, context, bootstrapUserId)) return null;

    const sessionToken = rawOpaqueSession();
    const csrfSecret = randomBytes(32);
    let created;
    try {
      created = await this.dependencies.commandPool.query<SessionRow>(
        `/* portal.auth.create-external-identity-session */
         SELECT session_id, user_id, user_email, selected_workspace_id, expires_at
         FROM app_private.create_portal_external_identity_session(
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
           $11, $12, $13, $14, $15
         )`,
        [
          assertion.issuer,
          assertion.subject,
          assertion.email,
          assertion.emailVerified,
          bootstrapUserId ?? null,
          assertion.affiliate.member,
          assertion.affiliate.affiliateId,
          assertion.affiliate.code,
          assertion.affiliate.codeStatus,
          assertion.attribution.referrerAffiliateId,
          assertion.attribution.attachedAt,
          sha256(sessionToken),
          sha256(csrfSecret),
          metadataHash(context.ipAddress),
          metadataHash(context.userAgent),
        ],
      );
    } catch (error) {
      // A concurrent re-link, membership revoke or workspace suspension is an
      // invalid sign-in. No external identity detail is exposed to the caller.
      if (isAuthorizationRace(error)) return null;
      throw error;
    }
    if (created.rows.length === 0) return null;
    if (created.rows.length !== 1) throw new Error('External portal login did not create exactly one session');
    const row = created.rows[0]!;
    const returnedSessionId = canonicalUuid(row.session_id);
    const userId = canonicalUuid(row.user_id);
    const userEmail = canonicalEmail(row.user_email);
    const workspaceId = canonicalUuid(row.selected_workspace_id);
    const expiresAt = row.expires_at instanceof Date ? row.expires_at.toISOString() : row.expires_at;
    const expiry = typeof expiresAt === 'string' ? Date.parse(expiresAt) : Number.NaN;
    // The canonical HQ email deliberately does not need to match the asserted
    // main-site email. Immutable issuer + subject is the linked authority.
    if (!returnedSessionId || !userId || !userEmail || !workspaceId
        || !Number.isFinite(expiry) || expiry <= context.now
        || expiry > context.now + 24 * 60 * 60 * 1_000 + 60_000) {
      throw new Error('External portal login created an invalid session');
    }
    return Object.freeze({
      sessionToken,
      userId,
      userEmail,
      workspaceId,
      expiresAt: new Date(expiry).toISOString(),
    });
  }

  private async releaseSetupClaim(
    setupTokenHash: Buffer,
    claimHash: Buffer,
    sourceHash: Buffer,
  ): Promise<void> {
    await this.dependencies.commandPool.query(
      `/* portal.auth.release-setup */
       SELECT app_private.release_native_account_setup_claim($1, $2, $3) AS released`,
      [setupTokenHash, claimHash, sourceHash],
    );
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
