/** Small HTTP helpers shared by the server and the MHP host mount. */

import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { WebinarError, type PgWebinarService } from './service.js';
import { verifyStreamWebhook } from './stream.js';

export const STREAM_WEBHOOK_ROUTE = '/api/webinars/stream-webhook';

/**
 * Client key for public rate limits. Render's Cloudflare edge overwrites
 * CF-Connecting-IP with the real client address (see portal/request-context.ts).
 */
export function webinarClientKey(req: IncomingMessage): string {
  const cf = req.headers['cf-connecting-ip'];
  return typeof cf === 'string' && /^[0-9a-f:.]{3,45}$/i.test(cf) ? cf : String(req.socket.remoteAddress ?? 'unknown');
}

function reply(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(body)), 'cache-control': 'no-store' });
  res.end(body);
}

/**
 * Cloudflare Stream webhook (video ready / error, including live recordings).
 * Verified with the shared secret and a five-minute window; the body hash is the
 * replay receipt, so a redelivery is acknowledged without being applied twice.
 */
export async function handleStreamWebhook(req: IncomingMessage, res: ServerResponse, service: PgWebinarService): Promise<boolean> {
  if (req.method !== 'POST') { reply(res, 405, { error: 'method_not_allowed' }); return true; }
  const secret = service.config.stream?.webhookSecret;
  if (!secret) { reply(res, 503, { error: 'webhook_not_configured' }); return true; }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 256 * 1024) { reply(res, 413, { error: 'too_large' }); return true; }
    chunks.push(chunk as Buffer);
  }
  const body = Buffer.concat(chunks);
  const header = req.headers['webhook-signature'];
  if (!verifyStreamWebhook(secret, typeof header === 'string' ? header : undefined, body, service.clock())) {
    reply(res, 401, { error: 'invalid_signature' });
    return true;
  }
  let video: Record<string, unknown>;
  try {
    video = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
  } catch {
    reply(res, 400, { error: 'invalid_json' });
    return true;
  }
  const status = (video.status ?? {}) as Record<string, unknown>;
  try {
    const outcome = await service.streamNotification(createHash('sha256').update(body).digest(), {
      uid: String(video.uid ?? ''),
      liveInput: typeof video.liveInput === 'string' ? video.liveInput : null,
      state: typeof status.state === 'string' ? status.state : 'unknown',
      readyToStream: video.readyToStream === true,
      duration: typeof video.duration === 'number' ? video.duration : null,
      errorReason: typeof status.errorReasonText === 'string' ? status.errorReasonText.slice(0, 200) : null,
    });
    reply(res, outcome === 'invalid' ? 400 : 200, { outcome });
  } catch (error) {
    reply(res, error instanceof WebinarError ? error.status : 503, { error: 'unavailable' });
  }
  return true;
}
