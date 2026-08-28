import { createHash } from 'node:crypto';
import type { CreateCompanyContentVersionCommand, CompanyContentKind } from '../company-content-pg/types.js';
import { canonicalCompanyContentJson } from '../company-content-pg/validation.js';

const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const HASH_SCHEMA = 'propertypredator.company-content/v1';
const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
const MAX_CATALOG_ITEMS = 500;
const JSON_MEDIA_TYPE = /^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json(?:\s*;\s*charset=utf-8)?$/iu;
const ALLOWED_ASSET_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const GENERATED_KINDS = new Set(['post', 'thread', 'email', 'script', 'article', 'ad', 'image']);
const AFFILIATE_MARKERS = [
  '{{link}}', '#ad', 'partner link', 'affiliate link', 'affiliate partner',
  'i earn a commission', 'commission if you', '?ref=', '&ref=',
];
const FIRST_PERSON_RESULT = /\b(?:i|i've|i’d|i'd)\s+(?:use|used|found|saved|made|earned|stopped|avoided|overpaid|offered|bought|sold|invested|negotiated|achieved)\b|\bmy\s+(?:deal|property|portfolio|offer|investment|result|return|yield)\b/iu;
const EMAIL_ADDRESS = /\b[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+\b/iu;
const UK_POSTCODE = /\b(?:GIR\s?0AA|[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2})\b/iu;
const PRIVATE_FIELD_MARKER = /(?:\{\{|\[|%)(?:customer|client|contact|lead)?[_. -]*(?:first[_. -]?name|last[_. -]?name|full[_. -]?name|email|phone|mobile|address)(?:\}\}|\]|%)/iu;
const PRIVATE_LABEL = /\b(?:customer|client|contact|lead)\s+(?:name|email|phone|mobile|address)\s*:/iu;

export type PropertyPredatorCompanyContentItemType = 'media' | 'asset' | 'generated';

export interface PropertyPredatorCompanyContentItem {
  readonly approvalId: string;
  readonly approvedAt: string;
  readonly blobSha256: string | null;
  readonly brandSha256: string;
  readonly contentSha256: string;
  readonly itemId: string;
  readonly itemType: PropertyPredatorCompanyContentItemType;
  readonly itemVersion: number;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly versionId: string;
  readonly assetFilePath: string | null;
}

export interface PropertyPredatorCompanyContentCatalog {
  readonly schemaVersion: 1;
  readonly brandSha256: string;
  readonly catalogSha256: string;
  readonly generatedAt: string;
  readonly itemCount: number;
  readonly items: readonly PropertyPredatorCompanyContentItem[];
}

export interface PropertyPredatorCatalogTransport {
  loadCatalog(): Promise<unknown>;
}

export class PropertyPredatorContentContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PropertyPredatorContentContractError';
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new PropertyPredatorContentContractError(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...allowed].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new PropertyPredatorContentContractError(`${label} has an unsupported field shape`);
  }
}

function text(value: unknown, label: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > maximum || (!allowEmpty && value.length === 0)) {
    throw new PropertyPredatorContentContractError(`${label} is invalid`);
  }
  return value;
}

function sha(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new PropertyPredatorContentContractError(`${label} is not a canonical SHA-256 digest`);
  }
  return value;
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || value !== value.toLowerCase() || !UUID.test(value)) {
    throw new PropertyPredatorContentContractError(`${label} must be a UUID`);
  }
  return value;
}

function instant(value: unknown, label: string): string {
  const candidate = text(value, label, 80);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(candidate)
      || !Number.isFinite(Date.parse(candidate))) {
    throw new PropertyPredatorContentContractError(`${label} must be an RFC3339 instant`);
  }
  return candidate;
}

function positiveInteger(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new PropertyPredatorContentContractError(`${label} must be a bounded positive integer`);
  }
  return value as number;
}

function nonNegativeInteger(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new PropertyPredatorContentContractError(`${label} must be a bounded non-negative integer`);
  }
  return value as number;
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function assertCompanyText(value: string, label: string): void {
  const folded = value.toLocaleLowerCase('en-GB');
  if (AFFILIATE_MARKERS.some((marker) => folded.includes(marker)) || FIRST_PERSON_RESULT.test(value)) {
    throw new PropertyPredatorContentContractError(`${label} contains affiliate or personal-result language`);
  }
}

function containsPhoneNumber(value: string): boolean {
  const candidates = value.match(/(?:\+|\b0)[\d\s().-]{8,}\d/gu) ?? [];
  return candidates.some((candidate) => {
    const digitCount = candidate.replace(/\D/gu, '').length;
    return digitCount >= 10 && digitCount <= 15;
  });
}

function assertNoCustomerPrivateData(payload: Readonly<Record<string, unknown>>): void {
  for (const value of Object.values(payload)) {
    if (typeof value !== 'string') continue;
    if (EMAIL_ADDRESS.test(value) || UK_POSTCODE.test(value) || containsPhoneNumber(value)
        || PRIVATE_FIELD_MARKER.test(value) || PRIVATE_LABEL.test(value)) {
      throw new PropertyPredatorContentContractError(
        'item.payload contains customer-private data or personalisation fields',
      );
    }
  }
}

function assertHttpsUrl(value: string, label: string): void {
  let url: URL;
  try { url = new URL(value); } catch { throw new PropertyPredatorContentContractError(`${label} is invalid`); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new PropertyPredatorContentContractError(`${label} must be a clean HTTPS URL`);
  }
  for (const key of url.searchParams.keys()) {
    if (key.toLowerCase() === 'ref' || key.toLowerCase().startsWith('affiliate')) {
      throw new PropertyPredatorContentContractError(`${label} contains referral attribution`);
    }
  }
}

function validatePayload(
  itemType: PropertyPredatorCompanyContentItemType,
  input: unknown,
  blobSha256: string | null,
): Readonly<Record<string, unknown>> {
  const payload = record(input, 'item.payload');
  if (itemType === 'media') {
    exactKeys(payload, ['active', 'body', 'category', 'kind', 'schema', 'title', 'type'], 'media payload');
    if (payload.active !== true || payload.type !== 'media' || payload.kind !== 'text' || payload.schema !== HASH_SCHEMA) {
      throw new PropertyPredatorContentContractError('media payload is not active company text');
    }
    const title = text(payload.title, 'media.title', 300);
    const body = text(payload.body, 'media.body', 20_000);
    text(payload.category, 'media.category', 100);
    assertCompanyText(title, 'media.title');
    assertCompanyText(body, 'media.body');
  } else if (itemType === 'asset') {
    exactKeys(payload, [
      'active', 'blob_sha256', 'bytes', 'caption', 'category', 'filename',
      'media_type', 'schema', 'title', 'type',
    ], 'asset payload');
    if (payload.active !== true || payload.type !== 'asset' || payload.schema !== HASH_SCHEMA) {
      throw new PropertyPredatorContentContractError('asset payload is not active company artwork');
    }
    const payloadBlob = sha(payload.blob_sha256, 'asset.blob_sha256');
    if (!blobSha256 || payloadBlob !== blobSha256) {
      throw new PropertyPredatorContentContractError('asset blob hash does not match its version');
    }
    const mediaType = text(payload.media_type, 'asset.media_type', 80);
    if (!ALLOWED_ASSET_TYPES.has(mediaType)) {
      throw new PropertyPredatorContentContractError('asset media type is not approved');
    }
    positiveInteger(payload.bytes, 'asset.bytes', 10 * 1024 * 1024);
    const title = text(payload.title, 'asset.title', 300);
    const caption = text(payload.caption, 'asset.caption', 2_000, true);
    text(payload.category, 'asset.category', 100);
    text(payload.filename, 'asset.filename', 200);
    assertCompanyText(title, 'asset.title');
    if (caption) assertCompanyText(caption, 'asset.caption');
  } else {
    exactKeys(payload, ['body', 'cta_url', 'kind', 'platform', 'schema', 'title', 'type'], 'generated payload');
    if (payload.type !== 'generated' || payload.schema !== HASH_SCHEMA
        || typeof payload.kind !== 'string' || !GENERATED_KINDS.has(payload.kind)) {
      throw new PropertyPredatorContentContractError('generated payload kind is not supported');
    }
    const title = text(payload.title, 'generated.title', 300);
    const body = text(payload.body, 'generated.body', 20_000);
    const cta = text(payload.cta_url, 'generated.cta_url', 500);
    text(payload.platform, 'generated.platform', 80, true);
    assertCompanyText(title, 'generated.title');
    assertCompanyText(body, 'generated.body');
    assertHttpsUrl(cta, 'generated.cta_url');
  }
  assertNoCustomerPrivateData(payload);
  return Object.freeze({ ...payload });
}

function parseItem(input: unknown, catalogBrandSha256: string): PropertyPredatorCompanyContentItem {
  const item = record(input, 'catalog item');
  const common = [
    'approvalId', 'approvedAt', 'blobSha256', 'brandSha256', 'contentSha256',
    'itemId', 'itemType', 'itemVersion', 'payload', 'versionId',
  ];
  const itemType = item.itemType;
  if (itemType !== 'media' && itemType !== 'asset' && itemType !== 'generated') {
    throw new PropertyPredatorContentContractError('catalog item type is unsupported');
  }
  exactKeys(item, itemType === 'asset' ? [...common, 'assetFilePath'] : common, 'catalog item');
  const brandSha256 = sha(item.brandSha256, 'item.brandSha256');
  if (brandSha256 !== catalogBrandSha256) {
    throw new PropertyPredatorContentContractError('catalog item brand hash is stale');
  }
  const blobSha256 = item.blobSha256 === null ? null : sha(item.blobSha256, 'item.blobSha256');
  if ((itemType === 'asset') !== (blobSha256 !== null)) {
    throw new PropertyPredatorContentContractError('catalog item blob provenance is inconsistent');
  }
  const payload = validatePayload(itemType, item.payload, blobSha256);
  const content = canonicalCompanyContentJson(payload);
  const contentSha256 = sha(item.contentSha256, 'item.contentSha256');
  if (digest(content) !== contentSha256) {
    throw new PropertyPredatorContentContractError('catalog item content hash failed verification');
  }
  const itemId = text(item.itemId, 'item.itemId', 200);
  if (!SAFE_SOURCE_ID.test(itemId)) {
    throw new PropertyPredatorContentContractError('item.itemId is not a safe source identity');
  }
  let assetFilePath: string | null = null;
  if (itemType === 'asset') {
    assetFilePath = text(item.assetFilePath, 'item.assetFilePath', 300);
    if (!/^\/api\/internal\/company-content\/assets\/[0-9a-f-]+\/file$/.test(assetFilePath)) {
      throw new PropertyPredatorContentContractError('asset file path is outside the company-content boundary');
    }
  }
  return Object.freeze({
    approvalId: uuid(item.approvalId, 'item.approvalId'),
    approvedAt: instant(item.approvedAt, 'item.approvedAt'),
    blobSha256,
    brandSha256,
    contentSha256,
    itemId,
    itemType,
    itemVersion: positiveInteger(item.itemVersion, 'item.itemVersion'),
    payload,
    versionId: uuid(item.versionId, 'item.versionId'),
    assetFilePath,
  });
}

export function parsePropertyPredatorCompanyContentCatalog(
  input: unknown,
): PropertyPredatorCompanyContentCatalog {
  const catalog = record(input, 'company-content catalog');
  exactKeys(catalog, [
    'brandSha256', 'catalogSha256', 'generatedAt', 'itemCount', 'items', 'schemaVersion',
  ], 'company-content catalog');
  if (catalog.schemaVersion !== 1) {
    throw new PropertyPredatorContentContractError('company-content schema version is unsupported');
  }
  const brandSha256 = sha(catalog.brandSha256, 'catalog.brandSha256');
  if (!Array.isArray(catalog.items) || catalog.items.length > MAX_CATALOG_ITEMS) {
    throw new PropertyPredatorContentContractError('company-content catalog is not a bounded item array');
  }
  const itemCount = nonNegativeInteger(catalog.itemCount, 'catalog.itemCount', MAX_CATALOG_ITEMS);
  if (itemCount !== catalog.items.length) {
    throw new PropertyPredatorContentContractError('company-content catalog item count does not match');
  }
  const items = catalog.items.map((item) => parseItem(item, brandSha256));
  const identities = new Set<string>();
  for (const item of items) {
    const identity = `${item.itemType}\u001f${item.itemId}\u001f${item.itemVersion}`;
    if (identities.has(identity)) {
      throw new PropertyPredatorContentContractError('company-content catalog repeats a source version');
    }
    identities.add(identity);
  }
  const manifestItems = items.map((item) => ({
    approvalId: item.approvalId,
    approvedAt: item.approvedAt,
    blobSha256: item.blobSha256,
    brandSha256: item.brandSha256,
    contentSha256: item.contentSha256,
    itemId: item.itemId,
    itemType: item.itemType,
    itemVersion: item.itemVersion,
    payload: item.payload,
    versionId: item.versionId,
    ...(item.assetFilePath === null ? {} : { assetFilePath: item.assetFilePath }),
  }));
  const manifest = { brandSha256, items: manifestItems, schemaVersion: 1 };
  const catalogSha256 = sha(catalog.catalogSha256, 'catalog.catalogSha256');
  if (digest(canonicalCompanyContentJson(manifest)) !== catalogSha256) {
    throw new PropertyPredatorContentContractError('company-content catalog hash failed verification');
  }
  return Object.freeze({
    schemaVersion: 1,
    brandSha256,
    catalogSha256,
    generatedAt: instant(catalog.generatedAt, 'catalog.generatedAt'),
    itemCount,
    items: Object.freeze(items),
  });
}

function mappedKind(item: PropertyPredatorCompanyContentItem): CompanyContentKind {
  if (item.itemType === 'asset') return 'image';
  if (item.itemType === 'media') return 'social_post';
  const kind = item.payload.kind;
  if (kind === 'email') return 'email';
  if (kind === 'script') return 'video';
  if (kind === 'article') return 'article';
  if (kind === 'image') return 'image';
  return 'social_post';
}

export function propertyPredatorItemToVersionCommand(
  catalog: PropertyPredatorCompanyContentCatalog,
  item: PropertyPredatorCompanyContentItem,
  commandKey: string,
  checkedAt: string,
  expiresAt: string,
): CreateCompanyContentVersionCommand {
  if (!catalog.items.some((candidate) => candidate.versionId === item.versionId
      && candidate.contentSha256 === item.contentSha256
      && candidate.brandSha256 === item.brandSha256)) {
    throw new PropertyPredatorContentContractError('source item is not part of the attested catalog');
  }
  const content = canonicalCompanyContentJson(item.payload);
  if (digest(content) !== item.contentSha256) {
    throw new PropertyPredatorContentContractError('source item changed after catalog validation');
  }
  const title = text(item.payload.title, 'item.payload.title', 300);
  return Object.freeze({
    commandKey,
    origin: 'imported',
    kind: mappedKind(item),
    title,
    contentMimeType: 'application/json',
    content,
    source: Object.freeze({
      system: 'propertypredator.company-content',
      itemId: `${item.itemType}:${item.itemId}`,
      version: String(item.itemVersion),
    }),
    blob: Object.freeze({
      storageKey: item.assetFilePath ?? `propertypredator:company-content:${item.versionId}`,
      sha256: item.blobSha256 ?? item.contentSha256,
    }),
    brand: Object.freeze({
      snapshotRef: `propertypredator:brand:${item.brandSha256}`,
      sha256: item.brandSha256,
    }),
    attestation: Object.freeze({
      catalogSha256: catalog.catalogSha256,
      checkedAt: instant(checkedAt, 'attestation.checkedAt'),
      expiresAt: instant(expiresAt, 'attestation.expiresAt'),
    }),
    metadata: Object.freeze({
      sourceApprovalId: item.approvalId,
      sourceApprovedAt: item.approvedAt,
      sourceVersionId: item.versionId,
      itemType: item.itemType,
      assetFilePath: item.assetFilePath,
    }),
  });
}

export class PropertyPredatorCompanyContentAdapter {
  constructor(private readonly transport: PropertyPredatorCatalogTransport) {}

  async catalog(): Promise<PropertyPredatorCompanyContentCatalog> {
    return parsePropertyPredatorCompanyContentCatalog(await this.transport.loadCatalog());
  }
}

export interface PropertyPredatorHttpCatalogOptions {
  readonly baseUrl: string;
  readonly clientId: string;
  readonly readToken: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly allowLocalHttp?: boolean;
}

export function createPropertyPredatorHttpCatalogTransport(
  options: PropertyPredatorHttpCatalogOptions,
): PropertyPredatorCatalogTransport {
  const base = new URL(options.baseUrl);
  const local = base.hostname === '127.0.0.1' || base.hostname === 'localhost';
  if ((base.protocol !== 'https:' && !(options.allowLocalHttp && local))
      || base.username || base.password || base.search || base.hash) {
    throw new PropertyPredatorContentContractError('company-content baseUrl is not an approved origin');
  }
  const clientId = text(options.clientId, 'company-content clientId', 100);
  const readToken = text(options.readToken, 'company-content readToken', 512);
  if (Buffer.byteLength(readToken, 'utf8') < 32) {
    throw new PropertyPredatorContentContractError('company-content readToken is too short');
  }
  const timeoutMs = options.timeoutMs ?? 8_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
    throw new PropertyPredatorContentContractError('company-content timeout is invalid');
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new PropertyPredatorContentContractError('company-content fetch implementation is unavailable');
  }
  const url = new URL('/api/internal/company-content/catalog', base);
  return Object.freeze({
    async loadCatalog(): Promise<unknown> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(url, {
          method: 'GET',
          headers: Object.freeze({
            accept: 'application/json',
            authorization: `Bearer ${readToken}`,
            'x-content-client': clientId,
          }),
          cache: 'no-store',
          redirect: 'error',
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new PropertyPredatorContentContractError(
            `company-content catalog returned HTTP ${response.status}`,
          );
        }
        if (!JSON_MEDIA_TYPE.test(response.headers.get('content-type') ?? '')) {
          throw new PropertyPredatorContentContractError(
            'company-content catalog media type is invalid',
          );
        }
        const declared = Number(response.headers.get('content-length') ?? 0);
        if (Number.isFinite(declared) && declared > MAX_CATALOG_BYTES) {
          throw new PropertyPredatorContentContractError('company-content catalog is too large');
        }
        const body = await response.text();
        if (Buffer.byteLength(body, 'utf8') > MAX_CATALOG_BYTES) {
          throw new PropertyPredatorContentContractError('company-content catalog is too large');
        }
        if (response.headers.get('etag') !== `"sha256-${digest(body)}"`) {
          throw new PropertyPredatorContentContractError(
            'company-content catalog ETag does not bind the exact response bytes',
          );
        }
        let parsed: unknown;
        try { parsed = JSON.parse(body) as unknown; } catch {
          throw new PropertyPredatorContentContractError('company-content catalog is not valid JSON');
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
            || response.headers.get('x-catalog-sha256')
              !== (parsed as Record<string, unknown>).catalogSha256
            || response.headers.get('x-source-observed-at')
              !== (parsed as Record<string, unknown>).generatedAt) {
          throw new PropertyPredatorContentContractError(
            'company-content catalog component headers do not match the response',
          );
        }
        return parsed;
      } finally {
        clearTimeout(timer);
      }
    },
  });
}
