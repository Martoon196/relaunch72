import type { Pool, QueryResultRow } from 'pg';
import { withTransaction } from '../db/transaction.js';
import type { ProviderOperationResult } from '../providers/contracts.js';
import { normalizeOwnedInternalSeedEmail } from '../providers/property-predator-email-pilot-config.js';
import type {
  CustomerEmailLiveClaim,
  CustomerEmailLiveMaterial,
  CustomerEmailLiveRepository,
} from '../customer-email-live/foundation.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const MESSAGE_ID = /^<pp-([0-9a-f]{64})@mg[.]propertypredator[.]com>$/u;
const SAFE_CODE = /^[a-z][a-z0-9_.:-]{0,99}$/u;
const SENDING_DOMAIN = 'mg.propertypredator.com';
type CommandPool = Pick<Pool, 'connect'>;

interface ClaimRow extends QueryResultRow { jobId: unknown; leaseVersion: unknown }
interface MaterialRow extends QueryResultRow {
  providerConnectionId: unknown; sendingDomain: unknown;
  operationId: unknown; correlationId: unknown;
  requestSha256: unknown; expectedMessageId: unknown; recipient: unknown;
  subject: unknown; body: unknown;
}

function fail(label: string): never {
  throw new Error(`Customer email live repository returned invalid ${label}`);
}
function uuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) fail(label);
  return value;
}
function positiveInteger(value: unknown, label: string): number {
  const parsed = typeof value === 'string' && /^[1-9][0-9]*$/u.test(value)
    ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || (parsed as number) < 1) fail(label);
  return parsed as number;
}
function exactText(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) fail(label);
  return value;
}
function timestamp(value: unknown, label: string): string {
  const normalized = value instanceof Date ? value.toISOString() : value;
  if (typeof normalized !== 'string' || !Number.isFinite(Date.parse(normalized))) fail(label);
  return new Date(normalized).toISOString();
}

export class PgCustomerEmailLiveRepository implements CustomerEmailLiveRepository {
  readonly #workspaceId: string;
  readonly #connectionId: string;

  constructor(private readonly commandPool: CommandPool,
    binding: Readonly<{ workspaceId: string; connectionId: string }>) {
    this.#workspaceId = uuid(binding.workspaceId, 'workspace binding');
    this.#connectionId = uuid(binding.connectionId, 'connection binding');
  }

  async claimOne(input: Readonly<{ leaseToken: Buffer; leaseSeconds: number }>):
  Promise<CustomerEmailLiveClaim | null> {
    if (input.leaseToken.length !== 32 || !Number.isSafeInteger(input.leaseSeconds)
        || input.leaseSeconds < 30 || input.leaseSeconds > 300) fail('claim input');
    return withTransaction(
      this.commandPool,
      { actorKind: 'worker', workspaceId: this.#workspaceId,
        requestId: `customer-email:claim:${this.#connectionId}` },
      async (transaction) => {
        const result = await transaction.query<ClaimRow>(
          `/* customer-email-live.claim-one */
           SELECT job_id AS "jobId", lease_version AS "leaseVersion"
           FROM app_private.claim_customer_email_live_job(
             $1::uuid, $2::uuid, $3::bytea, $4::integer
           )`, [this.#workspaceId, this.#connectionId, input.leaseToken, input.leaseSeconds],
        );
        if (result.rows.length === 0) return null;
        if (result.rows.length !== 1 || !result.rows[0]) fail('claim cardinality');
        return Object.freeze({ workspaceId: this.#workspaceId, connectionId: this.#connectionId,
          jobId: uuid(result.rows[0].jobId, 'claim job'),
          leaseVersion: positiveInteger(result.rows[0].leaseVersion, 'claim lease version') });
      },
      { isolation: 'serializable' },
    );
  }

  async loadClaimed(input: CustomerEmailLiveClaim & Readonly<{ leaseToken: Buffer }>
  ): Promise<CustomerEmailLiveMaterial> {
    this.#assertClaim(input);
    if (input.leaseToken.length !== 32) fail('load token');
    return withTransaction(
      this.commandPool,
      { actorKind: 'worker', workspaceId: this.#workspaceId,
        requestId: `customer-email:load:${input.jobId}` },
      async (transaction) => {
        const result = await transaction.query<MaterialRow>(
          `/* customer-email-live.load-claimed */
           SELECT provider_connection_id AS "providerConnectionId",
                  sending_domain AS "sendingDomain",
                  operation_id AS "operationId", correlation_id AS "correlationId",
                  encode(request_sha256, 'hex') AS "requestSha256",
                  expected_message_id AS "expectedMessageId", recipient, subject, body
           FROM app_private.load_customer_email_live_job(
             $1::uuid, $2::uuid, $3::bigint, $4::bytea
           )`, [input.workspaceId, input.jobId, input.leaseVersion, input.leaseToken],
        );
        if (result.rows.length !== 1 || !result.rows[0]) fail('material cardinality');
        const row = result.rows[0];
        if (uuid(row.providerConnectionId, 'material connection') !== this.#connectionId) {
          fail('material connection binding');
        }
        if (row.sendingDomain !== SENDING_DOMAIN) fail('sending domain binding');
        const requestSha256 = exactText(row.requestSha256, SHA256, 'request digest');
        const expectedMessageId = exactText(row.expectedMessageId, MESSAGE_ID, 'message id');
        if (MESSAGE_ID.exec(expectedMessageId)?.[1] !== requestSha256) fail('message id binding');
        const recipient = typeof row.recipient === 'string'
          ? normalizeOwnedInternalSeedEmail(row.recipient) : fail('recipient');
        if (recipient !== row.recipient || typeof row.subject !== 'string'
            || !row.subject || /[\r\n]/u.test(row.subject)
            || Buffer.byteLength(row.subject, 'utf8') > 500
            || typeof row.body !== 'string' || !row.body
            || Buffer.byteLength(row.body, 'utf8') > 8_192) fail('mail material');
        return Object.freeze({ ...input, operationId: uuid(row.operationId, 'operation id'),
          correlationId: uuid(row.correlationId, 'correlation id'), requestSha256,
          expectedMessageId, sendingDomain: row.sendingDomain,
          recipient, subject: row.subject, text: row.body });
      },
      { readOnly: true, isolation: 'repeatable read' },
    );
  }

  async markCalling(input: CustomerEmailLiveClaim & Readonly<{
    leaseToken: Buffer; providerEffectsEnabled: true; emailDeliveryEnabled: true;
    emergencyPaused: false;
  }>): Promise<boolean> {
    this.#assertClaim(input);
    if (input.leaseToken.length !== 32 || input.providerEffectsEnabled !== true
        || input.emailDeliveryEnabled !== true || input.emergencyPaused !== false) {
      fail('begin-call input');
    }
    return withTransaction(
      this.commandPool,
      { actorKind: 'worker', workspaceId: this.#workspaceId,
        requestId: `customer-email:begin:${input.jobId}` },
      async (transaction) => {
        const result = await transaction.query<{ marked: unknown } & QueryResultRow>(
          `/* customer-email-live.begin-call */
           SELECT app_private.begin_customer_email_live_call(
             $1::uuid, $2::uuid, $3::bigint, $4::bytea,
             $5::boolean, $6::boolean, $7::boolean
           ) AS marked`, [input.workspaceId, input.jobId, input.leaseVersion,
            input.leaseToken, true, true, false],
        );
        return result.rows.length === 1 && result.rows[0]?.marked === true;
      },
      { isolation: 'serializable' },
    );
  }

  async settle(input: CustomerEmailLiveClaim & Readonly<{
    leaseToken: Buffer; result: ProviderOperationResult; receiptSha256: string;
  }>): Promise<void> {
    this.#assertClaim(input);
    const result = input.result;
    if (input.leaseToken.length !== 32 || !SHA256.test(input.receiptSha256)
        || !['accepted', 'pending', 'succeeded', 'failed', 'needs_attention'].includes(result.status)
        || (result.externalId !== null && (typeof result.externalId !== 'string'
          || result.externalId.length < 1 || result.externalId.length > 500))
        || typeof result.retryable !== 'boolean'
        || (result.errorCode !== null && !SAFE_CODE.test(result.errorCode))
        || !result.summary || result.summary !== result.summary.trim()
        || result.summary.length > 500) fail('settlement input');
    await withTransaction(
      this.commandPool,
      { actorKind: 'worker', workspaceId: this.#workspaceId,
        requestId: `customer-email:settle:${input.jobId}` },
      async (transaction) => {
        await transaction.query(
          `/* customer-email-live.settle */
           SELECT app_private.settle_customer_email_live_call(
             $1::uuid, $2::uuid, $3::bigint, $4::bytea, $5::text, $6::text,
             $7::timestamptz, $8::boolean, $9::text, $10::text, decode($11, 'hex')
           )`, [input.workspaceId, input.jobId, input.leaseVersion, input.leaseToken,
            result.status, result.externalId, timestamp(result.occurredAt, 'provider occurrence'),
            result.retryable, result.errorCode, result.summary, input.receiptSha256],
        );
      },
      { isolation: 'serializable' },
    );
  }

  #assertClaim(input: CustomerEmailLiveClaim): void {
    if (uuid(input.workspaceId, 'claim workspace') !== this.#workspaceId
        || uuid(input.connectionId, 'claim connection') !== this.#connectionId
        || !UUID.test(input.jobId) || !Number.isSafeInteger(input.leaseVersion)
        || input.leaseVersion < 1) fail('claim binding');
  }
}
