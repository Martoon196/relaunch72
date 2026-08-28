import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  composePropertyPredatorCampaignDraftRuntime,
  createPropertyPredatorUpstreamAuthoritativeGenerationPolicy,
  PROPERTY_PREDATOR_CAMPAIGN_LOCAL_MAXIMUM_COST_MINOR,
  PROPERTY_PREDATOR_CAMPAIGN_QUOTA_AUTHORITY,
} from '../src/portal/property-predator-campaign-draft-composition.js';
import type {
  PropertyPredatorGenerationPolicyRequest,
} from '../src/company-content-adapter/property-predator-generation.js';

const SHA_A = '1'.repeat(64);
const SHA_B = '2'.repeat(64);
const SHA_C = '3'.repeat(64);
const SHA_D = '4'.repeat(64);

function exactEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    PORTAL_PRODUCT_PROFILE: 'property_predator_growth',
    PROPERTY_PREDATOR_CAMPAIGN_GENERATION_ENABLED: 'true',
    PROPERTY_PREDATOR_CAMPAIGN_GENERATION_PROVIDER_EFFECTS_ENABLED: 'true',
    PROPERTY_PREDATOR_CAMPAIGN_GENERATION_EMERGENCY_PAUSED: 'false',
    PROPERTY_PREDATOR_COMPANY_CONTENT_ORIGIN: 'http://127.0.0.1:43210',
    PROPERTY_PREDATOR_COMPANY_CONTENT_ALLOW_LOCAL_HTTP: 'true',
    PROPERTY_PREDATOR_COMPANY_CONTENT_CLIENT_ID: 'growth-hq-review-drafts',
    PROPERTY_PREDATOR_COMPANY_CONTENT_GENERATE_TOKEN:
      'test-only-campaign-generate-token-0000000000000001',
    PROPERTY_PREDATOR_COMPANY_CONTENT_READ_TOKEN:
      'test-only-company-content-read-token-00000000000000001',
    DATABASE_CONTENT_ADAPTER_URL:
      'postgresql://r72_content_adapter:test-only@localhost/relaunch72_test',
    PROPERTY_PREDATOR_COMPANY_CONTENT_TIMEOUT_MS: '8000',
    ...overrides,
  };
}

function policyRequest(
  maximumCostMinor = PROPERTY_PREDATOR_CAMPAIGN_LOCAL_MAXIMUM_COST_MINOR,
): PropertyPredatorGenerationPolicyRequest {
  return Object.freeze({
    requestSha256: SHA_A,
    idempotencyKeySha256: SHA_B,
    expectedBrandSha256: SHA_C,
    contextSha256: SHA_D,
    kind: 'post',
    requestBytes: 256,
    maximumCostMinor,
  });
}

test('campaign generation is dark by default and incomplete settings expose no runtime', () => {
  const entirelyDark = composePropertyPredatorCampaignDraftRuntime({
    PORTAL_PRODUCT_PROFILE: 'property_predator_growth',
  });
  assert.equal(entirelyDark.runtime, undefined);
  assert.equal(entirelyDark.readiness.state, 'disabled');
  assert.equal(entirelyDark.readiness.providerEffects, 'none');
  assert.equal(entirelyDark.readiness.outboundEffects, false);
  assert.equal(entirelyDark.readiness.publishCapability, false);
  assert.equal(entirelyDark.readiness.sendCapability, false);
  assert.equal(entirelyDark.readiness.scheduleCapability, false);

  const incomplete = composePropertyPredatorCampaignDraftRuntime({
    PORTAL_PRODUCT_PROFILE: 'property_predator_growth',
    PROPERTY_PREDATOR_COMPANY_CONTENT_ORIGIN: 'https://propertypredator.com',
    PROPERTY_PREDATOR_COMPANY_CONTENT_CLIENT_ID: 'growth-hq-review-drafts',
  });
  assert.equal(incomplete.runtime, undefined);
  assert.ok(incomplete.readiness.blockers.includes('GENERATION_CREDENTIALS_INCOMPLETE'));
});

test('campaign generation settings are forbidden on every other product profile', () => {
  assert.throws(
    () => composePropertyPredatorCampaignDraftRuntime({
      PORTAL_PRODUCT_PROFILE: 'relaunch72',
      PROPERTY_PREDATOR_CAMPAIGN_GENERATION_ENABLED: 'true',
    }),
    /forbidden outside property_predator_growth/,
  );
});

test('exact review-generation composition makes no network call at readiness', () => {
  let calls = 0;
  const composition = composePropertyPredatorCampaignDraftRuntime(exactEnv(), {
    fetchImpl: async () => {
      calls += 1;
      throw new Error('readiness must not call the source');
    },
  });

  assert.ok(composition.runtime);
  assert.equal(calls, 0);
  assert.deepEqual(composition.readiness, {
    state: 'review-generation-ready',
    quotaAuthority: PROPERTY_PREDATOR_CAMPAIGN_QUOTA_AUTHORITY,
    localMaximumCostMinor: 250,
    providerEffects: 'generation_only',
    outboundEffects: false,
    publishCapability: false,
    sendCapability: false,
    scheduleCapability: false,
    providerNetworkCallsMadeAtReadiness: false,
    blockers: [],
  });
  assert.deepEqual(Object.keys(composition.runtime).sort(), []);
  assert.equal('send' in composition.runtime, false);
  assert.equal('publish' in composition.runtime, false);
  assert.equal('schedule' in composition.runtime, false);
});

test('a fully activated composition rejects permissive origins and bad credential evidence', () => {
  assert.throws(
    () => composePropertyPredatorCampaignDraftRuntime(exactEnv({
      PROPERTY_PREDATOR_COMPANY_CONTENT_ORIGIN: 'https://propertypredator.com.evil.test',
      PROPERTY_PREDATOR_COMPANY_CONTENT_ALLOW_LOCAL_HTTP: 'false',
    })),
    /exact propertypredator.com origin/,
  );
  assert.throws(
    () => composePropertyPredatorCampaignDraftRuntime(exactEnv({
      PROPERTY_PREDATOR_COMPANY_CONTENT_READ_TOKEN:
        'test-only-campaign-generate-token-0000000000000001',
    })),
    /generation bridge configuration is invalid/,
  );
  assert.throws(
    () => composePropertyPredatorCampaignDraftRuntime(exactEnv({
      NODE_ENV: 'production',
    })),
    /Local HTTP campaign generation source is forbidden in production/,
  );
});

test('the local policy is a deterministic one-call ceiling, not a restart-sensitive quota ledger', async () => {
  const policy = createPropertyPredatorUpstreamAuthoritativeGenerationPolicy();
  const first = await policy.reserve(policyRequest());
  const replay = await policy.reserve(policyRequest());
  assert.equal(first.allowed, true);
  assert.deepEqual(replay, first);
  if (!first.allowed) assert.fail('expected the exact bounded post to be admitted');
  assert.match(first.reservationId, /^upstream-authority:[0-9a-f]{64}$/u);
  assert.equal(first.availableRequestSlots, 1);
  assert.equal(first.availableSpendMinor, 250);
  assert.equal(first.approvedMaximumCostMinor, 250);

  assert.deepEqual(await policy.reserve(policyRequest(251)), {
    allowed: false,
    reasonCode: 'spend_exhausted',
  });
  assert.deepEqual(await policy.reserve({ ...policyRequest(), kind: 'email' }), {
    allowed: false,
    reasonCode: 'policy_unavailable',
  });
});

test('PostgreSQL and server composition pass the review-only runtime into the portal', async () => {
  const [platform, provision, server] = await Promise.all([
    readFile(new URL('../src/portal/postgres-platform.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/portal/provision.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/server/index.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(platform, /composePropertyPredatorCampaignDraftRuntime\(env\)/u);
  assert.match(
    platform,
    /campaignDrafts:\s*companyContent\s*&&\s*brandBrain\s*\?\s*campaignDraftComposition\.runtime/u,
  );
  assert.match(provision, /campaignDrafts:\s*cfg\.campaignDrafts/u);
  assert.match(server, /campaignDrafts:\s*postgresPortal\.campaignDrafts/u);
});
