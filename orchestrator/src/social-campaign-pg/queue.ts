import { createHash } from 'node:crypto';
import type { SqlExecutor } from '../crm-pg/types.js';
import {
  PUBLIC_SOCIAL_TEST_PROVIDER_ID,
  PublicSocialTestLeaseLostError,
  SocialCampaignPgContractError,
  type PublicSocialTestClaim,
  type PublicSocialTestDispatchPayload,
  type PublicSocialTestLeaseIdentity,
  type PublicSocialTestMediaEvidence,
  type PublicSocialTestProviderResult,
  type PublicSocialTestQueue,
  type PublicSocialTestSettlement,
} from './types.js';
import {
  socialCampaignInteger,
  socialCampaignNetwork,
  socialCampaignOptionalTimestamp,
  socialCampaignSafeKey,
  socialCampaignSha256,
  socialCampaignState,
  socialCampaignTimestamp,
  socialCampaignUuid,
} from './validation.js';

const TEST_ACCOUNT = /^test-account:([a-z_]+):[a-z0-9_-]{1,64}$/u;
const TEST_REFERENCE = /^social_test_ref_[a-f0-9]{32}$/u;
const SAFE_TEXT = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]*$/u;

interface ClaimRow extends Record<string, unknown> {
  operationId: unknown;
  workspaceId: unknown;
  postId: unknown;
  targetId: unknown;
  connectionId: unknown;
  network: unknown;
  idempotencyKey: unknown;
  correlationId: unknown;
  attemptNumber: unknown;
  leaseVersion: unknown;
  leaseExpiresAt: unknown;
  attemptKind: unknown;
  testReference: unknown;
}

interface DispatchRow extends Record<string, unknown> {
  contentVersionId: unknown;
  contentSha256: unknown;
  text: unknown;
  media: unknown;
  network: unknown;
  testAccountRef: unknown;
  scheduledFor: unknown;
  planSha256: unknown;
  approvalDecisionId: unknown;
}

interface SettlementRow extends Record<string, unknown> {
  operationState: unknown;
  completedAt: unknown;
}

function leaseHash(lease: PublicSocialTestLeaseIdentity): Buffer {
  socialCampaignUuid(lease.workerId, 'workerId');
  const token = Buffer.from(lease.leaseToken);
  if (token.byteLength !== 32) {
    throw new SocialCampaignPgContractError('leaseToken must contain exactly 32 bytes');
  }
  return createHash('sha256').update(token).digest();
}

function exactOne<TRow extends Record<string, unknown>>(rows: readonly TRow[], label: string): TRow {
  const row = rows[0];
  if (rows.length !== 1 || !row) throw new SocialCampaignPgContractError(`${label} returned invalid cardinality`);
  return row;
}

function optionalTestReference(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !TEST_REFERENCE.test(value)) {
    throw new SocialCampaignPgContractError(`${label} returned invalid TEST reference`);
  }
  return value;
}

function validateMedia(value: unknown): readonly PublicSocialTestMediaEvidence[] {
  let source = value;
  if (typeof source === 'string') {
    try { source = JSON.parse(source) as unknown; }
    catch { throw new SocialCampaignPgContractError('media returned invalid JSON'); }
  }
  if (!Array.isArray(source) || source.length > 10) {
    throw new SocialCampaignPgContractError('media returned invalid evidence');
  }
  const seen = new Set<string>();
  const media = source.map((candidate, index) => {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
      throw new SocialCampaignPgContractError(`media[${index}] returned invalid evidence`);
    }
    const row = candidate as Record<string, unknown>;
    const contentVersionId = socialCampaignUuid(
      row.contentVersionId ?? row.content_version_id,
      `media[${index}].contentVersionId`,
    );
    const contentSha256 = socialCampaignSha256(
      row.contentSha256 ?? row.content_sha256,
      `media[${index}].contentSha256`,
    );
    const blobSha256 = socialCampaignSha256(
      row.blobSha256 ?? row.blob_sha256,
      `media[${index}].blobSha256`,
    );
    const blobStorageKeyValue = row.blobStorageKey ?? row.blob_storage_key;
    const mimeTypeValue = row.mimeType ?? row.mime_type;
    if (typeof blobStorageKeyValue !== 'string'
        || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,499}$/u.test(blobStorageKeyValue)
        || blobStorageKeyValue.includes('..') || blobStorageKeyValue.includes('//')) {
      throw new SocialCampaignPgContractError(`media[${index}].blobStorageKey returned invalid evidence`);
    }
    if (typeof mimeTypeValue !== 'string'
        || !/^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/u.test(mimeTypeValue)) {
      throw new SocialCampaignPgContractError(`media[${index}].mimeType returned invalid evidence`);
    }
    if (seen.has(contentVersionId)) {
      throw new SocialCampaignPgContractError('media returned duplicate content versions');
    }
    seen.add(contentVersionId);
    return Object.freeze({
      contentVersionId,
      contentSha256,
      blobStorageKey: blobStorageKeyValue,
      blobSha256,
      mimeType: mimeTypeValue,
    });
  });
  return Object.freeze(media);
}

function validateClaim(row: ClaimRow): PublicSocialTestClaim {
  const attemptKind = row.attemptKind;
  if (attemptKind !== 'simulation' && attemptKind !== 'reconcile') {
    throw new SocialCampaignPgContractError('claim attemptKind is invalid');
  }
  const testReference = optionalTestReference(row.testReference, 'testReference');
  if (attemptKind === 'simulation' && testReference !== null) {
    throw new SocialCampaignPgContractError('simulation claim unexpectedly retained a TEST reference');
  }
  return Object.freeze({
    operationId: socialCampaignUuid(row.operationId, 'operationId'),
    workspaceId: socialCampaignUuid(row.workspaceId, 'workspaceId'),
    postId: socialCampaignUuid(row.postId, 'postId'),
    targetId: socialCampaignUuid(row.targetId, 'targetId'),
    connectionId: socialCampaignUuid(row.connectionId, 'connectionId'),
    network: socialCampaignNetwork(row.network, 'network'),
    environment: 'test',
    idempotencyKey: socialCampaignSafeKey(row.idempotencyKey, 'idempotencyKey'),
    correlationId: socialCampaignUuid(row.correlationId, 'correlationId'),
    attemptNumber: socialCampaignInteger(row.attemptNumber, 'attemptNumber', 1, 4),
    leaseVersion: socialCampaignInteger(row.leaseVersion, 'leaseVersion', 1, Number.MAX_SAFE_INTEGER),
    leaseExpiresAt: socialCampaignTimestamp(row.leaseExpiresAt, 'leaseExpiresAt'),
    attemptKind,
    testReference,
  });
}

function validatePayload(row: DispatchRow, claim: PublicSocialTestClaim): PublicSocialTestDispatchPayload {
  const network = socialCampaignNetwork(row.network, 'network');
  if (network !== claim.network) {
    throw new SocialCampaignPgContractError('dispatch payload is not bound to its exact claim');
  }
  if (typeof row.testAccountRef !== 'string' || !TEST_ACCOUNT.test(row.testAccountRef)
      || TEST_ACCOUNT.exec(row.testAccountRef)?.[1] !== network) {
    throw new SocialCampaignPgContractError('dispatch payload returned a routable or mismatched account');
  }
  if (typeof row.text !== 'string' || !SAFE_TEXT.test(row.text)
      || Buffer.byteLength(row.text, 'utf8') < 1 || Buffer.byteLength(row.text, 'utf8') > 16_384) {
    throw new SocialCampaignPgContractError('dispatch payload returned invalid text');
  }
  const bodySha256 = createHash('sha256').update(row.text, 'utf8').digest('hex');
  const contentSha256 = socialCampaignSha256(row.contentSha256, 'contentSha256');
  if (bodySha256 !== contentSha256) {
    throw new SocialCampaignPgContractError(
      'dispatch payload body does not match the exact approved content hash',
    );
  }
  return Object.freeze({
    workspaceId: claim.workspaceId,
    operationId: claim.operationId,
    connectionId: claim.connectionId,
    providerId: PUBLIC_SOCIAL_TEST_PROVIDER_ID,
    postId: claim.postId,
    targetId: claim.targetId,
    network,
    testAccountRef: row.testAccountRef,
    contentVersionId: socialCampaignUuid(row.contentVersionId, 'contentVersionId'),
    contentSha256,
    approvalDecisionId: socialCampaignUuid(row.approvalDecisionId, 'approvalDecisionId'),
    text: row.text,
    bodySha256,
    planSha256: socialCampaignSha256(row.planSha256, 'planSha256'),
    scheduledFor: socialCampaignTimestamp(row.scheduledFor, 'scheduledFor'),
    media: validateMedia(row.media),
  });
}

function validateProviderResult(result: PublicSocialTestProviderResult): void {
  if (!['succeeded', 'failed', 'needs_attention'].includes(result.status)
      || result.externalPublishAttempted !== false
      || typeof result.retryable !== 'boolean'
      || typeof result.summary !== 'string' || result.summary !== result.summary.trim()
      || result.summary.length < 1 || Buffer.byteLength(result.summary, 'utf8') > 500
      || (result.testReference !== null && !TEST_REFERENCE.test(result.testReference))
      || (result.status === 'succeeded' && result.testReference === null)
      || (result.status === 'failed' && result.errorCode === null)
      || (result.errorCode !== null && !/^[a-z][a-z0-9_.:-]{0,99}$/u.test(result.errorCode))) {
    throw new SocialCampaignPgContractError('TEST provider returned an invalid result');
  }
  socialCampaignTimestamp(result.occurredAt, 'occurredAt');
}

function settlement(row: SettlementRow, claim: PublicSocialTestClaim): PublicSocialTestSettlement {
  return Object.freeze({
    operationId: claim.operationId,
    state: socialCampaignState(row.operationState, 'operationState'),
    completedAt: socialCampaignOptionalTimestamp(row.completedAt, 'completedAt'),
  });
}

/** Function-only queue boundary for r72_social_worker_command. */
export class PgPublicSocialTestQueue implements PublicSocialTestQueue {
  constructor(private readonly executor: SqlExecutor) {}

  async claim(
    lease: PublicSocialTestLeaseIdentity,
    options: Readonly<{ batchSize?: number; leaseSeconds?: number }> = {},
  ): Promise<readonly PublicSocialTestClaim[]> {
    const hash = leaseHash(lease);
    const batchSize = socialCampaignInteger(options.batchSize ?? 1, 'batchSize', 1, 25);
    const leaseSeconds = socialCampaignInteger(options.leaseSeconds ?? 60, 'leaseSeconds', 15, 300);
    const result = await this.executor.query<ClaimRow>(
      `/* social-campaign.claim */
       SELECT operation_id AS "operationId", workspace_id AS "workspaceId",
              post_id AS "postId", target_id AS "targetId",
              provider_connection_id AS "connectionId", network,
              idempotency_key AS "idempotencyKey", correlation_id AS "correlationId",
              attempt_number AS "attemptNumber",
              lease_version AS "leaseVersion", lease_expires_at AS "leaseExpiresAt",
              attempt_kind AS "attemptKind", test_reference AS "testReference"
       FROM app_private.claim_due_test_social_targets($1::uuid, $2::bytea, $3::integer, $4::integer)`,
      [lease.workerId, hash, batchSize, leaseSeconds],
    );
    if (result.rows.length > batchSize) {
      throw new SocialCampaignPgContractError('claim exceeded its requested bound');
    }
    return Object.freeze(result.rows.map(validateClaim));
  }

  async load(
    claim: PublicSocialTestClaim,
    lease: PublicSocialTestLeaseIdentity,
  ): Promise<PublicSocialTestDispatchPayload> {
    const hash = leaseHash(lease);
    const result = await this.executor.query<DispatchRow>(
      `/* social-campaign.load-dispatch */
       SELECT content_version_id AS "contentVersionId",
              encode(content_sha256, 'hex') AS "contentSha256",
              body_text AS text, media, network,
              test_account_ref AS "testAccountRef",
              scheduled_for AS "scheduledFor",
              encode(plan_sha256, 'hex') AS "planSha256",
              approval_decision_id AS "approvalDecisionId"
       FROM app_private.load_test_social_dispatch_payload(
         $1::uuid, $2::uuid, $3::uuid, $4::bytea, $5::bigint
       )`,
      [claim.workspaceId, claim.operationId, lease.workerId, hash, claim.leaseVersion],
    );
    return validatePayload(exactOne(result.rows, 'load dispatch'), claim);
  }

  async markCalling(
    claim: PublicSocialTestClaim,
    lease: PublicSocialTestLeaseIdentity,
  ): Promise<void> {
    const hash = leaseHash(lease);
    const result = await this.executor.query<{ marked: unknown } & Record<string, unknown>>(
      `/* social-campaign.mark-calling */
       SELECT app_private.mark_test_social_target_calling(
         $1::uuid, $2::uuid, $3::uuid, $4::bytea, $5::bigint
       ) AS marked`,
      [claim.workspaceId, claim.operationId, lease.workerId, hash, claim.leaseVersion],
    );
    if (result.rows.length !== 1 || result.rows[0]?.marked !== true) {
      throw new PublicSocialTestLeaseLostError();
    }
  }

  async renew(
    claim: PublicSocialTestClaim,
    lease: PublicSocialTestLeaseIdentity,
    leaseSeconds = 60,
  ): Promise<string> {
    const hash = leaseHash(lease);
    const seconds = socialCampaignInteger(leaseSeconds, 'leaseSeconds', 15, 300);
    const result = await this.executor.query<{ leaseExpiresAt: unknown } & Record<string, unknown>>(
      `/* social-campaign.renew */
       SELECT app_private.renew_test_social_target_lease(
         $1::uuid, $2::uuid, $3::uuid, $4::bytea, $5::bigint, $6::integer
       ) AS "leaseExpiresAt"`,
      [claim.workspaceId, claim.operationId, lease.workerId, hash, claim.leaseVersion, seconds],
    );
    return socialCampaignTimestamp(exactOne(result.rows, 'renew lease').leaseExpiresAt, 'leaseExpiresAt');
  }

  async settle(
    claim: PublicSocialTestClaim,
    lease: PublicSocialTestLeaseIdentity,
    providerResult: PublicSocialTestProviderResult,
  ): Promise<PublicSocialTestSettlement> {
    validateProviderResult(providerResult);
    const hash = leaseHash(lease);
    const result = await this.executor.query<SettlementRow>(
      `/* social-campaign.settle */
       SELECT operation_state AS "operationState", completed_at AS "completedAt"
       FROM app_private.settle_test_social_target(
         $1::uuid, $2::uuid, $3::uuid, $4::bytea, $5::bigint,
         $6::text, $7::text, $8::boolean, $9::text, $10::text, $11::timestamptz
       )`,
      [claim.workspaceId, claim.operationId, lease.workerId, hash, claim.leaseVersion,
        providerResult.status, providerResult.testReference, providerResult.retryable,
        providerResult.errorCode, providerResult.summary, providerResult.occurredAt],
    );
    return settlement(exactOne(result.rows, 'settle target'), claim);
  }

  async reconcile(
    claim: PublicSocialTestClaim,
    lease: PublicSocialTestLeaseIdentity,
    providerResult: PublicSocialTestProviderResult,
  ): Promise<PublicSocialTestSettlement> {
    validateProviderResult(providerResult);
    if (claim.attemptKind !== 'reconcile'
        || providerResult.status !== 'succeeded'
        || providerResult.testReference === null
        || (claim.testReference !== null
          && providerResult.testReference !== claim.testReference)) {
      throw new SocialCampaignPgContractError('reconciliation result is not bound to its claim');
    }
    const hash = leaseHash(lease);
    const result = await this.executor.query<SettlementRow>(
      `/* social-campaign.reconcile */
       SELECT operation_state AS "operationState", completed_at AS "completedAt"
       FROM app_private.reconcile_test_social_target(
         $1::uuid, $2::uuid, $3::uuid, $4::bytea, $5::bigint, $6::text, $7::timestamptz
       )`,
      [claim.workspaceId, claim.operationId, lease.workerId, hash, claim.leaseVersion,
        providerResult.testReference, providerResult.occurredAt],
    );
    return settlement(exactOne(result.rows, 'reconcile target'), claim);
  }
}
