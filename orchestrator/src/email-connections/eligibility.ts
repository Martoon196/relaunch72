/**
 * Which businesses may use "Connect email": the one seam every "is this business allowed" decision goes through.
 *
 * Stage 1 (this file): one implementation, staticEligibility, backed by exactly the constant list below (Property
 * Predator only). Stage 2 (a database allow-list, migration 0157) adds a second implementation and passes it in from
 * portal/postgres-platform.ts instead; no other file needs to change for that.
 *
 * The methods are synchronous ON PURPOSE. They are called on request paths (the home page's entry, the email page and
 * its ?business= check, every Connect step, Go live's webhook check) and on the bounce webhook's path (handles(), the
 * source put in force), none of which awaits for this today. Stage 2 should therefore read its table asynchronously
 * BEFORE composition (and again on the stored-connections refresh, about every 60 seconds) into an in-memory snapshot
 * these methods answer from: no request path gains a database read or an extra await.
 *
 * Who calls what:
 *   business(id)  request path: EmailConnectionService (every step), OwnerSendingService.webhookVerified (Go live),
 *                 the email page's ?business= check; bounce path: connectionBounceSource, BounceSources.put/remove,
 *                 and each row of BounceSources.refresh (start-up and every 60 s).
 *   allowed(id)   request path: the home page's entry and the email status card (portal/router.ts).
 *   list()        start-up: the run-lock pool's size (emailConnectionLockPoolSize); bounce path: BounceSources.handles(key);
 *                 PgEmailConnectionStore.otherConnectionHolds (how many businesses are allowed).
 */
import { connectionSourceKey, type EmailConnectBusiness } from './config.js';

/** Property Predator: the first, and in this release the only, business allowed to connect email. */
export const PP_EMAIL_WORKSPACE_ID = 'd975ff66-336a-46c2-b36b-d7095a11af97';

export const EMAIL_CONNECT_BUSINESSES: readonly EmailConnectBusiness[] = Object.freeze([
  Object.freeze({ workspaceId: PP_EMAIL_WORKSPACE_ID, name: 'Property Predator', sourceKey: connectionSourceKey(PP_EMAIL_WORKSPACE_ID), replacesSourceKey: null }),
]);

export interface EmailConnectEligibility {
  /** The allowed business for this workspace id (any letter case), with the facts its naming uses; null: not allowed. */
  business(workspaceId: string): EmailConnectBusiness | null;
  /** business(workspaceId) !== null. */
  allowed(workspaceId: string): boolean;
  /** Every allowed business, for the places that must enumerate them. */
  list(): readonly EmailConnectBusiness[];
}

/** An eligibility over a fixed list (lower-case workspace ids). staticEligibility is the production one. */
export function listEligibility(businesses: readonly EmailConnectBusiness[]): EmailConnectEligibility {
  const business = (workspaceId: string): EmailConnectBusiness | null => businesses.find(item => item.workspaceId === workspaceId.toLowerCase()) ?? null;
  return Object.freeze({ business, allowed: (workspaceId: string) => business(workspaceId) !== null, list: () => businesses });
}

/**
 * Start-up: the size of the Connect run-lock pool, one connection per allowed business plus one, so a run never
 * holds a shared identity connection and one business's run never queues another's.
 */
export const emailConnectionLockPoolSize = (eligibility: EmailConnectEligibility): number => eligibility.list().length + 1;

/** Today's allow-list: exactly EMAIL_CONNECT_BUSINESSES (Property Predator only). */
export const staticEligibility: EmailConnectEligibility = listEligibility(EMAIL_CONNECT_BUSINESSES);
