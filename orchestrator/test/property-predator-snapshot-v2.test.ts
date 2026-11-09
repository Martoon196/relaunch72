import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { DatabaseRequestContext } from '../src/db/rls.js';
import type { SqlExecutor, SqlResult } from '../src/crm-pg/types.js';
import {
  PROPERTY_PREDATOR_ACCOUNT_SNAPSHOT_SOURCE,
  LegacyLeadImportService,
  PropertyPredatorSnapshotContractError,
  PropertyPredatorSnapshotService,
  canonicalSnapshotJson,
  propertyPredatorSnapshotContentSha256,
  propertyPredatorSnapshotPageSha256,
  verifyPropertyPredatorAccountSnapshotV2,
  type LegacyImportTransactionRunner,
  type PropertyPredatorAccountSnapshotEnvelopeV2,
  type PropertyPredatorSnapshotRecordV2,
} from '../src/legacy-import/index.js';

const NOW = new Date('2026-08-27T10:10:00.000Z');
const GENERATED_AT = '2026-08-27T10:09:00.000Z';
const WATERMARK = '2026-08-27T10:08:30.000Z';
const SNAPSHOT_ID = '0198f20f-6ac0-7000-8000-000000000001';
const ACCOUNT_1 = '10000000-0000-4000-8000-000000000001';
const ACCOUNT_2 = '10000000-0000-4000-8000-000000000002';
const ACCOUNT_3 = '10000000-0000-4000-8000-000000000003';
const ACCOUNT_4 = '10000000-0000-4000-8000-000000000004';
const ACCOUNT_5 = '10000000-0000-4000-8000-000000000005';
const AFFILIATE_1 = '30000000-0000-4000-8000-000000000001';
const AFFILIATE_4 = '30000000-0000-4000-8000-000000000004';
const AFFILIATE_MISSING = '30000000-0000-4000-8000-000000000099';
const REFERRAL_1 = '40000000-0000-4000-8000-000000000001';
const REFERRAL_5 = '40000000-0000-4000-8000-000000000005';
const GOLDEN_PAGE_CANONICAL = '{"cursor":null,"nextCursor":null,"pageNumber":1,"previousPageSha256":null,"records":[{"account":{"companyName":"Predátor Partners","createdAt":"2026-01-01T09:00:00.000Z","displayName":"Álex 🏠","email":"owner@example.test","id":"10000000-0000-4000-8000-000000000001","verifiedIdentity":{"emailVerified":true,"provider":"google","verifiedAt":"2026-01-01T09:01:00.000Z"}},"originalAttribution":null,"ownAffiliate":{"code":"A","codeStatus":"unknown","createdAt":"2026-01-01T09:02:00.000Z","id":"30000000-0000-4000-8000-000000000001"}},{"account":{"createdAt":"2026-01-02T10:00:00.000Z","email":"lead@example.test","id":"10000000-0000-4000-8000-000000000002","verifiedIdentity":null},"originalAttribution":{"affiliateCode":"A","affiliateId":"30000000-0000-4000-8000-000000000001","attachedAt":"2026-01-02T09:59:00.000Z","referralId":"40000000-0000-4000-8000-000000000001"},"ownAffiliate":null}],"snapshotId":"0198f20f-6ac0-7000-8000-000000000042"}';
const GOLDEN_CONTENT_CANONICAL = '{"complete":true,"eventHighWatermark":"42","generatedAt":"2026-08-27T10:09:00.000Z","pageCount":1,"pageSha256":["9d94f96060d7b02d7c3a05a824518999f7c1f7554ed9779837cb86f280111b71"],"recordCount":2,"schemaVersion":2,"snapshotId":"0198f20f-6ac0-7000-8000-000000000042","sourceSystem":"property-predator.accounts/v2","watermark":"2026-08-27T10:08:30.000Z"}';
const context: DatabaseRequestContext = {
  actorKind: 'user',
  workspaceId: '10000000-0000-4000-8000-000000000001',
  userId: '20000000-0000-4000-8000-000000000001',
  requestId: 'snapshot-v2-test',
};

const owner: PropertyPredatorSnapshotRecordV2 = {
  account: {
    id: ACCOUNT_1,
    email: 'owner@example.test',
    createdAt: '2026-01-01T09:00:00.000Z',
    displayName: 'Alex Owner',
    companyName: 'Predator Partners',
    verifiedIdentity: {
      provider: 'google', emailVerified: true, verifiedAt: '2026-01-01T09:01:00.000Z',
    },
  },
  ownAffiliate: {
    id: AFFILIATE_1, code: 'PREDATOR72', codeStatus: 'active',
    createdAt: '2026-01-01T09:02:00.000Z',
  },
  originalAttribution: null,
};

const referred: PropertyPredatorSnapshotRecordV2 = {
  account: {
    id: ACCOUNT_2, email: 'lead@example.test',
    createdAt: '2026-01-02T10:00:00.000Z',
    verifiedIdentity: {
      provider: 'google', emailVerified: true, verifiedAt: '2026-01-02T10:01:00.000Z',
    },
  },
  ownAffiliate: null,
  originalAttribution: {
    referralId: REFERRAL_1, affiliateId: AFFILIATE_1,
    affiliateCode: 'PREDATOR72', attachedAt: '2026-01-02T09:59:00.000Z',
  },
};

const unverified: PropertyPredatorSnapshotRecordV2 = {
  account: {
    id: ACCOUNT_3, email: 'unverified@example.test',
    createdAt: '2026-01-03T10:00:00.000Z', verifiedIdentity: null,
  },
  ownAffiliate: null,
  originalAttribution: null,
};

function buildExport(
  pages: readonly (readonly PropertyPredatorSnapshotRecordV2[])[],
  overrides: Partial<PropertyPredatorAccountSnapshotEnvelopeV2> = {},
): PropertyPredatorAccountSnapshotEnvelopeV2[] {
  const sealedPages: PropertyPredatorAccountSnapshotEnvelopeV2['pages'][0][] = [];
  let priorHash: string | null = null;
  for (const [index, records] of pages.entries()) {
    const pageNumber = index + 1;
    const cursor = pageNumber === 1 ? null : `cursor-${pageNumber}`;
    const nextCursor = pageNumber === pages.length ? null : `cursor-${pageNumber + 1}`;
    const pageSha256 = propertyPredatorSnapshotPageSha256({
      snapshotId: SNAPSHOT_ID, pageNumber, cursor, nextCursor,
      previousPageSha256: priorHash, records,
    });
    sealedPages.push({
      pageNumber, cursor, nextCursor, previousPageSha256: priorHash,
      records, pageSha256,
    });
    priorHash = pageSha256;
  }
  const recordCount = pages.reduce((sum, page) => sum + page.length, 0);
  const eventHighWatermark = '9007199254740993';
  const contentSha256 = propertyPredatorSnapshotContentSha256({
    schemaVersion: 2,
    sourceSystem: PROPERTY_PREDATOR_ACCOUNT_SNAPSHOT_SOURCE,
    snapshotId: SNAPSHOT_ID,
    generatedAt: GENERATED_AT,
    watermark: WATERMARK,
    complete: true,
    pageCount: pages.length,
    recordCount,
    eventHighWatermark,
    pageSha256: sealedPages.map((page) => page.pageSha256),
  });
  return sealedPages.map((page) => ({
    schemaVersion: 2,
    sourceSystem: PROPERTY_PREDATOR_ACCOUNT_SNAPSHOT_SOURCE,
    snapshotId: SNAPSHOT_ID,
    generatedAt: GENERATED_AT,
    watermark: WATERMARK,
    complete: true,
    manifest: { pageCount: pages.length, recordCount, eventHighWatermark, contentSha256 },
    pages: [page],
    ...overrides,
  }));
}

function sqlResult<TRow extends Record<string, unknown>>(rows: TRow[] = []): SqlResult<TRow> {
  return { rows, rowCount: rows.length };
}

class Runner implements LegacyImportTransactionRunner {
  readonly calls: Array<{ readOnly: boolean; serializable?: boolean }> = [];
  constructor(private readonly executor: SqlExecutor = { query: async () => sqlResult([]) }) {}
  async run<T>(
    _context: DatabaseRequestContext,
    operation: (transaction: SqlExecutor) => Promise<T>,
    options: Readonly<{ readOnly: boolean; serializable?: boolean }>,
  ): Promise<T> {
    this.calls.push(options);
    return operation(this.executor);
  }
}

test('v2 verifies the complete page chain and adapts only explicit Google evidence', () => {
  const input = buildExport([[owner, referred], [unverified]]);
  const verified = verifyPropertyPredatorAccountSnapshotV2(input, NOW);

  assert.equal(verified.snapshotId, SNAPSHOT_ID);
  assert.equal(verified.manifest.eventHighWatermark, '9007199254740993');
  assert.equal(verified.records.length, 3);
  assert.equal(verified.consentDefault, 'unknown');
  assert.equal(verified.recordIssues.length, 0);
  assert.equal(verified.legacyBatch.sourceSystem, PROPERTY_PREDATOR_ACCOUNT_SNAPSHOT_SOURCE);
  assert.deepEqual(verified.legacyBatch.rows.map((row) => ({
    id: row.sourceRecordId,
    verified: row.identities[0]?.verified,
    label: row.identities[0]?.label,
  })), [{
    id: ACCOUNT_1, verified: true, label: 'Property Predator Google-verified email',
  }, {
    id: ACCOUNT_2, verified: true, label: 'Property Predator Google-verified email',
  }, {
    id: ACCOUNT_3, verified: false, label: 'Property Predator account email',
  }]);
  assert.deepEqual(verified.legacyBatch.rows[1]?.attribution?.raw, {
    referral: referred.originalAttribution,
    affiliate: owner.ownAffiliate,
  });
  assert.match(verified.envelopeSha256, /^[0-9a-f]{64}$/);
  assert.equal(canonicalSnapshotJson({ b: 2, a: 1 }), '{"a":1,"b":2}');
});

test('the shared Python/TypeScript golden vector has byte-identical page and content hashes', async () => {
  const raw = await readFile(new URL(
    './fixtures/property-predator-account-snapshot-v2.golden.json',
    import.meta.url,
  ), 'utf8');
  const envelope = JSON.parse(raw) as PropertyPredatorAccountSnapshotEnvelopeV2;
  const page = envelope.pages[0];
  const pagePayload = {
    snapshotId: envelope.snapshotId,
    pageNumber: page.pageNumber,
    cursor: page.cursor,
    nextCursor: page.nextCursor,
    previousPageSha256: page.previousPageSha256,
    records: page.records,
  };
  assert.equal(canonicalSnapshotJson(pagePayload), GOLDEN_PAGE_CANONICAL);
  assert.equal(
    propertyPredatorSnapshotPageSha256(pagePayload),
    '9d94f96060d7b02d7c3a05a824518999f7c1f7554ed9779837cb86f280111b71',
  );
  const contentPayload = {
    schemaVersion: 2,
    sourceSystem: PROPERTY_PREDATOR_ACCOUNT_SNAPSHOT_SOURCE,
    snapshotId: envelope.snapshotId,
    generatedAt: envelope.generatedAt,
    watermark: envelope.watermark,
    complete: true,
    pageCount: envelope.manifest.pageCount,
    recordCount: envelope.manifest.recordCount,
    eventHighWatermark: envelope.manifest.eventHighWatermark,
    pageSha256: [page.pageSha256],
  } as const;
  assert.equal(canonicalSnapshotJson(contentPayload), GOLDEN_CONTENT_CANONICAL);
  assert.equal(
    propertyPredatorSnapshotContentSha256(contentPayload),
    '31a9d2f78da74c0428690214d643b7193030686a5aaa945b8f2ba71c22cab211',
  );
  assert.equal(
    verifyPropertyPredatorAccountSnapshotV2(envelope, NOW).records.length,
    2,
  );
});

test('v2 rejects incomplete, mixed, missing, stale, reordered and hash-corrupt snapshots before DB use', () => {
  const valid = buildExport([[owner], [referred]]);
  const cases: unknown[] = [
    [{ ...valid[0], complete: false }, valid[1]],
    [valid[0]],
    [valid[0], { ...valid[1], sourceSystem: 'property-predator-v1' }],
    [valid[0], { ...valid[1], schemaVersion: 1 }],
    [valid[0], { ...valid[1], watermark: '2026-08-27T10:07:00.000Z' }],
    [valid[0], { ...valid[1], affiliate_commissions: [] }],
    [valid[0], { ...valid[1], manifest: { ...valid[1]!.manifest, recordCount: 99 } }],
    [valid[0], { ...valid[1], pages: [{ ...valid[1]!.pages[0], pageSha256: '0'.repeat(64) }] }],
    [{
      ...valid[0],
      pages: [{
        ...valid[0]!.pages[0],
        records: [{ ...owner, account: { ...owner.account, id: 'not-a-uuid' } }],
      }],
    }, valid[1]],
    [{
      ...valid[0],
      pages: [{
        ...valid[0]!.pages[0],
        records: [{ ...owner, account: { ...owner.account, displayName: null } }],
      }],
    }, valid[1]],
    [{
      ...valid[0],
      pages: [{
        ...valid[0]!.pages[0],
        records: [{
          ...owner,
          ownAffiliate: { ...owner.ownAffiliate!, parentAffiliateId: null },
        }],
      }],
    }, valid[1]],
    [{
      ...valid[0],
      pages: [{
        ...valid[0]!.pages[0],
        records: [{
          ...owner,
          ownAffiliate: { ...owner.ownAffiliate!, codeStatus: `x${'a'.repeat(32)}` },
        }],
      }],
    }, valid[1]],
    buildExport([[referred, owner]]),
  ];
  for (const candidate of cases) {
    assert.throws(
      () => verifyPropertyPredatorAccountSnapshotV2(candidate as never, NOW),
      PropertyPredatorSnapshotContractError,
    );
  }
  assert.throws(
    () => verifyPropertyPredatorAccountSnapshotV2(valid, new Date('2026-08-27T10:30:00.000Z')),
    /generatedAt must be within/,
  );
  const afterWatermark = buildExport([[{
    ...owner,
    account: { ...owner.account, createdAt: '2026-08-27T10:08:31.000Z' },
  }]]);
  assert.throws(
    () => verifyPropertyPredatorAccountSnapshotV2(afterWatermark, NOW),
    /must not be later than watermark/,
  );
  assert.throws(
    () => verifyPropertyPredatorAccountSnapshotV2(
      Array<PropertyPredatorAccountSnapshotEnvelopeV2>(10_001).fill(valid[0]!),
      NOW,
    ),
    /at most 10000 pages/,
  );
  const fiveHundredOwners = Array<PropertyPredatorSnapshotRecordV2>(500).fill(owner);
  const oversizedRecordSet = Array.from({ length: 21 }, (_, index) => ({
    ...valid[0]!,
    pages: [{
      ...valid[0]!.pages[0],
      pageNumber: index + 1,
      records: fiveHundredOwners,
    }] as const,
  }));
  assert.throws(
    () => verifyPropertyPredatorAccountSnapshotV2(oversizedRecordSet, NOW),
    /at most 10000 records in total/,
  );
});

test('duplicates and broken affiliate graphs are retained as explicit source quarantine', async () => {
  const secondOwner: PropertyPredatorSnapshotRecordV2 = {
    ...owner,
    account: {
      ...owner.account,
      id: ACCOUNT_1,
      email: 'second@example.test',
      verifiedIdentity: {
        provider: 'google', emailVerified: true, verifiedAt: '2026-01-01T09:03:00.000Z',
      },
    },
  };
  const invalidParent: PropertyPredatorSnapshotRecordV2 = {
    account: {
      id: ACCOUNT_4, email: 'partner@example.test',
      createdAt: '2026-01-04T10:00:00.000Z', verifiedIdentity: null,
    },
    ownAffiliate: {
      id: AFFILIATE_4, code: 'PARTNER04', codeStatus: 'unknown',
      createdAt: '2026-01-04T10:01:00.000Z', parentAffiliateId: AFFILIATE_MISSING,
    },
    originalAttribution: null,
  };
  const taintedReferral: PropertyPredatorSnapshotRecordV2 = {
    account: {
      id: ACCOUNT_5, email: 'tainted@example.test',
      createdAt: '2026-01-05T10:00:00.000Z', verifiedIdentity: null,
    },
    ownAffiliate: null,
    originalAttribution: {
      referralId: REFERRAL_5, affiliateId: AFFILIATE_4,
      affiliateCode: 'PARTNER04', attachedAt: '2026-01-05T10:01:00.000Z',
    },
  };
  const input = buildExport([[owner, secondOwner, invalidParent, taintedReferral]]);
  const verified = verifyPropertyPredatorAccountSnapshotV2(input, NOW);

  assert.deepEqual(
    verified.recordIssues.map((issue) => [issue.accountId, issue.code]),
    [
      [ACCOUNT_1, 'duplicate_account_id'],
      [ACCOUNT_1, 'duplicate_affiliate_code'],
      [ACCOUNT_1, 'duplicate_affiliate_id'],
      [ACCOUNT_1, 'duplicate_account_id'],
      [ACCOUNT_1, 'duplicate_affiliate_code'],
      [ACCOUNT_1, 'duplicate_affiliate_id'],
      [ACCOUNT_4, 'missing_parent_affiliate'],
      [ACCOUNT_5, 'invalid_attribution_affiliate'],
    ],
  );
  assert.equal(verified.legacyBatch.rows.some((row) => row.sourceRecordId === ACCOUNT_1), false);
  assert.ok((verified.legacyBatch.unresolvedAttributions?.length ?? 0) >= 3);

  const runner = new Runner({
    async query<TRow extends Record<string, unknown>>(statement: string): Promise<SqlResult<TRow>> {
      if (statement.includes('property-predator-snapshot.find')) return sqlResult<TRow>([]);
      if (statement.includes('insert-manifest')) {
        return sqlResult([{ id: 'x' }] as unknown as TRow[]);
      }
      if (statement.includes('insert-pages')) return { rows: [], rowCount: 1 };
      if (statement.includes('insert-quarantine')) {
        return { rows: [], rowCount: verified.recordIssues.length };
      }
      return sqlResult<TRow>([]);
    },
  });
  const stage = await new PropertyPredatorSnapshotService({
    transactionRunner: runner,
    now: () => NOW,
  }).stage(context, input);
  assert.equal(stage.quarantinedSourceRecords, 4, 'each affected raw position is counted once');
});

test('operator preview is zero-write, quarantines unverified accounts and reports consent unknown', async () => {
  const runner = new Runner();
  const service = new PropertyPredatorSnapshotService({
    transactionRunner: runner,
    now: () => NOW,
  });
  const report = await service.preview(context, buildExport([[owner, referred, unverified]]));

  assert.equal(report.writes, 0);
  assert.equal(report.integrity, 'verified_complete_snapshot');
  assert.equal(report.consentDefault, 'unknown');
  assert.deepEqual(report.accountCounts, { create: 2, match: 0, replay: 0, quarantine: 1 });
  assert.deepEqual(runner.calls, [{ readOnly: true }]);
  assert.ok(report.reconciliation?.rows.every((row) => row.resolution !== 'match'));
});

test('immutable staged evidence remains previewable after the live ingestion window closes', async () => {
  const input = buildExport([[owner]]);
  const runner = new Runner({
    async query<TRow extends Record<string, unknown>>(statement: string): Promise<SqlResult<TRow>> {
      if (statement.includes('load-manifest')) {
        return sqlResult([{
          id: '90000000-0000-4000-8000-000000000001',
          stagedAt: '2026-08-27 10:10:00+00',
        }] as unknown as TRow[]);
      }
      if (statement.includes('load-pages')) {
        return sqlResult([{ sourceEnvelope: input[0] }] as unknown as TRow[]);
      }
      return sqlResult<TRow>([]);
    },
  });
  const service = new PropertyPredatorSnapshotService({
    transactionRunner: runner,
    now: () => new Date('2026-08-28T10:10:00.000Z'),
  });
  const report = await service.previewStaged(context, SNAPSHOT_ID);
  assert.equal(report.integrity, 'verified_complete_snapshot');
  assert.equal(report.recordCount, 1);
  assert.deepEqual(runner.calls, [{ readOnly: true }, { readOnly: true }]);
});

test('the generic v1 mutating stage cannot activate the reserved v2 source', async () => {
  const runner = new Runner();
  const service = new LegacyLeadImportService({
    transactionRunner: runner,
    now: () => NOW,
  });
  const verified = verifyPropertyPredatorAccountSnapshotV2(buildExport([[owner]]), NOW);
  await assert.rejects(
    service.stage(context, verified.legacyBatch),
    /authorised for zero-write preview only/,
  );
  assert.deepEqual(runner.calls, []);
});

test('snapshot stage validates before writes and appends manifest, pages and quarantine atomically', async () => {
  const statements: string[] = [];
  const runner = new Runner({
    async query<TRow extends Record<string, unknown>>(statement: string): Promise<SqlResult<TRow>> {
      statements.push(statement);
      if (statement.includes('property-predator-snapshot.find')) return sqlResult<TRow>([]);
      if (statement.includes('insert-manifest')) {
        return sqlResult([{ id: 'x' }] as unknown as TRow[]);
      }
      return { rows: [], rowCount: statement.includes('insert-pages') ? 1 : 0 };
    },
  });
  let sequence = 1;
  const service = new PropertyPredatorSnapshotService({
    transactionRunner: runner,
    now: () => NOW,
    nextId: () => `90000000-0000-4000-8000-${String(sequence++).padStart(12, '0')}`,
  });
  const staged = await service.stage(context, buildExport([[owner]]));
  assert.equal(staged.disposition, 'staged');
  assert.equal(staged.consentDefault, 'unknown');
  assert.deepEqual(runner.calls, [{ readOnly: false, serializable: true }]);
  assert.ok(statements.some((statement) => statement.includes('insert-manifest')));
  assert.ok(statements.some((statement) => statement.includes('insert-pages')));
  assert.ok(statements.every((statement) => !/^\s*(?:UPDATE|DELETE)\b/i.test(statement)));

  const before = runner.calls.length;
  await assert.rejects(
    service.stage(context, [{ ...buildExport([[owner]])[0]!, complete: false } as never]),
    PropertyPredatorSnapshotContractError,
  );
  assert.equal(runner.calls.length, before);
});
