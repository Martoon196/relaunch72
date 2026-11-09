/**
 * The "your dashboard is ready" login email — a pure builder that turns a
 * provisioned account into a Postmark message. Transactional (Postmark, not
 * Brevo — see the email hard rule). The caller sends it with a real client.
 */

import { EmailError, type PostmarkMessage } from '../email/postmark.js';

export interface LoginEmailOpts {
  to: string;
  tenantName: string;
  setupUrl: string;
  /** Whether the initial draft pack was generated successfully. */
  generated: boolean;
  from?: string;
}

export function loginEmail(o: LoginEmailOpts): PostmarkMessage {
  if (!o.to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(o.to)) {
    throw new EmailError(`refusing to send: "${o.to}" is not a valid recipient address`);
  }
  const subject = 'Set up your Relaunch72 dashboard';
  const statusText = o.generated
    ? 'Your initial draft content cluster, simulated keyword research and paused ad drafts are ready for you to review.'
    : 'Your dashboard account is ready, but the initial draft pack could not be generated automatically and is not available yet. It needs to be retried before content appears.';
  const textBody =
    `Hi ${o.tenantName},\n\n` +
    `${statusText}\n\n` +
    `Choose your password and open your dashboard: ${o.setupUrl}\n\n` +
    `This private setup link expires in 24 hours and can only be used once. Nothing goes live without your say-so.\n\n` +
    `— The Relaunch72 team`;
  const esc = (s: string): string => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
  const htmlBody =
    `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1f2836;line-height:1.55;max-width:520px">` +
    `<p>Hi ${esc(o.tenantName)},</p>` +
    `<p>${esc(statusText)}</p>` +
    `<p style="margin:24px 0"><a href="${esc(o.setupUrl)}" style="background:#c9791a;color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-weight:600">Choose your password →</a></p>` +
    `<p style="font-size:13px;color:#8a97a9;margin-top:20px">This private setup link expires in 24 hours and can only be used once. Nothing goes live without your say-so.</p>` +
    `<p style="font-size:13px;color:#8a97a9">— The Relaunch72 team</p></div>`;
  return {
    from: o.from ?? 'Relaunch72 <hello@relaunch72.com>',
    to: o.to,
    subject,
    textBody,
    htmlBody,
    messageStream: 'outbound',
  };
}
