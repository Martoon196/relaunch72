import type { QueryResultRow } from 'pg';
import type { SqlExecutor } from '../crm-pg/types.js';
import type { ConversationChannel } from '../providers/contracts.js';
import type {
  NormalizedConfigureTestInboxCommand,
  NormalizedCreateDraftCommand,
  NormalizedDecideApprovalCommand,
  NormalizedRecordTestInboundCommand,
  NormalizedRequestApprovalCommand,
  NormalizedReviseDraftCommand,
  NormalizedSourceContent,
  NormalizedTestReceiptCommand,
} from './validation.js';

interface ReceiptRow extends QueryResultRow {
  id: string;
  payloadHash: Uint8Array;
  status: 'started' | 'succeeded' | 'failed';
  result: unknown;
}

export interface InboxCommandClaim extends ReceiptRow {
  readonly inserted: boolean;
}

export interface InboxConfigurationRow {
  readonly providerConnectionId: string;
  readonly channelEndpointId: string;
  readonly inboxId: string;
  readonly channel: ConversationChannel;
  readonly environment: 'test';
}

export interface LockedConversationRow {
  readonly conversationId: string;
  readonly providerConnectionId: string;
  readonly channelEndpointId: string;
  readonly channel: ConversationChannel;
  readonly environment: 'test';
  readonly contactId: string;
  readonly contactPointId: string;
}

export interface LockedMessageRow extends LockedConversationRow {
  readonly messageId: string;
  readonly messageVersionId: string;
  readonly versionNumber: number;
  readonly bodySha256: string;
  readonly lifecycle: 'received' | 'draft' | 'approval_pending' | 'approved' | 'committed';
  readonly rowVersion: number;
}

export interface LockedApprovalRow extends LockedMessageRow {
  /** Exact immutable app.message_versions.body_text size measured by PostgreSQL. */
  readonly bodyBytes: number;
  readonly approvalRequestId: string;
  readonly requestNumber: number;
  readonly approvalDecisionId: string | null;
  readonly decision: 'approved' | 'rejected' | 'changes_requested' | null;
}

export interface TestReceiptRow {
  readonly receiptId: string;
  readonly effectiveStatus: 'accepted' | 'delivered' | 'read' | 'failed';
  readonly replayed: boolean;
}

function provenanceValues(source: NormalizedSourceContent | null): readonly unknown[] {
  return source === null
    ? [null, null, null]
    : [source.versionRef, source.sha256, source.approvalRef];
}

function positiveSafeInteger(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${label} is invalid`);
  }
  return parsed;
}

export class InboxPgRepository {
  constructor(private readonly transaction: SqlExecutor) {}

  get executor(): SqlExecutor {
    return this.transaction;
  }

  async claimCommand(input: {
    readonly id: string;
    readonly commandName: string;
    readonly commandKey: string;
    readonly requestId: string;
    readonly payloadHash: Uint8Array;
    readonly createdAt: string;
  }): Promise<InboxCommandClaim> {
    const inserted = await this.transaction.query<ReceiptRow>(
      `/* inbox.claim-command */
       INSERT INTO app.command_receipts (
         id, workspace_id, command_name, idempotency_key, request_id,
         actor_user_id, payload_hash, status, created_at
       ) VALUES (
         $1, app_private.current_workspace_id(), $2, $3, $4,
         app_private.current_user_id(), $5, 'started', $6::timestamptz
       )
       ON CONFLICT (workspace_id, actor_user_id, command_name, idempotency_key)
       DO NOTHING
       RETURNING id, payload_hash AS "payloadHash", status, result`,
      [input.id, input.commandName, input.commandKey, input.requestId,
        input.payloadHash, input.createdAt],
    );
    if (inserted.rows[0]) return { ...inserted.rows[0], inserted: true };
    const existing = await this.transaction.query<ReceiptRow>(
      `/* inbox.read-command-receipt */
       SELECT id, payload_hash AS "payloadHash", status, result
       FROM app.command_receipts
       WHERE actor_user_id = app_private.current_user_id()
         AND command_name = $1 AND idempotency_key = $2`,
      [input.commandName, input.commandKey],
    );
    const row = existing.rows[0];
    if (!row) throw new Error('Inbox command receipt was not visible after conflict');
    return { ...row, inserted: false };
  }

  async completeCommand(input: {
    readonly receiptId: string;
    readonly payloadHash: Uint8Array;
    readonly result: Readonly<Record<string, unknown>>;
    readonly completedAt: string;
  }): Promise<void> {
    const result = await this.transaction.query(
      `/* inbox.complete-command */
       UPDATE app.command_receipts
       SET result = $3::jsonb, status = 'succeeded', response_status = 200,
           completed_at = $4::timestamptz
       WHERE id = $1 AND payload_hash = $2 AND status = 'started'`,
      [input.receiptId, input.payloadHash, JSON.stringify(input.result), input.completedAt],
    );
    if (result.rowCount !== 1) throw new Error('Inbox command receipt did not complete exactly once');
  }

  async configureTestInbox(input: {
    readonly connectionId: string;
    readonly endpointId: string;
    readonly inboxId: string;
    readonly actorUserId: string;
    readonly command: NormalizedConfigureTestInboxCommand;
    readonly at: string;
  }): Promise<InboxConfigurationRow> {
    const providerKind = input.command.channel === 'email' ? 'email'
      : input.command.channel === 'sms' || input.command.channel === 'whatsapp'
        ? 'messaging' : 'social';
    const connection = await this.transaction.query<{ id: string } & QueryResultRow>(
      `/* inbox.ensure-test-connection */
       INSERT INTO app.provider_connections (
         id, workspace_id, provider_id, provider_kind, environment,
         status, display_name, capabilities, created_by_user_id,
         created_at, updated_at
       ) VALUES (
         $1, app_private.current_workspace_id(), 'test_conversation', $2,
         'test', 'active', 'Test conversation provider', $3::jsonb,
         $4, $5::timestamptz, $5::timestamptz
       )
       ON CONFLICT (workspace_id, provider_id, environment)
         WHERE status <> 'disabled'
       DO UPDATE SET row_version = app.provider_connections.row_version + 1
       RETURNING id`,
      [input.connectionId, providerKind,
        JSON.stringify([input.command.channel]), input.actorUserId, input.at],
    );
    const providerConnectionId = connection.rows[0]?.id;
    if (!providerConnectionId) throw new Error('Test provider connection was not configured');

    const endpoint = await this.transaction.query<{ id: string } & QueryResultRow>(
      `/* inbox.ensure-test-channel-endpoint */
       INSERT INTO app.channel_endpoints (
         id, workspace_id, provider_connection_id, channel, environment,
         direction, address, normalized_address, display_name,
         provider_endpoint_ref, status, created_at, updated_at
       ) VALUES (
         $1, app_private.current_workspace_id(), $2, $3, 'test',
         'bidirectional', $4, $4, $5, NULL, 'active',
         $6::timestamptz, $6::timestamptz
       )
       ON CONFLICT (
         workspace_id, provider_connection_id, channel, normalized_address
       ) WHERE status <> 'disabled'
       DO UPDATE SET row_version = app.channel_endpoints.row_version + 1
       RETURNING id`,
      [input.endpointId, providerConnectionId, input.command.channel,
        input.command.endpointAddress, input.command.endpointDisplayName, input.at],
    );
    const channelEndpointId = endpoint.rows[0]?.id;
    if (!channelEndpointId) throw new Error('Test channel endpoint was not configured');

    const inbox = await this.transaction.query<{ id: string } & QueryResultRow>(
      `/* inbox.ensure-test-inbox */
       INSERT INTO app.inboxes (
         id, workspace_id, channel_endpoint_id, provider_connection_id,
         channel, environment, name, status, created_at, updated_at
       ) VALUES (
         $1, app_private.current_workspace_id(), $2, $3,
         $4, 'test', $5, 'active', $6::timestamptz, $6::timestamptz
       )
       ON CONFLICT (workspace_id, channel_endpoint_id)
       DO UPDATE SET row_version = app.inboxes.row_version + 1
       RETURNING id`,
      [input.inboxId, channelEndpointId, providerConnectionId,
        input.command.channel, input.command.name, input.at],
    );
    const inboxId = inbox.rows[0]?.id;
    if (!inboxId) throw new Error('Test inbox was not configured');
    return { providerConnectionId, channelEndpointId, inboxId,
      channel: input.command.channel, environment: 'test' };
  }

  async lockInboundTarget(input: NormalizedRecordTestInboundCommand): Promise<LockedConversationRow | null> {
    const result = await this.transaction.query<LockedConversationRow & QueryResultRow>(
      `/* inbox.lock-inbound-target */
       SELECT conversation.id AS "conversationId",
              inbox.provider_connection_id AS "providerConnectionId",
              inbox.channel_endpoint_id AS "channelEndpointId",
              inbox.channel, inbox.environment, point.contact_id AS "contactId",
              point.id AS "contactPointId"
       FROM app.inboxes AS inbox
       JOIN app.provider_connections AS connection
         ON connection.workspace_id = inbox.workspace_id
        AND connection.id = inbox.provider_connection_id
       JOIN app.contact_points AS point
         ON point.workspace_id = inbox.workspace_id
        AND point.id = $2 AND point.contact_id = $3
        AND point.deleted_at IS NULL AND point.is_verified
        AND point.dedupe_state = 'normal'
        AND point.kind = CASE inbox.channel
          WHEN 'email' THEN 'email' WHEN 'sms' THEN 'phone'
          WHEN 'whatsapp' THEN 'whatsapp' ELSE 'social' END
       LEFT JOIN app.conversations AS conversation
         ON conversation.workspace_id = inbox.workspace_id
        AND conversation.inbox_id = inbox.id
        AND conversation.contact_id = point.contact_id
        AND conversation.state IN ('open', 'snoozed')
       WHERE inbox.id = $1 AND inbox.status = 'active'
         AND inbox.environment = 'test'
         AND connection.provider_id = 'test_conversation'
         AND connection.status = 'active'
       FOR UPDATE OF inbox`,
      [input.inboxId, input.contactPointId, input.contactId],
    );
    return result.rows[0] ?? null;
  }

  async insertConversation(input: {
    readonly id: string;
    readonly inboxId: string;
    readonly channel: ConversationChannel;
    readonly contactId: string;
    readonly firstMessageAt: string;
    readonly at: string;
  }): Promise<void> {
    const result = await this.transaction.query(
      `/* inbox.insert-conversation */
       INSERT INTO app.conversations (
         id, workspace_id, inbox_id, channel, environment, contact_id,
         state, unread_count, last_message_at, created_at, updated_at
       ) VALUES (
         $1, app_private.current_workspace_id(), $2, $3, 'test', $4,
         'open', 0, NULL,
         least($5::timestamptz, $6::timestamptz, statement_timestamp()),
         statement_timestamp()
       )`,
      [input.id, input.inboxId, input.channel, input.contactId,
        input.firstMessageAt, input.at],
    );
    if (result.rowCount !== 1) throw new Error('Conversation was not inserted');
  }

  async lockDraftTarget(
    conversationId: string,
    contactPointId: string,
  ): Promise<LockedConversationRow | null> {
    const result = await this.transaction.query<LockedConversationRow & QueryResultRow>(
      `/* inbox.lock-draft-target */
       SELECT conversation.id AS "conversationId",
              inbox.provider_connection_id AS "providerConnectionId",
              inbox.channel_endpoint_id AS "channelEndpointId",
              conversation.channel, conversation.environment,
              conversation.contact_id AS "contactId", point.id AS "contactPointId"
       FROM app.conversations AS conversation
       JOIN app.inboxes AS inbox
         ON inbox.workspace_id = conversation.workspace_id
        AND inbox.id = conversation.inbox_id
       JOIN app.provider_connections AS connection
         ON connection.workspace_id = inbox.workspace_id
        AND connection.id = inbox.provider_connection_id
       JOIN app.contact_points AS point
         ON point.workspace_id = conversation.workspace_id
        AND point.id = $2 AND point.contact_id = conversation.contact_id
        AND point.deleted_at IS NULL AND point.is_verified
        AND point.dedupe_state = 'normal'
        AND point.kind = CASE conversation.channel
          WHEN 'email' THEN 'email' WHEN 'sms' THEN 'phone'
          WHEN 'whatsapp' THEN 'whatsapp' ELSE 'social' END
       WHERE conversation.id = $1 AND conversation.state = 'open'
         AND conversation.environment = 'test'
         AND connection.provider_id = 'test_conversation'
         AND connection.status = 'active'
       FOR UPDATE OF conversation`,
      [conversationId, contactPointId],
    );
    return result.rows[0] ?? null;
  }

  async insertMessageVersionPair(input: {
    readonly messageId: string;
    readonly versionId: string;
    readonly target: LockedConversationRow;
    readonly direction: 'inbound' | 'outbound';
    readonly lifecycle: 'received' | 'draft';
    readonly sourceKind: 'test_fixture' | 'user';
    readonly body: string;
    readonly bodySha256: string;
    readonly sourceContent: NormalizedSourceContent | null;
    readonly actorUserId: string;
    readonly requestId: string;
    readonly occurredAt: string;
    readonly at: string;
  }): Promise<LockedMessageRow> {
    const common = [input.messageId, input.target.conversationId,
      input.target.contactId, input.target.contactPointId, input.target.channel,
      input.direction, input.lifecycle, input.sourceKind, input.versionId,
      input.bodySha256, input.actorUserId, input.occurredAt, input.at] as const;
    const message = await this.transaction.query(
      `/* inbox.insert-message */
       INSERT INTO app.messages (
         id, workspace_id, conversation_id, contact_id, contact_point_id,
         channel, environment, direction, lifecycle, source_kind,
         current_version_id, current_version_number, current_body_sha256,
         created_by_actor_kind, created_by_user_id, occurred_at,
         created_at, updated_at
       ) VALUES (
         $1, app_private.current_workspace_id(), $2, $3, $4,
         $5, 'test', $6, $7, $8, $9, 1, decode($10, 'hex'),
         'user', $11, $12::timestamptz, $13::timestamptz, $13::timestamptz
       )`,
      common,
    );
    if (message.rowCount !== 1) throw new Error('Message was not inserted');
    const source = provenanceValues(input.sourceContent);
    const version = await this.transaction.query<{ bodySha256: string } & QueryResultRow>(
      `/* inbox.insert-message-version */
       INSERT INTO app.message_versions (
         id, workspace_id, conversation_id, message_id, channel, environment,
         version_number, body_format, body_text,
         source_content_version_ref, source_content_sha256,
         source_content_approval_ref, created_by_actor_kind,
         created_by_user_id, created_request_id, created_at
       ) VALUES (
         $1, app_private.current_workspace_id(), $2, $3, $4, 'test',
         1, 'plain_text', $5, $6,
         CASE WHEN $7::text IS NULL THEN NULL ELSE decode($7, 'hex') END,
         $8, 'user', $9, $10, $11::timestamptz
       ) RETURNING encode(body_sha256, 'hex') AS "bodySha256"`,
      [input.versionId, input.target.conversationId, input.messageId,
        input.target.channel, input.body, ...source, input.actorUserId,
        input.requestId, input.at],
    );
    if (version.rows[0]?.bodySha256 !== input.bodySha256) {
      throw new Error('PostgreSQL message digest did not match canonical UTF-8 bytes');
    }
    return { ...input.target, messageId: input.messageId,
      messageVersionId: input.versionId, versionNumber: 1,
      bodySha256: input.bodySha256, lifecycle: input.lifecycle, rowVersion: 1 };
  }

  async advanceConversationForInbound(
    conversationId: string,
    occurredAt: string,
  ): Promise<void> {
    const result = await this.transaction.query(
      `/* inbox.advance-conversation-inbound */
       UPDATE app.conversations
       SET unread_count = least(1000000, unread_count + 1),
           last_message_at = greatest(coalesce(last_message_at, $2::timestamptz), $2::timestamptz),
           row_version = row_version + 1
       WHERE id = $1`,
      [conversationId, occurredAt],
    );
    if (result.rowCount !== 1) throw new Error('Conversation was not advanced');
  }

  async lockMessage(messageId: string): Promise<LockedMessageRow | null> {
    const result = await this.transaction.query<
      Omit<LockedMessageRow, 'rowVersion'> & { rowVersion: number | string } & QueryResultRow
    >(
      `/* inbox.lock-message */
       SELECT message.conversation_id AS "conversationId",
              inbox.provider_connection_id AS "providerConnectionId",
              inbox.channel_endpoint_id AS "channelEndpointId",
              message.channel, message.environment,
              message.contact_id AS "contactId",
              message.contact_point_id AS "contactPointId",
              message.id AS "messageId", message.current_version_id AS "messageVersionId",
              message.current_version_number AS "versionNumber",
              encode(message.current_body_sha256, 'hex') AS "bodySha256",
              message.lifecycle, message.row_version AS "rowVersion"
       FROM app.messages AS message
       JOIN app.conversations AS conversation
         ON conversation.workspace_id = message.workspace_id
        AND conversation.id = message.conversation_id
       JOIN app.inboxes AS inbox
         ON inbox.workspace_id = conversation.workspace_id
        AND inbox.id = conversation.inbox_id
       WHERE message.id = $1 AND message.direction = 'outbound'
         AND message.environment = 'test'
       FOR UPDATE OF message`,
      [messageId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const rowVersion = positiveSafeInteger(row.rowVersion, 'Locked message row version');
    return { ...row, rowVersion };
  }

  async insertRevision(input: {
    readonly versionId: string;
    readonly message: LockedMessageRow;
    readonly command: NormalizedReviseDraftCommand;
    readonly actorUserId: string;
    readonly requestId: string;
    readonly at: string;
  }): Promise<LockedMessageRow | null> {
    const nextVersion = input.message.versionNumber + 1;
    const source = provenanceValues(input.command.sourceContent);
    const inserted = await this.transaction.query<{ bodySha256: string } & QueryResultRow>(
      `/* inbox.insert-revision */
       INSERT INTO app.message_versions (
         id, workspace_id, conversation_id, message_id, channel, environment,
         version_number, body_format, body_text,
         source_content_version_ref, source_content_sha256,
         source_content_approval_ref, created_by_actor_kind,
         created_by_user_id, created_request_id, created_at
       ) VALUES (
         $1, app_private.current_workspace_id(), $2, $3, $4, 'test',
         $5, 'plain_text', $6, $7,
         CASE WHEN $8::text IS NULL THEN NULL ELSE decode($8, 'hex') END,
         $9, 'user', $10, $11, $12::timestamptz
       ) RETURNING encode(body_sha256, 'hex') AS "bodySha256"`,
      [input.versionId, input.message.conversationId, input.message.messageId,
        input.message.channel, nextVersion, input.command.body,
        ...source, input.actorUserId, input.requestId, input.at],
    );
    if (inserted.rows[0]?.bodySha256 !== input.command.bodySha256) {
      throw new Error('PostgreSQL message digest did not match canonical UTF-8 bytes');
    }
    const updated = await this.transaction.query<{ rowVersion: number | string } & QueryResultRow>(
      `/* inbox.activate-revision */
       UPDATE app.messages
       SET current_version_id = $2, current_version_number = $3,
           current_body_sha256 = decode($4, 'hex'), lifecycle = 'draft',
           row_version = row_version + 1
       WHERE id = $1 AND row_version = $5 AND lifecycle = 'draft'
       RETURNING row_version AS "rowVersion"`,
      [input.message.messageId, input.versionId, nextVersion,
        input.command.bodySha256, input.command.expectedRowVersion],
    );
    const row = updated.rows[0];
    return row ? { ...input.message, messageVersionId: input.versionId,
      versionNumber: nextVersion, bodySha256: input.command.bodySha256,
      lifecycle: 'draft', rowVersion: positiveSafeInteger(row.rowVersion, 'Revised message row version') } : null;
  }

  async nextApprovalRequestNumber(messageId: string, versionId: string): Promise<number> {
    const result = await this.transaction.query<{ next: number | string } & QueryResultRow>(
      `/* inbox.next-approval-request-number */
       SELECT coalesce(max(request_number), 0) + 1 AS next
       FROM app.message_approval_requests
       WHERE message_id = $1 AND message_version_id = $2`,
      [messageId, versionId],
    );
    return positiveSafeInteger(result.rows[0]?.next ?? 1, 'Next approval request number');
  }

  async requestApproval(input: {
    readonly approvalRequestId: string;
    readonly message: LockedMessageRow;
    readonly requestNumber: number;
    readonly command: NormalizedRequestApprovalCommand;
    readonly actorUserId: string;
    readonly requestId: string;
    readonly at: string;
  }): Promise<LockedMessageRow | null> {
    const inserted = await this.transaction.query(
      `/* inbox.insert-approval-request */
       INSERT INTO app.message_approval_requests (
         id, workspace_id, conversation_id, message_id, message_version_id,
         version_number, body_sha256, request_number, review_note,
         requested_by_user_id, requested_request_id, requested_at
       ) VALUES (
         $1, app_private.current_workspace_id(), $2, $3, $4,
         $5, decode($6, 'hex'), $7, $8, $9, $10, $11::timestamptz
       )`,
      [input.approvalRequestId, input.message.conversationId,
        input.message.messageId, input.message.messageVersionId,
        input.message.versionNumber, input.message.bodySha256,
        input.requestNumber, input.command.reviewNote, input.actorUserId,
        input.requestId, input.at],
    );
    if (inserted.rowCount !== 1) throw new Error('Message approval request was not inserted');
    const updated = await this.transaction.query<{ rowVersion: number | string } & QueryResultRow>(
      `/* inbox.mark-approval-pending */
       UPDATE app.messages
       SET lifecycle = 'approval_pending', row_version = row_version + 1
       WHERE id = $1 AND row_version = $2 AND lifecycle = 'draft'
       RETURNING row_version AS "rowVersion"`,
      [input.message.messageId, input.command.expectedRowVersion],
    );
    const row = updated.rows[0];
    return row ? { ...input.message, lifecycle: 'approval_pending',
      rowVersion: positiveSafeInteger(row.rowVersion, 'Approval-pending message row version') } : null;
  }

  async lockApprovalRequest(approvalRequestId: string): Promise<LockedApprovalRow | null> {
    const result = await this.transaction.query<
      Omit<LockedApprovalRow, 'rowVersion' | 'bodyBytes'> & {
        rowVersion: number | string;
        bodyBytes: number | string;
      } & QueryResultRow
    >(
      `/* inbox.lock-approval-request */
       SELECT message.conversation_id AS "conversationId",
              inbox.provider_connection_id AS "providerConnectionId",
              inbox.channel_endpoint_id AS "channelEndpointId",
              message.channel, message.environment,
              message.contact_id AS "contactId",
              message.contact_point_id AS "contactPointId",
              message.id AS "messageId", message.current_version_id AS "messageVersionId",
              message.current_version_number AS "versionNumber",
              encode(message.current_body_sha256, 'hex') AS "bodySha256",
              octet_length(version.body_text) AS "bodyBytes",
              message.lifecycle, message.row_version AS "rowVersion",
              request.id AS "approvalRequestId", request.request_number AS "requestNumber",
              decision.id AS "approvalDecisionId", decision.decision
       FROM app.message_approval_requests AS request
       JOIN app.messages AS message
         ON message.workspace_id = request.workspace_id
        AND message.id = request.message_id
        AND message.current_version_id = request.message_version_id
        AND message.current_body_sha256 = request.body_sha256
       JOIN app.conversations AS conversation
         ON conversation.workspace_id = message.workspace_id
        AND conversation.id = message.conversation_id
       JOIN app.message_versions AS version
         ON version.workspace_id = message.workspace_id
        AND version.conversation_id = message.conversation_id
        AND version.message_id = message.id
        AND version.id = message.current_version_id
        AND version.version_number = message.current_version_number
        AND version.body_sha256 = message.current_body_sha256
       JOIN app.inboxes AS inbox
         ON inbox.workspace_id = conversation.workspace_id
        AND inbox.id = conversation.inbox_id
       LEFT JOIN app.message_approval_decisions AS decision
         ON decision.workspace_id = request.workspace_id
        AND decision.approval_request_id = request.id
       WHERE request.id = $1
       FOR UPDATE OF message`,
      [approvalRequestId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const rowVersion = positiveSafeInteger(row.rowVersion, 'Locked approval row version');
    const bodyBytes = positiveSafeInteger(row.bodyBytes, 'Locked approval body byte length');
    return { ...row, rowVersion, bodyBytes };
  }

  async decideApproval(input: {
    readonly approvalDecisionId: string;
    readonly approval: LockedApprovalRow;
    readonly command: NormalizedDecideApprovalCommand;
    readonly actorUserId: string;
    readonly requestId: string;
    readonly at: string;
  }): Promise<LockedMessageRow> {
    const inserted = await this.transaction.query(
      `/* inbox.insert-approval-decision */
       INSERT INTO app.message_approval_decisions (
         id, workspace_id, conversation_id, message_id, message_version_id,
         approval_request_id, version_number, body_sha256, decision,
         decision_note, decided_by_user_id, decided_request_id, decided_at
       ) VALUES (
         $1, app_private.current_workspace_id(), $2, $3, $4, $5,
         $6, decode($7, 'hex'), $8, $9, $10, $11, $12::timestamptz
       )`,
      [input.approvalDecisionId, input.approval.conversationId,
        input.approval.messageId, input.approval.messageVersionId,
        input.approval.approvalRequestId, input.approval.versionNumber,
        input.approval.bodySha256, input.command.decision,
        input.command.decisionNote, input.actorUserId, input.requestId, input.at],
    );
    if (inserted.rowCount !== 1) throw new Error('Message approval decision was not inserted');
    const lifecycle = input.command.decision === 'approved' ? 'approved' : 'draft';
    const updated = await this.transaction.query<{ rowVersion: number | string } & QueryResultRow>(
      `/* inbox.apply-approval-decision */
       UPDATE app.messages
       SET lifecycle = $2, row_version = row_version + 1
       WHERE id = $1 AND lifecycle = 'approval_pending'
       RETURNING row_version AS "rowVersion"`,
      [input.approval.messageId, lifecycle],
    );
    const row = updated.rows[0];
    if (!row) throw new Error('Message approval decision lost its row lock');
    return { ...input.approval, lifecycle,
      rowVersion: positiveSafeInteger(row.rowVersion, 'Decided message row version') };
  }

  async lockApprovedMessage(messageId: string): Promise<LockedApprovalRow | null> {
    const result = await this.transaction.query<
      Omit<LockedApprovalRow, 'rowVersion' | 'bodyBytes'> & {
        rowVersion: number | string;
        bodyBytes: number | string;
      } & QueryResultRow
    >(
      `/* inbox.lock-approved-message */
       SELECT message.conversation_id AS "conversationId",
              inbox.provider_connection_id AS "providerConnectionId",
              inbox.channel_endpoint_id AS "channelEndpointId",
              message.channel, message.environment,
              message.contact_id AS "contactId",
              message.contact_point_id AS "contactPointId",
              message.id AS "messageId", message.current_version_id AS "messageVersionId",
              message.current_version_number AS "versionNumber",
              encode(message.current_body_sha256, 'hex') AS "bodySha256",
              octet_length(version.body_text) AS "bodyBytes",
              message.lifecycle, message.row_version AS "rowVersion",
              request.id AS "approvalRequestId", request.request_number AS "requestNumber",
              decision.id AS "approvalDecisionId", decision.decision
       FROM app.messages AS message
       JOIN app.conversations AS conversation
         ON conversation.workspace_id = message.workspace_id
        AND conversation.id = message.conversation_id
       JOIN app.inboxes AS inbox
         ON inbox.workspace_id = conversation.workspace_id
        AND inbox.id = conversation.inbox_id
       JOIN app.message_versions AS version
         ON version.workspace_id = message.workspace_id
        AND version.conversation_id = message.conversation_id
        AND version.message_id = message.id
        AND version.id = message.current_version_id
        AND version.version_number = message.current_version_number
        AND version.body_sha256 = message.current_body_sha256
       JOIN LATERAL (
         SELECT request.* FROM app.message_approval_requests AS request
         WHERE request.workspace_id = message.workspace_id
           AND request.message_id = message.id
           AND request.message_version_id = message.current_version_id
           AND request.body_sha256 = message.current_body_sha256
         ORDER BY request.request_number DESC, request.id DESC LIMIT 1
       ) AS request ON true
       JOIN app.message_approval_decisions AS decision
         ON decision.workspace_id = request.workspace_id
        AND decision.approval_request_id = request.id
        AND decision.decision = 'approved'
       WHERE message.id = $1 AND message.lifecycle = 'approved'
         AND message.environment = 'test'
       FOR UPDATE OF message`,
      [messageId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const rowVersion = positiveSafeInteger(
      row.rowVersion,
      'Locked approved message row version',
    );
    const bodyBytes = positiveSafeInteger(
      row.bodyBytes,
      'Locked approved message body byte length',
    );
    return { ...row, rowVersion, bodyBytes };
  }

  async queueApprovedMessage(input: {
    readonly operationId: string;
    readonly deliveryId: string;
    readonly message: LockedApprovalRow;
    readonly purpose: string;
    readonly consentEventId: string;
    readonly actorUserId: string;
    readonly at: string;
  }): Promise<LockedMessageRow | null> {
    if (!input.message.approvalDecisionId || input.message.decision !== 'approved') {
      throw new Error('Approved message lock lacked its exact approval decision');
    }
    const operationKey = `conversation.send:${input.message.messageId}:${input.message.messageVersionId}`;
    const operation = await this.transaction.query(
      `/* inbox.insert-provider-operation */
       INSERT INTO app.provider_operations (
         id, workspace_id, provider_connection_id, operation_kind,
         message_delivery_id, environment, state, idempotency_key, correlation_id,
         created_by_actor_kind, created_by_user_id, created_at, updated_at
       ) VALUES (
         $1, app_private.current_workspace_id(), $2, 'conversation.send',
         $3, 'test', 'queued', $4, $5, 'user', $6,
         least($7::timestamptz, statement_timestamp()),
         statement_timestamp()
       )`,
      [input.operationId, input.message.providerConnectionId, input.deliveryId,
        operationKey, input.operationId, input.actorUserId, input.at],
    );
    if (operation.rowCount !== 1) throw new Error('Provider operation was not inserted');
    const consentChannel = input.message.channel === 'instagram'
      || input.message.channel === 'facebook' ? 'social' : input.message.channel;
    const delivery = await this.transaction.query(
      `/* inbox.insert-message-delivery */
       INSERT INTO app.message_deliveries (
         id, workspace_id, conversation_id, message_id, message_version_id,
         version_number, body_sha256, approval_request_id,
         approval_decision_id, approval_decision, provider_operation_id,
         provider_connection_id, channel_endpoint_id, contact_id,
         contact_point_id, conversation_channel, consent_channel, purpose,
         consent_event_id, endpoint_identity_sha256, environment,
         status, idempotency_key, created_by_user_id, queued_at, updated_at
       ) VALUES (
         $1, app_private.current_workspace_id(), $2, $3, $4, $5,
         decode($6, 'hex'), $7, $8, 'approved', $9, $10, $11, $12,
         $13, $14, $15, $16, $17, NULL, 'test', 'queued', $18, $19,
         least($20::timestamptz, statement_timestamp()),
         statement_timestamp()
       )`,
      [input.deliveryId, input.message.conversationId, input.message.messageId,
        input.message.messageVersionId, input.message.versionNumber,
        input.message.bodySha256, input.message.approvalRequestId,
        input.message.approvalDecisionId, input.operationId,
        input.message.providerConnectionId, input.message.channelEndpointId,
        input.message.contactId, input.message.contactPointId, input.message.channel,
        consentChannel, input.purpose, input.consentEventId, operationKey,
        input.actorUserId, input.at],
    );
    if (delivery.rowCount !== 1) throw new Error('Message delivery was not inserted');
    const updated = await this.transaction.query<{ rowVersion: number | string } & QueryResultRow>(
      `/* inbox.commit-approved-message */
       UPDATE app.messages
       SET lifecycle = 'committed', row_version = row_version + 1
       WHERE id = $1 AND row_version = $2 AND lifecycle = 'approved'
       RETURNING row_version AS "rowVersion"`,
      [input.message.messageId, input.message.rowVersion],
    );
    const row = updated.rows[0];
    return row ? { ...input.message, lifecycle: 'committed',
      rowVersion: positiveSafeInteger(row.rowVersion, 'Committed message row version') } : null;
  }

  async recordTestReceipt(
    workspaceId: string,
    command: NormalizedTestReceiptCommand,
  ): Promise<TestReceiptRow> {
    const result = await this.transaction.query<TestReceiptRow & QueryResultRow>(
      `/* inbox.record-test-receipt */
       SELECT receipt_id AS "receiptId", effective_status AS "effectiveStatus",
              replayed
       FROM app_private.record_test_provider_delivery_receipt(
         $1, $2, $3, $4, decode($5, 'hex'), $6, $7, $8::timestamptz
       )`,
      [workspaceId, command.providerOperationId, command.messageDeliveryId,
        command.externalEventId, command.payloadSha256,
        command.deliveryStatus, command.errorCode, command.occurredAt],
    );
    const row = result.rows[0];
    if (result.rows.length !== 1 || !row) throw new Error('Test receipt was not recorded');
    return row;
  }
}
