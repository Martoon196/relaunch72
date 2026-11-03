/** Genuine actor/brand engine reads only. This view is not an admission or mutation boundary. */
import type {SeoBlogEngine,Actor} from './engine.js';
import {SeoBlogError,type KnowledgeDocument,type KnowledgeRef,type Publication} from './types.js';
import {buildAuthorityProgrammeReview,authorityReviewSources,type AuthorityReviewInput,type AuthorityProgrammeReview} from './authority-programme-findings.js';
import {buildAuthorityAssetBriefs,type AuthorityAssetBrief} from './authority-asset-briefs.js';
export type AuthorityProgrammeReader=Pick<SeoBlogEngine,'getBrand'|'getProfile'|'listKnowledge'|'getInventory'|'listArticles'|'getArticle'>;
export const AUTHORITY_NATIVE_LIMITS=Object.freeze({articleDetails:30,concurrency:3});
export interface AuthorityProgrammeCoverage {readonly publishedArticles:number;readonly detailReads:number;readonly omitted:number;readonly ambiguous:number;readonly unobserved:number;readonly unusable:number;readonly observed:number;}
export interface AuthorityProgrammePageData {
 readonly brand:{readonly id:string;readonly name:string;readonly website:string|null};readonly readAt:string;
 readonly status:'ready'|'needs_website'|'needs_profile'|'needs_confirmation'|'needs_inventory'|'guidance_changed'|'evidence_unavailable';
 readonly guidanceChange?:'visual_only'|'other'|'ambiguous';
 readonly review:AuthorityProgrammeReview|null;readonly briefs:readonly AuthorityAssetBrief[];readonly coverage:AuthorityProgrammeCoverage;
 readonly readOnly:true;readonly atomicSnapshot:false;
}
const emptyCoverage=():AuthorityProgrammeCoverage=>({publishedArticles:0,detailReads:0,omitted:0,ambiguous:0,unobserved:0,unusable:0,observed:0});
const refKey=(r:KnowledgeRef)=>`${r.documentId}:${r.version}:${r.sha256}:${r.category}`;
function latestKnowledge(all:readonly KnowledgeDocument[],brandId:string):{refs:KnowledgeRef[];ambiguous:boolean} {
 const latest=new Map<string,KnowledgeDocument>();let ambiguous=false;
 for(const doc of all){
  if(doc.brandId!==brandId)throw new SeoBlogError(503,'Saved brand evidence could not be matched. Try again later.');
  const previous=latest.get(doc.id);
  if(!previous||doc.version>previous.version)latest.set(doc.id,doc);
  else if(previous.version===doc.version&&(previous.sha256!==doc.sha256||previous.category!==doc.category||previous.active!==doc.active||Boolean(previous.text)!==Boolean(doc.text)))ambiguous=true;
 }
 // Retired latest versions must not resurrect active older versions.
 const refs=[...latest.values()].filter(d=>d.active&&d.text).map(d=>({documentId:d.id,version:d.version,sha256:d.sha256,category:d.category})).sort((a,b)=>a.documentId.localeCompare(b.documentId));
 return {refs,ambiguous};
}
const denied=(error:unknown)=>error instanceof SeoBlogError&&[401,403,404].includes(error.status);
/** No mutators are available through this interface; each read repeats the genuine engine guard. */
export async function loadAuthorityProgrammePage(engine:AuthorityProgrammeReader,actor:Actor,brandId:string,options:{readonly now?:string;readonly maxEvidenceAgeDays?:number}={}):Promise<AuthorityProgrammePageData> {
 const now=options.now??new Date().toISOString();let rawBrand:Awaited<ReturnType<AuthorityProgrammeReader['getBrand']>>;
 try{rawBrand=await engine.getBrand(actor,brandId);}catch(error){if(denied(error))throw error;throw new SeoBlogError(503,'The authority review is temporarily unavailable. Try again later.');}
 if(rawBrand.id!==brandId)throw new SeoBlogError(404,'That brand was not found.');
 const brand=Object.freeze({id:rawBrand.id,name:rawBrand.name,website:rawBrand.website});
 const result=(status:AuthorityProgrammePageData['status'],extra:Partial<AuthorityProgrammePageData>={}):AuthorityProgrammePageData=>Object.freeze({brand,readAt:now,status,review:null,briefs:Object.freeze([]),coverage:Object.freeze(emptyCoverage()),readOnly:true,atomicSnapshot:false,...extra});
 if(!brand.website)return result('needs_website');
 try{const url=new URL(brand.website);if(url.protocol!=='https:'||url.username||url.password)return result('needs_website');}catch{return result('needs_website');}
 const reads=await Promise.allSettled([engine.getProfile(actor,brandId),engine.listKnowledge(actor,brandId),engine.getInventory(actor,brandId)] as const);
 for(const r of reads)if(r.status==='rejected'&&denied(r.reason))throw r.reason;
 if(reads.some(r=>r.status==='rejected'))throw new SeoBlogError(503,'The saved authority evidence is temporarily unavailable. Try again later.');
 const [profile,documents,inventory]=reads.map(r=>r.status==='fulfilled'?r.value:null) as [Awaited<ReturnType<AuthorityProgrammeReader['getProfile']>>,KnowledgeDocument[],Awaited<ReturnType<AuthorityProgrammeReader['getInventory']>>];
 if(!profile)return result('needs_profile');
 if(profile.brandId!==brandId)return result('evidence_unavailable');
 if(!profile.confirmedAt)return result('needs_confirmation');
 if(!inventory)return result('needs_inventory');
 const current=latestKnowledge(documents,brandId);
 if(current.ambiguous)return result('guidance_changed',{guidanceChange:'ambiguous'});
 const previous=new Map(profile.knowledge.map(r=>[r.documentId,r])),active=new Map(current.refs.map(r=>[r.documentId,r]));
 const changed=[...new Set([...previous.keys(),...active.keys()])].filter(id=>!previous.has(id)||!active.has(id)||refKey(previous.get(id)!)!==refKey(active.get(id)!));
 if(changed.length){
  const visualOnly=changed.every(id=>(!previous.has(id)||previous.get(id)!.category==='visual_guidance')&&(!active.has(id)||active.get(id)!.category==='visual_guidance'));
  return result('guidance_changed',{guidanceChange:visualOnly?'visual_only':'other'});
 }
 const base:AuthorityReviewInput={brand:{id:brand.id,name:brand.name,website:brand.website},profile,currentKnowledge:current.refs,inventory,deliveries:[],now,maxEvidenceAgeDays:options.maxEvidenceAgeDays??14};
 try{authorityReviewSources(base);}catch{return result('evidence_unavailable');}
 let rows:Awaited<ReturnType<AuthorityProgrammeReader['listArticles']>>;
 try{rows=await engine.listArticles(actor,brandId);}catch(error){if(denied(error))throw error;throw new SeoBlogError(503,'Saved publication evidence is temporarily unavailable. Try again later.');}
 if(rows.some(r=>r.article.brandId!==brandId))return result('evidence_unavailable');
 const published=rows.filter(r=>r.article.publishedVersionId&&r.article.publishedUrl).sort((a,b)=>(Date.parse(b.article.publishedAt??'')||0)-(Date.parse(a.article.publishedAt??'')||0)||a.article.id.localeCompare(b.article.id));
 if(new Set(published.map(r=>r.article.id)).size!==published.length)return result('evidence_unavailable');
 const selected=published.slice(0,AUTHORITY_NATIVE_LIMITS.articleDetails),deliveries:AuthorityReviewInput['deliveries'][number][]=[];
 const coverage={...emptyCoverage(),publishedArticles:published.length,omitted:Math.max(0,published.length-selected.length)};
 for(let offset=0;offset<selected.length;offset+=AUTHORITY_NATIVE_LIMITS.concurrency){
  const chunk=selected.slice(offset,offset+AUTHORITY_NATIVE_LIMITS.concurrency);
  const details=await Promise.allSettled(chunk.map(row=>engine.getArticle(actor,brandId,row.article.id)));
  for(const d of details)if(d.status==='rejected'&&denied(d.reason))throw d.reason;
  if(details.some(d=>d.status==='rejected'))throw new SeoBlogError(503,'Saved publication evidence is temporarily unavailable. Try again later.');
  for(let i=0;i<details.length;i++){
   const entry=details[i]!;if(entry.status!=='fulfilled')continue;coverage.detailReads++;
   const d=entry.value,a=d.article;
   if(a.brandId!==brandId||a.id!==chunk[i]!.article.id)return result('evidence_unavailable');
   const version=d.versions.find(v=>v.id===a.publishedVersionId&&v.brandId===brandId&&v.articleId===a.id);
   if(!version||!a.publishedUrl){coverage.unobserved++;continue;}
   const matches=d.publications.filter(p=>p.brandId===brandId&&p.articleId===a.id&&p.versionId===version.id&&p.contentSha===version.contentSha&&p.state==='published'&&p.publicUrl===a.publishedUrl);
   let operation:Publication|undefined;
   const pinned=matches.find(p=>p.id===a.deliveryPublicationId);
   if(pinned)operation=pinned;else if(matches.length===1)operation=matches[0];else if(matches.length>1){coverage.ambiguous++;continue;}
   if(!operation?.websiteDelivery){coverage.unobserved++;continue;}
   const delivery={publicationId:operation.id,articleId:a.id,articleVersionId:version.id,canonicalUrl:a.publishedUrl,evidence:operation.websiteDelivery};
   try{authorityReviewSources({...base,deliveries:[delivery]});deliveries.push(delivery);coverage.observed++;}catch{coverage.unusable++;}
  }
 }
 try{const input={...base,deliveries};const review=buildAuthorityProgrammeReview(input),briefs=buildAuthorityAssetBriefs(input,review);return result('ready',{review,briefs,coverage:Object.freeze(coverage)});}catch{return result('evidence_unavailable',{coverage:Object.freeze(coverage)});}
}
