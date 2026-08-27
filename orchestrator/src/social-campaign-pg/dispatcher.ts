import {
  type PublicSocialTestDispatchCycleResult,
  type PublicSocialTestLeaseIdentity,
  type PublicSocialTestProvider,
  type PublicSocialTestProviderContext,
  type PublicSocialTestProviderRequest,
  type PublicSocialTestProviderResult,
  type PublicSocialTestQueue,
} from './types.js';

/** Serial, one-claim dispatcher. A process runner owns polling and shutdown. */
export class PublicSocialTestDispatcher {
  readonly #now: () => Date;

  constructor(private readonly dependencies: Readonly<{
    queue: PublicSocialTestQueue;
    provider: PublicSocialTestProvider;
    now?: () => Date;
  }>) {
    this.#now = dependencies.now ?? (() => new Date());
  }

  async runOnce(lease: PublicSocialTestLeaseIdentity): Promise<PublicSocialTestDispatchCycleResult> {
    const claims = await this.dependencies.queue.claim(lease, { batchSize: 1 });
    const claim = claims[0];
    if (!claim) return Object.freeze({ disposition: 'idle', operationId: null, state: null });

    const context: PublicSocialTestProviderContext = Object.freeze({
      workspaceId: claim.workspaceId,
      connectionId: claim.connectionId,
      operationId: claim.operationId,
      correlationId: claim.correlationId,
      idempotencyKey: claim.idempotencyKey,
    });

    let request: PublicSocialTestProviderRequest | null = null;
    if (claim.attemptKind === 'simulation') {
      const payload = await this.dependencies.queue.load(claim, lease);
      request = Object.freeze({
        targetId: payload.targetId,
        network: payload.network,
        testAccountRef: payload.testAccountRef,
        text: payload.text,
        bodySha256: payload.bodySha256,
        planSha256: payload.planSha256,
        contentVersionId: payload.contentVersionId,
        contentSha256: payload.contentSha256,
        media: payload.media,
      });
    }

    // This committed state is the ambiguity boundary, even for the no-network
    // provider. Keeping the same boundary makes a future adapter unable to gain
    // unsafe retry semantics through a composition-only change.
    await this.dependencies.queue.markCalling(claim, lease);

    let result: PublicSocialTestProviderResult;
    try {
      result = claim.attemptKind === 'simulation'
        ? await this.dependencies.provider.simulate(context, request!)
        : await this.dependencies.provider.reconcile(context, claim.testReference);
    } catch {
      const instant = this.#now();
      const occurredAt = instant instanceof Date && Number.isFinite(Date.prototype.getTime.call(instant))
        ? new Date(Date.prototype.getTime.call(instant)).toISOString()
        : '1970-01-01T00:00:00.000Z';
      result = Object.freeze({
        status: 'needs_attention',
        testReference: claim.testReference,
        occurredAt,
        retryable: false,
        errorCode: 'ambiguous_test_provider_exception',
        summary: 'TEST provider outcome could not be determined',
        externalPublishAttempted: false,
      });
    }

    const settled = claim.attemptKind === 'reconcile' && result.status === 'succeeded'
      ? await this.dependencies.queue.reconcile(claim, lease, result)
      : await this.dependencies.queue.settle(claim, lease, result);
    return Object.freeze({
      disposition: 'settled',
      operationId: claim.operationId,
      state: settled.state,
    });
  }
}
