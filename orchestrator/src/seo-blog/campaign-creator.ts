/** Brand-scoped email and advocacy authoring. Deliberately has no delivery port. */
import { Ajv, type AnySchema } from 'ajv';
import type { LlmClient } from '../llm/client.js';
import { loadPrompt } from '../stages/prompt.js';
import { callJson, dataBlock, profileForPrompt } from './generation.js';
import { methodHash, methodRunFor, PRIVATE_RELEASE_VERSION, type MethodController } from './method-packs.js';
import type { SeoBlogStore } from './store.js';
import { SeoBlogError, type BrandProfile } from './types.js';
import { currentKnowledge } from './method-evidence.js';
import { acquisitionReferenceKinds, buildAcquisitionEvidence, type AcquisitionEvidence } from './acquisition-evidence.js';

export type CreatorKind='email'|'advocacy'|'acquisition';
export const ACQUISITION_OBJECTIVES=['leads','bookings','sales','sign_ups','awareness'] as const;
export const ACQUISITION_CHANNELS=['instagram','facebook','linkedin','email','search','website'] as const;
export type AcquisitionChannel=typeof ACQUISITION_CHANNELS[number];
export interface CampaignBrief {
  kind:CreatorKind; name:string; goal:string; audience:string; purpose:'welcome'|'onboarding'|'education'|'promotion'|'testimonial'|'referral'|'both'|'acquisition';
  count:number; cta:{label:string;url:string}; offerName:string|null; permissionContext:string;
  customerMoment:string; consentProcess:string; incentiveTerms:string;
  /** Acquisition proposals only. */
  objective?:typeof ACQUISITION_OBJECTIVES[number]; channels?:AcquisitionChannel[]; articleIds?:string[];
  /** Server-built from saved brand records; never accepted from a browser. */
  evidence?:AcquisitionEvidence;
}
export interface AcquisitionInsight { type:'problem'|'objection'|'opportunity'; statement:string; evidence:string[]; basis:'observed'|'inferred' }
export interface AcquisitionConcept { name:string; angle:string; hook:string; headline:string; primaryText:string; cta:{label:string;url:string}; channels:AcquisitionChannel[]; addresses:number[]; creativeDirection:string }
/** A campaign PLAN. Hypotheses are predictions, never results; actual results are recorded elsewhere. */
export interface AcquisitionProposal {
  title:string; summary:string; objective:{goal:string;primaryMetric:string};
  insights:AcquisitionInsight[]; channels:{channel:AcquisitionChannel;role:string;rationale:string}[];
  concepts:AcquisitionConcept[];
  measurement:{primaryMetric:string;secondaryMetrics:string[];reviewAfterDays:number;learningRule:string;limitations:string[]};
  hypotheses:{statement:string;basis:string}[];
}
export interface EmailDraft { dayOffset:number; purpose:string; subjects:string[]; subject:string; preview:string; body:string; cta:{label:string;url:string} }
export interface AdvocacyRequest { moment:string; shortRequest:string; standardRequest:string; followUp:string; questions:string[] }
export interface EmailCampaign { title:string; summary:string; emails:EmailDraft[] }
export interface AdvocacyKit { title:string; summary:string; requests:AdvocacyRequest[]; referralMessages:{short:string;standard:string;extended:string}|null; consentChecklist:string[]; incentiveTerms:string }
export type CampaignContent=EmailCampaign|AdvocacyKit|AcquisitionProposal;
/** JSONB reorders object keys; idempotency compares canonical values, not serialisation order. */
export function campaignInputHash(brief:CampaignBrief):string {
  // The evidence pack is derived on the server from saved records at generation time; the owner's inputs alone identify the command.
  const {evidence:_derived,...owned}=brief;
  const stable=(value:unknown):string=>value!==null&&typeof value==='object'?(Array.isArray(value)?'['+value.map(stable).join(',')+']':'{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+stable(v)).join(',')+'}'):JSON.stringify(value);
  return methodHash(stable(owned));
}
export interface CreatorVersion { number:number; content:CampaignContent; contentSha:string; methodReceiptId:string|null; createdAt:string; createdBy:string }
export interface CreatorRecord {
  id:string;brandId:string;brief:CampaignBrief;profileVersion:number;factsSha:string;assignmentRevision:number;
  state:'generating'|'draft'|'held'|'unknown'|'approved'; rowVersion:number;version:CreatorVersion|null;
  approval:{version:number;contentSha:string;by:string;at:string}|null;detail:string;createdAt:string;
}
export interface CreatorBegin {
  id:string;brandId:string;actorId:string;brief:CampaignBrief;profileVersion:number;factsSha:string;
  assignmentRevision:number;methodReceiptId:string;reservation:number;inputHash:string;
}
export interface CampaignCreatorStore {
  begin(input:CreatorBegin):Promise<{record:CreatorRecord;created:boolean}>;
  get(brandId:string,id:string):Promise<CreatorRecord|null>;
  list(brandId:string):Promise<CreatorRecord[]>;
  complete(brandId:string,id:string,receiptId:string,content:CampaignContent|null,detail:string):Promise<CreatorRecord>;
  edit(brandId:string,id:string,expectedRowVersion:number,expectedSha:string,content:CampaignContent):Promise<CreatorRecord>;
  approve(brandId:string,id:string,expectedRowVersion:number,expectedSha:string):Promise<CreatorRecord>;
  recover(brandId:string,id:string):Promise<CreatorRecord>;
}
const field=(min=3,max=800)=>({type:'string',minLength:min,maxLength:max});
const ctaSchema={type:'object',additionalProperties:false,required:['label','url'],properties:{label:field(3,160),url:field(8,1500)}};
export const EMAIL_CAMPAIGN_SCHEMA:AnySchema={type:'object',additionalProperties:false,required:['title','summary','emails'],properties:{
  title:field(3,160),summary:field(10,800),emails:{type:'array',minItems:1,maxItems:7,items:{type:'object',additionalProperties:false,required:['dayOffset','purpose','subjects','subject','preview','body','cta'],properties:{
    dayOffset:{type:'integer',minimum:0,maximum:90},purpose:field(3,180),subjects:{type:'array',minItems:3,maxItems:3,uniqueItems:true,items:field(3,100)},subject:field(3,100),preview:field(5,180),body:field(40,7000),cta:ctaSchema}}}}};
export const ADVOCACY_KIT_SCHEMA:AnySchema={type:'object',additionalProperties:false,required:['title','summary','requests','referralMessages','consentChecklist','incentiveTerms'],properties:{
  title:field(3,160),summary:field(10,800),requests:{type:'array',minItems:0,maxItems:3,items:{type:'object',additionalProperties:false,required:['moment','shortRequest','standardRequest','followUp','questions'],properties:{
    moment:field(5,500),shortRequest:field(20,700),standardRequest:field(40,1800),followUp:field(20,900),questions:{type:'array',minItems:3,maxItems:4,items:field(5,250)}}}},
  referralMessages:{type:['object','null'],additionalProperties:false,required:['short','standard','extended'],properties:{short:field(20,700),standard:field(40,1400),extended:field(60,2200)}},
  consentChecklist:{type:'array',minItems:3,maxItems:8,items:field(5,300)},incentiveTerms:field(3,1200)}};
const channelEnum={type:'string',enum:[...ACQUISITION_CHANNELS]};
export const ACQUISITION_PROPOSAL_SCHEMA:AnySchema={type:'object',additionalProperties:false,required:['title','summary','objective','insights','channels','concepts','measurement','hypotheses'],properties:{
  title:field(3,160),summary:field(10,900),
  objective:{type:'object',additionalProperties:false,required:['goal','primaryMetric'],properties:{goal:field(5,400),primaryMetric:field(3,160)}},
  insights:{type:'array',minItems:3,maxItems:9,items:{type:'object',additionalProperties:false,required:['type','statement','evidence','basis'],properties:{
    type:{type:'string',enum:['problem','objection','opportunity']},statement:field(10,400),evidence:{type:'array',minItems:1,maxItems:4,uniqueItems:true,items:field(1,160)},basis:{type:'string',enum:['observed','inferred']}}}},
  channels:{type:'array',minItems:1,maxItems:6,items:{type:'object',additionalProperties:false,required:['channel','role','rationale'],properties:{channel:channelEnum,role:field(3,200),rationale:field(10,500)}}},
  concepts:{type:'array',minItems:1,maxItems:3,items:{type:'object',additionalProperties:false,required:['name','angle','hook','headline','primaryText','cta','channels','addresses','creativeDirection'],properties:{
    name:field(3,80),angle:field(5,300),hook:field(3,120),headline:field(3,90),primaryText:field(20,600),cta:ctaSchema,
    channels:{type:'array',minItems:1,maxItems:6,uniqueItems:true,items:channelEnum},addresses:{type:'array',minItems:1,maxItems:9,uniqueItems:true,items:{type:'integer',minimum:0,maximum:8}},creativeDirection:field(10,500)}}},
  measurement:{type:'object',additionalProperties:false,required:['primaryMetric','secondaryMetrics','reviewAfterDays','learningRule','limitations'],properties:{
    primaryMetric:field(3,160),secondaryMetrics:{type:'array',minItems:0,maxItems:4,items:field(3,160)},reviewAfterDays:{type:'integer',minimum:7,maximum:90},
    learningRule:field(10,500),limitations:{type:'array',minItems:1,maxItems:5,items:field(10,400)}}},
  hypotheses:{type:'array',minItems:1,maxItems:4,items:{type:'object',additionalProperties:false,required:['statement','basis'],properties:{statement:field(10,400),basis:field(10,400)}}}}};
/** Commercial commitments a proposal may never introduce unless the owner's approved facts already state them. */
export const COMMERCIAL_COMMITMENTS=/\b(?:refunds?|money[- ]back|guarantee[ds]?|free (?:trial|consultation|quote|delivery|shipping)|discount(?:ed|s)?|\d+% off|cash ?back|warrant(?:y|ies)|no win,? no fee|price match|lowest price|cheapest)\b/gi;
const ajv=new Ajv({allErrors:true,strict:false});
const validators={email:ajv.compile(EMAIL_CAMPAIGN_SCHEMA),advocacy:ajv.compile(ADVOCACY_KIT_SCHEMA),acquisition:ajv.compile(ACQUISITION_PROPOSAL_SCHEMA)};
export function campaignProblems(brief:CampaignBrief,content:unknown,profile:BrandProfile):string[] {
  if(!validators[brief.kind](content))return ['The campaign draft does not match its required fields and limits.'];
  const v=content as CampaignContent;const problems:string[]=[];const encoded=JSON.stringify(v);
  if(Buffer.byteLength(encoded,'utf8')>65536)problems.push('Keep the complete campaign within the saved draft size limit.');
  if(/<\s*[a-z!\/]/i.test(encoded))problems.push('Use plain text; HTML is not allowed in campaign drafts.');
  if(/\{\{|\[\s*(first.?name|company|customer.?name)\s*\]/i.test(encoded))problems.push('Personalisation fields are unavailable in this authoring workspace.');
  const allowed=new Set([brief.cta.url]);
  for(const url of encoded.match(/https?:\/\/[^\s"<>\\)]+/g)??[])if(!allowed.has(url.replace(/[.,;!]$/,'')))problems.push('Only the campaign’s confirmed action URL may be used.');
  if(/\b(?:we have|we've|has been|was)\s+(?:sent|scheduled|published)\b/i.test(encoded))problems.push('A draft cannot claim that anything was sent, scheduled or published.');
  for(const exclusion of profile.exclusions)if(exclusion.length>=3&&encoded.toLowerCase().includes(exclusion.toLowerCase()))problems.push('The draft includes an excluded brand term or claim.');
  const approved=JSON.stringify({offers:profile.offers,claims:profile.approvedClaims,incentiveTerms:brief.incentiveTerms});
  for(const figure of encoded.match(/(?:£|\$|€)\s*\d[\d,.]*|\b\d+(?:\.\d+)?%/g)??[])if(!approved.includes(figure))problems.push('Commercial figures must match the approved brand facts or incentive terms.');
  if(brief.kind==='acquisition'){
    const p=v as AcquisitionProposal,evidence=brief.evidence??{research:[],facts:[],gaps:[]};
    const refs=acquisitionReferenceKinds(profile,evidence),channels=new Set(brief.channels??[]),proposed=new Set(p.channels.map(c=>c.channel));
    if(!p.insights.some(i=>i.type==='problem'))problems.push('Name at least one audience problem.');
    for(const insight of p.insights){
      if(!insight.evidence.every(r=>refs.has(r)))problems.push('Every insight must cite only the supplied evidence IDs.');
      if(insight.basis==='observed'&&!insight.evidence.some(r=>['research','knowledge','article'].includes(refs.get(r)??'')))problems.push('An insight marked observed must cite research, audience guidance or an article; otherwise mark it inferred.');
    }
    if(p.channels.some(c=>!channels.has(c.channel))||new Set(p.channels.map(c=>c.channel)).size!==p.channels.length)problems.push('Use only the channels the owner selected, once each.');
    if(p.concepts.length!==brief.count||new Set(p.concepts.map(c=>c.headline.trim().toLowerCase())).size!==p.concepts.length||new Set(p.concepts.map(c=>c.hook.trim().toLowerCase())).size!==p.concepts.length)problems.push('Return the requested number of distinct concepts, each with its own hook and headline.');
    for(const c of p.concepts){
      if(c.cta.url!==brief.cta.url||c.cta.label!==brief.cta.label)problems.push('Every concept must use the confirmed destination exactly.');
      if(c.channels.some(ch=>!proposed.has(ch)))problems.push('A concept can only run on channels in this proposal.');
      if(c.addresses.some(i=>i>=p.insights.length))problems.push('A concept must address listed insights.');
    }
    // Predictions are hypotheses: no invented rates, costs, returns or volumes; actual results are never written here.
    // objective.goal restates the owner's own words and may legitimately contain a number; predictions and the plan may not.
    const forecast=JSON.stringify({hypotheses:p.hypotheses,measurement:{...p.measurement,reviewAfterDays:null},primaryMetric:p.objective.primaryMetric});
    if(/\d/.test(forecast))problems.push('Predictions and the measurement plan must not invent numbers or targets; state them as testable hypotheses.');
    if(/\b(?:achieved|delivered|resulted in|generated)\b/i.test(p.objective.goal))problems.push('A proposal cannot report results; keep predictions as hypotheses.');
    if(/\b(?:roas|return on ad spend|cpa|cac|ctr)\b[^.]{0,40}\b(?:will|is|of|at)\b/i.test(forecast))problems.push('Do not state predicted ROAS, CPA, CAC or CTR as facts.');
    if(/\b(?:achieved|delivered|resulted in|generated)\b/i.test(forecast))problems.push('A proposal cannot report results; keep predictions as hypotheses.');
    const approvedText=JSON.stringify({offers:profile.offers,claims:profile.approvedClaims}).toLowerCase();
    for(const term of encoded.match(COMMERCIAL_COMMITMENTS)??[])if(!approvedText.includes(term.toLowerCase()))problems.push(`Do not introduce commercial commitments that are not in approved facts ("${term}").`);
    if(/\b(?:competitors?|rivals?)\b[^.]{0,60}\b(?:spend|budget|spending)\b/i.test(encoded))problems.push('Do not state competitor spend.');
  }
  if(brief.kind==='email'){
    const emails=(v as EmailCampaign).emails;
    if(emails.length!==brief.count)problems.push('Return the exact requested number of emails.');
    if(emails.some((e,i)=>e.cta.url!==brief.cta.url||e.cta.label!==brief.cta.label||i>0&&e.dayOffset<emails[i-1]!.dayOffset))problems.push('Preserve the approved action and ordered relative days.');
    for(const email of emails){
      if(!email.subjects.includes(email.subject)||new Set(email.subjects.map(s=>s.toLowerCase().trim())).size!==3||email.subjects.some(s=>/^(?:re|fw|fwd):/i.test(s)))problems.push('Choose one of three distinct honest subject lines without fake reply prefixes.');
      if(/\b(?:last chance|ends? (?:today|tomorrow)|only \d+ left|final notice)\b/i.test(JSON.stringify(email))&&!profile.approvedClaims.some(c=>/deadline|closes|ends|until|available until/i.test(c)))problems.push('Urgency needs an explicit approved campaign window.');
    }
  }else if(brief.kind==='advocacy'){
    const kit=v as AdvocacyKit;
    if(brief.purpose==='referral'&&kit.requests.length||brief.purpose!=='referral'&&!kit.requests.length||brief.purpose==='testimonial'&&kit.referralMessages!==null||brief.purpose!=='testimonial'&&kit.referralMessages===null)problems.push('Return only the requested feedback and/or referral components.');
    if(kit.incentiveTerms!==brief.incentiveTerms)problems.push('Keep incentive terms exactly as the owner supplied them.');
    if(/(?:five|5)[ -]star|positive review|leave (?:us )?a good review|guaranteed referral/i.test(encoded))problems.push('Do not reward positive reviews or promise referral outcomes.');
    if(!kit.consentChecklist.some(s=>/permission|consent/i.test(s))||!kit.consentChecklist.some(s=>/withdraw|remove/i.test(s)))problems.push('Include explicit proof-use permission and withdrawal handling.');
  }
  return [...new Set(problems)];
}
export function validateCampaignBrief(raw:CampaignBrief,profile:BrandProfile):CampaignBrief {
  const b=structuredClone(raw);
  if(!['email','advocacy','acquisition'].includes(b.kind)||!['welcome','onboarding','education','promotion','testimonial','referral','both','acquisition'].includes(b.purpose))throw new SeoBlogError(400,'Choose a supported campaign purpose.');
  if(b.kind==='email'&&!['welcome','onboarding','education','promotion'].includes(b.purpose)||b.kind==='advocacy'&&!['testimonial','referral','both'].includes(b.purpose)||(b.kind==='acquisition')!==(b.purpose==='acquisition'))throw new SeoBlogError(400,'Choose a purpose that matches this creator.');
  if(b.kind==='acquisition'){
    if(!ACQUISITION_OBJECTIVES.includes(b.objective as never))throw new SeoBlogError(400,'Choose the campaign objective.');
    const channels=[...new Set(b.channels??[])];
    if(!channels.length||channels.some(c=>!ACQUISITION_CHANNELS.includes(c)))throw new SeoBlogError(400,'Choose at least one channel.');
    b.channels=channels;
    if(!Number.isInteger(b.count)||b.count<1||b.count>3)throw new SeoBlogError(400,'Choose one to three concepts.');
    const ids=[...new Set(b.articleIds??[])];
    if(ids.length>3||ids.some(id=>!/^[0-9a-f-]{36}$/i.test(id)))throw new SeoBlogError(400,'Choose up to three supporting articles.');
    b.articleIds=ids;
    delete b.evidence;
  }else{ delete b.objective; delete b.channels; delete b.articleIds; delete b.evidence; }
  for(const [key,max] of [['name',160],['goal',1000],['audience',500],['permissionContext',1500]] as const)
    if(typeof b[key]!=='string'||b[key].trim().length<3||b[key].length>max)throw new SeoBlogError(400,'Complete the campaign name, goal, audience and permission context within the stated limits.');
  if(b.kind!=='acquisition'&&(!Number.isInteger(b.count)||b.count<1||b.count>7))throw new SeoBlogError(400,'Choose between one and seven emails.');
  if(!profile.audiences.includes(b.audience))throw new SeoBlogError(400,'Choose an audience confirmed for this brand.');
  const page=profile.conversionPages.find(p=>p.url===b.cta?.url&&p.label===b.cta?.label);
  if(!page||!/^https:\/\//i.test(page.url))throw new SeoBlogError(400,'Choose a confirmed action from this brand profile.');
  if(b.offerName&&!profile.offers.some(o=>o.name===b.offerName))throw new SeoBlogError(400,'Choose an approved offer from this brand.');
  if(b.purpose==='promotion'&&!b.offerName)throw new SeoBlogError(400,'Choose the approved offer for this promotion.');
  for(const key of ['customerMoment','consentProcess','incentiveTerms'] as const){
    if(typeof b[key]!=='string'||b[key].length>1500)throw new SeoBlogError(400,'Keep customer, consent and incentive notes within 1,500 characters.');
  }
  if(b.kind==='advocacy'&&(b.customerMoment.trim().length<5||b.consentProcess.trim().length<5||b.incentiveTerms.trim().length<3))throw new SeoBlogError(400,'Describe the customer moment, permission process and approved incentive terms (or None).');
  if(/(?:five|5)[ -]star|positive review/i.test(b.incentiveTerms))throw new SeoBlogError(400,'Incentives cannot depend on a positive review.');
  return b;
}

export class CampaignCreator {
  constructor(readonly store:CampaignCreatorStore,private readonly blogs:SeoBlogStore,private readonly methods:MethodController,private readonly llm:LlmClient|null){}
  private async profile(actorId:string,brandId:string){
    if(!await this.blogs.canManage(actorId,brandId))throw new SeoBlogError(403,'You cannot manage this brand.');
    const brand=await this.blogs.getBrand(brandId),profile=await this.blogs.latestProfile(brandId);
    if(!brand||!profile?.confirmedAt)throw new SeoBlogError(409,'Confirm this brand profile before creating a campaign.');
    const docs=currentKnowledge(await this.blogs.listKnowledge(brandId));
    if(profile.knowledge.some(k=>!docs.some(d=>d.id===k.documentId&&d.version===k.version&&d.sha256===k.sha256))||docs.some(d=>!profile.knowledge.some(k=>k.documentId===d.id&&k.version===d.version&&k.sha256===d.sha256)))throw new SeoBlogError(409,'Brand guidance changed. Review and confirm the current profile first.');
    if(profile.conflicts.length)throw new SeoBlogError(409,'Resolve conflicting brand facts before creating an email or referral campaign.');
    return {brand,profile};
  }
  async create(actorId:string,brandId:string,commandId:string,raw:CampaignBrief):Promise<CreatorRecord>{
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(commandId))throw new SeoBlogError(400,'Refresh the campaign form and try again.');
    const {brand,profile}=await this.profile(actorId,brandId),brief=validateCampaignBrief(raw,profile);
    if(brief.kind==='acquisition'){
      const articles=[];
      for(const id of brief.articleIds??[]){
        const article=await this.blogs.getArticle(brandId,id),version=article?.currentVersionId?await this.blogs.getVersion(brandId,article.currentVersionId):null;
        if(!article||!version)throw new SeoBlogError(400,'Choose supporting articles from this brand.');
        articles.push({article,version});
      }
      brief.evidence=buildAcquisitionEvidence({profile,knowledge:await this.blogs.listKnowledge(brandId),plans:await this.blogs.listPlans(brandId),articles});
      if(Buffer.byteLength(JSON.stringify(brief),'utf8')>15000)throw new SeoBlogError(400,'The campaign inputs are too large. Choose fewer supporting articles.');
    }
    const inputHash=campaignInputHash(brief);
    const existing=await this.store.get(brandId,commandId);
    if(existing){if(campaignInputHash(existing.brief)!==inputHash)throw new SeoBlogError(409,'This campaign command was already used with different inputs.');return existing;}
    if(!this.llm)throw new SeoBlogError(409,'Connect the writing model before creating a campaign.');
    const acquisition=brief.kind==='acquisition';
    // Acquisition uses the reviewed copy and social packs through their existing stages; the receipt stage names the creator kind.
    const llm=await this.methods.prepare(this.llm,{brand,profile,stage:brief.kind,stages:acquisition?['copy','social']:[brief.kind],assetRef:'creator:'+commandId,
      sources:acquisition?(brief.evidence?.research??[]).map(s=>s.id):[],baselineTokens:350000,
      evidence:acquisition?{research:brief.evidence?.research??[],ownerFacts:(brief.evidence?.facts??[]).map(f=>({id:f.id,text:`${f.title}: ${f.text}`}))}
        :{campaign:{consentProcess:brief.consentProcess,incentiveTerms:brief.incentiveTerms},ownerFacts:brief.kind==='advocacy'?[{id:'campaign:incentiveTerms',text:brief.incentiveTerms}]:[]}});
    const run=methodRunFor(llm),required=brief.kind==='email'?'email-writing':brief.kind==='advocacy'?'advocacy-and-referral':'conversion-copy';
    if(!run?.pins.some(p=>p.packId===required&&p.version===PRIVATE_RELEASE_VERSION))throw new SeoBlogError(409,'Activate the reviewed '+(brief.kind==='email'?'Inbox Engine':brief.kind==='advocacy'?'Word of Mouth Engine':'Hook & Close')+' pack for this brand first.');
    const begin=await this.store.begin({id:commandId,brandId,actorId,brief,profileVersion:profile.version,factsSha:profile.factsSha,assignmentRevision:run.assignment.revision,methodReceiptId:run.id,reservation:350000,inputHash});
    if(!begin.created)return begin.record;
    try{
      const generated=await callJson<CampaignContent>(llm,{prompt:loadPrompt(acquisition?'seo-acquisition-campaign.md':'seo-campaign-creator.md'),maxTokens:16000,
        user:[dataBlock('brand_profile',profileForPrompt(profile)),dataBlock('campaign_brief',brief)].join('\n\n'),
        schema:brief.kind==='email'?EMAIL_CAMPAIGN_SCHEMA:brief.kind==='advocacy'?ADVOCACY_KIT_SCHEMA:ACQUISITION_PROPOSAL_SCHEMA,validate:v=>campaignProblems(brief,v,profile)});
      return await this.store.complete(brandId,commandId,generated.record.methodReceiptId!,generated.value,'Draft prepared for owner review.');
    }catch(error){
      // Save held/unknown state without another paid call. Receipt persistence may itself be uncertain.
      await this.store.complete(brandId,commandId,run.id,null,(error as Error).message.slice(0,800));
      return (await this.store.get(brandId,commandId))!;
    }
  }
  async list(actorId:string,brandId:string):Promise<CreatorRecord[]>{if(!await this.blogs.canManage(actorId,brandId))throw new SeoBlogError(403,'You cannot manage this brand.');return this.store.list(brandId);}
  async recover(actorId:string,brandId:string,id:string):Promise<CreatorRecord>{await this.get(actorId,brandId,id);return this.store.recover(brandId,id);}
  async get(actorId:string,brandId:string,id:string):Promise<CreatorRecord>{
    if(!/^[0-9a-f-]{36}$/i.test(id))throw new SeoBlogError(404,'Campaign not found.');
    if(!await this.blogs.canManage(actorId,brandId))throw new SeoBlogError(403,'You cannot manage this brand.');
    const r=await this.store.get(brandId,id);if(!r)throw new SeoBlogError(404,'Campaign not found.');return r;
  }
  async edit(actorId:string,brandId:string,id:string,rowVersion:number,sha:string,content:unknown):Promise<CreatorRecord>{
    const {profile}=await this.profile(actorId,brandId),r=await this.get(actorId,brandId,id);
    const issues=campaignProblems(r.brief,content,profile);if(issues.length)throw new SeoBlogError(422,issues.join(' '));
    return this.store.edit(brandId,id,rowVersion,sha,content as CampaignContent);
  }
  async approve(actorId:string,brandId:string,id:string,rowVersion:number,sha:string,reviewed:boolean):Promise<CreatorRecord>{
    if(!reviewed)throw new SeoBlogError(400,'Confirm that you reviewed the facts, wording and permission process.');
    const {profile}=await this.profile(actorId,brandId),r=await this.get(actorId,brandId,id);
    if(!r.version)throw new SeoBlogError(409,'This campaign has no usable draft to approve.');
    const issues=campaignProblems(r.brief,r.version.content,profile);if(issues.length)throw new SeoBlogError(422,issues.join(' '));
    return this.store.approve(brandId,id,rowVersion,sha);
  }
  async export(actorId:string,brandId:string,id:string):Promise<string>{
    const r=await this.get(actorId,brandId,id),{profile}=await this.profile(actorId,brandId);
    if(!r.version||r.state!=='approved'||r.approval?.contentSha!==r.version.contentSha||!profile?.confirmedAt||profile.version!==r.profileVersion||profile.factsSha!==r.factsSha)throw new SeoBlogError(409,'Review and approve the current campaign against the current brand profile before exporting.');
    if(r.brief.kind==='acquisition')return JSON.stringify({kind:'acquisition',name:r.brief.name,status:'approved campaign proposal; nothing launched, published, scheduled or spent',
      objective:r.brief.objective,destination:r.brief.cta,channels:r.brief.channels,evidence:r.brief.evidence,content:r.version.content,
      predictions:'Hypotheses only — not results',actualResults:null},null,2)+'\n';
    return JSON.stringify({kind:r.brief.kind,name:r.brief.name,status:'approved authoring draft; not sent or scheduled',relativeDays:'Proposed timing only',permissionContext:r.brief.permissionContext,
      consentProcess:r.brief.consentProcess,recipientConsent:'Not established by this draft',content:r.version.content},null,2)+'\n';
  }
}
