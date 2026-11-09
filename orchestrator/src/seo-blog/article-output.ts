/** Private blog transport reuses the proven bounded method envelope, never repairs content. */
import type {BrandProfile} from './types.js';
import type {RulePack} from './method-packs.js';
import {methodEvidenceContext,selectionCatalogue,type MethodEvidenceInputs} from './method-evidence.js';
import {methodOutputSchema,decodePlanningOutput} from './planning-output.js';

type Schema=Record<string,unknown>;
const text:Schema={type:'string',minLength:3,maxLength:1600};
const list=(items:Schema,maxItems=100):Schema=>({type:'array',items,maxItems});
const object=(properties:Record<string,Schema>):Schema=>({type:'object',additionalProperties:false,required:Object.keys(properties),properties});

export function articleOutputSchema(asset:Schema,profile:BrandProfile,inputs:MethodEvidenceInputs,packs:readonly RulePack[]):Schema {
  const context=methodEvidenceContext(profile,inputs),catalogue=selectionCatalogue(packs)!;
  const sourceIds=context.research.flatMap(s=>[s.id,s.shortId]);
  const ids=[...context.factReferences.map(f=>f.id),...sourceIds];
  const reference:Schema={type:'string',...(ids.length?{enum:ids}:{})};
  const formats=catalogue.formats.filter(f=>f.requires.every(r=>context.availableInputs.includes(r))).map(f=>f.id);
  const span={assetPointer:{type:'string',description:'Exact prose JSON pointer into THIS article, e.g. /asset/intro or /asset/sections/0/body. Metadata and source-ID fields are invalid.'},paragraphQuote:{type:['string','null'],minLength:8,maxLength:160,description:'Copy an EXACT short substring from ONE existing blank-line paragraph in this article field. The server selects that entire unique paragraph, at most1600 characters. Null selects the whole field. Do not count paragraphs, paraphrase or copy source/profile text instead of article prose.'}};
  const properties:Record<string,Schema>={
    claimLedger:list(object({...span,references:{...list(reference),minItems:1}})),
    sourceAssessments:list(object({sourceId:{type:'string',...(sourceIds.length?{enum:sourceIds}:{})},publishedAt:{type:['string','null'],description:'Copy supplied value exactly, including time and timezone; unknown stays null.'},observedPeriod:{type:['string','null']},confidence:{type:'string',enum:['high','medium','low','unknown']},freshness:{type:'string',enum:['evergreen','dated','insufficient']},reason:text})),
    ownerDecisionsNeeded:list(text),
    formatDecision:object({formatId:{type:'string',enum:inputs.editorialFormat?[inputs.editorialFormat.formatId]:formats},rationale:text}),
    mechanismMap:{...list(object({...span,reason:text})),minItems:1},
  };
  if(packs.some(p=>p.packId==='visual-briefing'))properties.visualDecision=object({
    evidenceClass:{type:'string',enum:['illustrative','evidential']},
    assetIds:list({type:'string',description:'Only IDs from method_context.visual.assets; use [] when none are used.'}),
    styleReferences:list({type:'string',description:'Only IDs from method_context.visual.guidance; [] is valid when no exact brand style is asserted.'}),
    point:text,placement:{type:'string',enum:[context.visual.placement]},
  });
  if(packs.some(p=>p.packId==='conversion-copy'))Object.assign(properties,{
    structureDecision:object({structureId:{type:'string',enum:catalogue.structures.map(s=>s.id)},rationale:text}),
    hookOptions:{...list(text,3),minItems:3},proofSelection:object({reason:text,references:list(reference)}),
  });
  const schema=methodOutputSchema(asset,object(properties),profile,inputs,packs,'articleJson');
  // The complete article is small enough to constrain natively. Keeping it
  // in a free JSON string allowed a correction to return only heading/body.
  const fields=schema.properties as Record<string,Schema>,review=fields._method_sidecar!;
  const reviewFields=review.properties as Record<string,Schema>;
  review.properties={...Object.fromEntries(Object.entries(reviewFields).filter(([k])=>k!=='decisionsJson'&&k!=='qualityFindings')),decisionsJson:reviewFields.decisionsJson!,qualityFindings:reviewFields.qualityFindings!};
  const article=structuredClone(asset),articleFields=article.properties as Record<string,Schema>;
  const publicIds=context.research.map(s=>s.shortId);
  if(publicIds.length&&articleFields.public_source_ids)articleFields.public_source_ids={...articleFields.public_source_ids,items:{type:'string',enum:publicIds},description:'Only supplied research shortIds such as S1. Never durable source UUIDs or private profile references.'};
  schema.properties={article:{...article,description:'Return the COMPLETE article object, within64000 serialized characters. Never return just a corrected section.'},_method_sidecar:review};
  schema.required=['article','_method_sidecar'];
  return schema;
}

export function decodeArticleOutput(raw:Record<string,unknown>):{value:Record<string,unknown>;problems:string[]} {
  if(Object.hasOwn(raw,'article')){
    const article=raw.article;
    if(!article||typeof article!=='object'||Array.isArray(article))return {value:{},problems:['article must be the complete stage article object, never a section fragment.']};
    if(JSON.stringify(article).length>64000)return {value:{},problems:['The complete article exceeds the existing64000-character asset bound.']};
    if(Object.keys(raw).some(k=>k!=='article'&&k!=='_method_sidecar')||Object.hasOwn(article,'_method_sidecar'))return {value:{},problems:['Keep the complete article and its one sibling _method_sidecar separate.']};
    return decodePlanningOutput({...article,_method_sidecar:raw._method_sidecar},'articleJson');
  }
  return decodePlanningOutput(raw,'articleJson'); // Historical wire/canonical receipts remain readable.
}

/** Resolve only model-selected existing prose; never guess or repair a quote. */
export function resolveArticleEvidence(sidecar:Record<string,any>,asset:Record<string,unknown>):string[] {
  const d=sidecar.decisions;if(!d||typeof d!=='object'||Array.isArray(d))return [];
  const problems:string[]=[];
  for(const [group,field] of [['claimLedger','text'],['mechanismMap','recommendation']] as const){
    if(!Array.isArray(d[group]))continue;
    for(const [i,row] of d[group].entries()){
      if(!row||typeof row!=='object'||Array.isArray(row)||!Object.hasOwn(row,'assetPointer'))continue;
      const path=row.assetPointer,index=row.paragraphIndex;
      if(typeof path!=='string'||!/^\/asset\/(?:title|seo_title|meta_description|excerpt|intro|conclusion|sections\/(?:0|[1-9]\d?)\/(?:heading|body)|faqs\/(?:0|[1-9]\d?)\/(?:q|a))$/.test(path)){
        problems.push(`${group}[${i}].assetPointer must select existing article prose, never metadata or a prototype.`);continue;
      }
      let value:unknown={asset};for(const key of path.slice(1).split('/'))value=value&&typeof value==='object'&&Object.hasOwn(value,key)?(value as Record<string,unknown>)[key]:undefined;
      if(Object.hasOwn(row,'paragraphQuote')&&row.paragraphQuote!==null){
        const quote=row.paragraphQuote;
        if(typeof value!=='string'||typeof quote!=='string'||quote.trim().length<8||quote.length>160||(index!==null&&index!==undefined)){
          problems.push(`${group}[${i}].paragraphQuote must be an exact8–160 character article substring, without a competing paragraphIndex.`);continue;
        }
        const matches=value.split(/\r?\n[ \t]*\r?\n/).filter(p=>p.includes(quote));
        if(matches.length!==1){problems.push(`${group}[${i}].paragraphQuote must match exactly one existing paragraph at ${path}; found ${matches.length}. Copy a short unique substring from this article, never a paraphrase or list-item number.`);continue;}
        value=matches[0];
      }else if(index!==null&&index!==undefined){
        if(typeof value!=='string'||!Number.isInteger(index)||index<0||index>99){problems.push(`${group}[${i}] has an invalid paragraphIndex at ${path}; use a zero-based existing blank-line paragraph or null for the whole field.`);continue;}
        const paragraphs=value.split(/\r?\n[ \t]*\r?\n/);value=paragraphs[index];
      }
      if(typeof value!=='string'||value.trim().length<3||value.length>1600||(Object.hasOwn(row,field)&&row[field]!==value)){
        problems.push(`${group}[${i}] selects missing, oversized or conflicting prose at ${path}, paragraph ${index??'whole field'}. Select an existing paragraph within1600 characters using an exact paragraphQuote or correct your own draft; never invent text or metadata.`);continue;
      }
      row[field]=value;
    }
  }
  return problems;
}

export const ARTICLE_OUTPUT_CONTRACT='\nPrivate blog wire override: return {article: COMPLETE original stage article OBJECT, _method_sidecar: {audience,selectedFormat,angle,evidenceReferences,primaryNextAction,omittedUnsupportedClaims,decisionsJson: JSON-encoded decisions,qualityFindings}}. The native article schema requires EVERY article field: title, seo_title, meta_description, excerpt, intro, sections, conclusion, faqs, image_alt, public_source_ids. A heading/body section fragment is never the complete article, including during correction. Do not nest a sidecar in article. The decisionsJson description contains the COMPLETE decisions contract. claimLedger and mechanismMap use {assetPointer,paragraphQuote,...} to select EXISTING prose: null selects the whole field; otherwise copy an EXACT8–160 character substring unique to one blank-line paragraph. Never count paragraphs or list items. The server records its exact unchanged text as canonical claimLedger.text or mechanismMap.recommendation before ALL original evidence checks. Do not copy/paraphrase those text fields. Keep selected spans within1600 characters; split your own prose into focused paragraphs if necessary. References must support the entire selected factual span; numerical/metadata/owner/format/visual checks remain mandatory. Every finding requires meaningful detail and concrete evidence into /asset/... or /decisions/...; canonical resolved text is available there. Include formatDecision, mechanismMap and visualDecision. Supplied dates, confidence, nulls, source IDs and visual placement remain exact. Only verified absence checks may cite their actual empty lists. Customer article prose uses ONLY [src:S1] style research citations, never bare [S1] or private [profile:...] IDs. Private fact IDs belong ONLY in sidecar references. Monetary amounts, fees and percentages require supplied numerical support even in illustrative examples: omit unsupported figures instead of inventing support. Use unnumbered bullets rather than numeric list labels. public_source_ids uses supplied shortIds such as S1, never source UUIDs. Use ONLY supplied linkable URLs. Do not fabricate facts, assets, source freshness, owner approvals, pass findings or metadata. Correct the COMPLETE article on the existing single revision, preserving valid fields and qualifications.';
