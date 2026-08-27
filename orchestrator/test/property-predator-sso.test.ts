import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LivePropertyPredatorSsoClient,
  PROPERTY_PREDATOR_SSO_CALLBACK_ROUTE,
  PROPERTY_PREDATOR_SSO_COOKIE,
  PropertyPredatorSsoAuthenticationError,
  PropertyPredatorSsoConfigurationError,
  PropertyPredatorSsoExchangeError,
  clearPropertyPredatorSsoCookie,
  composePropertyPredatorSso,
  loadPropertyPredatorSsoConfig,
  verifyPropertyPredatorSsoTransaction,
  type PropertyPredatorSsoConfig,
} from '../src/portal/property-predator-sso.js';

const NOW = Date.parse('2026-08-26T12:00:00.000Z');
const BOOTSTRAP_USER_ID = '11111111-1111-4111-8111-111111111111';
const SUBJECT = '22222222-2222-4222-8222-222222222222';
const SESSION_SECRET = 'growth-hq-sso-cookie-secret-that-is-never-shared';

function config(over: Partial<PropertyPredatorSsoConfig> = {}): PropertyPredatorSsoConfig {
  return {
    issuer: 'https://propertypredator.com',
    authorizeUrl: 'https://propertypredator.com/sso.html',
    tokenUrl: 'https://propertypredator.com/api/auth/sso/token',
    clientId: 'growth-hq',
    clientSecret: 'backchannel-client-secret-that-never-enters-a-browser',
    redirectUri: `https://hq.propertypredator.com${PROPERTY_PREDATOR_SSO_CALLBACK_ROUTE}`,
    bootstrapUserId: BOOTSTRAP_USER_ID,
    bootstrapEmails: new Set(['martin.howard1984@gmail.com']),
    ...over,
  };
}

function identity(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    issuer: 'https://propertypredator.com',
    audience: 'growth-hq',
    subject: SUBJECT,
    email: 'martin.howard1984@gmail.com',
    email_verified: true,
    issued_at: new Date(NOW - 10_000).toISOString(),
    expires_at: new Date(NOW + 5 * 60_000).toISOString(),
    affiliate: {
      member: true,
      affiliate_id: '33333333-3333-4333-8333-333333333333',
      code: 'founder_01',
      code_status: 'active',
    },
    attribution: {
      referrer_affiliate_id: null,
      attached_at: null,
    },
    ...over,
  };
}

function deterministicBytes(): (size: number) => Buffer {
  const values = [Buffer.alloc(32, 1), Buffer.alloc(32, 2), Buffer.alloc(12, 3)];
  return (size) => {
    const value = values.shift();
    assert.ok(value, 'random source was called more than expected');
    assert.equal(value.length, size);
    return value;
  };
}

function cookieValue(header: string): string {
  const match = new RegExp(`^${PROPERTY_PREDATOR_SSO_COOKIE}=([^;]+)`).exec(header);
  assert.ok(match?.[1]);
  return match[1];
}

test('SSO configuration is optional when disabled and exact/fail-closed when enabled', () => {
  assert.equal(loadPropertyPredatorSsoConfig({ PROPERTY_PREDATOR_SSO_ENABLED: 'false' } as NodeJS.ProcessEnv), null);
  const env = {
    NODE_ENV: 'production',
    PROPERTY_PREDATOR_SSO_ENABLED: 'true',
    PROPERTY_PREDATOR_SSO_ISSUER: 'https://propertypredator.com',
    PROPERTY_PREDATOR_SSO_AUTHORIZE_URL: 'https://propertypredator.com/sso.html',
    PROPERTY_PREDATOR_SSO_TOKEN_URL: 'https://propertypredator.com/api/auth/sso/token',
    PROPERTY_PREDATOR_SSO_CLIENT_ID: 'growth-hq',
    PROPERTY_PREDATOR_SSO_CLIENT_SECRET: 'a-dedicated-backchannel-secret-of-adequate-length',
    PROPERTY_PREDATOR_SSO_REDIRECT_URI: `https://hq.propertypredator.com${PROPERTY_PREDATOR_SSO_CALLBACK_ROUTE}`,
    PROPERTY_PREDATOR_SSO_BOOTSTRAP_USER_ID: BOOTSTRAP_USER_ID,
    PROPERTY_PREDATOR_SSO_BOOTSTRAP_EMAILS: 'martin.howard1984@gmail.com',
  } as NodeJS.ProcessEnv;
  const loaded = loadPropertyPredatorSsoConfig(env);
  assert.equal(loaded?.issuer, 'https://propertypredator.com');
  assert.equal(loaded?.bootstrapEmails.has('martin.howard1984@gmail.com'), true);
  assert.throws(
    () => loadPropertyPredatorSsoConfig({ ...env, PROPERTY_PREDATOR_SSO_TOKEN_URL: 'https://attacker.example/api/auth/sso/token' }),
    PropertyPredatorSsoConfigurationError,
  );
  assert.throws(
    () => loadPropertyPredatorSsoConfig({ ...env, PROPERTY_PREDATOR_SSO_REDIRECT_URI: 'https://attacker.example/portal/auth/property-predator/callback' }),
    /canonical Growth HQ origin/,
  );
  assert.throws(
    () => loadPropertyPredatorSsoConfig({ ...env, PROPERTY_PREDATOR_SSO_BOOTSTRAP_EMAILS: '' }),
    /configured together/,
  );
  assert.throws(
    () => loadPropertyPredatorSsoConfig({ ...env, PROPERTY_PREDATOR_SSO_ENABLED: 'yes' }),
    /true or false/,
  );
  assert.throws(
    () => loadPropertyPredatorSsoConfig({ ...env, PROPERTY_PREDATOR_SSO_CLIENT_ID: 'another-client' }),
    /must be growth-hq/,
  );
  assert.throws(
    () => loadPropertyPredatorSsoConfig({ ...env, PROPERTY_PREDATOR_SSO_CLIENT_SECRET: 'not valid because it contains spaces and a snowman ☃' }),
    /only printable ASCII/,
  );
  const invalidComposition = composePropertyPredatorSso(
    { PROPERTY_PREDATOR_SSO_ENABLED: 'true' } as NodeJS.ProcessEnv,
    SESSION_SECRET,
    true,
  );
  assert.equal(invalidComposition.state, 'invalid');
  assert.equal(invalidComposition.client, undefined);
});

test('authorization start uses PKCE S256 and an encrypted host-only callback cookie', () => {
  const ssoConfig = config();
  const client = new LivePropertyPredatorSsoClient({
    config: ssoConfig,
    sessionSecret: SESSION_SECRET,
    secure: true,
    randomBytes: deterministicBytes(),
  });
  const started = client.begin('google', NOW);
  const authorize = new URL(started.url);
  assert.equal(authorize.origin + authorize.pathname, ssoConfig.authorizeUrl);
  assert.deepEqual([...authorize.searchParams.keys()].sort(), [
    'client_id', 'code_challenge', 'code_challenge_method', 'provider', 'redirect_uri', 'state',
  ]);
  assert.equal(authorize.searchParams.get('client_id'), 'growth-hq');
  assert.equal(authorize.searchParams.get('redirect_uri'), ssoConfig.redirectUri);
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorize.searchParams.get('provider'), 'google');
  assert.match(authorize.searchParams.get('state') ?? '', /^[A-Za-z0-9_-]{43}$/);
  assert.match(authorize.searchParams.get('code_challenge') ?? '', /^[A-Za-z0-9_-]{43}$/);
  assert.doesNotMatch(started.url, /client-secret|code_verifier|backchannel/);

  assert.match(started.cookie, new RegExp(`^${PROPERTY_PREDATOR_SSO_COOKIE}=`));
  assert.match(started.cookie, /HttpOnly/);
  assert.match(started.cookie, /Secure/);
  assert.match(started.cookie, /SameSite=Lax/);
  assert.match(started.cookie, new RegExp(`Path=${PROPERTY_PREDATOR_SSO_CALLBACK_ROUTE}`));
  assert.match(started.cookie, /Max-Age=600/);
  assert.doesNotMatch(started.cookie, /Domain=/i);
  assert.doesNotMatch(started.cookie, new RegExp(authorize.searchParams.get('state')!));

  const transaction = verifyPropertyPredatorSsoTransaction(
    SESSION_SECRET,
    ssoConfig,
    cookieValue(started.cookie),
    NOW,
  );
  assert.equal(transaction?.state, authorize.searchParams.get('state'));
  assert.match(transaction?.codeVerifier ?? '', /^[A-Za-z0-9_-]{43}$/);
  assert.equal(
    verifyPropertyPredatorSsoTransaction(
      SESSION_SECRET,
      config({ clientId: 'different-client' }),
      cookieValue(started.cookie),
      NOW,
    ),
    null,
    'an encrypted transaction is bound to the exact non-secret client configuration',
  );
  assert.equal(
    verifyPropertyPredatorSsoTransaction(SESSION_SECRET, ssoConfig, `${cookieValue(started.cookie)}x`, NOW),
    null,
  );
  assert.match(client.clearCookie(), /Max-Age=0/);
  assert.equal(client.clearCookie(), clearPropertyPredatorSsoCookie(true));
});

test('callback exchanges a single-use code server-to-server and returns only the verified assertion', async () => {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const ssoConfig = config();
  const client = new LivePropertyPredatorSsoClient({
    config: ssoConfig,
    sessionSecret: SESSION_SECRET,
    secure: true,
    randomBytes: deterministicBytes(),
    fetch: async (input, init) => {
      calls.push({ input: input.toString(), init });
      const body = JSON.stringify({ token_type: 'identity', identity: identity() });
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) }),
        text: async () => body,
      };
    },
  });
  const started = client.begin(undefined, NOW);
  const state = new URL(started.url).searchParams.get('state')!;
  const exchanged = await client.complete(
    'single-use-authorization-code',
    state,
    cookieValue(started.cookie),
    NOW,
  );
  assert.equal(exchanged?.bootstrapUserId, BOOTSTRAP_USER_ID);
  assert.equal(exchanged?.assertion.subject, SUBJECT);
  assert.equal(exchanged?.assertion.email, 'martin.howard1984@gmail.com');
  assert.equal(exchanged?.assertion.emailVerified, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.input, ssoConfig.tokenUrl);
  assert.equal(calls[0]!.init?.method, 'POST');
  assert.equal(calls[0]!.init?.redirect, 'error');
  const requestBody = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>;
  assert.deepEqual(Object.keys(requestBody).sort(), [
    'client_id', 'code', 'code_verifier', 'grant_type', 'redirect_uri',
  ]);
  assert.equal(requestBody.grant_type, 'authorization_code');
  assert.equal(requestBody.client_id, ssoConfig.clientId);
  assert.equal(requestBody.code, 'single-use-authorization-code');
  assert.equal(requestBody.redirect_uri, ssoConfig.redirectUri);
  assert.match(String(requestBody.code_verifier), /^[A-Za-z0-9_-]{43}$/);
  assert.doesNotMatch(calls[0]!.input, new RegExp(ssoConfig.clientSecret));
  assert.equal(
    (calls[0]!.init?.headers as Record<string, string>).authorization,
    `Basic ${Buffer.from(`${ssoConfig.clientId}:${ssoConfig.clientSecret}`).toString('base64')}`,
  );
  assert.equal(JSON.stringify(exchanged).includes(ssoConfig.clientSecret), false);
  assert.equal(JSON.stringify(exchanged).includes('refresh'), false);
});

test('the SSO backchannel secret cannot reuse the portal session secret', () => {
  assert.throws(
    () => new LivePropertyPredatorSsoClient({
      config: config({ clientSecret: SESSION_SECRET }),
      sessionSecret: SESSION_SECRET,
      secure: true,
    }),
    /must be dedicated/,
  );
  assert.throws(
    () => new LivePropertyPredatorSsoClient({
      config: config({ clientSecret: 'manual config contains spaces and is invalid' }),
      sessionSecret: SESSION_SECRET,
      secure: true,
    }),
    /canonical Property Predator contract/,
  );
});

test('state, transaction expiry and identity claims fail closed before local session issuance', async () => {
  let fetchCalls = 0;
  const responseIdentity = identity();
  const client = new LivePropertyPredatorSsoClient({
    config: config(),
    sessionSecret: SESSION_SECRET,
    secure: true,
    randomBytes: deterministicBytes(),
    fetch: async () => {
      fetchCalls += 1;
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => JSON.stringify({ token_type: 'identity', identity: responseIdentity }),
      };
    },
  });
  const started = client.begin(undefined, NOW);
  const state = new URL(started.url).searchParams.get('state')!;
  assert.equal(await client.complete('single-use-authorization-code', Buffer.alloc(32, 9).toString('base64url'), cookieValue(started.cookie), NOW), null);
  assert.equal(fetchCalls, 0, 'state is verified before the backchannel is contacted');
  assert.equal(await client.complete('single-use-authorization-code', state, cookieValue(started.cookie), NOW + 10 * 60_000), null);
  assert.equal(fetchCalls, 0, 'expired transaction is rejected before the backchannel is contacted');

  responseIdentity.email_verified = false;
  await assert.rejects(
    client.complete('single-use-authorization-code', state, cookieValue(started.cookie), NOW),
    PropertyPredatorSsoExchangeError,
  );
  assert.equal(fetchCalls, 1);
});

test('an unallowlisted verified affiliate assertion cannot select the founder bootstrap user', async () => {
  const client = new LivePropertyPredatorSsoClient({
    config: config(),
    sessionSecret: SESSION_SECRET,
    secure: true,
    randomBytes: deterministicBytes(),
    fetch: async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({
        token_type: 'identity',
        identity: identity({
          email: 'affiliate@example.test',
          affiliate: { member: false, affiliate_id: null, code: null, code_status: null },
        }),
      }),
    }),
  });
  const started = client.begin(undefined, NOW);
  const exchange = await client.complete(
    'single-use-authorization-code',
    new URL(started.url).searchParams.get('state')!,
    cookieValue(started.cookie),
    NOW,
  );
  assert.equal(exchange?.assertion.email, 'affiliate@example.test');
  assert.equal(exchange?.bootstrapUserId, undefined);
});

test('non-200, oversized and non-JSON token responses expose only one generic exchange error', async () => {
  for (const response of [
    { ok: false, status: 401, headers: new Headers({ 'content-type': 'application/json' }), text: async () => '{"secret":"detail"}' },
    { ok: true, status: 200, headers: new Headers({ 'content-type': 'text/html' }), text: async () => '<h1>proxy detail</h1>' },
    { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json', 'content-length': '70000' }), text: async () => '{}' },
  ]) {
    const client = new LivePropertyPredatorSsoClient({
      config: config(), sessionSecret: SESSION_SECRET, secure: true,
      randomBytes: deterministicBytes(), fetch: async () => response,
    });
    const started = client.begin(undefined, NOW);
    const operation = client.complete(
      'single-use-authorization-code',
      new URL(started.url).searchParams.get('state')!,
      cookieValue(started.cookie),
      NOW,
    );
    await assert.rejects(operation, (error: unknown) => {
      assert.ok(error instanceof PropertyPredatorSsoExchangeError);
      assert.equal(error.message, 'Property Predator identity exchange failed');
      return true;
    });
  }
});

test('token caller rejections are typed separately from transient provider failures', async () => {
  const completeWith = async (
    fetch: NonNullable<ConstructorParameters<typeof LivePropertyPredatorSsoClient>[0]['fetch']>,
  ): Promise<void> => {
    const client = new LivePropertyPredatorSsoClient({
      config: config(), sessionSecret: SESSION_SECRET, secure: true,
      randomBytes: deterministicBytes(), fetch,
    });
    const started = client.begin(undefined, NOW);
    await client.complete(
      'single-use-authorization-code',
      new URL(started.url).searchParams.get('state')!,
      cookieValue(started.cookie),
      NOW,
    );
  };
  const response = (status: number) => async () => ({
    ok: false,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => '{"error":"provider detail is never surfaced"}',
  });

  for (const status of [400, 401, 403, 422]) {
    await assert.rejects(completeWith(response(status)), (error: unknown) => {
      assert.ok(error instanceof PropertyPredatorSsoAuthenticationError);
      assert.equal(error.message, 'Property Predator identity exchange failed');
      return true;
    });
  }
  for (const status of [408, 429, 500, 503]) {
    await assert.rejects(completeWith(response(status)), (error: unknown) => {
      assert.ok(error instanceof PropertyPredatorSsoExchangeError);
      assert.equal(error instanceof PropertyPredatorSsoAuthenticationError, false);
      return true;
    });
  }
  await assert.rejects(
    completeWith(async () => { throw new DOMException('timed out', 'TimeoutError'); }),
    (error: unknown) => {
      assert.ok(error instanceof PropertyPredatorSsoExchangeError);
      assert.equal(error instanceof PropertyPredatorSsoAuthenticationError, false);
      return true;
    },
  );
});
