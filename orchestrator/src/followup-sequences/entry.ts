import { followupEntryIntent, type FollowupSequenceDefinition } from './definition.js';

export const MHP_CAPTURE_ENTRY_SOURCE = 'mhp.capture/v2' as const;
export const MHP_CAPTURE_ENTRY_EVENT = 'webinar_signup' as const;
export interface FollowupEntryRule {
  id: string; contentItemId: string; contentVersionId: string; state: 'active' | 'held' | 'off' | 'expired';
  activatedAt: string; expiresAt: string; heldReason: string | null;
  cursorSequence: string; cursorSignupId: string | null; cursorAt: string | null; lastSweptAt: string | null;
  processed: number; enrolled: number; skipped: number; blocked: number;
}
export function followupCanEnableEntry(definition: FollowupSequenceDefinition, currentPublished: boolean, emailReady: boolean): boolean {
  return currentPublished && emailReady && definition.brand === 'mhp' && followupEntryIntent(definition).mode === 'webinar_signup';
}
export function followupEntryExpiry(value: string, now: number): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u.test(value)) throw new Error('Choose a valid future stop time in UTC.');
  const at = Date.parse(`${value}:00Z`);
  if (!Number.isFinite(at) || at <= now || new Date(at).toISOString().slice(0, 16) !== value) throw new Error('Choose a valid future stop time in UTC.');
  return new Date(at).toISOString();
}
export interface FollowupEntrySweepResult { processed: number; enrolled: number; alreadyEnrolled: number; blocked: number; skipped: number; heldRules: number }
