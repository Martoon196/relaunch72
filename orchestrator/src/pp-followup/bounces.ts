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
 * The lasting stop. Every PP follow-up email carries the contact point it was addressed to, so a bounce, spam report
 * or provider unsubscribe reported for it is written to the CRM with its TRUE reason (0153: hard_bounce and
 * spam_complaint stop all PP email to that point, recipient_unsubscribe stops PP marketing) and that address's open
 * runs stop. Email only. While the database still ends at 0152 the existing unsubscribe capability is used instead,
 * exactly as before (it labels every row an unsubscribe). An address known only from Postmark's list (no point in the
 * metadata) is refused by every send guard through the durable block ledger instead.
 */
export function ppEmailBounceEffects(unsubscriber: PpFollowupUnsubscriber): EmailBounceEffects {
  // Called only for an event that is final in itself (hard bounce, spam report, unsubscribe at Postmark), never for a
  // temporary soft-bounce block: the suppression row is permanent.
  return { onMarketingBlock: async ({ metadata, reason }) => {
    if (!metadata.point || !UUID.test(metadata.point)) return;
    if (reason !== 'hard_bounce' && reason !== 'spam_complaint' && reason !== 'unsubscribed') return;
    if (unsubscriber.blockEmail) await unsubscriber.blockEmail(metadata.point, reason === 'unsubscribed' ? 'unsubscribe' : reason);
    else await unsubscriber.unsubscribe(metadata.point);
  } };
}
