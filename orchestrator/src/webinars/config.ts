/**
 * Webinar configuration from environment variables. Every value is optional; a
 * missing value produces a named blocker the owner can act on, never a crash and
 * never a fake working control. Secret values are never echoed anywhere.
 */

export type WebinarEmailMode = 'off' | 'test' | 'live';

export interface StreamConfig {
  readonly accountId: string;
  readonly apiToken: string;
  /** customer-<code>.cloudflarestream.com */
  readonly customerCode: string;
  readonly signingKeyId: string;
  /** Parsed private JWK from POST /accounts/:id/stream/keys (its `jwk` field is base64 JSON). */
  readonly signingJwk: JsonWebKey;
  /** Shared secret from PUT /accounts/:id/stream/webhook; null until the webhook is registered. */
  readonly webhookSecret: string | null;
}

export interface WebinarSender {
  readonly workspaceId: string;
  readonly from: string;
  readonly replyTo: string | null;
  /** Postmark server token, read from the env var named here (never stored in JSON). */
  readonly token: string;
  readonly messageStream: string;
}

export interface WebinarLimits {
  /** Live inputs that may exist per workspace. Creating one is a provider resource. */
  readonly maxLiveInputsPerWorkspace: number;
  /** Upper bound for uploaded video length; Stream bills stored minutes. */
  readonly maxUploadMinutes: number;
  /** Optional Stream recording deletion schedule (days). */
  readonly recordingRetentionDays: number | null;
}

export interface StudioConfig {
  /** ffmpeg used by the browser-studio relay (PATH name or absolute path). */
  readonly ffmpegPath: string;
  readonly maxSessions: number;
  readonly maxMinutes: number;
}

export interface WebinarConfig {
  readonly stream: StreamConfig | null;
  /** Human-readable, name-only reasons video is unavailable. Empty when stream is set. */
  readonly streamBlockers: readonly string[];
  /** HMAC key for attendee access links. Required for any attendee journey. */
  readonly accessSecret: string | null;
  readonly emailMode: WebinarEmailMode;
  /** In test mode only these exact recipients receive anything. */
  readonly emailTestRecipients: ReadonlySet<string>;
  readonly senders: ReadonlyMap<string, WebinarSender>;
  readonly senderBlockers: readonly string[];
  /** Origin used in emailed links when a workspace has no brand host of its own. */
  readonly defaultPublicOrigin: string | null;
  /** Brand app hosts, e.g. the MHP workspace's app.martinhowardproperty.co.uk. */
  readonly workspaceOrigins: ReadonlyMap<string, string>;
  readonly limits: WebinarLimits;
  readonly studio: StudioConfig;
}

export const WEBINAR_ENV = Object.freeze({
  accountId: 'CLOUDFLARE_ACCOUNT_ID',
  apiToken: 'CLOUDFLARE_STREAM_API_TOKEN',
  customerCode: 'CLOUDFLARE_STREAM_CUSTOMER_CODE',
  signingKeyId: 'CLOUDFLARE_STREAM_SIGNING_KEY_ID',
  signingJwk: 'CLOUDFLARE_STREAM_SIGNING_JWK',
  webhookSecret: 'CLOUDFLARE_STREAM_WEBHOOK_SECRET',
  accessSecret: 'WEBINAR_ACCESS_SECRET',
  emailMode: 'WEBINAR_EMAIL_MODE',
  emailTestRecipients: 'WEBINAR_EMAIL_TEST_RECIPIENTS',
  senders: 'WEBINAR_EMAIL_SENDERS',
  publicOrigin: 'WEBINAR_PUBLIC_ORIGIN',
  workspaceOrigins: 'WEBINAR_WORKSPACE_ORIGINS',
  maxLiveInputs: 'WEBINAR_MAX_LIVE_INPUTS_PER_WORKSPACE',
  maxUploadMinutes: 'WEBINAR_MAX_UPLOAD_MINUTES',
  recordingRetentionDays: 'WEBINAR_RECORDING_RETENTION_DAYS',
  studioFfmpeg: 'WEBINAR_STUDIO_FFMPEG',
  studioMaxSessions: 'WEBINAR_STUDIO_MAX_SESSIONS',
  studioMaxMinutes: 'WEBINAR_STUDIO_MAX_MINUTES',
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

function value(env: NodeJS.ProcessEnv, name: string): string | null {
  const v = env[name]?.trim();
  return v ? v : null;
}

function origin(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1'))) return null;
    if (u.username || u.password || u.pathname !== '/' || u.search || u.hash) return null;
    return u.origin;
  } catch {
    return null;
  }
}

function boundedInt(raw: string | null, min: number, max: number, fallback: number): number {
  if (raw === null) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

function parseJwk(raw: string): JsonWebKey | null {
  // Stream returns the JWK base64-encoded; accept raw JSON too.
  for (const candidate of [raw, (() => { try { return Buffer.from(raw, 'base64').toString('utf8'); } catch { return ''; } })()]) {
    try {
      const parsed = JSON.parse(candidate) as JsonWebKey;
      if (parsed && parsed.kty === 'RSA' && typeof parsed.n === 'string' && typeof parsed.d === 'string') return parsed;
    } catch { /* try next */ }
  }
  return null;
}

export function loadWebinarConfig(env: NodeJS.ProcessEnv = process.env): WebinarConfig {
  const streamBlockers: string[] = [];
  const accountId = value(env, WEBINAR_ENV.accountId);
  const apiToken = value(env, WEBINAR_ENV.apiToken);
  const customerCode = value(env, WEBINAR_ENV.customerCode);
  const signingKeyId = value(env, WEBINAR_ENV.signingKeyId);
  const signingJwkRaw = value(env, WEBINAR_ENV.signingJwk);
  if (!accountId) streamBlockers.push(`${WEBINAR_ENV.accountId} is not set (your Cloudflare account ID).`);
  else if (!/^[0-9a-f]{32}$/.test(accountId)) streamBlockers.push(`${WEBINAR_ENV.accountId} is not a 32-character Cloudflare account ID.`);
  if (!apiToken) streamBlockers.push(`${WEBINAR_ENV.apiToken} is not set (an API token with Stream:Edit on that account).`);
  if (!customerCode) streamBlockers.push(`${WEBINAR_ENV.customerCode} is not set (the code in customer-<code>.cloudflarestream.com).`);
  else if (!/^[a-z0-9]{8,64}$/.test(customerCode)) streamBlockers.push(`${WEBINAR_ENV.customerCode} does not look like a Stream customer code.`);
  if (!signingKeyId) streamBlockers.push(`${WEBINAR_ENV.signingKeyId} is not set (the id from POST /stream/keys).`);
  const signingJwk = signingJwkRaw ? parseJwk(signingJwkRaw) : null;
  if (!signingJwkRaw) streamBlockers.push(`${WEBINAR_ENV.signingJwk} is not set (the jwk field from POST /stream/keys).`);
  else if (!signingJwk) streamBlockers.push(`${WEBINAR_ENV.signingJwk} is not a valid RSA private JWK.`);
  const stream = streamBlockers.length === 0
    ? Object.freeze({ accountId: accountId!, apiToken: apiToken!, customerCode: customerCode!, signingKeyId: signingKeyId!,
      signingJwk: signingJwk!, webhookSecret: value(env, WEBINAR_ENV.webhookSecret) })
    : null;

  const accessSecretRaw = value(env, WEBINAR_ENV.accessSecret);
  const accessSecret = accessSecretRaw && accessSecretRaw.length >= 32 ? accessSecretRaw : null;

  const modeRaw = value(env, WEBINAR_ENV.emailMode);
  const emailMode: WebinarEmailMode = modeRaw === 'live' || modeRaw === 'test' ? modeRaw : 'off';
  const emailTestRecipients = new Set((value(env, WEBINAR_ENV.emailTestRecipients) ?? '').split(',')
    .map((s) => s.trim().toLowerCase()).filter((s) => EMAIL.test(s)));

  const senders = new Map<string, WebinarSender>();
  const senderBlockers: string[] = [];
  const sendersRaw = value(env, WEBINAR_ENV.senders);
  if (sendersRaw) {
    let parsed: unknown = null;
    try { parsed = JSON.parse(sendersRaw); } catch { senderBlockers.push(`${WEBINAR_ENV.senders} is not valid JSON.`); }
    if (parsed !== null && !Array.isArray(parsed)) senderBlockers.push(`${WEBINAR_ENV.senders} must be a JSON array.`);
    for (const [i, item] of (Array.isArray(parsed) ? parsed : []).entries()) {
      const s = item as Record<string, unknown>;
      const workspaceId = typeof s.workspaceId === 'string' && UUID.test(s.workspaceId) ? s.workspaceId.toLowerCase() : null;
      const from = typeof s.from === 'string' && s.from.length <= 320 && EMAIL.test(s.from.replace(/^.*<([^>]+)>\s*$/, '$1')) ? s.from : null;
      const tokenEnv = typeof s.tokenEnv === 'string' && /^[A-Z][A-Z0-9_]{2,80}$/.test(s.tokenEnv) ? s.tokenEnv : null;
      const token = tokenEnv ? value(env, tokenEnv) : null;
      if (!workspaceId || !from || !tokenEnv) { senderBlockers.push(`${WEBINAR_ENV.senders}[${i}] needs workspaceId, from and tokenEnv.`); continue; }
      if (!token) { senderBlockers.push(`${WEBINAR_ENV.senders}[${i}] names ${tokenEnv}, which is not set.`); continue; }
      if (senders.has(workspaceId)) { senderBlockers.push(`${WEBINAR_ENV.senders} lists workspace ${workspaceId} twice.`); continue; }
      const replyTo = typeof s.replyTo === 'string' && EMAIL.test(s.replyTo) ? s.replyTo : null;
      const messageStream = typeof s.messageStream === 'string' && /^[a-z0-9-]{1,50}$/.test(s.messageStream) ? s.messageStream : 'outbound';
      senders.set(workspaceId, Object.freeze({ workspaceId, from, replyTo, token, messageStream }));
    }
  }

  const workspaceOrigins = new Map<string, string>();
  const originsRaw = value(env, WEBINAR_ENV.workspaceOrigins);
  if (originsRaw) {
    try {
      const parsed = JSON.parse(originsRaw) as Record<string, unknown>;
      for (const [ws, o] of Object.entries(parsed ?? {})) {
        const normalised = typeof o === 'string' ? origin(o) : null;
        if (UUID.test(ws) && normalised) workspaceOrigins.set(ws.toLowerCase(), normalised);
      }
    } catch { /* ignored: links fall back to the default origin */ }
  }

  const retention = value(env, WEBINAR_ENV.recordingRetentionDays);
  return Object.freeze({
    stream,
    streamBlockers: Object.freeze(streamBlockers),
    accessSecret,
    emailMode,
    emailTestRecipients,
    senders,
    senderBlockers: Object.freeze(senderBlockers),
    defaultPublicOrigin: origin(value(env, WEBINAR_ENV.publicOrigin)),
    workspaceOrigins,
    limits: Object.freeze({
      maxLiveInputsPerWorkspace: boundedInt(value(env, WEBINAR_ENV.maxLiveInputs), 0, 20, 2),
      maxUploadMinutes: boundedInt(value(env, WEBINAR_ENV.maxUploadMinutes), 5, 600, 240),
      recordingRetentionDays: retention === null ? null : boundedInt(retention, 30, 3650, 365),
    }),
    studio: Object.freeze({
      ffmpegPath: ((p) => (p && /^[\w./-]{1,200}$/.test(p) ? p : 'ffmpeg'))(value(env, WEBINAR_ENV.studioFfmpeg)),
      maxSessions: boundedInt(value(env, WEBINAR_ENV.studioMaxSessions), 0, 10, 1),
      maxMinutes: boundedInt(value(env, WEBINAR_ENV.studioMaxMinutes), 10, 480, 240),
    }),
  });
}

export function publicOriginFor(config: WebinarConfig, workspaceId: string): string | null {
  return config.workspaceOrigins.get(workspaceId.toLowerCase()) ?? config.defaultPublicOrigin;
}

/** Hostnames our playback pages are served from for a brand; used for Stream allowedOrigins. */
export function playbackHosts(config: WebinarConfig, workspaceId: string): string[] {
  const hosts = new Set<string>();
  for (const o of [publicOriginFor(config, workspaceId), config.defaultPublicOrigin]) if (o) hosts.add(new URL(o).hostname);
  return [...hosts];
}
