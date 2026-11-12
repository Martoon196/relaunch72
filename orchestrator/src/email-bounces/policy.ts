/**
 * Email bounce and complaint policy, shared by every brand workspace.
 *
 * The rules in one place:
 *   hard bounce            the address does not work: no marketing AND no event/service email
 *   spam complaint         no marketing email of any purpose
 *   unsubscribed           (through the provider's own link or list) no marketing email
 *   repeated soft bounce   SOFT_BOUNCE_LIMIT temporary failures inside SOFT_BOUNCE_WINDOW_DAYS: no marketing email
 *
 * Only the EMAIL channel is ever affected. Texts and WhatsApp are untouched.
 * Account email (sign-in links, receipts) is not guarded here: the provider's own
 * per-stream list already stops repeat bounces there, and wrongly refusing a
 * paying member's sign-in link costs more than one extra bounce.
 */

export type EmailBlockReason = 'hard_bounce' | 'spam_complaint' | 'unsubscribed' | 'repeated_soft_bounce';
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
  hard_bounce: 4, spam_complaint: 3, unsubscribed: 2, repeated_soft_bounce: 1,
});

export function blocksPurpose(reason: EmailBlockReason, purpose: EmailPurpose): boolean {
  return purpose === 'marketing' || reason === 'hard_bounce';
}

export function strongestReason(reasons: Iterable<EmailBlockReason>): EmailBlockReason | null {
  let best: EmailBlockReason | null = null;
  for (const reason of reasons) if (!best || REASON_RANK[reason] > REASON_RANK[best]) best = reason;
  return best;
}

/** A fact that blocks on its own; a single soft bounce only counts. */
export function factBlockReason(kind: EmailFactKind): EmailBlockReason | null {
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
  decide(workspaceId: string, email: string, purpose: EmailPurpose): EmailSendDecision;
}

/** Thrown by a sender that refused before any provider call: a definite non-send. */
export class EmailRecipientBlockedError extends Error {
  constructor(readonly reason: EmailBlockReason) { super('Recipient is blocked after a bounce, complaint or unsubscribe'); }
}

export const BLOCK_REASON_PLAIN: Readonly<Record<EmailBlockReason, string>> = Object.freeze({
  hard_bounce: 'The address does not work (the email came straight back)',
  spam_complaint: 'They marked one of your emails as spam',
  unsubscribed: 'They unsubscribed',
  repeated_soft_bounce: `Their mailbox kept refusing email (${SOFT_BOUNCE_LIMIT} times in ${SOFT_BOUNCE_WINDOW_DAYS} days)`,
});
