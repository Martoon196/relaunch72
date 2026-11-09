/**
 * Real disposable PostgreSQL proof for typed-brief image generation (0144 section 5), as the actual r72_content_command
 * role with genuine owner sessions and a worker principal. The provider transport is the real generateImageCandidate with a
 * scripted HTTP response (no network, no charge). Operator-policy amounts are artificial proof units, never prices.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import jpeg from 'jpeg-js';
import pg from 'pg';
import { PgSeoBlogStore } from '../../src/seo-blog/pg-store.js';
import { PgSeoBlogMediaStore } from '../../src/seo-blog/media-store.js';
import { generateImageCandidate, type ImageGenerationOptions } from '../../src/seo-blog/image-generation.js';
import { CreativeGeneration } from '../../src/creative-studio/generation-service.js';
import { PgCreativeGenerationStore } from '../../src/creative-studio/generation-store.js';
import { completeJobInTransaction, runCreativeImageJob } from '../../src/creative-studio/generation-worker.js';
import type { Job } from '../../src/seo-blog/types.js';
import { fixtureBrand } from '../rl72-method-fixtures.js';

const raw = process.env.RL72_METHODS_PG_TEST_URL;
const skip = !raw || process.env.RELAUNCH72_DATABASE_INTEGRATION !== 'explicit-disposable-run' ? 'Explicit disposable creative-studio PostgreSQL run only.' : false;
const KEY = 'sk-test-' + 'x'.repeat(40);

function syntheticJpeg(width: number, height: number): Buffer {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set([40 + (i % width) % 120, 90, 140 + Math.floor(i / width) % 80, 255], i * 4);
  return Buffer.from(jpeg.encode({ data, width, height }, 70).data);
}
/** Scripted provider: records each call; returns one JPEG of the requested size, or fails as instructed. */
function scriptedProvider() {
  const calls: { url: string; size: string | null; parts: string[] }[] = [];
  let mode: 'ok' | 'timeout' | 'refuse' = 'ok';
  const fetchImpl = (async (url: string, init: RequestInit) => {
    let size: string | null = null; const parts: string[] = [];
    if (typeof init.body === 'string') size = JSON.parse(init.body).size;
    else if (init.body instanceof FormData) { size = String(init.body.get('size')); for (const [k] of init.body.entries()) parts.push(k); }
    calls.push({ url, size, parts });
    if (mode === 'timeout') throw new Error('socket hang up');
    if (mode === 'refuse') return new Response(JSON.stringify({ error: { code: 'moderation_blocked', message: 'blocked' } }), { status: 400, headers: { 'content-type': 'application/json' } });
    const [w, h] = (size ?? '1536x1024').split('x').map(Number);
    const body = JSON.stringify({ data: [{ b64_json: syntheticJpeg(w!, h!).toString('base64') }], usage: { input_tokens: 50, output_tokens: 1000, total_tokens: 1050, input_tokens_details: { text_tokens: 50, image_tokens: 0 }, output_tokens_details: { image_tokens: 1000 } } });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': 'req_' + randomUUID() } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl, set: (m: typeof mode) => { mode = m; } };
}

test('typed-brief generation on real PostgreSQL: owner intent, shared admission, one paid call, durable record, holds and isolation', { skip, timeout: 300_000 }, async (t) => {
  const target = new URL(raw!); assert(['localhost', '127.0.0.1'].includes(target.hostname)); assert.equal(target.pathname, '/relaunch72_test');
  const admin = new pg.Pool({ connectionString: raw, max: 2 });
  const u = new URL(raw!); u.username = 'r72_content_command'; u.password = 'local-methods-test-only';
  const pool = new pg.Pool({ connectionString: u.toString(), max: 6 });
  const provider = scriptedProvider();
  async function fixture(kind: 'home' | 'b2b') {
    const f = fixtureBrand(kind), actor = f.profile.confirmedBy!, token = randomUUID() + randomUUID();
    await admin.query("INSERT INTO app.organizations(id,name,slug,kind) VALUES($1,$2,$3,'direct_customer')", [f.brand.organizationId, f.brand.name, 'org-' + f.brand.organizationId]);
    await admin.query("INSERT INTO app.users(id,email,status) VALUES($1,$2,'active')", [actor, actor + '@example.test']);
    await admin.query("INSERT INTO app.organization_memberships(organization_id,user_id,role,status) VALUES($1,$2,'owner','active')", [f.brand.organizationId, actor]);
    await admin.query('INSERT INTO app.workspaces(id,organization_id,name,slug) VALUES($1,$2,$3,$4)', [f.brand.id, f.brand.organizationId, f.brand.name, 'gen-' + f.brand.id]);
    await admin.query("INSERT INTO app.workspace_memberships(workspace_id,organization_id,user_id,role,status,source_organization_id) VALUES($1,$2,$3,'owner','active',$2)", [f.brand.id, f.brand.organizationId, actor]);
    await admin.query("INSERT INTO app.user_sessions(token_hash,csrf_secret_hash,user_id,selected_workspace_id,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')", [createHash('sha256').update(token).digest(), createHash('sha256').update('csrf' + token).digest(), actor, f.brand.id]);
    await admin.query('INSERT INTO app.seo_blog_brands(workspace_id,organization_id,created_by_user_id,settings) VALUES($1,$2,$3,$4)', [f.brand.id, f.brand.organizationId, actor, JSON.stringify(f.brand.settings)]);
    const principal = { kind: 'user' as const, userId: actor, requestId: 'gen-pg', sessionToken: token, selectedWorkspaceId: f.brand.id };
    const media = new PgSeoBlogMediaStore(pool, principal, { publicOrigin: 'https://app.relaunch72.com' });
    const blogs = new PgSeoBlogStore(pool, principal, media);
    await blogs.saveProfile(f.profile);
    const store = new PgCreativeGenerationStore(pool, principal);
    const gen = new CreativeGeneration({ store, brands: blogs, policy: () => media.readImagePolicy(), providerConfigured: true });
    return { ...f, actor, blogs, store, gen, media };
  }
  const settings = (ws: string, studio: unknown, imagesPerMonth: number) => admin.query(
    "UPDATE app.seo_blog_brands SET settings=jsonb_set(settings||jsonb_build_object('studioImages',$2::jsonb),'{budgets,imagesPerMonth}',to_jsonb($3::int)) WHERE workspace_id=$1", [ws, JSON.stringify(studio), imagesPerMonth]);
  const policy = (patch: Record<string, unknown>) => admin.query('UPDATE app_private.seo_image_operator_policy SET version=version+1,config=config||$1::jsonb', [JSON.stringify(patch)]);
  const wPrincipal = { kind: 'worker' as const, requestId: 'gen-worker' };
  const wMedia = new PgSeoBlogMediaStore(pool, wPrincipal, { publicOrigin: 'https://app.relaunch72.com' });
  const wStore = new PgSeoBlogStore(pool, wPrincipal, wMedia);
  const wGen = new PgCreativeGenerationStore(pool, wPrincipal);
  const claim = async (ws: string, jobId: string, owner = 'gen-proof'): Promise<Job> => {
    const jobs = await wStore.claimJobs({ brandId: ws, now: new Date().toISOString(), owner, leaseMs: 600_000, limit: 10 });
    const job = jobs.find((j) => j.id === jobId); assert.ok(job, 'the worker claims the queued studio job'); return job!;
  };
  const run = (job: Job) => runCreativeImageJob(job, { store: wStore, generation: wGen, media: wMedia, providerConfigured: true, now: () => new Date().toISOString(),
    completeInTransaction: completeJobInTransaction, generate: (c, o: ImageGenerationOptions, s) => generateImageCandidate(c, { apiKey: KEY, fetchImpl: provider.fetchImpl, ...(s ? { signal: s } : {}) }, o) });
  const usage = async (ws: string) => Number((await admin.query("SELECT coalesce(sum(amount),0)::int AS n FROM app.seo_blog_usage WHERE workspace_id=$1 AND kind='images'", [ws])).rows[0].n);
  try {
    const a = await fixture('home'), b = await fixture('b2b');
    let briefId = '', jobId = '', generationAsset = { id: '', sha: '' };

    await t.test('defaults are off: a brief saves free of charge, but no request can start until owner and operator allow it', async () => {
      const saved = await a.gen.saveBrief(a.actor, a.brand.id, randomUUID(), { title: 'Morning kitchen', text: 'A bright modern kitchen in morning light with a mug on the counter and space on the left.', size: '1536x1024', useVisualGuidance: true, references: [] });
      briefId = saved.briefId; assert.equal(saved.version, 1);
      await assert.rejects(a.gen.saveBrief(a.actor, a.brand.id, randomUUID(), { text: 'Visit https://example.com for a photo', size: '1536x1024' }), /links/u);
      const held = await a.gen.request(a.actor, a.brand.id, briefId, 1, randomUUID(), false, null);
      assert.ok('reason' in held && held.reason === 'studio_generation_disabled', 'studio switch defaults off');
      assert.equal(await usage(a.brand.id), 0);
    });

    await t.test('owner intent becomes one durable job; refresh and double click return the same job', async () => {
      await settings(a.brand.id, { enabled: true, perMonth: 2, authorizedBy: a.actor, authorizedAt: new Date().toISOString() }, 3);
      await policy({ enabled: true, maxConcurrency: 1, monthlyMicrousd: 1_000_000, perAttemptMicrousd: 100_000 });
      const command = randomUUID();
      const job = await a.gen.request(a.actor, a.brand.id, briefId, 1, command, false, null);
      assert.ok(!('reason' in job)); jobId = (job as Job).id; assert.equal(jobId, command); assert.equal((job as Job).state, 'queued');
      assert.equal(((await a.gen.request(a.actor, a.brand.id, briefId, 1, command, false, null)) as Job).id, jobId, 'same command replays');
      assert.equal(((await a.gen.request(a.actor, a.brand.id, briefId, 1, randomUUID(), false, null)) as Job).id, jobId, 'a second click while queued joins the same job');
      assert.equal(provider.calls.length, 0, 'the HTTP request never calls the provider');
    });

    await t.test('the worker admits once, calls the provider once, stores the candidate and records it with the job done atomically', async () => {
      const done = await run(await claim(a.brand.id, jobId));
      assert.equal(done.state, 'done', done.error ?? done.progress);
      assert.equal(provider.calls.length, 1); assert.match(provider.calls[0]!.url, /images\/generations$/u); assert.equal(provider.calls[0]!.size, '1536x1024');
      assert.equal(await usage(a.brand.id), 1, 'exactly one shared usage debit');
      const state = await a.store.state(a.brand.id, briefId);
      assert.equal(state.generations.length, 1);
      const g = state.generations[0]!; generationAsset = { id: g.assetId, sha: g.sha256 };
      assert.deepEqual([g.width, g.height, g.briefVersion], [1536, 1024, 1]);
      assert.equal(state.attempts[0]!.outcome, 'candidate_received');
      assert.deepEqual(state.attempts[0]!.usage, { inputTokens: 50, outputTokens: 1000, totalTokens: 1050, inputTextTokens: 50, inputImageTokens: 0, outputImageTokens: 1000 });
      const bytes = (await a.media.loadPrivateAsset(a.brand.id, g.assetId, g.sha256)).bytes;
      assert.equal(createHash('sha256').update(bytes).digest('hex'), g.sha256, 'the exact stored pixels');
    });

    await t.test('restart recovery: re-running the same job uses the saved receipt and never calls the provider again', async () => {
      await admin.query("UPDATE app.seo_blog_jobs SET state='queued',lease_expires_at=NULL,data=data||'{\"state\":\"queued\",\"leaseOwner\":null}'::jsonb WHERE workspace_id=$1 AND id=$2", [a.brand.id, jobId]);
      const again = await run(await claim(a.brand.id, jobId, 'restarted-worker'));
      assert.equal(again.state, 'done', again.error ?? again.progress);
      assert.equal(provider.calls.length, 1, 'no second paid call');
      assert.equal((await a.store.state(a.brand.id, briefId)).generations.length, 1, 'recorded once');
      assert.equal(await usage(a.brand.id), 1);
    });

    await t.test('a new paid image for the same brief version needs an explicit new intent naming the last one', async () => {
      const held = await a.gen.request(a.actor, a.brand.id, briefId, 1, randomUUID(), false, null);
      assert.ok('reason' in held && held.reason === 'new_intent_confirmation_required');
      const replaces = (held as { replacesIntentId?: string }).replacesIntentId!;
      assert.equal(replaces, jobId);
      const second = await a.gen.request(a.actor, a.brand.id, briefId, 1, randomUUID(), true, replaces);
      assert.ok(!('reason' in second));
      // Unknown provider outcome: the attempt stays reserved and is never re-sent.
      provider.set('timeout');
      const unknown = await run(await claim(a.brand.id, (second as Job).id));
      assert.equal(unknown.state, 'blocked'); assert.match(unknown.error ?? '', /not confirmed/u);
      assert.equal(provider.calls.length, 2);
      await admin.query("UPDATE app.seo_blog_jobs SET state='queued',lease_expires_at=NULL,data=data||'{\"state\":\"queued\",\"leaseOwner\":null}'::jsonb WHERE workspace_id=$1 AND id=$2", [a.brand.id, (second as Job).id]);
      const rerun = await run(await claim(a.brand.id, (second as Job).id, 'restarted-worker'));
      assert.equal(rerun.state, 'blocked'); assert.equal(provider.calls.length, 2, 'existing started attempt: no repeat call');
      assert.equal(await usage(a.brand.id), 2, 'the unknown attempt still counts against the allowance');
      provider.set('ok');
    });

    await t.test('allowances and the shared concurrency limit hold before any provider call', async () => {
      // Studio allowance 2: one received + one unresolved = 2 counted, so a new version is held at admission.
      const v2 = await a.gen.saveBrief(a.actor, a.brand.id, randomUUID(), { title: 'Morning kitchen', text: 'The same kitchen, but at golden hour with warm light and the counter in focus.', size: '1024x1536', useVisualGuidance: false, references: [] }, briefId);
      assert.equal(v2.version, 2);
      const job = await a.gen.request(a.actor, a.brand.id, briefId, 2, randomUUID(), false, null);
      const v2Job = (job as Job).id;
      // The unresolved attempt still occupies the shared concurrency slot (max 1): a transient pre-admission hold, re-queued later.
      const busy = await run(await claim(a.brand.id, v2Job));
      assert.equal(busy.state, 'queued');
      assert.equal(((busy.payload.image as Record<string, unknown>).result as Record<string, unknown>).code, 'global_concurrency');
      assert.ok(Date.parse(busy.runAfter) > Date.now(), 'waits before retrying');
      assert.equal(provider.calls.length, 2, 'no provider call while the shared slot is busy');
      // With room in the shared limit, the brand's own studio allowance (2 counted of 2) holds it for good.
      await policy({ maxConcurrency: 5 });
      await admin.query("UPDATE app.seo_blog_jobs SET run_after=now()-interval '1 second',data=jsonb_set(data,'{runAfter}',to_jsonb((now()-interval '1 second')::text)) WHERE workspace_id=$1 AND id=$2", [a.brand.id, v2Job]);
      const stale = await run(await claim(a.brand.id, v2Job));
      assert.equal(stale.state, 'blocked');
      assert.equal(((stale.payload.image as Record<string, unknown>).result as Record<string, unknown>).code, 'operator_policy_changed', 'an intent priced under an older policy needs the owner again');
      const renewed = await a.gen.request(a.actor, a.brand.id, briefId, 2, randomUUID(), false, null);
      assert.ok(!('reason' in renewed), 'a fresh owner request under the current policy');
      const heldAtWorker = await run(await claim(a.brand.id, (renewed as Job).id));
      assert.equal(heldAtWorker.state, 'blocked');
      assert.equal(((heldAtWorker.payload.image as Record<string, unknown>).result as Record<string, unknown>).code, 'studio_image_allowance');
      assert.match(heldAtWorker.error ?? '', /allowance/u);
      assert.equal(provider.calls.length, 2, 'no provider call for a held request');
      assert.equal(await usage(a.brand.id), 2, 'a held request debits nothing');
    });

    await t.test('reference images must be this brand’s own current private images; briefs and sources are brand-isolated', async () => {
      const refBrief = await a.gen.saveBrief(a.actor, a.brand.id, randomUUID(), { title: 'Variation', text: 'A variation of the earlier kitchen picture with a plant by the window.', size: '1024x1024', useVisualGuidance: false,
        references: [{ assetId: generationAsset.id, sha256: generationAsset.sha }] });
      const src = await a.store.readBriefSource(a.brand.id, refBrief.briefId, 1);
      assert.deepEqual((src!.snapshot as { brief: { references: unknown } }).brief.references, [{ assetId: generationAsset.id, sha256: generationAsset.sha }]);
      await assert.rejects(b.gen.saveBrief(b.actor, b.brand.id, randomUUID(), { text: 'Use the other brand picture as a reference for this one.', size: '1024x1024', references: [{ assetId: generationAsset.id, sha256: generationAsset.sha }] }), /reference image|not a current private image/iu);
      assert.equal(await b.store.readBriefSource(b.brand.id, briefId, 1), null, 'another brand cannot read this brief');
      await assert.rejects(new PgCreativeGenerationStore(pool, { kind: 'user', userId: b.actor, requestId: 'x', sessionToken: 'not-a-session', selectedWorkspaceId: a.brand.id }).state(a.brand.id), /Sign in|permission|session/iu);
      await assert.rejects(pool.query('SELECT * FROM app.creative_studio_briefs'), /permission denied/u);
      await assert.rejects(pool.query('SELECT * FROM app.creative_studio_generations'), /permission denied/u);
      await assert.rejects(admin.query('UPDATE app.creative_studio_generations SET width=width WHERE workspace_id=$1', [a.brand.id]), /append|immutable|not allowed/iu);
      // The reference reaches the provider as one multipart image[] part on the edits endpoint, from this brand's stored bytes.
      await settings(a.brand.id, { enabled: true, perMonth: 4, authorizedBy: a.actor, authorizedAt: new Date().toISOString() }, 10);
      const refJob = await a.gen.request(a.actor, a.brand.id, refBrief.briefId, 1, randomUUID(), false, null);
      assert.ok(!('reason' in refJob), JSON.stringify(refJob));
      const before = provider.calls.length;
      const done = await run(await claim(a.brand.id, (refJob as Job).id));
      assert.equal(done.state, 'done', done.error ?? done.progress);
      assert.equal(provider.calls.length, before + 1);
      const call = provider.calls.at(-1)!;
      assert.match(call.url, /images\/edits$/u); assert.equal(call.size, '1024x1024');
      assert.equal(call.parts.filter((p) => p === 'image[]').length, 1);
    });

    await t.test('two jobs racing for the last studio image: exactly one is admitted and paid', async () => {
      // Counted so far: 2 received + 1 unresolved = 3 of 4, so only one more image fits.
      const ids: string[] = [];
      for (const text of ['A quiet reading corner with soft daylight and a wool throw on a chair.', 'An empty sunlit hallway with oak floorboards and a coat hook.']) {
        const s = await a.gen.saveBrief(a.actor, a.brand.id, randomUUID(), { text, size: '1024x1024', references: [] });
        const j = await a.gen.request(a.actor, a.brand.id, s.briefId, 1, randomUUID(), false, null);
        assert.ok(!('reason' in j), JSON.stringify(j)); ids.push((j as Job).id);
      }
      const claimed = await wStore.claimJobs({ brandId: a.brand.id, now: new Date().toISOString(), owner: 'race', leaseMs: 600_000, limit: 10 });
      const both = ids.map((id) => claimed.find((j) => j.id === id)!); assert.ok(both.every(Boolean));
      const before = provider.calls.length, debits = await usage(a.brand.id);
      const results = await Promise.all(both.map((j) => run(j)));
      assert.deepEqual(results.map((r) => r.state).sort(), ['blocked', 'done']);
      const held = results.find((r) => r.state === 'blocked')!;
      assert.equal(((held.payload.image as Record<string, unknown>).result as Record<string, unknown>).code, 'studio_image_allowance');
      assert.equal(provider.calls.length, before + 1, 'one paid call, never two');
      assert.equal(await usage(a.brand.id), debits + 1);
    });
  } finally {
    await pool.end(); await admin.end();
  }
});
