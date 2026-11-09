/** Real disposable PostgreSQL proof for storyboard/video media in the creative library (0143). Labelled stub renderer. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import jpeg from 'jpeg-js';
import pg from 'pg';
import { PgSeoBlogStore } from '../../src/seo-blog/pg-store.js';
import { PgCreativeLibraryStore } from '../../src/creative-studio/pg-store.js';
import { CreativeStudioService, setView } from '../../src/creative-studio/service.js';
import type { ArtworkInput, ArtworkRenderer, ContactSheetFrame, RenderedArtwork, RenderedVideo, VideoInput } from '../../src/creative-studio/renderer.js';
import { fixtureBrand } from '../rl72-method-fixtures.js';

const raw = process.env.RL72_METHODS_PG_TEST_URL;
const skip = !raw || process.env.RELAUNCH72_DATABASE_INTEGRATION !== 'explicit-disposable-run' ? 'Explicit disposable creative-studio PostgreSQL run only.' : false;
const own = <T extends object>(o: T, k: string, b: Buffer) => { Object.defineProperty(o, k, { enumerable: false, get: () => Buffer.from(b) }); return o; };
const tiny = (seed: string) => { const h = createHash('sha256').update(seed).digest(); const d = Buffer.alloc(64); for (let i = 0; i < 16; i++) d.set([h[i]!, h[i + 1]!, h[i + 2]!, 255], i * 4); return Buffer.from(jpeg.encode({ data: d, width: 4, height: 4 }, 90).data); };
class Stub implements ArtworkRenderer {
  readonly version = 'test-motion-stub';
  available() { return true; }
  async renderBatch(inputs: readonly ArtworkInput[]) { return inputs.map((i) => { const b = tiny(i.headline + i.placement.id); const o = own({ mime: 'image/jpeg' as const, sha256: createHash('sha256').update(b).digest('hex'), width: i.placement.width, height: i.placement.height, contrast: { headline: 9 }, scrimAlpha: 0.4, headlineSize: 80, issues: [] }, 'bytes', b); return (i.captureOverlay ? own(o, 'overlay', Buffer.from('png')) : o) as unknown as RenderedArtwork; }); }
  async renderContactSheet(frames: readonly ContactSheetFrame[], title: string) { const b = tiny(title + frames.length); return { bytes: b, sha256: createHash('sha256').update(b).digest('hex'), width: 1600, height: 900 }; }
  async renderVideo(input: VideoInput) { const b = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom' + JSON.stringify(input.scenes.map((s) => s.durationMs)))]); const ms = input.scenes.reduce((n, s) => n + s.durationMs, 0);
    return own({ mime: 'video/mp4' as const, codec: 'avc1', container: 'progressive' as const, sha256: createHash('sha256').update(b).digest('hex'), width: input.width, height: input.height, durationMs: ms, measuredDurationMs: ms, playable: true, byteLength: b.length }, 'bytes', b) as unknown as RenderedVideo; }
}

test('storyboard and video media in real PostgreSQL: storyboards never approvable, videos bound to an exact storyboard, byte types enforced', { skip }, async (t) => {
  const target = new URL(raw!); assert(['localhost', '127.0.0.1'].includes(target.hostname)); assert.equal(target.pathname, '/relaunch72_test');
  const admin = new pg.Pool({ connectionString: raw, max: 3 });
  const u = new URL(raw!); u.username = 'r72_content_command'; u.password = 'local-methods-test-only';
  const pool = new pg.Pool({ connectionString: u.toString(), max: 4 });
  try {
    const f = fixtureBrand('home'), actor = f.profile.confirmedBy!, token = randomUUID() + randomUUID();
    await admin.query("INSERT INTO app.organizations(id,name,slug,kind) VALUES($1,$2,$3,'direct_customer')", [f.brand.organizationId, f.brand.name, 'org-' + f.brand.organizationId]);
    await admin.query("INSERT INTO app.users(id,email,status) VALUES($1,$2,'active')", [actor, actor + '@example.test']);
    await admin.query("INSERT INTO app.organization_memberships(organization_id,user_id,role,status) VALUES($1,$2,'owner','active')", [f.brand.organizationId, actor]);
    await admin.query('INSERT INTO app.workspaces(id,organization_id,name,slug) VALUES($1,$2,$3,$4)', [f.brand.id, f.brand.organizationId, f.brand.name, 'video-' + f.brand.id]);
    await admin.query("INSERT INTO app.workspace_memberships(workspace_id,organization_id,user_id,role,status,source_organization_id) VALUES($1,$2,$3,'owner','active',$2)", [f.brand.id, f.brand.organizationId, actor]);
    await admin.query("INSERT INTO app.user_sessions(token_hash,csrf_secret_hash,user_id,selected_workspace_id,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')", [createHash('sha256').update(token).digest(), createHash('sha256').update('csrf' + token).digest(), actor, f.brand.id]);
    await admin.query('INSERT INTO app.seo_blog_brands(workspace_id,organization_id,created_by_user_id,settings) VALUES($1,$2,$3,$4)', [f.brand.id, f.brand.organizationId, actor, JSON.stringify(f.brand.settings)]);
    const principal = { kind: 'user' as const, userId: actor, requestId: 'video-pg-test', sessionToken: token, selectedWorkspaceId: f.brand.id };
    const blogs = new PgSeoBlogStore(pool, principal), library = new PgCreativeLibraryStore(pool, principal);
    await blogs.saveProfile(f.profile);
    const studio = new CreativeStudioService({ library, brands: blogs, renderer: new Stub() });
    const { setId } = await studio.draft(actor, f.brand.id, randomUUID(), { purpose: 'advert', source_kind: 'offer', offer: f.profile.offers[0]!.name, audience: '', destination: f.profile.conversionPages[0]!.url, placements: ['vertical'], concepts: '1' }, { kind: 'neutral' });
    const ctx = async () => (await studio.context(actor, f.brand.id)).context;
    await studio.createStoryboard(actor, f.brand.id, setId, 'c1', 'vertical', randomUUID(), false);
    let concept = setView((await library.getSet(f.brand.id, setId))!, await ctx()).concepts[0]!;
    const sb = concept.storyboards[0]!.version;
    await t.test('a storyboard is stored as its own lineage and SQL refuses to approve it', async () => {
      const row = await admin.query('SELECT variant_key FROM app.creative_studio_versions WHERE workspace_id=$1 AND id=$2', [f.brand.id, sb.id]);
      assert.equal(row.rows[0].variant_key, 'c1:storyboard_vertical:0');
      await assert.rejects(library.approve(f.brand.id, randomUUID(), 'a'.repeat(64), { id: randomUUID(), versionId: sb.id, context: sb.context, renderSha256: sb.render.sha256, specSha256: sb.specSha256, contextSha256: sb.contextSha256,
        figuresConfirmed: false, scope: 'image_only', approvedBy: actor, approvedAt: new Date().toISOString() }, sb.context), /storyboard is a plan/);
    });
    await studio.renderVideo(actor, f.brand.id, sb.id, randomUUID());
    concept = setView((await library.getSet(f.brand.id, setId))!, await ctx()).concepts[0]!;
    const video = concept.videos[0]!.version;
    await t.test('a video stores real video bytes under its own key and is approvable as an exact version', async () => {
      const row = await admin.query('SELECT v.variant_key,b.mime FROM app.creative_studio_versions v JOIN app.seo_blog_blobs b ON b.workspace_id=v.workspace_id AND b.id=v.blob_id WHERE v.workspace_id=$1 AND v.id=$2', [f.brand.id, video.id]);
      assert.deepEqual(row.rows[0], { variant_key: 'c1:video_vertical:0', mime: 'video/mp4' });
      await studio.approve(actor, f.brand.id, video.id, randomUUID(), video.render.sha256, false);
      assert.equal(setView((await library.getSet(f.brand.id, setId))!, await ctx()).concepts[0]!.videos[0]!.state, 'approved');
    });
    await t.test('SQL refuses a video whose storyboard reference or byte type is wrong', async () => {
      const c = await ctx(), inputs = { profileVersion: c.profileVersion!, factsSha: c.factsSha!, kitVersion: c.kitVersion };
      const next = { ...video, id: randomUUID(), number: 2, parentVersionId: video.id };
      await assert.rejects(library.appendVersions(f.brand.id, randomUUID(), 'b'.repeat(64), setId, [{ ...next, variant: { ...video.variant, storyboard: { ...video.variant.storyboard!, sourceStoryboardSpecSha256: 'f'.repeat(64) } } }], inputs), /exact storyboard/);
      // Image bytes presented as a video version are refused at the byte-type check.
      await assert.rejects(library.appendVersions(f.brand.id, randomUUID(), 'c'.repeat(64), setId, [{ ...next, render: { ...video.render, blobId: sb.render.blobId, sha256: sb.render.sha256 } }], inputs), /permission|match/);
    });
  } finally { await pool.end(); await admin.end(); }
});
