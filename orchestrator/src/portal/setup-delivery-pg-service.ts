import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const ERROR_CODE_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,99}$/;
const AAD_PREFIX = Buffer.from('r72/setup-link/v1', 'utf8');

export interface SetupDeliveryPayload {
  version: 1;
  recipientEmail: string;
  setupUrl: string;
}

export interface EncryptedSetupDelivery {
  deliveryId: string;
  setupTokenHash: Buffer;
  recipientEmailHash: Buffer;
  payloadVersion: 1;
  encryptionKeyId: string;
  encryptionIv: Buffer;
  encryptedPayload: Buffer;
  authenticationTag: Buffer;
}

export interface SetupDeliveryKeyringOptions {
  activeKeyId: string;
  keys: Readonly<Record<string, Uint8Array>>;
}

export class MissingSetupDeliveryKeyError extends Error {
  readonly keyId: string;

  constructor(keyId: string) {
    super(`Account setup delivery key is unavailable: ${keyId}`);
    this.name = 'MissingSetupDeliveryKeyError';
    this.keyId = keyId;
  }
}

export function setupDeliveryAad(deliveryId: string): Buffer {
  const canonical = canonicalUuid(deliveryId);
  if (!canonical) throw new Error('deliveryId must be a canonical UUID');
  return Buffer.concat([AAD_PREFIX, Buffer.from([0]), Buffer.from(canonical, 'ascii')]);
}

function canonicalUuid(value: unknown): string | null {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value.toLowerCase() : null;
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function exactBuffer(value: unknown, length: number, label: string): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength !== length) {
    throw new Error(`${label} must contain exactly ${length} bytes`);
  }
  return Buffer.from(value);
}

function boundedBuffer(value: unknown, minimum: number, maximum: number, label: string): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength < minimum || value.byteLength > maximum) {
    throw new Error(`${label} must contain ${minimum} to ${maximum} bytes`);
  }
  return Buffer.from(value);
}

function canonicalEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (email.length > 320 || !EMAIL_PATTERN.test(email)) {
    throw new Error('recipientEmail must be a valid email address');
  }
  return email;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function canonicalIsoDate(value: unknown, label: string): string {
  const raw = value instanceof Date ? value.toISOString() : value;
  const timestamp = typeof raw === 'string' ? Date.parse(raw) : Number.NaN;
  if (!Number.isFinite(timestamp)) throw new Error(`${label} must be a valid timestamp`);
  return new Date(timestamp).toISOString();
}

function parsePayload(value: Buffer): SetupDeliveryPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.toString('utf8'));
  } catch {
    throw new Error('Encrypted account setup delivery payload is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Encrypted account setup delivery payload has an invalid shape');
  }
  const candidate = parsed as Record<string, unknown>;
  if (candidate.version !== 1
      || typeof candidate.recipientEmail !== 'string'
      || typeof candidate.setupUrl !== 'string'
      || Object.keys(candidate).sort().join(',') !== 'recipientEmail,setupUrl,version') {
    throw new Error('Encrypted account setup delivery payload has an invalid shape');
  }
  const recipientEmail = canonicalEmail(candidate.recipientEmail);
  let setupUrl: URL;
  try {
    setupUrl = new URL(candidate.setupUrl);
  } catch {
    throw new Error('Encrypted account setup delivery URL is invalid');
  }
  const queryKeys = [...setupUrl.searchParams.keys()];
  if ((setupUrl.protocol !== 'https:'
        && !(isLoopbackHostname(setupUrl.hostname) && setupUrl.protocol === 'http:'))
      || setupUrl.username
      || setupUrl.password
      || setupUrl.pathname !== '/portal/setup'
      || setupUrl.hash
      || queryKeys.length !== 1
      || queryKeys[0] !== 'token'
      || !TOKEN_PATTERN.test(setupUrl.searchParams.get('token') ?? '')) {
    throw new Error('Encrypted account setup delivery URL is invalid');
  }
  return Object.freeze({ version: 1, recipientEmail, setupUrl: setupUrl.toString() });
}

export class SetupDeliveryKeyring {
  readonly activeKeyId: string;
  private readonly keys = new Map<string, Buffer>();

  constructor(options: SetupDeliveryKeyringOptions) {
    if (!KEY_ID_PATTERN.test(options.activeKeyId)) {
      throw new Error('active setup delivery key id is invalid');
    }
    for (const [keyId, keyBytes] of Object.entries(options.keys)) {
      if (!KEY_ID_PATTERN.test(keyId)) throw new Error(`setup delivery key id is invalid: ${keyId}`);
      this.keys.set(keyId, exactBuffer(keyBytes, 32, `setup delivery key ${keyId}`));
    }
    if (!this.keys.has(options.activeKeyId)) {
      throw new MissingSetupDeliveryKeyError(options.activeKeyId);
    }
    this.activeKeyId = options.activeKeyId;
  }

  has(keyId: string): boolean {
    return this.keys.has(keyId);
  }

  assertAvailable(keyIds: Iterable<string>): void {
    for (const keyId of keyIds) {
      if (!this.keys.has(keyId)) throw new MissingSetupDeliveryKeyError(keyId);
    }
  }

  seal(deliveryId: string, payload: SetupDeliveryPayload, iv: Uint8Array = randomBytes(12)): {
    encryptionKeyId: string;
    encryptionIv: Buffer;
    encryptedPayload: Buffer;
    authenticationTag: Buffer;
  } {
    const encryptionIv = exactBuffer(iv, 12, 'setup delivery IV');
    const key = this.keys.get(this.activeKeyId);
    if (!key) throw new MissingSetupDeliveryKeyError(this.activeKeyId);
    const cipher = createCipheriv('aes-256-gcm', key, encryptionIv, { authTagLength: 16 });
    cipher.setAAD(setupDeliveryAad(deliveryId));
    const encryptedPayload = Buffer.concat([
      cipher.update(JSON.stringify(payload), 'utf8'),
      cipher.final(),
    ]);
    return Object.freeze({
      encryptionKeyId: this.activeKeyId,
      encryptionIv,
      encryptedPayload,
      authenticationTag: cipher.getAuthTag(),
    });
  }

  open(input: {
    deliveryId: string;
    payloadVersion: number;
    encryptionKeyId: string;
    encryptionIv: unknown;
    encryptedPayload: unknown;
    authenticationTag: unknown;
    aadContext: unknown;
  }): SetupDeliveryPayload {
    const deliveryId = canonicalUuid(input.deliveryId);
    if (!deliveryId || input.payloadVersion !== 1 || !KEY_ID_PATTERN.test(input.encryptionKeyId)) {
      throw new Error('Claimed account setup delivery metadata is invalid');
    }
    const expectedAad = setupDeliveryAad(deliveryId);
    const actualAad = exactBuffer(input.aadContext, expectedAad.length, 'setup delivery AAD');
    if (!timingSafeEqual(expectedAad, actualAad)) {
      throw new Error('Claimed account setup delivery AAD does not match its delivery id');
    }
    const key = this.keys.get(input.encryptionKeyId);
    if (!key) throw new MissingSetupDeliveryKeyError(input.encryptionKeyId);
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      exactBuffer(input.encryptionIv, 12, 'setup delivery IV'),
      { authTagLength: 16 },
    );
    decipher.setAAD(expectedAad);
    decipher.setAuthTag(exactBuffer(input.authenticationTag, 16, 'setup delivery authentication tag'));
    let plaintext: Buffer;
    try {
      plaintext = Buffer.concat([
        decipher.update(boundedBuffer(input.encryptedPayload, 1, 16_384, 'encrypted setup delivery')),
        decipher.final(),
      ]);
    } catch {
      throw new Error('Encrypted account setup delivery authentication failed');
    }
    return parsePayload(plaintext);
  }
}

interface ClaimRow extends QueryResultRow {
  delivery_id: string;
  user_id: string;
  workspace_id: string;
  action_token_id: string;
  payload_version: number;
  encryption_key_id: string;
  encryption_iv: Buffer;
  encrypted_payload: Buffer;
  authentication_tag: Buffer;
  recipient_email_hash: Buffer;
  aad_context: Buffer;
  attempt_count: number;
  lease_expires_at: string | Date;
}

interface ReissueRow extends QueryResultRow {
  setup_action_token_id: string;
  setup_expires_at: string | Date;
  setup_delivery_id: string;
  setup_delivery_generation: number;
  created_now: boolean;
}

interface FailureRow extends QueryResultRow {
  delivery_state: string;
  available_at: string | Date;
}

export interface PgSetupDeliveryDependencies {
  deliveryCommandPool: Pick<Pool, 'query'>;
  reissueCommandPool?: Pick<Pool, 'query'>;
  keyring: SetupDeliveryKeyring;
  setupUrl: string;
  createSetupToken?: () => string;
  createDeliveryId?: () => string;
  createLeaseToken?: () => string;
  createIv?: () => Uint8Array;
}

export interface ClaimedSetupDelivery {
  deliveryId: string;
  userId: string;
  workspaceId: string;
  actionTokenId: string;
  providerIdempotencyKey: string;
  recipientEmail: string;
  setupUrl: string;
  attemptCount: number;
  leaseExpiresAt: string;
  /** Opaque lease credential. Pass it only to renew/ack/fail methods. */
  leaseToken: string;
}

export interface ReissueSetupDeliveryInput {
  idempotencyKey: string;
  workspaceId: string;
  userId: string;
  operatorRequest: string;
  recipientEmail: string;
}

export interface ReissueSetupDeliveryResult {
  setupActionTokenId: string;
  setupExpiresAt: string;
  setupDeliveryId: string;
  setupDeliveryGeneration: number;
  createdNow: boolean;
}

function validateSetupUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('setupUrl must be an absolute HTTP(S) URL');
  }
  const loopback = isLoopbackHostname(url.hostname);
  if ((url.protocol !== 'https:' && !(loopback && url.protocol === 'http:'))
      || url.username
      || url.password
      || url.pathname !== '/portal/setup'
      || url.search
      || url.hash) {
    throw new Error('setupUrl must be HTTPS (except loopback development), use exact /portal/setup, and have no query, credentials or fragment');
  }
  return url;
}

function generatedToken(factory: (() => string) | undefined, label: string): string {
  const token = (factory ?? (() => randomBytes(32).toString('base64url')))();
  if (!TOKEN_PATTERN.test(token)) {
    throw new Error(`${label} generator must return exactly 256 bits encoded as base64url`);
  }
  return token;
}

function generatedUuid(factory: (() => string) | undefined): string {
  const id = canonicalUuid((factory ?? randomUUID)());
  if (!id) throw new Error('setup delivery id generator must return a UUID');
  return id;
}

export class PgSetupDeliveryService {
  private readonly setupUrl: URL;

  constructor(private readonly dependencies: PgSetupDeliveryDependencies) {
    this.setupUrl = validateSetupUrl(dependencies.setupUrl);
  }

  prepare(recipientEmailInput: string): EncryptedSetupDelivery {
    const recipientEmail = canonicalEmail(recipientEmailInput);
    const deliveryId = generatedUuid(this.dependencies.createDeliveryId);
    const setupToken = generatedToken(this.dependencies.createSetupToken, 'setup token');
    const setupUrl = new URL(this.setupUrl);
    setupUrl.searchParams.set('token', setupToken);
    const protectedPayload = this.dependencies.keyring.seal(
      deliveryId,
      { version: 1, recipientEmail, setupUrl: setupUrl.toString() },
      this.dependencies.createIv?.(),
    );
    return Object.freeze({
      deliveryId,
      setupTokenHash: sha256(setupToken),
      recipientEmailHash: sha256(recipientEmail),
      payloadVersion: 1,
      ...protectedPayload,
    });
  }

  async assertReadyForPendingDeliveries(): Promise<void> {
    const result = await this.dependencies.deliveryCommandPool.query<{ encryption_key_id: string }>(
      `/* portal.setup-delivery.required-keys */
       SELECT encryption_key_id
       FROM app_private.required_account_setup_delivery_key_ids()`,
    );
    this.dependencies.keyring.assertAvailable(result.rows.map((row) => row.encryption_key_id));
  }

  async claim(batchSize = 1, leaseSeconds = 60): Promise<ClaimedSetupDelivery[]> {
    // Decrypt one job per claim. This keeps an unavailable rotation key or a
    // corrupt authenticated payload from hiding otherwise valid leased work.
    // The SQL primitive remains bounded/batch-capable for a future worker that
    // implements explicit per-row settlement.
    if (batchSize !== 1) {
      throw new Error('batchSize must be exactly 1 until per-row delivery settlement is configured');
    }
    if (!Number.isInteger(leaseSeconds) || leaseSeconds < 15 || leaseSeconds > 300) {
      throw new Error('leaseSeconds must be an integer from 15 to 300');
    }
    const leaseToken = generatedToken(this.dependencies.createLeaseToken, 'delivery lease token');
    const result = await this.dependencies.deliveryCommandPool.query<ClaimRow>(
      `/* portal.setup-delivery.claim */
       SELECT delivery_id, user_id, workspace_id, action_token_id,
               payload_version, encryption_key_id, encryption_iv,
               encrypted_payload, authentication_tag, recipient_email_hash,
               aad_context,
              attempt_count, lease_expires_at
       FROM app_private.claim_account_setup_deliveries($1, $2, $3)`,
      [sha256(leaseToken), batchSize, leaseSeconds],
    );
    try {
      return result.rows.map((row) => {
        const deliveryId = canonicalUuid(row.delivery_id);
        const userId = canonicalUuid(row.user_id);
        const workspaceId = canonicalUuid(row.workspace_id);
        const actionTokenId = canonicalUuid(row.action_token_id);
        if (!deliveryId || !userId || !workspaceId || !actionTokenId
            || !Number.isInteger(row.attempt_count) || row.attempt_count < 1 || row.attempt_count > 8) {
          throw new Error('Claimed account setup delivery returned invalid canonical data');
        }
        const payload = this.dependencies.keyring.open({
          deliveryId,
          payloadVersion: row.payload_version,
          encryptionKeyId: row.encryption_key_id,
          encryptionIv: row.encryption_iv,
          encryptedPayload: row.encrypted_payload,
          authenticationTag: row.authentication_tag,
          aadContext: row.aad_context,
        });
        const authoritativeRecipientHash = exactBuffer(
          row.recipient_email_hash,
          32,
          'setup delivery recipient email hash',
        );
        if (!timingSafeEqual(authoritativeRecipientHash, sha256(payload.recipientEmail))) {
          throw new Error('Encrypted account setup delivery recipient does not match database authority');
        }
        const decryptedSetupUrl = new URL(payload.setupUrl);
        if (decryptedSetupUrl.origin !== this.setupUrl.origin
            || decryptedSetupUrl.pathname !== this.setupUrl.pathname) {
          throw new Error('Encrypted account setup delivery URL does not match the configured portal');
        }
        return Object.freeze({
          deliveryId,
          userId,
          workspaceId,
          actionTokenId,
          providerIdempotencyKey: deliveryId,
          recipientEmail: payload.recipientEmail,
          setupUrl: payload.setupUrl,
          attemptCount: row.attempt_count,
          leaseExpiresAt: canonicalIsoDate(row.lease_expires_at, 'lease expiry'),
          leaseToken,
        });
      });
    } catch (error) {
      // A missing rotation key is a readiness/alert condition: do not mutate
      // or dead-letter those jobs. Their bounded lease expires for a corrected
      // worker. Authenticated-payload corruption is different; no job is
      // returned to a provider, and every row in this claimed batch is moved
      // back to bounded retry immediately rather than stranded until timeout.
      if (error instanceof MissingSetupDeliveryKeyError) throw error;
      const retryAt = new Date(Date.now() + 60_000);
      const releases = await Promise.allSettled(result.rows.map(async (row) => {
        const deliveryId = canonicalUuid(row.delivery_id);
        if (!deliveryId) return null;
        return this.fail(deliveryId, leaseToken, 'payload_batch_rejected', retryAt);
      }));
      const releaseErrors = releases
        .filter((release): release is PromiseRejectedResult => release.status === 'rejected')
        .map((release) => release.reason);
      if (releaseErrors.length > 0) {
        throw new AggregateError([error, ...releaseErrors], 'Setup delivery payload rejection and retry release both failed');
      }
      throw error;
    }
  }

  async renew(deliveryIdInput: string, leaseToken: string, leaseSeconds = 60): Promise<string | null> {
    const deliveryId = canonicalUuid(deliveryIdInput);
    if (!deliveryId || !TOKEN_PATTERN.test(leaseToken)
        || !Number.isInteger(leaseSeconds) || leaseSeconds < 15 || leaseSeconds > 300) {
      throw new Error('invalid setup delivery lease renewal input');
    }
    const result = await this.dependencies.deliveryCommandPool.query<{ lease_expires_at: string | Date }>(
      `/* portal.setup-delivery.renew */
       SELECT lease_expires_at
       FROM app_private.renew_account_setup_delivery_lease($1, $2, $3)`,
      [deliveryId, sha256(leaseToken), leaseSeconds],
    );
    if (result.rows.length === 0) return null;
    if (result.rows.length !== 1) throw new Error('Setup delivery renewal returned multiple rows');
    return canonicalIsoDate(result.rows[0]!.lease_expires_at, 'lease expiry');
  }

  async acknowledge(deliveryIdInput: string, leaseToken: string): Promise<boolean> {
    const deliveryId = canonicalUuid(deliveryIdInput);
    if (!deliveryId || !TOKEN_PATTERN.test(leaseToken)) {
      throw new Error('invalid setup delivery acknowledgement input');
    }
    const result = await this.dependencies.deliveryCommandPool.query<{ acknowledged: boolean }>(
      `/* portal.setup-delivery.acknowledge */
       SELECT app_private.acknowledge_account_setup_delivery($1, $2) AS acknowledged`,
      [deliveryId, sha256(leaseToken)],
    );
    return result.rows.length === 1 && result.rows[0]!.acknowledged === true;
  }

  async fail(
    deliveryIdInput: string,
    leaseToken: string,
    errorCode: string,
    retryAtInput: string | Date,
  ): Promise<{ state: string; availableAt: string } | null> {
    const deliveryId = canonicalUuid(deliveryIdInput);
    if (!deliveryId || !TOKEN_PATTERN.test(leaseToken)
        || errorCode !== errorCode.trim() || !ERROR_CODE_PATTERN.test(errorCode)) {
      throw new Error('invalid setup delivery failure input');
    }
    const retryAt = canonicalIsoDate(retryAtInput, 'retryAt');
    const result = await this.dependencies.deliveryCommandPool.query<FailureRow>(
      `/* portal.setup-delivery.fail */
       SELECT delivery_state, available_at
       FROM app_private.fail_account_setup_delivery($1, $2, $3, $4)`,
      [deliveryId, sha256(leaseToken), errorCode, retryAt],
    );
    if (result.rows.length === 0) return null;
    if (result.rows.length !== 1) throw new Error('Setup delivery failure returned multiple rows');
    const row = result.rows[0]!;
    if (!['retry', 'dead_letter'].includes(row.delivery_state)) {
      throw new Error('Setup delivery failure returned an invalid state');
    }
    return Object.freeze({
      state: row.delivery_state,
      availableAt: canonicalIsoDate(row.available_at, 'delivery availability'),
    });
  }

  async reissue(input: ReissueSetupDeliveryInput): Promise<ReissueSetupDeliveryResult> {
    const reissueCommandPool = this.dependencies.reissueCommandPool;
    if (!reissueCommandPool) throw new Error('Setup delivery reissue command pool is not configured');
    if (!input.idempotencyKey || input.idempotencyKey !== input.idempotencyKey.trim()
        || input.idempotencyKey.length > 128) {
      throw new Error('idempotencyKey must be a trimmed value of 1 to 128 characters');
    }
    const workspaceId = canonicalUuid(input.workspaceId);
    const userId = canonicalUuid(input.userId);
    if (!workspaceId || !userId) throw new Error('workspaceId and userId must be UUIDs');
    if (!input.operatorRequest || input.operatorRequest !== input.operatorRequest.trim()
        || input.operatorRequest.length > 200) {
      throw new Error('operatorRequest must be a trimmed value of 1 to 200 characters');
    }
    const encrypted = this.prepare(input.recipientEmail);
    const result = await reissueCommandPool.query<ReissueRow>(
      `/* portal.setup-delivery.reissue */
       SELECT setup_action_token_id, setup_expires_at, setup_delivery_id,
              setup_delivery_generation, created_now
       FROM app_private.reissue_native_account_setup(
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
       )`,
      [
        input.idempotencyKey,
        workspaceId,
        userId,
        input.operatorRequest,
        encrypted.setupTokenHash,
        encrypted.recipientEmailHash,
        encrypted.deliveryId,
        encrypted.payloadVersion,
        encrypted.encryptionKeyId,
        encrypted.encryptionIv,
        encrypted.encryptedPayload,
        encrypted.authenticationTag,
      ],
    );
    if (result.rows.length !== 1) throw new Error('Setup delivery reissue did not return exactly one result');
    const row = result.rows[0]!;
    const setupActionTokenId = canonicalUuid(row.setup_action_token_id);
    const setupDeliveryId = canonicalUuid(row.setup_delivery_id);
    if (!setupActionTokenId || !setupDeliveryId
        || !Number.isInteger(row.setup_delivery_generation)
        || row.setup_delivery_generation < 1
        || typeof row.created_now !== 'boolean') {
      throw new Error('Setup delivery reissue returned invalid canonical data');
    }
    return Object.freeze({
      setupActionTokenId,
      setupExpiresAt: canonicalIsoDate(row.setup_expires_at, 'setup expiry'),
      setupDeliveryId,
      setupDeliveryGeneration: row.setup_delivery_generation,
      createdNow: row.created_now,
    });
  }
}
