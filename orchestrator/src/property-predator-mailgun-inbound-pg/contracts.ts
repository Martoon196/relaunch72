import { TextDecoder } from 'node:util';
import type { MailgunWebhookSignatureFields } from '../mailgun-webhook-pg/types.js';
import { propertyPredatorMailgunReplyDigest } from '../providers/property-predator-mailgun-reply-correlation.js';
import {
  PROPERTY_PREDATOR_MAILGUN_INBOUND_MAX_BODY_BYTES,
  PROPERTY_PREDATOR_MAILGUN_INBOUND_MAX_MESSAGE_BYTES,
  PROPERTY_PREDATOR_MAILGUN_REPLY_DOMAIN,
  PROPERTY_PREDATOR_OWNED_OFFICE_EMAIL,
  PropertyPredatorMailgunInboundBodyTooLargeError,
  PropertyPredatorMailgunInboundContractError,
} from './types.js';

const SAFE_MESSAGE_ID = /^[^\u0000-\u001f\u007f<>]{1,498}$/u;
const CORRELATED_RECIPIENT = new RegExp(
  `^reply\\+([a-z2-7]{52})@${PROPERTY_PREDATOR_MAILGUN_REPLY_DOMAIN.replaceAll('.', '[.]')}$`,
);

export interface DecodedPropertyPredatorMailgunInboundForm {
  readonly fields: URLSearchParams;
  readonly signature: Readonly<MailgunWebhookSignatureFields>;
}

export interface ParsedPropertyPredatorMailgunInboundMessage {
  readonly correlationSha256: string;
  readonly providerMessageId: string;
  readonly normalizedSender: typeof PROPERTY_PREDATOR_OWNED_OFFICE_EMAIL;
  readonly normalizedRecipient: string;
  readonly subject: string;
  readonly bodyText: string;
}

function fail(message: string): never {
  throw new PropertyPredatorMailgunInboundContractError(message);
}

function one(fields: URLSearchParams, name: string): string {
  const values = fields.getAll(name);
  if (values.length !== 1) return fail(`Mailgun inbound ${name} must occur exactly once`);
  return values[0]!;
}

function safeEmail(value: string, label: string): string {
  if (value !== value.trim() || value.length < 3 || value.length > 320
      || !/^[^\s@]+@[^\s@]+$/u.test(value)
      || /[\u0000-\u001f\u007f]/u.test(value)) return fail(`${label} is invalid`);
  return value.toLowerCase();
}

function safeText(value: string, label: string, maximumBytes: number): string {
  const normalized = value.normalize('NFC').trim();
  if (!normalized || Buffer.byteLength(normalized, 'utf8') > maximumBytes
      || normalized.includes('\u0000')
      || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(normalized)) {
    return fail(`${label} is invalid`);
  }
  return normalized;
}

function messageId(rawHeaders: string): string {
  if (Buffer.byteLength(rawHeaders, 'utf8') > 32 * 1024) {
    return fail('Mailgun inbound message headers are too large');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(rawHeaders) as unknown;
  } catch {
    return fail('Mailgun inbound message headers are invalid');
  }
  if (!Array.isArray(decoded) || decoded.length > 200) {
    return fail('Mailgun inbound message headers are invalid');
  }
  const matches: string[] = [];
  for (const header of decoded) {
    if (!Array.isArray(header) || header.length !== 2
        || typeof header[0] !== 'string' || typeof header[1] !== 'string') {
      return fail('Mailgun inbound message headers are invalid');
    }
    if (header[0].toLowerCase() === 'message-id') matches.push(header[1]);
  }
  if (matches.length !== 1) return fail('Mailgun inbound Message-Id must occur exactly once');
  const wrapped = matches[0]!.trim();
  const canonical = wrapped.startsWith('<') && wrapped.endsWith('>')
    ? wrapped.slice(1, -1) : wrapped;
  if (!SAFE_MESSAGE_ID.test(canonical) || !canonical.includes('@')) {
    return fail('Mailgun inbound Message-Id is invalid');
  }
  return canonical;
}

/** Decode the bounded form only far enough to authenticate its exact signature fields. */
export function decodePropertyPredatorMailgunInboundForm(
  rawBody: Uint8Array,
): DecodedPropertyPredatorMailgunInboundForm {
  if (!(rawBody instanceof Uint8Array)) throw new TypeError('rawBody must be a Uint8Array');
  if (rawBody.byteLength > PROPERTY_PREDATOR_MAILGUN_INBOUND_MAX_BODY_BYTES) {
    throw new PropertyPredatorMailgunInboundBodyTooLargeError();
  }
  if (rawBody.byteLength === 0) return fail('Mailgun inbound body must not be empty');
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(rawBody);
  } catch {
    return fail('Mailgun inbound body must be valid UTF-8');
  }
  const fields = new URLSearchParams(decoded);
  return Object.freeze({
    fields,
    signature: Object.freeze({
      timestamp: one(fields, 'timestamp'),
      token: one(fields, 'token'),
      signature: one(fields, 'signature'),
    }),
  });
}

/** Parse only after the caller has authenticated `decoded.signature`. */
export function parsePropertyPredatorMailgunInboundMessage(
  decoded: DecodedPropertyPredatorMailgunInboundForm,
): ParsedPropertyPredatorMailgunInboundMessage {
  const attachmentCounts = decoded.fields.getAll('attachment-count');
  if (attachmentCounts.length > 1
      || (attachmentCounts.length === 1 && attachmentCounts[0] !== '0')
      || [...decoded.fields.keys()].some((name) =>
        name !== 'attachment-count' && /^attachment(?:-|$)/u.test(name))) {
    return fail('Mailgun inbound attachments are outside the owned-office proof boundary');
  }
  const sender = safeEmail(one(decoded.fields, 'sender'), 'Mailgun inbound sender');
  if (sender !== PROPERTY_PREDATOR_OWNED_OFFICE_EMAIL) {
    return fail('Mailgun inbound sender is outside the owned-office proof boundary');
  }
  const recipient = safeEmail(one(decoded.fields, 'recipient'), 'Mailgun inbound recipient');
  const correlation = CORRELATED_RECIPIENT.exec(recipient);
  if (!correlation) return fail('Mailgun inbound recipient is outside the proof reply boundary');
  const subject = safeText(one(decoded.fields, 'subject'), 'Mailgun inbound subject', 500);
  const stripped = decoded.fields.getAll('stripped-text');
  if (stripped.length > 1) return fail('Mailgun inbound stripped-text was duplicated');
  const body = stripped.length === 1 && stripped[0]!.trim()
    ? stripped[0]!
    : one(decoded.fields, 'body-plain');
  return Object.freeze({
    correlationSha256: propertyPredatorMailgunReplyDigest(correlation[1]!),
    providerMessageId: messageId(one(decoded.fields, 'message-headers')),
    normalizedSender: PROPERTY_PREDATOR_OWNED_OFFICE_EMAIL,
    normalizedRecipient: recipient,
    subject,
    bodyText: safeText(
      body,
      'Mailgun inbound body',
      PROPERTY_PREDATOR_MAILGUN_INBOUND_MAX_MESSAGE_BYTES,
    ),
  });
}
