import type { QueryResultRow } from 'pg';
import type { SqlExecutor } from '../crm-pg/types.js';
import type {
  PropertyPredatorAccountSnapshotEnvelopeV2,
  PropertyPredatorSnapshotRecordIssue,
  VerifiedPropertyPredatorAccountSnapshotV2,
} from './property-predator-snapshot-v2.js';

export interface PropertyPredatorSnapshotStageRecord {
  readonly id: string;
  readonly snapshotId: string;
  readonly envelopeSha256: Uint8Array;
  readonly pageCount: number;
  readonly recordCount: number;
}

interface StageRow extends QueryResultRow {
  id: string;
  snapshotId: string;
  envelopeSha256: Uint8Array;
  pageCount: number | string;
  recordCount: number | string;
}

interface StoredManifestRow extends QueryResultRow {
  id: string;
  stagedAt: string;
}

interface StoredPageRow extends QueryResultRow {
  sourceEnvelope: PropertyPredatorAccountSnapshotEnvelopeV2;
}

export interface StoredPropertyPredatorSnapshot {
  readonly stagedAt: string;
  readonly responses: readonly PropertyPredatorAccountSnapshotEnvelopeV2[];
}

function stageRecord(row: StageRow): PropertyPredatorSnapshotStageRecord {
  return {
    id: row.id,
    snapshotId: row.snapshotId,
    envelopeSha256: row.envelopeSha256,
    pageCount: Number(row.pageCount),
    recordCount: Number(row.recordCount),
  };
}

/** SQL adapter for append-only, workspace-scoped snapshot evidence. */
export class PropertyPredatorSnapshotRepository {
  constructor(private readonly transaction: SqlExecutor) {}

  async find(snapshotId: string): Promise<PropertyPredatorSnapshotStageRecord | null> {
    const result = await this.transaction.query<StageRow>(
      `/* property-predator-snapshot.find */
       SELECT id, snapshot_id AS "snapshotId", envelope_sha256 AS "envelopeSha256",
              page_count AS "pageCount", record_count AS "recordCount"
       FROM app_private.property_predator_snapshot_manifests
       WHERE snapshot_id = $1`,
      [snapshotId],
    );
    return result.rows[0] ? stageRecord(result.rows[0]) : null;
  }

  async insertManifest(input: {
    readonly id: string;
    readonly snapshot: VerifiedPropertyPredatorAccountSnapshotV2;
    readonly actorUserId: string;
    readonly requestId: string;
    readonly stagedAt: string;
  }): Promise<boolean> {
    const metadata = {
      schemaVersion: input.snapshot.schemaVersion,
      sourceSystem: input.snapshot.sourceSystem,
      snapshotId: input.snapshot.snapshotId,
      generatedAt: input.snapshot.generatedAt,
      watermark: input.snapshot.watermark,
      complete: true,
      manifest: input.snapshot.manifest,
    };
    const result = await this.transaction.query<{ id: string }>(
      `/* property-predator-snapshot.insert-manifest */
       INSERT INTO app_private.property_predator_snapshot_manifests (
         id, workspace_id, schema_version, source_system, snapshot_id,
         generated_at, watermark, complete, page_count, record_count, event_high_watermark,
         content_sha256, envelope_sha256, source_metadata, consent_default,
         created_by_user_id, request_id, staged_at
       ) VALUES (
         $1, app_private.current_workspace_id(), 2, $2, $3,
         $4::timestamptz, $5::timestamptz, true, $6, $7, $8::numeric,
         decode($9, 'hex'), decode($10, 'hex'), $11::jsonb, 'unknown',
         $12, $13, $14::timestamptz
       )
       ON CONFLICT (workspace_id, source_system, snapshot_id) DO NOTHING
       RETURNING id`,
      [
        input.id,
        input.snapshot.sourceSystem,
        input.snapshot.snapshotId,
        input.snapshot.generatedAt,
        input.snapshot.watermark,
        input.snapshot.manifest.pageCount,
        input.snapshot.manifest.recordCount,
        input.snapshot.manifest.eventHighWatermark,
        input.snapshot.manifest.contentSha256,
        input.snapshot.envelopeSha256,
        JSON.stringify(metadata),
        input.actorUserId,
        input.requestId,
        input.stagedAt,
      ],
    );
    return result.rowCount === 1;
  }

  async insertPages(input: {
    readonly manifestId: string;
    readonly snapshot: VerifiedPropertyPredatorAccountSnapshotV2;
    readonly pageIds: readonly string[];
    readonly stagedAt: string;
  }): Promise<void> {
    const pages = input.snapshot.pages.map((page, index) => ({
      id: input.pageIds[index],
      page_number: page.pageNumber,
      cursor: page.cursor,
      next_cursor: page.nextCursor,
      previous_page_sha256: page.previousPageSha256,
      page_sha256: page.pageSha256,
      record_count: page.records.length,
      source_envelope: {
        schemaVersion: 2,
        sourceSystem: input.snapshot.sourceSystem,
        snapshotId: input.snapshot.snapshotId,
        generatedAt: input.snapshot.generatedAt,
        watermark: input.snapshot.watermark,
        complete: true,
        manifest: input.snapshot.manifest,
        pages: [page],
      },
    }));
    const result = await this.transaction.query(
      `/* property-predator-snapshot.insert-pages */
       INSERT INTO app_private.property_predator_snapshot_pages (
         id, workspace_id, manifest_id, source_system, snapshot_id,
         page_number, cursor, next_cursor, previous_page_sha256,
         page_sha256, record_count, source_envelope, staged_at
       )
       SELECT page.id, app_private.current_workspace_id(), $1, $2, $3,
              page.page_number, page.cursor, page.next_cursor,
              CASE WHEN page.previous_page_sha256 IS NULL THEN NULL
                   ELSE decode(page.previous_page_sha256, 'hex') END,
              decode(page.page_sha256, 'hex'), page.record_count,
              page.source_envelope, $5::timestamptz
       FROM jsonb_to_recordset($4::jsonb) AS page(
         id uuid, page_number integer, cursor text, next_cursor text,
         previous_page_sha256 text, page_sha256 text, record_count integer,
         source_envelope jsonb
       )`,
      [
        input.manifestId,
        input.snapshot.sourceSystem,
        input.snapshot.snapshotId,
        JSON.stringify(pages),
        input.stagedAt,
      ],
    );
    if (result.rowCount !== pages.length) {
      throw new Error('Property Predator snapshot did not stage every verified page');
    }
  }

  async insertIssues(input: {
    readonly manifestId: string;
    readonly snapshot: VerifiedPropertyPredatorAccountSnapshotV2;
    readonly issueIds: readonly string[];
    readonly stagedAt: string;
  }): Promise<void> {
    if (input.snapshot.recordIssues.length === 0) return;
    const issues = input.snapshot.recordIssues.map((issue, index) => ({
      id: input.issueIds[index],
      page_number: issue.pageNumber,
      record_index: issue.recordIndex,
      account_id: issue.accountId,
      reason: issue.code,
    }));
    const result = await this.transaction.query(
      `/* property-predator-snapshot.insert-quarantine */
       INSERT INTO app_private.property_predator_snapshot_quarantine (
         id, workspace_id, manifest_id, source_system, snapshot_id,
         page_number, record_index, account_id, reason, quarantined_at
       )
       SELECT issue.id, app_private.current_workspace_id(), $1, $2, $3,
              issue.page_number, issue.record_index, issue.account_id,
              issue.reason, $5::timestamptz
       FROM jsonb_to_recordset($4::jsonb) AS issue(
         id uuid, page_number integer, record_index integer,
         account_id uuid, reason text
       )`,
      [
        input.manifestId,
        input.snapshot.sourceSystem,
        input.snapshot.snapshotId,
        JSON.stringify(issues),
        input.stagedAt,
      ],
    );
    if (result.rowCount !== issues.length) {
      throw new Error('Property Predator snapshot did not retain every quarantine reason');
    }
  }

  async load(snapshotId: string): Promise<StoredPropertyPredatorSnapshot | null> {
    const manifest = await this.transaction.query<StoredManifestRow>(
      `/* property-predator-snapshot.load-manifest */
       SELECT id, staged_at::text AS "stagedAt"
       FROM app_private.property_predator_snapshot_manifests
       WHERE snapshot_id = $1`,
      [snapshotId],
    );
    if (!manifest.rows[0]) return null;
    const pages = await this.transaction.query<StoredPageRow>(
      `/* property-predator-snapshot.load-pages */
       SELECT source_envelope AS "sourceEnvelope"
       FROM app_private.property_predator_snapshot_pages
       WHERE manifest_id = $1
       ORDER BY page_number`,
      [manifest.rows[0].id],
    );
    return Object.freeze({
      stagedAt: manifest.rows[0].stagedAt,
      responses: Object.freeze(pages.rows.map((row) => row.sourceEnvelope)),
    });
  }

  async loadIssues(snapshotId: string): Promise<readonly PropertyPredatorSnapshotRecordIssue[]> {
    const result = await this.transaction.query<{
      pageNumber: number | string;
      recordIndex: number | string;
      accountId: string;
      code: PropertyPredatorSnapshotRecordIssue['code'];
    }>(
      `/* property-predator-snapshot.load-quarantine */
       SELECT page_number AS "pageNumber", record_index AS "recordIndex",
              account_id AS "accountId", reason AS code
       FROM app_private.property_predator_snapshot_quarantine
       WHERE snapshot_id = $1
       ORDER BY page_number, record_index, reason`,
      [snapshotId],
    );
    return result.rows.map((row) => ({
      pageNumber: Number(row.pageNumber),
      recordIndex: Number(row.recordIndex),
      accountId: row.accountId,
      code: row.code,
    }));
  }
}
