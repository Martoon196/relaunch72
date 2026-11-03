/** Permanent released-asset reads; no user session, generation or current-draft dependency. */
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const RELEASED_SEO_MEDIA_PREFIX = '/api/public/seo-blog/media/';
export interface PortalReleasedSeoMediaReader {
  readReleasedAsset(releaseId: string, expectedSha256: string): Promise<Readonly<{ releaseId: string; sha256: string; mimeType: 'image/jpeg'; bytes: Buffer }> | null>;
}
const PATH = /^\/api\/public\/seo-blog\/media\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/([0-9a-f]{64})\.jpg$/u;
function text(res: ServerResponse, code: number, body: string): void {
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' }); res.end(body);
}
export async function serveReleasedSeoMedia(req: IncomingMessage, res: ServerResponse, url: URL, reader: PortalReleasedSeoMediaReader | undefined): Promise<void> {
  const match = PATH.exec(url.pathname);
  if (req.method !== 'GET' || url.search || !match || !reader) return text(res, 404, 'Image not found.');
  const [, releaseId, sha256] = match;
  try {
    const result = await reader.readReleasedAsset(releaseId!, sha256!);
    if (!result) return text(res, 404, 'Image not found.');
    if (result.releaseId !== releaseId || result.sha256 !== sha256 || result.mimeType !== 'image/jpeg' || !Buffer.isBuffer(result.bytes)
      || result.bytes.length < 20 || result.bytes.length > 600_000 || result.bytes.readUInt16BE(0) !== 0xffd8
      || result.bytes.readUInt16BE(result.bytes.length - 2) !== 0xffd9
      || createHash('sha256').update(result.bytes).digest('hex') !== sha256) return text(res, 503, 'Image temporarily unavailable.');
    res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': String(result.bytes.length), 'cache-control': 'no-store',
      'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'" });
    res.end(result.bytes);
  } catch { text(res, 503, 'Image temporarily unavailable.'); }
}

/** Keep previously released URLs alive when the owner disables the content UI. */
export function createReleasedSeoMediaMount(origin: string, reader: PortalReleasedSeoMediaReader) {
  if (origin !== 'https://app.relaunch72.com') throw new Error('Unapproved released-media origin.');
  const hostname = new URL(origin).hostname;
  return { hostname, readiness: async (): Promise<readonly string[]> => [],
    async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
      if (req.headers.host?.toLowerCase() !== hostname) return text(res, 421, 'Misdirected request.');
      const url = new URL(req.url ?? '/', origin);
      if (!url.pathname.startsWith(RELEASED_SEO_MEDIA_PREFIX)) return text(res, 404, 'Page not found.');
      return serveReleasedSeoMedia(req, res, url, reader);
    } };
}
