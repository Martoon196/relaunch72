import type { Pool, QueryResultRow } from 'pg';
import { withTransaction } from '../db/transaction.js';
import type {
  ZernioCalendarClaim,
  ZernioCalendarJobMaterial,
  ZernioCalendarRepository,
  ZernioCalendarSettlement,
} from '../public-social-outbound/zernio-calendar-live.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const OPERATION_TAG = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u;
const SAFE_EXTERNAL_ID = /^[A-Za-z0-9_-]{1,200}$/u;

type CommandPool = Pick<Pool, 'connect'>;

interface ClaimRow extends QueryResultRow {
  jobId: unknown;
  bindingId: unknown;
  zernioAccountId: unknown;
  leaseVersion: unknown;
  attemptKind: unknown;
  network: unknown;
}

interface MaterialRow extends QueryResultRow {
  providerConnectionId: unknown;
  bindingId: unknown;
  zernioAccountId: unknown;
  providerProfileIdSha256: unknown;
  providerAccountIdSha256: unknown;
  attemptKind: unknown;
  operationTag: unknown;
  idempotencyKey: unknown;
  textBody: unknown;
  textSha256: unknown;
  scheduledFor: unknown;
  providerExternalId: unknown;
  network: unknown;
  media: unknown;
}

function fail(label: string): never {
  throw new Error(`Zernio calendar repository returned invalid ${label}`);
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) fail(label);
  return value;
}

function integer(value: unknown, label: string): number {
  const parsed = typeof value === 'string' && /^[1-9][0-9]*$/u.test(value)
    ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || (parsed as number) < 1) fail(label);
  return parsed as number;
}

function digest(value: unknown, label: string): string {
  const result = Buffer.isBuffer(value) ? value.toString('hex') : value;
  if (typeof result !== 'string' || !SHA256.test(result)) fail(label);
  return result;
}

function timestamp(value: unknown, label: string): string {
  const normalized = value instanceof Date ? value.toISOString() : value;
  if (typeof normalized !== 'string' || !Number.isFinite(Date.parse(normalized))) fail(label);
  return new Date(normalized).toISOString();
}

function network(value: unknown): 'instagram' | 'linkedin' {
  if (value !== 'instagram' && value !== 'linkedin') fail('network');
  return value;
}

function externalId(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !SAFE_EXTERNAL_ID.test(value)) fail('provider post id');
  return value;
}

function media(value: unknown): ZernioCalendarJobMaterial['media'] {
  let source = value;
  if (typeof source === 'string') {
    try { source = JSON.parse(source) as unknown; } catch { fail('media'); }
  }
  if (!Array.isArray(source) || source.length > 10) fail('media');
  return Object.freeze(source.map((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) fail('media');
    const row = candidate as Record<string, unknown>;
    if (typeof row.storageKey !== 'string'
        || !/^\/?[A-Za-z0-9][A-Za-z0-9._/-]{0,499}$/u.test(row.storageKey)
        || row.storageKey.includes('..') || row.storageKey.includes('//')
        || typeof row.blobSha256 !== 'string' || !SHA256.test(row.blobSha256)
        || typeof row.mimeType !== 'string'
        || !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(row.mimeType)) {
      fail('media');
    }
    return Object.freeze({
      storageKey: row.storageKey, blobSha256: row.blobSha256, mimeType: row.mimeType,
    });
  }));
}

function exactClaim(
  workspaceId: string,
  connectionId: string,
  rows: readonly ClaimRow[],
): ZernioCalendarClaim | null {
  if (rows.length === 0) return null;
  if (rows.length !== 1 || !rows[0]) fail('claim cardinality');
  const row = rows[0];
  if (row.attemptKind !== 'publish' && row.attemptKind !== 'reconcile') fail('attempt kind');
  return Object.freeze({
    workspaceId, connectionId,
    bindingId: uuid(row.bindingId, 'binding id'),
    accountRecordId: uuid(row.zernioAccountId, 'account record id'),
    jobId: uuid(row.jobId, 'job id'),
    leaseVersion: integer(row.leaseVersion, 'lease version'),
    attemptKind: row.attemptKind,
    network: network(row.network),
  });
}

export class PgZernioCalendarRepository implements ZernioCalendarRepository {
  readonly #workspaceId: string;
  readonly #connectionId: string;

  constructor(
    private readonly commandPool: CommandPool,
    binding: Readonly<{ workspaceId: string; connectionId: string }>,
  ) {
    this.#workspaceId = uuid(binding.workspaceId, 'workspace binding');
    this.#connectionId = uuid(binding.connectionId, 'connection binding');
  }

  async claimOne(input: Readonly<{
    leaseToken: Buffer;
    leaseSeconds: number;
    networks: readonly ('instagram' | 'linkedin')[];
  }>): Promise<ZernioCalendarClaim | null> {
    if (!Buffer.isBuffer(input.leaseToken) || input.leaseToken.length !== 32
        || !Number.isSafeInteger(input.leaseSeconds)
        || input.leaseSeconds < 30 || input.leaseSeconds > 300
        || !Array.isArray(input.networks) || input.networks.length < 1
        || input.networks.length > 2
        || input.networks.some((item) => item !== 'instagram' && item !== 'linkedin')
        || new Set(input.networks).size !== input.networks.length) fail('claim input');
    return withTransaction(this.commandPool, {
      actorKind: 'worker', workspaceId: this.#workspaceId,
      requestId: `zernio-calendar:claim:${this.#connectionId}`,
    }, async (transaction) => {
      const result = await transaction.query<ClaimRow>(
        `/* zernio-calendar.claim-one */
         SELECT job_id AS "jobId", binding_id AS "bindingId",
                zernio_account_id AS "zernioAccountId",
                lease_version AS "leaseVersion", attempt_kind AS "attemptKind",
                network
         FROM app_private.claim_zernio_calendar_job(
           $1::uuid,$2::uuid,$3::text[],$4::bytea,$5::integer
         )`,
        [this.#workspaceId, this.#connectionId, input.networks,
          input.leaseToken, input.leaseSeconds],
      );
      return exactClaim(this.#workspaceId, this.#connectionId, result.rows);
    }, { isolation: 'serializable' });
  }

  async loadClaimed(
    input: ZernioCalendarClaim & Readonly<{ leaseToken: Buffer }>,
  ): Promise<ZernioCalendarJobMaterial> {
    this.#assertClaim(input);
    if (!Buffer.isBuffer(input.leaseToken) || input.leaseToken.length !== 32) fail('load token');
    return withTransaction(this.commandPool, {
      actorKind: 'worker', workspaceId: this.#workspaceId,
      requestId: `zernio-calendar:load:${input.jobId}`,
    }, async (transaction) => {
      const result = await transaction.query<MaterialRow>(
        `/* zernio-calendar.load */
         SELECT provider_connection_id AS "providerConnectionId",
                binding_id AS "bindingId", zernio_account_id AS "zernioAccountId",
                provider_profile_id_sha256 AS "providerProfileIdSha256",
                provider_account_id_sha256 AS "providerAccountIdSha256",
                attempt_kind AS "attemptKind", operation_tag AS "operationTag",
                idempotency_key AS "idempotencyKey", text_body AS "textBody",
                encode(text_sha256, 'hex') AS "textSha256",
                scheduled_for AS "scheduledFor",
                provider_external_id AS "providerExternalId", network, media
         FROM app_private.load_zernio_calendar_job(
           $1::uuid,$2::uuid,$3::bigint,$4::bytea
         )`,
        [input.workspaceId, input.jobId, input.leaseVersion, input.leaseToken],
      );
      const row = result.rows[0];
      if (result.rows.length !== 1 || !row
          || uuid(row.providerConnectionId, 'material connection') !== input.connectionId
          || uuid(row.bindingId, 'material binding') !== input.bindingId
          || uuid(row.zernioAccountId, 'material account') !== input.accountRecordId
          || row.attemptKind !== input.attemptKind
          || network(row.network) !== input.network
          || !OPERATION_TAG.test(String(row.operationTag ?? ''))
          || typeof row.textBody !== 'string' || row.textBody.length < 1
          || row.textBody.length > 3_000
          || typeof row.idempotencyKey !== 'string' || !SHA256.test(row.idempotencyKey)) {
        fail('material binding');
      }
      digest(row.providerProfileIdSha256, 'provider profile digest');
      return Object.freeze({
        ...input,
        providerAccountIdSha256: digest(row.providerAccountIdSha256, 'provider account digest'),
        operationTag: row.operationTag as string,
        text: row.textBody,
        textSha256: digest(row.textSha256, 'text digest'),
        scheduledFor: timestamp(row.scheduledFor, 'scheduled time'),
        providerPostId: externalId(row.providerExternalId),
        media: media(row.media),
      });
    }, { readOnly: true, isolation: 'repeatable read' });
  }

  async markCalling(input: ZernioCalendarClaim & Readonly<{
    leaseToken: Buffer;
    providerEffectsEnabled: true;
    emergencyPaused: false;
  }>): Promise<boolean> {
    this.#assertClaim(input);
    if (!Buffer.isBuffer(input.leaseToken) || input.leaseToken.length !== 32
        || input.providerEffectsEnabled !== true || input.emergencyPaused !== false) {
      fail('begin-call input');
    }
    return withTransaction(this.commandPool, {
      actorKind: 'worker', workspaceId: this.#workspaceId,
      requestId: `zernio-calendar:begin:${input.jobId}`,
    }, async (transaction) => {
      const result = await transaction.query<{ marked: unknown } & QueryResultRow>(
        `/* zernio-calendar.begin-call */
         SELECT app_private.begin_zernio_calendar_call(
           $1::uuid,$2::uuid,$3::bigint,$4::bytea,$5::boolean,$6::boolean
         ) AS marked`,
        [input.workspaceId, input.jobId, input.leaseVersion,
          input.leaseToken, true, false],
      );
      return result.rows.length === 1 && result.rows[0]?.marked === true;
    }, { isolation: 'serializable' });
  }

  async settle(input: ZernioCalendarClaim & Readonly<{
    leaseToken: Buffer;
    result: ZernioCalendarSettlement;
  }>): Promise<void> {
    this.#assertClaim(input);
    if (!Buffer.isBuffer(input.leaseToken) || input.leaseToken.length !== 32
        || !SHA256.test(input.result.receiptSha256)
        || !/^[a-z][a-z0-9_.:-]{0,99}$/u.test(input.result.safeCode)) fail('settlement input');
    await withTransaction(this.commandPool, {
      actorKind: 'worker', workspaceId: this.#workspaceId,
      requestId: `zernio-calendar:settle:${input.jobId}`,
    }, async (transaction) => {
      await transaction.query(
        `/* zernio-calendar.settle */
         SELECT app_private.settle_zernio_calendar_call(
           $1::uuid,$2::uuid,$3::bigint,$4::bytea,$5::text,$6::text,
           decode($7, 'hex'),$8::timestamptz,$9::text
         )`,
        [input.workspaceId, input.jobId, input.leaseVersion, input.leaseToken,
          input.result.state, input.result.providerPostId, input.result.receiptSha256,
          timestamp(input.result.occurredAt, 'provider occurrence'), input.result.safeCode],
      );
    }, { isolation: 'serializable' });
  }

  #assertClaim(input: ZernioCalendarClaim): void {
    if (uuid(input.workspaceId, 'claim workspace') !== this.#workspaceId
        || uuid(input.connectionId, 'claim connection') !== this.#connectionId
        || !UUID.test(input.bindingId) || !UUID.test(input.accountRecordId)
        || !UUID.test(input.jobId) || !Number.isSafeInteger(input.leaseVersion)
        || input.leaseVersion < 1
        || (input.attemptKind !== 'publish' && input.attemptKind !== 'reconcile')
        || (input.network !== 'instagram' && input.network !== 'linkedin')) {
      fail('claim binding');
    }
  }
}
