import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ZERNIO_ACCOUNT_WEBHOOK_MAXIMUM_BYTES,
  createZernioAccountWebhookCredential,
  verifyZernioAccountWebhook,
} from '../../public-social-outbound/index.js';
import {
  ZERNIO_SOCIAL_WEBHOOK_ROUTE,
  type PortalZernioSocialConnectionService,
} from '../../portal/zernio-social-connection-service.js';

export const PROPERTY_PREDATOR_ZERNIO_ACCOUNT_WEBHOOK_PATH =
  ZERNIO_SOCIAL_WEBHOOK_ROUTE;

export interface PropertyPredatorZernioAccountWebhookMount {
  readonly enabled: boolean;
  readonly ready: boolean;
  readonly blockers: readonly string[];
  readonly handle?: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
}

function send(res: ServerResponse, status: number, body: Readonly<Record<string, string>>): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(json)),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(json);
}

function singleHeader(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name];
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value) && value.length === 1) return value[0]!.trim();
  return null;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(Buffer.concat(chunks, size));
    };
    const declared = Number(req.headers['content-length'] ?? 0);
    if (Number.isFinite(declared) && declared > ZERNIO_ACCOUNT_WEBHOOK_MAXIMUM_BYTES) {
      req.resume();
      finish(new Error('body_too_large'));
      return;
    }
    req.on('data', (raw: Buffer | string) => {
      if (settled) return;
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      size += chunk.length;
      if (size > ZERNIO_ACCOUNT_WEBHOOK_MAXIMUM_BYTES) {
        chunks.length = 0;
        req.resume();
        finish(new Error('body_too_large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish());
    req.on('error', () => finish(new Error('body_unavailable')));
    req.on('aborted', () => finish(new Error('body_unavailable')));
  });
}

export function composePropertyPredatorZernioAccountWebhook(
  env: NodeJS.ProcessEnv,
  service: PortalZernioSocialConnectionService | undefined,
): PropertyPredatorZernioAccountWebhookMount {
  const configured = [
    env.ZERNIO_WEBHOOK_SECRET,
    env.ZERNIO_WEBHOOK_CREDENTIAL_VERSION,
  ].some((value) => Boolean(value?.trim()));
  if (!configured) return Object.freeze({ enabled: false, ready: false, blockers: Object.freeze([]) });
  const blockers: string[] = [];
  if (!service) blockers.push('Zernio connection database boundary is unavailable');
  let credential: ReturnType<typeof createZernioAccountWebhookCredential> | undefined;
  if (service) {
    try {
      credential = createZernioAccountWebhookCredential({
        workspaceId: env.PROPERTY_PREDATOR_PILOT_WORKSPACE_ID?.trim() ?? '',
        connectionId: service.providerConnectionId,
        providerProfileId: service.providerProfileId,
        credentialVersion: env.ZERNIO_WEBHOOK_CREDENTIAL_VERSION?.trim() ?? '',
        webhookSecret: env.ZERNIO_WEBHOOK_SECRET?.trim() ?? '',
      });
    } catch {
      blockers.push('Zernio webhook credential binding is invalid');
    }
  }
  if (!service || !credential || blockers.length > 0) {
    return Object.freeze({
      enabled: true,
      ready: false,
      blockers: Object.freeze(blockers),
    });
  }
  const boundService = service;
  const boundCredential = credential;
  return Object.freeze({
    enabled: true,
    ready: true,
    blockers: Object.freeze([]),
    async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
      if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
      const contentType = singleHeader(req, 'content-type')?.split(';', 1)[0]?.trim().toLowerCase();
      const signature = singleHeader(req, 'x-zernio-signature');
      const eventId = singleHeader(req, 'x-zernio-event-id');
      if (contentType !== 'application/json' || !signature || !eventId) {
        return send(res, 400, { error: 'invalid_request' });
      }
      let rawBody: Buffer;
      try { rawBody = await readBody(req); }
      catch { return send(res, 413, { error: 'invalid_request' }); }
      let verified;
      try {
        verified = verifyZernioAccountWebhook(boundCredential, {
          rawBody,
          signatureHeader: signature,
          eventIdHeader: eventId,
        });
      } catch {
        return send(res, 401, { error: 'invalid_signature_or_payload' });
      }
      const outcome = await boundService.recordWebhook(verified);
      if (!outcome.ok) {
        return send(res, outcome.kind === 'forbidden' ? 403 : 503, {
          error: 'receipt_unavailable',
        });
      }
      return send(res, 200, { status: outcome.disposition });
    },
  });
}
