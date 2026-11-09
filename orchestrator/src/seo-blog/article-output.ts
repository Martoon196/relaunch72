/** Private blog transport reuses the proven bounded method envelope, never repairs content. */
import type {BrandProfile} from './types.js';
import type {RulePack} from './method-packs.js';
import {methodEvidenceContext,selectionCatalogue,type MethodEvidenceInputs} from './method-evidence.js';
import {methodOutputSchema} from './planning-output.js';

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
  const properties:Record<string,Schema>={
    claimLedger:list(object({text:{...text,description:'A SHORT VERBATIM substring of a prose field in this exact returned article. Copy it byte-for-byte, including punctuation; never summarise a source or profile.'},references:{...list(reference),minItems:1}})),
    sourceAssessments:list(object({sourceId:{type:'string',...(sourceIds.length?{enum:sourceIds}:{})},publishedAt:{type:['string','null'],description:'Copy supplied value exactly, including time and timezone; unknown stays null.'},observedPeriod:{type:['string','null']},confidence:{type:'string',enum:['high','medium','low','unknown']},freshness:{type:'string',enum:['evergreen','dated','insufficient']},reason:text})),
    ownerDecisionsNeeded:list(text),
    formatDecision:object({formatId:{type:'string',enum:inputs.editorialFormat?[inputs.editorialFormat.formatId]:formats},rationale:text}),
    mechanismMap:{...list(object({recommendation:{...text,description:'A SHORT VERBATIM recommendation substring from this exact returned article, never a paraphrase.'},reason:text})),minItems:1},
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
  return methodOutputSchema(asset,object(properties),profile,inputs,packs,'articleJson');
}

export const ARTICLE_OUTPUT_CONTRACT='\nPrivate blog wire override: return {articleJson: JSON-encoded original stage article, _method_sidecar: {audience,selectedFormat,angle,evidenceReferences,primaryNextAction,omittedUnsupportedClaims,decisionsJson: JSON-encoded decisions,qualityFindings}}. The native schema descriptions contain the COMPLETE article and decisions contracts. The server decodes these strings and runs all original article, evidence, owner, format and visual checks. Do not nest a sidecar in articleJson. Every finding requires meaningful detail and concrete evidence. Copy claimLedger.text and mechanismMap.recommendation VERBATIM from the exact article you return; never paraphrase them. Include formatDecision, mechanismMap and visualDecision when required. Supplied dates, confidence, nulls, source IDs and visual placement must remain exact. Evidence pointers target decoded /asset/... or /decisions/...; an absence of supplied visual assets can be evidenced only by the actual empty visualDecision.assetIds under visual.check-assets-exist. Do not fabricate assets, source freshness, owner approvals, pass findings or metadata. Keep the article and decisions concise within their existing bounds.';
