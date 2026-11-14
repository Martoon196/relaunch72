/**
 * Where a business's email connection is kept (migration 0155, app_private.email_connections), behind the definer
 * functions only, on the r72_identity_command identity. Every owner call passes the sha-256 of the owner's portal
 * session token; the database resolves the session again and checks the owner rule itself.
 *
 * While the database still ends at 0154 the functions do not exist: every call then reports "absent" and the feature
 * is simply not offered (nothing errors). The store looks again after a few minutes, so applying 0155 takes effect
 * without a restart. Errors never carry a token, a secret or an address.
 */
import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { EmailConnectionSecretField } from './vault.js';

export type EmailConnectionStatus = 'not_connected' | 'creating' | 'dns_pending' | 'verified' | 'needs_attention' | 'disconnected';
export type EmailConnectionStep = 'server' | 'stream' | 'secret' | 'webhook' | 'domain';
export interface DnsRecordState { readonly host: string; readonly value: string; readonly verified: boolean }
/** How this business got its Postmark domain: created by its own run, adopted by id, or taken over by the founder. */
export type DomainOrigin = 'created' | 'adopted' | 'taken_over';
export interface EmailConnectionDns { readonly dkim: DnsRecordState; readonly returnPath: DnsRecordState; readonly origin?: DomainOrigin }
export interface EmailConnectionState {
  readonly status: EmailConnectionStatus;
  readonly step: EmailConnectionStep | null;
  readonly domain: string | null;
  readonly fromName: string | null;
  readonly fromAddress: string | null;
  readonly replyTo: string | null;
  readonly serverId: number | null;
  readonly domainId: number | null;
  readonly stream: string | null;
  readonly webhookId: number | null;
  readonly hasServerToken: boolean;
  readonly hasWebhookSecret: boolean;
  readonly mode: 'off' | 'test' | 'live';
  readonly dns: EmailConnectionDns | null;
  readonly verifiedAt: string | null;
  readonly rowVersion: number;
  /** Groundwork for protecting the shared Postmark account. Read for display only; nothing enforces them yet. */
  readonly protection: { readonly state: 'ok' | 'slowed' | 'paused' | 'off'; readonly reason: string | null; readonly since: string | null;
    readonly dailyCap: number; readonly hourlyCap: number; readonly warmupStartedAt: string | null };
  /** The email rules agreed to: version, when, and the agreeing user's display name (null when they have none). */
  readonly terms: { readonly version: string; readonly acceptedAt: string; readonly acceptedByName: string | null } | null;
  readonly goLiveApprovedAt: string | null;
  /** A run of this business has started creating this domain at Postmark before (so a 512 is our own domain). */
  readonly domainAttempted: boolean;
}
export interface EmailConnectionForm { readonly domain: string; readonly fromName: string; readonly fromAddress: string; readonly replyTo: string | null }
export interface StoredConnectionSource {
  readonly workspaceId: string; readonly serverId: string; readonly stream: string;
  readonly sealedServerToken: string; readonly sealedWebhookSecret: string;
}
export type BeginOutcome = 'started' | 'terms_required' | 'already_connected' | 'domain_taken';
export type TermsOutcome = 'accepted' | 'already';
export type StepOutcome = 'created' | 'adopted' | 'busy' | 'unauthorized' | 'refused' | 'failed' | 'plan_limit' | 'domain_taken' | 'public_domain' | 'awaiting_approval'
  | 'founder_takeover' | 'domain_removed' | 'domain_kept' | 'domain_gone' | 'domain_remove_failed';
export type CheckOutcome = 'verified' | 'partial' | 'pending';
export interface StepValues { readonly serverId?: number; readonly stream?: string; readonly webhookId?: number; readonly domainId?: number; readonly dns?: EmailConnectionDns }

/** The database does not have 0155 yet: the feature is not offered. */
export class EmailConnectionAbsentError extends Error {
  override readonly name = 'EmailConnectionAbsentError';
  constructor() { super('Email connections are not in this database yet.'); }
}
/** The session is not an eligible owner of this workspace (42501 from the database). */
export class EmailConnectionForbiddenError extends Error {
  override readonly name = 'EmailConnectionForbiddenError';
  constructor() { super('Business owner required.'); }
}

export interface EmailConnectionStore {
  state(sessionToken: string, workspaceId: string): Promise<EmailConnectionState>;
  /** The owner agrees to the email rules of this version (idempotent). */
  acceptTerms(sessionToken: string, workspaceId: string, version: string): Promise<TermsOutcome>;
  /** Refuses ('terms_required') unless the rules of termsVersion were agreed to. */
  begin(sessionToken: string, workspaceId: string, form: EmailConnectionForm, termsVersion: string): Promise<BeginOutcome>;
  intend(sessionToken: string, workspaceId: string, step: EmailConnectionStep): Promise<void>;
  record(sessionToken: string, workspaceId: string, step: EmailConnectionStep, outcome: StepOutcome, values?: StepValues): Promise<void>;
  saveSealed(sessionToken: string, workspaceId: string, field: EmailConnectionSecretField, sealed: string): Promise<void>;
  sealed(sessionToken: string, workspaceId: string): Promise<{ readonly serverToken: string | null; readonly webhookSecret: string | null }>;
  checked(sessionToken: string, workspaceId: string, dns: EmailConnectionDns, dkimVerified: boolean, returnPathVerified: boolean): Promise<CheckOutcome>;
  disconnect(sessionToken: string, workspaceId: string): Promise<void>;
  /** Every live stored connection with its sealed values, for the bounce handler. null: 0155 is not applied. */
  sources(): Promise<readonly StoredConnectionSource[] | null>;
  /**
   * One run per workspace at a time, across every instance. Resolves to a release function once held, or null when
   * another run still holds it after waitMs.
   */
  lock(workspaceId: string, waitMs: number): Promise<(() => Promise<void>) | null>;
  /** Whether the database has 0155 (so an entry to the page may be shown). */
  present(): Promise<boolean>;
}

/** 42883 undefined function, 42P01 undefined table, 3F000 undefined schema: the database still ends before 0155. */
const ABSENT = new Set(['42883', '42P01', '3F000']);
const RECHECK_MS = 5 * 60_000;
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const STATUSES = new Set<EmailConnectionStatus>(['not_connected', 'creating', 'dns_pending', 'verified', 'needs_attention', 'disconnected']);
const STEPS = new Set<EmailConnectionStep>(['server', 'stream', 'secret', 'webhook', 'domain']);
const sessionHash = (token: string): Buffer => createHash('sha256').update(token).digest();
const idOrNull = (value: unknown): number | null => {
  const n = typeof value === 'string' && /^[0-9]{1,15}$/u.test(value) ? Number(value) : value;
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : null;
};
const stringOrNull = (value: unknown): string | null => typeof value === 'string' ? value : null;

function readRecord(value: unknown): DnsRecordState | null {
  if (!record(value) || typeof value.host !== 'string' || typeof value.value !== 'string' || typeof value.verified !== 'boolean') return null;
  return Object.freeze({ host: value.host, value: value.value, verified: value.verified });
}
export function readDns(value: unknown): EmailConnectionDns | null {
  if (!record(value)) return null;
  const dkim = readRecord(value.dkim), returnPath = readRecord(value.returnPath);
  const origin = value.origin === 'created' || value.origin === 'adopted' || value.origin === 'taken_over' ? value.origin : undefined;
  return dkim && returnPath ? Object.freeze({ dkim, returnPath, ...(origin ? { origin } : {}) }) : null;
}

export function readEmailConnectionState(value: unknown): EmailConnectionState {
  if (!record(value) || typeof value.status !== 'string' || !STATUSES.has(value.status as EmailConnectionStatus)) throw new Error('Invalid email connection state');
  const step = typeof value.step === 'string' && STEPS.has(value.step as EmailConnectionStep) ? value.step as EmailConnectionStep : null;
  const mode = value.mode === 'test' || value.mode === 'live' ? value.mode : 'off';
  return Object.freeze({
    status: value.status as EmailConnectionStatus, step, domain: stringOrNull(value.domain), fromName: stringOrNull(value.fromName),
    fromAddress: stringOrNull(value.fromAddress), replyTo: stringOrNull(value.replyTo), serverId: idOrNull(value.serverId), domainId: idOrNull(value.domainId),
    stream: stringOrNull(value.stream), webhookId: idOrNull(value.webhookId), hasServerToken: value.hasServerToken === true, hasWebhookSecret: value.hasWebhookSecret === true,
    mode, dns: readDns(value.dns), verifiedAt: stringOrNull(value.verifiedAt), rowVersion: Number(value.rowVersion) || 0,
    protection: Object.freeze({
      state: value.protectionState === 'slowed' || value.protectionState === 'paused' || value.protectionState === 'off' ? value.protectionState : 'ok',
      reason: stringOrNull(value.protectionReason), since: stringOrNull(value.protectionSince),
      dailyCap: Number.isSafeInteger(value.dailyCap) ? Number(value.dailyCap) : 50, hourlyCap: Number.isSafeInteger(value.hourlyCap) ? Number(value.hourlyCap) : 13,
      warmupStartedAt: stringOrNull(value.warmupStartedAt) }),
    terms: typeof value.termsVersion === 'string' && typeof value.termsAcceptedAt === 'string'
      ? Object.freeze({ version: value.termsVersion, acceptedAt: value.termsAcceptedAt, acceptedByName: stringOrNull(value.termsAcceptedByName) }) : null,
    goLiveApprovedAt: stringOrNull(value.goLiveApprovedAt), domainAttempted: value.domainAttempted === true,
  });
}

export class PgEmailConnectionStore implements EmailConnectionStore {
  private absentUntil = 0;
  private answered = false;
  constructor(private readonly pool: Pick<Pool, 'query' | 'connect'>, private readonly options: { now?: () => number; log?: (line: string) => void;
    /** A dedicated small pool for the run lock (the platform gives it one connection of its own). */
    lockPool?: Pick<Pool, 'connect'> } = {}) {}

  private now(): number { return this.options.now?.() ?? Date.now(); }

  private async call<T>(sql: string, values: unknown[]): Promise<T> {
    if (!this.answered && this.now() < this.absentUntil) throw new EmailConnectionAbsentError();
    try {
      const result = await this.pool.query<{ value: T }>(sql, values);
      this.answered = true; this.absentUntil = 0;
      return result.rows[0]!.value;
    } catch (error) {
      const code = String((error as { code?: unknown })?.code ?? '');
      if (ABSENT.has(code)) {
        if (this.answered) {
          this.options.log?.(JSON.stringify({ event: 'email.connections.store_missing_after_use', level: 'warn', code }));
          throw error;
        }
        if (this.absentUntil === 0) this.options.log?.(JSON.stringify({ event: 'email.connections.store_absent', level: 'info',
          message: 'Email connections (0155) are not in this database yet; Connect email is not offered.' }));
        this.absentUntil = this.now() + RECHECK_MS;
        throw new EmailConnectionAbsentError();
      }
      if (code === '42501') throw new EmailConnectionForbiddenError();
      throw error;
    }
  }

  async state(sessionToken: string, workspaceId: string): Promise<EmailConnectionState> {
    return readEmailConnectionState(await this.call<unknown>('SELECT app_private.email_connection_state($1,$2) AS value', [sessionHash(sessionToken), workspaceId]));
  }

  async acceptTerms(sessionToken: string, workspaceId: string, version: string): Promise<TermsOutcome> {
    const value = await this.call<unknown>('SELECT app_private.email_connection_accept_terms($1,$2,$3) AS value', [sessionHash(sessionToken), workspaceId, version]);
    if (value !== 'accepted' && value !== 'already') throw new Error('Invalid email connection answer');
    return value;
  }

  async begin(sessionToken: string, workspaceId: string, form: EmailConnectionForm, termsVersion: string): Promise<BeginOutcome> {
    const value = await this.call<unknown>('SELECT app_private.email_connection_begin($1,$2,$3,$4,$5,$6,$7) AS value',
      [sessionHash(sessionToken), workspaceId, form.domain, form.fromName, form.fromAddress, form.replyTo, termsVersion]);
    if (value !== 'started' && value !== 'terms_required' && value !== 'already_connected' && value !== 'domain_taken') throw new Error('Invalid email connection answer');
    return value;
  }

  async intend(sessionToken: string, workspaceId: string, step: EmailConnectionStep): Promise<void> {
    await this.call('SELECT app_private.email_connection_intend($1,$2,$3) AS value', [sessionHash(sessionToken), workspaceId, step]);
  }

  async record(sessionToken: string, workspaceId: string, step: EmailConnectionStep, outcome: StepOutcome, values: StepValues = {}): Promise<void> {
    await this.call('SELECT app_private.email_connection_record($1,$2,$3,$4,$5::jsonb) AS value', [sessionHash(sessionToken), workspaceId, step, outcome, JSON.stringify(values)]);
  }

  async saveSealed(sessionToken: string, workspaceId: string, field: EmailConnectionSecretField, sealed: string): Promise<void> {
    await this.call('SELECT app_private.email_connection_save_sealed($1,$2,$3,$4) AS value', [sessionHash(sessionToken), workspaceId, field, sealed]);
  }

  async sealed(sessionToken: string, workspaceId: string): Promise<{ readonly serverToken: string | null; readonly webhookSecret: string | null }> {
    const value = await this.call<unknown>('SELECT app_private.email_connection_sealed($1,$2) AS value', [sessionHash(sessionToken), workspaceId]);
    if (!record(value)) throw new Error('Invalid email connection answer');
    return { serverToken: stringOrNull(value.serverToken), webhookSecret: stringOrNull(value.webhookSecret) };
  }

  async checked(sessionToken: string, workspaceId: string, dns: EmailConnectionDns, dkimVerified: boolean, returnPathVerified: boolean): Promise<CheckOutcome> {
    const value = await this.call<unknown>('SELECT app_private.email_connection_checked($1,$2,$3::jsonb,$4,$5) AS value',
      [sessionHash(sessionToken), workspaceId, JSON.stringify(dns), dkimVerified, returnPathVerified]);
    if (value !== 'verified' && value !== 'partial' && value !== 'pending') throw new Error('Invalid email connection answer');
    return value;
  }

  async disconnect(sessionToken: string, workspaceId: string): Promise<void> {
    await this.call('SELECT app_private.email_connection_disconnect($1,$2) AS value', [sessionHash(sessionToken), workspaceId]);
  }

  async sources(): Promise<readonly StoredConnectionSource[] | null> {
    let value: unknown;
    try { value = await this.call<unknown>('SELECT app_private.email_connection_sources() AS value', []); }
    catch (error) { if (error instanceof EmailConnectionAbsentError) return null; throw error; }
    if (!Array.isArray(value)) throw new Error('Invalid email connection sources');
    const out: StoredConnectionSource[] = [];
    for (const item of value) {
      if (!record(item) || typeof item.workspaceId !== 'string' || typeof item.stream !== 'string' || typeof item.sealedServerToken !== 'string'
          || typeof item.sealedWebhookSecret !== 'string' || idOrNull(item.serverId) === null) continue;
      out.push(Object.freeze({ workspaceId: item.workspaceId.toLowerCase(), serverId: String(idOrNull(item.serverId)), stream: item.stream,
        sealedServerToken: item.sealedServerToken, sealedWebhookSecret: item.sealedWebhookSecret }));
    }
    return out;
  }

  /** Whether this database has 0155 at all (cached for a few minutes); never throws. */
  async present(): Promise<boolean> {
    if (this.answered) return true;
    if (this.now() < this.absentUntil) return false;
    try {
      const result = await this.pool.query<{ ready: boolean }>(`/* email-connections.schema-readiness */
        SELECT to_regprocedure('app_private.email_connection_state(bytea,uuid)') IS NOT NULL AS ready`);
      if (result.rows[0]?.ready === true) return true;
      this.absentUntil = this.now() + RECHECK_MS;
      return false;
    } catch { return false; }
  }

  /**
   * One run per business at a time, across every instance: a transaction-level advisory lock held in ONE open
   * transaction, so it stays on one backend even behind a transaction pooler. It uses its own small pool (never one
   * of the shared identity connections) and gives the connection back between tries, so a waiter holds nothing.
   */
  async lock(workspaceId: string, waitMs: number): Promise<(() => Promise<void>) | null> {
    const pool = this.options.lockPool ?? this.pool;
    const key = `email-connection-run:${workspaceId.toLowerCase()}`;
    const deadline = this.now() + waitMs;
    for (;;) {
      const client: PoolClient = await pool.connect();
      let held = false;
      try {
        await client.query('BEGIN');
        const result = await client.query<{ held: boolean }>('SELECT pg_try_advisory_xact_lock(hashtextextended($1,155)) AS held', [key]);
        held = result.rows[0]?.held === true;
        if (!held) await client.query('ROLLBACK');
      } catch (error) { client.release(true); throw error; }
      if (held) {
        let released = false;
        return async () => {
          if (released) return;
          released = true;
          try { await client.query('ROLLBACK'); client.release(); } catch { client.release(true); }
        };
      }
      client.release();
      if (this.now() >= deadline) return null;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
}
