/**
 * The in-process picture of which addresses a workspace must not email, and why.
 *
 * The provider's (Postmark's) per-stream suppression list and bounce log are read
 * at start-up and on a slow timer, and its webhooks add to the picture the moment
 * something happens. Where the database ledger exists (0153, see ledger.ts) this is
 * a cache in front of it: ledger rows are loaded in with origin 'ledger', a provider
 * list read never removes them, and the send guard asks the ledger as well. Without
 * the ledger (a database that still ends at 0152) this picture is all there is and a
 * restart simply reads the lists again. Lasting effects (stopping a person's
 * marketing in the CRM) are applied by each brand's own effect.
 *
 * One address blocked on ANY of a workspace's streams or servers is blocked on
 * all of them, which is what the provider's own per-stream lists cannot do.
 */

import {
  blocksPurpose, factBlockReason, strongestReason, SOFT_BOUNCE_LIMIT, SOFT_BOUNCE_WINDOW_DAYS, EMAIL_HEALTH_WINDOW_DAYS,
  type EmailBlockReason, type EmailFactKind, type EmailPurpose, type EmailSendDecision, type EmailSendGuard,
} from './policy.js';

const DAY = 86_400_000;
const FACT_RETENTION_DAYS = 45;
const MAX_FACTS_PER_WORKSPACE = 50_000;
const MAX_SEEN_EVENTS = 10_000;
const MAX_RELEASES = 10_000;
/** A webhook fact newer than this is kept even when a list read does not show it yet. */
const FRESH_BLOCK_GRACE_MS = 15 * 60_000;

export type EmailStreamKind = 'marketing' | 'service';
export interface EmailFact {
  readonly sourceKey: string; readonly stream: string; readonly id: string;
  readonly kind: EmailFactKind; readonly email: string; readonly at: number;
}
interface BlockRecord { reason: EmailBlockReason; since: number; sourceKey: string; stream: string; recordedAt: number; origin: 'webhook' | 'list' | 'ledger' }
export interface StreamReading {
  readonly sourceKey: string; readonly stream: string; readonly kind: EmailStreamKind;
  /** Provider's own totals for the window; null when it could not be read. */
  readonly sent: number | null; readonly bounced: number | null; readonly complaints: number | null;
  readonly checkedAt: number | null; readonly failed: boolean;
}
interface WorkspaceState {
  blocks: Map<string, Map<string, BlockRecord>>;
  facts: Map<string, EmailFact>;
  factsByEmail: Map<string, Set<string>>;
  streams: Map<string, StreamReading>;
}

export interface BlockedAddress {
  readonly email: string; readonly reason: EmailBlockReason; readonly since: string;
  /** True when event/service email is refused too (hard bounce). */
  readonly allEmail: boolean;
}
export interface EmailHealthStream extends StreamReading {
  /** Fractions, not percentages; null when nothing was sent or the provider total is missing. */
  readonly bounceRate: number | null; readonly complaintRate: number | null;
}
export interface EmailHealthSnapshot {
  readonly workspaceId: string;
  readonly ready: boolean;
  readonly blocked: readonly BlockedAddress[];
  readonly month: { readonly bounced: number; readonly complained: number; readonly unsubscribed: number };
  readonly window: { readonly days: number; readonly sent: number | null; readonly bounced: number; readonly complaints: number;
    readonly bounceRate: number | null; readonly complaintRate: number | null };
  readonly streams: readonly EmailHealthStream[];
  readonly lastCheckedAt: string | null;
  readonly incomplete: boolean;
}

const blockKey = (sourceKey: string, stream: string, reason: EmailBlockReason): string => `${sourceKey}\u0000${stream}\u0000${reason}`;
const streamKey = (sourceKey: string, stream: string): string => `${sourceKey}\u0000${stream}`;
const factKey = (sourceKey: string, id: string): string => `${sourceKey}\u0000${id}`;
const releaseKey = (workspaceId: string, sourceKey: string, stream: string, email: string): string => `${workspaceId.toLowerCase()}\u0000${sourceKey}\u0000${stream}\u0000${email}`;
const rate = (part: number | null, whole: number | null): number | null => part !== null && whole !== null && whole > 0 ? part / whole : null;

const LONDON_PARTS = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
function londonWallClock(at: number): { year: number; month: number; asUtc: number } {
  const parts = LONDON_PARTS.formatToParts(at);
  const part = (type: string): number => Number(parts.find(p => p.type === type)?.value ?? 0);
  return { year: part('year'), month: part('month'), asUtc: Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second')) };
}
/**
 * Start of the calendar month in Europe/London, as a UTC instant. The clocks change INSIDE March and October,
 * so the offset is taken at the first of the month itself, never from "now".
 */
export function londonMonthStart(now: number): number {
  const { year, month } = londonWallClock(now);
  const guess = Date.UTC(year, month - 1, 1);
  // London's offset at midnight on the 1st (0 or +1 hour); the clocks never change at that moment.
  return guess - (londonWallClock(guess).asUtc - guess);
}

export class EmailBlockRegistry implements EmailSendGuard {
  private readonly workspaces = new Map<string, WorkspaceState>();
  private readonly seen = new Set<string>();
  /** When the provider last said "this address may be emailed again", so a list read that started earlier cannot undo it. */
  private readonly released = new Map<string, number>();
  private ready = false;
  private readonly readyWaiters: (() => void)[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  private state(workspaceId: string): WorkspaceState {
    const key = workspaceId.toLowerCase();
    let state = this.workspaces.get(key);
    if (!state) { state = { blocks: new Map(), facts: new Map(), factsByEmail: new Map(), streams: new Map() }; this.workspaces.set(key, state); }
    return state;
  }

  /** Called once the first list read has finished, whether or not it worked. */
  markReady(): void {
    if (this.ready) return;
    this.ready = true;
    for (const waiter of this.readyWaiters.splice(0)) waiter();
  }
  get isReady(): boolean { return this.ready; }
  /** Send paths wait briefly for the first list read, then carry on: the provider still refuses its own listed addresses. */
  whenReady(timeoutMs = 15_000): Promise<void> {
    if (this.ready) return Promise.resolve();
    return new Promise<void>(resolve => {
      // Waiting is paid once: after the first timeout every later send goes straight through.
      const timer = setTimeout(() => this.markReady(), timeoutMs);
      timer.unref?.();
      this.readyWaiters.push(() => { clearTimeout(timer); resolve(); });
    });
  }

  /** True when this exact provider event was already applied in this process. */
  wasSeen(sourceKey: string, eventId: string): boolean { return this.seen.has(`${sourceKey}\u0000${eventId}`); }
  markSeen(sourceKey: string, eventId: string): void {
    const key = `${sourceKey}\u0000${eventId}`;
    this.seen.delete(key); this.seen.add(key);
    if (this.seen.size > MAX_SEEN_EVENTS) this.seen.delete(this.seen.values().next().value as string);
  }

  declareStream(workspaceId: string, sourceKey: string, stream: string, kind: EmailStreamKind): void {
    const streams = this.state(workspaceId).streams, key = streamKey(sourceKey, stream);
    if (!streams.has(key)) streams.set(key, Object.freeze({ sourceKey, stream, kind, sent: null, bounced: null, complaints: null, checkedAt: null, failed: false }));
  }

  private softCount(state: WorkspaceState, email: string, now: number): number {
    let count = 0;
    for (const key of state.factsByEmail.get(email) ?? []) {
      const fact = state.facts.get(key);
      if (fact?.kind === 'soft_bounce' && fact.at > now - SOFT_BOUNCE_WINDOW_DAYS * DAY && fact.at <= now + DAY) count++;
    }
    return count;
  }
  private reasons(state: WorkspaceState, email: string, now: number): EmailBlockReason[] {
    const reasons = new Set<EmailBlockReason>();
    for (const block of state.blocks.get(email)?.values() ?? []) reasons.add(block.reason);
    if (this.softCount(state, email, now) >= SOFT_BOUNCE_LIMIT) reasons.add('repeated_soft_bounce');
    return [...reasons];
  }

  /**
   * durableAfter: the durable ledger has just answered for this address and is the record for every lasting reason.
   * This process then adds only what the ledger cannot know: a repeated soft bounce, and a block a webhook reported
   * here that happened AFTER the ledger's clearedAt for the address (a newer event whose durable write is still being
   * retried). Copies of list reads and of ledger rows, and anything at or before clearedAt, are left to the ledger.
   */
  decide(workspaceId: string, email: string, purpose: EmailPurpose, options: { durableAfter?: number } = {}): EmailSendDecision {
    const state = this.workspaces.get(workspaceId.toLowerCase());
    if (!state) return { blocked: false };
    const address = email.trim().toLowerCase(), now = this.now();
    let reasons: EmailBlockReason[];
    if (options.durableAfter === undefined) reasons = this.reasons(state, address, now);
    else {
      const set = new Set<EmailBlockReason>();
      for (const block of state.blocks.get(address)?.values() ?? []) if (block.origin === 'webhook' && block.since > options.durableAfter) set.add(block.reason);
      if (this.softCount(state, address, now) >= SOFT_BOUNCE_LIMIT) set.add('repeated_soft_bounce');
      reasons = [...set];
    }
    const blocking = reasons.filter(reason => blocksPurpose(reason, purpose));
    const reason = strongestReason(blocking);
    return reason ? { blocked: true, reason } : { blocked: false };
  }

  private addFact(state: WorkspaceState, fact: EmailFact): boolean {
    const key = factKey(fact.sourceKey, fact.id);
    if (state.facts.has(key)) return false;
    state.facts.set(key, fact);
    let keys = state.factsByEmail.get(fact.email);
    if (!keys) { keys = new Set(); state.factsByEmail.set(fact.email, keys); }
    keys.add(key);
    return true;
  }
  private dropFact(state: WorkspaceState, key: string): void {
    const fact = state.facts.get(key);
    if (!fact) return;
    state.facts.delete(key);
    const keys = state.factsByEmail.get(fact.email);
    keys?.delete(key);
    if (keys && keys.size === 0) state.factsByEmail.delete(fact.email);
  }
  private prune(state: WorkspaceState, now: number): void {
    for (const [key, fact] of state.facts) if (fact.at < now - FACT_RETENTION_DAYS * DAY) this.dropFact(state, key);
    for (const key of state.facts.keys()) { if (state.facts.size <= MAX_FACTS_PER_WORKSPACE) break; this.dropFact(state, key); }
  }
  private setBlock(state: WorkspaceState, email: string, block: BlockRecord): void {
    let blocks = state.blocks.get(email);
    if (!blocks) { blocks = new Map(); state.blocks.set(email, blocks); }
    const key = blockKey(block.sourceKey, block.stream, block.reason), existing = blocks.get(key);
    blocks.set(key, existing ? { ...block, since: Math.min(existing.since, block.since) } : block);
  }

  /**
   * Applies one provider fact (a webhook event). Idempotent on the fact id.
   * Returns the reason marketing email is now blocked for the address, if any.
   * counts=false blocks without adding to the bounce and complaint tallies.
   */
  record(workspaceId: string, fact: EmailFact, counts = true): { readonly added: boolean; readonly marketingBlock: EmailBlockReason | null } {
    const state = this.state(workspaceId), now = this.now();
    const added = counts && this.addFact(state, fact);
    const reason = factBlockReason(fact.kind);
    if (reason) this.setBlock(state, fact.email, { reason, since: fact.at, sourceKey: fact.sourceKey, stream: fact.stream, recordedAt: now, origin: 'webhook' });
    if (state.facts.size > MAX_FACTS_PER_WORKSPACE) this.prune(state, now);
    return { added, marketingBlock: strongestReason(this.reasons(state, fact.email, now)) };
  }

  /** The provider says this address may be emailed again on this stream (the person re-subscribed or was reactivated). */
  release(workspaceId: string, sourceKey: string, stream: string, email: string): void {
    const state = this.state(workspaceId), blocks = state.blocks.get(email);
    this.released.delete(releaseKey(workspaceId, sourceKey, stream, email));
    this.released.set(releaseKey(workspaceId, sourceKey, stream, email), this.now());
    if (this.released.size > MAX_RELEASES) this.released.delete(this.released.keys().next().value as string);
    if (!blocks) return;
    // A durable hard bounce or spam complaint is never lifted by the provider. A durable unsubscribe is lifted by the
    // ledger for the whole source (as the ledger itself does), whichever stream it was first seen on.
    for (const [key, block] of blocks) {
      if (block.sourceKey !== sourceKey) continue;
      if (block.origin === 'ledger' ? block.reason === 'unsubscribed' : block.stream === stream) blocks.delete(key);
    }
    if (blocks.size === 0) state.blocks.delete(email);
  }

  /** The owner confirmed a hard-bounced address works: forget this process's copies of that hard bounce. */
  clearHardBounce(workspaceId: string, email: string): void {
    const state = this.state(workspaceId), address = email.trim().toLowerCase(), blocks = state.blocks.get(address);
    if (!blocks) return;
    for (const [key, block] of blocks) if (block.reason === 'hard_bounce') blocks.delete(key);
    if (blocks.size === 0) state.blocks.delete(address);
  }

  /**
   * Replaces this workspace's durable blocks with a fresh read of the ledger. An unsubscribe the person has signed up
   * again since is left out: it no longer blocks anything the ledger answers for.
   */
  hydrate(workspaceId: string, rows: readonly { email: string; reason: EmailBlockReason; sourceKey: string; stream: string | null; since: number; reallowed: boolean }[]): void {
    const state = this.state(workspaceId), now = this.now();
    for (const [email, blocks] of state.blocks) {
      for (const [key, block] of blocks) if (block.origin === 'ledger') blocks.delete(key);
      if (blocks.size === 0) state.blocks.delete(email);
    }
    for (const row of rows) {
      if (row.reallowed) continue;
      this.setBlock(state, row.email, { reason: row.reason, since: row.since, sourceKey: row.sourceKey, stream: row.stream ?? 'ledger', recordedAt: now, origin: 'ledger' });
    }
  }

  /**
   * Replaces what is known for one stream with a fresh, successful read of the
   * provider's suppression list and bounce log. An address the provider no
   * longer lists is released, except one recorded moments ago by a webhook.
   */
  reconcile(workspaceId: string, input: {
    sourceKey: string; stream: string; kind: EmailStreamKind; startedAt: number;
    suppressions: readonly { email: string; kind: Exclude<EmailFactKind, 'soft_bounce'>; at: number | null }[];
    bounces: readonly { id: string; kind: EmailFactKind; email: string; at: number }[];
    sent: number | null; bounced: number | null; complaints: number | null;
  }): void {
    const state = this.state(workspaceId), now = this.now();
    const listed = new Set(input.suppressions.map(row => `${row.email}\u0000${row.kind}`));
    for (const [email, blocks] of state.blocks) {
      for (const [key, block] of blocks) {
        if (block.sourceKey !== input.sourceKey || block.stream !== input.stream || block.origin === 'ledger') continue;
        if (listed.has(`${email}\u0000${block.reason}`)) continue;
        if (block.origin === 'list' || block.recordedAt < input.startedAt - FRESH_BLOCK_GRACE_MS) blocks.delete(key);
      }
      if (blocks.size === 0) state.blocks.delete(email);
    }
    for (const row of input.suppressions) {
      // The list was fetched before the provider told us the address was reactivated: the newer word wins, the next read confirms it.
      const releasedAt = this.released.get(releaseKey(workspaceId, input.sourceKey, input.stream, row.email));
      if (releasedAt !== undefined && releasedAt >= input.startedAt) continue;
      this.setBlock(state, row.email, { reason: row.kind, since: row.at ?? input.startedAt, sourceKey: input.sourceKey, stream: input.stream, recordedAt: now, origin: 'list' });
    }
    for (const [key, releasedAt] of this.released) if (releasedAt < input.startedAt - FRESH_BLOCK_GRACE_MS) this.released.delete(key);
    for (const row of input.bounces) this.addFact(state, { sourceKey: input.sourceKey, stream: input.stream, id: `bounce:${row.id}`, kind: row.kind, email: row.email, at: row.at });
    this.prune(state, now);
    state.streams.set(streamKey(input.sourceKey, input.stream), Object.freeze({ sourceKey: input.sourceKey, stream: input.stream, kind: input.kind,
      sent: input.sent, bounced: input.bounced, complaints: input.complaints, checkedAt: now, failed: false }));
  }

  /** A read of one stream failed: keep what was known and say so. */
  readFailed(workspaceId: string, sourceKey: string, stream: string, kind: EmailStreamKind): void {
    const streams = this.state(workspaceId).streams, key = streamKey(sourceKey, stream), previous = streams.get(key);
    streams.set(key, Object.freeze({ sourceKey, stream, kind, sent: previous?.sent ?? null, bounced: previous?.bounced ?? null,
      complaints: previous?.complaints ?? null, checkedAt: previous?.checkedAt ?? null, failed: true }));
  }

  snapshot(workspaceId: string): EmailHealthSnapshot {
    const state = this.state(workspaceId), now = this.now();
    const windowStart = now - EMAIL_HEALTH_WINDOW_DAYS * DAY, monthStart = londonMonthStart(now);
    const emails = new Set<string>(state.blocks.keys());
    for (const email of state.factsByEmail.keys()) if (this.softCount(state, email, now) >= SOFT_BOUNCE_LIMIT) emails.add(email);
    const blocked: BlockedAddress[] = [];
    for (const email of emails) {
      const reasons = this.reasons(state, email, now), reason = strongestReason(reasons);
      if (!reason) continue;
      let since = Infinity;
      for (const block of state.blocks.get(email)?.values() ?? []) if (block.reason === reason) since = Math.min(since, block.since);
      if (reason === 'repeated_soft_bounce') {
        const soft = [...(state.factsByEmail.get(email) ?? [])].map(key => state.facts.get(key)!)
          .filter(fact => fact.kind === 'soft_bounce' && fact.at > now - SOFT_BOUNCE_WINDOW_DAYS * DAY).map(fact => fact.at).sort((a, b) => a - b);
        since = soft[SOFT_BOUNCE_LIMIT - 1] ?? now;
      }
      blocked.push(Object.freeze({ email, reason, since: new Date(Number.isFinite(since) ? since : now).toISOString(), allEmail: blocksPurpose(reason, 'service') }));
    }
    blocked.sort((a, b) => b.since.localeCompare(a.since) || a.email.localeCompare(b.email));

    // "This month" counts people, not messages: one address that bounced twice is one bounce.
    const month = { bounced: new Set<string>(), complained: new Set<string>(), unsubscribed: new Set<string>() };
    const counted = { hard_bounce: month.bounced, spam_complaint: month.complained, unsubscribed: month.unsubscribed } as const;
    for (const fact of state.facts.values()) if (fact.at >= monthStart && fact.kind !== 'soft_bounce') counted[fact.kind].add(fact.email);
    for (const [email, blocks] of state.blocks) for (const block of blocks.values()) {
      if (block.since >= monthStart && block.reason !== 'repeated_soft_bounce' && block.reason !== 'manual') counted[block.reason].add(email);
    }

    const streams: EmailHealthStream[] = [];
    let sent: number | null = 0, bounced = 0, complaints = 0, lastChecked: number | null = null, incomplete = false;
    for (const reading of state.streams.values()) {
      // The provider's own totals are what it judges the account by. Events that arrived since they
      // were read are in our own count, so the larger of the two is shown: a warning is never late.
      let ownBounced = 0, ownComplaints = 0;
      for (const fact of state.facts.values()) {
        if (fact.sourceKey !== reading.sourceKey || fact.stream !== reading.stream || fact.at < windowStart) continue;
        if (fact.kind === 'hard_bounce' || fact.kind === 'soft_bounce') ownBounced++;
        else if (fact.kind === 'spam_complaint') ownComplaints++;
      }
      const streamBounced = Math.max(reading.bounced ?? 0, ownBounced), streamComplaints = Math.max(reading.complaints ?? 0, ownComplaints);
      streams.push(Object.freeze({ ...reading, bounced: streamBounced, complaints: streamComplaints,
        bounceRate: rate(streamBounced, reading.sent), complaintRate: rate(streamComplaints, reading.sent) }));
      bounced += streamBounced; complaints += streamComplaints;
      sent = sent === null || reading.sent === null ? null : sent + reading.sent;
      if (reading.checkedAt !== null) lastChecked = Math.max(lastChecked ?? 0, reading.checkedAt);
      if (reading.failed || reading.checkedAt === null) incomplete = true;
    }
    if (streams.length === 0) sent = null;
    streams.sort((a, b) => a.kind.localeCompare(b.kind) || a.stream.localeCompare(b.stream));
    return Object.freeze({
      workspaceId: workspaceId.toLowerCase(), ready: this.ready, blocked: Object.freeze(blocked),
      month: Object.freeze({ bounced: month.bounced.size, complained: month.complained.size, unsubscribed: month.unsubscribed.size }),
      window: Object.freeze({ days: EMAIL_HEALTH_WINDOW_DAYS, sent, bounced, complaints, bounceRate: rate(bounced, sent), complaintRate: rate(complaints, sent) }),
      streams: Object.freeze(streams), lastCheckedAt: lastChecked === null ? null : new Date(lastChecked).toISOString(), incomplete,
    });
  }
}
