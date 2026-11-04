/** Real disposable PostgreSQL; never accepts production or a remote database. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { CampaignCreator, EMAIL_CAMPAIGN_SCHEMA, campaignProblems } from '../../src/seo-blog/campaign-creator.js';
import { PgCampaignCreatorStore } from '../../src/seo-blog/campaign-creator-store.js';
import { PgMethodStore } from '../../src/seo-blog/method-store.js';
import { PgSeoBlogStore } from '../../src/seo-blog/pg-store.js';
import { MethodController, libraryPins, methodHash, methodRunFor } from '../../src/seo-blog/method-packs.js';
import { callJson, dataBlock, profileForPrompt } from '../../src/seo-blog/generation.js';
import { loadPrompt } from '../../src/stages/prompt.js';
import { fixtureBrand } from '../rl72-method-fixtures.js';
import { UpgradeFixtureModel, campaignBrief } from '../rl72-upgrade-fixtures.js';

const raw=process.env.RL72_METHODS_PG_TEST_URL;
const skip=!raw||process.env.RELAUNCH72_DATABASE_INTEGRATION!=='explicit-disposable-run'?'Explicit disposable creator PostgreSQL run only.':false;
test('RL72 creators: real owner sessions, atomic allowance reservations, immutable revisions and recoverable generation', {skip},async t=>{
 const target=new URL(raw!);assert(['localhost','127.0.0.1'].includes(target.hostname));assert.equal(target.pathname,'/relaunch72_test');
 const admin=new pg.Pool({connectionString:raw,max:3});const u=new URL(raw!);u.username='r72_content_command';u.password='local-methods-test-only';const pool=new pg.Pool({connectionString:u.toString(),max:4});
 async function fixture(kind:'home'|'b2b'='home'){
  const f=fixtureBrand(kind),actor=f.profile.confirmedBy!,token=randomUUID()+randomUUID();
  await admin.query("INSERT INTO app.organizations(id,name,slug,kind) VALUES($1,$2,$3,'direct_customer')",[f.brand.organizationId,f.brand.name,'org-'+f.brand.organizationId]);
  await admin.query("INSERT INTO app.users(id,email,status) VALUES($1,$2,'active')",[actor,actor+'@example.test']);
  await admin.query("INSERT INTO app.organization_memberships(organization_id,user_id,role,status) VALUES($1,$2,'owner','active')",[f.brand.organizationId,actor]);
  await admin.query('INSERT INTO app.workspaces(id,organization_id,name,slug) VALUES($1,$2,$3,$4)',[f.brand.id,f.brand.organizationId,f.brand.name,'creator-'+f.brand.id]);
  await admin.query("INSERT INTO app.workspace_memberships(workspace_id,organization_id,user_id,role,status,source_organization_id) VALUES($1,$2,$3,'owner','active',$2)",[f.brand.id,f.brand.organizationId,actor]);
  await admin.query("INSERT INTO app.user_sessions(token_hash,csrf_secret_hash,user_id,selected_workspace_id,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')",[createHash('sha256').update(token).digest(),createHash('sha256').update('csrf'+token).digest(),actor,f.brand.id]);
  await admin.query('INSERT INTO app.seo_blog_brands(workspace_id,organization_id,created_by_user_id,settings) VALUES($1,$2,$3,$4)',[f.brand.id,f.brand.organizationId,actor,JSON.stringify(f.brand.settings)]);
  await admin.query("INSERT INTO app.seo_blog_method_private_organizations(organization_id,evidence) VALUES($1,'Explicit test-only owned organization')",[f.brand.organizationId]);
  const principal={kind:'user' as const,userId:actor,requestId:'creator-pg-test',sessionToken:token,selectedWorkspaceId:f.brand.id};
  const blogs=new PgSeoBlogStore(pool,principal),methods=new PgMethodStore(pool,principal),store=new PgCampaignCreatorStore(pool,principal),model=new UpgradeFixtureModel(),controller=new MethodController(methods,true);
  await blogs.saveProfile(f.profile);await methods.assign(f.brand.id,0,libraryPins('0.1.1'));
  return {...f,actor,token,blogs,methods,store,model,controller,creator:new CampaignCreator(store,blogs,controller,model)};
 }
 try{
  const a=await fixture(),b=await fixture('b2b');
  await t.test('runtime is table-blind and cannot assume the definer',async()=>{
   for(const name of ['campaigns','versions'])await assert.rejects(pool.query('SELECT * FROM app.seo_blog_creator_'+name),{code:'42501'});
   assert.equal((await pool.query("SELECT pg_has_role(current_user,'r72_seo_method_definer','MEMBER') AS allowed")).rows[0].allowed,false);
   const forced=await admin.query("SELECT relforcerowsecurity FROM pg_class WHERE oid IN ('app.seo_blog_creator_campaigns'::regclass,'app.seo_blog_creator_versions'::regclass)");assert(forced.rows.every(r=>r.relforcerowsecurity));
  });
  let email=await a.creator.create(a.actor,a.brand.id,randomUUID(),campaignBrief(a.profile));
  await t.test('email draft binds to exact receipt and charges accepted usage once',async()=>{
   assert.equal(email.state,'draft');const receipt=await a.methods.receipt(a.brand.id,email.version!.methodReceiptId!);assert.equal(receipt!.resultHash,email.version!.contentSha);assert(receipt!.resultText);
   const usage=await admin.query("SELECT amount FROM app.seo_blog_usage WHERE workspace_id=$1 AND reference=$2",[a.brand.id,'method-cost:'+receipt!.id]);assert.equal(usage.rowCount,1);assert.equal(Number(usage.rows[0].amount),250);
   const row=await admin.query('SELECT reserved_tokens FROM app.seo_blog_creator_campaigns WHERE workspace_id=$1 AND id=$2',[a.brand.id,email.id]);assert.equal(Number(row.rows[0].reserved_tokens),0);
  });
  await t.test('owner approvals are exact and edits clear approval while retaining old versions',async()=>{
   await assert.rejects(a.creator.export(a.actor,a.brand.id,email.id),/Review and approve/);
   email=await a.creator.approve(a.actor,a.brand.id,email.id,email.rowVersion,email.version!.contentSha,true);
   assert.match(await a.creator.export(a.actor,a.brand.id,email.id),/not sent or scheduled/);
   const old=email,body=structuredClone(email.version!.content);body.summary='A revised owner summary that still needs its own review.';
   email=await a.creator.edit(a.actor,a.brand.id,email.id,email.rowVersion,email.version!.contentSha,body);assert.equal(email.approval,null);assert.equal(email.version!.methodReceiptId,null);
   await assert.rejects(a.creator.approve(a.actor,a.brand.id,email.id,old.rowVersion,old.version!.contentSha,true),/changed/);
   const versions=await admin.query('SELECT number FROM app.seo_blog_creator_versions WHERE workspace_id=$1 AND campaign_id=$2 ORDER BY number',[a.brand.id,email.id]);assert.deepEqual(versions.rows.map(r=>r.number),[1,2]);
   await assert.rejects(admin.query("UPDATE app.seo_blog_creator_versions SET content_text='{}' WHERE workspace_id=$1",[a.brand.id]),/append-only/);
  });
  await t.test('foreign owners cannot read, edit, approve or recover another brand',async()=>{
   await assert.rejects(b.store.get(a.brand.id,email.id));await assert.rejects(b.store.approve(a.brand.id,email.id,email.rowVersion,email.version!.contentSha));await assert.rejects(b.store.recover(a.brand.id,email.id));
  });
  await t.test('two concurrent copies of one command produce one model call',async()=>{
   const id=randomUUID(),before=a.model.requests.length,brief=campaignBrief(a.profile);
   const results=await Promise.all([a.creator.create(a.actor,a.brand.id,id,brief),a.creator.create(a.actor,a.brand.id,id,brief)]);
   assert(results.every(r=>r.id===id));assert.equal(a.model.requests.length-before,1);
  });
  await t.test('advocacy writes optional request kits and retains exact owner incentive terms',async()=>{
   const r=await b.creator.create(b.actor,b.brand.id,randomUUID(),campaignBrief(b.profile,'advocacy'));assert.equal(r.state,'draft');assert.equal((r.version!.content as any).incentiveTerms,'None');
   const approved=await b.creator.approve(b.actor,b.brand.id,r.id,r.rowVersion,r.version!.contentSha,true);assert.equal(approved.state,'approved');
  });
  await t.test('a completed generation is recoverable after an interrupted asset save without another paid call',async()=>{
   const id=randomUUID(),brief=campaignBrief(a.profile),llm=await a.controller.prepare(a.model,{...a,stage:'email',stages:['email'],assetRef:'creator:'+id,sources:[],baselineTokens:350000});const run=methodRunFor(llm)!;
   await a.store.begin({id,brandId:a.brand.id,actorId:a.actor,brief,profileVersion:a.profile.version,factsSha:a.profile.factsSha,assignmentRevision:1,methodReceiptId:run.id,reservation:350000,inputHash:methodHash(JSON.stringify(brief))});
   const generated=await callJson(llm,{prompt:loadPrompt('seo-campaign-creator.md'),maxTokens:16000,user:[dataBlock('brand_profile',profileForPrompt(a.profile)),dataBlock('campaign_brief',brief)].join('\n'),schema:EMAIL_CAMPAIGN_SCHEMA,validate:v=>campaignProblems(brief,v,a.profile)});
   await assert.rejects(a.store.complete(a.brand.id,id,run.id,{...(generated.value as any),title:'A forged body'},'invalid'),/permission|receipt/i);
   const calls=a.model.requests.length,recovered=await a.creator.recover(a.actor,a.brand.id,id);assert.equal(recovered.state,'draft');assert.equal(recovered.version!.contentSha,(await a.methods.receipt(a.brand.id,run.id))!.resultHash);assert.equal(a.model.requests.length,calls);
   assert.equal((await a.creator.recover(a.actor,a.brand.id,id)).rowVersion,recovered.rowVersion);
  });
  await t.test('parallel different commands reserve the allowance atomically',async()=>{
   const c=await fixture();await admin.query("UPDATE app.seo_blog_brands SET settings=jsonb_set(settings,'{budgets,modelTokensPerMonth}','600000') WHERE workspace_id=$1",[c.brand.id]);
   const brief=campaignBrief(c.profile),start=()=>{const id=randomUUID();return c.store.begin({id,brandId:c.brand.id,actorId:c.actor,brief,profileVersion:c.profile.version,factsSha:c.profile.factsSha,assignmentRevision:1,methodReceiptId:randomUUID(),reservation:350000,inputHash:methodHash(JSON.stringify(brief))});};
   const results=await Promise.allSettled([start(),start()]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);
  });
  await t.test('transport uncertainty stays saved and reserved; replay does not call the provider',async()=>{
   const c=await fixture();let calls=0;const bad={mode:'mock' as const,async complete(){calls++;throw new Error('A fictional uncertain transport response');}};
   const creator=new CampaignCreator(c.store,c.blogs,c.controller,bad),id=randomUUID(),brief=campaignBrief(c.profile);
   const r=await creator.create(c.actor,c.brand.id,id,brief);assert.equal(r.state,'unknown');assert.equal(calls,1);await creator.create(c.actor,c.brand.id,id,brief);assert.equal(calls,1);
   const row=await admin.query('SELECT reserved_tokens FROM app.seo_blog_creator_campaigns WHERE workspace_id=$1 AND id=$2',[c.brand.id,id]);assert.equal(Number(row.rows[0].reserved_tokens),350000);await assert.rejects(c.store.approve(c.brand.id,id,r.rowVersion,''));
  });
  await t.test('session expiry during generation cannot save or approve a usable campaign',async()=>{
   const c=await fixture(),id=randomUUID();c.model.beforeReply=async()=>{await admin.query("UPDATE app.user_sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1",[createHash('sha256').update(c.token).digest()]);};
   await assert.rejects(c.creator.create(c.actor,c.brand.id,id,campaignBrief(c.profile)));
   const row=await admin.query('SELECT state,reserved_tokens,current_version FROM app.seo_blog_creator_campaigns WHERE workspace_id=$1 AND id=$2',[c.brand.id,id]);assert.equal(row.rows[0].current_version,0);assert.equal(Number(row.rows[0].reserved_tokens),350000);
  });
  await t.test('profile and assignment changes invalidate a future approval',async()=>{
   await a.blogs.saveProfile({...a.profile,version:2,factsSha:'e'.repeat(64)});
   await assert.rejects(a.store.approve(a.brand.id,email.id,email.rowVersion,email.version!.contentSha),/profile|context/i);
   await b.methods.assign(b.brand.id,1,[]);const row=(await b.store.list(b.brand.id))[0]!;
   await assert.rejects(b.store.approve(b.brand.id,row.id,row.rowVersion,row.version!.contentSha),/rules|profile/i);
  });
 }finally{await pool.end();await admin.end();}
});
