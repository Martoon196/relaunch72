import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Pool } from 'pg';
import { assertExpectedDatabaseInstallation } from '../../db/installation-identity.js';
import { createWhatsAppLiveWebhookCommandDatabasePool } from '../../db/pool.js';
import { assertRuntimeSchemaCurrent } from '../../db/runtime-readiness.js';
import {
  META_WHATSAPP_LIVE_WEBHOOK_DATABASE_ROLE,
  PgMetaWhatsAppLiveWebhookCommandService,
  assertMetaWhatsAppLiveWebhookBoundaryReady,
} from '../../whatsapp-live-pg/index.js';
import {
  MetaWhatsAppLiveError,
  dispatchVerifiedMetaWhatsAppLiveEvents,
  verifyMetaWhatsAppLiveChallenge,
  verifyMetaWhatsAppLiveWebhook,
  type MetaWhatsAppBinding,
  type MetaWhatsAppLiveWebhookCommandService,
} from '../../whatsapp-live/index.js';

export const META_WHATSAPP_LIVE_WEBHOOK_SERVICE =
  'property-predator-meta-whatsapp-live-webhook' as const;
export const META_WHATSAPP_LIVE_WEBHOOK_PATH = '/webhooks/meta/whatsapp' as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const META_ID = /^[1-9][0-9]{4,29}$/u;
const SAFE_SECRET = /^[\x21-\x7e]{20,2000}$/u;
const DATABASE_URL_ENV = 'DATABASE_WHATSAPP_LIVE_WEBHOOK_URL';
const MAX_WEBHOOK_BYTES = 256 * 1024;
const APPROVED_SECRET_NAMES = new Set([
  'PROPERTY_PREDATOR_META_WHATSAPP_APP_SECRET',
  'PROPERTY_PREDATOR_META_WHATSAPP_VERIFY_TOKEN',
]);
const SECRET_NAME = /(?:^|_)(?:API_?KEY|ACCESS_?TOKEN|AUTH_?TOKEN|BEARER_?TOKEN|OAUTH_?TOKEN|REFRESH_?TOKEN|CLIENT_?SECRET|APP_?SECRET|SIGNING_?KEY|WEBHOOK_?SECRET|PRIVATE_?KEY|SERVER_?TOKEN|PASSWORD|CREDENTIALS?|SECRET|TOKEN|KEY)(?:_|$)/u;

type RuntimePool = Pick<Pool, 'query' | 'connect' | 'end'>;

export type MetaWhatsAppLiveWebhookConfig = Readonly<{
  mode: 'disabled';
  installationId: string;
  host: string;
  port: number;
}> | Readonly<{
  mode: 'signed_live';
  installationId: string;
  host: string;
  port: number;
  bindingId: string;
  binding: MetaWhatsAppBinding;
  appSecret: string;
  verifyToken: string;
}>;

export interface MetaWhatsAppLiveWebhookReadiness {
  readonly schemaVersion: 1;
  readonly event: 'ready';
  readonly service: typeof META_WHATSAPP_LIVE_WEBHOOK_SERVICE;
  readonly mode: 'disabled' | 'signed_live';
  readonly path: typeof META_WHATSAPP_LIVE_WEBHOOK_PATH;
  readonly database: Readonly<{
    role: typeof META_WHATSAPP_LIVE_WEBHOOK_DATABASE_ROLE;
    schemaCurrent: true;
    installationMatched: true;
    functionBoundaryReady: true;
  }>;
  readonly safety: Readonly<{
    rawBodySignatureVerification: true;
    maximumBodyBytes: 262144;
    outboundAccessTokenPresent: false;
    credentialEncryptionKeyPresent: false;
    providerCallsMadeAtReadiness: false;
  }>;
}

export interface MetaWhatsAppLiveWebhookRuntime {
  readonly readiness: MetaWhatsAppLiveWebhookReadiness;
  readonly handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>;
  readonly address: AddressInfo | null;
  shutdown(): Promise<void>;
}

export interface MetaWhatsAppLiveWebhookDependencies {
  readonly env?: NodeJS.ProcessEnv;
  readonly listen?: boolean;
  readonly createPool?: (
    env: NodeJS.ProcessEnv,
    hooks: Readonly<{ onBackgroundError: (error: Error) => void }>,
  ) => RuntimePool;
  readonly assertSchemaCurrent?: (pool: Pick<Pool, 'query'>) => Promise<void>;
  readonly assertInstallationReady?: (
    pool: Pick<Pool, 'query'>,
    expectedInstallationId: string | undefined,
  ) => Promise<void>;
  readonly assertBoundaryReady?: (pool: Pick<Pool, 'query'>) => Promise<void>;
  readonly createCommandService?: (
    pool: Pick<Pool, 'connect'>,
    config: Extract<MetaWhatsAppLiveWebhookConfig, { mode: 'signed_live' }>,
  ) => MetaWhatsAppLiveWebhookCommandService;
  readonly createHttpServer?: (
    handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
  ) => Server;
  readonly writeReadiness?: (line: string) => void;
  readonly writeErrorTelemetry?: (line: string) => void;
}

function uuid(value: string | undefined, label: string): string {
  const exact = value?.trim() ?? '';
  if (!UUID.test(exact)) throw new Error(`${label} must be a canonical UUID`);
  return exact;
}

function metaId(value: string | undefined, label: string): string {
  const exact = value?.trim() ?? '';
  if (!META_ID.test(exact)) throw new Error(`${label} is invalid`);
  return exact;
}

function secret(value: string | undefined, label: string): string {
  const exact = value?.trim() ?? '';
  if (!SAFE_SECRET.test(exact)) throw new Error(`${label} is unavailable`);
  return exact;
}

function port(value: string | undefined): number {
  if (!value?.trim()) return 4243;
  const exact = Number(value);
  if (!Number.isSafeInteger(exact) || exact < 1 || exact > 65_535) {
    throw new Error('Meta WhatsApp webhook PORT is invalid');
  }
  return exact;
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
    throw new Error('Meta WhatsApp webhook received another database identity');
  }
}

function assertNoUnrelatedSecrets(env: NodeJS.ProcessEnv): void {
  const unrelated = Object.keys(env).some((name) => {
    const normalized = name.toUpperCase();
    return Boolean(env[name]?.trim()) && normalized !== DATABASE_URL_ENV
      && !APPROVED_SECRET_NAMES.has(normalized) && SECRET_NAME.test(normalized);
  });
  if (unrelated) throw new Error('Meta WhatsApp webhook received an unrelated secret');
}

export function loadMetaWhatsAppLiveWebhookConfig(
  env: NodeJS.ProcessEnv,
): MetaWhatsAppLiveWebhookConfig {
  assertExactDatabaseIdentity(env);
  assertNoUnrelatedSecrets(env);
  const installationId = uuid(
    env.PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID,
    'PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID',
  );
  const host = env.HOST?.trim() || '127.0.0.1';
  const selectedPort = port(env.PORT);
  const mode = env.PROPERTY_PREDATOR_WHATSAPP_WEBHOOK_MODE?.trim() || 'disabled';
  if (mode === 'disabled') {
    return Object.freeze({ mode, installationId, host, port: selectedPort });
  }
  if (mode !== 'signed_live'
      || env.NODE_ENV?.trim().toLowerCase() !== 'production'
      || env.PROPERTY_PREDATOR_WHATSAPP_LIVE_PROVIDER_ID !== 'meta_whatsapp_cloud') {
    throw new Error('Meta WhatsApp webhook activation tuple is invalid');
  }
  return Object.freeze({
    mode,
    installationId,
    host,
    port: selectedPort,
    bindingId: uuid(
      env.PROPERTY_PREDATOR_WHATSAPP_LIVE_BINDING_ID,
      'PROPERTY_PREDATOR_WHATSAPP_LIVE_BINDING_ID',
    ),
    binding: Object.freeze({
      workspaceId: uuid(
        env.PROPERTY_PREDATOR_WHATSAPP_LIVE_WORKSPACE_ID,
        'PROPERTY_PREDATOR_WHATSAPP_LIVE_WORKSPACE_ID',
      ),
      connectionId: uuid(
        env.PROPERTY_PREDATOR_WHATSAPP_LIVE_CONNECTION_ID,
        'PROPERTY_PREDATOR_WHATSAPP_LIVE_CONNECTION_ID',
      ),
      appId: metaId(env.PROPERTY_PREDATOR_META_WHATSAPP_APP_ID,
        'PROPERTY_PREDATOR_META_WHATSAPP_APP_ID'),
      wabaId: metaId(env.PROPERTY_PREDATOR_META_WHATSAPP_WABA_ID,
        'PROPERTY_PREDATOR_META_WHATSAPP_WABA_ID'),
      phoneNumberId: metaId(env.PROPERTY_PREDATOR_META_WHATSAPP_PHONE_NUMBER_ID,
        'PROPERTY_PREDATOR_META_WHATSAPP_PHONE_NUMBER_ID'),
      graphApiVersion: 'v24.0',
    }),
    appSecret: secret(env.PROPERTY_PREDATOR_META_WHATSAPP_APP_SECRET,
      'PROPERTY_PREDATOR_META_WHATSAPP_APP_SECRET'),
    verifyToken: secret(env.PROPERTY_PREDATOR_META_WHATSAPP_VERIFY_TOKEN,
      'PROPERTY_PREDATOR_META_WHATSAPP_VERIFY_TOKEN'),
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
  response.writeHead(status, { 'Cache-Control': 'no-store', 'Content-Length': bytes.length,
    'Content-Type': contentType, 'X-Content-Type-Options': 'nosniff' });
  response.end(bytes);
}

function exactChallenge(url: URL): Readonly<{
  mode: string | undefined;
  verifyToken: string | undefined;
  challenge: string | undefined;
}> | null {
  const allowed = new Set(['hub.mode', 'hub.verify_token', 'hub.challenge']);
  const entries = [...url.searchParams.entries()];
  if (entries.length !== 3 || entries.some(([key]) => !allowed.has(key))) return null;
  for (const key of allowed) if (url.searchParams.getAll(key).length !== 1) return null;
  return Object.freeze({ mode: url.searchParams.get('hub.mode') ?? undefined,
    verifyToken: url.searchParams.get('hub.verify_token') ?? undefined,
    challenge: url.searchParams.get('hub.challenge') ?? undefined });
}

export function createMetaWhatsAppLiveWebhookRequestHandler(
  config: MetaWhatsAppLiveWebhookConfig,
  commandService: MetaWhatsAppLiveWebhookCommandService | null,
  readiness: MetaWhatsAppLiveWebhookReadiness,
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  return async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://meta-whatsapp-webhook.invalid');
    if (request.method === 'GET' && url.pathname === '/health' && url.search === '') {
      send(response, 200, JSON.stringify(readiness));
      return;
    }
    if (url.pathname !== META_WHATSAPP_LIVE_WEBHOOK_PATH) {
      send(response, 404, JSON.stringify({ error: 'not_found' }));
      return;
    }
    if (config.mode === 'disabled' || !commandService) {
      send(response, 503, JSON.stringify({ error: 'whatsapp_webhook_disabled' }));
      return;
    }
    if (request.method === 'GET') {
      const challenge = exactChallenge(url);
      if (!challenge) {
        send(response, 400, '');
        return;
      }
      const result = verifyMetaWhatsAppLiveChallenge(
        { verifyToken: config.verifyToken }, challenge,
      );
      send(response, result.status, result.body, 'text/plain; charset=utf-8');
      return;
    }
    if (request.method !== 'POST' || url.search !== '') {
      send(response, 405, JSON.stringify({ error: 'method_not_allowed' }));
      return;
    }
    try {
      const body = await rawBody(request);
      const verified = verifyMetaWhatsAppLiveWebhook({ binding: config.binding,
        appSecret: config.appSecret, rawBody: body,
        xHubSignature256: request.headers['x-hub-signature-256'],
        contentType: request.headers['content-type'] });
      await dispatchVerifiedMetaWhatsAppLiveEvents({ verified, commandService });
      send(response, 200, JSON.stringify({ accepted: true }));
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        send(response, 413, JSON.stringify({ error: 'payload_too_large' }));
      } else if (error instanceof InvalidBodyError) {
        send(response, 400, JSON.stringify({ error: 'invalid_request' }));
      } else if (error instanceof MetaWhatsAppLiveError
          && error.code === 'signature_invalid') {
        send(response, 401, JSON.stringify({ error: 'invalid_signature' }));
      } else if (error instanceof MetaWhatsAppLiveError
          && ['webhook_invalid', 'invalid_binding'].includes(error.code)) {
        send(response, 400, JSON.stringify({ error: 'invalid_webhook' }));
      } else {
        send(response, 503, JSON.stringify({ error: 'webhook_temporarily_unavailable' }));
      }
    }
  };
}

function readinessFor(config: MetaWhatsAppLiveWebhookConfig): MetaWhatsAppLiveWebhookReadiness {
  return Object.freeze({ schemaVersion: 1, event: 'ready',
    service: META_WHATSAPP_LIVE_WEBHOOK_SERVICE, mode: config.mode,
    path: META_WHATSAPP_LIVE_WEBHOOK_PATH,
    database: Object.freeze({ role: META_WHATSAPP_LIVE_WEBHOOK_DATABASE_ROLE,
      schemaCurrent: true, installationMatched: true, functionBoundaryReady: true }),
    safety: Object.freeze({ rawBodySignatureVerification: true,
      maximumBodyBytes: 262144, outboundAccessTokenPresent: false,
      credentialEncryptionKeyPresent: false, providerCallsMadeAtReadiness: false }) });
}

export async function startMetaWhatsAppLiveWebhookService(
  dependencies: MetaWhatsAppLiveWebhookDependencies = {},
): Promise<MetaWhatsAppLiveWebhookRuntime> {
  const env = dependencies.env ?? process.env;
  const config = loadMetaWhatsAppLiveWebhookConfig(env);
  let backgroundErrors = 0;
  const writeError = dependencies.writeErrorTelemetry
    ?? ((line: string) => { process.stderr.write(line); });
  const pool = (dependencies.createPool ?? createWhatsAppLiveWebhookCommandDatabasePool)(env, {
    onBackgroundError: () => {
      backgroundErrors += 1;
      writeError(`${JSON.stringify({ schemaVersion: 1, event: 'webhook_error',
        service: META_WHATSAPP_LIVE_WEBHOOK_SERVICE,
        eventKind: 'background_database', count: backgroundErrors })}\n`);
    },
  });
  try {
    await (dependencies.assertSchemaCurrent ?? assertRuntimeSchemaCurrent)(pool);
    await (dependencies.assertInstallationReady ?? assertExpectedDatabaseInstallation)(
      pool, config.installationId,
    );
    await (dependencies.assertBoundaryReady ?? assertMetaWhatsAppLiveWebhookBoundaryReady)(pool);
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }
  let commandService: MetaWhatsAppLiveWebhookCommandService | null = null;
  if (config.mode === 'signed_live') {
    commandService = (dependencies.createCommandService
      ?? ((commandPool, exact) => new PgMetaWhatsAppLiveWebhookCommandService({
        commandPool, workspaceId: exact.binding.workspaceId,
        connectionId: exact.binding.connectionId, bindingId: exact.bindingId,
      })))(pool, config);
  }
  const readiness = readinessFor(config);
  try {
    (dependencies.writeReadiness ?? ((line: string) => { process.stdout.write(line); }))(
      `${JSON.stringify(readiness)}\n`,
    );
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }
  const handler = createMetaWhatsAppLiveWebhookRequestHandler(
    config, commandService, readiness,
  );
  let server: Server | null = null;
  if (dependencies.listen !== false) {
    server = (dependencies.createHttpServer ?? ((listener) => createServer((request, response) => {
      void listener(request, response).catch(() => {
        if (!response.headersSent) send(response, 503,
          JSON.stringify({ error: 'webhook_temporarily_unavailable' }));
        else response.destroy();
      });
    })))(handler);
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(config.port, config.host, () => {
        server!.removeListener('error', reject);
        resolve();
      });
    }).catch(async (error) => {
      await pool.end().catch(() => undefined);
      throw error;
    });
  }
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      if (server) await new Promise<void>((resolve, reject) => {
        server!.close((error) => { if (error) reject(error); else resolve(); });
      });
      await pool.end();
    })();
    return shutdownPromise;
  };
  return Object.freeze({ readiness, handler,
    address: server?.address() as AddressInfo | null ?? null, shutdown });
}
