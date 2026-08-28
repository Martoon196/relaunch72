import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  PROPERTY_PREDATOR_GENERATE_CREDENTIAL_BOUNDARY,
  PropertyPredatorGenerationBridgeError,
  createPropertyPredatorGenerationTransport,
  type PropertyPredatorGenerateDraftCommand,
  type PropertyPredatorGeneratedPayload,
  type PropertyPredatorGenerationPolicy,
  type PropertyPredatorGenerationPolicyOutcome,
  type PropertyPredatorGenerationPolicyRequest,
} from '../src/company-content-adapter/property-predator-generation.js';
import { canonicalCompanyContentJson } from '../src/company-content-pg/validation.js';

const GENERATE_TOKEN = 'test-only-company-content-generate-token-0000000001';
const READ_TOKEN = 'test-only-company-content-read-token-0000000000001';
const SYNC_TOKEN = 'test-only-company-content-sync-token-0000000000001';
const BRAND_SHA256 = 'b'.repeat(64);
const VERSION_ID = '22222222-2222-4222-8222-222222222222';
const DRAFT_ID = '33333333-3333-4333-8333-333333333333';

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

const CREDENTIAL = Object.freeze({
  boundary: PROPERTY_PREDATOR_GENERATE_CREDENTIAL_BOUNDARY,
  clientId: 'growth-hq-generate',
  generateToken: GENERATE_TOKEN,
  readCredentialSha256: digest(READ_TOKEN),
  syncCredentialSha256: digest(SYNC_TOKEN),
});

const APPROVED_CTA_HOSTS = Object.freeze(['propertypredator.com', 'www.propertypredator.com']);

const COMMAND: PropertyPredatorGenerateDraftCommand = Object.freeze({
  idempotencyKey: 'growth-hq-draft-000001',
  expectedBrandSha256: BRAND_SHA256,
  maximumCostMinor: 25,
  brief: Object.freeze({
    kind: 'post',
    platform: 'linkedin',
    topic: 'A practical guide to evaluating an investment property',
    tone: 'direct',
  }),
});

function generatedPayload(
  patch: Partial<PropertyPredatorGeneratedPayload> = {},
): PropertyPredatorGeneratedPayload {
  return {
    body: 'Use evidence, inspect the numbers, and make a deliberate decision.',
    cta_url: 'https://propertypredator.com/learn',
    kind: 'post',
    platform: 'linkedin',
    schema: 'propertypredator.company-content/v1',
    title: 'Evaluate the deal before the excitement',
    type: 'generated',
    ...patch,
  };
}

function generatedFixture(
  patch: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  const payload = (patch.payload ?? generatedPayload()) as PropertyPredatorGeneratedPayload;
  const usage = (patch.usage ?? {
    actualCostMinor: 12,
    inputTokens: 1_250,
    model: 'claude-sonnet-4-6',
    outputTokens: 480,
    providerRequestId: 'provider-request-00000001',
  }) as Record<string, unknown>;
  return {
    ok: true,
    schemaVersion: 1,
    brandSha256: BRAND_SHA256,
    contentSha256: digest(canonicalCompanyContentJson(payload)),
    draftId: DRAFT_ID,
    itemVersion: 1,
    payload,
    status: 'source_review_required',
    usage,
    usageSha256: patch.usageSha256 ?? digest(canonicalCompanyContentJson(usage)),
    versionId: VERSION_ID,
    ...patch,
  };
}

function generatedResponse(
  fixture: Record<string, unknown>,
  init: Readonly<{
    status?: number;
    headers?: Record<string, string>;
    body?: BodyInit;
  }> = {},
): Response {
  const body = init.body ?? JSON.stringify(fixture);
  return new Response(body, {
    status: init.status ?? 201,
    headers: {
      'cache-control': 'private, no-store',
      'content-type': 'application/json; charset=utf-8',
      ...init.headers,
    },
  });
}

function allowedPolicy(): Readonly<{
  policy: PropertyPredatorGenerationPolicy;
  reservations: PropertyPredatorGenerationPolicyRequest[];
  outcomes: PropertyPredatorGenerationPolicyOutcome[];
}> {
  const reservations: PropertyPredatorGenerationPolicyRequest[] = [];
  const outcomes: PropertyPredatorGenerationPolicyOutcome[] = [];
  return {
    reservations,
    outcomes,
    policy: {
      async reserve(request) {
        reservations.push(request);
        return {
          allowed: true,
          reservationId: `generation-reservation-${reservations.length.toString().padStart(4, '0')}`,
          generationEnabled: true,
          providerEffectsEnabled: true,
          emergencyPaused: false,
          availableRequestSlots: 10,
          availableSpendMinor: 1_000,
          approvedMaximumCostMinor: request.maximumCostMinor,
        };
      },
      async recordOutcome(outcome) {
        outcomes.push(outcome);
      },
    },
  };
}

function baseOptions(policy?: PropertyPredatorGenerationPolicy, fetchImpl?: typeof fetch) {
  return {
    baseUrl: 'https://propertypredator.example',
    credential: CREDENTIAL,
    approvedCtaHosts: APPROVED_CTA_HOSTS,
    ...(policy ? { policy } : {}),
    ...(fetchImpl ? { fetchImpl } : {}),
  };
}

test('stays dark by default and never reaches a provider without an explicit policy', async () => {
  let fetchCalls = 0;
  const transport = createPropertyPredatorGenerationTransport(baseOptions(undefined, async () => {
    fetchCalls += 1;
    return generatedResponse(generatedFixture());
  }));
  await assert.rejects(transport.generateDraft(COMMAND), (error: unknown) => {
    assert.ok(error instanceof PropertyPredatorGenerationBridgeError);
    assert.equal(error.code, 'effects_disabled');
    return true;
  });
  assert.equal(fetchCalls, 0);
  assert.deepEqual(Object.keys(transport), ['generateDraft']);
  assert.equal(JSON.stringify(transport), '{}');
});

test('uses the exact generate-only POST boundary and returns an immutable hash-verified draft', async () => {
  const controls = allowedPolicy();
  let observedUrl = '';
  let observedInit: RequestInit | undefined;
  const transport = createPropertyPredatorGenerationTransport(baseOptions(
    controls.policy,
    async (input, init) => {
      observedUrl = String(input);
      observedInit = init;
      return generatedResponse(generatedFixture());
    },
  ));
  const draft = await transport.generateDraft(COMMAND);
  assert.equal(observedUrl, 'https://propertypredator.example/api/internal/company-content/generate');
  assert.equal(observedInit?.method, 'POST');
  assert.equal(observedInit?.cache, 'no-store');
  assert.equal(observedInit?.credentials, 'omit');
  assert.equal(observedInit?.redirect, 'error');
  assert.equal(observedInit?.referrerPolicy, 'no-referrer');
  const body = String(observedInit?.body);
  assert.equal(body, canonicalCompanyContentJson({
    brief: COMMAND.brief,
    expectedBrandSha256: COMMAND.expectedBrandSha256,
    maximumCostMinor: COMMAND.maximumCostMinor,
    schema: 'propertypredator.company-content.generate/v1',
  }));
  const headers = observedInit?.headers as Record<string, string>;
  assert.equal(headers.authorization, `Bearer ${GENERATE_TOKEN}`);
  assert.equal(headers['x-content-client'], 'growth-hq-generate');
  assert.equal(headers['idempotency-key'], COMMAND.idempotencyKey);
  assert.equal(headers['content-length'], String(Buffer.byteLength(body, 'utf8')));
  assert.equal(Object.values(headers).includes(READ_TOKEN), false);
  assert.equal(Object.values(headers).includes(SYNC_TOKEN), false);
  assert.equal(draft.contentSha256, digest(canonicalCompanyContentJson(draft.payload)));
  assert.equal(draft.status, 'source_review_required');
  assert.ok(Object.isFrozen(draft));
  assert.ok(Object.isFrozen(draft.payload));
  assert.ok(Object.isFrozen(draft.usage));
  assert.equal(draft.usage.actualCostMinor, 12);
  assert.equal(draft.usageSha256, digest(canonicalCompanyContentJson(draft.usage)));

  assert.equal(controls.reservations.length, 1);
  assert.deepEqual(controls.outcomes, [{
    reservationId: 'generation-reservation-0001',
    requestSha256: digest(body),
    idempotencyKeySha256: digest(COMMAND.idempotencyKey),
    outcome: 'accepted',
    effectState: 'confirmed_version',
    safeErrorCode: null,
    versionId: VERSION_ID,
    contentSha256: draft.contentSha256,
    actualCostMinor: 12,
    inputTokens: 1_250,
    outputTokens: 480,
    model: 'claude-sonnet-4-6',
    providerRequestId: 'provider-request-00000001',
    usageSha256: draft.usageSha256,
  }]);
  const controlJson = JSON.stringify({
    reservations: controls.reservations,
    outcomes: controls.outcomes,
  });
  assert.doesNotMatch(controlJson, /investment property|test-only-company-content|growth-hq-draft/i);
});

test('requires a distinct strong generate credential and a clean immutable origin', () => {
  const base = baseOptions(allowedPolicy().policy, async () => generatedResponse(generatedFixture()));
  const invalid: unknown[] = [
    { ...base, baseUrl: 'http://propertypredator.example' },
    { ...base, baseUrl: 'https://user:secret@propertypredator.example' },
    { ...base, baseUrl: 'https://propertypredator.example/path' },
    { ...base, baseUrl: 'https://propertypredator.example?mode=generate' },
    { ...base, credential: { ...CREDENTIAL, boundary: 'property-predator-company-content-read/v1' } },
    { ...base, credential: { ...CREDENTIAL, clientId: 'bad client' } },
    { ...base, credential: { ...CREDENTIAL, generateToken: 'short' } },
    { ...base, credential: { ...CREDENTIAL, readCredentialSha256: '' } },
    { ...base, credential: { ...CREDENTIAL, syncCredentialSha256: CREDENTIAL.readCredentialSha256 } },
    {
      ...base,
      credential: {
        ...CREDENTIAL,
        readCredentialSha256: digest(GENERATE_TOKEN),
      },
    },
    {
      ...base,
      credential: {
        ...CREDENTIAL,
        syncCredentialSha256: digest(GENERATE_TOKEN),
      },
    },
    { ...base, approvedCtaHosts: [] },
    { ...base, approvedCtaHosts: ['PropertyPredator.com'] },
    { ...base, approvedCtaHosts: ['*.propertypredator.com'] },
    { ...base, approvedCtaHosts: ['attacker.example'] },
    { ...base, approvedCtaHosts: ['propertypredator.com', 'propertypredator.com'] },
    { ...base, timeoutMs: 30_001 },
  ];
  for (const options of invalid) {
    assert.throws(
      () => createPropertyPredatorGenerationTransport(options as Parameters<typeof createPropertyPredatorGenerationTransport>[0]),
      (error: unknown) => error instanceof PropertyPredatorGenerationBridgeError
        && error.code === 'invalid_configuration',
    );
  }
});

test('allows localhost HTTP only through the explicit test escape hatch', async () => {
  const controls = allowedPolicy();
  const transport = createPropertyPredatorGenerationTransport({
    ...baseOptions(controls.policy, async () => generatedResponse(generatedFixture())),
    baseUrl: 'http://127.0.0.1:43172',
    allowLocalHttp: true,
  });
  await assert.doesNotReject(transport.generateDraft(COMMAND));
  assert.throws(() => createPropertyPredatorGenerationTransport({
    ...baseOptions(controls.policy),
    baseUrl: 'http://127.0.0.1:43172',
  }), /configuration is invalid/);
});

test('rejects non-exact, private, attributed and unbounded requests before policy or fetch', async () => {
  const controls = allowedPolicy();
  let fetchCalls = 0;
  const transport = createPropertyPredatorGenerationTransport(baseOptions(controls.policy, async () => {
    fetchCalls += 1;
    return generatedResponse(generatedFixture());
  }));
  const accessor = { ...COMMAND } as Record<string, unknown>;
  Object.defineProperty(accessor, 'brief', { enumerable: true, get: () => COMMAND.brief });
  const symbol = { ...COMMAND, [Symbol('hidden')]: true };
  const hostileProxy = new Proxy(COMMAND, {
    getPrototypeOf() { throw new Error(`${GENERATE_TOKEN} proxy trap`); },
  });
  const invalid: unknown[] = [
    { ...COMMAND, extra: true },
    accessor,
    symbol,
    hostileProxy,
    { ...COMMAND, idempotencyKey: 'too-short' },
    { ...COMMAND, expectedBrandSha256: 'A'.repeat(64) },
    { ...COMMAND, maximumCostMinor: 0 },
    { ...COMMAND, brief: { ...COMMAND.brief, topic: ' person@example.com ' } },
    { ...COMMAND, brief: { ...COMMAND.brief, topic: 'Call 07123 456789 today' } },
    { ...COMMAND, brief: { ...COMMAND.brief, topic: 'Lead email: hidden value' } },
    { ...COMMAND, brief: { ...COMMAND.brief, topic: 'Use our affiliate link' } },
    { ...COMMAND, brief: { ...COMMAND.brief, topic: 'Review https://example.com/private' } },
    { ...COMMAND, brief: { ...COMMAND.brief, topic: '<strong>Generate this</strong>' } },
    { ...COMMAND, brief: { ...COMMAND.brief, topic: 'x'.repeat(401) } },
    { ...COMMAND, brief: { ...COMMAND.brief, extra: 'unsupported' } },
  ];
  for (const input of invalid) {
    await assert.rejects(
      transport.generateDraft(input as PropertyPredatorGenerateDraftCommand),
      (error: unknown) => error instanceof PropertyPredatorGenerationBridgeError
        && error.code === 'invalid_request',
    );
  }
  assert.equal(controls.reservations.length, 0);
  assert.equal(fetchCalls, 0);
});

test('maps generation, provider, emergency, volume and spend policy denials without fetching', async () => {
  const cases = [
    ['generation_disabled', 'effects_disabled'],
    ['provider_effects_disabled', 'effects_disabled'],
    ['emergency_paused', 'emergency_paused'],
    ['volume_exhausted', 'volume_exhausted'],
    ['spend_exhausted', 'spend_exhausted'],
    ['policy_unavailable', 'policy_unavailable'],
  ] as const;
  for (const [reasonCode, expectedCode] of cases) {
    let fetchCalls = 0;
    const policy: PropertyPredatorGenerationPolicy = {
      async reserve() { return { allowed: false, reasonCode }; },
      async recordOutcome() { throw new Error('must not be called'); },
    };
    const transport = createPropertyPredatorGenerationTransport(baseOptions(policy, async () => {
      fetchCalls += 1;
      return generatedResponse(generatedFixture());
    }));
    await assert.rejects(transport.generateDraft(COMMAND), (error: unknown) => {
      assert.ok(error instanceof PropertyPredatorGenerationBridgeError);
      assert.equal(error.code, expectedCode);
      return true;
    });
    assert.equal(fetchCalls, 0);
  }
});

test('rejects malformed or underfunded policy approvals before fetching', async () => {
  const invalidDecisions: unknown[] = [
    { allowed: true },
    {
      allowed: true, reservationId: 'generation-reservation-0001',
      generationEnabled: true, providerEffectsEnabled: false, emergencyPaused: false,
      availableRequestSlots: 10, availableSpendMinor: 1000, approvedMaximumCostMinor: 25,
    },
    {
      allowed: true, reservationId: 'generation-reservation-0001',
      generationEnabled: true, providerEffectsEnabled: true, emergencyPaused: false,
      availableRequestSlots: 0, availableSpendMinor: 1000, approvedMaximumCostMinor: 25,
    },
    {
      allowed: true, reservationId: 'generation-reservation-0001',
      generationEnabled: true, providerEffectsEnabled: true, emergencyPaused: false,
      availableRequestSlots: 10, availableSpendMinor: 24, approvedMaximumCostMinor: 25,
    },
  ];
  for (const decision of invalidDecisions) {
    let fetchCalls = 0;
    const policy = {
      async reserve() { return decision; },
      async recordOutcome() {},
    } as unknown as PropertyPredatorGenerationPolicy;
    const transport = createPropertyPredatorGenerationTransport(baseOptions(policy, async () => {
      fetchCalls += 1;
      return generatedResponse(generatedFixture());
    }));
    await assert.rejects(transport.generateDraft(COMMAND), (error: unknown) => {
      assert.ok(error instanceof PropertyPredatorGenerationBridgeError);
      assert.equal(error.code, 'policy_unavailable');
      return true;
    });
    assert.equal(fetchCalls, 0);
  }
});

test('preserves idempotency identity across retries without caching or mutating the command', async () => {
  const controls = allowedPolicy();
  const observedKeys: string[] = [];
  const observedBodies: string[] = [];
  const transport = createPropertyPredatorGenerationTransport(baseOptions(
    controls.policy,
    async (_input, init) => {
      observedKeys.push((init?.headers as Record<string, string>)['idempotency-key']!);
      observedBodies.push(String(init?.body));
      return generatedResponse(generatedFixture());
    },
  ));
  await transport.generateDraft(COMMAND);
  await transport.generateDraft(COMMAND);
  assert.deepEqual(observedKeys, [COMMAND.idempotencyKey, COMMAND.idempotencyKey]);
  assert.equal(observedBodies[0], observedBodies[1]);
  assert.equal(controls.reservations[0]?.requestSha256, controls.reservations[1]?.requestSha256);
  assert.equal(
    controls.reservations[0]?.idempotencyKeySha256,
    controls.reservations[1]?.idempotencyKeySha256,
  );
});

test('fails closed on status, media type, no-store, length, UTF-8, JSON, shape and byte limits', async () => {
  const extra = generatedFixture({ unsupported: true });
  const oversized = new Uint8Array(64 * 1024 + 1);
  const attempts: Array<() => Response> = [
    () => generatedResponse(generatedFixture(), { status: 429 }),
    () => generatedResponse(generatedFixture(), { headers: { 'content-type': 'text/html' } }),
    () => generatedResponse(generatedFixture(), { headers: { 'cache-control': 'private' } }),
    () => generatedResponse(generatedFixture(), { headers: { 'content-length': '99999999' } }),
    () => generatedResponse(generatedFixture(), { body: new Uint8Array([0xc3, 0x28]) }),
    () => generatedResponse(generatedFixture(), { body: '{' }),
    () => generatedResponse(extra),
    () => generatedResponse(generatedFixture(), { body: oversized }),
  ];
  for (const response of attempts) {
    const controls = allowedPolicy();
    const transport = createPropertyPredatorGenerationTransport(baseOptions(
      controls.policy,
      async () => response(),
    ));
    await assert.rejects(transport.generateDraft(COMMAND), PropertyPredatorGenerationBridgeError);
    assert.equal(controls.outcomes.length, 1);
    assert.equal(controls.outcomes[0]?.outcome, 'failed_closed');
    assert.equal(controls.outcomes[0]?.effectState, 'unknown');
    assert.equal(controls.outcomes[0]?.versionId, null);
  }
});

test('rejects the legacy affiliate studio response because it has no immutable version or usage evidence', async () => {
  const controls = allowedPolicy();
  const transport = createPropertyPredatorGenerationTransport(baseOptions(
    controls.policy,
    async () => generatedResponse({
      ok: true,
      content: 'Legacy free-form copy',
      role: 'social',
      remaining_today: 4,
    }),
  ));
  await assert.rejects(transport.generateDraft(COMMAND), (error: unknown) =>
    error instanceof PropertyPredatorGenerationBridgeError && error.code === 'invalid_response');
  assert.equal(controls.outcomes[0]?.outcome, 'failed_closed');
  assert.equal(controls.outcomes[0]?.actualCostMinor, null);
});

test('requires the exact brand, payload identity, UUIDs and canonical content hash', async () => {
  const unsafePayload = generatedPayload({ body: 'Email customer@example.com for the details.' });
  const badCtaPayload = generatedPayload({ cta_url: 'https://propertypredator.com/learn?ref=partner' });
  const offBrandCtaPayload = generatedPayload({ cta_url: 'https://attacker.example/collect' });
  const portCtaPayload = generatedPayload({ cta_url: 'https://propertypredator.com:8443/learn' });
  const markupPayload = generatedPayload({ body: '<img src=x onerror=alert(1)>' });
  const formattingMarkupPayload = generatedPayload({ body: '<strong>Evidence first</strong>' });
  const bodyLinkPayload = generatedPayload({ body: 'Read more at https://attacker.example/collect' });
  const cases = [
    generatedFixture({ brandSha256: 'a'.repeat(64) }),
    generatedFixture({ contentSha256: 'a'.repeat(64) }),
    generatedFixture({ payload: generatedPayload({ kind: 'email' }) }),
    generatedFixture({ versionId: 'ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF' }),
    generatedFixture({ itemVersion: 0 }),
    generatedFixture({ itemVersion: 2 }),
    generatedFixture({ payload: unsafePayload, contentSha256: digest(canonicalCompanyContentJson(unsafePayload)) }),
    generatedFixture({ payload: badCtaPayload, contentSha256: digest(canonicalCompanyContentJson(badCtaPayload)) }),
    generatedFixture({ payload: offBrandCtaPayload, contentSha256: digest(canonicalCompanyContentJson(offBrandCtaPayload)) }),
    generatedFixture({ payload: portCtaPayload, contentSha256: digest(canonicalCompanyContentJson(portCtaPayload)) }),
    generatedFixture({ payload: markupPayload, contentSha256: digest(canonicalCompanyContentJson(markupPayload)) }),
    generatedFixture({ payload: formattingMarkupPayload, contentSha256: digest(canonicalCompanyContentJson(formattingMarkupPayload)) }),
    generatedFixture({ payload: bodyLinkPayload, contentSha256: digest(canonicalCompanyContentJson(bodyLinkPayload)) }),
  ];
  for (const fixture of cases) {
    const controls = allowedPolicy();
    const transport = createPropertyPredatorGenerationTransport(baseOptions(
      controls.policy,
      async () => generatedResponse(fixture),
    ));
    await assert.rejects(transport.generateDraft(COMMAND), PropertyPredatorGenerationBridgeError);
    assert.equal(controls.outcomes[0]?.effectState, 'unknown');
  }
});

test('requires exact hash-bound upstream usage and rejects spend above the reservation', async () => {
  const baseUsage = {
    actualCostMinor: 12,
    inputTokens: 1_250,
    model: 'claude-sonnet-4-6',
    outputTokens: 480,
    providerRequestId: 'provider-request-00000001',
  };
  const cases = [
    generatedFixture({ usageSha256: 'a'.repeat(64) }),
    generatedFixture({ usage: { ...baseUsage, actualCostMinor: COMMAND.maximumCostMinor + 1 } }),
    generatedFixture({ usage: { ...baseUsage, inputTokens: -1 } }),
    generatedFixture({ usage: { ...baseUsage, outputTokens: 10_000_001 } }),
    generatedFixture({ usage: { ...baseUsage, model: '<b>model</b>' } }),
    generatedFixture({ usage: { ...baseUsage, providerRequestId: 'short' } }),
    generatedFixture({ usage: { ...baseUsage, unsupported: true } }),
  ];
  for (const fixture of cases) {
    const controls = allowedPolicy();
    const transport = createPropertyPredatorGenerationTransport(baseOptions(
      controls.policy,
      async () => generatedResponse(fixture),
    ));
    await assert.rejects(transport.generateDraft(COMMAND), PropertyPredatorGenerationBridgeError);
    assert.equal(controls.outcomes[0]?.outcome, 'failed_closed');
    assert.equal(controls.outcomes[0]?.effectState, 'unknown');
    assert.equal(controls.outcomes[0]?.actualCostMinor, null);
    assert.equal(controls.outcomes[0]?.usageSha256, null);
  }
});

test('enforces one absolute deadline across policy, fetch and response streaming', async () => {
  const policyTimeout: PropertyPredatorGenerationPolicy = {
    async reserve() { return new Promise(() => {}); },
    async recordOutcome() {},
  };
  const startedPolicy = Date.now();
  await assert.rejects(createPropertyPredatorGenerationTransport({
    ...baseOptions(policyTimeout), timeoutMs: 100,
  }).generateDraft(COMMAND), (error: unknown) => error instanceof PropertyPredatorGenerationBridgeError
    && error.code === 'timeout');
  assert.ok(Date.now() - startedPolicy < 1_000);

  const fetchControls = allowedPolicy();
  const startedFetch = Date.now();
  await assert.rejects(createPropertyPredatorGenerationTransport({
    ...baseOptions(fetchControls.policy, async () => new Promise<Response>(() => {})), timeoutMs: 100,
  }).generateDraft(COMMAND), (error: unknown) => error instanceof PropertyPredatorGenerationBridgeError
    && error.code === 'timeout');
  assert.ok(Date.now() - startedFetch < 1_000);
  assert.equal(fetchControls.outcomes[0]?.effectState, 'unknown');

  let hangingOutcomeCalled = false;
  const hangingOutcomePolicy: PropertyPredatorGenerationPolicy = {
    async reserve(request) {
      return {
        allowed: true, reservationId: 'generation-reservation-hanging-outcome',
        generationEnabled: true, providerEffectsEnabled: true, emergencyPaused: false,
        availableRequestSlots: 1, availableSpendMinor: 100,
        approvedMaximumCostMinor: request.maximumCostMinor,
      };
    },
    async recordOutcome() {
      hangingOutcomeCalled = true;
      return new Promise(() => {});
    },
  };
  const startedOutcome = Date.now();
  await assert.rejects(createPropertyPredatorGenerationTransport({
    ...baseOptions(hangingOutcomePolicy, async () => { throw new Error('network'); }),
    timeoutMs: 100,
  }).generateDraft(COMMAND), (error: unknown) => error instanceof PropertyPredatorGenerationBridgeError
    && error.code === 'transport_failed');
  assert.ok(Date.now() - startedOutcome < 1_000);
  assert.equal(hangingOutcomeCalled, true);

  const hangingBody = new ReadableStream<Uint8Array>({
    pull: async () => new Promise<void>(() => {}),
  });
  const bodyControls = allowedPolicy();
  const startedBody = Date.now();
  await assert.rejects(createPropertyPredatorGenerationTransport({
    ...baseOptions(bodyControls.policy, async () => generatedResponse(generatedFixture(), {
      body: hangingBody,
    })),
    timeoutMs: 100,
  }).generateDraft(COMMAND), (error: unknown) => error instanceof PropertyPredatorGenerationBridgeError
    && error.code === 'timeout');
  assert.ok(Date.now() - startedBody < 1_000);
  assert.equal(bodyControls.outcomes[0]?.effectState, 'unknown');
});

test('redacts endpoint failures and never exposes credentials, briefs or upstream bodies', async () => {
  const controls = allowedPolicy();
  const secretFailure = `${GENERATE_TOKEN} ${COMMAND.brief.topic} upstream-private-body`;
  const transport = createPropertyPredatorGenerationTransport(baseOptions(
    controls.policy,
    async () => { throw new Error(secretFailure); },
  ));
  let caught: unknown;
  try {
    await transport.generateDraft(COMMAND);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof PropertyPredatorGenerationBridgeError);
  assert.equal(caught.code, 'transport_failed');
  assert.doesNotMatch(caught.message, /test-only|investment property|upstream-private-body/i);
  assert.doesNotMatch(JSON.stringify(caught), /test-only|investment property|upstream-private-body/i);
  assert.deepEqual(controls.outcomes.map((outcome) => ({
    effectState: outcome.effectState,
    safeErrorCode: outcome.safeErrorCode,
  })), [{ effectState: 'unknown', safeErrorCode: 'transport_failed' }]);
});

test('source surface is generate-only, default-deny, bounded and free of provider SDK calls', async () => {
  const source = await readFile(
    new URL('../src/company-content-adapter/property-predator-generation.ts', import.meta.url),
    'utf8',
  );
  assert.match(source, /\/api\/internal\/company-content\/generate/);
  assert.match(source, /if \(!policy\) throw bridgeError\('effects_disabled'\)/);
  assert.match(source, /MAX_REQUEST_BYTES = 8 \* 1024/);
  assert.match(source, /MAX_RESPONSE_BYTES = 64 \* 1024/);
  assert.doesNotMatch(source, /Anthropic|response\.json\(\)|console\.|publish\(|sendMessage\(|loadCatalog\(|loadRelease\(/i);
  assert.doesNotMatch(source, /COMPANY_CONTENT_READ_TOKEN|COMPANY_CONTENT_SYNC_TOKEN|readToken|syncToken/);
});
