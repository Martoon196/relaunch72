/**
 * Real disposable PostgreSQL proof for durable Creative Studio render jobs: the owner's request records a job and
 * renders nothing; the production worker runner (creativeRenderRunner, real headless Chromium when present) renders it
 * for the job's sponsor; SQL binds the worker to that exact running claim, sponsor and command, and to reads and
 * version appends only. Runs as the actual r72_content_command role. No provider is involved anywhere.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { PgSeoBlogStore } from '../../src/seo-blog/pg-store.js';
import { PgSeoBlogMediaStore } from '../../src/seo-blog/media-store.js';
import { PgCreativeLibraryStore } from '../../src/creative-studio/pg-store.js';
import { CreativeStudioService } from '../../src/creative-studio/service.js';
import { creativeRenderer, creativeRenderRunner } from '../../src/portal/creative-studio-composition.js';
import { verifyCreativeImage } from '../../src/creative-studio/image-input.js';
import type { Job } from '../../src/seo-blog/types.js';
import { fixtureBrand } from '../rl72-method-fixtures.js';
import { syntheticLandscapeJpeg } from '../creative-studio-fixtures.js';

const raw = process.env.RL72_METHODS_PG_TEST_URL;
const skip = !raw || process.env.RELAUNCH72_DATABASE_INTEGRATION !== 'explicit-disposable-run' ? 'Explicit disposable creative-studio PostgreSQL run only.'
  : !creativeRenderer().available() ? 'Headless Chromium is not installed here.' : false;

test('durable render jobs on real PostgreSQL: request records, worker renders for the sponsor, SQL binds the claim', { skip, timeout: 300_000 }, async (t) => {
  const target = new URL(raw!); assert(['localhost', '127.0.0.1'].includes(target.hostname)); assert.equal(target.pathname, '/relaunch72_test');
  const admin = new pg.Pool({ connectionString: raw, max: 2 });
  const u = new URL(raw!); u.username = 'r72_content_command'; u.password = 'local-methods-test-only';
  const pool = new pg.Pool({ connectionString: u.toString(), max: 6 });
  async function fixture(kind: 'home' | 'b2b') {
    const f = fixtureBrand(kind), actor = f.profile.confirmedBy!, token = randomUUID() + randomUUID();
    await admin.query("INSERT INTO app.organizations(id,name,slug,kind) VALUES($1,$2,$3,'direct_customer')", [f.brand.organizationId, f.brand.name, 'org-' + f.brand.organizationId]);
    await admin.query("INSERT INTO app.users(id,email,status) VALUES($1,$2,'active')", [actor, actor + '@example.test']);
    await admin.query("INSERT INTO app.organization_memberships(organization_id,user_id,role,status) VALUES($1,$2,'owner','active')", [f.brand.organizationId, actor]);
    await admin.query('INSERT INTO app.workspaces(id,organization_id,name,slug) VALUES($1,$2,$3,$4)', [f.brand.id, f.brand.organizationId, f.brand.name, 'render-' + f.brand.id]);
    await admin.query("INSERT INTO app.workspace_memberships(workspace_id,organization_id,user_id,role,status,source_organization_id) VALUES($1,$2,$3,'owner','active',$2)", [f.brand.id, f.brand.organizationId, actor]);
    await admin.query("INSERT INTO app.user_sessions(token_hash,csrf_secret_hash,user_id,selected_workspace_id,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')", [createHash('sha256').update(token).digest(), createHash('sha256').update('csrf' + token).digest(), actor, f.brand.id]);
    await admin.query('INSERT INTO app.seo_blog_brands(workspace_id,organization_id,created_by_user_id,settings) VALUES($1,$2,$3,$4)', [f.brand.id, f.brand.organizationId, actor, JSON.stringify(f.brand.settings)]);
    const principal = { kind: 'user' as const, userId: actor, requestId: 'render-pg', sessionToken: token, selectedWorkspaceId: f.brand.id };
    const media = new PgSeoBlogMediaStore(pool, principal, { publicOrigin: 'https://app.relaunch72.com' });
    const blogs = new PgSeoBlogStore(pool, principal, media), library = new PgCreativeLibraryStore(pool, principal);
    await blogs.saveProfile(f.profile);
    // A renderer that must never be used by the owner's request.
    const studio = new CreativeStudioService({ library, brands: blogs, renderJobs: blogs,
      renderer: { version: 'request-must-not-render', available: () => true, renderBatch: async () => { throw new Error('rendered inside the request'); } } });
    return { ...f, actor, blogs, library, studio };
  }
  const env = { CREATIVE_STUDIO_ENABLED: 'true' } as NodeJS.ProcessEnv;
  const wPrincipal = { kind: 'worker' as const, requestId: 'render-worker' };
  const wStore = new PgSeoBlogStore(pool, wPrincipal, new PgSeoBlogMediaStore(pool, wPrincipal, { publicOrigin: 'https://app.relaunch72.com' }));
  const runner = creativeRenderRunner(pool, 'render-worker', env);
  const claim = async (ws: string, id: string, owner = 'render-proof'): Promise<Job> => {
    const job = (await wStore.claimJobs({ brandId: ws, now: new Date().toISOString(), owner, leaseMs: 600_000, limit: 10 })).find((j) => j.id === id);
    assert.ok(job, 'the worker claims the queued render job'); return job!;
  };
  const requeue = (ws: string, id: string) => admin.query("UPDATE app.seo_blog_jobs SET state='queued',lease_expires_at=NULL,run_after=now()-interval '1 second',data=data||'{\"state\":\"queued\",\"leaseOwner\":null}'::jsonb WHERE workspace_id=$1 AND id=$2", [ws, id]);
  const form = (f: ReturnType<typeof fixtureBrand>) => ({ purpose: 'advert', source_kind: 'offer', offer: f.profile.offers[0]!.name, audience: '', destination: f.profile.conversionPages[0]!.url, placements: ['square'], concepts: '2' });
  try {
    const a = await fixture('home'), b = await fixture('b2b');
    const draftCommand = randomUUID();
    let setId = '';

    await t.test('the owner request records one job and renders nothing; a double submit returns the same job', async () => {
      const job = await a.studio.enqueueRender(a.actor, a.brand.id, draftCommand, { op: 'draft', raw: form(a), background: { kind: 'neutral' } });
      assert.equal(job.id, draftCommand); assert.equal(job.state, 'queued'); assert.equal(job.payload.stage, 'creative_render');
      assert.equal((await a.studio.enqueueRender(a.actor, a.brand.id, draftCommand, { op: 'draft', raw: form(a), background: { kind: 'neutral' } })).id, job.id);
      assert.deepEqual(await a.library.listSets(a.brand.id), []);
      await assert.rejects(b.studio.enqueueRender(b.actor, a.brand.id, randomUUID(), { op: 'draft', raw: form(a), background: { kind: 'neutral' } }), /manage|permission|not found/iu, 'another owner cannot queue work for this brand');
    });

    await t.test('the production worker runner renders for the sponsor with real Chromium; the owner reads the result', async () => {
      const done = await runner.render!(await claim(a.brand.id, draftCommand));
      assert.equal(done.state, 'done', done.error ?? done.progress);
      const result = (done.payload.render as { result: { setId: string; message: string } }).result;
      setId = result.setId; assert.match(result.message, /Images created for review/u);
      const record = (await a.library.getSet(a.brand.id, setId))!;
      assert.equal(record.versions.length, 2);
      for (const v of record.versions) {
        assert.equal(v.createdBy, a.actor, 'recorded as the sponsoring owner');
        const blob = (await a.blogs.getBlob(a.brand.id, v.render.blobId))!;
        const img = verifyCreativeImage(blob.bytes);
        assert.deepEqual([img.mime, img.width, img.height], ['image/jpeg', 1080, 1080], 'real rendered JPEG of the placement size');
      }
      const task = await a.studio.renderTask(a.actor, a.brand.id, draftCommand);
      assert.equal(task.result?.setId, setId);
    });

    await t.test('restart: re-running a finished job replays the stored command and adds nothing', async () => {
      await requeue(a.brand.id, draftCommand);
      const again = await runner.render!(await claim(a.brand.id, draftCommand, 'restarted-worker'));
      assert.equal(again.state, 'done'); assert.match((again.payload.render as { result: { message: string } }).result.message, /already created/u);
      assert.equal((await a.library.getSet(a.brand.id, setId))!.versions.length, 2);
    });

    await t.test('a focal move and an uploaded background also run as jobs; a tampered stored reference is refused', async () => {
      const v = (await a.library.getSet(a.brand.id, setId))!.versions[0]!;
      const cmd = randomUUID();
      await a.studio.enqueueRender(a.actor, a.brand.id, cmd, { op: 'focal', versionId: v.id, focal: { x: 0.3, y: 0.6 } });
      const done = await runner.render!(await claim(a.brand.id, cmd));
      assert.equal(done.state, 'done', done.error ?? '');
      const after = (await a.library.getSet(a.brand.id, setId))!.versions.filter((x) => x.conceptKey === v.conceptKey && x.placement === v.placement);
      assert.equal(after.length, 2); assert.deepEqual(after.at(-1)!.variant.focal, { x: 0.3, y: 0.6 });
      // An uploaded background is verified and stored by the request; the worker re-verifies those exact bytes.
      const upload = syntheticLandscapeJpeg(900, 600), uploadCmd = randomUUID();
      const queued = await a.studio.enqueueRender(a.actor, a.brand.id, uploadCmd, { op: 'draft', raw: { ...form(a), concepts: '1' }, background: { kind: 'upload', bytes: upload } });
      const bg = (queued.payload.render as { operation: { background: { kind: string; component: { image: { blobId: string; sha256: string } } } } }).operation.background;
      assert.equal(bg.kind, 'prepared'); assert.equal(JSON.stringify(queued.payload).includes(upload.toString('base64').slice(0, 40)), false, 'no image bytes in the job row');
      const uploaded = await runner.render!(await claim(a.brand.id, uploadCmd));
      assert.equal(uploaded.state, 'done', uploaded.error ?? '');
      const set2 = (await a.library.getSet(a.brand.id, (uploaded.payload.render as { result: { setId: string } }).result.setId))!;
      const background = set2.versions[0]!.concept.background;
      assert.ok(background.kind === 'image' && background.origin === 'owner_upload' && background.image.blobId === bg.component.image.blobId);
      // A tampered stored reference is refused by the worker before rendering.
      const tamperCmd = randomUUID();
      await a.studio.enqueueRender(a.actor, a.brand.id, tamperCmd, { op: 'draft', raw: { ...form(a), concepts: '1' }, background: { kind: 'upload', bytes: upload } });
      await admin.query(`UPDATE app.seo_blog_jobs SET data=jsonb_set(data,'{payload,render,operation,background,component,image,sha256}','"${'0'.repeat(64)}"') WHERE workspace_id=$1 AND id=$2`, [a.brand.id, tamperCmd]);
      const tampered = await runner.render!(await claim(a.brand.id, tamperCmd));
      assert.equal(tampered.state, 'blocked'); assert.match(tampered.error ?? '', /integrity/u);
    });

    await t.test('SQL binds the worker to the exact running claim, sponsor and command, for reads and appends only', async () => {
      const cmd = randomUUID();
      await a.studio.enqueueRender(a.actor, a.brand.id, cmd, { op: 'refresh', setId, conceptKey: 'c1', heads: [] });
      const job = await claim(a.brand.id, cmd);
      const bound = new PgCreativeLibraryStore(pool, wPrincipal, { id: job.id, leaseOwner: job.leaseOwner!, attempt: job.attempts });
      assert.equal(await bound.renderActor(a.brand.id), a.actor);
      assert.ok(await bound.getSet(a.brand.id, setId), 'reads under the claim');
      const record = (await bound.getSet(a.brand.id, setId))!;
      const head = record.versions[0]!;
      const ctx = { profileVersion: head.context.profileVersion, factsSha: head.context.factsSha, kitVersion: head.context.kitVersion };
      await assert.rejects(bound.approve(a.brand.id, cmd, 'a'.repeat(64), { id: randomUUID(), versionId: head.id, renderSha256: head.render.sha256, approvedBy: a.actor, scope: 'image_only' } as never, ctx), /owner session|permission/iu, 'never approves');
      await assert.rejects(bound.saveKit(a.brand.id, cmd, 'a'.repeat(64), {} as never), /owner session|permission/iu, 'never changes the kit');
      await assert.rejects(bound.appendVersions(a.brand.id, randomUUID(), 'a'.repeat(64), setId, [head], ctx), /owner session|permission/iu, 'only its own command');
      for (const forged of [{ id: randomUUID(), leaseOwner: job.leaseOwner!, attempt: job.attempts }, { id: job.id, leaseOwner: 'someone-else', attempt: job.attempts },
        { id: job.id, leaseOwner: job.leaseOwner!, attempt: job.attempts + 1 }])
        await assert.rejects(new PgCreativeLibraryStore(pool, wPrincipal, forged).renderActor(a.brand.id), /owner session|permission/iu);
      await assert.rejects(bound.renderActor(b.brand.id), /owner session|permission/iu, 'the claim does not open another brand');
      // The sponsor stops managing the brand: the claim no longer grants anything and the job stops without rendering.
      await admin.query("UPDATE app.workspace_memberships SET status='revoked',revoked_at=now() WHERE workspace_id=$1 AND user_id=$2", [a.brand.id, a.actor]);
      const stopped = await runner.render!(job);
      assert.equal(stopped.state, 'blocked'); assert.equal((await a.library.getSet(a.brand.id, setId).catch(() => null)), null, 'the revoked owner reads nothing either');
      await admin.query("UPDATE app.workspace_memberships SET status='active',revoked_at=NULL WHERE workspace_id=$1 AND user_id=$2", [a.brand.id, a.actor]);
      assert.equal((await a.library.getSet(a.brand.id, setId))!.versions.length, 3, 'no version was added by the stopped job');
      // A finished (not running) job grants nothing.
      await assert.rejects(new PgCreativeLibraryStore(pool, wPrincipal, { id: draftCommand, leaseOwner: 'restarted-worker', attempt: 2 }).renderActor(a.brand.id), /owner session|permission/iu);
    });

    await t.test('the runtime role cannot call the worker path without the worker context, nor read job rows of another brand', async () => {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await assert.rejects(c.query("SELECT app_private.creative_studio_command($1,NULL,'kit_latest',$2)", [a.brand.id, JSON.stringify({ job: { id: draftCommand, leaseOwner: 'x', attempt: '1' } })]), /permission|owner session|session/iu);
        await c.query('ROLLBACK');
      } finally { c.release(); }
    });
  } finally {
    await pool.end(); await admin.end();
  }
});
