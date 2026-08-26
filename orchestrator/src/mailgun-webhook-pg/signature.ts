import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  MailgunWebhookAuthenticationError,
  MailgunWebhookConfigurationError,
  type MailgunWebhookSignatureFields,
  type VerifiedMailgunWebhookSignature,
} from './types.js';

export const MAILGUN_WEBHOOK_SIGNATURE_TOLERANCE_SECONDS = 300;

const TIMESTAMP_PATTERN = /^(?:0|[1-9][0-9]{0,11})$/;
const TOKEN_PATTERN = /^[\x21-\x7e]{1,200}$/;
const SIGNATURE_PATTERN = /^[0-9a-f]{64}$/;

export interface VerifyMailgunWebhookSignatureInput {
  readonly fields: Readonly<MailgunWebhookSignatureFields>;
  /** Dedicated Mailgun HTTP signing key, decoded from trusted secret storage. */
  readonly signingKey: Uint8Array;
  readonly nowSeconds?: number;
}

function authenticationFailure(): never {
  throw new MailgunWebhookAuthenticationError();
}

function validateConfiguration(signingKey: Uint8Array, nowSeconds: number): void {
  if (!(signingKey instanceof Uint8Array)
      || signingKey.byteLength < 32
      || signingKey.byteLength > 1_024) {
    throw new MailgunWebhookConfigurationError(
      'Mailgun signing key must contain 32 to 1024 bytes',
    );
  }
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0) {
    throw new MailgunWebhookConfigurationError(
      'Mailgun verification clock must be a non-negative Unix second',
    );
  }
}

/** Verify Mailgun's HMAC-SHA256 over the untouched timestamp + token strings. */
export function verifyMailgunWebhookSignature(
  input: Readonly<VerifyMailgunWebhookSignatureInput>,
): VerifiedMailgunWebhookSignature {
  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1_000);
  validateConfiguration(input.signingKey, nowSeconds);
  const { timestamp, token, signature } = input.fields;
  if (!TIMESTAMP_PATTERN.test(timestamp)
      || !TOKEN_PATTERN.test(token)
      || !SIGNATURE_PATTERN.test(signature)) {
    return authenticationFailure();
  }

  const timestampSeconds = Number(timestamp);
  if (!Number.isSafeInteger(timestampSeconds)
      || Math.abs(nowSeconds - timestampSeconds) > MAILGUN_WEBHOOK_SIGNATURE_TOLERANCE_SECONDS) {
    return authenticationFailure();
  }

  const expected = createHmac('sha256', Buffer.from(input.signingKey))
    .update(timestamp, 'ascii')
    .update(token, 'ascii')
    .digest();
  const presented = Buffer.from(signature, 'hex');
  if (presented.byteLength !== expected.byteLength || !timingSafeEqual(presented, expected)) {
    return authenticationFailure();
  }

  return Object.freeze({
    timestampSeconds,
    signatureVersion: 'mailgun-hmac-sha256-v1',
  });
}
