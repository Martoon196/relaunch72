import type { Pool, QueryResultRow } from 'pg';
import { withTransaction } from '../db/transaction.js';
import type {
  EnqueueMetaWhatsAppLiveTemplateCommand,
  MetaWhatsAppLiveCommandService,
  MetaWhatsAppLiveUserContext,
  RecordMetaWhatsAppLiveBindingCommand,
  RecordMetaWhatsAppLiveTemplateCommand,
} from '../whatsapp-live/index.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const META_ID = /^[1-9][0-9]{4,29}$/u;
const TEMPLATE = /^[a-z][a-z0-9_]{0,511}$/u;
const LANGUAGE = /^[a-z]{2,3}(?:_[A-Z]{2})?$/u;
const PURPOSE = /^[a-z][a-z0-9_.-]{0,99}$/u;
const KEY_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

interface IdRow extends QueryResultRow { id: unknown }

function uuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new Error(`Meta WhatsApp live ${label} is invalid`);
  }
  return value;
}

function digest(value: unknown, label: string): Buffer {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new Error(`Meta WhatsApp live ${label} is invalid`);
  }
  return Buffer.from(value, 'hex');
}

function exactBase64(value: unknown, length: number | null, label: string): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    throw new Error(`Meta WhatsApp live ${label} is invalid`);
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value || (length !== null && decoded.length !== length)) {
    throw new Error(`Meta WhatsApp live ${label} is invalid`);
  }
  return decoded;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))
      || new Date(value).toISOString() !== value) {
    throw new Error(`Meta WhatsApp live ${label} is invalid`);
  }
  return value;
}

function resultId(result: { rows: IdRow[] }, label: string): string {
  if (result.rows.length !== 1) throw new Error(`Meta WhatsApp live ${label} is invalid`);
  return uuid(result.rows[0]?.id, label);
}

export interface PgMetaWhatsAppLiveCommandServiceDependencies {
  readonly commandPool: Pick<Pool, 'connect'>;
  readonly workspaceId: string;
}

export class PgMetaWhatsAppLiveCommandService implements MetaWhatsAppLiveCommandService {
  readonly workspaceId: string;
  readonly #commandPool: Pick<Pool, 'connect'>;

  constructor(dependencies: PgMetaWhatsAppLiveCommandServiceDependencies) {
    this.workspaceId = uuid(dependencies.workspaceId, 'workspace binding');
    this.#commandPool = dependencies.commandPool;
  }

  async recordBinding(
    context: MetaWhatsAppLiveUserContext,
    command: RecordMetaWhatsAppLiveBindingCommand,
  ): Promise<string> {
    this.#assertContext(context);
    const binding = command.binding;
    if (binding.workspaceId !== this.workspaceId || binding.graphApiVersion !== 'v24.0'
        || !META_ID.test(binding.appId) || !META_ID.test(binding.wabaId)
        || !META_ID.test(binding.phoneNumberId)
        || command.envelope.algorithm !== 'aes-256-gcm-v1'
        || !KEY_VERSION.test(command.envelope.keyVersion)) {
      throw new Error('Meta WhatsApp live binding command is invalid');
    }
    const ciphertext = exactBase64(
      command.envelope.ciphertextBase64, null, 'credential ciphertext',
    );
    if (ciphertext.length < 64 || ciphertext.length > 8_192) {
      throw new Error('Meta WhatsApp live credential ciphertext is invalid');
    }
    const values = [
      this.workspaceId,
      uuid(binding.connectionId, 'provider connection'),
      uuid(binding.bindingId, 'binding id'),
      binding.appId, binding.wabaId, binding.phoneNumberId,
      digest(command.ownedPhoneSha256, 'owned phone digest'),
      command.envelope.keyVersion,
      exactBase64(command.envelope.ivBase64, 12, 'credential IV'),
      ciphertext,
      exactBase64(command.envelope.authTagBase64, 16, 'credential auth tag'),
      digest(command.envelope.aadSha256, 'credential AAD digest'),
      digest(command.envelope.secretPayloadSha256, 'credential payload digest'),
      digest(command.ownershipEvidenceSha256, 'ownership evidence digest'),
      timestamp(command.ownershipObservedAt, 'ownership observation'),
      command.predecessorBindingId === null
        ? null : uuid(command.predecessorBindingId, 'predecessor binding'),
    ];
    return this.#executeId(context,
      `/* meta-whatsapp-live-command.record-binding */
       SELECT app_private.record_whatsapp_live_binding(
         $1::uuid, $2::uuid, $3::uuid, $4::text, $5::text, $6::text,
         $7::bytea, $8::text, $9::bytea, $10::bytea, $11::bytea,
         $12::bytea, $13::bytea, $14::bytea, $15::timestamptz, $16::uuid
       ) AS id`, values, 'binding result');
  }

  async revokeBinding(
    context: MetaWhatsAppLiveUserContext,
    command: Readonly<{ bindingId: string; evidenceSha256: string }>,
  ): Promise<string> {
    this.#assertContext(context);
    return this.#executeId(context,
      `/* meta-whatsapp-live-command.revoke-binding */
       SELECT app_private.revoke_whatsapp_live_binding(
         $1::uuid, $2::uuid, $3::bytea
       ) AS id`, [this.workspaceId, uuid(command.bindingId, 'binding id'),
        digest(command.evidenceSha256, 'revocation evidence digest')],
      'revocation result');
  }

  async recordTemplate(
    context: MetaWhatsAppLiveUserContext,
    command: RecordMetaWhatsAppLiveTemplateCommand,
  ): Promise<string> {
    this.#assertContext(context);
    if (!TEMPLATE.test(command.templateName) || !LANGUAGE.test(command.languageCode)
        || !['utility', 'marketing'].includes(command.category)) {
      throw new Error('Meta WhatsApp live template command is invalid');
    }
    const values = [this.workspaceId, uuid(command.bindingId, 'binding id'),
      uuid(command.templateId, 'template id'), uuid(command.contentItemId, 'content item'),
      uuid(command.contentVersionId, 'content version'),
      uuid(command.approvalRequestId, 'approval request'),
      uuid(command.approvalDecisionId, 'approval decision'), command.templateName,
      digest(command.templateRefSha256, 'template reference digest'), command.languageCode,
      command.category,
      digest(command.providerApprovalEvidenceSha256, 'provider approval evidence'),
      timestamp(command.providerApprovedAt, 'provider approval')];
    return this.#executeId(context,
      `/* meta-whatsapp-live-command.record-template */
       SELECT app_private.record_whatsapp_live_template(
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
         $7::uuid, $8::text, $9::bytea, $10::text, $11::text, $12::bytea,
         $13::timestamptz
       ) AS id`, values, 'template result');
  }

  async authorizeAndEnqueue(
    context: MetaWhatsAppLiveUserContext,
    command: EnqueueMetaWhatsAppLiveTemplateCommand,
  ): Promise<string> {
    this.#assertContext(context);
    if (!PURPOSE.test(command.purpose)) {
      throw new Error('Meta WhatsApp live enqueue purpose is invalid');
    }
    const values = [this.workspaceId, uuid(command.bindingId, 'binding id'),
      uuid(command.templateId, 'template id'), uuid(command.contactId, 'contact'),
      uuid(command.contactPointId, 'contact point'),
      uuid(command.consentEventId, 'consent event'),
      uuid(command.complianceSubjectId, 'compliance subject'),
      uuid(command.policyPublicationEventId, 'policy publication'),
      uuid(command.pecrSenderDecisionEventId, 'PECR sender decision'),
      uuid(command.pecrInstigatorDecisionEventId, 'PECR instigator decision'),
      uuid(command.permissionUseReceiptId, 'permission-use receipt'), command.purpose,
      timestamp(command.authorityValidUntil, 'authority expiry'),
      uuid(command.operationId, 'operation id'),
      digest(command.idempotencyKeySha256, 'idempotency digest'),
      digest(command.requestSha256, 'request digest')];
    return this.#executeId(context,
      `/* meta-whatsapp-live-command.authorize-and-enqueue */
       SELECT app_private.authorize_and_enqueue_whatsapp_live_job(
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
         $7::uuid, $8::uuid, $9::uuid, $10::uuid, $11::uuid, $12::text,
         $13::timestamptz, $14::uuid, $15::bytea, $16::bytea
       ) AS id`, values, 'enqueue result');
  }

  #assertContext(context: MetaWhatsAppLiveUserContext): void {
    if (context.actorKind !== 'user' || context.workspaceId !== this.workspaceId
        || !Buffer.isBuffer(context.portalSessionTokenHash)
        || context.portalSessionTokenHash.length !== 32) {
      throw new Error('Meta WhatsApp live command crossed its trusted workspace');
    }
  }

  #executeId(
    context: MetaWhatsAppLiveUserContext,
    sql: string,
    values: readonly unknown[],
    label: string,
  ): Promise<string> {
    return withTransaction(this.#commandPool, context,
      async (transaction) => resultId(await transaction.query<IdRow>(sql, [...values]), label),
      { isolation: 'serializable' });
  }
}
