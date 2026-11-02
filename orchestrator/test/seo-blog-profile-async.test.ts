import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { harness, OWNER, STRANGER, type Harness } from './seo-blog-fixtures.js';
import { profilePayload } from '../src/seo-blog/profile-jobs.js';

async function fixture() {
  const h = harness();
  const { brand } = await h.engine.createBrand(OWNER, { commandId: randomUUID(), name: 'Harbour', website: 'https://harbour.example' });
  await h.engine.updateSettings(OWNER, brand.id, brand.rowVersion, { budgets: { modelTokensPerMonth: 1_000_000, searchCallsPerMonth: 0, imagesPerMonth: 0 } });
  await h.engine.uploadKnowledge(OWNER, brand.id, { category: 'product_facts', title: 'Offers', pastedText: 'Harbour Compliance Plan costs £49 per month.' });
  const request = (commandId: string = randomUUID(), baseVersion = 0, acknowledgePriorUsage = false) => h.engine.requestProfileExtraction(OWNER, brand.id, { commandId, baseVersion, acknowledgePriorUsage });
  return { h, brand, request };
}
function deferredModel(h: Harness) {
  const original = h.llm.complete.bind(h.llm); let release!: () => void; let entered!: () => void; let calls = 0;
  const gate = new Promise<void>((r) => { release = r; }); const started = new Promise<void>((r) => { entered = r; });
  h.llm.complete = async (req) => { calls++; if (calls === 1) { entered(); await gate; } return original(req); };
  return { started, release, calls: () => calls };
}

test('durable queue coalesces concurrent owner commands and exact aliases replay after result/budget/source changes', async () => {
  const f = await fixture(); const ids = [randomUUID(), randomUUID()];
  const jobs = await Promise.all(ids.map((id) => f.request(id)));
  assert.equal(jobs[0]!.id, jobs[1]!.id); assert.equal(f.h.llm.calls.length, 0);
  assert.equal((await f.h.engine.listJobs(OWNER, f.brand.id)).length, 1);
  const d = deferredModel(f.h); const running = f.h.engine.tick('worker-a'); await d.started;
  const pending = (await f.h.engine.listJobs(OWNER, f.brand.id))[0]!;
  assert.equal(pending.state, 'running'); assert.ok(profilePayload(pending).start?.nonce);
  await f.h.makeEngine().tick('worker-b'); assert.equal(d.calls(), 1);
  d.release(); await running;
  const profile = (await f.h.engine.getProfile(OWNER, f.brand.id))!;
  assert.equal(profile.version, 1); assert.equal(profile.confirmedAt, null);
  const used = (await f.h.engine.usage(OWNER, f.brand.id)).model_tokens; assert.ok(used > 0);
  const brand = await f.h.engine.getBrand(OWNER, f.brand.id);
  await f.h.engine.updateSettings(OWNER, f.brand.id, brand.rowVersion, { budgets: { ...brand.settings.budgets, modelTokensPerMonth: 0 } });
  await f.h.engine.uploadKnowledge(OWNER, f.brand.id, { category: 'other', title: 'New guidance', pastedText: 'Use plain words.' });
  for (const id of ids) assert.equal((await f.request(id)).state, 'done', 'old requests recover their receipt before new eligibility');
  assert.equal(d.calls(), 1); assert.equal((await f.h.engine.usage(OWNER, f.brand.id)).model_tokens, used);
});

test('known model receipt survives failure before atomic completion and lost acknowledgement after commit without repeating model or usage', async () => {
  for (const failure of ['before', 'after']) {
    const f = await fixture(); const queued = await f.request(); const boundary = f.h.store.profileJobBoundary.bind(f.h.store); let failed = false;
    f.h.store.profileJobBoundary = async (input) => {
      const decide = input.decide;
      const wrapped = { ...input, decide: (s: Parameters<typeof decide>[0]) => {
        const decision = decide(s);
        if (!failed && failure === 'before' && decision.profile) { failed = true; throw new Error('database unavailable before commit'); }
        return decision;
      } };
      const value = await boundary(wrapped);
      if (!failed && failure === 'after' && value.state === 'done') { failed = true; throw new Error('lost commit acknowledgement'); }
      return value;
    };
    await f.h.engine.tick('worker');
    assert.equal((await f.h.store.getJob(f.brand.id, queued.id))!.state, 'done');
    assert.equal(f.h.llm.calls.length, 1); assert.equal((await f.h.engine.getProfile(OWNER, f.brand.id))!.version, 1);
    const usage = await f.h.engine.usage(OWNER, f.brand.id);
    await f.h.engine.runJob((await f.h.store.getJob(f.brand.id, queued.id))!);
    assert.deepEqual(await f.h.engine.usage(OWNER, f.brand.id), usage); assert.equal(f.h.llm.calls.length, 1);
  }
});

test('source change or owner edit during generation preserves current profile and records the late receipt cost once', async () => {
  for (const change of ['knowledge', 'profile']) {
    const f = await fixture(); const base = await f.h.engine.extractBrandProfile(OWNER, f.brand.id);
    const queued = await f.request(randomUUID(), base.version); const d = deferredModel(f.h); const running = f.h.engine.tick('worker'); await d.started;
    if (change === 'knowledge') await f.h.engine.uploadKnowledge(OWNER, f.brand.id, { category: 'other', title: 'Changed', pastedText: 'New website guidance.' });
    else await f.h.engine.editProfile(OWNER, f.brand.id, base.version, { summary: 'The owner corrected the extracted summary.' });
    const current = await f.h.engine.getProfile(OWNER, f.brand.id); const before = await f.h.engine.usage(OWNER, f.brand.id);
    d.release(); await running;
    const held = (await f.h.store.getJob(f.brand.id, queued.id))!;
    assert.equal(held.state, 'blocked'); assert.equal(profilePayload(held).reason, 'inputs_changed'); assert.ok(profilePayload(held).receipt);
    assert.deepEqual(await f.h.engine.getProfile(OWNER, f.brand.id), current);
    assert.ok((await f.h.engine.usage(OWNER, f.brand.id)).model_tokens > before.model_tokens);
    assert.equal(d.calls(), 1);
  }
});

test('cancel before start permits a genuine fresh intent; cancel during a model call retains its receipt without reviving it', async () => {
  const f = await fixture(); const first = await f.request(); await f.h.engine.cancelJob(OWNER, f.brand.id, first.id);
  const next = await f.request(); assert.notEqual(first.id, next.id);
  assert.equal((await f.request(profilePayload(first).requestIds[0]!)).state, 'cancelled');
  const d = deferredModel(f.h); const running = f.h.engine.tick('worker'); await d.started;
  await f.h.engine.cancelJob(OWNER, f.brand.id, next.id); d.release(); await running;
  const cancelled = (await f.h.store.getJob(f.brand.id, next.id))!;
  assert.equal(cancelled.state, 'cancelled'); assert.ok(profilePayload(cancelled).receipt);
  assert.equal(await f.h.engine.getProfile(OWNER, f.brand.id), null); assert.ok((await f.h.engine.usage(OWNER, f.brand.id)).model_tokens > 0);
});

test('expired started operation is held even on same-owner reclaim; generic Retry never pays again and new intent needs explicit cost acknowledgement', async () => {
  const f = await fixture(); const queued = await f.request(); const d = deferredModel(f.h);
  const running = f.h.engine.tick('same-worker'); await d.started; const old = (await f.h.store.getJob(f.brand.id, queued.id))!;
  f.h.clock.advance(11 * 60_000);
  const reclaimed = await f.h.store.claimJobs({ brandId: f.brand.id, now: f.h.clock.now(), owner: 'same-worker', leaseMs: 600_000, limit: 1 });
  assert.equal(reclaimed[0]!.attempts, old.attempts + 1);
  // Old owner label is identical, but its attempt epoch cannot apply the late result.
  d.release(); await running;
  let held = (await f.h.store.getJob(f.brand.id, queued.id))!;
  assert.equal(held.state, 'blocked'); assert.ok(profilePayload(held).receipt); assert.equal(await f.h.engine.getProfile(OWNER, f.brand.id), null);
  await f.h.engine.retryJob(OWNER, f.brand.id, held.id);
  const [applyClaim] = await f.h.store.claimJobs({ brandId: f.brand.id, now: f.h.clock.now(), owner: 'apply-receipt', leaseMs: 600_000, limit: 1 });
  assert.ok(applyClaim!.attempts > reclaimed[0]!.attempts, 'profile receipt retries preserve a monotonic lease epoch');
  await f.h.engine.runJob(old);
  await f.h.engine.runJob({ ...old, leaseOwner: applyClaim!.leaseOwner });
  assert.equal(await f.h.engine.getProfile(OWNER, f.brand.id), null, 'old owner or same-owner stale attempt cannot adopt the current receipt lease');
  assert.equal((await f.h.store.getJob(f.brand.id, held.id))!.state, 'running');
  await f.h.engine.runJob(applyClaim!);
  assert.equal(d.calls(), 1); assert.equal((await f.h.engine.getProfile(OWNER, f.brand.id))!.version, 1);

  const g = await fixture(); const job = await g.request();
  const [claim] = await g.h.store.claimJobs({ now: g.h.clock.now(), owner: 'dead-worker', leaseMs: 600_000, limit: 1 });
  await g.h.store.updateJob({ ...claim!, payload: { ...profilePayload(claim!), start: { nonce: randomUUID(), at: g.h.clock.now() } } });
  g.h.clock.advance(11 * 60_000); await g.h.engine.tick('restart');
  held = (await g.h.store.getJob(g.brand.id, job.id))!;
  assert.equal(held.state, 'blocked'); assert.equal(profilePayload(held).reason, 'outcome_unknown'); assert.equal(g.h.llm.calls.length, 0);
  await assert.rejects(g.h.engine.retryJob(OWNER, g.brand.id, held.id), /uncertain outcome/);
  await assert.rejects(g.request(), /may already have used/);
  const explicit = await g.request(randomUUID(), 0, true); assert.notEqual(explicit.id, held.id);
  assert.deepEqual(profilePayload(explicit).acknowledgedPriorUsage, [held.id]);
  await g.h.engine.tick('new-intent'); assert.equal(g.h.llm.calls.length, 1);
});

test('current budget, requester membership and unsupported stages fail closed before model work', async () => {
  for (const control of ['budget', 'member']) {
    const f = await fixture(); await f.request();
    if (control === 'member') f.h.store.revoke(OWNER.userId, f.brand.id);
    else { const b = await f.h.engine.getBrand(OWNER, f.brand.id); await f.h.engine.updateSettings(OWNER, f.brand.id, b.rowVersion, { budgets: { ...b.settings.budgets, modelTokensPerMonth: 0 } }); }
    await f.h.engine.tick('worker'); assert.equal(f.h.llm.calls.length, 0);
    assert.equal((await f.h.store.listJobs(f.brand.id))[0]!.state, 'blocked');
  }
  const f = await fixture(); await assert.rejects(f.h.engine.requestProfileExtraction(STRANGER, f.brand.id, { commandId: randomUUID(), baseVersion: 0 }), { status: 404 });
  const j = await f.request(); await f.h.engine.cancelJob(OWNER, f.brand.id, j.id);
  const id = randomUUID(); await f.h.store.enqueueJob({ ...j, id, idempotencyKey: id, payload: { stage: 'future' }, state: 'queued' });
  await f.h.engine.tick('legacy'); assert.equal(f.h.llm.calls.length, 0); assert.equal((await f.h.store.getJob(f.brand.id, id))!.state, 'blocked');
});
