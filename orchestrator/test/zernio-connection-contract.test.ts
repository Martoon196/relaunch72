import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  PublicSocialOutboundContractError,
  PublicSocialOutboundDisabledError,
  ZERNIO_CONNECTION_CALLBACK_URL,
  ZERNIO_CONNECTION_SECURITY_CONTRACT,
  ZernioConnectionContract,
  createPublicSocialScriptedHttpTransport,
  createZernioConnectionCredential,
  readPublicSocialContractHttpRequests,
  type PublicSocialScriptedHttpStep,
  type ZernioConnectionContext,
  type ZernioConnectionRequest,
} from '../src/public-social-outbound/index.js';

const NOW = '2026-08-31T13:30:00.000Z';
const IDS = Object.freeze({
  workspace: '11111111-1111-4111-8111-111111111111',
  connection: '22222222-2222-4222-8222-222222222222',
  operation: '33333333-3333-4333-8333-333333333333',
  correlation: '44444444-4444-4444-8444-444444444444',
  other: '55555555-5555-4555-8555-555555555555',
});
const CALLBACK = 'https://hq.propertypredator.com/portal/social/accounts/callback';
const API_KEY = `sk_${'a'.repeat(64)}`;

const context: ZernioConnectionContext = Object.freeze({
  workspaceId: IDS.workspace,
  connectionId: IDS.connection,
  providerId: 'zernio',
  operationId: IDS.operation,
  correlationId: IDS.correlation,
});

const request: ZernioConnectionRequest = Object.freeze({
  network: 'facebook',
  redirectUrl: CALLBACK,
  headless: false,
});

function credential() {
  return createZernioConnectionCredential({
    workspaceId: IDS.workspace,
    connectionId: IDS.connection,
    providerProfileId: 'profile_abc123',
    credentialVersion: 'version-1',
    apiKey: API_KEY,
    profileBindingEvidenceSha256: 'b'.repeat(64),
    observedAt: NOW,
  });
}

function response(body: unknown, status = 200): PublicSocialScriptedHttpStep {
  return Object.freeze({ kind: 'response', status, bodyUtf8: JSON.stringify(body) });
}

function setup(step: PublicSocialScriptedHttpStep) {
  const http = createPublicSocialScriptedHttpTransport([step]);
  return Object.freeze({
    http,
    contract: new ZernioConnectionContract({
      executionMode: 'contract_test',
      credential: credential(),
      http,
      observedAt: NOW,
      timeoutMs: 4_000,
    }),
  });
}

test('disabled Zernio seam has no provider effects and does not inspect inputs', async () => {
  const contract = new ZernioConnectionContract();
  let reads = 0;
  const hostile = new Proxy(context, {
    get(target, key, receiver) {
      reads += 1;
      return Reflect.get(target, key, receiver) as unknown;
    },
  });
  await assert.rejects(contract.prepare(hostile, request), PublicSocialOutboundDisabledError);
  assert.equal(reads, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(contract)), {
    provider: 'zernio',
    executionMode: 'disabled',
    credentials: '[REDACTED]',
    providerEffects: 'oauth_not_started',
  });
});

test('security metadata is the exact contract the request builder consumes', () => {
  assert.deepEqual(ZERNIO_CONNECTION_SECURITY_CONTRACT, {
    origin: 'https://zernio.com',
    path: '/v1/connect/{platform}',
    authentication: 'bearer_header_only',
    redirectPolicy: 'error',
    responseMode: 'bounded_stream',
    maximumResponseBytes: 65_536,
    minimumTimeoutMs: 1_000,
    maximumTimeoutMs: 30_000,
    headless: false,
    workspaceProfileBindingRequired: true,
    accountConnectedWebhookRequired: true,
    callbackUrl: CALLBACK,
  });
});

test('prepares the exact reviewed Zernio hosted-selection OAuth request without starting OAuth', async () => {
  const authUrl = 'https://www.facebook.com/v21.0/dialog/oauth?client_id=reviewed';
  const state = 'bound-provider-state';
  const { contract, http } = setup(response({ authUrl, state }));
  const result = await contract.prepare(context, request);
  assert.deepEqual(result, {
    status: 'ready',
    authUrl,
    providerStateSha256: createHash('sha256').update(state, 'utf8').digest('hex'),
    occurredAt: NOW,
    retryable: false,
    errorCode: null,
    summary: 'Zernio prepared the exact facebook OAuth flow',
    providerEffects: 'oauth_not_started',
  });
  const [sent] = readPublicSocialContractHttpRequests(http);
  assert.ok(sent);
  const url = new URL(sent.url);
  assert.equal(url.origin, ZERNIO_CONNECTION_SECURITY_CONTRACT.origin);
  assert.equal(url.pathname, '/v1/connect/facebook');
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    profileId: 'profile_abc123',
    redirect_url: CALLBACK,
    headless: 'false',
  });
  assert.deepEqual(sent.headers, { Authorization: `Bearer ${API_KEY}` });
  assert.equal(sent.method, 'GET');
  assert.equal(sent.bodyUtf8, null);
  assert.equal(sent.redirectPolicy, 'error');
  assert.equal(sent.maximumResponseBytes, 65_536);
  assert.equal(sent.timeoutMs, 4_000);
  assert.equal(request.redirectUrl, ZERNIO_CONNECTION_CALLBACK_URL);
});

test('credential JSON is redacted and a copied credential is rejected', () => {
  const authentic = credential();
  const serialized = JSON.stringify(authentic);
  assert.equal(serialized.includes(API_KEY), false);
  assert.equal(serialized.includes('[REDACTED]'), true);
  const http = createPublicSocialScriptedHttpTransport([response({})]);
  assert.throws(() => new ZernioConnectionContract({
    executionMode: 'contract_test',
    credential: { ...authentic },
    http,
    observedAt: NOW,
  }), PublicSocialOutboundContractError);
});

test('workspace/profile binding fails before the scripted transport is touched', async () => {
  const { contract, http } = setup(response({ authUrl: 'https://facebook.com/oauth', state: 'state-123' }));
  await assert.rejects(contract.prepare({ ...context, workspaceId: IDS.other }, request),
    PublicSocialOutboundContractError);
  assert.deepEqual(readPublicSocialContractHttpRequests(http), []);
});

test('only the exact reviewed callback and pilot networks are accepted', async () => {
  const one = setup(response({}));
  await assert.rejects(one.contract.prepare(context, {
    ...request,
    redirectUrl: 'https://attacker.example/callback',
  }), PublicSocialOutboundContractError);
  assert.deepEqual(readPublicSocialContractHttpRequests(one.http), []);

  const two = setup(response({}));
  await assert.rejects(two.contract.prepare(context, {
    ...request,
    network: 'twitter' as 'facebook',
  }), PublicSocialOutboundContractError);
  assert.deepEqual(readPublicSocialContractHttpRequests(two.http), []);

  assert.throws(() => new ZernioConnectionContract({
    executionMode: 'disabled',
    allowedRedirectUrl: 'https://attacker.example/callback',
  } as never), PublicSocialOutboundContractError);
});

test('all and only the reviewed pilot networks produce their exact provider path', async () => {
  for (const network of ['facebook', 'instagram', 'linkedin'] as const) {
    const current = setup(response({
      authUrl: `https://www.${network}.com/oauth`, state: `state-${network}`,
    }));
    const result = await current.contract.prepare(context, { ...request, network });
    assert.equal(result.status, 'ready');
    const [sent] = readPublicSocialContractHttpRequests(current.http);
    assert.equal(new URL(sent!.url).pathname, `/v1/connect/${network}`);
  }
});

test('malformed or non-standard-port OAuth responses are contained as unbound', async () => {
  for (const body of [
    { authUrl: 'not-a-url', state: 'state-valid' },
    { authUrl: 'https://facebook.com:8443/oauth', state: 'state-valid' },
    { authUrl: 'https://facebook.com/oauth', state: 'bad state' },
    { authUrl: 'https://facebook.com.attacker.example/oauth', state: 'state-valid' },
  ]) {
    const current = setup(response(body));
    const result = await current.contract.prepare(context, request);
    assert.equal(result.status, 'needs_attention');
    assert.equal(result.errorCode, 'zernio_oauth_response_unbound');
    assert.equal(result.providerEffects, 'oauth_not_started');
  }
});

test('billing, rate-limit and unknown outcomes remain fail-closed', async () => {
  const billing = setup(response({ code: 'PAYMENT_REQUIRED' }, 402));
  assert.deepEqual(await billing.contract.prepare(context, request), {
    status: 'failed', authUrl: null, providerStateSha256: null, occurredAt: NOW,
    retryable: false, errorCode: 'zernio_billing_suspended',
    summary: 'Zernio billing is suspended; no OAuth flow was opened',
    providerEffects: 'oauth_not_started',
  });

  const rate = setup(response({}, 429));
  assert.equal((await rate.contract.prepare(context, request)).retryable, true);

  const unknown = setup(Object.freeze({ kind: 'transport_error', code: 'timeout' }));
  const unknownResult = await unknown.contract.prepare(context, request);
  assert.equal(unknownResult.status, 'needs_attention');
  assert.equal(unknownResult.errorCode, 'zernio_connection_outcome_unknown');
  assert.equal(unknownResult.retryable, false);
});

test('unexpected constructor fields and incomplete contract-test mode are rejected', () => {
  assert.throws(() => new ZernioConnectionContract({
    executionMode: 'disabled',
    surprise: true,
  } as never), PublicSocialOutboundContractError);
  assert.throws(() => new ZernioConnectionContract({
    executionMode: 'contract_test',
  }), PublicSocialOutboundContractError);
  for (const timeoutMs of [999, 30_001, 1.5, Number.NaN]) {
    assert.throws(() => new ZernioConnectionContract({ timeoutMs }),
      PublicSocialOutboundContractError);
  }
});
