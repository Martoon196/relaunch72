import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { Pool } from 'pg';
import type { SqlExecutor } from '../../src/crm-pg/types.js';
import type { DatabaseRequestContext } from '../../src/db/rls.js';
import {
  CompanyAssetConflictError,
  CompanyAssetService,
  type CompanyAssetTransactionRunner,
} from '../../src/company-asset-pg/index.js';
import {
  COMPANY_ASSET_RELEASE_ID,
  PROPERTY_PREDATOR_GROWTH_HQ_BRIDGE_CONTRACT,
  companyAssetReleaseScopeSha256,
  parseCompanyAssetReleaseBridge,
} from '../../src/company-asset-release/domain.js';
import {
  COMPANY_ASSET_EVAL_DIMENSIONS,
  COMPANY_ASSET_EVAL_RUNNER,
} from '../../src/company-asset-release/evaluation.js';
import {
  PROPERTY_PREDATOR_AI_RUNTIME_BRAND_V1_SHA256,
  canonicalPropertyPredatorAiInventoryJson,
} from '../../src/company-content-adapter/property-predator-ai-inventory.js';
import {
  expectPostgresError,
  openTestDatabase,
  ownerQuery,
  resetIdentityTables,
  testDatabaseSkipReason,
} from './database-helper.js';

const skip = testDatabaseSkipReason();
const manifestUrl = new URL('../fixtures/property-predator-ai-inventory-v1.golden.json', import.meta.url);
const CONTENT_SHA = '12'.repeat(32);
const BLOB_SHA = '23'.repeat(32);
const CATALOG_SHA = '34'.repeat(32);
const VERSION_ID = '20000000-0000-4000-8000-000000000001';
type Mutable = Record<string, any>;
type ContentRole = 'r72_content_adapter' | 'r72_content_command';

function runner(pool: Pool, role: ContentRole): CompanyAssetTransactionRunner {
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

async function scopedRoleQuery(
  pool: Pool,
  role: ContentRole | 'r72_web',
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

function canonicalSha256(value: unknown): string {
  return createHash('sha256')
    .update(canonicalPropertyPredatorAiInventoryJson(value), 'utf8')
    .digest('hex');
}

async function releaseEnvelope(): Promise<Mutable> {
  const release = {
    approvedItemCount: 1,
    approvedItems: [{
      affiliateMode: 'forbidden', approvalExpiresAt: null,
      approvalExpiryStatus: 'missing', approvalId: 'fictional-source-approval-db-1',
      approvedAt: '2026-08-27T09:10:00Z',
      assetResourcePath: `/api/internal/company-content/assets/${VERSION_ID}/file`,
      blobSha256: BLOB_SHA, brandSha256: PROPERTY_PREDATOR_AI_RUNTIME_BRAND_V1_SHA256,
      contentMode: 'company-owned',
      contentResourcePath: `/api/internal/company-content/versions/${VERSION_ID}`,
      contentSha256: CONTENT_SHA, hqUseStatus: 'review-required',
      itemId: 'asset:fictional-db-card', itemType: 'asset', itemVersion: 1,
      ownershipStatus: 'source-asserted-company-owned',
      privacyStatus: 'customer-private-data-forbidden',
      quarantineStatus: 'not-recorded-at-source',
      sourceApprovalStatus: 'source-approved-exact-version', versionId: VERSION_ID,
    }],
    brandBrain: {
      hqUseStatus: 'review-required',
      manifest: JSON.parse(await readFile(manifestUrl, 'utf8')) as unknown,
      runtimeBrandSha256: PROPERTY_PREDATOR_AI_RUNTIME_BRAND_V1_SHA256,
      sourceApprovalStatus: 'source-current',
    },
    contract: JSON.parse(JSON.stringify(PROPERTY_PREDATOR_GROWTH_HQ_BRIDGE_CONTRACT)),
    releaseId: COMPANY_ASSET_RELEASE_ID,
    sourceCatalogSha256: CATALOG_SHA,
    sourceSystem: 'property-predator',
  };
  return {
    generatedAt: '2026-08-27T09:12:00Z', release,
    releaseSha256: canonicalSha256(release), schemaVersion: 1,
  };
}

function founderApproval(
  release: ReturnType<typeof parseCompanyAssetReleaseBridge>,
  approvedAt: string,
  expiresAt: string,
): Mutable {
  return {
    approvalAuthority: 'growth_hq_founder', approvalExpiresAt: expiresAt,
    approvalId: 'fictional-founder-db-approval-1', approvalStatus: 'founder_approved',
    approvedAt, hqHumanApproval: true, schemaVersion: 1,
    scope: JSON.parse(JSON.stringify(release.scope)), scopeSha256: release.scopeSha256,
  };
}

function evalSuite(release: ReturnType<typeof parseCompanyAssetReleaseBridge>): Mutable {
  const reasons = {
    brand: { accept: 'brand_style_match', reject: 'brand_style_violation' },
    avatar: { accept: 'avatar_fit_match', reject: 'avatar_fit_violation' },
    claims: { accept: 'claims_supported', reject: 'claims_unsubstantiated' },
    disclosure: { accept: 'disclosure_present', reject: 'disclosure_missing' },
    visual_policy: { accept: 'visual_policy_match', reject: 'visual_policy_conflict' },
  } as const;
  return {
    brandBrainPackageSha256: release.scope.brandBrainPackageSha256,
    cases: COMPANY_ASSET_EVAL_DIMENSIONS.flatMap((dimension) => ([
      {
        caseId: `a-${dimension}-golden`, caseKind: 'golden', dimension,
        inputSha256: '45'.repeat(32), outputSha256: '56'.repeat(32),
        evidenceSha256: '67'.repeat(32), expectedDisposition: 'accept',
        observedDisposition: 'accept', reasonCode: reasons[dimension].accept,
      },
      {
        caseId: `b-${dimension}-rejected`, caseKind: 'rejected', dimension,
        inputSha256: '78'.repeat(32), outputSha256: '89'.repeat(32),
        evidenceSha256: '9a'.repeat(32), expectedDisposition: 'reject',
        observedDisposition: 'reject', reasonCode: reasons[dimension].reject,
      },
    ])).sort((left, right) => left.caseId.localeCompare(right.caseId)),
    runnerVersion: COMPANY_ASSET_EVAL_RUNNER, schemaVersion: 1,
    sourceReleaseSha256: release.releaseSha256,
    sourceScopeSha256: release.scopeSha256,
    suiteId: 'fictional-company-assets-db-v1',
  };
}

test('company asset persistence is replay-safe, exact-tuple gated, dark and role isolated', {
  skip,
}, async () => {
  const pool = await openTestDatabase();
  const organizationId = randomUUID();
  const workspaceA = randomUUID();
  const workspaceB = randomUUID();
  const ownerA = randomUUID();
  const ownerB = randomUUID();
  const viewerA = randomUUID();
  const contextA: DatabaseRequestContext = {
    actorKind: 'user', workspaceId: workspaceA, userId: ownerA,
    requestId: 'fictional-company-asset-a',
  };
  const contextB: DatabaseRequestContext = {
    actorKind: 'user', workspaceId: workspaceB, userId: ownerB,
    requestId: 'fictional-company-asset-b',
  };
  const viewerContext: DatabaseRequestContext = {
    actorKind: 'user', workspaceId: workspaceA, userId: viewerA,
    requestId: 'fictional-company-asset-viewer',
  };
  try {
    await resetIdentityTables(pool);
    const suffix = organizationId.replaceAll('-', '').slice(0, 10);
    await ownerQuery(pool,
      `INSERT INTO app.organizations (id, name, slug, kind, status)
       VALUES ($1, 'Fictional company asset integration', $2, 'direct_customer', 'active')`,
      [organizationId, `fictional-company-asset-${suffix}`]);
    await ownerQuery(pool,
      `INSERT INTO app.users (id, email, status, email_verified_at) VALUES
         ($1, $2, 'active', statement_timestamp()),
         ($3, $4, 'active', statement_timestamp()),
         ($5, $6, 'active', statement_timestamp())`,
      [ownerA, `fictional-owner-a-${suffix}@example.test`,
        ownerB, `fictional-owner-b-${suffix}@example.test`,
        viewerA, `fictional-viewer-${suffix}@example.test`]);
    await ownerQuery(pool,
      `INSERT INTO app.workspaces (id, organization_id, name, slug, status) VALUES
         ($1, $2, 'Fictional Assets A', $3, 'active'),
         ($4, $2, 'Fictional Assets B', $5, 'active')`,
      [workspaceA, organizationId, `fictional-assets-a-${suffix}`,
        workspaceB, `fictional-assets-b-${suffix}`]);
    await ownerQuery(pool,
      `INSERT INTO app.workspace_memberships (
         workspace_id, organization_id, user_id, role, status
       ) VALUES
         ($1, $2, $3, 'owner', 'active'),
         ($4, $2, $5, 'owner', 'active'),
         ($1, $2, $6, 'viewer', 'active')`,
      [workspaceA, organizationId, ownerA, workspaceB, ownerB, viewerA]);

    const rawRelease = await releaseEnvelope();
    const release = parseCompanyAssetReleaseBridge(rawRelease);
    const checkedAt = new Date(Date.now() - 1_000);
    const adapter = new CompanyAssetService({
      transactionRunner: runner(pool, 'r72_content_adapter'), now: () => new Date(),
    });
    const command = new CompanyAssetService({
      transactionRunner: runner(pool, 'r72_content_command'), now: () => new Date(),
    });
    const stageCommand = {
      commandKey: 'fictional-stage-db-1', releaseEnvelope: rawRelease,
      checkedAt: checkedAt.toISOString(),
      expiresAt: new Date(checkedAt.getTime() + 10 * 60_000).toISOString(),
    };
    const staged = await adapter.stageRelease(contextA, stageCommand);
    const replay = await adapter.stageRelease(contextA, stageCommand);
    assert.equal(staged.disposition, 'applied');
    assert.equal(replay.disposition, 'replayed');
    assert.equal(replay.sourceReleaseId, staged.sourceReleaseId);
    assert.equal(replay.sourceAttestationId, staged.sourceAttestationId);
    assert.equal(staged.usable, false);

    const evaluation = await adapter.recordEvaluation(contextA, {
      commandKey: 'fictional-eval-db-1', evaluationSuite: evalSuite(release),
    });
    assert.equal(evaluation.passed, true);
    const approvalNow = new Date();
    const approval = founderApproval(
      release,
      new Date(approvalNow.getTime() - 1_000).toISOString(),
      new Date(approvalNow.getTime() + 60 * 60_000).toISOString(),
    );
    const approved = await command.approveScope(contextA, {
      commandKey: 'fictional-approve-db-1', founderApproval: approval,
    });
    assert.equal(approved.scopeSha256, release.scopeSha256);

    for (const decision of [
      { dimension: 'visual_policy', outcome: 'clear', reasonCode: 'visual_policy_match' },
      { dimension: 'claim', outcome: 'clear', reasonCode: 'no_claims_present' },
      { dimension: 'asset', outcome: 'clear', reasonCode: 'asset_integrity_verified' },
    ] as const) {
      await command.decideQuarantine(contextA, {
        commandKey: `fictional-${decision.dimension}-db-1`,
        sourceReleaseId: staged.sourceReleaseId,
        itemType: 'asset', itemId: 'asset:fictional-db-card',
        ...decision, evidenceSha256: 'ab'.repeat(32),
      });
    }

    const reconciled = await adapter.reconcile(contextA, {
      commandKey: 'fictional-reconcile-db-1', releaseEnvelope: rawRelease,
      founderApproval: approval, evaluationReportSha256: evaluation.reportSha256,
      evaluatedAt: new Date().toISOString(),
    });
    assert.equal(reconciled.status, 'reconciled');
    assert.equal(reconciled.usable, false);
    assert.deepEqual(reconciled.usabilityReasonCodes, [
      'source_approval_expiry_missing', 'source_quarantine_unknown',
    ]);
    assert.deepEqual(reconciled.guardReasonCodes, []);
    assert.equal(reconciled.providerEffects, false);
    assert.equal(reconciled.modelCalls, false);
    assert.equal(reconciled.sourceCalls, false);
    assert.equal(reconciled.publishEffects, false);

    const summaries = await adapter.listReleases(contextA, { limit: 5 });
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0]!.sourceFresh, true);
    assert.equal(summaries[0]!.evaluationPassed, true);
    assert.equal(summaries[0]!.founderApproved, true);
    assert.equal(summaries[0]!.quarantineDecisionComplete, true);
    assert.equal(summaries[0]!.latestUsable, false);
    assert.equal((await adapter.listReleases(contextB)).length, 0);
    assert.equal((await adapter.listReleases(viewerContext)).length, 0);

    const stamped = await scopedRoleQuery(pool, 'r72_content_adapter', contextA,
      `INSERT INTO app_private.company_asset_source_attestations (
         id, workspace_id, source_release_id, release_sha256,
         source_catalog_sha256, scope_sha256, runtime_brand_sha256,
         brand_brain_package_sha256, source_commit, attestation_sha256,
         checked_at, expires_at, command_key_sha256, recorded_by_user_id,
         recorded_request_id, recorded_at
       ) SELECT $1, workspace_id, id, release_sha256, source_catalog_sha256,
         scope_sha256, runtime_brand_sha256, brand_brain_package_sha256,
         source_commit, decode($2, 'hex'), statement_timestamp(),
         statement_timestamp() + interval '1 minute', decode($3, 'hex'),
         $4, 'forged-request', '2100-01-01T00:00:00Z'::timestamptz
       FROM app_private.company_asset_releases WHERE id = $5
       RETURNING recorded_at < '2100-01-01T00:00:00Z'::timestamptz AS stamped`,
      [randomUUID(), 'bc'.repeat(32), 'bd'.repeat(32), ownerA, staged.sourceReleaseId]);
    assert.equal(stamped[0]!.stamped, true);

    await expectPostgresError(scopedRoleQuery(pool, 'r72_content_adapter', contextA,
      `INSERT INTO app_private.company_asset_eval_cases (
         id, workspace_id, source_release_id, eval_report_id, case_id,
         case_kind, dimension, input_sha256, output_sha256, evidence_sha256,
         expected_disposition, observed_disposition, reason_code,
         recorded_by_user_id, recorded_request_id
       ) VALUES ($1, $2, $3, $4, 'z-extra-golden', 'golden', 'brand',
         decode($5, 'hex'), decode($6, 'hex'), decode($7, 'hex'),
         'accept', 'accept', 'brand_style_match', $8, 'ignored')`,
      [randomUUID(), workspaceA, staged.sourceReleaseId,
        evaluation.evaluationReportId, 'c1'.repeat(32), 'c2'.repeat(32),
        'c3'.repeat(32), ownerA]), '23514');

    await expectPostgresError(scopedRoleQuery(pool, 'r72_web', contextA,
      `SELECT count(*) FROM app_private.company_asset_reconciliations`), '42501');
    await expectPostgresError(scopedRoleQuery(pool, 'r72_content_command', contextA,
      `INSERT INTO app_private.company_asset_releases (
         id, workspace_id, release_id, source_system, source_commit, generated_at,
         release_sha256, source_catalog_sha256, scope_sha256,
         runtime_brand_sha256, brand_brain_package_sha256, approved_item_count,
         recorded_by_user_id, recorded_request_id
       ) VALUES ($1, $2, 'property-predator.company-content-growth-hq/v1',
         'property-predator', 'b5986c94d0f8690236c9f290ba14b49cc978e887',
         statement_timestamp(), decode($3, 'hex'), decode($4, 'hex'),
         decode($5, 'hex'), decode($6, 'hex'), decode($7, 'hex'), 0, $8, 'ignored')`,
      [randomUUID(), workspaceA, '01'.repeat(32), '02'.repeat(32),
        '03'.repeat(32), '04'.repeat(32), '05'.repeat(32), ownerA]), '42501');
    await expectPostgresError(scopedRoleQuery(pool, 'r72_content_adapter', contextA,
      `INSERT INTO app_private.company_asset_founder_approvals (
         id, workspace_id, source_release_id, release_sha256,
         source_catalog_sha256, scope_sha256, runtime_brand_sha256,
         brand_brain_package_sha256, approval_id, approved_at,
         approval_expires_at, command_key_sha256,
         recorded_by_user_id, recorded_request_id
       ) SELECT $1, workspace_id, id, release_sha256, source_catalog_sha256,
         scope_sha256, runtime_brand_sha256, brand_brain_package_sha256,
         'fictional-role-confusion', statement_timestamp(),
         statement_timestamp() + interval '1 hour', decode($2, 'hex'), $3, 'ignored'
       FROM app_private.company_asset_releases WHERE id = $4`,
      [randomUUID(), 'cd'.repeat(32), ownerA, staged.sourceReleaseId]), '42501');
    await expectPostgresError(ownerQuery(pool,
      `UPDATE app_private.company_asset_releases
       SET approved_item_count = 0 WHERE id = $1`, [staged.sourceReleaseId]), '55000');

    const changedApproval = founderApproval(
      release,
      new Date(approvalNow.getTime() - 1_000).toISOString(),
      new Date(approvalNow.getTime() + 60 * 60_000).toISOString(),
    );
    changedApproval.scope.approvedItems[0].contentSha256 = 'ef'.repeat(32);
    changedApproval.scopeSha256 = companyAssetReleaseScopeSha256(changedApproval.scope);
    await assert.rejects(command.approveScope(contextA, {
      commandKey: 'fictional-approve-changed-db-1', founderApproval: changedApproval,
    }), CompanyAssetConflictError);

    const capabilities = await ownerQuery<{ unsafe: boolean }>(pool,
      `SELECT
         has_table_privilege('r72_content_adapter', 'app.provider_operations', 'INSERT')
         OR has_table_privilege('r72_content_command', 'app.provider_operations', 'INSERT')
         OR pg_has_role('r72_content_adapter', 'r72_worker', 'MEMBER')
         OR pg_has_role('r72_content_command', 'r72_worker', 'MEMBER') AS unsafe`);
    assert.equal(capabilities[0]!.unsafe, false);
  } finally {
    await resetIdentityTables(pool);
    await pool.end();
  }
});
