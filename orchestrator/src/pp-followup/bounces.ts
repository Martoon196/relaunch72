/**
 * Property Predator's side of the shared bounce handler (orchestrator/src/email-bounces).
 * Configuration only: the source exists while PP follow-up delivery is switched on and fully
 * configured, so with PP_MARKETING_MODE off there is no PP webhook, no reads and nothing refused.
 */
import type { EmailBounceSourceDefault } from '../email-bounces/config.js';
import type { EmailBounceEffects } from '../email-bounces/service.js';
import type { PpMarketingConfig } from './config.js';
import { PP_FOLLOWUP_WORKSPACE_ID, type PpFollowupUnsubscriber } from './repository.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** Webhook: POST /api/provider-webhooks/postmark/pp, Basic user "pp", password PP_POSTMARK_WEBHOOK_SECRET. */
export function ppEmailBounceSourceDefault(config: PpMarketingConfig | null | undefined): EmailBounceSourceDefault | null {
  return config ? { key: 'pp', workspaceId: PP_FOLLOWUP_WORKSPACE_ID, tokenEnv: 'PP_POSTMARK_SERVER_TOKEN', webhookSecretEnv: 'PP_POSTMARK_WEBHOOK_SECRET',
    marketingStreams: [config.stream], serviceStreams: [] } : null;
}

/**
 * The lasting stop, with no new SQL: every PP follow-up email carries the contact point it was addressed to, so a
 * bounce or complaint reported for it records the existing email suppression for both PP marketing purposes and
 * stops that address's open runs. Email only. The existing capability labels the row as an unsubscribe; recording
 * the true reason, and stopping an address known only from Postmark's list, needs an address-keyed function (0153).
 */
export function ppEmailBounceEffects(unsubscriber: PpFollowupUnsubscriber): EmailBounceEffects {
  // Called only for an event that is final in itself (hard bounce, spam report, unsubscribe at Postmark), never for a
  // temporary soft-bounce block: the suppression row is permanent and says "recipient unsubscribed".
  return { onMarketingBlock: async ({ metadata, reason }) => {
    if ((reason === 'hard_bounce' || reason === 'spam_complaint' || reason === 'unsubscribed') && metadata.point && UUID.test(metadata.point)) await unsubscriber.unsubscribe(metadata.point);
  } };
}
