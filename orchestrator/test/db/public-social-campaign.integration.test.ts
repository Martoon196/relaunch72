import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Pool } from 'pg';
import type { DatabaseRequestContext } from '../../src/db/rls.js';
import type { SqlExecutor } from '../../src/crm-pg/types.js';
import {
  CompanyContentService,
  type CompanyContentTransactionRunner,
} from '../../src/company-content-pg/index.js';
import { socialCampaignRevisionSha256 } from '../../src/social-campaign-pg/index.js';
import {
  expectPostgresError,
  openTestDatabase,
  ownerQuery,
  resetIdentityTables,
  scopedQuery,
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
        await client.query(
          `BEGIN ISOLATION LEVEL ${options.serializable ? 'SERIALIZABLE' : 'READ COMMITTED'} ${options.readOnly ? 'READ ONLY' : 'READ WRITE'}`,
        );
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

test('TEST public-social campaign scheduling is workspace-isolated, replay-safe and lease-fenced', {
  skip,
}, async () => {
  const pool = await openTestDatabase();
  const organizationId = randomUUID();
  const workspaceA = randomUUID();
  const workspaceB = randomUUID();
  const ownerA = randomUUID();
  const ownerB = randomUUID();
  const connectionId = randomUUID();
  const campaignId = randomUUID();
  const revisionId = randomUUID();
  const targetId = randomUUID();
  const postId = randomUUID();
  const workerId = randomUUID();
  const leaseHash = Buffer.from('ab'.repeat(32), 'hex');
  const wrongLeaseHash = Buffer.from('cd'.repeat(32), 'hex');
  const revisionHash = Buffer.from(socialCampaignRevisionSha256({
    workspaceId: workspaceA,
    campaignId,
    revisionId,
    revisionNumber: 1,
    previousRevisionId: null,
    title: 'Launch sprint',
    objective: 'Prove the dark simulator campaign rail',
    timezone: 'Europe/London',
  }), 'hex');
  const planHash = Buffer.from('22'.repeat(32), 'hex');
  const ownerContext: DatabaseRequestContext = {
    actorKind: 'user', workspaceId: workspaceA, userId: ownerA,
    requestId: 'public-social-content-owner',
  };
  const commandContext = {
    workspaceId: workspaceA,
    userId: ownerA,
    requestId: 'public-social-command',
  };
  const otherContext = {
    workspaceId: workspaceB,
    userId: ownerB,
    requestId: 'public-social-cross-workspace',
  };
  const workerContext = {
    workspaceId: workspaceA,
    requestId: 'public-social-worker',
  };

  try {
    const runtimeReadiness = await scopedQuery<{
      migration_count: number;
      has_worker_readiness_migration: boolean;
      installation_id: string;
    }>(pool, 'r72_public_social_worker_command', workerContext,
      `SELECT count(*)::int AS migration_count,
              bool_or(filename = '0041_public_social_worker_runtime_readiness.sql')
                AS has_worker_readiness_migration,
              app_private.runtime_database_installation_id()::text AS installation_id
       FROM app_private.runtime_schema_migrations()`,
    );
    assert.equal(runtimeReadiness.length, 1);
    assert.ok((runtimeReadiness[0]?.migration_count ?? 0) >= 41);
    assert.equal(runtimeReadiness[0]?.has_worker_readiness_migration, true);
    assert.match(
      runtimeReadiness[0]?.installation_id ?? '',
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    await resetIdentityTables(pool);
    const suffix = organizationId.replaceAll('-', '').slice(0, 10);
    await ownerQuery(pool,
      `INSERT INTO app.organizations (id, name, slug, kind, status)
       VALUES ($1, 'Public social integration', $2, 'direct_customer', 'active')`,
      [organizationId, `public-social-${suffix}`],
    );
    await ownerQuery(pool,
      `INSERT INTO app.users (id, email, status, email_verified_at)
       VALUES
         ($1, $2, 'active', statement_timestamp()),
         ($3, $4, 'active', statement_timestamp())`,
      [
        ownerA, `social-a-${ownerA.slice(0, 8)}@example.test`,
        ownerB, `social-b-${ownerB.slice(0, 8)}@example.test`,
      ],
    );
    await ownerQuery(pool,
      `INSERT INTO app.workspaces (id, organization_id, name, slug, status)
       VALUES
         ($1, $2, 'Social A', $3, 'active'),
         ($4, $2, 'Social B', $5, 'active')`,
      [
        workspaceA, organizationId, `social-a-${workspaceA.slice(0, 8)}`,
        workspaceB, `social-b-${workspaceB.slice(0, 8)}`,
      ],
    );
    await ownerQuery(pool,
      `INSERT INTO app.workspace_memberships (
         workspace_id, organization_id, user_id, role, status
       ) VALUES
         ($1, $2, $3, 'owner', 'active'),
         ($4, $2, $5, 'owner', 'active')`,
      [workspaceA, organizationId, ownerA, workspaceB, ownerB],
    );
    await ownerQuery(pool,
      `INSERT INTO app.provider_connections (
         id, workspace_id, provider_id, provider_kind, environment,
         status, display_name, capabilities, created_by_user_id
       ) VALUES (
         $1, $2, 'public_social_dark_simulator', 'social', 'test',
         'active', 'Public social dark simulator', '["social.publish"]'::jsonb, $3
       )`,
      [connectionId, workspaceA, ownerA],
    );
    await expectPostgresError(ownerQuery(pool,
      `INSERT INTO app.provider_connections (
         id, workspace_id, provider_id, provider_kind, environment,
         status, display_name, capabilities, created_by_user_id
       ) VALUES (
         $1, $2, 'public_social_dark_simulator', 'social', 'live',
         'active', 'Forbidden live simulator', '[]'::jsonb, $3
       )`,
      [randomUUID(), workspaceB, ownerB],
    ), '23514');

    const adapter = new CompanyContentService({
      transactionRunner: contentRunner(pool, 'r72_content_adapter'),
    });
    const approvals = new CompanyContentService({
      transactionRunner: contentRunner(pool, 'r72_content_command'),
    });
    const checkedAt = new Date(Date.now() - 30_000);
    const content = await adapter.createVersion(ownerContext, {
      commandKey: 'public-social-copy-v1',
      origin: 'generated',
      kind: 'social_post',
      title: 'Property Predator launch post',
      contentMimeType: 'text/plain',
      content: 'Test-only launch post. No provider can receive this content.',
      source: { system: 'fixture', itemId: 'public-social-copy', version: 'v1' },
      blob: { storageKey: 'fixtures/public-social-copy-v1', sha256: '33'.repeat(32) },
      brand: { snapshotRef: 'brand/property-predator-test', sha256: '44'.repeat(32) },
      attestation: {
        catalogSha256: '55'.repeat(32),
        checkedAt: checkedAt.toISOString(),
        expiresAt: new Date(checkedAt.getTime() + 10 * 60_000).toISOString(),
      },
    });
    const approvalRequest = await approvals.requestApproval(ownerContext, {
      commandKey: 'public-social-copy-approval-request-v1',
      contentItemId: content.contentItemId,
      contentVersionId: content.contentVersionId,
    });
    const approvalDecision = await approvals.decideApproval(ownerContext, {
      commandKey: 'public-social-copy-approval-decision-v1',
      approvalRequestId: approvalRequest.approvalRequestId,
      decision: 'approved',
    });
    const oversizedContent = await adapter.createVersion(ownerContext, {
      commandKey: 'public-social-copy-oversized-v1',
      origin: 'generated',
      kind: 'social_post',
      title: 'Unsupported oversized social post',
      contentMimeType: 'text/plain',
      content: 'x'.repeat(16_385),
      source: { system: 'fixture', itemId: 'public-social-copy-oversized', version: 'v1' },
      blob: { storageKey: 'fixtures/public-social-copy-oversized-v1', sha256: '66'.repeat(32) },
      brand: { snapshotRef: 'brand/property-predator-test', sha256: '77'.repeat(32) },
      attestation: {
        catalogSha256: '88'.repeat(32),
        checkedAt: checkedAt.toISOString(),
        expiresAt: new Date(checkedAt.getTime() + 10 * 60_000).toISOString(),
      },
    });
    const oversizedRequest = await approvals.requestApproval(ownerContext, {
      commandKey: 'public-social-copy-oversized-request-v1',
      contentItemId: oversizedContent.contentItemId,
      contentVersionId: oversizedContent.contentVersionId,
    });
    const oversizedDecision = await approvals.decideApproval(ownerContext, {
      commandKey: 'public-social-copy-oversized-decision-v1',
      approvalRequestId: oversizedRequest.approvalRequestId,
      decision: 'approved',
    });

    const revision = await scopedQuery<{
      campaign_id: string;
      revision_id: string;
      revision_number: number;
      disposition: string;
    }>(pool, 'r72_public_social_command', commandContext,
      `SELECT * FROM app_private.create_test_social_campaign_revision(
         $1, $2, $3, 1, NULL, 'Launch sprint',
         'Prove the dark simulator campaign rail', 'Europe/London', $4
       )`,
      [workspaceA, campaignId, revisionId, revisionHash],
    );
    assert.deepEqual(revision, [{
      campaign_id: campaignId,
      revision_id: revisionId,
      revision_number: 1,
      disposition: 'applied',
    }]);
    const revisionReplay = await scopedQuery<{ disposition: string }>(
      pool, 'r72_public_social_command', commandContext,
      `SELECT disposition FROM app_private.create_test_social_campaign_revision(
         $1, $2, $3, 1, NULL, 'Launch sprint',
         'Prove the dark simulator campaign rail', 'Europe/London', $4
       )`,
      [workspaceA, campaignId, revisionId, revisionHash],
    );
    assert.deepEqual(revisionReplay, [{ disposition: 'replayed' }]);
    await expectPostgresError(scopedQuery(
      pool, 'r72_public_social_command', commandContext,
      `SELECT * FROM app_private.create_test_social_campaign_revision(
         $1, $2, $3, 1, NULL, 'Forged revision',
         'Caller supplied a non-canonical hash', 'Europe/London', $4
       )`,
      [workspaceA, randomUUID(), randomUUID(), Buffer.from('99'.repeat(32), 'hex')],
    ), '22023');
    await expectPostgresError(scopedQuery(
      pool, 'r72_public_social_command', otherContext,
      `SELECT * FROM app_private.create_test_social_campaign_revision(
         $1, $2, $3, 1, NULL, 'Cross workspace',
         'Must fail before a fact is written', 'Europe/London', $4
       )`,
      [workspaceA, randomUUID(), randomUUID(), revisionHash],
    ), '42501');

    const target = await scopedQuery<{ target_id: string; disposition: string }>(
      pool, 'r72_public_social_command', commandContext,
      `SELECT * FROM app_private.register_test_social_campaign_target(
         $1, $2, $3, 'instagram', 'test-account:instagram:property_predator',
         'Property Predator TEST Instagram'
       )`,
      [workspaceA, targetId, connectionId],
    );
    assert.deepEqual(target, [{ target_id: targetId, disposition: 'applied' }]);
    await ownerQuery(pool,
      `UPDATE app.provider_connections
          SET status = 'disabled', updated_at = statement_timestamp(), row_version = row_version + 1
        WHERE workspace_id = $1 AND id = $2`,
      [workspaceA, connectionId],
    );
    const targetReplay = await scopedQuery<{ disposition: string }>(
      pool, 'r72_public_social_command', commandContext,
      `SELECT disposition FROM app_private.register_test_social_campaign_target(
         $1, $2, $3, 'instagram', 'test-account:instagram:property_predator',
         'Property Predator TEST Instagram'
       )`,
      [workspaceA, targetId, connectionId],
    );
    assert.deepEqual(targetReplay, [{ disposition: 'replayed' }]);
    await expectPostgresError(scopedQuery(
      pool, 'r72_public_social_command', commandContext,
      `SELECT * FROM app_private.register_test_social_campaign_target(
         $1, $2, $3, 'instagram', 'test-account:instagram:property_predator',
         'Changed TEST Instagram'
       )`,
      [workspaceA, targetId, connectionId],
    ), '23505');
    await ownerQuery(pool,
      `UPDATE app.provider_connections
          SET status = 'active', updated_at = statement_timestamp(), row_version = row_version + 1
        WHERE workspace_id = $1 AND id = $2`,
      [workspaceA, connectionId],
    );
    const resolvedTargets = await scopedQuery<{
      ordinal: number;
      target_id: string;
      network: string;
      test_account_ref: string;
    }>(pool, 'r72_public_social_command', commandContext,
      'SELECT * FROM app_private.resolve_test_social_campaign_targets($1, $2::uuid[])',
      [workspaceA, [targetId]],
    );
    assert.deepEqual(resolvedTargets, [{
      ordinal: 1,
      target_id: targetId,
      network: 'instagram',
      test_account_ref: 'test-account:instagram:property_predator',
    }]);
    await expectPostgresError(scopedQuery(
      pool, 'r72_public_social_command', otherContext,
      'SELECT * FROM app_private.resolve_test_social_campaign_targets($1, $2::uuid[])',
      [workspaceA, [targetId]],
    ), '42501');
    await expectPostgresError(scopedQuery(
      pool, 'r72_public_social_command', commandContext,
      `SELECT * FROM app_private.schedule_test_social_campaign(
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
         $11, 3::smallint, $12, $13::uuid[], '[]'::jsonb
       )`,
      [
        workspaceA, randomUUID(), campaignId, revisionId,
        content.contentItemId, content.contentVersionId,
        Buffer.from(content.contentSha256, 'hex'),
        approvalRequest.approvalRequestId, approvalDecision.approvalDecisionId,
        content.sourceAttestationId, new Date(Date.now() + 60 * 60_000),
        Buffer.from('ab'.repeat(32), 'hex'), [targetId],
      ],
    ), 'P0039');
    await expectPostgresError(scopedQuery(
      pool, 'r72_public_social_command', commandContext,
      `SELECT * FROM app_private.schedule_test_social_campaign(
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
         statement_timestamp(), 3::smallint, $11, $12::uuid[], '[]'::jsonb
       )`,
      [
        workspaceA, randomUUID(), campaignId, revisionId,
        oversizedContent.contentItemId, oversizedContent.contentVersionId,
        Buffer.from(oversizedContent.contentSha256, 'hex'),
        oversizedRequest.approvalRequestId, oversizedDecision.approvalDecisionId,
        oversizedContent.sourceAttestationId, Buffer.from('aa'.repeat(32), 'hex'),
        [targetId],
      ],
    ), '42501');
    await expectPostgresError(scopedQuery(
      pool, 'r72_public_social_command', commandContext,
      'SELECT count(*) FROM app.public_social_campaigns',
    ), '42501');

    const scheduledFor = new Date();
    const scheduleArgs = [
      workspaceA, postId, campaignId, revisionId,
      content.contentItemId, content.contentVersionId,
      Buffer.from(content.contentSha256, 'hex'),
      approvalRequest.approvalRequestId,
      approvalDecision.approvalDecisionId,
      content.sourceAttestationId,
      scheduledFor,
      planHash,
      [targetId],
    ] as const;
    const scheduled = await scopedQuery<{
      post_id: string;
      operation_ids: string[];
      disposition: string;
    }>(pool, 'r72_public_social_command', commandContext,
      `SELECT * FROM app_private.schedule_test_social_campaign(
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
         $11, 3::smallint, $12, $13::uuid[], '[]'::jsonb
       )`,
      [...scheduleArgs],
    );
    assert.equal(scheduled[0]?.post_id, postId);
    assert.equal(scheduled[0]?.operation_ids.length, 1);
    assert.equal(scheduled[0]?.disposition, 'applied');
    const operationId = scheduled[0]!.operation_ids[0]!;
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    await ownerQuery(pool,
      `UPDATE app.provider_connections
          SET status = 'disabled', updated_at = statement_timestamp(), row_version = row_version + 1
        WHERE workspace_id = $1 AND id = $2`,
      [workspaceA, connectionId],
    );
    const replayed = await scopedQuery<{ disposition: string }>(
      pool, 'r72_public_social_command', commandContext,
      `SELECT disposition FROM app_private.schedule_test_social_campaign(
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
         $11, 3::smallint, $12, $13::uuid[], '[]'::jsonb
       )`,
      [...scheduleArgs],
    );
    assert.deepEqual(replayed, [{ disposition: 'replayed' }]);
    await expectPostgresError(scopedQuery(
      pool, 'r72_public_social_command', commandContext,
      `SELECT * FROM app_private.schedule_test_social_campaign(
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
         $11, 3::smallint, $12, $13::uuid[], '[{}]'::jsonb
       )`,
      [...scheduleArgs],
    ), '23505');
    await ownerQuery(pool,
      `UPDATE app.provider_connections
          SET status = 'active', updated_at = statement_timestamp(), row_version = row_version + 1
        WHERE workspace_id = $1 AND id = $2`,
      [workspaceA, connectionId],
    );

    const claimed = await scopedQuery<{
      operation_id: string;
      workspace_id: string;
      attempt_number: number;
      lease_version: string;
      attempt_kind: string;
      test_reference: string | null;
    }>(pool, 'r72_public_social_worker_command', workerContext,
      `SELECT operation_id, workspace_id, attempt_number, lease_version,
              attempt_kind, test_reference
       FROM app_private.claim_due_test_social_targets($1, $2, 5, 60)`,
      [workerId, leaseHash],
    );
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0]?.operation_id, operationId);
    assert.equal(claimed[0]?.workspace_id, workspaceA);
    assert.equal(claimed[0]?.attempt_number, 1);
    assert.equal(claimed[0]?.attempt_kind, 'simulation');
    assert.equal(claimed[0]?.test_reference, null);
    const leaseVersion = BigInt(claimed[0]!.lease_version);

    const payload = await scopedQuery<{
      body_text: string;
      network: string;
      test_account_ref: string;
      content_sha256: Buffer;
    }>(pool, 'r72_public_social_worker_command', workerContext,
      `SELECT body_text, network, test_account_ref, content_sha256
       FROM app_private.load_test_social_dispatch_payload($1, $2, $3, $4, $5)`,
      [workspaceA, operationId, workerId, leaseHash, leaseVersion.toString()],
    );
    assert.deepEqual(payload.map((row) => [
      row.body_text,
      row.network,
      row.test_account_ref,
      row.content_sha256.toString('hex'),
    ]), [[
      'Test-only launch post. No provider can receive this content.',
      'instagram',
      'test-account:instagram:property_predator',
      content.contentSha256,
    ]]);
    const marked = await scopedQuery<{ marked: boolean }>(
      pool, 'r72_public_social_worker_command', workerContext,
      `SELECT app_private.mark_test_social_target_calling(
         $1, $2, $3, $4, $5
       ) AS marked`,
      [workspaceA, operationId, workerId, leaseHash, leaseVersion.toString()],
    );
    assert.deepEqual(marked, [{ marked: true }]);
    await expectPostgresError(scopedQuery(
      pool, 'r72_public_social_worker_command', workerContext,
      'SELECT app_private.renew_test_social_target_lease($1, $2, $3, $4, $5, 60)',
      [workspaceA, operationId, workerId, wrongLeaseHash, leaseVersion.toString()],
    ), '40001');
    await expectPostgresError(scopedQuery(
      pool, 'r72_public_social_worker_command', workerContext,
      `SELECT * FROM app_private.settle_test_social_target(
         $1, $2, $3, $4, $5, NULL, NULL, false,
         NULL, 'A NULL provider status must fail closed', statement_timestamp()
       )`,
      [workspaceA, operationId, workerId, leaseHash, leaseVersion.toString()],
    ), '22023');

    const testReference = `social_test_ref_${'66'.repeat(16)}`;
    const settled = await scopedQuery<{ operation_state: string; completed_at: Date | null }>(
      pool, 'r72_public_social_worker_command', workerContext,
      `SELECT * FROM app_private.settle_test_social_target(
         $1, $2, $3, $4, $5, 'failed', $6, true,
         'test_provider_retryable_failure',
         'TEST provider returned a stable reference with a failed result',
         statement_timestamp()
        )`,
      [workspaceA, operationId, workerId, leaseHash, leaseVersion.toString(), testReference],
    );
    assert.equal(settled[0]?.operation_state, 'reconciliation_required');
    assert.equal(settled[0]?.completed_at, null);
    await ownerQuery(pool,
      `UPDATE app.public_social_operations
       SET next_attempt_at = statement_timestamp(),
           updated_at = statement_timestamp(), row_version = row_version + 1
       WHERE workspace_id = $1 AND id = $2`,
      [workspaceA, operationId],
    );
    const mainReconcileLeaseHash = Buffer.from('e1'.repeat(32), 'hex');
    const [mainReconcileClaim] = await scopedQuery<{
      operation_id: string;
      lease_version: string;
      attempt_kind: string;
      test_reference: string | null;
    }>(pool, 'r72_public_social_worker_command', workerContext,
      `SELECT operation_id, lease_version, attempt_kind, test_reference
       FROM app_private.claim_due_test_social_targets($1, $2, 5, 60)`,
      [workerId, mainReconcileLeaseHash],
    );
    assert.deepEqual(mainReconcileClaim && [
      mainReconcileClaim.operation_id,
      mainReconcileClaim.attempt_kind,
      mainReconcileClaim.test_reference,
    ], [operationId, 'reconcile', testReference]);
    await scopedQuery(
      pool, 'r72_public_social_worker_command', workerContext,
      'SELECT app_private.mark_test_social_target_calling($1, $2, $3, $4, $5)',
      [
        workspaceA, operationId, workerId, mainReconcileLeaseHash,
        mainReconcileClaim!.lease_version,
      ],
    );
    const mainReconciled = await scopedQuery<{ operation_state: string }>(
      pool, 'r72_public_social_worker_command', workerContext,
      `SELECT operation_state FROM app_private.reconcile_test_social_target(
         $1, $2, $3, $4, $5, $6, statement_timestamp()
       )`,
      [
        workspaceA, operationId, workerId, mainReconcileLeaseHash,
        mainReconcileClaim!.lease_version, testReference,
      ],
    );
    assert.deepEqual(mainReconciled, [{ operation_state: 'simulated_reconciled' }]);
    const coherentReceipts = await ownerQuery<{
      source_kind: string;
      outcome: string;
    }>(pool,
      `SELECT source_kind, outcome
       FROM app.public_social_operation_receipts
       WHERE workspace_id = $1 AND operation_id = $2
       ORDER BY source_kind`,
      [workspaceA, operationId],
    );
    assert.deepEqual(coherentReceipts, [
      { source_kind: 'test_provider', outcome: 'simulated_failed' },
      { source_kind: 'worker_reconcile', outcome: 'simulated_reconciled' },
    ]);

    const cancelledPostId = randomUUID();
    const cancelledPlanHash = Buffer.from('77'.repeat(32), 'hex');
    const cancelledSchedule = await scopedQuery<{ operation_ids: string[] }>(
      pool, 'r72_public_social_command', commandContext,
      `SELECT operation_ids FROM app_private.schedule_test_social_campaign(
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
         statement_timestamp(), 2::smallint, $11, $12::uuid[], '[]'::jsonb
       )`,
      [
        workspaceA, cancelledPostId, campaignId, revisionId,
        content.contentItemId, content.contentVersionId,
        Buffer.from(content.contentSha256, 'hex'),
        approvalRequest.approvalRequestId, approvalDecision.approvalDecisionId,
        content.sourceAttestationId, cancelledPlanHash, [targetId],
      ],
    );
    const cancelledOperationId = cancelledSchedule[0]!.operation_ids[0]!;
    const cancelled = await scopedQuery<{ state: string; disposition: string }>(
      pool, 'r72_public_social_command', commandContext,
      `SELECT state, disposition
       FROM app_private.cancel_test_social_campaign_target($1, $2, $3)`,
      [workspaceA, cancelledOperationId, Buffer.from('88'.repeat(32), 'hex')],
    );
    assert.deepEqual(cancelled, [{
      state: 'simulated_cancelled',
      disposition: 'applied',
    }]);
    const cancellationReplay = await scopedQuery<{ state: string; disposition: string }>(
      pool, 'r72_public_social_command', commandContext,
      `SELECT state, disposition
       FROM app_private.cancel_test_social_campaign_target($1, $2, $3)`,
      [workspaceA, cancelledOperationId, Buffer.from('88'.repeat(32), 'hex')],
    );
    assert.deepEqual(cancellationReplay, [{
      state: 'simulated_cancelled',
      disposition: 'replayed',
    }]);
    await expectPostgresError(scopedQuery(
      pool, 'r72_public_social_command', commandContext,
      `SELECT * FROM app_private.cancel_test_social_campaign_target($1, $2, $3)`,
      [workspaceA, cancelledOperationId, Buffer.from('87'.repeat(32), 'hex')],
    ), '23505');

    const exhaustedPostId = randomUUID();
    const exhaustedSchedule = await scopedQuery<{ operation_ids: string[] }>(
      pool, 'r72_public_social_command', commandContext,
      `SELECT operation_ids FROM app_private.schedule_test_social_campaign(
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
         statement_timestamp(), 1::smallint, $11, $12::uuid[], '[]'::jsonb
       )`,
      [
        workspaceA, exhaustedPostId, campaignId, revisionId,
        content.contentItemId, content.contentVersionId,
        Buffer.from(content.contentSha256, 'hex'),
        approvalRequest.approvalRequestId, approvalDecision.approvalDecisionId,
        content.sourceAttestationId, Buffer.from('89'.repeat(32), 'hex'), [targetId],
      ],
    );
    const exhaustedOperationId = exhaustedSchedule[0]!.operation_ids[0]!;
    await ownerQuery(pool,
      `UPDATE app.public_social_operations
       SET reconciliation_count = max_attempts,
           updated_at = statement_timestamp(), row_version = row_version + 1
       WHERE workspace_id = $1 AND id = $2`,
      [workspaceA, exhaustedOperationId],
    );
    const exhaustedLeaseHash = Buffer.from('c3'.repeat(32), 'hex');
    const [exhaustedClaim] = await scopedQuery<{
      operation_id: string;
      lease_version: string;
      attempt_kind: string;
    }>(pool, 'r72_public_social_worker_command', workerContext,
      `SELECT operation_id, lease_version, attempt_kind
       FROM app_private.claim_due_test_social_targets($1, $2, 5, 60)`,
      [workerId, exhaustedLeaseHash],
    );
    assert.deepEqual(exhaustedClaim && [
      exhaustedClaim.operation_id, exhaustedClaim.attempt_kind,
    ], [exhaustedOperationId, 'simulation']);
    await scopedQuery(
      pool, 'r72_public_social_worker_command', workerContext,
      'SELECT app_private.mark_test_social_target_calling($1, $2, $3, $4, $5)',
      [
        workspaceA, exhaustedOperationId, workerId, exhaustedLeaseHash,
        exhaustedClaim!.lease_version,
      ],
    );
    const exhaustedAmbiguity = await scopedQuery<{
      operation_state: string;
      completed_at: Date | null;
    }>(pool, 'r72_public_social_worker_command', workerContext,
      `SELECT * FROM app_private.settle_test_social_target(
         $1, $2, $3, $4, $5, 'needs_attention', NULL, false,
         'ambiguous_test_provider_exception',
         'TEST provider outcome remained unknown after reconciliation exhaustion',
         statement_timestamp()
       )`,
      [
        workspaceA, exhaustedOperationId, workerId, exhaustedLeaseHash,
        exhaustedClaim!.lease_version,
      ],
    );
    assert.equal(exhaustedAmbiguity[0]?.operation_state, 'dead_letter');
    assert.ok(exhaustedAmbiguity[0]?.completed_at instanceof Date);

    const reconciliationPostId = randomUUID();
    const reconciliationPlanHash = Buffer.from('99'.repeat(32), 'hex');
    const reconciliationSchedule = await scopedQuery<{ operation_ids: string[] }>(
      pool, 'r72_public_social_command', commandContext,
      `SELECT operation_ids FROM app_private.schedule_test_social_campaign(
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
         statement_timestamp(), 1::smallint, $11, $12::uuid[], '[]'::jsonb
       )`,
      [
        workspaceA, reconciliationPostId, campaignId, revisionId,
        content.contentItemId, content.contentVersionId,
        Buffer.from(content.contentSha256, 'hex'),
        approvalRequest.approvalRequestId, approvalDecision.approvalDecisionId,
        content.sourceAttestationId, reconciliationPlanHash, [targetId],
      ],
    );
    const reconciliationOperationId = reconciliationSchedule[0]!.operation_ids[0]!;
    const firstReconcileLeaseHash = Buffer.from('a1'.repeat(32), 'hex');
    const firstReconcileClaim = await scopedQuery<{
      operation_id: string;
      lease_version: string;
      attempt_kind: string;
    }>(pool, 'r72_public_social_worker_command', workerContext,
      `SELECT operation_id, lease_version, attempt_kind
       FROM app_private.claim_due_test_social_targets($1, $2, 5, 60)`,
      [workerId, firstReconcileLeaseHash],
    );
    assert.deepEqual(firstReconcileClaim.map((row) => [
      row.operation_id,
      row.attempt_kind,
    ]), [[reconciliationOperationId, 'simulation']]);
    const firstReconcileLeaseVersion = firstReconcileClaim[0]!.lease_version;
    await scopedQuery(
      pool, 'r72_public_social_worker_command', workerContext,
      'SELECT app_private.mark_test_social_target_calling($1, $2, $3, $4, $5)',
      [
        workspaceA, reconciliationOperationId, workerId,
        firstReconcileLeaseHash, firstReconcileLeaseVersion,
      ],
    );
    // Model a process crash after crossing the call boundary but before any
    // provider result/reference was persisted. The next claim must sweep the
    // expired final simulation attempt into a reference-less reconciliation.
    await ownerQuery(pool,
      `UPDATE app.public_social_operations
       SET lease_expires_at = statement_timestamp() - interval '1 second',
           updated_at = statement_timestamp(), row_version = row_version + 1
       WHERE workspace_id = $1 AND id = $2`,
      [workspaceA, reconciliationOperationId],
    );
    const reconcileLeaseHash = Buffer.from('b2'.repeat(32), 'hex');
    const reconcileClaim = await scopedQuery<{
      operation_id: string;
      lease_version: string;
      attempt_kind: string;
      test_reference: string | null;
    }>(pool, 'r72_public_social_worker_command', workerContext,
      `SELECT operation_id, lease_version, attempt_kind, test_reference
       FROM app_private.claim_due_test_social_targets($1, $2, 5, 60)`,
      [workerId, reconcileLeaseHash],
    );
    assert.deepEqual(reconcileClaim.map((row) => [
      row.operation_id,
      row.attempt_kind,
      row.test_reference,
    ]), [[reconciliationOperationId, 'reconcile', null]]);
    const reconcileLeaseVersion = reconcileClaim[0]!.lease_version;
    await scopedQuery(
      pool, 'r72_public_social_worker_command', workerContext,
      'SELECT app_private.mark_test_social_target_calling($1, $2, $3, $4, $5)',
      [
        workspaceA, reconciliationOperationId, workerId,
        reconcileLeaseHash, reconcileLeaseVersion,
      ],
    );
    const reconciliationReference = `social_test_ref_${'aa'.repeat(16)}`;
    const reconciled = await scopedQuery<{ operation_state: string }>(
      pool, 'r72_public_social_worker_command', workerContext,
      `SELECT operation_state FROM app_private.reconcile_test_social_target(
         $1, $2, $3, $4, $5, $6, statement_timestamp()
       )`,
      [
        workspaceA, reconciliationOperationId, workerId,
        reconcileLeaseHash, reconcileLeaseVersion, reconciliationReference,
      ],
    );
    assert.deepEqual(reconciled, [{ operation_state: 'simulated_reconciled' }]);

    const campaign = await scopedQuery<{
      operation_state: string;
      test_reference_sha256: string;
    }>(pool, 'r72_web', commandContext,
      `SELECT operation_state, test_reference_sha256
       FROM app_private.list_social_campaign_command($1, $2, $3)`,
      [workspaceA, campaignId, 120],
    );
    assert.equal(campaign[0]?.operation_state, 'simulated_reconciled');
    assert.match(campaign[0]?.test_reference_sha256 ?? '', /^[a-f0-9]{64}$/);
    assert.notEqual(campaign[0]?.test_reference_sha256, testReference);
    await expectPostgresError(scopedQuery(
      pool, 'r72_web', otherContext,
      'SELECT * FROM app_private.list_social_campaign_command($1, $2, $3)',
      [workspaceA, campaignId, 120],
    ), '42501');
    await expectPostgresError(ownerQuery(pool,
      `UPDATE app.public_social_operation_receipts
       SET outcome = 'simulated_failed'
       WHERE workspace_id = $1 AND operation_id = $2`,
      [workspaceA, operationId],
    ), '55000');
    await expectPostgresError(ownerQuery(pool,
      `UPDATE app.public_social_operation_attempts
       SET safe_summary = 'forged history'
       WHERE workspace_id = $1 AND operation_id = $2`,
      [workspaceA, reconciliationOperationId],
    ), '55000');
    const evidenceCounts = await ownerQuery<{
      attempt_facts: string;
      receipt_facts: string;
    }>(pool,
      `SELECT
         (SELECT count(*)::text FROM app.public_social_operation_attempts
          WHERE workspace_id = $1 AND operation_id = $2) AS attempt_facts,
         (SELECT count(*)::text FROM app.public_social_operation_receipts
          WHERE workspace_id = $1) AS receipt_facts`,
      [workspaceA, reconciliationOperationId],
    );
    assert.deepEqual(evidenceCounts, [{ attempt_facts: '6', receipt_facts: '3' }]);
    const ready = await scopedQuery<{ ready: boolean }>(
      pool, 'r72_public_social_command', commandContext,
      'SELECT app_private.public_social_campaign_boundary_ready() AS ready',
    );
    assert.deepEqual(ready, [{ ready: true }]);
  } finally {
    await pool.end();
  }
});
