import type { Pool, QueryResultRow } from 'pg';
import { withTransaction } from '../db/transaction.js';
import type { ProviderOperationResult } from '../providers/contracts.js';
import {
  normalizeOwnedInternalSeedEmail,
} from '../providers/property-predator-email-pilot-config.js';
import type {
  PropertyPredatorMailgunBeginDecision,
  PropertyPredatorMailgunJobLease,
  PropertyPredatorMailgunWorkerRepository,
} from './types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_REASON = /^[a-z][a-z0-9_.:-]{0,99}$/;
const EXPECTED_MESSAGE_ID = /^<pp-([0-9a-f]{64})@mg[.]propertypredator[.]com>$/;
const RESULT_STATUSES = new Set(['accepted', 'pending', 'succeeded', 'failed', 'needs_attention']);
const RECOVERY_DISPOSITIONS = new Set([
  'requeued_before_call', 'claim_attempts_exhausted',
  'reconciliation_required', 'signed_webhook_reconciled',
]);

interface ClaimRow extends QueryResultRow {
  jobId: string;
  leaseVersion: string | number;
}

interface BeginRow extends QueryResultRow {
  disposition: string;
  reason: string | null;
  operationId: string | null;
  correlationId: string | null;
  providerConnectionId: string | null;
  reservationId: string | null;
  requestSha256: Buffer | string | null;
  expectedMessageId: string | null;
  recipient: string | null;
  subject: string | null;
  body: string | null;
}

interface RecoverRow extends QueryResultRow {
  jobId: string;
  disposition: string;
}

export interface PgPropertyPredatorMailgunWorkerRepositoryDependencies {
  readonly commandPool: Pick<Pool, 'connect'>;
  readonly workspaceId: string;
  readonly providerConnectionId: string;
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function token(value: Uint8Array): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    throw new TypeError('Mailgun lease token must contain exactly 32 bytes');
  }
  return Buffer.from(value);
}

function positiveInteger(value: number, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function leaseSeconds(value: number): number {
  if (!Number.isSafeInteger(value) || value < 30 || value > 300) {
    throw new TypeError('Mailgun lease seconds must be between 30 and 300');
  }
  return value;
}

function leaseVersion(value: string | number): number {
  const parsed = typeof value === 'string' && /^[1-9][0-9]*$/.test(value)
    ? Number(value) : value;
  return positiveInteger(parsed as number, 'Mailgun lease version', Number.MAX_SAFE_INTEGER);
}

function digest(value: Buffer | string | null): string {
  const candidate = Buffer.isBuffer(value)
    ? value.toString('hex')
    : typeof value === 'string' && value.startsWith('\\x') ? value.slice(2) : value;
  if (typeof candidate !== 'string' || !SHA256.test(candidate)) {
    throw new Error('Mailgun worker returned an invalid request digest');
  }
  return candidate;
}

function canonicalResult(result: ProviderOperationResult): ProviderOperationResult {
  if (!RESULT_STATUSES.has(result.status)
      || !Number.isFinite(new Date(result.occurredAt).getTime())
      || typeof result.retryable !== 'boolean'
      || typeof result.summary !== 'string'
      || result.summary !== result.summary.trim()
      || result.summary.length < 1 || result.summary.length > 500
      || (result.externalId !== null && (
        typeof result.externalId !== 'string'
        || result.externalId !== result.externalId.trim()
        || result.externalId.length < 1 || result.externalId.length > 500
      ))
      || (result.errorCode !== null && !SAFE_REASON.test(result.errorCode))) {
    throw new TypeError('Mailgun provider result is invalid');
  }
  return Object.freeze({ ...result, occurredAt: new Date(result.occurredAt).toISOString() });
}

function requestId(prefix: string, id: string): string {
  return `${prefix}:${id}`;
}

export class PgPropertyPredatorMailgunWorkerRepository
implements PropertyPredatorMailgunWorkerRepository {
  readonly #commandPool: Pick<Pool, 'connect'>;
  readonly #workspaceId: string;
  readonly #providerConnectionId: string;

  constructor(dependencies: Readonly<PgPropertyPredatorMailgunWorkerRepositoryDependencies>) {
    this.#commandPool = dependencies.commandPool;
    this.#workspaceId = uuid(dependencies.workspaceId, 'workspaceId');
    this.#providerConnectionId = uuid(
      dependencies.providerConnectionId,
      'providerConnectionId',
    );
  }

  async claimOne(
    leaseToken: Uint8Array,
    seconds: number,
  ): Promise<PropertyPredatorMailgunJobLease | null> {
    return withTransaction(
      this.#commandPool,
      { actorKind: 'worker', workspaceId: this.#workspaceId, requestId: 'mailgun-job:claim' },
      async (transaction) => {
        const result = await transaction.query<ClaimRow>(
          `/* property-predator-mailgun-worker.claim-one */
           SELECT job_id AS "jobId", lease_version AS "leaseVersion"
           FROM app_private.claim_property_predator_mailgun_job($1, $2, $3, $4)`,
          [this.#workspaceId, this.#providerConnectionId,
            token(leaseToken), leaseSeconds(seconds)],
        );
        if (result.rows.length === 0) return null;
        if (result.rows.length !== 1) throw new Error('Mailgun claim returned more than one job');
        return Object.freeze({
          jobId: uuid(result.rows[0]?.jobId, 'jobId'),
          leaseVersion: leaseVersion(result.rows[0]!.leaseVersion),
        });
      },
    );
  }

  async renew(
    lease: PropertyPredatorMailgunJobLease,
    leaseToken: Uint8Array,
    seconds: number,
  ): Promise<boolean> {
    const jobId = uuid(lease.jobId, 'jobId');
    const version = leaseVersion(lease.leaseVersion);
    return withTransaction(
      this.#commandPool,
      { actorKind: 'worker', workspaceId: this.#workspaceId, requestId: requestId('mailgun-job-renew', jobId) },
      async (transaction) => {
        const result = await transaction.query<{ renewed: boolean } & QueryResultRow>(
          `/* property-predator-mailgun-worker.renew */
           SELECT app_private.renew_property_predator_mailgun_job(
             $1, $2, $3, $4, $5
           ) AS renewed`,
          [this.#workspaceId, jobId, version, token(leaseToken), leaseSeconds(seconds)],
        );
        return result.rows.length === 1 && result.rows[0]?.renewed === true;
      },
    );
  }

  async beginCall(
    lease: PropertyPredatorMailgunJobLease,
    leaseToken: Uint8Array,
    limits: Readonly<{ runSpendCapUsdMicros: number; monthSpendCapUsdMicros: number }>,
  ): Promise<PropertyPredatorMailgunBeginDecision> {
    const jobId = uuid(lease.jobId, 'jobId');
    const version = leaseVersion(lease.leaseVersion);
    const runSpend = positiveInteger(limits.runSpendCapUsdMicros, 'runSpendCapUsdMicros', 100_000_000);
    const monthSpend = positiveInteger(limits.monthSpendCapUsdMicros, 'monthSpendCapUsdMicros', 100_000_000);
    if (monthSpend < runSpend) throw new TypeError('Mailgun monthly spend cap is below the run cap');
    return withTransaction(
      this.#commandPool,
      { actorKind: 'worker', workspaceId: this.#workspaceId, requestId: requestId('mailgun-job-begin', jobId) },
      async (transaction) => {
        const result = await transaction.query<BeginRow>(
          `/* property-predator-mailgun-worker.begin-call */
           SELECT disposition, reason, operation_id AS "operationId",
                  correlation_id AS "correlationId",
                  provider_connection_id AS "providerConnectionId",
                  reservation_id AS "reservationId",
                  request_sha256 AS "requestSha256",
                  expected_message_id AS "expectedMessageId",
                  recipient, subject, body
           FROM app_private.begin_property_predator_mailgun_job_call(
             $1, $2, $3, $4, $5, true, true, false, $6, $7
            )`,
          [this.#workspaceId, this.#providerConnectionId, jobId, version,
            token(leaseToken), runSpend, monthSpend],
        );
        const row = result.rows[0];
        if (result.rows.length !== 1 || !row) {
          throw new Error('Mailgun begin-call returned invalid canonical data');
        }
        if (row.disposition === 'blocked') {
          if (typeof row.reason !== 'string' || !SAFE_REASON.test(row.reason)) {
            throw new Error('Mailgun begin-call returned an invalid block reason');
          }
          return Object.freeze({ disposition: 'blocked', reason: row.reason });
        }
        if (row.disposition === 'replay') return Object.freeze({ disposition: 'replay' });
        if (row.disposition !== 'authorized') {
          throw new Error('Mailgun begin-call returned an unsupported disposition');
        }
        const requestSha256 = digest(row.requestSha256);
        const expected = row.expectedMessageId;
        const match = typeof expected === 'string' ? EXPECTED_MESSAGE_ID.exec(expected) : null;
        const recipient = typeof row.recipient === 'string'
          ? normalizeOwnedInternalSeedEmail(row.recipient) : '';
        if (!match || match[1] !== requestSha256
            || row.providerConnectionId !== this.#providerConnectionId
            || recipient !== 'office@propertypredator.com'
            || typeof row.subject !== 'string' || row.subject.length < 1
            || typeof row.body !== 'string' || row.body.length < 1) {
          throw new Error('Mailgun begin-call payload is not canonical');
        }
        const expectedMessageId = expected as string;
        return Object.freeze({
          disposition: 'authorized', jobId,
          operationId: uuid(row.operationId, 'operationId'),
          correlationId: uuid(row.correlationId, 'correlationId'),
          providerConnectionId: uuid(row.providerConnectionId, 'providerConnectionId'),
          reservationId: uuid(row.reservationId, 'reservationId'),
          requestSha256, expectedMessageId,
          recipient, subject: row.subject, text: row.body,
        });
      },
      { isolation: 'serializable' },
    );
  }

  async settle(
    lease: PropertyPredatorMailgunJobLease,
    leaseToken: Uint8Array,
    result: ProviderOperationResult,
  ): Promise<boolean> {
    const jobId = uuid(lease.jobId, 'jobId');
    const version = leaseVersion(lease.leaseVersion);
    const normalized = canonicalResult(result);
    return withTransaction(
      this.#commandPool,
      { actorKind: 'worker', workspaceId: this.#workspaceId, requestId: requestId('mailgun-job-settle', jobId) },
      async (transaction) => {
        const settled = await transaction.query<{ settled: boolean } & QueryResultRow>(
          `/* property-predator-mailgun-worker.settle */
           SELECT app_private.settle_property_predator_mailgun_job(
             $1, $2, $3, $4, $5, $6, $7::timestamptz, $8, $9, $10
           ) AS settled`,
          [this.#workspaceId, jobId, version, token(leaseToken),
            normalized.status, normalized.externalId, normalized.occurredAt,
            normalized.retryable, normalized.errorCode, normalized.summary],
        );
        return settled.rows.length === 1 && settled.rows[0]?.settled === true;
      },
      { isolation: 'serializable' },
    );
  }

  async recoverOne(): Promise<Readonly<{
    jobId: string;
    disposition:
      | 'requeued_before_call'
      | 'claim_attempts_exhausted'
      | 'reconciliation_required'
      | 'signed_webhook_reconciled';
  }> | null> {
    return withTransaction(
      this.#commandPool,
      { actorKind: 'worker', workspaceId: this.#workspaceId, requestId: 'mailgun-job:recover-one' },
      async (transaction) => {
        const result = await transaction.query<RecoverRow>(
          `/* property-predator-mailgun-worker.recover-one */
           SELECT job_id AS "jobId", disposition
           FROM app_private.recover_one_property_predator_mailgun_job($1, $2)`,
          [this.#workspaceId, this.#providerConnectionId],
        );
        if (result.rows.length === 0) return null;
        const row = result.rows[0];
        if (result.rows.length !== 1 || !row || !RECOVERY_DISPOSITIONS.has(row.disposition)) {
          throw new Error('Mailgun recovery returned invalid canonical data');
        }
        return Object.freeze({
          jobId: uuid(row.jobId, 'jobId'),
          disposition: row.disposition as
            | 'requeued_before_call'
            | 'claim_attempts_exhausted'
            | 'reconciliation_required'
            | 'signed_webhook_reconciled',
        });
      },
      { isolation: 'serializable' },
    );
  }
}

export function createPgPropertyPredatorMailgunWorkerRepository(
  dependencies: Readonly<PgPropertyPredatorMailgunWorkerRepositoryDependencies>,
): PropertyPredatorMailgunWorkerRepository {
  return new PgPropertyPredatorMailgunWorkerRepository(dependencies);
}
