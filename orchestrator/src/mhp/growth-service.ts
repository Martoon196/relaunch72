import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';

/**
 * Public sign-ups, member stories and the marketing send queue for
 * martinhowardproperty.co.uk. Replaces the Brevo forms and automations.
 */
export class MhpGrowthError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export const MHP_SITE_ORIGIN = 'https://martinhowardproperty.co.uk';
export const MHP_CONSENT_VERSION = 'site-2026-10';

export interface MhpScheduledSend { template: MhpTemplateKey; campaign: string; dueAt: string; expiresAt: string; context: Record<string, string> }
export type MhpTemplateKey = 'sheet_delivery' | 'webinar_confirm' | 'webinar_24h' | 'webinar_1h' | 'webinar_replay' | 'webinar_replay_plain'
  | 'webinar_followup' | 'webinar_90days' | 'webinar_casestudy' | 'application_received' | 'application_notify';
export interface MhpWebinarConfig { campaign: string; startsAt: string }
/** Where application notifications go, and the optional call-booking link shown to applicants. */
export interface MhpApplicationConfig { notifyTo: string; bookingUrl: string | null }
export interface MhpSignup {
  email: string; firstName: string | null; level: 'L1' | 'L2' | 'L3' | null; consent: boolean;
  kind: 'sheet' | 'webinar' | 'waitlist'; label: string; module: string | null; link: string | null;
}
export interface MhpClaimedSend {
  id: string; prospectId: string; template: string; campaign: string; context: Record<string, unknown>;
  email: string; firstName: string | null; level: string | null; attempts: number; expiresAt: string;
  /** Present only on application_notify sends: the application being announced to the owner. */
  application?: MhpApplicationRecord | null;
}
export const MHP_EXPERIENCE = ['None yet', 'Some reading or courses', 'Done a deal or two', 'Active in property'] as const;
export const MHP_DOORS = ['Refer', 'Source', 'Run', 'Own', 'Not sure yet'] as const;
export const MHP_HOURS = ['Under 5', '5 to 10', '10 to 15', '15 plus'] as const;
export const MHP_OBSTACLES = ['Direction', 'Skills', 'Time', 'Capital', 'Accountability', 'Something else'] as const;
export const MHP_SUPPORT = ['Group mentoring', 'Self-study', 'Not sure yet'] as const;
export const MHP_APPLICATION_SOURCES = ['live', 'replay', 'site', 'email'] as const;
export const MHP_EVENT_NAMES = ['webinar_page_viewed', 'live_page_opened', 'replay_page_opened', 'diagnostic_started',
  'diagnostic_completed', 'offer_viewed', 'application_started'] as const;
export type MhpEventName = typeof MHP_EVENT_NAMES[number];
export interface MhpApplication {
  name: string; email: string; phone: string | null; location: string; experience: string; door: string; hours: string;
  objective: string; obstacle: string; support: string; discuss: boolean; optIn: boolean; source: string;
}
export interface MhpApplicationRecord {
  id: string; name: string; email: string; phone: string | null; location: string; experience: string; door: string; hours: string;
  objective: string; obstacle: string; support: string; discuss: boolean; marketingConsent: boolean; source: string; status: string; createdAt: string;
}
export interface MhpGrowthSummary {
  prospects: number; unsubscribed: number; signupsToday: number;
  byKind: Record<string, number>; byLabel: { label: string; count: number }[]; byLevel: Record<string, number>;
  sends: { sent: number; pending: number; failed: number };
  stories: number; storiesWaiting: number;
  course: { modules: number; lessons: number; loadedAt: string | null };
  learners: number; lessonsCompleted: number;
  applications?: { total: number; today: number }; applicationsByDoor?: Record<string, number>; events?: Record<string, number>;
}

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sessionHash = (token: string): Buffer => {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new MhpGrowthError(403, 'Sign in to Martin Howard Property again.');
  return createHash('sha256').update(token).digest();
};
const clean = (value: string | undefined, max: number): string => {
  const text = (value ?? '').replace(/\r\n/g, '\n').trim();
  if (text.length > max || CONTROL.test(text)) throw new MhpGrowthError(400, 'Check the details in the form and try again.');
  return text;
};
const HOUR = 60 * 60_000;

/** Reads the public form fields the static site already sends (formerly to Brevo). */
export function parseMhpSignup(fields: URLSearchParams): MhpSignup | 'honeypot' {
  if ((fields.get('email_address_check') ?? '') !== '') return 'honeypot';
  const email = clean(fields.get('EMAIL') ?? '', 254).toLowerCase();
  if (!EMAIL.test(email)) throw new MhpGrowthError(400, 'Enter a valid email address.');
  const firstName = clean(fields.get('FIRSTNAME') ?? '', 100) || null;
  const rawLevel = (fields.get('LEVEL') ?? '').trim().toUpperCase();
  const level = rawLevel === 'L1' || rawLevel === 'L2' || rawLevel === 'L3' ? rawLevel : null;
  const label = clean(fields.get('CHEATSHEET') ?? '', 200) || 'Website sign-up';
  const module = clean(fields.get('CHEATSHEET_MODULE') ?? '', 40) || null;
  let link: string | null = clean(fields.get('CHEATSHEET_LINK') ?? '', 500) || null;
  if (link) {
    let parsed: URL;
    try { parsed = new URL(link); } catch { throw new MhpGrowthError(400, 'Check the details in the form and try again.'); }
    if (parsed.origin !== MHP_SITE_ORIGIN || parsed.username || parsed.password) throw new MhpGrowthError(400, 'Check the details in the form and try again.');
    link = parsed.toString();
  }
  const path = link ? new URL(link).pathname : '';
  const kind = path.startsWith('/webinar') || /^webinar\b/i.test(label) ? 'webinar'
    : path.startsWith('/cheat-sheets/') ? 'sheet' : 'waitlist';
  // Sheets and the waitlist require the box: its label covers the requested email and occasional tips.
  // Registering for the webinar is itself the request for the webinar emails; the box there is optional
  // and only adds marketing consent.
  const consent = fields.get('OPT_IN') === '1' || fields.get('OPT_IN') === 'on' || fields.get('OPT_IN') === 'true';
  if (!consent && kind !== 'webinar') throw new MhpGrowthError(400, 'Tick the box so we can email you.');
  return { email, firstName, level, consent, kind, label, module, link };
}

export function mhpWebinarConfig(env: NodeJS.ProcessEnv): MhpWebinarConfig {
  const startsAt = env.MHP_WEBINAR_STARTS_AT?.trim() || '2026-11-04T19:30:00Z';
  const parsed = Date.parse(startsAt);
  if (!Number.isFinite(parsed)) throw new Error('MHP_WEBINAR_STARTS_AT must be an ISO date-time');
  const campaign = env.MHP_WEBINAR_CAMPAIGN?.trim() || `webinar-${new Date(parsed).toISOString().slice(0, 10)}`;
  if (!/^[a-z0-9_-]{1,60}$/.test(campaign)) throw new Error('MHP_WEBINAR_CAMPAIGN is invalid');
  return { campaign, startsAt: new Date(parsed).toISOString() };
}

/**
 * The emails a sign-up asks for. Reminders that would arrive after their moment
 * are dropped; later steps keep their own times. Times are UTC: a 19:30 start in
 * November is 19:30 UK time, and the replay lands at 08:00 UK the next morning.
 * Service emails (confirmation, reminders, replay) go to every registrant; the
 * replay carries the mentoring offer only with marketing consent. The follow-up,
 * the 90-day offer and the case study are marketing and need consent.
 */
export function mhpSchedule(signup: MhpSignup, webinar: MhpWebinarConfig, now: number): MhpScheduledSend[] {
  const at = (ms: number): string => new Date(ms).toISOString();
  const context = { label: signup.label, module: signup.module ?? '', link: signup.link ?? '' };
  if (signup.kind === 'sheet') {
    return [{ template: 'sheet_delivery', campaign: `sheet-${(signup.module ?? 'site').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}`,
      dueAt: at(now), expiresAt: at(now + 7 * 24 * HOUR), context }];
  }
  if (signup.kind !== 'webinar') return [];
  const start = Date.parse(webinar.startsAt);
  const steps: { template: MhpTemplateKey; due: number; expires: number; marketing?: boolean }[] = [
    { template: 'webinar_confirm', due: now, expires: start },
    { template: 'webinar_24h', due: start - 24 * HOUR, expires: start - 2 * HOUR },
    { template: 'webinar_1h', due: start - HOUR, expires: start },
    { template: signup.consent ? 'webinar_replay' : 'webinar_replay_plain', due: start + 12.5 * HOUR, expires: start + 7 * 24 * HOUR },
    { template: 'webinar_followup', due: start + 36.5 * HOUR, expires: start + 8 * 24 * HOUR, marketing: true },
    // Saturday 08:00 UK. Founding applications close Saturday 23:59 UK, so this
    // expires at midnight at the end of that day (start + 76.5h).
    { template: 'webinar_90days', due: start + 60.5 * HOUR, expires: start + 76.5 * HOUR, marketing: true },
    { template: 'webinar_casestudy', due: start + 84.5 * HOUR, expires: start + 8 * 24 * HOUR, marketing: true },
  ];
  return steps
    .filter(step => step.expires > now && (!step.marketing || signup.consent))
    // A 24h reminder is pointless within two hours of the confirmation.
    .filter(step => !(step.template === 'webinar_24h' && step.due <= now))
    .map(step => ({ template: step.template, campaign: webinar.campaign, dueAt: at(Math.max(step.due, now)), expiresAt: at(step.expires), context }));
}

export function mhpApplicationConfig(env: NodeJS.ProcessEnv): MhpApplicationConfig {
  const notifyTo = (env.MHP_APPLICATION_NOTIFY_TO?.trim() || 'martin.howard1984@gmail.com').toLowerCase();
  if (notifyTo.length > 254 || !EMAIL.test(notifyTo)) throw new Error('MHP_APPLICATION_NOTIFY_TO must be one email address');
  const rawBooking = env.MHP_BOOKING_URL?.trim() || '';
  let bookingUrl: string | null = null;
  if (rawBooking) {
    let parsed: URL;
    try { parsed = new URL(rawBooking); } catch { throw new Error('MHP_BOOKING_URL must be an https URL'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || rawBooking.length > 500) throw new Error('MHP_BOOKING_URL must be an https URL');
    bookingUrl = parsed.toString();
  }
  return Object.freeze({ notifyTo, bookingUrl });
}

const line = (fields: URLSearchParams, name: string, max: number, min = 1): string => {
  const value = clean(fields.get(name) ?? '', max);
  if (value.length < min || /[\r\n\t]/.test(value)) throw new MhpGrowthError(400, 'Please answer every question before sending your application.');
  return value;
};
const choice = <T extends string>(fields: URLSearchParams, name: string, options: readonly T[]): T => {
  const value = (fields.get(name) ?? '').trim();
  if (!(options as readonly string[]).includes(value)) throw new MhpGrowthError(400, 'Please answer every question before sending your application.');
  return value as T;
};

/** The mentoring application form at /webinar/apply/. No savings or balances are collected. */
export function parseMhpApplication(fields: URLSearchParams): MhpApplication | 'honeypot' {
  if ((fields.get('email_address_check') ?? '') !== '') return 'honeypot';
  const email = clean(fields.get('EMAIL') ?? '', 254).toLowerCase();
  if (!EMAIL.test(email)) throw new MhpGrowthError(400, 'Enter a valid email address.');
  const phone = clean(fields.get('PHONE') ?? '', 30) || null;
  if (phone && !/^[0-9 +()-]+$/.test(phone)) throw new MhpGrowthError(400, 'Enter a phone number using digits, spaces and + ( ) - only.');
  const objective = clean(fields.get('OBJECTIVE') ?? '', 600);
  if (objective.length < 1) throw new MhpGrowthError(400, 'Please answer every question before sending your application.');
  if (fields.get('PRICE_UNDERSTOOD') !== 'yes') throw new MhpGrowthError(400, 'Please confirm you have seen the price before applying.');
  if (fields.get('CONSENT') !== '1') throw new MhpGrowthError(400, 'Tick the privacy box so we can look at your application.');
  const discuss = fields.get('DISCUSS');
  if (discuss !== 'yes' && discuss !== 'no') throw new MhpGrowthError(400, 'Please answer every question before sending your application.');
  const rawSource = (fields.get('SOURCE') ?? '').trim();
  const source = rawSource ? choice(fields, 'SOURCE', MHP_APPLICATION_SOURCES) : 'site';
  return {
    name: line(fields, 'NAME', 120), email, phone, location: line(fields, 'LOCATION', 120),
    experience: choice(fields, 'EXPERIENCE', MHP_EXPERIENCE), door: choice(fields, 'DOOR', MHP_DOORS), hours: choice(fields, 'HOURS', MHP_HOURS),
    objective, obstacle: choice(fields, 'OBSTACLE', MHP_OBSTACLES), support: choice(fields, 'SUPPORT', MHP_SUPPORT),
    discuss: discuss === 'yes', optIn: fields.get('OPT_IN') === '1', source,
  };
}

/** Cookieless page events from the site: `e=<name>&p=<path>`. Anything else is ignored. */
export function parseMhpEvent(body: string): { name: MhpEventName; path: string } | null {
  if (body.length > 512) return null;
  const fields = new URLSearchParams(body);
  const name = fields.get('e') ?? '';
  let path = (fields.get('p') ?? '').split(/[?#]/)[0] ?? '';
  if (!(MHP_EVENT_NAMES as readonly string[]).includes(name)) return null;
  if (path.length > 1 && path.endsWith('/')) path = path.replace(/\/+$/, '/');
  if (!/^\/[A-Za-z0-9/_.-]{0,119}$/.test(path)) return null;
  return { name: name as MhpEventName, path };
}

export interface MhpStory {
  name: string; town: string; email: string; door: string; did: string; before: string; changed: string;
  number: string; month: string; publishName: string; publishDoor: string; doNotSay: string | null;
}
const DOORS: readonly string[] = MHP_DOORS;
const PUBLISH_NAME = ['Yes, first name and town', 'First name only', 'No, keep me anonymous'];
export function parseMhpStory(fields: URLSearchParams): MhpStory {
  const field = (name: string, max: number, min = 1): string => {
    const value = clean(fields.get(name) ?? '', max);
    if (value.length < min) throw new MhpGrowthError(400, 'Please fill in every question before sending your story.');
    return value;
  };
  if (!['1', 'on', 'true'].includes(fields.get('CONSENT') ?? '')) throw new MhpGrowthError(400, 'Tick the permission box before sending your story.');
  const email = field('EMAIL', 254).toLowerCase();
  if (!EMAIL.test(email)) throw new MhpGrowthError(400, 'Enter a valid email address.');
  const story: MhpStory = {
    name: field('NAME', 120), town: field('TOWN', 120), email, door: field('DOOR', 20),
    did: field('WHAT_YOU_DID', 4000, 40), before: field('BEFORE', 4000), changed: field('WHAT_CHANGED', 4000),
    number: field('NUMBER', 200), month: field('WHEN', 7), publishName: field('PUBLISH_NAME', 40),
    publishDoor: field('PUBLISH_DOOR', 3), doNotSay: clean(fields.get('DO_NOT_SAY') ?? '', 2000) || null,
  };
  if (!DOORS.includes(story.door) || !PUBLISH_NAME.includes(story.publishName) || !['Yes', 'No'].includes(story.publishDoor)
      || !/^20[0-9]{2}-(0[1-9]|1[0-2])$/.test(story.month)) throw new MhpGrowthError(400, 'Check the choices in the form and try again.');
  // Stories never carry money claims.
  if (story.number.includes('£')) throw new MhpGrowthError(400, 'Please leave money amounts out of the number question: use doors, days, weeks or properties instead.');
  return story;
}

export function mhpUnsubscribeToken(secret: string, prospectId: string): string {
  return createHmac('sha256', secret).update('relaunch72/mhp-unsubscribe/v1\u0000').update(prospectId).digest('base64url');
}
export function verifyMhpUnsubscribeToken(secret: string, prospectId: string, token: string): boolean {
  if (!UUID.test(prospectId) || !/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
  const expected = Buffer.from(mhpUnsubscribeToken(secret, prospectId));
  const given = Buffer.from(token);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
export function mhpUnsubscribeUrl(secret: string, prospectId: string): string {
  return `https://app.martinhowardproperty.co.uk/email/unsubscribe?p=${encodeURIComponent(prospectId)}&t=${mhpUnsubscribeToken(secret, prospectId)}`;
}

export class PgMhpGrowthService {
  constructor(private readonly readPool: Pick<Pool, 'query'>, private readonly commandPool: Pick<Pool, 'query'>,
    private readonly webinar: MhpWebinarConfig, private readonly applications: MhpApplicationConfig = mhpApplicationConfig({})) {}

  async apply(application: MhpApplication, sourceHash: Buffer | null): Promise<{ applicationId: string; prospectId: string }> {
    try {
      const result = await this.commandPool.query<{ outcome: { applicationId: string; prospectId: string } }>(
        'SELECT app_private.mhp_record_application($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) AS outcome',
        [application.email, application.name, application.phone, application.location, application.experience, application.door, application.hours,
          application.objective, application.obstacle, application.support, true, application.discuss, application.optIn, MHP_CONSENT_VERSION,
          application.source, sourceHash?.length === 32 ? sourceHash : null, this.applications.notifyTo]);
      const outcome = result.rows[0]?.outcome;
      if (!outcome || !UUID.test(outcome.applicationId)) throw new MhpGrowthError(503, 'Applications are temporarily unavailable.');
      return outcome;
    } catch (error) {
      if (error instanceof MhpGrowthError) throw error;
      if ((error as { code?: string })?.code === '22023' || (error as { code?: string })?.code === '23514') throw new MhpGrowthError(400, 'Check the details in the form and try again.');
      throw new MhpGrowthError(503, 'Applications are temporarily unavailable.');
    }
  }

  /** Counts one page event. Never throws: the beacon always gets a 204. */
  async event(name: MhpEventName, path: string): Promise<boolean> {
    try {
      const result = await this.commandPool.query<{ counted: boolean }>('SELECT app_private.mhp_record_event($1,$2) AS counted', [name, path]);
      return result.rows[0]?.counted === true;
    } catch { return false; }
  }

  async listApplications(token: string): Promise<MhpApplicationRecord[]> {
    try {
      const result = await this.readPool.query<{ applications: MhpApplicationRecord[] }>('SELECT app_private.mhp_list_applications($1) AS applications', [sessionHash(token)]);
      const applications = result.rows[0]?.applications;
      return Array.isArray(applications) ? applications : [];
    } catch (error) {
      if (error instanceof MhpGrowthError) throw error;
      if ((error as { code?: string })?.code === '42501') throw new MhpGrowthError(403, 'Owner access is required for HQ.');
      throw new MhpGrowthError(503, 'Applications could not load.');
    }
  }

  async capture(signup: MhpSignup, sourceHash: Buffer | null, now = Date.now()): Promise<{ prospectId: string; queued: number }> {
    const schedule = mhpSchedule(signup, this.webinar, now);
    try {
      const result = await this.commandPool.query<{ outcome: { prospectId: string; queued: number } }>(
        'SELECT app_private.mhp_capture_signup($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) AS outcome',
        [signup.email, signup.firstName, signup.level, signup.consent, MHP_CONSENT_VERSION, signup.kind, signup.label,
          signup.module, signup.link, sourceHash?.length === 32 ? sourceHash : null, JSON.stringify(schedule)]);
      const outcome = result.rows[0]?.outcome;
      if (!outcome || !UUID.test(outcome.prospectId)) throw new MhpGrowthError(503, 'Sign-up is temporarily unavailable.');
      return outcome;
    } catch (error) {
      if (error instanceof MhpGrowthError) throw error;
      if ((error as { code?: string })?.code === '22023' || (error as { code?: string })?.code === '23514') throw new MhpGrowthError(400, 'Check the details in the form and try again.');
      throw new MhpGrowthError(503, 'Sign-up is temporarily unavailable.');
    }
  }

  async story(story: MhpStory, sourceHash: Buffer | null): Promise<void> {
    try {
      await this.commandPool.query('SELECT app_private.mhp_record_story($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',
        [story.name, story.town, story.email, story.door, story.did, story.before, story.changed, story.number, story.month,
          story.publishName, story.publishDoor, story.doNotSay, MHP_CONSENT_VERSION, sourceHash?.length === 32 ? sourceHash : null]);
    } catch (error) {
      if ((error as { code?: string })?.code === '23514') throw new MhpGrowthError(400, 'Check the details in the form and try again.');
      throw new MhpGrowthError(503, 'Story sharing is temporarily unavailable.');
    }
  }

  async unsubscribe(prospectId: string): Promise<boolean> {
    if (!UUID.test(prospectId)) return false;
    const result = await this.commandPool.query<{ done: boolean }>('SELECT app_private.mhp_unsubscribe_prospect($1) AS done', [prospectId]);
    return result.rows[0]?.done === true;
  }

  async claim(limit: number, leaseSeconds: number, onlyEmails: readonly string[] | null): Promise<MhpClaimedSend[]> {
    const result = await this.commandPool.query<{ claimed: MhpClaimedSend[] }>(
      'SELECT app_private.mhp_claim_marketing_sends($1,$2,$3) AS claimed', [limit, leaseSeconds, onlyEmails ? [...onlyEmails] : null]);
    const claimed = result.rows[0]?.claimed;
    return Array.isArray(claimed) ? claimed : [];
  }

  async settle(sendId: string, accepted: boolean, reference: string | null): Promise<void> {
    await this.commandPool.query('SELECT app_private.mhp_settle_marketing_send($1,$2,$3)', [sendId, accepted, reference]);
  }

  async summary(token: string): Promise<MhpGrowthSummary> {
    try {
      const result = await this.readPool.query<{ summary: MhpGrowthSummary }>('SELECT app_private.mhp_growth_summary($1) AS summary', [sessionHash(token)]);
      const summary = result.rows[0]?.summary;
      if (!summary) throw new MhpGrowthError(503, 'Growth figures could not load.');
      return summary;
    } catch (error) {
      if (error instanceof MhpGrowthError) throw error;
      if ((error as { code?: string })?.code === '42501') throw new MhpGrowthError(403, 'Owner access is required for HQ.');
      throw new MhpGrowthError(503, 'Growth figures could not load.');
    }
  }
}
