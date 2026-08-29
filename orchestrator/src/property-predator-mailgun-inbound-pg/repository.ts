import { createHash } from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';
import { withTransaction } from '../db/transaction.js';
import { propertyPredatorMailgunReplyToken } from '../providers/property-predator-mailgun-reply-correlation.js';
import {
  PROPERTY_PREDATOR_MAILGUN_REPLY_DOMAIN,
  PROPERTY_PREDATOR_OWNED_OFFICE_EMAIL,
  PropertyPredatorMailgunInboundConflictError,
  PropertyPredatorMailgunInboundUnmatchedError,
  type PropertyPredatorMailgunInboundRecordInput,
  type PropertyPredatorMailgunInboundRecordResult,
  type PropertyPredatorMailgunInboundRepository,
} from './types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MESSAGE_ID = /^[^\u0000-\u001f\u007f<>]{1,498}$/u;
const REPLY_ADDRESS = /^reply\+([a-z2-7]{52})@mg[.]propertypredator[.]com$/;

interface RecordRow extends QueryResultRow {
  replayed: boolean;
  conversation_id: string;
  message_id: string;
  message_version_id: string;
  admin_call_task_id: string;
}

interface PgErrorLike { readonly code?: unknown; readonly message?: unknown }

export interface PgPropertyPredatorMailgunInboundRepositoryDependencies {
  readonly commandPool: Pick<Pool, 'connect'>;
  readonly workspaceId: string;
  readonly providerConnectionId: string;
}

function bytes32(value: Uint8Array, label: string): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    throw new TypeError(`${label} must contain exactly 32 bytes`);
  }
  return Buffer.from(value);
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function validate(input: Readonly<PropertyPredatorMailgunInboundRecordInput>): void {
  const recipient = REPLY_ADDRESS.exec(input.normalizedRecipient);
  if (!SHA256.test(input.correlationSha256)
      || recipient?.[1] !== propertyPredatorMailgunReplyToken(input.correlationSha256)
      || input.normalizedSender !== PROPERTY_PREDATOR_OWNED_OFFICE_EMAIL
      || !input.normalizedRecipient.endsWith(`@${PROPERTY_PREDATOR_MAILGUN_REPLY_DOMAIN}`)
      || !MESSAGE_ID.test(input.providerMessageId)
      || !Number.isFinite(new Date(input.occurredAt).getTime())
      || !Number.isFinite(new Date(input.signatureTimestamp).getTime())
      || !input.subject || Buffer.byteLength(input.subject, 'utf8') > 500
      || !input.bodyText || Buffer.byteLength(input.bodyText, 'utf8') > 64 * 1024) {
    throw new TypeError('Mailgun inbound record input is invalid');
  }
  bytes32(input.payloadSha256, 'payloadSha256');
  bytes32(input.eventIdentitySha256, 'eventIdentitySha256');
  bytes32(input.signatureTokenSha256, 'signatureTokenSha256');
  bytes32(input.senderIdentitySha256, 'senderIdentitySha256');
  bytes32(input.recipientIdentitySha256, 'recipientIdentitySha256');
  bytes32(input.subjectSha256, 'subjectSha256');
  bytes32(input.bodySha256, 'bodySha256');
}

function translate(error: unknown): never {
  if (error && typeof error === 'object') {
    const pg = error as PgErrorLike;
    if (pg.code === '23503' && pg.message === 'owned-seed inbound reply is unmatched') {
      throw new PropertyPredatorMailgunInboundUnmatchedError();
    }
    if (pg.code === '22000' && pg.message === 'owned-seed inbound reply evidence conflicts') {
      throw new PropertyPredatorMailgunInboundConflictError();
    }
  }
  throw error;
}

export class PgPropertyPredatorMailgunInboundRepository
implements PropertyPredatorMailgunInboundRepository {
  readonly #commandPool: Pick<Pool, 'connect'>;
  readonly #workspaceId: string;
  readonly #providerConnectionId: string;

  constructor(dependencies: Readonly<PgPropertyPredatorMailgunInboundRepositoryDependencies>) {
    this.#commandPool = dependencies.commandPool;
    this.#workspaceId = uuid(dependencies.workspaceId, 'workspaceId');
    this.#providerConnectionId = uuid(dependencies.providerConnectionId, 'providerConnectionId');
  }

  async record(
    input: Readonly<PropertyPredatorMailgunInboundRecordInput>,
  ): Promise<Readonly<PropertyPredatorMailgunInboundRecordResult>> {
    validate(input);
    const requestId = `mailgun-in:${createHash('sha256')
      .update(input.providerMessageId, 'utf8').digest('hex').slice(0, 48)}`;
    try {
      return await withTransaction(
        this.#commandPool,
        { actorKind: 'webhook', workspaceId: this.#workspaceId, requestId },
        async (transaction) => {
          const result = await transaction.query<RecordRow>(
            `/* property-predator-mailgun-inbound.record */
             SELECT replayed, conversation_id, message_id,
                    message_version_id, admin_call_task_id
             FROM app_private.record_property_predator_owned_seed_mailgun_inbound(
               $1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz,
               $10, $11, $12, $13::timestamptz, $14, $15, $16, $17
             )`,
            [
              this.#workspaceId, this.#providerConnectionId,
              input.correlationSha256, input.providerMessageId,
              input.normalizedSender, input.normalizedRecipient,
              input.subject, input.bodyText, input.occurredAt,
              bytes32(input.payloadSha256, 'payloadSha256'),
              bytes32(input.eventIdentitySha256, 'eventIdentitySha256'),
              bytes32(input.signatureTokenSha256, 'signatureTokenSha256'),
              input.signatureTimestamp,
              bytes32(input.senderIdentitySha256, 'senderIdentitySha256'),
              bytes32(input.recipientIdentitySha256, 'recipientIdentitySha256'),
              bytes32(input.subjectSha256, 'subjectSha256'),
              bytes32(input.bodySha256, 'bodySha256'),
            ],
          );
          const row = result.rows[0];
          if (result.rows.length !== 1 || !row || typeof row.replayed !== 'boolean') {
            throw new Error('Mailgun inbound recorder returned invalid canonical data');
          }
          return Object.freeze({
            replayed: row.replayed,
            conversationId: uuid(row.conversation_id, 'conversationId'),
            messageId: uuid(row.message_id, 'messageId'),
            messageVersionId: uuid(row.message_version_id, 'messageVersionId'),
            adminCallTaskId: uuid(row.admin_call_task_id, 'adminCallTaskId'),
          });
        },
      );
    } catch (error) {
      translate(error);
    }
  }
}
