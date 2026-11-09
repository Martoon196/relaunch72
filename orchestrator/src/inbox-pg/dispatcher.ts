import { createHash } from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';
import type { DatabaseRequestContext } from '../db/rls.js';
import { workerDatabaseContext } from '../db/rls.js';
import { withTransaction } from '../db/transaction.js';
import {
  createProviderOperationContext,
  type ConversationProvider,
} from '../providers/contracts.js';
import type {
  ProviderOperationClaim,
  ProviderOperationLeaseIdentity,
  ProviderOperationQueue,
} from '../provider-operations-pg/types.js';
import { ProviderOperationConsentChangedError } from '../provider-operations-pg/types.js';
import type { InboxConsentChannel, InboxDispatchPayload } from './types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const CHANNELS = new Set(['email', 'sms', 'whatsapp', 'instagram', 'facebook']);
const CONSENT_CHANNELS = new Set(['email', 'sms', 'whatsapp', 'social']);

interface DispatchRow extends QueryResultRow {
  workspaceId: string;
  providerConnectionId: string;
  providerId: string;
  environment: string;
  conversationId: string;
  messageId: string;
  messageVersionId: string;
  body: string;
  bodySha256: string;
  contactPointId: string;
  recipient: string;
  channel: string;
  consentChannel: string;
  purpose: string;
  consentEventId: string | null;
  eligibilityStatus: string;
  eligibilityReason: string;
}

export interface InboxDispatchEligibility {
  readonly status: 'allowed' | 'blocked' | 'unknown';
  readonly reason: string;
  readonly payload: InboxDispatchPayload | null;
}

export interface InboxDispatchReader {
  loadAndEvaluate(
    context: DatabaseRequestContext,
    claim: ProviderOperationClaim,
    lease: ProviderOperationLeaseIdentity,
  ): Promise<InboxDispatchEligibility>;
}

export interface InboxDispatchCycleResult {
  readonly disposition: 'idle' | 'cancelled' | 'settled';
  readonly operationId: string | null;
  readonly operationState: string | null;
  readonly deliveryStatus: string | null;
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error(`Dispatch ${field} is invalid`);
  return value.toLowerCase();
}

function dispatchPayload(row: DispatchRow, currentConsentEventId: string): InboxDispatchPayload {
  if (row.environment !== 'test' || row.providerId !== 'test_conversation'
      || !CHANNELS.has(row.channel) || !CONSENT_CHANNELS.has(row.consentChannel)
      || typeof row.body !== 'string' || Buffer.byteLength(row.body, 'utf8') < 1
      || Buffer.byteLength(row.body, 'utf8') > 65_536
      || typeof row.recipient !== 'string' || row.recipient.length < 1 || row.recipient.length > 500
      || typeof row.purpose !== 'string' || !/^[a-z][a-z0-9_.-]{0,99}$/.test(row.purpose)
      || typeof row.bodySha256 !== 'string' || !SHA256.test(row.bodySha256)
      || createHash('sha256').update(row.body, 'utf8').digest('hex') !== row.bodySha256) {
    throw new Error('Dispatch payload returned invalid canonical data');
  }
  return Object.freeze({
    connection: Object.freeze({
      id: uuid(row.providerConnectionId, 'providerConnectionId'),
      workspaceId: uuid(row.workspaceId, 'workspaceId'), providerId: row.providerId,
    }),
    environment: 'test', conversationId: uuid(row.conversationId, 'conversationId'),
    messageId: uuid(row.messageId, 'messageId'),
    messageVersionId: uuid(row.messageVersionId, 'messageVersionId'),
    contactPointId: uuid(row.contactPointId, 'contactPointId'),
    consentChannel: row.consentChannel as InboxConsentChannel,
    purpose: row.purpose, consentEventId: uuid(currentConsentEventId, 'consentEventId'),
    request: Object.freeze({
      channel: row.channel as InboxDispatchPayload['request']['channel'],
      recipient: row.recipient, text: row.body, templateId: null,
      consentRecordId: uuid(currentConsentEventId, 'consentEventId'),
    }),
  });
}

export class PgInboxDispatchReader implements InboxDispatchReader {
  constructor(private readonly pool: Pick<Pool, 'connect'>) {}

  async loadAndEvaluate(
    context: DatabaseRequestContext,
    claim: ProviderOperationClaim,
    lease: ProviderOperationLeaseIdentity,
  ): Promise<InboxDispatchEligibility> {
    if (context.actorKind !== 'worker' || context.workspaceId !== claim.workspaceId) {
      throw new Error('Dispatch read requires the claimed worker workspace context');
    }
    const leaseToken = Buffer.from(lease.leaseToken);
    if (uuid(lease.workerId, 'workerId') !== lease.workerId.toLowerCase()
        || leaseToken.length !== 32) {
      throw new Error('Dispatch read requires a canonical worker and 32-byte lease token');
    }
    const leaseTokenHash = createHash('sha256').update(leaseToken).digest();
    return withTransaction(this.pool, context, async (transaction) => {
      const result = await transaction.query<DispatchRow>(
        `/* inbox.load-dispatch-payload */
         SELECT workspace_id AS "workspaceId",
                provider_connection_id AS "providerConnectionId",
                provider_id AS "providerId", environment,
                conversation_id AS "conversationId",
                message_id AS "messageId",
                message_version_id AS "messageVersionId",
                body, body_sha256 AS "bodySha256",
                contact_point_id AS "contactPointId", recipient, channel,
                consent_channel AS "consentChannel", purpose,
                consent_event_id AS "consentEventId",
                eligibility_status AS "eligibilityStatus",
                eligibility_reason AS "eligibilityReason"
         FROM app_private.load_test_provider_dispatch_payload(
           $1, $2, $3, $4, $5, $6
         )`,
        [claim.workspaceId, claim.operationId, claim.messageDeliveryId,
          lease.workerId, leaseTokenHash, claim.leaseVersion],
      );
      const row = result.rows[0];
      if (result.rows.length !== 1 || !row) {
        return Object.freeze({ status: 'blocked', reason: 'dispatch_target_unavailable', payload: null });
      }
      if (!['allowed', 'blocked', 'unknown'].includes(row.eligibilityStatus)
          || typeof row.eligibilityReason !== 'string'
          || !/^[a-z][a-z0-9_.:-]{0,99}$/.test(row.eligibilityReason)) {
        throw new Error('Dispatch eligibility returned invalid canonical data');
      }
      if (row.eligibilityStatus !== 'allowed' || row.consentEventId === null) {
        return Object.freeze({
          status: row.eligibilityStatus as 'blocked' | 'unknown',
          reason: row.eligibilityReason,
          payload: null,
        });
      }
      return Object.freeze({
        status: 'allowed', reason: row.eligibilityReason,
        payload: dispatchPayload(row, row.consentEventId),
      });
    }, { readOnly: true, isolation: 'repeatable read' });
  }
}

export class InboxProviderDispatcher {
  readonly #now: () => Date;

  constructor(private readonly dependencies: Readonly<{
    queue: ProviderOperationQueue;
    reader: InboxDispatchReader;
    provider: ConversationProvider;
    now?: () => Date;
  }>) {
    this.#now = dependencies.now ?? (() => new Date());
  }

  async runOnce(lease: ProviderOperationLeaseIdentity): Promise<InboxDispatchCycleResult> {
    const claims = await this.dependencies.queue.claim(lease, { batchSize: 1 });
    const claim = claims[0];
    if (!claim) return Object.freeze({ disposition: 'idle', operationId: null,
      operationState: null, deliveryStatus: null });
    const workerContext = workerDatabaseContext({
      workspaceId: claim.workspaceId,
      requestId: `provider-operation:${claim.operationId}`,
    });
    let payload: InboxDispatchPayload | null = null;
    if (claim.attemptKind === 'dispatch') {
      const eligibility = await this.dependencies.reader.loadAndEvaluate(workerContext, claim, lease);
      if (eligibility.status !== 'allowed' || !eligibility.payload) {
        const suffix = eligibility.reason.toLowerCase().replace(/[^a-z0-9_.:-]+/g, '_').slice(0, 70);
        await this.dependencies.queue.cancelBeforeCall(claim, lease, {
          errorCode: `consent_${suffix || 'blocked'}`,
          safeSummary: 'Current consent evidence does not permit this test delivery',
        });
        return Object.freeze({ disposition: 'cancelled', operationId: claim.operationId,
          operationState: 'cancelled', deliveryStatus: 'cancelled' });
      }
      payload = eligibility.payload;
    }
    const providerContext = createProviderOperationContext({
      connection: payload?.connection ?? Object.freeze({
        id: claim.providerConnectionId,
        workspaceId: claim.workspaceId,
        providerId: 'test_conversation',
      }),
      operationId: claim.operationId,
      idempotencyKey: claim.idempotencyKey, correlationId: claim.correlationId,
    });
    try {
      // Committing `calling` is the irreversible provider boundary. A crash or
      // withdrawal after this point is reconciled as an ambiguous external
      // outcome; it must never be silently cancelled or retried as unsent.
      await this.dependencies.queue.markCalling(claim, lease);
    } catch (error) {
      if (!(error instanceof ProviderOperationConsentChangedError)) throw error;
      await this.dependencies.queue.cancelBeforeCall(claim, lease, {
        errorCode: 'consent_changed_before_call',
        safeSummary: 'Consent changed before the provider boundary was crossed',
      });
      return Object.freeze({ disposition: 'cancelled', operationId: claim.operationId,
        operationState: 'cancelled', deliveryStatus: 'cancelled' });
    }
    let providerResult;
    try {
      providerResult = claim.attemptKind === 'dispatch'
        ? await this.dependencies.provider.sendMessage(providerContext, payload!.request)
        : await this.dependencies.provider.reconcile(providerContext, claim.providerReference!);
    } catch {
      providerResult = Object.freeze({
        status: 'needs_attention' as const,
        externalId: claim.providerReference,
        occurredAt: this.#now().toISOString(), retryable: false,
        errorCode: 'ambiguous_provider_exception',
        summary: 'Provider call outcome could not be determined',
      });
    }
    const settlement = await this.dependencies.queue.settle(claim, lease, providerResult);
    return Object.freeze({ disposition: 'settled', operationId: claim.operationId,
      operationState: settlement.operationState,
      deliveryStatus: settlement.deliveryStatus });
  }
}

export function createPgInboxProviderDispatcher(input: Readonly<{
  queue: ProviderOperationQueue;
  workerPool: Pick<Pool, 'connect'>;
  provider: ConversationProvider;
}>): InboxProviderDispatcher {
  return new InboxProviderDispatcher({
    queue: input.queue,
    reader: new PgInboxDispatchReader(input.workerPool),
    provider: input.provider,
  });
}
