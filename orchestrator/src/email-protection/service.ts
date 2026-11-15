/**
 * Sender protection, running: the evaluator (after every relevant event and every 5 minutes), the account trip-wire,
 * the alert emails and the founder's Today lines. Decisions are the pure functions in rules.ts; the database stores
 * them under a compare-and-set (several instances may evaluate at once: one step wins, the others see 'stale') and
 * enforces the ladder's direction and the second-pause rule itself. Reads only the database: no Postmark call here.
 */
import { accountDecision, decide, tripFromNumbers, tripNumbers, type ProtectionCounts, type Trip } from './rules.js';
import { founderAlertEmail, founderLine, ownerAlertEmail, ownerTripped, type AlertEmail, type FounderLine } from './messages.js';
import type { ClaimedAlert, CounterKind, EmailProtectionStore, ProtectionStatus } from './store.js';
import { EmailProtectionAbsentError } from './store.js';

/** Sends one plain email to one address (the platform's own transactional sender). */
export interface ProtectionMailer { send(input: { to: string; subject: string; text: string; html: string }): Promise<void> }

export const EMAIL_PROTECTION_FOUNDER_EMAIL_ENV = 'EMAIL_PROTECTION_FOUNDER_EMAIL';
export const FOUNDER_ROUTE = '/portal/email/founder';
export const OWNER_ROUTE = '/portal/email';
const EMAIL = /^[^\s@<>",;:()[\]\\]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;
const escape = (value: string): string => value.replace(/[&<>"']/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

const levelOf = (kind: string): Trip['level'] => kind === 'slowed' ? 'slowed' : kind === 'sample_held' || kind === 'account_held' ? 'held' : 'paused';

export function alertHtml(email: AlertEmail): string {
  return `<div style="font:16px/1.6 Arial,sans-serif;color:#172b30;max-width:560px">${email.text.split('\n\n').map(p => `<p>${escape(p)}</p>`).join('')}<p><a href="${escape(email.link)}" style="display:inline-block;padding:12px 18px;background:#f2b440;color:#172b30;border-radius:8px;font-weight:700;text-decoration:none">${escape(email.linkLabel)}</a></p></div>`;
}

export interface FounderToday {
  /** False while the database has no sender protection (0155): there is nothing to report either way. */
  readonly available: boolean;
  /** False when nothing needs the founder: then there is nothing to show. */
  readonly needsYou: boolean;
  readonly lines: readonly (FounderLine & { readonly url: string })[];
  readonly sentences: readonly string[];
  readonly summary: string;
}

export class EmailProtectionService {
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly pending = new Map<string, Promise<void>>();

  constructor(private readonly input: { store: EmailProtectionStore; now?: () => number; log?: (line: string) => void;
    mailer?: ProtectionMailer | null; founderEmail?: string | null; portalOrigin?: string | null }) {
    this.now = input.now ?? Date.now;
    this.log = input.log ?? (() => undefined);
  }

  get store(): EmailProtectionStore { return this.input.store; }
  private mailer: ProtectionMailer | null = null;
  /** The platform's own transactional sender, set by the server once it is known (absent: alerts wait in the outbox). */
  setMailer(mailer: ProtectionMailer | null): void { this.mailer = mailer; }
  /** Whether alert emails can be sent at all (a platform sender is set). */
  get mailerConfigured(): boolean { return Boolean(this.mailer ?? this.input.mailer); }

  /**
   * One bounce, complaint or unsubscribe from a business's own stream (webhook or hourly read), counted once per
   * Postmark event id. Throws when the database could not record it (the webhook then asks Postmark to retry).
   */
  async count(input: { workspaceId: string; kind: CounterKind; key: string; at: number }): Promise<'recorded' | 'exists' | 'ignored' | null> {
    const outcome = await this.input.store.count(input.workspaceId, input.kind, input.key, input.at);
    if (outcome === 'recorded') this.soon(input.workspaceId);
    return outcome;
  }

  /** Evaluates a business soon (joined if one is already running); never throws. */
  soon(workspaceId: string): void {
    const key = workspaceId.toLowerCase();
    if (this.pending.has(key)) return;
    const run = this.evaluate(key).then(() => undefined, () => this.log(JSON.stringify({ event: 'email.protection.evaluate_failed', level: 'warn' })))
      .finally(() => this.pending.delete(key));
    this.pending.set(key, run);
  }
  /** For tests: wait for evaluations started by soon(). */
  async settled(): Promise<void> { await Promise.all([...this.pending.values()]); }

  private async decideOne(c: ProtectionCounts): Promise<string | null> {
    const decision = decide(c, this.now());
    if (!decision) return null;
    const numbers = { ...tripNumbers(decision.trip, c), newDailyCap: decision.daily, newHourlyCap: decision.hourly,
      ...(decision.kind === 'warmup_step' && decision.step !== null ? { step: decision.step } : {}) };
    const result = await this.input.store.apply(c.workspaceId, { from: decision.from, to: decision.to, kind: decision.kind, cause: decision.kind ? 'own' : null,
      reason: decision.reasonTrip ? ownerTripped(decision.reasonTrip) : decision.trip && decision.kind !== 'sample_held' ? ownerTripped(decision.trip) : null, numbers, daily: decision.daily, hourly: decision.hourly, step: decision.step, stepAt: decision.stepAt,
      sample: decision.sample });
    if (decision.kind && decision.kind !== 'warmup_step') this.log(JSON.stringify({ event: 'email.protection.step', level: ['paused', 'sample_held'].includes(decision.kind) || result === 'off' ? 'warn' : 'info',
      kind: result === 'off' ? 'switched_off' : decision.kind, workspace: c.workspaceId.slice(0, 8), result }));
    return result;
  }

  /** Judges one business now. Returns the stored answer ('stale' after a second try means another instance moved first). */
  async evaluate(workspaceId: string): Promise<string | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const numbers = await this.input.store.numbers();
      const c = numbers?.businesses.find(item => item.workspaceId === workspaceId.toLowerCase());
      if (!c) return null;
      const result = await this.decideOne(c);
      if (result !== 'stale') return result;
    }
    return 'stale';
  }

  /** Every business, then the account trip-wire. Never throws for one business's failure. */
  async evaluateAll(): Promise<void> {
    const first = await this.input.store.numbers();
    if (!first) return;
    for (const c of first.businesses) {
      try { await this.decideOne(c); }
      catch { this.log(JSON.stringify({ event: 'email.protection.evaluate_failed', level: 'warn', workspace: c.workspaceId.slice(0, 8) })); }
      // Counter rows no window can read any more (older than 180 days and than the 50th latest live send).
      try { await this.input.store.prune(c.workspaceId); } catch { this.log(JSON.stringify({ event: 'email.protection.prune_failed', level: 'warn' })); }
    }
    const numbers = await this.input.store.numbers();
    if (!numbers) return;
    const verdict = accountDecision(numbers.account, numbers.businesses);
    for (const item of verdict.pause) {
      const c = numbers.businesses.find(b => b.workspaceId === item.workspaceId)!;
      const result = await this.input.store.apply(c.workspaceId, { from: c.state, to: 'paused', kind: 'paused', cause: 'account', reason: ownerTripped(item.trip),
        numbers: tripNumbers(item.trip, c), daily: 0, hourly: 0, step: null, stepAt: null, sample: null }).catch(() => 'failed');
      this.log(JSON.stringify({ event: 'email.protection.account_tripwire_pause', level: 'warn', workspace: c.workspaceId.slice(0, 8), result }));
    }
    if (verdict.hold) {
      // The stored reason is about the whole account (a hold has no share of its own: never "0 of your 0").
      const result = await this.input.store.accountHold(ownerTripped(verdict.hold).slice(0, 300) || 'The whole account is close to Postmark\'s limit.',
        { line: verdict.hold.line, count: verdict.hold.count, total: verdict.hold.total, limit: verdict.hold.limit }).catch(() => 'failed');
      this.log(JSON.stringify({ event: 'email.protection.account_held', level: 'warn', result }));
    }
  }

  private url(path: string): string { return `${this.input.portalOrigin ?? ''}${path}`; }

  /** The email one claimed alert becomes, and who it goes to. */
  compose(alert: ClaimedAlert): { readonly email: AlertEmail; readonly to: readonly string[] } | null {
    const businessName = alert.businessName ?? 'A business';
    const trip = tripFromNumbers(alert.numbers, levelOf(alert.kind));
    if (alert.audience === 'owner') {
      const daily = typeof alert.numbers.newDailyCap === 'number' ? alert.numbers.newDailyCap : undefined;
      const email = ownerAlertEmail({ kind: alert.kind, businessName, trip, ...(daily !== undefined ? { dailyCap: daily } : {}), pageUrl: this.url(OWNER_ROUTE),
        secondPause: alert.kind === 'paused' && typeof alert.numbers.previousPauseAt === 'string' });
      return email ? { email, to: alert.ownerEmails.filter(address => EMAIL.test(address)) } : null;
    }
    const domain = typeof alert.numbers.domain === 'string' ? alert.numbers.domain : null;
    const email = founderAlertEmail({ kind: alert.kind, businessName, trip, pageUrl: this.url(FOUNDER_ROUTE), domain, secondPause: secondPauseOf(alert.kind, alert.numbers) });
    const founder = this.input.founderEmail?.trim().toLowerCase() ?? '';
    return email ? { email, to: EMAIL.test(founder) ? [founder] : [] } : null;
  }

  /** Sends what is waiting in the alert outbox (at most 20 a run). No mailer: nothing is claimed and the alerts wait. */
  async flushAlerts(): Promise<number> {
    const mailer = this.mailer ?? this.input.mailer;
    if (!mailer) return 0;
    let sent = 0;
    for (const alert of await this.input.store.claimAlerts(20)) {
      const composed = this.compose(alert);
      let ok = false;
      if (composed && composed.to.length) {
        try {
          for (const to of composed.to) await mailer.send({ to, subject: composed.email.subject, text: `${composed.email.text}\n\n${composed.email.linkLabel}: ${composed.email.link}`, html: alertHtml(composed.email) });
          ok = true;
        } catch { this.log(JSON.stringify({ event: 'email.protection.alert_failed', level: 'warn', kind: alert.kind, audience: alert.audience })); }
      }
      // Nothing to say (an informational step) is marked sent; nobody to send it to is retried, then given up.
      if (!composed) ok = true;
      await this.input.store.alertDone(alert.id, ok).catch(() => undefined);
      if (ok && composed) sent++;
    }
    return sent;
  }

  /** The founder's Today: one line per thing that needs them, each with one button. Nothing needs them: nothing shown. */
  async founderToday(): Promise<FounderToday> {
    let status: ProtectionStatus | null;
    try { status = await this.input.store.status(); }
    catch (error) { if (error instanceof EmailProtectionAbsentError) status = null; else throw error; }
    return founderToday(status, this.url(FOUNDER_ROUTE));
  }

  /** Evaluate and flush every intervalMs (5 minutes). Failures are logged; the next run tries again. */
  start(intervalMs = 5 * 60_000): () => void {
    let stopped = false, running = false;
    const tick = async () => {
      if (stopped || running) return;
      running = true;
      try { await this.evaluateAll(); } catch { this.log(JSON.stringify({ event: 'email.protection.evaluate_all_failed', level: 'warn' })); }
      try { await this.flushAlerts(); } catch { this.log(JSON.stringify({ event: 'email.protection.alerts_failed', level: 'warn' })); }
      running = false;
    };
    void tick();
    const timer = setInterval(() => { void tick(); }, intervalMs);
    timer.unref?.();
    return () => { stopped = true; clearInterval(timer); };
  }
}

/** A second own pause that stayed paused (0156 apply records previousPauseAt and sendsSinceRestart), or null. */
function secondPauseOf(kind: string, numbers: Readonly<Record<string, unknown>>): { readonly sendsSinceRestart: number } | null {
  if (kind !== 'paused' || typeof numbers.previousPauseAt !== 'string') return null;
  const n = numbers.sendsSinceRestart;
  return { sendsSinceRestart: typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : 0 };
}

/** Builds the founder's lines from the protection status (pure, for the Group HQ action and the founder's page). */
export function founderToday(status: ProtectionStatus | null, url: string): FounderToday {
  const lines: (FounderLine & { url: string })[] = [];
  if (status) {
    if (status.account.state === 'held') {
      const line = founderLine({ kind: 'account_held', businessName: '', trip: tripFromNumbers(status.account.numbers, 'held') });
      if (line) lines.push({ ...line, url });
    }
    for (const b of status.businesses) {
      const stepTrip = (level: Trip['level']) => tripFromNumbers(b.lastStep ?? null, level);
      // goLiveRequestedAt is only ever a request still open for the domain in use (the database drops one that was
      // approved, or made for another domain), so a new domain's request reaches the founder too.
      const kind = b.state === 'off' ? 'switched_off' : b.state === 'paused' ? 'paused' : b.sampleState === 'held' ? 'sample_held'
        : b.goLiveRequestedAt ? 'go_live_requested' : null;
      if (!kind) continue;
      const line = founderLine({ kind, businessName: b.businessName, trip: kind === 'go_live_requested' ? null : stepTrip(levelOf(kind)), domain: b.domain ?? null,
        secondPause: kind === 'paused' && b.lastStep ? secondPauseOf(b.lastStep.kind, b.lastStep) : null });
      if (line) lines.push({ ...line, workspaceId: b.workspaceId, url });
    }
  }
  lines.sort((a, b) => (a.tone === b.tone ? 0 : a.tone === 'red' ? -1 : 1));
  return Object.freeze({ available: status !== null, needsYou: lines.length > 0, lines: Object.freeze(lines), sentences: Object.freeze(lines.map(line => line.sentence)),
    summary: lines.length === 0 ? 'Email sending needs nothing from you.' : lines.length === 1 ? lines[0]!.sentence : `${lines.length} email sending items need you. ${lines[0]!.sentence}` });
}
