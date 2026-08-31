import { createHash } from 'node:crypto';
import {
  ZERNIO_CONNECTION_CALLBACK_URL,
  ZERNIO_CONNECTION_SECURITY_CONTRACT,
  ZERNIO_PILOT_NETWORKS,
  type ZernioPilotNetwork,
} from './zernio-connection-contract.js';

export const ZERNIO_LIVE_CONNECTION_CONTRACT = 'r72-zernio-live-connect-v1' as const;

export type ZernioLiveConnectionFailureCode =
  | 'billing_required'
  | 'rate_limited'
  | 'provider_rejected'
  | 'provider_unavailable'
  | 'invalid_provider_response';

export class ZernioLiveConnectionError extends Error {
  constructor(readonly code: ZernioLiveConnectionFailureCode) {
    super(code);
    this.name = 'ZernioLiveConnectionError';
  }
}

export interface ZernioLiveConnectionClient {
  readonly contract: typeof ZERNIO_LIVE_CONNECTION_CONTRACT;
  prepare(input: Readonly<{
    network: ZernioPilotNetwork;
    intentId: string;
  }>): Promise<Readonly<{
    authUrl: string;
    providerStateSha256: string;
    authUrlSha256: string;
    providerEffects: 'oauth_not_started';
  }>>;
}

export interface ZernioLiveConnectionOptions {
  readonly apiKey: string;
  readonly providerProfileId: string;
  readonly fetch: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/u;
const SECRET = /^[\x21-\x7e]{8,500}$/u;
const STATE = /^[\x21-\x7e]{8,2048}$/u;
const NETWORKS = new Set<unknown>(ZERNIO_PILOT_NETWORKS);
const AUTH_HOSTS = new Set([
  'zernio.com', 'www.zernio.com',
  'facebook.com', 'www.facebook.com',
  'instagram.com', 'www.instagram.com', 'api.instagram.com',
  'linkedin.com', 'www.linkedin.com',
]);

function fail(code: ZernioLiveConnectionFailureCode): never {
  throw new ZernioLiveConnectionError(code);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function callbackUrl(intentId: string): string {
  if (!UUID.test(intentId)) fail('provider_rejected');
  const url = new URL(ZERNIO_CONNECTION_CALLBACK_URL);
  url.searchParams.set('intent', intentId);
  return url.toString();
}

async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json') fail('invalid_provider_response');
  const declared = response.headers.get('content-length');
  if (declared !== null
      && (!/^[0-9]{1,10}$/u.test(declared)
        || Number(declared) > ZERNIO_CONNECTION_SECURITY_CONTRACT.maximumResponseBytes)) {
    fail('invalid_provider_response');
  }
  const reader = response.body?.getReader();
  if (!reader) fail('invalid_provider_response');
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    length += item.value.length;
    if (length > ZERNIO_CONNECTION_SECURITY_CONTRACT.maximumResponseBytes) {
      await reader.cancel().catch(() => undefined);
      fail('invalid_provider_response');
    }
    chunks.push(item.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    fail('invalid_provider_response');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('invalid_provider_response');
  }
  return parsed as Record<string, unknown>;
}

function safeAuthUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 24_000) fail('invalid_provider_response');
  let url: URL;
  try { url = new URL(value); } catch { fail('invalid_provider_response'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash
      || (url.port !== '' && url.port !== '443')
      || !AUTH_HOSTS.has(url.hostname.toLowerCase())) {
    fail('invalid_provider_response');
  }
  return url.toString();
}

export function createZernioLiveConnectionClient(
  options: ZernioLiveConnectionOptions,
): ZernioLiveConnectionClient {
  if (!options || typeof options !== 'object' || Array.isArray(options)
      || typeof options.apiKey !== 'string' || !SECRET.test(options.apiKey)
      || typeof options.providerProfileId !== 'string'
      || !PROVIDER_ID.test(options.providerProfileId)
      || typeof options.fetch !== 'function') {
    fail('provider_rejected');
  }
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs)
      || timeoutMs < ZERNIO_CONNECTION_SECURITY_CONTRACT.minimumTimeoutMs
      || timeoutMs > ZERNIO_CONNECTION_SECURITY_CONTRACT.maximumTimeoutMs) {
    fail('provider_rejected');
  }
  const apiKey = options.apiKey;
  const providerProfileId = options.providerProfileId;
  const fetchImpl = options.fetch;

  return Object.freeze({
    contract: ZERNIO_LIVE_CONNECTION_CONTRACT,
    async prepare(input: Readonly<{
      network: ZernioPilotNetwork;
      intentId: string;
    }>) {
      if (!input || typeof input !== 'object' || Array.isArray(input)
          || Object.keys(input).sort().join(',') !== 'intentId,network'
          || !NETWORKS.has(input.network)) {
        fail('provider_rejected');
      }
      const redirectUrl = callbackUrl(input.intentId);
      const endpoint = new URL(`/v1/connect/${input.network}`,
        ZERNIO_CONNECTION_SECURITY_CONTRACT.origin);
      endpoint.searchParams.set('profileId', providerProfileId);
      endpoint.searchParams.set('redirect_url', redirectUrl);
      // Zernio hosts secondary account selection. Growth HQ never receives
      // Facebook/LinkedIn tempToken or userProfile material.
      endpoint.searchParams.set('headless', 'false');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      timer.unref?.();
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'GET',
          headers: Object.freeze({
            authorization: `Bearer ${apiKey}`,
            accept: 'application/json',
          }),
          redirect: 'error',
          signal: controller.signal,
        });
      } catch {
        fail('provider_unavailable');
      } finally {
        clearTimeout(timer);
      }
      if (response.status === 402) {
        await response.body?.cancel().catch(() => undefined);
        fail('billing_required');
      }
      if (response.status === 429) {
        await response.body?.cancel().catch(() => undefined);
        fail('rate_limited');
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        fail(response.status >= 500 ? 'provider_unavailable' : 'provider_rejected');
      }
      const body = await boundedJson(response);
      const authUrl = safeAuthUrl(body.authUrl);
      if (typeof body.state !== 'string' || !STATE.test(body.state)) {
        fail('invalid_provider_response');
      }
      return Object.freeze({
        authUrl,
        providerStateSha256: sha256(body.state),
        authUrlSha256: sha256(authUrl),
        providerEffects: 'oauth_not_started' as const,
      });
    },
  });
}
