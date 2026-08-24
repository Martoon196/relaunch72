import {
  MissingSetupDeliveryKeyError,
  UnreadableSetupDeliveryError,
  type AcknowledgedSetupDelivery,
  type ClaimedSetupDelivery,
  type PermanentlyRejectedSetupDelivery,
  type SetupDeliveryProviderAcceptance,
} from './setup-delivery-pg-service.js';
import {
  SetupEmailProviderError,
  type SetupEmailAcceptance,
  type SetupEmailProvider,
} from './setup-email-provider.js';

const ERROR_CODE_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,99}$/;
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,49}$/;
const PROVIDER_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type SetupEmailAcceptanceRecord = SetupDeliveryProviderAcceptance;

export interface SetupDeliveryQueue {
  claim(batchSize?: number, leaseSeconds?: number): Promise<ClaimedSetupDelivery[]>;
  renew(deliveryId: string, leaseToken: string, leaseSeconds?: number): Promise<string | null>;
  fail(
    deliveryId: string,
    leaseToken: string,
    errorCode: string,
    retryAt: string | Date,
  ): Promise<{ state: string; availableAt: string } | null>;
  /** Required to settle provider-declared permanent failures without retry churn. */
  rejectPermanently(
    deliveryId: string,
    leaseToken: string,
    errorCode: string,
  ): Promise<PermanentlyRejectedSetupDelivery | null>;
  /**
   * Required for a successful launch: provider evidence and sent state must
   * commit atomically under the live lease fence.
   */
  acknowledgeAcceptance(
    deliveryId: string,
    leaseToken: string,
    acceptance: SetupEmailAcceptanceRecord,
  ): Promise<AcknowledgedSetupDelivery | null>;
}

export type SetupEmailDispatchResult =
  | Readonly<{ outcome: 'idle' }>
  | Readonly<{ outcome: 'stopped' }>
  | Readonly<{
      outcome: 'accepted';
      deliveryId: string;
      attemptCount: number;
      providerReferenceId: string;
      deliveredAt: string;
    }>
  | Readonly<{
      outcome: 'retry_scheduled' | 'dead_lettered';
      deliveryId: string;
      attemptCount: number;
      errorCode: string;
      availableAt: string;
    }>
  | Readonly<{ outcome: 'blocked'; errorCode: string }>
  | Readonly<{
      outcome: 'needs_attention';
      deliveryId: string | null;
      attemptCount: number | null;
      errorCode: string;
      providerReferenceId: string | null;
    }>;

export type SetupEmailDispatchEvent =
  | Readonly<{ type: 'worker_started' | 'worker_stopped'; at: string }>
  | Readonly<{ type: 'dispatch_result'; at: string; result: SetupEmailDispatchResult }>;

export interface SetupEmailDispatcherOptions {
  queue: SetupDeliveryQueue;
  provider: SetupEmailProvider;
  leaseSeconds?: number;
  /** Provider calls are aborted before their database lease can expire. */
  providerTimeoutMs?: number;
  leaseSafetyMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  idlePollMs?: number;
  blockedPollMs?: number;
  now?: () => number;
  onEvent?: (event: SetupEmailDispatchEvent) => void;
}

interface NormalizedOptions {
  queue: SetupDeliveryQueue;
  provider: SetupEmailProvider;
  leaseSeconds: number;
  providerTimeoutMs: number;
  leaseSafetyMs: number;
  retryBaseMs: number;
  retryMaxMs: number;
  idlePollMs: number;
  blockedPollMs: number;
  now: () => number;
  onEvent?: (event: SetupEmailDispatchEvent) => void;
}

class ProviderCallAbortedError extends Error {}

function integerInRange(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function normalizeOptions(options: SetupEmailDispatcherOptions): NormalizedOptions {
  if (!PROVIDER_ID_PATTERN.test(options.provider.providerId)) {
    throw new Error('setup email provider id is invalid');
  }
  if (typeof options.queue.acknowledgeAcceptance !== 'function'
      || typeof options.queue.rejectPermanently !== 'function') {
    throw new Error('setup delivery queue lacks required terminal/acceptance settlement capabilities');
  }
  const leaseSeconds = integerInRange(options.leaseSeconds ?? 60, 15, 300, 'leaseSeconds');
  const providerTimeoutMs = integerInRange(
    options.providerTimeoutMs ?? 20_000,
    100,
    120_000,
    'providerTimeoutMs',
  );
  const leaseSafetyMs = integerInRange(options.leaseSafetyMs ?? 10_000, 100, 60_000, 'leaseSafetyMs');
  if (providerTimeoutMs + leaseSafetyMs >= leaseSeconds * 1_000) {
    throw new Error('providerTimeoutMs plus leaseSafetyMs must be shorter than the delivery lease');
  }
  const retryBaseMs = integerInRange(options.retryBaseMs ?? 30_000, 1_000, 3_600_000, 'retryBaseMs');
  const retryMaxMs = integerInRange(options.retryMaxMs ?? 900_000, retryBaseMs, 86_000_000, 'retryMaxMs');
  return {
    queue: options.queue,
    provider: options.provider,
    leaseSeconds,
    providerTimeoutMs,
    leaseSafetyMs,
    retryBaseMs,
    retryMaxMs,
    idlePollMs: integerInRange(options.idlePollMs ?? 2_000, 1, 60_000, 'idlePollMs'),
    blockedPollMs: integerInRange(options.blockedPollMs ?? 10_000, 1, 300_000, 'blockedPollMs'),
    now: options.now ?? Date.now,
    onEvent: options.onEvent,
  };
}

function freezeResult<T extends SetupEmailDispatchResult>(result: T): T {
  return Object.freeze(result);
}

function safeTimestamp(now: () => number): string {
  const timestamp = now();
  if (!Number.isFinite(timestamp)) return new Date(0).toISOString();
  return new Date(timestamp).toISOString();
}

function canonicalTimestamp(value: unknown): string | null {
  const raw = value instanceof Date ? value.toISOString() : value;
  const timestamp = typeof raw === 'string' ? Date.parse(raw) : Number.NaN;
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function validSafeClaim(job: ClaimedSetupDelivery): boolean {
  return UUID_PATTERN.test(job.deliveryId)
    && UUID_PATTERN.test(job.userId)
    && UUID_PATTERN.test(job.workspaceId)
    && UUID_PATTERN.test(job.actionTokenId)
    && job.providerIdempotencyKey === job.deliveryId
    && Number.isInteger(job.attemptCount)
    && job.attemptCount >= 1
    && job.attemptCount <= 8;
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    function finish(): void {
      signal.removeEventListener('abort', finish);
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener('abort', finish, { once: true });
  });
}

function callProvider(
  provider: SetupEmailProvider,
  job: ClaimedSetupDelivery,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<{ acceptance: SetupEmailAcceptance } | { aborted: 'stopped' | 'timeout' } | { error: unknown }> {
  if (signal.aborted) return Promise.resolve({ aborted: 'stopped' });
  const operation = new AbortController();
  let timedOut = false;
  const onStop = (): void => operation.abort();
  if (signal.aborted) operation.abort();
  else signal.addEventListener('abort', onStop, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    operation.abort();
  }, timeoutMs);

  let providerCall: Promise<SetupEmailAcceptance>;
  try {
    providerCall = Promise.resolve(provider.send({
      recipientEmail: job.recipientEmail,
      setupUrl: job.setupUrl,
      correlationKey: job.providerIdempotencyKey,
    }, operation.signal));
  } catch (error) {
    providerCall = Promise.reject(error);
  }

  const raced = new Promise<SetupEmailAcceptance>((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      reject(new ProviderCallAbortedError());
    };
    operation.signal.addEventListener('abort', onAbort, { once: true });
    if (operation.signal.aborted) onAbort();
    providerCall.then(
      (acceptance) => {
        if (settled) return;
        settled = true;
        operation.signal.removeEventListener('abort', onAbort);
        resolve(acceptance);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        operation.signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });

  return raced.then(
    (acceptance) => ({ acceptance }),
    (error: unknown) => {
      if (error instanceof ProviderCallAbortedError) {
        return { aborted: signal.aborted ? 'stopped' as const : timedOut ? 'timeout' as const : 'timeout' as const };
      }
      return { error };
    },
  ).finally(() => {
    clearTimeout(timeout);
    signal.removeEventListener('abort', onStop);
  });
}

function containsJobSecret(value: string, job: ClaimedSetupDelivery): boolean {
  const setupToken = (() => {
    try {
      return new URL(job.setupUrl).searchParams.get('token');
    } catch {
      return null;
    }
  })();
  const secrets = [job.recipientEmail, job.setupUrl, job.leaseToken, setupToken]
    .filter((secret): secret is string => typeof secret === 'string' && secret.length > 0);
  const representations = secrets.flatMap((secret) => {
    const bytes = Buffer.from(secret, 'utf8');
    return [
      secret,
      secret.toLowerCase(),
      bytes.toString('base64'),
      bytes.toString('base64url'),
      bytes.toString('hex'),
      encodeURIComponent(secret),
    ];
  });
  const folded = value.toLowerCase();
  return representations.some((representation) => (
    value.includes(representation) || folded.includes(representation.toLowerCase())
  ));
}

function validAcceptance(value: SetupEmailAcceptance, job: ClaimedSetupDelivery): boolean {
  return value?.status === 'accepted'
    && typeof value.providerReferenceId === 'string'
    && value.providerReferenceId === value.providerReferenceId.trim()
    && PROVIDER_REFERENCE_PATTERN.test(value.providerReferenceId)
    && !containsJobSecret(value.providerReferenceId, job)
    && Number.isFinite(Date.parse(value.acceptedAt));
}

function providerFailure(
  error: unknown,
  job: ClaimedSetupDelivery,
): { errorCode: string; retryable: boolean } {
  if (error instanceof SetupEmailProviderError && ERROR_CODE_PATTERN.test(error.code)) {
    const secretCode = containsJobSecret(error.code, job);
    return {
      errorCode: secretCode ? 'provider_unavailable' : error.code,
      retryable: secretCode ? true : error.retryable,
    };
  }
  return { errorCode: 'provider_unavailable', retryable: true };
}

export class SetupEmailDispatcher {
  private readonly options: NormalizedOptions;
  private controller: AbortController | null = null;
  private loop: Promise<void> | null = null;
  private processing = false;
  private lifecycle: 'idle' | 'running' | 'stopping' = 'idle';

  constructor(options: SetupEmailDispatcherOptions) {
    this.options = normalizeOptions(options);
  }

  get state(): 'idle' | 'running' | 'stopping' {
    return this.lifecycle;
  }

  /** Explicitly start the polling loop. Construction alone never starts it. */
  start(): void {
    if (this.lifecycle !== 'idle' || this.processing) {
      throw new Error('setup email dispatcher is already running');
    }
    this.controller = new AbortController();
    this.lifecycle = 'running';
    this.emit(Object.freeze({ type: 'worker_started', at: safeTimestamp(this.options.now) }));
    this.loop = this.runLoop(this.controller.signal);
  }

  /** Abort polling/provider work, release an owned job to retry, and await settlement. */
  async stop(): Promise<void> {
    if (this.lifecycle === 'idle') return;
    this.lifecycle = 'stopping';
    this.controller?.abort();
    await this.loop;
  }

  async runOnce(signal: AbortSignal = new AbortController().signal): Promise<SetupEmailDispatchResult> {
    if (this.lifecycle !== 'idle') {
      throw new Error('cannot run one setup email dispatch while the polling loop is active');
    }
    return this.dispatchOnce(signal);
  }

  private async dispatchOnce(signal: AbortSignal): Promise<SetupEmailDispatchResult> {
    if (this.processing) throw new Error('setup email dispatcher already has a job in progress');
    if (signal.aborted) return freezeResult({ outcome: 'stopped' });
    this.processing = true;
    try {
      return await this.processOne(signal);
    } finally {
      this.processing = false;
    }
  }

  private async processOne(signal: AbortSignal): Promise<SetupEmailDispatchResult> {
    let jobs: ClaimedSetupDelivery[];
    try {
      jobs = await this.options.queue.claim(1, this.options.leaseSeconds);
    } catch (error) {
      return freezeResult({
        outcome: 'blocked',
        errorCode: error instanceof MissingSetupDeliveryKeyError
          ? 'missing_delivery_encryption_key'
          : error instanceof UnreadableSetupDeliveryError
            ? error.code
          : 'delivery_claim_failed',
      });
    }
    if (jobs.length === 0) return freezeResult({ outcome: 'idle' });
    if (jobs.length !== 1) {
      return freezeResult({ outcome: 'blocked', errorCode: 'invalid_delivery_claim_batch' });
    }
    const job = jobs[0]!;
    if (!validSafeClaim(job)) {
      return freezeResult({ outcome: 'blocked', errorCode: 'invalid_delivery_claim' });
    }
    if (signal.aborted) return this.settleFailure(job, 'worker_stopped');

    const leaseExpiry = Date.parse(job.leaseExpiresAt);
    const requiredWindow = this.options.providerTimeoutMs + this.options.leaseSafetyMs;
    if (!Number.isFinite(leaseExpiry)) return this.settleFailure(job, 'invalid_lease_expiry');
    if (leaseExpiry - this.currentTime() <= requiredWindow) {
      // At most one renewal is needed: the provider timeout is strictly less
      // than a freshly renewed lease, making renewal bounded by construction.
      let renewedExpiry: string | null;
      try {
        renewedExpiry = await this.options.queue.renew(
          job.deliveryId,
          job.leaseToken,
          this.options.leaseSeconds,
        );
      } catch {
        return this.settleFailure(job, 'lease_renewal_failed');
      }
      if (!renewedExpiry) {
        return freezeResult({
          outcome: 'needs_attention',
          deliveryId: job.deliveryId,
          attemptCount: job.attemptCount,
          errorCode: 'delivery_lease_lost',
          providerReferenceId: null,
        });
      }
      const renewedTimestamp = Date.parse(renewedExpiry);
      if (!Number.isFinite(renewedTimestamp)
          || renewedTimestamp - this.currentTime() <= requiredWindow) {
        return this.settleFailure(job, 'lease_window_insufficient');
      }
    }
    if (signal.aborted) return this.settleFailure(job, 'worker_stopped');

    const providerOutcome = await callProvider(
      this.options.provider,
      job,
      signal,
      this.options.providerTimeoutMs,
    );
    if ('aborted' in providerOutcome) {
      return this.settleFailure(
        job,
        providerOutcome.aborted === 'stopped' ? 'worker_stopped' : 'provider_timeout',
      );
    }
    if ('error' in providerOutcome) {
      const failure = providerFailure(providerOutcome.error, job);
      return failure.retryable
        ? this.settleFailure(job, failure.errorCode)
        : this.settlePermanentFailure(job, failure.errorCode);
    }
    if (!validAcceptance(providerOutcome.acceptance, job)) {
      return this.settlePermanentFailure(job, 'provider_invalid_response');
    }

    // Once a provider accepts this at-least-once send, never mark it failed.
    // An acknowledgement race is surfaced with the safe provider reference;
    // a later lease may replay the correlation key and providers can duplicate.
    let acknowledged: AcknowledgedSetupDelivery | null;
    try {
      acknowledged = await this.options.queue.acknowledgeAcceptance(
        job.deliveryId,
        job.leaseToken,
        Object.freeze({
          providerId: this.options.provider.providerId,
          providerReferenceId: providerOutcome.acceptance.providerReferenceId,
          providerAcceptedAt: canonicalTimestamp(providerOutcome.acceptance.acceptedAt)!,
        }),
      );
    } catch {
      return freezeResult({
        outcome: 'needs_attention',
        deliveryId: job.deliveryId,
        attemptCount: job.attemptCount,
        errorCode: 'delivery_acknowledgement_failed',
        providerReferenceId: providerOutcome.acceptance.providerReferenceId,
      });
    }
    if (!acknowledged) {
      return freezeResult({
        outcome: 'needs_attention',
        deliveryId: job.deliveryId,
        attemptCount: job.attemptCount,
        errorCode: 'delivery_acknowledgement_fenced',
        providerReferenceId: providerOutcome.acceptance.providerReferenceId,
      });
    }
    const deliveredAt = canonicalTimestamp(acknowledged.deliveredAt);
    if (!deliveredAt
        || acknowledged.providerId !== this.options.provider.providerId
        || acknowledged.providerReferenceId !== providerOutcome.acceptance.providerReferenceId) {
      return freezeResult({
        outcome: 'needs_attention',
        deliveryId: job.deliveryId,
        attemptCount: job.attemptCount,
        errorCode: 'delivery_acknowledgement_mismatched',
        providerReferenceId: providerOutcome.acceptance.providerReferenceId,
      });
    }
    return freezeResult({
      outcome: 'accepted',
      deliveryId: job.deliveryId,
      attemptCount: job.attemptCount,
      providerReferenceId: providerOutcome.acceptance.providerReferenceId,
      deliveredAt,
    });
  }

  private currentTime(): number {
    const timestamp = this.options.now();
    if (!Number.isFinite(timestamp)) return 0;
    return timestamp;
  }

  private retryDelay(attemptCount: number): number {
    const exponent = Math.max(0, Math.min(20, attemptCount - 1));
    return Math.min(this.options.retryMaxMs, this.options.retryBaseMs * (2 ** exponent));
  }

  private async settleFailure(job: ClaimedSetupDelivery, errorCode: string): Promise<SetupEmailDispatchResult> {
    const retryAt = new Date(this.currentTime() + this.retryDelay(job.attemptCount));
    try {
      const settlement = await this.options.queue.fail(
        job.deliveryId,
        job.leaseToken,
        errorCode,
        retryAt,
      );
      if (!settlement) {
        return freezeResult({
          outcome: 'needs_attention',
          deliveryId: job.deliveryId,
          attemptCount: job.attemptCount,
          errorCode: 'delivery_failure_fenced',
          providerReferenceId: null,
        });
      }
      if (settlement.state !== 'retry' && settlement.state !== 'dead_letter') {
        return freezeResult({
          outcome: 'needs_attention',
          deliveryId: job.deliveryId,
          attemptCount: job.attemptCount,
          errorCode: 'delivery_failure_invalid_response',
          providerReferenceId: null,
        });
      }
      const availableAt = canonicalTimestamp(settlement.availableAt);
      if (!availableAt) {
        return freezeResult({
          outcome: 'needs_attention',
          deliveryId: job.deliveryId,
          attemptCount: job.attemptCount,
          errorCode: 'delivery_failure_invalid_response',
          providerReferenceId: null,
        });
      }
      return freezeResult({
        outcome: settlement.state === 'retry' ? 'retry_scheduled' : 'dead_lettered',
        deliveryId: job.deliveryId,
        attemptCount: job.attemptCount,
        errorCode,
        availableAt,
      });
    } catch {
      return freezeResult({
        outcome: 'needs_attention',
        deliveryId: job.deliveryId,
        attemptCount: job.attemptCount,
        errorCode: 'delivery_failure_settlement_failed',
        providerReferenceId: null,
      });
    }
  }

  private async settlePermanentFailure(
    job: ClaimedSetupDelivery,
    errorCode: string,
  ): Promise<SetupEmailDispatchResult> {
    try {
      const settlement = await this.options.queue.rejectPermanently(
        job.deliveryId,
        job.leaseToken,
        errorCode,
      );
      if (!settlement) {
        return freezeResult({
          outcome: 'needs_attention',
          deliveryId: job.deliveryId,
          attemptCount: job.attemptCount,
          errorCode: 'delivery_terminal_settlement_fenced',
          providerReferenceId: null,
        });
      }
      const settledAt = canonicalTimestamp(settlement.settledAt);
      if (settlement.state !== 'dead_letter' || !settledAt) {
        return freezeResult({
          outcome: 'needs_attention',
          deliveryId: job.deliveryId,
          attemptCount: job.attemptCount,
          errorCode: 'delivery_terminal_settlement_invalid_response',
          providerReferenceId: null,
        });
      }
      return freezeResult({
        outcome: 'dead_lettered',
        deliveryId: job.deliveryId,
        attemptCount: job.attemptCount,
        errorCode,
        availableAt: settledAt,
      });
    } catch {
      return freezeResult({
        outcome: 'needs_attention',
        deliveryId: job.deliveryId,
        attemptCount: job.attemptCount,
        errorCode: 'delivery_terminal_settlement_failed',
        providerReferenceId: null,
      });
    }
  }

  private async runLoop(signal: AbortSignal): Promise<void> {
    try {
      while (!signal.aborted) {
        let result: SetupEmailDispatchResult;
        try {
          result = await this.dispatchOnce(signal);
        } catch {
          result = freezeResult({ outcome: 'blocked', errorCode: 'dispatcher_internal_error' });
        }
        this.emit(Object.freeze({
          type: 'dispatch_result',
          at: safeTimestamp(this.options.now),
          result,
        }));
        if (result.outcome === 'blocked'
            && (result.errorCode === 'missing_delivery_encryption_key'
              || result.errorCode === 'delivery_payload_unreadable')) {
          break;
        }
        if (signal.aborted) break;
        const delay = result.outcome === 'idle'
          ? this.options.idlePollMs
          : result.outcome === 'blocked'
              || result.outcome === 'needs_attention'
            ? this.options.blockedPollMs
            : 0;
        if (delay > 0) await abortableDelay(delay, signal);
      }
    } finally {
      this.lifecycle = 'idle';
      this.controller = null;
      this.loop = null;
      this.emit(Object.freeze({ type: 'worker_stopped', at: safeTimestamp(this.options.now) }));
    }
  }

  private emit(event: SetupEmailDispatchEvent): void {
    try {
      this.options.onEvent?.(event);
    } catch {
      // Observability is deliberately non-authoritative and must never alter
      // delivery settlement or expose the error object to another surface.
    }
  }
}
