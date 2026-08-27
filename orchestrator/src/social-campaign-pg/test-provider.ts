import { createHash, timingSafeEqual } from 'node:crypto';
import {
  SocialCampaignPgContractError,
  type PublicSocialTestProvider,
  type PublicSocialTestProviderContext,
  type PublicSocialTestProviderRequest,
  type PublicSocialTestProviderResult,
} from './types.js';
import {
  socialCampaignNetwork,
  socialCampaignSha256,
  socialCampaignTimestamp,
  socialCampaignUuid,
} from './validation.js';

const TEST_ACCOUNT = /^test-account:([a-z_]+):[a-z0-9_-]{1,64}$/u;
const TEST_REFERENCE = /^social_test_ref_[a-f0-9]{32}$/u;
const SAFE_KEY = /^[\x21-\x7e]{1,200}$/u;
const SAFE_TEXT = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/u;

export interface PublicSocialTestProviderAudit {
  readonly mode: 'simulate' | 'reconcile';
  readonly operationId: string;
  readonly network: PublicSocialTestProviderRequest['network'] | null;
  readonly accountSha256: string | null;
  readonly bodySha256: string | null;
  readonly testReference: string;
  readonly externalPublishAttempted: false;
}

function fail(message: string): never {
  throw new SocialCampaignPgContractError(message);
}

function snapshotContext(input: PublicSocialTestProviderContext): PublicSocialTestProviderContext {
  if (typeof input !== 'object' || input === null) fail('TEST provider context is invalid');
  const source = input as unknown as Record<string, unknown>;
  const workspaceId = socialCampaignUuid(source.workspaceId, 'context.workspaceId');
  const connectionId = socialCampaignUuid(source.connectionId, 'context.connectionId');
  const operationId = socialCampaignUuid(source.operationId, 'context.operationId');
  const correlationId = socialCampaignUuid(source.correlationId, 'context.correlationId');
  if (typeof source.idempotencyKey !== 'string' || !SAFE_KEY.test(source.idempotencyKey)) {
    fail('context.idempotencyKey is invalid');
  }
  return Object.freeze({
    workspaceId, connectionId, operationId, correlationId,
    idempotencyKey: source.idempotencyKey,
  });
}

function reference(context: PublicSocialTestProviderContext): string {
  return `social_test_ref_${createHash('sha256').update(JSON.stringify({
    workspaceId: context.workspaceId,
    connectionId: context.connectionId,
    operationId: context.operationId,
    correlationId: context.correlationId,
    idempotencyKeySha256: createHash('sha256').update(context.idempotencyKey, 'utf8').digest('hex'),
  }), 'utf8').digest('hex').slice(0, 32)}`;
}

function snapshotRequest(input: PublicSocialTestProviderRequest): PublicSocialTestProviderRequest {
  if (typeof input !== 'object' || input === null) fail('TEST provider request is invalid');
  const source = input as unknown as Record<string, unknown>;
  const rawTargetId = source.targetId;
  const rawNetwork = source.network;
  const rawTestAccountRef = source.testAccountRef;
  const rawText = source.text;
  const rawBodySha256 = source.bodySha256;
  const rawPlanSha256 = source.planSha256;
  const rawContentVersionId = source.contentVersionId;
  const rawContentSha256 = source.contentSha256;
  const rawMedia = source.media;
  const targetId = socialCampaignUuid(rawTargetId, 'request.targetId');
  const network = socialCampaignNetwork(rawNetwork, 'request.network');
  if (typeof rawTestAccountRef !== 'string') fail('request.testAccountRef is invalid');
  const accountMatch = TEST_ACCOUNT.exec(rawTestAccountRef);
  if (!accountMatch || accountMatch[1] !== network) {
    fail('TEST provider accepts only its network-bound non-routable account');
  }
  if (typeof rawText !== 'string' || !SAFE_TEXT.test(rawText)
      || Buffer.byteLength(rawText, 'utf8') < 1
      || Buffer.byteLength(rawText, 'utf8') > 16_384) {
    fail('request.text is invalid');
  }
  const bodySha256 = socialCampaignSha256(rawBodySha256, 'request.bodySha256');
  const suppliedBody = Buffer.from(bodySha256, 'hex');
  const calculatedBody = createHash('sha256').update(rawText, 'utf8').digest();
  if (!timingSafeEqual(suppliedBody, calculatedBody)) fail('request.bodySha256 does not match text');
  const planSha256 = socialCampaignSha256(rawPlanSha256, 'request.planSha256');
  const contentVersionId = socialCampaignUuid(rawContentVersionId, 'request.contentVersionId');
  const contentSha256 = socialCampaignSha256(rawContentSha256, 'request.contentSha256');
  if (!Array.isArray(rawMedia) || rawMedia.length > 10) fail('request.media is invalid');
  const mediaIds = new Set<string>();
  const media = rawMedia.map((candidate, index) => {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
      fail(`request.media[${index}] is invalid`);
    }
    const row = candidate as Record<string, unknown>;
    const contentVersionId = socialCampaignUuid(
      row.contentVersionId,
      `request.media[${index}].contentVersionId`,
    );
    const contentSha256 = socialCampaignSha256(
      row.contentSha256,
      `request.media[${index}].contentSha256`,
    );
    const blobSha256 = socialCampaignSha256(
      row.blobSha256,
      `request.media[${index}].blobSha256`,
    );
    if (typeof row.blobStorageKey !== 'string'
        || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,499}$/u.test(row.blobStorageKey)
        || row.blobStorageKey.includes('..') || row.blobStorageKey.includes('//')) {
      fail(`request.media[${index}].blobStorageKey is invalid`);
    }
    if (typeof row.mimeType !== 'string'
        || !/^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/u.test(row.mimeType)) {
      fail(`request.media[${index}].mimeType is invalid`);
    }
    if (mediaIds.has(contentVersionId)) fail('request.media has duplicate content versions');
    mediaIds.add(contentVersionId);
    return Object.freeze({
      contentVersionId,
      contentSha256,
      blobStorageKey: row.blobStorageKey,
      blobSha256,
      mimeType: row.mimeType,
    });
  });
  return Object.freeze({
    targetId,
    network,
    testAccountRef: rawTestAccountRef,
    text: rawText,
    bodySha256,
    planSha256,
    contentVersionId,
    contentSha256,
    media: Object.freeze(media),
  });
}

/**
 * In-process TEST adapter. It imports no transport, accepts only reserved
 * accounts, emits a deterministic fake reference and retains only hashes.
 */
export class DeterministicPublicSocialTestProvider implements PublicSocialTestProvider {
  readonly #audit: PublicSocialTestProviderAudit[] = [];
  readonly #auditCapacity: number;
  readonly #now: () => Date;

  constructor(options: Readonly<{ now?: () => Date; auditCapacity?: number }> = {}) {
    if (typeof options !== 'object' || options === null
        || (options.now !== undefined && typeof options.now !== 'function')
        || (options.auditCapacity !== undefined && (!Number.isInteger(options.auditCapacity)
          || options.auditCapacity < 0 || options.auditCapacity > 1_000))) {
      fail('TEST provider options are invalid');
    }
    this.#now = options.now ?? (() => new Date());
    this.#auditCapacity = options.auditCapacity ?? 0;
  }

  get audit(): readonly PublicSocialTestProviderAudit[] {
    return Object.freeze(this.#audit.map((entry) => Object.freeze({ ...entry })));
  }

  #occurredAt(): string {
    const instant = this.#now();
    if (!(instant instanceof Date) || !Number.isFinite(Date.prototype.getTime.call(instant))) {
      fail('TEST provider clock returned an invalid instant');
    }
    return socialCampaignTimestamp(new Date(Date.prototype.getTime.call(instant)).toISOString(), 'occurredAt');
  }

  #record(entry: PublicSocialTestProviderAudit): void {
    if (this.#auditCapacity === 0) return;
    if (this.#audit.length === this.#auditCapacity) this.#audit.shift();
    this.#audit.push(Object.freeze(entry));
  }

  async simulate(
    rawContext: PublicSocialTestProviderContext,
    rawRequest: PublicSocialTestProviderRequest,
  ): Promise<PublicSocialTestProviderResult> {
    const context = snapshotContext(rawContext);
    const request = snapshotRequest(rawRequest);
    const testReference = reference(context);
    this.#record({
      mode: 'simulate',
      operationId: context.operationId,
      network: request.network,
      accountSha256: createHash('sha256').update(request.testAccountRef, 'utf8').digest('hex'),
      bodySha256: request.bodySha256,
      testReference,
      externalPublishAttempted: false,
    });
    return Object.freeze({
      status: 'succeeded',
      testReference,
      occurredAt: this.#occurredAt(),
      retryable: false,
      errorCode: null,
      summary: 'Reserved TEST social target simulated',
      externalPublishAttempted: false,
    });
  }

  async reconcile(
    rawContext: PublicSocialTestProviderContext,
    suppliedReference: string | null,
  ): Promise<PublicSocialTestProviderResult> {
    const context = snapshotContext(rawContext);
    const expected = reference(context);
    if (suppliedReference !== null
        && (typeof suppliedReference !== 'string'
          || !TEST_REFERENCE.test(suppliedReference)
          || suppliedReference !== expected)) {
      fail('TEST provider reconciliation reference is invalid');
    }
    this.#record({
      mode: 'reconcile',
      operationId: context.operationId,
      network: null,
      accountSha256: null,
      bodySha256: null,
      testReference: expected,
      externalPublishAttempted: false,
    });
    return Object.freeze({
      status: 'succeeded',
      testReference: expected,
      occurredAt: this.#occurredAt(),
      retryable: false,
      errorCode: null,
      summary: 'Reserved TEST social target reconciled',
      externalPublishAttempted: false,
    });
  }
}
