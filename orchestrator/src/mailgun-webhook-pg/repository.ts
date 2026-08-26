import { createHash } from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';
import { withTransaction } from '../db/transaction.js';
import {
  MailgunWebhookEventConflictError,
  MailgunWebhookReplayError,
  MailgunWebhookUnmatchedDeliveryError,
  type MailgunWebhookRecordInput,
  type MailgunWebhookRepository,
  type MailgunWebhookRepositoryRecordResult,
} from './types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EVENT_ID = /^[A-Za-z0-9._:+/=-]{1,255}$/;
const MESSAGE_ID = /^[^\u0000-\u001f\u007f]{1,500}$/u;
const EVENT_TYPES = new Set([
  'accepted', 'delivered', 'opened', 'clicked', 'failed', 'complained', 'unsubscribed',
]);
const DELIVERY_STATUSES = new Set(['accepted', 'delivered', 'read', 'failed']);

interface RecordRow extends QueryResultRow {
  replayed: boolean;
  delivery_status: string | null;
  suppression_recorded: boolean;
  opt_out_recorded: boolean;
}

interface PgErrorLike {
  code?: unknown;
  message?: unknown;
}

export interface PgMailgunWebhookRepositoryDependencies {
  readonly commandPool: Pick<Pool, 'connect'>;
  /** Server-trusted route mapping; never read from Mailgun's body. */
  readonly workspaceId: string;
  /** Server-trusted Mailgun connection mapping; never read from the body. */
  readonly providerConnectionId: string;
}

function bytes32(value: Uint8Array, label: string): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    throw new TypeError(`${label} must contain exactly 32 bytes`);
  }
  return Buffer.from(value);
}

function validateRecordInput(input: Readonly<MailgunWebhookRecordInput>): void {
  if (!EVENT_ID.test(input.externalEventId)
      || !EVENT_TYPES.has(input.eventType)
      || !MESSAGE_ID.test(input.providerMessageId)
      || input.providerMessageId !== input.providerMessageId.trim()
      || !Number.isFinite(new Date(input.occurredAt).getTime())
      || !Number.isFinite(new Date(input.signatureTimestamp).getTime())
      || (input.failureSeverity !== null
        && input.failureSeverity !== 'temporary'
        && input.failureSeverity !== 'permanent')
      || (input.eventType === 'failed') !== (input.failureSeverity !== null)) {
    throw new TypeError('Mailgun webhook record input is invalid');
  }
  bytes32(input.payloadSha256, 'payloadSha256');
  bytes32(input.eventIdentitySha256, 'eventIdentitySha256');
  bytes32(input.signatureTokenSha256, 'signatureTokenSha256');
  bytes32(input.recipientIdentitySha256, 'recipientIdentitySha256');
}

function translateDatabaseError(error: unknown): never {
  if (error && typeof error === 'object') {
    const candidate = error as PgErrorLike;
    if (candidate.code === '22000' && candidate.message === 'mailgun event identity conflict') {
      throw new MailgunWebhookEventConflictError();
    }
    if (candidate.code === '22000'
        && candidate.message === 'mailgun signature token replay conflict') {
      throw new MailgunWebhookReplayError();
    }
    if (candidate.code === '23503'
        && candidate.message === 'mailgun event does not match an outbound delivery') {
      throw new MailgunWebhookUnmatchedDeliveryError();
    }
  }
  throw error;
}

export class PgMailgunWebhookRepository implements MailgunWebhookRepository {
  readonly #commandPool: Pick<Pool, 'connect'>;
  readonly #workspaceId: string;
  readonly #providerConnectionId: string;

  constructor(dependencies: Readonly<PgMailgunWebhookRepositoryDependencies>) {
    if (!UUID.test(dependencies.workspaceId) || !UUID.test(dependencies.providerConnectionId)) {
      throw new TypeError('Mailgun trusted route mapping must use canonical lowercase UUIDs');
    }
    this.#commandPool = dependencies.commandPool;
    this.#workspaceId = dependencies.workspaceId;
    this.#providerConnectionId = dependencies.providerConnectionId;
  }

  async record(
    input: Readonly<MailgunWebhookRecordInput>,
  ): Promise<Readonly<MailgunWebhookRepositoryRecordResult>> {
    validateRecordInput(input);
    const requestId = `mailgun:${createHash('sha256')
      .update(input.externalEventId, 'utf8').digest('hex').slice(0, 48)}`;
    try {
      return await withTransaction(
        this.#commandPool,
        { actorKind: 'webhook', workspaceId: this.#workspaceId, requestId },
        async (transaction) => {
          const result = await transaction.query<RecordRow>(
            `/* mailgun-webhook.record-evidence */
             SELECT replayed, delivery_status, suppression_recorded, opt_out_recorded
             FROM app_private.record_mailgun_webhook_event(
               $1, $2, $3, $4, $5::timestamptz, $6,
               $7, $8, $9, $10::timestamptz, $11, $12
             )`,
            [
              this.#workspaceId,
              this.#providerConnectionId,
              input.externalEventId,
              input.eventType,
              input.occurredAt,
              input.providerMessageId,
              bytes32(input.payloadSha256, 'payloadSha256'),
              bytes32(input.eventIdentitySha256, 'eventIdentitySha256'),
              bytes32(input.signatureTokenSha256, 'signatureTokenSha256'),
              input.signatureTimestamp,
              bytes32(input.recipientIdentitySha256, 'recipientIdentitySha256'),
              input.failureSeverity,
            ],
          );
          const row = result.rows[0];
          if (result.rows.length !== 1
              || typeof row?.replayed !== 'boolean'
              || (row.delivery_status !== null && !DELIVERY_STATUSES.has(row.delivery_status))
              || typeof row.suppression_recorded !== 'boolean'
              || typeof row.opt_out_recorded !== 'boolean') {
            throw new Error('Mailgun webhook recorder returned invalid canonical data');
          }
          return Object.freeze({
            replayed: row.replayed,
            effectiveDeliveryStatus: row.delivery_status as MailgunWebhookRepositoryRecordResult['effectiveDeliveryStatus'],
            suppressionRecorded: row.suppression_recorded,
            optOutRecorded: row.opt_out_recorded,
          });
        },
      );
    } catch (error) {
      translateDatabaseError(error);
    }
  }
}

export function createPgMailgunWebhookRepository(
  dependencies: Readonly<PgMailgunWebhookRepositoryDependencies>,
): MailgunWebhookRepository {
  return new PgMailgunWebhookRepository(dependencies);
}
