import { randomUUID } from 'node:crypto';
import type { DatabaseRequestContext } from '../db/rls.js';
import { validateDatabaseContext } from '../db/rls.js';
import {
  createPgLegacyImportTransactionRunner,
  LegacyLeadImportRepository,
  type IdentityCandidate,
} from './repository.js';
import {
  LegacyImportConflictError,
  type LegacyLeadBatchInput,
  type LegacyLeadCommitResult,
  type LegacyLeadDryRunReport,
  type LegacyLeadDryRunRow,
  type LegacyLeadImportDependencies,
  type LegacyLeadResolution,
  type LegacyLeadStageResult,
  type NormalizedLegacyLeadBatch,
  type NormalizedLegacyLeadRow,
  type NormalizedLegacyUnresolvedAttribution,
} from './types.js';
import {
  bytesToHex,
  equalBytes,
  normalizeLegacyLeadBatch,
} from './validation.js';

interface RowDecision {
  readonly resolution: LegacyLeadResolution;
  readonly contactId: string | null;
  readonly reasons: readonly string[];
}

function managerContext(context: DatabaseRequestContext): void {
  validateDatabaseContext(context);
  if (context.actorKind !== 'user' || !context.userId) {
    throw new LegacyImportConflictError('Legacy imports require an authenticated workspace manager');
  }
}

function decide(candidates: readonly IdentityCandidate[], verifiedCount: number): RowDecision {
  if (verifiedCount === 0) {
    return { resolution: 'quarantine', contactId: null, reasons: ['no_verified_identity'] };
  }
  if (candidates.some((candidate) => candidate.dedupeState !== 'normal')) {
    return {
      resolution: 'quarantine', contactId: null,
      reasons: ['shared_or_quarantined_identity'],
    };
  }
  if (candidates.some((candidate) => candidate.contactState !== 'active')) {
    return {
      resolution: 'quarantine', contactId: null,
      reasons: ['identity_belongs_to_inactive_contact'],
    };
  }
  const contacts = [...new Set(candidates.map((candidate) => candidate.contactId))];
  if (contacts.length > 1) {
    return { resolution: 'quarantine', contactId: null, reasons: ['split_identity'] };
  }
  if (contacts[0]) return { resolution: 'match', contactId: contacts[0], reasons: ['verified_identity_match'] };
  return { resolution: 'create', contactId: null, reasons: ['no_existing_verified_identity_match'] };
}

function counts(rows: readonly LegacyLeadDryRunRow[]): Record<LegacyLeadResolution, number> {
  const result: Record<LegacyLeadResolution, number> = {
    create: 0, match: 0, replay: 0, quarantine: 0,
  };
  for (const row of rows) result[row.resolution] += 1;
  return result;
}

function asNormalizedRow(
  sourceSystem: string,
  sourcePayload: unknown,
  expectedHash: Uint8Array,
  now: Date,
): NormalizedLegacyLeadRow {
  const batch = normalizeLegacyLeadBatch({
    schemaVersion: 1,
    sourceSystem,
    batchKey: 'staged-row-integrity-check',
    rows: [sourcePayload as never],
  }, now);
  const row = batch.rows[0];
  if (!row || !equalBytes(row.payloadHash, expectedHash)) {
    throw new LegacyImportConflictError('A staged legacy lead failed its canonical payload integrity check');
  }
  return row;
}

function asNormalizedUnresolvedAttribution(
  sourceSystem: string,
  sourcePayload: unknown,
  expectedHash: Uint8Array,
  now: Date,
): NormalizedLegacyUnresolvedAttribution {
  const batch = normalizeLegacyLeadBatch({
    schemaVersion: 1,
    sourceSystem,
    batchKey: 'staged-unresolved-integrity-check',
    rows: [],
    unresolvedAttributions: [sourcePayload as never],
  }, now);
  const row = batch.unresolvedAttributions[0];
  if (!row || !equalBytes(row.payloadHash, expectedHash)) {
    throw new LegacyImportConflictError(
      'A staged unresolved attribution failed its canonical payload integrity check',
    );
  }
  return row;
}

export class LegacyLeadImportService {
  private readonly nextId: () => string;
  private readonly now: () => Date;

  constructor(private readonly dependencies: LegacyLeadImportDependencies) {
    this.nextId = dependencies.nextId ?? randomUUID;
    this.now = dependencies.now ?? (() => new Date());
  }

  /** Rehearses validation and dedupe under a read-only transaction: zero writes. */
  async dryRun(
    context: DatabaseRequestContext,
    input: LegacyLeadBatchInput,
  ): Promise<LegacyLeadDryRunReport> {
    managerContext(context);
    const normalized = normalizeLegacyLeadBatch(input, this.now());
    return this.dependencies.transactionRunner.run(context, async (transaction) => {
      const repository = new LegacyLeadImportRepository(transaction);
      const report: LegacyLeadDryRunRow[] = [];
      const plannedCreates = new Map<string, number>();

      for (const [index, row] of normalized.rows.entries()) {
        const receipt = await repository.findReceipt(normalized.sourceSystem, row.sourceRecordId);
        if (receipt) {
          report.push({
            ordinal: index + 1,
            sourceRecordId: row.sourceRecordId,
            resolution: equalBytes(receipt.payloadHash, row.payloadHash) ? 'replay' : 'quarantine',
            contactId: receipt.contactId,
            reasons: [equalBytes(receipt.payloadHash, row.payloadHash)
              ? 'source_record_already_imported'
              : 'source_record_payload_changed'],
          });
          continue;
        }
        const verified = row.identities.filter((identity) => identity.verified);
        const candidates = await repository.findIdentityCandidates(verified);
        let decision = decide(candidates, verified.length);
        if (decision.resolution !== 'quarantine') {
          const owners = [...new Set(verified
            .map((identity) => plannedCreates.get(`${identity.kind}:${identity.normalizedValue}`))
            .filter((owner): owner is number => owner !== undefined))];
          if (owners.length > 1) {
            decision = { resolution: 'quarantine', contactId: null, reasons: ['split_identity_within_batch'] };
          } else if (owners[0] !== undefined && decision.resolution === 'match') {
            // The earlier row would create a new contact, while this row also
            // resolves to a different live contact. Commit would therefore see
            // a split identity after that planned insert; rehearsal must agree.
            decision = {
              resolution: 'quarantine', contactId: null,
              reasons: ['split_identity_within_batch_and_existing'],
            };
          } else if (owners[0] !== undefined) {
            decision = {
              resolution: 'match', contactId: null,
              reasons: [`matches_earlier_batch_row:${owners[0]}`],
            };
          } else if (decision.resolution === 'create') {
            for (const identity of verified) {
              plannedCreates.set(`${identity.kind}:${identity.normalizedValue}`, index + 1);
            }
          }
        }
        report.push({
          ordinal: index + 1,
          sourceRecordId: row.sourceRecordId,
          ...decision,
        });
      }

      for (const [index, unresolved] of normalized.unresolvedAttributions.entries()) {
        const receipt = await repository.findUnresolvedAttributionReceipt(
          normalized.sourceSystem,
          unresolved.recordKind,
          unresolved.sourceRecordId,
        );
        const unchangedReplay = receipt && equalBytes(receipt.payloadHash, unresolved.payloadHash);
        report.push({
          ordinal: normalized.rows.length + index + 1,
          sourceRecordId: unresolved.sourceRecordId,
          resolution: unchangedReplay ? 'replay' : 'quarantine',
          contactId: null,
          reasons: [receipt
            ? unchangedReplay
              ? 'unresolved_attribution_already_recorded'
              : 'unresolved_attribution_payload_changed'
            : `unresolved_attribution:${unresolved.reason}`],
        });
      }

      return {
        mode: 'dry_run',
        writes: 0,
        sourceSystem: normalized.sourceSystem,
        batchKey: normalized.batchKey,
        inputHash: bytesToHex(normalized.inputHash),
        rows: report,
        counts: counts(report),
      };
    }, { readOnly: true });
  }

  async stage(
    context: DatabaseRequestContext,
    input: LegacyLeadBatchInput,
  ): Promise<LegacyLeadStageResult> {
    managerContext(context);
    const now = this.now();
    const normalized = normalizeLegacyLeadBatch(input, now);
    const total = normalized.rows.length + normalized.unresolvedAttributions.length;
    return this.dependencies.transactionRunner.run(context, async (transaction) => {
      const repository = new LegacyLeadImportRepository(transaction);
      const existing = await repository.findBatch(normalized.sourceSystem, normalized.batchKey, true);
      if (existing) return this.replayedStage(existing, normalized);

      const batchId = this.nextId();
      const inserted = await repository.insertBatch({
        id: batchId,
        schemaVersion: normalized.schemaVersion,
        sourceSystem: normalized.sourceSystem,
        batchKey: normalized.batchKey,
        inputHash: normalized.inputHash,
        rowCount: total,
        actorUserId: context.userId!,
        requestId: context.requestId,
        createdAt: now.toISOString(),
      });
      if (!inserted) {
        const claimed = await repository.findBatch(normalized.sourceSystem, normalized.batchKey, true);
        if (!claimed) throw new LegacyImportConflictError('Legacy import batch claim disappeared');
        return this.replayedStage(claimed, normalized);
      }
      await repository.insertRows(
        batchId,
        normalized.sourceSystem,
        normalized.rows.map((row, index) => ({ ...row, id: this.nextId(), ordinal: index + 1 })),
        now.toISOString(),
      );
      await repository.insertUnresolvedAttributions(
        batchId,
        normalized.sourceSystem,
        normalized.unresolvedAttributions.map((row, index) => ({
          ...row, id: this.nextId(), ordinal: normalized.rows.length + index + 1,
        })),
        now.toISOString(),
      );
      return {
        disposition: 'staged', batchId, rowCount: total,
        inputHash: bytesToHex(normalized.inputHash),
      };
    }, { readOnly: false, serializable: true });
  }

  async commit(context: DatabaseRequestContext, batchId: string): Promise<LegacyLeadCommitResult> {
    managerContext(context);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(batchId)) {
      throw new LegacyImportConflictError('Legacy import batchId must be a UUID');
    }
    const now = this.now();
    return this.dependencies.transactionRunner.run(context, async (transaction) => {
      const repository = new LegacyLeadImportRepository(transaction);
      const batch = await repository.lockBatch(batchId);
      if (!batch) throw new LegacyImportConflictError('Legacy import batch was not found in this workspace');
      if (batch.status === 'committed' || batch.status === 'committed_with_quarantine') {
        return {
          disposition: 'replayed', batchId: batch.id, imported: batch.imported,
          matched: batch.matched, replayed: batch.replayed,
          quarantined: batch.quarantined,
        };
      }
      if (batch.status !== 'staged') {
        throw new LegacyImportConflictError('Legacy import batch is already being committed');
      }
      const staged = await repository.loadStagedRows(batchId);
      const stagedUnresolved = await repository.loadStagedUnresolvedAttributions(batchId);
      if (staged.length + stagedUnresolved.length !== batch.rowCount) {
        throw new LegacyImportConflictError('Legacy import batch row count failed its integrity check');
      }
      const rows = staged.map((row) => ({
        staged: row,
        normalized: asNormalizedRow(batch.sourceSystem, row.sourcePayload, row.sourcePayloadHash, now),
      }));
      const unresolvedAttributions = stagedUnresolved.map((row) => ({
        staged: row,
        normalized: asNormalizedUnresolvedAttribution(
          batch.sourceSystem,
          row.sourcePayload,
          row.sourcePayloadHash,
          now,
        ),
      }));
      await repository.lockKeys(
        [
          ...rows.map(({ normalized }) => `${batch.sourceSystem}:${normalized.sourceRecordId}`),
          ...unresolvedAttributions.map(({ normalized }) => (
            `${batch.sourceSystem}:unresolved:${normalized.recordKind}:${normalized.sourceRecordId}`
          )),
        ],
        rows.flatMap(({ normalized }) => normalized.identities
          .filter((identity) => identity.verified)
          .map((identity) => `${identity.kind}:${identity.normalizedValue}`)),
      );
      await repository.beginCommit(batchId);

      let imported = 0;
      let matched = 0;
      let replayed = 0;
      let quarantined = 0;
      const report: Array<Record<string, unknown>> = [];

      for (const { staged: stagedRow, normalized } of unresolvedAttributions) {
        const existing = await repository.findUnresolvedAttributionReceipt(
          batch.sourceSystem,
          normalized.recordKind,
          normalized.sourceRecordId,
        );
        if (existing && equalBytes(existing.payloadHash, normalized.payloadHash)) {
          replayed += 1;
          report.push({
            sourceRecordId: normalized.sourceRecordId,
            recordKind: normalized.recordKind,
            resolution: 'replayed',
            reason: 'unresolved_attribution_already_recorded',
          });
          continue;
        }
        if (existing) {
          quarantined += 1;
          report.push({
            sourceRecordId: normalized.sourceRecordId,
            recordKind: normalized.recordKind,
            resolution: 'quarantined',
            reason: 'unresolved_attribution_payload_changed',
          });
          continue;
        }
        await repository.insertUnresolvedAttributionReceipt({
          id: this.nextId(),
          batchId,
          unresolvedRowId: stagedRow.id,
          sourceSystem: batch.sourceSystem,
          recordKind: normalized.recordKind,
          sourceRecordId: normalized.sourceRecordId,
          payloadHash: normalized.payloadHash,
          originalCreatedAt: normalized.originalCreatedAt,
          actorUserId: context.userId!,
          requestId: context.requestId,
          recordedAt: now.toISOString(),
        });
        quarantined += 1;
        report.push({
          sourceRecordId: normalized.sourceRecordId,
          recordKind: normalized.recordKind,
          resolution: 'quarantined',
          reason: `unresolved_attribution:${normalized.reason}`,
        });
      }

      for (const { staged: stagedRow, normalized: row } of rows) {
        const existing = await repository.findReceipt(batch.sourceSystem, row.sourceRecordId);
        if (existing) {
          if (equalBytes(existing.payloadHash, row.payloadHash)) {
            const boardPlacement = await repository.ensureBoardOpportunity(
              existing.contactId, batch.sourceSystem, row.sourceRecordId,
            );
            replayed += 1;
            await repository.resolveRow({
              rowId: stagedRow.id, status: 'replayed', contactId: existing.contactId,
              receiptId: existing.id,
              resolution: {
                reason: 'source_record_already_imported',
                boardPlacement,
              },
              committedAt: now.toISOString(),
            });
            report.push({
              sourceRecordId: row.sourceRecordId,
              resolution: 'replayed',
              contactId: existing.contactId,
              boardPlacement,
            });
          } else {
            quarantined += 1;
            await repository.resolveRow({
              rowId: stagedRow.id, status: 'quarantined', contactId: existing.contactId,
              receiptId: null, resolution: { reason: 'source_record_payload_changed' },
              committedAt: now.toISOString(),
            });
            report.push({ sourceRecordId: row.sourceRecordId, resolution: 'quarantined', reason: 'source_record_payload_changed' });
          }
          continue;
        }

        const verified = row.identities.filter((identity) => identity.verified);
        const decision = decide(await repository.findIdentityCandidates(verified), verified.length);
        if (decision.resolution === 'quarantine') {
          quarantined += 1;
          await repository.resolveRow({
            rowId: stagedRow.id, status: 'quarantined', contactId: null,
            receiptId: null, resolution: { reasons: decision.reasons },
            committedAt: now.toISOString(),
          });
          report.push({ sourceRecordId: row.sourceRecordId, resolution: 'quarantined', reasons: decision.reasons });
          continue;
        }

        const outcome = decision.resolution === 'match' ? 'matched' : 'created';
        const contactId = decision.contactId ?? this.nextId();
        if (outcome === 'created') {
          await repository.insertContact({
            id: contactId, displayName: row.displayName, companyName: row.companyName,
            sourceSystem: batch.sourceSystem, createdAt: row.originalCreatedAt,
          });
          await repository.insertContactPoints(
            contactId,
            row.identities.map((identity) => ({ ...identity, id: this.nextId() })),
            row.originalCreatedAt,
          );
          imported += 1;
        } else {
          // Matching is append-only provenance: never overwrite the live contact.
          matched += 1;
        }
        const receiptId = this.nextId();
        const provenanceId = this.nextId();
        await repository.insertReceipt({
          id: receiptId, batchId, rowId: stagedRow.id,
          sourceSystem: batch.sourceSystem, sourceRecordId: row.sourceRecordId,
          payloadHash: row.payloadHash, contactId, outcome,
          originalCreatedAt: row.originalCreatedAt, actorUserId: context.userId!,
          importedAt: now.toISOString(),
        });
        await repository.insertProvenance({
          id: provenanceId, receiptId, contactId,
          sourceSystem: batch.sourceSystem, sourceRecordId: row.sourceRecordId,
          payloadHash: row.payloadHash, originalCreatedAt: row.originalCreatedAt,
          importedAt: now.toISOString(),
        });
        if (row.attribution) {
          await repository.insertAttribution({
            id: this.nextId(), provenanceId, contactId,
            sourceSystem: batch.sourceSystem, sourceRecordId: row.sourceRecordId,
            attribution: row.attribution, recordedAt: now.toISOString(),
          });
        }
        const boardPlacement = await repository.ensureBoardOpportunity(
          contactId, batch.sourceSystem, row.sourceRecordId,
        );
        await repository.resolveRow({
          rowId: stagedRow.id, status: outcome === 'created' ? 'imported' : 'matched',
          contactId, receiptId,
          resolution: {
            reason: decision.reasons[0],
            liveContactOverwritten: false,
            boardPlacement,
          },
          committedAt: now.toISOString(),
        });
        report.push({
          sourceRecordId: row.sourceRecordId,
          resolution: outcome,
          contactId,
          boardPlacement,
        });
      }

      await repository.completeBatch({
        batchId, imported, matched, replayed, quarantined,
        report: {
          rows: report,
          unresolvedAttributions: unresolvedAttributions.length,
          liveContactsOverwritten: 0,
        },
        committedAt: now.toISOString(),
      });
      return { disposition: 'committed', batchId, imported, matched, replayed, quarantined };
    }, { readOnly: false, serializable: true });
  }

  private replayedStage(
    existing: { id: string; inputHash: Uint8Array; rowCount: number },
    normalized: NormalizedLegacyLeadBatch,
  ): LegacyLeadStageResult {
    if (!equalBytes(existing.inputHash, normalized.inputHash)) {
      throw new LegacyImportConflictError(
        'Legacy import batchKey was already used with different canonical bytes',
      );
    }
    return {
      disposition: 'replayed', batchId: existing.id, rowCount: existing.rowCount,
      inputHash: bytesToHex(existing.inputHash),
    };
  }
}

/** Compose the importer against its dedicated least-privilege command pool. */
export function createPgLegacyLeadImportService(
  pool: Parameters<typeof createPgLegacyImportTransactionRunner>[0],
): LegacyLeadImportService {
  return new LegacyLeadImportService({
    transactionRunner: createPgLegacyImportTransactionRunner(pool),
  });
}
