import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  PublicSocialOutboundContractError,
} from './contracts.js';
import {
  ZERNIO_CONNECTION_CONTRACT_VERSION,
  ZERNIO_PILOT_NETWORKS,
  type ZernioPilotNetwork,
} from './zernio-connection-contract.js';

export const ZERNIO_ACCOUNT_WEBHOOK_CONTRACT_VERSION =
  'r72-zernio-account-webhook-v1' as const;
export const ZERNIO_ACCOUNT_WEBHOOK_MAXIMUM_BYTES = 65_536;

export interface ZernioAccountWebhookCredentialInput {
  readonly workspaceId: string;
  readonly connectionId: string;
  readonly providerProfileId: string;
  readonly credentialVersion: string;
  readonly webhookSecret: string;
}

export interface ZernioAccountWebhookCredential {
  readonly kind: 'zernio_account_webhook_credentials';
  readonly workspaceId: string;
  readonly connectionId: string;
  readonly providerProfileId: string;
  readonly credentialVersion: string;
  readonly bindingSha256: string;
}

export interface VerifyZernioAccountWebhookInput {
  readonly rawBody: Uint8Array;
  readonly signatureHeader: string;
  readonly eventIdHeader: string;
}

export interface VerifiedZernioAccountWebhook {
  readonly contract: typeof ZERNIO_ACCOUNT_WEBHOOK_CONTRACT_VERSION;
  readonly workspaceId: string;
  readonly connectionId: string;
  readonly eventId: string;
  readonly event: 'account.connected' | 'account.disconnected';
  readonly network: ZernioPilotNetwork;
  readonly occurredAt: string;
  readonly providerProfileIdSha256: string;
  readonly providerAccountIdSha256: string;
  readonly rawBodySha256: string;
  readonly receiptSha256: string;
  readonly providerEffects: 'none';
}

interface SecretMaterial {
  readonly webhookSecret: string;
}

const SECRETS = new WeakMap<object, SecretMaterial>();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/u;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const SECRET = /^[\x21-\x7e]{16,500}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const NETWORKS = new Set<unknown>(ZERNIO_PILOT_NETWORKS);

function fail(message: string): never {
  throw new PublicSocialOutboundContractError(message);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${label} is invalid`);
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) fail(`${label} is invalid`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some((descriptor) => descriptor.get || descriptor.set)) {
    fail(`${label} is invalid`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} has unexpected fields`);
  }
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== 'string') fail(`${label} is invalid`);
  const canonical = value.trim().toLowerCase();
  if (!UUID.test(canonical)) fail(`${label} is invalid`);
  return canonical;
}

function providerId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !PROVIDER_ID.test(value)) fail(`${label} is invalid`);
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== 'string') fail(`${label} is invalid`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    fail(`${label} must be a canonical UTC timestamp`);
  }
  return value;
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function createZernioAccountWebhookCredential(
  input: ZernioAccountWebhookCredentialInput,
): ZernioAccountWebhookCredential {
  const source = record(input, 'Zernio webhook credential');
  exactKeys(source, [
    'workspaceId', 'connectionId', 'providerProfileId', 'credentialVersion', 'webhookSecret',
  ], 'Zernio webhook credential');
  const workspaceId = uuid(source.workspaceId, 'credential.workspaceId');
  const connectionId = uuid(source.connectionId, 'credential.connectionId');
  const profile = providerId(source.providerProfileId, 'credential.providerProfileId');
  if (typeof source.credentialVersion !== 'string' || !VERSION.test(source.credentialVersion)) {
    fail('credential.credentialVersion is invalid');
  }
  if (typeof source.webhookSecret !== 'string' || !SECRET.test(source.webhookSecret)) {
    fail('credential webhook secret is invalid');
  }
  const credentialVersion = source.credentialVersion;
  const bindingSha256 = sha256(JSON.stringify({
    contract: ZERNIO_ACCOUNT_WEBHOOK_CONTRACT_VERSION,
    connectionContract: ZERNIO_CONNECTION_CONTRACT_VERSION,
    workspaceId,
    connectionId,
    providerProfileId: profile,
    credentialVersion,
    webhookSecretSha256: sha256(source.webhookSecret),
  }));
  const credential = Object.freeze({
    kind: 'zernio_account_webhook_credentials' as const,
    workspaceId,
    connectionId,
    providerProfileId: profile,
    credentialVersion,
    bindingSha256,
    toJSON: () => Object.freeze({
      kind: 'zernio_account_webhook_credentials', workspaceId, connectionId,
      providerProfileId: profile, credentialVersion, bindingSha256, secrets: '[REDACTED]',
    }),
  });
  SECRETS.set(credential, Object.freeze({ webhookSecret: source.webhookSecret }));
  return credential;
}

export function verifyZernioAccountWebhook(
  credential: ZernioAccountWebhookCredential,
  input: VerifyZernioAccountWebhookInput,
): VerifiedZernioAccountWebhook {
  const secret = SECRETS.get(credential as object);
  if (!secret) fail('Zernio webhook credential is not authentic');
  const source = record(input, 'Zernio webhook input');
  exactKeys(source, ['rawBody', 'signatureHeader', 'eventIdHeader'], 'Zernio webhook input');
  if (!(source.rawBody instanceof Uint8Array)) {
    fail('Zernio webhook body is invalid');
  }
  let rawBody: Buffer;
  try {
    rawBody = Buffer.from(source.rawBody);
  } catch {
    fail('Zernio webhook body is invalid');
  }
  if (rawBody.length < 2 || rawBody.length > ZERNIO_ACCOUNT_WEBHOOK_MAXIMUM_BYTES) {
    fail('Zernio webhook body is invalid');
  }
  if (typeof source.signatureHeader !== 'string' || !SHA256.test(source.signatureHeader)) {
    fail('Zernio webhook signature is invalid');
  }
  const supplied = Buffer.from(source.signatureHeader, 'hex');
  const expected = createHmac('sha256', secret.webhookSecret).update(rawBody).digest();
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    fail('Zernio webhook signature is invalid');
  }
  const headerEventId = uuid(source.eventIdHeader, 'Zernio webhook event header');
  let payload: Record<string, unknown>;
  try {
    const json = new TextDecoder('utf-8', { fatal: true }).decode(rawBody);
    payload = record(JSON.parse(json), 'Zernio webhook payload');
  } catch {
    fail('Zernio webhook payload is invalid');
  }
  exactKeys(payload, ['id', 'event', 'timestamp', 'account'], 'Zernio webhook payload');
  const eventId = uuid(payload.id, 'payload.id');
  if (eventId !== headerEventId) fail('Zernio webhook event identity is mismatched');
  if (payload.event !== 'account.connected' && payload.event !== 'account.disconnected') {
    fail('Zernio webhook event is not supported');
  }
  const account = record(payload.account, 'Zernio webhook account');
  const allowedAccountKeys = new Set([
    'accountId', 'profileId', 'platform', 'username', 'displayName', 'disconnectionType',
  ]);
  if (Object.keys(account).some((key) => !allowedAccountKeys.has(key))) {
    fail('Zernio webhook account has unexpected fields');
  }
  const accountId = providerId(account.accountId, 'account.accountId');
  const profile = providerId(account.profileId, 'account.profileId');
  if (profile !== credential.providerProfileId) fail('Zernio webhook profile is not bound');
  if (!NETWORKS.has(account.platform)) fail('Zernio webhook network is not supported');
  if (payload.event === 'account.disconnected'
      && account.disconnectionType !== undefined
      && account.disconnectionType !== 'intentional'
      && account.disconnectionType !== 'unintentional') {
    fail('Zernio webhook disconnection type is invalid');
  }
  const occurredAt = timestamp(payload.timestamp, 'payload.timestamp');
  const rawBodySha256 = sha256(rawBody);
  const providerProfileIdSha256 = sha256(profile);
  const providerAccountIdSha256 = sha256(accountId);
  const receiptSha256 = sha256(JSON.stringify({
    contract: ZERNIO_ACCOUNT_WEBHOOK_CONTRACT_VERSION,
    workspaceId: credential.workspaceId,
    connectionId: credential.connectionId,
    eventId,
    event: payload.event,
    network: account.platform,
    occurredAt,
    providerProfileIdSha256,
    providerAccountIdSha256,
    rawBodySha256,
  }));
  return Object.freeze({
    contract: ZERNIO_ACCOUNT_WEBHOOK_CONTRACT_VERSION,
    workspaceId: credential.workspaceId,
    connectionId: credential.connectionId,
    eventId,
    event: payload.event,
    network: account.platform as ZernioPilotNetwork,
    occurredAt,
    providerProfileIdSha256,
    providerAccountIdSha256,
    rawBodySha256,
    receiptSha256,
    providerEffects: 'none',
  });
}
