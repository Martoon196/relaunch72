/** Deterministic PRIVATE review candidates; no calls, persistence, approvals or ranking score. */
import {createHash} from 'node:crypto';
import type {BrandProfile,KnowledgeRef,WebsiteInventory} from './types.js';
import type {WebsiteDeliveryEvidence,WebsiteObservation} from './website-delivery.js';
import type {AuthoritySample,IndexedMentionObservation} from './authority-types.js';
export const AUTHORITY_REVIEW_RULES='r72-authority-programme-review-v1' as const;
export const AUTHORITY_REVIEW_LIMITS=Object.freeze({inputBytes:1_048_576,pages:250,deliveries:30,mentions:25,findings:40,briefs:8});
export type ReviewClassification='observed'|'inferred'|'unknown';
export interface AuthorityReviewInput {
 readonly brand:{readonly id:string;readonly name:string;readonly website:string};
 readonly profile:BrandProfile;readonly currentKnowledge:readonly KnowledgeRef[];readonly inventory:WebsiteInventory;
 readonly deliveries:readonly {readonly publicationId:string;readonly articleId:string;readonly articleVersionId:string;readonly canonicalUrl:string;readonly evidence:WebsiteDeliveryEvidence}[];
 readonly indexedMentions?:AuthoritySample<IndexedMentionObservation>;
 readonly now:string;readonly maxEvidenceAgeDays:number;
}
export interface AuthorityReviewIdentity {
 readonly brandId:string;readonly origin:string;readonly profileVersion:number;readonly factsSha256:string;
 readonly profileSha256:string;readonly knowledgeSha256:string;readonly inventorySha256:string;readonly deliverySha256:string;
 readonly mentionsSha256:string|null;readonly snapshotSha256:string;
}
export interface AuthorityReviewEvidence {
 readonly id:string;readonly source:'confirmed_profile'|'site_inventory'|'served_delivery'|'supplier_index';
 readonly sourceId:string;readonly url:string|null;readonly observedAt:string;readonly sha256:string;
 readonly classification:ReviewClassification;readonly freshness:'current'|'stale';readonly detail:string;
}
export interface AuthorityProgrammeFinding {
 readonly id:string;readonly rulesVersion:typeof AUTHORITY_REVIEW_RULES;readonly rule:string;readonly targetUrl:string|null;
 readonly classification:ReviewClassification;readonly title:string;readonly explanation:string;readonly suggestedAction:string;
 readonly evidence:readonly AuthorityReviewEvidence[];readonly ownerReviewRequired:true;
}
export interface AuthorityProgrammeReview {
 readonly schema:'relaunch72.authority-review/v1';readonly rulesVersion:typeof AUTHORITY_REVIEW_RULES;
 readonly identity:AuthorityReviewIdentity;readonly observedAt:string;readonly maxEvidenceAgeDays:number;
 readonly findings:readonly AuthorityProgrammeFinding[];readonly findingsTruncated:boolean;
 readonly notMeasured:readonly string[];readonly consumerAiResults:'not_measured';readonly referralTraffic:'not_measured';
 readonly indexedSample:null|Readonly<{platform:string;locationCode:number;languageCode:string;since:string;until:string;retrievedAt:string;complete:boolean;observations:readonly Readonly<{id:string;reportedModel:string|null;retrievedAt:string;firstRecordedAt:string|null;lastUpdatedAt:string|null;excerptTruncated:boolean;sourcesTruncated:boolean;searchResultsTruncated:boolean}>[]}>;
 readonly coverage:'bounded_supplied_evidence';readonly persisted:false;readonly ownerReviewRequired:true;
}
export class AuthorityReviewInputError extends Error {constructor(){super('Supply matching brand, confirmed current guidance and bounded, dated source evidence.');this.name='AuthorityReviewInputError';}}
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA=/^[0-9a-f]{64}$/u;
const fail=():never=>{throw new AuthorityReviewInputError();};
function canonical(value:unknown,depth=0):string {
 if(depth>24)fail();if(value===null)return'null';
 if(typeof value==='string'||typeof value==='boolean')return JSON.stringify(value);
 if(typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);
 if(Array.isArray(value))return'['+value.map(v=>canonical(v,depth+1)).join(',')+']';
 if(value&&typeof value==='object')return'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical((value as Record<string,unknown>)[k],depth+1)).join(',')+'}';
 return fail();
}
export const authorityReviewSha=(value:unknown):string=>createHash('sha256').update(canonical(value),'utf8').digest('hex');
const text=(value:unknown,max:number):value is string=>typeof value==='string'&&value.length<=max;
const instant=(value:unknown,now:number):value is string=>typeof value==='string'&&value.length<=40&&/^\d{4}-\d{2}-\d{2}T/u.test(value)&&Number.isFinite(Date.parse(value))&&Date.parse(value)<=now;
function publicUrl(raw:unknown):URL {
 if(!text(raw,2048))return fail();let u:URL;try{u=new URL(raw);}catch{return fail();}
 const host=u.hostname.toLowerCase();
 if(u.protocol!=='https:'||u.username||u.password||(u.port&&u.port!=='443')||!host.includes('.')||/^[\d.]+$/u.test(host)||host.includes(':')||/(?:^|\.)(?:localhost|local|internal|test|invalid)$/u.test(host))return fail();
 return u;
}
const ownUrl=(raw:unknown,origin:string)=>{const u=publicUrl(raw);if(u.origin!==origin)fail();return u.toString();};
const refs=(values:readonly KnowledgeRef[])=>[...values].sort((a,b)=>a.documentId.localeCompare(b.documentId)||a.version-b.version);
const stringArray=(v:unknown,n:number,max:number):v is string[]=>Array.isArray(v)&&v.length<=n&&v.every(x=>text(x,max));
/** Captures exact supplied sources. Later queue admission must CAS these hashes against current stored rows. */
export function authorityReviewSources(raw:AuthorityReviewInput):{input:AuthorityReviewInput;identity:AuthorityReviewIdentity} {
 try {
  const serialized=JSON.stringify(raw);if(Buffer.byteLength(serialized)>AUTHORITY_REVIEW_LIMITS.inputBytes)fail();
  const input=JSON.parse(serialized) as AuthorityReviewInput;canonical(input);
  const now=Date.parse(input.now);if(!Number.isFinite(now)||!instant(input.now,now)||!Number.isInteger(input.maxEvidenceAgeDays)||input.maxEvidenceAgeDays<1||input.maxEvidenceAgeDays>365)fail();
  if(!UUID.test(input.brand.id)||!text(input.brand.name,250)||!input.brand.name.trim())fail();
  const origin=publicUrl(input.brand.website).origin,p=input.profile,inv=input.inventory;
  if(p.brandId!==input.brand.id||inv.brandId!==input.brand.id||publicUrl(inv.website).origin!==origin||!Number.isSafeInteger(p.version)||p.version<1||!SHA.test(p.factsSha)||!p.confirmedAt||!instant(p.confirmedAt,now)||!p.confirmedBy||!UUID.test(p.confirmedBy))fail();
  for(const collection of [p.knowledge,input.currentKnowledge]){
   if(!Array.isArray(collection)||collection.length>100||new Set(collection.map(r=>r.documentId)).size!==collection.length)fail();
   for(const r of collection)if(!UUID.test(r.documentId)||!Number.isSafeInteger(r.version)||r.version<1||!SHA.test(r.sha256)||!text(r.category,50))fail();
  }
  if(authorityReviewSha(refs(p.knowledge))!==authorityReviewSha(refs(input.currentKnowledge)))fail();
  if(!stringArray(p.audiences,20,500)||!stringArray(p.approvedClaims,50,2000)||!stringArray(p.missingFacts,50,2000)||!Array.isArray(p.conflicts)||p.conflicts.length>50||p.conflicts.some(c=>!text(c.field,500)||!text(c.detail,2000))||!Array.isArray(p.offers)||p.offers.length>30||p.offers.some(o=>!text(o.name,250)||!text(o.description,2000)||(o.price!==null&&!text(o.price,500))))fail();
  if(!instant(inv.fetchedAt,now)||!Array.isArray(inv.pages)||inv.pages.length>AUTHORITY_REVIEW_LIMITS.pages||!stringArray(inv.notes,30,2000))fail();
  for(const page of inv.pages){
   ownUrl(page.url,origin);if(page.canonical!==null)publicUrl(page.canonical);
   if((page.title!==null&&!text(page.title,1000))||!stringArray(page.headings,50,1000)||!text(page.excerpt,8000)||!['ok','http_error','blocked','too_large','not_html','error'].includes(page.fetchStatus)||typeof page.editorial!=='boolean')fail();
  }
  if(!Array.isArray(input.deliveries)||input.deliveries.length>AUTHORITY_REVIEW_LIMITS.deliveries||new Set(input.deliveries.map(d=>d.articleId)).size!==input.deliveries.length)fail();
  for(const d of input.deliveries){
   if(!UUID.test(d.publicationId)||!UUID.test(d.articleId)||!UUID.test(d.articleVersionId))fail();const url=ownUrl(d.canonicalUrl,origin);
   if(!Array.isArray(d.evidence.categories)||d.evidence.categories.length>5||ownUrl(d.evidence.article.url,origin)!==url)fail();
   for(const o of [d.evidence.article,d.evidence.index,...d.evidence.categories,d.evidence.sitemap]){
    ownUrl(o.url,origin);if(!instant(o.at,now)||!['verified','pending','different','unknown','incomplete'].includes(o.state)||!text(o.detail,2000))fail();
    if(o.finalUrl)publicUrl(o.finalUrl);if(o.canonical)publicUrl(o.canonical);
   }
   const s=d.evidence.sitemap;if(typeof s.complete!=='boolean'||!Number.isSafeInteger(s.occurrences)||s.occurrences<0||s.occurrences>50000)fail();
  }
  const sample=input.indexedMentions;
  if(sample){
   const scope=sample.scope;
   if(scope.kind!=='indexed_mentions')return fail();
   if(!['results','empty','unconfigured','unsupported','not_started','provider_rejected','outcome_unknown'].includes(sample.outcome)||sample.receipt.supplier!=='dataforseo'||scope.kind!=='indexed_mentions'||!['google','chat_gpt'].includes(scope.platform)||!Number.isSafeInteger(scope.locationCode)||scope.locationCode<1||!(/^[a-z]{2}$/u.test(scope.languageCode))||!(/^\d{4}-\d{2}-\d{2}$/u.test(scope.since))||!(/^\d{4}-\d{2}-\d{2}$/u.test(scope.until))||scope.since>scope.until||scope.brandId!==input.brand.id||scope.brandDomain.toLowerCase().replace(/^www\./u,'')!==new URL(origin).hostname.replace(/^www\./u,'')||!Array.isArray(sample.items)||sample.items.length>AUTHORITY_REVIEW_LIMITS.mentions||!instant(sample.receipt.retrievedAt,now)||!SHA.test(sample.receipt.inputSha256)||typeof sample.complete!=='boolean')fail();
   for(const item of sample.items){
    if((item.reportedModel!==null&&!text(item.reportedModel,250))||typeof item.excerptTruncated!=='boolean'||typeof item.sourcesTruncated!=='boolean'||typeof item.searchResultsTruncated!=='boolean'||item.brandId!==input.brand.id||item.kind!=='supplier_indexed_mention'||item.platform!==scope.platform||item.locationCode!==scope.locationCode||item.languageCode!==scope.languageCode||item.consumerResultObserved!==false||item.referralTrafficMeasured!==false||!text(item.id,200)||!instant(item.retrievedAt,now)||(item.question!==null&&!text(item.question,2000))||(item.answerExcerpt!==null&&!text(item.answerExcerpt,4000))||!Array.isArray(item.sources)||item.sources.length>25||!Array.isArray(item.searchResults)||item.searchResults.length>25)fail();
    for(const s of [...item.sources,...item.searchResults])publicUrl(s.url);
   }
  }
  const hashes={brandId:input.brand.id,origin,profileVersion:p.version,factsSha256:p.factsSha,profileSha256:authorityReviewSha(p),knowledgeSha256:authorityReviewSha(refs(input.currentKnowledge)),inventorySha256:authorityReviewSha(inv),deliverySha256:authorityReviewSha(input.deliveries),mentionsSha256:sample?authorityReviewSha(sample):null};
  return {input,identity:Object.freeze({...hashes,snapshotSha256:authorityReviewSha({rulesVersion:AUTHORITY_REVIEW_RULES,...hashes})})};
 }catch{return fail();}
}
export function buildAuthorityProgrammeReview(raw:AuthorityReviewInput):AuthorityProgrammeReview {
 const {input,identity}=authorityReviewSources(raw),found=new Map<string,AuthorityProgrammeFinding>();
 const stale=(at:string)=>Date.parse(input.now)-Date.parse(at)>input.maxEvidenceAgeDays*86400000;
 const evidence=(source:AuthorityReviewEvidence['source'],sourceId:string,url:string|null,at:string,value:unknown,classification:ReviewClassification,detail:string):AuthorityReviewEvidence=>Object.freeze({id:'evidence:'+authorityReviewSha({brand:identity.brandId,source,sourceId,value}),source,sourceId,url,observedAt:at,sha256:authorityReviewSha(value),classification,freshness:stale(at)?'stale':'current',detail});
 const add=(rule:string,targetUrl:string|null,classification:ReviewClassification,title:string,explanation:string,suggestedAction:string,ev:readonly AuthorityReviewEvidence[])=>{
  const id='finding:v1:'+authorityReviewSha({brand:identity.brandId,rule,targetUrl});
  found.set(id,Object.freeze({id,rulesVersion:AUTHORITY_REVIEW_RULES,rule,targetUrl,classification,title,explanation,suggestedAction,evidence:Object.freeze([...ev]),ownerReviewRequired:true as const}));
 };
 const inv=input.inventory,scanOld=stale(inv.fetchedAt);
 if(scanOld)add('stale-inventory',identity.origin,'unknown','Refresh the website evidence','The supplied scan is older than the chosen review freshness window.','Read the website again before acting on content recommendations.',[evidence('site_inventory','inventory',inv.website,inv.fetchedAt,inv,'unknown','A bounded historical inventory, not current site proof.')]);
 const titles=new Map<string,Set<string>>();
 for(const page of [...inv.pages].sort((a,b)=>a.url.localeCompare(b.url))){
  const ev=evidence('site_inventory',page.url,page.url,inv.fetchedAt,page,scanOld||page.fetchStatus!=='ok'?'unknown':'observed','Metadata recorded by the bounded website scan.');
  if(page.fetchStatus!=='ok'){add('page-unread',page.url,'unknown','Check an unread page',`The scan recorded ${page.fetchStatus}; page content and metadata are not established.`,'Inspect the page or repeat its read.',[ev]);continue;}
  if(scanOld)continue;
  if(!page.canonical||page.canonical!==page.url)add('canonical-review',page.url,'observed','Review the recorded canonical','The scan recorded no canonical or a different canonical address.','Check the intended preferred URL and the served page metadata.',[ev]);
  if(!page.title?.trim())add('title-review',page.url,'observed','Review the recorded page title','No title was recorded for this successfully read page.','Inspect the served title and choose a useful, accurate page title.',[ev]);
  else{const key=page.title.trim().toLowerCase().replace(/\s+/gu,' ');const set=titles.get(key)??new Set<string>();set.add(page.url);titles.set(key,set);}
  if(page.editorial&&!page.headings.length)add('heading-review',page.url,'observed','Review the heading structure','The scan recorded no headings. Heading levels were not captured by this read.','Inspect the visible page and arrange headings around its reader question.',[ev]);
 }
 for(const [title,urls]of [...titles].sort(([a],[b])=>a.localeCompare(b)))if(urls.size>1){const pages=inv.pages.filter(p=>urls.has(p.url)).sort((a,b)=>a.url.localeCompare(b.url));add('duplicate-title:'+authorityReviewSha(title),pages[0]!.url,'observed','Review repeated recorded titles',`${urls.size} distinct scanned URLs share a recorded title.`,'Decide whether these pages answer different questions before changing their titles.',pages.map(p=>evidence('site_inventory',p.url,p.url,inv.fetchedAt,p,'observed','Recorded title on this page.')));}
 for(const d of [...input.deliveries].sort((a,b)=>a.publicationId.localeCompare(b.publicationId))){
  const dims:[string,WebsiteObservation][]=[['article',d.evidence.article],['index',d.evidence.index],...d.evidence.categories.map((o,i)=>['category-'+i,o]as[string,WebsiteObservation]),['sitemap',d.evidence.sitemap]];
  for(const [dimension,o]of dims){
   const uncertain=stale(o.at)||o.state==='unknown'||o.state==='incomplete'||(dimension==='sitemap'&&!d.evidence.sitemap.complete);
   if(!uncertain&&o.state==='verified'&&!(dimension==='sitemap'&&d.evidence.sitemap.occurrences!==1))continue;
   add('delivery-'+dimension,d.canonicalUrl,uncertain?'unknown':'observed',`Review ${dimension.replace(/-\d+$/u,'')} delivery evidence`,uncertain?'This read is stale, unknown or incomplete; it cannot prove presence or absence.':o.state==='different'?'The served page differs from the expected publication.':'The public check is still waiting for matching evidence.','Recheck this exact published version and address before choosing a remedy.',[evidence('served_delivery',d.publicationId+':'+dimension,o.url,o.at,{publicationId:d.publicationId,articleId:d.articleId,articleVersionId:d.articleVersionId,observation:o},uncertain?'unknown':'observed',o.detail)]);
  }
 }
 if(input.profile.conflicts.length||input.profile.missingFacts.length)add('profile-open-inputs',null,'observed','Keep unsettled claims out of new assets','The confirmed profile still records questions or conflicts.','Resolve the relevant source fact before including that claim in an asset.',[evidence('confirmed_profile','profile:'+input.profile.version,null,input.profile.confirmedAt!,input.profile,'observed','Owner-confirmed private profile; open inputs remain explicit.')]);
 const sample=input.indexedMentions;
 if(sample){
  const scope=sample.scope;if(scope.kind!=='indexed_mentions')return fail();
  const uncertain=sample.outcome!=='results'||!sample.complete||stale(sample.receipt.retrievedAt);
  add('indexed-mention-sample',null,uncertain?'unknown':'observed','Review the supplier-indexed AI sample',`${sample.items.length} indexed observation${sample.items.length===1?'':'s'} supplied for ${scope.platform==='chat_gpt'?'ChatGPT':'Google'} during ${scope.since} to ${scope.until}. Empty or partial samples do not establish absence from live AI answers.`,'Review sampled questions and cited pages alongside your confirmed facts.',[evidence('supplier_index',sample.receipt.taskId??sample.receipt.inputSha256,null,sample.receipt.retrievedAt,sample,uncertain?'unknown':'observed',`Supplier index · market code ${scope.locationCode} · language ${scope.languageCode}. Consumer UI placement and referral traffic were not measured.`)]);
 }
 const all=[...found.values()].sort((a,b)=>a.id.localeCompare(b.id));
 const scope=sample?.scope;const indexedSample=sample&&scope?.kind==='indexed_mentions'?Object.freeze({platform:scope.platform,locationCode:scope.locationCode,languageCode:scope.languageCode,since:scope.since,until:scope.until,retrievedAt:sample.receipt.retrievedAt,complete:sample.complete,observations:Object.freeze(sample.items.map(o=>Object.freeze({id:o.id,reportedModel:o.reportedModel,retrievedAt:o.retrievedAt,firstRecordedAt:o.firstRecordedAt,lastUpdatedAt:o.lastUpdatedAt,excerptTruncated:o.excerptTruncated,sourcesTruncated:o.sourcesTruncated,searchResultsTruncated:o.searchResultsTruncated})))}):null;
 return Object.freeze({schema:'relaunch72.authority-review/v1',rulesVersion:AUTHORITY_REVIEW_RULES,identity,observedAt:input.now,maxEvidenceAgeDays:input.maxEvidenceAgeDays,findings:Object.freeze(all.slice(0,AUTHORITY_REVIEW_LIMITS.findings)),findingsTruncated:all.length>AUTHORITY_REVIEW_LIMITS.findings,notMeasured:Object.freeze(['robots.txt permissions','meta and header noindex','structured data','backlinks and earned links','site traffic','consumer AI answer placement','referral traffic']),consumerAiResults:'not_measured',referralTraffic:'not_measured',indexedSample,coverage:'bounded_supplied_evidence',persisted:false,ownerReviewRequired:true});
}
