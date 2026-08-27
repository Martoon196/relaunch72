import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PROVIDER_ACTIVATION_GATES,
  PROVIDER_ACTIVATION_RAILS,
  PROVIDER_ACTIVATION_READINESS_CEILING,
  evaluateProviderActivationReadiness,
  type ProviderActivationGate,
  type ProviderActivationRail,
  type ProviderActivationReadinessInput,
  type ProviderGateEvidence,
  type ProviderReadinessManifestMetadata,
} from '../src/provider-activation-readiness/domain.js';

const NOW = new Date('2026-08-27T12:00:00.000Z');
const VERIFIED_AT = '2026-08-01T09:00:00.000Z';
const EXPIRES_AT = '2027-08-01T09:00:00.000Z';
const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const CONNECTION_ID = '22222222-2222-4222-8222-222222222222';
const REFERENCE_ID = '33333333-3333-4333-8333-333333333333';
const APPROVAL_ID = '44444444-4444-4444-8444-444444444444';
const VERSION_ID = '55555555-5555-4555-8555-555555555555';
const TEST_RUN_ID = '66666666-6666-4666-8666-666666666666';
const EVIDENCE_ID = '77777777-7777-4777-8777-777777777777';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_D = 'd'.repeat(64);

function evidence(status: 'verified' | 'not_applicable' = 'verified'): ProviderGateEvidence {
  return {
    status,
    evidenceId: EVIDENCE_ID,
    evidenceSha256: HASH_A,
    verifiedAt: VERIFIED_AT,
    expiresAt: EXPIRES_AT,
  };
}

function unavailableEvidence(status: 'missing' | 'failed'): ProviderGateEvidence {
  return {
    status,
    evidenceId: null,
    evidenceSha256: null,
    verifiedAt: null,
    expiresAt: null,
  };
}

function allEvidence(): Record<ProviderActivationGate, ProviderGateEvidence> {
  return Object.fromEntries(PROVIDER_ACTIVATION_GATES.map((gate) => [gate, evidence()])) as Record<
    ProviderActivationGate,
    ProviderGateEvidence
  >;
}

function providerFor(rail: ProviderActivationRail): ProviderReadinessManifestMetadata {
  if (rail === 'mailgun_email') {
    return {
      providerId: 'mailgun_eu',
      kind: 'email',
      outboundCredentialAuth: 'api_key',
      inboundWebhookVerification: 'hmac_signature',
      adapterContractVersion: '1.0.0',
    };
  }
  if (rail === 'whatsapp') {
    return {
      providerId: 'whatsapp_cloud',
      kind: 'messaging',
      outboundCredentialAuth: 'oauth2',
      inboundWebhookVerification: 'hmac_signature',
      adapterContractVersion: '1.0.0',
    };
  }
  if (rail === 'public_social') {
    return {
      providerId: 'social_publisher',
      kind: 'social',
      outboundCredentialAuth: 'oauth2',
      inboundWebhookVerification: 'asymmetric_signature',
      adapterContractVersion: '1.0.0',
    };
  }
  return {
    providerId: 'social_messages',
    kind: 'social',
    outboundCredentialAuth: 'oauth2',
    inboundWebhookVerification: 'hmac_signature',
    adapterContractVersion: '1.0.0',
  };
}

function readyInput(rail: ProviderActivationRail): ProviderActivationReadinessInput {
  const provider = providerFor(rail);
  const publicBroadcast = rail === 'public_social';
  const gateEvidence = allEvidence();
  if (publicBroadcast) {
    gateEvidence.consent = evidence('not_applicable');
    gateEvidence.suppression = evidence('not_applicable');
  }
  return {
    schemaVersion: 1,
    rail,
    provider,
    workspace: {
      workspaceId: WORKSPACE_ID,
      providerConnectionId: CONNECTION_ID,
    },
    scope: {
      commercialRights: {
        model: 'white_label_resale',
        territories: ['GB'],
      },
      privacy: {
        dpaRoleModel: 'controller_processor',
        dataRegions: ['GB'],
        transferMechanism: 'not_required',
      },
      account: {
        ownership: 'operator_owned',
        providerAccountReferenceSha256: HASH_A,
      },
      isolation: {
        workspaceId: WORKSPACE_ID,
        providerConnectionId: CONNECTION_ID,
        compositeLookupEnforced: true,
        rowLevelSecurityEnforced: true,
        crossWorkspaceTestPassed: true,
      },
      secretManager: {
        manager: 'render_secret',
        referenceId: REFERENCE_ID,
        locatorSha256: HASH_B,
      },
      webhook: {
        verificationMode: provider.inboundWebhookVerification,
        replayWindowSeconds: 900,
        idempotencyNamespaceSha256: HASH_C,
        reconciliationMode: 'signed_webhook_and_provider_query',
        maxReconciliationLagSeconds: 3_600,
      },
      policy: {
        consentRoute: publicBroadcast ? 'not_applicable_public_broadcast' : 'individual_consent',
        purpose: publicBroadcast ? 'approved_content_publish' : 'internal_seed_validation',
        territories: ['GB'],
        senderReferenceSha256: HASH_D,
        suppressionScope: publicBroadcast
          ? 'public_broadcast_not_applicable'
          : 'recipient_workspace_provider',
      },
      approval: {
        approvalId: APPROVAL_ID,
        versionId: VERSION_ID,
        contentSha256: HASH_A,
      },
      caps: {
        currency: 'GBP',
        maxSpendPerOperationMinorUnits: 100,
        maxSpendPerDayMinorUnits: 1_000,
        maxSpendPerMonthMinorUnits: 10_000,
        maxVolumePerOperation: 1,
        maxVolumePerDay: 10,
        maxVolumePerMonth: 100,
      },
      switches: {
        emergencyPaused: true,
        runtimeEffects: 'off',
        databaseEffects: 'off',
        workspaceEffects: 'off',
        railEffects: 'off',
      },
      lifecycle: {
        exportPlanSha256: HASH_A,
        deletionPlanSha256: HASH_B,
        exitPlanSha256: HASH_C,
      },
      testProvider: {
        mode: 'provider_sandbox',
        fixturePackSha256: HASH_D,
        testRunId: TEST_RUN_ID,
      },
      internalSeed: {
        destinationScope: 'owned_internal_destinations_only',
        ownershipVerified: true,
        maxDestinations: 10,
        destinationReferenceHashes: [HASH_A],
      },
    },
    evidence: gateEvidence,
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function blockerCodes(input: ProviderActivationReadinessInput): string[] {
  return evaluateProviderActivationReadiness(input, NOW).blockingReasons.map((item) => item.code);
}

test('all four rails can reach only immutable internal-seed readiness while provider effects stay dark', () => {
  assert.deepEqual(PROVIDER_ACTIVATION_RAILS, [
    'mailgun_email',
    'whatsapp',
    'public_social',
    'social_dm',
  ]);
  assert.equal(PROVIDER_ACTIVATION_READINESS_CEILING, 'internal_seed_ready');

  for (const rail of PROVIDER_ACTIVATION_RAILS) {
    const report = evaluateProviderActivationReadiness(readyInput(rail), NOW);
    assert.equal(report.inputAccepted, true, rail);
    assert.equal(report.readiness, 'internal_seed_ready', rail);
    assert.equal(report.ceiling, 'internal_seed_ready', rail);
    assert.equal(report.nextStage, null, rail);
    assert.deepEqual(report.blockingReasons, [], rail);
    assert.ok(report.stages.every((stage) => stage.ready), rail);
    assert.deepEqual(report.safety, {
      liveAuthorised: false,
      providerEffectsAllowed: false,
      providerOperationsCreated: 0,
      separateActivationRequired: true,
    });
    assert.equal(JSON.stringify(report).includes('live_authorised'), false);
    assert.ok(Object.isFrozen(report));
    assert.ok(Object.isFrozen(report.stages));
    assert.ok(Object.isFrozen(report.stages[0]));
    assert.ok(Object.isFrozen(report.stages[0]?.blockers));
    assert.ok(Object.isFrozen(report.safety));
  }
});

test('stage progression is cumulative and reports the exact next missing proof', () => {
  const missingSeed = clone(readyInput('whatsapp'));
  (missingSeed.evidence as Record<ProviderActivationGate, ProviderGateEvidence>).internalSeed =
    unavailableEvidence('missing');
  const seedReport = evaluateProviderActivationReadiness(missingSeed, NOW);
  assert.equal(seedReport.readiness, 'provider_test_verified');
  assert.equal(seedReport.nextStage, 'internal_seed_ready');
  assert.deepEqual(seedReport.stages.map((stage) => stage.ready), [true, true, false]);
  assert.ok(seedReport.blockingReasons.some((item) => (
    item.code === 'EVIDENCE_MISSING' && item.gate === 'internalSeed'
  )));

  const missingTest = clone(readyInput('whatsapp'));
  (missingTest.evidence as Record<ProviderActivationGate, ProviderGateEvidence>).testProvider =
    unavailableEvidence('missing');
  const testReport = evaluateProviderActivationReadiness(missingTest, NOW);
  assert.equal(testReport.readiness, 'adapter_contract_verified');
  assert.equal(testReport.nextStage, 'provider_test_verified');
  assert.deepEqual(testReport.stages.map((stage) => stage.ready), [true, false, false]);
  assert.ok(testReport.blockingReasons.some((item) => (
    item.code === 'EVIDENCE_MISSING' && item.gate === 'testProvider'
  )));

  const missingAdapter = clone(readyInput('whatsapp'));
  (missingAdapter.evidence as Record<ProviderActivationGate, ProviderGateEvidence>).adapterContract =
    unavailableEvidence('failed');
  const adapterReport = evaluateProviderActivationReadiness(missingAdapter, NOW);
  assert.equal(adapterReport.readiness, 'not_ready');
  assert.equal(adapterReport.nextStage, 'adapter_contract_verified');
  assert.ok(adapterReport.blockingReasons.some((item) => (
    item.code === 'EVIDENCE_FAILED' && item.gate === 'adapterContract'
  )));
});

test('stale evidence fails closed with a transparent gate-level reason', () => {
  const input = clone(readyInput('mailgun_email'));
  (input.evidence as Record<ProviderActivationGate, ProviderGateEvidence>).dpa = {
    ...evidence(),
    expiresAt: '2026-08-27T11:59:59.999Z',
  };
  const report = evaluateProviderActivationReadiness(input, NOW);
  assert.equal(report.inputAccepted, true);
  assert.equal(report.readiness, 'not_ready');
  assert.ok(report.blockingReasons.some((item) => (
    item.code === 'EVIDENCE_STALE' && item.gate === 'dpa'
  )));
});

test('public broadcast may explicitly mark consent and suppression not applicable; direct rails may not', () => {
  const publicReport = evaluateProviderActivationReadiness(readyInput('public_social'), NOW);
  assert.equal(publicReport.readiness, 'internal_seed_ready');

  const directInput = clone(readyInput('whatsapp'));
  (directInput.scope.policy as { consentRoute: string }).consentRoute =
    'not_applicable_public_broadcast';
  (directInput.scope.policy as { suppressionScope: string }).suppressionScope =
    'public_broadcast_not_applicable';
  (directInput.evidence as Record<ProviderActivationGate, ProviderGateEvidence>).consent =
    evidence('not_applicable');
  (directInput.evidence as Record<ProviderActivationGate, ProviderGateEvidence>).suppression =
    evidence('not_applicable');
  const directReport = evaluateProviderActivationReadiness(directInput, NOW);
  assert.equal(directReport.inputAccepted, true);
  assert.equal(directReport.readiness, 'provider_test_verified');
  assert.ok(directReport.blockingReasons.some((item) => item.code === 'NOT_APPLICABLE_INVALID'));
  assert.ok(directReport.blockingReasons.some((item) => item.code === 'CHANNEL_POLICY_SCOPE_INVALID'));
});

test('any effects switch on or an open emergency pause blocks every readiness stage', () => {
  for (const mutation of [
    (input: ProviderActivationReadinessInput) => {
      (input.scope.switches as { emergencyPaused: boolean }).emergencyPaused = false;
    },
    (input: ProviderActivationReadinessInput) => {
      (input.scope.switches as { railEffects: string }).railEffects = 'on';
    },
  ]) {
    const input = clone(readyInput('social_dm'));
    mutation(input);
    const report = evaluateProviderActivationReadiness(input, NOW);
    assert.equal(report.inputAccepted, true);
    assert.equal(report.readiness, 'not_ready');
    assert.ok(report.stages.every((stage) => !stage.ready));
    assert.ok(report.blockingReasons.some((item) => item.code === 'DARK_SWITCH_INVARIANT_FAILED'));
    assert.equal(report.safety.providerEffectsAllowed, false);
  }
});

test('workspace crossover and incomplete isolation evidence fail closed', () => {
  const mismatch = clone(readyInput('whatsapp'));
  (mismatch.scope.isolation as { workspaceId: string }).workspaceId =
    '88888888-8888-4888-8888-888888888888';
  assert.ok(blockerCodes(mismatch).includes('WORKSPACE_SCOPE_MISMATCH'));

  const isolationGap = clone(readyInput('whatsapp'));
  (isolationGap.scope.isolation as { rowLevelSecurityEnforced: boolean }).rowLevelSecurityEnforced = false;
  assert.ok(blockerCodes(isolationGap).includes('WORKSPACE_ISOLATION_UNVERIFIED'));
});

test('credential-shaped input is rejected before parsing and is never echoed into the report', () => {
  const input = clone(readyInput('mailgun_email')) as unknown as Record<string, unknown>;
  input.apiKey = 'must-never-appear';
  const report = evaluateProviderActivationReadiness(input, NOW);
  assert.equal(report.inputAccepted, false);
  assert.equal(report.readiness, 'not_ready');
  assert.equal(report.validationIssues[0]?.code, 'FORBIDDEN_CREDENTIAL_FIELD');
  assert.equal(report.validationIssues[0]?.path, 'input.apiKey');
  assert.equal(JSON.stringify(report).includes('must-never-appear'), false);
  assert.equal(report.safety.liveAuthorised, false);
  assert.equal(report.safety.providerOperationsCreated, 0);
});

test('unknown fields, invalid seed bounds and inconsistent caps are malformed rather than partially trusted', () => {
  const unknownField = clone(readyInput('mailgun_email')) as unknown as {
    scope: { secretManager: Record<string, unknown> };
  };
  unknownField.scope.secretManager.environment = 'production';
  const unknownReport = evaluateProviderActivationReadiness(unknownField, NOW);
  assert.equal(unknownReport.inputAccepted, false);
  assert.equal(unknownReport.validationIssues[0]?.code, 'INPUT_SHAPE_INVALID');

  const tooManySeeds = clone(readyInput('mailgun_email'));
  (tooManySeeds.scope.internalSeed as { maxDestinations: number }).maxDestinations = 11;
  const seedsReport = evaluateProviderActivationReadiness(tooManySeeds, NOW);
  assert.equal(seedsReport.inputAccepted, false);
  assert.equal(seedsReport.validationIssues[0]?.code, 'INPUT_VALUE_INVALID');

  const invalidCaps = clone(readyInput('mailgun_email'));
  (invalidCaps.scope.caps as { maxSpendPerDayMinorUnits: number }).maxSpendPerDayMinorUnits = 50;
  const capReport = evaluateProviderActivationReadiness(invalidCaps, NOW);
  assert.equal(capReport.inputAccepted, false);
  assert.equal(capReport.validationIssues[0]?.path, 'input.scope.caps');
});

test('provider registry metadata must match the selected rail and webhook scope', () => {
  const wrongKind = clone(readyInput('whatsapp'));
  (wrongKind.provider as { kind: string }).kind = 'email';
  const wrongKindReport = evaluateProviderActivationReadiness(wrongKind, NOW);
  assert.equal(wrongKindReport.inputAccepted, true);
  assert.equal(wrongKindReport.readiness, 'not_ready');
  assert.ok(wrongKindReport.blockingReasons.some((item) => item.code === 'PROVIDER_METADATA_MISMATCH'));

  const mismatchedWebhook = clone(readyInput('public_social'));
  (mismatchedWebhook.scope.webhook as { verificationMode: string }).verificationMode = 'hmac_signature';
  const webhookReport = evaluateProviderActivationReadiness(mismatchedWebhook, NOW);
  assert.equal(webhookReport.inputAccepted, true);
  assert.equal(webhookReport.readiness, 'not_ready');
  assert.ok(webhookReport.blockingReasons.some((item) => item.code === 'PROVIDER_METADATA_MISMATCH'));
});

test('reports are detached from later input mutation and invalid clocks fail closed', () => {
  const input = clone(readyInput('whatsapp'));
  const report = evaluateProviderActivationReadiness(input, NOW);
  (input.provider as { providerId: string }).providerId = 'changed_after_assessment';
  (input.evidence as Record<ProviderActivationGate, ProviderGateEvidence>).adapterContract =
    unavailableEvidence('missing');
  assert.equal(report.providerId, 'whatsapp_cloud');
  assert.equal(report.readiness, 'internal_seed_ready');
  assert.equal(report.stages[0]?.ready, true);

  const invalidClock = evaluateProviderActivationReadiness(readyInput('whatsapp'), new Date(Number.NaN));
  assert.equal(invalidClock.inputAccepted, false);
  assert.equal(invalidClock.validationIssues[0]?.path, 'clock');
  assert.ok(Object.isFrozen(invalidClock.validationIssues));
  assert.ok(Object.isFrozen(invalidClock.validationIssues[0]));
});
