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
  return { ...asset, additionalProperties: false, required: [...asset.required as string[], '_method_sidecar'], properties: { ...asset.properties as Record<string, Schema>, _method_sidecar: sidecar } };
}

export const PLANNING_POINTER_CONTRACT = '\nPrivate planning wire override: claimLedger entries use {assetPointer,references}, not copied text. Point to a single short factual string in the plan (/asset/pillar/key_points/0 or /asset/supporting/0/angle); the server resolves and records its exact text before checking supporting evidence. Keep each factual string focused on evidence its references actually support. Reference IDs belong in the sidecar, not asset prose. All required qualityFindings fields include detail AND evidence. Record concise additional pack decisions in decisions.planningNotes. The native response schema is authoritative for shape; the server still validates all facts, sources, dates, decisions, formats and content.';

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
