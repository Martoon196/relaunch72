import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { DatabaseRequestContext } from '../src/db/rls.js';
import {
  LegacyImportValidationError,
  LegacyLeadImportService,
  bytesToHex,
  normalizeLegacyLeadBatch,
  type LegacyImportTransactionRunner,
} from '../src/legacy-import/index.js';
import type { SqlExecutor, SqlResult } from '../src/crm-pg/types.js';

const context: DatabaseRequestContext = {
  actorKind: 'user',
  workspaceId: '10000000-0000-4000-8000-000000000001',
  userId: '20000000-0000-4000-8000-000000000001',
  requestId: 'legacy-import-test',
};

const lead = {
  sourceRecordId: 'lead_001',
  displayName: '  Ada Lovelace  ',
  companyName: '  Analytical Estates  ',
  originalCreatedAt: '2024-01-02T03:04:05+00:00',
  identities: [
    { kind: 'email' as const, value: ' ADA@Example.Test ', verified: true, primary: true },
    { kind: 'phone' as const, value: '0044 7700 900123', verified: false },
  ],
  attribution: {
    affiliateSourceId: 'affiliate_17',
    affiliateCode: 'AFF-17',
    referralCode: 'PREDATOR17',
    raw: { click_id: 'clk_72', affiliate_code: 'AFF-17' },
  },
};

function result<TRow>(rows: TRow[] = [], rowCount = rows.length): SqlResult<TRow> {
  return { rows, rowCount };
}

class Runner implements LegacyImportTransactionRunner {
  readonly calls: Array<{ readOnly: boolean; serializable?: boolean }> = [];
  constructor(private readonly executor: SqlExecutor) {}
  async run<T>(
    _context: DatabaseRequestContext,
    operation: (transaction: SqlExecutor) => Promise<T>,
    options: Readonly<{ readOnly: boolean; serializable?: boolean }>,
  ): Promise<T> {
    this.calls.push(options);
    return operation(this.executor);
  }
}

test('canonical legacy JSON retains source IDs, affiliate codes and dangling facts deterministically', () => {
  const left = normalizeLegacyLeadBatch({
    schemaVersion: 1,
    sourceSystem: ' PROPERTY_PREDATOR ',
    batchKey: 'export-2026-08-25',
    rows: [lead],
    unresolvedAttributions: [{
      recordKind: 'commission',
      sourceRecordId: 'commission_001',
      referredSourceRecordId: 'missing_user_17',
      originalCreatedAt: '2024-01-03T00:00:00Z',
      reason: 'missing_contact',
      affiliateSourceId: 'affiliate_17',
      affiliateCode: 'AFF-17',
      referralCode: 'PREDATOR17',
      raw: { referral_id: 'ref_17', amount_minor: 7200 },
    }],
  }, new Date('2026-08-25T12:00:00Z'));
  const right = normalizeLegacyLeadBatch({
    schemaVersion: 1,
    sourceSystem: 'property_predator',
    batchKey: 'export-2026-08-25',
    rows: [{
      ...lead,
      attribution: {
        ...lead.attribution,
        raw: { affiliate_code: 'AFF-17', click_id: 'clk_72' },
      },
    }],
    unresolvedAttributions: [{
      recordKind: 'commission',
      sourceRecordId: 'commission_001',
      referredSourceRecordId: 'missing_user_17',
      originalCreatedAt: '2024-01-03T00:00:00.000Z',
      reason: 'missing_contact',
      affiliateSourceId: 'affiliate_17',
      affiliateCode: 'AFF-17',
      referralCode: 'PREDATOR17',
      raw: { amount_minor: 7200, referral_id: 'ref_17' },
    }],
  }, new Date('2026-08-25T12:00:00Z'));

  assert.equal(left.sourceSystem, 'property_predator');
  assert.equal(left.rows[0]?.identities[0]?.normalizedValue, 'ada@example.test');
  assert.equal(left.rows[0]?.identities[1]?.normalizedValue, '+447700900123');
  assert.equal(left.rows[0]?.attribution?.affiliateCode, 'AFF-17');
  assert.deepEqual(
    left.unresolvedAttributions[0],
    right.unresolvedAttributions[0],
  );
  assert.equal(bytesToHex(left.inputHash), bytesToHex(right.inputHash));
});

test('canonical validation rejects ambiguous input before any database call', async () => {
  const runner = new Runner({ query: async () => result([]) });
  const service = new LegacyLeadImportService({ transactionRunner: runner });
  await assert.rejects(
    service.dryRun(context, {
      schemaVersion: 1,
      sourceSystem: 'property_predator',
      batchKey: 'invalid',
      rows: [{
        ...lead,
        sourceRecordId: 'bad',
        originalCreatedAt: '2099-01-01T00:00:00Z',
        identities: [{ kind: 'phone', value: '07700 900123', verified: true }],
      }],
    }),
    (error) => error instanceof LegacyImportValidationError
      && error.issues.some((issue) => issue.path.endsWith('originalCreatedAt'))
      && error.issues.some((issue) => issue.path.endsWith('.value')),
  );
  assert.deepEqual(runner.calls, []);
});

test('dry run is read-only, performs no writes and quarantines dangling affiliate evidence', async () => {
  const sql: string[] = [];
  const runner = new Runner({
    async query<TRow extends Record<string, unknown>>(statement: string): Promise<SqlResult<TRow>> {
      sql.push(statement);
      return result<TRow>([]);
    },
  });
  const service = new LegacyLeadImportService({
    transactionRunner: runner,
    now: () => new Date('2026-08-25T12:00:00Z'),
  });
  const report = await service.dryRun(context, {
    schemaVersion: 1,
    sourceSystem: 'property_predator',
    batchKey: 'dry-run-001',
    rows: [lead],
    unresolvedAttributions: [{
      recordKind: 'referral', sourceRecordId: 'ref_missing',
      referredSourceRecordId: 'user_missing',
      originalCreatedAt: '2024-01-02T05:00:00Z',
      reason: 'broken_reference', affiliateCode: 'AFF-17',
      raw: { referred_user_id: 'user_missing', affiliate_code: 'AFF-17' },
    }],
  });

  assert.deepEqual(runner.calls, [{ readOnly: true }]);
  assert.equal(report.writes, 0);
  assert.deepEqual(report.counts, { create: 1, match: 0, replay: 0, quarantine: 1 });
  assert.deepEqual(report.rows[1]?.reasons, ['unresolved_attribution:broken_reference']);
  assert.ok(sql.every((statement) => /\/\* legacy-import\.(?:find-receipt|find-identity-candidates|find-unresolved-attribution-receipt) \*\//.test(statement)));
  assert.ok(sql.every((statement) => !/\b(?:INSERT|UPDATE|DELETE)\b/i.test(statement)));
});

test('dry run treats an unchanged unresolved source fact as a cross-batch replay', async () => {
  const input = {
    schemaVersion: 1 as const,
    sourceSystem: 'property_predator',
    batchKey: 'overlap-002',
    rows: [],
    unresolvedAttributions: [{
      recordKind: 'commission' as const,
      sourceRecordId: 'commission-overlap',
      referredSourceRecordId: 'missing-user',
      originalCreatedAt: '2024-01-03T00:00:00Z',
      reason: 'missing_contact' as const,
      raw: { amount_minor: 7200 },
    }],
  };
  const normalized = normalizeLegacyLeadBatch(input, new Date('2026-08-25T12:00:00Z'));
  const runner = new Runner({
    async query<TRow extends Record<string, unknown>>(statement: string): Promise<SqlResult<TRow>> {
      if (statement.includes('find-unresolved-attribution-receipt')) {
        return result([{
          id: '31000000-0000-4000-8000-000000000001',
          payloadHash: normalized.unresolvedAttributions[0]!.payloadHash,
        }] as unknown as TRow[]);
      }
      return result<TRow>([]);
    },
  });
  const report = await new LegacyLeadImportService({
    transactionRunner: runner,
    now: () => new Date('2026-08-25T12:00:00Z'),
  }).dryRun(context, input);

  assert.deepEqual(report.counts, { create: 0, match: 0, replay: 1, quarantine: 0 });
  assert.deepEqual(report.rows[0]?.reasons, ['unresolved_attribution_already_recorded']);
});

test('dry run refuses split identities and a changed source-record replay', async () => {
  const canonical = normalizeLegacyLeadBatch({
    schemaVersion: 1, sourceSystem: 'property_predator', batchKey: 'x', rows: [lead],
  }, new Date('2026-08-25T12:00:00Z')).rows[0]!;
  let receiptMode = false;
  const runner = new Runner({
    async query<TRow extends Record<string, unknown>>(statement: string): Promise<SqlResult<TRow>> {
      if (statement.includes('find-receipt')) {
        if (!receiptMode) return result<TRow>([]);
        return result([{
          id: '30000000-0000-4000-8000-000000000001',
          contactId: '40000000-0000-4000-8000-000000000001',
          payloadHash: createHash('sha256').update('different').digest(),
          outcome: 'created',
        }] as unknown as TRow[]);
      }
      return result([{
        kind: 'email', normalizedValue: canonical.identities[0]!.normalizedValue,
        contactId: '40000000-0000-4000-8000-000000000001',
        dedupeState: 'normal', contactState: 'active',
      }, {
        kind: 'phone', normalizedValue: canonical.identities[1]!.normalizedValue,
        contactId: '40000000-0000-4000-8000-000000000002',
        dedupeState: 'normal', contactState: 'active',
      }] as unknown as TRow[]);
    },
  });
  const service = new LegacyLeadImportService({
    transactionRunner: runner,
    now: () => new Date('2026-08-25T12:00:00Z'),
  });
  const splitInput = {
    schemaVersion: 1 as const, sourceSystem: 'property_predator', batchKey: 'split',
    rows: [{ ...lead, identities: lead.identities.map((identity) => ({ ...identity, verified: true })) }],
  };
  const split = await service.dryRun(context, splitInput);
  assert.deepEqual(split.rows[0]?.reasons, ['split_identity']);

  receiptMode = true;
  const changed = await service.dryRun(context, { ...splitInput, batchKey: 'changed' });
  assert.equal(changed.rows[0]?.resolution, 'quarantine');
  assert.deepEqual(changed.rows[0]?.reasons, ['source_record_payload_changed']);
});

test('dry run catches an earlier planned contact split with an existing contact', async () => {
  const runner = new Runner({
    async query<TRow extends Record<string, unknown>>(
      statement: string,
      values?: readonly unknown[],
    ): Promise<SqlResult<TRow>> {
      if (statement.includes('find-receipt')) return result<TRow>([]);
      const requested = JSON.parse(String(values?.[0] ?? '[]')) as Array<{ normalized_value: string }>;
      if (requested.some((identity) => identity.normalized_value === 'existing@example.test')) {
        return result([{
          kind: 'email', normalizedValue: 'existing@example.test',
          contactId: '40000000-0000-4000-8000-000000000099',
          dedupeState: 'normal', contactState: 'active',
        }] as unknown as TRow[]);
      }
      return result<TRow>([]);
    },
  });
  const service = new LegacyLeadImportService({
    transactionRunner: runner,
    now: () => new Date('2026-08-25T12:00:00Z'),
  });
  const report = await service.dryRun(context, {
    schemaVersion: 1,
    sourceSystem: 'property_predator',
    batchKey: 'planned-existing-split',
    rows: [{
      ...lead,
      sourceRecordId: 'planned-contact',
      identities: [{ kind: 'email', value: 'new@example.test', verified: true }],
    }, {
      ...lead,
      sourceRecordId: 'split-contact',
      identities: [
        { kind: 'email', value: 'new@example.test', verified: true },
        { kind: 'email', value: 'existing@example.test', verified: true },
      ],
    }],
  });

  assert.equal(report.rows[0]?.resolution, 'create');
  assert.equal(report.rows[1]?.resolution, 'quarantine');
  assert.deepEqual(report.rows[1]?.reasons, ['split_identity_within_batch_and_existing']);
});

test('stage writes canonical snake-case recordsets and counts dangling facts', async () => {
  const calls: Array<{ statement: string; values?: readonly unknown[] }> = [];
  const runner = new Runner({
    async query<TRow extends Record<string, unknown>>(
      statement: string,
      values?: readonly unknown[],
    ): Promise<SqlResult<TRow>> {
      calls.push({ statement, values });
      if (statement.includes('find-batch')) return result<TRow>([]);
      return result<TRow>([], 1);
    },
  });
  let sequence = 1;
  const service = new LegacyLeadImportService({
    transactionRunner: runner,
    now: () => new Date('2026-08-25T12:00:00Z'),
    nextId: () => `90000000-0000-4000-8000-${String(sequence++).padStart(12, '0')}`,
  });
  const staged = await service.stage(context, {
    schemaVersion: 1, sourceSystem: 'property_predator', batchKey: 'stage-001', rows: [lead],
    unresolvedAttributions: [{
      recordKind: 'affiliate', sourceRecordId: 'affiliate_missing_owner',
      referredSourceRecordId: 'missing_owner',
      originalCreatedAt: '2024-01-02T05:00:00Z',
      reason: 'missing_affiliate_owner', affiliateSourceId: 'affiliate_17',
      affiliateCode: 'AFF-17', raw: { affiliate_code: 'AFF-17' },
    }],
  });
  assert.equal(staged.rowCount, 2);
  assert.deepEqual(runner.calls, [{ readOnly: false, serializable: true }]);
  const leadRecordset = calls.find((call) => call.statement.includes('insert-rows'));
  const unresolvedRecordset = calls.find((call) => call.statement.includes('insert-unresolved-attributions'));
  assert.ok(leadRecordset && unresolvedRecordset);
  assert.deepEqual(Object.keys(JSON.parse(String(leadRecordset.values?.[2]))[0]).sort(), [
    'id', 'ordinal', 'original_created_at', 'payload_hash_hex',
    'source_payload', 'source_record_id',
  ]);
  assert.equal(JSON.parse(String(unresolvedRecordset.values?.[2]))[0].affiliate_code, 'AFF-17');
  assert.equal(JSON.parse(String(unresolvedRecordset.values?.[2]))[0].referred_source_record_id, 'missing_owner');
});

test('commit matching appends provenance but never updates or inserts a live contact', async () => {
  const now = new Date('2026-08-25T12:00:00Z');
  const normalized = normalizeLegacyLeadBatch({
    schemaVersion: 1, sourceSystem: 'property_predator', batchKey: 'commit-match', rows: [lead],
  }, now);
  const batchId = '50000000-0000-4000-8000-000000000001';
  const contactId = '60000000-0000-4000-8000-000000000001';
  const statements: string[] = [];
  const runner = new Runner({
    async query<TRow extends Record<string, unknown>>(statement: string): Promise<SqlResult<TRow>> {
      statements.push(statement);
      if (statement.includes('lock-batch')) return result([{
        id: batchId, sourceSystem: 'property_predator', inputHash: normalized.inputHash,
        status: 'staged', rowCount: 1, imported: 0, matched: 0, replayed: 0, quarantined: 0,
      }] as unknown as TRow[]);
      if (statement.includes('load-staged-rows')) return result([{
        id: '70000000-0000-4000-8000-000000000001', ordinal: 1,
        sourceRecordId: 'lead_001', sourcePayload: JSON.parse(normalized.rows[0]!.payloadJson),
        sourcePayloadHash: normalized.rows[0]!.payloadHash,
        originalCreatedAt: normalized.rows[0]!.originalCreatedAt,
      }] as unknown as TRow[]);
      if (statement.includes('count-unresolved')) return result([{ count: 0 }] as unknown as TRow[]);
      if (statement.includes('find-receipt')) return result<TRow>([]);
      if (statement.includes('find-identity-candidates')) return result([{
        kind: 'email', normalizedValue: 'ada@example.test', contactId,
        dedupeState: 'normal', contactState: 'active',
      }] as unknown as TRow[]);
      if (statement.includes('ensure-board-opportunity')) return result([{
        disposition: 'created',
        opportunityId: '61000000-0000-4000-8000-000000000001',
        pipelineId: '62000000-0000-4000-8000-000000000001',
        stageId: '63000000-0000-4000-8000-000000000001',
        failureReason: null,
      }] as unknown as TRow[]);
      return result<TRow>([], 1);
    },
  });
  let sequence = 1;
  const service = new LegacyLeadImportService({
    transactionRunner: runner,
    now: () => now,
    nextId: () => `80000000-0000-4000-8000-${String(sequence++).padStart(12, '0')}`,
  });
  const committed = await service.commit(context, batchId);

  assert.deepEqual(committed, {
    disposition: 'committed', batchId, imported: 0, matched: 1,
    replayed: 0, quarantined: 0,
  });
  assert.ok(statements.some((statement) => statement.includes('insert-receipt')));
  assert.ok(statements.some((statement) => statement.includes('insert-provenance')));
  assert.ok(statements.some((statement) => statement.includes('insert-attribution')));
  assert.ok(statements.some((statement) => statement.includes('ensure-board-opportunity')));
  assert.ok(
    statements.findIndex((statement) => statement.includes('insert-provenance'))
      < statements.findIndex((statement) => statement.includes('ensure-board-opportunity')),
    'the board adapter must see committed immutable provenance before it can materialize',
  );
  assert.ok(statements.every((statement) => !statement.includes('insert-contact */')));
  assert.ok(statements.every((statement) => !statement.includes('insert-contact-points')));
  assert.ok(statements.every((statement) => !/UPDATE app\.contacts|UPDATE app\.contact_points/.test(statement)));
});
