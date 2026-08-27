import { randomUUID } from 'node:crypto';
import type {
  PgPublicSocialRevalidationQueue,
  PublicSocialRevalidationClaim,
  PublicSocialRevalidationLease,
} from './queue.js';
import type { PgPropertyPredatorJitSourceAttestor } from './source-attestor.js';

export type PublicSocialRevalidationCycleResult = Readonly<
  | { disposition: 'idle'; jobId: null; postId: null; state: null }
  | {
    disposition: 'materialized';
    jobId: string;
    postId: string;
    state: 'materialized';
    operationCount: number;
  }
  | {
    disposition: 'retry_planned';
    jobId: string;
    postId: null;
    state: 'retry_wait' | 'dead_letter';
  }
>;

type Queue = Pick<
  PgPublicSocialRevalidationQueue,
  'claim' | 'fail' | 'completeAndMaterialize'
>;
type Attestor = Pick<PgPropertyPredatorJitSourceAttestor, 'attest'>;

export interface PublicSocialRevalidatorDependencies {
  readonly queue: Queue;
  readonly attestor: Attestor;
  readonly nextId?: () => string;
}

export class PublicSocialJitRevalidator {
  readonly #nextId: () => string;

  constructor(private readonly dependencies: PublicSocialRevalidatorDependencies) {
    this.#nextId = dependencies.nextId ?? randomUUID;
  }

  async #recordFailure(
    claim: PublicSocialRevalidationClaim,
    lease: PublicSocialRevalidationLease,
    cause: unknown,
  ): Promise<PublicSocialRevalidationCycleResult> {
    try {
      const state = await this.dependencies.queue.fail(
        claim,
        lease,
        'revalidation.source_or_proof_failed',
        true,
      );
      return Object.freeze({
        disposition: 'retry_planned',
        jobId: claim.jobId,
        postId: null,
        state,
      });
    } catch (failureError) {
      throw new AggregateError(
        [cause, failureError],
        'JIT revalidation and fenced failure recording both failed',
      );
    }
  }

  async runOnce(
    lease: PublicSocialRevalidationLease,
  ): Promise<PublicSocialRevalidationCycleResult> {
    const claim = await this.dependencies.queue.claim(lease);
    if (!claim) {
      return Object.freeze({ disposition: 'idle', jobId: null, postId: null, state: null });
    }
    try {
      const sourceProof = await this.dependencies.attestor.attest(claim, lease);
      const result = await this.dependencies.queue.completeAndMaterialize(
        claim,
        lease,
        sourceProof,
        this.#nextId(),
        this.#nextId(),
      );
      return Object.freeze({
        disposition: 'materialized',
        jobId: claim.jobId,
        postId: result.postId,
        state: 'materialized',
        operationCount: result.operationIds.length,
      });
    } catch (error) {
      return this.#recordFailure(claim, lease, error);
    }
  }
}
