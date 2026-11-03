import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { centralContentOrigin, composeCentralContentMount, createCentralContentMount, CENTRAL_CONTENT_ORIGIN } from '../src/portal/central-content-mount.js';
import type { PostgresPortalDeps } from '../src/portal/router.js';
import type { PortalReleasedSeoMediaReader } from '../src/portal/seo-blog-media.js';
import { IMAGE_FIXTURE } from './social-image-fixture.js';

const ID = '11111111-1111-4111-8111-111111111111', SHA = IMAGE_FIXTURE.sha256;
const PATH = `/api/public/seo-blog/media/${ID}/${SHA}.jpg`, BYTES = Buffer.from(IMAGE_FIXTURE.base64, 'base64');
function fixture() {
  let reads = 0, withdrawn = false;
  const reader: PortalReleasedSeoMediaReader = { readReleasedAsset: async (id, sha) => { reads++; assert.equal(id, ID); assert.equal(sha, SHA); return withdrawn ? null : { releaseId: ID, sha256: SHA, mimeType: 'image/jpeg', bytes: Buffer.from(BYTES) }; } };
  const portal = { kind: 'postgres', sessionSecret: 'released-media-test-secret-at-least-thirty-two-characters', secure: true,
    auth: { resolve: async () => { throw new Error('Public release must not resolve current membership'); }, revoke: async () => { throw new Error('not auth'); }, login: async () => { throw new Error('not auth'); } },
    releasedSeoMedia: reader, seoBlog: undefined } as unknown as PostgresPortalDeps;
  const mount = createCentralContentMount({ origin: CENTRAL_CONTENT_ORIGIN, portal, authorize: async () => { throw new Error('Released pixels are not current-owner resources'); } });
  return { mount, portal, reader, reads: () => reads, withdraw: () => { withdrawn = true; } };
}
async function call(f: ReturnType<typeof fixture>, path = PATH, method = 'GET', host = 'app.relaunch72.com') {
  const req = Object.assign(new EventEmitter(), { method, url: path, headers: { host, 'x-forwarded-host': 'app.relaunch72.com' } });
  const res = { code: 0, headers: {} as Record<string, string>, body: null as string | Buffer | null,
    writeHead(code: number, headers: Record<string, string>) { this.code = code; this.headers = headers; return this; }, end(value?: string | Buffer) { this.body = value ?? null; } };
  await f.mount.handle(req as never, res as never); return res;
}

test('released exact ID/SHA reads without SEO service, owner session or current draft; withdrawal ends access', async () => {
  const f = fixture(), result = await call(f);
  assert.equal(result.code, 200); assert.equal(result.headers['content-type'], 'image/jpeg'); assert.equal(result.headers['cache-control'], 'no-store'); assert.equal(result.headers['x-content-type-options'], 'nosniff');
  assert.deepEqual(result.body, BYTES); assert.equal(f.reads(), 1);
  f.withdraw(); const withdrawn = await call(f);
  assert.equal(withdrawn.code, 404); assert.equal(withdrawn.headers['cache-control'], 'no-store');
  assert.equal(withdrawn.headers['x-content-type-options'], 'nosniff');
});

test('released media host/path/method validation never falls into private or broad asset reads', async () => {
  const f = fixture();
  for (const path of [PATH.replace(ID, 'not-a-uuid'), PATH.replace(SHA, 'short'), `${PATH}?asset=private`, `${PATH}/extra`, '/api/public/seo-blog/media/', '/api/public/seo-blog/media/private']) assert.equal((await call(f, path)).code, 404);
  assert.equal((await call(f, PATH, 'POST')).code, 404);
  assert.equal((await call(f, PATH, 'GET', 'app.relaunch72.com:443')).code, 421);
  assert.equal((await call(f, PATH, 'GET', 'foreign.example')).code, 421);
  assert.equal(f.reads(), 0);
});

test('reader errors or mismatched bytes never leak private detail or serve unverified content', async () => {
  const f = fixture();
  f.portal.releasedSeoMedia = { readReleasedAsset: async () => { throw new Error('private database diagnostics'); } };
  const error = await call(f); assert.equal(error.code, 503); assert.doesNotMatch(String(error.body), /database|private/);
  f.portal.releasedSeoMedia = { readReleasedAsset: async () => ({ releaseId: ID, sha256: SHA, mimeType: 'image/jpeg', bytes: Buffer.from('not the released pixels') }) };
  assert.equal((await call(f)).code, 503);
});

test('production composition with global content UI flag OFF retains only released media, never login or SEO', async () => {
  const f = fixture();
  const mount = composeCentralContentMount({ origin: centralContentOrigin({ R72_CONTENT_ENABLED: 'false', R72_CONTENT_ORIGIN: 'https://ignored.example' }), portal: f.portal,
    releasedMedia: f.reader, authorize: async () => { throw new Error('UI is disabled'); } });
  assert.ok(mount); const disabled = { ...f, mount };
  assert.equal((await call(disabled)).code, 200);
  for (const path of ['/', '/portal/login', '/portal/setup', '/portal/seo-blog', '/checkout']) assert.equal((await call(disabled, path)).code, 404);
  assert.equal(f.reads(), 1, 'private paths never invoke the released reader');
  assert.equal(composeCentralContentMount({ origin: null, portal: undefined, releasedMedia: undefined, authorize: async () => false }), undefined);
});
