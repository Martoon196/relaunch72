import type { Pool, QueryResultRow } from 'pg';
import type { DatabaseRequestContext } from '../db/rls.js';
import { withTransaction } from '../db/transaction.js';
import type { SqlExecutor } from '../crm-pg/types.js';
import type {
  CompanyContentApprovalDecision,
  CompanyContentApprovalStatus,
  CompanyContentCatalogApprovalStatus,
  CompanyContentCatalogCursor,
  CompanyContentCatalogItem,
  CompanyContentKind,
  CompanyContentOrigin,
  CompanyContentTransactionRunner,
  CompanyContentVersionApprovalState,
} from './types.js';
import type { NormalizedCompanyContentVersionCommand } from './validation.js';

interface ReceiptRow extends QueryResultRow {
  id: string;
  payloadHash: Uint8Array;
  status: 'started' | 'succeeded' | 'failed';
  result: unknown;
}

export interface CompanyContentCommandClaim {
  readonly id: string;
  readonly payloadHash: Uint8Array;
  readonly status: ReceiptRow['status'];
  readonly result: unknown;
  readonly inserted: boolean;
}

interface LockedItemRow extends QueryResultRow {
  contentItemId: string;
  sourceSystem: string;
  sourceItemId: string;
  latestVersionId: string | null;
  latestVersionNumber: number | string | null;
}

export interface LockedCompanyContentItem {
  readonly contentItemId: string;
  readonly sourceSystem: string;
  readonly sourceItemId: string;
  readonly latestVersionId: string | null;
  readonly latestVersionNumber: number | null;
}

interface VersionRow extends QueryResultRow {
  contentItemId: string;
  contentVersionId: string;
  versionNumber: number | string;
  contentSha256: string;
  isLatest: boolean;
}

export interface LockedCompanyContentVersion {
  readonly contentItemId: string;
  readonly contentVersionId: string;
  readonly versionNumber: number;
  readonly contentSha256: string;
  readonly isLatest: boolean;
}

interface ApprovalRequestRow extends QueryResultRow {
  approvalRequestId: string;
  contentItemId: string;
  contentVersionId: string;
  requestNumber: number | string;
  contentSha256: string;
  isLatest: boolean;
  decision: CompanyContentApprovalDecision | null;
}

export interface LockedCompanyContentApprovalRequest {
  readonly approvalRequestId: string;
  readonly contentItemId: string;
  readonly contentVersionId: string;
  readonly requestNumber: number;
  readonly contentSha256: string;
  readonly isLatest: boolean;
  readonly decision: CompanyContentApprovalDecision | null;
}

interface ApprovalStateRow extends QueryResultRow {
  contentItemId: string;
  contentVersionId: string;
  versionNumber: number | string;
  title: string;
  origin: CompanyContentOrigin;
  sourceSystem: string;
  sourceItemId: string;
  sourceVersion: string;
  contentSha256: string;
  blobSha256: string;
  brandSha256: string;
  approvalRequestId: string | null;
  approvalDecisionId: string | null;
  approvalStatus: CompanyContentApprovalStatus;
  approvalStale: boolean;
}

interface CatalogRow extends QueryResultRow {
  contentItemId: string;
  contentVersionId: string;
  versionNumber: number | string;
  origin: CompanyContentOrigin;
  kind: CompanyContentKind;
  title: string;
  contentMimeType: string;
  sourceSystem: string;
  sourceItemId: string;
  sourceVersion: string;
  contentSha256: string;
  blobSha256: string;
  brandSha256: string;
  approvalRequestId: string | null;
  approvalDecisionId: string | null;
  approvalStatus: CompanyContentCatalogApprovalStatus;
  approvalStale: boolean;
  sourceAttestationId: string | null;
  sourceCheckedAt: string | null;
  sourceExpiresAt: string | null;
  sourceFresh: boolean;
  publishable: boolean;
  createdAt: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const CONTENT_ORIGINS = new Set<CompanyContentOrigin>(['imported', 'generated', 'edited']);
const CONTENT_KINDS = new Set<CompanyContentKind>([
  'article', 'document', 'email', 'image', 'social_post',
  'video', 'webinar', 'other',
]);
const CATALOG_APPROVAL_STATUSES = new Set<CompanyContentCatalogApprovalStatus>([
  'unrequested', 'pending', 'approved', 'rejected', 'changes_requested', 'stale',
]);

function lockedItem(row: LockedItemRow): LockedCompanyContentItem {
  return {
    contentItemId: row.contentItemId,
    sourceSystem: row.sourceSystem,
    sourceItemId: row.sourceItemId,
    latestVersionId: row.latestVersionId,
    latestVersionNumber: row.latestVersionNumber === null
      ? null : Number(row.latestVersionNumber),
  };
}

function lockedVersion(row: VersionRow): LockedCompanyContentVersion {
  return {
    ...row,
    versionNumber: Number(row.versionNumber),
  };
}

function approvalRequest(row: ApprovalRequestRow): LockedCompanyContentApprovalRequest {
  return {
    ...row,
    requestNumber: Number(row.requestNumber),
  };
}

function catalogItem(row: CatalogRow): CompanyContentCatalogItem {
  const hasApprovalRequest = row.approvalRequestId !== null;
  const hasApprovalDecision = row.approvalDecisionId !== null;
  const hasSourceAttestation = row.sourceAttestationId !== null;
  const hasSourceCheckedAt = row.sourceCheckedAt !== null;
  const hasSourceExpiresAt = row.sourceExpiresAt !== null;
  if (!UUID.test(row.contentItemId)
      || !UUID.test(row.contentVersionId)
      || !Number.isSafeInteger(Number(row.versionNumber))
      || Number(row.versionNumber) < 1
      || !CONTENT_ORIGINS.has(row.origin)
      || !CONTENT_KINDS.has(row.kind)
      || typeof row.title !== 'string' || row.title.length < 1
      || typeof row.contentMimeType !== 'string' || row.contentMimeType.length < 3
      || typeof row.sourceSystem !== 'string' || row.sourceSystem.length < 1
      || typeof row.sourceItemId !== 'string' || row.sourceItemId.length < 1
      || typeof row.sourceVersion !== 'string' || row.sourceVersion.length < 1
      || !SHA256.test(row.contentSha256)
      || !SHA256.test(row.blobSha256)
      || !SHA256.test(row.brandSha256)
      || (row.approvalRequestId !== null && !UUID.test(row.approvalRequestId))
      || (row.approvalDecisionId !== null && !UUID.test(row.approvalDecisionId))
      || !CATALOG_APPROVAL_STATUSES.has(row.approvalStatus)
      || (!hasApprovalRequest && hasApprovalDecision)
      || (!hasApprovalRequest
        && row.approvalStatus !== 'unrequested'
        && row.approvalStatus !== 'stale')
      || (hasApprovalRequest && !hasApprovalDecision
        && row.approvalStatus !== 'pending')
      || (hasApprovalDecision
        && !['approved', 'rejected', 'changes_requested'].includes(row.approvalStatus))
      || typeof row.approvalStale !== 'boolean'
      || (row.approvalStatus === 'stale' && !row.approvalStale)
      || (row.sourceAttestationId !== null && !UUID.test(row.sourceAttestationId))
      || (row.sourceCheckedAt !== null
        && !Number.isFinite(new Date(row.sourceCheckedAt).getTime()))
      || (row.sourceExpiresAt !== null
        && !Number.isFinite(new Date(row.sourceExpiresAt).getTime()))
      || hasSourceAttestation !== hasSourceCheckedAt
      || hasSourceAttestation !== hasSourceExpiresAt
      || typeof row.sourceFresh !== 'boolean'
      || (row.sourceFresh && !hasSourceAttestation)
      || typeof row.publishable !== 'boolean'
      || row.publishable !== (row.approvalStatus === 'approved' && row.sourceFresh)
      || typeof row.createdAt !== 'string'
      || !Number.isFinite(new Date(row.createdAt).getTime())) {
    throw new Error('Company content catalog returned invalid canonical data');
  }
  return Object.freeze({
    contentItemId: row.contentItemId,
    contentVersionId: row.contentVersionId,
    versionNumber: Number(row.versionNumber),
    origin: row.origin,
    kind: row.kind,
    title: row.title,
    contentMimeType: row.contentMimeType,
    source: Object.freeze({
      system: row.sourceSystem,
      itemId: row.sourceItemId,
      version: row.sourceVersion,
    }),
    contentSha256: row.contentSha256,
    blobSha256: row.blobSha256,
    brandSha256: row.brandSha256,
    approvalRequestId: row.approvalRequestId,
    approvalDecisionId: row.approvalDecisionId,
    approvalStatus: row.approvalStatus,
    approvalStale: row.approvalStale,
    sourceAttestationId: row.sourceAttestationId,
    sourceCheckedAt: row.sourceCheckedAt,
    sourceExpiresAt: row.sourceExpiresAt,
    sourceFresh: row.sourceFresh,
    publishable: row.publishable,
    createdAt: row.createdAt,
  });
}

export class CompanyContentPgRepository {
  constructor(private readonly transaction: SqlExecutor) {}

  async claimCommand(input: {
    readonly id: string;
    readonly commandName: string;
    readonly commandKey: string;
    readonly requestId: string;
    readonly payloadHash: Uint8Array;
    readonly createdAt: string;
  }): Promise<CompanyContentCommandClaim> {
    const inserted = await this.transaction.query<ReceiptRow>(
      `/* company-content.claim-command */
       INSERT INTO app.command_receipts (
         id, workspace_id, command_name, idempotency_key, request_id,
         actor_user_id, payload_hash, status, created_at
       ) VALUES (
         $1, app_private.current_workspace_id(), $2, $3, $4,
         app_private.current_user_id(), $5, 'started', $6::timestamptz
       )
       ON CONFLICT (
         workspace_id, actor_user_id, command_name, idempotency_key
       ) DO NOTHING
       RETURNING id, payload_hash AS "payloadHash", status, result`,
      [input.id, input.commandName, input.commandKey, input.requestId,
        input.payloadHash, input.createdAt],
    );
    if (inserted.rows[0]) return { ...inserted.rows[0], inserted: true };

    const existing = await this.transaction.query<ReceiptRow>(
      `/* company-content.read-command-receipt */
       SELECT id, payload_hash AS "payloadHash", status, result
       FROM app.command_receipts
       WHERE actor_user_id = app_private.current_user_id()
         AND command_name = $1
         AND idempotency_key = $2`,
      [input.commandName, input.commandKey],
    );
    const row = existing.rows[0];
    if (!row) throw new Error('Company content command receipt was not visible after conflict');
    return { ...row, inserted: false };
  }

  async completeCommand(input: {
    readonly receiptId: string;
    readonly payloadHash: Uint8Array;
    readonly result: Readonly<Record<string, unknown>>;
    readonly completedAt: string;
  }): Promise<void> {
    const completed = await this.transaction.query(
      `/* company-content.complete-command */
       UPDATE app.command_receipts
       SET result = $3::jsonb, status = 'succeeded', response_status = 200,
           completed_at = $4::timestamptz
       WHERE id = $1 AND payload_hash = $2 AND status = 'started'`,
      [input.receiptId, input.payloadHash, JSON.stringify(input.result), input.completedAt],
    );
    if (completed.rowCount !== 1) {
      throw new Error('Company content command receipt did not complete exactly once');
    }
  }

  async insertContentItem(input: {
    readonly id: string;
    readonly sourceSystem: string;
    readonly sourceItemId: string;
    readonly actorUserId: string;
    readonly requestId: string;
    readonly createdAt: string;
  }): Promise<void> {
    const result = await this.transaction.query(
      `/* company-content.insert-item */
       INSERT INTO app.company_content_items (
         id, workspace_id, source_system, source_item_id,
         created_by_user_id, created_request_id, created_at
       ) VALUES (
         $1, app_private.current_workspace_id(), $2, $3, $4, $5, $6::timestamptz
       )`,
      [input.id, input.sourceSystem, input.sourceItemId,
        input.actorUserId, input.requestId, input.createdAt],
    );
    if (result.rowCount !== 1) throw new Error('Company content item was not inserted');
  }

  async lockSourceIdentity(
    sourceSystem: string,
    sourceItemId: string,
  ): Promise<LockedCompanyContentItem | null> {
    await this.transaction.query(
      `/* company-content.lock-source-identity */
       SELECT pg_catalog.pg_advisory_xact_lock(
         pg_catalog.hashtextextended(
           'company-content-source:' || app_private.current_workspace_id()::text
             || ':' || $1 || ':' || $2,
           7200021
         )
       )`,
      [sourceSystem, sourceItemId],
    );
    const result = await this.transaction.query<LockedItemRow>(
      `/* company-content.find-item-by-source */
       SELECT item.id AS "contentItemId",
              item.source_system AS "sourceSystem",
              item.source_item_id AS "sourceItemId",
              latest.id AS "latestVersionId",
              latest.version_number AS "latestVersionNumber"
       FROM app.company_content_items AS item
       LEFT JOIN LATERAL (
         SELECT version.id, version.version_number
         FROM app.company_content_versions AS version
         WHERE version.workspace_id = item.workspace_id
           AND version.content_item_id = item.id
         ORDER BY version.version_number DESC, version.id
         LIMIT 1
       ) AS latest ON true
       WHERE item.source_system = $1 AND item.source_item_id = $2`,
      [sourceSystem, sourceItemId],
    );
    return result.rows[0] ? lockedItem(result.rows[0]) : null;
  }

  async lockContentItem(contentItemId: string): Promise<LockedCompanyContentItem | null> {
    await this.transaction.query(
      `/* company-content.lock-item-identity */
       SELECT pg_catalog.pg_advisory_xact_lock(
         pg_catalog.hashtextextended(
           'company-content-item:' || app_private.current_workspace_id()::text || ':' || $1,
           7200021
         )
       )`,
      [contentItemId],
    );
    const result = await this.transaction.query<LockedItemRow>(
      `/* company-content.lock-item */
       SELECT item.id AS "contentItemId",
              item.source_system AS "sourceSystem",
              item.source_item_id AS "sourceItemId",
              latest.id AS "latestVersionId",
              latest.version_number AS "latestVersionNumber"
       FROM app.company_content_items AS item
       LEFT JOIN LATERAL (
         SELECT version.id, version.version_number
         FROM app.company_content_versions AS version
         WHERE version.workspace_id = item.workspace_id
           AND version.content_item_id = item.id
         ORDER BY version.version_number DESC, version.id
         LIMIT 1
       ) AS latest ON true
       WHERE item.id = $1`,
      [contentItemId],
    );
    return result.rows[0] ? lockedItem(result.rows[0]) : null;
  }

  async insertVersion(input: {
    readonly id: string;
    readonly contentItemId: string;
    readonly previousVersionId: string | null;
    readonly versionNumber: number;
    readonly command: NormalizedCompanyContentVersionCommand;
    readonly actorUserId: string;
    readonly requestId: string;
    readonly createdAt: string;
  }): Promise<LockedCompanyContentVersion> {
    const result = await this.transaction.query<VersionRow>(
      `/* company-content.insert-version */
       INSERT INTO app.company_content_versions (
         id, workspace_id, content_item_id, version_number,
         previous_version_id, origin, content_kind, title,
         source_system, source_item_id, source_version,
         content_mime_type, content_body, blob_storage_key, blob_sha256,
         brand_snapshot_ref, brand_sha256, metadata,
         created_by_user_id, created_request_id, created_at
       ) VALUES (
         $1, app_private.current_workspace_id(), $2, $3, $4,
         $5, $6, $7, $8, $9, $10, $11, $12, $13, decode($14, 'hex'),
         $15, decode($16, 'hex'), $17::jsonb, $18, $19, $20::timestamptz
       )
       RETURNING content_item_id AS "contentItemId", id AS "contentVersionId",
                 version_number AS "versionNumber",
                 encode(content_sha256, 'hex') AS "contentSha256",
                 true AS "isLatest"`,
      [
        input.id, input.contentItemId, input.versionNumber, input.previousVersionId,
        input.command.origin, input.command.kind, input.command.title,
        input.command.sourceSystem, input.command.sourceItemId,
        input.command.sourceVersion, input.command.contentMimeType,
        input.command.content, input.command.blobStorageKey,
        input.command.blobSha256, input.command.brandSnapshotRef,
        input.command.brandSha256, JSON.stringify(input.command.metadata),
        input.actorUserId, input.requestId, input.createdAt,
      ],
    );
    const row = result.rows[0];
    if (result.rows.length !== 1 || !row) {
      throw new Error('Company content version was not inserted');
    }
    return lockedVersion(row);
  }

  async insertSourceAttestation(input: {
    readonly id: string;
    readonly version: LockedCompanyContentVersion;
    readonly command: NormalizedCompanyContentVersionCommand;
    readonly actorUserId: string;
    readonly requestId: string;
    readonly createdAt: string;
  }): Promise<{ readonly id: string; readonly expiresAt: string }> {
    const result = await this.transaction.query<{
      id: string;
      expiresAt: string;
    } & QueryResultRow>(
      `/* company-content.insert-source-attestation */
       INSERT INTO app.company_content_source_attestations (
         id, workspace_id, content_item_id, content_version_id,
         source_system, source_item_id, source_version,
         content_sha256, blob_sha256, brand_sha256,
         source_catalog_sha256, checked_at, expires_at,
         attested_by_user_id, attested_request_id, created_at
       ) VALUES (
         $1, app_private.current_workspace_id(), $2, $3,
         $4, $5, $6, decode($7, 'hex'), decode($8, 'hex'), decode($9, 'hex'),
         decode($10, 'hex'), $11::timestamptz, $12::timestamptz,
         $13, $14, $15::timestamptz
       )
       RETURNING id, expires_at::text AS "expiresAt"`,
      [
        input.id, input.version.contentItemId, input.version.contentVersionId,
        input.command.sourceSystem, input.command.sourceItemId,
        input.command.sourceVersion, input.version.contentSha256,
        input.command.blobSha256, input.command.brandSha256,
        input.command.sourceCatalogSha256, input.command.sourceCheckedAt,
        input.command.sourceExpiresAt, input.actorUserId,
        input.requestId, input.createdAt,
      ],
    );
    const row = result.rows[0];
    if (result.rows.length !== 1 || !row || !UUID.test(row.id)
        || !Number.isFinite(new Date(row.expiresAt).getTime())) {
      throw new Error('Company content source attestation returned invalid canonical data');
    }
    return Object.freeze({ id: row.id, expiresAt: row.expiresAt });
  }

  async lockVersion(
    contentItemId: string,
    contentVersionId: string,
  ): Promise<LockedCompanyContentVersion | null> {
    await this.transaction.query(
      `/* company-content.lock-version-item */
       SELECT pg_catalog.pg_advisory_xact_lock(
         pg_catalog.hashtextextended(
           'company-content-item:' || app_private.current_workspace_id()::text || ':' || $1,
           7200021
         )
       )`,
      [contentItemId],
    );
    const result = await this.transaction.query<VersionRow>(
      `/* company-content.lock-version */
       SELECT version.content_item_id AS "contentItemId",
              version.id AS "contentVersionId",
              version.version_number AS "versionNumber",
              encode(version.content_sha256, 'hex') AS "contentSha256",
              version.id = (
                SELECT latest.id
                FROM app.company_content_versions AS latest
                WHERE latest.workspace_id = version.workspace_id
                  AND latest.content_item_id = version.content_item_id
                ORDER BY latest.version_number DESC, latest.id
                LIMIT 1
              ) AS "isLatest"
       FROM app.company_content_items AS item
       JOIN app.company_content_versions AS version
         ON version.workspace_id = item.workspace_id
        AND version.content_item_id = item.id
       WHERE item.id = $1 AND version.id = $2`,
      [contentItemId, contentVersionId],
    );
    return result.rows[0] ? lockedVersion(result.rows[0]) : null;
  }

  async nextApprovalRequestNumber(
    contentItemId: string,
    contentVersionId: string,
  ): Promise<number> {
    const result = await this.transaction.query<{ next: number | string } & QueryResultRow>(
      `/* company-content.next-approval-request-number */
       SELECT coalesce(max(request.request_number), 0) + 1 AS next
       FROM app.company_content_approval_requests AS request
       WHERE request.content_item_id = $1 AND request.content_version_id = $2`,
      [contentItemId, contentVersionId],
    );
    return Number(result.rows[0]?.next ?? 1);
  }

  async insertApprovalRequest(input: {
    readonly id: string;
    readonly version: LockedCompanyContentVersion;
    readonly requestNumber: number;
    readonly reviewNote: string | null;
    readonly actorUserId: string;
    readonly requestId: string;
    readonly requestedAt: string;
  }): Promise<LockedCompanyContentApprovalRequest> {
    const result = await this.transaction.query<ApprovalRequestRow>(
      `/* company-content.insert-approval-request */
       INSERT INTO app.company_content_approval_requests (
         id, workspace_id, content_item_id, content_version_id,
         content_sha256, request_number, review_note,
         requested_by_user_id, requested_request_id, requested_at
       ) VALUES (
         $1, app_private.current_workspace_id(), $2, $3, decode($4, 'hex'),
         $5, $6, $7, $8, $9::timestamptz
       )
       RETURNING id AS "approvalRequestId", content_item_id AS "contentItemId",
                 content_version_id AS "contentVersionId",
                 request_number AS "requestNumber",
                 encode(content_sha256, 'hex') AS "contentSha256",
                 true AS "isLatest", NULL::text AS decision`,
      [
        input.id, input.version.contentItemId, input.version.contentVersionId,
        input.version.contentSha256, input.requestNumber, input.reviewNote,
        input.actorUserId, input.requestId, input.requestedAt,
      ],
    );
    const row = result.rows[0];
    if (result.rows.length !== 1 || !row) {
      throw new Error('Company content approval request was not inserted');
    }
    return approvalRequest(row);
  }

  async lockApprovalRequest(
    approvalRequestId: string,
  ): Promise<LockedCompanyContentApprovalRequest | null> {
    await this.transaction.query(
      `/* company-content.lock-approval-identity */
       SELECT pg_catalog.pg_advisory_xact_lock(
         pg_catalog.hashtextextended(
           'company-content-approval:' || app_private.current_workspace_id()::text || ':' || $1,
           7200021
         )
       )`,
      [approvalRequestId],
    );
    const result = await this.transaction.query<ApprovalRequestRow>(
      `/* company-content.lock-approval-request */
       SELECT request.id AS "approvalRequestId",
              request.content_item_id AS "contentItemId",
              request.content_version_id AS "contentVersionId",
              request.request_number AS "requestNumber",
              encode(request.content_sha256, 'hex') AS "contentSha256",
              request.content_version_id = latest.id AS "isLatest",
              decision.decision
       FROM app.company_content_approval_requests AS request
       JOIN app.company_content_items AS item
         ON item.workspace_id = request.workspace_id
        AND item.id = request.content_item_id
       JOIN LATERAL (
         SELECT version.id
         FROM app.company_content_versions AS version
         WHERE version.workspace_id = request.workspace_id
           AND version.content_item_id = request.content_item_id
         ORDER BY version.version_number DESC, version.id
         LIMIT 1
       ) AS latest ON true
       LEFT JOIN app.company_content_approval_decisions AS decision
         ON decision.workspace_id = request.workspace_id
        AND decision.approval_request_id = request.id
       WHERE request.id = $1`,
      [approvalRequestId],
    );
    return result.rows[0] ? approvalRequest(result.rows[0]) : null;
  }

  async insertApprovalDecision(input: {
    readonly id: string;
    readonly request: LockedCompanyContentApprovalRequest;
    readonly decision: CompanyContentApprovalDecision;
    readonly decisionNote: string | null;
    readonly actorUserId: string;
    readonly requestId: string;
    readonly decidedAt: string;
  }): Promise<void> {
    const result = await this.transaction.query(
      `/* company-content.insert-approval-decision */
       INSERT INTO app.company_content_approval_decisions (
         id, workspace_id, content_item_id, content_version_id,
         approval_request_id, content_sha256, decision, decision_note,
         decided_by_user_id, decided_request_id, decided_at
       ) VALUES (
         $1, app_private.current_workspace_id(), $2, $3, $4,
         decode($5, 'hex'), $6, $7, $8, $9, $10::timestamptz
       )`,
      [
        input.id, input.request.contentItemId, input.request.contentVersionId,
        input.request.approvalRequestId, input.request.contentSha256,
        input.decision, input.decisionNote, input.actorUserId,
        input.requestId, input.decidedAt,
      ],
    );
    if (result.rowCount !== 1) {
      throw new Error('Company content approval decision was not inserted');
    }
  }

  async listVersionApprovalStates(
    contentItemId: string,
  ): Promise<CompanyContentVersionApprovalState[]> {
    const result = await this.transaction.query<ApprovalStateRow>(
      `/* company-content.list-version-approval-states */
       WITH versions AS (
         SELECT version.*,
                max(version.version_number) OVER (
                  PARTITION BY version.workspace_id, version.content_item_id
                ) AS latest_version_number
         FROM app.company_content_versions AS version
         WHERE version.content_item_id = $1
       )
       SELECT version.content_item_id AS "contentItemId",
              version.id AS "contentVersionId",
              version.version_number AS "versionNumber",
              version.title, version.origin,
              version.source_system AS "sourceSystem",
              version.source_item_id AS "sourceItemId",
              version.source_version AS "sourceVersion",
              encode(version.content_sha256, 'hex') AS "contentSha256",
              encode(version.blob_sha256, 'hex') AS "blobSha256",
              encode(version.brand_sha256, 'hex') AS "brandSha256",
              request.id AS "approvalRequestId",
              decision.id AS "approvalDecisionId",
              CASE
                WHEN request.id IS NULL THEN 'unrequested'
                WHEN decision.id IS NULL THEN 'pending'
                ELSE decision.decision
              END AS "approvalStatus",
              request.id IS NOT NULL
                AND version.version_number <> version.latest_version_number
                AS "approvalStale"
       FROM versions AS version
       LEFT JOIN LATERAL (
         SELECT candidate.id
         FROM app.company_content_approval_requests AS candidate
         WHERE candidate.workspace_id = version.workspace_id
           AND candidate.content_item_id = version.content_item_id
           AND candidate.content_version_id = version.id
         ORDER BY candidate.request_number DESC, candidate.id
         LIMIT 1
       ) AS request ON true
       LEFT JOIN app.company_content_approval_decisions AS decision
         ON decision.workspace_id = version.workspace_id
        AND decision.approval_request_id = request.id
       ORDER BY version.version_number DESC, version.id
       LIMIT $2`,
      [contentItemId, 101],
    );
    if (result.rows.length > 100) {
      throw new Error('Company content version history exceeded its read bound');
    }
    return result.rows.map((row) => Object.freeze({
      contentItemId: row.contentItemId,
      contentVersionId: row.contentVersionId,
      versionNumber: Number(row.versionNumber),
      title: row.title,
      origin: row.origin,
      source: Object.freeze({
        system: row.sourceSystem,
        itemId: row.sourceItemId,
        version: row.sourceVersion,
      }),
      contentSha256: row.contentSha256,
      blobSha256: row.blobSha256,
      brandSha256: row.brandSha256,
      approvalRequestId: row.approvalRequestId,
      approvalDecisionId: row.approvalDecisionId,
      approvalStatus: row.approvalStatus,
      approvalStale: row.approvalStale,
    }));
  }

  async listCatalog(input: {
    readonly limit: number;
    readonly cursor: CompanyContentCatalogCursor | null;
  }): Promise<CompanyContentCatalogItem[]> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 101) {
      throw new Error('Company content repository catalog bound is invalid');
    }
    const result = await this.transaction.query<CatalogRow>(
      `/* company-content.list-catalog */
       WITH latest_versions AS (
         SELECT item.workspace_id,
                item.id AS content_item_id,
                latest.id AS content_version_id,
                latest.version_number,
                latest.origin,
                latest.content_kind,
                latest.title,
                latest.content_mime_type,
                latest.source_system,
                latest.source_item_id,
                latest.source_version,
                latest.content_sha256,
                latest.blob_sha256,
                latest.brand_sha256,
                latest.created_at
         FROM app.company_content_items AS item
         JOIN LATERAL (
           SELECT version.*
           FROM app.company_content_versions AS version
           WHERE version.workspace_id = item.workspace_id
             AND version.content_item_id = item.id
           ORDER BY version.version_number DESC, version.id
           LIMIT 1
         ) AS latest ON true
       )
       SELECT latest.content_item_id AS "contentItemId",
              latest.content_version_id AS "contentVersionId",
              latest.version_number AS "versionNumber",
              latest.origin,
              latest.content_kind AS kind,
              latest.title,
              latest.content_mime_type AS "contentMimeType",
              latest.source_system AS "sourceSystem",
              latest.source_item_id AS "sourceItemId",
              latest.source_version AS "sourceVersion",
              encode(latest.content_sha256, 'hex') AS "contentSha256",
              encode(latest.blob_sha256, 'hex') AS "blobSha256",
              encode(latest.brand_sha256, 'hex') AS "brandSha256",
              request.id AS "approvalRequestId",
              decision.id AS "approvalDecisionId",
              CASE
                WHEN request.id IS NULL AND prior_approval.exists THEN 'stale'
                WHEN request.id IS NULL THEN 'unrequested'
                WHEN decision.id IS NULL THEN 'pending'
                ELSE decision.decision
              END AS "approvalStatus",
              prior_approval.exists
                AND coalesce(decision.decision, '') <> 'approved'
                AS "approvalStale",
              attestation.id AS "sourceAttestationId",
              attestation.checked_at::text AS "sourceCheckedAt",
              attestation.expires_at::text AS "sourceExpiresAt",
              coalesce(
                attestation.checked_at <= statement_timestamp()
                AND attestation.expires_at > statement_timestamp(),
                false
              ) AS "sourceFresh",
              coalesce(decision.decision = 'approved', false)
                AND coalesce(
                  attestation.checked_at <= statement_timestamp()
                  AND attestation.expires_at > statement_timestamp(),
                  false
                ) AS publishable,
              latest.created_at::text AS "createdAt"
       FROM latest_versions AS latest
       LEFT JOIN LATERAL (
         SELECT candidate.id
         FROM app.company_content_approval_requests AS candidate
         WHERE candidate.workspace_id = latest.workspace_id
           AND candidate.content_item_id = latest.content_item_id
           AND candidate.content_version_id = latest.content_version_id
         ORDER BY candidate.request_number DESC, candidate.id
         LIMIT 1
       ) AS request ON true
       LEFT JOIN app.company_content_approval_decisions AS decision
        ON decision.workspace_id = latest.workspace_id
        AND decision.approval_request_id = request.id
       LEFT JOIN LATERAL (
         SELECT source_attestation.id,
                source_attestation.checked_at,
                source_attestation.expires_at
         FROM app.company_content_source_attestations AS source_attestation
         WHERE source_attestation.workspace_id = latest.workspace_id
           AND source_attestation.content_item_id = latest.content_item_id
           AND source_attestation.content_version_id = latest.content_version_id
         ORDER BY source_attestation.checked_at DESC, source_attestation.id DESC
         LIMIT 1
       ) AS attestation ON true
       LEFT JOIN LATERAL (
         SELECT EXISTS (
           SELECT 1
           FROM app.company_content_versions AS older
           JOIN app.company_content_approval_requests AS older_request
             ON older_request.workspace_id = older.workspace_id
            AND older_request.content_item_id = older.content_item_id
            AND older_request.content_version_id = older.id
           JOIN app.company_content_approval_decisions AS older_decision
             ON older_decision.workspace_id = older_request.workspace_id
            AND older_decision.approval_request_id = older_request.id
            AND older_decision.decision = 'approved'
           WHERE older.workspace_id = latest.workspace_id
             AND older.content_item_id = latest.content_item_id
             AND older.version_number < latest.version_number
         ) AS exists
       ) AS prior_approval ON true
       WHERE (
         $1::timestamptz IS NULL
         OR (latest.created_at, latest.content_version_id)
           < ($1::timestamptz, $2::uuid)
       )
       ORDER BY latest.created_at DESC, latest.content_version_id DESC
       LIMIT $3`,
      [input.cursor?.beforeCreatedAt ?? null,
        input.cursor?.beforeVersionId ?? null, input.limit],
    );
    if (result.rows.length > input.limit) {
      throw new Error('Company content catalog exceeded its SQL-side bound');
    }
    return result.rows.map(catalogItem);
  }
}

export function createCompanyContentTransactionRunner(
  pool: Pick<Pool, 'connect'>,
): CompanyContentTransactionRunner {
  return {
    run: (context, operation, options) => withTransaction(
      pool,
      context,
      operation,
      {
        readOnly: options.readOnly,
        isolation: options.serializable ? 'serializable' : 'read committed',
      },
    ),
  };
}
