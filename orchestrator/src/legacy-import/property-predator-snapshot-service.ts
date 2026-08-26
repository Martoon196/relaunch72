import { randomUUID } from 'node:crypto';
import type { DatabaseRequestContext } from '../db/rls.js';
import { validateDatabaseContext } from '../db/rls.js';
import { LegacyLeadImportService } from './service.js';
import type {
  LegacyImportTransactionRunner,
  LegacyLeadDryRunReport,
  LegacyLeadResolution,
} from './types.js';
import { LegacyImportConflictError } from './types.js';
import {
  type PropertyPredatorAccountSnapshotExportV2,
  type PropertyPredatorSnapshotRecordIssue,
  verifyPropertyPredatorAccountSnapshotV2,
} from './property-predator-snapshot-v2.js';
import { PropertyPredatorSnapshotRepository } from './property-predator-snapshot-repository.js';
import { equalBytes } from './validation.js';

export interface PropertyPredatorSnapshotServiceDependencies {
  readonly transactionRunner: LegacyImportTransactionRunner;
  readonly legacyImport?: Pick<LegacyLeadImportService, 'dryRun'>;
  readonly nextId?: () => string;
  readonly now?: () => Date;
}

export interface PropertyPredatorSnapshotStageResult {
  readonly disposition: 'staged' | 'replayed';
  readonly snapshotStageId: string;
  readonly snapshotId: string;
  readonly envelopeSha256: string;
  readonly pageCount: number;
  readonly recordCount: number;
  readonly quarantinedSourceRecords: number;
  readonly eventHighWatermark: string;
  readonly consentDefault: 'unknown';
}

export interface PropertyPredatorSnapshotAccountCounts {
  readonly create: number;
  readonly match: number;
  readonly replay: number;
  readonly quarantine: number;
}

export interface PropertyPredatorSnapshotPreviewReport {
  readonly mode: 'dry_run';
  readonly writes: 0;
  readonly integrity: 'verified_complete_snapshot';
  readonly snapshotId: string;
  readonly sourceSystem: 'property-predator.accounts/v2';
  readonly envelopeSha256: string;
  readonly contentSha256: string;
  readonly watermark: string;
  readonly eventHighWatermark: string;
  readonly pageCount: number;
  readonly recordCount: number;
  readonly consentDefault: 'unknown';
  readonly sourceIssues: readonly PropertyPredatorSnapshotRecordIssue[];
  readonly accountCounts: PropertyPredatorSnapshotAccountCounts;
  readonly unresolvedSourceFactCount: number;
  readonly reconciliation: LegacyLeadDryRunReport | null;
}

function managerContext(context: DatabaseRequestContext): void {
  validateDatabaseContext(context);
  if (context.actorKind !== 'user' || !context.userId) {
    throw new LegacyImportConflictError('Property Predator snapshot operations require a workspace manager');
  }
}

function hexBytes(value: string): Uint8Array {
  return Buffer.from(value, 'hex');
}

function emptyCounts(): Record<LegacyLeadResolution, number> {
  return { create: 0, match: 0, replay: 0, quarantine: 0 };
}

function duplicateAccountPositions(issues: readonly PropertyPredatorSnapshotRecordIssue[]): Set<string> {
  return new Set(issues
    .filter((issue) => issue.code === 'duplicate_account_id')
    .map((issue) => `${issue.pageNumber}:${issue.recordIndex}`));
}

function sourceIssuePositions(issues: readonly PropertyPredatorSnapshotRecordIssue[]): Set<string> {
  return new Set(issues.map((issue) => `${issue.pageNumber}:${issue.recordIndex}`));
}

export class PropertyPredatorSnapshotService {
  private readonly nextId: () => string;
  private readonly now: () => Date;
  private readonly legacyImport: Pick<LegacyLeadImportService, 'dryRun'>;

  constructor(private readonly dependencies: PropertyPredatorSnapshotServiceDependencies) {
    this.nextId = dependencies.nextId ?? randomUUID;
    this.now = dependencies.now ?? (() => new Date());
    this.legacyImport = dependencies.legacyImport
      ?? new LegacyLeadImportService({
        transactionRunner: dependencies.transactionRunner,
        nextId: this.nextId,
        now: this.now,
      });
  }

  /**
   * Recompute every manifest/page invariant before opening a transaction, then
   * append the complete envelope and every source quarantine reason atomically.
   */
  async stage(
    context: DatabaseRequestContext,
    input: PropertyPredatorAccountSnapshotExportV2,
  ): Promise<PropertyPredatorSnapshotStageResult> {
    managerContext(context);
    const now = this.now();
    const snapshot = verifyPropertyPredatorAccountSnapshotV2(input, now);
    return this.dependencies.transactionRunner.run(context, async (transaction) => {
      const repository = new PropertyPredatorSnapshotRepository(transaction);
      const existing = await repository.find(snapshot.snapshotId);
      if (existing) return this.replayed(existing, snapshot);
      const manifestId = this.nextId();
      const inserted = await repository.insertManifest({
        id: manifestId,
        snapshot,
        actorUserId: context.userId!,
        requestId: context.requestId,
        stagedAt: now.toISOString(),
      });
      if (!inserted) {
        const raced = await repository.find(snapshot.snapshotId);
        if (!raced) throw new LegacyImportConflictError('Snapshot claim disappeared');
        return this.replayed(raced, snapshot);
      }
      await repository.insertPages({
        manifestId,
        snapshot,
        pageIds: snapshot.pages.map(() => this.nextId()),
        stagedAt: now.toISOString(),
      });
      await repository.insertIssues({
        manifestId,
        snapshot,
        issueIds: snapshot.recordIssues.map(() => this.nextId()),
        stagedAt: now.toISOString(),
      });
      return {
        disposition: 'staged',
        snapshotStageId: manifestId,
        snapshotId: snapshot.snapshotId,
        envelopeSha256: snapshot.envelopeSha256,
        pageCount: snapshot.manifest.pageCount,
        recordCount: snapshot.manifest.recordCount,
        quarantinedSourceRecords: sourceIssuePositions(snapshot.recordIssues).size,
        eventHighWatermark: snapshot.manifest.eventHighWatermark,
        consentDefault: 'unknown',
      };
    }, { readOnly: false, serializable: true });
  }

  /** Full reconciliation with CRM identity evidence under a read-only transaction. */
  async preview(
    context: DatabaseRequestContext,
    input: PropertyPredatorAccountSnapshotExportV2,
  ): Promise<PropertyPredatorSnapshotPreviewReport> {
    managerContext(context);
    const snapshot = verifyPropertyPredatorAccountSnapshotV2(input, this.now());
    return this.previewVerified(context, snapshot);
  }

  private async previewVerified(
    context: DatabaseRequestContext,
    snapshot: ReturnType<typeof verifyPropertyPredatorAccountSnapshotV2>,
  ): Promise<PropertyPredatorSnapshotPreviewReport> {
    const legacyRecordCount = snapshot.legacyBatch.rows.length
      + (snapshot.legacyBatch.unresolvedAttributions?.length ?? 0);
    const reconciliation = legacyRecordCount > 0
      ? await this.legacyImport.dryRun(context, snapshot.legacyBatch)
      : null;
    const accountCounts = emptyCounts();
    if (reconciliation) {
      for (const row of reconciliation.rows.slice(0, snapshot.legacyBatch.rows.length)) {
        accountCounts[row.resolution] += 1;
      }
    }
    // Duplicate accounts cannot enter the compatibility rehearsal at all, so
    // count those raw records here. Other source issues quarantine only their
    // affiliate/referral fact while the independently valid account can still
    // receive a CRM resolution.
    accountCounts.quarantine += duplicateAccountPositions(snapshot.recordIssues).size;
    return Object.freeze({
      mode: 'dry_run',
      writes: 0,
      integrity: 'verified_complete_snapshot',
      snapshotId: snapshot.snapshotId,
      sourceSystem: snapshot.sourceSystem,
      envelopeSha256: snapshot.envelopeSha256,
      contentSha256: snapshot.manifest.contentSha256,
      watermark: snapshot.watermark,
      eventHighWatermark: snapshot.manifest.eventHighWatermark,
      pageCount: snapshot.manifest.pageCount,
      recordCount: snapshot.manifest.recordCount,
      consentDefault: 'unknown',
      sourceIssues: snapshot.recordIssues,
      accountCounts: Object.freeze(accountCounts),
      unresolvedSourceFactCount: snapshot.legacyBatch.unresolvedAttributions?.length ?? 0,
      reconciliation,
    });
  }

  /** Read immutable staged responses, reverify them, then run the same zero-write preview. */
  async previewStaged(
    context: DatabaseRequestContext,
    snapshotId: string,
  ): Promise<PropertyPredatorSnapshotPreviewReport> {
    managerContext(context);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(snapshotId)) {
      throw new LegacyImportConflictError('snapshotId must be a canonical lowercase UUID');
    }
    const stored = await this.dependencies.transactionRunner.run(context, async (transaction) => (
      new PropertyPredatorSnapshotRepository(transaction).load(snapshotId)
    ), { readOnly: true });
    if (!stored) {
      throw new LegacyImportConflictError('Snapshot was not found in this workspace');
    }
    // Freshness is an ingest-time control. The manifest's immutable stagedAt
    // proves the verifier accepted the source within the bounded window; later
    // operator previews recheck every byte/hash against that original time
    // rather than expiring durable evidence after fifteen minutes.
    const snapshot = verifyPropertyPredatorAccountSnapshotV2(
      stored.responses,
      new Date(stored.stagedAt),
    );
    return this.previewVerified(context, snapshot);
  }

  private replayed(
    existing: Readonly<{
      id: string;
      snapshotId: string;
      envelopeSha256: Uint8Array;
      pageCount: number;
      recordCount: number;
    }>,
    snapshot: ReturnType<typeof verifyPropertyPredatorAccountSnapshotV2>,
  ): PropertyPredatorSnapshotStageResult {
    if (!equalBytes(existing.envelopeSha256, hexBytes(snapshot.envelopeSha256))) {
      throw new LegacyImportConflictError('snapshotId was already staged with different canonical bytes');
    }
    return {
      disposition: 'replayed',
      snapshotStageId: existing.id,
      snapshotId: existing.snapshotId,
      envelopeSha256: snapshot.envelopeSha256,
      pageCount: existing.pageCount,
      recordCount: existing.recordCount,
      quarantinedSourceRecords: sourceIssuePositions(snapshot.recordIssues).size,
      eventHighWatermark: snapshot.manifest.eventHighWatermark,
      consentDefault: 'unknown',
    };
  }
}

/** Kept explicit so operator/report code cannot accidentally treat source issues as CRM writes. */
export function snapshotAccountResolutionTotal(
  counts: Readonly<Record<LegacyLeadResolution, number>>,
): number {
  return counts.create + counts.match + counts.replay + counts.quarantine;
}
