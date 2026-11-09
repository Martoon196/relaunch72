import { createHash } from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';
import type { SqlExecutor } from '../crm-pg/types.js';
import { requestDatabaseContext, type DatabaseRequestContext } from '../db/rls.js';
import { InactivePortalSessionError, withTransaction } from '../db/transaction.js';
import {
  createPgPortalCrmPrincipalResolver,
  type PortalCrmPrincipal,
  type PortalCrmPrincipalResolver,
} from './crm-pg-service.js';
import {
  PORTAL_LIVE_CHANNEL_BLOCKER_CODES,
  PORTAL_LIVE_CHANNEL_TRUTH_RAILS,
  type PortalLiveChannelBlockerCode,
  type PortalLiveChannelConnectionState,
  type PortalLiveChannelInboundState,
  type PortalLiveChannelLatestReceipt,
  type PortalLiveChannelOutboundOrReplyState,
  type PortalLiveChannelReceiptOutcome,
  type PortalLiveChannelReceiptState,
  type PortalLiveChannelTruthFailure,
  type PortalLiveChannelTruthRail,
  type PortalLiveChannelTruthRailSnapshot,
  type PortalLiveChannelTruthService,
  type PortalLiveChannelTruthSnapshot,
  type PortalLiveChannelTruthSnapshotOutcome,
} from './live-channel-truth-service.js';
import type { PortalCrmRequestIdentity } from './crm-service.js';

const MAX_CAP_VALUE = 1_000_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

const RAILS = new Set<string>(PORTAL_LIVE_CHANNEL_TRUTH_RAILS);
const BLOCKER_CODES = new Set<string>(PORTAL_LIVE_CHANNEL_BLOCKER_CODES);
const CONNECTION_STATES = new Set<string>([
  'not_configured', 'configured', 'ready', 'degraded', 'revoked', 'not_composed',
]);
const INBOUND_STATES = new Set<string>([
  'not_supported', 'not_ready', 'ready', 'degraded',
]);
const OUTBOUND_OR_REPLY_STATES = new Set<string>([
  'not_supported', 'effects_disabled', 'blocked', 'approval_required', 'ready', 'cap_reached',
]);
const RECEIPT_STATES = new Set<string>([
  'none', 'pending', 'healthy', 'needs_attention', 'outcome_unknown',
]);
const RECEIPT_OUTCOMES = new Set<string>([
  'accepted', 'succeeded', 'failed', 'inbound_verified', 'outcome_unknown',
]);

interface LiveChannelTruthRow extends QueryResultRow {
  readonly workspaceId: unknown;
  readonly snapshotAt: unknown;
  readonly rail: unknown;
  readonly connectionState: unknown;
  readonly inboundState: unknown;
  readonly outboundOrReplyState: unknown;
  readonly receiptState: unknown;
  readonly dailyUsed: unknown;
  readonly dailyLimit: unknown;
  readonly monthlyUsed: unknown;
  readonly monthlyLimit: unknown;
  readonly blockerCodes: unknown;
  readonly latestReceiptId: unknown;
  readonly latestReceiptOutcome: unknown;
  readonly latestReceiptAt: unknown;
  readonly latestReceiptEvidenceSha256: unknown;
}

const ROW_FIELDS = Object.freeze([
  'workspaceId',
  'snapshotAt',
  'rail',
  'connectionState',
  'inboundState',
  'outboundOrReplyState',
  'receiptState',
  'dailyUsed',
  'dailyLimit',
  'monthlyUsed',
  'monthlyLimit',
  'blockerCodes',
  'latestReceiptId',
  'latestReceiptOutcome',
  'latestReceiptAt',
  'latestReceiptEvidenceSha256',
] as const);

const LIVE_CHANNEL_TRUTH_SQL = `/* portal.live-channel-truth.snapshot */
  SELECT truth.workspace_id::text AS "workspaceId",
         truth.snapshot_at AS "snapshotAt",
         truth.rail,
         truth.connection_state AS "connectionState",
         truth.inbound_state AS "inboundState",
         truth.outbound_or_reply_state AS "outboundOrReplyState",
         truth.receipt_state AS "receiptState",
         truth.daily_used::text AS "dailyUsed",
         truth.daily_limit::text AS "dailyLimit",
         truth.monthly_used::text AS "monthlyUsed",
         truth.monthly_limit::text AS "monthlyLimit",
         truth.blocker_codes AS "blockerCodes",
         truth.latest_receipt_id::text AS "latestReceiptId",
         truth.latest_receipt_outcome AS "latestReceiptOutcome",
         truth.latest_receipt_at AS "latestReceiptAt",
         truth.latest_receipt_evidence_sha256 AS "latestReceiptEvidenceSha256"
  FROM app_private.property_predator_live_channel_truth() AS truth
  ORDER BY truth.rail`;

export interface PortalLiveChannelTruthTransactionRunner {
  run<T>(
    context: DatabaseRequestContext,
    operation: (transaction: SqlExecutor) => Promise<T>,
    options: Readonly<{ readOnly: true; serializable: true }>,
  ): Promise<T>;
}

export interface PgPortalLiveChannelTruthDependencies {
  readonly principalResolver: Pick<PortalCrmPrincipalResolver, 'resolve'>;
  /** Must be backed by the portal web identity; the function is its only read grant. */
  readonly readRunner: PortalLiveChannelTruthTransactionRunner;
}

class InvalidLiveChannelTruthSnapshotError extends Error {
  constructor() {
    super('Live channel truth did not pass the safe typed boundary');
    this.name = 'InvalidLiveChannelTruthSnapshotError';
  }
}

function databaseContext(
  identity: PortalCrmRequestIdentity,
  principal: PortalCrmPrincipal,
): DatabaseRequestContext {
  return requestDatabaseContext({
    ...principal,
    requestId: identity.requestId,
    portalSessionTokenHash: createHash('sha256').update(identity.sessionToken).digest(),
  });
}

function canonicalUuid(value: unknown): string | null {
  return typeof value === 'string' && UUID_PATTERN.test(value)
    ? value.toLowerCase()
    : null;
}

function canonicalTimestamp(value: unknown): string | null {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) return null;
    const canonical = value.toISOString();
    return ISO_TIMESTAMP_PATTERN.test(canonical) ? canonical : null;
  }
  if (typeof value !== 'string' || !ISO_TIMESTAMP_PATTERN.test(value)) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value ? value : null;
}

function enumValue<T extends string>(value: unknown, allowed: ReadonlySet<string>): T | null {
  return typeof value === 'string' && allowed.has(value) ? value as T : null;
}

function capValue(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !/^(?:0|[1-9]\d*)$/u.test(value)) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= MAX_CAP_VALUE
    ? parsed
    : null;
}

function hasExactRowShape(row: LiveChannelTruthRow): boolean {
  const fields = Object.keys(row).sort();
  const expected = [...ROW_FIELDS].sort();
  return fields.length === expected.length
    && fields.every((field, index) => field === expected[index]);
}

function blockerCodes(value: unknown): readonly PortalLiveChannelBlockerCode[] | null {
  if (!Array.isArray(value) || value.length > PORTAL_LIVE_CHANNEL_BLOCKER_CODES.length) return null;
  const deduplicated: PortalLiveChannelBlockerCode[] = [];
  const seen = new Set<PortalLiveChannelBlockerCode>();
  for (const candidate of value) {
    const code = enumValue<PortalLiveChannelBlockerCode>(candidate, BLOCKER_CODES);
    if (!code) return null;
    if (!seen.has(code)) {
      seen.add(code);
      deduplicated.push(code);
    }
  }
  return Object.freeze(deduplicated);
}

function latestReceipt(
  row: LiveChannelTruthRow,
  snapshotAt: string,
): PortalLiveChannelLatestReceipt | null | undefined {
  const values = [
    row.latestReceiptId,
    row.latestReceiptOutcome,
    row.latestReceiptAt,
    row.latestReceiptEvidenceSha256,
  ];
  if (values.every((value) => value === null)) return null;
  if (values.some((value) => value === null)) return undefined;
  const receiptId = canonicalUuid(row.latestReceiptId);
  const outcome = enumValue<PortalLiveChannelReceiptOutcome>(
    row.latestReceiptOutcome,
    RECEIPT_OUTCOMES,
  );
  const recordedAt = canonicalTimestamp(row.latestReceiptAt);
  const evidenceSha256 = typeof row.latestReceiptEvidenceSha256 === 'string'
    && SHA256_PATTERN.test(row.latestReceiptEvidenceSha256)
    ? row.latestReceiptEvidenceSha256
    : null;
  if (!receiptId || !outcome || !recordedAt || !evidenceSha256
      || Date.parse(recordedAt) > Date.parse(snapshotAt)) {
    return undefined;
  }
  return Object.freeze({ receiptId, outcome, recordedAt, evidenceSha256 });
}

function parseRail(
  row: LiveChannelTruthRow,
  context: DatabaseRequestContext,
): Readonly<{
  snapshotAt: string;
  rail: PortalLiveChannelTruthRailSnapshot;
}> {
  if (!hasExactRowShape(row)) throw new InvalidLiveChannelTruthSnapshotError();
  const workspaceId = canonicalUuid(row.workspaceId);
  const snapshotAt = canonicalTimestamp(row.snapshotAt);
  const rail = enumValue<PortalLiveChannelTruthRail>(row.rail, RAILS);
  const connectionState = enumValue<PortalLiveChannelConnectionState>(
    row.connectionState,
    CONNECTION_STATES,
  );
  const inboundState = enumValue<PortalLiveChannelInboundState>(row.inboundState, INBOUND_STATES);
  const outboundOrReplyState = enumValue<PortalLiveChannelOutboundOrReplyState>(
    row.outboundOrReplyState,
    OUTBOUND_OR_REPLY_STATES,
  );
  const receiptState = enumValue<PortalLiveChannelReceiptState>(row.receiptState, RECEIPT_STATES);
  const dailyUsed = capValue(row.dailyUsed);
  const dailyLimit = capValue(row.dailyLimit);
  const monthlyUsed = capValue(row.monthlyUsed);
  const monthlyLimit = capValue(row.monthlyLimit);
  const blockers = blockerCodes(row.blockerCodes);
  if (workspaceId !== context.workspaceId.toLowerCase() || !snapshotAt || !rail
      || !connectionState || !inboundState || !outboundOrReplyState || !receiptState
      || dailyUsed === null || dailyLimit === null
      || monthlyUsed === null || monthlyLimit === null || !blockers
      || dailyUsed > dailyLimit || monthlyUsed > monthlyLimit
      || dailyUsed > monthlyUsed || dailyLimit > monthlyLimit) {
    throw new InvalidLiveChannelTruthSnapshotError();
  }
  const receipt = latestReceipt(row, snapshotAt);
  const capReached = (dailyLimit > 0 && dailyUsed >= dailyLimit)
    || (monthlyLimit > 0 && monthlyUsed >= monthlyLimit);
  if (receipt === undefined
      || (receiptState === 'none') !== (receipt === null)
      || (receiptState === 'pending' && receipt?.outcome !== 'accepted')
      || (receiptState === 'healthy'
        && receipt?.outcome !== 'succeeded'
        && receipt?.outcome !== 'inbound_verified')
      || (receiptState === 'needs_attention' && receipt?.outcome !== 'failed')
      || (receiptState === 'outcome_unknown' && receipt?.outcome !== 'outcome_unknown')
      || (receiptState === 'needs_attention' && !blockers.includes('RECEIPT_NEEDS_ATTENTION'))
      || (receiptState === 'outcome_unknown'
        && !blockers.includes('OUTCOME_UNKNOWN_QUARANTINED'))
      || (connectionState === 'not_configured'
        && !blockers.includes('PROVIDER_NOT_CONFIGURED'))
      || (connectionState === 'not_composed'
        && !blockers.includes('LIVE_ADAPTER_NOT_COMPOSED'))
      || (outboundOrReplyState === 'effects_disabled'
        && !blockers.includes('EFFECTS_DISABLED'))
      || (outboundOrReplyState === 'approval_required'
        && !blockers.includes('APPROVAL_REQUIRED'))
      || capReached !== (outboundOrReplyState === 'cap_reached')
      || capReached !== blockers.includes('CAP_REACHED')) {
    throw new InvalidLiveChannelTruthSnapshotError();
  }
  if (rail === 'social_dm') {
    const accountReady = connectionState === 'ready' && inboundState === 'ready';
    const accountMissing = (connectionState === 'not_configured' || connectionState === 'configured')
      && inboundState === 'not_ready' && outboundOrReplyState === 'blocked';
    const safelyBlocked = outboundOrReplyState !== 'blocked'
      || blockers.includes('EMERGENCY_PAUSED')
      || blockers.includes('OUTCOME_UNKNOWN_QUARANTINED');
    if ((connectionState !== 'ready' && connectionState !== 'configured'
          && connectionState !== 'not_configured')
        || (outboundOrReplyState !== 'ready'
          && outboundOrReplyState !== 'approval_required'
          && outboundOrReplyState !== 'blocked')
        || (!accountReady && !accountMissing)
        || (accountReady && !safelyBlocked)
        || dailyUsed !== 0 || dailyLimit !== 0
        || monthlyUsed !== 0 || monthlyLimit !== 0
        || blockers.includes('LIVE_ADAPTER_NOT_COMPOSED')) {
      throw new InvalidLiveChannelTruthSnapshotError();
    }
  }
  return Object.freeze({
    snapshotAt,
    rail: Object.freeze({
      rail,
      connectionState,
      inboundState,
      outboundOrReplyState,
      receiptState,
      caps: Object.freeze({
        daily: Object.freeze({
          used: dailyUsed,
          limit: dailyLimit,
          remaining: dailyLimit - dailyUsed,
        }),
        monthly: Object.freeze({
          used: monthlyUsed,
          limit: monthlyLimit,
          remaining: monthlyLimit - monthlyUsed,
        }),
      }),
      blockerCodes: blockers,
      latestReceipt: receipt,
    }),
  });
}

function parseSnapshot(
  rows: readonly LiveChannelTruthRow[],
  context: DatabaseRequestContext,
): PortalLiveChannelTruthSnapshot {
  if (rows.length !== PORTAL_LIVE_CHANNEL_TRUTH_RAILS.length) {
    throw new InvalidLiveChannelTruthSnapshotError();
  }
  const parsed = rows.map((row) => parseRail(row, context));
  const snapshotAt = parsed[0]?.snapshotAt;
  const byRail = new Map(parsed.map((entry) => [entry.rail.rail, entry]));
  if (!snapshotAt || byRail.size !== PORTAL_LIVE_CHANNEL_TRUTH_RAILS.length
      || parsed.some((entry) => entry.snapshotAt !== snapshotAt)) {
    throw new InvalidLiveChannelTruthSnapshotError();
  }
  const rails = PORTAL_LIVE_CHANNEL_TRUTH_RAILS.map((rail) => byRail.get(rail)?.rail);
  if (rails.some((rail) => rail === undefined)) throw new InvalidLiveChannelTruthSnapshotError();
  return Object.freeze({
    workspaceId: context.workspaceId.toLowerCase(),
    snapshotAt,
    dataset: 'postgres_authoritative' as const,
    rails: Object.freeze(rails as PortalLiveChannelTruthRailSnapshot[]),
  });
}

function postgresCode(error: unknown): string | null {
  return error && typeof error === 'object' && 'code' in error
    && typeof (error as { readonly code?: unknown }).code === 'string'
    ? (error as { readonly code: string }).code
    : null;
}

function failure(
  kind: PortalLiveChannelTruthFailure['kind'],
  message: string,
): PortalLiveChannelTruthFailure {
  return Object.freeze({ ok: false, kind, message });
}

function readFailure(error: unknown): PortalLiveChannelTruthFailure {
  if (error instanceof InactivePortalSessionError) {
    return failure('unauthenticated', 'This portal session is no longer active.');
  }
  if (error instanceof InvalidLiveChannelTruthSnapshotError) {
    return failure(
      'invalid_snapshot',
      'Live channel evidence did not pass its safe typed boundary.',
    );
  }
  if (postgresCode(error) === '42501') {
    return failure('forbidden', 'This workspace role cannot read live channel evidence.');
  }
  return failure('unavailable', 'Live channel evidence is temporarily unavailable.');
}

export class PgPortalLiveChannelTruthService implements PortalLiveChannelTruthService {
  constructor(private readonly dependencies: PgPortalLiveChannelTruthDependencies) {}

  async snapshot(identity: PortalCrmRequestIdentity): Promise<PortalLiveChannelTruthSnapshotOutcome> {
    try {
      const principal = await this.dependencies.principalResolver.resolve(identity.sessionToken);
      if (!principal) {
        return failure('unauthenticated', 'This portal session is no longer active.');
      }
      const context = databaseContext(identity, principal);
      const snapshot = await this.dependencies.readRunner.run(
        context,
        async (transaction) => {
          const result = await transaction.query<LiveChannelTruthRow>(LIVE_CHANNEL_TRUTH_SQL);
          return parseSnapshot(result.rows, context);
        },
        { readOnly: true, serializable: true },
      );
      return Object.freeze({ ok: true as const, snapshot });
    } catch (error) {
      return readFailure(error);
    }
  }
}

export function createPortalLiveChannelTruthTransactionRunner(
  pool: Pick<Pool, 'connect'>,
): PortalLiveChannelTruthTransactionRunner {
  return {
    run: (context, operation) => withTransaction(
      pool,
      context,
      async (client) => operation({
        async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
          sql: string,
          values: readonly unknown[] = [],
        ) {
          const result = await client.query<TRow>(sql, [...values]);
          return { rows: result.rows, rowCount: result.rowCount };
        },
      }),
      { readOnly: true, isolation: 'serializable' },
    ),
  };
}

/** Production composition uses the web role for session resolution and the one definer read. */
export function createPgPortalLiveChannelTruthService(input: Readonly<{
  webPool: Pool;
}>): PgPortalLiveChannelTruthService {
  return new PgPortalLiveChannelTruthService({
    principalResolver: createPgPortalCrmPrincipalResolver(input.webPool),
    readRunner: createPortalLiveChannelTruthTransactionRunner(input.webPool),
  });
}
