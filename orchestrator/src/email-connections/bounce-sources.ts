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
 *
 * A source FOLLOWS ITS STORED ROW, never the allow-list: a business the founder switched off keeps its bounce webhook
 * answered, in this process and in one started later, for as long as its connection row exists (not disconnected), so
 * bounces and complaints from mail it already sent are still recorded and Postmark never gets a 404. Its sending is
 * stopped in the database instead (0157 email_send_reserve: 'not_allowed'). The allow-list is read again on the same
 * tick (refreshEligibility), before the rows.
 */
import type { EmailBounceService, EmailBounceSource, EmailBounceSourceLoader } from '../email-bounces/index.js';
import { connectionSourceKey } from './config.js';
import type { EmailConnectEligibility } from './eligibility.js';
import type { EmailConnectionStore, StoredConnectionSource } from './store.js';
import type { EmailConnectionVault } from './vault.js';

const SECRET = /^[\x21-\x7e]{24,200}$/u;
const FORCED_MIN_INTERVAL_MS = 5_000;

const WORKSPACE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
/** The shape of a stored connection's source key ("conn-" and the 32 hex digits of its workspace id). */
const CONNECTION_KEY = /^conn-[0-9a-f]{32}$/u;

/**
 * One stored connection as a bounce source: its Broadcast stream is a marketing stream. Its key and workspace come from
 * the stored row itself (the same key Connect gave Postmark), whatever the allow-list says now.
 */
export function connectionBounceSource(input: { workspaceId: string; serverId: string; stream: string; serverToken: string; webhookSecret: string }): EmailBounceSource {
  const workspaceId = input.workspaceId.toLowerCase();
  if (!WORKSPACE.test(workspaceId) || !SECRET.test(input.webhookSecret) || !/^[0-9]{1,20}$/u.test(input.serverId) || !/^[a-z0-9-]{1,60}$/u.test(input.stream)) throw new Error('Invalid stored email connection');
  return Object.freeze({ key: connectionSourceKey(workspaceId), workspaceId, token: input.serverToken, webhookSecret: input.webhookSecret,
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
    /** Which businesses may connect: the one the platform composed (only replacesSourceKey is read from it here). */
    eligibility: EmailConnectEligibility;
    /** Reads the allow-list again; run at the start of every refresh (the platform's database eligibility). */
    refreshEligibility?: () => Promise<void> }) {
    this.now = input.now ?? Date.now;
    this.log = input.log ?? (() => undefined);
    this.eligibility = input.eligibility;
  }

  /** Every stored connection's address is ours to look up (allowed now or not): the row decides, not the list. */
  handles(key: string): boolean { return CONNECTION_KEY.test(key); }
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
    const ws = workspaceId.toLowerCase();
    if (!WORKSPACE.test(ws)) return;
    const key = connectionSourceKey(ws);
    this.appliedAt.set(key, ++this.sequence);
    this.input.service.removeSource(key);
    this.unopenable.delete(key);
  }

  private open(row: StoredConnectionSource): EmailBounceSource | null {
    try {
      if (!this.input.vault) throw new Error('no key');
      return connectionBounceSource({ workspaceId: row.workspaceId, serverId: row.serverId, stream: row.stream,
        serverToken: this.input.vault.open(row.workspaceId, 'server_token', row.sealedServerToken),
        webhookSecret: this.input.vault.open(row.workspaceId, 'webhook_secret', row.sealedWebhookSecret) });
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
      // The allow-list first (it never throws: a failed read keeps the last good list), then the rows.
      await this.input.refreshEligibility?.().catch(() => undefined);
      const rows = await this.input.store.sources();
      const wanted = new Map<string, EmailBounceSource>(), unreadable = new Set<string>();
      for (const row of rows ?? []) {
        if (!WORKSPACE.test(row.workspaceId.toLowerCase())) continue;
        const source = this.open(row);
        if (source) wanted.set(source.key, source); else unreadable.add(connectionSourceKey(row.workspaceId));
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
