import { createHmac, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import type { IncomingMessage } from 'node:http';

export type PortalProxyMode = 'render' | 'direct';

export interface PortalRequestContext {
  /** One correlation id for every database/service call made by this request. */
  readonly requestId: string;
  /** Keyed request/trace evidence; raw identifiers never enter abuse storage. */
  readonly requestHash: Buffer;
  /** Raw address is used only by the existing session metadata boundary. */
  readonly clientAddress?: string;
  /** Keyed low-entropy client-address evidence used by the abuse guard. */
  readonly sourceHash?: Buffer;
  /** Render/Cloudflare trace correlation only. Never an authority or limit key. */
  readonly cfRay?: string;
}

export interface PortalRequestContextResolverOptions {
  readonly hashSecret: string;
  readonly proxyMode: PortalProxyMode;
  readonly requestId?: () => string;
  /** Development-only direct-peer resolver. It is ignored in Render mode. */
  readonly directClientAddress?: (req: IncomingMessage) => string | undefined;
}

const CF_RAY = /^[A-Za-z0-9-]{1,96}$/u;

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const first = raw?.split(',', 1)[0]?.trim();
  return first || undefined;
}

function canonicalClientAddress(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const candidate = value.trim();
  const family = isIP(candidate);
  if (family === 0 || candidate.includes('%')) return undefined;
  if (family === 4) return candidate;
  try {
    const hostname = new URL(`http://[${candidate}]/`).hostname;
    return hostname.startsWith('[') && hostname.endsWith(']')
      ? hostname.slice(1, -1).toLowerCase()
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * HMAC rather than a plain digest is mandatory for enumerable values such as
 * IPv4 addresses and email addresses. The domain separator prevents a value
 * observed in one dimension from being correlated with another.
 */
export function portalAbuseHash(secret: string, domain: string, value: string): Buffer {
  if (!secret || !domain || !value) throw new Error('Portal abuse hash input is incomplete');
  return createHmac('sha256', secret)
    .update(`relaunch72/portal-abuse/${domain}/v1\u0000`)
    .update(value)
    .digest();
}

/**
 * Render terminates the trusted proxy chain and supplies the true client in
 * the first X-Forwarded-For value. Production deliberately has no socket or
 * untrusted-header fallback: missing/malformed evidence must fail closed.
 */
export function createPortalRequestContextResolver(
  options: PortalRequestContextResolverOptions,
): (req: IncomingMessage) => PortalRequestContext | null {
  if (options.hashSecret.length < 32) {
    throw new Error('Portal abuse hash secret must contain at least 32 characters');
  }
  return (req: IncomingMessage): PortalRequestContext | null => {
    const clientAddress = canonicalClientAddress(options.proxyMode === 'render'
      ? firstHeaderValue(req.headers['x-forwarded-for'])
      : options.directClientAddress?.(req));
    if (options.proxyMode === 'render' && !clientAddress) return null;

    const requestId = options.requestId?.() ?? randomUUID();
    const rawCfRay = firstHeaderValue(req.headers['cf-ray']);
    const cfRay = rawCfRay && CF_RAY.test(rawCfRay) ? rawCfRay : undefined;
    return Object.freeze({
      requestId,
      requestHash: portalAbuseHash(
        options.hashSecret,
        'request',
        cfRay ? `${requestId}\u0000cf-ray:${cfRay}` : requestId,
      ),
      ...(clientAddress ? {
        clientAddress,
        sourceHash: portalAbuseHash(options.hashSecret, 'source', clientAddress),
      } : {}),
      ...(cfRay ? { cfRay } : {}),
    });
  };
}
