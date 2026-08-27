import {
  CompanyAssetReleaseContractError,
  parseCompanyAssetReleaseBridge,
  type CompanyAssetRelease,
} from './domain.js';

const MAX_BRIDGE_BYTES = 512 * 1024;
const SAFE_CLIENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u;
const JSON_MEDIA_TYPE = /^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json$/iu;

export interface PropertyPredatorCompanyAssetBridgeTransport {
  loadRelease(): Promise<CompanyAssetRelease>;
}

export interface PropertyPredatorCompanyAssetBridgeTransportOptions {
  readonly baseUrl: string;
  readonly clientId: string;
  readonly readToken: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  /** Test-only escape hatch. Production callers must use HTTPS. */
  readonly allowLocalHttp?: boolean;
}

function transportError(message: string): CompanyAssetReleaseContractError {
  return new CompanyAssetReleaseContractError(`company asset bridge ${message}`);
}

function cleanBaseUrl(raw: string, allowLocalHttp: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw transportError('origin is invalid');
  }
  const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if ((url.protocol !== 'https:' && !(allowLocalHttp && local))
      || url.username || url.password || url.search || url.hash
      || (url.pathname !== '' && url.pathname !== '/')) {
    throw transportError('origin must be a clean HTTPS origin');
  }
  return url;
}

function clientId(raw: string): string {
  if (typeof raw !== 'string' || !SAFE_CLIENT_ID.test(raw)) {
    throw transportError('client identity is invalid');
  }
  return raw;
}

function scopedToken(raw: string): string {
  if (typeof raw !== 'string'
      || Buffer.byteLength(raw, 'utf8') < 32
      || Buffer.byteLength(raw, 'utf8') > 512
      || /[^\x21-\x7e]/u.test(raw)) {
    throw transportError('read credential is invalid');
  }
  return raw;
}

function timeout(raw: number | undefined): number {
  const value = raw ?? 8_000;
  if (!Number.isSafeInteger(value) || value < 100 || value > 30_000) {
    throw transportError('timeout is invalid');
  }
  return value;
}

function validJsonMediaType(raw: string | null): boolean {
  if (raw === null) return false;
  const parts = raw.split(';').map((part) => part.trim());
  const mediaType = parts.shift();
  if (!mediaType || !JSON_MEDIA_TYPE.test(mediaType)) return false;
  if (parts.length === 0) return true;
  return parts.length === 1 && /^charset=utf-8$/iu.test(parts[0]!);
}

type DeadlineRace = <T>(operation: Promise<T>) => Promise<T>;

async function boundedBody(response: Response, beforeDeadline: DeadlineRace): Promise<string> {
  const declaredRaw = response.headers.get('content-length');
  if (declaredRaw !== null) {
    if (!/^(?:0|[1-9][0-9]{0,9})$/u.test(declaredRaw)) {
      throw transportError('response length is invalid');
    }
    if (Number(declaredRaw) > MAX_BRIDGE_BYTES) {
      throw transportError('response exceeds the byte bound');
    }
  }
  if (!response.body) throw transportError('response body is unavailable');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const result = await beforeDeadline(reader.read());
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > MAX_BRIDGE_BYTES) throw transportError('response exceeds the byte bound');
      text += decoder.decode(result.value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    void reader.cancel().catch(() => { /* Nothing else can be trusted or recovered. */ });
    if (error instanceof CompanyAssetReleaseContractError) throw error;
    throw transportError('response is not valid UTF-8');
  } finally {
    try { reader.releaseLock(); } catch { /* A hostile pending read must not hold the caller open. */ }
  }
  if (bytes === 0) throw transportError('response body is empty');
  return text;
}

/**
 * Creates an uncomposed, read-only transport for the metadata bridge. The
 * returned object has no body-resource, generation, model or provider method.
 */
export function createPropertyPredatorCompanyAssetBridgeTransport(
  options: PropertyPredatorCompanyAssetBridgeTransportOptions,
): PropertyPredatorCompanyAssetBridgeTransport {
  const baseUrl = cleanBaseUrl(options.baseUrl, options.allowLocalHttp === true);
  const exactClientId = clientId(options.clientId);
  const exactReadToken = scopedToken(options.readToken);
  const timeoutMs = timeout(options.timeoutMs);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw transportError('fetch implementation is unavailable');
  const endpoint = new URL('/api/internal/company-content/bridge', baseUrl).href;

  return Object.freeze({
    async loadRelease(): Promise<CompanyAssetRelease> {
      const controller = new AbortController();
      let rejectDeadline: ((reason: CompanyAssetReleaseContractError) => void) | undefined;
      const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
      const timer = setTimeout(() => {
        controller.abort();
        rejectDeadline?.(transportError('request timed out'));
      }, timeoutMs);
      const beforeDeadline: DeadlineRace = async <T>(operation: Promise<T>): Promise<T> => (
        Promise.race([operation, deadline])
      );
      try {
        let response: Response;
        try {
          response = await beforeDeadline(fetchImpl(endpoint, {
            method: 'GET',
            headers: Object.freeze({
              accept: 'application/json',
              authorization: `Bearer ${exactReadToken}`,
              'x-content-client': exactClientId,
            }),
            cache: 'no-store',
            credentials: 'omit',
            redirect: 'error',
            referrerPolicy: 'no-referrer',
            signal: controller.signal,
          }));
        } catch (error) {
          if (error instanceof CompanyAssetReleaseContractError) throw error;
          throw transportError('request failed closed');
        }
        if (!(response instanceof Response)) throw transportError('response is invalid');
        if (!response.ok) throw transportError(`returned HTTP ${response.status}`);
        if (!validJsonMediaType(response.headers.get('content-type'))) {
          throw transportError('response media type is invalid');
        }
        const raw = await boundedBody(response, beforeDeadline);
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw) as unknown;
        } catch {
          throw transportError('response is not valid JSON');
        }
        return parseCompanyAssetReleaseBridge(parsed);
      } finally {
        clearTimeout(timer);
      }
    },
  });
}
