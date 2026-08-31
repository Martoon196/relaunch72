import { createHash } from 'node:crypto';
import {
  PublicSocialOutboundContractError,
  PublicSocialOutboundDisabledError,
  executePublicSocialContractHttpRequest,
  isAuthenticPublicSocialContractHttpTransport,
  type PublicSocialContractHttpTransport,
  type PublicSocialHttpRequest,
  type PublicSocialHttpResponse,
} from './contracts.js';

export const ZERNIO_PUBLIC_SOCIAL_PROVIDER_ID = 'zernio' as const;
export const ZERNIO_CONNECTION_CONTRACT_VERSION = 'r72-zernio-connect-v1' as const;
export const ZERNIO_CONNECTION_CALLBACK_URL =
  'https://hq.propertypredator.com/portal/social/accounts/callback' as const;
export const ZERNIO_PILOT_NETWORKS = Object.freeze([
  'facebook', 'instagram', 'linkedin',
] as const);

export type ZernioPilotNetwork = typeof ZERNIO_PILOT_NETWORKS[number];

export const ZERNIO_CONNECTION_SECURITY_CONTRACT = Object.freeze({
  origin: 'https://zernio.com',
  path: '/api/v1/connect/{platform}',
  authentication: 'bearer_header_only',
  redirectPolicy: 'error',
  responseMode: 'bounded_stream',
  maximumResponseBytes: 65_536,
  minimumTimeoutMs: 1_000,
  maximumTimeoutMs: 30_000,
  headless: true,
  workspaceProfileBindingRequired: true,
  accountConnectedWebhookRequired: true,
  callbackUrl: ZERNIO_CONNECTION_CALLBACK_URL,
} as const);

export interface CreateZernioConnectionCredentialInput {
  readonly workspaceId: string;
  readonly connectionId: string;
  readonly providerProfileId: string;
  readonly credentialVersion: string;
  readonly apiKey: string;
  readonly profileBindingEvidenceSha256: string;
  readonly observedAt: string;
}

export interface ZernioConnectionCredential {
  readonly kind: 'zernio_connection_credentials';
  readonly workspaceId: string;
  readonly connectionId: string;
  readonly providerProfileId: string;
  readonly credentialVersion: string;
  readonly profileBindingEvidenceSha256: string;
  readonly observedAt: string;
  readonly bindingSha256: string;
}

export interface ZernioConnectionContext {
  readonly workspaceId: string;
  readonly connectionId: string;
  readonly providerId: typeof ZERNIO_PUBLIC_SOCIAL_PROVIDER_ID;
  readonly operationId: string;
  readonly correlationId: string;
}

export interface ZernioConnectionRequest {
  readonly network: ZernioPilotNetwork;
  readonly redirectUrl: string;
  readonly headless: true;
}

export interface ZernioConnectionResult {
  readonly status: 'ready' | 'failed' | 'needs_attention';
  readonly authUrl: string | null;
  readonly providerStateSha256: string | null;
  readonly occurredAt: string;
  readonly retryable: boolean;
  readonly errorCode: string | null;
  readonly summary: string;
  readonly providerEffects: 'oauth_not_started';
}

interface CredentialSecrets {
  readonly apiKey: string;
}

interface EnabledContract {
  readonly credential: ZernioConnectionCredential;
  readonly apiKey: string;
  readonly http: PublicSocialContractHttpTransport;
  readonly observedAt: string;
}

export interface ZernioConnectionContractOptions {
  readonly executionMode?: 'disabled' | 'contract_test';
  readonly credential?: ZernioConnectionCredential;
  readonly http?: PublicSocialContractHttpTransport;
  readonly observedAt?: string;
  readonly timeoutMs?: number;
}

const CREDENTIALS = new WeakMap<object, CredentialSecrets>();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const PROVIDER_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{2,127}$/u;
const VERSION = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/u;
const SECRET = /^[\x21-\x7e]{8,500}$/u;
const NETWORKS = new Set<unknown>(ZERNIO_PILOT_NETWORKS);
const AUTH_HOSTS = new Set([
  'zernio.com', 'www.zernio.com',
  'facebook.com', 'www.facebook.com',
  'instagram.com', 'www.instagram.com', 'api.instagram.com',
  'linkedin.com', 'www.linkedin.com',
]);
const OPAQUE_PROVIDER_STATE = /^[\x21-\x7e]{8,1024}$/u;

function fail(message: string): never {
  throw new PublicSocialOutboundContractError(message);
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${label} is invalid`);
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) fail(`${label} is invalid`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some((descriptor) => descriptor.get || descriptor.set)) {
    fail(`${label} is invalid`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(source: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(source).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} has unexpected fields`);
  }
}

function allowedKeys(source: Record<string, unknown>, allowed: readonly string[], label: string): void {
  if (Object.keys(source).some((key) => !allowed.includes(key))) {
    fail(`${label} has unexpected fields`);
  }
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== 'string') fail(`${label} is invalid`);
  const normalised = value.trim().toLowerCase();
  if (!UUID.test(normalised)) fail(`${label} is invalid`);
  return normalised;
}

function canonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string') fail(`${label} is invalid`);
  const parsed = new Date(value);
  if (!Number.isFinite(Date.prototype.getTime.call(parsed))
      || Date.prototype.toISOString.call(parsed) !== value) {
    fail(`${label} must be a canonical UTC timestamp`);
  }
  return value;
}

function canonicalHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function sha256Utf8(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function safeHttpsUrl(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length > 2_048) fail(`${label} is invalid`);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    fail(`${label} is invalid`);
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash
      || (parsed.port !== '' && parsed.port !== '443')) {
    fail(`${label} is invalid`);
  }
  return parsed.toString();
}

export function createZernioConnectionCredential(
  input: CreateZernioConnectionCredentialInput,
): ZernioConnectionCredential {
  const source = plainRecord(input, 'Zernio credential');
  exactKeys(source, [
    'workspaceId', 'connectionId', 'providerProfileId', 'credentialVersion', 'apiKey',
    'profileBindingEvidenceSha256', 'observedAt',
  ], 'Zernio credential');
  const workspaceId = uuid(source.workspaceId, 'credential.workspaceId');
  const connectionId = uuid(source.connectionId, 'credential.connectionId');
  if (typeof source.providerProfileId !== 'string' || !PROVIDER_ID.test(source.providerProfileId)) {
    fail('credential.providerProfileId is invalid');
  }
  if (typeof source.credentialVersion !== 'string' || !VERSION.test(source.credentialVersion)) {
    fail('credential.credentialVersion is invalid');
  }
  if (typeof source.apiKey !== 'string' || !SECRET.test(source.apiKey)) {
    fail('credential secret is invalid');
  }
  if (typeof source.profileBindingEvidenceSha256 !== 'string'
      || !SHA256.test(source.profileBindingEvidenceSha256)) {
    fail('credential profile binding evidence is invalid');
  }
  const observedAt = canonicalTimestamp(source.observedAt, 'credential.observedAt');
  const providerProfileId = source.providerProfileId;
  const credentialVersion = source.credentialVersion;
  const profileBindingEvidenceSha256 = source.profileBindingEvidenceSha256;
  const bindingSha256 = canonicalHash({
    contract: ZERNIO_CONNECTION_CONTRACT_VERSION,
    workspaceId,
    connectionId,
    providerProfileId,
    credentialVersion,
    apiKeySha256: sha256Utf8(source.apiKey),
    profileBindingEvidenceSha256,
    observedAt,
  });
  const credential = Object.freeze({
    kind: 'zernio_connection_credentials' as const,
    workspaceId,
    connectionId,
    providerProfileId,
    credentialVersion,
    profileBindingEvidenceSha256,
    observedAt,
    bindingSha256,
    toJSON: () => Object.freeze({
      kind: 'zernio_connection_credentials', workspaceId, connectionId, providerProfileId,
      credentialVersion, profileBindingEvidenceSha256, observedAt, bindingSha256,
      secrets: '[REDACTED]',
    }),
  });
  CREDENTIALS.set(credential, Object.freeze({ apiKey: source.apiKey }));
  return credential;
}

function readCredential(credential: ZernioConnectionCredential): Readonly<{
  credential: ZernioConnectionCredential;
  apiKey: string;
}> {
  const secrets = CREDENTIALS.get(credential as object);
  if (!secrets) fail('Zernio credential is not authentic');
  return Object.freeze({ credential, apiKey: secrets.apiKey });
}

function snapshotContext(input: ZernioConnectionContext): ZernioConnectionContext {
  const source = plainRecord(input, 'Zernio connection context');
  exactKeys(source, [
    'workspaceId', 'connectionId', 'providerId', 'operationId', 'correlationId',
  ], 'Zernio connection context');
  if (source.providerId !== ZERNIO_PUBLIC_SOCIAL_PROVIDER_ID) {
    fail('Zernio connection context has the wrong provider');
  }
  return Object.freeze({
    workspaceId: uuid(source.workspaceId, 'context.workspaceId'),
    connectionId: uuid(source.connectionId, 'context.connectionId'),
    providerId: ZERNIO_PUBLIC_SOCIAL_PROVIDER_ID,
    operationId: uuid(source.operationId, 'context.operationId'),
    correlationId: uuid(source.correlationId, 'context.correlationId'),
  });
}

function snapshotRequest(input: ZernioConnectionRequest, allowedRedirectUrl: string): ZernioConnectionRequest {
  const source = plainRecord(input, 'Zernio connection request');
  exactKeys(source, ['network', 'redirectUrl', 'headless'], 'Zernio connection request');
  if (!NETWORKS.has(source.network)) fail('Zernio pilot network is not supported');
  const redirectUrl = safeHttpsUrl(source.redirectUrl, 'request.redirectUrl');
  if (redirectUrl !== allowedRedirectUrl || source.headless !== true) {
    fail('Zernio connection request is outside the reviewed callback boundary');
  }
  return Object.freeze({
    network: source.network as ZernioPilotNetwork,
    redirectUrl,
    headless: true,
  });
}

function responseResult(
  status: ZernioConnectionResult['status'],
  observedAt: string,
  input: Partial<Omit<ZernioConnectionResult, 'status' | 'occurredAt' | 'providerEffects'>>,
): ZernioConnectionResult {
  return Object.freeze({
    status,
    authUrl: input.authUrl ?? null,
    providerStateSha256: input.providerStateSha256 ?? null,
    occurredAt: observedAt,
    retryable: input.retryable ?? false,
    errorCode: input.errorCode ?? null,
    summary: input.summary ?? 'Zernio connection preparation did not complete',
    providerEffects: 'oauth_not_started',
  });
}

function parseResponseBody(bodyUtf8: string): Record<string, unknown> | null {
  try {
    return plainRecord(JSON.parse(bodyUtf8), 'Zernio response');
  } catch {
    return null;
  }
}

export class ZernioConnectionContract {
  readonly providerId = ZERNIO_PUBLIC_SOCIAL_PROVIDER_ID;
  readonly executionMode: 'disabled' | 'contract_test';
  readonly timeoutMs: number;
  readonly #enabled: EnabledContract | null;

  constructor(options: ZernioConnectionContractOptions = {}) {
    const source = plainRecord(options, 'Zernio connection options');
    allowedKeys(source, [
      'executionMode', 'credential', 'http', 'observedAt', 'timeoutMs',
    ], 'Zernio connection options');
    const executionMode = options.executionMode ?? 'disabled';
    if (executionMode !== 'disabled' && executionMode !== 'contract_test') {
      fail('Zernio execution mode is invalid');
    }
    const timeoutMs = options.timeoutMs ?? 5_000;
    if (!Number.isSafeInteger(timeoutMs)
        || timeoutMs < ZERNIO_CONNECTION_SECURITY_CONTRACT.minimumTimeoutMs
        || timeoutMs > ZERNIO_CONNECTION_SECURITY_CONTRACT.maximumTimeoutMs) {
      fail('Zernio timeout is invalid');
    }
    this.executionMode = executionMode;
    this.timeoutMs = timeoutMs;
    if (executionMode === 'disabled') {
      this.#enabled = null;
      return;
    }
    if (!options.credential || !options.http || !options.observedAt) {
      fail('Zernio contract-test mode is incomplete');
    }
    if (!isAuthenticPublicSocialContractHttpTransport(options.http)) {
      fail('Zernio contract-test mode requires an authentic pure scripted transport');
    }
    const credential = readCredential(options.credential);
    const observedAt = canonicalTimestamp(options.observedAt, 'options.observedAt');
    if (credential.credential.observedAt !== observedAt) {
      fail('Zernio credential observation is stale or mismatched');
    }
    this.#enabled = Object.freeze({
      credential: credential.credential,
      apiKey: credential.apiKey,
      http: options.http,
      observedAt,
    });
  }

  async prepare(
    contextInput: ZernioConnectionContext,
    requestInput: ZernioConnectionRequest,
  ): Promise<ZernioConnectionResult> {
    if (!this.#enabled) throw new PublicSocialOutboundDisabledError();
    const context = snapshotContext(contextInput);
    const request = snapshotRequest(requestInput, ZERNIO_CONNECTION_CALLBACK_URL);
    if (context.workspaceId !== this.#enabled.credential.workspaceId
        || context.connectionId !== this.#enabled.credential.connectionId) {
      fail('Zernio credential is not bound to this workspace connection');
    }
    const path = ZERNIO_CONNECTION_SECURITY_CONTRACT.path.replace('{platform}', request.network);
    const url = new URL(path, ZERNIO_CONNECTION_SECURITY_CONTRACT.origin);
    url.searchParams.set('profileId', this.#enabled.credential.providerProfileId);
    url.searchParams.set('redirect_url', request.redirectUrl);
    url.searchParams.set('headless', 'true');
    const httpRequest: PublicSocialHttpRequest = Object.freeze({
      method: 'GET',
      url: url.toString(),
      headers: Object.freeze({ Authorization: `Bearer ${this.#enabled.apiKey}` }),
      bodyUtf8: null,
      timeoutMs: this.timeoutMs,
      redirectPolicy: ZERNIO_CONNECTION_SECURITY_CONTRACT.redirectPolicy,
      maximumResponseBytes: ZERNIO_CONNECTION_SECURITY_CONTRACT.maximumResponseBytes,
    });
    let response: PublicSocialHttpResponse;
    try {
      response = await executePublicSocialContractHttpRequest(this.#enabled.http, httpRequest);
    } catch {
      return responseResult('needs_attention', this.#enabled.observedAt, {
        retryable: false,
        errorCode: 'zernio_connection_outcome_unknown',
        summary: 'Zernio did not prove whether the OAuth preparation request succeeded',
      });
    }
    const body = parseResponseBody(response.bodyUtf8);
    if (response.status === 429) {
      return responseResult('failed', this.#enabled.observedAt, {
        retryable: true,
        errorCode: 'zernio_rate_limited',
        summary: 'Zernio temporarily rate-limited the connection preparation request',
      });
    }
    if (response.status === 402) {
      return responseResult('failed', this.#enabled.observedAt, {
        errorCode: 'zernio_billing_suspended',
        summary: 'Zernio billing is suspended; no OAuth flow was opened',
      });
    }
    if (response.status !== 200 || !body) {
      return responseResult('failed', this.#enabled.observedAt, {
        errorCode: 'zernio_connection_rejected',
        summary: 'Zernio rejected the connection preparation request',
      });
    }
    let authUrl: string;
    try {
      authUrl = safeHttpsUrl(body.authUrl, 'Zernio response.authUrl');
    } catch {
      return responseResult('needs_attention', this.#enabled.observedAt, {
        errorCode: 'zernio_oauth_response_unbound',
        summary: 'Zernio returned an OAuth response outside the reviewed redirect contract',
      });
    }
    const authHost = new URL(authUrl).hostname.toLowerCase();
    if (!AUTH_HOSTS.has(authHost) || typeof body.state !== 'string'
        || !OPAQUE_PROVIDER_STATE.test(body.state)) {
      return responseResult('needs_attention', this.#enabled.observedAt, {
        errorCode: 'zernio_oauth_response_unbound',
        summary: 'Zernio returned an OAuth response outside the reviewed redirect contract',
      });
    }
    return responseResult('ready', this.#enabled.observedAt, {
      authUrl,
      providerStateSha256: sha256Utf8(body.state),
      summary: `Zernio prepared the exact ${request.network} OAuth flow`,
    });
  }

  toJSON(): Readonly<Record<string, unknown>> {
    return Object.freeze({
      provider: this.providerId,
      executionMode: this.executionMode,
      credentials: '[REDACTED]',
      providerEffects: 'oauth_not_started',
    });
  }
}
