import { createHash } from 'node:crypto';
import type {
  ConversationMessageRequest,
  ConversationProvider,
  ProviderOperationContext,
  ProviderOperationResult,
} from '../providers/contracts.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TEST_EMAIL = /^[^\s@]+@[^\s@]+[.]invalid$/i;
const TEST_PHONE = /^[+]447700900[0-9]{3}$/;
const TEST_SOCIAL = /^test:[a-z0-9_.-]{1,100}$/;
const TEST_REFERENCE = /^testmsg_[a-f0-9]{24}$/;

export interface TestConversationCallAudit {
  readonly operationId: string;
  readonly mode: 'send' | 'reconcile';
  readonly channel: ConversationMessageRequest['channel'] | null;
  readonly recipientSha256: string | null;
  readonly bodySha256: string | null;
  readonly providerReference: string;
}

function testReference(operationId: string): string {
  return `testmsg_${createHash('sha256').update(operationId, 'utf8').digest('hex').slice(0, 24)}`;
}

function assertContext(context: ProviderOperationContext): void {
  if (context.providerId !== 'test_conversation'
      || !UUID.test(context.workspaceId)
      || !UUID.test(context.connectionId)
      || !UUID.test(context.operationId)
      || !UUID.test(context.correlationId)) {
    throw new Error('TestConversationProvider requires canonical test operation context');
  }
}
function assertReservedRecipient(request: ConversationMessageRequest): void {
  const allowed = request.channel === 'email'
    ? TEST_EMAIL.test(request.recipient)
    : request.channel === 'sms' || request.channel === 'whatsapp'
      ? TEST_PHONE.test(request.recipient)
      : TEST_SOCIAL.test(request.recipient);
  if (!allowed) {
    throw new Error('TestConversationProvider only accepts reserved non-routable recipients');
  }
  if (Buffer.byteLength(request.text, 'utf8') < 1
      || Buffer.byteLength(request.text, 'utf8') > 65_536
      || !UUID.test(request.consentRecordId)) {
    throw new Error('TestConversationProvider request is invalid');
  }
}

/**
 * An in-process provider for acceptance tests. It imports no network client,
 * stores only digests in its audit trail and refuses routable destinations.
 */
export class TestConversationProvider implements ConversationProvider {
  readonly #calls: TestConversationCallAudit[] = [];
  readonly #now: () => Date;

  constructor(options: Readonly<{ now?: () => Date }> = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  get audit(): readonly TestConversationCallAudit[] {
    return Object.freeze([...this.#calls]);
  }

  async sendMessage(
    context: ProviderOperationContext,
    request: ConversationMessageRequest,
  ): Promise<ProviderOperationResult> {
    assertContext(context);
    assertReservedRecipient(request);
    const externalId = testReference(context.operationId);
    this.#calls.push(Object.freeze({
      operationId: context.operationId,
      mode: 'send',
      channel: request.channel,
      recipientSha256: createHash('sha256').update(request.recipient, 'utf8').digest('hex'),
      bodySha256: createHash('sha256').update(request.text, 'utf8').digest('hex'),
      providerReference: externalId,
    }));
    return Object.freeze({
      status: 'succeeded',
      externalId,
      occurredAt: this.#now().toISOString(),
      retryable: false,
      errorCode: null,
      summary: 'Reserved test message accepted',
    });
  }

  async reconcile(
    context: ProviderOperationContext,
    externalId: string,
  ): Promise<ProviderOperationResult> {
    assertContext(context);
    if (!TEST_REFERENCE.test(externalId)
        || externalId !== testReference(context.operationId)) {
      throw new Error('TestConversationProvider reconciliation reference is invalid');
    }
    this.#calls.push(Object.freeze({
      operationId: context.operationId,
      mode: 'reconcile',
      channel: null,
      recipientSha256: null,
      bodySha256: null,
      providerReference: externalId,
    }));
    return Object.freeze({
      status: 'succeeded', externalId,
      occurredAt: this.#now().toISOString(), retryable: false,
      errorCode: null, summary: 'Reserved test message reconciled',
    });
  }
}
