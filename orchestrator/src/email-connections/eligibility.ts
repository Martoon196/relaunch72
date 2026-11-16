/**
 * Which businesses may use "Connect email": the one seam every "is this business allowed" decision goes through.
 *
 * Two implementations:
 *   staticEligibility   exactly the constant list below (Property Predator only): what the code did before the database
 *                       allow-list, and what the database-backed one answers while migration 0157 is not applied.
 *   databaseEligibility (allowlist.ts) the founder's allow-list in the database (0157), read asynchronously BEFORE
 *                       composition and again on the stored-connections tick (about every 60 seconds) into an
 *                       in-memory snapshot these synchronous methods answer from: no request path gains a database read
 *                       or an extra await.
 * portal/postgres-platform.ts chooses one and passes it to every consumer; every consumer requires it (a missed one is a
 * compile error).
 *
 * What the list decides, and what it does NOT:
 *   - It decides who may open the email page, connect, continue, check, and see the home entry (request paths).
 *   - It does NOT decide whether email is sent: the send path asks the database itself (0157's email_send_reserve
 *     answers 'not_allowed' for a business that is not on the active list), so removal is a stop at once, in every
 *     process, whatever this snapshot still says.
 *   - It does NOT decide bounce handling: a stored connection's bounce source follows its stored row
 *     (bounce-sources.ts), so bounces and complaints from mail already sent are recorded after a removal and the
 *     webhook never starts answering 404 while the row exists.
 *
 * The methods are synchronous ON PURPOSE (see above). Ids in every list are lower case.
 */
import { connectionSourceKey, type EmailConnectBusiness } from './config.js';

/** Property Predator: the first business allowed to connect email (seeded on the database allow-list by 0157). */
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
  /**
   * True once the answers come from the database allow-list (0157 is applied and was read). False for the static list
   * (and for the database-backed one while 0157 is not applied): then every answer, message and fallback is exactly
   * the pre-0157 one.
   */
  readonly fromDatabase: boolean;
}

/** An eligibility over a fixed list (lower-case workspace ids). staticEligibility is the pre-0157 one. */
export function listEligibility(businesses: readonly EmailConnectBusiness[]): EmailConnectEligibility {
  const business = (workspaceId: string): EmailConnectBusiness | null => businesses.find(item => item.workspaceId === workspaceId.toLowerCase()) ?? null;
  return Object.freeze({ business, allowed: (workspaceId: string) => business(workspaceId) !== null, list: () => businesses, fromDatabase: false });
}

/**
 * The Connect run-lock pool's size: a fixed maximum, so a business allowed after start-up connects without a restart.
 * The pool opens connections only when a run takes the lock (one per business running Connect at that moment in this
 * process; the same business twice in one process is told at once and never queues), so with one business it uses at
 * most one connection, exactly as before. Up to 8 businesses can run Connect at the same moment in one process; a
 * ninth waits for a free connection (its lock wait, then "already being set up") and never takes a shared identity
 * connection.
 */
export const EMAIL_CONNECT_LOCK_POOL_SIZE = 8;
export const emailConnectionLockPoolSize = (): number => EMAIL_CONNECT_LOCK_POOL_SIZE;

/** The pre-0157 allow-list: exactly EMAIL_CONNECT_BUSINESSES (Property Predator only). */
export const staticEligibility: EmailConnectEligibility = listEligibility(EMAIL_CONNECT_BUSINESSES);

/** The refusal shown to a business that is not allowed: names Property Predator only while 0157 is absent (as before). */
export const EMAIL_CONNECT_NOT_ALLOWED = Object.freeze({
  static: 'Email can only be connected for Property Predator for now.',
  database: 'Email isn\'t switched on for this business yet. Ask the platform owner.',
});
export const emailConnectNotAllowedMessage = (eligibility: Pick<EmailConnectEligibility, 'fromDatabase'>): string =>
  eligibility.fromDatabase ? EMAIL_CONNECT_NOT_ALLOWED.database : EMAIL_CONNECT_NOT_ALLOWED.static;
