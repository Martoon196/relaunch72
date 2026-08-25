import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Pool, QueryResultRow } from 'pg';
import type { DatabaseRequestContext } from '../../src/db/rls.js';
import type { SqlExecutor } from '../../src/crm-pg/types.js';
import {
  LegacyImportConflictError,
  LegacyLeadImportService,
  type LegacyImportTransactionRunner,
} from '../../src/legacy-import/index.js';
import {
  expectPostgresError,
  openTestDatabase,
  ownerQuery,
  resetIdentityTables,
  testDatabaseSkipReason,
} from './database-helper.js';

const skip = testDatabaseSkipReason();

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

async function importRoleQuery<T extends QueryResultRow>(
  pool: Pool,
  context: DatabaseRequestContext,
  sql: string,
  values: readonly unknown[] = [],
): Promise<T[]> {
  return importRunner(pool).run(context, async (transaction) => (
    transaction.query<T>(sql, values).then((result) => result.rows)
  ), { readOnly: true });
}

async function webRoleQuery<T extends QueryResultRow>(
  pool: Pool,
  context: DatabaseRequestContext,
  sql: string,
): Promise<T[]> {
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
    const result = await client.query<T>(sql);
    await client.query('COMMIT');
    return result.rows;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

test('disposable PostgreSQL rehearses, commits and replays legacy leads without losing affiliate evidence', {
  skip,
  timeout: 90_000,
}, async () => {
  const pool = await openTestDatabase();
  const organizationA = randomUUID();
  const organizationB = randomUUID();
  const workspaceA = randomUUID();
  const workspaceB = randomUUID();
  const ownerA = randomUUID();
  const viewerA = randomUUID();
  const ownerB = randomUUID();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const ownerContext: DatabaseRequestContext = {
    actorKind: 'user', workspaceId: workspaceA, userId: ownerA,
    requestId: 'legacy-import-integration-owner',
  };
  const viewerContext: DatabaseRequestContext = {
    actorKind: 'user', workspaceId: workspaceA, userId: viewerA,
    requestId: 'legacy-import-integration-viewer',
  };
  const otherWorkspaceContext: DatabaseRequestContext = {
    actorKind: 'user', workspaceId: workspaceB, userId: ownerB,
    requestId: 'legacy-import-integration-other-workspace',
  };
  const input = {
    schemaVersion: 1 as const,
    sourceSystem: 'property_predator',
    batchKey: 'sqlite-export-001',
    rows: [{
      sourceRecordId: 'user_001', displayName: 'Original Lead',
      originalCreatedAt: '2024-04-01T10:00:00Z',
      identities: [{
        kind: 'email' as const, value: 'original@example.test',
        verified: true, primary: true,
      }],
      attribution: {
        affiliateSourceId: 'affiliate_001', affiliateCode: 'PPAFF001',
        referralCode: 'PREDATOR-001', attributedAt: '2024-04-01T09:59:00Z',
        raw: { affiliate_id: 'affiliate_001', code: 'PPAFF001' },
      },
    }],
    unresolvedAttributions: [{
      recordKind: 'commission' as const, sourceRecordId: 'commission_001',
      referredSourceRecordId: 'missing_user_002',
      originalCreatedAt: '2024-04-02T10:00:00Z',
      reason: 'missing_contact' as const,
      affiliateSourceId: 'affiliate_001', affiliateCode: 'PPAFF001',
      referralCode: 'PREDATOR-001',
      raw: { referred_user_id: 'missing_user_002', commission_minor: 5000 },
    }],
  };

  try {
    await resetIdentityTables(pool);
    await ownerQuery(
      pool,
      `INSERT INTO app.organizations (id, name, slug, kind)
       VALUES ($1, 'Legacy A', $2, 'agency'), ($3, 'Legacy B', $4, 'agency')`,
      [organizationA, `legacy-a-${suffix}`, organizationB, `legacy-b-${suffix}`],
    );
    await ownerQuery(
      pool,
      `INSERT INTO app.users (id, email, status, email_verified_at)
       VALUES ($1, $2, 'active', statement_timestamp()),
              ($3, $4, 'active', statement_timestamp()),
              ($5, $6, 'active', statement_timestamp())`,
      [
        ownerA, `owner-a-${suffix}@example.test`,
        viewerA, `viewer-a-${suffix}@example.test`,
        ownerB, `owner-b-${suffix}@example.test`,
      ],
    );
    await ownerQuery(
      pool,
      `INSERT INTO app.workspaces
         (id, organization_id, legacy_tenant_key, name, slug)
       VALUES ($1, $2, NULL, 'Legacy A', $3),
              ($4, $5, NULL, 'Legacy B', $6)`,
      [workspaceA, organizationA, `legacy-workspace-a-${suffix}`,
        workspaceB, organizationB, `legacy-workspace-b-${suffix}`],
    );
    await ownerQuery(
      pool,
      `INSERT INTO app.organization_memberships
         (organization_id, user_id, role, status)
       VALUES ($1, $2, 'owner', 'active'), ($1, $3, 'billing', 'active'),
              ($4, $5, 'owner', 'active')`,
      [organizationA, ownerA, viewerA, organizationB, ownerB],
    );
    await ownerQuery(
      pool,
      `INSERT INTO app.workspace_memberships
         (workspace_id, organization_id, user_id, role, status,
          source_organization_id, granted_at)
       VALUES ($1, $2, $3, 'owner', 'active', $2, statement_timestamp()),
              ($1, $2, $4, 'viewer', 'active', $2, statement_timestamp()),
              ($5, $6, $7, 'owner', 'active', $6, statement_timestamp())`,
      [workspaceA, organizationA, ownerA, viewerA, workspaceB, organizationB, ownerB],
    );

    const service = new LegacyLeadImportService({
      transactionRunner: importRunner(pool),
      now: () => new Date('2026-08-25T12:00:00Z'),
    });
    const rehearsal = await service.dryRun(ownerContext, input);
    assert.deepEqual(rehearsal.counts, { create: 1, match: 0, replay: 0, quarantine: 1 });
    assert.deepEqual(await ownerQuery<{ contacts: number; batches: number }>(
      pool,
      `SELECT
         (SELECT count(*)::integer FROM app.contacts WHERE workspace_id = $1) AS contacts,
         (SELECT count(*)::integer FROM app_private.legacy_lead_import_batches
          WHERE workspace_id = $1) AS batches`,
      [workspaceA],
    ), [{ contacts: 0, batches: 0 }]);

    await expectPostgresError(
      service.stage(viewerContext, { ...input, batchKey: 'viewer-forbidden' }),
      '42501',
    );
    const staged = await service.stage(ownerContext, input);
    assert.equal(staged.disposition, 'staged');
    assert.equal(staged.rowCount, 2);
    const committed = await service.commit(ownerContext, staged.batchId);
    assert.deepEqual(committed, {
      disposition: 'committed', batchId: staged.batchId,
      imported: 1, matched: 0, replayed: 0, quarantined: 1,
    });

    assert.deepEqual(await ownerQuery<{
      contacts: number; provenance: number; attribution: number; unresolved: number;
      display_name: string; created_at: string; affiliate_code: string;
      referral_code: string; referred_source_record_id: string;
    }>(
      pool,
      `SELECT
         (SELECT count(*)::integer FROM app.contacts WHERE workspace_id = $1) AS contacts,
         (SELECT count(*)::integer FROM app.contact_import_provenance
          WHERE workspace_id = $1) AS provenance,
         (SELECT count(*)::integer FROM app.contact_import_attribution_facts
          WHERE workspace_id = $1) AS attribution,
         (SELECT count(*)::integer FROM app_private.legacy_lead_unresolved_attributions
          WHERE workspace_id = $1) AS unresolved,
         (SELECT display_name FROM app.contacts WHERE workspace_id = $1) AS display_name,
         (SELECT created_at::text FROM app.contacts WHERE workspace_id = $1) AS created_at,
         (SELECT affiliate_code FROM app.contact_import_attribution_facts
          WHERE workspace_id = $1) AS affiliate_code,
         (SELECT referral_code FROM app.contact_import_attribution_facts
          WHERE workspace_id = $1) AS referral_code,
         (SELECT referred_source_record_id
          FROM app_private.legacy_lead_unresolved_attributions
          WHERE workspace_id = $1) AS referred_source_record_id`,
      [workspaceA],
    ), [{
      contacts: 1, provenance: 1, attribution: 1, unresolved: 1,
      display_name: 'Original Lead', created_at: '2024-04-01 10:00:00+00',
      affiliate_code: 'PPAFF001', referral_code: 'PREDATOR-001',
      referred_source_record_id: 'missing_user_002',
    }]);

    await expectPostgresError(
      webRoleQuery(
        pool,
        ownerContext,
        'SELECT raw_attribution FROM app_private.contact_import_attribution_payloads',
      ),
      '42501',
    );

    const overlapping = {
      ...input,
      batchKey: 'sqlite-export-overlap-002',
      rows: [],
    };
    const overlapRehearsal = await service.dryRun(ownerContext, overlapping);
    assert.deepEqual(overlapRehearsal.counts, {
      create: 0, match: 0, replay: 1, quarantine: 0,
    });
    const overlappingStage = await service.stage(ownerContext, overlapping);
    assert.deepEqual(await service.commit(ownerContext, overlappingStage.batchId), {
      disposition: 'committed', batchId: overlappingStage.batchId,
      imported: 0, matched: 0, replayed: 1, quarantined: 0,
    });
    assert.deepEqual(await ownerQuery<{ canonical: number; staged_occurrences: number }>(
      pool,
      `SELECT
         (SELECT count(*)::integer
          FROM app_private.legacy_lead_unresolved_attribution_receipts
          WHERE workspace_id = $1) AS canonical,
         (SELECT count(*)::integer
          FROM app_private.legacy_lead_unresolved_attributions
          WHERE workspace_id = $1) AS staged_occurrences`,
      [workspaceA],
    ), [{ canonical: 1, staged_occurrences: 2 }]);

    const forgedBatchId = randomUUID();
    const forged = await importRunner(pool).run(ownerContext, async (transaction) => (
      transaction.query<{
        created_by_user_id: string;
        request_id: string;
        status: string;
        imported_count: number;
      }>(
        `INSERT INTO app_private.legacy_lead_import_batches (
           id, workspace_id, schema_version, source_system, batch_key,
           input_sha256, status, row_count, imported_count,
           created_by_user_id, request_id, created_at, committed_at
         ) VALUES (
           $1, app_private.current_workspace_id(), 1, 'property_predator',
           'forged-audit-attempt', decode(repeat('11', 32), 'hex'),
           'committed', 1, 1, $2, 'forged-request',
           '2020-01-01T00:00:00Z', '2020-01-02T00:00:00Z'
         )
         RETURNING created_by_user_id, request_id, status, imported_count`,
        [forgedBatchId, viewerA],
      ).then((result) => result.rows[0]!)
    ), { readOnly: false, serializable: true });
    assert.deepEqual(forged, {
      created_by_user_id: ownerA,
      request_id: ownerContext.requestId,
      status: 'staged',
      imported_count: 0,
    });
    await expectPostgresError(
      importRunner(pool).run(ownerContext, async (transaction) => {
        await transaction.query(
          `UPDATE app_private.legacy_lead_import_batches
           SET status = 'committed', imported_count = 1,
               report = '{"forged":true}'::jsonb,
               committed_at = statement_timestamp()
           WHERE id = $1`,
          [forgedBatchId],
        );
      }, { readOnly: false, serializable: true }),
      'P0001',
    );

    assert.equal((await service.stage(ownerContext, input)).disposition, 'replayed');
    assert.equal((await service.commit(ownerContext, staged.batchId)).disposition, 'replayed');
    await assert.rejects(
      service.stage(ownerContext, {
        ...input,
        rows: [{ ...input.rows[0]!, displayName: 'Changed bytes' }],
      }),
      LegacyImportConflictError,
    );

    const matching = await service.stage(ownerContext, {
      schemaVersion: 1, sourceSystem: 'property_predator', batchKey: 'sqlite-export-002',
      rows: [{
        ...input.rows[0]!, sourceRecordId: 'user_002',
        displayName: 'Must Not Replace Original', attribution: null,
      }],
    });
    assert.deepEqual(await service.commit(ownerContext, matching.batchId), {
      disposition: 'committed', batchId: matching.batchId,
      imported: 0, matched: 1, replayed: 0, quarantined: 0,
    });
    assert.deepEqual(await ownerQuery<{ count: number; display_name: string; provenance: number }>(
      pool,
      `SELECT count(*)::integer AS count, min(display_name) AS display_name,
              (SELECT count(*)::integer FROM app.contact_import_provenance
               WHERE workspace_id = $1) AS provenance
       FROM app.contacts WHERE workspace_id = $1`,
      [workspaceA],
    ), [{ count: 1, display_name: 'Original Lead', provenance: 2 }]);

    assert.deepEqual(await importRoleQuery<{ count: number }>(
      pool,
      otherWorkspaceContext,
      `SELECT count(*)::integer AS count
       FROM app_private.legacy_lead_import_batches`,
    ), [{ count: 0 }]);
  } finally {
    await resetIdentityTables(pool);
    await pool.end();
  }
});
