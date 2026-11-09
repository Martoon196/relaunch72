/** Disposable actual-role website target/repair boundary; no live provider calls. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import pg from 'pg';
import {openTestDatabase,testDatabaseSkipReason} from './database-helper.js';
import {withTransaction} from '../../src/db/transaction.js';
import {PgSeoBlogStore} from '../../src/seo-blog/pg-store.js';
import {SeoBlogEngine} from '../../src/seo-blog/engine.js';
import {GithubStaticPublisher} from '../../src/seo-blog/publishers/github-static.js';
import {harness,seedBrandSite} from '../seo-blog-fixtures.js';
const skip=testDatabaseSkipReason();
async function contentLogin(admin: pg.Pool): Promise<pg.Pool> {
  const password = `profile-proof-${randomUUID()}`;
  const statement = await admin.query<{ sql: string }>("SELECT pg_catalog.format('ALTER ROLE %I PASSWORD %L', 'r72_content_command', $1::text) AS sql", [password]);
  await admin.query(statement.rows[0]!.sql);
  const url = new URL(process.env.TEST_DATABASE_URL!); url.username = 'r72_content_command'; url.password = password;
  return new pg.Pool({ connectionString: url.toString(), max: 6, application_name: 'relaunch72-disposable-profile-async' });
}

async function seedOwner(admin: pg.Pool) {
  const org = randomUUID(), user = randomUUID(), home = randomUUID(), token = randomUUID() + randomUUID();
  await admin.query("INSERT INTO app.organizations(id,name,slug,kind) VALUES($1,'Async proof',$2,'direct_customer')", [org, `async-${org}`]);
  await admin.query("INSERT INTO app.users(id,email,status) VALUES($1,$2,'active')", [user, `async-${user}@example.test`]);
  await admin.query("INSERT INTO app.organization_memberships(organization_id,user_id,role,status) VALUES($1,$2,'owner','active')", [org,user]);
  await admin.query("INSERT INTO app.workspaces(id,organization_id,name,slug) VALUES($1,$2,'Home',$3)", [home,org,`home-${home}`]);
  await admin.query("INSERT INTO app.workspace_memberships(workspace_id,organization_id,user_id,role,status,source_organization_id) VALUES($1,$2,$3,'owner','active',$2)", [home,org,user]);
  await admin.query("INSERT INTO app.user_sessions(token_hash,csrf_secret_hash,user_id,selected_workspace_id,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')", [createHash('sha256').update(token).digest(),createHash('sha256').update(`csrf${token}`).digest(),user,home]);
  return { user, home, token };
}


test('009B actual role: exact owner/session target append, concurrent stale denial, worker begin snapshot and repair requester eligibility',{skip,timeout:180_000},async()=>{
  const admin=await openTestDatabase();const content=await contentLogin(admin);
  try{
    const alice=await seedOwner(admin),bob=await seedOwner(admin);const h=harness(new Date().toISOString());seedBrandSite(h.web,'https://harbour.example','deposits');
    const userStore=(owner:typeof alice)=>new PgSeoBlogStore(content,{kind:'user',userId:owner.user,selectedWorkspaceId:owner.home,sessionToken:owner.token,requestId:randomUUID()});
    const aStore=userStore(alice),bStore=userStore(bob),workerStore=new PgSeoBlogStore(content,{kind:'worker',requestId:'website-v2-proof'});
    const publishers=new Map([['github_static' as const,new GithubStaticPublisher(h.github.fetch,1000)]]);
    const deps={llm:h.llm,search:h.search,transport:h.web,publishers,vault:h.vault,now:h.clock.now,batchLimit:20};
    const a=new SeoBlogEngine({...deps,store:aStore}),b=new SeoBlogEngine({...deps,store:bStore}),worker=new SeoBlogEngine({...deps,store:workerStore});const actor={userId:alice.user};
    const {brand}=await a.createBrand(actor,{commandId:randomUUID(),name:'Website proof',website:'https://harbour.example'});
    const identity=await withTransaction(content,{actorKind:'worker',workspaceId:brand.id,requestId:'website-identity'},async(t)=>(await t.query("SELECT session_user,current_user,current_setting('app.actor_kind',true) AS actor,current_setting('app.user_id',true) AS user_id")).rows[0]);
    assert.equal(identity.session_user,'r72_content_command');assert.equal(identity.current_user,'r72_content_command');assert.equal(identity.actor,'worker');assert.equal(identity.user_id,'');
    await a.updateSettings(actor,brand.id,brand.rowVersion,{budgets:{modelTokensPerMonth:2_000_000,searchCallsPerMonth:100,imagesPerMonth:0}});await a.uploadKnowledge(actor,brand.id,{category:'product_facts',title:'Facts',pastedText:'Website proof Compliance Plan costs £49 per month.'});const profile=await a.extractBrandProfile(actor,brand.id);await a.confirmProfile(actor,brand.id,profile.version);
    const destination=await a.connectDestination(actor,brand.id,{type:'github_static',label:'Proof website',credential:'gh-token-fixture',config:{repository:'acme/site',branch:'main',publicBaseUrl:'https://harbour.example',blogPath:'blog',sitemapPath:'sitemap.xml'}});const inventory=await a.refreshInventory(brand.id);
    const current=await a.getBrand(actor,brand.id);const category=inventory.editorial!.categories[0]!;const structure=await a.approveEditorialStructure(actor,brand.id,{rowVersion:current.rowVersion,scanId:inventory.editorial!.scanId,scanSha:inventory.editorial!.scanSha,destinationId:destination.id,root:'/blog',categories:[{id:category.id,label:'Guides',slug:'guides'}]});
    await a.requestPlan(actor,brand.id,{commandId:randomUUID()});await worker.tick('plan');const [plan]=await a.listPlans(actor,brand.id);await a.acceptPlan(actor,brand.id,plan!.plan.id);await a.requestArticles(actor,brand.id,[plan!.briefs[0]!.id]);await worker.tick('write');const [entry]=await a.listArticles(actor,brand.id);const id=entry!.article.id;
    const before=(await a.getArticle(actor,brand.id,id)).version!;assert.equal(before.websiteTarget!.origin,'programme_default');const input={expectedVersionId:before.id,destinationId:destination.id,categoryIds:[structure.website!.categories[0]!.id]};
    await assert.rejects(b.reviewArticleWebsiteTarget({userId:bob.user},brand.id,id,input),{status:404});
    const outcomes=await Promise.allSettled([a.reviewArticleWebsiteTarget(actor,brand.id,id,input),a.reviewArticleWebsiteTarget(actor,brand.id,id,input)]);assert.equal(outcomes.filter((v)=>v.status==='fulfilled').length,1);assert.equal(outcomes.filter((v)=>v.status==='rejected').length,1);
    const reviewed=(await a.getArticle(actor,brand.id,id)).version!;assert.equal(reviewed.number,before.number+1);assert.equal((await a.getArticle(actor,brand.id,id)).article.approval,null);assert.deepEqual(reviewed.body,before.body);
    await assert.rejects(workerStore.reviewWebsiteTarget({brandId:brand.id,articleId:id,actorId:alice.user,destinationId:destination.id,expectedVersionId:reviewed.id,decide:()=>{throw new Error('worker impersonated owner');}}),{status:403});
    await a.approve(actor,brand.id,id,reviewed.id);const article=(await a.getArticle(actor,brand.id,id)).article;
    const tomorrow=new Date(Date.parse(h.clock.now())+24*3600_000).toISOString().slice(0,10);await a.schedule(actor,brand.id,id,article.rowVersion,{localDate:tomorrow,localTime:'09:00',destinationId:destination.id});const due=(await a.getArticle(actor,brand.id,id)).article.schedule!.publishAtUtc;h.clock.set(new Date(Date.parse(due)+1000).toISOString());await worker.tick('publish');
    const publication=(await workerStore.listPublications(brand.id,id))[0]!;assert.equal(publication.state,'published');assert.equal(publication.websiteSnapshot!.target!.deliverySha,reviewed.websiteTarget!.deliverySha);assert.equal(publication.websiteSnapshot!.reviewedIntentSha,reviewed.websiteTarget!.deliverySha);assert.equal(publication.websiteSnapshot!.destination.id,destination.id);
    h.github.files().set('sitemap.xml',h.github.files().get('sitemap.xml')!.replace(/<url>\s*<loc>[^<]+<\/loc>[\s\S]*?<\/url>/g,(block)=>block.includes(publication.publicUrl)?'':block));
    const repairId=randomUUID();await a.requestSitemapRepair(actor,brand.id,id,{publicationId:publication.id,commandId:repairId});
    assert.ok((await workerStore.listJobs(brand.id)).some((j)=>j.idempotencyKey===`sitemap-repair:${repairId}`&&j.kind==='publish'&&j.state==='queued'),'owner repair and worker wakeup committed atomically');
    await admin.query("UPDATE app.workspace_memberships SET status='revoked',revoked_at=clock_timestamp(),updated_at=clock_timestamp() WHERE workspace_id=$1 AND user_id=$2",[brand.id,alice.user]);const writes=h.github.refPatches;await worker.tick('revoked-repair');assert.equal(h.github.refPatches,writes);assert.equal((await workerStore.listPublications(brand.id,id))[0]!.sitemapRepair!.state,'held');
  }finally{await content.end();await admin.end();}
});
