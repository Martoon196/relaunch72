import { createHash } from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';
import type { DatabaseRequestContext } from '../db/rls.js';
import { requestDatabaseContext } from '../db/rls.js';
import { InactivePortalSessionError, withTransaction } from '../db/transaction.js';
import type { PortalCrmRequestIdentity } from './crm-service.js';
import {
  createPgPortalCrmPrincipalResolver,
  type PortalCrmPrincipal,
  type PortalCrmPrincipalResolver,
} from './crm-pg-service.js';

export const OPERATOR_ACTION_DATABASE_DEFAULT_LIMIT = 60;
export const OPERATOR_ACTION_DATABASE_MAX_LIMIT = 100;
export const OPERATOR_ACTION_HIGH_SCORE = 70;
export const OPERATOR_ACTION_STALL_HOURS = 48;

export type PgOperatorActionEnvironment = 'test' | 'production';
export type PgOperatorActionSource =
  | 'journey' | 'inbox' | 'content' | 'webinar' | 'automation' | 'provider' | 'crm';
export type PgOperatorActionPriority = 'p0' | 'p1' | 'p2' | 'p3';
export type PgOperatorActionStatus = 'open' | 'waiting' | 'blocked';

export type PgOperatorActionKind =
  | 'crm.task'
  | 'journey.attention'
  | 'content.approval'
  | 'content.changes_requested'
  | 'inbox.approval'
  | 'inbox.draft'
  | 'provider.test_operation'
  | 'provider.readiness';

export interface PgOperatorActionSnapshot {
  readonly actionId: string;
  readonly actionKind: PgOperatorActionKind;
  readonly sourceReference: string;
  readonly source: PgOperatorActionSource;
  readonly priority: PgOperatorActionPriority;
  readonly status: PgOperatorActionStatus;
  readonly title: string;
  readonly detail: string;
  readonly ownerLabel: string | null;
  readonly ownerTeam: string;
  readonly assignedUserId: string | null;
  readonly assignmentOverridden: boolean;
  readonly relatedPersonLabel: string | null;
  readonly signalLabel: string;
  readonly createdAt: string;
  readonly dueAt: string | null;
  readonly blockedBy: string | null;
  readonly deepLink: string;
  readonly deepLinkLabel: string;
  readonly evidence: Readonly<{
    label: string;
    detail: string;
    truth: 'measured';
    evidenceRef: string;
    observedAt: string;
  }>;
  /** Version of the assignment/snooze overlay; null means no overlay exists. */
  readonly rowVersion: number | null;
  readonly sourceRowVersion: number;
  readonly snoozedUntil: string | null;
  readonly canSnooze: boolean;
  /** Any writer may claim/release their own action; managers get the full member list. */
  readonly canAssign: boolean;
}

export interface PgOperatorAssignableMember {
  readonly userId: string;
  readonly displayName: string;
  readonly role: 'owner' | 'admin' | 'marketer' | 'sales';
}

export interface PgOperatorActionCentreSnapshot {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly asOf: string;
  readonly environment: PgOperatorActionEnvironment;
  readonly datasetKind: 'postgres_authoritative';
  readonly currentUserId: string;
  readonly canWrite: boolean;
  readonly canManage: boolean;
  readonly canAssign: boolean;
  readonly commandBoundaryAvailable: boolean;
  readonly assignableMembers: readonly PgOperatorAssignableMember[];
  readonly membersTruncated: boolean;
  readonly inputTruncated: boolean;
  readonly actions: readonly PgOperatorActionSnapshot[];
}

export interface PgOperatorActionCentreReadOptions {
  readonly limit?: number;
  /** Command replay lookup only; the normal operator queue never shows an active snooze. */
  readonly includeSnoozed?: boolean;
  /** Server-owned exact lookup used only to re-resolve one submitted action. */
  readonly actionId?: string;
}

export interface PgOperatorActionCentreReadService {
  load(
    context: DatabaseRequestContext,
    options?: PgOperatorActionCentreReadOptions,
  ): Promise<PgOperatorActionCentreSnapshot>;
}

interface WorkspaceRow extends QueryResultRow {
  workspaceId: string;
  workspaceName: string;
  snapshotAt: string | Date;
  role: string;
  canWrite: boolean;
  canAssign: boolean;
}

interface MemberRow extends QueryResultRow {
  userId: string;
  displayName: string;
  role: string;
}

interface CandidateRow extends QueryResultRow {
  actionId: string;
  actionKind: string;
  sourceReference: string;
  source: string;
  priority: string;
  status: string;
  title: string;
  detail: string;
  sourceOwnerUserId: string | null;
  sourceOwnerLabel: string | null;
  ownerTeam: string;
  relatedPersonLabel: string | null;
  signalLabel: string;
  createdAt: string | Date;
  dueAt: string | Date | null;
  blockedBy: string | null;
  destinationId: string | null;
  destinationChannel: string | null;
  destinationQuery: string | null;
  evidenceLabel: string;
  evidenceDetail: string;
  evidenceRef: string;
  observedAt: string | Date;
  sourceRowVersion: number | string;
}

interface ControlRow extends QueryResultRow {
  actionId: string;
  sourceKind: string;
  sourceReference: string;
  assignmentOverridden: boolean;
  assignedUserId: string | null;
  snoozedUntil: string | Date | null;
  rowVersion: number | string;
}

const WORKSPACE_SQL = `/* portal.operator-actions.workspace */
SELECT workspace.id AS "workspaceId", workspace.name AS "workspaceName",
       transaction_timestamp() AS "snapshotAt", membership.role,
       membership.role IN ('owner', 'admin', 'marketer', 'sales') AS "canWrite",
       membership.role IN ('owner', 'admin') AS "canAssign"
FROM app.workspaces AS workspace
JOIN app.workspace_memberships AS membership
  ON membership.workspace_id = workspace.id
 AND membership.user_id = app_private.current_user_id()
 AND membership.status = 'active'
WHERE workspace.id = app_private.current_workspace_id()
  AND workspace.status = 'active'`;

const ASSIGNABLE_MEMBERS_SQL = `/* portal.operator-actions.assignable-members */
SELECT member.user_id AS "userId",
       member.display_name AS "displayName",
       member.role
FROM app_private.list_operator_action_assignable_members($1) AS member`;

const CRM_ACTIONS_SQL = `/* portal.operator-actions.crm */
SELECT 'crm.task:' || task.id::text AS "actionId",
       'crm.task' AS "actionKind",
       'app.tasks:' || task.id::text AS "sourceReference",
       'crm' AS source,
       CASE task.priority WHEN 'urgent' THEN 'p0' WHEN 'high' THEN 'p1'
         WHEN 'normal' THEN 'p2' ELSE 'p3' END AS priority,
       'open' AS status,
       task.title,
       coalesce(task.description,
         CASE WHEN task.due_at IS NOT NULL THEN 'Open CRM work with a recorded due time.'
              ELSE 'Open CRM work without a recorded due time.' END) AS detail,
       task.assignee_user_id AS "sourceOwnerUserId",
       NULL::text AS "sourceOwnerLabel",
       'CRM operations' AS "ownerTeam",
       contact.display_name AS "relatedPersonLabel",
       CASE WHEN task.due_at < transaction_timestamp() THEN 'Open CRM task · overdue'
            WHEN task.due_at IS NOT NULL THEN 'Open CRM task · due time recorded'
            ELSE 'Open CRM task · no due time recorded' END AS "signalLabel",
       task.created_at AS "createdAt", task.due_at AS "dueAt", NULL::text AS "blockedBy",
       task.id::text AS "destinationId", NULL::text AS "destinationChannel",
       contact.display_name AS "destinationQuery",
       'CRM task ledger' AS "evidenceLabel",
       'Open status, priority, owner and due time come from the workspace CRM task row.' AS "evidenceDetail",
       'postgres:app.tasks:' || task.id::text || ':v' || task.row_version::text AS "evidenceRef",
       task.updated_at AS "observedAt", task.row_version AS "sourceRowVersion"
FROM app.tasks AS task
LEFT JOIN app.contacts AS contact
  ON contact.workspace_id = task.workspace_id AND contact.id = task.contact_id
WHERE task.workspace_id = app_private.current_workspace_id()
  AND task.status = 'open'`;

const JOURNEY_ACTIONS_SQL = `/* portal.operator-actions.journey */
SELECT 'journey.attention:' || enrollment.id::text AS "actionId",
       'journey.attention' AS "actionKind",
       'app.conversion_enrollments:' || enrollment.id::text AS "sourceReference",
       'journey' AS source,
       CASE WHEN score.total_score >= 85 THEN 'p0'
            WHEN coalesce(enrollment.last_event_at, enrollment.enrolled_at)
                   < transaction_timestamp() - interval '${OPERATOR_ACTION_STALL_HOURS} hours' THEN 'p1'
            WHEN score.total_score >= ${OPERATOR_ACTION_HIGH_SCORE} THEN 'p1' ELSE 'p2' END AS priority,
       CASE WHEN coalesce(enrollment.last_event_at, enrollment.enrolled_at)
                    < transaction_timestamp() - interval '${OPERATOR_ACTION_STALL_HOURS} hours'
            THEN 'blocked' ELSE 'open' END AS status,
       'Choose the next move for ' || contact.display_name AS title,
       journey.name || ' is active, but no open CRM task is linked to this lead.' AS detail,
       contact.owner_user_id AS "sourceOwnerUserId",
       NULL::text AS "sourceOwnerLabel",
       'Conversion desk' AS "ownerTeam",
       contact.display_name AS "relatedPersonLabel",
       CASE WHEN score.total_score IS NOT NULL
         THEN 'Score ' || score.total_score::text || '/100 · ' || score.band_key
         ELSE 'No current score · active journey' END AS "signalLabel",
       enrollment.created_at AS "createdAt",
       CASE WHEN coalesce(enrollment.last_event_at, enrollment.enrolled_at)
                    < transaction_timestamp() - interval '${OPERATOR_ACTION_STALL_HOURS} hours'
            THEN coalesce(enrollment.last_event_at, enrollment.enrolled_at)
                   + interval '${OPERATOR_ACTION_STALL_HOURS} hours'
            ELSE NULL END AS "dueAt",
       'No open CRM task is linked to this active journey enrollment.' AS "blockedBy",
       enrollment.id::text AS "destinationId", NULL::text AS "destinationChannel",
       contact.display_name AS "destinationQuery",
       'Journey enrollment and score ledger' AS "evidenceLabel",
       'Active enrollment, last event, latest score and absence of open CRM work are database-derived.' AS "evidenceDetail",
       'postgres:app.conversion_enrollments:' || enrollment.id::text || ':v'
         || enrollment.row_version::text AS "evidenceRef",
       greatest(enrollment.updated_at, coalesce(score.evaluated_at, enrollment.updated_at)) AS "observedAt",
       enrollment.row_version AS "sourceRowVersion"
FROM app.conversion_enrollments AS enrollment
JOIN app.contacts AS contact
  ON contact.workspace_id = enrollment.workspace_id
 AND contact.id = enrollment.contact_id
 AND contact.deleted_at IS NULL
JOIN app.conversion_journeys AS journey
  ON journey.workspace_id = enrollment.workspace_id
 AND journey.id = enrollment.journey_id
LEFT JOIN LATERAL (
  SELECT snapshot.total_score, snapshot.band_key, snapshot.evaluated_at
  FROM app.lead_score_snapshots AS snapshot
  WHERE snapshot.workspace_id = enrollment.workspace_id
    AND snapshot.enrollment_id = enrollment.id
  ORDER BY snapshot.evaluated_at DESC, snapshot.id DESC
  LIMIT 1
) AS score ON true
WHERE enrollment.workspace_id = app_private.current_workspace_id()
  AND enrollment.status = 'active'
  AND NOT EXISTS (
    SELECT 1 FROM app.tasks AS next_task
    WHERE next_task.workspace_id = enrollment.workspace_id
      AND next_task.contact_id = enrollment.contact_id
      AND next_task.status = 'open'
  )
  AND (score.total_score >= ${OPERATOR_ACTION_HIGH_SCORE}
       OR coalesce(enrollment.last_event_at, enrollment.enrolled_at)
            < transaction_timestamp() - interval '${OPERATOR_ACTION_STALL_HOURS} hours')`;

const CONTENT_ACTIONS_SQL = `/* portal.operator-actions.content */
WITH latest_version AS (
  SELECT DISTINCT ON (version.content_item_id)
         version.workspace_id, version.content_item_id, version.id,
         version.version_number, version.title, version.content_kind,
         version.content_sha256, version.created_by_user_id,
         version.created_at
  FROM app.company_content_versions AS version
  WHERE version.workspace_id = app_private.current_workspace_id()
  ORDER BY version.content_item_id, version.version_number DESC, version.id DESC
), latest_request AS (
  SELECT version.*, request.id AS request_id, request.request_number,
         request.review_note, request.requested_by_user_id, request.requested_at,
         decision.id AS decision_id, decision.decision, decision.decision_note,
         decision.decided_at
  FROM latest_version AS version
  JOIN LATERAL (
    SELECT candidate.*
    FROM app.company_content_approval_requests AS candidate
    WHERE candidate.workspace_id = version.workspace_id
      AND candidate.content_item_id = version.content_item_id
      AND candidate.content_version_id = version.id
      AND candidate.content_sha256 = version.content_sha256
    ORDER BY candidate.request_number DESC, candidate.id DESC
    LIMIT 1
  ) AS request ON true
  LEFT JOIN app.company_content_approval_decisions AS decision
    ON decision.workspace_id = request.workspace_id
   AND decision.approval_request_id = request.id
)
SELECT 'content.review:' || request.request_id::text AS "actionId",
       CASE WHEN request.decision = 'changes_requested'
            THEN 'content.changes_requested' ELSE 'content.approval' END AS "actionKind",
       'app.company_content_approval_requests:' || request.request_id::text AS "sourceReference",
       'content' AS source,
       CASE WHEN request.decision = 'changes_requested' THEN 'p1'
            WHEN request.requested_at < transaction_timestamp() - interval '24 hours' THEN 'p1'
            ELSE 'p2' END AS priority,
       CASE WHEN request.decision = 'changes_requested' THEN 'blocked' ELSE 'waiting' END AS status,
       CASE WHEN request.decision = 'changes_requested' THEN 'Apply requested changes to '
            ELSE 'Review ' END || request.title AS title,
       CASE WHEN request.decision = 'changes_requested'
            THEN coalesce(request.decision_note, 'A reviewer requested a new immutable version.')
            ELSE coalesce(request.review_note, 'An exact immutable version is waiting for a decision.') END AS detail,
       request.requested_by_user_id AS "sourceOwnerUserId",
       NULL::text AS "sourceOwnerLabel",
       'Content desk' AS "ownerTeam", NULL::text AS "relatedPersonLabel",
       CASE WHEN request.decision = 'changes_requested'
            THEN 'Changes requested · version ' || request.version_number::text
            ELSE 'Approval waiting · version ' || request.version_number::text END AS "signalLabel",
       request.requested_at AS "createdAt", NULL::timestamptz AS "dueAt",
       CASE WHEN request.decision = 'changes_requested'
            THEN coalesce(request.decision_note, 'Requested changes remain unresolved.')
            ELSE NULL END AS "blockedBy",
       request.content_item_id::text AS "destinationId", request.content_kind AS "destinationChannel",
       request.title AS "destinationQuery",
       'Company content approval ledger' AS "evidenceLabel",
       'The action binds one current immutable version, exact content hash and latest approval request.' AS "evidenceDetail",
       'postgres:app.company_content_approval_requests:' || request.request_id::text
         || ':sha256:' || encode(request.content_sha256, 'hex') AS "evidenceRef",
       coalesce(request.decided_at, request.requested_at) AS "observedAt",
       request.request_number::bigint AS "sourceRowVersion"
FROM latest_request AS request
WHERE request.decision_id IS NULL OR request.decision = 'changes_requested'`;

const INBOX_ACTIONS_SQL = `/* portal.operator-actions.inbox */
SELECT 'inbox.message:' || message.id::text AS "actionId",
       CASE WHEN message.lifecycle = 'approval_pending' AND approval.decision_id IS NULL
            THEN 'inbox.approval' ELSE 'inbox.draft' END AS "actionKind",
       'app.messages:' || message.id::text AS "sourceReference",
       'inbox' AS source,
       CASE WHEN message.lifecycle = 'approval_pending'
                  AND message.updated_at < transaction_timestamp() - interval '4 hours' THEN 'p1'
            ELSE 'p2' END AS priority,
       CASE WHEN message.lifecycle = 'approval_pending' AND approval.decision_id IS NULL
            THEN 'waiting' ELSE 'open' END AS status,
       CASE WHEN message.lifecycle = 'approval_pending' AND approval.decision_id IS NULL
            THEN 'Decide the ' || message.channel || ' reply for '
            ELSE 'Finish the ' || message.channel || ' draft for ' END
         || contact.display_name AS title,
       CASE WHEN approval.decision = 'changes_requested'
            THEN coalesce(approval.decision_note, 'The exact draft needs recorded changes.')
            WHEN message.lifecycle = 'approval_pending'
            THEN 'The exact current version is waiting for an approval decision.'
            ELSE 'The current outbound version remains a draft and cannot dispatch.' END AS detail,
       conversation.assigned_user_id AS "sourceOwnerUserId",
       NULL::text AS "sourceOwnerLabel",
       'Conversion desk' AS "ownerTeam", contact.display_name AS "relatedPersonLabel",
       CASE WHEN message.lifecycle = 'approval_pending' AND approval.decision_id IS NULL
            THEN 'Approval waiting · immutable version ' || message.current_version_number::text
            ELSE 'Draft · immutable version ' || message.current_version_number::text END AS "signalLabel",
       message.created_at AS "createdAt", NULL::timestamptz AS "dueAt",
       CASE WHEN approval.decision = 'changes_requested'
            THEN coalesce(approval.decision_note, 'Requested reply changes remain unresolved.')
            ELSE NULL END AS "blockedBy",
       conversation.id::text AS "destinationId", conversation.channel AS "destinationChannel",
       contact.display_name AS "destinationQuery",
       'Inbox message version and approval ledger' AS "evidenceLabel",
       'Conversation, current immutable body hash, lifecycle and latest exact-version decision are database-derived.' AS "evidenceDetail",
       'postgres:app.messages:' || message.id::text || ':v'
         || message.current_version_number::text || ':sha256:'
         || encode(message.current_body_sha256, 'hex') AS "evidenceRef",
       message.updated_at AS "observedAt", message.row_version AS "sourceRowVersion"
FROM app.messages AS message
JOIN app.conversations AS conversation
  ON conversation.workspace_id = message.workspace_id
 AND conversation.id = message.conversation_id
JOIN app.contacts AS contact
  ON contact.workspace_id = conversation.workspace_id
 AND contact.id = conversation.contact_id
 AND contact.deleted_at IS NULL
LEFT JOIN LATERAL (
  SELECT request.id AS request_id, decision.id AS decision_id,
         decision.decision, decision.decision_note
  FROM app.message_approval_requests AS request
  LEFT JOIN app.message_approval_decisions AS decision
    ON decision.workspace_id = request.workspace_id
   AND decision.approval_request_id = request.id
  WHERE request.workspace_id = message.workspace_id
    AND request.conversation_id = message.conversation_id
    AND request.message_id = message.id
    AND request.message_version_id = message.current_version_id
    AND request.version_number = message.current_version_number
    AND request.body_sha256 = message.current_body_sha256
  ORDER BY request.request_number DESC, request.id DESC
  LIMIT 1
) AS approval ON true
WHERE message.workspace_id = app_private.current_workspace_id()
  AND message.environment = 'test'
  AND conversation.environment = 'test'
  AND message.direction = 'outbound'
  AND message.lifecycle IN ('draft', 'approval_pending')
  AND (message.lifecycle = 'draft' OR approval.decision_id IS NULL)`;

const TEST_OPERATION_ACTIONS_SQL = `/* portal.operator-actions.test-operations */
SELECT 'provider.test_operation:' || operation.id::text AS "actionId",
       'provider.test_operation' AS "actionKind",
       'app.provider_operations:' || operation.id::text AS "sourceReference",
       'provider' AS source,
       CASE WHEN operation.state IN ('dead_letter', 'reconciliation_required') THEN 'p0'
            WHEN operation.state = 'failed' THEN 'p1' ELSE 'p2' END AS priority,
       'blocked' AS status,
       'Review held TEST ' || replace(operation.operation_kind, '.', ' ') AS title,
       coalesce(operation.last_summary,
         'A TEST provider operation is held for operator review; no live provider effect is represented.') AS detail,
       NULL::uuid AS "sourceOwnerUserId", NULL::text AS "sourceOwnerLabel",
       'Provider operations' AS "ownerTeam", contact.display_name AS "relatedPersonLabel",
       'TEST operation · ' || replace(operation.state, '_', ' ') AS "signalLabel",
       operation.created_at AS "createdAt",
       CASE WHEN operation.state = 'retry_wait' THEN operation.next_attempt_at ELSE NULL END AS "dueAt",
       coalesce(operation.last_error_code, replace(operation.state, '_', ' ')) AS "blockedBy",
       delivery.conversation_id::text AS "destinationId",
       delivery.conversation_channel AS "destinationChannel",
       contact.display_name AS "destinationQuery",
       'TEST provider operation ledger' AS "evidenceLabel",
       'Environment, state, attempt count and safe failure summary come from the durable TEST operation row.' AS "evidenceDetail",
       'postgres:app.provider_operations:' || operation.id::text || ':v'
         || operation.row_version::text AS "evidenceRef",
       operation.updated_at AS "observedAt", operation.row_version AS "sourceRowVersion"
FROM app.provider_operations AS operation
JOIN app.message_deliveries AS delivery
  ON delivery.workspace_id = operation.workspace_id
 AND delivery.id = operation.message_delivery_id
JOIN app.contacts AS contact
  ON contact.workspace_id = delivery.workspace_id
 AND contact.id = delivery.contact_id
WHERE operation.workspace_id = app_private.current_workspace_id()
  AND operation.environment = 'test'
  AND operation.state IN ('retry_wait', 'failed', 'reconciliation_required', 'dead_letter')`;

const READINESS_ACTIONS_SQL = `/* portal.operator-actions.readiness */
SELECT 'provider.readiness:' || connection.id::text AS "actionId",
       'provider.readiness' AS "actionKind",
       'app.provider_connections:' || connection.id::text AS "sourceReference",
       'provider' AS source, 'p1' AS priority, 'blocked' AS status,
       'Restore ' || connection.display_name || ' readiness' AS title,
       'The stored provider connection is degraded. This is configuration evidence, not proof of a provider effect.' AS detail,
       NULL::uuid AS "sourceOwnerUserId", NULL::text AS "sourceOwnerLabel",
       'Connections' AS "ownerTeam", NULL::text AS "relatedPersonLabel",
       upper(connection.environment) || ' connection · degraded' AS "signalLabel",
       connection.created_at AS "createdAt", NULL::timestamptz AS "dueAt",
       'Database-backed provider connection status is degraded.' AS "blockedBy",
       connection.id::text AS "destinationId", NULL::text AS "destinationChannel",
       connection.display_name AS "destinationQuery",
       'Provider connection readiness row' AS "evidenceLabel",
       'Only an explicitly degraded stored connection becomes an action; disabled connections are not treated as failures.' AS "evidenceDetail",
       'postgres:app.provider_connections:' || connection.id::text || ':v'
         || connection.row_version::text AS "evidenceRef",
       connection.updated_at AS "observedAt", connection.row_version AS "sourceRowVersion"
FROM app.provider_connections AS connection
WHERE connection.workspace_id = app_private.current_workspace_id()
  AND connection.status = 'degraded'`;

const AUTHORITATIVE_ACTIONS_SQL = `/* portal.operator-actions.authoritative */
WITH source_actions AS (
  (${CRM_ACTIONS_SQL})
  UNION ALL
  (${JOURNEY_ACTIONS_SQL})
  UNION ALL
  (${CONTENT_ACTIONS_SQL})
  UNION ALL
  (${INBOX_ACTIONS_SQL})
  UNION ALL
  (${TEST_OPERATION_ACTIONS_SQL})
  UNION ALL
  (${READINESS_ACTIONS_SQL})
)
SELECT candidate.*
FROM source_actions AS candidate
WHERE ($2::boolean OR NOT EXISTS (
  SELECT 1
  FROM app.operator_action_controls AS snooze_control
  WHERE snooze_control.workspace_id = app_private.current_workspace_id()
    AND snooze_control.action_key = candidate."actionId"
    AND snooze_control.snoozed_until > transaction_timestamp()
))
  AND ($3::text IS NULL OR candidate."actionId" = $3)
ORDER BY CASE WHEN candidate.priority = 'p0' AND candidate.status = 'blocked' THEN 0 ELSE 1 END,
         CASE WHEN candidate."dueAt" < transaction_timestamp() THEN 0
              WHEN candidate."dueAt" <= transaction_timestamp() + interval '2 hours' THEN 1
              WHEN candidate."dueAt" <= transaction_timestamp() + interval '24 hours' THEN 2
              WHEN candidate."dueAt" IS NOT NULL THEN 3 ELSE 4 END,
         CASE candidate.priority WHEN 'p0' THEN 0 WHEN 'p1' THEN 1
              WHEN 'p2' THEN 2 ELSE 3 END,
         candidate."dueAt" ASC NULLS LAST,
         candidate."createdAt" ASC,
         candidate."actionId" ASC
LIMIT $1`;

const CONTROLS_SQL = `/* portal.operator-actions.controls */
SELECT control.action_key AS "actionId", control.action_kind AS "sourceKind",
       control.source_reference AS "sourceReference",
       control.assignment_overridden AS "assignmentOverridden",
       control.assigned_user_id AS "assignedUserId",
       control.snoozed_until AS "snoozedUntil", control.row_version AS "rowVersion"
FROM app.operator_action_controls AS control
WHERE control.workspace_id = app_private.current_workspace_id()
  AND control.action_key = ANY($1::text[])
ORDER BY control.action_key`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTION_ID = /^(crm\.task|journey\.attention|content\.review|inbox\.message|provider\.(?:test_operation|readiness)):[0-9a-f-]{36}$/;
const SAFE_REFERENCE = /^[a-z][a-z0-9_.]*:[0-9a-f-]{36}$/;
const ACTION_KINDS = new Set<PgOperatorActionKind>([
  'crm.task', 'journey.attention', 'content.approval', 'content.changes_requested',
  'inbox.approval', 'inbox.draft', 'provider.test_operation', 'provider.readiness',
]);
const SOURCES = new Set<PgOperatorActionSource>([
  'journey', 'inbox', 'content', 'webinar', 'automation', 'provider', 'crm',
]);
const PRIORITIES = new Set<PgOperatorActionPriority>(['p0', 'p1', 'p2', 'p3']);
const STATUSES = new Set<PgOperatorActionStatus>(['open', 'waiting', 'blocked']);
const CONTENT_KINDS = new Set([
  'article', 'document', 'email', 'image', 'social_post', 'video', 'webinar', 'other',
]);
const ASSIGNED_WORKSPACE_MEMBER_LABEL = 'Assigned workspace member';

function boundedText(value: unknown, label: string, maximum: number, nullable = false): string | null {
  if (value === null && nullable) return null;
  if (typeof value !== 'string') throw new Error(`${label} is invalid`);
  const trimmed = value.trim();
  if (!trimmed || [...trimmed].length > maximum) throw new Error(`${label} is invalid`);
  return trimmed;
}

function displayText(value: unknown, label: string, maximum: number, nullable = false): string | null {
  if (value === null && nullable) return null;
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${label} is invalid`);
  return [...value.trim()].slice(0, maximum).join('');
}

function uuid(value: unknown, label: string, nullable = false): string | null {
  if (value === null && nullable) return null;
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error(`${label} is invalid`);
  return value.toLowerCase();
}

function instant(value: unknown, label: string, nullable = false): string | null {
  if (value === null && nullable) return null;
  const date = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
  if (!date || !Number.isFinite(date.valueOf())) throw new Error(`${label} is invalid`);
  return date.toISOString();
}

function safeInteger(value: unknown, label: string, nullable = false): number | null {
  if (value === null && nullable) return null;
  const parsed = typeof value === 'number' ? value
    : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} is invalid`);
  return parsed;
}

function limit(value: number | undefined): number {
  if (value === undefined) return OPERATOR_ACTION_DATABASE_DEFAULT_LIMIT;
  if (!Number.isSafeInteger(value) || value < 1 || value > OPERATOR_ACTION_DATABASE_MAX_LIMIT) {
    throw new Error(`Action Centre limit must be 1-${OPERATOR_ACTION_DATABASE_MAX_LIMIT}`);
  }
  return value;
}

function queryLink(pathname: string, values: Readonly<Record<string, string | null>>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value) query.set(key, value);
  const suffix = query.toString();
  return suffix ? `${pathname}?${suffix}` : pathname;
}

function boundedQuery(value: string | null, maximum: number, maximumEncoded = 120): string | null {
  if (!value) return null;
  let bounded = '';
  for (const character of [...value].slice(0, maximum)) {
    if (encodeURIComponent(`${bounded}${character}`).length > maximumEncoded) break;
    bounded += character;
  }
  return bounded || null;
}

function destination(row: CandidateRow, kind: PgOperatorActionKind): Readonly<{ link: string; label: string }> {
  const query = typeof row.destinationQuery === 'string' ? row.destinationQuery : null;
  const channel = typeof row.destinationChannel === 'string' ? row.destinationChannel : null;
  const id = typeof row.destinationId === 'string' ? row.destinationId : null;
  if (kind === 'crm.task') {
    return { link: '/portal/crm/tasks?status=open', label: 'Open the CRM task queue' };
  }
  if (kind === 'journey.attention') {
    return {
      link: queryLink('/portal/journeys/board', { q: boundedQuery(query, 120) }),
      label: 'Open the lead on the journey board',
    };
  }
  if (kind === 'content.approval' || kind === 'content.changes_requested') {
    const contentKind = channel && CONTENT_KINDS.has(channel) ? channel : 'all';
    const contentChannel = contentKind === 'social_post' ? 'social'
      : contentKind === 'email' ? 'email' : contentKind === 'webinar' ? 'webinar' : 'library';
    return {
      link: queryLink('/portal/content', {
        q: boundedQuery(query, 80), channel: contentChannel, format: contentKind,
      }),
      label: 'Open the exact content review queue',
    };
  }
  if (kind === 'inbox.approval' || kind === 'inbox.draft' || kind === 'provider.test_operation') {
    return {
      link: queryLink('/portal/inbox', {
        channel,
        queue: kind === 'inbox.approval' ? 'approval' : 'open',
        conversation: id,
      }),
      label: 'Open the exact conversion thread',
    };
  }
  // Provider connections do not yet have a mounted PostgreSQL route. Keep the
  // operator in the live Action Centre instead of emitting a decorative 404.
  return { link: '/portal/actions', label: 'Keep this readiness blocker in the Action Centre' };
}

function candidate(row: CandidateRow): PgOperatorActionSnapshot {
  if (!ACTION_ID.test(row.actionId)) throw new Error('actionId is invalid');
  if (!ACTION_KINDS.has(row.actionKind as PgOperatorActionKind)) throw new Error('actionKind is invalid');
  if (!SAFE_REFERENCE.test(row.sourceReference)) throw new Error('sourceReference is invalid');
  if (!SOURCES.has(row.source as PgOperatorActionSource)) throw new Error('source is invalid');
  if (!PRIORITIES.has(row.priority as PgOperatorActionPriority)) throw new Error('priority is invalid');
  if (!STATUSES.has(row.status as PgOperatorActionStatus)) throw new Error('status is invalid');
  const actionKind = row.actionKind as PgOperatorActionKind;
  const link = destination(row, actionKind);
  return Object.freeze({
    actionId: row.actionId,
    actionKind,
    sourceReference: row.sourceReference,
    source: row.source as PgOperatorActionSource,
    priority: row.priority as PgOperatorActionPriority,
    status: row.status as PgOperatorActionStatus,
    title: displayText(row.title, 'title', 180)!,
    detail: displayText(row.detail, 'detail', 320)!,
    ownerLabel: displayText(row.sourceOwnerLabel, 'sourceOwnerLabel', 100, true),
    ownerTeam: displayText(row.ownerTeam, 'ownerTeam', 100)!,
    assignedUserId: uuid(row.sourceOwnerUserId, 'sourceOwnerUserId', true),
    assignmentOverridden: false,
    relatedPersonLabel: displayText(row.relatedPersonLabel, 'relatedPersonLabel', 120, true),
    signalLabel: displayText(row.signalLabel, 'signalLabel', 140)!,
    createdAt: instant(row.createdAt, 'createdAt')!,
    dueAt: instant(row.dueAt, 'dueAt', true),
    blockedBy: displayText(row.blockedBy, 'blockedBy', 180, true),
    deepLink: link.link,
    deepLinkLabel: link.label,
    evidence: Object.freeze({
      label: displayText(row.evidenceLabel, 'evidenceLabel', 200)!,
      detail: displayText(row.evidenceDetail, 'evidenceDetail', 320)!,
      truth: 'measured' as const,
      evidenceRef: boundedText(row.evidenceRef, 'evidenceRef', 500)!,
      observedAt: instant(row.observedAt, 'observedAt')!,
    }),
    rowVersion: null,
    sourceRowVersion: safeInteger(row.sourceRowVersion, 'sourceRowVersion')!,
    snoozedUntil: null,
    canSnooze: false,
    canAssign: false,
  });
}

function parseControl(row: ControlRow): Readonly<{
  actionId: string;
  sourceKind: PgOperatorActionSource;
  sourceReference: string;
  assignmentOverridden: boolean;
  assignedUserId: string | null;
  snoozedUntil: string | null;
  rowVersion: number;
}> {
  if (!ACTION_ID.test(row.actionId)) throw new Error('control.actionId is invalid');
  if (!SOURCES.has(row.sourceKind as PgOperatorActionSource)) throw new Error('control.sourceKind is invalid');
  if (!SAFE_REFERENCE.test(row.sourceReference)) throw new Error('control.sourceReference is invalid');
  if (typeof row.assignmentOverridden !== 'boolean') throw new Error('control.assignmentOverridden is invalid');
  return Object.freeze({
    actionId: row.actionId,
    sourceKind: row.sourceKind as PgOperatorActionSource,
    sourceReference: row.sourceReference,
    assignmentOverridden: row.assignmentOverridden,
    assignedUserId: uuid(row.assignedUserId, 'control.assignedUserId', true),
    snoozedUntil: instant(row.snoozedUntil, 'control.snoozedUntil', true),
    rowVersion: safeInteger(row.rowVersion, 'control.rowVersion')!,
  });
}

const PRIORITY_RANK: Readonly<Record<PgOperatorActionPriority, number>> = Object.freeze({
  p0: 0, p1: 1, p2: 2, p3: 3,
});

function actionSlaRank(action: PgOperatorActionSnapshot, asOf: number): number {
  if (!action.dueAt) return 4;
  const minutes = Math.floor((Date.parse(action.dueAt) - asOf) / 60_000);
  if (minutes < 0) return 0;
  if (minutes <= 120) return 1;
  if (minutes <= 24 * 60) return 2;
  return 3;
}

function actionOrder(
  left: PgOperatorActionSnapshot,
  right: PgOperatorActionSnapshot,
  asOf: number,
): number {
  const critical = Number(right.priority === 'p0' && right.status === 'blocked')
    - Number(left.priority === 'p0' && left.status === 'blocked');
  if (critical) return critical;
  const sla = actionSlaRank(left, asOf) - actionSlaRank(right, asOf);
  if (sla) return sla;
  const priority = PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority];
  if (priority) return priority;
  const leftDue = left.dueAt ? Date.parse(left.dueAt) : Number.POSITIVE_INFINITY;
  const rightDue = right.dueAt ? Date.parse(right.dueAt) : Number.POSITIVE_INFINITY;
  if (leftDue !== rightDue) return leftDue - rightDue;
  const created = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  return created || left.actionId.localeCompare(right.actionId);
}

export class PgOperatorActionCentreReadServiceImpl implements PgOperatorActionCentreReadService {
  constructor(
    private readonly pool: Pick<Pool, 'connect'>,
    private readonly environment: PgOperatorActionEnvironment,
  ) {}

  async load(
    context: DatabaseRequestContext,
    options: PgOperatorActionCentreReadOptions = {},
  ): Promise<PgOperatorActionCentreSnapshot> {
    const wanted = limit(options.limit);
    if (options.actionId !== undefined && !ACTION_ID.test(options.actionId)) {
      throw new Error('Action Centre exact lookup key is invalid');
    }
    return withTransaction(this.pool, context, async (transaction) => {
      const workspaceResult = await transaction.query<WorkspaceRow>(WORKSPACE_SQL);
      const workspace = workspaceResult.rows[0];
      if (workspaceResult.rows.length !== 1 || !workspace) {
        throw new InactivePortalSessionError();
      }
      const workspaceId = uuid(workspace.workspaceId, 'workspaceId')!;
      const workspaceName = boundedText(workspace.workspaceName, 'workspaceName', 200)!;
      const asOf = instant(workspace.snapshotAt, 'snapshotAt')!;
      if (typeof workspace.canWrite !== 'boolean' || typeof workspace.canAssign !== 'boolean') {
        throw new Error('workspace permissions are invalid');
      }

      const memberLimit = OPERATOR_ACTION_DATABASE_MAX_LIMIT + 1;
      const memberResult = await transaction.query<MemberRow>(ASSIGNABLE_MEMBERS_SQL, [memberLimit]);
      const membersTruncated = memberResult.rows.length > OPERATOR_ACTION_DATABASE_MAX_LIMIT;
      const assignableMembers = memberResult.rows
        .slice(0, OPERATOR_ACTION_DATABASE_MAX_LIMIT)
        .map((row): PgOperatorAssignableMember => {
          if (!['owner', 'admin', 'marketer', 'sales'].includes(row.role)) {
            throw new Error('assignable member role is invalid');
          }
          return Object.freeze({
            userId: uuid(row.userId, 'assignableMember.userId')!,
            displayName: boundedText(row.displayName, 'assignableMember.displayName', 320)!,
            role: row.role as PgOperatorAssignableMember['role'],
          });
        });
      const memberLabels = new Map(assignableMembers.map((member) => [
        member.userId,
        member.displayName,
      ]));
      const ownerLabelFor = (userId: string | null): string | null => (
        userId === null
          ? null
          : memberLabels.get(userId) ?? ASSIGNED_WORKSPACE_MEMBER_LABEL
      );

      const sourceLimit = Math.min(wanted + 1, OPERATOR_ACTION_DATABASE_MAX_LIMIT + 1);
      const sourceResult = await transaction.query<CandidateRow>(AUTHORITATIVE_ACTIONS_SQL, [
        sourceLimit,
        options.includeSnoozed === true,
        options.actionId ?? null,
      ]);
      if (sourceResult.rows.length > sourceLimit) {
        throw new Error('Action source exceeded its database bound');
      }
      const rows = sourceResult.rows;
      const baseActions = rows.map((row) => {
        const action = candidate(row);
        return Object.freeze({
          ...action,
          ownerLabel: ownerLabelFor(action.assignedUserId),
        });
      });
      if (new Set(baseActions.map((action) => action.actionId)).size !== baseActions.length) {
        throw new Error('Duplicate authoritative action keys detected');
      }
      const controlResult = baseActions.length
        ? await transaction.query<ControlRow>(CONTROLS_SQL, [baseActions.map((action) => action.actionId)])
        : { rows: [] as ControlRow[] };
      const controls = new Map<string, ReturnType<typeof parseControl>>();
      for (const rawControl of controlResult.rows) {
        const control = parseControl(rawControl);
        if (controls.has(control.actionId)) throw new Error('Duplicate action control detected');
        controls.set(control.actionId, control);
      }
      const visible = baseActions.flatMap((action): PgOperatorActionSnapshot[] => {
        const control = controls.get(action.actionId);
        if (control && (control.sourceKind !== action.source
            || control.sourceReference !== action.sourceReference)) {
          throw new Error('Action control identity does not match source evidence');
        }
        if (!options.includeSnoozed && control?.snoozedUntil
            && Date.parse(control.snoozedUntil) > Date.parse(asOf)) return [];
        const assignedUserId = control?.assignmentOverridden
          ? control.assignedUserId : action.assignedUserId;
        return [Object.freeze({
          ...action,
          ownerLabel: ownerLabelFor(assignedUserId),
          assignedUserId,
          assignmentOverridden: control?.assignmentOverridden ?? false,
          rowVersion: control?.rowVersion ?? null,
          snoozedUntil: control?.snoozedUntil ?? null,
          canSnooze: workspace.canWrite,
          canAssign: workspace.canWrite && (
            workspace.canAssign
            || assignedUserId === null
            || assignedUserId === context.userId
          ),
        })];
      }).sort((left, right) => actionOrder(left, right, Date.parse(asOf)));
      const inputTruncated = rows.length === sourceLimit || visible.length > wanted;

      return Object.freeze({
        workspaceId,
        workspaceName,
        asOf,
        environment: this.environment,
        datasetKind: 'postgres_authoritative' as const,
        currentUserId: context.userId!,
        canWrite: workspace.canWrite,
        canManage: workspace.canAssign,
        canAssign: workspace.canAssign,
        commandBoundaryAvailable: workspace.canWrite,
        assignableMembers: Object.freeze(assignableMembers),
        membersTruncated,
        inputTruncated,
        actions: Object.freeze(visible.slice(0, wanted)),
      });
    }, { readOnly: true, isolation: 'repeatable read' });
  }
}

export function createPgOperatorActionCentreReadService(
  pool: Pick<Pool, 'connect'>,
  environment: PgOperatorActionEnvironment,
): PgOperatorActionCentreReadServiceImpl {
  return new PgOperatorActionCentreReadServiceImpl(pool, environment);
}

export interface OperatorActionControlResult {
  readonly actionId: string;
  readonly sourceKind: PgOperatorActionSource;
  readonly sourceReference: string;
  readonly assignmentOverridden: boolean;
  readonly assignedUserId: string | null;
  readonly snoozedUntil: string | null;
  readonly rowVersion: number;
  readonly changed: boolean;
  readonly disposition: 'applied' | 'replayed';
}

export interface OperatorActionSnoozeCommand {
  readonly actionId: string;
  readonly sourceKind: PgOperatorActionSource;
  readonly sourceReference: string;
  readonly snoozedUntil: string | null;
  readonly idempotencyKey: string;
  readonly expectedRowVersion: number | null;
}

export interface OperatorActionAssignmentCommand {
  readonly actionId: string;
  readonly sourceKind: PgOperatorActionSource;
  readonly sourceReference: string;
  readonly assignedUserId: string | null;
  readonly idempotencyKey: string;
  readonly expectedRowVersion: number | null;
}

interface CommandResultRow extends QueryResultRow {
  actionId: string;
  sourceKind: string;
  sourceReference: string;
  assignmentOverridden: boolean;
  assignedUserId: string | null;
  snoozedUntil: string | Date | null;
  rowVersion: number | string;
  changed: boolean;
  replayed: boolean;
}

const SNOOZE_SQL = `/* portal.operator-actions.snooze */
SELECT action_key AS "actionId", action_kind AS "sourceKind",
       source_reference AS "sourceReference",
       assignment_overridden AS "assignmentOverridden",
       assigned_user_id AS "assignedUserId", snoozed_until AS "snoozedUntil",
       row_version AS "rowVersion", changed, replayed
FROM app_private.set_operator_action_snooze($1, $2, $3, $4, $5, $6)`;

const ASSIGN_SQL = `/* portal.operator-actions.assign */
SELECT action_key AS "actionId", action_kind AS "sourceKind",
       source_reference AS "sourceReference",
       assignment_overridden AS "assignmentOverridden",
       assigned_user_id AS "assignedUserId", snoozed_until AS "snoozedUntil",
       row_version AS "rowVersion", changed, replayed
FROM app_private.set_operator_action_assignment($1, $2, $3, $4, $5, $6)`;

function idempotencyKey(value: unknown): string {
  if (typeof value !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/.test(value)) {
    throw new OperatorActionCommandValidationError('idempotencyKey is invalid');
  }
  return value;
}

function expectedVersion(value: unknown): number {
  if (value === null) return 0;
  try {
    return safeInteger(value, 'expectedRowVersion')!;
  } catch {
    throw new OperatorActionCommandValidationError('expectedRowVersion is invalid');
  }
}

function commandUuid(value: unknown, label: string, nullable = false): string | null {
  try {
    return uuid(value, label, nullable);
  } catch {
    throw new OperatorActionCommandValidationError(`${label} is invalid`);
  }
}

function commandInstant(value: unknown, label: string, nullable = false): string | null {
  try {
    return instant(value, label, nullable);
  } catch {
    throw new OperatorActionCommandValidationError(`${label} is invalid`);
  }
}

function commandIdentity(input: Readonly<{
  actionId: string;
  sourceKind: PgOperatorActionSource;
  sourceReference: string;
}>): Readonly<{ actionId: string; sourceKind: PgOperatorActionSource; sourceReference: string }> {
  if (!ACTION_ID.test(input.actionId)) throw new OperatorActionCommandValidationError('actionId is invalid');
  if (!SOURCES.has(input.sourceKind)) throw new OperatorActionCommandValidationError('sourceKind is invalid');
  if (!input.actionId.startsWith(`${input.sourceKind}.`)) {
    throw new OperatorActionCommandValidationError('action identity is inconsistent');
  }
  if (!SAFE_REFERENCE.test(input.sourceReference)) {
    throw new OperatorActionCommandValidationError('sourceReference is invalid');
  }
  return input;
}

function commandResult(row: CommandResultRow | undefined): OperatorActionControlResult {
  if (!row || typeof row.replayed !== 'boolean' || typeof row.changed !== 'boolean'
      || typeof row.assignmentOverridden !== 'boolean') {
    throw new Error('Operator action command returned no result');
  }
  const sourceKind = row.sourceKind as PgOperatorActionSource;
  const identity = commandIdentity({
    actionId: row.actionId,
    sourceKind,
    sourceReference: row.sourceReference,
  });
  return Object.freeze({
    ...identity,
    assignmentOverridden: row.assignmentOverridden,
    assignedUserId: uuid(row.assignedUserId, 'assignedUserId', true),
    snoozedUntil: instant(row.snoozedUntil, 'snoozedUntil', true),
    rowVersion: safeInteger(row.rowVersion, 'rowVersion')!,
    changed: row.changed,
    disposition: row.replayed ? 'replayed' : 'applied',
  });
}

export class OperatorActionCommandValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OperatorActionCommandValidationError';
  }
}

export class PgOperatorActionCentreCommandService {
  constructor(private readonly pool: Pick<Pool, 'connect'>) {}

  async snooze(
    context: DatabaseRequestContext,
    input: OperatorActionSnoozeCommand,
  ): Promise<OperatorActionControlResult> {
    const identity = commandIdentity(input);
    const snoozedUntil = commandInstant(input.snoozedUntil, 'snoozedUntil', true);
    const key = idempotencyKey(input.idempotencyKey);
    const version = expectedVersion(input.expectedRowVersion);
    return withTransaction(this.pool, context, async (transaction) => {
      const result = await transaction.query<CommandResultRow>(SNOOZE_SQL, [
        identity.actionId, identity.sourceKind, identity.sourceReference,
        snoozedUntil, version, key,
      ]);
      if (result.rows.length !== 1) throw new Error('Operator action command returned an invalid result count');
      return commandResult(result.rows[0]);
    }, { isolation: 'serializable' });
  }

  async assign(
    context: DatabaseRequestContext,
    input: OperatorActionAssignmentCommand,
  ): Promise<OperatorActionControlResult> {
    const identity = commandIdentity(input);
    const assignedUserId = commandUuid(input.assignedUserId, 'assignedUserId', true);
    const key = idempotencyKey(input.idempotencyKey);
    const version = expectedVersion(input.expectedRowVersion);
    return withTransaction(this.pool, context, async (transaction) => {
      const result = await transaction.query<CommandResultRow>(ASSIGN_SQL, [
        identity.actionId, identity.sourceKind, identity.sourceReference,
        assignedUserId, version, key,
      ]);
      if (result.rows.length !== 1) throw new Error('Operator action command returned an invalid result count');
      return commandResult(result.rows[0]);
    }, { isolation: 'serializable' });
  }
}

export type PortalOperatorActionCommandOutcome =
  | Readonly<{ ok: true; disposition: 'applied' | 'replayed'; changed: boolean; rowVersion: number }>
  | Readonly<{ ok: false; kind: 'validation' | 'not_found' | 'forbidden' | 'conflict' | 'unavailable'; message: string }>;

export interface PortalOperatorActionSnoozeInput {
  readonly actionId: string;
  readonly commandKey: string;
  readonly expectedRowVersion: number | null;
  readonly snoozedUntil: string | null;
}

export interface PortalOperatorActionAssignmentInput {
  readonly actionId: string;
  readonly commandKey: string;
  readonly expectedRowVersion: number | null;
  readonly assignedUserId: string | null;
}

export interface PortalOperatorActionCentreService {
  snapshot(
    identity: PortalCrmRequestIdentity,
    options?: PgOperatorActionCentreReadOptions,
  ): Promise<PgOperatorActionCentreSnapshot | null>;
  snoozeAction(
    identity: PortalCrmRequestIdentity,
    input: PortalOperatorActionSnoozeInput,
  ): Promise<PortalOperatorActionCommandOutcome>;
  assignAction(
    identity: PortalCrmRequestIdentity,
    input: PortalOperatorActionAssignmentInput,
  ): Promise<PortalOperatorActionCommandOutcome>;
}

function databaseContext(
  identity: PortalCrmRequestIdentity,
  principal: PortalCrmPrincipal,
): DatabaseRequestContext {
  return requestDatabaseContext({
    ...principal,
    requestId: identity.requestId,
    portalSessionTokenHash: createHash('sha256').update(identity.sessionToken).digest(),
  });
}

function postgresCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error
    && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code : null;
}

function commandFailure(error: unknown): PortalOperatorActionCommandOutcome {
  const code = postgresCode(error);
  if (error instanceof OperatorActionCommandValidationError || code === '22023') {
    return Object.freeze({ ok: false, kind: 'validation', message: 'The action update was invalid or its command key was reused with different input.' });
  }
  if (error instanceof InactivePortalSessionError || code === '42501') {
    return Object.freeze({ ok: false, kind: 'forbidden', message: 'This workspace action is not available to the active user.' });
  }
  if (code === '40001' || code === '23505') {
    return Object.freeze({ ok: false, kind: 'conflict', message: 'The action changed after this page loaded. Review the refreshed queue.' });
  }
  return Object.freeze({ ok: false, kind: 'unavailable', message: 'The action could not be updated safely. No source record or provider was changed.' });
}

export class PgPortalOperatorActionCentreService implements PortalOperatorActionCentreService {
  constructor(private readonly dependencies: Readonly<{
    principalResolver: Pick<PortalCrmPrincipalResolver, 'resolve'>;
    readService: Pick<PgOperatorActionCentreReadService, 'load'>;
    commandService: Pick<PgOperatorActionCentreCommandService, 'snooze' | 'assign'>;
  }>) {}

  private async context(identity: PortalCrmRequestIdentity): Promise<DatabaseRequestContext | null> {
    const principal = await this.dependencies.principalResolver.resolve(identity.sessionToken);
    return principal ? databaseContext(identity, principal) : null;
  }

  async snapshot(
    identity: PortalCrmRequestIdentity,
    options?: PgOperatorActionCentreReadOptions,
  ): Promise<PgOperatorActionCentreSnapshot | null> {
    const context = await this.context(identity);
    if (!context) return null;
    try {
      return await this.dependencies.readService.load(context, options);
    } catch (error) {
      if (error instanceof InactivePortalSessionError) return null;
      throw error;
    }
  }

  private async selectedAction(
    context: DatabaseRequestContext,
    actionId: string,
  ): Promise<Readonly<{
    action: PgOperatorActionSnapshot;
    snapshot: PgOperatorActionCentreSnapshot;
  }> | null> {
    if (!ACTION_ID.test(actionId)) return null;
    const snapshot = await this.dependencies.readService.load(context, {
      limit: 1,
      includeSnoozed: true,
      actionId,
    });
    const action = snapshot.actions.find((candidate) => candidate.actionId === actionId);
    return action ? Object.freeze({ action, snapshot }) : null;
  }

  async snoozeAction(
    identity: PortalCrmRequestIdentity,
    input: PortalOperatorActionSnoozeInput,
  ): Promise<PortalOperatorActionCommandOutcome> {
    try {
      if (!ACTION_ID.test(input.actionId)) {
        return Object.freeze({ ok: false, kind: 'validation', message: 'The selected action is invalid.' });
      }
      const context = await this.context(identity);
      if (!context) throw new InactivePortalSessionError();
      const selected = await this.selectedAction(context, input.actionId);
      if (!selected) return Object.freeze({ ok: false, kind: 'not_found', message: 'The action is no longer in this workspace queue.' });
      const { action, snapshot } = selected;
      if (!snapshot.canWrite || !action.canSnooze) {
        return Object.freeze({ ok: false, kind: 'forbidden', message: 'This workspace role cannot snooze the selected action.' });
      }
      const result = await this.dependencies.commandService.snooze(context, {
        actionId: action.actionId,
        sourceKind: action.source,
        sourceReference: action.sourceReference,
        snoozedUntil: input.snoozedUntil,
        idempotencyKey: input.commandKey,
        expectedRowVersion: input.expectedRowVersion,
      });
      return Object.freeze({
        ok: true,
        disposition: result.disposition,
        changed: result.changed,
        rowVersion: result.rowVersion,
      });
    } catch (error) {
      return commandFailure(error);
    }
  }

  async assignAction(
    identity: PortalCrmRequestIdentity,
    input: PortalOperatorActionAssignmentInput,
  ): Promise<PortalOperatorActionCommandOutcome> {
    try {
      if (!ACTION_ID.test(input.actionId)) {
        return Object.freeze({ ok: false, kind: 'validation', message: 'The selected action is invalid.' });
      }
      const context = await this.context(identity);
      if (!context) throw new InactivePortalSessionError();
      const selected = await this.selectedAction(context, input.actionId);
      if (!selected) return Object.freeze({ ok: false, kind: 'not_found', message: 'The action is no longer in this workspace queue.' });
      const { action, snapshot } = selected;
      if (!snapshot.canWrite || !action.canAssign) {
        return Object.freeze({ ok: false, kind: 'forbidden', message: 'This workspace role cannot assign the selected action.' });
      }
      const target = input.assignedUserId;
      const currentUserId = snapshot.currentUserId;
      if (snapshot.canManage) {
        if (target !== null
            && !snapshot.assignableMembers.some((member) => member.userId === target)) {
          return Object.freeze({ ok: false, kind: 'forbidden', message: 'The selected assignee is not in the scoped writable member directory.' });
        }
      } else if (target !== null) {
        if (target !== currentUserId
            || (action.assignedUserId !== null && action.assignedUserId !== currentUserId)) {
          return Object.freeze({ ok: false, kind: 'forbidden', message: 'This role may claim only an unassigned or already self-owned action.' });
        }
      } else if (!action.assignmentOverridden || action.assignedUserId !== currentUserId) {
        return Object.freeze({ ok: false, kind: 'forbidden', message: 'This role may release only its own explicit action assignment.' });
      }
      const result = await this.dependencies.commandService.assign(context, {
        actionId: action.actionId,
        sourceKind: action.source,
        sourceReference: action.sourceReference,
        assignedUserId: input.assignedUserId,
        idempotencyKey: input.commandKey,
        expectedRowVersion: input.expectedRowVersion,
      });
      return Object.freeze({
        ok: true,
        disposition: result.disposition,
        changed: result.changed,
        rowVersion: result.rowVersion,
      });
    } catch (error) {
      return commandFailure(error);
    }
  }
}

export function createPgPortalOperatorActionCentreService(input: Readonly<{
  webPool: Pool;
  commandPool: Pool;
  environment: PgOperatorActionEnvironment;
}>): PgPortalOperatorActionCentreService {
  return new PgPortalOperatorActionCentreService({
    principalResolver: createPgPortalCrmPrincipalResolver(input.webPool),
    readService: createPgOperatorActionCentreReadService(input.webPool, input.environment),
    commandService: new PgOperatorActionCentreCommandService(input.commandPool),
  });
}
