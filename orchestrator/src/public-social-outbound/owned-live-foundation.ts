import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

const AYRSHARE_ORIGIN = 'https://api.ayrshare.com';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_EXTERNAL_ID = /^[A-Za-z0-9_-]{1,200}$/u;
const SAFE_SECRET = /^[\x21-\x7e]{8,500}$/u;
const SAFE_OPERATION_TAG = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u;
const SAFE_SOCIAL_TEXT = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]{1,3000}$/u;
const LINK_LIKE = /(?:\/\/|\b[a-z][a-z0-9+.-]*:|\bwww\.|\b[a-z0-9](?:[a-z0-9-]{0,62})\.(?:[a-z]{2,63})(?:[/?#][^\s]*)?)/iu;
const MAX_RESPONSE_BYTES = 65_536;

export const OWNED_PUBLIC_SOCIAL_LIVE_CONTRACT =
  'propertypredator.owned-public-social-live/v1' as const;

export type OwnedPublicSocialNetwork = 'instagram' | 'linkedin' | 'x';

const AYRSHARE_PLATFORM: Readonly<Record<OwnedPublicSocialNetwork, string>> = Object.freeze({
  instagram: 'instagram',
  linkedin: 'linkedin',
  x: 'twitter',
});

const NETWORK_TEXT_LIMIT: Readonly<Record<OwnedPublicSocialNetwork, number>> = Object.freeze({
  instagram: 2_200,
  linkedin: 3_000,
  x: 280,
});

const NETWORK_MEDIA_LIMIT: Readonly<Record<OwnedPublicSocialNetwork, number>> = Object.freeze({
  instagram: 10,
  linkedin: 9,
  x: 4,
});

export class OwnedPublicSocialLiveError extends Error {
  constructor(readonly code:
    | 'disabled'
    | 'invalid_configuration'
    | 'invalid_binding'
    | 'invalid_request'
    | 'provider_rejected'
    | 'provider_outcome_unknown'
    | 'provider_response_invalid') {
    super(`Owned public-social live rail failed: ${code}`);
    this.name = 'OwnedPublicSocialLiveError';
  }
}

function fail(code: OwnedPublicSocialLiveError['code']): never {
  throw new OwnedPublicSocialLiveError(code);
}

function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) fail('invalid_binding');
  return value;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function exactTimestamp(value: unknown): string {
  if (typeof value !== 'string') fail('invalid_request');
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) fail('invalid_request');
  return value;
}

function sameUtcInstant(value: unknown, expected: string): boolean {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value)) {
    return false;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed === Date.parse(expected);
}

function canonicalAad(
  workspaceId: string,
  connectionId: string,
  profileId: string,
  network: OwnedPublicSocialNetwork,
): Buffer {
  return Buffer.from(JSON.stringify({
    contract: OWNED_PUBLIC_SOCIAL_LIVE_CONTRACT,
    workspaceId: uuid(workspaceId),
    connectionId: uuid(connectionId),
    profileId: uuid(profileId),
    providerId: 'ayrshare',
    network,
  }), 'utf8');
}

export interface OwnedProfileKeyEnvelope {
  readonly algorithm: 'aes-256-gcm-v1';
  readonly keyVersion: string;
  readonly ivBase64: string;
  readonly ciphertextBase64: string;
  readonly authTagBase64: string;
  readonly aadSha256: string;
  readonly profileKeySha256: string;
}

export function encryptOwnedProfileKey(input: Readonly<{
  workspaceId: string;
  connectionId: string;
  profileId: string;
  profileKey: string;
  keyVersion: string;
  encryptionKey: Buffer;
  iv?: Buffer;
  network?: OwnedPublicSocialNetwork;
}>): OwnedProfileKeyEnvelope {
  if (!SAFE_SECRET.test(input.profileKey)
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(input.keyVersion)
      || input.encryptionKey.length !== 32) fail('invalid_configuration');
  const iv = input.iv ? Buffer.from(input.iv) : randomBytes(12);
  if (iv.length !== 12) fail('invalid_configuration');
  const aad = canonicalAad(
    input.workspaceId, input.connectionId, input.profileId, input.network ?? 'x',
  );
  const cipher = createCipheriv('aes-256-gcm', input.encryptionKey, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(input.profileKey, 'utf8')),
    cipher.final(),
  ]);
  return Object.freeze({
    algorithm: 'aes-256-gcm-v1',
    keyVersion: input.keyVersion,
    ivBase64: iv.toString('base64'),
    ciphertextBase64: ciphertext.toString('base64'),
    authTagBase64: cipher.getAuthTag().toString('base64'),
    aadSha256: sha256(aad),
    profileKeySha256: sha256(input.profileKey),
  });
}

function exactBase64(value: unknown, expectedLength?: number): Buffer {
  if (typeof value !== 'string' || value.length < 4 || value.length > 2_048
      || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) fail('invalid_binding');
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value || (expectedLength && decoded.length !== expectedLength)) {
    fail('invalid_binding');
  }
  return decoded;
}

export function decryptOwnedProfileKey(input: Readonly<{
  workspaceId: string;
  connectionId: string;
  profileId: string;
  envelope: OwnedProfileKeyEnvelope;
  encryptionKey: Buffer;
  expectedKeyVersion: string;
  network?: OwnedPublicSocialNetwork;
}>): string {
  const envelope = input.envelope;
  if (envelope.algorithm !== 'aes-256-gcm-v1'
      || envelope.keyVersion !== input.expectedKeyVersion
      || input.encryptionKey.length !== 32
      || !SHA256.test(envelope.aadSha256)
      || !SHA256.test(envelope.profileKeySha256)) fail('invalid_binding');
  const aad = canonicalAad(
    input.workspaceId, input.connectionId, input.profileId, input.network ?? 'x',
  );
  const aadHash = Buffer.from(sha256(aad), 'hex');
  const expectedAadHash = Buffer.from(envelope.aadSha256, 'hex');
  if (!timingSafeEqual(aadHash, expectedAadHash)) fail('invalid_binding');
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm', input.encryptionKey, exactBase64(envelope.ivBase64, 12),
    );
    decipher.setAAD(aad);
    decipher.setAuthTag(exactBase64(envelope.authTagBase64, 16));
    const plaintext = Buffer.concat([
      decipher.update(exactBase64(envelope.ciphertextBase64)),
      decipher.final(),
    ]).toString('utf8');
    if (!SAFE_SECRET.test(plaintext)) fail('invalid_binding');
    const actualHash = Buffer.from(sha256(plaintext), 'hex');
    const expectedHash = Buffer.from(envelope.profileKeySha256, 'hex');
    if (!timingSafeEqual(actualHash, expectedHash)) fail('invalid_binding');
    return plaintext;
  } catch (error) {
    if (error instanceof OwnedPublicSocialLiveError) throw error;
    fail('invalid_binding');
  }
}

export interface OwnedPublicSocialLiveRuntimeConfig {
  readonly executionMode: 'disabled' | 'owned_profile_live';
  readonly providerEffectsEnabled: boolean;
  readonly emergencyPaused: boolean;
  readonly providerId: 'ayrshare';
  readonly network: OwnedPublicSocialNetwork | 'instagram_linkedin';
  readonly maximumOperationsPerCycle: 1;
  readonly dailyPublishCap: 1;
  readonly monthlyPublishCap: 3;
}

export function loadOwnedPublicSocialLiveRuntimeConfig(
  env: NodeJS.ProcessEnv,
): OwnedPublicSocialLiveRuntimeConfig {
  const executionMode = env.PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_MODE ?? 'disabled';
  const effects = env.PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED === 'true';
  const paused = env.PROPERTY_PREDATOR_SOCIAL_EMERGENCY_PAUSED !== 'false';
  if (executionMode === 'disabled') {
    if (effects || !paused) fail('invalid_configuration');
    return Object.freeze({
      executionMode, providerEffectsEnabled: false, emergencyPaused: true,
      providerId: 'ayrshare', network: 'x', maximumOperationsPerCycle: 1,
      dailyPublishCap: 1, monthlyPublishCap: 3,
    });
  }
  if (executionMode !== 'owned_profile_live'
      || env.PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_PROVIDER_ID !== 'ayrshare'
      || !['instagram', 'linkedin', 'instagram_linkedin', 'x'].includes(
        env.PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_NETWORK ?? '',
      )
      || !effects || paused) fail('invalid_configuration');
  return Object.freeze({
    executionMode, providerEffectsEnabled: true, emergencyPaused: false,
    providerId: 'ayrshare',
    network: env.PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_NETWORK as
      OwnedPublicSocialNetwork | 'instagram_linkedin',
    maximumOperationsPerCycle: 1,
    dailyPublishCap: 1, monthlyPublishCap: 3,
  });
}

export interface AyrshareOwnedLiveSecrets {
  readonly apiKey: string;
  readonly xOAuth1ApiKey?: string;
  readonly xOAuth1ApiSecret?: string;
}

export interface AyrshareOwnedPublishRequest {
  readonly workspaceId: string;
  readonly connectionId: string;
  readonly profileId: string;
  readonly profileKey: string;
  readonly operationTag: string;
  readonly idempotencyKey: string;
  readonly text: string;
  readonly scheduledFor: string | null;
  readonly network?: OwnedPublicSocialNetwork;
  readonly mediaUrls?: readonly string[];
}

export interface AyrshareOwnedReconcileRequest {
  readonly workspaceId: string;
  readonly connectionId: string;
  readonly profileId: string;
  readonly profileKey: string;
  readonly externalId: string;
  readonly textSha256: string;
  readonly operationTag: string;
  readonly network?: OwnedPublicSocialNetwork;
}

export type AyrshareOwnedResult = Readonly<{
  state: 'accepted' | 'published' | 'failed' | 'outcome_unknown';
  externalId: string | null;
  receiptSha256: string;
  occurredAt: string;
  safeCode: string;
}>;

export interface AyrshareOwnedLiveTransport {
  readonly contract: typeof OWNED_PUBLIC_SOCIAL_LIVE_CONTRACT;
  readonly providerId: 'ayrshare';
  readonly executionMode: 'owned_profile_live';
  publish(request: AyrshareOwnedPublishRequest): Promise<AyrshareOwnedResult>;
  reconcile(request: AyrshareOwnedReconcileRequest): Promise<AyrshareOwnedResult>;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

async function boundedBody(response: Response): Promise<string> {
  const length = response.headers.get('content-length');
  if (length && (!/^\d+$/u.test(length) || Number(length) > MAX_RESPONSE_BYTES)) {
    fail('provider_response_invalid');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      fail('provider_response_invalid');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

function safeSecrets(input: AyrshareOwnedLiveSecrets): AyrshareOwnedLiveSecrets {
  if (!SAFE_SECRET.test(input.apiKey)
      || ((input.xOAuth1ApiKey === undefined) !== (input.xOAuth1ApiSecret === undefined))
      || (input.xOAuth1ApiKey !== undefined && !SAFE_SECRET.test(input.xOAuth1ApiKey))
      || (input.xOAuth1ApiSecret !== undefined && !SAFE_SECRET.test(input.xOAuth1ApiSecret))) {
    fail('invalid_configuration');
  }
  return Object.freeze({ ...input });
}

function validateCommon(request: AyrshareOwnedPublishRequest | AyrshareOwnedReconcileRequest): void {
  uuid(request.workspaceId); uuid(request.connectionId); uuid(request.profileId);
  if (!SAFE_SECRET.test(request.profileKey)) fail('invalid_request');
}

function safeJson(body: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

function externalId(value: unknown): string | null {
  return typeof value === 'string' && SAFE_EXTERNAL_ID.test(value) ? value : null;
}

function exactPostIds(value: unknown, platform: string): boolean {
  if (!Array.isArray(value) || value.length !== 1) return false;
  const item = value[0];
  if (typeof item !== 'object' || item === null || Array.isArray(item)) return false;
  const post = item as Record<string, unknown>;
  return post.platform === platform
    && post.status === 'success'
    && externalId(post.id) !== null;
}

function exactPlatforms(value: unknown, platform: string): boolean {
  return Array.isArray(value) && value.length === 1 && value[0] === platform;
}

function network(value: unknown): OwnedPublicSocialNetwork {
  if (value !== 'instagram' && value !== 'linkedin' && value !== 'x') fail('invalid_request');
  return value;
}

function mediaUrls(value: readonly string[], selected: OwnedPublicSocialNetwork): readonly string[] {
  if (!Array.isArray(value) || value.length > NETWORK_MEDIA_LIMIT[selected]
      || (selected === 'instagram' && value.length === 0)
      || value.some((url) => typeof url !== 'string' || url.length > 2_048
        || !/^https:\/\/[^\s]+$/u.test(url))) fail('invalid_request');
  return Object.freeze([...value]);
}

export function createAyrshareOwnedLiveTransport(options: Readonly<{
  fetch: FetchLike;
  secrets: AyrshareOwnedLiveSecrets;
  providerEffectsEnabled: true;
  emergencyPaused: false;
  timeoutMs?: number;
  now?: () => Date;
}>): AyrshareOwnedLiveTransport {
  if (typeof options.fetch !== 'function' || options.providerEffectsEnabled !== true
      || options.emergencyPaused !== false) fail('invalid_configuration');
  const secrets = safeSecrets(options.secrets);
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30_000) {
    fail('invalid_configuration');
  }
  const now = options.now ?? (() => new Date());

  const call = async (
    path: '/api/post' | `/api/history/${string}`,
    method: 'GET' | 'POST',
    profileKey: string,
    selectedNetwork: OwnedPublicSocialNetwork,
    body: string | undefined,
  ): Promise<Readonly<{ status: number; body: string; occurredAt: string }>> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const url = `${AYRSHARE_ORIGIN}${path}`;
      const xHeaders = selectedNetwork === 'x'
        ? (() => {
          if (!secrets.xOAuth1ApiKey || !secrets.xOAuth1ApiSecret) fail('invalid_configuration');
          return {
            'X-Twitter-OAuth1-Api-Key': secrets.xOAuth1ApiKey,
            'X-Twitter-OAuth1-Api-Secret': secrets.xOAuth1ApiSecret,
          };
        })()
        : {};
      const response = await options.fetch(url, {
        method,
        redirect: 'error',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${secrets.apiKey}`,
          'Content-Type': 'application/json',
          'Profile-Key': profileKey,
          ...xHeaders,
        },
        ...(body === undefined ? {} : { body }),
      });
      return Object.freeze({
        status: response.status,
        body: await boundedBody(response),
        occurredAt: now().toISOString(),
      });
    } catch (error) {
      if (error instanceof OwnedPublicSocialLiveError) throw error;
      fail('provider_outcome_unknown');
    } finally {
      clearTimeout(timer);
    }
  };

  return Object.freeze({
    contract: OWNED_PUBLIC_SOCIAL_LIVE_CONTRACT,
    providerId: 'ayrshare' as const,
    executionMode: 'owned_profile_live' as const,
    async publish(request: AyrshareOwnedPublishRequest): Promise<AyrshareOwnedResult> {
      validateCommon(request);
      const selectedNetwork = network(request.network ?? 'x');
      const platform = AYRSHARE_PLATFORM[selectedNetwork];
      const selectedMediaUrls = mediaUrls(request.mediaUrls ?? [], selectedNetwork);
      if (!SAFE_OPERATION_TAG.test(request.operationTag)
          || request.idempotencyKey.length < 16 || request.idempotencyKey.length > 200
          || !SAFE_SOCIAL_TEXT.test(request.text)
          || [...request.text].length > NETWORK_TEXT_LIMIT[selectedNetwork]
          || (selectedNetwork === 'x' && LINK_LIKE.test(request.text))) fail('invalid_request');
      if (request.scheduledFor !== null) exactTimestamp(request.scheduledFor);
      const body = JSON.stringify({
        post: request.text,
        platforms: [platform],
        idempotencyKey: request.idempotencyKey,
        notes: request.operationTag,
        shortenLinks: false,
        ...(selectedMediaUrls.length === 0 ? {} : { mediaUrls: selectedMediaUrls }),
        ...(request.scheduledFor === null ? {} : { scheduleDate: request.scheduledFor }),
      });
      const response = await call(
        '/api/post', 'POST', request.profileKey, selectedNetwork, body,
      );
      const payload = safeJson(response.body);
      const id = externalId(payload?.id);
      const receiptSha256 = sha256(response.body);
      if (response.status < 200 || response.status >= 300) {
        const ambiguous = response.status === 408 || response.status === 409
          || response.status === 425 || response.status === 429 || response.status >= 500;
        return Object.freeze({
          state: ambiguous ? 'outcome_unknown' : 'failed', externalId: id,
          receiptSha256, occurredAt: response.occurredAt,
          safeCode: ambiguous ? `ayrshare_http_${response.status}_unknown`
            : `ayrshare_http_${response.status}`,
        });
      }
      if (!payload || id === null
          || (request.scheduledFor === null
            ? (payload.status !== 'success'
              || !exactPostIds(payload.postIds, platform))
            : (payload.status !== 'scheduled'
              || !sameUtcInstant(payload.scheduleDate, request.scheduledFor)))) {
        return Object.freeze({
          state: 'outcome_unknown', externalId: id, receiptSha256,
          occurredAt: response.occurredAt, safeCode: 'ayrshare_acceptance_unproven',
        });
      }
      return Object.freeze({
        state: 'accepted', externalId: id, receiptSha256,
        occurredAt: response.occurredAt, safeCode: 'ayrshare_accepted',
      });
    },
    async reconcile(request: AyrshareOwnedReconcileRequest): Promise<AyrshareOwnedResult> {
      validateCommon(request);
      const selectedNetwork = network(request.network ?? 'x');
      const platform = AYRSHARE_PLATFORM[selectedNetwork];
      if (!SAFE_EXTERNAL_ID.test(request.externalId) || !SHA256.test(request.textSha256)
          || !SAFE_OPERATION_TAG.test(request.operationTag)) {
        fail('invalid_request');
      }
      const response = await call(
        `/api/history/${request.externalId}`, 'GET', request.profileKey,
        selectedNetwork, undefined,
      );
      const payload = safeJson(response.body);
      const id = externalId(payload?.id);
      const receiptSha256 = sha256(response.body);
      if (response.status === 404) return Object.freeze({
        state: 'outcome_unknown', externalId: request.externalId, receiptSha256,
        occurredAt: response.occurredAt, safeCode: 'ayrshare_reconcile_not_found',
      });
      if (response.status < 200 || response.status >= 300 || !payload || id !== request.externalId) {
        return Object.freeze({
          state: response.status >= 400 && response.status < 500 ? 'failed' : 'outcome_unknown',
          externalId: id, receiptSha256, occurredAt: response.occurredAt,
          safeCode: 'ayrshare_reconcile_unproven',
        });
      }
      const text = typeof payload.post === 'string' ? payload.post : '';
      if (sha256(text) !== request.textSha256 || payload.notes !== request.operationTag) return Object.freeze({
        state: 'outcome_unknown', externalId: id, receiptSha256,
        occurredAt: response.occurredAt, safeCode: 'ayrshare_reconcile_content_mismatch',
      });
      if ((payload.status === 'success' || payload.status === 'published')
          && exactPlatforms(payload.platforms, platform)
          && exactPostIds(payload.postIds, platform)) return Object.freeze({
        state: 'published', externalId: id, receiptSha256,
        occurredAt: response.occurredAt, safeCode: 'ayrshare_published',
      });
      if (payload.status === 'error' || payload.status === 'failed') return Object.freeze({
        state: 'failed', externalId: id, receiptSha256,
        occurredAt: response.occurredAt, safeCode: 'ayrshare_failed',
      });
      return Object.freeze({
        state: 'accepted', externalId: id, receiptSha256,
        occurredAt: response.occurredAt, safeCode: 'ayrshare_pending',
      });
    },
  });
}

export interface OwnedPublicSocialClaim {
  readonly workspaceId: string;
  readonly connectionId: string;
  readonly profileId: string;
  readonly jobId: string;
  readonly leaseVersion: number;
  readonly attemptKind: 'publish' | 'reconcile';
}

export interface OwnedPublicSocialJobMaterial extends OwnedPublicSocialClaim {
  readonly network?: OwnedPublicSocialNetwork;
  readonly envelope: OwnedProfileKeyEnvelope;
  readonly operationTag: string;
  readonly idempotencyKey: string;
  readonly text: string;
  readonly textSha256: string;
  readonly scheduledFor: string | null;
  readonly externalId: string | null;
  readonly media?: readonly Readonly<{
    storageKey: string;
    blobSha256: string;
    mimeType: string;
  }>[];
}

export interface OwnedPublicSocialMediaResolver {
  resolve(input: Readonly<{
    workspaceId: string;
    jobId: string;
    scheduledFor: string | null;
    media: NonNullable<OwnedPublicSocialJobMaterial['media']>;
  }>): Promise<readonly string[]>;
}

export interface OwnedPublicSocialLiveRepository {
  claimOne(input: Readonly<{
    leaseToken: Buffer;
    leaseSeconds: number;
    networks: readonly OwnedPublicSocialNetwork[];
  }>): Promise<OwnedPublicSocialClaim | null>;
  loadClaimed(input: OwnedPublicSocialClaim & Readonly<{ leaseToken: Buffer }>): Promise<OwnedPublicSocialJobMaterial>;
  markCalling(input: OwnedPublicSocialClaim & Readonly<{
    leaseToken: Buffer;
    providerEffectsEnabled: true;
    emergencyPaused: false;
  }>): Promise<boolean>;
  settle(input: OwnedPublicSocialClaim & Readonly<{
    leaseToken: Buffer;
    result: AyrshareOwnedResult;
  }>): Promise<void>;
}

export async function runOwnedPublicSocialLiveOnce(input: Readonly<{
  config: OwnedPublicSocialLiveRuntimeConfig;
  repository: OwnedPublicSocialLiveRepository;
  transport: AyrshareOwnedLiveTransport;
  encryptionKey: Buffer;
  encryptionKeyVersion: string;
  leaseToken: Buffer;
  mediaResolver?: OwnedPublicSocialMediaResolver;
}>): Promise<'idle' | 'published_or_pending' | 'failed_or_attention'> {
  if (input.config.executionMode !== 'owned_profile_live'
      || !input.config.providerEffectsEnabled || input.config.emergencyPaused
      || input.transport.executionMode !== 'owned_profile_live'
      || input.encryptionKey.length !== 32 || input.leaseToken.length !== 32) fail('disabled');
  const claimNetworks: readonly OwnedPublicSocialNetwork[] = input.config.network === 'instagram_linkedin'
    ? Object.freeze(['instagram', 'linkedin'])
    : Object.freeze([input.config.network]);
  const claim = await input.repository.claimOne({
    leaseToken: input.leaseToken,
    leaseSeconds: 60,
    networks: claimNetworks,
  });
  if (!claim) return 'idle';
  const material = await input.repository.loadClaimed({ ...claim, leaseToken: input.leaseToken });
  if (material.workspaceId !== claim.workspaceId
      || material.connectionId !== claim.connectionId
      || material.profileId !== claim.profileId
      || material.jobId !== claim.jobId || material.leaseVersion !== claim.leaseVersion
      || material.attemptKind !== claim.attemptKind
      || (input.config.network === 'instagram_linkedin'
        ? ((material.network ?? 'x') !== 'instagram' && (material.network ?? 'x') !== 'linkedin')
        : (material.network ?? 'x') !== input.config.network)) fail('invalid_binding');
  const profileKey = decryptOwnedProfileKey({
    workspaceId: material.workspaceId,
    connectionId: material.connectionId,
    profileId: material.profileId,
    envelope: material.envelope,
    encryptionKey: input.encryptionKey,
    expectedKeyVersion: input.encryptionKeyVersion,
    network: material.network ?? 'x',
  });
  // Finish deterministic local preparation while the job is still only
  // leased. A resolution failure can then be safely returned to the queue by
  // lease recovery because no provider effect could have happened. `calling`
  // is reserved for the genuinely ambiguous provider-call window.
  const resolvedMedia = material.attemptKind === 'publish'
    ? await (input.mediaResolver ?? {
      async resolve() { return Object.freeze([]); },
    }).resolve({
      workspaceId: material.workspaceId,
      jobId: material.jobId,
      scheduledFor: material.scheduledFor,
      media: material.media ?? [],
    })
    : [];
  const calling = await input.repository.markCalling({
    ...claim, leaseToken: input.leaseToken,
    providerEffectsEnabled: true, emergencyPaused: false,
  });
  if (!calling) return 'failed_or_attention';
  let result: AyrshareOwnedResult;
  try {
    result = material.attemptKind === 'publish'
      ? await input.transport.publish({
        workspaceId: material.workspaceId,
        connectionId: material.connectionId,
        profileId: material.profileId,
        profileKey,
        operationTag: material.operationTag,
        idempotencyKey: material.idempotencyKey,
        text: material.text,
        // The database does not release a calendar job until its exact
        // available_at instant. Once claimed, the calendar is the clock and
        // Ayrshare should publish immediately instead of being asked to
        // schedule for an instant that has already arrived.
        scheduledFor: (material.network === 'instagram' || material.network === 'linkedin')
          ? null
          : material.scheduledFor,
        network: material.network ?? 'x',
        mediaUrls: resolvedMedia,
      })
      : await input.transport.reconcile({
        workspaceId: material.workspaceId,
        connectionId: material.connectionId,
        profileId: material.profileId,
        profileKey,
        externalId: material.externalId ?? '',
        textSha256: material.textSha256,
        operationTag: material.operationTag,
        network: material.network ?? 'x',
      });
  } catch {
    result = Object.freeze({
      state: 'outcome_unknown', externalId: material.externalId,
      receiptSha256: sha256('transport_exception'), occurredAt: new Date().toISOString(),
      safeCode: 'ayrshare_transport_outcome_unknown',
    });
  }
  await input.repository.settle({ ...claim, leaseToken: input.leaseToken, result });
  return result.state === 'accepted' || result.state === 'published'
    ? 'published_or_pending' : 'failed_or_attention';
}
