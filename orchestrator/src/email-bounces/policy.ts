/**
 * Email bounce and complaint policy, shared by every brand workspace.
 *
 * The rules in one place (owner rule, 12 November 2026):
 *   hard bounce            the address does not work: no email of any kind from that brand
 *   spam complaint         no email of any kind from that brand
 *   manual                 the owner blocked the address: no email of any kind (reserved; nothing writes it yet)
 *   unsubscribed           (through the provider's own link or list) no marketing email; an event email the
 *                          person asked for (a booking or webinar confirmation) may still go
 *   repeated soft bounce   SOFT_BOUNCE_LIMIT temporary failures inside SOFT_BOUNCE_WINDOW_DAYS: no marketing email
 *
 * Hard bounces, spam complaints and unsubscribes are kept in the database ledger (0153) where it exists; see ledger.ts.
 *
 * Only the EMAIL channel is ever affected. Texts and WhatsApp are untouched.
 * Account email (sign-in links, receipts) is not guarded here: the provider's own
 * per-stream list already stops repeat bounces there, and wrongly refusing a
 * paying member's sign-in link costs more than one extra bounce.
 */

export type EmailBlockReason = 'hard_bounce' | 'spam_complaint' | 'manual' | 'unsubscribed' | 'repeated_soft_bounce';
/** marketing: follow-ups, sequences, promotions. service: an event email the person asked for. */
export type EmailPurpose = 'marketing' | 'service';
export type EmailFactKind = 'hard_bounce' | 'soft_bounce' | 'spam_complaint' | 'unsubscribed';

export const SOFT_BOUNCE_LIMIT = 3;
export const SOFT_BOUNCE_WINDOW_DAYS = 30;
export const EMAIL_HEALTH_WINDOW_DAYS = 30;

/**
 * Our own early-warning lines, deliberately stricter than the provider's.
 * Postmark expects bounces under roughly 10% and spam complaints under 0.1%.
 */
export const BOUNCE_WARNING_RATE = 0.05;
export const COMPLAINT_WARNING_RATE = 0.0005;
export const PROVIDER_BOUNCE_LIMIT_RATE = 0.10;
export const PROVIDER_COMPLAINT_LIMIT_RATE = 0.001;

const REASON_RANK: Readonly<Record<EmailBlockReason, number>> = Object.freeze({
  hard_bounce: 5, spam_complaint: 4, manual: 3, unsubscribed: 2, repeated_soft_bounce: 1,
});

/** Reasons that stop every email from the brand, including the event emails a person asked for. */
const ALL_EMAIL_REASONS: ReadonlySet<EmailBlockReason> = new Set(['hard_bounce', 'spam_complaint', 'manual']);

export function blocksPurpose(reason: EmailBlockReason, purpose: EmailPurpose): boolean {
  return purpose === 'marketing' || ALL_EMAIL_REASONS.has(reason);
}

export function strongestReason(reasons: Iterable<EmailBlockReason>): EmailBlockReason | null {
  let best: EmailBlockReason | null = null;
  for (const reason of reasons) if (!best || REASON_RANK[reason] > REASON_RANK[best]) best = reason;
  return best;
}

/**
 * Reasons a provider event makes final in itself. A repeated soft bounce is a temporary state and lifts when the
 * window passes; 'manual' is the owner's own decision and never comes from the provider.
 */
export type LastingBlockReason = Exclude<EmailBlockReason, 'repeated_soft_bounce' | 'manual'>;

/** A fact that blocks on its own; a single soft bounce only counts. */
export function factBlockReason(kind: EmailFactKind): LastingBlockReason | null {
  return kind === 'soft_bounce' ? null : kind;
}

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u;
export function normalizeBounceEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email.length >= 3 && email.length <= 320 && EMAIL.test(email) ? email : null;
}

export type EmailSendDecision = { readonly blocked: false } | { readonly blocked: true; readonly reason: EmailBlockReason };

/** What a send path asks before handing a message to the provider. */
export interface EmailSendGuard {
  /** Resolves once the first read of the provider's lists has finished (or timed out). */
  whenReady(): Promise<void>;
  /** The in-process answer only. */
  decide(workspaceId: string, email: string, purpose: EmailPurpose): EmailSendDecision;
  /** The durable answer: the database ledger where it exists, with the in-process list in front of it. */
  check?(workspaceId: string, email: string, purpose: EmailPurpose): Promise<EmailSendDecision>;
  /**
   * False when the durable list is in use for this workspace but cannot be read right now. A dispatcher asks this
   * BEFORE claiming, so a database fault never spends a claimed attempt (claims count attempts and cannot hand them back).
   */
  available?(workspaceId: string): Promise<boolean>;
}

/** What every send path calls: the durable check when the guard has one, otherwise the in-process answer. */
export async function decideRecipient(guard: EmailSendGuard, workspaceId: string, email: string, purpose: EmailPurpose): Promise<EmailSendDecision> {
  return guard.check ? guard.check(workspaceId, email, purpose) : guard.decide(workspaceId, email, purpose);
}

/**
 * Whether a send path that was just refused should also stop the PERSON for good in the brand's own records.
 * A dead address or a spam report does: every email to them is refused anyway, so the stop only cancels what can
 * no longer go. Someone who is blocked from marketing alone (an unsubscribe, a temporary soft-bounce block) keeps
 * the event emails they asked for, which the stop would cancel. An owner's manual block is recorded by the owner.
 */
export function refusalStopsPerson(reason: EmailRefusalReason): boolean {
  return reason === 'hard_bounce' || reason === 'spam_complaint';
}

/**
 * Why a send was a definite non-send: a block of ours; (marketing only) the durable list could not be read; or the
 * provider itself refused the recipient as inactive on that stream (Postmark 406), which is not a block of ours.
 */
export type EmailRefusalReason = EmailBlockReason | 'check_unavailable' | 'provider_inactive';

/** Thrown by a sender that refused before any provider call: a definite non-send. */
export class EmailRecipientBlockedError extends Error {
  constructor(readonly reason: EmailRefusalReason, message = 'Recipient is blocked after a bounce, complaint or unsubscribe') { super(message); }
}

/**
 * The durable block list could not be read for a MARKETING email. Fail closed: a definite non-send that is tried again
 * later by the queue's own rule, never a send decided by the in-process list alone. Never stops the person.
 * Event (service) email is not refused for this: it falls back to the in-process list.
 */
export class EmailGuardUnavailableError extends EmailRecipientBlockedError {
  constructor() { super('check_unavailable', 'The email block list could not be read; the marketing email is held for a later attempt'); }
}

export const BLOCK_REASON_PLAIN: Readonly<Record<EmailBlockReason, string>> = Object.freeze({
  hard_bounce: 'The address does not work (the email came straight back)',
  spam_complaint: 'They marked one of your emails as spam',
  manual: 'You blocked this address',
  unsubscribed: 'They unsubscribed',
  repeated_soft_bounce: `Their mailbox kept refusing email (${SOFT_BOUNCE_LIMIT} times in ${SOFT_BOUNCE_WINDOW_DAYS} days)`,
});
