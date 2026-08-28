import {
  PROVIDER_ACTIVATION_GATES,
  evaluateProviderActivationReadiness,
  providerActivationAssessedScopeSha256,
  type ProviderActivationGate,
  type ProviderActivationRail,
  type ProviderActivationReadinessInput,
  type ProviderEvidenceStatus,
  type ProviderGateEvidence,
  type ProviderReadinessManifestMetadata,
} from '../provider-activation-readiness/domain.js';
import type {
  PortalProviderReadinessRailSnapshot,
  PortalProviderReadinessSnapshot,
} from './provider-readiness-cockpit-service.js';

export const PROPERTY_PREDATOR_PROVIDER_READINESS_AS_OF = '2026-08-27T12:00:00.000Z';

const WORKSPACE_ID = 'fa100000-0000-4000-8000-000000000001';
const CONNECTION_IDS: Readonly<Record<ProviderActivationRail, string>> = Object.freeze({
  mailgun_email: 'fa200000-0000-4000-8000-000000000001',
  whatsapp: 'fa200000-0000-4000-8000-000000000002',
  public_social: 'fa200000-0000-4000-8000-000000000003',
  social_dm: 'fa200000-0000-4000-8000-000000000004',
  webinar: 'fa200000-0000-4000-8000-000000000005',
  social_listening: 'fa200000-0000-4000-8000-000000000006',
});
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_D = 'd'.repeat(64);

function provider(rail: ProviderActivationRail): ProviderReadinessManifestMetadata {
  if (rail === 'mailgun_email') return {
    providerId: 'mailgun_eu_candidate',
    kind: 'email',
    outboundCredentialAuth: 'api_key',
    inboundWebhookVerification: 'hmac_signature',
    capabilities: ['conversations.reply'],
    adapterContractVersion: '1.0.0',
  };
  if (rail === 'whatsapp') return {
    providerId: 'whatsapp_cloud_candidate',
    kind: 'messaging',
    outboundCredentialAuth: 'oauth2',
    inboundWebhookVerification: 'hmac_signature',
    capabilities: ['channel.whatsapp', 'conversations.reply'],
    adapterContractVersion: '1.0.0',
  };
  if (rail === 'public_social') return {
    providerId: 'social_publisher_candidate',
    kind: 'social',
    outboundCredentialAuth: 'oauth2',
    inboundWebhookVerification: 'asymmetric_signature',
    capabilities: ['social.publish'],
    adapterContractVersion: '1.0.0',
  };
  if (rail === 'webinar') return {
    providerId: 'webinar_host_candidate',
    kind: 'webinar',
    outboundCredentialAuth: 'oauth2',
    inboundWebhookVerification: 'hmac_signature',
    capabilities: ['webinars.manage'],
    adapterContractVersion: '1.0.0',
  };
  if (rail === 'social_listening') return {
    providerId: 'social_listener_candidate',
    kind: 'analytics',
    outboundCredentialAuth: 'oauth2',
    inboundWebhookVerification: 'hmac_signature',
    capabilities: ['social.listen'],
    adapterContractVersion: '1.0.0',
  };
  return {
    providerId: 'social_messages_candidate',
    kind: 'social',
    outboundCredentialAuth: 'oauth2',
    inboundWebhookVerification: 'hmac_signature',
    capabilities: ['conversations.reply'],
    adapterContractVersion: '1.0.0',
  };
}

function evidenceIdentity(gate: ProviderActivationGate): Readonly<{ id: string; sha256: string }> {
  const ordinal = PROVIDER_ACTIVATION_GATES.indexOf(gate) + 1;
  return Object.freeze({
    id: `fa300000-0000-4000-8000-${ordinal.toString(16).padStart(12, '0')}`,
    sha256: ordinal.toString(16).padStart(64, '0'),
  });
}

function boundEvidence(
  input: ProviderActivationReadinessInput,
  gate: ProviderActivationGate,
  status: ProviderEvidenceStatus = 'verified',
  expiresAt = '2026-08-28T06:00:00.000Z',
): ProviderGateEvidence {
  const unavailable = status === 'missing' || status === 'failed';
  const identity = evidenceIdentity(gate);
  return Object.freeze({
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
    verifiedAt: unavailable ? null : '2026-08-27T06:00:00.000Z',
    expiresAt: unavailable ? null : expiresAt,
  });
}

function inputFor(rail: ProviderActivationRail): ProviderActivationReadinessInput {
  const nonTargeted = rail === 'public_social' || rail === 'social_listening';
  const providerMetadata = provider(rail);
  const input: ProviderActivationReadinessInput = {
    schemaVersion: 1,
    rail,
    provider: providerMetadata,
    workspace: {
      workspaceId: WORKSPACE_ID,
      providerConnectionId: CONNECTION_IDS[rail],
    },
    scope: {
      commercialRights: { model: 'white_label_resale', territories: ['GB'] },
      privacy: {
        dpaRoleModel: 'controller_processor',
        dataRegions: ['GB'],
        transferMechanism: 'not_required',
      },
      account: { ownership: 'operator_owned', providerAccountReferenceSha256: HASH_A },
      isolation: {
        workspaceId: WORKSPACE_ID,
        providerConnectionId: CONNECTION_IDS[rail],
        compositeLookupEnforced: true,
        rowLevelSecurityEnforced: true,
        crossWorkspaceTestPassed: true,
      },
      secretManager: {
        manager: 'render_secret',
        referenceId: 'fa400000-0000-4000-8000-000000000001',
        locatorSha256: HASH_B,
      },
      webhook: {
        verificationMode: providerMetadata.inboundWebhookVerification,
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
        approvalId: 'fa500000-0000-4000-8000-000000000001',
        versionId: 'fa600000-0000-4000-8000-000000000001',
        contentSha256: HASH_A,
      },
      caps: {
        currency: 'GBP',
        maxSpendPerOperationMinorUnits: rail === 'mailgun_email' ? 250 : 500,
        maxSpendPerDayMinorUnits: rail === 'mailgun_email' ? 2_500 : 5_000,
        maxSpendPerMonthMinorUnits: rail === 'mailgun_email' ? 25_000 : 50_000,
        maxVolumePerOperation: nonTargeted ? 5 : 1,
        maxVolumePerDay: nonTargeted ? 25 : 10,
        maxVolumePerMonth: nonTargeted ? 250 : 100,
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
        mode: 'simulated',
        fixturePackSha256: HASH_D,
        testRunId: 'fa700000-0000-4000-8000-000000000001',
      },
      internalSeed: {
        destinationScope: 'owned_internal_destinations_only',
        ownershipVerified: true,
        maxDestinations: 10,
        destinationReferenceHashes: [HASH_A],
      },
    },
    evidence: {} as Record<ProviderActivationGate, ProviderGateEvidence>,
  };
  const statuses: Partial<Record<ProviderActivationGate, ProviderEvidenceStatus>> = rail === 'whatsapp'
    ? { security: 'missing', signedWebhook: 'missing', internalSeed: 'missing' }
    : rail === 'social_dm'
      ? { consent: 'missing', approval: 'missing', internalSeed: 'missing' }
      : {};
  const evidence = Object.fromEntries(PROVIDER_ACTIVATION_GATES.map((gate) => {
    if (nonTargeted && (gate === 'consent' || gate === 'suppression')) {
      return [gate, boundEvidence(input, gate, 'not_applicable')];
    }
    const expired = rail === 'public_social' && gate === 'commercialSaasRights';
    return [gate, boundEvidence(
      input,
      gate,
      statuses[gate] ?? 'verified',
      expired ? '2026-08-27T11:00:00.000Z' : undefined,
    )];
  })) as Record<ProviderActivationGate, ProviderGateEvidence>;
  return Object.freeze({ ...input, evidence: Object.freeze(evidence) });
}

const LABELS: Readonly<Record<ProviderActivationRail, string>> = Object.freeze({
  mailgun_email: 'Mailgun email · candidate',
  whatsapp: 'WhatsApp Business · candidate',
  public_social: 'Public social publishing · candidate',
  social_dm: 'Social direct messages · candidate',
  webinar: 'Webinar hosting · candidate',
  social_listening: 'Social listening · candidate',
});

function fixtureRail(rail: ProviderActivationRail): PortalProviderReadinessRailSnapshot {
  const input = inputFor(rail);
  return Object.freeze({
    rail,
    providerLabel: LABELS[rail],
    candidateOnly: true,
    // Default authority intentionally uses the empty production registry.
    // Candidate metadata therefore remains NOT READY until real composition.
    report: evaluateProviderActivationReadiness(
      input,
      new Date(PROPERTY_PREDATOR_PROVIDER_READINESS_AS_OF),
    ),
    caps: Object.freeze({ ...input.scope.caps }),
    switches: Object.freeze({ ...input.scope.switches }),
    evidence: Object.freeze(PROVIDER_ACTIVATION_GATES.map((gate) => Object.freeze({
      gate,
      status: input.evidence[gate].status,
      verifiedAt: input.evidence[gate].verifiedAt,
      expiresAt: input.evidence[gate].expiresAt,
    }))),
  });
}

/** Fictional, read-only metadata. It cannot satisfy or change a live activation gate. */
export function createPropertyPredatorProviderReadinessFixture(): PortalProviderReadinessSnapshot {
  return Object.freeze({
    workspace: Object.freeze({
      workspaceId: WORKSPACE_ID,
      workspaceName: 'Property Predator Growth HQ',
      snapshotAt: PROPERTY_PREDATOR_PROVIDER_READINESS_AS_OF,
    }),
    dataset: 'illustrative_fixture',
    externalEffects: false,
    rails: Object.freeze(([
      'mailgun_email',
      'whatsapp',
      'public_social',
      'social_dm',
      'webinar',
      'social_listening',
    ] as const).map(fixtureRail)),
  });
}
