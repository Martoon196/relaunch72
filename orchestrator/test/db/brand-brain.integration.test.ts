import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { Pool } from 'pg';
import type { SqlExecutor } from '../../src/crm-pg/types.js';
import type { DatabaseRequestContext } from '../../src/db/rls.js';
import {
  BrandBrainPgRepository,
  BrandBrainService,
  type BrandBrainTransactionRunner,
} from '../../src/brand-brain-pg/index.js';
import {
  PROPERTY_PREDATOR_BRAND_BRAIN_EVAL_NEGATIVE_CASES_V1,
  PROPERTY_PREDATOR_BRAND_BRAIN_EVAL_POSITIVE_CASES_V1,
  PROPERTY_PREDATOR_BRAND_BRAIN_EVAL_RUNNER_V1,
  PROPERTY_PREDATOR_BRAND_BRAIN_EVAL_SUITE_V1_SHA256,
  normalizeStageBrandBrainInventory,
} from '../../src/brand-brain-pg/validation.js';
import { parsePropertyPredatorAiInventory } from '../../src/company-content-adapter/property-predator-ai-inventory.js';
import {
  expectPostgresError,
  openTestDatabase,
  ownerQuery,
  resetIdentityTables,
  testDatabaseSkipReason,
} from './database-helper.js';

const skip = testDatabaseSkipReason();
const fixtureUrl = new URL('../fixtures/property-predator-ai-inventory-v1.golden.json', import.meta.url);
type BrainRole = 'r72_content_adapter' | 'r72_content_command';

function runner(pool: Pool, role: BrainRole): BrandBrainTransactionRunner {
  return {
    async run<T>(
      context: DatabaseRequestContext,
      operation: (transaction: SqlExecutor) => Promise<T>,
      options: Readonly<{ readOnly: boolean; serializable?: boolean }>,
    ): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query(`BEGIN ISOLATION LEVEL ${options.serializable ? 'SERIALIZABLE' : 'READ COMMITTED'} ${options.readOnly ? 'READ ONLY' : 'READ WRITE'}`);
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
  role: BrainRole | 'r72_web',
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

test('Brand Brain is replay-safe, exact-manifest gated and resistant to direct-role parser bypass', {
  skip,
}, async () => {
  const pool = await openTestDatabase();
  const organizationId = randomUUID();
  const workspaceA = randomUUID();
  const workspaceB = randomUUID();
  const ownerA = randomUUID();
  const ownerB = randomUUID();
  const contextA: DatabaseRequestContext = {
    actorKind: 'user', workspaceId: workspaceA, userId: ownerA, requestId: 'brain-a',
  };
  const contextB: DatabaseRequestContext = {
    actorKind: 'user', workspaceId: workspaceB, userId: ownerB, requestId: 'brain-b',
  };
  try {
    await resetIdentityTables(pool);
    const slug = organizationId.replaceAll('-', '').slice(0, 10);
    await ownerQuery(pool,
      `INSERT INTO app.organizations (id, name, slug, kind, status)
       VALUES ($1, 'Brand Brain integration', $2, 'direct_customer', 'active')`,
      [organizationId, `brain-${slug}`]);
    await ownerQuery(pool,
      `INSERT INTO app.users (id, email, status, email_verified_at) VALUES
         ($1, $2, 'active', statement_timestamp()),
         ($3, $4, 'active', statement_timestamp())`,
      [ownerA, `brain-a-${slug}@example.test`, ownerB, `brain-b-${slug}@example.test`]);
    await ownerQuery(pool,
      `INSERT INTO app.workspaces (id, organization_id, name, slug, status) VALUES
         ($1, $2, 'Brain A', $3, 'active'),
         ($4, $2, 'Brain B', $5, 'active')`,
      [workspaceA, organizationId, `brain-a-${slug}`, workspaceB, `brain-b-${slug}`]);
    await ownerQuery(pool,
      `INSERT INTO app.workspace_memberships (
         workspace_id, organization_id, user_id, role, status
       ) VALUES
         ($1, $2, $3, 'owner', 'active'),
         ($4, $2, $5, 'owner', 'active')`,
      [workspaceA, organizationId, ownerA, workspaceB, ownerB]);

    const raw = JSON.parse(await readFile(fixtureUrl, 'utf8')) as unknown;
    const inventory = parsePropertyPredatorAiInventory(raw);
    const adapter = new BrandBrainService({ transactionRunner: runner(pool, 'r72_content_adapter') });
    const command = new BrandBrainService({ transactionRunner: runner(pool, 'r72_content_command') });
    const checkedAt = new Date(Date.now() - 5_000);
    const stageCommand = {
      commandKey: 'stage-exact-v1', inventory,
      checkedAt: checkedAt.toISOString(),
      expiresAt: new Date(checkedAt.getTime() + 10 * 60_000).toISOString(),
    };
    const staged = await adapter.stageInventory(contextA, stageCommand);
    const replay = await adapter.stageInventory(contextA, stageCommand);
    assert.equal(staged.disposition, 'applied');
    assert.equal(replay.disposition, 'replayed');
    assert.equal(replay.sourceReleaseId, staged.sourceReleaseId);
    assert.equal(replay.sourceAttestationId, staged.sourceAttestationId);

    const evaluation = await adapter.recordEvaluation(contextA, {
      commandKey: 'eval-exact-v1', sourceReleaseId: staged.sourceReleaseId,
      manifestSha256: staged.manifestSha256,
      evalSuiteSha256: PROPERTY_PREDATOR_BRAND_BRAIN_EVAL_SUITE_V1_SHA256,
      runnerVersion: PROPERTY_PREDATOR_BRAND_BRAIN_EVAL_RUNNER_V1,
      positiveCaseCount: PROPERTY_PREDATOR_BRAND_BRAIN_EVAL_POSITIVE_CASES_V1,
      negativeCaseCount: PROPERTY_PREDATOR_BRAND_BRAIN_EVAL_NEGATIVE_CASES_V1,
      passedCaseCount: PROPERTY_PREDATOR_BRAND_BRAIN_EVAL_POSITIVE_CASES_V1
        + PROPERTY_PREDATOR_BRAND_BRAIN_EVAL_NEGATIVE_CASES_V1,
      resultSha256: '12'.repeat(32),
    });
    const decisions = [];
    for (const dimension of ['ownership_licence', 'privacy_security', 'brand_readiness'] as const) {
      decisions.push(await command.decideReview(contextA, {
        commandKey: `approve-${dimension}`, sourceReleaseId: staged.sourceReleaseId,
        manifestSha256: staged.manifestSha256, dimension, decision: 'approved',
      }));
    }
    const activation = await command.activate(contextA, {
      commandKey: 'activate-exact-v1', sourceReleaseId: staged.sourceReleaseId,
      manifestSha256: staged.manifestSha256, evaluationId: evaluation.evaluationId,
      ownershipDecisionId: decisions[0]!.decisionId,
      privacyDecisionId: decisions[1]!.decisionId,
      brandDecisionId: decisions[2]!.decisionId,
    });
    assert.equal(activation.providerEffects, false);
    const snapshot = await command.latestSnapshot(contextA);
    assert.equal(snapshot?.activated, true);
    assert.equal(snapshot?.sources.length, 11);
    assert.equal(snapshot?.specialists.find((entry) => entry.capabilities.includes('post'))?.runtimeReady, true);
    assert.equal(snapshot?.specialists.find((entry) => entry.capabilities.includes('image'))?.runtimeReady, false);
    assert.equal(snapshot?.specialists.find((entry) => entry.capabilities.includes('image'))?.blockedReason,
      'visual_policy_conflict');

    await expectPostgresError(scopedRoleQuery(pool, 'r72_web', contextA,
      `SELECT id FROM app_private.brand_brain_source_releases`), '42501');
    await expectPostgresError(ownerQuery(pool,
      `UPDATE app_private.brand_brain_source_releases SET source_count = 11 WHERE id = $1`,
      [staged.sourceReleaseId]), '55000');

    const normalized = normalizeStageBrandBrainInventory(stageCommand);
    const releaseB = randomUUID();
    await scopedRoleQuery(pool, 'r72_content_adapter', contextB,
      `INSERT INTO app_private.brand_brain_source_releases (
         id, workspace_id, inventory_id, source_system, canonical_manifest,
         source_package_sha256, runtime_brand_sha256, source_count,
         specialist_count, artwork_count, quarantine_count,
         recorded_by_user_id, recorded_request_id
       ) VALUES (
         $1, $2, $3, $4, $5, decode($6, 'hex'), decode($7, 'hex'),
         11, 6, 10, 1, $8, 'direct-release-b'
       )`,
      [releaseB, workspaceB, inventory.inventoryId, inventory.sourceSystem,
        normalized.canonicalManifest, inventory.packageSha256,
        normalized.runtimeBrandSha256, ownerB]);

    const social = inventory.specialistProfiles[0]!;
    await expectPostgresError(scopedRoleQuery(pool, 'r72_content_adapter', contextB,
      `INSERT INTO app_private.brand_brain_specialist_profile_refs (
         id, workspace_id, source_release_id, profile_id, profile_name,
         capabilities, runtime_brand_sha256, source_status, hq_activation_status,
         recorded_by_user_id, recorded_request_id
       ) VALUES ($1, $2, $3, $4, $5, '["post"]'::jsonb, decode($6, 'hex'), $7, $8, $9, 'subset-capabilities')`,
      [randomUUID(), workspaceB, releaseB, social.profileId, social.name,
        social.runtimeBrandSha256, social.sourceStatus, social.hqActivationStatus, ownerB]), '23514');

    const quarantine = inventory.quarantines[0]!;
    await expectPostgresError(scopedRoleQuery(pool, 'r72_content_adapter', contextB,
      `INSERT INTO app_private.brand_brain_quarantines (
         id, workspace_id, source_release_id, quarantine_id, status, reason_code,
         usable, resolution, rule_ids, evidence_sha256,
         recorded_by_user_id, recorded_request_id
       ) VALUES ($1, $2, $3, $4, $5, $6, false, $7, $8::jsonb, decode($9, 'hex'), $10, 'subset-rules')`,
      [randomUUID(), workspaceB, releaseB, quarantine.quarantineId, quarantine.status,
        quarantine.reasonCode, quarantine.resolution,
        JSON.stringify([quarantine.ruleIds[0]]), quarantine.evidenceSha256, ownerB]), '23514');

    const source = inventory.sources.find((entry) => entry.sourceId === 'brand-bible')!;
    const sourceRefB = randomUUID();
    await scopedRoleQuery(pool, 'r72_content_adapter', contextB,
      `INSERT INTO app_private.brand_brain_source_version_refs (
         id, workspace_id, source_release_id, source_id, asset_role, authority_status,
         repository_path, locator_kind, source_symbol, media_type, byte_length,
         content_sha256, supplied_by, ownership_status, licence_status, privacy_class,
         consumer_use, recorded_by_user_id, recorded_request_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
         decode($12, 'hex'), $13, $14, $15, $16, $17, $18, 'valid-source')`,
      [sourceRefB, workspaceB, releaseB, source.sourceId, source.assetRole,
        source.authorityStatus, source.path, source.locatorKind, source.symbol,
        source.mediaType, source.byteLength, source.contentSha256, source.suppliedBy,
        source.ownershipStatus, source.licenceStatus, source.privacyClass,
        source.consumerUse, ownerB]);
    const profileRefB = randomUUID();
    await scopedRoleQuery(pool, 'r72_content_adapter', contextB,
      `INSERT INTO app_private.brand_brain_specialist_profile_refs (
         id, workspace_id, source_release_id, profile_id, profile_name,
         capabilities, runtime_brand_sha256, source_status, hq_activation_status,
         recorded_by_user_id, recorded_request_id
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, decode($7, 'hex'), $8, $9, $10, 'valid-profile')`,
      [profileRefB, workspaceB, releaseB, social.profileId, social.name,
        JSON.stringify(social.capabilities), social.runtimeBrandSha256,
        social.sourceStatus, social.hqActivationStatus, ownerB]);
    await expectPostgresError(scopedRoleQuery(pool, 'r72_content_adapter', contextB,
      `INSERT INTO app_private.brand_brain_specialist_source_refs (
         id, workspace_id, source_release_id, specialist_profile_ref_id,
         source_version_ref_id, reference_kind, recorded_by_user_id, recorded_request_id
       ) VALUES ($1, $2, $3, $4, $5, 'role', $6, 'wrong-semantic-link')`,
      [randomUUID(), workspaceB, releaseB, profileRefB, sourceRefB, ownerB]), '23514');

    await assert.rejects(adapter.stageInventory(contextB, stageCommand),
      /release projection is incomplete/);

    await expectPostgresError(scopedRoleQuery(pool, 'r72_content_adapter', contextB,
      `INSERT INTO app_private.brand_brain_eval_results (
         id, workspace_id, source_release_id, manifest_sha256, eval_suite_sha256,
         runner_version, positive_case_count, negative_case_count, passed_case_count,
         passed, result_sha256, recorded_by_user_id, recorded_request_id
       ) VALUES ($1, $2, $3, decode($4, 'hex'), decode($5, 'hex'),
         'arbitrary-runner', 0, 1, 1, true, decode($6, 'hex'), $7, 'arbitrary-eval')`,
      [randomUUID(), workspaceB, releaseB, inventory.packageSha256,
        'ab'.repeat(32), 'cd'.repeat(32), ownerB]), '23514');

    const evaluationB = await adapter.recordEvaluation(contextB, {
      commandKey: 'eval-b', sourceReleaseId: releaseB, manifestSha256: inventory.packageSha256,
      evalSuiteSha256: PROPERTY_PREDATOR_BRAND_BRAIN_EVAL_SUITE_V1_SHA256,
      runnerVersion: PROPERTY_PREDATOR_BRAND_BRAIN_EVAL_RUNNER_V1,
      positiveCaseCount: PROPERTY_PREDATOR_BRAND_BRAIN_EVAL_POSITIVE_CASES_V1,
      negativeCaseCount: PROPERTY_PREDATOR_BRAND_BRAIN_EVAL_NEGATIVE_CASES_V1,
      passedCaseCount: PROPERTY_PREDATOR_BRAND_BRAIN_EVAL_POSITIVE_CASES_V1
        + PROPERTY_PREDATOR_BRAND_BRAIN_EVAL_NEGATIVE_CASES_V1,
      resultSha256: '34'.repeat(32),
    });
    const decisionsB = [];
    for (const dimension of ['ownership_licence', 'privacy_security', 'brand_readiness'] as const) {
      decisionsB.push(await command.decideReview(contextB, {
        commandKey: `approve-b-${dimension}`, sourceReleaseId: releaseB,
        manifestSha256: inventory.packageSha256, dimension, decision: 'approved',
      }));
    }
    await expectPostgresError(command.activate(contextB, {
      commandKey: 'incomplete-activation-b', sourceReleaseId: releaseB,
      manifestSha256: inventory.packageSha256, evaluationId: evaluationB.evaluationId,
      ownershipDecisionId: decisionsB[0]!.decisionId,
      privacyDecisionId: decisionsB[1]!.decisionId,
      brandDecisionId: decisionsB[2]!.decisionId,
    }), '23514');

    const sourceRefsB = new Map<string, string>([[source.sourceId, sourceRefB]]);
    const profileRefsB = new Map<string, string>([[social.profileId, profileRefB]]);
    let quarantineRefB = '';
    await runner(pool, 'r72_content_adapter').run(contextB, async (transaction) => {
      const repository = new BrandBrainPgRepository(transaction);
      for (const candidate of inventory.sources) {
        if (sourceRefsB.has(candidate.sourceId)) continue;
        const id = randomUUID();
        await repository.insertSource({ id, releaseId: releaseB, source: candidate });
        sourceRefsB.set(candidate.sourceId, id);
      }
      for (const profile of inventory.specialistProfiles) {
        if (profileRefsB.has(profile.profileId)) continue;
        const id = randomUUID();
        await repository.insertSpecialist({ id, releaseId: releaseB, profile });
        profileRefsB.set(profile.profileId, id);
      }
      for (const artwork of inventory.artworkReferences) {
        await repository.insertArtwork({ id: randomUUID(), releaseId: releaseB, artwork });
      }
      quarantineRefB = randomUUID();
      await repository.insertQuarantine({
        id: quarantineRefB, releaseId: releaseB, quarantine,
      });
      for (const profile of inventory.specialistProfiles) {
        const profileRefId = profileRefsB.get(profile.profileId)!;
        const references: readonly (readonly [string, 'role' | 'policy' | 'instruction' | 'knowledge'])[] = [
          [profile.roleSourceId, 'role'],
          [profile.policySourceId, 'policy'],
          ...profile.instructionSourceIds.map((sourceId) => [sourceId, 'instruction'] as const),
          ...profile.knowledgeSourceIds.map((sourceId) => [sourceId, 'knowledge'] as const),
        ];
        for (const [sourceId, kind] of references) {
          if (profile.profileId === social.profileId && kind === 'knowledge') continue;
          await repository.insertSpecialistSource({
            id: randomUUID(), releaseId: releaseB, profileRefId,
            sourceRefId: sourceRefsB.get(sourceId)!, kind,
          });
        }
      }
      await repository.insertQuarantineSource({
        id: randomUUID(), releaseId: releaseB, quarantineRefId: quarantineRefB,
        sourceRefId: sourceRefsB.get(quarantine.sourceIds[0]!)!,
      });
    }, { readOnly: false, serializable: true });

    await assert.rejects(command.activate(contextB, {
      commandKey: 'missing-specialist-link-b', sourceReleaseId: releaseB,
      manifestSha256: inventory.packageSha256, evaluationId: evaluationB.evaluationId,
      ownershipDecisionId: decisionsB[0]!.decisionId,
      privacyDecisionId: decisionsB[1]!.decisionId,
      brandDecisionId: decisionsB[2]!.decisionId,
    }), /specialist source manifest is incomplete/);

    await runner(pool, 'r72_content_adapter').run(contextB, async (transaction) => {
      const repository = new BrandBrainPgRepository(transaction);
      await repository.insertSpecialistSource({
        id: randomUUID(), releaseId: releaseB, profileRefId: profileRefB,
        sourceRefId: sourceRefB, kind: 'knowledge',
      });
    }, { readOnly: false, serializable: true });
    await assert.rejects(command.activate(contextB, {
      commandKey: 'missing-quarantine-link-b', sourceReleaseId: releaseB,
      manifestSha256: inventory.packageSha256, evaluationId: evaluationB.evaluationId,
      ownershipDecisionId: decisionsB[0]!.decisionId,
      privacyDecisionId: decisionsB[1]!.decisionId,
      brandDecisionId: decisionsB[2]!.decisionId,
    }), /quarantine evidence links are incomplete/);

    assert.equal((await scopedRoleQuery(pool, 'r72_content_adapter', contextA,
      `SELECT count(*)::integer AS count FROM app_private.brand_brain_source_releases`))[0]?.count, 1);
    assert.equal((await scopedRoleQuery(pool, 'r72_content_adapter', contextB,
      `SELECT count(*)::integer AS count FROM app_private.brand_brain_source_releases`))[0]?.count, 1);
  } finally {
    await pool.end();
  }
});
