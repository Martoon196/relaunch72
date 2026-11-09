import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Pool } from 'pg';
import type { SqlExecutor } from '../../src/crm-pg/types.js';
import type { DatabaseRequestContext } from '../../src/db/rls.js';
import {
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

test('disposable PostgreSQL records blocked imports, recovers on replay, and adopts without duplicates', {
  skip,
  timeout: 90_000,
}, async () => {
  const pool = await openTestDatabase();
  const organizationId = randomUUID();
  const workspaceId = randomUUID();
  const ownerId = randomUUID();
  const pipelineId = randomUUID();
  const firstOpenStageId = randomUUID();
  const secondOpenStageId = randomUUID();
  const wonStageId = randomUUID();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const context: DatabaseRequestContext = {
    actorKind: 'user', workspaceId, userId: ownerId,
    requestId: 'legacy-board-materialization-integration',
  };
  const sourceRow = {
    sourceRecordId: 'legacy_user_001',
    displayName: 'Legacy Journey Lead',
    originalCreatedAt: '2024-04-01T10:00:00Z',
    identities: [{
      kind: 'email' as const,
      value: 'legacy-journey@example.test',
      verified: true,
      primary: true,
    }],
    attribution: {
      affiliateSourceId: 'affiliate_exact_001',
      affiliateCode: 'EXACT-001',
      referralCode: 'REF-EXACT-001',
      raw: { source_affiliate_id: 'affiliate_exact_001' },
    },
  };

  try {
    await resetIdentityTables(pool);
    await ownerQuery(
      pool,
      `INSERT INTO app.organizations (id, name, slug, kind)
       VALUES ($1, 'Legacy Board Materializer', $2, 'agency')`,
      [organizationId, `legacy-board-${suffix}`],
    );
    await ownerQuery(
      pool,
      `INSERT INTO app.users (id, email, status, email_verified_at)
       VALUES ($1, $2, 'active', statement_timestamp())`,
      [ownerId, `legacy-board-${suffix}@example.test`],
    );
    await ownerQuery(
      pool,
      `INSERT INTO app.workspaces
         (id, organization_id, name, slug, currency)
       VALUES ($1, $2, 'Legacy Board Materializer', $3, 'USD')`,
      [workspaceId, organizationId, `legacy-board-${suffix}`],
    );
    await ownerQuery(
      pool,
      `INSERT INTO app.organization_memberships
         (organization_id, user_id, role, status)
       VALUES ($1, $2, 'owner', 'active')`,
      [organizationId, ownerId],
    );
    await ownerQuery(
      pool,
      `INSERT INTO app.workspace_memberships
         (workspace_id, organization_id, user_id, role, status,
          source_organization_id, granted_at)
       VALUES ($1, $2, $3, 'owner', 'active', $2, statement_timestamp())`,
      [workspaceId, organizationId, ownerId],
    );

    const service = new LegacyLeadImportService({
      transactionRunner: importRunner(pool),
      now: () => new Date('2026-08-25T12:00:00Z'),
    });
    const firstBatch = await service.stage(context, {
      schemaVersion: 1,
      sourceSystem: 'property_predator',
      batchKey: 'legacy-board-no-topology',
      rows: [sourceRow],
    });
    await service.commit(context, firstBatch.batchId);

    assert.deepEqual(await ownerQuery<{
      opportunity_count: number;
      last_disposition: string;
      failure_reason: string;
      source_system: string;
      source_record_id: string;
      affiliate_source_id: string;
      affiliate_code: string;
      referral_code: string;
    }>(
      pool,
      `SELECT
         (SELECT count(*)::integer FROM app.opportunities
          WHERE workspace_id = $1) AS opportunity_count,
         materialization.last_disposition,
         materialization.failure_reason,
         materialization.source_system,
         materialization.source_record_id,
         attribution.affiliate_source_id,
         attribution.affiliate_code,
         attribution.referral_code
       FROM app_private.legacy_lead_board_materializations AS materialization
       JOIN app.contact_import_attribution_facts AS attribution
         ON attribution.workspace_id = materialization.workspace_id
        AND attribution.contact_id = materialization.contact_id
       WHERE materialization.workspace_id = $1`,
      [workspaceId],
    ), [{
      opportunity_count: 0,
      last_disposition: 'blocked',
      failure_reason: 'default_pipeline_missing',
      source_system: 'property_predator',
      source_record_id: 'legacy_user_001',
      affiliate_source_id: 'affiliate_exact_001',
      affiliate_code: 'EXACT-001',
      referral_code: 'REF-EXACT-001',
    }]);

    await ownerQuery(
      pool,
      `INSERT INTO app.pipelines
         (id, workspace_id, name, slug, status, is_default)
       VALUES ($1, $2, 'Default journey', 'default-journey', 'active', true)`,
      [pipelineId, workspaceId],
    );
    await ownerQuery(
      pool,
      `INSERT INTO app.pipeline_stages
         (id, workspace_id, pipeline_id, name, slug, position, stage_type, is_terminal)
       VALUES
         ($1, $2, $3, 'First open', 'first-open', 1, 'open', false),
         ($4, $2, $3, 'Second open', 'second-open', 2, 'open', false),
         ($5, $2, $3, 'Won', 'won', 3, 'won', true)`,
      [firstOpenStageId, workspaceId, pipelineId, secondOpenStageId, wonStageId],
    );

    const retryBatch = await service.stage(context, {
      schemaVersion: 1,
      sourceSystem: 'property_predator',
      batchKey: 'legacy-board-topology-retry',
      rows: [sourceRow],
    });
    assert.deepEqual(await service.commit(context, retryBatch.batchId), {
      disposition: 'committed', batchId: retryBatch.batchId,
      imported: 0, matched: 0, replayed: 1, quarantined: 0,
    });
    assert.deepEqual(await ownerQuery<{
      count: number; stage_id: string; currency: string; disposition: string;
    }>(
      pool,
      `SELECT count(*)::integer AS count,
              min(opportunity.stage_id::text)::uuid AS stage_id,
              min(opportunity.currency) AS currency,
              min(materialization.last_disposition) AS disposition
       FROM app.opportunities AS opportunity
       JOIN app_private.legacy_lead_board_materializations AS materialization
         ON materialization.workspace_id = opportunity.workspace_id
        AND materialization.opportunity_id = opportunity.id
       WHERE opportunity.workspace_id = $1`,
      [workspaceId],
    ), [{ count: 1, stage_id: firstOpenStageId, currency: 'USD', disposition: 'created' }]);

    const replayBatch = await service.stage(context, {
      schemaVersion: 1,
      sourceSystem: 'property_predator',
      batchKey: 'legacy-board-idempotent-replay',
      rows: [sourceRow],
    });
    await service.commit(context, replayBatch.batchId);
    await service.commit(context, replayBatch.batchId);
    assert.deepEqual(await ownerQuery<{ count: number; attempts: number; disposition: string }>(
      pool,
      `SELECT count(opportunity.id)::integer AS count,
              min(materialization.attempt_count)::integer AS attempts,
              min(materialization.last_disposition) AS disposition
       FROM app.opportunities AS opportunity
       JOIN app_private.legacy_lead_board_materializations AS materialization
         ON materialization.workspace_id = opportunity.workspace_id
        AND materialization.opportunity_id = opportunity.id
       WHERE opportunity.workspace_id = $1`,
      [workspaceId],
    ), [{ count: 1, attempts: 3, disposition: 'existing' }]);

    const adoptedContactId = randomUUID();
    const adoptedContactPointId = randomUUID();
    const adoptedOpportunityId = randomUUID();
    await ownerQuery(
      pool,
      `INSERT INTO app.contacts
         (id, workspace_id, display_name, lifecycle_status, source)
       VALUES ($1, $2, 'Already in CRM', 'lead', 'manual')`,
      [adoptedContactId, workspaceId],
    );
    await ownerQuery(
      pool,
      `INSERT INTO app.contact_points
         (id, workspace_id, contact_id, kind, value, normalized_value,
          is_primary, is_verified, dedupe_state)
       VALUES ($3, $2, $1, 'email', 'already@example.test',
               'already@example.test', true, true, 'normal')`,
      [adoptedContactId, workspaceId, adoptedContactPointId],
    );
    await ownerQuery(
      pool,
      `INSERT INTO app.opportunities
         (id, workspace_id, contact_id, pipeline_id, stage_id, name, status, currency)
       VALUES ($1, $2, $3, $4, $5, 'Existing opportunity', 'open', 'USD')`,
      [
        adoptedOpportunityId, workspaceId, adoptedContactId,
        pipelineId, secondOpenStageId,
      ],
    );
    const adoptionBatch = await service.stage(context, {
      schemaVersion: 1,
      sourceSystem: 'property_predator',
      batchKey: 'legacy-board-adopt-existing',
      rows: [{
        sourceRecordId: 'legacy_user_adopted',
        displayName: 'Source Name Must Not Overwrite CRM',
        originalCreatedAt: '2024-05-01T10:00:00Z',
        identities: [{
          kind: 'email', value: 'already@example.test', verified: true, primary: true,
        }],
      }],
    });
    assert.deepEqual(await service.commit(context, adoptionBatch.batchId), {
      disposition: 'committed', batchId: adoptionBatch.batchId,
      imported: 0, matched: 1, replayed: 0, quarantined: 0,
    });
    assert.deepEqual(await ownerQuery<{
      count: number; opportunity_id: string; disposition: string; display_name: string;
    }>(
      pool,
      `SELECT
         (SELECT count(*)::integer FROM app.opportunities
          WHERE workspace_id = $1 AND contact_id = $2) AS count,
         materialization.opportunity_id,
         materialization.last_disposition AS disposition,
         contact.display_name
       FROM app_private.legacy_lead_board_materializations AS materialization
       JOIN app.contacts AS contact
         ON contact.workspace_id = materialization.workspace_id
        AND contact.id = materialization.contact_id
       WHERE materialization.workspace_id = $1
         AND materialization.contact_id = $2`,
      [workspaceId, adoptedContactId],
    ), [{
      count: 1,
      opportunity_id: adoptedOpportunityId,
      disposition: 'existing',
      display_name: 'Already in CRM',
    }]);

    await expectPostgresError(
      importRunner(pool).run(context, async (transaction) => {
        await transaction.query(
          `INSERT INTO app.opportunities
             (workspace_id, contact_id, pipeline_id, stage_id, name, status, currency)
           VALUES ($1, $2, $3, $4, 'Forbidden direct import insert', 'open', 'USD')`,
          [workspaceId, adoptedContactId, pipelineId, firstOpenStageId],
        );
      }, { readOnly: false, serializable: true }),
      '42501',
    );
    await expectPostgresError(
      importRunner(pool).run(context, async (transaction) => {
        await transaction.query(
          'SELECT * FROM app_private.legacy_lead_board_materializations',
        );
      }, { readOnly: true }),
      '42501',
    );
  } finally {
    await resetIdentityTables(pool).catch(() => undefined);
    await pool.end();
  }
});
