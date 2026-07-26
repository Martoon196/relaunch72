/**
 * The "your dashboard is ready" login email — a pure builder that turns a
 * provisioned account into a Postmark message. Transactional (Postmark, not
 * Brevo — see the email hard rule). The caller sends it with a real client.
 */

import { EmailError, type PostmarkMessage } from '../email/postmark.js';

export interface LoginEmailOpts {
  to: string;
  tenantName: string;
  loginEmail: string;
  password: string;
  portalUrl: string;
  from?: string;
}

export function loginEmail(o: LoginEmailOpts): PostmarkMessage {
  if (!o.to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(o.to)) {
    throw new EmailError(`refusing to send: "${o.to}" is not a valid recipient address`);
  }
  const subject = 'Your Relaunch72 dashboard is ready';
  const textBody =
    `Hi ${o.tenantName},\n\n` +
    `Your marketing dashboard is live. Your AI marketing manager has already built your first content — a full content cluster, keyword research and ad drafts, all grounded in your business and ready for you to review.\n\n` +
    `Log in here: ${o.portalUrl}\n` +
    `Email: ${o.loginEmail}\n` +
    `Temporary password: ${o.password}\n\n` +
    `Change your password after you sign in. Nothing goes live without your say-so.\n\n` +
    `— The Relaunch72 team`;
  const esc = (s: string): string => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
  const htmlBody =
    `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1f2836;line-height:1.55;max-width:520px">` +
    `<p>Hi ${esc(o.tenantName)},</p>` +
    `<p>Your marketing dashboard is live. Your AI marketing manager has already built your first content — a full content cluster, keyword research and ad drafts, all grounded in your business and ready to review.</p>` +
    `<p style="margin:24px 0"><a href="${esc(o.portalUrl)}" style="background:#c9791a;color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-weight:600">Open your dashboard →</a></p>` +
    `<table style="font-size:14px;color:#5c6a7e"><tr><td>Email</td><td style="padding-left:14px;color:#1f2836"><b>${esc(o.loginEmail)}</b></td></tr>` +
    `<tr><td>Temporary password</td><td style="padding-left:14px;color:#1f2836;font-family:ui-monospace,Menlo,monospace"><b>${esc(o.password)}</b></td></tr></table>` +
    `<p style="font-size:13px;color:#8a97a9;margin-top:20px">Change your password after you sign in. Nothing goes live without your say-so.</p>` +
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
