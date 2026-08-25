import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Pool } from 'pg';
import type { DatabaseRequestContext } from '../../src/db/rls.js';
import type { SqlExecutor } from '../../src/crm-pg/types.js';
import {
  CompanyContentIdempotencyConflictError,
  CompanyContentService,
  type CompanyContentTransactionRunner,
} from '../../src/company-content-pg/index.js';
import {
  expectPostgresError,
  openTestDatabase,
  ownerQuery,
  resetIdentityTables,
  testDatabaseSkipReason,
} from './database-helper.js';

const skip = testDatabaseSkipReason();

type CompanyContentRole = 'r72_content_adapter' | 'r72_content_command';

function contentRunner(
  pool: Pool,
  role: CompanyContentRole,
): CompanyContentTransactionRunner {
  return {
    async run<T>(
      context: DatabaseRequestContext,
      operation: (transaction: SqlExecutor) => Promise<T>,
      options: Readonly<{ readOnly: boolean; serializable?: boolean }>,
    ): Promise<T> {
      const client = await pool.connect();
      try {
        const isolation = options.serializable ? 'SERIALIZABLE' : 'READ COMMITTED';
        const access = options.readOnly ? 'READ ONLY' : 'READ WRITE';
        await client.query(`BEGIN ISOLATION LEVEL ${isolation} ${access}`);
        // Role is a compile-time allowlist, never browser or fixture input.
        await client.query(`SET LOCAL ROLE ${role}`);
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
      } finally {
        client.release();
      }
    },
  };
}

async function roleQuery(
  pool: Pool,
  role: 'r72_web' | CompanyContentRole,
  context: DatabaseRequestContext,
  sql: string,
  values: readonly unknown[] = [],
): Promise<Record<string, unknown>[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${role}`);
    await client.query(
      `SELECT set_config('app.user_id', $1, true),
              set_config('app.workspace_id', $2, true),
              set_config('app.actor_kind', 'user', true),
              set_config('app.request_id', $3, true)`,
      [context.userId, context.workspaceId, context.requestId],
    );
    const result = await client.query<Record<string, unknown>>(sql, [...values]);
    await client.query('COMMIT');
    return result.rows;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

test('company content is isolated, immutable, replay-safe and marks superseded approval stale', {
  skip,
}, async () => {
  const pool = await openTestDatabase();
  const organizationId = randomUUID();
  const workspaceA = randomUUID();
  const workspaceB = randomUUID();
  const ownerA = randomUUID();
  const marketerA = randomUUID();
  const ownerB = randomUUID();
  const ownerContext: DatabaseRequestContext = {
    actorKind: 'user', workspaceId: workspaceA, userId: ownerA,
    requestId: 'company-content-owner-test',
  };
  const marketerContext: DatabaseRequestContext = {
    actorKind: 'user', workspaceId: workspaceA, userId: marketerA,
    requestId: 'company-content-marketer-test',
  };
  const otherContext: DatabaseRequestContext = {
    actorKind: 'user', workspaceId: workspaceB, userId: ownerB,
    requestId: 'company-content-other-test',
  };
  const shaA = '11'.repeat(32);
  const shaB = '22'.repeat(32);

  try {
    await resetIdentityTables(pool);
    const suffix = organizationId.replaceAll('-', '').slice(0, 10);
    await ownerQuery(pool,
      `INSERT INTO app.organizations (id, name, slug, kind, status)
       VALUES ($1, 'Content integration', $2, 'direct_customer', 'active')`,
      [organizationId, `content-${suffix}`]);
    await ownerQuery(pool,
      `INSERT INTO app.users (id, email, status, email_verified_at)
       VALUES
         ($1, $2, 'active', statement_timestamp()),
         ($3, $4, 'active', statement_timestamp()),
         ($5, $6, 'active', statement_timestamp())`,
      [
        ownerA, `owner-${ownerA.slice(0, 8)}@example.test`,
        marketerA, `marketer-${marketerA.slice(0, 8)}@example.test`,
        ownerB, `other-${ownerB.slice(0, 8)}@example.test`,
      ]);
    await ownerQuery(pool,
      `INSERT INTO app.workspaces (id, organization_id, name, slug, status)
       VALUES
         ($1, $2, 'Content A', $3, 'active'),
         ($4, $2, 'Content B', $5, 'active')`,
      [
        workspaceA, organizationId, `content-a-${workspaceA.slice(0, 8)}`,
        workspaceB, `content-b-${workspaceB.slice(0, 8)}`,
      ]);
    await ownerQuery(pool,
      `INSERT INTO app.workspace_memberships (
         workspace_id, organization_id, user_id, role, status
       ) VALUES
         ($1, $2, $3, 'owner', 'active'),
         ($1, $2, $4, 'marketer', 'active'),
         ($5, $2, $6, 'owner', 'active')`,
      [
        workspaceA, organizationId, ownerA, marketerA, workspaceB, ownerB,
      ]);

    const adapterService = new CompanyContentService({
      transactionRunner: contentRunner(pool, 'r72_content_adapter'),
    });
    const commandService = new CompanyContentService({
      transactionRunner: contentRunner(pool, 'r72_content_command'),
    });
    const checkedAt = new Date(Date.now() - 60_000);
    const firstCommand = {
      commandKey: 'integration-content-v1',
      origin: 'imported' as const,
      kind: 'document' as const,
      title: 'Company launch plan',
      contentMimeType: 'text/markdown',
      content: '# Durable company launch plan',
      source: { system: 'fixture', itemId: 'launch-plan', version: 'v1' },
      blob: { storageKey: 'fixtures/launch-plan-v1', sha256: shaA },
      brand: { snapshotRef: 'brand/fixture-v1', sha256: shaB },
      attestation: {
        catalogSha256: '33'.repeat(32),
        checkedAt: checkedAt.toISOString(),
        expiresAt: new Date(checkedAt.getTime() + 5 * 60_000).toISOString(),
      },
    };
    const first = await adapterService.createVersion(ownerContext, firstCommand);
    assert.equal((await adapterService.createVersion(ownerContext, firstCommand)).disposition, 'replayed');
    await assert.rejects(
      adapterService.createVersion(ownerContext, { ...firstCommand, content: 'changed bytes' }),
      CompanyContentIdempotencyConflictError,
    );
    await expectPostgresError(commandService.createVersion(ownerContext, {
      ...firstCommand,
      commandKey: 'approval-role-cannot-create-version',
      source: { ...firstCommand.source, version: 'forbidden-command-role' },
    }), '42501');

    const request = await commandService.requestApproval(marketerContext, {
      commandKey: 'integration-request-v1',
      contentItemId: first.contentItemId,
      contentVersionId: first.contentVersionId,
      reviewNote: 'Ready for manager review',
    });
    await expectPostgresError(commandService.decideApproval(marketerContext, {
      commandKey: 'marketer-cannot-approve',
      approvalRequestId: request.approvalRequestId,
      decision: 'approved',
    }), '42501');
    await commandService.decideApproval(ownerContext, {
      commandKey: 'owner-approval-v1',
      approvalRequestId: request.approvalRequestId,
      decision: 'approved',
    });
    await expectPostgresError(adapterService.requestApproval(ownerContext, {
      commandKey: 'adapter-cannot-request-approval',
      contentItemId: first.contentItemId,
      contentVersionId: first.contentVersionId,
    }), '42501');
    const approvedCatalog = await commandService.listCatalog(ownerContext, { limit: 10 });
    assert.deepEqual(
      approvedCatalog.items.map((item) => [
        item.approvalStatus, item.sourceFresh, item.publishable,
      ]),
      [['approved', true, true]],
    );

    const insertInvalidAttestation = (
      id: string,
      checkedAtSql: string,
      expiresAtSql: string,
    ) => roleQuery(
      pool, 'r72_content_adapter', ownerContext,
      `INSERT INTO app.company_content_source_attestations (
         id, workspace_id, content_item_id, content_version_id,
         source_system, source_item_id, source_version,
         content_sha256, blob_sha256, brand_sha256,
         source_catalog_sha256, checked_at, expires_at,
         attested_by_user_id, attested_request_id, created_at
       )
       SELECT $1, version.workspace_id, version.content_item_id, version.id,
              version.source_system, version.source_item_id, version.source_version,
              version.content_sha256, version.blob_sha256, version.brand_sha256,
              decode($2, 'hex'), ${checkedAtSql}, ${expiresAtSql},
              $3, 'forged-attestation', statement_timestamp()
       FROM app.company_content_versions AS version
       WHERE version.id = $4`,
      [id, '44'.repeat(32), ownerA, first.contentVersionId],
    );
    await expectPostgresError(insertInvalidAttestation(
      randomUUID(),
      'statement_timestamp()',
      "statement_timestamp() + interval '16 minutes'",
    ), '23514');
    await expectPostgresError(insertInvalidAttestation(
      randomUUID(),
      "statement_timestamp() - interval '6 minutes'",
      "statement_timestamp() - interval '1 minute'",
    ), '23514');

    const second = await adapterService.createVersion(ownerContext, {
      ...firstCommand,
      commandKey: 'integration-content-v2',
      contentItemId: first.contentItemId,
      previousVersionId: first.contentVersionId,
      origin: 'edited',
      content: '# Durable company launch plan\nCorrected.',
      source: { system: 'fixture', itemId: 'launch-plan', version: 'v2' },
    });
    assert.equal(second.versionNumber, 2);
    assert.deepEqual(
      (await commandService.listVersionApprovalStates(ownerContext, first.contentItemId))
        .map((version) => [version.versionNumber, version.approvalStatus, version.approvalStale]),
      [[2, 'unrequested', false], [1, 'approved', true]],
    );
    const catalog = await commandService.listCatalog(ownerContext, { limit: 10 });
    assert.deepEqual(
      catalog.items.map((item) => [
        item.versionNumber, item.approvalStatus, item.approvalStale,
        item.sourceFresh, item.publishable,
      ]),
      [[2, 'stale', true, true, false]],
    );

    assert.deepEqual(await roleQuery(
      pool, 'r72_content_adapter', ownerContext,
      `SELECT command_name AS "commandName"
       FROM app.command_receipts ORDER BY command_name, id`,
    ), [
      { commandName: 'companyContent.createVersion' },
      { commandName: 'companyContent.createVersion' },
    ]);
    assert.deepEqual(await roleQuery(
      pool, 'r72_content_command', ownerContext,
      `SELECT command_name AS "commandName"
       FROM app.command_receipts ORDER BY command_name, id`,
    ), [{ commandName: 'companyContent.decideApproval' }]);
    assert.deepEqual(await roleQuery(
      pool, 'r72_content_command', marketerContext,
      `SELECT command_name AS "commandName"
       FROM app.command_receipts ORDER BY command_name, id`,
    ), [{ commandName: 'companyContent.requestApproval' }]);

    assert.deepEqual(await commandService.listCatalog(otherContext), {
      items: [], nextCursor: null,
    });
    assert.deepEqual(await roleQuery(
      pool, 'r72_content_adapter', otherContext,
      'SELECT count(*)::integer AS count FROM app.company_content_versions',
    ), [{ count: 0 }]);
    assert.deepEqual(await roleQuery(
      pool, 'r72_web', otherContext,
      'SELECT count(*)::integer AS count FROM app.company_content_versions',
    ), [{ count: 0 }]);
    await expectPostgresError(roleQuery(
      pool, 'r72_web', ownerContext,
      `INSERT INTO app.company_content_items (
         id, workspace_id, created_by_user_id, created_request_id
       ) VALUES ($1, $2, $3, 'forged-web-write')`,
      [randomUUID(), workspaceA, ownerA],
    ), '42501');
    await expectPostgresError(roleQuery(
      pool, 'r72_content_command', ownerContext,
      'UPDATE app.company_content_versions SET title = title WHERE id = $1',
      [first.contentVersionId],
    ), '42501');
    await expectPostgresError(ownerQuery(
      pool,
      'UPDATE app.company_content_approval_decisions SET decision = decision WHERE id = $1',
      [(await ownerQuery<{ id: string }>(pool,
        `SELECT id FROM app.company_content_approval_decisions
         WHERE content_version_id = $1`, [first.contentVersionId]))[0]!.id],
    ), '55000');

    const stamped = await ownerQuery<{
      created_by_user_id: string;
      created_request_id: string;
    }>(pool,
      `SELECT created_by_user_id, created_request_id
       FROM app.company_content_versions WHERE id = $1`,
      [second.contentVersionId]);
    assert.deepEqual(stamped, [{
      created_by_user_id: ownerA,
      created_request_id: ownerContext.requestId,
    }]);
  } finally {
    await resetIdentityTables(pool);
    await pool.end();
  }
});
