import {randomBytes} from 'node:crypto';
import {PgNativeVideoPlanner,PgNativeVideoJitWorker} from '../../src/creative-studio/media-native-calendar.js';
import {PgZernioCalendarRepository} from '../../src/owned-public-social-pg/zernio-repository.js';
import {createPgSeoBlogSocialRegistry,createSeoBlogZernioWebhookBrands} from '../../src/portal/seo-blog-social-pg.js';
import {ZERNIO_ACCOUNT_WEBHOOK_CONTRACT_VERSION} from '../../src/public-social-outbound/zernio-account-webhook-contract.js';
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
import {spawnSync,execFileSync} from 'node:child_process';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {PgOfflineMediaDiscovery} from '../../src/creative-studio/media-worker-dispatch.js';
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
const skip=(!process.env.RL72_MEDIA_CLOCK_FILE&&!process.env.RL72_MEDIA_CLOCK_CONTAINER)?'Explicit isolated clock harness required':!raw||process.env.RELAUNCH72_DATABASE_INTEGRATION!=='explicit-disposable-run'
  ?'Only run with disposable localhost PG'
  :!available?'FFmpeg/FFprobe system dependency not installed in test worker':false;
const env={CREATIVE_MEDIA:'enabled',RL72_MEDIA_LOCAL_RENDER_ENABLED:'true',
 RL72_MEDIA_WORKER_ENABLED:'true'};
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');

test('native planner → three-day elapsed PostgreSQL clock → JIT proof → real Zernio calling trigger',{skip,timeout:120000},async t=>{
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
  await admin.query("INSERT INTO app.user_sessions(token_hash,csrf_secret_hash,user_id,selected_workspace_id,expires_at) VALUES($1,$2,$3,$4,now()+interval '7 days')",
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
  const extra:pg.Pool[]=[];
  const offset=async(value:string)=>{if(process.env.RL72_MEDIA_CLOCK_CONTAINER)execFileSync('docker',['exec','-u','postgres',process.env.RL72_MEDIA_CLOCK_CONTAINER,'sh','-c',"printf '%s\\n' '"+value+"' > /tmp/rl72-native-clock"]);else await writeFile(process.env.RL72_MEDIA_CLOCK_FILE!,value+'\n');};
  try{
   const login=async(role:string)=>{await admin.query(`ALTER ROLE ${role} PASSWORD 'local-methods-test-only'`);const u=new URL(uri);u.username=role;u.password='local-methods-test-only';const pool=new pg.Pool({connectionString:u.toString(),max:2});extra.push(pool);return pool;};
   const adapter=await login('r72_content_adapter'),planning=await login('r72_public_social_command'),zernio=await login('r72_zernio_social_command'),social=await login('r72_owned_social_worker_command'),offline=await login('r72_worker');
   const output=(await a.owner.outputs(a.brand.id)).find(o=>o.jobId===jobId)!;
   await new PgLocalOutputReviewOwner(content,a.principal,env).review({workspaceId:a.brand.id,outputId:output.id,outputSha256:output.sha256,commandId:randomUUID(),expectedRevision:0,decision:'reviewed_private',rightsConfirmed:true,claimsConfirmed:true,disclosureConfirmed:true});
   const handoff=await new PgLocalVideoCanonicalHandoff(adapter,content,a.principal,{...env,RL72_MEDIA_CANONICAL_HANDOFF_ENABLED:'true'}).request({workspaceId:a.brand.id,outputId:output.id,outputSha256:output.sha256,reviewRevision:1,commandId:randomUUID(),title:'Native video proof',caption:'#ad Exact native video for this account',platform:'instagram'});
   const hash=createHash('sha256').update(a.principal.sessionToken).digest(),ctx={actorKind:'user' as const,workspaceId:a.brand.id,userId:a.principal.userId,requestId:'native-clock-approval',portalSessionTokenHash:hash};
   const canonical=new CompanyContentService({transactionRunner:{run:(context,operation,options)=>withTransaction(content,context,operation,{isolation:options.serializable?'serializable':'read committed'})}});
   for(const approval of [handoff.approval,handoff.postApproval])await canonical.decideApproval(ctx,{commandKey:'approve:'+randomUUID(),approvalRequestId:approval.approvalRequestId,decision:'approved'});
   const identity={sessionToken:a.principal.sessionToken,userId:a.principal.userId,workspaceId:a.brand.id,userEmail:'native@example.test'};
   const registry=createPgSeoBlogSocialRegistry({zernioPool:zernio,contentCommandPool:content,contentAdapterPool:adapter,identity,requestId:'native-register',zernioApiKey:'inert-native-test-key',reservedProfileIds:[],fetch:(async()=>Response.json({profiles:[{id:profile,name:'Native fixture profile',externalId:a.brand.id}]})) as typeof fetch});
   const profile=randomUUID().replaceAll('-','').slice(0,24);await registry.registerProfile(a.brand.id,'Native media',profile);
   const hook=createSeoBlogZernioWebhookBrands(zernio),binding=await hook.resolve(profile);assert.ok(binding);
   const accounts=['a'.repeat(24),'b'.repeat(24),'c'.repeat(24)],digest=(s:string)=>createHash('sha256').update(s).digest('hex');
   for(const account of accounts){const event=randomUUID();assert.equal((await hook.record({contract:ZERNIO_ACCOUNT_WEBHOOK_CONTRACT_VERSION,workspaceId:a.brand.id,connectionId:binding.connectionId,eventId:event,event:'account.connected',network:'instagram',occurredAt:new Date().toISOString(),providerProfileIdSha256:digest(profile),providerAccountIdSha256:digest(account),rawBodySha256:digest('raw:'+event),receiptSha256:digest('signed-test:'+event),providerEffects:'none'},binding)).ok,true);}
   const flags={...env,RL72_MEDIA_NATIVE_CALENDAR_ENABLED:'true'},planner=new PgNativeVideoPlanner(adapter,planning,zernio,a.principal,flags),jit=new PgNativeVideoJitWorker(offline,'native-clock-jit',flags);
   const scheduledFor=new Date(Date.now()+3*86400000).toISOString();
   const request=(account:string)=>({workspaceId:a.brand.id,commandId:randomUUID(),postVersionId:handoff.postDraft.contentVersionId,videoVersionId:handoff.draft.contentVersionId,connectionId:binding.connectionId,network:'instagram' as const,profileSha256:digest(profile),accountSha256:digest(account),scheduledFor});
   const firstRequest=request(accounts[0]!),positive=await planner.plan(firstRequest),negative=await planner.plan(request(accounts[1]!));
   const future=await planner.plan({...request(accounts[2]!),scheduledFor:new Date(Date.now()+4*86400000).toISOString()});
   assert.equal((await planner.plan(firstRequest)).jobId,positive.jobId);
   // Separate trigger-isolation fixture: canonical foreign keys remain enabled.
   // This cloned text-only row is NOT used as planner/claim/calling proof above or below.
   const isolated=await admin.connect();try{
    await isolated.query('BEGIN');const textJob=randomUUID();
    const columns=(await isolated.query("SELECT attname FROM pg_attribute WHERE attrelid='app.property_predator_owned_social_jobs'::regclass AND attnum>0 AND NOT attisdropped AND attgenerated='' ORDER BY attnum")).rows.map(r=>'"'+String(r.attname).replaceAll('"','""')+'"').join(',');
    await isolated.query(`INSERT INTO app.property_predator_owned_social_jobs(${columns}) SELECT ${columns.split(',').map(c=>'copy.'+c).join(',')} FROM app.property_predator_owned_social_jobs j CROSS JOIN LATERAL jsonb_populate_record(NULL::app.property_predator_owned_social_jobs,to_jsonb(j)||jsonb_build_object('id',$3::text,'idempotency_key_sha256',('\\x'||encode(public.digest($3::text,'sha256'),'hex')),'state','leased','lease_version',1,'lease_attempt_kind','publish','lease_expires_at',clock_timestamp()+interval '90 seconds')) copy WHERE j.workspace_id=$1 AND j.id=$2`,[a.brand.id,positive.jobId,textJob]);
    await isolated.query('REVOKE EXECUTE ON FUNCTION app_private.creative_media_job_has_native_video(uuid,uuid) FROM r72_owned_social_definer,r72_owned_social_worker_command');
    await isolated.query("SELECT set_config('app.workspace_id',$1,true),set_config('app.actor_kind','worker',true)",[a.brand.id]);
    await isolated.query('SET LOCAL ROLE r72_owned_social_definer');
    assert.equal((await isolated.query("UPDATE app.property_predator_owned_social_jobs SET state='calling' WHERE workspace_id=$1 AND id=$2 RETURNING state",[a.brand.id,textJob])).rows[0].state,'calling','text job bypasses media guard even with media context grants revoked');
    for(const state of ['failed','queued','cancelled'])assert.equal((await isolated.query('UPDATE app.property_predator_owned_social_jobs SET state=$3,lease_expires_at=NULL,lease_attempt_kind=NULL WHERE workspace_id=$1 AND id=$2 RETURNING state',[a.brand.id,textJob,state])).rows[0].state,state);
    console.log('R1 reproduction PASS: classifier EXECUTE revoked, text calling/fail/requeue/cancel unaffected');
   }finally{await isolated.query('ROLLBACK');isolated.release();}

   await assert.rejects(new PgNativeVideoPlanner(adapter,planning,zernio,b.principal,flags).plan({...firstRequest,workspaceId:b.brand.id,commandId:randomUUID()}),/approved|owner|workspace/iu);
   assert.equal(await jit.attest(a.brand.id),0,'no premature proof days before the slot');
   const repository=new PgZernioCalendarRepository(social,{workspaceId:a.brand.id,connectionId:binding.connectionId});
   assert.equal(await repository.claimOne({leaseToken:randomBytes(32),leaseSeconds:300,networks:['instagram']}),null);
   await offset('+3d');
   const before=(await admin.query('SELECT clock_timestamp() AS now')).rows[0].now;assert.ok(new Date(before).getTime()>Date.now()+2.99*86400000);
   assert.equal(await repository.claimOne({leaseToken:randomBytes(32),leaseSeconds:300,networks:['instagram']}),null,'elapsed planning attestations cannot authorize a call');
   assert.equal(await jit.attest(a.brand.id),2);
   const proofs=await admin.query("SELECT p.checked_at,p.expires_at,a.expires_at AS planning_expiry FROM app.public_social_revalidation_proofs p JOIN app.public_social_planning_intents i ON i.workspace_id=p.workspace_id AND i.id=p.intent_id JOIN app.company_content_source_attestations a ON a.workspace_id=i.workspace_id AND a.id=i.planning_source_attestation_id WHERE p.workspace_id=$1",[a.brand.id]);
   assert.equal(proofs.rows.length,2);for(const proof of proofs.rows){assert.equal(new Date(proof.expires_at).getTime()-new Date(proof.checked_at).getTime(),15*60000);assert.ok(new Date(proof.planning_expiry).getTime()<new Date(proof.checked_at).getTime()-2*86400000);}
   const claims=[];for(let n=0;n<2;n++){const token=randomBytes(32),claim=await repository.claimOne({leaseToken:token,leaseSeconds:300,networks:['instagram']});assert.ok(claim);claims.push({...claim,leaseToken:token});}
   const good=claims.find(c=>c.jobId===positive.jobId)!,bad=claims.find(c=>c.jobId===negative.jobId)!;assert.ok(good&&bad);
   const release=new PgNativeVideoReleaseOwner(content,a.principal,{...env,RL72_MEDIA_VIDEO_RELEASE_ENABLED:'true'});
   await release.decide({workspaceId:a.brand.id,jobId:bad.jobId,contentVersionId:handoff.draft.contentVersionId,commandId:randomUUID(),action:'withdraw',consent:true});
   await assert.rejects(repository.markCalling({...bad,providerEffectsEnabled:true,emergencyPaused:false}),/withdrawn|stale/iu);
   assert.equal((await admin.query('SELECT count(*)::int n FROM app.creative_media_native_call_checks WHERE workspace_id=$1 AND job_id=$2',[a.brand.id,bad.jobId])).rows[0].n,0);
   const storage=(await admin.query('SELECT blob_storage_key FROM app.company_content_versions WHERE workspace_id=$1 AND id=$2',[a.brand.id,handoff.draft.contentVersionId])).rows[0].blob_storage_key;
   assert.equal(sha(await new PgNativeVideoReleaseWorker(social,'native-bytes-proof').load(a.brand.id,good.jobId,storage,output.sha256)),output.sha256);
   assert.equal(await repository.markCalling({...good,providerEffectsEnabled:true,emergencyPaused:false}),true);
   assert.equal((await admin.query('SELECT state FROM app.property_predator_owned_social_jobs WHERE workspace_id=$1 AND id=$2',[a.brand.id,good.jobId])).rows[0].state,'calling');
   assert.equal((await admin.query('SELECT count(*)::int n FROM app.creative_media_native_call_checks WHERE workspace_id=$1 AND job_id=$2',[a.brand.id,good.jobId])).rows[0].n,1,'actual BEFORE UPDATE trigger recorded its successful check');
   assert.equal((await admin.query("SELECT tgenabled FROM pg_trigger WHERE tgname='creative_media_native_video_call_guard'")).rows[0].tgenabled,'O');
   await assert.rejects(social.query('SELECT * FROM app.creative_media_native_call_checks'),/permission denied/iu);
   await offset('+260160s');
   assert.equal(await withTransaction(admin,{actorKind:'worker',workspaceId:a.brand.id,requestId:'expired-native-proof'},async t=>(await t.query<{v:boolean}>('SELECT app_private.creative_media_video_ready($1,$2,$3,true) v',[a.brand.id,good.jobId,handoff.draft.contentVersionId])).rows[0]!.v),false,'expired JIT cannot authorize media');
   await new PgMediaErasureOwner(content,a.principal,{...env,RL72_MEDIA_RETENTION_ENABLED:'true'}).erase(a.brand.id,'source',upload.id);
   await offset('+345600s');assert.equal(await jit.attest(a.brand.id),0);
   const held=(await admin.query('SELECT state,current_proof_id FROM app.public_social_revalidation_jobs WHERE workspace_id=$1 AND intent_id=$2',[a.brand.id,future.intentId])).rows[0];assert.equal(held.state,'cancelled');assert.equal(held.current_proof_id,null);
   console.log(JSON.stringify({nativeCalendarProof:{daysElapsed:3,plannerCreated:true,originalAttestationsExpired:true,proofTtlMinutes:15,triggerFired:true,withdrawalBlocked:true,expiryBlocked:true,erasedFutureCancelled:true,scopeDenied:true,replicationRoleBypass:false,providerCalls:0}}));
  }finally{await offset('+0');for(const pool of extra)await pool.end();}
 }finally{await rm(temp,{recursive:true,force:true});await workerPool.end();await admin.end();await content.end();}
});
