/**
 * The founder's allow-list for "Connect email" (migration 0157, app_private.email_connect_allowlist), behind the
 * r72_email_allowlist_definer functions only, on the r72_identity_command identity.
 *
 *   PgEmailConnectAllowlist   the reads and the founder's three actions (allow, switch off, allow again).
 *   databaseEligibility()     the EmailConnectEligibility the platform composes: the active list, read BEFORE
 *                             composition and refreshed on the stored-connections tick (about every 60 seconds).
 *
 * While the database still ends at 0156 the functions do not exist: the read answers "absent", the eligibility is
 * exactly the static list (Property Predator only, with its messages), one informational line says so, and it looks
 * again on every refresh, so applying 0157 takes effect without a restart. A read that fails keeps the last good list;
 * the first read failing composes with the static list (never with nothing). An empty answer from the database is the
 * founder's own decision (every business switched off) and is honoured: it can never silence a bounce webhook, which
 * follows the stored connection rows, not this list.
 */
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { PortalSessionIdentity } from '../portal/auth-service.js';
import { connectionSourceKey, type EmailConnectBusiness } from './config.js';
import { EMAIL_CONNECT_BUSINESSES, type EmailConnectEligibility } from './eligibility.js';

const ABSENT = new Set(['42883', '42P01', '3F000']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const NAME = /^[A-Za-z0-9][A-Za-z0-9 &.,()'+-]{1,59}$/u;
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string | null => typeof value === 'string' ? value : null;
const hash = (token: string): Buffer => createHash('sha256').update(token).digest();

export type AllowOutcome = 'allowed' | 'already_allowed' | 'revoked' | 'no_workspace';
export type ReallowOutcome = 'reallowed' | 'already_allowed' | 'not_listed' | 'no_workspace';
export type RevokeOutcome = 'revoked' | 'already_revoked' | 'not_listed' | 'reason_required';

/** One business on the founder's list. */
export interface AllowlistBusiness {
  readonly workspaceId: string;
  /** The name used at Postmark. */
  readonly name: string;
  /** The workspace's own name (what the founder knows it as), or null. */
  readonly businessName: string | null;
  readonly allowedAt: string; readonly allowedByName: string | null;
  readonly revokedAt: string | null; readonly revokedByName: string | null; readonly revokedReason: string | null;
  readonly note: string | null;
  readonly hasConnection: boolean; readonly status: string | null; readonly mode: 'off' | 'test' | 'live' | null; readonly protectionState: string | null;
}
export interface AllowlistView {
  readonly businesses: readonly AllowlistBusiness[];
  /** The founder's own businesses (as the Business picker lists them) that are not on the list yet. */
  readonly candidates: readonly { readonly workspaceId: string; readonly name: string }[];
}

/** The database does not have 0157 yet. */
export class EmailConnectAllowlistAbsentError extends Error {
  override readonly name = 'EmailConnectAllowlistAbsentError';
  constructor() { super('The email allow-list is not in this database yet.'); }
}
export class EmailConnectAllowlistForbiddenError extends Error {
  override readonly name = 'EmailConnectAllowlistForbiddenError';
  constructor() { super('Founder required.'); }
}
export class EmailConnectAllowlistInvalidError extends Error {
  override readonly name = 'EmailConnectAllowlistInvalidError';
  constructor() { super('Invalid input.'); }
}

export interface EmailConnectAllowlistStore {
  /** The active allow-list (lower-case ids), or null when 0157 is not applied. Throws when it cannot be read. */
  active(): Promise<readonly { readonly workspaceId: string; readonly name: string }[] | null>;
  founderView(sessionToken: string): Promise<AllowlistView>;
  allow(sessionToken: string, workspaceId: string, note: string | null): Promise<AllowOutcome>;
  reallow(sessionToken: string, workspaceId: string, note: string | null): Promise<ReallowOutcome>;
  revoke(sessionToken: string, workspaceId: string, reason: string): Promise<RevokeOutcome>;
}

export class PgEmailConnectAllowlist implements EmailConnectAllowlistStore {
  private told = false;
  constructor(private readonly pool: Pick<Pool, 'query'>, private readonly options: { log?: (line: string) => void } = {}) {}

  private async call<T>(sql: string, values: unknown[]): Promise<T> {
    try { return (await this.pool.query<{ value: T }>(sql, values)).rows[0]!.value; }
    catch (error) {
      const code = String((error as { code?: unknown })?.code ?? '');
      if (ABSENT.has(code)) throw new EmailConnectAllowlistAbsentError();
      if (code === '42501') throw new EmailConnectAllowlistForbiddenError();
      if (code === '22023') throw new EmailConnectAllowlistInvalidError();
      throw error;
    }
  }

  async active(): Promise<readonly { readonly workspaceId: string; readonly name: string }[] | null> {
    let value: unknown;
    try { value = await this.call<unknown>('SELECT app_private.email_connect_allowlist_active() AS value', []); }
    catch (error) {
      if (!(error instanceof EmailConnectAllowlistAbsentError)) throw error;
      if (!this.told) {
        this.told = true;
        this.options.log?.(JSON.stringify({ event: 'email.connections.allowlist_absent', level: 'info',
          message: 'The email allow-list (0157) is not in this database yet; Connect email stays Property Predator only.' }));
      }
      return null;
    }
    if (!Array.isArray(value)) throw new Error('Invalid email allow-list');
    const out: { workspaceId: string; name: string }[] = [];
    for (const item of value) {
      if (!record(item) || typeof item.workspaceId !== 'string' || !UUID.test(item.workspaceId.toLowerCase()) || typeof item.name !== 'string' || !NAME.test(item.name)) {
        throw new Error('Invalid email allow-list');
      }
      out.push(Object.freeze({ workspaceId: item.workspaceId.toLowerCase(), name: item.name }));
    }
    return Object.freeze(out);
  }

  async founderView(sessionToken: string): Promise<AllowlistView> {
    const value = await this.call<unknown>('SELECT app_private.email_connect_allowlist_view($1) AS value', [hash(sessionToken)]);
    if (!record(value) || !Array.isArray(value.businesses) || !Array.isArray(value.candidates)) throw new Error('Invalid email allow-list');
    const mode = (m: unknown) => m === 'off' || m === 'test' || m === 'live' ? m : null;
    return Object.freeze({
      businesses: Object.freeze(value.businesses.filter(record).map(b => Object.freeze({ workspaceId: String(b.workspaceId).toLowerCase(), name: String(b.name ?? ''),
        businessName: str(b.businessName), allowedAt: String(b.allowedAt ?? ''), allowedByName: str(b.allowedByName), revokedAt: str(b.revokedAt),
        revokedByName: str(b.revokedByName), revokedReason: str(b.revokedReason), note: str(b.note), hasConnection: b.hasConnection === true,
        status: str(b.status), mode: mode(b.mode), protectionState: str(b.protectionState) }))),
      candidates: Object.freeze(value.candidates.filter(record).filter(c => typeof c.workspaceId === 'string' && typeof c.name === 'string')
        .map(c => Object.freeze({ workspaceId: String(c.workspaceId).toLowerCase(), name: String(c.name) }))),
    });
  }

  async allow(sessionToken: string, workspaceId: string, note: string | null): Promise<AllowOutcome> {
    return this.call<AllowOutcome>('SELECT app_private.email_connect_allow($1,$2,$3) AS value', [hash(sessionToken), workspaceId, note]);
  }
  async reallow(sessionToken: string, workspaceId: string, note: string | null): Promise<ReallowOutcome> {
    return this.call<ReallowOutcome>('SELECT app_private.email_connect_reallow($1,$2,$3) AS value', [hash(sessionToken), workspaceId, note]);
  }
  async revoke(sessionToken: string, workspaceId: string, reason: string): Promise<RevokeOutcome> {
    return this.call<RevokeOutcome>('SELECT app_private.email_connect_revoke($1,$2,$3) AS value', [hash(sessionToken), workspaceId, reason]);
  }
}

/** The database-backed eligibility: answers from the last good snapshot; refresh() reads again. */
export interface DatabaseEligibility extends EmailConnectEligibility {
  /** Reads the list again. Never throws: a failed read keeps the last good list (logged once per failure run). */
  refresh(): Promise<void>;
}

const businessOf = (item: { workspaceId: string; name: string }): EmailConnectBusiness =>
  Object.freeze({ workspaceId: item.workspaceId, name: item.name, sourceKey: connectionSourceKey(item.workspaceId), replacesSourceKey: null });

/**
 * Loads the allow-list (awaited by the caller BEFORE anything is composed with it) and returns the eligibility.
 * 0157 absent: exactly the static list, re-checked on every refresh. First read failed: the static list, re-read on
 * every refresh.
 */
export async function databaseEligibility(source: Pick<EmailConnectAllowlistStore, 'active'>, options: { log?: (line: string) => void } = {}): Promise<DatabaseEligibility> {
  let businesses: readonly EmailConnectBusiness[] = EMAIL_CONNECT_BUSINESSES;
  let fromDatabase = false;
  let failing = false;
  let running: Promise<void> | null = null;
  const read = async (): Promise<void> => {
    let rows: Awaited<ReturnType<typeof source.active>>;
    try { rows = await source.active(); }
    catch {
      if (!failing) options.log?.(JSON.stringify({ event: 'email.connections.allowlist_refresh_failed', level: 'warn',
        message: 'The email allow-list could not be read; the last list read is kept.' }));
      failing = true;
      return;
    }
    failing = false;
    if (rows === null) { businesses = EMAIL_CONNECT_BUSINESSES; fromDatabase = false; return; }
    businesses = Object.freeze(rows.map(businessOf));
    fromDatabase = true;
  };
  const refresh = (): Promise<void> => running ??= read().finally(() => { running = null; });
  await refresh();
  const business = (workspaceId: string): EmailConnectBusiness | null => businesses.find(item => item.workspaceId === workspaceId.toLowerCase()) ?? null;
  return Object.freeze({
    business,
    allowed: (workspaceId: string) => business(workspaceId) !== null,
    list: () => businesses,
    get fromDatabase() { return fromDatabase; },
    refresh,
  });
}

/** Every sentence the founder can see from the allow-list section. Plain English; never an id or a setting name. */
export const ALLOWLIST_MESSAGES = Object.freeze({
  allowed: 'Email is switched on for this business. Its owner can now connect email from their email page.',
  alreadyAllowed: 'Email was already switched on for this business, so nothing changed.',
  allowRevoked: 'Email was switched off for this business. To switch it back on, press Allow again below.',
  noWorkspace: 'That business could not be found, or it is not active. Nothing changed.',
  revoked: 'Email is switched off for this business. Nothing more is sent through its connection; bounces from emails it already sent are still recorded.',
  alreadyRevoked: 'Email was already switched off for this business, so nothing changed.',
  notListed: 'That business is not on the list, so nothing changed.',
  reasonRequired: 'Say in a few words why email is being switched off, then press the button again.',
  reallowed: 'Email is switched back on for this business. It sends again as it did before it was switched off.',
  invalid: 'A note or reason can be up to 300 characters, on one line. Nothing changed.',
  notFounder: 'Only the founder can do this.',
  notAvailable: 'This isn\'t available here yet.',
  busy: 'Something went wrong on our side. Nothing was changed. Please try again in a minute.',
});

export type AllowlistAction = 'allow' | 'revoke' | 'reallow';
export interface AllowlistResult { readonly ok: boolean; readonly message: string }

/**
 * The founder's allow-list actions on /portal/email/founder: the founder is checked here (the same check the rest of
 * the founder page uses) and again in the database on every call. After a change this process reads the list again
 * at once; other processes pick it up on their next tick (about a minute). Sending never waits for that: the database
 * stops a switched-off business's sends from the moment the change commits.
 */
export class EmailConnectAllowlistService {
  constructor(private readonly input: { store: EmailConnectAllowlistStore; founder: (identity: PortalSessionIdentity) => Promise<boolean>;
    eligibility?: Pick<DatabaseEligibility, 'refresh'>; log?: (line: string) => void }) {}

  private async isFounder(identity: PortalSessionIdentity): Promise<boolean> {
    try { return (await this.input.founder(identity)) === true; } catch { return false; }
  }

  /** The founder's list, or null (not the founder, or the database does not have 0157). */
  async view(identity: PortalSessionIdentity): Promise<AllowlistView | null> {
    if (!(await this.isFounder(identity))) return null;
    try { return await this.input.store.founderView(identity.sessionToken); }
    catch (error) {
      if (error instanceof EmailConnectAllowlistAbsentError || error instanceof EmailConnectAllowlistForbiddenError) return null;
      this.input.log?.(JSON.stringify({ event: 'email.connections.allowlist_view_failed', level: 'warn' }));
      return null;
    }
  }

  async act(identity: PortalSessionIdentity, action: AllowlistAction, workspaceId: string, text: string | null): Promise<AllowlistResult> {
    if (!(await this.isFounder(identity))) return { ok: false, message: ALLOWLIST_MESSAGES.notFounder };
    const ws = workspaceId.toLowerCase();
    let outcome: AllowOutcome | ReallowOutcome | RevokeOutcome;
    try {
      outcome = action === 'allow' ? await this.input.store.allow(identity.sessionToken, ws, text)
        : action === 'reallow' ? await this.input.store.reallow(identity.sessionToken, ws, text)
          : await this.input.store.revoke(identity.sessionToken, ws, text ?? '');
    } catch (error) {
      if (error instanceof EmailConnectAllowlistForbiddenError) return { ok: false, message: ALLOWLIST_MESSAGES.notFounder };
      if (error instanceof EmailConnectAllowlistInvalidError) return { ok: false, message: ALLOWLIST_MESSAGES.invalid };
      if (error instanceof EmailConnectAllowlistAbsentError) return { ok: false, message: ALLOWLIST_MESSAGES.notAvailable };
      this.input.log?.(JSON.stringify({ event: 'email.connections.allowlist_action_failed', level: 'warn', action }));
      return { ok: false, message: ALLOWLIST_MESSAGES.busy };
    }
    if (outcome === 'allowed' || outcome === 'reallowed' || (outcome === 'revoked' && action === 'revoke')) {
      this.input.log?.(JSON.stringify({ event: 'email.connections.allowlist_changed', level: 'info', action, workspace: ws.slice(0, 8) }));
      await this.input.eligibility?.refresh();
    }
    switch (outcome) {
      case 'allowed': return { ok: true, message: ALLOWLIST_MESSAGES.allowed };
      case 'reallowed': return { ok: true, message: ALLOWLIST_MESSAGES.reallowed };
      case 'revoked': return action === 'revoke' ? { ok: true, message: ALLOWLIST_MESSAGES.revoked } : { ok: false, message: ALLOWLIST_MESSAGES.allowRevoked };
      case 'already_allowed': return { ok: false, message: ALLOWLIST_MESSAGES.alreadyAllowed };
      case 'already_revoked': return { ok: false, message: ALLOWLIST_MESSAGES.alreadyRevoked };
      case 'not_listed': return { ok: false, message: ALLOWLIST_MESSAGES.notListed };
      case 'reason_required': return { ok: false, message: ALLOWLIST_MESSAGES.reasonRequired };
      case 'no_workspace': return { ok: false, message: ALLOWLIST_MESSAGES.noWorkspace };
      default: return { ok: false, message: ALLOWLIST_MESSAGES.busy };
    }
  }
}
