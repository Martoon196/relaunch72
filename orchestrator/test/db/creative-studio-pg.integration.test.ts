/**
 * Real disposable PostgreSQL proof for the Creative Studio library (migration 0143).
 * Runs as the actual least-privilege r72_content_command runtime role with genuine
 * owner sessions. Never accepts production or a remote database. The artwork
 * renderer is a labelled stub here: SQL boundaries are under test, not pixels.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import jpeg from 'jpeg-js';
import pg from 'pg';
import { PgSeoBlogStore } from '../../src/seo-blog/pg-store.js';
import { PgCreativeLibraryStore } from '../../src/creative-studio/pg-store.js';
import { CreativeStudioService, setView } from '../../src/creative-studio/service.js';
import type { ArtworkInput, ArtworkRenderer, RenderedArtwork } from '../../src/creative-studio/renderer.js';
import { fixtureBrand } from '../rl72-method-fixtures.js';

const raw = process.env.RL72_METHODS_PG_TEST_URL;
const skip = !raw || process.env.RELAUNCH72_DATABASE_INTEGRATION !== 'explicit-disposable-run' ? 'Explicit disposable creative-studio PostgreSQL run only.' : false;

/** Test stub: a tiny real JPEG whose bytes depend on the exact copy, so edits change the digest. */
class StubRenderer implements ArtworkRenderer {
  readonly version = 'test-stub-renderer';
  calls = 0;
  available() { return true; }
  async renderBatch(inputs: readonly ArtworkInput[]): Promise<RenderedArtwork[]> {
    return inputs.map((input) => {
      this.calls++;
      const seed = createHash('sha256').update(`${input.placement.id}|${input.headline}|${input.body}|${input.focal.x},${input.focal.y}|${input.palette.dark}`).digest();
      const data = Buffer.alloc(16 * 16 * 4);
      for (let i = 0; i < 256; i++) { data[i * 4] = seed[i % 32]!; data[i * 4 + 1] = seed[(i + 7) % 32]!; data[i * 4 + 2] = seed[(i + 13) % 32]!; data[i * 4 + 3] = 255; }
      const bytes = Buffer.from(jpeg.encode({ data, width: 16, height: 16 }, 90).data);
      const out = { mime: 'image/jpeg' as const, sha256: createHash('sha256').update(bytes).digest('hex'), width: input.placement.width, height: input.placement.height,
        contrast: { headline: 9 }, scrimAlpha: 0.42, headlineSize: input.placement.headline.max, issues: [] };
      Object.defineProperty(out, 'bytes', { enumerable: false, get: () => Buffer.from(bytes) });
      return out as unknown as RenderedArtwork;
    });
  }
}

test('Creative Studio on real PostgreSQL: tenant isolation, idempotent commands, exact approvals and stale invalidation', { skip }, async (t) => {
  const target = new URL(raw!); assert(['localhost', '127.0.0.1'].includes(target.hostname)); assert.equal(target.pathname, '/relaunch72_test');
  const admin = new pg.Pool({ connectionString: raw, max: 3 });
  const u = new URL(raw!); u.username = 'r72_content_command'; u.password = 'local-methods-test-only';
  const pool = new pg.Pool({ connectionString: u.toString(), max: 4 });
  const renderer = new StubRenderer();
  async function fixture(kind: 'home' | 'b2b') {
    const f = fixtureBrand(kind), actor = f.profile.confirmedBy!, token = randomUUID() + randomUUID();
    await admin.query("INSERT INTO app.organizations(id,name,slug,kind) VALUES($1,$2,$3,'direct_customer')", [f.brand.organizationId, f.brand.name, 'org-' + f.brand.organizationId]);
    await admin.query("INSERT INTO app.users(id,email,status) VALUES($1,$2,'active')", [actor, actor + '@example.test']);
    await admin.query("INSERT INTO app.organization_memberships(organization_id,user_id,role,status) VALUES($1,$2,'owner','active')", [f.brand.organizationId, actor]);
    await admin.query('INSERT INTO app.workspaces(id,organization_id,name,slug) VALUES($1,$2,$3,$4)', [f.brand.id, f.brand.organizationId, f.brand.name, 'creative-' + f.brand.id]);
    await admin.query("INSERT INTO app.workspace_memberships(workspace_id,organization_id,user_id,role,status,source_organization_id) VALUES($1,$2,$3,'owner','active',$2)", [f.brand.id, f.brand.organizationId, actor]);
    await admin.query("INSERT INTO app.user_sessions(token_hash,csrf_secret_hash,user_id,selected_workspace_id,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')", [createHash('sha256').update(token).digest(), createHash('sha256').update('csrf' + token).digest(), actor, f.brand.id]);
    await admin.query('INSERT INTO app.seo_blog_brands(workspace_id,organization_id,created_by_user_id,settings) VALUES($1,$2,$3,$4)', [f.brand.id, f.brand.organizationId, actor, JSON.stringify(f.brand.settings)]);
    const principal = { kind: 'user' as const, userId: actor, requestId: 'creative-pg-test', sessionToken: token, selectedWorkspaceId: f.brand.id };
    const blogs = new PgSeoBlogStore(pool, principal), library = new PgCreativeLibraryStore(pool, principal);
    await blogs.saveProfile(f.profile);
    const studio = new CreativeStudioService({ library, brands: blogs, renderer });
    return { ...f, actor, token, blogs, library, studio, principal };
  }
  const draftForm = (offer: string, destination: string) => ({ purpose: 'advert', source_kind: 'offer', offer, audience: '', destination, placements: ['square', 'portrait', 'vertical'], concepts: '3' });
  try {
    const a = await fixture('home'), b = await fixture('b2b');
    const offerA = a.profile.offers[0]!.name, destA = a.profile.conversionPages[0]!.url;

    let setId = '';
    await t.test('a brand drafts real stored versions; a repeated command replays without re-rendering or duplicating', async () => {
      const commandId = randomUUID();
      const first = await a.studio.draft(a.actor, a.brand.id, commandId, draftForm(offerA, destA), { kind: 'neutral' });
      setId = first.setId;
      const callsAfterFirst = renderer.calls;
      const again = await a.studio.draft(a.actor, a.brand.id, commandId, draftForm(offerA, destA), { kind: 'neutral' });
      assert.equal(again.replayed, true); assert.equal(again.setId, setId); assert.equal(renderer.calls, callsAfterFirst, 'replay must not render again');
      await assert.rejects(a.studio.draft(a.actor, a.brand.id, commandId, { ...draftForm(offerA, destA), concepts: '1' }, { kind: 'neutral' }), /already used|changed/u);
      const sets = await a.library.listSets(a.brand.id);
      assert.equal(sets.length, 1);
      const record = (await a.library.getSet(a.brand.id, setId))!;
      assert.ok(record.versions.length >= 3 && record.versions.length % 3 === 0);
      for (const v of record.versions) {
        const blob = await a.blogs.getBlob(a.brand.id, v.render.blobId);
        assert.equal(createHash('sha256').update(blob!.bytes).digest('hex'), v.render.sha256, 'stored bytes match the recorded digest');
        assert.equal(v.brandId, a.brand.id);
      }
    });

    await t.test('another brand owner cannot read, list or write the first brand\'s creative library', async () => {
      assert.deepEqual(await b.library.listSets(b.brand.id), []);
      await assert.rejects(b.studio.getSet(b.actor, a.brand.id, setId), /do not manage|403/u);
      // Bypass the service: B's genuine session aimed at A's workspace is refused by the SQL boundary itself.
      const crossed = new PgCreativeLibraryStore(pool, { ...b.principal, selectedWorkspaceId: a.brand.id });
      await assert.rejects(crossed.getSet(a.brand.id, setId), /permission|Sign in/u);
      await assert.rejects(crossed.listSets(a.brand.id), /permission|Sign in/u);
      // A's set id under B's own workspace does not exist.
      assert.equal(await b.library.getSet(b.brand.id, setId), null);
      // The runtime role has no direct table privilege at all.
      await assert.rejects(pool.query('SELECT * FROM app.creative_studio_versions'), /permission denied/u);
      await assert.rejects(pool.query('SELECT * FROM app.creative_studio_kits'), /permission denied/u);
    });

    await t.test('editing one concept versions only that concept; other approvals survive', async () => {
      let record = (await a.library.getSet(a.brand.id, setId))!;
      let view = setView(record, (await a.studio.context(a.actor, a.brand.id)).context);
      const keys = view.concepts.map((c) => c.key);
      const other = view.concepts.find((c) => c.key !== 'c1')!.variants[0]!.version;
      await a.studio.approve(a.actor, a.brand.id, other.id, randomUUID(), other.render.sha256, false);
      const c1 = view.concepts.find((c) => c.key === 'c1')!;
      const c1Square = c1.variants.find((v) => v.version.placement === 'square')!.version;
      await a.studio.approve(a.actor, a.brand.id, c1Square.id, randomUUID(), c1Square.render.sha256, false);
      const edit = await a.studio.editConcept(a.actor, a.brand.id, setId, 'c1', randomUUID(), c1.variants.map((v) => v.version.id), { headline: 'Book a maintenance discussion' }, { kind: 'keep' });
      assert.deepEqual(edit.changed, ['headline']);
      record = (await a.library.getSet(a.brand.id, setId))!;
      view = setView(record, (await a.studio.context(a.actor, a.brand.id)).context);
      assert.deepEqual(view.concepts.map((c) => c.key), keys);
      const newC1 = view.concepts.find((c) => c.key === 'c1')!;
      for (const v of newC1.variants) { assert.equal(v.version.number, 2); assert.equal(v.state, 'unapproved'); assert.equal(v.version.componentShas.body, c1Square.componentShas.body, 'unchanged body keeps its component digest'); }
      const untouched = view.concepts.flatMap((c) => c.variants).find((v) => v.version.id === other.id)!;
      assert.equal(untouched.state, 'approved');
      // The superseded exact version can neither be approved again nor handed off.
      await assert.rejects(a.studio.handoff(a.actor, a.brand.id, c1Square.id, randomUUID(), { kind: 'article_campaign', articleId: randomUUID() }), /not found|newer|current/u);
      const crossedStore = new PgCreativeLibraryStore(pool, a.principal);
      const ctx = (await a.studio.context(a.actor, a.brand.id)).context;
      await assert.rejects(crossedStore.approve(a.brand.id, randomUUID(), 'f'.repeat(64), { id: randomUUID(), versionId: c1Square.id, context: { profileVersion: ctx.profileVersion!, factsSha: ctx.factsSha!, kitVersion: 0 },
        renderSha256: c1Square.render.sha256, specSha256: c1Square.specSha256, contextSha256: ctx.contextSha256, figuresConfirmed: false, scope: 'image_only', approvedBy: a.actor, approvedAt: new Date().toISOString() }, { profileVersion: 1, factsSha: 'a'.repeat(64), kitVersion: 0 }), /newer version/u);
    });

    await t.test('a creative-kit change makes existing approvals stale until the artwork is refreshed and re-approved', async () => {
      await a.studio.saveKit(a.actor, a.brand.id, randomUUID(), { palette: { primary: '#1f4fd1', accent: '#ffc83d', dark: '#0d1424', light: '#ffffff' }, disclosure: 'Fictional fixture brand.', restricted: '', logo: { kind: 'keep' }, expectedVersion: 0 });
      const ctx = (await a.studio.context(a.actor, a.brand.id)).context;
      let view = setView((await a.library.getSet(a.brand.id, setId))!, ctx);
      const approved = view.concepts.flatMap((c) => c.variants).filter((v) => v.approval);
      assert.ok(approved.length >= 1);
      for (const v of approved) assert.equal(v.state, 'stale');
      const target = approved[0]!;
      await assert.rejects(a.studio.handoff(a.actor, a.brand.id, target.version.id, randomUUID(), { kind: 'article_campaign', articleId: randomUUID() }), /not found|no longer current|changed/u);
      const artwork = await a.studio.artwork(a.actor, a.brand.id, target.version.id, target.version.render.sha256);
      assert.equal(artwork.approved, false, 'a stale approval never downloads as approved');
      const concept = view.concepts.find((c) => c.key === target.version.conceptKey)!;
      await a.studio.refreshConcept(a.actor, a.brand.id, setId, concept.key, randomUUID(), concept.variants.map((v) => v.version.id));
      view = setView((await a.library.getSet(a.brand.id, setId))!, ctx);
      const fresh = view.concepts.find((c) => c.key === concept.key)!.variants.find((v) => v.version.placement === target.version.placement && v.version.card === target.version.card)!;
      assert.equal(fresh.version.context.kitVersion, 1);
      await a.studio.approve(a.actor, a.brand.id, fresh.version.id, randomUUID(), fresh.version.render.sha256, false);
      const ok = await a.studio.artwork(a.actor, a.brand.id, fresh.version.id, fresh.version.render.sha256);
      assert.equal(ok.approved, true);
    });

    await t.test('profile fact changes are rechecked by SQL even if a caller skips the service checks', async () => {
      const ctx = (await a.studio.context(a.actor, a.brand.id)).context;
      const view = setView((await a.library.getSet(a.brand.id, setId))!, ctx);
      const head = view.concepts[0]!.variants.find((v) => !v.approval)!.version;
      await a.blogs.saveProfile({ ...a.profile, version: 2, factsSha: 'b'.repeat(64), approvedClaims: ['A changed fictional claim.'] });
      await assert.rejects(a.library.approve(a.brand.id, randomUUID(), 'e'.repeat(64), { id: randomUUID(), versionId: head.id, context: head.context, renderSha256: head.render.sha256, specSha256: head.specSha256,
        contextSha256: head.contextSha256, figuresConfirmed: false, scope: 'image_only', approvedBy: a.actor, approvedAt: new Date().toISOString() }, head.context), /changed since/u);
      await a.blogs.saveProfile({ ...a.profile, version: 3 });
    });

    await t.test('hand-offs only reach the same brand\'s campaigns and create no delivery effect', async () => {
      const ctx = (await a.studio.context(a.actor, a.brand.id)).context;
      const view = setView((await a.library.getSet(a.brand.id, setId))!, ctx);
      const concept = view.concepts[0]!;
      await a.studio.refreshConcept(a.actor, a.brand.id, setId, concept.key, randomUUID(), concept.variants.map((v) => v.version.id));
      const fresh = setView((await a.library.getSet(a.brand.id, setId))!, ctx).concepts[0]!.variants[0]!.version;
      await a.studio.approve(a.actor, a.brand.id, fresh.id, randomUUID(), fresh.render.sha256, false);
      const bCampaign = randomUUID();
      await assert.rejects(a.library.handoff(a.brand.id, randomUUID(), 'd'.repeat(64), { id: randomUUID(), versionId: fresh.id, approvalId: (await a.library.getVersion(a.brand.id, fresh.id))!.approval!.id,
        target: { kind: 'creator_campaign', campaignId: bCampaign }, state: 'ready_for_review', createdBy: a.actor, createdAt: new Date().toISOString() }, fresh.context), /check the artwork|not found/iu);
      const delivery = await admin.query("SELECT count(*)::int AS n FROM app.seo_blog_jobs WHERE workspace_id=$1", [a.brand.id]);
      assert.equal(delivery.rows[0].n, 0, 'no job, post or delivery was created');
    });

    await t.test('stored rows are append-only and tampered bytes are refused', async () => {
      await assert.rejects(admin.query("UPDATE app.creative_studio_versions SET blocking=false WHERE workspace_id=$1", [a.brand.id]), /append|immutable|not allowed/iu);
      const record = (await a.library.getSet(a.brand.id, setId))!;
      const v = record.versions.at(-1)!;
      const ctx = (await a.studio.context(a.actor, a.brand.id)).context;
      const forged = { ...v, id: randomUUID(), number: v.number + 1, parentVersionId: v.id, context: { profileVersion: ctx.profileVersion!, factsSha: ctx.factsSha!, kitVersion: ctx.kitVersion }, render: { ...v.render, sha256: 'c'.repeat(64) } };
      await assert.rejects(a.library.appendVersions(a.brand.id, randomUUID(), 'b'.repeat(64), setId, [forged], forged.context), /permission|missing|match/iu);
    });
  } finally {
    await pool.end(); await admin.end();
  }
});
