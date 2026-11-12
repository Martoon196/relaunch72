/**
 * Catch-up sweep and the per-workspace lasting effects.
 *
 * The sweep reads each configured Postmark stream's suppression list, recent
 * bounces and totals with the server token the service already holds, so
 * bounces from before the webhook existed are recorded without anyone typing
 * an address. It only reads, and reading twice changes nothing.
 */

import type { EmailBounceConfig, EmailBounceSource } from './config.js';
import type { EmailBlockReason } from './policy.js';
import { EMAIL_HEALTH_WINDOW_DAYS } from './policy.js';
import { createPostmarkBounceApi, type PostmarkBounceApi } from './postmark-api.js';
import type { PostmarkBounceRow } from './postmark-events.js';
import { EmailBlockRegistry } from './registry.js';

const DAY = 86_400_000;
const PAGE_SIZE = 500;
/** Postmark serves at most count + offset = 10,000 bounces per query. */
const MAX_OFFSET = 10_000;

/** What a brand does, with capabilities it already has, when an address must stop getting marketing email. */
export interface EmailBounceEffects {
  onMarketingBlock(input: { readonly email: string; readonly reason: EmailBlockReason; readonly metadata: Readonly<Record<string, string>> }): Promise<void>;
}
export interface SweepResult { readonly streams: number; readonly failed: number; readonly suppressions: number; readonly bounces: number;
  /** Streams with more recent bounces than Postmark serves in one query (10,000). The suppression list, which decides who is blocked, is always complete. */
  readonly truncated?: number }

const day = (at: number): string => new Date(at).toISOString().slice(0, 10);

export async function sweepPostmarkSource(input: { source: EmailBounceSource; api: PostmarkBounceApi; registry: EmailBlockRegistry; now: number }): Promise<SweepResult> {
  const { source, api, registry, now } = input;
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
    } catch {
      failed++;
      registry.readFailed(source.workspaceId, source.key, stream, kind);
    }
  }
  return { streams: source.streams.size, failed, suppressions: suppressionCount, bounces: bounceCount, ...(truncated ? { truncated } : {}) };
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

  constructor(input: { config: EmailBounceConfig; now?: () => number; apiFor?: (source: EmailBounceSource) => PostmarkBounceApi | null;
    registry?: EmailBlockRegistry; log?: (line: string) => void }) {
    this.now = input.now ?? Date.now;
    this.registry = input.registry ?? new EmailBlockRegistry(this.now);
    this.sources = input.config.sources;
    this.blockers = input.config.blockers;
    this.apiFor = input.apiFor ?? (source => source.token ? createPostmarkBounceApi(source.token) : null);
    this.log = input.log ?? (() => undefined);
    for (const source of this.sources) for (const [stream, kind] of source.streams) this.registry.declareStream(source.workspaceId, source.key, stream, kind);
    // With nothing to read there is nothing to wait for.
    if (!this.sources.some(source => source.token)) this.registry.markReady();
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
    const run = sweepPostmarkSource({ source, api, registry: this.registry, now: this.now() })
      .then(result => { this.lastSwept.set(source.key, this.now()); return result; })
      .finally(() => { this.running.delete(source.key); });
    this.running.set(source.key, run);
    return run;
  }

  /** Owner-triggered or timed. Sources read within minIntervalMs are not read again. */
  async sweepWorkspace(workspaceId: string | null, minIntervalMs = 0): Promise<SweepResult> {
    const total = { streams: 0, failed: 0, suppressions: 0, bounces: 0, truncated: 0 };
    for (const source of this.sources) {
      if (workspaceId !== null && source.workspaceId !== workspaceId.toLowerCase()) continue;
      const last = this.lastSwept.get(source.key);
      if (minIntervalMs > 0 && last !== undefined && this.now() - last < minIntervalMs) { total.streams += source.streams.size; continue; }
      const result: SweepResult = await this.sweepSource(source).catch(() => ({ streams: source.streams.size, failed: source.streams.size, suppressions: 0, bounces: 0 }));
      total.streams += result.streams; total.failed += result.failed; total.suppressions += result.suppressions; total.bounces += result.bounces;
      total.truncated += result.truncated ?? 0;
    }
    const { truncated, ...counts } = total;
    return truncated ? total : counts;
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
      finally { this.registry.markReady(); }
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
