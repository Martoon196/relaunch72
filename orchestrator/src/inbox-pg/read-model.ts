import type { Pool, QueryResultRow } from 'pg';
import type { DatabaseRequestContext } from '../db/rls.js';
import { validateDatabaseContext } from '../db/rls.js';
import { withTransaction } from '../db/transaction.js';
import type { ConversationChannel } from '../providers/contracts.js';
import type {
  InboxConversationCursor,
  InboxConversationPage,
  InboxConversationState,
  InboxConversationSummary,
} from './types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CHANNELS = new Set(['email', 'sms', 'whatsapp', 'instagram', 'facebook']);
const STATES = new Set(['open', 'snoozed', 'closed', 'quarantined']);
const DIRECTIONS = new Set(['inbound', 'outbound', 'internal_note']);
const LIFECYCLES = new Set(['received', 'draft', 'approval_pending', 'approved', 'committed']);

export interface InboxConversationQuery {
  readonly limit?: number;
  readonly channel?: ConversationChannel | null;
  readonly state?: InboxConversationState | null;
  readonly search?: string | null;
  readonly cursor?: InboxConversationCursor | null;
}

export interface InboxReadService {
  listConversations(
    context: DatabaseRequestContext,
    query?: InboxConversationQuery,
  ): Promise<InboxConversationPage>;
}

interface MetaRow extends QueryResultRow {
  workspaceId: string;
  timezone: string;
  canWrite: boolean;
  canManage: boolean;
  asOf: string | Date;
}

interface ConversationRow extends QueryResultRow {
  conversationId: string;
  inboxId: string;
  channel: string;
  environment: string;
  state: string;
  contactId: string | null;
  contactName: string | null;
  assignedUserId: string | null;
  assignedUserName: string | null;
  subject: string | null;
  unreadCount: number | string;
  requiresApproval: boolean;
  lastMessageAt: string | Date | null;
  sortAt: string | Date;
  rowVersion: number | string;
  latestMessageId: string | null;
  latestDirection: string | null;
  latestLifecycle: string | null;
  latestBody: string | null;
  latestOccurredAt: string | Date | null;
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error(`Inbox read ${field} is invalid`);
  return value.toLowerCase();
}

function nullableUuid(value: unknown, field: string): string | null {
  return value === null ? null : uuid(value, field);
}

function timestamp(value: unknown, field: string): string {
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(parsed.getTime())) throw new Error(`Inbox read ${field} is invalid`);
  return parsed.toISOString();
}

function integer(value: unknown, field: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Inbox read ${field} is invalid`);
  }
  return parsed;
}

function mapConversation(row: ConversationRow): InboxConversationSummary {
  if (!CHANNELS.has(row.channel) || !STATES.has(row.state)
      || (row.environment !== 'test' && row.environment !== 'live')
      || (row.subject !== null && (typeof row.subject !== 'string'
        || row.subject.length < 1 || row.subject.length > 500))
      || (row.contactName !== null && (typeof row.contactName !== 'string'
        || row.contactName.length < 1 || row.contactName.length > 200))
      || ((row.assignedUserId === null) !== (row.assignedUserName === null))
      || (row.assignedUserName !== null && (typeof row.assignedUserName !== 'string'
        || row.assignedUserName.length < 1 || row.assignedUserName.length > 320))
      || typeof row.requiresApproval !== 'boolean') {
    throw new Error('Inbox conversation read returned invalid canonical data');
  }
  const hasMessage = row.latestMessageId !== null;
  if (hasMessage !== (row.latestDirection !== null)
      || hasMessage !== (row.latestLifecycle !== null)
      || hasMessage !== (row.latestBody !== null)
      || hasMessage !== (row.latestOccurredAt !== null)) {
    throw new Error('Inbox conversation latest-message shape is invalid');
  }
  let latestMessage: InboxConversationSummary['latestMessage'] = null;
  if (hasMessage) {
    if (!DIRECTIONS.has(row.latestDirection!) || !LIFECYCLES.has(row.latestLifecycle!)
        || typeof row.latestBody !== 'string'
        || Buffer.byteLength(row.latestBody, 'utf8') < 1
        || Buffer.byteLength(row.latestBody, 'utf8') > 65_536) {
      throw new Error('Inbox conversation latest message is invalid');
    }
    latestMessage = Object.freeze({
      messageId: uuid(row.latestMessageId, 'latestMessageId'),
      direction: row.latestDirection as NonNullable<InboxConversationSummary['latestMessage']>['direction'],
      lifecycle: row.latestLifecycle as NonNullable<InboxConversationSummary['latestMessage']>['lifecycle'],
      body: row.latestBody,
      occurredAt: timestamp(row.latestOccurredAt, 'latestOccurredAt'),
    });
  }
  return Object.freeze({
    conversationId: uuid(row.conversationId, 'conversationId'),
    inboxId: uuid(row.inboxId, 'inboxId'),
    channel: row.channel as ConversationChannel,
    environment: row.environment as 'test' | 'live',
    state: row.state as InboxConversationState,
    contactId: nullableUuid(row.contactId, 'contactId'),
    contactName: row.contactName,
    assignedUserId: nullableUuid(row.assignedUserId, 'assignedUserId'),
    assignedUserName: row.assignedUserName,
    subject: row.subject,
    unreadCount: integer(row.unreadCount, 'unreadCount', 0, 1_000_000),
    requiresApproval: row.requiresApproval,
    lastMessageAt: row.lastMessageAt === null ? null : timestamp(row.lastMessageAt, 'lastMessageAt'),
    latestMessage,
    rowVersion: integer(row.rowVersion, 'rowVersion', 1, Number.MAX_SAFE_INTEGER),
  });
}

function normalizeQuery(query: InboxConversationQuery): Required<InboxConversationQuery> {
  const limit = query.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new Error('Inbox conversation limit must be an integer from 1 to 50');
  }
  const channel = query.channel ?? null;
  if (channel !== null && !CHANNELS.has(channel)) throw new Error('Inbox channel filter is invalid');
  const state = query.state ?? null;
  if (state !== null && !STATES.has(state)) throw new Error('Inbox state filter is invalid');
  const search = query.search === undefined || query.search === null || query.search === ''
    ? null : query.search.trim();
  if (search !== null && (search.length < 1 || search.length > 100)) {
    throw new Error('Inbox search must contain 1-100 characters');
  }
  const cursor = query.cursor ?? null;
  if (cursor !== null) {
    if (!cursor || typeof cursor !== 'object'
        || !UUID.test(cursor.beforeConversationId)
        || !Number.isFinite(new Date(cursor.beforeLastMessageAt).getTime())) {
      throw new Error('Inbox conversation cursor is invalid');
    }
  }
  return { limit, channel, state, search, cursor };
}

export class PgInboxReadService implements InboxReadService {
  constructor(private readonly pool: Pick<Pool, 'connect'>) {}

  async listConversations(
    context: DatabaseRequestContext,
    query: InboxConversationQuery = {},
  ): Promise<InboxConversationPage> {
    validateDatabaseContext(context);
    if (context.actorKind !== 'user' || !context.userId) {
      throw new Error('Inbox reads require an authenticated workspace member');
    }
    const input = normalizeQuery(query);
    return withTransaction(this.pool, context, async (transaction) => {
      const meta = await transaction.query<MetaRow>(
        `/* inbox.read-meta */
         SELECT workspace.id AS "workspaceId", workspace.timezone,
                app_private.can_write_workspace(
                  app_private.current_user_id(), workspace.id
                ) AS "canWrite",
                app_private.can_manage_workspace(
                  app_private.current_user_id(), workspace.id
                ) AS "canManage",
                statement_timestamp() AS "asOf"
         FROM app.workspaces AS workspace
         WHERE workspace.id = app_private.current_workspace_id()
           AND workspace.status = 'active'`,
      );
      const metadata = meta.rows[0];
      if (meta.rows.length !== 1 || !metadata
          || typeof metadata.timezone !== 'string' || metadata.timezone.length < 1
          || metadata.timezone.length > 100
          || typeof metadata.canWrite !== 'boolean'
          || typeof metadata.canManage !== 'boolean') {
        throw new Error('Inbox workspace metadata is unavailable or invalid');
      }

      const rows = await transaction.query<ConversationRow>(
        `/* inbox.list-conversations */
         SELECT conversation.id AS "conversationId",
                conversation.inbox_id AS "inboxId", conversation.channel,
                conversation.environment,
                conversation.state, conversation.contact_id AS "contactId",
                contact.display_name AS "contactName", conversation.subject,
                conversation.assigned_user_id AS "assignedUserId",
                coalesce(assigned_user.display_name, assigned_user.email::text)
                  AS "assignedUserName",
                conversation.unread_count AS "unreadCount",
                EXISTS (
                  SELECT 1
                  FROM app.messages AS approval_message
                  JOIN LATERAL (
                    SELECT approval_request.id,
                           approval_decision.id AS approval_decision_id,
                           approval_decision.decision
                    FROM app.message_approval_requests AS approval_request
                    LEFT JOIN app.message_approval_decisions AS approval_decision
                      ON approval_decision.workspace_id = approval_request.workspace_id
                     AND approval_decision.approval_request_id = approval_request.id
                    WHERE approval_request.workspace_id = approval_message.workspace_id
                      AND approval_request.conversation_id = approval_message.conversation_id
                      AND approval_request.message_id = approval_message.id
                      AND approval_request.message_version_id = approval_message.current_version_id
                      AND approval_request.version_number = approval_message.current_version_number
                      AND approval_request.body_sha256 = approval_message.current_body_sha256
                    ORDER BY approval_request.request_number DESC, approval_request.id DESC
                    LIMIT 1
                  ) AS latest_approval ON true
                  WHERE approval_message.workspace_id = conversation.workspace_id
                    AND approval_message.conversation_id = conversation.id
                    AND approval_message.environment = 'test'
                    AND approval_message.direction = 'outbound'
                    AND (
                      (approval_message.lifecycle = 'approval_pending'
                        AND latest_approval.approval_decision_id IS NULL)
                      OR (approval_message.lifecycle = 'draft'
                        AND latest_approval.decision = 'changes_requested')
                    )
                ) AS "requiresApproval",
                conversation.last_message_at AS "lastMessageAt",
                coalesce(conversation.last_message_at, conversation.created_at) AS "sortAt",
                conversation.row_version AS "rowVersion",
                latest.message_id AS "latestMessageId",
                latest.direction AS "latestDirection",
                latest.lifecycle AS "latestLifecycle",
                latest.body_text AS "latestBody",
                latest.occurred_at AS "latestOccurredAt"
         FROM app.conversations AS conversation
         LEFT JOIN app.contacts AS contact
          ON contact.workspace_id = conversation.workspace_id
          AND contact.id = conversation.contact_id
         LEFT JOIN app.users AS assigned_user
           ON assigned_user.id = conversation.assigned_user_id
         LEFT JOIN LATERAL (
           SELECT message.id AS message_id, message.direction, message.lifecycle,
                  version.body_text, message.occurred_at
           FROM app.messages AS message
           JOIN app.message_versions AS version
             ON version.workspace_id = message.workspace_id
            AND version.conversation_id = message.conversation_id
            AND version.message_id = message.id
            AND version.id = message.current_version_id
            AND version.version_number = message.current_version_number
            AND version.body_sha256 = message.current_body_sha256
           WHERE message.workspace_id = conversation.workspace_id
             AND message.conversation_id = conversation.id
           ORDER BY message.occurred_at DESC, message.id DESC
           LIMIT 1
         ) AS latest ON true
         WHERE (
             conversation.environment = 'test'
             OR (
               conversation.environment = 'live'
               AND app_private.operational_inbox_live_conversation_visible(
                 conversation.workspace_id, conversation.id, conversation.channel
               )
             )
           )
           AND ($1::text IS NULL OR conversation.channel = $1)
           AND ($2::text IS NULL OR conversation.state = $2)
           AND ($3::text IS NULL
             OR pg_catalog.strpos(
               pg_catalog.lower(coalesce(contact.display_name, '')),
               pg_catalog.lower($3)
             ) > 0
             OR pg_catalog.strpos(
               pg_catalog.lower(coalesce(conversation.subject, '')),
               pg_catalog.lower($3)
             ) > 0)
           AND ($4::timestamptz IS NULL OR
             (coalesce(conversation.last_message_at, conversation.created_at), conversation.id)
               < ($4::timestamptz, $5::uuid))
         ORDER BY coalesce(conversation.last_message_at, conversation.created_at) DESC,
                  conversation.id DESC
         LIMIT $6`,
        [input.channel, input.state, input.search,
          input.cursor?.beforeLastMessageAt ?? null,
          input.cursor?.beforeConversationId ?? null, input.limit + 1],
      );
      if (rows.rows.length > input.limit + 1) {
        throw new Error('Inbox conversation query exceeded its bound');
      }
      const hasMore = rows.rows.length > input.limit;
      const selectedRows = rows.rows.slice(0, input.limit);
      const conversations = Object.freeze(selectedRows.map(mapConversation));
      const last = selectedRows.at(-1);
      return Object.freeze({
        workspaceId: uuid(metadata.workspaceId, 'workspaceId'),
        canWrite: metadata.canWrite, canManage: metadata.canManage,
        timezone: metadata.timezone, asOf: timestamp(metadata.asOf, 'asOf'),
        conversations,
        nextCursor: hasMore && last ? Object.freeze({
          beforeLastMessageAt: timestamp(last.sortAt, 'sortAt'),
          beforeConversationId: uuid(last.conversationId, 'conversationId'),
        }) : null,
      });
    }, { readOnly: true, isolation: 'repeatable read' });
  }
}

export function createPgInboxReadService(pool: Pick<Pool, 'connect'>): InboxReadService {
  return new PgInboxReadService(pool);
}
