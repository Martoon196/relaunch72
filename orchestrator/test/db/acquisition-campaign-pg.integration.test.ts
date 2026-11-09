/** Real disposable PostgreSQL proof: acquisition proposals on the reviewed creator boundary (0143 extension of 0139). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { CampaignCreator } from '../../src/seo-blog/campaign-creator.js';
import { PgCampaignCreatorStore } from '../../src/seo-blog/campaign-creator-store.js';
import { PgMethodStore } from '../../src/seo-blog/method-store.js';
import { PgSeoBlogStore } from '../../src/seo-blog/pg-store.js';
import { libraryPins, MethodController } from '../../src/seo-blog/method-packs.js';
import { fixtureBrand } from '../rl72-method-fixtures.js';
import { AcquisitionFixtureModel, acquisitionBrief, plan, researchSource } from '../acquisition-campaign-fixtures.js';

const raw = process.env.RL72_METHODS_PG_TEST_URL;
const skip = !raw || process.env.RELAUNCH72_DATABASE_INTEGRATION !== 'explicit-disposable-run' ? 'Explicit disposable acquisition PostgreSQL run only.' : false;

test('acquisition proposals: reviewed-pack gate, atomic reservation, single charge, exact receipt and kind constraint in real PostgreSQL', { skip }, async (t) => {
  const target = new URL(raw!); assert(['localhost', '127.0.0.1'].includes(target.hostname)); assert.equal(target.pathname, '/relaunch72_test');
  const admin = new pg.Pool({ connectionString: raw, max: 3 });
  const u = new URL(raw!); u.username = 'r72_content_command'; u.password = 'local-methods-test-only';
  const pool = new pg.Pool({ connectionString: u.toString(), max: 4 });
  async function fixture(packs: readonly string[]) {
    const f = fixtureBrand('home'), actor = f.profile.confirmedBy!, token = randomUUID() + randomUUID();
    await admin.query("INSERT INTO app.organizations(id,name,slug,kind) VALUES($1,$2,$3,'direct_customer')", [f.brand.organizationId, f.brand.name, 'org-' + f.brand.organizationId]);
    await admin.query("INSERT INTO app.users(id,email,status) VALUES($1,$2,'active')", [actor, actor + '@example.test']);
    await admin.query("INSERT INTO app.organization_memberships(organization_id,user_id,role,status) VALUES($1,$2,'owner','active')", [f.brand.organizationId, actor]);
    await admin.query('INSERT INTO app.workspaces(id,organization_id,name,slug) VALUES($1,$2,$3,$4)', [f.brand.id, f.brand.organizationId, f.brand.name, 'acq-' + f.brand.id]);
    await admin.query("INSERT INTO app.workspace_memberships(workspace_id,organization_id,user_id,role,status,source_organization_id) VALUES($1,$2,$3,'owner','active',$2)", [f.brand.id, f.brand.organizationId, actor]);
    await admin.query("INSERT INTO app.user_sessions(token_hash,csrf_secret_hash,user_id,selected_workspace_id,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')", [createHash('sha256').update(token).digest(), createHash('sha256').update('csrf' + token).digest(), actor, f.brand.id]);
    await admin.query('INSERT INTO app.seo_blog_brands(workspace_id,organization_id,created_by_user_id,settings) VALUES($1,$2,$3,$4)', [f.brand.id, f.brand.organizationId, actor, JSON.stringify(f.brand.settings)]);
    // 0145 deliberately starts every new brand at zero. Give only this synthetic
    // fixture its explicit test allowance after insert, as founder provisioning does.
    await admin.query('UPDATE app.seo_blog_brands SET settings=$2::jsonb WHERE workspace_id=$1', [f.brand.id, JSON.stringify({ ...f.brand.settings,
      operatorLimits: { modelTokens: 2000000, searchCalls: 100, images: 0, studioImages: 0, configuredBy: actor, configuredAt: new Date().toISOString() } })]);
    await admin.query("INSERT INTO app.seo_blog_method_private_organizations(organization_id,evidence,automatic_defaults,default_owner_user_id) VALUES($1,'Explicit test-only owned organization',false,null)", [f.brand.organizationId]);
    const principal = { kind: 'user' as const, userId: actor, requestId: 'acq-pg-test', sessionToken: token, selectedWorkspaceId: f.brand.id };
    const blogs = new PgSeoBlogStore(pool, principal), methods = new PgMethodStore(pool, principal), store = new PgCampaignCreatorStore(pool, principal);
    await blogs.saveProfile(f.profile);
    await blogs.savePlan(plan(f.brand.id, 'accepted', [researchSource(1), researchSource(2)]));
    await methods.assign(f.brand.id, 0, libraryPins('0.1.1').filter((p) => packs.includes(p.packId)));
    const model = new AcquisitionFixtureModel();
    return { ...f, actor, blogs, methods, store, model, creator: new CampaignCreator(store, blogs, new MethodController(methods, true), model) };
  }
  try {
    const a = await fixture(['production-core', 'conversion-copy', 'social-repurposing']);
    const id = randomUUID();
    const r = await a.creator.create(a.actor, a.brand.id, id, acquisitionBrief(a.profile, { count: 2 }));
    await t.test('draft binds to an exact acquisition receipt and charges accepted usage once', async () => {
      assert.equal(r.state, 'draft'); assert.equal(r.brief.kind, 'acquisition');
      const receipt = await a.methods.receipt(a.brand.id, r.version!.methodReceiptId!);
      assert.equal(receipt!.stage, 'acquisition'); assert.equal(receipt!.resultHash, r.version!.contentSha); assert.ok(receipt!.resultText);
      const usage = await admin.query('SELECT amount FROM app.seo_blog_usage WHERE workspace_id=$1 AND reference=$2', [a.brand.id, 'method-cost:' + receipt!.id]);
      assert.equal(usage.rowCount, 1); assert.equal(Number(usage.rows[0].amount), 300);
      const row = await admin.query('SELECT kind,reserved_tokens,brief FROM app.seo_blog_creator_campaigns WHERE workspace_id=$1 AND id=$2', [a.brand.id, id]);
      assert.equal(row.rows[0].kind, 'acquisition'); assert.equal(Number(row.rows[0].reserved_tokens), 0);
      assert.equal(row.rows[0].brief.evidence.research[0].id, 'src-1', 'the server-built evidence pack is stored with the brief');
    });
    await t.test('replay and recovery never call the model or charge again', async () => {
      const calls = a.model.acquisitionCalls;
      assert.equal((await a.creator.create(a.actor, a.brand.id, id, acquisitionBrief(a.profile, { count: 2 }))).id, id);
      await a.creator.recover(a.actor, a.brand.id, id);
      assert.equal(a.model.acquisitionCalls, calls);
      const usage = await admin.query("SELECT count(*)::int AS n FROM app.seo_blog_usage WHERE workspace_id=$1 AND reference LIKE 'method-cost:%'", [a.brand.id]);
      assert.equal(usage.rows[0].n, 1);
    });
    await t.test('the SQL boundary requires the reviewed conversion-copy pin for an acquisition start', async () => {
      const b = await fixture(['production-core', 'email-writing']);
      const brief = { ...acquisitionBrief(b.profile), evidence: { research: [], facts: [], gaps: [] } };
      const snapshot = await b.methods.snapshot(b.brand.id);
      await assert.rejects(b.store.begin({ id: randomUUID(), brandId: b.brand.id, actorId: b.actor, brief, profileVersion: b.profile.version, factsSha: b.profile.factsSha,
        assignmentRevision: snapshot.assignment!.revision, methodReceiptId: randomUUID(), reservation: 350000, inputHash: 'a'.repeat(64) }), /permission|Reviewed|403/i);
      assert.equal(b.model.acquisitionCalls, 0);
    });
    await t.test('the creator kind constraint admits acquisition and nothing else new', async () => {
      await assert.rejects(admin.query("UPDATE app.seo_blog_creator_campaigns SET kind='other' WHERE workspace_id=$1 AND id=$2", [a.brand.id, id]), /check constraint/);
      const def = await admin.query("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname='seo_blog_creator_campaigns_kind_check'");
      assert.match(def.rows[0].d, /'email'.*'advocacy'.*'acquisition'/);
    });
  } finally { await pool.end(); await admin.end(); }
});
