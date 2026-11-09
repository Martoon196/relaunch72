import { createHash } from 'node:crypto';
import type { ProviderOperationContext } from '../providers/contracts.js';
import {
  SOCIAL_DM_DARK_PROVIDER_ID,
  SocialDmDarkContractError,
  assertSocialDmDarkContext,
  validateSocialDmDarkRequest,
  type SocialDmDarkAdapter,
  type SocialDmDarkRequest,
  type SocialDmDarkResult,
  type SocialDmNetwork,
} from './contracts.js';

const MESSAGE_REF = /^test-dm-message_[a-f0-9]{32}$/u;

export interface SocialDmDarkAudit {
  readonly action: 'simulate' | 'reconcile';
  readonly operationId: string;
  readonly network: SocialDmNetwork | null;
  readonly recipientSha256: string | null;
  readonly bodySha256: string | null;
  readonly testMessageRef: string;
  readonly providerOperationsCreated: 0;
  readonly externalMessageAttempted: false;
}

function references(context: ProviderOperationContext): Readonly<{ thread: string; message: string }> {
  const base = contextBindingSha256(context);
  return Object.freeze({
    thread: `test-dm-thread_${createHash('sha256').update(`thread\n${base}`, 'utf8').digest('hex').slice(0, 32)}`,
    message: `test-dm-message_${createHash('sha256').update(`message\n${base}`, 'utf8').digest('hex').slice(0, 32)}`,
  });
}

function contextBindingSha256(context: ProviderOperationContext): string {
  return createHash('sha256').update(JSON.stringify({
    workspaceId: context.workspaceId,
    connectionId: context.connectionId,
    providerId: context.providerId,
    operationId: context.operationId,
    idempotencyKey: context.idempotencyKey,
    correlationId: context.correlationId,
  }), 'utf8').digest('hex');
}

export class SimulatedSocialDmDarkAdapter implements SocialDmDarkAdapter {
  readonly providerId = SOCIAL_DM_DARK_PROVIDER_ID;
  readonly mode = 'simulated_test_only' as const;
  readonly #now: () => Date;
  readonly #audit: SocialDmDarkAudit[] = [];
  readonly #results = new Map<string, Readonly<{
    contextSha256: string;
    requestSha256: string;
    result: SocialDmDarkResult;
  }>>();

  constructor(options: Readonly<{ now?: () => Date }> = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  get audit(): readonly SocialDmDarkAudit[] {
    return Object.freeze(this.#audit.map((entry) => Object.freeze({ ...entry })));
  }

  async simulateMessage(
    context: ProviderOperationContext,
    request: SocialDmDarkRequest,
  ): Promise<SocialDmDarkResult> {
    const valid = validateSocialDmDarkRequest(context, request);
    const contextSha256 = contextBindingSha256(valid.context);
    const ref = references(valid.context);
    const requestSha256 = createHash('sha256').update(JSON.stringify({
      contextSha256,
      bodySha256: valid.bodySha256,
      evidenceSha256: valid.evidence.evidenceSha256,
      network: valid.network,
      recipientSha256: createHash('sha256').update(valid.recipient, 'utf8').digest('hex'),
      replyToMessageRef: valid.replyToMessageRef,
      threadRef: valid.threadRef,
    }), 'utf8').digest('hex');
    const existing = this.#results.get(valid.context.operationId);
    if (existing) {
      if (existing.contextSha256 !== contextSha256) {
        throw new SocialDmDarkContractError('operation id was reused with different test context');
      }
      if (existing.requestSha256 !== requestSha256) {
        throw new SocialDmDarkContractError('operation id was reused with different test input');
      }
      return existing.result;
    }
    const result = Object.freeze({
      mode: 'simulated_test_only' as const,
      status: 'simulated' as const,
      network: valid.network,
      testThreadRef: valid.threadRef ?? ref.thread,
      testMessageRef: ref.message,
      occurredAt: this.#now().toISOString(),
      providerOperationsCreated: 0 as const,
      externalMessageAttempted: false as const,
    });
    this.#results.set(valid.context.operationId, Object.freeze({ contextSha256, requestSha256, result }));
    this.#audit.push(Object.freeze({
      action: 'simulate',
      operationId: valid.context.operationId,
      network: valid.network,
      recipientSha256: createHash('sha256').update(valid.recipient, 'utf8').digest('hex'),
      bodySha256: valid.bodySha256,
      testMessageRef: ref.message,
      providerOperationsCreated: 0,
      externalMessageAttempted: false,
    }));
    return result;
  }

  async reconcileSimulation(
    context: ProviderOperationContext,
    testMessageRef: string,
  ): Promise<SocialDmDarkResult> {
    const exactContext = assertSocialDmDarkContext(context);
    const contextSha256 = contextBindingSha256(exactContext);
    const expected = references(exactContext).message;
    const stored = this.#results.get(exactContext.operationId);
    if (!stored || stored.contextSha256 !== contextSha256
        || typeof testMessageRef !== 'string' || !MESSAGE_REF.test(testMessageRef)
        || testMessageRef !== expected || stored.result.testMessageRef !== expected) {
      throw new SocialDmDarkContractError('social DM simulation reference is invalid');
    }
    if (!this.#audit.some((entry) => entry.action === 'reconcile' && entry.operationId === exactContext.operationId)) {
      this.#audit.push(Object.freeze({
        action: 'reconcile', operationId: exactContext.operationId, network: null,
        recipientSha256: null, bodySha256: null, testMessageRef,
        providerOperationsCreated: 0, externalMessageAttempted: false,
      }));
    }
    return stored.result;
  }
}
