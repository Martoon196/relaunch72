/**
 * Stored email connections as bounce sources, without a restart or an env change.
 *
 * Loaded at start, then about every 60 seconds (so other instances pick up a connection made elsewhere), and on
 * demand when Postmark posts to a connection's address this process has not loaded yet. Each source authenticates
 * the webhook with that connection's own (unsealed) secret and reads its stream with its own server token; neither
 * value is ever logged. A newly loaded source is swept at once (its suppression list read), not at the next hourly
 * sweep.
 *
 * A stored connection that cannot be opened (EMAIL_CONNECTION_KEY missing, lost or rotated) is reported as
 * unavailable, so its webhook answers 503 and Postmark retries, never 404 (which Postmark drops). One warning line
 * names the setting, never a value. Pressing Repair (or Continue) on the email page makes a new secret and webhook.
 */
import type { EmailBounceService, EmailBounceSource, EmailBounceSourceLoader } from '../email-bounces/index.js';
import { staticEligibility, type EmailConnectEligibility } from './eligibility.js';
import type { EmailConnectionStore, StoredConnectionSource } from './store.js';
import type { EmailConnectionVault } from './vault.js';

const SECRET = /^[\x21-\x7e]{24,200}$/u;
const FORCED_MIN_INTERVAL_MS = 5_000;

/** One stored connection as a bounce source: its Broadcast stream is a marketing stream. Only an allowed business has one. */
export function connectionBounceSource(input: { workspaceId: string; serverId: string; stream: string; serverToken: string; webhookSecret: string },
  eligibility: EmailConnectEligibility): EmailBounceSource {
  const business = eligibility.business(input.workspaceId);
  if (!business || !SECRET.test(input.webhookSecret) || !/^[0-9]{1,20}$/u.test(input.serverId) || !/^[a-z0-9-]{1,60}$/u.test(input.stream)) throw new Error('Invalid stored email connection');
  return Object.freeze({ key: business.sourceKey, workspaceId: business.workspaceId, token: input.serverToken, webhookSecret: input.webhookSecret,
    serverId: input.serverId, streams: new Map([[input.stream, 'marketing' as const]]), connection: true });
}

export class EmailConnectionBounceSources implements EmailBounceSourceLoader {
  private running: Promise<void> | null = null;
  private lastForced = 0;
  private warned = false;
  /** Keys whose stored row exists but could not be opened (their webhook answers 503). */
  private readonly unopenable = new Set<string>();
  /** When each key was last put in force by apply(): a refresh that began earlier never removes it. */
  private readonly appliedAt = new Map<string, number>();
  private sequence = 0;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly eligibility: EmailConnectEligibility;

  constructor(private readonly input: { store: Pick<EmailConnectionStore, 'sources'>; vault: EmailConnectionVault | null; service: EmailBounceService;
    now?: () => number; log?: (line: string) => void;
    /** Which businesses may connect (the platform passes its one; absent: today's static list). */
    eligibility?: EmailConnectEligibility }) {
    this.now = input.now ?? Date.now;
    this.log = input.log ?? (() => undefined);
    this.eligibility = input.eligibility ?? staticEligibility;
  }

  handles(key: string): boolean { return this.eligibility.list().some(business => business.sourceKey === key); }
  unavailable(key: string): boolean { return this.unopenable.has(key); }

  private put(source: EmailBounceSource): void {
    const fresh = !this.input.service.dynamicSourceKeys().includes(source.key);
    this.input.service.upsertSource(source, { replaces: this.eligibility.business(source.workspaceId)?.replacesSourceKey ?? null });
    this.unopenable.delete(source.key);
    // A newly added source is read at once, so bounces from before the webhook existed are known straight away.
    if (fresh) void this.input.service.sweepSource(source).catch(() => undefined);
  }

  /** Puts one source in force at once (the instance that is creating the webhook, before Postmark checks it). */
  apply(source: EmailBounceSource): void {
    this.appliedAt.set(source.key, ++this.sequence);
    this.put(source);
  }
  remove(workspaceId: string): void {
    const business = this.eligibility.business(workspaceId);
    if (!business) return;
    this.appliedAt.set(business.sourceKey, ++this.sequence);
    this.input.service.removeSource(business.sourceKey);
    this.unopenable.delete(business.sourceKey);
  }

  private open(row: StoredConnectionSource): EmailBounceSource | null {
    try {
      if (!this.input.vault) throw new Error('no key');
      return connectionBounceSource({ workspaceId: row.workspaceId, serverId: row.serverId, stream: row.stream,
        serverToken: this.input.vault.open(row.workspaceId, 'server_token', row.sealedServerToken),
        webhookSecret: this.input.vault.open(row.workspaceId, 'webhook_secret', row.sealedWebhookSecret) }, this.eligibility);
    } catch {
      if (!this.warned) {
        this.warned = true;
        this.log(JSON.stringify({ event: 'email.connections.source_unreadable', level: 'warn',
          message: 'A stored email connection could not be opened with EMAIL_CONNECTION_KEY (missing, lost or changed). Its bounce webhook answers 503 until the owner presses Repair (or Continue) on the email page, which makes a new secret and webhook.' }));
      }
      return null;
    }
  }

  /** One read of the store. Throws when the store cannot be read (the sources in force are kept). */
  async refresh(): Promise<void> {
    if (this.running) return this.running;
    const startedAt = this.sequence;
    const run = (async () => {
      const rows = await this.input.store.sources();
      const wanted = new Map<string, EmailBounceSource>(), unreadable = new Set<string>();
      for (const row of rows ?? []) {
        const business = this.eligibility.business(row.workspaceId);
        if (!business) continue;
        const source = this.open(row);
        if (source) wanted.set(source.key, source); else unreadable.add(business.sourceKey);
      }
      // Anything apply() or remove() did after this read began is newer than what the read saw: left as it is.
      const touched = (key: string) => (this.appliedAt.get(key) ?? 0) > startedAt;
      for (const [key, source] of wanted) if (!touched(key)) this.put(source);
      for (const key of unreadable) if (!touched(key)) { this.input.service.removeSource(key); this.unopenable.add(key); }
      for (const key of this.input.service.dynamicSourceKeys()) if (this.handles(key) && !wanted.has(key) && !unreadable.has(key) && !touched(key)) this.input.service.removeSource(key);
      for (const key of [...this.unopenable]) if (!unreadable.has(key) && !touched(key)) this.unopenable.delete(key);
    })();
    this.running = run.finally(() => { this.running = null; });
    return this.running;
  }

  /** The webhook's on-demand read: joins a read in progress, and reads at most once every 5 seconds otherwise. */
  async refreshNow(): Promise<void> {
    if (this.running) return this.running;
    if (this.now() - this.lastForced < FORCED_MIN_INTERVAL_MS) return;
    this.lastForced = this.now();
    return this.refresh();
  }

  /** Reads now, then every intervalMs. Failures are logged (warn) and the sources already in force are kept. */
  start(intervalMs = 60_000): () => void {
    let stopped = false;
    const tick = () => {
      if (stopped) return;
      this.refresh().catch(() => this.log(JSON.stringify({ event: 'email.connections.sources_refresh_failed', level: 'warn',
        message: 'Stored email connections could not be read; the bounce sources already loaded are kept.' })));
    };
    tick();
    const timer = setInterval(tick, intervalMs);
    timer.unref?.();
    return () => { stopped = true; clearInterval(timer); };
  }
}
