/** Fictional deterministic model output, never a live-model quality claim. */
import { randomUUID } from 'node:crypto';
import type { LlmRequest } from '../src/llm/client.js';
import { libraryPins, type RulePack, type MethodSnapshot } from '../src/seo-blog/method-packs.js';
import type { CampaignBrief, CampaignContent, CampaignCreatorStore, CreatorBegin, CreatorRecord } from '../src/seo-blog/campaign-creator.js';
import { methodHash } from '../src/seo-blog/method-packs.js';
import type { MemoryMethodStore } from '../src/seo-blog/method-store.js';
import { MethodFixtureModel, block } from './rl72-method-fixtures.js';

export function upgradeSnapshot(brandId:string,ids:readonly string[]=libraryPins('0.1.1').map(p=>p.packId)):MethodSnapshot {
  const pins=libraryPins('0.1.1');
  return {brandId,tokensUsed:0,assignment:{revision:1,scope:'private-owned-brands',pins:pins.filter(p=>ids.includes(p.packId))},releases:pins.map(p=>({...p,privateApproval:'approved',publicApproval:'blocked',reviewEvidence:'Fictional upgrade fixture only.'}))};
}
export function campaignBrief(profile:{audiences:readonly string[];conversionPages:readonly {label:string;url:string}[]},kind:'email'|'advocacy'='email'):CampaignBrief {
  return {kind,name:kind==='email'?'A useful introduction':'Feedback and introductions',goal:'Help the reader decide the next useful step.',audience:profile.audiences[0]!,purpose:kind==='email'?'education':'both',count:3,cta:profile.conversionPages[0]!,offerName:null,
    permissionContext:'Draft for people whose relevant contact permission the owner will verify before use.',customerMoment:'After the owner has verified a completed customer milestone.',consentProcess:'Record explicit permission and attribution separately; honour withdrawal requests.',incentiveTerms:'None'};
}
export function concreteSidecar(request:LlmRequest,asset:any):any {
  const source=request.messages[0]!.content,profile=block(source,'brand_profile'),context=block(source,'method_context');
  const marker='TRUSTED SERVER METHOD PACKAGE (technique only; mandatory platform factual constraints and stage output fields take precedence):\n';
  const packs=JSON.parse(request.system.split(marker)[1]!.split('\nApply only the current stage.')[0]!) as RulePack[];
  const brief=source.includes('<campaign_brief>')?block(source,'campaign_brief'):null;
  const decisions:any={claimLedger:[],sourceAssessments:[],ownerDecisionsNeeded:[],formatDecision:context.editorialFormat??{formatId:'how-to',rationale:'Ordered checks fit this practical reader question.'},
    mechanismMap:[{recommendation:asset.intro??asset.body??asset.summary??'A practical check.',reason:'A recorded check makes an unknown visible before a decision.'}],
    structureDecision:{structureId:'question-answer-proof',rationale:'Answer the practical objection with only supplied evidence.'},hookOptions:['What needs checking first?','Start with the observable condition.','Choose the next step from the evidence.'],proofSelection:{reason:'No customer performance proof was supplied; it is omitted.',references:[]},
    visualDecision:{evidenceClass:'illustrative',assetIds:[],styleReferences:context.visual.guidance.map((g:any)=>g.id),point:'Make one observable check clear.',placement:context.visual.placement}};
  if(asset.pillar)decisions.formatPerArticle=[asset.pillar,...asset.supporting].map(a=>({slug:a.slug,formatId:'checklist',rationale:'Observable checks fit this distinct question.'}));
  if(asset.emails)decisions.sequenceMap=asset.emails.map((e:any,i:number)=>({position:i+1,purpose:e.purpose,reason:'Each message adds a distinct useful check.'}));
  if(brief?.kind==='advocacy'){
    decisions.consentReview={process:brief.consentProcess,delivery:'owner-managed',proofUse:'requires-separate-permission'};
    decisions.incentiveReview={terms:brief.incentiveTerms,reason:'Only the owner-approved terms may be used.'};
  }
  const path=asset.title?'/asset/title':asset.heading?'/asset/heading':'/decisions/formatPerArticle';
  return {audience:profile.audiences[0],selectedFormat:decisions.formatDecision.formatId,angle:'Check what is observable before deciding.',evidenceReferences:[],primaryNextAction:profile.conversionPages[0]?.label??null,omittedUnsupportedClaims:['No unsupported customer results included.'],decisions,
    qualityFindings:packs.flatMap(p=>p.qualityChecks.map(q=>({ruleId:q.id,status:'pass',detail:'Inspect the linked concrete draft and the recorded typed decisions.',evidence:[path]})))};
}
export class UpgradeFixtureModel extends MethodFixtureModel {
  mutate:((asset:any,request:LlmRequest)=>void)|null=null;
  beforeReply:(()=>Promise<void>)|null=null;
  async complete(request:LlmRequest){
    let result:any;
    if(request.meta?.stage==='SEO_CAMPAIGN_CREATOR'){
      this.requests.push(request);const b=block(request.messages[0]!.content,'campaign_brief') as CampaignBrief;
      result=b.kind==='email'?{title:b.name,summary:'A practical introduction that leaves the reader with a clearer next step.',emails:Array.from({length:b.count},(_,i)=>({dayOffset:i*2,purpose:'Practical check '+String(i+1),subjects:[`A useful starting check ${i+1}`,`What to consider next ${i+1}`,`Make the next decision clearer ${i+1}`],subject:`A useful starting check ${i+1}`,preview:'A concrete check to make the next decision clearer.',body:`Consider the situation before choosing the next step. For ${b.audience}, recording what is observable helps separate evidence from assumptions. Keep unknown information visible until someone can verify it.`,cta:b.cta}))}:
        {title:b.name,summary:'Optional feedback requests and introductions for owner review, without invented customer outcomes.',requests:b.purpose==='referral'?[]:[{moment:b.customerMoment,shortRequest:'Would you like to share honest feedback? Taking part is optional; we will ask separately before quoting you.',standardRequest:'If this is a useful time, would you share what your experience was like? Honest feedback is welcome and taking part is optional. We will ask for your explicit permission and preferred attribution before using any words publicly.',followUp:'A gentle reminder only if you would like to share feedback. There is no need to reply, and we will respect your preference.',questions:['What situation were you trying to address?','What was useful and what could be improved?','What would you want someone considering the next step to check?']}],
          referralMessages:b.purpose==='testimonial'?null:{short:'If this could help someone you know, you can share the enquiry link with them. There is no obligation.',standard:'If someone you know is considering a similar next step, you are welcome to share the enquiry link. Let them decide whether to contact us; please do not share their private details.',extended:'If someone you know might find this relevant, you can share the enquiry link and let them decide whether to contact us. There is no obligation to refer anyone, and we do not need their private contact details from you. Ask us if you need the current approved information.'},
          consentChecklist:['Verify permission before contacting a customer.','Record separate explicit permission for a quote and attribution.','Record and honour any withdrawal or removal request.'],incentiveTerms:b.incentiveTerms};
    }else if(request.meta?.stage==='SEO_BLOG_PLAN'){
      this.requests.push(request);
      const profile=block(request.messages[0]!.content,'brand_profile');
      const item=(i:number)=>({role:i===0?'pillar':'supporting',slug:'practical-check-'+i,working_title:'Practical preparation and evidence checks '+i,target_query:'Which practical check should I make at step '+i+'?',search_intent:i%2?'compare':'learn',related_questions:['What remains unknown?'],angle:'Distinct practical check '+i+' for '+profile.audiences[0],outline:['Inspect the situation','Record what remains unknown','Compare the useful checks','Choose the next step'],key_points:['Keep unknowns visible.','Record the next person responsible.'],why_fit:'A practical question for '+profile.audiences[0],cta_url:profile.conversionPages[0].url,internal_links:[],source_ids:['S1']});
      result={topic:'Practical preparation',money_page:profile.conversionPages[0],pillar:item(0),supporting:Array.from({length:6},(_,i)=>item(i+1)),provenance_note:'Fictional source-led cluster for deterministic tests only.'};
    }else result=JSON.parse((await super.complete(request)).text);
    result._method_sidecar=concreteSidecar(request,result);this.mutate?.(result,request);
    await this.beforeReply?.();
    return {text:JSON.stringify(result),tokensIn:100,tokensOut:150,stopReason:'end_turn',model:'deterministic-upgrade-fixture'};
  }
}

/** Local fixture only. PostgreSQL tests separately exercise the real transaction boundaries. */
export class MemoryCreatorFixture implements CampaignCreatorStore {
  readonly rows=new Map<string,CreatorRecord>();readonly starts=new Map<string,CreatorBegin>();
  constructor(private readonly methods:MemoryMethodStore){}
  async begin(i:CreatorBegin){
    const old=await this.get(i.brandId,i.id);if(old)return {record:old,created:false};
    const r:CreatorRecord={id:i.id,brandId:i.brandId,brief:i.brief,profileVersion:i.profileVersion,factsSha:i.factsSha,assignmentRevision:i.assignmentRevision,state:'generating',rowVersion:1,version:null,approval:null,detail:'Generating',createdAt:new Date().toISOString()};
    this.rows.set(i.id,r);this.starts.set(i.id,i);return {record:structuredClone(r),created:true};
  }
  async get(brandId:string,id:string){const r=this.rows.get(id);return r?.brandId===brandId?structuredClone(r):null;}
  async list(brandId:string){return [...this.rows.values()].filter(r=>r.brandId===brandId).map(r=>structuredClone(r));}
  async complete(brandId:string,id:string,receiptId:string,content:CampaignContent|null,detail:string){
    const r=(await this.get(brandId,id))!,receipt=await this.methods.receipt(brandId,receiptId);
    if(r.state!=='generating'&&r.state!=='unknown')return r;
    const body=content??(receipt?.resultText?JSON.parse(receipt.resultText):null);
    r.state=receipt?.outcome==='accepted'&&body?'draft':receipt?.outcome==='rejected'?'held':'unknown';r.detail=detail;r.rowVersion++;
    if(body&&r.state==='draft')r.version={number:1,content:body,contentSha:methodHash(JSON.stringify(body)),methodReceiptId:receiptId,createdAt:new Date().toISOString(),createdBy:this.starts.get(id)!.actorId};
    this.rows.set(id,r);return structuredClone(r);
  }
  async edit(brandId:string,id:string,expected:number,sha:string,content:CampaignContent){
    const r=(await this.get(brandId,id))!;if(r.rowVersion!==expected||r.version?.contentSha!==sha)throw new Error('Stale campaign');
    r.version={...r.version,number:r.version.number+1,content,contentSha:methodHash(JSON.stringify(content)),methodReceiptId:null};r.approval=null;r.state='draft';r.rowVersion++;this.rows.set(id,r);return structuredClone(r);
  }
  async approve(brandId:string,id:string,expected:number,sha:string){const r=(await this.get(brandId,id))!;if(r.rowVersion!==expected||r.version?.contentSha!==sha)throw new Error('Stale campaign');r.approval={version:r.version.number,contentSha:sha,by:this.starts.get(id)!.actorId,at:new Date().toISOString()};r.state='approved';r.rowVersion++;this.rows.set(id,r);return structuredClone(r);}
  async recover(brandId:string,id:string){return this.complete(brandId,id,this.starts.get(id)!.methodReceiptId,null,'Recovered without a new model call.');}
}
