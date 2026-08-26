export const MAILGUN_WEBHOOK_EVENT_TYPES = [
  'accepted',
  'delivered',
  'opened',
  'clicked',
  'failed',
  'complained',
  'unsubscribed',
] as const;

export type MailgunWebhookEventType = (typeof MAILGUN_WEBHOOK_EVENT_TYPES)[number];
export type MailgunFailureSeverity = 'temporary' | 'permanent';

export interface MailgunWebhookSignatureFields {
  /** Exact, untrimmed Unix-seconds string supplied by Mailgun. */
  readonly timestamp: string;
  /** Exact, untrimmed nonce supplied by Mailgun. It must never be logged. */
  readonly token: string;
  /** Exact, lowercase hexadecimal HMAC supplied by Mailgun. */
  readonly signature: string;
}

export interface ParsedMailgunWebhookEvent {
  readonly externalEventId: string;
  readonly eventType: MailgunWebhookEventType;
  readonly occurredAt: string;
  readonly providerMessageId: string;
  /** Canonical lowercase mailbox used only to derive an irreversible digest. */
  readonly normalizedRecipient: string;
  readonly failureSeverity: MailgunFailureSeverity | null;
}

export interface VerifiedMailgunWebhookSignature {
  readonly timestampSeconds: number;
  readonly signatureVersion: 'mailgun-hmac-sha256-v1';
}

export interface MailgunWebhookRecordInput {
  readonly externalEventId: string;
  readonly eventType: MailgunWebhookEventType;
  readonly occurredAt: string;
  readonly providerMessageId: string;
  readonly failureSeverity: MailgunFailureSeverity | null;
  readonly payloadSha256: Uint8Array;
  readonly eventIdentitySha256: Uint8Array;
  readonly signatureTokenSha256: Uint8Array;
  readonly signatureTimestamp: string;
  readonly recipientIdentitySha256: Uint8Array;
}

export interface MailgunWebhookRepositoryRecordResult {
  readonly replayed: boolean;
  readonly effectiveDeliveryStatus: 'accepted' | 'delivered' | 'read' | 'failed' | null;
  readonly suppressionRecorded: boolean;
  readonly optOutRecorded: boolean;
}

export interface MailgunWebhookRepository {
  record(
    input: Readonly<MailgunWebhookRecordInput>,
  ): Promise<Readonly<MailgunWebhookRepositoryRecordResult>>;
}

export interface MailgunWebhookIngressResult {
  readonly disposition: 'recorded';
  readonly replayed: boolean;
  readonly eventType: MailgunWebhookEventType;
  readonly effectiveDeliveryStatus: 'accepted' | 'delivered' | 'read' | 'failed' | null;
  readonly suppressionRecorded: boolean;
  readonly optOutRecorded: boolean;
}

export class MailgunWebhookAuthenticationError extends Error {
  constructor() {
    super('Mailgun webhook authentication failed');
    this.name = 'MailgunWebhookAuthenticationError';
  }
}

export class MailgunWebhookConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MailgunWebhookConfigurationError';
  }
}

export class MailgunWebhookBodyTooLargeError extends Error {
  constructor() {
    super('Mailgun webhook body exceeds the configured byte limit');
    this.name = 'MailgunWebhookBodyTooLargeError';
  }
}

export class MailgunWebhookContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MailgunWebhookContractError';
  }
}

export class MailgunWebhookEventConflictError extends Error {
  constructor() {
    super('Mailgun event identity was already recorded with conflicting evidence');
    this.name = 'MailgunWebhookEventConflictError';
  }
}

export class MailgunWebhookReplayError extends Error {
  constructor() {
    super('Mailgun signature token was replayed for different evidence');
    this.name = 'MailgunWebhookReplayError';
  }
}

export class MailgunWebhookUnmatchedDeliveryError extends Error {
  constructor() {
    super('Mailgun event did not match an authenticated outbound delivery');
    this.name = 'MailgunWebhookUnmatchedDeliveryError';
  }
}
