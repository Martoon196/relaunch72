/** Actual-role adapter journey on disposable PG only. All image/provider/website bytes are synthetic. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import jpeg from 'jpeg-js';
import { openTestDatabase, testDatabaseSkipReason } from './database-helper.js';
import { loginMediaProofRole, seedMediaStorageFixture, MEDIA_STORAGE_TEST_ORIGIN } from './seo-blog-media-fixtures.js';
import { PgSeoBlogMediaStore, PgSeoBlogReleasedMediaReader } from '../../src/seo-blog/media-store.js';
import { PgSeoBlogStore } from '../../src/seo-blog/pg-store.js';
import { createPgArticleImageService } from '../../src/seo-blog/image-service-pg.js';
import { prepareImageGenerationRequest, type ImageGenerationCommand, type ImageGenerationReceipt } from '../../src/seo-blog/image-generation.js';
import { ArticleMediaReviewService } from '../../src/seo-blog/media-review.js';
import { createCentralImageQualityApproval } from '../../src/portal/seo-blog-image-review-pg.js';
import { SeoBlogEngine, sha256, profileFactsSha } from '../../src/seo-blog/engine.js';
import { createArticleCampaign, fallbackCampaignDrafts } from '../../src/seo-blog/campaign.js';
import { withTransaction } from '../../src/db/transaction.js';
import { FakeWeb } from '../seo-blog-fixtures.js';
import type { Article, ArticleBody, ArticleBrief, ArticleVersion, BrandProfile, Destination, Publication } from '../../src/seo-blog/types.js';
import { campaignCopyIssue, type CampaignGeneration, type CampaignCopyReceipt } from '../../src/seo-blog/campaign-generation.js';
import { programmeSha, programmeKnowledgeRefs } from '../../src/seo-blog/programme.js';
import { createPgSeoBlogSocialRegistry } from '../../src/portal/seo-blog-social-pg.js';

const skip = testDatabaseSkipReason();
const now = () => new Date().toISOString();
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
function syntheticJpeg(): Buffer {
  const width = 1536, height = 1024, data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < data.length; i += 4) { data[i] = 48; data[i + 1] = 83; data[i + 2] = 150; data[i + 3] = 255; }
  return Buffer.from(jpeg.encode({ width, height, data }, 80).data);
}

test('010 actual engine adapters: committed image admission/receipt/crops, genuine quality/use and same-client publication release', { skip, timeout: 300_000 }, async () => {
  const admin = await openTestDatabase();
  const content = await loginMediaProofRole(admin, 'r72_content_command'), adapter = await loginMediaProofRole(admin, 'r72_content_adapter'), web = await loginMediaProofRole(admin, 'r72_web'), zernio = await loginMediaProofRole(admin,'r72_zernio_social_command');
  try {
    const seeded = await seedMediaStorageFixture(admin, content);
    const seededVersion = (await admin.query('SELECT number,content_sha256,data FROM app.seo_blog_article_versions WHERE workspace_id=$1 AND id=$2',[seeded.brand,seeded.version])).rows[0];
    assert.equal(seededVersion.number,1);
    await assert.rejects(admin.query('UPDATE app.seo_blog_article_versions SET data=data WHERE workspace_id=$1 AND id=$2',[seeded.brand,seeded.version]),{code:'42501'},'The original storage fixture version stays append-only');
    const f = { ...seeded, version: randomUUID() }, at = now(), briefId = randomUUID(), planId = randomUUID();
    const profileBase: BrandProfile = { brandId: f.brand, version: 1, knowledge: [], summary: 'Synthetic Harbour creates considered editorial guides.', audiences: ['Readers considering their next decision'],
      positioning: 'Plain, grounded editorial explanation.', offers: [], conversionPages: [], voice: { tone: ['clear'], do: ['Use supplied facts'], dont: ['Invent claims'], examples: [] },
      approvedClaims: [], exclusions: [], conflicts: [], missingFacts: [], factsSha: '', source: 'owner_edited', confirmedAt: at, confirmedBy: f.user, createdAt: at, generation: null };
    const profile = { ...profileBase, factsSha: profileFactsSha(profileBase) };
    const body: ArticleBody = { title: 'A considered editorial decision', seoTitle: 'A considered editorial decision', slug: `article-${f.article}`, excerpt: 'A synthetic guide to considering context.',
      metaDescription: 'A synthetic source fixture, never a public article.', intro: 'Consider the evidence and context before taking the next step.', sections: [{ id: randomUUID(), heading: 'Consider context', body: 'Review the supplied facts carefully. This fixture makes no real product or legal claims.' }],
      conclusion: 'Keep the wider context in mind.', cta: null, faqs: [], citations: [], author: null, image: { kind: 'none', url: null, alt: 'An abstract considered editorial decision', provenance: 'No selected image.', width: null, height: null } };
    const version: ArticleVersion = { id: f.version, articleId: f.article, brandId: f.brand, number: 2, parentVersionId: seeded.version, change: 'generated', changedSectionId: null,
      createdAt: at, createdBy: f.user, body, contentSha: sha256(body), profileVersion: 1, factsSha: profile.factsSha, knowledge: [], briefId, planId, generation: null,
      promotionPack: { source: 'relaunch72.seo-blog', brandId: f.brand, articleId: f.article, versionId: f.version, contentSha: sha256(body), profileVersion: 1, factsSha: profile.factsSha,
        canonicalUrl: `${MEDIA_STORAGE_TEST_ORIGIN}/blog/${body.slug}`, mode: 'excerpt_fallback', generation: null, posts: fallbackCampaignDrafts(body).filter(d => d.angle === 'launch') } };
    const brief: ArticleBrief = { id: briefId, brandId: f.brand, planId, role: 'pillar', slug: body.slug, workingTitle: body.title, targetQuery: 'considered editorial decision', searchIntent: 'learn', relatedQuestions: [], angle: 'Synthetic source context', outline: ['Consider context'], keyPoints: [], cta: null, internalLinks: [], whyFit: 'Synthetic proof', demand: { kind: 'qualitative', rationale: 'No paid research.' }, sourceIds: [], duplicate: { verdict: 'distinct', score: 0, against: null, againstKind: null, advice: 'Synthetic proof only.' }, status: 'generated', suggestedAtUtc: null, articleId: f.article };
    const article: Article = { id: f.article, brandId: f.brand, briefId, planId, slug: body.slug, editorialState: 'draft', currentVersionId: f.version, requiresApproval: true,
      approval: null, checks: null, schedule: null, hold: null, delivery: 'none', publishedVersionId: null, publishedUrl: null, publishedAt: null, lastAttemptAt: null, failure: null, createdAt: at, rowVersion: 1,
      campaign: createArticleCampaign({ articleVersionId: f.version, articleContentSha: version.contentSha, canonicalUrl: version.promotionPack!.canonicalUrl, drafts: fallbackCampaignDrafts(body), createdAt: at, createdBy: 'system', generation: null }) };
    await admin.query("UPDATE app.seo_blog_records SET data=$2 WHERE workspace_id=$1 AND kind='profile'", [f.brand, JSON.stringify(profile)]);
    await admin.query('INSERT INTO app.seo_blog_article_versions(workspace_id,id,article_id,number,content_sha256,data) VALUES($1,$2,$3,$4,$5,$6)', [f.brand, f.version, f.article, version.number, version.contentSha, JSON.stringify(version)]);
    assert.deepEqual((await admin.query('SELECT number,content_sha256,data FROM app.seo_blog_article_versions WHERE workspace_id=$1 AND id=$2',[seeded.brand,seeded.version])).rows[0],seededVersion,'Appending the truthful source must preserve the original immutable row');
    await admin.query('UPDATE app.seo_blog_articles SET brief_id=$3,data=$4 WHERE workspace_id=$1 AND id=$2', [f.brand, f.article, briefId, JSON.stringify(article)]);
    await admin.query("INSERT INTO app.seo_blog_records(workspace_id,kind,id,data) VALUES($1,'brief',$2,$3)", [f.brand, briefId, JSON.stringify(brief)]);
    // Synthetic conservative proof units, not actual supplier prices or production settings.
    await admin.query("UPDATE app_private.seo_image_operator_policy SET version=version+1,config=config||$1::jsonb", [JSON.stringify({ enabled: true, maxConcurrency: 2, monthlyMicrousd: 10000, perAttemptMicrousd: 1000 })]);
    const ownerPrincipal = { kind: 'user' as const, userId: f.user, selectedWorkspaceId: f.home, sessionToken: f.token, requestId: randomUUID() };
    const workerPrincipal = { kind: 'worker' as const, requestId: randomUUID() };
    const ownerMedia = new PgSeoBlogMediaStore(content, ownerPrincipal, { publicOrigin: MEDIA_STORAGE_TEST_ORIGIN });
    const workerMedia = new PgSeoBlogMediaStore(content, workerPrincipal, { publicOrigin: MEDIA_STORAGE_TEST_ORIGIN });
    const ownerStore = new PgSeoBlogStore(content, ownerPrincipal, ownerMedia), workerStore = new PgSeoBlogStore(content, workerPrincipal, workerMedia);
    // Same real content-command/worker transaction boundary: receipt races debit once,
    // source/lease changes retain known usage but cannot install an obsolete version.
    for(const late of [false,true]) {
      const id=randomUUID(),copyBrief=randomUUID(),planned=randomUUID(),jobId=randomUUID(),nonce=randomUUID();
      const copyBody={...body,slug:`copy-${id}`};
      const copy=await workerStore.createArticle({...article,id,briefId:copyBrief,slug:copyBody.slug,currentVersionId:null,campaign:undefined});
      await workerStore.enqueueJob({id:jobId,brandId:f.brand,kind:'write',idempotencyKey:`copy-proof:${id}`,payload:{briefId:copyBrief,requestedBy:f.user},state:'queued',attempts:0,maxAttempts:3,leaseOwner:null,leaseExpiresAt:null,runAfter:at,createdAt:at,updatedAt:at,progress:'Synthetic copy boundary',error:null,rowVersion:1});
      const claim=(await workerStore.claimJobs({brandId:f.brand,kinds:['write'],now:now(),owner:`copy-proof-${id}`,leaseMs:600000,limit:1}))[0]!;
      assert.equal(claim.id,jobId);
      const authority={origin:'manual' as const,sponsorUserId:f.user},lease={jobId,leaseOwner:claim.leaseOwner,attempts:claim.attempts};
      const base={brandId:f.brand,articleId:id,authority,claim:lease,now:now()};
      await workerStore.campaignCopyBoundary({...base,decide:s=>{
        assert.equal(s.requesterAllowed,true);assert.equal(s.job!.payload.requestedBy,f.user);
        const marker:CampaignGeneration={nonce,estimatedTokens:6000,plannedVersionId:planned,plannedVersionNumber:1,body:copyBody,articleGeneration:null,profileSha:programmeSha(s.profile),knowledgeSha:programmeSha(programmeKnowledgeRefs(s.knowledge)),authority,claim:lease,capturedAt:at,startedAt:at,receipt:null,appliedAt:null};
        assert.equal(campaignCopyIssue(s,marker,now()),null);return {article:{...s.article,campaignGeneration:marker}};
      }});
      if(late)await workerStore.updateJob({...claim,state:'cancelled',leaseOwner:null,leaseExpiresAt:null});
      const before=await workerStore.usageSince(f.brand,'model_tokens',at.slice(0,7)+'-01T00:00:00.000Z');
      const receipt:CampaignCopyReceipt={nonce,at:now(),record:{mode:'simulated',model:'synthetic-only',promptVersion:'synthetic-copy-proof',tokensIn:101,tokensOut:23},result:{kind:'rejected'}};
      const save=()=>workerStore.campaignCopyBoundary({...base,now:now(),decide:s=>{
        const m=s.article.campaignGeneration!;if(m.receipt){assert.equal(s.modelTokensReserved,0);return {article:s.article};}
        assert.equal(s.modelTokensReserved,6000,'unknown start holds its estimate until the receipt commits');
        return {article:{...s.article,campaignGeneration:{...m,receipt}},usage:{brandId:f.brand,kind:'model_tokens',amount:124,at:receipt.at,reference:`promotion:${id}:${planned}`}};
      }});
      await Promise.all([save(),save()]);assert.equal(await workerStore.usageSince(f.brand,'model_tokens',at.slice(0,7)+'-01T00:00:00.000Z'),before+124);
      if(late){
        await assert.rejects(workerStore.campaignCopyBoundary({...base,now:now(),decide:s=>{const issue=campaignCopyIssue(s,s.article.campaignGeneration!,now());assert.ok(issue);throw Error(issue!);}}),/lease/);
        assert.equal((await workerStore.getArticle(f.brand,id))!.currentVersionId,null);
      }else{
        const nextVersion={...version,id:planned,number:1,parentVersionId:null,articleId:id,briefId:copyBrief,body:copyBody,contentSha:sha256(copyBody),promotionPack:undefined};
        await workerStore.campaignCopyBoundary({...base,now:now(),decide:s=>{
          const m=s.article.campaignGeneration!;assert.equal(campaignCopyIssue(s,m,now()),null);
          return {article:{...s.article,currentVersionId:planned,campaignGeneration:{...m,appliedAt:now()}},version:nextVersion};
        }});
        assert.equal((await workerStore.getArticle(f.brand,id))!.currentVersionId,planned);
      }
      const settled=(await workerStore.getJob(f.brand,jobId))!;if(settled.state==='running')await workerStore.updateJob({...settled,state:'done',leaseOwner:null,leaseExpiresAt:null});
      assert.equal(copy.created,true);
    }
    const identity = { userId: f.user, workspaceId: f.home, sessionToken: f.token, userEmail: `synthetic-${f.user}@example.test` };
    const calendar=createPgSeoBlogSocialRegistry({zernioPool:zernio,contentCommandPool:content,contentAdapterPool:adapter,identity,requestId:randomUUID(),zernioApiKey:null,reservedProfileIds:[]});
    const from=new Date(Date.now()-86_400_000).toISOString(),until=new Date(Date.now()+30*86_400_000).toISOString();
    assert.deepEqual(await calendar.listCalendar!(f.brand,from,until),[],'genuine original-home session reads target brand through existing command capability');
    await assert.rejects(calendar.listCalendar!(randomUUID(),from,until),{status:403});
    const reader = new PgSeoBlogReleasedMediaReader(web);
    const sourceBytes = syntheticJpeg(); let calls = 0;
    const generate = async (command: ImageGenerationCommand): Promise<ImageGenerationReceipt> => {
      calls++; const prepared = prepareImageGenerationRequest(command);
      const roles = await withTransaction(content, { actorKind: 'worker', workspaceId: f.brand, requestId: randomUUID() }, async t => (await t.query("SELECT session_user,current_user,current_setting('app.actor_kind') AS actor,current_setting('app.user_id') AS user_id")).rows[0]);
      assert.equal(roles.session_user, 'r72_content_command'); assert.equal(roles.current_user, 'r72_content_command'); assert.equal(roles.actor, 'worker'); assert.equal(roles.user_id, '');
      const admitted = (await admin.query('SELECT count(*)::int AS n FROM app.seo_blog_image_attempts WHERE workspace_id=$1', [f.brand])).rows[0].n;
      assert.equal(admitted, 1, 'admission is committed before the fake transport is invoked');
      return { outcome: 'candidate_received', code: 'candidate_received', requestSha256: prepared.requestSha256, providerRequestIdSha256: null, httpStatus: 200, usage: null,
        candidate: { bytes: sourceBytes, sha256: hash(sourceBytes), mimeType: 'image/jpeg', byteLength: sourceBytes.length, requestedSize: '1536x1024', validation: 'candidate_only' } };
    };
    const ownerImages = createPgArticleImageService({ store: ownerStore, media: ownerMedia, principal: ownerPrincipal, providerConfigured: true, generate });
    const workerImages = createPgArticleImageService({ store: workerStore, media: workerMedia, principal: workerPrincipal, providerConfigured: true, generate });
    const commandId = randomUUID(), request = { brandId: f.brand, articleId: f.article, expectedVersionId: f.version, commandId, origin: 'owner' as const, sponsorUserId: f.user, confirmedNewIntent: false };
    const queued = await ownerImages.request(request); assert.equal(queued.kind, 'job'); if (queued.kind !== 'job') throw Error('Synthetic intent should queue');
    const coalesced = await ownerImages.request({ ...request, commandId: randomUUID() }); assert.equal(coalesced.kind, 'job'); if (coalesced.kind === 'job') assert.equal(coalesced.job.id, queued.job.id);
    const claimed = await workerStore.claimJobs({ brandId: f.brand, kinds: ['write'], now: new Date(Date.now() + 1000).toISOString(), owner: 'native-image-proof', leaseMs: 600000, limit: 1 });
    assert.equal(claimed.length, 1);
    const done = await workerImages.run(claimed[0]!); assert.equal(done.state, 'done'); assert.equal(calls, 1);
    const duplicate = await workerImages.run(claimed[0]!); assert.equal(duplicate.state, 'done'); assert.equal(calls, 1);
    const current = (await ownerStore.getArticle(f.brand, f.article))!; assert.equal(current.imageProposals?.length, 1);
    const proposal = current.imageProposals![0]!; assert.deepEqual(proposal.variants.map(v => v.profile).sort(), ['blog', 'instagram', 'linkedin']);
    for (const crop of proposal.variants) { const saved = await ownerMedia.loadPrivateAsset(f.brand, crop.assetId, crop.sha256); assert.equal(hash(saved.bytes), crop.sha256); assert.equal(saved.asset.validation, 'prepared_jpeg'); }
    assert.equal((await admin.query("SELECT sum(amount)::int AS n FROM app.seo_blog_usage WHERE workspace_id=$1 AND kind='images'", [f.brand])).rows[0].n, 1);
    const quality = new ArticleMediaReviewService(ownerStore, ownerMedia, createCentralImageQualityApproval({ adapterPool: adapter, commandPool: content, identity, requestId: randomUUID() }), now);
    const hero = proposal.variants.find(v => v.profile === 'blog')!, qualityId = randomUUID();
    await quality.review(f.user, f.brand, f.article, qualityId, { assetId: hero.assetId, assetSha256: hero.sha256, profile: 'blog', alt: 'An abstract considered editorial decision' });
    const ownerEngine = new SeoBlogEngine({ store: ownerStore, llm: null, search: { id: 'unconfigured', mode: 'unconfigured', search: async () => { throw Error('No research'); } },
      transport: new FakeWeb(), publishers: new Map(), vault: null, mediaReview: quality, now });
    const final = await ownerEngine.selectCampaignHero({ userId: f.user }, f.brand, f.article, f.version, randomUUID(), qualityId);
    await ownerEngine.authorizeCampaignHero({ userId: f.user }, f.brand, f.article, final.id, randomUUID());
    const selected = (await ownerStore.getArticle(f.brand, f.article))!;
    assert.equal(await reader.readReleasedAsset(selected.heroMedia!.reservation.prospectiveReleaseId, hero.sha256), null, 'prospective reviewed URL is still private');
    const destination: Destination = { id: randomUUID(), brandId: f.brand, type: 'github_static', label: 'Synthetic website', config: { repository: 'synthetic/site', branch: 'main', blogPath: 'blog', sitemapPath: 'sitemap.xml', publicBaseUrl: MEDIA_STORAGE_TEST_ORIGIN }, sealedCredential: null,
      publicBaseUrl: MEDIA_STORAGE_TEST_ORIGIN, status: 'connected', statusDetail: 'Synthetic owned proof', checkedAt: now(), createdAt: now() };
    await ownerStore.saveDestination(destination);
    const approved = await ownerStore.updateArticle({ ...selected, approval: { versionId: final.id, contentSha: final.contentSha, approvedAt: now(), approvedBy: f.user },
      checks: { versionId: final.id, contentSha: final.contentSha, factsSha: final.factsSha, ranAt: now(), status: 'pass', issues: [] },
      schedule: { publishAtUtc: now(), localDate: now().slice(0, 10), localTime: '12:00', timezone: 'Europe/London', destinationId: destination.id, setAt: now(), setBy: f.user } });
    const publication: Publication = { id: randomUUID(), brandId: f.brand, articleId: f.article, versionId: final.id, contentSha: final.contentSha, destinationId: destination.id, idempotencyKey: `native-media:${randomUUID()}`,
      scheduledFor: now(), policy: { rule: 'approved', approvedVersionId: final.id, autoPublish: false, requiresApproval: true, decidedAt: now() }, state: 'prepared', attempts: 1, firstAttemptAt: now(), lastAttemptAt: now(), providerRef: null,
      publicUrl: `${MEDIA_STORAGE_TEST_ORIGIN}/blog/${body.slug}`, verifiedAt: null, verifyAttempts: 0, detail: 'Synthetic begin, no website provider invoked.', rowVersion: 1,
      websiteSnapshot: { destination, target: null, reviewedIntentSha: final.contentSha, brandName: 'Media brand', locale: 'en-GB', publishedAt: now(), requestSha: sha256('synthetic wire') } };
    const failedBegin = new PgSeoBlogStore(content, workerPrincipal, {
      assertPublicationMediaEffect: (t, workspace, input) => workerMedia.assertPublicationMediaEffect(t, workspace, input),
      async releaseForPublication(t, workspace, input) { await workerMedia.releaseForPublication(t, workspace, input); throw Error('Synthetic failure after release before publication COMMIT'); },
    });
    await assert.rejects(failedBegin.beginPublication({ brandId: f.brand, articleId: f.article, resumePublicationId: null,
      decide: s => ({ kind: 'begin', article: { ...s.article, delivery: 'publishing', deliveryPublicationId: publication.id }, publication }) }), /before publication COMMIT/);
    assert.equal(await reader.readReleasedAsset(selected.heroMedia!.reservation.prospectiveReleaseId, hero.sha256), null, 'a release rolls back with its publication');
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM app.seo_blog_publications WHERE workspace_id=$1 AND id=$2', [f.brand, publication.id])).rows[0].n, 0);
    const begun = await workerStore.beginPublication({ brandId: f.brand, articleId: f.article, resumePublicationId: null,
      decide: s => ({ kind: 'begin', article: { ...s.article, delivery: 'publishing', deliveryPublicationId: publication.id }, publication }) });
    assert.equal(begun.kind, 'begin'); assert.ok(begun.kind === 'begin' && begun.publication.mediaRelease?.ownerAuthorizationId);
    assert.deepEqual((await reader.readReleasedAsset(approved.heroMedia!.reservation.prospectiveReleaseId, hero.sha256))!.bytes, (await ownerMedia.loadPrivateAsset(f.brand, hero.assetId, hero.sha256)).bytes);
    assert.equal(calls, 1); assert.equal((await admin.query('SELECT count(*)::int AS n FROM app.seo_blog_media_public_releases WHERE workspace_id=$1', [f.brand])).rows[0].n, 1);
    // Later draft/membership changes do not revoke the historical public release.
    await admin.query("UPDATE app.workspace_memberships SET status='revoked',revoked_at=clock_timestamp(),updated_at=clock_timestamp() WHERE workspace_id=$1 AND user_id=$2", [f.brand, f.user]);
    await assert.rejects(calendar.listCalendar!(f.brand,from,until),{status:403});
    assert.ok(await reader.readReleasedAsset(approved.heroMedia!.reservation.prospectiveReleaseId, hero.sha256));
    const historical = (await workerStore.listPublications(f.brand, f.article))[0]!;
    await assert.rejects(workerStore.beginPublication({ brandId: f.brand, articleId: f.article, resumePublicationId: historical.id,
      decide: s => ({ kind: 'begin', article: s.article, publication: { ...s.publication!, attempts: s.publication!.attempts + 1, state: 'prepared' } }) }), { code: 'media_effect_held', status: 409 });
    assert.equal((await workerStore.listPublications(f.brand, f.article))[0]!.attempts, historical.attempts, 'revoked fresh-send guard rolls back the retry despite an old release receipt');
    assert.ok(await reader.readReleasedAsset(approved.heroMedia!.reservation.prospectiveReleaseId, hero.sha256), 'historical reads remain independent of new effect eligibility');
  } finally { await Promise.all([content.end(), adapter.end(), web.end(),zernio.end()]); await admin.end(); }
});
