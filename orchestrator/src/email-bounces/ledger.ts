/**
 * The durable email block ledger (migration 0153, app_private.email_address_blocks).
 *
 * One row per brand workspace, email source, address and reason, written by the Postmark webhook and the catch-up
 * sweep and read by every send guard. Only the Martin Howard Property and Property Predator workspaces are kept here
 * (the table is pinned to them); any other workspace stays on the in-process list alone.
 *
 * While the database still ends at 0152 the functions do not exist. Every call then answers "unavailable" and the
 * caller carries on exactly as before 0153 (the in-process list and the provider's own lists). The ledger looks
 * again after a few minutes, so applying 0153 takes effect without a restart. Once the ledger has answered in this
 * process, a missing function or table is a real fault, not "0153 not applied yet": it is thrown and logged at warn
 * every time. Any other database error is thrown too; the send guard decides (marketing fails closed). Errors and
 * log lines never carry an address.
 */

import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { EmailBlockReason, EmailPurpose, EmailSendDecision, LastingBlockReason } from './policy.js';

export const EMAIL_LEDGER_WORKSPACES: ReadonlySet<string> = new Set([
  '2789228d-55a6-4688-b1e8-2f70abca990b', // Martin Howard Property
  'd975ff66-336a-46c2-b36b-d7095a11af97', // Property Predator
]);

/** The ledger's own reason words. The in-process list says 'unsubscribed' where the ledger says 'unsubscribe'. */
export type LedgerReason = 'hard_bounce' | 'spam_complaint' | 'unsubscribe' | 'manual';
export const toLedgerReason = (reason: LastingBlockReason): LedgerReason => reason === 'unsubscribed' ? 'unsubscribe' : reason;
const fromLedgerReason = (reason: LedgerReason): 'hard_bounce' | 'spam_complaint' | 'manual' | 'unsubscribed' => reason === 'unsubscribe' ? 'unsubscribed' : reason;

/**
 * A durable answer. reallowed: an unsubscribe exists but a sign-up since lets marketing go again. cleared: per
 * reason, the latest event time up to which the ledger has cleared this address for that reason (a lift, or a
 * re-allowed unsubscribe); a block this process holds from a webhook AFTER that time, for that reason, still counts.
 */
export type LedgerCleared = Partial<Record<EmailBlockReason, number>>;
export type LedgerDecision = EmailSendDecision & { readonly reallowed: boolean; readonly cleared: LedgerCleared };
/** alreadyLifted: nothing was lifted by this press because an owner had already lifted the hard bounce. */
export interface OwnerLiftResult { readonly lifted: number; readonly released: number; readonly spamComplaint: boolean; readonly alreadyLifted: boolean }
export interface LedgerLift { readonly email: string; readonly reason: EmailBlockReason; readonly liftedAt: number }
export type LedgerStatus = 'unknown' | 'available' | 'absent';
export interface LedgerRow {
  readonly email: string; readonly reason: 'hard_bounce' | 'spam_complaint' | 'manual' | 'unsubscribed'; readonly scope: 'all' | 'marketing';
  readonly sourceKey: string; readonly stream: string | null; readonly since: number; readonly reallowed: boolean;
}
export type LedgerWrite = 'recorded' | 'renewed' | 'exists' | 'unavailable';

export interface EmailBlockLedger {
  /** True when this workspace is kept in the ledger at all (whether or not 0153 is applied yet). */
  covers(workspaceId: string): boolean;
  /** 'available' once a call has answered in this process; 'absent' while the database still ends before 0153. */
  status(): LedgerStatus;
  /** null: 0153 is not applied (use the in-process list, as before). Throws when the database could not answer. */
  decide(workspaceId: string, email: string, purpose: EmailPurpose): Promise<LedgerDecision | null>;
  /** One provider event. Throws only when the ledger exists and the write failed (so a webhook can ask for a retry). */
  record(input: { workspaceId: string; sourceKey: string; email: string; reason: LastingBlockReason; eventId: string | null; stream: string | null; at: number }): Promise<LedgerWrite>;
  /**
   * One stream's provider list. at null: the provider gave no time; the first time it is seen is kept, never renewed.
   * Returns how many rows were new and how many could not be recorded, or null when the ledger is unavailable.
   */
  recordList(input: { workspaceId: string; sourceKey: string; stream: string; rows: readonly { email: string; reason: LastingBlockReason; at: number | null }[] }): Promise<{ added: number; skipped: number } | null>;
  /** An explicit provider re-subscribe: lifts that source's unsubscribe for the address, nothing else. */
  lift(input: { workspaceId: string; sourceKey: string; email: string; eventId: string | null; at: number }): Promise<number | null>;
  /** Current rows, and lifted (address, reason) pairs, for the owner page and the process cache; null when unavailable. */
  rows(workspaceId: string, limit?: number): Promise<{ readonly current: readonly LedgerRow[]; readonly lifted: readonly LedgerLift[] } | null>;
  /**
   * The brand owner says a hard-bounced address works now (their own portal session token is checked in SQL). Lifts
   * the hard bounce with who, when and why; never a spam complaint. null when 0153 is not applied.
   */
  ownerLift?(input: { sessionToken: string; workspaceId: string; email: string; note: string }): Promise<OwnerLiftResult | null>;
}

/** 42883 undefined function, 42P01 undefined table, 3F000 undefined schema: the database still ends before 0153. */
const ABSENT = new Set(['42883', '42P01', '3F000']);
const RECHECK_MS = 5 * 60_000;
const LIST_CHUNK = 500;
const EVENT_ID = /^[!-~]{1,200}$/u;
const STREAM = /^[a-z0-9-]{1,60}$/u;
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const LEDGER_REASONS = new Set(['hard_bounce', 'spam_complaint', 'unsubscribe', 'manual']);

/**
 * Event ids are kept only to make replays idempotent and to trace a row back to the provider. A Postmark
 * subscription change has no id of its own (ours is built from the stream, the address and the time), so only a
 * digest of it is stored: the address is never written twice into one row.
 */
export function ledgerEventId(eventId: string | null): string | null {
  if (!eventId) return null;
  const id = eventId.startsWith('subscription:') ? `subscription:${createHash('sha256').update(eventId).digest('hex').slice(0, 40)}` : eventId;
  return EVENT_ID.test(id) ? id : null;
}

export class PgEmailBlockLedger implements EmailBlockLedger {
  private absentUntil = 0;
  /** Set once any call has answered: from then on a missing function is a fault, never "not applied yet". */
  private answered = false;
  constructor(private readonly pool: Pick<Pool, 'query'>, private readonly options: { now?: () => number; log?: (line: string) => void } = {}) {}

  private now(): number { return this.options.now?.() ?? Date.now(); }
  covers(workspaceId: string): boolean { return EMAIL_LEDGER_WORKSPACES.has(workspaceId.toLowerCase()); }
  /** False while the last call found the database before 0153; looked at again after a few minutes. */
  get available(): boolean { return this.now() >= this.absentUntil; }
  status(): LedgerStatus { return this.answered ? 'available' : this.absentUntil > 0 ? 'absent' : 'unknown'; }

  /** Runs one ledger call. 'absent' when 0153 is not applied; other database errors are rethrown. */
  private async call<T>(sql: string, values: unknown[]): Promise<{ value: T } | 'absent'> {
    if (!this.answered && !this.available) return 'absent';
    try {
      const result = await this.pool.query<{ value: T }>(sql, values);
      this.absentUntil = 0; this.answered = true;
      return { value: result.rows[0]!.value };
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      if (typeof code === 'string' && ABSENT.has(code) && this.answered) {
        this.options.log?.(JSON.stringify({ event: 'email.bounces.ledger_missing_after_use', level: 'warn', code,
          message: 'The email block ledger answered earlier in this process and is now missing; treated as a database fault.' }));
        throw error;
      }
      if (typeof code === 'string' && ABSENT.has(code)) {
        if (this.absentUntil === 0) this.options.log?.(JSON.stringify({ event: 'email.bounces.ledger_absent', level: 'info',
          message: 'The email block ledger (0153) is not in this database yet; the in-process list is used alone.' }));
        this.absentUntil = this.now() + RECHECK_MS;
        return 'absent';
      }
      throw error;
    }
  }

  async decide(workspaceId: string, email: string, purpose: EmailPurpose): Promise<LedgerDecision | null> {
    if (!this.covers(workspaceId)) return null;
    let answer: { value: unknown } | 'absent';
    try { answer = await this.call<unknown>('SELECT app_private.email_block_decide($1,$2,$3) AS value', [workspaceId.toLowerCase(), email.trim().toLowerCase(), purpose]); }
    catch (error) {
      // The send guard decides what a failed read means (marketing fails closed); the line carries no address.
      this.options.log?.(JSON.stringify({ event: 'email.bounces.ledger_read_failed', level: 'warn', purpose }));
      throw error;
    }
    if (answer === 'absent') return null;
    const value = answer.value;
    if (!record(value) || typeof value.blocked !== 'boolean' || typeof value.reallowed !== 'boolean' || !record(value.cleared)) throw new Error('Invalid email block ledger answer');
    const cleared: Partial<Record<EmailBlockReason, number>> = {};
    for (const [reason, at] of Object.entries(value.cleared)) {
      const time = typeof at === 'string' ? Date.parse(at) : NaN;
      if (!LEDGER_REASONS.has(reason) || !Number.isFinite(time)) throw new Error('Invalid email block ledger answer');
      cleared[fromLedgerReason(reason as LedgerReason)] = time;
    }
    if (!value.blocked) return { blocked: false, reallowed: value.reallowed, cleared };
    if (typeof value.reason !== 'string' || !LEDGER_REASONS.has(value.reason)) throw new Error('Invalid email block ledger answer');
    return { blocked: true, reason: fromLedgerReason(value.reason as LedgerReason), reallowed: false, cleared };
  }

  async record(input: { workspaceId: string; sourceKey: string; email: string; reason: LastingBlockReason; eventId: string | null; stream: string | null; at: number }): Promise<LedgerWrite> {
    if (!this.covers(input.workspaceId)) return 'unavailable';
    const answer = await this.call<string>('SELECT app_private.email_block_record($1,$2,$3,$4,$5,$6,$7) AS value', [input.workspaceId.toLowerCase(), input.sourceKey,
      input.email.trim().toLowerCase(), toLedgerReason(input.reason), ledgerEventId(input.eventId), input.stream && STREAM.test(input.stream) ? input.stream : null,
      new Date(Math.min(input.at, this.now())).toISOString()]);
    if (answer === 'absent') return 'unavailable';
    if (answer.value !== 'recorded' && answer.value !== 'renewed' && answer.value !== 'exists') throw new Error('Invalid email block ledger answer');
    return answer.value;
  }

  async recordList(input: { workspaceId: string; sourceKey: string; stream: string; rows: readonly { email: string; reason: LastingBlockReason; at: number | null }[] }): Promise<{ added: number; skipped: number } | null> {
    if (!this.covers(input.workspaceId) || !STREAM.test(input.stream)) return null;
    let added = 0, skipped = 0;
    const now = this.now();
    for (let offset = 0; offset < input.rows.length; offset += LIST_CHUNK) {
      const chunk = input.rows.slice(offset, offset + LIST_CHUNK).map(row => ({ email: row.email.trim().toLowerCase(), reason: toLedgerReason(row.reason),
        at: row.at === null ? null : new Date(Math.min(row.at, now)).toISOString() }));
      const answer = await this.call<{ added?: unknown; skipped?: unknown }>('SELECT app_private.email_block_record_list($1,$2,$3,$4::jsonb) AS value',
        [input.workspaceId.toLowerCase(), input.sourceKey, input.stream, JSON.stringify(chunk)]);
      if (answer === 'absent') return null;
      added += Number(answer.value?.added) || 0; skipped += Number(answer.value?.skipped) || 0;
    }
    return { added, skipped };
  }

  async ownerLift(input: { sessionToken: string; workspaceId: string; email: string; note: string }): Promise<OwnerLiftResult | null> {
    if (!this.covers(input.workspaceId)) return null;
    const answer = await this.call<{ lifted?: unknown; released?: unknown; spamComplaint?: unknown; alreadyLifted?: unknown }>('SELECT app_private.email_block_owner_lift($1,$2,$3,$4) AS value',
      [createHash('sha256').update(input.sessionToken).digest(), input.workspaceId.toLowerCase(), input.email.trim().toLowerCase(), input.note]);
    if (answer === 'absent') return null;
    const value = answer.value;
    if (!record(value) || !Number.isSafeInteger(value.lifted) || !Number.isSafeInteger(value.released) || typeof value.spamComplaint !== 'boolean'
        || typeof value.alreadyLifted !== 'boolean') {
      throw new Error('Invalid email block ledger answer');
    }
    return { lifted: Number(value.lifted), released: Number(value.released), spamComplaint: value.spamComplaint, alreadyLifted: value.alreadyLifted };
  }

  async lift(input: { workspaceId: string; sourceKey: string; email: string; eventId: string | null; at: number }): Promise<number | null> {
    if (!this.covers(input.workspaceId)) return null;
    const answer = await this.call<number>('SELECT app_private.email_block_lift($1,$2,$3,$4,$5) AS value', [input.workspaceId.toLowerCase(), input.sourceKey,
      input.email.trim().toLowerCase(), ledgerEventId(input.eventId), new Date(Math.min(input.at, this.now())).toISOString()]);
    return answer === 'absent' ? null : Number(answer.value) || 0;
  }

  async rows(workspaceId: string, limit = 20_000): Promise<{ readonly current: readonly LedgerRow[]; readonly lifted: readonly LedgerLift[] } | null> {
    if (!this.covers(workspaceId)) return null;
    const answer = await this.call<unknown>('SELECT app_private.email_block_rows($1,$2) AS value', [workspaceId.toLowerCase(), limit]);
    if (answer === 'absent') return null;
    const value = answer.value;
    if (!record(value) || !Array.isArray(value.current) || !Array.isArray(value.lifted)) throw new Error('Invalid email block ledger rows');
    const lifted: LedgerLift[] = [];
    for (const item of value.lifted) {
      if (!record(item) || typeof item.email !== 'string' || typeof item.reason !== 'string' || !LEDGER_REASONS.has(item.reason) || typeof item.liftedAt !== 'string') continue;
      const at = Date.parse(item.liftedAt);
      if (Number.isFinite(at)) lifted.push(Object.freeze({ email: item.email, reason: fromLedgerReason(item.reason as LedgerReason), liftedAt: at }));
    }
    const rows: LedgerRow[] = [];
    for (const row of value.current) {
      if (!record(row) || typeof row.email !== 'string' || typeof row.reason !== 'string' || !LEDGER_REASONS.has(row.reason)
          || (row.scope !== 'all' && row.scope !== 'marketing') || typeof row.source !== 'string' || typeof row.since !== 'string'
          || typeof row.reallowed !== 'boolean' || !(row.stream === null || typeof row.stream === 'string')) continue;
      const since = Date.parse(row.since);
      if (!Number.isFinite(since)) continue;
      rows.push(Object.freeze({ email: row.email, reason: fromLedgerReason(row.reason as LedgerReason), scope: row.scope, sourceKey: row.source,
        stream: row.stream as string | null, since, reallowed: row.reallowed }));
    }
    return { current: rows, lifted };
  }
}
