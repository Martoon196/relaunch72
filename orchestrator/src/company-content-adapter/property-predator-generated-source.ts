import { createHash } from 'node:crypto';
import { canonicalCompanyContentJson } from '../company-content-pg/validation.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const JSON_MEDIA_TYPE = /^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json/iu;
const MAX_RESPONSE_BYTES = 64 * 1024;

export interface PropertyPredatorGeneratedSourceTarget {
  readonly sourceItemId: string;
  readonly sourceVersionId: string;
  readonly sourceItemVersion: number;
  readonly contentSha256: string;
  readonly brandSha256: string;
}

export interface PropertyPredatorGeneratedSourceProof {
  readonly catalogSha256: string;
}

export interface PropertyPredatorGeneratedSourceRevalidator {
  verify(target: PropertyPredatorGeneratedSourceTarget): Promise<PropertyPredatorGeneratedSourceProof>;
}

export class PropertyPredatorGeneratedSourceError extends Error {
  constructor(readonly stage = 'validation', readonly status?: number) {
    super('Property Predator generated source could not be revalidated');
    this.name = 'PropertyPredatorGeneratedSourceError';
  }
}

function fail(stage?: string, status?: number): never { throw new PropertyPredatorGeneratedSourceError(stage, status); }

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function exactOrigin(raw: string, allowLocalHttp: boolean): URL {
  let url: URL;
  try { url = new URL(raw); } catch { fail(); }
  const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if ((url.protocol !== 'https:' && !(allowLocalHttp && local))
      || url.username || url.password || url.search || url.hash
      || (url.pathname !== '' && url.pathname !== '/')) fail();
  return url;
}

async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) fail();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > MAX_RESPONSE_BYTES) fail();
    chunks.push(next.value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; } catch { fail(); }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}

export function createPropertyPredatorGeneratedSourceRevalidator(options: Readonly<{
  baseUrl: string;
  clientId: string;
  readToken: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  allowLocalHttp?: boolean;
}>): PropertyPredatorGeneratedSourceRevalidator {
  const baseUrl = exactOrigin(options.baseUrl, options.allowLocalHttp === true);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u.test(options.clientId)
      || options.readToken !== options.readToken.trim()
      || Buffer.byteLength(options.readToken, 'utf8') < 32
      || Buffer.byteLength(options.readToken, 'utf8') > 512) fail();
  const timeoutMs = options.timeoutMs ?? 8_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) fail();
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') fail();

  return Object.freeze({
    async verify(target: PropertyPredatorGeneratedSourceTarget): Promise<PropertyPredatorGeneratedSourceProof> {
      if (!UUID.test(target.sourceItemId) || !UUID.test(target.sourceVersionId)
          || !Number.isSafeInteger(target.sourceItemVersion) || target.sourceItemVersion < 1
          || !SHA256.test(target.contentSha256) || !SHA256.test(target.brandSha256)) fail();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let stage = 'source_request';
      try {
        const endpoint = new URL(
          `/api/internal/company-content/generated/${encodeURIComponent(target.sourceVersionId)}`,
          baseUrl,
        );
        const response = await fetchImpl(endpoint, {
          method: 'GET',
          headers: Object.freeze({
            accept: 'application/json',
            authorization: `Bearer ${options.readToken}`,
            'x-content-client': options.clientId,
          }),
          cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
          signal: controller.signal,
        });
        if (!(response instanceof Response)) fail('source_response');
        if (response.status !== 200) fail('source_http', response.status);
        stage = 'source_headers';
        if (response.redirected
            || !JSON_MEDIA_TYPE.test(response.headers.get('content-type') ?? '')
            || !/(?:^|,)\s*no-store\s*(?:,|$)/iu.test(response.headers.get('cache-control') ?? '')) fail(stage);
        stage = 'source_body';
        const body = record(await boundedJson(response));
        const item = record(body.item);
        const payload = record(item.payload);
        const usage = record(item.usage);
        stage = 'source_integrity';
        if (body.schemaVersion !== 1 || item.status !== 'source_review_required'
            || item.draftId !== target.sourceItemId || item.versionId !== target.sourceVersionId
            || item.itemVersion !== target.sourceItemVersion
            || item.contentSha256 !== target.contentSha256 || item.brandSha256 !== target.brandSha256
            || payload.type !== 'generated' || payload.schema !== 'propertypredator.company-content/v1'
            || sha256(canonicalCompanyContentJson(payload)) !== target.contentSha256
            || typeof item.usageSha256 !== 'string' || !SHA256.test(item.usageSha256)
            || sha256(canonicalCompanyContentJson(usage)) !== item.usageSha256
            || response.headers.get('x-company-content-version') !== target.sourceVersionId
            || response.headers.get('x-content-sha256') !== target.contentSha256
            || response.headers.get('x-brand-sha256') !== target.brandSha256) fail(stage);
        return Object.freeze({
          catalogSha256: sha256(canonicalCompanyContentJson(Object.freeze({
            schema: 'propertypredator.generated-source-revalidation/v1',
            sourceItemId: target.sourceItemId,
            sourceVersionId: target.sourceVersionId,
            sourceItemVersion: target.sourceItemVersion,
            contentSha256: target.contentSha256,
            brandSha256: target.brandSha256,
            usageSha256: item.usageSha256,
          }))),
        });
      } catch (error) {
        if (error instanceof PropertyPredatorGeneratedSourceError && error.stage !== 'validation') throw error;
        fail(stage);
      } finally {
        clearTimeout(timer);
      }
    },
  });
}
