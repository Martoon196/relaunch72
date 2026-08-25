import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { DatabaseRequestContext } from '../src/db/rls.js';
import type { SqlExecutor, SqlResult } from '../src/crm-pg/types.js';
import {
  CompanyContentIdempotencyConflictError,
  CompanyContentPgRepository,
  CompanyContentService,
  CompanyContentValidationError,
  CompanyContentVersionConflictError,
  canonicalCompanyContentJson,
  companyContentRequestHash,
  normalizeCompanyContentVersionCommand,
  type CompanyContentTransactionRunner,
  type CreateCompanyContentVersionCommand,
} from '../src/company-content-pg/index.js';

const context: DatabaseRequestContext = {
  actorKind: 'user',
  workspaceId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  requestId: 'content-test-request',
};
const HASH_A = '11'.repeat(32);
const HASH_B = '22'.repeat(32);
const ATTESTATION_CHECKED_AT = new Date(Date.now() - 60_000);
const ATTESTATION_EXPIRES_AT = new Date(ATTESTATION_CHECKED_AT.getTime() + 5 * 60_000);

function command(overrides: Partial<CreateCompanyContentVersionCommand> = {}): CreateCompanyContentVersionCommand {
  return {
    commandKey: 'fixture-import-1',
    origin: 'imported',
    kind: 'document',
    title: 'Property Predator launch plan',
    contentMimeType: 'text/markdown',
    content: '# Launch plan\nExact fixture bytes.',
    source: { system: 'property_predator', itemId: 'launch-plan', version: 'fixture-v1' },
    blob: { storageKey: 'fixtures/launch-plan-v1.pdf', sha256: HASH_A },
    brand: { snapshotRef: 'brand/property-predator/v1', sha256: HASH_B },
    attestation: {
      catalogSha256: '33'.repeat(32),
      checkedAt: ATTESTATION_CHECKED_AT.toISOString(),
      expiresAt: ATTESTATION_EXPIRES_AT.toISOString(),
    },
    metadata: { fixture: true, pageCount: 12 },
    ...overrides,
  };
}

interface Receipt {
  id: string;
  name: string;
  key: string;
  payloadHash: Uint8Array;
  status: 'started' | 'succeeded';
  result: unknown;
}

interface Version {
  id: string;
  itemId: string;
  versionNumber: number;
  origin: string;
  kind: string;
  title: string;
  contentMimeType: string;
  sourceSystem: string;
  sourceItemId: string;
  sourceVersion: string;
  contentSha256: string;
  blobSha256: string;
  brandSha256: string;
  createdAt: string;
}

interface ApprovalRequest {
  id: string;
  itemId: string;
  versionId: string;
  requestNumber: number;
  contentSha256: string;
}

class InMemoryContentSql implements SqlExecutor {
  readonly receipts = new Map<string, Receipt>();
  readonly items = new Map<string, { sourceSystem: string; sourceItemId: string }>();
  readonly versions: Version[] = [];
  readonly requests: ApprovalRequest[] = [];
  readonly decisions = new Map<string, { id: string; decision: string }>();
  readonly attestations = new Map<string, {
    id: string;
    checkedAt: string;
    expiresAt: string;
  }>();

  private rows<T extends Record<string, unknown>>(rows: readonly Record<string, unknown>[]): SqlResult<T> {
    return { rows: rows as T[], rowCount: rows.length };
  }

  async query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<SqlResult<T>> {
    if (sql.includes('company-content.claim-command')) {
      const [id, name, key, , payloadHash] = values as [string, string, string, string, Uint8Array];
      const receiptKey = `${name}:${key}`;
      if (this.receipts.has(receiptKey)) return this.rows<T>([]);
      const receipt: Receipt = { id, name, key, payloadHash, status: 'started', result: null };
      this.receipts.set(receiptKey, receipt);
      return this.rows<T>([{ id, payloadHash, status: 'started', result: null }]);
    }
    if (sql.includes('company-content.read-command-receipt')) {
      const [name, key] = values as [string, string];
      const receipt = this.receipts.get(`${name}:${key}`);
      return this.rows<T>(receipt ? [{
        id: receipt.id,
        payloadHash: receipt.payloadHash,
        status: receipt.status,
        result: receipt.result,
      }] : []);
    }
    if (sql.includes('company-content.complete-command')) {
      const [id, , rawResult] = values as [string, Uint8Array, string];
      const receipt = [...this.receipts.values()].find((candidate) => candidate.id === id)!;
      receipt.status = 'succeeded';
      receipt.result = JSON.parse(rawResult) as unknown;
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('company-content.insert-item')) {
      this.items.set(String(values[0]), {
        sourceSystem: String(values[1]),
        sourceItemId: String(values[2]),
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('company-content.lock-source-identity')) {
      return this.rows<T>([{}]);
    }
    if (sql.includes('company-content.lock-item-identity')
        || sql.includes('company-content.lock-version-item')
        || sql.includes('company-content.lock-approval-identity')) {
      return this.rows<T>([{}]);
    }
    if (sql.includes('company-content.find-item-by-source')) {
      const [sourceSystem, sourceItemId] = values.map(String);
      const entry = [...this.items.entries()].find(([, source]) => (
        source.sourceSystem === sourceSystem && source.sourceItemId === sourceItemId
      ));
      if (!entry) return this.rows<T>([]);
      const [itemId, source] = entry;
      const latest = this.versions
        .filter((version) => version.itemId === itemId)
        .sort((left, right) => right.versionNumber - left.versionNumber)[0];
      return this.rows<T>([{
        contentItemId: itemId,
        sourceSystem: source.sourceSystem,
        sourceItemId: source.sourceItemId,
        latestVersionId: latest?.id ?? null,
        latestVersionNumber: latest?.versionNumber ?? null,
      }]);
    }
    if (sql.includes('company-content.lock-item')) {
      const itemId = String(values[0]);
      const source = this.items.get(itemId);
      if (!source) return this.rows<T>([]);
      const latest = this.versions
        .filter((version) => version.itemId === itemId)
        .sort((left, right) => right.versionNumber - left.versionNumber)[0];
      return this.rows<T>([{
        contentItemId: itemId,
        sourceSystem: source.sourceSystem,
        sourceItemId: source.sourceItemId,
        latestVersionId: latest?.id ?? null,
        latestVersionNumber: latest?.versionNumber ?? null,
      }]);
    }
    if (sql.includes('company-content.insert-version')) {
      const version: Version = {
        id: String(values[0]),
        itemId: String(values[1]),
        versionNumber: Number(values[2]),
        origin: String(values[4]),
        kind: String(values[5]),
        title: String(values[6]),
        contentMimeType: String(values[10]),
        sourceSystem: String(values[7]),
        sourceItemId: String(values[8]),
        sourceVersion: String(values[9]),
        contentSha256: createHash('sha256').update(String(values[11]), 'utf8').digest('hex'),
        blobSha256: String(values[13]),
        brandSha256: String(values[15]),
        createdAt: String(values[19]),
      };
      this.versions.push(version);
      return this.rows<T>([{
        contentItemId: version.itemId,
        contentVersionId: version.id,
        versionNumber: version.versionNumber,
        contentSha256: version.contentSha256,
        isLatest: true,
      }]);
    }
    if (sql.includes('company-content.insert-source-attestation')) {
      const id = String(values[0]);
      const versionId = String(values[2]);
      const checkedAt = String(values[10]);
      const expiresAt = String(values[11]);
      this.attestations.set(versionId, { id, checkedAt, expiresAt });
      return this.rows<T>([{ id, expiresAt }]);
    }
    if (sql.includes('company-content.lock-version')) {
      const [itemId, versionId] = values.map(String);
      const version = this.versions.find((candidate) => candidate.itemId === itemId && candidate.id === versionId);
      if (!version) return this.rows<T>([]);
      const latestNumber = Math.max(...this.versions
        .filter((candidate) => candidate.itemId === itemId)
        .map((candidate) => candidate.versionNumber));
      return this.rows<T>([{
        contentItemId: itemId,
        contentVersionId: version.id,
        versionNumber: version.versionNumber,
        contentSha256: version.contentSha256,
        isLatest: version.versionNumber === latestNumber,
      }]);
    }
    if (sql.includes('company-content.next-approval-request-number')) {
      const [itemId, versionId] = values.map(String);
      const count = this.requests.filter((request) => (
        request.itemId === itemId && request.versionId === versionId
      )).length;
      return this.rows<T>([{ next: count + 1 }]);
    }
    if (sql.includes('company-content.insert-approval-request')) {
      const request: ApprovalRequest = {
        id: String(values[0]),
        itemId: String(values[1]),
        versionId: String(values[2]),
        contentSha256: String(values[3]),
        requestNumber: Number(values[4]),
      };
      this.requests.push(request);
      return this.rows<T>([{
        approvalRequestId: request.id,
        contentItemId: request.itemId,
        contentVersionId: request.versionId,
        requestNumber: request.requestNumber,
        contentSha256: request.contentSha256,
        isLatest: true,
        decision: null,
      }]);
    }
    if (sql.includes('company-content.lock-approval-request')) {
      const request = this.requests.find((candidate) => candidate.id === String(values[0]));
      if (!request) return this.rows<T>([]);
      const version = this.versions.find((candidate) => candidate.id === request.versionId)!;
      const latestNumber = Math.max(...this.versions
        .filter((candidate) => candidate.itemId === request.itemId)
        .map((candidate) => candidate.versionNumber));
      return this.rows<T>([{
        approvalRequestId: request.id,
        contentItemId: request.itemId,
        contentVersionId: request.versionId,
        requestNumber: request.requestNumber,
        contentSha256: request.contentSha256,
        isLatest: version.versionNumber === latestNumber,
        decision: this.decisions.get(request.id)?.decision ?? null,
      }]);
    }
    if (sql.includes('company-content.insert-approval-decision')) {
      this.decisions.set(String(values[3]), { id: String(values[0]), decision: String(values[5]) });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('company-content.list-version-approval-states')) {
      const itemId = String(values[0]);
      const versions = this.versions.filter((candidate) => candidate.itemId === itemId);
      const latestNumber = Math.max(...versions.map((candidate) => candidate.versionNumber));
      return this.rows<T>(versions
        .sort((left, right) => right.versionNumber - left.versionNumber)
        .map((version) => {
          const request = this.requests
            .filter((candidate) => candidate.versionId === version.id)
            .sort((left, right) => right.requestNumber - left.requestNumber)[0];
          const decision = request ? this.decisions.get(request.id) : undefined;
          return {
            contentItemId: itemId,
            contentVersionId: version.id,
            versionNumber: version.versionNumber,
            title: version.title,
            origin: version.origin,
            sourceSystem: version.sourceSystem,
            sourceItemId: version.sourceItemId,
            sourceVersion: version.sourceVersion,
            contentSha256: version.contentSha256,
            blobSha256: version.blobSha256,
            brandSha256: version.brandSha256,
            approvalRequestId: request?.id ?? null,
            approvalDecisionId: decision?.id ?? null,
            approvalStatus: decision?.decision ?? (request ? 'pending' : 'unrequested'),
            approvalStale: version.versionNumber !== latestNumber,
          };
        }));
    }
    if (sql.includes('company-content.list-catalog')) {
      const [cursorAt, cursorId, rawLimit] = values as [string | null, string | null, number];
      return this.rows<T>(this.versions
        .filter((version) => {
          const latest = Math.max(...this.versions
            .filter((candidate) => candidate.itemId === version.itemId)
            .map((candidate) => candidate.versionNumber));
          if (version.versionNumber !== latest) return false;
          if (cursorAt === null) return true;
          return version.createdAt < cursorAt
            || (version.createdAt === cursorAt && version.id < String(cursorId));
        })
        .sort((left, right) => (
          right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)
        ))
        .slice(0, Number(rawLimit))
        .map((version) => {
          const request = this.requests
            .filter((candidate) => candidate.versionId === version.id)
            .sort((left, right) => right.requestNumber - left.requestNumber)[0];
          const decision = request ? this.decisions.get(request.id) : undefined;
          const priorApproved = this.versions.some((older) => (
            older.itemId === version.itemId
            && older.versionNumber < version.versionNumber
            && this.requests.some((candidate) => (
              candidate.versionId === older.id
              && this.decisions.get(candidate.id)?.decision === 'approved'
            ))
          ));
          const attestation = this.attestations.get(version.id);
          const sourceFresh = Boolean(attestation
            && new Date(attestation.checkedAt).getTime() <= Date.now()
            && new Date(attestation.expiresAt).getTime() > Date.now());
          return {
            contentItemId: version.itemId,
            contentVersionId: version.id,
            versionNumber: version.versionNumber,
            origin: version.origin,
            kind: version.kind,
            title: version.title,
            contentMimeType: version.contentMimeType,
            sourceSystem: version.sourceSystem,
            sourceItemId: version.sourceItemId,
            sourceVersion: version.sourceVersion,
            contentSha256: version.contentSha256,
            blobSha256: version.blobSha256,
            brandSha256: version.brandSha256,
            approvalRequestId: request?.id ?? null,
            approvalDecisionId: decision?.id ?? null,
            approvalStatus: request
              ? decision?.decision ?? 'pending'
              : priorApproved ? 'stale' : 'unrequested',
            approvalStale: priorApproved && decision?.decision !== 'approved',
            sourceAttestationId: attestation?.id ?? null,
            sourceCheckedAt: attestation?.checkedAt ?? null,
            sourceExpiresAt: attestation?.expiresAt ?? null,
            sourceFresh,
            publishable: decision?.decision === 'approved' && sourceFresh,
            createdAt: version.createdAt,
          };
        }));
    }
    throw new Error(`Unexpected company content SQL: ${sql}`);
  }
}

function runner(sql: InMemoryContentSql): CompanyContentTransactionRunner {
  return { run: async (_context, operation) => operation(sql) };
}

function ids(): () => string {
  let next = 3;
  return () => `${String(next++).padStart(8, '0')}-3333-4333-8333-${String(next).padStart(12, '0')}`;
}

test('normalization computes exact content SHA and rejects malformed provenance hashes', () => {
  const normalized = normalizeCompanyContentVersionCommand(command());
  assert.equal(
    normalized.contentSha256,
    createHash('sha256').update(command().content, 'utf8').digest('hex'),
  );
  assert.throws(
    () => normalizeCompanyContentVersionCommand(command({
      blob: { storageKey: 'fixtures/source.pdf', sha256: 'AA'.repeat(32) },
    })),
    CompanyContentValidationError,
  );
  assert.throws(
    () => normalizeCompanyContentVersionCommand(command({
      contentItemId: '33333333-3333-4333-8333-333333333333',
    })),
    /contentItemId and previousVersionId/,
  );
  assert.throws(
    () => normalizeCompanyContentVersionCommand(command({
      attestation: {
        catalogSha256: '33'.repeat(32),
        checkedAt: ATTESTATION_CHECKED_AT.toISOString(),
        expiresAt: new Date(
          ATTESTATION_CHECKED_AT.getTime() + 15 * 60_000 + 1,
        ).toISOString(),
      },
    })),
    /may not exceed 15 minutes/,
  );
  assert.throws(
    () => normalizeCompanyContentVersionCommand(command({
      metadata: { oversized: 'x'.repeat(65_537) },
    })),
    /metadata must not exceed 65536 UTF-8 bytes/,
  );
});

test('request hashes are canonical, actor-bound and insensitive to metadata key order', () => {
  const left = normalizeCompanyContentVersionCommand(command({ metadata: { z: 1, a: true } }));
  const right = normalizeCompanyContentVersionCommand(command({ metadata: { a: true, z: 1 } }));
  assert.deepEqual(
    companyContentRequestHash(context, 'companyContent.createVersion', left),
    companyContentRequestHash(context, 'companyContent.createVersion', right),
  );
  assert.notDeepEqual(
    companyContentRequestHash(context, 'companyContent.createVersion', left),
    companyContentRequestHash({ ...context, userId: '99999999-9999-4999-8999-999999999999' }, 'companyContent.createVersion', left),
  );
  assert.equal(
    canonicalCompanyContentJson({ é: 4, a: 3, _: 2, Z: 1 }),
    '{"Z":1,"_":2,"a":3,"é":4}',
  );
});

test('version, approval and edit flow preserves old approval as explicitly stale', async () => {
  const database = new InMemoryContentSql();
  const service = new CompanyContentService({
    transactionRunner: runner(database),
    nextId: ids(),
    now: () => new Date('2026-08-26T12:00:00.000Z'),
  });
  const first = await service.createVersion(context, command());
  const requested = await service.requestApproval(context, {
    commandKey: 'approve-request-v1',
    contentItemId: first.contentItemId,
    contentVersionId: first.contentVersionId,
  });
  await service.decideApproval(context, {
    commandKey: 'approve-decision-v1',
    approvalRequestId: requested.approvalRequestId,
    decision: 'approved',
  });
  const second = await service.createVersion(context, command({
    commandKey: 'fixture-edit-2',
    contentItemId: first.contentItemId,
    previousVersionId: first.contentVersionId,
    origin: 'edited',
    content: '# Launch plan\nCorrected fixture bytes.',
    source: { system: 'property_predator', itemId: 'launch-plan', version: 'edit-v2' },
  }));
  assert.equal(second.versionNumber, 2);
  assert.deepEqual(
    (await service.listVersionApprovalStates(context, first.contentItemId)).map((version) => ({
      version: version.versionNumber,
      approval: version.approvalStatus,
      stale: version.approvalStale,
    })),
    [
      { version: 2, approval: 'unrequested', stale: false },
      { version: 1, approval: 'approved', stale: true },
    ],
  );
  const catalog = await service.listCatalog(context, { limit: 10 });
  assert.equal(catalog.items.length, 1);
  assert.deepEqual({
    version: catalog.items[0]!.versionNumber,
    approval: catalog.items[0]!.approvalStatus,
    stale: catalog.items[0]!.approvalStale,
    sourceFresh: catalog.items[0]!.sourceFresh,
    publishable: catalog.items[0]!.publishable,
  }, {
    version: 2, approval: 'stale', stale: true,
    sourceFresh: true, publishable: false,
  });
  assert.equal(catalog.nextCursor, null);
  await assert.rejects(
    service.requestApproval(context, {
      commandKey: 'stale-request-v1',
      contentItemId: first.contentItemId,
      contentVersionId: first.contentVersionId,
    }),
    CompanyContentVersionConflictError,
  );
});

test('exact command replay returns stored result while changed input conflicts', async () => {
  const database = new InMemoryContentSql();
  const service = new CompanyContentService({ transactionRunner: runner(database), nextId: ids() });
  const first = await service.createVersion(context, command());
  assert.deepEqual(await service.createVersion(context, command()), {
    ...first,
    disposition: 'replayed',
  });
  await assert.rejects(
    service.createVersion(context, command({ content: 'Different bytes under the same key' })),
    CompanyContentIdempotencyConflictError,
  );
  assert.equal(database.versions.length, 1);
});

test('source sync atomically resolves one logical item and appends the next source version', async () => {
  const database = new InMemoryContentSql();
  const service = new CompanyContentService({ transactionRunner: runner(database), nextId: ids() });
  const first = await service.createVersion(context, command());
  const second = await service.createVersion(context, command({
    commandKey: 'fixture-import-2',
    content: '# Launch plan\nSource revision two.',
    source: { system: 'property_predator', itemId: 'launch-plan', version: 'fixture-v2' },
  }));
  assert.deepEqual({
    sameItem: second.contentItemId === first.contentItemId,
    version: second.versionNumber,
    previous: database.versions[1]?.itemId,
  }, {
    sameItem: true,
    version: 2,
    previous: first.contentItemId,
  });
  assert.equal(database.items.size, 1);
});

test('approval is publishable only while the exact source attestation remains fresh', async () => {
  const database = new InMemoryContentSql();
  const service = new CompanyContentService({ transactionRunner: runner(database), nextId: ids() });
  const version = await service.createVersion(context, command());
  const request = await service.requestApproval(context, {
    commandKey: 'freshness-request',
    contentItemId: version.contentItemId,
    contentVersionId: version.contentVersionId,
  });
  await service.decideApproval(context, {
    commandKey: 'freshness-decision',
    approvalRequestId: request.approvalRequestId,
    decision: 'approved',
  });
  const fresh = (await service.listCatalog(context)).items[0]!;
  assert.deepEqual({
    approval: fresh.approvalStatus,
    sourceFresh: fresh.sourceFresh,
    publishable: fresh.publishable,
  }, { approval: 'approved', sourceFresh: true, publishable: true });

  database.attestations.get(version.contentVersionId)!.expiresAt = new Date(
    Date.now() - 1,
  ).toISOString();
  const expired = (await service.listCatalog(context)).items[0]!;
  assert.deepEqual({
    approval: expired.approvalStatus,
    sourceFresh: expired.sourceFresh,
    publishable: expired.publishable,
  }, { approval: 'approved', sourceFresh: false, publishable: false });
});

test('workspace catalog is cursor-bounded and rejects invalid database rows', async () => {
  const database = new InMemoryContentSql();
  let tick = 0;
  const service = new CompanyContentService({
    transactionRunner: runner(database),
    nextId: ids(),
    now: () => new Date(Date.UTC(2026, 7, 26, 12, tick++)),
  });
  for (let index = 1; index <= 3; index += 1) {
    await service.createVersion(context, command({
      commandKey: `catalog-item-${index}`,
      title: `Catalog item ${index}`,
      source: {
        system: 'fixture', itemId: `catalog-${index}`, version: 'v1',
      },
    }));
  }
  const first = await service.listCatalog(context, { limit: 2 });
  assert.equal(first.items.length, 2);
  assert.ok(first.nextCursor);
  const second = await service.listCatalog(context, { limit: 2, cursor: first.nextCursor });
  assert.equal(second.items.length, 1);
  assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.items, ...second.items].map((item) => item.contentItemId)).size, 3);
  await assert.rejects(
    service.listCatalog(context, { limit: 101 }),
    CompanyContentValidationError,
  );
  await assert.rejects(
    new CompanyContentPgRepository(database).listCatalog({ limit: 102, cursor: null }),
    /repository catalog bound is invalid/,
  );

  const invalidRows: Record<string, unknown>[] = [{
        contentItemId: 'not-a-uuid',
        contentVersionId: 'also-not-a-uuid',
        versionNumber: 1,
        origin: 'imported',
        kind: 'document',
        title: 'Unsafe row',
        contentMimeType: 'text/plain',
        sourceSystem: 'fixture',
        sourceItemId: 'one',
        sourceVersion: 'v1',
        contentSha256: HASH_A,
        blobSha256: HASH_A,
        brandSha256: HASH_B,
        approvalRequestId: null,
        approvalDecisionId: null,
        approvalStatus: 'unrequested',
        approvalStale: false,
        sourceAttestationId: null,
        sourceCheckedAt: null,
        sourceExpiresAt: null,
        sourceFresh: false,
        publishable: false,
        createdAt: '2026-08-26T12:00:00.000Z',
  }];
  const badExecutor: SqlExecutor = {
    async query<T extends Record<string, unknown>>(): Promise<SqlResult<T>> {
      return { rows: invalidRows as T[], rowCount: 1 };
    },
  };
  await assert.rejects(
    new CompanyContentPgRepository(badExecutor).listCatalog({ limit: 10, cursor: null }),
    /invalid canonical data/,
  );
});
