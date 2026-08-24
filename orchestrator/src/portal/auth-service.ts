export interface PortalAuthRequestContext {
  now: number;
  /** Direct peer address only; proxy-derived client IP needs an explicit trust policy. */
  ipAddress?: string;
  userAgent?: string;
}

export interface PortalSessionIdentity {
  sessionToken: string;
  /** Canonical PostgreSQL identity; browser-supplied workspace ids are never authority. */
  userId: string;
  workspaceId: string;
  userEmail: string;
}

export interface PortalAuthenticatedSession extends PortalSessionIdentity {
  expiresAt?: string;
}

/**
 * Router-facing authentication boundary. A PostgreSQL implementation owns
 * password verification and opaque-session creation/revocation; the router
 * never turns a tenant id into authority itself.
 */
export interface PortalAuthService {
  resolve(sessionToken: string, now: number): Promise<PortalSessionIdentity | null>;
  login(
    email: string,
    password: string,
    context: PortalAuthRequestContext,
  ): Promise<PortalAuthenticatedSession | null>;
  completeSetup?(
    setupToken: string,
    password: string,
    context: PortalAuthRequestContext,
  ): Promise<PortalAuthenticatedSession | null>;
  revoke(sessionToken: string): Promise<void>;
}
