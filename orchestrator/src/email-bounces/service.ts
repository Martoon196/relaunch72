/**
 * Catch-up sweep and the per-workspace lasting effects.
 *
 * The sweep reads each configured Postmark stream's suppression list, recent
 * bounces and totals with the server token the service already holds, so
 * bounces from before the webhook existed are recorded without anyone typing
 * an address. It only reads, and reading twice changes nothing.
 */

import type { EmailBounceConfig, EmailBounceSource } from './config.js';
import type { EmailBlockLedger } from './ledger.js';
import type { EmailPurpose, EmailSendDecision, EmailSendGuard, LastingBlockReason } from './policy.js';
import { EMAIL_HEALTH_WINDOW_DAYS, strongestReason } from './policy.js';
import { createPostmarkBounceApi, type PostmarkBounceApi } from './postmark-api.js';
import type { PostmarkBounceRow } from './postmark-events.js';
import { EmailBlockRegistry } from './registry.js';

const DAY = 86_400_000;
const PAGE_SIZE = 500;
/** Postmark serves at most count + offset = 10,000 bounces per query. */
const MAX_OFFSET = 10_000;

/**
 * What a brand does, with capabilities it already has, when an address must stop getting marketing email for good.
 * Called only for an event that is final in itself (hard bounce, spam report, unsubscribe), with that event's own
 * reason; never for repeated soft bounces, which are a temporary block held in this process.
 */
export interface EmailBounceEffects {
  onMarketingBlock(input: { readonly email: string; readonly reason: LastingBlockReason; readonly metadata: Readonly<Record<string, string>> }): Promise<void>;
}
export interface SweepResult { readonly streams: number; readonly failed: number; readonly suppressions: number; readonly bounces: number;
  /** Streams with more recent bounces than Postmark serves in one query (10,000). The suppression list, which decides who is blocked, is always complete. */
  readonly truncated?: number;
  /** Streams whose suppression list was read but could not be written to the durable ledger (it is tried again at the next read). */
  readonly ledgerFailed?: number }

/** Writes one stream's suppression list to the durable ledger. Absent (database before 0153) is not a failure. */
export type SuppressionPersister = (stream: string, rows: readonly { email: string; kind: LastingBlockReason; at: number | null }[], startedAt: number) => Promise<void>;

const day = (at: number): string => new Date(at).toISOString().slice(0, 10);

export async function sweepPostmarkSource(input: { source: EmailBounceSource; api: PostmarkBounceApi; registry: EmailBlockRegistry; now: number;
  persist?: SuppressionPersister }): Promise<SweepResult> {
  const { source, api, registry, now } = input;
  let ledgerFailed = 0;
  // One day either side covers the provider reporting dates in its own time zone.
  const from = day(now - (EMAIL_HEALTH_WINDOW_DAYS + 1) * DAY), statsFrom = day(now - EMAIL_HEALTH_WINDOW_DAYS * DAY), to = day(now + DAY);
  let failed = 0, suppressionCount = 0, bounceCount = 0, truncated = 0;
  // Every read names its message stream: Postmark keeps suppressions per stream and would otherwise answer for the default stream only.
  for (const [stream, kind] of source.streams) {
    try {
      const suppressions = await api.suppressions(stream);
      const bounces: PostmarkBounceRow[] = [];
      // Postmark's limits: count <= 500 and count + offset <= 10,000.
      for (let offset = 0, more = true; more; offset += PAGE_SIZE) {
        const page = await api.bounces(stream, from, to, offset, PAGE_SIZE);
        bounces.push(...page.rows);
        more = page.received === PAGE_SIZE && offset + page.received < page.total;
        if (more && offset + 2 * PAGE_SIZE > MAX_OFFSET) { truncated++; more = false; }
      }
      // Totals are a nicety for the owner's view; the block list must not wait on them.
      const totals = await api.totals(stream, statsFrom, to).catch(() => ({ sent: null, bounced: null, complaints: null }));
      registry.reconcile(source.workspaceId, { sourceKey: source.key, stream, kind, startedAt: now, suppressions, bounces, ...totals });
      suppressionCount += suppressions.length; bounceCount += bounces.length;
      // The read itself succeeded; a failed durable write is reported on its own and written again next time.
      if (input.persist) { try { await input.persist(stream, suppressions, now); } catch { ledgerFailed++; } }
    } catch {
      failed++;
      registry.readFailed(source.workspaceId, source.key, stream, kind);
    }
  }
  return { streams: source.streams.size, failed, suppressions: suppressionCount, bounces: bounceCount, ...(truncated ? { truncated } : {}),
    ...(ledgerFailed ? { ledgerFailed } : {}) };
}

export class EmailBounceService {
  readonly registry: EmailBlockRegistry;
  readonly sources: readonly EmailBounceSource[];
  readonly blockers: readonly string[];
  private readonly effects = new Map<string, EmailBounceEffects>();
  private readonly running = new Map<string, Promise<SweepResult>>();
  private readonly lastSwept = new Map<string, number>();
  private readonly now: () => number;
  private readonly apiFor: (source: EmailBounceSource) => PostmarkBounceApi | null;
  private readonly log: (line: string) => void;
  /** The durable ledger (0153), or null when this service has no database. */
  readonly ledger: EmailBlockLedger | null;
  /**
   * What every send path is given: the in-process list in front of the durable ledger. Without a ledger, or while the
   * database still ends at 0152, it answers exactly as the in-process list alone did before 0153.
   */
  readonly guard: EmailSendGuard;

  constructor(input: { config: EmailBounceConfig; now?: () => number; apiFor?: (source: EmailBounceSource) => PostmarkBounceApi | null;
    registry?: EmailBlockRegistry; log?: (line: string) => void; ledger?: EmailBlockLedger | null }) {
    this.now = input.now ?? Date.now;
    this.registry = input.registry ?? new EmailBlockRegistry(this.now);
    this.sources = input.config.sources;
    this.blockers = input.config.blockers;
    this.apiFor = input.apiFor ?? (source => source.token ? createPostmarkBounceApi(source.token) : null);
    this.log = input.log ?? (() => undefined);
    this.ledger = input.ledger ?? null;
    const registry = this.registry;
    this.guard = Object.freeze({
      whenReady: (timeoutMs?: number) => registry.whenReady(timeoutMs),
      decide: (workspaceId: string, email: string, purpose: EmailPurpose) => registry.decide(workspaceId, email, purpose),
      check: (workspaceId: string, email: string, purpose: EmailPurpose) => this.check(workspaceId, email, purpose),
    });
    for (const source of this.sources) for (const [stream, kind] of source.streams) this.registry.declareStream(source.workspaceId, source.key, stream, kind);
    // With nothing to read there is nothing to wait for.
    if (!this.sources.some(source => source.token)) this.registry.markReady();
  }

  /**
   * The durable decision. The ledger is asked first where it covers the workspace; anything this process alone knows
   * (a repeated soft bounce, a block the ledger could not take yet) still counts. A ledger unsubscribe the person has
   * signed up again since lets marketing go, so this process's own copy of that unsubscribe is set aside.
   */
  async check(workspaceId: string, email: string, purpose: EmailPurpose): Promise<EmailSendDecision> {
    const to = email.trim().toLowerCase();
    const durable = this.ledger?.covers(workspaceId) ? await this.ledger.decide(workspaceId, to, purpose) : null;
    const memory = this.registry.decide(workspaceId, to, purpose, { ignoreUnsubscribed: durable?.reallowed === true });
    if (!durable?.blocked) return memory;
    const reason = strongestReason([durable.reason, ...(memory.blocked ? [memory.reason] : [])])!;
    return { blocked: true, reason };
  }

  /** Loads the ledger's current rows into the in-process picture (owner page, quick refusals). Never throws. */
  async refreshLedger(workspaceId: string | null = null): Promise<void> {
    if (!this.ledger) return;
    const workspaces = new Set(this.sources.map(source => source.workspaceId).filter(id => workspaceId === null || id === workspaceId.toLowerCase()));
    for (const id of workspaces) {
      if (!this.ledger.covers(id)) continue;
      try {
        const rows = await this.ledger.rows(id);
        if (rows) this.registry.hydrate(id, rows);
      } catch { this.log(JSON.stringify({ event: 'email.bounces.ledger_refresh_failed', level: 'warn' })); }
    }
  }

  private persister(source: EmailBounceSource): SuppressionPersister | undefined {
    const ledger = this.ledger;
    if (!ledger?.covers(source.workspaceId)) return undefined;
    return async (stream, rows, startedAt) => {
      await ledger.recordList({ workspaceId: source.workspaceId, sourceKey: source.key, stream,
        rows: rows.map(row => ({ email: row.email, reason: row.kind, at: row.at ?? startedAt })) });
    };
  }

  source(key: string): EmailBounceSource | undefined { return this.sources.find(source => source.key === key); }
  hasWorkspace(workspaceId: string): boolean { return this.sources.some(source => source.workspaceId === workspaceId.toLowerCase()); }
  setEffects(workspaceId: string, effects: EmailBounceEffects): void { this.effects.set(workspaceId.toLowerCase(), effects); }
  effectsFor(workspaceId: string): EmailBounceEffects | undefined { return this.effects.get(workspaceId.toLowerCase()); }

  /** One sweep of one source at a time; a second caller joins the sweep already running. */
  sweepSource(source: EmailBounceSource): Promise<SweepResult> {
    const existing = this.running.get(source.key);
    if (existing) return existing;
    const api = this.apiFor(source);
    // A webhook-only source has nothing to read; that is a configuration choice, not a failed read to retry.
    if (!api) return Promise.resolve({ streams: 0, failed: 0, suppressions: 0, bounces: 0 });
    const persist = this.persister(source);
    const run = sweepPostmarkSource({ source, api, registry: this.registry, now: this.now(), ...(persist ? { persist } : {}) })
      .then(result => { this.lastSwept.set(source.key, this.now()); return result; })
      .finally(() => { this.running.delete(source.key); });
    this.running.set(source.key, run);
    return run;
  }

  /** Owner-triggered or timed. Sources read within minIntervalMs are not read again. */
  async sweepWorkspace(workspaceId: string | null, minIntervalMs = 0): Promise<SweepResult> {
    const total = { streams: 0, failed: 0, suppressions: 0, bounces: 0, truncated: 0, ledgerFailed: 0 };
    for (const source of this.sources) {
      if (workspaceId !== null && source.workspaceId !== workspaceId.toLowerCase()) continue;
      const last = this.lastSwept.get(source.key);
      if (minIntervalMs > 0 && last !== undefined && this.now() - last < minIntervalMs) { total.streams += source.streams.size; continue; }
      const result: SweepResult = await this.sweepSource(source).catch(() => ({ streams: source.streams.size, failed: source.streams.size, suppressions: 0, bounces: 0 }));
      total.streams += result.streams; total.failed += result.failed; total.suppressions += result.suppressions; total.bounces += result.bounces;
      total.truncated += result.truncated ?? 0; total.ledgerFailed += result.ledgerFailed ?? 0;
    }
    const { truncated, ledgerFailed, ...counts } = total;
    return { ...counts, ...(truncated ? { truncated } : {}), ...(ledgerFailed ? { ledgerFailed } : {}) };
  }

  /**
   * Reads everything now, then every intervalMs (hourly: a handful of GET requests). Only counts reach the log.
   * A read that could not reach Postmark is never accepted quietly: it is logged as a warning and tried again
   * after retryMs, doubling up to maxRetryMs, until every stream has been read. Until then the block list holds
   * whatever was last read (nothing, straight after a restart) and Postmark's own per-stream list is the only guard.
   * The picture is per process, so with several web instances an instance that did not receive a webhook
   * learns of it here, within the hour; the lasting stop in the brand's own records is immediate everywhere.
   */
  start(intervalMs = 3_600_000, retry: { retryMs?: number; maxRetryMs?: number } = {}): () => void {
    let stopped = false, timer: NodeJS.Timeout | undefined, failures = 0;
    const firstRetry = retry.retryMs ?? 60_000, maxRetry = retry.maxRetryMs ?? 15 * 60_000;
    const run = async (): Promise<void> => {
      if (stopped) return;
      let failed = 0, streams = 0;
      try {
        const result = await this.sweepWorkspace(null);
        failed = result.failed; streams = result.streams;
        if (streams > 0) this.log(JSON.stringify({ event: failed ? 'email.bounces.sweep_incomplete' : 'email.bounces.sweep', level: failed ? 'warn' : 'info', ...result }));
      } catch { failed = 1; this.log(JSON.stringify({ event: 'email.bounces.sweep_failed', level: 'warn' })); }
      finally {
        // The durable rows are loaded after every read, so a restart or a second instance sees them too.
        await this.refreshLedger(null);
        this.registry.markReady();
      }
      if (stopped) return;
      failures = failed ? failures + 1 : 0;
      const wait = failed ? Math.min(firstRetry * 2 ** (failures - 1), maxRetry, intervalMs) : intervalMs;
      if (failed) this.log(JSON.stringify({ event: 'email.bounces.sweep_retry', level: 'warn', attempt: failures, retryInSeconds: Math.round(wait / 1000),
        message: 'Postmark could not be read for every stream; the block list may be incomplete until the retry succeeds.' }));
      timer = setTimeout(() => { void run(); }, wait);
      timer.unref?.();
    };
    void run();
    return () => { stopped = true; clearTimeout(timer); this.registry.markReady(); };
  }
}
