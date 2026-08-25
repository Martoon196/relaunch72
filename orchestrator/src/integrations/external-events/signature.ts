import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  PROPERTY_PREDATOR_EXTERNAL_EVENT_MAX_BODY_BYTES,
  PropertyPredatorExternalEventBodyTooLargeError,
} from './contracts.js';

export const PROPERTY_PREDATOR_SIGNATURE_VERSION = 'v1' as const;
export const PROPERTY_PREDATOR_SIGNATURE_TOLERANCE_SECONDS = 300;

const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TIMESTAMP_PATTERN = /^(?:0|[1-9][0-9]{0,11})$/;
const SIGNATURE_PATTERN = /^v1=[0-9a-f]{64}$/;

export class PropertyPredatorExternalEventAuthenticationError extends Error {
  constructor() {
    super('external event authentication failed');
    this.name = 'PropertyPredatorExternalEventAuthenticationError';
  }
}

export class PropertyPredatorExternalEventSignatureConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PropertyPredatorExternalEventSignatureConfigurationError';
  }
}

export interface VerifyPropertyPredatorExternalEventSignatureInput {
  /** Exact bytes read from the HTTP request, before JSON parsing or re-encoding. */
  readonly rawBody: Uint8Array;
  /** Exact X-R72-Key-Id header value. It is never trimmed or case-folded. */
  readonly keyId: string;
  /** Exact X-R72-Timestamp header value containing Unix seconds. */
  readonly timestamp: string;
  /** Exact X-R72-Signature header value: `v1=<lowercase hex>`. */
  readonly signature: string;
  /** Trusted connection configuration, not a request-body value. */
  readonly expectedKeyId: string;
  /** Decoded, dedicated HMAC secret. Must contain at least 32 bytes. */
  readonly sharedSecret: Uint8Array;
  /** Injectable clock for deterministic tests. Defaults to the current Unix second. */
  readonly nowSeconds?: number;
}

export interface VerifiedPropertyPredatorExternalEventSignature {
  readonly keyId: string;
  readonly timestampSeconds: number;
  readonly signatureVersion: typeof PROPERTY_PREDATOR_SIGNATURE_VERSION;
}

function authenticationFailure(): never {
  throw new PropertyPredatorExternalEventAuthenticationError();
}

function validateConfiguration(
  expectedKeyId: string,
  sharedSecret: Uint8Array,
  nowSeconds: number,
): void {
  if (typeof expectedKeyId !== 'string' || !KEY_ID_PATTERN.test(expectedKeyId)) {
    throw new PropertyPredatorExternalEventSignatureConfigurationError(
      'expectedKeyId must be a safe value of 1 to 64 characters',
    );
  }
  if (!(sharedSecret instanceof Uint8Array)
      || sharedSecret.byteLength < 32
      || sharedSecret.byteLength > 1_024) {
    throw new PropertyPredatorExternalEventSignatureConfigurationError(
      'sharedSecret must contain 32 to 1024 bytes',
    );
  }
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0) {
    throw new PropertyPredatorExternalEventSignatureConfigurationError(
      'nowSeconds must be a non-negative safe integer',
    );
  }
}

/**
 * Verify `HMAC-SHA256(secret, timestamp + "." + exactRawBody)`.
 *
 * The five-minute delivery timestamp prevents captured HTTP requests from being
 * replayed indefinitely. It is deliberately separate from the event's
 * `occurredAt`, so a durable old event can be retried with a fresh signature.
 */
export function verifyPropertyPredatorExternalEventSignature(
  input: VerifyPropertyPredatorExternalEventSignatureInput,
): VerifiedPropertyPredatorExternalEventSignature {
  if (!(input.rawBody instanceof Uint8Array)) {
    throw new TypeError('rawBody must be a Uint8Array');
  }
  if (input.rawBody.byteLength > PROPERTY_PREDATOR_EXTERNAL_EVENT_MAX_BODY_BYTES) {
    throw new PropertyPredatorExternalEventBodyTooLargeError();
  }

  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1_000);
  validateConfiguration(input.expectedKeyId, input.sharedSecret, nowSeconds);

  if (typeof input.keyId !== 'string'
      || !KEY_ID_PATTERN.test(input.keyId)
      || input.keyId !== input.expectedKeyId) {
    return authenticationFailure();
  }
  if (typeof input.timestamp !== 'string' || !TIMESTAMP_PATTERN.test(input.timestamp)) {
    return authenticationFailure();
  }
  const timestampSeconds = Number(input.timestamp);
  if (!Number.isSafeInteger(timestampSeconds)
      || Math.abs(nowSeconds - timestampSeconds) > PROPERTY_PREDATOR_SIGNATURE_TOLERANCE_SECONDS) {
    return authenticationFailure();
  }
  if (typeof input.signature !== 'string' || !SIGNATURE_PATTERN.test(input.signature)) {
    return authenticationFailure();
  }

  const expectedDigest = createHmac('sha256', Buffer.from(input.sharedSecret))
    .update(input.timestamp, 'ascii')
    .update('.', 'ascii')
    .update(input.rawBody)
    .digest();
  const presentedDigest = Buffer.from(input.signature.slice(3), 'hex');
  if (presentedDigest.byteLength !== expectedDigest.byteLength
      || !timingSafeEqual(presentedDigest, expectedDigest)) {
    return authenticationFailure();
  }

  return Object.freeze({
    keyId: input.keyId,
    timestampSeconds,
    signatureVersion: PROPERTY_PREDATOR_SIGNATURE_VERSION,
  });
}
