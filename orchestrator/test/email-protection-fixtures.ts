/**
 * An in-memory stand-in for migration 0156's sender protection, with the same rules the database enforces (the
 * ladder's direction, the second own pause within 90 days becoming off, compare-and-set, founder-only buttons), so
 * the service and the pages can be tested without PostgreSQL. All values are synthetic.
 */
import type { ApplyInput, ClaimedAlert, CounterKind, EmailProtectionStore, FounderAction, FounderOutcome, ProtectionNumbers, ProtectionStatus, ReserveOutcome,
  SendingCommand, SendingCommandOutcome, SendingConfig, SendingState } from '../src/email-protection/store.js';
import { EmailProtectionAbsentError, EmailProtectionForbiddenError } from '../src/email-protection/store.js';
import type { ProtectionCounts, ProtectionState } from '../src/email-protection/rules.js';

export const PP_WS = 'd975ff66-336a-46c2-b36b-d7095a11af97';
export const OWNER = 'owner-session-token-0123456789abcdef';
export const FOUNDER = 'founder-session-token-0123456789abcd';

export class MemoryProtectionStore implements EmailProtectionStore {
  absent = false;
  counts: ProtectionCounts;
  config: SendingConfig | null;
  rowVersion = 3;
  readonly applied: (ApplyInput & { result: string })[] = [];
  readonly events: { kind: string; numbers: Record<string, unknown>; actor: string | null; at: number }[] = [];
  readonly alerts: (ClaimedAlert & { done?: boolean | undefined })[] = [];
  readonly commands: { action: SendingCommand; terms: string; webhookOk: boolean }[] = [];
  readonly reserved: { key: string; purpose: string }[] = [];
  readonly counted = new Set<string>();
  account: ProtectionNumbers['account'] = { state: 'ok', sends7: 0, bounces7: 0, sends30: 0, complaints30: 0 };
  others: ProtectionCounts[] = [];
  sending: SendingState;
  commandAnswer: SendingCommandOutcome | null = null;
  reserveAnswer: ReserveOutcome = 'ok';
  failNumbers = false;
  constructor(counts: ProtectionCounts, private readonly now: () => number = Date.now) {
    this.counts = counts;
    this.config = null;
    this.sending = { defaultTestEmail: 'owner@pp-send-proof.co.uk', ownerEmailCount: 1, testCurrent: true, approvedCurrent: false, lastOwnerAlert: null, businessName: 'Property Predator Ltd', postalAddress: '1 High Street, Leeds LS1 1AA', testRecipients: [],
      testPassedAt: null, ownerPausedAt: null, goLiveRequestedAt: null, goLiveApprovedAt: null, sampleState: counts.sampleState, warmupStep: counts.warmupStep, accountHeld: false,
      lastStep: null, counts, days: [] };
  }
  private gone(): void { if (this.absent) throw new EmailProtectionAbsentError(); }
  async present(): Promise<boolean> { return !this.absent; }
  async sendingConfig(): Promise<SendingConfig | null> { return this.absent ? null : this.config; }
  async reserve(_ws: string, key: string, purpose: 'live' | 'test'): Promise<ReserveOutcome> { this.gone(); this.reserved.push({ key, purpose }); return this.reserveAnswer; }
  async settle(): Promise<void> { this.gone(); }
  async count(_ws: string, kind: CounterKind, key: string): Promise<'recorded' | 'exists' | 'ignored' | null> {
    if (this.absent) return null;
    const id = `${kind}:${key}`;
    if (this.counted.has(id)) return 'exists';
    this.counted.add(id);
    return 'recorded';
  }
  async numbers(): Promise<ProtectionNumbers | null> {
    if (this.failNumbers) throw new Error('down');
    return this.absent ? null : { account: this.account, businesses: [this.counts, ...this.others] };
  }
  private note(kind: string, numbers: Record<string, unknown>, actor: string | null, owner: boolean, founder: boolean, ws: string | null = PP_WS): void {
    this.events.push({ kind, numbers, actor, at: this.now() });
    const alert = (audience: 'owner' | 'founder') => this.alerts.push({ id: `alert-${this.alerts.length + 1}`, workspaceId: ws, audience, kind, numbers, attempts: 1,
      businessName: 'Property Predator Ltd', ownerEmails: audience === 'owner' ? ['owner@pp-send-proof.co.uk'] : [] });
    if (owner) alert('owner');
    if (founder) alert('founder');
  }
  async apply(workspaceId: string, input: ApplyInput): Promise<string> {
    this.gone();
    const target = workspaceId === this.counts.workspaceId ? this.counts : this.others.find(o => o.workspaceId === workspaceId);
    let result: string;
    if (!target) result = 'refused';
    else if (target.state !== input.from) result = 'stale';
    else if (!(input.from === input.to || (input.from === 'ok' && input.to !== 'ok') || (input.from === 'slowed' && ['ok', 'paused', 'off'].includes(input.to)))) result = 'refused';
    else {
      let to: ProtectionState = input.to, kind = input.kind;
      if (to === 'paused' && input.from !== 'paused' && (input.cause ?? 'own') === 'own'
          && this.events.some(e => e.kind === 'paused' && e.numbers.cause === 'own' && this.now() - e.at < 90 * 86_400_000)) {
        // As 0156: off only once 50 live sends went out since the founder's restart; with fewer, paused again.
        const own = this.events.filter(e => ['paused', 'switched_off'].includes(e.kind) && e.numbers.cause === 'own' && this.now() - e.at < 90 * 86_400_000).length;
        // ... and always on the third own pause within 90 days.
        if (target.countedSince == null || (target.sendsSinceRestart ?? 0) >= 50 || own >= 2) { to = 'off'; kind = 'switched_off'; }
      }
      const next = { ...target, state: to, dailyCap: ['paused', 'off'].includes(to) ? 0 : input.daily, hourlyCap: ['paused', 'off'].includes(to) ? 0 : input.hourly,
        warmupStep: input.step ?? target.warmupStep, warmupStepAt: input.stepAt ?? target.warmupStepAt, sampleState: input.sample ?? target.sampleState,
        since: to === input.from ? target.since : new Date(this.now()).toISOString() };
      if (target === this.counts) this.counts = next; else this.others[this.others.indexOf(target)] = next;
      if (kind) this.note(kind, { ...input.numbers, cause: input.cause ?? 'own', from: input.from, to }, null, ['slowed', 'paused', 'switched_off', 'sample_held'].includes(kind),
        ['paused', 'switched_off'].includes(kind), workspaceId);
      this.rowVersion++;
      result = to === input.from && !kind ? 'unchanged' : to;
    }
    this.applied.push({ ...input, result });
    return result;
  }
  async accountHold(_reason: string, numbers: Readonly<Record<string, unknown>>): Promise<string> {
    if (this.account.state !== 'ok') return 'stale';
    this.account = { ...this.account, state: 'held' };
    this.note('account_held', { ...numbers }, null, false, true, null);
    return 'held';
  }
  private owner(token: string): void { if (token !== OWNER) throw new EmailProtectionForbiddenError(); }
  async state(token: string): Promise<SendingState> { this.gone(); this.owner(token); return { ...this.sending, counts: this.counts, sampleState: this.counts.sampleState }; }
  async details(token: string, _ws: string, input: { businessName: string; postalAddress: string; testRecipients: readonly string[] }): Promise<void> {
    this.gone(); this.owner(token); this.sending = { ...this.sending, ...input };
  }
  async command(token: string, _ws: string, action: SendingCommand, terms: string, webhookOk: boolean): Promise<SendingCommandOutcome> {
    this.gone(); this.owner(token); this.commands.push({ action, terms, webhookOk });
    return this.commandAnswer ?? (action === 'live' ? 'requested' : action === 'test' ? 'test' : action === 'pause' ? 'paused' : 'resumed');
  }
  testResults: { key: string; accepted: boolean }[] = [];
  async testReserve(token: string, _ws: string, key: string): Promise<ReserveOutcome> { this.gone(); this.owner(token); this.reserved.push({ key, purpose: 'test' }); return this.reserveAnswer; }
  async testResult(token: string, _ws: string, key: string, accepted: boolean): Promise<void> { this.owner(token); this.testResults.push({ key, accepted }); }
  status_(): ProtectionStatus {
    const c = this.counts;
    return { account: { state: this.account.state, reason: null, since: null, rowVersion: 1, numbers: this.events.filter(e => e.kind === 'account_held').at(-1)?.numbers ?? null },
      businesses: [{ workspaceId: c.workspaceId, businessName: 'Property Predator Ltd', status: c.status, mode: c.mode, state: c.state, reason: c.reason, since: c.since,
        rowVersion: this.rowVersion, goLiveRequestedAt: this.sending.goLiveRequestedAt, goLiveApprovedAt: this.sending.goLiveApprovedAt, sampleState: c.sampleState, counts: c,
        lastStep: (() => { const e = this.events.filter(x => ['slowed', 'paused', 'switched_off', 'sample_held'].includes(x.kind)).at(-1); return e ? { ...e.numbers, kind: e.kind, at: new Date(e.at).toISOString() } : null; })() }] };
  }
  readonly founderActs: { action: FounderAction; ws: string | null; version: number }[] = [];
  async founderView(token: string): Promise<ProtectionStatus> { this.gone(); if (token !== FOUNDER) throw new EmailProtectionForbiddenError(); return this.status_(); }
  async founderAct(token: string, ws: string | null, action: FounderAction, version: number): Promise<FounderOutcome> {
    this.gone(); if (token !== FOUNDER) throw new EmailProtectionForbiddenError();
    this.founderActs.push({ action, ws, version });
    if (version !== this.rowVersion && action !== 'lift_account') return 'stale';
    if (action === 'lift' && this.counts.state === 'paused') { this.counts = { ...this.counts, state: 'slowed' }; this.note('lifted', {}, token, true, false); return 'done'; }
    if (action === 'reinstate' && this.counts.state === 'off') { this.counts = { ...this.counts, state: 'slowed' }; this.note('reinstated', {}, token, true, false); return 'done'; }
    if (action === 'approve' && this.sending.goLiveRequestedAt && !this.sending.goLiveApprovedAt) { this.sending = { ...this.sending, goLiveApprovedAt: new Date().toISOString() }; return 'done'; }
    return 'not_needed';
  }
  async status(): Promise<ProtectionStatus | null> { return this.absent ? null : this.status_(); }
  async claimAlerts(limit: number): Promise<readonly ClaimedAlert[]> { return this.alerts.filter(a => a.done === undefined).slice(0, limit).map(a => { a.done = false; return a; }); }
  readonly done: { id: string; sent: boolean }[] = [];
  pruned = 0; waited = 0;
  async prune(): Promise<number> { this.pruned++; return 0; }
  async holdWait(): Promise<number> { this.waited++; return 0; }
  async alertDone(id: string, sent: boolean): Promise<void> { this.done.push({ id, sent }); const a = this.alerts.find(x => x.id === id); if (a) a.done = sent ? true : undefined; }
}

/** One business's counters (the shape app_private.email_protection_counts returns), all clean by default. */
export function counts(over: Partial<ProtectionCounts> = {}): ProtectionCounts {
  return { workspaceId: PP_WS, status: 'verified', mode: 'live', state: 'ok', reason: null, since: null, dailyCap: 50, hourlyCap: 13, warmupStartedAt: '2026-11-01T00:00:00.000Z',
    goLiveApprovedAt: '2026-11-01T00:00:00.000Z', warmupStep: 0, warmupStepAt: new Date(Date.parse('2026-11-19T12:00:00.000Z')).toISOString(), countedSince: null, sampleState: 'passed', sampleStartedAt: null,
    sampleFullAt: null, ownerPausedAt: null, ownPauses90: 0, sends7: 0, hard7: 0, soft7: 0, sends30: 0, complaints30: 0, unsubscribes30: 0, last50Sends: 0, hardLast50: 0,
    liveDay: 0, liveHour: 0, sampleSends: 0, sampleBounces: 0, sampleComplaints: 0, stepSends: 0, stepBounces: 0, stepComplaints: 0, stepBusyDays: 0, ...over };
}

