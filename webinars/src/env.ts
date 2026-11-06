/** Bindings and secrets. See wrangler.toml. */
export interface RateLimiter {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  DB: D1Database;
  SESSION_ROOM: DurableObjectNamespace;
  WEBHOOKS: Queue<WebhookJob>;
  FILES?: R2Bucket;
  ASSETS?: Fetcher;
  RL_PUBLIC?: RateLimiter;
  RL_REGISTER?: RateLimiter;

  PUBLIC_ORIGIN: string;
  API_ORIGIN: string;
  CDN_ORIGIN: string;
  STREAM_CUSTOMER_CODE: string;
  TURNSTILE_SITE_KEY?: string;

  TOKEN_SECRET: string;          // HMAC key for session / host tokens
  DATA_KEY: string;              // base64 32-byte AES-GCM key (webhook secrets at rest)
  CF_ACCOUNT_ID?: string;
  CF_STREAM_API_TOKEN?: string;
  STREAM_SIGNING_KEY_ID?: string;
  STREAM_SIGNING_JWK?: string;   // base64 JWK as returned by POST /stream/keys
  STREAM_WEBHOOK_SECRET?: string;
  TURNSTILE_SECRET?: string;
  BOOTSTRAP_TOKEN?: string;
}

export interface WebhookJob {
  deliveryId: string;
}

export type Mode = 'live' | 'test';
