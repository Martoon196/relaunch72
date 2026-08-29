export const PROPERTY_PREDATOR_MAILGUN_INBOUND_MAX_BODY_BYTES = 128 * 1024;
export const PROPERTY_PREDATOR_MAILGUN_INBOUND_MAX_MESSAGE_BYTES = 64 * 1024;
export const PROPERTY_PREDATOR_OWNED_OFFICE_EMAIL = 'office@propertypredator.com' as const;
export const PROPERTY_PREDATOR_MAILGUN_REPLY_DOMAIN = 'mg.propertypredator.com' as const;

export interface PropertyPredatorMailgunInboundRecordInput {
  readonly correlationSha256: string;
  readonly providerMessageId: string;
  readonly normalizedSender: typeof PROPERTY_PREDATOR_OWNED_OFFICE_EMAIL;
  readonly normalizedRecipient: string;
  readonly subject: string;
  readonly bodyText: string;
  readonly occurredAt: string;
  readonly payloadSha256: Uint8Array;
  readonly eventIdentitySha256: Uint8Array;
  readonly signatureTokenSha256: Uint8Array;
  readonly signatureTimestamp: string;
  readonly senderIdentitySha256: Uint8Array;
  readonly recipientIdentitySha256: Uint8Array;
  readonly subjectSha256: Uint8Array;
  readonly bodySha256: Uint8Array;
}

export interface PropertyPredatorMailgunInboundRecordResult {
  readonly replayed: boolean;
  readonly conversationId: string;
  readonly messageId: string;
  readonly messageVersionId: string;
  readonly adminCallTaskId: string;
}

export interface PropertyPredatorMailgunInboundRepository {
  record(
    input: Readonly<PropertyPredatorMailgunInboundRecordInput>,
  ): Promise<Readonly<PropertyPredatorMailgunInboundRecordResult>>;
}

export interface PropertyPredatorMailgunInboundIngressResult
  extends PropertyPredatorMailgunInboundRecordResult {
  readonly disposition: 'recorded';
}

export class PropertyPredatorMailgunInboundBodyTooLargeError extends Error {
  constructor() {
    super('Mailgun inbound payload exceeds the owned-seed boundary');
    this.name = 'PropertyPredatorMailgunInboundBodyTooLargeError';
  }
}

export class PropertyPredatorMailgunInboundContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PropertyPredatorMailgunInboundContractError';
  }
}

export class PropertyPredatorMailgunInboundUnmatchedError extends Error {
  constructor() {
    super('Mailgun inbound reply did not match the owned-seed proof');
    this.name = 'PropertyPredatorMailgunInboundUnmatchedError';
  }
}

export class PropertyPredatorMailgunInboundConflictError extends Error {
  constructor() {
    super('Mailgun inbound reply conflicts with previously recorded evidence');
    this.name = 'PropertyPredatorMailgunInboundConflictError';
  }
}
