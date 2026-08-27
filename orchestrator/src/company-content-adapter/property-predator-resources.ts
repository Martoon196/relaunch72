import { createHash } from 'node:crypto';
import { canonicalCompanyContentJson } from '../company-content-pg/validation.js';
import { PropertyPredatorContentContractError } from './property-predator.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const CLIENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u;
const MAX_VERSION_BYTES = 128 * 1024;
const MAX_ASSET_BYTES = 10 * 1024 * 1024;
const JSON_MEDIA_TYPE = /^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json(?:\s*;\s*charset=utf-8)?$/iu;
const ASSET_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

export type PropertyPredatorApprovedResourceType = 'media' | 'asset' | 'generated';

export interface PropertyPredatorApprovedVersionResource {
  readonly versionId: string;
  readonly itemId: string;
  readonly itemType: PropertyPredatorApprovedResourceType;
  readonly itemVersion: number;
  readonly approvalId: string;
  readonly approvedAt: string;
  readonly contentSha256: string;
  readonly blobSha256: string | null;
  readonly brandSha256: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly canonicalContent: string;
  readonly assetResourcePath: string | null;
}

export interface PropertyPredatorApprovedAssetResource {
  readonly versionId: string;
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
  readonly sha256: string;
  readonly bytes: Uint8Array;
}

export interface PropertyPredatorApprovedResourceTransport {
  loadVersion(
    versionId: string,
    expectedContentSha256?: string,
  ): Promise<PropertyPredatorApprovedVersionResource>;
  loadAsset(
    versionId: string,
    expectedBlobSha256: string,
  ): Promise<PropertyPredatorApprovedAssetResource>;
}

export interface PropertyPredatorApprovedResourceTransportOptions {
  readonly baseUrl: string;
  readonly clientId: string;
  readonly readToken: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  /** Test-only escape hatch. Production callers must use HTTPS. */
  readonly allowLocalHttp?: boolean;
}

function error(message: string): PropertyPredatorContentContractError {
  return new PropertyPredatorContentContractError(`company-content resource ${message}`);
}

function cleanOrigin(raw: string, allowLocalHttp: boolean): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw error('origin is invalid'); }
  const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if ((url.protocol !== 'https:' && !(allowLocalHttp && local))
      || url.username || url.password || url.search || url.hash
      || (url.pathname !== '' && url.pathname !== '/')) {
    throw error('origin must be a clean HTTPS origin');
  }
  return url;
}

function scopedCredential(raw: string, label: string): string {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') < 32
      || Buffer.byteLength(raw, 'utf8') > 512 || /[^\x21-\x7e]/u.test(raw)) {
    throw error(`${label} is invalid`);
  }
  return raw;
}

function exactVersionId(raw: unknown): string {
  if (typeof raw !== 'string' || !UUID.test(raw)) throw error('version id is invalid');
  return raw;
}

function sha256(raw: unknown, label: string): string {
  if (typeof raw !== 'string' || !SHA256.test(raw)) throw error(`${label} is invalid`);
  return raw;
}

function plainRecord(raw: unknown, label: string): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || (Object.getPrototypeOf(raw) !== Object.prototype
        && Object.getPrototypeOf(raw) !== null)) {
    throw error(`${label} is invalid`);
  }
  return raw as Record<string, unknown>;
}

function exactKeys(
  record: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(record).sort();
  const canonical = [...expected].sort();
  if (actual.length !== canonical.length
      || actual.some((key, index) => key !== canonical[index])) {
    throw error(`${label} shape is unsupported`);
  }
}

function boundedText(raw: unknown, label: string, maximum: number): string {
  if (typeof raw !== 'string' || raw.length < 1 || raw.length > maximum) {
    throw error(`${label} is invalid`);
  }
  return raw;
}

function timestamp(raw: unknown, label: string): string {
  const value = boundedText(raw, label, 80);
  if (!Number.isFinite(Date.parse(value))) throw error(`${label} is invalid`);
  return value;
}

function positiveInteger(raw: unknown, label: string): number {
  if (!Number.isSafeInteger(raw) || (raw as number) < 1 || (raw as number) > 2_147_483_647) {
    throw error(`${label} is invalid`);
  }
  return raw as number;
}

function digest(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function boundedBytes(response: Response, maximum: number): Promise<Uint8Array> {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^(?:0|[1-9][0-9]{0,9})$/u.test(declared)
      || Number(declared) > maximum)) {
    throw error('response length is invalid');
  }
  if (!response.body) throw error('response body is unavailable');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maximum) {
        void reader.cancel().catch(() => undefined);
        throw error('response exceeds its byte bound');
      }
      chunks.push(chunk.value);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* no-op */ }
  }
  if (total === 0) throw error('response body is empty');
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function parseVersion(
  raw: unknown,
  requestedVersionId: string,
  expectedContentSha256?: string,
): PropertyPredatorApprovedVersionResource {
  const envelope = plainRecord(raw, 'version envelope');
  exactKeys(envelope, ['item', 'schemaVersion'], 'version envelope');
  if (envelope.schemaVersion !== 1) throw error('schema version is unsupported');
  const item = plainRecord(envelope.item, 'version item');
  const itemType = item.itemType;
  if (itemType !== 'media' && itemType !== 'asset' && itemType !== 'generated') {
    throw error('item type is unsupported');
  }
  const commonKeys = [
    'approvalId', 'approvedAt', 'blobSha256', 'brandSha256', 'contentSha256',
    'itemId', 'itemType', 'itemVersion', 'payload', 'versionId',
  ];
  exactKeys(item, itemType === 'asset' ? [...commonKeys, 'assetFilePath'] : commonKeys, 'version item');
  const versionId = exactVersionId(item.versionId);
  if (versionId !== requestedVersionId) throw error('version identity changed in transit');
  const contentSha256 = sha256(item.contentSha256, 'content digest');
  if (expectedContentSha256 !== undefined
      && contentSha256 !== sha256(expectedContentSha256, 'expected content digest')) {
    throw error('content digest does not match the selected version');
  }
  const payload = plainRecord(item.payload, 'version payload');
  const canonicalContent = canonicalCompanyContentJson(payload);
  if (digest(canonicalContent) !== contentSha256) throw error('content digest failed verification');
  const blobSha256 = item.blobSha256 === null ? null : sha256(item.blobSha256, 'blob digest');
  let assetResourcePath: string | null = null;
  if (itemType === 'asset') {
    if (!blobSha256) throw error('asset blob digest is missing');
    assetResourcePath = boundedText(item.assetFilePath, 'asset resource path', 300);
    if (assetResourcePath !== `/api/internal/company-content/assets/${versionId}/file`) {
      throw error('asset resource path escaped its exact version boundary');
    }
  } else if (blobSha256 !== null) {
    throw error('non-asset item exposed a blob digest');
  }
  return Object.freeze({
    versionId,
    itemId: boundedText(item.itemId, 'item id', 200),
    itemType,
    itemVersion: positiveInteger(item.itemVersion, 'item version'),
    approvalId: exactVersionId(item.approvalId),
    approvedAt: timestamp(item.approvedAt, 'approval time'),
    contentSha256,
    blobSha256,
    brandSha256: sha256(item.brandSha256, 'brand digest'),
    payload: Object.freeze({ ...payload }),
    canonicalContent,
    assetResourcePath,
  });
}

/**
 * Exact-version, read-only source transport. It has no generation, affiliate,
 * provider, schedule, send or publish method. Every returned byte is bounded
 * and verified against the immutable source digest before use.
 */
export function createPropertyPredatorApprovedResourceTransport(
  options: PropertyPredatorApprovedResourceTransportOptions,
): PropertyPredatorApprovedResourceTransport {
  const base = cleanOrigin(options.baseUrl, options.allowLocalHttp === true);
  if (!CLIENT_ID.test(options.clientId)) throw error('client id is invalid');
  const readToken = scopedCredential(options.readToken, 'read credential');
  const timeoutMs = options.timeoutMs ?? 8_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
    throw error('timeout is invalid');
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw error('fetch implementation is unavailable');

  const withRequest = async <T>(
    path: string,
    consume: (response: Response) => Promise<T>,
  ): Promise<T> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response: Response;
      try {
        response = await fetchImpl(new URL(path, base), {
          method: 'GET',
          headers: Object.freeze({
            accept: path.endsWith('/file') ? 'image/png,image/jpeg,image/webp' : 'application/json',
            authorization: `Bearer ${readToken}`,
            'x-content-client': options.clientId,
          }),
          cache: 'no-store',
          credentials: 'omit',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
          signal: controller.signal,
        });
      } catch {
        throw error('request failed closed');
      }
      if (!(response instanceof Response) || !response.ok) {
        throw error(`request returned HTTP ${response instanceof Response ? response.status : 0}`);
      }
      try { return await consume(response); }
      catch (cause) {
        if (cause instanceof PropertyPredatorContentContractError) throw cause;
        throw error('response stream failed closed');
      }
    } finally {
      clearTimeout(timer);
    }
  };

  return Object.freeze({
    async loadVersion(versionIdRaw: string, expectedContentSha256?: string) {
      const versionId = exactVersionId(versionIdRaw);
      return withRequest(`/api/internal/company-content/versions/${versionId}`, async (response) => {
        if (!JSON_MEDIA_TYPE.test(response.headers.get('content-type') ?? '')) {
          throw error('version media type is invalid');
        }
        const bytes = await boundedBytes(response, MAX_VERSION_BYTES);
        let parsed: unknown;
        try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
        catch { throw error('version response is not canonical UTF-8 JSON'); }
        return parseVersion(parsed, versionId, expectedContentSha256);
      });
    },

    async loadAsset(versionIdRaw: string, expectedBlobSha256Raw: string) {
      const versionId = exactVersionId(versionIdRaw);
      const expectedBlobSha256 = sha256(expectedBlobSha256Raw, 'expected blob digest');
      return withRequest(`/api/internal/company-content/assets/${versionId}/file`, async (response) => {
        const mediaType = (response.headers.get('content-type') ?? '').split(';', 1)[0]!.trim().toLowerCase();
        if (!ASSET_MEDIA_TYPES.has(mediaType)) throw error('asset media type is unsupported');
        const bytes = await boundedBytes(response, MAX_ASSET_BYTES);
        if (digest(bytes) !== expectedBlobSha256) throw error('asset digest failed verification');
        const etag = response.headers.get('etag');
        if (etag !== `"sha256-${expectedBlobSha256}"`) throw error('asset ETag is not exact');
        return Object.freeze({
          versionId,
          mediaType: mediaType as PropertyPredatorApprovedAssetResource['mediaType'],
          sha256: expectedBlobSha256,
          bytes,
        });
      });
    },
  });
}
