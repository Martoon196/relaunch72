import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Pool, QueryResultRow } from 'pg';
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

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function contentRunner(pool: Pool, role: 'r72_content_adapter' | 'r72_content_command'):
CompanyContentTransactionRunner {
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

async function revalidatorQuery<T extends QueryResultRow = QueryResultRow>(
  pool: Pool,
  workspaceId: string,
  sql: string,
  values: unknown[] = [],
): Promise<T[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE r72_public_social_revalidator_command');
    await client.query(
      `SELECT set_config('app.user_id', '', true),
              set_config('app.workspace_id', $1, true),
              set_config('app.actor_kind', 'worker', true),
              set_config('app.request_id', 'generated-social-db-proof', true)`,
      [workspaceId],
    );
    const result = await client.query<T>(sql, values);
    await client.query('COMMIT');
    return result.rows;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

test('generated and edited drafts use v2 while v1 stays inert and expired leases recover', {
  skip,
}, async () => {
  const pool = await openTestDatabase();
  const organizationId = randomUUID();
  const workspaceId = randomUUID();
  const ownerId = randomUUID();
  const connectionId = randomUUID();
  const campaignId = randomUUID();
  const revisionId = randomUUID();
  const targetId = randomUUID();
  const intentId = randomUUID();
  const recoveryIntentId = randomUUID();
  const malformedIntentId = randomUUID();
  const missingAncestorIntentId = randomUUID();
  const queueValidIntentId = randomUUID();
  const mediaDriftIntentId = randomUUID();
  const workerId = randomUUID();
  const leaseHash = Buffer.from('81'.repeat(32), 'hex');
  const brandSha256 = '82'.repeat(32);
  const sourceDraftId = randomUUID();
  const sourceVersionId = randomUUID();
  const sourceCatalogSha256 = Buffer.from('83'.repeat(32), 'hex');
  const ownerContext: DatabaseRequestContext = {
    actorKind: 'user', workspaceId, userId: ownerId,
    requestId: 'generated-social-content-owner',
  };
  const commandContext = {
    workspaceId, userId: ownerId, requestId: 'generated-social-command',
  };

  try {
    await resetIdentityTables(pool);
    await ownerQuery(pool,
      `INSERT INTO app.organizations (id, name, slug, kind, status)
       VALUES ($1, 'Generated social integration', $2, 'direct_customer', 'active')`,
      [organizationId, `generated-social-${organizationId.slice(0, 8)}`],
    );
    await ownerQuery(pool,
      `INSERT INTO app.users (id, email, status, email_verified_at)
       VALUES ($1, $2, 'active', statement_timestamp())`,
      [ownerId, `generated-social-${ownerId.slice(0, 8)}@example.test`],
    );
    await ownerQuery(pool,
      `INSERT INTO app.workspaces (id, organization_id, name, slug, status)
       VALUES ($1, $2, 'Generated social', $3, 'active')`,
      [workspaceId, organizationId, `generated-social-${workspaceId.slice(0, 8)}`],
    );
    await ownerQuery(pool,
      `INSERT INTO app.workspace_memberships (
         workspace_id, organization_id, user_id, role, status
       ) VALUES ($1, $2, $3, 'owner', 'active')`,
      [workspaceId, organizationId, ownerId],
    );
    await ownerQuery(pool,
      `INSERT INTO app.provider_connections (
         id, workspace_id, provider_id, provider_kind, environment,
         status, display_name, capabilities, created_by_user_id
       ) VALUES (
         $1, $2, 'public_social_dark_simulator', 'social', 'test',
         'active', 'Generated social dark simulator', '["social.publish"]'::jsonb, $3
       )`,
      [connectionId, workspaceId, ownerId],
    );

    const adapter = new CompanyContentService({
      transactionRunner: contentRunner(pool, 'r72_content_adapter'),
    });
    const approvals = new CompanyContentService({
      transactionRunner: contentRunner(pool, 'r72_content_command'),
    });
    const checkedAt = new Date(Date.now() - 5_000);
    const originalBody = JSON.stringify({
      body: 'Generated TEST social copy. No provider receives this fixture.',
      kind: 'post', platform: 'linkedin', title: 'Generated draft',
    });
    const originalSha256 = sha256(originalBody);
    const sourceEvidence = {
      schema: 'propertypredator.generated-draft-source/v1',
      sourceItemId: sourceDraftId,
      sourceDraftId,
      sourceVersionId,
      sourceItemVersion: 1,
      contentSha256: originalSha256,
      brandSha256,
      usageSha256: '84'.repeat(32),
      planSha256: '85'.repeat(32),
      generationContextSha256: '86'.repeat(32),
    } as const;
    const original = await adapter.createVersion(ownerContext, {
      commandKey: 'generated-social-original-v1',
      origin: 'generated',
      kind: 'social_post',
      title: 'Generated draft',
      contentMimeType: 'application/vnd.propertypredator.company-content+json',
      content: originalBody,
      source: {
        system: 'property_predator_generation',
        itemId: sourceDraftId,
        version: `${sourceVersionId}:v1`,
      },
      blob: {
        storageKey: `inline/property-predator/generated/${sourceVersionId}.json`,
        sha256: originalSha256,
      },
      brand: { snapshotRef: 'brand-brain:generated-social-proof', sha256: brandSha256 },
      attestation: {
        catalogSha256: '87'.repeat(32),
        checkedAt: checkedAt.toISOString(),
        expiresAt: new Date(checkedAt.getTime() + 10 * 60_000).toISOString(),
      },
      metadata: { source: sourceEvidence },
    });

    const editedBody = JSON.stringify({
      body: 'Edited TEST social copy. Still no provider effect.',
      kind: 'post', platform: 'linkedin', title: 'Exact reviewed draft',
    });
    const editedSha256 = sha256(editedBody);
    const edited = await adapter.createVersion(ownerContext, {
      commandKey: 'generated-social-edit-v2',
      contentItemId: original.contentItemId,
      previousVersionId: original.contentVersionId,
      origin: 'edited',
      kind: 'social_post',
      title: 'Exact reviewed draft',
      contentMimeType: 'application/vnd.propertypredator.company-content+json',
      content: editedBody,
      source: {
        system: 'property_predator_generation',
        itemId: sourceDraftId,
        version: `${sourceVersionId}:v1:edit:${editedSha256.slice(0, 16)}`,
      },
      blob: {
        storageKey: `inline/property-predator/generated/${sourceVersionId}-edit.json`,
        sha256: editedSha256,
      },
      brand: { snapshotRef: 'brand-brain:generated-social-proof', sha256: brandSha256 },
      attestation: {
        catalogSha256: '88'.repeat(32),
        checkedAt: checkedAt.toISOString(),
        expiresAt: new Date(checkedAt.getTime() + 10 * 60_000).toISOString(),
      },
      metadata: {
        source: sourceEvidence,
        editor: 'growth_hq_exact_review',
        previousContentVersionId: original.contentVersionId,
        previousContentSha256: original.contentSha256,
      },
    });
    const approvalRequest = await approvals.requestApproval(ownerContext, {
      commandKey: 'generated-social-edit-approval-request-v1',
      contentItemId: edited.contentItemId,
      contentVersionId: edited.contentVersionId,
    });
    const approvalDecision = await approvals.decideApproval(ownerContext, {
      commandKey: 'generated-social-edit-approval-decision-v1',
      approvalRequestId: approvalRequest.approvalRequestId,
      decision: 'approved',
    });

    const stageGenerated = async (
      suffix: string,
      sourceOverride: Readonly<Record<string, unknown>> = {},
    ) => {
      const draftId = randomUUID();
      const versionId = randomUUID();
      const body = JSON.stringify({ body: `Queue ${suffix}`, kind: 'post',
        platform: 'linkedin', title: `Queue ${suffix}` });
      const digest = sha256(body);
      const version = await adapter.createVersion(ownerContext, {
        commandKey: `generated-social-${suffix}`,
        origin: 'generated', kind: 'social_post', title: `Queue ${suffix}`,
        contentMimeType: 'application/vnd.propertypredator.company-content+json',
        content: body,
        source: { system: 'property_predator_generation', itemId: draftId,
          version: `${versionId}:v1` },
        blob: { storageKey: `inline/property-predator/generated/${versionId}.json`, sha256: digest },
        brand: { snapshotRef: 'brand-brain:generated-social-proof', sha256: brandSha256 },
        attestation: { catalogSha256: sha256(`catalog-${suffix}`),
          checkedAt: checkedAt.toISOString(),
          expiresAt: new Date(checkedAt.getTime() + 10 * 60_000).toISOString() },
        metadata: { source: { ...sourceEvidence, sourceItemId: draftId,
          sourceDraftId: draftId, sourceVersionId: versionId,
          contentSha256: digest, ...sourceOverride } },
      });
      const request = await approvals.requestApproval(ownerContext, {
        commandKey: `generated-social-${suffix}-request`, contentItemId: version.contentItemId,
        contentVersionId: version.contentVersionId,
      });
      await approvals.decideApproval(ownerContext, {
        commandKey: `generated-social-${suffix}-decision`,
        approvalRequestId: request.approvalRequestId, decision: 'approved',
      });
      return { ...version, draftId, versionId, digest };
    };
    const malformedQueue = await stageGenerated('malformed-queue', {
      sourceDraftId: 'not-a-uuid', sourceItemVersion: 'not-an-integer',
    });
    const missingAncestorQueue = await stageGenerated('missing-ancestor-queue', {
      schema: 'propertypredator.generated-draft-source/unsupported',
    });
    const validQueue = await stageGenerated('valid-queue');

    const mediaResourceVersionId = randomUUID();
    const mediaSourceApprovalId = randomUUID();
    const mediaSourceItemId = `media:${randomUUID()}`;
    const mediaApprovedAt = new Date(checkedAt.getTime() - 1_000);
    const mediaBody = JSON.stringify({ alt: 'TEST-only media fixture' });
    const media = await adapter.createVersion(ownerContext, {
      commandKey: 'generated-social-media-v1', origin: 'imported', kind: 'image',
      title: 'TEST-only media fixture', contentMimeType: 'image/png', content: mediaBody,
      source: { system: 'propertypredator.company-content',
        itemId: mediaSourceItemId, version: '1' },
      blob: { storageKey: `property-predator/test/${randomUUID()}.png`, sha256: '94'.repeat(32) },
      brand: { snapshotRef: 'brand-brain:generated-social-proof', sha256: brandSha256 },
      attestation: { catalogSha256: '95'.repeat(32), checkedAt: checkedAt.toISOString(),
        expiresAt: new Date(checkedAt.getTime() + 10 * 60_000).toISOString() },
      metadata: { sourceVersionId: mediaResourceVersionId,
        sourceApprovalId: mediaSourceApprovalId, sourceApprovedAt: mediaApprovedAt.toISOString() },
    });
    const mediaApprovalRequest = await approvals.requestApproval(ownerContext, {
      commandKey: 'generated-social-media-request-v1', contentItemId: media.contentItemId,
      contentVersionId: media.contentVersionId,
    });
    await approvals.decideApproval(ownerContext, {
      commandKey: 'generated-social-media-decision-v1',
      approvalRequestId: mediaApprovalRequest.approvalRequestId, decision: 'approved',
    });

    const revisionSha256 = Buffer.from(socialCampaignRevisionSha256({
      workspaceId,
      campaignId,
      revisionId,
      revisionNumber: 1,
      previousRevisionId: null,
      title: 'Generated scheduling proof',
      objective: 'Prove generated drafts remain inside the TEST rail',
      timezone: 'Europe/London',
    }), 'hex');
    await scopedQuery(pool, 'r72_public_social_command', commandContext,
      `SELECT * FROM app_private.create_test_social_campaign_revision(
         $1, $2, $3, 1, NULL, 'Generated scheduling proof',
         'Prove generated drafts remain inside the TEST rail', 'Europe/London', $4
       )`,
      [workspaceId, campaignId, revisionId, revisionSha256],
    );
    await scopedQuery(pool, 'r72_public_social_command', commandContext,
      `SELECT * FROM app_private.register_test_social_campaign_target(
         $1, $2, $3, 'linkedin', 'test-account:linkedin:property_predator',
         'Property Predator TEST LinkedIn'
       )`,
      [workspaceId, targetId, connectionId],
    );

    const desiredFor = new Date(Date.now() + 30_000);
    const createIntent = async (id: string, contentVersionId = edited.contentVersionId,
      mediaVersionIds: string[] = []): Promise<void> => {
      const planned = await scopedQuery<{ disposition: string }>(
        pool, 'r72_public_social_command', commandContext,
        `SELECT disposition FROM app_private.create_test_social_planning_intent(
           $1, $2, $3, $4, $5, $6, 3::smallint, $7::uuid[], $8::uuid[]
         )`,
        [workspaceId, id, campaignId, revisionId, contentVersionId, desiredFor,
          [targetId], mediaVersionIds],
      );
      assert.deepEqual(planned, [{ disposition: 'applied' }]);
    };

    await expectPostgresError(
      createIntent(malformedIntentId, malformedQueue.contentVersionId), '42501',
    );
    await expectPostgresError(
      createIntent(missingAncestorIntentId, missingAncestorQueue.contentVersionId), '42501',
    );
    await createIntent(queueValidIntentId, validQueue.contentVersionId);
    await ownerQuery(pool,
      `UPDATE app.public_social_revalidation_jobs job
          SET next_attempt_at = statement_timestamp() - interval '1 minute'
        FROM app.public_social_planning_intents intent
        WHERE intent.workspace_id = job.workspace_id AND intent.id = job.intent_id
          AND intent.id = $1`,
      [queueValidIntentId],
    );
    const queueClaim = await revalidatorQuery<{ intent_id: string; job_id: string }>(
      pool, workspaceId,
      'SELECT * FROM app_private.claim_due_test_social_revalidations_v2($1, $2, 10, 60)',
      [randomUUID(), Buffer.from('96'.repeat(32), 'hex')],
    );
    assert.deepEqual(queueClaim.map((row) => row.intent_id), [queueValidIntentId]);
    await ownerQuery(pool,
      `UPDATE app.public_social_revalidation_jobs SET state = 'dead_letter',
          lease_token_hash = NULL, lease_worker_id = NULL, lease_expires_at = NULL,
          completed_at = statement_timestamp()
        WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, queueClaim[0]!.job_id],
    );
    await createIntent(intentId);

    const legacyClaim = await revalidatorQuery(
      pool, workspaceId,
      'SELECT * FROM app_private.claim_due_test_social_revalidations($1, $2, 10, 60)',
      [randomUUID(), Buffer.from('89'.repeat(32), 'hex')],
    );
    assert.deepEqual(legacyClaim, []);
    const untouched = await ownerQuery<{ state: string; attempt_count: number; lease_version: string }>(
      pool,
      `SELECT state, attempt_count, lease_version::text
         FROM app.public_social_revalidation_jobs
        WHERE workspace_id = $1 AND intent_id = $2`,
      [workspaceId, intentId],
    );
    assert.deepEqual(untouched, [{
      state: 'waiting_for_window', attempt_count: 0, lease_version: '0',
    }]);

    const claimed = await revalidatorQuery<{
      job_id: string;
      lease_version: string;
      evidence_type: string;
      generated_source_item_id: string;
      generated_source_version_id: string;
      generated_source_item_version: number;
      generated_content_sha256: string;
      generated_brand_sha256: string;
      content_sha256: string;
      generated_lineage: unknown[];
    }>(pool, workspaceId,
      'SELECT * FROM app_private.claim_due_test_social_revalidations_v2($1, $2, 10, 60)',
      [workerId, leaseHash],
    );
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0]?.evidence_type, 'generated');
    assert.equal(claimed[0]?.generated_source_item_id, sourceDraftId);
    assert.equal(claimed[0]?.generated_source_version_id, sourceVersionId);
    assert.equal(claimed[0]?.generated_source_item_version, 1);
    assert.equal(claimed[0]?.generated_content_sha256, originalSha256);
    assert.equal(claimed[0]?.generated_brand_sha256, brandSha256);
    assert.equal(claimed[0]?.content_sha256, editedSha256);
    assert.equal(claimed[0]?.generated_lineage.length, 2);
    const jobId = claimed[0]!.job_id;
    const leaseVersion = Number(claimed[0]!.lease_version);

    const loaded = await revalidatorQuery<{
      resource_ordinal: number;
      evidence_type: string;
      generated_source_item_id: string;
      generated_source_version_id: string;
      generated_content_sha256: string;
      content_sha256: string;
    }>(pool, workspaceId,
      `SELECT * FROM app_private.load_leased_test_social_source_versions_v2(
         $1, $2, $3, $4
       )`,
      [jobId, workerId, leaseHash, leaseVersion],
    );
    assert.deepEqual(loaded.map((row) => ({
      ordinal: row.resource_ordinal,
      evidence: row.evidence_type,
      sourceItem: row.generated_source_item_id,
      sourceVersion: row.generated_source_version_id,
      generatedSha: row.generated_content_sha256,
      currentSha: row.content_sha256,
    })), [{
      ordinal: 0,
      evidence: 'generated',
      sourceItem: sourceDraftId,
      sourceVersion: sourceVersionId,
      generatedSha: originalSha256,
      currentSha: editedSha256,
    }]);

    const completionSql = `SELECT * FROM app_private.complete_and_materialize_test_social_revalidation_v2(
      $1::uuid, $2::uuid, $3::uuid, $4::bytea, $5::bigint, $6::uuid, $7::uuid,
      $8::uuid, NULL::uuid, NULL::timestamptz,
      ARRAY[]::uuid[], ARRAY[]::uuid[], ARRAY[]::timestamptz[],
      $9::bytea, $10::timestamptz, $11::timestamptz,
      'generated', $12::uuid, $13::uuid, 1, $14::bytea, $15::bytea
    )`;
    const proofId = randomUUID();
    const postId = randomUUID();
    const proofCheckedAt = new Date();
    const proofExpiresAt = new Date(proofCheckedAt.getTime() + 10 * 60_000);
    const baseCompletionValues = [
      workspaceId, jobId, workerId, leaseHash, leaseVersion, proofId, postId,
    ];
    await expectPostgresError(revalidatorQuery(
      pool, workspaceId, completionSql,
      [
        ...baseCompletionValues, randomUUID(), sourceCatalogSha256,
        proofCheckedAt, proofExpiresAt, sourceDraftId, sourceVersionId,
        Buffer.from(originalSha256, 'hex'), Buffer.from(brandSha256, 'hex'),
      ],
    ), '22023');
    await expectPostgresError(revalidatorQuery(
      pool, workspaceId, completionSql,
      [
        ...baseCompletionValues, null, sourceCatalogSha256,
        proofCheckedAt, proofExpiresAt, sourceDraftId, sourceVersionId,
        Buffer.from('90'.repeat(32), 'hex'), Buffer.from(brandSha256, 'hex'),
      ],
    ), '42501');
    const completed = await revalidatorQuery<{
      proof_id: string;
      post_id: string;
      operation_ids: string[];
      disposition: string;
    }>(pool, workspaceId, completionSql,
      [
        ...baseCompletionValues, null, sourceCatalogSha256,
        proofCheckedAt, proofExpiresAt, sourceDraftId, sourceVersionId,
        Buffer.from(originalSha256, 'hex'), Buffer.from(brandSha256, 'hex'),
      ],
    );
    assert.equal(completed[0]?.proof_id, proofId);
    assert.equal(completed[0]?.post_id, postId);
    assert.equal(completed[0]?.operation_ids.length, 1);
    assert.equal(completed[0]?.disposition, 'applied');
    const persisted = await ownerQuery<{
      state: string;
      evidence_type: string;
      source_resource_version_id: string | null;
      generated_source_item_id: string;
      generated_source_version_id: string;
    }>(pool,
      `SELECT job.state, proof.evidence_type, proof.source_resource_version_id,
              proof.generated_source_item_id, proof.generated_source_version_id
         FROM app.public_social_revalidation_jobs job
         JOIN app.public_social_revalidation_proofs proof
           ON proof.workspace_id = job.workspace_id AND proof.id = job.current_proof_id
        WHERE job.workspace_id = $1 AND job.id = $2`,
      [workspaceId, jobId],
    );
    assert.deepEqual(persisted, [{
      state: 'materialized',
      evidence_type: 'generated',
      source_resource_version_id: null,
      generated_source_item_id: sourceDraftId,
      generated_source_version_id: sourceVersionId,
    }]);

    await createIntent(mediaDriftIntentId, validQueue.contentVersionId,
      [media.contentVersionId]);
    const mediaWorkerId = randomUUID();
    const mediaLeaseHash = Buffer.from('97'.repeat(32), 'hex');
    const mediaClaim = await revalidatorQuery<{ job_id: string; lease_version: string }>(
      pool, workspaceId,
      'SELECT * FROM app_private.claim_due_test_social_revalidations_v2($1, $2, 1, 60)',
      [mediaWorkerId, mediaLeaseHash],
    );
    assert.equal(mediaClaim.length, 1);
    const newerMediaBody = JSON.stringify({ alt: 'Newer TEST-only media fixture' });
    await adapter.createVersion(ownerContext, {
      commandKey: 'generated-social-media-v2', contentItemId: media.contentItemId,
      previousVersionId: media.contentVersionId, origin: 'imported', kind: 'image',
      title: 'Newer TEST-only media fixture', contentMimeType: 'image/png',
      content: newerMediaBody,
      source: { system: 'propertypredator.company-content',
        itemId: mediaSourceItemId, version: '2' },
      blob: { storageKey: `property-predator/test/${randomUUID()}.png`, sha256: '98'.repeat(32) },
      brand: { snapshotRef: 'brand-brain:generated-social-proof', sha256: brandSha256 },
      attestation: { catalogSha256: '99'.repeat(32), checkedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() },
      metadata: { sourceVersionId: randomUUID(), sourceApprovalId: randomUUID(),
        sourceApprovedAt: new Date().toISOString() },
    });
    const mediaCompletionSql = `SELECT * FROM app_private.complete_and_materialize_test_social_revalidation_v2(
      $1::uuid, $2::uuid, $3::uuid, $4::bytea, $5::bigint, $6::uuid, $7::uuid,
      NULL::uuid, NULL::uuid, NULL::timestamptz,
      ARRAY[$8::uuid], ARRAY[$9::uuid], ARRAY[$10::timestamptz],
      $11::bytea, $12::timestamptz, $13::timestamptz,
      'generated', $14::uuid, $15::uuid, 1, $16::bytea, $17::bytea
    )`;
    const mediaProofCheckedAt = new Date();
    await expectPostgresError(revalidatorQuery(pool, workspaceId, mediaCompletionSql, [
      workspaceId, mediaClaim[0]!.job_id, mediaWorkerId, mediaLeaseHash,
      Number(mediaClaim[0]!.lease_version), randomUUID(), randomUUID(),
      mediaResourceVersionId, mediaSourceApprovalId, mediaApprovedAt,
      sourceCatalogSha256, mediaProofCheckedAt,
      new Date(mediaProofCheckedAt.getTime() + 10 * 60_000),
      validQueue.draftId, validQueue.versionId,
      Buffer.from(validQueue.digest, 'hex'), Buffer.from(brandSha256, 'hex'),
    ]), '42501');

    await createIntent(recoveryIntentId);
    const recoveryJob = await ownerQuery<{ id: string }>(pool,
      `UPDATE app.public_social_revalidation_jobs
          SET state = 'leased', attempt_count = 1, lease_token_hash = $3,
              lease_worker_id = $4, lease_expires_at = statement_timestamp() - interval '1 second',
              lease_version = 1, updated_at = statement_timestamp(), row_version = row_version + 1
        WHERE workspace_id = $1 AND intent_id = $2
        RETURNING id`,
      [workspaceId, recoveryIntentId, Buffer.from('91'.repeat(32), 'hex'), randomUUID()],
    );
    assert.equal(recoveryJob.length, 1);
    assert.deepEqual(await revalidatorQuery(
      pool, workspaceId,
      'SELECT * FROM app_private.claim_due_test_social_revalidations($1, $2, 10, 60)',
      [randomUUID(), Buffer.from('92'.repeat(32), 'hex')],
    ), []);
    const afterV1 = await ownerQuery<{ state: string; attempt_count: number }>(pool,
      `SELECT state, attempt_count FROM app.public_social_revalidation_jobs
        WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, recoveryJob[0]!.id],
    );
    assert.deepEqual(afterV1, [{ state: 'leased', attempt_count: 1 }]);

    assert.deepEqual(await revalidatorQuery(
      pool, workspaceId,
      'SELECT * FROM app_private.claim_due_test_social_revalidations_v2($1, $2, 10, 60)',
      [randomUUID(), Buffer.from('93'.repeat(32), 'hex')],
    ), []);
    const recovered = await ownerQuery<{
      state: string;
      attempt_count: number;
      last_error_code: string;
    }>(pool,
      `SELECT state, attempt_count, last_error_code
         FROM app.public_social_revalidation_jobs
        WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, recoveryJob[0]!.id],
    );
    assert.deepEqual(recovered, [{
      state: 'retry_wait', attempt_count: 1,
      last_error_code: 'revalidation.lease_expired',
    }]);

    const grants = await ownerQuery<{
      runtime_can_claim: boolean;
      runtime_can_load: boolean;
      runtime_can_complete: boolean;
      runtime_can_complete_internal: boolean;
    }>(pool,
      `SELECT
         has_function_privilege('r72_public_social_revalidator_command',
           'app_private.claim_due_test_social_revalidations_v2(uuid,bytea,integer,integer)', 'EXECUTE') AS runtime_can_claim,
         has_function_privilege('r72_public_social_revalidator_command',
           'app_private.load_leased_test_social_source_versions_v2(uuid,uuid,bytea,bigint)', 'EXECUTE') AS runtime_can_load,
         has_function_privilege('r72_public_social_revalidator_command',
           'app_private.complete_and_materialize_test_social_revalidation_v2(uuid,uuid,uuid,bytea,bigint,uuid,uuid,uuid,uuid,timestamptz,uuid[],uuid[],timestamptz[],bytea,timestamptz,timestamptz,text,uuid,uuid,integer,bytea,bytea)', 'EXECUTE') AS runtime_can_complete,
         has_function_privilege('r72_public_social_revalidator_command',
           'app_private.complete_test_social_revalidation_v2(uuid,uuid,uuid,bytea,bigint,uuid,uuid,uuid,timestamptz,uuid[],uuid[],timestamptz[],bytea,timestamptz,timestamptz,text,uuid,uuid,integer,bytea,bytea)', 'EXECUTE') AS runtime_can_complete_internal`,
    );
    assert.deepEqual(grants, [{
      runtime_can_claim: true,
      runtime_can_load: true,
      runtime_can_complete: true,
      runtime_can_complete_internal: false,
    }]);
  } finally {
    await pool.end();
  }
});
