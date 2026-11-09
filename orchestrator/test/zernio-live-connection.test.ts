import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ZernioLiveConnectionError,
  createZernioLiveConnectionClient,
} from '../src/public-social-outbound/index.js';

const INTENT = '11111111-1111-4111-8111-111111111111';

test('live Zernio preparation uses the documented hosted-selection endpoint', async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const client = createZernioLiveConnectionClient({
    apiKey: `sk_${'a'.repeat(48)}`,
    providerProfileId: '6a95a6ae41c1829b085cbe28',
    fetch: async (input, init) => {
      requests.push({ url: String(input), init: init ?? {} });
      return new Response(JSON.stringify({
        authUrl: 'https://zernio.com/connect/continue',
        state: 'provider-bound-state',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const result = await client.prepare({ network: 'facebook', intentId: INTENT });
  assert.equal(result.providerEffects, 'oauth_not_started');
  assert.equal(requests.length, 1);
  const sent = requests[0]!;
  const url = new URL(sent.url);
  assert.equal(url.origin, 'https://zernio.com');
  assert.equal(url.pathname, '/api/v1/connect/facebook');
  assert.equal(url.searchParams.get('profileId'), '6a95a6ae41c1829b085cbe28');
  assert.equal(url.searchParams.get('headless'), 'false');
  assert.equal(
    url.searchParams.get('redirect_url'),
    `https://hq.propertypredator.com/portal/social/accounts/callback?intent=${INTENT}`,
  );
  assert.equal(
    ((sent.init.headers as Record<string, string>).authorization ?? '').startsWith('Bearer '),
    true,
  );
  assert.equal(sent.init.redirect, 'error');
});

test('live Zernio preparation maps billing and rejects untrusted auth URLs', async () => {
  const billing = createZernioLiveConnectionClient({
    apiKey: `sk_${'b'.repeat(48)}`,
    providerProfileId: '6a95a6ae41c1829b085cbe28',
    fetch: async () => new Response('{}', {
      status: 402,
      headers: { 'content-type': 'application/json' },
    }),
  });
  await assert.rejects(
    billing.prepare({ network: 'linkedin', intentId: INTENT }),
    (error: unknown) => error instanceof ZernioLiveConnectionError
      && error.code === 'billing_required',
  );

  const hostile = createZernioLiveConnectionClient({
    apiKey: `sk_${'c'.repeat(48)}`,
    providerProfileId: '6a95a6ae41c1829b085cbe28',
    fetch: async () => new Response(JSON.stringify({
      authUrl: 'https://zernio.com.attacker.example/oauth',
      state: 'provider-bound-state',
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  });
  await assert.rejects(
    hostile.prepare({ network: 'instagram', intentId: INTENT }),
    (error: unknown) => error instanceof ZernioLiveConnectionError
      && error.code === 'invalid_provider_response',
  );
});
