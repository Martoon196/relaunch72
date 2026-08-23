import type { Pool, QueryResultRow } from 'pg';
import type { PlatformEvent } from '../platform/events.js';
import type { DatabaseActorKind, DatabaseRequestContext } from '../db/rls.js';
import { withTransaction } from '../db/transaction.js';
import type {
  ContactPointConsent,
  ContactPointKind,
  CrmTransactionRunner,
  OpportunityStatus,
  SqlExecutor,
} from './types.js';

export interface CommandReceiptClaim {
  id: string;
  inserted: boolean;
  payloadHash: Uint8Array;
  status: 'started' | 'succeeded' | 'failed';
  result: unknown;
}

interface ReceiptRow extends QueryResultRow {
  id: string;
  payloadHash: Uint8Array;
  status: 'started' | 'succeeded' | 'failed';
  result: unknown;
}

export interface ContactPointRecord {
  id: string;
  contactId: string;
  contactState: 'active' | 'archived' | 'deleted';
}

interface ContactPointRow extends QueryResultRow {
  id: string;
  contactId: string;
  contactState: 'active' | 'archived' | 'deleted';
}

export interface PipelineStageRecord {
  id: string;
  pipelineId: string;
  status: OpportunityStatus;
}

interface PipelineStageRow extends QueryResultRow {
  id: string;
  pipelineId: string;
  status: OpportunityStatus;
}

export interface OpportunityRecord {
  id: string;
  contactId: string;
  pipelineId: string;
  stageId: string;
  status: OpportunityStatus;
  rowVersion: number;
}

interface OpportunityRow extends QueryResultRow {
  id: string;
  contactId: string;
  pipelineId: string;
  stageId: string;
  status: OpportunityStatus;
  rowVersion: string | number;
}

export interface TaskRecord {
  id: string;
  contactId: string | null;
  opportunityId: string | null;
  status: 'open' | 'completed' | 'cancelled';
  rowVersion: number;
}

interface TaskRow extends QueryResultRow {
  id: string;
  contactId: string | null;
  opportunityId: string | null;
  status: 'open' | 'completed' | 'cancelled';
  rowVersion: string | number;
}

/**
 * SQL-only repository scoped to a transaction whose RLS context is already set.
 * Methods intentionally never accept a workspace ID; the database setting and
 * forced RLS are the tenant boundary.
 */
export class CrmPgRepository {
  constructor(private readonly transaction: SqlExecutor) {}

  async claimCommand(input: {
    id: string;
    commandName: string;
    commandKey: string;
    requestId: string;
    actorUserId: string | null;
    payloadHash: Uint8Array;
    createdAt: string;
  }): Promise<CommandReceiptClaim> {
    const result = await this.transaction.query<ReceiptRow>(
      `/* crm.claim-command */
       INSERT INTO app.command_receipts (
         id, workspace_id, command_name, idempotency_key, request_id,
         actor_user_id, payload_hash, status, created_at
       ) VALUES (
         $1, app_private.current_workspace_id(), $2, $3, $4,
         $5, $6, 'started', $7::timestamptz
       )
       ON CONFLICT (workspace_id, actor_user_id, command_name, idempotency_key) DO NOTHING
       RETURNING id, payload_hash AS "payloadHash", status, result`,
      [
        input.id,
        input.commandName,
        input.commandKey,
        input.requestId,
        input.actorUserId,
        input.payloadHash,
        input.createdAt,
      ],
    );
    const inserted = result.rows[0];
    if (inserted) return { ...inserted, inserted: true };

    // A separate statement is intentional. If ON CONFLICT waited for another
    // transaction, READ COMMITTED gives this SELECT a fresh snapshot that can
    // see the now-committed receipt; a one-statement CTE cannot guarantee that.
    const existing = await this.transaction.query<ReceiptRow>(
      `/* crm.read-command-receipt */
       SELECT id, payload_hash AS "payloadHash", status, result
       FROM app.command_receipts
       WHERE actor_user_id = $1 AND command_name = $2 AND idempotency_key = $3
       FOR UPDATE`,
      [input.actorUserId, input.commandName, input.commandKey],
    );
    const row = existing.rows[0];
    if (!row) throw new Error('Command receipt conflict was not visible after claim');
    return { ...row, inserted: false };
  }

  async completeCommand(input: {
    receiptId: string;
    payloadHash: Uint8Array;
    result: unknown;
    completedAt: string;
  }): Promise<void> {
    const update = await this.transaction.query<{ id: string }>(
      `/* crm.complete-command */
       UPDATE app.command_receipts
       SET status = 'succeeded', result = $3::jsonb, response_status = 200,
           completed_at = $4::timestamptz
       WHERE id = $1 AND status = 'started' AND payload_hash = $2
       RETURNING id`,
      [input.receiptId, input.payloadHash, JSON.stringify(input.result), input.completedAt],
    );
    if (update.rowCount !== 1) throw new Error('Command receipt completion lost its claim');
  }

  async findContactPoint(kind: ContactPointKind, normalizedValue: string): Promise<ContactPointRecord | null> {
    const result = await this.transaction.query<ContactPointRow>(
      `/* crm.find-contact-point */
       SELECT point.id,
              point.contact_id AS "contactId",
              CASE
                WHEN contact.deleted_at IS NOT NULL THEN 'deleted'
                WHEN contact.lifecycle_status = 'archived' THEN 'archived'
                ELSE 'active'
              END AS "contactState"
       FROM app.contact_points AS point
       INNER JOIN app.contacts AS contact
         ON contact.workspace_id = point.workspace_id
        AND contact.id = point.contact_id
       WHERE point.kind = $1 AND point.normalized_value = $2
         AND point.deleted_at IS NULL AND point.dedupe_state = 'normal'
       ORDER BY point.id
       LIMIT 1
       FOR UPDATE OF point, contact`,
      [kind, normalizedValue],
    );
    return result.rows[0] ?? null;
  }

  async insertContact(input: {
    id: string;
    displayName: string;
    companyName: string | null;
    ownerUserId: string | null;
    source: string | null;
    createdAt: string;
  }): Promise<void> {
    const result = await this.transaction.query<{ id: string }>(
      `/* crm.insert-contact */
       INSERT INTO app.contacts (
         id, workspace_id, display_name, company_name, lifecycle_status,
         owner_user_id, source, custom_fields, row_version, created_at, updated_at
       ) VALUES (
         $1, app_private.current_workspace_id(), $2, $3, 'lead',
         $4, $5, '{}'::jsonb, 1, $6::timestamptz, $6::timestamptz
       )
       RETURNING id`,
      [input.id, input.displayName, input.companyName, input.ownerUserId, input.source, input.createdAt],
    );
    if (result.rowCount !== 1) throw new Error('Contact insert returned no row');
  }

  async insertContactPoint(input: {
    id: string;
    contactId: string;
    kind: ContactPointKind;
    label: string | null;
    value: string;
    normalizedValue: string;
    isPrimary: boolean;
    consentStatus: ContactPointConsent;
    createdAt: string;
  }): Promise<boolean> {
    const result = await this.transaction.query<{ id: string }>(
      `/* crm.insert-contact-point */
       INSERT INTO app.contact_points (
         id, workspace_id, contact_id, kind, label, value, normalized_value,
         is_primary, consent_status, row_version, created_at, updated_at
       ) VALUES (
         $1, app_private.current_workspace_id(), $2, $3, $4, $5, $6,
         $7, $8, 1, $9::timestamptz, $9::timestamptz
       )
       ON CONFLICT (workspace_id, kind, normalized_value)
         WHERE deleted_at IS NULL AND dedupe_state = 'normal'
         DO NOTHING
       RETURNING id`,
      [
        input.id,
        input.contactId,
        input.kind,
        input.label,
        input.value,
        input.normalizedValue,
        input.isPrimary,
        input.consentStatus,
        input.createdAt,
      ],
    );
    return result.rowCount === 1;
  }

  async hasPrimaryContactPoint(contactId: string, kind: ContactPointKind): Promise<boolean> {
    const result = await this.transaction.query<{ id: string }>(
      `/* crm.has-primary-contact-point */
       SELECT id
       FROM app.contact_points
       WHERE contact_id = $1
         AND kind = $2
         AND is_primary
         AND deleted_at IS NULL
       ORDER BY id
       LIMIT 1`,
      [contactId, kind],
    );
    return result.rows.length > 0;
  }

  async getPipelineStage(stageId: string, pipelineId: string): Promise<PipelineStageRecord | null> {
    const result = await this.transaction.query<PipelineStageRow>(
      `/* crm.get-pipeline-stage */
       SELECT id, pipeline_id AS "pipelineId", status
       FROM app_private.lock_active_default_pipeline_stage($1, $2)`,
      [stageId, pipelineId],
    );
    return result.rows[0] ?? null;
  }

  async insertOpportunity(input: {
    id: string;
    contactId: string;
    pipelineId: string;
    stageId: string;
    name: string;
    status: OpportunityStatus;
    valueMinor: number;
    currency: string;
    ownerUserId: string | null;
    createdAt: string;
  }): Promise<void> {
    const result = await this.transaction.query<{ id: string }>(
      `/* crm.insert-opportunity */
       INSERT INTO app.opportunities (
         id, workspace_id, contact_id, pipeline_id, stage_id, name, status,
         value_minor, currency, owner_user_id, row_version, created_at, updated_at
       ) VALUES (
         $1, app_private.current_workspace_id(), $2, $3, $4, $5, $6,
         $7, $8, $9, 1, $10::timestamptz, $10::timestamptz
       )
       RETURNING id`,
      [
        input.id,
        input.contactId,
        input.pipelineId,
        input.stageId,
        input.name,
        input.status,
        input.valueMinor,
        input.currency,
        input.ownerUserId,
        input.createdAt,
      ],
    );
    if (result.rowCount !== 1) throw new Error('Opportunity insert returned no row');
  }

  async insertTask(input: {
    id: string;
    contactId: string | null;
    opportunityId: string | null;
    title: string;
    description: string | null;
    assigneeUserId: string | null;
    dueAt: string | null;
    createdAt: string;
  }): Promise<void> {
    const result = await this.transaction.query<{ id: string }>(
      `/* crm.insert-task */
       INSERT INTO app.tasks (
         id, workspace_id, contact_id, opportunity_id, title, description,
         assignee_user_id, status, due_at, row_version, created_at, updated_at
       ) VALUES (
         $1, app_private.current_workspace_id(), $2, $3, $4, $5,
         $6, 'open', $7::timestamptz, 1, $8::timestamptz, $8::timestamptz
       )
       RETURNING id`,
      [
        input.id,
        input.contactId,
        input.opportunityId,
        input.title,
        input.description,
        input.assigneeUserId,
        input.dueAt,
        input.createdAt,
      ],
    );
    if (result.rowCount !== 1) throw new Error('Task insert returned no row');
  }

  async lockOpportunity(opportunityId: string): Promise<OpportunityRecord | null> {
    const result = await this.transaction.query<OpportunityRow>(
      `/* crm.lock-opportunity */
       SELECT id, contact_id AS "contactId", pipeline_id AS "pipelineId",
              stage_id AS "stageId", status, row_version AS "rowVersion"
       FROM app.opportunities
       WHERE id = $1
       FOR UPDATE`,
      [opportunityId],
    );
    const row = result.rows[0];
    return row ? { ...row, rowVersion: Number(row.rowVersion) } : null;
  }

  async updateOpportunityStage(input: {
    opportunityId: string;
    targetStageId: string;
    targetStatus: OpportunityStatus;
    expectedRowVersion: number;
    changedAt: string;
  }): Promise<number | null> {
    const result = await this.transaction.query<{ rowVersion: string | number }>(
      `/* crm.update-opportunity-stage */
       UPDATE app.opportunities
       SET stage_id = $2,
           status = $3,
           closed_at = CASE WHEN $3 = 'open' THEN NULL ELSE $5::timestamptz END,
           row_version = row_version + 1,
           updated_at = $5::timestamptz
       WHERE id = $1 AND row_version = $4
       RETURNING row_version AS "rowVersion"`,
      [
        input.opportunityId,
        input.targetStageId,
        input.targetStatus,
        input.expectedRowVersion,
        input.changedAt,
      ],
    );
    const row = result.rows[0];
    return row ? Number(row.rowVersion) : null;
  }

  async insertStageHistory(input: {
    id: string;
    pipelineId: string;
    opportunityId: string;
    fromStageId: string;
    toStageId: string;
    changedByUserId: string | null;
    actorKind: DatabaseActorKind;
    requestId: string;
    correlationId: string;
    note: string | null;
    changedAt: string;
  }): Promise<void> {
    await this.transaction.query(
      `/* crm.insert-stage-history */
       INSERT INTO app.opportunity_stage_history (
         id, workspace_id, pipeline_id, opportunity_id, from_stage_id,
         to_stage_id, actor_kind, changed_by_user_id, request_id,
         correlation_id, note, changed_at
       ) VALUES (
         $1, app_private.current_workspace_id(), $2, $3, $4,
         $5, $6, $7, $8, $9, $10, $11::timestamptz
       )`,
      [
        input.id,
        input.pipelineId,
        input.opportunityId,
        input.fromStageId,
        input.toStageId,
        input.actorKind,
        input.changedByUserId,
        input.requestId,
        input.correlationId,
        input.note,
        input.changedAt,
      ],
    );
  }

  async lockTask(taskId: string): Promise<TaskRecord | null> {
    const result = await this.transaction.query<TaskRow>(
      `/* crm.lock-task */
       SELECT id, contact_id AS "contactId", opportunity_id AS "opportunityId",
              status, row_version AS "rowVersion"
       FROM app.tasks
       WHERE id = $1
       FOR UPDATE`,
      [taskId],
    );
    const row = result.rows[0];
    return row ? { ...row, rowVersion: Number(row.rowVersion) } : null;
  }

  async completeTask(input: {
    taskId: string;
    expectedRowVersion: number;
    completedByUserId: string | null;
    completedAt: string;
  }): Promise<number | null> {
    const result = await this.transaction.query<{ rowVersion: string | number }>(
      `/* crm.complete-task */
       UPDATE app.tasks
       SET status = 'completed', completed_at = $3::timestamptz,
           completed_by_user_id = $4, row_version = row_version + 1,
           updated_at = $3::timestamptz
       WHERE id = $1 AND row_version = $2 AND status = 'open'
       RETURNING row_version AS "rowVersion"`,
      [input.taskId, input.expectedRowVersion, input.completedAt, input.completedByUserId],
    );
    const row = result.rows[0];
    return row ? Number(row.rowVersion) : null;
  }

  async insertActivity(input: {
    id: string;
    contactId: string | null;
    opportunityId: string | null;
    taskId: string | null;
    activityType: string;
    actorUserId: string | null;
    actorKind: DatabaseActorKind;
    subject: string;
    body: string | null;
    metadata: Readonly<Record<string, unknown>>;
    requestId: string;
    correlationId: string;
    causationId: string | null;
    occurredAt: string;
  }): Promise<void> {
    await this.transaction.query(
      `/* crm.insert-activity */
       INSERT INTO app.activities (
         id, workspace_id, contact_id, opportunity_id, task_id, activity_type,
         channel, actor_kind, actor_user_id, subject, body, metadata,
         request_id, correlation_id, causation_id, occurred_at, created_at
       ) VALUES (
         $1, app_private.current_workspace_id(), $2, $3, $4, $5,
         'crm', $7, $6, $8, $9, $10::jsonb,
         $11, $12, $13, $14::timestamptz, $14::timestamptz
       )`,
      [
        input.id,
        input.contactId,
        input.opportunityId,
        input.taskId,
        input.activityType,
        input.actorUserId,
        input.actorKind,
        input.subject,
        input.body,
        JSON.stringify(input.metadata),
        input.requestId,
        input.correlationId,
        input.causationId,
        input.occurredAt,
      ],
    );
  }

  async insertOutboxEvent(
    event: PlatformEvent,
    aggregateType: string,
    aggregateId: string,
    requestId: string,
  ): Promise<void> {
    await this.transaction.query(
      `/* crm.insert-outbox-event */
       INSERT INTO app.outbox_events (
         id, workspace_id, aggregate_type, aggregate_id, event_type,
         event_version, idempotency_key, payload, request_id, correlation_id,
         causation_id, occurred_at, available_at, attempt_count, status, created_at
       ) VALUES (
         $1, app_private.current_workspace_id(), $2, $3, $4,
         $5, $1::text, $6::jsonb, $7, $8, $9,
         $10::timestamptz, $10::timestamptz, 0, 'pending', $10::timestamptz
       )`,
      [
        event.id,
        aggregateType,
        aggregateId,
        event.type,
        event.version,
        JSON.stringify(event),
        requestId,
        event.correlationId,
        event.causationId,
        event.occurredAt,
      ],
    );
  }
}

/** Production adapter; the command service still owns exactly one transaction. */
export function createPgCrmTransactionRunner(pool: Pick<Pool, 'connect'>): CrmTransactionRunner {
  return {
    run<T>(context: DatabaseRequestContext, operation: (transaction: SqlExecutor) => Promise<T>): Promise<T> {
      return withTransaction(pool, context, async (client) => operation({
        async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
          sql: string,
          values?: readonly unknown[],
        ) {
          const result = await client.query<TRow>(sql, values ? [...values] : undefined);
          return { rows: result.rows, rowCount: result.rowCount };
        },
      }));
    },
  };
}
