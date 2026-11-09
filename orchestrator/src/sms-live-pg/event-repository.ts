/**
 * MHP009B worker adapter for scheduled event reminders (0131). It prepares
 * due calendar steps into a fresh event authority + one job, then drives the
 * existing lease/begin/settle boundary through the event-only functions.
 * Settlement is the shared 0056 exact-lease function.
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
import { PgTwilioSmsLiveRepository } from './repository.js';

export const MHP_EVENT_WORKSPACE_ID = '2789228d-55a6-4688-b1e8-2f70abca990b';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const ISO = /^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u;

function fail(message: string): never {
  throw new Error(`MHP event SMS repository ${message}`);
}

export interface MhpEventSmsPreparation {
  readonly prepared: number;
  readonly held: number;
}

export class PgMhpEventSmsRepository implements TwilioSmsLiveRepository {
  readonly #pool: Pick<Pool, 'connect'>;
  readonly #connectionId: string;
  readonly #shared: PgTwilioSmsLiveRepository;

  constructor(pool: Pick<Pool, 'connect'>, binding: Readonly<{ workspaceId: string; connectionId: string }>) {
    if (binding.workspaceId !== MHP_EVENT_WORKSPACE_ID || !UUID.test(binding.connectionId)) fail('binding is invalid');
    this.#pool = pool;
    this.#connectionId = binding.connectionId;
    this.#shared = new PgTwilioSmsLiveRepository(pool, binding);
  }

  /** Absolute-due preparation. Never calls a provider; READ COMMITTED by design. */
  async prepareDue(limit = 10): Promise<MhpEventSmsPreparation> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) fail('prepare limit is invalid');
    const rows = await withTransaction(this.#pool, {
      actorKind: 'worker', workspaceId: MHP_EVENT_WORKSPACE_ID, requestId: `mhp-event-sms:prepare:${this.#connectionId}`,
    }, async (transaction) => (await transaction.query<{ value: { prepared?: unknown; held?: unknown } }>(
      `/* mhp-event-sms.prepare */ SELECT app_private.mhp_prepare_event_sms($1::uuid,$2::uuid,$3::integer) AS value`,
      [MHP_EVENT_WORKSPACE_ID, this.#connectionId, limit])).rows, { isolation: 'read committed' });
    const value = rows[0]?.value;
    if (rows.length !== 1 || !value || !Array.isArray(value.prepared) || !Array.isArray(value.held)) fail('prepare returned an invalid result');
    return Object.freeze({ prepared: value.prepared.length, held: value.held.length });
  }

  async claimOne(input: Readonly<{ leaseToken: Buffer; leaseSeconds: number }>): Promise<TwilioSmsLiveClaim | null> {
    if (input.leaseToken.length !== 32 || !Number.isSafeInteger(input.leaseSeconds) || input.leaseSeconds < 30 || input.leaseSeconds > 300) {
      fail('claim lease is invalid');
    }
    const rows = await withTransaction(this.#pool, {
      actorKind: 'worker', workspaceId: MHP_EVENT_WORKSPACE_ID, requestId: `mhp-event-sms:claim:${this.#connectionId}`,
    }, async (transaction) => (await transaction.query<{ jobId: unknown; leaseVersion: unknown }>(
      `/* mhp-event-sms.claim-one */
       SELECT job_id AS "jobId", lease_version AS "leaseVersion" FROM app_private.claim_event_sms_job($1::uuid,$2::uuid,$3::bytea,$4::integer)`,
      [MHP_EVENT_WORKSPACE_ID, this.#connectionId, input.leaseToken, input.leaseSeconds])).rows, { isolation: 'serializable' });
    if (rows.length === 0) return null;
    const leaseVersion = Number(rows[0]!.leaseVersion);
    if (rows.length !== 1 || typeof rows[0]!.jobId !== 'string' || !UUID.test(rows[0]!.jobId) || !Number.isSafeInteger(leaseVersion) || leaseVersion < 1) {
      fail('claim returned an invalid job');
    }
    return Object.freeze({ workspaceId: MHP_EVENT_WORKSPACE_ID, connectionId: this.#connectionId, jobId: rows[0]!.jobId, leaseVersion });
  }

  async loadClaimed(input: TwilioSmsLiveClaim & Readonly<{ leaseToken: Buffer }>): Promise<TwilioSmsLiveMaterial> {
    this.#assertClaim(input);
    const rows = await withTransaction(this.#pool, {
      actorKind: 'worker', workspaceId: MHP_EVENT_WORKSPACE_ID, requestId: `mhp-event-sms:load:${input.jobId}`,
    }, async (transaction) => (await transaction.query<{ value: Record<string, unknown> | null }>(
      `/* mhp-event-sms.load-claimed */ SELECT app_private.load_event_sms_job($1::uuid,$2::uuid,$3::bigint,$4::bytea) AS value`,
      [MHP_EVENT_WORKSPACE_ID, input.jobId, input.leaseVersion, input.leaseToken])).rows, { readOnly: true, isolation: 'repeatable read' });
    const row = rows[0]?.value;
    if (rows.length !== 1 || !row) fail('load did not return exactly one claimed job');
    const text = (key: string): string => typeof row[key] === 'string' ? row[key] as string : '';
    const segmentCount = Number(row.segmentCount);
    const body = text('body'), recipient = text('recipient'), senderNumber = text('senderNumber'), requestSha256 = text('requestSha256');
    const providerExpiresAt = text('providerExpiresAt');
    if (text('providerConnectionId') !== this.#connectionId || !SHA256.test(requestSha256) || !TWILIO_SMS_UK_RECIPIENT.test(senderNumber)
        || !TWILIO_SMS_UK_RECIPIENT.test(recipient) || !TWILIO_SMS_GSM_BASIC_TEXT.test(body) || twilioSmsSegmentCount(body) !== segmentCount
        || !UUID.test(text('operationId')) || !UUID.test(text('correlationId')) || !ISO.test(providerExpiresAt)) {
      fail('loaded material crossed its trusted boundary');
    }
    return Object.freeze({
      workspaceId: MHP_EVENT_WORKSPACE_ID, connectionId: this.#connectionId, jobId: input.jobId, leaseVersion: input.leaseVersion,
      operationId: text('operationId'), correlationId: text('correlationId'), requestSha256, senderNumber, recipient, body, segmentCount,
      providerExpiresAt,
    });
  }

  async markCalling(input: TwilioSmsLiveClaim & Readonly<{ leaseToken: Buffer; providerEffectsEnabled: true; smsDeliveryEnabled: true; emergencyPaused: false }>): Promise<boolean> {
    this.#assertClaim(input);
    const rows = await withTransaction(this.#pool, {
      actorKind: 'worker', workspaceId: MHP_EVENT_WORKSPACE_ID, requestId: `mhp-event-sms:begin:${input.jobId}`,
    }, async (transaction) => (await transaction.query<{ marked: unknown }>(
      `/* mhp-event-sms.begin-call */
       SELECT app_private.begin_event_sms_call($1::uuid,$2::uuid,$3::bigint,$4::bytea,$5::boolean,$6::boolean,$7::boolean) AS marked`,
      [MHP_EVENT_WORKSPACE_ID, input.jobId, input.leaseVersion, input.leaseToken, input.providerEffectsEnabled,
        input.smsDeliveryEnabled, input.emergencyPaused])).rows, { isolation: 'read committed' });
    if (rows.length !== 1 || typeof rows[0]!.marked !== 'boolean') fail('begin-call did not return a boolean fence');
    return rows[0]!.marked;
  }

  settle(input: TwilioSmsLiveClaim & Readonly<{ leaseToken: Buffer; result: ProviderOperationResult; receiptSha256: string }>): Promise<void> {
    this.#assertClaim(input);
    return this.#shared.settle(input);
  }

  #assertClaim(claim: TwilioSmsLiveClaim & Readonly<{ leaseToken: Buffer }>): void {
    if (claim.workspaceId !== MHP_EVENT_WORKSPACE_ID || claim.connectionId !== this.#connectionId || !UUID.test(claim.jobId)
        || !Number.isSafeInteger(claim.leaseVersion) || claim.leaseVersion < 1 || claim.leaseToken.length !== 32) {
      fail('claim crossed its trusted workspace binding');
    }
  }
}
