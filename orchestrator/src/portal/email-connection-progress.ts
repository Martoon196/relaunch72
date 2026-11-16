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
import type { EmailConnectionState } from '../email-connections/store.js';
import type { SendingConfig } from '../email-protection/store.js';

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
export type EmailEntryStatus = { readonly kind: 'not_started' } | { readonly kind: 'in_progress'; readonly step: EmailStep }
  | { readonly kind: 'live'; readonly note?: 'paused' | 'off' };

export function emailEntryStatus(view: EmailConnectionView, sending: OwnerSendingView | null | undefined): EmailEntryStatus | null {
  const now = emailStepNow(view, sending);
  if (now === null) return null;
  if (now === 'live') {
    const s = sending?.sending, state = view.offered ? view.state : null;
    return state?.protection.state === 'off' ? { kind: 'live', note: 'off' } : s?.ownerPausedAt || state?.protection.state === 'paused' ? { kind: 'live', note: 'paused' } : { kind: 'live' };
  }
  // Steps 1 and 2 have nothing stored yet: to the owner that is "not started".
  return now <= 2 ? { kind: 'not_started' } : { kind: 'in_progress', step: now };
}

/**
 * The card's state from the light read only: the sender's config (0156) when this database has it, else the stored
 * connection state. null: show the plain "Connect email" link instead (a connected business whose sending could not
 * be read is never called "step 4 of 5").
 */
export function emailEntryFromLight(read: { readonly config: SendingConfig | null | 'absent'; readonly state?: EmailConnectionState | null }): EmailEntryStatus | null {
  const { config } = read;
  if (config === 'absent') {
    const state = read.state;
    if (!state) return null;
    if (state.status === 'not_connected' || state.status === 'disconnected') return { kind: 'not_started' };
    if (state.status === 'verified') return null;
    return { kind: 'in_progress', step: 3 };
  }
  if (!config) return { kind: 'not_started' };
  if (config.status === 'not_connected' || config.status === 'disconnected') return { kind: 'not_started' };
  if (config.status !== 'verified') return { kind: 'in_progress', step: 3 };
  if (config.protectionState === 'off') return { kind: 'live', note: 'off' };
  if (!config.businessName || !config.postalAddress || !config.testCurrent) return { kind: 'in_progress', step: 4 };
  if (config.mode === 'live' && config.approvedCurrent) return config.ownerPaused || config.protectionState === 'paused' ? { kind: 'live', note: 'paused' } : { kind: 'live' };
  return { kind: 'in_progress', step: 5 };
}

export const EMAIL_ENTRY_TIMEOUT_MS = 300;

/**
 * Reads the card's state for a page render: at most two cheap reads, bounded by a short timeout. A slow, failing or
 * missing read gives null (the page shows its plain link); it never throws and never delays the page past the timeout.
 */
export async function readEmailEntry(input: {
  readonly config: () => Promise<SendingConfig | null | 'absent'>;
  readonly state: () => Promise<EmailConnectionState | null>;
  readonly timeoutMs?: number;
}): Promise<EmailEntryStatus | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), input.timeoutMs ?? EMAIL_ENTRY_TIMEOUT_MS); timer.unref?.(); });
  const work = (async () => {
    const config = await input.config();
    return emailEntryFromLight(config === 'absent' ? { config, state: await input.state() } : { config });
  })().catch(() => null);
  try { return await Promise.race([work, late]); } finally { clearTimeout(timer); }
}

/**
 * The small status card. The classes are the host page's own: `card` for the panel and `button` for the one button
 * (the home page passes its panel class; the follow-ups page its card class).
 */
export function renderEmailEntryCard(status: EmailEntryStatus, classes: { readonly card: string; readonly button?: string } = { card: 'card' }): string {
  const button = classes.button ?? 'button';
  if (status.kind === 'live') {
    const line = status.note === 'off' ? '<strong>Email connected: sending is off</strong> Your marketing emails are not going out. Your email page says why.'
      : status.note === 'paused' ? '<strong>Email connected ✓ (paused)</strong> Your marketing emails are paused. Your email page says what to do.'
      : '<strong>Email connected ✓</strong> Your follow-up and marketing emails go out from your own address.';
    return `<section class="${e(classes.card)} email-entry" aria-label="Your email"><p>${line}
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
