/**
 * LeadRelay → brand CRM feed (step one: Relaunch72 pulls, LeadRelay is unchanged).
 *
 * On a timer in the web process this reads LeadRelay's undelivered event list with a read-only workspace key,
 * copies new enquiries and call results into the brand's CRM, and then marks each event as delivered. It sends
 * nothing to anyone, enrols nobody, never writes to LeadRelay except to mark an event delivered, and never
 * posts a lead back to LeadRelay.
 *
 * Switches (names only; values live in the hosting dashboard):
 *   LEADRELAY_CRM_FEED            exactly "enabled", or the whole feature is inert
 *   LEADRELAY_CRM_FEED_KEY        the LeadRelay workspace key (40+ characters; scopes events.read, events.ack, lead.read)
 *   LEADRELAY_CRM_FEED_BASE_URL   https only; defaults to https://leadrelay-live.onrender.com
 *   LEADRELAY_CRM_FEED_BRAND      must be "pp" for now; the workspace comes from the Group HQ inbox brand scopes
 *
 * Bad settings are reported once and leave the feed off; they never stop the web service from starting.
 */

import { createHash } from 'node:crypto';
import type { InboxCrmConfig } from '../group-hq-crm/inbox.js';
import type { CrmTransactionRunner } from '../../crm-pg/types.js';
import {
  LEADRELAY_OUTBOX_PAGE, LeadRelayFeedError, createLeadRelayFeedClient, isLeadRelayId,
  type LeadRelayFeedClient, type LeadRelayOutboxRow, type LeadRelayUnreadableRow,
} from './crm-feed-client.js';
import {
  PgLeadRelayCrmWriter, normalisedEmail, normalisedPhone,
  type LeadRelayCrmScope, type LeadRelayCrmWriter, type TimelineEvent,
} from './crm-feed-writer.js';

export const LEADRELAY_CRM_FEED_ENV = 'LEADRELAY_CRM_FEED';
export const LEADRELAY_CRM_FEED_KEY_ENV = 'LEADRELAY_CRM_FEED_KEY';
export const LEADRELAY_CRM_FEED_BASE_URL_ENV = 'LEADRELAY_CRM_FEED_BASE_URL';
export const LEADRELAY_CRM_FEED_BRAND_ENV = 'LEADRELAY_CRM_FEED_BRAND';
export const LEADRELAY_DEFAULT_BASE_URL = 'https://leadrelay-live.onrender.com';
const SUPPORTED_BRANDS = new Set(['pp']);
const KEY = /^[\x21-\x7e]{40,512}$/u;
const TIME_ZONE = 'Europe/London';
/** Each event is tried once per run; after this many failures in a row it waits an hour so later events keep moving. */
export const MAX_ROW_FAILURES = 3;
const HOLD_MS = 3_600_000;
/** At most this many pages of 200 per run; the rest wait for the next run. */
const MAX_PAGES_PER_RUN = 10;
const NEEDS_OWNER_KEPT = 20;

// ---------------------------------------------------------------------------------------------------- settings

export type LeadRelayCrmFeedConfig =
  | { readonly state: 'off' }
  | { readonly state: 'invalid'; readonly problem: string }
  | { readonly state: 'on'; readonly key: string; readonly baseUrl: string; readonly brand: string; readonly scope: LeadRelayCrmScope };

export function loadLeadRelayCrmFeedConfig(env: NodeJS.ProcessEnv, inbox: InboxCrmConfig | undefined): LeadRelayCrmFeedConfig {
  if (env[LEADRELAY_CRM_FEED_ENV] !== 'enabled') return { state: 'off' };
  const invalid = (problem: string): LeadRelayCrmFeedConfig => ({ state: 'invalid', problem });
  const key = env[LEADRELAY_CRM_FEED_KEY_ENV]?.trim() ?? '';
  if (!KEY.test(key)) return invalid(`${LEADRELAY_CRM_FEED_KEY_ENV} must be the LeadRelay key: at least 40 characters with no spaces.`);
  const rawBase = env[LEADRELAY_CRM_FEED_BASE_URL_ENV]?.trim() || LEADRELAY_DEFAULT_BASE_URL;
  let base: URL;
  try { base = new URL(rawBase); } catch { return invalid(`${LEADRELAY_CRM_FEED_BASE_URL_ENV} is not a web address.`); }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || (base.pathname !== '/' && base.pathname !== '')) {
    return invalid(`${LEADRELAY_CRM_FEED_BASE_URL_ENV} must be a plain https:// address with nothing after the domain.`);
  }
  const brand = env[LEADRELAY_CRM_FEED_BRAND_ENV]?.trim() ?? '';
  if (!SUPPORTED_BRANDS.has(brand)) return invalid(`${LEADRELAY_CRM_FEED_BRAND_ENV} must be pp.`);
  const scope = inbox?.scopes[brand];
  if (!scope) return invalid(`The ${brand} CRM is not set up in the Group HQ inbox settings (R72_GROUP_HQ_INBOX_SCOPES), so LeadRelay has nowhere to write.`);
  return { state: 'on', key, baseUrl: base.origin, brand,
    scope: { workspaceId: scope.workspaceId, ownerUserId: scope.ownerUserId, pipelineId: scope.pipelineId, stageId: scope.stageId } };
}

// ---------------------------------------------------------------------------------------------------- wording

const day = new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
const dayLabel = new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, day: 'numeric', month: 'short', year: 'numeric' });
const clock = new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const londonDay = (at: number): string => day.format(new Date(at));
const hourOnly = new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, hour: '2-digit', hourCycle: 'h23' });
/** Midnight in the UK at the start of the UK day containing `at`. */
function londonMidnight(at: number): number {
  const [d, m, y] = londonDay(at).split('/').map(Number) as [number, number, number];
  const utcMidnight = Date.UTC(y, m - 1, d);
  return utcMidnight - Number(hourOnly.format(new Date(utcMidnight))) * 3_600_000;
}
const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

/** "14:05 today", "14:05 yesterday" or "14:05 on 3 Nov 2026", in UK time. */
export function whenLabel(at: number, now: number): string {
  const time = clock.format(new Date(at));
  if (londonDay(at) === londonDay(now)) return `${time} today`;
  if (londonDay(at) === londonDay(now - 86_400_000)) return `${time} yesterday`;
  return `${time} on ${dayLabel.format(new Date(at))}`;
}

const CALL_LABELS: Readonly<Record<string, string>> = {
  answered: 'answered', no_answer: 'no answer', booked: 'said they want to book', interested: 'interested',
  not_interested: 'not interested', failed: 'did not go through',
};

// ---------------------------------------------------------------------------------------------------- events

type Action =
  | { type: 'enquiry'; leadId: string }
  | { type: 'timeline'; leadId: string; counts: 'call' | 'dnc' | 'note'; event: Omit<TimelineEvent, 'eventKey' | 'leadKey'> }
  | { type: 'skip' }
  | { type: 'ignore' };

/** What one LeadRelay event means for the CRM. Free text in LeadRelay payloads (summaries) is never copied. */
export function interpretLeadRelayEvent(row: LeadRelayOutboxRow): Action {
  const date = dayLabel.format(new Date(row.createdAt * 1000));
  const occurredAt = new Date(row.createdAt * 1000).toISOString();
  const note = (leadId: string | null, subject: string, metadata: Record<string, string | number | boolean | null> = {}): Action =>
    leadId ? { type: 'timeline', leadId, counts: 'note', event: { leadRelayEventId: row.id, activityType: 'leadrelay.note', subject, body: null,
      occurredAt, metadata: { leadRelayKind: row.kind, ...metadata }, doNotCall: false } } : { type: 'skip' };
  const p = row.payload;
  switch (row.kind) {
    case 'lead.created':
      return p.is_demo === true || !row.leadId ? { type: 'skip' } : { type: 'enquiry', leadId: row.leadId };
    case 'call.provider_outcome':
    case 'call.outcome': {
      if (!row.leadId) return { type: 'skip' };
      const outcome = typeof p.outcome === 'string' ? p.outcome : null;
      if (outcome === 'opt_out') {
        return { type: 'timeline', leadId: row.leadId, counts: 'dnc', event: { leadRelayEventId: row.id, activityType: 'leadrelay.do_not_call',
          subject: `Asked not to be called (AI call on ${date})`, body: null, occurredAt, metadata: { leadRelayKind: row.kind, outcome }, doNotCall: true } };
      }
      const label = (outcome && CALL_LABELS[outcome]) ?? 'finished';
      return { type: 'timeline', leadId: row.leadId, counts: 'call', event: { leadRelayEventId: row.id, activityType: 'leadrelay.call_result',
        subject: `AI call: ${label} (${date})`, body: null, occurredAt, metadata: { leadRelayKind: row.kind, outcome }, doNotCall: false } };
    }
    case 'lead.status':
      // Booked and won arrive as their own meeting and purchase events; paused, active and new are LeadRelay's own housekeeping.
      if (p.status === 'unsubscribed') return note(row.leadId, `Unsubscribed in LeadRelay (${date}). LeadRelay will not contact them; permissions in this CRM are unchanged.`, { status: 'unsubscribed' });
      if (p.status === 'lost') return note(row.leadId, `Marked as not interested in LeadRelay (${date})`, { status: 'lost' });
      return { type: 'ignore' };
    case 'meeting.booked': {
      const starts = typeof p.starts_at === 'number' && Number.isFinite(p.starts_at) && p.starts_at > 0 ? p.starts_at * 1000 : null;
      return note(row.leadId, starts ? `Meeting booked through LeadRelay for ${clock.format(new Date(starts))} on ${dayLabel.format(new Date(starts))}`
        : `Meeting booked through LeadRelay (${date})`);
    }
    case 'meeting.cancelled': return note(row.leadId, `Meeting cancelled in LeadRelay (${date})`);
    case 'purchase.confirmed': return note(row.leadId, `Purchase confirmed in LeadRelay (${date})`);
    case 'lead.replied': return note(row.leadId, `Replied to LeadRelay (${date})`);
    case 'consent.updated': return note(row.leadId, `Contact permissions changed in LeadRelay (${date}). Permissions in this CRM are unchanged.`);
    case 'privacy.erased': return note(isLeadRelayId(p.erased_lead_id) ? p.erased_lead_id : null,
      `LeadRelay deleted this person's details at their request (${date}). Nothing in this CRM was changed.`);
    default: return { type: 'ignore' };
  }
}

const digest = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 48);
export const leadRelayLeadKey = (workspaceId: string | null, leadId: string): string => `lr.lead.${digest(`${workspaceId ?? ''}:${leadId}`)}`;
export const leadRelayEventKey = (workspaceId: string | null, eventId: string): string => `lr.event.${digest(`${workspaceId ?? ''}:${eventId}`)}`;
const sourceLabel = (source: string): string => `leadrelay:${source.toLowerCase().replace(/[^a-z0-9_.-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 80) || 'enquiry'}`;

// ---------------------------------------------------------------------------------------------------- status

export interface LeadRelayFeedCounts {
  enquiriesCopied: number; callResultsCopied: number; doNotCallRecorded: number; skipped: number; needsTheOwner: number;
}
export type LeadRelayFeedProblem = 'not_connected' | 'settings_incomplete' | 'starting' | 'no_answer' | 'key_refused' | 'unexpected_answer' | null;
export interface LeadRelayFeedStatus {
  brand: string;
  switchedOn: boolean;
  problem: LeadRelayFeedProblem;
  lastSucceededAt: string | null;
  lastAnsweredAt: string | null;
  today: LeadRelayFeedCounts;
  /** Counts are kept in memory: they start at midnight UK time or at the last restart, whichever is later. */
  countingSince: string;
  waitingAfterRepeatedFailures: number;
  needsTheOwner: { leadRelayLeadId: string; reason: 'two_contacts' | 'archived_contact' | 'number_not_on_contact'; at: string }[];
  sentences: string[];
  summary: string;
}

type Logger = (line: string) => void;
type RowResult = keyof LeadRelayFeedCounts | 'note' | 'ignored' | 'replayed';

export class LeadRelayCrmFeed {
  private readonly startedAt: number;
  private readonly now: () => number;
  private readonly log: Logger;
  private counts: LeadRelayFeedCounts = { enquiriesCopied: 0, callResultsCopied: 0, doNotCallRecorded: 0, skipped: 0, needsTheOwner: 0 };
  private countsDay: string;
  private lastSucceededAt: number | null = null;
  private lastAnsweredAt: number | null = null;
  private lastRun: number | null = null;
  private problem: Exclude<LeadRelayFeedProblem, 'not_connected' | 'settings_incomplete' | 'starting'> = null;
  private readonly failures = new Map<string, { count: number; retryAt: number }>();
  /** Events already counted whose acknowledgement did not reach LeadRelay; they are not counted twice. */
  private readonly countedNotAcked = new Set<string>();
  private readonly ownerItems: LeadRelayFeedStatus['needsTheOwner'] = [];
  private running: Promise<void> | null = null;

  constructor(readonly config: LeadRelayCrmFeedConfig, private readonly deps: { client?: LeadRelayFeedClient; writer?: LeadRelayCrmWriter;
    now?: () => number; log?: Logger } = {}) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => undefined);
    this.startedAt = this.now();
    this.countsDay = londonDay(this.startedAt);
  }

  private emit(event: string, level: 'info' | 'warn', fields: Record<string, string | number | boolean | null> = {}): void {
    // Counts, categories and LeadRelay's opaque ids only: never names, emails, phone numbers, free text or the key.
    this.log(JSON.stringify({ event: `leadrelay.crm_feed.${event}`, level, ...fields }));
  }

  private rollDay(): void {
    const today = londonDay(this.now());
    if (today === this.countsDay) return;
    this.countsDay = today;
    this.counts = { enquiriesCopied: 0, callResultsCopied: 0, doNotCallRecorded: 0, skipped: 0, needsTheOwner: 0 };
  }

  private bump(result: RowResult): void {
    this.rollDay();
    if (result in this.counts) this.counts[result as keyof LeadRelayFeedCounts]++;
  }

  private needsOwner(leadId: string, reason: LeadRelayFeedStatus['needsTheOwner'][number]['reason']): void {
    this.ownerItems.unshift({ leadRelayLeadId: leadId, reason, at: new Date(this.now()).toISOString() });
    this.ownerItems.length = Math.min(this.ownerItems.length, NEEDS_OWNER_KEPT);
  }

  private async handle(client: LeadRelayFeedClient, writer: LeadRelayCrmWriter, row: LeadRelayOutboxRow): Promise<RowResult[]> {
    const action = interpretLeadRelayEvent(row);
    if (action.type === 'ignore') return ['ignored'];
    if (action.type === 'skip') return ['skipped'];
    const leadKey = leadRelayLeadKey(row.workspaceId, action.leadId);
    if (action.type === 'enquiry') {
      const lead = await client.lead(action.leadId);
      // Demo leads, erased leads and leads with no way to reach them are not copied.
      if (!lead || lead.isDemo || (!normalisedEmail(lead.email) && !normalisedPhone(lead.phone))) return ['skipped'];
      const result = await writer.copyEnquiry({ leadKey, occurredAt: new Date(row.createdAt * 1000).toISOString(), lead: {
        displayName: lead.name.trim() || 'LeadRelay enquiry', companyName: lead.company.trim() || null,
        email: lead.email, phone: lead.phone, source: sourceLabel(lead.source) } });
      if (result.replayed) return ['replayed'];
      if (result.outcome === 'needs_owner') { this.needsOwner(action.leadId, result.reason); return ['needsTheOwner']; }
      return ['enquiriesCopied'];
    }
    const result = await writer.recordTimeline({ ...action.event, leadKey, eventKey: leadRelayEventKey(row.workspaceId, row.id) });
    if (result.replayed) return ['replayed'];
    if (result.outcome === 'not_copied') return ['skipped'];
    if (action.counts === 'note') return ['note'];
    if (action.counts === 'call') return ['callResultsCopied'];
    if (result.doNotCall === 'recorded') return ['callResultsCopied', 'doNotCallRecorded'];
    this.needsOwner(action.leadId, 'number_not_on_contact');
    return ['callResultsCopied', 'needsTheOwner'];
  }

  /** One pass over LeadRelay's waiting events, oldest first. Never throws. */
  runOnce(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.pass().finally(() => { this.running = null; });
    return this.running;
  }

  private async pass(): Promise<void> {
    const config = this.config;
    if (config.state !== 'on') return;
    const client = this.deps.client ?? createLeadRelayFeedClient({ baseUrl: config.baseUrl, key: config.key });
    const writer = this.deps.writer;
    if (!writer) return;
    this.lastRun = this.now();
    const tally: Record<string, number> = {};
    let failed = 0, transport: LeadRelayFeedError | null = null;
    try {
      for (let page = 0; page < MAX_PAGES_PER_RUN; page++) {
        const rows = (await client.outbox()).sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        this.lastAnsweredAt = this.now();
        let progressed = false;
        // A later event for a lead whose earlier event failed waits with it, so a call result never overtakes its enquiry.
        const waitingLeads = new Set<string>();
        for (const row of rows) {
          const leadId = 'unreadable' in row ? null : row.leadId ?? (isLeadRelayId(row.payload.erased_lead_id) ? row.payload.erased_lead_id : null);
          const held = this.failures.get(row.id);
          if ((held && held.retryAt > this.now()) || (leadId && waitingLeads.has(leadId))) { if (leadId) waitingLeads.add(leadId); continue; }
          let results: RowResult[];
          try {
            results = 'unreadable' in row ? ['skipped'] : await this.handle(client, writer, row);
          } catch (error) {
            if (error instanceof LeadRelayFeedError && error.kind !== 'not_found' && error.kind !== 'unexpected_answer') throw error;
            const count = (held?.count ?? 0) + 1;
            this.failures.set(row.id, { count, retryAt: count >= MAX_ROW_FAILURES ? this.now() + HOLD_MS : 0 });
            if (leadId) waitingLeads.add(leadId);
            failed++;
            this.emit('row_failed', 'warn', { leadRelayEventId: row.id, kind: 'unreadable' in row ? null : row.kind, attempt: count,
              cause: error instanceof Error ? error.name : 'unknown', code: typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : null,
              message: count >= MAX_ROW_FAILURES ? 'This LeadRelay event failed several times; later events carry on and it is tried again in an hour.' : null });
            continue;
          }
          // Counted once, when the write commits (a replay counts nothing), then acknowledged: only now that the CRM
          // write has committed or the event was deliberately skipped.
          if (!this.countedNotAcked.has(row.id)) for (const result of results) { this.bump(result); tally[result] = (tally[result] ?? 0) + 1; }
          this.countedNotAcked.add(row.id);
          this.failures.delete(row.id);
          await client.ack(row.id);
          this.countedNotAcked.delete(row.id);
          progressed = true;
        }
        if (!progressed || rows.length < LEADRELAY_OUTBOX_PAGE) break;
      }
      this.problem = null;
      this.lastSucceededAt = this.now();
    } catch (error) {
      transport = error instanceof LeadRelayFeedError ? error : null;
      this.problem = transport?.kind === 'unauthorised' ? 'key_refused' : transport?.kind === 'unexpected_answer' ? 'unexpected_answer' : 'no_answer';
      if (this.problem === 'key_refused' || this.problem === 'unexpected_answer') this.lastAnsweredAt = this.now();
    }
    if (transport || this.problem) {
      this.emit('run_incomplete', 'warn', { problem: this.problem, status: transport?.status ?? null, failed, ...tally });
    } else if (failed || Object.keys(tally).length) {
      this.emit('run', failed ? 'warn' : 'info', { failed, ...tally });
    }
  }

  /** Runs now, then every intervalMs; after LeadRelay fails to answer it retries sooner, doubling up to maxRetryMs. */
  start(intervalMs = 120_000, retry: { retryMs?: number; maxRetryMs?: number } = {}): () => void {
    if (this.config.state !== 'on' || !this.deps.writer) return () => undefined;
    let stopped = false, timer: NodeJS.Timeout | undefined, misses = 0;
    const firstRetry = retry.retryMs ?? 30_000, maxRetry = retry.maxRetryMs ?? 15 * 60_000;
    const run = async (): Promise<void> => {
      if (stopped) return;
      await this.runOnce();
      if (stopped) return;
      misses = this.problem ? misses + 1 : 0;
      const wait = misses ? Math.min(firstRetry * 2 ** (misses - 1), maxRetry) : intervalMs;
      timer = setTimeout(() => { void run(); }, wait);
      timer.unref?.();
    };
    this.emit('started', 'info', { brand: this.config.brand, everySeconds: Math.round(intervalMs / 1000) });
    void run();
    return () => { stopped = true; clearTimeout(timer); };
  }

  status(brand: string): LeadRelayFeedStatus {
    const now = this.now();
    this.rollDay();
    const config = this.config;
    const mine = config.state === 'on' && config.brand === brand;
    const startOfCounting = Math.max(this.startedAt, londonMidnight(now));
    const restartedToday = this.startedAt >= londonMidnight(now);
    const iso = (at: number | null): string | null => at === null ? null : new Date(at).toISOString();
    const stuck = [...this.failures.values()].filter(item => item.count >= MAX_ROW_FAILURES).length;
    const problem: LeadRelayFeedProblem = config.state === 'off' || (config.state === 'on' && !mine) ? 'not_connected'
      : config.state === 'invalid' ? 'settings_incomplete' : this.lastRun === null ? 'starting' : this.problem;
    const sentences: string[] = [];
    const safe = 'Enquiries already copied are safe; new ones appear when it is back. Nothing was sent to anyone.';
    const lastHeard = this.lastAnsweredAt === null ? 'not heard from since the last restart' : `last heard ${whenLabel(this.lastAnsweredAt, now)}`;
    if (problem === 'not_connected') sentences.push('LeadRelay is not connected yet, so its enquiries are not reaching the CRM.');
    else if (problem === 'settings_incomplete') sentences.push('LeadRelay is switched on but its settings are incomplete, so its enquiries are not reaching the CRM.');
    else if (problem === 'starting') sentences.push('LeadRelay is connecting. New enquiries will appear in the CRM within a few minutes.');
    else if (problem === 'no_answer') sentences.push(`LeadRelay did not answer (${lastHeard}). ${safe}`);
    else if (problem === 'key_refused') sentences.push(`LeadRelay did not accept the connection key, so new enquiries are not reaching the CRM. ${safe}`);
    else if (problem === 'unexpected_answer') sentences.push(`LeadRelay sent back something this CRM could not read, so new enquiries are waiting. ${safe}`);
    else {
      const c = this.counts;
      const since = restartedToday ? ` since the last restart at ${clock.format(new Date(this.startedAt))}` : ' today';
      sentences.push(`LeadRelay is connected. ${plural(c.enquiriesCopied, 'enquiry', 'enquiries')} and ${plural(c.callResultsCopied, 'call result', 'call results')} copied to the CRM${since}.`);
    }
    if (mine) {
      const c = this.counts;
      if (c.doNotCallRecorded) sentences.push(`${plural(c.doNotCallRecorded, 'person', 'people')} asked not to be called; calls to them are now blocked. Texts, WhatsApp and email are not affected.`);
      const twoContacts = this.ownerItems.filter(item => item.reason === 'two_contacts' && Date.parse(item.at) >= startOfCounting).length;
      const archived = this.ownerItems.filter(item => item.reason === 'archived_contact' && Date.parse(item.at) >= startOfCounting).length;
      const noNumber = this.ownerItems.filter(item => item.reason === 'number_not_on_contact' && Date.parse(item.at) >= startOfCounting).length;
      if (twoContacts) sentences.push(`${plural(twoContacts, 'LeadRelay enquiry matches', 'LeadRelay enquiries match')} two CRM contacts and ${twoContacts === 1 ? 'was' : 'were'} not copied.`);
      if (archived) sentences.push(`${plural(archived, 'LeadRelay enquiry belongs', 'LeadRelay enquiries belong')} to an archived CRM contact and ${archived === 1 ? 'was' : 'were'} not copied.`);
      if (noNumber) sentences.push(`${plural(noNumber, 'person', 'people')} asked LeadRelay not to call them, but the number called is not on their CRM contact. Please check ${noNumber === 1 ? 'it' : 'them'}.`);
      if (stuck) sentences.push(`${plural(stuck, 'LeadRelay update', 'LeadRelay updates')} could not be copied after several tries and will be tried again within the hour.`);
    }
    return {
      brand, switchedOn: config.state === 'on' && mine, problem,
      lastSucceededAt: mine ? iso(this.lastSucceededAt) : null, lastAnsweredAt: mine ? iso(this.lastAnsweredAt) : null,
      today: mine ? { ...this.counts } : { enquiriesCopied: 0, callResultsCopied: 0, doNotCallRecorded: 0, skipped: 0, needsTheOwner: 0 },
      countingSince: new Date(startOfCounting).toISOString(),
      waitingAfterRepeatedFailures: mine ? stuck : 0,
      needsTheOwner: mine ? this.ownerItems.map(item => ({ ...item })) : [],
      sentences, summary: sentences.join(' '),
    };
  }
}

/**
 * Builds the feed for the web process. Never throws: a bad setting is logged once and leaves the feed off.
 * Writes use the CRM command identity as the brand's configured owner (see crm-feed-writer.ts).
 */
export function composeLeadRelayCrmFeed(input: { env: NodeJS.ProcessEnv; inbox: InboxCrmConfig | undefined; runner: CrmTransactionRunner | undefined;
  log?: Logger }): LeadRelayCrmFeed {
  const log = input.log ?? (() => undefined);
  let config: LeadRelayCrmFeedConfig;
  try { config = loadLeadRelayCrmFeedConfig(input.env, input.inbox); }
  catch { config = { state: 'invalid', problem: 'The LeadRelay settings could not be read.' }; }
  if (config.state === 'on' && !input.runner) config = { state: 'invalid', problem: 'The CRM database is not available to the web service.' };
  if (config.state === 'invalid') log(`LeadRelay CRM feed is off: ${config.problem}`);
  const writer = config.state === 'on' && input.runner ? new PgLeadRelayCrmWriter(input.runner, config.scope) : undefined;
  return new LeadRelayCrmFeed(config, { ...(writer ? { writer } : {}), log });
}
