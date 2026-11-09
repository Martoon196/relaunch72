/** Durable render jobs: job shape, strict decode, and the worker runner's stop/retry rules (fake service, no rendering). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { decodeRenderJob, executeRender, newRenderJob, runCreativeRenderJob, type RenderService } from '../src/creative-studio/render-jobs.js';
import { SeoBlogError, type Job } from '../src/seo-blog/types.js';

const now = () => new Date().toISOString();
function harness(job: Job) {
  let row = job; const writes: Job[] = [];
  return { store: { getJob: async () => row, updateJob: async (j: Job) => { row = { ...j, rowVersion: row.rowVersion + 1 }; writes.push(row); return row; } }, writes, row: () => row };
}
const running = (j: Job, attempts = 1): Job => ({ ...j, state: 'running', attempts, leaseOwner: 'w', leaseExpiresAt: new Date(Date.now() + 600_000).toISOString() });
const service = (draft: RenderService['draft']) => ({ draft } as unknown as RenderService);

test('a render job is keyed by the form command, carries only the operation, and decodes strictly', () => {
  const brand = randomUUID(), sponsor = randomUUID(), cmd = randomUUID();
  const job = newRenderJob(brand, sponsor, cmd, { op: 'video', versionId: randomUUID() }, now());
  assert.equal(job.id, cmd); assert.equal(job.idempotencyKey, `creative-render:${cmd}`); assert.equal(job.payload.stage, 'creative_render'); assert.equal(job.state, 'queued');
  assert.equal(decodeRenderJob(job).sponsorUserId, sponsor);
  for (const bad of [{ ...job, id: randomUUID() }, { ...job, payload: { ...job.payload, render: { ...(job.payload.render as object), schema: 'other' } } },
    { ...job, payload: { ...job.payload, render: { ...(job.payload.render as object), operation: { op: 'approve' } } } }, { ...job, kind: 'publish' as const }])
    assert.throws(() => decodeRenderJob(bad as Job), /not recognised/u);
  assert.throws(() => newRenderJob(brand, 'not-a-user', cmd, { op: 'video', versionId: randomUUID() }, now()), /Refresh/u);
});

test('runner: success records the result; an owner-correctable error stops with its message; a server fault retries once, then stops', async () => {
  const base = newRenderJob(randomUUID(), randomUUID(), randomUUID(), { op: 'draft', raw: {}, background: { kind: 'neutral' } }, now());
  const ok = harness(running(base));
  const done = await runCreativeRenderJob(ok.row(), { store: ok.store, now, service: () => service(async () => ({ setId: 'set-1', note: null, replayed: false })) });
  assert.equal(done.state, 'done'); assert.equal((done.payload.render as { result: { setId: string } }).result.setId, 'set-1');

  const owner = harness(running(base));
  const stopped = await runCreativeRenderJob(owner.row(), { store: owner.store, now, service: () => service(async () => { throw new SeoBlogError(409, 'Brand facts changed. Refresh first.'); }) });
  assert.equal(stopped.state, 'blocked'); assert.equal(stopped.error, 'Brand facts changed. Refresh first.');

  const fault = harness(running(base, 1));
  const retried = await runCreativeRenderJob(fault.row(), { store: fault.store, now, service: () => service(async () => { throw new Error('browser crashed'); }) });
  assert.equal(retried.state, 'queued'); assert.equal(retried.error, null); assert.ok(Date.parse(retried.runAfter) > Date.now());
  const last = harness(running(base, 2));
  const gaveUp = await runCreativeRenderJob(last.row(), { store: last.store, now, service: () => service(async () => { throw new Error('browser crashed'); }) });
  assert.equal(gaveUp.state, 'blocked'); assert.match(gaveUp.error ?? '', /Nothing was published/u);
  assert.equal(JSON.stringify(gaveUp).includes('browser crashed'), false, 'internal error text is not shown');
});

test('runner: a lost claim or unrecognised payload never runs the service', async () => {
  const base = newRenderJob(randomUUID(), randomUUID(), randomUUID(), { op: 'draft', raw: {}, background: { kind: 'neutral' } }, now());
  let calls = 0; const svc = () => service(async () => { calls++; return { setId: 's', note: null, replayed: false }; });
  const h = harness(running(base));
  const lost = await runCreativeRenderJob({ ...h.row(), leaseOwner: 'other' }, { store: h.store, now, service: svc });
  assert.equal(lost.state, 'running'); assert.equal(h.writes.length, 0);
  // A lease that lapsed during a long render is left for the next claim rather than written back as blocked.
  const lapsed = harness({ ...running(base), leaseExpiresAt: new Date(Date.now() - 1000).toISOString() });
  assert.equal((await runCreativeRenderJob(lapsed.row(), { store: lapsed.store, now, service: svc })).state, 'running'); assert.equal(lapsed.writes.length, 0);
  const forged = harness(running({ ...base, payload: { stage: 'creative_render', render: { schema: 'x' } } }));
  assert.equal((await runCreativeRenderJob(forged.row(), { store: forged.store, now, service: svc })).state, 'blocked');
  assert.equal(calls, 0);
});

test('executeRender passes each operation to the service with the exact arguments the owner queued', async () => {
  const calls: unknown[][] = [];
  const rec = (name: string) => async (...args: unknown[]) => { calls.push([name, ...args]); return { setId: 'set', note: null, replayed: false, changed: ['x'], playable: true }; };
  const service = { draft: rec('draft'), refreshConcept: rec('refresh'), editConcept: rec('edit'), editFocal: rec('focal'), createStoryboard: rec('storyboard'), editStoryboard: rec('scenes'), renderVideo: rec('video'),
    artworkSet: async () => 'set-of-version' } as unknown as RenderService;
  const brand = randomUUID(), sponsor = randomUUID(), cmd = randomUUID(), setId = randomUUID(), versionId = randomUUID();
  const run = (operation: Parameters<typeof newRenderJob>[3]) => executeRender(service, brand, decodeRenderJob(newRenderJob(brand, sponsor, cmd, operation, now())));
  await run({ op: 'refresh', setId, conceptKey: 'c2', heads: ['h1', 'h2'] });
  await run({ op: 'edit', setId, conceptKey: 'c1', heads: ['h1'], patch: { headline: 'New' }, background: { kind: 'keep' } });
  await run({ op: 'focal', versionId, focal: { x: 0.25, y: 0.75 } });
  await run({ op: 'storyboard', setId, conceptKey: 'c3', placement: 'vertical', likeness: true });
  await run({ op: 'storyboard_edit', versionId, scenes: [{ headline: 'A' }, { headline: 'B' }] });
  const video = await run({ op: 'video', versionId });
  assert.deepEqual(calls, [
    ['refresh', sponsor, brand, setId, 'c2', cmd, ['h1', 'h2']],
    ['edit', sponsor, brand, setId, 'c1', cmd, ['h1'], { headline: 'New' }, { kind: 'keep' }],
    ['focal', sponsor, brand, versionId, cmd, { x: 0.25, y: 0.75 }],
    ['storyboard', sponsor, brand, setId, 'c3', 'vertical', cmd, true],
    ['scenes', sponsor, brand, versionId, cmd, [{ headline: 'A' }, { headline: 'B' }]],
    ['video', sponsor, brand, versionId, cmd],
  ]);
  assert.equal(video.setId, 'set-of-version');
});

test('decode refuses malformed operation shapes before any service call', () => {
  const brand = randomUUID(), sponsor = randomUUID(), cmd = randomUUID();
  const job = newRenderJob(brand, sponsor, cmd, { op: 'focal', versionId: randomUUID(), focal: { x: 0.5, y: 0.5 } }, now());
  const withOp = (operation: unknown) => ({ ...job, payload: { ...job.payload, render: { ...(job.payload.render as object), operation } } }) as Job;
  for (const bad of [{ op: 'focal', versionId: 'v', focal: { x: 'left', y: 0.5 } }, { op: 'refresh', setId: 's', conceptKey: 'c', heads: 'h1' }, { op: 'draft', raw: 'x', background: { kind: 'neutral' } },
    { op: 'edit', setId: 's', conceptKey: 'c', heads: [], patch: null, background: { kind: 'neutral' } }, { op: 'storyboard', setId: 's', conceptKey: 'c', placement: 'vertical', likeness: 'yes' },
    { op: 'storyboard_edit', versionId: 'v', scenes: Array.from({ length: 10 }, () => ({})) }, { op: 'draft', raw: {}, background: { kind: 'upload' } }])
    assert.throws(() => decodeRenderJob(withOp(bad)), /not recognised/u, JSON.stringify(bad));
});
