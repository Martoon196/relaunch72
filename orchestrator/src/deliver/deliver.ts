/**
 * Delivery packaging (LS-19 → delivery). Pure builders for the customer-facing
 * delivery email and pack note — no IO, no sending. The send mechanism is a
 * founder choice (download / Gmail draft / ESP); these artifacts feed all three.
 *
 * Gate: delivery only ever runs on an APPROVED pack (signoff.json decision =
 * 'approved'). Nothing customer-facing is produced for an un-signed run.
 */

import { deliverableName } from '../lexicon.js';

export interface DeliveryContext {
  business: string;
  /** Stage IDs present in the approved pack, in order (e.g. ['S1'..'S9']). */
  stages: string[];
  complianceLine: string;
  /** Customer first name if known; falls back to a warm neutral greeting. */
  firstName?: string;
}

export interface DeliveryEmail {
  subject: string;
  body: string;
}

/** Warm, honest, compliant delivery email. No hype, no outcome promises. */
export function buildDeliveryEmail(ctx: DeliveryContext): DeliveryEmail {
  const hi = ctx.firstName ? `Hi ${ctx.firstName},` : 'Hi,';
  const items = ctx.stages.map((s) => `  • ${deliverableName(s)}`).join('\n');
  const subject = `Your Relaunch72 pack for ${ctx.business} is ready`;
  const body = [
    hi,
    '',
    `Your relaunch is done. Everything below was built from the answers you gave us — read start to finish, it should feel like we actually listened.`,
    '',
    `What's in the pack:`,
    items,
    '',
    `Where to start: open the one-page plan first for the shape of it, then the message and offer, then the website, email and social packs you can put to work straight away.`,
    '',
    `A word of honesty: this is marketing material, not a guarantee. ${ctx.complianceLine.replace(/^This document is/, "It's")}`,
    '',
    `Read it, make it yours, and reply to this email if anything doesn't sound like you — we'd rather fix it than have you publish something that isn't right.`,
    '',
    `— The Relaunch72 team`,
  ].join('\n');
  return { subject, body };
}

/** RFC-822 .eml the founder can open and send from any client (Gmail included). */
export function buildEml(email: DeliveryEmail, opts: { to?: string; from?: string; date: string }): string {
  const headers = [
    `From: ${opts.from ?? 'Relaunch72 <hello@relaunch72.com>'}`,
    `To: ${opts.to ?? '{{customer_email}}'}`,
    `Subject: ${email.subject}`,
    `Date: ${opts.date}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="utf-8"',
    'X-Relaunch72: delivery-draft',
  ];
  return `${headers.join('\r\n')}\r\n\r\n${email.body.replace(/\n/g, '\r\n')}\r\n`;
}

/** One-line manifest of what to attach, for the founder / a later auto-sender. */
export function attachmentList(runDocsDir: string, stages: string[]): string[] {
  return ['index.pdf', ...stages.map((s) => `${s.toLowerCase()}.pdf`)].map((f) => `${runDocsDir}/${f}`);
}
