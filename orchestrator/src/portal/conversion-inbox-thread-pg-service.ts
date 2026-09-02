import type { Pool, QueryResultRow } from 'pg';
import type { DatabaseRequestContext } from '../db/rls.js';
import { validateDatabaseContext } from '../db/rls.js';
import { withTransaction } from '../db/transaction.js';
import { INBOX_DATABASE_MAX_BODY_BYTES } from '../inbox-pg/limits.js';
import {
  CONVERSION_INBOX_MAX_CONSENTS,
  CONVERSION_INBOX_MAX_MESSAGES,
  type ConversionInboxApprovalState,
  type ConversionInboxAdminCallSnapshot,
  type ConversionInboxConsentSnapshot,
  type ConversionInboxConsentState,
  type ConversionInboxDeliveryState,
  type ConversionInboxDraftSnapshot,
  type ConversionInboxLeadSnapshot,
  type ConversionInboxRailActivitySnapshot,
  type ConversionInboxSignedInboundEvidenceSnapshot,
  type ConversionInboxThreadSnapshot,
  type ConversionInboxTranscriptMessageSnapshot,
} from './conversion-inbox-presenter.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIRECTIONS = new Set(['inbound', 'outbound', 'internal_note']);
const LIFECYCLES = new Set(['received', 'draft', 'approval_pending', 'approved', 'committed']);
const DRAFT_LIFECYCLES = new Set(['draft', 'approval_pending', 'approved']);
const APPROVAL_STATES = new Set(['approved', 'rejected', 'changes_requested']);
const DELIVERY_STATES = new Set([
  'queued', 'sending', 'accepted', 'delivered', 'read', 'failed',
  'reconciliation_required', 'cancelled',
]);
const OPERATION_STATES = new Set([
  'queued', 'leased', 'calling', 'retry_wait', 'accepted', 'succeeded',
  'failed', 'reconciliation_required', 'dead_letter', 'cancelled',
]);
const ATTEMPT_KINDS = new Set(['dispatch', 'reconcile']);
const ATTEMPT_STATES = new Set([
  'leased', 'calling', 'accepted', 'pending', 'succeeded', 'failed', 'needs_attention',
]);
const CONSENT_STATES = new Set(['granted', 'denied', 'withdrawn']);
const CONSENT_CHANNELS = new Set(['email', 'sms', 'whatsapp', 'social']);
const PURPOSE = /^[a-z][a-z0-9_.-]{0,99}$/;

export interface ConversionInboxThreadReadService {
  thread(
    context: DatabaseRequestContext,
    conversationId: string,
  ): Promise<ConversionInboxThreadSnapshot | null>;
}

interface ThreadCoreRow extends QueryResultRow {
  conversationId: string;
  environment: string;
  contactId: string;
  contactPointId: string | null;
  displayName: string;
  companyName: string | null;
  lifecycleStatus: string;
  source: string | null;
  stageName: string | null;
  score: number | string | null;
  referralCode: string | null;
  nextMove: string | null;
  draftMessageId: string | null;
  draftBody: string | null;
  draftLifecycle: string | null;
  draftVersionNumber: number | string | null;
  draftRowVersion: number | string | null;
  draftUpdatedAt: string | Date | null;
  approvalRequestId: string | null;
  approvalDecision: string | null;
  approvalNote: string | null;
  deliveryStatus: string | null;
  deliveryPurpose: string | null;
  consentPurpose: string | null;
  railDeliveryStatus: string | null;
  railOperationState: string | null;
  railCorrelationId: string | null;
  railAttemptKind: string | null;
  railAttemptState: string | null;
  railOccurredAt: string | Date | null;
  adminCallTaskId: string | null;
  adminCallStatus: string | null;
  adminCallPriority: string | null;
  adminCallTitle: string | null;
  adminCallDueAt: string | Date | null;
  adminCallTaskRowVersion: number | string | null;
  adminCallOutcome: string | null;
  adminCallOutcomeSummary: string | null;
  adminCallOutcomeAt: string | Date | null;
  adminCallNextTaskId: string | null;
  adminCallNextTaskTitle: string | null;
  adminCallNextTaskDueAt: string | Date | null;
}

interface TranscriptRow extends QueryResultRow {
  messageId: string;
  direction: string;
  lifecycle: string;
  sourceKind: string;
  body: string;
  occurredAt: string | Date;
  deliveryStatus: string | null;
  inboundReceiptId: string | null;
  inboundProviderFamily: string | null;
  inboundNetwork: string | null;
  inboundVerifiedAt: string | Date | null;
}

interface ConsentRow extends QueryResultRow {
  channel: string;
  consentState: string | null;
  lawfulBasis: string | null;
  purpose: string | null;
  consentAt: string | Date | null;
  suppressionState: string | null;
  suppressionAt: string | Date | null;
  endpointAvailable: boolean;
}

const THREAD_CORE_SQL = `/* portal.conversion-inbox.thread-core */
SELECT conversation.id AS "conversationId",
       conversation.environment,
       conversation.contact_id AS "contactId",
       selected_point.id AS "contactPointId",
       contact.display_name AS "displayName",
       contact.company_name AS "companyName",
       contact.lifecycle_status AS "lifecycleStatus",
       contact.source,
       coalesce(current_milestone.name, opportunity_stage.name) AS "stageName",
       score.total_score AS score,
       attribution.referral_code AS "referralCode",
       next_milestone.name AS "nextMove",
       draft.id AS "draftMessageId",
       draft.body_text AS "draftBody",
       draft.lifecycle AS "draftLifecycle",
       draft.current_version_number AS "draftVersionNumber",
       draft.row_version AS "draftRowVersion",
       draft.updated_at AS "draftUpdatedAt",
       approval.id AS "approvalRequestId",
       approval.decision AS "approvalDecision",
       approval.approval_note AS "approvalNote",
       draft_delivery.status AS "deliveryStatus",
       draft_delivery.purpose AS "deliveryPurpose",
       current_consent.purpose AS "consentPurpose",
       rail_activity.delivery_status AS "railDeliveryStatus",
       rail_activity.operation_state AS "railOperationState",
       rail_activity.correlation_id AS "railCorrelationId",
       rail_activity.attempt_kind AS "railAttemptKind",
       rail_activity.attempt_state AS "railAttemptState",
       rail_activity.occurred_at AS "railOccurredAt",
       admin_call.task_id AS "adminCallTaskId",
       admin_call.task_status AS "adminCallStatus",
       admin_call.task_priority AS "adminCallPriority",
       admin_call.task_title AS "adminCallTitle",
       admin_call.task_due_at AS "adminCallDueAt",
       admin_call.task_row_version AS "adminCallTaskRowVersion",
       admin_call.outcome AS "adminCallOutcome",
       admin_call.outcome_summary AS "adminCallOutcomeSummary",
       admin_call.outcome_at AS "adminCallOutcomeAt",
       admin_call.next_task_id AS "adminCallNextTaskId",
       admin_call.next_task_title AS "adminCallNextTaskTitle",
       admin_call.next_task_due_at AS "adminCallNextTaskDueAt"
FROM app.conversations AS conversation
JOIN app.contacts AS contact
  ON contact.workspace_id = conversation.workspace_id
 AND contact.id = conversation.contact_id
 AND contact.deleted_at IS NULL
LEFT JOIN LATERAL (
  SELECT message.id, message.lifecycle, message.current_version_id,
         message.current_version_number, message.current_body_sha256,
         message.contact_point_id, message.row_version, message.updated_at,
         version.body_text
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
    AND message.environment = conversation.environment
    AND message.direction = 'outbound'
    AND message.lifecycle IN ('draft', 'approval_pending', 'approved')
  ORDER BY EXISTS (
    SELECT 1
    FROM LATERAL (
      SELECT target_request.id,
             target_decision.id AS decision_id,
             target_decision.decision
      FROM app.message_approval_requests AS target_request
      LEFT JOIN app.message_approval_decisions AS target_decision
        ON target_decision.workspace_id = target_request.workspace_id
       AND target_decision.approval_request_id = target_request.id
      WHERE target_request.workspace_id = message.workspace_id
        AND target_request.conversation_id = message.conversation_id
        AND target_request.message_id = message.id
        AND target_request.message_version_id = message.current_version_id
        AND target_request.version_number = message.current_version_number
        AND target_request.body_sha256 = message.current_body_sha256
      ORDER BY target_request.request_number DESC, target_request.id DESC
      LIMIT 1
    ) AS latest_target
    WHERE (
        (message.lifecycle = 'approval_pending' AND latest_target.decision_id IS NULL)
        OR (message.lifecycle = 'draft'
          AND latest_target.decision = 'changes_requested')
      )
  ) DESC,
  message.occurred_at DESC, message.id DESC
  LIMIT 1
) AS draft ON true
LEFT JOIN LATERAL (
  SELECT point.id
  FROM app.contact_points AS point
  WHERE point.workspace_id = conversation.workspace_id
    AND point.contact_id = conversation.contact_id
    AND (
      (draft.id IS NOT NULL AND point.id = draft.contact_point_id)
      OR (
        draft.id IS NULL
        AND point.deleted_at IS NULL
        AND point.kind = CASE conversation.channel
          WHEN 'email' THEN 'email'
          WHEN 'sms' THEN 'phone'
          WHEN 'whatsapp' THEN 'whatsapp'
          ELSE 'social'
        END
      )
    )
  ORDER BY (
    SELECT endpoint_message.occurred_at
    FROM app.messages AS endpoint_message
    WHERE endpoint_message.workspace_id = conversation.workspace_id
      AND endpoint_message.conversation_id = conversation.id
      AND endpoint_message.contact_point_id = point.id
    ORDER BY endpoint_message.occurred_at DESC, endpoint_message.id DESC
    LIMIT 1
  ) DESC NULLS LAST,
  point.is_verified DESC, point.is_primary DESC, point.updated_at DESC, point.id DESC
  LIMIT 1
) AS selected_point ON true
LEFT JOIN LATERAL (
  SELECT enrollment.id, enrollment.journey_version_id,
         enrollment.current_milestone_id
  FROM app.conversion_enrollments AS enrollment
  WHERE enrollment.workspace_id = conversation.workspace_id
    AND enrollment.contact_id = conversation.contact_id
  ORDER BY (enrollment.status = 'active') DESC,
           enrollment.updated_at DESC, enrollment.id DESC
  LIMIT 1
) AS enrollment ON true
LEFT JOIN app.conversion_journey_milestones AS current_milestone
  ON current_milestone.workspace_id = conversation.workspace_id
 AND current_milestone.journey_version_id = enrollment.journey_version_id
 AND current_milestone.id = enrollment.current_milestone_id
LEFT JOIN LATERAL (
  SELECT milestone.name
  FROM app.conversion_journey_milestones AS milestone
  WHERE milestone.workspace_id = conversation.workspace_id
    AND milestone.journey_version_id = enrollment.journey_version_id
    AND milestone.position > coalesce(current_milestone.position, 0)
  ORDER BY milestone.position, milestone.id
  LIMIT 1
) AS next_milestone ON true
LEFT JOIN LATERAL (
  SELECT snapshot.total_score
  FROM app.lead_score_snapshots AS snapshot
  WHERE snapshot.workspace_id = conversation.workspace_id
    AND snapshot.contact_id = conversation.contact_id
    AND snapshot.enrollment_id = enrollment.id
  ORDER BY snapshot.evaluated_at DESC, snapshot.id DESC
  LIMIT 1
) AS score ON true
LEFT JOIN LATERAL (
  SELECT stage.name
  FROM app.opportunities AS opportunity
  JOIN app.pipeline_stages AS stage
    ON stage.workspace_id = opportunity.workspace_id
   AND stage.pipeline_id = opportunity.pipeline_id
   AND stage.id = opportunity.stage_id
  WHERE opportunity.workspace_id = conversation.workspace_id
    AND opportunity.contact_id = conversation.contact_id
  ORDER BY (opportunity.status = 'open') DESC,
           opportunity.updated_at DESC, opportunity.id DESC
  LIMIT 1
) AS opportunity_stage ON true
LEFT JOIN LATERAL (
  SELECT fact.referral_code
  FROM app.contact_attribution_facts AS fact
  WHERE fact.workspace_id = conversation.workspace_id
    AND fact.contact_id = conversation.contact_id
    AND fact.attribution_type = 'affiliate_referral'
  ORDER BY fact.attributed_at DESC, fact.id DESC
  LIMIT 1
) AS attribution ON true
LEFT JOIN LATERAL (
  SELECT request.id, decision.decision,
         coalesce(decision.decision_note, request.review_note) AS approval_note
  FROM app.message_approval_requests AS request
  LEFT JOIN app.message_approval_decisions AS decision
    ON decision.workspace_id = request.workspace_id
   AND decision.approval_request_id = request.id
  WHERE request.workspace_id = conversation.workspace_id
    AND request.conversation_id = conversation.id
    AND request.message_id = draft.id
    AND request.message_version_id = draft.current_version_id
    AND request.version_number = draft.current_version_number
    AND request.body_sha256 = draft.current_body_sha256
  ORDER BY request.request_number DESC, request.id DESC
  LIMIT 1
) AS approval ON true
LEFT JOIN LATERAL (
  SELECT delivery.status, delivery.purpose
  FROM app.message_deliveries AS delivery
  WHERE delivery.workspace_id = conversation.workspace_id
    AND delivery.conversation_id = conversation.id
    AND delivery.message_id = draft.id
    AND delivery.message_version_id = draft.current_version_id
    AND delivery.version_number = draft.current_version_number
    AND delivery.body_sha256 = draft.current_body_sha256
    AND delivery.environment = conversation.environment
  ORDER BY delivery.updated_at DESC, delivery.id DESC
  LIMIT 1
) AS draft_delivery ON true
LEFT JOIN LATERAL (
  SELECT delivery.status AS delivery_status,
         operation.state AS operation_state,
         operation.correlation_id,
         latest_attempt.attempt_kind,
         latest_attempt.state AS attempt_state,
         greatest(
           operation.updated_at,
           delivery.updated_at,
           coalesce(
             latest_attempt.completed_at,
             latest_attempt.started_at,
             operation.updated_at
           )
         ) AS occurred_at
  FROM app.message_deliveries AS delivery
  JOIN app.provider_operations AS operation
    ON operation.workspace_id = delivery.workspace_id
   AND operation.id = delivery.provider_operation_id
   AND operation.message_delivery_id = delivery.id
   AND operation.environment = delivery.environment
  JOIN app.provider_connections AS rail_connection
    ON rail_connection.workspace_id = operation.workspace_id
   AND rail_connection.id = operation.provider_connection_id
   AND rail_connection.environment = operation.environment
   AND (
     (conversation.environment = 'test'
       AND rail_connection.provider_id = 'test_conversation')
     OR (conversation.environment = 'live'
       AND app_private.operational_inbox_live_delivery_linked(
         delivery.workspace_id, delivery.id, operation.id, conversation.channel
       ))
   )
  LEFT JOIN LATERAL (
    SELECT attempt.attempt_kind, attempt.state,
           attempt.completed_at, attempt.started_at
    FROM app.provider_operation_attempts AS attempt
    WHERE attempt.workspace_id = operation.workspace_id
      AND attempt.provider_operation_id = operation.id
    ORDER BY attempt.attempt_number DESC, attempt.id DESC
    LIMIT 1
  ) AS latest_attempt ON true
  WHERE delivery.workspace_id = conversation.workspace_id
    AND delivery.conversation_id = conversation.id
    AND delivery.environment = conversation.environment
  ORDER BY operation.updated_at DESC, delivery.updated_at DESC, delivery.id DESC
  LIMIT 1
) AS rail_activity ON true
LEFT JOIN LATERAL (
  SELECT consent.purpose
  FROM app.communication_consent_events AS consent
  WHERE consent.workspace_id = conversation.workspace_id
    AND consent.contact_id = conversation.contact_id
    AND consent.contact_point_id = selected_point.id
    AND consent.channel = CASE conversation.channel
      WHEN 'instagram' THEN 'social'
      WHEN 'facebook' THEN 'social'
      WHEN 'linkedin' THEN 'social'
      ELSE conversation.channel
    END
    AND consent.endpoint_identity_sha256 = public.digest(
      (CASE conversation.channel
        WHEN 'email' THEN 'email'
        WHEN 'sms' THEN 'phone'
        WHEN 'whatsapp' THEN 'whatsapp'
        ELSE 'social'
      END) || pg_catalog.chr(31)
        || (SELECT point.value FROM app.contact_points AS point
            WHERE point.workspace_id = conversation.workspace_id
              AND point.id = selected_point.id)
        || pg_catalog.chr(31)
        || (SELECT point.normalized_value FROM app.contact_points AS point
            WHERE point.workspace_id = conversation.workspace_id
              AND point.id = selected_point.id)
      , 'sha256'
    )
    AND consent.occurred_at <= statement_timestamp() + interval '5 minutes'
  ORDER BY consent.occurred_at DESC, consent.recorded_at DESC, consent.id DESC
  LIMIT 1
) AS current_consent ON true
LEFT JOIN LATERAL (
  SELECT task.id AS task_id, task.status AS task_status,
         task.priority AS task_priority, task.title AS task_title,
         task.due_at AS task_due_at, task.row_version AS task_row_version,
         outcome.outcome, outcome.summary AS outcome_summary,
         outcome.occurred_at AS outcome_at,
         next_task.id AS next_task_id, next_task.title AS next_task_title,
         next_task.due_at AS next_task_due_at
  FROM app.property_predator_admin_call_task_origins AS origin
  JOIN app.tasks AS task
    ON task.workspace_id = origin.workspace_id AND task.id = origin.task_id
  LEFT JOIN app.property_predator_admin_call_outcomes AS outcome
    ON outcome.workspace_id = origin.workspace_id AND outcome.origin_id = origin.id
  LEFT JOIN app.tasks AS next_task
    ON next_task.workspace_id = outcome.workspace_id AND next_task.id = outcome.next_task_id
  WHERE origin.workspace_id = conversation.workspace_id
    AND origin.conversation_id = conversation.id
  ORDER BY (task.status = 'open') DESC, origin.recorded_at DESC, origin.id DESC
  LIMIT 1
) AS admin_call ON true
WHERE conversation.id = $1
  AND (
    conversation.environment = 'test'
    OR (
      conversation.environment = 'live'
      AND app_private.operational_inbox_live_conversation_visible(
        conversation.workspace_id, conversation.id, conversation.channel
      )
    )
  )`;

const TRANSCRIPT_SQL = `/* portal.conversion-inbox.thread-transcript */
SELECT message.id AS "messageId", message.direction, message.lifecycle,
       message.source_kind AS "sourceKind",
       version.body_text AS body, message.occurred_at AS "occurredAt",
       delivery.status AS "deliveryStatus",
       coalesce(test_inbound.receipt_id, live_inbound.receipt_id)
         AS "inboundReceiptId",
       coalesce(live_inbound.provider_family, test_inbound.provider_family)
         AS "inboundProviderFamily",
       coalesce(live_inbound.network, test_inbound.network) AS "inboundNetwork",
       coalesce(test_inbound.received_at, live_inbound.verified_at)
         AS "inboundVerifiedAt"
FROM app.messages AS message
JOIN app.message_versions AS version
  ON version.workspace_id = message.workspace_id
 AND version.conversation_id = message.conversation_id
 AND version.message_id = message.id
 AND version.id = message.current_version_id
 AND version.version_number = message.current_version_number
 AND version.body_sha256 = message.current_body_sha256
LEFT JOIN LATERAL (
  SELECT candidate.status
  FROM app.message_deliveries AS candidate
  WHERE candidate.workspace_id = message.workspace_id
    AND candidate.conversation_id = message.conversation_id
    AND candidate.message_id = message.id
    AND candidate.message_version_id = message.current_version_id
    AND candidate.version_number = message.current_version_number
    AND candidate.body_sha256 = message.current_body_sha256
    AND candidate.environment = message.environment
  ORDER BY candidate.updated_at DESC, candidate.id DESC
  LIMIT 1
) AS delivery ON true
LEFT JOIN LATERAL app_private.test_inbox_webhook_message_provenance(
  message.workspace_id, message.conversation_id, message.id
) AS test_inbound ON message.environment = 'test'
  AND message.direction = 'inbound'
  AND message.lifecycle = 'received'
  AND message.source_kind = 'verified_webhook'
LEFT JOIN LATERAL app_private.operational_inbox_live_message_provenance(
  message.workspace_id, message.conversation_id, message.id
) AS live_inbound ON message.environment = 'live'
  AND message.direction = 'inbound'
  AND message.lifecycle = 'received'
  AND message.source_kind = 'verified_webhook'
WHERE message.conversation_id = $1
  AND (
    message.environment = 'test'
    OR (
      message.environment = 'live'
      AND app_private.operational_inbox_live_conversation_visible(
        message.workspace_id, message.conversation_id, message.channel
      )
    )
  )
ORDER BY message.occurred_at DESC, message.id DESC
LIMIT $2`;

const CONSENT_SQL = `/* portal.conversion-inbox.thread-consent */
WITH target AS (
  SELECT conversation.workspace_id, conversation.contact_id,
         point.id AS contact_point_id,
         CASE conversation.channel
           WHEN 'instagram' THEN 'social'
           WHEN 'facebook' THEN 'social'
           WHEN 'linkedin' THEN 'social'
           ELSE conversation.channel
         END AS channel,
         point.is_verified AND point.dedupe_state = 'normal'
           AND point.deleted_at IS NULL AS endpoint_available,
         public.digest(
           point.kind || pg_catalog.chr(31) || point.value
             || pg_catalog.chr(31) || point.normalized_value,
           'sha256'
         ) AS endpoint_identity_sha256
  FROM app.conversations AS conversation
  JOIN app.contact_points AS point
    ON point.workspace_id = conversation.workspace_id
   AND point.id = $2
   AND point.contact_id = conversation.contact_id
  WHERE conversation.id = $1
    AND (
      conversation.environment = 'test'
      OR (
        conversation.environment = 'live'
        AND app_private.operational_inbox_live_conversation_visible(
          conversation.workspace_id, conversation.id, conversation.channel
        )
      )
    )
), current_consent AS (
  SELECT target.*, consent.state AS consent_state,
         consent.lawful_basis, consent.purpose,
         consent.occurred_at AS consent_at
  FROM target
  LEFT JOIN LATERAL (
    SELECT event.state, event.lawful_basis, event.purpose, event.occurred_at
    FROM app.communication_consent_events AS event
    WHERE event.workspace_id = target.workspace_id
      AND event.contact_id = target.contact_id
      AND event.contact_point_id = target.contact_point_id
      AND event.channel = target.channel
      AND event.endpoint_identity_sha256 = target.endpoint_identity_sha256
      AND event.occurred_at <= statement_timestamp() + interval '5 minutes'
    ORDER BY event.occurred_at DESC, event.recorded_at DESC, event.id DESC
    LIMIT 1
  ) AS consent ON true
)
SELECT current_consent.channel,
       current_consent.consent_state AS "consentState",
       current_consent.lawful_basis AS "lawfulBasis",
       current_consent.purpose,
       current_consent.consent_at AS "consentAt",
       suppression.state AS "suppressionState",
       suppression.occurred_at AS "suppressionAt",
       current_consent.endpoint_available AS "endpointAvailable"
FROM current_consent
LEFT JOIN LATERAL (
  SELECT effective.state, effective.occurred_at
  FROM (
    SELECT DISTINCT ON (coalesce(event.purpose, ''))
           event.state, event.occurred_at, event.recorded_at, event.id
    FROM app.communication_suppression_events AS event
    WHERE event.workspace_id = current_consent.workspace_id
      AND event.contact_id = current_consent.contact_id
      AND event.contact_point_id = current_consent.contact_point_id
      AND event.channel = current_consent.channel
      AND (event.purpose IS NULL OR event.purpose = current_consent.purpose)
      AND event.endpoint_identity_sha256 = current_consent.endpoint_identity_sha256
      AND event.occurred_at <= statement_timestamp() + interval '5 minutes'
    ORDER BY coalesce(event.purpose, ''), event.occurred_at DESC,
             event.recorded_at DESC, event.id DESC
  ) AS effective
  WHERE effective.state = 'suppressed'
  ORDER BY effective.occurred_at DESC, effective.id DESC
  LIMIT 1
) AS suppression ON true
LIMIT $3`;

function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new Error(`Conversion Inbox thread ${field} is invalid`);
  }
  return value.toLowerCase();
}

function nullableUuid(value: unknown, field: string): string | null {
  return value === null ? null : uuid(value, field);
}

function timestamp(value: unknown, field: string): string {
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`Conversion Inbox thread ${field} is invalid`);
  }
  return parsed.toISOString();
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`Conversion Inbox thread ${field} is invalid`);
  }
  return parsed;
}

function nullableScore(value: unknown): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 100) {
    throw new Error('Conversion Inbox thread score is invalid');
  }
  return parsed;
}

function boundedText(value: unknown, field: string, maxBytes: number, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new Error(`Conversion Inbox thread ${field} is invalid`);
  }
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), 'utf8') <= maxBytes) low = middle;
    else high = middle - 1;
  }
  let end = low;
  if (end > 0) {
    const code = value.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  }
  return value.slice(0, end);
}

function nullableText(value: unknown, field: string, maxBytes: number): string | null {
  return value === null ? null : boundedText(value, field, maxBytes);
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function databaseBody(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.includes('\u0000') || hasUnpairedSurrogate(value)) {
    throw new Error(`Conversion Inbox thread ${field} is invalid`);
  }
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes < 1 || bytes > INBOX_DATABASE_MAX_BODY_BYTES) {
    throw new Error(`Conversion Inbox thread ${field} is invalid`);
  }
  return value;
}

function deliveryState(value: unknown): ConversionInboxDeliveryState {
  if (value === null) return 'not_queued';
  if (typeof value !== 'string' || !DELIVERY_STATES.has(value)) {
    throw new Error('Conversion Inbox thread delivery state is invalid');
  }
  if (value === 'sending') return 'queued';
  if (value === 'reconciliation_required' || value === 'cancelled') return 'failed';
  return value as ConversionInboxDeliveryState;
}

function lifecycleStageLabel(lifecycle: string): string {
  if (lifecycle === 'lead') return 'Lead';
  if (lifecycle === 'customer') return 'Customer';
  if (lifecycle === 'archived') return 'Archived';
  throw new Error('Conversion Inbox thread contact lifecycle is invalid');
}

function approvalState(row: ThreadCoreRow): ConversionInboxApprovalState {
  if (row.approvalRequestId === null) {
    if (row.approvalDecision !== null || row.approvalNote !== null) {
      throw new Error('Conversion Inbox thread approval shape is invalid');
    }
    return 'not_requested';
  }
  uuid(row.approvalRequestId, 'approvalRequestId');
  if (row.approvalDecision === null) return 'pending';
  if (!APPROVAL_STATES.has(row.approvalDecision)) {
    throw new Error('Conversion Inbox thread approval decision is invalid');
  }
  return row.approvalDecision as ConversionInboxApprovalState;
}

function purpose(row: ThreadCoreRow): string {
  const candidate = row.deliveryPurpose ?? row.consentPurpose ?? 'marketing';
  if (!PURPOSE.test(candidate)) throw new Error('Conversion Inbox thread purpose is invalid');
  return candidate;
}

function mapLead(row: ThreadCoreRow): ConversionInboxLeadSnapshot {
  const referral = nullableText(row.referralCode, 'referralCode', 256);
  return Object.freeze({
    contactId: uuid(row.contactId, 'contactId'),
    displayName: boundedText(row.displayName, 'displayName', 512),
    companyName: nullableText(row.companyName, 'companyName', 512),
    stageLabel: row.stageName === null
      ? lifecycleStageLabel(row.lifecycleStatus)
      : boundedText(row.stageName, 'stageName', 256),
    score: nullableScore(row.score),
    sourceLabel: row.source === null
      ? 'Direct / untracked'
      : boundedText(row.source, 'source', 512),
    affiliateLabel: referral === null ? null : `Referral ${referral}`,
    nextMove: row.nextMove === null
      ? null : `Advance to ${boundedText(row.nextMove, 'nextMove', 1_900)}`,
  });
}

function mapDraft(row: ThreadCoreRow): ConversionInboxDraftSnapshot {
  if (row.draftMessageId === null) {
    const hasPartialDraft = row.draftBody !== null || row.draftLifecycle !== null
      || row.draftVersionNumber !== null || row.draftRowVersion !== null
      || row.draftUpdatedAt !== null || row.approvalRequestId !== null
      || row.approvalDecision !== null || row.deliveryStatus !== null;
    if (hasPartialDraft) throw new Error('Conversion Inbox thread draft shape is invalid');
    return Object.freeze({
      messageId: null,
      body: '',
      lifecycle: 'draft',
      versionNumber: null,
      approvalState: 'not_requested',
      approvalNote: null,
      deliveryState: 'not_queued',
      updatedAt: null,
      rowVersion: null,
      approvalRequestId: null,
      purpose: purpose(row),
    });
  }
  if (row.draftBody === null || row.draftLifecycle === null
      || row.draftVersionNumber === null || row.draftRowVersion === null
      || row.draftUpdatedAt === null || !DRAFT_LIFECYCLES.has(row.draftLifecycle)) {
    throw new Error('Conversion Inbox thread draft shape is invalid');
  }
  return Object.freeze({
    messageId: uuid(row.draftMessageId, 'draftMessageId'),
    body: databaseBody(row.draftBody, 'draftBody'),
    lifecycle: row.draftLifecycle as ConversionInboxDraftSnapshot['lifecycle'],
    versionNumber: positiveInteger(row.draftVersionNumber, 'draftVersionNumber'),
    approvalState: approvalState(row),
    approvalNote: nullableText(row.approvalNote, 'approvalNote', 2_048),
    deliveryState: deliveryState(row.deliveryStatus),
    updatedAt: timestamp(row.draftUpdatedAt, 'draftUpdatedAt'),
    rowVersion: positiveInteger(row.draftRowVersion, 'draftRowVersion'),
    approvalRequestId: nullableUuid(row.approvalRequestId, 'approvalRequestId'),
    purpose: purpose(row),
  });
}

function mapRailActivity(row: ThreadCoreRow): ConversionInboxRailActivitySnapshot | null {
  const fields = [
    row.railDeliveryStatus,
    row.railOperationState,
    row.railCorrelationId,
    row.railAttemptKind,
    row.railAttemptState,
    row.railOccurredAt,
  ];
  if (fields.every((value) => value === null)) return null;
  if (row.railDeliveryStatus === null || row.railOperationState === null
      || row.railCorrelationId === null || row.railOccurredAt === null
      || !DELIVERY_STATES.has(row.railDeliveryStatus)
      || !OPERATION_STATES.has(row.railOperationState)
      || ((row.railAttemptKind === null) !== (row.railAttemptState === null))
      || (row.railAttemptKind !== null && !ATTEMPT_KINDS.has(row.railAttemptKind))
      || (row.railAttemptState !== null && !ATTEMPT_STATES.has(row.railAttemptState))) {
    throw new Error('Conversion Inbox TEST rail activity is invalid');
  }

  const needsAttention = ['failed', 'reconciliation_required', 'cancelled']
    .includes(row.railDeliveryStatus)
    || ['failed', 'reconciliation_required', 'dead_letter', 'cancelled']
      .includes(row.railOperationState);
  let state: ConversionInboxRailActivitySnapshot['state'];
  if (needsAttention) {
    state = 'attention';
  } else if (row.environment === 'live'
      && row.railAttemptKind === null && row.railAttemptState === null
      && ['delivered', 'read'].includes(row.railDeliveryStatus)
      && ['accepted', 'succeeded'].includes(row.railOperationState)) {
    // Live rails keep their attempts in channel-specific, table-blind ledgers.
    // The bounded live-delivery definer above has already proved that this
    // delivery belongs to the exact channel job. A terminal delivery/read
    // state is therefore signed-receipt evidence even though the shared TEST
    // attempt table intentionally has no row for it.
    state = 'reconciled';
  } else if (row.environment === 'live'
      && row.railAttemptKind === null && row.railAttemptState === null
      && row.railDeliveryStatus === 'accepted'
      && ['accepted', 'succeeded'].includes(row.railOperationState)) {
    // Provider acceptance remains distinct from final delivery evidence.
    state = 'accepted';
  } else if (row.railAttemptKind === 'reconcile'
      && ['accepted', 'succeeded'].includes(row.railAttemptState ?? '')
      && ['accepted', 'succeeded'].includes(row.railOperationState)
      && ['accepted', 'delivered', 'read'].includes(row.railDeliveryStatus)) {
    state = 'reconciled';
  } else if (['accepted', 'delivered', 'read'].includes(row.railDeliveryStatus)
      && ['accepted', 'succeeded'].includes(row.railOperationState)
      && row.railAttemptKind === 'dispatch'
      && ['accepted', 'succeeded'].includes(row.railAttemptState ?? '')) {
    state = 'accepted';
  } else if (['queued', 'sending'].includes(row.railDeliveryStatus)
      && ['queued', 'leased', 'calling', 'retry_wait'].includes(row.railOperationState)
      && (row.railAttemptState === null
        || ['leased', 'calling', 'failed'].includes(row.railAttemptState))) {
    state = 'queued';
  } else {
    throw new Error('Conversion Inbox TEST rail activity is inconsistent');
  }

  return Object.freeze({
    state,
    correlationId: uuid(row.railCorrelationId, 'railCorrelationId'),
    occurredAt: timestamp(row.railOccurredAt, 'railOccurredAt'),
  });
}

function mapInboundEvidence(
  row: TranscriptRow,
): ConversionInboxSignedInboundEvidenceSnapshot | null {
  const fields = [row.inboundReceiptId, row.inboundProviderFamily,
    row.inboundNetwork, row.inboundVerifiedAt];
  if (fields.every((value) => value === null)) return null;
  if (fields.some((value) => value === null)
      || row.direction !== 'inbound' || row.lifecycle !== 'received'
      || row.sourceKind !== 'verified_webhook') {
    throw new Error('Conversion Inbox signed inbound provenance is inconsistent');
  }
  const network = row.inboundNetwork;
  const providerFamily = row.inboundProviderFamily;
  if (network !== 'email' && network !== 'whatsapp' && network !== 'sms'
      && network !== 'facebook' && network !== 'instagram' && network !== 'linkedin') {
    throw new Error('Conversion Inbox signed inbound network is invalid');
  }
  const source = providerFamily === 'mailgun_email' && network === 'email'
    ? 'mailgun_eu'
    : providerFamily === 'twilio_sms_live' && network === 'sms'
    ? 'twilio_sms'
    : providerFamily === 'meta_whatsapp_live' && network === 'whatsapp'
    ? 'meta_whatsapp_cloud'
    : providerFamily === 'whatsapp' && network === 'whatsapp'
    ? 'whatsapp_simulator'
    : providerFamily === 'social_dm' && (network === 'facebook' || network === 'instagram')
      ? 'social_dm_simulator'
    : providerFamily === 'zernio_social_live'
        && (network === 'instagram' || network === 'linkedin')
      ? 'zernio' : null;
  if (source === null) {
    throw new Error('Conversion Inbox signed inbound provider is inconsistent');
  }
  return Object.freeze({
    kind: source === 'mailgun_eu'
      ? 'signed_mailgun_inbound'
      : source === 'twilio_sms'
        ? 'signed_twilio_sms_inbound'
      : source === 'meta_whatsapp_cloud'
        ? 'signed_meta_whatsapp_inbound'
      : source === 'zernio'
        ? 'signed_zernio_inbound'
        : 'signed_simulator_event',
    source,
    network,
    receiptId: uuid(row.inboundReceiptId, 'inboundReceiptId'),
    verifiedAt: timestamp(row.inboundVerifiedAt, 'inboundVerifiedAt'),
  });
}

function mapTranscript(
  rows: readonly TranscriptRow[],
  displayName: string,
): readonly ConversionInboxTranscriptMessageSnapshot[] {
  if (rows.length > CONVERSION_INBOX_MAX_MESSAGES + 1) {
    throw new Error('Conversion Inbox thread transcript exceeded its bound');
  }
  return Object.freeze(rows.map((row) => {
    if (!DIRECTIONS.has(row.direction) || !LIFECYCLES.has(row.lifecycle)) {
      throw new Error('Conversion Inbox thread transcript state is invalid');
    }
    const state = row.deliveryStatus === null ? null : deliveryState(row.deliveryStatus);
    return Object.freeze({
      messageId: uuid(row.messageId, 'messageId'),
      direction: row.direction as ConversionInboxTranscriptMessageSnapshot['direction'],
      lifecycle: row.lifecycle as ConversionInboxTranscriptMessageSnapshot['lifecycle'],
      authorLabel: row.direction === 'inbound' ? displayName
        : row.direction === 'internal_note' ? 'Internal note' : 'Growth team',
      body: databaseBody(row.body, 'messageBody'),
      occurredAt: timestamp(row.occurredAt, 'occurredAt'),
      inboundEvidence: mapInboundEvidence(row),
      ...(state === null ? {} : { deliveryState: state }),
    });
  }).reverse());
}

function consentState(row: ConsentRow): ConversionInboxConsentState {
  if (!row.endpointAvailable) return 'unknown';
  if (row.suppressionState === 'suppressed') return 'suppressed';
  if (row.suppressionState !== null) {
    throw new Error('Conversion Inbox thread suppression state is invalid');
  }
  if (row.consentState === null) return 'unknown';
  if (!CONSENT_STATES.has(row.consentState)) {
    throw new Error('Conversion Inbox thread consent state is invalid');
  }
  if (row.consentState === 'granted') return 'permitted';
  return row.consentState as Extract<ConversionInboxConsentState, 'denied' | 'withdrawn'>;
}

function laterTimestamp(first: unknown, second: unknown): string | null {
  if (first === null && second === null) return null;
  if (first === null) return timestamp(second, 'suppressionAt');
  if (second === null) return timestamp(first, 'consentAt');
  const a = timestamp(first, 'consentAt');
  const b = timestamp(second, 'suppressionAt');
  return a >= b ? a : b;
}

function mapConsents(rows: readonly ConsentRow[]): readonly ConversionInboxConsentSnapshot[] {
  if (rows.length > CONVERSION_INBOX_MAX_CONSENTS) {
    throw new Error('Conversion Inbox thread consent result exceeded its bound');
  }
  return Object.freeze(rows.map((row) => {
    if (!CONSENT_CHANNELS.has(row.channel) || typeof row.endpointAvailable !== 'boolean') {
      throw new Error('Conversion Inbox thread consent channel is invalid');
    }
    const consent = row.consentState;
    if (consent !== null && !CONSENT_STATES.has(consent)) {
      throw new Error('Conversion Inbox thread consent state is invalid');
    }
    const basis = row.lawfulBasis === null && row.purpose === null ? null
      : `${row.lawfulBasis ?? 'recorded'} · ${row.purpose ?? 'unspecified'}`;
    return Object.freeze({
      channel: row.channel as ConversionInboxConsentSnapshot['channel'],
      state: consentState(row),
      basis: basis === null ? null : boundedText(basis, 'consentBasis', 2_048),
      updatedAt: laterTimestamp(row.consentAt, row.suppressionAt),
    });
  }));
}

function mapAdminCall(row: ThreadCoreRow): ConversionInboxAdminCallSnapshot | null {
  if (row.adminCallTaskId === null || row.adminCallTaskId === undefined) return null;
  const taskStatus = row.adminCallStatus;
  const taskPriority = row.adminCallPriority;
  if ((taskStatus !== 'open' && taskStatus !== 'completed')
      || (taskPriority !== 'normal' && taskPriority !== 'high' && taskPriority !== 'urgent')
      || row.adminCallTitle === null || row.adminCallDueAt === null
      || row.adminCallTaskRowVersion === null) {
    throw new Error('Conversion Inbox admin-call projection is invalid');
  }
  const outcomePresent = row.adminCallOutcome !== null;
  if (outcomePresent !== (row.adminCallOutcomeSummary !== null && row.adminCallOutcomeAt !== null)) {
    throw new Error('Conversion Inbox admin-call outcome projection is partial');
  }
  const nextPresent = row.adminCallNextTaskId !== null;
  if (nextPresent !== (row.adminCallNextTaskTitle !== null && row.adminCallNextTaskDueAt !== null)) {
    throw new Error('Conversion Inbox admin-call next action projection is partial');
  }
  return Object.freeze({
    taskId: uuid(row.adminCallTaskId, 'adminCallTaskId'),
    taskStatus,
    taskPriority,
    taskTitle: boundedText(row.adminCallTitle, 'adminCallTitle', 2_048),
    dueAt: timestamp(row.adminCallDueAt, 'adminCallDueAt'),
    taskRowVersion: positiveInteger(row.adminCallTaskRowVersion, 'adminCallTaskRowVersion'),
    outcome: row.adminCallOutcome === null
      ? null : boundedText(row.adminCallOutcome, 'adminCallOutcome', 128),
    outcomeSummary: row.adminCallOutcomeSummary === null
      ? null : boundedText(row.adminCallOutcomeSummary, 'adminCallOutcomeSummary', 8_000),
    outcomeAt: row.adminCallOutcomeAt === null
      ? null : timestamp(row.adminCallOutcomeAt, 'adminCallOutcomeAt'),
    nextTaskId: row.adminCallNextTaskId === null
      ? null : uuid(row.adminCallNextTaskId, 'adminCallNextTaskId'),
    nextTaskTitle: row.adminCallNextTaskTitle === null
      ? null : boundedText(row.adminCallNextTaskTitle, 'adminCallNextTaskTitle', 2_048),
    nextTaskDueAt: row.adminCallNextTaskDueAt === null
      ? null : timestamp(row.adminCallNextTaskDueAt, 'adminCallNextTaskDueAt'),
  });
}

export class PgConversionInboxThreadReadService implements ConversionInboxThreadReadService {
  constructor(private readonly pool: Pick<Pool, 'connect'>) {}

  async thread(
    context: DatabaseRequestContext,
    conversationId: string,
  ): Promise<ConversionInboxThreadSnapshot | null> {
    validateDatabaseContext(context);
    if (context.actorKind !== 'user' || !context.userId) {
      throw new Error('Conversion Inbox thread reads require an authenticated workspace member');
    }
    const id = uuid(conversationId, 'conversationId');
    return withTransaction(this.pool, context, async (transaction) => {
      const coreResult = await transaction.query<ThreadCoreRow>(THREAD_CORE_SQL, [id]);
      if (coreResult.rows.length === 0) return null;
      const core = coreResult.rows[0];
      if (coreResult.rows.length !== 1 || !core) {
        throw new Error('Conversion Inbox thread core result is invalid');
      }
      const canonicalConversationId = uuid(core.conversationId, 'conversationId');
      if (canonicalConversationId !== id) {
        throw new Error('Conversion Inbox thread returned a mismatched conversation');
      }
      const contactPointId = nullableUuid(core.contactPointId, 'contactPointId');
      const transcriptResult = await transaction.query<TranscriptRow>(TRANSCRIPT_SQL, [
        id, CONVERSION_INBOX_MAX_MESSAGES + 1,
      ]);
      const consentResult = contactPointId === null
        ? { rows: [] as ConsentRow[] }
        : await transaction.query<ConsentRow>(CONSENT_SQL, [
          id, contactPointId, CONVERSION_INBOX_MAX_CONSENTS,
        ]);
      const lead = mapLead(core);
      if (core.environment !== 'test' && core.environment !== 'live') {
        throw new Error('Conversion Inbox thread environment is invalid');
      }
      return Object.freeze({
        conversationId: canonicalConversationId,
        environment: core.environment,
        contactPointId,
        messages: mapTranscript(transcriptResult.rows, lead.displayName),
        lead,
        consents: mapConsents(consentResult.rows),
        draft: mapDraft(core),
        railActivity: mapRailActivity(core),
        adminCall: mapAdminCall(core),
      });
    }, { readOnly: true, isolation: 'repeatable read' });
  }
}

export function createPgConversionInboxThreadReadService(
  pool: Pick<Pool, 'connect'>,
): ConversionInboxThreadReadService {
  return new PgConversionInboxThreadReadService(pool);
}
