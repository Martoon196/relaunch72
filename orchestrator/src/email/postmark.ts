/**
 * Postmark transactional email — the "your pack is ready" delivery send and,
 * later, receipts. Structurally decoupled via PostmarkLike so the delivery
 * logic tests with a fake (no token, no network). The real client (node:https,
 * proxy-aware like makeStripe) lives in makePostmark; nothing here sends unless
 * a caller passes a real client and an explicit recipient.
 *
 * Transactional only (hard rule: Postmark for transactional, Brevo for marketing).
 */

import https from 'node:https';
import { HttpsProxyAgent } from 'https-proxy-agent';
import type { DeliveryEmail } from '../deliver/deliver.js';

export interface Attachment {
  name: string;
  contentBase64: string;
  contentType: string;
}

export interface PostmarkMessage {
  from: string;
  to: string;
  subject: string;
  textBody: string;
  htmlBody?: string;
  replyTo?: string;
  attachments?: Attachment[];
  /** Postmark stream; 'outbound' is the default transactional stream. */
  messageStream?: string;
}

export interface PostmarkResult {
  messageId: string;
  to: string;
  errorCode: number;
  message: string;
}

/** The slice of Postmark the sender touches — the real client satisfies it. */
export interface PostmarkLike {
  send(msg: PostmarkMessage): Promise<PostmarkResult>;
}

export class EmailError extends Error {}

/** Map a built delivery email + recipient into a Postmark message. Pure. */
export function deliveryMessage(
  email: DeliveryEmail,
  opts: { to: string; from?: string; replyTo?: string; attachments?: Attachment[] },
): PostmarkMessage {
  if (!opts.to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(opts.to)) {
    throw new EmailError(`refusing to send: "${opts.to}" is not a valid recipient address`);
  }
  const from = opts.from ?? 'Relaunch72 <hello@relaunch72.com>';
  return {
    from,
    to: opts.to,
    subject: email.subject,
    textBody: email.body,
    replyTo: opts.replyTo,
    attachments: opts.attachments,
    messageStream: 'outbound',
  };
}

/** Real Postmark client over node:https (proxy-aware). */
export function makePostmark(token: string): PostmarkLike {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const agent = proxy ? new HttpsProxyAgent(proxy) : undefined;
  return {
    send(msg: PostmarkMessage): Promise<PostmarkResult> {
      const payload = JSON.stringify({
        From: msg.from,
        To: msg.to,
        Subject: msg.subject,
        TextBody: msg.textBody,
        HtmlBody: msg.htmlBody,
        ReplyTo: msg.replyTo,
        MessageStream: msg.messageStream ?? 'outbound',
        Attachments: (msg.attachments ?? []).map((a) => ({ Name: a.name, Content: a.contentBase64, ContentType: a.contentType })),
      });
      return new Promise<PostmarkResult>((resolve, reject) => {
        const req = https.request(
          {
            method: 'POST',
            host: 'api.postmarkapp.com',
            path: '/email',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
              'X-Postmark-Server-Token': token,
              'Content-Length': Buffer.byteLength(payload),
            },
            agent,
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => {
              const raw = Buffer.concat(chunks).toString('utf8');
              let body: Record<string, unknown>;
              try { body = JSON.parse(raw) as Record<string, unknown>; }
              catch { return reject(new EmailError(`Postmark returned non-JSON (HTTP ${res.statusCode ?? '?'}): ${raw.slice(0, 200)}`)); }
              const code = typeof body.ErrorCode === 'number' ? body.ErrorCode : 0;
              if ((res.statusCode ?? 0) >= 400 || code !== 0) {
                return reject(new EmailError(`Postmark error ${code} (HTTP ${res.statusCode}): ${String(body.Message ?? raw)}`));
              }
              resolve({
                messageId: String(body.MessageID ?? ''),
                to: String(body.To ?? msg.to),
                errorCode: code,
                message: String(body.Message ?? 'OK'),
              });
            });
          },
        );
        req.on('error', reject);
        req.write(payload);
        req.end();
      });
    },
  };
}
