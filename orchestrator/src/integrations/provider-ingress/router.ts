import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import type { TLSSocket } from 'node:tls';
import {
  MetaCommunicationsContractError,
  verifyMetaWebhookChallenge,
  type MetaSocialDmCredentialBundle,
  type MetaWhatsAppCredentialBundle,
} from '../../meta-communications/index.js';
import {
  ingestMetaSocialDmWebhook,
  type VerifiedMetaSocialDmInbound,
} from '../../social-dm-dark/index.js';
import {
  ingestMetaWhatsAppWebhook,
  type VerifiedMetaWhatsAppInbound,
} from '../../whatsapp-dark/index.js';
import {
  WHEREBY_WEBHOOK_MAX_BODY_BYTES,
  WherebyWebinarBridgeError,
  WherebyWebinarIngestService,
  WherebyWebinarRetryableError,
  WherebyWebhookAuthenticationError,
  WherebyWebhookContractError,
  verifyWherebyWebhook,
} from '../../whereby-webinar/index.js';

export const PROPERTY_PREDATOR_META_WHATSAPP_WEBHOOK_PATH =
  '/api/provider-webhooks/meta/whatsapp' as const;
export const PROPERTY_PREDATOR_META_FACEBOOK_WEBHOOK_PATH =
  '/api/provider-webhooks/meta/facebook' as const;
export const PROPERTY_PREDATOR_META_INSTAGRAM_WEBHOOK_PATH =
  '/api/provider-webhooks/meta/instagram' as const;
export const PROPERTY_PREDATOR_WHEREBY_WEBHOOK_PATH =
  '/api/provider-webhooks/whereby/events' as const;

const META_MAX_BODY_BYTES = 256 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;

export type PropertyPredatorProviderIngressPath =
  | typeof PROPERTY_PREDATOR_META_WHATSAPP_WEBHOOK_PATH
  | typeof PROPERTY_PREDATOR_META_FACEBOOK_WEBHOOK_PATH
  | typeof PROPERTY_PREDATOR_META_INSTAGRAM_WEBHOOK_PATH
  | typeof PROPERTY_PREDATOR_WHEREBY_WEBHOOK_PATH;

const PROVIDER_INGRESS_PATHS = new Set<string>([
  PROPERTY_PREDATOR_META_WHATSAPP_WEBHOOK_PATH,
  PROPERTY_PREDATOR_META_FACEBOOK_WEBHOOK_PATH,
  PROPERTY_PREDATOR_META_INSTAGRAM_WEBHOOK_PATH,
  PROPERTY_PREDATOR_WHEREBY_WEBHOOK_PATH,
]);

export function isPropertyPredatorProviderIngressPath(
  pathname: string,
): pathname is PropertyPredatorProviderIngressPath {
  return PROVIDER_INGRESS_PATHS.has(pathname);
}

export type MetaInboundDurableDisposition =
  | 'applied'
  | 'replayed'
  | 'conflict'
  | 'in_progress';

export type MetaVerifiedInboundEvent =
  | VerifiedMetaWhatsAppInbound
  | VerifiedMetaSocialDmInbound;

export interface MetaInboundDurableReceiptInput {
  readonly workspaceId: string;
  readonly connectionId: string;
  readonly providerId: 'meta_whatsapp_cloud' | 'meta_social_dm';
  readonly externalMessageId: string;
  /** Digest of the one exact authenticated HTTP body, before parsing. */
  readonly payloadSha256: string;
  /** Verified event. This is the conversion-inbox adapter's trusted input. */
  readonly event: MetaVerifiedInboundEvent;
}

/**
 * Production implementations must atomically fence
 * (workspaceId, connectionId, providerId, externalMessageId) to payloadSha256,
 * then enqueue/map the event into the conversion inbox in the same durable
 * transaction. `replayed` is valid only for identical authenticated bytes.
 */
export interface MetaInboundDurableCommandService {
  readonly workspaceId: string;
  readonly connectionId: string;
  recordAuthenticatedInbound(
    input: MetaInboundDurableReceiptInput,
  ): Promise<Readonly<{ disposition: MetaInboundDurableDisposition }>>;
}

export interface MetaInboundWebhookHandlerOptions {
  readonly path:
    | typeof PROPERTY_PREDATOR_META_WHATSAPP_WEBHOOK_PATH
    | typeof PROPERTY_PREDATOR_META_FACEBOOK_WEBHOOK_PATH
    | typeof PROPERTY_PREDATOR_META_INSTAGRAM_WEBHOOK_PATH;
  readonly credentials: MetaWhatsAppCredentialBundle | MetaSocialDmCredentialBundle;
  readonly commandService: MetaInboundDurableCommandService;
  /** This boundary ingests only. It can never execute an outbound provider call. */
  readonly providerEffectsEnabled: false;
  readonly emergencyPaused: true;
  readonly production: boolean;
  readonly trustedProxyAddresses?: readonly string[];
}

export interface WherebyInboundWebhookHandlerOptions {
  readonly webhookSecret: Uint8Array;
  readonly expectedSubdomain: string;
  readonly service: WherebyWebinarIngestService;
  /** This boundary ingests only. It can never create or modify a Whereby room. */
  readonly providerEffectsEnabled: false;
  readonly emergencyPaused: true;
  readonly production: boolean;
  readonly trustedProxyAddresses?: readonly string[];
  readonly nowSeconds?: () => number;
}

export interface PropertyPredatorProviderIngressMount {
  readonly enabled: boolean;
  readonly ready: boolean;
  readonly blockers: readonly string[];
  readonly paths: readonly PropertyPredatorProviderIngressPath[];
  ownsPath(pathname: string): boolean;
  readonly handle?: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
}

export interface PropertyPredatorProviderIngressEndpoint {
  readonly path: PropertyPredatorProviderIngressPath;
  readonly handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
}

class RequestBodyTooLargeError extends Error {}
class RequestBodyUnavailableError extends Error {}

function sendJson(
  res: ServerResponse,
  status: number,
  body: Readonly<Record<string, unknown>>,
  retryAfter = false,
): void {
  const encoded = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(encoded)),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...(retryAfter ? { 'retry-after': '30' } : {}),
  });
  res.end(encoded);
}

function sendText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

function exactSingleHeader(req: IncomingMessage, name: string): string | undefined {
  if (Array.isArray(req.rawHeaders) && req.rawHeaders.length > 0) {
    const matches: string[] = [];
    for (let index = 0; index < req.rawHeaders.length; index += 2) {
      if (req.rawHeaders[index]?.toLowerCase() === name) {
        const value = req.rawHeaders[index + 1];
        if (value !== undefined) matches.push(value);
      }
    }
    return matches.length === 1 ? matches[0] : undefined;
  }
  const value = req.headers[name];
  return typeof value === 'string' ? value : undefined;
}

function exactJsonContentType(req: IncomingMessage): string | undefined {
  const raw = exactSingleHeader(req, 'content-type');
  if (!raw) return undefined;
  const segments = raw.split(';').map((segment) => segment.trim().toLowerCase());
  return segments[0] === 'application/json'
      && segments.slice(1).every((segment) => segment === 'charset=utf-8')
    ? raw
    : undefined;
}

function trustedProxySet(addresses: readonly string[] | undefined): ReadonlySet<string> {
  const trusted = new Set(addresses ?? []);
  for (const address of trusted) {
    if (isIP(address) === 0) throw new Error('provider ingress trusted proxies must be exact IP addresses');
  }
  return trusted;
}

function isHttps(req: IncomingMessage, trustedProxies: ReadonlySet<string>): boolean {
  if ((req.socket as TLSSocket | undefined)?.encrypted === true) return true;
  const remoteAddress = req.socket?.remoteAddress;
  return typeof remoteAddress === 'string'
    && trustedProxies.has(remoteAddress)
    && exactSingleHeader(req, 'x-forwarded-proto') === 'https';
}

function readBoundedRawBody(req: IncomingMessage, maximumBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declaredValue = exactSingleHeader(req, 'content-length');
    const declared = declaredValue === undefined ? undefined : Number(declaredValue);
    if (declared !== undefined && (!Number.isSafeInteger(declared)
        || declared < 0 || declared > maximumBytes)) {
      req.resume();
      reject(new RequestBodyTooLargeError());
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const cleanup = (): void => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onUnavailable);
      req.off('aborted', onUnavailable);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      req.resume();
      reject(error);
    };
    const onData = (value: Buffer | string): void => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      total += chunk.byteLength;
      if (total > maximumBytes) {
        fail(new RequestBodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      if (settled) return;
      if (declared !== undefined && declared !== total) {
        fail(new RequestBodyUnavailableError());
        return;
      }
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks, total));
    };
    const onUnavailable = (): void => fail(new RequestBodyUnavailableError());
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onUnavailable);
    req.on('aborted', onUnavailable);
  });
}

function exactMetaPathBinding(
  path: MetaInboundWebhookHandlerOptions['path'],
  credentials: MetaInboundWebhookHandlerOptions['credentials'],
): void {
  if (path === PROPERTY_PREDATOR_META_WHATSAPP_WEBHOOK_PATH
      && credentials.kind !== 'meta_whatsapp_credentials') {
    throw new Error('Meta WhatsApp ingress requires WhatsApp credentials');
  }
  if (path === PROPERTY_PREDATOR_META_FACEBOOK_WEBHOOK_PATH
      && (credentials.kind !== 'meta_social_dm_credentials' || credentials.network !== 'facebook')) {
    throw new Error('Meta Facebook ingress requires Facebook credentials');
  }
  if (path === PROPERTY_PREDATOR_META_INSTAGRAM_WEBHOOK_PATH
      && (credentials.kind !== 'meta_social_dm_credentials' || credentials.network !== 'instagram')) {
    throw new Error('Meta Instagram ingress requires Instagram credentials');
  }
}

function queryValue(url: URL, key: string): string | undefined {
  const values = url.searchParams.getAll(key);
  return values.length === 1 ? values[0] : undefined;
}

function validMetaChallengeQuery(url: URL): boolean {
  const keys = [...url.searchParams.keys()];
  return keys.length === 3
    && new Set(keys).size === 3
    && keys.every((key) => ['hub.mode', 'hub.verify_token', 'hub.challenge'].includes(key));
}

/** Build an HTTPS, raw-body, durable-receipt Meta callback for one exact connection. */
export function createMetaInboundWebhookHandler(
  options: MetaInboundWebhookHandlerOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  if (options.providerEffectsEnabled !== false || options.emergencyPaused !== true) {
    throw new Error('Meta inbound must be outbound-dark and emergency-paused');
  }
  exactMetaPathBinding(options.path, options.credentials);
  if (options.commandService.workspaceId !== options.credentials.workspaceId
      || options.commandService.connectionId !== options.credentials.connectionId) {
    throw new Error('Meta ingress command service crossed its credential binding');
  }
  const trustedProxies = trustedProxySet(options.trustedProxyAddresses);
  return async (req, res): Promise<void> => {
    const requestUrl = new URL(req.url ?? '/', 'http://localhost');
    if (requestUrl.pathname !== options.path) {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }
    if (options.production && !isHttps(req, trustedProxies)) {
      sendJson(res, 400, { error: 'https_required' });
      return;
    }
    if (req.method === 'GET') {
      if (!validMetaChallengeQuery(requestUrl)) {
        sendText(res, 400, '');
        return;
      }
      let decision: Readonly<{ status: 200 | 400 | 403; body: string }>;
      try {
        decision = verifyMetaWebhookChallenge(options.credentials, {
          hubMode: queryValue(requestUrl, 'hub.mode'),
          hubVerifyToken: queryValue(requestUrl, 'hub.verify_token'),
          hubChallenge: queryValue(requestUrl, 'hub.challenge'),
        });
      } catch {
        sendText(res, 503, '');
        return;
      }
      sendText(res, decision.status, decision.body);
      return;
    }
    if (req.method !== 'POST' || requestUrl.search !== '') {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }
    const contentType = exactJsonContentType(req);
    if (!contentType) {
      sendJson(res, 415, { error: 'unsupported_media_type' });
      return;
    }
    const signature = exactSingleHeader(req, 'x-hub-signature-256');
    if (!signature) {
      sendJson(res, 401, { error: 'authentication_failed' });
      return;
    }
    let rawBody: Buffer;
    try {
      rawBody = await readBoundedRawBody(req, META_MAX_BODY_BYTES);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        sendJson(res, 413, { error: 'payload_too_large' });
      } else {
        sendJson(res, 503, { error: 'request_body_unavailable' }, true);
      }
      return;
    }
    let events: readonly MetaVerifiedInboundEvent[];
    try {
      events = options.credentials.kind === 'meta_whatsapp_credentials'
        ? ingestMetaWhatsAppWebhook({
            credentials: options.credentials,
            rawBody,
            xHubSignature256: signature,
            contentType,
          })
        : ingestMetaSocialDmWebhook({
            credentials: options.credentials,
            rawBody,
            xHubSignature256: signature,
            contentType,
          });
    } catch (error) {
      if (error instanceof MetaCommunicationsContractError
          && /signature|authentic/i.test(error.message)) {
        sendJson(res, 401, { error: 'authentication_failed' });
      } else if (error instanceof MetaCommunicationsContractError) {
        sendJson(res, 422, { error: 'invalid_event_contract' });
      } else {
        sendJson(res, 503, { error: 'provider_ingress_unavailable' }, true);
      }
      return;
    }
    const payloadSha256 = createHash('sha256').update(rawBody).digest('hex');
    let applied = 0;
    let replayed = 0;
    try {
      for (const event of events) {
        if (event.workspaceId !== options.credentials.workspaceId
            || event.connectionId !== options.credentials.connectionId) {
          throw new Error('verified event crossed its command-service binding');
        }
        const result = await options.commandService.recordAuthenticatedInbound({
          workspaceId: event.workspaceId,
          connectionId: event.connectionId,
          providerId: event.provider,
          externalMessageId: event.messageId,
          payloadSha256,
          event,
        });
        if (result.disposition === 'conflict') {
          sendJson(res, 409, { error: 'event_conflict' });
          return;
        }
        if (result.disposition === 'in_progress') {
          sendJson(res, 503, { error: 'event_in_progress' }, true);
          return;
        }
        if (result.disposition === 'applied') applied += 1;
        else if (result.disposition === 'replayed') replayed += 1;
        else throw new Error('durable command service returned an invalid disposition');
      }
    } catch {
      sendJson(res, 503, { error: 'provider_ingress_unavailable' }, true);
      return;
    }
    sendJson(res, applied > 0 ? 202 : 200, {
      accepted: true,
      applied,
      replayed,
      ignored: events.length === 0,
    });
  };
}

/** Build the exact raw-body Whereby attendance callback; no room API is present. */
export function createWherebyInboundWebhookHandler(
  options: WherebyInboundWebhookHandlerOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  if (options.providerEffectsEnabled !== false || options.emergencyPaused !== true) {
    throw new Error('Whereby inbound must be provider-dark and emergency-paused');
  }
  const secret = Uint8Array.from(options.webhookSecret);
  const trustedProxies = trustedProxySet(options.trustedProxyAddresses);
  return async (req, res): Promise<void> => {
    const requestUrl = new URL(req.url ?? '/', 'http://localhost');
    if (req.method !== 'POST' || requestUrl.pathname !== PROPERTY_PREDATOR_WHEREBY_WEBHOOK_PATH
        || requestUrl.search !== '') {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }
    if (options.production && !isHttps(req, trustedProxies)) {
      sendJson(res, 400, { error: 'https_required' });
      return;
    }
    if (!exactJsonContentType(req)) {
      sendJson(res, 415, { error: 'unsupported_media_type' });
      return;
    }
    const signatureHeader = exactSingleHeader(req, 'whereby-signature');
    if (!signatureHeader) {
      sendJson(res, 401, { error: 'authentication_failed' });
      return;
    }
    let rawBody: Buffer;
    try {
      rawBody = await readBoundedRawBody(req, WHEREBY_WEBHOOK_MAX_BODY_BYTES);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        sendJson(res, 413, { error: 'payload_too_large' });
      } else {
        sendJson(res, 503, { error: 'request_body_unavailable' }, true);
      }
      return;
    }
    try {
      const event = verifyWherebyWebhook({
        rawBody,
        signatureHeader,
        webhookSecret: secret,
        expectedSubdomain: options.expectedSubdomain,
        nowSeconds: options.nowSeconds?.(),
      });
      const result = await options.service.ingest(event);
      sendJson(res, result.disposition === 'replayed' ? 200 : 202, {
        accepted: true,
        disposition: result.disposition,
      });
    } catch (error) {
      if (error instanceof WherebyWebhookAuthenticationError) {
        sendJson(res, 401, { error: 'authentication_failed' });
      } else if (error instanceof WherebyWebhookContractError
          || error instanceof WherebyWebinarBridgeError) {
        sendJson(res, 422, { error: 'invalid_event_contract' });
      } else if (error instanceof WherebyWebinarRetryableError) {
        sendJson(res, 503, { error: 'event_temporarily_unavailable' }, true);
      } else {
        sendJson(res, 503, { error: 'provider_ingress_unavailable' }, true);
      }
    }
  };
}

/** Aggregate exact endpoints without introducing any outbound provider client. */
export function createPropertyPredatorProviderIngressMount(
  endpoints: readonly PropertyPredatorProviderIngressEndpoint[],
): PropertyPredatorProviderIngressMount {
  const handlers = new Map<PropertyPredatorProviderIngressPath, PropertyPredatorProviderIngressEndpoint['handle']>();
  for (const endpoint of endpoints) {
    if (handlers.has(endpoint.path)) throw new Error('provider ingress endpoint path is duplicated');
    handlers.set(endpoint.path, endpoint.handle);
  }
  if (handlers.size === 0) throw new Error('provider ingress requires at least one ready endpoint');
  const paths = Object.freeze([...handlers.keys()]);
  return Object.freeze({
    enabled: true,
    ready: true,
    blockers: Object.freeze([]),
    paths,
    ownsPath: (pathname: string) => handlers.has(pathname as PropertyPredatorProviderIngressPath),
    handle: async (req: IncomingMessage, res: ServerResponse) => {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      const handler = handlers.get(pathname as PropertyPredatorProviderIngressPath);
      if (!handler) {
        sendJson(res, 404, { error: 'not_found' });
        return;
      }
      await handler(req, res);
    },
  });
}

export function darkPropertyPredatorProviderIngressMount(
  enabled: boolean,
  blockers: readonly string[],
): PropertyPredatorProviderIngressMount {
  return Object.freeze({
    enabled,
    ready: false,
    blockers: Object.freeze([...blockers]),
    paths: Object.freeze([]),
    ownsPath: () => false,
  });
}

export function isSha256Digest(value: string): boolean {
  return SHA256.test(value);
}
