import { domainToASCII } from 'node:url';
import type {
  ProviderOperationContext,
  ProviderOperationResult,
} from './contracts.js';
import {
  normalizeOwnedInternalSeedEmail,
  PROPERTY_PREDATOR_EMAIL_PROVIDER_ID,
} from './property-predator-email-pilot-config.js';

const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_EXTERNAL_ID = /^[^\u0000-\u001f\u007f]{1,500}$/u;
const MAILGUN_EU_API_ORIGIN = 'https://api.eu.mailgun.net';
const MAX_BODY_BYTES = 8_192;
const MAX_SUBJECT_BYTES = 500;

export interface MailgunEuEmailRequest {
  readonly recipients: readonly string[];
  readonly subject: string;
  readonly text: string;
  /** SHA-256 of the canonical controlled-pilot request. */
  readonly idempotencySha256: string;
  /** Message-ID durably persisted by the worker before the provider call. */
  readonly expectedMessageId?: string;
  readonly signal?: AbortSignal;
}

export interface MailgunEuEmailTransport {
  send(
    context: ProviderOperationContext,
    request: MailgunEuEmailRequest,
  ): Promise<ProviderOperationResult>;
}

export class MailgunOutcomeUnknownError extends Error {
  readonly code = 'mailgun_outcome_unknown';

  constructor() {
    super('The Mailgun request outcome is unknown and must be reconciled before any retry');
    this.name = 'MailgunOutcomeUnknownError';
  }
}

export interface MailgunEuHttpAdapterOptions {
  readonly apiKey: string;
  readonly sendingDomain: string;
  readonly fromEmail: string;
  readonly fromName?: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
}

function plainSecret(value: string): string {
  if (typeof value !== 'string' || value.length < 8 || value.length > 500
      || /[\u0000-\u0020\u007f]/u.test(value)) {
    throw new Error('Mailgun API key is missing or malformed');
  }
  return value;
}

function sendingDomain(value: string): string {
  const ascii = domainToASCII(value.trim()).toLowerCase();
  if (!ascii || ascii.length > 253
      || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/i.test(ascii)
      || ascii.split('.').length < 2
      || ascii.split('.').some((label) => label.length < 1 || label.length > 63)) {
    throw new Error('Mailgun sending domain is invalid');
  }
  return ascii;
}

function fromName(value: string | undefined): string {
  const normalized = (value ?? 'Property Predator').normalize('NFC').trim();
  if (!normalized || normalized.length > 100 || /[\u0000-\u001f\u007f<>"]/u.test(normalized)) {
    throw new Error('Mailgun From name is invalid');
  }
  return normalized;
}

function safeText(value: string, label: string, maximumBytes: number): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') < 1
      || Buffer.byteLength(value, 'utf8') > maximumBytes
      || value.includes('\u0000') || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function safeContext(context: ProviderOperationContext): void {
  if (context.providerId !== PROPERTY_PREDATOR_EMAIL_PROVIDER_ID
      || !SHA256.test(context.idempotencyKey)) {
    throw new Error('Mailgun adapter requires canonical controlled-pilot context');
  }
}

function safeResponseId(value: unknown): string | null {
  return typeof value === 'string' && SAFE_EXTERNAL_ID.test(value.trim()) ? value.trim() : null;
}

function makeAbortSignal(input: AbortSignal | undefined, timeoutMs: number): Readonly<{
  signal: AbortSignal;
  dispose: () => void;
}> {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  if (input?.aborted) controller.abort();
  else input?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  timer.unref?.();
  return Object.freeze({
    signal: controller.signal,
    dispose: (): void => {
      clearTimeout(timer);
      input?.removeEventListener('abort', abort);
    },
  });
}

/**
 * Minimal Mailgun EU transport. It owns credentials in private fields, never
 * places them in a URL and never exposes provider response bodies in errors.
 */
export class MailgunEuHttpAdapter implements MailgunEuEmailTransport {
  readonly #apiKey: string;
  readonly #sendingDomain: string;
  readonly #from: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;

  constructor(options: MailgunEuHttpAdapterOptions) {
    this.#apiKey = plainSecret(options.apiKey);
    this.#sendingDomain = sendingDomain(options.sendingDomain);
    const canonicalFrom = normalizeOwnedInternalSeedEmail(options.fromEmail);
    if (canonicalFrom.split('@')[1] !== this.#sendingDomain) {
      throw new Error('Mailgun From identity must use the configured sending domain');
    }
    this.#from = `${fromName(options.fromName)} <${canonicalFrom}>`;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1_000 || this.#timeoutMs > 30_000) {
      throw new Error('Mailgun timeout must be between 1000 and 30000 milliseconds');
    }
    this.#fetch = options.fetch ?? globalThis.fetch;
    if (typeof this.#fetch !== 'function') throw new Error('A Fetch implementation is required');
    this.#now = options.now ?? (() => new Date());
  }

  async send(
    context: ProviderOperationContext,
    request: MailgunEuEmailRequest,
  ): Promise<ProviderOperationResult> {
    safeContext(context);
    if (!SHA256.test(request.idempotencySha256)
        || request.idempotencySha256 !== context.idempotencyKey) {
      throw new Error('Mailgun idempotency evidence does not match the provider context');
    }
    const recipients = request.recipients.map(normalizeOwnedInternalSeedEmail);
    if (recipients.length < 1 || recipients.length > 10
        || new Set(recipients).size !== recipients.length) {
      throw new Error('Mailgun request must contain one to ten unique recipients');
    }
    const subject = safeText(request.subject.normalize('NFC').trim(), 'Mailgun subject', MAX_SUBJECT_BYTES);
    if (/[\r\n]/u.test(subject)) throw new Error('Mailgun subject cannot contain header breaks');
    const body = safeText(request.text, 'Mailgun body', MAX_BODY_BYTES);
    const expectedMessageId = `<pp-${request.idempotencySha256}@${this.#sendingDomain}>`;
    if (request.expectedMessageId !== undefined
        && request.expectedMessageId !== expectedMessageId) {
      throw new Error('Mailgun expected Message-ID does not match durable worker evidence');
    }
    if (request.signal?.aborted) throw new MailgunOutcomeUnknownError();

    const form = new FormData();
    form.set('from', this.#from);
    for (const recipient of recipients) form.append('to', recipient);
    form.set('subject', subject);
    form.set('text', body);
    form.set('h:Message-Id', expectedMessageId);
    form.set('v:pp-idempotency-sha256', request.idempotencySha256);
    form.set('o:tracking', 'yes');

    const composed = makeAbortSignal(request.signal, this.#timeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(
        `${MAILGUN_EU_API_ORIGIN}/v3/${this.#sendingDomain}/messages`,
        {
          method: 'POST',
          headers: Object.freeze({
            Authorization: `Basic ${Buffer.from(`api:${this.#apiKey}`, 'utf8').toString('base64')}`,
          }),
          body: form,
          signal: composed.signal,
          redirect: 'error',
        },
      );
    } catch {
      throw new MailgunOutcomeUnknownError();
    } finally {
      composed.dispose();
    }

    const occurredAt = this.#now().toISOString();
    if (!response.ok) {
      const outcomeUnknown = response.status === 408 || response.status >= 500;
      if (outcomeUnknown) {
        return Object.freeze({
          status: 'needs_attention', externalId: null, occurredAt, retryable: false,
          errorCode: `mailgun_http_${response.status}_outcome_unknown`,
          summary: 'Mailgun response did not prove whether the controlled-pilot request was accepted',
        });
      }
      const retryable = response.status === 408 || response.status === 409
        || response.status === 425 || response.status === 429 || response.status >= 500;
      return Object.freeze({
        status: 'failed', externalId: null, occurredAt, retryable,
        errorCode: `mailgun_http_${response.status}`,
        summary: retryable
          ? 'Mailgun temporarily rejected the controlled-pilot request'
          : 'Mailgun rejected the controlled-pilot request',
      });
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return Object.freeze({
        status: 'needs_attention', externalId: null, occurredAt, retryable: false,
        errorCode: 'mailgun_invalid_success_response',
        summary: 'Mailgun accepted the request but returned no reconcilable message identity',
      });
    }
    const externalId = payload && typeof payload === 'object' && 'id' in payload
      ? safeResponseId((payload as { id?: unknown }).id)
      : null;
    if (!externalId) {
      return Object.freeze({
        status: 'needs_attention', externalId: null, occurredAt, retryable: false,
        errorCode: 'mailgun_missing_message_id',
        summary: 'Mailgun accepted the request but returned no reconcilable message identity',
      });
    }
    return Object.freeze({
      status: 'accepted', externalId, occurredAt, retryable: false,
      errorCode: null, summary: 'Mailgun accepted the controlled internal-seed email',
    });
  }

  /** Prevent accidental credential rendering through JSON serialization. */
  toJSON(): Readonly<{ provider: string; region: string; credentials: string }> {
    return Object.freeze({ provider: 'mailgun', region: 'eu', credentials: '[REDACTED]' });
  }
}

export function createMailgunEuHttpAdapterFromEnvironment(
  env: NodeJS.ProcessEnv,
  options: Readonly<{ fetch?: typeof fetch; now?: () => Date }> = {},
): MailgunEuHttpAdapter {
  if (env.MAILGUN_REGION?.trim() !== 'eu') throw new Error('MAILGUN_REGION must be eu');
  return new MailgunEuHttpAdapter({
    apiKey: env.MAILGUN_API_KEY ?? '',
    sendingDomain: env.MAILGUN_SENDING_DOMAIN ?? '',
    fromEmail: env.MAILGUN_FROM_EMAIL ?? '',
    fetch: options.fetch,
    now: options.now,
  });
}

/**
 * Production worker factory for a domain-scoped Mailgun Domain Sending Key.
 *
 * The key is deliberately separate from the web-only webhook signing key and
 * from any broad account API key. Mailgun Domain Sending Keys are limited to
 * the selected domain's messages/messages.mime/events surfaces. The worker
 * uses only the EU messages endpoint.
 */
export function createMailgunEuHttpAdapterFromDomainSendingKeyEnvironment(
  env: NodeJS.ProcessEnv,
  options: Readonly<{ fetch?: typeof fetch; now?: () => Date }> = {},
): MailgunEuHttpAdapter {
  if (env.MAILGUN_REGION?.trim() !== 'eu') throw new Error('MAILGUN_REGION must be eu');
  if (env.MAILGUN_KEY_SCOPE?.trim() !== 'domain-sending') {
    throw new Error('MAILGUN_KEY_SCOPE must be domain-sending');
  }
  if (env.MAILGUN_API_KEY?.trim()) {
    throw new Error('The Mailgun worker must not receive a broad account API key');
  }
  return new MailgunEuHttpAdapter({
    apiKey: env.MAILGUN_DOMAIN_SENDING_KEY ?? '',
    sendingDomain: env.MAILGUN_SENDING_DOMAIN ?? '',
    fromEmail: env.MAILGUN_FROM_EMAIL ?? '',
    fetch: options.fetch,
    now: options.now,
  });
}
