import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CsvImportPreviewError,
  canonicalCsvHeader,
  previewLegacyCsvImport,
  previewLegacyCsvImportFromAdapter,
  type CsvImportMapping,
  type LegacyImportSourceAdapter,
} from '../src/legacy-import/csv-preview.js';

const encoder = new TextEncoder();

function source(text: string, bom = false) {
  const body = encoder.encode(text);
  return {
    mediaType: 'text/csv' as const,
    bytes: bom ? Uint8Array.from([0xef, 0xbb, 0xbf, ...body]) : body,
  };
}

const mapping: CsvImportMapping = Object.freeze({
  columns: Object.freeze([
    Object.freeze({ sourceHeader: 'First Name', targetField: 'contact.first_name' as const }),
    Object.freeze({ sourceHeader: 'Email', targetField: 'contact.email' as const }),
    Object.freeze({ sourceHeader: 'Opportunity', targetField: 'lead.title' as const }),
    Object.freeze({ sourceHeader: 'Notes', targetField: 'lead.notes' as const }),
  ]),
  affiliateSourceHeaders: Object.freeze(['Affiliate Source']),
  requiredTargetFields: Object.freeze(['contact.email' as const]),
});

function errorCode(run: () => unknown): string {
  try { run(); }
  catch (error) {
    assert.ok(error instanceof CsvImportPreviewError);
    return error.code;
  }
  assert.fail('expected preview failure');
}

test('UTF-8 BOM, quoted newlines and doubled quotes map into an effects-free preview', () => {
  const csv = [
    ' First Name ,Email,Opportunity,Notes,Affiliate Source',
    '"Jo""an",joan@example.test,North House,"First line\r\nSecond line",partner-seven',
  ].join('\r\n');
  const preview = previewLegacyCsvImport(source(csv, true), 'csv-upload', mapping);

  assert.deepEqual(preview.canonicalHeaders, [
    'first_name', 'email', 'opportunity', 'notes', 'affiliate_source',
  ]);
  assert.equal(preview.records.length, 1);
  assert.deepEqual(preview.records[0]?.contact?.fields, {
    first_name: 'Jo"an',
    email: 'joan@example.test',
  });
  assert.deepEqual(preview.records[0]?.lead?.fields, {
    title: 'North House',
    notes: 'First line\nSecond line',
  });
  assert.deepEqual(preview.records[0]?.affiliateSources, [{
    column: 'affiliate_source', value: 'partner-seven',
  }]);
  assert.equal(preview.records[0]?.provenance.sourceRowNumber, 2);
  assert.equal(preview.previewOnly, true);
  assert.equal(preview.providerEffects, false);
  assert.deepEqual(preview.receipt.effects, {
    databaseWrites: 0, externalMutations: 0, providerCalls: 0,
  });
});

test('canonical header normalisation rejects empty, duplicate and prototype-pollution names', () => {
  assert.equal(canonicalCsvHeader('  Affiliate-Source ID  '), 'affiliate_source_id');
  assert.equal(
    errorCode(() => previewLegacyCsvImport(
      source('First Name,first-name\nA,B'), 'csv-upload', {
        columns: [{ sourceHeader: 'First Name', targetField: 'contact.full_name' }],
      },
    )),
    'csv_header_duplicate',
  );
  assert.equal(
    errorCode(() => previewLegacyCsvImport(
      source('   ,Email\nA,a@example.test'), 'csv-upload', {
        columns: [{ sourceHeader: 'Email', targetField: 'contact.email' }],
      },
    )),
    'csv_header_empty',
  );
  for (const dangerous of ['__proto__', 'constructor', 'prototype']) {
    assert.equal(
      errorCode(() => previewLegacyCsvImport(
        source(`${dangerous},Email\nvalue,a@example.test`), 'csv-upload', {
          columns: [{ sourceHeader: 'Email', targetField: 'contact.email' }],
        },
      )),
      'csv_header_unsafe',
    );
  }
});

test('formula-leading cells are rejected from mapped output and quarantined without raw PII', () => {
  const csv = [
    'First Name,Email,Opportunity,Notes,Affiliate Source',
    'Avery,avery@example.test,Deal,"   =HYPERLINK(""https://evil.test"")",affiliate-secret',
    'Jordan,jordan@example.test,Safe deal,Plain text,affiliate-safe',
  ].join('\n');
  const preview = previewLegacyCsvImport(source(csv), 'csv-upload', mapping);

  assert.equal(preview.records.length, 1);
  assert.equal(preview.records[0]?.contact?.fields.email, 'jordan@example.test');
  assert.deepEqual(preview.quarantinedRows, [{
    sourceRowNumber: 2,
    rowSha256: preview.quarantinedRows[0]?.rowSha256,
    reasons: ['formula_injection_cell'],
    unsafeColumnIndexes: [4],
  }]);
  assert.equal(preview.receipt.quarantineReasonCounts.formula_injection_cell, 1);
  const piiFreeEvidence = JSON.stringify({
    receipt: preview.receipt,
    quarantinedRows: preview.quarantinedRows,
  });
  assert.doesNotMatch(piiFreeEvidence, /avery@|affiliate-secret|HYPERLINK|evil\.test/i);

  const allPrefixes = previewLegacyCsvImport(
    source('Email\n =unsafe\n\t+unsafe\n -unsafe\n @unsafe\nsafe@example.test'),
    'csv-upload',
    { columns: [{ sourceHeader: 'Email', targetField: 'contact.email' }] },
  );
  assert.equal(allPrefixes.records.length, 1);
  assert.equal(allPrefixes.quarantinedRows.length, 4);
  assert.equal(allPrefixes.receipt.quarantineReasonCounts.formula_injection_cell, 4);
});

test('byte, row, column and cell caps fail closed with fixed PII-free errors', () => {
  const cases: ReadonlyArray<readonly [string, () => unknown, string]> = [
    ['bytes', () => previewLegacyCsvImport(
      source('Email\na@example.test'), 'csv-upload',
      { columns: [{ sourceHeader: 'Email', targetField: 'contact.email' }] },
      { maxBytes: 5 },
    ), 'source_too_large'],
    ['rows', () => previewLegacyCsvImport(
      source('Email\na@example.test\nb@example.test'), 'csv-upload',
      { columns: [{ sourceHeader: 'Email', targetField: 'contact.email' }] },
      { maxRows: 1 },
    ), 'csv_too_many_rows'],
    ['columns', () => previewLegacyCsvImport(
      source('Email,Phone\na@example.test,07000000000'), 'csv-upload',
      { columns: [{ sourceHeader: 'Email', targetField: 'contact.email' }] },
      { maxColumns: 1 },
    ), 'csv_too_many_columns'],
    ['cell', () => previewLegacyCsvImport(
      source('Email\na@example.test'), 'csv-upload',
      { columns: [{ sourceHeader: 'Email', targetField: 'contact.email' }] },
      { maxCellBytes: 4 },
    ), 'csv_cell_too_large'],
  ];
  for (const [label, run, expected] of cases) {
    const code = errorCode(run);
    assert.equal(code, expected, label);
  }
});

test('unsafe encodings, NUL, malformed quoting and ragged rows never reach mapping', () => {
  assert.equal(errorCode(() => previewLegacyCsvImport({
    mediaType: 'text/csv', bytes: Uint8Array.from([0xff, 0xfe, 0x41, 0x00]),
  }, 'csv-upload', mapping)), 'source_encoding_unsafe');
  assert.equal(errorCode(() => previewLegacyCsvImport(
    source('Email\na\0@example.test'), 'csv-upload', mapping,
  )), 'source_contains_nul');
  assert.equal(errorCode(() => previewLegacyCsvImport(
    source('Email\n"unterminated'), 'csv-upload', mapping,
  )), 'csv_syntax_invalid');
  assert.equal(errorCode(() => previewLegacyCsvImport(
    source('Email,Phone\na@example.test'), 'csv-upload', {
      columns: [{ sourceHeader: 'Email', targetField: 'contact.email' }],
    },
  )), 'csv_row_ragged');
});

test('explicit contact/lead mapping preserves provenance and affiliate source without invented IDs', () => {
  const payload = source([
    'First Name,Email,Opportunity,Notes,Affiliate Source',
    'Morgan,morgan@example.test,Vendor lead,Asked for a callback,Jack-Partner-42',
  ].join('\n'));
  const first = previewLegacyCsvImport(payload, 'api-export-v1', mapping);
  const second = previewLegacyCsvImport(payload, 'api-export-v1', mapping);

  assert.deepEqual(first, second, 'the same source and mapping must produce byte-stable evidence');
  assert.equal(first.receipt.acceptedRowCount, 1);
  assert.equal(first.receipt.quarantinedRowCount, 0);
  assert.equal(first.records[0]?.provenance.adapterId, 'api-export-v1');
  assert.equal(first.records[0]?.provenance.sourceSha256, first.receipt.sourceSha256);
  assert.equal(first.records[0]?.provenance.headerSchemaSha256, first.receipt.headerSchemaSha256);
  assert.equal(first.records[0]?.provenance.mappingSha256, first.receipt.mappingSha256);
  assert.equal(first.receipt.adapterId, 'api-export-v1');
  assert.deepEqual(first.records[0]?.affiliateSources, [{
    column: 'affiliate_source', value: 'Jack-Partner-42',
  }]);
  const projected = first.records[0] as unknown as Record<string, unknown>;
  assert.equal(Object.hasOwn(projected, 'id'), false);
  assert.equal(Object.hasOwn(first.records[0]?.contact?.fields ?? {}, 'id'), false);
  assert.equal(Object.hasOwn(first.records[0]?.lead?.fields ?? {}, 'id'), false);
});

test('missing required values and empty mapped entities quarantine rows deterministically', () => {
  const required = previewLegacyCsvImport(source([
    'First Name,Email,Opportunity,Notes,Affiliate Source',
    'Morgan,,Deal,Note,partner-one',
  ].join('\n')), 'csv-upload', mapping);
  assert.deepEqual(required.quarantinedRows[0]?.reasons, ['required_value_missing']);

  const empty = previewLegacyCsvImport(source('Email,Affiliate Source\n,partner-two'), 'csv-upload', {
    columns: [{ sourceHeader: 'Email', targetField: 'contact.email' }],
    affiliateSourceHeaders: ['Affiliate Source'],
  });
  assert.deepEqual(empty.quarantinedRows[0]?.reasons, ['mapped_entity_empty']);
  assert.equal(empty.records.length, 0);
});

test('read-only source adapters are accepted and mutation-shaped adapters are rejected before use', async () => {
  let reads = 0;
  const adapter: LegacyImportSourceAdapter = Object.freeze({
    adapterId: 'future-upload-adapter',
    async read() {
      reads += 1;
      return source('Email\nowner@example.test');
    },
  });
  const preview = await previewLegacyCsvImportFromAdapter(adapter, {
    columns: [{ sourceHeader: 'Email', targetField: 'contact.email' }],
  });
  assert.equal(reads, 1);
  assert.equal(preview.receipt.effects.databaseWrites, 0);
  assert.equal(preview.receipt.effects.externalMutations, 0);
  assert.equal(preview.receipt.effects.providerCalls, 0);
  assert.equal('write' in preview, false);
  assert.equal('commit' in preview, false);

  let unsafeReads = 0;
  const unsafeAdapter = {
    adapterId: 'unsafe-adapter',
    async read() { unsafeReads += 1; return source('Email\nowner@example.test'); },
    async write() { throw new Error('must never run'); },
  } as unknown as LegacyImportSourceAdapter;
  await assert.rejects(
    previewLegacyCsvImportFromAdapter(unsafeAdapter, {
      columns: [{ sourceHeader: 'Email', targetField: 'contact.email' }],
    }),
    (error: unknown) => error instanceof CsvImportPreviewError
      && error.code === 'adapter_surface_unsafe'
      && !/owner@example\.test/u.test(error.message),
  );
  assert.equal(unsafeReads, 0);
});
