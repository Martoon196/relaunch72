/**
 * Cloudflare Stream: live inputs, direct uploads, recordings, and signed playback.
 * Videos and live inputs are created with requireSignedURLs + allowedOrigins, so nothing
 * plays without a short-lived token minted here.
 */
import type { Env } from '../env.js';
import { b64Decode, hmacSha256Hex, safeEqual, signJwtRs256 } from './crypto.js';

export interface LiveInputResult {
  uid: string;
  rtmps: { url: string; streamKey: string };
  srt: { url: string; streamId: string; passphrase: string };
  webRTC: { url: string };          // WHIP ingest
}

export interface PlaybackUrls {
  hls: string;
  webrtc: string | null;            // WHEP (low-latency live only)
  expires_at: string;
}

export interface StreamService {
  createLiveInput(meta: Record<string, string>, allowedOrigins: string[]): Promise<LiveInputResult>;
  createDirectUpload(meta: Record<string, string>, allowedOrigins: string[], maxDurationSeconds: number): Promise<{ uploadURL: string; uid: string }>;
  latestRecording(liveInputUid: string): Promise<{ uid: string; duration: number; readyToStream: boolean } | null>;
  videoDetails(uid: string): Promise<{ uid: string; duration: number; readyToStream: boolean } | null>;
  playback(uid: string, opts: { live: boolean; ttlSeconds?: number; nowMs?: number }): Promise<PlaybackUrls>;
}

class StreamApiError extends Error {}

export function createStreamService(env: Env): StreamService {
  const base = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/stream`;
  const customer = `https://customer-${env.STREAM_CUSTOMER_CODE}.cloudflarestream.com`;

  async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!env.CF_ACCOUNT_ID || !env.CF_STREAM_API_TOKEN) throw new StreamApiError('Stream is not configured (CF_ACCOUNT_ID / CF_STREAM_API_TOKEN)');
    const res = await fetch(base + path, {
      ...init,
      headers: { authorization: `Bearer ${env.CF_STREAM_API_TOKEN}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
    const body = (await res.json().catch(() => ({}))) as { success?: boolean; result?: T; errors?: { message: string }[] };
    if (!res.ok || body.success === false) {
      throw new StreamApiError(`Stream ${path} failed: ${res.status} ${body.errors?.map((e) => e.message).join('; ') ?? ''}`);
    }
    return body.result as T;
  }

  let jwk: JsonWebKey | null = null;
  function signingJwk(): JsonWebKey {
    if (!jwk) {
      if (!env.STREAM_SIGNING_JWK || !env.STREAM_SIGNING_KEY_ID) throw new StreamApiError('Stream signing key not configured');
      jwk = JSON.parse(new TextDecoder().decode(b64Decode(env.STREAM_SIGNING_JWK))) as JsonWebKey;
    }
    return jwk;
  }

  return {
    async createLiveInput(meta, allowedOrigins) {
      const r = await api<LiveInputResult>('/live_inputs', {
        method: 'POST',
        body: JSON.stringify({
          meta,
          recording: { mode: 'automatic', requireSignedURLs: true, allowedOrigins, timeoutSeconds: 60 },
        }),
      });
      return r;
    },
    async createDirectUpload(meta, allowedOrigins, maxDurationSeconds) {
      return api<{ uploadURL: string; uid: string }>('/direct_upload', {
        method: 'POST',
        body: JSON.stringify({ meta, requireSignedURLs: true, allowedOrigins, maxDurationSeconds }),
      });
    },
    async latestRecording(liveInputUid) {
      const vids = await api<{ uid: string; duration: number; readyToStream: boolean; created: string }[]>(`/live_inputs/${liveInputUid}/videos`);
      const sorted = [...(vids ?? [])].sort((a, b) => b.created.localeCompare(a.created));
      return sorted[0] ?? null;
    },
    async videoDetails(uid) {
      try {
        return await api<{ uid: string; duration: number; readyToStream: boolean }>(`/${uid}`);
      } catch {
        return null;
      }
    },
    async playback(uid, { live, ttlSeconds = 3600, nowMs = Date.now() }) {
      const now = Math.floor(nowMs / 1000);
      const exp = now + ttlSeconds;
      const token = await signJwtRs256(signingJwk(), env.STREAM_SIGNING_KEY_ID!, {
        sub: uid,
        kid: env.STREAM_SIGNING_KEY_ID,
        exp,
        nbf: now - 60,
      });
      return {
        hls: `${customer}/${token}/manifest/video.m3u8`,
        webrtc: live ? `${customer}/${token}/webRTC/play` : null,
        expires_at: new Date(exp * 1000).toISOString(),
      };
    },
  };
}

/**
 * Verify a Stream webhook: header `Webhook-Signature: time=<unix>,sig1=<hex hmac(time + "." + body)>`.
 */
export async function verifyStreamWebhook(secret: string, header: string | null, body: string, nowS = Math.floor(Date.now() / 1000)): Promise<boolean> {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]));
  const time = Number(parts.time);
  if (!parts.sig1 || !Number.isFinite(time) || Math.abs(nowS - time) > 300) return false;
  return safeEqual(await hmacSha256Hex(secret, `${parts.time}.${body}`), parts.sig1);
}
