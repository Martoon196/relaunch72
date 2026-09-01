import type { Pool, QueryResultRow } from 'pg';
import { withTransaction } from '../db/transaction.js';
import type {
  AyrshareOwnedResult,
  OwnedProfileKeyEnvelope,
  OwnedPublicSocialClaim,
  OwnedPublicSocialJobMaterial,
  OwnedPublicSocialLiveRepository,
} from '../public-social-outbound/owned-live-foundation.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const OPERATION_TAG = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u;
const SAFE_EXTERNAL_ID = /^[A-Za-z0-9_-]{1,200}$/u;

type CommandPool = Pick<Pool, 'connect'>;

interface ClaimRow extends QueryResultRow {
  jobId: unknown;
  profileId: unknown;
  leaseVersion: unknown;
  attemptKind: unknown;
}

interface MaterialRow extends QueryResultRow {
  providerConnectionId: unknown;
  profileId: unknown;
  attemptKind: unknown;
  secretKeyVersion: unknown;
  profileKeyIv: unknown;
  profileKeyCiphertext: unknown;
  profileKeyAuthTag: unknown;
  profileKeyAadSha256: unknown;
  profileKeySha256: unknown;
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
  throw new Error(`Owned public-social repository returned invalid ${label}`);
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

function buffer(value: unknown, length: number | null, label: string): Buffer {
  const result = Buffer.isBuffer(value) ? Buffer.from(value) : null;
  if (!result || (length !== null && result.length !== length)) fail(label);
  return result;
}

function timestamp(value: unknown, label: string): string {
  const normalized = value instanceof Date ? value.toISOString() : value;
  if (typeof normalized !== 'string' || !Number.isFinite(Date.parse(normalized))) fail(label);
  return new Date(normalized).toISOString();
}

function optionalTimestamp(value: unknown, label: string): string | null {
  return value === null ? null : timestamp(value, label);
}

function optionalExternalId(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !SAFE_EXTERNAL_ID.test(value)) fail('external id');
  return value;
}

function socialNetwork(value: unknown): 'instagram' | 'linkedin' | 'x' {
  if (value !== 'instagram' && value !== 'linkedin' && value !== 'x') fail('network');
  return value;
}

function socialMedia(value: unknown): OwnedPublicSocialJobMaterial['media'] {
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
        || row.storageKey.length > 500
        || row.storageKey.includes('..') || row.storageKey.includes('//')
        || typeof row.blobSha256 !== 'string' || !SHA256.test(row.blobSha256)
        || typeof row.mimeType !== 'string'
        || !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(row.mimeType)) {
      fail('media');
    }
    return Object.freeze({
      storageKey: row.storageKey,
      blobSha256: row.blobSha256,
      mimeType: row.mimeType,
    });
  }));
}

function exactClaim(
  workspaceId: string,
  connectionId: string,
  rows: readonly ClaimRow[],
): OwnedPublicSocialClaim | null {
  if (rows.length === 0) return null;
  if (rows.length !== 1 || !rows[0]) fail('claim cardinality');
  const attemptKind = rows[0].attemptKind;
  if (attemptKind !== 'publish' && attemptKind !== 'reconcile') fail('attempt kind');
  return Object.freeze({
    workspaceId,
    connectionId,
    profileId: uuid(rows[0].profileId, 'profile id'),
    jobId: uuid(rows[0].jobId, 'job id'),
    leaseVersion: integer(rows[0].leaseVersion, 'lease version'),
    attemptKind,
  });
}

function envelope(row: MaterialRow): OwnedProfileKeyEnvelope {
  const keyVersion = row.secretKeyVersion;
  if (typeof keyVersion !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(keyVersion)) fail('key version');
  return Object.freeze({
    algorithm: 'aes-256-gcm-v1',
    keyVersion,
    ivBase64: buffer(row.profileKeyIv, 12, 'profile key IV').toString('base64'),
    ciphertextBase64: buffer(row.profileKeyCiphertext, null, 'profile key ciphertext').toString('base64'),
    authTagBase64: buffer(row.profileKeyAuthTag, 16, 'profile key auth tag').toString('base64'),
    aadSha256: buffer(row.profileKeyAadSha256, 32, 'profile key AAD').toString('hex'),
    profileKeySha256: buffer(row.profileKeySha256, 32, 'profile key digest').toString('hex'),
  });
}

export class PgOwnedPublicSocialLiveRepository implements OwnedPublicSocialLiveRepository {
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
    networks: readonly ('instagram' | 'linkedin' | 'x')[];
  }>): Promise<OwnedPublicSocialClaim | null> {
    if (input.leaseToken.length !== 32 || !Number.isSafeInteger(input.leaseSeconds)
        || input.leaseSeconds < 30 || input.leaseSeconds > 300) fail('claim input');
    if (!Array.isArray(input.networks) || input.networks.length < 1 || input.networks.length > 3) {
      fail('claim networks');
    }
    const networks = input.networks.map(socialNetwork);
    if (new Set(networks).size !== networks.length) fail('claim networks');
    return withTransaction(
      this.commandPool,
      {
        actorKind: 'worker', workspaceId: this.#workspaceId,
        requestId: `owned-social:claim:${this.#connectionId}`,
      },
      async (transaction) => {
        const result = await transaction.query<ClaimRow>(
          `/* owned-social.claim-one */
           SELECT job_id AS "jobId", profile_id AS "profileId",
                  lease_version AS "leaseVersion", attempt_kind AS "attemptKind"
           FROM app_private.claim_owned_social_job_v2(
             $1::uuid, $2::uuid, $3::text[], $4::bytea, $5::integer
           )`,
          [this.#workspaceId, this.#connectionId, networks, input.leaseToken, input.leaseSeconds],
        );
        return exactClaim(this.#workspaceId, this.#connectionId, result.rows);
      },
    );
  }

  async loadClaimed(
    input: OwnedPublicSocialClaim & Readonly<{ leaseToken: Buffer }>,
  ): Promise<OwnedPublicSocialJobMaterial> {
    this.#assertClaimBinding(input);
    if (input.leaseToken.length !== 32) fail('load token');
    return withTransaction(
      this.commandPool,
      {
        actorKind: 'worker', workspaceId: this.#workspaceId,
        requestId: `owned-social:load:${input.jobId}`,
      },
      async (transaction) => {
        const result = await transaction.query<MaterialRow>(
          `/* owned-social.load-claimed */
           SELECT provider_connection_id AS "providerConnectionId", profile_id AS "profileId",
                  attempt_kind AS "attemptKind", secret_key_version AS "secretKeyVersion",
                  profile_key_iv AS "profileKeyIv", profile_key_ciphertext AS "profileKeyCiphertext",
                  profile_key_auth_tag AS "profileKeyAuthTag",
                  profile_key_aad_sha256 AS "profileKeyAadSha256",
                  profile_key_sha256 AS "profileKeySha256", operation_tag AS "operationTag",
                  idempotency_key AS "idempotencyKey", text_body AS "textBody",
                  encode(text_sha256, 'hex') AS "textSha256", scheduled_for AS "scheduledFor",
                  provider_external_id AS "providerExternalId",
                  network, media
           FROM app_private.load_owned_social_job_v2($1::uuid, $2::uuid, $3::bigint, $4::bytea)`,
          [input.workspaceId, input.jobId, input.leaseVersion, input.leaseToken],
        );
        if (result.rows.length !== 1 || !result.rows[0]) fail('material cardinality');
        const row = result.rows[0];
        const connectionId = uuid(row.providerConnectionId, 'material connection');
        const profileId = uuid(row.profileId, 'material profile');
        if (connectionId !== input.connectionId || profileId !== input.profileId
            || row.attemptKind !== input.attemptKind) fail('material binding');
        if (typeof row.operationTag !== 'string' || !OPERATION_TAG.test(row.operationTag)
            || typeof row.idempotencyKey !== 'string' || !SHA256.test(row.idempotencyKey)
            || typeof row.textBody !== 'string' || row.textBody.length < 1 || row.textBody.length > 3_000
            || typeof row.textSha256 !== 'string' || !SHA256.test(row.textSha256)) {
          fail('material payload');
        }
        return Object.freeze({
          ...input,
          connectionId,
          profileId,
          envelope: envelope(row),
          operationTag: row.operationTag,
          idempotencyKey: row.idempotencyKey,
          text: row.textBody,
          textSha256: row.textSha256,
          scheduledFor: optionalTimestamp(row.scheduledFor, 'scheduled time'),
          externalId: optionalExternalId(row.providerExternalId),
          network: socialNetwork(row.network),
          media: socialMedia(row.media),
        });
      },
    );
  }

  async markCalling(input: OwnedPublicSocialClaim & Readonly<{
    leaseToken: Buffer;
    providerEffectsEnabled: true;
    emergencyPaused: false;
  }>): Promise<boolean> {
    this.#assertClaimBinding(input);
    if (input.leaseToken.length !== 32 || input.providerEffectsEnabled !== true
        || input.emergencyPaused !== false) fail('begin-call input');
    return withTransaction(
      this.commandPool,
      {
        actorKind: 'worker', workspaceId: this.#workspaceId,
        requestId: `owned-social:begin:${input.jobId}`,
      },
      async (transaction) => {
        const result = await transaction.query<{ marked: unknown } & QueryResultRow>(
          `/* owned-social.begin-call */
           SELECT app_private.begin_owned_social_call_v2(
             $1::uuid, $2::uuid, $3::bigint, $4::bytea, $5::boolean, $6::boolean
           ) AS marked`,
          [input.workspaceId, input.jobId, input.leaseVersion, input.leaseToken, true, false],
        );
        return result.rows.length === 1 && result.rows[0]?.marked === true;
      },
      { isolation: 'serializable' },
    );
  }

  async settle(input: OwnedPublicSocialClaim & Readonly<{
    leaseToken: Buffer;
    result: AyrshareOwnedResult;
  }>): Promise<void> {
    this.#assertClaimBinding(input);
    if (input.leaseToken.length !== 32 || !SHA256.test(input.result.receiptSha256)) {
      fail('settlement input');
    }
    await withTransaction(
      this.commandPool,
      {
        actorKind: 'worker', workspaceId: this.#workspaceId,
        requestId: `owned-social:settle:${input.jobId}`,
      },
      async (transaction) => {
        await transaction.query(
          `/* owned-social.settle */
           SELECT app_private.settle_owned_social_call(
             $1::uuid, $2::uuid, $3::bigint, $4::bytea, $5::text,
             $6::text, decode($7, 'hex'), $8::timestamptz, $9::text
           )`,
          [input.workspaceId, input.jobId, input.leaseVersion, input.leaseToken,
            input.result.state, input.result.externalId, input.result.receiptSha256,
            timestamp(input.result.occurredAt, 'provider occurrence'), input.result.safeCode],
        );
      },
      { isolation: 'serializable' },
    );
  }

  #assertClaimBinding(input: OwnedPublicSocialClaim): void {
    if (uuid(input.workspaceId, 'claim workspace') !== this.#workspaceId
        || uuid(input.connectionId, 'claim connection') !== this.#connectionId
        || !UUID.test(input.profileId) || !UUID.test(input.jobId)
        || !Number.isSafeInteger(input.leaseVersion) || input.leaseVersion < 1
        || (input.attemptKind !== 'publish' && input.attemptKind !== 'reconcile')) {
      fail('claim binding');
    }
  }
}
