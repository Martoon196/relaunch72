import { followupTimeline, type FollowupSequenceDefinition } from './definition.js';

export type FollowupRunState = 'active' | 'paused' | 'held' | 'completed' | 'stopped' | 'cancelled' | 'failed';
export interface FollowupRun {
  readonly id: string; readonly state: FollowupRunState; readonly position: number;
  readonly dueAt: string; readonly reason: string | null; readonly inFlight: boolean;
  readonly unknownProofId: string | null;
}
export interface FollowupNextMessage { readonly position: number; readonly dueAt: string }

/** Pure timeline calculation mirrors the DB transition; never advance from a failed/unknown handoff. */
export function nextFollowupMessage(definition: FollowupSequenceDefinition, previousPosition: number, acceptedAt: string): FollowupNextMessage | null {
  const at = Date.parse(acceptedAt);
  if (!Number.isFinite(at) || !Number.isSafeInteger(previousPosition) || previousPosition < -1) throw new Error('Invalid sequence transition');
  const next = followupTimeline(definition).find(step => step.position > previousPosition);
  return next ? { position: next.position, dueAt: new Date(at + next.waitMinutes * 60_000).toISOString() } : null;
}
export function followupCanPrepare(input: { state: FollowupRunState; currentPosition: number; deliveryPosition: number;
  dueAt: string; expiresAt: string; now: number; consent: boolean; exactApproval: boolean; unknownProofId: string | null }): boolean {
  return input.state === 'active' && input.currentPosition === input.deliveryPosition && input.consent && input.exactApproval
    && input.unknownProofId === null && Number.isFinite(Date.parse(input.dueAt)) && Number.isFinite(Date.parse(input.expiresAt))
    && Date.parse(input.dueAt) <= input.now && Date.parse(input.expiresAt) > input.now;
}

export const FOLLOWUP_REASON_LABELS: Readonly<Record<string, string>> = Object.freeze({
  newer_sequence: 'A newer sequence draft exists. Cancel this run before starting the new version from its first step.',
  content_changed: 'The selected email or brand changed. Review the latest content before continuing.',
  outcome_unknown: 'The provider may have accepted this message. Check delivery before choosing a retry that could send it twice.',
  unsubscribed: 'Stopped because this person unsubscribed or no longer has the required email permission.',
  delivery_expired: 'The delivery retry window ended. No further step was started.',
  delivery_failed: 'The current message failed. No further step was started.',
  manual: 'Stopped manually by the owner.', recovery: 'Held during release recovery. An owner must explicitly resume it.',
});
