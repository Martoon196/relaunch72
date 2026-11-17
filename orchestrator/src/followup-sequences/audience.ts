import { FollowupSequenceValidationError } from './definition.js';

/**
 * Who a sequence is for. This is a separate, explicit statement next to the stored
 * definition: the definition says what is sent and when, the audience says to whom.
 *
 * Storage: the MHP database validator (app_private.mhp_sequence_exact, 0128/0129) pins
 * the definition's keys exactly, so an `audience` key inside the canonical definition
 * would make every new version unpublishable until a migration widens it. Until then the
 * audience lives in the same immutable content-version row, in
 * metadata.mhpSequence.audience = { schema, kind, campaign }, which that validator
 * tolerates. Versions are append-only, so the audience cannot change under an approval.
 */
/**
 * webinar_signups: people who registered for the configured webinar and agreed to emails.
 * book_readers: people who asked for the Before You Buy first chapter and ticked the email box (release B, migration 0160).
 * none_yet: written and approved, with no audience this system can start.
 */
export const FOLLOWUP_AUDIENCE_KINDS = ['webinar_signups', 'book_readers', 'none_yet'] as const;
export type FollowupAudienceKind = typeof FOLLOWUP_AUDIENCE_KINDS[number];
export const MHP_SEQUENCE_AUDIENCE_SCHEMA = 'mhp.followup-sequence-audience/v1' as const;
/** How the audience of a version was decided: chosen when saved; anything else (saved before audiences, or unreadable) is "none yet". */
export type FollowupAudienceOrigin = 'chosen' | 'legacy_none' | 'unreadable';
export interface FollowupAudience { readonly kind: FollowupAudienceKind; readonly campaign: string | null; readonly origin: FollowupAudienceOrigin }
export interface StoredFollowupAudience { readonly schema: typeof MHP_SEQUENCE_AUDIENCE_SCHEMA; readonly kind: FollowupAudienceKind; readonly campaign: string | null }

const CAMPAIGN = /^[a-z0-9_-]{1,60}$/u;
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A plain form or tool value. Anything other than the two names is refused; a missing value is "none yet", never webinar. */
export function parseFollowupAudienceChoice(value: unknown): FollowupAudienceKind {
  if (value === undefined || value === null || value === '') return 'none_yet';
  if (typeof value !== 'string' || !(FOLLOWUP_AUDIENCE_KINDS as readonly string[]).includes(value)) throw new FollowupSequenceValidationError('Choose who this sequence is for.');
  return value as FollowupAudienceKind;
}
export function storedFollowupAudience(kind: FollowupAudienceKind, campaign: string): StoredFollowupAudience {
  if (!CAMPAIGN.test(campaign)) throw new FollowupSequenceValidationError('The webinar audience is unavailable.');
  return Object.freeze({ schema: MHP_SEQUENCE_AUDIENCE_SCHEMA, kind, campaign: kind === 'webinar_signups' ? campaign : null });
}
/**
 * Reads the audience saved with a version. null means the version predates audiences.
 * Anything present but malformed is treated as "none yet" (it can never be started), not as webinar.
 */
export function readStoredFollowupAudience(metadata: unknown): FollowupAudience | null {
  const local = record(metadata) ? metadata.mhpSequence : undefined;
  if (!record(local) || !('audience' in local)) return null;
  const value = local.audience;
  if (!record(value) || Object.keys(value).sort().join(',') !== 'campaign,kind,schema' || value.schema !== MHP_SEQUENCE_AUDIENCE_SCHEMA
      || !(FOLLOWUP_AUDIENCE_KINDS as readonly unknown[]).includes(value.kind)
      || (value.kind === 'webinar_signups' ? typeof value.campaign !== 'string' || !CAMPAIGN.test(value.campaign) : value.campaign !== null)) {
    return Object.freeze({ kind: 'none_yet', campaign: null, origin: 'unreadable' });
  }
  return Object.freeze({ kind: value.kind as FollowupAudienceKind, campaign: value.campaign as string | null, origin: 'chosen' });
}
/**
 * A version saved before audiences existed, or one without a valid saved audience, is for no one yet,
 * whatever people or rules it has. Having people in it proves nothing: the book sequence that caused the
 * incident has webinar people in it precisely because it was started for the wrong audience. A sequence
 * becomes startable only when the owner saves a version and chooses "People who registered for the webinar".
 */
export function legacyFollowupAudience(): FollowupAudience {
  return Object.freeze({ kind: 'none_yet', campaign: null, origin: 'legacy_none' });
}
/**
 * An audience this system can start (and resume): explicitly chosen, and either the configured webinar's sign-ups
 * or book readers. Whether the database can already start book readers (migration 0160) is a separate question.
 */
export function followupAudienceCanStart(audience: FollowupAudience, configuredCampaign: string): boolean {
  if (audience.origin !== 'chosen') return false;
  if (audience.kind === 'book_readers') return audience.campaign === null;
  return audience.kind === 'webinar_signups' && audience.campaign === configuredCampaign && CAMPAIGN.test(configuredCampaign);
}
/** Only the webinar audience has the existing automatic webinar sign-up rule. */
export function followupAudienceIsWebinar(audience: FollowupAudience, configuredCampaign: string): boolean {
  return followupAudienceCanStart(audience, configuredCampaign) && audience.kind === 'webinar_signups';
}
export function followupAudienceIsBook(audience: FollowupAudience): boolean {
  return audience.origin === 'chosen' && audience.kind === 'book_readers';
}
export const FOLLOWUP_NO_AUDIENCE_LINE = 'This sequence has no audience yet, so it cannot be started. It is saved and approved, ready for when its audience is connected.';
export const FOLLOWUP_NO_AUDIENCE_RESUME = 'This sequence has no audience yet, so nobody in it can be restarted here. You can stop them.';
export const BOOK_READERS_DATABASE_STEP = 'This will be ready after one database step. The sequence is saved; nothing has been sent.';
export const BOOK_READERS_LABEL = 'Before You Buy — book interest';
