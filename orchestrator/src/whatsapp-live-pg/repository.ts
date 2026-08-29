import type { Pool, QueryResultRow } from 'pg';
import type {
  MetaWhatsAppCredentialEnvelope,
  MetaWhatsAppDispatchResult,
  MetaWhatsAppLiveClaim,
  MetaWhatsAppLiveMaterial,
  MetaWhatsAppLiveRepository,
} from '../whatsapp-live/foundation.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const META_ID = /^[1-9][0-9]{4,29}$/u;
const E164 = /^[1-9][0-9]{6,14}$/u;
const TEMPLATE = /^[a-z][a-z0-9_]{0,511}$/u;
const LANGUAGE = /^[a-z]{2,3}(?:_[A-Z]{2})?$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MESSAGE_ID = /^wamid\.[A-Za-z0-9_=-]{1,190}$/u;
const SAFE_CODE = /^[a-z][a-z0-9_.:-]{0,99}$/u;

type Executor = Pick<Pool, 'query'>;

interface ClaimRow extends QueryResultRow {
  jobId: unknown;
  bindingId: unknown;
  leaseVersion: unknown;
}

interface MaterialRow extends QueryResultRow {
  providerConnectionId: unknown;
  bindingId: unknown;
  appId: unknown;
  wabaId: unknown;
  phoneNumberId: unknown;
  graphApiVersion: unknown;
  secretKeyVersion: unknown;
  secretIv: unknown;
  secretCiphertext: unknown;
  secretAuthTag: unknown;
  secretAadSha256: unknown;
  secretPayloadSha256: unknown;
  recipient: unknown;
  templateName: unknown;
  languageCode: unknown;
  operationId: unknown;
  requestSha256: unknown;
}

function fail(label: string): never {
  throw new Error(`Meta WhatsApp live repository returned invalid ${label}`);
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) fail(label);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = typeof value === 'string' && /^[1-9][0-9]*$/u.test(value)
    ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || (parsed as number) < 1) fail(label);
  return parsed as number;
}

function bytes(value: unknown, length: number | null, label: string): Buffer {
  if (!Buffer.isBuffer(value)) fail(label);
  const result = Buffer.from(value);
  if (length !== null && result.length !== length) fail(label);
  return result;
}

function exactText(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) fail(label);
  return value;
}

function timestamp(value: unknown, label: string): string {
  const normalized = value instanceof Date ? value.toISOString() : value;
  if (typeof normalized !== 'string' || !Number.isFinite(Date.parse(normalized))) fail(label);
  return new Date(normalized).toISOString();
}

function envelope(row: MaterialRow): MetaWhatsAppCredentialEnvelope {
  const keyVersion = exactText(
    row.secretKeyVersion, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u, 'key version',
  );
  const ciphertext = bytes(row.secretCiphertext, null, 'secret ciphertext');
  if (ciphertext.length < 64 || ciphertext.length > 8_192) fail('secret ciphertext');
  return Object.freeze({
    algorithm: 'aes-256-gcm-v1',
    keyVersion,
    ivBase64: bytes(row.secretIv, 12, 'secret IV').toString('base64'),
    ciphertextBase64: ciphertext.toString('base64'),
    authTagBase64: bytes(row.secretAuthTag, 16, 'secret auth tag').toString('base64'),
    aadSha256: bytes(row.secretAadSha256, 32, 'secret AAD').toString('hex'),
    secretPayloadSha256: bytes(row.secretPayloadSha256, 32, 'secret payload digest').toString('hex'),
  });
}

export class PgMetaWhatsAppLiveRepository implements MetaWhatsAppLiveRepository {
  readonly #workspaceId: string;
  readonly #connectionId: string;

  constructor(
    private readonly executor: Executor,
    binding: Readonly<{ workspaceId: string; connectionId: string }>,
  ) {
    this.#workspaceId = uuid(binding.workspaceId, 'workspace binding');
    this.#connectionId = uuid(binding.connectionId, 'connection binding');
  }

  async claimOne(input: Readonly<{
    leaseToken: Buffer;
    leaseSeconds: number;
  }>): Promise<MetaWhatsAppLiveClaim | null> {
    if (input.leaseToken.length !== 32 || !Number.isSafeInteger(input.leaseSeconds)
        || input.leaseSeconds < 30 || input.leaseSeconds > 300) fail('claim input');
    const result = await this.executor.query<ClaimRow>(
      `/* meta-whatsapp-live.claim-one */
       SELECT job_id AS "jobId", binding_id AS "bindingId",
              lease_version AS "leaseVersion"
       FROM app_private.claim_whatsapp_live_job($1::uuid, $2::uuid, $3::bytea, $4::integer)`,
      [this.#workspaceId, this.#connectionId, input.leaseToken, input.leaseSeconds],
    );
    if (result.rows.length === 0) return null;
    if (result.rows.length !== 1 || !result.rows[0]) fail('claim cardinality');
    return Object.freeze({
      workspaceId: this.#workspaceId,
      connectionId: this.#connectionId,
      bindingId: uuid(result.rows[0].bindingId, 'claim binding id'),
      jobId: uuid(result.rows[0].jobId, 'claim job id'),
      leaseVersion: positiveInteger(result.rows[0].leaseVersion, 'claim lease version'),
    });
  }

  async loadClaimed(
    input: MetaWhatsAppLiveClaim & Readonly<{ leaseToken: Buffer }>,
  ): Promise<MetaWhatsAppLiveMaterial> {
    this.#assertClaim(input);
    if (input.leaseToken.length !== 32) fail('load token');
    const result = await this.executor.query<MaterialRow>(
      `/* meta-whatsapp-live.load-claimed */
       SELECT provider_connection_id AS "providerConnectionId", binding_id AS "bindingId",
              app_id AS "appId", waba_id AS "wabaId", phone_number_id AS "phoneNumberId",
              graph_api_version AS "graphApiVersion", secret_key_version AS "secretKeyVersion",
              secret_iv AS "secretIv", secret_ciphertext AS "secretCiphertext",
              secret_auth_tag AS "secretAuthTag", secret_aad_sha256 AS "secretAadSha256",
              secret_payload_sha256 AS "secretPayloadSha256", recipient,
              template_name AS "templateName", language_code AS "languageCode",
              operation_id AS "operationId", encode(request_sha256, 'hex') AS "requestSha256"
       FROM app_private.load_whatsapp_live_job($1::uuid, $2::uuid, $3::bigint, $4::bytea)`,
      [input.workspaceId, input.jobId, input.leaseVersion, input.leaseToken],
    );
    if (result.rows.length !== 1 || !result.rows[0]) fail('material cardinality');
    const row = result.rows[0];
    const connectionId = uuid(row.providerConnectionId, 'material connection');
    const bindingId = uuid(row.bindingId, 'material binding id');
    if (connectionId !== input.connectionId || bindingId !== input.bindingId
        || row.graphApiVersion !== 'v24.0') fail('material binding');
    return Object.freeze({
      ...input,
      connectionId,
      bindingId,
      binding: Object.freeze({
        workspaceId: input.workspaceId,
        connectionId,
        appId: exactText(row.appId, META_ID, 'app id'),
        wabaId: exactText(row.wabaId, META_ID, 'WABA id'),
        phoneNumberId: exactText(row.phoneNumberId, META_ID, 'phone-number id'),
        graphApiVersion: 'v24.0',
      }),
      envelope: envelope(row),
      recipient: exactText(row.recipient, E164, 'recipient'),
      templateName: exactText(row.templateName, TEMPLATE, 'template name'),
      languageCode: exactText(row.languageCode, LANGUAGE, 'language code'),
      operationId: uuid(row.operationId, 'operation id'),
      requestSha256: exactText(row.requestSha256, SHA256, 'request digest'),
    });
  }

  async markCalling(input: MetaWhatsAppLiveClaim & Readonly<{
    leaseToken: Buffer;
    providerEffectsEnabled: true;
    emergencyPaused: false;
  }>): Promise<boolean> {
    this.#assertClaim(input);
    if (input.leaseToken.length !== 32 || input.providerEffectsEnabled !== true
        || input.emergencyPaused !== false) fail('begin-call input');
    const result = await this.executor.query<{ marked: unknown } & QueryResultRow>(
      `/* meta-whatsapp-live.begin-call */
       SELECT app_private.begin_whatsapp_live_call(
         $1::uuid, $2::uuid, $3::bigint, $4::bytea, $5::boolean, $6::boolean
       ) AS marked`,
      [input.workspaceId, input.jobId, input.leaseVersion, input.leaseToken, true, false],
    );
    return result.rows.length === 1 && result.rows[0]?.marked === true;
  }

  async settle(input: MetaWhatsAppLiveClaim & Readonly<{
    leaseToken: Buffer;
    result: MetaWhatsAppDispatchResult;
  }>): Promise<void> {
    this.#assertClaim(input);
    const result = input.result;
    if (input.leaseToken.length !== 32 || !SHA256.test(result.receiptSha256)
        || !SAFE_CODE.test(result.safeCode)
        || !['accepted', 'failed', 'outcome_unknown'].includes(result.state)
        || (result.providerMessageId !== null && !MESSAGE_ID.test(result.providerMessageId))
        || (result.state === 'accepted' && result.providerMessageId === null)) {
      fail('settlement input');
    }
    await this.executor.query(
      `/* meta-whatsapp-live.settle */
       SELECT app_private.settle_whatsapp_live_call(
         $1::uuid, $2::uuid, $3::bigint, $4::bytea, $5::text,
         $6::text, decode($7, 'hex'), $8::text, $9::timestamptz
       )`,
      [input.workspaceId, input.jobId, input.leaseVersion, input.leaseToken,
        result.state, result.providerMessageId, result.receiptSha256, result.safeCode,
        timestamp(result.occurredAt, 'provider occurrence')],
    );
  }

  #assertClaim(input: MetaWhatsAppLiveClaim): void {
    if (uuid(input.workspaceId, 'claim workspace') !== this.#workspaceId
        || uuid(input.connectionId, 'claim connection') !== this.#connectionId
        || !UUID.test(input.bindingId) || !UUID.test(input.jobId)
        || !Number.isSafeInteger(input.leaseVersion) || input.leaseVersion < 1) {
      fail('claim binding');
    }
  }
}
