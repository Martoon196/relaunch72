/**
 * Stored email connections as bounce sources, without a restart or an env change.
 *
 * Loaded at start, then about every 60 seconds (so other instances pick up a connection made elsewhere), and on
 * demand when Postmark posts to a connection's address this process has not loaded yet. Each source authenticates
 * the webhook with that connection's own (unsealed) secret and reads its stream with its own server token; neither
 * value is ever logged. A connection that cannot be opened (wrong key) is skipped with one warning line.
 */
import type { EmailBounceService, EmailBounceSource, EmailBounceSourceLoader } from '../email-bounces/index.js';
import { EMAIL_CONNECT_BUSINESSES, emailConnectBusiness } from './config.js';
import type { EmailConnectionStore, StoredConnectionSource } from './store.js';
import type { EmailConnectionVault } from './vault.js';

const SECRET = /^[\x21-\x7e]{24,200}$/u;
const FORCED_MIN_INTERVAL_MS = 5_000;

/** One stored connection as a bounce source: its Broadcast stream is a marketing stream. */
export function connectionBounceSource(input: { workspaceId: string; serverId: string; stream: string; serverToken: string; webhookSecret: string }): EmailBounceSource {
  const business = emailConnectBusiness(input.workspaceId);
  if (!business || !SECRET.test(input.webhookSecret) || !/^[0-9]{1,20}$/u.test(input.serverId) || !/^[a-z0-9-]{1,60}$/u.test(input.stream)) throw new Error('Invalid stored email connection');
  return Object.freeze({ key: business.sourceKey, workspaceId: business.workspaceId, token: input.serverToken, webhookSecret: input.webhookSecret,
    serverId: input.serverId, streams: new Map([[input.stream, 'marketing' as const]]), connection: true });
}

export class EmailConnectionBounceSources implements EmailBounceSourceLoader {
  private running: Promise<void> | null = null;
  private lastForced = 0;
  private warned = new Set<string>();
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(private readonly input: { store: Pick<EmailConnectionStore, 'sources'>; vault: EmailConnectionVault; service: EmailBounceService;
    now?: () => number; log?: (line: string) => void }) {
    this.now = input.now ?? Date.now;
    this.log = input.log ?? (() => undefined);
  }

  handles(key: string): boolean { return EMAIL_CONNECT_BUSINESSES.some(business => business.sourceKey === key); }

  /** Puts one source in force at once (the instance that is creating the webhook, before Postmark checks it). */
  apply(source: EmailBounceSource): void {
    this.input.service.upsertSource(source, { replaces: emailConnectBusiness(source.workspaceId)?.replacesSourceKey ?? null });
  }
  remove(workspaceId: string): void {
    const business = emailConnectBusiness(workspaceId);
    if (business) this.input.service.removeSource(business.sourceKey);
  }

  private open(row: StoredConnectionSource): EmailBounceSource | null {
    try {
      return connectionBounceSource({ workspaceId: row.workspaceId, serverId: row.serverId, stream: row.stream,
        serverToken: this.input.vault.open(row.workspaceId, 'server_token', row.sealedServerToken),
        webhookSecret: this.input.vault.open(row.workspaceId, 'webhook_secret', row.sealedWebhookSecret) });
    } catch {
      if (!this.warned.has(row.workspaceId)) {
        this.warned.add(row.workspaceId);
        this.log(JSON.stringify({ event: 'email.connections.source_unreadable', level: 'warn', workspace: row.workspaceId.slice(0, 8),
          message: 'A stored email connection could not be opened with EMAIL_CONNECTION_KEY; its bounce webhook stays closed.' }));
      }
      return null;
    }
  }

  /** One read of the store. Throws when the store cannot be read (the sources in force are kept). */
  async refresh(): Promise<void> {
    if (this.running) return this.running;
    const run = (async () => {
      const rows = await this.input.store.sources();
      const wanted = new Map<string, EmailBounceSource>();
      for (const row of rows ?? []) {
        const source = this.open(row);
        if (source) wanted.set(source.key, source);
      }
      for (const [, source] of wanted) this.apply(source);
      for (const key of this.input.service.dynamicSourceKeys()) if (this.handles(key) && !wanted.has(key)) this.input.service.removeSource(key);
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
