import { createHash } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { validateDatabaseContext } from '../db/rls.js';
import { withTransaction } from '../db/transaction.js';
import { OWNED_PUBLIC_SOCIAL_LIVE_CONTRACT } from '../public-social-outbound/owned-live-foundation.js';
import type { OwnedPublicSocialNetwork } from '../public-social-outbound/owned-live-foundation.js';
import {
  OWNED_PUBLIC_SOCIAL_DAILY_PUBLISH_CAP,
  OWNED_PUBLIC_SOCIAL_MONTHLY_PUBLISH_CAP,
  OwnedPublicSocialLiveCommandError,
  type EnqueueOwnedPublicSocialJobCommand,
  type EnqueueOwnedPublicSocialJobResult,
  type OwnedPublicSocialLiveCommandService,
  type OwnedPublicSocialLiveCommandServiceDependencies,
  type OwnedPublicSocialLiveUserContext,
  type RecordOwnedPublicSocialProfileCommand,
  type RecordOwnedPublicSocialProfileResult,
  type RevokeOwnedPublicSocialProfileCommand,
  type RevokeOwnedPublicSocialProfileResult,
} from './command-types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const KEY_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const REASON_CODE = /^[a-z][a-z0-9_.:-]{0,99}$/u;
const OPERATION_TAG = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u;

interface IdRow extends QueryResultRow { id: unknown }

function fail(message: string): never {
  throw new OwnedPublicSocialLiveCommandError(message);
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

function exactBase64(
  value: unknown,
  minimumLength: number,
  maximumLength: number,
  label: string,
): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    fail(`${label} must be canonical base64`);
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value
      || decoded.length < minimumLength || decoded.length > maximumLength) {
    fail(`${label} must be canonical base64`);
  }
  return decoded;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))
      || new Date(value).toISOString() !== value) {
    fail(`${label} must be a canonical ISO timestamp`);
  }
  return value;
}

function optionalTimestamp(value: unknown, label: string): string | null {
  return value === null ? null : timestamp(value, label);
}

function network(value: unknown): OwnedPublicSocialNetwork {
  if (value !== 'instagram' && value !== 'linkedin' && value !== 'x') {
    fail('network must be instagram, linkedin or x');
  }
  return value;
}

function returnedId(rows: readonly IdRow[], label: string): string {
  if (rows.length !== 1) fail(`${label} returned invalid cardinality`);
  return uuid(rows[0]?.id, label);
}

function expectedProfileAadDigest(
  workspaceId: string,
  providerConnectionId: string,
  profileId: string,
  selectedNetwork: OwnedPublicSocialNetwork,
): string {
  return createHash('sha256').update(JSON.stringify({
    contract: OWNED_PUBLIC_SOCIAL_LIVE_CONTRACT,
    workspaceId,
    connectionId: providerConnectionId,
    profileId,
    providerId: 'ayrshare',
    network: selectedNetwork,
  }), 'utf8').digest('hex');
}

export class PgOwnedPublicSocialLiveCommandService
implements OwnedPublicSocialLiveCommandService {
  readonly workspaceId: string;
  readonly providerConnectionId: string;
  readonly #commandPool: OwnedPublicSocialLiveCommandServiceDependencies['commandPool'];

  constructor(dependencies: OwnedPublicSocialLiveCommandServiceDependencies) {
    this.workspaceId = uuid(dependencies.workspaceId, 'workspace binding');
    this.providerConnectionId = uuid(
      dependencies.providerConnectionId,
      'provider connection binding',
    );
    this.#commandPool = dependencies.commandPool;
  }

  async recordProfile(
    context: OwnedPublicSocialLiveUserContext,
    command: RecordOwnedPublicSocialProfileCommand,
  ): Promise<RecordOwnedPublicSocialProfileResult> {
    this.#assertContext(context);
    if (!command || typeof command !== 'object') fail('profile command is required');
    const profileId = uuid(command.profileId, 'profileId');
    const selectedNetwork = network(command.network ?? 'x');
    const envelope = command.envelope;
    if (typeof command.displayName !== 'string'
        || command.displayName !== command.displayName.trim()
        || command.displayName.length < 1 || command.displayName.length > 120
        || !envelope || typeof envelope !== 'object'
        || envelope.algorithm !== 'aes-256-gcm-v1'
        || !KEY_VERSION.test(envelope.keyVersion)
        || envelope.aadSha256 !== expectedProfileAadDigest(
          this.workspaceId,
          this.providerConnectionId,
          profileId,
          selectedNetwork,
        )) {
      fail('profile evidence is invalid');
    }
    const linkedAt = timestamp(command.linkedAt, 'linkedAt');
    const evidenceObservedAt = timestamp(
      command.evidenceObservedAt,
      'evidenceObservedAt',
    );
    if (Date.parse(linkedAt) > Date.parse(evidenceObservedAt) + 5 * 60_000) {
      fail('profile evidence chronology is invalid');
    }
    const commonValues = [
      this.workspaceId, this.providerConnectionId, profileId,
    ] as const;
    const evidenceValues = [
      command.displayName,
      digest(command.providerProfileRefSha256, 'providerProfileRefSha256'),
      digest(command.ownedAccountRefSha256, 'ownedAccountRefSha256'), envelope.keyVersion,
      exactBase64(envelope.ivBase64, 12, 12, 'profile key IV'),
      exactBase64(envelope.ciphertextBase64, 8, 1_024, 'profile key ciphertext'),
      exactBase64(envelope.authTagBase64, 16, 16, 'profile key auth tag'),
      digest(envelope.aadSha256, 'profile key AAD digest'),
      digest(envelope.profileKeySha256, 'profile key digest'),
      digest(command.providerLinkEvidenceSha256 ?? command.xOAuthLinkEvidenceSha256,
        'provider link evidence'), linkedAt, evidenceObservedAt,
    ] as const;
    const legacy = selectedNetwork === 'x' && command.network === undefined;
    const values = legacy
      ? [...commonValues, ...evidenceValues]
      : [...commonValues, selectedNetwork, ...evidenceValues];
    const id = await this.#executeId(
      context,
      legacy
        ? `/* owned-public-social-command.record-profile */
       SELECT app_private.record_owned_social_profile(
         $1::uuid, $2::uuid, $3::uuid, $4::text, $5::bytea,
         $6::bytea, $7::text, $8::bytea, $9::bytea, $10::bytea,
         $11::bytea, $12::bytea, $13::bytea, $14::timestamptz,
         $15::timestamptz
       ) AS id`
        : `/* owned-public-social-command.record-profile-v2 */
       SELECT app_private.record_owned_social_profile_v2(
         $1::uuid, $2::uuid, $3::uuid, $4::text, $5::text, $6::bytea,
         $7::bytea, $8::text, $9::bytea, $10::bytea, $11::bytea,
         $12::bytea, $13::bytea, $14::bytea, $15::timestamptz,
         $16::timestamptz
       ) AS id`,
      values,
      'profileId',
      profileId,
    );
    return Object.freeze({ profileId: id, providerEffects: 'none' });
  }

  async revokeProfile(
    context: OwnedPublicSocialLiveUserContext,
    command: RevokeOwnedPublicSocialProfileCommand,
  ): Promise<RevokeOwnedPublicSocialProfileResult> {
    this.#assertContext(context);
    if (!command || typeof command !== 'object' || !REASON_CODE.test(command.reasonCode)) {
      fail('profile revocation is invalid');
    }
    const revocationId = await this.#executeId(
      context,
      `/* owned-public-social-command.revoke-profile */
       SELECT app_private.revoke_owned_social_profile(
         $1::uuid, $2::uuid, $3::uuid, $4::bytea, $5::text
       ) AS id`,
      [this.workspaceId, this.providerConnectionId,
        uuid(command.profileId, 'profileId'),
        digest(command.revocationEvidenceSha256, 'revocation evidence'),
        command.reasonCode],
      'revocationId',
    );
    return Object.freeze({ revocationId, providerEffects: 'none' });
  }

  async enqueue(
    context: OwnedPublicSocialLiveUserContext,
    command: EnqueueOwnedPublicSocialJobCommand,
  ): Promise<EnqueueOwnedPublicSocialJobResult> {
    this.#assertContext(context);
    if (!command || typeof command !== 'object' || !OPERATION_TAG.test(command.operationTag)) {
      fail('enqueue command is invalid');
    }
    const legacy = command.network === undefined && command.planningIntentId === undefined;
    const values = legacy
      ? [this.workspaceId, this.providerConnectionId,
        uuid(command.profileId, 'profileId'),
        uuid(command.contentItemId, 'contentItemId'),
        uuid(command.contentVersionId, 'contentVersionId'),
        uuid(command.approvalRequestId, 'approvalRequestId'),
        uuid(command.approvalDecisionId, 'approvalDecisionId'),
        uuid(command.sourceAttestationId, 'sourceAttestationId'),
        command.operationTag,
        digest(command.idempotencyKeySha256, 'idempotencyKeySha256'),
        digest(command.requestSha256, 'requestSha256'),
        optionalTimestamp(command.scheduledFor, 'scheduledFor')]
      : [this.workspaceId, this.providerConnectionId,
        uuid(command.profileId, 'profileId'), network(command.network),
        uuid(command.planningIntentId, 'planningIntentId'),
        uuid(command.contentItemId, 'contentItemId'),
        uuid(command.contentVersionId, 'contentVersionId'),
        uuid(command.approvalRequestId, 'approvalRequestId'),
        uuid(command.approvalDecisionId, 'approvalDecisionId'),
        uuid(command.sourceAttestationId, 'sourceAttestationId'),
        command.operationTag,
        digest(command.idempotencyKeySha256, 'idempotencyKeySha256'),
        digest(command.requestSha256, 'requestSha256'),
        optionalTimestamp(command.scheduledFor, 'scheduledFor')];
    const jobId = await this.#executeId(
      context,
      legacy
        ? `/* owned-public-social-command.enqueue */
       SELECT app_private.enqueue_owned_social_job(
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
         $6::uuid, $7::uuid, $8::uuid, $9::text, $10::bytea,
         $11::bytea, $12::timestamptz
       ) AS id`
        : `/* owned-public-social-command.enqueue-v2 */
       SELECT app_private.enqueue_owned_social_job_v2(
         $1::uuid, $2::uuid, $3::uuid, $4::text, $5::uuid,
         $6::uuid, $7::uuid, $8::uuid, $9::uuid, $10::uuid,
         $11::text, $12::bytea, $13::bytea, $14::timestamptz
       ) AS id`,
      values,
      'jobId',
    );
    return Object.freeze({
      jobId,
      providerEffects: 'none',
      caps: Object.freeze({
        daily: OWNED_PUBLIC_SOCIAL_DAILY_PUBLISH_CAP,
        monthly: OWNED_PUBLIC_SOCIAL_MONTHLY_PUBLISH_CAP,
      }),
    });
  }

  #assertContext(context: OwnedPublicSocialLiveUserContext): void {
    validateDatabaseContext(context);
    if (context.actorKind !== 'user' || context.workspaceId !== this.workspaceId
        || !context.userId || !Buffer.isBuffer(context.portalSessionTokenHash)
        || context.portalSessionTokenHash.length !== 32) {
      fail('command crossed its trusted workspace or portal session');
    }
  }

  #executeId(
    context: OwnedPublicSocialLiveUserContext,
    sql: string,
    values: readonly unknown[],
    label: string,
    expectedId?: string,
  ): Promise<string> {
    return withTransaction(
      this.#commandPool,
      context,
      async (transaction) => {
        const id = returnedId(
          (await transaction.query<IdRow>(sql, [...values])).rows,
          label,
        );
        if (expectedId !== undefined && id !== expectedId) {
          fail('profile result did not match the requested profile');
        }
        return id;
      },
      { isolation: 'serializable' },
    );
  }
}

export function createPgOwnedPublicSocialLiveCommandService(
  dependencies: OwnedPublicSocialLiveCommandServiceDependencies,
): OwnedPublicSocialLiveCommandService {
  return new PgOwnedPublicSocialLiveCommandService(dependencies);
}
