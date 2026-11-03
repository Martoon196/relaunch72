import test from 'node:test';
import assert from 'node:assert/strict';
import { websiteFixture } from './seo-blog-website-fixtures.js';
import { harness, OWNER, seedBrandSite } from './seo-blog-fixtures.js';
import type { CampaignCopyBoundaryInput } from '../src/seo-blog/campaign-generation.js';
import { randomUUID } from 'node:crypto';
import { campaignFixture } from './seo-blog-campaign-fixtures.js';
import { programmeSha } from '../src/seo-blog/programme.js';
import { nativeIdentity,nativeSeoCall } from './seo-blog-native-request.js';

test('known rejected campaign output debits exact usage once and applies labelled fallback after a DB-only receipt retry',async()=>{
  const f=await websiteFixture('github_static',undefined,async(h)=>{
    const original=h.llm.complete.bind(h.llm);
    h.llm.complete=async r=>{
      if(r.meta?.stage!=='SEO_BLOG_SOCIAL')return original(r);
      h.llm.calls.push('SEO_BLOG_SOCIAL');h.store.failNext.campaignCopyBoundary=1;
      return {text:'{"posts":[]}',tokensIn:321,tokensOut:123,model:'synthetic-model',stopReason:'end_turn'};
    };
  });
  const detail=await f.h.engine.getArticle(OWNER,f.brand.id,f.articleId);
  assert.equal(detail.article.campaign?.mode,'excerpt_fallback');assert.equal(detail.version?.promotionPack?.generation,null);
  const stored=(await f.h.store.getArticle(f.brand.id,f.articleId))!;
  assert.equal(stored.campaignGeneration?.receipt?.result.kind,'rejected');
  const used=await f.h.store.usageSince(f.brand.id,'model_tokens','2026-01-01T00:00:00.000Z');
  const records=(await f.h.store.latestProfile(f.brand.id))!.generation!;
  const plans=await f.h.store.listPlans(f.brand.id);const article=detail.version!.generation!;
  assert.equal(used,records.tokensIn+records.tokensOut+plans[0]!.generation!.tokensIn+plans[0]!.generation!.tokensOut+article.tokensIn+article.tokensOut+444);
  assert.equal(f.h.llm.calls.filter(s=>s==='SEO_BLOG_SOCIAL').length,1);
  await f.h.engine.runWrite(f.brand.id,{briefId:stored.briefId,requestedBy:OWNER.userId});
  assert.equal(await f.h.store.usageSince(f.brand.id,'model_tokens','2026-01-01T00:00:00.000Z'),used);
});

test('saved accepted receipt and body survive final apply rollback; restart calls neither article nor social model again',async()=>{
  let failed=false;
  const f=await websiteFixture('github_static',undefined,async(h)=>{
    const original=h.store.campaignCopyBoundary.bind(h.store);
    h.store.campaignCopyBoundary=(input:CampaignCopyBoundaryInput)=>original({...input,decide:s=>{
      const d=input.decide(s);if(d.version&&!failed){failed=true;throw new Error('synthetic apply rollback');}return d;
    }});
  });
  let article=(await f.h.store.listArticles(f.brand.id))[0]!;
  assert.equal(article.currentVersionId,null);assert.equal(article.campaignGeneration?.receipt?.result.kind,'accepted');
  const calls=f.h.llm.calls.length, used=await f.h.store.usageSince(f.brand.id,'model_tokens','2026-01-01T00:00:00.000Z');
  f.h.clock.advance(5*60_000);await f.h.engine.tick('recovery-worker');
  article=(await f.h.store.getArticle(f.brand.id,article.id))!;
  assert.equal(article.currentVersionId,article.campaignGeneration!.plannedVersionId);assert.equal(article.campaign?.variants.length,6);
  assert.equal(f.h.llm.calls.length,calls);assert.equal(await f.h.store.usageSince(f.brand.id,'model_tokens','2026-01-01T00:00:00.000Z'),used);
});

test('uncertain initial social request is durable, has no fabricated usage/result and generic Retry cannot call either model',async()=>{
  const f=await websiteFixture('github_static',undefined,async(h)=>{
    const original=h.llm.complete.bind(h.llm);
    h.llm.complete=async r=>{if(r.meta?.stage==='SEO_BLOG_SOCIAL'){h.llm.calls.push('SEO_BLOG_SOCIAL');throw new Error('synthetic transport uncertainty');}return original(r);};
  });
  const article=(await f.h.store.listArticles(f.brand.id))[0]!,job=(await f.h.store.listJobs(f.brand.id)).find(j=>j.kind==='write')!;
  assert.ok(article.campaignGeneration?.startedAt);assert.equal(article.campaignGeneration?.receipt,null);assert.equal(article.currentVersionId,null);assert.equal(job.state,'blocked');
  const calls=f.h.llm.calls.length;
  await assert.rejects(f.h.engine.retryJob(OWNER,f.brand.id,job.id),/uncertain outcome/);
  await assert.rejects(f.h.engine.runWrite(f.brand.id,{briefId:article.briefId,requestedBy:OWNER.userId}),/uncertain outcome/);
  for(const suffix of ['', '/campaign']){
    const page=await nativeSeoCall(f.h.engine,{who:nativeIdentity(OWNER.userId),method:'GET',path:`/portal/seo-blog/b/${f.brand.id}/articles/${article.id}${suffix}`,applicationName:'Relaunch72 Content'});
    assert.equal(page.status,200);assert.match(page.body,/Social copy awaiting a confirmed outcome/);assert.match(page.body,/Read saved blog text/);assert.match(page.body,/will not be repeated automatically/);assert.doesNotMatch(page.body,/Generate an image|Approve this post|Progress continues if you leave/);
  }
  assert.equal(f.h.llm.calls.length,calls);
});

test('a late known copy receipt is accounted but changed source cannot apply its saved article',async()=>{
  const f=await websiteFixture('github_static',undefined,async(h,brandId)=>{
    const original=h.llm.complete.bind(h.llm);
    h.llm.complete=async r=>{const result=await original(r);if(r.meta?.stage==='SEO_BLOG_SOCIAL'){
      const profile=(await h.store.latestProfile(brandId))!;await h.store.saveProfile({...profile,version:profile.version+1,confirmedAt:null});
    }return result;};
  });
  const article=(await f.h.store.listArticles(f.brand.id))[0]!;
  assert.ok(article.campaignGeneration?.receipt);assert.equal(article.currentVersionId,null);
  assert.equal((await f.h.store.listVersions(f.brand.id,article.id)).length,0);
  assert.equal(f.h.llm.calls.filter(s=>s==='SEO_BLOG_SOCIAL').length,1);
});

test('concurrent re-entry sees the durable start before either model; a reclaimed same-owner epoch cannot be adopted by the late result',async()=>{
  let reentered=false;
  const f=await websiteFixture('github_static',undefined,async(h,brandId)=>{
    const original=h.llm.complete.bind(h.llm);
    h.llm.complete=async r=>{
      if(r.meta?.stage==='SEO_BLOG_SOCIAL'){
        const a=(await h.store.listArticles(brandId))[0]!;
        await assert.rejects(h.engine.runWrite(brandId,{briefId:a.briefId,requestedBy:OWNER.userId}),/uncertain outcome/);reentered=true;
        const job=(await h.store.listJobs(brandId)).find(j=>j.kind==='write'&&j.state==='running')!;
        await h.store.updateJob({...job,attempts:job.attempts+1,progress:'Synthetic reclaimed epoch'});
      }
      return original(r);
    };
  });
  const article=(await f.h.store.listArticles(f.brand.id))[0]!,job=(await f.h.store.listJobs(f.brand.id)).find(j=>j.kind==='write')!;
  assert.equal(reentered,true);assert.ok(article.campaignGeneration?.receipt);assert.equal(article.currentVersionId,null);assert.equal(job.attempts,2);assert.equal(job.state,'running');assert.equal(job.progress,'Synthetic reclaimed epoch');
  assert.equal(f.h.llm.calls.filter(s=>s==='SEO_BLOG_ARTICLE').length,1);assert.equal(f.h.llm.calls.filter(s=>s==='SEO_BLOG_SOCIAL').length,1);
});

test('initial marker remains history while ordinary body and metadata edits allocate new immutable version identities',async()=>{
  let initialCalls=0;
  const f=await websiteFixture('github_static',undefined,async(h)=>{
    const original=h.llm.complete.bind(h.llm);h.llm.complete=async r=>{if(r.meta?.stage==='SEO_BLOG_SOCIAL'&&r.messages[0]!.content.includes('six_angle_campaign'))initialCalls++;return original(r);};
  });
  const first=(await f.h.engine.getArticle(OWNER,f.brand.id,f.articleId)).version!;
  await f.h.engine.approve(OWNER,f.brand.id,f.articleId,first.id);
  const edited=await f.h.engine.editArticle(OWNER,f.brand.id,f.articleId,first.id,{title:first.body.title+' — owner edit'});
  const metadata=await f.h.engine.editArticle(OWNER,f.brand.id,f.articleId,edited.id,{metaDescription:edited.body.metaDescription+' Further context.'});
  assert.equal(new Set([first.id,edited.id,metadata.id]).size,3);assert.equal(metadata.number,3);assert.equal(initialCalls,1);
  const article=(await f.h.store.getArticle(f.brand.id,f.articleId))!;assert.equal(article.approval,null);assert.equal(article.campaignGeneration!.plannedVersionId,first.id);assert.ok(article.campaignGeneration!.appliedAt);
});

test('same-brand initial copy reservations admit one of two concurrent calls and unknown reservations survive month rollover',async()=>{
  const f=await campaignFixture(),authority={origin:'manual' as const,sponsorUserId:OWNER.userId};
  let brand=(await f.h.store.getBrand(f.brand.id))!;brand=await f.h.store.updateBrand({...brand,settings:{...brand.settings,budgets:{...brand.settings.budgets,modelTokensPerMonth:6000}}});
  const articles=await Promise.all([0,1,2].map(async n=>{const id=randomUUID();return (await f.h.store.createArticle({...f.article,id,briefId:randomUUID(),slug:`copy-${n}`,currentVersionId:null,campaign:undefined})).article;}));
  let providerCalls=0;
  const start=async(id:string)=>{
    const saved=await f.h.store.campaignCopyBoundary({brandId:brand.id,articleId:id,authority,claim:null,now:f.h.clock.now(),decide:s=>{
      if(s.modelTokensUsed+s.modelTokensReserved+6000>s.brand.settings.budgets.modelTokensPerMonth)throw Error('No unreserved headroom');
      return {article:{...s.article,campaignGeneration:{nonce:randomUUID(),estimatedTokens:6000,plannedVersionId:randomUUID(),plannedVersionNumber:1,body:f.version.body,articleGeneration:null,profileSha:programmeSha(s.profile),knowledgeSha:programmeSha([]),authority,claim:null,capturedAt:f.h.clock.now(),startedAt:f.h.clock.now(),receipt:null,appliedAt:null}}};
    }});providerCalls++;return saved;
  };
  const results=await Promise.allSettled([start(articles[0]!.id),start(articles[1]!.id)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(providerCalls,1);
  f.h.clock.set('2026-12-01T00:01:00.000Z');await assert.rejects(start(articles[2]!.id),/unreserved/);assert.equal(providerCalls,1);
  const retained=(await f.h.store.listArticles(brand.id)).find(a=>a.campaignGeneration)!;
  const save=()=>f.h.store.campaignCopyBoundary({brandId:brand.id,articleId:retained.id,authority,claim:null,now:f.h.clock.now(),decide:s=>{
    const m=s.article.campaignGeneration!;if(m.receipt)return {article:s.article};
    return {article:{...s.article,campaignGeneration:{...m,receipt:{nonce:m.nonce,at:f.h.clock.now(),record:{mode:'simulated',model:'synthetic',promptVersion:'fixture',tokensIn:70,tokensOut:30},result:{kind:'rejected'}}}},usage:{brandId:brand.id,kind:'model_tokens',amount:100,at:f.h.clock.now(),reference:'exact-copy-receipt'}};
  }});
  await Promise.all([save(),save()]);assert.equal(await f.h.store.usageSince(brand.id,'model_tokens','2026-12-01T00:00:00.000Z'),100);
  await f.h.store.campaignCopyBoundary({brandId:brand.id,articleId:retained.id,authority,claim:null,now:f.h.clock.now(),decide:s=>{assert.equal(s.modelTokensReserved,0);assert.equal(s.modelTokensUsed,100);return {article:s.article};}});
});

test('lost receipt COMMIT acknowledgement recovers the same result with one debit and no second completion',async()=>{
  let lost=false,before=0;
  const f=await websiteFixture('github_static',undefined,async(h,brandId)=>{
    const complete=h.llm.complete.bind(h.llm),boundary=h.store.campaignCopyBoundary.bind(h.store);
    h.llm.complete=async r=>{if(r.meta?.stage==='SEO_BLOG_SOCIAL'){h.llm.calls.push('SEO_BLOG_SOCIAL');before=await h.store.usageSince(brandId,'model_tokens','2026-01-01T00:00:00.000Z');return {text:'{"posts":[]}',tokensIn:70,tokensOut:30,model:'synthetic',stopReason:'end_turn'};}return complete(r);};
    h.store.campaignCopyBoundary=async input=>{const saved=await boundary(input);if(saved.campaignGeneration?.receipt&&!saved.campaignGeneration.appliedAt&&!lost){lost=true;throw Error('Synthetic lost COMMIT ACK');}return saved;};
  });
  const article=(await f.h.store.getArticle(f.brand.id,f.articleId))!;assert.ok(article.currentVersionId);assert.equal(lost,true);assert.equal(f.h.llm.calls.filter(s=>s==='SEO_BLOG_SOCIAL').length,1);assert.equal(await f.h.store.usageSince(f.brand.id,'model_tokens','2026-01-01T00:00:00.000Z'),before+100);
});

test('copy authority follows the genuine write requester, independently of another managing owner who planned the topic',async()=>{
  for(const automatic of [false,true]){
    const h=harness(),bob={userId:randomUUID()};seedBrandSite(h.web,'https://harbour.example','deposits');
    const {brand}=await h.engine.createBrand(OWNER,{commandId:randomUUID(),name:'Dual-owner synthetic brand',website:'https://harbour.example'});h.store.grant(bob.userId,brand.id);
    await h.engine.updateSettings(OWNER,brand.id,brand.rowVersion,{budgets:{modelTokensPerMonth:2_000_000,searchCallsPerMonth:100,imagesPerMonth:0}});
    await h.engine.uploadKnowledge(OWNER,brand.id,{category:'product_facts',title:'Synthetic facts',pastedText:'Harbour Compliance Plan costs £49 per month.'});
    const profile=await h.engine.extractBrandProfile(OWNER,brand.id);await h.engine.confirmProfile(OWNER,brand.id,profile.version);
    await h.engine.requestPlan(OWNER,brand.id,{commandId:randomUUID()});await h.engine.tick('plan-owner-A');
    const [plan]=await h.engine.listPlans(bob,brand.id);await h.engine.acceptPlan(bob,brand.id,plan!.plan.id);
    if(automatic){const b=await h.engine.getBrand(bob,brand.id);await h.engine.updateSettings(bob,brand.id,b.rowVersion,{ongoingProduction:true,backlogCeiling:1});await h.engine.runDaily(brand.id);}
    else await h.engine.requestArticles(bob,brand.id,[plan!.briefs[0]!.id]);
    const write=(await h.store.listJobs(brand.id)).find(j=>j.kind==='write')!;assert.equal(write.payload.requestedBy,automatic?'system':bob.userId);
    await h.engine.tick('actual-content-worker');
    const article=(await h.store.listArticles(brand.id))[0]!;assert.ok(article.currentVersionId);assert.equal(article.campaignGeneration!.authority.sponsorUserId,bob.userId);assert.equal(article.campaignGeneration!.authority.origin,automatic?'daily':'manual');
    assert.equal(h.llm.calls.filter(s=>s==='SEO_BLOG_ARTICLE').length,1);assert.equal(h.llm.calls.filter(s=>s==='SEO_BLOG_SOCIAL').length,1);assert.equal(h.github.refPatches,0);
    const id=randomUUID(),briefId=randomUUID(),jobId=randomUUID();
    const fakeArticle=(await h.store.createArticle({...article,id,briefId,slug:`forged-${id}`,currentVersionId:null,campaign:undefined,campaignGeneration:undefined})).article;
    const actual=await h.store.enqueueJob({...write,id:jobId,idempotencyKey:`forged-proof:${jobId}`,payload:{briefId,requestedBy:automatic?'system':bob.userId},state:'queued',leaseOwner:null,leaseExpiresAt:null,attempts:0,rowVersion:1});
    // Active A membership is not permission to impersonate B/system on a fresh job.
    let decided=false;
    await assert.rejects(h.store.campaignCopyBoundary({brandId:brand.id,articleId:fakeArticle.id,authority:{origin:'manual',sponsorUserId:OWNER.userId},claim:{jobId:actual.job.id,leaseOwner:null,attempts:0},now:h.clock.now(),decide:s=>{decided=true;return {article:s.article};}}),/requester does not match/);
    assert.equal(decided,false);
  }
});
