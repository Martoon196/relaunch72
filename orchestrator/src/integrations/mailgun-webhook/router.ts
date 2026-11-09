import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  MAILGUN_WEBHOOK_MAX_BODY_BYTES,
  MailgunWebhookAuthenticationError,
  MailgunWebhookBodyTooLargeError,
  MailgunWebhookConfigurationError,
  MailgunWebhookContractError,
  MailgunWebhookEventConflictError,
  MailgunWebhookReplayError,
  MailgunWebhookUnmatchedDeliveryError,
  type MailgunWebhookIngressResult,
} from '../../mailgun-webhook-pg/index.js';

export const PROPERTY_PREDATOR_MAILGUN_WEBHOOK_PATH =
  '/api/provider-webhooks/mailgun/events';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface MailgunWebhookIngress {
  handle(rawBody: Uint8Array): Promise<Readonly<MailgunWebhookIngressResult>>;
}

export interface PropertyPredatorMailgunWebhookConfig {
  readonly enabled: boolean;
  readonly configurationReady: boolean;
  readonly blockers: readonly string[];
  readonly workspaceId: string | null;
  readonly providerConnectionId: string | null;
  /** Secret; never serialize or log. */
  readonly signingKey: Uint8Array | null;
}

export interface PropertyPredatorMailgunWebhookMount {
  readonly enabled: boolean;
  readonly ready: boolean;
  readonly blockers: readonly string[];
  readonly handle?: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
}

function exactUuid(value: string | undefined): string | null {
  const candidate = value?.trim().toLowerCase() ?? '';
  return UUID.test(candidate) ? candidate : null;
}

/**
 * A non-empty malformed opt-in remains visibly blocked rather than silently
 * becoming disabled. Missing/`false` is the only ordinary dark state.
 */
export function loadPropertyPredatorMailgunWebhookConfig(
  env: NodeJS.ProcessEnv,
): PropertyPredatorMailgunWebhookConfig {
  const rawEnable = env.PROPERTY_PREDATOR_MAILGUN_WEBHOOK_ENABLED?.trim() ?? '';
  const attemptedEnable = rawEnable !== '' && rawEnable !== 'false';
  const enabled = rawEnable === 'true' || attemptedEnable;
  if (!enabled) {
    return Object.freeze({
      enabled: false,
      configurationReady: true,
      blockers: Object.freeze([]),
      workspaceId: null,
      providerConnectionId: null,
      signingKey: null,
    });
  }

  const blockers: string[] = [];
  if (rawEnable !== 'true') blockers.push('Mailgun webhook enablement must be exact true');
  if (env.MAILGUN_WEBHOOK_SIGNATURE_VERIFICATION_ENABLED?.trim() !== 'true') {
    blockers.push('Mailgun webhook signature verification is not explicitly enabled');
  }
  const workspaceId = exactUuid(env.PROPERTY_PREDATOR_PILOT_WORKSPACE_ID);
  if (!workspaceId) blockers.push('Mailgun webhook workspace binding is invalid');
  const providerConnectionId = exactUuid(env.PROPERTY_PREDATOR_MAILGUN_CONNECTION_ID);
  if (!providerConnectionId) blockers.push('Mailgun webhook provider-connection binding is invalid');
  const rawSigningKey = env.MAILGUN_SIGNING_KEY ?? '';
  const signingKey = Buffer.from(rawSigningKey, 'utf8');
  if (signingKey.byteLength < 32 || signingKey.byteLength > 1_024) {
    blockers.push('Mailgun webhook signing key is missing or invalid');
  }
  return Object.freeze({
    enabled: true,
    configurationReady: blockers.length === 0,
    blockers: Object.freeze(blockers),
    workspaceId,
    providerConnectionId,
    signingKey: blockers.some((blocker) => blocker.includes('signing key'))
      ? null
      : signingKey,
  });
}

function sendJson(
  res: ServerResponse,
  statusCode: number,
  body: Readonly<Record<string, unknown>>,
  retryAfter = false,
): void {
  const serialized = JSON.stringify(body);
  res.writeHead(statusCode, {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(serialized)),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...(retryAfter ? { 'retry-after': '30' } : {}),
  });
  res.end(serialized);
}

class RequestBodyAbortedError extends Error {}

function readBoundedRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (Number.isFinite(declared) && declared > MAILGUN_WEBHOOK_MAX_BODY_BYTES) {
      req.resume();
      reject(new MailgunWebhookBodyTooLargeError());
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const cleanup = (): void => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      req.resume();
      reject(error);
    };
    const onData = (raw: Buffer | string): void => {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      total += chunk.byteLength;
      if (total > MAILGUN_WEBHOOK_MAX_BODY_BYTES) {
        fail(new MailgunWebhookBodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks, total));
    };
    const onError = (error: Error): void => fail(error);
    const onAborted = (): void => fail(new RequestBodyAbortedError());
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
  });
}

function isJson(req: IncomingMessage): boolean {
  const raw = req.headers['content-type'];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.split(';', 1)[0]?.trim().toLowerCase();
  return value === 'application/json';
}

export function createPropertyPredatorMailgunWebhookHandler(
  ingress: MailgunWebhookIngress,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res): Promise<void> => {
    if (!isJson(req)) {
      sendJson(res, 415, { error: 'unsupported_media_type' });
      return;
    }
    try {
      const result = await ingress.handle(await readBoundedRawBody(req));
      sendJson(res, 200, {
        received: true,
        replayed: result.replayed,
        event_type: result.eventType,
        effective_delivery_status: result.effectiveDeliveryStatus,
        suppression_recorded: result.suppressionRecorded,
        opt_out_recorded: result.optOutRecorded,
      });
    } catch (error) {
      if (error instanceof MailgunWebhookAuthenticationError) {
        sendJson(res, 401, { error: 'invalid_signature' });
      } else if (error instanceof MailgunWebhookBodyTooLargeError) {
        sendJson(res, 413, { error: 'payload_too_large' });
      } else if (error instanceof MailgunWebhookContractError) {
        sendJson(res, 400, { error: 'invalid_event' });
      } else if (error instanceof MailgunWebhookEventConflictError
          || error instanceof MailgunWebhookReplayError) {
        sendJson(res, 409, { error: 'event_conflict' });
      } else if (error instanceof MailgunWebhookUnmatchedDeliveryError
          || error instanceof MailgunWebhookConfigurationError
          || error instanceof RequestBodyAbortedError) {
        sendJson(res, 503, { error: 'webhook_temporarily_unavailable' }, true);
      } else {
        sendJson(res, 503, { error: 'webhook_temporarily_unavailable' }, true);
      }
    }
  };
}
