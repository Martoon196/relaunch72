/** Grounded planning briefs only; no drafted claims, statistics, outreach or model calls. */
import type {KnowledgeRef} from './types.js';
import {authorityReviewSources,authorityReviewSha,AuthorityReviewInputError,AUTHORITY_REVIEW_LIMITS,type AuthorityReviewInput,type AuthorityProgrammeReview,type AuthorityReviewIdentity} from './authority-programme-findings.js';
export interface AuthorityAssetBrief {
 readonly id:string;readonly rulesVersion:'r72-authority-asset-brief-v1';readonly kind:'checklist'|'resource'|'comparison';
 readonly question:string;readonly questionTruncated:boolean;readonly audience:string;readonly proposedTitle:string;
 readonly sourceIdentity:AuthorityReviewIdentity;readonly preparedAt:string;
 readonly availableFacts:readonly {readonly text:string;readonly profileVersion:number;readonly qualification:'confirmed_profile'|'review_against_open_conflicts';readonly documentRefs:readonly KnowledgeRef[]}[];
 readonly evidence:readonly {readonly source:'confirmed_profile'|'site_inventory'|'supplier_index';readonly sourceId:string;readonly url:string|null;readonly observedAt:string;readonly sha256:string}[];
 readonly outline:readonly string[];readonly missingInputs:readonly string[];
 readonly status:'owner_review';readonly scheduled:false;readonly publishable:false;
}
export function buildAuthorityAssetBriefs(raw:AuthorityReviewInput,review:AuthorityProgrammeReview):readonly AuthorityAssetBrief[] {
 const {input,identity}=authorityReviewSources(raw);
 if(review.schema!=='relaunch72.authority-review/v1'||review.identity.snapshotSha256!==identity.snapshotSha256||review.identity.brandId!==identity.brandId||review.maxEvidenceAgeDays!==input.maxEvidenceAgeDays||review.observedAt!==input.now)throw new AuthorityReviewInputError();
 const p=input.profile,audience=p.audiences.find(a=>a.trim());if(!audience)return Object.freeze([]);
 const fresh=(at:string)=>Date.parse(input.now)-Date.parse(at)<=input.maxEvidenceAgeDays*86400000;
 const documentRefs=Object.freeze(p.knowledge.map(r=>Object.freeze({...r})));
 const availableFacts=Object.freeze(p.approvedClaims.slice(0,8).map(text=>Object.freeze({text,profileVersion:p.version,qualification:p.conflicts.length?'review_against_open_conflicts' as const:'confirmed_profile' as const,documentRefs})));
 const profileEvidence=Object.freeze({source:'confirmed_profile' as const,sourceId:'profile:'+p.version,url:null,observedAt:p.confirmedAt!,sha256:identity.profileSha256});
 const missing=Object.freeze([...new Set([
  ...p.conflicts.map(c=>`Resolve ${c.field}: ${c.detail}`),...p.missingFacts,
  'Choose the final scope and owner-approved wording.',
  'Add a dated primary reference for each factual step.',
  ...(availableFacts.length?[]:['Supply current owner-approved facts for the proposed asset.']),
 ])].slice(0,14));
 const out=new Map<string,AuthorityAssetBrief>();
 const add=(kind:AuthorityAssetBrief['kind'],question:string,title:string,evidence:AuthorityAssetBrief['evidence'],outline:readonly string[])=>{
  const id='asset-brief:v1:'+authorityReviewSha({brand:identity.brandId,kind,audience,question});
  out.set(id,Object.freeze({id,rulesVersion:'r72-authority-asset-brief-v1',kind,question:question.slice(0,500),questionTruncated:question.length>500,audience,proposedTitle:title.slice(0,700),sourceIdentity:identity,preparedAt:input.now,availableFacts,evidence:Object.freeze([...evidence]),outline:Object.freeze([...outline]),missingInputs:missing,status:'owner_review',scheduled:false,publishable:false}));
 };
 const offers=[...new Set(p.offers.map(o=>o.name.trim()).filter(Boolean))];
 if(offers[0])add('checklist',`What should ${audience} check before choosing ${offers[0]}?`,`${offers[0]}: a practical decision checklist`,[profileEvidence],['Who this checklist helps and which decision it supports','Checks supported by the confirmed brand facts','Evidence to gather and questions to resolve','A practical next step without promised outcomes']);
 if(fresh(input.inventory.fetchedAt)){
  const page=[...input.inventory.pages].filter(x=>x.fetchStatus==='ok'&&x.editorial&&x.title?.trim()).sort((a,b)=>a.url.localeCompare(b.url))[0];
  if(page?.title)add('resource',`What practical checks help with “${page.title}”?`,`A useful resource for: ${page.title}`,[profileEvidence,Object.freeze({source:'site_inventory',sourceId:page.url,url:page.url,observedAt:input.inventory.fetchedAt,sha256:authorityReviewSha(page)})],['Start with the existing page and its reader question','Turn confirmed facts into a useful reference or checklist','Identify unsupported steps and missing primary sources','Review the resource alongside the source article']);
 }
 if(offers.length>=2)add('comparison',`How should ${audience} compare ${offers[0]} and ${offers[1]}?`,`${offers[0]} and ${offers[1]}: comparison worksheet`,[profileEvidence],['Define the decision and comparison criteria','Record current owner-approved differences with sources','Leave unconfirmed prices, allowances and claims blank','Explain which questions still need an answer']);
 const sample=input.indexedMentions;
 if(sample?.outcome==='results'&&fresh(sample.receipt.retrievedAt)){
  const item=[...sample.items].filter(x=>x.question?.trim()&&fresh(x.retrievedAt)).sort((a,b)=>a.id.localeCompare(b.id))[0];
  if(item?.question)add('resource',item.question,`Resource idea: ${item.question}`,[profileEvidence,Object.freeze({source:'supplier_index',sourceId:item.id,url:null,observedAt:item.retrievedAt,sha256:authorityReviewSha(item)})],['Review this supplier-indexed question for audience relevance','Answer only with supported brand facts and primary references','Separate unknown inputs from confirmed statements','Link to the most useful owned reference if it exists']);
 }
 return Object.freeze([...out.values()].sort((a,b)=>a.id.localeCompare(b.id)).slice(0,AUTHORITY_REVIEW_LIMITS.briefs));
}
