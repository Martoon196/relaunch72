import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createZernioPostingClient,
  ZernioPostingError,
  type ZernioPostingTarget,
} from '../src/public-social-outbound/zernio-posting-client.js';

const API_KEY = 'zernio-owned-test-key';
const REQUEST_ID = '00000000-0000-4000-8000-000000000001';
const INSTAGRAM_ACCOUNT = '6a95e99a77555aae01643ae2';
const LINKEDIN_ACCOUNT = '6a95e99a77555aae01643ae3';
const POST_ID = '65f1c0a9e2b5af0012ab34cd';
const TARGETS: readonly ZernioPostingTarget[] = Object.freeze([
  Object.freeze({ network: 'instagram', accountId: INSTAGRAM_ACCOUNT }),
  Object.freeze({ network: 'linkedin', accountId: LINKEDIN_ACCOUNT }),
]);

function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

function post(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _id: POST_ID,
    status: 'published',
    platforms: [
      {
        platform: 'instagram',
        accountId: {
          _id: INSTAGRAM_ACCOUNT,
          platform: 'instagram',
          username: 'propertypredator',
        },
        status: 'published',
        platformPostUrl: 'https://www.instagram.com/p/property-predator-proof/',
      },
      {
        platform: 'linkedin',
        accountId: LINKEDIN_ACCOUNT,
        status: 'published',
        platformPostUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:123/',
      },
    ],
    ...overrides,
  };
}

function client(fetch: typeof globalThis.fetch) {
  return createZernioPostingClient({
    apiKey: API_KEY,
    allowedTargets: TARGETS,
    fetch,
  });
}

function publishInput(overrides: Record<string, unknown> = {}) {
  return {
    requestId: REQUEST_ID,
    content: 'One postcode. One answer.',
    targets: TARGETS,
    mediaItems: [{
      type: 'image' as const,
      url: 'https://media.propertypredator.com/social/proof-card.png?signature=owned',
    }],
    ...overrides,
  };
}

test('publishes one due Instagram and LinkedIn job through the exact Zernio boundary', async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const posting = client(async (url, init) => {
    requests.push({ url: String(url), init: init ?? {} });
    return json({ post: post(), message: 'Post published successfully' }, 201);
  });

  const result = await posting.publishDue(publishInput());

  assert.equal(result.providerPostId, POST_ID);
  assert.equal(result.status, 'published');
  assert.equal(result.platforms.length, 2);
  assert.equal(result.platforms[0]?.network, 'instagram');
  assert.equal(result.platforms[1]?.platformPostUrl,
    'https://www.linkedin.com/feed/update/urn:li:activity:123/');
  assert.equal(result.idempotentReplay, false);
  assert.match(result.responseSha256, /^[0-9a-f]{64}$/u);

  assert.equal(requests.length, 1);
  const request = requests[0]!;
  assert.equal(request.url, 'https://zernio.com/api/v1/posts');
  assert.equal(request.init.method, 'POST');
  assert.equal(request.init.redirect, 'error');
  const headers = request.init.headers as Record<string, string>;
  assert.equal(headers.authorization, `Bearer ${API_KEY}`);
  assert.equal(headers.accept, 'application/json');
  assert.equal(headers['content-type'], 'application/json');
  assert.equal(headers['x-request-id'], REQUEST_ID);
  assert.deepEqual(JSON.parse(String(request.init.body)), {
    content: 'One postcode. One answer.',
    platforms: [
      { platform: 'instagram', accountId: INSTAGRAM_ACCOUNT },
      { platform: 'linkedin', accountId: LINKEDIN_ACCOUNT },
    ],
    mediaItems: [{
      type: 'image',
      url: 'https://media.propertypredator.com/social/proof-card.png?signature=owned',
    }],
    publishNow: true,
  });
});

test('accepts only the documented x-request-id replay envelope', async () => {
  const posting = client(async () => json({ existingPost: post() }, 200));
  const result = await posting.publishDue(publishInput({ mediaItems: [] }));
  assert.equal(result.idempotentReplay, true);
  assert.equal(result.providerPostId, POST_ID);

  const wrongEnvelope = client(async () => json({ post: post() }, 200));
  await assert.rejects(
    wrongEnvelope.publishDue(publishInput()),
    (error: unknown) => error instanceof ZernioPostingError
      && error.code === 'invalid_provider_response',
  );
});

test('rejects account substitution and non-public media before provider I/O', async () => {
  let calls = 0;
  const posting = client(async () => {
    calls += 1;
    return json({ post: post() }, 201);
  });

  await assert.rejects(
    posting.publishDue(publishInput({
      targets: [{ network: 'instagram', accountId: '6a95e99a77555aae01643aff' }],
    })),
    (error: unknown) => error instanceof ZernioPostingError
      && error.code === 'unbound_target',
  );
  await assert.rejects(
    posting.publishDue(publishInput({
      mediaItems: [{ type: 'video', url: 'https://127.0.0.1/private.mp4' }],
    })),
    (error: unknown) => error instanceof ZernioPostingError
      && error.code === 'invalid_request',
  );
  await assert.rejects(
    posting.publishDue(publishInput({ requestId: 'not-a-uuid' })),
    (error: unknown) => error instanceof ZernioPostingError
      && error.code === 'invalid_request',
  );
  assert.equal(calls, 0);
});

test('fails closed on every sensitive create status and ambiguous transport outcome', async (t) => {
  const cases = [
    [401, 'unauthorised'],
    [403, 'forbidden'],
    [409, 'conflict'],
    [429, 'rate_limited'],
    [500, 'outcome_unknown'],
    [503, 'outcome_unknown'],
  ] as const;
  for (const [status, code] of cases) {
    await t.test(String(status), async () => {
      const posting = client(async () => json({ error: 'provider refused' }, status));
      await assert.rejects(
        posting.publishDue(publishInput()),
        (error: unknown) => error instanceof ZernioPostingError && error.code === code,
      );
    });
  }

  const ambiguous = client(async () => { throw new Error('socket closed'); });
  await assert.rejects(
    ambiguous.publishDue(publishInput()),
    (error: unknown) => error instanceof ZernioPostingError
      && error.code === 'outcome_unknown',
  );
});

test('rejects malformed, oversized, missing and target-crossed provider responses', async (t) => {
  const cases: Array<readonly [string, () => Response, string]> = [
    ['wrong media type', () => new Response('not json', {
      status: 201, headers: { 'content-type': 'text/plain' },
    }), 'invalid_provider_response'],
    ['oversized declaration', () => json({ post: post() }, 201, {
      'content-length': '65537',
    }), 'invalid_provider_response'],
    ['missing target', () => json({ post: post({ platforms: [
      (post().platforms as unknown[])[0],
    ] }) }, 201), 'invalid_provider_response'],
    ['crossed account', () => json({ post: post({ platforms: [
      {
        platform: 'instagram', accountId: LINKEDIN_ACCOUNT,
        status: 'published', platformPostUrl: 'https://www.instagram.com/p/crossed/',
      },
      (post().platforms as unknown[])[1],
    ] }) }, 201), 'unbound_target'],
    ['unknown platform state', () => json({ post: post({ platforms: [
      { ...(post().platforms as Record<string, unknown>[])[0], status: 'maybe' },
      (post().platforms as unknown[])[1],
    ] }) }, 201), 'invalid_provider_response'],
  ];

  for (const [name, response, code] of cases) {
    await t.test(name, async () => {
      const posting = client(async () => response());
      await assert.rejects(
        posting.publishDue(publishInput()),
        (error: unknown) => error instanceof ZernioPostingError && error.code === code,
      );
    });
  }
});

test('reconciles the exact provider post and bound platform receipts with GET', async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const posting = client(async (url, init) => {
    requests.push({ url: String(url), init: init ?? {} });
    return json({ post: post({
      status: 'partial',
      platforms: [
        (post().platforms as unknown[])[0],
        {
          platform: 'linkedin', accountId: LINKEDIN_ACCOUNT,
          status: 'failed', errorMessage: 'Platform rejected the post',
        },
      ],
    }) });
  });

  const result = await posting.reconcile({
    providerPostId: POST_ID,
    expectedTargets: TARGETS,
  });
  assert.equal(result.status, 'partial');
  assert.equal(result.platforms[0]?.status, 'published');
  assert.equal(result.platforms[1]?.status, 'failed');
  assert.equal(result.platforms[1]?.platformPostUrl, null);
  assert.equal(requests[0]?.url, `https://zernio.com/api/v1/posts/${POST_ID}`);
  assert.equal(requests[0]?.init.method, 'GET');
  assert.equal(requests[0]?.init.redirect, 'error');
  assert.equal(
    (requests[0]?.init.headers as Record<string, string>)['x-request-id'],
    undefined,
  );
});

test('reconciliation distinguishes absence and retryable provider unavailability', async () => {
  const missing = client(async () => json({ error: 'Not found' }, 404));
  await assert.rejects(
    missing.reconcile({ providerPostId: POST_ID, expectedTargets: TARGETS }),
    (error: unknown) => error instanceof ZernioPostingError && error.code === 'not_found',
  );

  const unavailable = client(async () => { throw new Error('network'); });
  await assert.rejects(
    unavailable.reconcile({ providerPostId: POST_ID, expectedTargets: TARGETS }),
    (error: unknown) => error instanceof ZernioPostingError
      && error.code === 'provider_unavailable',
  );
});

test('configuration accepts only bounded printable API secrets and exact target bindings', () => {
  assert.throws(
    () => createZernioPostingClient({
      apiKey: 'bad key with spaces',
      allowedTargets: TARGETS,
      fetch: async () => json({}),
    }),
    (error: unknown) => error instanceof ZernioPostingError
      && error.code === 'invalid_configuration',
  );
  assert.throws(
    () => createZernioPostingClient({
      apiKey: API_KEY,
      allowedTargets: [TARGETS[0]!, TARGETS[0]!],
      fetch: async () => json({}),
    }),
    (error: unknown) => error instanceof ZernioPostingError
      && error.code === 'invalid_configuration',
  );
});
