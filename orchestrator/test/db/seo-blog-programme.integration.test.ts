/** Disposable actual-role programme research/approval proof; no live provider calls. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { openTestDatabase, testDatabaseSkipReason } from './database-helper.js';
import { withTransaction } from '../../src/db/transaction.js';
import { PgSeoBlogStore } from '../../src/seo-blog/pg-store.js';
import { SeoBlogEngine } from '../../src/seo-blog/engine.js';
import { programmeRun, researchDiagnostic } from '../../src/seo-blog/programme.js';
import { ResearchProviderError } from '../../src/seo-blog/research.js';
import type { SearchProvider } from '../../src/seo-blog/research.js';
import { harness, seedBrandSite } from '../seo-blog-fixtures.js';
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


test('009A actual role: source receipts, global retry budget, atomic reservations, owner isolation, durable hold and worker daily sponsor', {skip,timeout:180_000},async()=>{
  const admin=await openTestDatabase();const content=await contentLogin(admin);
  try {
    const alice=await seedOwner(admin),bob=await seedOwner(admin);const h=harness(new Date().toISOString());seedBrandSite(h.web,'https://harbour.example','deposits');
    const storeFor=(owner:typeof alice)=>new PgSeoBlogStore(content,{kind:'user',userId:owner.user,selectedWorkspaceId:owner.home,sessionToken:owner.token,requestId:randomUUID()});
    const deps={llm:h.llm,search:h.search,transport:h.web,publishers:new Map(),vault:h.vault,now:h.clock.now};
    const aStore=storeFor(alice),bStore=storeFor(bob),workerStore=new PgSeoBlogStore(content,{kind:'worker',requestId:randomUUID()});
    const a=new SeoBlogEngine({...deps,store:aStore}),b=new SeoBlogEngine({...deps,store:bStore}),worker=new SeoBlogEngine({...deps,store:workerStore});
    const actorA={userId:alice.user},actorB={userId:bob.user};
    const brandA=(await a.createBrand(actorA,{commandId:randomUUID(),name:'Harbour',website:'https://harbour.example'})).brand;
    const brandB=(await b.createBrand(actorB,{commandId:randomUUID(),name:'Harbour',website:'https://harbour.example'})).brand;
    for(const [engine,actor,brand]of [[a,actorA,brandA],[b,actorB,brandB]]as const){
      await engine.updateSettings(actor,brand.id,brand.rowVersion,{budgets:{modelTokensPerMonth:2_000_000,searchCallsPerMonth:100,imagesPerMonth:0}});
      await engine.uploadKnowledge(actor,brand.id,{category:'product_facts',title:'Own facts',pastedText:'Harbour Compliance Plan costs £49 per month.'});
      const p=await engine.extractBrandProfile(actor,brand.id);await engine.confirmProfile(actor,brand.id,p.version);
    }
    await assert.rejects(b.getBrand(actorB,brandA.id),{status:404});
    const identity=await withTransaction(content,{actorKind:'worker',workspaceId:brandA.id,requestId:'009a-identity'},async(t)=>(await t.query("SELECT session_user,current_user,current_setting('app.actor_kind',true) AS actor,current_setting('app.user_id',true) AS user_id,current_setting('app.workspace_id',true) AS workspace_id")).rows[0]);
    assert.equal(identity.session_user,'r72_content_command');assert.equal(identity.current_user,'r72_content_command');assert.equal(identity.actor,'worker');assert.equal(identity.user_id,'');assert.equal(identity.workspace_id,brandA.id);
    const provider:SearchProvider=h.search;const original=provider.search.bind(provider);const queries:string[]=[];let failures=0;
    provider.search=async(q,o)=>{
      queries.push(q);
      const count=await admin.query("SELECT coalesce(sum(amount),0)::int AS n FROM app.seo_blog_usage WHERE workspace_id=$1 AND kind='search_calls'",[brandA.id]);
      assert.equal(count.rows[0].n,queries.length,'reservation is committed before transport');
      if(queries.length>1&&failures<2){failures++;throw new ResearchProviderError(researchDiagnostic(40101,200,'pg-task-12345678'),0.002);}
      return original(q,o);
    };
    const job=await a.requestPlan(actorA,brandA.id,{commandId:randomUUID()});
    await assert.rejects(workerStore.programmeBoundary({brandId:brandA.id,jobId:job.id,authority:{origin:'manual',sponsorUserId:bob.user},now:h.clock.now(),decide:()=>{throw new Error('foreign authority reached callback');}}),/requester does not match/);
    const boundary=workerStore.programmeBoundary.bind(workerStore);let lostAck=false;
    workerStore.programmeBoundary=async(input)=>{const result=await boundary(input);if(result&&programmeRun(result)?.retries===1&&!lostAck){lostAck=true;throw new Error('lost known response acknowledgement');}return result;};
    await worker.tick('worker');assert.ok(lostAck);let state=(await workerStore.getJob(brandA.id,job.id))!;assert.equal(state.state,'queued');assert.equal(programmeRun(state)!.retries,1);
    h.clock.advance(60_000);await worker.tick('restart-1');state=(await workerStore.getJob(brandA.id,job.id))!;assert.equal(programmeRun(state)!.retries,2);
    h.clock.advance(300_000);await worker.tick('restart-2');state=(await workerStore.getJob(brandA.id,job.id))!;assert.equal(state.state,'done',state.error??'');
    assert.equal(queries.filter((q)=>q===queries[0]).length,1);assert.equal(programmeRun(state)!.snapshot.structureSha,null);
    assert.equal((await a.listPlans(actorA,brandA.id)).length,1);assert.equal((await b.listPlans(actorB,brandB.id)).length,0);
    const before=queries.length;await worker.runJob(state);assert.equal(queries.length,before);
    const ledger=await admin.query("SELECT reference,count(*)::int AS n FROM app.seo_blog_usage WHERE workspace_id=$1 AND kind='search_calls' GROUP BY reference",[brandA.id]);assert.equal(ledger.rows.length,before);assert.ok(ledger.rows.every((r)=>r.n===1));

    // A known provider failure exhausts one run; the next daily pass cannot repurchase it.
    let blockedCalls=0;provider.search=async()=>{blockedCalls++;throw new ResearchProviderError(researchDiagnostic(40101));};
    const heldJob=await a.requestPlan(actorA,brandA.id,{commandId:randomUUID()});await worker.tick('held-1');h.clock.advance(60_000);await worker.tick('held-2');h.clock.advance(300_000);await worker.tick('held-3');
    assert.equal((await workerStore.getJob(brandA.id,heldJob.id))!.state,'blocked');assert.equal(blockedCalls,3);
    const currentA=await a.getBrand(actorA,brandA.id);await a.updateSettings(actorA,brandA.id,currentA.rowVersion,{ongoingProduction:true});
    h.clock.advance(24*3600_000);await worker.runDaily(brandA.id);await worker.tick('tomorrow');assert.equal(blockedCalls,3);
    const hold=(await a.getBrand(actorA,brandA.id)).settings.programme!.researchHold!;assert.equal(hold.jobId,heldJob.id);
    await assert.rejects(a.retryJob(actorA,brandA.id,heldJob.id),/new intent/);
    await assert.rejects(b.requestPlan(actorB,brandA.id,{commandId:randomUUID(),resumeHoldId:hold.logicalRunId}),{status:404});

    // Daily work derives an eligible UUID sponsor under the worker identity, never literal system.
    provider.search=original;
    const currentB=await b.getBrand(actorB,brandB.id);await b.updateSettings(actorB,brandB.id,currentB.rowVersion,{ongoingProduction:true,autoAcceptPlans:true});
    await worker.runDaily(brandB.id);
    const daily=(await workerStore.listJobs(brandB.id)).find((j)=>j.kind==='plan')!;assert.equal(daily.payload.requestedBy,'system');
    await admin.query("UPDATE app.workspace_memberships SET status='revoked' WHERE workspace_id=$1 AND user_id=$2",[brandB.id,bob.user]);
    const searchBefore=h.search.calls;await worker.tick('revoked-daily');assert.equal(h.search.calls,searchBefore);
    assert.equal((await workerStore.getJob(brandB.id,daily.id))!.state,'blocked');
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM app.seo_blog_usage WHERE workspace_id=$1 AND kind='search_calls'",[brandB.id])).rows[0].n,0);
  }finally{await content.end();await admin.end();}
});
