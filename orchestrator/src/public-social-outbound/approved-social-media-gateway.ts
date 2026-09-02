import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  PropertyPredatorApprovedResourceTransport,
} from '../company-content-adapter/property-predator-resources.js';
import type {
  ZernioCalendarJobMaterial,
  ZernioCalendarMediaResolver,
} from './zernio-calendar-live.js';

export const PROPERTY_PREDATOR_APPROVED_SOCIAL_MEDIA_PATH =
  '/api/public/property-predator/approved-media/' as const;
export const PROPERTY_PREDATOR_APPROVED_SOCIAL_MEDIA_CONTRACT =
  'propertypredator.approved-social-media/v1' as const;

const TOKEN_CONTEXT = Buffer.from(
  'propertypredator:approved-social-media:v1\0',
  'utf8',
);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const STORAGE_KEY = /^\/api\/internal\/company-content\/assets\/([0-9a-f-]{36})\/file$/u;
const TOKEN = /^([A-Za-z0-9_-]{20,1800})\.([A-Za-z0-9_-]{43})$/u;
const SAFE_PUBLIC_HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;
const MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const DEFAULT_TTL_SECONDS = 900;
const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 3_600;

interface ApprovedMediaTokenPayload {
  readonly v: 1;
  readonly workspaceId: string;
  readonly jobId: string;
  readonly storageKey: string;
  readonly blobSha256: string;
  readonly mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  readonly expiresAt: number;
}

export interface ApprovedSocialMediaSigningConfig {
  readonly key: Buffer;
  readonly ttlSeconds: number;
}

export interface PropertyPredatorApprovedSocialMediaGateway {
  readonly contract: typeof PROPERTY_PREDATOR_APPROVED_SOCIAL_MEDIA_CONTRACT;
  handle(
    req: Readonly<{ method?: string }>,
    res: ApprovedSocialMediaHttpResponse,
    url: URL,
  ): Promise<void>;
}

export interface ApprovedSocialMediaHttpResponse {
  writeHead(statusCode: number, headers: Readonly<Record<string, string>>): unknown;
  end(body?: string | Uint8Array): unknown;
}

export class ApprovedSocialMediaGatewayError extends Error {
  constructor(readonly code: 'invalid_configuration' | 'invalid_media') {
    super(code);
    this.name = 'ApprovedSocialMediaGatewayError';
  }
}

function fail(code: ApprovedSocialMediaGatewayError['code']): never {
  throw new ApprovedSocialMediaGatewayError(code);
}

function signingKey(value: Uint8Array): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    fail('invalid_configuration');
  }
  return Buffer.from(value);
}

function ttlSeconds(value: number): number {
  if (!Number.isSafeInteger(value)
      || value < MIN_TTL_SECONDS || value > MAX_TTL_SECONDS) {
    fail('invalid_configuration');
  }
  return value;
}

function canonicalSigningKey(raw: string | undefined, required: boolean): Buffer | undefined {
  const value = raw?.trim() ?? '';
  if (!value) {
    if (required) fail('invalid_configuration');
    return undefined;
  }
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) fail('invalid_configuration');
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.byteLength !== 32 || decoded.toString('base64url') !== value) {
    fail('invalid_configuration');
  }
  return decoded;
}

/** Loads the one shared, time-limited URL-signing capability. */
export function loadApprovedSocialMediaSigningConfig(
  env: NodeJS.ProcessEnv,
  required = false,
): ApprovedSocialMediaSigningConfig | undefined {
  const key = canonicalSigningKey(
    env.PROPERTY_PREDATOR_PUBLIC_SOCIAL_MEDIA_SIGNING_KEY_BASE64URL,
    required,
  );
  if (!key) return undefined;
  const rawTtl = env.PROPERTY_PREDATOR_PUBLIC_SOCIAL_MEDIA_URL_TTL_SECONDS?.trim();
  const ttl = rawTtl ? Number(rawTtl) : DEFAULT_TTL_SECONDS;
  return Object.freeze({ key, ttlSeconds: ttlSeconds(ttl) });
}

function cleanPublicOrigin(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { fail('invalid_configuration'); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password
      || (url.port && url.port !== '443') || url.search || url.hash
      || (url.pathname !== '' && url.pathname !== '/')
      || !SAFE_PUBLIC_HOST.test(host)
      || host === 'localhost' || host.endsWith('.localhost')
      || host.endsWith('.local') || host.endsWith('.internal')) {
    fail('invalid_configuration');
  }
  return url;
}

function exactMedia(
  item: ZernioCalendarJobMaterial['media'][number],
): Readonly<{
  storageKey: string;
  versionId: string;
  blobSha256: string;
  mimeType: ApprovedMediaTokenPayload['mimeType'];
}> {
  const match = STORAGE_KEY.exec(item.storageKey);
  if (!match?.[1] || !UUID.test(match[1]) || !SHA256.test(item.blobSha256)
      || !MEDIA_TYPES.has(item.mimeType)) fail('invalid_media');
  return Object.freeze({
    storageKey: item.storageKey,
    versionId: match[1],
    blobSha256: item.blobSha256,
    mimeType: item.mimeType as ApprovedMediaTokenPayload['mimeType'],
  });
}

function signature(key: Buffer, encodedPayload: string): Buffer {
  return createHmac('sha256', key)
    .update(TOKEN_CONTEXT)
    .update(encodedPayload, 'ascii')
    .digest();
}

function tokenFor(key: Buffer, payload: ApprovedMediaTokenPayload): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${encoded}.${signature(key, encoded).toString('base64url')}`;
}

function parseToken(
  key: Buffer,
  raw: string,
  nowSeconds: number,
): Readonly<ApprovedMediaTokenPayload & { versionId: string }> | null {
  const match = TOKEN.exec(raw);
  if (!match?.[1] || !match[2]) return null;
  const expected = signature(key, match[1]);
  const presented = Buffer.from(match[2], 'base64url');
  if (presented.byteLength !== expected.byteLength
      || !timingSafeEqual(presented, expected)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8')) as unknown;
  } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const source = parsed as Record<string, unknown>;
  const keys = Object.keys(source).sort();
  const exactKeys = [
    'blobSha256', 'expiresAt', 'jobId', 'mimeType', 'storageKey', 'v', 'workspaceId',
  ].sort();
  if (keys.length !== exactKeys.length
      || keys.some((value, index) => value !== exactKeys[index])) return null;
  const storageKey = typeof source.storageKey === 'string' ? source.storageKey : '';
  const storageMatch = STORAGE_KEY.exec(storageKey);
  if (source.v !== 1 || typeof source.workspaceId !== 'string'
      || !UUID.test(source.workspaceId) || typeof source.jobId !== 'string'
      || !UUID.test(source.jobId) || !storageMatch?.[1] || !UUID.test(storageMatch[1])
      || typeof source.blobSha256 !== 'string' || !SHA256.test(source.blobSha256)
      || typeof source.mimeType !== 'string' || !MEDIA_TYPES.has(source.mimeType)
      || !Number.isSafeInteger(source.expiresAt)
      || (source.expiresAt as number) <= nowSeconds
      || (source.expiresAt as number) > nowSeconds + MAX_TTL_SECONDS) return null;
  return Object.freeze({
    v: 1,
    workspaceId: source.workspaceId,
    jobId: source.jobId,
    storageKey,
    versionId: storageMatch[1],
    blobSha256: source.blobSha256,
    mimeType: source.mimeType as ApprovedMediaTokenPayload['mimeType'],
    expiresAt: source.expiresAt as number,
  });
}

/**
 * Creates provider-fetchable URLs from immutable job media. The worker receives
 * only this signing capability; the source adapter bearer remains in Growth HQ.
 */
export function createApprovedSocialMediaUrlResolver(input: Readonly<{
  publicOrigin: string;
  signingKey: Uint8Array;
  ttlSeconds?: number;
  now?: () => Date;
}>): ZernioCalendarMediaResolver {
  const origin = cleanPublicOrigin(input.publicOrigin);
  const key = signingKey(input.signingKey);
  const ttl = ttlSeconds(input.ttlSeconds ?? DEFAULT_TTL_SECONDS);
  const now = input.now ?? (() => new Date());
  return Object.freeze({
    async resolve(request: Readonly<{
      workspaceId: string;
      jobId: string;
      media: ZernioCalendarJobMaterial['media'];
    }>) {
      if (!UUID.test(request.workspaceId) || !UUID.test(request.jobId)
          || !Array.isArray(request.media) || request.media.length > 10) {
        fail('invalid_media');
      }
      const current = now();
      if (!(current instanceof Date) || !Number.isFinite(current.getTime())) {
        fail('invalid_configuration');
      }
      const expiresAt = Math.floor(current.getTime() / 1_000) + ttl;
      return Object.freeze(request.media.map((item) => {
        const media = exactMedia(item);
        const token = tokenFor(key, Object.freeze({
          v: 1,
          workspaceId: request.workspaceId,
          jobId: request.jobId,
          storageKey: media.storageKey,
          blobSha256: media.blobSha256,
          mimeType: media.mimeType,
          expiresAt,
        }));
        return new URL(`${PROPERTY_PREDATOR_APPROVED_SOCIAL_MEDIA_PATH}${token}`, origin)
          .toString();
      }));
    },
  });
}

function hiddenNotFound(res: ApprovedSocialMediaHttpResponse): void {
  res.writeHead(404, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': '9',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end('Not found');
}

/**
 * Public, credential-free byte gateway for one exact approved asset. The URL
 * is the authority: it is time-limited and HMAC-bound to the immutable source
 * storage key, blob digest and MIME type. Every response is re-fetched through
 * the existing read-only company-content adapter and digest-verified there.
 */
export function createPropertyPredatorApprovedSocialMediaGateway(input: Readonly<{
  signingKey: Uint8Array;
  resources: Pick<PropertyPredatorApprovedResourceTransport, 'loadAsset'>;
  now?: () => Date;
}>): PropertyPredatorApprovedSocialMediaGateway {
  const key = signingKey(input.signingKey);
  if (!input.resources || typeof input.resources.loadAsset !== 'function') {
    fail('invalid_configuration');
  }
  const now = input.now ?? (() => new Date());
  return Object.freeze({
    contract: PROPERTY_PREDATOR_APPROVED_SOCIAL_MEDIA_CONTRACT,
    async handle(
      req: Readonly<{ method?: string }>,
      res: ApprovedSocialMediaHttpResponse,
      url: URL,
    ) {
      if ((req.method !== 'GET' && req.method !== 'HEAD') || url.search || url.hash
          || !url.pathname.startsWith(PROPERTY_PREDATOR_APPROVED_SOCIAL_MEDIA_PATH)) {
        hiddenNotFound(res);
        return;
      }
      const rawToken = url.pathname.slice(PROPERTY_PREDATOR_APPROVED_SOCIAL_MEDIA_PATH.length);
      const current = now();
      const parsed = current instanceof Date && Number.isFinite(current.getTime())
        ? parseToken(key, rawToken, Math.floor(current.getTime() / 1_000))
        : null;
      if (!parsed) {
        hiddenNotFound(res);
        return;
      }
      try {
        const asset = await input.resources.loadAsset(parsed.versionId, parsed.blobSha256);
        if (asset.sha256 !== parsed.blobSha256 || asset.mediaType !== parsed.mimeType) {
          hiddenNotFound(res);
          return;
        }
        res.writeHead(200, {
          'content-type': asset.mediaType,
          'content-length': String(asset.bytes.byteLength),
          etag: `"sha256-${asset.sha256}"`,
          'cache-control': 'private, no-store, max-age=0',
          'content-disposition': 'inline',
          'cross-origin-resource-policy': 'cross-origin',
          'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'none'; frame-ancestors 'none'; sandbox",
        });
        res.end(req.method === 'HEAD' ? undefined : Buffer.from(asset.bytes));
      } catch {
        hiddenNotFound(res);
      }
    },
  });
}

export function isPropertyPredatorApprovedSocialMediaPath(pathname: string): boolean {
  return pathname.startsWith(PROPERTY_PREDATOR_APPROVED_SOCIAL_MEDIA_PATH);
}
