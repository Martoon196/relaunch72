import { createHash, randomUUID } from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';
import { withTransaction } from '../db/transaction.js';
import {
  TEST_INBOX_WEBHOOK_PROVIDER_IDS,
  TestInboxWebhookBindingError,
  TestInboxWebhookEventConflictError,
  TestInboxWebhookSignatureReplayError,
  type TestInboxWebhookProviderId,
  type TestInboxWebhookRecordResult,
  type TestInboxWebhookRepository,
  type TestInboxWebhookTrustedBinding,
  type VerifiedTestInboxWebhookRecordInput,
} from './types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const WHATSAPP_EVENT = /^waevt_[a-f0-9]{32}$/;
const SOCIAL_EVENT = /^social_dm_evt_[a-f0-9]{32}$/;
const SAFE_BODY = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/u;
const PROVIDERS = new Set<string>(TEST_INBOX_WEBHOOK_PROVIDER_IDS);

interface RecordRow extends QueryResultRow {
  replayed: boolean;
  conversationId: string;
  messageId: string;
  messageVersionId: string;
  bodySha256: string;
}

interface PgErrorLike {
  code?: unknown;
  message?: unknown;
}

export interface PgTestInboxWebhookRepositoryDependencies {
  readonly commandPool: Pick<Pool, 'connect'>;
  readonly binding: TestInboxWebhookTrustedBinding;
  readonly nextId?: () => string;
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new TypeError(`${label} must be a canonical lowercase UUID`);
  }
  return value;
}

function bytes32(value: unknown, label: string): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    throw new TypeError(`${label} must contain exactly 32 bytes`);
  }
  return Buffer.from(value);
}

function providerId(value: unknown): TestInboxWebhookProviderId {
  if (typeof value !== 'string' || !PROVIDERS.has(value)) {
    throw new TypeError('providerId is not an approved TEST simulator');
  }
  return value as TestInboxWebhookProviderId;
}

function canonicalTimestamp(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('occurredAt must be canonical UTC');
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new TypeError('occurredAt must be canonical UTC');
  }
  return value;
}

function validateBinding(value: TestInboxWebhookTrustedBinding): TestInboxWebhookTrustedBinding {
  return Object.freeze({
    workspaceId: uuid(value.workspaceId, 'binding.workspaceId'),
    providerConnectionId: uuid(value.providerConnectionId, 'binding.providerConnectionId'),
    providerId: providerId(value.providerId),
    inboxId: uuid(value.inboxId, 'binding.inboxId'),
    contactId: uuid(value.contactId, 'binding.contactId'),
    contactPointId: uuid(value.contactPointId, 'binding.contactPointId'),
  });
}

function snapshotInput(
  input: Readonly<VerifiedTestInboxWebhookRecordInput>,
): Readonly<VerifiedTestInboxWebhookRecordInput & { bodySha256: Buffer }> {
  const provider = providerId(input.providerId);
  const externalEventId = input.externalEventId;
  if (typeof externalEventId !== 'string'
      || !(provider === 'whatsapp_dark_simulator'
        ? WHATSAPP_EVENT.test(externalEventId)
        : SOCIAL_EVENT.test(externalEventId))) {
    throw new TypeError('externalEventId is invalid for the TEST simulator');
  }
  const body = input.body;
  if (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') < 1
      || Buffer.byteLength(body, 'utf8') > 16_384 || !SAFE_BODY.test(body)) {
    throw new TypeError('body must contain 1-16384 safe UTF-8 bytes');
  }
  return Object.freeze({
    workspaceId: uuid(input.workspaceId, 'input.workspaceId'),
    providerConnectionId: uuid(input.providerConnectionId, 'input.providerConnectionId'),
    providerId: provider,
    inboxId: uuid(input.inboxId, 'input.inboxId'),
    contactId: uuid(input.contactId, 'input.contactId'),
    contactPointId: uuid(input.contactPointId, 'input.contactPointId'),
    externalEventId,
    occurredAt: canonicalTimestamp(input.occurredAt),
    payloadSha256: bytes32(input.payloadSha256, 'payloadSha256'),
    eventIdentitySha256: bytes32(input.eventIdentitySha256, 'eventIdentitySha256'),
    signatureSha256: bytes32(input.signatureSha256, 'signatureSha256'),
    sourceIdentitySha256: bytes32(input.sourceIdentitySha256, 'sourceIdentitySha256'),
    destinationIdentitySha256: bytes32(
      input.destinationIdentitySha256,
      'destinationIdentitySha256',
    ),
    body,
    bodySha256: createHash('sha256').update(body, 'utf8').digest(),
  });
}

function translateDatabaseError(error: unknown): never {
  if (error && typeof error === 'object') {
    const candidate = error as PgErrorLike;
    if (candidate.code === '22000'
        && candidate.message === 'test inbox webhook event identity conflict') {
      throw new TestInboxWebhookEventConflictError();
    }
    if (candidate.code === '22000'
        && candidate.message === 'test inbox webhook signature replay conflict') {
      throw new TestInboxWebhookSignatureReplayError();
    }
    if (candidate.code === '42501'
        && candidate.message === 'test inbox webhook binding is unavailable') {
      throw new TestInboxWebhookBindingError();
    }
  }
  throw error;
}

export class PgTestInboxWebhookRepository implements TestInboxWebhookRepository {
  readonly #commandPool: Pick<Pool, 'connect'>;
  readonly #binding: TestInboxWebhookTrustedBinding;
  readonly #nextId: () => string;

  constructor(dependencies: Readonly<PgTestInboxWebhookRepositoryDependencies>) {
    this.#commandPool = dependencies.commandPool;
    this.#binding = validateBinding({ ...dependencies.binding });
    this.#nextId = dependencies.nextId ?? randomUUID;
  }

  async record(
    input: Readonly<VerifiedTestInboxWebhookRecordInput>,
  ): Promise<Readonly<TestInboxWebhookRecordResult>> {
    const exact = snapshotInput(input);
    if (exact.workspaceId !== this.#binding.workspaceId
        || exact.providerConnectionId !== this.#binding.providerConnectionId
        || exact.providerId !== this.#binding.providerId
        || exact.inboxId !== this.#binding.inboxId
        || exact.contactId !== this.#binding.contactId
        || exact.contactPointId !== this.#binding.contactPointId) {
      throw new TestInboxWebhookBindingError();
    }
    const requestId = `test-inbox:${createHash('sha256')
      .update(exact.externalEventId, 'utf8').digest('hex').slice(0, 48)}`;
    const proposedIds = [this.#nextId(), this.#nextId(), this.#nextId()]
      .map((value, index) => uuid(value, ['conversationId', 'messageId', 'messageVersionId'][index]!));
    try {
      return await withTransaction(
        this.#commandPool,
        { actorKind: 'webhook', workspaceId: this.#binding.workspaceId, requestId },
        async (transaction) => {
          const result = await transaction.query<RecordRow>(
            `/* test-inbox-webhook.record-inbound */
             SELECT replayed,
                    conversation_id AS "conversationId",
                    message_id AS "messageId",
                    message_version_id AS "messageVersionId",
                    encode(body_sha256, 'hex') AS "bodySha256"
             FROM app_private.record_test_inbox_webhook_inbound(
               $1, $2, $3, $4, $5, $6, $7,
               $8, $9, $10, $11, $12, $13, $14,
               $15::timestamptz, $16, $17, $18
             )`,
            [
              this.#binding.workspaceId,
              this.#binding.providerConnectionId,
              this.#binding.providerId,
              this.#binding.inboxId,
              this.#binding.contactId,
              this.#binding.contactPointId,
              exact.externalEventId,
              exact.payloadSha256,
              exact.eventIdentitySha256,
              exact.signatureSha256,
              exact.sourceIdentitySha256,
              exact.destinationIdentitySha256,
              exact.body,
              exact.bodySha256,
              exact.occurredAt,
              proposedIds[0],
              proposedIds[1],
              proposedIds[2],
            ],
          );
          const row = result.rows[0];
          if (result.rows.length !== 1 || typeof row?.replayed !== 'boolean'
              || !UUID.test(row.conversationId) || !UUID.test(row.messageId)
              || !UUID.test(row.messageVersionId) || !SHA256.test(row.bodySha256)) {
            throw new Error('Test inbox webhook recorder returned invalid canonical data');
          }
          return Object.freeze({ ...row });
        },
        { isolation: 'serializable' },
      );
    } catch (error) {
      translateDatabaseError(error);
    }
  }
}

export function createPgTestInboxWebhookRepository(
  dependencies: Readonly<PgTestInboxWebhookRepositoryDependencies>,
): TestInboxWebhookRepository {
  return new PgTestInboxWebhookRepository(dependencies);
}
