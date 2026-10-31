import { canonicalFollowupSequence, FOLLOWUP_SEQUENCE_SCHEMA, followupSequenceSha, followupTimeline, FOLLOWUP_SEQUENCE_MIME } from '../../src/followup-sequences/definition.js';
import type { MhpSequenceSnapshot, MhpSequenceReview } from '../../src/mhp/followup-sequence-service.js';
import { ids, local, review, snapshot as emailSnapshot } from './mhp-owner-email-fixture.js';
export const sequenceIds = { item: 'ed127300-0000-4000-8000-000000000001', version: 'ed127400-0000-4000-8000-000000000001', run: 'ed127800-0000-4000-8000-000000000001', proof: 'ed127900-0000-4000-8000-000000000001' };
export const sequenceDefinition = { schema: FOLLOWUP_SEQUENCE_SCHEMA, brand: 'mhp' as const, campaign: emailSnapshot.database.campaign, title: 'Webinar welcome and follow-up', expiryHours: 24,
  stopOn: { reply: false, booked: false, purchased: false }, steps: [{ key: 'first', kind: 'email' as const, contentItemId: ids.item, contentVersionId: ids.version, contentSha256: review.contentSha256 },
    { key: 'wait', kind: 'wait' as const, minutes: 1440 }, { key: 'second', kind: 'email' as const, contentItemId: ids.item, contentVersionId: ids.version, contentSha256: review.contentSha256 }] };
export const sequenceCanonical = canonicalFollowupSequence(sequenceDefinition);
export const sequenceSnapshot: MhpSequenceSnapshot = { database: { brand: emailSnapshot.database.brand, campaign: sequenceDefinition.campaign, eligible: 3, blocked: 2, runCount: 0, runs: [] },
  catalog: { items: [], nextCursor: null }, emailCatalog: emailSnapshot.catalog, mode: 'live', readiness: { email: true, sms: false, whatsapp: false, reply: false, booked: false, purchased: false } };
export const sequenceDetail: MhpSequenceReview = { review: { ...review, contentItemId: sequenceIds.item, contentVersionId: sequenceIds.version, kind: 'other', email: null,
  source: { system: 'mhp.followup-sequence', itemId: `sequence:${sequenceIds.item}`, version: `edit:${sequenceIds.version}` }, title: sequenceDefinition.title,
  canonicalContent: sequenceCanonical, canonicalByteLength: Buffer.byteLength(sequenceCanonical), contentSha256: followupSequenceSha(sequenceCanonical), contentMimeType: FOLLOWUP_SEQUENCE_MIME },
  local: { ...local, contentItemId: sequenceIds.item, contentVersionId: sequenceIds.version, sourceItemId: `sequence:${sequenceIds.item}`, sourceVersion: `edit:${sequenceIds.version}`,
    canonicalContent: sequenceCanonical, contentSha256: followupSequenceSha(sequenceCanonical), valid: true,
    exact: { ...local.exact!, contentItemId: sequenceIds.item, contentVersionId: sequenceIds.version, sourceItemId: `sequence:${sequenceIds.item}`, sourceVersion: `edit:${sequenceIds.version}`,
      canonicalContent: sequenceCanonical, contentSha256: followupSequenceSha(sequenceCanonical), definition: sequenceDefinition, campaign: sequenceDefinition.campaign } },
  definition: sequenceDefinition, blockers: [], timeline: followupTimeline(sequenceDefinition) };
