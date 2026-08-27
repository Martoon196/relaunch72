import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  PROPERTY_PREDATOR_GROWTH_HQ_BRIDGE_CONTRACT,
  CompanyAssetReleaseContractError,
} from '../src/company-asset-release/domain.js';
import {
  createPropertyPredatorCompanyAssetBridgeTransport,
} from '../src/company-asset-release/property-predator-bridge-transport.js';
import {
  PROPERTY_PREDATOR_AI_RUNTIME_BRAND_V1_SHA256,
  canonicalPropertyPredatorAiInventoryJson,
} from '../src/company-content-adapter/property-predator-ai-inventory.js';

const TOKEN = 'test-only-company-content-read-token-0000000001';
const VERSION_ID = '22222222-2222-4222-8222-222222222222';
const FIXTURE_URL = new URL('./fixtures/property-predator-ai-inventory-v1.golden.json', import.meta.url);

function digest(value: unknown): string {
  return createHash('sha256')
    .update(canonicalPropertyPredatorAiInventoryJson(value), 'utf8')
    .digest('hex');
}

async function bridgeFixture(): Promise<Record<string, unknown>> {
  const release = {
    approvedItemCount: 1,
    approvedItems: [{
      affiliateMode: 'forbidden', approvalExpiresAt: null, approvalExpiryStatus: 'missing',
      approvalId: 'source-approval-asset-4', approvedAt: '2026-08-27T09:10:11.123456+00:00',
      assetResourcePath: `/api/internal/company-content/assets/${VERSION_ID}/file`,
      blobSha256: 'e'.repeat(64), brandSha256: PROPERTY_PREDATOR_AI_RUNTIME_BRAND_V1_SHA256,
      contentMode: 'company-owned',
      contentResourcePath: `/api/internal/company-content/versions/${VERSION_ID}`,
      contentSha256: 'd'.repeat(64), hqUseStatus: 'review-required',
      itemId: 'asset:company-evidence-card', itemType: 'asset', itemVersion: 4,
      ownershipStatus: 'source-asserted-company-owned',
      privacyStatus: 'customer-private-data-forbidden',
      quarantineStatus: 'not-recorded-at-source',
      sourceApprovalStatus: 'source-approved-exact-version', versionId: VERSION_ID,
    }],
    brandBrain: {
      hqUseStatus: 'review-required',
      manifest: JSON.parse(await readFile(FIXTURE_URL, 'utf8')) as unknown,
      runtimeBrandSha256: PROPERTY_PREDATOR_AI_RUNTIME_BRAND_V1_SHA256,
      sourceApprovalStatus: 'source-current',
    },
    contract: JSON.parse(JSON.stringify(PROPERTY_PREDATOR_GROWTH_HQ_BRIDGE_CONTRACT)) as unknown,
    releaseId: 'property-predator.company-content-growth-hq/v1',
    sourceCatalogSha256: 'c'.repeat(64), sourceSystem: 'property-predator',
  };
  return {
    generatedAt: '2026-08-27T09:12:00+00:00', release,
    releaseSha256: digest(release), schemaVersion: 1,
  };
}

test('loads only the exact metadata bridge through a bounded authenticated GET', async () => {
  const fixture = await bridgeFixture();
  let observedUrl = '';
  let observedInit: RequestInit | undefined;
  const transport = createPropertyPredatorCompanyAssetBridgeTransport({
    baseUrl: 'https://propertypredator.example', clientId: 'growth-hq', readToken: TOKEN,
    fetchImpl: async (input, init) => {
      observedUrl = String(input);
      observedInit = init;
      return new Response(JSON.stringify(fixture), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    },
  });
  const release = await transport.loadRelease();
  assert.equal(observedUrl, 'https://propertypredator.example/api/internal/company-content/bridge');
  assert.equal(observedInit?.method, 'GET');
  assert.equal(observedInit?.redirect, 'error');
  assert.equal(observedInit?.credentials, 'omit');
  assert.equal(observedInit?.body, undefined);
  const headers = observedInit?.headers as Record<string, string>;
  assert.equal(headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(headers['x-content-client'], 'growth-hq');
  assert.equal(release.releaseSha256, fixture.releaseSha256);
  assert.equal(release.usable, false);
  assert.deepEqual(release.usabilityReasonCodes, [
    'hq_human_approval_required',
    'source_approval_expiry_missing',
    'source_quarantine_unknown',
  ]);
  assert.deepEqual(Object.keys(transport), ['loadRelease']);
  assert.equal(JSON.stringify(transport), '{}');
});

test('refuses unsafe origins, credentials, selectors and timeouts before fetch', () => {
  const base = { clientId: 'growth-hq', readToken: TOKEN, fetchImpl: async () => new Response('{}') };
  for (const baseUrl of [
    'http://propertypredator.example',
    'https://user:secret@propertypredator.example',
    'https://propertypredator.example/path',
    'https://propertypredator.example?selector=all',
    'https://propertypredator.example#fragment',
  ]) {
    assert.throws(
      () => createPropertyPredatorCompanyAssetBridgeTransport({ ...base, baseUrl }),
      CompanyAssetReleaseContractError,
    );
  }
  assert.throws(() => createPropertyPredatorCompanyAssetBridgeTransport({
    ...base, baseUrl: 'https://propertypredator.example', clientId: 'bad client',
  }), CompanyAssetReleaseContractError);
  assert.throws(() => createPropertyPredatorCompanyAssetBridgeTransport({
    ...base, baseUrl: 'https://propertypredator.example', readToken: 'short',
  }), CompanyAssetReleaseContractError);
  assert.throws(() => createPropertyPredatorCompanyAssetBridgeTransport({
    ...base, baseUrl: 'https://propertypredator.example', timeoutMs: 31_000,
  }), CompanyAssetReleaseContractError);
});

test('allows explicit localhost HTTP only for tests', async () => {
  const fixture = await bridgeFixture();
  const transport = createPropertyPredatorCompanyAssetBridgeTransport({
    baseUrl: 'http://127.0.0.1:43172', clientId: 'growth-hq', readToken: TOKEN,
    allowLocalHttp: true,
    fetchImpl: async () => new Response(JSON.stringify(fixture), {
      headers: { 'content-type': 'application/problem+json' },
    }),
  });
  await assert.doesNotReject(transport.loadRelease());
  assert.throws(() => createPropertyPredatorCompanyAssetBridgeTransport({
    baseUrl: 'http://127.0.0.1:43172', clientId: 'growth-hq', readToken: TOKEN,
  }), CompanyAssetReleaseContractError);
});

test('fails closed on status, media type, length, UTF-8, JSON and bridge contract errors', async () => {
  const options = (fetchImpl: typeof fetch) => ({
    baseUrl: 'https://propertypredator.example', clientId: 'growth-hq', readToken: TOKEN, fetchImpl,
  });
  const attempts: typeof fetch[] = [
    async () => new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } }),
    async () => new Response('{}', { headers: { 'content-type': 'text/html' } }),
    async () => new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '999999' } }),
    async () => new Response(new Uint8Array([0xc3, 0x28]), { headers: { 'content-type': 'application/json' } }),
    async () => new Response('{', { headers: { 'content-type': 'application/json' } }),
    async () => new Response('{}', { headers: { 'content-type': 'application/json' } }),
  ];
  for (const fetchImpl of attempts) {
    await assert.rejects(
      createPropertyPredatorCompanyAssetBridgeTransport(options(fetchImpl)).loadRelease(),
      CompanyAssetReleaseContractError,
    );
  }
});

test('stream byte cap stops an undeclared oversized response', async () => {
  const oversized = new Uint8Array(512 * 1024 + 1);
  const transport = createPropertyPredatorCompanyAssetBridgeTransport({
    baseUrl: 'https://propertypredator.example', clientId: 'growth-hq', readToken: TOKEN,
    fetchImpl: async () => new Response(oversized, { headers: { 'content-type': 'application/json' } }),
  });
  await assert.rejects(transport.loadRelease(), /exceeds the byte bound/);
});

test('absolute deadline rejects fetch and body implementations that ignore abort', async () => {
  const common = {
    baseUrl: 'https://propertypredator.example', clientId: 'growth-hq',
    readToken: TOKEN, timeoutMs: 100,
  } as const;
  const startedFetch = Date.now();
  await assert.rejects(createPropertyPredatorCompanyAssetBridgeTransport({
    ...common,
    fetchImpl: async () => new Promise<Response>(() => {}),
  }).loadRelease(), /request timed out/);
  assert.ok(Date.now() - startedFetch < 1_000);

  const hangingBody = new ReadableStream<Uint8Array>({
    pull: async () => new Promise<void>(() => {}),
  });
  const startedBody = Date.now();
  await assert.rejects(createPropertyPredatorCompanyAssetBridgeTransport({
    ...common,
    fetchImpl: async () => new Response(hangingBody, {
      headers: { 'content-type': 'application/json' },
    }),
  }).loadRelease(), /request timed out/);
  assert.ok(Date.now() - startedBody < 1_000);
});

test('transmits an immutable endpoint identity and rejects runtime-coerced client identities', async () => {
  const fixture = await bridgeFixture();
  const observed: string[] = [];
  const transport = createPropertyPredatorCompanyAssetBridgeTransport({
    baseUrl: 'https://propertypredator.example', clientId: 'growth-hq', readToken: TOKEN,
    fetchImpl: async (input) => {
      assert.equal(typeof input, 'string');
      observed.push(String(input));
      return new Response(JSON.stringify(fixture), {
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    },
  });
  await transport.loadRelease();
  await transport.loadRelease();
  assert.deepEqual(observed, [
    'https://propertypredator.example/api/internal/company-content/bridge',
    'https://propertypredator.example/api/internal/company-content/bridge',
  ]);
  assert.throws(() => createPropertyPredatorCompanyAssetBridgeTransport({
    baseUrl: 'https://propertypredator.example',
    clientId: { toString: () => 'growth-hq' } as unknown as string,
    readToken: TOKEN,
  }), /client identity is invalid/);
});

test('accepts only JSON or structured JSON with an optional UTF-8 charset', async () => {
  const fixture = await bridgeFixture();
  for (const contentType of ['application/json; garbage', 'application/json; charset=utf-16']) {
    const transport = createPropertyPredatorCompanyAssetBridgeTransport({
      baseUrl: 'https://propertypredator.example', clientId: 'growth-hq', readToken: TOKEN,
      fetchImpl: async () => new Response(JSON.stringify(fixture), { headers: { 'content-type': contentType } }),
    });
    await assert.rejects(transport.loadRelease(), /media type is invalid/);
  }
});

test('transport source has no content-body, asset-byte, generation, model or provider operation method', async () => {
  const source = await readFile(
    new URL('../src/company-asset-release/property-predator-bridge-transport.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /versions\/\$|assets\/\$|generate_company|generateDraft|modelCall|publish|provider_operations|sendMessage/i);
  assert.match(source, /\/api\/internal\/company-content\/bridge/);
  assert.doesNotMatch(source, /console\.|response\.json\(\)|response body.*message/i);
});
