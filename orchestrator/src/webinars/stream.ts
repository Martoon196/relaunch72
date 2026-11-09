/**
 * Cloudflare Stream adapter. Server-side only: the account API token never leaves
 * this process, and attendees only ever receive short-lived signed playback URLs.
 *
 * Request/response shapes were checked against the official `cloudflare` SDK
 * (v7.3.0) type definitions for stream.liveInputs, stream.videos, stream.keys,
 * stream.webhooks and the videos list `live_input_id` filter.
 *
 * Delivery choice (see docs/webinars.md): live = RTMPS/SRT ingest with
 * recording.mode 'automatic' + requireSignedURLs, played as signed HLS. Stream's
 * WebRTC (WHIP/WHEP) path is not used for attendees because it does not record,
 * cannot be played as HLS and does not support signed URLs.
 */

import { createHmac, createPrivateKey, sign as cryptoSign, timingSafeEqual } from 'node:crypto';
import type { StreamConfig } from './config.js';

export type StreamFetch = typeof fetch;

export class StreamError extends Error {
  constructor(message: string, readonly status: number | null, readonly retryable: boolean) {
    super(message);
  }
}

export interface LiveInputCredentials {
  readonly uid: string;
  readonly rtmpsUrl: string | null;
  readonly rtmpsStreamKey: string | null;
  readonly srtUrl: string | null;
  readonly srtStreamId: string | null;
  readonly srtPassphrase: string | null;
}

/** Normalised from LiveInput.status. */
export type LiveConnection = 'idle' | 'connected' | 'reconnecting' | 'disconnected';

export interface StreamVideo {
  readonly uid: string;
  readonly readyToStream: boolean;
  readonly state: string;
  readonly duration: number | null;
  readonly liveInput: string | null;
  readonly created: string | null;
  readonly errorReason: string | null;
}

const UID = /^[0-9a-f]{32}$/;
const API = 'https://api.cloudflare.com/client/v4/accounts';

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

export function liveConnection(status: unknown): LiveConnection {
  // The real provider response uses status.current.state; SDK examples also
  // advertise the legacy scalar shape. Unknown payloads must still fail closed.
  if (status && typeof status === 'object' && !Array.isArray(status)) {
    const current = (status as Record<string, unknown>).current;
    status = current && typeof current === 'object' && !Array.isArray(current)
      ? (current as Record<string, unknown>).state : undefined;
  }
  switch (status) {
    case 'connected':
    case 'reconnected':
    case 'new_configuration_accepted':
      return 'connected';
    case 'reconnecting':
      return 'reconnecting';
    case 'client_disconnect':
    case 'ttl_exceeded':
    case 'failed_to_connect':
    case 'failed_to_reconnect':
      return 'disconnected';
    default:
      return 'idle';
  }
}

function video(raw: Record<string, unknown>): StreamVideo | null {
  const uid = typeof raw.uid === 'string' && UID.test(raw.uid) ? raw.uid : null;
  if (!uid) return null;
  const status = (raw.status ?? {}) as Record<string, unknown>;
  const duration = typeof raw.duration === 'number' && raw.duration >= 0 ? raw.duration : null;
  return Object.freeze({
    uid,
    readyToStream: raw.readyToStream === true,
    state: typeof status.state === 'string' ? status.state : 'unknown',
    duration,
    liveInput: typeof raw.liveInput === 'string' && UID.test(raw.liveInput) ? raw.liveInput : null,
    created: typeof raw.created === 'string' ? raw.created : null,
    errorReason: typeof status.errorReasonText === 'string' ? status.errorReasonText.slice(0, 200)
      : typeof status.errorReasonCode === 'string' ? status.errorReasonCode.slice(0, 200) : null,
  });
}

export class CloudflareStreamClient {
  private key: ReturnType<typeof createPrivateKey> | null = null;

  constructor(private readonly config: StreamConfig, private readonly fetcher: StreamFetch = fetch) {}

  private async api<T>(method: string, path: string, body?: unknown, query?: Record<string, string>): Promise<T> {
    const url = new URL(`${API}/${this.config.accountId}/stream${path}`);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
    let res: Response;
    try {
      res = await this.fetcher(url, {
        method,
        headers: { authorization: `Bearer ${this.config.apiToken}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      // Timeout or network failure: the provider may or may not have acted.
      throw new StreamError(`Cloudflare Stream did not answer ${method} ${path}`, null, true);
    }
    const json = (await res.json().catch(() => ({}))) as { success?: boolean; result?: T; errors?: { message?: string }[] };
    if (!res.ok || json.success === false) {
      const message = (json.errors ?? []).map((e) => e.message).filter(Boolean).join('; ').slice(0, 200);
      throw new StreamError(`Cloudflare Stream ${method} ${path} failed (${res.status})${message ? `: ${message}` : ''}`, res.status, res.status >= 500 || res.status === 429);
    }
    return json.result as T;
  }

  /** Creates a recording live input. meta.webinarJob lets an interrupted call be found again. */
  async createLiveInput(meta: Record<string, string>, allowedOrigins: readonly string[], retentionDays: number | null): Promise<LiveInputCredentials> {
    const result = await this.api<Record<string, unknown>>('POST', '/live_inputs', {
      meta,
      recording: { mode: 'automatic', requireSignedURLs: true, allowedOrigins: [...allowedOrigins], timeoutSeconds: 0, hideLiveViewerCount: true },
      ...(retentionDays ? { deleteRecordingAfterDays: retentionDays } : {}),
    });
    return credentials(result);
  }

  async getLiveInput(uid: string): Promise<{ credentials: LiveInputCredentials; connection: LiveConnection; meta: Record<string, unknown> }> {
    assertUid(uid);
    const result = await this.api<Record<string, unknown>>('GET', `/live_inputs/${uid}`);
    return { credentials: credentials(result), connection: liveConnection(result.status), meta: (result.meta ?? {}) as Record<string, unknown> };
  }

  /** Finds a live input created for a given job after an uncertain create call. */
  async findLiveInputByJob(jobId: string): Promise<string | null> {
    const list = await this.api<Record<string, unknown>[]>('GET', '/live_inputs');
    const match = (Array.isArray(list) ? list : []).find((li) => (li.meta as Record<string, unknown> | undefined)?.webinarJob === jobId);
    return match && typeof match.uid === 'string' && UID.test(match.uid) ? match.uid : null;
  }

  async getVideo(uid: string): Promise<StreamVideo | null> {
    assertUid(uid);
    try {
      return video(await this.api<Record<string, unknown>>('GET', `/${uid}`));
    } catch (error) {
      if (error instanceof StreamError && error.status === 404) return null;
      throw error;
    }
  }

  /** Recordings for one live input, newest first. */
  async recordingsFor(liveInputUid: string): Promise<StreamVideo[]> {
    assertUid(liveInputUid);
    const list = await this.api<Record<string, unknown>[]>('GET', `/live_inputs/${liveInputUid}/videos`);
    // The scoped endpoint can omit liveInput; retain an explicit foreign input
    // so it is rejected rather than silently associating another brand's video.
    return (Array.isArray(list) ? list : []).map(raw => video({ ...raw, liveInput: raw.liveInput ?? liveInputUid }))
      .filter((v): v is StreamVideo => v !== null && v.liveInput === liveInputUid)
      .sort((a, b) => String(b.created).localeCompare(String(a.created)));
  }

  /** Locks a video to signed URLs and our playback origins (uploads only; live inputs set this on creation). */
  async protectVideo(uid: string, allowedOrigins: readonly string[]): Promise<void> {
    assertUid(uid);
    await this.api('POST', `/${uid}`, { requireSignedURLs: true, allowedOrigins: [...allowedOrigins] });
  }

  /**
   * Creates a resumable (tus) direct creator upload. The browser then PATCHes the
   * file straight to Cloudflare; no video bytes pass through our server.
   */
  async createTusUpload(lengthBytes: number, input: { name: string; maxDurationSeconds: number; webinarId: string }): Promise<{ uploadUrl: string; uid: string }> {
    if (!Number.isSafeInteger(lengthBytes) || lengthBytes < 1 || lengthBytes > 30 * 1024 ** 3) {
      throw new StreamError('Video size must be between 1 byte and 30 GB', 400, false);
    }
    const meta = [
      `name ${b64(input.name.slice(0, 120))}`,
      `maxdurationseconds ${b64(String(input.maxDurationSeconds))}`,
      'requiresignedurls',
    ].join(',');
    let res: Response;
    try {
      res = await this.fetcher(new URL(`${API}/${this.config.accountId}/stream?direct_user=true`), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.config.apiToken}`,
          'tus-resumable': '1.0.0',
          'upload-length': String(lengthBytes),
          'upload-metadata': meta,
        },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new StreamError('Cloudflare Stream did not answer the upload request', null, true);
    }
    const location = res.headers.get('location');
    const uid = res.headers.get('stream-media-id');
    if (res.status !== 201 || !location || !uid || !UID.test(uid)) {
      throw new StreamError(`Cloudflare Stream refused the upload (${res.status})`, res.status, res.status >= 500);
    }
    const url = new URL(location);
    if (url.protocol !== 'https:' || !/(^|\.)(cloudflarestream\.com|videodelivery\.net)$/.test(url.hostname)) {
      throw new StreamError('Cloudflare Stream returned an unexpected upload host', res.status, false);
    }
    return { uploadUrl: url.toString(), uid };
  }

  /** Self-signed RS256 playback token; no API call per viewer. */
  signPlayback(uid: string, nowMs: number, ttlSeconds = 3600): { token: string; expiresAt: string } {
    assertUid(uid);
    this.key ??= createPrivateKey({ key: this.config.signingJwk as import('node:crypto').JsonWebKey, format: 'jwk' });
    const now = Math.floor(nowMs / 1000);
    const header = b64url(JSON.stringify({ alg: 'RS256', kid: this.config.signingKeyId, typ: 'JWT' }));
    const payload = b64url(JSON.stringify({ sub: uid, kid: this.config.signingKeyId, exp: now + ttlSeconds, nbf: now - 60 }));
    const signature = cryptoSign('sha256', Buffer.from(`${header}.${payload}`), this.key);
    return { token: `${header}.${payload}.${b64url(signature)}`, expiresAt: new Date((now + ttlSeconds) * 1000).toISOString() };
  }

  hlsUrl(token: string): string {
    return `https://customer-${this.config.customerCode}.cloudflarestream.com/${token}/manifest/video.m3u8`;
  }

  /** Origins our playback pages are served from; used for Stream allowedOrigins. */
  get customerHost(): string {
    return `customer-${this.config.customerCode}.cloudflarestream.com`;
  }
}

function b64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

function assertUid(uid: string): void {
  if (!UID.test(uid)) throw new StreamError('Invalid Stream identifier', 400, false);
}

function credentials(raw: Record<string, unknown>): LiveInputCredentials {
  const uid = typeof raw.uid === 'string' && UID.test(raw.uid) ? raw.uid : null;
  if (!uid) throw new StreamError('Cloudflare Stream returned a live input without an id', 502, false);
  const rtmps = (raw.rtmps ?? {}) as Record<string, unknown>;
  const srt = (raw.srt ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v.length <= 500 ? v : null);
  return Object.freeze({
    uid,
    rtmpsUrl: str(rtmps.url), rtmpsStreamKey: str(rtmps.streamKey),
    srtUrl: str(srt.url), srtStreamId: str(srt.streamId), srtPassphrase: str(srt.passphrase),
  });
}

/**
 * Verifies `Webhook-Signature: time=<unix>,sig1=<hex HMAC-SHA256(secret, "<time>.<body>")>`.
 * Signatures older than five minutes are rejected (replay window); exact replays
 * inside the window are de-duplicated by the database receipt.
 */
export function verifyStreamWebhook(secret: string, header: string | undefined, body: Buffer, nowMs: number): boolean {
  if (!header || header.length > 300) return false;
  const parts = new Map(header.split(',').map((p) => {
    const i = p.indexOf('=');
    return [p.slice(0, i).trim(), p.slice(i + 1).trim()] as const;
  }));
  const time = parts.get('time') ?? '';
  const sig = parts.get('sig1') ?? '';
  if (!/^\d{9,11}$/.test(time) || !/^[0-9a-f]{64}$/.test(sig)) return false;
  if (Math.abs(Math.floor(nowMs / 1000) - Number(time)) > 300) return false;
  const expected = createHmac('sha256', secret).update(`${time}.`).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(sig, 'hex'));
}
