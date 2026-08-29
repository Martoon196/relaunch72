import type { QueryResultRow } from 'pg';
import { validateDatabaseContext } from '../db/rls.js';
import { withTransaction } from '../db/transaction.js';
import {
  CUSTOMER_EMAIL_DAILY_CAP,
  CUSTOMER_EMAIL_MONTHLY_CAP,
  CUSTOMER_EMAIL_RECIPIENTS_PER_JOB,
  CustomerEmailLivePgContractError,
  type AuthorizeCustomerEmailLiveCommand,
  type AuthorizeCustomerEmailLiveResult,
  type CustomerEmailLiveCommandService,
  type CustomerEmailLiveCommandServiceDependencies,
  type CustomerEmailLiveUserContext,
} from './types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

interface JobRow extends QueryResultRow { jobId: unknown; disposition: unknown }

function fail(message: string): never {
  throw new CustomerEmailLivePgContractError(message);
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) fail(`${label} must be a UUID`);
  return value;
}

function digest(value: unknown, label: string): Buffer {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    fail(`${label} must be a lowercase SHA-256 digest`);
  }
  return Buffer.from(value, 'hex');
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    fail(`${label} must be an ISO timestamp`);
  }
  const normalized = new Date(value).toISOString();
  if (normalized !== value) fail(`${label} must be a canonical ISO timestamp`);
  return normalized;
}

export class PgCustomerEmailLiveCommandService implements CustomerEmailLiveCommandService {
  readonly #workspaceId: string;
  readonly #providerConnectionId: string;

  constructor(private readonly dependencies: CustomerEmailLiveCommandServiceDependencies) {
    this.#workspaceId = uuid(dependencies.workspaceId, 'workspaceId');
    this.#providerConnectionId = uuid(
      dependencies.providerConnectionId,
      'providerConnectionId',
    );
  }

  async authorizeAndEnqueue(
    context: CustomerEmailLiveUserContext,
    command: AuthorizeCustomerEmailLiveCommand,
  ): Promise<AuthorizeCustomerEmailLiveResult> {
    validateDatabaseContext(context);
    if (context.actorKind !== 'user' || !context.userId
        || !Buffer.isBuffer(context.portalSessionTokenHash)
        || context.portalSessionTokenHash.length !== 32
        || context.workspaceId !== this.#workspaceId) {
      fail('customer email enqueue requires the bound active portal session');
    }
    if (!command || typeof command !== 'object') fail('customer email command is required');
    const values = [
      this.#workspaceId,
      this.#providerConnectionId,
      uuid(command.campaignTemplateVersionId, 'campaignTemplateVersionId'),
      uuid(command.campaignTemplateStepId, 'campaignTemplateStepId'),
      digest(command.campaignStepContentSha256, 'campaignStepContentSha256'),
      uuid(command.campaignApprovalRequestId, 'campaignApprovalRequestId'),
      uuid(command.campaignApprovalDecisionId, 'campaignApprovalDecisionId'),
      uuid(command.messageVersionId, 'messageVersionId'),
      uuid(command.messageApprovalRequestId, 'messageApprovalRequestId'),
      uuid(command.messageApprovalDecisionId, 'messageApprovalDecisionId'),
      uuid(command.channelEndpointId, 'channelEndpointId'),
      uuid(command.consentEventId, 'consentEventId'),
      uuid(command.complianceSubjectId, 'complianceSubjectId'),
      uuid(command.policyPublicationEventId, 'policyPublicationEventId'),
      uuid(command.pecrSenderDecisionEventId, 'pecrSenderDecisionEventId'),
      uuid(command.pecrInstigatorDecisionEventId, 'pecrInstigatorDecisionEventId'),
      uuid(command.permissionUseReceiptId, 'permissionUseReceiptId'),
      timestamp(command.authorityValidUntil, 'authorityValidUntil'),
      uuid(command.providerOperationId, 'providerOperationId'),
      uuid(command.messageDeliveryId, 'messageDeliveryId'),
      uuid(command.correlationId, 'correlationId'),
      digest(command.idempotencyKeySha256, 'idempotencyKeySha256'),
      digest(command.requestSha256, 'requestSha256'),
    ] as const;

    const enqueued = await withTransaction(
      this.dependencies.commandPool,
      context,
      async (transaction) => {
        const result = await transaction.query<JobRow>(
          `/* customer-email-live.authorize-and-enqueue */
           SELECT job_id AS "jobId", disposition
           FROM app_private.authorize_and_enqueue_customer_email_live_job(
             $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::bytea,
             $6::uuid, $7::uuid, $8::uuid, $9::uuid, $10::uuid,
             $11::uuid, $12::uuid, $13::uuid, $14::uuid, $15::uuid,
             $16::uuid, $17::uuid, $18::timestamptz, $19::uuid,
             $20::uuid, $21::uuid, $22::bytea, $23::bytea
           )`,
          [...values],
        );
        if (result.rows.length !== 1) fail('enqueue returned invalid cardinality');
        const row = result.rows[0];
        if (!row) fail('enqueue returned invalid cardinality');
        const disposition = row?.disposition;
        if (disposition !== 'queued' && disposition !== 'replayed') {
          fail('enqueue returned an invalid disposition');
        }
        return Object.freeze({
          jobId: uuid(row.jobId, 'jobId'),
          disposition,
        });
      },
      { isolation: 'serializable' },
    );

    return Object.freeze({
      jobId: enqueued.jobId,
      disposition: enqueued.disposition,
      providerEffects: 'none',
      caps: Object.freeze({
        daily: CUSTOMER_EMAIL_DAILY_CAP,
        monthly: CUSTOMER_EMAIL_MONTHLY_CAP,
        recipientsPerJob: CUSTOMER_EMAIL_RECIPIENTS_PER_JOB,
      }),
    });
  }
}

export function createPgCustomerEmailLiveCommandService(
  dependencies: CustomerEmailLiveCommandServiceDependencies,
): CustomerEmailLiveCommandService {
  return new PgCustomerEmailLiveCommandService(dependencies);
}
