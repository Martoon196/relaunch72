/**
 * Deterministic, fictional Live Channels snapshot.
 *
 * Every identity, count, receipt and instant below is invented. The
 * presenter enforces that an illustrative fixture can never depict a
 * deliverable channel, and the view renders the dataset banner. Nothing
 * here was read from Mailgun, Ayrshare, Meta or any database.
 */

import {
  CUSTOMER_EMAIL_DAILY_HARD_CAP,
  CUSTOMER_EMAIL_LIVE_CONTRACT,
  CUSTOMER_EMAIL_MONTHLY_HARD_CAP,
} from '../customer-email-live/foundation.js';
import { OWNED_PUBLIC_SOCIAL_LIVE_CONTRACT } from '../public-social-outbound/owned-live-foundation.js';
import { META_WHATSAPP_LIVE_CONTRACT } from '../whatsapp-live/foundation.js';
import type { PortalLiveChannelsSnapshot } from './live-channels-service.js';

export const PROPERTY_PREDATOR_LIVE_CHANNELS_AS_OF = '2026-08-27T12:00:00.000Z';

const WORKSPACE_ID = 'fa100000-0000-4000-8000-000000000001';

export function createPropertyPredatorLiveChannelsFixture(): PortalLiveChannelsSnapshot {
  return Object.freeze({
    workspace: Object.freeze({
      workspaceId: WORKSPACE_ID,
      workspaceName: 'Property Predator Growth HQ',
      snapshotAt: PROPERTY_PREDATOR_LIVE_CHANNELS_AS_OF,
    }),
    dataset: 'illustrative_fixture',
    channels: Object.freeze([
      Object.freeze({
        channel: 'customer_email_mailgun',
        identity: Object.freeze({
          providerId: 'mailgun_eu',
          providerLabel: 'Mailgun EU',
          accountLabel: 'mg.propertypredator.com',
          connectionLabel: 'Connection fa20…0001 · live',
          environment: 'live',
          connectionStatus: 'active',
          contract: CUSTOMER_EMAIL_LIVE_CONTRACT,
        }),
        switches: Object.freeze({
          mode: 'customer_live',
          providerEffectsEnabled: true,
          deliveryEnabled: true,
          emergencyPaused: true,
        }),
        dispatch: Object.freeze({
          workerComposed: true,
          observedAt: '2026-08-27T11:58:00.000Z',
          queuedCount: 1,
          inFlightCount: 0,
          awaitingProofCount: 1,
          needsAttentionCount: 0,
          succeededTodayCount: 2,
          failedTodayCount: 0,
        }),
        caps: Object.freeze({
          dailyCap: CUSTOMER_EMAIL_DAILY_HARD_CAP,
          monthlyCap: CUSTOMER_EMAIL_MONTHLY_HARD_CAP,
          usedToday: 4,
          usedThisMonth: 14,
          maxRecipientsPerJob: 1,
          maxOperationsPerCycle: 1,
        }),
        approvals: Object.freeze({
          pendingCount: 1,
          oldestPendingAt: '2026-08-26T16:40:00.000Z',
        }),
        permission: Object.freeze({
          state: 'granted',
          detail: 'Latest consent event is granted for the single pilot recipient scope and the suppression list is clear.',
          checkedAt: '2026-08-27T11:55:00.000Z',
        }),
        latestReceipt: Object.freeze({
          eventKind: 'delivered',
          safeCode: 'mailgun_signed_customer_receipt',
          occurredAt: '2026-08-27T09:14:00.000Z',
          recordedAt: '2026-08-27T09:14:30.000Z',
        }),
        blockers: Object.freeze([]),
      }),
      Object.freeze({
        channel: 'owned_public_social',
        identity: Object.freeze({
          providerId: 'ayrshare',
          providerLabel: 'Ayrshare',
          accountLabel: 'Owned X profile · @predator (fictional)',
          connectionLabel: 'Connection fa20…0003 · live',
          environment: 'live',
          connectionStatus: 'active',
          contract: OWNED_PUBLIC_SOCIAL_LIVE_CONTRACT,
        }),
        switches: Object.freeze({
          mode: 'owned_profile_live',
          providerEffectsEnabled: false,
          deliveryEnabled: null,
          emergencyPaused: true,
        }),
        dispatch: Object.freeze({
          workerComposed: true,
          observedAt: '2026-08-27T11:57:00.000Z',
          queuedCount: 1,
          inFlightCount: 0,
          awaitingProofCount: 0,
          needsAttentionCount: 1,
          succeededTodayCount: 0,
          failedTodayCount: 0,
        }),
        caps: Object.freeze({
          dailyCap: 1,
          monthlyCap: 3,
          usedToday: 1,
          usedThisMonth: 2,
          maxRecipientsPerJob: 1,
          maxOperationsPerCycle: 1,
        }),
        approvals: Object.freeze({
          pendingCount: 2,
          oldestPendingAt: '2026-08-25T10:05:00.000Z',
        }),
        permission: Object.freeze({
          state: 'granted',
          detail: 'The owned X profile authority is recorded with read-write permission and carries no revocation.',
          checkedAt: '2026-08-27T11:55:00.000Z',
        }),
        latestReceipt: Object.freeze({
          eventKind: 'outcome_unknown',
          safeCode: 'ayrshare_transport_outcome_unknown',
          occurredAt: '2026-08-26T18:20:00.000Z',
          recordedAt: '2026-08-26T18:20:30.000Z',
        }),
        blockers: Object.freeze([
          Object.freeze({
            code: 'SOURCE_ATTESTATION_EXPIRED',
            message: 'The source attestation behind the approved post expired, so the queued publish cannot be re-authorised until it is refreshed.',
          }),
        ]),
      }),
      Object.freeze({
        channel: 'meta_whatsapp',
        identity: Object.freeze({
          providerId: 'meta_whatsapp_cloud',
          providerLabel: 'Meta WhatsApp Cloud',
          accountLabel: 'WABA +44 7700 900123 (fictional)',
          connectionLabel: 'Connection fa20…0002 · live',
          environment: 'live',
          connectionStatus: 'active',
          contract: META_WHATSAPP_LIVE_CONTRACT,
        }),
        switches: Object.freeze({
          mode: 'disabled',
          providerEffectsEnabled: false,
          deliveryEnabled: null,
          emergencyPaused: true,
        }),
        dispatch: Object.freeze({
          workerComposed: false,
          observedAt: null,
          queuedCount: 0,
          inFlightCount: 0,
          awaitingProofCount: 0,
          needsAttentionCount: 0,
          succeededTodayCount: 0,
          failedTodayCount: 0,
        }),
        caps: Object.freeze({
          dailyCap: 1,
          monthlyCap: 3,
          usedToday: 0,
          usedThisMonth: 0,
          maxRecipientsPerJob: 1,
          maxOperationsPerCycle: 1,
        }),
        approvals: Object.freeze({
          pendingCount: 0,
          oldestPendingAt: null,
        }),
        permission: Object.freeze({
          state: 'missing',
          detail: 'No granted consent evidence has been recorded yet for the WhatsApp pilot recipient scope.',
          checkedAt: null,
        }),
        latestReceipt: null,
        blockers: Object.freeze([]),
      }),
    ]),
    receipts: Object.freeze([
      Object.freeze({
        channel: 'customer_email_mailgun',
        eventKind: 'delivered',
        safeCode: 'mailgun_signed_customer_receipt',
        occurredAt: '2026-08-27T09:14:00.000Z',
        recordedAt: '2026-08-27T09:14:30.000Z',
      }),
      Object.freeze({
        channel: 'customer_email_mailgun',
        eventKind: 'dispatch_accepted',
        safeCode: 'mailgun_customer_accepted',
        occurredAt: '2026-08-27T09:02:00.000Z',
        recordedAt: '2026-08-27T09:02:15.000Z',
      }),
      Object.freeze({
        channel: 'customer_email_mailgun',
        eventKind: 'opened',
        safeCode: 'mailgun_signed_customer_receipt',
        occurredAt: '2026-08-26T19:05:00.000Z',
        recordedAt: '2026-08-26T19:05:20.000Z',
      }),
      Object.freeze({
        channel: 'owned_public_social',
        eventKind: 'outcome_unknown',
        safeCode: 'ayrshare_transport_outcome_unknown',
        occurredAt: '2026-08-26T18:20:00.000Z',
        recordedAt: '2026-08-26T18:20:30.000Z',
      }),
      Object.freeze({
        channel: 'customer_email_mailgun',
        eventKind: 'delivered',
        safeCode: 'mailgun_signed_customer_receipt',
        occurredAt: '2026-08-26T17:44:00.000Z',
        recordedAt: '2026-08-26T17:44:25.000Z',
      }),
      Object.freeze({
        channel: 'owned_public_social',
        eventKind: 'published',
        safeCode: 'ayrshare_published',
        occurredAt: '2026-08-25T11:30:00.000Z',
        recordedAt: '2026-08-25T11:30:40.000Z',
      }),
    ]),
    handoff: Object.freeze({
      conversionInboxComposed: true,
      lead360Composed: true,
      whatsappInboundProjection: null,
      inboundLastDayCount: null,
    }),
  });
}
