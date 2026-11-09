import type { Pool, QueryResultRow } from 'pg';
import type { DatabaseRequestContext } from '../db/rls.js';
import { withTransaction } from '../db/transaction.js';
import {
  PROPERTY_PREDATOR_OWNED_SEED_MESSAGE_EMAIL,
  PropertyPredatorOwnedSeedMessageConflictError,
  type CreateOwnedSeedMessageDraftCommand,
  type CreateOwnedSeedMessageDraftResult,
  type DecideOwnedSeedMessageApprovalCommand,
  type DecideOwnedSeedMessageApprovalResult,
  type PropertyPredatorOwnedSeedMessageRepository,
  type RequestOwnedSeedMessageApprovalCommand,
  type RequestOwnedSeedMessageApprovalResult,
  type ResumeOwnedSeedMessageCommand,
  type ResumeOwnedSeedMessageResult,
} from './types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;

interface DraftRow extends QueryResultRow {
  disposition: string;
  messageId: string;
  messageVersionId: string;
  companyContentVersionId: string;
  companyContentApprovalDecisionId: string;
  subjectSha256: Buffer | string;
  bodySha256: Buffer | string;
  sourceContentSha256: Buffer | string;
}

interface RequestRow extends QueryResultRow {
  disposition: string;
  messageId: string;
  messageVersionId: string;
  approvalRequestId: string;
  subjectSha256: Buffer | string;
  bodySha256: Buffer | string;
  sourceContentSha256: Buffer | string;
}

interface DecisionRow extends RequestRow {
  approvalDecisionId: string;
  decision: string;
}

interface ResumeRow extends QueryResultRow {
  messageId: string;
  messageVersionId: string;
  companyContentVersionId: string;
  phase: string;
  approvalRequestId: string | null;
  subjectSha256: Buffer | string;
  bodySha256: Buffer | string;
  sourceContentSha256: Buffer | string;
}

interface PgErrorLike { readonly code?: unknown }

function uuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new Error(`${label} returned an invalid UUID`);
  }
  return value;
}

function digest(value: Buffer | string, label: string): string {
  const candidate = Buffer.isBuffer(value)
    ? value.toString('hex')
    : value.startsWith('\\x') ? value.slice(2) : value;
  if (!SHA256.test(candidate)) throw new Error(`${label} returned an invalid digest`);
  return candidate;
}

function translateConflict(error: unknown): never {
  if (error && typeof error === 'object'
      && ['22000', '23505', '40001'].includes(String((error as PgErrorLike).code))) {
    throw new PropertyPredatorOwnedSeedMessageConflictError(
      'Owned-seed message evidence changed or the command conflicted',
    );
  }
  throw error;
}

function retryableConcurrentCreate(error: unknown): boolean {
  return Boolean(error && typeof error === 'object'
    && ['23505', '40001'].includes(String((error as PgErrorLike).code)));
}

function evidence(row: DraftRow | RequestRow | DecisionRow | ResumeRow) {
  return Object.freeze({
    subjectSha256: digest(row.subjectSha256, 'subjectSha256'),
    bodySha256: digest(row.bodySha256, 'bodySha256'),
    sourceContentSha256: digest(row.sourceContentSha256, 'sourceContentSha256'),
    recipient: PROPERTY_PREDATOR_OWNED_SEED_MESSAGE_EMAIL,
    providerEffects: false as const,
  });
}

export class PgPropertyPredatorOwnedSeedMessageRepository
implements PropertyPredatorOwnedSeedMessageRepository {
  readonly #commandPool: Pick<Pool, 'connect'>;
  readonly #workspaceId: string;

  constructor(dependencies: Readonly<{
    commandPool: Pick<Pool, 'connect'>;
    workspaceId: string;
  }>) {
    this.#commandPool = dependencies.commandPool;
    this.#workspaceId = uuid(dependencies.workspaceId, 'workspaceId');
  }

  async createDraft(
    context: DatabaseRequestContext,
    command: CreateOwnedSeedMessageDraftCommand,
  ): Promise<CreateOwnedSeedMessageDraftResult> {
    this.#assertWorkspace(context);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await withTransaction(this.#commandPool, context, async (transaction) => {
        const result = await transaction.query<DraftRow>(
          `/* property-predator-owned-seed-message.create-draft */
           SELECT disposition, message_id AS "messageId",
                  message_version_id AS "messageVersionId",
                  company_content_version_id AS "companyContentVersionId",
                  company_content_approval_decision_id AS "companyContentApprovalDecisionId",
                  subject_sha256 AS "subjectSha256", body_sha256 AS "bodySha256",
                  source_content_sha256 AS "sourceContentSha256"
           FROM app_private.create_property_predator_owned_seed_message_draft($1, $2, $3)`,
          [this.#workspaceId, command.companyContentVersionId, command.commandKey],
        );
        const row = result.rows[0];
        if (result.rows.length !== 1 || !row
            || !['created', 'replayed'].includes(row.disposition)) {
          throw new Error('Owned-seed message draft returned invalid canonical data');
        }
        return Object.freeze({
          disposition: row.disposition as 'created' | 'replayed',
          messageId: uuid(row.messageId, 'messageId'),
          messageVersionId: uuid(row.messageVersionId, 'messageVersionId'),
          companyContentVersionId: uuid(row.companyContentVersionId, 'companyContentVersionId'),
          companyContentApprovalDecisionId: uuid(
            row.companyContentApprovalDecisionId,
            'companyContentApprovalDecisionId',
          ),
          ...evidence(row), lifecycleAtCommand: 'draft' as const,
        });
        }, { isolation: 'serializable' });
      } catch (error) {
        // Two tabs may both observe no workflow before the workspace lock.
        // The unique source-version fence elects one winner; one retry sees
        // and replays that immutable winner instead of surfacing an orphaning
        // concurrency error.
        if (attempt === 0 && retryableConcurrentCreate(error)) continue;
        translateConflict(error);
      }
    }
    throw new Error('Owned-seed message draft retry exhausted unexpectedly');
  }

  async requestApproval(
    context: DatabaseRequestContext,
    command: RequestOwnedSeedMessageApprovalCommand,
  ): Promise<RequestOwnedSeedMessageApprovalResult> {
    this.#assertWorkspace(context);
    try {
      return await withTransaction(this.#commandPool, context, async (transaction) => {
        const result = await transaction.query<RequestRow>(
          `/* property-predator-owned-seed-message.request-approval */
           SELECT disposition, message_id AS "messageId",
                  message_version_id AS "messageVersionId",
                  approval_request_id AS "approvalRequestId",
                  subject_sha256 AS "subjectSha256", body_sha256 AS "bodySha256",
                  source_content_sha256 AS "sourceContentSha256"
           FROM app_private.request_property_predator_owned_seed_message_approval($1, $2, $3, $4)`,
          [this.#workspaceId, command.messageId, command.commandKey,
            command.reviewNote ?? null],
        );
        const row = result.rows[0];
        if (result.rows.length !== 1 || !row
            || !['requested', 'replayed'].includes(row.disposition)) {
          throw new Error('Owned-seed approval request returned invalid canonical data');
        }
        return Object.freeze({
          disposition: row.disposition as 'requested' | 'replayed',
          messageId: uuid(row.messageId, 'messageId'),
          messageVersionId: uuid(row.messageVersionId, 'messageVersionId'),
          approvalRequestId: uuid(row.approvalRequestId, 'approvalRequestId'),
          ...evidence(row), lifecycleAtCommand: 'approval_pending' as const,
        });
      }, { isolation: 'serializable' });
    } catch (error) { translateConflict(error); }
  }

  async decideApproval(
    context: DatabaseRequestContext,
    command: DecideOwnedSeedMessageApprovalCommand,
  ): Promise<DecideOwnedSeedMessageApprovalResult> {
    this.#assertWorkspace(context);
    try {
      return await withTransaction(this.#commandPool, context, async (transaction) => {
        const result = await transaction.query<DecisionRow>(
          `/* property-predator-owned-seed-message.decide-approval */
           SELECT disposition, message_id AS "messageId",
                  message_version_id AS "messageVersionId",
                  approval_request_id AS "approvalRequestId",
                  approval_decision_id AS "approvalDecisionId", decision,
                  subject_sha256 AS "subjectSha256", body_sha256 AS "bodySha256",
                  source_content_sha256 AS "sourceContentSha256"
           FROM app_private.decide_property_predator_owned_seed_message_approval($1, $2, $3, $4, $5)`,
          [this.#workspaceId, command.approvalRequestId, command.decision,
            command.decisionNote ?? null, command.commandKey],
        );
        const row = result.rows[0];
        if (result.rows.length !== 1 || !row
            || !['decided', 'replayed'].includes(row.disposition)
            || !['approved', 'rejected', 'changes_requested'].includes(row.decision)) {
          throw new Error('Owned-seed approval decision returned invalid canonical data');
        }
        const decision = row.decision as 'approved' | 'rejected' | 'changes_requested';
        return Object.freeze({
          disposition: row.disposition as 'decided' | 'replayed',
          messageId: uuid(row.messageId, 'messageId'),
          messageVersionId: uuid(row.messageVersionId, 'messageVersionId'),
          approvalRequestId: uuid(row.approvalRequestId, 'approvalRequestId'),
          approvalDecisionId: uuid(row.approvalDecisionId, 'approvalDecisionId'),
          decision,
          ...evidence(row),
          lifecycleAtCommand: decision === 'approved' ? 'approved' as const : 'draft' as const,
        });
      }, { isolation: 'serializable' });
    } catch (error) { translateConflict(error); }
  }

  async resume(
    context: DatabaseRequestContext,
    command: ResumeOwnedSeedMessageCommand,
  ): Promise<ResumeOwnedSeedMessageResult | null> {
    this.#assertWorkspace(context);
    try {
      return await withTransaction(this.#commandPool, context, async (transaction) => {
        const result = await transaction.query<ResumeRow>(
          `/* property-predator-owned-seed-message.resume */
           SELECT message_id AS "messageId",
                  message_version_id AS "messageVersionId",
                  company_content_version_id AS "companyContentVersionId",
                  phase, approval_request_id AS "approvalRequestId",
                  subject_sha256 AS "subjectSha256",
                  body_sha256 AS "bodySha256",
                  source_content_sha256 AS "sourceContentSha256"
           FROM app_private.resume_property_predator_owned_seed_message($1, $2)`,
          [this.#workspaceId, command.companyContentVersionId],
        );
        if (result.rows.length === 0) return null;
        const row = result.rows[0];
        if (result.rows.length !== 1 || !row
            || !['drafted', 'approval_pending', 'approved', 'staged'].includes(row.phase)
            || (row.phase !== 'drafted' && row.approvalRequestId === null)) {
          throw new Error('Owned-seed message resume returned invalid canonical data');
        }
        return Object.freeze({
          messageId: uuid(row.messageId, 'messageId'),
          messageVersionId: uuid(row.messageVersionId, 'messageVersionId'),
          companyContentVersionId: uuid(
            row.companyContentVersionId,
            'companyContentVersionId',
          ),
          phase: row.phase as ResumeOwnedSeedMessageResult['phase'],
          approvalRequestId: row.approvalRequestId === null
            ? null : uuid(row.approvalRequestId, 'approvalRequestId'),
          subjectSha256: digest(row.subjectSha256, 'subjectSha256'),
          bodySha256: digest(row.bodySha256, 'bodySha256'),
          sourceContentSha256: digest(
            row.sourceContentSha256,
            'sourceContentSha256',
          ),
          recipient: PROPERTY_PREDATOR_OWNED_SEED_MESSAGE_EMAIL,
        });
      }, { isolation: 'serializable', readOnly: true });
    } catch (error) { translateConflict(error); }
  }

  async assertReady(): Promise<void> {
    await withTransaction(this.#commandPool, {
      actorKind: 'system', workspaceId: this.#workspaceId,
      requestId: 'owned-seed-message:readiness',
    }, async (transaction) => {
      const result = await transaction.query<{ ready: boolean } & QueryResultRow>(
        `/* property-predator-owned-seed-message.boundary-ready */
         SELECT app_private.property_predator_owned_seed_message_boundary_ready() AS ready`,
      );
      if (result.rows.length !== 1 || result.rows[0]?.ready !== true) {
        throw new Error('Owned-seed message PostgreSQL boundary is not ready');
      }
    }, { readOnly: true });
  }

  #assertWorkspace(context: DatabaseRequestContext): void {
    if (context.workspaceId !== this.#workspaceId) {
      throw new PropertyPredatorOwnedSeedMessageConflictError(
        'Owned-seed message workspace does not match its database identity',
      );
    }
  }
}
