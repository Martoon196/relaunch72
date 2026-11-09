/** Private planning wire contract. It describes evidence, never approves it. */
import type { RulePack } from './method-packs.js';
import { methodEvidenceContext, selectionCatalogue, type MethodEvidenceInputs } from './method-evidence.js';
import type { BrandProfile } from './types.js';

type Schema = Record<string, unknown>;
const str = { type: 'string', minLength: 3, maxLength: 500 };
const list = (items: Schema, maxItems = 100): Schema => ({ type: 'array', items, maxItems });
const object = (properties: Record<string, Schema>): Schema => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });

export function planningOutputSchema(asset: Schema, profile: BrandProfile, inputs: MethodEvidenceInputs, packs: readonly RulePack[]): Schema {
  const context = methodEvidenceContext(profile, inputs);
  const sourceIds = context.research.flatMap(s => [s.id, s.shortId]);
  const refs = [...context.factReferences.map(f => f.id), ...sourceIds];
  // A type remains usable with no references, but the existing semantic
  // validator rejects any invented ID and any unsupported factual claim.
  const reference = { type: 'string', ...(refs.length ? { enum: refs } : {}) };
  const decisions = object({
    claimLedger: list(object({
      assetPointer: { type: 'string', description: 'Exact JSON pointer to one short factual prose string in this returned plan, e.g. /asset/pillar/key_points/0. Server reads its text; never paraphrase or put reference IDs in asset prose.' },
      references: { ...list(reference), minItems: 1 },
    })),
    sourceAssessments: list(object({
      sourceId: { type: 'string', ...(sourceIds.length ? { enum: sourceIds } : {}) },
      publishedAt: { type: ['string', 'null'], description: 'Copy the supplied publishedAt byte-for-byte; unknown stays null.' },
      observedPeriod: { type: ['string', 'null'], description: 'Copy the supplied observedPeriod byte-for-byte; unknown stays null.' },
      confidence: { type: 'string', enum: ['high', 'medium', 'low', 'unknown'] },
      freshness: { type: 'string', enum: ['evergreen', 'dated', 'insufficient'] }, reason: str,
    })),
    ownerDecisionsNeeded: list(str),
    formatPerArticle: { ...list(object({ slug: str, formatId: { type: 'string', enum: selectionCatalogue(packs)!.formats.filter(f => f.requires.every(r => context.availableInputs.includes(r))).map(f => f.id) }, rationale: str }), 7), minItems: 7 },
    planningNotes: { type: 'string', maxLength: 2500, description: 'Concise candidate-question, pillar/runner-up and editorial-mix decisions required by the selected packs. No hidden reasoning or invented capabilities.' },
  });
  const sidecar = object({
    audience: str, selectedFormat: str, angle: str, evidenceReferences: list(reference),
    primaryNextAction: { type: ['string', 'null'] }, omittedUnsupportedClaims: list(str), decisions,
    qualityFindings: { ...list(object({
      ruleId: { type: 'string', enum: packs.flatMap(p => p.qualityChecks.map(q => q.id)) },
      status: { type: 'string', enum: ['pass', 'fail', 'not_assessed'] }, detail: str,
      evidence: { ...list({ type: 'string', description: 'Concrete /asset/... or /decisions/... JSON pointer. Claim evidence may point at /decisions/claimLedger/0/assetPointer; canonical text is also available after server resolution.' }), minItems: 1 },
    }), packs.reduce((n, p) => n + p.qualityChecks.length, 0)), minItems: packs.reduce((n, p) => n + p.qualityChecks.length, 0) },
  });
  // Compiling both the complete plan and all nested decisions exceeded the
  // provider grammar limit. Constrain the review fields natively and carry
  // the two existing JSON objects as bounded text; the server decodes them
  // and still validates their full original contracts before accepting them.
  const wireSidecar=structuredClone(sidecar) as {properties:Record<string,Schema>;required:string[]};
  delete wireSidecar.properties.decisions;
  wireSidecar.properties.decisionsJson={type:'string',maxLength:30000,description:'JSON text for the original decisions object, validated by the server: '+JSON.stringify(decisions)};
  wireSidecar.required=wireSidecar.required.map(k=>k==='decisions'?'decisionsJson':k);
  return object({planJson:{type:'string',maxLength:64000,description:'JSON text for the original plan, validated by the server: '+JSON.stringify(asset)},_method_sidecar:wireSidecar});
}

export const PLANNING_POINTER_CONTRACT = '\nPrivate planning wire override: return {planJson: JSON-encoded stage plan object, _method_sidecar: {audience,selectedFormat,angle,evidenceReferences,primaryNextAction,omittedUnsupportedClaims,decisionsJson: JSON-encoded decisions object,qualityFindings}}. Do not put a sidecar inside planJson. The native schema descriptions contain the FULL original plan and decisions contracts; the server parses both strings and validates those original contracts before acceptance. Within decoded decisions, claimLedger entries use {assetPointer,references}, not copied text. Point to one short factual string in the decoded plan (/asset/pillar/key_points/0 or /asset/supporting/0/angle); the server resolves and records its exact text before checking supporting evidence. Keep each factual string focused on evidence its references support. Reference IDs belong in the sidecar, not asset prose. All qualityFindings require detail AND evidence. Record concise pack decisions in decisions.planningNotes. Preserve actual nulls and exact supplied metadata inside the JSON strings. Evidence pointers address the decoded /asset and /decisions. Never omit required stage fields or change the article count.';

/** A transport codec only: never repairs fields, evidence or review outcomes.
 * Existing canonical receipts remain readable without a wire envelope. */
export function decodePlanningOutput(raw:Record<string,unknown>):{value:Record<string,unknown>;problems:string[]} {
  let value=structuredClone(raw);
  const parseObject=(text:unknown,limit:number):Record<string,unknown>|null=>{
    if(typeof text!=='string'||text.length>limit)return null;
    try {const parsed:unknown=JSON.parse(text);return parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed as Record<string,unknown>:null;}catch{return null;}
  };
  if(Object.hasOwn(value,'planJson')){
    const plan=parseObject(value.planJson,64000);
    if(!plan||Object.hasOwn(plan,'_method_sidecar')||Object.keys(value).some(k=>k!=='planJson'&&k!=='_method_sidecar'))return {value:{},problems:['planJson must encode only the original plan object within its size limit.']};
    value={...plan,_method_sidecar:value._method_sidecar};
  }
  const sidecar=value._method_sidecar;
  if(sidecar&&typeof sidecar==='object'&&!Array.isArray(sidecar)&&Object.hasOwn(sidecar,'decisionsJson')){
    const s=sidecar as Record<string,unknown>,decisions=parseObject(s.decisionsJson,30000);
    if(!decisions||Object.hasOwn(s,'decisions'))return {value,problems:['decisionsJson must encode one original decisions object within its size limit.']};
    const {decisionsJson:_wire,...rest}=s;value._method_sidecar={...rest,decisions};
  }
  return {value,problems:[]};
}

/** Only actual planning prose can become a claim; never metadata or prototypes. */
export function resolvePlanningClaims(sidecar: Record<string, any>, asset: Record<string, unknown>): string[] {
  const rows = sidecar.decisions?.claimLedger;
  if (!Array.isArray(rows)) return [];
  const problems: string[] = [];
  for (const [i, row] of rows.entries()) {
    if (!row || typeof row !== 'object' || !Object.hasOwn(row, 'assetPointer')) continue; // Existing immutable text-ledger receipts remain readable.
    const path = row.assetPointer;
    if (typeof path !== 'string' || !/^\/asset\/(?:pillar|supporting\/[0-5])\/(?:working_title|target_query|angle|why_fit|(?:related_questions|outline|key_points)\/(?:0|[1-9]\d?))$/.test(path)) {
      problems.push(`claimLedger[${i}] must point to a short planning prose field.`); continue;
    }
    let value: unknown = { asset };
    for (const key of path.slice(1).split('/')) value = value && typeof value === 'object' && Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined;
    if (typeof value !== 'string' || value.trim().length < 3 || value.length > 1600 || (Object.hasOwn(row, 'text') && row.text !== value)) {
      problems.push(`claimLedger[${i}] points to missing, oversized or mismatched claim text.`); continue;
    }
    row.text = value;
  }
  return problems;
}
