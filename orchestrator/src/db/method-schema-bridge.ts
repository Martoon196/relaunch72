import type { SqlMigration } from './migrate.js';

export const METHOD_PACK_MIGRATION_SHA='84f1abb3a152ac93800edbfd92b281d34d31e8ffe4e4ec5b0df2019e806898d8';
export const METHOD_CREATOR_MIGRATION_SHA='30dd3672ae8fb89e2397b8f18145f87dffc36ff20e702480989909fd017a4643';
export const METHOD_DEFAULTS_MIGRATION_SHA='a4b53f5721855e300cd49665cc5faa773f3c80240fbcca3fe3f31379c7f3a378';
const expected=[['0138_seo_blog_method_packs.sql',METHOD_PACK_MIGRATION_SHA],['0139_method_evidence_campaign_creators.sql',METHOD_CREATOR_MIGRATION_SHA],['0140_private_method_automatic_defaults.sql',METHOD_DEFAULTS_MIGRATION_SHA]] as const;
/** Explicit, exact additive transition only. Never mounts methods on the older schema. */
export function methodSchemaBridgeAllowed(migrations:readonly SqlMigration[],applied:ReadonlyMap<string,string>,env:NodeJS.ProcessEnv):boolean {
  if(env.RL72_METHOD_SCHEMA_BRIDGE!=='138-140'||env.SEO_BLOG_METHOD_PACKS==='true'||env.SEO_BLOG_CAMPAIGN_CREATORS==='true')return false;
  if(migrations.length!==140||applied.get('0137_seo_blog_media_storage.sql')!=='ff85dc3ee825e2529333fc8efb0de070a05e43786717d9ae279aa469e41e1255')return false;
  if(!expected.every(([name,sha],i)=>migrations[137+i]?.filename===name&&migrations[137+i]?.checksum===sha))return false;
  const pending=migrations.filter(m=>!applied.has(m.filename));
  return pending.length>0&&pending.length<=3&&pending.every(m=>expected.some(([name,sha])=>m.filename===name&&m.checksum===sha));
}
