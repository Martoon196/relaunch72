import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import type { DatabaseRequestContext } from '../../src/db/rls.js';
import type { SqlExecutor } from '../../src/crm-pg/types.js';
import {
  CompanyContentService,
  canonicalCompanyContentJson,
  type CompanyContentTransactionRunner,
} from '../../src/company-content-pg/index.js';
import { PropertyPredatorGeneratedDraftLifecycle } from '../../src/company-content-adapter/property-predator-generation-approval.js';
import { PropertyPredatorGenerationBridgeError } from '../../src/company-content-adapter/property-predator-generation.js';
import { createPropertyPredatorBrandBrainFixture } from '../../src/portal/brand-brain-fixtures.js';
import { ownerQuery } from './database-helper.js';

const roleUrls = {
  owner: process.env.HQ_DRAFT_PROOF_OWNER_URL?.trim(),
  adapter: process.env.HQ_DRAFT_PROOF_ADAPTER_URL?.trim(),
  web: process.env.HQ_DRAFT_PROOF_WEB_URL?.trim(),
  command: process.env.HQ_DRAFT_PROOF_COMMAND_URL?.trim(),
};
const expectedHost = process.env.HQ_DRAFT_PROOF_EXPECTED_HOST?.trim();
const skip = !roleUrls.owner || !roleUrls.adapter || !roleUrls.web || !roleUrls.command || !expectedHost
  ? 'HQ draft proof role URLs and expected child-branch host are not configured' : false;

function runner(pool: Pool, readOnly = false): CompanyContentTransactionRunner {
  return {
    async run<T>(context: DatabaseRequestContext, operation: (sql: SqlExecutor) => Promise<T>, options: { readOnly: boolean; serializable?: boolean }): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query(`BEGIN ISOLATION LEVEL ${options.serializable ? 'SERIALIZABLE' : 'READ COMMITTED'} ${options.readOnly || readOnly ? 'READ ONLY' : 'READ WRITE'}`);
        await client.query(
          `SELECT set_config('app.user_id', $1, true), set_config('app.workspace_id', $2, true),
                  set_config('app.actor_kind', 'user', true), set_config('app.request_id', $3, true)`,
          [context.userId, context.workspaceId, context.requestId],
        );
        const value = await operation(client as SqlExecutor);
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

function readyBrain() {
  const fixture = JSON.parse(JSON.stringify(createPropertyPredatorBrandBrainFixture())) as ReturnType<typeof createPropertyPredatorBrandBrainFixture>;
  return {
    ...fixture,
    brain: {
      ...fixture.brain,
      evaluationPassed: true,
      activated: true,
      visualPolicyConflict: false,
      reviews: [...fixture.brain.reviews, {
        dimension: 'brand_readiness' as const,
        decision: 'approved' as const,
        decisionId: 'b3000000-0000-4000-8000-000000000003',
      }],
      specialists: fixture.brain.specialists.map((profile) => profile.profileId === 'propertypredator.owned.social/v1'
        ? { ...profile, capabilities: ['post', 'thread'], runtimeReady: true, blockedReason: null }
        : profile),
    },
  };
}

test('disposable branch proves adapter persistence, replay, reopen, isolation and approval gating', { skip }, async () => {
  for (const value of Object.values(roleUrls)) {
    assert.equal(new URL(value!).hostname, expectedHost, 'every role URL must target the named disposable child branch');
  }
  const owner = new Pool({ connectionString: roleUrls.owner!, max: 1 });
  const adapterPool = new Pool({ connectionString: roleUrls.adapter!, max: 2 });
  const webPool = new Pool({ connectionString: roleUrls.web!, max: 2 });
  const commandPool = new Pool({ connectionString: roleUrls.command!, max: 2 });
  const organizationId = randomUUID();
  const workspaceA = randomUUID();
  const workspaceB = randomUUID();
  const ownerA = randomUUID();
  const ownerB = randomUUID();
  const contextA: DatabaseRequestContext = { actorKind: 'user', workspaceId: workspaceA, userId: ownerA, requestId: 'draft-continuity-a' };
  const contextB: DatabaseRequestContext = { actorKind: 'user', workspaceId: workspaceB, userId: ownerB, requestId: 'draft-continuity-b' };
  try {
    assert.equal((await adapterPool.query<{ current_user: string }>('SELECT current_user')).rows[0]?.current_user, 'r72_content_adapter');
    assert.equal((await webPool.query<{ current_user: string }>('SELECT current_user')).rows[0]?.current_user, 'r72_web');
    assert.equal((await commandPool.query<{ current_user: string }>('SELECT current_user')).rows[0]?.current_user, 'r72_content_command');
    await ownerQuery(owner, `INSERT INTO app.organizations (id,name,slug,kind,status) VALUES ($1,'Draft continuity proof',$2,'direct_customer','active')`, [organizationId, `draft-proof-${organizationId.slice(0, 8)}`]);
    await ownerQuery(owner, `INSERT INTO app.users (id,email,status,email_verified_at) VALUES ($1,$2,'active',statement_timestamp()),($3,$4,'active',statement_timestamp())`, [ownerA, `a-${ownerA.slice(0, 8)}@example.test`, ownerB, `b-${ownerB.slice(0, 8)}@example.test`]);
    await ownerQuery(owner, `INSERT INTO app.workspaces (id,organization_id,name,slug,status) VALUES ($1,$2,'Draft A',$3,'active'),($4,$2,'Draft B',$5,'active')`, [workspaceA, organizationId, `draft-a-${workspaceA.slice(0, 8)}`, workspaceB, `draft-b-${workspaceB.slice(0, 8)}`]);
    await ownerQuery(owner, `INSERT INTO app.workspace_memberships (workspace_id,organization_id,user_id,role,status) VALUES ($1,$2,$3,'owner','active'),($4,$2,$5,'owner','active')`, [workspaceA, organizationId, ownerA, workspaceB, ownerB]);

    const adapter = new CompanyContentService({ transactionRunner: runner(adapterPool) });
    const web = new CompanyContentService({ transactionRunner: runner(webPool, true) });
    const command = new CompanyContentService({ transactionRunner: runner(commandPool) });
    const brain = readyBrain();
    const sourceReplay = new Map<string, any>();
    let paidEffects = 0;
    const lifecycle = new PropertyPredatorGeneratedDraftLifecycle({
      content: adapter,
      generation: { async generateDraft(input) {
        if (input.brief.platform === 'facebook') throw new PropertyPredatorGenerationBridgeError('transport_failed');
        const prior = sourceReplay.get(input.idempotencyKey);
        if (prior) return prior;
        paidEffects += 1;
        const payload = { body: 'Saved on the disposable branch.', contextSha256: input.contextSha256, cta_url: 'https://propertypredator.com/learn', kind: 'post' as const, platform: input.brief.platform, schema: 'propertypredator.company-content/v1' as const, title: 'A durable draft', type: 'generated' as const };
        const usage = { accountingState: 'provider_tokens_unpriced' as const, inputTokens: 10, outputTokens: 12, model: 'offline-fixture', providerRequestId: 'offline-only' };
        const result = Object.freeze({ ok: true as const, schemaVersion: 1 as const, brandSha256: input.expectedBrandSha256, contentSha256: createHash('sha256').update(canonicalCompanyContentJson(payload)).digest('hex'), contextSha256: input.contextSha256, draftId: 'd1000000-0000-4000-8000-000000000001', itemVersion: 1, payload: Object.freeze(payload), status: 'source_review_required' as const, usage: Object.freeze(usage), usageSha256: createHash('sha256').update(canonicalCompanyContentJson(usage)).digest('hex'), versionId: 'd2000000-0000-4000-8000-000000000001' });
        sourceReplay.set(input.idempotencyKey, result);
        return result;
      } },
    });
    const input = { persistenceCommandKey: 'draft-continuity-persist-1', draftPlan: { selection: 'property-predator-agency-laps:presentation', brandBrainSnapshot: brain }, generation: { idempotencyKey: 'draft-continuity-generate-1', expectedBrandSha256: brain.brain.runtimeBrandSha256, maximumCostMinor: 250, brief: { kind: 'post' as const, platform: 'linkedin', topic: 'Evidence', tone: 'direct' } } };
    const first = await lifecycle.generateAndStage(contextA, input);
    const replay = await lifecycle.generateAndStage(contextA, input);
    assert.equal(paidEffects, 1);
    assert.equal(replay.disposition, 'replayed');
    assert.equal(replay.reviewTarget.contentVersionId, first.reviewTarget.contentVersionId);
    const catalogue = await web.listCatalog(contextA, { limit: 10 });
    assert.equal(catalogue.items[0]?.contentVersionId, first.reviewTarget.contentVersionId);
    assert.equal(catalogue.items[0]?.publishable, false);
    assert.equal((await web.listCatalog(contextB, { limit: 10 })).items.length, 0);
    const review = await web.getExactReview(contextA, first.reviewTarget);
    assert.equal(review?.canonicalContent, canonicalCompanyContentJson(first.draft.payload));
    const requested = await command.requestApproval(contextA, { commandKey: 'draft-continuity-request-1', contentItemId: first.reviewTarget.contentItemId, contentVersionId: first.reviewTarget.contentVersionId });
    await command.decideApproval(contextA, { commandKey: 'draft-continuity-approve-1', approvalRequestId: requested.approvalRequestId, decision: 'approved' });
    assert.equal((await web.listCatalog(contextA, { limit: 10 })).items[0]?.publishable, true);
    await assert.rejects(lifecycle.generateAndStage(contextA, { ...input, persistenceCommandKey: 'draft-continuity-facebook', generation: { ...input.generation, idempotencyKey: 'draft-continuity-facebook', brief: { ...input.generation.brief, platform: 'facebook' } } }), PropertyPredatorGenerationBridgeError);
    assert.equal((await web.listCatalog(contextA, { limit: 10 })).items.length, 1);
    const effectCounts = await ownerQuery(owner, `SELECT
      (SELECT count(*)::int FROM app.provider_operations WHERE workspace_id = $1) AS providers,
      (SELECT count(*)::int FROM app.public_social_planning_intents WHERE workspace_id = $1) AS plans,
      (SELECT count(*)::int FROM app.property_predator_owned_social_jobs WHERE workspace_id = $1) AS jobs`, [workspaceA]);
    assert.deepEqual(effectCounts[0], { providers: 0, plans: 0, jobs: 0 });
  } finally {
    // The real append-only triggers also protect fixture rows. Retain them only
    // on the explicitly pinned disposable branch; never disable those triggers
    // or delete inherited data to clean up a proof run.
    console.info('Synthetic proof workspaces retained on disposable branch:', workspaceA, workspaceB);
    await Promise.allSettled([adapterPool.end(), webPool.end(), commandPool.end()]);
    await owner.end();
  }
});
