/**
 * Public Twilio callback surface for the 0056 SMS rail. This process owns
 * only the webhook login and the Account Auth Token that keys Twilio's
 * X-Twilio-Signature verification. It never receives the restricted API
 * key pair, cannot construct an outbound request, and records verified
 * status and inbound evidence through two SECURITY DEFINER functions only.
 */

import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import {
  parseTwilioSmsInboundEvent,
  parseTwilioSmsStatusEvent,
  TWILIO_SMS_ACCOUNT_SID,
  TwilioSmsLiveError,
  verifyTwilioSmsWebhook,
} from '../../sms-live/foundation.js';
import {
  assertSmsWebhookBoundaryReady,
  SMS_WEBHOOK_DATABASE_ROLE,
} from '../../sms-live-pg/readiness.js';
import { PgTwilioSmsWebhookRepository } from '../../sms-live-pg/webhook-repository.js';
import { assertRuntimeSchemaCurrent } from '../../db/runtime-readiness.js';
import { assertExpectedDatabaseInstallation } from '../../db/installation-identity.js';

export const TWILIO_SMS_LIVE_WEBHOOK_SERVICE =
  'property-predator-twilio-sms-live-webhook' as const;
export const TWILIO_SMS_INBOUND_WEBHOOK_PATH = '/webhooks/twilio/sms/inbound' as const;
export const TWILIO_SMS_STATUS_WEBHOOK_PATH = '/webhooks/twilio/sms/status' as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SAFE_SECRET = /^[\x21-\x7e]{16,2000}$/u;
const DATABASE_URL_ENV = 'DATABASE_SMS_WEBHOOK_URL';
const MAX_WEBHOOK_BYTES = 64 * 1024;
const APPROVED_SECRET_NAMES = new Set(['TWILIO_AUTH_TOKEN']);
const SECRET_NAME = /(?:^|_)(?:API_?KEY|ACCESS_?TOKEN|AUTH_?TOKEN|BEARER_?TOKEN|OAUTH_?TOKEN|REFRESH_?TOKEN|CLIENT_?SECRET|APP_?SECRET|SIGNING_?KEY|WEBHOOK_?SECRET|PRIVATE_?KEY|SERVER_?TOKEN|PASSWORD|CREDENTIALS?|SECRET|TOKEN|KEY)(?:_|$)/u;

export type TwilioSmsLiveWebhookConfig = Readonly<{
  mode: 'disabled';
  installationId: string;
  host: string;
  port: number;
}> | Readonly<{
  mode: 'signed_live';
  installationId: string;
  host: string;
  port: number;
  workspaceId: string;
  connectionId: string;
  accountSid: string;
  authToken: string;
  publicOrigin: string;
}>;

export interface TwilioSmsLiveWebhookReadiness {
  readonly schemaVersion: 1;
  readonly event: 'ready';
  readonly service: typeof TWILIO_SMS_LIVE_WEBHOOK_SERVICE;
  readonly mode: 'disabled' | 'signed_live';
  readonly paths: Readonly<{
    inbound: typeof TWILIO_SMS_INBOUND_WEBHOOK_PATH;
    status: typeof TWILIO_SMS_STATUS_WEBHOOK_PATH;
  }>;
  readonly database: Readonly<{
    role: typeof SMS_WEBHOOK_DATABASE_ROLE;
    schemaCurrent: true;
    installationMatched: true;
    functionBoundaryReady: true;
  }>;
  readonly safety: Readonly<{
    rawBodySignatureVerification: true;
    maximumBodyBytes: 65536;
    outboundApiKeyPresent: false;
    providerCallsMadeAtReadiness: false;
  }>;
}

function assertExactDatabaseIdentity(env: NodeJS.ProcessEnv): void {
  if (!env[DATABASE_URL_ENV]?.trim()) throw new Error(`${DATABASE_URL_ENV} is required`);
  const databaseUrls = Object.keys(env).filter((name) => {
    const normalized = name.toUpperCase();
    return Boolean(env[name]?.trim())
      && (normalized === 'DATABASE_URL' || normalized === 'TEST_DATABASE_URL'
        || /^DATABASE_[A-Z0-9_]+_URL$/u.test(normalized));
  });
  if (databaseUrls.some((name) => name.toUpperCase() !== DATABASE_URL_ENV)) {
    throw new Error('Twilio SMS webhook received another database identity');
  }
}

function assertNoUnrelatedSecrets(env: NodeJS.ProcessEnv): void {
  const unrelated = Object.keys(env).some((name) => {
    const normalized = name.toUpperCase();
    return Boolean(env[name]?.trim()) && normalized !== DATABASE_URL_ENV
      && !APPROVED_SECRET_NAMES.has(normalized) && SECRET_NAME.test(normalized);
  });
  if (unrelated) throw new Error('Twilio SMS webhook received an unrelated secret');
}

function publicOriginOf(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('Twilio SMS webhook public origin is invalid');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password
      || parsed.search || parsed.hash
      || (parsed.pathname !== '/' && parsed.pathname !== '')) {
    throw new Error('Twilio SMS webhook public origin must be a bare HTTPS origin');
  }
  return parsed.origin;
}

export function loadTwilioSmsLiveWebhookConfig(
  env: NodeJS.ProcessEnv,
): TwilioSmsLiveWebhookConfig {
  assertExactDatabaseIdentity(env);
  assertNoUnrelatedSecrets(env);
  const installationId = env.PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID?.trim().toLowerCase() ?? '';
  if (!UUID.test(installationId)) {
    throw new Error('PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID must be a UUID');
  }
  const host = env.HOST?.trim() || '127.0.0.1';
  const selectedPort = env.PORT?.trim() ? Number(env.PORT.trim()) : 4_244;
  if (!Number.isSafeInteger(selectedPort) || selectedPort < 1 || selectedPort > 65_535) {
    throw new Error('PORT must be 1-65535');
  }
  const mode = env.PROPERTY_PREDATOR_SMS_WEBHOOK_MODE?.trim() || 'disabled';
  if (mode === 'disabled') {
    return Object.freeze({ mode, installationId, host, port: selectedPort });
  }
  if (mode !== 'signed_live'
      || env.NODE_ENV?.trim().toLowerCase() !== 'production'
      || env.PROPERTY_PREDATOR_SMS_PROVIDER_ID !== 'twilio_messaging') {
    throw new Error('Twilio SMS webhook activation tuple is invalid');
  }
  const workspaceId = env.PROPERTY_PREDATOR_SMS_LIVE_WORKSPACE_ID?.trim().toLowerCase() ?? '';
  const connectionId = env.PROPERTY_PREDATOR_SMS_LIVE_CONNECTION_ID?.trim().toLowerCase() ?? '';
  const accountSid = env.PROPERTY_PREDATOR_SMS_ACCOUNT_SID?.trim() ?? '';
  const authToken = env.TWILIO_AUTH_TOKEN ?? '';
  if (!UUID.test(workspaceId) || !UUID.test(connectionId)
      || !TWILIO_SMS_ACCOUNT_SID.test(accountSid) || !SAFE_SECRET.test(authToken)) {
    throw new Error('Twilio SMS webhook activation tuple is invalid');
  }
  return Object.freeze({
    mode,
    installationId,
    host,
    port: selectedPort,
    workspaceId,
    connectionId,
    accountSid,
    authToken,
    publicOrigin: publicOriginOf(env.PROPERTY_PREDATOR_SMS_WEBHOOK_PUBLIC_ORIGIN?.trim() ?? ''),
  });
}

class BodyTooLargeError extends Error {}
class InvalidBodyError extends Error {}

async function rawBody(request: IncomingMessage): Promise<Buffer> {
  const declared = request.headers['content-length'];
  if (declared !== undefined) {
    if (Array.isArray(declared) || !/^[0-9]+$/u.test(declared)) throw new InvalidBodyError();
    if (Number(declared) > MAX_WEBHOOK_BYTES) throw new BodyTooLargeError();
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += bytes.length;
    if (total > MAX_WEBHOOK_BYTES) throw new BodyTooLargeError();
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function send(
  response: ServerResponse,
  status: number,
  body: string,
  contentType = 'application/json; charset=utf-8',
): void {
  const bytes = Buffer.from(body, 'utf8');
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Length': bytes.length,
    'Content-Type': contentType,
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(bytes);
}

export interface TwilioSmsWebhookRecorder {
  recordStatus(input: Readonly<{
    event: ReturnType<typeof parseTwilioSmsStatusEvent>;
    payloadSha256: string;
    occurredAt: string;
  }>): Promise<'applied' | 'replayed' | 'conflict' | 'not_applicable'>;
  recordInbound(input: Readonly<{
    event: ReturnType<typeof parseTwilioSmsInboundEvent>;
    payloadSha256: string;
    signatureSha256: string;
    occurredAt: string;
    projection: 'conversion_inbox_and_lead360';
  }>): Promise<'applied' | 'replayed' | 'conflict'>;
}

export interface TwilioSmsWebhookDependencies {
  readonly env?: NodeJS.ProcessEnv;
  readonly createPool?: (env: NodeJS.ProcessEnv) => Pool;
  readonly assertSchemaCurrent?: (pool: Pool) => Promise<void>;
  readonly assertInstallationReady?: (pool: Pool, installationId: string) => Promise<void>;
  readonly assertBoundaryReady?: (pool: Pool) => Promise<void>;
  readonly createRecorder?: (
    pool: Pool,
    config: Extract<TwilioSmsLiveWebhookConfig, { mode: 'signed_live' }>,
  ) => TwilioSmsWebhookRecorder;
  readonly createHttpServer?: (
    listener: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
  ) => Server;
  readonly listen?: boolean;
  readonly now?: () => Date;
  readonly writeReadiness?: (line: string) => void;
  readonly writeErrorTelemetry?: (line: string) => void;
}

export interface TwilioSmsWebhookRuntime {
  readonly readiness: TwilioSmsLiveWebhookReadiness;
  handle(request: IncomingMessage, response: ServerResponse): Promise<void>;
  shutdown(): Promise<void>;
}

async function centralizedPoolFactory(
  env: NodeJS.ProcessEnv,
  onBackgroundError: (error: Error) => void,
): Promise<Pool> {
  const module = await import('../../db/pool.js') as Record<string, unknown>;
  const factory = module.createSmsWebhookCommandDatabasePool;
  if (typeof factory !== 'function') {
    throw new Error('Twilio SMS webhook centralized database factory is unavailable');
  }
  return (factory as (
    env: NodeJS.ProcessEnv,
    hooks: Readonly<{ onBackgroundError?: (error: Error) => void }>,
  ) => Pool)(env, { onBackgroundError });
}

export async function startTwilioSmsLiveWebhookService(
  dependencies: TwilioSmsWebhookDependencies = {},
): Promise<TwilioSmsWebhookRuntime> {
  const env = dependencies.env ?? process.env;
  const config = loadTwilioSmsLiveWebhookConfig(env);
  const writeErrorTelemetry = dependencies.writeErrorTelemetry
    ?? ((line: string) => process.stderr.write(line));
  let backgroundErrorCount = 0;
  const pool = dependencies.createPool
    ? dependencies.createPool(env)
    : await centralizedPoolFactory(env, () => {
      backgroundErrorCount += 1;
      writeErrorTelemetry(`${JSON.stringify({
        schemaVersion: 1,
        event: 'webhook_error',
        service: TWILIO_SMS_LIVE_WEBHOOK_SERVICE,
        eventKind: 'background_database',
        count: backgroundErrorCount,
      })}\n`);
    });
  try {
    await (dependencies.assertSchemaCurrent ?? assertRuntimeSchemaCurrent)(pool);
    await (dependencies.assertInstallationReady ?? assertExpectedDatabaseInstallation)(
      pool, config.installationId,
    );
    await (dependencies.assertBoundaryReady ?? assertSmsWebhookBoundaryReady)(pool);
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }

  let recorder: TwilioSmsWebhookRecorder | null = null;
  if (config.mode === 'signed_live') {
    recorder = (dependencies.createRecorder
      ?? ((boundPool, exact) => new PgTwilioSmsWebhookRepository({
        commandPool: boundPool,
        workspaceId: exact.workspaceId,
        providerConnectionId: exact.connectionId,
      })))(pool, config);
  }

  const readiness: TwilioSmsLiveWebhookReadiness = Object.freeze({
    schemaVersion: 1,
    event: 'ready',
    service: TWILIO_SMS_LIVE_WEBHOOK_SERVICE,
    mode: config.mode,
    paths: Object.freeze({
      inbound: TWILIO_SMS_INBOUND_WEBHOOK_PATH,
      status: TWILIO_SMS_STATUS_WEBHOOK_PATH,
    }),
    database: Object.freeze({
      role: SMS_WEBHOOK_DATABASE_ROLE,
      schemaCurrent: true as const,
      installationMatched: true as const,
      functionBoundaryReady: true as const,
    }),
    safety: Object.freeze({
      rawBodySignatureVerification: true as const,
      maximumBodyBytes: 65_536 as const,
      outboundApiKeyPresent: false as const,
      providerCallsMadeAtReadiness: false as const,
    }),
  });

  const now = dependencies.now ?? (() => new Date());

  const handle = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (request.method === 'GET' && url.pathname === '/health' && url.search === '') {
      send(response, 200, JSON.stringify(readiness));
      return;
    }
    if (url.pathname !== TWILIO_SMS_INBOUND_WEBHOOK_PATH
        && url.pathname !== TWILIO_SMS_STATUS_WEBHOOK_PATH) {
      send(response, 404, JSON.stringify({ error: 'not_found' }));
      return;
    }
    if (config.mode !== 'signed_live' || !recorder) {
      send(response, 503, JSON.stringify({ error: 'sms_webhook_disabled' }));
      return;
    }
    if (request.method !== 'POST' || url.search !== '') {
      send(response, 405, JSON.stringify({ error: 'method_not_allowed' }));
      return;
    }
    try {
      const body = await rawBody(request);
      const verified = verifyTwilioSmsWebhook({
        publicOrigin: config.publicOrigin,
        path: url.pathname,
        authToken: config.authToken,
        rawBody: body,
        contentType: request.headers['content-type'],
        twilioSignature: request.headers['x-twilio-signature'],
      });
      const occurredAt = now().toISOString();
      if (url.pathname === TWILIO_SMS_STATUS_WEBHOOK_PATH) {
        const event = parseTwilioSmsStatusEvent(verified, config.accountSid);
        const disposition = await recorder.recordStatus({
          event,
          payloadSha256: verified.payloadSha256,
          occurredAt,
        });
        send(response, 200, JSON.stringify({ accepted: true, disposition }));
        return;
      }
      const event = parseTwilioSmsInboundEvent(verified, config.accountSid);
      const disposition = await recorder.recordInbound({
        event,
        payloadSha256: verified.payloadSha256,
        signatureSha256: verified.signatureSha256,
        occurredAt,
        projection: 'conversion_inbox_and_lead360',
      });
      if (disposition === 'conflict') {
        send(response, 409, JSON.stringify({ error: 'event_conflict' }));
        return;
      }
      // Twilio expects TwiML for inbound messages; an empty response sends nothing back.
      send(response, 200, '<?xml version="1.0" encoding="UTF-8"?><Response/>', 'text/xml; charset=utf-8');
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        send(response, 413, JSON.stringify({ error: 'payload_too_large' }));
      } else if (error instanceof InvalidBodyError) {
        send(response, 400, JSON.stringify({ error: 'invalid_request' }));
      } else if (error instanceof TwilioSmsLiveError && error.code === 'signature_invalid') {
        send(response, 401, JSON.stringify({ error: 'invalid_signature' }));
      } else if (error instanceof TwilioSmsLiveError && error.code === 'webhook_invalid') {
        send(response, 400, JSON.stringify({ error: 'invalid_webhook' }));
      } else {
        send(response, 503, JSON.stringify({ error: 'webhook_temporarily_unavailable' }));
      }
    }
  };

  let server: Server | null = null;
  if (dependencies.listen !== false) {
    await new Promise<void>((resolve, reject) => {
      server = (dependencies.createHttpServer
        ?? ((listener) => createServer((request, response) => {
          void listener(request, response).catch(() => {
            if (!response.headersSent) {
              send(response, 503, JSON.stringify({ error: 'webhook_temporarily_unavailable' }));
            } else {
              response.destroy();
            }
          });
        })))(handle);
      server.once('error', (error) => {
        void pool.end().catch(() => undefined);
        reject(error);
      });
      server.listen(config.port, config.host, () => resolve());
    });
  }
  (dependencies.writeReadiness ?? ((line: string) => process.stdout.write(line)))(
    `${JSON.stringify(readiness)}\n`,
  );

  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    await pool.end();
  };

  return Object.freeze({ readiness, handle, shutdown });
}

/** Deterministic evidence hash for tests; never used to authenticate. */
export function twilioSmsWebhookPayloadSha256(rawBodyBytes: Uint8Array): string {
  return createHash('sha256').update(Buffer.from(rawBodyBytes)).digest('hex');
}
