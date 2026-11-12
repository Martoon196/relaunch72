import { normalizePpEmail, type PpMarketingConfig } from './config.js';
import type { PpFollowupRendered } from './content.js';
import type { EmailSendGuard } from '../email-bounces/policy.js';

/** contactPointId travels with the message so a later bounce or complaint can stop that exact address for good. */
export interface PpRenderedSend { readonly id: string; readonly email: string; readonly tag: string; readonly rendered: PpFollowupRendered; readonly contactPointId?: string }
/** Refuses addresses that bounced, complained or unsubscribed at Postmark, for one workspace, before any provider call. */
export interface PpRecipientGuard { readonly guard: EmailSendGuard; readonly workspaceId: string }
const POINT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export interface PpFollowupSender { sendRendered(item: PpRenderedSend): Promise<string> }

/**
 * A definite non-send: the email certainly did not go out, so the dispatcher records a plain failure instead of
 * holding the run as "we are not sure". The scope says what was refused:
 *  - 'sender'    nothing is wrong with this message (bad server token, unconfirmed sender, rate limit, test list);
 *                the attempt is handed back and tried again later;
 *  - 'message'   Postmark refused this message; it is retried a few times, then the run fails;
 *  - 'recipient' this address can never be sent to (invalid, or inactive at Postmark); the run fails at once.
 * Any other error from a sender (timeout, network error, 5xx, unreadable answer) stays an unknown outcome.
 */
export class PpNotSentError extends Error {
  constructor(readonly scope: 'sender' | 'message' | 'recipient', message = 'PP follow-up delivery was not accepted') { super(message); this.name = 'PpNotSentError'; }
}

/** Postmark API error codes that describe the account or sender, not this message: bad token, sender signature missing or unconfirmed, sending not allowed, account pending. */
const SENDER_ERROR_CODES: ReadonlySet<number> = new Set([10, 400, 401, 405, 412, 413]);
/** Postmark 406: the recipient is inactive (hard bounce, spam complaint or a Postmark-side unsubscribe). */
const RECIPIENT_ERROR_CODES: ReadonlySet<number> = new Set([406]);
const scopeOf = (code: unknown): 'sender' | 'message' | 'recipient' =>
  typeof code === 'number' && SENDER_ERROR_CODES.has(code) ? 'sender' : typeof code === 'number' && RECIPIENT_ERROR_CODES.has(code) ? 'recipient' : 'message';

/**
 * Postmark broadcast-stream sender for PP follow-ups. Resolves only with Postmark's MessageID after an
 * ErrorCode 0 acceptance. A definite refusal (HTTP 4xx, or an explicit non-zero ErrorCode) throws
 * PpNotSentError; everything uncertain throws a plain error and is treated by the dispatcher as unknown.
 */
export function createPpPostmarkSender(config: PpMarketingConfig, fetcher: typeof fetch = fetch, recipients?: PpRecipientGuard): PpFollowupSender {
  return {
    async sendRendered(item) {
      const to = normalizePpEmail(item.email);
      if (!to) throw new PpNotSentError('recipient', 'Invalid recipient');
      // Test mode is checked again at the final recipient, after the database claim filter.
      if (config.testRecipients && !config.testRecipients.includes(to)) throw new PpNotSentError('sender', 'Recipient is outside the test list');
      // Last check before the provider. The dispatcher already refuses these before a proof exists; a block that
      // arrived in between is still a definite non-send for an address that can never be sent to.
      if (recipients) {
        await recipients.guard.whenReady();
        if (recipients.guard.decide(recipients.workspaceId, to, 'marketing').blocked) throw new PpNotSentError('recipient', 'Recipient is blocked after a bounce, complaint or unsubscribe');
      }
      const response = await fetcher('https://api.postmarkapp.com/email', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: { 'content-type': 'application/json', accept: 'application/json', 'X-Postmark-Server-Token': config.token },
        body: JSON.stringify({
          From: `${config.fromName} <${config.from}>`, To: to, ReplyTo: config.replyTo, Subject: item.rendered.subject,
          HtmlBody: item.rendered.html, TextBody: item.rendered.text, MessageStream: config.stream, Tag: item.tag,
          TrackOpens: false, TrackLinks: 'None',
          Headers: [
            { Name: 'List-Unsubscribe', Value: `<${item.rendered.unsubscribe}>` },
            { Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' },
          ],
          Metadata: { send: item.id, ...(item.contactPointId && POINT_ID.test(item.contactPointId) ? { point: item.contactPointId } : {}) },
        }),
      });
      // Provider bodies can echo recipients. Only the numeric error code and, on success, the message id are read.
      if (!response.ok) {
        const definite = response.status >= 400 && response.status < 500 && response.status !== 408;
        let code: unknown;
        if (definite) { try { code = (await response.json() as { ErrorCode?: unknown })?.ErrorCode; } catch { code = undefined; } }
        else await response.body?.cancel().catch(() => undefined);
        // 401/403: the server token was refused. 429: rate limit. Neither says anything about this message.
        if (definite) throw new PpNotSentError([401, 403, 429].includes(response.status) ? 'sender' : scopeOf(code));
        throw new Error('PP follow-up delivery outcome is unknown');
      }
      let body: { MessageID?: unknown; ErrorCode?: unknown };
      try { body = await response.json() as { MessageID?: unknown; ErrorCode?: unknown }; }
      catch { throw new Error('PP follow-up delivery outcome is unknown'); }
      if (typeof body?.ErrorCode === 'number' && body.ErrorCode !== 0) throw new PpNotSentError(scopeOf(body.ErrorCode));
      if (body?.ErrorCode !== 0 || typeof body.MessageID !== 'string' || body.MessageID.length < 1 || body.MessageID.length > 200) {
        throw new Error('PP follow-up delivery outcome is unknown');
      }
      return body.MessageID;
    },
  };
}
