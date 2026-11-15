import { randomUUID } from 'node:crypto';
import type { Brand,BrandProfile,ArticleBrief,ResearchSource,ArticleBody } from '../src/seo-blog/types.js';
import { DEFAULT_BRAND_SETTINGS } from '../src/seo-blog/types.js';
import type { LlmClient,LlmRequest } from '../src/llm/client.js';
import { libraryPins, SUPPORTED_METHODS, type MethodSnapshot, type RulePack } from '../src/seo-blog/method-packs.js';

export function fixtureBrand(kind:'home'|'b2b'='home'){
  const id=randomUUID(),isHome=kind==='home',name=isHome?'Fictional Hearth Maintenance':'Fictional Queue Scheduling';
  const audience=isHome?'Homeowners preparing a maintenance checklist':'Operations managers coordinating appointments';
  const url=isHome?'https://hearth.example/request':'https://queue.example/demo';
  const profile:BrandProfile={brandId:id,version:1,knowledge:[],summary:name,audiences:[audience],positioning:isHome?'Practical household maintenance':'Clear appointment coordination',
    offers:[{name:isHome?'Maintenance enquiry':'Scheduling demonstration',description:'A fictional example service',price:null,url,sourceDocumentId:null}],
    conversionPages:[{url,label:isHome?'Request a maintenance discussion':'Request a scheduling demonstration'}],
    voice:{tone:[isHome?'warm and practical':'concise and analytical'],do:['Explain the practical mechanism'],dont:['No unsupported performance figures'],examples:[]},
    approvedClaims:[isHome?'The fictional service accepts maintenance enquiries.':'The fictional service offers a scheduling demonstration.'],
    exclusions:['Invented customer results'],conflicts:[],missingFacts:[],factsSha:'a'.repeat(64),source:'owner_edited',
    confirmedAt:'2026-11-04T00:00:00.000Z',confirmedBy:randomUUID(),createdAt:'2026-11-04T00:00:00.000Z',generation:null};
  const brand:Brand={id,organizationId:randomUUID(),name,slug:kind,website:new URL(url).origin,locale:'en-GB',timezone:'Europe/London',
    settings:{...DEFAULT_BRAND_SETTINGS,budgets:{modelTokensPerMonth:2000000,searchCallsPerMonth:100,imagesPerMonth:0}},createdAt:profile.createdAt,createdBy:profile.confirmedBy!,rowVersion:1};
  const topic=isHome?'household maintenance checks':'appointment handoff checks';
  const brief:ArticleBrief={id:randomUUID(),planId:randomUUID(),brandId:id,role:'supporting',slug:kind+'-practical-checklist',workingTitle:'How to organise '+topic,
    targetQuery:'How should I organise '+topic+'?',searchIntent:'learn',relatedQuestions:[],angle:isHome?'Check the visible condition before deciding the next maintenance step.':'Record the handoff before assigning the next appointment.',
    outline:['Inspect the starting point','Record what needs attention','Choose the next action'],keyPoints:['Keep unknown details visible.'],
    cta:profile.conversionPages[0]!,internalLinks:[],whyFit:'A practical process for this specific fictional audience.',demand:{kind:'qualitative',rationale:'Fixture only.'},sourceIds:['fixture-source'],
    duplicate:{verdict:'distinct',score:0,against:null,againstKind:null,advice:'Fixture only.'},status:'accepted',suggestedAtUtc:null,articleId:null};
  const sources:ResearchSource[]=[{id:'fixture-source',url:new URL('/guide',url).href,title:'Fictional process guide',retrievedAt:profile.createdAt,
    passage:'Record the starting condition, identify unknown information and decide the next verification step.',provider:'fixture',primary:true,query:topic}];
  return {brand,profile,brief,sources};
}
export function fixtureSnapshot(brandId:string,ids:readonly string[]=['production-core','blog-writing']):MethodSnapshot{
  const pins=libraryPins();
  return {brandId,assignment:{revision:1,scope:'private-owned-brands',pins:pins.filter(p=>ids.includes(p.packId))},
    releases:pins.map(p=>({...p,privateApproval:(SUPPORTED_METHODS as readonly string[]).includes(p.packId)?'approved':'pending',publicApproval:'blocked',reviewEvidence:'Explicit test-only review fixture.'})),tokensUsed:0};
}
export const block=(content:string,tag:string):any=>JSON.parse(content.split('<'+tag+'>')[1]!.split('</'+tag+'>')[0]!);
export class MethodFixtureModel implements LlmClient {
  readonly mode='mock' as const;readonly requests:LlmRequest[]=[];
  failQuality=false;missingSidecar=false;badEvidence=false;duplicateSocial=false;
  async complete(request:LlmRequest){
    this.requests.push(request);const text=request.messages[0]!.content;
    const profile=block(text,'brand_profile') as BrandProfile;const home=profile.summary.includes('Hearth');
    const topic=home?'maintenance condition':'appointment handoff';
    const action=profile.conversionPages[0]!.label;
    let output:Record<string,unknown>;
    if(request.meta?.stage==='SEO_BLOG_ARTICLE'){
      const brief=block(text,'brief');
      output={title:brief.working_title,seo_title:('Practical '+topic+' checks').slice(0,65),
        meta_description:'Use a clear, practical process to inspect the starting point, record what remains unknown and choose the next appropriate action.',
        excerpt:'A practical checklist for '+profile.audiences[0]+'.',
        intro:home?'Inspect the visible condition before choosing a maintenance task. Keep uncertain details on the checklist until they can be checked.':'Record the appointment handoff before assigning responsibility. Keep uncertain details visible until the team confirms them.',
        sections:[{heading:'Inspect the starting point',body:'- Check the '+topic+' and record what is observable. This separates evidence from assumptions before a decision is made.'},
          {heading:'Record what needs attention',body:'- List each unknown detail and who can verify it. A named check prevents missing information from turning into a confident claim.'},
          {heading:'Choose the next action',body:'- Choose the relevant next step from the recorded evidence. '+action+' when that is the appropriate route.'}],
        conclusion:'Keep the record clear and use the next step that fits the situation. '+action+'.',faqs:[],image_alt:'An illustrative checklist beside neutral planning notes',public_source_ids:[]};
    }else if(request.meta?.stage==='SEO_BLOG_SECTION'){
      output={heading:block(text,'section').heading,body:'Check the '+topic+' before moving on. Record each unknown detail so the person responsible can verify it and explain the next step.'};
    }else{
      const article=block(text,'blog_article') as ArticleBody;
      const angles=text.includes('<campaign_recipe>')?['launch','takeaway','follow_up']:['launch'];
      output={posts:['instagram','linkedin'].flatMap(network=>angles.map(angle=>({network,...(angles.length===3?{angle}:{}),title:article.title,
        copy:(network==='instagram'?'Keep this practical checklist handy. ':'For teams reviewing their process: ')+angle+': '+(angle==='launch'?article.intro:angle==='takeaway'?article.sections[0]!.body:article.conclusion)+' Read the guide for the process and the checks that remain.',
        artworkInstructions:'Use a neutral illustrative checklist showing the '+angle+' point.'})))};
      if(this.duplicateSocial)(output.posts as any[])[1]=(output.posts as any[])[0];
    }
    const marker='TRUSTED SERVER METHOD PACKAGE (technique only; mandatory platform factual constraints and stage output fields take precedence):\n';
    if(request.system.includes(marker)&&!this.missingSidecar){
      const packs=JSON.parse(request.system.split(marker)[1]!.split('\nApply only the current stage.')[0]!) as RulePack[];
      output._method_sidecar={audience:profile.audiences[0],selectedFormat:'how-to checklist',angle:home?'Inspect condition before choosing work':'Record handoff before assigning responsibility',
        evidenceReferences:this.badEvidence?['invented-source']:[],primaryNextAction:action,omittedUnsupportedClaims:['No unsupported cost, time-saving or customer-result figures included.'],
        decisions:{formatReason:'Steps make the practical process inspectable.',evidenceClass:'Explicit fictional test inputs; no customer performance proof.'},
        qualityFindings:packs.flatMap(p=>p.qualityChecks.map(q=>({ruleId:q.id,status:this.failQuality?'fail':'pass',detail:'Fixture: inspect the matching practical steps, factual restraint and brand-specific next action.'})))};
    }
    return {text:JSON.stringify(output),tokensIn:100,tokensOut:150,stopReason:'end_turn',model:'deterministic-method-fixture'};
  }
}
