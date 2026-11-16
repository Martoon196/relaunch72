/**
 * Real, disposable PostgreSQL end-to-end private media proof:
 * upload owned MP4 -> genuine ffprobe -> immutable edit -> owner intent ->
 * one-shot offline FFmpeg render -> persisted verified MP4 -> owner preview.
 * No production database, remote provider, sender or publisher is touched.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {PgResumableMediaUploads} from '../../src/creative-studio/media-upload-pg-store.js';
import {PgOfflineMediaDiscovery} from '../../src/creative-studio/media-worker-dispatch.js';
import {PgMediaBillingOwner,PgMediaBillingWebhook} from '../../src/creative-studio/media-billing.js';
import {PgMediaAccessOwner} from '../../src/creative-studio/media-access-pg-store.js';
import {PgCreativeMediaProductStore} from '../../src/creative-studio/media-product-pg-store.js';
import {PgMediaLinkEvidenceOwner} from '../../src/creative-studio/media-link-evidence.js';
import {PgLocalVideoCanonicalHandoff} from '../../src/creative-studio/media-canonical-handoff.js';
import {withTransaction} from '../../src/db/transaction.js';
import {fixtureBrand} from '../rl72-method-fixtures.js';
import {PgSeoBlogStore} from '../../src/seo-blog/pg-store.js';
import {PgCreativeVideoSources} from '../../src/creative-studio/media-video-source-pg-store.js';
import {PgVideoSourceProbeWorker,ffprobeFromBytes} from '../../src/creative-studio/media-source-probe.js';
import {PgMediaEditStore} from '../../src/creative-studio/media-edit-pg-store.js';
import {PgLocalRenderOwner,PgLocalRenderWorker,runQueuedLocalRender,renderLocalVideo}
 from '../../src/creative-studio/media-local-render-pg-store.js';
import {PgLocalOutputReviewOwner} from '../../src/creative-studio/media-local-output-review.js';
import {videoEditDigest,type VideoEditPlan} from '../../src/creative-studio/media-edit-plan.js';

const raw=process.env.RL72_METHODS_PG_TEST_URL;
const available=spawnSync('ffmpeg',['-version'],{encoding:'utf8',timeout:5000}).status===0
 &&spawnSync('ffprobe',['-version'],{encoding:'utf8',timeout:5000}).status===0;
const skip=!raw||process.env.RELAUNCH72_DATABASE_INTEGRATION!=='explicit-disposable-run'
  ?'Only run with disposable localhost PG'
  :!available?'FFmpeg/FFprobe system dependency not installed in test worker':false;
const env={CREATIVE_MEDIA:'enabled',RL72_MEDIA_LOCAL_RENDER_ENABLED:'true',
 RL72_MEDIA_WORKER_ENABLED:'true'};
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');

test('real native render starts from exact owned, independently probed source and ends in private preview',{skip,timeout:120000},async t=>{
 const uri=new URL(raw!);
 assert.ok(['127.0.0.1','localhost'].includes(uri.hostname));
 assert.equal(uri.pathname,'/relaunch72_test');
 const admin=new pg.Pool({connectionString:raw,max:3});
 const userUri=new URL(uri);
 userUri.username='r72_content_command';userUri.password='local-methods-test-only';
 const content=new pg.Pool({connectionString:userUri.toString(),max:4});
 const temp=await mkdtemp(join(tmpdir(),'rl72-pg-local-video-smoke-'));
 async function seed(kind:'home'|'b2b'){
  const f=fixtureBrand(kind), actor=f.profile.confirmedBy!,sessionToken=randomUUID()+randomUUID();
  await admin.query("INSERT INTO app.organizations(id,name,slug,kind) VALUES($1,$2,$3,'direct_customer')",
   [f.brand.organizationId,f.brand.name,'local-render-'+f.brand.organizationId]);
  await admin.query("INSERT INTO app.users(id,email,status) VALUES($1,$2,'active')",
   [actor,actor+'@local-render.test']);
  await admin.query("INSERT INTO app.organization_memberships(organization_id,user_id,role,status) VALUES($1,$2,'owner','active')",
   [f.brand.organizationId,actor]);
  await admin.query("INSERT INTO app.workspaces(id,organization_id,name,slug) VALUES($1,$2,$3,$4)",
   [f.brand.id,f.brand.organizationId,f.brand.name,'local-render-'+f.brand.id]);
  await admin.query("INSERT INTO app.workspace_memberships(workspace_id,organization_id,user_id,role,status,source_organization_id) VALUES($1,$2,$3,'owner','active',$2)",
   [f.brand.id,f.brand.organizationId,actor]);
  await admin.query("INSERT INTO app.user_sessions(token_hash,csrf_secret_hash,user_id,selected_workspace_id,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')",
   [createHash('sha256').update(sessionToken).digest(),
    createHash('sha256').update('csrf'+sessionToken).digest(),actor,f.brand.id]);
  await admin.query("INSERT INTO app.seo_blog_brands(workspace_id,organization_id,created_by_user_id,settings) VALUES($1,$2,$3,$4)",
   [f.brand.id,f.brand.organizationId,actor,JSON.stringify(f.brand.settings)]);
  const principal={kind:'user' as const,userId:actor,requestId:'local-render-test',
   sessionToken,selectedWorkspaceId:f.brand.id};
  await new PgSeoBlogStore(content,principal).saveProfile(f.profile);
  return {...f,principal,owner:new PgLocalRenderOwner(content,principal,env)};
 }
 try{
  const a=await seed('home'),b=await seed('b2b');
  const inputPath=join(temp,'fixture.mp4');
  const made=spawnSync('ffmpeg',[
    '-hide_banner','-loglevel','error','-nostdin','-y',
    '-f','lavfi','-i','testsrc2=size=320x180:rate=30',
    '-f','lavfi','-i','sine=frequency=440:sample_rate=44100',
    '-t','3.0','-c:v','libx264','-preset','ultrafast','-crf','33',
    '-c:a','aac','-b:a','64k',inputPath],{encoding:'utf8',timeout:20000});
  assert.equal(made.status,0,made.stderr.slice(0,500));
  const bytes=await readFile(inputPath);
  const upload=await new PgCreativeVideoSources(content,a.principal).upload({
   workspaceId:a.brand.id,commandId:randomUUID(),fileName:'owned-fixture.mp4',
   rights:'owned',rightsConfirmed:true,evidenceSha256:null,bytes,
  });
  const editor=new PgMediaEditStore(content,a.principal);
  const plan:VideoEditPlan={canvas:'portrait',disclosure:'#ad',
   clips:[{startMs:0,endMs:1000,caption:'Private clip test',transition:'cut',speed:1},
    {startMs:1250,endMs:2250,caption:'Another scene',transition:'fade',speed:2}]};
  const projectId=randomUUID();
  const save=await editor.save({
   workspaceId:a.brand.id,projectId,commandId:randomUUID(),expectedRevision:0,
   sourceId:upload.id,sourceSha256:upload.sha256,plan,
  });
  assert.equal(save.revision,1);
  const jobId=randomUUID(),commandId=randomUUID(),enqueue={
   workspaceId:a.brand.id,projectId,revision:1,jobId,commandId,
   sourceSha256:upload.sha256,planSha256:videoEditDigest(plan),rightsConfirmed:true,
  };
  await t.test('cannot queue unprobed source or impersonate owner',async()=>{
   await assert.rejects(a.owner.enqueue(enqueue),/probe|measured|timeline/iu);
   await assert.rejects(b.owner.enqueue({...enqueue,workspaceId:b.brand.id}),/owner|session|workspace|probe|rights|measured source/iu);
   await assert.rejects(content.query('SELECT * FROM app.creative_media_local_render_jobs'),/permission denied/iu);
  });
  await t.test('trusted worker measures actual source file, owner queues exact latest timeline',async()=>{
   const measured=await new PgVideoSourceProbeWorker(admin,'local-source-probe').run(a.brand.id,upload.id);
   assert.equal(measured.status,'verified_technical');
   const original=await ffprobeFromBytes(bytes);
   assert.equal(original.status,'verified_technical');
   const queued=await a.owner.enqueue(enqueue);
   assert.deepEqual(queued,{id:jobId,state:'queued',replayed:false});
   const replay=await a.owner.enqueue(enqueue);
   assert.deepEqual(replay,{id:jobId,state:'queued',replayed:true});
   assert.equal((await a.owner.list(a.brand.id)).length,1);
   assert.deepEqual(await b.owner.list(b.brand.id),[]);
   await assert.rejects(b.owner.list(a.brand.id),/session|owner|workspace/iu);
  });
  await t.test('real FFmpeg job produces private H264 MP4, never a paid provider receipt',async()=>{
   const worker=new PgLocalRenderWorker(admin,'local-render-pg-smoke',env);
   const finished=await runQueuedLocalRender(a.brand.id,jobId,{
    ledger:worker,renderer:renderLocalVideo,
   });
   assert.equal(finished.state,'completed');
   assert.ok(finished.outputId);
   const saved=(await a.owner.outputs(a.brand.id))[0];
   assert.equal(saved?.jobId,jobId);
   assert.equal(saved?.sourceSha256,upload.sha256);
   assert.equal(saved?.planSha256,videoEditDigest(plan));
   assert.equal(saved?.width,720);assert.equal(saved?.height,1280);
   const privateAsset=await a.owner.load(a.brand.id,finished.outputId!);
   assert.equal(privateAsset.mime,'video/mp4');
   assert.ok(privateAsset.bytes.length>=1024&&privateAsset.bytes.length<20_000_000);
   assert.equal(sha(privateAsset.bytes),privateAsset.sha256);
   const fresh=await ffprobeFromBytes(privateAsset.bytes);
   assert.equal(fresh.status,'verified_technical');
   assert.equal(fresh.videoCodec,'h264');
   assert.deepEqual(await b.owner.outputs(b.brand.id),[]);
   await assert.rejects(b.owner.load(b.brand.id,finished.outputId!),/not found|unavailable/iu);
   await assert.rejects(b.owner.load(a.brand.id,finished.outputId!),/owner|session|workspace/iu);
   await assert.rejects(worker.claim(a.brand.id,jobId),/cannot be claimed again/iu);
   const paid=(await admin.query('SELECT count(*)::int AS n FROM app.creative_media_video_jobs WHERE workspace_id=$1',
    [a.brand.id])).rows[0]?.n;
   assert.equal(paid,0,'Local rendering must not create a paid provider reservation');
  });
  await t.test('local output exact owner review is isolated, replay-safe, withdrawable and never published',async()=>{
   const review=new PgLocalOutputReviewOwner(content,a.principal,env);
   const other=new PgLocalOutputReviewOwner(content,b.principal,env);
   const output=(await a.owner.outputs(a.brand.id))[0]!;
   const initial=(await review.list(a.brand.id))[0]!;
   assert.equal(initial.revision,0);assert.equal(initial.decision,null);
   assert.equal(initial.sha256,output.sha256);
   const input={workspaceId:a.brand.id,outputId:output.id,outputSha256:output.sha256,
    expectedRevision:0,commandId:randomUUID(),decision:'reviewed_private' as const,
    rightsConfirmed:true,claimsConfirmed:true,disclosureConfirmed:true};
   await assert.rejects(review.review({...input,outputSha256:'0'.repeat(64)}),/authorised/iu);
   await assert.rejects(other.review({...input,workspaceId:b.brand.id}),/authorised/iu);
   await assert.rejects(other.list(a.brand.id),/authorised|session/iu);
   assert.deepEqual(await other.list(b.brand.id),[]);
   await assert.rejects(content.query('SELECT * FROM app.creative_media_local_output_reviews'),/permission denied/iu);
   // Call the SQL boundary directly so missing/null fields cannot hide behind TS validation.
   const sessionHash=createHash('sha256').update(a.principal.sessionToken).digest();
   for(const bad of [{...input,rightsConfirmed:null},{...input,decision:null},
      {...input,claimsConfirmed:undefined},{...input,disclosureConfirmed:undefined}]){
    await assert.rejects(withTransaction(content,{actorKind:'user',workspaceId:a.brand.id,
      userId:a.principal.userId,requestId:'malformed-local-review',portalSessionTokenHash:sessionHash},
      async tx=>tx.query('SELECT app_private.creative_media_local_output_review($1,$2,$3,$4)',
       [a.brand.id,sessionHash,'review',JSON.stringify(bad)])),/Invalid exact private review request/iu);
   }
   await assert.rejects(withTransaction(content,{actorKind:'user',workspaceId:a.brand.id,
     userId:a.principal.userId,requestId:'null-action-review',portalSessionTokenHash:sessionHash},
     async tx=>tx.query('SELECT app_private.creative_media_local_output_review($1,$2,$3,$4)',
      [a.brand.id,sessionHash,null,JSON.stringify(input)])),/Invalid exact private review request/iu);
   const accepted=await review.review(input);
   assert.equal(accepted.revision,1);assert.equal(accepted.replayed,false);
   assert.equal((await review.review(input)).replayed,true);
   await assert.rejects(review.review({...input,decision:'rejected_private'}),/changed/iu);
   await assert.rejects(review.review({...input,commandId:randomUUID()}),/changed/iu);
   const withdrawn=await review.review({...input,expectedRevision:1,commandId:randomUUID(),
    decision:'withdrawn_private',rightsConfirmed:false,claimsConfirmed:false,disclosureConfirmed:false});
   assert.equal(withdrawn.revision,2);
   assert.equal((await review.list(a.brand.id))[0]?.decision,'withdrawn_private');
   assert.equal((await review.review({...input,expectedRevision:2,commandId:randomUUID()})).revision,3);
   const history=await admin.query('SELECT decision FROM app.creative_media_local_output_reviews WHERE workspace_id=$1 AND output_id=$2 ORDER BY revision',[a.brand.id,output.id]);
   assert.deepEqual(history.rows.map(x=>x.decision),['reviewed_private','withdrawn_private','reviewed_private']);
   // Review never copies the local render to provider capture or publication records.
   assert.equal((await admin.query('SELECT count(*)::int AS n FROM app.creative_media_video_outputs WHERE workspace_id=$1',[a.brand.id])).rows[0].n,0);
  });
  await t.test('resumable upload persists exact parts, refuses substitution and completes into canonical source store',async()=>{
   const flags={...env,RL72_MEDIA_RESUMABLE_UPLOADS_ENABLED:'true'};
   const uploader=new PgResumableMediaUploads(content,a.principal,flags),other=new PgResumableMediaUploads(content,b.principal,flags);
   const uploadId=randomUUID(),payload={byteLength:bytes.length,sha256:sha(bytes),metadata:{fileName:'resume.mp4',mime:'video/mp4' as const,rights:'owned' as const,evidenceSha256:null,rightsConfirmed:true}};
   const begun=await uploader.begin(a.brand.id,uploadId,payload);assert.deepEqual(begun.parts,[]);
   await assert.rejects(uploader.complete(a.brand.id,uploadId),/incomplete/iu);
   for(let index=0;index<Math.ceil(bytes.length/1000000);index++)await uploader.part(a.brand.id,uploadId,index,bytes.subarray(index*1000000,(index+1)*1000000));
   assert.equal((await uploader.status(a.brand.id,uploadId)).parts.length,Math.ceil(bytes.length/1000000));
   await assert.rejects(other.status(b.brand.id,uploadId),/owner|workspace/iu);
   const changed=Buffer.from(bytes.subarray(0,1000000));changed[changed.length-1]=(changed[changed.length-1]??0)^1;
   await assert.rejects(uploader.part(a.brand.id,uploadId,0,changed),/changed/iu);
   const stored=await uploader.complete(a.brand.id,uploadId);assert.equal(stored.sha256,sha(bytes));
   assert.equal((await uploader.complete(a.brand.id,uploadId)).replayed,true);
   assert.deepEqual((await uploader.status(a.brand.id,uploadId)).parts,[]);
   const cancelId=randomUUID();await uploader.begin(a.brand.id,cancelId,payload);await uploader.cancel(a.brand.id,cancelId);
   await assert.rejects(uploader.part(a.brand.id,cancelId,0,bytes.subarray(0,1000000)),/expired/iu);
   await assert.rejects(content.query('SELECT * FROM app.creative_media_upload_parts'),/permission denied/iu);
   const discovery=new PgOfflineMediaDiscovery(admin,'discovery-proof');
   const pending=await discovery.pending(a.brand.id,10);assert.ok(pending.some(x=>x.kind==='probe'&&x.id===stored.id));
   assert.deepEqual(await discovery.pending(b.brand.id,10),[]);
  });
  await t.test('native video handoff creates a genuine pending canonical approval and withdrawal blocks a fresh handoff',async()=>{
   await admin.query("ALTER ROLE r72_content_adapter PASSWORD 'local-methods-test-only'");
   const adapterUri=new URL(uri);adapterUri.username='r72_content_adapter';adapterUri.password='local-methods-test-only';
   const adapter=new pg.Pool({connectionString:adapterUri.toString(),max:2});
   try{
    const output=(await a.owner.outputs(a.brand.id))[0]!,review=new PgLocalOutputReviewOwner(content,a.principal,env);
    const current=(await review.list(a.brand.id))[0]!;
    const handoff=new PgLocalVideoCanonicalHandoff(adapter,content,a.principal,{...env,RL72_MEDIA_CANONICAL_HANDOFF_ENABLED:'true'});
    const input={workspaceId:a.brand.id,outputId:output.id,outputSha256:output.sha256,reviewRevision:current.revision,commandId:randomUUID(),title:'Private native video',caption:'#ad Review this exact owned video',platform:'instagram' as const};
    const saved=await handoff.request(input);assert.equal(saved.state,'pending_canonical_review');assert.equal(saved.providerEffects,false);
    assert.equal((await handoff.request(input)).draft.disposition,'replayed');
    const canonical=await admin.query('SELECT content_kind FROM app.company_content_versions WHERE workspace_id=$1 AND id=$2',[a.brand.id,saved.draft.contentVersionId]);
    assert.equal(canonical.rows[0].content_kind,'video');
    await review.review({workspaceId:a.brand.id,outputId:output.id,outputSha256:output.sha256,expectedRevision:current.revision,commandId:randomUUID(),decision:'withdrawn_private',rightsConfirmed:false,claimsConfirmed:false,disclosureConfirmed:false});
    await assert.rejects(handoff.request({...input,commandId:randomUUID()}),/review required/iu);
   }finally{await adapter.end();}
  });
  await t.test('merchant evidence is private, exact-product-version bound and superseded by product edits',async()=>{
   const store=new PgCreativeMediaProductStore(content,a.principal),links=new PgMediaLinkEvidenceOwner(content,a.principal,{...env,RL72_MEDIA_LINK_EVIDENCE_ENABLED:'true'});
   const product={network:'amazon_associates' as const,merchantName:'Amazon UK',productName:'Owner supplied item',productUrl:'https://www.amazon.co.uk/dp/B000000001',affiliateUrl:'https://www.amazon.co.uk/dp/B000000001?tag=owner-21',sourceRights:'owned' as const,productReviewed:true,channelEligible:true,mediaRightsConfirmed:true,disclosureVersion:'uk-v1'};
   const saved=await store.save({workspaceId:a.brand.id,expectedRevision:0,product});
   const input={workspaceId:a.brand.id,commandId:randomUUID(),productId:saved.productId,productRevision:1,evidenceSha256:'a'.repeat(64),registeredSite:'https://owner.example/',programmeConfirmed:true,siteConfirmed:true,tagOwnershipConfirmed:true};
   assert.equal((await links.save(input)).status,'owner_asserted_private');assert.equal((await links.list(a.brand.id))[0]?.current,true);
   await store.save({workspaceId:a.brand.id,productId:saved.productId,expectedRevision:1,product:{...product,productName:'Revised owner item'}});
   assert.equal((await links.list(a.brand.id))[0]?.current,false);
   await assert.rejects(links.save({...input,commandId:randomUUID()}),/Current product/iu);
  });
  await t.test('operator price policy, bound checkout and webhook role produce replay-safe grants and revocations',async()=>{
   await admin.query("INSERT INTO app.creative_media_price_policy(tier,price_id,livemode,enabled,max_job_microusd,monthly_video_microusd) VALUES('affiliate_creator','price_privateproof',false,true,1000000,10000000)");
   const flags={...env,RL72_MEDIA_BILLING_ENABLED:'true'},billing=new PgMediaBillingOwner(content,a.principal,flags),command=randomUUID();
   const intent=await billing.intent(a.brand.id,command,'affiliate_creator');assert.equal(intent.priceId,'price_privateproof');
   assert.equal((await billing.options(a.brand.id)).plans[0]?.priceId,'price_privateproof');
   await billing.bind(a.brand.id,command,'cs_test_privateproof');
   await assert.rejects(billing.bind(a.brand.id,command,'cs_test_changed'),/changed/iu);
   await admin.query("ALTER ROLE r72_webhook PASSWORD 'local-methods-test-only'");
   const webhookUri=new URL(uri);webhookUri.username='r72_webhook';webhookUri.password='local-methods-test-only';
   const webhook=new pg.Pool({connectionString:webhookUri.toString(),max:2});
   try{
    const ledger=new PgMediaBillingWebhook(webhook,'media-billing-proof'),access=new PgMediaAccessOwner(content,a.principal);
    const created=Math.floor(Date.now()/1000),receipt={eventId:'evt_privategrant',eventSha256:'a'.repeat(64),eventCreated:created,subscriptionId:'sub_privateproof',customerId:'cus_privateproof',priceId:'price_privateproof',livemode:false,activePaid:true,periodEnd:new Date(Date.now()+86400000).toISOString(),intentId:command,checkoutSessionId:'cs_test_privateproof',checkoutVerified:true};
    assert.deepEqual(await ledger.record(receipt),{disposition:'granted',replayed:false});assert.equal((await billing.options(a.brand.id)).customerId,'cus_privateproof');assert.equal((await access.current(a.brand.id)).maxJobMicrousd,1000000);
    assert.deepEqual(await ledger.record(receipt),{disposition:'granted',replayed:true});
    const revoked={...receipt,eventId:'evt_privaterevoke',eventSha256:'b'.repeat(64),eventCreated:created+1,activePaid:false,intentId:null,checkoutSessionId:null,checkoutVerified:false};
    assert.deepEqual(await ledger.record(revoked),{disposition:'revoked',replayed:false});assert.equal((await access.current(a.brand.id)).maxJobMicrousd,0);
    const stale={...receipt,eventId:'evt_privatestale',eventSha256:'c'.repeat(64),intentId:null};
    assert.deepEqual(await ledger.record(stale),{disposition:'stale',replayed:false});assert.equal((await access.current(a.brand.id)).maxJobMicrousd,0);
    assert.equal((await access.current(a.brand.id)).active,false);
    const replacement=randomUUID();await billing.intent(a.brand.id,replacement,'affiliate_creator');await billing.bind(a.brand.id,replacement,'cs_test_replacement');
    assert.deepEqual(await ledger.record({...receipt,eventId:'evt_replacement',eventSha256:'d'.repeat(64),eventCreated:created+2,subscriptionId:'sub_replacement',intentId:replacement,checkoutSessionId:'cs_test_replacement'}),{disposition:'granted',replayed:false});
    assert.equal((await access.current(a.brand.id)).active,true);
    assert.deepEqual(await ledger.record({...revoked,eventId:'evt_oldsubscription',eventSha256:'e'.repeat(64),eventCreated:created+3}),{state:'unbound'});
    await assert.rejects(webhook.query('SELECT * FROM app.creative_media_access_grants'),/permission denied/iu);
   }finally{await webhook.end();}
  });
  await t.test('newer edit makes an older timeline unqueueable',async()=>{
   const newer:VideoEditPlan={...plan,clips:[...plan.clips].reverse()};
   const updated=await editor.save({workspaceId:a.brand.id,projectId,
    commandId:randomUUID(),expectedRevision:1,sourceId:upload.id,
    sourceSha256:upload.sha256,plan:newer});
   assert.equal(updated.revision,2);
   await assert.rejects(a.owner.enqueue({...enqueue,commandId:randomUUID(),jobId:randomUUID()}),
    /latest|timeline|changed|required/iu);
  });
 }finally{
  await rm(temp,{recursive:true,force:true});
  await admin.end();await content.end();
 }
});
