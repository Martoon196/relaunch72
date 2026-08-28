export type CsvImportTargetField =
  | 'contact.first_name'
  | 'contact.last_name'
  | 'contact.full_name'
  | 'contact.email'
  | 'contact.phone'
  | 'contact.company'
  | 'contact.job_title'
  | 'lead.title'
  | 'lead.stage'
  | 'lead.status'
  | 'lead.value'
  | 'lead.currency'
  | 'lead.source'
  | 'lead.notes';

export interface CsvImportColumnMapping {
  /** Source header as supplied by the operator; the core canonicalises it. */
  readonly sourceHeader: string;
  readonly targetField: CsvImportTargetField;
}

export interface CsvImportMapping {
  readonly columns: readonly CsvImportColumnMapping[];
  /** Source columns retained verbatim as attribution data, never interpreted as IDs. */
  readonly affiliateSourceHeaders?: readonly string[];
  /** Optional explicit non-empty gates for a row to be eligible. */
  readonly requiredTargetFields?: readonly CsvImportTargetField[];
}

export interface CsvPreviewLimits {
  readonly maxBytes?: number;
  readonly maxRows?: number;
  readonly maxColumns?: number;
  readonly maxCellBytes?: number;
}

export interface LegacyImportSourcePayload {
  readonly bytes: Uint8Array;
  readonly mediaType: 'text/csv' | 'application/csv';
}

/**
 * Minimal read-only boundary for a future upload, API or object-store source.
 * Implementations expose bytes only; persistence and provider methods are not part of the contract.
 */
export interface LegacyImportSourceAdapter {
  readonly adapterId: string;
  read(): Promise<LegacyImportSourcePayload>;
}

export interface CsvImportProvenance {
  readonly adapterId: string;
  readonly sourceSha256: string;
  readonly headerSchemaSha256: string;
  readonly mappingSha256: string;
  readonly sourceRowNumber: number;
  readonly rowSha256: string;
}

export interface CsvImportAffiliateSourceValue {
  readonly column: string;
  readonly value: string;
}

export interface CsvImportMappedEntity {
  readonly fields: Readonly<Record<string, string>>;
}

export interface CsvImportPreviewRecord {
  readonly contact: CsvImportMappedEntity | null;
  readonly lead: CsvImportMappedEntity | null;
  readonly affiliateSources: readonly CsvImportAffiliateSourceValue[];
  readonly provenance: CsvImportProvenance;
}

export type CsvImportQuarantineReason =
  | 'formula_injection_cell'
  | 'required_value_missing'
  | 'mapped_entity_empty';

export interface CsvImportQuarantinedRow {
  readonly sourceRowNumber: number;
  readonly rowSha256: string;
  readonly reasons: readonly CsvImportQuarantineReason[];
  /** Column indexes are one-based and contain no source values or header text. */
  readonly unsafeColumnIndexes: readonly number[];
}

export interface CsvImportPreviewReceipt {
  readonly schemaVersion: 1;
  readonly adapterId: string;
  readonly sourceSha256: string;
  readonly headerSchemaSha256: string;
  readonly mappingSha256: string;
  readonly receiptSha256: string;
  readonly byteCount: number;
  readonly rowCount: number;
  readonly acceptedRowCount: number;
  readonly quarantinedRowCount: number;
  readonly columnCount: number;
  readonly quarantineReasonCounts: Readonly<Record<CsvImportQuarantineReason, number>>;
  readonly effects: Readonly<{
    databaseWrites: 0;
    externalMutations: 0;
    providerCalls: 0;
  }>;
}

export interface CsvImportPreview {
  readonly schemaVersion: 1;
  readonly canonicalHeaders: readonly string[];
  /** Mapped preview data; deliberately excluded from the PII-free receipt. */
  readonly records: readonly CsvImportPreviewRecord[];
  /** Hashes and reason codes only; raw rejected cells never cross this boundary. */
  readonly quarantinedRows: readonly CsvImportQuarantinedRow[];
  readonly receipt: CsvImportPreviewReceipt;
  readonly previewOnly: true;
  readonly providerEffects: false;
}

export type CsvImportPreviewErrorCode =
  | 'adapter_invalid'
  | 'adapter_surface_unsafe'
  | 'limits_invalid'
  | 'source_read_failed'
  | 'source_media_type_unsafe'
  | 'source_too_large'
  | 'source_encoding_unsafe'
  | 'source_contains_nul'
  | 'csv_empty'
  | 'csv_syntax_invalid'
  | 'csv_too_many_rows'
  | 'csv_too_many_columns'
  | 'csv_cell_too_large'
  | 'csv_header_empty'
  | 'csv_header_duplicate'
  | 'csv_header_unsafe'
  | 'csv_row_ragged'
  | 'mapping_invalid';

/** Fixed-code error: messages never interpolate source bytes, headers or cell values. */
export class CsvImportPreviewError extends Error {
  constructor(readonly code: CsvImportPreviewErrorCode) {
    super(CSV_IMPORT_PREVIEW_ERROR_MESSAGES[code]);
    this.name = 'CsvImportPreviewError';
  }
}

const CSV_IMPORT_PREVIEW_ERROR_MESSAGES: Readonly<Record<CsvImportPreviewErrorCode, string>> = Object.freeze({
  adapter_invalid: 'The import source adapter is invalid.',
  adapter_surface_unsafe: 'The import source adapter exposes a forbidden mutation surface.',
  limits_invalid: 'The CSV preview limits are invalid.',
  source_read_failed: 'The import source could not be read safely.',
  source_media_type_unsafe: 'The import source is not an approved CSV media type.',
  source_too_large: 'The CSV source exceeds its byte limit.',
  source_encoding_unsafe: 'The CSV source is not canonical UTF-8.',
  source_contains_nul: 'The CSV source contains a forbidden NUL character.',
  csv_empty: 'The CSV source does not contain a header row.',
  csv_syntax_invalid: 'The CSV source does not follow the supported RFC4180 quoting rules.',
  csv_too_many_rows: 'The CSV source exceeds its row limit.',
  csv_too_many_columns: 'The CSV source exceeds its column limit.',
  csv_cell_too_large: 'A CSV cell exceeds its byte limit.',
  csv_header_empty: 'A CSV header is empty after canonical normalisation.',
  csv_header_duplicate: 'CSV headers collide after canonical normalisation.',
  csv_header_unsafe: 'A CSV header is unsafe for object mapping.',
  csv_row_ragged: 'A CSV data row does not match the header width.',
  mapping_invalid: 'The explicit CSV mapping is invalid.',
});
