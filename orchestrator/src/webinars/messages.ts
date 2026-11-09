/**
 * Event-service messages (confirmation, reminders, reschedule/cancellation notices,
 * replay availability, access links). These are requested by the act of
 * registering; they never carry marketing. Each brand sends only from its own
 * configured sender: a brand without one is reported as blocked, never routed
 * through another brand's identity.
 */

import { accentPalette } from './colour.js';
import type { WebinarConfig, WebinarSender } from './config.js';
import { formatInZone } from './schedule.js';
import type { WebinarBrand, WebinarEvent } from './types.js';

export type MessagePurpose = 'confirmation' | 'reminder' | 'reschedule' | 'cancellation' | 'replay_available' | 'access_link';

export interface ComposedMessage {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

export interface MessageContext {
  readonly event: WebinarEvent;
  readonly brand: WebinarBrand;
  readonly recipientName: string;
  readonly roomUrl: string;
  readonly calendarUrl: string | null;
  /** Minutes before the start, for reminders. */
  readonly reminderOffsetMinutes: number | null;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function when(e: WebinarEvent): string {
  if (e.kind === 'on_demand' || !e.startsAt) return 'available to watch now';
  return formatInZone(e.startsAt, e.timezone);
}

function offsetPhrase(minutes: number): string {
  if (minutes % 1440 === 0) return minutes === 1440 ? 'tomorrow' : `in ${minutes / 1440} days`;
  if (minutes % 60 === 0) return minutes === 60 ? 'in one hour' : `in ${minutes / 60} hours`;
  return `in ${minutes} minutes`;
}

export function composeMessage(purpose: MessagePurpose, c: MessageContext): ComposedMessage {
  const brand = c.brand.productName ?? c.brand.workspaceName;
  const e = c.event;
  const first = c.recipientName.split(/\s+/)[0] ?? c.recipientName;
  const kind = e.kind === 'scheduled_recording' ? 'This is a recorded presentation shown at a scheduled time.' : '';
  const lines: string[] = [];
  let subject = '';
  let button = 'Open the webinar room';
  switch (purpose) {
    case 'confirmation':
      subject = `You're registered: ${e.title}`;
      lines.push(`You're registered for ${e.title}.`, e.kind === 'on_demand' ? 'You can watch it now.' : `It starts ${when(e)}.`);
      break;
    case 'reminder':
      subject = `Starting ${offsetPhrase(c.reminderOffsetMinutes ?? 60)}: ${e.title}`;
      lines.push(`${e.title} starts ${offsetPhrase(c.reminderOffsetMinutes ?? 60)} (${when(e)}).`);
      break;
    case 'reschedule':
      subject = `New time: ${e.title}`;
      lines.push(`${e.title} has moved. The new time is ${when(e)}.`, 'Your registration and link still work.');
      break;
    case 'cancellation':
      subject = `Cancelled: ${e.title}`;
      lines.push(`We're sorry — ${e.title} has been cancelled.`);
      button = '';
      break;
    case 'replay_available':
      subject = `Replay ready: ${e.title}`;
      lines.push(`The replay of ${e.title} is ready to watch.`);
      if (e.settings.replay.availableDays) lines.push(`It is available for ${e.settings.replay.availableDays} days.`);
      button = 'Watch the replay';
      break;
    case 'access_link':
      subject = `Your link: ${e.title}`;
      lines.push(`Here is your personal link for ${e.title}. It is the same link we sent when you registered, so keep it private.`);
      break;
  }
  if (kind) lines.push(kind);
  const footer = `You're receiving this because you registered for ${e.title} with ${brand}. This link is personal to you; please don't share it.`;
  const text = [`Hi ${first},`, '', ...lines, '', ...(button ? [`${button}: ${c.roomUrl}`] : []),
    ...(c.calendarUrl && purpose !== 'cancellation' && e.kind !== 'on_demand' ? [`Add to calendar: ${c.calendarUrl}`] : []), '', footer, ...(c.brand.supportEmail ? [`Questions? ${c.brand.supportEmail}`] : [])].join('\n');
  const palette = accentPalette(e.settings.accentColor ?? c.brand.accentColor);
  const accent = palette.accent;
  const html = `<!doctype html><html><body style="margin:0;background:#f5f6f8;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#111827">
<div style="max-width:560px;margin:0 auto;padding:28px 20px"><p style="font-weight:700;color:${esc(palette.textOnLight)};margin:0 0 16px">${esc(brand)}</p>
<div style="background:#fff;border-radius:12px;padding:24px;border:1px solid #e5e7eb"><p>Hi ${esc(first)},</p>${lines.map((l) => `<p>${esc(l)}</p>`).join('')}
${button ? `<p style="margin:24px 0"><a href="${esc(c.roomUrl)}" style="background:${esc(accent)};color:${esc(palette.onAccent)};text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600;display:inline-block">${esc(button)}</a></p>` : ''}
${c.calendarUrl && purpose !== 'cancellation' && e.kind !== 'on_demand' ? `<p><a href="${esc(c.calendarUrl)}" style="color:${esc(palette.textOnLight)}">Add to calendar (.ics)</a></p>` : ''}</div>
<p style="font-size:12px;color:#6b7280;margin-top:16px">${esc(footer)}${c.brand.supportEmail ? ` Questions? ${esc(c.brand.supportEmail)}` : ''}</p></div></body></html>`;
  return { subject: subject.slice(0, 200), text, html };
}

export type DeliveryDecision =
  | { readonly kind: 'send'; readonly sender: WebinarSender }
  | { readonly kind: 'hold'; readonly reason: string }
  | { readonly kind: 'block'; readonly reason: string };

/** Off holds everything; test sends only to listed recipients; a brand without a sender waits. */
export function deliveryDecision(config: WebinarConfig, workspaceId: string, recipient: string): DeliveryDecision {
  if (config.emailMode === 'off') return { kind: 'hold', reason: 'Webinar email is off (WEBINAR_EMAIL_MODE).' };
  const sender = config.senders.get(workspaceId.toLowerCase());
  if (!sender) return { kind: 'hold', reason: 'No sender is configured for this brand (WEBINAR_EMAIL_SENDERS).' };
  if (config.emailMode === 'test' && !config.emailTestRecipients.has(recipient.toLowerCase())) {
    return { kind: 'block', reason: 'Test mode: recipient is not on WEBINAR_EMAIL_TEST_RECIPIENTS.' };
  }
  return { kind: 'send', sender };
}

export interface MailResult {
  readonly outcome: 'sent' | 'rejected' | 'retry' | 'unknown';
  readonly messageId?: string;
  readonly detail?: string;
}

export interface WebinarMailer {
  send(sender: WebinarSender, to: string, message: ComposedMessage, metadata: Record<string, string>): Promise<MailResult>;
}

/** Postmark transactional send. A timeout is 'unknown' — the caller never resends it blindly. */
export function createPostmarkMailer(fetcher: typeof fetch = fetch): WebinarMailer {
  return {
    async send(sender, to, message, metadata) {
      let res: Response;
      try {
        res = await fetcher('https://api.postmarkapp.com/email', {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json', 'x-postmark-server-token': sender.token },
          body: JSON.stringify({
            From: sender.from, To: to, Subject: message.subject, TextBody: message.text, HtmlBody: message.html,
            MessageStream: sender.messageStream, ...(sender.replyTo ? { ReplyTo: sender.replyTo } : {}),
            Tag: 'webinar', Metadata: metadata, TrackOpens: false, TrackLinks: 'None',
          }),
          signal: AbortSignal.timeout(15_000),
        });
      } catch {
        return { outcome: 'unknown', detail: 'Postmark did not answer; not resent automatically.' };
      }
      const json = (await res.json().catch(() => ({}))) as { MessageID?: string; ErrorCode?: number; Message?: string };
      if (res.ok && json.ErrorCode === 0 && json.MessageID) return { outcome: 'sent', messageId: json.MessageID };
      const detail = `Postmark ${res.status}${json.ErrorCode ? ` code ${json.ErrorCode}` : ''}: ${(json.Message ?? '').slice(0, 200)}`;
      // 406: inactive recipient; 422 with a recipient/sender error: permanent.
      if (res.status === 406 || res.status === 422 || res.status === 401) return { outcome: 'rejected', detail };
      return { outcome: 'retry', detail };
    },
  };
}

export function icsCalendar(e: WebinarEvent, roomUrl: string, brandName: string): string {
  if (!e.startsAt) return '';
  const stamp = (iso: string) => iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const end = new Date(Date.parse(e.startsAt) + e.durationMinutes * 60_000).toISOString();
  const fold = (s: string) => s.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/[,;]/g, (m) => `\\${m}`);
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Relaunch72//Webinars//EN', 'METHOD:PUBLISH', 'BEGIN:VEVENT',
    `UID:${e.id}-v${e.scheduleVersion}@webinars`, `SEQUENCE:${e.scheduleVersion}`, `DTSTAMP:${stamp(new Date().toISOString())}`,
    `DTSTART:${stamp(e.startsAt)}`, `DTEND:${stamp(end)}`, `SUMMARY:${fold(e.title)}`,
    `DESCRIPTION:${fold(`${brandName}\n${e.kind === 'scheduled_recording' ? 'Recorded presentation shown at a scheduled time.\n' : ''}Join: ${roomUrl}`)}`,
    `URL:${roomUrl}`, `LOCATION:${fold(roomUrl)}`, ...(e.status === 'cancelled' ? ['STATUS:CANCELLED'] : []),
    'BEGIN:VALARM', 'TRIGGER:-PT15M', 'ACTION:DISPLAY', `DESCRIPTION:${fold(e.title)}`, 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n') + '\r\n';
}
