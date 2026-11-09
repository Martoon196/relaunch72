import type { IncomingMessage, ServerResponse } from 'node:http';
import { MailgunWebhookAuthenticationError } from '../../mailgun-webhook-pg/types.js';
import {
  PROPERTY_PREDATOR_MAILGUN_INBOUND_MAX_BODY_BYTES,
  PropertyPredatorMailgunInboundBodyTooLargeError,
  PropertyPredatorMailgunInboundConflictError,
  PropertyPredatorMailgunInboundContractError,
  PropertyPredatorMailgunInboundUnmatchedError,
  type PropertyPredatorMailgunInboundIngressResult,
} from '../../property-predator-mailgun-inbound-pg/index.js';

export const PROPERTY_PREDATOR_MAILGUN_INBOUND_PATH =
  '/api/provider-webhooks/mailgun/inbound/owned-seed';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface PropertyPredatorMailgunInboundIngress {
  handle(rawBody: Uint8Array): Promise<PropertyPredatorMailgunInboundIngressResult>;
}

export interface PropertyPredatorMailgunInboundConfig {
  readonly enabled: boolean;
  readonly configurationReady: boolean;
  readonly blockers: readonly string[];
  readonly workspaceId: string | null;
  readonly providerConnectionId: string | null;
  readonly signingKey: Uint8Array | null;
}

export interface PropertyPredatorMailgunInboundMount {
  readonly enabled: boolean;
  readonly ready: boolean;
  readonly blockers: readonly string[];
  readonly handle?: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
}

function exactUuid(value: string | undefined): string | null {
  const candidate = value?.trim().toLowerCase() ?? '';
  return UUID.test(candidate) ? candidate : null;
}

export function loadPropertyPredatorMailgunInboundConfig(
  env: NodeJS.ProcessEnv,
): PropertyPredatorMailgunInboundConfig {
  const rawEnable = env.PROPERTY_PREDATOR_MAILGUN_INBOUND_ENABLED?.trim() ?? '';
  const attemptedEnable = rawEnable !== '' && rawEnable !== 'false';
  const enabled = rawEnable === 'true' || attemptedEnable;
  if (!enabled) return Object.freeze({
    enabled: false, configurationReady: true, blockers: Object.freeze([]),
    workspaceId: null, providerConnectionId: null, signingKey: null,
  });
  const blockers: string[] = [];
  if (rawEnable !== 'true') blockers.push('Mailgun inbound enablement must be exact true');
  if (env.MAILGUN_WEBHOOK_SIGNATURE_VERIFICATION_ENABLED?.trim() !== 'true') {
    blockers.push('Mailgun inbound signature verification is not explicitly enabled');
  }
  const workspaceId = exactUuid(env.PROPERTY_PREDATOR_PILOT_WORKSPACE_ID);
  if (!workspaceId) blockers.push('Mailgun inbound workspace binding is invalid');
  const providerConnectionId = exactUuid(env.PROPERTY_PREDATOR_MAILGUN_CONNECTION_ID);
  if (!providerConnectionId) blockers.push('Mailgun inbound provider binding is invalid');
  const rawSigningKey = env.MAILGUN_SIGNING_KEY ?? '';
  const signingKey = Buffer.from(rawSigningKey, 'utf8');
  if (signingKey.byteLength < 32 || signingKey.byteLength > 1_024) {
    blockers.push('Mailgun inbound signing key is missing or invalid');
  }
  return Object.freeze({
    enabled: true,
    configurationReady: blockers.length === 0,
    blockers: Object.freeze(blockers),
    workspaceId,
    providerConnectionId,
    signingKey: blockers.some((blocker) => blocker.includes('signing key'))
      ? null : signingKey,
  });
}

function send(res: ServerResponse, status: number, body: Readonly<Record<string, unknown>>): void {
  const output = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(output)),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(output);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (Number.isFinite(declared) && declared > PROPERTY_PREDATOR_MAILGUN_INBOUND_MAX_BODY_BYTES) {
      req.resume();
      reject(new PropertyPredatorMailgunInboundBodyTooLargeError());
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(Buffer.concat(chunks, total));
    };
    req.on('data', (raw: Buffer | string) => {
      if (settled) return;
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      total += chunk.byteLength;
      if (total > PROPERTY_PREDATOR_MAILGUN_INBOUND_MAX_BODY_BYTES) {
        req.resume();
        finish(new PropertyPredatorMailgunInboundBodyTooLargeError());
      } else chunks.push(chunk);
    });
    req.once('end', () => finish());
    req.once('aborted', () => finish(new Error('request aborted')));
    req.once('error', (error) => finish(error));
  });
}

function contentType(req: IncomingMessage): string {
  const raw = req.headers['content-type'];
  return (Array.isArray(raw) ? raw[0] : raw)?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

/**
 * Pilot replies intentionally reject attachments. Mailgun documents 406 as
 * terminal/not-applicable, so malformed or out-of-bound mail is not retried.
 */
export function createPropertyPredatorMailgunInboundHandler(
  ingress: PropertyPredatorMailgunInboundIngress,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res): Promise<void> => {
    if (contentType(req) !== 'application/x-www-form-urlencoded') {
      req.resume();
      send(res, 406, { received: false, error: 'not_applicable' });
      return;
    }
    try {
      const result = await ingress.handle(await readBody(req));
      send(res, 200, {
        received: true,
        replayed: result.replayed,
      });
    } catch (error) {
      if (error instanceof MailgunWebhookAuthenticationError) {
        send(res, 401, { received: false, error: 'invalid_signature' });
      } else if (error instanceof PropertyPredatorMailgunInboundBodyTooLargeError) {
        send(res, 406, { received: false, error: 'not_applicable' });
      } else if (error instanceof PropertyPredatorMailgunInboundContractError
          || error instanceof PropertyPredatorMailgunInboundUnmatchedError) {
        send(res, 406, { received: false, error: 'not_applicable' });
      } else if (error instanceof PropertyPredatorMailgunInboundConflictError) {
        send(res, 409, { received: false, error: 'evidence_conflict' });
      } else {
        send(res, 503, { received: false, error: 'temporarily_unavailable' });
      }
    }
  };
}
