/**
 * Twilio Messaging HTTP transport for the 0056 SMS rail.
 *
 * Restricted-credential, single-recipient adapter. It holds only the
 * restricted API key pair plus non-secret account/Messaging Service
 * identifiers, redacts itself on serialization, and quarantines every
 * ambiguous outcome instead of retrying. The Account Auth Token is a
 * webhook-only value and is rejected here by the environment factory.
 */

import {
  TWILIO_SMS_GSM_BASIC_TEXT,
  TWILIO_SMS_LIVE_CONTRACT,
  TWILIO_SMS_MESSAGE_SID,
  TWILIO_SMS_PROVIDER_ID,
  TWILIO_SMS_UK_RECIPIENT,
  twilioSmsSegmentCount,
  type TwilioMessagingSmsTransport,
  type TwilioSmsSendRequest,
} from '../sms-live/foundation.js';
import type {
  ProviderOperationContext,
  ProviderOperationResult,
} from './contracts.js';

export const TWILIO_API_ORIGIN = 'https://api.twilio.com' as const;

const ACCOUNT_SID = /^AC[0-9a-f]{32}$/u;
const API_KEY_SID = /^SK[0-9a-f]{32}$/u;
const MESSAGING_SERVICE_SID = /^MG[0-9a-f]{32}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_SECRET = /^[\x21-\x7e]{16,500}$/u;
const AMBIGUOUS_HTTP = new Set([408, 409, 425, 429]);

export class TwilioOutcomeUnknownError extends Error {
  readonly code = 'twilio_sms_outcome_unknown';
  constructor() {
    super('The Twilio request outcome is unknown and must be reconciled before any retry');
    this.name = 'TwilioOutcomeUnknownError';
  }
}

type FetchLike = typeof fetch;

export interface TwilioMessagingHttpAdapterOptions {
  readonly accountSid: string;
  readonly apiKeySid: string;
  readonly apiKeySecret: string;
  readonly messagingServiceSid: string;
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
}

function makeAbortSignal(
  timeoutMs: number,
  upstream: AbortSignal | undefined,
): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer === 'object' && 'unref' in timer) timer.unref();
  if (upstream) {
    if (upstream.aborted) controller.abort();
    else upstream.addEventListener('abort', () => controller.abort(), { once: true });
  }
  controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  return controller.signal;
}

export class TwilioMessagingHttpAdapter implements TwilioMessagingSmsTransport {
  readonly contract = TWILIO_SMS_LIVE_CONTRACT;
  readonly providerId = TWILIO_SMS_PROVIDER_ID;
  readonly #accountSid: string;
  readonly #apiKeySid: string;
  readonly #apiKeySecret: string;
  readonly #messagingServiceSid: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  readonly #now: () => Date;

  constructor(options: TwilioMessagingHttpAdapterOptions) {
    if (!ACCOUNT_SID.test(options.accountSid)
        || !API_KEY_SID.test(options.apiKeySid)
        || !SAFE_SECRET.test(options.apiKeySecret)
        || !MESSAGING_SERVICE_SID.test(options.messagingServiceSid)) {
      throw new Error('Twilio adapter requires the exact restricted-key credential shape');
    }
    const timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30_000) {
      throw new Error('Twilio timeout must be between 1000 and 30000 milliseconds');
    }
    this.#accountSid = options.accountSid;
    this.#apiKeySid = options.apiKeySid;
    this.#apiKeySecret = options.apiKeySecret;
    this.#messagingServiceSid = options.messagingServiceSid;
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = timeoutMs;
    this.#now = options.now ?? (() => new Date());
  }

  toJSON(): Readonly<{ provider: string; credentials: string }> {
    return Object.freeze({ provider: 'twilio_messaging', credentials: '[REDACTED]' });
  }

  async send(
    context: ProviderOperationContext,
    request: TwilioSmsSendRequest,
  ): Promise<ProviderOperationResult> {
    if (context.providerId !== TWILIO_SMS_PROVIDER_ID
        || !SHA256.test(request.idempotencySha256)
        || request.idempotencySha256 !== context.idempotencyKey
        || !TWILIO_SMS_UK_RECIPIENT.test(request.recipient)
        || !TWILIO_SMS_GSM_BASIC_TEXT.test(request.body)
        || twilioSmsSegmentCount(request.body) !== request.expectedSegmentCount) {
      throw new Error('Twilio send request failed its controlled-pilot boundary');
    }
    const form = new URLSearchParams();
    form.set('To', request.recipient);
    form.set('MessagingServiceSid', this.#messagingServiceSid);
    form.set('Body', request.body);
    const authorization = `Basic ${Buffer
      .from(`${this.#apiKeySid}:${this.#apiKeySecret}`, 'utf8').toString('base64')}`;
    let response: Response;
    try {
      response = await this.#fetch(
        `${TWILIO_API_ORIGIN}/2010-04-01/Accounts/${this.#accountSid}/Messages.json`,
        {
          method: 'POST',
          headers: {
            authorization,
            'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
            'idempotency-key': request.idempotencySha256,
          },
          body: form.toString(),
          redirect: 'error',
          signal: makeAbortSignal(this.#timeoutMs, request.signal),
        },
      );
    } catch {
      throw new TwilioOutcomeUnknownError();
    }
    const occurredAt = this.#now().toISOString();
    if (!response.ok) {
      if (AMBIGUOUS_HTTP.has(response.status) || response.status >= 500) {
        return Object.freeze({
          status: 'needs_attention' as const,
          externalId: null,
          occurredAt,
          retryable: false,
          errorCode: `twilio_http_${response.status}_outcome_unknown`,
          summary: 'Twilio returned an ambiguous status; the outcome awaits signed reconciliation',
        });
      }
      return Object.freeze({
        status: 'failed' as const,
        externalId: null,
        occurredAt,
        retryable: false,
        errorCode: `twilio_http_${response.status}`,
        summary: 'Twilio rejected the controlled SMS request',
      });
    }
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      return Object.freeze({
        status: 'needs_attention' as const,
        externalId: null,
        occurredAt,
        retryable: false,
        errorCode: 'twilio_invalid_success_response',
        summary: 'Twilio acceptance could not be proven from its response body',
      });
    }
    const sid = typeof parsed === 'object' && parsed !== null
      && 'sid' in parsed && typeof (parsed as { sid: unknown }).sid === 'string'
      ? (parsed as { sid: string }).sid
      : '';
    if (!TWILIO_SMS_MESSAGE_SID.test(sid)) {
      return Object.freeze({
        status: 'needs_attention' as const,
        externalId: null,
        occurredAt,
        retryable: false,
        errorCode: 'twilio_missing_message_sid',
        summary: 'Twilio acceptance did not carry a canonical Message SID',
      });
    }
    const reportedSegments = typeof parsed === 'object' && parsed !== null
      && 'num_segments' in parsed
      && typeof (parsed as { num_segments: unknown }).num_segments === 'string'
      ? Number((parsed as { num_segments: string }).num_segments)
      : null;
    if (reportedSegments !== null && Number.isSafeInteger(reportedSegments)
        && reportedSegments > request.expectedSegmentCount) {
      return Object.freeze({
        status: 'needs_attention' as const,
        externalId: sid,
        occurredAt,
        retryable: false,
        errorCode: 'twilio_segments_exceeded',
        summary: 'Twilio reported more billed segments than the capped authorisation allowed',
      });
    }
    return Object.freeze({
      status: 'accepted' as const,
      externalId: sid,
      occurredAt,
      retryable: false,
      errorCode: null,
      summary: 'Twilio accepted the controlled owned-number SMS',
    });
  }
}

/**
 * Worker factory. It accepts only the restricted API key pair and rejects
 * any process that also carries the webhook-only Account Auth Token.
 */
export function createTwilioMessagingHttpAdapterFromRestrictedKeyEnvironment(
  env: NodeJS.ProcessEnv,
  options: Readonly<{ fetch?: FetchLike; now?: () => Date }> = {},
): TwilioMessagingHttpAdapter {
  if (env.TWILIO_KEY_SCOPE?.trim() !== 'restricted-api-key') {
    throw new Error('TWILIO_KEY_SCOPE must be restricted-api-key');
  }
  if (env.TWILIO_AUTH_TOKEN?.trim()) {
    throw new Error('The Twilio worker must not receive the webhook Account Auth Token');
  }
  return new TwilioMessagingHttpAdapter({
    accountSid: env.PROPERTY_PREDATOR_SMS_ACCOUNT_SID?.trim() ?? '',
    apiKeySid: env.TWILIO_API_KEY_SID?.trim() ?? '',
    apiKeySecret: env.TWILIO_API_KEY_SECRET ?? '',
    messagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID?.trim() ?? '',
    fetch: options.fetch,
    now: options.now,
  });
}
