/**
 * Founder-command seam for the 0056 Twilio SMS rail. It accepts evidence
 * identifiers only, runs serializably under the locked portal session, and
 * makes exactly one 19-argument SECURITY DEFINER call. It cannot call
 * Twilio and never accepts a browser-supplied phone number.
 */

import type { QueryResultRow } from 'pg';
import { validateDatabaseContext } from '../db/rls.js';
import { withTransaction } from '../db/transaction.js';
import {
  SMS_DAILY_SEGMENT_CAP,
  SMS_MONTHLY_SEGMENT_CAP,
  SMS_RECIPIENTS_PER_JOB,
  TwilioSmsLivePgContractError,
  type AuthorizeTwilioSmsLiveCommand,
  type AuthorizeTwilioSmsLiveResult,
  type TwilioSmsLiveCommandServiceDependencies,
  type TwilioSmsLiveUserContext,
} from './types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

function fail(message: string): never {
  throw new TwilioSmsLivePgContractError(`Twilio SMS live command ${message}`);
}

function uuid(value: string, label: string): string {
  if (!UUID.test(value)) fail(`${label} is invalid`);
  return value;
}

function digest(value: string, label: string): Buffer {
  if (!SHA256.test(value)) fail(`${label} is invalid`);
  return Buffer.from(value, 'hex');
}

function timestamp(value: string, label: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    fail(`${label} must be a canonical UTC millisecond instant`);
  }
  return value;
}

interface EnqueueRow extends QueryResultRow {
  jobId: unknown;
  disposition: unknown;
}

export class PgTwilioSmsLiveCommandService {
  readonly #commandPool: TwilioSmsLiveCommandServiceDependencies['commandPool'];
  readonly #workspaceId: string;
  readonly #providerConnectionId: string;

  constructor(dependencies: TwilioSmsLiveCommandServiceDependencies) {
    this.#commandPool = dependencies.commandPool;
    this.#workspaceId = uuid(dependencies.workspaceId, 'workspace binding');
    this.#providerConnectionId = uuid(dependencies.providerConnectionId, 'connection binding');
  }

  async authorizeAndEnqueue(
    context: TwilioSmsLiveUserContext,
    command: AuthorizeTwilioSmsLiveCommand,
  ): Promise<AuthorizeTwilioSmsLiveResult> {
    validateDatabaseContext(context);
    if (context.actorKind !== 'user' || !context.userId
        || !Buffer.isBuffer(context.portalSessionTokenHash)
        || context.portalSessionTokenHash.length !== 32
        || context.workspaceId !== this.#workspaceId) {
      fail('requires the bound active portal session');
    }
    if (!Number.isSafeInteger(command.expectedSegmentCount)
        || command.expectedSegmentCount < 1
        || command.expectedSegmentCount > SMS_DAILY_SEGMENT_CAP) {
      fail('expected segment count is outside the hard cap');
    }
    const values = [
      this.#workspaceId,
      this.#providerConnectionId,
      uuid(command.messageVersionId, 'message version'),
      uuid(command.messageApprovalRequestId, 'message approval request'),
      uuid(command.messageApprovalDecisionId, 'message approval decision'),
      uuid(command.channelEndpointId, 'channel endpoint'),
      uuid(command.consentEventId, 'consent event'),
      uuid(command.complianceSubjectId, 'compliance subject'),
      uuid(command.policyPublicationEventId, 'policy publication'),
      uuid(command.pecrSenderDecisionEventId, 'PECR sender decision'),
      uuid(command.pecrInstigatorDecisionEventId, 'PECR instigator decision'),
      uuid(command.permissionUseReceiptId, 'permission-use receipt'),
      timestamp(command.authorityValidUntil, 'authority expiry'),
      uuid(command.providerOperationId, 'provider operation'),
      uuid(command.messageDeliveryId, 'message delivery'),
      uuid(command.correlationId, 'correlation id'),
      digest(command.idempotencyKeySha256, 'idempotency digest'),
      digest(command.requestSha256, 'request digest'),
      command.expectedSegmentCount,
    ];
    const rows = await withTransaction(this.#commandPool, context, async (transaction) => (
      await transaction.query<EnqueueRow>(
        `/* twilio-sms-live.authorize-and-enqueue */
         SELECT job_id AS "jobId", disposition
         FROM app_private.authorize_and_enqueue_sms_live_job(
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
           $7::uuid, $8::uuid, $9::uuid, $10::uuid, $11::uuid, $12::uuid,
           $13::timestamptz, $14::uuid, $15::uuid, $16::uuid,
           $17::bytea, $18::bytea, $19::integer
         )`,
        values,
      )
    ).rows, { isolation: 'serializable' });
    if (rows.length !== 1) fail('enqueue did not return exactly one job');
    const jobId = typeof rows[0]!.jobId === 'string' ? rows[0]!.jobId : '';
    const disposition = rows[0]!.disposition;
    if (!UUID.test(jobId) || (disposition !== 'queued' && disposition !== 'replayed')) {
      fail('enqueue returned an invalid disposition');
    }
    return Object.freeze({
      jobId,
      disposition,
      providerEffects: 'none',
      caps: Object.freeze({
        dailySegments: SMS_DAILY_SEGMENT_CAP,
        monthlySegments: SMS_MONTHLY_SEGMENT_CAP,
        recipientsPerJob: SMS_RECIPIENTS_PER_JOB,
      }),
    });
  }
}

export function createPgTwilioSmsLiveCommandService(
  dependencies: TwilioSmsLiveCommandServiceDependencies,
): PgTwilioSmsLiveCommandService {
  return new PgTwilioSmsLiveCommandService(dependencies);
}
