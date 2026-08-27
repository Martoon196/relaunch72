export const TEST_INBOX_WEBHOOK_PROVIDER_IDS = [
  'whatsapp_dark_simulator',
  'social_dm_dark_simulator',
] as const;

export type TestInboxWebhookProviderId =
  (typeof TEST_INBOX_WEBHOOK_PROVIDER_IDS)[number];

export interface TestInboxWebhookTrustedBinding {
  readonly workspaceId: string;
  readonly providerConnectionId: string;
  readonly providerId: TestInboxWebhookProviderId;
  readonly inboxId: string;
  readonly contactId: string;
  readonly contactPointId: string;
}

/** Facts produced only after the simulator-specific HMAC verifier succeeds. */
export interface VerifiedTestInboxWebhookRecordInput {
  readonly workspaceId: string;
  readonly providerConnectionId: string;
  readonly providerId: TestInboxWebhookProviderId;
  /** Exact command targets must match the repository's trusted constructor binding. */
  readonly inboxId: string;
  readonly contactId: string;
  readonly contactPointId: string;
  readonly externalEventId: string;
  readonly occurredAt: string;
  /** SHA-256 of the exact signed bytes. Raw bytes are not stored as receipt evidence. */
  readonly payloadSha256: Uint8Array;
  /** SHA-256 of the canonical authenticated event identity. */
  readonly eventIdentitySha256: Uint8Array;
  /** SHA-256 of the verified signature value; never the signature or HMAC secret. */
  readonly signatureSha256: Uint8Array;
  /** Irreversible hashes of the verified reserved test addresses. */
  readonly sourceIdentitySha256: Uint8Array;
  readonly destinationIdentitySha256: Uint8Array;
  /** Stored only as the immutable inbound message body, never in receipt/audit evidence. */
  readonly body: string;
}

export interface TestInboxWebhookRecordResult {
  readonly replayed: boolean;
  readonly conversationId: string;
  readonly messageId: string;
  readonly messageVersionId: string;
  readonly bodySha256: string;
}

export interface TestInboxWebhookRepository {
  record(
    input: Readonly<VerifiedTestInboxWebhookRecordInput>,
  ): Promise<Readonly<TestInboxWebhookRecordResult>>;
}

export class TestInboxWebhookEventConflictError extends Error {
  constructor() {
    super('Simulated inbound event was already recorded with conflicting evidence');
    this.name = 'TestInboxWebhookEventConflictError';
  }
}

export class TestInboxWebhookSignatureReplayError extends Error {
  constructor() {
    super('Simulated inbound signature was reused for different evidence');
    this.name = 'TestInboxWebhookSignatureReplayError';
  }
}

export class TestInboxWebhookBindingError extends Error {
  constructor() {
    super('Simulated inbound event does not match its TEST inbox binding');
    this.name = 'TestInboxWebhookBindingError';
  }
}
