/**
 * Webhook-role recorder for authenticated Twilio callbacks. Status receipts
 * and inbound projections run serializably under the webhook GUC context;
 * dispositions are constrained to applied/replayed/conflict(/not_applicable)
 * and every hash is re-derived client-side before the SQL boundary.
 */

import { createHash } from 'node:crypto';
import { withTransaction } from '../db/transaction.js';
import {
  type VerifiedTwilioSmsInboundEvent,
  type VerifiedTwilioSmsStatusEvent,
} from '../sms-live/foundation.js';
import type { TwilioSmsWebhookRepositoryDependencies } from './types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const STATUS_OUTCOMES = new Set(['applied', 'replayed', 'conflict', 'not_applicable']);
const INBOUND_OUTCOMES = new Set(['applied', 'replayed', 'conflict']);

type StatusOutcome = 'applied' | 'replayed' | 'conflict' | 'not_applicable';
type InboundOutcome = 'applied' | 'replayed' | 'conflict';

interface OutcomeRow extends Record<string, unknown> {
  outcome: unknown;
}

function fail(message: string): never {
  throw new Error(`Twilio SMS webhook recorder ${message}`);
}

function outcomeOf(rows: readonly OutcomeRow[], allowed: ReadonlySet<string>): string {
  const value = rows[0]?.outcome;
  if (rows.length !== 1 || typeof value !== 'string' || !allowed.has(value)) {
    fail('returned an invalid outcome');
  }
  return value;
}

export class PgTwilioSmsWebhookRepository {
  readonly #commandPool: TwilioSmsWebhookRepositoryDependencies['commandPool'];
  readonly workspaceId: string;
  readonly connectionId: string;

  constructor(dependencies: TwilioSmsWebhookRepositoryDependencies) {
    if (!UUID.test(dependencies.workspaceId) || !UUID.test(dependencies.providerConnectionId)) {
      fail('binding is invalid');
    }
    this.#commandPool = dependencies.commandPool;
    this.workspaceId = dependencies.workspaceId;
    this.connectionId = dependencies.providerConnectionId;
  }

  async recordStatus(input: Readonly<{
    event: VerifiedTwilioSmsStatusEvent;
    payloadSha256: string;
    occurredAt: string;
  }>): Promise<StatusOutcome> {
    if (input.event.kind !== 'status' || !SHA256.test(input.payloadSha256)
        || !Number.isFinite(Date.parse(input.occurredAt))) {
      fail('status evidence is invalid');
    }
    const rows = await withTransaction(this.#commandPool, {
      actorKind: 'webhook',
      workspaceId: this.workspaceId,
      requestId: this.#requestId(input.event.externalEventId),
    }, async (transaction) => (await transaction.query<OutcomeRow>(
      `/* twilio-sms-live-webhook.record-status */
       SELECT app_private.record_sms_live_status_receipt(
         $1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::text,
         decode($7, 'hex'), $8::timestamptz
       ) AS outcome`,
      [this.workspaceId, this.connectionId, input.event.externalEventId,
        input.event.providerMessageId, input.event.status, input.event.errorCode,
        input.payloadSha256, input.occurredAt],
    )).rows, { isolation: 'serializable' });
    return outcomeOf(rows, STATUS_OUTCOMES) as StatusOutcome;
  }

  async recordInbound(input: Readonly<{
    event: VerifiedTwilioSmsInboundEvent;
    payloadSha256: string;
    signatureSha256: string;
    occurredAt: string;
    projection: 'conversion_inbox_and_lead360';
  }>): Promise<InboundOutcome> {
    const event = input.event;
    if (event.kind !== 'inbound'
        || input.projection !== 'conversion_inbox_and_lead360'
        || !SHA256.test(input.payloadSha256) || !SHA256.test(input.signatureSha256)
        || !Number.isFinite(Date.parse(input.occurredAt))
        || createHash('sha256').update(event.normalizedSender, 'utf8').digest('hex')
          !== event.senderSha256
        || createHash('sha256').update(event.body, 'utf8').digest('hex') !== event.bodySha256) {
      fail('inbound projection evidence is invalid');
    }
    const eventIdentitySha256 = createHash('sha256').update([
      event.externalEventId,
      event.providerMessageId,
      event.senderSha256,
      event.bodySha256,
      input.payloadSha256,
      input.signatureSha256,
    ].join('\u001f')).digest();
    const rows = await withTransaction(this.#commandPool, {
      actorKind: 'webhook',
      workspaceId: this.workspaceId,
      requestId: this.#requestId(event.externalEventId),
    }, async (transaction) => (await transaction.query<OutcomeRow>(
      `/* twilio-sms-live-webhook.record-inbound-projection */
       SELECT projection.disposition AS outcome
       FROM app_private.record_sms_live_inbound_projection(
         $1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::text, $7::text,
         decode($8, 'hex'), decode($9, 'hex'), decode($10, 'hex'),
         decode($11, 'hex'), $12::bytea, $13::timestamptz
       ) AS projection`,
      [this.workspaceId, this.connectionId, event.externalEventId,
        event.providerMessageId, event.normalizedSender,
        event.optEvidence ?? '', event.body,
        event.senderSha256, event.bodySha256, input.payloadSha256,
        input.signatureSha256, eventIdentitySha256, input.occurredAt],
    )).rows, { isolation: 'serializable' });
    return outcomeOf(rows, INBOUND_OUTCOMES) as InboundOutcome;
  }

  #requestId(externalEventId: string): string {
    return `twilio-sms:${createHash('sha256')
      .update(externalEventId, 'utf8').digest('hex').slice(0, 48)}`;
  }
}
