/**
 * Real disposable PostgreSQL proof for Milestone 4 (0143 distribution section), run as the actual
 * least-privilege r72_content_command role with genuine owner sessions:
 * - SQL independently verifies hand-off routes against the existing article media rows and tracked-link tags;
 * - delivery states are read only from this brand's existing posting-plan receipts and calendar jobs;
 * - outcomes are counted only from this brand's existing CRM, journey and commerce rows by exact UTM tag.
 * External rows that the existing pipelines would write (calendar jobs, receipts, imported attribution, journey facts)
 * are seeded by the disposable superuser with replication-role FK bypass; that is test seeding, never runtime behaviour.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import jpeg from 'jpeg-js';
import pg from 'pg';
import { PgSeoBlogStore } from '../../src/seo-blog/pg-store.js';
import { PgCreativeDistributionReader, PgCreativeLibraryStore } from '../../src/creative-studio/pg-store.js';
import { CreativeStudioService, setView } from '../../src/creative-studio/service.js';
import { creativeUtmContent } from '../../src/creative-studio/distribution.js';
import type { ArtworkInput, ArtworkRenderer, RenderedArtwork } from '../../src/creative-studio/renderer.js';
import type { CreativeHandoff } from '../../src/creative-studio/types.js';
import { fixtureBrand } from '../rl72-method-fixtures.js';

const raw = process.env.RL72_METHODS_PG_TEST_URL;
const skip = !raw || process.env.RELAUNCH72_DATABASE_INTEGRATION !== 'explicit-disposable-run' ? 'Explicit disposable creative-studio PostgreSQL run only.' : false;
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

class StubRenderer implements ArtworkRenderer {
  readonly version = 'test-stub-renderer';
  available() { return true; }
  async renderBatch(inputs: readonly ArtworkInput[]): Promise<RenderedArtwork[]> {
    return inputs.map((input) => {
      const seed = createHash('sha256').update(`${input.placement.id}|${input.headline}`).digest(), data = Buffer.alloc(16 * 16 * 4);
      for (let i = 0; i < 256; i++) data.set([seed[i % 32]!, seed[(i + 5) % 32]!, seed[(i + 9) % 32]!, 255], i * 4);
      const bytes = Buffer.from(jpeg.encode({ data, width: 16, height: 16 }, 90).data);
      const out = { mime: 'image/jpeg' as const, sha256: sha(bytes), width: input.placement.width, height: input.placement.height, contrast: { headline: 9 }, scrimAlpha: 0.4, headlineSize: 80, issues: [] };
      Object.defineProperty(out, 'bytes', { enumerable: false, get: () => Buffer.from(bytes) });
      return out as unknown as RenderedArtwork;
    });
  }
}

test('Milestone 4 on real PostgreSQL: verified hand-off routes, receipt-derived delivery states and tag-exact CRM outcomes', { skip }, async (t) => {
  const target = new URL(raw!); assert(['localhost', '127.0.0.1'].includes(target.hostname)); assert.equal(target.pathname, '/relaunch72_test');
  const admin = new pg.Pool({ connectionString: raw, max: 2 });
  const u = new URL(raw!); u.username = 'r72_content_command'; u.password = 'local-methods-test-only';
  const pool = new pg.Pool({ connectionString: u.toString(), max: 4 });
  /** Disposable seeding only: bypass FKs to unrelated upstream receipts while keeping every CHECK constraint. */
  const seed = async (sql: string, values: unknown[]) => { const c = await admin.connect(); try { await c.query('BEGIN'); await c.query('SET LOCAL session_replication_role=replica'); await c.query(sql, values); await c.query('COMMIT'); } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); } };
  async function fixture(kind: 'home' | 'b2b') {
    const f = fixtureBrand(kind), actor = f.profile.confirmedBy!, token = randomUUID() + randomUUID();
    await admin.query("INSERT INTO app.organizations(id,name,slug,kind) VALUES($1,$2,$3,'direct_customer')", [f.brand.organizationId, f.brand.name, 'org-' + f.brand.organizationId]);
    await admin.query("INSERT INTO app.users(id,email,status) VALUES($1,$2,'active')", [actor, actor + '@example.test']);
    await admin.query("INSERT INTO app.organization_memberships(organization_id,user_id,role,status) VALUES($1,$2,'owner','active')", [f.brand.organizationId, actor]);
    await admin.query('INSERT INTO app.workspaces(id,organization_id,name,slug) VALUES($1,$2,$3,$4)', [f.brand.id, f.brand.organizationId, f.brand.name, 'creative-' + f.brand.id]);
    await admin.query("INSERT INTO app.workspace_memberships(workspace_id,organization_id,user_id,role,status,source_organization_id) VALUES($1,$2,$3,'owner','active',$2)", [f.brand.id, f.brand.organizationId, actor]);
    await admin.query("INSERT INTO app.user_sessions(token_hash,csrf_secret_hash,user_id,selected_workspace_id,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')", [createHash('sha256').update(token).digest(), createHash('sha256').update('csrf' + token).digest(), actor, f.brand.id]);
    await admin.query('INSERT INTO app.seo_blog_brands(workspace_id,organization_id,created_by_user_id,settings) VALUES($1,$2,$3,$4)', [f.brand.id, f.brand.organizationId, actor, JSON.stringify(f.brand.settings)]);
    const principal = { kind: 'user' as const, userId: actor, requestId: 'creative-m4-pg-test', sessionToken: token, selectedWorkspaceId: f.brand.id };
    const blogs = new PgSeoBlogStore(pool, principal), library = new PgCreativeLibraryStore(pool, principal), reader = new PgCreativeDistributionReader(pool, principal);
    await blogs.saveProfile(f.profile);
    const studio = new CreativeStudioService({ library, brands: blogs, renderer: new StubRenderer(), distribution: reader });
    return { ...f, actor, blogs, library, reader, studio, principal };
  }
  try {
    const a = await fixture('home'), b = await fixture('b2b');
    const draft = await a.studio.draft(a.actor, a.brand.id, randomUUID(), { purpose: 'advert', source_kind: 'offer', offer: a.profile.offers[0]!.name, audience: '', destination: a.profile.conversionPages[0]!.url, placements: ['portrait'], concepts: '1' }, { kind: 'neutral' });
    const ctx = (await a.studio.context(a.actor, a.brand.id)).context;
    const portrait = setView((await a.library.getSet(a.brand.id, draft.setId))!, ctx).concepts[0]!.variants[0]!.version;
    await a.studio.approve(a.actor, a.brand.id, portrait.id, randomUUID(), portrait.render.sha256, true);
    const approvalId = (await a.library.getVersion(a.brand.id, portrait.id))!.approval!.id;
    const articleId = randomUUID(), campaignId = randomUUID();
    const handoff = (over: Partial<CreativeHandoff> & Pick<CreativeHandoff, 'target'>): CreativeHandoff => ({ id: randomUUID(), versionId: portrait.id, approvalId, state: 'ready_for_review', createdBy: a.actor, createdAt: new Date().toISOString(), ...over });
    const record = (h: CreativeHandoff) => a.library.handoff(a.brand.id, randomUUID(), sha(h.id), h, portrait.context);

    await t.test('article_media is accepted only when SQL finds this exact approved artwork in the article images', async () => {
      await seed("INSERT INTO app.seo_blog_articles(workspace_id,id,brief_id,slug,data) VALUES($1,$2,$3,'synthetic-article','{}'::jsonb)", [a.brand.id, articleId, randomUUID()]);
      const media = { candidateAssetId: randomUUID(), candidateSha256: portrait.render.sha256, variantAssetId: randomUUID(), variantSha256: 'a'.repeat(64), profile: 'instagram' as const };
      const forged = handoff({ target: { kind: 'article_campaign', articleId }, route: 'article_media', articleMedia: media });
      await assert.rejects(record(forged), /does not match this approved artwork/u, 'no article image row exists yet');
      const bytes = Buffer.from('synthetic-variant'), blob = randomUUID(), cblob = randomUUID();
      await seed("INSERT INTO app.seo_blog_blobs(workspace_id,id,mime,bytes,sha256) VALUES($1,$2,'image/jpeg',$3,decode($4,'hex')),($1,$5,'image/jpeg',$6,decode($7,'hex'))",
        [a.brand.id, blob, bytes, sha(bytes), cblob, Buffer.from('c'), portrait.render.sha256]);
      const insertCandidate = (id: string, name: string) => seed(`INSERT INTO app.seo_blog_media_assets(id,workspace_id,blob_id,asset_kind,byte_sha256,byte_length,mime_type,provenance)
        VALUES($1,$2,$3,'candidate',decode($4,'hex'),1,'image/jpeg',$5)`, [id, a.brand.id, cblob, portrait.render.sha256, JSON.stringify({ kind: 'uploaded', brandSha256: 'f'.repeat(64), sourceName: name })]);
      const insertVariant = (id: string, source: string) => seed(`INSERT INTO app.seo_blog_media_assets(id,workspace_id,blob_id,asset_kind,byte_sha256,byte_length,mime_type,width,height,source_asset_id,recipe,provenance)
        VALUES($1,$2,$3,'variant',decode($4,'hex'),$5,'image/jpeg',1080,1350,$6,$7,'{}'::jsonb)`, [id, a.brand.id, blob, sha(bytes), bytes.length, source, JSON.stringify({ profile: 'instagram' })]);
      // A candidate that is someone's ordinary upload (not this creative version) never satisfies the route.
      const other = randomUUID(), otherVariant = randomUUID();
      await insertCandidate(other, 'owner-photo.jpg'); await insertVariant(otherVariant, other);
      await assert.rejects(record(handoff({ target: { kind: 'article_campaign', articleId }, route: 'article_media', articleMedia: { ...media, candidateAssetId: other, variantAssetId: otherVariant, variantSha256: sha(bytes) } })), /does not match/u);
      await insertCandidate(media.candidateAssetId, `creative-studio-${portrait.id}.jpg`); await insertVariant(media.variantAssetId, media.candidateAssetId);
      const ok = await record(handoff({ target: { kind: 'article_campaign', articleId }, route: 'article_media', articleMedia: { ...media, variantSha256: sha(bytes) } }));
      assert.equal(ok.replayed, false);
      await assert.rejects(record(handoff({ target: { kind: 'article_campaign', articleId }, route: 'carrier_pigeon' as never })), /check the artwork/iu);
    });

    await t.test('tracked_link must carry this campaign and this exact artwork in the link itself', async () => {
      await seed(`INSERT INTO app.seo_blog_creator_campaigns(workspace_id,id,kind,input_hash,brief,profile_version,facts_sha,assignment_revision,method_receipt_id,reserved_tokens,state,created_by)
        VALUES($1,$2,'acquisition',$3,'{}'::jsonb,1,$4,1,$5,0,'draft',$6)`, [a.brand.id, campaignId, 'a'.repeat(64), 'f'.repeat(64), randomUUID(), a.actor]);
      const utmCampaign = `spring-plan-${campaignId.replace(/-/gu, '').slice(0, 8)}`, utmContent = creativeUtmContent(0, portrait.id);
      const url = `https://hearth.example/request?utm_source=instagram&utm_medium=social&utm_campaign=${utmCampaign}&utm_content=${utmContent}`;
      const tgt = { kind: 'creator_campaign' as const, campaignId, concept: 0, channel: 'instagram' };
      await assert.rejects(record(handoff({ target: tgt, route: 'tracked_link', trackedLink: { url, utmCampaign, utmContent: creativeUtmContent(0, randomUUID()), channel: 'instagram', concept: 0 } })), /check the artwork/iu, 'another artwork id');
      await assert.rejects(record(handoff({ target: tgt, route: 'tracked_link', trackedLink: { url: 'https://hearth.example/request', utmCampaign, utmContent, channel: 'instagram', concept: 0 } })), /check the artwork/iu, 'tags not in the link');
      await assert.rejects(record(handoff({ target: tgt, route: 'tracked_link', trackedLink: { url, utmCampaign: 'spring-plan-00000000', utmContent, channel: 'instagram', concept: 0 } })), /check the artwork/iu, 'another campaign');
      await assert.rejects(record(handoff({ target: tgt, route: 'tracked_link', trackedLink: { url: url.replace('hearth.example', 'elsewhere.example'), utmCampaign, utmContent, channel: 'instagram', concept: 0 } })), /check the artwork/iu, 'a host that is not a confirmed conversion page');
      await assert.rejects(record(handoff({ target: { ...tgt, concept: 1 }, route: 'tracked_link', trackedLink: { url, utmCampaign, utmContent, channel: 'instagram', concept: 1 } })), /check the artwork/iu, 'concept index does not match the tag');
      assert.equal((await record(handoff({ target: tgt, route: 'tracked_link', trackedLink: { url, utmCampaign, utmContent, channel: 'instagram', concept: 0 } }))).replayed, false);
    });

    await t.test('delivery states come only from this brand\'s posting-plan receipts and calendar job records', async () => {
      const q1 = randomUUID(), q2 = randomUUID(), qb = randomUUID(), job = randomUUID();
      const cmd = (ws: string, id: string, action: string, actorKind: string, actorId: string | null, result: unknown) => seed(
        'INSERT INTO app.seo_blog_media_commands(workspace_id,id,action,actor_kind,actor_user_id,payload_sha256,result) VALUES($1,$2,$3,$4,$5,$6,$7)', [ws, id, action, actorKind, actorId, createHash('sha256').update(id).digest(), JSON.stringify(result)]);
      await cmd(a.brand.id, q1, 'authorize_campaign_queue', 'user', a.actor, { queueIntentId: q1 });
      await cmd(a.brand.id, q2, 'authorize_campaign_queue', 'user', a.actor, { queueIntentId: q2 });
      await cmd(b.brand.id, qb, 'authorize_campaign_queue', 'user', b.actor, { queueIntentId: qb });
      const receiptId = (await admin.query('SELECT app_private.seo_media_campaign_queue_receipt_id($1) AS id', [q1])).rows[0].id as string;
      await cmd(a.brand.id, receiptId, 'materialize_campaign_queue', 'worker', null, { kind: 'materialized', queueIntentId: q1, jobId: job, scheduledFor: '2026-11-10T09:00:00.000Z' });
      const h32 = () => createHash('sha256').update(randomUUID()).digest();
      await seed(`INSERT INTO app.property_predator_owned_social_jobs(id,workspace_id,provider_connection_id,environment,network,content_item_id,content_version_id,content_sha256,approval_request_id,approval_decision_id,
          source_attestation_id,operation_tag,idempotency_key_sha256,request_sha256,text_body,utc_day,utc_month,created_by_user_id,provider_id,zernio_publish_binding_id,zernio_account_id,state,provider_external_id,scheduled_for)
        VALUES($1,$2,$3,'live','instagram',$4,$5,$6,$7,$8,$9,'seo-campaign:test',$10,$11,'Synthetic post text',current_date,date_trunc('month',now())::date,$12,'zernio',$13,$14,'succeeded','post_123','2026-11-10T09:00:00Z')`,
        [job, a.brand.id, randomUUID(), randomUUID(), randomUUID(), h32(), randomUUID(), randomUUID(), randomUUID(), h32(), h32(), a.actor, randomUUID(), randomUUID()]);
      for (const [n, kind, at] of [[1, 'accepted', '2026-11-10T09:00:02Z'], [2, 'published', '2026-11-10T09:01:00Z']] as const)
        await seed(`INSERT INTO app.property_predator_owned_social_receipts(workspace_id,job_id,lease_version,attempt_kind,event_kind,receipt_sha256,safe_code,provider_occurred_at,provider_id,provider_external_id)
          VALUES($1,$2,$3,'publish',$4,$5,$6,$7,'zernio','post_123')`, [a.brand.id, job, n, kind, h32(), `zernio.${kind}`, at]);
      const rows = await a.reader.delivery(a.brand.id, [q1, q2, qb]);
      assert.deepEqual(rows.map((r) => r.queueIntentId).sort(), [q1, q2].sort(), 'another brand\'s plan is invisible');
      const r1 = rows.find((r) => r.queueIntentId === q1)!, r2 = rows.find((r) => r.queueIntentId === q2)!;
      assert.deepEqual({ m: r1.materialized, s: r1.jobState, p: r1.providerPostRecorded, e: r1.events.map((e) => [e.kind, e.at]) },
        { m: true, s: 'succeeded', p: true, e: [['accepted', '2026-11-10T09:00:02.000Z'], ['published', '2026-11-10T09:01:00.000Z']] });
      assert.deepEqual({ m: r2.materialized, s: r2.jobState, e: r2.events }, { m: false, s: null, e: [] }, 'a saved plan with no receipt is not reported as queued');
      // B's genuine session aimed at A's workspace is refused by the SQL boundary.
      const crossed = new PgCreativeDistributionReader(pool, { ...b.principal, selectedWorkspaceId: a.brand.id });
      await assert.rejects(crossed.delivery(a.brand.id, [q1]), /permission|Sign in/u);
      await assert.rejects(pool.query('SELECT * FROM app.property_predator_owned_social_jobs'), /permission denied/u);
      await assert.rejects(a.reader.delivery(a.brand.id, ['not-a-uuid']), /Check the distribution request/u, 'malformed queue ids are refused with a plain error');
      // A plan replaced by a newer one is reported as superseded even though no cancel command exists.
      const q3 = randomUUID(), q4 = randomUUID();
      await cmd(a.brand.id, q3, 'authorize_campaign_queue', 'user', a.actor, { queueIntentId: q3 });
      await cmd(a.brand.id, q4, 'authorize_campaign_queue', 'user', a.actor, { queueIntentId: q4, supersedesQueueIntentId: q3 });
      const replaced = await a.reader.delivery(a.brand.id, [q3, q4]);
      assert.deepEqual(replaced.map((r) => [r.queueIntentId, r.superseded, r.cancelled]).sort(), [[q3, true, false], [q4, false, false]].sort());
    });

    await t.test('outcomes count each tagged contact once from existing CRM, journey and commerce rows, per brand', async () => {
      const utmCampaign = `spring-plan-${campaignId.replace(/-/gu, '').slice(0, 8)}`, tag = creativeUtmContent(0, portrait.id);
      const contact = async (ws: string, opts: { status?: string; deleted?: boolean } = {}) => {
        const id = randomUUID();
        await seed(`INSERT INTO app.contacts(id,workspace_id,display_name,lifecycle_status,deleted_at) VALUES($1,$2,'Synthetic contact',$3,$4)`, [id, ws, opts.deleted ? 'archived' : opts.status ?? 'lead', opts.deleted ? new Date(Date.now() + 60_000).toISOString() : null]);
        return id;
      };
      const touch = (ws: string, c: string, campaign: string, content: string | null, at: string) => seed(`INSERT INTO app.contact_import_attribution_facts(workspace_id,contact_id,provenance_id,source_system,source_record_id,utm_campaign,utm_content,attributed_at)
        VALUES($1,$2,$3,'legacy.synthetic',$4,$5,$6,$7)`, [ws, c, randomUUID(), randomUUID(), campaign, content, at]);
      const [c1, c2, c3, c4, c5, c6] = [await contact(a.brand.id), await contact(a.brand.id), await contact(a.brand.id, { status: 'customer' }), await contact(a.brand.id), await contact(b.brand.id), await contact(a.brand.id, { deleted: true })];
      await touch(a.brand.id, c1, utmCampaign, tag, '2026-11-03T09:00:00Z');
      await touch(a.brand.id, c2, utmCampaign, 'concept-1', '2026-11-02T09:00:00Z');
      await touch(a.brand.id, c2, utmCampaign, tag, '2026-11-04T09:00:00Z'); // latest touch wins; counted once
      await touch(a.brand.id, c3, utmCampaign, tag, '2026-11-05T09:00:00Z');
      await touch(a.brand.id, c4, 'another-campaign-00000000', tag, '2026-11-05T09:00:00Z');
      await touch(b.brand.id, c5, utmCampaign, tag, '2026-11-05T09:00:00Z');
      await touch(a.brand.id, c6, utmCampaign, tag, '2026-11-05T09:00:00Z');
      const pipeline = randomUUID(), qualified = randomUUID(), open = randomUUID();
      await seed("INSERT INTO app.pipelines(id,workspace_id,name,slug) VALUES($1,$2,'Sales','sales-m4')", [pipeline, a.brand.id]);
      await seed("INSERT INTO app.pipeline_stages(id,workspace_id,pipeline_id,name,slug,position,stage_type) VALUES($1,$3,$4,'New','new-lead',1,'open'),($2,$3,$4,'Qualified','qualified',2,'open')", [open, qualified, a.brand.id, pipeline]);
      await seed("INSERT INTO app.opportunities(id,workspace_id,contact_id,pipeline_id,stage_id,name) VALUES($1,$2,$3,$4,$5,'Synthetic opportunity')", [randomUUID(), a.brand.id, c2, pipeline, qualified]);
      await seed(`INSERT INTO app.conversion_milestone_facts(workspace_id,enrollment_id,contact_id,journey_version_id,milestone_id,milestone_semantic,source_kind,source_system,source_event_id,actor_kind,occurred_at)
        VALUES($1,$2,$3,$4,$5,'appointment','event','propertypredator','sales.appointment.booked:synthetic','webhook',now())`, [a.brand.id, randomUUID(), c2, randomUUID(), randomUUID()]);
      await seed(`INSERT INTO app.conversion_commerce_facts(workspace_id,enrollment_id,contact_id,source_system,source_event_id,source_payload_sha256,fact_type,external_order_id,product_key,amount_minor,currency,actor_kind,occurred_at)
        VALUES($1,$2,$3,'stripe','evt_synthetic',$4,'payment_collected','ord_synthetic','synthetic',4900,'GBP','webhook',now())`, [a.brand.id, randomUUID(), c3, createHash('sha256').update('p').digest()]);
      const read = await a.reader.outcomes(a.brand.id, utmCampaign);
      assert.equal(read.utmCampaign, utmCampaign);
      assert.deepEqual(read.buckets.map((x) => ({ c: x.utmContent, leads: x.leads, q: x.qualified, b: x.booked, s: x.sold, cu: x.customers })),
        [{ c: tag, leads: 3, q: 1, b: 1, s: 1, cu: 1 }], 'c4 (other campaign), c5 (other brand) and c6 (deleted) are excluded; c2 counted once');
      assert.equal(read.buckets[0]!.firstAt, '2026-11-03T09:00:00.000Z');
      assert.deepEqual((await b.reader.outcomes(b.brand.id, utmCampaign)).buckets.map((x) => x.leads), [1], 'brand B sees only its own contact');
      await assert.rejects(a.reader.outcomes(a.brand.id, "x' OR 1=1 --"), /Check the distribution request/u);
      // The outcome counter is internal: the runtime role cannot call it directly, only through the owner-checked boundary.
      await assert.rejects(pool.query('SELECT app_private.creative_studio_outcome_buckets($1,$2)', [a.brand.id, utmCampaign]), /permission denied/u);
      await assert.rejects(pool.query('SELECT * FROM app.contact_import_attribution_facts'), /permission denied/u);
      const writes = await admin.query('SELECT (SELECT count(*) FROM app.seo_blog_jobs WHERE workspace_id=$1)::int AS jobs, (SELECT count(*) FROM app.outbox_events WHERE workspace_id=$1)::int AS outbox', [a.brand.id]);
      assert.deepEqual(writes.rows[0], { jobs: 0, outbox: 0 }, 'reading outcomes queued or sent nothing');
    });
  } finally {
    await pool.end(); await admin.end();
  }
});
