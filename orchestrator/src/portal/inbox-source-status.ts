import type { PortalZernioMessagingSnapshot } from './zernio-messaging-service.js';

export type InboxSourceState = 'ready' | 'check_on_open' | 'not_connected' | 'permission_missing'
  | 'paused' | 'read_failed' | 'not_available';

export interface InboxSourceStatus {
  readonly id: 'conversion' | 'social';
  readonly label: string;
  readonly href: string;
  readonly state: InboxSourceState;
  readonly checkedAt: string | null;
  readonly lastKnownAt: string | null;
  readonly readDetail: string;
  readonly replyDetail: string;
}

export function conversionInboxStatus(ready: boolean): InboxSourceStatus {
  return Object.freeze({
    id: 'conversion', label: 'Messages & follow-ups', href: '/portal/inbox',
    state: ready ? 'ready' : 'read_failed', checkedAt: null, lastKnownAt: null,
    readDetail: ready ? 'The workspace conversation records are available.' : 'The conversation records could not be refreshed.',
    replyDetail: 'Each record shows its own draft, approval and delivery state.',
  });
}

export function conversionUncheckedStatus(configured: boolean): InboxSourceStatus {
  const base = { id: 'conversion' as const, label: 'Messages & follow-ups', href: '/portal/inbox' };
  return configured
    ? Object.freeze({ ...base, state: 'check_on_open' as const, checkedAt: null, lastKnownAt: null, readDetail: 'Open Messages & follow-ups to check the workspace conversation records.', replyDetail: 'Each record shows its own draft, approval and delivery state.' })
    : Object.freeze({ ...base, state: 'not_available' as const, checkedAt: null, lastKnownAt: null, readDetail: 'Messages & follow-ups is not available in this workspace.', replyDetail: 'No conversation action is available.' });
}

export function socialUncheckedStatus(configured: boolean): InboxSourceStatus {
  const base = { id: 'social' as const, label: 'Live social', href: '/portal/inbox/social' };
  return configured
    ? Object.freeze({ ...base, state: 'check_on_open' as const, checkedAt: null, lastKnownAt: null, readDetail: 'Open Live social to check the connected accounts and messages.', replyDetail: 'Reply readiness is checked on that source.' })
    : Object.freeze({ ...base, state: 'not_available' as const, checkedAt: null, lastKnownAt: null, readDetail: 'Live social is not available in this workspace.', replyDetail: 'No social reply action is available.' });
}

export function socialMessagingStatus(snapshot: PortalZernioMessagingSnapshot): InboxSourceStatus {
  const base = { id: 'social' as const, label: 'Live social', href: '/portal/inbox/social' };
  if (!snapshot.ok) return Object.freeze({ ...base, state: snapshot.kind === 'not_connected' ? 'not_connected' as const : snapshot.kind === 'forbidden' || snapshot.kind === 'unauthenticated' ? 'permission_missing' as const : 'read_failed' as const, checkedAt: null, lastKnownAt: null, readDetail: snapshot.kind === 'not_connected' ? 'No active social account is connected.' : snapshot.kind === 'forbidden' || snapshot.kind === 'unauthenticated' ? 'You cannot view this source.' : 'Live social could not be refreshed.', replyDetail: snapshot.kind === 'not_connected' ? 'Connect an account in Social accounts.' : 'No provider action ran.' });
  const paused = snapshot.emergencyPaused || !snapshot.outboundEffectsEnabled;
  const instant = new Date(snapshot.checkedAt);
  const checkedLabel = Number.isNaN(instant.getTime()) ? 'time unavailable' : new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  }).format(instant);
  return Object.freeze({ ...base, state: paused ? 'paused' as const : 'ready' as const, checkedAt: snapshot.checkedAt, lastKnownAt: snapshot.checkedAt, readDetail: `Messages checked ${checkedLabel}.`, replyDetail: paused ? 'Reading is available; replies are paused.' : 'Replies require an exact approved draft.' });
}
