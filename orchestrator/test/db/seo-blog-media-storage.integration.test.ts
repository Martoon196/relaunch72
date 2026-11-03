/** Disposable PostgreSQL only. No supplier, HTTP publication, real limits or production credentials. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import pg from 'pg';
import { openTestDatabase,testDatabaseSkipReason } from './database-helper.js';
import {loginMediaProofRole as login,seedMediaStorageFixture as seed,type MediaStorageProofFixture as Fixture} from './seo-blog-media-fixtures.js';
import { withTransaction,type DbTransaction } from '../../src/db/transaction.js';
import { type Job } from '../../src/seo-blog/types.js';
import { PgSeoBlogMediaStore,PgSeoBlogReleasedMediaReader,canonicalImageSourceVersion } from '../../src/seo-blog/media-store.js';
import type { SeoImageAttemptInput,SeoImageAttemptDecision,SeoImageIntentInput,SeoImageVerifiedPreparation,SeoMediaCanonicalApproval,SeoMediaRecipe } from '../../src/seo-blog/media-types.js';
import { CompanyContentService,type CompanyContentTransactionRunner } from '../../src/company-content-pg/index.js';
import {canonicalCompanyContentJson} from '../../src/company-content-pg/validation.js';
import {createPgSeoBlogSocialRegistry,createSeoBlogZernioWebhookBrands} from '../../src/portal/seo-blog-social-pg.js';
import {ZERNIO_ACCOUNT_WEBHOOK_CONTRACT_VERSION} from '../../src/public-social-outbound/zernio-account-webhook-contract.js';
import type {SeoCampaignQueueInput,SeoCampaignQueueResult} from '../../src/seo-blog/media-types.js';
const skip=testDatabaseSkipReason();
const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const origin='https://media-proof.example.test';
const jpeg=Buffer.concat([Buffer.from('ffd8ffe0','hex'),Buffer.alloc(40,7),Buffer.from('ffd9','hex')]);
// The storage boundary receives a preparation receipt; decoder accuracy belongs to the separately reviewed JPEG component.
const recipe=(sourceSha256:string):SeoMediaRecipe=>({version:'r72-jpeg-focal-v1',sourceSha256,profile:'blog',width:1600,height:900,
  focal:{x:.5,y:.5},crop:{x:0,y:80,width:1536,height:864},quality:85,metadataStripped:true});
const workerContext=(workspaceId:string)=>({actorKind:'worker' as const,workspaceId,requestId:randomUUID()});
function canonicalService(pool:pg.Pool):CompanyContentService {
  const runner:CompanyContentTransactionRunner={run:(context,run,options)=>withTransaction(pool,context,run,{readOnly:options.readOnly,isolation:options.serializable?'serializable':'read committed'})};
  return new CompanyContentService({transactionRunner:runner});
}
async function initialize(f:Fixture,worker:PgSeoBlogMediaStore,policy:Awaited<ReturnType<PgSeoBlogMediaStore['readImagePolicy']>>,content:pg.Pool) {
  // Each later journey deliberately creates a DISTINCT manual intent. Terminalise prior fixture jobs, retaining all nonces/reservations.
  await withTransaction(content,workerContext(f.brand),(t)=>t.query("UPDATE app.seo_blog_jobs SET state='cancelled',data=data||jsonb_build_object('state','cancelled') WHERE workspace_id=$1 AND kind='write' AND data#>>'{payload,stage}'='image' AND state IN ('queued','running')",[f.brand]));
  const source=await f.owner.readImageSourceSnapshot(f.brand,f.article);
  let input:SeoImageIntentInput={commandId:randomUUID(),jobId:randomUUID(),intentId:randomUUID(),intentSha256:sha(randomUUID()),requestSha256:sha(randomUUID()),
    expectedPolicyVersion:policy.version,expectedPolicySha256:policy.sha256,model:'gpt-image-2',quality:'medium',sponsorUserId:f.user,
    privateCommand:{brandId:f.brand,actorId:f.user,prompt:'Fixture only; no supplier is invoked.'},source};
  let result=await f.owner.initializeImageIntent(f.brand,input);
  if(result.kind==='held'&&result.reason==='new_intent_confirmation_required'){
    assert.ok(result.replacesIntentId);input={...input,confirmedNewIntent:true,replacesIntentId:result.replacesIntentId!,intentSha256:sha(randomUUID())};
    result=await f.owner.initializeImageIntent(f.brand,input);
  }
  assert.ok('id' in result);if('id' in result)assert.equal(result.id,input.jobId);
  await withTransaction(content,workerContext(f.brand),async(t)=>{
    await t.query(`UPDATE app.seo_blog_jobs SET state='running',lease_expires_at=clock_timestamp()+interval '30 minutes',
      data=data||jsonb_build_object('state','running','attempts',1,'leaseOwner','media-proof','leaseExpiresAt',clock_timestamp()+interval '30 minutes') WHERE workspace_id=$1 AND id=$2`,[f.brand,input.jobId]);
  });
  const start:SeoImageAttemptInput={workspaceId:f.brand,jobId:input.jobId,intentId:input.intentId,nonce:randomUUID(),leaseOwner:'media-proof',leaseAttempt:1,
    expectedPolicyVersion:policy.version,expectedPolicySha256:policy.sha256,requestSha256:input.requestSha256,intentSha256:input.intentSha256,providerConfigured:true,
    sourceSha256:source.sourceSha256,profileSha256:source.profileSha256,visualSha256:source.visualSha256,articleId:source.articleId,articleVersionId:source.articleVersionId,
    articleContentSha256:source.articleContentSha256,sponsorUserId:f.user,sourceSnapshotVersion:'seo-image-source-v1'};
  return {input,start,worker};
}
async function configure(admin:pg.Pool,patch:Record<string,unknown>) {
  // Artificial disposable proof units, never supplier pricing and never production configuration.
  await admin.query('UPDATE app_private.seo_image_operator_policy SET version=version+1,config=config||$1::jsonb',[JSON.stringify(patch)]);
}
async function waitForBlockedFixture(admin:pg.Pool,marker:string):Promise<void>{
  for(let i=0;i<100;i++){
    const row=(await admin.query<{blocked:boolean}>("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='relaunch72-disposable-media-storage' AND wait_event_type='Lock' AND query LIKE $1) AS blocked",[`%${marker}%`])).rows[0]!;
    if(row.blocked)return;await new Promise(resolve=>setTimeout(resolve,10));
  }
  throw new Error(`Expected isolated fixture lock wait: ${marker}`);
}
async function project(t:DbTransaction,start:SeoImageAttemptInput,decision:Extract<SeoImageAttemptDecision,{kind:'admitted'}>,amount:number|null=1,months=0,nonce=decision.nonce) {
  await t.query("UPDATE app.seo_blog_jobs SET data=jsonb_set(data,'{payload,image,start}',jsonb_build_object('nonce',$3::text,'attemptId',$4::text)) WHERE workspace_id=$1 AND id=$2",[start.workspaceId,start.jobId,nonce,decision.attemptId]);
  if(amount!==null)await t.query("INSERT INTO app.seo_blog_usage(workspace_id,kind,amount,at,reference) VALUES($1,'images',$2,clock_timestamp()+make_interval(months=>$3),$4)",[start.workspaceId,amount,months,`seo-image-start:${decision.attemptId}`]);
}

test('010 storage and spending: genuine roles, immutable owner review/release, zero policy, races, atomic starts/receipts and late-source fences',{skip,timeout:300_000},async()=>{
  const admin=await openTestDatabase();const content=await login(admin,'r72_content_command'),adapter=await login(admin,'r72_content_adapter'),web=await login(admin,'r72_web');
  const zernio=await login(admin,'r72_zernio_social_command'),calendar=await login(admin,'r72_owned_social_worker_command');
  try {
    const a=await seed(admin,content),b=await seed(admin,content),worker=new PgSeoBlogMediaStore(content,{kind:'worker',requestId:randomUUID()},{publicOrigin:origin});
    const reader=new PgSeoBlogReleasedMediaReader(web);
    const identity=await withTransaction(content,workerContext(a.brand),async(t)=>(await t.query("SELECT session_user,current_user,current_setting('app.actor_kind') AS actor,current_setting('app.user_id') AS user_id")).rows[0]);
    assert.equal(identity.session_user,'r72_content_command');assert.equal(identity.current_user,'r72_content_command');assert.equal(identity.actor,'worker');assert.equal(identity.user_id,'');
    assert.equal((await web.query('SELECT session_user,current_user')).rows[0].session_user,'r72_web');
    for(const table of ['seo_blog_media_assets','seo_blog_media_commands','seo_blog_image_attempts'])await assert.rejects(content.query(`SELECT * FROM app.${table}`),{code:'42501'});
    await assert.rejects(web.query('SELECT * FROM app.seo_blog_blobs'),{code:'42501'});
    await assert.rejects(content.query('UPDATE app_private.seo_image_operator_policy SET admission_epoch=admission_epoch+1'),{code:'42501'});
    await assert.rejects(content.query('SET ROLE r72_seo_media_definer'),{code:'42501'});
    assert.equal((await admin.query("SELECT rolcanlogin,rolinherit,rolbypassrls FROM pg_roles WHERE rolname='r72_seo_media_definer'")).rows[0].rolcanlogin,false);

    const candidateInput={commandId:randomUUID(),bytes:jpeg,provenance:{kind:'uploaded' as const,brandSha256:sha('brand'),sourceName:'Owner fixture'},receipt:{outcome:'uploaded',code:'uploaded'}};
    await assert.rejects(worker.persistCandidateReceipt(a.brand,candidateInput));
    const candidate=await a.owner.persistCandidateReceipt(a.brand,candidateInput);
    assert.equal((await a.owner.persistCandidateReceipt(a.brand,candidateInput)).id,candidate.id);
    assert.deepEqual((await a.owner.loadPrivateAsset(a.brand,candidate.id,candidate.sha256)).bytes,jpeg);
    await assert.rejects(b.owner.loadPrivateAsset(b.brand,candidate.id,candidate.sha256));
    const prep=await worker.commitPreparation(a.brand,{commandId:randomUUID(),sourceAssetId:candidate.id,sourceSha256:candidate.sha256,outcome:'prepared',sourceDimensions:{width:1536,height:1024},variants:[{bytes:jpeg,recipe:recipe(candidate.sha256)}],detail:null});
    const asset=prep.variants[0]!;const use=await a.owner.reserveMediaUse(a.brand,{commandId:randomUUID(),articleId:a.article,assetId:asset.id,assetSha256:asset.sha256,presentation:{profile:'blog',slot:'hero',alt:'Owner reviewed test image'}});
    assert.equal(await reader.readReleasedAsset(use.prospectiveReleaseId,asset.sha256),null);
    const manifest=await a.owner.getCanonicalManifest(a.brand,use.commandId);
    const userContext={actorKind:'user' as const,workspaceId:a.brand,userId:a.user,requestId:randomUUID()};
    const makeVersion=canonicalService(adapter),approvals=canonicalService(content);
    const created=await makeVersion.createVersion(userContext,{commandKey:randomUUID(),origin:'imported',kind:'image',title:'Exact owner image',contentMimeType:'application/json',content:JSON.stringify(manifest),
      source:{system:'relaunch72.seo-media',itemId:asset.id,version:canonicalImageSourceVersion(manifest)},blob:{storageKey:`seo-blog-media/${asset.id}/${asset.sha256}`,sha256:asset.sha256},brand:{snapshotRef:'media-proof',sha256:manifest.provenance.brandSha256},
      attestation:{catalogSha256:sha(JSON.stringify(manifest)),checkedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+240000).toISOString()}});
    const requested=await approvals.requestApproval(userContext,{commandKey:randomUUID(),contentItemId:created.contentItemId,contentVersionId:created.contentVersionId});
    const decision=await approvals.decideApproval(userContext,{commandKey:randomUUID(),approvalRequestId:requested.approvalRequestId,decision:'approved'});
    const canonical:SeoMediaCanonicalApproval={contentItemId:created.contentItemId,contentVersionId:created.contentVersionId,contentSha256:created.contentSha256,approvalRequestId:requested.approvalRequestId,approvalDecisionId:decision.approvalDecisionId};
    // A newer rejected presentation never silently selects old pixels, but explicit exact old approval remains usable.
    const changedManifest={...manifest,presentation:{...manifest.presentation,alt:'Rejected newer presentation'}};
    const newer=await makeVersion.createVersion(userContext,{commandKey:randomUUID(),contentItemId:created.contentItemId,previousVersionId:created.contentVersionId,origin:'edited',kind:'image',title:'Newer rejected image presentation',contentMimeType:'application/json',content:JSON.stringify(changedManifest),
      source:{system:'relaunch72.seo-media',itemId:asset.id,version:canonicalImageSourceVersion(changedManifest)},blob:{storageKey:`seo-blog-media/${asset.id}/${asset.sha256}`,sha256:asset.sha256},brand:{snapshotRef:'media-proof',sha256:manifest.provenance.brandSha256},
      attestation:{catalogSha256:sha(JSON.stringify(changedManifest)),checkedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+240000).toISOString()}});
    const newerRequest=await approvals.requestApproval(userContext,{commandKey:randomUUID(),contentItemId:newer.contentItemId,contentVersionId:newer.contentVersionId});
    await approvals.decideApproval(userContext,{commandKey:randomUUID(),approvalRequestId:newerRequest.approvalRequestId,decision:'rejected',decisionNote:'Reject the newer presentation; retain the separately approved historical image.'});
    const finalVersion=randomUUID(),contentSha=sha(use.prospectiveUrl),destinationId=randomUUID();
    const destination={id:destinationId,brandId:a.brand,type:'content_api',publicBaseUrl:origin,config:{},sealedCredential:'fixture-seal-not-real',status:'connected',websiteCapability:{protocol:'legacy',checkedAt:new Date().toISOString()}};
    await admin.query("INSERT INTO app.seo_blog_records(workspace_id,kind,id,data) VALUES($1,'destination',$2,$3)",[a.brand,destinationId,JSON.stringify(destination)]);
    await admin.query('INSERT INTO app.seo_blog_article_versions(workspace_id,id,article_id,number,content_sha256,data) VALUES($1,$2,$3,2,$4,$5)',[a.brand,finalVersion,a.article,contentSha,JSON.stringify({id:finalVersion,body:{image:{url:use.prospectiveUrl,alt:use.presentation.alt}},contentSha})]);
    await admin.query("UPDATE app.seo_blog_articles SET data=data||jsonb_build_object('currentVersionId',$3::text,'approval',jsonb_build_object('versionId',$3::text,'contentSha',$4::text),'checks',jsonb_build_object('versionId',$3::text,'contentSha',$4::text,'status','pass')) WHERE workspace_id=$1 AND id=$2",[a.brand,a.article,finalVersion,contentSha]);
    const authorization=await a.owner.recordOwnerImageAuthorization(a.brand,{commandId:randomUUID(),reservationCommandId:use.commandId,articleVersionId:finalVersion,articleContentSha256:contentSha,reviewedIntentSha256:contentSha,canonical});
    await assert.rejects(withTransaction(content,userContext,(t)=>t.query('SELECT app_private.seo_media_authorize($1,$2,$3)',[a.brand,Buffer.alloc(32,1),JSON.stringify({commandId:randomUUID()})])),{code:'42501'});
    await assert.rejects(worker.recordOwnerImageAuthorization(a.brand,{commandId:randomUUID(),reservationCommandId:use.commandId,articleVersionId:finalVersion,articleContentSha256:contentSha,reviewedIntentSha256:contentSha,canonical}));
    const publication=randomUUID();
    await admin.query("INSERT INTO app.seo_blog_publications(workspace_id,id,article_id,version_id,idempotency_key,state,data) VALUES($1,$2,$3,$4,$5,'prepared',$6)",[a.brand,publication,a.article,finalVersion,`media-proof:${publication}`,JSON.stringify({id:publication,articleId:a.article,versionId:finalVersion,contentSha,destinationId,publicUrl:`${origin}/blog/proof`,policy:{rule:'approved',approvedVersionId:finalVersion,autoPublish:false,requiresApproval:true},websiteSnapshot:{destination,target:null,reviewedIntentSha:contentSha}})]);
    const releaseInput={publicationId:publication,ownerAuthorizationId:authorization.id,reviewedIntentSha256:contentSha};
    await assert.rejects(withTransaction(content,workerContext(a.brand),async(t)=>{await worker.releaseForPublication(t,a.brand,releaseInput);throw new Error('rollback-publication');}),/rollback-publication/);
    assert.equal(await reader.readReleasedAsset(use.prospectiveReleaseId,asset.sha256),null);
    await withTransaction(content,workerContext(a.brand),(t)=>worker.releaseForPublication(t,a.brand,releaseInput));
    assert.deepEqual((await reader.readReleasedAsset(use.prospectiveReleaseId,asset.sha256))!.bytes,jpeg);
    // Same reviewed image URL can receive a second append-only operation binding after fresh v2 target/version review.
    const siteId=randomUUID(),capabilitiesSha=sha('v2-installed-capabilities'),deliverySha=sha('v2-reviewed-delivery'),v2Version=randomUUID(),v2Publication=randomUUID();
    const v2Destination={...destination,websiteCapability:{protocol:'v2',checkedAt:new Date().toISOString(),capabilities:{contractVersion:2,siteId,publicOrigin:origin,capabilitiesSha}}};
    const v2Target={schema:1,origin:'owner_review',destinationId,brandName:'Media brand',locale:'en-GB',contractVersion:2,
      target:{siteId,capabilitiesSha,rootId:'blog',rootPath:'blog',canonicalUrl:`${origin}/blog/proof`,indexUrl:`${origin}/blog`,structureId:randomUUID(),structureRevision:1,structureSha:sha('structure'),categories:[],categoryIds:[]},categoryUrls:[],sitemapUrls:[`${origin}/sitemap.xml`],deliverySha};
    await admin.query("UPDATE app.seo_blog_records SET data=$3 WHERE workspace_id=$1 AND kind='destination' AND id=$2",[a.brand,destinationId,JSON.stringify(v2Destination)]);
    await admin.query('INSERT INTO app.seo_blog_article_versions(workspace_id,id,article_id,number,content_sha256,data) VALUES($1,$2,$3,3,$4,$5)',[a.brand,v2Version,a.article,contentSha,JSON.stringify({id:v2Version,body:{image:{url:use.prospectiveUrl,alt:use.presentation.alt}},contentSha,websiteTarget:v2Target})]);
    await admin.query("UPDATE app.seo_blog_articles SET data=data||jsonb_build_object('currentVersionId',$3::text,'approval',jsonb_build_object('versionId',$3::text,'contentSha',$4::text),'checks',jsonb_build_object('versionId',$3::text,'contentSha',$4::text,'status','pass')) WHERE workspace_id=$1 AND id=$2",[a.brand,a.article,v2Version,contentSha]);
    const v2Authorization=await a.owner.recordOwnerImageAuthorization(a.brand,{commandId:randomUUID(),reservationCommandId:use.commandId,articleVersionId:v2Version,articleContentSha256:contentSha,reviewedIntentSha256:deliverySha,canonical});
    const v2Data={id:v2Publication,articleId:a.article,versionId:v2Version,contentSha,destinationId,publicUrl:`${origin}/blog/proof`,policy:{rule:'approved',approvedVersionId:v2Version,autoPublish:false,requiresApproval:true},websiteSnapshot:{destination:v2Destination,target:{...v2Target,deliverySha:sha('wrong-target')},reviewedIntentSha:deliverySha}};
    await admin.query("INSERT INTO app.seo_blog_publications(workspace_id,id,article_id,version_id,idempotency_key,state,data) VALUES($1,$2,$3,$4,$5,'prepared',$6)",[a.brand,v2Publication,a.article,v2Version,`media-proof:${v2Publication}`,JSON.stringify(v2Data)]);
    const v2ReleaseInput={publicationId:v2Publication,ownerAuthorizationId:v2Authorization.id,reviewedIntentSha256:deliverySha};
    await assert.rejects(withTransaction(content,workerContext(a.brand),(t)=>worker.releaseForPublication(t,a.brand,v2ReleaseInput)),{code:'55000'});
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM app.seo_blog_media_public_releases WHERE publication_id=$1',[v2Publication])).rows[0].n,0);
    await admin.query("UPDATE app.seo_blog_publications SET data=jsonb_set(data,'{websiteSnapshot,target}',$3::jsonb) WHERE workspace_id=$1 AND id=$2",[a.brand,v2Publication,JSON.stringify(v2Target)]);
    const v2Release=await withTransaction(content,workerContext(a.brand),async(t)=>{await worker.assertPublicationMediaEffect(t,a.brand,v2ReleaseInput);return worker.releaseForPublication(t,a.brand,v2ReleaseInput);});
    assert.equal(v2Release.id,use.prospectiveReleaseId);assert.notEqual(v2Release.bindingId,publication);
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM app.seo_blog_media_public_releases WHERE release_id=$1',[use.prospectiveReleaseId])).rows[0].n,2);
    await admin.query("UPDATE app.workspace_memberships SET status='revoked',revoked_at=clock_timestamp() WHERE workspace_id=$1 AND user_id=$2",[a.brand,a.user]);
    await assert.rejects(withTransaction(content,workerContext(a.brand),(t)=>worker.assertPublicationMediaEffect(t,a.brand,v2ReleaseInput)),{code:'55000'});
    assert.ok(await reader.readReleasedAsset(use.prospectiveReleaseId,asset.sha256));
    await withTransaction(content,workerContext(a.brand),(t)=>worker.releaseForPublication(t,a.brand,releaseInput)); // receipt replay, not fresh admission
    await admin.query("UPDATE app.workspace_memberships SET status='active',revoked_at=NULL WHERE workspace_id=$1 AND user_id=$2",[a.brand,a.user]);
    await withTransaction(content,workerContext(a.brand),async(t)=>{await worker.assertPublicationMediaEffect(t,a.brand,v2ReleaseInput);assert.deepEqual(await worker.releaseForPublication(t,a.brand,v2ReleaseInput),v2Release);});
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM app.seo_blog_media_public_releases WHERE release_id=$1',[use.prospectiveReleaseId])).rows[0].n,2);
    await admin.query("UPDATE app.seo_blog_articles SET data=data||jsonb_build_object('currentVersionId',$3::text,'approval',NULL) WHERE workspace_id=$1 AND id=$2",[a.brand,a.article,a.version]);
    assert.ok(await reader.readReleasedAsset(use.prospectiveReleaseId,asset.sha256),'A new unapproved draft retains the released snapshot');
    await admin.query("UPDATE app.seo_blog_articles SET data=data||jsonb_build_object('currentVersionId',$3::text,'approval',jsonb_build_object('versionId',$3::text,'contentSha',$4::text)) WHERE workspace_id=$1 AND id=$2",[a.brand,a.article,v2Version,contentSha]);
    await a.owner.withdrawAssetOrRelease(a.brand,{commandId:randomUUID(),scope:'release',releaseId:use.prospectiveReleaseId,assetSha256:asset.sha256,reason:'Explicit fixture withdrawal'});
    await assert.rejects(withTransaction(content,workerContext(a.brand),(t)=>worker.assertPublicationMediaEffect(t,a.brand,v2ReleaseInput)),{code:'55000'});
    assert.deepEqual(await withTransaction(content,workerContext(a.brand),(t)=>worker.releaseForPublication(t,a.brand,v2ReleaseInput)),v2Release);
    assert.equal(await reader.readReleasedAsset(use.prospectiveReleaseId,asset.sha256),null);
    await admin.query("UPDATE app.seo_blog_articles SET data=data||jsonb_build_object('currentVersionId',$3::text,'approval',NULL) WHERE workspace_id=$1 AND id=$2",[a.brand,a.article,a.version]);

    let policy=await worker.readImagePolicy();assert.equal(policy.enabled,false);assert.equal(policy.maxConcurrency,0);assert.equal(policy.monthlyMicrousd,0);
    const disabled=await initialize(a,worker,policy,content);assert.equal((await worker.commitImageAttempt(disabled.start)).kind,'held');
    const automaticInput={...disabled.input,commandId:randomUUID(),jobId:randomUUID(),intentId:randomUUID(),intentSha256:sha(randomUUID())};
    const automatic=await worker.initializeImageIntent(a.brand,automaticInput);assert.ok('id' in automatic);if('id' in automatic)assert.equal(automatic.id,disabled.input.jobId);
    const foreignSponsor={...automaticInput,commandId:randomUUID(),jobId:randomUUID(),intentId:randomUUID(),sponsorUserId:b.user,privateCommand:{...automaticInput.privateCommand,actorId:b.user}};
    assert.deepEqual(await worker.initializeImageIntent(a.brand,foreignSponsor),{kind:'held',reason:'sponsor_ineligible'});
    const coalesce=await seed(admin,content);const coalesceSource=await coalesce.owner.readImageSourceSnapshot(coalesce.brand,coalesce.article);
    const coalesceInput:SeoImageIntentInput={...disabled.input,commandId:randomUUID(),jobId:randomUUID(),intentId:randomUUID(),intentSha256:sha(randomUUID()),source:coalesceSource,sponsorUserId:coalesce.user,
      privateCommand:{brandId:coalesce.brand,actorId:coalesce.user,prompt:'Coalescing fixture; never invoke a supplier.'}};
    const concurrentInit=await Promise.all([coalesce.owner.initializeImageIntent(coalesce.brand,coalesceInput),
      coalesce.owner.initializeImageIntent(coalesce.brand,{...coalesceInput,commandId:randomUUID(),jobId:randomUUID(),intentId:randomUUID(),intentSha256:sha(randomUUID())})]);
    assert.ok(concurrentInit.every(x=>'id' in x));if(!('id' in concurrentInit[0]!)||!('id' in concurrentInit[1]!))throw new Error('Coalescing fixture held');
    assert.equal(concurrentInit[0]!.id,concurrentInit[1]!.id);
    const retainedId=concurrentInit[0]!.id;
    const aliasInput={...coalesceInput,commandId:randomUUID(),jobId:randomUUID(),intentId:randomUUID(),confirmedNewIntent:true,replacesIntentId:randomUUID()};
    const confirmedDuplicate=await coalesce.owner.initializeImageIntent(coalesce.brand,aliasInput);
    assert.ok('id' in confirmedDuplicate);if('id' in confirmedDuplicate)assert.equal(confirmedDuplicate.id,retainedId);
    // The coalesced DIFFERENT command has its own durable receipt, before a now-held source/prompt can be rebuilt.
    await admin.query("UPDATE app.seo_blog_brands SET settings=jsonb_set(settings,'{pauseAll}','true') WHERE workspace_id=$1",[coalesce.brand]);
    const recoveredAlias=await coalesce.owner.recoverImageIntentRequest(coalesce.brand,{commandId:aliasInput.commandId,articleId:coalesce.article,articleVersionId:coalesce.version,origin:'owner'});
    assert.equal(recoveredAlias?.id,retainedId);
    assert.equal((await coalesce.owner.initializeImageIntent(coalesce.brand,aliasInput) as Job).id,retainedId);
    await assert.rejects(coalesce.owner.recoverImageIntentRequest(coalesce.brand,{commandId:aliasInput.commandId,articleId:coalesce.article,articleVersionId:randomUUID(),origin:'owner'}),{status:409});
    await admin.query("UPDATE app.seo_blog_brands SET settings=jsonb_set(settings,'{pauseAll}','false') WHERE workspace_id=$1",[coalesce.brand]);
    const originalAliases=(await admin.query("SELECT data#>'{payload,image,requestAliases}' AS aliases FROM app.seo_blog_jobs WHERE workspace_id=$1 AND id=$2",[coalesce.brand,retainedId])).rows[0].aliases as unknown[];
    const fullAliases=[...originalAliases,...Array.from({length:128-originalAliases.length},()=>({commandId:randomUUID(),requestedBy:coalesce.user,origin:'owner',articleId:coalesce.article,articleVersionId:coalesce.version}))];
    await withTransaction(content,workerContext(coalesce.brand),(t)=>t.query("UPDATE app.seo_blog_jobs SET data=jsonb_set(data,'{payload,image,requestAliases}',$3) WHERE workspace_id=$1 AND id=$2",[coalesce.brand,retainedId,JSON.stringify(fullAliases)]));
    assert.deepEqual(await coalesce.owner.initializeImageIntent(coalesce.brand,{...coalesceInput,commandId:randomUUID(),jobId:randomUUID(),intentId:randomUUID()}),{kind:'held',reason:'command_alias_limit'});
    assert.equal((await coalesce.owner.recoverImageIntentRequest(coalesce.brand,{commandId:aliasInput.commandId,articleId:coalesce.article,articleVersionId:coalesce.version,origin:'owner'}))?.id,retainedId);
    await withTransaction(content,workerContext(coalesce.brand),(t)=>t.query("UPDATE app.seo_blog_jobs SET data=jsonb_set(data,'{payload,image,requestAliases}',$3) WHERE workspace_id=$1 AND id=$2",[coalesce.brand,retainedId,JSON.stringify(originalAliases)]));
    await withTransaction(content,workerContext(coalesce.brand),(t)=>t.query("UPDATE app.seo_blog_jobs SET state='cancelled',data=data||jsonb_build_object('state','cancelled') WHERE workspace_id=$1 AND id=$2",[coalesce.brand,retainedId]));
    const afterTerminal=await worker.initializeImageIntent(coalesce.brand,{...coalesceInput,commandId:randomUUID(),jobId:randomUUID(),intentId:randomUUID()});
    assert.ok('id' in afterTerminal);if('id' in afterTerminal){assert.equal(afterTerminal.id,retainedId);assert.equal(afterTerminal.state,'cancelled');}
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM app.seo_blog_jobs WHERE workspace_id=$1',[coalesce.brand])).rows[0].n,1);
    const foreignFresh=await seed(admin,content);const foreignSource=await foreignFresh.owner.readImageSourceSnapshot(foreignFresh.brand,foreignFresh.article);
    assert.deepEqual(await worker.initializeImageIntent(foreignFresh.brand,{...coalesceInput,commandId:randomUUID(),jobId:randomUUID(),intentId:randomUUID(),source:foreignSource,sponsorUserId:a.user,
      privateCommand:{brandId:foreignFresh.brand,actorId:a.user,prompt:'Foreign sponsor must hold.'}}),{kind:'held',reason:'sponsor_ineligible'});
    await configure(admin,{enabled:true,maxConcurrency:1,monthlyMicrousd:10000,perAttemptMicrousd:1000});policy=await worker.readImagePolicy();
    const aa=await initialize(a,worker,policy,content),bb=await initialize(b,worker,policy,content);
    const raced=await Promise.all([worker.commitImageAttempt(aa.start),worker.commitImageAttempt(bb.start)]);
    assert.equal(raced.filter(x=>x.kind==='admitted').length,1);assert.equal(raced.filter(x=>x.kind==='held').length,1);
    const winner=raced[0]!.kind==='admitted'?aa:bb;const won=raced.find((x):x is Extract<SeoImageAttemptDecision,{kind:'admitted'}>=>x.kind==='admitted')!;
    assert.equal((await worker.commitImageAttempt({...winner.start,nonce:randomUUID()})).kind,'existing_started');
    await assert.rejects(withTransaction(content,workerContext(winner.start.workspaceId),(t)=>t.query('SELECT app_private.seo_image_reserve($1,$2)',[winner.start.workspaceId,JSON.stringify({...winner.start,intentSha256:sha('forged')})])),{code:'23505'});
    const unknown={outcome:'outcome_unknown',code:'transport_interrupted',requestSha256:winner.start.requestSha256,providerRequestIdSha256:null,httpStatus:null,usage:null};
    await worker.commitImageAttemptReceipt({workspaceId:winner.start.workspaceId,attemptId:won.attemptId,nonce:won.nonce,requestSha256:winner.start.requestSha256,leaseOwner:'media-proof',leaseAttempt:1,receipt:unknown});
    assert.equal((await worker.commitImageAttempt(winner.start)).kind,'existing_receipt');
    const loser=raced[0]!.kind==='admitted'?bb:aa;assert.deepEqual(await worker.commitImageAttempt(loser.start),{kind:'held',reason:'global_concurrency'});
    // Explicit known HTTP rejection releases concurrency, retaining conservative monetary/volume reservation.
    const rejected={...unknown,outcome:'rejected',code:'provider_rejected',httpStatus:400};
    await worker.commitImageAttemptReceipt({workspaceId:winner.start.workspaceId,attemptId:won.attemptId,nonce:won.nonce,requestSha256:winner.start.requestSha256,leaseOwner:'media-proof',leaseAttempt:1,receipt:rejected});
    assert.equal((await admin.query('SELECT reserved_microusd FROM app.seo_blog_image_attempts WHERE id=$1',[won.attemptId])).rows[0].reserved_microusd,'1000');
    await configure(admin,{maxConcurrency:100,monthlyMicrousd:100000});policy=await worker.readImagePolicy();
    // Each malformed admission must roll back the NEW ledger row and projected usage together.
    for(const mode of ['missing','wrong_nonce','wrong_amount','wrong_period','duplicate'] as const){
      const fixture=await initialize(a,worker,policy,content);
      await assert.rejects(withTransaction(content,workerContext(a.brand),async(t)=>{
        await t.query('SELECT workspace_id FROM app.seo_blog_brands WHERE workspace_id=$1 FOR UPDATE',[a.brand]);
        await t.query('SELECT id FROM app.seo_blog_jobs WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[a.brand,fixture.start.jobId]);
        const raw=(await t.query<{r:SeoImageAttemptDecision}>('SELECT app_private.seo_image_reserve($1,$2) AS r',[a.brand,JSON.stringify(fixture.start)])).rows[0]!.r;
        assert.equal(raw.kind,'admitted');if(raw.kind!=='admitted')throw new Error('Fixture admission did not start');
        await project(t,fixture.start,raw,mode==='missing'?null:mode==='wrong_amount'?2:1,mode==='wrong_period'?-2:0,mode==='wrong_nonce'?randomUUID():raw.nonce);
        if(mode==='duplicate')await t.query("INSERT INTO app.seo_blog_usage(workspace_id,kind,amount,at,reference) VALUES($1,'images',1,clock_timestamp(),$2)",[a.brand,`seo-image-start:${raw.attemptId}`]);
      }));
      assert.equal((await admin.query('SELECT count(*)::int AS n FROM app.seo_blog_image_attempts WHERE job_id=$1',[fixture.start.jobId])).rows[0].n,0);
    }
    const adversarialReference=`seo-image-start:${randomUUID()}`;
    const debitRace=await Promise.allSettled([0,1].map(()=>withTransaction(content,workerContext(b.brand),(t)=>t.query(
      "INSERT INTO app.seo_blog_usage(workspace_id,kind,amount,at,reference) VALUES($1,'images',1,clock_timestamp(),$2)",[b.brand,adversarialReference]))));
    assert.equal(debitRace.filter(r=>r.status==='fulfilled').length,1);
    const duplicateFailure=debitRace.find(r=>r.status==='rejected');assert.ok(duplicateFailure&&duplicateFailure.status==='rejected');assert.equal(duplicateFailure.reason.code,'23505');
    const late=await initialize(b,worker,policy,content);const admitted=await worker.commitImageAttempt(late.start);assert.equal(admitted.kind,'admitted');if(admitted.kind!=='admitted')throw new Error('No late fixture start');
    await withTransaction(content,workerContext(b.brand),(t)=>t.query("UPDATE app.seo_blog_jobs SET state='cancelled',data=data||jsonb_build_object('state','cancelled') WHERE workspace_id=$1 AND id=$2",[b.brand,late.start.jobId]));
    await configure(admin,{enabled:false});
    const success={outcome:'candidate_received',code:'candidate_received',requestSha256:late.start.requestSha256,providerRequestIdSha256:sha('request-id'),httpStatus:200,usage:{inputTokens:null,outputTokens:null,totalTokens:null}};
    const receiptInput={workspaceId:b.brand,attemptId:admitted.attemptId,nonce:admitted.nonce,requestSha256:late.start.requestSha256,leaseOwner:'media-proof',leaseAttempt:1,receipt:success,candidate:{bytes:jpeg,provenance:{kind:'generated' as const,brandSha256:late.input.source.profileSha256,sourceName:'Paid fixture candidate',generation:{intentId:late.start.intentId,nonce:admitted.nonce,requestSha256:late.start.requestSha256}}}};
    const saved=await worker.commitImageAttemptReceipt(receiptInput);assert.ok(saved.candidate);assert.equal(saved.applyEligible,false);
    assert.equal((await worker.commitImageAttemptReceipt(receiptInput)).candidate!.id,saved.candidate!.id);
    assert.equal((await admin.query('SELECT state FROM app.seo_blog_jobs WHERE workspace_id=$1 AND id=$2',[b.brand,late.start.jobId])).rows[0].state,'cancelled');
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM app.seo_blog_usage WHERE workspace_id=$1 AND reference=$2",[b.brand,`seo-image-start:${admitted.attemptId}`])).rows[0].n,1);
    await assert.rejects(worker.commitImageAttemptReceipt({...receiptInput,workspaceId:a.brand}));
    await assert.rejects(worker.commitImageAttemptReceipt({...receiptInput,candidate:{...receiptInput.candidate,bytes:Buffer.concat([jpeg,Buffer.from('changed')])}}),{code:'23505'});

    // Two independent brand transactions establish their snapshots BEFORE racing the singleton gate.
    await configure(admin,{enabled:true,maxConcurrency:1,monthlyMicrousd:1000000});policy=await worker.readImagePolicy();
    const serialA=await initialize(a,worker,policy,content),serialB=await initialize(b,worker,policy,content);
    let arrivals=0;let releaseBarrier!:()=>void;const barrier=new Promise<void>(resolve=>{releaseBarrier=resolve;});
    const serial=await Promise.allSettled([serialA,serialB].map(fixture=>withTransaction(content,workerContext(fixture.start.workspaceId),async(t)=>{
      await t.query('SELECT count(*) FROM app.seo_blog_usage WHERE workspace_id=$1',[fixture.start.workspaceId]);
      if(++arrivals===2)releaseBarrier();await barrier;
      return worker.reserveImageAttempt(t,fixture.start);
    },{isolation:'serializable'})));
    assert.equal(serial.filter(x=>x.status==='fulfilled'&&x.value.kind==='admitted').length,1);
    const serialFailure=serial.find(x=>x.status==='rejected');assert.ok(serialFailure&&serialFailure.status==='rejected');assert.equal(serialFailure.reason.code,'40001');
    const serialWinnerIndex=serial.findIndex(x=>x.status==='fulfilled'&&x.value.kind==='admitted');
    const serialWinner=serialWinnerIndex===0?serialA:serialB;const serialDecision=serial[serialWinnerIndex]!;
    assert.equal(serialDecision.status,'fulfilled');if(serialDecision.status!=='fulfilled'||serialDecision.value.kind!=='admitted')throw new Error('Serializable fixture missing winner');
    const serialAttempt=serialDecision.value;
    await worker.commitImageAttemptReceipt({workspaceId:serialWinner.start.workspaceId,attemptId:serialAttempt.attemptId,nonce:serialAttempt.nonce,
      requestSha256:serialWinner.start.requestSha256,leaseOwner:'media-proof',leaseAttempt:1,receipt:{...rejected,requestSha256:serialWinner.start.requestSha256}});

    // A fresh policy change held by the global gate must be observed after the waiting admission resumes.
    const waiting=await initialize(a,worker,policy,content);const operator=await admin.connect();
    try{
      await operator.query('BEGIN');await operator.query("UPDATE app_private.seo_image_operator_policy SET version=version+1,config=config||'{\"enabled\":false}'::jsonb");
      const pending=worker.commitImageAttempt(waiting.start);
      let observed=false;
      for(let i=0;i<100;i++){
        observed=(await admin.query<{blocked:boolean}>("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='relaunch72-disposable-media-storage' AND wait_event_type='Lock') AS blocked")).rows[0]!.blocked;
        if(observed)break;await new Promise(resolve=>setTimeout(resolve,10));
      }
      assert.equal(observed,true);
      let editCommitted=false;
      const editing=withTransaction(content,workerContext(a.brand),async(t)=>{
        await t.query("/* fixture.reserve-article-edit */ UPDATE app.seo_blog_articles SET data=jsonb_set(data,'{currentVersionId}',to_jsonb($3::text)) WHERE workspace_id=$1 AND id=$2",[a.brand,a.article,finalVersion]);
      }).then(()=>{editCommitted=true;});
      await waitForBlockedFixture(admin,'fixture.reserve-article-edit');assert.equal(editCommitted,false);
      await operator.query('COMMIT');
      assert.deepEqual(await pending,{kind:'held',reason:'operator_policy_changed'});
      await editing;assert.equal(editCommitted,true);
      assert.equal((await admin.query('SELECT count(*)::int AS n FROM app.seo_blog_image_attempts WHERE job_id=$1',[waiting.start.jobId])).rows[0].n,0);
      assert.deepEqual(await worker.commitImageAttempt(waiting.start),{kind:'held',reason:'source_changed'});
    }finally{await operator.query('ROLLBACK');operator.release();}

    // Build an honest previous-month history fixture, rather than changing a live attempt's immutable period.
    await configure(admin,{enabled:true,maxConcurrency:100,monthlyMicrousd:1000000});policy=await worker.readImagePolicy();
    const historical=await initialize(a,worker,policy,content),historicalId=randomUUID();
    const oldMonth=(await admin.query<{period:string}>("SELECT (date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC')-interval '1 month')::date::text AS period")).rows[0]!.period;
    await withTransaction(admin,workerContext(a.brand),async(t)=>{
      await t.query(`INSERT INTO app.seo_blog_image_attempts(id,workspace_id,job_id,intent_id,start_nonce,lease_owner,lease_attempt,intent_sha256,request_sha256,source_sha256,visual_sha256,profile_sha256,source_snapshot,sponsor_user_id,model,quality,allowance_period,reserved_microusd,policy_version,policy_sha256,policy_snapshot,outcome,created_at)
        VALUES($1,$2,$3,$4,$5,'media-proof',1,decode($6,'hex'),decode($7,'hex'),decode($8,'hex'),decode($9,'hex'),decode($10,'hex'),$11,$12,'gpt-image-2','medium',$13,1000,$14,decode($15,'hex'),$16,'outcome_unknown',$13::date+interval '1 day')`,
        [historicalId,a.brand,historical.start.jobId,historical.start.intentId,historical.start.nonce,historical.start.intentSha256,historical.start.requestSha256,
          historical.input.source.sourceSha256,historical.input.source.visualSha256,historical.input.source.profileSha256,JSON.stringify(historical.input.source),a.user,oldMonth,policy.version,policy.sha256,JSON.stringify(policy)]);
      await t.query("UPDATE app.seo_blog_jobs SET data=jsonb_set(data,'{payload,image,start}',jsonb_build_object('nonce',$3::text,'attemptId',$4::text)) WHERE workspace_id=$1 AND id=$2",[a.brand,historical.start.jobId,historical.start.nonce,historicalId]);
      await t.query("INSERT INTO app.seo_blog_usage(workspace_id,kind,amount,at,reference) VALUES($1,'images',1,$2::date+interval '1 day',$3)",[a.brand,oldMonth,`seo-image-start:${historicalId}`]);
    });
    const currentReserved=Number((await admin.query("SELECT coalesce(sum(reserved_microusd),0) AS n FROM app.seo_blog_image_attempts WHERE allowance_period=date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC')::date")).rows[0].n);
    await configure(admin,{monthlyMicrousd:currentReserved+1999});policy=await worker.readImagePolicy();
    const costBoundary=await initialize(b,worker,policy,content);
    assert.deepEqual(await worker.commitImageAttempt(costBoundary.start),{kind:'held',reason:'global_cost_reservation'});
    const resumed=await worker.commitImageAttempt({...historical.start,nonce:randomUUID()});assert.equal(resumed.kind,'existing_started');
    // Only a trusted operator resolution can release OLD unresolved headroom; the original nonce remains consumed.
    await withTransaction(admin,workerContext(a.brand),async(t)=>{
      await t.query('SET LOCAL ROLE r72_owner');
      await t.query("UPDATE app.seo_blog_image_attempts SET outcome='operator_resolved',operator_resolution=jsonb_build_object('reason','Explicit disposable fixture resolution') WHERE id=$1",[historicalId]);
    });
    const boundaryAdmission=await worker.commitImageAttempt(costBoundary.start);assert.equal(boundaryAdmission.kind,'admitted');
    assert.deepEqual(await worker.commitImageAttempt({...historical.start,nonce:randomUUID()}),{kind:'held',reason:'attempt_resolved'});

    if(boundaryAdmission.kind!=='admitted')throw new Error('Cost boundary fixture did not admit');
    const blobCount=Number((await admin.query('SELECT count(*) AS n FROM app.seo_blog_blobs WHERE workspace_id=$1',[b.brand])).rows[0].n);
    const mismatched=await worker.commitImageAttemptReceipt({workspaceId:b.brand,attemptId:boundaryAdmission.attemptId,nonce:boundaryAdmission.nonce,
      requestSha256:costBoundary.start.requestSha256,leaseOwner:'media-proof',leaseAttempt:1,observedCandidateSha256:sha(jpeg),
      receipt:{...unknown,code:'invalid_response',requestSha256:sha('different-wire-request')}});
    assert.equal(mismatched.candidate,null);assert.equal(mismatched.applyEligible,false);assert.equal(mismatched.hold,'request_identity_mismatch');
    assert.equal(Number((await admin.query('SELECT count(*) AS n FROM app.seo_blog_blobs WHERE workspace_id=$1',[b.brand])).rows[0].n),blobCount);
    const mismatchEvidence=(await admin.query("SELECT outcome,encode(request_sha256,'hex') AS reserved,receipts->0->>'candidateSha256' AS observed,receipts->0#>>'{receipt,requestSha256}' AS actual FROM app.seo_blog_image_attempts WHERE id=$1",[boundaryAdmission.attemptId])).rows[0];
    assert.equal(mismatchEvidence.outcome,'outcome_unknown');assert.equal(mismatchEvidence.reserved,costBoundary.start.requestSha256);assert.equal(mismatchEvidence.actual,sha('different-wire-request'));assert.equal(mismatchEvidence.observed,sha(jpeg));

    await configure(admin,{monthlyMicrousd:1000000});policy=await worker.readImagePolicy();
    const policyLate=await initialize(b,worker,policy,content);const policyAdmission=await worker.commitImageAttempt(policyLate.start);
    assert.equal(policyAdmission.kind,'admitted');if(policyAdmission.kind!=='admitted')throw new Error('Policy late fixture did not start');
    await configure(admin,{enabled:false});
    const policySaved=await worker.commitImageAttemptReceipt({workspaceId:b.brand,attemptId:policyAdmission.attemptId,nonce:policyAdmission.nonce,
      requestSha256:policyLate.start.requestSha256,leaseOwner:'media-proof',leaseAttempt:1,receipt:{...success,requestSha256:policyLate.start.requestSha256},
      candidate:{bytes:jpeg,provenance:{kind:'generated',brandSha256:policyLate.input.source.profileSha256,sourceName:'Policy-held fixture candidate',
        generation:{intentId:policyLate.start.intentId,nonce:policyAdmission.nonce,requestSha256:policyLate.start.requestSha256}}}});
    assert.ok(policySaved.candidate);assert.equal(policySaved.applyEligible,false);assert.equal(policySaved.hold,'operator_policy_disabled');

    await configure(admin,{enabled:true});policy=await worker.readImagePolicy();
    const applyFixture=await initialize(b,worker,policy,content);const applyAdmission=await worker.commitImageAttempt(applyFixture.start);
    assert.equal(applyFixture.input.confirmedNewIntent,true);assert.equal(applyFixture.input.replacesIntentId,policyLate.start.intentId);
    assert.equal(applyAdmission.kind,'admitted');if(applyAdmission.kind!=='admitted')throw new Error('Private apply fixture did not start');
    const applyReceipt=await worker.commitImageAttemptReceipt({workspaceId:b.brand,attemptId:applyAdmission.attemptId,nonce:applyAdmission.nonce,
      requestSha256:applyFixture.start.requestSha256,leaseOwner:'media-proof',leaseAttempt:1,receipt:{...success,requestSha256:applyFixture.start.requestSha256},
      candidate:{bytes:jpeg,provenance:{kind:'generated',brandSha256:applyFixture.input.source.profileSha256,sourceName:'Private apply candidate',
        generation:{intentId:applyFixture.start.intentId,nonce:applyAdmission.nonce,requestSha256:applyFixture.start.requestSha256}}}});
    assert.ok(applyReceipt.candidate);assert.equal(applyReceipt.applyEligible,true);
    const applyCandidate=applyReceipt.candidate!;
    const prepared=await worker.commitPreparation(b.brand,{commandId:randomUUID(),sourceAssetId:applyCandidate.id,sourceSha256:applyCandidate.sha256,outcome:'prepared',sourceDimensions:{width:1536,height:1024},variants:[{bytes:jpeg,recipe:recipe(applyCandidate.sha256)}],detail:null});
    const applyInput={workspaceId:b.brand,attemptId:applyAdmission.attemptId,nonce:applyAdmission.nonce,leaseOwner:'media-proof',leaseAttempt:1,
      candidateAssetId:applyCandidate.id,candidateSha256:applyCandidate.sha256,variants:prepared.variants.map(v=>({assetId:v.id,sha256:v.sha256,profile:v.recipe!.profile}))};
    let callbacks=0;
    assert.deepEqual(await worker.applyPreparedImageBoundary({...applyInput,leaseAttempt:2},async()=>{callbacks++;}),{applied:false,hold:'claim_changed'});
    assert.deepEqual(await worker.applyPreparedImageBoundary({...applyInput,variants:[{...applyInput.variants[0]!,sha256:sha('wrong-variant')}]},async()=>{callbacks++;}),{applied:false,hold:'candidate_integrity'});
    assert.equal(callbacks,0);
    const applyCallback=async(t:DbTransaction,snapshot:{job:Job;preparation:SeoImageVerifiedPreparation})=>{
      callbacks++;assert.equal(snapshot.job.id,applyFixture.start.jobId);assert.equal(snapshot.preparation.candidate.id,applyCandidate.id);
      const variant=snapshot.preparation.variants[0]!;
      await t.query("UPDATE app.seo_blog_articles SET data=jsonb_set(data,'{media}',jsonb_build_object('fixtureOnly',true,'assetId',$3::text)) WHERE workspace_id=$1 AND id=$2",[b.brand,b.article,variant.id]);
      await t.query("UPDATE app.seo_blog_jobs SET state='done',data=data||jsonb_build_object('state','done','progress','Private proposal stored') WHERE workspace_id=$1 AND id=$2",[b.brand,snapshot.job.id]);
      return variant.id;
    };
    await assert.rejects(worker.applyPreparedImageBoundary(applyInput,async(t,s)=>{await applyCallback(t,s);throw new Error('rollback-private-apply');}),/rollback-private-apply/);
    assert.equal((await admin.query('SELECT state FROM app.seo_blog_jobs WHERE id=$1',[applyFixture.start.jobId])).rows[0].state,'running');
    assert.equal((await admin.query("SELECT data->'media' AS media FROM app.seo_blog_articles WHERE workspace_id=$1 AND id=$2",[b.brand,b.article])).rows[0].media,null);
    let enterApply!:()=>void,releaseApply!:()=>void;
    const applyEntered=new Promise<void>(r=>{enterApply=r;}),applyGate=new Promise<void>(r=>{releaseApply=r;});
    const applying=worker.applyPreparedImageBoundary(applyInput,async(t,snapshot)=>{enterApply();await applyGate;return applyCallback(t,snapshot);});
    await Promise.race([applyEntered,applying.then(()=>{throw new Error('Apply callback was held before the lock fixture entered');})]);let editAfterApply=false;
    const editor=withTransaction(content,workerContext(b.brand),(t)=>t.query("/* fixture.apply-article-edit */ UPDATE app.seo_blog_articles SET data=jsonb_set(data,'{fixtureEditWon}','true') WHERE workspace_id=$1 AND id=$2",[b.brand,b.article])).then(()=>{editAfterApply=true;});
    try{await waitForBlockedFixture(admin,'fixture.apply-article-edit');assert.equal(editAfterApply,false);}finally{releaseApply();}
    const applied=await applying;assert.equal(applied.applied,true);await editor;assert.equal(editAfterApply,true);
    assert.equal((await admin.query('SELECT state FROM app.seo_blog_jobs WHERE id=$1',[applyFixture.start.jobId])).rows[0].state,'done');
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM app.seo_blog_media_public_releases WHERE workspace_id=$1',[b.brand])).rows[0].n,0);
    const replacementSource=await b.owner.readImageSourceSnapshot(b.brand,b.article);
    const replacement={...applyFixture.input,commandId:randomUUID(),source:replacementSource,jobId:randomUUID(),intentId:randomUUID(),intentSha256:sha(randomUUID()),confirmedNewIntent:true,replacesIntentId:policyLate.start.intentId};
    assert.deepEqual(await b.owner.initializeImageIntent(b.brand,replacement),{kind:'held',reason:'new_intent_confirmation_required',replacesIntentId:applyFixture.start.intentId});
    const acceptedReplacement=await b.owner.initializeImageIntent(b.brand,{...replacement,replacesIntentId:applyFixture.start.intentId,intentSha256:sha(randomUUID())});
    assert.ok('id' in acceptedReplacement);
    const sponsor=await initialize(b,worker,policy,content);
    await admin.query("UPDATE app.workspace_memberships SET status='revoked',revoked_at=clock_timestamp() WHERE workspace_id=$1 AND user_id=$2",[b.brand,b.user]);
    assert.deepEqual(await worker.commitImageAttempt(sponsor.start),{kind:'held',reason:'sponsor_ineligible'});
    await admin.query("UPDATE app.workspace_memberships SET status='active',revoked_at=NULL WHERE workspace_id=$1 AND user_id=$2",[b.brand,b.user]);
    const paused=await initialize(b,worker,policy,content);
    await admin.query("UPDATE app.seo_blog_brands SET settings=jsonb_set(settings,'{pauseAll}','true') WHERE workspace_id=$1",[b.brand]);
    assert.deepEqual(await worker.commitImageAttempt(paused.start),{kind:'held',reason:'programme_paused'});
    await admin.query("UPDATE app.seo_blog_brands SET settings=jsonb_set(settings,'{pauseAll}','false') WHERE workspace_id=$1",[b.brand]);
    const visual=await initialize(b,worker,policy,content);const documentId=randomUUID();
    await admin.query("INSERT INTO app.seo_blog_records(workspace_id,kind,id,data) VALUES($1,'knowledge',$2,$3)",[b.brand,`${documentId}:1`,JSON.stringify({id:documentId,version:1,category:'visual_guidance',sha256:sha('new-visual'),active:true,status:'image_reference',text:null,blobId:null})]);
    assert.deepEqual(await worker.commitImageAttempt(visual.start),{kind:'held',reason:'source_changed'});
    const profile=await initialize(a,worker,policy,content);
    await admin.query("INSERT INTO app.seo_blog_records(workspace_id,kind,id,data) SELECT workspace_id,kind,'00000002',data||jsonb_build_object('version',2,'confirmedAt',NULL) FROM app.seo_blog_records WHERE workspace_id=$1 AND kind='profile' AND id='00000001'",[a.brand]);
    assert.deepEqual(await worker.commitImageAttempt(profile.start),{kind:'held',reason:'source_changed'});
    await campaignQueueJourney(admin,content,adapter,zernio,calendar,worker);
    console.log(JSON.stringify({proof:'010-media-storage-actual-role',postgresVersion:(await admin.query('SHOW server_version')).rows[0].server_version,sessionUser:identity.session_user,defaultDisabled:true,raceAdmitted:1,serializableConflict:'40001',policyWaitHeld:true,oldUnknownCarried:true,incompleteCommitCases:5,lateReceiptRetained:true,providerCalls:0}));
  }finally{await Promise.all([content.end(),adapter.end(),web.end(),zernio.end(),calendar.end()]);await admin.end();}
});

async function campaignQueueJourney(admin:pg.Pool,content:pg.Pool,adapter:pg.Pool,zernio:pg.Pool,calendar:pg.Pool,worker:PgSeoBlogMediaStore){
  const f=await seed(admin,content),foreign=await seed(admin,content);
  await admin.query("UPDATE app.workspaces SET timezone='America/New_York' WHERE id=$1",[f.brand]);
  const context={actorKind:'user' as const,workspaceId:f.brand,userId:f.user,requestId:randomUUID()};
  const make=canonicalService(adapter),approve=canonicalService(content),canonicalUrl=`${origin}/blog/article-${f.article}`;
  const nowIso=()=>new Date().toISOString();
  const proofGolden={id:'11111111-1111-4111-8111-111111111111',variantId:'22222222-2222-4222-8222-222222222222',
    articleVersionId:'33333333-3333-4333-8333-333333333333',articleContentSha:'a'.repeat(64),canonicalUrl:'https://harbour.example/blog/decisions',
    network:'linkedin',angle:'launch',recipe:'r72-social-three-angle-v1',title:'A calm decision — café',
    copy:'A calm "decision" starts with one practical question.\nTake time to check the evidence — café notes included.',
    artworkInstructions:'Calm editorial illustration; no fabricated client or property evidence.',relativeDays:0,media:null,
    createdAt:'2026-11-03T12:00:00.000Z',createdBy:'44444444-4444-4444-8444-444444444444'};
  const canonicalGolden=canonicalCompanyContentJson(proofGolden);
  assert.equal(sha(canonicalGolden),'1cdfe1c2136db8492f264d3200772339d19fa8b31b6a1430965ec7d2ae3cd7e3');
  assert.equal((await admin.query('SELECT app_private.seo_media_campaign_canonical($1::jsonb) AS body',[JSON.stringify(proofGolden)])).rows[0].body,canonicalGolden);
  for(const [anchor,days,expected] of [
    ['2026-03-26T10:20:35.123Z',3,'2026-03-29T10:20:35.123Z'],['2026-10-22T09:20:35.123Z',3,'2026-10-25T11:20:35.123Z'],
    ['2026-10-22T00:30:00.000Z',3,'timezone_ambiguous'],['2026-03-26T01:30:00.000Z',3,'timezone_gap'],
    ['2026-10-25T00:30:35.123Z',0,'2026-10-25T01:30:35.123Z'],
  ] as const){
    const result=(await admin.query('SELECT app_private.seo_media_campaign_queue_time($1,$2::jsonb) AS result',[anchor,JSON.stringify({kind:'relative_verified',days,afterMinutes:60,timezone:'Europe/London'})])).rows[0].result;
    if(expected.startsWith('timezone_'))assert.equal(result.reason,expected);else assert.equal(new Date(result.atUtc).toISOString(),expected);
  }
  // Marker-only JPEGs exercise storage/provenance, not the separately required actual codec/uploader acceptance.
  const candidate=await f.owner.persistCandidateReceipt(f.brand,{commandId:randomUUID(),bytes:jpeg,
    provenance:{kind:'uploaded',brandSha256:sha('campaign-brand'),sourceName:'Storage-only campaign fixture'},receipt:{outcome:'uploaded',code:'uploaded'}});
  const prepared=await worker.commitPreparation(f.brand,{commandId:randomUUID(),sourceAssetId:candidate.id,sourceSha256:candidate.sha256,outcome:'prepared',
    sourceDimensions:{width:1536,height:1920},detail:null,variants:[{bytes:jpeg,recipe:{...recipe(candidate.sha256),profile:'instagram',width:1080,height:1350,crop:{x:0,y:0,width:1536,height:1920}}}]});
  const asset=prepared.variants[0]!,alt='An owner reviewed private editorial illustration';
  const manifest=await f.owner.getAssetCanonicalManifest(f.brand,{assetId:asset.id,assetSha256:asset.sha256,profile:'instagram',alt});
  assert.equal('slot' in manifest.presentation,false,'Generic quality review is not a pretend blog hero use');
  const quality=await make.createVersion(context,{commandKey:randomUUID(),origin:'imported',kind:'image',title:'Campaign quality',contentMimeType:'application/json',content:JSON.stringify(manifest),
    source:{system:'relaunch72.seo-media',itemId:asset.id,version:canonicalImageSourceVersion(manifest)},blob:{storageKey:`seo-blog-media/${asset.id}/${asset.sha256}`,sha256:asset.sha256},
    brand:{snapshotRef:'campaign-quality',sha256:manifest.provenance.brandSha256},attestation:{catalogSha256:sha(JSON.stringify(manifest)),checkedAt:nowIso(),expiresAt:new Date(Date.now()+600000).toISOString()}});
  const qr=await approve.requestApproval(context,{commandKey:randomUUID(),contentItemId:quality.contentItemId,contentVersionId:quality.contentVersionId});
  const qd=await approve.decideApproval(context,{commandKey:randomUUID(),approvalRequestId:qr.approvalRequestId,decision:'approved'});
  const canonical:SeoMediaCanonicalApproval={contentItemId:quality.contentItemId,contentVersionId:quality.contentVersionId,contentSha256:quality.contentSha256,approvalRequestId:qr.approvalRequestId,approvalDecisionId:qd.approvalDecisionId};
  const rejectedManifest={...manifest,presentation:{...manifest.presentation,alt:'A rejected later presentation'}};
  const newer=await make.createVersion(context,{commandKey:randomUUID(),contentItemId:quality.contentItemId,previousVersionId:quality.contentVersionId,origin:'edited',kind:'image',title:'Rejected later quality',contentMimeType:'application/json',content:JSON.stringify(rejectedManifest),
    source:{system:'relaunch72.seo-media',itemId:asset.id,version:canonicalImageSourceVersion(rejectedManifest)},blob:{storageKey:`seo-blog-media/${asset.id}/${asset.sha256}`,sha256:asset.sha256},
    brand:{snapshotRef:'campaign-quality',sha256:manifest.provenance.brandSha256},attestation:{catalogSha256:sha(JSON.stringify(rejectedManifest)),checkedAt:nowIso(),expiresAt:new Date(Date.now()+600000).toISOString()}});
  const nr=await approve.requestApproval(context,{commandKey:randomUUID(),contentItemId:newer.contentItemId,contentVersionId:newer.contentVersionId});
  await approve.decideApproval(context,{commandKey:randomUUID(),approvalRequestId:nr.approvalRequestId,decision:'rejected',decisionNote:'Reject the newer presentation; retain the separately approved historical image.'});
  const variants=([['instagram','launch',0],['instagram','takeaway',3],['instagram','follow_up',7],['linkedin','launch',0]] as const).map(([network,angle,days])=>{
    const id=randomUUID(),revision={id:randomUUID(),variantId:id,articleVersionId:f.version,articleContentSha:sha('article'),canonicalUrl,network,angle,
      recipe:'r72-social-three-angle-v1',title:`${angle} — café`,copy:`Practical ${angle} notes.`,artworkInstructions:'A private editorial concept.',relativeDays:days,
      media:network==='instagram'?{useId:randomUUID(),assetId:asset.id,assetSha256:asset.sha256,profile:network,alt,canonical}:null,createdAt:nowIso(),createdBy:f.user};
    const sealed={...revision,sha256:sha(canonicalCompanyContentJson(revision))};
    return{id,network,angle,currentRevisionId:sealed.id,revisions:[sealed],omitted:false,pinnedSchedule:null};
  });
  const campaign={schema:'relaunch72.seo-campaign/v1',articleVersionId:f.version,articleContentSha:sha('article'),variants};
  await admin.query("UPDATE app.seo_blog_articles SET data=data||jsonb_build_object('campaign',$3::jsonb,'delivery','none','publishedVersionId',NULL,'publishedUrl',NULL) WHERE workspace_id=$1 AND id=$2",[f.brand,f.article,JSON.stringify(campaign)]);
  const imageUse=(variant:typeof variants[number])=>({commandId:randomUUID(),useId:variant.revisions[0]!.media!.useId,articleId:f.article,articleVersionId:f.version,articleContentSha:sha('article'),
    variantId:variant.id,variantRevisionId:variant.currentRevisionId,variantSha256:variant.revisions[0]!.sha256,network:'instagram' as const,assetId:asset.id,assetSha256:asset.sha256,profile:'instagram' as const,alt,canonical});
  await assert.rejects(worker.recordOwnerSocialImageAuthorization(f.brand,imageUse(variants[0]!)),{status:403});
  await assert.rejects(foreign.owner.recordOwnerSocialImageAuthorization(foreign.brand,imageUse(variants[0]!)));
  await assert.rejects(f.owner.reserveMediaUse(f.brand,{commandId:randomUUID(),articleId:f.article,assetId:asset.id,assetSha256:asset.sha256,presentation:{profile:'blog',slot:'hero',alt}}));
  for(const variant of variants.filter(v=>v.network==='instagram')){
    const use=await f.owner.recordOwnerSocialImageAuthorization(f.brand,imageUse(variant));assert.equal(use.useKind,'social_variant');
    const commandId=randomUUID(),observed=await f.owner.refreshSocialImageAttestation(f.brand,{useId:use.id,commandId});
    assert.deepEqual(await f.owner.refreshSocialImageAttestation(f.brand,{useId:use.id,commandId}),observed);
  }
  assert.equal((await admin.query('SELECT count(*)::int n FROM app.seo_blog_media_public_releases WHERE workspace_id=$1',[f.brand])).rows[0].n,0);
  const identity={sessionToken:f.token,userId:f.user,workspaceId:f.home,userEmail:'campaign-owner@example.test'};
  const registry=createPgSeoBlogSocialRegistry({zernioPool:zernio,contentCommandPool:content,contentAdapterPool:adapter,identity,requestId:randomUUID(),zernioApiKey:null,reservedProfileIds:[]});
  const profileId=`campaign_${randomUUID().slice(0,8)}`;await registry.registerProfile(f.brand,'Campaign proof',profileId);
  const webhooks=createSeoBlogZernioWebhookBrands(zernio),webhook=(await webhooks.resolve(profileId))!;
  const bindingIds=new Map<string,string>();
  for(const [network,account] of [['instagram','d'.repeat(24)],['linkedin','e'.repeat(24)]] as const){
    const eventId=randomUUID();assert.equal((await webhooks.record({contract:ZERNIO_ACCOUNT_WEBHOOK_CONTRACT_VERSION,workspaceId:f.brand,connectionId:webhook.connectionId,eventId,event:'account.connected',network,
      occurredAt:nowIso(),providerProfileIdSha256:sha(profileId),providerAccountIdSha256:sha(account),rawBodySha256:sha(`raw${eventId}`),receiptSha256:sha(`receipt${eventId}`),providerEffects:'none'},webhook)).ok,true);
    bindingIds.set(network,(await registry.registerBinding(f.brand,{network,providerAccountId:account,dailyCap:5,monthlyCap:20})).bindingId);
  }
  const posts:Awaited<ReturnType<CompanyContentService['createVersion']>>[]=[],inputs:SeoCampaignQueueInput[]=[];
  const expiresAt=Date.now()+30_000;const slot=new Date(Date.now()+60_000).toISOString();
  for(const variant of variants){
    const revision=variant.revisions[0]!;
    const envelope={schema:'propertypredator.company-content/v1',type:'seo_campaign',kind:'article_promotion',platform:variant.network,title:revision.title,
      body:`${revision.copy}\n\n${canonicalUrl}`,artwork_instructions:revision.artworkInstructions,cta_url:canonicalUrl,contextSha256:revision.sha256,
      ...(revision.media?{image:{mimeType:'image/jpeg',base64:jpeg.toString('base64'),sha256:asset.sha256,width:1080,height:1350,alt}}:{})};
    const body=canonicalCompanyContentJson(envelope);
    const post=await make.createVersion(context,{commandKey:randomUUID(),origin:'imported',kind:'social_post',title:revision.title,contentMimeType:'application/vnd.propertypredator.company-content+json',content:body,
      source:{system:'relaunch72.seo-blog',itemId:`${f.brand}:${f.article}:${variant.network}:${variant.id}`,version:`campaign:v1:${f.version}:${revision.id}:${revision.sha256}`},
      blob:{storageKey:`campaign/${revision.id}`,sha256:sha(body)},brand:{snapshotRef:'campaign-proof',sha256:sha('campaign-brand')},
      metadata:{source:'relaunch72.seo-blog',campaignSchema:campaign.schema,brandId:f.brand,articleId:f.article,articleVersionId:f.version,articleContentSha:sha('article'),canonicalUrl,network:variant.network,
        variantId:variant.id,variantRevisionId:revision.id,variantSha256:revision.sha256,...(revision.media?{mediaUseId:revision.media.useId,mediaAssetId:asset.id,mediaSha256:asset.sha256}:{})},
      attestation:{catalogSha256:sha(`owner-observation:${revision.id}`),checkedAt:nowIso(),expiresAt:new Date(expiresAt).toISOString()}});
    const request=await approve.requestApproval(context,{commandKey:randomUUID(),contentItemId:post.contentItemId,contentVersionId:post.contentVersionId});
    await approve.decideApproval(context,{commandKey:randomUUID(),approvalRequestId:request.approvalRequestId,decision:'approved'});posts.push(post);
    const input:SeoCampaignQueueInput={commandId:randomUUID(),articleId:f.article,articleVersionId:f.version,articleContentSha:sha('article'),variantId:variant.id,variantRevisionId:revision.id,
      variantSha256:revision.sha256,contentVersionId:post.contentVersionId,bindingId:bindingIds.get(variant.network)!,dateRule:variant.network==='linkedin'
        ?{kind:'relative_verified',days:0,afterMinutes:60,timezone:'America/New_York'}:{kind:'pinned',atUtc:slot,timezone:'America/New_York'}};
    if(!inputs.some(i=>bindingIds.get(variant.network)===i.bindingId)){
      await assert.rejects(f.owner.recordOwnerCampaignQueue(f.brand,input),{code:'P0136'});
      await withTransaction(zernio,context,async(t)=>{assert.equal((await t.query('SELECT app_private.lock_active_portal_session($1,$2,$3) ok',[Buffer.from(sha(f.token),'hex'),f.user,f.home])).rows[0].ok,true);
        await t.query('SELECT app_private.bootstrap_zernio_calendar_planner_target($1,$2,$3,$4,$5)',[f.brand,webhook.connectionId,variant.network,Buffer.from(sha(profileId),'hex'),Buffer.from(sha(variant.network==='instagram'?'d'.repeat(24):'e'.repeat(24)),'hex')]);},{isolation:'serializable'});
    }
    const instruction=await f.owner.recordOwnerCampaignQueue(f.brand,input);assert.equal(instruction.authorizingUserId,f.user);
    assert.deepEqual(await f.owner.recordOwnerCampaignQueue(f.brand,input),instruction);inputs.push(input);
    if(inputs.length===1){
      await admin.query("UPDATE app.workspaces SET timezone='UTC' WHERE id=$1",[f.brand]);
      assert.deepEqual(await f.owner.recordOwnerCampaignQueue(f.brand,input),instruction,'Known owner receipt precedes changed canonical timezone');
      await admin.query("UPDATE app.workspaces SET timezone='America/New_York' WHERE id=$1",[f.brand]);
    }
    assert.equal((await worker.materializeCampaignQueue(f.brand,input.commandId)).kind,'held','Draft owner approval must not enqueue');
  }
  assert.equal((await admin.query('SELECT count(*)::int n FROM app.property_predator_owned_social_jobs WHERE workspace_id=$1',[f.brand])).rows[0].n,0);
  assert.deepEqual(await worker.listPendingCampaignQueues(f.brand),[],'Recovery discovery skips drafts');
  assert.equal((await f.owner.recordOwnerCampaignQueue(f.brand,inputs[0]!,async(t)=>{
    assert.ok((await f.owner.listPendingCampaignQueuesOnTransaction(t,f.brand,f.article)).includes(inputs[0]!.commandId));
  })).queueIntentId,inputs[0]!.commandId);
  await admin.query('UPDATE app.user_sessions SET expires_at=clock_timestamp()-interval \'1 second\' WHERE token_hash=$1',[Buffer.from(sha(f.token),'hex')]);
  // Expire the real initial POST observations. Worker lineage is retained without forging owner-observed-now evidence.
  await new Promise(resolve=>setTimeout(resolve,Math.max(0,expiresAt-Date.now()+50)));
  const publication=randomUUID(),verifiedAt=nowIso();
  await admin.query("INSERT INTO app.seo_blog_publications(workspace_id,id,article_id,version_id,idempotency_key,state,data) VALUES($1,$2,$3,$4,$5,'published',$6)",
    [f.brand,publication,f.article,f.version,`campaign-parent:${publication}`,JSON.stringify({id:publication,articleId:f.article,versionId:f.version,contentSha:sha('article'),publicUrl:canonicalUrl,verifiedAt,policy:{rule:'auto_unflagged',autoPublish:true,requiresApproval:false}})]);
  await admin.query("UPDATE app.seo_blog_articles SET data=data||jsonb_build_object('delivery','published','publishedVersionId',$3::text,'publishedUrl',$4::text) WHERE workspace_id=$1 AND id=$2",[f.brand,f.article,f.version,canonicalUrl]);
  assert.ok((await worker.listCampaignQueueWorkspaces()).includes(f.brand));
  assert.equal((await worker.listPendingCampaignQueues(f.brand)).length,3,'Legacy unknown first-verification time cannot become a relative anchor');
  assert.deepEqual(await worker.materializeCampaignQueue(f.brand,inputs[3]!.commandId),{kind:'held',reason:'stable_first_verification_anchor_required_choose_owner_pin'});
  const race=await Promise.allSettled([worker.materializeCampaignQueue(f.brand,inputs[0]!.commandId),worker.materializeCampaignQueue(f.brand,inputs[0]!.commandId)]);
  assert.ok(race.some(r=>r.status==='fulfilled'&&r.value.kind==='materialized'));
  for(const r of race)if(r.status==='rejected')assert.equal(r.reason.code,'40001');
  const receipts:Extract<SeoCampaignQueueResult,{kind:'materialized'}>[]=[];
  for(let i=0;i<inputs.length;i++){let input=inputs[i]!;
    if(i===3){
      await admin.query("UPDATE app.user_sessions SET expires_at=clock_timestamp()+interval '1 hour' WHERE token_hash=$1",[Buffer.from(sha(f.token),'hex')]);
      const revision=variants[3]!.revisions[0]!,post=posts[3]!;
      await make.refreshSourceAttestation(context,{commandKey:randomUUID(),contentItemId:post.contentItemId,contentVersionId:post.contentVersionId,
        expected:{source:{system:'relaunch72.seo-blog',itemId:`${f.brand}:${f.article}:linkedin:${revision.variantId}`,version:`campaign:v1:${f.version}:${revision.id}:${revision.sha256}`},contentSha256:post.contentSha256,blobSha256:post.contentSha256,brandSha256:sha('campaign-brand')},
        attestation:{catalogSha256:sha('new-genuine-owner-observation'),checkedAt:nowIso(),expiresAt:new Date(Date.now()+600000).toISOString()}});
      input={...input,commandId:randomUUID(),dateRule:{kind:'pinned',atUtc:slot,timezone:'America/New_York'}};
      await f.owner.recordOwnerCampaignQueue(f.brand,input);inputs[i]=input;
    }
    const receipt=await worker.materializeCampaignQueue(f.brand,input.commandId);if(receipt.kind!=='materialized')throw new Error(receipt.reason);receipts.push(receipt);
    assert.equal(receipt.anchorKind,'legacy_pinned_observation');
    assert.deepEqual(await worker.materializeCampaignQueue(f.brand,input.commandId),receipt);}
  assert.equal((await admin.query('SELECT count(*)::int n FROM app.property_predator_owned_social_jobs WHERE workspace_id=$1',[f.brand])).rows[0].n,4);
  assert.equal((await admin.query("SELECT count(DISTINCT content_version_id)::int n FROM app.property_predator_owned_social_jobs WHERE workspace_id=$1 AND network='instagram'",[f.brand])).rows[0].n,3);
  assert.equal((await admin.query('SELECT count(*)::int n FROM app.property_predator_owned_social_job_media WHERE workspace_id=$1',[f.brand])).rows[0].n,3);
  const job=(await admin.query('SELECT * FROM app.property_predator_owned_social_jobs WHERE workspace_id=$1 AND id=$2',[f.brand,receipts[0]!.jobId])).rows[0];
  assert.equal(job.text_body,`${variants[0]!.revisions[0]!.copy}\n\n${canonicalUrl}`);assert.equal(job.content_sha256.toString('hex'),posts[0]!.contentSha256);assert.equal(job.text_sha256.toString('hex'),sha(job.text_body));
  await admin.query("UPDATE app.seo_blog_brands SET settings=jsonb_set(settings,'{pauseAll}','true') WHERE workspace_id=$1",[f.brand]);
  await withTransaction(content,workerContext(f.brand),(t)=>t.query('SELECT * FROM app_private.seo_blog_attest_due_promotions($1)',[f.brand]));
  assert.equal((await admin.query('SELECT max(attempt_count)::int n FROM app.public_social_revalidation_jobs WHERE workspace_id=$1',[f.brand])).rows[0].n,0);
  await admin.query("UPDATE app.seo_blog_brands SET settings=jsonb_set(settings,'{pauseAll}','false') WHERE workspace_id=$1",[f.brand]);
  await withTransaction(content,workerContext(f.brand),async(t)=>{const who=(await t.query("SELECT session_user,current_user,current_setting('app.actor_kind') actor,current_setting('app.user_id') actor_user")).rows[0];
    assert.deepEqual(who,{session_user:'r72_content_command',current_user:'r72_content_command',actor:'worker',actor_user:''});
    assert.equal((await t.query('SELECT * FROM app_private.seo_blog_attest_due_promotions($1)',[f.brand])).rows.length,4);});
  assert.equal((await admin.query('SELECT count(*)::int n FROM app.public_social_revalidation_proof_media WHERE workspace_id=$1',[f.brand])).rows[0].n,3);
  assert.equal((await admin.query("SELECT has_function_privilege('r72_owned_social_worker_command','app_private.zernio_calendar_job_effect_ready(uuid,uuid)','EXECUTE') ok")).rows[0].ok,false);
  // Auxiliary source/control assertions use the existing PUBLIC begin capability, never private EXECUTE or a new wrapper.
  // The synthetic lease is a disposable fixture, not evidence that the production claim function selected a job.
  const sourceEligibilityViaPublicBeginProbe=async(id:string):Promise<boolean>=>{
    const timing=(await admin.query("SELECT utc_day::text day,scheduled_for,(clock_timestamp() AT TIME ZONE 'UTC')::date::text today FROM app.property_predator_owned_social_jobs WHERE workspace_id=$1 AND id=$2",[f.brand,id])).rows[0];
    assert.ok(timing);
    if(timing.day!==timing.today){
      const wait=Math.max(0,new Date(timing.scheduled_for).getTime()-Date.now()+25);assert.ok(wait<=65000,'Use an isolated near-due fixture; never rewrite its UTC day');
      await new Promise(resolve=>setTimeout(resolve,wait));
      assert.equal((await admin.query("SELECT (clock_timestamp() AT TIME ZONE 'UTC')::date::text today")).rows[0].today,timing.day);
    }
    const setup=await admin.connect(),token=Buffer.from(sha(randomUUID()),'hex');let saved:pg.QueryResultRow|undefined;let version=0,open=false,seeded=false;
    try{
      await setup.query('BEGIN');open=true;
      saved=(await setup.query('SELECT state,lease_version,lease_attempt_kind,lease_expires_at,calling_at,provider_external_id FROM app.property_predator_owned_social_jobs WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[f.brand,id])).rows[0];
      assert.ok(saved);assert.equal(saved.state,'queued','Never resurrect terminal, unknown or already-begun operations for a source probe');assert.equal(saved.calling_at,null);assert.equal(saved.provider_external_id,null);
      assert.equal((await setup.query('SELECT count(*)::int n FROM app.property_predator_owned_social_job_leases WHERE workspace_id=$1 AND job_id=$2',[f.brand,id])).rows[0].n,0);
      assert.equal((await setup.query('SELECT count(*)::int n FROM app.property_predator_owned_social_receipts WHERE workspace_id=$1 AND job_id=$2',[f.brand,id])).rows[0].n,0);
      version=Number(saved.lease_version)+1;
      await setup.query("UPDATE app.property_predator_owned_social_jobs SET state='leased',lease_version=$3,lease_attempt_kind='publish',lease_expires_at=clock_timestamp()+interval '90 seconds' WHERE workspace_id=$1 AND id=$2",[f.brand,id,version]);
      await setup.query('INSERT INTO app.property_predator_owned_social_job_leases(workspace_id,job_id,lease_version,lease_token_sha256) VALUES($1,$2,$3,$4)',[f.brand,id,version,Buffer.from(sha(token),'hex')]);
      await setup.query('COMMIT');open=false;seeded=true;
      const sentinel=new Error('rollback-source-eligibility-probe'),observed={reached:false,value:false};
      try{await withTransaction(calendar,workerContext(f.brand),async(t)=>{
        assert.deepEqual((await t.query("SELECT session_user,current_user,current_setting('app.actor_kind') actor,current_setting('app.user_id') actor_user")).rows[0],
          {session_user:'r72_owned_social_worker_command',current_user:'r72_owned_social_worker_command',actor:'worker',actor_user:''});
        observed.value=(await t.query('SELECT app_private.begin_zernio_calendar_call($1,$2,$3,$4,true,false) ok',[f.brand,id,version,token])).rows[0].ok;
        observed.reached=true;throw sentinel; // Even a true decision MUST NOT commit calling state or call a provider.
      });}catch(error){if(error!==sentinel)throw error;}
      assert.equal(observed.reached,true);return observed.value;
    }finally{
      try{
        if(open){await setup.query('ROLLBACK');open=false;}
        if(seeded){
          await setup.query('BEGIN');open=true;
          const current=(await setup.query('SELECT state,lease_version,calling_at FROM app.property_predator_owned_social_jobs WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[f.brand,id])).rows[0];
          assert.equal(current.state,'leased');assert.equal(Number(current.lease_version),version);assert.equal(current.calling_at,null);
          assert.equal((await setup.query('SELECT count(*)::int n FROM app.property_predator_owned_social_receipts WHERE workspace_id=$1 AND job_id=$2',[f.brand,id])).rows[0].n,0);
          assert.equal((await setup.query('DELETE FROM app.property_predator_owned_social_job_leases WHERE workspace_id=$1 AND job_id=$2 AND lease_version=$3 AND lease_token_sha256=$4',[f.brand,id,version,Buffer.from(sha(token),'hex')])).rowCount,1);
          await setup.query('UPDATE app.property_predator_owned_social_jobs SET state=$3,lease_version=$4,lease_attempt_kind=$5,lease_expires_at=$6 WHERE workspace_id=$1 AND id=$2',
            [f.brand,id,saved!.state,saved!.lease_version,saved!.lease_attempt_kind,saved!.lease_expires_at]);
          await setup.query('COMMIT');open=false;
        }
      }finally{if(open)await setup.query('ROLLBACK');setup.release();}
    }
  };
  for(const receipt of receipts)assert.equal(await sourceEligibilityViaPublicBeginProbe(receipt.jobId),true,'Current approved old quality is allowed only through this fresh exact use');
  await admin.query("UPDATE app.seo_blog_publications SET data=jsonb_set(data,'{verifiedAt}',to_jsonb(clock_timestamp())) WHERE workspace_id=$1 AND id=$2",[f.brand,publication]);
  for(const [i,receipt] of receipts.entries()){
    assert.deepEqual(await worker.materializeCampaignQueue(f.brand,inputs[i]!.commandId),receipt,'Read-only verification refresh retains original job/date/anchor');
    assert.equal(await sourceEligibilityViaPublicBeginProbe(receipt.jobId),true);
  }
  // The actual final provider boundary is exercised without invoking a transport. No image upload or send occurs.
  await new Promise(resolve=>setTimeout(resolve,Math.max(0,new Date(slot).getTime()-Date.now()+20)));
  const leaseToken=Buffer.from(sha(randomUUID()),'hex');
  const claimed=await withTransaction(calendar,workerContext(f.brand),async(t)=>(await t.query('SELECT * FROM app_private.claim_zernio_calendar_job($1,$2,$3,$4,$5)',[f.brand,webhook.connectionId,['instagram'],leaseToken,90])).rows[0]);
  assert.ok(claimed);assert.equal(claimed.job_id,receipts[0]!.jobId);
  const material=await withTransaction(calendar,workerContext(f.brand),async(t)=>(await t.query('SELECT * FROM app_private.load_zernio_calendar_job($1,$2,$3,$4)',[f.brand,claimed.job_id,claimed.lease_version,leaseToken])).rows[0]);
  assert.equal(material.media.length,1,'The REAL media row must suppress the0102 virtual duplicate');
  assert.equal(material.media[0].mimeType,'image/jpeg');assert.equal(material.media[0].seoCampaign.mediaUseId,variants[0]!.revisions[0]!.media!.useId);
  assert.equal(material.media[0].storageKey,`seo-blog-media/${asset.id}/${asset.sha256}`);assert.equal(material.media[0].inlineImage.base64,jpeg.toString('base64'));
  assert.equal((await admin.query('SELECT content_mime_type FROM app.property_predator_owned_social_job_media WHERE workspace_id=$1 AND job_id=$2',[f.brand,claimed.job_id])).rows[0].content_mime_type,'application/json');
  await admin.query("UPDATE app.seo_blog_brands SET settings=jsonb_set(settings,'{pauseAll}','true') WHERE workspace_id=$1",[f.brand]);
  const begin=()=>withTransaction(calendar,workerContext(f.brand),async(t)=>(await t.query('SELECT app_private.begin_zernio_calendar_call($1,$2,$3,$4,true,false) ok',[f.brand,claimed.job_id,claimed.lease_version,leaseToken])).rows[0].ok as boolean);
  assert.equal(await begin(),false,'Pause after JIT proof must still block atomic begin');
  await admin.query("UPDATE app.seo_blog_brands SET settings=jsonb_set(settings,'{pauseAll}','false') WHERE workspace_id=$1",[f.brand]);
  assert.equal(await begin(),true,'Unpaused eligible operation can begin with its exact real media proof');
  await admin.query("UPDATE app.workspace_memberships SET status='revoked',revoked_at=clock_timestamp() WHERE workspace_id=$1 AND user_id=$2",[f.brand,f.user]);
  assert.equal(await sourceEligibilityViaPublicBeginProbe(receipts[1]!.jobId),false);assert.deepEqual(await worker.materializeCampaignQueue(f.brand,inputs[0]!.commandId),receipts[0]);
  await admin.query("UPDATE app.workspace_memberships SET status='active',revoked_at=NULL WHERE workspace_id=$1 AND user_id=$2",[f.brand,f.user]);
  await admin.query("UPDATE app.user_sessions SET expires_at=clock_timestamp()+interval '1 hour' WHERE token_hash=$1",[Buffer.from(sha(f.token),'hex')]);
  // A stale, never-called needs_attention slot can be superseded without weakening133 or taking job locks under brand locks.
  const oldText=receipts[3]!,oldToken=Buffer.from(sha(randomUUID()),'hex');
  await admin.query("UPDATE app.property_predator_owned_social_jobs SET state='needs_attention',lease_version=1,lease_attempt_kind=NULL,lease_expires_at=NULL WHERE workspace_id=$1 AND id=$2",[f.brand,oldText.jobId]);
  await admin.query('INSERT INTO app.property_predator_owned_social_job_leases(workspace_id,job_id,lease_version,lease_token_sha256) VALUES($1,$2,1,$3)',[f.brand,oldText.jobId,Buffer.from(sha(oldToken),'hex')]);
  const replacementInput:SeoCampaignQueueInput={...inputs[3]!,commandId:randomUUID(),dateRule:{kind:'pinned',atUtc:new Date(Date.now()+60000).toISOString(),timezone:'America/New_York'}};
  await f.owner.recordOwnerCampaignQueue(f.brand,replacementInput);
  let enteredBrand!:()=>void,releaseBrand!:()=>void;
  const brandEntered=new Promise<void>(r=>{enteredBrand=r;}),brandGate=new Promise<void>(r=>{releaseBrand=r;});
  const brandLocker=withTransaction(content,workerContext(f.brand),async(t)=>{await t.query('SELECT workspace_id FROM app.seo_blog_brands WHERE workspace_id=$1 FOR UPDATE',[f.brand]);enteredBrand();await brandGate;});
  await brandEntered;const replacing=worker.materializeCampaignQueue(f.brand,replacementInput.commandId);
  try{await waitForBlockedFixture(admin,'seo_blog_materialize_campaign_queue');
    assert.equal((await admin.query('SELECT state FROM app.property_predator_owned_social_jobs WHERE workspace_id=$1 AND id=$2',[f.brand,oldText.jobId])).rows[0].state,'cancelled','Job-only cleanup committed before waiting on brand');
    assert.equal((await admin.query('SELECT count(*)::int n FROM app.property_predator_owned_social_job_leases WHERE workspace_id=$1 AND job_id=$2',[f.brand,oldText.jobId])).rows[0].n,0);
  }finally{releaseBrand();await brandLocker;}
  const replacementReceipt=await replacing;if(replacementReceipt.kind!=='materialized')throw new Error(replacementReceipt.reason);
  inputs[3]=replacementInput;receipts[3]=replacementReceipt;
  await withTransaction(content,workerContext(f.brand),(t)=>t.query('SELECT * FROM app_private.seo_blog_attest_due_promotions($1)',[f.brand]));
  assert.equal(await sourceEligibilityViaPublicBeginProbe(replacementReceipt.jobId),true);
  assert.equal(await withTransaction(calendar,workerContext(f.brand),async(t)=>(await t.query('SELECT app_private.begin_zernio_calendar_call($1,$2,1,$3,true,false) ok',[f.brand,oldText.jobId,oldToken])).rows[0].ok),false);
  await f.owner.cancelOwnerCampaignQueue(f.brand,{queueIntentId:inputs[0]!.commandId,commandId:randomUUID()});
  await withTransaction(calendar,workerContext(f.brand),(t)=>t.query('SELECT app_private.settle_zernio_calendar_call($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [f.brand,claimed.job_id,claimed.lease_version,leaseToken,'outcome_unknown',null,Buffer.from(sha('disposable-unknown'),'hex'),nowIso(),'fixture_unknown_no_transport']));
  assert.equal(await worker.retireCancelledCampaignJobs(f.brand),0,'An unknown publish outcome cannot free its133slot');
  assert.equal((await admin.query('SELECT state FROM app.property_predator_owned_social_jobs WHERE workspace_id=$1 AND id=$2',[f.brand,claimed.job_id])).rows[0].state,'needs_attention');
  assert.equal((await admin.query('SELECT state FROM app.property_predator_owned_social_jobs WHERE workspace_id=$1 AND id=$2',[f.brand,receipts[0]!.jobId])).rows[0].state,'needs_attention');
  assert.equal(await sourceEligibilityViaPublicBeginProbe(receipts[1]!.jobId),true);
  const editedBase={...variants[1]!.revisions[0]!,id:randomUUID(),copy:'Only this variant was edited.',media:{...variants[1]!.revisions[0]!.media!,useId:randomUUID()}};
  const {sha256:_oldRevisionSha,...editedWithoutSha}=editedBase;const edited={...editedWithoutSha,sha256:sha(canonicalCompanyContentJson(editedWithoutSha))};
  const editedCampaign={...campaign,variants:variants.map((v,i)=>i===1?{...v,currentRevisionId:edited.id,revisions:[...v.revisions,edited]}:v)};
  await admin.query("UPDATE app.seo_blog_articles SET data=jsonb_set(data,'{campaign}',$3) WHERE workspace_id=$1 AND id=$2",[f.brand,f.article,JSON.stringify(editedCampaign)]);
  assert.equal(await sourceEligibilityViaPublicBeginProbe(receipts[1]!.jobId),false);assert.equal(await sourceEligibilityViaPublicBeginProbe(receipts[2]!.jobId),true,'One source edit holds only its exact variant');
  await f.owner.withdrawAssetOrRelease(f.brand,{commandId:randomUUID(),scope:'asset',assetId:asset.id,assetSha256:asset.sha256,reason:'Explicit fixture withdrawal'});
  for(const receipt of receipts.slice(1,3))assert.equal(await sourceEligibilityViaPublicBeginProbe(receipt.jobId),false);
  assert.equal(await sourceEligibilityViaPublicBeginProbe(replacementReceipt.jobId),true,'The replacement active text-only instruction retains its approval');
  // Actual inherited USER plain-SEO admission is exercised separately from the new native queue path.
  const plainText=`A legacy plain SEO promotion.\n\n${canonicalUrl}`,plain=await make.createVersion(context,{commandKey:randomUUID(),origin:'imported',kind:'social_post',title:'Legacy plain SEO',contentMimeType:'text/plain',content:plainText,
    source:{system:'relaunch72.seo-blog',itemId:`${f.brand}:${f.article}:linkedin`,version:'legacy-user-parity-v1'},blob:{storageKey:'legacy-plain-seo',sha256:sha(plainText)},brand:{snapshotRef:'legacy-brand',sha256:sha('legacy-brand')},
    metadata:{source:'relaunch72.seo-blog',brandId:f.brand,articleId:f.article,articleVersionId:f.version,articleContentSha:sha('article'),canonicalUrl,network:'linkedin'},
    attestation:{catalogSha256:sha('legacy-owner-observation'),checkedAt:nowIso(),expiresAt:new Date(Date.now()+600000).toISOString()}});
  const plainRequest=await approve.requestApproval(context,{commandKey:randomUUID(),contentItemId:plain.contentItemId,contentVersionId:plain.contentVersionId});
  const plainDecision=await approve.decideApproval(context,{commandKey:randomUUID(),approvalRequestId:plainRequest.approvalRequestId,decision:'approved'});
  const plainAttestation=(await admin.query('SELECT id FROM app.company_content_source_attestations WHERE workspace_id=$1 AND content_version_id=$2 ORDER BY checked_at DESC LIMIT 1',[f.brand,plain.contentVersionId])).rows[0].id;
  const plainIntent=randomUUID(),plainSlot=new Date(Date.now()+60000).toISOString();
  const plainJob=await withTransaction(zernio,context,async(t)=>{
    assert.equal((await t.query('SELECT app_private.lock_active_portal_session($1,$2,$3) ok',[Buffer.from(sha(f.token),'hex'),f.user,f.home])).rows[0].ok,true);
    const target=(await t.query('SELECT test_target_id FROM app_private.bootstrap_zernio_calendar_planner_target($1,$2,$3,$4,$5)',[f.brand,webhook.connectionId,'linkedin',Buffer.from(sha(profileId),'hex'),Buffer.from(sha('e'.repeat(24)),'hex')])).rows[0].test_target_id;
    await t.query('SELECT * FROM app_private.seo_blog_create_promotion_planning_intent($1,$2,$3,$4,$5)',[f.brand,plainIntent,plain.contentVersionId,plainSlot,[target]]);
    return(await t.query('SELECT * FROM app_private.seo_blog_enqueue_zernio_calendar($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[f.brand,bindingIds.get('linkedin'),plainIntent,target,plain.contentItemId,plain.contentVersionId,plainRequest.approvalRequestId,plainDecision.approvalDecisionId,plainAttestation,`seo-blog:${plainIntent}`,plainSlot])).rows[0];
  },{isolation:'serializable'});
  assert.ok(plainJob.job_id);assert.equal((await admin.query('SELECT text_body FROM app.property_predator_owned_social_jobs WHERE workspace_id=$1 AND id=$2',[f.brand,plainJob.job_id])).rows[0].text_body,plainText);
  const baseMetadata={source:'relaunch72.seo-blog',brandId:f.brand,articleId:f.article,articleVersionId:f.version,articleContentSha:sha('article'),canonicalUrl,network:'linkedin'};
  for(const [label,mime,metadata] of [
    ['wrong_schema','text/plain',{...baseMetadata,campaignSchema:'relaunch72.seo-campaign/v999'}],
    ['null_schema','text/plain',{...baseMetadata,campaignSchema:null}],
    ['combined_without_key','application/vnd.propertypredator.company-content+json',baseMetadata],
  ] as const){
    const body=mime==='text/plain'?plainText:canonicalCompanyContentJson({schema:'propertypredator.company-content/v1',type:'seo_campaign',kind:'article_promotion',platform:'linkedin',title:'Unsupported family',body:plainText,cta_url:canonicalUrl});
    assert.equal((await admin.query('SELECT app_private.seo_media_campaign_family($1,$2,$3::jsonb) family',['relaunch72.seo-blog',mime,JSON.stringify(metadata)])).rows[0].family,true);
    assert.equal((await admin.query('SELECT app_private.seo_media_campaign_family($1,$2,$3::jsonb) family',['property_predator_generation',mime,JSON.stringify(metadata)])).rows[0].family,false,'PP source classification is unchanged');
    const bad=await make.createVersion(context,{commandKey:randomUUID(),origin:'imported',kind:'social_post',title:label,contentMimeType:mime,content:body,
      source:{system:'relaunch72.seo-blog',itemId:`unsupported:${randomUUID()}`,version:'unsupported-family-v1'},blob:{storageKey:`unsupported/${label}`,sha256:sha(body)},
      brand:{snapshotRef:'legacy-brand',sha256:sha('legacy-brand')},metadata,attestation:{catalogSha256:sha(label),checkedAt:nowIso(),expiresAt:new Date(Date.now()+600000).toISOString()}});
    const request=await approve.requestApproval(context,{commandKey:randomUUID(),contentItemId:bad.contentItemId,contentVersionId:bad.contentVersionId});
    const decision=await approve.decideApproval(context,{commandKey:randomUUID(),approvalRequestId:request.approvalRequestId,decision:'approved'});
    const attestation=(await admin.query('SELECT id FROM app.company_content_source_attestations WHERE workspace_id=$1 AND content_version_id=$2',[f.brand,bad.contentVersionId])).rows[0].id;
    await assert.rejects(withTransaction(zernio,context,async(t)=>{
      const target=(await t.query('SELECT test_target_id FROM app_private.bootstrap_zernio_calendar_planner_target($1,$2,$3,$4,$5)',[f.brand,webhook.connectionId,'linkedin',Buffer.from(sha(profileId),'hex'),Buffer.from(sha('e'.repeat(24)),'hex')])).rows[0].test_target_id;
      const intent=randomUUID();await t.query('SELECT * FROM app_private.seo_blog_create_promotion_planning_intent($1,$2,$3,$4,$5)',[f.brand,intent,bad.contentVersionId,plainSlot,[target]]);
      await t.query('SELECT * FROM app_private.seo_blog_enqueue_zernio_calendar($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[f.brand,bindingIds.get('linkedin'),intent,target,bad.contentItemId,bad.contentVersionId,request.approvalRequestId,decision.approvalDecisionId,attestation,`seo-blog:${intent}`,plainSlot]);
    },{isolation:'serializable'}),(error:unknown)=>(error as {code?:string}).code==='42501'&&/genuine-owner queue instruction/.test((error as Error).message));
    assert.equal((await admin.query('SELECT count(*)::int n FROM app.property_predator_owned_social_jobs WHERE workspace_id=$1 AND content_version_id=$2',[f.brand,bad.contentVersionId])).rows[0].n,0);
  }
  // A separate truthful historical fixture has a stable first-verification latch, so relative admission has a real anchor.
  const relativeArticle=randomUUID(),relativeVersion=randomUUID(),relativeVariant=randomUUID(),relativeRevision=randomUUID(),relativePublication=randomUUID();
  const relativeSha=sha('relative-parent'),relativeUrl=`${origin}/blog/relative-${relativeArticle}`,firstVerifiedAt=new Date(Date.now()-59*60000).toISOString();
  const relativeBase={id:relativeRevision,variantId:relativeVariant,articleVersionId:relativeVersion,articleContentSha:relativeSha,canonicalUrl:relativeUrl,network:'linkedin',angle:'launch',
    recipe:'r72-social-three-angle-v1',title:'Stable relative launch',copy:'A separately approved launch.',artworkInstructions:null,relativeDays:0,media:null,createdAt:nowIso(),createdBy:f.user};
  const relativeSealed={...relativeBase,sha256:sha(canonicalCompanyContentJson(relativeBase))};
  await admin.query('INSERT INTO app.seo_blog_articles(workspace_id,id,brief_id,slug,data,created_at) VALUES($1,$2,$3,$4,$5,$6)',[f.brand,relativeArticle,randomUUID(),`relative-${relativeArticle}`,JSON.stringify({id:relativeArticle,brandId:f.brand,currentVersionId:relativeVersion,requiresApproval:false,hold:null,
    delivery:'published',publishedVersionId:relativeVersion,publishedUrl:relativeUrl,campaign:{schema:campaign.schema,articleVersionId:relativeVersion,articleContentSha:relativeSha,
      variants:[{id:relativeVariant,network:'linkedin',angle:'launch',currentRevisionId:relativeRevision,revisions:[relativeSealed],omitted:false,pinnedSchedule:null}]}}),new Date(Date.parse(firstVerifiedAt)-180000).toISOString()]);
  await admin.query('INSERT INTO app.seo_blog_article_versions(workspace_id,id,article_id,number,content_sha256,data,created_at) VALUES($1,$2,$3,1,$4,$5,$6)',[f.brand,relativeVersion,relativeArticle,relativeSha,JSON.stringify({id:relativeVersion,body:{image:null},contentSha:relativeSha,promotionPack:{canonicalUrl:relativeUrl}}),new Date(Date.parse(firstVerifiedAt)-120000).toISOString()]);
  const relativePublished={id:relativePublication,articleId:relativeArticle,versionId:relativeVersion,contentSha:relativeSha,publicUrl:relativeUrl,verifiedAt:nowIso(),firstVerifiedAt,
    policy:{rule:'auto_unflagged',autoPublish:true,requiresApproval:false}};
  await admin.query("INSERT INTO app.seo_blog_publications(workspace_id,id,article_id,version_id,idempotency_key,state,data,created_at) VALUES($1,$2,$3,$4,$5,'published',$6,$7)",
    [f.brand,relativePublication,relativeArticle,relativeVersion,`relative-parent:${relativePublication}`,JSON.stringify(relativePublished),new Date(Date.parse(firstVerifiedAt)-60000).toISOString()]);
  const relativeBody=canonicalCompanyContentJson({schema:'propertypredator.company-content/v1',type:'seo_campaign',kind:'article_promotion',platform:'linkedin',title:relativeSealed.title,
    body:`${relativeSealed.copy}\n\n${relativeUrl}`,artwork_instructions:null,cta_url:relativeUrl,contextSha256:relativeSealed.sha256});
  const relativePost=await make.createVersion(context,{commandKey:randomUUID(),origin:'imported',kind:'social_post',title:relativeSealed.title,contentMimeType:'application/vnd.propertypredator.company-content+json',content:relativeBody,
    source:{system:'relaunch72.seo-blog',itemId:`${f.brand}:${relativeArticle}:linkedin:${relativeVariant}`,version:`campaign:v1:${relativeVersion}:${relativeRevision}:${relativeSealed.sha256}`},
    blob:{storageKey:`relative/${relativeRevision}`,sha256:sha(relativeBody)},brand:{snapshotRef:'relative-brand',sha256:sha('relative-brand')},
    metadata:{source:'relaunch72.seo-blog',campaignSchema:campaign.schema,brandId:f.brand,articleId:relativeArticle,articleVersionId:relativeVersion,articleContentSha:relativeSha,canonicalUrl:relativeUrl,network:'linkedin',variantId:relativeVariant,variantRevisionId:relativeRevision,variantSha256:relativeSealed.sha256},
    attestation:{catalogSha256:sha('relative-source'),checkedAt:nowIso(),expiresAt:new Date(Date.now()+600000).toISOString()}});
  const relativeRequest=await approve.requestApproval(context,{commandKey:randomUUID(),contentItemId:relativePost.contentItemId,contentVersionId:relativePost.contentVersionId});
  await approve.decideApproval(context,{commandKey:randomUUID(),approvalRequestId:relativeRequest.approvalRequestId,decision:'approved'});
  const relativeInput:SeoCampaignQueueInput={commandId:randomUUID(),articleId:relativeArticle,articleVersionId:relativeVersion,articleContentSha:relativeSha,variantId:relativeVariant,variantRevisionId:relativeRevision,
    variantSha256:relativeSealed.sha256,contentVersionId:relativePost.contentVersionId,bindingId:bindingIds.get('linkedin')!,dateRule:{kind:'relative_verified',days:0,afterMinutes:60,timezone:'America/New_York'}};
  await f.owner.recordOwnerCampaignQueue(f.brand,relativeInput);const relativeReceipt=await worker.materializeCampaignQueue(f.brand,relativeInput.commandId);
  if(relativeReceipt.kind!=='materialized')throw new Error(relativeReceipt.reason);
  assert.equal(relativeReceipt.anchorKind,'first_verified');assert.equal(relativeReceipt.anchorPublicationId,relativePublication);
  assert.equal(new Date(relativeReceipt.scheduledFor).toISOString(),new Date(Date.parse(firstVerifiedAt)+3600000).toISOString());
  await withTransaction(content,workerContext(f.brand),(t)=>t.query('SELECT * FROM app_private.seo_blog_attest_due_promotions($1)',[f.brand]));assert.equal(await sourceEligibilityViaPublicBeginProbe(relativeReceipt.jobId),true);
  await admin.query("UPDATE app.seo_blog_publications SET data=jsonb_set(data,'{verifiedAt}',to_jsonb(clock_timestamp())) WHERE workspace_id=$1 AND id=$2",[f.brand,relativePublication]);
  assert.deepEqual(await worker.materializeCampaignQueue(f.brand,relativeInput.commandId),relativeReceipt);assert.equal(await sourceEligibilityViaPublicBeginProbe(relativeReceipt.jobId),true);
  const unknownHistory=randomUUID();
  await admin.query("INSERT INTO app.seo_blog_publications(workspace_id,id,article_id,version_id,idempotency_key,state,data) VALUES($1,$2,$3,$4,$5,'published',$6)",
    [f.brand,unknownHistory,relativeArticle,relativeVersion,`legacy-mixed:${unknownHistory}`,JSON.stringify({...relativePublished,id:unknownHistory,firstVerifiedAt:null,verifiedAt:nowIso()})]);
  assert.deepEqual(await worker.materializeCampaignQueue(f.brand,relativeInput.commandId),relativeReceipt);assert.equal(await sourceEligibilityViaPublicBeginProbe(relativeReceipt.jobId),true,'Additional historical operations do not change an already materialized anchor');
  await admin.query("UPDATE app.seo_blog_publications SET data=jsonb_set(data,'{policy}','null'::jsonb) WHERE workspace_id=$1 AND id=$2",[f.brand,relativePublication]);
  assert.equal(await sourceEligibilityViaPublicBeginProbe(relativeReceipt.jobId),false,'Another valid exact-tuple operation cannot conceal NULL policy on the chosen receipt anchor');
  assert.deepEqual(await worker.materializeCampaignQueue(f.brand,relativeInput.commandId),relativeReceipt,'Historical receipt remains available without fresh effect permission');
  await admin.query("UPDATE app.seo_blog_publications SET data=jsonb_set(data,'{policy}',$3::jsonb) WHERE workspace_id=$1 AND id=$2",[f.brand,relativePublication,JSON.stringify(relativePublished.policy)]);
  assert.equal(await sourceEligibilityViaPublicBeginProbe(relativeReceipt.jobId),true);
  const mixedInput={...relativeInput,commandId:randomUUID()};await f.owner.recordOwnerCampaignQueue(f.brand,mixedInput);
  assert.deepEqual(await worker.materializeCampaignQueue(f.brand,mixedInput.commandId),{kind:'held',reason:'stable_first_verification_anchor_required_choose_owner_pin'},'Fresh relative admission cannot establish earliest among mixed known/unknown history');
  console.log(JSON.stringify({proof:'010-native-campaign-queue',draftNoJob:true,firstWorkerBinding:true,expiredOwnerSessionAndPostObservation:true,distinctInstagramJobs:3,realImageRows:3,realProofMediaRows:3,
    oldSelectedApprovedImage:true,unicodeGolden:true,dstGoldens:5,nonLondonCanonicalTimezone:true,legacyRelativeHeldOwnerPinWorked:true,stableRelativeAnchorRefreshSafe:true,knownUnsentRetiredBeforeBrandLock:true,unknownRetained:true,
    legacyUserPlainSeo:true,oneVariantEditHeld:true,pauseSkippedWithoutAttempts:true,finalPauseBoundary:true,oneLoaderImage:true,revokedOwnerHeld:true,cancelHeld:true,withdrawalHeld:true,providerCalls:0,storageOnlyMarkerJpeg:true}));
}

// Regression uses a fresh fixture on the existing disposable database; no reset or provider effect.
test('Sponsor revocation committed during global-gate wait holds the paid image start',{skip,timeout:30000},async()=>{
  const raw=process.env.TEST_DATABASE_URL??'';const target=new URL(raw);
  assert.equal(process.env.RELAUNCH72_DATABASE_INTEGRATION,'explicit-disposable-run');
  assert.equal(process.env.TEST_DATABASE_RESET_CONFIRM,'reset-disposable-branch');
  assert.match(decodeURIComponent(target.pathname.slice(1)),/(?:^|[_-])test(?:$|[_-])/i);
  assert.ok(['localhost','127.0.0.1','[::1]'].includes(target.hostname),'Sponsor-wait regression requires the local disposable PostgreSQL service');
  const admin=new pg.Pool({connectionString:raw,max:6,application_name:'relaunch72-disposable-media-control'});
  let content:pg.Pool|undefined,identityPool:pg.Pool|undefined;
  const gate=await admin.connect();let pending:Promise<SeoImageAttemptDecision>|undefined;
  try{
    content=await login(admin,'r72_content_command'); // Existing helper enforces reset guard and actual current_database before changing disposable role password.
    const expectedDb=decodeURIComponent(target.pathname.slice(1));assert.equal((await admin.query('SELECT current_database() name')).rows[0].name,expectedDb);
    const identityPassword=randomUUID()+randomUUID();
    const alter=(await admin.query<{sql:string}>("SELECT format('ALTER ROLE %I PASSWORD %L',$1::text,$2::text) sql",['r72_identity_command',identityPassword])).rows[0]!.sql;
    await admin.query(alter);const identityUrl=new URL(raw);identityUrl.username='r72_identity_command';identityUrl.password=identityPassword;
    identityPool=new pg.Pool({connectionString:identityUrl.toString(),max:2,application_name:'relaunch72-disposable-media-identity-control'});
    assert.deepEqual((await identityPool.query('SELECT session_user,current_user')).rows[0],{session_user:'r72_identity_command',current_user:'r72_identity_command'});
    const sponsor=await seed(admin,content),operator=await seed(admin,content);
    // Existing canonical Investor Desk access control, with genuine active administrator session; no direct membership UPDATE in this probe.
    await admin.query('INSERT INTO app_private.investor_programme_admins(user_id) VALUES($1)',[operator.user]);
    await admin.query(`INSERT INTO app.investor_businesses(workspace_id,administrator_user_id,owner_user_id,owner_email,owner_name,brand_name,
      access_state,payment_reference,creation_key,creation_hash) VALUES($1,$2,$3,$4,'Control sponsor','Control brand','active','disposable-fixture-only',$5,$6)`,
      [sponsor.brand,operator.user,sponsor.user,`control-${sponsor.user}@example.test`,randomUUID(),Buffer.from(sha('disposable-business-control'),'hex')]);
    const media=new PgSeoBlogMediaStore(content,{kind:'worker',requestId:randomUUID()},{publicOrigin:origin});
    await configure(admin,{enabled:true,maxConcurrency:1000000,monthlyMicrousd:1000000000000,perAttemptMicrousd:1000});
    const policy=await media.readImagePolicy(),fixture=await initialize(sponsor,media,policy,content);
    assert.equal((await admin.query('SELECT app_private.can_manage_workspace($1,$2) ok',[sponsor.user,sponsor.brand])).rows[0].ok,true);
    await gate.query('BEGIN');await gate.query('UPDATE app_private.seo_image_operator_policy SET admission_epoch=admission_epoch+1 WHERE singleton');
    pending=media.commitImageAttempt(fixture.start);
    await waitForBlockedFixture(admin,'seo_image_reserve');
    const before=(await admin.query('SELECT count(*)::int n FROM app.seo_blog_image_attempts WHERE job_id=$1',[fixture.start.jobId])).rows[0].n;
    assert.equal(before,0,'No attempt is committed while reserve waits');
    await withTransaction(identityPool,{actorKind:'user',workspaceId:operator.home,userId:operator.user,requestId:randomUUID()},async(t)=>{
      await t.query("SET LOCAL statement_timeout='5s'");
      await t.query('SELECT app_private.set_investor_access($1,$2,1,$3,NULL,NULL)',[Buffer.from(sha(operator.token),'hex'),sponsor.brand,'suspended']);
    });
    assert.equal((await admin.query('SELECT status FROM app.workspace_memberships WHERE workspace_id=$1 AND user_id=$2',[sponsor.brand,sponsor.user])).rows[0].status,'suspended');
    assert.equal((await admin.query('SELECT app_private.can_manage_workspace($1,$2) ok',[sponsor.user,sponsor.brand])).rows[0].ok,false);
    await gate.query('COMMIT');
    const decision=await pending;pending=undefined;
    const attempts=(await admin.query('SELECT count(*)::int n FROM app.seo_blog_image_attempts WHERE job_id=$1',[fixture.start.jobId])).rows[0].n;
    const usage=(await admin.query("SELECT coalesce(sum(amount),0)::int n FROM app.seo_blog_usage WHERE workspace_id=$1 AND kind='images'",[sponsor.brand])).rows[0].n;
    const workerIdentity=await withTransaction(content,workerContext(sponsor.brand),async(t)=>(await t.query("SELECT session_user,current_user,current_setting('app.actor_kind') actor,current_setting('app.user_id') actor_user")).rows[0]);
    assert.deepEqual(workerIdentity,{session_user:'r72_content_command',current_user:'r72_content_command',actor:'worker',actor_user:''});
    console.log(JSON.stringify({proof:'010-IMAGE-SPONSOR-WAIT-001',
      realRole:'r72_content_command',isolation:'read committed',globalWaitObserved:true,canonicalRevocationCommittedBeforeGateRelease:true,
      result:decision.kind,reason:'reason' in decision?decision.reason:null,committedAttempts:attempts,committedImagesDebit:usage,providerCalls:0}));
    assert.deepEqual(decision,{kind:'held',reason:'sponsor_ineligible'},'The fresh post-wait sponsor check must hold before any committed provider grant');
    assert.equal(attempts,0);assert.equal(usage,0);
  }finally{
    await gate.query('ROLLBACK').catch(()=>{});gate.release();
    if(pending)await pending.catch(()=>{});
    await Promise.all([content?.end(),identityPool?.end()]);await admin.end();
  }
});
