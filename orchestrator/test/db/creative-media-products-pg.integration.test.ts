/**
 * Disposable PostgreSQL integration proof for migration 0156.
 * Uses actual r72_content_command, RLS, owner portal sessions and real SQL.
 * Never connect to production or a remote database.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { PgSeoBlogStore } from '../../src/seo-blog/pg-store.js';
import { PgCreativeMediaProductStore, type AffiliateMediaProductInput } from '../../src/creative-studio/media-product-pg-store.js';
import { fixtureBrand } from '../rl72-method-fixtures.js';
import { PgAmazonTrackingReports } from '../../src/creative-studio/amazon-report-pg-store.js';
import { PgVideoAdmissionOwner, PgVideoAdmissionWorker } from '../../src/creative-studio/media-admission-pg-store.js';
import { mediaRequestDigests } from '../../src/creative-studio/media-providers.js';
import { PgCreativeVideoSources } from '../../src/creative-studio/media-video-source-pg-store.js';
import { PgMediaVideoOutputWorker } from '../../src/creative-studio/media-video-output-pg-store.js';
import { PgMediaVideoOutputOwner } from '../../src/creative-studio/media-video-output-owner.js';
import { PgMediaEditStore } from '../../src/creative-studio/media-edit-pg-store.js';

const raw = process.env.RL72_METHODS_PG_TEST_URL;
const skip = !raw || process.env.RELAUNCH72_DATABASE_INTEGRATION !== 'explicit-disposable-run'
  ? 'Only run against explicit disposable local PostgreSQL' : false;

test('Affiliate catalogue: real PostgreSQL owner authority, immutable revisions, idempotent commands and RLS', {skip},async(t)=>{
  const u=new URL(raw!);
  assert.ok(['127.0.0.1','localhost'].includes(u.hostname));
  assert.equal(u.pathname,'/relaunch72_test');
  const admin=new pg.Pool({connectionString:raw,max:3});
  const contentUrl=new URL(raw!);
  contentUrl.username='r72_content_command';
  contentUrl.password='local-methods-test-only';
  const content=new pg.Pool({connectionString:contentUrl.toString(),max:4});

  async function seed(kind:'home'|'b2b'){
    const f=fixtureBrand(kind), actor=f.profile.confirmedBy!, token=randomUUID()+randomUUID();
    await admin.query("INSERT INTO app.organizations(id,name,slug,kind) VALUES($1,$2,$3,'direct_customer')",
      [f.brand.organizationId,f.brand.name,'media-org-'+f.brand.organizationId]);
    await admin.query("INSERT INTO app.users(id,email,status) VALUES($1,$2,'active')",[actor,actor+'@example.test']);
    await admin.query("INSERT INTO app.organization_memberships(organization_id,user_id,role,status) VALUES($1,$2,'owner','active')",
      [f.brand.organizationId,actor]);
    await admin.query("INSERT INTO app.workspaces(id,organization_id,name,slug) VALUES($1,$2,$3,$4)",
      [f.brand.id,f.brand.organizationId,f.brand.name,'media-'+f.brand.id]);
    await admin.query("INSERT INTO app.workspace_memberships(workspace_id,organization_id,user_id,role,status,source_organization_id) VALUES($1,$2,$3,'owner','active',$2)",
      [f.brand.id,f.brand.organizationId,actor]);
    await admin.query("INSERT INTO app.user_sessions(token_hash,csrf_secret_hash,user_id,selected_workspace_id,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')",
      [createHash('sha256').update(token).digest(),createHash('sha256').update('csrf'+token).digest(),actor,f.brand.id]);
    await admin.query("INSERT INTO app.seo_blog_brands(workspace_id,organization_id,created_by_user_id,settings) VALUES($1,$2,$3,$4)",
      [f.brand.id,f.brand.organizationId,actor,JSON.stringify(f.brand.settings)]);
    const principal={kind:'user' as const,userId:actor,requestId:'creative-media-pg-test',
      sessionToken:token,selectedWorkspaceId:f.brand.id};
    const blogs=new PgSeoBlogStore(content,principal);
    await blogs.saveProfile(f.profile);
    return {...f,actor,token,principal,store:new PgCreativeMediaProductStore(content,principal)};
  }

  const data:AffiliateMediaProductInput={
    network:'amazon_associates',
    merchantName:'Amazon UK',
    productName:'Emergency radio',
    productUrl:'https://www.amazon.co.uk/dp/EXAMPLE123',
    affiliateUrl:'https://amzn.to/EXAMPLE1',
    sourceRights:'none',
    evidenceSha256:null,
    productReviewed:true,
    channelEligible:false,
    mediaRightsConfirmed:false,
    disclosureVersion:'kit-1',
  };
  try{
    const a=await seed('home'),b=await seed('b2b');
    const productId=randomUUID(),commandId=randomUUID();
    await t.test('the exact same owner command is idempotent and new revision is immutable',async()=>{
      const first=await a.store.save({workspaceId:a.brand.id,productId,commandId,expectedRevision:0,product:data});
      assert.deepEqual(first,{replayed:false,productId,revision:1});
      assert.deepEqual(await a.store.save({workspaceId:a.brand.id,productId,commandId,expectedRevision:0,product:data}),
        {replayed:true,productId,revision:1});
      await assert.rejects(a.store.save({workspaceId:a.brand.id,productId,commandId,expectedRevision:0,
        product:{...data,productName:'Different radio'}}),/changed|reused/u);
      const second=await a.store.save({workspaceId:a.brand.id,productId,expectedRevision:1,
        product:{...data,productName:'Emergency radio — updated'}});
      assert.equal(second.revision,2);
      await assert.rejects(a.store.save({workspaceId:a.brand.id,productId,expectedRevision:1,product:data}),/changed/u);
      const list=await a.store.list(a.brand.id);
      assert.equal(list.length,1);
      assert.equal(list[0]?.revision,2);
      assert.equal(list[0]?.product_name,'Emergency radio — updated');
    });
    await t.test('another owner and direct content role cannot see or mutate the product',async()=>{
      assert.deepEqual(await b.store.list(b.brand.id),[]);
      await assert.rejects(b.store.get(a.brand.id,productId),/session|permission|owner|denied/iu);
      await assert.rejects(b.store.save({workspaceId:a.brand.id,productId,expectedRevision:2,product:data}),/session|permission|owner|denied/iu);
      await assert.rejects(content.query('SELECT * FROM app.creative_media_products'),/permission denied/iu);
      await assert.rejects(content.query('SELECT * FROM app.creative_media_product_commands'),/permission denied/iu);
    });
    await t.test('a signed-in owner cannot certify licensed rights without evidence',async()=>{
      assert.throws(()=>a.store.save({workspaceId:a.brand.id,expectedRevision:0,product:{
        ...data,sourceRights:'licensed',mediaRightsConfirmed:true,evidenceSha256:null,
      }}),/evidence/iu);
    });
    await t.test('Amazon earnings report import uses the same owner workspace and never fabricates a sale',async()=>{
      const report='Tracking ID\tClicks\tEarnings\nshop-21\t40\t£8.50\nOthers\t-\t£1.50\nhidden\t-\t-\n';
      const ours=new PgAmazonTrackingReports(content,a.principal);
      const other=new PgAmazonTrackingReports(content,b.principal);
      const input={workspaceId:a.brand.id,reportStart:'2026-11-01',reportEnd:'2026-11-15',
        originalText:report,commandId:randomUUID()};
      const first=await ours.save(input);
      assert.equal(first.replayed,false);
      assert.equal((await ours.save(input)).replayed,true);
      const summaries=await ours.list(a.brand.id);
      assert.equal(summaries.length,1);
      assert.equal(summaries[0]?.summary.knownEarningsMinor,1000);
      assert.equal(summaries[0]?.summary.unallocatedEarningsMinor,150);
      assert.equal(summaries[0]?.summary.unknownEarningsRows,1);
      assert.deepEqual(await other.list(b.brand.id),[]);
      await assert.rejects(other.list(a.brand.id),/session|permission|owner|denied/iu);
    });
    await t.test('paid video remains disabled until an actual workspace policy and signed owner approval',async()=>{
      const owner=new PgVideoAdmissionOwner(content,a.principal);
      const crossed=new PgVideoAdmissionOwner(content,b.principal);
      const commandId=randomUUID(),jobId=randomUUID();
      const mediaRequest={workspaceId:a.brand.id,commandId,
        sourceUrl:'https://www.youtube.com/watch?v=owned-video',durationSeconds:120,
        projectName:'Owned source for verified clipping',rights:{rights:'owned' as const,evidenceRef:'private-asset-001'}};
      const digests=mediaRequestDigests(mediaRequest);
      const request={workspaceId:a.brand.id,commandId,jobId,kind:'vizard_clip' as const,
        request:mediaRequest,estimatedMicrousd:500000,consent:true};
      await assert.rejects(owner.reserve(request),/disabled|budget/iu);
      assert.deepEqual(await owner.list(a.brand.id),[]);
      await assert.rejects(crossed.list(a.brand.id),/session|owner|permission/iu);
      await assert.rejects(content.query('SELECT * FROM app.creative_media_video_jobs'),/permission denied/iu);
      // Disposable test-only operator authorisation: production policy remains disabled by default.
      await admin.query("UPDATE app_private.creative_media_global_policy SET enabled=true,monthly_microusd=5000000 WHERE policy_id=1");
      // Operator provisioning proof: paid API is blocked without an active same-workspace grant.
      await admin.query(`INSERT INTO app.creative_media_access_grants
        (workspace_id,tier,source,valid_from,valid_until,max_job_microusd,monthly_video_microusd)
        VALUES($1,'agency_client','operator_trial',now()-interval '1 day',
          now()+interval '7 days',750000,1000000)`,[a.brand.id]);
      await admin.query('INSERT INTO app.creative_media_video_policy(workspace_id,enabled,monthly_microusd,per_job_microusd,max_pending) VALUES($1,true,1000000,750000,1)',[a.brand.id]);
      const first=await owner.reserve(request);
      assert.equal(first.replayed,false);
      const replay=await owner.reserve(request);
      assert.equal(replay.replayed,true);
      assert.equal(replay.id,jobId);
      const anotherCommand=randomUUID();
      await assert.rejects(owner.reserve({...request,commandId:anotherCommand,jobId:randomUUID(),
        request:{...mediaRequest,commandId:anotherCommand}}),/budget|cap/iu);
      assert.equal((await owner.list(a.brand.id)).length,1);
      assert.deepEqual(await crossed.list(b.brand.id),[]);
      // SQL worker leases are single-claim; only submitted jobs can settle,
      // unknowns cannot be resubmitted and final cost cannot exceed reserve.
      const worker=new PgVideoAdmissionWorker(admin,'creative-media-real-pg-worker');
      await assert.rejects(worker.claim(b.brand.id,jobId),/not found/iu);
      const claim=await worker.claim(a.brand.id,jobId);
      assert.equal(claim.id,jobId);
      assert.equal(claim.commandId,commandId);
      assert.equal(claim.payloadSha,digests.payloadSha256);
      assert.equal(claim.rightsSha,digests.rightsSha256);
      assert.deepEqual(JSON.parse(claim.reviewedRequestJson),mediaRequest);
      await assert.rejects(worker.claim(a.brand.id,jobId),/not available/iu);
      await assert.rejects(worker.completed(a.brand.id,jobId,claim.claimToken,100000),/Invalid worker transition/iu);
      const sent=await worker.submitted(a.brand.id,jobId,claim.claimToken,'vizard-job-1234');
      assert.equal(sent.state,'submitted');
      await assert.rejects(worker.submitted(a.brand.id,jobId,claim.claimToken,'vizard-job-1234'),/Invalid worker transition/iu);
      await assert.rejects(worker.completed(a.brand.id,jobId,claim.claimToken,600000),/Invalid worker transition/iu);
      const unknown=await worker.unknown(a.brand.id,jobId,claim.claimToken);
      assert.equal(unknown.state,'outcome_unknown');
      await assert.rejects(worker.submitted(a.brand.id,jobId,claim.claimToken,'vizard-job-1234'),/lease required/iu);
    });
    await t.test('workspace-scoped video source bytes are private and never provider-ready',async()=>{
      const store=new PgCreativeVideoSources(content,a.principal);
      const foreign=new PgCreativeVideoSources(content,b.principal);
      const bytes=Buffer.alloc(1024);bytes.writeUInt32BE(24,0);bytes.write('ftyp',4,'ascii');
      const input={workspaceId:a.brand.id,commandId:randomUUID(),bytes,fileName:'owner-footage.mp4',
        rights:'owned' as const,evidenceSha256:null,rightsConfirmed:true};
      const saved=await store.upload(input);
      assert.equal(saved.replayed,false);assert.equal(saved.state,'awaiting_probe');
      assert.equal((await store.upload(input)).replayed,true);
      await assert.rejects(store.upload({...input,fileName:'different.mp4'}),/replay|changed/u);
      const list=await store.list(a.brand.id);
      assert.equal(list.length,1);
      assert.equal(list[0]?.sha256,saved.sha256);
      const privatePreview=await store.load(a.brand.id,saved.id);
      assert.deepEqual(privatePreview.bytes,bytes);
      assert.equal(privatePreview.sha256,saved.sha256);
      await assert.rejects(foreign.load(b.brand.id,saved.id),/not found/iu);
      await assert.rejects(foreign.load(a.brand.id,saved.id),/owner|session|permission/iu);
      assert.equal((await admin.query("SELECT encode(b.sha256,'hex') AS digest FROM app.creative_media_source_videos s JOIN app.seo_blog_blobs b ON b.workspace_id=s.workspace_id AND b.id=s.blob_id WHERE s.workspace_id=$1",[a.brand.id])).rows[0].digest,saved.sha256);
      assert.deepEqual(await foreign.list(b.brand.id),[]);
      await assert.rejects(foreign.list(a.brand.id),/owner|session|permission/iu);
      await assert.rejects(content.query('SELECT * FROM app.creative_media_source_videos'),/permission denied/iu);
    });
    await t.test('provider outputs are privately captured once and cross-tenant playback stays forbidden',async()=>{
      // Create a new bounded job after the first one entered terminal unknown.
      await admin.query('UPDATE app.creative_media_video_policy SET monthly_microusd=3000000,max_pending=3 WHERE workspace_id=$1',[a.brand.id]);
      const owner=new PgVideoAdmissionOwner(content,a.principal);
      const worker=new PgVideoAdmissionWorker(admin,'media-output-pg-test');
      const commandId=randomUUID(),jobId=randomUUID();
      const source={workspaceId:a.brand.id,commandId,rights:{rights:'owned' as const,evidenceRef:'verified-test-owned-video'},
        sourceUrl:'https://www.youtube.com/watch?v=fixture-test-source',projectName:'Private result capture',
        durationSeconds:120};
      const reserved=await owner.reserve({workspaceId:a.brand.id,commandId,jobId,
        kind:'vizard_clip',request:source,estimatedMicrousd:400000,consent:true});
      assert.equal(reserved.state,'reserved');
      // Workspace policy now permits 3m, but the immutable monthly grant permits 1m.
      // The first unknown 500k plus this reserved 400k must hold 900k of that grant.
      const blockedCommand=randomUUID();
      await assert.rejects(owner.reserve({workspaceId:a.brand.id,commandId:blockedCommand,jobId:randomUUID(),kind:'vizard_clip',request:{...source,commandId:blockedCommand},estimatedMicrousd:200000,consent:true}),/budget|disabled/iu);
      const claim=await worker.claim(a.brand.id,jobId);
      await worker.submitted(a.brand.id,jobId,claim.claimToken,'provider-project-999');
      const bytes=Buffer.alloc(1024);bytes.writeUInt32BE(24,0);bytes.write('ftyp',4,'ascii');
      const sha256=createHash('sha256').update(bytes).digest('hex');
      const capture=new PgMediaVideoOutputWorker(admin,'media-output-pg-capture');
      const payload={workspaceId:a.brand.id,jobId,claimToken:claim.claimToken,
        providerId:'provider-project-999',slot:0,providerAssetId:'clip-001',
        media:{mime:'video/mp4' as const,bytes,sha256}};
      const first=await capture.capture(payload);
      assert.equal(first.replayed,false);assert.equal(first.state,'captured_unverified');
      assert.equal((await capture.capture(payload)).replayed,true);
      await assert.rejects(capture.capture({...payload,providerAssetId:'different-clip'}),/replay changed/iu);
      await assert.rejects(capture.capture({...payload,workspaceId:b.brand.id}),/submitted|permission|denied/iu);
      const local=new PgMediaVideoOutputOwner(content,a.principal);
      const foreign=new PgMediaVideoOutputOwner(content,b.principal);
      const listing=await local.list(a.brand.id);
      assert.equal(listing.length,1);assert.equal(listing[0]!.state,'captured_unverified');
      assert.deepEqual((await local.load(a.brand.id,first.id)).bytes,bytes);
      assert.deepEqual(await foreign.list(b.brand.id),[]);
      await assert.rejects(foreign.load(b.brand.id,first.id),/not found/iu);
      await assert.rejects(foreign.list(a.brand.id),/permission|owner|session/iu);
      await assert.rejects(content.query('SELECT * FROM app.creative_media_video_outputs'),/permission denied/iu);
      // A captured preview is NOT a completed financial settlement or creative approval.
      assert.equal((await owner.list(a.brand.id)).find(j=>j.id===jobId)?.state,'submitted');
    });
    await t.test('owner timelines store immutable revisions against same-workspace uploaded sources',async()=>{
      const sources=await new PgCreativeVideoSources(content,a.principal).list(a.brand.id);
      assert.equal(sources.length,1);
      const owner=new PgMediaEditStore(content,a.principal);
      const other=new PgMediaEditStore(content,b.principal);
      const projectId=randomUUID(),commandId=randomUUID();
      const plan={canvas:'portrait' as const,disclosure:'#ad',clips:[
        {startMs:0,endMs:5000,caption:'Private review only',transition:'cut' as const,speed:1 as const}]};
      const input={workspaceId:a.brand.id,projectId,commandId,expectedRevision:0,
        sourceId:sources[0]!.id,sourceSha256:sources[0]!.sha256,plan};
      const first=await owner.save(input);
      assert.equal(first.revision,1);assert.equal(first.replayed,false);
      assert.equal((await owner.save(input)).replayed,true);
      await assert.rejects(owner.save({...input,plan:{...plan,disclosure:'#ad new'}}),/reused|changed/iu);
      const version=await owner.get(a.brand.id,projectId);
      assert.equal(version?.plan.clips[0]?.caption,'Private review only');
      assert.equal(version?.planSha256.length,64);
      assert.equal((await owner.list(a.brand.id)).length,1);
      assert.deepEqual(await other.list(b.brand.id),[]);
      await assert.rejects(other.get(a.brand.id,projectId),/owner|permission|session/iu);
      await assert.rejects(content.query('SELECT * FROM app.creative_media_edit_projects'),/permission denied/iu);
      assert.equal((await owner.save({...input,commandId:randomUUID(),expectedRevision:1,
        plan:{...plan,clips:[{...plan.clips[0]!,caption:'Edited caption'}]}})).revision,2);
    });
    await t.test('unauthenticated direct SQL function never reveals catalogue',async()=>{
      await assert.rejects(content.query("SELECT app_private.creative_media_product_command($1,NULL,'list','{}'::jsonb)",
        [a.brand.id]),/owner|permission|denied/iu);
    });
  }finally{await admin.end();await content.end();}
});
