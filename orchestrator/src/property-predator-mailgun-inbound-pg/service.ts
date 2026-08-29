import { createHash } from 'node:crypto';
import { verifyMailgunWebhookSignature } from '../mailgun-webhook-pg/signature.js';
import {
  decodePropertyPredatorMailgunInboundForm,
  parsePropertyPredatorMailgunInboundMessage,
} from './contracts.js';
import type {
  PropertyPredatorMailgunInboundIngressResult,
  PropertyPredatorMailgunInboundRepository,
} from './types.js';

export interface PropertyPredatorMailgunInboundIngressDependencies {
  readonly repository: PropertyPredatorMailgunInboundRepository;
  readonly signingKey: Uint8Array;
  readonly nowSeconds?: () => number;
}

function digest(value: Uint8Array | string): Buffer {
  return createHash('sha256').update(value).digest();
}

export class PropertyPredatorMailgunInboundIngressService {
  readonly #repository: PropertyPredatorMailgunInboundRepository;
  readonly #signingKey: Uint8Array;
  readonly #nowSeconds?: () => number;

  constructor(dependencies: Readonly<PropertyPredatorMailgunInboundIngressDependencies>) {
    this.#repository = dependencies.repository;
    this.#signingKey = dependencies.signingKey;
    this.#nowSeconds = dependencies.nowSeconds;
  }

  async handle(rawBody: Uint8Array): Promise<PropertyPredatorMailgunInboundIngressResult> {
    const decoded = decodePropertyPredatorMailgunInboundForm(rawBody);
    const verified = verifyMailgunWebhookSignature({
      fields: decoded.signature,
      signingKey: this.#signingKey,
      ...(this.#nowSeconds === undefined ? {} : { nowSeconds: this.#nowSeconds() }),
    });
    // No sender, recipient, subject, body or message header is trusted before
    // the exact Mailgun HMAC has passed.
    const message = parsePropertyPredatorMailgunInboundMessage(decoded);
    const senderIdentitySha256 = digest(message.normalizedSender);
    const recipientIdentitySha256 = digest(message.normalizedRecipient);
    const subjectSha256 = digest(message.subject);
    const bodySha256 = digest(message.bodyText);
    const eventIdentitySha256 = digest([
      message.correlationSha256,
      message.providerMessageId,
      senderIdentitySha256.toString('hex'),
      recipientIdentitySha256.toString('hex'),
      subjectSha256.toString('hex'),
      bodySha256.toString('hex'),
    ].join('\u001f'));
    const recorded = await this.#repository.record({
      ...message,
      occurredAt: new Date(verified.timestampSeconds * 1_000).toISOString(),
      payloadSha256: digest(rawBody),
      eventIdentitySha256,
      signatureTokenSha256: digest(decoded.signature.token),
      signatureTimestamp: new Date(verified.timestampSeconds * 1_000).toISOString(),
      senderIdentitySha256,
      recipientIdentitySha256,
      subjectSha256,
      bodySha256,
    });
    return Object.freeze({ disposition: 'recorded', ...recorded });
  }
}
