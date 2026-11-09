import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  PROVIDER_ACTIVATION_GATES,
  PROVIDER_ACTIVATION_RAILS,
  PROVIDER_ACTIVATION_READINESS_CEILING,
  PROVIDER_ACTIVATION_READINESS_STAGES,
  createProviderActivationAuthority,
  evaluateProviderActivationReadiness,
  providerActivationAssessedScopeSha256,
  type ProviderActivationAuthority,
  type ProviderActivationGate,
  type ProviderActivationRail,
  type ProviderActivationReadinessInput,
  type ProviderGateEvidence,
  type ProviderReadinessManifestMetadata,
} from '../src/provider-activation-readiness/domain.js';
import { createProviderRegistry } from '../src/providers/registry.js';

const NOW = new Date('2026-08-27T12:00:00.000Z');
const VERIFIED_AT = '2026-08-27T06:00:00.000Z';
const EXPIRES_AT = '2026-08-28T06:00:00.000Z';
const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const CONNECTION_ID = '22222222-2222-4222-8222-222222222222';
const REFERENCE_ID = '33333333-3333-4333-8333-333333333333';
const APPROVAL_ID = '44444444-4444-4444-8444-444444444444';
const VERSION_ID = '55555555-5555-4555-8555-555555555555';
const TEST_RUN_ID = '66666666-6666-4666-8666-666666666666';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_D = 'd'.repeat(64);

const MAILGUN_TEST_REGISTRY = createProviderRegistry([{
  id: 'mailgun_eu',
  name: 'Mailgun EU authoritative test manifest',
  kind: 'email',
  outboundCredentialAuth: 'api_key',
  inboundWebhookVerification: 'hmac_signature',
  capabilities: ['conversations.reply'],
}]);
const MAILGUN_AUTHORITY = createProviderActivationAuthority(MAILGUN_TEST_REGISTRY, [{
  rail: 'mailgun_email',
  providerId: 'mailgun_eu',
  adapterContractVersion: '1.0.0',
}]);
const DISABLED_FOUNDATION_REGISTRY = createProviderRegistry([{
  id: 'social_listener',
  name: 'Disabled social listening foundation',
  kind: 'analytics',
  outboundCredentialAuth: 'oauth2',
  inboundWebhookVerification: 'hmac_signature',
  capabilities: ['social.listen'],
}, {
  id: 'webinar_host',
  name: 'Disabled webinar foundation',
  kind: 'webinar',
  outboundCredentialAuth: 'oauth2',
  inboundWebhookVerification: 'hmac_signature',
  capabilities: ['webinars.manage'],
}]);
const DISABLED_FOUNDATION_AUTHORITY = createProviderActivationAuthority(
  DISABLED_FOUNDATION_REGISTRY,
  [{
    rail: 'social_listening',
    providerId: 'social_listener',
    adapterContractVersion: '1.0.0',
  }, {
    rail: 'webinar',
    providerId: 'webinar_host',
    adapterContractVersion: '1.0.0',
  }],
);

function providerFor(rail: ProviderActivationRail): ProviderReadinessManifestMetadata {
  if (rail === 'mailgun_email') {
    return {
      providerId: 'mailgun_eu',
      kind: 'email',
      outboundCredentialAuth: 'api_key',
      inboundWebhookVerification: 'hmac_signature',
      capabilities: ['conversations.reply'],
      adapterContractVersion: '1.0.0',
    };
  }
  if (rail === 'whatsapp') {
    return {
      providerId: 'whatsapp_cloud',
      kind: 'messaging',
      outboundCredentialAuth: 'oauth2',
      inboundWebhookVerification: 'hmac_signature',
      capabilities: ['channel.whatsapp', 'conversations.reply'],
      adapterContractVersion: '1.0.0',
    };
  }
  if (rail === 'public_social') {
    return {
      providerId: 'social_publisher',
      kind: 'social',
      outboundCredentialAuth: 'oauth2',
      inboundWebhookVerification: 'asymmetric_signature',
      capabilities: ['social.publish'],
      adapterContractVersion: '1.0.0',
    };
  }
  if (rail === 'webinar') {
    return {
      providerId: 'webinar_host',
      kind: 'webinar',
      outboundCredentialAuth: 'oauth2',
      inboundWebhookVerification: 'hmac_signature',
      capabilities: ['webinars.manage'],
      adapterContractVersion: '1.0.0',
    };
  }
  if (rail === 'social_listening') {
    return {
      providerId: 'social_listener',
      kind: 'analytics',
      outboundCredentialAuth: 'oauth2',
      inboundWebhookVerification: 'hmac_signature',
      capabilities: ['social.listen'],
      adapterContractVersion: '1.0.0',
    };
  }
  return {
    providerId: 'social_messages',
    kind: 'social',
    outboundCredentialAuth: 'oauth2',
    inboundWebhookVerification: 'hmac_signature',
    capabilities: ['conversations.reply'],
    adapterContractVersion: '1.0.0',
  };
}

function readyInput(rail: ProviderActivationRail): ProviderActivationReadinessInput {
  const provider = providerFor(rail);
  const nonTargeted = rail === 'public_social' || rail === 'social_listening';
  const input = {
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
        consentRoute: nonTargeted ? 'not_applicable_public_broadcast' : 'individual_consent',
        purpose: rail === 'public_social' ? 'approved_content_publish' : 'internal_seed_validation',
        territories: ['GB'],
        senderReferenceSha256: HASH_D,
        suppressionScope: nonTargeted
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
    evidence: {} as Record<ProviderActivationGate, ProviderGateEvidence>,
  } satisfies ProviderActivationReadinessInput;
  input.evidence = bindAllEvidence(input);
  if (nonTargeted) {
    input.evidence.consent = boundEvidence(input, 'consent', 'not_applicable');
    input.evidence.suppression = boundEvidence(input, 'suppression', 'not_applicable');
  }
  return input;
}

function evidenceIdentity(gate: ProviderActivationGate): { id: string; sha256: string } {
  const ordinal = PROVIDER_ACTIVATION_GATES.indexOf(gate) + 1;
  return {
    id: `70000000-0000-4000-8000-${ordinal.toString(16).padStart(12, '0')}`,
    sha256: ordinal.toString(16).padStart(64, '0'),
  };
}

function boundEvidence(
  input: ProviderActivationReadinessInput,
  gate: ProviderActivationGate,
  status: 'verified' | 'not_applicable' | 'missing' | 'failed' = 'verified',
): ProviderGateEvidence {
  const unavailable = status === 'missing' || status === 'failed';
  const identity = evidenceIdentity(gate);
  return {
    gate,
    rail: input.rail,
    providerId: input.provider.providerId,
    adapterContractVersion: input.provider.adapterContractVersion,
    workspaceId: input.workspace.workspaceId,
    providerConnectionId: input.workspace.providerConnectionId,
    assessedScopeVersion: 1,
    assessedScopeSha256: providerActivationAssessedScopeSha256(input),
    status,
    evidenceId: unavailable ? null : identity.id,
    evidenceSha256: unavailable ? null : identity.sha256,
    verifiedAt: unavailable ? null : VERIFIED_AT,
    expiresAt: unavailable ? null : EXPIRES_AT,
  };
}

function bindAllEvidence(
  input: ProviderActivationReadinessInput,
): Record<ProviderActivationGate, ProviderGateEvidence> {
  return Object.fromEntries(
    PROVIDER_ACTIVATION_GATES.map((gate) => [gate, boundEvidence(input, gate)]),
  ) as Record<ProviderActivationGate, ProviderGateEvidence>;
}

function rebindEvidence(input: ProviderActivationReadinessInput): void {
  const statuses = Object.fromEntries(
    PROVIDER_ACTIVATION_GATES.map((gate) => [gate, input.evidence[gate]?.status ?? 'verified']),
  ) as Record<ProviderActivationGate, ProviderGateEvidence['status']>;
  (input as { evidence: Record<ProviderActivationGate, ProviderGateEvidence> }).evidence =
    Object.fromEntries(PROVIDER_ACTIVATION_GATES.map((gate) => [
      gate,
      boundEvidence(input, gate, statuses[gate]),
    ])) as Record<ProviderActivationGate, ProviderGateEvidence>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function blockerCodes(
  input: ProviderActivationReadinessInput,
  authority: ProviderActivationAuthority = MAILGUN_AUTHORITY,
): string[] {
  return evaluateProviderActivationReadiness(input, NOW, authority).blockingReasons.map((item) => item.code);
}

test('empty production registry denies every rail; an exact injected authority stays dark', () => {
  assert.deepEqual(PROVIDER_ACTIVATION_RAILS, [
    'mailgun_email',
    'whatsapp',
    'public_social',
    'social_dm',
    'webinar',
    'social_listening',
  ]);
  assert.equal(PROVIDER_ACTIVATION_READINESS_CEILING, 'internal_seed_ready');

  assert.ok(Object.isFrozen(PROVIDER_ACTIVATION_RAILS));
  assert.ok(Object.isFrozen(PROVIDER_ACTIVATION_READINESS_STAGES));
  assert.ok(Object.isFrozen(PROVIDER_ACTIVATION_GATES));

  for (const rail of PROVIDER_ACTIVATION_RAILS) {
    const report = evaluateProviderActivationReadiness(readyInput(rail), NOW);
    assert.equal(report.inputAccepted, true, rail);
    assert.equal(report.readiness, 'not_ready', rail);
    assert.equal(report.ceiling, 'internal_seed_ready', rail);
    assert.equal(report.nextStage, 'adapter_contract_verified', rail);
    assert.ok(report.blockingReasons.some((item) => item.code === 'PROVIDER_METADATA_MISMATCH'));
    assert.ok(report.stages.every((stage) => !stage.ready), rail);
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

  const trusted = evaluateProviderActivationReadiness(
    readyInput('mailgun_email'), NOW, MAILGUN_AUTHORITY,
  );
  assert.equal(trusted.readiness, 'internal_seed_ready');
  assert.equal(trusted.nextStage, null);
  assert.deepEqual(trusted.blockingReasons, []);
  assert.equal(trusted.safety.liveAuthorised, false);
  assert.equal(trusted.safety.providerEffectsAllowed, false);
});

test('webinar and social-listening foundations can prove dark readiness without enabling effects', () => {
  for (const rail of ['webinar', 'social_listening'] as const) {
    const report = evaluateProviderActivationReadiness(
      readyInput(rail), NOW, DISABLED_FOUNDATION_AUTHORITY,
    );
    assert.equal(report.inputAccepted, true, rail);
    assert.equal(report.readiness, 'internal_seed_ready', rail);
    assert.equal(report.nextStage, null, rail);
    assert.deepEqual(report.blockingReasons, [], rail);
    assert.deepEqual(report.safety, {
      liveAuthorised: false,
      providerEffectsAllowed: false,
      providerOperationsCreated: 0,
      separateActivationRequired: true,
    });
  }
});

test('stage progression is cumulative and reports the exact next missing proof', () => {
  const missingSeed = clone(readyInput('mailgun_email'));
  (missingSeed.evidence as Record<ProviderActivationGate, ProviderGateEvidence>).internalSeed =
    boundEvidence(missingSeed, 'internalSeed', 'missing');
  const seedReport = evaluateProviderActivationReadiness(missingSeed, NOW, MAILGUN_AUTHORITY);
  assert.equal(seedReport.readiness, 'provider_test_verified');
  assert.equal(seedReport.nextStage, 'internal_seed_ready');
  assert.deepEqual(seedReport.stages.map((stage) => stage.ready), [true, true, false]);
  assert.ok(seedReport.blockingReasons.some((item) => (
    item.code === 'EVIDENCE_MISSING' && item.gate === 'internalSeed'
  )));

  const missingTest = clone(readyInput('mailgun_email'));
  (missingTest.evidence as Record<ProviderActivationGate, ProviderGateEvidence>).testProvider =
    boundEvidence(missingTest, 'testProvider', 'missing');
  const testReport = evaluateProviderActivationReadiness(missingTest, NOW, MAILGUN_AUTHORITY);
  assert.equal(testReport.readiness, 'adapter_contract_verified');
  assert.equal(testReport.nextStage, 'provider_test_verified');
  assert.deepEqual(testReport.stages.map((stage) => stage.ready), [true, false, false]);
  assert.ok(testReport.blockingReasons.some((item) => (
    item.code === 'EVIDENCE_MISSING' && item.gate === 'testProvider'
  )));

  const missingAdapter = clone(readyInput('mailgun_email'));
  (missingAdapter.evidence as Record<ProviderActivationGate, ProviderGateEvidence>).adapterContract =
    boundEvidence(missingAdapter, 'adapterContract', 'failed');
  const adapterReport = evaluateProviderActivationReadiness(missingAdapter, NOW, MAILGUN_AUTHORITY);
  assert.equal(adapterReport.readiness, 'not_ready');
  assert.equal(adapterReport.nextStage, 'adapter_contract_verified');
  assert.ok(adapterReport.blockingReasons.some((item) => (
    item.code === 'EVIDENCE_FAILED' && item.gate === 'adapterContract'
  )));
});

test('stale evidence fails closed with a transparent gate-level reason', () => {
  const input = clone(readyInput('mailgun_email'));
  (input.evidence as Record<ProviderActivationGate, ProviderGateEvidence>).dpa = {
    ...boundEvidence(input, 'dpa'),
    expiresAt: '2026-08-27T11:59:59.999Z',
  };
  const report = evaluateProviderActivationReadiness(input, NOW, MAILGUN_AUTHORITY);
  assert.equal(report.inputAccepted, true);
  assert.equal(report.readiness, 'not_ready');
  assert.ok(report.blockingReasons.some((item) => (
    item.code === 'EVIDENCE_STALE' && item.gate === 'dpa'
  )));
});

test('non-targeted public rails may mark consent and suppression not applicable; direct rails may not', () => {
  const publicReport = evaluateProviderActivationReadiness(readyInput('public_social'), NOW);
  assert.equal(publicReport.readiness, 'not_ready');
  const publicSeed = publicReport.stages.find((stage) => stage.stage === 'internal_seed_ready')!;
  assert.equal(publicSeed.blockers.some((item) => item.code === 'NOT_APPLICABLE_INVALID'), false);
  assert.equal(publicSeed.blockers.some((item) => item.code === 'CHANNEL_POLICY_SCOPE_INVALID'), false);

  const listeningReport = evaluateProviderActivationReadiness(
    readyInput('social_listening'), NOW, DISABLED_FOUNDATION_AUTHORITY,
  );
  const listeningSeed = listeningReport.stages.find(
    (stage) => stage.stage === 'internal_seed_ready',
  )!;
  assert.equal(listeningSeed.blockers.some((item) => item.code === 'NOT_APPLICABLE_INVALID'), false);
  assert.equal(listeningSeed.blockers.some((item) => item.code === 'CHANNEL_POLICY_SCOPE_INVALID'), false);

  const directInput = clone(readyInput('whatsapp'));
  (directInput.scope.policy as { consentRoute: string }).consentRoute =
    'not_applicable_public_broadcast';
  (directInput.scope.policy as { suppressionScope: string }).suppressionScope =
    'public_broadcast_not_applicable';
  rebindEvidence(directInput);
  (directInput.evidence as Record<ProviderActivationGate, ProviderGateEvidence>).consent =
    boundEvidence(directInput, 'consent', 'not_applicable');
  (directInput.evidence as Record<ProviderActivationGate, ProviderGateEvidence>).suppression =
    boundEvidence(directInput, 'suppression', 'not_applicable');
  const directReport = evaluateProviderActivationReadiness(directInput, NOW);
  assert.equal(directReport.inputAccepted, true);
  const directSeed = directReport.stages.find((stage) => stage.stage === 'internal_seed_ready')!;
  assert.ok(directSeed.blockers.some((item) => item.code === 'NOT_APPLICABLE_INVALID'));
  assert.ok(directSeed.blockers.some((item) => item.code === 'CHANNEL_POLICY_SCOPE_INVALID'));
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
    const input = clone(readyInput('mailgun_email'));
    mutation(input);
    rebindEvidence(input);
    const report = evaluateProviderActivationReadiness(input, NOW, MAILGUN_AUTHORITY);
    assert.equal(report.inputAccepted, true);
    assert.equal(report.readiness, 'not_ready');
    assert.ok(report.stages.every((stage) => !stage.ready));
    assert.ok(report.blockingReasons.some((item) => item.code === 'DARK_SWITCH_INVARIANT_FAILED'));
    assert.equal(report.safety.providerEffectsAllowed, false);
  }
});

test('workspace crossover and incomplete isolation evidence fail closed', () => {
  const mismatch = clone(readyInput('mailgun_email'));
  (mismatch.scope.isolation as { workspaceId: string }).workspaceId =
    '88888888-8888-4888-8888-888888888888';
  rebindEvidence(mismatch);
  assert.ok(blockerCodes(mismatch).includes('WORKSPACE_SCOPE_MISMATCH'));

  const isolationGap = clone(readyInput('mailgun_email'));
  (isolationGap.scope.isolation as { rowLevelSecurityEnforced: boolean }).rowLevelSecurityEnforced = false;
  rebindEvidence(isolationGap);
  assert.ok(blockerCodes(isolationGap).includes('WORKSPACE_ISOLATION_UNVERIFIED'));
});

test('credential-shaped input is rejected before parsing and is never echoed into the report', () => {
  const input = clone(readyInput('mailgun_email')) as unknown as Record<string, unknown>;
  input.apiKey = 'must-never-appear';
  const report = evaluateProviderActivationReadiness(input, NOW);
  assert.equal(report.inputAccepted, false);
  assert.equal(report.readiness, 'not_ready');
  assert.equal(report.validationIssues[0]?.code, 'FORBIDDEN_CREDENTIAL_FIELD');
  assert.match(report.validationIssues[0]?.path ?? '', /^input\{field:\d+\}$/u);
  assert.equal(JSON.stringify(report).includes('must-never-appear'), false);
  assert.equal(JSON.stringify(report).includes('apiKey'), false);
  assert.equal(report.safety.liveAuthorised, false);
  assert.equal(report.safety.providerOperationsCreated, 0);
});

test('pre-schema traversal rejects proxies and accessors before executing reflective traps', () => {
  let ownKeysCalls = 0;
  let descriptorCalls = 0;
  let prototypeCalls = 0;
  const alternatingWideProxy = new Proxy({}, {
    getPrototypeOf() {
      prototypeCalls += 1;
      return Object.prototype;
    },
    ownKeys() {
      ownKeysCalls += 1;
      return ownKeysCalls === 1
        ? []
        : Array.from({ length: 50_000 }, (_unused, index) => `opaque_${index}`);
    },
    getOwnPropertyDescriptor() {
      descriptorCalls += 1;
      return { configurable: true, enumerable: true, writable: true, value: true };
    },
  });
  const proxyReport = evaluateProviderActivationReadiness(alternatingWideProxy, NOW);
  assert.equal(proxyReport.inputAccepted, false);
  assert.equal(proxyReport.validationIssues[0]?.code, 'INPUT_NOT_PLAIN_DATA');
  assert.equal(proxyReport.validationIssues[0]?.path, 'input');
  assert.equal(prototypeCalls, 0);
  assert.equal(ownKeysCalls, 0);
  assert.equal(descriptorCalls, 0);

  let getterCalls = 0;
  const accessorInput = {};
  Object.defineProperty(accessorInput, 'opaque', {
    configurable: true,
    enumerable: true,
    get() {
      getterCalls += 1;
      return 'getter-result-must-not-run';
    },
  });
  const accessorReport = evaluateProviderActivationReadiness(accessorInput, NOW);
  assert.equal(accessorReport.inputAccepted, false);
  assert.equal(accessorReport.validationIssues[0]?.code, 'INPUT_NOT_PLAIN_DATA');
  assert.equal(getterCalls, 0);
  assert.equal(JSON.stringify(accessorReport).includes('getter-result-must-not-run'), false);

  const exoticReport = evaluateProviderActivationReadiness(Object.create({ inherited: true }), NOW);
  assert.equal(exoticReport.inputAccepted, false);
  assert.equal(exoticReport.validationIssues[0]?.code, 'INPUT_NOT_PLAIN_DATA');

  const nonJsonPrimitiveReport = evaluateProviderActivationReadiness({ opaque: 1n }, NOW);
  assert.equal(nonJsonPrimitiveReport.inputAccepted, false);
  assert.equal(nonJsonPrimitiveReport.validationIssues[0]?.code, 'INPUT_NOT_PLAIN_DATA');
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
  const exact = readyInput('mailgun_email');
  assert.equal(evaluateProviderActivationReadiness(exact, NOW).readiness, 'not_ready');
  assert.equal(
    evaluateProviderActivationReadiness(exact, NOW, MAILGUN_AUTHORITY).readiness,
    'internal_seed_ready',
  );
  const forgedAuthority = Object.freeze({ authorityVersion: 1 as const, manifestCount: 1 });
  assert.equal(
    evaluateProviderActivationReadiness(exact, NOW, forgedAuthority).readiness,
    'not_ready',
  );

  for (const mutate of [
    (input: ProviderActivationReadinessInput) => {
      (input.provider as { providerId: string }).providerId = 'unregistered_email';
    },
    (input: ProviderActivationReadinessInput) => {
      (input.provider as { kind: string }).kind = 'social';
    },
    (input: ProviderActivationReadinessInput) => {
      (input.provider as { outboundCredentialAuth: string }).outboundCredentialAuth = 'oauth2';
    },
    (input: ProviderActivationReadinessInput) => {
      (input.provider as { inboundWebhookVerification: string }).inboundWebhookVerification =
        'asymmetric_signature';
      (input.scope.webhook as { verificationMode: string }).verificationMode =
        'asymmetric_signature';
    },
    (input: ProviderActivationReadinessInput) => {
      (input.provider as { capabilities: readonly string[] }).capabilities = ['social.publish'];
    },
    (input: ProviderActivationReadinessInput) => {
      (input.provider as { adapterContractVersion: string }).adapterContractVersion = '1.0.1';
    },
  ]) {
    const input = clone(readyInput('mailgun_email'));
    mutate(input);
    rebindEvidence(input);
    const report = evaluateProviderActivationReadiness(input, NOW, MAILGUN_AUTHORITY);
    assert.equal(report.inputAccepted, true);
    assert.equal(report.readiness, 'not_ready');
    assert.ok(report.blockingReasons.some((item) => item.code === 'PROVIDER_METADATA_MISMATCH'));
  }

  assert.throws(() => createProviderActivationAuthority(createProviderRegistry([]), [{
    rail: 'mailgun_email', providerId: 'mailgun_eu', adapterContractVersion: '1.0.0',
  }]), /unknown provider/u);
  assert.throws(() => createProviderActivationAuthority(createProviderRegistry([{
    id: 'mailgun_eu', name: 'Wrong capability fixture', kind: 'email',
    outboundCredentialAuth: 'api_key', inboundWebhookVerification: 'hmac_signature',
    capabilities: ['social.publish'],
  }]), [{
    rail: 'mailgun_email', providerId: 'mailgun_eu', adapterContractVersion: '1.0.0',
  }]), /lacks the required/u);
});

test('simulated transport is hard-ceilinged at adapter-contract readiness', () => {
  const input = clone(readyInput('mailgun_email'));
  (input.scope.testProvider as { mode: string }).mode = 'simulated';
  rebindEvidence(input);
  const report = evaluateProviderActivationReadiness(input, NOW, MAILGUN_AUTHORITY);
  assert.equal(report.inputAccepted, true);
  assert.equal(report.readiness, 'adapter_contract_verified');
  assert.equal(report.nextStage, 'provider_test_verified');
  assert.deepEqual(report.stages.map((stage) => stage.ready), [true, false, false]);
  assert.ok(report.blockingReasons.some((item) => (
    item.code === 'PROVIDER_TEST_SCOPE_INVALID' && item.gate === 'testProvider'
  )));
});

test('evidence is unique, scope-bound, gate-bound and gate-age-bounded', () => {
  const input = readyInput('mailgun_email');
  assert.equal(
    new Set(PROVIDER_ACTIVATION_GATES.map((gate) => input.evidence[gate].evidenceId)).size,
    PROVIDER_ACTIVATION_GATES.length,
  );
  assert.equal(
    new Set(PROVIDER_ACTIVATION_GATES.map((gate) => input.evidence[gate].evidenceSha256)).size,
    PROVIDER_ACTIVATION_GATES.length,
  );

  const wrongGate = clone(input);
  (wrongGate.evidence.dpa as { gate: ProviderActivationGate }).gate = 'security';
  const wrongGateReport = evaluateProviderActivationReadiness(wrongGate, NOW, MAILGUN_AUTHORITY);
  assert.equal(wrongGateReport.inputAccepted, false);
  assert.equal(wrongGateReport.validationIssues[0]?.path, 'input.evidence.dpa');

  const replayedAfterScopeChange = clone(input);
  (replayedAfterScopeChange.scope.caps as { maxSpendPerDayMinorUnits: number })
    .maxSpendPerDayMinorUnits = 2_000;
  const replayReport = evaluateProviderActivationReadiness(
    replayedAfterScopeChange, NOW, MAILGUN_AUTHORITY,
  );
  assert.equal(replayReport.inputAccepted, false);
  assert.match(replayReport.validationIssues[0]?.path ?? '', /^input\.evidence\./u);

  const wrongWorkspaceBinding = clone(input);
  (wrongWorkspaceBinding.evidence.security as { workspaceId: string }).workspaceId =
    '88888888-8888-4888-8888-888888888888';
  const workspaceReport = evaluateProviderActivationReadiness(
    wrongWorkspaceBinding, NOW, MAILGUN_AUTHORITY,
  );
  assert.equal(workspaceReport.inputAccepted, false);

  const replayedProof = clone(input);
  (replayedProof.evidence as Record<ProviderActivationGate, ProviderGateEvidence>).dpa = {
    ...boundEvidence(replayedProof, 'dpa'),
    evidenceId: replayedProof.evidence.security.evidenceId,
    evidenceSha256: replayedProof.evidence.security.evidenceSha256,
  };
  const proofReplayReport = evaluateProviderActivationReadiness(
    replayedProof, NOW, MAILGUN_AUTHORITY,
  );
  assert.equal(proofReplayReport.inputAccepted, false);
  assert.match(proofReplayReport.validationIssues[0]?.message ?? '', /replayed/u);

  const overlong = clone(input);
  (overlong.evidence as Record<ProviderActivationGate, ProviderGateEvidence>).internalSeed = {
    ...boundEvidence(overlong, 'internalSeed'),
    expiresAt: '2026-08-29T06:00:00.000Z',
  };
  const overlongReport = evaluateProviderActivationReadiness(overlong, NOW, MAILGUN_AUTHORITY);
  assert.equal(overlongReport.inputAccepted, false);
  assert.equal(overlongReport.validationIssues[0]?.path, 'input.evidence.internalSeed.expiresAt');
});

test('policy arrays are runtime-frozen and plain-data width and bytes are bounded', () => {
  for (const policy of [
    PROVIDER_ACTIVATION_RAILS,
    PROVIDER_ACTIVATION_READINESS_STAGES,
    PROVIDER_ACTIVATION_GATES,
  ]) {
    const before = [...policy];
    assert.equal(Reflect.set(policy, 0, 'rogue'), false);
    assert.deepEqual(policy, before);
  }

  const wide = clone(readyInput('mailgun_email')) as unknown as Record<string, unknown>;
  for (let index = 0; index < 65; index += 1) wide[`unknown_${index}`] = true;
  const wideReport = evaluateProviderActivationReadiness(wide, NOW, MAILGUN_AUTHORITY);
  assert.equal(wideReport.inputAccepted, false);
  assert.match(wideReport.validationIssues[0]?.message ?? '', /key bound/u);

  const excessiveTotalKeys = {
    branches: Array.from({ length: 32 }, (_unused, branch) => Object.fromEntries(
      Array.from({ length: 40 }, (_innerUnused, field) => [`field_${branch}_${field}`, true]),
    )),
  };
  const totalKeysReport = evaluateProviderActivationReadiness(excessiveTotalKeys, NOW);
  assert.equal(totalKeysReport.inputAccepted, false);
  assert.equal(totalKeysReport.validationIssues[0]?.path, 'input');
  assert.match(totalKeysReport.validationIssues[0]?.message ?? '', /total key bound/u);

  const oversized = clone(readyInput('mailgun_email')) as unknown as Record<string, unknown>;
  oversized.note = 'x'.repeat(1_025);
  const oversizedReport = evaluateProviderActivationReadiness(oversized, NOW, MAILGUN_AUTHORITY);
  assert.equal(oversizedReport.inputAccepted, false);
  assert.match(oversizedReport.validationIssues[0]?.message ?? '', /byte bound/u);

  const excessiveTotalBytes = {
    payload: Array.from(
      { length: 4 },
      () => Array.from({ length: 64 }, () => 'x'.repeat(600)),
    ),
  };
  const totalBytesReport = evaluateProviderActivationReadiness(excessiveTotalBytes, NOW);
  assert.equal(totalBytesReport.inputAccepted, false);
  assert.equal(totalBytesReport.validationIssues[0]?.path, 'input');
  assert.match(totalBytesReport.validationIssues[0]?.message ?? '', /total plain-data byte bound/u);

  const opaqueMarker = 'CALLER_CONTROLLED_OPAQUE_MARKER';
  const opaqueKey = `opaque_${opaqueMarker}_${'x'.repeat(140)}`;
  const opaqueKeyReport = evaluateProviderActivationReadiness({ [opaqueKey]: true }, NOW);
  assert.equal(opaqueKeyReport.inputAccepted, false);
  assert.equal(opaqueKeyReport.validationIssues[0]?.code, 'INPUT_VALUE_INVALID');
  assert.equal(opaqueKeyReport.validationIssues[0]?.path, 'input{field:0}');
  assert.equal(JSON.stringify(opaqueKeyReport).includes(opaqueMarker), false);
  assert.ok((opaqueKeyReport.validationIssues[0]?.path.length ?? 1_000) < 64);
  assert.ok((opaqueKeyReport.validationIssues[0]?.message.length ?? 1_000) < 128);

  const sparse = clone(readyInput('mailgun_email'));
  const capabilities = new Array<string>(2);
  capabilities[0] = 'conversations.reply';
  (sparse.provider as { capabilities: readonly string[] }).capabilities = capabilities;
  const sparseReport = evaluateProviderActivationReadiness(sparse, NOW, MAILGUN_AUTHORITY);
  assert.equal(sparseReport.inputAccepted, false);
  assert.match(sparseReport.validationIssues[0]?.message ?? '', /dense plain-data arrays/u);
});

test('reports are detached from later input mutation and invalid clocks fail closed', () => {
  const input = clone(readyInput('mailgun_email'));
  const report = evaluateProviderActivationReadiness(input, NOW, MAILGUN_AUTHORITY);
  (input.provider as { providerId: string }).providerId = 'changed_after_assessment';
  (input.evidence as Record<ProviderActivationGate, ProviderGateEvidence>).adapterContract =
    boundEvidence(input, 'adapterContract', 'missing');
  assert.equal(report.providerId, 'mailgun_eu');
  assert.equal(report.readiness, 'internal_seed_ready');
  assert.equal(report.stages[0]?.ready, true);

  const invalidClock = evaluateProviderActivationReadiness(
    readyInput('mailgun_email'), new Date(Number.NaN), MAILGUN_AUTHORITY,
  );
  assert.equal(invalidClock.inputAccepted, false);
  assert.equal(invalidClock.validationIssues[0]?.path, 'clock');
  assert.ok(Object.isFrozen(invalidClock.validationIssues));
  assert.ok(Object.isFrozen(invalidClock.validationIssues[0]));
});

test('readiness domain has no adapter, credential, database or provider-operation path', () => {
  const source = readFileSync(
    new URL('../src/provider-activation-readiness/domain.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /from ['"]\.\.\/providers\/(?!registry\.js)[^'"]+['"]/u);
  assert.doesNotMatch(
    source,
    /\b(?:fetch|send|publish|dispatch|enqueue|createProviderOperation)\s*\(/u,
  );
  assert.doesNotMatch(source, /\b(?:process\.env|DATABASE_URL|INSERT INTO|UPDATE\s+app\.)\b/u);
});
