import type { Pool, QueryResultRow } from 'pg';
import type { SqlExecutor } from '../crm-pg/types.js';
import type { DatabaseRequestContext } from '../db/rls.js';
import { withTransaction } from '../db/transaction.js';
import type { LegacyImportTransactionRunner } from './types.js';
import type {
  NormalizedLegacyLeadAttribution,
  NormalizedLegacyLeadIdentity,
  NormalizedLegacyLeadRow,
  NormalizedLegacyUnresolvedAttribution,
} from './types.js';
import { bytesToHex } from './validation.js';

export interface LegacyImportBatchRecord {
  readonly id: string;
  readonly sourceSystem: string;
  readonly inputHash: Uint8Array;
  readonly status: 'staged' | 'committing' | 'committed' | 'committed_with_quarantine';
  readonly rowCount: number;
  readonly imported: number;
  readonly matched: number;
  readonly replayed: number;
  readonly quarantined: number;
}

interface BatchRow extends QueryResultRow {
  id: string;
  sourceSystem: string;
  inputHash: Uint8Array;
  status: LegacyImportBatchRecord['status'];
  rowCount: number | string;
  imported: number | string;
  matched: number | string;
  replayed: number | string;
  quarantined: number | string;
}

export interface StagedLegacyLeadRow {
  readonly id: string;
  readonly ordinal: number;
  readonly sourceRecordId: string;
  readonly sourcePayload: unknown;
  readonly sourcePayloadHash: Uint8Array;
  readonly originalCreatedAt: string;
}

interface StagedRow extends QueryResultRow {
  id: string;
  ordinal: number | string;
  sourceRecordId: string;
  sourcePayload: unknown;
  sourcePayloadHash: Uint8Array;
  originalCreatedAt: string;
}

export interface StagedLegacyUnresolvedAttributionRow {
  readonly id: string;
  readonly ordinal: number;
  readonly recordKind: NormalizedLegacyUnresolvedAttribution['recordKind'];
  readonly sourceRecordId: string;
  readonly sourcePayload: unknown;
  readonly sourcePayloadHash: Uint8Array;
  readonly originalCreatedAt: string;
}

interface StagedUnresolvedRow extends QueryResultRow {
  id: string;
  ordinal: number | string;
  recordKind: NormalizedLegacyUnresolvedAttribution['recordKind'];
  sourceRecordId: string;
  sourcePayload: unknown;
  sourcePayloadHash: Uint8Array;
  originalCreatedAt: string;
}

export interface LegacyUnresolvedAttributionReceiptRecord {
  readonly id: string;
  readonly payloadHash: Uint8Array;
}

interface UnresolvedReceiptRow extends QueryResultRow {
  id: string;
  payloadHash: Uint8Array;
}

export interface LegacyImportReceiptRecord {
  readonly id: string;
  readonly contactId: string;
  readonly payloadHash: Uint8Array;
  readonly outcome: 'created' | 'matched';
}

interface ReceiptRow extends QueryResultRow {
  id: string;
  contactId: string;
  payloadHash: Uint8Array;
  outcome: 'created' | 'matched';
}

export interface IdentityCandidate {
  readonly kind: 'email' | 'phone';
  readonly normalizedValue: string;
  readonly contactId: string;
  readonly dedupeState: 'normal' | 'shared' | 'quarantined';
  readonly contactState: 'active' | 'archived' | 'deleted';
}

interface CandidateRow extends QueryResultRow, IdentityCandidate {}

export interface LegacyLeadBoardPlacement {
  readonly disposition: 'created' | 'existing' | 'blocked';
  readonly opportunityId: string | null;
  readonly pipelineId: string | null;
  readonly stageId: string | null;
  readonly failureReason:
    | 'contact_inactive'
    | 'default_pipeline_missing'
    | 'first_open_stage_missing'
    | null;
}

interface BoardPlacementRow extends QueryResultRow, LegacyLeadBoardPlacement {}

function batch(row: BatchRow): LegacyImportBatchRecord {
  return {
    id: row.id,
    sourceSystem: row.sourceSystem,
    inputHash: row.inputHash,
    status: row.status,
    rowCount: Number(row.rowCount),
    imported: Number(row.imported),
    matched: Number(row.matched),
    replayed: Number(row.replayed),
    quarantined: Number(row.quarantined),
  };
}

export class LegacyLeadImportRepository {
  constructor(private readonly transaction: SqlExecutor) {}

  async findBatch(sourceSystem: string, batchKey: string, lock = false): Promise<LegacyImportBatchRecord | null> {
    const result = await this.transaction.query<BatchRow>(
      `/* legacy-import.find-batch */
       SELECT id, source_system AS "sourceSystem", input_sha256 AS "inputHash", status,
              row_count AS "rowCount", imported_count AS imported,
              matched_count AS matched, replayed_count AS replayed,
              quarantined_count AS quarantined
       FROM app_private.legacy_lead_import_batches
       WHERE source_system = $1 AND batch_key = $2
       ${lock ? 'FOR UPDATE' : ''}`,
      [sourceSystem, batchKey],
    );
    return result.rows[0] ? batch(result.rows[0]) : null;
  }

  async lockBatch(batchId: string): Promise<LegacyImportBatchRecord | null> {
    const result = await this.transaction.query<BatchRow>(
      `/* legacy-import.lock-batch */
       SELECT id, source_system AS "sourceSystem", input_sha256 AS "inputHash", status,
              row_count AS "rowCount", imported_count AS imported,
              matched_count AS matched, replayed_count AS replayed,
              quarantined_count AS quarantined
       FROM app_private.legacy_lead_import_batches
       WHERE id = $1
       FOR UPDATE`,
      [batchId],
    );
    return result.rows[0] ? batch(result.rows[0]) : null;
  }

  async insertBatch(input: {
    id: string;
    schemaVersion: 1;
    sourceSystem: string;
    batchKey: string;
    inputHash: Uint8Array;
    rowCount: number;
    actorUserId: string;
    requestId: string;
    createdAt: string;
  }): Promise<boolean> {
    const result = await this.transaction.query<{ id: string }>(
      `/* legacy-import.insert-batch */
       INSERT INTO app_private.legacy_lead_import_batches (
         id, workspace_id, schema_version, source_system, batch_key, input_sha256, status,
         row_count, created_by_user_id, request_id, created_at
       ) VALUES (
         $1, app_private.current_workspace_id(), $2, $3, $4, $5,
         'staged', $6, $7, $8, $9::timestamptz
       )
       ON CONFLICT (workspace_id, source_system, batch_key) DO NOTHING
       RETURNING id`,
      [
        input.id, input.schemaVersion, input.sourceSystem, input.batchKey,
        input.inputHash, input.rowCount, input.actorUserId, input.requestId,
        input.createdAt,
      ],
    );
    return result.rowCount === 1;
  }

  async insertRows(
    batchId: string,
    sourceSystem: string,
    rows: readonly (NormalizedLegacyLeadRow & { readonly id: string; readonly ordinal: number })[],
    stagedAt: string,
  ): Promise<void> {
    if (rows.length === 0) return;
    const payload = rows.map((row) => ({
      id: row.id,
      ordinal: row.ordinal,
      source_record_id: row.sourceRecordId,
      source_payload: JSON.parse(row.payloadJson),
      payload_hash_hex: bytesToHex(row.payloadHash),
      original_created_at: row.originalCreatedAt,
    }));
    const result = await this.transaction.query(
      `/* legacy-import.insert-rows */
       INSERT INTO app_private.legacy_lead_import_rows (
         id, workspace_id, batch_id, source_system, ordinal,
         source_record_id, source_payload, source_payload_sha256,
         original_created_at, status, staged_at
       )
       SELECT row.id, app_private.current_workspace_id(), $1, $2,
              row.ordinal, row.source_record_id, row.source_payload,
              decode(row.payload_hash_hex, 'hex'), row.original_created_at,
              'staged', $4::timestamptz
       FROM jsonb_to_recordset($3::jsonb) AS row(
         id uuid, ordinal integer, source_record_id text,
         source_payload jsonb, payload_hash_hex text,
         original_created_at timestamptz
       )`,
      [batchId, sourceSystem, JSON.stringify(payload), stagedAt],
    );
    if (result.rowCount !== rows.length) throw new Error('Legacy import did not stage every lead row');
  }

  async insertUnresolvedAttributions(
    batchId: string,
    sourceSystem: string,
    rows: readonly (NormalizedLegacyUnresolvedAttribution & { readonly id: string; readonly ordinal: number })[],
    quarantinedAt: string,
  ): Promise<void> {
    if (rows.length === 0) return;
    const payload = rows.map((row) => ({
      id: row.id,
      ordinal: row.ordinal,
      record_kind: row.recordKind,
      source_record_id: row.sourceRecordId,
      referred_source_record_id: row.referredSourceRecordId,
      affiliate_source_id: row.affiliateSourceId,
      affiliate_code: row.affiliateCode,
      referral_code: row.referralCode,
      source_payload: JSON.parse(row.payloadJson),
      payload_hash_hex: bytesToHex(row.payloadHash),
      original_created_at: row.originalCreatedAt,
      reason: row.reason,
    }));
    const result = await this.transaction.query(
      `/* legacy-import.insert-unresolved-attributions */
       INSERT INTO app_private.legacy_lead_unresolved_attributions (
         id, workspace_id, batch_id, source_system, ordinal, record_kind,
         source_record_id, referred_source_record_id, affiliate_source_id,
         affiliate_code, referral_code, source_payload, source_payload_sha256,
         original_created_at, reason, quarantined_at
       )
       SELECT row.id, app_private.current_workspace_id(), $1, $2,
              row.ordinal, row.record_kind, row.source_record_id,
              row.referred_source_record_id, row.affiliate_source_id,
              row.affiliate_code, row.referral_code, row.source_payload,
              decode(row.payload_hash_hex, 'hex'), row.original_created_at,
              row.reason, $4::timestamptz
       FROM jsonb_to_recordset($3::jsonb) AS row(
         id uuid, ordinal integer, record_kind text, source_record_id text,
         referred_source_record_id text, affiliate_source_id text,
         affiliate_code text, referral_code text, source_payload jsonb,
         payload_hash_hex text, original_created_at timestamptz, reason text
       )`,
      [batchId, sourceSystem, JSON.stringify(payload), quarantinedAt],
    );
    if (result.rowCount !== rows.length) {
      throw new Error('Legacy import did not retain every unresolved attribution');
    }
  }

  async loadStagedRows(batchId: string): Promise<StagedLegacyLeadRow[]> {
    const result = await this.transaction.query<StagedRow>(
      `/* legacy-import.load-staged-rows */
       SELECT id, ordinal, source_record_id AS "sourceRecordId",
              source_payload AS "sourcePayload",
              source_payload_sha256 AS "sourcePayloadHash",
              original_created_at::text AS "originalCreatedAt"
       FROM app_private.legacy_lead_import_rows
       WHERE batch_id = $1
       ORDER BY ordinal, id`,
      [batchId],
    );
    return result.rows.map((row) => ({ ...row, ordinal: Number(row.ordinal) }));
  }

  async countUnresolvedAttributions(batchId: string): Promise<number> {
    const result = await this.transaction.query<{ count: number | string }>(
      `/* legacy-import.count-unresolved-attributions */
       SELECT count(*) AS count
       FROM app_private.legacy_lead_unresolved_attributions
       WHERE batch_id = $1`,
      [batchId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async loadStagedUnresolvedAttributions(
    batchId: string,
  ): Promise<StagedLegacyUnresolvedAttributionRow[]> {
    const result = await this.transaction.query<StagedUnresolvedRow>(
      `/* legacy-import.load-staged-unresolved-attributions */
       SELECT id, ordinal, record_kind AS "recordKind",
              source_record_id AS "sourceRecordId", source_payload AS "sourcePayload",
              source_payload_sha256 AS "sourcePayloadHash",
              original_created_at::text AS "originalCreatedAt"
       FROM app_private.legacy_lead_unresolved_attributions
       WHERE batch_id = $1
       ORDER BY ordinal, id`,
      [batchId],
    );
    return result.rows.map((row) => ({ ...row, ordinal: Number(row.ordinal) }));
  }

  async findUnresolvedAttributionReceipt(
    sourceSystem: string,
    recordKind: NormalizedLegacyUnresolvedAttribution['recordKind'],
    sourceRecordId: string,
  ): Promise<LegacyUnresolvedAttributionReceiptRecord | null> {
    const result = await this.transaction.query<UnresolvedReceiptRow>(
      `/* legacy-import.find-unresolved-attribution-receipt */
       SELECT id, source_payload_sha256 AS "payloadHash"
       FROM app_private.legacy_lead_unresolved_attribution_receipts
       WHERE source_system = $1 AND record_kind = $2 AND source_record_id = $3`,
      [sourceSystem, recordKind, sourceRecordId],
    );
    return result.rows[0] ?? null;
  }

  async insertUnresolvedAttributionReceipt(input: {
    id: string;
    batchId: string;
    unresolvedRowId: string;
    sourceSystem: string;
    recordKind: NormalizedLegacyUnresolvedAttribution['recordKind'];
    sourceRecordId: string;
    payloadHash: Uint8Array;
    originalCreatedAt: string;
    actorUserId: string;
    requestId: string;
    recordedAt: string;
  }): Promise<void> {
    const result = await this.transaction.query(
      `/* legacy-import.insert-unresolved-attribution-receipt */
       INSERT INTO app_private.legacy_lead_unresolved_attribution_receipts (
         id, workspace_id, batch_id, unresolved_row_id, source_system,
         record_kind, source_record_id, source_payload_sha256,
         original_created_at, recorded_by_user_id, request_id, recorded_at
       ) VALUES (
         $1, app_private.current_workspace_id(), $2, $3, $4,
         $5, $6, $7, $8::timestamptz, $9, $10, $11::timestamptz
       )`,
      [
        input.id, input.batchId, input.unresolvedRowId, input.sourceSystem,
        input.recordKind, input.sourceRecordId, input.payloadHash,
        input.originalCreatedAt, input.actorUserId, input.requestId,
        input.recordedAt,
      ],
    );
    if (result.rowCount !== 1) {
      throw new Error('Legacy import unresolved attribution receipt insert returned no row');
    }
  }

  async lockKeys(sourceKeys: readonly string[], identityKeys: readonly string[]): Promise<void> {
    const allKeys = [
      ...new Set([
        ...sourceKeys.map((key) => `source:${key}`),
        ...identityKeys.map((key) => `identity:${key}`),
      ]),
    ].sort();
    if (allKeys.length === 0) return;
    await this.transaction.query(
      `/* legacy-import.lock-source-and-identity-keys */
       SELECT pg_advisory_xact_lock(
                hashtext(app_private.current_workspace_id()::text),
                hashtext(candidate.key)
              )
       FROM (SELECT key FROM unnest($1::text[]) AS key ORDER BY key) AS candidate`,
      [allKeys],
    );
  }

  async findReceipt(sourceSystem: string, sourceRecordId: string): Promise<LegacyImportReceiptRecord | null> {
    const result = await this.transaction.query<ReceiptRow>(
      `/* legacy-import.find-receipt */
       SELECT id, contact_id AS "contactId",
              source_payload_sha256 AS "payloadHash", outcome
       FROM app_private.legacy_lead_import_receipts
       WHERE source_system = $1 AND source_record_id = $2`,
      [sourceSystem, sourceRecordId],
    );
    return result.rows[0] ?? null;
  }

  async findIdentityCandidates(
    identities: readonly Pick<NormalizedLegacyLeadIdentity, 'kind' | 'normalizedValue'>[],
  ): Promise<IdentityCandidate[]> {
    if (identities.length === 0) return [];
    const result = await this.transaction.query<CandidateRow>(
      `/* legacy-import.find-identity-candidates */
       SELECT point.kind, point.normalized_value AS "normalizedValue",
              point.contact_id AS "contactId", point.dedupe_state AS "dedupeState",
              CASE
                WHEN contact.deleted_at IS NOT NULL THEN 'deleted'
                WHEN contact.lifecycle_status = 'archived' THEN 'archived'
                ELSE 'active'
              END AS "contactState"
       FROM jsonb_to_recordset($1::jsonb) AS requested(kind text, normalized_value text)
       JOIN app.contact_points AS point
         ON point.kind = requested.kind
        AND point.normalized_value = requested.normalized_value
        AND point.deleted_at IS NULL
       JOIN app.contacts AS contact
         ON contact.workspace_id = point.workspace_id
        AND contact.id = point.contact_id
       ORDER BY point.kind, point.normalized_value, point.contact_id, point.id`,
      [JSON.stringify(identities.map((identity) => ({
        kind: identity.kind,
        normalized_value: identity.normalizedValue,
      })))],
    );
    return result.rows;
  }

  async insertContact(input: {
    id: string;
    displayName: string;
    companyName: string | null;
    sourceSystem: string;
    createdAt: string;
  }): Promise<void> {
    const result = await this.transaction.query(
      `/* legacy-import.insert-contact */
       INSERT INTO app.contacts (
         id, workspace_id, display_name, company_name, lifecycle_status,
         owner_user_id, source, custom_fields, row_version, created_at, updated_at
       ) VALUES (
         $1, app_private.current_workspace_id(), $2, $3, 'lead',
         NULL, $4, '{}'::jsonb, 1, $5::timestamptz, $5::timestamptz
       )`,
      [input.id, input.displayName, input.companyName, input.sourceSystem, input.createdAt],
    );
    if (result.rowCount !== 1) throw new Error('Legacy import contact insert returned no row');
  }

  async insertContactPoints(
    contactId: string,
    identities: readonly (NormalizedLegacyLeadIdentity & { readonly id: string })[],
    createdAt: string,
  ): Promise<void> {
    const payload = identities.map((identity) => ({
      ...identity,
      isPrimary: identity.verified && identity.primary,
      dedupeState: identity.verified ? 'normal' : 'quarantined',
    }));
    const result = await this.transaction.query(
      `/* legacy-import.insert-contact-points */
       INSERT INTO app.contact_points (
         id, workspace_id, contact_id, kind, label, value, normalized_value,
         is_primary, is_verified, dedupe_state, consent_status,
         row_version, created_at, updated_at
       )
       SELECT point.id, app_private.current_workspace_id(), $1, point.kind,
              point.label, point.value, point.normalized_value,
              point.is_primary, point.verified, point.dedupe_state, 'unknown',
              1, $3::timestamptz, $3::timestamptz
       FROM jsonb_to_recordset($2::jsonb) AS point(
         id uuid, kind text, label text, value text, normalized_value text,
         is_primary boolean, verified boolean, dedupe_state text
       )`,
      [contactId, JSON.stringify(payload.map((point) => ({
        id: point.id,
        kind: point.kind,
        label: point.label,
        value: point.value,
        normalized_value: point.normalizedValue,
        is_primary: point.isPrimary,
        verified: point.verified,
        dedupe_state: point.dedupeState,
      }))), createdAt],
    );
    if (result.rowCount !== identities.length) {
      throw new Error('Legacy import did not insert every contact point');
    }
  }

  async insertReceipt(input: {
    id: string;
    batchId: string;
    rowId: string;
    sourceSystem: string;
    sourceRecordId: string;
    payloadHash: Uint8Array;
    contactId: string;
    outcome: 'created' | 'matched';
    originalCreatedAt: string;
    actorUserId: string;
    importedAt: string;
  }): Promise<void> {
    const result = await this.transaction.query(
      `/* legacy-import.insert-receipt */
       INSERT INTO app_private.legacy_lead_import_receipts (
         id, workspace_id, batch_id, row_id, source_system, source_record_id,
         source_payload_sha256, contact_id, outcome, original_created_at,
         imported_by_user_id, imported_at
       ) VALUES (
         $1, app_private.current_workspace_id(), $2, $3, $4, $5,
         $6, $7, $8, $9::timestamptz, $10, $11::timestamptz
       )`,
      [
        input.id, input.batchId, input.rowId, input.sourceSystem,
        input.sourceRecordId, input.payloadHash, input.contactId, input.outcome,
        input.originalCreatedAt, input.actorUserId, input.importedAt,
      ],
    );
    if (result.rowCount !== 1) throw new Error('Legacy import receipt insert returned no row');
  }

  async insertProvenance(input: {
    id: string;
    receiptId: string;
    contactId: string;
    sourceSystem: string;
    sourceRecordId: string;
    payloadHash: Uint8Array;
    originalCreatedAt: string;
    importedAt: string;
  }): Promise<void> {
    const result = await this.transaction.query(
      `/* legacy-import.insert-provenance */
       INSERT INTO app.contact_import_provenance (
         id, workspace_id, contact_id, import_receipt_id, source_system,
         source_record_id, source_payload_sha256, original_created_at, imported_at
       ) VALUES (
         $1, app_private.current_workspace_id(), $2, $3, $4,
         $5, $6, $7::timestamptz, $8::timestamptz
       )`,
      [
        input.id, input.contactId, input.receiptId, input.sourceSystem,
        input.sourceRecordId, input.payloadHash, input.originalCreatedAt,
        input.importedAt,
      ],
    );
    if (result.rowCount !== 1) throw new Error('Legacy import provenance insert returned no row');
  }

  async insertAttribution(input: {
    id: string;
    provenanceId: string;
    contactId: string;
    sourceSystem: string;
    sourceRecordId: string;
    attribution: NormalizedLegacyLeadAttribution;
    recordedAt: string;
  }): Promise<void> {
    const attribution = input.attribution;
    const result = await this.transaction.query(
      `/* legacy-import.insert-attribution */
       INSERT INTO app.contact_import_attribution_facts (
         id, workspace_id, contact_id, provenance_id, source_system,
         source_record_id, affiliate_source_id, affiliate_name, affiliate_code,
         referral_code, utm_source, utm_medium, utm_campaign, utm_term,
         utm_content, referrer_url, landing_url, attributed_at, recorded_at
       ) VALUES (
         $1, app_private.current_workspace_id(), $2, $3, $4,
         $5, $6, $7, $8, $9, $10, $11, $12, $13,
         $14, $15, $16, $17::timestamptz, $18::timestamptz
       )`,
      [
        input.id, input.contactId, input.provenanceId, input.sourceSystem,
        input.sourceRecordId, attribution.affiliateSourceId,
        attribution.affiliateName, attribution.affiliateCode,
        attribution.referralCode, attribution.utmSource, attribution.utmMedium,
        attribution.utmCampaign, attribution.utmTerm, attribution.utmContent,
        attribution.referrerUrl, attribution.landingUrl,
        attribution.attributedAt, input.recordedAt,
      ],
    );
    if (result.rowCount !== 1) throw new Error('Legacy import attribution insert returned no row');
    const privatePayload = await this.transaction.query(
      `/* legacy-import.insert-attribution-payload */
       INSERT INTO app_private.contact_import_attribution_payloads (
         id, workspace_id, attribution_fact_id, contact_id, source_system,
         source_record_id, raw_attribution, recorded_at
       ) VALUES (
         $1, app_private.current_workspace_id(), $1, $2, $3,
         $4, $5::jsonb, $6::timestamptz
       )`,
      [
        input.id, input.contactId, input.sourceSystem, input.sourceRecordId,
        JSON.stringify(attribution.raw), input.recordedAt,
      ],
    );
    if (privatePayload.rowCount !== 1) {
      throw new Error('Legacy import private attribution payload insert returned no row');
    }
  }

  async ensureBoardOpportunity(
    contactId: string,
    sourceSystem: string,
    sourceRecordId: string,
  ): Promise<LegacyLeadBoardPlacement> {
    const result = await this.transaction.query<BoardPlacementRow>(
      `/* legacy-import.ensure-board-opportunity */
       SELECT disposition,
              opportunity_id AS "opportunityId",
              pipeline_id AS "pipelineId",
              stage_id AS "stageId",
              failure_reason AS "failureReason"
       FROM app_private.ensure_legacy_lead_board_opportunity($1, $2, $3)`,
      [contactId, sourceSystem, sourceRecordId],
    );
    const placement = result.rows[0];
    if (!placement || result.rowCount !== 1) {
      throw new Error('Legacy import board opportunity materialization returned no outcome');
    }
    return placement;
  }

  async resolveRow(input: {
    rowId: string;
    status: 'imported' | 'matched' | 'replayed' | 'quarantined';
    contactId: string | null;
    receiptId: string | null;
    resolution: Readonly<Record<string, unknown>>;
    committedAt: string;
  }): Promise<void> {
    const result = await this.transaction.query(
      `/* legacy-import.resolve-row */
       UPDATE app_private.legacy_lead_import_rows
       SET status = $2, matched_contact_id = $3, import_receipt_id = $4,
           resolution = $5::jsonb, committed_at = $6::timestamptz
       WHERE id = $1 AND status = 'staged'`,
      [
        input.rowId, input.status, input.contactId, input.receiptId,
        JSON.stringify(input.resolution), input.committedAt,
      ],
    );
    if (result.rowCount !== 1) throw new Error('Legacy import row lost its staged state');
  }

  async beginCommit(batchId: string): Promise<void> {
    const result = await this.transaction.query(
      `/* legacy-import.begin-commit */
       UPDATE app_private.legacy_lead_import_batches
       SET status = 'committing'
       WHERE id = $1 AND status = 'staged'`,
      [batchId],
    );
    if (result.rowCount !== 1) throw new Error('Legacy import batch lost its staged state');
  }

  async completeBatch(input: {
    batchId: string;
    imported: number;
    matched: number;
    replayed: number;
    quarantined: number;
    report: Readonly<Record<string, unknown>>;
    committedAt: string;
  }): Promise<void> {
    const status = input.quarantined > 0 ? 'committed_with_quarantine' : 'committed';
    const result = await this.transaction.query(
      `/* legacy-import.complete-batch */
       UPDATE app_private.legacy_lead_import_batches
       SET status = $2, imported_count = $3, matched_count = $4,
           replayed_count = $5, quarantined_count = $6,
           report = $7::jsonb, committed_at = $8::timestamptz
       WHERE id = $1 AND status = 'committing'`,
      [
        input.batchId, status, input.imported, input.matched, input.replayed,
        input.quarantined, JSON.stringify(input.report), input.committedAt,
      ],
    );
    if (result.rowCount !== 1) throw new Error('Legacy import batch completion lost its claim');
  }
}

/** The supplied pool must authenticate as the dedicated r72_import_command role. */
export function createPgLegacyImportTransactionRunner(
  pool: Pick<Pool, 'connect'>,
): LegacyImportTransactionRunner {
  return {
    run<T>(
      context: DatabaseRequestContext,
      operation: (transaction: SqlExecutor) => Promise<T>,
      options: Readonly<{ readOnly: boolean; serializable?: boolean }>,
    ): Promise<T> {
      return withTransaction(pool, context, async (client) => operation({
        async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
          sql: string,
          values?: readonly unknown[],
        ) {
          const result = await client.query<TRow>(sql, values ? [...values] : undefined);
          return { rows: result.rows, rowCount: result.rowCount };
        },
      }), {
        readOnly: options.readOnly,
        isolation: options.serializable ? 'serializable' : 'repeatable read',
      });
    },
  };
}
