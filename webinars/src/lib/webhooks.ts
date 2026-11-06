/**
 * Outgoing webhooks. Signed `GHQ-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, t + "." + body)>`.
 * Receivers must reject timestamps older than 5 minutes (replay protection) — see verifyWebhookSignature.
 * Retries are exponential over ~24h; after that the delivery is marked `dead` (the dead-letter log).
 */
import type { Env, WebhookJob } from '../env.js';
import { decryptSecret, hmacSha256Hex, safeEqual } from './crypto.js';
import { nowIso } from './util.js';

/** Delay before attempt n+1 (seconds). Sum ≈ 24h. Queue delays cap at 12h. */
export const RETRY_SCHEDULE_S = [30, 60, 300, 900, 1800, 3600, 7200, 14400, 28800, 28800];
const MAX_AGE_MS = 24 * 3600_000 + 15 * 60_000;

export async function signWebhook(secret: string, body: string, tsS: number): Promise<string> {
  return `t=${tsS},v1=${await hmacSha256Hex(secret, `${tsS}.${body}`)}`;
}

/** Reference verifier for receivers (Growth HQ side). */
export async function verifyWebhookSignature(secret: string, header: string | null, body: string, nowS = Math.floor(Date.now() / 1000), toleranceS = 300): Promise<boolean> {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(',').map((p) => { const i = p.indexOf('='); return [p.slice(0, i), p.slice(i + 1)]; }));
  const t = Number(parts.t);
  if (!parts.v1 || !Number.isFinite(t) || Math.abs(nowS - t) > toleranceS) return false;
  return safeEqual(await hmacSha256Hex(secret, `${t}.${body}`), parts.v1);
}

interface DeliveryRow {
  id: string;
  status: string;
  attempts: number;
  created_at: string;
  url: string;
  secret_enc: string;
  active: number;
  event_id: string;
  event_type: string;
  data_json: string;
}

export type AttemptResult = { outcome: 'delivered' } | { outcome: 'retry'; delaySeconds: number } | { outcome: 'dead' | 'skip' };

export async function attemptDelivery(env: Pick<Env, 'DB' | 'DATA_KEY'>, deliveryId: string, fetcher: typeof fetch = fetch, nowMs = Date.now()): Promise<AttemptResult> {
  const row = await env.DB.prepare(
    `SELECT d.id, d.status, d.attempts, d.created_at, e.url, e.secret_enc, e.active, ev.id AS event_id, ev.type AS event_type, ev.data_json
       FROM webhook_deliveries d
       JOIN webhook_endpoints e ON e.id = d.endpoint_id
       JOIN events ev ON ev.id = d.event_id
      WHERE d.id = ?`,
  ).bind(deliveryId).first<DeliveryRow>();
  if (!row || row.status === 'delivered' || row.status === 'dead') return { outcome: 'skip' };
  if (!row.active) {
    await env.DB.prepare("UPDATE webhook_deliveries SET status = 'dead', last_error = 'endpoint disabled' WHERE id = ?").bind(row.id).run();
    return { outcome: 'dead' };
  }

  const tsS = Math.floor(nowMs / 1000);
  const body = row.data_json;
  let error: string | null = null;
  try {
    const secret = await decryptSecret(env.DATA_KEY, row.secret_enc);
    const res = await fetcher(row.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'GrowthHQ-Webinars/1',
        'ghq-event': row.event_type,
        'ghq-delivery': row.id,
        'ghq-signature': await signWebhook(secret, body, tsS),
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      await env.DB.prepare("UPDATE webhook_deliveries SET status = 'delivered', attempts = attempts + 1, delivered_at = ?, last_error = NULL WHERE id = ?")
        .bind(nowIso(nowMs), row.id).run();
      return { outcome: 'delivered' };
    }
    error = `HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const attempts = row.attempts + 1;
  const tooOld = nowMs - Date.parse(row.created_at) > MAX_AGE_MS;
  const delay = RETRY_SCHEDULE_S[attempts - 1];
  if (tooOld || delay === undefined) {
    await env.DB.prepare("UPDATE webhook_deliveries SET status = 'dead', attempts = ?, last_error = ? WHERE id = ?").bind(attempts, error, row.id).run();
    console.error(`webhook ${row.id} dead after ${attempts} attempts: ${error}`);
    return { outcome: 'dead' };
  }
  await env.DB.prepare("UPDATE webhook_deliveries SET status = 'failed', attempts = ?, last_error = ?, next_attempt_at = ? WHERE id = ?")
    .bind(attempts, error, nowIso(nowMs + delay * 1000), row.id).run();
  return { outcome: 'retry', delaySeconds: delay };
}

export async function handleWebhookBatch(batch: MessageBatch<WebhookJob>, env: Env): Promise<void> {
  for (const msg of batch.messages) {
    try {
      const r = await attemptDelivery(env, msg.body.deliveryId);
      if (r.outcome === 'retry') msg.retry({ delaySeconds: r.delaySeconds });
      else msg.ack();
    } catch (err) {
      console.error('webhook consumer error', err);
      msg.retry({ delaySeconds: 60 });
    }
  }
}
