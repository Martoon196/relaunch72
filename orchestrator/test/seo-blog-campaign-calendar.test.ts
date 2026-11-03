import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { campaignCalendarEntries, campaignJobLinks } from '../src/seo-blog/campaign-calendar.js';
import { calendarPage } from '../src/portal/seo-blog-view.js';
import { campaignDeliveryCalendarPage } from '../src/portal/seo-blog-campaign-calendar-view.js';
import { SeoBlogEngine } from '../src/seo-blog/engine.js';
import { campaignFixture } from './seo-blog-campaign-fixtures.js';
import { nativeIdentity, nativeSeoCall } from './seo-blog-native-request.js';
import { OWNER, STRANGER } from './seo-blog-fixtures.js';
import type { Publication } from '../src/seo-blog/types.js';

test('six current social drafts populate month/week/agenda after blogs and retain an undated waiting tray without social drag payloads',async()=>{
  const f=await campaignFixture(),now='2026-11-03T00:00:00.000Z';
  const source={article:f.article,version:f.version,proposedAt:'2026-11-05T09:00:00.000Z',publications:[]};
  const entries=campaignCalendarEntries([source],now,'Europe/London');assert.equal(entries.length,6);assert.ok(entries.every(e=>e.dateKind==='proposed_relative'));
  const shell={brands:[f.brand],brand:f.brand,csrf:'synthetic-csrf',tab:'calendar' as const};
  for(const view of ['month','week','list'] as const){
    const html=calendarPage(shell,{view,anchor:'2026-11-05',articles:[{article:f.article,title:'Blog first',status:'Needs approval'}],briefs:[],destinations:[],brandsAll:false,campaignEntries:entries});
    assert.match(html,/Instagram · Launch/);assert.match(html,/LinkedIn · Takeaway/);assert.match(html,/Suggested from the blog date/);assert.match(html,/social\/calendar/);
    for(const card of html.matchAll(/<article class="slot planned social"[^>]*>[\s\S]*?<\/article>/g)){assert.doesNotMatch(card[0],/draggable|data-destination|<form/);assert.match(card[0],/\/campaign#post-/);}
  }
  const undated=campaignCalendarEntries([{...source,proposedAt:null}],now,'Europe/London');assert.ok(undated.every(e=>e.at===null));
  const html=calendarPage(shell,{view:'month',anchor:'2026-11-05',articles:[],briefs:[],destinations:[],brandsAll:false,campaignEntries:undated});
  assert.equal((html.match(/data-campaign-proposal/g)??[]).length,6);assert.match(html,/Social posts waiting for a date/);
  assert.match(html,/0 proposed blog dates · 0 planned topics · 0 blog publication schedules/);assert.match(html,/6 campaign drafts/);
  assert.equal(f.h.llm.calls.length,0);
});

test('relative dates use only stable exact publication first verification; mixed legacy history holds, owner pins remain exact',async()=>{
  const f=await campaignFixture(),now='2026-11-03T00:00:00.000Z',url=f.version.promotionPack!.canonicalUrl!;
  const article={...f.article,delivery:'published' as const,publishedVersionId:f.version.id,publishedUrl:url,publishedAt:'2026-01-01T00:00:00.000Z'};
  const publication={id:randomUUID(),articleId:article.id,versionId:f.version.id,contentSha:f.version.contentSha,publicUrl:url,state:'published',firstVerifiedAt:'2026-11-05T09:00:00.000Z',verifiedAt:'2026-11-20T09:00:00.000Z'} as Publication;
  const sources=[{article,version:f.version,proposedAt:null,publications:[publication]}];
  const first=campaignCalendarEntries(sources,now,'Europe/London');assert.equal(first[0]!.at,'2026-11-05T10:00:00.000Z');
  const latest=campaignCalendarEntries([{...sources[0]!,publications:[{...publication,verifiedAt:'2026-12-05T00:00:00.000Z'}]}],now,'Europe/London');assert.deepEqual(latest,first);
  const mixed=campaignCalendarEntries([{...sources[0]!,publications:[publication,{...publication,id:randomUUID(),firstVerifiedAt:null}]}],now,'Europe/London');assert.ok(mixed.every(e=>e.at===null&&e.state==='held'));
  const variant=article.campaign!.variants[0]!,pin={scheduledFor:'2026-11-02T09:00:00.000Z',localDate:'2026-11-02',localTime:'09:00',timezone:'Europe/London',setBy:OWNER.userId,setAt:now};
  const pinned={...article,campaign:{...article.campaign!,variants:article.campaign!.variants.map(v=>v.id===variant.id?{...v,pinnedSchedule:pin}:v)}};
  const p=campaignCalendarEntries([{...sources[0]!,article:pinned,publications:[]}],now,'Europe/London')[0]!;assert.equal(p.at,pin.scheduledFor);assert.equal(p.state,'held');assert.equal(p.dateKind,'owner_pin');
});

test('native delivery diary is genuine-owner read only, escapes actual jobs and links only exact stored canonical receipts',async()=>{
  const f=await campaignFixture(),jobId=randomUUID(),variant=f.article.campaign!.variants[0]!,intent=randomUUID(),content=randomUUID();
  const queue={instruction:{queueIntentId:intent,contentVersionId:content,variantId:variant.id},result:{kind:'materialized',jobId,intentId:intent,queueIntentId:intent,contentVersionId:content}} as NonNullable<typeof f.article.campaign>['queueInstructions'] extends readonly (infer T)[]|undefined?T:never;
  await f.h.store.updateArticle({...f.article,campaign:{...f.article.campaign!,queueInstructions:[queue]}});
  let reads=0;const jobs=[{jobId,network:'instagram',content:'<script>not executable</script>',scheduledFor:'2026-11-05T10:00:00.000Z',state:'queued',safeCode:null},{jobId:randomUUID(),network:'linkedin',content:'Similar text must not create a link.',scheduledFor:'2026-11-05T10:00:00.000Z',state:'needs_attention',safeCode:'source.held'}];
  const engine=new SeoBlogEngine({store:f.h.store,llm:null,search:f.h.search,transport:f.h.web,publishers:new Map(),vault:f.h.vault,now:f.h.clock.now,social:{listCalendar:async()=>{reads++;return jobs;}} as never});
  const path=`/portal/seo-blog/b/${f.brand.id}/social/calendar?from=2026-11-01&to=2026-12-01`,who=nativeIdentity(OWNER.userId);
  const response=await nativeSeoCall(engine,{who,method:'GET',path,applicationName:'Relaunch72 Content'});assert.equal(response.status,200);assert.equal(reads,1);assert.match(response.body,/&lt;script&gt;/);assert.doesNotMatch(response.body,/<script>not executable/);assert.equal((response.body.match(/Review this campaign post/g)??[]).length,1);
  assert.equal((await nativeSeoCall(engine,{who:nativeIdentity(STRANGER.userId),method:'GET',path})).status,404);assert.equal(reads,1);
  await assert.rejects(engine.socialCalendar(OWNER,f.brand.id,'2026-01-01T00:00:00.000Z','2028-01-01T00:00:00.000Z'),/366/);assert.equal(reads,1);
  const links=campaignJobLinks([(await f.h.store.getArticle(f.brand.id,f.article.id))!]);assert.equal(links.get(jobId)?.variantId,variant.id);assert.equal(links.size,1);
  assert.equal(f.h.llm.calls.length,0);assert.equal((await f.h.store.listJobs(f.brand.id)).length,0);
});
