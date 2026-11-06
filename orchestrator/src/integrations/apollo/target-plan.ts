/** Target briefs are data. They cannot choose credentials, spend caps or send tools. */
import { createHash } from 'node:crypto';
import type { BrandProfile, KnowledgeDocument } from '../../seo-blog/types.js';
import { ApolloHold, type PeopleFilters } from './index.js';

export interface CoverageTargetPlan {
  schemaVersion: 1;
  brandId: string;
  profileVersion: number;
  factsSha: string;
  audience: string;
  objective: string;
  filters: PeopleFilters;
}
export interface ValidatedCoverageTarget {
  plan: CoverageTargetPlan;
  sha256: string;
  knowledgeSha256: string;
}
type TargetProfile=Pick<BrandProfile,'brandId'|'version'|'confirmedAt'|'confirmedBy'|'conflicts'|'knowledge'|'factsSha'|'audiences'>;
type TargetKnowledge=Pick<KnowledgeDocument,'id'|'brandId'|'version'|'active'|'sha256'|'status'>;
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const object=(v:unknown):Record<string,unknown>=>{
  if(v===null||typeof v!=='object'||Array.isArray(v))throw new ApolloHold('target_invalid');
  return v as Record<string,unknown>;
};
function exactKeys(v:Record<string,unknown>,keys:readonly string[]):void {
  if(Object.keys(v).some(k=>!keys.includes(k)))throw new ApolloHold('target_unexpected_field');
}
export function validateCoverageTarget(raw:unknown,brandId:string,profile:TargetProfile|null,documents:readonly TargetKnowledge[]):ValidatedCoverageTarget {
  const p=object(raw);exactKeys(p,['schemaVersion','brandId','profileVersion','factsSha','audience','objective','filters']);
  if(!profile?.confirmedAt||!profile.confirmedBy||profile.brandId!==brandId||profile.conflicts.length)throw new ApolloHold('target_profile_unconfirmed');
  if(p.schemaVersion!==1||p.brandId!==brandId||p.profileVersion!==profile.version||p.factsSha!==profile.factsSha
    ||typeof p.factsSha!=='string'||!/^[a-f0-9]{64}$/.test(p.factsSha))throw new ApolloHold('target_profile_stale');
  if(typeof p.audience!=='string'||!profile.audiences.includes(p.audience))throw new ApolloHold('target_audience_unconfirmed');
  if(typeof p.objective!=='string'||p.objective.trim().length<3||p.objective.length>1000)throw new ApolloHold('target_objective_invalid');
  // Match campaign authoring's latest-version/active-document rule.
  const latest=new Map<string,TargetKnowledge>();
  for(const doc of documents)if(!latest.has(doc.id)||latest.get(doc.id)!.version<doc.version)latest.set(doc.id,doc);
  const docs=[...latest.values()].filter(d=>d.active);
  if(docs.some(d=>d.brandId!==brandId||!['extracted','image_reference'].includes(d.status))
    ||profile.knowledge.length!==docs.length
    ||docs.some(d=>!profile.knowledge.some(k=>k.documentId===d.id&&k.version===d.version&&k.sha256===d.sha256)))throw new ApolloHold('target_knowledge_stale');
  const f=object(p.filters);exactKeys(f,['titles','seniorities','locations','industryIds']);
  const filters:PeopleFilters={};
  for(const key of ['titles','seniorities','locations','industryIds'] as const){
    if(f[key]===undefined)continue;
    const values=f[key];
    if(!Array.isArray(values)||values.length<1||values.length>20
      ||values.some(v=>typeof v!=='string'||v!==v.trim()||v.length<1||v.length>200||/[\x00-\x1f]/.test(v))
      ||new Set(values).size!==values.length)throw new ApolloHold('target_filters_invalid');
    filters[key]=[...values] as string[];
  }
  if(!(filters.titles?.length||filters.seniorities?.length)||!filters.locations?.length)throw new ApolloHold('target_filters_required');
  const plan:CoverageTargetPlan={schemaVersion:1,brandId,profileVersion:profile.version,factsSha:profile.factsSha,
    audience:p.audience,objective:p.objective.trim(),filters};
  const knowledge=docs.map(d=>({id:d.id,version:d.version,sha256:d.sha256})).sort((a,b)=>a.id.localeCompare(b.id));
  return {plan,sha256:hash(plan),knowledgeSha256:hash(knowledge)};
}
