/** Website protocol data is private, typed evidence, never an editable string-config claim. */
import { createHash,randomUUID } from 'node:crypto';
import { SeoBlogError } from './types.js';
import type { Article, ArticleVersion, Brand, Destination, Publication, Job, BrandProfile, KnowledgeDocument, ArticleBrief } from './types.js';
import {FACTUAL_KNOWLEDGE_CATEGORIES} from './types.js';
import {programmeKnowledgeRefs,type ProgrammeAuthority} from './programme.js';

export interface WebsiteRoot {
  readonly id: string;
  readonly path: string;
  readonly indexUrl: string;
  readonly articleUrlPattern: string;
  readonly categoryUrlPattern: string;
}
export interface WebsiteCapabilities {
  readonly contractVersion: 2;
  readonly siteId: string;
  readonly publicOrigin: string;
  readonly capabilitiesSha: string;
  readonly roots: readonly WebsiteRoot[];
  readonly taxonomy: {readonly mode: 'categories'; readonly maxCategoriesPerArticle: number};
  readonly sitemaps: readonly string[];
  readonly updates: {readonly preservePublishedUrl: true};
  readonly repair: {readonly sitemap: boolean};
  /**
   * Explicit, versioned URL extension. Absent: the strict v2 single-root URL rules
   * (`{origin}/{root}`, `/{root}/{slug}`, `/{root}/category/{slug}`). Present only for
   * adapters that opt in (WordPress): declared same-origin permalink patterns.
   */
  readonly urlContract?: typeof WORDPRESS_URL_CONTRACT;
}
/** WordPress permalink URL extension of the v2 website contract. */
export const WORDPRESS_URL_CONTRACT='wordpress-permalinks-1' as const;
export interface CapabilityParseOptions {readonly urlContract?: typeof WORDPRESS_URL_CONTRACT}
export type WebsiteCapabilityReceipt =
  | {readonly protocol: 'legacy'; readonly checkedAt: string}
  | {readonly protocol: 'v2'; readonly checkedAt: string; readonly capabilities: WebsiteCapabilities};
export interface WebsiteCategory {readonly id: string; readonly slug: string; readonly label: string}
/** EXACT PP v2 wire target. Root paths are relative single segments. */
export interface WebsiteWireTarget {
  readonly siteId: string;
  readonly capabilitiesSha: string;
  readonly rootId: string;
  readonly rootPath: string;
  readonly canonicalUrl: string;
  readonly indexUrl: string;
  readonly structureId: string;
  readonly structureRevision: number;
  readonly structureSha: string;
  readonly categories: readonly WebsiteCategory[];
  readonly categoryIds: readonly string[];
}
export interface WebsiteStructure {
  readonly siteId: string;
  readonly structureId: string;
  readonly rootId: string;
  readonly rootPath: string;
  readonly categories: readonly (WebsiteCategory & {readonly recommendationId: string})[];
}
export interface ArticleWebsiteTarget {
  readonly origin: 'programme_default' | 'owner_review';
  readonly schema: 1;
  readonly destinationId: string;
  readonly brandName: string;
  readonly locale: string;
  readonly contractVersion: 2;
  readonly target: WebsiteWireTarget;
  readonly categoryUrls: readonly string[];
  readonly sitemapUrls: readonly string[];
  /** Digest of the complete reviewed article body plus target/catalog/membership. */
  readonly deliverySha: string;
}
export interface PublicationWebsiteSnapshot {
  /** Reviewed v2 body/target digest; legacy fallback is body binding, never an authorisation token. */
  readonly reviewedIntentSha:string;
  readonly destination: Destination;
  readonly brandName: string;
  readonly locale: string;
  readonly publishedAt: string;
  readonly target: ArticleWebsiteTarget | null;
  readonly requestSha: string;
}
export interface SitemapRepairIntent {
  readonly uncertain:boolean;
  readonly reconcileAttempts:number;
  readonly reconcileAfter:string|null;
  readonly publicationId:string;
  readonly versionId:string;
  readonly targetSha:string;
  readonly sitemapSourceSha:string;
  readonly id:string;
  readonly requestedBy:string;
  readonly requestedAt:string;
  readonly state:'queued'|'calling'|'unknown'|'done'|'held';
  readonly startedAt:string|null;
  readonly providerRef:string|null;
  readonly detail:string;
}
export interface WebsiteReviewSnapshot {
  readonly brand: Brand;
  readonly article: Article;
  readonly version: ArticleVersion;
  readonly destination: Destination;
  readonly publications: readonly Publication[];
}
/** Pure callback under brand -> article -> destination/publication locks; no network/model work. */
export interface WebsiteReviewInput {
  readonly brandId: string;
  readonly articleId: string;
  readonly actorId: string;
  readonly destinationId: string;
  readonly expectedVersionId: string;
  readonly decide: (snapshot: WebsiteReviewSnapshot) => {readonly article: Article; readonly version: ArticleVersion};
}

export interface WebsiteVersionGuard {
  readonly expectedVersionId:string|null;
  readonly structureSha:string;
  readonly structureVersion:number;
  readonly destinationId:string;
  readonly destinationSha:string;
  readonly profileSha:string;
  readonly knowledgeSha:string;
  readonly authority:ProgrammeAuthority;
}
export function assertWebsiteVersionGuard(guard:WebsiteVersionGuard,s:{brand:Brand;article:Article;destination:Destination|null;profile:BrandProfile|null;knowledge:readonly KnowledgeDocument[];brief:ArticleBrief|null;requesterAllowed:boolean}):void {
  const structure=s.brand.settings.programme?.structure;
  if(!UUID.test(guard.authority.sponsorUserId)||!s.requesterAllowed||s.brand.settings.pauseAll||!s.profile?.confirmedAt)throw new SeoBlogError(409,'Current owner authority, profile or pause controls no longer allow this target proposal.');
  const knowledge=programmeKnowledgeRefs(s.knowledge);
  const factual=(refs:typeof knowledge)=>refs.filter((r)=>FACTUAL_KNOWLEDGE_CATEGORIES.has(r.category)).map((r)=>`${r.documentId}:${r.sha256}`).sort().join('|');
  if(s.article.currentVersionId!==guard.expectedVersionId||structure?.sha!==guard.structureSha||structure.version!==guard.structureVersion||!s.destination||s.destination.id!==guard.destinationId||(s.destination.status!=='connected'||destinationIdentity(s.destination)!==guard.destinationSha)||websiteSha(s.profile)!==guard.profileSha||websiteSha(knowledge)!==guard.knowledgeSha||factual(knowledge)!==factual([...s.profile.knowledge]))throw new SeoBlogError(409,'The article, guidance or website changed while the target proposal was being prepared. Review current inputs before a new write.');
  const authority=s.brief?.programme?.authority;
  if(authority&&(authority.origin!==guard.authority.origin||authority.sponsorUserId!==guard.authority.sponsorUserId))throw new SeoBlogError(403,'The source programme authority changed.');
  if(guard.authority.origin==='daily'&&(!s.brand.settings.ongoingProduction||(s.brand.settings.programme?.authorisedBy??s.profile.confirmedBy)!==guard.authority.sponsorUserId))throw new SeoBlogError(409,'Daily programme authority changed while writing.');
}

/** Existing publish-job wakeup, inserted in the SAME transaction as the publication intent/evidence. */
export function websiteWakeJob(p:Publication):Job|null {
  const repair=p.sitemapRepair?.state==='queued'?p.sitemapRepair:null;
  const recovery=p.sitemapRepair&&['calling','unknown'].includes(p.sitemapRepair.state)&&p.sitemapRepair.reconcileAfter&&p.sitemapRepair.reconcileAttempts<6?p.sitemapRepair:null;
  if(!repair&&!recovery&&(p.state!=='published'||!p.websiteObserveAfter))return null;
  const at=repair?.requestedAt??p.websiteDelivery?.article.at??p.verifiedAt??p.scheduledFor;
  return {id:randomUUID(),brandId:p.brandId,kind:'publish',idempotencyKey:repair?`sitemap-repair:${repair.id}`:recovery?`repair-observe:${recovery.id}:${recovery.reconcileAttempts}:${recovery.reconcileAfter}`:`observe:${p.id}:${p.websiteObserveRunId??'initial'}:${p.websiteObserveAttempts??0}`,payload:repair?{sitemapRepair:p.id}:{websiteObservation:p.id},state:'queued',attempts:0,maxAttempts:1,leaseOwner:null,leaseExpiresAt:null,runAfter:repair?.requestedAt??recovery?.reconcileAfter??p.websiteObserveAfter!,progress:repair?'Owner-authorised sitemap-only repair queued.':'Waiting to recheck public website delivery.',error:null,createdAt:at,updatedAt:at,rowVersion:1};
}

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA=/^[a-f0-9]{64}$/;
const SEGMENT=/^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export function websiteSha(value: unknown): string {
  const canonical=(v:unknown):string=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?`[${v.map(canonical).join(',')}]`:`{${Object.entries(v as Record<string,unknown>).filter(([,x])=>x!==undefined).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,x])=>`${JSON.stringify(k)}:${canonical(x)}`).join(',')}}`;
  return createHash('sha256').update(canonical(value)).digest('hex');
}
/** Health timestamps/diagnostic text are observations, not a different website credential or capability. */
export function destinationIdentity(destination:Destination):string {
  const receipt=destination.websiteCapability;
  return websiteSha({id:destination.id,brandId:destination.brandId,type:destination.type,publicBaseUrl:destination.publicBaseUrl,config:destination.config,sealedCredential:destination.sealedCredential,capability:receipt?.protocol==='v2'?{protocol:'v2',capabilities:receipt.capabilities}:receipt?{protocol:'legacy'}:null});
}
/** Deterministic, brand-scoped UUID identity; labels and scan timestamps never change it. */
export function websiteIdentity(...parts: readonly string[]): string {
  const hex=createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
}
function object(value:unknown):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new SeoBlogError(409,'The website returned invalid capabilities.');
  return value as Record<string,unknown>;
}
export function websiteOrigin(value:string):string {
  let u:URL;try{u=new URL(value);}catch{throw new SeoBlogError(400,'Use an exact HTTPS website origin.');}
  if(u.protocol!=='https:'||u.username||u.password||u.port||u.pathname!=='/'||u.search||u.hash)throw new SeoBlogError(400,'Use an exact HTTPS website origin.');
  return u.origin;
}
/** Called only after the authenticated website check; an absent capability object is v1, not v2. */
export function parseWebsiteCapabilities(value:unknown,configuredOrigin:string,at:string,options:CapabilityParseOptions={}):WebsiteCapabilityReceipt {
  const origin=websiteOrigin(configuredOrigin);
  if(value===undefined)return {protocol:'legacy',checkedAt:at};
  const c=object(value);const taxonomy=object(c.taxonomy);const updates=object(c.updates);const repair=object(c.repair);
  if(c.contractVersion!==2||typeof c.siteId!=='string'||!UUID.test(c.siteId)||c.publicOrigin!==origin||typeof c.capabilitiesSha!=='string'||!SHA.test(c.capabilitiesSha)||taxonomy.mode!=='categories'||!Number.isInteger(taxonomy.maxCategoriesPerArticle)||Number(taxonomy.maxCategoriesPerArticle)<0||Number(taxonomy.maxCategoriesPerArticle)>5||updates.preservePublishedUrl!==true||typeof repair.sitemap!=='boolean')throw new SeoBlogError(409,'The website capability contract is unsupported or belongs to another website.');
  if(c.urlContract!==undefined&&(c.urlContract!==WORDPRESS_URL_CONTRACT||options.urlContract!==WORDPRESS_URL_CONTRACT))throw new SeoBlogError(409,'The website advertised a URL contract this connection type does not support.');
  const declared=c.urlContract===WORDPRESS_URL_CONTRACT;
  if(!Array.isArray(c.roots)||!c.roots.length||c.roots.length>20||!Array.isArray(c.sitemaps)||!c.sitemaps.length||c.sitemaps.length>20)throw new SeoBlogError(409,'The website returned an invalid installed-root or sitemap list.');
  const roots=c.roots.map((value)=>{
    const r=object(value);if(typeof r.id!=='string'||typeof r.path!=='string'||!SEGMENT.test(r.id)||!SEGMENT.test(r.path)||r.path.length>80||r.id.length>80)throw new SeoBlogError(409,'The website advertised an unsupported root.');
    if(declared){
      const indexUrl=declaredIndexUrl(r.indexUrl,origin);const article=declaredPattern(r.articleUrlPattern,origin,0);const category=declaredPattern(r.categoryUrlPattern,origin,1);
      if(!indexUrl||!article||!category||article.trailing!==category.trailing)throw new SeoBlogError(409,'The website advertised WordPress permalink patterns this connection cannot verify.');
      return {id:r.id,path:r.path,indexUrl,articleUrlPattern:article.pattern,categoryUrlPattern:category.pattern} as WebsiteRoot;
    }
    const base=`${origin}/${r.path}`;
    if(r.indexUrl!==base||r.articleUrlPattern!==`${base}/{slug}`||r.categoryUrlPattern!==`${base}/category/{slug}`)throw new SeoBlogError(409,'The website advertised URLs outside its installed root.');
    return {id:r.id,path:r.path,indexUrl:base,articleUrlPattern:r.articleUrlPattern,categoryUrlPattern:r.categoryUrlPattern} as WebsiteRoot;
  });
  if(new Set(roots.map((r)=>r.id)).size!==roots.length||new Set(roots.map((r)=>r.path)).size!==roots.length)throw new SeoBlogError(409,'The website advertised duplicate roots.');
  const sitemaps=c.sitemaps.map((value)=>{if(typeof value!=='string'||value.length>2048)throw new SeoBlogError(409,'Invalid website sitemap.');const u=new URL(value);if(u.origin!==origin||u.username||u.password||u.search||u.hash)throw new SeoBlogError(409,'The sitemap must be on this website.');return u.toString();});
  return {protocol:'v2',checkedAt:at,capabilities:{contractVersion:2,siteId:c.siteId,publicOrigin:origin,capabilitiesSha:c.capabilitiesSha,roots,taxonomy:{mode:'categories',maxCategoriesPerArticle:Number(taxonomy.maxCategoriesPerArticle)},sitemaps,updates:{preservePublishedUrl:true},repair:{sitemap:repair.sitemap},...(declared?{urlContract:WORDPRESS_URL_CONTRACT}:{})}};
}

const DECLARED_PATH=/^((?:\/[A-Za-z0-9._~-]+)*)\/\{slug\}(\/?)$/;
/** Same-origin `{prefix}/{slug}[/]` with exactly one slug placeholder as the final segment. */
function declaredPattern(value:unknown,origin:string,minPrefixSegments:number):{pattern:string;trailing:boolean}|null {
  if(typeof value!=='string'||value.length>2048||!value.startsWith(`${origin}/`))return null;
  const match=DECLARED_PATH.exec(value.slice(origin.length));if(!match||match[1]!.split('/').filter(Boolean).length<minPrefixSegments||match[1]!.split('/').some((s)=>s==='.'||s==='..'))return null;
  return {pattern:value,trailing:match[2]==='/'};
}
function declaredIndexUrl(value:unknown,origin:string):string|null {
  if(typeof value!=='string'||value.length>2048)return null;
  let u:URL;try{u=new URL(value);}catch{return null;}
  if(u.origin!==origin||u.username||u.password||u.search||u.hash||u.toString()!==value||!/^(?:\/[A-Za-z0-9._~-]+)*\/?$/.test(u.pathname)||u.pathname.split('/').some((s)=>s==='.'||s==='..'))return null;
  return value;
}
/** True when `url` is exactly this root's article pattern with one valid slug. */
export function articleUrlMatches(root:WebsiteRoot,url:string):boolean {
  const [before,after]=root.articleUrlPattern.split('{slug}') as [string,string];
  if(!url.startsWith(before)||!url.endsWith(after)||url.length<=before.length+after.length)return false;
  return SEGMENT.test(url.slice(before.length,url.length-after.length));
}
export function targetEligibility(destination:Destination,target:ArticleWebsiteTarget):string|null {
  const receipt=destination.websiteCapability;
  if(destination.id!==target.destinationId||receipt?.protocol!=='v2')return 'Review this article’s publishing target against the verified website connection.';
  const c=receipt.capabilities;const t=target.target;const root=c.roots.find((r)=>r.id===t.rootId&&r.path===t.rootPath);
  if(c.siteId!==t.siteId||c.capabilitiesSha!==t.capabilitiesSha||!root||t.indexUrl!==root.indexUrl||(c.urlContract===WORDPRESS_URL_CONTRACT?!articleUrlMatches(root,t.canonicalUrl):!t.canonicalUrl.startsWith(`${root.indexUrl.replace(/\/$/,'')}/`)))return 'The website capabilities changed. Review a new article target before publishing.';
  return null;
}

/** Resolve only server-stored catalogues; posted IDs never become taxonomy or URLs. */
export function reviewedWebsiteTarget(s:WebsiteReviewSnapshot,categoryIds:readonly string[]):ArticleWebsiteTarget {
  const receipt=s.destination.websiteCapability;
  if(s.destination.status!=='connected'||receipt?.protocol!=='v2')throw new SeoBlogError(409,'Check a v2-capable website before reviewing this target.');
  if(s.article.delivery==='unknown'||s.article.delivery==='publishing'||s.publications.some((p)=>['prepared','submitted','outcome_unknown','verifying'].includes(p.state)))throw new SeoBlogError(409,'Wait for the existing publication outcome before changing its target.');
  const caps=receipt.capabilities;const published=s.article.publishedUrl;
  const matchingPublications=s.publications.filter((p)=>p.state==='published'&&p.websiteSnapshot?.target?.target.canonicalUrl===published).sort((a,b)=>Number(b.versionId===s.article.publishedVersionId)-Number(a.versionId===s.article.publishedVersionId)||(b.versionNumber??0)-(a.versionNumber??0)||(b.verifiedAt??b.lastAttemptAt??'').localeCompare(a.verifiedAt??a.lastAttemptAt??''));
  const publishedTarget=matchingPublications[0]?.websiteSnapshot?.target;
  const currentPin=s.version.websiteTarget?.target.canonicalUrl===published?s.version.websiteTarget:undefined;
  const historical=currentPin??publishedTarget??undefined;
  if(historical&&(historical.destinationId!==s.destination.id||historical.target.siteId!==caps.siteId||currentPin&&publishedTarget&&currentPin.target.structureId!==publishedTarget.target.structureId))throw new SeoBlogError(409,'The original destination, website or catalogue lineage changed. Reconnect the original target; an existing article cannot be migrated implicitly.');
  const structure=s.brand.settings.programme?.structure;
  const selected=published?caps.roots.find((r)=>published===r.articleUrlPattern.replace('{slug}',s.version.body.slug)):caps.roots.find((r)=>r.id===structure?.website?.rootId&&`/${r.path}`===structure.root&&structure.destinationId===s.destination.id);
  if(!selected)throw new SeoBlogError(409,published?'The original published URL is not an installed root on this website. Reconnect the original website; articles cannot be moved implicitly.':'Approve an installed website root and its category guidance before choosing this article target.');
  if(historical&&historical.destinationId!==s.destination.id)throw new SeoBlogError(409,'An existing article must keep its original website connection.');
  const usesCurrent=structure?.destinationId===s.destination.id&&structure.website?.siteId===caps.siteId&&structure.website.rootId===selected.id&&(!historical||historical.target.structureId===structure.website.structureId);
  if(!usesCurrent&&!historical)throw new SeoBlogError(409,'Approve website guidance for this article’s original root before adopting v2 categories. Ordinary legacy updates can keep their original URL without a v2 target.');
  const categories:readonly WebsiteCategory[]=usesCurrent?structure.website!.categories.map(({id,slug,label})=>({id,slug,label})):historical!.target.categories;
  const structureId=usesCurrent?structure.website!.structureId:historical!.target.structureId;
  const structureRevision=usesCurrent?structure.version:historical!.target.structureRevision;
  const structureSha=usesCurrent?structure.sha:historical!.target.structureSha;
  if(categoryIds.length>caps.taxonomy.maxCategoriesPerArticle||new Set(categoryIds).size!==categoryIds.length||categoryIds.some((id)=>!categories.some((c)=>c.id===id)))throw new SeoBlogError(400,'Choose only categories in this reviewed website catalogue, within the advertised limit.');
  const target:WebsiteWireTarget={siteId:caps.siteId,capabilitiesSha:caps.capabilitiesSha,rootId:selected.id,rootPath:selected.path,canonicalUrl:published??selected.articleUrlPattern.replace('{slug}',s.version.body.slug),indexUrl:selected.indexUrl,structureId,structureRevision,structureSha,categories:[...categories].sort((a,b)=>a.id.localeCompare(b.id)),categoryIds:[...categoryIds].sort()};
  const base={schema:1 as const,origin:'owner_review' as const,destinationId:s.destination.id,brandName:s.brand.name,locale:s.brand.locale,contractVersion:2 as const,target,categoryUrls:target.categoryIds.map((id)=>selected.categoryUrlPattern.replace('{slug}',categories.find((c)=>c.id===id)!.slug)),sitemapUrls:caps.sitemaps};
  return {...base,deliverySha:websiteSha({body:s.version.body,...base})};
}
