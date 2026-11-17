import {PgMediaErasureOwner,PgMediaRetentionWorker} from '../../src/creative-studio/media-retention.js';
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
import {PgOfflineMediaDiscovery,runOfflineMediaTick} from '../../src/creative-studio/media-worker-dispatch.js';
import {PgLocalVideoCanonicalHandoff} from '../../src/creative-studio/media-canonical-handoff.js';
import {PrivateMediaFiles,LARGE_MEDIA_PART_BYTES} from '../../src/creative-studio/media-private-files.js';
import {PgPrivateObjectSources,PgPrivateObjectProbeWorker,PgPrivateObjectCleanupWorker} from '../../src/creative-studio/media-object-sources.js';
import {renderLocalVideoFile} from '../../src/creative-studio/media-local-render.js';
import {PgSetupDeliveryService,SetupDeliveryKeyring,setupDeliveryAad} from '../../src/portal/setup-delivery-pg-service.js';
import {PgPortalAuthService} from '../../src/portal/auth-pg-service.js';
import {PgNativeVideoReleaseOwner,PgNativeVideoReleaseWorker} from '../../src/creative-studio/media-video-release.js';
import {CompanyContentService} from '../../src/company-content-pg/index.js';
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
 await admin.query("ALTER ROLE r72_worker PASSWORD 'local-worker-test-only'");
 const workerUrl=new URL(uri);workerUrl.username='r72_worker';workerUrl.password='local-worker-test-only';
 const workerPool=new pg.Pool({connectionString:workerUrl.toString(),max:3});
 assert.equal((await workerPool.query('SELECT current_user')).rows[0].current_user,'r72_worker');
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
    '-t','4.0','-c:v','libx264','-preset','ultrafast','-crf','33',
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
    {startMs:1250,endMs:3250,caption:'Another scene',transition:'fade',speed:2}]};
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
   await assert.rejects(b.owner.enqueue({...enqueue,workspaceId:b.brand.id}),/owner|session|workspace|probe|rights|measured source|timeline/iu);
   await assert.rejects(content.query('SELECT * FROM app.creative_media_local_render_jobs'),/permission denied/iu);
  });
  await t.test('trusted worker measures actual source file, owner queues exact latest timeline',async()=>{
   const measured=await new PgVideoSourceProbeWorker(workerPool,'local-source-probe').run(a.brand.id,upload.id);
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
   const worker=new PgLocalRenderWorker(workerPool,'local-render-pg-smoke',env);
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
   assert.equal((await admin.query("SELECT to_regclass('app.creative_media_video_jobs') AS name")).rows[0].name,null,'native-only schema has no paid job table');
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
   assert.equal((await admin.query("SELECT to_regclass('app.creative_media_video_outputs') AS name")).rows[0].name,null);
  });
  await t.test('24 MB private source follows canonical upload, actual file probe, immutable edit and offline render',async()=>{
   const files=new PrivateMediaFiles(join(temp,'private-objects')),flags={...env,RL72_MEDIA_PRIVATE_FILES_ENABLED:'true'};
   const sources=new PgPrivateObjectSources(content,a.principal,files,flags),crossed=new PgPrivateObjectSources(content,b.principal,files,flags);
   const free=Buffer.alloc(24*1024*1024-bytes.length);free.writeUInt32BE(free.length,0);free.write('free',4,'ascii');const large=Buffer.concat([bytes,free]);
   const sourceId=randomUUID(),metadata={byteLength:large.length,sha256:sha(large),fileName:'large-owned.mp4',mime:'video/mp4' as const,rights:'owned' as const,evidenceSha256:null,rightsConfirmed:true};
   await assert.rejects(sources.begin(a.brand.id,upload.id,metadata),/already catalogued/iu);
   await sources.begin(a.brand.id,sourceId,metadata);
   await assert.rejects(sources.complete(a.brand.id,sourceId));
   for(let i=0;i<Math.ceil(large.length/LARGE_MEDIA_PART_BYTES);i++)await sources.part(a.brand.id,sourceId,i,large.subarray(i*LARGE_MEDIA_PART_BYTES,(i+1)*LARGE_MEDIA_PART_BYTES));
   const finished=await sources.complete(a.brand.id,sourceId);assert.equal(finished.state,'completed');assert.equal((await sources.complete(a.brand.id,sourceId)).state,'completed');
   await assert.rejects(crossed.source(b.brand.id,sourceId),/unavailable/iu);
   const probed=await new PgPrivateObjectProbeWorker(workerPool,'large-source-proof',files,flags).run(a.brand.id,sourceId);assert.equal(probed?.status,'verified_technical');
   const project=randomUUID(),objectPlan={...plan,clips:[{startMs:0,endMs:1000,caption:'Actual large source',transition:'cut' as const,speed:1 as const}]};
   await new PgMediaEditStore(content,a.principal).save({workspaceId:a.brand.id,projectId:project,commandId:randomUUID(),expectedRevision:0,sourceId,sourceSha256:sha(large),plan:objectPlan});
   const queuedId=randomUUID();await a.owner.enqueue({workspaceId:a.brand.id,projectId:project,revision:1,jobId:queuedId,commandId:randomUUID(),sourceSha256:sha(large),planSha256:videoEditDigest(objectPlan),rightsConfirmed:true});
   const result=await runQueuedLocalRender(a.brand.id,queuedId,{ledger:new PgLocalRenderWorker(workerPool,'large-render-proof',flags),renderer:renderLocalVideo,objectRenderer:(object,probe,edit)=>renderLocalVideoFile(files,object,probe,edit)});
   assert.equal(result.state,'completed');assert.ok(result.outputId);assert.equal((await a.owner.load(a.brand.id,result.outputId!)).mime,'video/mp4');
   // Simulate a crash after catalogue commit but before staging unlink.
   await files.putPart(a.brand.id,sourceId,0,large.length,large.subarray(0,LARGE_MEDIA_PART_BYTES));
   const expired=randomUUID();await sources.begin(a.brand.id,expired,metadata);await sources.part(a.brand.id,expired,0,large.subarray(0,LARGE_MEDIA_PART_BYTES));
   await admin.query("UPDATE app.creative_media_object_uploads SET expires_at=now()-interval '1 second' WHERE workspace_id=$1 AND id=$2",[a.brand.id,expired]);
   const cleaned=await new PgPrivateObjectCleanupWorker(workerPool,'object-cleanup-proof',files,flags).sweep(a.brand.id);assert.ok(cleaned.some(x=>x.sourceId===expired&&x.state==='cleaned'));
   assert.deepEqual(await files.parts(a.brand.id,sourceId,large.length),[]);await files.verify(finished);
   assert.equal((await sources.source(a.brand.id,sourceId)).sha256,sha(large),'housekeeping must preserve completed canonical objects');
  });
  await t.test('native video handoff creates a genuine pending canonical approval and withdrawal blocks a fresh handoff',async()=>{
   await admin.query("ALTER ROLE r72_content_adapter PASSWORD 'local-methods-test-only'");
   const adapterUri=new URL(uri);adapterUri.username='r72_content_adapter';adapterUri.password='local-methods-test-only';
   const adapter=new pg.Pool({connectionString:adapterUri.toString(),max:2});
   try{
    const output=(await a.owner.outputs(a.brand.id)).find(x=>x.jobId===jobId)!,review=new PgLocalOutputReviewOwner(content,a.principal,env);
    const current=(await review.list(a.brand.id)).find(x=>x.outputId===output.id)!;
    const handoff=new PgLocalVideoCanonicalHandoff(adapter,content,a.principal,{...env,RL72_MEDIA_CANONICAL_HANDOFF_ENABLED:'true'});
    const input={workspaceId:a.brand.id,outputId:output.id,outputSha256:output.sha256,reviewRevision:current.revision,commandId:randomUUID(),title:'Private native video',caption:'#ad Review this exact owned video',platform:'instagram' as const};
    const saved=await handoff.request(input);assert.equal(saved.state,'pending_canonical_review');assert.equal(saved.providerEffects,false);
    assert.equal((await handoff.request(input)).draft.disposition,'replayed');
    const canonical=await admin.query('SELECT content_kind FROM app.company_content_versions WHERE workspace_id=$1 AND id=$2',[a.brand.id,saved.draft.contentVersionId]);
    assert.equal(canonical.rows[0].content_kind,'video');
    const sessionHash=createHash('sha256').update(a.principal.sessionToken).digest();
    const ctx={actorKind:'user' as const,userId:a.principal.userId,workspaceId:a.brand.id,requestId:'native-video-canonical-approval',portalSessionTokenHash:sessionHash};
    const service=new CompanyContentService({transactionRunner:{run:(context,op,options)=>withTransaction(content,context,op,{readOnly:false,isolation:options.serializable?'serializable':'read committed'})}});
    const approved=await service.decideApproval(ctx,{commandKey:'approve-native-'+randomUUID(),approvalRequestId:saved.approval.approvalRequestId,decision:'approved'});
    // Planner -> scheduled job -> calling is an explicit unresolved audit gate.
    // Do not seed a fake job or disable FK/triggers to pretend this is proved.
    await review.review({workspaceId:a.brand.id,outputId:output.id,outputSha256:output.sha256,expectedRevision:current.revision,commandId:randomUUID(),decision:'withdrawn_private',rightsConfirmed:false,claimsConfirmed:false,disclosureConfirmed:false});
    await assert.rejects(handoff.request({...input,commandId:randomUUID()}),/review required/iu);
   }finally{await adapter.end();}
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
  await t.test('stale queued timelines become permanent failures instead of blocking every service tick',async()=>{
   const current=(await editor.list(a.brand.id)).find(x=>x.id===projectId)!,staleJob=randomUUID();
   await a.owner.enqueue({...enqueue,jobId:staleJob,commandId:randomUUID(),revision:current.revision,planSha256:current.planSha256});
   await editor.save({workspaceId:a.brand.id,projectId,commandId:randomUUID(),expectedRevision:current.revision,sourceId:upload.id,sourceSha256:upload.sha256,plan:{...current.plan,clips:current.plan.clips.map((clip,index)=>({...clip,caption:clip.caption+(index===0?' changed':'' )}))}});
   await assert.rejects(new PgLocalRenderWorker(workerPool,'stale-proof',env).claim(a.brand.id,staleJob),/unavailable/iu);
   assert.equal((await admin.query('SELECT state FROM app.creative_media_local_render_jobs WHERE workspace_id=$1 AND id=$2',[a.brand.id,staleJob])).rows[0].state,'failed');
   assert.equal((await new PgOfflineMediaDiscovery(workerPool,'stale-discovery').pending(a.brand.id,10)).some(x=>x.id===staleJob),false);
  });
  await t.test('offline leases heartbeat, fence expired attempts and stop retrying after three claims',async()=>{
   const current=(await editor.list(a.brand.id)).find(x=>x.id===projectId)!;
   const retryJob=randomUUID();await a.owner.enqueue({...enqueue,jobId:retryJob,commandId:randomUUID(),revision:current.revision,planSha256:current.planSha256});
   const ledger=new PgLocalRenderWorker(workerPool,'heartbeat-proof',env),discovery=new PgOfflineMediaDiscovery(workerPool,'retry-proof');
   let first:string|undefined;
   for(let attempt=1;attempt<=3;attempt++){
    const claim=await ledger.claim(a.brand.id,retryJob);first??=claim.claimToken;
    assert.equal(await ledger.heartbeat(a.brand.id,retryJob,claim.claimToken),true);
    if(attempt>1)assert.notEqual(claim.claimToken,first);
    await admin.query("UPDATE app.creative_media_local_render_jobs SET claim_until=clock_timestamp()-interval '1 second' WHERE workspace_id=$1 AND id=$2",[a.brand.id,retryJob]);
    assert.equal(await ledger.heartbeat(a.brand.id,retryJob,claim.claimToken),false);
    await discovery.pending(a.brand.id,10);
    await assert.rejects(ledger.fail(a.brand.id,retryJob,claim.claimToken,'render_failed'),/token|lease/iu);
    if(attempt<3)await admin.query("UPDATE app.creative_media_local_render_jobs SET retry_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1 AND id=$2",[a.brand.id,retryJob]);
   }
   const final=(await admin.query('SELECT state,attempts FROM app.creative_media_local_render_jobs WHERE workspace_id=$1 AND id=$2',[a.brand.id,retryJob])).rows[0];assert.deepEqual(final,{state:'failed',attempts:3});
  });
  await t.test('R8 SQL admission rejects subsecond and beyond-source trims before creating a job',async()=>{
   for(const endMs of [500,9000]){
    const project=randomUUID(),invalid={...plan,clips:[{...plan.clips[0]!,endMs}]},digest=sha(Buffer.from(JSON.stringify(invalid)));
    await admin.query('INSERT INTO app.creative_media_edit_projects(workspace_id,id,revision,source_id,source_sha256,plan,plan_sha256,created_by) VALUES($1,$2,1,$3,$4,$5,$6,$7)',[a.brand.id,project,upload.id,upload.sha256,JSON.stringify(invalid),digest,a.principal.userId]);
    await assert.rejects(a.owner.enqueue({...enqueue,projectId:project,revision:1,jobId:randomUUID(),commandId:randomUUID(),planSha256:digest}),/at least one second|within the uploaded video/iu);
   }
  });
  await t.test('the SQL queue cap rejects a twenty-first outstanding render',async()=>{
   const current=(await editor.list(a.brand.id)).find(x=>x.id===projectId)!;
   const request=()=>({...enqueue,jobId:randomUUID(),commandId:randomUUID(),revision:current.revision,planSha256:current.planSha256});
   for(let n=0;n<20;n++)await a.owner.enqueue(request());
   await assert.rejects(a.owner.enqueue(request()),/cap|storage/iu);
  });
  await t.test('R2 missing disk source backs off and newer small source is probed on the next tick',async()=>{
   const missing=randomUUID(),digest='a'.repeat(64),ws=b.brand.id;
   await admin.query("INSERT INTO app.creative_media_source_videos(workspace_id,id,command_id,storage_kind,object_key,file_name,sha256,byte_length,mime,rights,owner_user_id) VALUES($1,$2,$2,'private_object',$3,'unreachable.mp4',$4,25000000,'video/mp4','owned',$5)",[ws,missing,ws+'/'+missing+'/'+digest+'.mp4',digest,b.principal.userId]);
   const healthy=await new PgCreativeVideoSources(content,b.principal).upload({workspaceId:ws,commandId:randomUUID(),fileName:'healthy.mp4',rights:'owned',rightsConfirmed:true,evidenceSha256:null,bytes});
   const files=new PrivateMediaFiles(join(temp,'unreachable-disk')),flags={...env,RL72_MEDIA_PRIVATE_FILES_ENABLED:'true',RL72_MEDIA_DISPATCH_ENABLED:'true'},discovery=new PgOfflineMediaDiscovery(workerPool,'R2-reproduction');
   const seen:string[]=[];
   for(let tick=0;tick<4;tick++)await runOfflineMediaTick(ws,{pending:(w,n)=>discovery.pending(w,n),deferProbe:(w,id)=>discovery.deferProbe(w,id),probe:async(w,id)=>{seen.push(id);return await new PgPrivateObjectProbeWorker(workerPool,'R2-object',files,flags).run(w,id)??new PgVideoSourceProbeWorker(workerPool,'R2-small').run(w,id);},render:async()=>{throw Error('Unexpected render');}},{env:flags,limit:1});
   assert.deepEqual(seen,[missing,healthy.id]);
   assert.equal((await admin.query('SELECT attempts,retry_at>clock_timestamp() waiting FROM app.creative_media_probe_retries WHERE workspace_id=$1 AND source_id=$2',[ws,missing])).rows[0].waiting,true);
   assert.equal((await admin.query('SELECT status FROM app.creative_media_video_probes WHERE workspace_id=$1 AND source_id=$2',[ws,healthy.id])).rows[0].status,'verified_technical');
   console.log('R2 reproduction PASS: unreachable large file deferred; healthy upload probed by second tick');
  });
  await t.test('owner erasure blocks reads immediately, removes stored bytes and isolates tenants',async()=>{
   const flags={...env,RL72_MEDIA_RETENTION_ENABLED:'true'};
   const owner=new PgMediaErasureOwner(content,a.principal,flags),cross=new PgMediaErasureOwner(content,b.principal,flags);
   await assert.rejects(cross.erase(b.brand.id,'source',upload.id),/unavailable|owner/iu);
   const erasedOutput=(await a.owner.outputs(a.brand.id)).find(o=>o.jobId===jobId)!;
   const latest=(await editor.list(a.brand.id)).find(p=>p.id===projectId)!;
   await owner.erase(a.brand.id,'source',upload.id);
   await assert.rejects(a.owner.enqueue({...enqueue,revision:latest.revision,planSha256:latest.planSha256,jobId:randomUUID(),commandId:randomUUID()}),/deleted/iu);
   await assert.rejects(a.owner.load(a.brand.id,erasedOutput.id),/unavailable/iu);
   await new PgMediaRetentionWorker(workerPool,'erasure-test',null).sweep(a.brand.id);
   const counts=await admin.query("SELECT octet_length(b.bytes) n FROM app.creative_media_source_videos s JOIN app.seo_blog_blobs b ON b.workspace_id=s.workspace_id AND b.id=s.blob_id WHERE s.workspace_id=$1 AND s.id=$2",[a.brand.id,upload.id]);
   assert.equal(counts.rows[0].n,1);
   assert.equal((await admin.query('SELECT file_name FROM app.creative_media_source_videos WHERE workspace_id=$1 AND id=$2',[a.brand.id,upload.id])).rows[0].file_name,'Deleted video');
   assert.equal((await admin.query("SELECT count(*)::int n FROM app.creative_media_edit_projects WHERE workspace_id=$1 AND source_id=$2 AND plan<>'{\"erased\":true}'::jsonb",[a.brand.id,upload.id])).rows[0].n,0);
   assert.equal((await admin.query('SELECT count(*)::int n FROM app.creative_media_erasures WHERE workspace_id=$1 AND erased_at IS NOT NULL',[a.brand.id])).rows[0].n>=2,true);
  });
  await t.test('R7 database sources have workspace count and byte caps with safe replay',async()=>{
   const countBrand=await seed('home'),store=new PgCreativeVideoSources(content,countBrand.principal);
   const request=()=>({workspaceId:countBrand.brand.id,commandId:randomUUID(),fileName:'capacity.mp4',rights:'owned' as const,rightsConfirmed:true,evidenceSha256:null,bytes});
   const first=request();await store.upload(first);for(let n=1;n<50;n++)await store.upload(request());
   assert.equal((await store.upload(first)).replayed,true);await assert.rejects(store.upload(request()),/library is full/iu);
   const byteBrand=await seed('b2b'),byteStore=new PgCreativeVideoSources(content,byteBrand.principal),big=Buffer.alloc(20000000);bytes.copy(big);
   const bigRequest=()=>({...request(),workspaceId:byteBrand.brand.id,bytes:big});
   for(let n=0;n<10;n++)await byteStore.upload(bigRequest());
   await assert.rejects(byteStore.upload({...bigRequest(),bytes}),/library is full/iu);
  });
  await t.test('automatic retention advances beyond its first batch without a per-workspace manual command',async()=>{
   const ids:string[]=[];
   for(let n=0;n<14;n++){
    const id=randomUUID();ids.push(id);
    await admin.query(`WITH blob AS (INSERT INTO app.seo_blog_blobs(workspace_id,mime,bytes,sha256) VALUES($1,'video/mp4',$2::bytea,public.digest($2::bytea,'sha256')) RETURNING id)
     INSERT INTO app.creative_media_source_videos(workspace_id,id,command_id,blob_id,file_name,sha256,byte_length,mime,rights,owner_user_id,created_at)
     SELECT $1,$3,$3,blob.id,'retention.mp4',encode(public.digest($2::bytea,'sha256'),'hex'),octet_length($2::bytea),'video/mp4','owned',$4,clock_timestamp()-interval '31 days' FROM blob`,[a.brand.id,bytes,id,a.principal.userId]);
   }
   const janitor=new PgMediaRetentionWorker(workerPool,'automatic-retention-proof',null);
   await janitor.sweep(a.brand.id);
   assert.equal((await admin.query("SELECT count(*)::int n FROM app.creative_media_erasures WHERE workspace_id=$1 AND id=ANY($2::uuid[])",[a.brand.id,ids])).rows[0].n,0,'default retains owner library indefinitely');
   await new PgMediaErasureOwner(content,a.principal,{...env,RL72_MEDIA_RETENTION_ENABLED:'true'}).setRetention(a.brand.id,30,true);
   for(let n=0;n<6;n++)await janitor.sweep(a.brand.id);
   const result=await admin.query("SELECT count(*)::int n FROM app.creative_media_erasures WHERE workspace_id=$1 AND kind='source' AND id=ANY($2::uuid[]) AND erased_at IS NOT NULL",[a.brand.id,ids]);assert.equal(result.rows[0].n,14);
  });
 }finally{
  await rm(temp,{recursive:true,force:true});
  await workerPool.end();await admin.end();await content.end();
 }
});
