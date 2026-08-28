import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  composePropertyPredatorOpenAiImageRuntime,
  PROPERTY_PREDATOR_OPENAI_IMAGE_BASE_URL,
  type PropertyPredatorOpenAiImageRuntimeDependencies,
} from '../src/company-content-adapter/property-predator-openai-image-runtime.js';
import type {
  PropertyPredatorImageCostEvidenceProvider,
  PropertyPredatorImageInspector,
  PropertyPredatorImagePolicy,
} from '../src/company-content-adapter/property-predator-openai-image.js';

const IMAGE_KEY = 'sk-proj-property-predator-image-only-test-key-000000000000000000';
const OTHER_DIGESTS = Object.freeze({
  PROPERTY_PREDATOR_CONTENT_READ_CREDENTIAL_SHA256: '1'.repeat(64),
  PROPERTY_PREDATOR_CONTENT_SYNC_CREDENTIAL_SHA256: '2'.repeat(64),
  PROPERTY_PREDATOR_TEXT_GENERATION_CREDENTIAL_SHA256: '3'.repeat(64),
});

const policy: PropertyPredatorImagePolicy = {
  async reserve() { return { allowed: false, reasonCode: 'provider_effects_disabled' }; },
  async recordOutcome() {},
};
const costEvidence: PropertyPredatorImageCostEvidenceProvider = {
  async resolveExact(request) {
    return {
      actualCostMinor: 1,
      currency: 'USD',
      usageSha256: request.usageSha256,
      pricingVersionSha256: '4'.repeat(64),
      evidenceSha256: '5'.repeat(64),
    };
  },
};
const inspector: PropertyPredatorImageInspector = {
  async inspectExact(request) {
    return {
      passed: true,
      outputSha256: request.outputSha256,
      rulesSha256: request.rulesSha256,
      paletteWithinBrand: true,
      noText: true,
      noPeople: true,
      noLogos: true,
      noAnimals: true,
      noFakeUi: true,
      inspectionVersionSha256: '6'.repeat(64),
      evidenceSha256: '7'.repeat(64),
    };
  },
};
const commandBoundary = {
  async authorizeExact() {},
};

function darkEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    PROPERTY_PREDATOR_IMAGE_RUNTIME_MODE: 'dark-production',
    PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED: 'false',
    PROPERTY_PREDATOR_IMAGE_PROVIDER_EFFECTS_ENABLED: 'false',
    PROPERTY_PREDATOR_IMAGE_GENERATION_ENABLED: 'false',
    PROPERTY_PREDATOR_IMAGE_EMERGENCY_PAUSED: 'true',
    PROPERTY_PREDATOR_IMAGE_COMMAND_BOUNDARY_ENABLED: 'false',
    ...overrides,
  };
}

function liveEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    PROPERTY_PREDATOR_IMAGE_RUNTIME_MODE: 'review-proposal-live',
    PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED: 'true',
    PROPERTY_PREDATOR_IMAGE_PROVIDER_EFFECTS_ENABLED: 'true',
    PROPERTY_PREDATOR_IMAGE_GENERATION_ENABLED: 'true',
    PROPERTY_PREDATOR_IMAGE_EMERGENCY_PAUSED: 'false',
    PROPERTY_PREDATOR_IMAGE_COMMAND_BOUNDARY_ENABLED: 'true',
    OPENAI_IMAGE_BASE_URL: PROPERTY_PREDATOR_OPENAI_IMAGE_BASE_URL,
    OPENAI_IMAGE_API_KEY: IMAGE_KEY,
    ...OTHER_DIGESTS,
    ...overrides,
  };
}

function liveDependencies(
  overrides: Partial<PropertyPredatorOpenAiImageRuntimeDependencies> = {},
): PropertyPredatorOpenAiImageRuntimeDependencies {
  return {
    env: liveEnvironment(),
    policy,
    costEvidence,
    inspector,
    commandBoundary,
    fetchImpl: async () => { throw new Error('provider call must not run during composition'); },
    ...overrides,
  };
}

test('dark image runtime returns no callable transport even when an image key is pre-staged', () => {
  const runtime = composePropertyPredatorOpenAiImageRuntime({
    env: darkEnvironment({ OPENAI_IMAGE_API_KEY: IMAGE_KEY }),
    policy,
    costEvidence,
    inspector,
  });
  assert.equal(runtime.transport, null);
  assert.equal(runtime.readiness.mode, 'dark-production');
  assert.equal(runtime.readiness.provider.dedicatedCredentialConfigured, true);
  assert.equal(runtime.readiness.composition.commandBoundary, false);
  assert.equal(runtime.readiness.composition.providerAdapterInstantiated, false);
  assert.equal(runtime.readiness.safety.providerEffectsEnabled, false);
  assert.equal(runtime.readiness.safety.imageEffectsEnabled, false);
  assert.equal(runtime.readiness.safety.generationEnabled, false);
  assert.equal(runtime.readiness.safety.emergencyPaused, true);
  assert.equal(runtime.readiness.activationReady, false);
  assert.deepEqual(runtime.readiness.blockers, [
    'PROVIDER_EFFECTS_DISABLED',
    'IMAGE_EFFECTS_DISABLED',
    'IMAGE_GENERATION_DISABLED',
    'IMAGE_EMERGENCY_PAUSED',
    'IMAGE_COMMAND_BOUNDARY_DISABLED',
  ]);
});

test('exact live proposal composition instantiates the rail but makes no provider call', () => {
  let fetchCalls = 0;
  const runtime = composePropertyPredatorOpenAiImageRuntime(liveDependencies({
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error('not expected');
    },
  }));
  assert.ok(runtime.transport);
  assert.equal(fetchCalls, 0);
  assert.equal(runtime.readiness.mode, 'review-proposal-live');
  assert.equal(runtime.readiness.activationReady, true);
  assert.deepEqual(runtime.readiness.blockers, []);
  assert.equal(runtime.readiness.composition.providerAdapterInstantiated, true);
  assert.equal(runtime.readiness.composition.commandBoundary, true);
  assert.equal(runtime.readiness.safety.providerNetworkCallsMadeAtReadiness, false);
  assert.equal(runtime.readiness.safety.publishCapability, false);
  assert.equal(runtime.readiness.safety.customerAttachmentCapability, false);
});

test('the live transport cannot reach request validation or fetch before command authorization', async () => {
  let fetchCalls = 0;
  let authorizationCalls = 0;
  const runtime = composePropertyPredatorOpenAiImageRuntime(liveDependencies({
    commandBoundary: {
      async authorizeExact() {
        authorizationCalls += 1;
        throw new Error('command_not_authorized');
      },
    },
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error('provider call must remain unreachable');
    },
  }));
  await assert.rejects(
    runtime.transport!.generate({} as never),
    /command_not_authorized/,
  );
  assert.equal(authorizationCalls, 1);
  assert.equal(fetchCalls, 0);
});

test('live proposal mode fails closed on every implicit or contradictory action-time switch', () => {
  const settings = [
    'PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED',
    'PROPERTY_PREDATOR_IMAGE_PROVIDER_EFFECTS_ENABLED',
    'PROPERTY_PREDATOR_IMAGE_GENERATION_ENABLED',
    'PROPERTY_PREDATOR_IMAGE_EMERGENCY_PAUSED',
    'PROPERTY_PREDATOR_IMAGE_COMMAND_BOUNDARY_ENABLED',
  ];
  for (const setting of settings) {
    const env = liveEnvironment({ [setting]: undefined });
    assert.throws(
      () => composePropertyPredatorOpenAiImageRuntime(liveDependencies({ env })),
      new RegExp(setting),
      setting,
    );
  }
  assert.throws(() => composePropertyPredatorOpenAiImageRuntime(liveDependencies({
    env: liveEnvironment({ PROPERTY_PREDATOR_IMAGE_RUNTIME_MODE: 'dark-production' }),
  })), /must be exactly false/);
});

test('live proposal mode requires the official endpoint, dedicated key and composed evidence services', () => {
  assert.throws(() => composePropertyPredatorOpenAiImageRuntime(liveDependencies({
    env: liveEnvironment({ OPENAI_IMAGE_BASE_URL: 'https://attacker.example' }),
  })), /OPENAI_IMAGE_BASE_URL/);
  assert.throws(() => composePropertyPredatorOpenAiImageRuntime(liveDependencies({
    env: liveEnvironment({ OPENAI_IMAGE_API_KEY: '' }),
  })), /activation inputs are incomplete/);
  assert.throws(() => composePropertyPredatorOpenAiImageRuntime(liveDependencies({
    policy: undefined,
  })), /activation inputs are incomplete/);
  assert.throws(() => composePropertyPredatorOpenAiImageRuntime(liveDependencies({
    commandBoundary: undefined,
  })), /activation inputs are incomplete/);
  assert.throws(() => composePropertyPredatorOpenAiImageRuntime(liveDependencies({
    env: liveEnvironment({ OPENAI_API_KEY: 'broad-openai-key-that-must-not-enter-image-process' }),
  })), /secret owned by another process/);
  assert.throws(() => composePropertyPredatorOpenAiImageRuntime(liveDependencies({
    env: liveEnvironment({ DATABASE_URL: 'postgresql://owner:secret@db.example/app' }),
  })), /database identity/);
});

test('readiness serialization contains no API key or credential digests', () => {
  const runtime = composePropertyPredatorOpenAiImageRuntime(liveDependencies());
  const serialized = JSON.stringify(runtime.readiness);
  assert.doesNotMatch(serialized, /sk-proj|image-only-test-key/i);
  for (const digest of Object.values(OTHER_DIGESTS)) assert.equal(serialized.includes(digest), false);
  assert.match(serialized, /property-predator-openai-image-api\/v1/);
  assert.match(serialized, /gpt-image-2/);
});

test('production manifest keeps Mailgun dark without outbound credential slots', () => {
  const manifest = readFileSync(
    new URL('../../render.property-predator.production.yaml', import.meta.url),
    'utf8',
  );
  const worker = manifest.slice(manifest.indexOf('name: property-predator-email-worker'));
  assert.match(worker, /key: PROPERTY_PREDATOR_EMAIL_WORKER_MODE\s+value: dark-production/);
  assert.match(worker, /key: PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED\s+value: "false"/);
  assert.match(worker, /key: PROPERTY_PREDATOR_EMAIL_DELIVERY_ENABLED\s+value: "false"/);
  assert.match(worker, /key: PROPERTY_PREDATOR_EMAIL_EMERGENCY_PAUSED\s+value: "true"/);
  assert.doesNotMatch(worker, /key: MAILGUN_REGION\b/);
  assert.doesNotMatch(worker, /key: MAILGUN_SENDING_DOMAIN\b/);
  assert.doesNotMatch(worker, /key: MAILGUN_FROM_EMAIL\b/);
  assert.doesNotMatch(worker, /key: MAILGUN_KEY_SCOPE\b/);
  assert.doesNotMatch(worker, /key: MAILGUN_DOMAIN_SENDING_KEY\b/);
  assert.doesNotMatch(worker, /key: MAILGUN_API_KEY\b/);
  assert.doesNotMatch(worker, /key: MAILGUN_SIGNING_KEY\b/);
});
