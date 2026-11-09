/** Durable render jobs: job shape, strict decode, and the worker runner's stop/retry rules (fake service, no rendering). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { decodeRenderJob, newRenderJob, runCreativeRenderJob, type RenderService } from '../src/creative-studio/render-jobs.js';
import { SeoBlogError, type Job } from '../src/seo-blog/types.js';

const now = () => new Date().toISOString();
function harness(job: Job) {
  let row = job; const writes: Job[] = [];
  return { store: { getJob: async () => row, updateJob: async (j: Job) => { row = { ...j, rowVersion: row.rowVersion + 1 }; writes.push(row); return row; } }, writes, row: () => row };
}
const running = (j: Job, attempts = 1): Job => ({ ...j, state: 'running', attempts, leaseOwner: 'w', leaseExpiresAt: now() });
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
  const forged = harness(running({ ...base, payload: { stage: 'creative_render', render: { schema: 'x' } } }));
  assert.equal((await runCreativeRenderJob(forged.row(), { store: forged.store, now, service: svc })).state, 'blocked');
  assert.equal(calls, 0);
});
