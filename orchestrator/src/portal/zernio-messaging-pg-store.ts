import { createHash } from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';
import { requestDatabaseContext } from '../db/rls.js';
import { InactivePortalSessionError, withTransaction } from '../db/transaction.js';
import {
  createPgPortalCrmPrincipalResolver,
  type PortalCrmPrincipalResolver,
} from './crm-pg-service.js';
import type { PortalCrmRequestIdentity } from './crm-service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HEX = /^[0-9a-f]{64}$/u;

export type ZernioReplyStoreFailure =
  | 'unauthenticated' | 'forbidden' | 'validation' | 'conflict' | 'unavailable';

export interface ZernioReplyState {
  readonly draftId: string;
  readonly body: string;
  readonly bodySha256: string;
  readonly createdAt: string;
  readonly approvalRequestId: string | null;
  readonly requestedAt: string | null;
  readonly approvalDecisionId: string | null;
  readonly approvalDecision: 'approved' | 'rejected' | null;
  readonly decidedAt: string | null;
  readonly deliveryId: string | null;
  readonly deliveryState: 'calling' | 'accepted' | 'failed' | 'outcome_unknown' | null;
  readonly deliveryStartedAt: string | null;
  readonly deliverySettledAt: string | null;
  readonly deliveryFailureCode: string | null;
}

export type ZernioReplyStoreResult<T> = Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; kind: ZernioReplyStoreFailure }>;

interface ReplyRow extends QueryResultRow {
  draft_id: unknown;
  body_text: unknown;
  body_sha256: unknown;
  created_at: unknown;
  approval_request_id: unknown;
  requested_at: unknown;
  approval_decision_id: unknown;
  approval_decision: unknown;
  decided_at: unknown;
  delivery_id: unknown;
  delivery_state: unknown;
  delivery_started_at: unknown;
  delivery_settled_at: unknown;
  delivery_failure_code: unknown;
}

interface DispositionRow extends QueryResultRow { disposition: unknown }
interface ClaimRow extends DispositionRow { body_text: unknown; body_sha256: unknown }

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function hex(value: unknown): string {
  if (!Buffer.isBuffer(value) || value.length !== 32) throw new Error('Invalid reply digest');
  return value.toString('hex');
}

function timestamp(value: unknown): string {
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(parsed.getTime())) throw new Error('Invalid reply timestamp');
  return parsed.toISOString();
}

function nullableTimestamp(value: unknown): string | null {
  return value === null || value === undefined ? null : timestamp(value);
}

function nullableUuid(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error('Invalid reply UUID');
  return value;
}

function mapRow(row: ReplyRow): ZernioReplyState {
  if (typeof row.draft_id !== 'string' || !UUID.test(row.draft_id)
      || typeof row.body_text !== 'string' || row.body_text.length < 1
      || (row.approval_decision !== null && row.approval_decision !== 'approved'
        && row.approval_decision !== 'rejected')
      || (row.delivery_state !== null && row.delivery_state !== 'calling'
        && row.delivery_state !== 'accepted' && row.delivery_state !== 'failed'
        && row.delivery_state !== 'outcome_unknown')
      || (row.delivery_failure_code !== null && typeof row.delivery_failure_code !== 'string')) {
    throw new Error('Invalid reply state row');
  }
  return Object.freeze({
    draftId: row.draft_id,
    body: row.body_text,
    bodySha256: hex(row.body_sha256),
    createdAt: timestamp(row.created_at),
    approvalRequestId: nullableUuid(row.approval_request_id),
    requestedAt: nullableTimestamp(row.requested_at),
    approvalDecisionId: nullableUuid(row.approval_decision_id),
    approvalDecision: row.approval_decision as 'approved' | 'rejected' | null,
    decidedAt: nullableTimestamp(row.decided_at),
    deliveryId: nullableUuid(row.delivery_id),
    deliveryState: row.delivery_state as ZernioReplyState['deliveryState'],
    deliveryStartedAt: nullableTimestamp(row.delivery_started_at),
    deliverySettledAt: nullableTimestamp(row.delivery_settled_at),
    deliveryFailureCode: row.delivery_failure_code as string | null,
  });
}

function sqlState(error: unknown): string | null {
  return error && typeof error === 'object' && 'code' in error
    && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code : null;
}

function failure(error: unknown): ZernioReplyStoreResult<never> {
  if (error instanceof InactivePortalSessionError) return Object.freeze({ ok: false, kind: 'unauthenticated' });
  const code = sqlState(error);
  if (code === '42501') return Object.freeze({ ok: false, kind: 'forbidden' });
  if (code === '40001' || code === '23505') return Object.freeze({ ok: false, kind: 'conflict' });
  if (code === '22023' || code === '23503' || code === '23514') {
    return Object.freeze({ ok: false, kind: 'validation' });
  }
  return Object.freeze({ ok: false, kind: 'unavailable' });
}

export class PgZernioMessagingReplyStore {
  readonly #profileHash: Buffer;

  constructor(private readonly dependencies: Readonly<{
    principalResolver: Pick<PortalCrmPrincipalResolver, 'resolve'>;
    commandPool: Pick<Pool, 'connect'>;
    workspaceId: string;
    providerConnectionId: string;
    providerProfileId: string;
  }>) {
    if (!UUID.test(dependencies.workspaceId) || !UUID.test(dependencies.providerConnectionId)
        || dependencies.providerProfileId.length < 3) throw new Error('Invalid Zernio reply store binding');
    this.#profileHash = sha256(dependencies.providerProfileId);
  }

  async #context(identity: PortalCrmRequestIdentity) {
    const principal = await this.dependencies.principalResolver.resolve(identity.sessionToken);
    if (!principal || principal.workspaceId !== this.dependencies.workspaceId) return null;
    return requestDatabaseContext({
      ...principal, requestId: identity.requestId,
      portalSessionTokenHash: sha256(identity.sessionToken),
    });
  }

  async read(identity: PortalCrmRequestIdentity, input: Readonly<{
    accountId: string; providerConversationId: string;
  }>): Promise<ZernioReplyStoreResult<ZernioReplyState | null>> {
    try {
      const context = await this.#context(identity);
      if (!context) return Object.freeze({ ok: false, kind: 'unauthenticated' });
      const result = await withTransaction(this.dependencies.commandPool, context, (client) =>
        client.query<ReplyRow>(
          `/* portal.zernio-messaging.reply-state */
           SELECT * FROM app_private.read_zernio_reply_state(
             $1::uuid,$2::uuid,$3::bytea,$4::bytea,$5::bytea
           )`,
          [context.workspaceId, this.dependencies.providerConnectionId, this.#profileHash,
            sha256(input.accountId), sha256(input.providerConversationId)],
        ), { readOnly: true, isolation: 'repeatable read' });
      if (result.rows.length > 1) throw new Error('Invalid reply state cardinality');
      return Object.freeze({ ok: true, value: result.rows[0] ? mapRow(result.rows[0]) : null });
    } catch (error) { return failure(error); }
  }

  async create(identity: PortalCrmRequestIdentity, input: Readonly<{
    draftId: string; accountId: string; providerConversationId: string; body: string;
  }>): Promise<ZernioReplyStoreResult<'created' | 'replayed'>> {
    if (!UUID.test(input.draftId) || !input.body || input.body !== input.body.trim()
        || Buffer.byteLength(input.body, 'utf8') > 10_000) {
      return Object.freeze({ ok: false, kind: 'validation' });
    }
    try {
      const context = await this.#context(identity);
      if (!context) return Object.freeze({ ok: false, kind: 'unauthenticated' });
      const bodyHash = sha256(input.body);
      const result = await withTransaction(this.dependencies.commandPool, context, (client) =>
        client.query<DispositionRow>(
          `/* portal.zernio-messaging.create-draft */
           SELECT disposition FROM app_private.create_zernio_reply_draft(
             $1::uuid,$2::uuid,$3::uuid,$4::bytea,$5::bytea,$6::bytea,$7::text,$8::bytea
           )`,
          [context.workspaceId, this.dependencies.providerConnectionId, input.draftId,
            this.#profileHash, sha256(input.accountId), sha256(input.providerConversationId),
            input.body, bodyHash],
        ), { isolation: 'serializable' });
      const disposition = result.rows[0]?.disposition;
      if (result.rows.length !== 1 || (disposition !== 'created' && disposition !== 'replayed')) {
        throw new Error('Invalid draft disposition');
      }
      return Object.freeze({ ok: true, value: disposition });
    } catch (error) { return failure(error); }
  }

  async requestApproval(identity: PortalCrmRequestIdentity, input: Readonly<{
    draftId: string; approvalRequestId: string;
  }>): Promise<ZernioReplyStoreResult<'requested' | 'replayed'>> {
    if (!UUID.test(input.draftId) || !UUID.test(input.approvalRequestId)) {
      return Object.freeze({ ok: false, kind: 'validation' });
    }
    try {
      const context = await this.#context(identity);
      if (!context) return Object.freeze({ ok: false, kind: 'unauthenticated' });
      const result = await withTransaction(this.dependencies.commandPool, context, (client) =>
        client.query<DispositionRow>(
          `/* portal.zernio-messaging.request-approval */
           SELECT app_private.request_zernio_reply_approval($1::uuid,$2::uuid,$3::uuid) AS disposition`,
          [context.workspaceId, input.draftId, input.approvalRequestId],
        ), { isolation: 'serializable' });
      const disposition = result.rows[0]?.disposition;
      if (result.rows.length !== 1 || (disposition !== 'requested' && disposition !== 'replayed')) {
        throw new Error('Invalid approval request disposition');
      }
      return Object.freeze({ ok: true, value: disposition });
    } catch (error) { return failure(error); }
  }

  async decide(identity: PortalCrmRequestIdentity, input: Readonly<{
    approvalRequestId: string; decisionId: string; decision: 'approved' | 'rejected';
  }>): Promise<ZernioReplyStoreResult<'approved' | 'rejected' | 'replayed'>> {
    if (!UUID.test(input.approvalRequestId) || !UUID.test(input.decisionId)
        || (input.decision !== 'approved' && input.decision !== 'rejected')) {
      return Object.freeze({ ok: false, kind: 'validation' });
    }
    try {
      const context = await this.#context(identity);
      if (!context) return Object.freeze({ ok: false, kind: 'unauthenticated' });
      const result = await withTransaction(this.dependencies.commandPool, context, (client) =>
        client.query<DispositionRow>(
          `/* portal.zernio-messaging.decide-approval */
           SELECT app_private.decide_zernio_reply_approval(
             $1::uuid,$2::uuid,$3::uuid,$4::text
           ) AS disposition`,
          [context.workspaceId, input.approvalRequestId, input.decisionId, input.decision],
        ), { isolation: 'serializable' });
      const disposition = result.rows[0]?.disposition;
      if (result.rows.length !== 1 || (disposition !== 'approved'
          && disposition !== 'rejected' && disposition !== 'replayed')) {
        throw new Error('Invalid approval decision disposition');
      }
      return Object.freeze({ ok: true, value: disposition });
    } catch (error) { return failure(error); }
  }

  async claim(identity: PortalCrmRequestIdentity, input: Readonly<{
    draftId: string; deliveryId: string; accountId: string;
    providerConversationId: string; idempotencyKey: string; leaseToken: string;
  }>): Promise<ZernioReplyStoreResult<Readonly<{
    disposition: string; body: string | null; bodySha256: string;
  }>>> {
    if (!UUID.test(input.draftId) || !UUID.test(input.deliveryId)
        || !UUID.test(input.leaseToken) || !input.idempotencyKey) {
      return Object.freeze({ ok: false, kind: 'validation' });
    }
    try {
      const context = await this.#context(identity);
      if (!context) return Object.freeze({ ok: false, kind: 'unauthenticated' });
      const result = await withTransaction(this.dependencies.commandPool, context, (client) =>
        client.query<ClaimRow>(
          `/* portal.zernio-messaging.claim-send */
           SELECT * FROM app_private.claim_zernio_reply_send(
             $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::bytea,$6::bytea,$7::bytea,$8::bytea,$9::bytea
           )`,
          [context.workspaceId, this.dependencies.providerConnectionId, input.draftId,
            input.deliveryId, this.#profileHash, sha256(input.accountId),
            sha256(input.providerConversationId), sha256(input.idempotencyKey),
            sha256(input.leaseToken)],
        ), { isolation: 'serializable' });
      const row = result.rows[0];
      if (result.rows.length !== 1 || !row || typeof row.disposition !== 'string'
          || (row.body_text !== null && typeof row.body_text !== 'string')) {
        throw new Error('Invalid reply claim result');
      }
      return Object.freeze({ ok: true, value: Object.freeze({
        disposition: row.disposition, body: row.body_text as string | null,
        bodySha256: hex(row.body_sha256),
      }) });
    } catch (error) { return failure(error); }
  }

  async settle(identity: PortalCrmRequestIdentity, input: Readonly<{
    deliveryId: string; leaseToken: string;
    state: 'accepted' | 'failed' | 'outcome_unknown';
    providerMessageIdSha256: string | null;
    providerResponseSha256: string | null;
    failureCode: string | null;
  }>): Promise<ZernioReplyStoreResult<string>> {
    if (!UUID.test(input.deliveryId) || !UUID.test(input.leaseToken)
        || (input.providerMessageIdSha256 !== null && !HEX.test(input.providerMessageIdSha256))
        || (input.providerResponseSha256 !== null && !HEX.test(input.providerResponseSha256))) {
      return Object.freeze({ ok: false, kind: 'validation' });
    }
    try {
      const context = await this.#context(identity);
      if (!context) return Object.freeze({ ok: false, kind: 'unauthenticated' });
      const result = await withTransaction(this.dependencies.commandPool, context, (client) =>
        client.query<DispositionRow>(
          `/* portal.zernio-messaging.settle-send */
           SELECT app_private.settle_zernio_reply_send(
             $1::uuid,$2::uuid,$3::bytea,$4::text,$5::bytea,$6::bytea,$7::text
           ) AS disposition`,
          [context.workspaceId, input.deliveryId, sha256(input.leaseToken), input.state,
            input.providerMessageIdSha256 ? Buffer.from(input.providerMessageIdSha256, 'hex') : null,
            input.providerResponseSha256 ? Buffer.from(input.providerResponseSha256, 'hex') : null,
            input.failureCode],
        ), { isolation: 'serializable' });
      if (result.rows.length !== 1 || typeof result.rows[0]?.disposition !== 'string') {
        throw new Error('Invalid reply settlement result');
      }
      return Object.freeze({ ok: true, value: result.rows[0].disposition });
    } catch (error) { return failure(error); }
  }
}

export function createPgZernioMessagingReplyStore(input: Readonly<{
  webPool: Pool; commandPool: Pool; workspaceId: string;
  providerConnectionId: string; providerProfileId: string;
}>): PgZernioMessagingReplyStore {
  return new PgZernioMessagingReplyStore({
    principalResolver: createPgPortalCrmPrincipalResolver(input.webPool),
    commandPool: input.commandPool, workspaceId: input.workspaceId,
    providerConnectionId: input.providerConnectionId,
    providerProfileId: input.providerProfileId,
  });
}
