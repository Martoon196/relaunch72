import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApprovedSocialMediaGatewayError,
  PROPERTY_PREDATOR_APPROVED_SOCIAL_MEDIA_PATH,
  createApprovedSocialMediaUrlResolver,
  createPropertyPredatorApprovedSocialMediaGateway,
  loadApprovedSocialMediaSigningConfig,
} from '../src/public-social-outbound/approved-social-media-gateway.js';

const KEY = Buffer.alloc(32, 7);
const KEY_TEXT = KEY.toString('base64url');
const NOW = new Date('2026-09-02T10:00:00.000Z');
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const JOB = '22222222-2222-4222-8222-222222222222';
const VERSION = '33333333-3333-4333-8333-333333333333';
const STORAGE_KEY = `/api/internal/company-content/assets/${VERSION}/file`;
const BLOB_SHA256 = 'a'.repeat(64);
const BYTES = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

type CapturedResponse = Readonly<{
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}>;

function responseCapture(): Readonly<{
  response: Promise<CapturedResponse>;
  res: {
    writeHead(status: number, headers: Record<string, string>): void;
    end(body?: string | Uint8Array): void;
  };
}> {
  let status = 0;
  let headers: Record<string, string> = {};
  let resolve: (value: CapturedResponse) => void = () => undefined;
  const response = new Promise<CapturedResponse>((done) => { resolve = done; });
  return Object.freeze({
    response,
    res: {
      writeHead(nextStatus, nextHeaders) {
        status = nextStatus;
        headers = { ...nextHeaders };
      },
      end(body) {
        resolve(Object.freeze({
          status,
          headers,
          body: typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body ?? []),
        }));
      },
    },
  });
}

async function signedUrl(): Promise<string> {
  const resolver = createApprovedSocialMediaUrlResolver({
    publicOrigin: 'https://hq.propertypredator.com',
    signingKey: KEY,
    ttlSeconds: 900,
    now: () => NOW,
  });
  const urls = await resolver.resolve({
    workspaceId: WORKSPACE,
    jobId: JOB,
    media: Object.freeze([Object.freeze({
      storageKey: STORAGE_KEY,
      blobSha256: BLOB_SHA256,
      mimeType: 'image/png',
    })]),
  });
  assert.equal(urls.length, 1);
  return urls[0]!;
}

test('signing config accepts only one canonical 32-byte key and a bounded TTL', () => {
  const config = loadApprovedSocialMediaSigningConfig({
    PROPERTY_PREDATOR_PUBLIC_SOCIAL_MEDIA_SIGNING_KEY_BASE64URL: KEY_TEXT,
    PROPERTY_PREDATOR_PUBLIC_SOCIAL_MEDIA_URL_TTL_SECONDS: '900',
  }, true)!;
  assert.deepEqual(config.key, KEY);
  assert.equal(config.ttlSeconds, 900);
  assert.equal(loadApprovedSocialMediaSigningConfig({}), undefined);
  for (const env of [
    { PROPERTY_PREDATOR_PUBLIC_SOCIAL_MEDIA_SIGNING_KEY_BASE64URL: 'short' },
    {
      PROPERTY_PREDATOR_PUBLIC_SOCIAL_MEDIA_SIGNING_KEY_BASE64URL: KEY_TEXT,
      PROPERTY_PREDATOR_PUBLIC_SOCIAL_MEDIA_URL_TTL_SECONDS: '59',
    },
    {
      PROPERTY_PREDATOR_PUBLIC_SOCIAL_MEDIA_SIGNING_KEY_BASE64URL: KEY_TEXT,
      PROPERTY_PREDATOR_PUBLIC_SOCIAL_MEDIA_URL_TTL_SECONDS: '3601',
    },
  ]) assert.throws(
    () => loadApprovedSocialMediaSigningConfig(env, true),
    ApprovedSocialMediaGatewayError,
  );
});

test('resolver creates a non-enumerable HTTPS URL bound to exact approved media', async () => {
  const url = new URL(await signedUrl());
  assert.equal(url.origin, 'https://hq.propertypredator.com');
  assert.ok(url.pathname.startsWith(PROPERTY_PREDATOR_APPROVED_SOCIAL_MEDIA_PATH));
  assert.equal(url.search, '');
  assert.equal(url.hash, '');
  assert.doesNotMatch(url.href, /api\/internal\/company-content|33333333-3333/u);

  const resolver = createApprovedSocialMediaUrlResolver({
    publicOrigin: 'https://hq.propertypredator.com', signingKey: KEY, now: () => NOW,
  });
  for (const item of [
    { storageKey: '/uploads/guessable.png', blobSha256: BLOB_SHA256, mimeType: 'image/png' },
    { storageKey: STORAGE_KEY, blobSha256: BLOB_SHA256, mimeType: 'video/mp4' },
    { storageKey: STORAGE_KEY, blobSha256: 'bad', mimeType: 'image/png' },
  ]) {
    await assert.rejects(
      resolver.resolve({ workspaceId: WORKSPACE, jobId: JOB, media: [item] }),
      ApprovedSocialMediaGatewayError,
    );
  }
});

test('gateway re-fetches and serves only the exact adapter-verified bytes', async () => {
  const calls: unknown[][] = [];
  const gateway = createPropertyPredatorApprovedSocialMediaGateway({
    signingKey: KEY,
    now: () => NOW,
    resources: {
      async loadAsset(...args) {
        calls.push(args);
        return Object.freeze({
          versionId: VERSION,
          mediaType: 'image/png' as const,
          sha256: BLOB_SHA256,
          bytes: BYTES,
        });
      },
    },
  });
  const capture = responseCapture();
  await gateway.handle({ method: 'GET' }, capture.res, new URL(await signedUrl()));
  const result = await capture.response;
  assert.deepEqual(calls, [[VERSION, BLOB_SHA256]]);
  assert.equal(result.status, 200);
  assert.equal(result.headers['content-type'], 'image/png');
  assert.equal(result.headers.etag, `"sha256-${BLOB_SHA256}"`);
  assert.equal(result.headers['cache-control'], 'private, no-store, max-age=0');
  assert.deepEqual(result.body, Buffer.from(BYTES));
  assert.doesNotMatch(JSON.stringify(result.headers), /company-content|read-token|bearer/iu);
});

test('gateway returns the same hidden 404 for tamper, expiry and byte mismatch', async () => {
  let loads = 0;
  const gateway = createPropertyPredatorApprovedSocialMediaGateway({
    signingKey: KEY,
    now: () => new Date(NOW.getTime() + 901_000),
    resources: {
      async loadAsset() {
        loads += 1;
        return Object.freeze({
          versionId: VERSION, mediaType: 'image/jpeg' as const,
          sha256: BLOB_SHA256, bytes: BYTES,
        });
      },
    },
  });
  const expired = responseCapture();
  await gateway.handle({ method: 'GET' }, expired.res, new URL(await signedUrl()));
  assert.equal((await expired.response).status, 404);
  assert.equal(loads, 0, 'expired authority must not contact the source adapter');

  const validNowGateway = createPropertyPredatorApprovedSocialMediaGateway({
    signingKey: KEY,
    now: () => NOW,
    resources: {
      async loadAsset() {
        loads += 1;
        return Object.freeze({
          versionId: VERSION, mediaType: 'image/jpeg' as const,
          sha256: BLOB_SHA256, bytes: BYTES,
        });
      },
    },
  });
  const original = await signedUrl();
  const tamperedUrl = `${original.slice(0, -1)}${original.endsWith('A') ? 'B' : 'A'}`;
  const tampered = responseCapture();
  await validNowGateway.handle({ method: 'GET' }, tampered.res, new URL(tamperedUrl));
  assert.equal((await tampered.response).status, 404);
  assert.equal(loads, 0, 'invalid signature must not contact the source adapter');

  const mismatch = responseCapture();
  await validNowGateway.handle({ method: 'GET' }, mismatch.res, new URL(original));
  assert.equal((await mismatch.response).status, 404);
  assert.equal(loads, 1);
});
