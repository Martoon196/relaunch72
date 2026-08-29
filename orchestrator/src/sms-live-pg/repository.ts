/**
 * Worker-role PostgreSQL adapter for the 0056 Twilio SMS rail. Every method
 * is a single SECURITY DEFINER function call under the exact worker GUC
 * context; the repository re-proves each row against its constructor-bound
 * workspace and connection before the domain layer may act on it.
 */

import type { Pool } from 'pg';
import { withTransaction } from '../db/transaction.js';
import {
  TWILIO_SMS_GSM_BASIC_TEXT,
  TWILIO_SMS_UK_RECIPIENT,
  twilioSmsSegmentCount,
  type TwilioSmsLiveClaim,
  type TwilioSmsLiveMaterial,
  type TwilioSmsLiveRepository,
} from '../sms-live/foundation.js';
import type { ProviderOperationResult } from '../providers/contracts.js';

type CommandPool = Pick<Pool, 'connect'>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_CODE = /^[a-z][a-z0-9_.:-]{0,99}$/u;
const STATUSES = new Set(['accepted', 'pending', 'succeeded', 'failed', 'needs_attention']);

function fail(message: string): never {
  throw new Error(`Twilio SMS live repository ${message}`);
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) fail(`${label} is invalid`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed < 1) {
    fail(`${label} is invalid`);
  }
  return parsed;
}

interface ClaimRow extends Record<string, unknown> {
  jobId: unknown;
  leaseVersion: unknown;
}

interface LoadRow extends Record<string, unknown> {
  providerConnectionId: unknown;
  senderNumber: unknown;
  operationId: unknown;
  correlationId: unknown;
  requestSha256: unknown;
  recipient: unknown;
  body: unknown;
  segmentCount: unknown;
}

export class PgTwilioSmsLiveRepository implements TwilioSmsLiveRepository {
  readonly #workspaceId: string;
  readonly #connectionId: string;

  constructor(
    private readonly commandPool: CommandPool,
    binding: Readonly<{ workspaceId: string; connectionId: string }>,
  ) {
    this.#workspaceId = uuid(binding.workspaceId, 'workspace binding');
    this.#connectionId = uuid(binding.connectionId, 'connection binding');
  }

  async claimOne(
    input: Readonly<{ leaseToken: Buffer; leaseSeconds: number }>,
  ): Promise<TwilioSmsLiveClaim | null> {
    if (input.leaseToken.length !== 32
        || !Number.isSafeInteger(input.leaseSeconds)
        || input.leaseSeconds < 30 || input.leaseSeconds > 300) {
      fail('claim lease is invalid');
    }
    const rows = await withTransaction(this.commandPool, {
      actorKind: 'worker',
      workspaceId: this.#workspaceId,
      requestId: `sms:claim:${this.#connectionId}`,
    }, async (transaction) => (await transaction.query<ClaimRow>(
      `/* twilio-sms-live.claim-one */
       SELECT job_id AS "jobId", lease_version AS "leaseVersion"
       FROM app_private.claim_sms_live_job(
         $1::uuid, $2::uuid, $3::bytea, $4::integer
       )`,
      [this.#workspaceId, this.#connectionId, input.leaseToken, input.leaseSeconds],
    )).rows, { isolation: 'serializable' });
    if (rows.length === 0) return null;
    if (rows.length !== 1) fail('claim returned more than one job');
    return Object.freeze({
      workspaceId: this.#workspaceId,
      connectionId: this.#connectionId,
      jobId: uuid(rows[0]!.jobId, 'claimed job id'),
      leaseVersion: positiveInteger(rows[0]!.leaseVersion, 'claimed lease version'),
    });
  }

  async loadClaimed(
    input: TwilioSmsLiveClaim & Readonly<{ leaseToken: Buffer }>,
  ): Promise<TwilioSmsLiveMaterial> {
    this.#assertClaim(input);
    const rows = await withTransaction(this.commandPool, {
      actorKind: 'worker',
      workspaceId: this.#workspaceId,
      requestId: `sms:load:${input.jobId}`,
    }, async (transaction) => (await transaction.query<LoadRow>(
      `/* twilio-sms-live.load-claimed */
       SELECT provider_connection_id AS "providerConnectionId",
              sender_number AS "senderNumber",
              operation_id AS "operationId", correlation_id AS "correlationId",
              encode(request_sha256, 'hex') AS "requestSha256",
              recipient, body, segment_count AS "segmentCount"
       FROM app_private.load_sms_live_job(
         $1::uuid, $2::uuid, $3::bigint, $4::bytea
       )`,
      [this.#workspaceId, input.jobId, input.leaseVersion, input.leaseToken],
    )).rows, { readOnly: true, isolation: 'repeatable read' });
    if (rows.length !== 1) fail('load did not return exactly one claimed job');
    const row = rows[0]!;
    const senderNumber = typeof row.senderNumber === 'string' ? row.senderNumber : '';
    const recipient = typeof row.recipient === 'string' ? row.recipient : '';
    const body = typeof row.body === 'string' ? row.body : '';
    const requestSha256 = typeof row.requestSha256 === 'string' ? row.requestSha256 : '';
    const segmentCount = positiveInteger(row.segmentCount, 'segment count');
    if (uuid(row.providerConnectionId, 'loaded connection') !== this.#connectionId
        || !SHA256.test(requestSha256)
        || !TWILIO_SMS_UK_RECIPIENT.test(senderNumber)
        || !TWILIO_SMS_UK_RECIPIENT.test(recipient)
        || !TWILIO_SMS_GSM_BASIC_TEXT.test(body)
        || twilioSmsSegmentCount(body) !== segmentCount) {
      fail('loaded material crossed its trusted boundary');
    }
    return Object.freeze({
      workspaceId: this.#workspaceId,
      connectionId: this.#connectionId,
      jobId: input.jobId,
      leaseVersion: input.leaseVersion,
      operationId: uuid(row.operationId, 'operation id'),
      correlationId: uuid(row.correlationId, 'correlation id'),
      requestSha256,
      senderNumber,
      recipient,
      body,
      segmentCount,
    });
  }

  async markCalling(input: TwilioSmsLiveClaim & Readonly<{
    leaseToken: Buffer;
    providerEffectsEnabled: true;
    smsDeliveryEnabled: true;
    emergencyPaused: false;
  }>): Promise<boolean> {
    this.#assertClaim(input);
    const rows = await withTransaction(this.commandPool, {
      actorKind: 'worker',
      workspaceId: this.#workspaceId,
      requestId: `sms:begin:${input.jobId}`,
    }, async (transaction) => (await transaction.query<{ marked: unknown }>(
      `/* twilio-sms-live.begin-call */
       SELECT app_private.begin_sms_live_call(
         $1::uuid, $2::uuid, $3::bigint, $4::bytea,
         $5::boolean, $6::boolean, $7::boolean
       ) AS marked`,
      [this.#workspaceId, input.jobId, input.leaseVersion, input.leaseToken,
        input.providerEffectsEnabled, input.smsDeliveryEnabled, input.emergencyPaused],
    )).rows, { isolation: 'serializable' });
    if (rows.length !== 1 || typeof rows[0]!.marked !== 'boolean') {
      fail('begin-call did not return a boolean fence');
    }
    return rows[0]!.marked;
  }

  async settle(input: TwilioSmsLiveClaim & Readonly<{
    leaseToken: Buffer;
    result: ProviderOperationResult;
    receiptSha256: string;
  }>): Promise<void> {
    this.#assertClaim(input);
    const result = input.result;
    if (!STATUSES.has(result.status)
        || (result.errorCode !== null && !SAFE_CODE.test(result.errorCode))
        || (result.externalId !== null
          && (result.externalId.length < 1 || result.externalId.length > 500))
        || result.summary !== result.summary.trim()
        || result.summary.length < 1 || result.summary.length > 500
        || !SHA256.test(input.receiptSha256)
        || !Number.isFinite(Date.parse(result.occurredAt))) {
      fail('settlement evidence is invalid');
    }
    await withTransaction(this.commandPool, {
      actorKind: 'worker',
      workspaceId: this.#workspaceId,
      requestId: `sms:settle:${input.jobId}`,
    }, async (transaction) => transaction.query(
      `/* twilio-sms-live.settle */
       SELECT app_private.settle_sms_live_call(
         $1::uuid, $2::uuid, $3::bigint, $4::bytea, $5::text, $6::text,
         $7::timestamptz, $8::boolean, $9::text, $10::text, decode($11, 'hex')
       )`,
      [this.#workspaceId, input.jobId, input.leaseVersion, input.leaseToken,
        result.status, result.externalId, result.occurredAt, result.retryable,
        result.errorCode, result.summary, input.receiptSha256],
    ), { isolation: 'serializable' });
  }

  #assertClaim(claim: TwilioSmsLiveClaim & Readonly<{ leaseToken: Buffer }>): void {
    if (claim.workspaceId !== this.#workspaceId
        || claim.connectionId !== this.#connectionId
        || !UUID.test(claim.jobId)
        || !Number.isSafeInteger(claim.leaseVersion) || claim.leaseVersion < 1
        || claim.leaseToken.length !== 32) {
      fail('claim crossed its trusted workspace binding');
    }
  }
}
