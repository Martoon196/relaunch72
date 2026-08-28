import { createHash } from 'node:crypto';
import {
  CsvImportPreviewError,
  type CsvImportAffiliateSourceValue,
  type CsvImportColumnMapping,
  type CsvImportMappedEntity,
  type CsvImportMapping,
  type CsvImportPreview,
  type CsvImportPreviewReceipt,
  type CsvImportQuarantineReason,
  type CsvImportQuarantinedRow,
  type CsvImportTargetField,
  type CsvPreviewLimits,
  type LegacyImportSourceAdapter,
  type LegacyImportSourcePayload,
} from './csv-preview-types.js';

const HARD_LIMITS = Object.freeze({
  maxBytes: 10 * 1024 * 1024,
  maxRows: 50_000,
  maxColumns: 250,
  maxCellBytes: 128 * 1024,
});

const DEFAULT_LIMITS = Object.freeze({
  maxBytes: 5 * 1024 * 1024,
  maxRows: 10_000,
  maxColumns: 100,
  maxCellBytes: 64 * 1024,
});

const TARGET_FIELDS = new Set<CsvImportTargetField>([
  'contact.first_name', 'contact.last_name', 'contact.full_name', 'contact.email',
  'contact.phone', 'contact.company', 'contact.job_title', 'lead.title', 'lead.stage',
  'lead.status', 'lead.value', 'lead.currency', 'lead.source', 'lead.notes',
]);

const FORBIDDEN_ADAPTER_METHODS = Object.freeze([
  'write', 'save', 'commit', 'insert', 'update', 'delete', 'remove', 'send',
  'publish', 'schedule', 'generate', 'mutate', 'execute',
]);

const REASON_ORDER: readonly CsvImportQuarantineReason[] = Object.freeze([
  'formula_injection_cell', 'required_value_missing', 'mapped_entity_empty',
]);

interface ResolvedLimits {
  readonly maxBytes: number;
  readonly maxRows: number;
  readonly maxColumns: number;
  readonly maxCellBytes: number;
}

interface ParsedCsv {
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

interface ResolvedColumnMapping {
  readonly sourceHeader: string;
  readonly sourceIndex: number;
  readonly targetField: CsvImportTargetField;
}

interface ResolvedMapping {
  readonly columns: readonly ResolvedColumnMapping[];
  readonly affiliateColumns: readonly Readonly<{ sourceHeader: string; sourceIndex: number }>[];
  readonly requiredTargetFields: readonly CsvImportTargetField[];
  readonly sha256: string;
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function positiveLimit(
  value: number | undefined,
  fallback: number,
  hardMaximum: number,
): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > hardMaximum) {
    throw new CsvImportPreviewError('limits_invalid');
  }
  return candidate;
}

function resolveLimits(input: CsvPreviewLimits | undefined): ResolvedLimits {
  return Object.freeze({
    maxBytes: positiveLimit(input?.maxBytes, DEFAULT_LIMITS.maxBytes, HARD_LIMITS.maxBytes),
    maxRows: positiveLimit(input?.maxRows, DEFAULT_LIMITS.maxRows, HARD_LIMITS.maxRows),
    maxColumns: positiveLimit(input?.maxColumns, DEFAULT_LIMITS.maxColumns, HARD_LIMITS.maxColumns),
    maxCellBytes: positiveLimit(
      input?.maxCellBytes,
      DEFAULT_LIMITS.maxCellBytes,
      HARD_LIMITS.maxCellBytes,
    ),
  });
}

function decodeUtf8Csv(bytes: Uint8Array, limits: ResolvedLimits): string {
  if (bytes.byteLength > limits.maxBytes) throw new CsvImportPreviewError('source_too_large');
  const utf16Or32Bom = (bytes[0] === 0xff && bytes[1] === 0xfe)
    || (bytes[0] === 0xfe && bytes[1] === 0xff)
    || (bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0xfe && bytes[3] === 0xff);
  if (utf16Or32Bom) throw new CsvImportPreviewError('source_encoding_unsafe');
  const hasUtf8Bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const body = hasUtf8Bom ? bytes.subarray(3) : bytes;
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    throw new CsvImportPreviewError('source_encoding_unsafe');
  }
  if (decoded.includes('\0')) throw new CsvImportPreviewError('source_contains_nul');
  if (decoded.includes('\ufeff')) throw new CsvImportPreviewError('source_encoding_unsafe');
  return decoded;
}

function parseRows(text: string, limits: ResolvedLimits): readonly (readonly string[])[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let state: 'unquoted' | 'quoted' | 'after_quote' = 'unquoted';
  let recordOpen = false;

  const finishCell = (): void => {
    if (Buffer.byteLength(cell, 'utf8') > limits.maxCellBytes) {
      throw new CsvImportPreviewError('csv_cell_too_large');
    }
    row.push(cell);
    if (row.length > limits.maxColumns) throw new CsvImportPreviewError('csv_too_many_columns');
    cell = '';
  };
  const finishRow = (): void => {
    finishCell();
    rows.push(row);
    if (rows.length > limits.maxRows + 1) throw new CsvImportPreviewError('csv_too_many_rows');
    row = [];
    recordOpen = false;
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (state === 'quoted') {
      if (character === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          state = 'after_quote';
        }
      } else if (character === '\r') {
        if (text[index + 1] === '\n') index += 1;
        cell += '\n';
      } else {
        cell += character;
      }
      recordOpen = true;
      continue;
    }

    if (state === 'after_quote') {
      if (character === ',') {
        finishCell();
        state = 'unquoted';
        recordOpen = true;
        continue;
      }
      if (character === '\r' || character === '\n') {
        if (character === '\r' && text[index + 1] === '\n') index += 1;
        finishRow();
        state = 'unquoted';
        continue;
      }
      throw new CsvImportPreviewError('csv_syntax_invalid');
    }

    if (character === '"') {
      if (cell.length !== 0) throw new CsvImportPreviewError('csv_syntax_invalid');
      state = 'quoted';
      recordOpen = true;
    } else if (character === ',') {
      finishCell();
      recordOpen = true;
    } else if (character === '\r' || character === '\n') {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      finishRow();
    } else {
      cell += character;
      recordOpen = true;
    }
  }

  if (state === 'quoted') throw new CsvImportPreviewError('csv_syntax_invalid');
  if (recordOpen || row.length > 0 || cell.length > 0) finishRow();
  return Object.freeze(rows.map((entry) => Object.freeze([...entry])));
}

function formulaInjection(value: string): boolean {
  const withoutLeadingWhitespace = value.replace(/^\s+/u, '');
  return /^[=+\-@]/u.test(withoutLeadingWhitespace);
}

function unsafeHeader(raw: string, canonical: string): boolean {
  const folded = raw.normalize('NFKC').trim().toLocaleLowerCase('en-GB');
  const compact = folded.replace(/[^a-z0-9]/gu, '');
  return folded === '__proto__'
    || canonical === '__proto__'
    || compact === 'prototype'
    || compact === 'constructor'
    || compact === 'constructorprototype';
}

/** Stable, locale-independent header key used by both mapping and preview output. */
export function canonicalCsvHeader(raw: string): string {
  return raw.normalize('NFKC')
    .trim()
    .toLocaleLowerCase('en-GB')
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/gu, '');
}

function parseCsv(bytes: Uint8Array, limits: ResolvedLimits): ParsedCsv {
  const rows = parseRows(decodeUtf8Csv(bytes, limits), limits);
  const rawHeaders = rows[0];
  if (!rawHeaders) throw new CsvImportPreviewError('csv_empty');
  const headers = rawHeaders.map((header) => {
    if (formulaInjection(header)) throw new CsvImportPreviewError('csv_header_unsafe');
    const canonical = canonicalCsvHeader(header);
    if (!canonical) throw new CsvImportPreviewError('csv_header_empty');
    if (unsafeHeader(header, canonical)) throw new CsvImportPreviewError('csv_header_unsafe');
    return canonical;
  });
  if (new Set(headers).size !== headers.length) {
    throw new CsvImportPreviewError('csv_header_duplicate');
  }
  const dataRows = rows.slice(1);
  if (dataRows.some((row) => row.length !== headers.length)) {
    throw new CsvImportPreviewError('csv_row_ragged');
  }
  return Object.freeze({
    headers: Object.freeze(headers),
    rows: Object.freeze(dataRows),
  });
}

function isTargetField(value: unknown): value is CsvImportTargetField {
  return typeof value === 'string' && TARGET_FIELDS.has(value as CsvImportTargetField);
}

function canonicalMappingHeader(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 512) {
    throw new CsvImportPreviewError('mapping_invalid');
  }
  const canonical = canonicalCsvHeader(raw);
  if (!canonical || unsafeHeader(raw, canonical)) throw new CsvImportPreviewError('mapping_invalid');
  return canonical;
}

function resolveMapping(headers: readonly string[], mapping: CsvImportMapping): ResolvedMapping {
  if (!mapping || typeof mapping !== 'object' || !Array.isArray(mapping.columns)
      || mapping.columns.length === 0 || mapping.columns.length > TARGET_FIELDS.size) {
    throw new CsvImportPreviewError('mapping_invalid');
  }
  const headerIndexes = new Map(headers.map((header, index) => [header, index]));
  const targets = new Set<CsvImportTargetField>();
  const pairs = new Set<string>();
  const columns: ResolvedColumnMapping[] = mapping.columns.map((entry: CsvImportColumnMapping) => {
    if (!entry || typeof entry !== 'object' || !isTargetField(entry.targetField)) {
      throw new CsvImportPreviewError('mapping_invalid');
    }
    const sourceHeader = canonicalMappingHeader(entry.sourceHeader);
    const sourceIndex = headerIndexes.get(sourceHeader);
    const pair = `${sourceHeader}\0${entry.targetField}`;
    if (sourceIndex === undefined || targets.has(entry.targetField) || pairs.has(pair)) {
      throw new CsvImportPreviewError('mapping_invalid');
    }
    targets.add(entry.targetField);
    pairs.add(pair);
    return Object.freeze({ sourceHeader, sourceIndex, targetField: entry.targetField });
  });
  const affiliateSeen = new Set<string>();
  const affiliateColumns = (mapping.affiliateSourceHeaders ?? []).map((raw) => {
    const sourceHeader = canonicalMappingHeader(raw);
    const sourceIndex = headerIndexes.get(sourceHeader);
    if (sourceIndex === undefined || affiliateSeen.has(sourceHeader)) {
      throw new CsvImportPreviewError('mapping_invalid');
    }
    affiliateSeen.add(sourceHeader);
    return Object.freeze({ sourceHeader, sourceIndex });
  });
  const requiredSeen = new Set<CsvImportTargetField>();
  const requiredTargetFields = (mapping.requiredTargetFields ?? []).map((field) => {
    if (!isTargetField(field) || !targets.has(field) || requiredSeen.has(field)) {
      throw new CsvImportPreviewError('mapping_invalid');
    }
    requiredSeen.add(field);
    return field;
  });
  const digestShape = Object.freeze({
    affiliateSourceHeaders: [...affiliateSeen].sort(),
    columns: columns
      .map(({ sourceHeader, targetField }) => ({ sourceHeader, targetField }))
      .sort((left, right) => left.targetField.localeCompare(right.targetField)
        || left.sourceHeader.localeCompare(right.sourceHeader)),
    requiredTargetFields: [...requiredTargetFields].sort(),
  });
  return Object.freeze({
    columns: Object.freeze(columns),
    affiliateColumns: Object.freeze(affiliateColumns),
    requiredTargetFields: Object.freeze(requiredTargetFields),
    sha256: sha256(JSON.stringify(digestShape)),
  });
}

function mappedEntity(
  entity: 'contact' | 'lead',
  row: readonly string[],
  mapping: ResolvedMapping,
): CsvImportMappedEntity | null {
  const fields: Record<string, string> = {};
  for (const column of mapping.columns) {
    const [targetEntity, field] = column.targetField.split('.', 2);
    const value = row[column.sourceIndex]!;
    if (targetEntity === entity && field && value.trim().length > 0) fields[field] = value;
  }
  return Object.keys(fields).length > 0 ? Object.freeze({ fields: Object.freeze(fields) }) : null;
}

function affiliateValues(
  row: readonly string[],
  mapping: ResolvedMapping,
): readonly CsvImportAffiliateSourceValue[] {
  return Object.freeze(mapping.affiliateColumns.map((column) => Object.freeze({
    column: column.sourceHeader,
    value: row[column.sourceIndex]!,
  })));
}

function countReasons(rows: readonly CsvImportQuarantinedRow[]): Readonly<Record<CsvImportQuarantineReason, number>> {
  const counts: Record<CsvImportQuarantineReason, number> = {
    formula_injection_cell: 0,
    required_value_missing: 0,
    mapped_entity_empty: 0,
  };
  for (const row of rows) for (const reason of row.reasons) counts[reason] += 1;
  return Object.freeze(counts);
}

function receipt(
  adapterId: string,
  sourceSha256: string,
  headerSchemaSha256: string,
  mappingSha256: string,
  byteCount: number,
  rowCount: number,
  columnCount: number,
  acceptedRowCount: number,
  quarantinedRows: readonly CsvImportQuarantinedRow[],
): CsvImportPreviewReceipt {
  const unsigned = Object.freeze({
    schemaVersion: 1 as const,
    adapterId,
    sourceSha256,
    headerSchemaSha256,
    mappingSha256,
    byteCount,
    rowCount,
    acceptedRowCount,
    quarantinedRowCount: quarantinedRows.length,
    columnCount,
    quarantineReasonCounts: countReasons(quarantinedRows),
    effects: Object.freeze({ databaseWrites: 0 as const, externalMutations: 0 as const, providerCalls: 0 as const }),
  });
  return Object.freeze({
    ...unsigned,
    receiptSha256: sha256(JSON.stringify(unsigned)),
  });
}

function validatePayload(payload: LegacyImportSourcePayload): Uint8Array {
  if (!payload || typeof payload !== 'object'
      || (payload.mediaType !== 'text/csv' && payload.mediaType !== 'application/csv')
      || !(payload.bytes instanceof Uint8Array)) {
    throw new CsvImportPreviewError(
      payload && typeof payload === 'object' && 'mediaType' in payload
        ? 'source_media_type_unsafe'
        : 'source_read_failed',
    );
  }
  return payload.bytes;
}

/** Pure preview: parses and maps in memory, returning no persistence or provider command. */
export function previewLegacyCsvImport(
  payload: LegacyImportSourcePayload,
  adapterId: string,
  mappingInput: CsvImportMapping,
  limitInput?: CsvPreviewLimits,
): CsvImportPreview {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u.test(adapterId)) {
    throw new CsvImportPreviewError('adapter_invalid');
  }
  const limits = resolveLimits(limitInput);
  const suppliedBytes = validatePayload(payload);
  if (suppliedBytes.byteLength > limits.maxBytes) {
    throw new CsvImportPreviewError('source_too_large');
  }
  // Snapshot the adapter-owned buffer before hashing and parsing so a caller
  // cannot mutate the evidence tuple between those two pure operations.
  const bytes = Uint8Array.from(suppliedBytes);
  const sourceSha256 = sha256(bytes);
  const parsed = parseCsv(bytes, limits);
  const mapping = resolveMapping(parsed.headers, mappingInput);
  const headerSchemaSha256 = sha256(JSON.stringify(parsed.headers));
  const records = [] as CsvImportPreview['records'][number][];
  const quarantinedRows: CsvImportQuarantinedRow[] = [];

  parsed.rows.forEach((row, rowIndex) => {
    const sourceRowNumber = rowIndex + 2;
    const rowSha256 = sha256(JSON.stringify(row));
    const unsafeColumnIndexes = row
      .map((value, index) => formulaInjection(value) ? index + 1 : 0)
      .filter((value) => value > 0);
    const reasons = new Set<CsvImportQuarantineReason>();
    if (unsafeColumnIndexes.length > 0) reasons.add('formula_injection_cell');
    if (mapping.requiredTargetFields.some((target) => {
      const column = mapping.columns.find((entry) => entry.targetField === target)!;
      return row[column.sourceIndex]!.trim().length === 0;
    })) reasons.add('required_value_missing');
    const contact = mappedEntity('contact', row, mapping);
    const lead = mappedEntity('lead', row, mapping);
    if (!contact && !lead) reasons.add('mapped_entity_empty');
    if (reasons.size > 0) {
      quarantinedRows.push(Object.freeze({
        sourceRowNumber,
        rowSha256,
        reasons: Object.freeze(REASON_ORDER.filter((reason) => reasons.has(reason))),
        unsafeColumnIndexes: Object.freeze(unsafeColumnIndexes),
      }));
      return;
    }
    records.push(Object.freeze({
      contact,
      lead,
      affiliateSources: affiliateValues(row, mapping),
      provenance: Object.freeze({
        adapterId,
        sourceSha256,
        headerSchemaSha256,
        mappingSha256: mapping.sha256,
        sourceRowNumber,
        rowSha256,
      }),
    }));
  });

  const frozenQuarantine = Object.freeze(quarantinedRows);
  return Object.freeze({
    schemaVersion: 1,
    canonicalHeaders: parsed.headers,
    records: Object.freeze(records),
    quarantinedRows: frozenQuarantine,
    receipt: receipt(
      adapterId,
      sourceSha256,
      headerSchemaSha256,
      mapping.sha256,
      bytes.byteLength,
      parsed.rows.length,
      parsed.headers.length,
      records.length,
      frozenQuarantine,
    ),
    previewOnly: true,
    providerEffects: false,
  });
}

/** Adapter wrapper for future upload/API sources. It accepts read-only surfaces only. */
export async function previewLegacyCsvImportFromAdapter(
  adapter: LegacyImportSourceAdapter,
  mapping: CsvImportMapping,
  limits?: CsvPreviewLimits,
): Promise<CsvImportPreview> {
  if (!adapter || typeof adapter !== 'object' || typeof adapter.read !== 'function'
      || typeof adapter.adapterId !== 'string') {
    throw new CsvImportPreviewError('adapter_invalid');
  }
  if (FORBIDDEN_ADAPTER_METHODS.some((method) => method in adapter)) {
    throw new CsvImportPreviewError('adapter_surface_unsafe');
  }
  let payload: LegacyImportSourcePayload;
  try {
    payload = await adapter.read();
  } catch {
    throw new CsvImportPreviewError('source_read_failed');
  }
  return previewLegacyCsvImport(payload, adapter.adapterId, mapping, limits);
}

export type {
  CsvImportMapping,
  CsvImportPreview,
  CsvImportPreviewReceipt,
  CsvImportQuarantineReason,
  CsvImportTargetField,
  CsvPreviewLimits,
  LegacyImportSourceAdapter,
  LegacyImportSourcePayload,
} from './csv-preview-types.js';
export { CsvImportPreviewError } from './csv-preview-types.js';
