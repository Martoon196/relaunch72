/**
 * The operator acts as one configured portal user. Sessions are the same
 * delegated sessions Group HQ's sign-in handoff mints (migration 0147): the
 * database refuses unless that user is an active owner or admin of the brand
 * workspace. One session per brand is cached and re-minted when it stops resolving.
 */
import { createHash } from 'node:crypto';
import type { PortalAuthService, PortalSessionIdentity } from '../portal/auth-service.js';
import type { OperatorBrand, OperatorConfig } from './config.js';

export type OperatorAuth = Pick<PortalAuthService, 'resolve' | 'loginDelegated'>;

export class OperatorSessions {
  private readonly cache = new Map<OperatorBrand, { identity: PortalSessionIdentity; checkedAt: number; expiresAt: number }>();

  constructor(
    private readonly config: OperatorConfig,
    private readonly auth: Readonly<Record<OperatorBrand, OperatorAuth | undefined>>,
    private readonly now: () => number = Date.now,
  ) {}

  /** A resolving identity for the brand, or an Error with a plain message. */
  async identity(brand: OperatorBrand): Promise<PortalSessionIdentity> {
    const workspaceId = this.config.workspaces[brand];
    const auth = this.auth[brand];
    if (!workspaceId || !auth?.loginDelegated) throw new Error(brand === 'pp' ? 'The Property Predator workspace is not configured for the operator.' : 'The MHP host is not composed on this deployment.');
    const now = this.now();
    const cached = this.cache.get(brand);
    if (cached && cached.expiresAt > now + 60_000) {
      if (now - cached.checkedAt < 5 * 60_000) return cached.identity;
      const still = await auth.resolve(cached.identity.sessionToken, now).catch(() => null);
      if (still && still.userId === cached.identity.userId && still.workspaceId === workspaceId) {
        cached.checkedAt = now;
        return cached.identity;
      }
      this.cache.delete(brand);
    }
    const sourceHash = createHash('sha256').update('relaunch72/operator-source/v1\u0000').update(this.config.userId).digest();
    const session = await auth.loginDelegated({ userId: this.config.userId, workspaceId }, { now, sourceHash, userAgent: 'relaunch72-operator' });
    if (!session) throw new Error('The operator user is not an owner of this workspace, so the request was refused.');
    const expiresAt = session.expiresAt ? Date.parse(session.expiresAt) : now + 60 * 60_000;
    const identity: PortalSessionIdentity = Object.freeze({ sessionToken: session.sessionToken, userId: session.userId, workspaceId: session.workspaceId, userEmail: session.userEmail });
    this.cache.set(brand, { identity, checkedAt: now, expiresAt });
    return identity;
  }

  forget(brand: OperatorBrand): void { this.cache.delete(brand); }
}
