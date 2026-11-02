import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { harness, OWNER, STRANGER, seedBrandSite } from './seo-blog-fixtures.js';
import { ResearchProviderError } from '../src/seo-blog/research.js';
import { editorialRecommendations, editorialRootIssue, legacyPlanningHold, programmeRun, researchDiagnostic } from '../src/seo-blog/programme.js';
import { SeoBlogEngine } from '../src/seo-blog/engine.js';
import type { SearchProvider } from '../src/seo-blog/research.js';

async function ready() {
  const h=harness();seedBrandSite(h.web,'https://harbour.example','deposits');
  const {brand}=await h.engine.createBrand(OWNER,{commandId:randomUUID(),name:'Harbour',website:'https://harbour.example'});
  await h.engine.updateSettings(OWNER,brand.id,brand.rowVersion,{budgets:{modelTokensPerMonth:2_000_000,searchCallsPerMonth:100,imagesPerMonth:0}});
  await h.engine.uploadKnowledge(OWNER,brand.id,{category:'product_facts',title:'Offers',pastedText:'Harbour Compliance Plan costs £49 per month.'});
  const p=await h.engine.extractBrandProfile(OWNER,brand.id);await h.engine.confirmProfile(OWNER,brand.id,p.version);
  const provider:SearchProvider=h.search;
  return {h,brand,provider,request:()=>h.engine.requestPlan(OWNER,brand.id,{commandId:randomUUID()})};
}
test('only two additional40101 retries persist60/300s across claims; every attempt is counted before the call and exhaustion survives tomorrow',async()=>{
  const f=await ready();let calls=0;
  f.h.search.search=async()=>{calls++;assert.equal((await f.h.engine.usage(OWNER,f.brand.id)).search_calls,calls);throw new ResearchProviderError(researchDiagnostic(40101,200,'task-12345678'),0.001);};
  const job=await f.request();await f.h.engine.tick('worker');
  let current=(await f.h.store.getJob(f.brand.id,job.id))!;assert.equal(current.state,'queued');assert.equal(programmeRun(current)!.retries,1);assert.equal(Date.parse(current.runAfter)-Date.parse(f.h.clock.now()),60_000);
  await f.h.engine.tick('worker');assert.equal(calls,1);
  f.h.clock.advance(60_000);await f.h.makeEngine().tick('restart');
  current=(await f.h.store.getJob(f.brand.id,job.id))!;assert.equal(programmeRun(current)!.retries,2);assert.equal(Date.parse(current.runAfter)-Date.parse(f.h.clock.now()),300_000);
  f.h.clock.advance(300_000);await f.h.engine.tick('worker');current=(await f.h.store.getJob(f.brand.id,job.id))!;
  assert.equal(current.state,'blocked');assert.equal(calls,3);assert.equal(programmeRun(current)!.attempts.length,3);
  assert.ok(programmeRun(current)!.attempts.every((a)=>a.providerReportedCost===0.001));assert.equal((await f.h.engine.listPlans(OWNER,f.brand.id)).length,0);
  const brand=await f.h.engine.getBrand(OWNER,f.brand.id);await f.h.engine.updateSettings(OWNER,f.brand.id,brand.rowVersion,{ongoingProduction:true});
  f.h.clock.advance(24*3600_000);await f.h.engine.runDaily(f.brand.id);await f.h.engine.tick('next-day');assert.equal(calls,3);
  assert.ok((await f.h.engine.getBrand(OWNER,f.brand.id)).settings.programme?.researchHold);
  await assert.rejects(f.request(),/explicitly resume/);await assert.rejects(f.h.engine.retryJob(OWNER,f.brand.id,job.id),/new intent/);
});
test('successful query receipts are reused on transient resume; database-only receipt retry does not spend or increment retry twice',async()=>{
  const f=await ready();const search=f.provider.search.bind(f.provider);const seen:string[]=[];let failed=false;
  f.provider.search=async(q,o)=>{seen.push(q);if(seen.length===2&&!failed){failed=true;throw new ResearchProviderError(researchDiagnostic(40101));}return search(q,o);};
  const boundary=f.h.store.programmeBoundary.bind(f.h.store);let lostAck=false;
  f.h.store.programmeBoundary=async(input)=>{const value=await boundary(input);if(value&&programmeRun(value)?.retries===1&&!lostAck){lostAck=true;throw new Error('lost receipt acknowledgement');}return value;};
  const job=await f.request();await f.h.engine.tick('worker');assert.ok(lostAck);assert.equal(programmeRun((await f.h.store.getJob(f.brand.id,job.id))!)!.retries,1);
  f.h.clock.advance(60_000);await f.h.engine.tick('restart');
  const current=(await f.h.store.getJob(f.brand.id,job.id))!;assert.equal(current.state,'done',current.error??'');
  assert.equal(seen.filter((q)=>q===seen[0]).length,1,'the first successful query was not purchased again');
  assert.equal((await f.h.engine.usage(OWNER,f.brand.id)).search_calls,seen.length);assert.equal((await f.h.engine.listPlans(OWNER,f.brand.id)).length,1);
  const usage=await f.h.engine.usage(OWNER,f.brand.id);await f.h.engine.runJob(current);assert.deepEqual(await f.h.engine.usage(OWNER,f.brand.id),usage);
});
test('unknown interrupted research is held on reclaim and a late response cannot revive it',async()=>{
  const f=await ready();const search=f.provider.search.bind(f.provider);let release!:()=>void;let entered!:()=>void;let calls=0;
  const gate=new Promise<void>((r)=>{release=r;});const started=new Promise<void>((r)=>{entered=r;});
  f.provider.search=async(q,o)=>{calls++;entered();await gate;return search(q,o);};
  const job=await f.request();const running=f.h.engine.tick('same-owner');await started;
  f.h.clock.advance(11*60_000);await f.h.makeEngine().tick('same-owner');
  assert.equal((await f.h.store.getJob(f.brand.id,job.id))!.state,'blocked');assert.equal(calls,1);
  release();await running;assert.equal((await f.h.store.getJob(f.brand.id,job.id))!.state,'blocked');
  assert.equal((await f.h.engine.usage(OWNER,f.brand.id)).search_calls,1);assert.equal((await f.h.engine.listPlans(OWNER,f.brand.id)).length,0);
});
test('source change during a planning model call records known tokens but applies no obsolete briefs or autoacceptance',async()=>{
  const f=await ready();const b=await f.h.engine.getBrand(OWNER,f.brand.id);await f.h.engine.updateSettings(OWNER,f.brand.id,b.rowVersion,{autoAcceptPlans:true,ongoingProduction:true});
  const original=f.h.llm.complete.bind(f.h.llm);let release!:()=>void;let entered!:()=>void;
  const gate=new Promise<void>((r)=>{release=r;});const started=new Promise<void>((r)=>{entered=r;});
  f.h.llm.complete=async(req)=>{if(req.meta?.stage==='SEO_BLOG_PLAN'){entered();await gate;}return original(req);};
  const job=await f.request();const running=f.h.engine.tick('worker');await started;
  const profile=(await f.h.engine.getProfile(OWNER,f.brand.id))!;await f.h.engine.editProfile(OWNER,f.brand.id,profile.version,{summary:'Owner corrected this profile during planning.'});
  const before=(await f.h.engine.usage(OWNER,f.brand.id)).model_tokens;release();await running;
  const current=(await f.h.store.getJob(f.brand.id,job.id))!;assert.equal(current.state,'blocked');assert.ok(programmeRun(current)!.modelReceipt);
  assert.ok((await f.h.engine.usage(OWNER,f.brand.id)).model_tokens>before);assert.equal((await f.h.store.listBriefs(f.brand.id)).length,0);assert.equal((await f.h.engine.listPlans(OWNER,f.brand.id)).length,0);
});
test('null editorial guidance preserves daily drafts; revoked sponsor is held without system UUID casting, and owner reauthorisation is explicit',async()=>{
  const f=await ready();const b=await f.h.engine.getBrand(OWNER,f.brand.id);await f.h.engine.updateSettings(OWNER,f.brand.id,b.rowVersion,{ongoingProduction:true,autoAcceptPlans:true});
  await f.h.engine.runDaily(f.brand.id);await f.h.engine.tick('worker');
  const [plan]=await f.h.engine.listPlans(OWNER,f.brand.id);assert.ok(plan);assert.equal(plan!.plan.programme!.structureSha,null);assert.equal(plan!.plan.status,'accepted');
  const g=await ready();const gb=await g.h.engine.getBrand(OWNER,g.brand.id);await g.h.engine.updateSettings(OWNER,g.brand.id,gb.rowVersion,{ongoingProduction:true});
  await g.h.engine.runDaily(g.brand.id);g.h.store.revoke(OWNER.userId,g.brand.id);await g.h.engine.tick('worker');
  assert.equal(g.h.search.calls,0);assert.ok((await g.h.store.listJobs(g.brand.id)).some((j)=>j.kind==='plan'&&j.state==='blocked'));
  g.h.store.grant(STRANGER.userId,g.brand.id);const newer=await g.h.engine.getBrand(STRANGER,g.brand.id);await g.h.engine.updateSettings(STRANGER,g.brand.id,newer.rowVersion,{ongoingProduction:true});
  assert.equal((await g.h.engine.getBrand(STRANGER,g.brand.id)).settings.programme!.authorisedBy,STRANGER.userId);
  assert.equal((await g.h.engine.getBrand(STRANGER,g.brand.id)).settings.programme!.researchHold??null,null);
  await g.h.engine.requestPlan(STRANGER,g.brand.id,{commandId:randomUUID()});await g.h.engine.tick('new-owner');assert.ok(g.h.search.calls>0);
});
test('editorial recommendations are deterministic across timestamp-only scans and unsupported PP roots remain unapproved',async()=>{
  const f=await ready();const first=await f.h.engine.refreshInventory(f.brand.id);
  const second=editorialRecommendations({...first,fetchedAt:'2027-01-01T00:00:00.000Z'});assert.equal(first.editorial!.scanSha,second.scanSha);assert.equal(first.editorial!.scanId,second.scanId);
  const destination=await f.h.engine.connectDestination(OWNER,f.brand.id,{type:'github_static',label:'Site',credential:'gh-token-fixture',config:{repository:'acme/site',branch:'main',publicBaseUrl:'https://harbour.example',blogPath:'blog',sitemapPath:'sitemap.xml'}});
  assert.match(editorialRootIssue({...destination,publicBaseUrl:'https://propertypredator.com'},'/investment-info')!,/supports \/blog only/);
  const b=await f.h.engine.getBrand(OWNER,f.brand.id);const c=first.editorial!.categories[0]!;
  const structure=await f.h.engine.approveEditorialStructure(OWNER,f.brand.id,{rowVersion:b.rowVersion,scanId:first.editorial!.scanId,scanSha:first.editorial!.scanSha,destinationId:destination.id,root:'/blog',categories:[{id:c.id,label:'Owner guides',slug:'owner-guides'}]});
  await f.h.engine.refreshInventory(f.brand.id);assert.equal((await f.h.engine.getBrand(OWNER,f.brand.id)).settings.programme!.structure!.sha,structure.sha);
  await assert.rejects(f.h.engine.approveEditorialStructure(OWNER,f.brand.id,{rowVersion:b.rowVersion,scanId:first.editorial!.scanId,scanSha:first.editorial!.scanSha,destinationId:destination.id,root:'/investment-info',categories:[{id:c.id,label:'Guides',slug:'guides'}]}),/changed/);
});
test('optional metrics are separately reserved, failures do not retry or invalidate source research, and no headroom means no metrics call',async()=>{
  for(const ceiling of [100,4]) {
    const f=await ready();const b=await f.h.engine.getBrand(OWNER,f.brand.id);await f.h.engine.updateSettings(OWNER,f.brand.id,b.rowVersion,{budgets:{...b.settings.budgets,searchCallsPerMonth:Math.max(ceiling,8)}});let calls=0;
    const worker=new SeoBlogEngine({store:f.h.store,llm:f.h.llm,search:f.h.search,transport:f.h.web,publishers:new Map(),vault:f.h.vault,now:f.h.clock.now,keywords:{mode:'live',metrics:async()=>{calls++;throw new Error('untrusted metrics response');}}});
    const queued=await f.request();if(ceiling===4){const current=await f.h.engine.getBrand(OWNER,f.brand.id);await f.h.engine.updateSettings(OWNER,f.brand.id,current.rowVersion,{budgets:{...current.settings.budgets,searchCallsPerMonth:4}});}await worker.tick('worker');const job=(await f.h.store.getJob(f.brand.id,queued.id))!;
    assert.equal(job.state,'done',job.error??'');assert.equal(programmeRun(job)!.retries,0);assert.ok(programmeRun(job)!.metricsWarning);assert.equal(calls,ceiling===4?0:1);
    assert.equal((await f.h.engine.usage(OWNER,f.brand.id)).search_calls,f.h.search.calls+calls);assert.equal((await f.h.engine.getBrand(OWNER,f.brand.id)).settings.programme?.researchHold??null,null);
    assert.ok((await f.h.engine.listPlans(OWNER,f.brand.id))[0]!.briefs.every((b)=>b.demand.kind==='qualitative'));
  }
});
test('an uncertain metrics attempt is not repeated on reclaim and its genuine late receipt is retained without rewriting the plan',async()=>{
  const f=await ready();let calls=0;let release!:()=>void;let entered!:()=>void;
  const gate=new Promise<void>((r)=>{release=r;});const started=new Promise<void>((r)=>{entered=r;});
  const worker=new SeoBlogEngine({store:f.h.store,llm:f.h.llm,search:f.h.search,transport:f.h.web,publishers:new Map(),vault:f.h.vault,now:f.h.clock.now,keywords:{mode:'live',metrics:async(queries)=>{calls++;entered();await gate;return queries.map((keyword)=>({keyword,volume:10,difficulty:1,cpc:null,source:'dataforseo' as const}));}}});
  const queued=await f.request();const first=worker.tick('old');await started;f.h.clock.advance(11*60_000);await worker.tick('new');
  const plansBefore=await f.h.engine.listPlans(OWNER,f.brand.id);assert.equal(plansBefore.length,1);assert.ok(plansBefore[0]!.briefs.every((b)=>b.demand.kind==='qualitative'));
  release();await first;assert.equal(calls,1);
  const final=(await f.h.store.getJob(f.brand.id,queued.id))!;assert.equal(final.state,'done');
  const metrics=programmeRun(final)!.attempts.find((a)=>a.kind==='metrics')!;assert.ok(metrics.receipt?.keywordMetrics?.length);assert.ok(metrics.uncertainAt);assert.ok(metrics.receivedAt);
  assert.deepEqual(await f.h.engine.listPlans(OWNER,f.brand.id),plansBefore);
});
test('latest unresolved legacy failure materialises once; explicit owner resume and a newer success prevent historical re-holds',async()=>{
  const f=await ready();const b=await f.h.engine.getBrand(OWNER,f.brand.id);await f.h.engine.updateSettings(OWNER,f.brand.id,b.rowVersion,{ongoingProduction:true});
  const old=await f.request();const failed=await f.h.store.updateJob({...old,state:'blocked',error:'Old generic research error'});
  const newer={...failed,id:randomUUID(),state:'done' as const,updatedAt:new Date(Date.parse(failed.updatedAt)+1).toISOString()};assert.equal(legacyPlanningHold([failed,newer],undefined),null);
  await Promise.all([f.h.engine.runDaily(f.brand.id),f.h.engine.runDaily(f.brand.id)]);
  const held=(await f.h.engine.getBrand(OWNER,f.brand.id)).settings.programme!.researchHold!;
  assert.equal(held.jobId,old.id);assert.equal(held.diagnostic,null);assert.equal(f.h.search.calls,0);
  assert.equal((await f.h.engine.activity(OWNER,f.brand.id)).filter((e)=>e.kind==='research.legacy_hold').length,1);
  f.h.clock.advance(1000);await f.h.engine.requestPlan(OWNER,f.brand.id,{commandId:randomUUID(),resumeHoldId:held.logicalRunId});await f.h.engine.tick('owner-resume');
  const acknowledged=(await f.h.engine.getBrand(OWNER,f.brand.id)).settings.programme!;assert.ok(acknowledged.researchAcknowledgements!.some((a)=>a.jobId===old.id));
  f.h.clock.advance(24*3600_000);await f.h.engine.runDaily(f.brand.id);assert.equal((await f.h.engine.getBrand(OWNER,f.brand.id)).settings.programme!.researchHold,null);
  assert.equal((await f.h.engine.activity(OWNER,f.brand.id)).filter((e)=>e.kind==='research.legacy_hold').length,1);
});
test('acknowledging the latest legacy failure suppresses older failures but not a genuinely newer failure',async()=>{
  const f=await ready();const first=await f.request();const older=await f.h.store.updateJob({...first,state:'blocked',error:'Older failure'});
  f.h.clock.advance(1000);const latest={...older,id:randomUUID(),state:'failed' as const,updatedAt:f.h.clock.now()};
  const acknowledgements=[{jobId:latest.id,intentId:randomUUID(),actorId:OWNER.userId,at:f.h.clock.now()}];
  assert.equal(legacyPlanningHold([older,latest],acknowledgements),null);
  f.h.clock.advance(1000);const newer={...latest,id:randomUUID(),updatedAt:f.h.clock.now()};
  assert.equal(legacyPlanningHold([older,latest,newer],acknowledgements)!.jobId,newer.id);
});

test('daily work cannot resurrect an older legacy failure during an explicitly resumed paid run',async()=>{
  const f=await ready();let b=await f.h.engine.getBrand(OWNER,f.brand.id);await f.h.engine.updateSettings(OWNER,f.brand.id,b.rowVersion,{ongoingProduction:true});
  const first=await f.request();await f.h.store.updateJob({...first,state:'blocked',error:'Older failure'});
  f.h.clock.advance(1000);await f.h.store.enqueueJob({...first,id:randomUUID(),idempotencyKey:`legacy:${randomUUID()}`,state:'failed',error:'Latest failure',updatedAt:f.h.clock.now()});
  await f.h.engine.runDaily(f.brand.id);b=await f.h.engine.getBrand(OWNER,f.brand.id);const hold=b.settings.programme!.researchHold!;
  const search=f.provider.search.bind(f.provider);let release!:()=>void;let entered!:()=>void;
  const gate=new Promise<void>((r)=>{release=r;});const started=new Promise<void>((r)=>{entered=r;});
  f.provider.search=async(q,o)=>{entered();await gate;return search(q,o);};
  f.h.clock.advance(1000);const resumed=await f.h.engine.requestPlan(OWNER,f.brand.id,{commandId:randomUUID(),resumeHoldId:hold.logicalRunId});
  const working=f.h.engine.tick('resumed-worker');await started;
  await Promise.all([f.h.engine.runDaily(f.brand.id),f.h.engine.runDaily(f.brand.id)]);
  assert.equal((await f.h.engine.getBrand(OWNER,f.brand.id)).settings.programme!.researchHold,null);
  assert.equal((await f.h.engine.activity(OWNER,f.brand.id)).filter((event)=>event.kind==='research.legacy_hold').length,1);
  release();await working;assert.equal((await f.h.store.getJob(f.brand.id,resumed.id))!.state,'done');
});

test('an already-claimed legacy task without new receipts is held rather than silently purchasing its work again',async()=>{
  const f=await ready();const job=await f.request();
  await f.h.store.claimJobs({brandId:f.brand.id,owner:'old-worker',now:f.h.clock.now(),leaseMs:600_000,limit:1});
  f.h.clock.advance(11*60_000);await f.h.engine.tick('upgraded-worker');
  const held=(await f.h.store.getJob(f.brand.id,job.id))!;assert.equal(held.state,'blocked');assert.equal(programmeRun(held)!.hold,'legacy_outcome_unknown');assert.equal(f.h.search.calls,0);assert.equal((await f.h.engine.usage(OWNER,f.brand.id)).search_calls,0);
});
test('zero-start profile, budget and pause blockers do not latch paid research; current owner corrections permit a fresh daily intent',async()=>{
  for(const control of ['profile','budget','pause']) {
    const f=await ready();let b=await f.h.engine.getBrand(OWNER,f.brand.id);await f.h.engine.updateSettings(OWNER,f.brand.id,b.rowVersion,{ongoingProduction:true});
    const job=await f.request();b=await f.h.engine.getBrand(OWNER,f.brand.id);
    if(control==='profile'){const p=(await f.h.engine.getProfile(OWNER,f.brand.id))!;await f.h.engine.editProfile(OWNER,f.brand.id,p.version,{summary:'Owner corrected brand context.'});}
    else if(control==='budget')await f.h.engine.updateSettings(OWNER,f.brand.id,b.rowVersion,{budgets:{...b.settings.budgets,modelTokensPerMonth:0}});
    else await f.h.engine.updateSettings(OWNER,f.brand.id,b.rowVersion,{pauseAll:true});
    await f.h.engine.tick('held');assert.equal((await f.h.store.getJob(f.brand.id,job.id))!.state,'blocked');assert.equal(f.h.search.calls,0);assert.equal((await f.h.engine.getBrand(OWNER,f.brand.id)).settings.programme?.researchHold??null,null);
    b=await f.h.engine.getBrand(OWNER,f.brand.id);
    if(control==='profile'){const p=(await f.h.engine.getProfile(OWNER,f.brand.id))!;await f.h.engine.confirmProfile(OWNER,f.brand.id,p.version);}
    else if(control==='budget')await f.h.engine.updateSettings(OWNER,f.brand.id,b.rowVersion,{budgets:{...b.settings.budgets,modelTokensPerMonth:2_000_000}});
    else await f.h.engine.updateSettings(OWNER,f.brand.id,b.rowVersion,{pauseAll:false});
    f.h.clock.advance(24*3600_000);await f.h.engine.runDaily(f.brand.id);await f.h.engine.tick('fresh-daily');assert.ok(f.h.search.calls>0);assert.equal((await f.h.store.getJob(f.brand.id,job.id))!.state,'blocked','the old snapshot was not revived');
  }
});
