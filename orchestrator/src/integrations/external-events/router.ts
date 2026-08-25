import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import type { TLSSocket } from 'node:tls';
import {
  PROPERTY_PREDATOR_EXTERNAL_EVENT_MAX_BODY_BYTES,
  PropertyPredatorExternalEventBodyTooLargeError,
  PropertyPredatorExternalEventContractError,
} from './contracts.js';
import {
  type PgPropertyPredatorExternalEventShadowService,
  PropertyPredatorExternalEventReceiptConflictError,
} from './pg-service.js';
import {
  PropertyPredatorExternalEventAuthenticationError,
  verifyPropertyPredatorExternalEventSignature,
} from './signature.js';

export const PROPERTY_PREDATOR_EXTERNAL_EVENT_PATH =
  '/api/external-events/v1/property-predator' as const;

export interface PropertyPredatorExternalEventRouterBinding {
  readonly keyId: string;
  readonly sharedSecret: Uint8Array;
  /** Store is already bound to this key's trusted server-side workspace. */
  readonly store: Pick<PgPropertyPredatorExternalEventShadowService, 'record'>;
}

export interface PropertyPredatorExternalEventRouterOptions {
  /** HTTPS is required only for an exact NODE_ENV=production composition. */
  readonly production: boolean;
  /** Exact socket peer addresses allowed to assert X-Forwarded-Proto. */
  readonly trustedProxyAddresses?: readonly string[];
  readonly bindings: readonly PropertyPredatorExternalEventRouterBinding[];
}

export interface PropertyPredatorExternalEventBridgeMount {
  readonly enabled: boolean;
  readonly ready: boolean;
  /** Safe operator-facing reasons; never secrets or provider/database errors. */
  readonly blockers: readonly string[];
  readonly handle?: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
}

class ExternalEventRequestBodyTooLargeError extends Error {}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(encoded),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(encoded);
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
    if (matches.length !== 1) return undefined;
    return matches[0];
  }
  const value = req.headers[name];
  return typeof value === 'string' ? value : undefined;
}

function hasJsonContentType(req: IncomingMessage): boolean {
  const raw = exactSingleHeader(req, 'content-type');
  if (!raw) return false;
  const segments = raw.split(';').map((segment) => segment.trim().toLowerCase());
  if (segments[0] !== 'application/json') return false;
  return segments.slice(1).every((segment) => segment === 'charset=utf-8');
}

function isHttps(req: IncomingMessage, trustedProxyAddresses: ReadonlySet<string>): boolean {
  if ((req.socket as TLSSocket | undefined)?.encrypted === true) return true;
  const remoteAddress = req.socket?.remoteAddress;
  return typeof remoteAddress === 'string'
    && trustedProxyAddresses.has(remoteAddress)
    && exactSingleHeader(req, 'x-forwarded-proto') === 'https';
}

function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const declared = exactSingleHeader(req, 'content-length');
    const contentLength = declared === undefined ? undefined : Number(declared);

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
    const onData = (value: Buffer | string): void => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      total += chunk.byteLength;
      if (total > PROPERTY_PREDATOR_EXTERNAL_EVENT_MAX_BODY_BYTES) {
        fail(new ExternalEventRequestBodyTooLargeError());
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
    const onAborted = (): void => fail(new Error('external event request body aborted'));

    if (contentLength !== undefined
        && (!Number.isSafeInteger(contentLength)
          || contentLength < 0
          || contentLength > PROPERTY_PREDATOR_EXTERNAL_EVENT_MAX_BODY_BYTES)) {
      fail(new ExternalEventRequestBodyTooLargeError());
      return;
    }
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
  });
}

/** Build the exact Property Predator V1 POST handler from trusted key bindings. */
export function createPropertyPredatorExternalEventHandler(
  options: PropertyPredatorExternalEventRouterOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const trustedProxyAddresses = new Set(options.trustedProxyAddresses ?? []);
  for (const address of trustedProxyAddresses) {
    if (isIP(address) === 0) {
      throw new Error('trusted proxy addresses must be exact IPv4 or IPv6 addresses');
    }
  }
  const bindings = new Map<string, PropertyPredatorExternalEventRouterBinding>();
  for (const binding of options.bindings) {
    if (bindings.has(binding.keyId)) throw new Error('duplicate Property Predator external-event key ID');
    bindings.set(binding.keyId, Object.freeze({
      keyId: binding.keyId,
      sharedSecret: Buffer.from(binding.sharedSecret),
      store: binding.store,
    }));
  }
  if (bindings.size === 0) throw new Error('at least one Property Predator external-event key binding is required');

  return async (req, res): Promise<void> => {
    const requestUrl = new URL(req.url ?? '/', 'http://localhost');
    if (req.method !== 'POST'
        || requestUrl.pathname !== PROPERTY_PREDATOR_EXTERNAL_EVENT_PATH
        || requestUrl.search !== '') {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }
    if (options.production && !isHttps(req, trustedProxyAddresses)) {
      sendJson(res, 400, { error: 'https_required' });
      return;
    }
    if (!hasJsonContentType(req)) {
      sendJson(res, 415, { error: 'content_type_must_be_application_json' });
      return;
    }

    let rawBody: Buffer;
    try {
      rawBody = await readRawBody(req);
    } catch (error) {
      if (error instanceof ExternalEventRequestBodyTooLargeError) {
        sendJson(res, 413, { error: 'payload_too_large' });
        return;
      }
      sendJson(res, 503, { error: 'request_body_unavailable' });
      return;
    }

    const keyId = exactSingleHeader(req, 'x-r72-key-id');
    const timestamp = exactSingleHeader(req, 'x-r72-timestamp');
    const signature = exactSingleHeader(req, 'x-r72-signature');
    const binding = keyId === undefined ? undefined : bindings.get(keyId);
    if (keyId === undefined || !binding || timestamp === undefined || signature === undefined) {
      sendJson(res, 401, { error: 'authentication_failed' });
      return;
    }

    let verifiedSignature;
    try {
      verifiedSignature = verifyPropertyPredatorExternalEventSignature({
        rawBody,
        keyId,
        timestamp,
        signature,
        expectedKeyId: binding.keyId,
        sharedSecret: binding.sharedSecret,
      });
    } catch (error) {
      if (error instanceof PropertyPredatorExternalEventBodyTooLargeError) {
        sendJson(res, 413, { error: 'payload_too_large' });
        return;
      }
      if (error instanceof PropertyPredatorExternalEventAuthenticationError) {
        sendJson(res, 401, { error: 'authentication_failed' });
        return;
      }
      sendJson(res, 503, { error: 'external_event_bridge_unavailable' });
      return;
    }

    try {
      const result = await binding.store.record({ rawBody, verifiedSignature });
      sendJson(res, result.replayed ? 200 : 202, {
        accepted: true,
        disposition: 'shadow',
        replayed: result.replayed,
      });
    } catch (error) {
      if (error instanceof PropertyPredatorExternalEventBodyTooLargeError) {
        sendJson(res, 413, { error: 'payload_too_large' });
        return;
      }
      if (error instanceof PropertyPredatorExternalEventContractError) {
        sendJson(res, 422, { error: 'invalid_event_contract' });
        return;
      }
      if (error instanceof PropertyPredatorExternalEventReceiptConflictError) {
        sendJson(res, 409, { error: 'event_conflict' });
        return;
      }
      sendJson(res, 503, { error: 'external_event_store_unavailable' });
    }
  };
}
