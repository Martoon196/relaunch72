import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { canonicalCompanyContentSocialDraft, parseCompanyContentSocialDraft } from '../src/company-content-pg/validation.js';
import { parseCompanyContentSocialImage, socialImageFromDataUrl } from '../src/company-content-pg/social-image.js';
import { createCombinedSocialImageMediaResolver } from '../src/public-social-outbound/combined-social-image-media.js';
import { IMAGE_FIXTURE, JPEG_FIXTURE } from './social-image-fixture.js';

const post = { type: 'generated', kind: 'post', platform: 'LinkedIn', title: 'A post',
  publicationCopy: 'The words people read.', artworkInstructions: 'Use a real screenshot.' };
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

test('words and actual image share one canonical digest; text-only history still parses', () => {
  const original = canonicalCompanyContentSocialDraft(post);
  assert.equal(parseCompanyContentSocialDraft(original).image, undefined);
  const combined = canonicalCompanyContentSocialDraft({ ...post, image: IMAGE_FIXTURE });
  assert.deepEqual(parseCompanyContentSocialDraft(combined).image, IMAGE_FIXTURE);
  assert.notEqual(hash(original), hash(combined));
  assert.notEqual(hash(combined), hash(canonicalCompanyContentSocialDraft({ ...post,
    image: IMAGE_FIXTURE, publicationCopy: 'Changed words' })));
  assert.notEqual(hash(combined), hash(canonicalCompanyContentSocialDraft({ ...post,
    image: { ...IMAGE_FIXTURE, alt: 'Changed description' } })));
});

test('server verifies image bytes rather than trusting browser hashes or dimensions', () => {
  for (const image of [ { ...IMAGE_FIXTURE, sha256: 'a'.repeat(64) },
    { ...IMAGE_FIXTURE, width: 201 }, { ...IMAGE_FIXTURE, url: 'https://attacker.invalid/image' },
    { ...IMAGE_FIXTURE, mimeType: 'image/svg+xml' }, { ...IMAGE_FIXTURE, base64: 'broken' } ]) {
    assert.throws(() => parseCompanyContentSocialImage(image));
  }
  assert.throws(() => socialImageFromDataUrl('data:image/svg+xml;base64,PHN2Zz4=', 'unsafe'));
  assert.throws(() => socialImageFromDataUrl(JPEG_FIXTURE, ''));
  assert.throws(() => socialImageFromDataUrl(JPEG_FIXTURE, 'line\nbreak'));
  assert.throws(() => socialImageFromDataUrl('data:image/jpeg;base64,' + 'A'.repeat(800004), 'large'));
});

test('delivery uploads exact approved bytes and returns the provider media URL', async () => {
  let received: Uint8Array | null = null;
  const resolver = createCombinedSocialImageMediaResolver({
    legacy: { resolve: async () => { throw new Error('not legacy'); } },
    posting: { prepareMediaUpload: async (request) => {
      assert.equal(request.filename, `${IMAGE_FIXTURE.sha256}.jpg`);
      return { uploadUrl: 'https://fixture.r2.cloudflarestorage.com/image',
        publicUrl: 'https://media.zernio.com/image.jpg', expiresIn: 120 };
    } },
    fetch: (async (_url, options) => {
      received = options!.body as Uint8Array;
      assert.equal(options!.redirect, 'error');
      assert.deepEqual(options!.headers, { 'content-type': 'image/jpeg' });
      return new Response(null, { status: 200 });
    }) as typeof fetch,
  });
  assert.deepEqual(await resolver.resolve({ workspaceId: 'workspace', jobId: 'job', media: [{
    storageKey: `hq-social-image/${IMAGE_FIXTURE.sha256}`, blobSha256: IMAGE_FIXTURE.sha256,
    mimeType: IMAGE_FIXTURE.mimeType, inlineImage: IMAGE_FIXTURE,
  }] }), ['https://media.zernio.com/image.jpg']);
  assert.deepEqual(Buffer.from(received!), Buffer.from(IMAGE_FIXTURE.base64, 'base64'));
});

test('delivery refuses missing inline bytes and untrusted upload destinations', async () => {
  let requests = 0;
  const resolver = createCombinedSocialImageMediaResolver({
    legacy: { resolve: async () => ['https://legacy.invalid/image'] },
    posting: { prepareMediaUpload: async () => ({ uploadUrl: 'http://127.0.0.1/internal',
      publicUrl: 'https://media.zernio.com/image.jpg', expiresIn: 120 }) },
    fetch: (async () => { requests++; return new Response(); }) as typeof fetch,
  });
  const item = { storageKey: `hq-social-image/${IMAGE_FIXTURE.sha256}`,
    blobSha256: IMAGE_FIXTURE.sha256, mimeType: IMAGE_FIXTURE.mimeType };
  await assert.rejects(resolver.resolve({ workspaceId: 'w', jobId: 'j', media: [item] }));
  await assert.rejects(resolver.resolve({ workspaceId: 'w', jobId: 'j', media: [{ ...item, inlineImage: IMAGE_FIXTURE }] }));
  assert.equal(requests, 0);
});

test('existing approved-asset delivery stays with its existing resolver', async () => {
  const resolver = createCombinedSocialImageMediaResolver({
    legacy: { resolve: async () => ['https://legacy.invalid/image'] },
    posting: { prepareMediaUpload: async () => { throw new Error('no upload'); } },
    fetch: (async () => { throw new Error('no provider'); }) as typeof fetch,
  });
  assert.deepEqual(await resolver.resolve({ workspaceId: 'w', jobId: 'j', media: [{
    storageKey: 'approved/picture.jpg', blobSha256: 'a'.repeat(64), mimeType: 'image/jpeg',
  }] }), ['https://legacy.invalid/image']);
});
