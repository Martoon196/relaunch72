import { createHash } from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';
import { withTransaction } from '../db/transaction.js';
import type {
  MetaWhatsAppLiveWebhookCommandService,
  VerifiedMetaWhatsAppLiveEvent,
} from '../whatsapp-live/index.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MESSAGE_ID = /^wamid\.[A-Za-z0-9_=-]{1,190}$/u;
const EVENT_ID = /^[\x21-\x7e]{1,500}$/u;
const OUTCOME = new Set(['applied', 'replayed', 'conflict']);
type WebhookOutcome = 'applied' | 'replayed' | 'conflict';

interface OutcomeRow extends QueryResultRow { outcome: unknown }

function uuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new Error(`Meta WhatsApp webhook ${label} is invalid`);
  }
  return value;
}

function digest(value: unknown, label: string): Buffer {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new Error(`Meta WhatsApp webhook ${label} is invalid`);
  }
  return Buffer.from(value, 'hex');
}

function eventIdentity(event: VerifiedMetaWhatsAppLiveEvent): void {
  if (!EVENT_ID.test(event.externalEventId) || !MESSAGE_ID.test(event.providerMessageId)
      || !Number.isFinite(Date.parse(event.occurredAt))
      || new Date(event.occurredAt).toISOString() !== event.occurredAt) {
    throw new Error('Meta WhatsApp webhook event identity is invalid');
  }
}

function outcome(result: { rows: OutcomeRow[] }): WebhookOutcome {
  const value = result.rows[0]?.outcome;
  if (result.rows.length !== 1 || typeof value !== 'string' || !OUTCOME.has(value)) {
    throw new Error('Meta WhatsApp webhook recorder returned an invalid outcome');
  }
  return value as WebhookOutcome;
}

export interface PgMetaWhatsAppLiveWebhookCommandServiceDependencies {
  readonly commandPool: Pick<Pool, 'connect'>;
  readonly workspaceId: string;
  readonly connectionId: string;
  readonly bindingId: string;
}

export class PgMetaWhatsAppLiveWebhookCommandService
implements MetaWhatsAppLiveWebhookCommandService {
  readonly workspaceId: string;
  readonly connectionId: string;
  readonly #bindingId: string;
  readonly #commandPool: Pick<Pool, 'connect'>;

  constructor(dependencies: PgMetaWhatsAppLiveWebhookCommandServiceDependencies) {
    this.workspaceId = uuid(dependencies.workspaceId, 'workspace binding');
    this.connectionId = uuid(dependencies.connectionId, 'connection binding');
    this.#bindingId = uuid(dependencies.bindingId, 'credential binding');
    this.#commandPool = dependencies.commandPool;
  }

  async recordStatus(input: Readonly<{
    event: Extract<VerifiedMetaWhatsAppLiveEvent, { kind: 'status' }>;
    payloadSha256: string;
  }>): Promise<WebhookOutcome> {
    const event = input.event;
    this.#assertBound(event);
    const payloadSha256 = digest(input.payloadSha256, 'payload digest');
    const recipientSha256 = digest(event.recipientSha256, 'recipient digest');
    return withTransaction(this.#commandPool, {
      actorKind: 'webhook', workspaceId: this.workspaceId,
      requestId: this.#requestId(event.externalEventId),
    }, async (transaction) => outcome(await transaction.query<OutcomeRow>(
      `/* meta-whatsapp-live-webhook.record-status */
       SELECT app_private.record_whatsapp_live_status(
         $1::uuid, $2::uuid, $3::text, $4::text, $5::bytea, $6::text,
         $7::bytea, $8::timestamptz
       ) AS outcome`,
      [this.workspaceId, this.#bindingId, event.externalEventId,
        event.providerMessageId, recipientSha256, event.status,
        payloadSha256, event.occurredAt],
    )), { isolation: 'serializable' });
  }

  async recordInbound(input: Readonly<{
    event: Extract<VerifiedMetaWhatsAppLiveEvent, { kind: 'inbound' }>;
    payloadSha256: string;
    projection: 'conversion_inbox_and_lead360';
  }>): Promise<WebhookOutcome> {
    const event = input.event;
    this.#assertBound(event);
    if (input.projection !== 'conversion_inbox_and_lead360'
        || createHash('sha256').update(event.senderId).digest('hex') !== event.senderSha256
        || createHash('sha256').update(event.body).digest('hex') !== event.bodySha256) {
      throw new Error('Meta WhatsApp inbound projection evidence is invalid');
    }
    const payloadSha256 = digest(input.payloadSha256, 'payload digest');
    const senderSha256 = digest(event.senderSha256, 'sender digest');
    const bodySha256 = digest(event.bodySha256, 'body digest');
    return withTransaction(this.#commandPool, {
      actorKind: 'webhook', workspaceId: this.workspaceId,
      requestId: this.#requestId(event.externalEventId),
    }, async (transaction) => outcome(await transaction.query<OutcomeRow>(
      `/* meta-whatsapp-live-webhook.record-inbound-receipt */
       SELECT app_private.record_whatsapp_live_inbound_receipt(
         $1::uuid, $2::uuid, $3::text, $4::text, $5::bytea, $6::bytea,
         $7::bytea, $8::timestamptz
       ) AS outcome`,
      [this.workspaceId, this.#bindingId, event.externalEventId,
        event.providerMessageId, senderSha256, bodySha256,
        payloadSha256, event.occurredAt],
    )), { isolation: 'serializable' });
  }

  #assertBound(event: VerifiedMetaWhatsAppLiveEvent): void {
    eventIdentity(event);
    if (event.workspaceId !== this.workspaceId || event.connectionId !== this.connectionId) {
      throw new Error('Meta WhatsApp webhook event crossed its trusted binding');
    }
  }

  #requestId(externalEventId: string): string {
    return `meta-wa:${createHash('sha256').update(externalEventId).digest('hex').slice(0, 48)}`;
  }
}
