import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  CAMPAIGN_MACHINE_SNAPSHOT_SQL,
  PgPortalCampaignMachineService,
  type PgPortalCampaignMachineDependencies,
} from '../src/portal/campaign-machine-pg-service.js';
import { createPropertyPredatorCampaignMachineFixture } from '../src/portal/campaign-machine-fixtures.js';

const SESSION = 'opaque-campaign-machine-session';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_ID = '22222222-2222-4222-8222-222222222222';

function rows(): Record<string, unknown>[] {
  const snapshot = createPropertyPredatorCampaignMachineFixture();
  const template = snapshot.templates[0]!;
  return template.steps.map((step) => ({
    workspaceName: snapshot.workspaceName,
    snapshotAt: snapshot.asOf,
    templateId: template.templateId,
    templateKey: template.templateKey,
    templateName: template.name,
    templateDescription: template.description,
    versionId: template.version.versionId,
    versionNumber: String(template.version.versionNumber),
    definitionSha256: template.version.definitionSha256,
    brandBrainReleaseId: template.version.brandBrainReleaseId,
    brandBrainManifestSha256: template.version.brandBrainManifestSha256,
    canonicalBrandVersion: template.version.canonicalBrandVersion,
    specialistChain: [...template.version.specialistChain],
    lapsTrack: template.version.lapsTrack,
    journeySlug: template.version.journeySlug,
    entryStage: template.version.entryStage,
    targetStage: template.version.targetStage,
    activationWindowId: template.version.activationWindowId,
    audienceVersionId: template.version.audienceVersionId,
    offerVersionId: template.version.offerVersionId,
    versionCreatedAt: template.version.createdAt,
    recipeId: template.recipe.recipeId,
    recipeVersionId: template.recipe.recipeVersionId,
    recipeSha256: template.recipe.recipeSha256,
    entryEventKey: template.recipe.entryEventKey,
    stopEventKeys: [...template.recipe.stopEventKeys],
    idempotencyScope: template.recipe.idempotencyScope,
    reportingIdentityId: template.reporting.reportingIdentityId,
    reportingVersionSha256: template.reporting.templateVersionSha256,
    reportingKey: template.reporting.reportingKey,
    attributionNamespace: template.reporting.attributionNamespace,
    metricSchemaSha256: template.reporting.metricSchemaSha256,
    approvalRequestId: template.approval.requestId,
    approvalDecisionId: template.approval.decisionId,
    approvalVersionSha256: template.approval.templateVersionSha256,
    approvalState: template.approval.state,
    approvalDecidedAt: template.approval.decidedAt,
    stepId: step.stepId,
    stepPosition: String(step.position),
    stepKey: step.stepKey,
    stepKind: step.kind,
    delayMinutes: String(step.delayMinutes),
    triggerEventKey: step.triggerEventKey,
    stepTargetStage: step.targetLapsStage,
    ownedSpecialistId: step.ownedSpecialistId,
    subject: step.subject,
    previewText: step.previewText,
    body: step.body,
    ctaLabel: step.ctaLabel,
    contentSha256: step.contentSha256,
    requiresHumanApproval: step.requiresHumanApproval,
    requiresCurrentPermission: step.requiresCurrentPermission,
  }));
}

function dependencies(returnedRows = rows()): PgPortalCampaignMachineDependencies {
  return {
    principalResolver: {
      resolve: async () => ({ userId: USER_ID, workspaceId: WORKSPACE_ID }),
    },
    readRunner: {
      async run(_context, operation) {
        return operation({
          query: async () => ({ rows: returnedRows, rowCount: returnedRows.length }),
        } as never);
      },
    },
  };
}

test('Campaign Machine reads one authenticated RLS-scoped immutable snapshot', async () => {
  const calls: unknown[] = [];
  let sql = '';
  const service = new PgPortalCampaignMachineService({
    ...dependencies(),
    readRunner: {
      async run(context, operation, options) {
        calls.push(context);
        assert.deepEqual(options, { readOnly: true, serializable: true });
        return operation({
          async query(text: string, values?: readonly unknown[]) {
            sql = text;
            assert.deepEqual(values, [WORKSPACE_ID]);
            return { rows: rows(), rowCount: rows().length };
          },
        } as never);
      },
    },
  });
  const outcome = await service.snapshot({ sessionToken: SESSION, requestId: 'campaign-read-1' });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(calls, [{
    actorKind: 'user', userId: USER_ID, workspaceId: WORKSPACE_ID,
    requestId: 'campaign-read-1',
    portalSessionTokenHash: createHash('sha256').update(SESSION).digest(),
  }]);
  assert.equal(sql, CAMPAIGN_MACHINE_SNAPSHOT_SQL);
  assert.match(sql, /FROM app\.campaign_templates/u);
  assert.match(sql, /LIMIT 9/u);
  assert.match(sql, /LIMIT 13/u);
  assert.doesNotMatch(sql, /recipient|email_address|phone|credential|secret|provider_payload/iu);
  assert.equal(outcome.snapshot.templates.length, 1);
  assert.equal(outcome.snapshot.templates[0]!.steps.length, 6);
  assert.equal(outcome.snapshot.templates[0]!.version.providerEffects, false);
  assert.equal('enqueue' in service, false);
  assert.equal('approve' in service, false);
});

test('Campaign Machine fails before any read when the session is unresolved', async () => {
  let reads = 0;
  const service = new PgPortalCampaignMachineService({
    ...dependencies(),
    principalResolver: { resolve: async () => null },
    readRunner: { async run() { reads += 1; throw new Error('must not run'); } },
  });
  assert.deepEqual(await service.snapshot({ sessionToken: SESSION, requestId: 'campaign-read-2' }), {
    ok: false, kind: 'unauthenticated', message: 'This portal session is no longer active.',
  });
  assert.equal(reads, 0);
});

test('Campaign Machine accepts an honest empty workspace snapshot', async () => {
  const empty = rows()[0]!;
  const returned: Record<string, unknown> = Object.fromEntries(
    Object.keys(empty).map((key) => [key, null]),
  );
  returned.workspaceName = 'Property Predator Growth HQ';
  returned.snapshotAt = '2026-08-29T08:00:00.000Z';
  const outcome = await new PgPortalCampaignMachineService(dependencies([returned])).snapshot({
    sessionToken: SESSION, requestId: 'campaign-read-3',
  });
  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.deepEqual(outcome.snapshot.templates, []);
});

test('Campaign Machine rejects cross-shape, secret-shaped and altered binding rows', async () => {
  const candidates = [
    rows().map((row, index) => index === 0 ? { ...row, providerToken: 'DO-NOT-LEAK' } : row),
    rows().map((row, index) => index === 0 ? { ...row, reportingVersionSha256: 'f'.repeat(64) } : row),
    rows().map((row, index) => index === 0 ? { ...row, stepPosition: '0' } : row),
  ];
  for (const [index, candidate] of candidates.entries()) {
    const outcome = await new PgPortalCampaignMachineService(dependencies(candidate)).snapshot({
      sessionToken: SESSION, requestId: `campaign-invalid-${index}`,
    });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.kind, 'invalid_snapshot');
    assert.doesNotMatch(JSON.stringify(outcome), /DO-NOT-LEAK/u);
  }
});
