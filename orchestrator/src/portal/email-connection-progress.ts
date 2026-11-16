/**
 * Where a business is on the five "Connect email" steps, worked out from what is already stored (no state of its
 * own), and the small status card shown wherever sending email is offered (the home page, the follow-ups page).
 *
 *   1 Email rules · 2 Your address · 3 Your domain · 4 Send yourself a test · 5 Go live
 *
 * Steps 1 and 2 are one stored state (not connected): the page moves from 1 to 2 when the rules are ticked, and the
 * tick is recorded with the address when the owner presses Connect.
 */
import { escapeHtml as e } from './ui.js';
import type { EmailConnectionView } from '../email-connections/service.js';
import type { OwnerSendingView } from '../email-protection/owner.js';

export type EmailStep = 1 | 2 | 3 | 4 | 5;
export const EMAIL_STEP_NAMES: Readonly<Record<EmailStep, string>> = Object.freeze({ 1: 'Email rules', 2: 'Your address', 3: 'Your domain', 4: 'Send yourself a test', 5: 'Go live' });

/** The step that is "now", or 'live' once every step is done. null when Connect email is not offered. */
export function emailStepNow(view: EmailConnectionView, sending: OwnerSendingView | null | undefined, agreed = false): EmailStep | 'live' | null {
  if (!view.offered) return null;
  const state = view.state;
  switch (state.status) {
    case 'not_connected': case 'disconnected': return agreed ? 2 : 1;
    case 'creating': case 'needs_attention': case 'dns_pending': return 3;
    case 'verified': {
      const s = sending?.offered ? sending.sending : null;
      // Release 1 only (no sending controls yet): connected, and the rest switches on later.
      if (!s) return 4;
      if (!s.businessName || !s.postalAddress || !s.testCurrent) return 4;
      if (state.mode === 'live' && s.approvedCurrent) return 'live';
      return 5;
    }
  }
}

/** The card's three states: not started, in progress at step N, live. */
export type EmailEntryStatus = { readonly kind: 'not_started' } | { readonly kind: 'in_progress'; readonly step: EmailStep } | { readonly kind: 'live' };

export function emailEntryStatus(view: EmailConnectionView, sending: OwnerSendingView | null | undefined): EmailEntryStatus | null {
  const now = emailStepNow(view, sending);
  if (now === null) return null;
  if (now === 'live') return { kind: 'live' };
  // Steps 1 and 2 have nothing stored yet: to the owner that is "not started".
  return now <= 2 ? { kind: 'not_started' } : { kind: 'in_progress', step: now };
}

/**
 * The small status card. The classes are the host page's own: `card` for the panel and `button` for the one button
 * (the home page passes its panel class; the follow-ups page its card class).
 */
export function renderEmailEntryCard(status: EmailEntryStatus, classes: { readonly card: string; readonly button?: string } = { card: 'card' }): string {
  const button = classes.button ?? 'button';
  if (status.kind === 'live') {
    return `<section class="${e(classes.card)} email-entry" aria-label="Your email"><p><strong>Email connected ✓</strong> Your follow-up and marketing emails go out from your own address.
      <a href="/portal/email">See your email page</a></p></section>`;
  }
  if (status.kind === 'not_started') {
    return `<section class="${e(classes.card)} email-entry" aria-label="Your email"><h2>Connect your email (about 5 minutes)</h2>
      <p>Send your follow-up and marketing emails from your own address. We walk you through it one step at a time.</p>
      <p><a class="${e(button)}" href="/portal/email">Connect email</a></p></section>`;
  }
  return `<section class="${e(classes.card)} email-entry" aria-label="Your email"><h2>Finish connecting your email: step ${status.step} of 5</h2>
    <p>Next: ${e(EMAIL_STEP_NAMES[status.step])}. Your place is saved.</p>
    <p><a class="${e(button)}" href="/portal/email#email-step">Carry on</a></p></section>`;
}
