import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Pool, PoolClient } from 'pg';
import type { DatabaseRequestContext } from '../../src/db/rls.js';
import type { SqlExecutor } from '../../src/crm-pg/types.js';
import {
  LegacyImportConflictError,
  PROPERTY_PREDATOR_ACCOUNT_SNAPSHOT_SOURCE,
  PropertyPredatorSnapshotService,
  propertyPredatorSnapshotContentSha256,
  propertyPredatorSnapshotPageSha256,
  type LegacyImportTransactionRunner,
  type PropertyPredatorAccountSnapshotEnvelopeV2,
  type PropertyPredatorSnapshotRecordV2,
} from '../../src/legacy-import/index.js';
import {
  expectPostgresError,
  openTestDatabase,
  ownerQuery,
  resetIdentityTables,
  testDatabaseSkipReason,
} from './database-helper.js';

const skip = testDatabaseSkipReason();
const NOW = new Date('2026-08-27T10:10:00.000Z');
const GENERATED_AT = '2026-08-27T10:09:00.000Z';
const WATERMARK = '2026-08-27T10:08:30.000Z';
const SNAPSHOT_ID = '0198f20f-6ac0-7000-8000-000000000030';
const ACCOUNT_1 = '10000000-0000-4000-8000-000000000001';
const ACCOUNT_2 = '10000000-0000-4000-8000-000000000002';
const ACCOUNT_3 = '10000000-0000-4000-8000-000000000003';
const ACCOUNT_4 = '10000000-0000-4000-8000-000000000004';
const AFFILIATE_1 = '30000000-0000-4000-8000-000000000001';
const AFFILIATE_3 = '30000000-0000-4000-8000-000000000003';
const AFFILIATE_MISSING = '30000000-0000-4000-8000-000000000099';
const REFERRAL_4 = '40000000-0000-4000-8000-000000000004';

function importRunner(pool: Pool): LegacyImportTransactionRunner {
  return {
    async run<T>(
      context: DatabaseRequestContext,
      operation: (transaction: SqlExecutor) => Promise<T>,
      options: Readonly<{ readOnly: boolean; serializable?: boolean }>,
    ): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query(
          `BEGIN ISOLATION LEVEL ${options.serializable ? 'SERIALIZABLE' : 'REPEATABLE READ'} ${options.readOnly ? 'READ ONLY' : 'READ WRITE'}`,
        );
        await client.query('SET LOCAL ROLE r72_import_command');
        await client.query(
          `SELECT set_config('app.user_id', $1, true),
                  set_config('app.workspace_id', $2, true),
                  set_config('app.actor_kind', 'user', true),
                  set_config('app.request_id', $3, true)`,
          [context.userId, context.workspaceId, context.requestId],
        );
        const value = await operation({
          async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
            sql: string,
            values?: readonly unknown[],
          ) {
            const result = await client.query<TRow>(sql, values ? [...values] : undefined);
            return { rows: result.rows, rowCount: result.rowCount };
          },
        });
        await client.query('COMMIT');
        return value;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

async function webRoleQuery(pool: Pool, context: DatabaseRequestContext, sql: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query('SET LOCAL ROLE r72_web');
    await client.query(
      `SELECT set_config('app.user_id', $1, true),
              set_config('app.workspace_id', $2, true),
              set_config('app.actor_kind', 'user', true),
              set_config('app.request_id', $3, true)`,
      [context.userId, context.workspaceId, context.requestId],
    );
    await client.query(sql);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function importRoleMutation(
  pool: Pool,
  context: DatabaseRequestContext,
  sql: string,
  values: readonly unknown[] = [],
): Promise<void> {
  await importRunner(pool).run(context, async (transaction) => {
    await transaction.query(sql, values);
  }, { readOnly: false, serializable: true });
}

function buildSnapshot(
  pageRecords: readonly (readonly PropertyPredatorSnapshotRecordV2[])[],
): readonly PropertyPredatorAccountSnapshotEnvelopeV2[] {
  const pages: PropertyPredatorAccountSnapshotEnvelopeV2['pages'][0][] = [];
  let previousPageSha256: string | null = null;
  for (const [index, records] of pageRecords.entries()) {
    const pageNumber = index + 1;
    const cursor = pageNumber === 1 ? null : `cursor-${pageNumber}`;
    const nextCursor = pageNumber === pageRecords.length ? null : `cursor-${pageNumber + 1}`;
    const pageSha256 = propertyPredatorSnapshotPageSha256({
      snapshotId: SNAPSHOT_ID,
      pageNumber,
      cursor,
      nextCursor,
      previousPageSha256,
      records,
    });
    pages.push({
      pageNumber,
      cursor,
      nextCursor,
      previousPageSha256,
      records,
      pageSha256,
    });
    previousPageSha256 = pageSha256;
  }
  const recordCount = pages.reduce((sum, page) => sum + page.records.length, 0);
  const eventHighWatermark = '9223372036854775807';
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
    pageSha256: pages.map((page) => page.pageSha256),
  });
  const manifest = {
    pageCount: pages.length,
    recordCount,
    eventHighWatermark,
    contentSha256,
  };
  return pages.map((page) => ({
    schemaVersion: 2,
    sourceSystem: PROPERTY_PREDATOR_ACCOUNT_SNAPSHOT_SOURCE,
    snapshotId: SNAPSHOT_ID,
    generatedAt: GENERATED_AT,
    watermark: WATERMARK,
    complete: true,
    manifest,
    pages: [page],
  }));
}

test('disposable PostgreSQL stages immutable v2 evidence and previews verified identity without promotion', {
  skip,
  timeout: 90_000,
}, async () => {
  const pool = await openTestDatabase();
  const organizationA = randomUUID();
  const organizationB = randomUUID();
  const workspaceA = randomUUID();
  const workspaceB = randomUUID();
  const ownerA = randomUUID();
  const ownerB = randomUUID();
  const contactId = randomUUID();
  const contactPointId = randomUUID();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const contextA: DatabaseRequestContext = {
    actorKind: 'user', workspaceId: workspaceA, userId: ownerA,
    requestId: 'snapshot-v2-integration-owner',
  };
  const contextB: DatabaseRequestContext = {
    actorKind: 'user', workspaceId: workspaceB, userId: ownerB,
    requestId: 'snapshot-v2-integration-other-workspace',
  };
  const records: readonly PropertyPredatorSnapshotRecordV2[] = [
    {
      account: {
        id: ACCOUNT_1, email: 'founder@example.test',
        createdAt: '2026-01-01T09:00:00.000Z', displayName: 'Founder Source Name',
        verifiedIdentity: {
          provider: 'google', emailVerified: true,
          verifiedAt: '2026-01-01T09:01:00.000Z',
        },
      },
      ownAffiliate: {
        id: AFFILIATE_1, code: 'PREDATOR72', codeStatus: 'active',
        createdAt: '2026-01-01T09:02:00.000Z',
      },
      originalAttribution: null,
    },
    {
      account: {
        id: ACCOUNT_2, email: 'duplicate-a@example.test',
        createdAt: '2026-01-02T09:00:00.000Z', verifiedIdentity: null,
      },
      ownAffiliate: null,
      originalAttribution: null,
    },
    {
      account: {
        id: ACCOUNT_2, email: 'duplicate-b@example.test',
        createdAt: '2026-01-02T09:01:00.000Z', verifiedIdentity: null,
      },
      ownAffiliate: null,
      originalAttribution: null,
    },
    {
      account: {
        id: ACCOUNT_3, email: 'affiliate-owner@example.test',
        createdAt: '2026-01-03T09:00:00.000Z', verifiedIdentity: null,
      },
      ownAffiliate: {
        id: AFFILIATE_3, code: 'PARTNER03', codeStatus: 'unknown',
        createdAt: '2026-01-03T09:01:00.000Z', parentAffiliateId: AFFILIATE_MISSING,
      },
      originalAttribution: null,
    },
    {
      account: {
        id: ACCOUNT_4, email: 'referred@example.test',
        createdAt: '2026-01-04T09:00:00.000Z',
        verifiedIdentity: {
          provider: 'google', emailVerified: true,
          verifiedAt: '2026-01-04T09:01:00.000Z',
        },
      },
      ownAffiliate: null,
      originalAttribution: {
        referralId: REFERRAL_4, affiliateId: AFFILIATE_3,
        affiliateCode: 'PARTNER03', attachedAt: '2026-01-04T08:59:00.000Z',
      },
    },
  ];
  const snapshot = buildSnapshot([records.slice(0, 3), records.slice(3)]);

  try {
    await resetIdentityTables(pool);
    await ownerQuery(
      pool,
      `INSERT INTO app.organizations (id, name, slug, kind)
       VALUES ($1, 'Snapshot A', $2, 'agency'), ($3, 'Snapshot B', $4, 'agency')`,
      [organizationA, `snapshot-a-${suffix}`, organizationB, `snapshot-b-${suffix}`],
    );
    await ownerQuery(
      pool,
      `INSERT INTO app.users (id, email, status, email_verified_at)
       VALUES ($1, $2, 'active', statement_timestamp()),
              ($3, $4, 'active', statement_timestamp())`,
      [ownerA, `owner-a-${suffix}@example.test`, ownerB, `owner-b-${suffix}@example.test`],
    );
    await ownerQuery(
      pool,
      `INSERT INTO app.workspaces
         (id, organization_id, legacy_tenant_key, name, slug)
       VALUES ($1, $2, NULL, 'Snapshot A', $3),
              ($4, $5, NULL, 'Snapshot B', $6)`,
      [
        workspaceA, organizationA, `snapshot-workspace-a-${suffix}`,
        workspaceB, organizationB, `snapshot-workspace-b-${suffix}`,
      ],
    );
    await ownerQuery(
      pool,
      `INSERT INTO app.organization_memberships
         (organization_id, user_id, role, status)
       VALUES ($1, $2, 'owner', 'active'), ($3, $4, 'owner', 'active')`,
      [organizationA, ownerA, organizationB, ownerB],
    );
    await ownerQuery(
      pool,
      `INSERT INTO app.workspace_memberships
         (workspace_id, organization_id, user_id, role, status,
          source_organization_id, granted_at)
       VALUES ($1, $2, $3, 'owner', 'active', $2, statement_timestamp()),
              ($4, $5, $6, 'owner', 'active', $5, statement_timestamp())`,
      [workspaceA, organizationA, ownerA, workspaceB, organizationB, ownerB],
    );
    await ownerQuery(
      pool,
      `INSERT INTO app.contacts
         (id, workspace_id, display_name, source)
       VALUES ($1, $2, 'Existing Founder Name', 'manual')`,
      [contactId, workspaceA],
    );
    await ownerQuery(
      pool,
      `INSERT INTO app.contact_points
         (id, workspace_id, contact_id, kind, label, value, normalized_value,
          is_primary, is_verified, consent_status)
       VALUES ($1, $2, $3, 'email', 'Existing email', 'founder@example.test',
               'founder@example.test', true, false, 'unknown')`,
      [contactPointId, workspaceA, contactId],
    );

    const service = new PropertyPredatorSnapshotService({
      transactionRunner: importRunner(pool),
      now: () => NOW,
    });
    const staged = await service.stage(contextA, snapshot);
    assert.equal(staged.disposition, 'staged');
    assert.equal(staged.pageCount, 2);
    assert.equal(staged.recordCount, 5);
    assert.equal(staged.eventHighWatermark, '9223372036854775807');
    assert.equal(staged.consentDefault, 'unknown');
    assert.equal(staged.quarantinedSourceRecords, 4);

    await expectPostgresError(
      importRoleMutation(
        pool,
        contextA,
        `INSERT INTO app_private.property_predator_snapshot_manifests (
           id, workspace_id, schema_version, source_system, snapshot_id,
           generated_at, watermark, complete, page_count, record_count,
           event_high_watermark, content_sha256, envelope_sha256, source_metadata,
           consent_default, created_by_user_id, request_id, staged_at
         ) VALUES (
           $1, app_private.current_workspace_id(), 2,
           'property-predator.accounts/v2', $2,
           '2026-08-27T10:09:00.000Z', '2026-08-27T10:08:30.000Z',
           true, 1, 0, 0, decode(repeat('11', 32), 'hex'),
           decode(repeat('22', 32), 'hex'), '{}'::jsonb, 'unknown',
           app_private.current_user_id(), app_private.current_request_id(),
           '2026-08-27T10:10:00.000Z'
         )`,
        [randomUUID(), '0198f20f-6ac0-7000-8000-000000000031'],
      ),
      '23514',
    );
    await expectPostgresError(
      importRoleMutation(
        pool,
        contextA,
        `INSERT INTO app_private.property_predator_snapshot_pages (
           id, workspace_id, manifest_id, source_system, snapshot_id,
           page_number, cursor, next_cursor, previous_page_sha256,
           page_sha256, record_count, source_envelope, staged_at
         ) VALUES (
           $1, app_private.current_workspace_id(), $2,
           'property-predator.accounts/v2', $3,
           3, 'malformed-page-3', NULL, decode(repeat('33', 32), 'hex'),
           decode(repeat('44', 32), 'hex'), 0, '{}'::jsonb,
           '2026-08-27T10:10:00.000Z'
         )`,
        [randomUUID(), staged.snapshotStageId, SNAPSHOT_ID],
      ),
      '23514',
    );

    const preview = await service.previewStaged(contextA, SNAPSHOT_ID);
    assert.equal(preview.writes, 0);
    assert.equal(preview.integrity, 'verified_complete_snapshot');
    assert.equal(preview.eventHighWatermark, '9223372036854775807');
    assert.equal(preview.consentDefault, 'unknown');
    assert.deepEqual(preview.accountCounts, {
      create: 1,
      match: 1,
      replay: 0,
      quarantine: 3,
    });
    assert.equal(preview.sourceIssues.length, 4);
    const founder = preview.reconciliation?.rows.find((row) => row.sourceRecordId === ACCOUNT_1);
    assert.equal(founder?.resolution, 'match');
    assert.equal(founder?.contactId, contactId);
    assert.deepEqual(founder?.reasons, [
      'verified_identity_match',
      'verification_evidence_not_promoted',
    ]);

    assert.deepEqual(await ownerQuery<{
      manifests: number;
      pages: number;
      quarantines: number;
      raw_records: number;
      event_high_watermark: string;
      consent_default: string;
    }>(
      pool,
      `SELECT
         (SELECT count(*)::integer
          FROM app_private.property_predator_snapshot_manifests
          WHERE workspace_id = $1) AS manifests,
         (SELECT count(*)::integer
          FROM app_private.property_predator_snapshot_pages
          WHERE workspace_id = $1) AS pages,
         (SELECT count(*)::integer
          FROM app_private.property_predator_snapshot_quarantine
          WHERE workspace_id = $1) AS quarantines,
         (SELECT sum(jsonb_array_length(source_envelope -> 'pages' -> 0 -> 'records'))::integer
          FROM app_private.property_predator_snapshot_pages
          WHERE workspace_id = $1) AS raw_records,
         (SELECT event_high_watermark::text
          FROM app_private.property_predator_snapshot_manifests
          WHERE workspace_id = $1) AS event_high_watermark,
         (SELECT consent_default
          FROM app_private.property_predator_snapshot_manifests
          WHERE workspace_id = $1) AS consent_default`,
      [workspaceA],
    ), [{
      manifests: 1,
      pages: 2,
      quarantines: 4,
      raw_records: 5,
      event_high_watermark: '9223372036854775807',
      consent_default: 'unknown',
    }]);

    assert.deepEqual(await ownerQuery<{
      contacts: number;
      points: number;
      is_verified: boolean;
      consent_status: string;
      display_name: string;
    }>(
      pool,
      `SELECT
         (SELECT count(*)::integer FROM app.contacts WHERE workspace_id = $1) AS contacts,
         (SELECT count(*)::integer FROM app.contact_points WHERE workspace_id = $1) AS points,
         (SELECT is_verified FROM app.contact_points WHERE id = $2) AS is_verified,
         (SELECT consent_status FROM app.contact_points WHERE id = $2) AS consent_status,
         (SELECT display_name FROM app.contacts WHERE id = $3) AS display_name`,
      [workspaceA, contactPointId, contactId],
    ), [{
      contacts: 1,
      points: 1,
      is_verified: false,
      consent_status: 'unknown',
      display_name: 'Existing Founder Name',
    }]);

    await assert.rejects(
      service.previewStaged(contextB, SNAPSHOT_ID),
      LegacyImportConflictError,
    );
    await expectPostgresError(
      webRoleQuery(
        pool,
        contextA,
        'SELECT * FROM app_private.property_predator_snapshot_manifests',
      ),
      '42501',
    );
    await expectPostgresError(
      importRoleMutation(
        pool,
        contextA,
        `UPDATE app_private.property_predator_snapshot_manifests
         SET request_id = request_id WHERE snapshot_id = '${SNAPSHOT_ID}'`,
      ),
      '42501',
    );
    await expectPostgresError(
      importRoleMutation(
        pool,
        contextA,
        `DELETE FROM app_private.property_predator_snapshot_pages
         WHERE snapshot_id = '${SNAPSHOT_ID}'`,
      ),
      '42501',
    );

    const replay = await service.stage(contextA, snapshot);
    assert.equal(replay.disposition, 'replayed');
    assert.equal(replay.snapshotStageId, staged.snapshotStageId);
  } finally {
    await resetIdentityTables(pool);
    await pool.end();
  }
});
