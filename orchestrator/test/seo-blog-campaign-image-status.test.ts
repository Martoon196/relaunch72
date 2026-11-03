import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { CAMPAIGN_IMAGE_STATUS_SCRIPT } from '../src/portal/campaign-image-status.js';
import { campaignFixture } from './seo-blog-campaign-fixtures.js';
import { nativeIdentity, nativeSeoCall } from './seo-blog-native-request.js';
import { OWNER, STRANGER } from './seo-blog-fixtures.js';
import { randomUUID } from 'node:crypto';

function browser(response: unknown | (() => Promise<unknown>), endpoint = '/portal/seo-blog/b/11111111-1111-4111-8111-111111111111/image/status?job=synthetic') {
  const detail = { textContent: 'Waiting to start' }, technical={textContent:''}, link={textContent:'View saved images'}, result = { hidden: true,querySelector:(selector:string)=>selector==='a'?link:null }, timers = new Map<number, () => void>(), events = new Map<string, (event?: {persisted:boolean}) => void>(); let count = 0, nextTimer = 0;
  const node = { isConnected: true, dataset: { campaignImageTask: 'synthetic', endpoint }, querySelector: (selector: string) => selector === '[data-task-detail]' ? detail : selector==='[data-task-technical]'?technical:selector==='[data-task-result]'?result:null };
  const context = { document: { querySelectorAll: (selector: string) => { assert.equal(selector, '[data-campaign-image-task]'); return [node]; } },
    location: { origin: 'https://app.relaunch72.com', href: 'https://app.relaunch72.com/portal/seo-blog' }, URL, AbortController,
    addEventListener: (name: string, action: (event?: {persisted:boolean}) => void) => events.set(name, action),
    setTimeout: (action: () => void) => { const id = ++nextTimer; timers.set(id, action); return id; }, clearTimeout: (id: number) => timers.delete(id),
    fetch: async (_url: string, options: {credentials:string;cache:string}) => { count++; assert.equal(options.credentials, 'same-origin'); assert.equal(options.cache, 'no-store'); return { ok: true, headers: { get: () => 'application/json' }, json: async () => typeof response === 'function' ? response() : response }; } };
  runInNewContext(CAMPAIGN_IMAGE_STATUS_SCRIPT, context);
  return { detail, technical,link,result, timers, events, calls: () => count };
}
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
test('image progress is read-only and reveals prepared result without navigation, form inspection or re-generation', async () => {
  const b = browser({ id: 'synthetic', state: 'done', detail: 'Three private crops prepared.', prepared: true }); await settle();
  assert.equal(b.detail.textContent, 'Images ready to review');assert.equal(b.technical.textContent,'done · Three private crops prepared.');assert.equal(b.link.textContent,'View saved images'); assert.equal(b.result.hidden, false); assert.equal(b.calls(), 1); assert.equal(b.timers.size, 0);
  const external = browser({ id: 'synthetic', state: 'done', detail: 'Must not read this', prepared: true }, 'https://foreign.example/portal/seo-blog/b/11111111-1111-4111-8111-111111111111/image/status'); await settle(); assert.equal(external.calls(), 0);
});
test('late progress after pagehide cannot revive a restored page and unknown response never becomes a ready claim', async () => {
  let finish!: (value: unknown) => void;
  const b = browser(() => new Promise(resolve => { finish = resolve; })); await settle(); b.events.get('pagehide')!();
  finish({ id: 'synthetic', state: 'done', detail: 'Old page result', prepared: true }); await settle();
  assert.equal(b.detail.textContent, 'Waiting to start'); assert.equal(b.result.hidden, true); assert.equal(b.timers.size, 0);
  const invalid = browser({ id: 'other', state: 'done', detail: 'Wrong task', prepared: true }); await settle();
  assert.match(invalid.detail.textContent, /temporarily unavailable/);assert.match(invalid.detail.textContent,/Save any edits/);assert.doesNotMatch(invalid.detail.textContent,/task continues/); assert.equal(invalid.result.hidden, true);
});
test('live image statuses stay plain while technical detail is text-only in Advanced; terminal holds offer only manual review',async()=>{
  for(const [state,label] of [['queued','Waiting to start'],['running','Preparing images'],['blocked','Needs attention'],['failed','Needs checking'],['done','Needs checking'],['cancelled','Cancelled']]){
    const b=browser({id:'synthetic',state,detail:'nonce <script>not executable</script> receipt',prepared:false});await settle();
    assert.equal(b.detail.textContent,label);assert.equal(b.technical.textContent,`${state} · nonce <script>not executable</script> receipt`);
    assert.doesNotMatch(b.detail.textContent,/nonce|receipt|script/);
    const active=state==='queued'||state==='running';assert.equal(b.result.hidden,active);assert.equal(b.link.textContent,'See what needs checking');assert.equal(b.calls(),1);
    if(active)b.events.get('pagehide')!();
  }
});
test('image progress route authorises exact brand and article and exposes no private prompt/source/receipt', async () => {
  const f = await campaignFixture(), id = randomUUID(), at = f.h.clock.now();
  await f.h.store.enqueueJob({ id, brandId: f.brand.id, kind: 'write', idempotencyKey: `image-status:${id}`, state: 'running', payload: { stage: 'image', image: { articleId: f.article.id, privateCommand: { prompt: 'PRIVATE PROMPT' }, sourceSnapshot: { profile: 'PRIVATE PROFILE' }, receipt: { raw: 'PRIVATE RECEIPT' } } },
    attempts: 1, maxAttempts: 3, leaseOwner: 'synthetic', leaseExpiresAt: '2026-11-02T10:10:00.000Z', runAfter: at, progress: 'Preparing saved image.', error: null, createdAt: at, updatedAt: at, rowVersion: 1 });
  const path = `/portal/seo-blog/b/${f.brand.id}/image/status?article=${f.article.id}&job=${id}`;
  const page = await nativeSeoCall(f.h.engine, { who: nativeIdentity(OWNER.userId), method: 'GET', path });
  assert.equal(page.status, 200); assert.match(page.headers['content-type']!, /application\/json/); assert.equal(JSON.parse(page.body).state, 'running'); assert.doesNotMatch(page.body, /PRIVATE|sourceSnapshot|privateCommand|receipt/);
  assert.equal((await nativeSeoCall(f.h.engine, { who: nativeIdentity(STRANGER.userId), method: 'GET', path })).status, 404);
  assert.equal((await nativeSeoCall(f.h.engine, { who: nativeIdentity(OWNER.userId), method: 'GET', path: path.replace(f.article.id, randomUUID()) })).status, 404);
  assert.equal(f.h.llm.calls.length, 0);
});
