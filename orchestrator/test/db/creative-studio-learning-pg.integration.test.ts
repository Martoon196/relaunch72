/**
 * Real disposable PostgreSQL proof for Milestone 5 (0143 learning section), as the actual r72_content_command
 * role with genuine owner sessions: findings are recorded only with evidence SQL recomputes from the existing CRM
 * rows; the journal is append-only; general patterns refuse brand-specific content and reach only the same person's
 * other brands, and only while shared. Upstream CRM rows are seeded by the disposable superuser (FK bypass for
 * unrelated import receipts only).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { PgSeoBlogStore } from '../../src/seo-blog/pg-store.js';
import { PgCreativeDistributionReader, PgCreativeLearningStore, PgCreativeLibraryStore } from '../../src/creative-studio/pg-store.js';
import { CreativeStudioService } from '../../src/creative-studio/service.js';
import { buildLearning, type RecordedFinding } from '../../src/creative-studio/learning.js';
import { creativeUtmContent } from '../../src/creative-studio/distribution.js';
import type { ArtworkRenderer } from '../../src/creative-studio/renderer.js';
import type { AcquisitionProposal, CreatorRecord } from '../../src/seo-blog/campaign-creator.js';
import { fixtureBrand } from '../rl72-method-fixtures.js';

const raw = process.env.RL72_METHODS_PG_TEST_URL;
const skip = !raw || process.env.RELAUNCH72_DATABASE_INTEGRATION !== 'explicit-disposable-run' ? 'Explicit disposable creative-studio PostgreSQL run only.' : false;
const unusedRenderer = { version: 'unused', available: () => false, renderBatch: async () => { throw new Error('unused'); } } as unknown as ArtworkRenderer;
const proposal = { concepts: [{ name: 'Practical', channels: ['email'] }, { name: 'General', channels: ['email'] }], measurement: { reviewAfterDays: 14 } } as unknown as AcquisitionProposal;

test('Milestone 5 on real PostgreSQL: evidence-checked findings journal and owner-authorised cross-brand patterns', { skip }, async (t) => {
  const target = new URL(raw!); assert(['localhost', '127.0.0.1'].includes(target.hostname)); assert.equal(target.pathname, '/relaunch72_test');
  const admin = new pg.Pool({ connectionString: raw, max: 2 });
  const u = new URL(raw!); u.username = 'r72_content_command'; u.password = 'local-methods-test-only';
  const pool = new pg.Pool({ connectionString: u.toString(), max: 4 });
  const seed = async (sql: string, values: unknown[]) => { const c = await admin.connect(); try { await c.query('BEGIN'); await c.query('SET LOCAL session_replication_role=replica'); await c.query(sql, values); await c.query('COMMIT'); } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); } };
  const session = async (actor: string, workspace: string) => {
    const token = randomUUID() + randomUUID();
    await admin.query("INSERT INTO app.user_sessions(token_hash,csrf_secret_hash,user_id,selected_workspace_id,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')", [createHash('sha256').update(token).digest(), createHash('sha256').update('csrf' + token).digest(), actor, workspace]);
    return { kind: 'user' as const, userId: actor, requestId: 'creative-m5-pg-test', sessionToken: token, selectedWorkspaceId: workspace };
  };
  async function fixture(kind: 'home' | 'b2b', owner?: { actor: string; organizationId: string }) {
    const f = fixtureBrand(kind), actor = owner?.actor ?? f.profile.confirmedBy!, org = owner?.organizationId ?? f.brand.organizationId;
    if (!owner) {
      await admin.query("INSERT INTO app.organizations(id,name,slug,kind) VALUES($1,$2,$3,'direct_customer')", [org, f.brand.name, 'org-' + org]);
      await admin.query("INSERT INTO app.users(id,email,status) VALUES($1,$2,'active')", [actor, actor + '@example.test']);
      await admin.query("INSERT INTO app.organization_memberships(organization_id,user_id,role,status) VALUES($1,$2,'owner','active')", [org, actor]);
    }
    await admin.query('INSERT INTO app.workspaces(id,organization_id,name,slug) VALUES($1,$2,$3,$4)', [f.brand.id, org, f.brand.name, 'learning-' + f.brand.id]);
    await admin.query("INSERT INTO app.workspace_memberships(workspace_id,organization_id,user_id,role,status,source_organization_id) VALUES($1,$2,$3,'owner','active',$2)", [f.brand.id, org, actor]);
    await admin.query('INSERT INTO app.seo_blog_brands(workspace_id,organization_id,created_by_user_id,settings) VALUES($1,$2,$3,$4)', [f.brand.id, org, actor, JSON.stringify(f.brand.settings)]);
    const principal = await session(actor, f.brand.id);
    const blogs = new PgSeoBlogStore(pool, principal);
    await blogs.saveProfile({ ...f.profile, confirmedBy: actor });
    const store = new PgCreativeLearningStore(pool, principal), reader = new PgCreativeDistributionReader(pool, principal);
    const campaignId = randomUUID(), record = { id: campaignId, brandId: f.brand.id, brief: { kind: 'acquisition', name: 'Spring plan' }, version: { content: proposal } } as unknown as CreatorRecord;
    await seed(`INSERT INTO app.seo_blog_creator_campaigns(workspace_id,id,kind,input_hash,brief,profile_version,facts_sha,assignment_revision,method_receipt_id,reserved_tokens,state,created_by)
      VALUES($1,$2,'acquisition',$3,'{}'::jsonb,1,$4,1,$5,0,'approved',$6)`, [f.brand.id, campaignId, 'a'.repeat(64), 'f'.repeat(64), randomUUID(), actor]);
    const studio = new CreativeStudioService({ library: new PgCreativeLibraryStore(pool, principal), brands: blogs, renderer: unusedRenderer, distribution: reader, learning: store,
      creators: { get: async (_b, id) => (id === campaignId ? record : null), list: async () => [record] } });
    return { ...f, actor, org, store, reader, studio, campaignId, utm: `spring-plan-${campaignId.replace(/-/gu, '').slice(0, 8)}` };
  }
  const tag = (concept: number) => creativeUtmContent(concept, '1a2b3c4d-0000-4000-8000-000000000000');
  const lead = async (ws: string, utm: string, content: string, at = '2026-11-03T09:00:00Z') => {
    const c = randomUUID();
    await seed("INSERT INTO app.contacts(id,workspace_id,display_name) VALUES($1,$2,'Synthetic contact')", [c, ws]);
    await seed(`INSERT INTO app.contact_import_attribution_facts(workspace_id,contact_id,provenance_id,source_system,source_record_id,utm_campaign,utm_content,attributed_at)
      VALUES($1,$2,$3,'legacy.synthetic',$4,$5,$6,$7)`, [ws, c, randomUUID(), randomUUID(), utm, content, at]);
  };
  try {
    const a = await fixture('home'), b = await fixture('b2b'), c = await fixture('b2b', { actor: a.actor, organizationId: a.org });
    for (let i = 0; i < 3; i++) await lead(a.brand.id, a.utm, tag(0));
    await lead(a.brand.id, a.utm, tag(1));
    let findingId = '';

    await t.test('recording findings stores the evidence SQL recomputed, with the server date', async () => {
      const learning = a.studio.learning();
      const view = await learning.view(a.actor, a.brand.id, a.campaignId);
      assert.deepEqual(view.read!.buckets.map((x) => [x.utmContent, x.leads]), [[tag(0), 3], [tag(1), 1]]);
      assert.ok(view.snapshot!.findings.some((f) => f.kind === 'comparison' && f.strength === 'insufficient_data'), 'fewer than 20 leads per arm: no comparison drawn');
      const command = randomUUID();
      const r = await learning.record(a.actor, a.brand.id, a.campaignId, command);
      findingId = r.id;
      assert.equal((await learning.record(a.actor, a.brand.id, a.campaignId, command)).replayed, true);
      const [saved] = await a.store.listFindings(a.brand.id, a.campaignId);
      assert.equal(saved!.id, findingId);
      assert.match(saved!.recordedAt, /^\d{4}-\d{2}-\d{2}T/u);
      const stored = await admin.query('SELECT evidence FROM app.creative_studio_findings WHERE workspace_id=$1 AND id=$2', [a.brand.id, findingId]);
      assert.deepEqual(stored.rows[0].evidence.map((x: { utmContent: string; leads: number }) => [x.utmContent, x.leads]), [[tag(0), 3], [tag(1), 1]], 'SQL stored its own read');
    });

    await t.test('forged, stale or foreign evidence is refused by SQL', async () => {
      const read = await a.reader.outcomes(a.brand.id, a.utm);
      const base = (over: Partial<RecordedFinding> = {}): RecordedFinding => ({ id: randomUUID(), campaignId: a.campaignId, utmCampaign: a.utm, read, snapshot: buildLearning(read, proposal), recordedBy: a.actor, recordedAt: new Date().toISOString(), ...over });
      const inflated = { ...read, buckets: read.buckets.map((x) => ({ ...x, leads: x.leads + 10 })) };
      await assert.rejects(a.store.recordFinding(a.brand.id, randomUUID(), 'a'.repeat(64), base({ read: inflated, snapshot: buildLearning(inflated, proposal) })), /Outcomes changed/u);
      const good = base(), swapped = { ...good.snapshot, findings: good.snapshot.findings.map((f) => ({ ...f, evidence: f.evidence.map((x) => ({ ...x, leads: x.qualified, qualified: x.leads })) })) };
      await assert.rejects(a.store.recordFinding(a.brand.id, randomUUID(), 'b'.repeat(64), { ...good, snapshot: swapped }), /not observed/u, 'swapped counts are not accepted by unordered containment');
      await assert.rejects(a.store.recordFinding(a.brand.id, randomUUID(), 'c'.repeat(64), base({ campaignId: b.campaignId, utmCampaign: b.utm })), /acquisition campaigns/u, 'another brand\'s campaign');
      await assert.rejects(a.store.recordFinding(a.brand.id, randomUUID(), 'd'.repeat(64), base({ recordedBy: b.actor })), /acquisition campaigns|Invalid/u, 'cannot record as someone else');
      await lead(a.brand.id, a.utm, tag(1), '2026-11-06T09:00:00Z');
      await assert.rejects(a.store.recordFinding(a.brand.id, randomUUID(), 'e'.repeat(64), good), /Outcomes changed/u, 'a read older than the CRM is refused');
      await assert.rejects(admin.query('UPDATE app.creative_studio_findings SET utm_campaign=utm_campaign WHERE workspace_id=$1', [a.brand.id]), /append|immutable|not allowed/iu);
      await assert.rejects(pool.query('SELECT * FROM app.creative_studio_findings'), /permission denied/u);
      const crossed = new PgCreativeLearningStore(pool, { ...(await session(b.actor, b.brand.id)), selectedWorkspaceId: a.brand.id });
      await assert.rejects(crossed.listFindings(a.brand.id), /permission|Sign in/u);
    });

    await t.test('patterns: brand-specific content refused; visible only to the same person\'s other brands while shared', async () => {
      const share = (statement: string) => a.store.decidePattern(a.brand.id, randomUUID(), createHash('sha256').update(statement + randomUUID()).digest('hex'),
        { id: randomUUID(), patternId: randomUUID(), findingId, statement, state: 'shared', decidedBy: a.actor, decidedAt: new Date().toISOString() });
      await assert.rejects(share('Practical questions raised qualified enquiries by 20 percent.'), /check|constraint|Check the/iu, 'figures');
      await assert.rejects(share('Fictional Hearth Maintenance readers liked practical first steps.'), /cannot name this brand/u, 'brand name');
      await assert.rejects(share('People asking about a maintenance enquiry wanted practical steps.'), /cannot name this brand/u, 'offer name');
      await assert.rejects(a.store.decidePattern(a.brand.id, randomUUID(), 'f'.repeat(64), { id: randomUUID(), patternId: randomUUID(), findingId: randomUUID(), statement: 'Practical first-step questions drew more enquiries.', state: 'shared', decidedBy: a.actor, decidedAt: new Date().toISOString() }), /recorded findings/u);
      const statement = 'Practical first-step questions drew more qualified enquiries than general invitations.';
      await share(statement);
      const mine = await a.store.patterns(a.brand.id, 'mine');
      assert.deepEqual(mine.map((p) => [p.statement, p.state]), [[statement, 'shared']]);
      assert.deepEqual((await c.store.patterns(c.brand.id, 'other')).map((p) => p.statement), [statement], 'the same owner sees it in another brand');
      assert.deepEqual(await b.store.patterns(b.brand.id, 'other'), [], 'a different owner never sees it');
      const withdraw = () => a.store.decidePattern(a.brand.id, randomUUID(), createHash('sha256').update(randomUUID()).digest('hex'),
        { id: randomUUID(), patternId: mine[0]!.patternId, findingId, statement, state: 'withdrawn', decidedBy: a.actor, decidedAt: new Date().toISOString() });
      await withdraw();
      assert.deepEqual(await c.store.patterns(c.brand.id, 'other'), [], 'withdrawn patterns disappear from other brands');
      await assert.rejects(withdraw(), /currently shared/u);
      assert.deepEqual((await a.store.patterns(a.brand.id, 'mine')).map((p) => p.state), ['withdrawn'], 'history is kept');
    });
  } finally {
    await pool.end(); await admin.end();
  }
});
