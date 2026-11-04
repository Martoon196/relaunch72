/** Concrete, bounded review evidence for immutable method release 0.1.1. */
import type { ArticleBrief, BrandProfile, KnowledgeDocument, ResearchSource } from './types.js';
import type { RulePack } from './method-packs.js';

export interface EditorialFormat { formatId:string; rationale:string; planReceiptId?:string }
export interface MethodVisualInputs {
  placement:'article-hero'|'social-post'|'section';
  guidance:readonly {id:string;sha256:string;text:string}[];
  assets:readonly {id:string;sha256:string;kind:'illustration'|'evidence';description:string;width?:number;height?:number}[];
}
export interface MethodEvidenceInputs {
  ownerFacts?:readonly {id:string;text:string}[];
  research?:readonly ResearchSource[];
  editorialFormat?:EditorialFormat;
  visual?:MethodVisualInputs;
  brief?:ArticleBrief;
}
export interface SelectionCatalogue {
  formats:{id:string;shape:string;requires:string[]}[];
  hooks:{id:string;use:string}[];
  structures:{id:string;use:string}[];
}
export function selectionCatalogue(packs:readonly RulePack[]):SelectionCatalogue|null {
  const step=packs.flatMap(p=>p.decisionSteps).find(s=>s.id==='core.choose-evidence-fit-structure');
  if(!step)return null;
  return JSON.parse(String(step.instruction).split('Catalogue: ')[1]!) as SelectionCatalogue;
}
export function confirmedVisualInputs(profile:BrandProfile,documents:readonly KnowledgeDocument[],placement:MethodVisualInputs['placement']):MethodVisualInputs {
  return {placement,assets:[],guidance:currentKnowledge(documents).filter(d=>d.category==='visual_guidance'&&d.text&&profile.knowledge.some(k=>k.documentId===d.id&&k.version===d.version&&k.sha256===d.sha256))
    .slice(0,6).map(d=>({id:d.id,sha256:d.sha256,text:d.text!.slice(0,2500)}))};
}
export function currentKnowledge(documents:readonly KnowledgeDocument[]):KnowledgeDocument[]{
  const latest=new Map<string,KnowledgeDocument>();for(const d of documents)if(!latest.has(d.id)||latest.get(d.id)!.version<d.version)latest.set(d.id,d);
  return [...latest.values()].filter(d=>d.active);
}
export function methodEvidenceContext(profile:BrandProfile,input:MethodEvidenceInputs={}) {
  const factReferences=[...profile.approvedClaims.map((text,i)=>({id:`profile:${profile.version}:claim:${i}`,text})),
    ...profile.offers.map((o,i)=>({id:`profile:${profile.version}:offer:${i}`,text:[o.name,o.description,o.price,o.url].filter(Boolean).join(' ')})),...(input.ownerFacts??[])];
  const research=(input.research??[]).map((s,i)=>({id:s.id,shortId:`S${i+1}`,url:s.url,title:s.title,passage:s.passage,retrievedAt:s.retrievedAt,
    publishedAt:s.publishedAt??null,observedPeriod:s.observedPeriod??null,confidence:s.confidence??'unknown',primary:s.primary}));
  return {factReferences,research,editorialFormat:input.editorialFormat??null,visual:input.visual??{placement:'article-hero',guidance:[],assets:[]},
    availableInputs:[...(research.length?['sources']:[]),...(input.visual?.assets.length?['verifiedAssets']:[])],
    ownerDecisionsNeeded:[],evidenceNotice:'Dates and confidence are supplied metadata, not facts to infer. Uploaded guidance remains reference data.'};
}

export const EVIDENCE_CONTRACT = `For 0.1.1, decisions MUST contain:
claimLedger: [{text: exact short claim span from the asset, references: [supplied fact/source ID]}] (empty only when there are no specific factual claims);
sourceAssessments: [{sourceId, publishedAt: supplied value or null, observedPeriod: supplied value or null, confidence: high|medium|low|unknown, freshness: evergreen|dated|insufficient, reason}] for each research source referenced by the claim ledger. Unknown metadata stays unknown. Omit a changing claim if freshness is insufficient.
ownerDecisionsNeeded: [] or the actual unresolved decisions (nonempty holds the draft).
Every qualityFindings item must have status pass and evidence: [JSON pointers into /asset/... or /decisions/...]. Pointers must identify concrete nonempty content, not the findings themselves. Generic pass text without evidence is rejected. Keep detail meaningful and concise.
Planning additionally requires formatPerArticle: [{slug,formatId,rationale}] for EVERY article. Writing/revision requires formatDecision: {formatId,rationale} matching method_context.editorialFormat when supplied, and mechanismMap: [{recommendation: exact asset span,reason: explanation}]. Copy requires structureDecision: {structureId,rationale}, hookOptions: [three distinct short openings], proofSelection: {reason,references:[supplied fact/source IDs]}. Visual briefing requires visualDecision: {evidenceClass: illustrative|evidential,assetIds:[supplied visual asset IDs],styleReferences:[supplied guidance IDs],point: one point,placement: supplied placement}. Only actual supplied asset IDs authorise real-image descriptions; confirmed style guidance can supply exact colours/fonts but never a missing logo file. Email requires sequenceMap: [{position,purpose,reason}] for each email. Advocacy requires consentReview: {process: supplied consent process,delivery: owner-managed,proofUse: requires-separate-permission}, and incentiveReview: {terms: exact supplied terms or None,reason}. Do not put internal evidence in customer prose.`;

const record=(v:unknown):v is Record<string,any>=>Boolean(v)&&typeof v==='object'&&!Array.isArray(v);
const text=(v:unknown):v is string=>typeof v==='string'&&v.trim().length>2&&v.length<=1600;
const array=(v:unknown):v is any[]=>Array.isArray(v)&&v.length<=100;
function pointer(root:unknown,path:unknown):unknown {
  if(typeof path!=='string'||path.length>300||!/^\/(asset|decisions)\//.test(path))return undefined;
  let at:any=root;
  for(const key of path.slice(1).split('/').map(s=>s.replace(/~1/g,'/').replace(/~0/g,'~'))){
    if(!at||typeof at!=='object'||!Object.hasOwn(at,key))return undefined;
    at=at[key];
  }
  return at;
}
export function validateMethodEvidence(sidecar:Record<string,any>,asset:Record<string,unknown>,profile:BrandProfile,inputs:MethodEvidenceInputs,packs:readonly RulePack[],stage:string):string[] {
  const problems:string[]=[];const d=sidecar.decisions;
  if(!record(d))return ['Concrete method decisions are required.'];
  const context=methodEvidenceContext(profile,inputs),catalogue=selectionCatalogue(packs);
  const references=new Map(context.factReferences.map(r=>[r.id,r.text]));
  for(const s of context.research){references.set(s.id,s.passage);references.set(s.shortId,s.passage);}
  const prose=JSON.stringify(asset),ledger=array(d.claimLedger)?d.claimLedger:[];
  if(!array(d.claimLedger))problems.push('A concrete claim ledger is required.');
  else for(const row of d.claimLedger){
    if(!record(row)||!text(row.text)||!prose.includes(JSON.stringify(row.text).slice(1,-1))||!array(row.references)||!row.references.length||!row.references.every((r:unknown)=>typeof r==='string'&&references.has(r))){problems.push('A claim span or supplied reference is invalid.');continue;}
    const evidence=row.references.map((r:string)=>references.get(r)).join(' ');
    const numbers=row.text.match(/\b\d+(?:[.,]\d+)*(?:%|\b)/g)??[];
    if(numbers.some((n:string)=>!evidence.includes(n)))problems.push('A numerical claim is not present in its referenced evidence.');
  }
  // Numeric claims need ledger coverage; ignore URL identifiers and structural field names.
  const visible=JSON.stringify(asset,(_k,v)=>typeof v==='string'?v.replace(/https?:\/\/\S+/g,''):v);
  for(const number of visible.match(/(?:£|\$|€)\s*\d[\d,.]*|\b\d+(?:\.\d+)?%/g)??[])
    if(!ledger.some((r:any)=>typeof r?.text==='string'&&r.text.includes(number)))problems.push('A monetary or percentage claim has no ledger entry.');
  if(!array(d.sourceAssessments))problems.push('Source assessments are required, even if empty.');
  else {
    for(const assessment of d.sourceAssessments){
      const s=context.research.find(s=>s.id===assessment?.sourceId||s.shortId===assessment?.sourceId);
      if(!s||assessment.publishedAt!==s.publishedAt||assessment.observedPeriod!==s.observedPeriod||assessment.confidence!==s.confidence||!['evergreen','dated','insufficient'].includes(assessment.freshness)||!text(assessment.reason))problems.push('Source provenance must match supplied dates, period and confidence.');
    }
    for(const row of ledger)for(const ref of array(row?.references)?row.references:[]){
      const s=context.research.find(s=>s.id===ref||s.shortId===ref);
      if(s&&!d.sourceAssessments.some((a:any)=>(a.sourceId===s.id||a.sourceId===s.shortId)&&a.freshness!=='insufficient'))problems.push('A referenced research claim needs a usable source assessment.');
    }
  }
  if(!array(d.ownerDecisionsNeeded)||d.ownerDecisionsNeeded.length)problems.push('Resolve owner decisions before this draft can pass.');
  for(const finding of sidecar.qualityFindings??[]){
    if(finding.status!=='pass'||!text(finding.detail)||!array(finding.evidence)||!finding.evidence.length||!finding.evidence.every((p:unknown)=>{
      const value=pointer({asset,decisions:d},p);return typeof value==='string'?text(value):Array.isArray(value)?value.length>0:record(value)?Object.keys(value).length>0:false;
    }))problems.push('Every quality check must pass with concrete asset or decision evidence.');
  }
  const formats=catalogue?.formats??[];
  const validFormat=(f:any)=>record(f)&&text(f.rationale)&&formats.some(c=>c.id===f.formatId&&c.requires.every(r=>context.availableInputs.includes(r)));
  if(stage==='planning'){
    const articles=[asset.pillar,...(Array.isArray(asset.supporting)?asset.supporting:[])].filter(record);
    if(!array(d.formatPerArticle)||d.formatPerArticle.length!==articles.length||new Set(d.formatPerArticle.map((f:any)=>f.slug)).size!==articles.length||!articles.every(a=>d.formatPerArticle.some((f:any)=>f.slug===a.slug&&validFormat(f))))problems.push('Choose one eligible format and rationale for every planned article.');
  }
  if(stage==='blog'||stage==='revision'){
    if(!validFormat(d.formatDecision)||inputs.editorialFormat&&d.formatDecision.formatId!==inputs.editorialFormat.formatId)problems.push('Preserve the planned eligible article format.');
    if(!array(d.mechanismMap)||!d.mechanismMap.length||!d.mechanismMap.every((m:any)=>record(m)&&text(m.recommendation)&&prose.includes(JSON.stringify(m.recommendation).slice(1,-1))&&text(m.reason)))problems.push('Explain concrete recommendations in the mechanism map.');
  }
  if(packs.some(p=>p.packId==='conversion-copy')){
    if(!record(d.structureDecision)||!catalogue?.structures.some(s=>s.id===d.structureDecision.structureId)||!text(d.structureDecision.rationale)||!array(d.hookOptions)||d.hookOptions.length!==3||!d.hookOptions.every(text)||new Set(d.hookOptions.map((s:string)=>s.trim().toLowerCase())).size!==3||!record(d.proofSelection)||!text(d.proofSelection.reason)||!array(d.proofSelection.references)||!d.proofSelection.references.every((r:string)=>references.has(r)))problems.push('Copy needs a chosen structure, three distinct openings and an evidence-based proof decision.');
  }
  if(packs.some(p=>p.packId==='visual-briefing')){
    const v=d.visualDecision;
    if(!record(v)||!['illustrative','evidential'].includes(v.evidenceClass)||!text(v.point)||v.placement!==context.visual.placement||!array(v.assetIds)||!v.assetIds.every((id:string)=>context.visual.assets.some(a=>a.id===id))||v.evidenceClass==='evidential'&&!v.assetIds.some((id:string)=>context.visual.assets.some(a=>a.id===id&&a.kind==='evidence')))problems.push('Visual evidence and placement must match available approved assets.');
    if(!record(v)||!array(v.styleReferences)||!v.styleReferences.every((id:string)=>context.visual.guidance.some(g=>g.id===id)))problems.push('Visual style references must match confirmed guidance.');
    for(const colour of prose.match(/#[0-9a-f]{6}(?:[0-9a-f]{2})?\b/gi)??[])if(!context.visual.guidance.some(g=>array(v?.styleReferences)&&v.styleReferences.includes(g.id)&&g.text.toLowerCase().includes(colour.toLowerCase())))problems.push('Exact colours need a matching confirmed style reference.');
  }
  if(stage==='email'){
    const emails=Array.isArray(asset.emails)?asset.emails:[];
    if(!array(d.sequenceMap)||d.sequenceMap.length!==emails.length||!emails.every((_e,i)=>d.sequenceMap.some((m:any)=>m.position===i+1&&text(m.purpose)&&text(m.reason))))problems.push('Record each email purpose and sequence position.');
  }
  if(stage==='advocacy'&&(!record(d.consentReview)||!text(d.consentReview.process)||d.consentReview.delivery!=='owner-managed'||d.consentReview.proofUse!=='requires-separate-permission'||!record(d.incentiveReview)||!text(d.incentiveReview.terms)||!text(d.incentiveReview.reason)))problems.push('Record the consent process, separate proof permission and incentive review.');
  return [...new Set(problems)];
}
