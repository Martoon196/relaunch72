import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const COMPANY_CONTENT_SYNC_ROUTE = '/portal/content/source-sync' as const;

export type CompanyContentSyncNoticeCode =
  | 'synced'
  | 'attention'
  | 'retry_wait'
  | 'busy'
  | 'replayed'
  | 'forbidden'
  | 'invalid'
  | 'unavailable';

export interface CompanyContentSyncNoticeView {
  readonly kind: 'success' | 'info' | 'error';
  readonly title: string;
  readonly message: string;
}

const NOTICE_CODES = new Set<CompanyContentSyncNoticeCode>([
  'synced', 'attention', 'retry_wait', 'busy', 'replayed', 'forbidden', 'invalid', 'unavailable',
]);
const NOTICE_CONTEXT = 'relaunch72:company-content-sync-notice:v1\0';
const COMMAND_CONTEXT = 'relaunch72:company-content-sync-command:v1\0';
const COMMAND_KEY = /^[A-Za-z0-9_-]{16,128}$/u;
const COMMAND_PAYLOAD = /^([A-Za-z0-9_-]{16,128})~([0-9a-z]{1,11})$/u;
const COMMAND_MAX_AGE_MS = 10 * 60_000;
const COMMAND_FUTURE_SKEW_MS = 30_000;
const REPLAY_RETENTION_MS = COMMAND_MAX_AGE_MS + COMMAND_FUTURE_SKEW_MS;
const MAX_REPLAY_ENTRIES = 2_048;

function mac(secret: string, context: string, sessionToken: string, value: string): string {
  return createHmac('sha256', secret)
    .update(context).update(sessionToken).update('\0').update(value)
    .digest('base64url');
}

function exactSignedValue(
  supplied: string,
  allowedValue: (value: string) => boolean,
  expectedMac: (value: string) => string,
): string | null {
  const separator = supplied.indexOf('.');
  if (separator <= 0 || supplied.indexOf('.', separator + 1) !== -1) return null;
  const value = supplied.slice(0, separator);
  const suppliedMac = supplied.slice(separator + 1);
  if (!allowedValue(value) || !suppliedMac || suppliedMac.length > 128) return null;
  const expected = expectedMac(value);
  const actualBytes = Buffer.from(suppliedMac);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)
    ? value
    : null;
}

export function companyContentSyncCommandToken(
  secret: string,
  sessionToken: string,
  commandKey: string,
  issuedAtMs: number,
): string {
  if (!secret || !sessionToken || !COMMAND_KEY.test(commandKey)
      || !Number.isSafeInteger(issuedAtMs) || issuedAtMs < 0) return '';
  const payload = `${commandKey}~${issuedAtMs.toString(36)}`;
  return `${payload}.${mac(secret, COMMAND_CONTEXT, sessionToken, payload)}`;
}

export function verifyCompanyContentSyncCommandToken(
  secret: string,
  sessionToken: string,
  supplied: string,
  nowMs: number,
): string | null {
  if (!secret || !sessionToken || typeof supplied !== 'string'
      || !Number.isSafeInteger(nowMs) || nowMs < 0) return null;
  const payload = exactSignedValue(
    supplied,
    (value) => COMMAND_PAYLOAD.test(value),
    (value) => mac(secret, COMMAND_CONTEXT, sessionToken, value),
  );
  if (!payload) return null;
  const match = COMMAND_PAYLOAD.exec(payload);
  if (!match) return null;
  const issuedAtMs = Number.parseInt(match[2]!, 36);
  if (!Number.isSafeInteger(issuedAtMs)
      || issuedAtMs > nowMs + COMMAND_FUTURE_SKEW_MS
      || nowMs - issuedAtMs > COMMAND_MAX_AGE_MS) return null;
  return match[1]!;
}

export interface CompanyContentSyncReplayGuard {
  /** Atomically accepts a command once for this running portal process. */
  consume(
    sessionToken: string,
    commandKey: string,
    nowMs: number,
  ): 'accepted' | 'replayed' | 'saturated';
}

/**
 * A bounded server-side one-use guard closes browser and sequential HTTP
 * replay before any source read starts. The sync itself remains database
 * idempotent; this process-local layer stores only hashes and expires them.
 */
export class InMemoryCompanyContentSyncReplayGuard implements CompanyContentSyncReplayGuard {
  private readonly consumed = new Map<string, number>();

  consume(
    sessionToken: string,
    commandKey: string,
    nowMs: number,
  ): 'accepted' | 'replayed' | 'saturated' {
    if (!sessionToken || !COMMAND_KEY.test(commandKey)
        || !Number.isSafeInteger(nowMs) || nowMs < 0) return 'saturated';
    for (const [key, expiresAt] of this.consumed) {
      if (expiresAt <= nowMs) this.consumed.delete(key);
    }
    const evidenceHash = createHash('sha256')
      .update('relaunch72:company-content-sync-replay:v1\0')
      .update(sessionToken)
      .update('\0')
      .update(commandKey)
      .digest('base64url');
    const existing = this.consumed.get(evidenceHash);
    if (existing !== undefined && existing > nowMs) return 'replayed';
    if (this.consumed.size >= MAX_REPLAY_ENTRIES) {
      return 'saturated';
    }
    this.consumed.set(evidenceHash, nowMs + REPLAY_RETENTION_MS);
    return 'accepted';
  }
}

export function companyContentSyncNoticeToken(
  secret: string,
  sessionToken: string,
  code: CompanyContentSyncNoticeCode,
): string {
  if (!secret || !sessionToken || !NOTICE_CODES.has(code)) return '';
  return `${code}.${mac(secret, NOTICE_CONTEXT, sessionToken, code)}`;
}

function noticeFor(code: CompanyContentSyncNoticeCode): CompanyContentSyncNoticeView {
  if (code === 'synced') return Object.freeze({
    kind: 'success', title: 'Owned-content proof refreshed',
    message: 'The scoped source and exact immutable resources agreed. No provider, publishing or generation action ran.',
  });
  if (code === 'attention') return Object.freeze({
    kind: 'info', title: 'Sync completed with protected blockers',
    message: 'Safe records were reconciled and anything unresolved stayed blocked or quarantined. Review the exact reasons below.',
  });
  if (code === 'retry_wait') return Object.freeze({
    kind: 'info', title: 'Source retry is safely delayed',
    message: 'The source could not be proved this time. No unsafe record was accepted; use the displayed retry window.',
  });
  if (code === 'busy') return Object.freeze({
    kind: 'info', title: 'Source Sync already running',
    message: 'Another protected sync owns this workspace lock. No duplicate run started; refresh shortly.',
  });
  if (code === 'replayed') return Object.freeze({
    kind: 'info', title: 'Source Sync already accepted',
    message: 'That protected command has already been used. No duplicate source read or sync started.',
  });
  if (code === 'forbidden') return Object.freeze({
    kind: 'error', title: 'Founder access required',
    message: 'Only a workspace owner or admin can run source sync. Nothing changed.',
  });
  if (code === 'invalid') return Object.freeze({
    kind: 'error', title: 'Source Sync request rejected',
    message: 'The protected form was incomplete, duplicated or expired. Nothing changed.',
  });
  return Object.freeze({
    kind: 'error', title: 'Source Sync unavailable',
    message: 'The command could not complete safely. No provider, publishing or external-delivery action ran.',
  });
}

export function companyContentSyncNoticeFromQuery(
  query: URLSearchParams,
  secret: string,
  sessionToken: string,
): CompanyContentSyncNoticeView | undefined {
  const supplied = query.getAll('notice');
  if (supplied.length !== 1 || !secret || !sessionToken) return undefined;
  const code = exactSignedValue(
    supplied[0]!,
    (value) => NOTICE_CODES.has(value as CompanyContentSyncNoticeCode),
    (value) => mac(secret, NOTICE_CONTEXT, sessionToken, value),
  ) as CompanyContentSyncNoticeCode | null;
  return code ? noticeFor(code) : undefined;
}
