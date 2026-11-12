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
export interface SweepResult { readonly streams: number; readonly failed: number; readonly suppressions: number; readonly bounces: number }

const day = (at: number): string => new Date(at).toISOString().slice(0, 10);

export async function sweepPostmarkSource(input: { source: EmailBounceSource; api: PostmarkBounceApi; registry: EmailBlockRegistry; now: number }): Promise<SweepResult> {
  const { source, api, registry, now } = input;
  // One day either side covers the provider reporting dates in its own time zone.
  const from = day(now - (EMAIL_HEALTH_WINDOW_DAYS + 1) * DAY), statsFrom = day(now - EMAIL_HEALTH_WINDOW_DAYS * DAY), to = day(now + DAY);
  let failed = 0, suppressionCount = 0, bounceCount = 0;
  for (const [stream, kind] of source.streams) {
    try {
      const suppressions = await api.suppressions(stream);
      const bounces: PostmarkBounceRow[] = [];
      for (let offset = 0; offset + PAGE_SIZE <= MAX_OFFSET; offset += PAGE_SIZE) {
        const page = await api.bounces(stream, from, to, offset, PAGE_SIZE);
        bounces.push(...page.rows);
        if (page.received < PAGE_SIZE || offset + page.received >= page.total) break;
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
  return { streams: source.streams.size, failed, suppressions: suppressionCount, bounces: bounceCount };
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
    if (!api) return Promise.resolve({ streams: source.streams.size, failed: source.streams.size, suppressions: 0, bounces: 0 });
    const run = sweepPostmarkSource({ source, api, registry: this.registry, now: this.now() })
      .then(result => { this.lastSwept.set(source.key, this.now()); return result; })
      .finally(() => { this.running.delete(source.key); });
    this.running.set(source.key, run);
    return run;
  }

  /** Owner-triggered or timed. Sources read within minIntervalMs are not read again. */
  async sweepWorkspace(workspaceId: string | null, minIntervalMs = 0): Promise<SweepResult> {
    const total = { streams: 0, failed: 0, suppressions: 0, bounces: 0 };
    for (const source of this.sources) {
      if (workspaceId !== null && source.workspaceId !== workspaceId.toLowerCase()) continue;
      const last = this.lastSwept.get(source.key);
      if (minIntervalMs > 0 && last !== undefined && this.now() - last < minIntervalMs) { total.streams += source.streams.size; continue; }
      const result = await this.sweepSource(source).catch(() => ({ streams: source.streams.size, failed: source.streams.size, suppressions: 0, bounces: 0 }));
      total.streams += result.streams; total.failed += result.failed; total.suppressions += result.suppressions; total.bounces += result.bounces;
    }
    return total;
  }

  /**
   * Reads everything now, then every intervalMs (hourly: a handful of GET requests). Only counts reach the log.
   * The picture is per process, so with several web instances an instance that did not receive a webhook
   * learns of it here, within the hour; the lasting stop in the brand's own records is immediate everywhere.
   */
  start(intervalMs = 3_600_000): () => void {
    let stopped = false;
    const run = async (): Promise<void> => {
      if (stopped) return;
      try {
        const result = await this.sweepWorkspace(null);
        if (result.streams > 0) this.log(JSON.stringify({ event: 'email.bounces.sweep', ...result }));
      } catch { this.log(JSON.stringify({ event: 'email.bounces.sweep_failed' })); }
      finally { this.registry.markReady(); }
    };
    void run();
    const timer = setInterval(() => { void run(); }, intervalMs);
    timer.unref?.();
    return () => { stopped = true; clearInterval(timer); this.registry.markReady(); };
  }
}
