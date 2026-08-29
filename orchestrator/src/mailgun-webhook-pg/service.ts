import { createHash } from 'node:crypto';
import { decodeMailgunWebhookEnvelope, parseMailgunWebhookEventData } from './contracts.js';
import { verifyMailgunWebhookSignature } from './signature.js';
import type {
  MailgunWebhookIngressResult,
  MailgunWebhookRepository,
} from './types.js';

export interface MailgunWebhookIngressServiceDependencies {
  readonly repository: MailgunWebhookRepository;
  /**
   * Optional receipt-only projector. It runs only after signature verification
   * and the generic Mailgun event journal have both succeeded. A failure is
   * deliberately propagated so Mailgun retries instead of losing live-channel
   * receipt evidence.
   */
  readonly signedReceiptProjector?: Readonly<{
    recordSignedReceipt(externalEventId: string): Promise<unknown>;
  }>;
  /** Dedicated Mailgun signing key from a server-side secret manager. */
  readonly signingKey: Uint8Array;
  /** Injectable clock for deterministic verification tests. */
  readonly nowSeconds?: () => number;
}

function digest(value: Uint8Array | string): Buffer {
  return createHash('sha256').update(value).digest();
}

export class MailgunWebhookIngressService {
  readonly #repository: MailgunWebhookRepository;
  readonly #signingKey: Uint8Array;
  readonly #nowSeconds?: () => number;
  readonly #signedReceiptProjector?: Readonly<{
    recordSignedReceipt(externalEventId: string): Promise<unknown>;
  }>;

  constructor(dependencies: Readonly<MailgunWebhookIngressServiceDependencies>) {
    this.#repository = dependencies.repository;
    this.#signingKey = dependencies.signingKey;
    this.#nowSeconds = dependencies.nowSeconds;
    this.#signedReceiptProjector = dependencies.signedReceiptProjector;
  }

  async handle(rawBody: Uint8Array): Promise<Readonly<MailgunWebhookIngressResult>> {
    const envelope = decodeMailgunWebhookEnvelope(rawBody);
    const verified = verifyMailgunWebhookSignature({
      fields: envelope.signature,
      signingKey: this.#signingKey,
      ...(this.#nowSeconds === undefined ? {} : { nowSeconds: this.#nowSeconds() }),
    });
    // Authentication is complete before any event mapping or durable write.
    const event = parseMailgunWebhookEventData(envelope.eventData);
    const recipientIdentitySha256 = digest(event.normalizedRecipient);
    const eventIdentitySha256 = digest(JSON.stringify([
      event.externalEventId,
      event.eventType,
      event.occurredAt,
      event.providerMessageId,
      recipientIdentitySha256.toString('hex'),
      event.failureSeverity,
    ]));
    const recorded = await this.#repository.record({
      externalEventId: event.externalEventId,
      eventType: event.eventType,
      occurredAt: event.occurredAt,
      providerMessageId: event.providerMessageId,
      failureSeverity: event.failureSeverity,
      payloadSha256: digest(rawBody),
      eventIdentitySha256,
      signatureTokenSha256: digest(envelope.signature.token),
      signatureTimestamp: new Date(verified.timestampSeconds * 1_000).toISOString(),
      recipientIdentitySha256,
    });
    await this.#signedReceiptProjector?.recordSignedReceipt(event.externalEventId);
    return Object.freeze({
      disposition: 'recorded',
      replayed: recorded.replayed,
      eventType: event.eventType,
      effectiveDeliveryStatus: recorded.effectiveDeliveryStatus,
      suppressionRecorded: recorded.suppressionRecorded,
      optOutRecorded: recorded.optOutRecorded,
    });
  }
}
