/**
 * Bounded public-web fetching for inventory and research.
 *
 * - http/https only, default ports only unless explicitly allowed
 * - every hostname is resolved and every address checked against private,
 *   loopback, link-local, CGNAT, multicast and reserved ranges; the socket is
 *   pinned to the checked address so DNS rebinding cannot swap it afterwards
 * - redirects are followed manually (≤ 5) and each hop is revalidated
 * - response bodies are capped and requests time out
 *
 * Fetched content is untrusted data. Callers extract text from it; nothing in
 * it is ever treated as an instruction.
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP, BlockList } from 'node:net';
import http from 'node:http';
import https from 'node:https';

export interface FetchedResource {
  readonly url: string;
  readonly finalUrl: string;
  readonly status: number;
  readonly contentType: string;
  readonly body: Buffer;
  readonly truncated: boolean;
  readonly headers: Readonly<Record<string, string>>;
}

export class SafeFetchError extends Error {
  constructor(readonly kind: 'blocked' | 'invalid_url' | 'timeout' | 'too_large' | 'network' | 'redirects', message: string) {
    super(message);
    this.name = 'SafeFetchError';
  }
}

export interface FetchOptions {
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  readonly maxRedirects?: number;
  readonly accept?: string;
  readonly method?: 'GET' | 'HEAD';
  readonly headers?: Readonly<Record<string, string>>;
}

/** The single seam every outbound public fetch in the engine goes through. */
export interface FetchTransport {
  fetch(url: string, options?: FetchOptions): Promise<FetchedResource>;
}

// Separate lists: Node's BlockList matches IPv4 addresses against IPv4-mapped
// IPv6 rules, so a mapped range in a shared list would block every IPv4 host.
const BLOCKED_V4 = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) BLOCKED_V4.addSubnet(net, prefix, 'ipv4');
const BLOCKED_V6 = new BlockList();
for (const [net, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001::', 23],
  ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const) BLOCKED_V6.addSubnet(net, prefix, 'ipv6');

export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  if (family === 4) return BLOCKED_V4.check(address, 'ipv4');
  const lower = address.toLowerCase();
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (dotted) return BLOCKED_V4.check(dotted[1]!, 'ipv4');
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex) {
    const hi = parseInt(hex[1]!, 16), lo = parseInt(hex[2]!, 16);
    return BLOCKED_V4.check(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`, 'ipv4');
  }
  // Any other IPv4-compatible/mapped form is refused outright.
  if (/^(::ffff:0:|::ffff:|::)(\d|[0-9a-f]{1,4}:[0-9a-f]{1,4}$)/.test(lower) && lower !== '::') return true;
  return BLOCKED_V6.check(address, 'ipv6');
}

export function validatePublicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SafeFetchError('invalid_url', 'That address is not a valid web address.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new SafeFetchError('invalid_url', 'Only http and https addresses can be fetched.');
  if (url.username || url.password) throw new SafeFetchError('invalid_url', 'Addresses with embedded credentials are not fetched.');
  if (url.port && url.port !== '80' && url.port !== '443') throw new SafeFetchError('blocked', 'Only standard web ports can be fetched.');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new SafeFetchError('blocked', 'Private or local addresses cannot be fetched.');
  }
  if (isIP(host) && isBlockedAddress(host)) throw new SafeFetchError('blocked', 'Private or local addresses cannot be fetched.');
  url.hash = '';
  return url;
}

async function resolvePublic(host: string): Promise<{ address: string; family: 4 | 6 }> {
  const bare = host.replace(/^\[|\]$/g, '');
  if (isIP(bare)) {
    if (isBlockedAddress(bare)) throw new SafeFetchError('blocked', 'Private or local addresses cannot be fetched.');
    return { address: bare, family: isIP(bare) as 4 | 6 };
  }
  let records: { address: string; family: number }[];
  try {
    records = await dnsLookup(bare, { all: true, verbatim: true });
  } catch {
    throw new SafeFetchError('network', 'The website address could not be resolved.');
  }
  if (records.length === 0) throw new SafeFetchError('network', 'The website address could not be resolved.');
  // Any private answer fails the whole host: mixed answers are a rebinding signal.
  if (records.some((r) => isBlockedAddress(r.address))) throw new SafeFetchError('blocked', 'The website resolves to a private or local address.');
  const first = records[0]!;
  return { address: first.address, family: first.family === 6 ? 6 : 4 };
}

export const DEFAULT_FETCH_OPTIONS = Object.freeze({
  maxBytes: 2 * 1024 * 1024,
  timeoutMs: 12_000,
  maxRedirects: 5,
});

const USER_AGENT = 'Relaunch72-SEO-Blog/1.0 (+owner-configured content inventory)';

/** Production transport: guarded node:http(s) with address pinning. */
export class GuardedFetchTransport implements FetchTransport {
  async fetch(raw: string, options: FetchOptions = {}): Promise<FetchedResource> {
    const maxBytes = options.maxBytes ?? DEFAULT_FETCH_OPTIONS.maxBytes;
    const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_OPTIONS.timeoutMs;
    const maxRedirects = options.maxRedirects ?? DEFAULT_FETCH_OPTIONS.maxRedirects;
    let current = validatePublicUrl(raw);
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const pinned = await resolvePublic(current.hostname);
      const response = await this.once(current, pinned, maxBytes, timeoutMs, options);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.location;
        if (!location) return { ...response, url: raw };
        current = validatePublicUrl(new URL(location, current).toString());
        continue;
      }
      return { ...response, url: raw };
    }
    throw new SafeFetchError('redirects', 'The website redirected too many times.');
  }

  private once(url: URL, pinned: { address: string; family: 4 | 6 }, maxBytes: number, timeoutMs: number, options: FetchOptions): Promise<FetchedResource> {
    return new Promise((resolve, reject) => {
      const client = url.protocol === 'https:' ? https : http;
      const request = client.request(url, {
        method: options.method ?? 'GET',
        headers: {
          'user-agent': USER_AGENT,
          accept: options.accept ?? 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.1',
          'accept-encoding': 'identity',
          ...(options.headers ?? {}),
        },
        // Pin the connection to the address that passed the check.
        lookup: (_host, lookupOptions, callback) => {
          if ((lookupOptions as { all?: boolean }).all) {
            (callback as unknown as (e: Error | null, a: { address: string; family: number }[]) => void)(null, [{ address: pinned.address, family: pinned.family }]);
          } else {
            callback(null, pinned.address, pinned.family);
          }
        },
        timeout: timeoutMs,
      }, (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        response.on('data', (chunk: Buffer) => {
          if (truncated) return;
          size += chunk.length;
          if (size > maxBytes) {
            truncated = true;
            chunks.push(chunk.subarray(0, Math.max(0, chunk.length - (size - maxBytes))));
            response.destroy();
            finish();
            return;
          }
          chunks.push(chunk);
        });
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(deadline);
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(response.headers)) if (typeof v === 'string') headers[k] = v;
          resolve({
            url: url.toString(), finalUrl: url.toString(), status: response.statusCode ?? 0,
            contentType: String(response.headers['content-type'] ?? ''), body: Buffer.concat(chunks), truncated, headers,
          });
        };
        response.on('end', finish);
        response.on('error', (error) => {
          if (!done) {
            done = true;
            clearTimeout(deadline);
            reject(new SafeFetchError('network', `The website connection failed (${error.message}).`));
          }
        });
      });
      const deadline = setTimeout(() => request.destroy(new SafeFetchError('timeout', 'The website did not respond in time.')), timeoutMs);
      request.on('timeout', () => request.destroy(new SafeFetchError('timeout', 'The website did not respond in time.')));
      request.on('error', (error) => {
        clearTimeout(deadline);
        reject(error instanceof SafeFetchError ? error : new SafeFetchError('network', `The website connection failed (${error.message}).`));
      });
      request.end();
    });
  }
}

/** Test/offline transport: a fixed map of URL → response. Unknown URLs 404. */
export class StaticFetchTransport implements FetchTransport {
  readonly requests: string[] = [];
  constructor(private readonly pages: Readonly<Record<string, { status?: number; contentType?: string; body: string }>>) {}
  async fetch(raw: string, options: FetchOptions = {}): Promise<FetchedResource> {
    const url = validatePublicUrl(raw).toString();
    this.requests.push(url);
    const page = this.pages[url] ?? this.pages[raw];
    const body = Buffer.from(page?.body ?? 'Not found');
    const max = options.maxBytes ?? DEFAULT_FETCH_OPTIONS.maxBytes;
    return {
      url: raw, finalUrl: url, status: page ? page.status ?? 200 : 404, contentType: page?.contentType ?? 'text/html; charset=utf-8',
      body: body.subarray(0, max), truncated: body.length > max, headers: {},
    };
  }
}
