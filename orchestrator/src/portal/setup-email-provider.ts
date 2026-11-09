import { createHash } from 'node:crypto';

const ERROR_CODE_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,99}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * The deliberately small contract between account-setup delivery and an email
 * adapter. Provider credentials and provider-specific payloads stay behind
 * this interface.
 */
export interface SetupEmailSendRequest {
  readonly recipientEmail: string;
  readonly setupUrl: string;
  /**
   * Stable across retries and attached to provider metadata where supported.
   * It is a reconciliation key, not a promise that the provider deduplicates.
   */
  readonly correlationKey: string;
}

export interface SetupEmailAcceptance {
  readonly status: 'accepted';
  /** Safe provider reference used to reconcile an at-least-once send. */
  readonly providerReferenceId: string;
  readonly acceptedAt: string;
}

export interface SetupEmailProvider {
  /** Stable adapter identifier persisted with provider acceptance. */
  readonly providerId: string;
  send(request: SetupEmailSendRequest, signal: AbortSignal): Promise<SetupEmailAcceptance>;
}

/** A provider-safe error: the code is persisted, while raw provider bodies are not. */
export class SetupEmailProviderError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, retryable = true) {
    if (!ERROR_CODE_PATTERN.test(code)) {
      throw new Error('setup email provider error code is invalid');
    }
    super('Setup email provider rejected the request');
    this.name = 'SetupEmailProviderError';
    this.code = code;
    this.retryable = retryable;
  }
}

export interface InMemorySetupEmailProviderOptions {
  now?: () => number;
}

export interface InMemorySetupEmailReceipt {
  readonly correlationKey: string;
  readonly providerReferenceId: string;
  readonly acceptedAt: string;
}

interface StoredAcceptance {
  readonly fingerprint: string;
  readonly acceptance: SetupEmailAcceptance;
}

function validateRequest(request: SetupEmailSendRequest): void {
  const recipientEmail = request.recipientEmail.trim().toLowerCase();
  if (recipientEmail !== request.recipientEmail
      || recipientEmail.length > 320
      || !EMAIL_PATTERN.test(recipientEmail)) {
    throw new SetupEmailProviderError('provider_invalid_recipient', false);
  }
  if (!UUID_PATTERN.test(request.correlationKey)) {
    throw new SetupEmailProviderError('provider_invalid_correlation_key', false);
  }
  let setupUrl: URL;
  try {
    setupUrl = new URL(request.setupUrl);
  } catch {
    throw new SetupEmailProviderError('provider_invalid_setup_url', false);
  }
  const queryKeys = [...setupUrl.searchParams.keys()];
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(setupUrl.hostname);
  if ((setupUrl.protocol !== 'https:' && !(loopback && setupUrl.protocol === 'http:'))
      || setupUrl.username
      || setupUrl.password
      || setupUrl.pathname !== '/portal/setup'
      || setupUrl.hash
      || queryKeys.length !== 1
      || queryKeys[0] !== 'token'
      || !TOKEN_PATTERN.test(setupUrl.searchParams.get('token') ?? '')) {
    throw new SetupEmailProviderError('provider_invalid_setup_url', false);
  }
}

function requestFingerprint(request: SetupEmailSendRequest): string {
  return createHash('sha256')
    .update(request.recipientEmail)
    .update('\0')
    .update(request.setupUrl)
    .digest('hex');
}

/**
 * Network-free provider for development and deterministic tests.
 *
 * It retains only a fingerprint of the recipient/link pair. This fake locally
 * deduplicates a correlation key to make deterministic development safe; real
 * adapters remain at-least-once unless their provider documents idempotency.
 * Snapshots cannot reveal the setup credential or recipient address.
 */
export class InMemorySetupEmailProvider implements SetupEmailProvider {
  readonly providerId = 'memory';
  private readonly accepted = new Map<string, StoredAcceptance>();
  private readonly queuedFailures: SetupEmailProviderError[] = [];
  private readonly now: () => number;

  constructor(options: InMemorySetupEmailProviderOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  failNext(code = 'provider_unavailable', retryable = true): void {
    this.queuedFailures.push(new SetupEmailProviderError(code, retryable));
  }

  async send(request: SetupEmailSendRequest, signal: AbortSignal): Promise<SetupEmailAcceptance> {
    if (signal.aborted) throw new SetupEmailProviderError('provider_aborted');
    validateRequest(request);
    const queuedFailure = this.queuedFailures.shift();
    if (queuedFailure) throw queuedFailure;

    const fingerprint = requestFingerprint(request);
    const previous = this.accepted.get(request.correlationKey);
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        throw new SetupEmailProviderError('provider_correlation_conflict', false);
      }
      return previous.acceptance;
    }

    const timestamp = this.now();
    if (!Number.isFinite(timestamp)) {
      throw new SetupEmailProviderError('provider_clock_invalid');
    }
    const acceptance = Object.freeze({
      status: 'accepted' as const,
      providerReferenceId: `memory_${createHash('sha256').update(request.correlationKey).digest('hex').slice(0, 24)}`,
      acceptedAt: new Date(timestamp).toISOString(),
    });
    this.accepted.set(request.correlationKey, { fingerprint, acceptance });
    return acceptance;
  }

  hasAccepted(correlationKey: string): boolean {
    return this.accepted.has(correlationKey);
  }

  snapshot(): readonly InMemorySetupEmailReceipt[] {
    return Object.freeze([...this.accepted.entries()].map(([correlationKey, stored]) => Object.freeze({
      correlationKey,
      providerReferenceId: stored.acceptance.providerReferenceId,
      acceptedAt: stored.acceptance.acceptedAt,
    })));
  }
}
