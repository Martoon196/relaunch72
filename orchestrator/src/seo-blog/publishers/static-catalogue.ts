/** Public static-site publication metadata, committed atomically with the website tree. */
import {websiteSha,type WebsiteWireTarget} from '../website-target.js';
import {PublisherRejectedError} from './types.js';
export const STATIC_CATALOGUE_MAX_BYTES=512*1024;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA=/^[a-f0-9]{64}$/;
interface Revision {readonly structureSha:string;readonly publicCatalogueSha:string}
interface Lineage {readonly latestRevision:number;readonly revisions:Readonly<Record<string,Revision>>}
export interface StaticArchive {readonly id:string;readonly structureId:string;readonly rootPath:string;readonly slug:string;readonly label:string;readonly labelRevision:number}
export interface StaticCatalogue {
  readonly schema:1;
  readonly source:'relaunch72.seo-blog';
  readonly siteId:string;
  readonly lineages:Readonly<Record<string,Lineage>>;
  readonly categories:Readonly<Record<string,StaticArchive>>;
}
export function staticCataloguePath(siteId:string):string {
  if(!UUID.test(siteId))throw new PublisherRejectedError('The static website identity is invalid.');
  return `.relaunch72/seo-blog/${siteId}.json`;
}
function record(value:unknown,keys:readonly string[]):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some((k)=>!keys.includes(k)))throw new PublisherRejectedError('The existing site catalogue is not an engine-owned metadata file.');
  return value as Record<string,unknown>;
}
export function readStaticCatalogue(raw:string|null,siteId:string):StaticCatalogue {
  staticCataloguePath(siteId);
  if(raw===null)return {schema:1,source:'relaunch72.seo-blog',siteId,lineages:{},categories:{}};
  if(Buffer.byteLength(raw)>STATIC_CATALOGUE_MAX_BYTES)throw new PublisherRejectedError('The public catalogue reached its metadata limit. Review the website integration; history was not discarded.');
  let parsed:unknown;try{parsed=JSON.parse(raw);}catch{throw new PublisherRejectedError('The existing public catalogue is corrupt. Restore its history before publishing.');}
  const value=record(parsed,['schema','source','siteId','lineages','categories']);
  if(value.schema!==1||value.source!=='relaunch72.seo-blog'||value.siteId!==siteId)throw new PublisherRejectedError('The existing public catalogue belongs to another source or website.');
  const lineages=record(value.lineages,Object.keys(value.lineages??{}));const categories=record(value.categories,Object.keys(value.categories??{}));
  for(const [id,data]of Object.entries(lineages)){
    if(!UUID.test(id))throw new PublisherRejectedError('Invalid catalogue lineage.');const lineage=record(data,['latestRevision','revisions']);
    if(!Number.isInteger(lineage.latestRevision)||Number(lineage.latestRevision)<1||Number(lineage.latestRevision)>1_000_000)throw new PublisherRejectedError('Invalid catalogue revision.');
    const revisions=record(lineage.revisions,Object.keys(lineage.revisions??{}));
    if(!Object.hasOwn(revisions,String(lineage.latestRevision)))throw new PublisherRejectedError('The catalogue lost its latest revision.');
    for(const [revision,entry]of Object.entries(revisions)){const r=record(entry,['structureSha','publicCatalogueSha']);if(!/^[1-9]\d{0,6}$/.test(revision)||Number(revision)>Number(lineage.latestRevision)||!SHA.test(String(r.structureSha))||!SHA.test(String(r.publicCatalogueSha)))throw new PublisherRejectedError('Invalid public catalogue revision history.');}
  }
  for(const [id,data]of Object.entries(categories)){
    const c=record(data,['id','structureId','rootPath','slug','label','labelRevision']);
    if(id!==c.id||!UUID.test(id)||!UUID.test(String(c.structureId))||!Object.hasOwn(lineages,String(c.structureId))||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(c.rootPath))||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(c.slug))||typeof c.label!=='string'||c.label.length>120||!Number.isInteger(c.labelRevision)||Number(c.labelRevision)<1)throw new PublisherRejectedError('Invalid immutable category address in the site catalogue.');
  }
  return value as unknown as StaticCatalogue;
}
export function acceptStaticCatalogue(previous:StaticCatalogue,target:WebsiteWireTarget):StaticCatalogue {
  if(previous.siteId!==target.siteId||!UUID.test(target.structureId)||!Number.isInteger(target.structureRevision)||target.structureRevision<1||target.structureRevision>1_000_000||!SHA.test(target.structureSha))throw new PublisherRejectedError('The static target catalogue identity is invalid.');
  if(target.categories.length>50||new Set(target.categories.map((c)=>c.id)).size!==target.categories.length||new Set(target.categories.map((c)=>c.slug)).size!==target.categories.length||target.categoryIds.length>5||new Set(target.categoryIds).size!==target.categoryIds.length||target.categoryIds.some((id)=>!target.categories.some((c)=>c.id===id)))throw new PublisherRejectedError('The static target catalogue or memberships are invalid.');
  const old=previous.lineages[target.structureId];const known=old?.revisions[String(target.structureRevision)];
  const publicCatalogueSha=websiteSha({rootId:target.rootId,rootPath:target.rootPath,categories:[...target.categories].sort((a,b)=>a.id.localeCompare(b.id))});
  if(known&&(known.structureSha!==target.structureSha||known.publicCatalogueSha!==publicCatalogueSha))throw new PublisherRejectedError('This structure revision already has a different immutable public catalogue.');
  if(old&&target.structureRevision<old.latestRevision&&!known)throw new PublisherRejectedError('This older catalogue revision is unknown. Review a current target before publishing.');
  const addresses=new Map(Object.values(previous.categories).map((c)=>[`${c.rootPath}/${c.slug}`,c.id]));const categories={...previous.categories};
  for(const item of target.categories){
    if(!UUID.test(item.id)||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.slug)||item.slug.length>80||!item.label.trim()||item.label.length>120)throw new PublisherRejectedError('Invalid public category.');
    const existing=previous.categories[item.id];const address=addresses.get(`${target.rootPath}/${item.slug}`);
    if(existing&&(existing.structureId!==target.structureId||existing.rootPath!==target.rootPath||existing.slug!==item.slug)||address&&address!==item.id)throw new PublisherRejectedError('A category identity or archive address already belongs to another lineage or URL.');
    if(old&&target.structureRevision<old.latestRevision&&!existing)throw new PublisherRejectedError('An older catalogue cannot introduce a new category identity.');
    if(!existing||target.structureRevision>existing.labelRevision)categories[item.id]={id:item.id,structureId:target.structureId,rootPath:target.rootPath,slug:item.slug,label:item.label,labelRevision:target.structureRevision};
    addresses.set(`${target.rootPath}/${item.slug}`,item.id);
  }
  const result:StaticCatalogue={...previous,categories,lineages:{...previous.lineages,[target.structureId]:{latestRevision:Math.max(old?.latestRevision??0,target.structureRevision),revisions:{...(old?.revisions??{}),[String(target.structureRevision)]:{structureSha:target.structureSha,publicCatalogueSha}}}}};
  if(Buffer.byteLength(JSON.stringify(result))>STATIC_CATALOGUE_MAX_BYTES)throw new PublisherRejectedError('The public catalogue reached its metadata limit. Publication is held; no revision history was forgotten.');
  return result;
}
