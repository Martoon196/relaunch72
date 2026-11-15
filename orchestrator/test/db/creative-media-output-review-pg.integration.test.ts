/**
 * ISOLATED, disposable-PostgreSQL proof. Uses real signed-in owner sessions and
 * transaction-local RLS; synthetic media is never passed off as decoded video.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import pg from 'pg';
import {fixtureBrand} from '../rl72-method-fixtures.js';
import {PgSeoBlogStore} from '../../src/seo-blog/pg-store.js';
import {PgVideoAdmissionOwner,PgVideoAdmissionWorker} from '../../src/creative-studio/media-admission-pg-store.js';
import {PgMediaVideoOutputWorker} from '../../src/creative-studio/media-video-output-pg-store.js';
import {PgMediaOutputProbeWorker,PgMediaOutputReviewOwner} from '../../src/creative-studio/media-output-review.js';
import {VIDEO_PROBE_VERSION} from '../../src/creative-studio/media-source-probe.js';

const connection=process.env.RL72_METHODS_PG_TEST_URL;
const skip=!connection||process.env.RELAUNCH72_DATABASE_INTEGRATION!=='explicit-disposable-run'
  ?'Runs only against explicit disposable localhost PG':false;

test('media output technical probe and exact private review have independent tenant-safe receipts',{skip},async t=>{
 const url=new URL(connection!);
 assert.ok(['localhost','127.0.0.1'].includes(url.hostname));
 assert.equal(url.pathname,'/relaunch72_test');
 const admin=new pg.Pool({connectionString:connection,max:3});
 const contentUrl=new URL(url);
 contentUrl.username='r72_content_command';
 contentUrl.password='local-methods-test-only';
 const content=new pg.Pool({connectionString:contentUrl.toString(),max:4});

 async function seed(kind:'home'|'b2b'){
  const f=fixtureBrand(kind),actor=f.profile.confirmedBy!,token=randomUUID()+randomUUID();
  await admin.query("INSERT INTO app.organizations(id,name,slug,kind) VALUES($1,$2,$3,'direct_customer')",
    [f.brand.organizationId,f.brand.name,'media-review-org-'+f.brand.organizationId]);
  await admin.query("INSERT INTO app.users(id,email,status) VALUES($1,$2,'active')",
    [actor,actor+'@media-review.test']);
  await admin.query("INSERT INTO app.organization_memberships(organization_id,user_id,role,status) VALUES($1,$2,'owner','active')",
    [f.brand.organizationId,actor]);
  await admin.query("INSERT INTO app.workspaces(id,organization_id,name,slug) VALUES($1,$2,$3,$4)",
    [f.brand.id,f.brand.organizationId,f.brand.name,'media-review-'+f.brand.id]);
  await admin.query("INSERT INTO app.workspace_memberships(workspace_id,organization_id,user_id,role,status,source_organization_id) VALUES($1,$2,$3,'owner','active',$2)",
    [f.brand.id,f.brand.organizationId,actor]);
  await admin.query("INSERT INTO app.user_sessions(token_hash,csrf_secret_hash,user_id,selected_workspace_id,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')",
    [createHash('sha256').update(token).digest(),
     createHash('sha256').update('csrf'+token).digest(),actor,f.brand.id]);
  await admin.query("INSERT INTO app.seo_blog_brands(workspace_id,organization_id,created_by_user_id,settings) VALUES($1,$2,$3,$4)",
    [f.brand.id,f.brand.organizationId,actor,JSON.stringify(f.brand.settings)]);
  const principal={kind:'user' as const,userId:actor,requestId:'review-test',
    sessionToken:token,selectedWorkspaceId:f.brand.id};
  await new PgSeoBlogStore(content,principal).saveProfile(f.profile);
  return {...f,actor,principal,review:new PgMediaOutputReviewOwner(content,principal,{CREATIVE_MEDIA:'enabled'})};
 }
 try {
  const a=await seed('home'), b=await seed('b2b');
  await admin.query("UPDATE app_private.creative_media_global_policy SET enabled=true,monthly_microusd=5000000 WHERE policy_id=1");
  await admin.query(`INSERT INTO app.creative_media_access_grants
    (workspace_id,tier,source,valid_from,valid_until,max_job_microusd,monthly_video_microusd)
    VALUES($1,'agency_client','operator_trial',now()-interval '1 day',
      now()+interval '3 days',750000,2000000)`,[a.brand.id]);
  await admin.query("INSERT INTO app.creative_media_video_policy(workspace_id,enabled,monthly_microusd,per_job_microusd,max_pending) VALUES($1,true,2000000,750000,3)",[a.brand.id]);
  const commandId=randomUUID(),jobId=randomUUID();
  const approvedRequest={workspaceId:a.brand.id,commandId,
    sourceUrl:'https://www.youtube.com/watch?v=owner_review_fixture',
    durationSeconds:120,projectName:'Offline review receipt',
    rights:{rights:'owned' as const,evidenceRef:'owner-declared-license-evidence'}};
  await new PgVideoAdmissionOwner(content,a.principal).reserve({
    workspaceId:a.brand.id,commandId,jobId,kind:'vizard_clip',
    request:approvedRequest,estimatedMicrousd:400000,consent:true,
  });
  const worker=new PgVideoAdmissionWorker(admin,'review-worker-test');
  const claim=await worker.claim(a.brand.id,jobId);
  await worker.submitted(a.brand.id,jobId,claim.claimToken,'vizard-project-review-001');
  const bytes=Buffer.alloc(1024);
  bytes.writeUInt32BE(24,0);bytes.write('ftyp',4,'ascii');
  const sha256=createHash('sha256').update(bytes).digest('hex');
  const output=await new PgMediaVideoOutputWorker(admin,'review-capture-worker').capture({
    workspaceId:a.brand.id,jobId,claimToken:claim.claimToken,
    providerId:'vizard-project-review-001',slot:0,providerAssetId:'mock-result-private-review',
    media:{mime:'video/mp4',bytes,sha256},
  });
  const probe=new PgMediaOutputProbeWorker(admin,'review-probe-worker',
    {CREATIVE_MEDIA:'enabled',RL72_MEDIA_WORKER_ENABLED:'true'});
  await t.test('unprobed output cannot receive owner-private acceptance, and other tenant cannot review it',async()=>{
   const request={workspaceId:a.brand.id,outputId:output.id,outputSha256:sha256,
     commandId:randomUUID(),expectedRevision:0,decision:'reviewed_private' as const,
     rightsConfirmed:true,claimsConfirmed:true,disclosureConfirmed:true};
   await assert.rejects(a.review.review(request),/technically verified|invalid/iu);
   await assert.rejects(b.review.review({...request,commandId:randomUUID()}),/authorised|session|output/iu);
   assert.deepEqual(await b.review.list(b.brand.id),[]);
   await assert.rejects(b.review.list(a.brand.id),/session|owner|authorised/iu);
   await assert.rejects(content.query('SELECT * FROM app.creative_media_output_reviews'),/permission denied/iu);
  });
  await t.test('worker records technical measurement, never merchant or publication verification',async()=>{
   const mockMeasure=async()=>({status:'verified_technical' as const,
     checkerVersion:VIDEO_PROBE_VERSION,
     durationMs:30000,width:1280,height:720,frameRate:30,
     videoCodec:'h264',audioPresent:true});
   const result=await probe.probe(a.brand.id,output.id,mockMeasure);
   assert.deepEqual(result,{status:'verified_technical',replayed:false});
   await assert.rejects(probe.probe(a.brand.id,output.id,mockMeasure),/already measured/iu);
   await assert.rejects(probe.probe(b.brand.id,output.id,mockMeasure),/not found|already measured/iu);
  });
  await t.test('owner decisions bind exact SHA, are idempotent, versioned, and may be withdrawn',async()=>{
   const review={workspaceId:a.brand.id,outputId:output.id,outputSha256:sha256,
     commandId:randomUUID(),expectedRevision:0,decision:'reviewed_private' as const,
     rightsConfirmed:true,claimsConfirmed:true,disclosureConfirmed:true};
   await assert.rejects(a.review.review({...review,outputSha256:'f'.repeat(64)}),/authorised|output/iu);
   const first=await a.review.review(review);
   assert.deepEqual(first,{outputId:output.id,revision:1,replayed:false,decision:'reviewed_private'});
   assert.deepEqual(await a.review.review(review),{...first,replayed:true});
   await assert.rejects(a.review.review({...review,commandId:randomUUID()}),/invalid|changed/iu);
   await assert.rejects(a.review.review({...review,expectedRevision:1}),/changed/iu);
   const withdrawn=await a.review.review({...review,commandId:randomUUID(),expectedRevision:1,
     decision:'withdrawn_private',rightsConfirmed:false,claimsConfirmed:false,disclosureConfirmed:false});
   assert.equal(withdrawn.revision,2);assert.equal(withdrawn.decision,'withdrawn_private');
   const current=await a.review.list(a.brand.id);
   assert.equal(current.length,1);
   assert.equal(current[0]?.decision,'withdrawn_private');
   assert.equal(current[0]?.technicalStatus,'verified_technical');
   await assert.rejects(content.query('UPDATE app.creative_media_output_reviews SET decision=$1 WHERE workspace_id=$2',
    ['reviewed_private',a.brand.id]),/permission denied/iu);
   const reopened=await a.review.review({...review,commandId:randomUUID(),expectedRevision:2});
   assert.equal(reopened.revision,3);
  });
 } finally {
  await admin.end();await content.end();
 }
});
