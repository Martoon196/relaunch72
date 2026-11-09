/**
 * Real disposable PostgreSQL proof of campaign attribution capture (0144 section 6). A visitor's form submission goes
 * through the actual public handler, the existing CRM command (crm.createLead as the real r72_crm_command role) and
 * the studio touch function (r72_content_command); the existing outcome reader then attributes the lead to the right
 * campaign and artwork, and counts it as qualified only via the owner-mapped stage id. No CRM row is pre-tagged.
 * The upstream acquisition campaign row is seeded (its generation path needs a model); its tracked link is issued
 * through the real hand-off SQL.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import jpeg from 'jpeg-js';
import pg from 'pg';
import { PgSeoBlogStore } from '../../src/seo-blog/pg-store.js';
import { PgCreativeDistributionReader, PgCreativeEnquirySettings, PgCreativeLibraryStore } from '../../src/creative-studio/pg-store.js';
import { CreativeStudioService, setView } from '../../src/creative-studio/service.js';
import { creativeUtmContent } from '../../src/creative-studio/distribution.js';
import { buildLearning } from '../../src/creative-studio/learning.js';
import { enquiryToken, handleEnquiryPublic, PgEnquiryCapture } from '../../src/creative-studio/enquiry-capture.js';
import { CrmCommandService } from '../../src/crm-pg/commands.js';
import { createPgCrmTransactionRunner } from '../../src/crm-pg/repository.js';
import { requestDatabaseContext } from '../../src/db/rls.js';
import type { ArtworkInput, ArtworkRenderer, RenderedArtwork } from '../../src/creative-studio/renderer.js';
import { fixtureBrand } from '../rl72-method-fixtures.js';

const raw = process.env.RL72_METHODS_PG_TEST_URL;
const skip = !raw || process.env.RELAUNCH72_DATABASE_INTEGRATION !== 'explicit-disposable-run' ? 'Explicit disposable creative-studio PostgreSQL run only.' : false;
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const SECRET = 'e'.repeat(48);

class StubRenderer implements ArtworkRenderer {
  readonly version = 'test-stub-renderer';
  available() { return true; }
  async renderBatch(inputs: readonly ArtworkInput[]): Promise<RenderedArtwork[]> {
    return inputs.map((input) => {
      const data = Buffer.alloc(16 * 16 * 4, 120), bytes = Buffer.from(jpeg.encode({ data, width: 16, height: 16 }, 90).data);
      const out = { mime: 'image/jpeg' as const, sha256: sha(bytes), width: input.placement.width, height: input.placement.height, contrast: { headline: 9 }, scrimAlpha: 0.4, headlineSize: 80, issues: [] };
      Object.defineProperty(out, 'bytes', { enumerable: false, get: () => Buffer.from(bytes) });
      return out as unknown as RenderedArtwork;
    });
  }
}

/** Drives the real public handler as a browser would (GET the form, POST it back). */
async function http(capture: PgEnquiryCapture, method: string, path: string, form?: Record<string, string>) {
  const body = form ? new URLSearchParams(form).toString() : '';
  const req = new PassThrough() as unknown as IncomingMessage & PassThrough;
  Object.assign(req, { method, url: path, headers: form ? { 'content-type': 'application/x-www-form-urlencoded' } : {} });
  (req as PassThrough).end(body);
  let status = 0, headers: Record<string, string> = {}, out = '';
  const res = { writeHead(s: number, h: Record<string, string>) { status = s; headers = h; return res; }, end(c?: string) { out += c ?? ''; } } as unknown as ServerResponse;
  await handleEnquiryPublic(req, res, capture, SECRET, `enq-${randomUUID()}`);
  return { status, headers, body: out };
}
const field = (html: string, name: string) => new RegExp(`name="${name}" value="([^"]*)"`, 'u').exec(html)?.[1] ?? '';

test('campaign enquiries on real PostgreSQL: public form → existing CRM command → validated touch → existing outcome reader', { skip, timeout: 300_000 }, async (t) => {
  const target = new URL(raw!); assert(['localhost', '127.0.0.1'].includes(target.hostname)); assert.equal(target.pathname, '/relaunch72_test');
  const admin = new pg.Pool({ connectionString: raw, max: 2 });
  await admin.query("ALTER ROLE r72_crm_command PASSWORD 'local-crm-test-only'");
  const u = new URL(raw!); u.username = 'r72_content_command'; u.password = 'local-methods-test-only';
  const c = new URL(raw!); c.username = 'r72_crm_command'; c.password = 'local-crm-test-only';
  const pool = new pg.Pool({ connectionString: u.toString(), max: 4 }), crmPool = new pg.Pool({ connectionString: c.toString(), max: 4 });
  const crm = new CrmCommandService({ transactionRunner: createPgCrmTransactionRunner(crmPool) });
  const capture = new PgEnquiryCapture({ contentPool: pool, crm });
  const seed = async (sql: string, values: unknown[]) => { const x = await admin.connect(); try { await x.query('BEGIN'); await x.query('SET LOCAL session_replication_role=replica'); await x.query(sql, values); await x.query('COMMIT'); } catch (e) { await x.query('ROLLBACK'); throw e; } finally { x.release(); } };
  async function fixture(kind: 'home' | 'b2b') {
    const f = fixtureBrand(kind), actor = f.profile.confirmedBy!, token = randomUUID() + randomUUID();
    await admin.query("INSERT INTO app.organizations(id,name,slug,kind) VALUES($1,$2,$3,'direct_customer')", [f.brand.organizationId, f.brand.name, 'org-' + f.brand.organizationId]);
    await admin.query("INSERT INTO app.users(id,email,status) VALUES($1,$2,'active')", [actor, actor + '@example.test']);
    await admin.query("INSERT INTO app.organization_memberships(organization_id,user_id,role,status) VALUES($1,$2,'owner','active')", [f.brand.organizationId, actor]);
    await admin.query('INSERT INTO app.workspaces(id,organization_id,name,slug) VALUES($1,$2,$3,$4)', [f.brand.id, f.brand.organizationId, f.brand.name, 'enq-' + f.brand.id]);
    await admin.query("INSERT INTO app.workspace_memberships(workspace_id,organization_id,user_id,role,status,source_organization_id) VALUES($1,$2,$3,'owner','active',$2)", [f.brand.id, f.brand.organizationId, actor]);
    await admin.query("INSERT INTO app.user_sessions(token_hash,csrf_secret_hash,user_id,selected_workspace_id,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')", [createHash('sha256').update(token).digest(), createHash('sha256').update('csrf' + token).digest(), actor, f.brand.id]);
    await admin.query('INSERT INTO app.seo_blog_brands(workspace_id,organization_id,created_by_user_id,settings) VALUES($1,$2,$3,$4)', [f.brand.id, f.brand.organizationId, actor, JSON.stringify(f.brand.settings)]);
    const principal = { kind: 'user' as const, userId: actor, requestId: 'enquiry-pg', sessionToken: token, selectedWorkspaceId: f.brand.id };
    const blogs = new PgSeoBlogStore(pool, principal), library = new PgCreativeLibraryStore(pool, principal), reader = new PgCreativeDistributionReader(pool, principal);
    await blogs.saveProfile(f.profile);
    const studio = new CreativeStudioService({ library, brands: blogs, renderer: new StubRenderer(), distribution: reader, enquirySettings: new PgCreativeEnquirySettings(pool, principal) });
    return { ...f, actor, blogs, library, reader, studio };
  }
  try {
    const a = await fixture('home'), b = await fixture('b2b');
    // Brand A: approved artwork, an acquisition campaign and a tracked link issued through the real hand-off SQL.
    const draft = await a.studio.draft(a.actor, a.brand.id, randomUUID(), { purpose: 'advert', source_kind: 'offer', offer: a.profile.offers[0]!.name, audience: '', destination: a.profile.conversionPages[0]!.url, placements: ['portrait'], concepts: '1' }, { kind: 'neutral' });
    const ctx = (await a.studio.context(a.actor, a.brand.id)).context;
    const art = setView((await a.library.getSet(a.brand.id, draft.setId))!, ctx).concepts[0]!.variants[0]!.version;
    await a.studio.approve(a.actor, a.brand.id, art.id, randomUUID(), art.render.sha256, true);
    const approvalId = (await a.library.getVersion(a.brand.id, art.id))!.approval!.id, campaignId = randomUUID();
    await seed(`INSERT INTO app.seo_blog_creator_campaigns(workspace_id,id,kind,input_hash,brief,profile_version,facts_sha,assignment_revision,method_receipt_id,reserved_tokens,state,created_by)
      VALUES($1,$2,'acquisition',$3,'{}'::jsonb,1,$4,1,$5,0,'draft',$6)`, [a.brand.id, campaignId, 'a'.repeat(64), 'f'.repeat(64), randomUUID(), a.actor]);
    const utmCampaign = `spring-plan-${campaignId.replace(/-/gu, '').slice(0, 8)}`, utmContent = creativeUtmContent(0, art.id);
    const link = `https://hearth.example/request?utm_source=instagram&utm_medium=social&utm_campaign=${utmCampaign}&utm_content=${utmContent}`;
    const h = { id: randomUUID(), versionId: art.id, approvalId, state: 'ready_for_review' as const, createdBy: a.actor, createdAt: new Date().toISOString(),
      target: { kind: 'creator_campaign' as const, campaignId, concept: 0, channel: 'instagram' }, route: 'tracked_link' as const,
      trackedLink: { url: link, utmCampaign, utmContent, channel: 'instagram', concept: 0 } };
    await a.library.handoff(a.brand.id, randomUUID(), sha(h.id), h as never, art.context);
    const query = `?utm_source=instagram&utm_medium=social&utm_campaign=${utmCampaign}&utm_content=${utmContent}`;
    let formPath = '', keyB = '';

    await t.test('capture is off until the owner maps stages and adds a privacy notice; a brand with no pipeline gets the standard one', async () => {
      const before = await a.studio.enquiries(a.actor, a.brand.id);
      assert.equal(before.configured, false); assert.equal(before.pipelineId, null);
      await assert.rejects(a.studio.saveEnquiries(a.actor, a.brand.id, { enabled: true, privacyUrl: '', newStageId: '', qualifiedStageId: '', expectedVersion: 0 }), /privacy/iu);
      const saved = await a.studio.saveEnquiries(a.actor, a.brand.id, { enabled: true, privacyUrl: 'https://hearth.example/privacy', newStageId: '', qualifiedStageId: '', expectedVersion: 0 });
      assert.equal(saved.enabled, true); assert.equal(saved.pipelineName, 'Enquiries');
      assert.deepEqual(saved.stages.map((s) => s.name), ['New enquiry', 'Contacted', 'Qualified', 'Won', 'Not proceeding']);
      assert.equal(saved.qualifiedStageId, saved.stages[2]!.id, 'qualified mapped by stage id');
      await assert.rejects(a.studio.saveEnquiries(a.actor, a.brand.id, { enabled: true, privacyUrl: 'https://hearth.example/privacy', newStageId: saved.stages[2]!.id, qualifiedStageId: saved.stages[0]!.id, expectedVersion: saved.rowVersion }), /later open stage/iu);
      await assert.rejects(b.studio.saveEnquiries(b.actor, a.brand.id, { enabled: false, privacyUrl: '', newStageId: '', qualifiedStageId: '', expectedVersion: 0 }), /permission|manage|not found/iu, 'another owner cannot configure this brand');
      formPath = `/enquire/${a.brand.id}/${saved.publicKey}`;
      const bs = await b.studio.saveEnquiries(b.actor, b.brand.id, { enabled: true, privacyUrl: 'https://queue.example/privacy', newStageId: '', qualifiedStageId: '', expectedVersion: 0 });
      keyB = bs.publicKey!;
      assert.equal((await http(capture, 'GET', `/enquire/${a.brand.id}/${bs.publicKey}`)).status, 404, 'a key works only for its own brand');
    });

    let contactId = '', opportunityId = '';
    await t.test('a real form submission creates the CRM lead and stores the campaign touch; the existing reader attributes it', async () => {
      const page = await http(capture, 'GET', formPath + query);
      assert.equal(page.status, 200); assert.match(page.body, /Send an enquiry/u); assert.match(page.headers['content-security-policy']!, /frame-ancestors 'none'/u);
      const form = { token: field(page.body, 'token'), utm_source: 'instagram', utm_medium: 'social', utm_campaign: utmCampaign, utm_content: utmContent,
        name: 'Fictional Visitor', email: 'visitor@example.test', phone: '', message: 'Please call me about a boiler check.', consent: 'yes', website: '' };
      const sent = await http(capture, 'POST', formPath, form);
      assert.equal(sent.status, 200, sent.body.slice(0, 300)); assert.match(sent.body, /Thank you/u);
      assert.equal((await http(capture, 'POST', formPath, form)).status, 200, 'a double submit replays');
      const touches = await admin.query('SELECT * FROM app.creative_studio_lead_touches WHERE workspace_id=$1', [a.brand.id]);
      assert.equal(touches.rows.length, 1, 'one touch, even after a double submit');
      ({ contact_id: contactId, opportunity_id: opportunityId } = touches.rows[0]);
      assert.deepEqual([touches.rows[0].campaign_id, touches.rows[0].utm_campaign, touches.rows[0].utm_content], [campaignId, utmCampaign, utmContent]);
      const lead = await admin.query('SELECT o.pipeline_id,o.stage_id,c.source FROM app.opportunities o JOIN app.contacts c ON c.workspace_id=o.workspace_id AND c.id=o.contact_id WHERE o.workspace_id=$1 AND o.id=$2', [a.brand.id, opportunityId]);
      const settings = await a.studio.enquiries(a.actor, a.brand.id);
      assert.deepEqual([lead.rows[0].pipeline_id, lead.rows[0].stage_id, lead.rows[0].source], [settings.pipelineId, settings.newStageId, 'creative_studio_enquiry']);
      assert.equal((await admin.query("SELECT count(*)::int n FROM app.command_receipts WHERE workspace_id=$1 AND command_name='crm.createLead'", [a.brand.id])).rows[0].n, 1, 'the existing CRM command created it once');
      const read = await a.reader.outcomes(a.brand.id, utmCampaign);
      assert.equal(read.qualifiedMapped, true);
      assert.deepEqual(read.buckets.map((x) => [x.utmContent, x.leads, x.qualified]), [[utmContent, 1, 0]]);
      // No personal data in any URL the system produced.
      for (const u of [formPath + query, link]) assert.equal(/visitor|example\.test|Fictional/iu.test(u), false);
    });

    await t.test('qualified follows the mapped stage id through the real CRM move, and survives renaming the stage', async () => {
      const settings = await a.studio.enquiries(a.actor, a.brand.id);
      const version = Number((await admin.query('SELECT row_version FROM app.opportunities WHERE workspace_id=$1 AND id=$2', [a.brand.id, opportunityId])).rows[0].row_version);
      await crm.moveOpportunityStage(requestDatabaseContext({ workspaceId: a.brand.id, userId: a.actor, requestId: 'move' }), { commandKey: `move-${randomUUID()}`, opportunityId, targetStageId: settings.qualifiedStageId!, expectedRowVersion: version });
      await admin.query("UPDATE app.pipeline_stages SET slug='sales-ready',name='Sales ready' WHERE workspace_id=$1 AND id=$2", [a.brand.id, settings.qualifiedStageId]);
      const read = await a.reader.outcomes(a.brand.id, utmCampaign);
      assert.deepEqual(read.buckets.map((x) => [x.leads, x.qualified]), [[1, 1]], 'counted by stage id, not the mutable slug');
      assert.ok(buildLearning(read, null).findings.some((f) => f.kind === 'observation' && /1 qualified/u.test(f.statement)));
      assert.ok(contactId);
    });

    await t.test('untrusted tags: malformed, unknown, altered or another brand’s references create the lead but no touch', async () => {
      const otherCampaign = `spring-plan-${randomUUID().replace(/-/gu, '').slice(0, 8)}`;
      const cases: [string, string][] = [
        [`/enquire/${a.brand.id}/${(await a.studio.enquiries(a.actor, a.brand.id)).publicKey}?utm_campaign=${otherCampaign}&utm_content=${utmContent}&utm_source=instagram&utm_medium=social`, 'unknown campaign'],
        [`${formPath}?utm_campaign=${utmCampaign}&utm_content=${utmContent}&utm_source=email&utm_medium=email`, 'source not on the issued link'],
        [`${formPath}?utm_campaign=DROP%20TABLE&utm_content=x`, 'malformed'],
        [`/enquire/${b.brand.id}/${keyB}${query}`, 'brand A’s link sent to brand B’s form'],
      ];
      for (const [path, label] of cases) {
        const page = await http(capture, 'GET', path);
        const form: Record<string, string> = { token: field(page.body, 'token'), name: 'Other Visitor', email: `${randomUUID().slice(0, 8)}@example.test`, phone: '', message: 'Hello there.', consent: 'yes', website: '' };
        for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content']) { const v = field(page.body, k); if (v) form[k] = v; }
        const sent = await http(capture, 'POST', path.split('?')[0]!, form);
        assert.equal(sent.status, 200, `${label}: ${sent.body.slice(0, 200)}`);
      }
      assert.equal((await admin.query('SELECT count(*)::int n FROM app.creative_studio_lead_touches')).rows[0].n, 1, 'no new touch for any of them');
      assert.equal((await admin.query("SELECT count(*)::int n FROM app.command_receipts WHERE command_name='crm.createLead' AND idempotency_key LIKE 'creative.enquiry.%'")).rows[0].n, 5, 'the leads themselves were captured');
    });

    await t.test('a second channel for the same concept is attributed; an existing customer cannot hand an old sale to the campaign', async () => {
      // The same artwork handed off on LinkedIn: a different tracked link with the same campaign and content tags.
      const linkedin = link.replace('utm_source=instagram', 'utm_source=linkedin');
      const h2 = { ...h, id: randomUUID(), target: { ...h.target, channel: 'linkedin' }, trackedLink: { ...h.trackedLink, url: linkedin, channel: 'linkedin' } };
      await a.library.handoff(a.brand.id, randomUUID(), sha(h2.id), h2 as never, art.context);
      const liQuery = query.replace('utm_source=instagram', 'utm_source=linkedin');
      const page = await http(capture, 'GET', formPath + liQuery);
      const sent = await http(capture, 'POST', formPath, { token: field(page.body, 'token'), utm_source: 'linkedin', utm_medium: 'social', utm_campaign: utmCampaign, utm_content: utmContent,
        name: 'LinkedIn Visitor', email: 'linkedin@example.test', phone: '', message: 'Saw this on LinkedIn.', consent: 'yes', website: '' });
      assert.equal(sent.status, 200, sent.body.slice(0, 200));
      const touches = await admin.query('SELECT utm_source,created_contact FROM app.creative_studio_lead_touches WHERE workspace_id=$1 ORDER BY captured_at', [a.brand.id]);
      assert.deepEqual(touches.rows.map((r) => r.utm_source), ['instagram', 'linkedin']); assert.ok(touches.rows.every((r) => r.created_contact === true));
      // An existing customer with a won opportunity and a payment sends a new enquiry through the campaign link.
      const settings = await a.studio.enquiries(a.actor, a.brand.id);
      const won = settings.stages.find((s) => s.type === 'won')!;
      const ownerCtx = requestDatabaseContext({ workspaceId: a.brand.id, userId: a.actor, requestId: 'seed-customer' });
      const customer = await crm.createLead(ownerCtx, { commandKey: `seed-${randomUUID()}`, displayName: 'Existing Customer', contactPoints: [{ kind: 'email', value: 'customer@example.test', isPrimary: true }],
        pipelineId: settings.pipelineId!, stageId: settings.newStageId!, valueMinor: 0, currency: 'GBP' });
      const v = Number((await admin.query('SELECT row_version FROM app.opportunities WHERE workspace_id=$1 AND id=$2', [a.brand.id, customer.opportunityId])).rows[0].row_version);
      await crm.moveOpportunityStage(ownerCtx, { commandKey: `win-${randomUUID()}`, opportunityId: customer.opportunityId, targetStageId: won.id, expectedRowVersion: v });
      await admin.query("UPDATE app.contacts SET lifecycle_status='customer' WHERE workspace_id=$1 AND id=$2", [a.brand.id, customer.contactId]);
      const again = await http(capture, 'GET', formPath + query);
      const resent = await http(capture, 'POST', formPath, { token: field(again.body, 'token'), utm_source: 'instagram', utm_medium: 'social', utm_campaign: utmCampaign, utm_content: utmContent,
        name: 'Existing Customer', email: 'customer@example.test', phone: '', message: 'Another question.', consent: 'yes', website: '' });
      assert.equal(resent.status, 200);
      const row = (await admin.query('SELECT contact_id,created_contact FROM app.creative_studio_lead_touches WHERE workspace_id=$1 ORDER BY captured_at DESC LIMIT 1', [a.brand.id])).rows[0];
      assert.equal(row.contact_id, customer.contactId); assert.equal(row.created_contact, false, 'the enquiry attached to the existing contact');
      const read = await a.reader.outcomes(a.brand.id, utmCampaign);
      const bucket = read.buckets.find((x) => x.utmContent === utmContent)!;
      assert.equal(bucket.leads, 3, 'three tagged contacts');
      assert.equal(bucket.sold, 0, 'the earlier win is not this campaign\u2019s sale'); assert.equal(bucket.customers, 0, 'an existing customer is not this campaign\u2019s customer');
      assert.equal(bucket.qualified, 1, 'only the first lead, moved to the mapped stage after its touch');
    });

    await t.test('the hourly cap is enforced in the database; expired tokens are refused; a new form address retires the old one; the embed may be framed only by the brand\u2019s origins', async () => {
      const key = formPath.split('/').at(-1)!;
      const nonce = () => createHash('sha256').update(randomUUID()).digest('hex');
      await admin.query('INSERT INTO app.creative_studio_enquiry_admissions(workspace_id,nonce_hash) SELECT $1,unnest($2::text[])', [a.brand.id, Array.from({ length: 50 - 3 }, nonce)]);
      const receipts = async () => (await admin.query("SELECT count(*)::int n FROM app.command_receipts WHERE workspace_id=$1 AND command_name='crm.createLead'", [a.brand.id])).rows[0].n;
      const before = await receipts();
      const page = await http(capture, 'GET', formPath + query);
      const form = { token: field(page.body, 'token'), utm_source: 'instagram', utm_medium: 'social', utm_campaign: utmCampaign, utm_content: utmContent, name: 'Fifty First', email: 'fifty@example.test', phone: '', message: 'One too many.', consent: 'yes', website: '' };
      assert.equal((await http(capture, 'POST', formPath, form)).status, 429);
      assert.equal(await receipts(), before, 'a refused admission creates nothing');
      await admin.query("UPDATE app.creative_studio_enquiry_admissions SET admitted_at=clock_timestamp()-interval '2 hours' WHERE workspace_id=$1", [a.brand.id]);
      assert.equal((await http(capture, 'POST', formPath, form)).status, 200, 'older admissions do not count');
      assert.equal((await http(capture, 'POST', formPath, { ...form, token: enquiryToken(SECRET, a.brand.id, key, { utm_source: 'instagram', utm_medium: 'social', utm_campaign: utmCampaign, utm_content: utmContent }, Date.now() - 3_601_000) })).status, 400, 'expired token');
      const embed = await http(capture, 'GET', `${formPath}?embed=1`);
      assert.equal(embed.status, 200); assert.match(embed.headers['content-security-policy']!, /frame-ancestors https:\/\/hearth\.example https:\/\/www\.hearth\.example/u);
      assert.match((await http(capture, 'GET', formPath)).headers['content-security-policy']!, /frame-ancestors 'none'/u);
      const s = await a.studio.enquiries(a.actor, a.brand.id);
      const rotated = await a.studio.rotateEnquiryKey(a.actor, a.brand.id, s.rowVersion);
      assert.notEqual(rotated.publicKey, key);
      assert.equal((await http(capture, 'GET', formPath + query)).status, 404, 'the old address is gone');
      formPath = `/enquire/${a.brand.id}/${rotated.publicKey}`;
      assert.equal((await http(capture, 'GET', formPath + query)).status, 200);
    });

    await t.test('tampered tags, honeypots and switched-off forms are refused', async () => {
      const page = await http(capture, 'GET', formPath + query);
      const base = { token: field(page.body, 'token'), utm_source: 'instagram', utm_medium: 'social', utm_campaign: utmCampaign, utm_content: utmContent, name: 'X', email: 'x@example.test', phone: '', message: 'Hi there.', consent: 'yes', website: '' };
      assert.equal((await http(capture, 'POST', formPath, { ...base, utm_content: creativeUtmContent(1, art.id) })).status, 400, 'tags changed after the form was issued');
      const before = (await admin.query("SELECT count(*)::int n FROM app.command_receipts WHERE command_name='crm.createLead'")).rows[0].n;
      assert.equal((await http(capture, 'POST', formPath, { ...base, website: 'spam' })).status, 200);
      assert.equal((await admin.query("SELECT count(*)::int n FROM app.command_receipts WHERE command_name='crm.createLead'")).rows[0].n, before, 'honeypot: nothing created');
      assert.equal((await http(capture, 'POST', formPath, { ...base, consent: '' })).status, 400);
      const s = await a.studio.enquiries(a.actor, a.brand.id);
      await a.studio.saveEnquiries(a.actor, a.brand.id, { enabled: false, privacyUrl: s.privacyUrl!, newStageId: s.newStageId!, qualifiedStageId: s.qualifiedStageId!, expectedVersion: s.rowVersion });
      assert.equal((await http(capture, 'GET', formPath + query)).status, 404, 'switched off');
      // Direct calls cannot forge a touch: the runtime role has no table access and the function needs the capture owner.
      await assert.rejects(pool.query('SELECT * FROM app.creative_studio_lead_touches'), /permission denied/u);
    });
  } finally {
    await pool.end(); await crmPool.end(); await admin.end();
  }
});
