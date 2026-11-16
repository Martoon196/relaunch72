/**
 * Which businesses may use "Connect email": the one seam every "is this business allowed" decision goes through.
 *
 * Stage 1 (this file): one implementation, staticEligibility, backed by exactly the constant list below (Property
 * Predator only). Stage 2 (a database allow-list, migration 0157) adds a second implementation and passes it in from
 * portal/postgres-platform.ts instead. That swap moves every decision that used the old list, but stage 2 has more to do
 * than the swap (an independent review listed these):
 *   - PgEmailConnectionStore.otherConnectionHolds throws once two businesses are allowed: replace it with the SQL read.
 *   - The product-profile gate ('property_predator_growth' in portal/router.ts, email-connection-router.ts and
 *     growth-home.ts) and the refusal text that names Property Predator sit outside this seam.
 *   - The workspace pins in migrations 0155, 0156 and 0153, and EMAIL_LEDGER_WORKSPACES for durable blocks.
 *   - Removal from the list is NOT a stop: the send path never asks the list, and a running process keeps a removed
 *     business's bounce source while a restarted one drops it. Removal must first switch sending off, and the bounce
 *     source should follow the stored row, not the list.
 *   - Never compose with an empty or not-yet-loaded list (Property Predator's bounce webhook would answer 404 while it
 *     keeps sending); a failed refresh keeps the last good list.
 *   - The lock pool is sized once at start-up; ids in the list must be lower case.
 *   - Make `eligibility` required in the four constructors that fall back to staticEligibility today, so a missed
 *     consumer is a compile error (the store's fallback fails open: "no other business holds this domain").
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
