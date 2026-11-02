/** Typed programme metadata lives in the existing brand/inventory/job JSON envelopes. */
import { createHash } from 'node:crypto';
import type { PlannedCluster, JsonCallResult } from './generation.js';
import type { SearchHit, ResearchBundle } from './research.js';
import type { ActivityEvent, ArticleBrief, Brand, BrandProfile, Destination, Job, KnowledgeCategory, KnowledgeDocument, KnowledgeRef, TopicPlan, UsageRecord, WebsiteInventory } from './types.js';
import { FACTUAL_KNOWLEDGE_CATEGORIES } from './types.js';
import type { KeywordMetric } from '../keyword/types.js';

export interface ResearchDiagnostic {
  readonly category: 'transient' | 'credentials' | 'verification' | 'payment' | 'daily_limit' | 'entitlement' | 'task_failed' | 'unknown';
  readonly supplierCode: number | null;
  readonly httpStatus: number | null;
  readonly taskId: string | null;
  readonly retryable: boolean;
  readonly summary: string;
  readonly remedy: string;
}
export function researchDiagnostic(code: number | null, httpStatus: number | null = null, rawTaskId?: unknown): ResearchDiagnostic {
  const taskId = typeof rawTaskId === 'string' && /^[a-zA-Z0-9-]{8,100}$/.test(rawTaskId) ? rawTaskId : null;
  const known: Record<number, [ResearchDiagnostic['category'], string, string]> = {
    40101: ['transient', 'The search engine could not process this research request.', 'The programme can retry this known temporary supplier error twice, within your search allowance.'],
    40103: ['task_failed', 'The supplier could not execute this research task.', 'Review the task in DataForSEO, then explicitly resume research if appropriate.'],
    40100: ['credentials', 'DataForSEO authentication was refused.', 'Check the configured research credentials. No automatic retry will run.'],
    40104: ['verification', 'The DataForSEO account requires verification.', 'Complete account verification in the provider console before resuming.'],
    40200: ['payment', 'The provider reported a payment requirement.', 'Check the provider balance and billing; the application has not purchased credits.'],
    40203: ['daily_limit', 'The provider daily cost limit was reached.', 'Review the provider daily limit and the programme allowance before resuming.'],
    40204: ['entitlement', 'This provider endpoint requires an account entitlement.', 'Check the endpoint subscription. Do not buy or raise a limit automatically.'],
  };
  const value = code !== null ? known[code] : undefined;
  if (value) return { category: value[0], supplierCode: code, httpStatus, taskId, retryable: code === 40101, summary: value[1], remedy: value[2] };
  if (httpStatus === 401 || httpStatus === 403) return { category: 'credentials', supplierCode: null, httpStatus, taskId, retryable: false, summary: 'The research provider refused access.', remedy: 'Review credentials and endpoint permissions before an explicit retry.' };
  return { category: 'unknown', supplierCode: code, httpStatus, taskId, retryable: false, summary: 'Research did not produce a known usable response.', remedy: 'The outcome and any supplier charge may be uncertain. Review the provider task and explicitly resume; no automatic retry will run.' };
}

export interface ResearchSearchReceipt {
  readonly keywordMetrics?: readonly KeywordMetric[];
  readonly hits: readonly SearchHit[];
  readonly taskId: string | null;
  /** Provider-reported cost is evidence, separate from the application's attempt allowance. */
  readonly providerReportedCost: number | null;
}
export interface ProgrammeQueryAttempt {
  readonly kind?: 'serp' | 'metrics';
  readonly querySha: string;
  readonly query: string;
  readonly nonce: string;
  readonly startedAt: string;
  readonly receipt?: ResearchSearchReceipt;
  readonly diagnostic?: ResearchDiagnostic;
  readonly providerReportedCost?: number | null;
  readonly receivedAt?: string;
  readonly uncertainAt?: string;
}
export interface ProgrammeInputSnapshot {
  readonly authority: ProgrammeAuthority;
  readonly sha: string;
  readonly profileVersion: number;
  readonly profileSha: string;
  readonly knowledge: readonly KnowledgeRef[];
  readonly structureSha: string | null;
  readonly structureVersion: number | null;
  readonly root: string | null;
  readonly categoryLabels: readonly string[];
  readonly brandWebsite: string | null;
}
export interface ProgrammeRun {
  readonly metricsWarning?: ResearchDiagnostic;
  readonly schema: 1;
  readonly logicalRunId: string;
  readonly snapshot: ProgrammeInputSnapshot;
  readonly retries: number;
  readonly attempts: readonly ProgrammeQueryAttempt[];
  readonly research?: ResearchBundle;
  readonly modelStart?: { readonly nonce: string; readonly at: string };
  readonly modelReceipt?: JsonCallResult<PlannedCluster>;
  readonly modelReceiptAt?: string;
  readonly planId?: string;
  readonly hold?: string;
}
export interface ProgrammeResearchHold {
  readonly logicalRunId: string;
  readonly jobId: string;
  readonly at: string;
  readonly reason: string;
  readonly diagnostic: ResearchDiagnostic | null;
}
export interface EditorialCategory {
  readonly id: string;
  readonly label: string;
  readonly slug: string;
  readonly evidenceUrls: readonly string[];
  readonly rationale: string;
  readonly confidence: 'high' | 'medium' | 'low';
}
export interface EditorialRecommendations {
  readonly schema: 1;
  readonly scanId: string;
  readonly scanSha: string;
  readonly generatedAt: string;
  readonly observedRoots: readonly { readonly path: string; readonly count: number; readonly evidenceUrls: readonly string[] }[];
  readonly categories: readonly EditorialCategory[];
  readonly suggestedRoot: string;
  readonly rationale: string;
}
export interface ApprovedEditorialStructure {
  readonly schema: 1;
  readonly version: number;
  readonly sha: string;
  readonly scanId: string;
  readonly scanSha: string;
  readonly root: string;
  readonly destinationId: string;
  readonly categories: readonly EditorialCategory[];
  readonly approvedBy: string;
  readonly approvedAt: string;
}
export interface BrandProgrammeSettings {
  /** Set only from a genuine managing-owner settings action. Never guessed from brand creation. */
  readonly authorisedBy?: string;
  readonly authorisedAt?: string;
  readonly structure?: ApprovedEditorialStructure;
  readonly researchHold?: ProgrammeResearchHold | null;
  readonly researchAcknowledgements?: readonly {readonly jobId:string;readonly intentId:string;readonly actorId:string;readonly at:string}[];
  readonly focus?: string | null;
  readonly exclusions?: readonly string[];
}
export interface ProgrammeProvenance {
  readonly authority?: ProgrammeAuthority;
  readonly logicalRunId: string;
  readonly inputSha: string;
  readonly structureSha: string | null;
  readonly structureVersion: number | null;
  readonly root?: string | null;
  readonly categoryLabels?: readonly string[];
}
export interface ProgrammeBoundarySnapshot {
  readonly brand: Brand;
  readonly profile: BrandProfile | null;
  readonly knowledge: readonly KnowledgeDocument[];
  readonly inventory: WebsiteInventory | null;
  readonly jobs: readonly Job[];
  readonly job: Job | null;
  readonly plans: readonly TopicPlan[];
  readonly briefs: readonly ArticleBrief[];
  readonly destinations: readonly Destination[];
  readonly requesterAllowed: boolean;
  readonly usage: { readonly search_calls: number; readonly model_tokens: number };
}
export interface ProgrammeBoundaryDecision {
  readonly job: Job | null;
  /** Controls the job mutation only; optional receipt/usage/settings effects are explicit below. */
  readonly writeJob: boolean;
  readonly settings?: Brand['settings'];
  readonly usage?: UsageRecord;
  readonly plan?: TopicPlan;
  readonly briefs?: readonly ArticleBrief[];
  readonly event?: ActivityEvent;
}
export interface ProgrammeBoundaryInput {
  readonly brandId: string;
  readonly jobId: string | null;
  readonly authority: ProgrammeAuthority;
  readonly now: string;
  readonly decide: (snapshot: ProgrammeBoundarySnapshot) => ProgrammeBoundaryDecision;
}
export interface ProgrammeAuthority {
  readonly origin: 'manual' | 'daily';
  readonly sponsorUserId: string;
}
export function programmeRun(job: Job): ProgrammeRun | null {
  return job.kind === 'plan' && job.payload.programme ? job.payload.programme as unknown as ProgrammeRun : null;
}
export function legacyPlanningHold(jobs:readonly Job[],acknowledgements:BrandProgrammeSettings['researchAcknowledgements']):ProgrammeResearchHold|null {
  const acknowledged=new Set((acknowledgements??[]).map((a)=>a.jobId));
  const failure=jobs.filter((j)=>j.kind==='plan'&&['blocked','failed'].includes(j.state)&&!programmeRun(j)&&!acknowledged.has(j.id)).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))[0];
  if(!failure||jobs.some((j)=>j.kind==='plan'&&j.state==='done'&&j.updatedAt>=failure.updatedAt)) return null;
  return {logicalRunId:failure.id,jobId:failure.id,at:failure.updatedAt,reason:'legacy_planning_hold',diagnostic:null};
}
export function programmeSha(value: unknown): string {
  const canonical = (v: unknown): string => v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : `{${Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k,x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(',')}}`;
  return createHash('sha256').update(canonical(value)).digest('hex');
}

export function activeProgrammeKnowledge(all: readonly KnowledgeDocument[]): KnowledgeDocument[] {
  const latest = new Map<string,KnowledgeDocument>();
  for(const d of all) if(!latest.has(d.id) || latest.get(d.id)!.version<d.version) latest.set(d.id,d);
  return [...latest.values()].filter((d)=>d.active);
}
export function programmeKnowledgeRefs(all: readonly KnowledgeDocument[]): KnowledgeRef[] {
  return activeProgrammeKnowledge(all).filter((d)=>d.text).map((d)=>({documentId:d.id,version:d.version,sha256:d.sha256,category:d.category})).sort((a,b)=>a.documentId.localeCompare(b.documentId));
}
export function programmeInputSnapshot(s: ProgrammeBoundarySnapshot, authority: ProgrammeAuthority): ProgrammeInputSnapshot {
  const knowledge=programmeKnowledgeRefs(s.knowledge);
  const structure=s.brand.settings.programme?.structure;
  const base={authority,profileVersion:s.profile?.version??0,profileSha:programmeSha(s.profile),knowledge,structureSha:structure?.sha??null,structureVersion:structure?.version??null,root:structure?.root??null,categoryLabels:structure?.categories.map((c)=>c.label)??[],brandWebsite:s.brand.website};
  return {...base,sha:programmeSha({...base,name:s.brand.name,locale:s.brand.locale,timezone:s.brand.timezone,cadence:s.brand.settings.cadence,horizon:s.brand.settings.planningHorizonDays})};
}
export function programmeAuthorityFor(job: Job, brand: Brand, profile: BrandProfile | null): ProgrammeAuthority {
  const bound=programmeRun(job)?.snapshot.authority;
  if(bound) return bound;
  return job.payload.requestedBy==='system'
    ? {origin:'daily',sponsorUserId:brand.settings.programme?.authorisedBy??profile?.confirmedBy??''}
    : {origin:'manual',sponsorUserId:typeof job.payload.requestedBy==='string'?job.payload.requestedBy:''};
}
export function programmeReadinessIssue(s: ProgrammeBoundarySnapshot, authority: ProgrammeAuthority): string | null {
  if(!s.requesterAllowed) return 'The programme authorising owner no longer manages this brand. A current owner can re-authorise programme settings.';
  if(s.brand.settings.pauseAll) return 'The owner has paused the programme. Resume it before new research or drafting.';
  if(authority.origin==='daily') {
    if(!s.brand.settings.ongoingProduction) return 'Automatic draft production is off.';
    if((s.brand.settings.programme?.authorisedBy??s.profile?.confirmedBy)!==authority.sponsorUserId) return 'The programme authorising owner changed. Start a new planning intent.';
  }
  if(!s.profile?.confirmedAt) return 'Extract, review and confirm the current brand profile before planning.';
  const factual=(refs:readonly KnowledgeRef[])=>refs.filter((r)=>FACTUAL_KNOWLEDGE_CATEGORIES.has(r.category)).map((r)=>`${r.documentId}:${r.sha256}`).sort().join('|');
  if(factual(s.profile.knowledge)!==factual(programmeKnowledgeRefs(s.knowledge))) return 'Brand guidance changed. Review and confirm a newly extracted profile before planning.';
  return null;
}

export function editorialRecommendations(inventory: WebsiteInventory): EditorialRecommendations {
  const observed=new Map<string,string[]>();
  const pages=inventory.pages.filter((p)=>p.fetchStatus==='ok' && p.editorial);
  for(const page of pages) {
    const parts=new URL(page.canonical??page.url).pathname.split('/').filter(Boolean);
    const root=parts.length>1?`/${parts[0]}`:'/';
    observed.set(root,[...(observed.get(root)??[]),page.url]);
  }
  const observedRoots=[...observed].map(([path,evidenceUrls])=>({path,count:evidenceUrls.length,evidenceUrls:evidenceUrls.slice(0,5)})).sort((a,b)=>b.count-a.count||a.path.localeCompare(b.path));
  const groups=new Map<string,string[]>();
  for(const page of pages) {
    const parts=new URL(page.canonical??page.url).pathname.split('/').filter(Boolean);
    if(parts.length>=3 && parts[1]) groups.set(parts[1],[...(groups.get(parts[1])??[]),page.url]);
  }
  const label=(slug:string)=>slug.replace(/[-_]/g,' ').replace(/\b\w/g,(c)=>c.toUpperCase());
  const categories:EditorialCategory[]=[...groups].sort(([a],[b])=>a.localeCompare(b)).slice(0,8).map(([slug,urls])=>({id:`observed-${slug}`,label:label(slug),slug,evidenceUrls:urls.slice(0,5),rationale:'This section appears in the observed article URL structure. This is evidence, not a CMS taxonomy change.',confidence:urls.length>1?'high':'medium'}));
  if(!categories.length) categories.push({id:'suggested-guides',label:'Guides',slug:'guides',evidenceUrls:pages.slice(0,3).map((p)=>p.url),rationale:pages.length?'A simple guide category fits the observed editorial pages; the website did not expose a reliable category taxonomy.':'A draft category suggestion only. No readable editorial pages were found; review the incomplete scan before approval.',confidence:'low'});
  const scanSha=programmeSha({website:inventory.website,pages:inventory.pages.map((p)=>({url:p.url,canonical:p.canonical,title:p.title,headings:p.headings,editorial:p.editorial,fetchStatus:p.fetchStatus})).sort((a,b)=>a.url.localeCompare(b.url)),observedRoots,categories});
  return {schema:1,scanId:`scan-${scanSha.slice(0,24)}`,scanSha,generatedAt:inventory.fetchedAt,observedRoots,categories,suggestedRoot:observedRoots.find((r)=>r.path!=='/')?.path??'/blog',rationale:pages.length?'Recommendations come from the bounded website inventory. Categories guide drafts and do not create routes or move existing URLs.':'No reliable editorial structure was found. Recommendations are tentative; publishing support must be checked separately.'};
}
export function editorialRootIssue(destination: Destination | undefined, root: string): string | null {
  if(!destination || destination.status!=='connected') return 'Connect and verify a supported publishing destination first.';
  if(!/^\/[a-z0-9]+(?:[a-z0-9/_-]*[a-z0-9])?$/.test(root) || root.includes('//') || root.includes('..')) return 'Choose a simple supported root path, such as /blog.';
  const host=new URL(destination.publicBaseUrl).hostname.toLowerCase().replace(/^www\./,'');
  if(host==='propertypredator.com' && root!=='/blog') return 'Property Predator currently supports /blog only. Other roots require a website integration; no route will be created.';
  if(root!==`/${destination.config.blogPath??'blog'}`.replace(/\/$/,'')) return 'This root differs from the connected adapter configuration. Website integration is required before it can be approved.';
  return null;
}

export function suggestedKnowledgeCategory(name: string): KnowledgeCategory | null {
  name=name.replace(/[_-]/g,' ');
  if(/\b(voice|tone|copy samples?)\b/i.test(name)) return 'voice_samples';
  if(/\b(products?|pricing|plans?|packages?|offers?|facts?)\b/i.test(name)) return 'product_facts';
  if(/\b(faqs?|questions? and answers?)\b/i.test(name)) return 'faqs';
  if(/\b(audience|personas?)\b/i.test(name)) return 'audience_notes';
  if(/\b(visual|logos?|photography|imagery)\b/i.test(name)) return 'visual_guidance';
  if(/\bapproved claims?\b/i.test(name)) return 'approved_claims';
  if(/\b(brand|style|guidelines?)\b/i.test(name)) return 'brand_guidelines';
  return null;
}
export interface ProgrammeSummary {
  readonly state: 'paused'|'needs_setup'|'held'|'waiting_retry'|'working'|'needs_review'|'ready'|'off';
  readonly title: string;
  readonly detail: string;
  readonly next: {readonly label:string;readonly tab:string};
  readonly health: string;
  readonly diagnostic: ResearchDiagnostic | null;
  readonly lastSuccessAt: string | null;
  readonly metricsWarning: string | null;
}
export function programmeSummary(input:{brand:Brand;jobs:readonly Job[];profileState:string;canPlan:boolean;missing:readonly string[];researchConfigured:boolean;drafts:number}):ProgrammeSummary {
  const plans=input.jobs.filter((j)=>j.kind==='plan').sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
  const attempts=plans.flatMap((j)=>programmeRun(j)?.attempts??[]).filter((a)=>a.kind!=='metrics').sort((a,b)=>(b.receivedAt??b.startedAt).localeCompare(a.receivedAt??a.startedAt));
  const success=attempts.find((a)=>a.receipt);
  const latest=attempts[0];const hold=input.brand.settings.programme?.researchHold??legacyPlanningHold(input.jobs,input.brand.settings.programme?.researchAcknowledgements);
  const diagnostic=hold?.diagnostic??latest?.diagnostic??null;
  const active=plans.find((j)=>['queued','running'].includes(j.state));
  const oldBlock=plans.find((j)=>['blocked','failed'].includes(j.state)&&(!programmeRun(j)||!!programmeRun(j)?.attempts.length));
  const base={health:!input.researchConfigured?'Not configured':diagnostic?'Needs attention':oldBlock&&!success?'Earlier planning task needs attention':success?'Last source research succeeded':'Configured · not yet verified by a successful run',diagnostic,lastSuccessAt:success?.receivedAt??null,metricsWarning:plans.map((j)=>programmeRun(j)?.metricsWarning?.summary).find(Boolean)??null};
  if(input.brand.settings.pauseAll) return {...base,state:'paused',title:'Programme paused',detail:'New research and draft production wait for your instruction. Existing drafts remain available.',next:{label:'Review pause controls',tab:'publishing'}};
  if(input.profileState!=='confirmed') return {...base,state:'needs_setup',title:'Your brand profile needs review',detail:input.profileState==='stale'?'Guidance changed after confirmation. Extract and review the current profile before production.':'Review the extracted facts and confirm the profile. The programme will not invent missing facts or confirm it for you.',next:{label:'Review and confirm profile',tab:'setup#brand-profile'}};
  if(hold) return {...base,state:'held',title:'Research needs your attention',detail:diagnostic?`${diagnostic.summary} ${diagnostic.remedy}`:'An earlier planning outcome needs review. Saved results and usage history remain available; no new automatic run will silently restart it.',next:{label:'Review research and resume',tab:'topics#research-status'}};
  if(active) return {...base,state:active.state==='queued'&&programmeRun(active)?.retries?'waiting_retry':'working',title:active.state==='queued'&&programmeRun(active)?.retries?'A bounded research retry is queued':'Your next content plan is in progress',detail:active.progress,next:{label:'Open programme tasks',tab:'activity'}};
  if(!input.canPlan) return {...base,state:'needs_setup',title:'One setup step is holding production',detail:input.missing.join(' '),next:{label:input.missing.some((x)=>/budget|allowance/i.test(x))?'Review programme allowances':'Finish brand setup',tab:input.missing.some((x)=>/budget|allowance/i.test(x))?'publishing':'setup'}};
  if(input.drafts) return {...base,state:'needs_review',title:`${input.drafts} draft${input.drafts===1?' is':'s are'} ready for your review`,detail:'Proposed dates are editorial intentions. Approval and a publication schedule are separate decisions.',next:{label:'Review the draft diary',tab:'calendar'}};
  if(plans.some((j)=>programmeRun(j)?.planId)) return {...base,state:'needs_review',title:'Your researched topic plan is ready',detail:'Review the proposed articles and accept the plan, or keep automatic plan acceptance under your own programme settings.',next:{label:'Review topics',tab:'topics'}};
  return {...base,state:input.brand.settings.ongoingProduction?'ready':'off',title:input.brand.settings.ongoingProduction?'The draft programme is ready':'Create your next content plan',detail:input.brand.settings.ongoingProduction?'The worker will replenish the proposed diary within your cadence, backlog and usage ceilings.':'You can plan a campaign now or enable ongoing draft production. Public publishing remains a separate control.',next:{label:'Plan my content',tab:'topics'}};
}
