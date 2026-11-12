import { normalizeMhpEmail } from './auth-service.js';
import { MHP_SITE_ORIGIN, mhpApplicationConfig, mhpUnsubscribeUrl, type MhpApplicationRecord, type MhpClaimedSend, type MhpTemplateKey, type PgMhpGrowthService } from './growth-service.js';
import { MHP_MARKETING_TEMPLATES } from './marketing-templates.js';
import { dispatchMhpOwnerEmails, type MhpOwnerEmailDispatch } from './owner-email-dispatch.js';
import { dispatchMhpSequenceEmails, type MhpSequenceDispatch } from './followup-sequence-dispatch.js';
import type { FollowupEntrySweepResult } from '../followup-sequences/entry.js';
import { EmailRecipientBlockedError, type EmailSendGuard } from '../email-bounces/policy.js';

/**
 * Sends the queued sign-up emails through a Postmark broadcast stream.
 * MHP_MARKETING_MODE: off (default, nothing is sent and the queue waits),
 * test (only addresses in MHP_MARKETING_TEST_TO receive anything), live.
 */
export type MhpMarketingMode = 'off' | 'test' | 'live';
export interface MhpMarketingConfig {
  mode: MhpMarketingMode; token: string; from: string; replyTo: string; stream: string; transactionalStream: string; notifyTo: string; bookingUrl: string | null; testRecipients: readonly string[] | null;
}

export function mhpMarketingConfig(env: NodeJS.ProcessEnv): MhpMarketingConfig | null {
  const mode = (env.MHP_MARKETING_MODE?.trim() || 'off') as MhpMarketingMode;
  if (!['off', 'test', 'live'].includes(mode)) throw new Error('MHP_MARKETING_MODE must be off, test or live');
  if (mode === 'off') return null;
  const token = env.MHP_POSTMARK_SERVER_TOKEN?.trim() ?? '';
  const from = normalizeMhpEmail(env.MHP_MARKETING_FROM ?? '');
  const replyTo = normalizeMhpEmail(env.MHP_MARKETING_REPLY_TO ?? 'martin@propinvestuk.co.uk');
  const stream = env.MHP_POSTMARK_BROADCAST_STREAM?.trim() || 'broadcast';
  const transactionalStream = env.MHP_POSTMARK_TRANSACTIONAL_STREAM?.trim() || 'outbound';
  if (!token || !from || !replyTo || !/^[a-z0-9-]{1,60}$/.test(stream) || !/^[a-z0-9-]{1,60}$/.test(transactionalStream)) throw new Error('MHP marketing email is not fully configured');
  const { notifyTo, bookingUrl } = mhpApplicationConfig(env);
  let testRecipients: string[] | null = null;
  if (mode === 'test') {
    testRecipients = (env.MHP_MARKETING_TEST_TO ?? '').split(',').map(value => normalizeMhpEmail(value)).filter((value): value is string => Boolean(value));
    if (testRecipients.length < 1 || testRecipients.length > 20) throw new Error('MHP_MARKETING_TEST_TO needs one to twenty addresses in test mode');
  }
  return Object.freeze({ mode, token, from, replyTo, stream, transactionalStream, notifyTo, bookingUrl, testRecipients });
}

const escape = (value: string): string => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const P = 'margin:0 0 18px;font-family:Inter, Arial, Helvetica, sans-serif;font-size:16px;line-height:1.7;color:#111511;';
const BUTTON = 'display:inline-block;background-color:#E8A33D;color:#111511;font-family:Inter, Arial, Helvetica, sans-serif;font-size:16px;font-weight:700;line-height:1;padding:16px 24px;border-radius:8px;text-decoration:none;';
const BOOKING_FALLBACK = "I'll email you within one working day with a time for your call.";

function applicationRows(application: MhpApplicationRecord): [string, string][] {
  return [
    ['Name', application.name], ['Email', application.email], ['Phone', application.phone ?? 'Not given'], ['Town or area', application.location],
    ['Experience', application.experience], ['Door', application.door], ['Hours a week', application.hours], ['90-day objective', application.objective],
    ['Biggest obstacle', application.obstacle], ['Support wanted', application.support], ['Happy to discuss on a call', application.discuss ? 'Yes' : 'No'],
    ['Marketing emails', application.marketingConsent ? 'Yes' : 'No'], ['Came from', application.source],
    ['Received', new Date(application.createdAt).toLocaleString('en-GB', { timeZone: 'Europe/London', dateStyle: 'medium', timeStyle: 'short' }) + ' UK time'],
  ];
}

export interface MhpRenderOptions { bookingUrl?: string | null }

export function renderMhpMarketingEmail(send: Pick<MhpClaimedSend, 'template' | 'firstName' | 'context' | 'prospectId'> & Partial<Pick<MhpClaimedSend, 'application'>>,
  unsubscribeSecret: string, options: MhpRenderOptions = {}) {
  const template = MHP_MARKETING_TEMPLATES[send.template as MhpTemplateKey];
  if (!template) throw new Error('Unknown MHP marketing template');
  // emailPurpose is supplied exclusively by the restricted queue claim, not public form context.
  const service = send.context.emailPurpose === 'webinar_service';
  const stream = service ? 'outbound' : template.stream ?? 'broadcast';
  let templateHtml = template.html, templateText = template.text;
  if (service && send.template === 'webinar_confirm') {
    const teaser = "Near the end I'll explain how I work with a small group of people. Every price is on a page, and there's no countdown clock.";
    const paragraph = '<p style="' + P + '">' + teaser + '</p>';
    if (templateHtml.split(paragraph).length !== 2 || templateText.split(teaser + '\n\n').length !== 2) {
      throw new Error('Webinar service confirmation variant is unavailable');
    }
    templateHtml = templateHtml.replace(paragraph, '');
    templateText = templateText.replace(teaser + '\n\n', '');
  }
  const raw = (key: string): string => typeof send.context[key] === 'string' ? String(send.context[key]) : '';
  let link = raw('link');
  try { if (!link || new URL(link).origin !== MHP_SITE_ORIGIN) link = `${MHP_SITE_ORIGIN}/cheat-sheets/`; } catch { link = `${MHP_SITE_ORIGIN}/cheat-sheets/`; }
  const unsubscribe = mhpUnsubscribeUrl(unsubscribeSecret, send.prospectId);
  const values: Record<string, string> = {
    FIRSTNAME: (send.firstName ?? '').trim().split(/\s+/)[0]?.slice(0, 60) || 'there',
    LABEL: raw('label').slice(0, 200) || 'cheat sheet', LINK: link, UNSUBSCRIBE: unsubscribe,
  };
  // Blocks built here from escaped parts; inserted as-is in one pass so values are never re-scanned for placeholders.
  const blocks: Record<string, { html: string; text: string }> = {};
  if (send.template === 'application_received') {
    let booking: string | null = null;
    try { if (options.bookingUrl && new URL(options.bookingUrl).protocol === 'https:') booking = new URL(options.bookingUrl).toString(); } catch { booking = null; }
    blocks.BOOKING = booking
      ? { html: `<p style="margin:0 0 24px;"><a href="${escape(booking)}" style="${BUTTON}">Book your 20-minute call</a></p>`, text: `Book your 20-minute call (${booking})` }
      : { html: `<p style="${P}">${escape(BOOKING_FALLBACK)}</p>`, text: BOOKING_FALLBACK };
  }
  if (send.template === 'application_notify') {
    const application = send.application;
    if (!application) throw new Error('Application notification has no application');
    const rows = applicationRows(application);
    values.NAME = application.name.slice(0, 120);
    values.DOOR = application.door;
    blocks.DETAILS = {
      html: `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;font-size:15px;line-height:1.5;">${rows.map(([label, value]) =>
        `<tr><td style="padding:6px 16px 6px 0;vertical-align:top;color:#555555;white-space:nowrap;">${escape(label)}</td><td style="padding:6px 0;vertical-align:top;white-space:pre-wrap;">${escape(value)}</td></tr>`).join('')}</table>`,
      text: rows.map(([label, value]) => `${label}: ${value}`).join('\n'),
    };
  }
  const fill = (text: string, html: boolean, subject = false): string => text.replace(/\{\{([A-Z]+)\}\}/g, (match, key: string) => {
    if (!subject && blocks[key]) return html ? blocks[key]!.html : blocks[key]!.text;
    const value = values[key];
    if (value === undefined) throw new Error('Unfilled MHP template placeholder');
    return html ? escape(value) : value.replace(/[\r\n]+/g, ' ');
  });
  return { subject: fill(template.subject, false, true), html: fill(templateHtml, true), text: fill(templateText, false), unsubscribe, stream };
}

export interface MhpMarketingSender { send(item: MhpClaimedSend): Promise<string> }
export interface MhpRenderedMarketingSend {
  id: string; email: string; tag: string;
  rendered: { subject: string; text: string; html: string; unsubscribe: string; stream?: 'broadcast' | 'outbound' };
  ownerTest?: boolean;
  /** The prospect this email is addressed to. Travels with the message so a later bounce or complaint can stop that person. */
  prospectId?: string;
}
export interface MhpRenderedMarketingSender { sendRendered(item: MhpRenderedMarketingSend): Promise<string> }
/** Refuses bounced, complained and unsubscribed addresses for one workspace before any provider call. */
export interface MhpRecipientGuard { guard: EmailSendGuard; workspaceId: string }
const PROSPECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function createMhpMarketingSender(config: MhpMarketingConfig, unsubscribeSecret: string, fetcher: typeof fetch = fetch,
  recipients?: MhpRecipientGuard): MhpMarketingSender & MhpRenderedMarketingSender {
    const sendRendered = async (item: MhpRenderedMarketingSend): Promise<string> => {
      const to = normalizeMhpEmail(item.email);
      if (!to) throw new Error('Invalid recipient');
      if (config.testRecipients && !config.testRecipients.includes(to)) throw new Error('Recipient is outside the test list');
      const email = item.rendered;
      const transactional = email.stream === 'outbound';
      // The single choke point for built-in emails, owner emails and sequences. The owner's own test send is exempt.
      if (recipients && !item.ownerTest) {
        await recipients.guard.whenReady();
        const decision = recipients.guard.decide(recipients.workspaceId, to, transactional ? 'service' : 'marketing');
        if (decision.blocked) throw new EmailRecipientBlockedError(decision.reason);
      }
      const response = await fetcher('https://api.postmarkapp.com/email', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: { 'content-type': 'application/json', accept: 'application/json', 'X-Postmark-Server-Token': config.token },
        body: JSON.stringify({
          From: `Martin Howard <${config.from}>`, To: to, ReplyTo: config.replyTo, Subject: email.subject,
          HtmlBody: email.html, TextBody: email.text, MessageStream: transactional ? config.transactionalStream : config.stream, Tag: item.tag,
          TrackOpens: false, TrackLinks: 'None',
          ...(transactional ? {} : { Headers: item.ownerTest ? [] : [
            { Name: 'List-Unsubscribe', Value: `<${email.unsubscribe}>` },
            { Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' },
          ] }),
          Metadata: { send: item.id, ...(item.prospectId && PROSPECT_ID.test(item.prospectId) ? { prospect: item.prospectId } : {}) },
        }),
      });
      // Provider bodies can echo recipients. Only the message id is read on success.
      if (!response.ok) { await response.body?.cancel(); throw new Error('Marketing delivery was not accepted'); }
      const body = await response.json() as { MessageID?: unknown; ErrorCode?: unknown };
      if (body.ErrorCode !== 0 || typeof body.MessageID !== 'string' || body.MessageID.length < 1 || body.MessageID.length > 200) {
        throw new Error('Marketing delivery was not accepted');
      }
      return body.MessageID;
    };
  return {
    sendRendered,
    send: (item: MhpClaimedSend) => {
      if (item.template === 'application_notify' && normalizeMhpEmail(item.email) !== config.notifyTo) throw new Error('Application notification recipient changed');
      // An application notice goes to the owner, not the applicant, so it never carries the applicant's prospect id.
      return sendRendered({ id: item.id, email: item.email, tag: item.template,
        ...(item.template === 'application_notify' ? {} : { prospectId: item.prospectId }),
        rendered: renderMhpMarketingEmail(item, unsubscribeSecret, { bookingUrl: config.bookingUrl }) });
    },
  };
}

/** One minute sweeps on the existing process. Counts only reach the logs. */
export function startMhpMarketingDispatcher(growth: Pick<PgMhpGrowthService, 'claim' | 'settle'>, sender: MhpMarketingSender,
  config: Pick<MhpMarketingConfig, 'testRecipients'>, options: { intervalMs?: number; onResult?: (result: { sent: number; failed: number }) => void;
    owner?: { queue: MhpOwnerEmailDispatch; sender: MhpRenderedMarketingSender; unsubscribeSecret: string };
    sequences?: { queue: MhpSequenceDispatch; sender: MhpRenderedMarketingSender; unsubscribeSecret: string;
      onEntryResult?: (result: FollowupEntrySweepResult) => void; onEntryError?: () => void };
    /** A send was refused because the address bounced, complained or unsubscribed: stop that person's email for good. */
    onBlocked?: (prospectId: string) => Promise<void> } = {}): () => void {
  let stopped = false, running = false;
  const runOnce = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    let sent = 0, failed = 0;
    try {
      for (let page = 0; page < 4 && !stopped; page++) {
        const batch = await growth.claim(25, 120, config.testRecipients);
        for (const item of batch) {
          try {
            const reference = await sender.send(item);
            await growth.settle(item.id, true, reference); sent++;
          } catch (error) {
            failed++;
            if (error instanceof EmailRecipientBlockedError && item.template !== 'application_notify') {
              try { await options.onBlocked?.(item.prospectId); } catch { /* The address stays refused here; the stop is retried at the next attempt. */ }
            }
            try { await growth.settle(item.id, false, null); } catch { /* The lease expires and the send retries. */ }
          }
        }
        if (batch.length < 25) break;
      }
      if (options.owner && !stopped) {
        const owner = await dispatchMhpOwnerEmails({ ...options.owner, testRecipients: config.testRecipients, stopped: () => stopped, onBlocked: options.onBlocked });
        sent += owner.sent; failed += owner.failed;
      }
      if (options.sequences && !stopped) {
        const sequences = await dispatchMhpSequenceEmails({ ...options.sequences, testRecipients: config.testRecipients, stopped: () => stopped, onBlocked: options.onBlocked });
        sent += sequences.sent; failed += sequences.failed + sequences.unknown;
      }
    } catch { failed++; }
    finally {
      running = false;
      if (sent || failed) { try { options.onResult?.({ sent, failed }); } catch { /* telemetry only */ } }
    }
  };
  const interval = options.intervalMs ?? 60_000;
  void runOnce();
  const timer = setInterval(() => { void runOnce(); }, interval);
  timer.unref();
  return () => { stopped = true; clearInterval(timer); };
}
