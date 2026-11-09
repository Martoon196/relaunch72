import { createHmac } from 'node:crypto';
import {
  PROPERTY_PREDATOR_EXTERNAL_EVENT_MAX_BODY_BYTES,
  parsePropertyPredatorExternalEvent,
  type PropertyPredatorExternalEvent,
} from './contracts.js';
import { PROPERTY_PREDATOR_EXTERNAL_EVENT_PATH } from './router.js';
import { PROPERTY_PREDATOR_SIGNATURE_VERSION } from './signature.js';

const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const MAX_RESPONSE_BYTES = 16 * 1024;

export type PropertyPredatorExternalEventDeliveryFailureKind =
  | 'invalid_configuration'
  | 'outcome_unknown_retryable'
  | 'receiver_unavailable_retryable'
  | 'authentication_rejected'
  | 'event_contract_rejected'
  | 'event_conflict'
  | 'unexpected_response';

export class PropertyPredatorExternalEventDeliveryError extends Error {
  constructor(
    readonly kind: PropertyPredatorExternalEventDeliveryFailureKind,
    readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = 'PropertyPredatorExternalEventDeliveryError';
  }
}

export interface PropertyPredatorExternalEventSenderConfig {
  readonly endpoint: string;
  readonly keyId: string;
  readonly sharedSecret: Uint8Array;
  readonly timeoutMs?: number;
}

export interface PropertyPredatorExternalEventDeliveryReceipt {
  readonly accepted: true;
  readonly disposition: 'shadow' | 'projected';
  readonly replayed: boolean;
  readonly eventId: string;
  readonly acceptedStatus: 200 | 202;
}

export interface PropertyPredatorExternalEventSenderDependencies {
  readonly fetch?: typeof fetch;
  readonly nowSeconds?: () => number;
}

export function loadPropertyPredatorExternalEventSenderConfig(
  env: NodeJS.ProcessEnv = process.env,
): PropertyPredatorExternalEventSenderConfig {
  const endpoint = env.PROPERTY_PREDATOR_GROWTH_HQ_EVENT_ENDPOINT?.trim() ?? '';
  const keyId = env.PROPERTY_PREDATOR_GROWTH_HQ_EVENT_KEY_ID?.trim() ?? '';
  const encodedSecret = env.PROPERTY_PREDATOR_GROWTH_HQ_EVENT_SECRET_BASE64URL?.trim() ?? '';
  const rawTimeout = env.PROPERTY_PREDATOR_GROWTH_HQ_EVENT_TIMEOUT_MS?.trim();
  if (endpoint !== env.PROPERTY_PREDATOR_GROWTH_HQ_EVENT_ENDPOINT
      || keyId !== env.PROPERTY_PREDATOR_GROWTH_HQ_EVENT_KEY_ID
      || encodedSecret !== env.PROPERTY_PREDATOR_GROWTH_HQ_EVENT_SECRET_BASE64URL
      || (rawTimeout !== undefined && rawTimeout !== env.PROPERTY_PREDATOR_GROWTH_HQ_EVENT_TIMEOUT_MS)) {
    return configurationFailure('Growth HQ external-event sender values must be exact and trimmed.');
  }
  if (!/^[A-Za-z0-9_-]+$/u.test(encodedSecret)) {
    return configurationFailure('Growth HQ external-event secret must be canonical base64url.');
  }
  const sharedSecret = Buffer.from(encodedSecret, 'base64url');
  if (sharedSecret.toString('base64url') !== encodedSecret) {
    return configurationFailure('Growth HQ external-event secret must be canonical base64url.');
  }
  const timeoutMs = rawTimeout === undefined ? 5_000 : Number(rawTimeout);
  const config = Object.freeze({ endpoint, keyId, sharedSecret, timeoutMs });
  validateConfig(config);
  return config;
}

interface ValidatedConfig {
  readonly endpoint: string;
  readonly keyId: string;
  readonly sharedSecret: Buffer;
  readonly timeoutMs: number;
}

function configurationFailure(message: string): never {
  throw new PropertyPredatorExternalEventDeliveryError(
    'invalid_configuration', false, message,
  );
}

function validateConfig(config: PropertyPredatorExternalEventSenderConfig): ValidatedConfig {
  let endpoint: URL;
  try {
    endpoint = new URL(config.endpoint);
  } catch {
    return configurationFailure('Growth HQ external-event endpoint must be an absolute URL.');
  }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password
      || endpoint.pathname !== PROPERTY_PREDATOR_EXTERNAL_EVENT_PATH
      || endpoint.search || endpoint.hash) {
    return configurationFailure(
      `Growth HQ external-event endpoint must be HTTPS with exact path ${PROPERTY_PREDATOR_EXTERNAL_EVENT_PATH}.`,
    );
  }
  if (!KEY_ID.test(config.keyId)) {
    return configurationFailure('Growth HQ external-event key ID is invalid.');
  }
  if (!(config.sharedSecret instanceof Uint8Array)
      || config.sharedSecret.byteLength < 32 || config.sharedSecret.byteLength > 1_024) {
    return configurationFailure('Growth HQ external-event secret must contain 32 to 1024 bytes.');
  }
  const timeoutMs = config.timeoutMs ?? 5_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 30_000) {
    return configurationFailure('Growth HQ external-event timeout must be 250 to 30000 milliseconds.');
  }
  return Object.freeze({
    endpoint: endpoint.toString(), keyId: config.keyId,
    sharedSecret: Buffer.from(config.sharedSecret), timeoutMs,
  });
}

async function readBoundedResponse(response: Response): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_RESPONSE_BYTES) {
      throw new PropertyPredatorExternalEventDeliveryError(
        'unexpected_response', false, 'Growth HQ returned an invalid response.',
      );
    }
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new PropertyPredatorExternalEventDeliveryError(
          'unexpected_response', false, 'Growth HQ returned an oversized response.',
        );
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString('utf8');
}

function exactReceipt(
  value: unknown,
  status: 200 | 202,
  eventId: string,
): PropertyPredatorExternalEventDeliveryReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PropertyPredatorExternalEventDeliveryError(
      'unexpected_response', false, 'Growth HQ returned an invalid acceptance receipt.',
    );
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(',') !== 'accepted,disposition,replayed'
      || record.accepted !== true
      || (record.disposition !== 'shadow' && record.disposition !== 'projected')
      || typeof record.replayed !== 'boolean'
      || (status === 200) !== record.replayed
      || (status === 202) === record.replayed) {
    throw new PropertyPredatorExternalEventDeliveryError(
      'unexpected_response', false, 'Growth HQ returned a contradictory acceptance receipt.',
    );
  }
  return Object.freeze({
    accepted: true, disposition: record.disposition,
    replayed: record.replayed, eventId, acceptedStatus: status,
  });
}

function responseFailure(status: number): PropertyPredatorExternalEventDeliveryError {
  if (status === 401) {
    return new PropertyPredatorExternalEventDeliveryError(
      'authentication_rejected', false, 'Growth HQ rejected the event authentication.',
    );
  }
  if (status === 409) {
    return new PropertyPredatorExternalEventDeliveryError(
      'event_conflict', false, 'Growth HQ found the event ID with different immutable bytes.',
    );
  }
  if (status === 413 || status === 415 || status === 422) {
    return new PropertyPredatorExternalEventDeliveryError(
      'event_contract_rejected', false, 'Growth HQ rejected the event contract.',
    );
  }
  if (status === 429 || status >= 500) {
    return new PropertyPredatorExternalEventDeliveryError(
      'receiver_unavailable_retryable', true, 'Growth HQ is temporarily unavailable.',
    );
  }
  return new PropertyPredatorExternalEventDeliveryError(
    'unexpected_response', false, 'Growth HQ returned an unexpected response.',
  );
}

/**
 * Source-side exact sender. It performs one attempt only; the Property Predator
 * transactional outbox owns retry timing and reuses the same immutable event ID.
 */
export class PropertyPredatorExternalEventSender {
  private readonly config: ValidatedConfig;
  private readonly fetch: typeof fetch;
  private readonly nowSeconds: () => number;

  constructor(
    config: PropertyPredatorExternalEventSenderConfig,
    dependencies: PropertyPredatorExternalEventSenderDependencies = {},
  ) {
    this.config = validateConfig(config);
    this.fetch = dependencies.fetch ?? globalThis.fetch;
    this.nowSeconds = dependencies.nowSeconds ?? (() => Math.floor(Date.now() / 1_000));
  }

  async deliver(eventInput: PropertyPredatorExternalEvent): Promise<PropertyPredatorExternalEventDeliveryReceipt> {
    const event = parsePropertyPredatorExternalEvent(eventInput);
    const rawBody = Buffer.from(JSON.stringify(event), 'utf8');
    if (rawBody.byteLength > PROPERTY_PREDATOR_EXTERNAL_EVENT_MAX_BODY_BYTES) {
      throw new PropertyPredatorExternalEventDeliveryError(
        'event_contract_rejected', false, 'Property Predator event exceeds the receiver limit.',
      );
    }
    const now = this.nowSeconds();
    if (!Number.isSafeInteger(now) || now < 0) {
      return configurationFailure('Growth HQ external-event sender clock is invalid.');
    }
    const timestamp = String(now);
    const signature = createHmac('sha256', this.config.sharedSecret)
      .update(timestamp, 'ascii').update('.', 'ascii').update(rawBody).digest('hex');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    let response: Response;
    try {
      response = await this.fetch(this.config.endpoint, {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'content-length': String(rawBody.byteLength),
          'x-r72-key-id': this.config.keyId,
          'x-r72-timestamp': timestamp,
          'x-r72-signature': `${PROPERTY_PREDATOR_SIGNATURE_VERSION}=${signature}`,
        },
        body: rawBody,
      });
    } catch {
      throw new PropertyPredatorExternalEventDeliveryError(
        'outcome_unknown_retryable', true,
        'Growth HQ event attempt outcome is unknown; retry the same immutable event ID.',
      );
    } finally {
      clearTimeout(timeout);
    }
    const responseText = await readBoundedResponse(response);
    if (response.status !== 200 && response.status !== 202) throw responseFailure(response.status);
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    if (contentType !== 'application/json') throw responseFailure(0);
    let parsed: unknown;
    try { parsed = JSON.parse(responseText) as unknown; } catch { throw responseFailure(0); }
    return exactReceipt(parsed, response.status, event.id);
  }
}
