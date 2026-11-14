import { escapeHtml } from '../portal/ui.js';
import {
  BLOCK_REASON_PLAIN, BOUNCE_WARNING_RATE, COMPLAINT_WARNING_RATE, PROVIDER_BOUNCE_LIMIT_RATE, PROVIDER_COMPLAINT_LIMIT_RATE,
  normalizeBounceEmail, type EmailBlockReason,
} from '../email-bounces/policy.js';
import type { EmailHealthSnapshot } from '../email-bounces/registry.js';
import type { EmailBounceEffects, EmailBounceService } from '../email-bounces/service.js';
import type { EmailBounceSourceDefault } from '../email-bounces/config.js';
import type { PgMhpGrowthService } from './growth-service.js';
import { MHP_MARKETING_WORKSPACE_ID } from './marketing-workspace-service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const STREAM = /^[a-z0-9-]{1,60}$/u;

/**
 * MHP's Postmark server, from the variables its senders already use. The only
 * new setting is the webhook secret, MHP_POSTMARK_WEBHOOK_SECRET.
 * 'outbound' is always included: sign-in links and receipts are sent on it.
 */
export function mhpEmailBounceSourceDefault(env: NodeJS.ProcessEnv): EmailBounceSourceDefault {
  const stream = (name: string, fallback: string): string => { const value = env[name]?.trim() || fallback; return STREAM.test(value) ? value : fallback; };
  return { key: 'mhp', workspaceId: MHP_MARKETING_WORKSPACE_ID, tokenEnv: 'MHP_POSTMARK_SERVER_TOKEN', webhookSecretEnv: 'MHP_POSTMARK_WEBHOOK_SECRET',
    marketingStreams: [stream('MHP_POSTMARK_BROADCAST_STREAM', 'broadcast')],
    serviceStreams: [...new Set([stream('MHP_POSTMARK_TRANSACTIONAL_STREAM', 'outbound'), 'outbound'])] };
}

export interface MhpEmailHealthCheck {
  /** False when Postmark could not be read for at least one kind of email. */
  readonly complete: boolean;
  readonly blocked: number;
  /** People newly stopped in the contact list by this check. */
  readonly stopped: number;
  /** False when this sign-in may not read the contact list, so only sending was blocked. */
  readonly contactListChecked: boolean;
}

/**
 * MHP's side of bounce handling. A person is stopped for good through the
 * capability the unsubscribe link already uses, so queued emails are cancelled
 * and running sequences end. Email only: texts and WhatsApp are untouched.
 *
 * That capability cancels EVERYTHING queued for the person, including the webinar
 * reminders they asked for, and it cannot be undone from here. So it is used only
 * where that is right:
 *   hard bounce, spam report   every email to the address is refused anyway: always.
 *   unsubscribe                when it happens (webhook) and at the owner's check, unless the person
 *                              has signed up again since: they still get what they asked for.
 *   repeated soft bounce       never. It is a temporary block in the sending process only.
 * Which addresses are blocked, and why, is kept in the durable ledger where 0153 is applied.
 */
export class MhpEmailHealth {
  readonly workspaceId = MHP_MARKETING_WORKSPACE_ID;
  constructor(private readonly deps: { bounces: EmailBounceService; growth: Pick<PgMhpGrowthService, 'listRegistrants' | 'unsubscribe'>; patienceMs?: number }) {}

  get configured(): boolean { return this.deps.bounces.hasWorkspace(this.workspaceId); }
  /** True only once the durable list (0153) has answered in this process. */
  get durable(): boolean { return this.deps.bounces.durable; }

  /**
   * The owner says a hard-bounced address works now. Lifts the durable hard bounce (the owner's session is checked
   * again in the database), forgets this process's copy and reloads the list. A spam report is never lifted. The
   * person's contact-list stop is left alone: the contact record does not say whether a bounce caused it.
   */
  async lift(sessionToken: string, email: string): Promise<MhpEmailLiftOutcome> {
    const address = normalizeBounceEmail(email);
    if (!address) return { email: String(email).slice(0, 320), outcome: 'not_blocked' };
    const result = await this.deps.bounces.ownerLiftHardBounce({ sessionToken, workspaceId: this.workspaceId, email: address,
      note: 'Owner confirmed in Growth HQ that this address works now' });
    if (!result) return { email: address, outcome: 'unavailable' };
    await this.deps.bounces.refreshLedger(this.workspaceId);
    if (result.spamComplaint) return { email: address, outcome: 'spam' };
    if (result.lifted > 0) return { email: address, outcome: 'lifted' };
    return { email: address, outcome: result.alreadyLifted ? 'already_lifted' : 'not_blocked' };
  }
  snapshot(): EmailHealthSnapshot { return this.deps.bounces.registry.snapshot(this.workspaceId); }

  /** A send path refused this person's dead address (the dispatchers call this for a hard bounce only): stop their email for good. */
  readonly onBlocked = async (prospectId: string): Promise<void> => { if (UUID.test(prospectId)) await this.deps.growth.unsubscribe(prospectId); };

  /**
   * Webhook effect: every MHP marketing and sign-up email carries the prospect it was addressed to.
   * The shared handler calls this only for an event that is final in itself; the reason is checked again here.
   */
  effects(): EmailBounceEffects {
    return { onMarketingBlock: async ({ metadata, reason }) => {
      if ((reason === 'hard_bounce' || reason === 'spam_complaint' || reason === 'unsubscribed') && metadata.prospect) await this.onBlocked(metadata.prospect);
    } };
  }

  /**
   * Owner-triggered catch-up: read Postmark's lists again, then stop the listed
   * people in the contact list (see the rules on this class). Safe to press
   * repeatedly: people already stopped are skipped, and Postmark is read at most
   * twice a minute. The contact list read covers the latest 2,000 people.
   */
  async check(sessionToken: string): Promise<MhpEmailHealthCheck> {
    const { bounces, growth } = this.deps;
    // The web request must answer inside the server's 30-second limit. A slow read carries on in the
    // background and is picked up by the next press; what is already known is applied now.
    let timer: NodeJS.Timeout | undefined;
    const sweep = await Promise.race([bounces.sweepWorkspace(this.workspaceId, 30_000),
      new Promise<{ failed: number }>(resolve => { timer = setTimeout(() => resolve({ failed: 1 }), this.deps.patienceMs ?? 18_000); timer.unref?.(); })]);
    clearTimeout(timer);
    // Durable rows (0153) join the picture before it is compared with the contact list.
    await bounces.refreshLedger(this.workspaceId);
    let stopped = 0, contactListChecked = false;
    try {
      const registrants = await growth.listRegistrants(sessionToken);
      contactListChecked = true;
      const blocked = new Map(this.snapshot().blocked.map(item => [item.email, item]));
      for (const person of registrants) {
        const email = normalizeBounceEmail(person.email);
        if (person.unsubscribed || !email || !UUID.test(person.id)) continue;
        const block = blocked.get(email);
        if (!block || block.reason === 'repeated_soft_bounce') continue;
        // Blocked from marketing only, and they have signed up again since: the stop would cancel the
        // webinar emails they just asked for. Their record is left alone.
        if (!block.allEmail && Date.parse(person.lastSignupAt) > Date.parse(block.since)) continue;
        // An owner's own block is the owner's decision; it is not turned into a contact-list stop here.
        if (block.reason === 'manual') continue;
        if (await growth.unsubscribe(person.id)) stopped++;
      }
    } catch { /* Sending stays blocked either way; the page says the contact list was not updated. */ }
    return { complete: sweep.failed === 0, blocked: this.snapshot().blocked.length, stopped, contactListChecked };
  }
}

const percent = (value: number): string => value === 0 ? '0%' : `${(value * 100).toFixed(value < 0.01 ? 2 : 1)}%`;
const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;
const date = (iso: string): string => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', year: 'numeric' }).format(Date.parse(iso));
const dateTime = (iso: string): string => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(Date.parse(iso));
const STOPPED: Readonly<Record<EmailBlockReason, string>> = Object.freeze({
  hard_bounce: 'Marketing and event emails', spam_complaint: 'Marketing and event emails', manual: 'Marketing and event emails',
  unsubscribed: 'Marketing email', repeated_soft_bounce: 'Marketing email, for now (this lifts by itself)',
});

/** The transactional stream carries more than webinar emails: sign-in links and receipts are counted in its totals too. */
const REQUESTED_EMAILS = 'requested emails (sign-in links, receipts and webinar emails)';

/** Plain warnings, strongest first. The lines are ours and sit below the provider's own. */
export function emailHealthWarnings(snapshot: EmailHealthSnapshot): string[] {
  const warnings: string[] = [];
  for (const stream of snapshot.streams) {
    const what = stream.kind === 'marketing' ? 'marketing emails' : REQUESTED_EMAILS;
    if (stream.bounceRate !== null && stream.bounceRate >= BOUNCE_WARNING_RATE) {
      warnings.push(`${percent(stream.bounceRate)} of your ${what} bounced in the last ${snapshot.window.days} days (${stream.bounced} of ${stream.sent}). `
        + `We warn at ${percent(BOUNCE_WARNING_RATE)}, which is our own line. Postmark expects bounces to stay under about ${percent(PROVIDER_BOUNCE_LIMIT_RATE)} and can pause sending above that. `
        + 'Before the next big send, check where the newest addresses came from.');
    }
    if (stream.complaintRate !== null && stream.complaintRate >= COMPLAINT_WARNING_RATE) {
      warnings.push(`${plural(stream.complaints ?? 0, 'person', 'people')} marked your ${what} as spam in the last ${snapshot.window.days} days (${percent(stream.complaintRate)} of ${stream.sent} sent). `
        + `We warn at ${percent(COMPLAINT_WARNING_RATE)}, which is our own line. Postmark expects spam reports to stay under ${percent(PROVIDER_COMPLAINT_LIMIT_RATE)}. `
        + 'Only email people who asked to hear from you, and make the unsubscribe link easy to find.');
    }
  }
  return warnings;
}

/** The short card on the marketing screen. */
export function emailHealthCard(snapshot: EmailHealthSnapshot): string {
  const warnings = emailHealthWarnings(snapshot);
  const rate = snapshot.window.bounceRate === null ? '' : ` In the last ${snapshot.window.days} days ${percent(snapshot.window.bounceRate)} of your emails bounced.`;
  return `<section style="margin-top:40px"><h2>Emails that bounced or complained</h2><p>${snapshot.blocked.length === 0
    ? 'No addresses are blocked.' : `${plural(snapshot.blocked.length, 'address is', 'addresses are')} blocked: no marketing email goes to ${snapshot.blocked.length === 1 ? 'it' : 'them'}, and no event emails either after a bounce or spam report.`}${escapeHtml(rate)}</p>${
    warnings.length ? `<p role="alert"><strong>Warning:</strong> your bounce or spam-report rate needs attention.</p>` : ''}<a class="button" href="/hq/marketing/email-health">See bounced and blocked emails</a></section>`;
}

/** What pressing "This address works now" did, in the owner's words. */
export interface MhpEmailLiftOutcome {
  readonly email: string;
  /**
   * lifted: our block is lifted now; already_lifted: an owner had already lifted it; spam: a spam report blocks it
   * whatever the bounce says (the bounce may or may not have been lifted); not_blocked: no bounce was recorded;
   * unavailable: no durable list here, nothing changed.
   */
  readonly outcome: 'lifted' | 'already_lifted' | 'spam' | 'not_blocked' | 'unavailable';
}

export function emailHealthPage(snapshot: EmailHealthSnapshot, csrf: string, result?: MhpEmailHealthCheck,
  options: { durable?: boolean; lift?: MhpEmailLiftOutcome } = {}): string {
  const durable = options.durable === true;
  const warnings = emailHealthWarnings(snapshot);
  const { month, window } = snapshot;
  const overall = window.sent === null
    ? `${plural(window.bounced, 'email', 'emails')} bounced and ${plural(window.complaints, 'was', 'were')} reported as spam. The number of emails sent could not be read from Postmark, so no percentage is shown.`
    : window.sent === 0 ? 'No emails went out in this period.'
      : `${window.bounced} of ${window.sent} emails bounced (${percent(window.bounceRate ?? 0)}). ${plural(window.complaints, 'email was', 'emails were')} reported as spam (${percent(window.complaintRate ?? 0)}).`;
  const small = window.sent !== null && window.sent > 0 && window.sent < 200
    ? `<p class="note">Only ${window.sent} emails went out in this period, so one or two bad addresses move the percentage a lot.</p>` : '';
  const streams = snapshot.streams.filter(stream => stream.sent !== null).map(stream =>
    `<tr><td>${stream.kind === 'marketing' ? 'Marketing emails' : `${REQUESTED_EMAILS[0]!.toUpperCase()}${REQUESTED_EMAILS.slice(1)}`}</td><td>${stream.sent}</td><td>${stream.bounced ?? 0}${stream.bounceRate === null ? '' : ` (${percent(stream.bounceRate)})`}</td><td>${stream.complaints ?? 0}${stream.complaintRate === null ? '' : ` (${percent(stream.complaintRate)})`}</td></tr>`).join('');
  // A wrong hard bounce can be undone by the owner, only where the list is kept in our own records (0153).
  const works = (email: string): string => `<form method="post" action="/hq/marketing/email-health/lift"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="email" value="${escapeHtml(email)}"><button type="submit">This address works now</button></form>`;
  const rows = snapshot.blocked.map(item => `<tr><td>${escapeHtml(item.email)}</td><td>${escapeHtml(BLOCK_REASON_PLAIN[item.reason])}</td><td>${escapeHtml(date(item.since))}</td><td>${STOPPED[item.reason]}${
    durable && item.reason === 'hard_bounce' ? works(item.email) : ''}</td></tr>`).join('');
  const lifted = options.lift ? `<p role="status" class="status">${escapeHtml(({
    lifted: `We no longer block ${options.lift.email} for that bounce. Now press Reactivate for this address in Postmark, or Postmark will still refuse it. If we also stopped this person in your contacts, they stay stopped until they sign up again: we cannot tell whether the bounce caused that.`,
    already_lifted: `We had already stopped blocking ${options.lift.email} for that bounce. If it is still listed here, Postmark still lists it: press Reactivate for this address in Postmark.`,
    spam: `${options.lift.email} stays blocked: they marked one of your emails as spam, and a spam report cannot be undone from this page.`,
    not_blocked: `${options.lift.email} has no bounce recorded in your own records, so nothing changed. If it is still listed here, Postmark still lists it: press Reactivate for this address in Postmark.`,
    unavailable: `Nothing changed: this list is not kept in your own records yet, so reactivate ${options.lift.email} in Postmark instead.`,
  } as const)[options.lift.outcome])}</p>` : '';
  const outcome = result ? `<p role="status" class="status">${result.complete ? 'Checked with Postmark.' : 'Postmark could not be fully read just now, so this may be missing the newest bounces. Try again in a minute.'} ${
    plural(result.blocked, 'address is', 'addresses are')} blocked. ${result.contactListChecked
      ? (result.stopped === 0 ? 'No one new needed stopping in your contacts.' : `${plural(result.stopped, 'person was', 'people were')} newly stopped in your contacts.`)
      : 'Sending to them is blocked. Your contact list was not updated from this sign-in; open Owner HQ and check again to update it.'}</p>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Emails that bounced or complained · Growth HQ</title><style>body{margin:0;background:#f5f3ed;color:#142019;font:17px/1.6 system-ui,sans-serif}header,main{max-width:960px;margin:auto;padding:24px}header{display:flex;gap:20px;flex-wrap:wrap;justify-content:space-between}nav{display:flex;gap:20px;flex-wrap:wrap}a{color:inherit}article{background:white;border:1px solid #dedfd5;border-radius:20px;padding:clamp(24px,5vw,52px)}h1{font:clamp(30px,5vw,46px)/1.12 Georgia,serif;margin:12px 0 24px}h2{margin-top:40px}.eyebrow{font-size:13px;font-weight:800;letter-spacing:.12em;color:#83510c;text-transform:uppercase}p{max-width:68ch}.figures{display:flex;gap:16px;flex-wrap:wrap;padding:0;list-style:none}.figures li{flex:1 1 180px;border:1px solid #dedfd5;border-radius:14px;padding:16px}.figures strong{display:block;font:700 34px/1.1 Georgia,serif}.warning{border:2px solid #9c2f14;background:#fdf1ec;border-radius:14px;padding:16px 20px;margin:20px 0}.status{border:1px solid #bac5b8;background:#eef4ec;border-radius:14px;padding:14px 18px}.note{font-size:15px;color:#526154}table{border-collapse:collapse;width:100%;font-size:16px}th,td{text-align:left;padding:10px 12px;border-bottom:1px solid #e3e4da;vertical-align:top}td:first-child{overflow-wrap:anywhere}.scroll{overflow-x:auto}button{cursor:pointer;border:0;background:#E8A33D;border-radius:10px;padding:15px 22px;color:#142019;font:700 16px system-ui}a:focus-visible,button:focus-visible{outline:3px solid #83510c;outline-offset:4px}</style></head><body><header><strong>Martin Howard Property</strong><nav aria-label="Owner navigation"><a href="/hq/marketing">Marketing workspace</a><a href="/hq">Owner HQ</a></nav></header><main><article><span class="eyebrow">Growth HQ · MHP brand</span><h1>Emails that bounced or complained</h1><p>When an email cannot be delivered, or someone marks it as spam, we automatically stop sending that address marketing and event emails. When someone unsubscribes we stop marketing email only. Sign-in links and receipts still go. Email services switch off accounts that keep sending to bad addresses, so this page shows how you are doing. Texts and WhatsApp are not affected.</p>${outcome}${lifted}${
    warnings.map(text => `<div class="warning" role="alert"><strong>Warning.</strong> ${escapeHtml(text)}</div>`).join('')}<h2>This month</h2><ul class="figures"><li><strong>${month.bounced}</strong>${month.bounced === 1 ? 'address' : 'addresses'} bounced</li><li><strong>${month.complained}</strong>${month.complained === 1 ? 'person' : 'people'} marked an email as spam</li><li><strong>${month.unsubscribed}</strong>unsubscribed through the email service</li></ul><h2>Last ${window.days} days</h2><p>${escapeHtml(overall)}</p>${small}${
    streams ? `<div class="scroll"><table><thead><tr><th scope="col">Kind of email</th><th scope="col">Sent</th><th scope="col">Bounced</th><th scope="col">Reported as spam</th></tr></thead><tbody>${streams}</tbody></table></div>` : ''}<p class="note">We warn when bounces reach ${percent(BOUNCE_WARNING_RATE)} or spam reports reach ${percent(COMPLAINT_WARNING_RATE)}. Those lines are ours, set well below Postmark's own (about ${percent(PROVIDER_BOUNCE_LIMIT_RATE)} and ${percent(PROVIDER_COMPLAINT_LIMIT_RATE)}), so you hear about it first.</p><h2>Addresses we no longer email</h2>${
    rows ? `<div class="scroll"><table><thead><tr><th scope="col">Address</th><th scope="col">Why</th><th scope="col">Since</th><th scope="col">What is stopped</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p>No blocked addresses. Nothing has bounced or been reported.</p>'}<p class="note">${
    snapshot.lastCheckedAt ? `Last checked with Postmark: ${escapeHtml(dateTime(snapshot.lastCheckedAt))}.` : 'Not checked with Postmark yet.'}${snapshot.incomplete ? ' Postmark could not be fully read last time, so the newest bounces may be missing.' : ''} New bounces and spam reports also arrive here on their own as they happen.</p><p class="note">This list follows Postmark, the service that sends your emails. ${durable
      ? 'It is also kept in your own records, so a restart does not lose it. A bounce or spam report stays blocked here even if the address is reactivated in Postmark. If you know a bounced address works now, press Reactivate for it in Postmark first, then press &ldquo;This address works now&rdquo; beside it here. A spam report cannot be undone from this page.'
      : 'If an address has been fixed, reactivate it in Postmark and it leaves this list at the next check.'} Someone who unsubscribed gets marketing email again only once they have signed up again and Postmark no longer lists them as unsubscribed. Anyone we also stopped in your contacts stays stopped, exactly as if they had unsubscribed, until they sign up again and tick the box themselves.</p><form method="post" action="/hq/marketing/email-health/check"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button type="submit">Check with Postmark now</button></form></article></main></body></html>`;
}
