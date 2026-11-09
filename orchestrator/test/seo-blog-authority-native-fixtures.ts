/** Read-port spies only; no fake SQL authority or real provider. */
import type {Actor} from '../src/seo-blog/engine.js';
import {DEFAULT_BRAND_SETTINGS,type Brand,type Article,type ArticleVersion,type Publication,type KnowledgeDocument} from '../src/seo-blog/types.js';
import type {AuthorityProgrammeReader} from '../src/seo-blog/authority-programme-controller.js';
import {authorityReviewFixture,reviewId} from './seo-blog-authority-programme-fixtures.js';
export const NATIVE_ACTOR:Actor=Object.freeze({userId:reviewId(3)});
export function authorityNativeFixture(count=1){
 const source=authorityReviewFixture(),origin=source.brand.website;
 const settings={...DEFAULT_BRAND_SETTINGS,privateMarker:'DO_NOT_RETURN_BRAND_SETTINGS'};
 const brand:Brand={...source.brand,website:origin,organizationId:reviewId(80),slug:'demo-harbour',locale:'en-GB',timezone:'Europe/London',settings,createdAt:source.now,createdBy:NATIVE_ACTOR.userId,rowVersion:1};
 const documents=source.currentKnowledge.map(ref=>({...ref,id:ref.documentId,brandId:brand.id,title:'Facts',active:true,text:'DO_NOT_RETURN_RAW_DOCUMENT',blobId:'DO_NOT_RETURN_BLOB',createdAt:source.now,status:'extracted'} as unknown as KnowledgeDocument));
 const rows:{article:Article;title:string;status:string}[]=[];
 const details=new Map<string,Awaited<ReturnType<AuthorityProgrammeReader['getArticle']>>>();
 for(let i=0;i<count;i++){
  const articleId=reviewId(100+i*10),publishedVersionId=reviewId(101+i*10),draftId=reviewId(102+i*10),publicationId=reviewId(103+i*10),url=origin+'/blog/guide-'+i;
  const article={id:articleId,brandId:brand.id,currentVersionId:draftId,publishedVersionId,publishedUrl:url,publishedAt:'2026-11-02T10:00:00.000Z',delivery:'published',deliveryPublicationId:publicationId,rowVersion:9} as Article;
  const version={id:publishedVersionId,brandId:brand.id,articleId,contentSha:'d'.repeat(64),number:1,body:{privateMarker:'DO_NOT_RETURN_RAW_ARTICLE'}} as unknown as ArticleVersion;
  const draft={...version,id:draftId,number:2};
  const evidence={...source.deliveries[0]!.evidence,article:{...source.deliveries[0]!.evidence.article,url}};
  const publication={id:publicationId,brandId:brand.id,articleId,versionId:publishedVersionId,contentSha:version.contentSha,state:'published',publicUrl:url,verifiedAt:'2026-11-03T08:00:00.000Z',websiteDelivery:evidence,websiteSnapshot:{sealedCredential:'DO_NOT_RETURN_SEALED_CONNECTION'}} as unknown as Publication;
  rows.push({article,title:'A newer unapproved draft',status:'Draft'});details.set(articleId,{article,version:draft,versions:[version,draft],publications:[publication],status:'Draft'});
 }
 const data={brand,profile:source.profile as typeof source.profile|null,documents,inventory:source.inventory as typeof source.inventory|null,rows,details};
 const calls:{method:keyof AuthorityProgrammeReader;actor:Actor;brandId:string;articleId?:string}[]=[];let active=0,maxActive=0;let delay=0;let beforeRead:((method:keyof AuthorityProgrammeReader,articleId?:string)=>void)|null=null;
 const note=(method:keyof AuthorityProgrammeReader,actor:Actor,brandId:string,articleId?:string)=>{calls.push({method,actor,brandId,articleId});beforeRead?.(method,articleId);};
 const methods:AuthorityProgrammeReader={
  async getBrand(a,b){note('getBrand',a,b);return data.brand;},async getProfile(a,b){note('getProfile',a,b);return data.profile;},
  async listKnowledge(a,b){note('listKnowledge',a,b);return data.documents;},async getInventory(a,b){note('getInventory',a,b);return data.inventory;},
  async listArticles(a,b){note('listArticles',a,b);return data.rows;},async getArticle(a,b,id){note('getArticle',a,b,id);active++;maxActive=Math.max(maxActive,active);try{if(delay)await new Promise(r=>setTimeout(r,delay));const d=data.details.get(id);if(!d)throw new Error('Missing fixture detail');return d;}finally{active--;}}
 };
 const engine=new Proxy(methods,{get(target,key){if(!(key in target))throw new Error('Mutator or unlisted read accessed: '+String(key));return Reflect.get(target,key);}});
 return {source,data,engine,calls,get maxActive(){return maxActive;},setDelay(ms:number){delay=ms;},before(fn:typeof beforeRead){beforeRead=fn;}};
}
