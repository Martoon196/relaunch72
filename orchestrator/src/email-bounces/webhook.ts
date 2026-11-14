/**
 * Postmark webhook for bounces, spam complaints and subscription changes.
 *
 *   POST /api/provider-webhooks/postmark/<source key>
 *
 * One handler serves every brand: the path names the configured source, and the
 * source decides the workspace. Postmark offers no payload signature, so the
 * request must carry the source's shared secret, either as the HTTP Basic
 * password Postmark's webhook form asks for or in the x-postmark-webhook-secret
 * header. A source with no secret configured is closed, never open.
 *
 * Postmark retries any non-2xx answer, so everything applied here is safe to
 * apply again, and an event is only remembered once its effects have succeeded.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { EmailBounceSource } from './config.js';
import { factBlockReason } from './policy.js';
import { parsePostmarkJson, readPostmarkWebhook } from './postmark-events.js';
import type { EmailBounceService } from './service.js';

export const POSTMARK_BOUNCE_WEBHOOK_PREFIX = '/api/provider-webhooks/postmark/';
export const POSTMARK_BOUNCE_WEBHOOK_MAX_BODY_BYTES = 256 * 1024;
export const POSTMARK_BOUNCE_WEBHOOK_SECRET_HEADER = 'x-postmark-webhook-secret';

const LIMITER_PURGE_ABOVE = 20_000, LIMITER_MAX_KEYS = 40_000;
/**
 * Per-caller fixed window. Its own cost is bounded whatever the callers do: an unauthenticated flood from many
 * addresses (one IPv6 allocation is enough) must not make each request scan the whole table, or grow it for ever.
 */
export class FixedWindowLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  private nextPurgeAt = 0;
  constructor(private readonly limit: number, private readonly windowMs: number) {}
  get size(): number { return this.hits.size; }
  allow(key: string, now: number): boolean {
    // Expired windows are swept at most once a second, not on every request.
    if (this.hits.size > LIMITER_PURGE_ABOVE && now >= this.nextPurgeAt) {
      this.nextPurgeAt = now + 1_000;
      for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
    }
    const hit = this.hits.get(key);
    if (!hit || hit.resetAt <= now) {
      this.hits.delete(key); this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      // Hard bound: the oldest windows are forgotten first, a quarter of the table in one pass (removing them
      // one at a time is slow on a large Map). A real sender's window is recent, so it is kept.
      if (this.hits.size > LIMITER_MAX_KEYS) {
        let excess = LIMITER_MAX_KEYS / 4;
        for (const k of this.hits.keys()) { if (excess-- <= 0) break; this.hits.delete(k); }
      }
      return true;
    }
    hit.count += 1;
    return hit.count <= this.limit;
  }
}

function send(res: ServerResponse, status: number, body: Readonly<Record<string, unknown>>, extra: Record<string, string> = {}): void {
  const serialized = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(serialized)),
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra });
  res.end(serialized);
}

function clientKey(req: IncomingMessage): string {
  // Render's Cloudflare edge overwrites CF-Connecting-IP with the real client address.
  const cf = req.headers['cf-connecting-ip'];
  return typeof cf === 'string' && /^[0-9a-f:.]{3,45}$/iu.test(cf) ? cf : String(req.socket?.remoteAddress ?? 'unknown');
}

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();
const sameSecret = (candidate: string, secret: string): boolean => timingSafeEqual(digest(candidate), digest(secret));

/** True only when the request carries this source's secret. The Basic user name must be the source key. */
export function postmarkWebhookAuthorized(req: IncomingMessage, source: Pick<EmailBounceSource, 'key' | 'webhookSecret'>): boolean {
  if (!source.webhookSecret) return false;
  const header = req.headers[POSTMARK_BOUNCE_WEBHOOK_SECRET_HEADER];
  if (typeof header === 'string' && header.length <= 400 && sameSecret(header, source.webhookSecret)) return true;
  const authorization = req.headers.authorization;
  if (typeof authorization !== 'string' || authorization.length > 800 || !/^Basic [A-Za-z0-9+/]+={0,2}$/u.test(authorization)) return false;
  const decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
  const split = decoded.indexOf(':');
  if (split < 0) return false;
  // Both halves are compared in constant time so neither leaks through timing.
  const user = sameSecret(decoded.slice(0, split), source.key), password = sameSecret(decoded.slice(split + 1), source.webhookSecret);
  return user && password;
}

class BodyTooLarge extends Error {}
async function readBody(req: IncomingMessage, maximum: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (Number.isFinite(declared) && declared > maximum) { req.resume(); throw new BodyTooLarge(); }
  const chunks: Buffer[] = []; let size = 0;
  for await (const raw of req) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as string);
    size += chunk.length;
    if (size > maximum) { req.resume(); throw new BodyTooLarge(); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

export interface PostmarkBounceWebhook {
  /** Returns false when the path is not a Postmark bounce webhook. */
  handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
}

export function createPostmarkBounceWebhook(input: { service: EmailBounceService; now?: () => number; log?: (line: string) => void;
  requestsPerMinute?: number; failedAuthPerMinute?: number }): PostmarkBounceWebhook {
  const { service } = input;
  const now = input.now ?? Date.now, log = input.log ?? (() => undefined);
  const requests = new FixedWindowLimiter(input.requestsPerMinute ?? 600, 60_000);
  const failures = new FixedWindowLimiter(input.failedAuthPerMinute ?? 20, 60_000);
  return {
    async handle(req, res, url) {
      if (!url.pathname.startsWith(POSTMARK_BOUNCE_WEBHOOK_PREFIX)) return false;
      const key = url.pathname.slice(POSTMARK_BOUNCE_WEBHOOK_PREFIX.length).replace(/\/+$/u, '');
      const source = /^[a-z0-9][a-z0-9-]{0,39}$/u.test(key) ? service.source(key) : undefined;
      if (!source) { send(res, 404, { error: 'not_found' }); return true; }
      // Nothing is read from an unauthenticated caller: the body is discarded unbuffered.
      const refuse = (status: number, body: Readonly<Record<string, unknown>>, extra: Record<string, string> = {}): true => {
        req.resume(); send(res, status, body, extra); return true;
      };
      if (req.method !== 'POST') return refuse(405, { error: 'method_not_allowed' }, { allow: 'POST' });
      const at = now(), client = clientKey(req);
      if (!requests.allow(`${source.key}\u0000${client}`, at)) return refuse(429, { error: 'slow_down' }, { 'retry-after': '60' });
      if (!source.webhookSecret) return refuse(503, { error: 'webhook_not_configured' }, { 'retry-after': '300' });
      if (!postmarkWebhookAuthorized(req, source)) {
        // Guessing is slowed per caller; a correct secret is never limited by wrong ones from elsewhere.
        if (!failures.allow(client, at)) return refuse(429, { error: 'slow_down' }, { 'retry-after': '60' });
        return refuse(401, { error: 'unauthorized' }, { 'www-authenticate': 'Basic realm="postmark-webhook"' });
      }
      const contentType = String(req.headers['content-type'] ?? '').split(';', 1)[0]!.trim().toLowerCase();
      if (contentType !== 'application/json') return refuse(415, { error: 'unsupported_media_type' });
      let payload: unknown;
      try { payload = parsePostmarkJson((await readBody(req, POSTMARK_BOUNCE_WEBHOOK_MAX_BODY_BYTES)).toString('utf8')); }
      catch (error) {
        send(res, error instanceof BodyTooLarge ? 413 : 400, { error: error instanceof BodyTooLarge ? 'payload_too_large' : 'invalid_json' });
        return true;
      }
      const reading = readPostmarkWebhook(payload);
      if (reading.outcome === 'invalid') { send(res, 400, { error: 'invalid_event' }); return true; }
      if (reading.outcome === 'ignored') { send(res, 200, { received: true, outcome: 'ignored' }); return true; }
      const event = reading.event;
      if (source.serverId && event.serverId !== source.serverId) {
        // The right secret on another server's webhook is a set-up mistake; refuse it loudly, apply nothing.
        log(JSON.stringify({ event: 'email.bounces.webhook_wrong_server', source: source.key }));
        send(res, 403, { error: 'wrong_server' });
        return true;
      }
      const streamKind = source.streams.get(event.stream);
      if (!streamKind) { send(res, 200, { received: true, outcome: 'ignored_stream' }); return true; }
      if (service.registry.wasSeen(source.key, event.eventId)) { send(res, 200, { received: true, outcome: event.kind, replayed: true }); return true; }
      let blocked = false;
      try {
        if (event.kind === 'resubscribed') {
          service.registry.release(source.workspaceId, source.key, event.stream, event.email);
          // The provider's explicit re-subscribe lifts a durable unsubscribe from this source; never a bounce or complaint.
          await service.ledger?.lift({ workspaceId: source.workspaceId, sourceKey: source.key, email: event.email, eventId: event.eventId, at: event.at });
        } else {
          const result = service.registry.record(source.workspaceId, { sourceKey: source.key, stream: event.stream, id: event.eventId,
            kind: event.kind, email: event.email, at: event.at }, event.counts);
          blocked = result.marketingBlock !== null;
          // The lasting stop follows what THIS event says, never an older block or a tally: a hard bounce, a spam
          // report or an unsubscribe is final in itself. A soft bounce, even the one that tips the address over the
          // limit, is a temporary state held in this process and lifts by itself; it never rewrites a person's record.
          const lasting = factBlockReason(event.kind);
          // Durable first (0153): if the ledger exists and the write fails, Postmark's retry writes it again.
          // Before 0153 the ledger answers 'unavailable' and the event is handled exactly as it was.
          const written = lasting ? await service.ledger?.record({ workspaceId: source.workspaceId, sourceKey: source.key, email: event.email, reason: lasting,
            eventId: event.eventId, stream: event.stream, at: event.at }) : undefined;
          // A replay (or a retry) of an event the ledger already holds, for an address the ledger no longer blocks for
          // that reason (the owner lifted the bounce, or a newer re-subscribe lifted the unsubscribe): the brand's lasting
          // stop is NOT run again, so a retried old bounce never re-stops a person the owner has just let back in.
          let stillBlocks = true;
          if (lasting && written === 'exists' && service.ledger) {
            const now = await service.ledger.decide(source.workspaceId, event.email, lasting === 'unsubscribed' ? 'marketing' : 'service');
            stillBlocks = now !== null && now.blocked && now.reason === lasting;
          }
          if (lasting && stillBlocks) await service.effectsFor(source.workspaceId)?.onMarketingBlock({ email: event.email, reason: lasting, metadata: event.metadata });
        }
      } catch {
        // Not remembered: Postmark's retry repeats the lasting effect. The in-process block already holds.
        log(JSON.stringify({ event: 'email.bounces.webhook_effect_failed', source: source.key, kind: event.kind }));
        send(res, 503, { error: 'temporarily_unavailable' }, { 'retry-after': '60' });
        return true;
      }
      service.registry.markSeen(source.key, event.eventId);
      log(JSON.stringify({ event: 'email.bounces.webhook', source: source.key, kind: event.kind, stream: streamKind, blocked }));
      send(res, 200, { received: true, outcome: event.kind, replayed: false, blocked });
      return true;
    },
  };
}
