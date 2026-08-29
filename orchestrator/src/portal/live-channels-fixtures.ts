/**
 * Deterministic, fictional Live Channels snapshot for the labelled local
 * preview only. It reuses the shared truth-rail shape verbatim but is
 * stamped `illustrative_fixture`, and the presenter enforces that an
 * illustrative snapshot can never depict a deliverable channel. Nothing
 * here was read from Mailgun, Ayrshare, Meta or any database, and the
 * production route never renders this fixture.
 */

import type { LiveChannelsSourceSnapshot } from './live-channels-presenter.js';

export const PROPERTY_PREDATOR_LIVE_CHANNELS_AS_OF = '2026-08-27T12:00:00.000Z';

const WORKSPACE_ID = 'fa100000-0000-4000-8000-000000000001';

export function createPropertyPredatorLiveChannelsFixture(): LiveChannelsSourceSnapshot {
  return Object.freeze({
    workspaceId: WORKSPACE_ID,
    snapshotAt: PROPERTY_PREDATOR_LIVE_CHANNELS_AS_OF,
    dataset: 'illustrative_fixture',
    rails: Object.freeze([
      Object.freeze({
        rail: 'customer_email',
        connectionState: 'ready',
        inboundState: 'ready',
        outboundOrReplyState: 'blocked',
        receiptState: 'healthy',
        caps: Object.freeze({
          daily: Object.freeze({ used: 4, limit: 10, remaining: 6 }),
          monthly: Object.freeze({ used: 14, limit: 50, remaining: 36 }),
        }),
        blockerCodes: Object.freeze(['EMERGENCY_PAUSED']),
        latestReceipt: Object.freeze({
          receiptId: 'fa300000-0000-4000-8000-000000000001',
          outcome: 'succeeded',
          recordedAt: '2026-08-27T09:14:30.000Z',
          evidenceSha256: 'a'.repeat(64),
        }),
      }),
      Object.freeze({
        rail: 'owned_social',
        connectionState: 'ready',
        inboundState: 'not_supported',
        outboundOrReplyState: 'effects_disabled',
        receiptState: 'outcome_unknown',
        caps: Object.freeze({
          daily: Object.freeze({ used: 0, limit: 1, remaining: 1 }),
          monthly: Object.freeze({ used: 2, limit: 3, remaining: 1 }),
        }),
        blockerCodes: Object.freeze(['EFFECTS_DISABLED', 'OUTCOME_UNKNOWN_QUARANTINED']),
        latestReceipt: Object.freeze({
          receiptId: 'fa300000-0000-4000-8000-000000000002',
          outcome: 'outcome_unknown',
          recordedAt: '2026-08-26T18:20:30.000Z',
          evidenceSha256: 'b'.repeat(64),
        }),
      }),
      Object.freeze({
        rail: 'whatsapp',
        connectionState: 'configured',
        inboundState: 'not_ready',
        outboundOrReplyState: 'approval_required',
        receiptState: 'pending',
        caps: Object.freeze({
          daily: Object.freeze({ used: 0, limit: 1, remaining: 1 }),
          monthly: Object.freeze({ used: 0, limit: 3, remaining: 3 }),
        }),
        blockerCodes: Object.freeze(['INGRESS_NOT_READY', 'APPROVAL_REQUIRED']),
        latestReceipt: Object.freeze({
          receiptId: 'fa300000-0000-4000-8000-000000000003',
          outcome: 'accepted',
          recordedAt: '2026-08-27T08:05:10.000Z',
          evidenceSha256: 'c'.repeat(64),
        }),
      }),
      Object.freeze({
        rail: 'social_dm',
        connectionState: 'not_composed',
        inboundState: 'not_ready',
        outboundOrReplyState: 'not_supported',
        receiptState: 'none',
        caps: Object.freeze({
          daily: Object.freeze({ used: 0, limit: 0, remaining: 0 }),
          monthly: Object.freeze({ used: 0, limit: 0, remaining: 0 }),
        }),
        blockerCodes: Object.freeze(['LIVE_ADAPTER_NOT_COMPOSED']),
        latestReceipt: null,
      }),
    ]),
  }) as LiveChannelsSourceSnapshot;
}
