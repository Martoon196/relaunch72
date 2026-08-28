import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Pool } from 'pg';
import {
  CompanyContentService,
  type CompanyContentTransactionRunner,
} from '../../src/company-content-pg/index.js';
import type { SqlExecutor } from '../../src/crm-pg/types.js';
import type { DatabaseRequestContext } from '../../src/db/rls.js';
import { propertyPredatorOwnedSeedProofEmailCommand } from '../../src/portal/owned-seed-proof-email.js';
import {
  expectPostgresError,
  openTestDatabase,
  ownerQuery,
  resetIdentityTables,
  testDatabaseSkipReason,
} from './database-helper.js';

const skip = testDatabaseSkipReason();

function contentAdapterRunner(pool: Pool): CompanyContentTransactionRunner {
  return {
    async run<T>(
      context: DatabaseRequestContext,
      operation: (transaction: SqlExecutor) => Promise<T>,
      options: Readonly<{ readOnly: boolean; serializable?: boolean }>,
    ): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query(
          `BEGIN ISOLATION LEVEL ${options.serializable ? 'SERIALIZABLE' : 'READ COMMITTED'} ${options.readOnly ? 'READ ONLY' : 'READ WRITE'}`,
        );
        await client.query('SET LOCAL ROLE r72_content_adapter');
        await client.query(
          `SELECT set_config('app.user_id', $1, true),
                  set_config('app.workspace_id', $2, true),
                  set_config('app.actor_kind', 'user', true),
                  set_config('app.request_id', $3, true)`,
          [context.userId, context.workspaceId, context.requestId],
        );
        const result = await operation(client as SqlExecutor);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
    },
  };
}

async function insertExtendedAttestation(
  pool: Pool,
  context: DatabaseRequestContext,
  contentVersionId: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE r72_content_adapter');
    await client.query(
      `SELECT set_config('app.user_id', $1, true),
              set_config('app.workspace_id', $2, true),
              set_config('app.actor_kind', 'user', true),
              set_config('app.request_id', $3, true)`,
      [context.userId, context.workspaceId, context.requestId],
    );
    await client.query(
      `INSERT INTO app.company_content_source_attestations (
         id, workspace_id, content_item_id, content_version_id,
         source_system, source_item_id, source_version,
         content_sha256, blob_sha256, brand_sha256, source_catalog_sha256,
         checked_at, expires_at, attested_by_user_id, attested_request_id
       )
       SELECT $1, version.workspace_id, version.content_item_id, version.id,
              version.source_system, version.source_item_id, version.source_version,
              version.content_sha256, version.blob_sha256, version.brand_sha256,
              pg_catalog.decode($2, 'hex'), statement_timestamp(),
              statement_timestamp() + interval '24 hours', $3, 'overwritten'
       FROM app.company_content_versions AS version
       WHERE version.workspace_id = $4 AND version.id = $5`,
      [randomUUID(), '44'.repeat(32), context.userId, context.workspaceId, contentVersionId],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

test('the disposable database persists only the exact 24-hour owned-office proof', {
  skip,
}, async () => {
  const pool = await openTestDatabase();
  const organizationId = randomUUID();
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const context: DatabaseRequestContext = Object.freeze({
    actorKind: 'user', workspaceId, userId,
    requestId: 'owned-seed-attestation-window-integration',
  });
  try {
    await resetIdentityTables(pool);
    await ownerQuery(pool,
      `INSERT INTO app.organizations (id, name, slug, kind, status)
       VALUES ($1, 'Owned proof attestation', $2, 'direct_customer', 'active')`,
      [organizationId, `owned-proof-${organizationId.slice(0, 8)}`]);
    await ownerQuery(pool,
      `INSERT INTO app.users (id, email, status, email_verified_at)
       VALUES ($1, $2, 'active', statement_timestamp())`,
      [userId, `owned-proof-${userId.slice(0, 8)}@example.test`]);
    await ownerQuery(pool,
      `INSERT INTO app.workspaces (id, organization_id, name, slug, status)
       VALUES ($1, $2, 'Owned proof attestation', $3, 'active')`,
      [workspaceId, organizationId, `owned-proof-${workspaceId.slice(0, 8)}`]);
    await ownerQuery(pool,
      `INSERT INTO app.workspace_memberships (
         workspace_id, organization_id, user_id, role, status
       ) VALUES ($1, $2, $3, 'owner', 'active')`,
      [workspaceId, organizationId, userId]);

    const service = new CompanyContentService({
      transactionRunner: contentAdapterRunner(pool),
    });
    const now = Date.now();
    const proof = await service.createEmailDraftVersion(
      context,
      propertyPredatorOwnedSeedProofEmailCommand('owned-proof-create-0001', now),
    );
    assert.equal(
      Date.parse(proof.sourceAttestationExpiresAt) - now,
      24 * 60 * 60 * 1_000,
    );

    const wrong = await service.createEmailDraftVersion(
      { ...context, requestId: 'owned-seed-attestation-wrong-bytes' },
      {
        ...propertyPredatorOwnedSeedProofEmailCommand('owned-proof-create-wrong', now),
        commandKey: 'owned-proof-create-wrong',
        source: {
          system: 'propertypredator.company-content',
          itemId: 'growth-hq-owned-seed-delivery-proof-attack',
          version: 'operational-proof-v1',
        },
        attestation: {
          ...propertyPredatorOwnedSeedProofEmailCommand('unused', now).attestation,
          expiresAt: new Date(now + 14 * 60 * 1_000).toISOString(),
        },
      },
    );
    await expectPostgresError(insertExtendedAttestation(
      pool,
      { ...context, requestId: 'owned-seed-attestation-extended-attack' },
      wrong.contentVersionId,
    ), '23514');
  } finally {
    await resetIdentityTables(pool);
    await pool.end();
  }
});
