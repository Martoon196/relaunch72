import { normalizePpEmail, type PpMarketingConfig } from './config.js';
import type { PpFollowupRendered } from './content.js';

export interface PpRenderedSend { readonly id: string; readonly email: string; readonly tag: string; readonly rendered: PpFollowupRendered }
export interface PpFollowupSender { sendRendered(item: PpRenderedSend): Promise<string> }

/**
 * Postmark broadcast-stream sender for PP follow-ups. Resolves only with Postmark's MessageID after an
 * ErrorCode 0 acceptance; every other outcome throws and is treated by the dispatcher as not sent.
 */
export function createPpPostmarkSender(config: PpMarketingConfig, fetcher: typeof fetch = fetch): PpFollowupSender {
  return {
    async sendRendered(item) {
      const to = normalizePpEmail(item.email);
      if (!to) throw new Error('Invalid recipient');
      // Test mode is checked again at the final recipient, after the database claim filter.
      if (config.testRecipients && !config.testRecipients.includes(to)) throw new Error('Recipient is outside the test list');
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
          Metadata: { send: item.id },
        }),
      });
      // Provider bodies can echo recipients. Only the message id is read on success.
      if (!response.ok) { await response.body?.cancel(); throw new Error('PP follow-up delivery was not accepted'); }
      const body = await response.json() as { MessageID?: unknown; ErrorCode?: unknown };
      if (body.ErrorCode !== 0 || typeof body.MessageID !== 'string' || body.MessageID.length < 1 || body.MessageID.length > 200) {
        throw new Error('PP follow-up delivery was not accepted');
      }
      return body.MessageID;
    },
  };
}
