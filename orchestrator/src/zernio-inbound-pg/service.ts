import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';
import { withTransaction } from '../db/transaction.js';

export const ZERNIO_INBOUND_WEBHOOK_CONTRACT_VERSION =
  'r72-zernio-inbound-webhook-v1' as const;
export const ZERNIO_INBOUND_WEBHOOK_MAXIMUM_BYTES = 65_536;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SECRET = /^[\x21-\x7e]{16,500}$/u;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const OPAQUE_ID = /^[^\u0000-\u001f\u007f]{1,512}$/u;

export type ZernioInboundNetwork = 'instagram' | 'linkedin';
export type ZernioInboundKind = 'instagram_dm' | 'owned_post_comment';
export type ZernioInboundDisposition = 'applied' | 'replayed' | 'quarantined' | 'conflict';
export type ZernioInboundProviderOwnershipAssertion =
  'not_applicable' | 'not_owned' | 'unknown';

export class ZernioInboundContractError extends Error {
  constructor(
    readonly kind: 'authentication' | 'payload' | 'not_applicable',
    message: string,
  ) {
    super(message);
    this.name = 'ZernioInboundContractError';
  }
}

export class ZernioInboundAccountBindingError extends Error {
  constructor() {
    super('The signed Zernio event does not match one exact connected account');
    this.name = 'ZernioInboundAccountBindingError';
  }
}

export interface ZernioInboundWebhookCredentialInput {
  readonly workspaceId: string;
  readonly providerConnectionId: string;
  readonly providerProfileId: string;
  readonly credentialVersion: string;
  readonly webhookSecret: string;
}

export interface ZernioInboundWebhookCredential {
  readonly contract: typeof ZERNIO_INBOUND_WEBHOOK_CONTRACT_VERSION;
  readonly workspaceId: string;
  readonly providerConnectionId: string;
  readonly providerProfileIdSha256: string;
  readonly credentialVersion: string;
  readonly credentialVersionSha256: string;
  readonly bindingSha256: string;
}

interface SecretMaterial { readonly webhookSecret: string }
const SECRETS = new WeakMap<object, SecretMaterial>();

export interface VerifiedZernioInbound {
  readonly contract: typeof ZERNIO_INBOUND_WEBHOOK_CONTRACT_VERSION;
  readonly workspaceId: string;
  readonly providerConnectionId: string;
  readonly network: ZernioInboundNetwork;
  readonly inboundKind: ZernioInboundKind;
  readonly providerProfileIdSha256: string;
  readonly credentialVersionSha256: string;
  readonly credentialBindingSha256: string;
  readonly providerAccountIdSha256: string;
  readonly providerPersonIdSha256: string;
  readonly providerThreadIdSha256: string;
  readonly providerEventIdSha256: string;
  readonly bodyText: string;
  readonly bodySha256: string;
  readonly payloadSha256: string;
  readonly signatureSha256: string;
  readonly eventIdentitySha256: string;
  readonly providerOwnershipAssertion: ZernioInboundProviderOwnershipAssertion;
  readonly occurredAt: string;
  readonly signatureVerifiedAt: string;
  readonly requestId: string;
  readonly providerEffects: 'none';
}

export interface ZernioInboundReceipt {
  readonly disposition: ZernioInboundDisposition;
  readonly transportReceiptId: string;
  readonly eventId: string;
  readonly quarantineId: string | null;
  readonly projectionId: string | null;
  readonly conversationId: string | null;
  readonly inboundMessageId: string | null;
  readonly adminReviewTaskId: string | null;
  readonly outreachAttemptReceiptId: string | null;
  readonly outreachCandidateDisposition: 'linked' | 'unlinked' | null;
  readonly providerEffects: 'none';
}

function fail(kind: ZernioInboundContractError['kind'], message: string): never {
  throw new ZernioInboundContractError(kind, message);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('payload', `${label} is invalid`);
  }
  return value as Record<string, unknown>;
}

function opaqueId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value !== value.trim() || !OPAQUE_ID.test(value)) {
    fail('payload', `${label} is invalid`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(value)) {
    fail('payload', `${label} is invalid`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) fail('payload', `${label} is invalid`);
  return parsed.toISOString();
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function postgresTimestamp(value: string): string {
  return value.replace(/\.(\d{3})Z$/u, '.$1000Z');
}

function accountIdentity(account: Record<string, unknown>): string {
  const id = opaqueId(account.id, 'account.id');
  if (account.accountId !== undefined
      && opaqueId(account.accountId, 'account.accountId') !== id) {
    fail('payload', 'Zernio account identity is mismatched');
  }
  return id;
}

function body(value: unknown, fallback: string): string {
  const candidate = typeof value === 'string' ? value : fallback;
  if (candidate.trim().length === 0 || candidate.includes('\u0000')
      || Buffer.byteLength(candidate, 'utf8') > 65_536) {
    fail('payload', 'Zernio inbound body is invalid');
  }
  return candidate;
}

function validateAttachments(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > 20) {
    fail('payload', 'Zernio message attachments are invalid');
  }
  return value.map((entry, index) => {
    const attachment = record(entry, `message.attachments[${index}]`);
    opaqueId(attachment.type, `message.attachments[${index}].type`);
    const rawUrl = opaqueId(attachment.url, `message.attachments[${index}].url`);
    let parsed: URL;
    try { parsed = new URL(rawUrl); }
    catch { return fail('payload', `message.attachments[${index}].url is invalid`); }
    if (parsed.protocol !== 'https:') {
      fail('payload', `message.attachments[${index}].url is invalid`);
    }
    return attachment;
  });
}

export function createZernioInboundWebhookCredential(
  input: ZernioInboundWebhookCredentialInput,
): ZernioInboundWebhookCredential {
  const workspaceId = input.workspaceId.trim().toLowerCase();
  const providerConnectionId = input.providerConnectionId.trim().toLowerCase();
  if (!UUID.test(workspaceId) || !UUID.test(providerConnectionId)
      || !OPAQUE_ID.test(input.providerProfileId)
      || !VERSION.test(input.credentialVersion)
      || !SECRET.test(input.webhookSecret)) {
    throw new ZernioInboundContractError('payload', 'Zernio inbound credential binding is invalid');
  }
  const providerProfileIdSha256 = sha256(input.providerProfileId);
  const credentialVersionSha256 = sha256(input.credentialVersion);
  const credential = Object.freeze({
    contract: ZERNIO_INBOUND_WEBHOOK_CONTRACT_VERSION,
    workspaceId,
    providerConnectionId,
    providerProfileIdSha256,
    credentialVersion: input.credentialVersion,
    credentialVersionSha256,
    bindingSha256: sha256(JSON.stringify({
      contract: ZERNIO_INBOUND_WEBHOOK_CONTRACT_VERSION,
      workspaceId,
      providerConnectionId,
      providerProfileIdSha256,
      credentialVersion: input.credentialVersion,
      webhookSecretSha256: sha256(input.webhookSecret),
    })),
  });
  SECRETS.set(credential, Object.freeze({ webhookSecret: input.webhookSecret }));
  return credential;
}

export function verifyZernioInboundWebhook(
  credential: ZernioInboundWebhookCredential,
  input: Readonly<{
    rawBody: Uint8Array;
    signatureHeader: string;
    eventIdHeader: string;
  }>,
  now: () => Date = () => new Date(),
): VerifiedZernioInbound {
  const secrets = SECRETS.get(credential as object);
  if (!secrets) fail('authentication', 'Zernio inbound credential is not authentic');
  if (!(input.rawBody instanceof Uint8Array)) fail('payload', 'Zernio inbound body is invalid');
  const rawBody = Buffer.from(input.rawBody);
  if (rawBody.byteLength < 2 || rawBody.byteLength > ZERNIO_INBOUND_WEBHOOK_MAXIMUM_BYTES) {
    fail('payload', 'Zernio inbound body is invalid');
  }
  if (!SHA256.test(input.signatureHeader)) fail('authentication', 'Zernio signature is invalid');
  const supplied = Buffer.from(input.signatureHeader, 'hex');
  const expected = createHmac('sha256', secrets.webhookSecret).update(rawBody).digest();
  if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected)) {
    fail('authentication', 'Zernio signature is invalid');
  }

  let payload: Record<string, unknown>;
  try {
    payload = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBody)),
      'Zernio inbound payload');
  } catch (error) {
    if (error instanceof ZernioInboundContractError) throw error;
    fail('payload', 'Zernio inbound payload is invalid');
  }
  const eventId = opaqueId(payload.id, 'payload.id');
  if (opaqueId(input.eventIdHeader, 'X-Zernio-Event-Id') !== eventId) {
    fail('authentication', 'Zernio event identity is mismatched');
  }
  if (payload.event !== 'message.received' && payload.event !== 'comment.received') {
    fail('not_applicable', 'Zernio event is not an inbound message or comment');
  }
  const account = record(payload.account, 'payload.account');
  const providerAccountId = accountIdentity(account);
  if (account.profileId !== undefined
      && sha256(opaqueId(account.profileId, 'account.profileId'))
        !== credential.providerProfileIdSha256) {
    fail('authentication', 'Zernio profile binding is mismatched');
  }
  let network: ZernioInboundNetwork;
  let inboundKind: ZernioInboundKind;
  let personId: string;
  let threadId: string;
  let bodyText: string;
  let occurredAt: string;
  let providerOwnershipAssertion: ZernioInboundProviderOwnershipAssertion;

  if (payload.event === 'message.received') {
    const message = record(payload.message, 'payload.message');
    const conversation = record(payload.conversation, 'payload.conversation');
    if (message.platform !== 'instagram' || account.platform !== 'instagram'
        || message.direction !== 'incoming') {
      fail('not_applicable', 'Only incoming Instagram DMs are accepted');
    }
    const attachments = validateAttachments(message.attachments);
    const sender = record(message.sender, 'message.sender');
    personId = opaqueId(sender.id, 'message.sender.id');
    if (conversation.participantId !== undefined
        && opaqueId(conversation.participantId, 'conversation.participantId') !== personId) {
      fail('payload', 'Zernio participant identity is mismatched');
    }
    const conversationId = opaqueId(conversation.id, 'conversation.id');
    if (opaqueId(message.conversationId, 'message.conversationId') !== conversationId) {
      fail('payload', 'Zernio conversation identity is mismatched');
    }
    threadId = opaqueId(conversation.platformConversationId,
      'conversation.platformConversationId');
    bodyText = body(message.text,
      attachments.length > 0 ? '[Instagram attachment received]' : '');
    occurredAt = timestamp(message.sentAt, 'message.sentAt');
    network = 'instagram';
    inboundKind = 'instagram_dm';
    providerOwnershipAssertion = 'not_applicable';
  } else {
    const comment = record(payload.comment, 'payload.comment');
    const post = record(payload.post, 'payload.post');
    if ((comment.platform !== 'instagram' && comment.platform !== 'linkedin')
        || account.platform !== comment.platform) {
      fail('not_applicable', 'Only Instagram or LinkedIn owned-post comments are accepted');
    }
    const author = record(comment.author, 'comment.author');
    if (author.isOwnAccount !== undefined
        && typeof author.isOwnAccount !== 'boolean') {
      fail('payload', 'comment.author.isOwnAccount is invalid');
    }
    if (author.isOwnAccount === true) {
      fail('not_applicable', 'Own-account comments are not inbound leads');
    }
    providerOwnershipAssertion = author.isOwnAccount === false ? 'not_owned' : 'unknown';
    personId = opaqueId(author.id, 'comment.author.id');
    threadId = opaqueId(post.platformPostId, 'post.platformPostId');
    if (opaqueId(comment.platformPostId, 'comment.platformPostId') !== threadId) {
      fail('payload', 'Zernio comment post identity is mismatched');
    }
    bodyText = body(comment.text, '');
    occurredAt = timestamp(comment.createdAt, 'comment.createdAt');
    network = comment.platform;
    inboundKind = 'owned_post_comment';
  }

  timestamp(payload.timestamp, 'payload.timestamp');
  const verifiedAt = now();
  if (!(verifiedAt instanceof Date) || !Number.isFinite(verifiedAt.getTime())) {
    fail('payload', 'Zernio signature verification time is invalid');
  }
  const providerAccountIdSha256 = sha256(providerAccountId);
  const providerPersonIdSha256 = sha256(personId);
  const providerThreadIdSha256 = sha256(threadId);
  const providerEventIdSha256 = sha256(eventId);
  const bodySha256 = sha256(bodyText);
  const payloadSha256 = sha256(rawBody);
  const signatureSha256 = sha256(supplied);
  const eventKeySha256 = providerEventIdSha256;
  const eventIdentitySha256 = sha256(
    `${eventKeySha256}\x1f${network}\x1f${inboundKind}\x1f${providerAccountIdSha256}`
      + `\x1f${providerPersonIdSha256}\x1f${providerThreadIdSha256}`
      + `\x1f${bodySha256}\x1f${payloadSha256}\x1f${postgresTimestamp(occurredAt)}`,
  );
  return Object.freeze({
    contract: ZERNIO_INBOUND_WEBHOOK_CONTRACT_VERSION,
    workspaceId: credential.workspaceId,
    providerConnectionId: credential.providerConnectionId,
    network,
    inboundKind,
    providerProfileIdSha256: credential.providerProfileIdSha256,
    credentialVersionSha256: credential.credentialVersionSha256,
    credentialBindingSha256: credential.bindingSha256,
    providerAccountIdSha256,
    providerPersonIdSha256,
    providerThreadIdSha256,
    providerEventIdSha256,
    bodyText,
    bodySha256,
    payloadSha256,
    signatureSha256,
    eventIdentitySha256,
    providerOwnershipAssertion,
    occurredAt,
    signatureVerifiedAt: verifiedAt.toISOString(),
    requestId: `zernio-inbound:${providerEventIdSha256.slice(0, 48)}`,
    providerEffects: 'none',
  });
}

interface AccountRow extends QueryResultRow { zernio_account_id: unknown }
interface ReceiptRow extends QueryResultRow {
  disposition: unknown;
  transport_receipt_id: unknown;
  event_id: unknown;
  quarantine_id: unknown;
  projection_id: unknown;
  conversation_id: unknown;
  inbound_message_id: unknown;
  admin_review_task_id: unknown;
  outreach_attempt_receipt_id: unknown;
  outreach_candidate_disposition: unknown;
}

function nullableUuid(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function requiredUuid(value: unknown, label: string): string {
  const parsed = nullableUuid(value, label);
  if (!parsed) throw new Error(`${label} is required`);
  return parsed;
}

const ZERNIO_INBOUND_MAXIMUM_TRANSACTION_ATTEMPTS = 3;
const ZERNIO_INBOUND_RETRYABLE_UNIQUE_CONSTRAINTS = new Set([
  'conversations_open_contact_inbox_uq',
  'zernio_inbound_transport_delivery_uq',
  'zernio_inbound_event_key_uq',
]);

function isRetryableZernioInboundTransactionError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const databaseError = error as { readonly code?: unknown; readonly constraint?: unknown };
  if (databaseError.code === '40001' || databaseError.code === '40P01') return true;
  return databaseError.code === '23505'
    && typeof databaseError.constraint === 'string'
    && ZERNIO_INBOUND_RETRYABLE_UNIQUE_CONSTRAINTS.has(databaseError.constraint);
}

export class PgZernioInboundRepository {
  constructor(private readonly commandPool: Pick<Pool, 'connect'>) {}

  async record(input: VerifiedZernioInbound): Promise<ZernioInboundReceipt> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.recordInFreshTransaction(input);
      } catch (error) {
        if (attempt >= ZERNIO_INBOUND_MAXIMUM_TRANSACTION_ATTEMPTS
            || !isRetryableZernioInboundTransactionError(error)) throw error;
      }
    }
  }

  private async recordInFreshTransaction(
    input: VerifiedZernioInbound,
  ): Promise<ZernioInboundReceipt> {
    return withTransaction(this.commandPool, {
      actorKind: 'webhook', workspaceId: input.workspaceId, requestId: input.requestId,
    }, async (client) => {
      const account = await client.query<AccountRow>(
        `/* zernio-inbound.resolve-account */
         SELECT * FROM app_private.resolve_zernio_inbound_account(
           $1::uuid,$2::uuid,$3::text,$4::bytea,$5::bytea,$6::bytea,$7::bytea
         )`,
        [input.workspaceId, input.providerConnectionId, input.network,
          Buffer.from(input.providerProfileIdSha256, 'hex'),
          Buffer.from(input.providerAccountIdSha256, 'hex'),
          Buffer.from(input.credentialVersionSha256, 'hex'),
          Buffer.from(input.credentialBindingSha256, 'hex')],
      );
      const zernioAccountId = account.rows[0]?.zernio_account_id;
      if (account.rows.length !== 1 || typeof zernioAccountId !== 'string'
          || !UUID.test(zernioAccountId)) throw new ZernioInboundAccountBindingError();
      const result = await client.query<ReceiptRow>(
        `/* zernio-inbound.record */
         SELECT * FROM app_private.record_zernio_signed_inbound(
           $1::uuid,$2::uuid,$3::uuid,$4::text,$5::text,
           $6::bytea,$7::bytea,$8::bytea,$9::bytea,$10::bytea,
           $11::bytea,$12::bytea,$13::text,$14::bytea,$15::bytea,
           $16::bytea,$17::bytea,$18::text,$19::timestamptz,$20::timestamptz
         )`,
        [input.workspaceId, input.providerConnectionId, zernioAccountId,
          input.network, input.inboundKind,
          Buffer.from(input.providerProfileIdSha256, 'hex'),
          Buffer.from(input.credentialVersionSha256, 'hex'),
          Buffer.from(input.credentialBindingSha256, 'hex'),
          Buffer.from(input.providerAccountIdSha256, 'hex'),
          Buffer.from(input.providerPersonIdSha256, 'hex'),
          Buffer.from(input.providerThreadIdSha256, 'hex'),
          Buffer.from(input.providerEventIdSha256, 'hex'),
          input.bodyText,
          Buffer.from(input.bodySha256, 'hex'), Buffer.from(input.payloadSha256, 'hex'),
          Buffer.from(input.signatureSha256, 'hex'), Buffer.from(input.eventIdentitySha256, 'hex'),
          input.providerOwnershipAssertion, input.occurredAt, input.signatureVerifiedAt],
      );
      const row = result.rows[0];
      if (result.rows.length !== 1 || !row
          || (row.disposition !== 'applied' && row.disposition !== 'replayed'
            && row.disposition !== 'quarantined' && row.disposition !== 'conflict')) {
        throw new Error('Zernio inbound recorder returned an invalid disposition');
      }
      const candidate = row.outreach_candidate_disposition;
      if (candidate !== null && candidate !== 'linked' && candidate !== 'unlinked') {
        throw new Error('Zernio inbound outreach disposition is invalid');
      }
      const transportReceiptId = requiredUuid(row.transport_receipt_id, 'transport receipt');
      const eventId = requiredUuid(row.event_id, 'event');
      const quarantineId = nullableUuid(row.quarantine_id, 'quarantine');
      const projectionId = nullableUuid(row.projection_id, 'projection');
      const conversationId = nullableUuid(row.conversation_id, 'conversation');
      const inboundMessageId = nullableUuid(row.inbound_message_id, 'inbound message');
      const adminReviewTaskId = nullableUuid(row.admin_review_task_id, 'admin review task');
      const outreachAttemptReceiptId = nullableUuid(
        row.outreach_attempt_receipt_id, 'outreach attempt receipt');
      const projected = row.disposition === 'applied' || row.disposition === 'replayed';
      if (projected) {
        if (quarantineId !== null || !projectionId || !conversationId
            || !inboundMessageId || !adminReviewTaskId || candidate === null
            || (candidate === 'linked') !== (outreachAttemptReceiptId !== null)) {
          throw new Error('Zernio inbound projected receipt shape is invalid');
        }
      } else if (!quarantineId || projectionId !== null || conversationId !== null
          || inboundMessageId !== null || adminReviewTaskId !== null
          || outreachAttemptReceiptId !== null || candidate !== null) {
        throw new Error('Zernio inbound quarantined receipt shape is invalid');
      }
      return Object.freeze({
        disposition: row.disposition,
        transportReceiptId,
        eventId,
        quarantineId,
        projectionId,
        conversationId,
        inboundMessageId,
        adminReviewTaskId,
        outreachAttemptReceiptId,
        outreachCandidateDisposition: candidate,
        providerEffects: 'none' as const,
      });
    }, { isolation: 'serializable' });
  }
}

export async function assertZernioInboundCommandBoundaryReady(
  pool: Pick<Pool, 'query'>,
): Promise<void> {
  const result = await pool.query<Record<string, unknown>>(
    `/* zernio-inbound.runtime-boundary */
     SELECT
       current_user = 'r72_zernio_inbound_webhook_command' AS "exactRole",
       EXISTS (
         SELECT 1 FROM pg_catalog.pg_roles role
         WHERE role.rolname = 'r72_zernio_inbound_webhook_command'
           AND role.rolcanlogin AND NOT role.rolinherit
           AND NOT role.rolsuper AND NOT role.rolcreatedb
           AND NOT role.rolcreaterole AND NOT role.rolreplication
           AND NOT role.rolbypassrls
       ) AND EXISTS (
         SELECT 1 FROM pg_catalog.pg_roles role
         WHERE role.rolname = 'r72_zernio_inbound_definer'
           AND NOT role.rolcanlogin AND NOT role.rolinherit
           AND NOT role.rolsuper AND NOT role.rolcreatedb
           AND NOT role.rolcreaterole AND NOT role.rolreplication
           AND NOT role.rolbypassrls
       ) AS "exactRoleAttributes",
       has_schema_privilege(current_user, 'app_private', 'USAGE') AS "schemaUsage",
       has_function_privilege(current_user,
         'app_private.resolve_zernio_inbound_account(uuid,uuid,text,bytea,bytea,bytea,bytea)',
         'EXECUTE')
       AND has_function_privilege(current_user,
         'app_private.record_zernio_signed_inbound(uuid,uuid,uuid,text,text,bytea,bytea,bytea,bytea,bytea,bytea,bytea,text,bytea,bytea,bytea,bytea,text,timestamp with time zone,timestamp with time zone)',
         'EXECUTE')
       AND has_function_privilege(current_user,
         'app_private.runtime_schema_migrations()', 'EXECUTE')
       AND has_function_privilege(current_user,
         'app_private.runtime_database_installation_id()', 'EXECUTE')
         AS "requiredFunctions",
       NOT EXISTS (
         SELECT 1
         FROM pg_catalog.pg_proc procedure
         JOIN pg_catalog.pg_namespace namespace
           ON namespace.oid = procedure.pronamespace
         WHERE namespace.nspname = 'app_private'
           AND has_function_privilege(current_user, procedure.oid, 'EXECUTE')
           AND procedure.oid::regprocedure::text NOT IN (
             'app_private.resolve_zernio_inbound_account(uuid,uuid,text,bytea,bytea,bytea,bytea)',
             'app_private.record_zernio_signed_inbound(uuid,uuid,uuid,text,text,bytea,bytea,bytea,bytea,bytea,bytea,bytea,text,bytea,bytea,bytea,bytea,text,timestamp with time zone,timestamp with time zone)',
             'app_private.runtime_schema_migrations()',
             'app_private.runtime_database_installation_id()'
           )
       ) AS "exactFunctionsOnly",
       NOT EXISTS (
         SELECT 1 FROM pg_catalog.pg_class relation
         JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname IN ('app', 'app_private')
           AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
           AND (has_table_privilege(current_user, relation.oid,
                  'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
             OR has_any_column_privilege(current_user, relation.oid,
                  'SELECT,INSERT,UPDATE,REFERENCES'))
       ) AS "tableBlind",
       NOT pg_has_role(current_user, 'r72_owner', 'MEMBER')
         AND NOT pg_has_role(current_user, 'r72_security_definer', 'MEMBER')
         AND NOT pg_has_role(current_user, 'r72_zernio_inbound_definer', 'MEMBER')
         AS "elevatedRolesDenied",
       NOT EXISTS (
         SELECT 1
         FROM pg_catalog.pg_auth_members membership
         JOIN pg_catalog.pg_roles member ON member.oid = membership.member
         WHERE member.rolname IN (
           'r72_zernio_inbound_webhook_command', 'r72_zernio_inbound_definer'
         )
       ) AS "parentRolesDenied",
       NOT EXISTS (
         SELECT 1
         FROM pg_catalog.pg_auth_members membership
         JOIN pg_catalog.pg_roles member ON member.oid = membership.member
         JOIN pg_catalog.pg_roles parent ON parent.oid = membership.roleid
         WHERE parent.rolname = 'r72_zernio_inbound_webhook_command'
            OR (parent.rolname = 'r72_zernio_inbound_definer'
                AND member.rolname <> 'r72_owner')
       ) AS "reverseMembersExact"`,
  );
  const row = result.rows[0];
  if (result.rows.length !== 1 || !row
      || Object.values(row).some((value) => value !== true)) {
    throw new Error('Zernio inbound command database boundary is not exact');
  }
}
