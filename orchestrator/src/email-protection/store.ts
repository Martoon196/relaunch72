/**
 * Where sender protection is kept (migration 0156), behind the r72_email_connection_definer functions only, on the
 * r72_identity_command identity. Owner calls pass the sha-256 of the portal session token; the database resolves the
 * session again and checks the owner (or, for the founder's buttons, the founder) itself.
 *
 * While the database still ends at 0155 the functions do not exist: every call then reports "absent" (null, or
 * EmailProtectionAbsentError for commands), nothing errors, and sending behaves exactly as it does today. The store
 * looks again after a few minutes, so applying 0156 takes effect without a restart.
 */
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { ProtectionCounts, ProtectionState, SampleState } from './rules.js';

export class EmailProtectionAbsentError extends Error {
  override readonly name = 'EmailProtectionAbsentError';
  constructor() { super('Sender protection is not in this database yet.'); }
}
export class EmailProtectionForbiddenError extends Error {
  override readonly name = 'EmailProtectionForbiddenError';
  constructor() { super('Not allowed.'); }
}
export class EmailProtectionInvalidError extends Error {
  override readonly name = 'EmailProtectionInvalidError';
  constructor() { super('Invalid input.'); }
}

export type ReserveOutcome = 'ok' | 'replayed' | 'replayed_refused' | 'replayed_unknown' | 'account_held' | 'off' | 'paused' | 'owner_paused' | 'not_live' | 'not_connected' | 'not_approved' | 'needs_test'
  | 'sample_wait' | 'sample_held' | 'daily_cap' | 'hourly_cap' | 'test_limit';
export type SendingCommand = 'test' | 'live' | 'pause' | 'resume';
export type SendingCommandOutcome = 'test' | 'live' | 'paused' | 'resumed' | 'unchanged' | 'requested' | 'already_requested' | 'not_connected' | 'switched_off'
  | 'needs_webhook' | 'needs_terms' | 'needs_footer' | 'needs_test';
export type FounderAction = 'approve' | 'lift' | 'reinstate' | 'release_sample' | 'lift_account';
export type FounderOutcome = 'done' | 'stale' | 'not_needed';
export type CounterKind = 'hard_bounce' | 'soft_bounce' | 'blocked' | 'complaint' | 'unsubscribe';

/** What the sender reads each sweep. */
export interface SendingConfig {
  readonly workspaceId: string; readonly status: string; readonly mode: 'off' | 'test' | 'live'; readonly serverId: number | null; readonly stream: string;
  readonly sealedServerToken: string | null; readonly fromName: string | null; readonly fromAddress: string | null; readonly replyTo: string | null;
  readonly businessName: string | null; readonly postalAddress: string | null; readonly testRecipients: readonly string[];
  readonly protectionState: ProtectionState; readonly protectionReason: string | null; readonly ownerPaused: boolean; readonly sampleState: SampleState;
  readonly dailyCap: number; readonly hourlyCap: number; readonly accountHeld: boolean; readonly liveDay: number; readonly liveHour: number;
  readonly goLiveRequestedAt: string | null; readonly goLiveApprovedAt: string | null;
  /** The founder approved a go-live for the domain now in use. */
  readonly approvedCurrent: boolean;
  /** A test was accepted for sending since the connection was last verified. */
  readonly testCurrent: boolean;
  readonly lastStep: (Readonly<Record<string, unknown>> & { readonly kind: string; readonly at: string }) | null;
}
export interface SendingDay { readonly day: string; readonly sends: number; readonly hardBounces: number; readonly softBounces: number; readonly blocked?: number; readonly complaints: number; readonly unsubscribes: number }
/** What the owner's page shows beyond 0155's state. */
export interface SendingState {
  /** Who tests go to when no test list is saved: the owner who agreed to the email rules (the sweep uses the same). */
  readonly defaultTestEmail: string | null;
  /** How many owner sign-in addresses an alert email could go to. */
  readonly ownerEmailCount: number;
  readonly testCurrent: boolean; readonly approvedCurrent: boolean;
  /** The latest alert email to the owner: 'sent', 'pending', 'given_up', or null (none). */
  readonly lastOwnerAlert: 'sent' | 'pending' | 'given_up' | null;
  readonly businessName: string | null; readonly postalAddress: string | null; readonly testRecipients: readonly string[];
  readonly testPassedAt: string | null; readonly ownerPausedAt: string | null; readonly goLiveRequestedAt: string | null; readonly goLiveApprovedAt: string | null;
  readonly sampleState: SampleState; readonly warmupStep: number; readonly accountHeld: boolean;
  readonly lastStep: (Readonly<Record<string, unknown>> & { readonly kind: string; readonly at: string }) | null;
  readonly counts: ProtectionCounts | null; readonly days: readonly SendingDay[];
}
export interface FounderBusiness {
  readonly workspaceId: string; readonly businessName: string; readonly status: string; readonly mode: 'off' | 'test' | 'live'; readonly state: ProtectionState;
  readonly reason: string | null; readonly since: string | null; readonly rowVersion: number; readonly goLiveRequestedAt: string | null; readonly goLiveApprovedAt: string | null;
  /** The domain in use now (a go-live request is only ever shown, and approved, for it). */
  readonly domain?: string | null;
  readonly sampleState: SampleState; readonly counts: ProtectionCounts | null;
  readonly lastStep: (Readonly<Record<string, unknown>> & { readonly kind: string; readonly at: string }) | null;
}
export interface ProtectionStatus {
  /** Alert emails given up on in the last 30 days (shown on the founder's page so none is lost). */
  readonly undelivered?: readonly { readonly workspaceId: string | null; readonly audience: 'owner' | 'founder'; readonly kind: string; readonly at: string }[];
  readonly account: { readonly state: 'ok' | 'held'; readonly reason: string | null; readonly since: string | null; readonly rowVersion: number; readonly numbers: Readonly<Record<string, unknown>> | null };
  readonly businesses: readonly FounderBusiness[];
}
export interface ProtectionNumbers {
  readonly account: { readonly state: 'ok' | 'held'; readonly sends7: number; readonly bounces7: number; readonly sends30: number; readonly complaints30: number };
  readonly businesses: readonly ProtectionCounts[];
}
export interface ApplyInput {
  readonly from: ProtectionState; readonly to: ProtectionState; readonly kind: string | null; readonly cause: 'own' | 'account' | null; readonly reason: string | null;
  readonly numbers: Readonly<Record<string, unknown>>; readonly daily: number; readonly hourly: number; readonly step: number | null; readonly stepAt: string | null;
  readonly sample: 'held' | 'passed' | null;
}
export interface ClaimedAlert {
  readonly id: string; readonly workspaceId: string | null; readonly audience: 'owner' | 'founder'; readonly kind: string;
  readonly numbers: Readonly<Record<string, unknown>>; readonly attempts: number; readonly businessName: string | null; readonly ownerEmails: readonly string[];
}

export interface EmailProtectionStore {
  /** null: no connection row, or 0156 is not applied (send exactly as today). */
  sendingConfig(workspaceId: string): Promise<SendingConfig | null>;
  reserve(workspaceId: string, key: string, purpose: 'live' | 'test'): Promise<ReserveOutcome>;
  settle(workspaceId: string, key: string, accepted: boolean): Promise<void>;
  /** 'ignored' when there is no connection row; null when 0156 is not applied. */
  count(workspaceId: string, kind: CounterKind, key: string, at: number): Promise<'recorded' | 'exists' | 'ignored' | null>;
  numbers(): Promise<ProtectionNumbers | null>;
  apply(workspaceId: string, input: ApplyInput): Promise<string>;
  accountHold(reason: string, numbers: Readonly<Record<string, unknown>>): Promise<string>;
  state(sessionToken: string, workspaceId: string): Promise<SendingState>;
  details(sessionToken: string, workspaceId: string, input: { businessName: string; postalAddress: string; testRecipients: readonly string[] }): Promise<void>;
  command(sessionToken: string, workspaceId: string, action: SendingCommand, terms: string, webhookOk: boolean): Promise<SendingCommandOutcome>;
  testReserve(sessionToken: string, workspaceId: string, key: string): Promise<ReserveOutcome>;
  testResult(sessionToken: string, workspaceId: string, key: string, accepted: boolean): Promise<void>;
  founderView(sessionToken: string): Promise<ProtectionStatus>;
  founderAct(sessionToken: string, workspaceId: string | null, action: FounderAction, version: number): Promise<FounderOutcome>;
  /** No session: the signed Group HQ read. null when 0156 is not applied. */
  status(): Promise<ProtectionStatus | null>;
  claimAlerts(limit: number): Promise<readonly ClaimedAlert[]>;
  /** Removes counter rows that can no longer change a decision (see the migration). */
  prune(workspaceId: string): Promise<number>;
  /** Restarts the retry window of due PP follow-up runs while sending is held (0156 pp_followup_hold_wait). */
  holdWait(): Promise<number>;
  alertDone(id: string, sent: boolean): Promise<void>;
  /** Whether the database has 0156; never throws. */
  present(): Promise<boolean>;
}

const ABSENT = new Set(['42883', '42P01', '3F000']);
const RECHECK_MS = 5 * 60_000;
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string | null => typeof value === 'string' ? value : null;
const int = (value: unknown): number => { const n = typeof value === 'string' && /^[0-9]{1,15}$/u.test(value) ? Number(value) : value; return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : 0; };
const STATES = new Set(['ok', 'slowed', 'paused', 'off']);
const SAMPLES = new Set(['none', 'sending', 'waiting', 'passed', 'held']);
const stateOf = (value: unknown): ProtectionState => STATES.has(String(value)) ? value as ProtectionState : 'ok';
const sampleOf = (value: unknown): SampleState => SAMPLES.has(String(value)) ? value as SampleState : 'none';
const modeOf = (value: unknown): 'off' | 'test' | 'live' => value === 'test' || value === 'live' ? value : 'off';
const hash = (token: string): Buffer => createHash('sha256').update(token).digest();
const strings = (value: unknown): readonly string[] => Array.isArray(value) ? Object.freeze(value.filter((item): item is string => typeof item === 'string')) : Object.freeze([]);

export function readCounts(value: unknown): ProtectionCounts | null {
  if (!record(value) || typeof value.workspaceId !== 'string') return null;
  return Object.freeze({
    workspaceId: value.workspaceId.toLowerCase(), businessName: str(value.businessName), status: String(value.status ?? ''), mode: modeOf(value.mode), state: stateOf(value.state),
    reason: str(value.reason), since: str(value.since), dailyCap: int(value.dailyCap), hourlyCap: int(value.hourlyCap), warmupStartedAt: str(value.warmupStartedAt),
    goLiveApprovedAt: str(value.goLiveApprovedAt), warmupStep: int(value.warmupStep), warmupStepAt: str(value.warmupStepAt), countedSince: str(value.countedSince),
    sampleState: sampleOf(value.sampleState), sampleStartedAt: str(value.sampleStartedAt), sampleFullAt: str(value.sampleFullAt), ownerPausedAt: str(value.ownerPausedAt),
    ownPauses90: int(value.ownPauses90), sends7: int(value.sends7), hard7: int(value.hard7), soft7: int(value.soft7), blocked7: int(value.blocked7),
    sendsSinceRestart: value.sendsSinceRestart == null ? null : int(value.sendsSinceRestart), sends30: int(value.sends30),
    complaints30: int(value.complaints30), unsubscribes30: int(value.unsubscribes30), last50Sends: int(value.last50Sends), hardLast50: int(value.hardLast50),
    liveDay: int(value.liveDay), liveHour: int(value.liveHour), sampleSends: int(value.sampleSends), sampleBounces: int(value.sampleBounces),
    sampleComplaints: int(value.sampleComplaints), stepSends: int(value.stepSends), stepBounces: int(value.stepBounces), stepComplaints: int(value.stepComplaints),
    stepBusyDays: int(value.stepBusyDays), domain: str(value.domain),
  });
}
const lastStep = (value: unknown) => record(value) && typeof value.kind === 'string' && typeof value.at === 'string'
  ? Object.freeze({ ...value, kind: value.kind, at: value.at }) : null;

export function readSendingConfig(value: unknown): SendingConfig | null {
  if (!record(value) || typeof value.workspaceId !== 'string') return null;
  return Object.freeze({ workspaceId: value.workspaceId.toLowerCase(), status: String(value.status ?? ''), mode: modeOf(value.mode),
    serverId: int(value.serverId) || null, stream: typeof value.stream === 'string' && /^[a-z0-9-]{1,60}$/u.test(value.stream) ? value.stream : 'broadcast',
    sealedServerToken: str(value.sealedServerToken), fromName: str(value.fromName), fromAddress: str(value.fromAddress), replyTo: str(value.replyTo),
    businessName: str(value.businessName), postalAddress: str(value.postalAddress), testRecipients: strings(value.testRecipients),
    protectionState: stateOf(value.protectionState), protectionReason: str(value.protectionReason), ownerPaused: value.ownerPaused === true, sampleState: sampleOf(value.sampleState),
    approvedCurrent: value.approvedCurrent === true, testCurrent: value.testCurrent === true,
    dailyCap: int(value.dailyCap), hourlyCap: int(value.hourlyCap), accountHeld: value.accountHeld === true, liveDay: int(value.liveDay), liveHour: int(value.liveHour),
    goLiveRequestedAt: str(value.goLiveRequestedAt), goLiveApprovedAt: str(value.goLiveApprovedAt), lastStep: lastStep(value.lastStep) });
}

function readStatus(value: unknown): ProtectionStatus {
  if (!record(value) || !record(value.account) || !Array.isArray(value.businesses)) throw new Error('Invalid protection status');
  const a = value.account;
  return Object.freeze({
    undelivered: Object.freeze(Array.isArray(value.undelivered) ? value.undelivered.filter(record).map(u => Object.freeze({ workspaceId: str(u.workspaceId),
      audience: u.audience === 'owner' ? 'owner' as const : 'founder' as const, kind: String(u.kind), at: String(u.at) })) : []),
    account: Object.freeze({ state: a.state === 'held' ? 'held' : 'ok', reason: str(a.reason), since: str(a.since), rowVersion: int(a.rowVersion), numbers: record(a.numbers) ? a.numbers : null }),
    businesses: Object.freeze(value.businesses.filter(record).map(b => Object.freeze({ workspaceId: String(b.workspaceId).toLowerCase(), businessName: str(b.businessName) ?? 'This business',
      status: String(b.status ?? ''), mode: modeOf(b.mode), state: stateOf(b.state), reason: str(b.reason), since: str(b.since), rowVersion: int(b.rowVersion),
      goLiveRequestedAt: str(b.goLiveRequestedAt), goLiveApprovedAt: str(b.goLiveApprovedAt), domain: str(b.domain), sampleState: sampleOf(b.sampleState), counts: readCounts(b.counts),
      lastStep: lastStep(b.lastStep) }))),
  });
}

export class PgEmailProtectionStore implements EmailProtectionStore {
  private absentUntil = 0;
  private answered = false;
  constructor(private readonly pool: Pick<Pool, 'query'>, private readonly options: { now?: () => number; log?: (line: string) => void } = {}) {}
  private now(): number { return this.options.now?.() ?? Date.now(); }

  private async call<T>(sql: string, values: unknown[]): Promise<T> {
    if (!this.answered && this.now() < this.absentUntil) throw new EmailProtectionAbsentError();
    try {
      const result = await this.pool.query<{ value: T }>(sql, values);
      this.answered = true; this.absentUntil = 0;
      return result.rows[0]!.value;
    } catch (error) {
      const code = String((error as { code?: unknown })?.code ?? '');
      if (ABSENT.has(code)) {
        if (this.answered) { this.options.log?.(JSON.stringify({ event: 'email.protection.store_missing_after_use', level: 'warn', code })); throw error; }
        if (this.absentUntil === 0) this.options.log?.(JSON.stringify({ event: 'email.protection.store_absent', level: 'info',
          message: 'Sender protection (0156) is not in this database yet; email is sent exactly as before.' }));
        this.absentUntil = this.now() + RECHECK_MS;
        throw new EmailProtectionAbsentError();
      }
      if (code === '42501') throw new EmailProtectionForbiddenError();
      if (code === '22023') throw new EmailProtectionInvalidError();
      throw error;
    }
  }
  private async optional<T>(sql: string, values: unknown[]): Promise<T | null> {
    try { return await this.call<T>(sql, values); } catch (error) { if (error instanceof EmailProtectionAbsentError) return null; throw error; }
  }

  async present(): Promise<boolean> {
    if (this.answered) return true;
    if (this.now() < this.absentUntil) return false;
    try {
      const result = await this.pool.query<{ ready: boolean }>(`/* email-protection.schema-readiness */
        SELECT to_regprocedure('app_private.email_sending_config(uuid)') IS NOT NULL AS ready`);
      if (result.rows[0]?.ready === true) return true;
      this.absentUntil = this.now() + RECHECK_MS;
      return false;
    } catch { return false; }
  }

  async sendingConfig(workspaceId: string): Promise<SendingConfig | null> {
    return readSendingConfig(await this.optional<unknown>('SELECT app_private.email_sending_config($1) AS value', [workspaceId]));
  }
  async reserve(workspaceId: string, key: string, purpose: 'live' | 'test'): Promise<ReserveOutcome> {
    return await this.call<ReserveOutcome>('SELECT app_private.email_send_reserve($1,$2,$3) AS value', [workspaceId, key, purpose]);
  }
  async settle(workspaceId: string, key: string, accepted: boolean): Promise<void> {
    await this.call('SELECT app_private.email_send_settle($1,$2,$3) AS value', [workspaceId, key, accepted]);
  }
  async count(workspaceId: string, kind: CounterKind, key: string, at: number): Promise<'recorded' | 'exists' | 'ignored' | null> {
    return this.optional<'recorded' | 'exists' | 'ignored'>('SELECT app_private.email_counter_record($1,$2,$3,$4) AS value',
      [workspaceId, kind, key, new Date(Math.min(at, this.now())).toISOString()]);
  }
  async numbers(): Promise<ProtectionNumbers | null> {
    const value = await this.optional<unknown>('SELECT app_private.email_protection_numbers() AS value', []);
    if (value === null) return null;
    if (!record(value) || !record(value.account) || !Array.isArray(value.businesses)) throw new Error('Invalid protection numbers');
    const a = value.account;
    return { account: { state: a.state === 'held' ? 'held' : 'ok', sends7: int(a.sends7), bounces7: int(a.bounces7), sends30: int(a.sends30), complaints30: int(a.complaints30) },
      businesses: value.businesses.map(readCounts).filter((item): item is ProtectionCounts => item !== null) };
  }
  async apply(workspaceId: string, input: ApplyInput): Promise<string> {
    return await this.call<string>('SELECT app_private.email_protection_apply($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12) AS value',
      [workspaceId, input.from, input.to, input.kind, input.cause, input.reason, JSON.stringify(input.numbers), input.daily, input.hourly, input.step, input.stepAt, input.sample]);
  }
  async accountHold(reason: string, numbers: Readonly<Record<string, unknown>>): Promise<string> {
    return await this.call<string>('SELECT app_private.email_account_apply($1,$2,$3,$4::jsonb) AS value', ['ok', 'held', reason, JSON.stringify(numbers)]);
  }
  async state(sessionToken: string, workspaceId: string): Promise<SendingState> {
    const value = await this.call<unknown>('SELECT app_private.email_sending_state($1,$2) AS value', [hash(sessionToken), workspaceId]);
    if (!record(value)) throw new Error('Invalid sending state');
    return Object.freeze({ defaultTestEmail: str(value.defaultTestEmail), ownerEmailCount: int(value.ownerEmailCount), testCurrent: value.testCurrent === true,
      approvedCurrent: value.approvedCurrent === true,
      lastOwnerAlert: value.lastOwnerAlert === 'sent' || value.lastOwnerAlert === 'pending' || value.lastOwnerAlert === 'given_up' ? value.lastOwnerAlert : null,
      businessName: str(value.businessName), postalAddress: str(value.postalAddress), testRecipients: strings(value.testRecipients),
      testPassedAt: str(value.testPassedAt), ownerPausedAt: str(value.ownerPausedAt), goLiveRequestedAt: str(value.goLiveRequestedAt), goLiveApprovedAt: str(value.goLiveApprovedAt),
      sampleState: sampleOf(value.sampleState), warmupStep: int(value.warmupStep), accountHeld: value.accountHeld === true, lastStep: lastStep(value.lastStep),
      counts: readCounts(value.counts), days: Array.isArray(value.days) ? value.days.filter(record).map(d => Object.freeze({ day: String(d.day), sends: int(d.sends),
        hardBounces: int(d.hardBounces), softBounces: int(d.softBounces), blocked: int(d.blocked), complaints: int(d.complaints), unsubscribes: int(d.unsubscribes) })) : [] });
  }
  async details(sessionToken: string, workspaceId: string, input: { businessName: string; postalAddress: string; testRecipients: readonly string[] }): Promise<void> {
    await this.call('SELECT app_private.email_sending_details($1,$2,$3,$4,$5) AS value', [hash(sessionToken), workspaceId, input.businessName, input.postalAddress, [...input.testRecipients]]);
  }
  async command(sessionToken: string, workspaceId: string, action: SendingCommand, terms: string, webhookOk: boolean): Promise<SendingCommandOutcome> {
    return await this.call<SendingCommandOutcome>('SELECT app_private.email_sending_command($1,$2,$3,$4,$5) AS value', [hash(sessionToken), workspaceId, action, terms, webhookOk]);
  }
  async testReserve(sessionToken: string, workspaceId: string, key: string): Promise<ReserveOutcome> {
    return await this.call<ReserveOutcome>('SELECT app_private.email_sending_test_reserve($1,$2,$3) AS value', [hash(sessionToken), workspaceId, key]);
  }
  async testResult(sessionToken: string, workspaceId: string, key: string, accepted: boolean): Promise<void> {
    await this.call('SELECT app_private.email_sending_test_result($1,$2,$3,$4) AS value', [hash(sessionToken), workspaceId, key, accepted]);
  }
  async founderView(sessionToken: string): Promise<ProtectionStatus> {
    return readStatus(await this.call<unknown>('SELECT app_private.email_protection_founder_view($1) AS value', [hash(sessionToken)]));
  }
  async founderAct(sessionToken: string, workspaceId: string | null, action: FounderAction, version: number): Promise<FounderOutcome> {
    return await this.call<FounderOutcome>('SELECT app_private.email_protection_founder_act($1,$2,$3,$4) AS value', [hash(sessionToken), workspaceId, action, version]);
  }
  async status(): Promise<ProtectionStatus | null> {
    const value = await this.optional<unknown>('SELECT app_private.email_protection_status() AS value', []);
    return value === null ? null : readStatus(value);
  }
  async claimAlerts(limit: number): Promise<readonly ClaimedAlert[]> {
    const value = await this.optional<unknown>('SELECT app_private.email_protection_alerts_claim($1) AS value', [limit]);
    if (!Array.isArray(value)) return [];
    return value.filter(record).map(a => Object.freeze({ id: String(a.id), workspaceId: str(a.workspaceId), audience: a.audience === 'owner' ? 'owner' as const : 'founder' as const,
      kind: String(a.kind), numbers: record(a.numbers) ? a.numbers : {}, attempts: int(a.attempts), businessName: str(a.businessName), ownerEmails: strings(a.ownerEmails) }));
  }
  async prune(workspaceId: string): Promise<number> {
    return Number(await this.optional<number>('SELECT app_private.email_send_events_prune($1) AS value', [workspaceId]) ?? 0);
  }
  async holdWait(): Promise<number> {
    return Number(await this.optional<number>('SELECT app_private.pp_followup_hold_wait() AS value', []) ?? 0);
  }
  async alertDone(id: string, sent: boolean): Promise<void> {
    await this.call('SELECT app_private.email_protection_alert_done($1,$2) AS value', [id, sent]);
  }
}
