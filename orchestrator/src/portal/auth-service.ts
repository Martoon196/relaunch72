export interface PortalAuthRequestContext {
  now: number;
  /** Deployment-keyed, domain-separated source evidence; never a raw address/digest. */
  sourceHash?: Buffer;
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
 * A short-lived, verified assertion returned by the Property Predator SSO
 * backchannel. It is deliberately smaller than the main site's user/session
 * model: Growth HQ stores the immutable issuer + subject link and only the
 * bounded affiliate/source fields below. Provider tokens never cross this
 * boundary.
 */
export interface PortalExternalIdentityAssertion {
  issuer: string;
  subject: string;
  email: string;
  emailVerified: true;
  issuedAt: string;
  expiresAt: string;
  affiliate: {
    member: boolean;
    affiliateId: string | null;
    code: string | null;
    codeStatus: string | null;
  };
  attribution: {
    referrerAffiliateId: string | null;
    attachedAt: string | null;
  };
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
  /**
   * Link/resolve a verified external subject and mint the same opaque local HQ
   * session as password login. `bootstrapUserId` is server-owned first-link
   * authority; assertions can never select or create a workspace themselves.
   */
  loginExternal?(
    assertion: PortalExternalIdentityAssertion,
    context: PortalAuthRequestContext,
    bootstrapUserId?: string,
  ): Promise<PortalAuthenticatedSession | null>;
  revoke(sessionToken: string): Promise<void>;
}
