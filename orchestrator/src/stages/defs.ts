import type { AnySchema } from 'ajv';
import type { Intake, QAIssue } from '../types.js';
import { qaS1, qaS2, S1_INPUT_FIELDS, S2_INPUT_FIELDS } from '../qa/checks.js';
import { S1_SCHEMA, S2_SCHEMA } from './schemas.js';

export interface StageDef {
  id: string;
  name: string;
  promptFile: string;
  /**
   * Exactly the intake fields this stage consumes (Pipeline Spec "In:" list).
   * No stage reads intake it doesn't need — "No mega-prompt".
   */
  inputFields: string[];
  /** Prior stage outputs injected into context (Pipeline Spec "In:" list). */
  priorStages: string[];
  schema: AnySchema;
  qa: (output: unknown, intake: Intake, prior: Record<string, unknown>) => QAIssue[];
  maxTokens: number;
}

export const STAGE_ORDER = ['S1', 'S2'] as const; // extends through S10 in M2

export const STAGES: Record<string, StageDef> = {
  S1: {
    id: 'S1',
    name: 'Marketing audit & scorecard',
    promptFile: 's1-audit.md',
    inputFields: S1_INPUT_FIELDS,
    priorStages: [],
    schema: S1_SCHEMA,
    qa: (output, intake) => qaS1(output, intake),
    maxTokens: 16000,
  },
  S2: {
    id: 'S2',
    name: 'Dream buyer profile (ICP)',
    promptFile: 's2-icp.md',
    inputFields: S2_INPUT_FIELDS,
    priorStages: [], // per spec, S2 consumes intake only — not S1 (decisions.md D-012)
    schema: S2_SCHEMA,
    qa: (output, intake) => qaS2(output, intake),
    maxTokens: 16000,
  },
};
