/** Complete native mocked journey; real JPEG codec, no provider/socket/public post. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import jpeg from 'jpeg-js';
import { SeoBlogEngine } from '../src/seo-blog/engine.js';
import { ArticleMediaReviewService,canonicalImageQualityApproval } from '../src/seo-blog/media-review.js';
import { canonicalCampaignApproval } from '../src/seo-blog/campaign-promotions.js';
import { campaignDateProposal,currentCampaignRevision } from '../src/seo-blog/campaign.js';
import { SeoBlogCampaignQueueService,type CampaignQueuePort } from '../src/seo-blog/campaign-queue.js';
import { parseCompanyContentSocialImage } from '../src/company-content-pg/social-image.js';
import { GithubStaticPublisher } from '../src/seo-blog/publishers/github-static.js';
import type { DbTransaction } from '../src/db/transaction.js';
import type { SeoCampaignQueueInstruction,SeoCampaignQueueResult } from '../src/seo-blog/media-types.js';
import type { SocialBinding,SocialRegistry } from '../src/seo-blog/social.js';
import { websiteFixture } from './seo-blog-website-fixtures.js';
import { nativeMediaPorts } from './seo-blog-native-media-fixture.js';
import { nativeCsrf,nativeIdentity,nativeSeoCall } from './seo-blog-native-request.js';
import { OWNER } from './seo-blog-fixtures.js';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
function originalJpeg(){const width=1536,height=1024,data=Buffer.alloc(width*height*4);for(let i=0;i<data.length;i+=4){data[i]=34;data[i+1]=70;data[i+2]=120;data[i+3]=255;}return Buffer.from(jpeg.encode({width,height,data},80).data);}

test('native campaign uploads/reviews real crops, pins hero before review, approves six distinct posts and waits for exact live blog before canonical jobs', {timeout:120_000},async()=>{
  const f=await websiteFixture('github_static'),h=f.h,ports=nativeMediaPorts(h.store,f.brand.id,OWNER.userId,h.clock.now),who=nativeIdentity(OWNER.userId);
  const bindings:SocialBinding[]=(['instagram','linkedin'] as const).map(network=>({id:randomUUID(),network,providerConnectionId:randomUUID(),providerAccountIdSha256:hash(network),username:`synthetic_${network}`,dailyCap:5,monthlyCap:10,status:'active',registeredAt:h.clock.now(),revokedAt:null}));
  const instructions=new Map<string,SeoCampaignQueueInstruction>(),actualJobs=new Map<string,Extract<SeoCampaignQueueResult,{kind:'materialized'}>>();
  const transaction={async query(_sql:string,values:unknown[]){await h.store.enqueueJob({...JSON.parse(String(values[7])),rowVersion:1});return {rows:[]};}} as unknown as DbTransaction;
  const port:CampaignQueuePort={
    async recordOwnerCampaignQueue(ws,input,onQueued){assert.equal(ws,f.brand.id);let saved=instructions.get(input.commandId);if(!saved){const {commandId,...tuple}=input;saved={...tuple,queueIntentId:commandId,authorizingUserId:OWNER.userId,supersedesQueueIntentId:null};instructions.set(commandId,saved);}await onQueued(transaction,saved);return saved;},
    cancelOwnerCampaignQueue:async()=>undefined,
    async materializeCampaignQueue(ws,id){const saved=actualJobs.get(id);if(saved)return saved;const instruction=instructions.get(id)!;const a=(await h.store.getArticle(ws,f.articleId))!;if(a.delivery!=='published'||a.publishedVersionId!==instruction.articleVersionId)return {kind:'held',reason:'parent_unpublished'};
      const publication=(await h.store.listPublications(ws,a.id)).find(p=>p.versionId===a.currentVersionId&&p.state==='published'&&p.firstVerifiedAt)!;
      assert.ok(publication?.firstVerifiedAt);const variant=a.campaign!.variants.find(v=>v.id===instruction.variantId)!;
      const date=campaignDateProposal(variant,publication.firstVerifiedAt!,h.clock.now(),f.brand.timezone);assert.equal(date.state,'proposed');if(date.state!=='proposed')return {kind:'held',reason:'date'};
      const result:Extract<SeoCampaignQueueResult,{kind:'materialized'}>={kind:'materialized',queueIntentId:id,intentId:id,jobId:randomUUID(),contentVersionId:instruction.contentVersionId,bindingId:instruction.bindingId,authorizingUserId:OWNER.userId,executingActor:'worker',scheduledFor:date.at,anchorPublicationId:publication.id,anchorVerifiedAt:publication.firstVerifiedAt!,anchorKind:'first_verified',timezone:f.brand.timezone,dailyCap:5,monthlyCap:10};actualJobs.set(id,result);return result;},
    async listCampaignQueueWorkspaces(){const a=await h.store.getArticle(f.brand.id,f.articleId);return a?.delivery==='published'?[f.brand.id]:[];},
    async listPendingCampaignQueues(){return [...instructions.keys()].filter(id=>!actualJobs.has(id));},
  };
  const queue=new SeoBlogCampaignQueueService(h.store,port,h.clock.now);
  const social={overview:async()=>({profile:null,accounts:[],bindings}),listCalendar:async()=>{
    const a=(await h.store.getArticle(f.brand.id,f.articleId))!;
    return [...actualJobs.values()].map(j=>({jobId:j.jobId,network:a.campaign!.variants.find(v=>v.id===instructions.get(j.queueIntentId)!.variantId)!.network,content:'Synthetic exact connected job',scheduledFor:j.scheduledFor,state:'queued',safeCode:null}));
  }} as unknown as SocialRegistry;
  const engine=new SeoBlogEngine({store:h.store,llm:h.llm,search:h.search,transport:h.web,publishers:new Map([['github_static',new GithubStaticPublisher(h.github.fetch,1000)]]),vault:h.vault,now:h.clock.now,batchLimit:20,
    mediaReview:new ArticleMediaReviewService(h.store,ports.media,canonicalImageQualityApproval({context:ports.context,drafts:ports.drafts,approvals:ports.approvals,find:(source,sha)=>ports.find(source,sha)}),h.clock.now),
    campaignReview:{approval:canonicalCampaignApproval({context:ports.context,drafts:ports.drafts,approvals:ports.approvals,findDraft:command=>ports.find(command.source,hash(command.content))}),authorizeImage:(ws,input)=>ports.media.recordOwnerSocialImageAuthorization(ws,input),async loadImage(ws,selected){const p=await ports.media.loadPrivateAsset(ws,selected.assetId,selected.assetSha256);return parseCompanyContentSocialImage({mimeType:'image/jpeg',base64:p.bytes.toString('base64'),sha256:p.asset.sha256,width:p.asset.width!,height:p.asset.height!,alt:selected.alt});}},campaignQueue:queue,social});
  const base=`/portal/seo-blog/b/${f.brand.id}/articles/${f.articleId}`,brandBase=`/portal/seo-blog/b/${f.brand.id}`,csrf=nativeCsrf(who);
  const post=async(action:string,fields:Record<string,string|string[]>,file?:{filename:string;bytes:Buffer})=>{const response=await nativeSeoCall(engine,{who,method:'POST',path:`${base}/${action}`,fields:{_csrf:csrf,...fields},file,applicationName:'Relaunch72 Content'});assert.ok(response.status===200||response.status===303,`${action}: ${response.status} ${response.body.slice(0,200)}`);if(response.status===303)assert.doesNotMatch(response.headers.location!,/\?e=/,`${action}: ${response.headers.location}`);return response;};
  const current=()=>h.store.getArticle(f.brand.id,f.articleId).then(a=>a!);let article=await current(),versionId=article.currentVersionId!;
  const calls=h.llm.calls.length,searchCalls=h.search.calls;
  await post('image-upload',{versionId,commandId:randomUUID()},{filename:'synthetic-editorial.jpg',bytes:originalJpeg()});
  article=await current();const crops=article.localImageProposals![0]!.variants;assert.equal(crops.length,3);assert.equal(article.imageProposals?.length??0,0);
  for(const crop of crops){const result=await nativeSeoCall(engine,{who,method:'GET',path:`${brandBase}/media/${crop.assetId}/${crop.sha256}.jpg`});assert.equal(result.status,200);assert.equal(result.headers['content-type'],'image/jpeg');assert.ok(result.bytes.length>100);await post('image-quality-review',{commandId:randomUUID(),assetId:crop.assetId,assetSha256:crop.sha256,profile:crop.profile,alt:`Synthetic editorial ${crop.profile} illustration.`});}
  article=await current();assert.equal(article.mediaQualityReviews!.filter(r=>r.canonical).length,3);
  const quality=article.mediaQualityReviews!.find(r=>r.manifest.presentation.profile==='blog')!;
  await post('image-select-hero',{versionId,commandId:randomUUID(),qualityCommandId:quality.commandId});article=await current();const before=versionId;versionId=article.currentVersionId!;assert.notEqual(versionId,before);assert.equal(article.approval,null);assert.equal(article.campaignGeneration?.plannedVersionId,before);
  const version=(await h.store.getVersion(f.brand.id,versionId))!;assert.equal(version.body.image.url,article.heroMedia!.reservation.prospectiveUrl);assert.equal(article.heroMedia!.authorizations.length,0);
  await post('image-authorize-hero',{versionId,commandId:randomUUID()});await post('campaign-rebase',{versionId});
  article=await current();
  for(const variant of article.campaign!.variants){const quality=(await current()).mediaQualityReviews!.find(r=>r.manifest.presentation.profile===variant.network)!;await post('campaign-select-image',{versionId,variantId:variant.id,revisionId:variant.currentRevisionId,commandId:randomUUID(),qualityCommandId:quality.commandId});}
  article=await current();const fields:Record<string,string>={versionId};for(const v of article.campaign!.variants)fields[`approve_${v.id}`]=v.currentRevisionId;
  const approvalPage=await post('campaign-approve-selected',fields);assert.equal((approvalPage.body.match(/Exact post approved\. Scheduling/g)??[]).length,6);
  article=await current();assert.equal(new Set(article.campaign!.variants.map(v=>v.approval!.contentVersionId)).size,6);assert.equal(ports.uses.size,6);
  const queued:Record<string,string>={versionId};for(const variant of article.campaign!.variants){const rev=currentCampaignRevision(variant);queued[`queue_${variant.id}`]=rev.id;queued[`queueCommand_${variant.id}`]=randomUUID();queued[`queueBinding_${variant.id}`]=bindings.find(b=>b.network===variant.network)!.id;queued[`queueDate_${variant.id}`]=JSON.stringify({kind:'relative_verified',days:rev.relativeDays,afterMinutes:60,timezone:f.brand.timezone});}
  const queuedPage=await post('campaign-queue-selected',queued);assert.equal((queuedPage.body.match(/Genuine delivery instruction saved/g)??[]).length,6);assert.equal(instructions.size,6);assert.equal(actualJobs.size,0);
  await engine.tick('synthetic-draft-worker');assert.equal(actualJobs.size,0);assert.equal(h.github.refPatches,0);
  await post('approve',{versionId});article=await current();await post('schedule',{rowVersion:String(article.rowVersion),localDate:'2026-11-03',localTime:'09:00',destinationId:f.destination.id});
  h.clock.set('2026-11-03T09:00:01.000Z');await engine.tick('synthetic-capable-worker');article=await current();assert.equal(article.delivery,'published');assert.equal(actualJobs.size,6);
  for(const network of ['instagram','linkedin']){const ids=article.campaign!.variants.filter(v=>v.network===network).map(v=>v.approval!.contentVersionId);assert.equal(new Set(ids).size,3);}
  const receipts=[...actualJobs.values()];assert.ok(receipts.every(r=>Date.parse(r.scheduledFor)>=Date.parse(r.anchorVerifiedAt)+3_600_000));
  await engine.tick('synthetic-restart');assert.equal(actualJobs.size,6);assert.equal(h.llm.calls.length,calls);assert.equal(h.search.calls,searchCalls);
  const calendar=await nativeSeoCall(engine,{who,method:'GET',path:`${brandBase}/calendar?view=month&date=2026-11-03`,applicationName:'Relaunch72 Content'});assert.equal(calendar.status,200);assert.match(calendar.body,/data-campaign-proposal/);
  const diary=await nativeSeoCall(engine,{who,method:'GET',path:`${brandBase}/social/calendar?from=2026-11-01&to=2026-12-01`,applicationName:'Relaunch72 Content'});assert.equal(diary.status,200);assert.equal((diary.body.match(/data-canonical-social-job/g)??[]).length,6);assert.equal((diary.body.match(/Review this campaign post/g)??[]).length,6);
  const selected=article.campaign!.variants[0]!,rev=currentCampaignRevision(selected),other=article.campaign!.variants[1]!;
  await post('campaign-edit',{versionId,variantId:selected.id,revisionId:rev.id,title:rev.title,copy:rev.copy+' A further owner-reviewed practical question.',artworkInstructions:rev.artworkInstructions});
  const changed=await current();assert.equal(changed.currentVersionId,versionId);assert.equal(changed.heroMedia!.authorizations.length,1);assert.equal(changed.campaign!.variants[0]!.approval,null);assert.deepEqual(changed.campaign!.variants[1],other);assert.equal(h.llm.calls.length,calls);
});
