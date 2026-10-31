import { normalizeMhpEmail } from './auth-service.js';
import { MHP_SITE_ORIGIN, mhpUnsubscribeUrl, type MhpClaimedSend, type MhpTemplateKey, type PgMhpGrowthService } from './growth-service.js';
import { MHP_MARKETING_TEMPLATES } from './marketing-templates.js';
import { dispatchMhpOwnerEmails, type MhpOwnerEmailDispatch } from './owner-email-dispatch.js';
import { dispatchMhpSequenceEmails, type MhpSequenceDispatch } from './followup-sequence-dispatch.js';
import type { FollowupEntrySweepResult } from '../followup-sequences/entry.js';

/**
 * Sends the queued sign-up emails through a Postmark broadcast stream.
 * MHP_MARKETING_MODE: off (default, nothing is sent and the queue waits),
 * test (only addresses in MHP_MARKETING_TEST_TO receive anything), live.
 */
export type MhpMarketingMode = 'off' | 'test' | 'live';
export interface MhpMarketingConfig {
  mode: MhpMarketingMode; token: string; from: string; replyTo: string; stream: string; testRecipients: readonly string[] | null;
}

export function mhpMarketingConfig(env: NodeJS.ProcessEnv): MhpMarketingConfig | null {
  const mode = (env.MHP_MARKETING_MODE?.trim() || 'off') as MhpMarketingMode;
  if (!['off', 'test', 'live'].includes(mode)) throw new Error('MHP_MARKETING_MODE must be off, test or live');
  if (mode === 'off') return null;
  const token = env.MHP_POSTMARK_SERVER_TOKEN?.trim() ?? '';
  const from = normalizeMhpEmail(env.MHP_MARKETING_FROM ?? '');
  const replyTo = normalizeMhpEmail(env.MHP_MARKETING_REPLY_TO ?? 'martin@propinvestuk.co.uk');
  const stream = env.MHP_POSTMARK_BROADCAST_STREAM?.trim() || 'broadcast';
  if (!token || !from || !replyTo || !/^[a-z0-9-]{1,60}$/.test(stream)) throw new Error('MHP marketing email is not fully configured');
  let testRecipients: string[] | null = null;
  if (mode === 'test') {
    testRecipients = (env.MHP_MARKETING_TEST_TO ?? '').split(',').map(value => normalizeMhpEmail(value)).filter((value): value is string => Boolean(value));
    if (testRecipients.length < 1 || testRecipients.length > 20) throw new Error('MHP_MARKETING_TEST_TO needs one to twenty addresses in test mode');
  }
  return Object.freeze({ mode, token, from, replyTo, stream, testRecipients });
}

const escape = (value: string): string => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function renderMhpMarketingEmail(send: Pick<MhpClaimedSend, 'template' | 'firstName' | 'context' | 'prospectId'>, unsubscribeSecret: string) {
  const template = MHP_MARKETING_TEMPLATES[send.template as MhpTemplateKey];
  if (!template) throw new Error('Unknown MHP marketing template');
  const raw = (key: string): string => typeof send.context[key] === 'string' ? String(send.context[key]) : '';
  let link = raw('link');
  try { if (!link || new URL(link).origin !== MHP_SITE_ORIGIN) link = `${MHP_SITE_ORIGIN}/cheat-sheets/`; } catch { link = `${MHP_SITE_ORIGIN}/cheat-sheets/`; }
  const unsubscribe = mhpUnsubscribeUrl(unsubscribeSecret, send.prospectId);
  const values: Record<string, string> = {
    FIRSTNAME: (send.firstName ?? '').trim().split(/\s+/)[0]?.slice(0, 60) || 'there',
    LABEL: raw('label').slice(0, 200) || 'cheat sheet', LINK: link, UNSUBSCRIBE: unsubscribe,
  };
  const fill = (text: string, html: boolean): string => text.replace(/\{\{(FIRSTNAME|LABEL|LINK|UNSUBSCRIBE)\}\}/g,
    (_, key: string) => html ? escape(values[key]!) : values[key]!.replace(/[\r\n]+/g, ' '));
  return { subject: fill(template.subject, false), html: fill(template.html, true), text: fill(template.text, false), unsubscribe };
}

export interface MhpMarketingSender { send(item: MhpClaimedSend): Promise<string> }
export interface MhpRenderedMarketingSend {
  id: string; email: string; tag: string;
  rendered: { subject: string; text: string; html: string; unsubscribe: string };
  ownerTest?: boolean;
}
export interface MhpRenderedMarketingSender { sendRendered(item: MhpRenderedMarketingSend): Promise<string> }

export function createMhpMarketingSender(config: MhpMarketingConfig, unsubscribeSecret: string, fetcher: typeof fetch = fetch): MhpMarketingSender & MhpRenderedMarketingSender {
    const sendRendered = async (item: MhpRenderedMarketingSend): Promise<string> => {
      const to = normalizeMhpEmail(item.email);
      if (!to) throw new Error('Invalid recipient');
      if (config.testRecipients && !config.testRecipients.includes(to)) throw new Error('Recipient is outside the test list');
      const email = item.rendered;
      const response = await fetcher('https://api.postmarkapp.com/email', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: { 'content-type': 'application/json', accept: 'application/json', 'X-Postmark-Server-Token': config.token },
        body: JSON.stringify({
          From: `Martin Howard <${config.from}>`, To: to, ReplyTo: config.replyTo, Subject: email.subject,
          HtmlBody: email.html, TextBody: email.text, MessageStream: config.stream, Tag: item.tag,
          TrackOpens: false, TrackLinks: 'None',
          Headers: item.ownerTest ? [] : [
            { Name: 'List-Unsubscribe', Value: `<${email.unsubscribe}>` },
            { Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' },
          ],
          Metadata: { send: item.id },
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
    send: (item: MhpClaimedSend) => sendRendered({ id: item.id, email: item.email, tag: item.template,
      rendered: renderMhpMarketingEmail(item, unsubscribeSecret) }),
  };
}

/** One minute sweeps on the existing process. Counts only reach the logs. */
export function startMhpMarketingDispatcher(growth: Pick<PgMhpGrowthService, 'claim' | 'settle'>, sender: MhpMarketingSender,
  config: Pick<MhpMarketingConfig, 'testRecipients'>, options: { intervalMs?: number; onResult?: (result: { sent: number; failed: number }) => void;
    owner?: { queue: MhpOwnerEmailDispatch; sender: MhpRenderedMarketingSender; unsubscribeSecret: string };
    sequences?: { queue: MhpSequenceDispatch; sender: MhpRenderedMarketingSender; unsubscribeSecret: string;
      onEntryResult?: (result: FollowupEntrySweepResult) => void; onEntryError?: () => void } } = {}): () => void {
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
          } catch {
            failed++;
            try { await growth.settle(item.id, false, null); } catch { /* The lease expires and the send retries. */ }
          }
        }
        if (batch.length < 25) break;
      }
      if (options.owner && !stopped) {
        const owner = await dispatchMhpOwnerEmails({ ...options.owner, testRecipients: config.testRecipients, stopped: () => stopped });
        sent += owner.sent; failed += owner.failed;
      }
      if (options.sequences && !stopped) {
        const sequences = await dispatchMhpSequenceEmails({ ...options.sequences, testRecipients: config.testRecipients, stopped: () => stopped });
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
