import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ZERNIO_INBOUND_WEBHOOK_MAXIMUM_BYTES,
  ZernioInboundAccountBindingError,
  ZernioInboundContractError,
  type PgZernioInboundRepository,
  type ZernioInboundWebhookCredential,
  verifyZernioInboundWebhook,
} from '../../zernio-inbound-pg/index.js';

export const PROPERTY_PREDATOR_ZERNIO_INBOUND_PATH = '/webhooks/zernio/inbound' as const;

export interface PropertyPredatorZernioInboundMount {
  readonly enabled: boolean;
  readonly ready: boolean;
  readonly blockers: readonly string[];
  readonly handle?: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
}

export interface PropertyPredatorZernioInboundConfig {
  readonly enabled: boolean;
  readonly configurationReady: boolean;
  readonly blockers: readonly string[];
  readonly workspaceId: string | null;
  readonly providerConnectionId: string | null;
  readonly providerProfileId: string | null;
  readonly credentialVersion: string | null;
  readonly webhookSecret: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function loadPropertyPredatorZernioInboundConfig(
  env: NodeJS.ProcessEnv,
): PropertyPredatorZernioInboundConfig {
  const rawEnabled = env.PROPERTY_PREDATOR_ZERNIO_INBOUND_ENABLED?.trim() ?? '';
  const attempted = rawEnabled !== '' && rawEnabled !== 'false';
  const enabled = rawEnabled === 'true' || attempted;
  if (!enabled) return Object.freeze({
    enabled: false, configurationReady: true, blockers: Object.freeze([]),
    workspaceId: null, providerConnectionId: null, providerProfileId: null,
    credentialVersion: null, webhookSecret: null,
  });
  const blockers: string[] = [];
  if (rawEnabled !== 'true') blockers.push('Zernio inbound enablement must be exact true');
  const workspaceId = env.PROPERTY_PREDATOR_PILOT_WORKSPACE_ID?.trim().toLowerCase() ?? '';
  if (!UUID.test(workspaceId)) blockers.push('Zernio inbound workspace binding is invalid');
  const providerConnectionId = env.PROPERTY_PREDATOR_ZERNIO_INBOUND_CONNECTION_ID
    ?.trim().toLowerCase() ?? '';
  if (!UUID.test(providerConnectionId)) {
    blockers.push('Zernio inbound connection binding is invalid');
  }
  const providerProfileId = env.PROPERTY_PREDATOR_ZERNIO_INBOUND_PROVIDER_PROFILE_ID?.trim() ?? '';
  if (!/^[^\u0000-\u001f\u007f]{1,512}$/u.test(providerProfileId)) {
    blockers.push('Zernio inbound profile binding is invalid');
  }
  const credentialVersion = env.ZERNIO_INBOUND_WEBHOOK_CREDENTIAL_VERSION?.trim() ?? '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(credentialVersion)) {
    blockers.push('Zernio inbound credential version is invalid');
  }
  const webhookSecret = env.ZERNIO_INBOUND_WEBHOOK_SECRET ?? '';
  if (!/^[\x21-\x7e]{16,500}$/u.test(webhookSecret)) {
    blockers.push('Zernio inbound webhook secret is missing or invalid');
  }
  if (!env.DATABASE_ZERNIO_INBOUND_WEBHOOK_URL?.trim()) {
    blockers.push('Zernio inbound dedicated database identity is missing');
  }
  return Object.freeze({
    enabled: true,
    configurationReady: blockers.length === 0,
    blockers: Object.freeze(blockers),
    workspaceId: UUID.test(workspaceId) ? workspaceId : null,
    providerConnectionId: UUID.test(providerConnectionId) ? providerConnectionId : null,
    providerProfileId: providerProfileId || null,
    credentialVersion: credentialVersion || null,
    webhookSecret: webhookSecret || null,
  });
}

export class PropertyPredatorZernioInboundIngress {
  constructor(private readonly dependencies: Readonly<{
    credential: ZernioInboundWebhookCredential;
    repository: Pick<PgZernioInboundRepository, 'record'>;
  }>) {}

  async handle(input: Readonly<{
    rawBody: Uint8Array;
    signatureHeader: string;
    eventIdHeader: string;
  }>) {
    return this.dependencies.repository.record(
      verifyZernioInboundWebhook(this.dependencies.credential, input),
    );
  }
}

function send(res: ServerResponse, status: number, body: Readonly<Record<string, unknown>>): void {
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
    if (Number.isFinite(declared) && declared > ZERNIO_INBOUND_WEBHOOK_MAXIMUM_BYTES) {
      req.resume(); finish(new Error('body_too_large')); return;
    }
    req.on('data', (raw: Buffer | string) => {
      if (settled) return;
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      size += chunk.byteLength;
      if (size > ZERNIO_INBOUND_WEBHOOK_MAXIMUM_BYTES) {
        chunks.length = 0; req.resume(); finish(new Error('body_too_large')); return;
      }
      chunks.push(chunk);
    });
    req.once('end', () => finish());
    req.once('aborted', () => finish(new Error('body_unavailable')));
    req.once('error', () => finish(new Error('body_unavailable')));
  });
}

export function createPropertyPredatorZernioInboundHandler(
  ingress: PropertyPredatorZernioInboundIngress,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res): Promise<void> => {
    if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
    const contentType = singleHeader(req, 'content-type')?.split(';', 1)[0]?.toLowerCase();
    const signatureHeader = singleHeader(req, 'x-zernio-signature');
    const eventIdHeader = singleHeader(req, 'x-zernio-event-id');
    if (contentType !== 'application/json' || !signatureHeader || !eventIdHeader) {
      req.resume(); return send(res, 400, { received: false, error: 'invalid_request' });
    }
    let rawBody: Buffer;
    try { rawBody = await readBody(req); }
    catch { return send(res, 413, { received: false, error: 'invalid_request' }); }
    try {
      const receipt = await ingress.handle({ rawBody, signatureHeader, eventIdHeader });
      return send(res, 200, {
        received: true,
        disposition: receipt.disposition,
        provider_effects: false,
      });
    } catch (error) {
      if (error instanceof ZernioInboundContractError) {
        if (error.kind === 'not_applicable') {
          return send(res, 200, { received: false, disposition: 'ignored' });
        }
        return send(res, error.kind === 'authentication' ? 401 : 400, {
          received: false,
          error: error.kind === 'authentication' ? 'invalid_signature_or_binding' : 'invalid_payload',
        });
      }
      if (error instanceof ZernioInboundAccountBindingError) {
        return send(res, 403, { received: false, error: 'account_not_bound' });
      }
      return send(res, 503, { received: false, error: 'temporarily_unavailable' });
    }
  };
}
